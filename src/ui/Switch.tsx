/**
 * 开关（Switch）—— 表达「状态」，不是「选择」
 *
 * 为什么不用 checkbox：
 *   列表界面里 checkbox 的通用语义是「这一行被我选中了」。
 *   规则的启用/停用是行自身的状态，跟选中无关。两者都用 checkbox 的话，
 *   一进批量模式一行就出现两个方框，用户分不清点的是哪个（还得靠 disabled 一个来避免误点）。
 *
 *   把状态换成开关后，两种控件形态完全不同：
 *     ☑ 方框 = 我选了它     ●— 滑块 = 它开着
 *   于是同一行里可以并存，批量模式下启用开关也不必再禁用。
 *
 * 三态：分组头的「启用组内全部」会出现「部分启用」，滑块停在中间。
 * 原生 checkbox 的 indeterminate 只能用 JS 设，这里就是个普通 button，反而更直白。
 */

interface Props {
  /** 'partial' 表示部分开启（滑块居中） */
  checked: boolean | 'partial';
  onChange: (next: boolean) => void;
  disabled?: boolean;
  title?: string;
  /** 无可见文字标签时给读屏用 */
  label?: string;
  /** sm 用于密度更高的场合（popup 列表） */
  size?: 'md' | 'sm';
  /** 阻止事件冒泡到行上（行本身有点击/双击行为） */
  stopPropagation?: boolean;
}

export function Switch({
  checked,
  onChange,
  disabled,
  title,
  label,
  size = 'md',
  stopPropagation = true,
}: Props) {
  const partial = checked === 'partial';
  const on = checked === true;

  const cls = ['switch', size === 'sm' && 'switch--sm', on && 'is-on', partial && 'is-partial']
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      role="switch"
      // 部分启用时点一下应该是「全开」，所以对外报 false
      aria-checked={on}
      aria-label={label}
      className={cls}
      disabled={disabled}
      title={title}
      onClick={(e) => {
        if (stopPropagation) e.stopPropagation();
        onChange(!on);
      }}
    >
      <span className="switch__knob" />
    </button>
  );
}
