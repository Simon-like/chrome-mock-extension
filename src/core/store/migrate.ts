/**
 * Schema 版本迁移
 *
 * 为什么这个机制值得存在：第一次需要迁移的时候，往往已经有辛苦配了
 * 几十条规则的存量数据。那时再补机制，要么丢数据，要么临时写一堆兼容代码。
 *
 * v1 → v2 就是第一次真正用上它 —— 引入项目层与变体，Rule.response
 * 移进 Variant，是破坏性结构变更。
 */

import {
  CURRENT_SCHEMA_VERSION,
  type Group,
  type MockStore,
  type Project,
  type Rule,
  type Variant,
} from '../types.js';
import {
  BUILTIN_SHELL_TEMPLATES,
  DEFAULT_VARIANT_NAME,
  createDefaultStore,
  createResponseSpec,
} from './defaults.js';

type Bag = Record<string, unknown>;
type Migration = (old: Bag, idFactory: () => string) => Bag;

/**
 * key 是【目标版本】。migrations[2] 负责把 v1 迁到 v2。
 */
const migrations: Record<number, Migration> = {
  2: migrateV1ToV2,
};

export interface MigrateResult {
  store: MockStore;
  /** 是否发生了重置（版本断层或数据损坏） */
  reset: boolean;
  reason?: string;
  /** 迁移过程中需要告知用户的变化，UI 上给一次性提示 */
  notices: string[];
}

export function migrate(raw: unknown, idFactory: () => string = fallbackId): MigrateResult {
  const notices: string[] = [];

  if (!raw || typeof raw !== 'object') {
    return { store: createDefaultStore(), reset: true, reason: '无有效数据', notices };
  }

  let store = raw as Bag;
  let version = typeof store.schemaVersion === 'number' ? store.schemaVersion : 1;

  if (version > CURRENT_SCHEMA_VERSION) {
    // 来自更新版本的插件 —— 不敢降级处理，避免丢字段
    return {
      store: createDefaultStore(),
      reset: true,
      reason: `数据版本 v${version} 高于当前支持的 v${CURRENT_SCHEMA_VERSION}，可能来自更新版本的插件`,
      notices,
    };
  }

  while (version < CURRENT_SCHEMA_VERSION) {
    const next = version + 1;
    const fn = migrations[next];
    if (!fn) {
      return {
        store: createDefaultStore(),
        reset: true,
        reason: `缺少 v${version} → v${next} 的迁移函数`,
        notices,
      };
    }
    store = fn(store, idFactory);
    version = next;

    if (next === 2) {
      const exclusiveCount = countExclusiveGroups(raw as Bag);
      if (exclusiveCount > 0) {
        notices.push(
          `${exclusiveCount} 个互斥分组已变为普通分组 —— 「场景」功能重做中，` +
            `同一接口的多份响应现在用「变体」表达`,
        );
      }
      notices.push('规则的响应已包装为「默认」变体，可在编辑器里新增更多变体');
    }
  }

  return { store: heal(store, idFactory), reset: false, notices };
}

// ═══════════════════════════════════════════════════════════
// v1 → v2
// ═══════════════════════════════════════════════════════════

/**
 * 主要变化：
 *   1. Rule.response  → Rule.variants[0].response，并补 activeVariantId
 *   2. 新增 projects 与 Rule.projectId / Group.projectId
 *   3. Group.exclusive 移除（场景重做，本轮不实现）
 *
 * 不自动创建项目 —— 用户的规则保持「未归档」状态，由他自己整理。
 * 擅自建项目并把规则塞进去，反而要用户先理解再撤销。
 */
function migrateV1ToV2(old: Bag, idFactory: () => string): Bag {
  const rules = Array.isArray(old.rules) ? (old.rules as Bag[]) : [];
  const groups = Array.isArray(old.groups) ? (old.groups as Bag[]) : [];

  return {
    ...old,
    schemaVersion: 2,
    projects: [],
    activeProjectId: null,
    rules: rules.map((r) => upgradeRule(r, idFactory)),
    groups: groups.map((g) => {
      const { exclusive: _drop, ...rest } = g;
      return { ...rest, projectId: null };
    }),
  };
}

