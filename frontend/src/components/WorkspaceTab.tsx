import { useState, useEffect, useCallback, useMemo, useRef, forwardRef, useImperativeHandle, useSyncExternalStore, memo } from "react";
import { useResultTree } from "../hooks/useResultTree";
import { useScan, fetchScanStream } from "../hooks/useScan";
import { isLiveNodeId, isNodeOpen, useTreeState, type ChipKey, type LazyOptions } from "../hooks/useTreeState";
import { invalidate as invalidateScanCache } from "../lib/scanCache";
import {
  revealPath, openPath, createFolder,
  copyPath, renameItem, moveItems, deletePath,
  hasNativeMove, moveItemsNative, fetchDupesV2Bounded, runCommand,
  exportUrl, printReportAsPdf, webFetch, webSearch,
  clipboardWriteFiles, clipboardReadFiles, copyItemsNative, hasNativeCopy,
  releaseExternalPaths,
  compress, extract, checksum, copyText,
  setAttributes, setTimes,
  fetchServerSearch, shellContextMenu, fetchChildren,
} from "../api/client";
import type { ScanOptions, ExportFormat, CompressionSource, AppTabSettings } from "../api/client";
import type { NodeRecord, SortKey, TagEntry } from "../api/types";
import type { FilterRule } from "../hooks/useFilterRules";
import { isNoOpMove, buildWriteFileCommand, buildEditFileCommand, readFileWindow, type AgentApi } from "../lib/agent";
import { confirmRisky, isCrossDrive } from "../lib/confirmRisky";
import { clearUndo, pushUndo, parentDir } from "../lib/undo";
import { beginTransfer, finishTransfer, enqueueTransfer, transferDedupeKey } from "../lib/transfers";
import { searchNodesAdvanced, filtersActive, toServerSearchParams, type SearchFilters } from "../lib/search";
import { exportResults } from "../lib/exportRows";
import { loadFolderPref, saveFolderPref, normFolderKey } from "../lib/folderPrefs";
import { compressionPathKey as bookmarkPathKey } from "../lib/compressionExclusions";
import { compareNodes } from "../hooks/useTreeState";
import { formatBytes } from "../utils/formatBytes";
import { formatDate } from "../utils/formatDate";
import { toast, type ToastAction } from "../lib/toast";
import { promptDialog } from "../lib/dialogs";
import { TreeTable } from "./TreeTable";
import { TabFooter } from "./TabFooter";
import { BulkRenameDialog } from "./BulkRenameDialog";
import { TagPopover } from "./TagPopover";
import { ConfigureColumnsMenu } from "./ConfigureColumnsMenu";
import type { ViewId } from "./ActivityBar";
import { ConflictDialog, type ConflictChoice } from "./ConflictDialog";
import { MoveToDialog } from "./MoveToDialog";
import { AttributesDialog, type AttributesPayload } from "./AttributesDialog";
import { SendToDialog } from "./SendToDialog";
import { getRecentDestinations, recordRecentDestination, removeRecentDestination } from "../lib/recentDestinations";
import { FilterDialog } from "./FilterDialog";
import { Breadcrumb } from "./Breadcrumb";
import { Icon } from "./Icon";
import { Select } from "./Select";
import type { ScanStatus, ProgressStore } from "../hooks/useScan";
import type { ScanResult, Metric, Unit } from "../api/types";
import {
  isTauriV2,
  scanPage,
  toNodeRecord,
  fetchV2DirectorySnapshot,
  releaseV2ScanPages,
  startV2FilesystemWatch,
  stopV2FilesystemWatch,
} from "../api/v2";
import {
  mutationAffectsRoot,
  publishFilesystemMutation,
  subscribeFilesystemMutations,
} from "../lib/fsMutations";

export interface WorkspaceTabHandle {
  getStatus: () => ScanStatus;
  getData: () => ScanResult | null;
  getProgress: () => { nodes: number; elapsed: number } | null;
  /** The live scan-progress store, so a tiny subscriber (e.g. the status bar
   *  counter) can re-render on progress ticks WITHOUT re-rendering this pane. */
  getProgressStore: () => ProgressStore;
  getErrorMessage: () => string;
  getVisibleCount: () => number;
  /** Current table selection summary for the status bar: number of selected
   *  rows and their total size (parent-aware — a selected folder's descendants
   *  that are also selected aren't double-counted). */
  getSelectionSummary: () => { count: number; bytes: number };
  /** Copy the current selection to the clipboard as a TSV table (Copy as table). */
  doCopyAsTable: () => void;
  getScanPath: () => string;
  getViewState: () => AppTabSettings;
  getScanning: () => boolean;
  getNodeById: () => Map<number, NodeRecord>;
  getAgentApi: () => AgentApi;
  /** Snapshot of everything the shared (hoisted) Explorer side bar needs, plus
   *  the navigation/scan handlers bound to THIS tab. App reads it from the
   *  focused group's active tab so the single left panel drives that pane. */
  getSidebarModel: () => SidebarModel;
  doScan: () => void;
  doCancel: () => void;
  doScanPath: (path: string) => void;
  doNavigateParent: () => void;
  /** Navigate back/forward through this tab's per-tab scan history. */
  doBack: () => void;
  doForward: () => void;
  /** Whether back/forward are currently possible (for menu enabled state). */
  getNavState: () => { canBack: boolean; canForward: boolean };
  doExpand: (level: number) => void;
  doNewFolder: () => void;
  doOpenFilter: () => void;
  doReveal: () => void;
  doExport: (format: ExportFormat) => void;
  /** Select all current search/filter result rows by path; returns how many
   *  resolved to rows in THIS pane's scan (#35). */
  doSelectPaths: (paths: string[]) => number;
  /** Select every current flat search/filter result row in this pane (#35). */
  doSelectSearchResults: () => void;
  /** Export the current flat search/filter result rows to CSV/JSON (#35). */
  doExportSearchResults: (format: "csv" | "json") => void;
  /** Cut the selection to the clipboard as CF_HDROP (paste = move). #9 */
  doCutFiles: () => void;
  /** Paste CF_HDROP clipboard files into the focused folder (move or copy). #9 */
  doPaste: () => void;
  /** Drop Explorer files into a specific folder (drag-in): move same-drive, copy cross-drive. #9 */
  dropExternalInto: (paths: string[], destination: string, provenance?: string) => Promise<void>;
  doRename: () => void;
  doRenamePath: (path: string) => void;
  /** Open the bulk-rename dialog for the current selection (F3). */
  doBulkRename: () => void;
  doDelete: () => void;
  doDeletePaths: (paths: string[]) => void;
  doMoveTo: () => void;
  /** Open the "Copy to…" destination picker for the current selection (#42). */
  doCopyTo: () => void;
  /** Open the batch attribute + timestamp editor for the selection (#43). */
  doEditAttributes: () => void;
  /** "Send to → Mail recipient": open the default mail client (#44). */
  doSendToMail: () => void;
  /** "Send to → Run command…": open the custom-command runner (#44). */
  doSendToCommand: () => void;
  doCopyPath: () => void;
  doCopyFiles: () => void;
  /** Compress the current selection into a .zip beside it (F5). */
  doCompress: () => void;
  /** Extract the selected .zip into its own folder (F5). */
  doExtract: () => void;
  /** Copy the SHA-256 checksum of the selected file to the clipboard (F5). */
  doChecksum: () => void;
  getRibbonState: () => RibbonState;
  setMetric: (m: string) => void;
  setUnit: (u: string) => void;
  setFilter: (f: string) => void;
  setShowFiles: (v: boolean) => void;
  setScanPath: (p: string) => void;
  setSortKeyDir: (key: string, dir: 1 | -1) => void;
  /** Show a transient status toast in this pane (used for undo feedback). */
  showNotice: (message: string) => void;
  /** Force a fresh rescan of this pane (used after an undo changes the tree). */
  refresh: () => void;
  /** #14: incremental "smart refresh" — re-walk only the expanded folders,
   *  reusing collapsed subtrees; falls back to a full rescan when appropriate. */
  smartRefresh: () => Promise<void>;
  /** Reveal/select a node by id (command palette file jump, F6). */
  doNavigateId: (id: number) => void;
  /** Current advanced filter rules — captured when saving a smart folder (F7). */
  getFilterRules: () => FilterRule[];
  /** Apply advanced filter rules — used when a smart folder is opened (F7). */
  setFilterRules: (rules: FilterRule[]) => void;
}

export interface RibbonState {
  scanPath: string;
  scanning: boolean;
  metric: string;
  unit: string;
  filter: string;
  showFiles: boolean;
  filterActive: boolean;
  sortKey: string;
  sortDir: 1 | -1;
}

// Data + handlers the shared Explorer side bar (rendered once in App, to the
// left of the editor groups) needs from the focused pane. The handlers are the
// same ones the in-pane tree/treemap already use, so clicking a location/folder
// in the left panel acts on the focused group's active tab.
export interface SidebarModel {
  data: ScanResult | null;
  nodeById: Map<number, NodeRecord>;
  metric: Metric;
  unit: Unit;
  loadedDirs: Set<number>;
  scanPath: string;
  scanning: boolean;
  treeRows: NodeRecord[];
  expanded: Set<number>;
  expandedAll: boolean;
  collapsedOverrides: Set<number>;
  selectedId: number;
  selectedNode: NodeRecord | undefined;
  errorCount: number;
  onSelectNode: (id: number) => void;
  onEnsureChildren: (id: number) => void;
  onMoveItems: (sourcePaths: string[], destinationFolder: string) => Promise<{ ok: boolean; error?: string }>;
  onOpenNode: (id: number) => void;
  onNavigate: (id: number) => void;
  onScanPathInput: (p: string) => void;
  onScan: () => void;
  onCancel: () => void;
  onRefresh: () => void;
  onUp: () => void;
  onNewFolder: () => void;
  onCollapseAll: () => void;
  onOpenLocation: (path: string) => void;
  onToggleExpand: (id: number) => void;
  onSelectFolder: (id: number) => void;
  onOpen: () => void;
  onReveal: () => void;
  onCopyPath: () => void;
  onScanPath: (p: string) => void;
}

// Cap on per-tab navigation history so a long browsing session can't grow the
// stack without bound. Oldest entries are dropped first.
const HISTORY_MAX = 50;

// Case-insensitive, trailing-separator-insensitive path equality (Windows).
function samePath(a: string, b: string): boolean {
  return a.replace(/[/\\]+$/, "").toLowerCase() === b.replace(/[/\\]+$/, "").toLowerCase();
}

// Parent folder of a path, with drive roots normalized to include the trailing
// backslash ("C:\\Users" → "C:\\"). Returns null at a volume/UNC root so "up"
// becomes a no-op rather than scanning a malformed path.
function parentDirOf(p: string): string | null {
  const trimmed = p.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (idx <= 0) return null;
  const parent = trimmed.slice(0, idx);
  if (/^[a-zA-Z]:$/.test(parent)) return parent + "\\";
  return parent || null;
}

function dedupeNestedPaths(paths: string[], nodeByPath: Map<string, NodeRecord>): string[] {
  // Sort shortest-first so an ancestor is always kept before its descendants.
  const sorted = [...paths].sort((a, b) => a.length - b.length);
  const result: string[] = [];
  // A candidate is dropped iff it (or an ancestor) is already a kept directory.
  // Walking ancestors against a Set is O(path depth) instead of O(kept) per item.
  const keptDirs = new Set<string>();
  const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
  for (const path of sorted) {
    let cur = norm(path);
    let covered = false;
    for (;;) {
      if (keptDirs.has(cur)) { covered = true; break; }
      const i = Math.max(cur.lastIndexOf("\\"), cur.lastIndexOf("/"));
      if (i <= 0) break;
      cur = cur.slice(0, i);
    }
    if (covered) continue;
    result.push(path);
    if (nodeByPath.get(path)?.dir) keptDirs.add(norm(path));
  }
  return result;
}

