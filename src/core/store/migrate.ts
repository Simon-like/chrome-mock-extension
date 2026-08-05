/**
 * Schema 版本迁移
 *
 * 为什么现在就建这个机制（明明还没有 v2）：
 * 第一次需要迁移的时候，往往已经有辛苦配了几十条规则的存量数据了。
 * 那时再补机制，要么丢数据，要么临时写一堆兼容代码。
 * 现在建成本是 20 行，将来建成本是一次数据事故。
 *
 * 详见设计文档 05 §2.4。
 */

import { CURRENT_SCHEMA_VERSION, type MockStore } from '../types.js';
import { createDefaultStore, BUILTIN_SHELL_TEMPLATES } from './defaults.js';

type Migration = (old: Record<string, unknown>) => Record<string, unknown>;

/**
 * key 是【目标版本】。例如 migrations[2] 负责把 v1 迁到 v2。
 */
const migrations: Record<number, Migration> = {
  // 2: (s) => ({ ...s, schemaVersion: 2, newField: defaultValue }),
};

export interface MigrateResult {
  store: MockStore;
  /** 是否发生了重置（版本断层或数据损坏） */
  reset: boolean;
  reason?: string;
}

export function migrate(raw: unknown): MigrateResult {
  if (!raw || typeof raw !== 'object') {
    return { store: createDefaultStore(), reset: true, reason: '无有效数据' };
  }

  let store = raw as Record<string, unknown>;
  let version = typeof store.schemaVersion === 'number' ? store.schemaVersion : 0;

  if (version > CURRENT_SCHEMA_VERSION) {
    // 来自更新版本的插件 —— 不敢降级处理，避免丢字段
    return {
      store: createDefaultStore(),
      reset: true,
      reason: `数据版本 v${version} 高于当前支持的 v${CURRENT_SCHEMA_VERSION}，可能来自更新版本的插件`,
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
      };
    }
    store = fn(store);
    version = next;
  }

  const healed = heal(store);
  return { store: healed, reset: false };
}

/**
 * 结构自愈：补齐缺失字段。
 *
 * 导入的文件、手工编辑过的数据都可能缺字段。与其在各处写防御性代码，
 * 不如在入口一次性补齐，让下游可以信任类型。
 */
function heal(s: Record<string, unknown>): MockStore {
  const def = createDefaultStore();
  const settings = (s.settings ?? {}) as Record<string, unknown>;

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    enabled: typeof s.enabled === 'boolean' ? s.enabled : def.enabled,
    rules: Array.isArray(s.rules) ? (s.rules as MockStore['rules']) : [],
    groups: healGroups(s.groups),
    shellTemplates: mergeShellTemplates(s.shellTemplates),
    settings: {
      captureEnabled:
        typeof settings.captureEnabled === 'boolean'
          ? settings.captureEnabled
          : def.settings.captureEnabled,
      captureMaxCount:
        typeof settings.captureMaxCount === 'number' && settings.captureMaxCount > 0
          ? settings.captureMaxCount
          : def.settings.captureMaxCount,
      aiReadEnabled:
        typeof settings.aiReadEnabled === 'boolean'
          ? settings.aiReadEnabled
          : def.settings.aiReadEnabled,
      aiHostWhitelist: Array.isArray(settings.aiHostWhitelist)
        ? (settings.aiHostWhitelist as string[])
        : [...def.settings.aiHostWhitelist],
    },
  };
}

/**
 * 补齐分组字段。
 *
 * exclusive 是后加的字段，早期数据和别人导出的旧文件里都没有 ——
 * 缺失时按 false（普通组）处理，是安全的默认值：
 * 误判成互斥组会导致用户的组莫名互相关闭。
 */
function healGroups(raw: unknown): MockStore['groups'] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((g): g is Record<string, unknown> => !!g && typeof g === 'object')
    .map((g) => ({
      id: String(g.id ?? ''),
      name: String(g.name ?? '未命名分组'),
      enabled: typeof g.enabled === 'boolean' ? g.enabled : true,
      exclusive: g.exclusive === true,
      collapsed: g.collapsed === true,
      defaultShellTemplateId:
        typeof g.defaultShellTemplateId === 'string' ? g.defaultShellTemplateId : null,
    }))
    .filter((g) => g.id);
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
