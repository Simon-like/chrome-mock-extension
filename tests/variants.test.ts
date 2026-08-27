/**
 * 变体测试
 *
 * 变体是本轮的核心概念：一条规则持有多份响应，同一时刻生效一份。
 * 「同时刻只有一个」是结构上的保证，这些测试守住它。
 */

import { describe, expect, it } from 'vitest';
import { reduce, type ReduceContext } from '../src/core/command/reducer.js';
import {
  createDefaultStore,
  createResponseSpec,
  createRuleDraft,
  getActiveVariant,
} from '../src/core/store/defaults.js';
import { buildResponse } from '../src/core/engine/responder.js';
import { normalizeRequest } from '../src/core/engine/normalize.js';
import { validateRule } from '../src/core/store/validate.js';
import { migrate } from '../src/core/store/migrate.js';
import type { MockStore } from '../src/core/types.js';

function makeCtx(): ReduceContext {
  let n = 0;
  return { idFactory: () => `id-${++n}`, now: () => 1_700_000_000_000 };
}

function withRule(store: MockStore, ctx: ReduceContext, variants?: { name: string; body: string }[]) {
  return reduce(
    store,
    {
      type: 'CREATE_RULE',
      payload: {
        draft: createRuleDraft({
          name: '商品列表',
          match: { urlMode: 'contains', url: '/api/goods', methods: [], hosts: [] },
          variants: (variants ?? [{ name: '默认', body: '{"a":1}' }]).map((v) => ({
            name: v.name,
            response: createResponseSpec({ body: v.body }),
          })),
        }),
      },
    },
    ctx,
  );
}

const req = normalizeRequest('/api/goods/list', 'GET', 'https://a.com/');

describe('创建规则时的变体', () => {
  it('默认带一个变体，activeVariantId 指向它', () => {
    const ctx = makeCtx();
    const { store } = withRule(createDefaultStore(), ctx);
    const rule = store.rules[0]!;
    expect(rule.variants).toHaveLength(1);
    expect(rule.activeVariantId).toBe(rule.variants[0]!.id);
  });

  it('可以一次建多个变体', () => {
    const ctx = makeCtx();
    const { store } = withRule(createDefaultStore(), ctx, [
      { name: '正常', body: '{"list":[1,2]}' },
      { name: '空数据', body: '{"list":[]}' },
      { name: '报错', body: '{"msg":"err"}' },
    ]);
    expect(store.rules[0]!.variants.map((v) => v.name)).toEqual(['正常', '空数据', '报错']);
    // 默认生效第一个
    expect(getActiveVariant(store.rules[0]!).name).toBe('正常');
  });

  it('变体草稿为空时兜底补一个 —— 空变体的规则无响应可返回', () => {
    const ctx = makeCtx();
    const { store } = reduce(
      createDefaultStore(),
      { type: 'CREATE_RULE', payload: { draft: createRuleDraft({ variants: [] }) } },
      ctx,
    );
    expect(store.rules[0]!.variants.length).toBeGreaterThan(0);
  });
});

describe('SET_ACTIVE_VARIANT —— 最高频操作', () => {
  it('切换生效变体', () => {
    const ctx = makeCtx();
    let s = withRule(createDefaultStore(), ctx, [
      { name: '正常', body: '{"list":[1]}' },
      { name: '空数据', body: '{"list":[]}' },
    ]).store;

    const rule = s.rules[0]!;
    const empty = rule.variants[1]!;
    s = reduce(
      s,
      { type: 'SET_ACTIVE_VARIANT', payload: { ruleId: rule.id, variantId: empty.id } },
      ctx,
    ).store;

    expect(getActiveVariant(s.rules[0]!).name).toBe('空数据');
  });

  it('切换后引擎返回的是新变体的内容', () => {
    const ctx = makeCtx();
    let s = withRule(createDefaultStore(), ctx, [
      { name: '正常', body: '{"list":[1,2,3]}' },
      { name: '空数据', body: '{"list":[]}' },
    ]).store;

    expect(JSON.parse(buildResponse(s, s.rules[0]!, req).body)).toEqual({ list: [1, 2, 3] });

    const empty = s.rules[0]!.variants[1]!;
    s = reduce(
      s,
      { type: 'SET_ACTIVE_VARIANT', payload: { ruleId: s.rules[0]!.id, variantId: empty.id } },
      ctx,
    ).store;

    expect(JSON.parse(buildResponse(s, s.rules[0]!, req).body)).toEqual({ list: [] });
  });

  it('切到不存在的变体被拒绝', () => {
    const ctx = makeCtx();
    const s = withRule(createDefaultStore(), ctx).store;
    const out = reduce(
      s,
      { type: 'SET_ACTIVE_VARIANT', payload: { ruleId: s.rules[0]!.id, variantId: 'nope' } },
      ctx,
    );
    expect(out.result.ok).toBe(false);
    expect(out.store).toBe(s);
  });
});

