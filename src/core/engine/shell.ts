/**
 * 响应外壳套用（F24）
 *
 * 用户的公司响应格式不统一：多数是 {status, message, data}，
 * 但经风控等中间层后会变。所以是「模板库 + 规则级选择」，不是全局配置。
 * 详见需求文档 02 §1.5。
 */

import type { ShellTemplate } from '../types.js';

export const DATA_PLACEHOLDER = '__DATA__';

/**
 * 把 body 塞进外壳模板的 __DATA__ 位置。
 *
 * 注意这里是【字符串替换】而不是对象合并 —— 因为 body 存的就是字符串，
 * 走 JSON.parse 再 stringify 会丢精度（大整数）也会丢格式。
 */
export function applyShell(template: string, body: string): string {
  if (!template.includes(DATA_PLACEHOLDER)) {
    // 模板里没有占位符，说明是个固定响应，直接返回模板本身
    return template;
  }
  return template.split(DATA_PLACEHOLDER).join(body);
}

export function findShellTemplate(
  templates: ShellTemplate[],
  id: string | null,
): ShellTemplate | null {
  if (!id) return null;
  return templates.find((t) => t.id === id) ?? null;
}

/**
 * 从一段真实响应里反推它用的是哪个外壳（F25 的基础）。
 *
 * 思路：把模板的 __DATA__ 换成宽松的捕获组，用生成的正则去匹配真实响应。
 * 匹配上就说明用的是这个壳，捕获组的内容就是 data 部分。
 *
 * MVP 不启用，先把能力放在这里，V1 的 Capture-to-Mock 会用到。
 */
export function detectShell(
  templates: ShellTemplate[],
  responseBody: string,
): { template: ShellTemplate; data: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const obj = parsed as Record<string, unknown>;

  for (const t of templates) {
    if (!t.template.includes(DATA_PLACEHOLDER)) continue;

    let shape: unknown;
    try {
      // 用 null 占位，得到外壳的结构
      shape = JSON.parse(applyShell(t.template, 'null'));
    } catch {
      continue;
    }

    // 裸数据模板（template 就是 __DATA__）解析出来是 null，不是对象 ——
    // 它没有「外壳」可识别，跳过。不加这个判断 Object.keys(null) 会抛异常。
    if (!shape || typeof shape !== 'object' || Array.isArray(shape)) continue;

    const shellShape = shape as Record<string, unknown>;
    const shellKeys = Object.keys(shellShape);
    const dataKey = shellKeys.find((k) => shellShape[k] === null);
    if (!dataKey) continue;

    // 键集合一致 + data 位置存在，就认为命中
    const objKeys = Object.keys(obj);
    const sameShape =
      shellKeys.length === objKeys.length &&
      shellKeys.every((k) => k in obj);

    if (sameShape && dataKey in obj) {
      return { template: t, data: JSON.stringify(obj[dataKey], null, 2) };
    }
  }
  return null;
}
