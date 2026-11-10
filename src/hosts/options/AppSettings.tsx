import { useEffect, useState } from 'react';
import type { MockStore, Settings, ThemeId } from '@core/types.js';
import {
  LOCAL_STORAGE_QUOTA_BYTES,
  estimateRuleCapacity,
  estimateStoreBytes,
  formatBytes,
} from '@core/store/storageUsage.js';
import { Switch } from '@ui/Switch.js';
import { GearIcon } from './ProjectSidebar.js';

interface Props {
  settings: Settings;
  store: MockStore;
  onSave: (patch: Partial<Settings>) => void;
  onOpenMcp: () => void;
  onClose: () => void;
}

const THEMES: Array<{
  id: ThemeId;
  name: string;
  description: string;
  colors: [string, string, string];
}> = [
  {
    id: 'circuit',
    name: 'Circuit Teal',
    description: '默认 · 平静、适合长时间调试',
    colors: ['#0F766E', '#E2F4F1', '#B45309'],
  },
  {
    id: 'signal',
    name: 'Signal Blue',
    description: '精确、状态对比最清楚',
    colors: ['#2563EB', '#E9F0FF', '#B45309'],
  },
  {
    id: 'slate',
    name: 'Slate Violet',
    description: '品牌感更强，保留蓝紫记忆',
    colors: ['#6754C7', '#EEEAFD', '#B45F16'],
  },
];

export function AppSettings({ settings, store, onSave, onOpenMcp, onClose }: Props) {
  const [theme, setTheme] = useState(settings.theme);
  const [captureEnabled, setCaptureEnabled] = useState(settings.captureEnabled);
  const [captureMaxCount, setCaptureMaxCount] = useState(String(settings.captureMaxCount));
  const [pageSize, setPageSize] = useState(String(settings.pageSize));
  const storageBytes = estimateStoreBytes(store);
  const storagePercent = Math.min(100, (storageBytes / LOCAL_STORAGE_QUOTA_BYTES) * 100);
  const estimatedRuleCapacity = estimateRuleCapacity(store);

  // 选中时立即预览整页效果；取消或关闭时由 store 中已保存的主题恢复。
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    return () => {
      document.documentElement.dataset.theme = settings.theme;
    };
  }, [theme, settings.theme]);

  const save = () => {
    const max = Number(captureMaxCount);
    const page = Number(pageSize);
    onSave({
      theme,
      captureEnabled,
      captureMaxCount: Number.isFinite(max) && max > 0 ? Math.floor(max) : settings.captureMaxCount,
      pageSize: Number.isFinite(page) && page > 0 ? Math.floor(page) : settings.pageSize,
    });
    onClose();
  };

  return (
    <>
      <div className="modal__backdrop" onClick={onClose} />
      <div className="modal modal--settings">
        <div className="settings-head">
          <div className="settings-head__icon"><GearIcon size={17} /></div>
          <div><strong>Mock Studio 设置</strong><span>外观、请求采集与 AI 协作</span></div>
          <button className="ghost" onClick={onClose}>关闭</button>
        </div>

        <div className="settings-body">
          <section className="settings-section">
            <div className="settings-section__title"><b>外观主题</b><span>所有扩展页面同步生效</span></div>
            <div className="theme-grid">
              {THEMES.map((item) => (
                <button
                  key={item.id}
                  className={`theme-card${theme === item.id ? ' theme-card--on' : ''}`}
                  onClick={() => setTheme(item.id)}
                >
                  <span className="theme-card__preview">
                    {item.colors.map((color) => <i key={color} style={{ background: color }} />)}
                  </span>
                  <span className="theme-card__copy"><b>{item.name}</b><small>{item.description}</small></span>
                  <span className="theme-card__check">{theme === item.id ? '✓' : ''}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section__title"><b>请求与列表</b><span>控制临时请求记录的采集规模</span></div>
            <div className="settings-row">
              <div><b>采集页面请求</b><span>关闭后仍会记录被 Mock 命中的请求</span></div>
              <Switch checked={captureEnabled} onChange={setCaptureEnabled} label="采集页面请求" />
            </div>
            <div className="settings-fields">
              <label><span>最多保留请求</span><input type="number" min="20" max="2000" value={captureMaxCount} onChange={(e) => setCaptureMaxCount(e.target.value)} /></label>
              <label><span>规则每页数量</span><input type="number" min="5" max="100" value={pageSize} onChange={(e) => setPageSize(e.target.value)} /></label>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section__title"><b>规则存储</b><span>容量取决于响应体大小，不是固定条数</span></div>
            <div className="settings-row">
              <div>
                <b>{store.rules.length} 条规则 · {formatBytes(storageBytes)} / {formatBytes(LOCAL_STORAGE_QUOTA_BYTES)}</b>
                <span>
                  {estimatedRuleCapacity
                    ? `按当前平均大小估算总容量约 ${estimatedRuleCapacity.toLocaleString()} 条（非硬上限）`
                    : '创建规则后会按实际平均大小估算可存条数'}
                </span>
              </div>
              <strong className={storagePercent >= 80 ? 'warn' : 'muted'}>{storagePercent.toFixed(1)}%</strong>
            </div>
            <div style={{ height: 6, borderRadius: 999, overflow: 'hidden', background: 'var(--surface-hover)' }}>
              <div
                style={{
                  width: `${Math.max(storagePercent, storageBytes > 0 ? 0.5 : 0)}%`,
                  height: '100%',
                  borderRadius: 999,
                  background: storagePercent >= 80 ? 'var(--warn)' : 'var(--accent)',
                }}
              />
            </div>
          </section>

          <section className="settings-section settings-section--mcp">
            <div className="settings-section__title"><b>AI 与 MCP</b><span>连接 Codex、Claude Code、Cursor 等本地客户端</span></div>
            <button className="settings-link" onClick={onOpenMcp}>
              <span className={`settings-link__status${settings.mcpEnabled ? ' is-on' : ''}`}></span>
              <span><b>MCP 桥设置</b><small>{settings.mcpEnabled ? `已启用 · 端口 ${settings.mcpPort}` : '未启用'}</small></span>
              <i>›</i>
            </button>
          </section>
        </div>

        <div className="modal__foot">
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={save}>保存设置</button>
        </div>
      </div>
    </>
  );
}
