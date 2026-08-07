/**
 * 动态响应的测试
 *
 * 注意这里【测不出】真实站点的 CSP —— Node 里 new Function 永远可用。
 * 能测的是：编译两种写法、执行不抛、序列化边界、上下文构造。缓存与熔断见 bodygen.test.ts。
 * CSP 那一问只能在真实页面上量，方法与结论见 docs/10-动态响应Spike.md。
 */

import { describe, expect, it } from 'vitest';
import {
  buildDynamicContext,
  compileDynamicBody,
  probeEvalSupport,
  runDynamicBody,
  type CompiledBody,
} from '../src/core/engine/dynamic.js';
import { normalizeRequest } from '../src/core/engine/normalize.js';

/** 编译成功才返回函数，失败直接让测试炸掉（比后面 undefined 报错好读） */
function compiled(src: string): CompiledBody {
  const r = compileDynamicBody(src);
  if (!r.ok) throw new Error(`编译失败：${r.error}`);
  return r.fn;
}

const ctx = buildDynamicContext(
  normalizeRequest('/api/list?page=2&size=3', 'GET', 'https://a.com/'),
);

describe('probeEvalSupport', () => {
  it('Node 环境下 new Function 可用', () => {
    expect(probeEvalSupport()).toEqual({ available: true });
  });
});

describe('compileDynamicBody', () => {
  it('支持箭头函数表达式写法', () => {
    const r = runDynamicBody(compiled('(req) => ({ ok: 1 })'), ctx);
    expect(r.ok && JSON.parse(r.body)).toEqual({ ok: 1 });
  });

  it('支持 function 表达式写法', () => {
    const r = runDynamicBody(compiled('function (req) { return { ok: 2 }; }'), ctx);
    expect(r.ok && JSON.parse(r.body)).toEqual({ ok: 2 });
  });

  it('支持裸函数体写法（用户很容易直接写 return）', () => {
    const r = runDynamicBody(compiled('return { ok: 3 };'), ctx);
    expect(r.ok && JSON.parse(r.body)).toEqual({ ok: 3 });
  });

  it('空源码给出明确错误而不是抛异常', () => {
    expect(compileDynamicBody('   ')).toEqual({ ok: false, error: '源码为空' });
  });

  it('语法错误返回 ok:false，不抛出', () => {
    const r = compileDynamicBody('(req) => { this is not js');
    expect(r.ok).toBe(false);
  });
});

describe('runDynamicBody', () => {
  it('用户代码抛异常时降级为 ok:false，引擎不受影响', () => {
    const r = runDynamicBody(compiled('(req) => { throw new Error("boom"); }'), ctx);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('boom');
  });

  it('返回字符串时原样使用，不再 JSON.stringify 一层', () => {
    const r = runDynamicBody(compiled('(req) => "plain text"'), ctx);
    expect(r.ok && r.body).toBe('plain text');
  });

  it('返回 undefined 时序列化为 null，而不是字面量 undefined', () => {
    const r = runDynamicBody(compiled('(req) => undefined'), ctx);
    expect(r.ok && r.body).toBe('null');
  });

  it('拒绝 Promise —— XHR 的 send() 是同步的，等不了', () => {
    const r = runDynamicBody(compiled('(req) => Promise.resolve({})'), ctx);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('Promise');
  });

  it('循环引用不会让引擎崩掉', () => {
    const r = runDynamicBody(compiled('(req) => { const a = {}; a.self = a; return a; }'), ctx);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('无法序列化');
  });

  it('超出耗时预算时标记 slow，但结果仍然可用', () => {
    // 预算设成 -1 保证必然超，不依赖机器快慢
    const r = runDynamicBody(compiled('(req) => ({ a: 1 })'), ctx, -1);
    expect(r.ok && r.slow).toBe(true);
  });
});

describe('buildDynamicContext', () => {
  it('查询参数解析成对象，值为字符串', () => {
    expect(ctx.query).toEqual({ page: '2', size: '3' });
  });

  it('path 不含查询串', () => {
    expect(ctx.path).toBe('/api/list');
  });

  it('按参数生成分页数据 —— 这就是动态响应要解决的痛点', () => {
    const r = runDynamicBody(
      compiled(`(req) => {
        const page = Number(req.query.page) || 1;
        const size = Number(req.query.size) || 10;
        return {
          list: Array.from({ length: size }, (_, i) => ({ id: (page - 1) * size + i + 1 })),
          total: 48,
        };
      }`),
      ctx,
    );
    expect(r.ok && JSON.parse(r.body)).toEqual({
      list: [{ id: 4 }, { id: 5 }, { id: 6 }],
      total: 48,
    });
  });

  it('非法 URL 不抛异常，退化为空 path/query（09 §6.5）', () => {
    const bad = buildDynamicContext({ url: 'not a url', method: 'GET', host: '' });
    expect(bad.path).toBe('');
    expect(bad.query).toEqual({});
  });
});
