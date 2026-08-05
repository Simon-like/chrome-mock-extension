/**
 * 状态订阅 hook
 *
 * 各 UI 页面（popup / options / devtools）共用。
 * 模式：挂载时拉一次全量，之后靠广播增量更新。
 */

import { useCallback, useEffect, useState } from 'react';
import type { Command, CommandResult } from '@core/command/types.js';
import type { MockStore } from '@core/types.js';
import { dispatchCommand, fetchState, subscribe } from '@shared/rpc.js';

export interface UseStoreResult {
  store: MockStore | null;
  loading: boolean;
  error: string | null;
  /**
   * 提交命令。返回完整结果而不只是 boolean ——
   * 新建类命令需要拿到 createdId，否则调用方无法把新建态切成编辑态，
   * 会导致「保存两次创建出两条规则」。
   */
  run: (cmd: Command) => Promise<CommandResult>;
}

export function useStore(): UseStoreResult {
  const [store, setStore] = useState<MockStore | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    void fetchState().then((s) => {
      if (!alive) return;
      if (s) setStore(s);
      else setError('无法连接到后台服务，请在 chrome://extensions 重新加载扩展');
      setLoading(false);
    });

    const unsub = subscribe((msg) => {
      if (msg.type === 'STATE_CHANGED') setStore(msg.store);
    });

    return () => {
      alive = false;
      unsub();
    };
  }, []);

  const run = useCallback(async (cmd: Command): Promise<CommandResult> => {
    const result = await dispatchCommand(cmd);
    setError(result.ok ? null : (result.error ?? '操作失败'));
    return result;
  }, []);

  return { store, loading, error, run };
}
