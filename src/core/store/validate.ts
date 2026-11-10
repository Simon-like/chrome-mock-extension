/**
 * 规则校验
 *
 * 两类输出：
 *   - error：会导致规则不工作，UI 应阻止保存
 *   - warning：可能有问题但不确定，UI 提示但允许保存
 *
 * 为什么正则的 ReDoS 检测是 warning 而不是 error：
 * 静态检测有误报可能，用户写的可能是合法且安全的复杂正则。
 * 阻止保存太粗暴，提示 + 运行时耗时预算（matcher.ts）是更稳的组合。
 */

import type { MatchCondition, ResponseSpec, Rule, RuleDraft } from '../types.js';

export interface ValidationIssue {
  level: 'error' | 'warning';
  field: string;
  message: string;
}

export function validateRule(rule: Rule | RuleDraft): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!rule.name?.trim()) {
    issues.push({ level: 'error', field: 'name', message: '规则名不能为空' });
  }

  issues.push(...validateMatch(rule.match));

  // 变体不能为空 —— 没有变体的规则没有任何响应可返回
  if (!rule.variants || rule.variants.length === 0) {
    issues.push({ level: 'error', field: 'variants', message: '至少需要一个变体' });
  } else {
    rule.variants.forEach((v, i) => {
      const prefix = rule.variants.length > 1 ? `变体「${v.name}」：` : '';
      for (const issue of validateResponse(v.response)) {
        issues.push({ ...issue, field: `variants[${i}].${issue.field}`, message: prefix + issue.message });
      }
    });

    const names = rule.variants.map((v) => v.name.trim());
    if (new Set(names).size !== names.length) {
      issues.push({ level: 'warning', field: 'variants', message: '存在同名变体，切换时不易分辨' });
    }
  }

  return issues;
}

function validateMatch(m: MatchCondition): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!m.url?.trim()) {
    issues.push({
      level: 'error',
      field: 'match.url',
      message: '匹配条件不能为空（空条件不会匹配任何请求）',
    });
    return issues;
  }

  if (m.urlMode === 'regex') {
    try {
      new RegExp(m.url);
    } catch (e) {
      issues.push({
        level: 'error',
        field: 'match.url',
        message: `正则语法错误：${(e as Error).message}`,
      });
      return issues;
    }
    if (hasRedosRisk(m.url)) {
      issues.push({
        level: 'warning',
        field: 'match.url',
        message: '正则中存在嵌套量词，可能导致灾难性回溯（页面卡死）。建议简化',
      });
    }
  }

  // 过于宽泛的匹配会拦下全站请求，这是新手最容易踩的坑
  if (m.urlMode === 'contains' && m.url.trim().length <= 2) {
    issues.push({
      level: 'warning',
      field: 'match.url',
      message: '匹配串过短，可能会命中大量无关请求',
    });
  }
  if (m.urlMode === 'wildcard' && /^\**$/.test(m.url.trim())) {
    issues.push({
      level: 'warning',
      field: 'match.url',
      message: '该通配符会匹配所有请求',
    });
  }

  return issues;
}

function validateResponse(r: ResponseSpec): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!Number.isFinite(r.status) || r.status < 100 || r.status > 599) {
    issues.push({
      level: 'error',
      field: 'status',
      message: 'HTTP 状态码需在 100–599 之间',
    });
  }

  if (r.bodyType === 'static' && r.body) {
    // 只在明显是 JSON 意图时才校验（以 { 或 [ 开头）
    const trimmed = r.body.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        JSON.parse(trimmed);
      } catch (e) {
        issues.push({
          level: 'error',
          field: 'body',
          message: `JSON 格式错误：${(e as Error).message}`,
        });
      }
    }
  }

  /**
   * Mock 模板本身就是 JSON，可以直接验 —— 模板写错是最常见的失误，
   * 而且验起来零成本（不像 dynamic 那样需要求值）。
   */
  if (r.bodyType === 'mockjs') {
    const src = (r.body ?? '').trim();
    if (!src) {
      issues.push({ level: 'error', field: 'body', message: 'Mock 模板不能为空' });
    } else {
      try {
        JSON.parse(src);
      } catch (e) {
        issues.push({
          level: 'error',
          field: 'body',
          message: `Mock 模板不是合法 JSON：${(e as Error).message}`,
        });
      }
    }
  }

  /**
   * 动态响应只做**不需要求值**的检查。
   *
   * 语法错误交给编辑器的语法树（core 里没有解析器，而且 validate 也跑在 SW，
   * 那边同样禁 eval）。这里只拦「一看就不会返回数据」这类低级失误 ——
   * 拦不住的部分由运行时熔断兜底，请求面板会标红。
   */
  if (r.bodyType === 'dynamic') {
    const src = (r.body ?? '').trim();
    if (!src) {
      issues.push({
        level: 'error',
        field: 'body',
        message: '动态响应的代码不能为空',
      });
    } else if (!/\breturn\b/.test(src) && !src.includes('=>')) {
      issues.push({
        level: 'warning',
        field: 'body',
        message: '代码里没有 return 也没有箭头函数，多半不会返回任何数据',
      });
    }
  }

  if (r.delayMs < 0) {
    issues.push({ level: 'error', field: 'delayMs', message: '延迟不能为负' });
  }
  if (r.delayMs > 60_000) {
    issues.push({
      level: 'warning',
      field: 'delayMs',
      message: '延迟超过 60 秒，确认不是误填？',
    });
  }

  return issues;
}

/**
 * ReDoS 静态检测（启发式，会有误报）
 *
 * 检测嵌套量词：(a+)+  (a*)*  (a+)*  等形态。
 * 这类结构在匹配失败时会引发指数级回溯。
 */
export function hasRedosRisk(pattern: string): boolean {
  // 分组内以量词结尾，且分组本身又被量词修饰
  return /\([^)]*[+*][^)]*\)\s*[+*]/.test(pattern);
}

/** 找出被前面规则遮蔽的规则（先到先得策略的唯一坑，UI 要提示） */
export function findShadowedRules(rules: Rule[]): Map<string, string> {
  const shadowed = new Map<string, string>();
  for (let i = 0; i < rules.length; i++) {
    const later = rules[i];
    if (!later || !later.enabled) continue;
    for (let j = 0; j < i; j++) {
      const earlier = rules[j];
      if (!earlier || !earlier.enabled) continue;
      if (isSubsumedBy(later, earlier)) {
        shadowed.set(later.id, earlier.id);
        break;
      }
    }
  }
  return shadowed;
}

/**
 * later 是否被 earlier 完全遮蔽。
 * 只做保守判断（同模式、同 method 集、earlier 的 url 是 later 的子串），
 * 宁可漏报也不误报 —— 误报的提示会让用户困惑。
 */
function isSubsumedBy(later: Rule, earlier: Rule): boolean {
  const a = earlier.match;
  const b = later.match;
  if (a.urlMode !== 'contains' || b.urlMode !== 'contains') return false;
  if (!b.url.includes(a.url)) return false;
  if (a.methods.length === 0) return true;
  if (b.methods.length === 0) return false;
  return b.methods.every((m) => a.methods.includes(m));
}
