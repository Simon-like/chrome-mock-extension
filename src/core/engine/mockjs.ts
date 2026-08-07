/**
 * Mock 模板展开 —— 一行模板造一批「看起来像真的」的数据
 *
 * ```
 * { "list|10": [{ "id|+1": 1001, "name": "@cname", "price|10-999.2": 1 }] }
 * ```
 *
 * ── 为什么自己写，不引 Mock.js ────────────────────────
 *
 * 1. **体积**。这段代码要打进注入脚本，而注入脚本在用户访问的
 *    **每一个页面**上加载。实测本模块给 `public/inject.js` 增加约
 *    6KB（gzip），引 Mock.js 则是约 20KB（gzip）—— 差三倍多。
 *    整个注入脚本现在 gzip 10.8KB，还不到 Mock.js 一个库的一半。
 *    （按需加载这条路走不通：`xhr.send()` 是同步的，等不了 `import()`）
 * 2. **不需要 eval**。Mock.js 的模板是纯数据结构，展开是遍历 + 字符串替换。
 *    于是它在 CSP 禁了 `unsafe-eval` 的站点上照样能用 ——
 *    正好补上动态响应（`dynamic.ts`）的短板，两者是互补而不是重复。
 * 3. **core 层合规**。零依赖、零 chrome/DOM，可测、将来 MCP Server 能直接复用。
 *
 * 代价是只支持一个**子集**。支持范围见 docs/11-Mock模板语法.md，
 * 与 Mock.js 的差异也记在那里 —— 不装作完全兼容，比装了之后处处踩坑强。
 */

// ═══════════════════════════════════════════════════════════
// 随机源（可注入，测试才能断言具体值）
// ═══════════════════════════════════════════════════════════

export interface Random {
  /** [0, 1) */
  next(): number;
}

/** 默认随机源 */
export const systemRandom: Random = { next: () => Math.random() };

/**
 * 可复现的伪随机（mulberry32）。
 * 测试用它断言具体输出；将来若要做「同一请求每次返回同样数据」也是它。
 */
