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
  if (opts.nocache) params.set("nocache", "1");
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
  // VS Code workbench layout
  activeView?: string;
  sidebarOpen?: boolean;
  sidebarWidth?: number;
  panelOpen?: boolean;
  panelHeight?: number;
  chatOpen?: boolean;
  chatWidth?: number;
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
      // Parse and error-handling are kept separate so a provider-reported
      // error is surfaced (thrown) rather than swallowed by the parse catch.
      let parsed: { message?: { content?: string }; done?: boolean; error?: string } | null = null;
      try { parsed = JSON.parse(trimmed); } catch { parsed = null; }
      if (!parsed) continue;
      if (parsed.error) throw new Error(parsed.error);
      if (parsed.message?.content) yield parsed.message.content;
    }
  }
}

// ── Agentic AI chat (tool-calling) ───────────────────────────

export interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> | string };
}
export type ChatRole = "system" | "user" | "assistant" | "tool";
export interface OllamaMessage {
  role: ChatRole;
  content: string;
  tool_calls?: OllamaToolCall[];
}
export type AgentChatEvent =
  | { type: "text"; value: string }
  | { type: "tool_calls"; value: OllamaToolCall[] };

// Stream a chat turn that may include tool definitions. The Rust server forwards
// the body verbatim to Ollama /api/chat, so `tools` and role:"tool" messages pass
// straight through, and `message.tool_calls` is surfaced from the NDJSON stream.
export async function* streamAgentChat(
  model: string,
  messages: OllamaMessage[],
  tools: unknown[] | undefined,
  signal?: AbortSignal,
): AsyncGenerator<AgentChatEvent> {
  const res = await fetch("/api/ai-chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, tools, stream: true }),
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
      let parsed: { message?: OllamaMessage; done?: boolean; error?: string };
      try { parsed = JSON.parse(trimmed); } catch { continue; }
      if (parsed.error) throw new Error(parsed.error);
      const msg = parsed.message;
      if (msg?.tool_calls?.length) yield { type: "tool_calls", value: msg.tool_calls };
      if (msg?.content) yield { type: "text", value: msg.content };
    }
  }
}

type ElectronAPI = {
  copyText?: (text: string) => Promise<void>;
  copyFiles?: (paths: string[]) => Promise<void>;
  shellContextMenu?: (paths: string | string[], x: number, y: number) => Promise<void>;
  moveItemsNative?: (paths: string[], destination: string) => Promise<{ aborted: boolean }>;
};
const eAPI = (): ElectronAPI =>
  (window as unknown as { electronAPI?: ElectronAPI }).electronAPI ?? {};

/** True when running in Electron with the native shell move-operation available. */
export function hasNativeMove(): boolean {
  return typeof eAPI().moveItemsNative === "function";
}

/**
 * Move items into a folder using the Windows shell (IFileOperation), which shows
 * the real native dialogs (progress, Replace/Skip/Keep both, "source and
 * destination file names are the same", elevation). Throws if unavailable.
 */
export async function moveItemsNative(
  paths: string[],
  destination: string,
): Promise<{ aborted: boolean }> {
  const api = eAPI();
  if (!api.moveItemsNative) throw new Error("native move unavailable");
  return api.moveItemsNative(paths, destination);
}

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

export type MoveConflictChoice = "replace" | "keep-both" | "skip";

export interface MoveConflict {
  /** Absolute source path that collides with an existing item. */
  src: string;
  /** Base name that already exists in the destination. */
  name: string;
}

export interface MoveItemsResult {
  ok: boolean;
  /** Joined per-item error messages, if any. */
  error?: string;
  /** Sources that were moved on this call. */
  moved: string[];
  /** Sources that were already the same file in the destination (no-op). */
  alreadyThere: string[];
  /** Collisions reported in detect mode (no `conflict` arg) so the UI can ask. */
  conflicts: MoveConflict[];
  /** Sources skipped when called with conflict="skip". */
  skipped: string[];
  /** Per-item error strings. */
  errors: string[];
}

/**
 * Move items into a folder.
 *
 * Called once without `conflict` to "detect": clean items are moved and any
 * name collisions are returned in `conflicts` (nothing overwritten). Call again
 * with the colliding sources and a `conflict` choice to resolve them.
 */
export async function moveItems(
  paths: string[],
  destination: string,
  conflict?: MoveConflictChoice,
): Promise<MoveItemsResult> {
  const empty: MoveItemsResult = {
    ok: false, moved: [], alreadyThere: [], conflicts: [], skipped: [], errors: [],
  };
  const res = await fetch("/api/move-items", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(conflict ? { paths, destination, conflict } : { paths, destination }),
  });
  if (!res.ok) {
    return { ...empty, error: await responseErrorText(res) };
  }
  try {
    const j = (await res.json()) as Partial<MoveItemsResult>;
    const errors = j.errors ?? [];
    return {
      ok: j.ok ?? errors.length === 0,
      moved: j.moved ?? [],
      alreadyThere: j.alreadyThere ?? [],
      conflicts: j.conflicts ?? [],
      skipped: j.skipped ?? [],
      errors,
      error: errors.length > 0 ? errors.join("; ") : undefined,
    };
  } catch {
    return { ...empty, ok: true };
  }
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

export async function shellContextMenu(paths: string | string[], x: number, y: number): Promise<void> {
  if (eAPI().shellContextMenu) {
    await eAPI().shellContextMenu!(paths, x, y);
  } else {
    const first = Array.isArray(paths) ? paths[0] : paths;
    if (!first) return;
    const params = new URLSearchParams({ path: first, x: String(Math.round(x)), y: String(Math.round(y)) });
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
