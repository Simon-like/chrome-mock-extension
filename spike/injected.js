/**
 * MAIN world 注入脚本 —— Spike 的核心
 *
 * 这个文件跑在页面的 JS 世界里，能改 window.fetch / XMLHttpRequest，
 * 但完全用不了 chrome.* API，数据只能靠 window.postMessage 传出去。
 *
 * 它要验证 5 件事：
 *   1. 注入时机够不够早（能不能赶在页面脚本之前）
 *   2. 能不能 hook 到 fetch
 *   3. 能不能 hook 到 XHR（axios 走这条）
 *   4. 能不能真的改掉响应（不只是旁观）
 *   5. hook 会不会被页面覆盖掉
 */
(function () {
  'use strict';

  const CHANNEL = '__MOCK_SPIKE__';
  const installedAt = performance.now();

  // ── 时机证据：注入的这一刻，页面处于什么状态 ─────────────────
  const timing = {
    installedAt,
    readyState: document.readyState,
    // document_start 时页面应该还没有任何 script 标签被执行
    scriptCountAtInstall: document.scripts ? document.scripts.length : -1,
    hasBody: !!document.body,
  };

  // ── 测试规则（写死，仅用于自检）────────────────────────────
  // 真实产品里这些规则来自 chrome.storage，由 content script 下发
  const TEST_RULES = [
    {
      name: 'spike-fetch-test',
      match: (url) => url.includes('__spike_mock_fetch__'),
      status: 200,
      body: { __mocked_by__: 'spike', via: 'fetch', ok: true },
    },
    {
      name: 'spike-xhr-test',
      match: (url) => url.includes('__spike_mock_xhr__'),
      status: 200,
      body: { __mocked_by__: 'spike', via: 'xhr', ok: true },
    },
  ];

  function matchRule(url) {
    try {
      return TEST_RULES.find((r) => r.match(String(url))) || null;
    } catch (e) {
      return null;
    }
  }

  // ── 把观测数据送出 MAIN world ─────────────────────────────
  // MAIN world 没有 chrome.*，postMessage 是唯一通道
  let seq = 0;
  function report(payload) {
    try {
      window.postMessage(
        { channel: CHANNEL, seq: ++seq, t: Date.now(), ...payload },
        '*'
      );
    } catch (e) {
      /* 静默失败，绝不能影响宿主页面 */
    }
  }

  function normalizeUrl(u) {
    try {
      return new URL(String(u), location.href).href;
    } catch (e) {
      return String(u);
    }
  }

  // ══════════════════════════════════════════════════════════
  // 1. Hook fetch
  // ══════════════════════════════════════════════════════════
  const originalFetch = window.fetch;

  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      let url, method;
      try {
        if (typeof input === 'string') {
          url = input;
          method = (init && init.method) || 'GET';
        } else if (input instanceof Request) {
          url = input.url;
          method = (init && init.method) || input.method || 'GET';
        } else {
          url = String(input);
          method = (init && init.method) || 'GET';
        }
        url = normalizeUrl(url);
        method = String(method).toUpperCase();
      } catch (e) {
        return originalFetch.apply(this, arguments);
      }

      const rule = matchRule(url);

      if (!rule) {
        report({ kind: 'observe', api: 'fetch', url, method });
        return originalFetch.apply(this, arguments);
      }

      // 命中规则 —— 真实请求根本不会发出去
      // 这正是「虚拟接口」能凭空存在、且不触发 CORS 预检的原因
      report({ kind: 'mock', api: 'fetch', url, method, rule: rule.name });
      const bodyText = JSON.stringify(rule.body);
      return Promise.resolve(
        new Response(bodyText, {
          status: rule.status,
          statusText: 'OK',
          headers: { 'Content-Type': 'application/json' },
        })
      );
    };
    // 让 hook 后的 fetch 看起来尽量像原生的，避免被页面的检测代码识破
    try {
      Object.defineProperty(window.fetch, 'name', { value: 'fetch' });
      window.fetch.toString = () => originalFetch.toString();
    } catch (e) {}
  }

  // ══════════════════════════════════════════════════════════
  // 2. Hook XMLHttpRequest（axios 默认走这条）
  // ══════════════════════════════════════════════════════════
  const XHRProto = XMLHttpRequest.prototype;
  const originalOpen = XHRProto.open;
  const originalSend = XHRProto.send;
  const originalSetRequestHeader = XHRProto.setRequestHeader;

  XHRProto.open = function (method, url) {
    try {
      this.__spike = {
        method: String(method || 'GET').toUpperCase(),
        url: normalizeUrl(url),
        headers: {},
      };
    } catch (e) {}
    return originalOpen.apply(this, arguments);
  };

  XHRProto.setRequestHeader = function (name, value) {
    try {
      if (this.__spike) this.__spike.headers[name] = value;
    } catch (e) {}
    return originalSetRequestHeader.apply(this, arguments);
  };

  XHRProto.send = function (body) {
    const info = this.__spike;
    if (!info) return originalSend.apply(this, arguments);

    const rule = matchRule(info.url);

    if (!rule) {
      report({ kind: 'observe', api: 'xhr', url: info.url, method: info.method });
      return originalSend.apply(this, arguments);
    }

    report({ kind: 'mock', api: 'xhr', url: info.url, method: info.method, rule: rule.name });

    // XHR 的 status / responseText 等都是原型上的只读 getter，
    // 但在【实例】上重新 defineProperty 可以遮蔽掉原型的 getter。
    const self = this;
    const responseText = JSON.stringify(rule.body);
    const define = (prop, getter) => {
      try {
        Object.defineProperty(self, prop, { get: getter, configurable: true });
      } catch (e) {}
    };

    define('readyState', () => 4);
    define('status', () => rule.status);
    define('statusText', () => 'OK');
    define('responseURL', () => info.url);
    define('responseText', () => responseText);
    define('response', () =>
      self.responseType === 'json' ? rule.body : responseText
    );

    self.getAllResponseHeaders = () => 'content-type: application/json\r\n';
    self.getResponseHeader = (n) =>
      String(n).toLowerCase() === 'content-type' ? 'application/json' : null;

    // 异步派发，模拟真实网络的时序（同步派发会让某些库的状态机错乱）
    setTimeout(() => {
      try {
        // dispatchEvent 会同时触发 addEventListener 注册的监听
        // 和 onload / onreadystatechange 这类属性形式的监听
        self.dispatchEvent(new Event('readystatechange'));
        self.dispatchEvent(new ProgressEvent('load'));
        self.dispatchEvent(new ProgressEvent('loadend'));
      } catch (e) {
        report({ kind: 'error', api: 'xhr', url: info.url, error: String(e) });
      }
    }, 0);

    // 关键：不调用 originalSend，真实请求不会发出
  };

  // ══════════════════════════════════════════════════════════
  // 3. 自检：hook 是否还活着（有些页面会重置内置对象）
  // ══════════════════════════════════════════════════════════
  const ourFetch = window.fetch;
  const ourSend = XHRProto.send;

  function selfCheck(phase) {
    report({
      kind: 'selfcheck',
      phase,
      timing,
      fetchStillHooked: window.fetch === ourFetch,
      xhrStillHooked: XMLHttpRequest.prototype.send === ourSend,
      elapsed: Math.round(performance.now() - installedAt),
    });
  }

  document.addEventListener('DOMContentLoaded', () => selfCheck('DOMContentLoaded'));
  window.addEventListener('load', () => selfCheck('load'));
  selfCheck('install');

  // 暴露一个调试入口，方便你在页面 Console 里手动验证
  Object.defineProperty(window, '__MOCK_SPIKE__', {
    value: {
      timing,
      // 结构判断：我们的函数是否仍是最外层引用。
      // 注意 false 不代表失效 —— 页面可能在我们之后包了一层（见 wrapperInfo），
      // 只要我们在最底层、请求仍穿过我们，mock 就照样生效。真正的判据是 test()。
      isHooked: () => ({
        fetch: window.fetch === ourFetch,
        xhr: XMLHttpRequest.prototype.send === ourSend,
      }),
      // 如果被包了，看看是谁包的（常见是监控/APM SDK）
      wrapperInfo: () => ({
        fetch:
          window.fetch === ourFetch
            ? '(未被包裹，我们是最外层)'
            : String(window.fetch).slice(0, 300),
        xhrSend:
          XMLHttpRequest.prototype.send === ourSend
            ? '(未被包裹，我们是最外层)'
            : String(XMLHttpRequest.prototype.send).slice(0, 300),
      }),
      test: async () => {
        const out = {};
        try {
          const r = await fetch('/__spike_mock_fetch__');
          out.fetch = await r.json();
        } catch (e) {
          out.fetch = 'ERROR: ' + e.message;
        }
        out.xhr = await new Promise((resolve) => {
          const x = new XMLHttpRequest();
          x.open('GET', '/__spike_mock_xhr__');
          x.onload = () => {
            try {
              resolve(JSON.parse(x.responseText));
            } catch (e) {
              resolve('PARSE ERROR: ' + x.responseText);
            }
          };
          x.onerror = () => resolve('ERROR');
          x.send();
        });
        return out;
      },
    },
    configurable: true,
  });

  console.log(
    '%c[Mock Spike]%c 注入成功 · readyState=' +
      timing.readyState +
      ' · 已有脚本数=' +
      timing.scriptCountAtInstall +
      '\n在 Console 里跑 await __MOCK_SPIKE__.test() 可验证 Mock 是否生效',
    'background:#2563eb;color:#fff;padding:2px 6px;border-radius:3px',
    'color:#888'
  );
})();
