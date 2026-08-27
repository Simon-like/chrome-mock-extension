/**
 * 响应构造器 —— 引擎心脏之二
 *
 * 返回纯数据（MockResponse），不是浏览器的 Response 对象 —— 因为：
 *   1. core 层不能依赖浏览器 API
 *   2. fetch 和 XHR 需要的响应形态不同（一个要 Response，一个要往实例挂 getter），
 *      由各自的宿主适配层去转换
 */

import { getActiveVariant } from '../store/defaults.js';
import type { MockResponse, MockStore, RequestInfo, Rule } from '../types.js';
import { applyShell, findShellTemplate } from './shell.js';
import { createBodyGenRuntime, type BodyGenRuntime } from './bodygen.js';

/**
 * 默认运行时。宿主不传就用这个。
 *
 * 是模块级单例，但它只装缓存和熔断计数，不影响「同样输入同样输出」——
 * 唯一的例外是熔断后会持续降级，这正是它该做的事。
 * 测试要隔离就自己 createBodyGenRuntime() 传进来（见 tests/bodygen.test.ts）。
 */
const defaultRuntime = createBodyGenRuntime();

export function buildResponse(
  store: MockStore,
  rule: Rule,
  req: RequestInfo,
  runtime: BodyGenRuntime = defaultRuntime,
): MockResponse {
  // 一条规则可能有多个变体，取当前生效的那个
  const variant = getActiveVariant(rule);
  const spec = variant.response;

  let body = spec.body ?? '';
  let bodyGen: MockResponse['bodyGen'];

  // body 不是写死的（dynamic 跑 JS / mockjs 展开模板）就在这里算出来。
  // 熔断粒度是「规则 + 变体」—— 同一条规则的不同变体是不同的代码/模板，
  // 一个变体写错了不该把另一个也拖下水
  if (spec.bodyType !== 'static') {
    const gen = runtime.generate(`${rule.id}:${variant.id}`, spec.bodyType, body, req);
    body = gen.body;
    bodyGen = gen.diagnostics;
  }

  // 套响应外壳：规则未指定时，回落到分组 → 项目的默认值。
  // 生成出来的 body 也要套壳 —— 「JS / 模板生成 data，外壳补公司统一格式」是最常见的组合
  const shellId = spec.shellTemplateId ?? inheritedShellId(store, rule);
  const shell = findShellTemplate(store.shellTemplates, shellId);
  if (shell) {
    body = applyShell(shell.template, body);
  }

  return {
    variantId: variant.id,
    variantName: variant.name,
    status: normalizeStatus(spec.status),
    headers: {
      'content-type': 'application/json',
      // 用户自定义的 header 后写，可以覆盖默认值
      ...normalizeHeaders(spec.headers),
    },
    body,
    delayMs: Math.max(0, Number(spec.delayMs) || 0),
    behavior: spec.behavior ?? 'normal',
    ...(bodyGen ? { bodyGen } : {}),
  };
}

/**
 * 外壳继承链：规则 → 分组 → 项目。
 *
 * 这样公司的统一响应格式只需在项目上配一次，
 * 而不是每条规则都选一遍（F24 的实际价值所在）。
 */
function inheritedShellId(store: MockStore, rule: Rule): string | null {
  if (rule.groupId) {
    const g = store.groups.find((x) => x.id === rule.groupId);
    if (g?.defaultShellTemplateId) return g.defaultShellTemplateId;
  }
  if (rule.projectId) {
    const p = store.projects.find((x) => x.id === rule.projectId);
    if (p?.defaultShellTemplateId) return p.defaultShellTemplateId;
  }
  return null;
}

function normalizeStatus(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 100 || n > 599) return 200;
  return Math.floor(n);
}

/** header 名统一小写，避免 content-type / Content-Type 重复设置 */
function normalizeHeaders(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k) continue;
    out[k.toLowerCase()] = String(v ?? '');
  }
  return out;
}
