import type {
  ScanResult,
  DriveList,
  Config,
  ExactDuplicatesResult,
  SpecialFolderList,
  SnapshotList,
  SnapshotMeta,
  DiffResult,
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

/**
 * Per-session local auth token exposed by the Electron preload. The Rust server
 * requires it as the `X-FileTree-Token` header on destructive routes (delete /
 * move / move-items / rename / dupes-action / run-command). Empty outside
 * Electron (dev/browser), where the server runs token-less and POST-only.
 */
function authToken(): string {
  return (window as unknown as { electronAPI?: { authToken?: string } })
    .electronAPI?.authToken ?? "";
}

/** Build headers for a mutating request: the session token plus any extras. */
function mutateHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = authToken();
  return { ...(token ? { "X-FileTree-Token": token } : {}), ...(extra ?? {}) };
}

export interface ScanOptions {
  path: string;
  threads?: number;
  includeHidden?: boolean;
  followLinks?: boolean;
  excludePatterns?: string[];
  maxDepth?: number;
  nocache?: boolean;
  /** Opt-in owner resolution (slower scans). Off by default; see `crate::owner`. */
  collectOwners?: boolean;
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
  if (opts.collectOwners) params.set("owners", "1");
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
  if (opts.collectOwners) params.set("owners", "1");
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
  const res = await fetch(`/api/delete?${params}`, { method: "POST", headers: mutateHeaders() });
  if (res.ok) return { ok: true };
  const text = await res.text();
  return { ok: false, error: text };
}

export interface RunCommandResult {
  ok: boolean;
  exit_code?: number | null;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
  error?: string;
}

/**
 * Run a shell command via the backend (POST /api/run-command). The server runs
 * it (PowerShell by default, or cmd), enforces a wall-clock timeout, caps the
 * captured output, and returns the real exit code + stdout/stderr. The AI
 * assistant gates every command behind an approval card before calling this.
 */
export async function runCommand(
  command: string,
  cwd?: string,
  opts?: { shell?: "powershell" | "cmd"; timeoutMs?: number },
): Promise<RunCommandResult> {
  const res = await fetch("/api/run-command", {
    method: "POST",
    headers: mutateHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      command,
      ...(cwd ? { cwd } : {}),
      ...(opts?.shell ? { shell: opts.shell } : {}),
      ...(opts?.timeoutMs != null ? { timeout_ms: opts.timeoutMs } : {}),
    }),
  });
  if (!res.ok) return { ok: false, error: await responseErrorText(res) };
  try {
    return (await res.json()) as RunCommandResult;
  } catch {
    return { ok: false, error: "Invalid response from run-command" };
  }
}

