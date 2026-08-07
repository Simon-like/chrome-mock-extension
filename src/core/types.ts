/**
 * 规则数据模型 —— 整个系统的地基
 *
 * 对应设计文档 05 第 2 章 与 08 号 PRD。修改前请先读那两份，
 * 尤其是几个关键决策的理由（body 为什么是 string、为什么单一 storage key、
 * 为什么是「规则持有多个变体」而非「多条规则共用一个 URL」）。
 *
 * 本文件属于 core 层，铁律：不允许出现 chrome.* / window.* / document.*
 */

/** 当前 Schema 版本。v2 引入项目层与变体 */
export const CURRENT_SCHEMA_VERSION = 2;

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

/** 响应体类型。MVP 只实现 static，其余为后续预留 */
export type BodyType = 'static' | 'dynamic' | 'mockjs';

/** 特殊网络行为（F11 场景预设） */
export type ResponseBehavior = 'normal' | 'timeout' | 'networkError';

/** 规则从哪来的 —— 用于统计与调试 */
export type RuleSource = 'manual' | 'capture' | 'ai' | 'import';

export interface MatchCondition {
  urlMode: UrlMode;
  /** 按 urlMode 解释：包含 / 通配符 / 正则 */
  url: string;
  /** 空数组 = 匹配所有 method */
  methods: HttpMethod[];
  /**
   * 域名作用域（F15）。空数组 = 不限。
   * 非空时【覆盖】所属项目的 hostScope（少数派例外场景）
   */
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
  /** 延迟模拟（F12） */
  delayMs: number;
  /** 特殊行为（F11）。缺省视为 normal */
  behavior?: ResponseBehavior;
}

/**
 * 变体 —— 同一接口的一份响应
 *
 * 一条规则可以有多个变体（正常 / 空数据 / 报错 / 超长列表…），
 * 同一时刻只有 activeVariantId 指向的那个生效。
 *
 * 为什么不用「多条规则共用一个 URL」来实现：那要靠「同一 URL 只启用一条」
 * 的隐式约定维持，用户很容易两条都开着，然后困惑为什么生效的是上面那条
 * （先到先得）。变体把「同一时刻只有一个」变成结构上的保证，配不错。
 * 详见 08 号 PRD §2.1。
 */
export interface Variant {
  id: string;
  /** 正常 / 空数据 / 报错… */
  name: string;
  response: ResponseSpec;
}

export interface RuleMeta {
  createdAt: number;
  updatedAt: number;
  source: RuleSource;
  /**
   * 命中次数 —— 这不是统计癖，是诊断功能。
   * 注入式 mock 的改动不出现在 Network 面板，用户排查不生效问题时：
   * 命中数 0 = URL 没匹配上；命中数 >0 但页面没变 = 响应内容有问题。
   */
  hitCount: number;
  lastHitAt: number | null;
}

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  /** 所属分组。null = 未分组 */
  groupId: string | null;
  /**
   * 所属项目。null = 未归档。
   * 与 groupId 冗余存储，因为规则可以「属于项目但不在任何分组」
   */
  projectId: string | null;
  kind: RuleKind;
  match: MatchCondition;

  /** 至少一个变体。不允许为空数组 */
  variants: Variant[];
  /** 当前生效的变体 id。必须指向 variants 中的某一个 */
  activeVariantId: string;

  meta: RuleMeta;
}

/**
 * 域名作用域
 *
 * 空 patterns = 不限域名（默认）—— 降低建项目的门槛，
 * 不必先想清楚域名才能开始用。
 */
export interface HostScope {
  mode: 'include' | 'exclude';
  patterns: string[];
}

/**
 * 项目 —— 最外层容器
 *
 * 它的独特价值是【绑定域名】。如果只是「更大的分组」，就没必要存在。
 * 解决的问题：同一个 /api/user/info 路径在 A 系统和 B 系统含义完全不同，
 * 有了项目就只配一次域名，而不是每条规则单独填。
 */
export interface Project {
  id: string;
  name: string;
  hostScope: HostScope;
  /** 项目级默认响应外壳，新建规则时自动带上 */
  defaultShellTemplateId: string | null;
}

