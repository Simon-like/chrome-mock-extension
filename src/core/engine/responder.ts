/**
 * 响应构造器 —— 引擎心脏之二
 *
 * 返回纯数据（MockResponse），不是浏览器的 Response 对象 —— 因为：
 *   1. core 层不能依赖浏览器 API
 *   2. fetch 和 XHR 需要的响应形态不同（一个要 Response，一个要往实例挂 getter），
 *      由各自的宿主适配层去转换
 *
 * 详见设计文档 05 §5.3。
 */

import type { MockResponse, MockStore, RequestInfo, Rule } from '../types.js';
import { applyShell, findShellTemplate } from './shell.js';

export function buildResponse(
  store: MockStore,
  rule: Rule,
  _req: RequestInfo,
): MockResponse {
  const spec = rule.response;

  let body = spec.body ?? '';

  // 套响应外壳（F24）
  const shell = findShellTemplate(store.shellTemplates, spec.shellTemplateId);
  if (shell) {
    body = applyShell(shell.template, body);
  }

  return {
    status: normalizeStatus(spec.status),
    headers: {
      'content-type': 'application/json',
      // 用户自定义的 header 后写，可以覆盖默认值
      ...normalizeHeaders(spec.headers),
    },
    body,
    delayMs: Math.max(0, Number(spec.delayMs) || 0),
    behavior: spec.behavior ?? 'normal',
  };
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
