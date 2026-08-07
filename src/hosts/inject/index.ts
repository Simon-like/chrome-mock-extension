/**
 * MAIN world 拦截引擎 —— 实际干活的地方
 *
 * ⚠️ 这个文件跑在页面的 JS 世界里：
 *   - 能改 window.fetch / XMLHttpRequest
 *   - 完全用不了 chrome.* API（数据只能靠 window.postMessage 传出）
 *   - manifest 里的 run_at: document_start + world: MAIN 两个配置不可改动
 *
 * 设计要点见 05 §5.4、§5.5；时机原理见 03 §2；
 * 「页面会在我们之后再包一层」的实测结论见 04 §2。
 */

import { findMatchingRule } from '@core/engine/matcher.js';
import { normalizeRequest } from '@core/engine/normalize.js';
import { buildResponse } from '@core/engine/responder.js';
import { createBodyGenRuntime } from '@core/engine/bodygen.js';
import { probeEvalSupport, type EvalSupport } from '@core/engine/dynamic.js';
import type { EngineSnapshot, CapturedRequest } from '@shared/messages.js';
import { PAGE_CHANNEL } from '@shared/messages.js';
import type { MockResponse, MockStore, RequestInfo, Rule } from '@core/types.js';

// ═══════════════════════════════════════════════════════════
// 状态
// ═══════════════════════════════════════════════════════════

let snapshot: EngineSnapshot | null = null;

/** 规则到达前发生的请求 —— 用于提示用户刷新页面（见 05 §4.3） */
const missedBeforeReady: string[] = [];

let eventSeq = 0;

/** 保存原始实现。必须在任何人包装我们之前抓住 */
const originalFetch = window.fetch;
const XhrProto = XMLHttpRequest.prototype;
const originalOpen = XhrProto.open;
const originalSend = XhrProto.send;
const originalSetRequestHeader = XhrProto.setRequestHeader;

/** 健康度自检用的行为计数（不能用引用相等判断，见 04 §2） */
let observedCount = 0;
let mockedCount = 0;

/**
 * 动态响应运行时（编译缓存 + 熔断），一个页面一份。
 *
 * 由宿主持有而不是用 responder 里的默认单例 —— 因为熔断需要在
 * 「用户改完规则」时清零，那个时机只有宿主知道（见下面的快照监听）。
 */
const bodyGenRuntime = createBodyGenRuntime();

// ═══════════════════════════════════════════════════════════
// 与 ISOLATED world 通信
// ═══════════════════════════════════════════════════════════

function post(msg: unknown): void {
  try {
    window.postMessage(msg, '*');
  } catch {
    /* 绝不能因为上报失败影响宿主页面 */
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  // 安全校验：postMessage 页面也能伪造，必须验来源
  if (event.source !== window) return;
  const data = event.data as { channel?: string; type?: string; snapshot?: EngineSnapshot };
  if (!data || data.channel !== PAGE_CHANNEL) return;
  if (data.type !== 'RULES_SNAPSHOT' || !data.snapshot) return;

  snapshot = data.snapshot;

  // 新快照 = 用户刚改了什么。给被熔断的动态规则一次重新执行的机会 ——
  // 否则用户改完 JS 保存了，页面却还在返回「已熔断」，只能刷页面，很费解。
  // 编译缓存不用清：它以源码为键，改一个字符就是新条目
  bodyGenRuntime.reset();
});

function reportEvent(entry: CapturedRequest): void {
  if (!snapshot?.captureEnabled && !entry.mocked) return;
  post({ channel: PAGE_CHANNEL, type: 'REQUEST_EVENT', entry });
}

function makeEntry(
  req: RequestInfo,
  api: 'fetch' | 'xhr',
  extra: Partial<CapturedRequest>,
): CapturedRequest {
  return {
    id: `${Date.now()}-${++eventSeq}`,
    at: Date.now(),
    url: req.url,
    method: req.method,
    api,
    mocked: false,
    ruleId: null,
    ruleName: null,
    status: null,
    body: null,
    truncated: false,
    durationMs: null,
    ...extra,
  };
}

// ═══════════════════════════════════════════════════════════
// 规则查询
// ═══════════════════════════════════════════════════════════

