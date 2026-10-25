/**
 * MCP 桥（扩展侧）—— 作为 WebSocket client 连本机的 MCP Server
 *
 * 协议定义见 `@shared/bridge`。这里只负责三件事：
 *   1. 连上去并握手（配对码）
 *   2. 把桥请求翻译成已有的 dispatch / 读 captures —— **不新增任何业务逻辑**
 *   3. 断了自动重连
 *
 * ── 为什么不新增业务逻辑（A3 在兑现）────────────────
 * 写侧只有一条 `DISPATCH`，因为扩展里本来就只有 `dispatch(command)` 一个入口。
 * MCP 的每个写工具在 Node 侧翻译成 Command 就行，桥这边不需要为每个工具开一条消息。
 * 当初 A3 那层间接的价值就是在这里兑现的 —— 如果规则改动散在各处 UI 事件里，
 * 这个文件就得把它们全重实现一遍。
 *
 * ── Service Worker 生命周期 ─────────────────────────
 * SW 约 30 秒无事件就被杀。Chrome 116+ 起 **WebSocket 收发会重置这个计时器**，
 * 所以只要有心跳就能一直活着（manifest 已声明 minimum_chrome_version: 116）。
 * 但 SW 仍可能因为别的原因被回收，所以还有一层 alarms 兜底：
 * 每分钟醒一次，发现该连没连上就重连。
 */

import {
  BRIDGE_CLOSE,
  BRIDGE_PROTOCOL_VERSION,
  SILENCE_TIMEOUT_MS,
  type BridgeData,
  type BridgeEvent,
  type BridgeHello,
  type BridgeRequest,
  type BridgeResponse,
} from '@shared/bridge.js';
import { hostAllowed, redactCapture, redactUrl } from '@core/mcp/redact.js';
import type { Command } from '@core/command/types.js';
import { getCaptures } from './captureStore.js';

/**
 * 心跳间隔。要明显小于 SW 的 30s 空闲阈值 —— 它的作用是**保活 Service Worker**
 * （Chrome 116+ 的 WS 收发会重置空闲计时器），不是探活。
 * 探活由服务端的 PING 和下面的看门狗负责。
 */
const HEARTBEAT_MS = 20_000;
/** 看门狗多久检查一次「有多久没收到服务端消息了」 */
const WATCHDOG_MS = 15_000;
/** 重连退避：首次 1s，逐次翻倍，封顶 30s */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** SW 被回收后靠它唤醒重连。Chrome 的最小周期就是 1 分钟 */
export const RECONNECT_ALARM = 'mcp-bridge-reconnect';

type Deps = {
  getState: () => Promise<import('@core/types.js').MockStore>;
  dispatch: (cmd: Command) => Promise<import('@core/command/types.js').CommandResult>;
  /** dispatch 成功后要做的副作用（更新徽章、下发快照、通知 UI），复用 SW 里那一套 */
  afterDispatch: () => Promise<void>;
};

let deps: Deps | null = null;
let socket: WebSocket | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let watchdog: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * 最后一次收到**服务端消息**的时刻。
 *
 * 这是判断「连接还活着吗」的唯一可靠依据。
 * 不能靠 send() 成不成功：半开 socket 上 send() 只是写进本地缓冲区，
 * 不会抛错也不会触发 onclose —— 第一版就是因此永远显示「已连接」，
 * 而对端其实早就退出了。
 */
let lastSeenAt = 0;
let attempt = 0;
/** 已经主动关掉了（用户在设置里关的），别再自动重连 */
let stopped = true;

/**
 * 连接代次。每次 connect() +1，事件回调只认自己那一代。
 *
 * 没有它会出一个很隐蔽的 bug：用户在设置里改端口时，connect(新端口) 会先关掉旧 socket，
 * 而旧 socket 的 onclose 闭包里捕获的是**旧端口** —— 它异步触发后会
 * ① 把状态覆盖成「旧端口断开」，盖掉新连接的状态；
 * ② 安排一次到旧端口的重连，而那次重连又会关掉刚建好的新连接。
 * 结果就是两个端口互相踢，界面上时连时断，日志里看着像网络不稳。
 *
 * 判定「我还是当前那条连接吗」不能用 `socket === ws`：
 * 新连接建立后 socket 已经换人，旧回调的这个判断会为 false 而**跳过清理**，
 * 却继续往下执行后面的状态覆盖和重连 —— 正是上面那个 bug 的来源。
 */