function upgradeRule(r: Bag, idFactory: () => string): Bag {
  const { response, ...rest } = r;
  const variantId = idFactory();

  return {
    ...rest,
    projectId: null,
    variants: [
      {
        id: variantId,
        name: DEFAULT_VARIANT_NAME,
        response: response ?? createResponseSpec(),
      },
    ],
    activeVariantId: variantId,
  };
}

function countExclusiveGroups(raw: Bag): number {
  if (!Array.isArray(raw.groups)) return 0;
  return (raw.groups as Bag[]).filter((g) => g?.exclusive === true).length;
}

// ═══════════════════════════════════════════════════════════
// 结构自愈
// ═══════════════════════════════════════════════════════════

/**
 * 补齐缺失字段。
 *
 * 导入的文件、手工编辑过的数据、AI 生成的规则都可能缺字段。
 * 与其在各处写防御性代码，不如在入口一次性补齐，让下游可以信任类型。
 */
function heal(s: Bag, idFactory: () => string): MockStore {
  const def = createDefaultStore();
  const settings = (s.settings ?? {}) as Bag;

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    enabled: typeof s.enabled === 'boolean' ? s.enabled : def.enabled,
    projects: healProjects(s.projects),
    groups: healGroups(s.groups),
    rules: healRules(s.rules, idFactory),
    shellTemplates: mergeShellTemplates(s.shellTemplates),
    settings: {
      captureEnabled: bool(settings.captureEnabled, def.settings.captureEnabled),
      captureMaxCount: posInt(settings.captureMaxCount, def.settings.captureMaxCount),
      pageSize: posInt(settings.pageSize, def.settings.pageSize),
      aiReadEnabled: bool(settings.aiReadEnabled, def.settings.aiReadEnabled),
      aiHostWhitelist: Array.isArray(settings.aiHostWhitelist)
        ? (settings.aiHostWhitelist as string[])
        : [],
      mcpEnabled: bool(settings.mcpEnabled, def.settings.mcpEnabled),
      mcpPort: posInt(settings.mcpPort, def.settings.mcpPort),
      mcpToken: typeof settings.mcpToken === 'string' ? settings.mcpToken : '',
    },
    activeProjectId: typeof s.activeProjectId === 'string' ? s.activeProjectId : null,
  };
}

function healProjects(raw: unknown): Project[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is Bag => !!p && typeof p === 'object')
    .map((p): Project => {
      const scope = (p.hostScope ?? {}) as Bag;
      return {
        id: String(p.id ?? ''),
        name: String(p.name ?? '未命名项目'),
        hostScope: {
          mode: scope.mode === 'exclude' ? 'exclude' : 'include',
          // 空数组 = 不限域名，这是默认值
          patterns: Array.isArray(scope.patterns) ? (scope.patterns as string[]) : [],
        },
        defaultShellTemplateId:
          typeof p.defaultShellTemplateId === 'string' ? p.defaultShellTemplateId : null,
      };
    })
    .filter((p) => p.id);
}

function healGroups(raw: unknown): Group[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((g): g is Bag => !!g && typeof g === 'object')
    .map((g) => ({
      id: String(g.id ?? ''),
      name: String(g.name ?? '未命名分组'),
      projectId: typeof g.projectId === 'string' ? g.projectId : null,
      collapsed: g.collapsed === true,
      defaultShellTemplateId:
        typeof g.defaultShellTemplateId === 'string' ? g.defaultShellTemplateId : null,
    }))
    .filter((g) => g.id);
}

function healRules(raw: unknown, idFactory: () => string): Rule[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Bag => !!r && typeof r === 'object')
    .map((r) => healRule(r, idFactory))
    .filter((r) => r.id);
}