/**
 * 规则未就绪时【放行】（fail-open）。
 *
 * 为什么不阻塞等待：xhr.send() 是同步方法，没法等一个异步消息回来。
 * 放行的后果是早期请求拿到真实数据（页面正常工作，只是 mock 没生效）；
 * 阻塞的后果是页面卡死。放行是安全的降级。详见 05 §4.3。
 */
function lookupRule(req: RequestInfo): Rule | null {
  if (!snapshot) {
    missedBeforeReady.push(req.url);
    return null;
  }
  if (!snapshot.enabled) return null;

  // matcher 需要一个 MockStore 形态，用快照拼一个（settings 不参与匹配）
  const pseudoStore = {
    enabled: snapshot.enabled,
    rules: snapshot.rules,
    groups: snapshot.groups,
    projects: snapshot.projects ?? [],
    shellTemplates: snapshot.shellTemplates,
  } as MockStore;

  const hit = findMatchingRule(pseudoStore, req);
  return hit?.rule ?? null;
}

function makeMockResponse(rule: Rule, req: RequestInfo): MockResponse {
  // 外壳继承链要读 groups / projects，都得带上
  const pseudoStore = {
    shellTemplates: snapshot?.shellTemplates ?? [],
    groups: snapshot?.groups ?? [],
    projects: snapshot?.projects ?? [],
  } as MockStore;
  const mock = buildResponse(pseudoStore, rule, req, bodyGenRuntime);
  warnOnBodyGenFailure(rule, mock);
  return mock;
}

/**
 * 响应体没生成出来，在页面控制台喊一声 —— 用户多半正盯着控制台调页面，
 * 比让他自己想起来去开 DevTools 面板快得多。
 *
 * 只在【第一次】喊。一个翻页列表一秒能发十几个请求，每次都 warn 会把控制台冲垮，
 * 反而盖住用户自己的日志。firstFailure 由 runtime 判定。
 */
function warnOnBodyGenFailure(rule: Rule, mock: MockResponse): void {
  if (!mock.bodyGen || mock.bodyGen.ok || !mock.bodyGen.firstFailure) return;
  const what = mock.bodyGen.kind === 'mockjs' ? 'Mock 模板展开' : '动态响应执行';
  try {
    console.warn(
      `[Mock Studio] 规则「${rule.name}」的${what}失败：${mock.bodyGen.error}\n` +
        '已返回错误载荷（__mockStudioError__），请在扩展里修正。',
    );
  } catch {
    /* 页面可能改了 console，绝不能因此影响请求 */
  }
}

const MAX_CAPTURE_BODY = 256 * 1024;

