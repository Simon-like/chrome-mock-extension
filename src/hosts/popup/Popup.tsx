/**
 * Popup —— 轻量控制面板
 *
 * 职责刻意限制为：总开关、规则概览、快速跳转。
 * Popup 一关就整个销毁，state 全没，所以不放任何编辑功能。
 */

import { useEffect, useState } from 'react';
import { useStore } from '@ui/useStore.js';
import type { Rule } from '@core/types.js';

export function Popup() {
  const { store, loading, error, run } = useStore();
  const [engineStats, setEngineStats] = useState<EngineStats | null>(null);

  useEffect(() => {
    void readEngineStats().then(setEngineStats);
  }, []);

  if (loading) {
    return <div style={{ width: 340, padding: 16 }} className="muted">加载中…</div>;
  }

  if (error || !store) {
    return (
      <div style={{ width: 340, padding: 16 }}>
        <p className="bad">{error ?? '状态不可用'}</p>
      </div>
    );
  }

  const activeRules = store.rules.filter((r) => r.enabled);
  const virtualCount = activeRules.filter((r) => r.kind === 'virtual').length;

  return (
    <div style={{ width: 340, padding: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <strong style={{ fontSize: 14 }}>Mock Studio</strong>
        <button
          className={store.enabled ? 'primary' : ''}
          onClick={() =>
            void run({ type: 'SET_GLOBAL_ENABLED', payload: { enabled: !store.enabled } })
          }
        >
          {store.enabled ? '已启用' : '已停用'}
        </button>
      </div>

      <div className="muted" style={{ fontSize: 11, marginBottom: 12 }}>
        快捷键 Alt+M 可直接切换总开关
      </div>

      {/* 虚拟接口的风险提示：关掉总开关后这些接口会真的 404 */}
      {store.enabled && virtualCount > 0 && (
        <div
          style={{
            padding: '6px 9px',
            marginBottom: 10,
            borderRadius: 6,
            background: 'rgba(217,119,6,.12)',
            fontSize: 11,
          }}
          className="warn"
        >
          有 {virtualCount} 个虚拟接口正在生效。停用后这些请求会真的失败。
        </div>
      )}

      <Stat label="启用规则" value={`${activeRules.length} / ${store.rules.length}`} />
      {engineStats && (
        <>
          <Stat label="本页已拦截" value={String(engineStats.observed + engineStats.mocked)} />
          <Stat label="本页 Mock 命中" value={String(engineStats.mocked)} highlight={engineStats.mocked > 0} />
          {engineStats.missedBeforeReady > 0 && (
            <div className="warn" style={{ fontSize: 11, marginTop: 8 }}>
              有 {engineStats.missedBeforeReady} 个请求在规则加载前发出，刷新页面可确保全部生效
            </div>
          )}
        </>
      )}

      {store.rules.length > 0 && (
        <div style={{ marginTop: 12, maxHeight: 200, overflowY: 'auto' }}>
          {store.rules.slice(0, 8).map((r) => (
            <RuleRow
              key={r.id}
              rule={r}
              onToggle={(enabled) =>
                void run({ type: 'TOGGLE_RULE', payload: { id: r.id, enabled } })
              }
            />
          ))}
        </div>
      )}

      <div className="row" style={{ marginTop: 14, gap: 6 }}>
        <button style={{ flex: 1 }} onClick={() => chrome.runtime.openOptionsPage()}>
          管理规则
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div
      className="row"
      style={{ justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--border)' }}
    >
      <span className="muted">{label}</span>
      <strong className={highlight ? 'ok' : undefined}>{value}</strong>
    </div>
  );
}

function RuleRow({ rule, onToggle }: { rule: Rule; onToggle: (enabled: boolean) => void }) {
  return (
    <div className="row" style={{ padding: '5px 0', gap: 6 }}>
      <input
        type="checkbox"
        checked={rule.enabled}
        onChange={(e) => onToggle(e.target.checked)}
        style={{ width: 'auto', margin: 0 }}
      />
      <span className={`tag tag-${rule.kind}`}>{rule.kind === 'virtual' ? '虚拟' : '覆盖'}</span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {rule.name}
      </span>
      {/* 命中数是诊断线索：0 表示 URL 没匹配上 */}
      <span className="muted mono" style={{ fontSize: 10 }}>
        {rule.meta.hitCount}
      </span>
    </div>
  );
}

interface EngineStats {
  observed: number;
  mocked: number;
  rulesLoaded: number;
  missedBeforeReady: number;
}

/**
 * 读取当前页面引擎的运行统计。
 *
 * 注意必须注入到页面的 MAIN world 去读 —— popup 自己是扩展页面，
 * 它的 window 上没有 __MOCK_STUDIO__。
 */
async function readEngineStats(): Promise<EngineStats | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/.test(tab.url ?? '')) return null;

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        const api = (window as unknown as { __MOCK_STUDIO__?: { stats: unknown } }).__MOCK_STUDIO__;
        return api ? api.stats : null;
      },
    });
    return (results[0]?.result as EngineStats | null) ?? null;
  } catch {
    return null;
  }
}
