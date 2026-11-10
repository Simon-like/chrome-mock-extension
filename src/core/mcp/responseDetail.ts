/**
 * MCP 响应详情的最后一道体积控制。
 *
 * 采集层负责“最多留多少”，这里负责“这次最多给模型多少”。
 * 默认只描述 JSON 结构；原始 body 必须显式读取，并按 UTF-8 字节限制分段。
 * 本模块不依赖 Chrome 或 Node API，方便在两端复用同一套语义。
 */

export type BodyMode = 'schema' | 'sample' | 'full';

export interface BodyReadOptions {
  mode: BodyMode;
  maxBytes?: number;
  cursor?: string;
}

export interface BodyChunk {
  body: string;
  returnedBytes: number;
  nextCursor: string | null;
}

interface CaptureBodyPresentation {
  bodyMode: BodyMode;
  body: unknown;
  bodyBytes: number;
  returnedBytes: number;
  sourceTruncated: boolean;
  nextCursor: string | null;
}

const encoder = new TextEncoder();
const MAX_BODY_BYTES = 65_536;
const DEFAULT_SAMPLE_BYTES = 8 * 1024;
const DEFAULT_FULL_BYTES = 16 * 1024;
const TEXT_PREVIEW_BYTES = 2 * 1024;
const MAX_OBJECT_KEYS = 50;
const MAX_DEPTH = 6;
const MAX_EXAMPLE_CHARS = 200;

function bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

/**
 * 读取一段原始 body。cursor 是不透明的 UTF-16 偏移，调用方不应自行计算。
 * maxBytes 限制的是 UTF-8 字节，不是 JS 字符串长度。
 */
export function readBodyChunk(body: string, maxBytes: number, cursor = '0'): BodyChunk {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BODY_BYTES) {
    throw new Error(`max_bytes 必须是 1 到 ${MAX_BODY_BYTES} 之间的整数`);
  }
  if (!/^(0|[1-9]\d*)$/.test(cursor)) throw new Error('cursor 不是有效的读取游标');
  const start = Number(cursor);
  if (!Number.isSafeInteger(start)) throw new Error('cursor 不是有效的读取游标');

  let offset = start;
  let output = '';
  let outputBytes = 0;
  for (const char of body.slice(start)) {
    const charBytes = bytes(char);
    if (outputBytes + charBytes > maxBytes) {
      if (!output) throw new Error('max_bytes 太小，无法容纳下一个 Unicode 字符');
      break;
    }
    output += char;
    outputBytes += charBytes;
    offset += char.length;
  }

  return {
    body: output,
    returnedBytes: outputBytes,
    nextCursor: offset < body.length ? String(offset) : null,
  };
}

/** 把一条已脱敏 capture 变成有界的 MCP 输出，不带出原始完整 body。 */
export function presentCaptureDetail<T extends { body: string | null; truncated: boolean }>(
  entry: T,
  options: BodyReadOptions,
): Omit<T, 'body' | 'truncated'> & CaptureBodyPresentation {
  const { body: raw, truncated, ...metadata } = entry;
  const bodyBytes = raw === null ? 0 : bytes(raw);
  const common = {
    ...metadata,
    bodyMode: options.mode,
    bodyBytes,
    sourceTruncated: truncated,
  } as Omit<T, 'body' | 'truncated'> & Pick<
    CaptureBodyPresentation,
    'bodyMode' | 'bodyBytes' | 'sourceTruncated'
  >;

  if (raw === null) {
    return { ...common, body: null, returnedBytes: 0, nextCursor: null };
  }

  if (options.mode === 'schema') {
    let shape: unknown;
    try {
      shape = summarizeJson(JSON.parse(raw) as unknown);
    } catch {
      const preview = readBodyChunk(raw, TEXT_PREVIEW_BYTES);
      shape = { type: 'text', preview: preview.body, truncated: preview.nextCursor !== null };
    }
    return {
      ...common,
      body: shape,
      returnedBytes: bytes(JSON.stringify(shape)),
      nextCursor: null,
    };
  }

  const maxBytes =
    options.maxBytes ?? (options.mode === 'sample' ? DEFAULT_SAMPLE_BYTES : DEFAULT_FULL_BYTES);
  const chunk = readBodyChunk(raw, maxBytes, options.cursor);
  return { ...common, ...chunk };
}

type JsonShape = Record<string, unknown>;

/** 有界 JSON 结构摘要：只展开数组首项，宽对象和深嵌套都有明确截断标记。 */
function summarizeJson(value: unknown, depth = 0): JsonShape {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return { type: 'array', itemCount: value.length, truncated: true };
    return {
      type: 'array',
      itemCount: value.length,
      items: value.length > 0 ? summarizeJson(value[0], depth + 1) : null,
      omittedItems: Math.max(0, value.length - 1),
    };
  }

  if (typeof value === 'object') {
    if (depth >= MAX_DEPTH) return { type: 'object', truncated: true };
    const entries = Object.entries(value as Record<string, unknown>);
    const properties: Record<string, JsonShape> = Object.create(null) as Record<string, JsonShape>;
    for (const [key, child] of entries.slice(0, MAX_OBJECT_KEYS)) {
      properties[key] = summarizeJson(child, depth + 1);
    }
    return {
      type: 'object',
      properties,
      omittedKeys: Math.max(0, entries.length - MAX_OBJECT_KEYS),
    };
  }

  if (typeof value === 'string') {
    const example = [...value].slice(0, MAX_EXAMPLE_CHARS).join('');
    return { type: 'string', example, truncated: example !== value };
  }
  return { type: typeof value, example: value };
}
