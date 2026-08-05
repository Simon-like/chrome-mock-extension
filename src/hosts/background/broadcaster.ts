/**
 * 变更广播
 *
 * SW 是唯一状态持有者，其他所有地方都是订阅者、持有只读副本。
 * 状态一变就要通知：所有 tab 的引擎（下发新规则）+ 所有打开的 UI。
 */

import type { CapturedRequest, SwBroadcast } from '@shared/messages.js';
import { buildSnapshot } from './stateManager.js';

/**
 * DevTools 面板的长连接。
 *
 * 用 Port 而非 sendMessage：请求流量大（一个 SPA 几分钟上千个请求）
 * 且只在 F12 打开时需要。Port 建一次连接持续用，且 onDisconnect 让 SW
 * 能在 F12 关闭的瞬间停止推送，不做无谓的工作。
 */
interface DevtoolsSubscriber {
  port: chrome.runtime.Port;
  /** 只关心这个 tab 的请求。undefined 表示还没订阅 */
  tabId?: number;
}

const devtoolsSubscribers = new Set<DevtoolsSubscriber>();

export function registerDevtoolsPort(port: chrome.runtime.Port): void {
  const sub: DevtoolsSubscriber = { port };
  devtoolsSubscribers.add(sub);

  port.onMessage.addListener((msg: { type?: string; tabId?: number }) => {
    if (msg?.type === 'SUBSCRIBE') sub.tabId = msg.tabId;
    if (msg?.type === 'UNSUBSCRIBE') sub.tabId = undefined;
  });

  port.onDisconnect.addListener(() => devtoolsSubscribers.delete(sub));
}

/** 状态变更：所有 UI 都要知道 */
export function notifyUi(msg: SwBroadcast): void {
  // popup / options 没打开时 sendMessage 会抛错，忽略即可
  chrome.runtime.sendMessage(msg).catch(() => undefined);

  for (const sub of devtoolsSubscribers) {
    postSafely(sub, msg);
  }
}

/**
 * 请求事件：只推给关心这个 tab 的订阅者。
 *
 * 不做过滤的话，同时开着多个标签页调试时，各个 DevTools 面板会互相串台 ——
 * 你在 A 页面的面板里看到 B 页面的请求，无法排查问题。
 */
export function notifyCapture(entry: CapturedRequest, tabId: number | undefined): void {
  const msg: SwBroadcast = { type: 'CAPTURE_ADDED', entry };

  for (const sub of devtoolsSubscribers) {
    // 订阅了具体 tab 的，只收该 tab 的；没订阅 tab 的收全部
    if (sub.tabId !== undefined && sub.tabId !== tabId) continue;
    postSafely(sub, msg);
  }
}

function postSafely(sub: DevtoolsSubscriber, msg: SwBroadcast): void {
  try {
    sub.port.postMessage(msg);
  } catch {
    // Port 已失效（面板关了但 onDisconnect 还没触发）
    devtoolsSubscribers.delete(sub);
  }
}

/**
 * 把最新规则推给所有 tab 的引擎。
 *
 * 为什么要推给【所有】tab：用户可能同时开着多个标签页调同一个站点，
 * 在 Options 里改了规则，所有页面都该立刻生效，而不是只有当前这个。
 */
export async function broadcastSnapshotToAllTabs(): Promise<void> {
  const snapshot = await buildSnapshot();
  const tabs = await chrome.tabs.query({});

  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'RULES_SNAPSHOT', snapshot });
      } catch {
        // 该 tab 没有 content script（chrome:// 页面、扩展页面等），正常现象
      }
    }),
  );
}
