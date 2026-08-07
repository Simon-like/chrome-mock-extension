/**
 * 脱敏的测试
 *
 * 这是**安全边界**，测试的心态和别处不同：
 * 别的地方漏一个用例是少覆盖一条路径，这里漏一个用例是把用户的
 * 生产环境 token 送给了第三方。所以宁可测得啰嗦。
 */

import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  hostAllowed,
  isSensitiveKey,
  looksLikeSecret,
  redactBody,
  redactCapture,
  redactUrl,
  redactValue,
} from '../src/core/mcp/redact.js';

const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

describe('isSensitiveKey', () => {
  it('命中常见的凭证字段名', () => {
    for (const k of ['Authorization', 'Cookie', 'access_token', 'apiKey', 'password', 'sessionId']) {
      expect(isSensitiveKey(k), k).toBe(true);
    }
  });

  it('大小写、下划线、连字符的各种写法都算同一个', () => {
    for (const k of ['accessToken', 'access_token', 'Access-Token', 'ACCESS TOKEN']) {
      expect(isSensitiveKey(k), k).toBe(true);
    }
  });

  it('带业务前缀的也命中 —— 真实字段名很少是光秃秃的', () => {
    expect(isSensitiveKey('x-jd-token')).toBe(true);
    expect(isSensitiveKey('userAuthorization')).toBe(true);
  });

  it('普通字段不误伤', () => {
    for (const k of ['id', 'name', 'price', 'list', 'total', 'createdAt']) {
      expect(isSensitiveKey(k), k).toBe(false);
    }
  });
});

describe('looksLikeSecret', () => {
  it('识别 JWT', () => {
    expect(looksLikeSecret(JWT)).toBe(true);
  });

  it('识别长十六进制串（session id / 签名）', () => {
    expect(looksLikeSecret('a'.repeat(32))).toBe(true);
    expect(looksLikeSecret('0123456789abcdef0123456789abcdef')).toBe(true);
  });

  it('普通值不误伤', () => {
    for (const v of ['1001', 'hello', '2026-08-06', 'abc.def', 'a'.repeat(10)]) {
      expect(looksLikeSecret(v), v).toBe(false);
    }
  });
});

describe('redactUrl', () => {
  it('打掉查询参数里的 token —— 光把 URL 列出来就已经泄露了', () => {
    const out = redactUrl('https://a.com/api/x?access_token=abc123&page=1');
    expect(out).toContain(REDACTED);
    expect(out).not.toContain('abc123');
    expect(out).toContain('page=1'); // 无关参数保留
  });

  it('键名不敏感但值像凭证时也打掉', () => {
    const out = redactUrl(`https://a.com/api/x?t=${JWT}`);
    expect(out).not.toContain(JWT);
  });

  it('没有敏感参数时原样返回', () => {
    const url = 'https://a.com/api/x?page=1&size=20';
    expect(redactUrl(url)).toBe(url);
  });

  it('URL 解析不了时【去掉整个查询串】而不是原样放行', () => {
    // 看不懂的形态就不该放行 —— 这是本模块的立场
    const out = redactUrl('not a url?secret=abc123');
    expect(out).not.toContain('abc123');
    expect(out).toBe(`not a url?${REDACTED}`);
  });
});

describe('redactValue', () => {
  it('打掉对象里的敏感字段', () => {
    expect(redactValue({ token: 'abc', name: 'x' })).toEqual({ token: REDACTED, name: 'x' });
  });

  it('递归进嵌套对象和数组', () => {
    const out = redactValue({ data: { list: [{ password: 'p', id: 1 }] } }) as any;
    expect(out.data.list[0]).toEqual({ password: REDACTED, id: 1 });
  });

  it('键名普通但值是 JWT 时也打掉', () => {
    expect(redactValue({ v: JWT })).toEqual({ v: REDACTED });
  });

  it('不动普通数据', () => {
    const v = { list: [{ id: 1, name: '商品' }], total: 48 };
    expect(redactValue(v)).toEqual(v);
  });
});

