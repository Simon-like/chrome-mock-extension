/**
 * 项目、分组与域名作用域测试
 *
 * v2 的容器层级：项目 → 分组 → 规则。两层都可选。
 * 项目的独特价值是绑定域名，否则它只是「更大的分组」。
 */

import { describe, expect, it } from 'vitest';
import { reduce, type ReduceContext } from '../src/core/command/reducer.js';
import { createDefaultStore, createRuleDraft } from '../src/core/store/defaults.js';
import { findMatchingRule, matchHostScope } from '../src/core/engine/matcher.js';
import { normalizeRequest } from '../src/core/engine/normalize.js';
import { buildResponse } from '../src/core/engine/responder.js';
import type { MockStore } from '../src/core/types.js';

function makeCtx(): ReduceContext {
  let n = 0;
  return { idFactory: () => `id-${++n}`, now: () => 1_700_000_000_000 };
}

const addProject = (s: MockStore, ctx: ReduceContext, name: string) =>
  reduce(s, { type: 'CREATE_PROJECT', payload: { name } }, ctx);

const addGroup = (s: MockStore, ctx: ReduceContext, name: string, projectId: string | null = null) =>
  reduce(s, { type: 'CREATE_GROUP', payload: { name, projectId } }, ctx);

const addRule = (
  s: MockStore,
  ctx: ReduceContext,
  name: string,
  url: string,
  extra: { groupId?: string | null; projectId?: string | null; hosts?: string[] } = {},
) =>
  reduce(
    s,
    {
      type: 'CREATE_RULE',
      payload: {
        draft: createRuleDraft({
          name,
          groupId: extra.groupId ?? null,
          projectId: extra.projectId ?? null,
          match: { urlMode: 'contains', url, methods: [], hosts: extra.hosts ?? [] },
        }),
      },
    },
    ctx,
  );

const req = (url: string, host = 'a.com') =>
  normalizeRequest(url, 'GET', `https://${host}/`);

// ═══════════════════════════════════════════════════════════

describe('项目', () => {
  it('新建项目默认不限域名 —— 建项目时不必先想清楚域名', () => {
    const ctx = makeCtx();
    const { store, result } = addProject(createDefaultStore(), ctx, '金链平台');
    expect(result.ok).toBe(true);
    expect(store.projects[0]!.hostScope.patterns).toEqual([]);
    // 新建后自动切过去
    expect(store.activeProjectId).toBe(store.projects[0]!.id);
  });

  it('项目名为空时拒绝创建', () => {
    const ctx = makeCtx();
    const { store, result } = addProject(createDefaultStore(), ctx, '   ');
    expect(result.ok).toBe(false);
    expect(store.projects).toHaveLength(0);
  });

  it('删除项目默认保留内容 —— 删错了还能找回来，删没了找不回来', () => {
    const ctx = makeCtx();
    let s = addProject(createDefaultStore(), ctx, '项目A').store;
    const pid = s.projects[0]!.id;
    s = addGroup(s, ctx, '商品', pid).store;
    const gid = s.groups[0]!.id;
    s = addRule(s, ctx, '列表', '/api/goods', { groupId: gid, projectId: pid }).store;

    const out = reduce(s, { type: 'DELETE_PROJECT', payload: { id: pid } }, ctx);
    expect(out.store.projects).toHaveLength(0);
    // 删项目顺带毁掉几十条规则是很难挽回的操作
    expect(out.store.rules).toHaveLength(1);
    expect(out.store.rules[0]!.projectId).toBeNull();
    expect(out.store.groups[0]!.projectId).toBeNull();
    expect(out.store.activeProjectId).toBeNull();
  });
});

