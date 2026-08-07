/**
 * MCP 桥接协议 —— Node 进程 ↔ 扩展 Service Worker
 *
 * ```
 *   Claude Code / Cursor
 *         ↕  stdio（MCP 协议）
 *   mock-mcp-server（Node 进程，跑 WS server）
 *         ↕  WebSocket（localhost）        ← 本文件定义这一段
 *   Chrome 扩展 Service Worker（WS client）
 *         ↕  chrome.runtime
 *   注入层
 * ```
 *
 * ── 为什么是插件连服务端，不是反过来 ────────────────
 * 扩展里起不了 server。只能插件作为 client 主动连 localhost。
 *
 * ── 为什么这个文件用相对导入 ────────────────────────
 * `@core` / `@shared` 是 Vite 的别名，Node 侧的 MCP Server 不认。
 * 而这份协议**两边都要用**，所以它必须是两边都能直接 import 的形态。
 * 这正是 A1（core 层零 chrome 依赖）当初留的口子在兑现。
 */

import type { Command, CommandResult } from '../core/command/types.js';
import type { MockStore, ShellTemplate } from '../core/types.js';

/** 协议版本。两端不一致时握手直接失败，比运行到一半字段对不上强 */
export const BRIDGE_PROTOCOL_VERSION = 1;

// 端口常量的本体在 core（它是 Settings 的默认值，core 不能反向依赖 shared）
export { DEFAULT_BRIDGE_PORT } from '../core/types.js';

// ═══════════════════════════════════════════════════════════
// 握手
// ═══════════════════════════════════════════════════════════

/** 扩展连上后发的第一条消息。服务端校验通过才认这条连接 */
export interface BridgeHello {
  type: 'HELLO';
  protocolVersion: number;
  /** 配对码。扩展 UI 里生成并显示，用户填进 MCP Server 的环境变量 */
  token: string;
  extensionVersion: string;
}

export interface BridgeWelcome {
  type: 'WELCOME';
  serverVersion: string;
}

/** 握手失败时服务端在关闭连接前说明原因，避免扩展端只看到一个无声的断开 */
export interface BridgeReject {
  type: 'REJECT';
  reason: string;
}

/** 关闭码。4000 段是应用自定义区间 */
export const BRIDGE_CLOSE = {
  BAD_TOKEN: 4001,
  BAD_ORIGIN: 4002,
  BAD_PROTOCOL: 4003,
} as const;

// ═══════════════════════════════════════════════════════════
// 请求（Node → 扩展）
// ═══════════════════════════════════════════════════════════

export type BridgeRequest =
  /** 读整份 store。AI 要先知道现在有哪些规则、哪些外壳模板 */
  | { id: string; type: 'GET_STATE' }
  /**
   * 所有写操作都走这一条 —— 因为扩展侧本来就只有 dispatch 一个入口（A3）。
   * 桥不需要为每个工具设计一条消息，MCP 工具直接翻译成 Command 即可。
   */
  | { id: string; type: 'DISPATCH'; command: Command }
  /** 读请求流。读侧的核心 */
  | {
      id: string;
      type: 'GET_CAPTURES';
      limit?: number;
      /** 只看被 mock 命中的 / 只看没命中的 */
      onlyMocked?: boolean;
      onlyUnmocked?: boolean;
      /** URL 子串过滤 */
      urlFilter?: string;
    }
  | { id: string; type: 'GET_CAPTURE_DETAIL'; captureId: string }
  /** 心跳。同时兼顾「保活 SW」和「探测对端还在不在」 */
  | { id: string; type: 'PING' };

// ═══════════════════════════════════════════════════════════
// 响应（扩展 → Node）
// ═══════════════════════════════════════════════════════════

export type BridgeResponse =
  | { id: string; ok: true; data: BridgeData }
  | { id: string; ok: false; error: string };

export type BridgeData =
  | { kind: 'state'; store: MockStore }
  | { kind: 'dispatch'; result: CommandResult }
  | { kind: 'captures'; entries: RedactedCapture[]; total: number; readDisabled?: boolean }
  | { kind: 'captureDetail'; entry: RedactedCapture | null; readDisabled?: boolean }
  | { kind: 'pong' }
  | { kind: 'shellTemplates'; templates: ShellTemplate[] };

/**
 * 出给 AI 的请求记录。
 *
 * 与 `CapturedRequest` 的区别：**url 和 body 已经脱敏**（core/mcp/redact.ts），
 * 且已按域名白名单过滤过。类型上分开，是为了让「哪份数据能出去」在编译期可见 ——
 * 直接把 CapturedRequest 发出去会编译不过。
 */
export interface RedactedCapture {
  id: string;
  at: number;
  url: string;
  method: string;
  api: 'fetch' | 'xhr';
  mocked: boolean;
  ruleId: string | null;
  ruleName: string | null;
  status: number | null;
  body: string | null;
  truncated: boolean;
  durationMs: number | null;
  /** 本条是否有内容被打码 —— 让 AI 知道自己看到的不是全貌 */
  redacted: boolean;
}

// ═══════════════════════════════════════════════════════════
// 事件（扩展 → Node，无需应答）
// ═══════════════════════════════════════════════════════════

/**
 * 目前只有一条。刻意**不**推送请求流 ——
 * 推的话每个页面请求都要过一次 WS，而 AI 只在被问到时才需要看，
 * 拉模式（GET_CAPTURES）足够，还顺带省掉了「AI 没在看时也在传敏感数据」。
 */
export interface BridgeEvent {
  type: 'EVENT';
  event: 'STATE_CHANGED';
}

export type BridgeClientMessage = BridgeHello | BridgeResponse | BridgeEvent;
export type BridgeServerMessage = BridgeWelcome | BridgeReject | BridgeRequest;

// ═══════════════════════════════════════════════════════════

export function isBridgeResponse(m: unknown): m is BridgeResponse {
  return !!m && typeof m === 'object' && 'id' in m && 'ok' in m;
}

export function isBridgeEvent(m: unknown): m is BridgeEvent {
  return !!m && typeof m === 'object' && (m as { type?: string }).type === 'EVENT';
}
