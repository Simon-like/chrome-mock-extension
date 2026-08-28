/**
 * 变体切换器 —— 规则行上最高频的操作
 *
 * 设计要点：
 *   - 一步到位：点徽标直接出列表，不用先进编辑器
 *   - 非首个变体高亮成橙色 —— 扫一眼列表就知道哪些接口被切走了，
 *     不会调半天才发现自己还停在「报错」变体上
 *   - 只有一个变体时不显示（没有可切的，徽标只是噪音）
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  const [position, setPosition] = useState({ top: 0, left: 0, placed: false, above: false });
  const ref = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;

    const place = () => {
      const trigger = ref.current?.getBoundingClientRect();
      const menu = menuRef.current;
      if (!trigger || !menu) return;

      const margin = 8;
      const gap = 6;
      const width = menu.offsetWidth;
      const height = menu.offsetHeight;
      const above = trigger.bottom + gap + height > window.innerHeight - margin && trigger.top > height + gap + margin;
      const top = above ? trigger.top - height - gap : trigger.bottom + gap;
      // 规则行的切换器通常靠右；右对齐后菜单向左展开，不会无谓盖住 Inspector。
      const preferredLeft = trigger.right - width;
      const left = Math.min(
        Math.max(margin, preferredLeft),
        Math.max(margin, window.innerWidth - width - margin),
      );
      setPosition({ top, left, placed: true, above });
    };

    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, rule.variants.length]);

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

      {open && createPortal(
        <div
          ref={menuRef}
          className={`vpop${position.above ? ' vpop--above' : ''}`}
          style={{ top: position.top, left: position.left, visibility: position.placed ? 'visible' : 'hidden' }}
          onClick={(e) => e.stopPropagation()}
        >
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
        </div>,
        document.body,
      )}
    </span>
  );
}

function summarize(status: number, delayMs: number): string {
  return delayMs > 0 ? `${status} · ${delayMs}ms` : String(status);
}
