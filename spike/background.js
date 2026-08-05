/**
 * Service Worker —— 汇总观测结果
 *
 * 注意这里刻意用 chrome.storage.session 而不是全局变量：
 * SW 大约 30 秒无事件就会被杀，全局变量会丢。
 */

const MAX_EVENTS = 300;

// 事件监听必须同步注册在顶层，SW 重启时才不会漏事件
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'SPIKE_EVENT') {
    recordEvent(msg.payload, sender);
    return false;
  }

  if (msg?.type === 'GET_REPORT') {
    buildReport().then(sendResponse);
    return true; // ← 异步返回必须 return true，否则通道立刻关闭
  }

  if (msg?.type === 'CLEAR') {
    chrome.storage.session.set({ events: [] }).then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});

// 页面可能瞬间发出几十个请求。storage 是异步的，
// 如果每个事件都各自 get→push→set，就会互相覆盖导致漏记。
// 这里用一个 promise 链把写操作串起来。
let writeQueue = Promise.resolve();

function recordEvent(payload, sender) {
  writeQueue = writeQueue
    .then(async () => {
      const { events = [] } = await chrome.storage.session.get('events');
      events.push({
        ...payload,
        tabId: sender?.tab?.id,
        origin: sender?.origin || sender?.url,
      });
      // 只留最近的，避免无限增长
      const trimmed = events.slice(-MAX_EVENTS);
      await chrome.storage.session.set({ events: trimmed });

      const mocked = trimmed.filter((e) => e.kind === 'mock').length;
      const observed = trimmed.filter((e) => e.kind === 'observe').length;
      chrome.action.setBadgeText({ text: String(observed || '') });
      chrome.action.setBadgeBackgroundColor({
        color: mocked > 0 ? '#16a34a' : '#2563eb',
      });
    })
    .catch(() => {
      /* 单条失败不能卡死整条队列 */
    });
  return writeQueue;
}

async function buildReport() {
  const { events = [] } = await chrome.storage.session.get('events');

  const observed = events.filter((e) => e.kind === 'observe');
  const mocked = events.filter((e) => e.kind === 'mock');
  const checks = events.filter((e) => e.kind === 'selfcheck');
  const errors = events.filter((e) => e.kind === 'error');
  const latestCheck = checks[checks.length - 1];

  return {
    total: events.length,
    observed: observed.length,
    mocked: mocked.length,
    errors,
    byApi: {
      fetch: observed.filter((e) => e.api === 'fetch').length,
      xhr: observed.filter((e) => e.api === 'xhr').length,
    },
    timing: latestCheck?.timing,
    stillHooked: latestCheck
      ? { fetch: latestCheck.fetchStillHooked, xhr: latestCheck.xhrStillHooked }
      : null,
    recent: events.filter((e) => e.kind === 'observe' || e.kind === 'mock').slice(-20),
  };
}
