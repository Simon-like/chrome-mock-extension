/**
 * matcher 测试
 *
 * 为什么这个模块值得重点测（设计文档 05 §10.1）：
 * 三种匹配模式 × 边界情况组合很多；它跑在用户每个请求上，错了就是整站异常；
 * 纯函数，测试成本极低。投入产出比最高的测试。
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearBannedPatterns,
  clearMatcherCache,
  findMatchingRule,
  getBannedPatterns,
  matchHost,
  matchUrl,
  testWildcard,
} from '../src/core/engine/matcher.js';
import { normalizeRequest } from '../src/core/engine/normalize.js';
import { createDefaultStore, createRuleDraft, materializeRule } from '../src/core/store/defaults.js';
import type { MatchCondition, MockStore, Rule, RuleDraft } from '../src/core/types.js';

let seq = 0;
const nextId = () => `rule-${++seq}`;

function makeRule(partial: Partial<RuleDraft>): Rule {
  return materializeRule(createRuleDraft(partial), nextId, 1_700_000_000_000);
}

function storeWith(rules: Rule[]): MockStore {
  return { ...createDefaultStore(), rules };
}

function req(url: string, method = 'GET') {
  return normalizeRequest(url, method, 'https://example.com/');
}

beforeEach(() => {
  clearMatcherCache();
  clearBannedPatterns();
});

describe('matchUrl · contains', () => {
  const m = (url: string): MatchCondition => ({
    urlMode: 'contains',
    url,
    methods: [],
    hosts: [],
  });

  it('命中子串', () => {
    expect(matchUrl(m('/api/goods'), 'https://a.com/api/goods/list')).toBe(true);
  });

  it('不含则不命中', () => {
    expect(matchUrl(m('/api/user'), 'https://a.com/api/goods/list')).toBe(false);
  });

  it('大小写敏感', () => {
    expect(matchUrl(m('/API'), 'https://a.com/api/x')).toBe(false);
  });

  it('空匹配条件不命中任何请求（避免误伤全站）', () => {
    expect(matchUrl(m(''), 'https://a.com/api/x')).toBe(false);
  });

  it('能匹配 query 部分', () => {
    expect(matchUrl(m('page=2'), 'https://a.com/api/x?page=2')).toBe(true);
  });
});

describe('matchUrl · wildcard', () => {
  const m = (url: string): MatchCondition => ({
    urlMode: 'wildcard',
    url,
    methods: [],
    hosts: [],
  });

  it('* 匹配任意字符', () => {
    expect(matchUrl(m('/api/*/list'), 'https://a.com/api/goods/list')).toBe(true);
  });

  it('* 可跨路径段', () => {
    expect(matchUrl(m('/api/*/list'), 'https://a.com/api/v1/goods/list')).toBe(true);
  });

  it('正则元字符被转义，不当作正则解释', () => {
    // 点号应当是字面量，不是「任意字符」
    expect(testWildcard('/api/a.b', '/api/aXb')).toBe(false);
    expect(testWildcard('/api/a.b', '/api/a.b')).toBe(true);
  });

  it('括号等元字符不会导致崩溃', () => {
    expect(() => testWildcard('/api/(x', '/api/(x')).not.toThrow();
    expect(testWildcard('/api/(x', '/api/(x')).toBe(true);
  });

  it('纯 * 匹配一切', () => {
    expect(matchUrl(m('*'), 'https://a.com/anything')).toBe(true);
  });
});

describe('matchUrl · regex', () => {
  const m = (url: string): MatchCondition => ({
    urlMode: 'regex',
    url,
    methods: [],
    hosts: [],
  });

  it('基本正则', () => {
    expect(matchUrl(m('/api/goods/\\d+'), 'https://a.com/api/goods/123')).toBe(true);
  });

  it('非法正则不抛异常，视为不匹配', () => {
    // 关键：不 catch 的话整个 hook 崩溃，页面所有请求全挂
    expect(() => matchUrl(m('[invalid'), 'https://a.com/x')).not.toThrow();
    expect(matchUrl(m('[invalid'), 'https://a.com/x')).toBe(false);
  });

  it('锚定符可用', () => {
    expect(matchUrl(m('^https://a\\.com/api'), 'https://a.com/api/x')).toBe(true);
    expect(matchUrl(m('^https://b\\.com/api'), 'https://a.com/api/x')).toBe(false);
  });
});

describe('matchHost', () => {
  it('空数组表示不限制', () => {
    expect(matchHost([], 'a.com')).toBe(true);
  });

  it('精确匹配', () => {
    expect(matchHost(['a.com'], 'a.com')).toBe(true);
    expect(matchHost(['a.com'], 'b.com')).toBe(false);
  });

  it('匹配子域名', () => {
    expect(matchHost(['a.com'], 'api.a.com')).toBe(true);
  });

  it('不会把 xxa.com 误判为 a.com 的子域', () => {
    expect(matchHost(['a.com'], 'xxa.com')).toBe(false);
  });
});

