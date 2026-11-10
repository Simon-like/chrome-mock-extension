/**
 * Service Worker 入口
 *
 * ⚠️ 所有事件监听必须【同步注册在顶层】。
 * SW 重启时会重新执行整个文件，如果监听器写在异步回调里，
 * 重启后可能来不及注册就丢事件（03 文档 §3.1）。
 */

import type { Command } from '@core/command/types.js';
import { DEVTOOLS_PORT_NAME, type CapturedRequest } from '@shared/messages.js';
import { addCapture, clearCaptures, getCaptures } from './captureStore.js';
import {
  broadcastSnapshotToAllTabs,
  notifyCapture,
  notifyUi,
  registerDevtoolsPort,
} from './broadcaster.js';
import { buildSnapshot, dispatch, getState } from './stateManager.js';
import {
  RECONNECT_ALARM,
  getBridgeStatus,
  initBridge,
  syncBridge,
} from './mcpBridge.js';

// ═══════════════════════════════════════════════════════════
// 消息路由（顶层同步注册）
// ═══════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 异步分支必须 return true，否则通道立刻关闭、sendResponse 永远发不出去
  switch (msg?.type) {
    case 'GET_SNAPSHOT':
      buildSnapshot().then((snapshot) => sendResponse({ snapshot }));
      return true;

    case 'GET_STATE':
      getState().then((store) => sendResponse({ type: 'STATE', store }));
      return true;

    case 'DISPATCH':
      handleDispatch(msg.command as Command).then(sendResponse);
      return true;

    case 'REQUEST_EVENT':
      handleRequestEvent(msg.entry as CapturedRequest, sender.tab?.id);
      return false;

    case 'GET_CAPTURES':
      getCaptures(msg.tabId).then((entries) => sendResponse({ type: 'CAPTURES', entries }));
      return true;

    case 'CLEAR_CAPTURES':
      clearCaptures().then(() => sendResponse({ type: 'OK' }));
      return true;

    case 'GET_BRIDGE_STATUS':
      sendResponse({ type: 'BRIDGE_STATUS', status: getBridgeStatus() });
      return false;

    default:
      return false;
  }
});

async function handleDispatch(command: Command) {
  const result = await dispatch(command);

  if (result.ok) {
    await afterDispatch();
    // 改的是 MCP 设置就顺手把桥同步一下 —— 用户在设置里点了开关，
    // 期待的是「立刻生效」，而不是「重启浏览器后生效」
    if (command.type === 'UPDATE_SETTINGS') void syncBridge();
  }

  return { type: 'DISPATCH_RESULT', ...result };
}

/** 状态变了之后的副作用：更新徽章、下发新规则、通知所有 UI */
async function afterDispatch() {
  await Promise.all([updateBadge(), broadcastSnapshotToAllTabs(), notifyStateChanged()]);
}

async function notifyStateChanged() {
  const store = await getState();
  notifyUi({ type: 'STATE_CHANGED', store });
}

async function handleRequestEvent(entry: CapturedRequest, tabId: number | undefined) {
  const store = await getState();

  // 命中了规则就累加统计（这是诊断功能的数据来源，见 05 §2.3 决策四）
  if (entry.mocked && entry.ruleId) {
    await dispatch({ type: 'RECORD_HIT', payload: { ruleId: entry.ruleId, at: entry.at } });
  }

  if (store.settings.captureEnabled || entry.mocked) {
    await addCapture(entry, tabId, store.settings.captureMaxCount);
    // 按 tabId 定向推送，避免多标签页调试时各面板互相串台
    notifyCapture(entry, tabId);
  }
}

// ═══════════════════════════════════════════════════════════
// DevTools 长连接
// ═══════════════════════════════════════════════════════════

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === DEVTOOLS_PORT_NAME) {
    registerDevtoolsPort(port);
  }
});

// ═══════════════════════════════════════════════════════════
// 生命周期与快捷键
// ═══════════════════════════════════════════════════════════

chrome.runtime.onInstalled.addListener((details) => {
  void updateBadge();
  // 首次安装打开引导页 —— 从 GitHub 下载装上的用户最容易在
  // 「接下来干嘛」这一步流失，直接把他带到带引导横幅的规则管理页。
  // options_page 的路径以 manifest 为准，构建工具改名也不会写死
  if (details.reason === 'install') {
    const optionsPage = chrome.runtime.getManifest().options_page;
    if (optionsPage) {
      void chrome.tabs.create({ url: chrome.runtime.getURL(optionsPage) + '?welcome=1' });
    }
  }
});

chrome.runtime.onStartup.addListener(() => {
  void updateBadge();
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-global') {
    void toggleGlobal();
  }
});

async function toggleGlobal() {
  const store = await getState();
  await handleDispatch({
    type: 'SET_GLOBAL_ENABLED',
    payload: { enabled: !store.enabled },
  });
}

/** 页面导航完成后重新下发规则（SPA 路由切换不会重新注入 content script） */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    void pushSnapshotToTab(tabId);
  }
});

async function pushSnapshotToTab(tabId: number) {
  try {
    const snapshot = await buildSnapshot();
    await chrome.tabs.sendMessage(tabId, { type: 'RULES_SNAPSHOT', snapshot });
  } catch {
    // content script 还没就绪 —— 无妨，它自己会主动来拉（见 content/index.ts）
  }
}

// ═══════════════════════════════════════════════════════════
// 徽章：一眼看出 mock 是否开着、有几条规则生效
// ═══════════════════════════════════════════════════════════

async function updateBadge() {
  const store = await getState();
  const activeCount = store.rules.filter((r) => r.enabled).length;

  if (!store.enabled) {
    await chrome.action.setBadgeText({ text: 'off' });
    await chrome.action.setBadgeBackgroundColor({ color: '#9ca3af' });
    return;
  }

  await chrome.action.setBadgeText({ text: activeCount > 0 ? String(activeCount) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
}

// ═══════════════════════════════════════════════════════════
// MCP 桥
// ═══════════════════════════════════════════════════════════

initBridge({ getState, dispatch, afterDispatch });

/**
 * SW 被回收后靠 alarm 唤醒重连。
 *
 * 心跳能让**活着的** SW 一直活着（Chrome 116+ WS 收发会重置空闲计时器），
 * 但拦不住浏览器出于别的原因回收它。所以还要一层兜底：
 * 醒来时 syncBridge 会发现没连上，自己重连。
 * 1 分钟是 chrome.alarms 允许的最小周期。
 */
chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) void syncBridge();
});

// 冷启动时也刷一次
void updateBadge();
void syncBridge();
