/**
 * Popup —— 轻量控制面板
 *
 * 职责刻意限制为：总开关、规则概览、快速跳转。
 * Popup 一关就整个销毁，state 全没，所以不放任何编辑功能。
 */

import { useEffect, useState } from 'react';
import { useStore } from '@ui/useStore.js';
import { Switch } from '@ui/Switch.js';
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

      <DynamicProbe />

      <div className="row" style={{ marginTop: 14, gap: 6 }}>
        <button style={{ flex: 1 }} onClick={() => chrome.runtime.openOptionsPage()}>
          管理规则
        </button>
      </div>
    </div>
  );
}

/**
 * 动态响应可行性探测（Spike 工具，见 docs/experiments/SPIKE-0002-dynamic-response.md）
 *
 * 为什么做成手动按钮而不是自动跑：探测被 CSP 拦下会派发 securitypolicyviolation，
 * 站点若配了 report-uri 就会收到一条我们制造的告警。这属于「在别人家里留脚印」，
 * 必须由人主动按下才做。
 */
function DynamicProbe() {
  const [result, setResult] = useState<{ available: boolean; reason?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const probe = async () => {
    setBusy(true);
    setResult(await probeDynamicSupport());
    setBusy(false);
  };

  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
      <button className="ghost" style={{ width: '100%' }} disabled={busy} onClick={probe}>
        {busy ? '探测中…' : '探测：本站能否用动态响应'}
      </button>
      {result && (
        <div
          className={result.available ? 'ok' : 'warn'}
          style={{ fontSize: 11, marginTop: 6, lineHeight: 1.5 }}
        >
          {result.available
            ? '✓ 本站允许 new Function —— 动态响应可以落地'
            : `✗ 本站 CSP 禁用了 unsafe-eval —— 动态响应在此站不可用${
                result.reason ? `（${result.reason}）` : ''
              }`}
        </div>
      )}
    </div>
  );
}

/** 必须在 MAIN world 跑：受不受 CSP 管，取决于代码在【页面的】realm 里执行 */
async function probeDynamicSupport(): Promise<{ available: boolean; reason?: string }> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/.test(tab.url ?? '')) {
      return { available: false, reason: '当前标签页不是 http(s) 页面' };
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        const api = (
          window as unknown as {
            __MOCK_STUDIO__?: { probeDynamicSupport(): { available: boolean; reason?: string } };
          }
        ).__MOCK_STUDIO__;
        if (!api) return { available: false, reason: '引擎未注入，请刷新页面' };
        return api.probeDynamicSupport();
      },
    });
    return (
      (results[0]?.result as { available: boolean; reason?: string } | undefined) ?? {
        available: false,
        reason: '探测无返回',
      }
    );
  } catch (e) {
    return { available: false, reason: (e as Error).message };
  }
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
      {/* 开关而非复选框 —— 全局统一：开关是状态，复选框是选择。见 ui/Switch.tsx */}
      <Switch
        size="sm"
        checked={rule.enabled}
        onChange={onToggle}
        label={`启用 / 停用「${rule.name}」`}
        title={rule.enabled ? '已启用 —— 点击停用' : '已停用 —— 点击启用'}
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
