/**
 * 请求流存储
 *
 * 存 storage.session 而非 local：请求流是临时数据，浏览器关了就该清空。
 * 用环形缓冲定长保存：一个正常 SPA 几分钟能发上千个请求，
 * 无限累积会撑爆 storage（10MB）并让广播数据量线性增长。
 */

import type { CapturedRequest } from '@shared/messages.js';

const SESSION_KEY = 'captures';
const DEFAULT_MAX = 200;

let writeQueue: Promise<unknown> = Promise.resolve();

export function addCapture(
  entry: CapturedRequest,
  tabId: number | undefined,
  max = DEFAULT_MAX,
): Promise<void> {
  const task = writeQueue.then(async () => {
    const stored = await chrome.storage.session.get(SESSION_KEY);
    const list: StoredCapture[] = Array.isArray(stored[SESSION_KEY])
      ? stored[SESSION_KEY]
      : [];

    list.push({ ...entry, tabId });

    // 环形缓冲：超出容量时丢最旧的
    const trimmed = list.length > max ? list.slice(list.length - max) : list;
    await chrome.storage.session.set({ [SESSION_KEY]: trimmed });
  });

  writeQueue = task.catch(() => undefined);
  return task;
}

export async function getCaptures(tabId?: number): Promise<StoredCapture[]> {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  const list: StoredCapture[] = Array.isArray(stored[SESSION_KEY])
    ? stored[SESSION_KEY]
    : [];
  return tabId === undefined ? list : list.filter((e) => e.tabId === tabId);
}

export async function clearCaptures(): Promise<void> {
  await chrome.storage.session.set({ [SESSION_KEY]: [] });
}

export interface StoredCapture extends CapturedRequest {
  tabId?: number;
}
