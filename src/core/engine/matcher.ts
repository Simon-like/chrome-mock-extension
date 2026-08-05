/**
 * 规则匹配器 —— 引擎心脏之一
 *
 * ⚠️ 这个模块跑在【用户的每一个请求】上。
 * 任何异常或卡顿都会直接毁掉整个页面，健壮性要求比 UI 代码高一个数量级。
 * 三条铁律：
 *   1. 永远不抛异常（内部全部 try/catch，失败返回「不匹配」）
 *   2. 永远不阻塞（正则有耗时预算）
 *   3. 纯函数，零副作用
 *
 * 详见设计文档 05 §5.1、§5.2。
 */

import type {
  MatchCondition,
  MockStore,
  RequestInfo,
  Rule,
} from '../types.js';

/** 单次正则匹配的耗时预算（毫秒）。超过则判定该正则有 ReDoS 风险 */
const REGEX_TIME_BUDGET_MS = 50;

/**
 * 正则可测试的 URL 最大长度。
 *
 * 灾难性回溯的耗时随输入长度指数增长。截断输入是唯一能【事前】封顶的手段
 * （JS 没有正则超时机制）。2048 对正常 URL 完全够用（浏览器地址栏上限也在这个量级）。
 */
const REGEX_MAX_INPUT_LENGTH = 2048;

/** 被判定为危险的正则，加入黑名单不再执行 */
const bannedPatterns = new Set<string>();

/**
 * ReDoS 静态风险检测：分组内含量词，且该分组本身又被量词修饰。
 * 形如 (a+)+ (a*)* (\d+)* —— 匹配失败时会指数级回溯。
 *
 * 与 store/validate.ts 里的同名逻辑保持一致，但这里是【引擎侧的强制拦截】，
 * validate 那边只是给 UI 的提示。两处都要有：
 *   - validate：保存规则时警告用户
 *   - 这里：即使用户忽略警告存下了，引擎也不会执行它
 */
function hasNestedQuantifier(pattern: string): boolean {
  return /\([^)]*[+*][^)]*\)\s*[+*]/.test(pattern);
}

export interface MatchResult {
  rule: Rule;
  /** 在 rules 数组中的下标，UI 用来提示「被上面的规则遮蔽」 */
  index: number;
}

/**
 * 找出命中的规则。
 *
 * 策略是【先到先得】：从上往下遍历，第一条匹配的生效。
 * 不用「最长匹配优先」或优先级字段，因为列表顺序即匹配顺序，
 * 所见即所得，用户可预测、可通过拖拽控制。详见设计文档 05 §5.1。
 */
export function findMatchingRule(
  store: MockStore,
  req: RequestInfo,
): MatchResult | null {
  if (!store.enabled) return null;

  const groupEnabled = buildGroupEnabledMap(store);

  for (let i = 0; i < store.rules.length; i++) {
    const rule = store.rules[i];
    if (!rule) continue;
    if (!rule.enabled) continue;
    if (rule.groupId && groupEnabled.get(rule.groupId) === false) continue;
    if (!matchRule(rule, req)) continue;
    return { rule, index: i };
  }
  return null;
}

/** 单条规则是否匹配 —— 导出供 UI 做「这条规则会命中哪些历史请求」的预览 */
export function matchRule(rule: Rule, req: RequestInfo): boolean {
  const m = rule.match;
  return matchHost(m.hosts, req.host) && matchMethod(m, req) && matchUrl(m, req.url);
}

function buildGroupEnabledMap(store: MockStore): Map<string, boolean> {
  const map = new Map<string, boolean>();
  for (const g of store.groups) map.set(g.id, g.enabled);
  return map;
}

/** 空数组 = 不限制 */
export function matchHost(hosts: string[], host: string): boolean {
  if (hosts.length === 0) return true;
  return hosts.some((h) => h === host || host.endsWith('.' + h));
}

function matchMethod(m: MatchCondition, req: RequestInfo): boolean {
  if (m.methods.length === 0) return true;
  return m.methods.includes(req.method);
}

