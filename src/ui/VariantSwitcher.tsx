/**
 * 变体切换器 —— 规则行上最高频的操作
 *
 * 设计要点：
 *   - 一步到位：点徽标直接出列表，不用先进编辑器
 *   - 非首个变体高亮成橙色 —— 扫一眼列表就知道哪些接口被切走了，
 *     不会调半天才发现自己还停在「报错」变体上
 *   - 只有一个变体时不显示（没有可切的，徽标只是噪音）
 */

import { useEffect, useRef, useState } from 'react';
import type { Rule } from '@core/types.js';

interface Props {
  rule: Rule;
  onSwitch: (variantId: string) => void;
  onCreate?: () => void;
  /** 只有一个变体时是否仍然显示 */
  alwaysShow?: boolean;
}

export function VariantSwitcher({ rule, onSwitch, onCreate, alwaysShow }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  if (rule.variants.length <= 1 && !alwaysShow) return null;

  const activeIndex = rule.variants.findIndex((v) => v.id === rule.activeVariantId);
  const active = rule.variants[activeIndex] ?? rule.variants[0]!;
  // 第一个变体视为默认，切走了就提示
  const switched = activeIndex > 0;

  return (
    <span
      ref={ref}
      className={`vsel${switched ? ' vsel--alt' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        setOpen((v) => !v);
      }}
      title={`当前变体：${active.name}`}
    >
      <span className="vsel__name">{active.name}</span>
      <span className="vsel__caret">▾</span>

      {open && (
        <div className="vpop" onClick={(e) => e.stopPropagation()}>
          {rule.variants.map((v) => (
            <button
              key={v.id}
              className={v.id === rule.activeVariantId ? 'on' : ''}
              onClick={() => {
                onSwitch(v.id);
                setOpen(false);
              }}
            >
              <span className="vpop__check">{v.id === rule.activeVariantId ? '✓' : ''}</span>
              <span className="vpop__name">{v.name}</span>
              <span className="vpop__meta">{summarize(v.response.status, v.response.delayMs)}</span>
            </button>
          ))}
          {onCreate && (
            <>
              <div className="vpop__sep" />
              <button
                className="vpop__add"
                onClick={() => {
                  onCreate();
                  setOpen(false);
                }}
              >
                ＋ 基于当前新增变体
              </button>
            </>
          )}
        </div>
      )}
    </span>
  );
}

function summarize(status: number, delayMs: number): string {
  return delayMs > 0 ? `${status} · ${delayMs}ms` : String(status);
}