describe('findMatchingRule', () => {
  it('总开关关闭时不匹配任何规则', () => {
    const store = { ...storeWith([makeRule({ match: { urlMode: 'contains', url: '/api', methods: [], hosts: [] } })]), enabled: false };
    expect(findMatchingRule(store, req('https://a.com/api/x'))).toBeNull();
  });

  it('禁用的规则被跳过', () => {
    const store = storeWith([
      makeRule({ enabled: false, match: { urlMode: 'contains', url: '/api', methods: [], hosts: [] } }),
    ]);
    expect(findMatchingRule(store, req('https://a.com/api/x'))).toBeNull();
  });

  it('先到先得：返回第一条匹配的规则', () => {
    const first = makeRule({ name: '第一条', match: { urlMode: 'contains', url: '/api', methods: [], hosts: [] } });
    const second = makeRule({ name: '第二条', match: { urlMode: 'contains', url: '/api/goods', methods: [], hosts: [] } });
    const store = storeWith([first, second]);
    const hit = findMatchingRule(store, req('https://a.com/api/goods'));
    expect(hit?.rule.name).toBe('第一条');
    expect(hit?.index).toBe(0);
  });

  it('method 过滤生效', () => {
    const store = storeWith([
      makeRule({ match: { urlMode: 'contains', url: '/api', methods: ['POST'], hosts: [] } }),
    ]);
    expect(findMatchingRule(store, req('https://a.com/api/x', 'GET'))).toBeNull();
    expect(findMatchingRule(store, req('https://a.com/api/x', 'POST'))).not.toBeNull();
  });

  it('空 methods 数组匹配所有 method', () => {
    const store = storeWith([
      makeRule({ match: { urlMode: 'contains', url: '/api', methods: [], hosts: [] } }),
    ]);
    expect(findMatchingRule(store, req('https://a.com/api/x', 'DELETE'))).not.toBeNull();
  });

  it('分组禁用时组内规则失效', () => {
    const rule = makeRule({ groupId: 'g1', match: { urlMode: 'contains', url: '/api', methods: [], hosts: [] } });
    const store: MockStore = {
      ...storeWith([rule]),
      groups: [
        {
          id: 'g1',
          name: '组',
          enabled: false,
          projectId: null,
          collapsed: false,
          defaultShellTemplateId: null,
        },
      ],
    };
    expect(findMatchingRule(store, req('https://a.com/api/x'))).toBeNull();
  });
});

describe('ReDoS 防护', () => {
  const m = (url: string): MatchCondition => ({
    urlMode: 'regex',
    url,
    methods: [],
    hosts: [],
  });

  it('嵌套量词在【第一次】就被拦下，不会执行', () => {
    // 经典灾难性回溯：(a+)+$ 遇到长串 a 后跟非 a。
    // 实测这个正则匹配 30 个 a 需要约 42 秒 —— 必须事前拦截，
    // 靠事后测耗时的话用户页面已经卡死了。
    const evil = '(a+)+$';
    const target = 'a'.repeat(40) + 'X';

    const started = Date.now();
    expect(matchUrl(m(evil), target)).toBe(false);
    const elapsed = Date.now() - started;

    // 关键断言：必须立即返回，而不是跑完再说
    expect(elapsed).toBeLessThan(100);
    expect(getBannedPatterns()).toContain(evil);
  });

  it('其他危险形态同样被拦', () => {
    for (const evil of ['(a*)*', '(\\d+)*$', '([a-z]+)+']) {
      clearBannedPatterns();
      const started = Date.now();
      matchUrl(m(evil), 'a'.repeat(40) + '!');
      expect(Date.now() - started).toBeLessThan(100);
      expect(getBannedPatterns()).toContain(evil);
    }
  });

  it('正常正则不受影响', () => {
    expect(matchUrl(m('/api/goods/\\d+'), 'https://a.com/api/goods/123')).toBe(true);
    expect(getBannedPatterns()).toHaveLength(0);
  });

  it('超长 URL 被截断，防止回溯耗时随长度爆炸', () => {
    // 这个正则不含嵌套量词，会真正执行；靠截断封顶最坏耗时
    const longUrl = 'https://a.com/' + 'x'.repeat(50_000);
    const started = Date.now();
    expect(() => matchUrl(m('x+$'), longUrl)).not.toThrow();
    expect(Date.now() - started).toBeLessThan(100);
  });
});

describe('normalizeRequest', () => {
  it('相对路径解析为绝对 URL', () => {
    const r = normalizeRequest('/api/x', 'get', 'https://a.com/page');
    expect(r.url).toBe('https://a.com/api/x');
    expect(r.method).toBe('GET');
    expect(r.host).toBe('a.com');
  });

  it('非法 method 降级为 GET', () => {
    expect(normalizeRequest('/x', 'FOO', 'https://a.com/').method).toBe('GET');
  });

  it('无法解析的 URL 不抛异常', () => {
    expect(() => normalizeRequest('::::', 'GET', 'not-a-url')).not.toThrow();
  });

  it('保留端口号', () => {
    const r = normalizeRequest('http://a.com:8080/x', 'GET', 'https://b.com/');
    expect(r.host).toBe('a.com:8080');
  });
});