describe('域名作用域', () => {
  it('空 patterns = 不限域名', () => {
    expect(matchHostScope([], { mode: 'include', patterns: [] }, 'anything.com')).toBe(true);
  });

  it('include 模式只在列出的域名下生效', () => {
    const scope = { mode: 'include' as const, patterns: ['glink.jd.com'] };
    expect(matchHostScope([], scope, 'glink.jd.com')).toBe(true);
    expect(matchHostScope([], scope, 'dev2.glink.jd.com')).toBe(true);
    expect(matchHostScope([], scope, 'pay.jd.com')).toBe(false);
  });

  it('exclude 模式反过来', () => {
    const scope = { mode: 'exclude' as const, patterns: ['prod.jd.com'] };
    expect(matchHostScope([], scope, 'prod.jd.com')).toBe(false);
    expect(matchHostScope([], scope, 'dev.jd.com')).toBe(true);
  });

  it('支持 *.example.com 通配，同时也命中裸域', () => {
    const scope = { mode: 'include' as const, patterns: ['*.jdpay.com'] };
    expect(matchHostScope([], scope, 'a.jdpay.com')).toBe(true);
    expect(matchHostScope([], scope, 'dev.a.jdpay.com')).toBe(true);
    expect(matchHostScope([], scope, 'jdpay.com')).toBe(true);
    expect(matchHostScope([], scope, 'jdpay.com.evil.net')).toBe(false);
    expect(matchHostScope([], scope, 'notjdpay.com')).toBe(false);
  });

  it('* 可出现在任意位置，且不跨越点号', () => {
    const s1 = { mode: 'include' as const, patterns: ['*-test.jd.com'] };
    expect(matchHostScope([], s1, 'pay-test.jd.com')).toBe(true);
    expect(matchHostScope([], s1, 'prod.jd.com')).toBe(false);
    // 不跨点：a.b-test 不该被 *-test 匹配上
    expect(matchHostScope([], s1, 'a.b-test.jd.com')).toBe(false);

    const s2 = { mode: 'include' as const, patterns: ['dev*.jdpay.com'] };
    expect(matchHostScope([], s2, 'dev2.jdpay.com')).toBe(true);
    expect(matchHostScope([], s2, 'dev.jdpay.com')).toBe(true);
    expect(matchHostScope([], s2, 'prod.jdpay.com')).toBe(false);
  });

  it('单个 * 匹配所有域名', () => {
    expect(matchHostScope([], { mode: 'include', patterns: ['*'] }, 'anything.com')).toBe(true);
  });

  it('大小写不敏感', () => {
    const scope = { mode: 'include' as const, patterns: ['*.JDPay.com'] };
    expect(matchHostScope([], scope, 'API.jdpay.COM')).toBe(true);
  });

  it('黑名单里的通配同样生效', () => {
    const scope = { mode: 'exclude' as const, patterns: ['*.prod.jd.com'] };
    expect(matchHostScope([], scope, 'a.prod.jd.com')).toBe(false);
    expect(matchHostScope([], scope, 'a.dev.jd.com')).toBe(true);
  });

  it('规则自己的 hosts 非空时覆盖项目设置 —— 允许个别规则开例外', () => {
    const scope = { mode: 'include' as const, patterns: ['glink.jd.com'] };
    expect(matchHostScope(['other.com'], scope, 'other.com')).toBe(true);
    expect(matchHostScope(['other.com'], scope, 'glink.jd.com')).toBe(false);
  });

  it('项目域名参与实际匹配', () => {
    const ctx = makeCtx();
    let s = addProject(createDefaultStore(), ctx, '金链').store;
    const pid = s.projects[0]!.id;
    s = reduce(
      s,
      {
        type: 'UPDATE_PROJECT',
        payload: { id: pid, patch: { hostScope: { mode: 'include', patterns: ['glink.jd.com'] } } },
      },
      ctx,
    ).store;
    s = addRule(s, ctx, '列表', '/api/goods', { projectId: pid }).store;

    expect(findMatchingRule(s, req('/api/goods/list', 'glink.jd.com'))).not.toBeNull();
    expect(findMatchingRule(s, req('/api/goods/list', 'pay.jd.com'))).toBeNull();
  });
});

