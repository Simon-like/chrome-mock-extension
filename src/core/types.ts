/**
 * 规则数据模型 —— 整个系统的地基
 *
 * 对应设计文档 05 第 2 章。修改这里之前请先读那一章，
 * 尤其是几个关键决策的理由（body 为什么是 string、为什么单一 storage key）。
 *
 * 本文件属于 core 层，铁律：不允许出现 chrome.* / window.* / document.*
 */

/** 当前 Schema 版本。加字段并需要迁移时才 +1（见 store/migrate.ts） */
export const CURRENT_SCHEMA_VERSION = 1;

export type HttpMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'DELETE'
  | 'PATCH'
  | 'HEAD'
  | 'OPTIONS';

export const HTTP_METHODS: readonly HttpMethod[] = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS',
] as const;

/** URL 匹配模式（F2） */
export type UrlMode = 'contains' | 'wildcard' | 'regex';

/**
 * 规则类型（F22）
 * - override：接口真实存在，只改它的响应
 * - virtual ：后端根本没这个接口，凭空造一个
 *
 * 为什么要显式存储而不是运行时推断：我们拦截时根本不发出真实请求，
 * 所以永远不知道真实接口存不存在。详见设计文档 05 §2.3 决策三。
 */
export type RuleKind = 'override' | 'virtual';

/** 响应体类型。MVP 只实现 static，其余为 V1 预留 */
export type BodyType = 'static' | 'dynamic' | 'mockjs';

/** 特殊网络行为（F11 场景预设，V1 用） */
export type ResponseBehavior = 'normal' | 'timeout' | 'networkError';

/** 规则从哪来的 —— 用于统计与调试 */
export type RuleSource = 'manual' | 'capture' | 'ai' | 'import';

export interface MatchCondition {
  urlMode: UrlMode;
  /** 按 urlMode 解释：包含 / 通配符 / 正则 */
  url: string;
  /** 空数组 = 匹配所有 method */
  methods: HttpMethod[];
  /** 域名作用域（F15）。空数组 = 所有域名 */
  hosts: string[];
}

export interface ResponseSpec {
  status: number;
  headers: Record<string, string>;
  bodyType: BodyType;
  /**
   * 永远是字符串，不是对象。
   * 理由（设计文档 05 §2.3 决策一）：保真（大整数不丢精度）、
   * 兼容非 JSON、允许非法 JSON 草稿、为 dynamic 存 JS 源码铺路。
   */
  body: string;
  /** 套哪个响应外壳（F24）。null = 不套壳，body 即完整响应 */
  shellTemplateId: string | null;
  /** 延迟模拟（F12）。MVP 恒为 0 */
  delayMs: number;
  /** 特殊行为（F11）。缺省视为 normal */
  behavior?: ResponseBehavior;
}

export interface RuleMeta {
  createdAt: number;
  updatedAt: number;
  source: RuleSource;
  /**
   * 命中次数 —— 这不是统计癖，是诊断功能。
   * 注入式 mock 的改动不出现在 Network 面板，用户排查不生效问题时：
   * 命中数 0 = URL 没匹配上；命中数 >0 但页面没变 = 响应内容有问题。
   * 详见设计文档 05 §2.3 决策四。
   */
  hitCount: number;
  lastHitAt: number | null;
}

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  /** 所属分组（F13）。MVP 恒为 null */
  groupId: string | null;
  kind: RuleKind;
  match: MatchCondition;
  response: ResponseSpec;
  meta: RuleMeta;
}

export interface Group {
  id: string;
  name: string;
  /** 组开关：关掉则组内规则全部失效 */
  enabled: boolean;
  /**
   * 互斥组：同一时刻只允许一个互斥组处于启用状态。
   *
   * 这是「场景切换」的实现方式 —— 把「正常态 / 全空态 / 全错态」建成三个互斥组，
   * 点一下就整体切换，不需要再引入独立的 Scenario 概念。
   * 普通组（false）之间互不影响，可同时启用，用于按业务模块归拢规则。
   */
  exclusive: boolean;
  /** UI 折叠状态。放在数据里是为了刷新后保持 */
  collapsed?: boolean;
  defaultShellTemplateId: string | null;
}

export interface ShellTemplate {
  id: string;
  name: string;
  /** 内置模板不可删除 */
  builtin: boolean;
  /** 用 __DATA__ 占位，如 {"status":0,"message":"ok","data":__DATA__} */
  template: string;
}

export interface Settings {
  /** 是否采集请求流（F5） */
  captureEnabled: boolean;
  /** 请求流最多保留条数 */
  captureMaxCount: number;
  /** MCP 读侧总开关（Q11 决策：默认开） */
  aiReadEnabled: boolean;
  /** 读侧域名白名单 —— Q11 的不可关闭措施之一 */
  aiHostWhitelist: string[];
}

/**
 * 存储根对象。chrome.storage.local 里只存这一个 key。
 * 单 key 的理由是原子性：SW 随时可能被杀，多 key 分开写会留下不一致的中间状态。
 * 详见设计文档 05 §2.3 决策二。
 */
export interface MockStore {
  schemaVersion: number;
  /** 全局总开关（F4） */
  enabled: boolean;
  rules: Rule[];
  groups: Group[];
  shellTemplates: ShellTemplate[];
  settings: Settings;
}

/** storage 里的 key 名 */
export const STORE_KEY = 'mockStore';

// ───────────────────────────────────────────────────────────
// 引擎相关（非持久化）
// ───────────────────────────────────────────────────────────

/** 规范化后的请求信息，喂给 matcher */
export interface RequestInfo {
  /** 绝对 URL */
  url: string;
  method: HttpMethod;
  /** host（含端口），如 example.com:8080 */
  host: string;
}

/** matcher/responder 产出的纯数据，由各宿主自行转成 Response 或 XHR getter */
export interface MockResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  delayMs: number;
  behavior: ResponseBehavior;
}

/** 新建规则时的草稿：id 和 meta 由系统生成，调用方不填 */
export type RuleDraft = Omit<Rule, 'id' | 'meta'> & {
  meta?: Partial<RuleMeta>;
};
