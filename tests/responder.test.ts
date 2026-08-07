import { describe, expect, it } from 'vitest';
import { buildResponse } from '../src/core/engine/responder.js';
import { applyShell, detectShell } from '../src/core/engine/shell.js';
import { captureToRuleDraft } from '../src/core/capture/toRule.js';
import {
  BUILTIN_SHELL_TEMPLATES,
  createDefaultStore,
  createResponseSpec,
  createRuleDraft,
  materializeRule,
} from '../src/core/store/defaults.js';
import { normalizeRequest } from '../src/core/engine/normalize.js';
import { createBodyGenRuntime } from '../src/core/engine/bodygen.js';
import type { ResponseSpec, RuleDraft } from '../src/core/types.js';

const req = normalizeRequest('/api/x', 'GET', 'https://a.com/');

let seq = 0;
/** 造一条只有一个变体的规则，方便测响应构造 */
function ruleOf(response?: Partial<ResponseSpec>) {
  const draft: Partial<RuleDraft> = {
    variants: [{ name: '默认', response: createResponseSpec(response) }],
  };
  return materializeRule(createRuleDraft(draft), () => `r${++seq}`, 1);
}

describe('buildResponse', () => {
  const store = createDefaultStore();

  it('返回纯数据而非 Response 对象（core 不依赖浏览器 API）', () => {
    const rule = ruleOf({ body: '{"a":1}' });
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
    const rule = ruleOf({ status: 99 });
    expect(buildResponse(store, rule, req).status).toBe(200);
  });

  it('header 名统一小写，避免 Content-Type 重复设置', () => {
    const rule = ruleOf({ headers: { 'Content-Type': 'text/plain' } });
    const res = buildResponse(store, rule, req);
    expect(res.headers['content-type']).toBe('text/plain');
    expect(Object.keys(res.headers)).toHaveLength(1);
  });

  it('套用响应外壳', () => {
    const rule = ruleOf({ body: '[1,2]', shellTemplateId: 'shell-status-message-data' });
    const res = buildResponse(store, rule, req);
    expect(res.body).toBe('{"status":0,"message":"ok","data":[1,2]}');
  });

  it('shellTemplateId 指向不存在的模板时不套壳，不崩溃', () => {
    const rule = ruleOf({ body: '{"a":1}', shellTemplateId: 'nope' });
    expect(buildResponse(store, rule, req).body).toBe('{"a":1}');
  });
});

