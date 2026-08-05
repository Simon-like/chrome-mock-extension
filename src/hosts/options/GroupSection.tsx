/**
 * 分组区块
 *
 * 两种分组，视觉上必须能一眼分清：
 *   - 普通组：复选框，多个可同时启用，用于按业务模块归拢规则
 *   - 互斥组：单选框 + ⚡ 标记，同一时刻只有一个启用 —— 这就是「场景切换」
 *
 * 之所以不引入独立的 Scenario 概念，是因为「一组规则一起生效、且与其他组互斥」
 * 本质就是分组加一个属性，多一个概念只会增加理解成本。
 */

import { useState } from 'react';
import type { Group, Rule } from '@core/types.js';

interface Props {
  group: Group | null; // null 表示「未分组」这个虚拟分区
  rules: Rule[];
  /** 该组内是否有互斥兄弟组，用于决定渲染单选还是复选 */
  isExclusive: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onSetExclusive: (exclusive: boolean) => void;
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
  isExclusive,
  collapsed,
  onToggleCollapse,
  onToggleEnabled,
  onRename,
  onDelete,
  onSetExclusive,
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
          /* 互斥组用单选框：点一下即切换场景，语义上就是「选中这一个」 */
          <input
            type={isExclusive ? 'radio' : 'checkbox'}
            checked={enabled}
            onChange={(e) => onToggleEnabled(e.target.checked)}
            /* radio 需要同名才能表现出单选外观 */
            name={isExclusive ? 'mockstudio-exclusive-group' : undefined}
            title={isExclusive ? '切换到这个场景' : '启用 / 停用该分组'}
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

        {isExclusive && (
          <span className="tag tag-exclusive" title="同一时刻只有一个互斥组生效">
            ⚡ 互斥
          </span>
        )}

        <span className="faint" style={{ fontSize: 10.5, flexShrink: 0 }}>
          {activeCount}/{rules.length}
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
                  <button
                    onClick={() => {
                      onSetExclusive(!group.exclusive);
                      setMenuOpen(false);
                    }}
                  >
                    {group.exclusive ? '改为普通分组' : '改为互斥分组（场景）'}
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
          {rules.length === 0 ? (
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
