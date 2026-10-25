import { describe, expect, it } from 'vitest';
import {
  presentCaptureDetail,
  readBodyChunk,
} from '../src/core/mcp/responseDetail.js';

function capture(body: string | null, truncated = false) {
  return {
    id: 'c1',
    url: 'https://example.com/api',
    body,
    truncated,
    redacted: false,
  };
}

describe('presentCaptureDetail', () => {
  it('默认用结构摘要代替原始 JSON，并只展开数组首项', () => {
    const raw = JSON.stringify({
      code: 0,
      users: [
        { id: 1, name: '张三', admin: false },
        { id: 2, name: '李四', admin: true },
      ],
    });

    const result = presentCaptureDetail(capture(raw), { mode: 'schema' });

    expect(result.bodyMode).toBe('schema');
    expect(result.bodyBytes).toBe(new TextEncoder().encode(raw).byteLength);
    expect(result.body).toMatchObject({
      type: 'object',
      properties: {
        code: { type: 'number', example: 0 },
        users: {
          type: 'array',
          itemCount: 2,
          omittedItems: 1,
          items: {
            type: 'object',
            properties: {
              id: { type: 'number' },
              name: { type: 'string' },
              admin: { type: 'boolean' },
            },
          },
        },
      },
    });
    expect(result.body).not.toBe(raw);
    expect(result.sourceTruncated).toBe(false);
  });

  it('非 JSON 使用有界文本预览，空 body 不伪造结构', () => {
    const text = presentCaptureDetail(capture('x'.repeat(3000)), { mode: 'schema' });
    expect(text.body).toMatchObject({ type: 'text', truncated: true });
    expect((text.body as { preview: string }).preview.length).toBeLessThan(3000);

    const empty = presentCaptureDetail(capture(null), { mode: 'schema' });
    expect(empty.body).toBeNull();
    expect(empty.bodyBytes).toBe(0);
    expect(empty.returnedBytes).toBe(0);
  });

  it('限制对象键数、嵌套深度和字符串示例长度', () => {
    const wide = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`key${i}`, i]));
    const result = presentCaptureDetail(capture(JSON.stringify({ wide, text: '好'.repeat(300) })), {
      mode: 'schema',
    });
    const body = result.body as {
      properties: {
        wide: { omittedKeys: number; properties: Record<string, unknown> };
        text: { example: string; truncated: boolean };
      };
    };
    expect(Object.keys(body.properties.wide.properties)).toHaveLength(50);
    expect(body.properties.wide.omittedKeys).toBe(10);
    expect([...body.properties.text.example]).toHaveLength(200);
    expect(body.properties.text.truncated).toBe(true);
  });

  it('sample 和 full 返回原始片段，并保留采集层截断标记', () => {
    const sample = presentCaptureDetail(capture('你好世界', true), {
      mode: 'sample',
      maxBytes: 6,
    });
    expect(sample.body).toBe('你好');
    expect(sample.returnedBytes).toBe(6);
    expect(sample.nextCursor).toBe('2');
    expect(sample.sourceTruncated).toBe(true);

    const full = presentCaptureDetail(capture('你好世界'), {
      mode: 'full',
      maxBytes: 6,
      cursor: sample.nextCursor ?? undefined,
    });
    expect(full.body).toBe('世界');
    expect(full.nextCursor).toBeNull();
  });
});

describe('readBodyChunk', () => {
  it('按 UTF-8 字节截断且不拆开 Unicode 码点', () => {
    const chunk = readBodyChunk('A😀B', 5);
    expect(chunk.body).toBe('A😀');
    expect(chunk.returnedBytes).toBe(5);
    expect(chunk.nextCursor).toBe('3');
    expect(readBodyChunk('A😀B', 1, chunk.nextCursor!).body).toBe('B');
  });

  it('拒绝非法游标、超限字节和无法前进的读取', () => {
    expect(() => readBodyChunk('abc', 10, '-1')).toThrow('cursor');
    expect(() => readBodyChunk('abc', 10, '01')).toThrow('cursor');
    expect(() => readBodyChunk('abc', 65537)).toThrow('65536');
    expect(() => readBodyChunk('😀', 1)).toThrow('Unicode');
  });
});
