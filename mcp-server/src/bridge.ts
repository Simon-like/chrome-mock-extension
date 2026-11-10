/**
 * 桥（服务端）—— Hub / Peer 双角色
 *
 * ── 要解决的问题 ────────────────────────────────────
 * MCP Server 是被客户端 spawn 的 stdio 子进程：**开几个 AI 工具就有几个进程**。
 * 但扩展只能连一个端口。第一版的结果是第二个进程直接 EADDRINUSE 退出 ——
 * Claude Code 和 JoyCode 不能同时用，这在实际工作里很难受。
 *
 * ── 解法：抢端口，抢不到就当 Peer ──────────────────
 * ```
 *   进程 A ── bind(8787) 成功 ──→ HUB ←── WebSocket ── Chrome 扩展
 *                                  ↑
 *   进程 B ── bind 失败 ──→ PEER ──┘  把工具调用转发给 Hub
 *   进程 C ── bind 失败 ──→ PEER ──┘
 * ```
 * 对上层（tools.ts）完全透明：两种角色都实现同一个 `BridgeTransport`。
 *
 * Hub 挂了（它的 AI 客户端退出了）→ Peer 的连接断开 → 重新参与抢端口，
 * 谁抢到谁当 Hub。扩展本来就在退避重连，会自动连到新 Hub 上。
 *
 * ── 探活：为什么必须要应答 ──────────────────────────
 * 第一版心跳是「只发不验」，而**半开 socket 上 send() 只是写进本地缓冲区，
 * 不会抛错** —— 于是服务端和扩展都会永远显示「已连接」，实际早就断了。
 * 现在 Hub 定期发 PING 并等 pong，超时就 terminate（不是 close ——
 * 对端已经不在了，四次挥手等不到回应）。
 */

import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import {
  BRIDGE_CLOSE,
  BRIDGE_PROTOCOL_VERSION,
  PING_INTERVAL_MS,
  PING_TIMEOUT_MS,
  type BridgeData,
  type BridgeHello,
  type BridgeRequest,
  type BridgeResponse,
} from '../../src/shared/bridge.js';

/** 单次请求的超时。扩展没响应时不能让 AI 那边无限挂着 */
const REQUEST_TIMEOUT_MS = 10_000;
/** 抢不到端口、又连不上 Hub 时的重试节奏（Hub 可能正好在这一刻退出） */
const ELECTION_RETRY_MS = 400;
const ELECTION_MAX_TRIES = 5;

/**
 * 去掉 id 字段（id 由传输层分配，调用方不该关心）。
 *
 * ⚠️ 不能直接写 `Omit<BridgeRequest, 'id'>`：BridgeRequest 是**联合类型**，
 * Omit 作用在联合上会先折叠成「所有成员的公共键」，结果只剩 `type`，
 * 各分支的 payload 会被推断成 never，任何请求都传不进去。
 */
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

/** 上层只认这个接口，不关心自己是 Hub 还是 Peer */
export interface BridgeTransport {
  request(req: WithoutId<BridgeRequest>): Promise<BridgeData>;
  /** 扩展在不在线（Peer 是从 Hub 那里得知的） */
  readonly extensionOnline: boolean;
  readonly role: 'hub' | 'peer';
  /** 最近一次拒绝/失败的原因，用来拼可操作的报错 */
  readonly hint: string | null;
  close(): Promise<void>;
}

// ═══════════════════════════════════════════════════════════
// 请求应答配对：Hub 和 Peer 都要用
// ═══════════════════════════════════════════════════════════

class Pending {
  private map = new Map<
    string,
    { resolve: (r: BridgeResponse) => void; timer: NodeJS.Timeout }
  >();
  private seq = 0;

  nextId(prefix: string): string {
    return `${prefix}${++this.seq}`;
  }

  add(id: string, resolve: (r: BridgeResponse) => void, onTimeout: () => void): void {
    const timer = setTimeout(() => {
      this.map.delete(id);
      onTimeout();
    }, REQUEST_TIMEOUT_MS);
    this.map.set(id, { resolve, timer });
  }

  settle(id: string, res: BridgeResponse): boolean {
    const w = this.map.get(id);
    if (!w) return false;
    clearTimeout(w.timer);
    this.map.delete(id);
    w.resolve(res);
    return true;
  }

