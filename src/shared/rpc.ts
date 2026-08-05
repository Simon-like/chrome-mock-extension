/**
 * 与 Service Worker 通信的类型安全封装
 *
 * 直接用 chrome.runtime.sendMessage 的问题是没有类型约束，
 * 而且 SW 冷启动时会抛错需要处处 try/catch。集中封装一次。
 */

import type { Command, CommandResult } from '@core/command/types.js';
import type { MockStore } from '@core/types.js';
import type { CapturedRequest, SwBroadcast } from './messages.js';

async function send<T>(msg: unknown): Promise<T | null> {
  try {
    return (await chrome.runtime.sendMessage(msg)) as T;
  } catch {
    // SW 正在冷启动 —— 重试一次
    try {
      await new Promise((r) => setTimeout(r, 120));
      return (await chrome.runtime.sendMessage(msg)) as T;
    } catch {
      return null;
    }
  }
}

export async function fetchState(): Promise<MockStore | null> {
  const res = await send<{ type: 'STATE'; store: MockStore }>({ type: 'GET_STATE' });
  return res?.store ?? null;
}

export async function dispatchCommand(command: Command): Promise<CommandResult> {
  const res = await send<{ type: string } & CommandResult>({ type: 'DISPATCH', command });
  return res ?? { ok: false, error: '无法连接到后台服务，请重新加载扩展' };
}

export async function fetchCaptures(tabId?: number): Promise<CapturedRequest[]> {
  const res = await send<{ entries: CapturedRequest[] }>({ type: 'GET_CAPTURES', tabId });
  return res?.entries ?? [];
}

export async function clearCaptures(): Promise<void> {
  await send({ type: 'CLEAR_CAPTURES' });
}

/** 订阅 SW 的状态广播。返回取消订阅函数 */
export function subscribe(handler: (msg: SwBroadcast) => void): () => void {
  const listener = (msg: unknown) => {
    const m = msg as SwBroadcast;
    if (m?.type === 'STATE_CHANGED' || m?.type === 'CAPTURE_ADDED') handler(m);
    return false;
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
