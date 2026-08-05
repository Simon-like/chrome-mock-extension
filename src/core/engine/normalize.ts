/**
 * 请求信息规范化
 *
 * hook 拿到的 url 可能是相对路径、可能是 Request 对象、可能带各种奇怪格式。
 * 统一在这里转成 RequestInfo，让 matcher 只处理一种形态。
 *
 * core 层：不依赖 chrome/DOM，但需要一个 baseUrl 参数来解析相对路径
 * （宿主传 location.href 进来）。
 */

import type { HttpMethod, RequestInfo } from '../types.js';
import { HTTP_METHODS } from '../types.js';

export function normalizeMethod(raw: unknown): HttpMethod {
  const m = String(raw ?? 'GET').toUpperCase();
  return (HTTP_METHODS as readonly string[]).includes(m)
    ? (m as HttpMethod)
    : 'GET';
}

/**
 * 解析成绝对 URL 并提取 host。
 * 解析失败时降级为原样字符串 + 空 host，绝不抛异常。
 */
export function normalizeRequest(
  rawUrl: unknown,
  rawMethod: unknown,
  baseUrl: string,
): RequestInfo {
  const method = normalizeMethod(rawMethod);
  const urlStr = String(rawUrl ?? '');

  try {
    const u = new URL(urlStr, baseUrl);
    return { url: u.href, method, host: u.host };
  } catch {
    return { url: urlStr, method, host: '' };
  }
}
