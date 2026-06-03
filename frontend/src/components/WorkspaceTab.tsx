import { useState, useEffect, useCallback, useMemo, useRef, forwardRef, useImperativeHandle, useSyncExternalStore, memo } from "react";
import { useScan, fetchScanStream } from "../hooks/useScan";
import { useTreeState } from "../hooks/useTreeState";
import { invalidate as invalidateScanCache, invalidateAll as invalidateAllScanCache } from "../lib/scanCache";
import {
  revealPath, openPath, shellContextMenu, createFolder,
  copyPath, renameItem, moveItems, deletePath, copyFiles,
  hasNativeMove, moveItemsNative, fetchDupesV2Bounded, runCommand,
  exportUrl, printReportAsPdf, webFetch, webSearch,
  clipboardWriteFiles, clipboardReadFiles, copyItemsNative, hasNativeCopy,
} from "../api/client";
import type { ScanOptions, ExportFormat } from "../api/client";
import type { NodeRecord, SortKey } from "../api/types";
import { isNoOpMove, buildWriteFileCommand, buildEditFileCommand, readFileWindow, type AgentApi } from "../lib/agent";
import { confirmRisky, isCrossDrive } from "../lib/confirmRisky";
import { pushUndo, parentDir } from "../lib/undo";
import { searchNodes } from "../lib/search";
import { toast, type ToastAction } from "../lib/toast";
import { promptDialog } from "../lib/dialogs";
import { TreeTable } from "./TreeTable";
import { ConfigureColumnsMenu } from "./ConfigureColumnsMenu";
import { Treemap } from "./Treemap";
import type { ViewId } from "./ActivityBar";
import { ConflictDialog, type ConflictChoice } from "./ConflictDialog";
import { FilterDialog } from "./FilterDialog";
import { Breadcrumb } from "./Breadcrumb";
import { Icon } from "./Icon";
import type { ScanStatus, ProgressStore } from "../hooks/useScan";
import type { ScanResult, Metric, Unit } from "../api/types";

export interface WorkspaceTabHandle {
  getStatus: () => ScanStatus;
  getData: () => ScanResult | null;
  getProgress: () => { nodes: number; elapsed: number } | null;
  /** The live scan-progress store, so a tiny subscriber (e.g. the status bar
   *  counter) can re-render on progress ticks WITHOUT re-rendering this pane. */
  getProgressStore: () => ProgressStore;
  getErrorMessage: () => string;
  getVisibleCount: () => number;
  getScanPath: () => string;
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
  /** Cut the selection to the clipboard as CF_HDROP (paste = move). #9 */
  doCutFiles: () => void;
  /** Paste CF_HDROP clipboard files into the focused folder (move or copy). #9 */
  doPaste: () => void;
  /** Drop Explorer files into a specific folder (drag-in): move same-drive, copy cross-drive. #9 */
  dropExternalInto: (paths: string[], destination: string) => Promise<void>;
  doRename: () => void;
  doRenamePath: (path: string) => void;
  doDelete: () => void;
  doDeletePaths: (paths: string[]) => void;
  doMoveTo: () => void;
  doCopyPath: () => void;
  doCopyFiles: () => void;
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
  unit: Unit;
  scanPath: string;
  scanning: boolean;
  treeRows: NodeRecord[];
  expanded: Set<number>;
  selectedId: number;
  selectedNode: NodeRecord | undefined;
  errorCount: number;
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

// Filesystem-watch tuning. Patching is O(n) over the whole node array, so on big
// scans we throttle hard and only patch folders the user actually has open.
const WATCH_DEBOUNCE_MS = 700;
const WATCH_MAX_BATCH = 6;
const WATCH_LARGE_TREE = 50_000;

interface WorkspaceTabProps {
  tabId: string;
  initialPath: string;
  active: boolean;
  // Drives the in-pane treemap "view"; the shared side bar (App) tracks its own.
  activeView: ViewId;
  // Activity-bar Search query (already debounced in App). When activeView ===
  // "search" and this has >= 2 chars, the main table renders flat search results.
  searchQuery: string;
  // Whether the per-pane controls toolbar row (under the tabs) is shown. Toggled
  // from the tab bar's toolbar button; per-editor-group, defaults to visible.
  toolbarVisible: boolean;
  darkMode: boolean;
  panelOpen: boolean;
  onPanelOpenChange: (v: boolean) => void;
  panelHeight: number;
  onPanelHeightChange: (n: number) => void;
  // data + options
  bookmarkList: string[];
  threads: number;
  includeHidden: boolean;
  followLinks: boolean;
  /** Opt-in Windows owner resolution (off by default; slower scans). */
  collectOwners: boolean;
  /** Toggling this re-scans the current path so owners (de)populate. */
  onCollectOwnersChange: (v: boolean) => void;
  exclude: string;
  treemapDetail: number;
  tmShowSingleFiles: boolean;
  tmShow3D: boolean;
  tmShowHierarchy: boolean;
  tmShowLegend: boolean;
  tmShowLabels: boolean;
  tmDragDrop: boolean;
  decimals: number;
  visibleColumns: Set<SortKey>;
  onVisibleColumnsChange: (cols: Set<SortKey>) => void;
  onDecimalsChange: (d: number) => void;
  onClose3D: () => void;
  onToggleBookmark: (path: string) => void;
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
  onOpenFolderInTab?: (path: string, groupId?: string) => void;
  // Reverse the most recent reversible op (the same handler Ctrl+Z runs). Wired
  // to the "Undo (Ctrl+Z)" action link on move/rename/recycle success toasts.
  onUndo?: () => void;
}

const WorkspaceTabInner = forwardRef<WorkspaceTabHandle, WorkspaceTabProps>(function WorkspaceTab(
  {
    tabId, initialPath, active, activeView, searchQuery, toolbarVisible, darkMode,
    panelOpen, onPanelOpenChange, panelHeight, onPanelHeightChange,
    bookmarkList, threads, includeHidden, followLinks, collectOwners, onCollectOwnersChange, exclude,
    treemapDetail,
    tmShowSingleFiles, tmShow3D, tmShowHierarchy, tmShowLegend, tmShowLabels, tmDragDrop,
    decimals, visibleColumns, onVisibleColumnsChange, onDecimalsChange,
    onClose3D, onToggleBookmark, onScanPath, onStateChange, onWorkbenchChange, onOpenTerminal,
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
  const dragStartRef = useRef<{ y: number; h: number } | null>(null);

  const { data, status, errorMessage, progressStore, startScan, startRefresh, cancelScan } = useScan();
  const tree = useTreeState();
  // Latest tree snapshot for stable callbacks / async watch handlers (avoids
  // recreating callbacks every render and reading stale expansion state).
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set([0]));
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const selectionAnchorIdRef = useRef<number>(0);
  const isFirstChunkRef = useRef(true);
  const lastCompletedPathRef = useRef<string>("");
  const lastScanWasRefreshRef = useRef(false);
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

  const fsEventsRef = useRef<EventSource | null>(null);
  const watchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingChangesRef = useRef<Set<string>>(new Set());
  const suppressWatchRef = useRef(false);
  // Skip stacking watch patches: a new batch is dropped/retried while one runs.
  const patchInFlightRef = useRef(false);
  // Latest path→node map, read inside the async watch flush for gating.
  const nodeByPathRef = useRef<Map<string, NodeRecord>>(new Map());

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
    if (isRefresh) {
      lastScanWasRefreshRef.current = true;
      startRefresh(opts);
    } else {
      lastScanWasRefreshRef.current = false;
      startScan(opts);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanPath, threads, includeHidden, followLinks, collectOwners, exclude, startScan, startRefresh, tree]);

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
    if (initialPath && !hasStartedRef.current) {
      hasStartedRef.current = true;
      doScan(initialPath);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPath]);