  /** 连接没了：把所有在等的请求一次性失败掉，别让调用方挂到超时 */
  failAll(reason: string): void {
    for (const [, w] of this.map) {
      clearTimeout(w.timer);
      w.resolve({ id: '', ok: false, error: reason });
    }
    this.map.clear();
  }
}

// ═══════════════════════════════════════════════════════════
// Hub —— 抢到端口的那个
// ═══════════════════════════════════════════════════════════

export class HubBridge implements BridgeTransport {
  readonly role = 'hub' as const;

  private wss: WebSocketServer | null = null;
  private extension: WebSocket | null = null;
  private peers = new Set<WebSocket>();
  private pending = new Pending();
  private pingTimer: NodeJS.Timeout | null = null;
  private lastReject: string | null = null;

  constructor(
    private readonly port: number,
    private readonly token: string,
    private readonly serverVersion: string,
    private readonly log: (...a: unknown[]) => void,
  ) {}

  get extensionOnline(): boolean {
    return this.extension !== null && this.extension.readyState === 1;
  }

  get hint(): string | null {
    return this.lastReject;
  }

  /** bind 成功才算当上 Hub；EADDRINUSE 会原样抛出去，由选举逻辑接住 */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // host 写死 127.0.0.1：绑 0.0.0.0 会把这个口暴露到局域网
      const wss = new WebSocketServer({ port: this.port, host: '127.0.0.1' });
      this.wss = wss;

