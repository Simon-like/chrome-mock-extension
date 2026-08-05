import { describe, expect, it } from 'vitest';
import { buildResponse } from '../src/core/engine/responder.js';
import { applyShell, detectShell } from '../src/core/engine/shell.js';
import { captureToRuleDraft } from '../src/core/capture/toRule.js';
import { migrate } from '../src/core/store/migrate.js';
import {
  BUILTIN_SHELL_TEMPLATES,
  createDefaultStore,
  createRuleDraft,
  materializeRule,
} from '../src/core/store/defaults.js';
import { normalizeRequest } from '../src/core/engine/normalize.js';
import type { MockStore, RuleDraft } from '../src/core/types.js';

const req = normalizeRequest('/api/x', 'GET', 'https://a.com/');

function ruleOf(partial: Partial<RuleDraft>) {
  return materializeRule(createRuleDraft(partial), () => 'r1', 1);
}

describe('buildResponse', () => {
  const store = createDefaultStore();

  it('返回纯数据而非 Response 对象（core 不依赖浏览器 API）', () => {
    const rule = ruleOf({ response: { ...createRuleDraft().response, body: '{"a":1}' } });
    const res = buildResponse(store, rule, req);
    expect(res).toEqual({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
      delayMs: 0,
      behavior: 'normal',
    });
  });

  it('非法状态码降级为 200，而不是抛异常', () => {
    const rule = ruleOf({ response: { ...createRuleDraft().response, status: 99 } });
    expect(buildResponse(store, rule, req).status).toBe(200);
  });

  it('header 名统一小写，避免 Content-Type 重复设置', () => {
    const rule = ruleOf({
      response: { ...createRuleDraft().response, headers: { 'Content-Type': 'text/plain' } },
    });
    const res = buildResponse(store, rule, req);
    expect(res.headers['content-type']).toBe('text/plain');
    expect(Object.keys(res.headers)).toHaveLength(1);
  });

  it('套用响应外壳', () => {
    const rule = ruleOf({
      response: {
        ...createRuleDraft().response,
        body: '[1,2]',
        shellTemplateId: 'shell-status-message-data',
      },
    });
    const res = buildResponse(store, rule, req);
    expect(res.body).toBe('{"status":0,"message":"ok","data":[1,2]}');
  });

  it('shellTemplateId 指向不存在的模板时不套壳，不崩溃', () => {
    const rule = ruleOf({
      response: { ...createRuleDraft().response, body: '{"a":1}', shellTemplateId: 'nope' },
    });
    expect(buildResponse(store, rule, req).body).toBe('{"a":1}');
  });
});

describe('applyShell', () => {
  it('大整数不丢精度（这是 body 存字符串的核心理由）', () => {
    const big = '{"id":12345678901234567890}';
    const out = applyShell('{"data":__DATA__}', big);
    expect(out).toContain('12345678901234567890');
  });

  it('多个占位符都替换', () => {
    expect(applyShell('{"a":__DATA__,"b":__DATA__}', '1')).toBe('{"a":1,"b":1}');
  });

  it('模板无占位符时返回模板本身（固定响应）', () => {
    expect(applyShell('{"fixed":true}', '{"ignored":1}')).toBe('{"fixed":true}');
  });
});

describe('detectShell', () => {
  it('识别出 status/message/data 外壳并挑出 data 部分', () => {
    const body = '{"status":0,"message":"ok","data":{"list":[1,2]}}';
    const got = detectShell(BUILTIN_SHELL_TEMPLATES, body);
    expect(got?.template.id).toBe('shell-status-message-data');
    expect(JSON.parse(got!.data)).toEqual({ list: [1, 2] });
  });

  it('键不完全一致时不误判', () => {
    const body = '{"status":0,"data":{},"extra":1}';
    const got = detectShell(BUILTIN_SHELL_TEMPLATES, body);
    expect(got?.template.id).not.toBe('shell-status-message-data');
  });

  it('非 JSON 返回 null 而不抛异常', () => {
    expect(detectShell(BUILTIN_SHELL_TEMPLATES, '<html>')).toBeNull();
  });
});