describe('分组', () => {
  it('TOGGLE_GROUP 是批量启用/停用组内规则，不是独立的组开关', () => {
    const ctx = makeCtx();
    let s = addGroup(createDefaultStore(), ctx, '商品').store;
    const gid = s.groups[0]!.id;
    s = addRule(s, ctx, '列表', '/api/goods', { groupId: gid }).store;
    s = addRule(s, ctx, '详情', '/api/goods/detail', { groupId: gid }).store;
    // 组外的规则不受影响
    s = addRule(s, ctx, '其他', '/api/other').store;

    s = reduce(s, { type: 'TOGGLE_GROUP', payload: { id: gid, enabled: false } }, ctx).store;
    expect(s.rules.filter((r) => r.groupId === gid).every((r) => !r.enabled)).toBe(true);
    expect(s.rules.find((r) => r.name === '其他')!.enabled).toBe(true);
    expect(findMatchingRule(s, req('/api/goods/list'))).toBeNull();

    s = reduce(s, { type: 'TOGGLE_GROUP', payload: { id: gid, enabled: true } }, ctx).store;
    expect(s.rules.filter((r) => r.groupId === gid).every((r) => r.enabled)).toBe(true);
  });

  it('id 传 null 时批量控制「未分组」的规则', () => {
    const ctx = makeCtx();
    let s = addRule(createDefaultStore(), ctx, 'A', '/a').store;
    s = addRule(s, ctx, 'B', '/b').store;

    s = reduce(s, { type: 'TOGGLE_GROUP', payload: { id: null, enabled: false } }, ctx).store;
    expect(s.rules.every((r) => !r.enabled)).toBe(true);
  });

  it('删除分组时组内规则移到未分组', () => {
    const ctx = makeCtx();
    let s = addGroup(createDefaultStore(), ctx, '商品').store;
    const gid = s.groups[0]!.id;
    s = addRule(s, ctx, '列表', '/api/goods', { groupId: gid }).store;

    const out = reduce(s, { type: 'DELETE_GROUP', payload: { id: gid } }, ctx);
    expect(out.store.rules).toHaveLength(1);
    expect(out.store.rules[0]!.groupId).toBeNull();
  });

  it('折叠状态存进数据，刷新后保持', () => {
    const ctx = makeCtx();
    let s = addGroup(createDefaultStore(), ctx, '商品').store;
    expect(s.groups[0]!.collapsed).toBe(false);
    s = reduce(
      s,
      { type: 'UPDATE_GROUP', payload: { id: s.groups[0]!.id, patch: { collapsed: true } } },
      ctx,
    ).store;
    expect(s.groups[0]!.collapsed).toBe(true);
  });

  it('分组换项目时，组内规则的项目归属跟着走', () => {
    const ctx = makeCtx();
    let s = addProject(createDefaultStore(), ctx, 'A').store;
    const pa = s.projects[0]!.id;
    s = addProject(s, ctx, 'B').store;
    const pb = s.projects[1]!.id;
    s = addGroup(s, ctx, '商品', pa).store;
    const gid = s.groups[0]!.id;
    s = addRule(s, ctx, '列表', '/api/goods', { groupId: gid, projectId: pa }).store;

    s = reduce(s, { type: 'UPDATE_GROUP', payload: { id: gid, patch: { projectId: pb } } }, ctx).store;

    // 否则会出现「规则在 B 项目的分组里却标着属于 A 项目」这种自相矛盾的状态
    expect(s.rules[0]!.projectId).toBe(pb);
  });
});

describe('MOVE_RULE', () => {
  it('移进分组时项目自动跟随该分组', () => {
    const ctx = makeCtx();
    let s = addProject(createDefaultStore(), ctx, '项目A').store;
    const pid = s.projects[0]!.id;
    s = addGroup(s, ctx, '商品', pid).store;
    const gid = s.groups[0]!.id;
    s = addRule(s, ctx, '列表', '/api/goods').store; // 未归档

    s = reduce(s, { type: 'MOVE_RULE', payload: { id: s.rules[0]!.id, groupId: gid } }, ctx).store;

    expect(s.rules[0]!.groupId).toBe(gid);
    expect(s.rules[0]!.projectId).toBe(pid);
  });

  it('移出分组（groupId 传 null）', () => {
    const ctx = makeCtx();
    let s = addGroup(createDefaultStore(), ctx, '商品').store;
    const gid = s.groups[0]!.id;
    s = addRule(s, ctx, '列表', '/api/goods', { groupId: gid }).store;

    s = reduce(s, { type: 'MOVE_RULE', payload: { id: s.rules[0]!.id, groupId: null } }, ctx).store;
    expect(s.rules[0]!.groupId).toBeNull();
  });

  it('同时调整顺序 —— 顺序即优先级，归组不能把优先级搞乱', () => {
    const ctx = makeCtx();
    let s = addRule(createDefaultStore(), ctx, 'A', '/a').store;
    s = addRule(s, ctx, 'B', '/b').store;
    s = addRule(s, ctx, 'C', '/c').store;

    s = reduce(
      s,
      { type: 'MOVE_RULE', payload: { id: s.rules[2]!.id, groupId: null, toIndex: 0 } },
      ctx,
    ).store;
    expect(s.rules.map((r) => r.name)).toEqual(['C', 'A', 'B']);
  });

  it('目标分组不存在时拒绝', () => {
    const ctx = makeCtx();
    const s = addRule(createDefaultStore(), ctx, 'A', '/a').store;
    const out = reduce(s, { type: 'MOVE_RULE', payload: { id: s.rules[0]!.id, groupId: 'nope' } }, ctx);
    expect(out.result.ok).toBe(false);
    expect(out.store).toBe(s);
  });
});

