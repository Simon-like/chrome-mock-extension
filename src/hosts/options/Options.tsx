/**
 * Options 页 —— 规则管理主界面
 *
 * 规则列表的顺序【就是】匹配优先级（先到先得），所以支持上下移动。
 * 被遮蔽的规则会显式提示 —— 这是先到先得策略唯一的坑（05 §5.1）。
 */

import { useMemo, useState } from 'react';
import { findShadowedRules } from '@core/store/validate.js';
import type { Rule, RuleDraft } from '@core/types.js';
import { useStore } from '@ui/useStore.js';
import { Splitter, useResizable } from '@ui/Splitter.js';
import { RuleEditor } from './RuleEditor.js';

const EDITOR_DEFAULT_WIDTH = 560;

/**
 * 编辑态按 id 记录而非整个 rule 对象 —— 规则改动后要能拿到最新版本。
 * 新建成功后会切成 { mode:'edit', ruleId }，避免再次保存又建一条。
 */
type Editing = { mode: 'edit'; ruleId: string } | { mode: 'new' } | null;

export function Options() {
  const { store, loading, error, run } = useStore();
  const [editing, setEditing] = useState<Editing>(null);
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);
  const [keyword, setKeyword] = useState('');

  const editorPane = useResizable({
    storageKey: 'mockstudio.options.editorWidth',
    defaultWidth: EDITOR_DEFAULT_WIDTH,
    minWidth: 380,
  });

  const shadowed = useMemo(
    () => (store ? findShadowedRules(store.rules) : new Map<string, string>()),
    [store],
  );

  const visible = useMemo(() => {
    if (!store) return [];
    const kw = keyword.trim().toLowerCase();
    if (!kw) return store.rules;
    return store.rules.filter(
      (r) => r.name.toLowerCase().includes(kw) || r.match.url.toLowerCase().includes(kw),
    );
  }, [store, keyword]);

  if (loading) return <div style={{ padding: 28 }} className="muted">加载中…</div>;
  if (error || !store) {
    return (
      <div style={{ padding: 28 }}>
        <div className="banner banner-bad">{error ?? '状态不可用'}</div>
      </div>
    );
  }

  const flash = (text: string, bad = false) => {
    setNotice({ text, bad });
    setTimeout(() => setNotice(null), 3000);
  };

  /**
   * 保存后编辑器【不关闭】，所以必须处理一个副作用：
   * 新建保存成功后要立刻切到编辑态，否则用户再点一次保存会又建出一条重复规则。
   */
  const save = async (draft: RuleDraft): Promise<boolean> => {
    if (editing?.mode === 'edit') {
      const res = await run({ type: 'UPDATE_RULE', payload: { id: editing.ruleId, patch: draft } });
      return res.ok;
    }
    const res = await run({ type: 'CREATE_RULE', payload: { draft } });
    if (res.ok && res.createdId) {
      setEditing({ mode: 'edit', ruleId: res.createdId });
    }
    return res.ok;
  };

  const exportRules = () => {
    const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mock-studio-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    flash('已导出');
  };

  const importRules = (mode: 'replace' | 'merge') => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const raw = JSON.parse(await file.text());
        const ok = await run({ type: 'IMPORT_STORE', payload: { raw, mode } });
        flash(ok ? `导入成功（${mode === 'replace' ? '替换' : '合并'}）` : '导入失败', !ok);
      } catch (e) {
        flash(`导入失败：${(e as Error).message}`, true);
      }
    };
    input.click();
  };

  /** 从剪贴板导入 —— L0 AI 协同的落地路径（02 §2.2） */
  const importFromClipboard = async () => {
    try {
      const raw = JSON.parse(await navigator.clipboard.readText());
      // AI 可能给单条规则、规则数组，或完整 store，三种都支持
      const payload = Array.isArray(raw)
        ? { ...store, rules: raw }
        : raw.rules
          ? raw
          : { ...store, rules: [raw] };
      const ok = await run({ type: 'IMPORT_STORE', payload: { raw: payload, mode: 'merge' } });
      flash(ok ? '已从剪贴板导入' : '导入失败', !ok);
    } catch (e) {
      flash(`剪贴板内容不是合法 JSON：${(e as Error).message}`, true);
    }
  };

  const activeCount = store.rules.filter((r) => r.enabled).length;
  const virtualCount = store.rules.filter((r) => r.enabled && r.kind === 'virtual').length;

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {/* 顶栏 */}
        <div
          style={{
            padding: '13px 20px 11px',
            borderBottom: '1px solid var(--border)',
            flexShrink: 0,
          }}
        >
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 3 }}>
            <div className="row" style={{ gap: 10 }}>
              <strong style={{ fontSize: 15 }}>Mock Studio</strong>
              <span className="faint" style={{ fontSize: 11.5 }}>
                {activeCount} / {store.rules.length} 条启用
                {virtualCount > 0 && ` · ${virtualCount} 个虚拟接口`}
              </span>
            </div>
            <button
              className={store.enabled ? 'primary' : ''}
              onClick={() =>
                run({ type: 'SET_GLOBAL_ENABLED', payload: { enabled: !store.enabled } })
              }
            >
              总开关：{store.enabled ? '已启用' : '已停用'}
            </button>
          </div>
          <div className="faint" style={{ fontSize: 11 }}>
            列表顺序即匹配优先级 —— 从上往下第一条命中的规则生效
          </div>
        </div>

        {/* 工具栏 */}
        <div
          className="row"
          style={{
            gap: 6,
            padding: '10px 20px',
            flexWrap: 'wrap',
            flexShrink: 0,
          }}
        >
          <button className="primary" onClick={() => setEditing({ mode: 'new' })}>
            + 新建规则
          </button>
          <input
            placeholder="搜索规则名或 URL"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            style={{ width: 200 }}
          />
          <span className="grow" />
          <button className="ghost" onClick={importFromClipboard} title="粘贴 AI 生成的规则 JSON">
            剪贴板导入
          </button>
          <button className="ghost" onClick={() => importRules('merge')}>
            导入
          </button>
          <button className="ghost" onClick={() => importRules('replace')}>
            导入并替换
          </button>
          <button className="ghost" onClick={exportRules}>
            导出
          </button>
        </div>

        {notice && (
          <div style={{ padding: '0 20px 10px' }}>
            <div className={`banner ${notice.bad ? 'banner-bad' : 'banner-ok'}`}>{notice.text}</div>
          </div>
        )}

        {/* 列表 */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 20px', minHeight: 0 }}>
          {store.rules.length === 0 ? (
            <div className="empty">
              还没有规则
              <br />
              <span style={{ fontSize: 11.5 }}>
                提示：在页面按 F12 打开 <strong>Mock</strong> 面板，可以把真实请求一键转成规则
              </span>
            </div>
          ) : visible.length === 0 ? (
            <div className="empty">没有匹配「{keyword}」的规则</div>
          ) : (
            visible.map((rule) => {
              const idx = store.rules.indexOf(rule);
              const shadowerId = shadowed.get(rule.id);
              return (
                <RuleItem
                  key={rule.id}
                  rule={rule}
                  index={idx}
                  total={store.rules.length}
                  shadowedBy={
                    shadowerId ? store.rules.find((r) => r.id === shadowerId)?.name : undefined
                  }
                  selected={editing?.mode === 'edit' && editing.ruleId === rule.id}
                  onEdit={() => setEditing({ mode: 'edit', ruleId: rule.id })}
                  onToggle={(enabled) =>
                    void run({ type: 'TOGGLE_RULE', payload: { id: rule.id, enabled } })
                  }
                  onDelete={() => {
                    void run({ type: 'DELETE_RULE', payload: { id: rule.id } });
                    if (editing?.mode === 'edit' && editing.ruleId === rule.id) setEditing(null);
                  }}
                  onDuplicate={() => void run({ type: 'DUPLICATE_RULE', payload: { id: rule.id } })}
                  onMove={(dir) =>
                    void run({ type: 'REORDER_RULE', payload: { id: rule.id, toIndex: idx + dir } })
                  }
                />
              );
            })
          )}
        </div>
      </div>

      {editing && (
        <>
          <Splitter
            onResize={editorPane.setWidth}
            onDragStateChange={editorPane.setDragging}
            onReset={() => editorPane.setWidth(EDITOR_DEFAULT_WIDTH)}
          />
          <div style={{ width: editorPane.width, flexShrink: 0, minWidth: 0 }}>
            <RuleEditor
              key={editing.mode === 'edit' ? editing.ruleId : 'new'}
              initial={
                editing.mode === 'edit'
                  ? store.rules.find((r) => r.id === editing.ruleId)
                  : undefined
              }
              shellTemplates={store.shellTemplates}
              onSave={save}
              onClose={() => setEditing(null)}
            />
          </div>
        </>
      )}
    </div>
  );
}

