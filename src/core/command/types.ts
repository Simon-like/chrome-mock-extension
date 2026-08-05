/**
 * 命令定义（A3 落地）
 *
 * 铁律：所有对 store 的修改，只能通过 dispatch 一个 Command。
 *
 * 为什么值得这层间接：来源不同的操作（Popup 点开关、Options 编辑、
 * DevTools 转 Mock、未来 AI 通过 MCP 下发）必须走同一条路，
 * 否则校验、副作用、广播逻辑要各写一遍，状态不同步是必然的。
 *
 * 附带好处：Command 是可序列化对象，天然支持 postMessage 传输、
 * 操作日志、撤销重做，以及把 MCP 工具调用直接翻译成 Command。
 */

import type { Group, Project, ResponseSpec, Rule, RuleDraft, Settings } from '../types.js';

export type Command =
  // ── 规则 ──
  | { type: 'CREATE_RULE'; payload: { draft: RuleDraft } }
  | {
      type: 'UPDATE_RULE';
      payload: {
        id: string;
        patch: Partial<Omit<Rule, 'id' | 'meta' | 'variants' | 'activeVariantId'>>;
      };
    }
  | { type: 'DELETE_RULE'; payload: { id: string } }
  | { type: 'TOGGLE_RULE'; payload: { id: string; enabled: boolean } }
  | { type: 'REORDER_RULE'; payload: { id: string; toIndex: number } }
  | { type: 'DUPLICATE_RULE'; payload: { id: string } }
  | {
      type: 'MOVE_RULE';
      payload: {
        id: string;
        projectId?: string | null;
        groupId?: string | null;
        toIndex?: number;
      };
    }
  // ── 变体 ──
  /** 切换当前生效的变体 —— 最高频操作 */
  | { type: 'SET_ACTIVE_VARIANT'; payload: { ruleId: string; variantId: string } }
  | {
      type: 'CREATE_VARIANT';
      payload: {
        ruleId: string;
        name: string;
        /** 缺省则复制当前生效变体的响应 */
        response?: ResponseSpec;
        /** 建完是否立刻切过去，默认 true */
        activate?: boolean;
      };
    }
  | {
      type: 'UPDATE_VARIANT';
      payload: {
        ruleId: string;
        variantId: string;
        patch: { name?: string; response?: Partial<ResponseSpec> };
      };
    }
  | { type: 'DELETE_VARIANT'; payload: { ruleId: string; variantId: string } }
  | { type: 'REORDER_VARIANT'; payload: { ruleId: string; variantId: string; toIndex: number } }
  // ── 项目 ──
  | { type: 'CREATE_PROJECT'; payload: { name: string } }
  | { type: 'UPDATE_PROJECT'; payload: { id: string; patch: Partial<Omit<Project, 'id'>> } }
  /**
   * 删除项目。cascade 决定其下的分组与规则怎么办：
   *   'detach'（默认）—— 降级为全局分组 / 未归档规则，内容保留
   *   'cascade'       —— 连同分组与规则一起删除
   * 默认值刻意选保守的那个：删错了还能找回来，删没了找不回来。
   */
  | { type: 'DELETE_PROJECT'; payload: { id: string; cascade?: 'detach' | 'cascade' } }
  | { type: 'SET_ACTIVE_PROJECT'; payload: { id: string | null } }
  // ── 分组 ──
  | { type: 'CREATE_GROUP'; payload: { name: string; projectId?: string | null } }
  | { type: 'UPDATE_GROUP'; payload: { id: string; patch: Partial<Omit<Group, 'id'>> } }
  /**
   * 删除分组。cascade 决定组内规则怎么办：
   *   'detach'（默认）—— 移到「未分组」，规则保留
   *   'cascade'       —— 连同规则一起删除
   */
  | { type: 'DELETE_GROUP'; payload: { id: string; cascade?: 'detach' | 'cascade' } }
  /** 批量启用/停用组内规则。id 传 null 表示「未分组」那一堆 */
  | { type: 'TOGGLE_GROUP'; payload: { id: string | null; enabled: boolean } }
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
