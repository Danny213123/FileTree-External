import { useMemo, useState, memo, useEffect, useRef, useCallback } from "react";
import type { NodeRecord, Metric, Unit } from "../api/types";
import { layoutTreemap } from "../utils/treeLayout";
import { formatBytes, formatCount } from "../utils/formatBytes";
import { moveItem } from "../api/client";
import { Treemap3DModal } from "./Treemap3DModal";
import { NodeTooltip } from "./NodeTooltip";

// detail 1–5 → rendering limits
function detailLimits(detail: number) {
  const d = Math.max(1, Math.min(5, detail));
  const top      = [4,  8, 12, 18, 25][d - 1];
  const children = [4,  8, 12, 18, 25][d - 1];
  const depth    = [1,  2,  3,  4,  5][d - 1];
  return { maxTop: top, maxChildren: children, maxDepth: depth };
}

const DEFAULT_W = 1400;
const DEFAULT_H = 400;

const BRANCH_COLORS = [
  "#1c5ea8", "#1a7a5a", "#7a3fa0", "#c06020",
  "#236028", "#962030", "#1068a0", "#705828",
  "#1a6878", "#883060", "#405890", "#686830",
];

function lighten(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, (n >> 16) + amt);
  const g = Math.min(255, ((n >> 8) & 0xff) + amt);
  const b = Math.min(255, (n & 0xff) + amt);
  return `rgb(${r},${g},${b})`;
}

function getValue(n: NodeRecord, metric: Metric): number {
  switch (metric) {
    case "allocated": return n.allocated;
    case "files":     return n.files;
    case "folders":   return n.folders;
    default:          return n.size;
  }
}

function buildChildrenMap(nodeById: Map<number, NodeRecord>): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (const node of nodeById.values()) {
    if (!map.has(node.id)) map.set(node.id, []);
    if (node.parent != null) {
      let arr = map.get(node.parent);
      if (!arr) { arr = []; map.set(node.parent, arr); }
      arr.push(node.id);
    }
  }
  return map;
}

// Flat rect with absolute pixel coords for draw + hit testing
interface FlatRect {
  nodeId: number;
  px: number; py: number; pw: number; ph: number;
  color: string;
  depth: number;
  showLabel: boolean;
  showCount: boolean;
  pxLabelH: number;
  children: FlatRect[];
}

function flattenLayout(
  rects: { node: NodeRecord; x: number; y: number; w: number; h: number }[],
  nodeById: Map<number, NodeRecord>,
  childrenMap: Map<number, number[]>,
  canvasW: number, canvasH: number,
  depth: number,
  maxDepth: number, maxChildren: number,
  metric: Metric,
  branchColor: string,
  offsetX: number, offsetY: number,
): FlatRect[] {
  const result: FlatRect[] = [];
  for (const rect of rects) {
    const px = offsetX + (rect.x / 100) * canvasW;
    const py = offsetY + (rect.y / 100) * canvasH;
    const pw = (rect.w / 100) * canvasW;
    const ph = (rect.h / 100) * canvasH;
    const color = lighten(branchColor, depth * 16);
    const labelH = (pw >= 20 && ph >= 10) ? 16 : 0;
    const showLabel = labelH > 0 && pw >= 30;
    const showCount = showLabel && pw >= 70;

    const children: FlatRect[] = [];
    if (rect.node.dir && depth < maxDepth) {
      const kids = (childrenMap.get(rect.node.id) ?? [])
        .map(id => nodeById.get(id))
        .filter((n): n is NodeRecord => n !== undefined && getValue(n, metric) > 0)
        .sort((a, b) => getValue(b, metric) - getValue(a, metric))
        .slice(0, maxChildren);
      const innerH = ph - labelH;
      if (kids.length > 0 && innerH > 4 && pw > 4) {
        const childRects = layoutTreemap(kids, pw, innerH, metric);
        children.push(...flattenLayout(
          childRects, nodeById, childrenMap,
          pw, innerH, depth + 1, maxDepth, maxChildren, metric,
          color, px, py + labelH,
        ));
      }
    }

    result.push({
      nodeId: rect.node.id,
      px, py, pw, ph, color, depth,
      showLabel, showCount, pxLabelH: labelH,
      children,
    });
  }
  return result;
}

function drawClippedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number, y: number,
  maxW: number,
  align: "left" | "right" = "left",
) {
  if (maxW <= 0) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(align === "right" ? x - maxW : x, y - 8, maxW, 16);
  ctx.clip();
  ctx.textAlign = align;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawRects(
  ctx: CanvasRenderingContext2D,
  rects: FlatRect[],
  nodeById: Map<number, NodeRecord>,
  selectedId: number,
  hoverId: number | null,
  dragOverId: number | null,
) {
  for (const r of rects) {
    const { px, py, pw, ph } = r;

    // Fill
    ctx.fillStyle = r.color;
    ctx.fillRect(px, py, pw, ph);

    // Border
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);

    // Header strip
    if (r.pxLabelH > 0) {
      ctx.fillStyle = "rgba(0,0,0,0.18)";
      ctx.fillRect(px, py, pw, r.pxLabelH);

      if (r.showLabel) {
        const node = nodeById.get(r.nodeId);
        const isDir = node?.dir ?? false;

        if (isDir) {
          ctx.fillStyle = "#e8b824";
          ctx.fillRect(px + 3, py + 4, 10, 9);
          ctx.fillRect(px + 3, py + 2, 5, 3);
        }

        const textX = isDir ? px + 16 : px + 3;
        ctx.fillStyle = "#e8f0ff";
        ctx.font = "600 11px system-ui,sans-serif";
        ctx.textBaseline = "middle";
        const rightEdge = r.showCount ? pw - 54 : pw - 4;
        drawClippedText(ctx, node?.name ?? "", textX, py + r.pxLabelH / 2, rightEdge - (textX - px));

        if (r.showCount) {
          ctx.fillStyle = "rgba(232,240,255,0.78)";
          ctx.font = "10px system-ui,sans-serif";
          const countText = isDir
            ? `(${formatCount(node?.files ?? 0)})`
            : formatBytes(node?.size ?? 0);
          drawClippedText(ctx, countText, px + pw - 4, py + r.pxLabelH / 2, 50, "right");
        }
      }
    }

    // Draw children before overlays so overlays appear on top
    drawRects(ctx, r.children, nodeById, selectedId, hoverId, dragOverId);

    // Overlays
    if (r.nodeId === selectedId) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.strokeRect(px + 1, py + 1, pw - 2, ph - 2);
    }
    if (r.nodeId === hoverId && r.nodeId !== selectedId) {
      ctx.strokeStyle = "rgba(255,255,255,0.7)";
      ctx.lineWidth = 2;
      ctx.strokeRect(px + 1, py + 1, pw - 2, ph - 2);
      if (r.pxLabelH > 0) {
        ctx.fillStyle = "rgba(255,255,255,0.14)";
        ctx.fillRect(px, py, pw, r.pxLabelH);
      }
    } else if (r.nodeId === hoverId) {
      // selected+hovered: still show hover label brightening
      if (r.pxLabelH > 0) {
        ctx.fillStyle = "rgba(255,255,255,0.14)";
        ctx.fillRect(px, py, pw, r.pxLabelH);
      }
    }
    if (r.nodeId === dragOverId) {
      ctx.strokeStyle = "#f0c040";
      ctx.lineWidth = 2;
      ctx.strokeRect(px + 1, py + 1, pw - 2, ph - 2);
    }
  }
}

function hitTest(rects: FlatRect[], mx: number, my: number): FlatRect | null {
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i];
    if (mx < r.px || mx >= r.px + r.pw || my < r.py || my >= r.py + r.ph) continue;
    const child = hitTest(r.children, mx, my);
    if (child) return child;
    return r;
  }
  return null;
}

interface TreemapProps {
  nodeById: Map<number, NodeRecord>;
  selectedId: number;
  metric: Metric;
  unit: Unit;
  detail: number;
  showSingleFiles: boolean;
  show3D: boolean;
  showHierarchy: boolean;
  showLegend: boolean;
  showLabels: boolean;
  dragDrop: boolean;
  onSelect: (id: number) => void;
  onNavigate: (id: number) => void;
  onOpen?: (id: number) => void;
  onClose3D?: () => void;
}

