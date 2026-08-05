/**
 * 项目设置弹层
 *
 * 核心是域名作用域。默认不限，用户按需再加 —— 建项目时不必先想清楚域名。
 */

import { useState } from 'react';
import type { Project, ShellTemplate } from '@core/types.js';

interface Props {
  project: Project;
  shellTemplates: ShellTemplate[];
  onSave: (patch: Partial<Omit<Project, 'id'>>) => void;
  onDelete: () => void;
  onClose: () => void;
}

export function ProjectSettings({ project, shellTemplates, onSave, onDelete, onClose }: Props) {
  const [name, setName] = useState(project.name);
  const [mode, setMode] = useState(project.hostScope.mode);
  const [patternsText, setPatternsText] = useState(project.hostScope.patterns.join('\n'));
  const [shellId, setShellId] = useState(project.defaultShellTemplateId ?? '');
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const patterns = patternsText
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const save = () => {
    if (!name.trim()) return;
    onSave({
      name: name.trim(),
      hostScope: { mode, patterns },
      defaultShellTemplateId: shellId || null,
    });
    onClose();
  };

  return (
    <>
      <div className="modal__backdrop" onClick={onClose} />
      <div className="modal">
        <div className="modal__head">
          <strong style={{ fontSize: 13 }}>项目设置</strong>
          <button onClick={onClose}>关闭</button>
        </div>

        <div className="modal__body">
          <div style={{ marginBottom: 14 }}>
            <label>项目名</label>
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>

          <div style={{ marginBottom: 14 }}>
            <label>
              域名作用域
              <span className="faint" style={{ fontWeight: 400 }}> · 留空 = 不限域名</span>
            </label>
            <div className="row" style={{ gap: 6, marginBottom: 6 }}>
              <button
                className={mode === 'include' ? 'primary tiny' : 'tiny'}
                onClick={() => setMode('include')}
              >
                白名单
              </button>
              <button
                className={mode === 'exclude' ? 'primary tiny' : 'tiny'}
                onClick={() => setMode('exclude')}
              >
                黑名单
              </button>
              <span className="faint" style={{ fontSize: 10.5 }}>
                {mode === 'include' ? '只在列出的域名下生效' : '除列出的域名外都生效'}
              </span>
            </div>
            <textarea
              className="mono"
              rows={4}
              placeholder={'每行一个，支持通配\ndev2.glink.jd.com\n*.jd.com'}
              value={patternsText}
              onChange={(e) => setPatternsText(e.target.value)}
            />
            {patterns.length === 0 && (
              <div className="faint" style={{ fontSize: 10.5, marginTop: 4 }}>
                当前不限域名，项目内规则在所有站点都可能生效
              </div>
            )}
          </div>

          <div style={{ marginBottom: 14 }}>
            <label>
              默认响应外壳
              <span className="faint" style={{ fontWeight: 400 }}> · 新建规则时自动套用</span>
            </label>
            <select value={shellId} onChange={(e) => setShellId(e.target.value)}>
              <option value="">不设默认</option>
              {shellTemplates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>

          <div className="modal__danger">
            {confirmingDelete ? (
              <div className="row" style={{ gap: 8 }}>
                <span className="bad" style={{ fontSize: 11.5 }}>
                  确认删除？其下分组与规则会移到「未归档」，不会被删除
                </span>
                <span className="grow" />
                <button className="tiny" onClick={() => setConfirmingDelete(false)}>取消</button>
                <button className="danger tiny" onClick={onDelete}>确认删除</button>
              </div>
            ) : (
              <button className="danger tiny" onClick={() => setConfirmingDelete(true)}>
                删除项目
              </button>
            )}
          </div>
        </div>

        <div className="modal__foot">
          <button onClick={onClose}>取消</button>
          <button className="primary" disabled={!name.trim()} onClick={save}>保存</button>
        </div>
      </div>
    </>
  );
}
