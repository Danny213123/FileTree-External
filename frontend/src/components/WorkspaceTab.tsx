import { useState, useEffect, useCallback, useRef, forwardRef, useImperativeHandle } from "react";
import { useScan, reconstructChildren } from "../hooks/useScan";
import { useTreeState } from "../hooks/useTreeState";
import { invalidate as invalidateScanCache } from "../lib/scanCache";
import {
  revealPath, openPath, shellContextMenu, createFolder, fetchScan,
} from "../api/client";
import type { ScanOptions } from "../api/client";
import type { DriveEntry, SpecialFolder, SortKey } from "../api/types";
import { TreeTable } from "./TreeTable";
import { TabStrip } from "./TabStrip";
import type { TabId } from "./TabStrip";
import { Treemap } from "./Treemap";
import { DetailsTab } from "./DetailsTab";
import { ExtensionsTab } from "./ExtensionsTab";
import { AgeTab } from "./AgeTab";
import { TopFilesTab } from "./TopFilesTab";
import { DuplicatesTab } from "./DuplicatesTab";
import { ErrorsTab } from "./ErrorsTab";
import { BookmarksTab } from "./BookmarksTab";
import { AiChatTab } from "./AiChatTab";
import { DuplicateFinder } from "./DuplicateFinder";
import { FilterDialog } from "./FilterDialog";
import type { ScanStatus } from "../hooks/useScan";
import type { ScanResult } from "../api/types";

export interface WorkspaceTabHandle {
  // Called by App to propagate active tab's status/data upward for the status bar
  getStatus: () => ScanStatus;
  getData: () => ScanResult | null;
  getProgress: () => { nodes: number; elapsed: number } | null;
  getErrorMessage: () => string;
  getVisibleCount: () => number;
  getScanPath: () => string;
  getScanning: () => boolean;
  // Called to trigger actions from the ribbon (which lives in App)
  doScan: () => void;
  doCancel: () => void;
  doScanPath: (path: string) => void;
  doNavigateParent: () => void;
  doExpand: (level: number) => void;
  doNewFolder: () => void;
  doOpenFilter: () => void;
  doReveal: () => void;
  doExport: (format: "csv" | "json") => void;
  // State readers for ribbon props
  getRibbonState: () => RibbonState;
  // State setters called from ribbon
  setMetric: (m: string) => void;
  setUnit: (u: string) => void;
  setFilter: (f: string) => void;
  setShowFiles: (v: boolean) => void;
  setScanPath: (p: string) => void;
  setSortKeyDir: (key: string, dir: 1 | -1) => void;
  showDetailsPane: () => void;
  showTreemapPane: () => void;
}

export interface RibbonState {
  scanPath: string;
  scanning: boolean;
  metric: string;
  unit: string;
  filter: string;
  showFiles: boolean;
  filterActive: boolean;
  activeTab: string;
  sortKey: string;
  sortDir: 1 | -1;
}

interface WorkspaceTabProps {
  tabId: string;
  initialPath: string;
  active: boolean;
  showDuplicateFinder: boolean;
  drives: DriveEntry[];
  specialFolders: SpecialFolder[];
  bookmarkList: string[];
  threads: number;
  includeHidden: boolean;
  followLinks: boolean;
  exclude: string;
  treemapPosition: "bottom" | "right";
  treemapDetail: number;
  tmShowSingleFiles: boolean;
  tmShow3D: boolean;
  tmShowHierarchy: boolean;
  tmShowLegend: boolean;
  tmShowLabels: boolean;
  tmDragDrop: boolean;
  decimals: number;
  visibleColumns: Set<SortKey>;
  onClose3D: () => void;
  onToggleBookmark: (path: string) => void;
  onScanPath: (path: string) => void; // open in current tab
  onOpenInNewTab: (path: string) => void;
  onStateChange: () => void; // notify App that something changed (for status bar refresh)
}

