/**
 * Options 页 —— 规则管理主界面
 *
 * 三层容器 + 一个正交轴，UI 上要区分清楚：
 *   - 项目：按系统划分，绑定域名（侧栏）
 *   - 分组：业务模块归类，纯粹的容器（主区标题）
 *   - 规则：列表顺序即匹配优先级（先到先得）
 *   - 变体：同一接口的多份响应，在规则行上直接切换（不属于容器层级）
 */

import { useMemo, useState } from 'react';
import { findShadowedRules } from '@core/store/validate.js';
import { createRuleDraft, getActiveVariant } from '@core/store/defaults.js';
import type { Group, Rule, RuleDraft } from '@core/types.js';
import { useStore } from '@ui/useStore.js';
import { Splitter, useResizable } from '@ui/Splitter.js';
import { VariantSwitcher } from '@ui/VariantSwitcher.js';
import { RuleEditor } from './RuleEditor.js';
import { GroupSection } from './GroupSection.js';
import { ProjectSidebar } from './ProjectSidebar.js';
import { ProjectSettings } from './ProjectSettings.js';

const EDITOR_DEFAULT_WIDTH = 560;
const DRAG_MIME = 'application/x-mockstudio-rule';

type Editing = { mode: 'edit'; ruleId: string } | { mode: 'new' } | null;