      const onError = (e: Error) => reject(e);
      wss.once('error', onError);
      wss.once('listening', () => {
        wss.off('error', onError);
        // 监听起来之后的错误不该让进程崩掉
        wss.on('error', (e) => this.log('WebSocket 服务错误：', e.message));
        this.startPinging();
        resolve();
      });
      wss.on('connection', (ws, req) => this.onConnection(ws, req));
    });
  }

  async close(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.pending.failAll('服务端正在关闭');
    for (const p of this.peers) safeClose(p, 1001, 'hub shutting down');
    if (this.extension) safeClose(this.extension, 1001, 'hub shutting down');
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
  }

  // ── 连接与握手 ─────────────────────────────────────

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const origin = req.headers.origin ?? '';
    let role: 'extension' | 'peer' | null = null;

    // 握手要在限定时间内完成，否则占着连接不说话也是一种骚扰
    const handshakeTimer = setTimeout(() => {
      this.reject(ws, BRIDGE_CLOSE.BAD_TOKEN, '握手超时');
    }, 5_000);

    ws.on('message', (raw) => {
      let msg: Partial<BridgeHello> & Partial<BridgeResponse> & { type?: string };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return; // 收到看不懂的东西就丢掉
      }

      if (!role) {
        if (msg.type !== 'HELLO') return;
        clearTimeout(handshakeTimer);
        const claimed: 'extension' | 'peer' = msg.role === 'peer' ? 'peer' : 'extension';

        // 校验 1：只有扩展需要过 Origin。
        // 网页发起的 WS 一定带自己的 http(s) Origin，且浏览器不允许 JS 伪造这个头 ——
        // 这一条能挡住所有网页。peer 是本机 Node 进程，没有 Origin，靠配对码把关
        if (claimed === 'extension' && !origin.startsWith('chrome-extension://')) {
          this.reject(ws, BRIDGE_CLOSE.BAD_ORIGIN, `Origin 不是扩展：${origin || '(空)'}`);
          return;
        }
        if (claimed === 'peer' && origin) {
          this.reject(ws, BRIDGE_CLOSE.BAD_ORIGIN, 'peer 不该带 Origin —— 浏览器伪装成 peer？');
          return;
        }

        if (msg.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
          this.reject(
            ws,
            BRIDGE_CLOSE.BAD_PROTOCOL,
            `协议版本不一致：对端 ${msg.protocolVersion} / 本端 ${BRIDGE_PROTOCOL_VERSION}。` +
              `请把扩展和 mcp-server 都更新到同一版本（扩展要重新加载，mcp-server 要重新 build）`,
          );
          return;
        }
        // 校验 2：配对码。等长比较避免时序侧信道 —— 本地场景风险低，
        // 但这是安全代码，按安全代码的规矩写
        if (!safeEqual(msg.token ?? '', this.token)) {
          this.reject(
            ws,
            BRIDGE_CLOSE.BAD_TOKEN,
            '配对码不匹配。请在扩展设置页复制配对码，填进 MOCK_STUDIO_TOKEN',
          );
          return;
        }

        role = claimed;
        this.lastReject = null;
        this.accept(ws, role, msg.clientVersion ?? '?');
        return;
      }

      if (role === 'extension') this.onExtensionMessage(msg as BridgeResponse);
      else this.onPeerMessage(ws, msg as unknown as BridgeRequest);
    });

    ws.on('close', () => {
      clearTimeout(handshakeTimer);
      if (role === 'peer') this.peers.delete(ws);
      if (role === 'extension' && this.extension === ws) {
        this.extension = null;
        this.pending.failAll('扩展已断开');
        this.log('扩展已断开');
        this.broadcastExtensionState(false);
      }
    });

    ws.on('error', () => {
      /* 对端异常不该让服务端进程崩掉 */
    });
  }

  private accept(ws: WebSocket, role: 'extension' | 'peer', version: string): void {
    if (role === 'extension') {
      /**
       * 至多一条扩展连接。
       *
       * ⚠️ 第一版这里只写了 `this.client = ws`，**没有关掉上一条** ——
       * 于是扩展每重连一次就在服务端漏一个 socket，堆成一片半开连接。
       * 用户看到的「占用很多端口」就是这么来的。
       */
      if (this.extension && this.extension !== ws) {
        safeClose(this.extension, BRIDGE_CLOSE.SUPERSEDED, '被新的扩展连接顶替');
      }
      this.extension = ws;
      this.log(`扩展已连接（v${version}）`);
      this.broadcastExtensionState(true);
    } else {
      this.peers.add(ws);
      this.log(`另一个 MCP Server 作为 peer 接入（v${version}），当前 peer 数：${this.peers.size}`);
    }

    ws.send(
      JSON.stringify({
        type: 'WELCOME',
        serverVersion: this.serverVersion,
        extensionOnline: this.extensionOnline,
      }),
    );
  }

  private reject(ws: WebSocket, code: number, reason: string): void {
    this.lastReject = reason;
    try {
      ws.send(JSON.stringify({ type: 'REJECT', reason }));
    } catch {
      /* ignore */
    }
    // close 的 reason 有 123 字节上限，超了会抛。截断而不是让它炸
    safeClose(ws, code, reason.slice(0, 100));
  }

  /** peer 需要知道扩展在不在，才能给出「让用户开扩展」这种可操作的报错 */
  private broadcastExtensionState(online: boolean): void {
    const msg = JSON.stringify({ type: 'EXTENSION_STATE', online });
    for (const p of this.peers) {
      try {
        p.send(msg);
      } catch {
        /* 发不出去的 peer 自会 close */
      }
    }
  }

  // ── 消息 ───────────────────────────────────────────

  private onExtensionMessage(msg: BridgeResponse): void {
    if (!msg.id) return; // 心跳事件之类，没有 id
    this.pending.settle(msg.id, msg);
  }

  /** peer 发来的请求：转给扩展，应答原路送回 */
  private onPeerMessage(peer: WebSocket, req: BridgeRequest): void {
    if (!req?.id || !req.type) return;
    const peerReqId = req.id;
    this.request(req as WithoutId<BridgeRequest>)
      .then((data) => sendJson(peer, { id: peerReqId, ok: true, data }))
      .catch((e: Error) => sendJson(peer, { id: peerReqId, ok: false, error: e.message }));
  }

  // ── 探活 ───────────────────────────────────────────

  /**
   * 定期 PING 扩展并等 pong。没等到就**主动杀掉**这条连接。
   *
   * 用 terminate 不用 close：对端已经不在了，四次挥手等不到回应，
   * close 会让 socket 卡在 CLOSING 直到 TCP 超时 —— 那正是「半开连接堆积」的来源。
   */
  private startPinging(): void {
    this.pingTimer = setInterval(() => {
      const ws = this.extension;
      if (!ws || ws.readyState !== 1) return;
      const id = this.pending.nextId('ping');
      let answered = false;
      this.pending.add(
        id,
        () => {
          answered = true;
        },
        () => {
          if (!answered) {
            this.log('扩展心跳超时，断开这条连接');
            if (this.extension === ws) this.extension = null;
            ws.terminate();
            this.broadcastExtensionState(false);
          }
        },
      );
      // 心跳的超时比常规请求短：它的意义就是尽快发现死连接
      setTimeout(() => {
        if (!answered && this.extension === ws) {
          this.log('扩展心跳超时，断开这条连接');
          this.extension = null;
          ws.terminate();
          this.broadcastExtensionState(false);
        }
      }, PING_TIMEOUT_MS);
      sendJson(ws, { id, type: 'PING' });
    }, PING_INTERVAL_MS);
  }

  // ── 对外 ───────────────────────────────────────────

  request(req: WithoutId<BridgeRequest>): Promise<BridgeData> {
    const ws = this.extension;
    if (!ws || ws.readyState !== 1) {
      return Promise.reject(new Error(extensionOfflineHint(this.lastReject)));
    }
    const id = this.pending.nextId('h');
    return new Promise<BridgeData>((resolve, reject) => {
      this.pending.add(
        id,
        (r) => (r.ok ? resolve(r.data) : reject(new Error(r.error))),
        () => reject(new Error('扩展在 10 秒内没有响应，可能 Service Worker 正在重启，请重试')),
      );
      try {
        ws.send(JSON.stringify({ ...req, id }));
      } catch (e) {
        this.pending.settle(id, { id, ok: false, error: (e as Error).message });
      }
    });
  }
}

