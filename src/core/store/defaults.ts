/**
 * 默认值与工厂函数
 *
 * core 层，不依赖 chrome/DOM。
 */

import {
  DEFAULT_BRIDGE_PORT,
  CURRENT_SCHEMA_VERSION,
  type MockStore,
  type ResponseSpec,
  type Rule,
  type RuleDraft,
  type Settings,
  type ShellTemplate,
  type Variant,
} from '../types.js';

/**
 * 内置响应外壳模板（F24）
 *
 * 公司响应格式不统一：多数是 {status, message, data}，但经风控等中间层
 * 转换后会变成别的。所以外壳是「一组模板」而非全局唯一配置，且支持自定义。
 */
export const BUILTIN_SHELL_TEMPLATES: ShellTemplate[] = [
  {
    id: 'shell-raw',
    name: '裸数据（不套壳）',
    builtin: true,
    template: '__DATA__',
  },
  {
    id: 'shell-status-message-data',
    name: '标准 status / message / data',
    builtin: true,
    template: '{"status":0,"message":"ok","data":__DATA__}',
  },
  {
    id: 'shell-code-data-message',
    name: 'code / data / message',
    builtin: true,
    template: '{"code":0,"data":__DATA__,"message":"success"}',
  },
  {
    id: 'shell-success-result',
    name: 'success / result',
    builtin: true,
    template: '{"success":true,"result":__DATA__}',
  },
  {
    id: 'shell-errno-errmsg',
    name: 'errno / errmsg / data',
    builtin: true,
    template: '{"errno":0,"errmsg":"","data":__DATA__}',
  },
];

export const DEFAULT_SETTINGS: Settings = {
  captureEnabled: true,
  captureMaxCount: 200,
  pageSize: 15,
  aiReadEnabled: true,
  aiHostWhitelist: [],
  // 桥默认关：开一个 localhost 连接是用户该主动做的决定，不该装完就替他做了
  mcpEnabled: false,
  mcpPort: DEFAULT_BRIDGE_PORT,
  mcpToken: '',
};

export function createDefaultStore(): MockStore {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    enabled: true,
    projects: [],
    groups: [],
    rules: [],
    shellTemplates: [...BUILTIN_SHELL_TEMPLATES],
    settings: { ...DEFAULT_SETTINGS },
    activeProjectId: null,
  };
}

export function createResponseSpec(partial?: Partial<ResponseSpec>): ResponseSpec {
  return {
    status: 200,
    headers: {},
    bodyType: 'static',
    body: '{}',
    shellTemplateId: null,
    delayMs: 0,
    ...partial,
  };
}

/** 默认变体名。新建规则时至少要有一个变体 */
export const DEFAULT_VARIANT_NAME = '默认';

/** 新建规则时的默认草稿 */
export function createRuleDraft(partial?: Partial<RuleDraft>): RuleDraft {
  return {
    name: '新建规则',
    enabled: true,
    groupId: null,
    projectId: null,
    kind: 'override',
    match: {
      urlMode: 'contains',
      url: '',
      methods: [],
      hosts: [],
    },
    variants: [{ name: DEFAULT_VARIANT_NAME, response: createResponseSpec() }],
    activeVariantIndex: 0,
    ...partial,
  };
}

/**
 * 把草稿变成完整规则：补上 id、变体 id 和 meta。
 *
 * idFactory 作为参数注入而不是直接 import nanoid —— 这样 core 保持无依赖，
 * 测试时也能传入可预测的 id 生成器。
 */
export function materializeRule(
  draft: RuleDraft,
  idFactory: () => string,
  now: number = Date.now(),
): Rule {
  const { meta, variants, activeVariantIndex, ...rest } = draft;

  // 变体不能为空 —— 空规则没有任何响应可返回，是无效状态
  const source = variants.length > 0 ? variants : createRuleDraft().variants;
  const materialized: Variant[] = source.map((v) => ({
    id: v.id ?? idFactory(),
    name: v.name || DEFAULT_VARIANT_NAME,
    response: v.response,
  }));

  const idx = clampIndex(activeVariantIndex ?? 0, materialized.length);

  return {
    ...rest,
    id: idFactory(),
    variants: materialized,
    activeVariantId: materialized[idx]!.id,
    meta: {
      createdAt: now,
      updatedAt: now,
      source: meta?.source ?? 'manual',
      hitCount: 0,
      lastHitAt: null,
    },
  };
}

function clampIndex(i: number, len: number): number {
  if (!Number.isFinite(i) || i < 0) return 0;
  return Math.min(Math.floor(i), len - 1);
}

/**
 * 取规则当前生效的变体。
 *
 * activeVariantId 可能因数据损坏指向不存在的变体，
 * 这时回落到第一个 —— 引擎不能因为数据问题就返回 undefined。
 */
export function getActiveVariant(rule: Rule): Variant {
  return rule.variants.find((v) => v.id === rule.activeVariantId) ?? rule.variants[0]!;
}
