import { useRef, useState, useCallback, useMemo } from "react";
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
}: TreeTableProps) {
  const cols = useMemo(
    () => ALL_COLUMNS.filter((c) => visibleColumns.has(c.key)),
    [visibleColumns],
  );
  const gridTemplate = useMemo(
    () => `minmax(200px,1fr)${cols.filter(c => c.key !== "name").map(() => " minmax(70px,100px)").join("")}`,
    [cols],
  );
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

  return (
    <div className="table-pane">
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
      <div className="rows" ref={scrollRef}>
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
            return (
              <div
                key={node.id}
                data-index={vItem.index}
                className={`row${selectedId === node.id ? " selected" : ""}${node.hidden ? " hidden-entry" : ""}`}
                style={{ position: "absolute", top: vItem.start, left: 0, right: 0, height: ROW_HEIGHT, gridTemplateColumns: gridTemplate }}
                onClick={(e) => { if (e.ctrlKey && !isBundle) { onCtrlClick(node.id); return; } onSelect(node.id); }}
                onDoubleClick={() => {
                  if (isBundle) onToggleExpand(node.id);
                  else onDoubleClick(node.id);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!isBundle) onContextMenu(node.id, e.clientX, e.clientY);
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