export function matchUrl(m: MatchCondition, url: string): boolean {
  if (!m.url) return false; // 空匹配条件视为不匹配，避免误伤全站

  switch (m.urlMode) {
    case 'contains':
      return url.includes(m.url);
    case 'wildcard':
      return testWildcard(m.url, url);
    case 'regex':
      return testRegExp(m.url, url);
    default:
      return false;
  }
}

// ───────────────────────────────────────────────────────────
// 通配符
// ───────────────────────────────────────────────────────────

const wildcardCache = new Map<string, RegExp | null>();

/**
 * 通配符转正则。* 匹配任意字符（含 /），因为用户写 /api/*\/list 时
 * 通常期望跨路径段匹配。
 */
export function testWildcard(pattern: string, url: string): boolean {
  let re = wildcardCache.get(pattern);
  if (re === undefined) {
    re = compileWildcard(pattern);
    wildcardCache.set(pattern, re);
  }
  if (re === null) return false;
  try {
    return re.test(url);
  } catch {
    return false;
  }
}

function compileWildcard(pattern: string): RegExp | null {
  try {
    // 先整体转义，再把转义后的 \* 换回 .*
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const body = escaped.replace(/\\\*/g, '.*');
    return new RegExp(body);
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────
// 正则
// ───────────────────────────────────────────────────────────

const regexCache = new Map<string, RegExp | null>();

/**
 * 安全的正则测试。
 *
 * 两个必须处理的风险：
 *   1. 非法正则会抛异常 —— 不 catch 的话整个 hook 崩溃，页面所有请求全挂
 *   2. 灾难性回溯（ReDoS）—— 像 (a+)+$ 这种遇到特定输入会指数级耗时，卡死页面
 *
 * 对风险 2 用三道防线，缺一不可：
 *
 *   防线一（事前拦截）：静态检测嵌套量词，命中直接拒绝执行。
 *     这是唯一能防住【第一次】的手段。实测 (a+)+$ 匹配 30 个 a 要 42 秒 ——
 *     纯靠事后测耗时的话，用户页面已经卡死了。
 *
 *   防线二（输入封顶）：截断超长 URL。
 *     回溯耗时随输入长度指数增长，封顶输入等于封顶最坏耗时。
 *
 *   防线三（事后兜底）：测量耗时，超预算永久拉黑。
 *     兜住启发式漏掉的模式（比如交替分支型 (a|a)*）。
 */
export function testRegExp(pattern: string, url: string): boolean {
  if (bannedPatterns.has(pattern)) return false;

  // 防线一：静态风险模式，直接拒绝执行并拉黑
  if (hasNestedQuantifier(pattern)) {
    bannedPatterns.add(pattern);
    return false;
  }

  let re = regexCache.get(pattern);
  if (re === undefined) {
    re = compileRegExp(pattern);
    regexCache.set(pattern, re);
  }
  if (re === null) return false;

  // 防线二：截断输入
  const input =
    url.length > REGEX_MAX_INPUT_LENGTH ? url.slice(0, REGEX_MAX_INPUT_LENGTH) : url;

  // 防线三：耗时兜底
  const start = now();
  try {
    const result = re.test(input);
    if (now() - start > REGEX_TIME_BUDGET_MS) {
      bannedPatterns.add(pattern);
    }
    return result;
  } catch {
    return false;
  }
}

function compileRegExp(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/** 被拉黑的正则列表 —— UI 用来提示用户 */
export function getBannedPatterns(): string[] {
  return [...bannedPatterns];
}

export function clearBannedPatterns(): void {
  bannedPatterns.clear();
}

/** core 不能依赖 performance（Node 环境测试时可能没有），做个降级 */
function now(): number {
  return typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now();
}

/** 规则变更后清缓存，避免用旧的编译结果 */
export function clearMatcherCache(): void {
  wildcardCache.clear();
  regexCache.clear();
}
