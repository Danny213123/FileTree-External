import type {
  NodeRecord,
  ScanResult,
  DriveList,
  DriveEntry,
  Config,
  ExactDuplicatesResult,
  SpecialFolderList,
  SnapshotMeta,
  SnapshotDiff,
  DiffResult,
  DiffRow,
  DiffStatus,
  CleanupScanResult,
  BulkRenameOp,
  BulkRenameResponse,
  TagEntry,
  SmartFolder,
  CompressResult,
  ExtractResult,
  ChecksumResult,
  CompressTools,
  CompressInstallResult,
  CompressJob,
  CompressJobRequest,
  CompressJobSummary,
  CompressJobFilesPage,
  CompressFilesQuery,
  CompressTelemetry,
  CompressEvent,
  CompressLogRow,
} from "./types";
import { isTauriV2, scanPage, toNodeRecord } from "./v2";
import { Channel, invoke } from "@tauri-apps/api/core";

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json() as Promise<T>;
}

/**
 * Running build's version string (from the server binary's CARGO_PKG_VERSION).
 * Never throws — returns "" on any failure so the title bar degrades gracefully.
 */
export async function fetchAppVersion(signal?: AbortSignal): Promise<string> {
  try {
    if (isTauriV2()) return (await invoke<{ version: string }>("app_version")).version;
    return (await getJson<{ version: string }>("/api/version", signal)).version;
  } catch {
    return "";
  }
}

/** Result shape returned by the Electron `mutate` IPC (token-authed POST). */
type MutateResponse = { ok: boolean; status: number; data: any };

/** safeStorage-backed secret store exposed by the Electron preload. */
interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

type ElectronAPI = {
  /**
   * Token-authenticated POST performed from the Electron MAIN process. Every
   * mutating/destructive API call routes through this so the per-session server
   * token (formerly `X-FileTree-Token`) never has to be exposed to the renderer.
   */
  mutate?: (route: string, body?: unknown) => Promise<MutateResponse>;
  /** safeStorage-backed secret storage for cloud AI provider keys. */
  secrets?: SecretStore;
  copyText?: (text: string) => Promise<void>;
  copyFiles?: (paths: string[]) => Promise<void>;
  clipboardWriteFiles?: (paths: string[], cut: boolean) => Promise<boolean>;
  clipboardReadFiles?: () => Promise<ClipboardFiles>;
  shellContextMenu?: (paths: string | string[], x: number, y: number) => Promise<void>;
  moveItemsNative?: (paths: string[], destination: string) => Promise<NativeMoveResult>;
  copyItemsNative?: (paths: string[], destination: string) => Promise<NativeMoveResult>;
  restoreFromRecycleBin?: (originalPath: string) => Promise<boolean>;
  /** Approval-gated network fetch performed in the Electron MAIN process. */
  webFetch?: (url: string, opts?: { maxBytes?: number }) => Promise<WebFetchResult>;
  /** Best-effort keyless web search (DuckDuckGo) performed in MAIN. */
  webSearch?: (query: string) => Promise<WebSearchResult>;
  /** Minimal MCP client (list/call) bridged through MAIN. */
  mcp?: {
    listTools: (server: unknown) => Promise<McpListResult>;
    callTool: (server: unknown, name: string, args: unknown) => Promise<McpCallResult>;
  };
  /** Show a native OS desktop notification from the MAIN process (F9). */
  notify?: (title: string, body: string) => Promise<boolean>;
};

export interface WebFetchResult {
  ok: boolean;
  status?: number;
  contentType?: string;
  text?: string;
  truncated?: boolean;
  url?: string;
  error?: string;
}

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}
export interface WebSearchResult {
  ok: boolean;
  answer?: string;
  results?: WebSearchResultItem[];
  error?: string;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** MCP tool annotations; `readOnlyHint:false` / `destructiveHint:true` ⇒ gate it. */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}
export interface McpListResult {
  ok: boolean;
  tools?: McpToolInfo[];
  error?: string;
}
export interface McpCallResult {
  ok: boolean;
  content?: string;
  isError?: boolean;
  error?: string;
}

const eAPI = (): ElectronAPI =>
  (window as unknown as { electronAPI?: ElectronAPI }).electronAPI ?? {};

/**
 * Perform a mutating request. Prefers the Electron `mutate` IPC, which attaches
 * the per-session token in the MAIN process; when it's unavailable (plain
 * browser dev) it falls back to the same POST + JSON body issued directly from
 * the renderer, without a token, so dev keeps working. Never reads a raw token.
 */