export interface Group {
  id: string;
  name: string;
  /**
   * 注意这里【没有】enabled 字段。
   *
   * 分组的启用状态是组内规则的聚合结果，不是一个独立开关 ——
   * 否则会出现「组开着但规则全关」「组关着但规则全开」这类自相矛盾的状态，
   * 用户也分不清自己点的是哪一层。UI 上的分组复选框是「批量启用/停用组内规则」，
   * 三态显示（全开 / 全关 / 部分开）。
   */
  /** 所属项目。null = 全局分组（不属于任何项目） */
  projectId: string | null;
  /** UI 折叠状态。放在数据里是为了刷新后保持 */
  collapsed: boolean;
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
  /** 规则列表每页条数 */
  pageSize: number;
  /** MCP 读侧总开关。关掉后 AI 看不到任何请求记录，写侧仍可用 */
  aiReadEnabled: boolean;
  /**
   * 读侧域名白名单。空 = 不限。
   * 见 core/mcp/redact.ts 里 hostAllowed 的注释 —— 这里偏离了 02 §4.1，
   * 真正不可关的那道线是**脱敏**，不是白名单。
   */
  aiHostWhitelist: string[];
  /** MCP 桥总开关。默认关 —— 开一个 localhost 连接是用户该主动做的决定 */
  mcpEnabled: boolean;
  /** MCP Server 的 WebSocket 端口 */
  mcpPort: number;
  /**
   * 配对码。扩展生成、UI 显示，用户填进 MCP Server 的环境变量。
   * 空串表示还没生成过 —— 开启桥时会自动生成一个。
   */
  mcpToken: string;
}

/**
 * 存储根对象。chrome.storage.local 里只存这一个 key。
 * 单 key 的理由是原子性：SW 随时可能被杀，多 key 分开写会留下不一致的中间状态。
 */
export interface MockStore {
  schemaVersion: number;
  /** 全局总开关（F4） */
  enabled: boolean;
  projects: Project[];
  groups: Group[];
  rules: Rule[];
  shellTemplates: ShellTemplate[];
  settings: Settings;
  /** 当前选中的项目。null = 查看全部 */
  activeProjectId: string | null;
}

/** storage 里的 key 名 */
export const STORE_KEY = 'mockStore';

/**
 * MCP 桥的默认端口。
 *
 * 定义在 core 而不是 shared/bridge.ts —— 它是 Settings 的默认值之一，
 * 而 core 不能反向依赖 shared（分层铁律）。bridge.ts 从这里再导出一次。
 *
 * 刻意**不随机化**端口（02 §2.3 原本写的是随机化）：随机端口扩展就发现不了，
 * 除非再造一套端口协商，那反而多一个攻击面。安全靠配对码 + Origin 校验，
 * 不靠端口猜不到 —— 端口扫描是零成本的，靠它防守本来就是错觉。
 */
export const DEFAULT_BRIDGE_PORT = 8787;

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

/**
 * 响应体「生成」过程的诊断。
 *
 * dynamic（跑用户 JS）和 mockjs（展开模板）都属于「body 不是写死的，是算出来的」，
 * 失败表现和用户要看的信息完全一样 —— 所以共用一个字段，用 kind 区分，
 * 而不是各开一个平行字段让面板去 if/else 两遍。
 * 静态响应没有这个字段。
 */
export interface BodyGenDiagnostics {
  kind: Exclude<BodyType, 'static'>;
  ok: boolean;
  /** 失败原因（编译错 / 运行时抛错 / 模板非法 / 已熔断） */
  error?: string;
  durationMs: number;
  /** 超出耗时预算 */
  slow: boolean;
  /** 因连续失败被熔断，本次根本没执行 */
  tripped: boolean;
  /** 本条规则第一次报错 —— 宿主据此只 warn 一次，不刷屏 */
  firstFailure: boolean;
}

/** matcher/responder 产出的纯数据，由各宿主自行转成 Response 或 XHR getter */
export interface MockResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  delayMs: number;
  behavior: ResponseBehavior;
  /** body 生成过程的诊断，供请求面板标红。静态响应没有这个字段 */
  bodyGen?: BodyGenDiagnostics;
}

/** 新建规则时的草稿：id / meta / 变体 id 由系统生成 */
export type RuleDraft = Omit<Rule, 'id' | 'meta' | 'variants' | 'activeVariantId'> & {
  /** 变体草稿，id 可缺省 */
  variants: Array<Omit<Variant, 'id'> & { id?: string }>;
  /** 生效变体的【下标】，缺省为 0 */
  activeVariantIndex?: number;
  meta?: Partial<RuleMeta>;
};
