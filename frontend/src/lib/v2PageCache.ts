const MAX_PAGES = 16;
const MAX_BYTES = 16 * 1024 * 1024;

interface Entry<T> {
  value: T;
  bytes: number;
  used: number;
}

/** Small byte-aware LRU used by v2 tree/search paging. Values are never shared
 * with React state, so evicting an inactive page immediately releases it. */
export class V2PageCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private bytes = 0;

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    entry.used = performance.now();
    return entry.value;
  }

  set(key: string, value: T, estimatedBytes: number): void {
    const previous = this.entries.get(key);
    if (previous) this.bytes -= previous.bytes;
    const bytes = Math.max(1, estimatedBytes);
    this.entries.set(key, { value, bytes, used: performance.now() });
    this.bytes += bytes;
    this.trim(key);
  }

  deletePrefix(prefix: string): void {
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(prefix)) continue;
      this.entries.delete(key);
      this.bytes -= entry.bytes;
    }
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  get retainedBytes(): number {
    return this.bytes;
  }

  private trim(incoming: string): void {
    while (this.entries.size > MAX_PAGES || this.bytes > MAX_BYTES) {
      let victim: string | undefined;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.entries) {
        if (key === incoming && this.entries.size === 1) continue;
        if (entry.used < oldest) {
          oldest = entry.used;
          victim = key;
        }
      }
      if (!victim) break;
      const removed = this.entries.get(victim);
      this.entries.delete(victim);
      this.bytes -= removed?.bytes ?? 0;
    }
  }
}
