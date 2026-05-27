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
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.result;
}

export function setCached(path: string, result: ScanResult): void {
  cache.set(normalizePath(path), { result, ts: Date.now() });
}

/** Remove the path and any sub-path entries (e.g. after a file system change). */
export function invalidate(path: string): void {
  const key = normalizePath(path);
  for (const k of cache.keys()) {
    if (k === key || k.startsWith(key + "/")) {
      cache.delete(k);
    }
  }
}