export function seededRandom(seed: number): Random {
  let a = seed >>> 0;
  return {
    next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

// ═══════════════════════════════════════════════════════════
// 防炸护栏
// ═══════════════════════════════════════════════════════════

/**
 * 单个数组最多生成多少项。
 * `"list|999999"` 是手滑就能打出来的，没上限的话直接把页面内存吃干净。
 */
export const MAX_REPEAT = 1000;
/** 整个模板最多产出多少个节点，防深层嵌套相乘炸开（10 × 10 × 10 × …） */
export const MAX_NODES = 50_000;

export class TemplateLimitError extends Error {}

// ═══════════════════════════════════════════════════════════
// 入口
// ═══════════════════════════════════════════════════════════

export interface ExpandOptions {
  random?: Random;
  /** @increment 的起始值 */
  incrementStart?: number;
}

export type ExpandResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/**
 * 展开一份模板。
 *
 * 永不抛异常 —— 引擎跑在用户的每一个请求上（09 §6.5）。
 */
export function expandTemplate(template: unknown, opts: ExpandOptions = {}): ExpandResult {
  const ctx: Ctx = {
    random: opts.random ?? systemRandom,
    increment: opts.incrementStart ?? 1,
    nodes: 0,
    steps: new Map(),
  };
  try {
    return { ok: true, value: expand(template, ctx) };
  } catch (e) {
    if (e instanceof TemplateLimitError) return { ok: false, error: e.message };
    return { ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}

/** 从 JSON 字符串展开，顺带把「模板本身不是合法 JSON」这个最常见的错误说清楚 */
export function expandTemplateJson(source: string, opts: ExpandOptions = {}): ExpandResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (e) {
    return { ok: false, error: `模板不是合法 JSON：${(e as Error).message}` };
  }
  return expandTemplate(parsed, opts);
}

interface Ctx {
  random: Random;
  /** @increment 的计数器 */
  increment: number;
  nodes: number;
  /**
   * `|+n` 的计数器，**按键名分开存**。
   * 共用一个的话，`{"id|+1": 1, "seq|+10": 100}` 两个字段会互相串号。
   */
  steps: Map<string, number>;
}

function countNode(ctx: Ctx): void {
  if (++ctx.nodes > MAX_NODES) {
    throw new TemplateLimitError(
      `模板展开后节点数超过 ${MAX_NODES} —— 多半是多层 |n 相乘导致的，请调小数量`,
    );
  }
}

// ═══════════════════════════════════════════════════════════
// 展开
// ═══════════════════════════════════════════════════════════

function expand(value: unknown, ctx: Ctx): unknown {
  countNode(ctx);

  if (typeof value === 'string') return expandString(value, ctx);
  if (Array.isArray(value)) return value.map((v) => expand(v, ctx));
  if (value && typeof value === 'object') return expandObject(value as Record<string, unknown>, ctx);
  return value;
}

function expandObject(obj: Record<string, unknown>, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [rawKey, rawValue] of Object.entries(obj)) {
    const { name, rule } = parseKey(rawKey);

    if (!rule) {
      out[name] = expand(rawValue, ctx);
      continue;
    }

    out[name] = applyRule(name, rule, rawValue, ctx);
  }

  return out;
}

// ── key 上的规则 ───────────────────────────────────────────

export interface KeyRule {
  /** `|3` → count=3；`|1-5` → min=1,max=5 */
  min: number;
  max: number;
  /** `|+2` 的步长 */
  step?: number;
  /** `|1-10.2-4` 里小数位的范围 */
  dmin?: number;
  dmax?: number;
  /** 规则里写没写小数部分 —— 决定生成整数还是浮点 */
  hasDecimal: boolean;
}

/** `'list|1-5'` → `{ name: 'list', rule: {...} }`；没有 `|` 就 rule 为 null */
export function parseKey(key: string): { name: string; rule: KeyRule | null } {
  const at = key.lastIndexOf('|');
  if (at < 0) return { name: key, rule: null };

  const name = key.slice(0, at);
  const spec = key.slice(at + 1).trim();

  // |+step
  const inc = /^\+(\d+)$/.exec(spec);
  if (inc) {
    const step = Number(inc[1]);
    return { name, rule: { min: 0, max: 0, step, hasDecimal: false } };
  }

  // |min-max.dmin-dmax  /  |min-max.d  /  |count.d  /  |count
  const m = /^(\d+)(?:-(\d+))?(?:\.(\d+)(?:-(\d+))?)?$/.exec(spec);
  if (!m) return { name: key, rule: null }; // 认不出来的规则原样当作键名，不猜

  const min = Number(m[1]);
  const max = m[2] === undefined ? min : Number(m[2]);
  const hasDecimal = m[3] !== undefined;
  const dmin = hasDecimal ? Number(m[3]) : undefined;
  const dmax = m[4] === undefined ? dmin : Number(m[4]);

  return { name, rule: { min, max, step: undefined, dmin, dmax, hasDecimal } };
}

function applyRule(name: string, rule: KeyRule, value: unknown, ctx: Ctx): unknown {
  // |+step：递增。只对数字有意义，且只有在数组里逐项展开时才看得出效果
  //（第一项用模板里写的初值，之后依次加 step）
  if (rule.step !== undefined) {
    if (typeof value !== 'number') return expand(value, ctx);
    const cur = ctx.steps.get(name) ?? value;
    ctx.steps.set(name, cur + rule.step);
    return cur;
  }

  const count = randInt(ctx, rule.min, rule.max);

  if (Array.isArray(value)) {
    if (count > MAX_REPEAT) {
      throw new TemplateLimitError(`单个数组最多生成 ${MAX_REPEAT} 项，当前要 ${count} 项`);
    }
    const out: unknown[] = [];
    for (let i = 0; i < count; i++) {
      // 每一轮都重新展开模板，@increment / 随机值才会逐项不同
      for (const item of value) out.push(expand(item, ctx));
    }
    return out;
  }

  if (typeof value === 'string') {
    if (count * value.length > MAX_REPEAT * 16) {
      throw new TemplateLimitError('字符串重复后过长');
    }
    // 占位符可能返回非字符串（如 "@natural"），重复时统一按字符串处理
    return String(expandString(value, ctx) ?? '').repeat(count);
  }

  if (typeof value === 'number') {
    if (rule.hasDecimal) {
      const digits = randInt(ctx, rule.dmin ?? 1, rule.dmax ?? rule.dmin ?? 1);
      const n = rule.min + ctx.random.next() * (rule.max - rule.min);
      return Number(n.toFixed(digits));
    }
    return count;
  }

  if (typeof value === 'boolean') {
    // |1 → 随机真假。Mock.js 的 |1 是「有 1/2 概率取反」，这里直接给随机布尔，
    // 结果分布一样，但解释起来简单得多
    return ctx.random.next() < 0.5;
  }

  if (value && typeof value === 'object') {
    // |n → 从对象里随机取 n 个键
    const keys = Object.keys(value as object);
    const picked = shuffle(keys, ctx).slice(0, Math.min(count, keys.length));
    const out: Record<string, unknown> = {};
    for (const k of picked) {
      const { name } = parseKey(k);
      out[name] = expand((value as Record<string, unknown>)[k], ctx);
    }
    return out;
  }

  return expand(value, ctx);
}

// ═══════════════════════════════════════════════════════════
// 字符串里的 @占位符
// ═══════════════════════════════════════════════════════════

/**
 * `"@cname"` → 单独一个占位符时返回**原始类型**（数字就是数字，不被套成字符串）；
 * `"编号 @id"` → 混在文本里时做字符串替换。
 *
 * 这个区分很重要：`{"id": "@natural"}` 应该得到 `{"id": 42}` 而不是 `{"id": "42"}`，
 * 否则前端 `typeof res.id === 'number'` 的判断会挂。
 */
const PLACEHOLDER = /@([a-zA-Z_]\w*)(\(([^()]*)\))?/g;

function expandString(str: string, ctx: Ctx): unknown {
  if (!str.includes('@')) return str;

  // 整串就是一个占位符 → 保留原始类型
  const whole = new RegExp(`^${PLACEHOLDER.source}$`).exec(str);
  if (whole) {
    const v = invoke(whole[1]!, parseArgs(whole[3]), ctx);
    if (v !== undefined) return v;
  }

  return str.replace(PLACEHOLDER, (raw, name: string, _p, args?: string) => {
    const v = invoke(name, parseArgs(args), ctx);
    // 认不出的占位符原样保留 —— 用户可能只是想写个 @ 符号
    return v === undefined ? raw : String(v);
  });
}

/** `"1, 2, 'a b'"` → `[1, 2, 'a b']` */
function parseArgs(raw?: string): (string | number)[] {
  if (!raw || !raw.trim()) return [];
  return raw.split(',').map((s) => {
    const t = s.trim().replace(/^['"]|['"]$/g, '');
    const n = Number(t);
    return t !== '' && Number.isFinite(n) ? n : t;
  });
}

function invoke(name: string, args: (string | number)[], ctx: Ctx): unknown {
  const fn = PLACEHOLDERS[name.toLowerCase()];
  return fn ? fn(ctx, args) : undefined;
}

// ═══════════════════════════════════════════════════════════
// 数据池
// ═══════════════════════════════════════════════════════════

const CN_SURNAME = '王李张刘陈杨黄赵吴周徐孙马朱胡林郭何高罗郑梁谢宋唐许韩冯邓曹彭曾'.split('');
const CN_GIVEN = '伟芳娜秀英敏静丽强磊洋艳勇军杰娟涛明超秀霞平刚桂英文辉建华丹晨浩宇思远'.split('');
const CN_WORD = [
  '数据', '系统', '服务', '订单', '商品', '用户', '支付', '优惠', '活动', '配送',
  '库存', '评价', '售后', '账户', '积分', '会员', '结算', '发票', '物流', '退款',
];
const CN_CITY = ['北京', '上海', '广州', '深圳', '杭州', '成都', '南京', '武汉', '西安', '苏州'];
const CN_PROVINCE = ['广东', '江苏', '浙江', '山东', '河南', '四川', '湖北', '福建', '湖南', '陕西'];

const EN_FIRST = ['James', 'Mary', 'John', 'Patricia', 'Robert', 'Jennifer', 'Michael', 'Linda'];
const EN_LAST = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis'];
const EN_WORD = [
  'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit',
  'sed', 'eiusmod', 'tempor', 'incididunt', 'labore', 'magna', 'aliqua',
];

const DOMAIN_TLD = ['com', 'cn', 'net', 'org', 'io'];
const HEX = '0123456789abcdef';

// ═══════════════════════════════════════════════════════════
// 占位符实现
// ═══════════════════════════════════════════════════════════

type Placeholder = (ctx: Ctx, args: (string | number)[]) => unknown;

const PLACEHOLDERS: Record<string, Placeholder> = {
  // ── 数字 ──
  natural: (c, a) => randInt(c, num(a[0], 0), num(a[1], 9999999)),
  integer: (c, a) => randInt(c, num(a[0], -9999), num(a[1], 9999)),
  float: (c, a) => {
    const min = num(a[0], 0);
    const max = num(a[1], 9999);
    const digits = randInt(c, num(a[2], 1), num(a[3], num(a[2], 4)));
    return Number((min + c.random.next() * (max - min)).toFixed(digits));
  },
  id: (c) => randInt(c, 100000, 999999),
  increment: (c, a) => {
    const step = num(a[0], 1);
    const cur = c.increment;
    c.increment += step;
    return cur;
  },
  guid: (c) =>
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
      const r = Math.floor(c.random.next() * 16);
      return HEX[ch === 'x' ? r : (r & 0x3) | 0x8]!;
    }),

  // ── 布尔 / 字符串 ──
  boolean: (c) => c.random.next() < 0.5,
  string: (c, a) => {
    const len = randInt(c, num(a[0], 3), num(a[1], num(a[0], 10)));
    const pool = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let s = '';
    for (let i = 0; i < len; i++) s += pool[Math.floor(c.random.next() * pool.length)];
    return s;
  },
  color: (c) => {
    let s = '#';
    for (let i = 0; i < 6; i++) s += HEX[Math.floor(c.random.next() * 16)];
    return s;
  },

  // ── 中文 ──
  cfirst: (c) => pick(c, CN_SURNAME),
  // 名字六成是双字 —— 全是单字的话一眼就看出是编的
  clast: (c) => pick(c, CN_GIVEN) + (c.random.next() < 0.6 ? pick(c, CN_GIVEN) : ''),
  cname: (c) => pick(c, CN_SURNAME) + PLACEHOLDERS.clast!(c, []),
  cword: (c, a) => {
    const n = randInt(c, num(a[0], 1), num(a[1], num(a[0], 1)));
    return Array.from({ length: n }, () => pick(c, CN_WORD)).join('');
  },
  ctitle: (c, a) => {
    const n = randInt(c, num(a[0], 2), num(a[1], num(a[0], 4)));
    return Array.from({ length: n }, () => pick(c, CN_WORD)).join('');
  },
  csentence: (c, a) => {
    const n = randInt(c, num(a[0], 3), num(a[1], num(a[0], 8)));
    return Array.from({ length: n }, () => pick(c, CN_WORD)).join('') + '。';
  },
  cparagraph: (c, a) => {
    const n = randInt(c, num(a[0], 2), num(a[1], num(a[0], 4)));
    return Array.from({ length: n }, () =>
      PLACEHOLDERS.csentence!(c, []),
    ).join('');
  },
  city: (c) => pick(c, CN_CITY),
  province: (c) => pick(c, CN_PROVINCE),

  // ── 英文 ──
  first: (c) => pick(c, EN_FIRST),
  last: (c) => pick(c, EN_LAST),
  name: (c) => `${pick(c, EN_FIRST)} ${pick(c, EN_LAST)}`,
  word: (c) => pick(c, EN_WORD),
  title: (c, a) => {
    const n = randInt(c, num(a[0], 2), num(a[1], num(a[0], 5)));
    return Array.from({ length: n }, () => capitalize(pick(c, EN_WORD))).join(' ');
  },
  sentence: (c, a) => {
    const n = randInt(c, num(a[0], 6), num(a[1], num(a[0], 12)));
    const words = Array.from({ length: n }, () => pick(c, EN_WORD));
    return capitalize(words.join(' ')) + '.';
  },
  paragraph: (c, a) => {
    const n = randInt(c, num(a[0], 2), num(a[1], num(a[0], 4)));
    return Array.from({ length: n }, () => PLACEHOLDERS.sentence!(c, [])).join(' ');
  },

  // ── 联系方式 ──
  domain: (c) => `${pick(c, EN_WORD)}.${pick(c, DOMAIN_TLD)}`,
  url: (c) => `https://${pick(c, EN_WORD)}.${pick(c, DOMAIN_TLD)}/${pick(c, EN_WORD)}`,
  email: (c) => `${pick(c, EN_WORD)}${randInt(c, 1, 999)}@${pick(c, EN_WORD)}.${pick(c, DOMAIN_TLD)}`,
  ip: (c) => Array.from({ length: 4 }, () => randInt(c, 1, 254)).join('.'),
  phone: (c) => `1${pick(c, ['3', '5', '7', '8', '9'])}${String(randInt(c, 0, 999999999)).padStart(9, '0')}`,

  // ── 时间 ──
  // 注意：不引日期库，只支持最常用的几种格式
  now: (_c, a) => formatDate(new Date(), String(a[0] ?? 'yyyy-MM-dd HH:mm:ss')),
  timestamp: (c) => Date.now() - randInt(c, 0, 86400 * 365) * 1000,
  date: (c, a) => formatDate(randomDate(c), String(a[0] ?? 'yyyy-MM-dd')),
  time: (c, a) => formatDate(randomDate(c), String(a[0] ?? 'HH:mm:ss')),
  datetime: (c, a) => formatDate(randomDate(c), String(a[0] ?? 'yyyy-MM-dd HH:mm:ss')),

  // ── 工具 ──
  pick: (c, a) => (a.length === 0 ? undefined : a[Math.floor(c.random.next() * a.length)]),
  range: (_c, a) => {
    const start = num(a[0], 0);
    const stop = a.length > 1 ? num(a[1], 0) : start;
    const step = num(a[2], 1) || 1;
    const from = a.length > 1 ? start : 0;
    const out: number[] = [];
    for (let i = from; step > 0 ? i < stop : i > stop; i += step) {
      if (out.length >= MAX_REPEAT) break;
      out.push(i);
    }
    return out;
  },
};

/** 供 UI 做补全提示用 */
export const PLACEHOLDER_NAMES: string[] = Object.keys(PLACEHOLDERS).sort();

// ═══════════════════════════════════════════════════════════
// 小工具
// ═══════════════════════════════════════════════════════════

function num(v: string | number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function randInt(ctx: Ctx, min: number, max: number): number {
  if (max < min) [min, max] = [max, min];
  return min + Math.floor(ctx.random.next() * (max - min + 1));
}

function pick<T>(ctx: Ctx, pool: readonly T[]): T {
  return pool[Math.floor(ctx.random.next() * pool.length)]!;
}

function shuffle<T>(arr: readonly T[], ctx: Ctx): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(ctx.random.next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** 近一年内的随机时刻 */
function randomDate(ctx: Ctx): Date {
  return new Date(Date.now() - Math.floor(ctx.random.next() * 365 * 86400 * 1000));
}

function formatDate(d: Date, fmt: string): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  return fmt
    .replace(/yyyy/g, String(d.getFullYear()))
    .replace(/MM/g, p2(d.getMonth() + 1))
    .replace(/dd/g, p2(d.getDate()))
    .replace(/HH/g, p2(d.getHours()))
    .replace(/mm/g, p2(d.getMinutes()))
    .replace(/ss/g, p2(d.getSeconds()));
}