function RuleItem({
  rule,
  index,
  total,
  shadowedBy,
  selected,
  onEdit,
  onToggle,
  onDelete,
  onDuplicate,
  onMove,
}: {
  rule: Rule;
  index: number;
  total: number;
  shadowedBy?: string;
  selected: boolean;
  onEdit: () => void;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onMove: (dir: number) => void;
}) {
  const cls = ['rule-item', selected && 'selected', !rule.enabled && 'disabled']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls} onDoubleClick={onEdit}>
      <div className="rule-item__head">
        <input
          type="checkbox"
          checked={rule.enabled}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <span className={`tag tag-${rule.kind}`}>{rule.kind === 'virtual' ? '虚拟' : '覆盖'}</span>
        <span className="grow truncate" style={{ fontWeight: 500 }}>
          {rule.name}
        </span>

        <span
          className={rule.enabled && rule.meta.hitCount === 0 ? 'faint' : 'muted'}
          style={{ fontSize: 10.5, flexShrink: 0 }}
          title="命中次数"
        >
          {rule.meta.hitCount} 次
        </span>

        <div className="rule-item__actions">
          <button className="icon" disabled={index === 0} onClick={() => onMove(-1)} title="上移（提高优先级）">
            ↑
          </button>
          <button className="icon" disabled={index === total - 1} onClick={() => onMove(1)} title="下移">
            ↓
          </button>
          <button className="icon" onClick={onEdit}>编辑</button>
          <button className="icon" onClick={onDuplicate}>复制</button>
          <button className="danger tiny" onClick={onDelete}>删除</button>
        </div>
      </div>

      <div className="rule-item__body">
        <div className="mono muted truncate">
          <span className="faint">[{modeLabel(rule.match.urlMode)}]</span> {rule.match.url}
          {rule.match.methods.length > 0 && (
            <span className="faint"> · {rule.match.methods.join('/')}</span>
          )}
          <span className="faint"> · {rule.response.status}</span>
          {rule.response.delayMs > 0 && (
            <span className="faint"> · 延迟 {rule.response.delayMs}ms</span>
          )}
        </div>

        {/* 先到先得策略唯一的坑：必须显式提示遮蔽关系 */}
        {shadowedBy && rule.enabled && (
          <div className="warn" style={{ fontSize: 10.5, marginTop: 4 }}>
            ⚠ 可能被上方的「{shadowedBy}」遮蔽而永不命中，可上移调整优先级
          </div>
        )}

        {/* 命中数为 0 是最常见的「配了但不生效」信号 */}
        {rule.enabled && rule.meta.hitCount === 0 && !shadowedBy && (
          <div className="faint" style={{ fontSize: 10.5, marginTop: 4 }}>
            尚未命中过 —— 若预期已生效，请检查匹配条件
          </div>
        )}
      </div>
    </div>
  );
}

function modeLabel(mode: Rule['match']['urlMode']): string {
  return { contains: '包含', wildcard: '通配', regex: '正则' }[mode];
}