async function postMutation(route: string, body?: unknown): Promise<MutateResponse> {
  const mutate = eAPI().mutate;
  if (typeof mutate === "function") return mutate(route, body);
  const res = await fetch(route, {
    method: "POST",
    ...(body !== undefined
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  let data: unknown = null;
  const text = await res.text().catch(() => "");
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  return { ok: res.ok, status: res.status, data };
}

/** Best-effort human-readable error message from a {@link MutateResponse}. */
function mutateErrorText(r: MutateResponse): string {
  const d = r.data;
  if (typeof d === "string" && d) return d;
  if (d && typeof d === "object" && typeof (d as { error?: unknown }).error === "string") {
    return (d as { error: string }).error;
  }
  return `HTTP ${r.status}`;
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

// ── Lazy tree loading (>10M-node support) ───────────────────────────────────
// These back LAZY mode (see hooks/useScan LAZY_THRESHOLD): the renderer holds
// only the root and pulls each directory's children / searches / subtree files
// from the backend's already-cached scan, so it never materializes the whole
// tree. No-ops for normal scans, which keep the full in-memory tree.

/** Thrown by {@link fetchChildren} when the cached scan changed under us (409),
 *  so the caller can refetch the scan. */
export class ScanStaleError extends Error {
  constructor() {
    super("Scan changed since this reference");
    this.name = "ScanStaleError";
  }
}

/**
 * Load all children of one directory from the cached scan via GET /api/children,
 * following the server's paging (`hasMore`) until the directory is fully read.
 * Each returned node has `path` populated (server-side) and an empty
 * `children: []` (filled lazily when that child is itself expanded). The page is
 * a few thousand small JSON lines at most, so parsing one page's text is cheap.
 */
export async function fetchChildren(opts: {
  rootPath: string;
  scanId?: string;
  dirId: number;
  scannedAt?: number;
  sort?: string;
  dir?: "asc" | "desc";
  signal?: AbortSignal;
}): Promise<NodeRecord[]> {
  if (isTauriV2() && opts.scanId) {
    const out: NodeRecord[] = [];
    let offset = 0;
    // A single expansion is capped at the same sixteen pages as the renderer
    // LRU. Very wide folders remain bounded instead of recreating a giant map.
    for (let pageIndex = 0; pageIndex < 16; pageIndex++) {
      if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const page = await scanPage({
        scanId: opts.scanId,
        parentId: opts.dirId,
        offset,
        limit: 500,
        sort: opts.sort,
        direction: opts.dir,
      });
      out.push(...page.items.map(toNodeRecord));
      offset += page.items.length;
      if (!page.hasMore || page.items.length === 0) break;
    }
    return out;
  }
  const out: NodeRecord[] = [];
  let offset = 0;
  // Bound the page loop defensively so a misbehaving server can't spin forever.
  for (let guard = 0; guard < 100_000; guard++) {
    const params = new URLSearchParams({
      path: opts.rootPath,
      id: String(opts.dirId),
      offset: String(offset),
      limit: "50000",
    });
    if (opts.sort) params.set("sort", opts.sort);
    if (opts.dir) params.set("dir", opts.dir);
    if (opts.scannedAt) params.set("scannedAt", String(opts.scannedAt));
    const res = await fetch(`/api/children?${params}`, { signal: opts.signal });
    // A lazy result can outlive the server-side tree when another very large
    // tab wins cache eviction. Treat a missing scan/node exactly like a changed
    // scan so the workspace performs a fresh walk instead of showing a dead,
    // permanently-empty expanded folder.
    if (res.status === 404 || res.status === 409) throw new ScanStaleError();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    let hasMore = false;
    let pageCount = 0;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const obj = JSON.parse(trimmed) as { type?: string; hasMore?: boolean } & Record<string, unknown>;
      if (obj.type === "children") { hasMore = !!obj.hasMore; continue; }
      if (obj.type === "node") {
        const { type: _t, ...node } = obj;
        const rec = node as unknown as NodeRecord;
        rec.children = [];
        out.push(rec);
        pageCount++;
      }
    }
    offset += pageCount;
    if (!hasMore || pageCount === 0) break;
  }
  return out;
}

/**
 * Server-side BFS returning every descendant FILE path under a directory node in
 * the cached scan (GET /api/subtree-files). Used by the Compress-from-context
 * flow in lazy mode, where the renderer doesn't hold the whole subtree.
 */
export interface CompressionSourceFile {
  path: string;
  size: number;
}

/** A folder selection backed by the persisted scan index. Its file count and
 * aggregate size were computed during the scan, so opening Compression never
 * has to transfer every descendant path through the WebView. */
export interface CompressionScanDirectorySource {
  sourceType: "scan-directory";
  scanId: string;
  directoryId: number;
  path: string;
  name: string;
  size: number;
  fileCount: number;
}

export type CompressionSource = CompressionSourceFile | CompressionScanDirectorySource;

export async function fetchSubtreeFiles(opts: {
  rootPath: string;
  scanId?: string;
  dirId: number;
  signal?: AbortSignal;
}): Promise<CompressionSourceFile[]> {
  if (isTauriV2()) {
    if (!opts.scanId) throw new Error("The current scan has no v2 scan id");
    const files: CompressionSourceFile[] = [];
    let offset = 0;
    for (;;) {
      if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const page = await invoke<{
        items: CompressionSourceFile[];
        offset: number;
        limit: number;
        hasMore: boolean;
      }>("scan_subtree_files", {
        query: { scanId: opts.scanId, directoryId: opts.dirId, offset, limit: 5_000 },
      });
      files.push(...page.items);
      offset += page.items.length;
      if (!page.hasMore || page.items.length === 0) break;
    }
    return files;
  }
  const params = new URLSearchParams({ path: opts.rootPath, id: String(opts.dirId) });
  const res = await fetch(`/api/subtree-files?${params}`, { signal: opts.signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { paths?: string[] };
  return (data.paths ?? []).map((path) => ({ path, size: 0 }));
}

export interface CompressionCandidateStats {
  scanned: number;
  eligible: number;
  skippedUnavailable: number;
  skippedNoGain: number;
  skippedTooSmall: number;
}

interface CompressionCandidateBatch {
  items: CompressionSourceFile[];
  progress: CompressionCandidateStats;
}

/** Stream only files with an available, worthwhile compression pipeline. */
export async function streamCompressionCandidates(
  opts: {
    rootPath: string;
    scanId?: string;
    dirId: number;
    allowVideo: boolean;
    allowImage: boolean;
    minSizeBytes: number;
    signal?: AbortSignal;
  },
  onBatch: (files: CompressionSourceFile[], progress: CompressionCandidateStats) => void,
): Promise<CompressionCandidateStats> {
  if (isTauriV2()) {
    if (!opts.scanId) throw new Error("The current scan has no v2 scan id");
    const channel = new Channel<CompressionCandidateBatch>();
    channel.onmessage = (batch) => {
      if (!opts.signal?.aborted) onBatch(batch.items, batch.progress);
    };
    const stats = await invoke<CompressionCandidateStats>("scan_compression_candidates_stream", {
      scanId: opts.scanId,
      directoryId: opts.dirId,
      allowVideo: opts.allowVideo,
      allowImage: opts.allowImage,
      minSizeBytes: opts.minSizeBytes,
      onBatch: channel,
    });
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return stats;
  }
  const files = await fetchSubtreeFiles(opts);
  if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const eligible = files.filter((file) => file.size >= opts.minSizeBytes);
  const stats: CompressionCandidateStats = {
    scanned: files.length,
    eligible: eligible.length,
    skippedUnavailable: 0,
    skippedNoGain: 0,
    skippedTooSmall: files.length - eligible.length,
  };
  onBatch(eligible, stats);
  return stats;
}

/** Return the largest descendant file for a folder hover without loading its
 * complete subtree into the renderer. */
export async function fetchFolderPreview(opts: {
  scanId: string;
  dirId: number;
}): Promise<CompressionSourceFile | null> {
  if (!isTauriV2()) return null;
  return invoke<CompressionSourceFile | null>("scan_folder_preview", {
    scanId: opts.scanId,
    directoryId: opts.dirId,
  });
}

export interface ServerSearchResult {
  matches: NodeRecord[];
  total: number;
  capped: boolean;
}

/**
 * Server-side search over the cached scan (GET /api/search), used in lazy mode
 * where the renderer can't iterate every node. Mirrors searchNodesAdvanced:
 * case-insensitive name/path match plus optional size/date/type/ext filters.
 */
export async function fetchServerSearch(opts: {
  rootPath: string;
  scanId?: string;
  query: string;
  regex?: boolean;
  minSize?: number;
  maxSize?: number;
  modifiedAfter?: number;
  modifiedBefore?: number;
  ext?: string;
  category?: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<ServerSearchResult> {
  if (isTauriV2() && opts.scanId) {
    // One bounded query per edit. Tauri invokes cannot be cancelled once SQLite
    // has started, so issuing four sequential pages caused old keystrokes to
    // pile up and made the desktop appear to crash on large scans.
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const wanted = Math.min(500, Math.max(1, opts.limit ?? 500));
    const page = await scanPage({
      scanId: opts.scanId,
      parentId: null,
      offset: 0,
      limit: wanted,
      search: opts.query,
      regex: opts.regex,
      minSize: opts.minSize,
      maxSize: opts.maxSize,
      modifiedAfter: opts.modifiedAfter,
      modifiedBefore: opts.modifiedBefore,
      ext: opts.ext,
      category: opts.category,
      // Live search only needs to know whether another result page exists.
      // Avoid a separate full COUNT(*) pass over a multi-million-row scan.
      countTotal: false,
    });
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const matches = page.items.map(toNodeRecord);
    return { matches, total: page.total, capped: matches.length < page.total };
  }
  const params = new URLSearchParams({ path: opts.rootPath });
  if (opts.query) params.set("q", opts.query);
  if (opts.regex) params.set("regex", "1");
  if (opts.minSize != null) params.set("minSize", String(opts.minSize));
  if (opts.maxSize != null) params.set("maxSize", String(opts.maxSize));
  if (opts.modifiedAfter != null) params.set("modifiedAfter", String(opts.modifiedAfter));
  if (opts.modifiedBefore != null) params.set("modifiedBefore", String(opts.modifiedBefore));
  if (opts.ext) params.set("ext", opts.ext);
  if (opts.category && opts.category !== "any") params.set("category", opts.category);
  if (opts.limit != null) params.set("limit", String(opts.limit));
  const res = await fetch(`/api/search?${params}`, { signal: opts.signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { matches?: NodeRecord[]; total?: number; capped?: boolean };
  const matches = (data.matches ?? []).map((n) => ({ ...n, children: n.children ?? [] }));
  return { matches, total: data.total ?? matches.length, capped: !!data.capped };
}

export async function fetchDrives(): Promise<DriveList> {
  if (isTauriV2()) return invoke<DriveList>("drives");
  return getJson<DriveList>("/api/drives");
}

/** Capacity and geometry of one volume, for a scan tab's footer. */
export interface VolumeInfo {
  path: string;
  /** "NTFS", "exFAT", …; "" when the platform wouldn't say. */
  filesystem: string;
  /** 0 when the volume's capacity couldn't be queried. */
  totalBytes: number;
  freeBytes: number;
  /** Allocation unit size; 0 when unavailable. */
  bytesPerCluster: number;
}

/** Never throws: the footer degrades to scan-only figures when this fails. */
export async function fetchVolumeInfo(path: string): Promise<VolumeInfo | null> {
  if (!isTauriV2()) return null;
  try {
    return await invoke<VolumeInfo>("volume_info", { path });
  } catch {
    return null;
  }
}

export async function fetchSpecialFolders(): Promise<SpecialFolderList> {
  if (isTauriV2()) return invoke<SpecialFolderList>("special_folders");
  return getJson<SpecialFolderList>("/api/special-folders");
}

export async function fetchConfig(): Promise<Config> {
  if (isTauriV2()) return invoke<Config>("app_config");
  return getJson<Config>("/api/config");
}

/** One immediate subfolder from {@link browseDirectories}. */
export interface BrowseDirectoryEntry {
  name: string;
  path: string;
  hidden: boolean;
}

/**
 * Immediate subfolders of `path`, name-sorted, for the folder pickers (duplicate
 * scan targets, move/copy destinations). Unlike the `directory_snapshot`
 * command this works on any folder — a picker has to walk down from a drive
 * letter before anything has been scanned. Browser/server builds have no route
 * route, so they degrade to a non-expandable list rather than throwing.
 */
export async function browseDirectories(path: string): Promise<BrowseDirectoryEntry[]> {
  if (!isTauriV2()) return [];
  return invoke<BrowseDirectoryEntry[]>("browse_directories", { path });
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
  if (isTauriV2()) {
    await invoke("reveal_path", { path });
    return;
  }
  await postMutation("/api/reveal", { path });
}

export async function openPath(path: string): Promise<void> {
  if (isTauriV2()) {
    await invoke("open_path", { path });
    return;
  }
  await postMutation("/api/open", { path });
}

/** Ask the backend to terminate the app (routed through the token-authed IPC). */
export async function exitApp(): Promise<void> {
  if (isTauriV2()) {
    await invoke("app_exit");
    return;
  }
  await postMutation("/api/exit");
}

export async function deletePath(
  path: string,
  permanent = false,
): Promise<{ ok: boolean; error?: string }> {
  const r = await postMutation("/api/delete", { path, permanent });
  if (r.ok) return { ok: true };
  return { ok: false, error: mutateErrorText(r) };
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
  const r = await postMutation("/api/run-command", {
    command,
    ...(cwd ? { cwd } : {}),
    ...(opts?.shell ? { shell: opts.shell } : {}),
    ...(opts?.timeoutMs != null ? { timeout_ms: opts.timeoutMs } : {}),
  });
  if (!r.ok) return { ok: false, error: mutateErrorText(r) };
  if (r.data && typeof r.data === "object") return r.data as RunCommandResult;
  return { ok: false, error: "Invalid response from run-command" };
}

export async function moveItem(src: string, dst: string): Promise<{ ok: boolean; error?: string }> {
  const r = await postMutation("/api/move", { src, dst });
  if (r.ok) return { ok: true };
  return { ok: false, error: mutateErrorText(r) };
}

export async function openProperties(path: string): Promise<void> {
  await postMutation("/api/properties", { path });
}

export async function createFolder(path: string): Promise<void> {
  const r = await postMutation("/api/mkdir", { path });
  if (!r.ok) throw new Error(mutateErrorText(r));
}

export async function fetchBookmarks(): Promise<string[]> {
  if (isTauriV2()) return invoke<string[]>("bookmarks_get");
  const res = await fetch("/api/bookmarks");
  if (!res.ok) return [];
  try { return await res.json() as string[]; } catch { return []; }
}

export async function saveBookmarks(paths: string[]): Promise<void> {
  if (isTauriV2()) {
    await invoke("bookmarks_set", { paths });
    return;
  }
  await postMutation("/api/bookmarks", paths);
}

// ── Settings ─────────────────────────────────────────────────

export interface AppTabSettings {
  metric?: string;
  unit?: string;
  showFiles?: boolean;
  sortKey?: string;
  sortDir?: 1 | -1;
  columnWidths?: Record<string, number>;
}

export interface AppSettings {
  /** Monotonic wall-clock marker used to prefer the close-time shadow if the
   *  process exited before the asynchronous SQLite write completed. */
  sessionSavedAt?: number;
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
  /** Per-tab view state parallel to `openTabs`. */
  tabState?: AppTabSettings[];
  /** Per-tab metadata parallel to `openTabs` by index (#49): custom label,
   *  color label, and pinned state. */
  tabMeta?: { label?: string; color?: string; pinned?: boolean }[];
  recentPaths?: string[];
  // Details-list columns (global, shared by all tabs/panes)
  visibleColumns?: string[];
  decimals?: number;
  // Split-pane layout: each group references tab indices into openTabs.
  paneGroups?: { tabs: number[]; active: number; width?: number; toolbarHidden?: boolean }[];
  focusedGroupIndex?: number;
  // VS Code workbench layout
  activeView?: string;
  sidebarOpen?: boolean;
  sidebarWidth?: number;
  panelOpen?: boolean;
  panelHeight?: number;
  chatOpen?: boolean;
  chatWidth?: number;
  chatSessionId?: string;
  terminalOpen?: boolean;
  terminalHeight?: number;
  terminalCwd?: string;
  // Inspector (right-side Details/Preview panes)
  previewOpen?: boolean;
  detailsOpen?: boolean;
  inspectorWidth?: number;
  // Treemap presentation. The transient 3D modal itself is intentionally not
  // restored; its host panel and stable display preferences are.
  treemapDetail?: number;
  tmShowSingleFiles?: boolean;
  tmShowHierarchy?: boolean;
  tmShowLegend?: boolean;
  tmShowLabels?: boolean;
  tmDragDrop?: boolean;
  // Low-space monitor (F9): alert when a drive's free space drops below this
  // percentage. `lowSpaceAlerts` toggles the monitor on/off.
  lowSpaceThreshold?: number;
  lowSpaceAlerts?: boolean;
}

export async function fetchSettings(): Promise<AppSettings> {
  if (isTauriV2()) return invoke<AppSettings>("app_settings_get");
  const res = await fetch("/api/settings");
  if (!res.ok) return {};
  try { return await res.json() as AppSettings; } catch { return {}; }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  if (isTauriV2()) {
    await invoke("app_settings_set", { settings });
    return;
  }
  await postMutation("/api/settings", settings);
}

export async function setCompressionPresence(state: {
  enabled: boolean;
  active: boolean;
  status: string;
  progress: number;
}): Promise<void> {
  if (!isTauriV2()) {
    const legacy = (window as unknown as {
      electronAPI?: { setCompressionState?: (value: typeof state) => void };
    }).electronAPI?.setCompressionState;
    legacy?.(state);
    return;
  }
  await invoke("compression_presence", state);
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

// ── Web fetch / search (Electron MAIN IPC; approval-gated in the agent) ──────
// The renderer's CSP is connect-src 'self', so all outbound network requests are
// performed in the Electron MAIN process. In plain-browser dev these degrade to
// a direct fetch (usually CORS-blocked), returning an error the model can read.

export async function webFetch(url: string, opts?: { maxBytes?: number }): Promise<WebFetchResult> {
  const api = eAPI();
  if (typeof api.webFetch === "function") return api.webFetch(url, opts);
  try {
    const res = await fetch(url);
    const text = await res.text();
    const max = opts?.maxBytes ?? 64 * 1024;
    const truncated = text.length > max;
    return { ok: res.ok, status: res.status, text: truncated ? text.slice(0, max) : text, truncated, url };
  } catch (e) {
    return { ok: false, error: (e as Error).message, url };
  }
}

export async function webSearch(query: string): Promise<WebSearchResult> {
  const api = eAPI();
  if (typeof api.webSearch === "function") return api.webSearch(query);
  return { ok: false, error: "Web search requires the FileTree desktop app." };
}

// ── MCP client bridge (Electron MAIN performs the JSON-RPC) ──────────────────
export async function mcpListTools(server: unknown): Promise<McpListResult> {
  const api = eAPI();
  if (!api.mcp) return { ok: false, error: "MCP requires the FileTree desktop app." };
  try { return await api.mcp.listTools(server); }
  catch (e) { return { ok: false, error: (e as Error).message }; }
}

export async function mcpCallTool(server: unknown, name: string, args: unknown): Promise<McpCallResult> {
  const api = eAPI();
  if (!api.mcp) return { ok: false, error: "MCP requires the FileTree desktop app." };
  try { return await api.mcp.callTool(server, name, args); }
  catch (e) { return { ok: false, error: (e as Error).message }; }
}

// ── Scan snapshots + growth diff (F2) ────────────────────────
// All four operations target the NEW compact folder→size snapshot store
// (`src/snapshots.rs`): GET /api/snapshots (list, bare array),
// POST /api/snapshots-save, GET /api/snapshots-diff?a=&b= and
// POST /api/snapshots-delete. The legacy singular `/api/snapshot-*` routes (the
// older `crate::diff` NDJSON store) are intentionally no longer used here.

/** List saved snapshots (newest first). Never throws — returns [] on failure. */
export async function fetchSnapshots(): Promise<SnapshotMeta[]> {
  const res = await fetch("/api/snapshots");
  if (!res.ok) return [];
  try {
    // GET /api/snapshots returns a bare array; tolerate a {snapshots:[…]} wrap.
    const data = (await res.json()) as SnapshotMeta[] | { snapshots?: SnapshotMeta[] };
    if (Array.isArray(data)) return data;
    return data.snapshots ?? [];
  } catch { return []; }
}

/**
 * Save the server's current scan of `path` as a new snapshot via
 * POST /api/snapshots-save. The server reads the freshly-scanned tree from its
 * own cache (no large client upload); the response is just the saved meta, so
 * we re-fetch the manifest and return the updated list (newest first).
 */
export async function saveSnapshot(path: string): Promise<SnapshotMeta[]> {
  const r = await postMutation("/api/snapshots-save", { path });
  if (!r.ok) throw new Error(mutateErrorText(r));
  return fetchSnapshots();
}

/**
 * Load one saved snapshot's full data (meta + its absolute-dir→size map) via
 * GET /api/snapshots-get?id=. Used by the Explorer "what changed since last
 * snapshot" badges (#39). Never throws — returns null on any failure.
 */
export async function fetchSnapshotData(
  id: string,
  signal?: AbortSignal,
): Promise<import("./types").SnapshotData | null> {
  try {
    const res = await fetch(`/api/snapshots-get?id=${encodeURIComponent(id)}`, { signal });
    if (!res.ok) return null;
    return (await res.json()) as import("./types").SnapshotData;
  } catch {
    return null;
  }
}

/** Delete a saved snapshot by id; returns the updated list (newest first). */
export async function deleteSnapshot(id: string): Promise<SnapshotMeta[]> {
  await postMutation("/api/snapshots-delete", { id });
  return fetchSnapshots();
}

const SNAP_DIFF_CAP = 1000; // mirrors snapshots::DIFF_CAP (per-bucket cap)

function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

/**
 * Diff two saved snapshots (`b` minus `a`) over their folder size maps. Adapts
 * the raw GET /api/snapshots-diff response into the client view model the diff
 * views render: `added`/`removed` pass through; each `changed` entry becomes a
 * "grown"/"shrunk" row by the sign of its delta. The net/total figures come
 * from the two snapshot metas (the diff endpoint only returns folder deltas).
 */
export async function fetchSnapshotDiff(
  a: SnapshotMeta,
  b: SnapshotMeta,
  signal?: AbortSignal,
): Promise<DiffResult> {
  const params = new URLSearchParams({ a: a.id, b: b.id });
  const raw = await getJson<SnapshotDiff>(`/api/snapshots-diff?${params}`, signal);
  const added = raw.added ?? [];
  const removed = raw.removed ?? [];
  const changed = raw.changed ?? [];

  const rows: DiffRow[] = [];
  for (const e of added) {
    rows.push({ path: e.path, name: baseName(e.path), status: "added", oldSize: 0, newSize: e.size, delta: e.size, dir: true });
  }
  for (const e of removed) {
    rows.push({ path: e.path, name: baseName(e.path), status: "removed", oldSize: e.size, newSize: 0, delta: -e.size, dir: true });
  }
  let grown = 0;
  let shrunk = 0;
  for (const e of changed) {
    const status: DiffStatus = e.delta >= 0 ? "grown" : "shrunk";
    if (e.delta >= 0) grown++; else shrunk++;
    rows.push({ path: e.path, name: baseName(e.path), status, oldSize: e.sizeA, newSize: e.sizeB, delta: e.delta, dir: true });
  }

  return {
    a,
    b,
    rows,
    summary: {
      added: added.length,
      removed: removed.length,
      grown,
      shrunk,
      oldTotal: a.total,
      newTotal: b.total,
      netDelta: b.total - a.total,
      rowCount: rows.length,
      capped:
        added.length >= SNAP_DIFF_CAP ||
        removed.length >= SNAP_DIFF_CAP ||
        changed.length >= SNAP_DIFF_CAP,
    },
  };
}

// ── Disk Cleanup / Reclaim Space assistant (roadmap #1) ───────────────────
// A read-only scan buckets reclaimable space by category (temp, caches, build
// artifacts, recycle bin, old large downloads, confirmed duplicate sets) for a
// scan root; the user then multi-selects and moves the selection to the Recycle
// Bin. The recycle call routes through the token-authed mutate IPC like delete.

/** Bucket reclaimable space under `path` by category. Throws on a non-200. */
export async function fetchCleanupScan(
  path: string,
  signal?: AbortSignal,
): Promise<CleanupScanResult> {
  const params = new URLSearchParams({ path });
  return getJson<CleanupScanResult>(`/api/cleanup-scan?${params}`, signal);
}

/** Move the given paths to the Recycle Bin (safe, restorable delete). */
export async function recycleItems(paths: string[]): Promise<{ ok: boolean; error?: string }> {
  const r = await postMutation("/api/recycle-items", { paths });
  if (r.ok) return { ok: true };
  return { ok: false, error: mutateErrorText(r) };
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

/** True when the desktop runtime can use Windows' native file-operation UI. */
export function hasNativeMove(): boolean {
  return isTauriV2() || typeof eAPI().moveItemsNative === "function";
}

/**
 * Move items into a folder using the Windows shell (IFileOperation), which shows
 * the real native dialogs (progress, Replace/Skip/Keep both, "source and
 * destination file names are the same", elevation). Throws if unavailable.
 */
export async function moveItemsNative(
  paths: string[],
  destination: string,
  provenance?: string,
): Promise<NativeMoveResult> {
  if (isTauriV2()) {
    return invoke<NativeMoveResult>("native_move_items", { paths, destination, provenance });
  }
  const api = eAPI();
  if (!api.moveItemsNative) throw new Error("native move unavailable");
  return api.moveItemsNative(paths, destination);
}

/** CF_HDROP file list read off the clipboard (roadmap item #9). */
export interface ClipboardFiles {
  paths: string[];
  /** True when the source tagged the items as a Cut (paste should MOVE them). */
  preferMove: boolean;
  /** One-shot Tauri capability binding outside-root paths to this OS clipboard read. */
  provenance?: string;
}

/** True when the native shell COPY (for paste-copy / drag-in copy) is available. */
export function hasNativeCopy(): boolean {
  return isTauriV2() || typeof eAPI().copyItemsNative === "function";
}

/** True when native CF_HDROP clipboard read/write is available. */
export function hasClipboardFiles(): boolean {
  if (isTauriV2()) return true;
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
  provenance?: string,
): Promise<NativeMoveResult> {
  if (isTauriV2()) {
    return invoke<NativeMoveResult>("native_copy_items", { paths, destination, provenance });
  }
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
  if (isTauriV2()) {
    return invoke<boolean>("clipboard_write_files", { paths, cut });
  }
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
  if (isTauriV2()) {
    return invoke<ClipboardFiles>("clipboard_read_files");
  }
  const api = eAPI();
  if (!api.clipboardReadFiles) return { paths: [], preferMove: false };
  try {
    return await api.clipboardReadFiles();
  } catch {
    return { paths: [], preferMove: false };
  }
}

/** Claim the one-shot capability created by a native Tauri file-drop event. */
export async function claimExternalPaths(paths: string[]): Promise<string | undefined> {
  if (!isTauriV2()) return undefined;
  return invoke<string>("claim_external_paths", { paths });
}

/** Revoke an unused outside-root capability after a canceled paste/drop. */
export async function releaseExternalPaths(provenance?: string): Promise<void> {
  if (!isTauriV2() || !provenance) return;
  await invoke<void>("release_external_paths", { provenance });
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
  const r = await postMutation("/api/rename", { path, newName });
  if (r.ok) return { ok: true };
  return { ok: false, error: mutateErrorText(r) };
}

// ── Batch attributes + timestamps (#43) ──────────────────────────────────────
// Both routes modify only the metadata of existing paths (gated to a scanned
// root + audited server-side) and echo a per-path result so the dialog can
// surface partial failures. Omitted fields are left unchanged.

/** Per-path outcome echoed by /api/set-attributes and /api/set-times. */
export interface MetadataResultItem {
  path: string;
  ok: boolean;
  error?: string;
}
export interface MetadataResult {
  /** True when every path succeeded. */
  ok: boolean;
  results: MetadataResultItem[];
  /** Joined per-path errors, if any. */
  error?: string;
}

function adaptMetadataResult(r: MutateResponse): MetadataResult {
  if (!r.ok) return { ok: false, results: [], error: mutateErrorText(r) };
  const data = (r.data ?? {}) as { results?: MetadataResultItem[] };
  const results = data.results ?? [];
  const failed = results.filter((x) => !x.ok);
  return {
    ok: failed.length === 0,
    results,
    error: failed.length > 0
      ? failed.map((x) => `${x.path}: ${x.error ?? "failed"}`).join("; ")
      : undefined,
  };
}

/**
 * Set/clear the read-only and/or hidden attribute on each path. Pass `undefined`
 * (or omit) to leave an attribute unchanged.
 */
export async function setAttributes(
  paths: string[],
  attrs: { readonly?: boolean; hidden?: boolean },
): Promise<MetadataResult> {
  const body: Record<string, unknown> = { paths };
  if (attrs.readonly !== undefined) body.readonly = attrs.readonly;
  if (attrs.hidden !== undefined) body.hidden = attrs.hidden;
  return adaptMetadataResult(await postMutation("/api/set-attributes", body));
}

/**
 * Set the created / modified / accessed times (epoch milliseconds) on each path.
 * Omit a field to leave that timestamp unchanged.
 */
export async function setTimes(
  paths: string[],
  times: { created?: number; modified?: number; accessed?: number },
): Promise<MetadataResult> {
  const body: Record<string, unknown> = { paths };
  if (times.created !== undefined) body.created = times.created;
  if (times.modified !== undefined) body.modified = times.modified;
  if (times.accessed !== undefined) body.accessed = times.accessed;
  return adaptMetadataResult(await postMutation("/api/set-times", body));
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
  if (isTauriV2()) {
    try {
      const result = await invoke<MoveItemsResult>("move_items", {
        paths,
        destination,
        conflict: conflict ?? null,
      });
      const errors = result.errors ?? [];
      return {
        ...empty,
        ...result,
        errors,
        error: result.error ?? (errors.length > 0 ? errors.join("; ") : undefined),
      };
    } catch (error) {
      return { ...empty, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const r = await postMutation(
    "/api/move-items",
    conflict ? { paths, destination, conflict } : { paths, destination },
  );
  if (!r.ok) {
    return { ...empty, error: mutateErrorText(r) };
  }
  const j = (r.data ?? {}) as Partial<MoveItemsResult>;
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
}

export async function copyFiles(paths: string[]): Promise<void> {
  if (isTauriV2()) {
    await invoke<boolean>("clipboard_write_files", { paths, cut: false });
  } else if (eAPI().copyFiles) {
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

const NATIVE_CONTEXT_MENU_CLASS = "native-context-menu-open";
let activeNativeContextMenus = 0;

function setNativeContextMenuOpen(open: boolean): void {
  activeNativeContextMenus = Math.max(0, activeNativeContextMenus + (open ? 1 : -1));
  if (typeof document !== "undefined") {
    document.documentElement.classList.toggle(
      NATIVE_CONTEXT_MENU_CLASS,
      activeNativeContextMenus > 0,
    );
  }
}

export interface ShellContextMenuOptions {
  /** Return Paste to the caller instead of invoking it in the native worker. */
  deferPaste?: boolean;
}

function shellMenuParentKey(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const separator = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return (separator < 0 ? "" : trimmed.slice(0, separator))
    .replace(/\//g, "\\")
    .toLowerCase();
}

export async function shellContextMenu(
  paths: string | string[],
  x: number,
  y: number,
  options: ShellContextMenuOptions = {},
): Promise<string | null> {
  const requestedTargets = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  if (requestedTargets.length === 0) return null;
  // IShellFolder menus only support siblings. Match the native fallback before
  // dispatch so deferred Copy/Cut cannot act on paths omitted from the menu.
  const firstParent = shellMenuParentKey(requestedTargets[0]);
  const targets = requestedTargets.every((path) => shellMenuParentKey(path) === firstParent)
    ? requestedTargets
    : [requestedTargets[0]];
  setNativeContextMenuOpen(true);
  try {
    if (isTauriV2()) {
      const verb = await invoke<string | null>("shell_context_menu", {
        paths: targets,
        clientX: Math.round(x),
        clientY: Math.round(y),
        deferPaste: options.deferPaste === true,
      });
      // The native menu intentionally defers Copy/Cut: shell clipboard data can
      // be tied to its short-lived STA worker. Write a concrete CF_HDROP through
      // FileTree's persistent clipboard command, matching Ctrl+C/Ctrl+X.
      if (verb?.toLowerCase() === "copy" || verb?.toLowerCase() === "cut") {
        const written = await clipboardWriteFiles(targets, verb.toLowerCase() === "cut");
        if (!written) throw new Error("The desktop file clipboard is unavailable.");
      }
      return verb;
    }
    if (eAPI().shellContextMenu) {
      await eAPI().shellContextMenu!(targets, x, y);
    } else {
      const first = targets[0];
      const params = new URLSearchParams({ path: first, x: String(Math.round(x)), y: String(Math.round(y)) });
      await fetch(`/api/shell-context-menu?${params}`);
    }
    return null;
  } finally {
    setNativeContextMenuOpen(false);
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
  // Sandbox the server-rendered report so a crafted file name embedded in it can
  // never execute script or navigate the top frame. We grant only the two tokens
  // this hidden frame actually needs: `allow-same-origin` (so the parent can read
  // `contentWindow` to drive printing — a blob URL is same-origin) and
  // `allow-modals` (so the `print()` call below isn't suppressed). Notably absent:
  // `allow-scripts`, `allow-top-navigation`, `allow-forms`, `allow-popups`.
  iframe.setAttribute("sandbox", "allow-same-origin allow-modals");
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
  const r = await postMutation("/api/schedule-create", req);
  if (!r.ok) throw new Error(mutateErrorText(r));
  return (r.data as { name?: string } | null)?.name ?? req.name;
}

/** Delete a FileTree scheduled task by its short name. */
export async function deleteSchedule(name: string): Promise<void> {
  const r = await postMutation("/api/schedule-delete", { name });
  if (!r.ok) throw new Error(mutateErrorText(r));
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

export interface DupeActionItem {
  path: string;
  keeper: string;
}

export interface DupeActionResult {
  ok: boolean;
  errors: string[];
  succeeded: string[];
  requiresRescan?: boolean;
}

export async function dupeAction(
  action: "delete" | "move" | "copy",
  paths: string[],
  opts: {
    permanent?: boolean;
    dest?: string;
    protectedPaths?: string[];
    items?: DupeActionItem[];
    reviewToken?: string;
  },
): Promise<DupeActionResult> {
  if (isTauriV2()) {
    if (!opts.items || opts.items.length !== paths.length || !opts.reviewToken) {
      return { ok: false, errors: ["Duplicate action plan is incomplete; run the scan again."], succeeded: [] };
    }
    const errors: string[] = [];
    const succeeded: string[] = [];
    let requiresRescan = false;
    for (let offset = 0; offset < opts.items.length; offset += 1_000) {
      try {
        const result = await invoke<DupeActionResult>("duplicates_action", {
          reviewToken: opts.reviewToken,
          action,
          items: opts.items.slice(offset, offset + 1_000),
          permanent: opts.permanent ?? false,
          destination: opts.dest ?? null,
        });
        if (!result || !Array.isArray(result.errors) || !Array.isArray(result.succeeded)) {
          throw new Error("Invalid duplicate action response");
        }
        errors.push(...(result.errors ?? []));
        succeeded.push(...(result.succeeded ?? []));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        requiresRescan = true;
        break;
      }
    }
    return {
      ok: errors.length === 0,
      errors,
      succeeded,
      ...(requiresRescan ? { requiresRescan: true } : {}),
    };
  }
  const r = await postMutation("/api/dupes-action", {
    action,
    paths,
    permanent: opts.permanent ?? false,
    dest: opts.dest ?? "",
    protectedPaths: opts.protectedPaths ?? [],
    items: opts.items ?? [],
    reviewToken: opts.reviewToken ?? "",
  });
  if (!r.ok) return { ok: false, errors: [mutateErrorText(r)], succeeded: [], requiresRescan: true };
  const data = r.data as { ok?: boolean; errors?: string[]; succeeded?: string[] } | null;
  if (!data) return { ok: false, errors: ["Invalid response"], succeeded: [], requiresRescan: true };
  return {
    ok: data.ok ?? false,
    errors: data.errors ?? [],
    succeeded: data.succeeded ?? (data.ok ? paths : []),
    requiresRescan: !data.ok && !Array.isArray(data.succeeded),
  };
}

/**
 * #26: replace checked duplicate copies with a hard link (same volume) or a
 * symbolic link to the kept original. Each pair is `{original, link}` where
 * `original` is the kept reference and `link` is the duplicate path to replace.
 * The server recycles the duplicate (recoverable) and moves a fresh link into
 * its place. Returns `{ok, errors}` like {@link dupeAction}.
 */
export async function hardlinkPairs(
  pairs: { original: string; link: string }[],
  mode: "hardlink" | "symlink",
  protectedPaths: string[] = [],
  reviewToken?: string,
  permanent = false,
): Promise<DupeActionResult> {
  if (isTauriV2()) {
    if (!reviewToken) {
      return { ok: false, errors: ["Duplicate action plan is incomplete; run the scan again."], succeeded: [] };
    }
    const errors: string[] = [];
    const succeeded: string[] = [];
    let requiresRescan = false;
    for (let offset = 0; offset < pairs.length; offset += 1_000) {
      try {
        const result = await invoke<DupeActionResult>("duplicates_link", {
          reviewToken,
          pairs: pairs.slice(offset, offset + 1_000),
          mode,
          permanent,
        });
        if (!result || !Array.isArray(result.errors) || !Array.isArray(result.succeeded)) {
          throw new Error("Invalid duplicate link response");
        }
        errors.push(...(result.errors ?? []));
        succeeded.push(...(result.succeeded ?? []));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        requiresRescan = true;
        break;
      }
    }
    return {
      ok: errors.length === 0,
      errors,
      succeeded,
      ...(requiresRescan ? { requiresRescan: true } : {}),
    };
  }
  const r = await postMutation("/api/hardlink", {
    mode,
    pairs,
    protectedPaths,
    reviewToken: reviewToken ?? "",
    permanent,
  });
  if (!r.ok) return { ok: false, errors: [mutateErrorText(r)], succeeded: [], requiresRescan: true };
  const d = (r.data ?? {}) as { ok?: boolean; errors?: string[]; succeeded?: string[] };
  return {
    ok: d.ok ?? false,
    errors: d.errors ?? [],
    succeeded: d.succeeded ?? (d.ok ? pairs.map((pair) => pair.link) : []),
    requiresRescan: !d.ok && !Array.isArray(d.succeeded),
  };
}

/** One item FileTree recycled, as recorded in the audit log (#30). */
export interface RecycledItem {
  /** ISO-8601 UTC timestamp the item was recycled. */
  ts: string;
  /** Original absolute path before it was sent to the Recycle Bin. */
  path: string;
}

/**
 * #30: list items FileTree itself sent to the Recycle Bin (parsed from the
 * append-only audit log, newest-first). Never throws — returns [] on failure.
 * Full system Recycle Bin enumeration is intentionally NOT done here (see the
 * Recycle Bin viewer notes); restore reuses the native Recycle Bin restore.
 */
export async function fetchRecycledLog(signal?: AbortSignal): Promise<RecycledItem[]> {
  try {
    const res = await fetch("/api/audit-recycled", { signal });
    if (!res.ok) return [];
    const data = (await res.json()) as { items?: RecycledItem[] };
    return data.items ?? [];
  } catch {
    return [];
  }
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
  if (isTauriV2()) return { ok: true, count: 0 };
  const body = JSON.stringify({ a, b });
  const res = await fetch("/api/dupes-ignore", { method: "POST", headers: { "Content-Type": "application/json" }, body });
  if (!res.ok) return { ok: false, count: 0 };
  return res.json() as Promise<{ ok: boolean; count: number }>;
}

export async function dupeClearIgnoreList(): Promise<{ ok: boolean }> {
  if (isTauriV2()) return { ok: true };
  const res = await fetch("/api/dupes-ignore", { method: "DELETE" });
  if (!res.ok) return { ok: false };
  return res.json() as Promise<{ ok: boolean }>;
}

// ── Bulk rename (F3) ─────────────────────────────────────────────────────────
// POST a batch of {from,to} renames; the server applies them in order and echoes
// a per-op result so the UI can surface partial failures. Routed through the
// token-authed mutate IPC like rename/move. Degrades gracefully: a missing/404
// endpoint (backend not yet landed) yields a synthesized all-failed result so
// the dialog reports it instead of throwing.
export async function bulkRename(ops: BulkRenameOp[]): Promise<BulkRenameResponse> {
  const r = await postMutation("/api/bulk-rename", { ops });
  if (!r.ok) {
    const msg = mutateErrorText(r);
    return { results: ops.map((o) => ({ from: o.from, to: o.to, ok: false, error: msg })) };
  }
  const data = (r.data ?? {}) as Partial<BulkRenameResponse>;
  // Tolerate a server that returns nothing useful: treat as all-OK only when it
  // explicitly says so; otherwise echo an empty list the caller can detect.
  return { results: data.results ?? [] };
}

// ── Tags & color labels (F4) ──────────────────────────────────────────────────
// Persisted exactly like bookmarks: a read-only GET plus a full-list-replace
// POST routed through the token-authed mutate IPC. Never throws — a missing
// endpoint yields an empty list so the feature degrades to "no tags yet".
export async function fetchTags(): Promise<TagEntry[]> {
  const res = await fetch("/api/tags");
  if (!res.ok) return [];
  try {
    const data = (await res.json()) as { items?: TagEntry[] } | TagEntry[];
    if (Array.isArray(data)) return data;
    return data.items ?? [];
  } catch {
    return [];
  }
}

export async function saveTags(items: TagEntry[]): Promise<void> {
  await postMutation("/api/tags", { items });
}

// ── Smart folders (F7) ────────────────────────────────────────────────────────
// Saved searches/filters. GET returns a bare array; POST replaces the whole
// list (token-authed). Never throws — a missing endpoint yields [].
export async function fetchSmartFolders(): Promise<SmartFolder[]> {
  const res = await fetch("/api/smart-folders");
  if (!res.ok) return [];
  try {
    const data = (await res.json()) as SmartFolder[] | { items?: SmartFolder[] };
    if (Array.isArray(data)) return data;
    return data.items ?? [];
  } catch {
    return [];
  }
}

export async function saveSmartFolders(items: SmartFolder[]): Promise<void> {
  await postMutation("/api/smart-folders", items);
}

// ── Archive (zip) + checksums (F5) ──────────────────────────────────────────
// Compress/extract route through the token-authed mutate IPC (they write under
// a scanned root). Both return HTTP 200 even on a logical failure, carrying
// `ok:false` + an `error`, so we read the body rather than trusting the status.
// checksum is a read-only GET. All three gate paths to a scanned root server-side.

/** Zip `paths` into `dest` (a .zip path, whose parent must be under a scan root). */
export async function compress(paths: string[], dest: string): Promise<CompressResult> {
  const r = await postMutation("/api/compress", { paths, dest });
  if (!r.ok) return { ok: false, dest, error: mutateErrorText(r) };
  const d = (r.data ?? {}) as Partial<CompressResult>;
  return { ok: d.ok ?? false, dest: d.dest ?? dest, error: d.ok ? undefined : (d.error ?? "Compress failed") };
}

/** Extract `archive` (a .zip) into `dest` (zip-slip guarded server-side). */
export async function extract(archive: string, dest: string): Promise<ExtractResult> {
  const r = await postMutation("/api/extract", { archive, dest });
  if (!r.ok) return { ok: false, error: mutateErrorText(r) };
  const d = (r.data ?? {}) as Partial<ExtractResult>;
  return { ok: d.ok ?? false, error: d.ok ? undefined : (d.error ?? "Extract failed") };
}

/** Stream a file through SHA-256 (default) or MD5 and return the hex digest. */
export async function checksum(path: string, algo: "sha256" | "md5" = "sha256"): Promise<ChecksumResult> {
  const params = new URLSearchParams({ path, algo });
  const res = await fetch(`/api/checksum?${params}`);
  let data: Partial<ChecksumResult> = {};
  try { data = (await res.json()) as Partial<ChecksumResult>; } catch { /* ignore */ }
  if (!res.ok || !data.hash) {
    return { algo, hash: "", error: data.error ?? `HTTP ${res.status}` };
  }
  return { algo: data.algo ?? algo, hash: data.hash };
}

// ── Compression page (media re-encode + zip, with live jobs) ────────────────
// A first-class job layer: POST starts a job (mutation → token-authed), an
// NDJSON stream reports per-file + overall progress, and cancel/retry mutate the
// running job. Reads (tools detect + poll fallback) are plain GETs. Everything
// soft-degrades: a 404/offline backend yields all-tools-missing and an empty
// job rather than throwing, so the page renders even before the backend lands.

/** Default "nothing available" tools shape, used when detection fails/404s. */
const COMPRESS_TOOLS_NONE: CompressTools = {
  handbrake: { found: false },
  image: { found: false, kind: null },
  zip: { found: true },
};

/**
 * Detect which compression tools are installed. Never throws — on any failure
 * (endpoint missing, offline, malformed body) it reports everything but the
 * built-in zip as not-found so the page degrades to "zip only".
 */
let compressToolsCache: CompressTools | null = null;
let compressToolsPending: Promise<CompressTools> | null = null;

export async function fetchCompressTools(signal?: AbortSignal): Promise<CompressTools> {
  if (compressToolsCache) return compressToolsCache;
  if (!compressToolsPending) {
    compressToolsPending = (async () => {
      try {
        const data = isTauriV2()
          ? await invoke<Partial<CompressTools>>("compression_tools")
          : await (async () => {
              const res = await fetch("/api/compress-tools");
              if (!res.ok) return null;
              return res.json() as Promise<Partial<CompressTools>>;
            })();
        if (!data) return COMPRESS_TOOLS_NONE;
        return {
          handbrake: data.handbrake ?? { found: false },
          image: data.image ?? { found: false, kind: null },
          zip: { found: true },
          // Pass through the capability/availability diagnostics so the Performance
          // panel can gate the GPU controls on effective availability and show
          // ground-truth evidence (resolved binary, `-h` parse, adapters).
          caps: data.caps,
          available: data.available,
          gpu: data.gpu,
          gpuHardware: data.gpuHardware,
          handbrakeHParseOk: data.handbrakeHParseOk,
          handbrakeEncodersRaw: data.handbrakeEncodersRaw,
        };
      } catch {
        return COMPRESS_TOOLS_NONE;
      }
    })();
  }
  const tools = await compressToolsPending;
  compressToolsCache = tools;
  compressToolsPending = null;
  if (signal?.aborted) return tools;
  return tools;
}

/**
 * Ask the backend to download/install a missing tool (hybrid provisioning). On
 * success returns `{ok:true, path}`; if in-app install isn't possible the
 * backend may return a `downloadUrl` the caller opens instead.
 */
export async function installCompressTool(
  tool: "handbrake" | "image",
): Promise<CompressInstallResult> {
  const r = await postMutation("/api/compress-tools/install", { tool });
  compressToolsCache = null;
  compressToolsPending = null;
  if (!r.ok) return { ok: false, error: mutateErrorText(r) };
  const d = (r.data ?? {}) as Partial<CompressInstallResult>;
  return {
    ok: d.ok ?? false,
    path: d.path,
    error: d.ok ? undefined : (d.error ?? "Install failed"),
    downloadUrl: d.downloadUrl,
  };
}

/** One encode-probe result (a real HandBrake run on a tiny generated clip). */
export interface EncodeProbe {
  encoder: string;
  isGpu: boolean;
  success: boolean;
  ms: number;
  outBytes: number;
  exitCode: number | null;
  stderr: string;
}

export interface GpuTestResult extends Partial<EncodeProbe> {
  ok: boolean;
  error?: string;
  resolvedEncoder?: string;
}

export interface AutotuneResult {
  ok: boolean;
  error?: string;
  cpu?: EncodeProbe | null;
  gpu?: EncodeProbe | null;
  recommendedEncoder?: string;
  recommendedUseGpu?: boolean;
}

/** Definitive GPU-encoder test: runs the resolved HW encoder on a tiny clip
 *  (token-authed POST). Never throws — a failure surfaces as `{ok:false}`. */
export async function testGpuEncoder(
  encoder: string,
  codec: string,
): Promise<GpuTestResult> {
  const r = await postMutation("/api/compress-tools/test-gpu", { encoder, codec });
  if (!r.ok) return { ok: false, error: mutateErrorText(r) };
  return (r.data ?? { ok: false, error: "No response" }) as GpuTestResult;
}

/** Legacy auto-tune route. Current servers perform a GPU-only validation probe
 *  and never launch a software encoder. Never throws. */
export async function autotuneCompress(codec: string): Promise<AutotuneResult> {
  const r = await postMutation("/api/compress-tools/autotune", { codec });
  if (!r.ok) return { ok: false, error: mutateErrorText(r) };
  return (r.data ?? { ok: false, error: "No response" }) as AutotuneResult;
}

export interface CompressPreflight {
  ok: number;
  missing: string[];
  placeholder: string[];
}

/** Lightweight pre-flight: classify a selection's paths as present / missing /
 *  cloud-placeholder before starting a job. Read-only POST; never throws (a
 *  failure yields an all-ok result so it can't block a legitimate start). */
export async function compressPreflight(paths: string[]): Promise<CompressPreflight> {
  try {
    const res = await fetch("/api/compress-preflight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths }),
    });
    if (!res.ok) return { ok: paths.length, missing: [], placeholder: [] };
    const d = (await res.json()) as Partial<CompressPreflight>;
    return { ok: d.ok ?? 0, missing: d.missing ?? [], placeholder: d.placeholder ?? [] };
  } catch {
    return { ok: paths.length, missing: [], placeholder: [] };
  }
}

/** Start a compression job (throws so the caller can surface why it failed). */
export interface CompressJobStartResult {
  jobId: string;
  status: string;
  total: number;
  skippedUnavailable: number;
  skippedIneligible: number;
  skippedMissing: number;
}

export async function startCompressJob(body: CompressJobRequest): Promise<CompressJobStartResult> {
  // Forward the custom-preset video knobs only when defined (mirrors how the
  // other optional fields are sent), so older/non-custom requests are unchanged.
  const payload: CompressJobRequest = { ...body };
  if (body.customMaxHeight !== undefined) payload.customMaxHeight = body.customMaxHeight;
  else delete payload.customMaxHeight;
  if (body.customQuality !== undefined) payload.customQuality = body.customQuality;
  else delete payload.customQuality;
  if (isTauriV2()) {
    const result = await invoke<CompressJobStartResult>("compression_start", { request: payload });
    if (!result.jobId) throw new Error("Rust did not return a job id");
    return {
      jobId: result.jobId,
      status: result.status,
      total: result.total ?? body.paths.length,
      skippedUnavailable: result.skippedUnavailable ?? 0,
      skippedIneligible: result.skippedIneligible ?? 0,
      skippedMissing: result.skippedMissing ?? 0,
    };
  }
  const r = await postMutation("/api/compress-jobs", payload);
  if (!r.ok) throw new Error(mutateErrorText(r));
  const data = r.data as Partial<CompressJobStartResult> | null;
  const id = data?.jobId;
  if (!id) throw new Error("Server did not return a job id");
  return {
    jobId: id,
    status: data?.status ?? (body.queued ? "queued" : "running"),
    total: data?.total ?? body.paths.length,
    skippedUnavailable: data?.skippedUnavailable ?? 0,
    skippedIneligible: data?.skippedIneligible ?? 0,
    skippedMissing: data?.skippedMissing ?? 0,
  };
}

/** Hard-cancel a running job (kills the active encoder child server-side). */
export async function cancelCompressJob(id: string): Promise<{ ok: boolean; error?: string }> {
  if (isTauriV2()) {
    try {
      const data = await compressJobMutation("/api/compress-jobs/cancel", { id });
      return data.ok === false ? { ok: false, error: "Compression job was not found" } : { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const r = await postMutation("/api/compress-jobs/cancel", { id });
  if (r.ok) return { ok: true };
  return { ok: false, error: mutateErrorText(r) };
}

async function compressJobMutation(
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, any>> {
  if (isTauriV2()) {
    const action = path.split("/").filter(Boolean).pop() ?? "";
    return invoke<Record<string, any>>("compression_control", { action, request: body });
  }
  const r = await postMutation(path, body);
  if (!r.ok) throw new Error(mutateErrorText(r));
  return (r.data ?? {}) as Record<string, any>;
}

export async function pauseCompressJob(id: string): Promise<void> {
  await compressJobMutation("/api/compress-jobs/pause", { id });
}

export async function resumeCompressJob(id: string): Promise<void> {
  await compressJobMutation("/api/compress-jobs/resume", { id });
}

export async function setCompressConcurrency(id: string, concurrency: number): Promise<void> {
  await compressJobMutation("/api/compress-jobs/concurrency", { id, concurrency });
}

export async function prioritizeCompressFiles(id: string, indices: number[]): Promise<void> {
  await compressJobMutation("/api/compress-jobs/prioritize", { id, indices });
}

export async function skipCompressFiles(id: string, indices: number[]): Promise<void> {
  await compressJobMutation("/api/compress-jobs/skip", { id, indices });
}

export async function retryCompressFiles(id: string, indices: number[]): Promise<string> {
  const data = await compressJobMutation("/api/compress-jobs/retry-files", { id, indices });
  if (!data.jobId) throw new Error("Server did not return a retry job id");
  return data.jobId as string;
}

export async function reorderQueuedCompressJobs(ids: string[]): Promise<void> {
  await compressJobMutation("/api/compress-jobs/queue-reorder", { ids });
}

export async function removeQueuedCompressJob(id: string): Promise<void> {
  await compressJobMutation("/api/compress-jobs/queue-remove", { id });
}

/** Resume a job from its manifest (skips files already `done`). Returns the
 *  (possibly new) job id to re-attach the stream to. */
export async function retryCompressJob(id: string): Promise<string> {
  if (isTauriV2()) {
    const data = await compressJobMutation("/api/compress-jobs/retry", { id });
    if (!data.jobId) throw new Error("Rust did not return a job id");
    return data.jobId as string;
  }
  const r = await postMutation("/api/compress-jobs/retry", { id });
  if (!r.ok) throw new Error(mutateErrorText(r));
  const jobId = (r.data as { jobId?: string } | null)?.jobId;
  if (!jobId) throw new Error("Server did not return a job id");
  return jobId;
}

/** List every compression job (live + persisted manifests) for the "In Progress"
 *  tab. Returns [] on any error so the tab degrades gracefully. */
export async function listCompressJobs(signal?: AbortSignal): Promise<CompressJobSummary[]> {
  try {
    if (isTauriV2()) {
      const data = await invoke<{ jobs?: CompressJobSummary[] }>("compression_list");
      return Array.isArray(data?.jobs) ? data.jobs : [];
    }
    const res = await fetch("/api/compress-jobs", { signal });
    if (!res.ok) return [];
    const data = (await res.json()) as { jobs?: CompressJobSummary[] } | null;
    return Array.isArray(data?.jobs) ? data!.jobs : [];
  } catch {
    return [];
  }
}

/** Poll a job snapshot. Tauri v2 composes this from a compact summary and one
 *  bounded file page so callers can never pull a 200,000-row payload into the
 *  WebView. The opt-in legacy headless server keeps its compatibility route. */
export async function fetchCompressJob(
  id: string,
  signal?: AbortSignal,
): Promise<CompressJob | null> {
  try {
    if (isTauriV2()) {
      const [summary, page] = await Promise.all([
        listCompressJobs(signal).then((jobs) => jobs.find((job) => job.id === id) ?? null),
        fetchCompressJobFiles(id, { offset: 0, limit: 250, sort: "activity" }, signal),
      ]);
      if (!summary) return null;
      return {
        id: summary.id,
        status: summary.status,
        total: summary.total,
        savedBytes: summary.savedBytes,
        preset: summary.preset,
        totalBytes: summary.totalBytes,
        workCompletedBytes: summary.workCompletedBytes,
        successfulBytes: summary.successfulBytes,
        skippedBytes: summary.skippedBytes,
        failedBytes: summary.failedBytes,
        activeWorkBytes: summary.activeWorkBytes,
        activeCount: summary.activeCount,
        activeElapsedMs: summary.activeElapsedMs,
        concurrency: summary.concurrency,
        encoder: summary.encoder,
        codec: summary.codec,
        useGpu: summary.useGpu,
        originalAction: summary.originalAction,
        outputDir: summary.outputDir,
        queueRank: summary.queueRank,
        files: page?.items ?? [],
      };
    }
    const res = await fetch(`/api/compress-jobs/${encodeURIComponent(id)}`, { signal });
    if (!res.ok) return null;
    return (await res.json()) as CompressJob;
  } catch {
    return null;
  }
}

export async function fetchCompressJobFiles(
  id: string,
  query: CompressFilesQuery,
  signal?: AbortSignal,
): Promise<CompressJobFilesPage | null> {
  try {
    if (isTauriV2()) {
      return invoke<CompressJobFilesPage | null>("compression_files", { id, query });
    }
    const params = new URLSearchParams({ id });
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== "" && value !== false) params.set(key, String(value));
    });
    const res = await fetch(`/api/compress-jobs/files?${params}`, { signal });
    if (!res.ok) return null;
    return (await res.json()) as CompressJobFilesPage;
  } catch {
    return null;
  }
}

export async function fetchCompressTelemetry(
  id: string,
  signal?: AbortSignal,
): Promise<CompressTelemetry | null> {
  try {
    if (isTauriV2()) return invoke<CompressTelemetry>("compression_telemetry", { id });
    const res = await fetch(`/api/compress-jobs/telemetry?id=${encodeURIComponent(id)}`, { signal });
    if (!res.ok) return null;
    return (await res.json()) as CompressTelemetry;
  } catch {
    return null;
  }
}

/**
 * Open the job's NDJSON progress stream and dispatch one parsed event per line,
 * mirroring `readNdjsonStream` in hooks/useScan.ts. Resolves when the stream
 * ends (or the signal aborts); rejects on a network/HTTP error so the caller
 * can fall back to {@link fetchCompressJob} polling. Each line is a small JSON
 * object, so JSON.parse never sees a giant string.
 */
export async function streamCompressJob(
  id: string,
  onEvent: (ev: CompressEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (isTauriV2()) {
    const channel = new Channel<CompressEvent>();
    channel.onmessage = onEvent;
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    await invoke("compression_subscribe", { id, onEvent: channel });
    return;
  }
  const res = await fetch(`/api/compress-jobs/stream?id=${encodeURIComponent(id)}`, { signal });
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
      let ev: CompressEvent | null = null;
      try { ev = JSON.parse(trimmed) as CompressEvent; } catch { ev = null; }
      if (ev) onEvent(ev);
    }
  }
}

/** Fetch the last `limit` rows of the persistent compress CSV log (newest last)
 *  for the History tab. A missing log returns `[]`; desktop command failures
 *  throw so the UI does not misreport an I/O/runtime error as empty history. */
export async function fetchCompressLog(
  limit = 500,
  signal?: AbortSignal,
): Promise<CompressLogRow[]> {
  try {
    if (isTauriV2()) {
      if (signal?.aborted) return [];
      const rows = await invoke<CompressLogRow[]>("compression_log", { limit });
      return Array.isArray(rows) ? rows : [];
    }
    const res = await fetch(`/api/compress-log?limit=${encodeURIComponent(limit)}`, { signal });
    if (!res.ok) return [];
    return (await res.json()) as CompressLogRow[];
  } catch (error) {
    if (isTauriV2() && !signal?.aborted) throw error;
    return [];
  }
}

/** URL of the full compress log CSV (an attachment download). */
export function compressLogCsvUrl(): string {
  return "/api/compress-log.csv";
}

/** Resolve the absolute path of the compress log file (for reveal/open). Returns
 *  an empty string if it can't be read. */
export async function compressLogPath(): Promise<string> {
  try {
    if (isTauriV2()) {
      const r = await invoke<{ path?: string }>("compression_log_path", { kind: "history" });
      return r.path ?? "";
    }
    const r = await getJson<{ path?: string }>("/api/compress-log/path");
    return r.path ?? "";
  } catch {
    return "";
  }
}

/** URL of the verbose compress debug log (a plain-text attachment download). */
export function compressDebugLogUrl(): string {
  return "/api/compress-debug.log";
}

/** Resolve the absolute path of the verbose compress debug log (for
 *  reveal/open). Returns an empty string if it can't be read. */
export async function compressDebugPath(): Promise<string> {
  try {
    if (isTauriV2()) {
      const r = await invoke<{ path?: string }>("compression_log_path", { kind: "debug" });
      return r.path ?? "";
    }
    const r = await getJson<{ path?: string }>("/api/compress-debug/path");
    return r.path ?? "";
  } catch {
    return "";
  }
}

/** Open or reveal an app-owned compression log without granting the renderer
 * arbitrary access to FileTree's application-data directory. */
export async function openCompressionLog(
  kind: "history" | "debug",
  reveal = false,
): Promise<void> {
  if (isTauriV2()) {
    await invoke("compression_log_action", { kind, reveal });
    return;
  }
  const path = kind === "history" ? await compressLogPath() : await compressDebugPath();
  if (!path) throw new Error("The compression log has not been created yet");
  if (reveal) await revealPath(path);
  else await openPath(path);
}

/** Copy arbitrary text to the clipboard (Electron `copyText`, else /api/copy-path). */
export async function copyText(text: string): Promise<void> {
  if (eAPI().copyText) {
    await eAPI().copyText!(text);
  } else {
    await fetch("/api/copy-path", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: text }),
    }).catch(() => {});
  }
}

// ── Drive free-space (F9) ──────────────────────────────────────────────────────
// The backend has no dedicated /api/drive-space; GET /api/drives already reports
// {root,label,total,free} (bytes) per volume, so the low-space monitor watches
// that directly — the caller maps root→drive and computes percent-free from
// total/free. Never throws.
export async function fetchDriveSpace(): Promise<DriveEntry[]> {
  try {
    return (await fetchDrives()).drives ?? [];
  } catch {
    return [];
  }
}

// ── Native desktop notification (F9) ───────────────────────────────────────────
// Prefer the Electron MAIN-process Notification bridge (real OS toast even when
// the window is unfocused). Outside Electron, fall back to the Web Notifications
// API (requesting permission once). Never throws; resolves true when a
// notification was shown.
export async function notify(title: string, body: string): Promise<boolean> {
  const api = eAPI();
  if (typeof api.notify === "function") {
    try { return await api.notify(title, body); } catch { /* fall through */ }
  }
  try {
    if (typeof Notification !== "undefined") {
      if (Notification.permission === "granted") {
        new Notification(title, { body });
        return true;
      }
      if (Notification.permission !== "denied") {
        const perm = await Notification.requestPermission();
        if (perm === "granted") {
          new Notification(title, { body });
          return true;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}
