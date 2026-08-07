/**
 * Mock 模板展开的测试
 *
 * 随机性用 seededRandom 消掉 —— 断言「结构对不对」而不是「值等于多少」，
 * 只有在确实要验证分布/边界时才固定种子看具体值。
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_NODES,
  MAX_REPEAT,
  expandTemplate,
  expandTemplateJson,
  parseKey,
  seededRandom,
} from '../src/core/engine/mockjs.js';

/** 固定种子，结果可复现 */
const rnd = () => seededRandom(42);

function expand(tpl: unknown): any {
  const r = expandTemplate(tpl, { random: rnd() });
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

describe('parseKey', () => {
  it('没有 | 时整个都是键名', () => {
    expect(parseKey('name')).toEqual({ name: 'name', rule: null });
  });

  it('|n 解析成固定数量', () => {
    expect(parseKey('list|3').rule).toMatchObject({ min: 3, max: 3, hasDecimal: false });
  });

  it('|min-max 解析成范围', () => {
    expect(parseKey('list|1-5').rule).toMatchObject({ min: 1, max: 5 });
  });

  it('|+n 解析成步长', () => {
    expect(parseKey('id|+2').rule).toMatchObject({ step: 2 });
  });

  it('|min-max.dmin-dmax 解析出小数位', () => {
    expect(parseKey('price|10-99.1-3').rule).toMatchObject({
      min: 10, max: 99, dmin: 1, dmax: 3, hasDecimal: true,
    });
  });

  it('认不出的规则原样当键名，不猜 —— 键里带 | 的真实字段不该被吃掉', () => {
    expect(parseKey('a|b')).toEqual({ name: 'a|b', rule: null });
  });
});

describe('数量规则', () => {
  it('|n 让数组重复 n 次 —— 这就是「一行造 10 条」', () => {
    const out = expand({ 'list|10': [{ id: 1 }] });
    expect(out.list).toHaveLength(10);
    expect(out.list[0]).toEqual({ id: 1 });
  });

  it('展开后的键名不带规则后缀', () => {
    expect(Object.keys(expand({ 'list|2': [1] }))).toEqual(['list']);
  });

  it('|min-max 生成范围内的长度', () => {
    const n = expand({ 'list|2-5': [1] }).list.length;
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(5);
  });

  it('字符串 |n 重复 n 次', () => {
    expect(expand({ 'sep|3': 'ab' }).sep).toBe('ababab');
  });

  it('数字 |min-max 生成范围内整数', () => {
    const v = expand({ 'age|18-60': 1 }).age;
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(18);
    expect(v).toBeLessThanOrEqual(60);
  });

  it('数字 |min-max.d 生成指定小数位的浮点', () => {
    const v = expand({ 'price|10-99.2': 1 }).price;
    expect(v).toBeGreaterThanOrEqual(10);
    expect(v).toBeLessThan(100);
    expect(String(v).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(2);
  });

  it('对象 |n 随机取 n 个键', () => {
    const out = expand({ 'o|2': { a: 1, b: 2, c: 3 } });
    expect(Object.keys(out.o)).toHaveLength(2);
  });

  it('布尔 |1 得到布尔值', () => {
    expect(typeof expand({ 'ok|1': true }).ok).toBe('boolean');
  });
});

describe('|+n 递增', () => {
  it('数组里逐项递增，第一项用模板写的初值', () => {
    const out = expand({ 'list|3': [{ 'id|+1': 1001 }] });
    expect(out.list.map((x: any) => x.id)).toEqual([1001, 1002, 1003]);
  });

  it('步长可以不是 1', () => {
    const out = expand({ 'list|3': [{ 'id|+10': 0 }] });
    expect(out.list.map((x: any) => x.id)).toEqual([0, 10, 20]);
  });

  it('不同键各自计数，不会互相串号', () => {
    const out = expand({ 'list|3': [{ 'id|+1': 1, 'seq|+100': 100 }] });
    expect(out.list.map((x: any) => x.id)).toEqual([1, 2, 3]);
    expect(out.list.map((x: any) => x.seq)).toEqual([100, 200, 300]);
  });

  it('每次展开都从头开始 —— 两个请求不该拿到接着上次的号', () => {
    const tpl = { 'list|2': [{ 'id|+1': 1 }] };
    expect(expand(tpl).list.map((x: any) => x.id)).toEqual([1, 2]);
    expect(expand(tpl).list.map((x: any) => x.id)).toEqual([1, 2]);
  });
});

describe('@占位符', () => {
  it('整串就是一个占位符时保留原始类型 —— 不能把数字套成字符串', () => {
    const out = expand({ id: '@natural', ok: '@boolean' });
    expect(typeof out.id).toBe('number');
    expect(typeof out.ok).toBe('boolean');
  });

  it('混在文本里时做字符串替换', () => {
    const out = expand({ label: '编号 @natural(1,9) 号' });
    expect(out.label).toMatch(/^编号 \d 号$/);
  });

  it('@cname 生成 2~3 字的中文姓名', () => {
    expect(expand({ n: '@cname' }).n).toMatch(/^[一-龥]{2,3}$/);
  });

  it('@pick 从给定值里选一个', () => {
    const v = expand({ s: '@pick(待付款,已发货,已完成)' }).s;
    expect(['待付款', '已发货', '已完成']).toContain(v);
  });

  it('@range 生成数字数组', () => {
    expect(expand({ r: '@range(1,5)' }).r).toEqual([1, 2, 3, 4]);
  });

  it('@date 按默认格式输出', () => {
    expect(expand({ d: '@date' }).d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('@date 支持自定义格式', () => {
    expect(expand({ d: '@date(yyyy/MM/dd)' }).d).toMatch(/^\d{4}\/\d{2}\/\d{2}$/);
  });

  it('@increment 在整份模板里连续递增', () => {
    const out = expand({ 'list|3': [{ i: '@increment' }] });
    expect(out.list.map((x: any) => x.i)).toEqual([1, 2, 3]);
  });

  it('@guid 形如 UUID v4', () => {
    expect(expand({ g: '@guid' }).g).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('认不出的占位符原样保留 —— 用户可能只是想写个 @ 符号', () => {
    expect(expand({ s: '@不存在的东西 a@b.com' }).s).toContain('a@b.com');
  });

  it('@email / @url / @ip 形状正确', () => {
    const out = expand({ e: '@email', u: '@url', i: '@ip' });
    expect(out.e).toMatch(/^[\w.]+@[\w.]+$/);
    expect(out.u).toMatch(/^https:\/\//);
    expect(out.i).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });
});

describe('嵌套与原样透传', () => {
  it('嵌套对象里的模板也会展开', () => {
    const out = expand({ data: { 'list|2': [{ 'id|+1': 1 }] } });
    expect(out.data.list.map((x: any) => x.id)).toEqual([1, 2]);
  });

  it('没有规则也没有占位符时原样返回', () => {
    const tpl = { a: 1, b: 'x', c: null, d: [1, 2], e: { f: true } };
    expect(expand(tpl)).toEqual(tpl);
  });

  it('顶层数组也能展开', () => {
    expect(expand([{ n: '@natural(1,1)' }])).toEqual([{ n: 1 }]);
  });
});

describe('护栏', () => {
  it('单个数组超过上限时报错而不是把内存吃干净', () => {
    const r = expandTemplate({ [`list|${MAX_REPEAT + 1}`]: [1] }, { random: rnd() });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain(String(MAX_REPEAT));
  });

  it('多层相乘炸开时被节点数上限拦住', () => {
    const r = expandTemplate(
      { 'a|100': [{ 'b|100': [{ 'c|100': [{ x: 1 }] }] }] },
      { random: rnd() },
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain(String(MAX_NODES));
  });

  it('展开永不抛异常，错误以 ok:false 返回（09 §6.5）', () => {
    expect(() => expandTemplate({ 'a|99999': [1] })).not.toThrow();
  });
});

describe('expandTemplateJson', () => {
  it('从 JSON 字符串展开', () => {
    const r = expandTemplateJson('{"list|2":[{"id|+1":1}]}', { random: rnd() });
    expect(r.ok && (r.value as any).list).toHaveLength(2);
  });

  it('模板不是合法 JSON 时给出明确原因', () => {
    const r = expandTemplateJson('{列表|2: []}');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('不是合法 JSON');
  });
});

describe('确定性', () => {
  it('同一个种子产出完全相同的结果 —— 测试和排查才有依据', () => {
    const tpl = { 'list|5': [{ id: '@natural', name: '@cname', p: '@float(1,99,2)' }] };
    const a = expandTemplate(tpl, { random: seededRandom(7) });
    const b = expandTemplate(tpl, { random: seededRandom(7) });
    expect(a).toEqual(b);
  });

  it('不同种子产出不同结果', () => {
    const tpl = { 'list|5': [{ name: '@cname' }] };
    const a = expandTemplate(tpl, { random: seededRandom(1) });
    const b = expandTemplate(tpl, { random: seededRandom(2) });
    expect(a).not.toEqual(b);
  });
});
