import { useMemo, useState, memo, useEffect, useRef, useCallback, forwardRef, useImperativeHandle, lazy, Suspense } from "react";
import type { NodeRecord, Metric, Unit } from "../api/types";
import { layoutTreemap } from "../utils/treeLayout";
import { formatBytes, formatCount } from "../utils/formatBytes";
import { NodeTooltip } from "./NodeTooltip";
import { isNoOpMove } from "../lib/agent";

// The 3D treemap modal (its own isometric SVG renderer) is only shown on demand
// via the "3D" toggle, so it is code-split out of the main bundle with
// React.lazy and loaded the first time the user opens it.
const Treemap3DModal = lazy(() => import("./Treemap3DModal").then((m) => ({ default: m.Treemap3DModal })));

// detail 1–5 → rendering limits
function detailLimits(detail: number) {
  const d = Math.max(1, Math.min(5, detail));
  const top      = [4,  7, 10, 14, 18][d - 1];
  const children = [4,  6,  9, 12, 16][d - 1];
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

// Scale a colour's brightness (factor < 1 darkens, > 1 lightens). Accepts the
// "rgb(r,g,b)" strings produced by lighten() as well as #rrggbb hex.
function shade(color: string, factor: number): string {
  let r: number, g: number, b: number;
  if (color[0] === "#") {
    const n = parseInt(color.slice(1), 16);
    r = (n >> 16) & 0xff; g = (n >> 8) & 0xff; b = n & 0xff;
  } else {
    const m = color.match(/\d+/g);
    if (!m || m.length < 3) return color;
    r = +m[0]; g = +m[1]; b = +m[2];
  }
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * factor)));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

// Blend a #rrggbb colour toward white by ratio t (0 = unchanged, 1 = white).
function tint(hex: string, t: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  const m = (v: number) => Math.round(v + (255 - v) * t);
  return `rgb(${m(r)},${m(g)},${m(b)})`;
}

// Fill colour for a cell given its branch's base hue, nesting depth, and theme.
// Dark theme: progressively lighter shades of the base colour (as before). Light
// theme: light pastels (base tinted toward white) that get a little stronger with
// depth, kept light enough for dark label text.
function fillColor(branchHex: string, depth: number, darkMode: boolean): string {
  if (darkMode) return lighten(branchHex, depth * 16);
  return tint(branchHex, Math.max(0.3, 0.68 - depth * 0.09));
}

// Upper bound on rendered cells so the entire-treemap view stays interactive
// even on a huge scan (the canvas is large, so without this the subdivision can
// explode into many thousands of tiny rects).
const MAX_RECTS = 4000;