  useEffect(() => {
    if (data === null) {
      tree.setNodes([]);
      isFirstChunkRef.current = true;
    } else if (lastScanWasRefreshRef.current) {
      tree.setNodes(data.nodes ?? []);
      suppressWatchRef.current = false;
    } else {
      tree.setNodes(data.nodes ?? []);
      if (isFirstChunkRef.current) {
        const isSamePath = data.rootPath === lastCompletedPathRef.current;
        if (!isSamePath) tree.resetForNewScan();
        isFirstChunkRef.current = false;
      }
    }
    onStateChange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

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

  // The Explorer side bar / status bar / inspector live once in App (shared,
  // around the editor groups) and pull their data from the focused pane's
  // getSidebarModel(). When THIS is the visible tab, publish to the workbench
  // store on tree/selection/path changes so ONLY those subscribers re-render —
  // App's title bar/menus/tab bar stay put. data/status changes also publish via
  // onStateChange above (which keeps the shell's scan-level state in sync too).
  useEffect(() => {
    if (active) onWorkbenchChange();
  }, [active, tree.visibleRows, tree.expanded, tree.selectedId, tree.nodeById, scanPath, onWorkbenchChange]);

  const startWatch = useCallback((rootPath: string) => {
    if (fsEventsRef.current) { fsEventsRef.current.close(); fsEventsRef.current = null; }
    if (watchDebounceRef.current) { clearTimeout(watchDebounceRef.current); watchDebounceRef.current = null; }
    pendingChangesRef.current.clear();

    const url = `/api/fs-events?path=${encodeURIComponent(rootPath)}`;
    const es = new EventSource(url);
    fsEventsRef.current = es;

    // Coalesced + gated flush. A big drive (e.g. C:\) churns logs/registry/temp
    // nonstop; patching every change would rebuild the whole node array each
    // time. So we (1) debounce on a leading timer that is NOT reset per event
    // (it fires ~700ms after the first pending change), (2) only patch dirs the
    // user actually has open/visible, and (3) never stack patches.
    async function flushWatch() {
      watchDebounceRef.current = null;
      if (patchInFlightRef.current) {
        // A patch is still running — retry shortly without losing pending dirs.
        watchDebounceRef.current = setTimeout(flushWatch, WATCH_DEBOUNCE_MS);
        return;
      }
      if (suppressWatchRef.current) { pendingChangesRef.current.clear(); return; }

      const t = treeRef.current;
      const byPath = nodeByPathRef.current;
      const bigTree = t.nodeById.size > WATCH_LARGE_TREE;

      // Gate: keep only changed dirs that are loaded AND currently expanded, so
      // background churn in unopened folders is ignored (reflected on next scan).
      const dirs: string[] = [];
      for (const d of pendingChangesRef.current) {
        const node = byPath.get(d);
        if (!node) continue; // dir isn't in our tree → nothing visible to update
        const isOpen = node.id === 0
          || (t.expandedAll ? !bigTree : t.expanded.has(node.id));
        if (isOpen) dirs.push(d);
      }
      pendingChangesRef.current.clear();
      if (dirs.length === 0) return;

      // Coalesce nested dirs and cap the batch so one flush can't stall the UI.
      dirs.sort((a, b) => a.length - b.length);
      const toScan: string[] = [];
      for (const d of dirs) {
        if (!toScan.some(q => d === q || d.startsWith(q + "\\") || d.startsWith(q + "/")))
          toScan.push(d);
        if (toScan.length >= WATCH_MAX_BATCH) break;
      }

      patchInFlightRef.current = true;
      try {
        for (const dir of toScan) {
          if (suppressWatchRef.current) break;
          invalidateScanCache(dir);
          try {
            // Streamed (NDJSON) shallow rescan: parsed line-by-line so a
            // background watch patch never buffers a whole JSON blob in memory.
            const result = await fetchScanStream({
              path: dir,
              threads,
              includeHidden,
              followLinks,
              collectOwners,
              excludePatterns: exclude ? exclude.split(",").map((s) => s.trim()).filter(Boolean) : [],
              maxDepth: 1,
              nocache: true,
            });
            if (result?.nodes?.length) treeRef.current.patchDirectory(dir, result.nodes);
          } catch { /* ignore network errors */ }
        }
      } finally {
        patchInFlightRef.current = false;
      }
    }

    es.onmessage = (evt) => {
      let changedDir: string;
      try { changedDir = JSON.parse(evt.data) as string; }
      catch { return; }
      pendingChangesRef.current.add(changedDir);
      // Leading-edge: schedule once, don't reset on every event during a storm.
      if (!watchDebounceRef.current) {
        watchDebounceRef.current = setTimeout(flushWatch, WATCH_DEBOUNCE_MS);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, includeHidden, followLinks, collectOwners, exclude]);

  useEffect(() => {
    if (status === "done" && data) {
      lastCompletedPathRef.current = data.rootPath;
      if (active) startWatch(data.rootPath);
      // Seed history with the very first completed root (initial/restored scan).
      // Subsequent navigations push via openLocation; this only fires once.
      setNavHistory((prev) => (prev.index === -1 ? { stack: [data.rootPath], index: 0 } : prev));
    }
    if (status === "scanning") {
      fsEventsRef.current?.close();
      fsEventsRef.current = null;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  useEffect(() => {
    if (!active) {
      fsEventsRef.current?.close();
      fsEventsRef.current = null;
      if (watchDebounceRef.current) { clearTimeout(watchDebounceRef.current); watchDebounceRef.current = null; }
    } else if (status === "done" && data) {
      startWatch(data.rootPath);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

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
    const node = t.nodeById.get(id);
    if (!node || node.id < 0 || !node.path) return;

    if (mode === "range") {
      const anchorId = selectionAnchorIdRef.current;
      const anchorIndex = t.visibleRows.findIndex((row) => row.id === anchorId);
      const targetIndex = t.visibleRows.findIndex((row) => row.id === id);
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const [start, end] = anchorIndex < targetIndex
          ? [anchorIndex, targetIndex]
          : [targetIndex, anchorIndex];
        const rangeIds = t.visibleRows
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

  const handleContextMenu = useCallback((id: number, x: number, y: number) => {
    const t = treeRef.current;
    const selIds = selectedIdsRef.current;
    const alreadySelected = selIds.has(id);
    if (!alreadySelected) handleSelectRow(id, "single");
    const node = t.nodeById.get(id);
    if (!node || node.id < 0 || !node.path) return;
    const targets = alreadySelected && selIds.size > 1
      ? [...selIds].map((sid) => t.nodeById.get(sid)?.path).filter((p): p is string => !!p)
      : [node.path];
    shellContextMenu(targets, x, y).catch(() => {});
  }, [handleSelectRow]);

  const handleDblClick = useCallback((id: number) => {
    const node = treeRef.current.nodeById.get(id);
    if (!node) return;
    // Double-clicking a folder opens it in a real File Explorer window (#11);
    // in-app drill-in stays available via the expand chevron / breadcrumb /
    // "Open in new tab". Files open in their default app, unchanged.
    openPath(node.path);
  }, []);

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
    const selected = tree.nodeById.get(tree.selectedId);
    const base = selected?.dir
      ? selected.path
      : selected?.parent != null
        ? (tree.nodeById.get(selected.parent)?.path ?? scanPath)
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
      doScan();
    } catch (e) {
      toast.error(`Could not create folder: ${e instanceof Error ? e.message : e}`);
    }
  }, [tree, scanPath, doScan]);

  const handleTreemapOpen = useCallback((id: number) => {
    const node = treeRef.current.nodeById.get(id);
    if (node && !node.dir && node.path) openPath(node.path);
  }, []);

  const selectedNode = tree.nodeById.get(tree.selectedId);
  const selectedNodes = useMemo(() => {
    const nodes = Array.from(selectedIds)
      .map((id) => tree.nodeById.get(id))
      .filter((node): node is NodeRecord => !!node && node.id >= 0 && !!node.path);
    return nodes.length > 0 && selectedNode?.path ? nodes : selectedNode?.path ? [selectedNode] : [];
  }, [selectedIds, selectedNode, tree.nodeById]);
  const nodeByPath = useMemo(() => {
    const map = new Map<string, NodeRecord>();
    for (const node of tree.nodeById.values()) {
      if (node.path) map.set(node.path, node);
    }
    return map;
  }, [tree.nodeById]);
  nodeByPathRef.current = nodeByPath;
  const selectedPaths = useMemo(
    () => dedupeNestedPaths(selectedNodes.map((node) => node.path), nodeByPath),
    [nodeByPath, selectedNodes],
  );

  useEffect(() => {
    const node = tree.nodeById.get(tree.selectedId);
    if (!node || node.id < 0 || !node.path) return;
    setSelectedIds((prev) => {
      const valid = new Set(Array.from(prev).filter((id) => tree.nodeById.has(id)));
      if (valid.has(tree.selectedId) && valid.size === prev.size) return prev;
      selectionAnchorIdRef.current = tree.selectedId;
      return new Set([tree.selectedId]);
    });
  }, [tree.selectedId, tree.nodeById]);

  const runReveal   = useCallback(() => { if (selectedNode) revealPath(selectedNode.path); }, [selectedNode]);
  const runOpen     = useCallback(() => { if (selectedNode) openPath(selectedNode.path); }, [selectedNode]);
  const runCopyPath = useCallback(() => { if (selectedNode) copyPath(selectedNode.path).catch(() => {}); }, [selectedNode]);

  // Open the integrated terminal at the selected folder (a file → its folder),
  // falling back to the scanned root.
  const handleOpenTerminal = useCallback(() => {
    let cwd = data?.rootPath || scanPath;
    if (selectedNode?.path) {
      const parentId = selectedNode.parent;
      cwd = selectedNode.dir
        ? selectedNode.path
        : (parentId != null ? tree.nodeById.get(parentId)?.path ?? cwd : cwd);
    }
    onOpenTerminal?.(cwd);
  }, [selectedNode, tree, data, scanPath, onOpenTerminal]);

  const [renamingId, setRenamingId] = useState<number | null>(null);

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
    const node = tree.nodeById.get(id);
    if (!node) return;
    const newName = rawName.trim();
    if (!newName || newName === node.name) return;
    const result = await renameItem(node.path, newName);
    if (!result.ok) { toast.error(`Rename failed: ${result.error ?? "unknown error"}`); return; }
    // Phase 6: record the reverse (rename back to the original name) for Ctrl+Z.
    pushUndo({ kind: "rename", parent: parentDir(node.path), from: node.name, to: newName });
    toast.success(`Renamed to \u201C${newName}\u201D.`, { action: undoAction });
    invalidateAllScanCache();
    doScan(undefined, undefined, true);
  }, [tree.nodeById, doScan, undoAction]);

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
    doScan();
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
  }, [nodeByPath, selectedPaths, doScan, undoAction]);

  const runDelete = useCallback(() => { void runDeletePaths(); }, [runDeletePaths]);

  const [conflictPrompt, setConflictPrompt] = useState<{
    names: string[];
    resolve: (choice: ConflictChoice) => void;
  } | null>(null);
  const [moveNotice, setMoveNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!moveNotice) return;
    const timer = window.setTimeout(() => setMoveNotice(null), 2600);
    return () => window.clearTimeout(timer);
  }, [moveNotice]);

  const askConflict = useCallback(
    (names: string[]) => new Promise<ConflictChoice>((resolve) => setConflictPrompt({ names, resolve })),
    [],
  );
  const handleConflictChoice = useCallback((choice: ConflictChoice) => {
    setConflictPrompt((prev) => { prev?.resolve(choice); return null; });
  }, []);

  const runMoveWithConflicts = useCallback(
    async (sources: string[], destination: string): Promise<{ ok: boolean; error?: string }> => {
      const detected = await moveItems(sources, destination);
      const allErrors = [...detected.errors];
      if (detected.conflicts.length > 0) {
        const choice = await askConflict(detected.conflicts.map((c) => c.name));
        if (choice === "replace" || choice === "keep-both") {
          const resolved = await moveItems(detected.conflicts.map((c) => c.src), destination, choice);
          allErrors.push(...resolved.errors);
        }
      } else if (detected.alreadyThere.length > 0 && detected.moved.length === 0) {
        const n = detected.alreadyThere.length;
        setMoveNotice(n === 1 ? "Already in this folder." : `${n} items are already in this folder.`);
      }
      return allErrors.length > 0 ? { ok: false, error: allErrors.join("; ") } : { ok: true };
    },
    [askConflict],
  );

  const runCopyFiles = useCallback(() => {
    if (selectedPaths.length > 0) copyFiles(selectedPaths).catch(() => {});
  }, [selectedPaths]);

  // Cut the selection: CF_HDROP with a MOVE drop effect so Explorer dims the
  // items and a later Paste (here or in Explorer) relocates them (#9).
  const runCutFiles = useCallback(() => {
    if (selectedPaths.length > 0) clipboardWriteFiles(selectedPaths, true).catch(() => {});
  }, [selectedPaths]);

  // Where a Paste lands: a single selected folder, else the scanned root.
  const pasteTargetFolder = useCallback((): string | null => {
    if (!data) return null;
    if (selectedPaths.length === 1) {
      const node = nodeByPath.get(selectedPaths[0]);
      if (node?.dir) return node.path;
    }
    return data.rootPath;
  }, [data, selectedPaths, nodeByPath]);

  // Copy clipboard/dropped files INTO `destination` via the guarded native shell
  // COPY (IFileOperation): native progress/collision dialogs, recycle-on-
  // overwrite, descendant/no-op skip, and per-item audit — never a raw copy that
  // could clobber. Risk-scoped confirm for large/many batches mirrors moves (#9).
  const runPasteCopy = useCallback(async (sources: string[], destination: string): Promise<void> => {
    if (sources.length === 0 || !destination) return;
    const byPath = nodeByPathRef.current;
    const copyBytes = sources.reduce((sum, s) => sum + (byPath.get(s)?.size ?? 0), 0);
    const proceed = await confirmRisky({
      kind: "copy",
      crossDrive: isCrossDrive(sources, destination),
      itemCount: sources.length,
      totalBytes: copyBytes,
      names: sources.map((s) => byPath.get(s)?.name ?? basenameFromPath(s)),
    });
    if (!proceed) { setMoveNotice("Paste canceled."); return; }
    if (!hasNativeCopy()) { setMoveNotice("Paste-copy requires the FileTree desktop app."); return; }
    try {
      suppressWatchRef.current = true;
      const res = await copyItemsNative(sources, destination);
      if (res.failed > 0) {
        setMoveNotice(`${res.failed} item${res.failed === 1 ? "" : "s"} could not be copied${res.aborted ? " (canceled)" : ""}.`);
      } else if (res.moved === 0 && res.skipped > 0) {
        setMoveNotice("Nothing to paste here.");
      }
      invalidateAllScanCache();
      doScan(undefined, undefined, true);
    } catch (e) {
      suppressWatchRef.current = false;
      setMoveNotice(`Paste failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [doScan]);

  const handleInternalMove = useCallback(async (sources: string[], destination: string): Promise<{ ok: boolean; error?: string }> => {
    if (sources.length === 0 || !destination) return { ok: true };
    // Drop any source whose move would be a no-op or unsafe — dropped onto
    // itself, into one of its own descendants, or into the folder it already
    // lives in directly. The guard is normalized + case-insensitive (reliable on
    // Windows), replacing the old case-sensitive self/descendant string check.
    const realSources = sources.filter((s) => s && !isNoOpMove(s, destination));
    if (realSources.length === 0) {
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
      setMoveNotice("Move canceled.");
      return { ok: true };
    }
    try {
      suppressWatchRef.current = true;
      let outcome: { ok: boolean; error?: string };
      let didMove = false;
      if (hasNativeMove()) {
        const res = await moveItemsNative(realSources, destination);
        // Honor the native result instead of assuming success. A fully cancelled
        // dialog (nothing moved, nothing failed) is just a no-op notice, while
        // any item that didn't make it — a per-item failure or a "Skip" in the
        // native collision dialog — is surfaced so the caller can report it.
        if (res.aborted && res.moved === 0 && res.failed === 0) {
          setMoveNotice("Move canceled.");
          outcome = { ok: true };
        } else if (res.failed > 0) {
          didMove = res.moved > 0;
          outcome = {
            ok: false,
            error: `${res.failed} item${res.failed === 1 ? "" : "s"} could not be moved${res.aborted ? " (move canceled)" : ""}.`,
          };
        } else {
          didMove = res.moved > 0;
          outcome = { ok: true };
        }
      } else {
        outcome = await runMoveWithConflicts(realSources, destination);
        didMove = outcome.ok;
      }
      // Phase 6 undo: record the reverse move (each item back to its original
      // parent) when at least one item actually moved. The executor only moves
      // back items still present at the destination, so partial moves are safe.
      if (didMove) {
        pushUndo({
          kind: "move",
          destination,
          items: realSources.map((s) => ({ name: basenameFromPath(s), originalParent: parentDir(s) })),
        });
        // Reversible move — offer Undo on a clean success (partial failures are
        // surfaced by the caller, so we don't also claim success there).
        if (outcome.ok) {
          toast.success(`Moved ${itemsLabel(realSources.length)} to \u201C${basenameFromPath(destination)}\u201D.`, { action: undoAction });
        }
      }
      invalidateAllScanCache();
      doScan(undefined, undefined, true);
      return outcome;
    } catch (error) {
      suppressWatchRef.current = false;
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }, [doScan, runMoveWithConflicts, undoAction]);

  // Paste CF_HDROP files into the focused folder. A Cut pastes as a MOVE through
  // the existing guarded move flow (handleInternalMove: no-op/descendant guards,
  // recycle-on-overwrite, risk confirm, audit, undo); a Copy pastes via the
  // guarded native copy above (#9). Declared after handleInternalMove so the
  // const is initialised before these closures capture it.
  const runPaste = useCallback(async () => {
    if (!data) return;
    const clip = await clipboardReadFiles();
    if (!clip.paths.length) { setMoveNotice("Clipboard has no files to paste."); return; }
    const dest = pasteTargetFolder();
    if (!dest) return;
    if (clip.preferMove) {
      const outcome = await handleInternalMove(clip.paths, dest);
      if (!outcome.ok) setMoveNotice(`Paste failed: ${outcome.error ?? "unknown error"}`);
    } else {
      await runPasteCopy(clip.paths, dest);
    }
  }, [data, pasteTargetFolder, handleInternalMove, runPasteCopy]);

  // Explorer drag-in dropped onto a folder row: Explorer-like effect — same-drive
  // MOVE, cross-drive COPY (avoids the move=copy+delete hazard). Both route
  // through the guarded engines, so the data-safety guards still fire (#9).
  const dropExternalInto = useCallback(async (sources: string[], destination: string): Promise<void> => {
    if (sources.length === 0 || !destination) return;
    if (isCrossDrive(sources, destination)) {
      await runPasteCopy(sources, destination);
    } else {
      const outcome = await handleInternalMove(sources, destination);
      if (!outcome.ok) setMoveNotice(`Drop failed: ${outcome.error ?? "unknown error"}`);
    }
  }, [handleInternalMove, runPasteCopy]);

  // "Move to..." (ribbon / context action). Route through handleInternalMove so
  // that in Electron it uses the native shell move (IFileOperation) with the real
  // Windows progress + conflict dialog — exactly like drag, treemap and the AI
  // agent already do. The /api/move-items path stays only as the !hasNativeMove()
  // (browser / dev) fallback, which handleInternalMove selects internally.
  const runMoveTo = useCallback(async () => {
    if (selectedPaths.length === 0) return;
    const dest = await promptDialog({
      title: "Move to folder",
      label: "Destination folder",
      placeholder: "C:\\path\\to\\folder",
      confirmLabel: "Move",
    });
    if (dest == null) return; // canceled
    const outcome = await handleInternalMove(selectedPaths, dest.trim());
    if (!outcome.ok) { toast.error(`Move failed: ${outcome.error ?? "unknown error"}`); return; }
  }, [selectedPaths, handleInternalMove]);

  // After a native drag moved item(s) OUT of this tree (a true move to Explorer
  // or another app), the source is gone from disk; drop our cached scan and
  // rescan so a moved-out folder doesn't keep showing in an expanded parent.
  const handleAfterExternalMove = useCallback(() => {
    invalidateAllScanCache();
    doScan(undefined, undefined, true);
  }, [doScan]);

  // ── Agent API facade (used by the right-side ChatPanel) ──────────────────
  const agentApi = useMemo<AgentApi>(() => ({
    getScanPath: () => scanPath,
    getScanResult: () => data,
    getNodes: () => Array.from(tree.nodeById.values()),
    scanFolder: async (path: string) => { openLocation(path); },
    refresh: async () => { invalidateAllScanCache(); doScan(undefined, undefined, true); },
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
        invalidateAllScanCache();
        doScan(undefined, undefined, true);
      }
      return r;
    },
    createFolder: async (path: string) => {
      try { await createFolder(path); pushUndo({ kind: "mkdir", path }); doScan(); return { ok: true }; }
      catch (e) { return { ok: false, error: (e as Error).message }; }
    },
    reveal: async (path: string) => { revealPath(path); },
    // Run an approved shell command, then refresh the tree (deletions, recycle,
    // etc. change the folder). cwd defaults to this tab's scanned folder.
    runCommand: async (command: string, cwd?: string, shell?: "powershell" | "cmd") => {
      const res = await runCommand(command, cwd ?? scanPath, shell ? { shell } : undefined);
      invalidateAllScanCache();
      doScan(undefined, undefined, true);
      return res;
    },
    // Read-only bounded text read (server caps at ~64 KiB; we window by line).
    readFile: async (path: string, opts) => readFileWindow(path, opts),
    // Create/overwrite a text file via an approved PowerShell write, then rescan.
    writeFile: async (path: string, content: string) => {
      const res = await runCommand(buildWriteFileCommand(path, content), parentDir(path) || scanPath);
      invalidateAllScanCache();
      doScan(undefined, undefined, true);
      return res;
    },
    // Exact-substring edit via an approved PowerShell replace, then rescan.
    editFile: async (path: string, oldString: string, newString: string) => {
      const res = await runCommand(buildEditFileCommand(path, oldString, newString), parentDir(path) || scanPath);
      invalidateAllScanCache();
      doScan(undefined, undefined, true);
      return res;
    },
    webFetch: async (url: string, opts) => webFetch(url, opts),
    webSearch: async (query: string) => webSearch(query),
  }), [scanPath, data, tree.nodeById, openLocation, doScan, handleInternalMove]);

  useImperativeHandle(ref, () => ({
    getStatus: () => status,
    getData: () => data,
    getProgress: () => progressStore.get(),
    getProgressStore: () => progressStore,
    getErrorMessage: () => errorMessage,
    getVisibleCount: () => tree.visibleRows.length,
    getScanPath: () => scanPath,
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
        unit: t.unit,
        scanPath,
        scanning: status === "scanning",
        treeRows: t.visibleRows,
        expanded: t.expanded,
        selectedId: t.selectedId,
        selectedNode: t.nodeById.get(t.selectedId),
        errorCount: data?.errorCount ?? 0,
        onNavigate: handleNavigate,
        onScanPathInput: setScanPathState,
        onScan: () => openLocation(scanPath),
        onCancel: cancelScan,
        onRefresh: () => doScan(undefined, undefined, true),
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
    doDelete: runDelete,
    doDeletePaths: (paths) => { void runDeletePaths(paths); },
    doMoveTo: runMoveTo,
    doCopyPath: runCopyPath,
    doCopyFiles: runCopyFiles,
    doCutFiles: runCutFiles,
    doPaste: () => { void runPaste(); },
    dropExternalInto: (paths, destination) => dropExternalInto(paths, destination),
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
    refresh: () => { invalidateAllScanCache(); doScan(undefined, undefined, true); },
  }), [status, data, progressStore, errorMessage, scanPath, tree, cancelScan, agentApi,
       doScan, handleNavigate, handleNavigateParent, handleExpand, handleNewFolder, selectedNode,
       openLocation, goBack, goForward, navHistory, runOpen, runReveal, onScanPath,
       runRename, runRenamePath, runDelete, runDeletePaths, runMoveTo, runCopyPath, runCopyFiles,
       runCutFiles, runPaste, dropExternalInto]);

  // Bottom-panel (treemap) vertical resize.
  const handlePanelResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragStartRef.current = { y: e.clientY, h: panelHeight };
    const onMove = (ev: MouseEvent) => {
      if (!dragStartRef.current) return;
      const delta = dragStartRef.current.y - ev.clientY;
      onPanelHeightChange(Math.max(120, Math.min(900, dragStartRef.current.h + delta)));
    };
    const onUp = () => {
      dragStartRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [panelHeight, onPanelHeightChange]);

  const showTreemapView = activeView === "treemap";
  // Flat, sorted name/path matches across the whole scan. Rendered in the main
  // table (replacing the tree rows) when the Search view is active with a >= 2
  // char query; re-sorts automatically because it reads the active sortKey/dir.
  const searchResults = useMemo(
    () => searchNodes(tree.nodeById, searchQuery, tree.sortKey, tree.sortDir, 2000),
    [tree.nodeById, searchQuery, tree.sortKey, tree.sortDir],
  );
  const searching = activeView === "search" && searchQuery.trim().length >= 2;
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
  // content. The virtualized TreeTable and the two Treemap canvases are
  // unmounted, freeing their DOM + canvas backing stores and skipping any
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
        {showTreemapView ? (
          <>
            {toolbarVisible && (
            <div className="editor-toolbar">
              <label>
                Size
                <select value={tree.metric} onChange={(e) => tree.setMetric(e.target.value as Metric)}>
                  <option value="size">Size</option>
                  <option value="allocated">Allocated</option>
                  <option value="files">Files</option>
                  <option value="folders">Folders</option>
                </select>
              </label>
              <label>
                Unit
                <select value={tree.unit} onChange={(e) => tree.setUnit(e.target.value as Unit)}>
                  <option value="auto">Auto</option>
                  <option value="tb">TB</option>
                  <option value="gb">GB</option>
                  <option value="mb">MB</option>
                  <option value="kb">KB</option>
                  <option value="bytes">Bytes</option>
                </select>
              </label>
            </div>
            )}
            <div className="editor-stack">
              <div className="editor-main">
                <Treemap
                  nodeById={tree.nodeById}
                  selectedId={tree.selectedId}
                  metric={tree.metric}
                  unit={tree.unit}
                  detail={treemapDetail}
                  darkMode={darkMode}
                  showSingleFiles={tmShowSingleFiles}
                  show3D={tmShow3D}
                  showHierarchy={tmShowHierarchy}
                  showLegend={tmShowLegend}
                  showLabels={tmShowLabels}
                  dragDrop={tmDragDrop}
                  onSelect={tree.setSelectedId}
                  onNavigate={handleNavigate}
                  onOpen={handleTreemapOpen}
                  onClose3D={onClose3D}
                />
              </div>
            </div>
          </>
        ) : (
          <>
            {toolbarVisible && (
            <div className="editor-toolbar">
              <label>
                Size
                <select value={tree.metric} onChange={(e) => tree.setMetric(e.target.value as Metric)}>
                  <option value="size">Size</option>
                  <option value="allocated">Allocated</option>
                  <option value="files">Files</option>
                  <option value="folders">Folders</option>
                </select>
              </label>
              <label>
                Unit
                <select value={tree.unit} onChange={(e) => tree.setUnit(e.target.value as Unit)}>
                  <option value="auto">Auto</option>
                  <option value="tb">TB</option>
                  <option value="gb">GB</option>
                  <option value="mb">MB</option>
                  <option value="kb">KB</option>
                  <option value="bytes">Bytes</option>
                </select>
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
              <button onClick={() => tree.expandToLevel(Infinity)}>Expand all</button>
              <button onClick={() => tree.expandToLevel(0)}>Collapse all</button>
              <span className="sep" />
              <input
                placeholder="Filter…"
                value={filterInput}
                onChange={(e) => setFilterInput(e.target.value)}
                style={{ height: 24, width: 150, background: "var(--vsc-input-bg)", border: "1px solid var(--vsc-border)", color: "var(--text)" }}
              />
              <button onClick={() => setFilterDialogOpen(true)} title="Advanced filter">Rules</button>
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
              <button
                className={panelOpen ? "active" : ""}
                onClick={() => onPanelOpenChange(!panelOpen)}
                title="Toggle treemap panel"
              >Treemap</button>
            </div>
            )}

            <div className="editor-stack">
              <div className="editor-main">
                <TreeTable
                  rows={searching ? searchResults : tree.visibleRows}
                  flat={searching}
                  nodeById={tree.nodeById}
                  expanded={tree.expanded}
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
                  onToggleExpand={tree.toggleExpand}
                  onSelect={handleSelectRow}
                  onDoubleClick={handleDblClick}
                  onContextMenu={handleContextMenu}
                  onCopySelected={runCopyFiles}
                  onMoveItems={handleInternalMove}
                  onOpenFolderInTab={onOpenFolderInTab}
                  onAfterExternalMove={handleAfterExternalMove}
                  onSortChange={handleSortChange}
                  bookmarks={bookmarkSet}
                  onToggleBookmark={onToggleBookmark}
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

              {panelOpen && (
                <>
                  <div className="resizer-y" onMouseDown={handlePanelResize} />
                  <div className="bottom-panel" style={{ height: panelHeight, flex: `0 0 ${panelHeight}px` }}>
                    <div className="bottom-panel-header">
                      <span className="bottom-panel-tab active">Treemap</span>
                      <span className="spacer" />
                      <button className="icon" title="Close panel" onClick={() => onPanelOpenChange(false)}><Icon name="x" size={13} /></button>
                    </div>
                    <div className="bottom-panel-body">
                      <Treemap
                        nodeById={tree.nodeById}
                        selectedId={tree.selectedId}
                        metric={tree.metric}
                        unit={tree.unit}
                        detail={treemapDetail}
                        darkMode={darkMode}
                        showSingleFiles={tmShowSingleFiles}
                        show3D={tmShow3D}
                        showHierarchy={tmShowHierarchy}
                        showLegend={tmShowLegend}
                        showLabels={tmShowLabels}
                        dragDrop={tmDragDrop}
                        onSelect={tree.setSelectedId}
                        onNavigate={handleNavigate}
                        onMoveItems={handleInternalMove}
                        onOpen={handleTreemapOpen}
                        onClose3D={onClose3D}
                      />
                    </div>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>

      {filterDialogOpen && (
        <FilterDialog
          initialRules={tree.filterRules}
          onApply={tree.setFilterRules}
          onClose={() => setFilterDialogOpen(false)}
        />
      )}

      {conflictPrompt && (
        <ConflictDialog names={conflictPrompt.names} onChoice={handleConflictChoice} />
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