describe('captureToRuleDraft（F6 核心）', () => {
  it('默认丢弃 query，只用 pathname 匹配', () => {
    // 关键行为：带 ?page=1&t=169... 的话，用户翻页规则就失效了
    const draft = captureToRuleDraft({
      url: 'https://a.com/api/goods/list?page=1&t=1690000000',
      method: 'GET',
      status: 200,
      body: '{"list":[]}',
    });
    expect(draft.match.url).toBe('/api/goods/list');
    expect(draft.match.url).not.toContain('page');
  });

  it('抓包来源一定是覆盖式', () => {
    const draft = captureToRuleDraft({ url: 'https://a.com/api/x', method: 'GET', status: 200, body: '{}' });
    expect(draft.kind).toBe('override');
    expect(draft.meta?.source).toBe('capture');
  });

  it('限定 host，避免规则误伤其他域名', () => {
    const draft = captureToRuleDraft({ url: 'https://a.com/api/x', method: 'POST', status: 201, body: '{}' });
    expect(draft.match.hosts).toEqual(['a.com']);
    expect(draft.match.methods).toEqual(['POST']);
    expect(draft.response.status).toBe(201);
  });

  it('自动识别外壳，body 里只留业务数据', () => {
    const draft = captureToRuleDraft(
      {
        url: 'https://a.com/api/goods/list',
        method: 'GET',
        status: 200,
        body: '{"status":0,"message":"ok","data":{"list":[1]}}',
      },
      BUILTIN_SHELL_TEMPLATES,
    );
    expect(draft.response.shellTemplateId).toBe('shell-status-message-data');
    expect(JSON.parse(draft.response.body)).toEqual({ list: [1] });
  });

  it('响应体是 HTML 等非 JSON 时原样保留', () => {
    const draft = captureToRuleDraft({
      url: 'https://a.com/page',
      method: 'GET',
      status: 200,
      body: '<html>hi</html>',
    });
    expect(draft.response.body).toBe('<html>hi</html>');
  });

  it('无法解析的 URL 不崩溃', () => {
    expect(() =>
      captureToRuleDraft({ url: 'not a url', method: 'GET', status: 200, body: '{}' }),
    ).not.toThrow();
  });
});

describe('migrate', () => {
  it('无数据时返回默认配置', () => {
    const { store, reset } = migrate(undefined);
    expect(reset).toBe(true);
    expect(store.schemaVersion).toBe(1);
    expect(store.rules).toEqual([]);
  });

  it('缺字段的数据被自愈补齐', () => {
    const { store, reset } = migrate({ schemaVersion: 1, rules: [] });
    expect(reset).toBe(false);
    expect(store.settings.captureMaxCount).toBe(200);
    expect(store.shellTemplates.length).toBeGreaterThan(0);
  });

  it('内置模板始终以代码为准，用户自定义模板保留', () => {
    const { store } = migrate({
      schemaVersion: 1,
      rules: [],
      shellTemplates: [
        { id: 'shell-raw', name: '被改坏的内置模板', builtin: true, template: 'BAD' },
        { id: 'my-custom', name: '风控层格式', builtin: false, template: '{"d":__DATA__}' },
      ],
    });
    expect(store.shellTemplates.find((t) => t.id === 'shell-raw')!.template).toBe('__DATA__');
    expect(store.shellTemplates.find((t) => t.id === 'my-custom')).toBeDefined();
  });

  it('来自更高版本的数据不敢降级处理，走重置', () => {
    const { reset, reason } = migrate({ schemaVersion: 999, rules: [] });
    expect(reset).toBe(true);
    expect(reason).toContain('999');
  });

  it('保留 enabled 状态', () => {
    const { store } = migrate({ schemaVersion: 1, enabled: false, rules: [] } as Partial<MockStore>);
    expect(store.enabled).toBe(false);
  });
});
