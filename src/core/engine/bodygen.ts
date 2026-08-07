/**
 * 响应体生成运行时 —— 「body 不是写死的」这件事的统一入口
 *
 * 两条生成路径：
 *   - `dynamic`：跑一段用户 JS（[dynamic.ts](./dynamic.ts)），需要 `new Function`
 *   - `mockjs`：展开一份数据模板（[mockjs.ts](./mockjs.ts)），纯遍历，不需要 eval
 *
 * ── 为什么合成一个 runtime ──────────────────────────
 *
 * 两者的**失败处理完全同构**：都要缓存、都要「同一个错别刷屏」、
 * 都要「一直失败就别再试了」。分成两套的话，这三件事要写两遍、
 * 语义还容易漂（比如一边熔断一边不熔断，用户看到的行为就不一致了）。
 *
 * 所以有状态的部分（编译缓存 · 失败计数 · 已报告集合）都收在这里，
 * dynamic.ts 和 mockjs.ts 保持纯函数、各自可独立测试。
 *
 * 为什么是显式对象而不是模块级变量：core 层铁律是纯函数零副作用（09 §6.5）。
 * 藏成模块变量的话测试之间会互相污染 —— 一个用例把某规则熔断了，
 * 下一个用例莫名其妙拿到降级结果，极难查。
 */

import type { BodyGenDiagnostics, BodyType, RequestInfo } from '../types.js';
import {
  DYNAMIC_BUDGET_MS,
  buildDynamicContext,
  compileDynamicBody,
  runDynamicBody,
  type CompileResult,
} from './dynamic.js';
import { expandTemplateJson } from './mockjs.js';

export interface BodyGenRuntimeOptions {
  budgetMs?: number;
  /** 连续失败多少次后熔断这条规则 */
  tripAfter?: number;
  /** 编译缓存上限，超了按插入顺序淘汰最早的 */
  cacheLimit?: number;
}

export interface BodyGenResult {
  /** 最终要用的响应体（失败时是错误载荷） */
  body: string;
  diagnostics: BodyGenDiagnostics;
}

export interface BodyGenRuntime {
  /**
   * @param key 熔断与「已报告」的粒度。调用方按「规则:变体」传 ——
   *            同一条规则的不同变体是不同的代码/模板，不该互相拖累
   */
  generate(
    key: string,
    kind: Exclude<BodyType, 'static'>,
    source: string,
    req: RequestInfo,
  ): BodyGenResult;
  /** 用户改了规则后调用，给它一次重新做人的机会 */
  reset(key?: string): void;
}

const DEFAULT_TRIP_AFTER = 3;
const DEFAULT_CACHE_LIMIT = 64;

export function createBodyGenRuntime(opts: BodyGenRuntimeOptions = {}): BodyGenRuntime {
  const budgetMs = opts.budgetMs ?? DYNAMIC_BUDGET_MS;
  const tripAfter = opts.tripAfter ?? DEFAULT_TRIP_AFTER;
  const cacheLimit = opts.cacheLimit ?? DEFAULT_CACHE_LIMIT;

  /** 源码 → 编译结果。键用源码本身，改一个字符就是新条目，自然失效 */
  const compiled = new Map<string, CompileResult>();
  /** key → 连续失败次数。成功一次就清零 */
  const failures = new Map<string, number>();
  /** 已经报过错的 key，用来判断 firstFailure */
  const reported = new Set<string>();

  const compile = (source: string): CompileResult => {
    const hit = compiled.get(source);
    if (hit) return hit;
    const result = compileDynamicBody(source);
    // Map 保持插入顺序，第一个键就是最早的
    if (compiled.size >= cacheLimit) {
      const oldest = compiled.keys().next().value;
      if (oldest !== undefined) compiled.delete(oldest);
    }
    compiled.set(source, result);
    return result;
  };

  const fail = (
    key: string,
    kind: Exclude<BodyType, 'static'>,
    error: string,
    durationMs: number,
  ): BodyGenResult => {
    failures.set(key, (failures.get(key) ?? 0) + 1);
    const firstFailure = !reported.has(key);
    reported.add(key);
    return {
      body: errorPayload(error),
      diagnostics: {
        kind,
        ok: false,
        error,
        durationMs,
        slow: false,
        tripped: false,
        firstFailure,
      },
    };
  };

  const succeed = (
    key: string,
    kind: Exclude<BodyType, 'static'>,
    body: string,
    durationMs: number,
  ): BodyGenResult => {
    failures.delete(key);
    return {
      body,
      diagnostics: {
        kind,
        ok: true,
        durationMs,
        slow: durationMs > budgetMs,
        tripped: false,
        firstFailure: false,
      },
    };
  };

  return {
    generate(key, kind, source, req) {
      /**
       * 熔断：连错够多就不再执行。这是「事后测量」唯一能兑现的保护 ——
       * 拦不住第一次，但拦得住第 4 次到第 4000 次。
       *
       * mockjs 也走这条：坏模板是确定性失败，重试一万次也还是那个错，
       * 白白在每个请求上烧 CPU。
       */
      if ((failures.get(key) ?? 0) >= tripAfter) {
        const error = `已熔断（连续失败 ${tripAfter} 次）`;
        return {
          body: errorPayload(`该规则的响应体生成已连续失败 ${tripAfter} 次，已暂停执行`),
          diagnostics: {
            kind,
            ok: false,
            error,
            durationMs: 0,
            slow: false,
            tripped: true,
            firstFailure: false,
          },
        };
      }

      if (kind === 'mockjs') {
        const started = now();
        const out = expandTemplateJson(source);
        const durationMs = now() - started;
        return out.ok
          ? succeed(key, kind, safeStringify(out.value), durationMs)
          : fail(key, kind, out.error, durationMs);
      }

      const c = compile(source);
      if (!c.ok) return fail(key, kind, `编译失败 —— ${c.error}`, 0);

      const r = runDynamicBody(c.fn, buildDynamicContext(req), budgetMs);
      return r.ok
        ? succeed(key, kind, r.body, r.durationMs)
        : fail(key, kind, r.error, r.durationMs);
    },

    reset(key) {
      if (key === undefined) {
        failures.clear();
        reported.clear();
        return;
      }
      failures.delete(key);
      reported.delete(key);
    },
  };
}

/**
 * 失败时返回的载荷。
 *
 * 刻意**不**静默返回 `{}` —— 那样页面会「正常」渲染出空列表，
 * 开发者得排查半天才发现是自己那段 mock 写错了。
 * 明晃晃地把错误塞进响应体，配合请求面板标红，一眼就知道该去改哪。
 */
function errorPayload(error: string): string {
  return JSON.stringify({ __mockStudioError__: error });
}

/** 模板展开的产物理论上都能序列化，但引擎不做「理论上」的假设 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? 'null';
  } catch (e) {
    return errorPayload(`结果无法序列化：${(e as Error).message}`);
  }
}

/** performance 在 SW / MAIN world / Node 都有，但保险起见回落到 Date */
function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}