let generation = 0;

export type BridgeStatus =
  | { state: 'off' }
  | { state: 'connecting'; port: number }
  /** silentMs：距上次收到服务端消息多久了，供 UI 显示真实活跃度 */
  | { state: 'connected'; port: number; silentMs: number }
  | { state: 'error'; port: number; reason: string };

let status: BridgeStatus = { state: 'off' };

export function getBridgeStatus(): BridgeStatus {
  // 连接态是**算出来的**，不是存下来的 —— 存下来的状态会латch 在「已连接」
  if (status.state === 'connected') {
    return { ...status, silentMs: Date.now() - lastSeenAt };
  }
  return status;
}

export function initBridge(d: Deps): void {
  deps = d;
}

// ═══════════════════════════════════════════════════════════
// 连接
// ═══════════════════════════════════════════════════════════

/** 按当前设置决定该连还是该断。设置变了、SW 冷启动、alarm 醒来都调它 */
export async function syncBridge(): Promise<void> {
  if (!deps) return;
  const { settings } = await deps.getState();

  if (!settings.mcpEnabled || !settings.mcpToken) {
    stop();
    return;
  }
  // 已经连着同一个端口就什么都不用做
  if (socket && socket.readyState <= WebSocket.OPEN && status.state !== 'off') {
    if ('port' in status && status.port === settings.mcpPort) return;
  }
  stopped = false;
  // 换了目标（端口/配对码变了）就重置退避 —— 用户刚改完设置，
  // 不该让他为上一个目标积累的失败次数买单，等最长 30 秒才重连
  attempt = 0;
  connect(settings.mcpPort, settings.mcpToken);
}

export function stop(): void {
  stopped = true;
  attempt = 0;
  generation++; // 让所有在途回调失效
  clearHeartbeat();
  clearReconnectTimer();
  if (socket) {
    // 1000 = 正常关闭。用它服务端就知道不是异常断开，不必刷日志
    try {
      socket.close(1000, 'disabled');
    } catch {
      /* 关一个已经坏掉的 socket 不该再抛 */
    }
    socket = null;
  }
  status = { state: 'off' };
}