function truncate(body: string): { body: string; truncated: boolean } {
  if (body.length <= MAX_CAPTURE_BODY) return { body, truncated: false };
  return { body: body.slice(0, MAX_CAPTURE_BODY), truncated: true };
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

// ═══════════════════════════════════════════════════════════
// Hook fetch
// ═══════════════════════════════════════════════════════════

function hookFetch(): void {
  if (typeof originalFetch !== 'function') return;

  const patched = function (this: unknown, ...args: Parameters<typeof fetch>) {
    let req: RequestInfo;
    try {
      req = parseFetchArgs(args);
    } catch {
      return originalFetch.apply(this as never, args);
    }

    const rule = lookupRule(req);

    if (!rule) {
      observedCount++;
      const started = Date.now();
      const p = originalFetch.apply(this as never, args);
      // 采集真实响应体（Capture-to-Mock 需要它）
      if (snapshot?.captureEnabled) {
        p.then((res) => {
          // clone 避免消费掉业务代码要用的 body
          res
            .clone()
            .text()
            .then((text) => {
              const t = truncate(text);
              reportEvent(
                makeEntry(req, 'fetch', {
                  status: res.status,
                  body: t.body,
                  truncated: t.truncated,
                  durationMs: Date.now() - started,
                }),
              );
            })
            .catch(() => {
              reportEvent(makeEntry(req, 'fetch', { status: res.status }));
            });
        }).catch(() => {
          reportEvent(makeEntry(req, 'fetch', {}));
        });
      }
      return p;
    }

    // 命中规则 —— 真实请求根本不会发出。
    // 这正是虚拟接口不会 404、不触发 CORS 预检的原因（02 §1.2）
    mockedCount++;
    const mock = makeMockResponse(rule, req);
    reportEvent(
      makeEntry(req, 'fetch', {
        mocked: true,
        ruleId: rule.id,
        ruleName: rule.name,
        status: mock.status,
        body: mock.body,
        bodyGen: mock.bodyGen,
      }),
    );

    if (mock.behavior === 'networkError') {
      return sleep(mock.delayMs).then(() =>
        Promise.reject(new TypeError('Failed to fetch')),
      );
    }
    if (mock.behavior === 'timeout') {
      // 永不 resolve，模拟请求挂起
      return new Promise<Response>(() => {});
    }

    return sleep(mock.delayMs).then(
      () =>
        new Response(mock.body, {
          status: mock.status,
          statusText: statusTextOf(mock.status),
          headers: mock.headers,
        }),
    );
  };

  window.fetch = patched as typeof fetch;

  // 伪装成原生：有些监控/风控 SDK 会检测内置函数是否被篡改
  try {
    Object.defineProperty(window.fetch, 'name', { value: 'fetch' });
    Object.defineProperty(window.fetch, 'length', { value: originalFetch.length });
    window.fetch.toString = () => originalFetch.toString();
  } catch {
    /* 失败无妨 */
  }
}

function parseFetchArgs(args: Parameters<typeof fetch>): RequestInfo {
  const [input, init] = args;
  let rawUrl: unknown;
  let rawMethod: unknown;

  if (typeof input === 'string') {
    rawUrl = input;
    rawMethod = init?.method ?? 'GET';
  } else if (input instanceof URL) {
    rawUrl = input.href;
    rawMethod = init?.method ?? 'GET';
  } else if (input instanceof Request) {
    rawUrl = input.url;
    rawMethod = init?.method ?? input.method ?? 'GET';
  } else {
    rawUrl = String(input);
    rawMethod = init?.method ?? 'GET';
  }

  return normalizeRequest(rawUrl, rawMethod, location.href);
}

// ═══════════════════════════════════════════════════════════
// Hook XMLHttpRequest（axios 默认走这条）
// ═══════════════════════════════════════════════════════════

interface XhrMeta {
  req: RequestInfo;
  headers: Record<string, string>;
  startedAt: number;
}

const xhrMeta = new WeakMap<XMLHttpRequest, XhrMeta>();

function hookXhr(): void {
  XhrProto.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    try {
      xhrMeta.set(this, {
        req: normalizeRequest(url, method, location.href),
        headers: {},
        startedAt: 0,
      });
    } catch {
      /* 记不下就当普通请求处理 */
    }
    return (originalOpen as (...a: unknown[]) => void).apply(this, [
      method,
      url,
      ...rest,
    ]);
  } as typeof XhrProto.open;

  XhrProto.setRequestHeader = function (
    this: XMLHttpRequest,
    name: string,
    value: string,
  ) {
    const meta = xhrMeta.get(this);
    if (meta) meta.headers[name] = value;
    return originalSetRequestHeader.call(this, name, value);
  };

  XhrProto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const meta = xhrMeta.get(this);
    if (!meta) return originalSend.call(this, body ?? null);

    const rule = lookupRule(meta.req);

    if (!rule) {
      observedCount++;
      meta.startedAt = Date.now();
      if (snapshot?.captureEnabled) {
        attachCaptureListener(this, meta);
      }
      return originalSend.call(this, body ?? null);
    }

    mockedCount++;
    const mock = makeMockResponse(rule, meta.req);
    reportEvent(
      makeEntry(meta.req, 'xhr', {
        mocked: true,
        ruleId: rule.id,
        ruleName: rule.name,
        status: mock.status,
        body: mock.body,
        bodyGen: mock.bodyGen,
      }),
    );

    if (mock.behavior === 'timeout') {
      return; // 永不回调，请求挂起
    }
    if (mock.behavior === 'networkError') {
      setTimeout(() => {
        try {
          this.dispatchEvent(new ProgressEvent('error'));
          this.dispatchEvent(new ProgressEvent('loadend'));
        } catch {
          /* ignore */
        }
      }, mock.delayMs);
      return;
    }

    fulfillXhr(this, mock, meta.req.url);
  };
}

/**
 * 伪造 XHR 响应。
 *
 * status / responseText 等都是【原型上的只读 getter】，
 * 但在实例上重新 defineProperty 可以遮蔽原型的 getter —— 这是标准手法。
 */
