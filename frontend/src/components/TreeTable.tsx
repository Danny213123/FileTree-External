import { useRef, useState, useCallback, useMemo, useEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { NodeRecord, SortKey, Metric, Unit } from "../api/types";
import { formatBytes, formatCount } from "../utils/formatBytes";
import { formatDate } from "../utils/formatDate";
import { NodeTooltip } from "./NodeTooltip";
import { FileIcon } from "./FileIcon";

const ROW_HEIGHT = 20;

export const ALL_COLUMNS: { key: SortKey; label: string }[] = [
  { key: "name",        label: "Name" },
  { key: "path",        label: "Full Path" },
  { key: "folderPath",  label: "Folder Path" },
  { key: "size",        label: "Size" },
  { key: "allocated",   label: "Allocated" },
  { key: "type",        label: "Type" },
  { key: "files",       label: "Files" },
  { key: "folders",     label: "Folders" },
  { key: "attributes",  label: "Attributes" },
  { key: "percent",     label: "% of Parent" },
  { key: "created",     label: "Creation Date" },
  { key: "accessed",    label: "Last Accessed" },
  { key: "modified",    label: "Last Modified" },
  { key: "avgFileSize", label: "Avg. File Size" },
  { key: "pathLength",  label: "Path Length" },
  { key: "dirLevel",    label: "Dir Level" },
];

export const DEFAULT_VISIBLE_COLUMNS = new Set<SortKey>(["name", "size", "allocated", "files", "folders", "percent", "modified"]);

type MoveItemsResult = { ok: boolean; error?: string };

interface TreeTableProps {
  rows: NodeRecord[];
  nodeById: Map<number, NodeRecord>;
  expanded: Set<number>;
  selectedId: number;
  selectedIds: Set<number>;
  sortKey: SortKey;
  sortDir: 1 | -1;
  metric: Metric;
  unit: Unit;
  decimals: number;
  visibleColumns: Set<SortKey>;
  bookmarks: Set<string>;
  onToggleExpand: (id: number) => void;
  onSelect: (id: number, mode: "single" | "toggle" | "range") => void;
  onDoubleClick: (id: number) => void;
  onContextMenu: (id: number, x: number, y: number) => void;
  onSortChange: (key: SortKey) => void;
  onToggleBookmark: (path: string) => void;
  onCopySelected?: () => void;
  /** Called when the user drags rows from inside FileTree onto a folder row. */
  onMoveItems?: (sourcePaths: string[], destinationFolder: string) => Promise<MoveItemsResult | void> | MoveItemsResult | void;
  /** id of the row whose name is being edited inline (null/undefined = none). */
  renamingId?: number | null;
  /** Commit an inline rename for the given row id with the typed name. */
  onRenameCommit?: (id: number, newName: string) => void;
  /** Abandon the in-progress inline rename without changing anything. */
  onRenameCancel?: () => void;
}

function metricValue(node: NodeRecord, metric: Metric): number {
  switch (metric) {
    case "allocated": return node.allocated;
    case "files":     return node.files;
    case "folders":   return node.folders;
    default:          return node.size;
  }
}

function isPathInside(path: string, parent: string): boolean {
  const normalizedPath = path.toLowerCase();
  const normalizedParent = parent.replace(/[\\/]+$/, "").toLowerCase();
  return normalizedPath === normalizedParent ||
    normalizedPath.startsWith(`${normalizedParent}\\`) ||
    normalizedPath.startsWith(`${normalizedParent}/`);
}

function dedupeNestedNodes(nodes: NodeRecord[]): NodeRecord[] {
  const sorted = [...nodes].sort((a, b) => a.path.length - b.path.length);
  const result: NodeRecord[] = [];
  for (const node of sorted) {
    if (!node.path) continue;
    if (result.some((kept) => kept.dir && isPathInside(node.path, kept.path))) continue;
    result.push(node);
  }
  return result;
}

/**
 * Inline name editor shown in the Name cell of the row being renamed.
 * Mirrors Explorer/TreeSize: autofocuses, pre-selects the filename stem,
 * commits on Enter or blur, cancels on Escape. All pointer/key events are
 * stopped so they don't reach the row's selection / keyboard-nav handlers.
 */
function RenameInput({
  initialName,
  onCommit,
  onCancel,
}: {
  initialName: string;
  onCommit: (newName: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  // Guards against firing twice (e.g. Enter commits, which then blurs).
  const doneRef = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = initialName.lastIndexOf(".");
    if (dot > 0) el.setSelectionRange(0, dot); // select stem, keep extension
    else el.select();
  }, [initialName]);

  const commit = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCommit(ref.current?.value ?? initialName);
  }, [initialName, onCommit]);

  const cancel = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCancel();
  }, [onCancel]);

  return (
    <input
      ref={ref}
      className="name-edit"
      defaultValue={initialName}
      spellCheck={false}
      autoComplete="off"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        else if (e.key === "Escape") { e.preventDefault(); cancel(); }
      }}
      onBlur={commit}
    />
  );
}

