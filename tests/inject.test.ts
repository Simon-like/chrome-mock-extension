/**
 * @vitest-environment happy-dom
 */

/**
 * 注入层测试 —— 引擎的心脏
 *
 * 为什么这些测试必须有：
 *   - 伪造 XHR 响应是全项目最容易写错的地方（原型上的只读 getter、事件派发时序）
 *   - 引擎跑在用户的每一个请求上，错了就是整站异常
 *   - 手工在浏览器里验证一遍要好几分钟，而且容易漏掉边界情况
 *
 * 注意 inject/index.ts 在 import 时就会执行 hook（副作用），
 * 所以必须用 dynamic import 并在之前把环境准备好。
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createDefaultStore, createRuleDraft, materializeRule } from '../src/core/store/defaults.js';
import { PAGE_CHANNEL } from '../src/shared/messages.js';
import type { EngineSnapshot } from '../src/shared/messages.js';
import type { Rule, RuleDraft } from '../src/core/types.js';

/** 记录注入层通过 postMessage 上报的事件 */
const reported: Array<{ type: string; entry?: Record<string, unknown> }> = [];

let seq = 0;
function rule(partial: Partial<RuleDraft>): Rule {
  return materializeRule(createRuleDraft(partial), () => `r${++seq}`, 1);
}

function snapshotOf(rules: Rule[], enabled = true): EngineSnapshot {
  const def = createDefaultStore();
  return {
    enabled,
    rules,
    groups: [],
    shellTemplates: def.shellTemplates,
    captureEnabled: false, // 关掉采集，避免真实 fetch 被调用
    revision: ++seq,
  };
}

/**
 * 把规则快照推给引擎，模拟 content script 的下发。
 *
 * 这里不能直接用 window.postMessage：注入层出于安全会校验 event.source === window
 * （防止 iframe 或其他窗口伪造规则下发），而 happy-dom 的 postMessage 把 source
 * 设成了一个非 window 的 EventTarget。所以显式构造带 source 的 MessageEvent。
 * 产品代码的校验是正确的，这只是测试环境的适配。
 */
async function pushSnapshot(snapshot: EngineSnapshot): Promise<void> {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { channel: PAGE_CHANNEL, type: 'RULES_SNAPSHOT', snapshot },
      source: window,
    }),
  );
  await new Promise((r) => setTimeout(r, 0));
}

/** 原始 fetch 的替身：命中它说明请求被放行了（没有被 mock） */
const passthroughFetch = vi.fn(
  async () => new Response('REAL', { status: 200, headers: { 'content-type': 'text/plain' } }),
);

beforeAll(async () => {
  // 装上原始 fetch 的替身，注入层会保存它作为 originalFetch
  window.fetch = passthroughFetch as unknown as typeof fetch;

  // 拦下注入层的上报，避免污染页面
  window.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { channel?: string; type?: string; entry?: Record<string, unknown> };
    if (d?.channel === PAGE_CHANNEL && d.type === 'REQUEST_EVENT') {
      reported.push({ type: d.type, entry: d.entry });
    }
  });

  // 副作用式 import：这一行会安装 hook
  await import('../src/hosts/inject/index.js');
});

// ═══════════════════════════════════════════════════════════

describe('引擎安装', () => {
  it('暴露调试入口', () => {
    expect((window as unknown as { __MOCK_STUDIO__: unknown }).__MOCK_STUDIO__).toBeDefined();
  });

  it('fetch 与 XHR.send 都已被替换', () => {
    expect(window.fetch).not.toBe(passthroughFetch);
    expect(XMLHttpRequest.prototype.send).toBeDefined();
  });
});

describe('规则未就绪时 fail-open 放行', () => {
  it('没有快照时请求走原始 fetch，并记录漏网', async () => {
    passthroughFetch.mockClear();
    const res = await fetch('/api/before-ready');
    expect(await res.text()).toBe('REAL');
    expect(passthroughFetch).toHaveBeenCalledTimes(1);

    const api = (window as unknown as { __MOCK_STUDIO__: { stats: { missedBeforeReady: number } } })
      .__MOCK_STUDIO__;
    expect(api.stats.missedBeforeReady).toBeGreaterThan(0);
  });
});

