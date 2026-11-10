import type { MockStore } from '../types.js';

export const LOCAL_STORAGE_QUOTA_BYTES = 10 * 1024 * 1024;

export function estimateStoreBytes(store: MockStore): number {
  return new TextEncoder().encode(JSON.stringify(store)).byteLength;
}

export function estimateRuleCapacity(store: MockStore): number | null {
  if (store.rules.length === 0) return null;
  const total = estimateStoreBytes(store);
  const base = estimateStoreBytes({ ...store, rules: [] });
  const averageRuleBytes = Math.max(1, (total - base) / store.rules.length);
  return Math.max(0, Math.floor((LOCAL_STORAGE_QUOTA_BYTES - base) / averageRuleBytes));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
