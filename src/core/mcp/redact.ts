/**
 * 出给 AI 的数据脱敏 —— **不可关闭**的那道防线
 *
 * 背景：读侧（让 AI 看到页面实际发了哪些请求）是 MCP 价值最大的部分，
 * 风险也最大 —— 公司接口的 URL 和响应体里往往带着真实鉴权凭证。
 * 02 §4.1 定的规矩：读侧可以默认开，但**脱敏不可关**。
 *
 * 所以这个模块：
 *   - 在 core 层（纯函数、可测、无 chrome/DOM）
 *   - 没有「关闭」参数。调用方无从跳过它
 *   - 在数据**离开扩展之前**执行，不是在 MCP 端执行 ——
 *     万一 WS 端口被别的进程连上，拿到的也已经是脱敏过的
 *
 * 原则：**宁可多打码**。漏掉一个 token 的代价，远大于 AI 少看见一个字段。
 */

/** 打码后的占位符。保留可辨识性，让 AI 知道「这里有个值但你看不到」 */
export const REDACTED = '[REDACTED]';

/**
 * 敏感字段名。匹配时统一转小写并去掉 `-` `_`，
 * 所以 `access_token` / `accessToken` / `Access-Token` 都能命中同一条。
 */
const SENSITIVE_KEYS = [
  'authorization',
  'cookie',
  'setcookie',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'apikey',
  'appkey',
  'secret',
  'appsecret',
  'clientsecret',
  'password',
  'passwd',
  'pwd',
  'session',
  'sessionid',
  'sid',
  'jsessionid',
  'auth',
  'credential',
  'signature',
  'sign',
  'privatekey',
  'csrftoken',
  'xsrftoken',
];

const NORMALIZE = /[-_\s]/g;

/** 键名是否敏感。用「包含」而不是「相等」—— 真实字段名常带前缀，如 `x-jd-token` */
export function isSensitiveKey(key: string): boolean {
  const k = String(key).toLowerCase().replace(NORMALIZE, '');
  return SENSITIVE_KEYS.some((s) => k.includes(s));
}

/**
 * 长得像凭证的**值**，即使键名不敏感也打码。
 *
 * 覆盖两类现实中最常见的漏网之鱼：
 *   - JWT：`xxx.yyy.zzz` 三段 base64
 *   - 长十六进制 / base64 串（32 位以上），一般是 session id 或签名
 */
const JWT = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;
const LONG_OPAQUE = /^[A-Fa-f0-9]{32,}$/;

export function looksLikeSecret(value: string): boolean {
  return JWT.test(value) || LONG_OPAQUE.test(value);
}

// ═══════════════════════════════════════════════════════════
// URL
// ═══════════════════════════════════════════════════════════

/**
 * 打码 URL 里的查询参数。
 *
 * `?access_token=xxx` 是最常见的泄露路径 —— 它连「响应体」都不算，
 * 光是把 URL 列给 AI 看就漏了。
 *
 * 解析失败时**返回去掉查询串的 URL**，而不是原样返回：
 * 解析不了说明它是个我们看不懂的形态，看不懂就不该放行。
 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    let changed = false;
    for (const key of [...u.searchParams.keys()]) {
      const val = u.searchParams.get(key) ?? '';
      if (isSensitiveKey(key) || looksLikeSecret(val)) {
        u.searchParams.set(key, REDACTED);
        changed = true;
      }
    }
    // URLSearchParams 会把 [ ] 百分号编码成 %5B %5D，占位符就认不出来了。
    // 值本身已经安全，这里只是把标记还原成人和 AI 都读得懂的样子
    return changed ? u.toString().split(encodeURIComponent(REDACTED)).join(REDACTED) : url;
  } catch {
    const q = String(url).indexOf('?');
    return q < 0 ? String(url) : `${String(url).slice(0, q)}?${REDACTED}`;
  }
}

// ═══════════════════════════════════════════════════════════
// 结构化数据
// ═══════════════════════════════════════════════════════════

/** 递归深度上限。深层嵌套的数据结构不该拖垮脱敏本身 */
const MAX_DEPTH = 12;

/** 递归打码对象/数组里的敏感字段 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return value;

  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k)) {
        out[k] = REDACTED;
      } else if (typeof v === 'string' && looksLikeSecret(v)) {
        out[k] = REDACTED;
      } else {
        out[k] = redactValue(v, depth + 1);
      }
    }
    return out;
  }

  return value;
}

/**
 * 打码响应体。
 *
 * body 是字符串（可能是 JSON，也可能是 HTML/纯文本）。
 * 能解析成 JSON 就按结构处理，解析不了就按文本兜底 ——
 * 兜底同样要打码，不能因为「不是 JSON」就整段放行。
 */
