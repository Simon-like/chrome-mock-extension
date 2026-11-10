import { describe, expect, it } from 'vitest';
import { createDefaultStore } from '../src/core/store/defaults.js';
import {
  LOCAL_STORAGE_QUOTA_BYTES,
  estimateRuleCapacity,
  estimateStoreBytes,
  formatBytes,
} from '../src/core/store/storageUsage.js';

describe('storage usage', () => {
  it('按 UTF-8 字节估算序列化 store', () => {
    const store = createDefaultStore();
    store.shellTemplates[0]!.name = '中文';
    expect(estimateStoreBytes(store)).toBe(new TextEncoder().encode(JSON.stringify(store)).byteLength);
  });

  it('使用 Chrome 116+ storage.local 的 10 MiB 配额', () => {
    expect(LOCAL_STORAGE_QUOTA_BYTES).toBe(10_485_760);
  });

  it('格式化常见容量', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.50 MB');
  });

  it('根据现有规则平均字节数估算容量，空仓库不猜', () => {
    const empty = createDefaultStore();
    expect(estimateRuleCapacity(empty)).toBeNull();

    const populated = createDefaultStore();
    populated.rules = [
      {
        id: 'r1',
        name: 'x',
        enabled: true,
        groupId: null,
        projectId: null,
        kind: 'override',
        match: { urlMode: 'contains', url: '/x', methods: [], hosts: [] },
        variants: [
          {
            id: 'v1',
            name: '默认',
            response: {
              status: 200,
              headers: {},
              bodyType: 'static',
              body: '{"ok":true}',
              shellTemplateId: null,
              delayMs: 0,
            },
          },
        ],
        activeVariantId: 'v1',
        meta: { createdAt: 1, updatedAt: 1, source: 'manual', hitCount: 0, lastHitAt: null },
      },
    ];
    expect(estimateRuleCapacity(populated)).toBeGreaterThan(1000);
  });
});