export async function moveItem(src: string, dst: string): Promise<{ ok: boolean; error?: string }> {
  const params = new URLSearchParams({ src, dst });
  const res = await fetch(`/api/move?${params}`, { method: "POST", headers: mutateHeaders() });
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
  /** Opt-in Windows owner resolution during scans (off by default; slower). */
  collectOwners?: boolean;
  exclude?: string;
  lastPath?: string;
  metric?: string;
  unit?: string;
  showFiles?: boolean;
  sortKey?: string;
  sortDir?: number;
  openTabs?: string[];
  recentPaths?: string[];
  // Details-list columns (global, shared by all tabs/panes)
  visibleColumns?: string[];
  decimals?: number;
  // Split-pane layout: each group references tab indices into openTabs.
  paneGroups?: { tabs: number[]; active: number; width?: number; toolbarHidden?: boolean }[];
  // VS Code workbench layout
  activeView?: string;
  sidebarOpen?: boolean;
  sidebarWidth?: number;
  panelOpen?: boolean;
  panelHeight?: number;
  chatOpen?: boolean;
  chatWidth?: number;
  // Inspector (right-side Details/Preview panes)
  previewOpen?: boolean;
  detailsOpen?: boolean;
  inspectorWidth?: number;
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

// ── File text preview (read-only) ────────────────────────────

export interface FileTextPreview {
  /** Decoded text head (present only when the file looks like text). */
  text?: string;
  /** True when the file is larger than the preview cap (server reads ~64 KB). */
  truncated?: boolean;
  /** True when the head contained NUL bytes (treat as non-previewable). */
  binary?: boolean;
}

// Fetch a bounded UTF-8 text preview of a file. Returns { binary: true } for
// anything the server can't read as text so callers fall back to an icon.
export async function fetchFileText(path: string, signal?: AbortSignal): Promise<FileTextPreview> {
  const params = new URLSearchParams({ path });
  const res = await fetch(`/api/file-text?${params.toString()}`, { signal });
  if (!res.ok) return { binary: true };
  try { return await res.json() as FileTextPreview; } catch { return { binary: true }; }
}

// ── Scan snapshots + growth diff (roadmap #5) ────────────────

/** List saved snapshots (newest first). Never throws — returns [] on failure. */
export async function fetchSnapshots(): Promise<SnapshotMeta[]> {
  const res = await fetch("/api/snapshots");
  if (!res.ok) return [];
  try { return ((await res.json()) as SnapshotList).snapshots ?? []; } catch { return []; }
}

/**
 * Save the server's current scan of `path` as a new snapshot. The server reads
 * the freshly-scanned tree from its own cache (no large client upload) and
 * returns the updated snapshot list (newest first).
 */
export async function saveSnapshot(path: string, label?: string): Promise<SnapshotMeta[]> {
  const params = new URLSearchParams({ path });
  if (label) params.set("label", label);
  const res = await fetch(`/api/snapshots?${params}`, { method: "POST", headers: mutateHeaders() });
  if (!res.ok) throw new Error(await responseErrorText(res));
  try { return ((await res.json()) as SnapshotList).snapshots ?? []; } catch { return []; }
}

export async function deleteSnapshot(id: string): Promise<SnapshotMeta[]> {
  const params = new URLSearchParams({ id });
  const res = await fetch(`/api/snapshot-delete?${params}`, { method: "POST", headers: mutateHeaders() });
  if (!res.ok) return fetchSnapshots();
  try { return ((await res.json()) as SnapshotList).snapshots ?? []; } catch { return []; }
}

/**
 * Diff two snapshots, or a snapshot vs the live scan. Pass the literal "current"
 * for either side to compare against the server's current scan of `path`
 * (required when a side is "current").
 */
export async function fetchSnapshotDiff(
  a: string,
  b: string,
  path?: string,
  signal?: AbortSignal,
): Promise<DiffResult> {
  const params = new URLSearchParams({ a, b });
  if (path) params.set("path", path);
  return getJson<DiffResult>(`/api/snapshot-diff?${params}`, signal);
}

/** On-demand owner resolution for a single path (Details pane fallback). */
export async function fetchOwner(path: string, signal?: AbortSignal): Promise<string> {
  const params = new URLSearchParams({ path });
  const res = await fetch(`/api/owner?${params}`, { signal });
  if (!res.ok) return "";
  try { return ((await res.json()) as { owner?: string }).owner ?? ""; } catch { return ""; }
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
  authToken?: string;
  copyText?: (text: string) => Promise<void>;
  copyFiles?: (paths: string[]) => Promise<void>;
  clipboardWriteFiles?: (paths: string[], cut: boolean) => Promise<boolean>;
  clipboardReadFiles?: () => Promise<ClipboardFiles>;
  shellContextMenu?: (paths: string | string[], x: number, y: number) => Promise<void>;
  moveItemsNative?: (paths: string[], destination: string) => Promise<NativeMoveResult>;
  copyItemsNative?: (paths: string[], destination: string) => Promise<NativeMoveResult>;
  restoreFromRecycleBin?: (originalPath: string) => Promise<boolean>;
};
const eAPI = (): ElectronAPI =>
  (window as unknown as { electronAPI?: ElectronAPI }).electronAPI ?? {};

/**
 * Result of a native shell move (`IFileOperation`). `aborted` is true when the
 * user cancelled in the native progress/conflict dialog; the counts are
 * post-hoc per-item outcomes so the caller can react to a partial move:
 *   - `moved`   — sources gone from their origin afterward (true moves),
 *   - `skipped` — sources skipped before the op as no-ops/unsafe (already in
 *                 place, or moving a folder into itself/its descendant),
 *   - `failed`  — sources queued but still present afterward (a per-item error,
 *                 or the user chose "Skip" in the native collision dialog).
 */
export interface NativeMoveResult {
  aborted: boolean;
  moved: number;
  skipped: number;
  failed: number;
}

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
): Promise<NativeMoveResult> {
  const api = eAPI();
  if (!api.moveItemsNative) throw new Error("native move unavailable");
  return api.moveItemsNative(paths, destination);
}

/** CF_HDROP file list read off the clipboard (roadmap item #9). */
export interface ClipboardFiles {
  paths: string[];
  /** True when the source tagged the items as a Cut (paste should MOVE them). */
  preferMove: boolean;
}