function getValue(n: NodeRecord, metric: Metric): number {
  switch (metric) {
    case "allocated": return n.allocated;
    case "files":     return n.files;
    case "folders":   return n.folders;
    default:          return n.size;
  }
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
  canvasW: number, canvasH: number,
  depth: number,
  maxDepth: number, maxChildren: number,
  metric: Metric,
  branchColor: string,
  offsetX: number, offsetY: number,
  budget: { n: number },
  darkMode: boolean,
): FlatRect[] {
  const result: FlatRect[] = [];
  for (const rect of rects) {
    const px = offsetX + (rect.x / 100) * canvasW;
    const py = offsetY + (rect.y / 100) * canvasH;
    const pw = (rect.w / 100) * canvasW;
    const ph = (rect.h / 100) * canvasH;
    const color = fillColor(branchColor, depth, darkMode);
    const labelH = (pw >= 20 && ph >= 10) ? 16 : 0;
    const showLabel = labelH > 0 && pw >= 30;
    const showCount = showLabel && pw >= 70;

    const children: FlatRect[] = [];
    // Use node.children directly (already maintained on every node) instead of
    // rebuilding a parent→children map across the whole tree on each render.
    if (rect.node.dir && depth < maxDepth && budget.n < MAX_RECTS) {
      const kids = rect.node.children
        .map(id => nodeById.get(id))
        .filter((n): n is NodeRecord => n !== undefined && getValue(n, metric) > 0)
        .sort((a, b) => getValue(b, metric) - getValue(a, metric))
        .slice(0, maxChildren);
      const innerH = ph - labelH;
      // Only skip subdivision for genuinely tiny cells — small enough to cut
      // crowding, but still showing the bordered/nested structure.
      if (kids.length > 0 && innerH > 14 && pw > 18) {
        const childRects = layoutTreemap(kids, pw, innerH, metric);
        children.push(...flattenLayout(
          childRects, nodeById,
          pw, innerH, depth + 1, maxDepth, maxChildren, metric,
          branchColor, px, py + labelH, budget, darkMode,
        ));
      }
    }

    result.push({
      nodeId: rect.node.id,
      px, py, pw, ph, color, depth,
      showLabel, showCount, pxLabelH: labelH,
      children,
    });
    budget.n++;
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

// Base layer: fills, cell borders, header strips, and labels. Drawn only when
// the layout (flatRects) changes — NOT on hover/selection — so moving the mouse
// never repaints thousands of cells. `parentColor` is the fill of the containing
// cell; each border is a darker shade of it.
function drawBase(
  ctx: CanvasRenderingContext2D,
  rects: FlatRect[],
  nodeById: Map<number, NodeRecord>,
  darkMode: boolean,
  parentColor?: string,
) {
  for (const r of rects) {
    const { px, py, pw, ph } = r;

    // Fill
    ctx.fillStyle = r.color;
    ctx.fillRect(px, py, pw, ph);

    // Border: a darker shade of the parent cell's colour. At the top level there
    // is no parent cell drawn, so shade the cell's own colour instead.
    ctx.strokeStyle = shade(parentColor ?? r.color, 0.6);
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
        ctx.fillStyle = darkMode ? "#e8f0ff" : "#1f2430";
        ctx.font = "600 11px system-ui,sans-serif";
        ctx.textBaseline = "middle";
        const rightEdge = r.showCount ? pw - 54 : pw - 4;
        drawClippedText(ctx, node?.name ?? "", textX, py + r.pxLabelH / 2, rightEdge - (textX - px));

        if (r.showCount) {
          ctx.fillStyle = darkMode ? "rgba(232,240,255,0.78)" : "rgba(31,36,48,0.74)";
          ctx.font = "10px system-ui,sans-serif";
          const countText = isDir
            ? `(${formatCount(node?.files ?? 0)})`
            : formatBytes(node?.size ?? 0);
          drawClippedText(ctx, countText, px + pw - 4, py + r.pxLabelH / 2, 50, "right");
        }
      }
    }

    drawBase(ctx, r.children, nodeById, darkMode, r.color);
  }
}