export function Options() {
  const { store, loading, error, run } = useStore();
  const [editing, setEditing] = useState<Editing>(null);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(0);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const editorPane = useResizable({
    storageKey: 'mockstudio.options.editorWidth',
    defaultWidth: EDITOR_DEFAULT_WIDTH,
    minWidth: 380,
  });

  const shadowed = useMemo(
    () => (store ? findShadowedRules(store.rules) : new Map<string, string>()),
    [store],
  );

  /** 当前项目下的规则（未归档时看 projectId === null 的） */
  const scopedRules = useMemo(
    () => (store ? store.rules.filter((r) => r.projectId === store.activeProjectId) : []),
    [store],
  );

  const searched = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return scopedRules;
    return scopedRules.filter(
      (r) => r.name.toLowerCase().includes(kw) || r.match.url.toLowerCase().includes(kw),
    );
  }, [scopedRules, keyword]);

  if (loading) return <div style={{ padding: 28 }} className="muted">加载中…</div>;
  if (error || !store) {
    return (
      <div style={{ padding: 28 }}>
        <div className="banner banner-bad">{error ?? '状态不可用'}</div>
      </div>
    );
  }

  const pageSize = store.settings.pageSize;
  const pageCount = Math.max(1, Math.ceil(searched.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  /**
   * 分页按「规则」切，跨分组连续排。
   * 分组本身不分页 —— 它是标题不是条目，分页会把同组规则切断反而难用。
   */
  const pageRuleIds = new Set(
    searched.slice(safePage * pageSize, (safePage + 1) * pageSize).map((r) => r.id),
  );

  const flash = (text: string, bad = false) => {
    setNotice({ text, bad });
    setTimeout(() => setNotice(null), 3000);
  };

  const activeProject = store.projects.find((p) => p.id === store.activeProjectId) ?? null;
  const groupsInScope = store.groups.filter((g) => g.projectId === store.activeProjectId);

  const save = async (draft: RuleDraft): Promise<boolean> => {
    if (editing?.mode === 'edit') {
      const res = await run({ type: 'UPDATE_RULE', payload: { id: editing.ruleId, patch: draft } });
      return res.ok;
    }
    const res = await run({ type: 'CREATE_RULE', payload: { draft } });
    if (res.ok && res.createdId) setEditing({ mode: 'edit', ruleId: res.createdId });
    return res.ok;
  };

  // ── 拖拽归组 ──────────────────────────────────────
  const handleDrop = (e: React.DragEvent, groupId: string | null) => {
    e.preventDefault();
    setDropTarget(null);
    setDraggingId(null);
    const ruleId = e.dataTransfer.getData(DRAG_MIME);
    if (!ruleId) return;
    const rule = store.rules.find((r) => r.id === ruleId);
    if (!rule || rule.groupId === groupId) return;
    void run({ type: 'MOVE_RULE', payload: { id: ruleId, groupId } });
  };

  const allowDrop = (e: React.DragEvent, key: string) => {
    if (!draggingId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget(key);
  };

  // ── 导入导出 ──────────────────────────────────────
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
        const res = await run({ type: 'IMPORT_STORE', payload: { raw, mode } });
        flash(res.ok ? `导入成功（${mode === 'replace' ? '替换' : '合并'}）` : '导入失败', !res.ok);
      } catch (e) {
        flash(`导入失败：${(e as Error).message}`, true);
      }
    };
    input.click();
  };

  /** 从剪贴板导入 —— AI 协同的落地路径 */
  const importFromClipboard = async () => {
    try {
      const raw = JSON.parse(await navigator.clipboard.readText());
      const payload = Array.isArray(raw)
        ? { ...store, rules: raw }
        : raw.rules
          ? raw
          : { ...store, rules: [raw] };
      const res = await run({ type: 'IMPORT_STORE', payload: { raw: payload, mode: 'merge' } });
      flash(res.ok ? '已从剪贴板导入' : '导入失败', !res.ok);
    } catch (e) {
      flash(`剪贴板内容不是合法 JSON：${(e as Error).message}`, true);
    }
  };

  // ── 渲染 ──────────────────────────────────────────
  const rulesOf = (groupId: string | null) => searched.filter((r) => r.groupId === groupId);

  const activeCount = scopedRules.filter((r) => r.enabled).length;
  const virtualCount = scopedRules.filter((r) => r.enabled && r.kind === 'virtual').length;

  const renderRule = (rule: Rule) => {
    if (!pageRuleIds.has(rule.id)) return null;
    const idx = store.rules.indexOf(rule);
    const shadowerId = shadowed.get(rule.id);

    return (
      <RuleItem
        key={rule.id}
        rule={rule}
        index={idx}
        total={store.rules.length}
        groups={groupsInScope}
        shadowedBy={shadowerId ? store.rules.find((r) => r.id === shadowerId)?.name : undefined}
        selected={editing?.mode === 'edit' && editing.ruleId === rule.id}
        dragging={draggingId === rule.id}
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_MIME, rule.id);
          e.dataTransfer.effectAllowed = 'move';
          setDraggingId(rule.id);
        }}
        onDragEnd={() => {
          setDraggingId(null);
          setDropTarget(null);
        }}
        onEdit={() => setEditing({ mode: 'edit', ruleId: rule.id })}
        onToggle={(enabled) => void run({ type: 'TOGGLE_RULE', payload: { id: rule.id, enabled } })}
        onDelete={() => {
          void run({ type: 'DELETE_RULE', payload: { id: rule.id } });
          if (editing?.mode === 'edit' && editing.ruleId === rule.id) setEditing(null);
        }}
        onDuplicate={() => void run({ type: 'DUPLICATE_RULE', payload: { id: rule.id } })}
        onMove={(dir) =>
          void run({ type: 'REORDER_RULE', payload: { id: rule.id, toIndex: idx + dir } })
        }
        onChangeGroup={(groupId) => void run({ type: 'MOVE_RULE', payload: { id: rule.id, groupId } })}
        onSwitchVariant={(variantId) =>
          void run({ type: 'SET_ACTIVE_VARIANT', payload: { ruleId: rule.id, variantId } })
        }
      />
    );
  };

  const renderGroup = (group: Group | null) => {
    const key = group?.id ?? '__ungrouped__';
    const rules = rulesOf(group?.id ?? null);
    const shownCount = rules.filter((r) => pageRuleIds.has(r.id)).length;

    // 未分组区没有内容时不渲染，避免空标题占地方
    if (!group && shownCount === 0) return null;

    return (
      <GroupSection
        key={key}
        group={group}
        rules={rules}
        shownCount={shownCount}
        collapsed={group?.collapsed ?? false}
        dropActive={dropTarget === key}
        onDragOver={(e) => allowDrop(e, key)}
        onDragLeave={() => setDropTarget((t) => (t === key ? null : t))}
        onDrop={(e) => handleDrop(e, group?.id ?? null)}
        onToggleCollapse={() => {
          if (!group) return;
          void run({
            type: 'UPDATE_GROUP',
            payload: { id: group.id, patch: { collapsed: !group.collapsed } },
          });
        }}
        onToggleEnabled={(enabled) =>
          group && void run({ type: 'TOGGLE_GROUP', payload: { id: group.id, enabled } })
        }
        onRename={(name) =>
          group && void run({ type: 'UPDATE_GROUP', payload: { id: group.id, patch: { name } } })
        }
        onDelete={() => group && void run({ type: 'DELETE_GROUP', payload: { id: group.id } })}
      >
        {rules.map(renderRule)}
      </GroupSection>
    );
  };

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <ProjectSidebar
        store={store}
        onSelect={(id) => {
          void run({ type: 'SET_ACTIVE_PROJECT', payload: { id } });
          setPage(0);
          setEditing(null);
        }}
        onCreate={async () => {
          const res = await run({ type: 'CREATE_PROJECT', payload: { name: '新项目' } });
          if (res.ok && res.createdId) setSettingsFor(res.createdId);
        }}
        onOpenSettings={setSettingsFor}
      />

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="main__head">
          <div className="row" style={{ gap: 9 }}>
            <h1>{activeProject?.name ?? '未归档'}</h1>
            {activeProject && (
              <span className="chip">
                {activeProject.hostScope.patterns.length === 0
                  ? '不限域名'
                  : activeProject.hostScope.mode === 'include'
                    ? '白名单'
                    : '黑名单'}
              </span>
            )}
            <span className="grow" />
            {activeProject && (
              <button className="ghost" onClick={() => setSettingsFor(activeProject.id)}>
                ⚙ 项目设置
              </button>
            )}
            <button
              className={store.enabled ? 'primary' : ''}
              onClick={() =>
                void run({ type: 'SET_GLOBAL_ENABLED', payload: { enabled: !store.enabled } })
              }
            >
              总开关：{store.enabled ? '已启用' : '已停用'}
            </button>
          </div>
          <div className="main__sub">
            {activeProject && activeProject.hostScope.patterns.length > 0
              ? activeProject.hostScope.patterns.join(' · ')
              : '列表顺序即匹配优先级 —— 从上往下第一条命中的规则生效'}
          </div>
        </div>

        <div className="row" style={{ gap: 6, padding: '12px 22px', flexWrap: 'wrap', flexShrink: 0 }}>
          <button className="primary" onClick={() => setEditing({ mode: 'new' })}>+ 新建规则</button>
          <button
            onClick={async () => {
              const res = await run({
                type: 'CREATE_GROUP',
                payload: { name: '新分组', projectId: store.activeProjectId },
              });
              if (res.ok) flash('已新建分组（双击名称可重命名）');
            }}
          >
            + 分组
          </button>
          <input
            placeholder="搜索规则名或 URL"
            value={keyword}
            onChange={(e) => {
              setKeyword(e.target.value);
              setPage(0);
            }}
            style={{ width: 190 }}
          />
          <span className="grow" />
          <button className="ghost" onClick={importFromClipboard} title="粘贴 AI 生成的规则 JSON">
            剪贴板导入
          </button>
          <button className="ghost" onClick={() => importRules('merge')}>导入</button>
          <button className="ghost" onClick={() => importRules('replace')}>导入并替换</button>
          <button className="ghost" onClick={exportRules}>导出</button>
        </div>

        {notice && (
          <div style={{ padding: '0 22px 10px' }}>
            <div className={`banner ${notice.bad ? 'banner-bad' : 'banner-ok'}`}>{notice.text}</div>
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', padding: '0 22px 18px', minHeight: 0 }}>
          {scopedRules.length === 0 && groupsInScope.length === 0 ? (
            <div className="empty">
              {activeProject ? `「${activeProject.name}」还没有规则` : '还没有规则'}
              <br />
              <span style={{ fontSize: 11.5 }}>
                提示：在页面按 F12 打开 <strong>Mock</strong> 面板，可以把真实请求一键转成规则
              </span>
            </div>
          ) : searched.length === 0 ? (
            <div className="empty">没有匹配「{keyword}」的规则</div>
          ) : (
            <>
              {groupsInScope.map((g) => renderGroup(g))}
              {renderGroup(null)}
            </>
          )}
        </div>

        <div className="foot">
          <span>
            共 <b style={{ color: 'var(--fg)' }}>{scopedRules.length}</b> 条 · {activeCount} 条启用
            {virtualCount > 0 && ` · ${virtualCount} 个虚拟接口`}
          </span>
          <span className="grow" />
          {pageCount > 1 && (
            <div className="pager">
              <button disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>‹</button>
              {Array.from({ length: pageCount }, (_, i) => (
                <button key={i} className={i === safePage ? 'on' : ''} onClick={() => setPage(i)}>
                  {i + 1}
                </button>
              ))}
              <button disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>›</button>
            </div>
          )}
          <select
            value={pageSize}
            onChange={(e) =>
              void run({
                type: 'UPDATE_SETTINGS',
                payload: { patch: { pageSize: Number(e.target.value) } },
              })
            }
          >
            <option value={15}>15 / 页</option>
            <option value={30}>30 / 页</option>
            <option value={50}>50 / 页</option>
          </select>
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
              // 新建时自动落在当前项目下
              initialDraft={
                editing.mode === 'new'
                  ? createRuleDraft({ projectId: store.activeProjectId })
                  : undefined
              }
              projects={store.projects}
              groups={store.groups}
              shellTemplates={store.shellTemplates}
              onSave={save}
              onClose={() => setEditing(null)}
            />
          </div>
        </>
      )}

      {settingsFor &&
        (() => {
          const p = store.projects.find((x) => x.id === settingsFor);
          if (!p) return null;
          return (
            <ProjectSettings
              project={p}
              shellTemplates={store.shellTemplates}
              onSave={(patch) => void run({ type: 'UPDATE_PROJECT', payload: { id: p.id, patch } })}
              onDelete={() => {
                void run({ type: 'DELETE_PROJECT', payload: { id: p.id } });
                setSettingsFor(null);
              }}
              onClose={() => setSettingsFor(null)}
            />
          );
        })()}
    </div>
  );
}