describe('fetch 拦截', () => {
  it('命中规则时返回 mock 内容，且真实请求不发出', async () => {
    await pushSnapshot(
      snapshotOf([
        rule({
          name: 'goods',
          match: { urlMode: 'contains', url: '/api/goods', methods: [], hosts: [] },
          response: {
            ...createRuleDraft().response,
            body: '{"list":[1,2,3]}',
          },
        }),
      ]),
    );

    passthroughFetch.mockClear();
    const res = await fetch('/api/goods/list');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ list: [1, 2, 3] });
    // 关键：真实请求根本没发出 —— 这正是虚拟接口不会 404 的原因
    expect(passthroughFetch).not.toHaveBeenCalled();
  });

  it('未命中的请求正常放行', async () => {
    passthroughFetch.mockClear();
    const res = await fetch('/api/other/thing');
    expect(await res.text()).toBe('REAL');
    expect(passthroughFetch).toHaveBeenCalledTimes(1);
  });

  it('自定义状态码生效', async () => {
    await pushSnapshot(
      snapshotOf([
        rule({
          match: { urlMode: 'contains', url: '/api/boom', methods: [], hosts: [] },
          response: { ...createRuleDraft().response, status: 500, body: '{"err":1}' },
        }),
      ]),
    );
    const res = await fetch('/api/boom');
    expect(res.status).toBe(500);
  });

  it('总开关关闭时全部放行', async () => {
    await pushSnapshot(
      snapshotOf(
        [
          rule({
            match: { urlMode: 'contains', url: '/api/goods', methods: [], hosts: [] },
            response: { ...createRuleDraft().response, body: '{"mocked":true}' },
          }),
        ],
        false,
      ),
    );

    passthroughFetch.mockClear();
    const res = await fetch('/api/goods/list');
    expect(await res.text()).toBe('REAL');
    expect(passthroughFetch).toHaveBeenCalledTimes(1);
  });

  it('Request 对象作为入参也能识别', async () => {
    await pushSnapshot(
      snapshotOf([
        rule({
          match: { urlMode: 'contains', url: '/api/req-obj', methods: [], hosts: [] },
          response: { ...createRuleDraft().response, body: '{"ok":1}' },
        }),
      ]),
    );
    const res = await fetch(new Request('https://localhost/api/req-obj'));
    expect(await res.json()).toEqual({ ok: 1 });
  });

  it('method 过滤生效', async () => {
    await pushSnapshot(
      snapshotOf([
        rule({
          match: { urlMode: 'contains', url: '/api/only-post', methods: ['POST'], hosts: [] },
          response: { ...createRuleDraft().response, body: '{"posted":1}' },
        }),
      ]),
    );

    passthroughFetch.mockClear();
    // GET 不该命中
    expect(await (await fetch('/api/only-post')).text()).toBe('REAL');
    // POST 该命中
    expect(await (await fetch('/api/only-post', { method: 'POST' })).json()).toEqual({ posted: 1 });
    expect(passthroughFetch).toHaveBeenCalledTimes(1);
  });

  it('套响应外壳', async () => {
    await pushSnapshot(
      snapshotOf([
        rule({
          match: { urlMode: 'contains', url: '/api/shelled', methods: [], hosts: [] },
          response: {
            ...createRuleDraft().response,
            body: '[7,8]',
            shellTemplateId: 'shell-status-message-data',
          },
        }),
      ]),
    );
    const res = await fetch('/api/shelled');
    expect(await res.json()).toEqual({ status: 0, message: 'ok', data: [7, 8] });
  });
});