function healRule(r: Bag, idFactory: () => string): Rule {
  const variants = healVariants(r.variants, r.response, idFactory);
  const wanted = typeof r.activeVariantId === 'string' ? r.activeVariantId : '';
  // activeVariantId 必须指向真实存在的变体，否则回落到第一个
  const active = variants.some((v) => v.id === wanted) ? wanted : variants[0]!.id;

  const match = (r.match ?? {}) as Bag;
  const meta = (r.meta ?? {}) as Bag;
  const now = Date.now();

  return {
    id: String(r.id ?? ''),
    name: String(r.name ?? '未命名规则'),
    enabled: bool(r.enabled, true),
    groupId: typeof r.groupId === 'string' ? r.groupId : null,
    projectId: typeof r.projectId === 'string' ? r.projectId : null,
    kind: r.kind === 'virtual' ? 'virtual' : 'override',
    match: {
      urlMode:
        match.urlMode === 'wildcard' || match.urlMode === 'regex'
          ? match.urlMode
          : 'contains',
      url: String(match.url ?? ''),
      methods: Array.isArray(match.methods) ? (match.methods as Rule['match']['methods']) : [],
      hosts: Array.isArray(match.hosts) ? (match.hosts as string[]) : [],
    },
    variants,
    activeVariantId: active,
    meta: {
      createdAt: posInt(meta.createdAt, now),
      updatedAt: posInt(meta.updatedAt, now),
      source: (['manual', 'capture', 'ai', 'import'] as const).includes(meta.source as never)
        ? (meta.source as Rule['meta']['source'])
        : 'import',
      hitCount: Number.isFinite(meta.hitCount) ? Number(meta.hitCount) : 0,
      lastHitAt: Number.isFinite(meta.lastHitAt) ? Number(meta.lastHitAt) : null,
    },
  };
}

/**
 * 变体永远不能为空 —— 空规则没有任何响应可返回。
 *
 * 三种输入都要能处理：
 *   1. 正常的 variants 数组
 *   2. v1 遗留的 response 字段（AI 生成的规则也常是这个形态）
 *   3. 什么都没有
 */
function healVariants(raw: unknown, legacyResponse: unknown, idFactory: () => string): Variant[] {
  if (Array.isArray(raw) && raw.length > 0) {
    const out = raw
      .filter((v): v is Bag => !!v && typeof v === 'object')
      .map((v) => ({
        id: typeof v.id === 'string' && v.id ? v.id : idFactory(),
        name: String(v.name || DEFAULT_VARIANT_NAME),
        response: healResponse(v.response),
      }));
    if (out.length > 0) return out;
  }

  // 兼容 v1 形态与 AI 直接给的 response
  return [
    {
      id: idFactory(),
      name: DEFAULT_VARIANT_NAME,
      response: healResponse(legacyResponse),
    },
  ];
}

function healResponse(raw: unknown): Rule['variants'][number]['response'] {
  const r = (raw ?? {}) as Bag;
  return createResponseSpec({
    status: posInt(r.status, 200),
    headers:
      r.headers && typeof r.headers === 'object'
        ? (r.headers as Record<string, string>)
        : {},
    bodyType: r.bodyType === 'dynamic' || r.bodyType === 'mockjs' ? r.bodyType : 'static',
    // body 可能被写成对象（AI 常犯），统一转回字符串
    body:
      typeof r.body === 'string'
        ? r.body
        : r.body === undefined || r.body === null
          ? '{}'
          : JSON.stringify(r.body, null, 2),
    shellTemplateId: typeof r.shellTemplateId === 'string' ? r.shellTemplateId : null,
    delayMs: Number.isFinite(r.delayMs) && Number(r.delayMs) > 0 ? Number(r.delayMs) : 0,
    behavior:
      r.behavior === 'timeout' || r.behavior === 'networkError' ? r.behavior : 'normal',
  });
}

/**
 * 内置模板始终以代码为准（用户可能用的是旧版本导出的文件），
 * 用户自定义的模板则原样保留。
 */
function mergeShellTemplates(raw: unknown): MockStore['shellTemplates'] {
  const builtinIds = new Set(BUILTIN_SHELL_TEMPLATES.map((t) => t.id));
  const custom = Array.isArray(raw)
    ? (raw as MockStore['shellTemplates']).filter(
        (t) => t && typeof t === 'object' && !t.builtin && !builtinIds.has(t.id),
      )
    : [];
  return [...BUILTIN_SHELL_TEMPLATES, ...custom];
}

// ── 小工具 ─────────────────────────────────────────────────

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function posInt(v: unknown, fallback: number): number {
  return Number.isFinite(v) && Number(v) > 0 ? Number(v) : fallback;
}

let counter = 0;
function fallbackId(): string {
  return `gen-${Date.now().toString(36)}-${++counter}`;
}
