/**
 * DevTools「Mock」面板 —— 产品的主战场
 *
 * 承担两件事，都是差异化的关键：
 *
 * 1. F5 实时请求面板：补偿注入式方案「改动不出现在 Network 面板」这个先天缺陷。
 *    这不是锦上添花 —— 没有它，用户根本无法确认 mock 到底生效了没有。
 *
 * 2. F6 Capture-to-Mock：从真实请求一键转规则，真实响应自动填进编辑器。
 *    这是 D1，也是所有竞品做得最不够的地方。
 *
 * 文件名刻意叫 PanelApp 而不是 Panel —— macOS 文件系统大小写不敏感，
 * Panel.tsx 会和入口 panel.tsx 撞成同一个文件。
 */

import { useEffect, useMemo, useState } from 'react';
import { captureToRuleDraft } from '@core/capture/toRule.js';
import type { CapturedRequest } from '@shared/messages.js';
import { DEVTOOLS_PORT_NAME } from '@shared/messages.js';
import { clearCaptures, fetchCaptures } from '@shared/rpc.js';
import type { Rule, RuleDraft } from '@core/types.js';
import { useStore } from '@ui/useStore.js';
import { Splitter, useResizable } from '@ui/Splitter.js';
import { RuleEditor } from '../options/RuleEditor.js';

const inspectedTabId = chrome.devtools.inspectedWindow.tabId;

/** DevTools 面板通常比较窄，默认给小一点 */
const SIDE_DEFAULT_WIDTH = 480;

export function PanelApp() {
  const { store, run } = useStore();
  const [entries, setEntries] = useState<CapturedRequest[]>([]);
  const [filter, setFilter] = useState('');
  const [onlyMocked, setOnlyMocked] = useState(false);
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [draftKey, setDraftKey] = useState(0);
  const [selected, setSelected] = useState<CapturedRequest | null>(null);

  // 编辑器和详情面板共用一个宽度设置 —— 它们占的是同一块位置，
  // 分开记的话来回切换会跳动
  const sidePane = useResizable({
    storageKey: 'mockstudio.devtools.sideWidth',
    defaultWidth: SIDE_DEFAULT_WIDTH,
    minWidth: 320,
  });

  // 请求流量大且只在 F12 打开时需要 → 用 Port 长连而非一次性消息（05 §4.2）
  useEffect(() => {
    void fetchCaptures(inspectedTabId).then(setEntries);

    const port = chrome.runtime.connect({ name: DEVTOOLS_PORT_NAME });
    port.postMessage({ type: 'SUBSCRIBE', tabId: inspectedTabId });

    port.onMessage.addListener((msg: { type?: string; entry?: CapturedRequest }) => {
      if (msg?.type === 'CAPTURE_ADDED' && msg.entry) {
        setEntries((prev) => [...prev, msg.entry!].slice(-300));
      }
    });

    return () => port.disconnect();
  }, []);

  const visible = useMemo(() => {
    const kw = filter.trim().toLowerCase();
    return entries.filter((e) => {
      if (onlyMocked && !e.mocked) return false;
      if (kw && !e.url.toLowerCase().includes(kw)) return false;
      return true;
    });
  }, [entries, filter, onlyMocked]);

  const mockedCount = entries.filter((e) => e.mocked).length;

  /** F6 的核心动线：点一下 → 真实响应自动填进编辑器 */
  const convertToMock = (entry: CapturedRequest) => {
    setDraft(captureToRuleDraft(entry, store?.shellTemplates ?? []));
    setDraftKey((k) => k + 1);
    setCreatedId(null); // 换了一条请求，重新算作新建
    setSelected(entry);
  };

  /**
   * 保存后不关闭编辑器（与 Options 一致）。
   * 新建成功要记住 id，否则再点保存会重复创建。
   */
  const [createdId, setCreatedId] = useState<string | null>(null);

  const saveDraft = async (d: RuleDraft): Promise<boolean> => {
    if (createdId) {
      const res = await run({ type: 'UPDATE_RULE', payload: { id: createdId, patch: d } });
      return res.ok;
    }
    const res = await run({ type: 'CREATE_RULE', payload: { draft: d } });
    if (res.ok && res.createdId) setCreatedId(res.createdId);
    return res.ok;
  };

  const closeEditor = () => {
    setDraft(null);
    setCreatedId(null);
  };

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <Toolbar
          filter={filter}
          onFilter={setFilter}
          onlyMocked={onlyMocked}
          onOnlyMocked={setOnlyMocked}
          total={entries.length}
          mocked={mockedCount}
          globalEnabled={store?.enabled ?? true}
          onToggleGlobal={() =>
            void run({
              type: 'SET_GLOBAL_ENABLED',
              payload: { enabled: !(store?.enabled ?? true) },
            })
          }
          onClear={async () => {
            await clearCaptures();
            setEntries([]);
          }}
        />

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {visible.length === 0 ? (
            <div className="empty">
              {entries.length === 0 ? (
                <>
                  暂无请求。
                  <br />
                  <span style={{ fontSize: 11 }}>刷新页面或触发操作后，请求会出现在这里</span>
                </>
              ) : (
                '没有符合筛选条件的请求'
              )}
            </div>
          ) : (
            visible.map((e) => (
              <EntryRow
                key={e.id}
                entry={e}
                selected={selected?.id === e.id}
                matchedRule={store?.rules.find((r) => r.id === e.ruleId)}
                onConvert={() => convertToMock(e)}
                onSelect={() => setSelected(e)}
              />
            ))
          )}
        </div>
      </div>

      {(draft || selected) && (
        <Splitter
          onResize={sidePane.setWidth}
          onDragStateChange={sidePane.setDragging}
          onReset={() => sidePane.setWidth(SIDE_DEFAULT_WIDTH)}
        />
      )}

      {draft ? (
        <div style={{ width: sidePane.width, flexShrink: 0, minWidth: 0 }}>
          <RuleEditor
            key={draftKey}
            initialDraft={draft}
            shellTemplates={store?.shellTemplates ?? []}
            onSave={saveDraft}
            onClose={closeEditor}
          />
        </div>
      ) : (
        selected && (
          <div style={{ width: sidePane.width, flexShrink: 0, minWidth: 0 }}>
            <DetailPane
              entry={selected}
              onConvert={() => convertToMock(selected)}
              onClose={() => setSelected(null)}
            />
          </div>
        )
      )}
    </div>
  );
}

