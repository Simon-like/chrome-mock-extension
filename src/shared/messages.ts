/**
 * 消息协议
 *
 * 对应设计文档 05 §4.1 的消息类型总表。
 *
 * 和 core 的区别：core 是业务逻辑（V2 的 MCP Server 在 Node 里也能复用），
 * shared 是插件内部的通信约定（只在浏览器里有意义）。
 */

import type { Command } from '@core/command/types.js';
import type { MockStore, Rule } from '@core/types.js';

/** MAIN world ↔ ISOLATED 之间的 postMessage 频道标识 */
export const PAGE_CHANNEL = '__MOCK_STUDIO__';

// ───────────────────────────────────────────────────────────
// UI ↔ Service Worker（chrome.runtime.sendMessage）
// ───────────────────────────────────────────────────────────

export type UiRequest =
  | { type: 'GET_STATE' }
  | { type: 'DISPATCH'; command: Command }
  | { type: 'GET_CAPTURES' }
  | { type: 'CLEAR_CAPTURES' };

export type UiResponse =
  | { type: 'STATE'; store: MockStore }
  | { type: 'DISPATCH_RESULT'; ok: boolean; error?: string; createdId?: string }
  | { type: 'CAPTURES'; entries: CapturedRequest[] }
  | { type: 'OK' };

/** SW 主动推给 UI 的广播 */
export type SwBroadcast =
  | { type: 'STATE_CHANGED'; store: MockStore }
  | { type: 'CAPTURE_ADDED'; entry: CapturedRequest };

// ───────────────────────────────────────────────────────────
// 页面内：MAIN world ↔ ISOLATED（window.postMessage）
// ───────────────────────────────────────────────────────────

/** SW → content → MAIN：规则快照下发 */
export interface RulesSnapshotMessage {
  channel: typeof PAGE_CHANNEL;
  type: 'RULES_SNAPSHOT';
  /** 引擎只需要这些字段，不下发整个 store（减小传输量） */
  snapshot: EngineSnapshot;
}

/** MAIN → content → SW：请求观测事件 */
export interface RequestEventMessage {
  channel: typeof PAGE_CHANNEL;
  type: 'REQUEST_EVENT';
  entry: CapturedRequest;
}

export type PageMessage = RulesSnapshotMessage | RequestEventMessage;

/**
 * 下发给引擎的规则快照。
 *
 * 为什么不直接传整个 MockStore：引擎只需要匹配和构造响应，
 * meta/settings 等字段用不上。每个 tab 都要传一份，能省就省。
 */
export interface EngineSnapshot {
  enabled: boolean;
  rules: Rule[];
  groups: MockStore['groups'];
  /** 项目的域名作用域参与匹配，所以引擎也需要 */
  projects: MockStore['projects'];
  shellTemplates: MockStore['shellTemplates'];
  captureEnabled: boolean;
  /** 版本号，用于判断快照是否需要更新 */
  revision: number;
}

// ───────────────────────────────────────────────────────────
// 采集的请求记录
// ───────────────────────────────────────────────────────────

export interface CapturedRequest {
  id: string;
  at: number;
  url: string;
  method: string;
  /** 'fetch' | 'xhr' */
  api: 'fetch' | 'xhr';
  /** 是否被 mock 命中 */
  mocked: boolean;
  /** 命中的规则 id 与名称，便于 UI 直接展示 */
  ruleId: string | null;
  ruleName: string | null;
  status: number | null;
  /** 响应体。可能被截断，见 truncated */
  body: string | null;
  truncated: boolean;
  /** 耗时（毫秒） */
  durationMs: number | null;
}

// ───────────────────────────────────────────────────────────
// DevTools ↔ SW 长连接
// ───────────────────────────────────────────────────────────

export const DEVTOOLS_PORT_NAME = 'devtools-panel';

export interface DevtoolsPortMessage {
  type: 'SUBSCRIBE' | 'UNSUBSCRIBE';
  /** 只关心这个 tab 的请求 */
  tabId?: number;
}
