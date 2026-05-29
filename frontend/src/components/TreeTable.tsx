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

interface TreeTableProps {
  rows: NodeRecord[];
  nodeById: Map<number, NodeRecord>;
  expanded: Set<number>;
  selectedId: number;
  sortKey: SortKey;
  sortDir: 1 | -1;
  metric: Metric;
  unit: Unit;
  decimals: number;
  visibleColumns: Set<SortKey>;
  bookmarks: Set<string>;
  onToggleExpand: (id: number) => void;
  onSelect: (id: number) => void;
  onDoubleClick: (id: number) => void;
  onCtrlClick: (id: number) => void;
  onContextMenu: (id: number, x: number, y: number) => void;
  onSortChange: (key: SortKey) => void;
  onToggleBookmark: (path: string) => void;
  onCopySelected?: () => void;
  /** Called when the user drags rows from inside FileTree onto a folder row. */
  onMoveItems?: (sourcePaths: string[], destinationFolder: string) => void;
  /** Called after a successful external drag-out with dropEffect="move" to delete source. */
  onExternalMove?: (paths: string[]) => void;
}

function metricValue(node: NodeRecord, metric: Metric): number {
  switch (metric) {
    case "allocated": return node.allocated;
    case "files":     return node.files;
    case "folders":   return node.folders;
    default:          return node.size;
  }
}

export function TreeTable({
  rows,
  nodeById,
  expanded,
  selectedId,
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
  onCtrlClick,
  onContextMenu,
  onSortChange,
  onToggleBookmark,
  onCopySelected,
  onMoveItems,
  onExternalMove,
}: TreeTableProps) {
  const [dropTargetId, setDropTargetId] = useState<number | null>(null);
  const dragPathRef = useRef<string | null>(null);
  const pendingExternalDragRef = useRef<{ path: string; completed: boolean; cancelled: boolean } | null>(null);
  type DragStartResult = { ok: boolean; status: string; error?: string };
  type DeleteAfterDragResult = { ok: boolean; status?: string; error?: string };
  type ElectronAPI = {
    startDrag: (filePath: string) => DragStartResult;
    deleteAfterDrag: (filePath: string) => Promise<DeleteAfterDragResult>;
  };
  const electronAPI = () => (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
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

  const finishExternalDrag = useCallback(async (src: string, reason: string) => {
    const pending = pendingExternalDragRef.current;
    if (!pending || pending.path !== src || pending.completed || pending.cancelled) return;

    pending.completed = true;
    dragPathRef.current = null;
    setDropTargetId(null);

    const api = electronAPI();
    if (!api?.deleteAfterDrag) {
      pendingExternalDragRef.current = null;
      return;
    }

    try {
      const result = await api.deleteAfterDrag(src);
      if (!result.ok) {
        const message = result.error ?? "unknown error";
        console.error("[TreeTable] deleteAfterDrag failed", { src, reason, message });
        window.alert(`Could not remove the original after drag-out: ${message}`);
        return;
      }

      console.log("[TreeTable] external drag cleanup complete", { src, reason, status: result.status });
      onExternalMove?.([]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[TreeTable] deleteAfterDrag threw", { src, reason, error });
      window.alert(`Could not remove the original after drag-out: ${message}`);
    } finally {
      pendingExternalDragRef.current = null;
    }
  }, [onExternalMove]);

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
            const isDropTarget = dropTargetId === node.id;
            return (
              <div
                key={node.id}
                data-index={vItem.index}
                className={`row${selectedId === node.id ? " selected" : ""}${node.hidden ? " hidden-entry" : ""}${isDropTarget ? " drop-target" : ""}`}
                style={{ position: "absolute", top: vItem.start, left: 0, right: 0, height: ROW_HEIGHT, gridTemplateColumns: gridTemplate }}
                draggable={isDraggable}
                onClick={(e) => {
                  if (isBundle) { onToggleExpand(node.id); onSelect(node.id); return; }
                  if (e.ctrlKey) { onCtrlClick(node.id); return; }
                  onSelect(node.id);
                }}
                onDoubleClick={() => { if (!isBundle) onDoubleClick(node.id); }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!isBundle) onContextMenu(node.id, e.clientX, e.clientY);
                }}
                onDragStart={(e) => {
                  if (!isDraggable) return;
                  onSelect(node.id);
                  // Set internal drag MIME so drop targets inside FileTree can detect this.
                  e.dataTransfer.setData("application/x-filetree-path", node.path);
                  e.dataTransfer.effectAllowed = "move";
                  dragPathRef.current = node.path;
                  pendingExternalDragRef.current = { path: node.path, completed: false, cancelled: false };
                  const api = electronAPI();
                  if (api) {
                    // External drag-out via Electron native drag (blocks until drop/cancel).
                    e.preventDefault(); // suppress Chromium's HTML5 drag to avoid double-drag crash
                    const result = api.startDrag(node.path);
                    console.log("[TreeTable] dragstart result=", result, "src=", node.path);
                    if (!result?.ok) {
                      console.error("[TreeTable] startDrag failed", { src: node.path, result });
                      dragPathRef.current = null;
                      pendingExternalDragRef.current = null;
                      return;
                    }
                    window.setTimeout(() => { void finishExternalDrag(node.path, "native-return"); }, 0);
                  }
                }}
                onDragEnd={(e) => {
                  const src = dragPathRef.current;
                  setDropTargetId(null);
                  if (!src) return;

                  if (e.dataTransfer.dropEffect === "none") {
                    const pending = pendingExternalDragRef.current;
                    if (pending?.path === src) pending.cancelled = true;
                    pendingExternalDragRef.current = null;
                    dragPathRef.current = null;
                    console.log("[TreeTable] external drag cancelled", { src });
                    return;
                  }

                  void finishExternalDrag(src, `dragend:${e.dataTransfer.dropEffect}`);
                }}
                onDragOver={(e) => {
                  if (!node.dir || !node.path || isBundle) return;
                  if (!e.dataTransfer.types.includes("application/x-filetree-path")) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = e.ctrlKey ? "copy" : "move";
                  if (dropTargetId !== node.id) setDropTargetId(node.id);
                }}
                onDragLeave={() => {
                  if (dropTargetId === node.id) setDropTargetId(null);
                }}
                onDrop={(e) => {
                  if (!node.dir || !node.path || isBundle) return;
                  const src = e.dataTransfer.getData("application/x-filetree-path");
                  setDropTargetId(null);
                  if (!src || src === node.path) return;
                  e.preventDefault();
                  onMoveItems?.([src], node.path);
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
                  <span className={`name-text${isBundle ? " bundle-label" : ""}`}>{node.name}</span>
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
