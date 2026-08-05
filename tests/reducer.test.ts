/**
 * reducer 测试
 *
 * reducer 是纯函数，副作用（id 生成、时间戳）通过 ctx 注入，
 * 所以测试可以完全可预测 —— 这正是设计成纯函数的收益之一。
 */

import { describe, expect, it } from 'vitest';
import { reduce, type ReduceContext } from '../src/core/command/reducer.js';
import { createDefaultStore, createRuleDraft } from '../src/core/store/defaults.js';
import type { MockStore } from '../src/core/types.js';

function makeCtx(): ReduceContext {
  let n = 0;
  return { idFactory: () => `id-${++n}`, now: () => 1_700_000_000_000 };
}

function withRule(store: MockStore, ctx: ReduceContext, name: string, url: string) {
  return reduce(
    store,
    {
      type: 'CREATE_RULE',
      payload: {
        draft: createRuleDraft({
          name,
          match: { urlMode: 'contains', url, methods: [], hosts: [] },
        }),
      },
    },
    ctx,
  );
}

describe('CREATE_RULE', () => {
  it('新增规则并返回生成的 id', () => {
    const ctx = makeCtx();
    const { store, result } = withRule(createDefaultStore(), ctx, 'A', '/api/a');
    expect(result.ok).toBe(true);
    expect(result.createdId).toBe('id-1');
    expect(store.rules).toHaveLength(1);
    expect(store.rules[0]!.name).toBe('A');
  });

  it('meta 被正确初始化', () => {
    const ctx = makeCtx();
    const { store } = withRule(createDefaultStore(), ctx, 'A', '/api/a');
    const meta = store.rules[0]!.meta;
    expect(meta.hitCount).toBe(0);
    expect(meta.lastHitAt).toBeNull();
    expect(meta.createdAt).toBe(1_700_000_000_000);
    expect(meta.source).toBe('manual');
  });

  it('不修改原 store（纯函数）', () => {
    const ctx = makeCtx();
    const original = createDefaultStore();
    withRule(original, ctx, 'A', '/api/a');
    expect(original.rules).toHaveLength(0);
  });
});

describe('UPDATE_RULE', () => {
  it('局部更新并刷新 updatedAt', () => {
    const ctx = makeCtx();
    let s = withRule(createDefaultStore(), ctx, 'A', '/api/a').store;

    const later: ReduceContext = { ...ctx, now: () => 1_700_000_999_999 };
    const out = reduce(
      s,
      { type: 'UPDATE_RULE', payload: { id: 'id-1', patch: { name: 'A改' } } },
      later,
    );

    expect(out.result.ok).toBe(true);
    expect(out.store.rules[0]!.name).toBe('A改');
    expect(out.store.rules[0]!.meta.updatedAt).toBe(1_700_000_999_999);
    // 未涉及的字段保持不变
    expect(out.store.rules[0]!.match.url).toBe('/api/a');
  });

  it('id 不存在时返回错误且 store 不变', () => {
    const ctx = makeCtx();
    const s = createDefaultStore();
    const out = reduce(s, { type: 'UPDATE_RULE', payload: { id: 'nope', patch: {} } }, ctx);
    expect(out.result.ok).toBe(false);
    expect(out.store).toBe(s);
  });

  it('patch 无法篡改 id', () => {
    const ctx = makeCtx();
    const s = withRule(createDefaultStore(), ctx, 'A', '/api/a').store;
    const out = reduce(
      s,
      { type: 'UPDATE_RULE', payload: { id: 'id-1', patch: { name: 'x' } } },
      ctx,
    );
    expect(out.store.rules[0]!.id).toBe('id-1');
  });
});

describe('REORDER_RULE', () => {
  it('顺序即优先级，移动到指定下标', () => {
    const ctx = makeCtx();
    let s = withRule(createDefaultStore(), ctx, 'A', '/a').store;
    s = withRule(s, ctx, 'B', '/b').store;
    s = withRule(s, ctx, 'C', '/c').store;

    const out = reduce(s, { type: 'REORDER_RULE', payload: { id: 'id-3', toIndex: 0 } }, ctx);
    expect(out.store.rules.map((r) => r.name)).toEqual(['C', 'A', 'B']);
  });

  it('越界下标被夹取，不报错', () => {
    const ctx = makeCtx();
    let s = withRule(createDefaultStore(), ctx, 'A', '/a').store;
    s = withRule(s, ctx, 'B', '/b').store;

    const out = reduce(s, { type: 'REORDER_RULE', payload: { id: 'id-1', toIndex: 99 } }, ctx);
    expect(out.result.ok).toBe(true);
    expect(out.store.rules.map((r) => r.name)).toEqual(['B', 'A']);
  });
});

