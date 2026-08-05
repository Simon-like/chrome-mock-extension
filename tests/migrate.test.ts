/**
 * v1 → v2 迁移测试
 *
 * 这是最容易丢数据的地方：Rule.response 移进 Variant 是破坏性结构变更。
 * 用户本机还留着在用的规则，迁移必须无损。
 */

import { describe, expect, it } from 'vitest';
import { migrate } from '../src/core/store/migrate.js';
import { CURRENT_SCHEMA_VERSION } from '../src/core/types.js';

let n = 0;
const id = () => `mig-${++n}`;

/** 一份典型的 v1 数据 */
function v1Store() {
  return {
    schemaVersion: 1,
    enabled: true,
    rules: [
      {
        id: 'r1',
        name: '商品列表',
        enabled: true,
        groupId: 'g1',
        kind: 'override',
        match: { urlMode: 'contains', url: '/api/goods', methods: ['GET'], hosts: ['a.com'] },
        response: {
          status: 200,
          headers: { 'x-test': '1' },
          bodyType: 'static',
          body: '{"list":[1,2]}',
          shellTemplateId: 'shell-raw',
          delayMs: 300,
        },
        meta: {
          createdAt: 1000,
          updatedAt: 2000,
          source: 'capture',
          hitCount: 7,
          lastHitAt: 3000,
        },
      },
    ],
    groups: [
      { id: 'g1', name: '商品模块', enabled: true, exclusive: false, defaultShellTemplateId: null },
      { id: 'g2', name: '全空态', enabled: true, exclusive: true, defaultShellTemplateId: null },
    ],
    shellTemplates: [],
    settings: { captureEnabled: true, captureMaxCount: 200 },
  };
}

