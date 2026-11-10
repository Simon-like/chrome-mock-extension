/**
 * 响应体生成运行时的测试
 *
 * 这里测的是**有状态的那部分**：编译缓存、连续失败熔断、报告去重。
 * 生成本身的正确性在 dynamic.test.ts / mockjs.test.ts 里测。
 *
 * 每个用例都自己 createBodyGenRuntime() —— 熔断状态串味的话，
 * 一个用例把某 key 打黑了，下一个用例莫名其妙拿到降级结果，极难查。
 */

import { describe, expect, it } from 'vitest';
import { createBodyGenRuntime } from '../src/core/engine/bodygen.js';
import { normalizeRequest } from '../src/core/engine/normalize.js';

const req = normalizeRequest('/api/list?page=2', 'GET', 'https://a.com/');

const OK = '(req) => ({ a: 1 })';
const BOOM = '(req) => { throw new Error("boom"); }';

describe('generate · dynamic', () => {
  it('成功时返回执行结果', () => {
    const rt = createBodyGenRuntime();
    const r = rt.generate('r1', 'dynamic', OK, req);
    expect(r.diagnostics).toMatchObject({ kind: 'dynamic', ok: true });
    expect(JSON.parse(r.body)).toEqual({ a: 1 });
  });

  it('失败时返回带 __mockStudioError__ 的载荷，而不是静默的空对象', () => {
    const rt = createBodyGenRuntime();
    const r = rt.generate('r1', 'dynamic', BOOM, req);
    expect(r.diagnostics.ok).toBe(false);
    expect(JSON.parse(r.body).__mockStudioError__).toContain('boom');
  });

  it('同一段源码只编译一次（缓存以源码为键）', () => {
    const rt = createBodyGenRuntime();
    // 源码里带副作用计数器，只有【编译】时会执行外层
    const src = '(() => { globalThis.__c = (globalThis.__c || 0) + 1; return (req) => ({}); })()';
    rt.generate('r1', 'dynamic', src, req);
    rt.generate('r1', 'dynamic', src, req);
    rt.generate('r1', 'dynamic', src, req);
    expect((globalThis as { __c?: number }).__c).toBe(1);
    delete (globalThis as { __c?: number }).__c;
  });
});

