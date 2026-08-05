/**
 * 项目侧栏
 *
 * 项目的独特价值是绑定域名 —— 侧栏上每个项目都显示它的域名，
 * 这样「今天在调哪个系统」一眼可见。
 */

import { useMemo, useState } from 'react';
import type { MockStore, Project } from '@core/types.js';

const PAGE_SIZE = 8;

interface Props {
  store: MockStore;
  onSelect: (projectId: string | null) => void;
  onCreate: () => void;
  onOpenSettings: (projectId: string) => void;
}

export function ProjectSidebar({ store, onSelect, onCreate, onOpenSettings }: Props) {
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return store.projects;
    return store.projects.filter(
      (p) =>
        p.name.toLowerCase().includes(kw) ||
        p.hostScope.patterns.some((h) => h.toLowerCase().includes(kw)),
    );
  }, [store.projects, keyword]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const countOf = (projectId: string | null) =>
    store.rules.filter((r) => r.projectId === projectId).length;

  const unfiledCount = countOf(null);

  return (
    <div className="side">
      <div className="side__search">
        <input
          placeholder="搜索项目…"
          value={keyword}
          onChange={(e) => {
            setKeyword(e.target.value);
            setPage(0);
          }}
        />
      </div>

      <div className="side__scroll">
        <div className="side__label">
          <span>项目</span>
          <button onClick={onCreate} title="新建项目">＋</button>
        </div>

        {store.projects.length === 0 ? (
          <div className="side__hint">
            还没有项目。
            <br />
            项目用于按系统划分规则并绑定域名。
          </div>
        ) : visible.length === 0 ? (
          <div className="side__hint">没有匹配的项目</div>
        ) : (
          visible.map((p) => (
            <ProjectItem
              key={p.id}
              project={p}
              count={countOf(p.id)}
              active={store.activeProjectId === p.id}
              onSelect={() => onSelect(p.id)}
              onSettings={() => onOpenSettings(p.id)}
            />
          ))
        )}

        {pageCount > 1 && (
          <div className="side__pager">
            <button disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>‹</button>
            <span>{safePage + 1} / {pageCount}</span>
            <button disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>›</button>
          </div>
        )}

        {/* 未归档永远可见 —— 不建项目也能直接用 */}
        <div className="side__label"><span>其他</span></div>
        <button
          className={`proj${store.activeProjectId === null ? ' proj--on' : ''}`}
          onClick={() => onSelect(null)}
        >
          <div className="proj__row">
            <span className="proj__name">未归档</span>
            <span className="proj__n">{unfiledCount}</span>
          </div>
          <div className="proj__host">不限域名</div>
        </button>
      </div>
    </div>
  );
}

function ProjectItem({
  project,
  count,
  active,
  onSelect,
  onSettings,
}: {
  project: Project;
  count: number;
  active: boolean;
  onSelect: () => void;
  onSettings: () => void;
}) {
  const { patterns, mode } = project.hostScope;
  const hostLabel =
    patterns.length === 0
      ? '不限域名'
      : (mode === 'exclude' ? '排除 ' : '') +
        patterns[0] +
        (patterns.length > 1 ? ` +${patterns.length - 1}` : '');

  return (
    <button className={`proj${active ? ' proj--on' : ''}`} onClick={onSelect}>
      <div className="proj__row">
        <span className="proj__name">{project.name}</span>
        <span className="proj__n">{count}</span>
        <span
          className="proj__gear"
          title="项目设置"
          onClick={(e) => {
            e.stopPropagation();
            onSettings();
          }}
        >
          ⚙
        </span>
      </div>
      <div className="proj__host" title={patterns.join(', ')}>{hostLabel}</div>
    </button>
  );
}
