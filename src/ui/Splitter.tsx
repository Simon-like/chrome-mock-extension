/**
 * 可拖拽分隔条 —— 用来调整右侧面板宽度（类似 VSCode 侧栏）
 *
 * 设计要点：
 *   - 视觉上是一条 1px 细线，但热区有 9px，否则很难点中
 *   - 用 Pointer Events + setPointerCapture：拖到浏览器窗口外也不会丢失跟踪
 *   - 拖动中给 body 挂全局样式，防止选中文本、防止 iframe 抢走指针
 *   - 双击重置为默认宽度
 *   - 宽度记在 localStorage，按 storageKey 区分不同界面（options / devtools）
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseResizableOptions {
  /** localStorage 的 key，不同界面用不同 key */
  storageKey: string;
  defaultWidth: number;
  minWidth?: number;
  /** 最大宽度。传函数可基于窗口宽度动态计算 */
  maxWidth?: number | (() => number);
}

export function useResizable({
  storageKey,
  defaultWidth,
  minWidth = 360,
  maxWidth,
}: UseResizableOptions) {
  const [width, setWidth] = useState(() => readStored(storageKey) ?? defaultWidth);
  const [dragging, setDragging] = useState(false);

  const resolveMax = useCallback(() => {
    if (typeof maxWidth === 'function') return maxWidth();
    if (typeof maxWidth === 'number') return maxWidth;
    // 默认最多占窗口的 80%，保证左侧列表还看得见
    return Math.max(minWidth, window.innerWidth * 0.8);
  }, [maxWidth, minWidth]);

  const clamp = useCallback(
    (w: number) => Math.min(Math.max(w, minWidth), resolveMax()),
    [minWidth, resolveMax],
  );

  const commit = useCallback(
    (w: number) => {
      const next = clamp(w);
      setWidth(next);
      try {
        localStorage.setItem(storageKey, String(next));
      } catch {
        /* 隐私模式下可能不可写，不影响使用 */
      }
    },
    [clamp, storageKey],
  );

  // 窗口变小时，面板不该把列表挤没
  useEffect(() => {
    const onResize = () => setWidth((w) => clamp(w));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clamp]);

  return { width, setWidth: commit, dragging, setDragging, defaultWidth, clamp };
}

interface SplitterProps {
  /** 当前宽度，拖动时实时更新 */
  onResize: (width: number) => void;
  /** 拖动结束时落盘 */
  onResizeEnd?: (width: number) => void;
  onDragStateChange?: (dragging: boolean) => void;
  /** 双击重置 */
  onReset?: () => void;
  /**
   * 面板贴在哪一侧。'right' 表示面板在分隔条右边，
   * 此时宽度 = 窗口右边缘 - 指针 x
   */
  side?: 'right' | 'left';
  title?: string;
}

export function Splitter({
  onResize,
  onResizeEnd,
  onDragStateChange,
  onReset,
  side = 'right',
  title = '拖动调整宽度，双击重置',
}: SplitterProps) {
  const [active, setActive] = useState(false);
  const latestWidth = useRef(0);

  const computeWidth = (clientX: number) =>
    side === 'right' ? window.innerWidth - clientX : clientX;

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    setActive(true);
    onDragStateChange?.(true);

    // 拖动期间禁掉文本选中和指针事件，否则会选中页面文字、
    // 或者指针飘到 CodeMirror 上被它吃掉
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    const onMove = (ev: PointerEvent) => {
      latestWidth.current = computeWidth(ev.clientX);
      onResize(latestWidth.current);
    };

    const onUp = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      setActive(false);
      onDragStateChange?.(false);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      onResizeEnd?.(latestWidth.current || computeWidth(ev.clientX));
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
    };

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  };

  // 键盘可达性：聚焦后左右方向键微调
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = e.shiftKey ? 40 : 10;
    const delta = e.key === 'ArrowLeft' ? step : -step;
    const el = e.currentTarget as HTMLElement;
    const current = computeWidth(el.getBoundingClientRect().left);
    onResize(current + (side === 'right' ? delta : -delta));
    onResizeEnd?.(current + (side === 'right' ? delta : -delta));
  };

  return (
    <div
      className={`splitter${active ? ' splitter--active' : ''}`}
      onPointerDown={handlePointerDown}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
      role="separator"
      aria-orientation="vertical"
      tabIndex={0}
      title={title}
    >
      <span className="splitter__line" />
    </div>
  );
}

function readStored(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