describe('generate · mockjs', () => {
  it('展开模板，kind 标成 mockjs', () => {
    const rt = createBodyGenRuntime();
    const r = rt.generate('r1', 'mockjs', '{"list|3":[{"id|+1":1}]}', req);
    expect(r.diagnostics).toMatchObject({ kind: 'mockjs', ok: true });
    expect(JSON.parse(r.body).list.map((x: { id: number }) => x.id)).toEqual([1, 2, 3]);
  });

  it('模板非法时也走同一套错误载荷', () => {
    const rt = createBodyGenRuntime();
    const r = rt.generate('r1', 'mockjs', '{不是 JSON}', req);
    expect(r.diagnostics.ok).toBe(false);
    expect(JSON.parse(r.body).__mockStudioError__).toContain('不是合法 JSON');
  });

  it('模板不需要 eval —— 和 dynamic 走的是完全不同的路径', () => {
    // 这条用例的价值在于把「mockjs 在 CSP 严格站点上仍可用」钉住：
    // 若哪天有人图省事把模板展开改成 new Function 实现，这里不会红，
    // 但注释在，评审时能看见。真正的保证是 mockjs.ts 里没有 Function 调用
    const src = require('node:fs').readFileSync('src/core/engine/mockjs.ts', 'utf8');
    expect(src).not.toMatch(/new Function|\beval\(/);
  });
});

describe('熔断', () => {
  it('连续失败达到阈值后熔断，不再执行用户代码', () => {
    const rt = createBodyGenRuntime({ tripAfter: 2 });
    const counting =
      '(req) => { globalThis.__n = (globalThis.__n || 0) + 1; throw new Error("x"); }';
    rt.generate('r1', 'dynamic', counting, req);
    rt.generate('r1', 'dynamic', counting, req);
    const calls = (globalThis as { __n?: number }).__n ?? 0;

    const third = rt.generate('r1', 'dynamic', counting, req);
    expect(third.diagnostics.tripped).toBe(true);
    expect((globalThis as { __n?: number }).__n).toBe(calls); // 没有再涨
    delete (globalThis as { __n?: number }).__n;
  });

  it('坏模板同样会被熔断 —— 确定性失败重试一万次也是那个错', () => {
    const rt = createBodyGenRuntime({ tripAfter: 1 });
    rt.generate('r1', 'mockjs', '{坏的}', req);
    expect(rt.generate('r1', 'mockjs', '{坏的}', req).diagnostics.tripped).toBe(true);
  });

  it('按 key 隔离，一条坏规则不拖累另一条', () => {
    const rt = createBodyGenRuntime({ tripAfter: 1 });
    rt.generate('bad', 'dynamic', BOOM, req);
    expect(rt.generate('bad', 'dynamic', BOOM, req).diagnostics.tripped).toBe(true);
    expect(rt.generate('good', 'dynamic', OK, req).diagnostics.ok).toBe(true);
  });

  it('中间成功一次就清零计数，不会攒着攒着突然熔断', () => {
    const rt = createBodyGenRuntime({ tripAfter: 2 });
    rt.generate('r1', 'dynamic', BOOM, req); // 失败 1
    rt.generate('r1', 'dynamic', OK, req); // 成功 → 清零
    rt.generate('r1', 'dynamic', BOOM, req); // 失败 1（没清零的话这里已经是 2）
    // 熔断在【进入时】判断，所以攒够 tripAfter 的下一次才被拦
    expect(rt.generate('r1', 'dynamic', BOOM, req).diagnostics.tripped).toBe(false);
    expect(rt.generate('r1', 'dynamic', BOOM, req).diagnostics.tripped).toBe(true);
  });

  it('编译失败也计入熔断', () => {
    const rt = createBodyGenRuntime({ tripAfter: 2 });
    const broken = '(req) => { this is not js';
    expect(rt.generate('r1', 'dynamic', broken, req).diagnostics.ok).toBe(false);
    rt.generate('r1', 'dynamic', broken, req);
    expect(rt.generate('r1', 'dynamic', broken, req).diagnostics.tripped).toBe(true);
  });

  it('reset 后恢复执行 —— 对应「用户改完规则保存」', () => {
    const rt = createBodyGenRuntime({ tripAfter: 1 });
    rt.generate('r1', 'dynamic', BOOM, req);
    expect(rt.generate('r1', 'dynamic', BOOM, req).diagnostics.tripped).toBe(true);
    rt.reset();
    expect(rt.generate('r1', 'dynamic', OK, req).diagnostics.ok).toBe(true);
  });
});

describe('firstFailure', () => {
  it('只在第一次为 true —— 宿主据此只 warn 一次，不刷屏', () => {
    const rt = createBodyGenRuntime();
    expect(rt.generate('r1', 'dynamic', BOOM, req).diagnostics.firstFailure).toBe(true);
    expect(rt.generate('r1', 'dynamic', BOOM, req).diagnostics.firstFailure).toBe(false);
  });

  it('模板错误也去重，不会每个请求都喊一遍', () => {
    const rt = createBodyGenRuntime();
    expect(rt.generate('r1', 'mockjs', '{坏}', req).diagnostics.firstFailure).toBe(true);
    expect(rt.generate('r1', 'mockjs', '{坏}', req).diagnostics.firstFailure).toBe(false);
  });

  it('reset 后可以再喊一次 —— 用户改过了，新的错值得重新提示', () => {
    const rt = createBodyGenRuntime();
    rt.generate('r1', 'dynamic', BOOM, req);
    rt.reset('r1');
    expect(rt.generate('r1', 'dynamic', BOOM, req).diagnostics.firstFailure).toBe(true);
  });
});
