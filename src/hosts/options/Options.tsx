/**
 * Options 页 —— 规则管理主界面
 *
 * 三层容器 + 一个正交轴，UI 上要区分清楚：
 *   - 项目：按系统划分，绑定域名（侧栏）
 *   - 分组：业务模块归类，纯粹的容器（主区标题）
 *   - 规则：列表顺序即匹配优先级（先到先得）
 *   - 变体：同一接口的多份响应，在规则行上直接切换（不属于容器层级）
 *
 * 规则行上的控件语义（三种形态，互不重复）：
 *   ⠿  把手   = 拖动改归属      （默认态）
 *   ☑  复选框 = 选中这一行      （选择态，占把手的槽位）
 *   ●— 开关   = 这条规则开着吗  （两种状态都在，始终可点）
 * 早期启用/停用也用 checkbox，一进批量模式一行就出现两个方框，
 * 只能把其中一个禁用来消歧 —— 现在换成开关，形态本身就区分开了。
 */

import { useEffect, useMemo, useState } from 'react';
import { findShadowedRules } from '@core/store/validate.js';
import { createRuleDraft, getActiveVariant } from '@core/store/defaults.js';
import type { Group, Rule, RuleDraft } from '@core/types.js';
import { useStore } from '@ui/useStore.js';
import { Splitter, useResizable } from '@ui/Splitter.js';
import { VariantSwitcher } from '@ui/VariantSwitcher.js';
import { Switch } from '@ui/Switch.js';
import { RuleEditor } from './RuleEditor.js';
import { GroupSection } from './GroupSection.js';
import { GearIcon, ProjectSidebar } from './ProjectSidebar.js';
import { ConfirmDelete, type DeleteMode } from '@ui/ConfirmDelete.js';
import { ProjectSettings } from './ProjectSettings.js';
import { McpSettings } from './McpSettings.js';
import { AppSettings } from './AppSettings.js';

const EDITOR_DEFAULT_WIDTH = 560;
const DRAG_MIME = 'application/x-mockstudio-rule';

type Editing = { mode: 'edit'; ruleId: string } | { mode: 'new' } | null;