function RuleItem({
  rule,
  index,
  total,
  groups,
  shadowedBy,
  selected,
  dragging,
  onDragStart,
  onDragEnd,
  onEdit,
  onToggle,
  onDelete,
  onDuplicate,
  onMove,
  onChangeGroup,
  onSwitchVariant,
}: {
  rule: Rule;
  index: number;
  total: number;
  groups: Group[];
  shadowedBy?: string;
  selected: boolean;
  dragging: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onEdit: () => void;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onMove: (dir: number) => void;
  onChangeGroup: (groupId: string | null) => void;
  onSwitchVariant: (variantId: string) => void;
}) {
  const active = getActiveVariant(rule);
  const cls = [
    'rule-item',
    selected && 'selected',
    !rule.enabled && 'disabled',
    dragging && 'rule-item--dragging',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls} onDoubleClick={onEdit} draggable onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div className="rule-item__head">
        <span className="rule-item__grip" title="拖动可移到其他分组">⠿</span>
        <input type="checkbox" checked={rule.enabled} onChange={(e) => onToggle(e.target.checked)} />
        <span className={`tag tag-${rule.kind}`}>{rule.kind === 'virtual' ? '虚拟' : '覆盖'}</span>
        <span className="truncate" style={{ fontWeight: 500, maxWidth: '46%' }}>{rule.name}</span>

        {/* 变体切换 —— 最高频操作，直接放在行上，不用进编辑器 */}
        <VariantSwitcher rule={rule} onSwitch={onSwitchVariant} />

        <span className="grow" />

        <span
          className={rule.enabled && rule.meta.hitCount === 0 ? 'faint' : 'muted'}
          style={{ fontSize: 10.5, flexShrink: 0 }}
          title="命中次数"
        >
          {rule.meta.hitCount} 次
        </span>

        <div className="rule-item__actions">
          {groups.length > 0 && (
            <select
              value={rule.groupId ?? ''}
              onChange={(e) => onChangeGroup(e.target.value || null)}
              onClick={(e) => e.stopPropagation()}
              style={{ width: 'auto', maxWidth: 108, padding: '1px 4px', fontSize: 11 }}
              title="所属分组"
            >
              <option value="">未分组</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          )}
          <button className="icon" disabled={index === 0} onClick={() => onMove(-1)} title="上移（提高优先级）">↑</button>
          <button className="icon" disabled={index === total - 1} onClick={() => onMove(1)} title="下移">↓</button>
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
          <span className="faint"> · {active.response.status}</span>
          {active.response.delayMs > 0 && (
            <span className="faint"> · 延迟 {active.response.delayMs}ms</span>
          )}
          {rule.variants.length > 1 && (
            <span className="faint"> · {rule.variants.length} 个变体</span>
          )}
        </div>

        {shadowedBy && rule.enabled && (
          <div className="warn" style={{ fontSize: 10.5, marginTop: 4 }}>
            ⚠ 可能被上方的「{shadowedBy}」遮蔽而永不命中，可上移调整优先级
          </div>
        )}

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