describe('响应外壳继承链', () => {
  it('规则未指定时继承分组默认值', () => {
    const ctx = makeCtx();
    let s = addGroup(createDefaultStore(), ctx, '商品').store;
    const gid = s.groups[0]!.id;
    s = reduce(
      s,
      {
        type: 'UPDATE_GROUP',
        payload: { id: gid, patch: { defaultShellTemplateId: 'shell-status-message-data' } },
      },
      ctx,
    ).store;
    s = addRule(s, ctx, '列表', '/api/goods', { groupId: gid }).store;

    const res = buildResponse(s, s.rules[0]!, req('/api/goods'));
    expect(JSON.parse(res.body)).toEqual({ status: 0, message: 'ok', data: {} });
  });

  it('分组没配时继承项目默认值', () => {
    const ctx = makeCtx();
    let s = addProject(createDefaultStore(), ctx, '金链').store;
    const pid = s.projects[0]!.id;
    s = reduce(
      s,
      {
        type: 'UPDATE_PROJECT',
        payload: { id: pid, patch: { defaultShellTemplateId: 'shell-success-result' } },
      },
      ctx,
    ).store;
    s = addRule(s, ctx, '列表', '/api/goods', { projectId: pid }).store;

    const res = buildResponse(s, s.rules[0]!, req('/api/goods'));
    expect(JSON.parse(res.body)).toEqual({ success: true, result: {} });
  });

  it('规则自己指定时优先级最高', () => {
    const ctx = makeCtx();
    let s = addProject(createDefaultStore(), ctx, '金链').store;
    const pid = s.projects[0]!.id;
    s = reduce(
      s,
      {
        type: 'UPDATE_PROJECT',
        payload: { id: pid, patch: { defaultShellTemplateId: 'shell-success-result' } },
      },
      ctx,
    ).store;
    s = reduce(
      s,
      {
        type: 'CREATE_RULE',
        payload: {
          draft: createRuleDraft({
            name: '列表',
            projectId: pid,
            match: { urlMode: 'contains', url: '/api/goods', methods: [], hosts: [] },
            variants: [
              {
                name: '默认',
                response: {
                  status: 200,
                  headers: {},
                  bodyType: 'static',
                  body: '{}',
                  shellTemplateId: 'shell-raw',
                  delayMs: 0,
                },
              },
            ],
          }),
        },
      },
      ctx,
    ).store;

    const res = buildResponse(s, s.rules[0]!, req('/api/goods'));
    expect(res.body).toBe('{}');
  });
});

describe('删除策略（cascade）', () => {
  /** 建一个「项目 → 分组 → 规则」的完整结构 */
  function nested() {
    const ctx = makeCtx();
    let s = addProject(createDefaultStore(), ctx, '项目A').store;
    const pid = s.projects[0]!.id;
    s = addGroup(s, ctx, '商品', pid).store;
    const gid = s.groups[0]!.id;
    s = addRule(s, ctx, '组内1', '/a', { groupId: gid, projectId: pid }).store;
    s = addRule(s, ctx, '组内2', '/b', { groupId: gid, projectId: pid }).store;
    s = addRule(s, ctx, '项目内未分组', '/c', { projectId: pid }).store;
    s = addRule(s, ctx, '完全无关', '/d').store;
    return { store: s, ctx, pid, gid };
  }

  it('删分组 · detach：规则移到未分组', () => {
    const { store, ctx, gid } = nested();
    const out = reduce(store, { type: 'DELETE_GROUP', payload: { id: gid, cascade: 'detach' } }, ctx);
    expect(out.store.groups).toHaveLength(0);
    expect(out.store.rules).toHaveLength(4);
    expect(out.store.rules.filter((r) => r.groupId === null)).toHaveLength(4);
  });

  it('删分组 · cascade：组内规则一并删除，组外不受影响', () => {
    const { store, ctx, gid } = nested();
    const out = reduce(store, { type: 'DELETE_GROUP', payload: { id: gid, cascade: 'cascade' } }, ctx);
    expect(out.store.groups).toHaveLength(0);
    expect(out.store.rules.map((r) => r.name)).toEqual(['项目内未分组', '完全无关']);
  });

  it('删项目 · detach：分组与规则降级为全局/未归档', () => {
    const { store, ctx, pid } = nested();
    const out = reduce(store, { type: 'DELETE_PROJECT', payload: { id: pid, cascade: 'detach' } }, ctx);
    expect(out.store.projects).toHaveLength(0);
    expect(out.store.groups).toHaveLength(1);
    expect(out.store.groups[0]!.projectId).toBeNull();
    expect(out.store.rules).toHaveLength(4);
    expect(out.store.rules.every((r) => r.projectId === null)).toBe(true);
  });

  it('删项目 · cascade：项目下的分组与规则全部删除', () => {
    const { store, ctx, pid } = nested();
    const out = reduce(store, { type: 'DELETE_PROJECT', payload: { id: pid, cascade: 'cascade' } }, ctx);
    expect(out.store.projects).toHaveLength(0);
    expect(out.store.groups).toHaveLength(0);
    // 只剩项目外那条
    expect(out.store.rules.map((r) => r.name)).toEqual(['完全无关']);
  });

  it('不传 cascade 时按 detach 处理 —— 保守的默认值', () => {
    const { store, ctx, gid } = nested();
    const out = reduce(store, { type: 'DELETE_GROUP', payload: { id: gid } }, ctx);
    expect(out.store.rules).toHaveLength(4);
  });

  it('删项目时会清空 activeProjectId，避免指向已不存在的项目', () => {
    const { store, ctx, pid } = nested();
    expect(store.activeProjectId).toBe(pid);
    const out = reduce(store, { type: 'DELETE_PROJECT', payload: { id: pid, cascade: 'cascade' } }, ctx);
    expect(out.store.activeProjectId).toBeNull();
  });
});

