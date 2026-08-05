/**
 * 命令定义（A3 落地）
 *
 * 铁律：所有对 store 的修改，只能通过 dispatch 一个 Command。
 *
 * 为什么值得这层间接：来源不同的操作（Popup 点开关、Options 编辑、
 * DevTools 转 Mock、V2 的 AI 通过 MCP 下发）必须走同一条路，
 * 否则校验、副作用、广播逻辑要各写一遍，状态不同步是必然的。
 *
 * 附带好处：Command 是可序列化对象，天然支持 postMessage 传输、
 * 操作日志、撤销重做，以及 V2 里把 MCP 工具调用直接翻译成 Command。
 *
 * 详见设计文档 05 §3.4。
 */

import type { Group, Rule, RuleDraft, Settings } from '../types.js';

export type Command =
  // ── 规则 ──
  | { type: 'CREATE_RULE'; payload: { draft: RuleDraft } }
  | { type: 'UPDATE_RULE'; payload: { id: string; patch: Partial<Omit<Rule, 'id' | 'meta'>> } }
  | { type: 'DELETE_RULE'; payload: { id: string } }
  | { type: 'TOGGLE_RULE'; payload: { id: string; enabled: boolean } }
  | { type: 'REORDER_RULE'; payload: { id: string; toIndex: number } }
  | { type: 'DUPLICATE_RULE'; payload: { id: string } }
  | { type: 'MOVE_RULE_TO_GROUP'; payload: { id: string; groupId: string | null; toIndex?: number } }
  // ── 分组 ──
  | { type: 'CREATE_GROUP'; payload: { name: string; exclusive?: boolean } }
  | { type: 'UPDATE_GROUP'; payload: { id: string; patch: Partial<Omit<Group, 'id'>> } }
  /** 删除分组。组内规则不删除，移到未分组 */
  | { type: 'DELETE_GROUP'; payload: { id: string } }
  /** 启用互斥组时会自动关闭其他互斥组 —— 这就是场景切换 */
  | { type: 'TOGGLE_GROUP'; payload: { id: string; enabled: boolean } }
  | { type: 'REORDER_GROUP'; payload: { id: string; toIndex: number } }
  // ── 全局 ──
  | { type: 'SET_GLOBAL_ENABLED'; payload: { enabled: boolean } }
  | { type: 'UPDATE_SETTINGS'; payload: { patch: Partial<Settings> } }
  // ── 导入导出 ──
  | { type: 'IMPORT_STORE'; payload: { raw: unknown; mode: 'replace' | 'merge' } }
  // ── 运行时统计 ──
  | { type: 'RECORD_HIT'; payload: { ruleId: string; at: number } };

export type CommandType = Command['type'];

/** reduce 的执行结果。ok=false 时 store 不变，error 说明原因 */
export interface CommandResult {
  ok: boolean;
  error?: string;
  /** 新建类命令返回生成的 id，方便调用方后续定位 */
  createdId?: string;
}
