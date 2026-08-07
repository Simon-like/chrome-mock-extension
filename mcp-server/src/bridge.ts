/**
 * WebSocket 桥（服务端）—— 等扩展连上来
 *
 * 这是**信任边界**：一个监听在 localhost 的端口，本机任何进程、
 * 以及任何网页里的 JS 都能尝试连它。所以三道校验缺一不可：
 *
 *   1. **只监听 127.0.0.1** —— 不是 0.0.0.0。局域网里的别人连不上
 *   2. **Origin 必须是 chrome-extension://** —— 网页发起的 WS 会带上
 *      自己的 http(s) Origin，直接挡掉。浏览器不允许 JS 伪造这个头
 *   3. **配对码** —— 挡住本机上的其他进程（它们可以随便伪造 Origin）
 *
 * 三道都过了才认这条连接。任何一道没过就带原因关闭 ——
 * 静默断开会让用户完全无法排查。
 */

import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import {
  BRIDGE_CLOSE,
  BRIDGE_PROTOCOL_VERSION,
  type BridgeData,
  type BridgeHello,
  type BridgeRequest,
  type BridgeResponse,
} from '../../src/shared/bridge.js';

/** 单次请求的超时。扩展没响应时不能让 AI 那边无限挂着 */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * 去掉 id 字段（id 由本类分配，调用方不该关心）。
 *
 * ⚠️ 不能直接写 `Omit<BridgeRequest, 'id'>`：BridgeRequest 是**联合类型**，
 * Omit 作用在联合上会先把它折叠成「所有成员的公共键」，结果只剩下 `type` ——
 * 于是 `limit` / `command` 这些字段全部报「不存在」，而各分支的 payload
 * 又会被推断成 never，任何 Command 都传不进去。
 * 必须用条件类型让它**分配到每个成员**上再 Omit。
 */
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

export class BridgeServer {
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private pending = new Map<
    string,
    { resolve: (r: BridgeResponse) => void; timer: NodeJS.Timeout }
  >();
  private seq = 0;
  /** 最近一次拒绝的原因。工具报错时带上它，用户才知道该去改什么 */
  private lastReject: string | null = null;

  constructor(
    private readonly port: number,
    private readonly token: string,
    private readonly serverVersion: string,
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // host 写死 127.0.0.1：绑 0.0.0.0 会把这个口暴露到局域网
      const wss = new WebSocketServer({ port: this.port, host: '127.0.0.1' });
      this.wss = wss;

      wss.on('listening', resolve);
      wss.on('error', reject);
      wss.on('connection', (ws, req) => this.onConnection(ws, req));
    });
  }

  async stop(): Promise<void> {
    for (const [, p] of this.pending) clearTimeout(p.timer);
    this.pending.clear();
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
  }

  get connected(): boolean {
    return this.client !== null && this.client.readyState === 1;
  }

  get rejectReason(): string | null {
    return this.lastReject;
  }

  // ── 连接与握手 ─────────────────────────────────────

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const origin = req.headers.origin ?? '';

    // 校验 2：网页发起的 WebSocket 一定带自己的 http(s) Origin，
    // 而且浏览器不允许 JS 改这个头 —— 所以这一条能挡住所有网页
    if (!origin.startsWith('chrome-extension://')) {
      this.reject(ws, BRIDGE_CLOSE.BAD_ORIGIN, `Origin 不是扩展：${origin || '(空)'}`);
      return;
    }

    // 握手要在限定时间内完成，否则占着连接不说话也是一种骚扰
    const handshakeTimer = setTimeout(() => {
      this.reject(ws, BRIDGE_CLOSE.BAD_TOKEN, '握手超时');
    }, 5_000);

    let shook = false;

    ws.on('message', (raw) => {
      let msg: Partial<BridgeHello> & { id?: string };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return; // 收到看不懂的东西就丢掉
      }

      if (!shook) {
        if (msg.type !== 'HELLO') return;
        clearTimeout(handshakeTimer);

        if (msg.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
          this.reject(
            ws,
            BRIDGE_CLOSE.BAD_PROTOCOL,
            `协议版本不一致：扩展 ${msg.protocolVersion} / 服务端 ${BRIDGE_PROTOCOL_VERSION}。请把两边升到同一版本`,
          );
          return;
        }
        // 校验 3：配对码。用等长比较避免时序侧信道 —— 本地场景风险低，
        // 但这是安全代码，按安全代码的规矩写
        if (!safeEqual(msg.token ?? '', this.token)) {
          this.reject(
            ws,
            BRIDGE_CLOSE.BAD_TOKEN,
            '配对码不匹配。请在扩展设置页复制配对码，填进 MOCK_STUDIO_TOKEN',
          );
          return;
        }

        shook = true;
        this.lastReject = null;
        this.client = ws;
        ws.send(JSON.stringify({ type: 'WELCOME', serverVersion: this.serverVersion }));
        return;
      }

      // 握手后：只可能是对我们请求的应答（心跳事件没有 id，直接忽略）
      if (!msg.id) return;
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.pending.delete(msg.id);
      waiter.resolve(msg as unknown as BridgeResponse);
    });

    ws.on('close', () => {
      clearTimeout(handshakeTimer);
      if (this.client === ws) this.client = null;
    });

    ws.on('error', () => {
      /* 对端异常不该让服务端进程崩掉 */
    });
  }

  private reject(ws: WebSocket, code: number, reason: string): void {
    this.lastReject = reason;
    try {
      ws.send(JSON.stringify({ type: 'REJECT', reason }));
      // close 的 reason 有 123 字节上限，超了会抛。截断而不是让它炸
      ws.close(code, reason.slice(0, 100));
    } catch {
      /* ignore */
    }
  }

  // ── 请求 ───────────────────────────────────────────

  /**
   * 向扩展发一个请求并等应答。
   *
   * 没连上时抛一个**能照着做**的错误 —— MCP 工具的报错会直接进 AI 的上下文，
   * 写成「connection error」的话 AI 只会干瞪眼。
   */
  request(req: WithoutId<BridgeRequest>): Promise<BridgeData> {
    if (!this.connected) {
      const hint = this.lastReject
        ? `扩展连接被拒绝：${this.lastReject}`
        : '扩展还没连上来。请确认：① Chrome 里装了 Mock Studio 且已启用；' +
          '② 扩展设置页里「MCP 桥」开着；③ 端口和配对码与本服务端一致。';
      return Promise.reject(new Error(hint));
    }

    const id = `r${++this.seq}`;
    const payload = { ...req, id } as BridgeRequest;

    return new Promise<BridgeData>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('扩展在 10 秒内没有响应，可能 Service Worker 正在重启，请重试'));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, {
        timer,
        resolve: (r) => (r.ok ? resolve(r.data) : reject(new Error(r.error))),
      });

      try {
        this.client!.send(JSON.stringify(payload));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }
}

/** 等长比较，不因为在第几位不同而提前返回 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