function connect(port: number, token: string): void {
  const gen = ++generation;
  clearHeartbeat();
  clearReconnectTimer();
  if (socket) {
    try {
      // 1000 = 正常关闭：这是我们主动换连接，不是异常断开
      socket.close(1000, 'reconnect');
    } catch {
      /* ignore */
    }
    socket = null;
  }

  status = { state: 'connecting', port };

  let ws: WebSocket;
  try {
    // 127.0.0.1 而不是 localhost：localhost 可能解析到 ::1，
    // 而 Node 的 server 默认只监听 IPv4，会连不上且报错很难懂
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch (e) {
    status = { state: 'error', port, reason: (e as Error).message };
    scheduleReconnect(port, token, gen);
    return;
  }
  socket = ws;

  ws.onopen = () => {
    const hello: BridgeHello = {
      type: 'HELLO',
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      role: 'extension',
      token,
      clientVersion: chrome.runtime.getManifest().version,
    };
    ws.send(JSON.stringify(hello));
  };

  ws.onmessage = (ev) => {
    if (gen !== generation) return;
    void handleMessage(ws, ev.data, port, token, gen);
  };

  ws.onerror = () => {
    if (gen !== generation) return;
    // onerror 之后必然跟一个 onclose，重连逻辑放那边，避免连两次
    status = { state: 'error', port, reason: '连接失败 —— MCP Server 没在运行？' };
  };

  ws.onclose = (ev) => {
    // 已经被更新的连接取代了 —— 闭嘴，什么都别做。
    // 少了这一句，改端口时旧连接会把新连接踢掉（见 generation 的注释）
    if (gen !== generation) return;

    clearHeartbeat();
    socket = null;
    if (stopped) return;
    // 4004/4005 不是「配置错了」，是连接被换掉/被判死 —— 这两种要继续重连
    if (ev.code === BRIDGE_CLOSE.SUPERSEDED || ev.code === BRIDGE_CLOSE.STALE) {
      status = { state: 'error', port, reason: '连接已被替换，正在重连…' };
      scheduleReconnect(port, token, gen);
      return;
    }
    // 其余 4000 段是握手被拒（配对码/协议版本不对）。重连一万次也还是被拒，
    // 停下来让用户去改设置，别在后台无声地空转
    if (ev.code >= 4000 && ev.code < 5000) {
      status = { state: 'error', port, reason: ev.reason || '握手被拒绝' };
      stopped = true;
      return;
    }
    status = { state: 'error', port, reason: '连接已断开，正在重连…' };
    scheduleReconnect(port, token, gen);
  };
}

function scheduleReconnect(port: number, token: string, gen: number): void {
  if (stopped || gen !== generation) return;
  clearReconnectTimer();
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
  attempt++;
  reconnectTimer = setTimeout(() => {
    // 等待期间设置可能又变了，醒来要再确认一次自己没过期
    if (!stopped && gen === generation) connect(port, token);
  }, delay);
}

function clearReconnectTimer(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

/**
 * 两个定时器，职责完全不同，别合并：
 *   - 心跳：**发**东西，目的是让 Service Worker 不被回收
 *   - 看门狗：**看**有多久没收到东西，目的是发现死连接
 * 只有前者的话就是第一版那个 bug：一直在发，一直以为自己连着。
 */
function startKeepalive(ws: WebSocket, port: number, token: string, gen: number): void {
  clearHeartbeat();
  lastSeenAt = Date.now();

  heartbeat = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const event: BridgeEvent = { type: 'EVENT', event: 'STATE_CHANGED' };
    try {
      ws.send(JSON.stringify({ ...event, heartbeat: true }));
    } catch {
      /* 发不出去说明连接已经坏了，onclose 会接手 */
    }
  }, HEARTBEAT_MS);

  watchdog = setInterval(() => {
    if (gen !== generation) return;
    if (Date.now() - lastSeenAt < SILENCE_TIMEOUT_MS) return;
    // 服务端已经很久没吭声了。它正常情况下每 20 秒会 PING 一次，
    // 静默这么久说明对端没了 —— 主动断开触发重连，别耗在假连接上
    status = { state: 'error', port, reason: '服务端长时间无响应，正在重连…' };
    try {
      ws.close(1000, 'silence timeout');
    } catch {
      /* ignore */
    }
    // close 可能因为对端已消失而迟迟不触发 onclose，这里直接安排重连兜底
    scheduleReconnect(port, token, gen);
  }, WATCHDOG_MS);
}

function clearHeartbeat(): void {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  if (watchdog) clearInterval(watchdog);
  watchdog = null;
}

// ═══════════════════════════════════════════════════════════
// 消息处理
// ═══════════════════════════════════════════════════════════

async function handleMessage(
  ws: WebSocket,
  raw: unknown,
  port: number,
  token: string,
  gen: number,
): Promise<void> {
  // 收到任何东西都算「对端还活着」—— 看门狗就看这个
  lastSeenAt = Date.now();

  // 故意用宽松类型：这是**信任边界**，对端发什么都可能。
  // 先当成任意 JSON 收下，逐字段验完再往下走
  let msg: { type?: string; id?: string; reason?: string };
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return; // 收到看不懂的东西就丢掉，绝不因此断开
  }
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'WELCOME') {
    attempt = 0;
    status = { state: 'connected', port, silentMs: 0 };
    startKeepalive(ws, port, token, gen);
    return;
  }

  if (msg.type === 'REJECT') {
    status = { state: 'error', port, reason: msg.reason ?? '握手被拒绝' };
    stopped = true;
    return;
  }

  if (!msg.id || !msg.type) return;

  const response = await answer(msg as unknown as BridgeRequest);
  try {
    ws.send(JSON.stringify(response));
  } catch {
    /* 连接已断，下次重连后 MCP 端会重试 */
  }
}