// ═══════════════════════════════════════════════════════════
// Peer —— 没抢到端口的那些
// ═══════════════════════════════════════════════════════════

export class PeerBridge implements BridgeTransport {
  readonly role = 'peer' as const;

  private ws: WebSocket | null = null;
  private pending = new Pending();
  private online = false;
  private reason: string | null = null;

  constructor(
    private readonly port: number,
    private readonly token: string,
    private readonly serverVersion: string,
    private readonly log: (...a: unknown[]) => void,
    /** Hub 掉线时通知外层重新参与选举 */
    private readonly onHubLost: () => void,
  ) {}

  get extensionOnline(): boolean {
    return this.online;
  }

  get hint(): string | null {
    return this.reason;
  }

  connect(WsCtor: typeof WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WsCtor(`ws://127.0.0.1:${this.port}`);
      this.ws = ws;
      let shook = false;

      const fail = (e: Error) => (shook ? undefined : reject(e));
      const timer = setTimeout(() => fail(new Error('连接 Hub 超时')), 4_000);

      ws.on('open', () => {
        sendJson(ws, {
          type: 'HELLO',
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          role: 'peer',
          token: this.token,
          clientVersion: this.serverVersion,
        });
      });

      ws.on('message', (raw) => {
        let msg: { type?: string; reason?: string; online?: boolean } & Partial<BridgeResponse>;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }

        if (msg.type === 'WELCOME') {
          clearTimeout(timer);
          shook = true;
          this.online = !!(msg as { extensionOnline?: boolean }).extensionOnline;
          resolve();
          return;
        }
        if (msg.type === 'REJECT') {
          clearTimeout(timer);
          this.reason = msg.reason ?? '被 Hub 拒绝';
          fail(new Error(this.reason));
          return;
        }
        if (msg.type === 'EXTENSION_STATE') {
          this.online = !!msg.online;
          return;
        }
        if (msg.id) this.pending.settle(msg.id, msg as BridgeResponse);
      });

      ws.on('close', () => {
        clearTimeout(timer);
        this.pending.failAll('与 Hub 的连接已断开');
        this.online = false;
        if (shook) {
          this.log('Hub 已退出，重新参与端口选举…');
          this.onHubLost();
        } else {
          fail(new Error('连接 Hub 时被关闭'));
        }
      });

      ws.on('error', (e) => {
        clearTimeout(timer);
        fail(e as Error);
      });
    });
  }

  async close(): Promise<void> {
    this.pending.failAll('正在关闭');
    if (this.ws) safeClose(this.ws, 1000, 'peer shutting down');
    this.ws = null;
  }

  request(req: WithoutId<BridgeRequest>): Promise<BridgeData> {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) {
      return Promise.reject(new Error('与 Hub 的连接已断开，正在重新接管，请重试'));
    }
    if (!this.online) {
      return Promise.reject(new Error(extensionOfflineHint(this.reason)));
    }
    const id = this.pending.nextId('p');
    return new Promise<BridgeData>((resolve, reject) => {
      this.pending.add(
        id,
        (r) => (r.ok ? resolve(r.data) : reject(new Error(r.error))),
        () => reject(new Error('Hub 在 10 秒内没有响应，请重试')),
      );
      try {
        ws.send(JSON.stringify({ ...req, id }));
      } catch (e) {
        this.pending.settle(id, { id, ok: false, error: (e as Error).message });
      }
    });
  }
}