function Toolbar(props: {
  filter: string;
  onFilter: (v: string) => void;
  onlyMocked: boolean;
  onOnlyMocked: (v: boolean) => void;
  total: number;
  mocked: number;
  globalEnabled: boolean;
  onToggleGlobal: () => void;
  onClear: () => void;
}) {
  return (
    <div
      className="row"
      style={{
        padding: '8px 10px',
        gap: 8,
        borderBottom: '1px solid var(--border)',
        flexWrap: 'wrap',
        flexShrink: 0,
      }}
    >
      <button
        className={props.globalEnabled ? 'primary' : ''}
        style={{ padding: '3px 9px', fontSize: 11 }}
        onClick={props.onToggleGlobal}
      >
        Mock {props.globalEnabled ? '开' : '关'}
      </button>

      <input
        placeholder="筛选 URL"
        value={props.filter}
        onChange={(e) => props.onFilter(e.target.value)}
        style={{ width: 190, padding: '3px 7px' }}
      />

      <label className="row" style={{ gap: 4, margin: 0, fontSize: 11, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={props.onlyMocked}
          onChange={(e) => props.onOnlyMocked(e.target.checked)}
          style={{ width: 'auto', margin: 0 }}
        />
        只看已 Mock
      </label>

      <span style={{ flex: 1 }} />

      <span className="muted" style={{ fontSize: 11 }}>
        {props.total} 个请求 ·{' '}
        <span className={props.mocked > 0 ? 'ok' : undefined}>{props.mocked} 个已 Mock</span>
      </span>

      <button style={{ padding: '3px 9px', fontSize: 11 }} onClick={props.onClear}>
        清空
      </button>
      <button
        style={{ padding: '3px 9px', fontSize: 11 }}
        onClick={() => chrome.runtime.openOptionsPage()}
      >
        规则管理
      </button>
    </div>
  );
}

function EntryRow({
  entry,
  selected,
  matchedRule,
  onConvert,
  onSelect,
}: {
  entry: CapturedRequest;
  selected: boolean;
  matchedRule?: Rule;
  onConvert: () => void;
  onSelect: () => void;
}) {
  const cls = ['req-row', entry.mocked && 'mocked', selected && 'selected']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls} onClick={onSelect}>
      {/* 被 Mock 的请求要一眼能认出来 —— 这是本面板存在的理由 */}
      <span style={{ width: 42, flexShrink: 0 }}>
        {entry.mocked && <span className="tag tag-mock">MOCK</span>}
      </span>

      <span className="faint mono" style={{ width: 44, flexShrink: 0 }}>
        {entry.method}
      </span>

      <span className="mono grow truncate" title={entry.url}>
        {shortUrl(entry.url)}
      </span>

      {matchedRule && (
        <span className="muted truncate" style={{ fontSize: 10.5, maxWidth: 140, flexShrink: 0 }}>
          ← {matchedRule.name}
        </span>
      )}

      <span
        className={entry.status && entry.status >= 400 ? 'bad' : 'faint'}
        style={{ width: 30, flexShrink: 0, fontSize: 11, textAlign: 'right' }}
      >
        {entry.status ?? '—'}
      </span>

      <span className="faint" style={{ width: 46, flexShrink: 0, fontSize: 10, textAlign: 'right' }}>
        {entry.durationMs != null ? `${entry.durationMs}ms` : ''}
      </span>

      <span className="req-row__action" style={{ width: 66, flexShrink: 0 }}>
        {!entry.mocked && (
          <button
            className="tiny"
            onClick={(e) => {
              e.stopPropagation();
              onConvert();
            }}
          >
            转为 Mock
          </button>
        )}
      </span>
    </div>
  );
}