describe('redactBody', () => {
  it('JSON 体按结构打码', () => {
    const out = redactBody('{"token":"abc","id":1}');
    expect(JSON.parse(out!)).toEqual({ token: REDACTED, id: 1 });
  });

  it('非 JSON 文本也要打码，不能因为「不是 JSON」就整段放行', () => {
    const out = redactBody('Authorization: Bearer abc123xyz\nid: 1');
    expect(out).not.toContain('abc123xyz');
  });

  /**
   * 回归：第一版只打掉 `key:` 后的**第一个词**，
   * 于是 `Authorization: Bearer eyJ...` 打掉的是 "Bearer" 这个毫无价值的单词，
   * 真正的 token 原封不动漏出去了。这是最常见的 auth header 形态，必须钉住。
   */
  it('Bearer 形态要打掉整行，不能只打掉 "Bearer" 这个词', () => {
    const out = redactBody(`Authorization: Bearer ${JWT}`)!;
    expect(out).not.toContain(JWT);
    expect(out).toContain(REDACTED);
  });

  it('key=value 形态里的敏感值也打掉', () => {
    expect(redactBody('page=1&token=abc123&size=20')).toBe(`page=1&token=${REDACTED}&size=20`);
  });

  it('无关内容不被殃及', () => {
    const text = 'id: 1\nname: 商品\nprice: 9.9';
    expect(redactBody(text)).toBe(text);
  });

  it('文本里裸露的 JWT 会被打掉', () => {
    expect(redactBody(`somewhere ${JWT} here`)).not.toContain(JWT);
  });

  it('null / 空串原样返回', () => {
    expect(redactBody(null)).toBeNull();
    expect(redactBody('')).toBe('');
  });
});

describe('redactCapture', () => {
  const base = {
    id: '1',
    at: 0,
    url: 'https://a.com/api/x',
    method: 'GET',
    api: 'fetch' as const,
    mocked: false,
    ruleId: null,
    ruleName: null,
    status: 200,
    body: '{"id":1}',
    truncated: false,
    durationMs: 12,
  };

  it('干净的请求不标记 redacted', () => {
    expect(redactCapture(base).redacted).toBe(false);
  });

  it('URL 有东西被打码时标记 redacted —— AI 要知道自己看到的不是全貌', () => {
    const out = redactCapture({ ...base, url: 'https://a.com/api/x?token=abc' });
    expect(out.redacted).toBe(true);
  });

  it('body 有东西被打码时标记 redacted', () => {
    const out = redactCapture({ ...base, body: '{"cookie":"x"}' });
    expect(out.redacted).toBe(true);
    expect(out.body).not.toContain('"x"');
  });

  it('其余字段原样带过 —— 脱敏不该顺手改变数据形状', () => {
    const out = redactCapture(base);
    expect(out.method).toBe('GET');
    expect(out.status).toBe(200);
    expect(out.durationMs).toBe(12);
  });
});

describe('hostAllowed', () => {
  it('空白名单 = 不限（与项目 hostScope 语义一致）', () => {
    expect(hostAllowed('a.com', [])).toBe(true);
  });

  it('精确匹配', () => {
    expect(hostAllowed('a.com', ['a.com'])).toBe(true);
    expect(hostAllowed('b.com', ['a.com'])).toBe(false);
  });

  it('带端口的 host 也能匹配到不带端口的白名单项', () => {
    expect(hostAllowed('a.com:8080', ['a.com'])).toBe(true);
  });

  it('通配符不跨点号 —— *.a.com 不匹配 a.com 本身', () => {
    expect(hostAllowed('dev.a.com', ['*.a.com'])).toBe(true);
    expect(hostAllowed('a.com', ['*.a.com'])).toBe(false);
    expect(hostAllowed('x.y.a.com', ['*.a.com'])).toBe(false);
  });

  it('前缀通配', () => {
    expect(hostAllowed('dev1.x.com', ['dev*.x.com'])).toBe(true);
    expect(hostAllowed('prod.x.com', ['dev*.x.com'])).toBe(false);
  });

  it('任意一项命中即放行', () => {
    expect(hostAllowed('b.com', ['a.com', 'b.com'])).toBe(true);
  });
});