// ═══════════════════════════════════════════════════════════
// 选举：谁当 Hub
// ═══════════════════════════════════════════════════════════

/**
 * 建立一条桥。
 *
 * 先抢端口；抢不到就连上去当 Peer；连不上（Hub 恰好这一刻退出了）就重试抢。
 * Hub 掉线后 Peer 会自动重跑这套流程 —— 所以关掉任意一个 AI 工具，
 * 剩下的会自己接管，不需要用户做任何事。
 */
export async function createBridge(opts: {
  port: number;
  token: string;
  serverVersion: string;
  log: (...a: unknown[]) => void;
  WsCtor: typeof WebSocket;
}): Promise<BridgeTransport> {
  const { port, token, serverVersion, log, WsCtor } = opts;

  for (let tries = 0; tries < ELECTION_MAX_TRIES; tries++) {
    const hub = new HubBridge(port, token, serverVersion, log);
    try {
      await hub.start();
      log(`已成为 Hub，监听 127.0.0.1:${port}，等待扩展连接…`);
      return hub;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'EADDRINUSE') throw err;
      await hub.close().catch(() => undefined);
    }

    // 端口被占：说明已经有 Hub 了，去当 peer
    let rejoin: (() => void) | null = null;
    const peer = new PeerBridge(port, token, serverVersion, log, () => rejoin?.());
    try {
      await peer.connect(WsCtor);
      log(`已作为 peer 接入现有 Hub（127.0.0.1:${port}）—— 多个 AI 工具可以同时用`);
      // Hub 掉线时把这条 peer 换成一个新选举出来的传输层
      const resilient = new ResilientBridge(peer, () => createBridge(opts), log);
      rejoin = () => void resilient.reelect();
      return resilient;
    } catch {
      await peer.close().catch(() => undefined);
      // Hub 可能正好在 bind 和 connect 之间退出了，等一下再抢
      await sleep(ELECTION_RETRY_MS);
    }
  }
  throw new Error(
    `端口 ${port} 上既抢不到、也连不上。可能有别的程序占着它 —— ` +
      `换个端口（MOCK_STUDIO_PORT，同时改扩展设置页）或杀掉占用进程。`,
  );
}

/**
 * 包一层，让「Hub 换人」对上层透明。
 *
 * Hub 退出时（它的 AI 客户端关了），本进程会重新参与选举，
 * 可能升格成新的 Hub。上层拿到的对象引用不变。
 */
class ResilientBridge implements BridgeTransport {
  private inner: BridgeTransport;
  private reelecting: Promise<void> | null = null;

  constructor(
    initial: BridgeTransport,
    private readonly elect: () => Promise<BridgeTransport>,
    private readonly log: (...a: unknown[]) => void,
  ) {
    this.inner = initial;
  }

  get role() {
    return this.inner.role;
  }
  get extensionOnline() {
    return this.inner.extensionOnline;
  }
  get hint() {
    return this.inner.hint;
  }

  reelect(): Promise<void> {
    // 多条消息同时触发时只选一次
    if (this.reelecting) return this.reelecting;
    this.reelecting = (async () => {
      try {
        await this.inner.close().catch(() => undefined);
        this.inner = await this.elect();
        this.log(`重新选举完成，当前角色：${this.inner.role}`);
      } catch (e) {
        this.log('重新选举失败：', (e as Error).message);
      } finally {
        this.reelecting = null;
      }
    })();
    return this.reelecting;
  }

  async request(req: WithoutId<BridgeRequest>): Promise<BridgeData> {
    if (this.reelecting) await this.reelecting;
    return this.inner.request(req);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

// ═══════════════════════════════════════════════════════════

function extensionOfflineHint(lastReject: string | null): string {
  return lastReject
    ? `扩展连接被拒绝：${lastReject}`
    : '扩展还没连上来。请确认：① Chrome 里装了 Mock Studio 且已启用；' +
        '② 扩展设置页里「MCP 桥」开着；③ 端口和配对码与本服务端一致。';
}

function sendJson(ws: WebSocket, v: unknown): void {
  try {
    ws.send(JSON.stringify(v));
  } catch {
    /* 发不出去说明连接已坏，close 事件会接手 */
  }
}

function safeClose(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason.slice(0, 100));
  } catch {
    /* ignore */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 等长比较，不因为在第几位不同而提前返回 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
