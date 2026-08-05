/**
 * Capture-to-Mock 转换（F6）—— D1 差异化的核心
 *
 * 目标：从看到请求到 Mock 生效 ≤ 3 次点击。
 * 所以这里要尽可能把字段都猜对，让用户不用动手改。
 */

import { createRuleDraft } from '../store/defaults.js';
import { normalizeMethod } from '../engine/normalize.js';
import { detectShell } from '../engine/shell.js';
import type { RuleDraft, ShellTemplate } from '../types.js';

export interface CaptureLike {
  url: string;
  method: string;
  status: number | null;
  body: string | null;
}

export function captureToRuleDraft(
  entry: CaptureLike,
  shellTemplates: ShellTemplate[] = [],
): RuleDraft {
  const parsed = safeParseUrl(entry.url);
  const body = entry.body ?? '{}';

  // 尝试识别响应外壳，把 data 部分单独挑出来给用户编辑（F25 的基础）。
  // 识别成功的话，用户看到的就是干净的业务数据，而不是包着三层壳的完整响应。
  const detected = shellTemplates.length > 0 ? detectShell(shellTemplates, body) : null;

  return createRuleDraft({
    name: suggestName(parsed.pathname, entry.method),
    // 从抓包来的一定是覆盖式 —— 接口真实存在
    kind: 'override',
    match: {
      urlMode: 'contains',
      /**
       * 默认只取 pathname，丢掉 query。
       *
       * 理由（05 §6.4）：抓到的 URL 常带 ?page=1&t=1690000000。
       * 原样匹配的话，用户翻到第 2 页规则就失效了，
       * 带时间戳的接口更是永远只命中一次。
       * 用 pathname 覆盖该接口所有调用，符合 90% 的意图。
       */
      url: parsed.pathname || entry.url,
      methods: [normalizeMethod(entry.method)],
      hosts: parsed.host ? [parsed.host] : [],
    },
    response: {
      status: entry.status ?? 200,
      headers: {},
      bodyType: 'static',
      body: detected ? detected.data : prettyJson(body),
      shellTemplateId: detected ? detected.template.id : null,
      delayMs: 0,
    },
    meta: { source: 'capture' },
  });
}

function safeParseUrl(url: string): { pathname: string; host: string } {
  try {
    const u = new URL(url);
    return { pathname: u.pathname, host: u.host };
  } catch {
    return { pathname: '', host: '' };
  }
}

/** 从路径猜个可读的名字，如 /api/goods/list → goods/list */
function suggestName(pathname: string, method: string): string {
  if (!pathname) return '新建规则';
  const parts = pathname.split('/').filter(Boolean);
  const tail = parts.slice(-2).join('/');
  const m = normalizeMethod(method);
  return m === 'GET' ? tail || pathname : `${m} ${tail || pathname}`;
}

export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // 不是 JSON 就原样返回（可能是 HTML、纯文本）
    return text;
  }
}
