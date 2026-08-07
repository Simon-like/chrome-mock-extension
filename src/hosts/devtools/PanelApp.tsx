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
import { CodeEditor } from '@ui/CodeEditor.js';

const inspectedTabId = chrome.devtools.inspectedWindow.tabId;

/**
 * 侧栏默认宽度。详情面板是左右两栏（元信息 + 响应体），
 * 480 会把响应体挤成面条，所以给到 640；不够还能拖。
 */
const SIDE_DEFAULT_WIDTH = 640;

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
    setDraft(
      captureToRuleDraft(entry, {
        shellTemplates: store?.shellTemplates ?? [],
        projectId: store?.activeProjectId ?? null,
        // 抓包转 Mock 后多半接着就要测空态和报错，预先建好省一步
        withPresetVariants: true,
      }),
    );
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

  /**
   * 详情面板里直接改规则响应，不用跳去规则管理页。
   *
   * 只改**当前生效变体**的 body —— 其余配置（匹配条件、状态码、变体结构）
   * 还是去完整编辑器改。这里要的是「看到不对，顺手改一下」这条最短路径。
   */
  const saveRuleBody = async (ruleId: string, variantId: string, body: string) => {
    const rule = store?.rules.find((r) => r.id === ruleId);
    const variant = rule?.variants.find((v) => v.id === variantId);
    if (!variant) return false;
    const res = await run({
      type: 'UPDATE_VARIANT',
      payload: { ruleId, variantId, patch: { response: { ...variant.response, body } } },
    });
    return res.ok;
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
            projects={store?.projects}
            groups={store?.groups}
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
              rule={store?.rules.find((r) => r.id === selected.ruleId)}
              onConvert={() => convertToMock(selected)}
              onClose={() => setSelected(null)}
              onSaveBody={saveRuleBody}
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
  // 响应体没生成出来时必须压过 mocked 的绿底 —— 「Mock 生效了」和「Mock 算错了」
  // 是两件事，后者更紧急，不能被前者的成功色盖住
  const genBad = entry.bodyGen && !entry.bodyGen.ok;
  const cls = [
    'req-row',
    entry.mocked && 'mocked',
    genBad && 'req-row--dynfail',
    selected && 'selected',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls} onClick={onSelect}>
      {/* 被 Mock 的请求要一眼能认出来 —— 这是本面板存在的理由 */}
      <span style={{ width: 42, flexShrink: 0 }}>
        {genBad ? (
          <span className="tag tag-dynfail" title={entry.bodyGen?.error}>
            {entry.bodyGen?.kind === 'mockjs' ? '模板错' : 'JS 错'}
          </span>
        ) : (
          entry.mocked && <span className="tag tag-mock">MOCK</span>
        )}
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

/**
 * 请求详情 —— 左右分栏
 *
 * 之前是单栏竖排：元信息一条条堆上去，响应体挤在最底下一个矮 <pre> 里，
 * 又窄又没高亮，一个几百行的接口响应根本看不了。
 *
 * 现在左边放元信息（固定窄栏），右边整块留给响应体 ——
 * 响应体拿到**整个面板的高度**，这是可读性提升最大的一步。
 * 面板本身已经能拖宽，横向不够时把它拖开就是了。
 */
function DetailPane({
  entry,
  rule,
  onConvert,
  onClose,
  onSaveBody,
}: {
  entry: CapturedRequest;
  /** 命中的规则。只有已 Mock 的请求才有 —— 有它才谈得上「就地编辑」 */
  rule?: Rule;
  onConvert: () => void;
  onClose: () => void;
  onSaveBody: (ruleId: string, variantId: string, body: string) => Promise<boolean>;
}) {
  const [copied, setCopied] = useState(false);
  /**
   * 看「实际返回」还是「规则内容」。
   *
   * ⚠️ 这两者对 mockjs / dynamic 规则**完全不是一回事**：
   * 实际返回是模板展开/JS 执行后的结果，规则内容才是你写的那份源码。
   * 早期想过让响应体直接可编辑，但那样用户改的是**生成结果**，
   * 一保存就把模板覆盖成了某一次的快照 —— 数据从此不再变化，还很难发现。
   * 所以必须分成两个明确的视图，而不是一个含糊的「编辑」。
   */
  const [tab, setTab] = useState<'actual' | 'source'>('actual');
  const [dirtyBody, setDirtyBody] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const variant = rule?.variants.find((v) => v.id === rule.activeVariantId) ?? rule?.variants[0];
  const editable = !!rule && !!variant;
  /** 生成式规则的「实际返回」是算出来的，跟源码差得远 —— 要显式告诉用户 */
  const generated = variant ? variant.response.bodyType !== 'static' : false;

  // 换了一条请求就把未保存的编辑丢掉，否则会把 A 的改动存到 B 上
  useEffect(() => {
    setDirtyBody(null);
    setSaved(false);
    setTab('actual');
  }, [entry.id]);

  /** 响应体格式化后再给编辑器 —— 原始的是压成一行的，缩进后才谈得上「可读」 */
  const pretty = useMemo(() => {
    const raw = entry.body;
    if (!raw) return '';
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw; // 不是 JSON 就原样显示，不强行改造
    }
  }, [entry.body]);

  const sourceBody = dirtyBody ?? variant?.response.body ?? '';
  const dirty = dirtyBody !== null && dirtyBody !== variant?.response.body;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(tab === 'actual' ? (entry.body ?? '') : sourceBody);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板不可用时用户还能自己选中复制 */
    }
  };

  const save = async () => {
    if (!rule || !variant || !dirty) return;
    setSaving(true);
    const ok = await onSaveBody(rule.id, variant.id, sourceBody);
    setSaving(false);
    if (ok) {
      setDirtyBody(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  return (
    <div className="detail">
      <div className="detail__head">
        <strong style={{ fontSize: 12 }}>请求详情</strong>
        <span className="grow" />
        {!entry.mocked && (
          <button className="primary" style={{ padding: '2px 9px', fontSize: 11 }} onClick={onConvert}>
            转为 Mock
          </button>
        )}
        <button style={{ padding: '2px 7px', fontSize: 11 }} onClick={onClose}>
          关闭
        </button>
      </div>

      <div className="detail__cols">
        {/* ── 左：元信息 ── */}
        <div className="detail__meta">
          <KV k="Method" v={entry.method} />
          <KV k="状态" v={String(entry.status ?? '—')} bad={!!entry.status && entry.status >= 400} />
          <KV k="来源" v={entry.api === 'xhr' ? 'XMLHttpRequest' : 'fetch'} />
          {entry.durationMs != null && <KV k="耗时" v={`${entry.durationMs}ms`} />}
          {entry.mocked && entry.ruleName && <KV k="命中规则" v={entry.ruleName} />}
          {variant && rule && rule.variants.length > 1 && (
            <KV k="当前变体" v={variant.name} />
          )}
          <KV k="URL" v={entry.url} mono wrap />

          {entry.bodyGen && (
            <div style={{ marginTop: 10 }}>
              <label>{entry.bodyGen.kind === 'mockjs' ? 'Mock 模板' : '动态响应'}</label>
              {entry.bodyGen.ok ? (
                <div className={entry.bodyGen.slow ? 'warn' : 'ok'} style={{ fontSize: 11 }}>
                  ✓ 生成成功 · {entry.bodyGen.durationMs.toFixed(1)}ms
                  {entry.bodyGen.slow && ' —— 偏慢，翻页高频调用时可能拖慢页面'}
                </div>
              ) : (
                <div className="banner banner-bad" style={{ fontSize: 11, lineHeight: 1.5 }}>
                  ✗ {entry.bodyGen.error}
                  {entry.bodyGen.tripped && (
                    <div style={{ marginTop: 4 }} className="muted">
                      已熔断，暂停执行。改完保存后会自动恢复。
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── 右：响应体，占满剩余空间 ── */}
        <div className="detail__body">
          <div className="detail__bodyhead">
            {editable ? (
              <div className="bodytype" style={{ margin: 0 }}>
                <button
                  className={tab === 'actual' ? 'bodytype__on' : ''}
                  onClick={() => setTab('actual')}
                  title="页面这次实际收到的内容"
                >
                  实际返回
                </button>
                <button
                  className={tab === 'source' ? 'bodytype__on' : ''}
                  onClick={() => setTab('source')}
                  title="规则里写的那份内容，可以直接改"
                >
                  规则内容{dirty ? ' ·' : ''}
                </button>
              </div>
            ) : (
              <label style={{ margin: 0 }}>
                响应体
                {entry.truncated && <span className="warn"> · 已截断</span>}
              </label>
            )}

            <span className="grow" />

            {tab === 'source' && editable && (
              <>
                {saved && <span className="ok" style={{ fontSize: 11 }}>✓ 已保存</span>}
                <button
                  className={dirty ? 'primary tiny' : 'tiny'}
                  disabled={!dirty || saving}
                  onClick={save}
                  title="保存到这条规则的当前变体"
                >
                  {saving ? '保存中…' : '保存'}
                </button>
              </>
            )}
            <span className="faint" style={{ fontSize: 10.5 }}>
              {tab === 'actual' ? sizeOf(entry.body) : ''}
            </span>
            <button className="tiny ghost" onClick={copy}>
              {copied ? '已复制' : '复制'}
            </button>
          </div>

          {/* 生成式规则：两个视图差别很大，说清楚免得用户以为哪个坏了 */}
          {editable && generated && (
            <div className="faint" style={{ fontSize: 10.5, lineHeight: 1.5 }}>
              {tab === 'actual'
                ? `这是${variant!.response.bodyType === 'mockjs' ? '模板展开' : 'JS 执行'}后的结果，每次请求都会重新生成。要改内容请切到「规则内容」。`
                : `这是规则里写的${variant!.response.bodyType === 'mockjs' ? ' Mock 模板' : ' JS 源码'}，不是页面收到的东西。改完保存，刷新页面生效。`}
            </div>
          )}

          {tab === 'actual' ? (
            entry.body ? (
              <CodeEditor
                key={`${entry.id}-actual`}
                value={pretty}
                onChange={() => {}}
                readOnly
                height="100%"
              />
            ) : (
              <div className="empty" style={{ fontSize: 11 }}>（无响应体）</div>
            )
          ) : (
            <CodeEditor
              key={`${entry.id}-source-${variant?.id}`}
              value={sourceBody}
              onChange={setDirtyBody}
              language={variant?.response.bodyType === 'dynamic' ? 'js' : 'json'}
              height="100%"
            />
          )}
        </div>
      </div>
    </div>
  );
}

function sizeOf(body: string | null): string {
  if (!body) return '';
  const bytes = new Blob([body]).size;
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function KV({
  k,
  v,
  mono,
  wrap,
  bad,
}: {
  k: string;
  v: string;
  mono?: boolean;
  /** 长内容（URL）才需要折行，短字段折行只会让左栏高低不齐 */
  wrap?: boolean;
  bad?: boolean;
}) {
  return (
    <div style={{ marginBottom: 6 }}>
      <label>{k}</label>
      <div
        className={[mono && 'mono', bad && 'bad'].filter(Boolean).join(' ') || undefined}
        style={{ fontSize: 11, wordBreak: wrap ? 'break-all' : 'normal' }}
        title={v}
      >
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