describe('SAVE_RULE_DRAFT —— 编辑器整单保存', () => {
  it('保存选中的第二个变体，并在重新加载后仍保持生效', () => {
    const ctx = makeCtx();
    const initial = withRule(createDefaultStore(), ctx, [
      { name: '正常', body: '{"list":[1]}' },
      { name: '空数据', body: '{"list":[]}' },
    ]).store;
    const rule = initial.rules[0]!;

    const saved = reduce(
      initial,
      {
        type: 'SAVE_RULE_DRAFT',
        payload: {
          id: rule.id,
          draft: {
            name: rule.name,
            enabled: rule.enabled,
            projectId: rule.projectId,
            groupId: rule.groupId,
            kind: rule.kind,
            match: rule.match,
            variants: rule.variants,
            activeVariantIndex: 1,
          },
        },
      },
      ctx,
    ).store;

    const reloaded = migrate(JSON.parse(JSON.stringify(saved))).store;
    expect(getActiveVariant(reloaded.rules[0]!).name).toBe('空数据');
  });

  it('给编辑器新建的无 id 变体补 id，并能在同一次保存中激活', () => {
    const ctx = makeCtx();
    const initial = withRule(createDefaultStore(), ctx, [{ name: '正常', body: '{"x":1}' }]).store;
    const rule = initial.rules[0]!;

    const out = reduce(
      initial,
      {
        type: 'SAVE_RULE_DRAFT',
        payload: {
          id: rule.id,
          draft: {
            name: rule.name,
            enabled: rule.enabled,
            projectId: rule.projectId,
            groupId: rule.groupId,
            kind: rule.kind,
            match: rule.match,
            variants: [
              rule.variants[0]!,
              { name: '报错', response: createResponseSpec({ status: 500, body: '{"error":true}' }) },
            ],
            activeVariantIndex: 1,
          },
        },
      },
      ctx,
    );

    const active = getActiveVariant(out.store.rules[0]!);
    expect(out.result.ok).toBe(true);
    expect(active.name).toBe('报错');
    expect(active.id).toMatch(/^id-/);
    expect(active.response.status).toBe(500);
  });
});

describe('CREATE_VARIANT', () => {
  it('新建变体默认复制当前生效的响应', () => {
    const ctx = makeCtx();
    let s = withRule(createDefaultStore(), ctx, [{ name: '正常', body: '{"x":1}' }]).store;

    s = reduce(
      s,
      { type: 'CREATE_VARIANT', payload: { ruleId: s.rules[0]!.id, name: '副本' } },
      ctx,
    ).store;

    const rule = s.rules[0]!;
    expect(rule.variants).toHaveLength(2);
    // 内容复制过来了，用户接着改一点就行
    expect(rule.variants[1]!.response.body).toBe('{"x":1}');
    // 默认切过去
    expect(getActiveVariant(rule).name).toBe('副本');
  });

  it('复制是深拷贝，改新变体不影响原变体', () => {
    const ctx = makeCtx();
    let s = withRule(createDefaultStore(), ctx, [{ name: '正常', body: '{"x":1}' }]).store;
    s = reduce(s, { type: 'CREATE_VARIANT', payload: { ruleId: s.rules[0]!.id, name: '副本' } }, ctx).store;

    const rule = s.rules[0]!;
    s = reduce(
      s,
      {
        type: 'UPDATE_VARIANT',
        payload: {
          ruleId: rule.id,
          variantId: rule.variants[1]!.id,
          patch: { response: { body: '{"x":999}' } },
        },
      },
      ctx,
    ).store;

    expect(s.rules[0]!.variants[0]!.response.body).toBe('{"x":1}');
    expect(s.rules[0]!.variants[1]!.response.body).toBe('{"x":999}');
  });

  it('activate:false 时不切过去', () => {
    const ctx = makeCtx();
    let s = withRule(createDefaultStore(), ctx, [{ name: '正常', body: '{}' }]).store;
    s = reduce(
      s,
      { type: 'CREATE_VARIANT', payload: { ruleId: s.rules[0]!.id, name: '备用', activate: false } },
      ctx,
    ).store;
    expect(getActiveVariant(s.rules[0]!).name).toBe('正常');
  });

  it('变体名为空时自动编号', () => {
    const ctx = makeCtx();
    let s = withRule(createDefaultStore(), ctx).store;
    s = reduce(s, { type: 'CREATE_VARIANT', payload: { ruleId: s.rules[0]!.id, name: '  ' } }, ctx).store;
    expect(s.rules[0]!.variants[1]!.name).toBe('变体 2');
  });
});