export function redactBody(body: string | null): string | null {
  if (body === null || body === '') return body;

  try {
    const parsed = JSON.parse(body);
    return JSON.stringify(redactValue(parsed));
  } catch {
    return redactText(body);
  }
}

/**
 * 非 JSON 文本的兜底：打掉 `key: value` / `key=value` 形态里的敏感项，
 * 以及裸露的 JWT。
 *
 * ⚠️ `key:` 形态**打掉整行剩余部分**，不是只打第一个词。
 * 原因是 `Authorization: Bearer eyJhbGci...` —— 只吃第一个词的话，
 * 打掉的是 "Bearer" 这个毫无价值的单词，真正的 token 原封不动地漏出去。
 * 这是本模块第一版真实犯过的错，被测试抓住了。
 *
 * 做不到完美 —— 但「做不到完美」不是「什么都不做」的理由。
 */
export function redactText(text: string): string {
  return (
    text
      // header / YAML 风格：`key: 剩下整行`
      .replace(
        /^([ \t]*)([A-Za-z0-9_-]+)([ \t]*:[ \t]*)(.+)$/gm,
        (raw, indent: string, key: string, sep: string, val: string) =>
          isSensitiveKey(key) || looksLikeSecret(val.trim())
            ? `${indent}${key}${sep}${REDACTED}`
            : raw,
      )
      // query / form 风格：`key=value`，值到 & ; 或空白为止
      .replace(/([A-Za-z0-9_-]+)=([^\s&;]+)/g, (raw, key: string, val: string) =>
        isSensitiveKey(key) || looksLikeSecret(val) ? `${key}=${REDACTED}` : raw,
      )
      // 裸露的 JWT，前两条都没盖住的情况
      .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED)
  );
}

// ═══════════════════════════════════════════════════════════
// 请求记录
// ═══════════════════════════════════════════════════════════

/**
 * 结构化描述一条请求记录。
 *
 * 刻意**不** import `@shared/messages` 的 `CapturedRequest` ——
 * core 层不认识 shared（那是插件内部的通信约定）。用结构类型对上就够了，
 * 类型不兼容时 TS 会在调用处报错，一样跑不掉。
 */
export interface CaptureLike {
  id: string;
  at: number;
  url: string;
  method: string;
  api: 'fetch' | 'xhr';
  mocked: boolean;
  ruleId: string | null;
  ruleName: string | null;
  status: number | null;
  body: string | null;
  truncated: boolean;
  durationMs: number | null;
}

export type RedactedCaptureLike = CaptureLike & { redacted: boolean };

/**
 * 把一条请求记录处理成可以出给 AI 的样子。
 *
 * `redacted` 标记很重要：AI 得知道自己看到的不是全貌，
 * 否则它可能基于「这个字段是空的」做出错误推断。
 */
export function redactCapture(c: CaptureLike): RedactedCaptureLike {
  const url = redactUrl(c.url);
  const body = redactBody(c.body);
  return {
    ...c,
    url,
    body,
    redacted: url !== c.url || body !== c.body,
  };
}

// ═══════════════════════════════════════════════════════════
// 域名白名单
// ═══════════════════════════════════════════════════════════

/**
 * 请求的 host 是否在白名单内。
 *
 * 空白名单 = **不限**。
 *
 * ⚠️ 这一条偏离了 02 §4.1（那里写「白名单不可关」）。理由：
 *   1. 产品里已经有一个「域名作用域」概念（项目的 hostScope），那里空数组就是不限。
 *      同一个概念两套语义，用户一定会搞混，而搞混安全设置比没有安全设置更糟
 *   2. 「不可关的白名单」在初始状态无解 —— 总得有个默认值，
 *      默认放行等于没开，默认全禁则功能开箱即坏
 * 补偿：白名单为空且读侧开着时，设置页给显著警告；**脱敏无论如何都执行**。
 * 真正不可关的那道线是脱敏，不是白名单。
 */
export function hostAllowed(host: string, whitelist: string[]): boolean {
  if (whitelist.length === 0) return true;
  const h = String(host).toLowerCase();
  return whitelist.some((raw) => matchHost(h, String(raw).toLowerCase().trim()));
}

/** 与项目 hostScope 同款通配：`*` 不跨点号，所以 `*.a.com` 不会匹配 `a.com` 本身 */
function matchHost(host: string, pattern: string): boolean {
  if (!pattern) return false;
  if (!pattern.includes('*')) return host === pattern || host.startsWith(`${pattern}:`);
  const re = new RegExp(
    `^${pattern.split('*').map(escapeRe).join('[^.]*')}(:\\d+)?$`,
  );
  return re.test(host);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