function fulfillXhr(xhr: XMLHttpRequest, mock: MockResponse, url: string): void {
  const define = (prop: string, getter: () => unknown) => {
    try {
      Object.defineProperty(xhr, prop, { get: getter, configurable: true });
    } catch {
      /* 个别属性失败不影响整体 */
    }
  };

  define('readyState', () => 4);
  define('status', () => mock.status);
  define('statusText', () => statusTextOf(mock.status));
  define('responseURL', () => url);
  define('responseText', () => mock.body);
  define('response', () => {
    if (xhr.responseType === 'json') {
      try {
        return JSON.parse(mock.body);
      } catch {
        return null;
      }
    }
    return mock.body;
  });

  const headerLines = Object.entries(mock.headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n');
  xhr.getAllResponseHeaders = () => headerLines + '\r\n';
  xhr.getResponseHeader = (name: string) =>
    mock.headers[String(name).toLowerCase()] ?? null;

  // 必须异步派发。同步派发会让 axios 等库的状态机错乱
  //（send() 还没返回，onload 就已经触发了）
  setTimeout(() => {
    try {
      // dispatchEvent 同时触发 addEventListener 和 onload 两种写法
      xhr.dispatchEvent(new Event('readystatechange'));
      xhr.dispatchEvent(new ProgressEvent('load'));
      xhr.dispatchEvent(new ProgressEvent('loadend'));
    } catch {
      /* ignore */
    }
  }, mock.delayMs);
}

function attachCaptureListener(xhr: XMLHttpRequest, meta: XhrMeta): void {
  xhr.addEventListener('load', () => {
    let text: string | null = null;
    try {
      // responseType 为 blob/arraybuffer 时读 responseText 会抛错
      text = xhr.responseType === '' || xhr.responseType === 'text'
        ? xhr.responseText
        : xhr.responseType === 'json'
          ? JSON.stringify(xhr.response)
          : null;
    } catch {
      text = null;
    }
    const t = text === null ? { body: null, truncated: false } : truncate(text);
    reportEvent(
      makeEntry(meta.req, 'xhr', {
        status: xhr.status,
        body: t.body,
        truncated: t.truncated,
        durationMs: Date.now() - meta.startedAt,
      }),
    );
  });
}

// ═══════════════════════════════════════════════════════════
// 动态响应可行性探测（Spike，见 docs/10-动态响应Spike.md）
// ═══════════════════════════════════════════════════════════

/**
 * 探测结果缓存。一个页面的 CSP 不会中途变，测一次就够。
 *
 * ⚠️ 刻意【不在启动时探测】：被 CSP 拦下会派发 securitypolicyviolation，
 * 站点配了 report-uri 的话，我们就往人家监控里灌脏数据了。
 * 只在用户显式点探测、或将来真要执行 dynamic 规则时才跑。
 */
let evalSupport: EvalSupport | null = null;

function getEvalSupport(): EvalSupport {
  if (!evalSupport) evalSupport = probeEvalSupport();
  return evalSupport;
}

function statusTextOf(status: number): string {
  const map: Record<number, string> = {
    200: 'OK',
    201: 'Created',
    204: 'No Content',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
  };
  return map[status] ?? '';
}

// ═══════════════════════════════════════════════════════════
// 启动
// ═══════════════════════════════════════════════════════════

hookFetch();
hookXhr();

/**
 * 调试入口。健康判断用【行为】而非引用相等 ——
 * 实测你司站点的监控 SDK 会在我们之后包一层，导致 window.fetch !== 我们的函数，
 * 但我们仍在调用链最底层，mock 照常生效。详见 04 §2。
 */
Object.defineProperty(window, '__MOCK_STUDIO__', {
  value: {
    get healthy() {
      return observedCount + mockedCount > 0;
    },
    get stats() {
      return {
        observed: observedCount,
        mocked: mockedCount,
        rulesLoaded: snapshot?.rules.length ?? 0,
        revision: snapshot?.revision ?? -1,
        missedBeforeReady: missedBeforeReady.length,
      };
    },
    get missedBeforeReady() {
      return [...missedBeforeReady];
    },
    /**
     * 动态响应能否在本站点落地。
     * 是个【方法】而不是 getter —— 调用有副作用（可能触发 CSP 上报），
     * 写成 getter 的话在控制台展开 __MOCK_STUDIO__ 就会被无意触发。
     */
    probeDynamicSupport() {
      return getEvalSupport();
    },
  },
  configurable: true,
});