/** 把桥请求翻译成扩展里已有的能力。**这里不实现任何新的业务规则** */
async function answer(req: BridgeRequest): Promise<BridgeResponse> {
  if (!deps) return { id: req.id, ok: false, error: '桥未初始化' };

  try {
    switch (req.type) {
      case 'PING':
        return ok(req.id, { kind: 'pong' });

      case 'GET_STATE':
        return ok(req.id, { kind: 'state', store: await deps.getState() });

      case 'DISPATCH': {
        const result = await deps.dispatch(req.command);
        if (result.ok) await deps.afterDispatch();
        return ok(req.id, { kind: 'dispatch', result });
      }

      case 'GET_CAPTURES': {
        const gate = await readGate();
        if (gate) return ok(req.id, { kind: 'captures', entries: [], total: 0, readDisabled: true });

        const page = req.activeTab ? await getActivePage() : null;
        // 活动页不存在时返回空集，不能退化成“所有标签页”。
        const all = req.activeTab && !page ? [] : await visibleCaptures(page?.id);
        let list = all;
        if (req.onlyMocked) list = list.filter((e) => e.mocked);
        if (req.onlyUnmocked) list = list.filter((e) => !e.mocked);
        if (req.urlFilter) {
          const kw = req.urlFilter.toLowerCase();
          list = list.filter((e) => e.url.toLowerCase().includes(kw));
        }
        // 最近的在前 —— AI 问「页面刚发了什么」时想看的是最新的
        const ordered = [...list].reverse();
        const limit = Math.min(Math.max(1, req.limit ?? 30), 200);
        return ok(req.id, {
          kind: 'captures',
          entries: ordered.slice(0, limit),
          total: ordered.length,
          ...(req.activeTab ? { page } : {}),
        });
      }

      case 'GET_CAPTURE_DETAIL': {
        const gate = await readGate();
        if (gate) return ok(req.id, { kind: 'captureDetail', entry: null, readDisabled: true });
        const found = (await visibleCaptures()).find((e) => e.id === req.captureId) ?? null;
        return ok(req.id, { kind: 'captureDetail', entry: found });
      }

      default:
        return { id: (req as { id: string }).id, ok: false, error: '未知的请求类型' };
    }
  } catch (e) {
    // 桥的任何异常都不该让 SW 崩掉，也不该让 MCP 端挂起等待
    return { id: req.id, ok: false, error: (e as Error).message };
  }
}

function ok(id: string, data: BridgeData): BridgeResponse {
  return { id, ok: true, data };
}

/** 读侧关掉时返回 true。返回值是「是否被拦住」，调用处读起来才顺 */
async function readGate(): Promise<boolean> {
  const { settings } = await deps!.getState();
  return !settings.aiReadEnabled;
}

/**
 * 能出给 AI 的请求记录。
 *
 * 两道处理，顺序不能反：
 *   1. 域名白名单过滤 —— 不在白名单里的**根本不出现**
 *   2. 脱敏 —— 出去的每一条都过一遍，不可跳过
 *
 * 脱敏放在扩展侧而不是 MCP 侧：万一 WS 端口被别的进程连上，
 * 它拿到的也已经是脱敏过的数据。防线要设在数据离开之前。
 */
async function visibleCaptures(tabId?: number) {
  const { settings } = await deps!.getState();
  const all = await getCaptures(tabId);
  return all
    .filter((e) => hostAllowed(hostOf(e.url), settings.aiHostWhitelist))
    .map((entry) => ({ ...redactCapture(entry), tabId: entry.tabId }));
}

/** 只暴露当前页的最小上下文；页面 URL 和请求 URL 走同一套脱敏。 */
async function getActivePage() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (typeof tab?.id !== 'number') return null;
  return {
    id: tab.id,
    title: tab.title ?? '',
    url: redactUrl(tab.url ?? ''),
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
