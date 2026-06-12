import type { ScanResult } from "../api/types";

const CACHE_TTL_MS = 60 * 1000; // 60 seconds — enough for tab switching, avoids holding stale 200MB blobs

// Byte budget across all cached scans. A scanned tree is dominated by its node
// array; we estimate ~320 bytes/node (the NodeRecord fields + strings) and evict
// the least-recently-used entries once the estimate exceeds this cap, so a few
// large scans can't pin hundreds of MB of renderer heap.
const CACHE_MAX_BYTES = 256 * 1024 * 1024;
const BYTES_PER_NODE = 320;

interface CacheEntry {
  result: ScanResult;
  /** Creation time — drives TTL expiry (kept fixed so stale data can't live
   *  forever just because it keeps being read). */
  ts: number;
  /** Last-read time — drives LRU eviction order. */
  used: number;
  /** Estimated retained heap for this entry, in bytes. */
  bytes: number;
}

const cache = new Map<string, CacheEntry>();

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase().replace(/\/$/, "");
}

function estimateBytes(result: ScanResult): number {
  const nodes = result.nodes?.length ?? 0;
  return Math.max(1, nodes) * BYTES_PER_NODE;
}

/** Evict least-recently-used entries until the total estimate is within the cap.
 *  `incoming` is the entry just inserted (kept even if it alone exceeds the cap). */
function evictToCap(incomingKey: string): void {
  let total = 0;
  for (const e of cache.values()) total += e.bytes;
  if (total <= CACHE_MAX_BYTES) return;
  // Oldest first (Map preserves insertion order, but `ts` is the truth after
  // re-inserts on access), excluding the just-inserted entry.
  const ordered = [...cache.entries()].sort((a, b) => a[1].used - b[1].used);
  for (const [k, e] of ordered) {
    if (total <= CACHE_MAX_BYTES) break;
    if (k === incomingKey) continue;
    cache.delete(k);
    total -= e.bytes;
  }
}

export function getCached(path: string): ScanResult | null {
  const key = normalizePath(path);
  const entry = cache.get(key);
  if (!entry) { console.log("[scanCache] GET miss key=", key); return null; }
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    console.log("[scanCache] GET expired key=", key);
    cache.delete(key);
    return null;
  }
  entry.used = Date.now();
  console.log("[scanCache] GET hit key=", key, "nodes=", entry.result.nodes?.length);
  return entry.result;
}

export function setCached(path: string, result: ScanResult): void {
  const key = normalizePath(path);
  console.log("[scanCache] SET key=", key, "nodes=", result.nodes?.length);
  // Re-insert at the end so insertion order tracks recency.
  cache.delete(key);
  const now = Date.now();
  cache.set(key, { result, ts: now, used: now, bytes: estimateBytes(result) });
  evictToCap(key);
}

/** Remove the path, any sub-path entries, and any ancestor entries. */
export function invalidate(path: string): void {
  const key = normalizePath(path);
  const removed: string[] = [];
  for (const k of cache.keys()) {
    if (k === key || k.startsWith(key + "/") || key.startsWith(k + "/")) {
      cache.delete(k);
      removed.push(k);
    }
  }
  console.log("[scanCache] invalidate key=", key, "removed=", removed);
}

/** Invalidate all entries — use after operations that change multiple locations. */
export function invalidateAll(): void {
  const keys = [...cache.keys()];
  cache.clear();
  console.log("[scanCache] invalidateAll removed=", keys);
}
