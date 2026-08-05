/**
 * 分组区块
 *
 * 分组是纯粹的容器：规则住在里面，一条规则只属于一个分组。
 * 「同一接口的多份响应」不是分组的事，那是变体（见 VariantSwitcher）。
 *
 * 复选框语义：批量启用/停用组内规则，三态显示。
 * 分组【没有】独立的启用开关 —— 否则会出现「组开着但规则全关」这类
 * 自相矛盾的状态，用户也分不清自己点的是哪一层。
 */

import { useEffect, useRef, useState } from 'react';
import type { Group, Rule } from '@core/types.js';

interface Props {
  /** null 表示「未分组」这个虚拟分区 */
  group: Group | null;
  rules: Rule[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** 批量启用/停用组内规则 */
  onToggleAll: (enabled: boolean) => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  dropActive: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  children: React.ReactNode;
}

export function GroupSection({
  group,
  rules,
  collapsed,
  onToggleCollapse,
  onToggleAll,
  onRename,
  onDelete,
  dropActive,
  onDragOver,
  onDragLeave,
  onDrop,
  children,
}: Props) {
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(group?.name ?? '');
  const [menuOpen, setMenuOpen] = useState(false);
  const checkboxRef = useRef<HTMLInputElement>(null);

  const enabledCount = rules.filter((r) => r.enabled).length;
  const allOn = rules.length > 0 && enabledCount === rules.length;
  const someOn = enabledCount > 0 && enabledCount < rules.length;

  // indeterminate 只能用 JS 设，没有对应的 HTML 属性。
  // 手动把组内规则逐个点开后，这个框会自动变成全选态 —— 状态是聚合出来的
  useEffect(() => {
    if (checkboxRef.current) checkboxRef.current.indeterminate = someOn;
  }, [someOn]);

  const commitRename = () => {
    const name = draftName.trim();
    if (name && name !== group?.name) onRename(name);
    setRenaming(false);
  };

  const cls = [
    'group',
    dropActive && 'group--drop',
    collapsed && 'group--collapsed',
    rules.length > 0 && enabledCount === 0 && 'group--off',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <section className={cls} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <header className="group__head">
        {/* 箭头本身热区太小，所以标题和右侧空白也能点折叠 */}
        <button
          className="group__toggle"
          onClick={onToggleCollapse}
          title={collapsed ? '展开' : '折叠'}
        >
          <svg className="group__caret" viewBox="0 0 12 12" width="11" height="11" aria-hidden>
            <path
              d="M4 2.5L8 6l-4 3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        <input
          ref={checkboxRef}
          type="checkbox"
          checked={allOn}
          disabled={rules.length === 0}
          onChange={(e) => onToggleAll(e.target.checked)}
          title={
            rules.length === 0
              ? '组内没有规则'
              : allOn
                ? '停用组内全部规则'
                : '启用组内全部规则'
          }
        />

        {renaming ? (
          <input
            autoFocus
            className="group__rename"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <span
            className="group__name"
            onClick={onToggleCollapse}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (!group) return;
              setDraftName(group.name);
              setRenaming(true);
            }}
            title={group ? '单击折叠 · 双击重命名' : '单击折叠'}
          >
            {group ? group.name : '未分组'}
          </span>
        )}

        <span className="group__count">
          {rules.length === 0 ? '空' : `${enabledCount} / ${rules.length}`}
        </span>

        <span className="group__spacer" onClick={onToggleCollapse} />

        {group && (
          <div className="group__menu">
            <button className="icon" onClick={() => setMenuOpen((v) => !v)} title="更多">
              ⋯
            </button>
            {menuOpen && (
              <>
                <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
                <div className="menu">
                  <button
                    onClick={() => {
                      setDraftName(group.name);
                      setRenaming(true);
                      setMenuOpen(false);
                    }}
                  >
                    重命名
                  </button>
                  <div className="menu__sep" />
                  <button
                    className="danger"
                    onClick={() => {
                      onDelete();
                      setMenuOpen(false);
                    }}
                  >
                    删除分组
                  </button>
                  <div className="menu__hint">删除后组内规则会移到「未分组」</div>
                </div>
              </>
            )}
          </div>
        )}
      </header>

      {/* 折叠动画用 grid-template-rows: 0fr → 1fr。
          这样能过渡到内容的自适应高度，不必提前测量 scrollHeight */}
      <div className="group__wrap">
        <div className="group__body">
          {rules.length === 0 ? (
            <div className="group__empty">
              {dropActive ? '松开放入此分组' : '空分组 —— 把规则拖进来'}
            </div>
          ) : (
            children
          )}
        </div>
      </div>
    </section>
  );
}
