/**
 * 默认值与工厂函数
 *
 * core 层，不依赖 chrome/DOM。
 */

import {
  CURRENT_SCHEMA_VERSION,
  type MockStore,
  type Rule,
  type RuleDraft,
  type Settings,
  type ShellTemplate,
} from '../types.js';

/**
 * 内置响应外壳模板（F24）
 *
 * 用户反馈：公司响应格式不统一，多数是 {status, message, data}，
 * 但经风控等中间层转换后会变成别的。所以外壳是「一组模板」而非全局唯一配置，
 * 且支持自定义。详见需求文档 02 §1.5。
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
  // Q11 决策：读侧默认开启
  aiReadEnabled: true,
  // 但白名单机制不可关闭（默认空 = 仅当前活动域名，由 UI 引导添加）
  aiHostWhitelist: [],
};

export function createDefaultStore(): MockStore {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    enabled: true,
    rules: [],
    groups: [],
    shellTemplates: [...BUILTIN_SHELL_TEMPLATES],
    settings: { ...DEFAULT_SETTINGS },
  };
}

/** 新建规则时的默认草稿 */
export function createRuleDraft(partial?: Partial<RuleDraft>): RuleDraft {
  return {
    name: '新建规则',
    enabled: true,
    groupId: null,
    kind: 'override',
    match: {
      urlMode: 'contains',
      url: '',
      methods: [],
      hosts: [],
    },
    response: {
      status: 200,
      headers: {},
      bodyType: 'static',
      body: '{}',
      shellTemplateId: null,
      delayMs: 0,
    },
    ...partial,
  };
}

/**
 * 把草稿变成完整规则：补上 id 和 meta。
 *
 * idFactory 作为参数注入，而不是直接 import nanoid —— 这样 core 保持无依赖，
 * 测试时也能传入可预测的 id 生成器。
 */
export function materializeRule(
  draft: RuleDraft,
  idFactory: () => string,
  now: number = Date.now(),
): Rule {
  const { meta, ...rest } = draft;
  return {
    ...rest,
    id: idFactory(),
    meta: {
      createdAt: now,
      updatedAt: now,
      source: meta?.source ?? 'manual',
      hitCount: 0,
      lastHitAt: null,
    },
  };
}
