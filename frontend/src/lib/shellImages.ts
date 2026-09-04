import { invoke } from "@tauri-apps/api/core";
import { isTauriV2 } from "../api/v2";

interface CacheEntry {
  promise: Promise<string | null>;
  bytes: number;
  value?: string;
}

class ImagePromiseCache {
  private readonly entries = new Map<string, CacheEntry>();
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  get(key: string, load: () => Promise<string | null>): Promise<string | null> {
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.promise;
    }
    const entry: CacheEntry = { promise: Promise.resolve(null), bytes: 0 };
    entry.promise = load().then((value) => {
      if (this.entries.get(key) !== entry) return value;
      if (!value) {
        // A shell worker or association lookup can fail transiently. Do not
        // turn that one miss into a permanent blank icon for the app session.
        this.entries.delete(key);
        return null;
      }
      entry.value = value;
      entry.bytes = value.length * 2;
      this.bytes += entry.bytes;
      this.trim();
      return value;
    }).catch((error) => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      console.warn("Windows shell image unavailable", error);
      return null;
    });
    this.entries.set(key, entry);
    return entry.promise;
  }

  peek(key: string): string | undefined {
    const hit = this.entries.get(key);
    if (!hit?.value) return undefined;
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.value;
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes = Math.max(0, this.bytes - entry.bytes);
  }

  private trim(): void {
    while (this.bytes > this.maxBytes && this.entries.size > 1) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey == null) break;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      this.bytes = Math.max(0, this.bytes - (oldest?.bytes ?? 0));
    }
  }
}

const iconCache = new ImagePromiseCache(4 * 1024 * 1024);
const thumbnailCache = new ImagePromiseCache(16 * 1024 * 1024);
const ICON_BATCH_MAX = 128;

interface PendingIconLoad {
  resolve: (value: string | null) => void;
  reject: (reason?: unknown) => void;
}

const pendingIconLoads = new Map<string, PendingIconLoad[]>();
let iconBatchScheduled = false;
let iconBatchRunning = false;

function scheduleIconBatch(): void {
  if (iconBatchScheduled || iconBatchRunning) return;
  iconBatchScheduled = true;
  queueMicrotask(() => {
    iconBatchScheduled = false;
    void flushIconBatch();
  });
}

async function flushIconBatch(): Promise<void> {
  if (iconBatchRunning || pendingIconLoads.size === 0) return;
  iconBatchRunning = true;
  const extensions = Array.from(pendingIconLoads.keys()).slice(0, ICON_BATCH_MAX);
  const waiters = new Map<string, PendingIconLoad[]>();
  for (const extension of extensions) {
    waiters.set(extension, pendingIconLoads.get(extension) ?? []);
    pendingIconLoads.delete(extension);
  }

  try {
    let values: Record<string, string | null>;
    try {
      values = await invoke<Record<string, string | null>>("file_icons", { extensions });
    } catch {
      // Keep a newly-updated renderer compatible while the desktop backend is
      // still restarting, and retain support for older desktop builds.
      const fallback = await Promise.all(extensions.map(async (extension) => [
        extension,
        await invoke<string | null>("file_icon", { extension }).catch(() => null),
      ] as const));
      values = Object.fromEntries(fallback);
    }
    for (const extension of extensions) {
      const value = values[extension] ?? null;
      for (const waiter of waiters.get(extension) ?? []) waiter.resolve(value);
    }
  } catch (error) {
    for (const loaders of waiters.values()) {
      for (const waiter of loaders) waiter.reject(error);
    }
  } finally {
    iconBatchRunning = false;
    if (pendingIconLoads.size > 0) scheduleIconBatch();
  }
}

function loadNativeShellIcon(extension: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const waiters = pendingIconLoads.get(extension);
    if (waiters) waiters.push({ resolve, reject });
    else pendingIconLoads.set(extension, [{ resolve, reject }]);
    scheduleIconBatch();
  });
}

export function loadShellIcon(extension: string): Promise<string | null> {
  const normalized = extension.replace(/^\./, "").toLowerCase();
  if (!normalized) return Promise.resolve(null);
  if (!isTauriV2()) {
    return Promise.resolve(`/api/file-icon?ext=${encodeURIComponent(normalized)}`);
  }
  return iconCache.get(normalized, () => loadNativeShellIcon(normalized));
}

export function peekShellIcon(extension: string): string | undefined {
  const normalized = extension.replace(/^\./, "").toLowerCase();
  return normalized ? iconCache.peek(normalized) : undefined;
}

export function invalidateShellIcon(extension: string): void {
  const normalized = extension.replace(/^\./, "").toLowerCase();
  if (normalized) iconCache.delete(normalized);
}

export function loadShellThumbnail(
  path: string,
  size = 480,
  iconFallback = true,
): Promise<string | null> {
  if (!path) return Promise.resolve(null);
  if (!isTauriV2()) {
    return Promise.resolve(`/api/thumbnail?path=${encodeURIComponent(path)}`);
  }
  const boundedSize = Math.min(512, Math.max(16, Math.round(size)));
  const key = `${path.toLowerCase()}|${boundedSize}|${iconFallback ? 1 : 0}`;
  return thumbnailCache.get(key, () =>
    invoke<string | null>("file_thumbnail", {
      path,
      size: boundedSize,
      iconFallback,
    }),
  );
}