describe('v1 → v2 迁移', () => {
  it('response 被包成「默认」变体，内容一字不差', () => {
    const { store, reset } = migrate(v1Store(), id);
    expect(reset).toBe(false);

    const rule = store.rules[0]!;
    expect(rule.variants).toHaveLength(1);

    const v = rule.variants[0]!;
    expect(v.name).toBe('默认');
    expect(v.response).toMatchObject({
      status: 200,
      headers: { 'x-test': '1' },
      body: '{"list":[1,2]}',
      shellTemplateId: 'shell-raw',
      delayMs: 300,
    });
    // activeVariantId 必须指向真实存在的变体
    expect(rule.activeVariantId).toBe(v.id);
  });

  it('规则的其余字段完整保留，统计不清零', () => {
    const { store } = migrate(v1Store(), id);
    const rule = store.rules[0]!;
    expect(rule.id).toBe('r1');
    expect(rule.name).toBe('商品列表');
    expect(rule.groupId).toBe('g1');
    expect(rule.match.hosts).toEqual(['a.com']);
    expect(rule.meta.hitCount).toBe(7);
    expect(rule.meta.source).toBe('capture');
  });

  it('分组保留，exclusive 字段被移除并降级为普通分组', () => {
    const { store } = migrate(v1Store(), id);
    expect(store.groups).toHaveLength(2);
    expect(store.groups.every((g) => !('exclusive' in g))).toBe(true);
    // 原互斥组仍然存在，只是变成普通组
    expect(store.groups.find((g) => g.name === '全空态')).toBeDefined();
  });

  it('互斥组转普通组时给出提示', () => {
    const { notices } = migrate(v1Store(), id);
    expect(notices.some((t) => t.includes('互斥分组'))).toBe(true);
    expect(notices.some((t) => t.includes('变体'))).toBe(true);
  });

  it('不自动创建项目 —— 规则保持未归档，由用户自行整理', () => {
    const { store } = migrate(v1Store(), id);
    expect(store.projects).toEqual([]);
    expect(store.rules[0]!.projectId).toBeNull();
    expect(store.groups.every((g) => g.projectId === null)).toBe(true);
  });

  it('版本号升到 v2', () => {
    const { store } = migrate(v1Store(), id);
    expect(store.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(store.schemaVersion).toBe(2);
  });

  it('缺 schemaVersion 的数据按 v1 处理（早期版本没写这个字段）', () => {
    const raw = v1Store() as Record<string, unknown>;
    delete raw.schemaVersion;
    const { store, reset } = migrate(raw, id);
    expect(reset).toBe(false);
    expect(store.rules[0]!.variants).toHaveLength(1);
  });
});

describe('结构自愈', () => {
  it('无数据时返回默认配置', () => {
    const { store, reset } = migrate(undefined, id);
    expect(reset).toBe(true);
    expect(store.rules).toEqual([]);
    expect(store.settings.pageSize).toBe(15);
  });

  it('变体为空数组时补一个默认变体 —— 空变体的规则是无效状态', () => {
    const { store } = migrate(
      {
        schemaVersion: 2,
        rules: [{ id: 'r1', name: 'x', match: {}, variants: [] }],
      },
      id,
    );
    expect(store.rules[0]!.variants).toHaveLength(1);
    expect(store.rules[0]!.activeVariantId).toBe(store.rules[0]!.variants[0]!.id);
  });

  it('activeVariantId 指向不存在的变体时回落到第一个', () => {
    const { store } = migrate(
      {
        schemaVersion: 2,
        rules: [
          {
            id: 'r1',
            name: 'x',
            match: {},
            variants: [{ id: 'v1', name: 'A', response: {} }],
            activeVariantId: '不存在的id',
          },
        ],
      },
      id,
    );
    expect(store.rules[0]!.activeVariantId).toBe('v1');
  });

  it('body 被写成对象时转回字符串（AI 生成的规则常犯）', () => {
    const { store } = migrate(
      {
        schemaVersion: 2,
        rules: [
          {
            id: 'r1',
            name: 'x',
            match: {},
            variants: [{ id: 'v1', name: 'A', response: { body: { list: [] } } }],
          },
        ],
      },
      id,
    );
    const body = store.rules[0]!.variants[0]!.response.body;
    expect(typeof body).toBe('string');
    expect(JSON.parse(body)).toEqual({ list: [] });
  });

  it('只给 response 不给 variants 时自动包装（AI 常按旧 Schema 生成）', () => {
    const { store } = migrate(
      {
        schemaVersion: 2,
        rules: [{ id: 'r1', name: 'x', match: {}, response: { status: 404, body: '{}' } }],
      },
      id,
    );
    expect(store.rules[0]!.variants).toHaveLength(1);
    expect(store.rules[0]!.variants[0]!.response.status).toBe(404);
  });

  it('项目 hostScope 缺失时默认不限域名', () => {
    const { store } = migrate(
      { schemaVersion: 2, projects: [{ id: 'p1', name: '项目' }], rules: [] },
      id,
    );
    expect(store.projects[0]!.hostScope.patterns).toEqual([]);
    expect(store.projects[0]!.hostScope.mode).toBe('include');
  });

  it('丢弃没有 id 的脏数据', () => {
    const { store } = migrate(
      {
        schemaVersion: 2,
        rules: [{ name: '没有id', match: {} }, { id: 'r1', name: '正常', match: {} }],
        groups: [{ name: '没有id' }],
        projects: [{ name: '没有id' }],
      },
      id,
    );
    expect(store.rules).toHaveLength(1);
    expect(store.groups).toHaveLength(0);
    expect(store.projects).toHaveLength(0);
  });

  it('内置外壳模板始终以代码为准，用户自定义的保留', () => {
    const { store } = migrate(
      {
        schemaVersion: 2,
        rules: [],
        shellTemplates: [
          { id: 'shell-raw', name: '被改坏的', builtin: true, template: 'BAD' },
          { id: 'mine', name: '风控层格式', builtin: false, template: '{"d":__DATA__}' },
        ],
      },
      id,
    );
    expect(store.shellTemplates.find((t) => t.id === 'shell-raw')!.template).toBe('__DATA__');
    expect(store.shellTemplates.find((t) => t.id === 'mine')).toBeDefined();
  });

  it('来自更高版本的数据不敢降级处理，走重置', () => {
    const { reset, reason } = migrate({ schemaVersion: 999, rules: [] }, id);
    expect(reset).toBe(true);
    expect(reason).toContain('999');
  });
});
