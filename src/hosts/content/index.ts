/**
 * ISOLATED world 中继站
 *
 * 唯一职责：在 MAIN world 和 Service Worker 之间转发消息。
 * MAIN world 用不了 chrome.*，SW 也没法直接 postMessage 给页面，
 * 所以必须有这一层。
 *
 * 见 03 文档 §2.4 —— 这条三段式链路是插件的主动脉。
 */

import type { CapturedRequest, EngineSnapshot, PageMessage } from '@shared/messages.js';
import { PAGE_CHANNEL } from '@shared/messages.js';

// ── MAIN → SW ────────────────────────────────────────────
window.addEventListener('message', (event: MessageEvent) => {
  // 安全校验：postMessage 页面也能伪造
  if (event.source !== window) return;
  const data = event.data as PageMessage | undefined;
  if (!data || data.channel !== PAGE_CHANNEL) return;
  if (data.type !== 'REQUEST_EVENT') return;

  void forwardToSw(data.entry);
});

async function forwardToSw(entry: CapturedRequest): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: 'REQUEST_EVENT', entry });
  } catch {
    // SW 正在重启时 sendMessage 会抛错。请求观测是尽力而为的，丢一两条无妨
  }
}

// ── SW → MAIN ────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg: { type?: string; snapshot?: EngineSnapshot }) => {
  if (msg?.type === 'RULES_SNAPSHOT' && msg.snapshot) {
    pushSnapshot(msg.snapshot);
  }
  return false;
});

function pushSnapshot(snapshot: EngineSnapshot): void {
  window.postMessage({ channel: PAGE_CHANNEL, type: 'RULES_SNAPSHOT', snapshot }, '*');
}

/**
 * 主动拉一次规则。
 *
 * 关键时序问题：SW 不知道我们什么时候注入完成，而引擎必须尽快拿到规则
 * （拿到之前的请求会 fail-open 放行，mock 不生效）。所以由 content script
 * 一启动就主动索要，而不是等 SW 推送。
 */
async function requestInitialSnapshot(): Promise<void> {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_SNAPSHOT' });
    if (res?.snapshot) pushSnapshot(res.snapshot);
  } catch {
    // SW 冷启动可能失败，重试一次
    setTimeout(() => {
      chrome.runtime
        .sendMessage({ type: 'GET_SNAPSHOT' })
        .then((res) => {
          if (res?.snapshot) pushSnapshot(res.snapshot);
        })
        .catch(() => {});
    }, 100);
  }
}

void requestInitialSnapshot();