/** True when the native shell COPY (for paste-copy / drag-in copy) is available. */
export function hasNativeCopy(): boolean {
  return typeof eAPI().copyItemsNative === "function";
}

/** True when native CF_HDROP clipboard read/write is available (Electron + addon). */
export function hasClipboardFiles(): boolean {
  const api = eAPI();
  return typeof api.clipboardReadFiles === "function" && typeof api.clipboardWriteFiles === "function";
}

/**
 * Copy items into a folder via the Windows shell (IFileOperation) — same guarded
 * engine + native dialogs as {@link moveItemsNative}. Throws if unavailable.
 */
export async function copyItemsNative(
  paths: string[],
  destination: string,
): Promise<NativeMoveResult> {
  const api = eAPI();
  if (!api.copyItemsNative) throw new Error("native copy unavailable");
  return api.copyItemsNative(paths, destination);
}

/**
 * Put files on the clipboard as CF_HDROP (`cut` ⇒ MOVE, else COPY). Resolves
 * true when a real file drop was written; false when it degraded to text (no
 * native addon) or there was nothing to write.
 */
export async function clipboardWriteFiles(paths: string[], cut: boolean): Promise<boolean> {
  const api = eAPI();
  if (!api.clipboardWriteFiles) {
    // Best-effort text fallback so something lands on the clipboard.
    if (api.copyFiles) await api.copyFiles(paths);
    return false;
  }
  return api.clipboardWriteFiles(paths, cut);
}

/** Read CF_HDROP paths (+ cut/copy intent) off the clipboard for paste-into-folder. */
export async function clipboardReadFiles(): Promise<ClipboardFiles> {
  const api = eAPI();
  if (!api.clipboardReadFiles) return { paths: [], preferMove: false };
  try {
    return await api.clipboardReadFiles();
  } catch {
    return { paths: [], preferMove: false };
  }
}

/** True when the native Recycle Bin restore (Phase 6 undo) is available. */
export function hasRecycleRestore(): boolean {
  return typeof eAPI().restoreFromRecycleBin === "function";
}

/**
 * Best-effort restore of a recycled item back to `originalPath` via the native
 * addon (it locates the item in the Recycle Bin and moves it back). Resolves
 * true on success, false when it couldn't be found / put back (caller tells the
 * user to restore manually) or when running outside Electron. Never throws.
 */
export async function restoreFromRecycleBin(originalPath: string): Promise<boolean> {
  const api = eAPI();
  if (!api.restoreFromRecycleBin) return false;
  try {
    return await api.restoreFromRecycleBin(originalPath);
  } catch {
    return false;
  }
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
    headers: mutateHeaders({ "Content-Type": "application/json" }),
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
    headers: mutateHeaders({ "Content-Type": "application/json" }),
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

// Export formats wired into the File menu (#8). csv/json/html/xml/xlsx download
// from the server; "pdf" is rendered by printing the HTML report (see
// `printReportAsPdf`) since the report doubles as the print-to-PDF source.
export type ExportFormat = "csv" | "json" | "html" | "xml" | "xlsx" | "pdf";

/** URL of the server export endpoint for a downloadable format. */
export function exportUrl(format: Exclude<ExportFormat, "pdf">, path: string): string {
  return `/api/export.${format}?path=${encodeURIComponent(path)}`;
}

/**
 * "Export as PDF" = print the HTML report (#8). We fetch the same self-contained
 * report the HTML export produces, drop it into a hidden, sandboxed iframe and
 * invoke print() — the user then picks "Save as PDF" (or Microsoft Print to PDF)
 * in the OS print dialog. This avoids bundling a heavyweight PDF engine while
 * still producing a real PDF from the exact report.
 */
export async function printReportAsPdf(path: string): Promise<void> {
  const res = await fetch(exportUrl("html", path));
  if (!res.ok) throw new Error(`export.html failed: ${res.status}`);
  const html = await res.text();
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);

  const iframe = document.createElement("iframe");
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  iframe.onload = () => {
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } finally {
      // Give the print dialog time to capture the document before teardown.
      window.setTimeout(() => {
        iframe.remove();
        URL.revokeObjectURL(url);
      }, 60_000);
    }
  };
  iframe.src = url;
  document.body.appendChild(iframe);
}

// ── Scheduled scans (#10) ─────────────────────────────────────────────────
// A UI wizard registers a Windows Scheduled Task that runs the FileTree CLI
// (`scan --path … --out … --format …`) on a daily/weekly cadence. Create/delete
// are POST + token-gated (they shell out to PowerShell); list is a read-only GET.

