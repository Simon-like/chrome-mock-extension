import { describe, expect, it } from 'vitest';
import { createDefaultStore, createRuleDraft, materializeRule } from '../src/core/store/defaults.js';
import {
  deriveGroupName,
  findProjectByHosts,
  hostFromPageUrl,
  organizeLegacyRules,
} from '../src/core/store/organize.js';

function ids() {
  let index = 0;
  return () => `generated-${++index}`;
}

describe('deriveGroupName', () => {
  it('跳过网关与版本前缀，选择第一个业务路径段', () => {
    expect(deriveGroupName('/gateway/api/jinying/requirement/query')).toBe('jinying');
    expect(deriveGroupName('/api/gw2/generic/jkActivity/newh5/m/query')).toBe('jkActivity');
  });

  it('无法识别业务路径时回落到其他接口', () => {
    expect(deriveGroupName('/api/v2')).toBe('其他接口');
  });
});

describe('organizeLegacyRules', () => {
  it('按 hosts 创建项目并按 URL 创建分组', () => {
    const id = ids();
    const base = createDefaultStore();
    base.rules.push(
      materializeRule(
        createRuleDraft({
          name: '活动查询',
          match: {
            urlMode: 'contains',
            url: '/gateway/api/jinying/requirement/query',
            methods: ['POST'],
            hosts: ['IDT.JD.COM'],
          },
        }),
        id,
      ),
    );

    const result = organizeLegacyRules(base, id);
    expect(result.createdProjectCount).toBe(1);
    expect(result.createdGroupCount).toBe(1);
    expect(result.store.projects[0]).toMatchObject({
      name: 'idt.jd.com',
      hostScope: { mode: 'include', patterns: ['idt.jd.com'] },
    });
    expect(result.store.groups[0]!.name).toBe('jinying');
    expect(result.store.rules[0]).toMatchObject({
      projectId: result.store.projects[0]!.id,
      groupId: result.store.groups[0]!.id,
    });
  });

  it('复用相同域名项目与业务分组', () => {
    const id = ids();
    const base = createDefaultStore();
    for (const url of ['/api/orders/list', '/gateway/orders/detail']) {
      base.rules.push(
        materializeRule(
          createRuleDraft({
            name: url,
            match: { urlMode: 'contains', url, methods: [], hosts: ['shop.test'] },
          }),
          id,
        ),
      );
    }

    const result = organizeLegacyRules(base, id);
    expect(result.store.projects).toHaveLength(1);
    expect(result.store.groups).toHaveLength(1);
    expect(new Set(result.store.rules.map((rule) => rule.groupId)).size).toBe(1);
    expect(findProjectByHosts(result.store, ['SHOP.TEST'])?.id).toBe(result.store.projects[0]!.id);
  });

  it('没有 hosts 时只建全局分组，不猜项目', () => {
    const id = ids();
    const base = createDefaultStore();
    base.rules.push(
      materializeRule(
        createRuleDraft({
          match: { urlMode: 'contains', url: '/api/benefits/list', methods: [], hosts: [] },
        }),
        id,
      ),
    );

    const result = organizeLegacyRules(base, id);
    expect(result.store.projects).toEqual([]);
    expect(result.store.groups[0]).toMatchObject({ name: 'benefits', projectId: null });
    expect(result.store.rules[0]!.projectId).toBeNull();
  });

  it('保留已有分组归属', () => {
    const id = ids();
    const base = createDefaultStore();
    base.groups.push({
      id: 'manual-group',
      name: '人工分组',
      projectId: null,
      collapsed: false,
      defaultShellTemplateId: null,
    });
    base.rules.push(materializeRule(createRuleDraft({ groupId: 'manual-group' }), id));

    const result = organizeLegacyRules(base, id);
    expect(result.organizedRuleCount).toBe(0);
    expect(result.store.rules[0]!.groupId).toBe('manual-group');
  });
});

describe('hostFromPageUrl', () => {
  it('只接受 http(s) 活动页', () => {
    expect(hostFromPageUrl('https://IDT.JD.COM/path')).toBe('idt.jd.com');
    expect(hostFromPageUrl('chrome://extensions')).toBeNull();
  });
});
