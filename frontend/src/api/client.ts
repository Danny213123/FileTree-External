import type {
  ScanResult,
  DriveList,
  Config,
  ExactDuplicatesResult,
  SpecialFolderList,
} from "./types";

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json() as Promise<T>;
}

async function responseErrorText(res: Response): Promise<string> {
  const text = await res.text();
  if (!text) return `HTTP ${res.status}`;
  try {
    const parsed = JSON.parse(text) as { error?: string };
    return parsed.error ?? text;
  } catch {
    return text;
  }
}

export interface ScanOptions {
  path: string;
  threads?: number;
  includeHidden?: boolean;
  followLinks?: boolean;
  excludePatterns?: string[];
  maxDepth?: number;
  nocache?: boolean;
}

export function scanStreamUrl(opts: ScanOptions): string {
  const params = new URLSearchParams({ path: opts.path });
  if (opts.threads != null) params.set("threads", String(opts.threads));
  if (opts.includeHidden) params.set("hidden", "1");
  if (opts.followLinks) params.set("links", "1");
  if (opts.excludePatterns?.length)
    params.set("exclude", opts.excludePatterns.join(","));
  if (opts.maxDepth != null) params.set("maxdepth", String(opts.maxDepth));
  return `/api/scan-stream?${params}`;
}

export function scanUrl(opts: ScanOptions): string {
  const params = new URLSearchParams({ path: opts.path });
  if (opts.threads != null) params.set("threads", String(opts.threads));
  if (opts.includeHidden) params.set("hidden", "1");
  if (opts.followLinks) params.set("links", "1");
  if (opts.excludePatterns?.length)
    params.set("exclude", opts.excludePatterns.join(","));
  if (opts.maxDepth != null) params.set("maxdepth", String(opts.maxDepth));
  if (opts.nocache) params.set("nocache", "1");
  return `/api/scan?${params}`;
}

export async function fetchScan(
  opts: ScanOptions,
  signal?: AbortSignal,
): Promise<ScanResult> {
  return getJson<ScanResult>(scanUrl(opts), signal);
}

export async function fetchDrives(): Promise<DriveList> {
  return getJson<DriveList>("/api/drives");
}

export async function fetchSpecialFolders(): Promise<SpecialFolderList> {
  return getJson<SpecialFolderList>("/api/special-folders");
}

export async function fetchConfig(): Promise<Config> {
  return getJson<Config>("/api/config");
}

function buildDupeParams(filter: import("./types").DupeFilter): URLSearchParams {
  return new URLSearchParams({
    minSize: String(filter.minSize),
    ...(filter.maxSize != null ? { maxSize: String(filter.maxSize) } : {}),
    ...(filter.extensions ? { extensions: filter.extensions } : {}),
    ...(filter.namePattern ? { namePattern: filter.namePattern } : {}),
    ...(filter.nameExact ? { nameExact: "1" } : {}),
    ...(filter.dateFrom ? { dateFrom: String(filter.dateFrom) } : {}),
    ...(filter.dateTo ? { dateTo: String(filter.dateTo) } : {}),
    ...(filter.keepPathPrefix ? { keepPrefix: filter.keepPathPrefix } : {}),
    ...(filter.searchPathPrefix ? { searchPrefix: filter.searchPathPrefix } : {}),
  });
}

export interface DupesProgress {
  phase: "idle" | "scan" | "hash" | "done";
  filesScanned: number;
  filesHashing: number;
  filesHashed: number;
}

export async function fetchDupesProgress(): Promise<DupesProgress> {
  const res = await fetch("/api/dupes-progress");
  if (!res.ok) return { phase: "idle", filesScanned: 0, filesHashing: 0, filesHashed: 0 };
  try { return await res.json() as DupesProgress; } catch { return { phase: "idle", filesScanned: 0, filesHashing: 0, filesHashed: 0 }; }
}

export async function cancelDupesScan(): Promise<void> {
  await fetch("/api/dupes-cancel", { method: "POST" }).catch(() => {});
}

export async function fetchDupesScan(
  paths: string[],
  filter: import("./types").DupeFilter,
  signal?: AbortSignal,
): Promise<import("./types").DupesResult> {
  const params = buildDupeParams(filter);
  params.set("paths", paths.join(","));
  return getJson<import("./types").DupesResult>(`/api/dupes-scan?${params}`, signal);
}

export async function fetchDupes(
  filter: import("./types").DupeFilter,
  signal?: AbortSignal,
): Promise<import("./types").DupesResult> {
  return getJson<import("./types").DupesResult>(`/api/dupes?${buildDupeParams(filter)}`, signal);
}