describe('批量操作', () => {
  function threeRules() {
    const ctx = makeCtx();
    let s = addGroup(createDefaultStore(), ctx, '商品').store;
    const gid = s.groups[0]!.id;
    s = addRule(s, ctx, 'A', '/a').store;
    s = addRule(s, ctx, 'B', '/b').store;
    s = addRule(s, ctx, 'C', '/c').store;
    return { store: s, ctx, gid, ids: s.rules.map((r) => r.id) };
  }

  it('DELETE_RULES 一次删除多条', () => {
    const { store, ctx, ids } = threeRules();
    const out = reduce(store, { type: 'DELETE_RULES', payload: { ids: [ids[0]!, ids[2]!] } }, ctx);
    expect(out.result.ok).toBe(true);
    expect(out.store.rules.map((r) => r.name)).toEqual(['B']);
  });

  it('空选中时拒绝，避免误触发一次无意义的写入', () => {
    const { store, ctx } = threeRules();
    const out = reduce(store, { type: 'DELETE_RULES', payload: { ids: [] } }, ctx);
    expect(out.result.ok).toBe(false);
    expect(out.store).toBe(store);
  });

  it('全部 id 都不存在时拒绝', () => {
    const { store, ctx } = threeRules();
    const out = reduce(store, { type: 'DELETE_RULES', payload: { ids: ['x', 'y'] } }, ctx);
    expect(out.result.ok).toBe(false);
  });

  it('TOGGLE_RULES 批量启停，未选中的不受影响', () => {
    const { store, ctx, ids } = threeRules();
    const out = reduce(
      store,
      { type: 'TOGGLE_RULES', payload: { ids: [ids[0]!, ids[1]!], enabled: false } },
      ctx,
    );
    expect(out.store.rules[0]!.enabled).toBe(false);
    expect(out.store.rules[1]!.enabled).toBe(false);
    expect(out.store.rules[2]!.enabled).toBe(true);
  });

  it('MOVE_RULES 批量归组，项目跟随分组', () => {
    const ctx = makeCtx();
    let s = addProject(createDefaultStore(), ctx, '项目A').store;
    const pid = s.projects[0]!.id;
    s = addGroup(s, ctx, '商品', pid).store;
    const gid = s.groups[0]!.id;
    s = addRule(s, ctx, 'A', '/a').store;
    s = addRule(s, ctx, 'B', '/b').store;
    const ids = s.rules.map((r) => r.id);

    const out = reduce(s, { type: 'MOVE_RULES', payload: { ids, groupId: gid } }, ctx);
    expect(out.store.rules.every((r) => r.groupId === gid)).toBe(true);
    // 与单条 MOVE_RULE 保持一致：项目跟随分组，避免归属自相矛盾
    expect(out.store.rules.every((r) => r.projectId === pid)).toBe(true);
  });

  it('MOVE_RULES 目标分组不存在时拒绝', () => {
    const { store, ctx, ids } = threeRules();
    const out = reduce(store, { type: 'MOVE_RULES', payload: { ids, groupId: 'nope' } }, ctx);
    expect(out.result.ok).toBe(false);
    expect(out.store).toBe(store);
  });
});

