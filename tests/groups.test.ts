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

  it('删除项目时其下分组与规则不删除，降级为全局/未归档', () => {
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

  it('支持 *.example.com 通配', () => {
    const scope = { mode: 'include' as const, patterns: ['*.jd.com'] };
    expect(matchHostScope([], scope, 'a.jd.com')).toBe(true);
    expect(matchHostScope([], scope, 'jd.com')).toBe(true);
    expect(matchHostScope([], scope, 'jd.com.evil.net')).toBe(false);
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
  it('组关闭时组内规则不参与匹配', () => {
    const ctx = makeCtx();
    let s = addGroup(createDefaultStore(), ctx, '商品').store;
    const gid = s.groups[0]!.id;
    s = addRule(s, ctx, '列表', '/api/goods', { groupId: gid }).store;

    expect(findMatchingRule(s, req('/api/goods/list'))).not.toBeNull();
    s = reduce(s, { type: 'TOGGLE_GROUP', payload: { id: gid, enabled: false } }, ctx).store;
    expect(findMatchingRule(s, req('/api/goods/list'))).toBeNull();
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