export async function fetchExactDuplicates(
  path: string,
  signal?: AbortSignal,
): Promise<ExactDuplicatesResult> {
  const params = new URLSearchParams({ path });
  return getJson<ExactDuplicatesResult>(
    `/api/duplicates?${params}`,
    signal,
  );
}

export async function revealPath(path: string): Promise<void> {
  const params = new URLSearchParams({ path });
  await fetch(`/api/reveal?${params}`);
}

export async function openPath(path: string): Promise<void> {
  const params = new URLSearchParams({ path });
  await fetch(`/api/open?${params}`);
}

export async function deletePath(
  path: string,
  permanent = false,
): Promise<{ ok: boolean; error?: string }> {
  const params = new URLSearchParams({ path });
  if (permanent) params.set("permanent", "1");
  const res = await fetch(`/api/delete?${params}`, { method: "POST" });
  if (res.ok) return { ok: true };
  const text = await res.text();
  return { ok: false, error: text };
}

export async function moveItem(src: string, dst: string): Promise<{ ok: boolean; error?: string }> {
  const params = new URLSearchParams({ src, dst });
  const res = await fetch(`/api/move?${params}`, { method: "POST" });
  if (res.ok) return { ok: true };
  const text = await res.text();
  return { ok: false, error: text };
}

export async function openProperties(path: string): Promise<void> {
  const params = new URLSearchParams({ path });
  await fetch(`/api/properties?${params}`);
}

export async function createFolder(path: string): Promise<void> {
  const params = new URLSearchParams({ path });
  const res = await fetch(`/api/mkdir?${params}`);
  if (!res.ok) {
    const body = await res.json() as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
}

export async function fetchBookmarks(): Promise<string[]> {
  const res = await fetch("/api/bookmarks");
  if (!res.ok) return [];
  try { return await res.json() as string[]; } catch { return []; }
}

export async function saveBookmarks(paths: string[]): Promise<void> {
  await fetch("/api/bookmarks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(paths),
  });
}

// ── Settings ─────────────────────────────────────────────────

export interface AppSettings {
  darkMode?: boolean;
  threads?: number;
  includeHidden?: boolean;
  followLinks?: boolean;
  exclude?: string;
  lastPath?: string;
  metric?: string;
  unit?: string;
  showFiles?: boolean;
  sortKey?: string;
  sortDir?: number;
  openTabs?: string[];
  recentPaths?: string[];
}

export async function fetchSettings(): Promise<AppSettings> {
  const res = await fetch("/api/settings");
  if (!res.ok) return {};
  try { return await res.json() as AppSettings; } catch { return {}; }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
}

// ── Smart watch ──────────────────────────────────────────────

// DirMtime is one entry in the mtime cache — one per directory node.
export interface DirMtime { path: string; mtime: number; }

// POST the mtime cache; returns paths of dirs whose mtime changed.
// O(#dirs) stat calls on the backend — no full BFS.
export async function pollWatchDirs(dirs: DirMtime[]): Promise<string[]> {
  const res = await fetch("/api/watch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(dirs),
  });
  if (!res.ok) return [];
  try {
    const data = await res.json() as { changed?: string[] };
    return data.changed ?? [];
  } catch { return []; }
}

// ── AI chat ──────────────────────────────────────────────────

export async function fetchAiModels(): Promise<string[]> {
  const res = await fetch("/api/ai-models");
  if (!res.ok) return [];
  try {
    const data = await res.json() as { models?: { name: string }[] };
    return (data.models ?? []).map((m) => m.name);
  } catch { return []; }
}

export function aiChatStreamUrl(): string {
  return "/api/ai-chat";
}

export async function* streamAiChat(
  model: string,
  messages: { role: string; content: string }[],
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const res = await fetch("/api/ai-chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as { message?: { content?: string }; done?: boolean; error?: string };
        if (parsed.error) throw new Error(parsed.error);
        if (parsed.message?.content) yield parsed.message.content;
      } catch { /* skip malformed */ }
    }
  }
}

type ElectronAPI = {
  copyText?: (text: string) => Promise<void>;
  copyFiles?: (paths: string[]) => Promise<void>;
  shellContextMenu?: (path: string, x: number, y: number) => Promise<void>;
};
const eAPI = (): ElectronAPI =>
  (window as unknown as { electronAPI?: ElectronAPI }).electronAPI ?? {};

