/**
 * 分组与互斥组（场景切换）测试
 *
 * 互斥规则有三个触发入口 —— 切换组、新建互斥组、把普通组改成互斥组。
 * 散落在各处很容易漏掉其中一个，所以每个入口都要覆盖。
 */

import { describe, expect, it } from 'vitest';
import { reduce, type ReduceContext } from '../src/core/command/reducer.js';
import { createDefaultStore, createRuleDraft } from '../src/core/store/defaults.js';
import { findMatchingRule } from '../src/core/engine/matcher.js';
import { normalizeRequest } from '../src/core/engine/normalize.js';
import { migrate } from '../src/core/store/migrate.js';
import type { MockStore } from '../src/core/types.js';

function makeCtx(): ReduceContext {
  let n = 0;
  return { idFactory: () => `id-${++n}`, now: () => 1_700_000_000_000 };
}

function addGroup(store: MockStore, ctx: ReduceContext, name: string, exclusive = false) {
  return reduce(store, { type: 'CREATE_GROUP', payload: { name, exclusive } }, ctx);
}

function addRule(store: MockStore, ctx: ReduceContext, name: string, url: string, groupId: string | null = null) {
  return reduce(
    store,
    {
      type: 'CREATE_RULE',
      payload: {
        draft: createRuleDraft({
          name,
          groupId,
          match: { urlMode: 'contains', url, methods: [], hosts: [] },
        }),
      },
    },
    ctx,
  );
}

describe('分组基础操作', () => {
  it('新建分组默认启用且为普通组', () => {
    const ctx = makeCtx();
    const { store, result } = addGroup(createDefaultStore(), ctx, '商品模块');
    expect(result.ok).toBe(true);
    expect(store.groups).toHaveLength(1);
    expect(store.groups[0]!.enabled).toBe(true);
    expect(store.groups[0]!.exclusive).toBe(false);
  });

  it('分组名为空时拒绝创建', () => {
    const ctx = makeCtx();
    const { store, result } = addGroup(createDefaultStore(), ctx, '   ');
    expect(result.ok).toBe(false);
    expect(store.groups).toHaveLength(0);
  });

  it('删除分组时组内规则移到未分组，而不是被删掉', () => {
    const ctx = makeCtx();
    let s = addGroup(createDefaultStore(), ctx, '商品').store;
    const gid = s.groups[0]!.id;
    s = addRule(s, ctx, '列表', '/api/goods', gid).store;
    s = addRule(s, ctx, '详情', '/api/goods/detail', gid).store;

    const out = reduce(s, { type: 'DELETE_GROUP', payload: { id: gid } }, ctx);
    expect(out.store.groups).toHaveLength(0);
    // 规则还在，只是没了归属
    expect(out.store.rules).toHaveLength(2);
    expect(out.store.rules.every((r) => r.groupId === null)).toBe(true);
  });
});