describe('DUPLICATE_RULE', () => {
  it('副本紧跟原规则，且统计归零', () => {
    const ctx = makeCtx();
    let s = withRule(createDefaultStore(), ctx, 'A', '/a').store;
    s = reduce(s, { type: 'RECORD_HIT', payload: { ruleId: 'id-1', at: 123 } }, ctx).store;

    const out = reduce(s, { type: 'DUPLICATE_RULE', payload: { id: 'id-1' } }, ctx);
    expect(out.store.rules.map((r) => r.name)).toEqual(['A', 'A 副本']);
    expect(out.store.rules[1]!.meta.hitCount).toBe(0);
    expect(out.store.rules[1]!.id).not.toBe('id-1');
  });

  it('副本是深拷贝，改副本不影响原规则', () => {
    const ctx = makeCtx();
    const s = withRule(createDefaultStore(), ctx, 'A', '/a').store;
    const out = reduce(s, { type: 'DUPLICATE_RULE', payload: { id: 'id-1' } }, ctx);

    out.store.rules[1]!.match.methods.push('POST');
    expect(out.store.rules[0]!.match.methods).toEqual([]);
  });
});

describe('RECORD_HIT', () => {
  it('累加命中数（这是诊断功能的数据来源）', () => {
    const ctx = makeCtx();
    let s = withRule(createDefaultStore(), ctx, 'A', '/a').store;
    s = reduce(s, { type: 'RECORD_HIT', payload: { ruleId: 'id-1', at: 100 } }, ctx).store;
    s = reduce(s, { type: 'RECORD_HIT', payload: { ruleId: 'id-1', at: 200 } }, ctx).store;

    expect(s.rules[0]!.meta.hitCount).toBe(2);
    expect(s.rules[0]!.meta.lastHitAt).toBe(200);
  });
});

describe('IMPORT_STORE', () => {
  it('replace 模式整体替换', () => {
    const ctx = makeCtx();
    const s = withRule(createDefaultStore(), ctx, '本地', '/local').store;
    const incoming = withRule(createDefaultStore(), makeCtx(), '导入', '/imported').store;

    const out = reduce(
      s,
      { type: 'IMPORT_STORE', payload: { raw: incoming, mode: 'replace' } },
      ctx,
    );
    expect(out.result.ok).toBe(true);
    expect(out.store.rules.map((r) => r.name)).toEqual(['导入']);
  });

  it('merge 模式保留本地不冲突的规则', () => {
    const ctxA = makeCtx();
    const local = withRule(createDefaultStore(), ctxA, '本地', '/local').store;

    // 用不同的 id 工厂，模拟另一台机器导出的文件
    let n = 100;
    const ctxB: ReduceContext = { idFactory: () => `remote-${++n}`, now: () => 1 };
    const incoming = withRule(createDefaultStore(), ctxB, '导入', '/imported').store;

    const out = reduce(
      local,
      { type: 'IMPORT_STORE', payload: { raw: incoming, mode: 'merge' } },
      ctxA,
    );
    expect(out.store.rules.map((r) => r.name)).toEqual(['本地', '导入']);
  });

  it('垃圾数据导入失败且 store 不变', () => {
    const ctx = makeCtx();
    const s = withRule(createDefaultStore(), ctx, 'A', '/a').store;
    const out = reduce(s, { type: 'IMPORT_STORE', payload: { raw: 'garbage', mode: 'replace' } }, ctx);
    expect(out.result.ok).toBe(false);
    expect(out.store).toBe(s);
  });
});

describe('全局开关与设置', () => {
  it('SET_GLOBAL_ENABLED', () => {
    const ctx = makeCtx();
    const out = reduce(
      createDefaultStore(),
      { type: 'SET_GLOBAL_ENABLED', payload: { enabled: false } },
      ctx,
    );
    expect(out.store.enabled).toBe(false);
  });

  it('UPDATE_SETTINGS 局部更新', () => {
    const ctx = makeCtx();
    const out = reduce(
      createDefaultStore(),
      { type: 'UPDATE_SETTINGS', payload: { patch: { captureMaxCount: 500 } } },
      ctx,
    );
    expect(out.store.settings.captureMaxCount).toBe(500);
    // 其他设置不受影响
    expect(out.store.settings.captureEnabled).toBe(true);
  });
});