export const Treemap = memo(function Treemap({
  nodeById, selectedId, metric, unit, detail,
  showSingleFiles, show3D, showHierarchy, showLegend, showLabels, dragDrop,
  onSelect, onNavigate, onOpen, onClose3D,
}: TreemapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ w: DEFAULT_W, h: DEFAULT_H });
  const [hoverId, setHoverId] = useState<number | null>(null);
  const [dragSourceId, setDragSourceId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  const rafRef = useRef<number>(0);
  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tooltip, setTooltip] = useState<{ node: NodeRecord; x: number; y: number } | null>(null);
  const isDraggingRef = useRef(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width === 0 || height === 0) return;
      setContainerSize(prev => {
        if (Math.abs(width - prev.w) < 8 && Math.abs(height - prev.h) < 8) return prev;
        return { w: width, h: height };
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { maxTop, maxChildren, maxDepth } = useMemo(() => detailLimits(detail), [detail]);
  const childrenMap = useMemo(() => buildChildrenMap(nodeById), [nodeById]);

  const viewId = useMemo(() => {
    const node = nodeById.get(selectedId);
    if (!node) return 0;
    if (node.dir) return node.id;
    return node.parent ?? 0;
  }, [selectedId, nodeById]);

  const topItems = useMemo(() => {
    const allKids = (childrenMap.get(viewId) ?? [])
      .map(id => nodeById.get(id))
      .filter((n): n is NodeRecord => n !== undefined && getValue(n, metric) > 0);
    const dirs  = allKids.filter(n => n.dir);
    const files = allKids.filter(n => !n.dir);
    console.log(`[treemap] viewId=${viewId} total_children=${allKids.length} dirs=${dirs.length} files=${files.length} showSingleFiles=${showSingleFiles} maxTop=${maxTop}`);
    const kids = allKids
      .sort((a, b) => getValue(b, metric) - getValue(a, metric))
      .slice(0, maxTop);
    console.log(`[treemap] after slice: ${kids.length} items rendered (${kids.filter(n=>n.dir).length} dirs, ${kids.filter(n=>!n.dir).length} files)`);
    return kids;
  }, [viewId, nodeById, childrenMap, metric, maxTop, showSingleFiles]);

  const flatRects = useMemo(() => {
    const topRects = layoutTreemap(topItems, containerSize.w, containerSize.h, metric);
    const result: FlatRect[] = [];
    for (let i = 0; i < topRects.length; i++) {
      const branchColor = BRANCH_COLORS[i % BRANCH_COLORS.length];
      if (!showHierarchy) {
        // No child rendering — just top level
        const rect = topRects[i];
        const pw = (rect.w / 100) * containerSize.w;
        const ph = (rect.h / 100) * containerSize.h;
        const labelH = (pw >= 20 && ph >= 10) ? 16 : 0;
        result.push({
          nodeId: rect.node.id,
          px: (rect.x / 100) * containerSize.w,
          py: (rect.y / 100) * containerSize.h,
          pw, ph,
          color: branchColor,
          depth: 0,
          showLabel: showLabels && labelH > 0 && pw >= 30,
          showCount: showLabels && labelH > 0 && pw >= 70,
          pxLabelH: labelH,
          children: [],
        });
      } else {
        const flat = flattenLayout(
          [topRects[i]], nodeById, childrenMap,
          containerSize.w, containerSize.h,
          0, maxDepth, maxChildren, metric,
          branchColor, 0, 0,
        );
        // If labels disabled, strip showLabel/showCount
        if (!showLabels) {
          for (const f of flat) {
            f.showLabel = false;
            f.showCount = false;
          }
        }
        result.push(...flat);
      }
    }
    return result;
  }, [topItems, containerSize, nodeById, childrenMap, maxDepth, maxChildren, metric, showHierarchy, showLabels]);

  // Legend data (top-level items with their colors)
  const legendItems = useMemo(() =>
    topItems.slice(0, BRANCH_COLORS.length).map((n, i) => ({
      node: n,
      color: BRANCH_COLORS[i % BRANCH_COLORS.length],
    })),
    [topItems],
  );

  // Redraw on any visual state change
  useEffect(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawRects(ctx, flatRects, nodeById, selectedId, hoverId, dragOverId);
    });
  }, [flatRects, nodeById, selectedId, hoverId, dragOverId]);

  const getHit = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return hitTest(flatRects, e.clientX - rect.left, e.clientY - rect.top);
  }, [flatRects]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const hit = getHit(e);
    const newHoverId = hit ? hit.nodeId : null;
    setHoverId(newHoverId);

    const hitNode = hit ? nodeById.get(hit.nodeId) : null;
    if (canvasRef.current) {
      canvasRef.current.style.cursor =
        isDraggingRef.current && hitNode?.dir ? "copy"
        : isDraggingRef.current ? "no-drop"
        : hit ? "pointer"
        : "default";
    }

    // Drag-over tracking
    if (isDraggingRef.current) {
      setDragOverId(hitNode?.dir ? (hit!.nodeId) : null);
    }

    // Tooltip timer
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
    setTooltip(null);
    if (hit && hitNode) {
      const cx = e.clientX, cy = e.clientY;
      tooltipTimerRef.current = setTimeout(() => {
        setTooltip({ node: hitNode, x: cx, y: cy });
      }, 400);
    }
  }, [getHit, nodeById]);

  const handleMouseLeave = useCallback(() => {
    setHoverId(null);
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
    setTooltip(null);
  }, []);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isDraggingRef.current) return;
    const hit = getHit(e);
    if (!hit) return;
    onSelect(hit.nodeId);
    onNavigate(hit.nodeId);
  }, [getHit, onSelect, onNavigate]);

  const handleDoubleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const hit = getHit(e);
    if (!hit) return;
    const node = nodeById.get(hit.nodeId);
    if (node?.dir) onNavigate(hit.nodeId);
    else if (node && onOpen) onOpen(hit.nodeId);
  }, [getHit, onNavigate, onOpen, nodeById]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragDrop) return;
    const hit = getHit(e);
    if (hit && nodeById.get(hit.nodeId)?.dir) {
      isDraggingRef.current = true;
      setDragSourceId(hit.nodeId);
      if (canvasRef.current) canvasRef.current.style.cursor = "grabbing";
    }
  }, [dragDrop, getHit, nodeById]);

  const handleMouseUp = useCallback(async () => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    const srcId = dragSourceId;
    const dstId = dragOverId;
    setDragSourceId(null);
    setDragOverId(null);
    if (canvasRef.current) canvasRef.current.style.cursor = "default";

    if (srcId == null || dstId == null || srcId === dstId) return;
    const src = nodeById.get(srcId);
    const dst = nodeById.get(dstId);
    if (!src || !dst || !dst.dir) return;
    const srcName = src.path.split(/[\\/]/).pop() ?? src.name;
    const sep = dst.path.endsWith("\\") || dst.path.endsWith("/") ? "" : "\\";
    const newPath = dst.path + sep + srcName;
    const result = await moveItem(src.path, newPath);
    if (!result.ok) alert(`Move failed: ${result.error}`);
  }, [dragSourceId, dragOverId, nodeById]);

  return (
    <>
    {show3D && (
      <Treemap3DModal
        nodeById={nodeById}
        viewId={viewId}
        metric={metric}
        onClose={onClose3D ?? (() => {})}
        onNavigate={onNavigate}
      />
    )}
    <div className="treemap-shell">
      <div className="treemap-body">
        <div className="treemap" ref={containerRef}>
          <canvas
            ref={canvasRef}
            width={containerSize.w}
            height={containerSize.h}
            className="treemap-canvas"
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            onClick={handleClick}
            onDoubleClick={handleDoubleClick}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
          />
          {tooltip && (
            <NodeTooltip
              node={tooltip.node}
              unit={unit}
              anchorX={tooltip.x}
              anchorY={tooltip.y}
            />
          )}
        </div>
      </div>
      {showLegend && legendItems.length > 0 && (
        <div className="treemap-legend">
          {legendItems.map(({ node, color }) => (
            <span key={node.id} className="treemap-legend-item">
              <span className="treemap-legend-swatch" style={{ background: color }} />
              <span className="treemap-legend-label">{node.name}</span>
            </span>
          ))}
        </div>
      )}
    </div>
    </>
  );
});