describe('互斥组 = 场景切换', () => {
  /** 建三个互斥组，模拟「正常态 / 全空态 / 全错态」 */
  function threeScenarios() {
    const ctx = makeCtx();
    let s = createDefaultStore();
    s = addGroup(s, ctx, '正常态', true).store;
    s = addGroup(s, ctx, '全空态', true).store;
    s = addGroup(s, ctx, '全错态', true).store;
    return { store: s, ctx };
  }

  it('入口一：新建互斥组时自动关掉其他互斥组', () => {
    const { store } = threeScenarios();
    const enabled = store.groups.filter((g) => g.enabled);
    expect(enabled).toHaveLength(1);
    // 最后建的那个生效
    expect(enabled[0]!.name).toBe('全错态');
  });

  it('入口二：启用某个互斥组，其余自动关闭', () => {
    const { store, ctx } = threeScenarios();
    const normal = store.groups.find((g) => g.name === '正常态')!;

    const out = reduce(store, { type: 'TOGGLE_GROUP', payload: { id: normal.id, enabled: true } }, ctx);
    const enabled = out.store.groups.filter((g) => g.enabled);
    expect(enabled).toHaveLength(1);
    expect(enabled[0]!.name).toBe('正常态');
  });

  it('入口三：普通组改成互斥组时同样遵守互斥', () => {
    const { store, ctx } = threeScenarios();
    let s = addGroup(store, ctx, '临时组', false).store;
    const temp = s.groups.find((g) => g.name === '临时组')!;
    expect(temp.enabled).toBe(true);

    // 此时有 1 个互斥组 + 1 个启用的普通组
    s = reduce(s, { type: 'UPDATE_GROUP', payload: { id: temp.id, patch: { exclusive: true } } }, ctx).store;

    const enabledExclusive = s.groups.filter((g) => g.exclusive && g.enabled);
    expect(enabledExclusive).toHaveLength(1);
    expect(enabledExclusive[0]!.name).toBe('临时组');
  });

  it('关闭互斥组不会连带开启别的（允许全部关闭）', () => {
    const { store, ctx } = threeScenarios();
    const active = store.groups.find((g) => g.enabled)!;
    const out = reduce(store, { type: 'TOGGLE_GROUP', payload: { id: active.id, enabled: false } }, ctx);
    expect(out.store.groups.filter((g) => g.enabled)).toHaveLength(0);
  });

  it('普通组之间互不影响，可同时启用', () => {
    const ctx = makeCtx();
    let s = createDefaultStore();
    s = addGroup(s, ctx, '商品模块').store;
    s = addGroup(s, ctx, '订单模块').store;
    s = addGroup(s, ctx, '用户模块').store;
    expect(s.groups.filter((g) => g.enabled)).toHaveLength(3);
  });

  it('普通组不受互斥组切换影响', () => {
    const ctx = makeCtx();
    let s = createDefaultStore();
    s = addGroup(s, ctx, '商品模块', false).store;
    s = addGroup(s, ctx, '正常态', true).store;
    s = addGroup(s, ctx, '全空态', true).store;

    const goods = s.groups.find((g) => g.name === '商品模块')!;
    expect(goods.enabled).toBe(true); // 没被互斥逻辑误伤
  });
});

describe('分组开关对匹配的影响', () => {
  it('组关闭时组内规则不参与匹配', () => {
    const ctx = makeCtx();
    let s = addGroup(createDefaultStore(), ctx, '商品').store;
    const gid = s.groups[0]!.id;
    s = addRule(s, ctx, '列表', '/api/goods', gid).store;

    const req = normalizeRequest('/api/goods/list', 'GET', 'https://a.com/');
    expect(findMatchingRule(s, req)).not.toBeNull();

    s = reduce(s, { type: 'TOGGLE_GROUP', payload: { id: gid, enabled: false } }, ctx).store;
    expect(findMatchingRule(s, req)).toBeNull();
  });

  it('切换场景后命中的是新场景里的规则', () => {
    const ctx = makeCtx();
    let s = createDefaultStore();
    s = addGroup(s, ctx, '正常态', true).store;
    const normalId = s.groups[0]!.id;
    s = addGroup(s, ctx, '全空态', true).store;
    const emptyId = s.groups[1]!.id;

    // 两个场景各有一条针对同一接口的规则
    s = addRule(s, ctx, '正常-列表', '/api/goods', normalId).store;
    s = addRule(s, ctx, '空-列表', '/api/goods', emptyId).store;

    const req = normalizeRequest('/api/goods/list', 'GET', 'https://a.com/');

    // 建「全空态」时它成了唯一启用的互斥组
    expect(findMatchingRule(s, req)?.rule.name).toBe('空-列表');

    s = reduce(s, { type: 'TOGGLE_GROUP', payload: { id: normalId, enabled: true } }, ctx).store;
    expect(findMatchingRule(s, req)?.rule.name).toBe('正常-列表');
  });
});

