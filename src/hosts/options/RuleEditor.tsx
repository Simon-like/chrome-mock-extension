/**
 * 规则编辑器
 *
 * 这里【没有业务逻辑】—— 校验来自 core/store/validate，保存是 dispatch 一个 Command。
 * UI 只负责收集输入和展示反馈。这正是 A1/A3 分层的目的：
 * V2 的 MCP 走同一套 core，无需重写。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { validateRule } from '@core/store/validate.js';
import { createRuleDraft } from '@core/store/defaults.js';
import {
  HTTP_METHODS,
  type HttpMethod,
  type Rule,
  type RuleDraft,
  type ShellTemplate,
} from '@core/types.js';
import { JsonEditor } from '@ui/JsonEditor.js';

interface Props {
  /** 编辑现有规则时传入 */
  initial?: Rule;
  /**
   * 以一份预填草稿开始（Capture-to-Mock 用这个）。
   * 与 initial 互斥：initial 是「改一条已存在的规则」，
   * initialDraft 是「新建一条但字段已经填好了」。
   */
  initialDraft?: RuleDraft;
  shellTemplates: ShellTemplate[];
  /** 返回是否保存成功 */
  onSave: (draft: RuleDraft) => Promise<boolean> | boolean;
  onClose: () => void;
}

export function RuleEditor({ initial, initialDraft, shellTemplates, onSave, onClose }: Props) {
  const [draft, setDraft] = useState<RuleDraft>(
    () => initialDraft ?? (initial ? toDraft(initial) : createRuleDraft()),
  );
  /** 保存后用来判断有没有新改动 —— 没改动就不该允许重复保存 */
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => void (flashTimer.current && clearTimeout(flashTimer.current)), []);

  const issues = useMemo(() => validateRule(draft), [draft]);
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');

  const serialized = JSON.stringify(draft);
  const dirty = savedSnapshot === null || savedSnapshot !== serialized;

  const patch = (p: Partial<RuleDraft>) => setDraft((d) => ({ ...d, ...p }));
  const patchMatch = (p: Partial<RuleDraft['match']>) =>
    setDraft((d) => ({ ...d, match: { ...d.match, ...p } }));
  const patchResponse = (p: Partial<RuleDraft['response']>) =>
    setDraft((d) => ({ ...d, response: { ...d.response, ...p } }));

  const toggleMethod = (m: HttpMethod) => {
    const cur = draft.match.methods;
    patchMatch({ methods: cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m] });
  };

  /**
   * 保存后【不关闭编辑器】。
   *
   * 用户反馈：保存即隐藏会让人不确定有没有存上，容易反复点保存。
   * 现在改成留在原地 + 短暂提示 + 保存按钮进入「已保存」不可点状态，
   * 直到有新改动才重新可用。
   */
  const handleSave = async () => {
    if (errors.length > 0 || saving || !dirty) return;
    setSaving(true);
    const ok = await onSave(draft);
    setSaving(false);
    if (!ok) return;

    setSavedSnapshot(serialized);
    setFlash('已保存');
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 2000);
  };

  // Cmd/Ctrl + S 保存
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const title = initial ? '编辑规则' : initialDraft ? '从请求创建 Mock' : '新建规则';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        borderLeft: '1px solid var(--border)',
        background: 'var(--bg)',
      }}
    >
      {/* 头部固定，长表单滚动时保存按钮始终可见 */}
      <div
        className="row"
        style={{
          justifyContent: 'space-between',
          padding: '11px 16px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <div className="row" style={{ gap: 9 }}>
          <strong style={{ fontSize: 13 }}>{title}</strong>
          {flash && (
            <span className="ok" style={{ fontSize: 11 }}>
              ✓ {flash}
            </span>
          )}
          {!flash && dirty && savedSnapshot !== null && (
            <span className="faint" style={{ fontSize: 11 }}>
              有未保存的改动
            </span>
          )}
        </div>

        <div className="row" style={{ gap: 7 }}>
          <button onClick={onClose}>关闭</button>
          <button
            className="primary"
            disabled={errors.length > 0 || saving || !dirty}
            onClick={handleSave}
            title="⌘S / Ctrl+S"
          >
            {saving ? '保存中…' : !dirty && savedSnapshot !== null ? '已保存' : '保存'}
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 16, minHeight: 0 }}>
        <div style={{ marginBottom: 14 }}>
          <label>规则名</label>
          <input value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
        </div>

        <div style={{ marginBottom: 14 }}>
          <label>类型</label>
          <div className="row" style={{ gap: 9, alignItems: 'stretch' }}>
            <KindOption
              checked={draft.kind === 'override'}
              onSelect={() => patch({ kind: 'override' })}
              title="覆盖已有接口"
              desc="接口真实存在，只改响应。停用后回到真实数据"
            />
            <KindOption
              checked={draft.kind === 'virtual'}
              onSelect={() => patch({ kind: 'virtual' })}
              title="新建虚拟接口"
              desc="后端还没有这个接口。停用后请求会真的失败"
            />
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label>URL 匹配</label>
          <div className="row" style={{ gap: 7 }}>
            <select
              value={draft.match.urlMode}
              onChange={(e) =>
                patchMatch({ urlMode: e.target.value as RuleDraft['match']['urlMode'] })
              }
              style={{ width: 96, flexShrink: 0 }}
            >
              <option value="contains">包含</option>
              <option value="wildcard">通配符</option>
              <option value="regex">正则</option>
            </select>
            <input
              className="mono"
              placeholder={placeholderFor(draft.match.urlMode)}
              value={draft.match.url}
              onChange={(e) => patchMatch({ url: e.target.value })}
            />
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label>
            请求方法
            {draft.match.methods.length === 0 && (
              <span className="faint" style={{ fontWeight: 400 }}> · 未选 = 匹配全部</span>
            )}
          </label>
          <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
            {HTTP_METHODS.map((m) => (
              <button
                key={m}
                className={draft.match.methods.includes(m) ? 'primary tiny' : 'tiny'}
                onClick={() => toggleMethod(m)}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        <div className="row" style={{ gap: 10, alignItems: 'flex-start', marginBottom: 14 }}>
          <div style={{ width: 86, flexShrink: 0 }}>
            <label>状态码</label>
            <input
              type="number"
              value={draft.response.status}
              onChange={(e) => patchResponse({ status: Number(e.target.value) })}
            />
          </div>
          <div style={{ width: 96, flexShrink: 0 }}>
            <label>延迟 (ms)</label>
            <input
              type="number"
              value={draft.response.delayMs}
              onChange={(e) => patchResponse({ delayMs: Number(e.target.value) })}
            />
          </div>
          <div className="grow">
            <label>响应外壳</label>
            <select
              value={draft.response.shellTemplateId ?? ''}
              onChange={(e) => patchResponse({ shellTemplateId: e.target.value || null })}
            >
              <option value="">不套壳（body 即完整响应）</option>
              {shellTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
            <label style={{ margin: 0 }}>
              {draft.response.shellTemplateId ? '响应数据（填入外壳的 __DATA__ 位置）' : '响应体'}
            </label>
            <div className="row" style={{ gap: 4 }}>
              {SCENARIO_PRESETS.map((p) => (
                <button
                  key={p.label}
                  className="tiny ghost"
                  onClick={() => patchResponse(p.apply(draft.response.shellTemplateId))}
                  title={p.hint}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* 高度给足 —— 真实接口响应动辄几百行 */}
          <JsonEditor
            value={draft.response.body}
            onChange={(body) => patchResponse({ body })}
            height="min(52vh, 560px)"
          />
        </div>

        {errors.map((i, n) => (
          <div key={`e${n}`} className="banner banner-bad" style={{ marginTop: 7 }}>
            ✗ {i.message}
          </div>
        ))}
        {warnings.map((i, n) => (
          <div key={`w${n}`} className="banner banner-warn" style={{ marginTop: 7 }}>
            ⚠ {i.message}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 场景预设（F11 的雏形）：把前端高频边界场景做成一键套用 */
const SCENARIO_PRESETS = [
  {
    label: '空数据',
    hint: '测空状态',
    apply: (shellId: string | null) => ({
      status: 200,
      body: shellId ? '[]' : '{\n  "list": [],\n  "total": 0\n}',
    }),
  },
  {
    label: '500',
    hint: '服务端错误',
    apply: () => ({ status: 500, body: '{\n  "message": "Internal Server Error"\n}' }),
  },
  {
    label: '401',
    hint: '登录过期',
    apply: () => ({ status: 401, body: '{\n  "message": "登录已过期"\n}' }),
  },
  { label: '慢 3 秒', hint: '测 loading 态', apply: () => ({ delayMs: 3000 }) },
];

function KindOption({
  checked,
  onSelect,
  title,
  desc,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  desc: string;
}) {
  return (
    <div
      onClick={onSelect}
      style={{
        flex: 1,
        padding: '8px 10px',
        border: `1px solid ${checked ? 'var(--accent)' : 'var(--border-strong)'}`,
        borderRadius: 'var(--radius-sm)',
        cursor: 'pointer',
        background: checked ? 'var(--accent-soft)' : 'transparent',
        transition: 'border-color .12s, background .12s',
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>{title}</div>
      <div className="muted" style={{ fontSize: 10.5, lineHeight: 1.45 }}>
        {desc}
      </div>
    </div>
  );
}

function placeholderFor(mode: RuleDraft['match']['urlMode']): string {
  switch (mode) {
    case 'contains':
      return '/api/goods/list';
    case 'wildcard':
      return '/api/*/list';
    case 'regex':
      return '/api/goods/\\d+';
  }
}

function toDraft(rule: Rule): RuleDraft {
  const { id: _id, meta, ...rest } = rule;
  return { ...rest, meta: { source: meta.source } };
}