function basenameFromPath(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** "1 item" / "N items" — small helper for toast/notice copy. */
function itemsLabel(n: number): string {
  return n === 1 ? "1 item" : `${n} items`;
}

// Quick-filter chips shown above the table — label + tree-state chip key. Each
// toggles a predicate ANDed onto the active filter (see useTreeState.toggleChip).
const QUICK_FILTER_CHIPS: { key: ChipKey; label: string }[] = [
  { key: "size100mb", label: ">100 MB" },
  { key: "size1gb", label: ">1 GB" },
  { key: "videos", label: "Videos" },
  { key: "images", label: "Images" },
  { key: "old1y", label: ">1 year old" },
];

// Filesystem-watch tuning. Snapshot reads run in bounded batches so a large
// mutation updates changed branches without turning into a drive-wide rescan.
// Native watcher events are already collapsed into short batches before they
// cross IPC. This small UI-side window merges adjacent batches without making
// visible changes wait close to a second.
const WATCH_DEBOUNCE_MS = 60;
const WATCH_MAX_BATCH = 6;
const DIRTY_DIRECTORY_MAX = 512;

// #11 diff-on-rescan: how long the added/changed row tint lingers before fading,
// and the largest tree we'll snapshot per-path sizes for (keeps the diff cheap
// on huge scans — beyond this we skip the highlight rather than retain a giant map).
const DIFF_HIGHLIGHT_MS = 4000;
const DIFF_MAX_NODES = 200_000;

// #14 smart refresh: re-walk at most this many currently-expanded directories
// for an undirected manual refresh. Watcher-driven dirty paths are drained in
// bounded batches and are not truncated to this limit.
const SMART_REFRESH_MAX_DIRS = 50;
// Phase 0 safety net: a scan with more nodes than this surfaces a non-blocking
// "very large scan" banner warning that performance may degrade while loading
// continues. Purely advisory — loading is never truncated. Kept below the lazy
// threshold so a heavy (but not yet lazy) scan still gives the user a heads-up.
const VERY_LARGE_SCAN_NODES = 2_000_000;

interface WorkspaceTabProps {
  tabId: string;
  initialPath: string;
  initialViewState?: AppTabSettings;
  active: boolean;
  // Drives search/results behavior; the shared side bar (App) tracks its own.
  activeView: ViewId;
  // Activity-bar Search query (already debounced in App). When activeView ===
  // "search" and this has >= 2 chars, the main table renders flat search results.
  searchQuery: string;
  // Inline search filters + regex toggle (#31), lifted in App so the pane's flat
  // results table applies the same narrowing the sidebar Search view shows.
  searchFilters: SearchFilters;
  // Whether the per-pane controls toolbar row (under the tabs) is shown. Toggled
  // from the tab bar's toolbar button; per-editor-group, defaults to visible.
  toolbarVisible: boolean;
  // data + options
  bookmarkList: string[];
  // Tags & color labels (F4): path → entry map for the row badges + popover, the
  // active tag filter (flattens the table to tagged paths), and the setter that
  // persists edits (mirrors the bookmark store, threaded from App).
  tagsByPath: Map<string, TagEntry>;
  activeTagFilter: string | null;
  onSetTags: (path: string, tags: string[], color?: string) => void;
  onClearTagFilter: () => void;
  threads: number;
  includeHidden: boolean;
  followLinks: boolean;
  /** Opt-in Windows owner resolution (off by default; slower scans). */
  collectOwners: boolean;
  /** Toggling this re-scans the current path so owners (de)populate. */
  onCollectOwnersChange: (v: boolean) => void;
  exclude: string;
  decimals: number;
  visibleColumns: Set<SortKey>;
  onVisibleColumnsChange: (cols: Set<SortKey>) => void;
  onDecimalsChange: (d: number) => void;
  /** #7: when true (default) double-clicking a FOLDER opens it in File Explorer;
   *  when false it drills into the folder in-app (navigates this pane). */
  folderDblClickExplorer: boolean;
  /** #9: tint table rows by size relative to the largest visible row. */
  heatTint: boolean;
  /** Row height in px, from the Appearance density + text-size prefs. */
  rowHeight: number;
  onToggleBookmark: (path: string) => void;
  // Quick-load files or persisted scan folders into the Compress page.
  onCompress: (sources: CompressionSource[]) => void;
  onScanPath: (path: string) => void;
  onStateChange: () => void;
  // Publish this pane's sidebar/status snapshot to the shared workbench store
  // (when focused). Routed separately from onStateChange so high-frequency tree
  // edits (expand/collapse/filter/select) re-render only the store subscribers,
  // never the App shell.
  onWorkbenchChange: () => void;
  onOpenTerminal?: (cwd: string) => void;
  // Open `path` in a new workspace tab of editor group `groupId` (falls back to
  // the focused group). Used when a native folder drag is dropped on a tab strip.
  onOpenFolderInTab?: (path: string, groupId?: string, background?: boolean) => void;
  // Reverse the most recent reversible op (the same handler Ctrl+Z runs). Wired
  // to the "Undo (Ctrl+Z)" action link on move/rename/recycle success toasts.
  onUndo?: () => void;
}

const WorkspaceTabInner = forwardRef<WorkspaceTabHandle, WorkspaceTabProps>(function WorkspaceTab(
  {
    tabId, initialPath, initialViewState, active, activeView, searchQuery, searchFilters, toolbarVisible,
    bookmarkList, tagsByPath, activeTagFilter, onSetTags, onClearTagFilter,
    threads, includeHidden, followLinks, collectOwners, onCollectOwnersChange, exclude,
    decimals, visibleColumns, onVisibleColumnsChange, onDecimalsChange,
    folderDblClickExplorer, heatTint, rowHeight,
    onToggleBookmark, onCompress, onScanPath, onStateChange, onWorkbenchChange, onOpenTerminal,
    onOpenFolderInTab, onUndo,
  }: WorkspaceTabProps,
  ref,
) {
  const [scanPath, setScanPathState] = useState(initialPath);
  // Stable "Undo (Ctrl+Z)" action for success toasts — reads the latest onUndo
  // via a ref so the action keeps a stable identity (no re-render churn) while
  // always invoking the current undo handler.
  const onUndoRef = useRef(onUndo);
  onUndoRef.current = onUndo;
  const undoAction = useMemo<ToastAction>(
    () => ({ label: "Undo (Ctrl+Z)", onClick: () => onUndoRef.current?.() }),
    [],
  );
  const [filterDialogOpen, setFilterDialogOpen] = useState(false);

  const { data, status, errorMessage, progressStore, startScan, startRefresh, cancelScan } = useScan();
  // LAZY mode (very large scans): when useScan flags the result `lazy`, the
  // renderer holds only the root and useTreeState fetches each directory's
  // children on demand from the backend's cached scan. onStale fires when the
  // backend reports the cached scan changed under us (409) — we force a fresh
  // rescan via the ref below (doScan is defined later).
  const onStaleRef = useRef<() => void>(() => {});
  const lazyOptions = useMemo<LazyOptions | undefined>(() => {
    if (!data?.lazy) return undefined;
    return {
      enabled: true,
      rootPath: data.rootPath,
      scannedAt: data.scannedAt,
      scanId: data.scanId,
      loadDirectory: isTauriV2() ? fetchV2DirectorySnapshot : undefined,
      onStale: () => onStaleRef.current(),
    };
  }, [data?.lazy, data?.rootPath, data?.scannedAt, data?.scanId]);
  const tree = useTreeState(lazyOptions);
  const initialViewAppliedRef = useRef(false);
  useEffect(() => {
    if (initialViewAppliedRef.current || !initialViewState) return;
    initialViewAppliedRef.current = true;
    if (["size", "allocated", "files", "folders"].includes(initialViewState.metric ?? "")) {
      tree.setMetric(initialViewState.metric as Metric);
    }
    if (["auto", "tb", "gb", "mb", "kb", "bytes"].includes(initialViewState.unit ?? "")) {
      tree.setUnit(initialViewState.unit as Unit);
    }
    if (initialViewState.showFiles !== undefined) tree.setShowFiles(initialViewState.showFiles);
    if (initialViewState.sortKey && (initialViewState.sortDir === 1 || initialViewState.sortDir === -1)) {
      tree.setSort(initialViewState.sortKey as SortKey, initialViewState.sortDir);
    }
    if (initialViewState.columnWidths) {
      tree.setColumnWidthsAll(initialViewState.columnWidths as Partial<Record<SortKey, number>>);
    }
  }, [initialViewState, tree]);
  // Latest tree snapshot for stable callbacks / async watch handlers (avoids
  // recreating callbacks every render and reading stale expansion state).
  const treeRef = useRef(tree);
  treeRef.current = tree;
  // Latest scan result for stable callbacks (lazy flag / rootPath at call time).
  const dataRef = useRef(data);
  dataRef.current = data;
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set([0]));
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const selectionAnchorIdRef = useRef<number>(0);
  // Search state lives beside selection so every row action resolves against
  // the result set from this render, including lazy rows absent from nodeById.
  const searchResultsRef = useRef<NodeRecord[]>([]);
  const localSearchResults = useMemo(
    () => searchNodesAdvanced(tree.nodeById, searchQuery, searchFilters, tree.sortKey, tree.sortDir, 2000),
    [tree.nodeById, searchQuery, searchFilters, tree.sortKey, tree.sortDir],
  );
  const [lazySearch, setLazySearch] = useState<{
    key: string;
    matches: NodeRecord[];
    capped: boolean;
  }>({ key: "", matches: [], capped: false });
  const lazySearchRequestRef = useRef(0);
  const lazyMode = !!data?.lazy;
  const lazySearchKey = `${data?.scanId ?? ""}\u0000${searchQuery}\u0000${JSON.stringify(searchFilters)}`;
  useEffect(() => {
    const requestId = ++lazySearchRequestRef.current;
    const requestKey = lazySearchKey;
    if (!lazyMode || activeView !== "search") {
      setLazySearch({ key: "", matches: [], capped: false });
      return;
    }
    const q = searchQuery.trim();
    const hasFilters = filtersActive(searchFilters);
    if (q.length < 2 && !hasFilters) {
      setLazySearch({ key: requestKey, matches: [], capped: false });
      return;
    }
    const controller = new AbortController();
    const params = toServerSearchParams(searchFilters);
    void fetchServerSearch({
      rootPath: data!.rootPath,
      scanId: data!.scanId,
      query: searchQuery,
      limit: 500,
      signal: controller.signal,
      ...params,
    })
      .then((res) => {
        if (requestId === lazySearchRequestRef.current) {
          setLazySearch({
            key: requestKey,
            matches: res.matches,
            capped: res.capped,
          });
        }
      })
      .catch((err: unknown) => {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          console.warn("server search failed", err);
        }
      });
    return () => {
      controller.abort();
    };
  }, [lazyMode, lazySearchKey, activeView, searchQuery, searchFilters, data]);

  const searchResults = useMemo(() => {
    if (!lazyMode) return localSearchResults;
    if (lazySearch.key !== lazySearchKey) return [];
    return [...lazySearch.matches].sort((a, b) => compareNodes(a, b, tree.sortKey, tree.sortDir));
  }, [lazyMode, lazySearchKey, localSearchResults, lazySearch, tree.sortKey, tree.sortDir]);
  searchResultsRef.current = searchResults;
  const searching = activeView === "search"
    && (searchQuery.trim().length >= 2 || filtersActive(searchFilters));

  const taggedPaths = useMemo(() => {
    if (!activeTagFilter) return null;
    const want = activeTagFilter.toLowerCase();
    const paths = new Set<string>();
    for (const entry of tagsByPath.values()) {
      if (entry.tags.some((tag) => tag.toLowerCase() === want)) paths.add(entry.path);
    }
    return paths;
  }, [tagsByPath, activeTagFilter]);
  const tagResults = useMemo(() => {
    if (!taggedPaths) return [];
    const results: NodeRecord[] = [];
    for (const node of tree.nodeById.values()) {
      if (node.id >= 0 && node.path && taggedPaths.has(node.path)) results.push(node);
    }
    results.sort((a, b) => compareNodes(a, b, tree.sortKey, tree.sortDir));
    return results;
  }, [taggedPaths, tree.nodeById, tree.sortKey, tree.sortDir]);
  const tagFiltering = !!activeTagFilter && !searching;
  const bookmarksView = activeView === "bookmarks";
  const bookmarkPaths = useMemo(() => {
    const root = bookmarkPathKey(data?.rootPath ?? scanPath);
    return bookmarkList.filter((path) => {
      const key = bookmarkPathKey(path);
      return root && (key === root || key.startsWith(`${root}/`));
    });
  }, [bookmarkList, data?.rootPath, scanPath]);
  const bookmarkQueryKey = JSON.stringify([data?.scanId, bookmarkPaths]);
  const [indexedBookmarks, setIndexedBookmarks] = useState<{ key: string; rows: NodeRecord[] }>({ key: "", rows: [] });
  useEffect(() => {
    if (!bookmarksView || !data?.scanId || !data.lazy || !bookmarkPaths.length) return;
    let disposed = false;
    void (async () => {
      const rows: NodeRecord[] = [];
      for (let offset = 0; offset < bookmarkPaths.length; offset += 500) {
        const page = await scanPage({ scanId: data.scanId!, parentId: null, directoryPaths: bookmarkPaths.slice(offset, offset + 500), limit: 500, countTotal: false });
        if (disposed) return;
        rows.push(...page.items.map(toNodeRecord));
      }
      setIndexedBookmarks({ key: bookmarkQueryKey, rows });
    })().catch((error) => { if (!disposed) toast.error(String(error)); });
    return () => { disposed = true; };
  }, [bookmarksView, data?.scanId, data?.lazy, bookmarkPaths, bookmarkQueryKey]);
  const bookmarkRows = useMemo(() => {
    const paths = new Set(bookmarkPaths.map(bookmarkPathKey));
    const source = data?.lazy && indexedBookmarks.key === bookmarkQueryKey ? indexedBookmarks.rows : [...tree.nodeById.values()];
    return source.filter((node) => node.dir && node.path && paths.has(bookmarkPathKey(node.path)))
      .sort((a, b) => compareNodes(a, b, tree.sortKey, tree.sortDir));
  }, [bookmarkPaths, data?.lazy, indexedBookmarks, bookmarkQueryKey, tree.nodeById, tree.sortKey, tree.sortDir]);
  const resultRoots = bookmarksView ? bookmarkRows : searching ? searchResults : tagFiltering ? tagResults : [];
  const resultTree = useResultTree(
    JSON.stringify([data?.scanId, data?.scannedAt, activeView, searchQuery, bookmarkQueryKey, searchFilters]),
    resultRoots,
    async node => data?.lazy
      ? fetchChildren({ rootPath: data.rootPath, scanId: data.scanId, scannedAt: data.scannedAt, dirId: node.id })
      : node.children.map(id => tree.nodeById.get(id)).filter((child): child is NodeRecord => !!child),
    (a, b) => compareNodes(a, b, tree.sortKey, tree.sortDir),
    error => toast.error(String(error)),
  );
  const showRows = bookmarksView || searching || tagFiltering ? resultTree.rows : tree.visibleRows;
  const showFlat = bookmarksView || searching || tagFiltering;
  const showRowsRef = useRef(showRows);
  showRowsRef.current = showRows;
  const actionNodeById = useMemo(() => {
    if (!showFlat) return tree.nodeById;
    return new Map(showRows.map((node) => [node.id, node]));
  }, [showFlat, showRows, tree.nodeById]);
  const actionNodeByIdRef = useRef(actionNodeById);
  actionNodeByIdRef.current = actionNodeById;
  const isFirstChunkRef = useRef(true);
  const lastCompletedPathRef = useRef<string>("");
  const lastScanWasRefreshRef = useRef(false);
  // #5: normalized folder key whose sort/widths the per-folder store currently
  // tracks, plus a one-shot guard so applying a restored entry doesn't trigger
  // an immediate re-save of what we just loaded.
  const folderPrefsKeyRef = useRef<string>("");
  const skipFolderSaveRef = useRef(false);
  const bookmarkSet = useMemo(() => new Set(bookmarkList), [bookmarkList]);

  // Per-tab navigation history: the sequence of scanned root paths the user
  // visited, with `index` pointing at the current entry. User navigations
  // (drill-in, breadcrumb click, "up", sidebar location, scan) push onto the
  // stack (truncating any forward entries); Back/Forward only move the index so
  // they never create spurious entries. A live ref lets the stable Back/Forward
  // callbacks read current state without being re-created each render.
  const [navHistory, setNavHistory] = useState<{ stack: string[]; index: number }>({ stack: [], index: -1 });
  const navHistoryRef = useRef(navHistory);
  navHistoryRef.current = navHistory;

  // Debounced filter box: typing commits to tree state ~180ms after the last
  // keystroke so collectVisibleRows (O(n) over the whole tree) doesn't re-run on
  // every character. The local input stays responsive; external changes (reset,
  // agent) sync back into the box.
  const [filterInput, setFilterInput] = useState(tree.filter);
  useEffect(() => {
    if (filterInput === treeRef.current.filter) return;
    const id = setTimeout(() => treeRef.current.setFilter(filterInput), 180);
    return () => clearTimeout(id);
  }, [filterInput]);
  useEffect(() => { setFilterInput(tree.filter); }, [tree.filter]);

  // Phase 0: dismissal flag for the non-blocking "very large scan" banner. Reset
  // whenever a fresh scan result arrives (see the data effect) so each big scan
  // re-warns once.
  const [largeScanDismissed, setLargeScanDismissed] = useState(false);
  // #11: transient per-node-id highlight (added / size-changed) applied right
  // after a same-root refresh completes; fades after DIFF_HIGHLIGHT_MS.
  const [diffHighlight, setDiffHighlight] = useState<Map<number, "added" | "changed"> | null>(null);
  // #11: prior scan's path→size snapshot, captured just before a refresh starts.
  const prevSizeByPathRef = useRef<Map<string, number> | null>(null);
  const diffTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fsEventsRef = useRef<EventSource | null>(null);
  const v2WatchIdRef = useRef<number | null>(null);
  const watchGenerationRef = useRef(0);
  const watchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingChangesRef = useRef<Set<string>>(new Set());
  // Watcher and in-app mutation paths remain here until their shallow snapshot
  // has been grafted into the loaded tree. Unknown lazy branches stay dirty and
  // are retried when the user expands them; they never force a full drive scan.
  const dirtyDirectoriesRef = useRef<Map<string, string>>(new Map());
  // Paths absent from the immutable scan index need one bounded recursive
  // summary after their parent listing discovers them.
  const aggregateDirectoriesRef = useRef<Set<string>>(new Set());
  const dirtyDirectoryOverflowRef = useRef(false);
  const suppressWatchRef = useRef(false);
  // Skip stacking watch patches: a new batch is dropped/retried while one runs.
  const patchInFlightRef = useRef(false);
  const smartRefreshInFlightRef = useRef(false);
  const refreshToastIdRef = useRef<number | null>(null);
  // Latest path→node map, read inside the async watch flush for gating.
  const nodeByPathRef = useRef<Map<string, NodeRecord>>(new Map());
  const pendingMutationRefreshRef = useRef(false);
  const mutationRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const statusRef = useRef(status);
  statusRef.current = status;

  const doScan = useCallback((path?: string, t?: number, forceFresh?: boolean) => {
    const p = path ?? scanPath;
    if (!p.trim()) return;
    const opts: ScanOptions = {
      path: p.trim(),
      threads: t ?? threads,
      includeHidden,
      followLinks,
      collectOwners,
      excludePatterns: exclude ? exclude.split(",").map((s) => s.trim()).filter(Boolean) : [],
      nocache: forceFresh || undefined,
    };
    const isRefresh = p.trim() === lastCompletedPathRef.current;
    // The user explicitly (re)scanned, so discard pending watcher work that the
    // fresh scan already includes.
    dirtyDirectoriesRef.current.clear();
    aggregateDirectoriesRef.current.clear();
    dirtyDirectoryOverflowRef.current = false;
    if (isRefresh) {
      lastScanWasRefreshRef.current = true;
      // #11: snapshot the current tree's per-path sizes so we can diff-highlight
      // new/changed rows once this same-root refresh lands. Skip on very large
      // trees to keep the snapshot cheap.
      const cur = treeRef.current.nodeById;
      if (cur.size > 0 && cur.size <= DIFF_MAX_NODES) {
        const snap = new Map<string, number>();
        for (const n of cur.values()) if (n.path) snap.set(n.path, n.size);
        prevSizeByPathRef.current = snap;
      } else {
        prevSizeByPathRef.current = null;
      }
      startRefresh(opts);
    } else {
      lastScanWasRefreshRef.current = false;
      prevSizeByPathRef.current = null;
      startScan(opts);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanPath, threads, includeHidden, followLinks, collectOwners, exclude, startScan, startRefresh, tree]);

  const markDirtyDirectories = useCallback((directories: Iterable<string>): string[] => {
    const marked: string[] = [];
    for (const directory of directories) {
      const path = directory.trim();
      if (!path) continue;
      const key = normFolderKey(path);
      if (!dirtyDirectoriesRef.current.has(key)) {
        if (dirtyDirectoriesRef.current.size >= DIRTY_DIRECTORY_MAX) {
          dirtyDirectoryOverflowRef.current = true;
          continue;
        }
        dirtyDirectoriesRef.current.set(key, path);
      }
      marked.push(path);
    }
    return marked;
  }, []);

  const markMutationPathsDirty = useCallback((paths: string[]): string[] => {
    const loadedByKey = new Map<string, NodeRecord>();
    for (const node of nodeByPathRef.current.values()) {
      if (node.path) loadedByKey.set(normFolderKey(node.path), node);
    }
    const directories: string[] = [];
    for (const path of paths) {
      const node = loadedByKey.get(normFolderKey(path));
      if (node?.dir) directories.push(node.path);
      const parent = parentDirOf(path);
      if (parent) directories.push(parent);
    }
    return markDirtyDirectories(directories);
  }, [markDirtyDirectories]);

  const refreshDirectories = useCallback(async (directories: Iterable<string>): Promise<number> => {
    if (statusRef.current === "scanning" || patchInFlightRef.current) return 0;

    const loadedByKey = new Map<string, NodeRecord>();
    for (const node of nodeByPathRef.current.values()) {
      if (node.dir && node.path) loadedByKey.set(normFolderKey(node.path), node);
    }
    const requested = new Map<string, {
      path: string;
      recursiveAggregates: boolean;
      scanId?: string;
      directoryId?: number;
    }>();
    for (const directory of directories) {
      const key = normFolderKey(directory);
      const loaded = loadedByKey.get(key);
      if (loaded) {
        requested.set(key, {
          path: loaded.path,
          // Watcher-created directories are absent from the immutable SQLite
          // index. Fill their recursive totals once, while ordinary refreshes
          // remain cheap one-level listings.
          recursiveAggregates: aggregateDirectoriesRef.current.has(key)
            || (isLiveNodeId(loaded.id)
              && loaded.size === 0
              && loaded.files === 0
              && loaded.folders === 0),
          scanId: dataRef.current?.scanId,
          directoryId: isLiveNodeId(loaded.id) ? undefined : loaded.id,
        });
      }
    }
    if (requested.size === 0) {
      return 0;
    }

    patchInFlightRef.current = true;
    let patched = 0;
    const entries = Array.from(requested.entries());
    const refreshedDirectories = new Set<string>();
    const failedSnapshots: Array<{ key: string; dir: string }> = [];
    try {
      for (let offset = 0; offset < entries.length; offset += WATCH_MAX_BATCH) {
        const batch = entries.slice(offset, offset + WATCH_MAX_BATCH);
        const refreshed = await Promise.all(batch.map(async ([key, request]) => {
          invalidateScanCache(request.path);
          try {
            if (isTauriV2()) {
              const nodes = await fetchV2DirectorySnapshot(
                request.path,
                request.recursiveAggregates,
                request.scanId,
                request.directoryId,
              );
              return nodes.length ? {
                key,
                dir: request.path,
                nodes,
                recursiveAggregates: request.recursiveAggregates,
              } : null;
            }
            const result = await fetchScanStream({
              path: request.path,
              threads,
              includeHidden,
              followLinks,
              collectOwners,
              excludePatterns: exclude ? exclude.split(",").map((s) => s.trim()).filter(Boolean) : [],
              maxDepth: 1,
              nocache: true,
            });
            return result?.nodes?.length ? {
              key,
              dir: request.path,
              nodes: result.nodes,
              recursiveAggregates: request.recursiveAggregates,
            } : null;
          } catch {
            return null;
          }
        }));
        for (const snapshot of refreshed) {
          if (!snapshot) continue;
          const targetBeforePatch = loadedByKey.get(snapshot.key);
          const listingWasLoaded = !dataRef.current?.lazy
            || targetBeforePatch?.id === 0
            || (targetBeforePatch != null && treeRef.current.loadedDirs.has(targetBeforePatch.id));
          const aggregateFollowups: string[] = [];
          if (!snapshot.recursiveAggregates && listingWasLoaded) {
            for (const child of snapshot.nodes) {
              if (!child.dir || child.id === 0 || !child.path) continue;
              const childKey = normFolderKey(child.path);
              const existing = loadedByKey.get(childKey);
              const unresolvedLiveDirectory = existing != null
                && isLiveNodeId(existing.id)
                && existing.size === 0
                && existing.files === 0
                && existing.folders === 0;
              if (child.aggregateKnown !== true && (!existing || unresolvedLiveDirectory)) {
                aggregateDirectoriesRef.current.add(childKey);
                aggregateFollowups.push(child.path);
              }
            }
          }
          treeRef.current.patchDirectory(snapshot.dir, snapshot.nodes);
          dirtyDirectoriesRef.current.delete(snapshot.key);
          if (snapshot.recursiveAggregates) aggregateDirectoriesRef.current.delete(snapshot.key);
          if (aggregateFollowups.length > 0) markDirtyDirectories(aggregateFollowups);
          refreshedDirectories.add(snapshot.key);
          patched++;
        }
        for (let batchIndex = 0; batchIndex < batch.length; batchIndex++) {
          if (!refreshed[batchIndex]) {
            const [key, request] = batch[batchIndex];
            failedSnapshots.push({ key, dir: request.path });
          }
        }
      }
      // A removed or renamed directory cannot be snapshotted after its event.
      // Once its parent snapshot succeeds, that listing is authoritative and
      // the vanished child must not leave the tab permanently marked stale.
      for (const failed of failedSnapshots) {
        if (refreshedDirectories.has(normFolderKey(parentDir(failed.dir)))) {
          dirtyDirectoriesRef.current.delete(failed.key);
        }
      }
    } finally {
      patchInFlightRef.current = false;
    }
    return patched;
  }, [threads, includeHidden, followLinks, collectOwners, exclude, markDirtyDirectories]);

  const schedulePendingMutationRefresh = useCallback(() => {
    if (!pendingMutationRefreshRef.current || !activeRef.current || statusRef.current === "scanning") return;
    if (mutationRefreshTimerRef.current) clearTimeout(mutationRefreshTimerRef.current);
    mutationRefreshTimerRef.current = setTimeout(() => {
      mutationRefreshTimerRef.current = null;
      if (!pendingMutationRefreshRef.current || !activeRef.current || statusRef.current === "scanning") return;
      if (patchInFlightRef.current) {
        schedulePendingMutationRefresh();
        return;
      }
      pendingMutationRefreshRef.current = false;
      void refreshDirectories(dirtyDirectoriesRef.current.values());
    }, 120);
  }, [refreshDirectories]);

  // Tauri v2 has no loopback HTTP server, so app-initiated mutations are
  // broadcast directly between mounted workspace tabs. Visible affected tabs
  // refresh promptly; inactive tabs retain only a pending bit and refresh when
  // selected, preserving the v2 bounded-memory design.
  useEffect(() => subscribeFilesystemMutations((mutation) => {
    if (mutation.sourceTabId === tabId) return;
    const rootPath = dataRef.current?.rootPath || lastCompletedPathRef.current || scanPath;
    if (!rootPath || !mutationAffectsRoot(rootPath, mutation.paths)) return;
    markMutationPathsDirty(mutation.paths);
    pendingMutationRefreshRef.current = true;
    schedulePendingMutationRefresh();
  }), [markMutationPathsDirty, scanPath, schedulePendingMutationRefresh, tabId]);

  useEffect(() => {
    schedulePendingMutationRefresh();
  }, [active, status, schedulePendingMutationRefresh]);

  useEffect(() => () => {
    if (mutationRefreshTimerRef.current) clearTimeout(mutationRefreshTimerRef.current);
  }, []);

  const refreshAfterMutation = useCallback((changedPaths: string[]) => {
    suppressWatchRef.current = false;
    publishFilesystemMutation(changedPaths, tabId);
    markMutationPathsDirty(changedPaths);
    pendingMutationRefreshRef.current = true;
    schedulePendingMutationRefresh();
  }, [markMutationPathsDirty, schedulePendingMutationRefresh, tabId]);

  // LAZY: when a cached page is stale, queue a shallow root reconciliation.
  // The user's explicit Scan action remains the only path to a deep rebuild.
  onStaleRef.current = () => {
    const p = lastCompletedPathRef.current || scanPath;
    if (p && p.trim()) markDirtyDirectories([p]);
  };

  // Toggling owner collection only changes data on the next walk, so re-scan the
  // current root (forced fresh) when it flips — but never on the initial mount /
  // settings hydration before any scan has completed.
  const ownersHydratedRef = useRef(false);
  useEffect(() => {
    if (!ownersHydratedRef.current) { ownersHydratedRef.current = true; return; }
    if (status !== "scanning" && lastCompletedPathRef.current) {
      doScan(lastCompletedPathRef.current, undefined, true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectOwners]);

  const hasStartedRef = useRef(false);
  useEffect(() => {
    // Restored tabs are cheap handles until selected. Starting every persisted
    // tab at launch opened several SQLite connections and filled page-cache
    // entries that an inactive pane could not display.
    if (active && initialPath && !hasStartedRef.current) {
      hasStartedRef.current = true;
      doScan(initialPath, undefined, true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, initialPath]);

  useEffect(() => {
    // A scan may finish just after its tab was deactivated. Do not let that late
    // result repopulate renderer rows or the shared page cache.
    if (!active && data?.lazy) {
      if (data.scanId) releaseV2ScanPages(data.scanId);
      tree.setNodes([]);
      return;
    }
    if (data === null) {
      tree.setNodes([]);
      isFirstChunkRef.current = true;
    } else if (lastScanWasRefreshRef.current) {
      tree.setNodes(data.nodes ?? []);
      suppressWatchRef.current = false;
      // #11: diff the freshly-refreshed nodes against the pre-refresh snapshot
      // and tint new (added) and size-changed rows; the tint fades on a timer.
      const prev = prevSizeByPathRef.current;
      if (prev && data.nodes && data.nodes.length <= DIFF_MAX_NODES) {
        const marks = new Map<number, "added" | "changed">();
        for (const n of data.nodes) {
          if (!n.path || n.id < 0) continue;
          const old = prev.get(n.path);
          if (old === undefined) marks.set(n.id, "added");
          else if (old !== n.size) marks.set(n.id, "changed");
        }
        if (diffTimerRef.current) clearTimeout(diffTimerRef.current);
        if (marks.size > 0) {
          setDiffHighlight(marks);
          diffTimerRef.current = setTimeout(() => setDiffHighlight(null), DIFF_HIGHLIGHT_MS);
        } else {
          setDiffHighlight(null);
        }
      }
      prevSizeByPathRef.current = null;
    } else {
      tree.setNodes(data.nodes ?? []);
      if (isFirstChunkRef.current) {
        const isSamePath = data.rootPath === lastCompletedPathRef.current;
        if (!isSamePath) tree.resetForNewScan();
        isFirstChunkRef.current = false;
      }
    }
    // Phase 0: re-arm the very-large-scan banner for each freshly-arrived result.
    if (data) setLargeScanDismissed(false);
    onStateChange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, active]);

  // LAZY: wait until setNodes has actually committed the streamed root before
  // requesting its children. Calling ensureChildren in the data effect above
  // could race React's state commit and leave an expanded but empty root.
  useEffect(() => {
    if (!active || !data?.lazy || !tree.nodeById.has(0)) return;
    tree.ensureChildren(0);
  }, [active, data?.lazy, data?.rootPath, data?.scannedAt, tree.nodeById, tree.ensureChildren]);

  // Status transitions (idle→scanning→done/…) are rare and meaningful, so they
  // notify App. Progress ticks deliberately do NOT live here anymore: they flow
  // through progressStore to the status-bar counter + scan overlay only, so a
  // scan no longer re-renders App/this pane on every tick.
  useEffect(() => { onStateChange(); }, [status, onStateChange]);

  // The scan-path doubles as this pane's tab label (title bar + tab strip show
  // its basename), so a path edit is shell-relevant — tick App (throttled) when
  // focused. Kept out of the high-frequency tree effect below so expand / filter
  // / select still never reach the shell.
  useEffect(() => { if (active) onStateChange(); }, [scanPath, active, onStateChange]);

  // These are durable per-tab presentation settings. Notify the shell so its
  // debounced session snapshot includes the latest value (including a final
  // column resize); selection, hover, and expansion remain on the workbench-only
  // path and do not re-render App.
  useEffect(() => {
    if (active) onStateChange();
  }, [
    active,
    tree.metric,
    tree.unit,
    tree.showFiles,
    tree.sortKey,
    tree.sortDir,
    tree.columnWidths,
    onStateChange,
  ]);

  // The Explorer side bar / status bar / inspector live once in App (shared,
  // around the editor groups) and pull their data from the focused pane's
  // getSidebarModel(). When THIS is the visible tab, publish to the workbench
  // store on tree/selection/path changes so ONLY those subscribers re-render —
  // App's title bar/menus/tab bar stay put. data/status changes also publish via
  // onStateChange above (which keeps the shell's scan-level state in sync too).
  useEffect(() => {
    if (active) onWorkbenchChange();
  }, [
    active,
    tree.visibleRows,
    tree.expanded,
    tree.expandedAll,
    tree.collapsedOverrides,
    tree.selectedId,
    tree.nodeById,
    tree.loadedDirs,
    tree.metric,
    tree.unit,
    selectedIds,
    scanPath,
    onWorkbenchChange,
  ]);

  const startWatch = useCallback((rootPath: string) => {
    const generation = ++watchGenerationRef.current;
    if (fsEventsRef.current) { fsEventsRef.current.close(); fsEventsRef.current = null; }
    if (v2WatchIdRef.current != null) {
      void stopV2FilesystemWatch(v2WatchIdRef.current);
      v2WatchIdRef.current = null;
    }
    if (watchDebounceRef.current) { clearTimeout(watchDebounceRef.current); watchDebounceRef.current = null; }
    pendingChangesRef.current.clear();

    // Coalesced + gated flush. A big drive (e.g. C:\) churns logs/registry/temp
    // nonstop; patching every change would rebuild the whole node array each
    // time. Native events arrive pre-batched, then we gate them to open/visible
    // directories and never stack patches.
    async function flushWatch() {
      watchDebounceRef.current = null;
      if (patchInFlightRef.current) {
        // A patch is still running — retry shortly without losing pending dirs.
        watchDebounceRef.current = setTimeout(flushWatch, WATCH_DEBOUNCE_MS);
        return;
      }
      if (suppressWatchRef.current) { pendingChangesRef.current.clear(); return; }

      const byPath = new Map<string, NodeRecord>();
      for (const node of nodeByPathRef.current.values()) {
        if (node.dir && node.path) byPath.set(normFolderKey(node.path), node);
      }

      // Patch every changed directory that is already represented in the lazy
      // tree, including collapsed rows. Unloaded branches remain in the dirty
      // queue and are retried when they become visible.
      const dirs: string[] = [];
      for (const d of pendingChangesRef.current) {
        const node = byPath.get(normFolderKey(d));
        if (node) dirs.push(node.path);
      }
      pendingChangesRef.current.clear();
      if (dirs.length === 0) return;

      await refreshDirectories(dirs);
    }

    const queueChangedDirectories = (changedDirs: string[]) => {
      markDirtyDirectories(changedDirs);
      for (const changedDir of changedDirs) pendingChangesRef.current.add(changedDir);
      // Leading-edge: schedule once, don't reset on every event during a storm.
      if (!watchDebounceRef.current) {
        watchDebounceRef.current = setTimeout(flushWatch, WATCH_DEBOUNCE_MS);
      }
    };

    if (isTauriV2()) {
      void startV2FilesystemWatch(rootPath, queueChangedDirectories)
        .then((watchId) => {
          if (generation !== watchGenerationRef.current || !activeRef.current) {
            void stopV2FilesystemWatch(watchId);
            return;
          }
          v2WatchIdRef.current = watchId;
          const reconcileLoadedBranches = () => {
            if (generation !== watchGenerationRef.current || !activeRef.current) return;
            const visibleDirectories = new Set<string>([rootPath]);
            const currentTree = treeRef.current;
            for (const node of currentTree.nodeById.values()) {
              if (
                node.dir
                && node.path
                && isNodeOpen(
                  node.id,
                  currentTree.expanded,
                  currentTree.expandedAll,
                  currentTree.collapsedOverrides,
                )
              ) {
                visibleDirectories.add(node.path);
              }
            }
            queueChangedDirectories(Array.from(visibleDirectories));
          };
          // Reconcile restored rows immediately, then once more after lazy
          // expansion state has rehydrated from the SQLite page cache.
          reconcileLoadedBranches();
          window.setTimeout(reconcileLoadedBranches, 500);
        })
        .catch((error: unknown) => {
          console.warn("Could not start the native filesystem watcher", error);
        });
      return;
    }

    const url = `/api/fs-events?path=${encodeURIComponent(rootPath)}`;
    const es = new EventSource(url);
    fsEventsRef.current = es;
    es.onmessage = (evt) => {
      try { queueChangedDirectories([JSON.parse(evt.data) as string]); }
      catch { /* ignore malformed legacy watcher messages */ }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markDirtyDirectories, refreshDirectories]);

  useEffect(() => () => {
    watchGenerationRef.current++;
    fsEventsRef.current?.close();
    if (v2WatchIdRef.current != null) void stopV2FilesystemWatch(v2WatchIdRef.current);
  }, []);

  useEffect(() => {
    if (status === "done" && data) {
      lastCompletedPathRef.current = data.rootPath;
      // #5: when navigating into a DIFFERENT folder, restore its saved sort +
      // column widths (if any). Same-folder refreshes keep the user's current
      // sort untouched. The skip guard prevents the restore from re-saving.
      const prefsKey = normFolderKey(data.rootPath);
      if (prefsKey !== folderPrefsKeyRef.current) {
        folderPrefsKeyRef.current = prefsKey;
        const saved = loadFolderPref(prefsKey);
        if (saved) {
          skipFolderSaveRef.current = true;
          treeRef.current.setSort(saved.sortKey, saved.sortDir);
          treeRef.current.setColumnWidthsAll(saved.columnWidths ?? {});
          setTimeout(() => { skipFolderSaveRef.current = false; }, 0);
        }
      }
      if (active) startWatch(data.rootPath);
      // Seed history with the very first completed root (initial/restored scan).
      // Subsequent navigations push via openLocation; this only fires once.
      setNavHistory((prev) => (prev.index === -1 ? { stack: [data.rootPath], index: 0 } : prev));
    }
    if (status === "scanning") {
      watchGenerationRef.current++;
      fsEventsRef.current?.close();
      fsEventsRef.current = null;
      if (v2WatchIdRef.current != null) {
        void stopV2FilesystemWatch(v2WatchIdRef.current);
        v2WatchIdRef.current = null;
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // #5: persist this folder's sort + column widths whenever the user changes
  // them. Skipped while a restore is being applied (above) and before any scan
  // has completed (no folder key yet). Capped LRU store lives in folderPrefs.
  useEffect(() => {
    if (skipFolderSaveRef.current) return;
    const key = folderPrefsKeyRef.current;
    if (!key) return;
    saveFolderPref(key, {
      sortKey: tree.sortKey,
      sortDir: tree.sortDir,
      columnWidths: tree.columnWidths,
    });
  }, [tree.sortKey, tree.sortDir, tree.columnWidths]);

  useEffect(() => {
    if (!active) {
      watchGenerationRef.current++;
      fsEventsRef.current?.close();
      fsEventsRef.current = null;
      if (v2WatchIdRef.current != null) {
        void stopV2FilesystemWatch(v2WatchIdRef.current);
        v2WatchIdRef.current = null;
      }
      if (watchDebounceRef.current) { clearTimeout(watchDebounceRef.current); watchDebounceRef.current = null; }
      if (data?.lazy) {
        if (data.scanId) releaseV2ScanPages(data.scanId);
        treeRef.current.setNodes([]);
      }
    } else if (status === "done" && data) {
      if (data.lazy && !treeRef.current.nodeById.has(0)) {
        treeRef.current.setNodes(data.nodes ?? []);
      }
      startWatch(data.rootPath);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Rehydrate open lazy branches a level at a time after an inactive tab
  // releases pages. Expand All also discovers newly-loaded folders recursively;
  // the small batch keeps a large drive from launching thousands of requests at
  // once while the node cache applies its normal retention bound.
  useEffect(() => {
    if (!active || !data?.lazy) return;
    let requested = 0;
    for (const node of tree.nodeById.values()) {
      if (
        requested >= 12
        || !node.dir
        || tree.loadedDirs.has(node.id)
        || !isNodeOpen(
          node.id,
          tree.expanded,
          tree.expandedAll,
          tree.collapsedOverrides,
        )
      ) continue;
      tree.ensureChildren(node.id);
      requested++;
    }
  }, [
    active,
    data?.lazy,
    tree.expanded,
    tree.expandedAll,
    tree.collapsedOverrides,
    tree.loadedDirs,
    tree.nodeById,
    tree.ensureChildren,
  ]);

  // Opening a previously-unloaded lazy branch makes any retained watcher path
  // patchable. Retry only those newly-known dirty directories; no deep scan.
  useEffect(() => {
    if (!active || status !== "done" || dirtyDirectoriesRef.current.size === 0) return;
    const loadedKeys = new Set<string>();
    for (const node of tree.nodeById.values()) {
      if (node.dir && node.path) loadedKeys.add(normFolderKey(node.path));
    }
    const ready = Array.from(dirtyDirectoriesRef.current.entries())
      .filter(([key]) => loadedKeys.has(key))
      .slice(0, WATCH_MAX_BATCH)
      .map(([, path]) => path);
    if (ready.length > 0) void refreshDirectories(ready);
  }, [active, status, tree.nodeById, refreshDirectories]);

  // Record a user navigation in the history stack. Drops any forward entries
  // (classic browser semantics) and skips no-op pushes when re-navigating to
  // the entry we're already on (e.g. a refresh of the current root).
  const pushHistory = useCallback((path: string) => {
    setNavHistory((prev) => {
      const cur = prev.index >= 0 ? prev.stack[prev.index] : undefined;
      if (cur != null && samePath(cur, path)) return prev;
      const base = prev.stack.slice(0, prev.index + 1);
      base.push(path);
      const overflow = Math.max(0, base.length - HISTORY_MAX);
      const stack = overflow ? base.slice(overflow) : base;
      return { stack, index: stack.length - 1 };
    });
  }, []);

  // Scan a path inside THIS tab (no upward propagation/double-scan). This is the
  // single funnel for user-initiated root navigations (sidebar location, drill-
  // in, breadcrumb, "up", scan button) so they all record history consistently.
  // cancelScan() first so a navigation during an in-flight scan isn't dropped by
  // startScan's "already scanning" guard.
  const openLocation = useCallback((path: string) => {
    if (!path.trim()) return;
    cancelScan();
    setScanPathState(path);
    onScanPath(path); // record recent only
    pushHistory(path.trim());
    doScan(path);
  }, [cancelScan, doScan, onScanPath, pushHistory]);

  // Back/Forward replay a previously-visited root WITHOUT pushing new history;
  // they only move the index. Guarded so they no-op at the ends of the stack.
  const goBack = useCallback(() => {
    const h = navHistoryRef.current;
    if (h.index <= 0) return;
    const target = h.stack[h.index - 1];
    setNavHistory({ stack: h.stack, index: h.index - 1 });
    cancelScan();
    setScanPathState(target);
    onScanPath(target);
    doScan(target);
  }, [cancelScan, doScan, onScanPath]);

  const goForward = useCallback(() => {
    const h = navHistoryRef.current;
    if (h.index >= h.stack.length - 1) return;
    const target = h.stack[h.index + 1];
    setNavHistory({ stack: h.stack, index: h.index + 1 });
    cancelScan();
    setScanPathState(target);
    onScanPath(target);
    doScan(target);
  }, [cancelScan, doScan, onScanPath]);

  // Stable identity (reads tree via ref) so TreeTable's React.memo holds across
  // unrelated parent re-renders.
  const handleSelectRow = useCallback((id: number, mode: "single" | "toggle" | "range") => {
    const t = treeRef.current;
    const node = actionNodeByIdRef.current.get(id);
    if (!node || node.id < 0 || !node.path) return;

    if (mode === "range") {
      const rows = showRowsRef.current;
      const anchorId = selectionAnchorIdRef.current;
      const anchorIndex = rows.findIndex((row) => row.id === anchorId);
      const targetIndex = rows.findIndex((row) => row.id === id);
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const [start, end] = anchorIndex < targetIndex
          ? [anchorIndex, targetIndex]
          : [targetIndex, anchorIndex];
        const rangeIds = rows
          .slice(start, end + 1)
          .filter((row) => row.id >= 0 && !!row.path)
          .map((row) => row.id);
        setSelectedIds(new Set(rangeIds));
        t.setSelectedId(id);
        return;
      }
    }

    if (mode === "toggle") {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id) && next.size > 1) {
          next.delete(id);
          if (t.selectedId === id) {
            const nextPrimary = next.values().next().value as number | undefined;
            t.setSelectedId(nextPrimary ?? id);
          }
        } else {
          next.add(id);
          t.setSelectedId(id);
          selectionAnchorIdRef.current = id;
        }
        return next;
      });
      return;
    }

    selectionAnchorIdRef.current = id;
    setSelectedIds(new Set([id]));
    t.setSelectedId(id);
  }, []);

  // Ctrl+A from the table: select every currently-visible selectable row (#2).
  // TreeTable supplies the id list (scoped to its rendered rows), so this works
  // for the tree, search and tag-filtered views alike. Anchor the range at the
  // first row and make the last the active/primary so a following Shift+Arrow
  // extends sensibly.
  const handleSelectAllRows = useCallback((ids: number[]) => {
    if (ids.length === 0) return;
    selectionAnchorIdRef.current = ids[0];
    setSelectedIds(new Set(ids));
    treeRef.current.setSelectedId(ids[ids.length - 1]);
  }, []);

  // Quick "Compress" row action. Persisted folders stay as compact scan/id
  // descriptors: their recursive file count and size were aggregated during
  // scanning, and Rust resolves the paths only when the job starts. This keeps
  // a 500K-file folder from crossing IPC just to open the setup page.
  const handleCompress = useCallback((id: number) => {
    const t = treeRef.current;
    const currentNodes = actionNodeByIdRef.current;
    const selIds = selectedIdsRef.current;
    const rawTargetIds = selIds.has(id) && selIds.size > 1 ? [...selIds] : [id];
    const targetSet = new Set(rawTargetIds);
    const targetIds = rawTargetIds.filter((targetId) => {
      // Keep explicitly selected files even when their parent folder is also
      // selected: a watcher may have added them after the immutable scan index
      // was written. Rust deduplicates files that are already in the index.
      if (!currentNodes.get(targetId)?.dir) return true;
      let parent = currentNodes.get(targetId)?.parent;
      while (parent != null) {
        if (targetSet.has(parent)) return false;
        parent = currentNodes.get(parent)?.parent ?? t.nodeById.get(parent)?.parent;
      }
      return true;
    });
    const scan = dataRef.current;
    const scanId = scan?.scanId;
    const sources: CompressionSource[] = [];
    const seen = new Set<string>();
    const normalizePath = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const pushFilePath = (p: string, size = 0) => {
      const key = normalizePath(p);
      if (!p || seen.has(key)) return;
      seen.add(key);
      sources.push({ path: p, size });
    };
    const pushFile = (node: NodeRecord) => {
      if (node.dir || node.id < 0 || !node.path) return;
      pushFilePath(node.path, node.size);
    };

    for (const tid of targetIds) {
      const node = currentNodes.get(tid);
      if (!node) continue;
      if (!node.dir) {
        pushFile(node);
        continue;
      }
      if (scanId && node.id >= 0 && node.path) {
        sources.push({
          sourceType: "scan-directory",
          scanId,
          directoryId: node.id,
          path: node.path,
          name: node.name,
          size: node.size,
          fileCount: node.files,
        });
        continue;
      }
      // Browser/headless fallback: only full trees lack a persisted scan id.
      const queue = [node.id];
      for (let qi = 0; qi < queue.length; qi++) {
        const cur = t.nodeById.get(queue[qi]);
        if (!cur) continue;
        if (!cur.dir) { pushFile(cur); continue; }
        for (const childId of cur.children) queue.push(childId);
      }
    }
    if (sources.length > 0) onCompress(sources);
    else toast.info("This selection has no files to compress.");
  }, [onCompress]);

  // Latest value of the configurable double-click action, read inside the stable
  // handleDblClick callback without re-creating it (#7).
  const folderDblClickExplorerRef = useRef(folderDblClickExplorer);
  folderDblClickExplorerRef.current = folderDblClickExplorer;

  const handleDblClick = useCallback((node: NodeRecord) => {
    if (node.dir) {
      if (!folderDblClickExplorerRef.current) {
        openLocation(node.path);
        return;
      }
      void openPath(node.path).catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : String(error));
      });
      return;
    }
    void openPath(node.path).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : String(error));
    });
  }, [openLocation]);

  const handleSortChange = useCallback((k: SortKey) => { treeRef.current.setSortKey(k); }, []);

  // Stable identity (reads tree via ref) so the memoized Treemap/SideBar don't
  // re-render every time the tree object is recreated.
  const handleNavigate = useCallback((id: number) => {
    const t = treeRef.current;
    let node = t.nodeById.get(id);
    while (node && node.parent != null) {
      t.ensureExpanded(node.parent);
      node = t.nodeById.get(node.parent);
    }
    if (id >= 0 && t.nodeById.get(id)?.dir) t.ensureChildren(id);
    t.setSelectedId(id);
  }, []);

  // "Up one level" navigates the scanned ROOT to its parent folder (Explorer
  // parity) and records history. No-ops at a volume/UNC root.
  const handleNavigateParent = useCallback(() => {
    const root = lastCompletedPathRef.current || scanPath;
    const parent = parentDirOf(root);
    if (parent && !samePath(parent, root)) openLocation(parent);
  }, [scanPath, openLocation]);

  const handleExpand = useCallback((level: number) => { tree.expandToLevel(level); }, [tree]);

  const handleNewFolder = useCallback(async () => {
    const selected = actionNodeByIdRef.current.get(tree.selectedId);
    const base = selected?.dir
      ? selected.path
      : selected?.path
        ? parentDir(selected.path)
        : scanPath;
    const name = await promptDialog({
      title: "New folder",
      label: "Folder name",
      placeholder: "New folder",
      confirmLabel: "Create",
      validate: (v) =>
        /[\\/:*?"<>|]/.test(v) ? 'A name can\u2019t contain \\ / : * ? " < > |' : null,
    });
    if (name == null) return; // canceled
    const sep = base.endsWith("\\") || base.endsWith("/") ? "" : "\\";
    const full = base + sep + name.trim();
    try {
      await createFolder(full);
      // Phase 6 undo: removing the folder on Ctrl+Z is safe only while it stays
      // empty (the executor checks before deleting), so this never loses files.
      pushUndo({ kind: "mkdir", path: full });
      refreshAfterMutation([full]);
    } catch (e) {
      toast.error(`Could not create folder: ${e instanceof Error ? e.message : e}`);
    }
  }, [tree, scanPath, refreshAfterMutation]);

  const handleTreemapOpen = useCallback((id: number) => {
    const node = treeRef.current.nodeById.get(id);
    if (node && !node.dir && node.path) openPath(node.path);
  }, []);

  // Flat views deliberately scope commands to their displayed rows. This keeps
  // a selection from an earlier search from targeting an item now hidden by a
  // different query.
  const selectedNode = actionNodeById.get(tree.selectedId);
  const selectedNodes = useMemo(() => {
    const nodes = Array.from(selectedIds)
      .map((id) => actionNodeById.get(id))
      .filter((node): node is NodeRecord => !!node && node.id >= 0 && !!node.path);
    return nodes.length > 0 ? nodes : selectedNode?.path ? [selectedNode] : [];
  }, [actionNodeById, selectedIds, selectedNode]);
  const nodeByPath = useMemo(() => {
    const map = new Map<string, NodeRecord>();
    for (const node of tree.nodeById.values()) {
      if (node.path) map.set(node.path, node);
    }
    for (const node of actionNodeById.values()) {
      if (node.path) map.set(node.path, node);
    }
    return map;
  }, [actionNodeById, tree.nodeById]);
  nodeByPathRef.current = nodeByPath;
  const selectedPaths = useMemo(() => {
    const selectedByPath = new Map(selectedNodes.map((node) => [node.path, node]));
    return dedupeNestedPaths(selectedNodes.map((node) => node.path), selectedByPath);
  }, [selectedNodes]);

  // Selection summary for the status bar. Count is every selected row; total
  // size sums only top-level-selected nodes (those whose parent is NOT also
  // selected) so a folder + its selected descendants aren't double-counted.
  const selectionSummary = useMemo(() => {
    let count = 0;
    let bytes = 0;
    for (const node of selectedNodes) {
      count++;
      if (node.parent != null && selectedIds.has(node.parent)) continue;
      bytes += node.size;
    }
    return { count, bytes };
  }, [selectedIds, selectedNodes]);

  // Copy the current selection to the clipboard as a TSV table (header + one row
  // per selected node, in the active sort order) — pastes cleanly into Excel /
  // Sheets. Sourced from the same selection the status-bar summary uses.
  const runCopyAsTable = useCallback(() => {
    const t = treeRef.current;
    const currentNodes = actionNodeByIdRef.current;
    const nodes = Array.from(selectedIdsRef.current)
      .map((id) => currentNodes.get(id))
      .filter((n): n is NodeRecord => !!n && n.id >= 0 && !!n.path);
    if (nodes.length === 0) { toast.info("Select one or more items to copy."); return; }
    nodes.sort((a, b) => compareNodes(a, b, t.sortKey, t.sortDir));
    const header = ["Name", "Size", "Type", "Modified", "Full path"];
    const lines = [header.join("\t")];
    for (const n of nodes) {
      const type = n.dir ? "Folder" : (n.extension ? n.extension.toLowerCase() : "File");
      const modified = n.modified ? formatDate(n.modified) : "";
      // Strip tabs/newlines from cell values so the TSV grid stays intact.
      const cells = [n.name, formatBytes(n.size, t.unit), type, modified, n.path]
        .map((c) => String(c).replace(/[\t\r\n]+/g, " "));
      lines.push(cells.join("\t"));
    }
    const tsv = lines.join("\r\n");
    navigator.clipboard.writeText(tsv)
      .then(() => toast.success(`Copied ${nodes.length} row${nodes.length === 1 ? "" : "s"}`))
      .catch(() => toast.error("Could not copy to the clipboard."));
  }, []);

  useEffect(() => {
    const activeNode = actionNodeById.get(tree.selectedId);
    const valid = new Set(Array.from(selectedIds).filter((id) => actionNodeById.has(id)));
    let next: Set<number>;
    if (activeNode?.path && activeNode.id >= 0) {
      next = valid.has(tree.selectedId) ? valid : new Set([tree.selectedId]);
    } else if (valid.size > 0) {
      next = valid;
      const nextPrimary = valid.values().next().value as number;
      if (tree.selectedId !== nextPrimary) tree.setSelectedId(nextPrimary);
    } else if (showFlat) {
      next = new Set();
      if (tree.selectedId !== -1) tree.setSelectedId(-1);
    } else {
      const fallback = tree.nodeById.get(0) ?? tree.visibleRows.find((node) => node.id >= 0);
      next = fallback ? new Set([fallback.id]) : new Set();
      if (fallback && tree.selectedId !== fallback.id) tree.setSelectedId(fallback.id);
    }
    const unchanged = next.size === selectedIds.size
      && Array.from(next).every((id) => selectedIds.has(id));
    if (!unchanged) {
      if (next.size > 0) {
        selectionAnchorIdRef.current = next.values().next().value as number;
      }
      setSelectedIds(next);
    }
  }, [
    actionNodeById,
    selectedIds,
    showFlat,
    tree.nodeById,
    tree.selectedId,
    tree.setSelectedId,
    tree.visibleRows,
  ]);

  const runReveal   = useCallback(() => { if (selectedNode) revealPath(selectedNode.path); }, [selectedNode]);
  const runOpen     = useCallback(() => { if (selectedNode) openPath(selectedNode.path); }, [selectedNode]);
  const runCopyPath = useCallback(() => { if (selectedNode) copyPath(selectedNode.path).catch(() => {}); }, [selectedNode]);

  // Open the integrated terminal at the selected folder (a file → its folder),
  // falling back to the scanned root.
  const handleOpenTerminal = useCallback(() => {
    let cwd = data?.rootPath || scanPath;
    if (selectedNode?.path) {
      cwd = selectedNode.dir
        ? selectedNode.path
        : parentDirOf(selectedNode.path) || cwd;
    }
    onOpenTerminal?.(cwd);
  }, [selectedNode, data, scanPath, onOpenTerminal]);

  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [bulkRenameOpen, setBulkRenameOpen] = useState(false);
  // Tag editing popover anchored at the clicked row's tag badge (F4).
  const [tagPopover, setTagPopover] = useState<{ path: string; x: number; y: number } | null>(null);

  const runRenamePath = useCallback((targetPath?: string) => {
    const pathToRename = targetPath ?? selectedNode?.path;
    if (!pathToRename) return;
    const id = nodeByPath.get(pathToRename)?.id
      ?? (pathToRename === selectedNode?.path ? selectedNode?.id : undefined);
    if (id == null) return;
    tree.setSelectedId(id);
    setRenamingId(id);
  }, [selectedNode, nodeByPath, tree]);

  const runRename = useCallback(() => { runRenamePath(); }, [runRenamePath]);
  const cancelRename = useCallback(() => setRenamingId(null), []);

  const commitRename = useCallback(async (id: number, rawName: string) => {
    setRenamingId(null);
    const node = actionNodeByIdRef.current.get(id);
    if (!node) return;
    const newName = rawName.trim();
    if (!newName || newName === node.name) return;
    const result = await renameItem(node.path, newName);
    if (!result.ok) { toast.error(`Rename failed: ${result.error ?? "unknown error"}`); return; }
    // Phase 6: record the reverse (rename back to the original name) for Ctrl+Z.
    pushUndo({ kind: "rename", parent: parentDir(node.path), from: node.name, to: newName });
    toast.success(`Renamed to \u201C${newName}\u201D.`, { action: undoAction });
    refreshAfterMutation([parentDir(node.path)]);
  }, [refreshAfterMutation, undoAction]);

  const runDeletePaths = useCallback(async (paths?: string[], permanent = false) => {
    const targetPaths = paths && paths.length > 0 ? dedupeNestedPaths(paths, nodeByPath) : selectedPaths;
    if (targetPaths.length === 0) return;
    const nameOf = (p: string) => nodeByPath.get(p)?.name ?? basenameFromPath(p);
    // Risk-scoped confirm (Phase 4): a permanent delete always prompts (it's
    // irreversible); a recyclable delete prompts only for a large/many batch.
    // A small recyclable delete is recoverable from the Recycle Bin (and now
    // audited), so it stays frictionless — no prompt.
    const totalBytes = targetPaths.reduce((sum, p) => sum + (nodeByPath.get(p)?.size ?? 0), 0);
    const proceed = await confirmRisky({
      kind: "delete",
      permanent,
      itemCount: targetPaths.length,
      totalBytes,
      names: targetPaths.map(nameOf),
    });
    if (!proceed) return;
    // Aggregate per-item results instead of swallowing them, so a delete that
    // fails (locked file, permission denied) is surfaced rather than silently
    // lost — the user otherwise thinks the item is gone when it isn't.
    const failures: string[] = [];
    const recycled: string[] = [];
    let purged = 0;
    for (const path of targetPaths) {
      try {
        const res = await deletePath(path, permanent);
        if (!res.ok) failures.push(`${nameOf(path)}: ${res.error ?? "unknown error"}`);
        else if (permanent) purged++;
        else recycled.push(path);
      } catch (e) {
        failures.push(`${nameOf(path)}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Phase 6 undo: a recycle is reversible (restore from the Recycle Bin); a
    // permanent delete is not — push a marker so Ctrl+Z says so plainly.
    if (recycled.length > 0) pushUndo({ kind: "recycle", paths: recycled });
    if (purged > 0) pushUndo({ kind: "permanentDelete", count: purged });
    refreshAfterMutation(targetPaths);
    // A recycle is reversible — offer Undo. (A permanent delete is not, so it
    // gets no Undo affordance.)
    if (recycled.length > 0 && failures.length === 0) {
      toast.success(`Moved ${itemsLabel(recycled.length)} to the Recycle Bin.`, { action: undoAction });
    }
    if (failures.length > 0) {
      const verb = permanent ? "delete" : "move to the Recycle Bin";
      const shown = failures.slice(0, 10).join("\n");
      const more = failures.length > 10 ? `\n…and ${failures.length - 10} more` : "";
      toast.error(
        `Could not ${verb} ${failures.length} of ${targetPaths.length} item${targetPaths.length === 1 ? "" : "s"}:\n\n${shown}${more}`,
      );
    }
  }, [nodeByPath, selectedPaths, refreshAfterMutation, undoAction]);

  const runDelete = useCallback(() => { void runDeletePaths(); }, [runDeletePaths]);

  const [conflictPrompt, setConflictPrompt] = useState<{
    names: string[];
    index?: number;
    total?: number;
    resolve: (result: { choice: ConflictChoice; applyToAll: boolean }) => void;
  } | null>(null);
  const [moveNotice, setMoveNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!moveNotice) return;
    const timer = window.setTimeout(() => setMoveNotice(null), 2600);
    return () => window.clearTimeout(timer);
  }, [moveNotice]);

  const askConflict = useCallback(
    (names: string[], index?: number, total?: number) =>
      new Promise<{ choice: ConflictChoice; applyToAll: boolean }>((resolve) =>
        setConflictPrompt({ names, index, total, resolve }),
      ),
    [],
  );
  const handleConflictChoice = useCallback((choice: ConflictChoice, applyToAll: boolean) => {
    setConflictPrompt((prev) => { prev?.resolve({ choice, applyToAll }); return null; });
  }, []);

  // Conflict-resolution for the non-native (browser/dev) move path: the server's
  // /api/move-items first runs in "detect" mode (moves clean items, reports
  // collisions without overwriting), then we resolve the collisions per the
  // user's choice. With "Apply to all" (default) one choice resolves every
  // remaining collision in a single batched call; unchecked, we re-prompt for
  // each item in turn (Skip/Overwrite/Rename) until done or Cancel.
  // NOTE: in the desktop app, moves go through the native shell (IFileOperation)
  // which presents Windows' OWN Replace/Skip/Keep-both dialog, so this dialog is
  // the dev/browser fallback. (See handleInternalMove.)
  const runMoveWithConflicts = useCallback(
    async (sources: string[], destination: string): Promise<{
      ok: boolean;
      error?: string;
      movedPaths: string[];
      skipped: number;
      canceled: boolean;
      undoSafe: boolean;
    }> => {
      const detected = await moveItems(sources, destination);
      if (!detected.ok && detected.error) {
        return {
          ok: false,
          error: detected.error,
          movedPaths: detected.moved,
          skipped: Math.max(0, sources.length - detected.moved.length),
          canceled: false,
          undoSafe: false,
        };
      }
      const allErrors = [...detected.errors];
      const movedPaths = [...detected.moved];
      let canceled = false;
      const conflicts = detected.conflicts;
      if (conflicts.length > 0) {
        let start = 0;
        while (start < conflicts.length) {
          const isFirst = start === 0;
          // First prompt lists all collisions (apply-to-all is the default);
          // per-item prompts show just the current item with an "X of N" header.
          const view = isFirst ? conflicts : [conflicts[start]];
          const { choice, applyToAll } = await askConflict(
            view.map((c) => c.name),
            isFirst ? undefined : start + 1,
            conflicts.length,
          );
          if (choice === "cancel") {
            canceled = true;
            break;
          }
          const targets = applyToAll ? conflicts.slice(start) : [conflicts[start]];
          if (choice === "replace" || choice === "keep-both") {
            const resolved = await moveItems(targets.map((c) => c.src), destination, choice);
            if (!resolved.ok && resolved.error) allErrors.push(resolved.error);
            allErrors.push(...resolved.errors);
            movedPaths.push(...resolved.moved);
          }
          if (applyToAll) break;
          start += 1;
        }
      } else if (detected.alreadyThere.length > 0 && detected.moved.length === 0) {
        const n = detected.alreadyThere.length;
        setMoveNotice(n === 1 ? "Already in this folder." : `${n} items are already in this folder.`);
      }
      const normalizedMoved = new Set(
        movedPaths.map((path) => path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase()),
      );
      const confirmedMovedPaths = sources.filter((path) =>
        normalizedMoved.has(path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase()),
      );
      const skipped = Math.max(0, sources.length - confirmedMovedPaths.length);
      const ok = allErrors.length === 0 && !canceled && skipped === 0;
      const error = allErrors.length > 0
        ? [...new Set(allErrors)].join("; ")
        : canceled
          ? `Move canceled after ${confirmedMovedPaths.length} of ${sources.length} items.`
          : skipped > 0
            ? `${skipped} item${skipped === 1 ? "" : "s"} not moved.`
            : undefined;
      return {
        ok,
        error,
        movedPaths: confirmedMovedPaths,
        skipped,
        canceled,
        // Any collision can rename or merge a destination. Without an exact
        // output path, a custom undo could move pre-existing destination data.
        undoSafe: ok && conflicts.length === 0,
      };
    },
    [askConflict],
  );

  const runCopyFiles = useCallback(() => {
    if (selectedPaths.length === 0) {
      setMoveNotice("Select one or more files or folders to copy.");
      return;
    }
    void clipboardWriteFiles(selectedPaths, false)
      .then((written) => {
        setMoveNotice(written
          ? `Copied ${itemsLabel(selectedPaths.length)} to the clipboard.`
          : "The desktop file clipboard is unavailable.");
      })
      .catch((error: unknown) => {
        setMoveNotice(`Copy failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  }, [selectedPaths]);

  // Cut the selection: CF_HDROP with a MOVE drop effect so Explorer dims the
  // items and a later Paste (here or in Explorer) relocates them (#9).
  const runCutFiles = useCallback(() => {
    if (selectedPaths.length === 0) {
      setMoveNotice("Select one or more files or folders to cut.");
      return;
    }
    void clipboardWriteFiles(selectedPaths, true)
      .then((written) => {
        setMoveNotice(written
          ? `Cut ${itemsLabel(selectedPaths.length)} to the clipboard.`
          : "The desktop file clipboard is unavailable.");
      })
      .catch((error: unknown) => {
        setMoveNotice(`Cut failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  }, [selectedPaths]);

  // Where a Paste lands: a single selected folder, else the scanned root.
  const pasteTargetFolder = useCallback((): string | null => {
    if (!data) return null;
    if (selectedPaths.length === 1) {
      const node = nodeByPath.get(selectedPaths[0])
        ?? selectedNodes.find((selected) => selected.path === selectedPaths[0]);
      if (node?.dir) return node.path;
    }
    return data.rootPath;
  }, [data, selectedPaths, nodeByPath, selectedNodes]);

  // Copy clipboard/dropped files INTO `destination` via the guarded native shell
  // COPY (IFileOperation): native progress/collision dialogs, recycle-on-
  // overwrite, descendant/no-op skip, and per-item audit — never a raw copy that
  // could clobber. Risk-scoped confirm for large/many batches mirrors moves (#9).
  const runPasteCopy = useCallback(async (
    sources: string[],
    destination: string,
    provenance?: string,
  ): Promise<void> => {
    if (sources.length === 0 || !destination) {
      void releaseExternalPaths(provenance).catch(() => {});
      return;
    }
    const byPath = nodeByPathRef.current;
    const copyBytes = sources.reduce((sum, s) => sum + (byPath.get(s)?.size ?? 0), 0);
    const proceed = await confirmRisky({
      kind: "copy",
      crossDrive: isCrossDrive(sources, destination),
      itemCount: sources.length,
      totalBytes: copyBytes,
      names: sources.map((s) => byPath.get(s)?.name ?? basenameFromPath(s)),
    });
    if (!proceed) {
      void releaseExternalPaths(provenance).catch(() => {});
      setMoveNotice("Paste canceled.");
      return;
    }
    if (!hasNativeCopy()) {
      void releaseExternalPaths(provenance).catch(() => {});
      setMoveNotice("Paste-copy requires the FileTree desktop app.");
      return;
    }
    // F10: track the copy in the transfer queue. The queue serializes transfers
    // and honors a Pause (between transfers) — see lib/transfers.
    await enqueueTransfer(
      "copy",
      `${itemsLabel(sources.length)} → \u201C${basenameFromPath(destination)}\u201D`,
      sources.length,
      async () => {
        try {
          suppressWatchRef.current = true;
          const res = await copyItemsNative(sources, destination, provenance);
          const unaccounted = Math.max(0, sources.length - res.moved - res.skipped - res.failed);
          const incomplete = res.skipped + res.failed + unaccounted;
          if (res.aborted || incomplete > 0) {
            const details = [
              res.skipped > 0 ? `${res.skipped} skipped` : "",
              res.failed > 0 ? `${res.failed} failed` : "",
              unaccounted > 0 ? `${unaccounted} unconfirmed` : "",
            ].filter(Boolean).join(", ");
            setMoveNotice(
              `${res.moved > 0 ? `Copied ${res.moved} of ${sources.length}` : "Nothing copied"}`
              + `${details ? ` (${details})` : ""}${res.aborted ? " — canceled" : ""}.`,
            );
          }
          if (res.moved > 0 || res.aborted || res.failed > 0 || unaccounted > 0) {
            refreshAfterMutation([...sources, destination]);
          } else {
            suppressWatchRef.current = false;
          }
          const ok = !res.aborted && incomplete === 0 && res.moved === sources.length;
          const notCopied = Math.max(0, sources.length - res.moved);
          return {
            ok,
            error: ok
              ? undefined
              : notCopied > 0
                ? `${notCopied} item${notCopied === 1 ? "" : "s"} not copied`
                : "Copy was canceled",
          };
        } catch (e) {
          suppressWatchRef.current = false;
          const message = e instanceof Error ? e.message : String(e);
          setMoveNotice(`Paste failed: ${message}`);
          return { ok: false, error: message };
        }
      },
      transferDedupeKey("copy", sources, destination),
      () => {
        void releaseExternalPaths(provenance).catch(() => {});
      },
    );
  }, [refreshAfterMutation]);

  const handleInternalMove = useCallback(async (
    sources: string[],
    destination: string,
    provenance?: string,
  ): Promise<{ ok: boolean; error?: string }> => {
    if (sources.length === 0 || !destination) {
      void releaseExternalPaths(provenance).catch(() => {});
      return { ok: true };
    }
    // Drop any source whose move would be a no-op or unsafe — dropped onto
    // itself, into one of its own descendants, or into the folder it already
    // lives in directly. The guard is normalized + case-insensitive (reliable on
    // Windows), replacing the old case-sensitive self/descendant string check.
    const realSources = sources.filter((s) => s && !isNoOpMove(s, destination));
    if (realSources.length === 0) {
      void releaseExternalPaths(provenance).catch(() => {});
      // Everything was already in place / self-targeted: nothing to move. Surface
      // a brief, non-error notice (mirrors runMoveWithConflicts' alreadyThere
      // path) rather than failing or silently doing nothing.
      const n = sources.length;
      setMoveNotice(n === 1 ? "Already in this folder." : `${n} items are already in this folder.`);
      return { ok: true };
    }
    // Risk-scoped confirm (Phase 4): prompt only for a genuinely risky move —
    // crossing drives (copy + delete originals), or a large/many batch. An
    // ordinary same-drive move stays frictionless. (Overwrite/replace is still
    // confirmed separately by the conflict / native collision dialog.)
    const byPath = nodeByPathRef.current;
    const moveBytes = realSources.reduce((sum, s) => sum + (byPath.get(s)?.size ?? 0), 0);
    const proceedMove = await confirmRisky({
      kind: "move",
      crossDrive: isCrossDrive(realSources, destination),
      itemCount: realSources.length,
      totalBytes: moveBytes,
      names: realSources.map((s) => byPath.get(s)?.name ?? basenameFromPath(s)),
    });
    if (!proceedMove) {
      void releaseExternalPaths(provenance).catch(() => {});
      setMoveNotice("Move canceled.");
      return { ok: true };
    }
    // F10: track this move in the transfer queue (status surfaces near the
    // status bar). The queue serializes transfers and honors a Pause between
    // transfers; the native shell op shows its own granular progress dialog.
    return enqueueTransfer(
      "move",
      `${itemsLabel(realSources.length)} → \u201C${basenameFromPath(destination)}\u201D`,
      realSources.length,
      async () => {
        try {
          suppressWatchRef.current = true;
          let outcome: { ok: boolean; error?: string };
          let didMove = false;
          let movedCount = 0;
          let canUndoCompleteBatch = false;
          if (hasNativeMove()) {
            const res = await moveItemsNative(realSources, destination, provenance);
            movedCount = res.moved;
            didMove = movedCount > 0;
            const unaccounted = Math.max(0, realSources.length - res.moved - res.skipped - res.failed);
            const incomplete = res.skipped + res.failed + unaccounted;
            const complete = !res.aborted
              && incomplete === 0
              && res.moved === realSources.length;
            // IFileOperation may keep both under a generated name or merge a
            // folder. Its aggregate response does not expose exact output
            // paths, so FileTree must not construct a basename-based undo.
            canUndoCompleteBatch = false;
            outcome = complete
              ? { ok: true }
              : {
                  ok: false,
                  error: `${movedCount > 0 ? `Moved ${movedCount} of ${realSources.length}` : "Nothing moved"}`
                    + `${res.skipped ? `; ${res.skipped} skipped` : ""}`
                    + `${res.failed ? `; ${res.failed} failed` : ""}`
                    + `${unaccounted ? `; ${unaccounted} unconfirmed` : ""}`
                    + `${res.aborted ? " (canceled)" : ""}.`,
                };
          } else {
            void releaseExternalPaths(provenance).catch(() => {});
            const fallback = await runMoveWithConflicts(realSources, destination);
            outcome = fallback;
            didMove = fallback.movedPaths.length > 0;
            movedCount = fallback.movedPaths.length;
            canUndoCompleteBatch = fallback.undoSafe;
          }
          // Record a custom reverse move only when the fallback confirmed every
          // original basename and no collision could rename or merge output.
          // Native IFileOperation already records its own shell undo metadata,
          // but does not expose enough output identity for FileTree's undo stack.
          // If files moved without a safe custom inverse, discard older entries
          // so Ctrl+Z cannot target an unrelated operation across this boundary.
          if (canUndoCompleteBatch) {
            pushUndo({
              kind: "move",
              destination,
              items: realSources.map((s) => ({ name: basenameFromPath(s), originalParent: parentDir(s) })),
            });
          } else if (didMove) {
            clearUndo();
          }
          if (outcome.ok) {
            toast.success(
              `Moved ${itemsLabel(movedCount)} to \u201C${basenameFromPath(destination)}\u201D.`,
              canUndoCompleteBatch ? { action: undoAction } : undefined,
            );
          }
          if (didMove || !outcome.ok) refreshAfterMutation([...realSources, destination]);
          else suppressWatchRef.current = false;
          return outcome;
        } catch (error) {
          suppressWatchRef.current = false;
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, error: message };
        }
      },
      transferDedupeKey("move", realSources, destination),
      () => {
        void releaseExternalPaths(provenance).catch(() => {});
      },
    );
  }, [refreshAfterMutation, runMoveWithConflicts, undoAction]);

  // Paste CF_HDROP files into the focused folder. A Cut pastes as a MOVE through
  // the existing guarded move flow (handleInternalMove: no-op/descendant guards,
  // recycle-on-overwrite, risk confirm, audit, undo); a Copy pastes via the
  // guarded native copy above (#9). Declared after handleInternalMove so the
  // const is initialised before these closures capture it.
  const runPaste = useCallback(async (destination?: string) => {
    if (!data) return;
    try {
      const clip = await clipboardReadFiles();
      if (!clip.paths.length) { setMoveNotice("Clipboard has no files to paste."); return; }
      const dest = destination?.trim() || pasteTargetFolder();
      if (!dest) return;
      if (clip.preferMove) {
        const outcome = await handleInternalMove(clip.paths, dest, clip.provenance);
        if (!outcome.ok) setMoveNotice(`Paste failed: ${outcome.error ?? "unknown error"}`);
      } else {
        await runPasteCopy(clip.paths, dest, clip.provenance);
      }
    } catch (error) {
      setMoveNotice(`Paste failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [data, pasteTargetFolder, handleInternalMove, runPasteCopy]);

  // The Windows shell worker returns Copy/Cut/Paste without invoking them.
  // Copy/Cut are dispatched centrally by shellContextMenu; Paste needs this
  // row's explicit folder destination and uses the same provenance-bound flow
  // as Ctrl+V. Capturing the clicked row also avoids waiting for React selection
  // state to commit after a right-click on an unselected item.
  const handleContextMenu = useCallback((node: NodeRecord, x: number, y: number) => {
    const selIds = selectedIdsRef.current;
    const id = node.id;
    const alreadySelected = selIds.has(id);
    if (!alreadySelected) handleSelectRow(id, "single");
    if (!node || node.id < 0 || !node.path) return;
    const targetIds = alreadySelected && selIds.size > 1
      ? [id, ...Array.from(selIds).filter((selectedId) => selectedId !== id)]
      : [id];
    const currentNodes = actionNodeByIdRef.current;
    const paths = targetIds
      .map((targetId) => (
        targetId === id ? node : currentNodes.get(targetId)
      ))
      .filter((target): target is NodeRecord => !!target && target.id >= 0 && !!target.path)
      .map((target) => target.path)
      .filter((path, index, all) => all.indexOf(path) === index);
    const pasteDestination = node.dir
      ? node.path
      : parentDirOf(node.path) || dataRef.current?.rootPath;
    void shellContextMenu(paths, x, y, { deferPaste: true })
      .then((verb) => {
        const normalized = verb?.toLowerCase();
        if (normalized === "copy") {
          setMoveNotice(`Copied ${itemsLabel(paths.length)} to the clipboard.`);
        } else if (normalized === "cut") {
          setMoveNotice(`Cut ${itemsLabel(paths.length)} to the clipboard.`);
        } else if (normalized === "paste" && pasteDestination) {
          return runPaste(pasteDestination);
        }
      })
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : String(error));
      });
  }, [handleSelectRow, runPaste]);

  // Explorer drag-in is copy-only. Tauri's native drop event does not expose
  // Ctrl/Shift drop intent, so treating a same-drive drop as a destructive move
  // could delete the source against the user's intent. Explicit Cut/Paste still
  // carries a MOVE capability from the OS clipboard.
  const dropExternalInto = useCallback(async (
    sources: string[],
    destination: string,
    provenance?: string,
  ): Promise<void> => {
    if (sources.length === 0 || !destination) return;
    await runPasteCopy(sources, destination, provenance);
  }, [runPasteCopy]);

  // "Move to…" / "Copy to…" (ribbon / context / palette). #42: a richer dialog
  // with recent destinations + an inline "New folder…" affordance replaces the
  // old plain text prompt. Move routes through handleInternalMove (native shell
  // move in Tauri/Electron, /api/move-items fallback in dev); Copy routes through the
  // guarded native copy (runPasteCopy). The chosen destination is recorded as a
  // recent on confirm so it's one click away next time.
  const [moveToPrompt, setMoveToPrompt] = useState<{ mode: "move" | "copy" } | null>(null);

  const runMoveTo = useCallback(() => {
    if (selectedPaths.length === 0) { toast.info("Select one or more items first."); return; }
    setMoveToPrompt({ mode: "move" });
  }, [selectedPaths]);

  const runCopyTo = useCallback(() => {
    if (selectedPaths.length === 0) { toast.info("Select one or more items first."); return; }
    setMoveToPrompt({ mode: "copy" });
  }, [selectedPaths]);

  // Default the dialog's destination field to the lone selected folder, else the
  // scanned root, so "New folder…" has a sensible parent to start from.
  const moveToInitialPath = useMemo(() => {
    if (selectedPaths.length === 1) {
      const node = nodeByPath.get(selectedPaths[0]);
      if (node?.dir) return node.path;
    }
    return data?.rootPath ?? "";
  }, [selectedPaths, nodeByPath, data]);

  const handleMoveToConfirm = useCallback(async (destination: string) => {
    const mode = moveToPrompt?.mode ?? "move";
    setMoveToPrompt(null);
    const target = destination.trim();
    if (!target) return;
    // Record the destination as recent (the user explicitly chose it). Recording
    // on confirm — rather than waiting for the async transfer to settle — keeps
    // the MRU responsive and is harmless if the transfer is later canceled.
    recordRecentDestination(target);
    if (mode === "move") {
      const outcome = await handleInternalMove(selectedPaths, target);
      if (!outcome.ok) toast.error(`Move failed: ${outcome.error ?? "unknown error"}`);
    } else {
      await runPasteCopy(selectedPaths, target);
    }
  }, [moveToPrompt, selectedPaths, handleInternalMove, runPasteCopy]);

  // Create `name` under `parent` for the dialog's inline "New folder…". Reuses
  // the audited create-folder API + pushes an undo entry like handleNewFolder.
  const handleMoveToCreateFolder = useCallback(async (parent: string, name: string) => {
    const sep = parent.includes("/") && !parent.includes("\\") ? "/" : "\\";
    const full = `${parent.replace(/[\\/]+$/, "")}${sep}${name}`;
    try {
      await createFolder(full);
      pushUndo({ kind: "mkdir", path: full });
      refreshAfterMutation([full]);
      return { ok: true, path: full };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }, [refreshAfterMutation]);

  // ── F5: archive (zip) + checksum on the current selection ────────────────
  // The table's right-click opens the native Explorer menu, so these actions
  // are surfaced from the Edit menu via the handle. Long ops route through the
  // transfers panel; the tree is rescanned afterward so new files appear.

  const runCompress = useCallback(async () => {
    const paths = selectedPaths;
    if (paths.length === 0) { toast.info("Select one or more items to compress."); return; }
    // Default the .zip into the first item's parent — always under a scan root,
    // which the server requires for the destination.
    const sep = paths[0].includes("/") && !paths[0].includes("\\") ? "/" : "\\";
    const parent = parentDir(paths[0]);
    const stem = paths.length === 1
      ? basenameFromPath(paths[0]).replace(/\.[^.]+$/, "")
      : basenameFromPath(parent);
    const name = await promptDialog({
      title: "Compress to .zip",
      label: "Archive file name",
      message: `Zip ${itemsLabel(paths.length)} into ${parent}${sep}…`,
      initialValue: `${stem || "archive"}.zip`,
      placeholder: "archive.zip",
      confirmLabel: "Compress",
      validate: (v) => (/[\\/:*?"<>|]/.test(v.trim()) ? "Illegal character in name" : null),
    });
    if (name == null) return;
    let fileName = name.trim();
    if (!/\.zip$/i.test(fileName)) fileName += ".zip";
    const dest = `${parent}${sep}${fileName}`;
    const xferId = beginTransfer("copy", `Compress ${itemsLabel(paths.length)} \u2192 \u201C${fileName}\u201D`, paths.length);
    try {
      const res = await compress(paths, dest);
      finishTransfer(xferId, res.ok, res.error);
      if (res.ok) {
        toast.success(`Compressed ${itemsLabel(paths.length)} to \u201C${fileName}\u201D.`);
        refreshAfterMutation([dest]);
      } else {
        toast.error(`Compress failed: ${res.error ?? "unknown error"}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      finishTransfer(xferId, false, msg);
      toast.error(`Compress failed: ${msg}`);
    }
  }, [selectedPaths, refreshAfterMutation]);

  const runExtract = useCallback(async () => {
    const node = selectedNode;
    if (!node || node.dir || !/\.zip$/i.test(node.path)) {
      toast.info("Select a .zip file to extract.");
      return;
    }
    // "Extract here" → into the archive's own containing folder.
    const dest = parentDir(node.path);
    const xferId = beginTransfer("copy", `Extract \u201C${node.name}\u201D`, 1);
    try {
      const res = await extract(node.path, dest);
      finishTransfer(xferId, res.ok, res.error);
      if (res.ok) {
        toast.success(`Extracted \u201C${node.name}\u201D here.`);
        refreshAfterMutation([dest]);
      } else {
        toast.error(`Extract failed: ${res.error ?? "unknown error"}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      finishTransfer(xferId, false, msg);
      toast.error(`Extract failed: ${msg}`);
    }
  }, [selectedNode, refreshAfterMutation]);

  // #43: batch attribute + timestamp editor on the current selection. Opens a
  // dialog; the apply handler routes through the audited, root-gated backend
  // endpoints and rescans so the new attributes/dates show immediately.
  const [attrDialogOpen, setAttrDialogOpen] = useState(false);

  const runEditAttributes = useCallback(() => {
    if (selectedPaths.length === 0) { toast.info("Select one or more items first."); return; }
    setAttrDialogOpen(true);
  }, [selectedPaths]);

  const applyAttributes = useCallback(async (payload: AttributesPayload): Promise<{ ok: boolean; error?: string }> => {
    const paths = selectedPaths;
    if (paths.length === 0) return { ok: true };
    const errors: string[] = [];
    if (payload.attrs.readonly !== undefined || payload.attrs.hidden !== undefined) {
      const r = await setAttributes(paths, payload.attrs);
      if (!r.ok && r.error) errors.push(r.error);
    }
    if (payload.times.created !== undefined || payload.times.modified !== undefined || payload.times.accessed !== undefined) {
      const r = await setTimes(paths, payload.times);
      if (!r.ok && r.error) errors.push(r.error);
    }
    refreshAfterMutation(paths);
    if (errors.length > 0) return { ok: false, error: errors.join("; ") };
    toast.success(`Updated ${itemsLabel(paths.length)}.`);
    return { ok: true };
  }, [selectedPaths, refreshAfterMutation]);

  // #44: "Send to" actions on the selection. Compress reuses runCompress; Mail
  // opens the default mail client via a mailto: URL (attachments aren't possible
  // through mailto — FLAGGED — so we offer a one-click "Compress to .zip" so the
  // user can attach the archive); custom commands run via the SendToDialog.
  const [sendToOpen, setSendToOpen] = useState(false);

  const runSendToMail = useCallback(async () => {
    const paths = selectedPaths;
    if (paths.length === 0) { toast.info("Select one or more items first."); return; }
    const names = paths.map((p) => basenameFromPath(p));
    const subject = encodeURIComponent(
      paths.length === 1 ? `Sharing ${names[0]}` : `Sharing ${paths.length} files`,
    );
    const body = encodeURIComponent(
      `I'd like to share the following:\n\n${names.join("\n")}\n\n` +
      `(Files can't be attached automatically from a mailto link — please attach them manually.)`,
    );
    const url = `mailto:?subject=${subject}&body=${body}`;
    try {
      // Open the user's default mail client. Start-Process resolves the mailto:
      // protocol handler; the URL is fully encoded so the shell can't mis-parse it.
      await runCommand(`Start-Process "${url}"`, scanPath, { shell: "powershell" });
      toast.info("Opened your mail client. Attachments must be added manually.", {
        action: { label: "Compress to .zip", onClick: () => { void runCompress(); } },
      });
    } catch (e) {
      toast.error(`Couldn't open the mail client: ${e instanceof Error ? e.message : String(e)}`);
    }
  // runCompress is defined just above; referenced lazily so the closure is fine.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPaths, scanPath]);

  const runSendToCommand = useCallback(() => {
    if (selectedPaths.length === 0) { toast.info("Select one or more items first."); return; }
    setSendToOpen(true);
  }, [selectedPaths]);

  // Run a substituted Send-to command, then rescan (it may create/modify files).
  const sendToRunCommand = useCallback(async (command: string) => {
    const res = await runCommand(command, scanPath);
    refreshAfterMutation([scanPath]);
    return res;
  }, [scanPath, refreshAfterMutation]);

  const runChecksum = useCallback(async () => {
    const node = selectedNode;
    if (!node || node.dir) { toast.info("Select a file to checksum."); return; }
    const res = await checksum(node.path, "sha256");
    if (res.error || !res.hash) {
      toast.error(`Checksum failed: ${res.error ?? "unknown error"}`);
      return;
    }
    await copyText(res.hash);
    toast.success(`SHA-256 of \u201C${node.name}\u201D copied:\n${res.hash}`);
  }, [selectedNode]);

  // After a native drag moved item(s) OUT of this tree, reconcile the loaded
  // source listing so a moved-out folder disappears without a deep rescan.
  const handleAfterExternalMove = useCallback(() => {
    refreshAfterMutation([dataRef.current?.rootPath || scanPath]);
  }, [refreshAfterMutation, scanPath]);

  // #14 Incremental refresh. Dirty watcher branches are preferred; otherwise
  // refresh loaded open directories. Each request is maxDepth=1 and preserves
  // cached subtrees, so clicking Refresh never starts a drive-wide scan.
  const doSmartRefresh = useCallback(async () => {
    const t = treeRef.current;
    const root = lastCompletedPathRef.current;
    if (!root || status === "scanning" || smartRefreshInFlightRef.current) return;

    const replaceRefreshToast = (id: number) => {
      if (refreshToastIdRef.current != null) toast.dismiss(refreshToastIdRef.current);
      refreshToastIdRef.current = id;
    };

    smartRefreshInFlightRef.current = true;
    try {
      const dirty = Array.from(dirtyDirectoriesRef.current.values());
      const overflowed = dirtyDirectoryOverflowRef.current;
      if (dirty.length > 0 || overflowed) {
        const patched = await refreshDirectories(dirty);
        const unresolved = dirtyDirectoriesRef.current.size;
        // The explicit refresh acknowledges an overflow after reconciling all
        // loaded branches. Unknown lazy branches remain queued until opened.
        dirtyDirectoryOverflowRef.current = false;
        if (unresolved > 0 || overflowed) {
          const pending = `${unresolved}${overflowed ? "+" : ""}`;
          const prefix = patched > 0
            ? `Updated ${patched} changed folder${patched === 1 ? "" : "s"}; `
            : "";
          replaceRefreshToast(toast.warn(`${prefix}${pending} unloaded branch${pending === "1" ? "" : "es"} will refresh when opened.`));
        } else {
          replaceRefreshToast(toast.success(`Updated ${patched} changed folder${patched === 1 ? "" : "s"}.`));
        }
        return;
      }

      // Currently-expanded directories that are real, loaded nodes (skip the
      // root's synthetic bundle ids). Live watcher rows are valid refresh roots.
      const openDirs: string[] = [];
      for (const node of t.nodeById.values()) {
        if (!node.dir || node.id < 0 || !node.path) continue;
        if (
          node.id === 0
          || isNodeOpen(node.id, t.expanded, t.expandedAll, t.collapsedOverrides)
        ) openDirs.push(node.path);
      }
      if (openDirs.length === 0) return;
      const limited = openDirs.slice(0, SMART_REFRESH_MAX_DIRS);
      const patched = await refreshDirectories(limited);
      replaceRefreshToast(toast.success(`Smart refresh updated ${patched} visible folder${patched === 1 ? "" : "s"}.`));
    } finally {
      smartRefreshInFlightRef.current = false;
    }
  }, [status, refreshDirectories]);

  // ── Agent API facade (used by the right-side ChatPanel) ──────────────────
  const agentApi = useMemo<AgentApi>(() => ({
    getScanPath: () => scanPath,
    getScanResult: () => data,
    getNodes: () => Array.from(tree.nodeById.values()),
    scanFolder: async (path: string) => { openLocation(path); },
    refresh: async () => { await doSmartRefresh(); },
    findDuplicates: async (minSizeBytes: number, signal?: AbortSignal) => {
      const root = data?.rootPath || scanPath;
      const res = await fetchDupesV2Bounded({ paths: [root], mode: "exact", minSize: minSizeBytes }, signal);
      return { groups: res.groups.map((g) => ({ waste: g.waste, files: g.files.map((f) => ({ path: f.path, size: f.size })) })) };
    },
    moveItems: async (paths: string[], destination: string) => handleInternalMove(paths, destination),
    renameItem: async (path: string, newName: string) => {
      const r = await renameItem(path, newName);
      if (r.ok) {
        pushUndo({ kind: "rename", parent: parentDir(path), from: basenameFromPath(path), to: newName });
        refreshAfterMutation([parentDir(path)]);
      }
      return r;
    },
    createFolder: async (path: string) => {
      try { await createFolder(path); pushUndo({ kind: "mkdir", path }); refreshAfterMutation([path]); return { ok: true }; }
      catch (e) { return { ok: false, error: (e as Error).message }; }
    },
    reveal: async (path: string) => { revealPath(path); },
    // Run an approved shell command, then refresh the tree (deletions, recycle,
    // etc. change the folder). cwd defaults to this tab's scanned folder.
    runCommand: async (command: string, cwd?: string, shell?: "powershell" | "cmd") => {
      const workingDirectory = cwd ?? scanPath;
      const res = await runCommand(command, workingDirectory, shell ? { shell } : undefined);
      refreshAfterMutation([workingDirectory]);
      return res;
    },
    // Read-only bounded text read (server caps at ~64 KiB; we window by line).
    readFile: async (path: string, opts) => readFileWindow(path, opts),
    // Create/overwrite a text file via an approved PowerShell write, then rescan.
    writeFile: async (path: string, content: string) => {
      const res = await runCommand(buildWriteFileCommand(path, content), parentDir(path) || scanPath);
      refreshAfterMutation([path]);
      return res;
    },
    // Exact-substring edit via an approved PowerShell replace, then rescan.
    editFile: async (path: string, oldString: string, newString: string) => {
      const res = await runCommand(buildEditFileCommand(path, oldString, newString), parentDir(path) || scanPath);
      refreshAfterMutation([path]);
      return res;
    },
    webFetch: async (url: string, opts) => webFetch(url, opts),
    webSearch: async (query: string) => webSearch(query),
  }), [scanPath, data, tree.nodeById, openLocation, doSmartRefresh, handleInternalMove, refreshAfterMutation]);

  useImperativeHandle(ref, () => ({
    getStatus: () => status,
    getData: () => data,
    getProgress: () => progressStore.get(),
    getProgressStore: () => progressStore,
    getErrorMessage: () => errorMessage,
    getVisibleCount: () => tree.visibleRows.length,
    getSelectionSummary: () => selectionSummary,
    doCopyAsTable: runCopyAsTable,
    getScanPath: () => scanPath,
    getViewState: () => ({
      metric: tree.metric,
      unit: tree.unit,
      showFiles: tree.showFiles,
      sortKey: tree.sortKey,
      sortDir: tree.sortDir,
      columnWidths: tree.columnWidths as Record<string, number>,
    }),
    getScanning: () => status === "scanning",
    getNodeById: () => tree.nodeById,
    getAgentApi: () => agentApi,
    getSidebarModel: () => {
      // Read tree state via the live ref so the model is always current even if
      // this handle closure is a render behind; data/scanPath/etc. come from the
      // closure (they're in the dep array below, so the handle is fresh on commit).
      const t = treeRef.current;
      return {
        data,
        nodeById: t.nodeById,
        metric: t.metric,
        unit: t.unit,
        loadedDirs: t.loadedDirs,
        scanPath,
        scanning: status === "scanning",
        treeRows: t.visibleRows,
        expanded: t.expanded,
        expandedAll: t.expandedAll,
        collapsedOverrides: t.collapsedOverrides,
        selectedId: t.selectedId,
        selectedNode: t.nodeById.get(t.selectedId),
        errorCount: data?.errorCount ?? 0,
        onSelectNode: t.setSelectedId,
        onEnsureChildren: t.ensureChildren,
        onMoveItems: (sourcePaths, destinationFolder) =>
          handleInternalMove(sourcePaths, destinationFolder),
        onOpenNode: handleTreemapOpen,
        onNavigate: handleNavigate,
        onScanPathInput: setScanPathState,
        onScan: () => openLocation(scanPath),
        onCancel: cancelScan,
        onRefresh: () => { void doSmartRefresh(); },
        onUp: handleNavigateParent,
        onNewFolder: handleNewFolder,
        onCollapseAll: () => t.expandToLevel(0),
        onOpenLocation: openLocation,
        onToggleExpand: t.toggleExpand,
        onSelectFolder: handleNavigate,
        onOpen: runOpen,
        onReveal: runReveal,
        onCopyPath: runCopyPath,
        onScanPath: openLocation,
      };
    },
    doScan: () => doScan(),
    doCancel: cancelScan,
    doScanPath: (path) => openLocation(path),
    doNavigateParent: handleNavigateParent,
    doBack: goBack,
    doForward: goForward,
    getNavState: () => ({
      canBack: navHistory.index > 0,
      canForward: navHistory.index < navHistory.stack.length - 1,
    }),
    doExpand: handleExpand,
    doNewFolder: handleNewFolder,
    doOpenFilter: () => setFilterDialogOpen(true),
    doReveal: () => { if (selectedNode) revealPath(selectedNode.path); },
    doRename: runRename,
    doRenamePath: (path) => { void runRenamePath(path); },
    doBulkRename: () => setBulkRenameOpen(true),
    doDelete: runDelete,
    doDeletePaths: (paths) => { void runDeletePaths(paths); },
    doMoveTo: runMoveTo,
    doCopyTo: runCopyTo,
    doEditAttributes: runEditAttributes,
    doSendToMail: () => { void runSendToMail(); },
    doSendToCommand: runSendToCommand,
    doCopyPath: runCopyPath,
    doCopyFiles: runCopyFiles,
    doCompress: () => { void runCompress(); },
    doExtract: () => { void runExtract(); },
    doChecksum: () => { void runChecksum(); },
    doCutFiles: runCutFiles,
    doPaste: () => { void runPaste(); },
    dropExternalInto: (paths, destination, provenance) => dropExternalInto(paths, destination, provenance),
    doExport: (format) => {
      if (!data) return;
      // "pdf" isn't a server format: per roadmap #8, PDF = print the HTML
      // report. We fetch the same server-rendered report and print it via a
      // hidden iframe, so the user gets the OS "Save as PDF" target.
      if (format === "pdf") {
        printReportAsPdf(data.rootPath);
        return;
      }
      // csv/json/html/xml/xlsx all download from the matching server endpoint,
      // which reports on the current scan (last_scan) plus its analytics.
      const a = document.createElement("a");
      a.href = exportUrl(format, data.rootPath);
      a.download = "";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    },
    doSelectPaths: (paths) => {
      const byPath = new Map<string, number>();
      for (const n of actionNodeByIdRef.current.values()) {
        if (n.id >= 0 && n.path) byPath.set(n.path.toLowerCase(), n.id);
      }
      const ids: number[] = [];
      for (const p of paths) {
        const id = byPath.get(p.toLowerCase());
        if (id != null) ids.push(id);
      }
      if (ids.length > 0) handleSelectAllRows(ids);
      return ids.length;
    },
    doSelectSearchResults: () => {
      const ids = searchResultsRef.current.map((n) => n.id);
      if (ids.length === 0) { setMoveNotice("No results to select."); return; }
      handleSelectAllRows(ids);
    },
    doExportSearchResults: (format) => {
      const rows = searchResultsRef.current;
      if (rows.length === 0) { setMoveNotice("No results to export."); return; }
      exportResults(rows, format);
    },
    getRibbonState: () => ({
      scanPath,
      scanning: status === "scanning",
      metric: tree.metric,
      unit: tree.unit,
      filter: tree.filter,
      showFiles: tree.showFiles,
      filterActive: tree.filterRules.some((r) => r.value.trim() !== ""),
      sortKey: tree.sortKey,
      sortDir: tree.sortDir,
    }),
    setMetric: (m) => tree.setMetric(m as never),
    setUnit: (u) => tree.setUnit(u as never),
    setFilter: (f) => tree.setFilter(f),
    setShowFiles: (v) => tree.setShowFiles(v),
    setScanPath: (p) => setScanPathState(p),
    setSortKeyDir: (key, dir) => {
      tree.setSortKey(key as SortKey);
      if (tree.sortDir !== dir) tree.setSortKey(key as SortKey);
    },
    showNotice: (message) => setMoveNotice(message),
    refresh: () => { void doSmartRefresh(); },
    smartRefresh: doSmartRefresh,
    doNavigateId: (id) => handleNavigate(id),
    getFilterRules: () => treeRef.current.filterRules,
    setFilterRules: (rules) => treeRef.current.setFilterRules(rules),
  }), [status, data, progressStore, errorMessage, scanPath, tree, cancelScan, agentApi,
       doScan, handleNavigate, handleNavigateParent, handleExpand, handleNewFolder, handleTreemapOpen, selectedNode,
       openLocation, goBack, goForward, navHistory, runOpen, runReveal, onScanPath,
       runRename, runRenamePath, runDelete, runDeletePaths, runMoveTo, runCopyTo, runEditAttributes,
       runSendToMail, runSendToCommand, runCopyPath, runCopyFiles,
       runCompress, runExtract, runChecksum, selectionSummary, runCopyAsTable,
       runCutFiles, runPaste, dropExternalInto, doSmartRefresh]);

  const breadcrumbPath = data?.rootPath || scanPath;
  const canBack = navHistory.index > 0;
  const canForward = navHistory.index < navHistory.stack.length - 1;
  // No parent at a drive/volume root (parentDirOf returns null) → disable Up,
  // matching the existing Back/Forward disabled treatment.
  const breadcrumbParent = parentDirOf(breadcrumbPath);
  const canUp = !!breadcrumbParent && !samePath(breadcrumbParent, breadcrumbPath);

  // Inactive tabs stay MOUNTED — so their scan/tree state, imperative ref, the
  // shared Explorer side bar, the status bar and the Duplicates cross-tab scan
  // aggregation all keep reading this pane — but render NONE of their heavy
  // content. The virtualized TreeTable is unmounted, freeing its DOM and
  // skipping any
  // background canvas redraws / row reconciliation while hidden (previously they
  // stayed in the DOM behind `display:none`). Every piece of important state
  // lives in this component's hooks (useScan / useTreeState / selection /
  // history), so it survives activate↔deactivate untouched; only transient view
  // state (e.g. table scroll offset) resets when the pane is shown again.
  if (!active) {
    return <div className="wb-tab" data-tab-id={tabId} style={{ display: "none" }} aria-hidden="true" />;
  }

  return (
    <div className="wb-tab" data-tab-id={tabId}>
      <div className="editor-region">
        <Breadcrumb
          path={breadcrumbPath}
          scanning={status === "scanning"}
          canBack={canBack}
          canForward={canForward}
          canUp={canUp}
          onNavigate={openLocation}
          onBack={goBack}
          onForward={goForward}
          onUp={handleNavigateParent}
        />
        {data && data.nodeCount > VERY_LARGE_SCAN_NODES && !largeScanDismissed && status !== "scanning" && (
          <div className="stale-bar" role="status">
            <Icon name="warning" size={12} />
            <span>
              Very large scan ({data.nodeCount.toLocaleString()} items)
              {data.lazy
                ? " — loading folders on demand to stay responsive."
                : " — performance may degrade while everything loads."}
            </span>
            <span className="spacer" />
            <button
              className="stale-bar-dismiss"
              title="Dismiss"
              onClick={() => setLargeScanDismissed(true)}
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        )}
        {tagFiltering && (
          <div className="tag-filter-bar" role="status">
            <Icon name="funnel-fill" size={12} />
            <span>Filtering by tag</span>
            <span className="tag-filter-chip">{activeTagFilter}</span>
            <span className="tag-filter-count">{tagResults.length} item{tagResults.length === 1 ? "" : "s"}</span>
            <span className="spacer" />
            <button className="tag-filter-clear" title="Clear tag filter" onClick={onClearTagFilter}>
              <Icon name="x" size={12} /> Clear
            </button>
          </div>
        )}
        {toolbarVisible && (
            <div className="editor-toolbar">
              <label>
                Size
                <Select
                  value={tree.metric}
                  options={[
                    { value: "size", label: "Size" },
                    { value: "allocated", label: "Allocated" },
                    { value: "files", label: "Files" },
                    { value: "folders", label: "Folders" },
                  ]}
                  aria-label="Size metric"
                  onChange={tree.setMetric}
                />
              </label>
              <label>
                Unit
                <Select
                  value={tree.unit}
                  options={[
                    { value: "auto", label: "Auto" },
                    { value: "tb", label: "TB" },
                    { value: "gb", label: "GB" },
                    { value: "mb", label: "MB" },
                    { value: "kb", label: "KB" },
                    { value: "bytes", label: "Bytes" },
                  ]}
                  aria-label="Display unit"
                  onChange={tree.setUnit}
                />
              </label>
              <span className="sep" />
              <label>
                <input type="checkbox" checked={tree.showFiles} onChange={(e) => tree.setShowFiles(e.target.checked)} />
                Files
              </label>
              <label title="Resolve each item's Windows owner during the scan (slower). Off by default; toggling re-scans this folder.">
                <input type="checkbox" checked={collectOwners} onChange={(e) => onCollectOwnersChange(e.target.checked)} />
                Owners
              </label>
              <button
                onClick={() => tree.expandToLevel(Infinity)}
                title={data?.lazy
                  ? "Expand all folders and file groups, loading large scans in bounded batches."
                  : "Expand all folders and file groups."}
              >Expand all</button>
              <button onClick={() => tree.expandToLevel(0)}>Collapse all</button>
              <span className="sep" />
              <input
                placeholder="Filter…"
                value={filterInput}
                onChange={(e) => setFilterInput(e.target.value)}
                style={{ height: 24, width: 150, background: "var(--vsc-input-bg)", border: "1px solid var(--vsc-border)", color: "var(--text)" }}
              />
              <button onClick={() => setFilterDialogOpen(true)} title="Advanced filter">Rules</button>
              <button
                onClick={() => setBulkRenameOpen(true)}
                disabled={selectedNodes.length === 0}
                title="Bulk rename the selected items"
              >Rename…</button>
              <span className="sep" />
              <ConfigureColumnsMenu
                visibleColumns={visibleColumns}
                onVisibleColumnsChange={onVisibleColumnsChange}
                decimals={decimals}
                onDecimalsChange={onDecimalsChange}
                unit={tree.unit}
                onUnitChange={tree.setUnit}
              />
              <span className="spacer" />
              <button onClick={handleOpenTerminal} title="Open terminal here (Ctrl+`)">Terminal</button>
            </div>
        )}

        {toolbarVisible && (
            <div className="editor-toolbar quick-filter-chips">
              {QUICK_FILTER_CHIPS.map((chip) => (
                <button
                  key={chip.key}
                  type="button"
                  className={`compress-chip${tree.chips.has(chip.key) ? " active" : ""}`}
                  onClick={() => tree.toggleChip(chip.key)}
                  title={`Show only ${chip.label}`}
                >
                  {chip.label}
                </button>
              ))}
            </div>
        )}

        {searching && (
          <div className="editor-toolbar search-results-bar">
                <Icon name="search" size={12} />
                <span className="search-results-count">
                  {searchResults.length}{searchResults.length >= 2000 ? "+" : ""} result{searchResults.length === 1 ? "" : "s"}
                </span>
                <span className="spacer" />
                <button
                  onClick={() => { const ids = searchResults.map((n) => n.id); if (ids.length) handleSelectAllRows(ids); }}
                  disabled={searchResults.length === 0}
                  title="Select every matching result row"
                >Select all</button>
                <button
                  onClick={() => { if (searchResults.length) exportResults(searchResults, "csv"); }}
                  disabled={searchResults.length === 0}
                  title="Export the result rows to CSV"
                >Export CSV</button>
                <button
                  onClick={() => { if (searchResults.length) exportResults(searchResults, "json"); }}
                  disabled={searchResults.length === 0}
                  title="Export the result rows to JSON"
                >Export JSON</button>
          </div>
        )}

        {bookmarksView && <div className="editor-toolbar search-results-bar">
          <Icon name="star-fill" size={12} />
          <span>{bookmarkRows.length} bookmarked folders in {data?.rootPath ?? scanPath}</span>
        </div>}
        <div className="editor-stack">
          <div className="editor-main">
            <TreeTable
                  rows={showRows}
                  scanId={data?.scanId}
                  flat={showFlat}
                  expandableFlat={showFlat}
                  lazy={!!data?.lazy}
                  loadedDirs={showFlat ? resultTree.loadedDirs : tree.loadedDirs}
                  nodeById={actionNodeById}
                  expanded={showFlat ? resultTree.expanded : tree.expanded}
                  expandedAll={showFlat ? false : tree.expandedAll}
                  collapsedOverrides={tree.collapsedOverrides}
                  selectedId={tree.selectedId}
                  selectedIds={selectedIds}
                  sortKey={tree.sortKey}
                  sortDir={tree.sortDir}
                  metric={tree.metric}
                  unit={tree.unit}
                  decimals={decimals}
                  visibleColumns={visibleColumns}
                  columnWidths={tree.columnWidths}
                  onColumnResize={tree.setColumnWidth}
                  onToggleExpand={showFlat ? resultTree.toggle : tree.toggleExpand}
                  onSelect={handleSelectRow}
                  onSelectAll={handleSelectAllRows}
                  selectionSummary={selectionSummary}
                  heatTint={heatTint}
                  rowHeight={rowHeight}
                  diffHighlight={diffHighlight}
                  onDoubleClick={handleDblClick}
                  onContextMenu={handleContextMenu}
                  onCopySelected={runCopyFiles}
                  onMoveItems={handleInternalMove}
                  onOpenFolderInTab={onOpenFolderInTab}
                  onAfterExternalMove={handleAfterExternalMove}
                  onSortChange={handleSortChange}
                  bookmarks={bookmarkSet}
                  tags={tagsByPath}
                  onEditTags={(path, x, y) => setTagPopover({ path, x, y })}
                  onToggleBookmark={onToggleBookmark}
                  onCompress={handleCompress}
                  renamingId={renamingId}
                  onRenameCommit={commitRename}
                  onRenameCancel={cancelRename}
            />
            {/* In-editor scan feedback: while a scan is in flight and the
                tree is still empty (initial/large scans blank the grid), show
                a centered overlay with the live node count + Cancel over a few
                skeleton rows. A refresh keeps the old tree visible, so rows are
                present and this never shows. */}
            {status === "scanning" && tree.visibleRows.length === 0 && (
              <ScanOverlay progressStore={progressStore} onCancel={cancelScan} />
            )}
          </div>
        </div>
        <TabFooter
          scanResult={data}
          root={tree.nodeById.get(0) ?? null}
          scanPath={scanPath}
          unit={tree.unit}
          decimals={decimals}
        />
      </div>

      {filterDialogOpen && (
        <FilterDialog
          initialRules={tree.filterRules}
          onApply={tree.setFilterRules}
          onClose={() => setFilterDialogOpen(false)}
        />
      )}

      {bulkRenameOpen && (
        <BulkRenameDialog
          nodes={selectedNodes}
          onClose={() => setBulkRenameOpen(false)}
          onApplied={() => { refreshAfterMutation(selectedPaths); }}
          undoAction={undoAction}
        />
      )}

      {attrDialogOpen && (
        <AttributesDialog
          nodes={selectedNodes}
          onApply={applyAttributes}
          onClose={() => setAttrDialogOpen(false)}
        />
      )}

      {sendToOpen && (
        <SendToDialog
          paths={selectedPaths}
          onRunCommand={sendToRunCommand}
          onClose={() => setSendToOpen(false)}
        />
      )}

      {tagPopover && (
        <TagPopover
          path={tagPopover.path}
          x={tagPopover.x}
          y={tagPopover.y}
          entry={tagsByPath.get(tagPopover.path)}
          onApply={onSetTags}
          onClose={() => setTagPopover(null)}
        />
      )}

      {conflictPrompt && (
        <ConflictDialog
          names={conflictPrompt.names}
          index={conflictPrompt.index}
          total={conflictPrompt.total}
          onChoice={handleConflictChoice}
        />
      )}

      {moveToPrompt && (
        <MoveToDialog
          title={moveToPrompt.mode === "move" ? "Move to folder" : "Copy to folder"}
          confirmLabel={moveToPrompt.mode === "move" ? "Move" : "Copy"}
          initialPath={moveToInitialPath}
          recents={getRecentDestinations()}
          onCreateFolder={handleMoveToCreateFolder}
          onRemoveRecent={removeRecentDestination}
          onConfirm={(dest) => { void handleMoveToConfirm(dest); }}
          onCancel={() => setMoveToPrompt(null)}
        />
      )}

      {moveNotice && <div className="move-toast" role="status">{moveNotice}</div>}
    </div>
  );
});

// Stops the App-level render cascade: when App re-renders (e.g. another pane's
// scan progress, a tab switch, or a focus change), a hidden/inactive pane is
// skipped unless one of its own props actually changed. The visible tab always
// re-renders; any tab re-renders when its internal state changes (memo only
// blocks parent-driven renders). All remaining props are stable identities
// (memoized callbacks, primitives, or Sets that change identity on edit).
function arePropsEqual(prev: WorkspaceTabProps, next: WorkspaceTabProps): boolean {
  if (prev.active !== next.active) return false;
  if (next.active) return false;
  for (const k of Object.keys(next) as (keyof WorkspaceTabProps)[]) {
    if (prev[k] !== next[k]) return false;
  }
  return true;
}

export const WorkspaceTab = memo(WorkspaceTabInner, arePropsEqual);

// Centered scan overlay shown over the (empty) tree while a scan streams in.
// Reuses the duplicates scan's spinner + sweeping progress bar (.df-scanning-
// spinner / .df-progress-*) so in-editor feedback matches that view, and layers
// a few shimmering skeleton rows behind the card to hint at the incoming table.
const SKELETON_WIDTHS = [62, 48, 71, 40, 58, 45, 66, 52];

function ScanOverlay({ progressStore, onCancel }: { progressStore: ProgressStore; onCancel: () => void }) {
  // Subscribe to live progress here (a tiny leaf) so each tick re-renders only
  // this counter, not the surrounding pane.
  const progress = useSyncExternalStore(progressStore.subscribe, progressStore.get);
  const nodes = progress?.nodes ?? 0;
  return (
    <div className="scan-overlay" role="status" aria-live="polite">
      <div className="scan-skeleton" aria-hidden="true">
        {SKELETON_WIDTHS.map((w, i) => (
          <div className="skeleton-row" key={i}>
            <span className="skeleton-bar skeleton-name" style={{ width: `${w}%` }} />
            <span className="skeleton-bar skeleton-size" />
          </div>
        ))}
      </div>
      <div className="scan-overlay-card">
        <div className="df-scanning-spinner" />
        <div className="scan-overlay-title">Scanning…</div>
        <div className="scan-overlay-count">{nodes.toLocaleString()} items</div>
        <div className="df-progress-track">
          <div className="df-progress-bar df-progress-bar-sweep" />
        </div>
        <button type="button" className="scan-overlay-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