/** Export formats a scheduled task can emit (PDF is interactive-only, so omitted). */
export type ScheduleFormat = "csv" | "json" | "html" | "xml" | "xlsx";

export interface ScheduleCreateRequest {
  name: string;
  path: string;
  schedule: "daily" | "weekly";
  /** 24-hour HH:MM. */
  time: string;
  /** Weekday for weekly (e.g. "Mon"); ignored for daily. */
  day?: string;
  outDir: string;
  format: ScheduleFormat;
}

/** One FileTree scheduled task as reported by the server (Windows task info). */
export interface ScheduledTask {
  name: string;
  state: string;
  execute: string;
  arguments: string;
  nextRun: string;
  lastRun: string;
}

/** List FileTree-created scheduled tasks. Never throws — returns [] on failure. */
export async function listSchedules(): Promise<ScheduledTask[]> {
  const res = await fetch("/api/schedules");
  if (!res.ok) return [];
  try {
    return (await res.json()) as ScheduledTask[];
  } catch {
    return [];
  }
}

/** Register (or overwrite) a scheduled scan+export task. Returns the full task name. */
export async function createSchedule(req: ScheduleCreateRequest): Promise<string> {
  const res = await fetch("/api/schedule-create", {
    method: "POST",
    headers: mutateHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(await responseErrorText(res));
  try {
    return ((await res.json()) as { name?: string }).name ?? req.name;
  } catch {
    return req.name;
  }
}

/** Delete a FileTree scheduled task by its short name. */
export async function deleteSchedule(name: string): Promise<void> {
  const res = await fetch("/api/schedule-delete", {
    method: "POST",
    headers: mutateHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(await responseErrorText(res));
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

/**
 * Cancellable, time-bounded wrapper over fetchDupesV2. The underlying
 * /api/dupes-v2 walk + hash can be expensive, so this aborts it when the
 * external signal aborts (e.g. the chat Stop button) OR after `timeoutMs`, and
 * also tells the server to stop (/api/dupes-cancel) so a scan can never hang.
 * On cancel/timeout it resolves with an empty result carrying an explanatory
 * error rather than throwing; any other error is rethrown.
 */
export async function fetchDupesV2Bounded(
  opts: DupesV2Opts,
  external?: AbortSignal,
  timeoutMs = 90000,
): Promise<import("./types").DupesV2Result> {
  const inner = new AbortController();
  const onExternalAbort = () => inner.abort();
  const timer = setTimeout(() => inner.abort(), timeoutMs);
  if (external) {
    if (external.aborted) inner.abort();
    else external.addEventListener("abort", onExternalAbort);
  }
  try {
    return await fetchDupesV2(opts, inner.signal);
  } catch (e) {
    if (inner.signal.aborted) {
      await cancelDupesScan();
      return { mode: opts.mode, groups: [], errors: ["Duplicate scan canceled or timed out"], ignoredCount: 0 };
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (external) external.removeEventListener("abort", onExternalAbort);
  }
}

export interface DupeHashFile {
  path: string;
  size: number;
  mtime: number; // seconds since epoch
}

export interface DupeHashGroup {
  paths: string[];
}

export interface DupeHashResult {
  groups: DupeHashGroup[];
  errors: string[];
}

/**
 * Content-verify a client-aggregated candidate list. The server groups by size,
 * hashes (cached + parallel) only size-collision files, optionally byte-confirms,
 * and returns byte-identical path groups. No filesystem walk happens server-side.
 */
export async function fetchDupesHash(
  files: DupeHashFile[],
  confirmBytes = true,
  signal?: AbortSignal,
): Promise<DupeHashResult> {
  const body = JSON.stringify({ files, confirmBytes });
  const res = await fetch("/api/dupes-hash", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal,
  });
  if (!res.ok) {
    if (res.status === 499) return { groups: [], errors: ["Hashing canceled"] };
    return { groups: [], errors: [`HTTP ${res.status}`] };
  }
  return res.json() as Promise<DupeHashResult>;
}

export async function dupeAction(
  action: "delete" | "move" | "copy",
  paths: string[],
  opts: { permanent?: boolean; dest?: string },
): Promise<{ ok: boolean; errors: string[] }> {
  const body = JSON.stringify({ action, paths, permanent: opts.permanent ?? false, dest: opts.dest ?? "" });
  const res = await fetch("/api/dupes-action", { method: "POST", headers: mutateHeaders({ "Content-Type": "application/json" }), body });
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