export function TreeTable({
  rows,
  nodeById,
  expanded,
  selectedId,
  selectedIds,
  sortKey,
  sortDir,
  unit,
  metric,
  decimals,
  visibleColumns,
  bookmarks,
  onToggleExpand,
  onSelect,
  onDoubleClick,
  onContextMenu,
  onSortChange,
  onToggleBookmark,
  onCopySelected,
  onMoveItems,
  renamingId,
  onRenameCommit,
  onRenameCancel,
}: TreeTableProps) {
  const [dropTargetId, setDropTargetId] = useState<number | null>(null);
  const dragPathsRef = useRef<string[]>([]);
  // True only on the TreeTable instance that started the current native drag.
  // Gates the nativeDropInternal IPC so hidden/other-tab instances ignore it.
  const nativeDragOriginRef = useRef<boolean>(false);
  // Path of the folder the cursor last highlighted during the drag — this is
  // the real drop target (the same folder shown highlighted), so we move into
  // it directly instead of re-deriving it from drop coordinates.
  const lastFolderTargetRef = useRef<string | null>(null);
  type ElectronAPI = {
    // Fire-and-forget: main runs the native shell drag while the renderer stays
    // responsive (auto-scroll + folder highlight keep working during the drag).
    startDrag: (filePaths: string | string[]) => void;
    getPathForFile?: (file: File) => string;
    // The native drag ended over a FileTree window: hit-test the drop point and
    // move the dragged files into that folder ourselves.
    onNativeDropInternal?: (
      cb: (clientX: number, clientY: number, paths: string[]) => void,
    ) => () => void;
    // The native drag ended externally or was cancelled: clear drag UI.
    onNativeDropEnd?: (cb: () => void) => () => void;
    // TEMP diagnostic: forward a renderer log line to the main-process terminal.
    diag?: (message: string) => void;
  };
  const electronAPI = () => (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
  const getDroppedFilePaths = useCallback((files: FileList) => {
    const api = electronAPI();
    return Array.from(files)
      .map((file) => {
        try {
          return api?.getPathForFile?.(file) || (file as unknown as { path?: string }).path || "";
        } catch {
          return (file as unknown as { path?: string }).path || "";
        }
      })
      .filter((filePath) => filePath.length > 0);
  }, []);
  const resetDragState = useCallback(() => {
    // NOTE: deliberately does NOT clear nativeDragOriginRef / lastFolderTargetRef.
    // Those must survive any dragend/drop/dragleave that fire during the native
    // drag so the nativeDropInternal IPC (which arrives afterwards) can use them.
    dragPathsRef.current = [];
    setDropTargetId(null);
  }, []);
  const cols = useMemo(
    () => ALL_COLUMNS.filter((c) => visibleColumns.has(c.key)),
    [visibleColumns],
  );
  const gridTemplate = useMemo(
    () => `minmax(200px,1fr)${cols.filter(c => c.key !== "name").map(() => " minmax(70px,100px)").join("")}`,
    [cols],
  );
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);

  // Native wheel listener attached via ref callback so it fires even during
  // an active HTML5 drag (React's synthetic onWheel is suppressed during drag).
  useEffect(() => {
    if (!scrollEl) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      scrollEl.scrollTop += e.deltaY;
    };
    scrollEl.addEventListener("wheel", onWheel, { passive: false });
    return () => scrollEl.removeEventListener("wheel", onWheel);
  }, [scrollEl]);

  useEffect(() => {
    window.addEventListener("dragend", resetDragState);
    window.addEventListener("drop", resetDragState);
    return () => {
      window.removeEventListener("dragend", resetDragState);
      window.removeEventListener("drop", resetDragState);
    };
  }, [resetDragState]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tooltip, setTooltip] = useState<{ node: NodeRecord; x: number; y: number } | null>(null);

  const handleKindEnter = useCallback((node: NodeRecord, e: React.MouseEvent) => {
    if (node.id < 0) return; // skip bundles
    const x = e.clientX;
    const y = e.clientY;
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => setTooltip({ node, x, y }), 400);
  }, []);

  const handleKindLeave = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    setTooltip(null);
  }, []);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  const rootNode = nodeById.get(0);
  const selectedDragNodes = useMemo(
    () => dedupeNestedNodes(
      Array.from(selectedIds)
        .map((id) => nodeById.get(id))
        .filter((node): node is NodeRecord => !!node && node.id >= 0 && !!node.path),
    ),
    [nodeById, selectedIds],
  );

  const reportInternalMoveError = useCallback((message: string) => {
    console.error("[TreeTable] internal move failed", message);
    window.setTimeout(() => {
      window.alert(`Move failed: ${message}`);
    }, 0);
  }, []);

  const runInternalMove = useCallback(async (sourcePaths: string[], destinationFolder: string) => {
    try {
      const result = await onMoveItems?.(sourcePaths, destinationFolder);
      if (result && !result.ok) {
        reportInternalMoveError(result.error ?? "unknown error");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reportInternalMoveError(message);
    } finally {
      resetDragState();
    }
  }, [onMoveItems, reportInternalMoveError, resetDragState]);

  // When a native (file) drag-out ends back over FileTree, main sends the drop
  // point so we hit-test the destination folder and perform the move ourselves
  // (Chromium can't complete its own drop while the modal drag loop runs).
  useEffect(() => {
    const api = electronAPI();
    if (!api?.onNativeDropInternal) return;
    const offInternal = api.onNativeDropInternal((clientX, clientY, paths) => {
      const origin = nativeDragOriginRef.current;
      const tracked = lastFolderTargetRef.current;
      api?.diag?.(`[diag] internal-drop ENTER origin=${origin} tracked=${tracked ?? "(none)"} paths=${paths.length} xy=${clientX},${clientY}`);
      // Only the instance that started the drag acts. Other tabs keep a mounted
      // (display:none) TreeTable and would otherwise all handle this same IPC.
      if (!origin) return;

      // Primary target: the folder the user last highlighted during the drag
      // (exactly what was shown highlighted). Fall back to hit-testing the drop
      // point only if no folder was tracked.
      let destPath = tracked ?? undefined;
      if (!destPath) {
        const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
        const row = el?.closest<HTMLElement>(".row");
        if (row?.dataset.nodeDir === "1") destPath = row.dataset.nodePath;
      }
      const movable = destPath ? paths.filter((src) => src && src !== destPath) : [];
      api?.diag?.(`[diag] internal-drop dest=${destPath ?? "(none)"} willMove=${movable.length}`);
      nativeDragOriginRef.current = false;
      lastFolderTargetRef.current = null;
      if (destPath && movable.length > 0) {
        const target = destPath;
        window.setTimeout(() => { void runInternalMove(movable, target); }, 0);
        return;
      }
      resetDragState();
    });
    const offEnd = api.onNativeDropEnd?.(() => {
      nativeDragOriginRef.current = false;
      lastFolderTargetRef.current = null;
      resetDragState();
    });
    return () => { offInternal?.(); offEnd?.(); };
  }, [runInternalMove, resetDragState]);

  return (
    <div
      className="table-pane"
      tabIndex={0}
      style={{ outline: "none" }}
      onMouseDown={(e) => { (e.currentTarget as HTMLElement).focus(); }}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "c" && onCopySelected) {
          e.preventDefault();
          onCopySelected();
        }
      }}
    >
      {/* Column header */}
      <div className="table-head" style={{ gridTemplateColumns: gridTemplate }}>
        {cols.map((col) => (
          <button
            key={col.key}
            data-sort={col.key}
            onClick={() => onSortChange(col.key)}
          >
            {col.label}
            {sortKey === col.key ? (sortDir === 1 ? " ↑" : " ↓") : ""}
          </button>
        ))}
      </div>

      {/* Virtual scroll container */}
      <div className="rows"
        ref={(el) => { (scrollRef as React.MutableRefObject<HTMLDivElement | null>).current = el; setScrollEl(el); }}
        onDragOver={(e) => {
          const el = scrollRef.current;
          if (!el) return;
          const { top, bottom, height } = el.getBoundingClientRect();
          const ZONE = Math.min(50, height * 0.15);
          const y = e.clientY;
          if (y < top + ZONE) el.scrollTop -= 6 * ((top + ZONE - y) / ZONE);
          else if (y > bottom - ZONE) el.scrollTop += 6 * ((y - (bottom - ZONE)) / ZONE);
        }}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((vItem) => {
            const node = rows[vItem.index];
            const isBundle  = node.id < 0;
            const val       = metricValue(node, metric);
            const rootVal   = rootNode ? metricValue(rootNode, metric) : val;
            const barWidth  = rootVal > 0 ? (val / rootVal) * 100 : 0;
            const parentNode = node.parent != null ? nodeById.get(node.parent) : null;
            const parentSize = parentNode ? parentNode.size : node.size;
            const pct       = parentSize > 0 ? (node.size / parentSize) * 100 : 100;
            const hasKids   = node.children.length > 0;
            const isOpen    = expanded.has(node.id);
            const isDraggable = !isBundle && !!node.path;
            const isSelected = !isBundle && selectedIds.has(node.id);
            const isDropTarget = dropTargetId === node.id;
            return (
              <div
                key={node.id}
                data-index={vItem.index}
                data-node-path={node.path ?? ""}
                data-node-dir={node.dir && !isBundle ? "1" : "0"}
                className={`row${isSelected ? " selected" : ""}${selectedId === node.id ? " primary-selected" : ""}${node.hidden ? " hidden-entry" : ""}${isDropTarget ? " drop-target" : ""}`}
                style={{ position: "absolute", top: vItem.start, left: 0, right: 0, height: ROW_HEIGHT, gridTemplateColumns: gridTemplate }}
                draggable={isDraggable}
                onClick={(e) => {
                  if (isBundle) { onToggleExpand(node.id); return; }
                  onSelect(node.id, e.shiftKey ? "range" : (e.ctrlKey || e.metaKey ? "toggle" : "single"));
                }}
                onDoubleClick={() => { if (!isBundle) onDoubleClick(node.id); }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!isBundle) onContextMenu(node.id, e.clientX, e.clientY);
                }}
                onDragStart={(e) => {
                  if (!isDraggable) return;
                  const draggedNodes = selectedIds.has(node.id)
                    ? selectedDragNodes
                    : dedupeNestedNodes([node]);
                  const draggedPaths = draggedNodes.map((draggedNode) => draggedNode.path);
                  if (draggedPaths.length === 0) return;

                  if (!selectedIds.has(node.id)) onSelect(node.id, "single");
                  e.dataTransfer.setData("application/x-filetree-path", draggedPaths[0]);
                  e.dataTransfer.setData("application/x-filetree-paths", JSON.stringify(draggedPaths));
                  if (draggedNodes.length === 1 && draggedNodes[0].dir) {
                    e.dataTransfer.setData("application/x-filetree-folder-path", draggedPaths[0]);
                  }
                  e.dataTransfer.effectAllowed = draggedNodes.some((draggedNode) => draggedNode.dir) ? "copyMove" : "move";
                  dragPathsRef.current = draggedPaths;
                  const api = electronAPI();
                  const useNativeDrag = !!api && draggedNodes.every((draggedNode) => !draggedNode.dir);
                  if (useNativeDrag) {
                    // Files: hand the drag to the native shell drag (fire-and-forget
                    // so the renderer stays responsive). Chromium still fires
                    // dragover on the page during the drag (folder highlight +
                    // auto-scroll work). The drop is completed by main via
                    // onNativeDropInternal (internal move) or onNativeDropEnd
                    // (external move/copy/cancel). Folders fall through to a pure
                    // HTML5 drag (internal move only).
                    e.preventDefault(); // suppress Chromium's HTML5 drag; native drag takes over
                    // Mark this instance as the drag origin and reset the tracked
                    // target; the nativeDropInternal IPC will only act here.
                    nativeDragOriginRef.current = true;
                    lastFolderTargetRef.current = null;
                    api.diag?.(`[diag] native dragstart paths=${draggedPaths.length}`);
                    api.startDrag(draggedPaths);
                  }
                }}
                onDragEnd={() => {
                  // Native drag-out is fully handled in onDragStart; this only needs to clear
                  // UI state for internal (HTML5) drags that ended without a valid drop.
                  resetDragState();
                }}
                onDragOver={(e) => {
                  if (!node.dir || !node.path || isBundle) return;
                  const acceptsFileTreeDrag = e.dataTransfer.types.includes("application/x-filetree-path");
                  const acceptsExplorerFiles = e.dataTransfer.types.includes("Files");
                  if (!acceptsFileTreeDrag && !acceptsExplorerFiles) return;
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = "move";
                  // Remember the highlighted folder as the live drop target so a
                  // native drag-out that returns here can move into it directly.
                  lastFolderTargetRef.current = node.path;
                  if (dropTargetId !== node.id) setDropTargetId(node.id);
                }}
                onDragLeave={() => {
                  if (dropTargetId === node.id) setDropTargetId(null);
                }}
                onDrop={(e) => {
                  if (!node.dir || !node.path || isBundle) return;
                  const isFileTreeDrag = e.dataTransfer.types.includes("application/x-filetree-path");
                  const isExplorerFileDrag = e.dataTransfer.types.includes("Files");
                  if (!isFileTreeDrag && !isExplorerFileDrag) return;

                  e.preventDefault();
                  e.stopPropagation();

                  let sources: string[] = [];
                  if (isFileTreeDrag) {
                    const pathsPayload = e.dataTransfer.getData("application/x-filetree-paths");
                    try {
                      sources = pathsPayload
                        ? JSON.parse(pathsPayload) as string[]
                        : [e.dataTransfer.getData("application/x-filetree-path")];
                    } catch {
                      sources = [e.dataTransfer.getData("application/x-filetree-path")];
                    }
                  } else {
                    sources = getDroppedFilePaths(e.dataTransfer.files);
                  }

                  setDropTargetId(null);
                  const movableSources = sources.filter((src) => src && src !== node.path);
                  if (movableSources.length === 0) {
                    resetDragState();
                    if (isExplorerFileDrag && sources.length === 0) {
                      reportInternalMoveError("Could not read the dropped file paths.");
                    }
                    return;
                  }
                  resetDragState();
                  window.setTimeout(() => {
                    void runInternalMove(movableSources, node.path);
                  }, 0);
                }}
              >
                <div
                  className="cell name-cell"
                  style={{ "--depth": node.depth, "--bar-width": `${barWidth}%` } as React.CSSProperties}
                >
                  {hasKids ? (
                    <button
                      className="twisty"
                      onClick={(e) => { e.stopPropagation(); onToggleExpand(node.id); }}
                    >
                      {isOpen ? "▾" : "▸"}
                    </button>
                  ) : (
                    <span className="twisty" />
                  )}
                  <FileIcon
                    ext={node.extension ?? ""}
                    isDir={node.dir}
                    isBundle={isBundle}
                    onMouseEnter={(e) => handleKindEnter(node, e)}
                    onMouseLeave={handleKindLeave}
                  />
                  {node.id === renamingId ? (
                    <RenameInput
                      initialName={node.name}
                      onCommit={(newName) => onRenameCommit?.(node.id, newName)}
                      onCancel={() => onRenameCancel?.()}
                    />
                  ) : (
                    <span className={`name-text${isBundle ? " bundle-label" : ""}`}>{node.name}</span>
                  )}
                  {!isBundle && node.path && (
                    <button
                      className={`bookmark-btn${bookmarks.has(node.path) ? " bookmarked" : ""}`}
                      title={bookmarks.has(node.path) ? "Remove bookmark" : "Add bookmark"}
                      onClick={(e) => { e.stopPropagation(); onToggleBookmark(node.path); }}
                    >
                      {bookmarks.has(node.path) ? "★" : "☆"}
                    </button>
                  )}
                </div>
                {visibleColumns.has("path")       && <div className="cell num" title={node.path}>{node.path}</div>}
                {visibleColumns.has("folderPath") && <div className="cell num" title={node.path}>{node.path.replace(/[^/\\]*$/, "") || node.path}</div>}
                {visibleColumns.has("size")       && <div className="cell num">{formatBytes(node.size, unit, decimals)}</div>}
                {visibleColumns.has("allocated")  && <div className="cell num">{formatBytes(node.allocated, unit, decimals)}</div>}
                {visibleColumns.has("type")       && <div className="cell num">{node.dir ? "Folder" : (node.extension ? node.extension.toUpperCase() : "File")}</div>}
                {visibleColumns.has("files")      && <div className="cell num">{formatCount(node.files)}</div>}
                {visibleColumns.has("folders")    && <div className="cell num">{isBundle ? "" : formatCount(node.folders)}</div>}
                {visibleColumns.has("attributes") && <div className="cell num">{[node.hidden ? "H" : "", node.readonly ? "R" : "", node.link ? "L" : ""].filter(Boolean).join("") || "—"}</div>}
                {visibleColumns.has("percent")    && (
                  <div className="percent-cell" style={{ "--percent": pct } as React.CSSProperties}>
                    <span>{pct.toFixed(decimals > 0 ? decimals : 1)}%</span>
                  </div>
                )}
                {visibleColumns.has("created")    && <div className="cell num">{(node.created ?? 0) > 0 ? formatDate(node.created) : "—"}</div>}
                {visibleColumns.has("accessed")   && <div className="cell num">{(node.accessed ?? 0) > 0 ? formatDate(node.accessed) : "—"}</div>}
                {visibleColumns.has("modified")   && <div className="cell num">{node.modified ? formatDate(node.modified) : ""}</div>}
                {visibleColumns.has("avgFileSize") && <div className="cell num">{node.files > 0 ? formatBytes(Math.round(node.size / node.files), unit, decimals) : "—"}</div>}
                {visibleColumns.has("pathLength") && <div className="cell num">{node.path.length}</div>}
                {visibleColumns.has("dirLevel")   && <div className="cell num">{node.depth}</div>}
              </div>
            );
          })}
        </div>
      </div>
      {tooltip && (
        <NodeTooltip
          node={tooltip.node}
          unit={unit}
          anchorX={tooltip.x}
          anchorY={tooltip.y}
        />
      )}
    </div>
  );
}