export const WorkspaceTab = forwardRef<WorkspaceTabHandle, WorkspaceTabProps>(function WorkspaceTab(
  {
    tabId, initialPath, active,
    showDuplicateFinder,
    drives, specialFolders,
    bookmarkList, threads, includeHidden, followLinks, exclude,
    treemapPosition, treemapDetail,
    tmShowSingleFiles, tmShow3D, tmShowHierarchy, tmShowLegend, tmShowLabels, tmDragDrop,
    decimals, visibleColumns,
    onClose3D, onToggleBookmark, onScanPath, onOpenInNewTab, onStateChange,
  }: WorkspaceTabProps,
  ref,
) {
  const [scanPath, setScanPathState] = useState(initialPath);
  const [filterDialogOpen, setFilterDialogOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>("chart");
  const [chartHeight, setChartHeight] = useState(420);
  const dragStartRef = useRef<{ y: number; h: number } | null>(null);

  const { data, status, errorMessage, progress, startScan, startRefresh, cancelScan } = useScan();
  const tree = useTreeState();
  const isFirstChunkRef = useRef(true);
  // Root path of the last completed scan. When doScan is called with the same
  // path, we skip resetForNewScan and preserve expansion via mergeNodes instead.
  const lastCompletedPathRef = useRef<string>("");
  // True when the current in-flight scan is a startRefresh call (not startScan).
  // Used in useEffect([status]) to skip the mergeNodes call — refresh callers
  // handle merging directly, and data is stale for refresh paths.
  const lastScanWasRefreshRef = useRef(false);
  const bookmarkSet = new Set(bookmarkList);

  // EventSource for real-time filesystem change notifications (/api/fs-events).
  const fsEventsRef = useRef<EventSource | null>(null);
  // Debounce: coalesce rapid changes before triggering a rescan.
  const watchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Paths whose directories changed since the last debounce flush.
  const pendingChangesRef = useRef<Set<string>>(new Set());


  const doScan = useCallback((path?: string, t?: number) => {
    const p = path ?? scanPath;
    if (!p.trim()) return;
    const opts: ScanOptions = {
      path: p.trim(),
      threads: t ?? threads,
      includeHidden,
      followLinks,
      excludePatterns: exclude ? exclude.split(",").map((s) => s.trim()).filter(Boolean) : [],
    };
    if (p.trim() === lastCompletedPathRef.current) {
      // Same path: use startRefresh so the tree never blanks mid-stream.
      // startRefresh now calls setData(finalResult), which triggers useEffect([data])
      // → tree.mergeNodes, preserving expansion state.
      lastScanWasRefreshRef.current = true;
      startRefresh(opts);
    } else {
      lastScanWasRefreshRef.current = false;
      startScan(opts);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanPath, threads, includeHidden, followLinks, exclude, startScan, startRefresh, tree]);

  // Eager background start: begin scanning immediately on mount so the tab
  // is ready by the time the user clicks it. `active` is intentionally NOT
  // required here — all tabs scan in parallel from the moment they are created.
  const hasStartedRef = useRef(false);
  useEffect(() => {
    if (initialPath && !hasStartedRef.current) {
      hasStartedRef.current = true;
      doScan(initialPath);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPath]);

  // Sync tree nodes whenever data changes (fires for both startScan and startRefresh).
  // For refresh scans we call setNodes directly (same proven path as initial scan).
  useEffect(() => {
    console.log("[data effect] fired, data:", data?.rootPath, "nodes:", data?.nodes?.length, "wasRefresh:", lastScanWasRefreshRef.current);
    if (data === null) {
      tree.setNodes([]);
      isFirstChunkRef.current = true;
    } else if (lastScanWasRefreshRef.current) {
      // Refresh: replace nodes. Expansion state uses stable IDs so mostly survives.
      console.log("[data effect] calling setNodes for refresh with", data.nodes?.length, "nodes");
      tree.setNodes(data.nodes ?? []);
    } else {
      tree.setNodes(data.nodes ?? []);
      if (isFirstChunkRef.current) {
        const isSamePath = data.rootPath === lastCompletedPathRef.current;
        if (!isSamePath) {
          tree.resetForNewScan();
        }
        isFirstChunkRef.current = false;
      }
    }
    onStateChange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(() => { onStateChange(); }, [status, progress, onStateChange]);

  // Real-time filesystem watch via SSE (ReadDirectoryChangesW on backend).
  // Opens an EventSource to /api/fs-events?path=<root>. On each notification
  // the backend sends the changed directory path. We debounce 200ms and rescan
  // only the shallowest affected directories.
  const startWatch = useCallback((rootPath: string) => {
    // Close any existing EventSource before opening a new one
    if (fsEventsRef.current) {
      fsEventsRef.current.close();
      fsEventsRef.current = null;
    }
    if (watchDebounceRef.current) {
      clearTimeout(watchDebounceRef.current);
      watchDebounceRef.current = null;
    }
    pendingChangesRef.current.clear();

    const url = `/api/fs-events?path=${encodeURIComponent(rootPath)}`;
    console.log("[watch] opening EventSource", url);
    const es = new EventSource(url);
    fsEventsRef.current = es;

    es.onopen = () => console.log("[watch] SSE connected");
    es.onerror = (e) => console.warn("[watch] SSE error", e, "readyState:", es.readyState);

    es.onmessage = (evt) => {
      let changedDir: string;
      try { changedDir = JSON.parse(evt.data) as string; }
      catch { return; }
      pendingChangesRef.current.add(changedDir);

      if (watchDebounceRef.current) clearTimeout(watchDebounceRef.current);
      // Short debounce: coalesce burst events (e.g. copying many files at once)
      watchDebounceRef.current = setTimeout(async () => {
        const dirs = [...pendingChangesRef.current];
        pendingChangesRef.current.clear();

        // Deduplicate: drop child paths if parent is already included
        dirs.sort((a, b) => a.length - b.length);
        const toScan: string[] = [];
        for (const d of dirs) {
          if (!toScan.some(q => d === q || d.startsWith(q + "\\") || d.startsWith(q + "/")))
            toScan.push(d);
        }

        // Shallow-rescan each changed directory (maxDepth=1 → only immediate children).
        // ~50ms vs ~1500ms for a full rescan — gives TreeSize-like update latency.
        for (const dir of toScan) {
          invalidateScanCache(dir);
          try {
            const raw = await fetchScan({
              path: dir,
              threads,
              includeHidden,
              followLinks,
              excludePatterns: exclude ? exclude.split(",").map((s) => s.trim()).filter(Boolean) : [],
              maxDepth: 1,
              nocache: true,
            });
            // fetchScan returns raw JSON — nodes lack children[] and path strings.
            // reconstructChildren rebuilds both before we graft into the tree.
            const result = reconstructChildren(raw);
            if (result?.nodes?.length) tree.patchDirectory(dir, result.nodes);
          } catch { /* ignore network errors */ }
        }
      }, 100);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, includeHidden, followLinks, exclude, startRefresh, tree]);

  useEffect(() => {
    if (status === "done" && data) {
      lastCompletedPathRef.current = data.rootPath;
      // (Re)open the SSE watch after every completed scan — both initial and refresh.
      // The EventSource was closed when status changed to "scanning".
      if (active) {
        console.log("[watch] scan done, starting watch on", data.rootPath);
        startWatch(data.rootPath);
      }
    }
    if (status === "scanning") {
      // Close the EventSource while a scan is in progress to avoid duplicate events.
      // It will be reopened when status becomes "done".
      fsEventsRef.current?.close();
      fsEventsRef.current = null;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // Close EventSource when tab is hidden; reopen when shown again.
  useEffect(() => {
    if (!active) {
      fsEventsRef.current?.close();
      fsEventsRef.current = null;
      if (watchDebounceRef.current) {
        clearTimeout(watchDebounceRef.current);
        watchDebounceRef.current = null;
      }
    } else if (status === "done" && data) {
      startWatch(data.rootPath);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const handleScanPath = useCallback((path: string) => {
    setScanPathState(path);
    onScanPath(path);
    cancelScan();
    startScan({
      path,
      threads,
      includeHidden,
      followLinks,
      excludePatterns: exclude ? exclude.split(",").map((s) => s.trim()).filter(Boolean) : [],
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, includeHidden, followLinks, exclude]);

  const handleCtrlClick = useCallback((id: number) => {
    const node = tree.nodeById.get(id);
    if (node?.dir) onOpenInNewTab(node.path);
  }, [tree, onOpenInNewTab]);

  const handleContextMenu = useCallback((id: number, x: number, y: number) => {
    tree.setSelectedId(id);
    const node = tree.nodeById.get(id);
    if (!node || node.id < 0 || !node.path) return;
    shellContextMenu(node.path, x, y).catch(() => {});
  }, [tree]);

  const handleDblClick = useCallback((id: number) => {
    const node = tree.nodeById.get(id);
    if (!node) return;
    if (node.dir) {
      // Navigate into this folder within the current tab only.
      // Do NOT call handleScanPath here — that propagates via onScanPath up to
      // App.handleScanPath → getActiveRef()?.doScanPath(), which may target the
      // wrong tab if the active-ref closure is stale.
      setScanPathState(node.path);
      cancelScan();
      startScan({
        path: node.path,
        threads,
        includeHidden,
        followLinks,
        excludePatterns: exclude ? exclude.split(",").map((s) => s.trim()).filter(Boolean) : [],
      });
    } else {
      openPath(node.path);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, threads, includeHidden, followLinks, exclude, cancelScan, startScan]);

  const handleNavigate = useCallback((id: number) => {
    let node = tree.nodeById.get(id);
    // Ensure all ancestors are open so the node is visible in the table
    while (node && node.parent != null) {
      tree.ensureExpanded(node.parent);
      node = tree.nodeById.get(node.parent);
    }
    tree.setSelectedId(id);
  }, [tree]);

  const handleNavigateParent = useCallback(() => {
    const selected = tree.nodeById.get(tree.selectedId);
    if (selected?.parent != null) {
      tree.setSelectedId(selected.parent);
    } else {
      const parts = scanPath.replace(/[/\\]+$/, "").split(/[/\\]/);
      if (parts.length > 1) {
        const parent = parts.slice(0, -1).join("\\");
        setScanPathState(parent);
      }
    }
  }, [tree, scanPath]);

  const handleExpand = useCallback((level: number) => { tree.expandToLevel(level); }, [tree]);

  const handleNewFolder = useCallback(async () => {
    const selected = tree.nodeById.get(tree.selectedId);
    const base = selected?.dir
      ? selected.path
      : selected?.parent != null
        ? (tree.nodeById.get(selected.parent)?.path ?? scanPath)
        : scanPath;
    const name = window.prompt("New folder name:");
    if (!name?.trim()) return;
    const sep = base.endsWith("\\") || base.endsWith("/") ? "" : "\\";
    try {
      await createFolder(base + sep + name.trim());
      doScan();
    } catch (e) {
      alert(`Could not create folder: ${e instanceof Error ? e.message : e}`);
    }
  }, [tree, scanPath, doScan]);

  const handleTreemapOpen = useCallback((id: number) => {
    const node = tree.nodeById.get(id);
    if (node && !node.dir && node.path) openPath(node.path);
  }, [tree]);

  const selectedNode = tree.nodeById.get(tree.selectedId);
  const runReveal   = useCallback(() => { if (selectedNode) revealPath(selectedNode.path); }, [selectedNode]);
  const runOpen     = useCallback(() => { if (selectedNode) openPath(selectedNode.path); }, [selectedNode]);
  const runCopyPath = useCallback(() => { if (selectedNode) navigator.clipboard.writeText(selectedNode.path).catch(() => {}); }, [selectedNode]);

  // Expose API to parent via ref
  useImperativeHandle(ref, () => ({
    getStatus: () => status,
    getData: () => data,
    getProgress: () => progress,
    getErrorMessage: () => errorMessage,
    getVisibleCount: () => tree.visibleRows.length,
    getScanPath: () => scanPath,
    getScanning: () => status === "scanning",
    doScan: () => doScan(),
    doCancel: cancelScan,
    doScanPath: (path) => { setScanPathState(path); doScan(path); },
    doNavigateParent: handleNavigateParent,
    doExpand: handleExpand,
    doNewFolder: handleNewFolder,
    doOpenFilter: () => setFilterDialogOpen(true),
    doReveal: () => { if (selectedNode) revealPath(selectedNode.path); },
    doExport: (format) => {
      if (!data) return;
      const path = encodeURIComponent(data.rootPath);
      const url = format === "csv"
        ? `/api/export.csv?path=${path}`
        : `/api/export.json?path=${path}`;
      const a = document.createElement("a");
      a.href = url;
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
      activeTab,
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
      // setSortKey toggles direction if same key; force it by setting again when mismatched
      if (tree.sortDir !== dir) tree.setSortKey(key as SortKey);
    },
    showDetailsPane: () => setActiveTab("details"),
    showTreemapPane: () => setActiveTab("chart"),
  }), [status, data, progress, errorMessage, scanPath, activeTab, tree, cancelScan,
       doScan, handleNavigateParent, handleExpand, handleNewFolder, selectedNode]);

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragStartRef.current = { y: e.clientY, h: chartHeight };
    const onMove = (ev: MouseEvent) => {
      if (!dragStartRef.current) return;
      const delta = dragStartRef.current.y - ev.clientY; // drag up = bigger chart
      const newH = Math.max(120, Math.min(900, dragStartRef.current.h + delta));
      setChartHeight(newH);
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
  }, [chartHeight]);

  return (
    <div
      className="workspace"
      data-tab-id={tabId}
      style={active ? undefined : { display: "none" }}
    >
      {showDuplicateFinder && (
        <DuplicateFinder
          scanPath={scanPath}
          hasScan={data !== null}
          drives={drives}
          specialFolders={specialFolders}
          onNavigate={(id) => { handleNavigate(id); }}
          onRescan={doScan}
        />
      )}

      {/* Top row: tree table + side pane */}
      <div className="workspace-top" style={showDuplicateFinder ? { display: "none" } : undefined}>
        <TreeTable
          rows={tree.visibleRows}
          nodeById={tree.nodeById}
          expanded={tree.expanded}
          selectedId={tree.selectedId}
          sortKey={tree.sortKey}
          sortDir={tree.sortDir}
          metric={tree.metric}
          unit={tree.unit}
          decimals={decimals}
          visibleColumns={visibleColumns}
          onToggleExpand={tree.toggleExpand}
          onSelect={tree.setSelectedId}
          onDoubleClick={handleDblClick}
          onCtrlClick={handleCtrlClick}
          onContextMenu={handleContextMenu}
          onSortChange={(k: SortKey) => tree.setSortKey(k)}
          bookmarks={bookmarkSet}
          onToggleBookmark={onToggleBookmark}
        />

        <div className="side-pane">
          {treemapPosition === "right" ? (
            <Treemap
              nodeById={tree.nodeById}
              selectedId={tree.selectedId}
              metric={tree.metric}
              unit={tree.unit}
              detail={treemapDetail}
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
          ) : (
            <>
              <TabStrip
                active={activeTab}
                onChange={setActiveTab}
                errorCount={data?.errorCount ?? 0}
                bookmarkCount={bookmarkList.length}
              />
              <div className="tab-body">
                <div className={`tab-panel${activeTab === "details" ? " active" : ""}`}>
                  <DetailsTab data={data} selectedNode={selectedNode} onOpen={runOpen} onReveal={runReveal} onCopyPath={runCopyPath} />
                </div>
                <div className={`tab-panel${activeTab === "extensions" ? " active" : ""}`}>
                  <ExtensionsTab extensionStats={data?.extensionStats ?? []} />
                </div>
                <div className={`tab-panel${activeTab === "age" ? " active" : ""}`}>
                  <AgeTab ageStats={data?.ageStats ?? []} />
                </div>
                <div className={`tab-panel${activeTab === "top" ? " active" : ""}`}>
                  <TopFilesTab topFileIds={data?.topFiles ?? []} nodeById={tree.nodeById} onNavigate={handleNavigate} />
                </div>
                <div className={`tab-panel${activeTab === "duplicates" ? " active" : ""}`}>
                  <DuplicatesTab
                    candidates={data?.duplicateCandidates ?? []}
                    exactGroups={null}
                    scanPath={data?.rootPath ?? ""}
                    nodeById={tree.nodeById}
                    onNavigate={handleNavigate}
                  />
                </div>
                <div className={`tab-panel${activeTab === "errors" ? " active" : ""}`}>
                  <ErrorsTab errors={data?.scanErrors ?? []} />
                </div>
                <div className={`tab-panel${activeTab === "bookmarks" ? " active" : ""}`}>
                  <BookmarksTab
                    bookmarks={bookmarkList}
                    nodeById={tree.nodeById}
                    unit={tree.unit}
                    onNavigate={handleNavigate}
                    onScanPath={handleScanPath}
                    onRemove={onToggleBookmark}
                  />
                </div>
                <div className={`tab-panel${activeTab === "ai" ? " active" : ""}`}>
                  <AiChatTab scanPath={scanPath} nodeById={tree.nodeById} />
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Resize handle — only visible when chart panel is open (bottom mode only) */}
      {!showDuplicateFinder && treemapPosition === "bottom" && (
        <div
          className={`chart-resize-handle${activeTab === "chart" ? " chart-resize-handle-open" : ""}`}
          onMouseDown={activeTab === "chart" ? handleResizeMouseDown : undefined}
        />
      )}

      {/* Chart panel — full width below table + side pane (bottom mode only) */}
      {!showDuplicateFinder && treemapPosition === "bottom" && (
        <div
          className={`chart-panel${activeTab === "chart" ? " chart-panel-open" : ""}`}
          style={activeTab === "chart" ? { flex: `0 0 ${chartHeight}px`, height: chartHeight } : undefined}
        >
          <Treemap
            nodeById={tree.nodeById}
            selectedId={tree.selectedId}
            metric={tree.metric}
            unit={tree.unit}
            detail={treemapDetail}
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
      )}

      {filterDialogOpen && (
        <FilterDialog
          initialRules={tree.filterRules}
          onApply={tree.setFilterRules}
          onClose={() => setFilterDialogOpen(false)}
        />
      )}
    </div>
  );
});