export async function copyPath(path: string): Promise<void> {
  if (eAPI().copyText) {
    await eAPI().copyText!(path);
  } else {
    await fetch("/api/copy-path", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
  }
}

export async function renameItem(path: string, newName: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch("/api/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, newName }),
  });
  if (res.ok) return { ok: true };
  return { ok: false, error: await responseErrorText(res) };
}

export async function moveItems(paths: string[], destination: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch("/api/move-items", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths, destination }),
  });
  if (res.ok) return { ok: true };
  return { ok: false, error: await responseErrorText(res) };
}

export async function copyFiles(paths: string[]): Promise<void> {
  if (eAPI().copyFiles) {
    await eAPI().copyFiles!(paths);
  } else {
    await fetch("/api/copy-files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths }),
    });
  }
}

export async function dragOut(paths: string[]): Promise<void> {
  await fetch("/api/drag-out", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  });
}

export async function shellContextMenu(path: string, x: number, y: number): Promise<void> {
  if (eAPI().shellContextMenu) {
    await eAPI().shellContextMenu!(path, x, y);
  } else {
    const params = new URLSearchParams({ path, x: String(Math.round(x)), y: String(Math.round(y)) });
    await fetch(`/api/shell-context-menu?${params}`);
  }
}

export function exportCsvUrl(path: string): string {
  return `/api/export.csv?path=${encodeURIComponent(path)}`;
}

export function exportJsonUrl(path: string): string {
  return `/api/export.json?path=${encodeURIComponent(path)}`;
}

// ── dupeguru V2 API ───────────────────────────────────────────────────────

export interface DupesV2Opts {
  paths: string[];
  mode: import("./types").DupeScanMode;
  minScore?: number;
  weighted?: boolean;
  tags?: string[];
  minSize?: number;
  maxSize?: number;
  extensions?: string;
  mixKinds?: boolean;
  sortBy?: import("./types").ReprioritizeCriterion;
}

export async function fetchDupesV2(
  opts: DupesV2Opts,
  signal?: AbortSignal,
): Promise<import("./types").DupesV2Result> {
  const params = new URLSearchParams({ paths: opts.paths.join(","), mode: opts.mode });
  if (opts.minScore != null) params.set("minScore", String(opts.minScore));
  if (opts.weighted)         params.set("weighted", "1");
  if (opts.tags?.length)     params.set("tags", opts.tags.join(","));
  if (opts.minSize != null)  params.set("minSize", String(opts.minSize));
  if (opts.maxSize != null)  params.set("maxSize", String(opts.maxSize));
  if (opts.extensions)       params.set("extensions", opts.extensions);
  if (opts.mixKinds)         params.set("mixKinds", "1");
  if (opts.sortBy)           params.set("sortBy", opts.sortBy);
  return getJson<import("./types").DupesV2Result>(`/api/dupes-v2?${params}`, signal);
}

export async function dupeAction(
  action: "delete" | "move" | "copy",
  paths: string[],
  opts: { permanent?: boolean; dest?: string },
): Promise<{ ok: boolean; errors: string[] }> {
  const body = JSON.stringify({ action, paths, permanent: opts.permanent ?? false, dest: opts.dest ?? "" });
  const res = await fetch("/api/dupes-action", { method: "POST", headers: { "Content-Type": "application/json" }, body });
  if (!res.ok) return { ok: false, errors: [`HTTP ${res.status}`] };
  return res.json() as Promise<{ ok: boolean; errors: string[] }>;
}

export async function dupeMakeRef(
  groupPaths: string[],
  refPath: string,
): Promise<import("./types").DupeGroupV2> {
  const body = JSON.stringify({ paths: groupPaths, refPath });
  const res = await fetch("/api/dupes-make-ref", { method: "POST", headers: { "Content-Type": "application/json" }, body });
  const data = await res.json() as import("./types").DupesV2Result;
  return data.groups[0];
}

export async function dupeIgnorePair(a: string, b: string): Promise<{ ok: boolean; count: number }> {
  const body = JSON.stringify({ a, b });
  const res = await fetch("/api/dupes-ignore", { method: "POST", headers: { "Content-Type": "application/json" }, body });
  if (!res.ok) return { ok: false, count: 0 };
  return res.json() as Promise<{ ok: boolean; count: number }>;
}

export async function dupeClearIgnoreList(): Promise<{ ok: boolean }> {
  const res = await fetch("/api/dupes-ignore", { method: "DELETE" });
  if (!res.ok) return { ok: false };
  return res.json() as Promise<{ ok: boolean }>;
}