function DetailPane({
  entry,
  onConvert,
  onClose,
}: {
  entry: CapturedRequest;
  onConvert: () => void;
  onClose: () => void;
}) {
  return (
    <div
      style={{
        height: '100%',
        borderLeft: '1px solid var(--border)',
        padding: 12,
        overflowY: 'auto',
      }}
    >
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <strong style={{ fontSize: 12 }}>请求详情</strong>
        <div className="row" style={{ gap: 6 }}>
          {!entry.mocked && (
            <button
              className="primary"
              style={{ padding: '2px 9px', fontSize: 11 }}
              onClick={onConvert}
            >
              转为 Mock
            </button>
          )}
          <button style={{ padding: '2px 7px', fontSize: 11 }} onClick={onClose}>
            关闭
          </button>
        </div>
      </div>

      <KV k="URL" v={entry.url} mono />
      <KV k="Method" v={entry.method} />
      <KV k="状态" v={String(entry.status ?? '—')} />
      <KV k="来源" v={entry.api === 'xhr' ? 'XMLHttpRequest' : 'fetch'} />
      {entry.mocked && entry.ruleName && <KV k="命中规则" v={entry.ruleName} />}

      <div style={{ marginTop: 10 }}>
        <label>响应体{entry.truncated && '（已截断）'}</label>
        <pre
          className="mono"
          style={{
            margin: 0,
            padding: 8,
            maxHeight: 380,
            overflow: 'auto',
            background: 'var(--surface)',
            borderRadius: 6,
            fontSize: 11,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {entry.body ?? '（无内容）'}
        </pre>
      </div>
    </div>
  );
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div style={{ marginBottom: 5 }}>
      <label>{k}</label>
      <div className={mono ? 'mono' : undefined} style={{ fontSize: 11, wordBreak: 'break-all' }}>
        {v}
      </div>
    </div>
  );
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}
