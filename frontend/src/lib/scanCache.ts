import type { ScanResult } from "../api/types";

const CACHE_TTL_MS = 60 * 1000; // 60 seconds — enough for tab switching, avoids holding stale 200MB blobs

interface CacheEntry {
  result: ScanResult;
  ts: number;
}

const cache = new Map<string, CacheEntry>();

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase().replace(/\/$/, "");
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
  console.log("[scanCache] GET hit key=", key, "nodes=", entry.result.nodes?.length);
  return entry.result;
}

export function setCached(path: string, result: ScanResult): void {
  const key = normalizePath(path);
  console.log("[scanCache] SET key=", key, "nodes=", result.nodes?.length);
  cache.set(key, { result, ts: Date.now() });
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
