/**
 * 分组区块
 *
 * 分组是纯粹的容器：规则住在里面，一条规则只属于一个分组。
 * 「同一接口的多份响应」不是分组的事，那是变体（见 VariantSwitcher）。
 */

import { useState } from 'react';
import type { Group, Rule } from '@core/types.js';

interface Props {
  group: Group | null; // null 表示「未分组」这个虚拟分区
  rules: Rule[];
  /** 本页实际展示了几条 —— 分页会把同组规则切开，要让用户知道 */
  shownCount: number;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  /** 拖拽相关 */
  dropActive: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  children: React.ReactNode;
}

export function GroupSection({
  group,
  rules,
  shownCount,
  collapsed,
  onToggleCollapse,
  onToggleEnabled,
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

  const enabled = group ? group.enabled : true;
  const activeCount = rules.filter((r) => r.enabled).length;

  const commitRename = () => {
    const name = draftName.trim();
    if (name && name !== group?.name) onRename(name);
    setRenaming(false);
  };

  return (
    <div
      className={`group-section${dropActive ? ' group-section--drop' : ''}${
        !enabled ? ' group-section--off' : ''
      }`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="group-section__head">
        <button
          className="group-section__caret"
          onClick={onToggleCollapse}
          title={collapsed ? '展开' : '折叠'}
        >
          {collapsed ? '▸' : '▾'}
        </button>

        {group ? (
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onToggleEnabled(e.target.checked)}
            title="启用 / 停用该分组"
          />
        ) : (
          <span style={{ width: 13, flexShrink: 0 }} />
        )}

        {renaming ? (
          <input
            autoFocus
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') setRenaming(false);
            }}
            style={{ maxWidth: 200, padding: '2px 6px' }}
          />
        ) : (
          <span
            className="group-section__name"
            onDoubleClick={() => {
              if (!group) return;
              setDraftName(group.name);
              setRenaming(true);
            }}
            title={group ? '双击重命名' : undefined}
          >
            {group ? group.name : '未分组'}
          </span>
        )}

        <span className="faint" style={{ fontSize: 10.5, flexShrink: 0 }}>
          {shownCount < rules.length
            ? `本页 ${shownCount} / 共 ${rules.length}`
            : `${activeCount} / ${rules.length}`}
        </span>

        <span className="grow" />

        {group && (
          <div className="group-section__menu">
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
      </div>

      {!collapsed && (
        <div className="group-section__body">
          {shownCount === 0 && rules.length === 0 ? (
            <div className="group-section__empty">
              {dropActive ? '松开放入此分组' : '空分组 —— 把规则拖进来'}
            </div>
          ) : (
            children
          )}
        </div>
      )}
    </div>
  );
}