describe('buildResponse · 生成式响应体', () => {
  const store = createDefaultStore();
  const listReq = normalizeRequest('/api/list?page=3&size=2', 'GET', 'https://a.com/');

  /** 每个用例给一个干净的 runtime，避免熔断状态串味 */
  const rt = () => createBodyGenRuntime();

  it('bodyType 为 dynamic 时按请求参数现算 —— 这是整个功能的存在理由', () => {
    const rule = ruleOf({
      bodyType: 'dynamic',
      body: '(req) => ({ page: Number(req.query.page), size: Number(req.query.size) })',
    });
    const res = buildResponse(store, rule, listReq, rt());
    expect(JSON.parse(res.body)).toEqual({ page: 3, size: 2 });
    expect(res.bodyGen?.ok).toBe(true);
  });

  it('同一条规则、不同请求参数会得到不同结果（静态响应做不到）', () => {
    const rule = ruleOf({ bodyType: 'dynamic', body: '(req) => ({ p: req.query.page })' });
    const runtime = rt();
    const p1 = normalizeRequest('/api/list?page=1', 'GET', 'https://a.com/');
    const p2 = normalizeRequest('/api/list?page=2', 'GET', 'https://a.com/');
    expect(buildResponse(store, rule, p1, runtime).body).toBe('{"p":"1"}');
    expect(buildResponse(store, rule, p2, runtime).body).toBe('{"p":"2"}');
  });

  it('动态结果照样套响应外壳 —— JS 生成 data，外壳补公司格式', () => {
    const rule = ruleOf({
      bodyType: 'dynamic',
      body: '(req) => [1, 2]',
      shellTemplateId: 'shell-status-message-data',
    });
    const res = buildResponse(store, rule, listReq, rt());
    expect(res.body).toBe('{"status":0,"message":"ok","data":[1,2]}');
  });

  it('执行失败时给出错误载荷并标记 bodyGen.ok=false，不静默返回空对象', () => {
    const rule = ruleOf({ bodyType: 'dynamic', body: '(req) => { throw new Error("炸了"); }' });
    const res = buildResponse(store, rule, listReq, rt());
    expect(res.bodyGen?.ok).toBe(false);
    expect(JSON.parse(res.body).__mockStudioError__).toContain('炸了');
  });

  it('静态响应不带 bodyGen 字段，请求面板据此判断要不要显示诊断', () => {
    const rule = ruleOf({ body: '{"a":1}' });
    expect(buildResponse(store, rule, req).bodyGen).toBeUndefined();
  });

  it('熔断按「规则 + 变体」隔离：一个变体写错不影响另一个', () => {
    const draft: Partial<RuleDraft> = {
      variants: [
        { name: '好的', response: createResponseSpec({ bodyType: 'dynamic', body: '(req) => ({ ok: 1 })' }) },
        { name: '坏的', response: createResponseSpec({ bodyType: 'dynamic', body: '(req) => { throw 1; }' }) },
      ],
    };
    const rule = materializeRule(createRuleDraft(draft), () => `rv${++seq}`, 1);
    const runtime = rt();

    // 先把「坏的」变体打到熔断
    const broken = { ...rule, activeVariantId: rule.variants[1]!.id };
    for (let i = 0; i < 5; i++) buildResponse(store, broken, listReq, runtime);
    expect(buildResponse(store, broken, listReq, runtime).bodyGen?.tripped).toBe(true);

    // 「好的」变体不受影响
    const good = { ...rule, activeVariantId: rule.variants[0]!.id };
    expect(buildResponse(store, good, listReq, runtime).bodyGen?.ok).toBe(true);
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
    expect(draft.variants[0]!.response.status).toBe(201);
  });

  it('自动识别外壳，body 里只留业务数据', () => {
    const draft = captureToRuleDraft(
      {
        url: 'https://a.com/api/goods/list',
        method: 'GET',
        status: 200,
        body: '{"status":0,"message":"ok","data":{"list":[1]}}',
      },
      { shellTemplates: BUILTIN_SHELL_TEMPLATES },
    );
    const v = draft.variants[0]!;
    expect(v.response.shellTemplateId).toBe('shell-status-message-data');
    expect(JSON.parse(v.response.body)).toEqual({ list: [1] });
  });

  it('响应体是 HTML 等非 JSON 时原样保留', () => {
    const draft = captureToRuleDraft({
      url: 'https://a.com/page',
      method: 'GET',
      status: 200,
      body: '<html>hi</html>',
    });
    expect(draft.variants[0]!.response.body).toBe('<html>hi</html>');
  });

  it('无法解析的 URL 不崩溃', () => {
    expect(() =>
      captureToRuleDraft({ url: 'not a url', method: 'GET', status: 200, body: '{}' }),
    ).not.toThrow();
  });
});

  it('withPresetVariants 顺带生成空数据与报错变体', () => {
    const draft = captureToRuleDraft(
      {
        url: 'https://a.com/api/goods/list',
        method: 'GET',
        status: 200,
        body: '{"list":[{"id":1}],"total":42}',
      },
      { withPresetVariants: true },
    );
    expect(draft.variants.map((v) => v.name)).toEqual(['真实响应', '空数据', '报错']);
    // 空数据是从真实响应推出来的形状，而非死板的 {"list":[],"total":0}
    expect(JSON.parse(draft.variants[1]!.response.body)).toEqual({ list: [], total: 0 });
    expect(draft.variants[2]!.response.status).toBe(500);
  });

  it('落在项目下时不再重复限定 host —— 项目已经管住域名了', () => {
    const draft = captureToRuleDraft(
      { url: 'https://a.com/api/x', method: 'GET', status: 200, body: '{}' },
      { projectId: 'p1' },
    );
    expect(draft.projectId).toBe('p1');
    expect(draft.match.hosts).toEqual([]);
  });
