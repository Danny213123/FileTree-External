import { invoke } from "@tauri-apps/api/core";
import { isTauriV2 } from "../api/v2";

interface CacheEntry {
  promise: Promise<string | null>;
  bytes: number;
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
      entry.bytes = value ? value.length * 2 : 0;
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

export function loadShellIcon(extension: string): Promise<string | null> {
  const normalized = extension.replace(/^\./, "").toLowerCase();
  if (!normalized) return Promise.resolve(null);
  if (!isTauriV2()) {
    return Promise.resolve(`/api/file-icon?ext=${encodeURIComponent(normalized)}`);
  }
  return iconCache.get(normalized, () =>
    invoke<string | null>("file_icon", { extension: normalized }),
  );
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
