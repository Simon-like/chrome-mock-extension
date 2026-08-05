/**
 * 状态管理 —— Service Worker 是唯一的状态持有者
 *
 * 两个必须尊重的约束（03 文档 §3.1）：
 *   1. SW 约 30 秒无事件就被杀，全局变量会丢 → 所有状态必须落 storage
 *   2. storage 是异步的，并发读写会互相覆盖 → 写操作必须串行化
 *
 * 第 2 条在 Spike 阶段已经踩过一次（页面瞬间发几十个请求时统计数字会失真）。
 */

import { reduce, type ReduceContext } from '@core/command/reducer.js';
import type { Command, CommandResult } from '@core/command/types.js';
import { migrate } from '@core/store/migrate.js';
import { clearMatcherCache } from '@core/engine/matcher.js';
import { STORE_KEY, type MockStore } from '@core/types.js';
import type { EngineSnapshot } from '@shared/messages.js';

/** 内存缓存。SW 存活期间避免反复读 storage，被杀后会自动从 storage 恢复 */
let cached: MockStore | null = null;

/** 快照版本号，每次状态变更 +1，用于引擎判断是否需要更新 */
let revision = 0;

/**
 * 写操作串行化队列。
 * 不用锁而用 promise 链，因为 JS 单线程，promise 链就是最简单的互斥。
 */
let writeQueue: Promise<unknown> = Promise.resolve();

const ctx: ReduceContext = {
  idFactory: () => crypto.randomUUID(),
  now: () => Date.now(),
};

export async function getState(): Promise<MockStore> {
  if (cached) return cached;

  const raw = await chrome.storage.local.get(STORE_KEY);
  const { store, reset, reason } = migrate(raw[STORE_KEY]);

  if (reset && raw[STORE_KEY] !== undefined) {
    console.warn('[MockStudio] 配置已重置：', reason);
  }
  cached = store;
  return store;
}

export function getRevision(): number {
  return revision;
}

/**
 * 提交一个命令。所有状态变更的唯一入口（A3）。
 *
 * UI 点击、DevTools 转 Mock、V2 的 MCP 下发，全部走这里 ——
 * 单一入口 = 单一真相 = 单一 bug 面。
 */
export function dispatch(cmd: Command): Promise<CommandResult> {
  const task = writeQueue.then(async (): Promise<CommandResult> => {
    const store = await getState();
    const { store: next, result } = reduce(store, cmd, ctx);

    if (!result.ok) return result;

    cached = next;
    revision++;

    // 规则变了，matcher 里编译好的正则/通配符缓存要失效
    clearMatcherCache();

    await chrome.storage.local.set({ [STORE_KEY]: next });
    return result;
  });

  // 单条失败不能卡死整条队列
  writeQueue = task.catch(() => undefined);
  return task;
}

/**
 * 构造下发给引擎的快照。
 * 只带引擎需要的字段 —— 每个 tab 都要传一份，能省就省。
 */
export async function buildSnapshot(): Promise<EngineSnapshot> {
  const store = await getState();
  return {
    enabled: store.enabled,
    rules: store.rules,
    groups: store.groups,
    projects: store.projects,
    shellTemplates: store.shellTemplates,
    captureEnabled: store.settings.captureEnabled,
    revision,
  };
}

/** 外部（如 storage 被别的实例改动）导致缓存失效时调用 */
export function invalidateCache(): void {
  cached = null;
  revision++;
  clearMatcherCache();
}