describe('MOVE_RULE_TO_GROUP', () => {
  it('把规则移入分组', () => {
    const ctx = makeCtx();
    let s = addGroup(createDefaultStore(), ctx, '商品').store;
    const gid = s.groups[0]!.id;
    s = addRule(s, ctx, '列表', '/api/goods').store;
    const rid = s.rules[0]!.id;

    const out = reduce(s, { type: 'MOVE_RULE_TO_GROUP', payload: { id: rid, groupId: gid } }, ctx);
    expect(out.result.ok).toBe(true);
    expect(out.store.rules[0]!.groupId).toBe(gid);
  });

  it('移出分组（groupId 传 null）', () => {
    const ctx = makeCtx();
    let s = addGroup(createDefaultStore(), ctx, '商品').store;
    const gid = s.groups[0]!.id;
    s = addRule(s, ctx, '列表', '/api/goods', gid).store;
    const rid = s.rules[0]!.id;

    const out = reduce(s, { type: 'MOVE_RULE_TO_GROUP', payload: { id: rid, groupId: null } }, ctx);
    expect(out.store.rules[0]!.groupId).toBeNull();
  });

  it('同时调整顺序 —— 顺序即优先级，归组不能把优先级搞乱', () => {
    const ctx = makeCtx();
    let s = createDefaultStore();
    s = addRule(s, ctx, 'A', '/a').store;
    s = addRule(s, ctx, 'B', '/b').store;
    s = addRule(s, ctx, 'C', '/c').store;
    const cId = s.rules[2]!.id;

    const out = reduce(
      s,
      { type: 'MOVE_RULE_TO_GROUP', payload: { id: cId, groupId: null, toIndex: 0 } },
      ctx,
    );
    expect(out.store.rules.map((r) => r.name)).toEqual(['C', 'A', 'B']);
  });

  it('目标分组不存在时拒绝，且不改动 store', () => {
    const ctx = makeCtx();
    const s = addRule(createDefaultStore(), ctx, 'A', '/a').store;
    const out = reduce(
      s,
      { type: 'MOVE_RULE_TO_GROUP', payload: { id: s.rules[0]!.id, groupId: 'nope' } },
      ctx,
    );
    expect(out.result.ok).toBe(false);
    expect(out.store).toBe(s);
  });

  it('越界 toIndex 被夹取', () => {
    const ctx = makeCtx();
    let s = addRule(createDefaultStore(), ctx, 'A', '/a').store;
    s = addRule(s, ctx, 'B', '/b').store;
    const out = reduce(
      s,
      { type: 'MOVE_RULE_TO_GROUP', payload: { id: s.rules[0]!.id, groupId: null, toIndex: 99 } },
      ctx,
    );
    expect(out.result.ok).toBe(true);
    expect(out.store.rules.map((r) => r.name)).toEqual(['B', 'A']);
  });
});

describe('REORDER_GROUP', () => {
  it('调整分组顺序', () => {
    const ctx = makeCtx();
    let s = createDefaultStore();
    s = addGroup(s, ctx, 'A').store;
    s = addGroup(s, ctx, 'B').store;
    s = addGroup(s, ctx, 'C').store;

    const out = reduce(s, { type: 'REORDER_GROUP', payload: { id: s.groups[2]!.id, toIndex: 0 } }, ctx);
    expect(out.store.groups.map((g) => g.name)).toEqual(['C', 'A', 'B']);
  });
});

describe('旧数据兼容', () => {
  it('缺 exclusive 字段的分组按普通组处理', () => {
    // 误判成互斥组会让用户的组莫名互相关闭，所以默认值必须是 false
    const { store } = migrate({
      schemaVersion: 1,
      rules: [],
      groups: [
        { id: 'g1', name: '老分组A', enabled: true, defaultShellTemplateId: null },
        { id: 'g2', name: '老分组B', enabled: true, defaultShellTemplateId: null },
      ],
    });
    expect(store.groups.every((g) => g.exclusive === false)).toBe(true);
    expect(store.groups.filter((g) => g.enabled)).toHaveLength(2);
  });

  it('丢弃没有 id 的脏数据', () => {
    const { store } = migrate({
      schemaVersion: 1,
      rules: [],
      groups: [{ name: '没有id' }, { id: 'g1', name: '正常' }],
    });
    expect(store.groups).toHaveLength(1);
    expect(store.groups[0]!.id).toBe('g1');
  });
});
