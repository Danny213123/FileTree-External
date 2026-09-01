import { Channel, invoke } from "@tauri-apps/api/core";
import type { NodeRecord, ScanResult } from "./types";
import type { ScanOptions } from "./client";
import { V2PageCache } from "../lib/v2PageCache";

export interface V2ScanHandle {
  scanId: string;
  rootPath: string;
  databasePath: string;
  status: string;
  nodeCount: number;
  startedAt: number;
  elapsedMs: number;
  error?: string | null;
}

export interface V2ScanProgress {
  scanId: string;
  stage: string;
  nodeCount: number;
  elapsedMs: number;
}

interface V2NodeItem {
  id: number;
  parentId: number | null;
  name: string;
  path: string;
  isDir: boolean;
  isLink: boolean;
  hidden: boolean;
  readonly: boolean;
  size: number;
  allocated: number;
  files: number;
  folders: number;
  modifiedMs: number;
  createdMs: number;
  accessedMs: number;
  depth: number;
  errors: number;
  extension: string;
  owner: string;
  attributes: number;
}

export interface V2NodePage {
  items: V2NodeItem[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface V2MemoryStats {
  workingSetBytes: number | null;
  privateBytes: number | null;
  managedBudgetBytes: number;
  scanIndexBytes: number;
  activeScans: number;
  retainedScanHandles: number;
}

export interface NativeDragResponse {
  outcome: "internal" | "external-move" | "external-copy" | "cancel";
  clientX: number | null;
  clientY: number | null;
}

const pageCache = new V2PageCache<V2NodePage>();

export function isTauriV2(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function startNativeDrag(paths: string[]): Promise<NativeDragResponse> {
  return invoke<NativeDragResponse>("native_drag", { paths });
}

export async function startV2FilesystemWatch(
  rootPath: string,
  onChange: (directories: string[]) => void,
): Promise<number> {
  const channel = new Channel<string[]>();
  channel.onmessage = onChange;
  return invoke<number>("fs_watch_start", { rootPath, onChange: channel });
}

export async function stopV2FilesystemWatch(watchId: number): Promise<void> {
  await invoke("fs_watch_stop", { watchId });
}

export async function fetchV2DirectorySnapshot(
  path: string,
  recursiveAggregates = false,
  scanId?: string,
  directoryId?: number,
): Promise<NodeRecord[]> {
  return invoke<NodeRecord[]>("directory_snapshot", {
    path,
    recursiveAggregates,
    scanId: scanId ?? null,
    directoryId: directoryId ?? null,
  });
}

export function toNodeRecord(item: V2NodeItem): NodeRecord {
  return {
    id: item.id,
    parent: item.parentId,
    name: item.name,
    path: item.path,
    dir: item.isDir,
    link: item.isLink,
    hidden: item.hidden,
    readonly: item.readonly,
    size: item.size,
    allocated: item.allocated,
    files: item.files,
    folders: item.folders,
    modified: item.modifiedMs,
    created: item.createdMs,
    accessed: item.accessedMs,
    depth: item.depth,
    errors: item.errors,
    extension: item.extension,
    children: [],
    owner: item.owner,
    attributes: item.attributes,
    aggregateKnown: true,
  };
}

export async function runV2Scan(
  options: ScanOptions,
  onProgress: (value: V2ScanProgress) => void,
  signal?: AbortSignal,
): Promise<ScanResult> {
  if (!options.nocache) {
    const cached = await invoke<V2ScanHandle | null>("scan_find", { rootPath: options.path });
    if (cached) return loadV2Scan(cached, options.threads ?? 0);
  }
  const channel = new Channel<V2ScanProgress>();
  let terminal: V2ScanProgress | null = null;
  let finish: ((value: V2ScanProgress) => void) | undefined;
  const done = new Promise<V2ScanProgress>((resolve) => { finish = resolve; });
  channel.onmessage = (event) => {
    onProgress(event);
    if (["done", "cancelled", "error"].includes(event.stage)) {
      terminal = event;
      finish?.(event);
    }
  };
  const handle = await invoke<V2ScanHandle>("scan_start", {
    request: {
      root: options.path,
      includeHidden: options.includeHidden ?? true,
      followLinks: options.followLinks ?? false,
      excludePatterns: options.excludePatterns ?? [],
      threads: options.threads ?? 0,
    },
    onProgress: channel,
  });
  const abort = () => { void invoke("scan_cancel", { scanId: handle.scanId }); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const final = terminal ?? await done;
    if (final.stage === "cancelled" || signal?.aborted) throw new DOMException("Scan cancelled", "AbortError");
    if (final.stage === "error") {
      const failed = await invoke<V2ScanHandle>("scan_status", { scanId: handle.scanId });
      throw new Error(failed.error || "The v2 scan failed");
    }
    return loadV2Scan({ ...handle, nodeCount: final.nodeCount, elapsedMs: final.elapsedMs }, options.threads ?? 0);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

async function loadV2Scan(handle: V2ScanHandle, threadCount: number): Promise<ScanResult> {
  const page = await scanPage({ scanId: handle.scanId, parentId: null, offset: 0, limit: 1 });
  const root = page.items[0];
  if (!root) throw new Error("The v2 scan completed without a root row");
  return {
    app: "FileTree",
    version: "2.0.0",
    rootPath: handle.rootPath,
    scannedAt: handle.startedAt,
    elapsedMs: handle.elapsedMs,
    threadCount,
    nodeCount: handle.nodeCount,
    errorCount: 0,
    nodes: [toNodeRecord(root)],
    lazy: true,
    scanId: handle.scanId,
    topFiles: [],
    largestDirs: [],
    extensionStats: [],
    ageStats: [],
    duplicateCandidates: [],
    scanErrors: [],
  };
}

export async function scanPage(query: {
  scanId: string;
  parentId?: number | null;
  offset?: number;
  limit?: number;
  search?: string;
  sort?: string;
  direction?: "asc" | "desc";
  directoriesOnly?: boolean;
  filesOnly?: boolean;
  regex?: boolean;
  minSize?: number;
  maxSize?: number;
  modifiedAfter?: number;
  modifiedBefore?: number;
  ext?: string;
  category?: string;
  countTotal?: boolean;
}): Promise<V2NodePage> {
  const normalized = {
    scanId: query.scanId,
    parentId: query.parentId ?? null,
    offset: query.offset ?? 0,
    limit: Math.min(500, Math.max(1, query.limit ?? 500)),
    search: query.search ?? "",
    sort: query.sort ?? "size",
    direction: query.direction ?? "desc",
    directoriesOnly: query.directoriesOnly ?? false,
    filesOnly: query.filesOnly ?? false,
    regex: query.regex ?? false,
    minSize: query.minSize ?? null,
    maxSize: query.maxSize ?? null,
    modifiedAfter: query.modifiedAfter ?? null,
    modifiedBefore: query.modifiedBefore ?? null,
    ext: query.ext ?? "",
    category: query.category ?? "",
    countTotal: query.countTotal ?? true,
  };
  const key = JSON.stringify(normalized);
  const cached = pageCache.get(key);
  if (cached) return cached;
  const page = await invoke<V2NodePage>("scan_page", { query: normalized });
  const estimated = page.items.reduce((total, item) => total + 192 + item.name.length * 2 + item.path.length * 2, 0);
  pageCache.set(key, page, estimated);
  return page;
}

export async function v2MemoryStats(): Promise<V2MemoryStats> {
  return invoke<V2MemoryStats>("memory_stats");
}

export function releaseV2ScanPages(scanId: string): void {
  pageCache.deletePrefix(`{\"scanId\":\"${scanId}\"`);
}