export function Options() {
  const { store, loading, error, run } = useStore();
  const [editing, setEditing] = useState<Editing>(null);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [appSettingsOpen, setAppSettingsOpen] = useState(false);
  /** 首次安装由 onInstalled 带 ?welcome=1 打开本页 —— 展示三步上手引导 */
  const [welcome, setWelcome] = useState(
    () => new URLSearchParams(window.location.search).has('welcome'),
  );
  /** 待确认删除的对象。删容器是不可逆操作，必须让用户明确选内容怎么办 */
  const [deleting, setDeleting] = useState<
    | { kind: 'group'; id: string }
    | { kind: 'project'; id: string }
    | { kind: 'rules'; ids: string[] }
    | null
  >(null);
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);
  const [keyword, setKeyword] = useState('');
  const [draggingId, setDraggingId] = useState<string | null>(null);
  /** 「未分组」不是真实的 Group，没有 collapsed 字段可存，用本地状态 */
  const [ungroupedCollapsed, setUngroupedCollapsed] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  /**
   * 选择态。null = 不在选择态（列表显示拖拽把手），Set = 在选择态（显示复选框）。
   *
   * 为什么仍然保留「态」而不是常驻复选框：
   *   常驻复选框会让每一行多一个平时用不到的控件，列表越长噪音越大；
   *   而且把手和复选框都要占最左槽位，常驻就没地方放把手了 ——
   *   拖拽归组是默认态的高频操作，不能为了低频的批量把它挤掉。
   *
   * 两个入口：工具栏「选择」按钮（显式、可发现），或在任意规则行上
   * Cmd/Ctrl+点击（隐式、零成本，习惯了文件管理器的人会直接试）。
   * 退出：Esc、「完成」按钮，或清空选择后再点一次「选择」。
   */
  const [selection, setSelection] = useState<Set<string> | null>(null);
  /** Shift 范围选择的锚点 —— 上一次单独点选的行 */
  const [anchorId, setAnchorId] = useState<string | null>(null);

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

  /**
   * 列表里从上到下的规则顺序 —— Shift 范围选择要按「看到的顺序」算，
   * 而不是 store.rules 的顺序（分组把它打散了）。
   */
  const visibleOrder = useMemo(() => {
    if (!store) return [] as string[];
    const groupIds = store.groups
      .filter((g) => g.projectId === store.activeProjectId)
      .map((g) => g.id as string | null);
    // 渲染顺序：各分组在前，「未分组」垫底（与下方 renderGroup 的调用顺序一致）
    return [...groupIds, null].flatMap((gid) =>
      searched.filter((r) => r.groupId === gid).map((r) => r.id),
    );
  }, [store, searched]);

  // Esc 退出选择态。放在这里而不是行上 —— 焦点可能在任何地方
  useEffect(() => {
    if (selection === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelection(null);
        setAnchorId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection]);

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

  const inSelectMode = selection !== null;
  const selectedIds = selection ? [...selection] : [];

  const selectMany = (ids: string[], on: boolean) =>
    setSelection((cur) => {
      const next = new Set(cur ?? []);
      for (const id of ids) (on ? next.add(id) : next.delete(id));
      return next;
    });

  const exitSelect = () => {
    setSelection(null);
    setAnchorId(null);
  };

  /**
   * 点选一行。Shift 表示「从锚点到这里全选」—— 和文件管理器一致。
   * 锚点只在非 Shift 的点击时更新，这样连续 Shift 点击是在同一个锚点上改范围，
   * 而不是每点一次就把范围截断重来。
   */
  const pickRule = (id: string, shift: boolean) => {
    if (shift && anchorId && anchorId !== id) {
      const a = visibleOrder.indexOf(anchorId);
      const b = visibleOrder.indexOf(id);
      if (a >= 0 && b >= 0) {
        const range = visibleOrder.slice(Math.min(a, b), Math.max(a, b) + 1);
        selectMany(range, true);
        return;
      }
    }
    setAnchorId(id);
    setSelection((cur) => {
      const next = new Set(cur ?? []);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const activeProject = store.projects.find((p) => p.id === store.activeProjectId) ?? null;
  const groupsInScope = store.groups.filter((g) => g.projectId === store.activeProjectId);

  const save = async (draft: RuleDraft): Promise<boolean> => {
    if (editing?.mode === 'edit') {
      const res = await run({
        type: 'SAVE_RULE_DRAFT',
        payload: { id: editing.ruleId, draft },
      });
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
        selectMode={inSelectMode}
        checked={selection?.has(rule.id) ?? false}
        onPick={(shift) => pickRule(rule.id, shift)}
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

    // 未分组区没有规则时不渲染 —— 它是虚拟分区，空着只会占地方。
    // 真实分组即使为空也要渲染，否则新建的分组会「消失」，用户以为没建成功
    if (!group && rules.length === 0) return null;

    return (
      <GroupSection
        key={key}
        group={group}
        rules={rules}
        collapsed={group ? group.collapsed : ungroupedCollapsed}
        selectMode={inSelectMode}
        selectedCount={selection ? rules.filter((r) => selection.has(r.id)).length : 0}
        onSelectAll={(on) => selectMany(rules.map((r) => r.id), on)}
        dropActive={dropTarget === key}
        onDragOver={(e) => allowDrop(e, key)}
        onDragLeave={() => setDropTarget((t) => (t === key ? null : t))}
        onDrop={(e) => handleDrop(e, group?.id ?? null)}
        onToggleCollapse={() => {
          if (!group) {
            setUngroupedCollapsed((v) => !v);
            return;
          }
          void run({
            type: 'UPDATE_GROUP',
            payload: { id: group.id, patch: { collapsed: !group.collapsed } },
          });
        }}
        onToggleAll={(enabled) =>
          void run({ type: 'TOGGLE_GROUP', payload: { id: group?.id ?? null, enabled } })
        }
        onRename={(name) =>
          group && void run({ type: 'UPDATE_GROUP', payload: { id: group.id, patch: { name } } })
        }
        onDelete={() => group && setDeleting({ kind: 'group', id: group.id })}
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
          setEditing(null);
        }}
        onCreate={async () => {
          const res = await run({ type: 'CREATE_PROJECT', payload: { name: '新项目' } });
          if (res.ok && res.createdId) setSettingsFor(res.createdId);
        }}
        onOpenSettings={setSettingsFor}
      />

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {welcome && (
          <div className="banner welcome-banner">
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong>欢迎使用 Mock Studio —— 三步上手：</strong>
              <ol className="faint" style={{ margin: '6px 0 0', paddingLeft: 18, lineHeight: 1.8 }}>
                <li>
                  随便打开一个页面，点工具栏的 Mock Studio 图标，确认请求已能被看到
                </li>
                <li>
                  想让 AI 直接帮你写 mock？点右上角 <b>MCP</b> → 启用桥 →
                  用「一键安装」或 install 命令接入你的 AI 客户端
                </li>
                <li>对 AI 说一句「页面没数据，帮我 mock 一下」，刷新页面看效果</li>
              </ol>
            </div>
            <button className="primary" onClick={() => setMcpOpen(true)}>
              接入 AI（MCP）
            </button>
            <button
              className="ghost"
              onClick={() => {
                setWelcome(false);
                // 去掉 ?welcome=1，刷新后不再出现
                window.history.replaceState(null, '', window.location.pathname);
              }}
            >
              知道了
            </button>
          </div>
        )}
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
              <button className="btn-icon" onClick={() => setSettingsFor(activeProject.id)}>
                <GearIcon size={15} />
                项目设置
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

        <div className="options-toolbar">
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
            onChange={(e) => setKeyword(e.target.value)}
            style={{ width: 190 }}
          />
          <button
            className={inSelectMode ? 'primary' : ''}
            onClick={() => (inSelectMode ? exitSelect() : setSelection(new Set()))}
            disabled={scopedRules.length === 0}
            title={
              inSelectMode
                ? '退出选择（Esc）'
                : '选中多条规则后可一次启停、移动或删除。也可在规则行上 Cmd/Ctrl+点击直接进入'
            }
          >
            {inSelectMode ? '完成选择' : '选择'}
          </button>
          <span className="grow" />
          <button className="ghost" onClick={() => setAppSettingsOpen(true)} title="主题、请求采集与 MCP">
            <GearIcon size={14} /> 设置
          </button>
          <details className="toolbar-more">
            <summary>更多</summary>
            <div className="toolbar-more__menu">
              <button onClick={importFromClipboard} title="粘贴 AI 生成的规则 JSON">剪贴板导入</button>
              <button onClick={() => importRules('merge')}>从文件导入</button>
              <button onClick={() => importRules('replace')}>导入并替换</button>
              <span />
              <button onClick={exportRules}>导出全部规则</button>
            </div>
          </details>
        </div>

        {notice && (
          <div style={{ padding: '0 22px 10px' }}>
            <div className={`banner ${notice.bad ? 'banner-bad' : 'banner-ok'}`}>{notice.text}</div>
          </div>
        )}

        {/* 选择操作条。选中数为 0 时也显示，否则用户会以为「选择」没生效。
            0 条时不给禁用按钮的海洋看，只留一行提示 —— 见下方 selectedIds.length === 0 分支 */}
        {inSelectMode && (
          <div className="bulkbar">
            <label className="row" style={{ gap: 6, margin: 0, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={selectedIds.length > 0 && selectedIds.length === searched.length}
                ref={(el) => {
                  if (el)
                    el.indeterminate =
                      selectedIds.length > 0 && selectedIds.length < searched.length;
                }}
                onChange={(e) => selectMany(searched.map((r) => r.id), e.target.checked)}
              />
              <span style={{ fontSize: 12 }}>
                已选 <b>{selectedIds.length}</b> / {searched.length} 条
              </span>
            </label>

            {selectedIds.length === 0 && (
              <span className="bulkbar__hint">
                勾选左侧复选框选中规则 · Shift 点击可选一段 · Esc 退出
              </span>
            )}

            <span className="grow" />

            <select
              value=""
              disabled={selectedIds.length === 0}
              onChange={(e) => {
                const v = e.target.value;
                if (!v) return;
                void run({
                  type: 'MOVE_RULES',
                  payload: { ids: selectedIds, groupId: v === '__none__' ? null : v },
                }).then((res) => {
                  if (res.ok) {
                    flash(`已移动 ${selectedIds.length} 条规则`);
                    setSelection(new Set());
                  }
                });
              }}
              style={{ width: 'auto', minWidth: 120 }}
            >
              <option value="">移动到分组…</option>
              <option value="__none__">未分组</option>
              {groupsInScope.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>

            <button
              disabled={selectedIds.length === 0}
              onClick={() =>
                void run({ type: 'TOGGLE_RULES', payload: { ids: selectedIds, enabled: true } })
              }
            >
              启用
            </button>
            <button
              disabled={selectedIds.length === 0}
              onClick={() =>
                void run({ type: 'TOGGLE_RULES', payload: { ids: selectedIds, enabled: false } })
              }
            >
              停用
            </button>
            <button
              className="danger"
              disabled={selectedIds.length === 0}
              onClick={() => setDeleting({ kind: 'rules', ids: selectedIds })}
            >
              删除
            </button>
            <button className="ghost" onClick={exitSelect}>完成</button>
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', padding: '0 22px 18px', minHeight: 0 }}>
          {/* 三种空状态要分清楚，否则会出现「建了分组却什么都不显示」的困惑 */}
          {scopedRules.length === 0 && groupsInScope.length === 0 ? (
            <div className="empty">
              {activeProject ? `「${activeProject.name}」还没有规则` : '还没有规则'}
              <br />
              <span style={{ fontSize: 11.5 }}>
                提示：在页面按 F12 打开 <strong>Mock</strong> 面板，可以把真实请求一键转成规则
              </span>
            </div>
          ) : keyword.trim() && searched.length === 0 ? (
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
              title={editing.mode === 'new' ? '新建规则' : undefined}
              projects={store.projects}
              groups={store.groups}
              shellTemplates={store.shellTemplates}
              onSave={save}
              onClose={() => setEditing(null)}
            />
          </div>
        </>
      )}

      {mcpOpen && (
        <McpSettings
          settings={store.settings}
          onSave={(patch) => {
            void run({ type: 'UPDATE_SETTINGS', payload: { patch } }).then((res) => {
              if (res.ok) flash(patch.mcpEnabled ? 'MCP 设置已保存' : 'MCP 桥已关闭');
            });
          }}
          onClose={() => setMcpOpen(false)}
        />
      )}

      {appSettingsOpen && (
        <AppSettings
          settings={store.settings}
          onSave={(patch) => void run({ type: 'UPDATE_SETTINGS', payload: { patch } })}
          onOpenMcp={() => {
            setAppSettingsOpen(false);
            setMcpOpen(true);
          }}
          onClose={() => setAppSettingsOpen(false)}
        />
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
                setSettingsFor(null);
                setDeleting({ kind: 'project', id: p.id });
              }}
              onClose={() => setSettingsFor(null)}
            />
          );
        })()}

      {deleting?.kind === 'rules' &&
        (() => {
          const ids = deleting.ids;
          return (
            <ConfirmDelete
              title="删除规则"
              name={
                ids.length === 1
                  ? (store.rules.find((r) => r.id === ids[0])?.name ?? '规则')
                  : `${ids.length} 条规则`
              }
              ruleCount={0}
              detachLabel=""
              onConfirm={() => {
                void run({ type: 'DELETE_RULES', payload: { ids } }).then((res) => {
                  if (res.ok) {
                    flash(`已删除 ${ids.length} 条规则`);
                    setSelection(new Set());
                    if (editing?.mode === 'edit' && ids.includes(editing.ruleId)) setEditing(null);
                  }
                });
                setDeleting(null);
              }}
              onCancel={() => setDeleting(null)}
            />
          );
        })()}

      {deleting &&
        deleting.kind !== 'rules' &&
        (() => {
          const isProject = deleting.kind === 'project';
          const target = isProject
            ? store.projects.find((x) => x.id === deleting.id)
            : store.groups.find((x) => x.id === deleting.id);
          if (!target) return null;

          const affectedRules = isProject
            ? store.rules.filter((r) => r.projectId === deleting.id)
            : store.rules.filter((r) => r.groupId === deleting.id);
          const affectedGroups = isProject
            ? store.groups.filter((g) => g.projectId === deleting.id)
            : [];

          const confirm = (mode: DeleteMode) => {
            void run(
              isProject
                ? { type: 'DELETE_PROJECT', payload: { id: deleting.id, cascade: mode } }
                : { type: 'DELETE_GROUP', payload: { id: deleting.id, cascade: mode } },
            );
            setDeleting(null);
            flash(
              mode === 'cascade'
                ? `已删除「${target.name}」及其内容`
                : `已删除「${target.name}」，内容已保留`,
            );
          };

          return (
            <ConfirmDelete
              title={isProject ? '删除项目' : '删除分组'}
              name={target.name}
              ruleCount={affectedRules.length}
              groupCount={isProject ? affectedGroups.length : undefined}
              detachLabel={isProject ? '未归档' : '未分组'}
              onConfirm={confirm}
              onCancel={() => setDeleting(null)}
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
  selectMode,
  checked,
  onPick,
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
  selectMode: boolean;
  checked: boolean;
  /** shift 为 true 表示范围选择 */
  onPick: (shift: boolean) => void;
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
    selectMode && 'rule-item--pickable',
    checked && 'rule-item--checked',
    !rule.enabled && 'disabled',
    dragging && 'rule-item--dragging',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={cls}
      onDoubleClick={selectMode ? undefined : onEdit}
      // 选择态：整行可点即选中。默认态：Cmd/Ctrl+点击直接进入选择态并选中这一行
      onClick={(e) => {
        if (selectMode) {
          onPick(e.shiftKey);
        } else if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          onPick(false);
        }
      }}
      draggable={!selectMode}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div className="rule-item__head">
        {selectMode ? (
          <input
            type="checkbox"
            className="rule-item__pick"
            checked={checked}
            // 复选框只负责显示。点击穿透到行的 onClick 统一走 pickRule
            // （CSS 里 pointer-events: none），否则 shift 范围选择会走两条路径算两次
            readOnly
            title="选中这一行 · Shift 点击可选一段"
          />
        ) : (
          <span className="rule-item__grip" title="拖动可移到其他分组">⠿</span>
        )}
        <Switch
          checked={rule.enabled}
          onChange={onToggle}
          label={`启用 / 停用「${rule.name}」`}
          title={rule.enabled ? '已启用 —— 点击停用' : '已停用 —— 点击启用'}
        />
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

        <div className="rule-item__actions" style={selectMode ? { display: 'none' } : undefined}>
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