// Overlay layer: just the selection / hover / drag-over highlights (at most a
// few rects), painted on a transparent canvas stacked above the base.
function drawOverlay(
  ctx: CanvasRenderingContext2D,
  canvasW: number, canvasH: number,
  rectById: Map<number, FlatRect>,
  selectedId: number,
  hoverId: number | null,
  dragOverId: number | null,
  darkMode: boolean,
) {
  ctx.clearRect(0, 0, canvasW, canvasH);

  // Theme-aware highlight strokes: a light stroke reads on the dark-navy fills,
  // a dark stroke reads on the light pastel fills. (Drag stays amber on both.)
  const hoverHeaderTint = darkMode ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.10)";
  const hoverStroke = darkMode ? "rgba(255,255,255,0.7)" : "rgba(0,0,0,0.5)";
  const selectStroke = darkMode ? "#ffffff" : "#1f2430";

  const hov = hoverId != null ? rectById.get(hoverId) : undefined;
  if (hov) {
    if (hov.pxLabelH > 0) {
      ctx.fillStyle = hoverHeaderTint;
      ctx.fillRect(hov.px, hov.py, hov.pw, hov.pxLabelH);
    }
    if (hoverId !== selectedId) {
      ctx.strokeStyle = hoverStroke;
      ctx.lineWidth = 2;
      ctx.strokeRect(hov.px + 1, hov.py + 1, hov.pw - 2, hov.ph - 2);
    }
  }

  const sel = rectById.get(selectedId);
  if (sel) {
    ctx.strokeStyle = selectStroke;
    ctx.lineWidth = 2;
    ctx.strokeRect(sel.px + 1, sel.py + 1, sel.pw - 2, sel.ph - 2);
  }

  const drag = dragOverId != null ? rectById.get(dragOverId) : undefined;
  if (drag) {
    ctx.strokeStyle = "#f0c040";
    ctx.lineWidth = 2;
    ctx.strokeRect(drag.px + 1, drag.py + 1, drag.pw - 2, drag.ph - 2);
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

// Imperative hover-tooltip layer. The tooltip's node/position lives in THIS small
// memoized component's own state and is driven through an imperative handle, so
// showing/hiding it (or following the cursor) never re-renders the Treemap body —
// the canvas + thousands of cells stay put while only this leaf updates. Moving
// the mouse no longer churns React: the parent schedules show()/hide() via a ref.
export interface TreemapTooltipHandle {
  show: (node: NodeRecord, x: number, y: number) => void;
  hide: () => void;
}

const TreemapTooltip = memo(
  forwardRef<TreemapTooltipHandle, { unit: Unit }>(function TreemapTooltip({ unit }, ref) {
    const [tip, setTip] = useState<{ node: NodeRecord; x: number; y: number } | null>(null);
    useImperativeHandle(ref, () => ({
      show: (node, x, y) => setTip({ node, x, y }),
      // Functional update returns the same reference when already hidden, so a
      // hide() during continuous mouse movement (the common case) is a no-op and
      // triggers no re-render.
      hide: () => setTip((prev) => (prev ? null : prev)),
    }), []);
    if (!tip) return null;
    return <NodeTooltip node={tip.node} unit={unit} anchorX={tip.x} anchorY={tip.y} />;
  }),
);

interface TreemapProps {
  nodeById: Map<number, NodeRecord>;
  selectedId: number;
  metric: Metric;
  unit: Unit;
  detail: number;
  darkMode: boolean;
  showSingleFiles: boolean;
  show3D: boolean;
  showHierarchy: boolean;
  showLegend: boolean;
  showLabels: boolean;
  dragDrop: boolean;
  onSelect: (id: number) => void;
  onNavigate: (id: number) => void;
  /** Move folder(s) into a destination folder (same path as the tree's drag
   *  handler: shell IFileOperation / `/api/move-items`, with the self/descendant
   *  guard and conflict handling). Dropping one folder onto another moves it in. */
  onMoveItems?: (sourcePaths: string[], destinationFolder: string) => Promise<{ ok: boolean; error?: string } | void> | { ok: boolean; error?: string } | void;
  onOpen?: (id: number) => void;
  onClose3D?: () => void;
}

export const Treemap = memo(function Treemap({
  nodeById, selectedId, metric, unit, detail, darkMode,
  showSingleFiles, show3D, showHierarchy, showLegend, showLabels, dragDrop,
  onSelect, onNavigate, onMoveItems, onOpen, onClose3D,
}: TreemapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ w: DEFAULT_W, h: DEFAULT_H });
  const hoverIdRef = useRef<number | null>(null);
  const [dragSourceId, setDragSourceId] = useState<number | null>(null);
  const dragOverIdRef = useRef<number | null>(null);
  const rafRef = useRef<number>(0);
  const overlayRafRef = useRef<number>(0);
  const moveRafRef = useRef<number>(0);
  const pendingMoveRef = useRef<{ mx: number; my: number; cx: number; cy: number } | null>(null);
  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tooltip lives in a memoized child driven imperatively (see TreemapTooltip), so
  // hover never re-renders this component or repaints the treemap body.
  const tooltipApiRef = useRef<TreemapTooltipHandle>(null);
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

  // Bundle nodes have negative IDs: id = -(parentId + 1), so parentId = -id - 1.
  const isBundleSelected = selectedId < 0;
  const viewId = useMemo(() => {
    if (selectedId < 0) return -selectedId - 1; // bundle → its parent folder id
    const node = nodeById.get(selectedId);
    if (!node) return 0;
    if (node.dir) return node.id;
    return node.parent ?? 0;
  }, [selectedId, nodeById]);

  const topItems = useMemo(() => {
    const allKids = (nodeById.get(viewId)?.children ?? [])
      .map(id => nodeById.get(id))
      .filter((n): n is NodeRecord => {
        if (n === undefined || getValue(n, metric) <= 0) return false;
        // When a bundle is selected, show only files (that's what the bundle contains).
        if (isBundleSelected) return !n.dir;
        return showSingleFiles || n.dir;
      });
    return allKids
      .sort((a, b) => getValue(b, metric) - getValue(a, metric))
      .slice(0, maxTop);
  }, [viewId, isBundleSelected, nodeById, metric, maxTop, showSingleFiles]);

  const flatRects = useMemo(() => {
    const topRects = layoutTreemap(topItems, containerSize.w, containerSize.h, metric);
    const result: FlatRect[] = [];
    const budget = { n: 0 };
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
          color: fillColor(branchColor, 0, darkMode),
          depth: 0,
          showLabel: showLabels && labelH > 0 && pw >= 30,
          showCount: showLabels && labelH > 0 && pw >= 70,
          pxLabelH: labelH,
          children: [],
        });
      } else {
        const flat = flattenLayout(
          [topRects[i]], nodeById,
          containerSize.w, containerSize.h,
          0, maxDepth, maxChildren, metric,
          branchColor, 0, 0, budget, darkMode,
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
  }, [topItems, containerSize, nodeById, maxDepth, maxChildren, metric, showHierarchy, showLabels, darkMode]);

  // Flat node→rect index for O(1) overlay highlight lookup (no tree walk per
  // hover). Rebuilt only when the layout changes.
  const rectById = useMemo(() => {
    const m = new Map<number, FlatRect>();
    const walk = (rs: FlatRect[]) => {
      for (const r of rs) {
        m.set(r.nodeId, r);
        if (r.children.length) walk(r.children);
      }
    };
    walk(flatRects);
    return m;
  }, [flatRects]);

  // Legend data (top-level items with their colors)
  const legendItems = useMemo(() =>
    topItems.slice(0, BRANCH_COLORS.length).map((n, i) => ({
      node: n,
      color: fillColor(BRANCH_COLORS[i % BRANCH_COLORS.length], 0, darkMode),
    })),
    [topItems, darkMode],
  );

  // Base layer redraw: only when the layout itself changes (NOT hover/select).
  useEffect(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawBase(ctx, flatRects, nodeById, darkMode);
    });
  }, [flatRects, nodeById, darkMode]);

  // Overlay layer: hover/drag highlights live in refs and are painted imperatively
  // (no React re-render per hovered cell). The effect only fires when the layout
  // (rectById) or the selection changes.
  const redrawOverlay = useCallback(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    drawOverlay(ctx, canvas.width, canvas.height, rectById, selectedId, hoverIdRef.current, dragOverIdRef.current, darkMode);
  }, [rectById, selectedId, darkMode]);

  useEffect(() => {
    cancelAnimationFrame(overlayRafRef.current);
    overlayRafRef.current = requestAnimationFrame(redrawOverlay);
  }, [redrawOverlay]);

  const getHit = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return hitTest(flatRects, e.clientX - rect.left, e.clientY - rect.top);
  }, [flatRects]);

  // Hit-test + hover state are computed at most once per animation frame so a
  // fast mouse drag across a dense treemap can't queue up redundant work.
  const processMove = useCallback(() => {
    moveRafRef.current = 0;
    const pm = pendingMoveRef.current;
    if (!pm) return;
    const hit = hitTest(flatRects, pm.mx, pm.my);
    const hitNode = hit ? nodeById.get(hit.nodeId) : null;
    if (canvasRef.current) {
      canvasRef.current.style.cursor =
        isDraggingRef.current && hitNode?.dir ? "copy"
        : isDraggingRef.current ? "no-drop"
        : hit ? "pointer"
        : "default";
    }

    let changed = false;
    const newHoverId = hit ? hit.nodeId : null;
    if (newHoverId !== hoverIdRef.current) {
      hoverIdRef.current = newHoverId;
      changed = true;
    }
    if (isDraggingRef.current) {
      const newDragOverId = hitNode?.dir ? hit!.nodeId : null;
      if (newDragOverId !== dragOverIdRef.current) {
        dragOverIdRef.current = newDragOverId;
        changed = true;
      }
    }
    if (changed) redrawOverlay();

    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
    tooltipApiRef.current?.hide();
    if (hit && hitNode) {
      const cx = pm.cx, cy = pm.cy;
      tooltipTimerRef.current = setTimeout(() => {
        tooltipApiRef.current?.show(hitNode, cx, cy);
      }, 400);
    }
  }, [flatRects, nodeById, redrawOverlay]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    pendingMoveRef.current = {
      mx: e.clientX - rect.left,
      my: e.clientY - rect.top,
      cx: e.clientX,
      cy: e.clientY,
    };
    if (!moveRafRef.current) moveRafRef.current = requestAnimationFrame(processMove);
  }, [processMove]);

  const handleMouseLeave = useCallback(() => {
    if (moveRafRef.current) { cancelAnimationFrame(moveRafRef.current); moveRafRef.current = 0; }
    pendingMoveRef.current = null;
    if (hoverIdRef.current !== null) { hoverIdRef.current = null; redrawOverlay(); }
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
    tooltipApiRef.current?.hide();
  }, [redrawOverlay]);

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
    const dstId = dragOverIdRef.current;
    setDragSourceId(null);
    dragOverIdRef.current = null;
    redrawOverlay();
    if (canvasRef.current) canvasRef.current.style.cursor = "default";

    if (srcId == null || dstId == null || srcId === dstId) return;
    const src = nodeById.get(srcId);
    const dst = nodeById.get(dstId);
    if (!src || !dst || !dst.dir) return;
    // Refuse no-op / unsafe drops: onto itself, into a descendant, or into the
    // folder it already lives in (parent-drop). `srcId === dstId` above only
    // catches the exact-same-cell case; this also blocks dropping a child back
    // onto its own parent, matching the tree's guard so the treemap can't
    // quietly "move" a folder to where it already is.
    if (isNoOpMove(src.path, dst.path)) return;
    // Move the dragged item INTO the destination folder using the same path the
    // tree uses (shell IFileOperation move via /api/move-items, with the
    // self/descendant guard and conflict handling). The old direct moveItem()
    // call hit POST /api/move, which the Rust server doesn't whitelist — so it
    // 405'd and treemap folder moves silently did nothing.
    const result = await onMoveItems?.([src.path], dst.path);
    if (result && !result.ok) alert(`Move failed: ${result.error}`);
  }, [dragSourceId, nodeById, redrawOverlay, onMoveItems]);

  return (
    <>
    {show3D && (
      <Suspense fallback={null}>
        <Treemap3DModal
          nodeById={nodeById}
          viewId={viewId}
          metric={metric}
          onClose={onClose3D ?? (() => {})}
          onNavigate={onNavigate}
        />
      </Suspense>
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
          <canvas
            ref={overlayRef}
            width={containerSize.w}
            height={containerSize.h}
            className="treemap-overlay"
          />
          <TreemapTooltip ref={tooltipApiRef} unit={unit} />
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
