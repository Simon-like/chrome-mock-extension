/**
 * 动态响应 —— 用户写一段 JS，按请求参数现算响应体
 *
 * Spike 已通过（目标站点允许 `new Function`，见 docs/10-动态响应Spike.md §5），
 * 现已接进 responder：`bodyType: 'dynamic'` 时 `body` 存的是 JS 源码。
 *
 * ── 为什么当初必须先探测 ────────────────────────────
 * 用户代码只能在 MAIN world 用 `new Function` 编译。
 * 备选方案都不成立：
 *   - Service Worker 里跑 ❌ xhr.send() 是同步的，等不了跨进程往返
 *   - <script> 注入 ❌ 同样受 CSP 的 script-src 管，而且拿不到返回值
 * 而 `new Function` 受页面 CSP 的 `script-src 'unsafe-eval'` 管辖。
 * 站点禁了它，整条路就不成立 —— 所以要先量，别先写。
 *
 * ── core 层合规 ─────────────────────────────────────
 * 全文件不出现 chrome. / window. / document.。
 * `new Function` 是纯 JS 语言特性，不是浏览器 API，可以放在 core。
 * 这也让「同一份逻辑将来在 Node 侧 MCP Server 复用」这条路仍然通着。
 */

import type { RequestInfo } from '../types.js';

// ═══════════════════════════════════════════════════════════
// 一、能力探测
// ═══════════════════════════════════════════════════════════

export type EvalSupport =
  | { available: true }
  | { available: false; reason: string };

/**
 * 探测当前执行环境能否 `new Function`。
 *
 * ⚠️ 这个调用【有副作用】：被 CSP 拦下时浏览器会派发 securitypolicyviolation，
 * 站点若配了 report-uri 就会往人家的监控里打一条。
 * 所以【绝不能在每个页面启动时无条件跑】—— 必须由用户显式触发，
 * 或在真的要执行一条 dynamic 规则时惰性触发一次。
 *
 * 结果不在这里缓存：缓存策略是宿主的事（不同页面 CSP 不同）。
 */
export function probeEvalSupport(): EvalSupport {
  try {
    // 用一个有返回值的表达式，确保不是「编译过了但没真执行」
    const probe = new Function('return 1 + 1;') as () => unknown;
    return probe() === 2
      ? { available: true }
      : { available: false, reason: 'new Function 可编译但返回值异常' };
  } catch (e) {
    return { available: false, reason: describeError(e) };
  }
}

// ═══════════════════════════════════════════════════════════
// 二、编译
// ═══════════════════════════════════════════════════════════

/** 传给用户函数的请求上下文 */
export interface DynamicContext {
  url: string;
  method: string;
  host: string;
  path: string;
  /** 查询参数。值一律是 **字符串**（URL 里本来就没有类型），必要时自己 Number() */
  query: Record<string, string>;
}

export type CompiledBody = (ctx: DynamicContext) => unknown;

export type CompileResult =
  | { ok: true; fn: CompiledBody }
  | { ok: false; error: string };

/**
 * 把用户源码编译成函数。
 *
 * 支持两种写法，因为用户两种都会写，报「语法错误」很不友好：
 *   1. 表达式形式：`(req) => ({ ... })`
 *   2. 函数体形式：`return { ... }`
 * 先按 1 试，失败再按 2 试。
 */
export function compileDynamicBody(source: string): CompileResult {
  const src = String(source ?? '').trim();
  if (!src) return { ok: false, error: '源码为空' };

  // 写法 1：整段是一个表达式，求值后应当得到一个函数
  try {
    const make = new Function(`"use strict"; return (${src});`) as () => unknown;
    const fn = make();
    if (typeof fn === 'function') return { ok: true, fn: fn as CompiledBody };
  } catch {
    /* 落到写法 2 */
  }

  // 写法 2：整段就是函数体，参数名固定为 req
  try {
    const fn = new Function('req', `"use strict";\n${src}`) as CompiledBody;
    return { ok: true, fn };
  } catch (e) {
    return { ok: false, error: describeError(e) };
  }
}

// ═══════════════════════════════════════════════════════════
// 三、受保护执行
// ═══════════════════════════════════════════════════════════

export interface RunOk {
  ok: true;
  /** 序列化后的响应体 */
  body: string;
  durationMs: number;
  /** 超出耗时预算 —— 宿主应据此把这条规则标红/降级 */
  slow: boolean;
}
export interface RunFail {
  ok: false;
  error: string;
  durationMs: number;
}
export type RunResult = RunOk | RunFail;

/** 单次执行的耗时预算。超了不中断（做不到），但会上报 */
export const DYNAMIC_BUDGET_MS = 50;

/**
 * 执行用户函数并把结果转成响应体字符串。
 *
 * ⚠️ 关于「超时保护」的诚实说明：
 *    同线程内**无法**中断一段同步的死循环 —— 没有 API 能做到。
 *    所谓超时只能是【事后】测量：这次卡了，下次别再跑（宿主负责熔断）。
 *    这跟 ReDoS 那道防线是同一个教训（见 09 号文档 §6.4）：
 *    事后测量拦不住第一次，所以第一次的代价必须可接受。
 *    这里可接受的理由是 —— 用户代码跑在 MAIN world，
 *    死循环的爆炸半径等同于页面自己的脚本写了死循环，且只影响开发者本人的调试页面。
 *
 * 返回值永不抛异常：引擎跑在用户的每一个请求上（09 §6.5）。
 */
export function runDynamicBody(
  fn: CompiledBody,
  ctx: DynamicContext,
  budgetMs: number = DYNAMIC_BUDGET_MS,
): RunResult {
  const started = now();
  let raw: unknown;
  try {
    raw = fn(ctx);
  } catch (e) {
    return { ok: false, error: describeError(e), durationMs: now() - started };
  }

  // Promise 不支持：XHR 的 send() 是同步的，等不了。
  // 明说出来，比让用户拿到一个 "[object Promise]" 强得多
  if (isThenable(raw)) {
    return {
      ok: false,
      error: '动态响应不支持返回 Promise —— XHR 的 send() 是同步的，等不了异步结果',
      durationMs: now() - started,
    };
  }

  let body: string;
  try {
    body = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
  } catch (e) {
    // 循环引用、BigInt 之类
    return {
      ok: false,
      error: `返回值无法序列化：${describeError(e)}`,
      durationMs: now() - started,
    };
  }

  const durationMs = now() - started;
  return { ok: true, body: body ?? 'null', durationMs, slow: durationMs > budgetMs };
}

// ═══════════════════════════════════════════════════════════
// 四、上下文构造
// ═══════════════════════════════════════════════════════════

/** 从 RequestInfo 拼出给用户函数的上下文。解析失败按空处理，绝不抛（09 §6.5） */
export function buildDynamicContext(req: RequestInfo): DynamicContext {
  const query: Record<string, string> = {};
  let path = '';
  try {
    const u = new URL(req.url);
    path = u.pathname;
    u.searchParams.forEach((v, k) => {
      query[k] = v;
    });
  } catch {
    /* 非法 URL：path 留空、query 留空 */
  }
  return { url: req.url, method: req.method, host: req.host, path, query };
}

// ═══════════════════════════════════════════════════════════

function isThenable(v: unknown): boolean {
  return !!v && (typeof v === 'object' || typeof v === 'function') &&
    typeof (v as { then?: unknown }).then === 'function';
}

function describeError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

/** performance 在 SW / MAIN world / Node 都有，但保险起见回落到 Date */
function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}