describe('XHR 拦截（axios 走这条）', () => {
  /** 用 onload 属性形式监听 */
  function xhrViaProperty(url: string, method = 'GET'): Promise<XMLHttpRequest> {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open(method, url);
      x.onload = () => resolve(x);
      x.onerror = () => reject(new Error('xhr error'));
      x.send();
    });
  }

  /** 用 addEventListener 形式监听 —— axios 实际用的是这种 */
  function xhrViaListener(url: string): Promise<XMLHttpRequest> {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('GET', url);
      x.addEventListener('loadend', () => resolve(x));
      x.addEventListener('error', () => reject(new Error('xhr error')));
      x.send();
    });
  }

  it('onload 属性形式能收到 mock 响应', async () => {
    await pushSnapshot(
      snapshotOf([
        rule({
          match: { urlMode: 'contains', url: '/api/xhr-prop', methods: [], hosts: [] },
          response: { ...createRuleDraft().response, body: '{"via":"prop"}' },
        }),
      ]),
    );

    const x = await xhrViaProperty('/api/xhr-prop');
    expect(x.status).toBe(200);
    expect(x.readyState).toBe(4);
    expect(JSON.parse(x.responseText)).toEqual({ via: 'prop' });
  });

  it('addEventListener 形式同样能收到（这是 axios 的方式）', async () => {
    await pushSnapshot(
      snapshotOf([
        rule({
          match: { urlMode: 'contains', url: '/api/xhr-listener', methods: [], hosts: [] },
          response: { ...createRuleDraft().response, body: '{"via":"listener"}' },
        }),
      ]),
    );

    const x = await xhrViaListener('/api/xhr-listener');
    expect(JSON.parse(x.responseText)).toEqual({ via: 'listener' });
  });

  it('响应头可读（axios 会读 content-type 决定是否自动 parse）', async () => {
    await pushSnapshot(
      snapshotOf([
        rule({
          match: { urlMode: 'contains', url: '/api/xhr-headers', methods: [], hosts: [] },
          response: { ...createRuleDraft().response, body: '{}' },
        }),
      ]),
    );

    const x = await xhrViaProperty('/api/xhr-headers');
    expect(x.getResponseHeader('content-type')).toBe('application/json');
    expect(x.getAllResponseHeaders()).toContain('content-type');
  });

  it('自定义状态码生效', async () => {
    await pushSnapshot(
      snapshotOf([
        rule({
          match: { urlMode: 'contains', url: '/api/xhr-401', methods: [], hosts: [] },
          response: { ...createRuleDraft().response, status: 401, body: '{"msg":"过期"}' },
        }),
      ]),
    );

    const x = await xhrViaProperty('/api/xhr-401');
    expect(x.status).toBe(401);
    expect(x.statusText).toBe('Unauthorized');
  });

  it('responseURL 指向请求的地址', async () => {
    await pushSnapshot(
      snapshotOf([
        rule({
          match: { urlMode: 'contains', url: '/api/xhr-url', methods: [], hosts: [] },
          response: { ...createRuleDraft().response, body: '{}' },
        }),
      ]),
    );

    const x = await xhrViaProperty('/api/xhr-url');
    expect(x.responseURL).toContain('/api/xhr-url');
  });

  it('多个 XHR 实例互不干扰（getter 定义在实例上而非原型）', async () => {
    await pushSnapshot(
      snapshotOf([
        rule({
          name: 'a',
          match: { urlMode: 'contains', url: '/api/multi-a', methods: [], hosts: [] },
          response: { ...createRuleDraft().response, body: '{"which":"a"}' },
        }),
        rule({
          name: 'b',
          match: { urlMode: 'contains', url: '/api/multi-b', methods: [], hosts: [] },
          response: { ...createRuleDraft().response, status: 201, body: '{"which":"b"}' },
        }),
      ]),
    );

    const [a, b] = await Promise.all([
      xhrViaProperty('/api/multi-a'),
      xhrViaProperty('/api/multi-b'),
    ]);

    expect(JSON.parse(a.responseText)).toEqual({ which: 'a' });
    expect(JSON.parse(b.responseText)).toEqual({ which: 'b' });
    expect(a.status).toBe(200);
    expect(b.status).toBe(201);
  });
});

describe('延迟模拟', () => {
  it('fetch 按 delayMs 延后返回', async () => {
    await pushSnapshot(
      snapshotOf([
        rule({
          match: { urlMode: 'contains', url: '/api/slow', methods: [], hosts: [] },
          response: { ...createRuleDraft().response, body: '{}', delayMs: 60 },
        }),
      ]),
    );

    const started = Date.now();
    await fetch('/api/slow');
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });
});

describe('上报', () => {
  it('命中 mock 时上报规则信息，供 DevTools 面板展示', async () => {
    const r = rule({
      name: '上报测试',
      match: { urlMode: 'contains', url: '/api/reported', methods: [], hosts: [] },
      response: { ...createRuleDraft().response, body: '{"x":1}' },
    });
    await pushSnapshot(snapshotOf([r]));

    reported.length = 0;
    await fetch('/api/reported');
    await new Promise((res) => setTimeout(res, 10));

    const hit = reported.find((e) => e.entry?.url && String(e.entry.url).includes('/api/reported'));
    expect(hit).toBeDefined();
    expect(hit!.entry!.mocked).toBe(true);
    expect(hit!.entry!.ruleName).toBe('上报测试');
    expect(hit!.entry!.ruleId).toBe(r.id);
  });
});

describe('健壮性：引擎绝不能拖垮页面', () => {
  it('非法正则规则不影响其他请求', async () => {
    await pushSnapshot(
      snapshotOf([
        rule({
          name: '坏正则',
          match: { urlMode: 'regex', url: '[invalid(', methods: [], hosts: [] },
          response: { ...createRuleDraft().response, body: '{}' },
        }),
      ]),
    );

    passthroughFetch.mockClear();
    // 不该抛异常，应该正常放行
    const res = await fetch('/api/anything');
    expect(await res.text()).toBe('REAL');
  });

  it('响应体是非法 JSON 时照样原样返回（允许草稿状态）', async () => {
    await pushSnapshot(
      snapshotOf([
        rule({
          match: { urlMode: 'contains', url: '/api/bad-json', methods: [], hosts: [] },
          response: { ...createRuleDraft().response, body: '{not json' },
        }),
      ]),
    );

    const res = await fetch('/api/bad-json');
    expect(await res.text()).toBe('{not json');
  });
});
