/**
 * 删除确认弹层
 *
 * 删除容器时必须让用户明确选择内容怎么办 —— 直接删掉是不可逆的，
 * 而静默保留又可能让用户以为规则也一起没了。
 *
 * 默认选中「保留」：删错了还能找回来，删没了找不回来。
 */

import { useState } from 'react';

export type DeleteMode = 'detach' | 'cascade';

interface Props {
  title: string;
  /** 被删对象的名字 */
  name: string;
  /** 会受影响的规则条数 */
  ruleCount: number;
  /** 会受影响的分组数（删项目时才有） */
  groupCount?: number;
  /** 保留时内容去哪儿，如「未分组」「未归档」 */
  detachLabel: string;
  onConfirm: (mode: DeleteMode) => void;
  onCancel: () => void;
}

export function ConfirmDelete({
  title,
  name,
  ruleCount,
  groupCount,
  detachLabel,
  onConfirm,
  onCancel,
}: Props) {
  const [mode, setMode] = useState<DeleteMode>('detach');
  const empty = ruleCount === 0 && !groupCount;

  return (
    <>
      <div className="modal__backdrop" onClick={onCancel} />
      <div className="modal modal--sm">
        <div className="modal__head">
          <strong style={{ fontSize: 13 }}>{title}</strong>
        </div>

        <div className="modal__body">
          <p style={{ margin: '0 0 14px', fontSize: 12.5, lineHeight: 1.7 }}>
            即将删除「<b>{name}</b>」。
            {!empty && (
              <>
                <br />
                <span className="muted">
                  它包含 {groupCount ? `${groupCount} 个分组、` : ''}
                  {ruleCount} 条规则。
                </span>
              </>
            )}
          </p>

          {empty ? (
            <div className="faint" style={{ fontSize: 11.5 }}>
              里面是空的，删除不会影响任何规则。
            </div>
          ) : (
            <div className="choice">
              <label className={`choice__item${mode === 'detach' ? ' choice__item--on' : ''}`}>
                <input
                  type="radio"
                  name="delete-mode"
                  checked={mode === 'detach'}
                  onChange={() => setMode('detach')}
                />
                <span>
                  <b>保留内容</b>
                  <em>
                    {groupCount ? '分组与规则' : '规则'}移到「{detachLabel}」，之后可继续使用
                  </em>
                </span>
              </label>

              <label className={`choice__item${mode === 'cascade' ? ' choice__item--on' : ''}`}>
                <input
                  type="radio"
                  name="delete-mode"
                  checked={mode === 'cascade'}
                  onChange={() => setMode('cascade')}
                />
                <span>
                  <b className="bad">一并删除</b>
                  <em>
                    连同 {groupCount ? `${groupCount} 个分组和 ` : ''}
                    {ruleCount} 条规则全部删除，<b className="bad">不可恢复</b>
                  </em>
                </span>
              </label>
            </div>
          )}
        </div>

        <div className="modal__foot">
          <button onClick={onCancel}>取消</button>
          <button
            className={mode === 'cascade' && !empty ? 'primary danger-solid' : 'primary'}
            onClick={() => onConfirm(mode)}
          >
            {empty ? '删除' : mode === 'cascade' ? '删除全部' : '删除并保留内容'}
          </button>
        </div>
      </div>
    </>
  );
}
