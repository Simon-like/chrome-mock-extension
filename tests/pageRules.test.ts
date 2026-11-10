import { describe, expect, it } from 'vitest';
import { createDefaultStore, createRuleDraft, materializeRule } from '../src/core/store/defaults.js';
import { selectPageRules } from '../src/core/store/pageRules.js';

function buildStore() {
  let index = 0;
  const id = () => `id-${++index}`;
  const store = createDefaultStore();
  store.projects.push(
    {
      id: 'project-a',
      name: 'A',
      hostScope: { mode: 'include', patterns: ['a.test'] },
      defaultShellTemplateId: null,
    },
    {
      id: 'project-b',
      name: 'B',
      hostScope: { mode: 'include', patterns: ['b.test'] },
      defaultShellTemplateId: null,
    },
  );
  store.rules.push(
    materializeRule(createRuleDraft({ name: '全局历史', enabled: true }), id),
    materializeRule(createRuleDraft({ name: 'A 项目', projectId: 'project-a' }), id),
    materializeRule(createRuleDraft({ name: 'B 项目', projectId: 'project-b' }), id),
    materializeRule(
      createRuleDraft({
        name: '规则级域名',
        match: { urlMode: 'contains', url: '/x', methods: [], hosts: ['a.test'] },
      }),
      id,
    ),
  );
  return store;
}

describe('selectPageRules', () => {
  it('展示当前域名作用域规则，隐藏无命中的全局历史', () => {
    const store = buildStore();
    const result = selectPageRules(store, 'a.test', []);
    expect(result.rules.map((rule) => rule.name)).toEqual(['A 项目', '规则级域名']);
    expect(result.hiddenGlobalCount).toBe(1);
    expect(result.hiddenGlobalEnabledCount).toBe(1);
  });

  it('当前标签页命中的全局规则置顶', () => {
    const store = buildStore();
    const global = store.rules.find((rule) => rule.name === '全局历史')!;
    const result = selectPageRules(store, 'a.test', [global.id]);
    expect(result.rules.map((rule) => rule.name)).toEqual(['全局历史', 'A 项目', '规则级域名']);
    expect(result.hiddenGlobalCount).toBe(0);
  });

  it('命中顺序按当前页最近请求顺序排列', () => {
    const store = buildStore();
    const scoped = store.rules.filter((rule) => rule.name.includes('项目'));
    const result = selectPageRules(store, 'a.test', [scoped[1]!.id, scoped[0]!.id]);
    expect(result.rules.slice(0, 2).map((rule) => rule.name)).toEqual(['B 项目', 'A 项目']);
  });
});