describe('DELETE_VARIANT', () => {
  it('至少保留一个变体', () => {
    const ctx = makeCtx();
    const s = withRule(createDefaultStore(), ctx).store;
    const out = reduce(
      s,
      {
        type: 'DELETE_VARIANT',
        payload: { ruleId: s.rules[0]!.id, variantId: s.rules[0]!.variants[0]!.id },
      },
      ctx,
    );
    expect(out.result.ok).toBe(false);
    expect(out.result.error).toContain('至少');
    expect(out.store).toBe(s);
  });

  it('删掉当前生效的变体时，生效态回落到第一个', () => {
    const ctx = makeCtx();
    let s = withRule(createDefaultStore(), ctx, [
      { name: 'A', body: '{"a":1}' },
      { name: 'B', body: '{"b":1}' },
    ]).store;

    const rule = s.rules[0]!;
    // 先切到 B
    s = reduce(
      s,
      { type: 'SET_ACTIVE_VARIANT', payload: { ruleId: rule.id, variantId: rule.variants[1]!.id } },
      ctx,
    ).store;
    // 再把 B 删掉
    s = reduce(
      s,
      { type: 'DELETE_VARIANT', payload: { ruleId: rule.id, variantId: rule.variants[1]!.id } },
      ctx,
    ).store;

    expect(s.rules[0]!.variants).toHaveLength(1);
    expect(getActiveVariant(s.rules[0]!).name).toBe('A');
  });
});

describe('DUPLICATE_RULE 与变体', () => {
  it('副本的变体是全新 id —— 否则两条规则切换时会互相干扰', () => {
    const ctx = makeCtx();
    let s = withRule(createDefaultStore(), ctx, [
      { name: 'A', body: '{"a":1}' },
      { name: 'B', body: '{"b":1}' },
    ]).store;

    s = reduce(s, { type: 'DUPLICATE_RULE', payload: { id: s.rules[0]!.id } }, ctx).store;

    const [orig, copy] = s.rules;
    const origIds = orig!.variants.map((v) => v.id);
    const copyIds = copy!.variants.map((v) => v.id);
    expect(copyIds.some((cid) => origIds.includes(cid))).toBe(false);
    // 生效变体的对应关系要保持
    expect(getActiveVariant(copy!).name).toBe(getActiveVariant(orig!).name);
  });
});

describe('REORDER_VARIANT', () => {
  it('调整变体顺序', () => {
    const ctx = makeCtx();
    let s = withRule(createDefaultStore(), ctx, [
      { name: 'A', body: '{}' },
      { name: 'B', body: '{}' },
      { name: 'C', body: '{}' },
    ]).store;

    const rule = s.rules[0]!;
    s = reduce(
      s,
      { type: 'REORDER_VARIANT', payload: { ruleId: rule.id, variantId: rule.variants[2]!.id, toIndex: 0 } },
      ctx,
    ).store;

    expect(s.rules[0]!.variants.map((v) => v.name)).toEqual(['C', 'A', 'B']);
  });
});

describe('校验', () => {
  it('每个变体的响应都会被校验，报错标明是哪个变体', () => {
    const draft = createRuleDraft({
      name: '测试',
      match: { urlMode: 'contains', url: '/api', methods: [], hosts: [] },
      variants: [
        { name: '正常', response: createResponseSpec({ body: '{"ok":1}' }) },
        { name: '坏的', response: createResponseSpec({ body: '{not json' }) },
      ],
    });
    const issues = validateRule(draft as never);
    const err = issues.find((i) => i.level === 'error');
    expect(err).toBeDefined();
    expect(err!.message).toContain('坏的');
  });

  it('同名变体给出警告', () => {
    const draft = createRuleDraft({
      name: '测试',
      match: { urlMode: 'contains', url: '/api', methods: [], hosts: [] },
      variants: [
        { name: '正常', response: createResponseSpec() },
        { name: '正常', response: createResponseSpec() },
      ],
    });
    const issues = validateRule(draft as never);
    expect(issues.some((i) => i.level === 'warning' && i.message.includes('同名'))).toBe(true);
  });
});
