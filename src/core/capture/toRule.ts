/**
 * Capture-to-Mock 转换（F6）—— D1 差异化的核心
 *
 * 目标：从看到请求到 Mock 生效 ≤ 3 次点击。
 * 所以这里要尽可能把字段都猜对，让用户不用动手改。
 */

import { createResponseSpec, createRuleDraft } from '../store/defaults.js';
import { normalizeMethod } from '../engine/normalize.js';
import { detectShell } from '../engine/shell.js';
import type { RuleDraft, ShellTemplate } from '../types.js';

export interface CaptureLike {
  url: string;
  method: string;
  status: number | null;
  body: string | null;
}

export interface CaptureToRuleOptions {
  shellTemplates?: ShellTemplate[];
  /** 落到哪个项目/分组，由调用方（当前视图）决定 */
  projectId?: string | null;
  groupId?: string | null;
  /**
   * 是否顺带生成常用变体（空数据 / 报错）。
   * 抓包转 Mock 时多半接着就要测这些边界，预先建好省一步。
   */
  withPresetVariants?: boolean;
}

export function captureToRuleDraft(
  entry: CaptureLike,
  options: CaptureToRuleOptions = {},
): RuleDraft {
  const { shellTemplates = [], projectId = null, groupId = null } = options;

  const parsed = safeParseUrl(entry.url);
  const body = entry.body ?? '{}';

  // 尝试识别响应外壳，把 data 部分单独挑出来给用户编辑（F25）。
  // 识别成功的话，用户看到的就是干净的业务数据，而不是包着三层壳的完整响应。
  const detected = shellTemplates.length > 0 ? detectShell(shellTemplates, body) : null;
  const shellTemplateId = detected ? detected.template.id : null;
  const mainBody = detected ? detected.data : prettyJson(body);

  const variants: RuleDraft['variants'] = [
    {
      name: '真实响应',
      response: createResponseSpec({
        status: entry.status ?? 200,
        body: mainBody,
        shellTemplateId,
      }),
    },
  ];

  if (options.withPresetVariants) {
    variants.push(
      {
        name: '空数据',
        response: createResponseSpec({
          status: 200,
          body: emptyShapeOf(mainBody),
          shellTemplateId,
        }),
      },
      {
        name: '报错',
        response: createResponseSpec({
          status: 500,
          body: '{\n  "message": "Internal Server Error"\n}',
          shellTemplateId: null,
        }),
      },
    );
  }

  return createRuleDraft({
    name: suggestName(parsed.pathname, entry.method),
    // 从抓包来的一定是覆盖式 —— 接口真实存在
    kind: 'override',
    projectId,
    groupId,
    match: {
      urlMode: 'contains',
      /**
       * 默认只取 pathname，丢掉 query。
       *
       * 抓到的 URL 常带 ?page=1&t=1690000000。原样匹配的话，
       * 用户翻到第 2 页规则就失效了，带时间戳的接口更是永远只命中一次。
       * 用 pathname 覆盖该接口所有调用，符合 90% 的意图。
       */
      url: parsed.pathname || entry.url,
      methods: [normalizeMethod(entry.method)],
      // 项目已经限定了域名时不必重复限定；否则用抓到的 host 兜底
      hosts: projectId ? [] : parsed.host ? [parsed.host] : [],
    },
    variants,
    activeVariantIndex: 0,
    meta: { source: 'capture' },
  });
}

/**
 * 从真实响应推出「空」的样子：数组清空、数字归零、其余保留结构。
 * 比给一个死板的 {"list":[],"total":0} 更贴合实际接口。
 */
function emptyShapeOf(body: string): string {
  try {
    return JSON.stringify(emptyValue(JSON.parse(body)), null, 2);
  } catch {
    return '{}';
  }
}

function emptyValue(v: unknown): unknown {
  if (Array.isArray(v)) return [];
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = typeof val === 'number' ? 0 : emptyValue(val);
    }
    return out;
  }
  return v;
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
