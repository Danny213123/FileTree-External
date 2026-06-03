import { useMemo, useRef, useState, useEffect, useCallback } from "react";
import type { NodeRecord, Metric } from "../api/types";
import { formatBytes, formatCount } from "../utils/formatBytes";
import "./Treemap3DModal.css";

const BRANCH_COLORS = [
  "#1c5ea8", "#1a7a5a", "#7a3fa0", "#c06020",
  "#236028", "#962030", "#1068a0", "#705828",
  "#1a6878", "#883060", "#405890", "#686830",
];

// Isometric projection constants
const TW = 48;       // screen px per world unit (X/Z horizontal)
const TH = 24;       // screen px per world unit (Y vertical component)
const BAR_SCALE = 110; // screen px for max bar height
const MAX_ITEMS = 30;

function getValue(n: NodeRecord, metric: Metric): number {
  if (metric === "allocated") return n.allocated;
  if (metric === "files") return n.files;
  if (metric === "folders") return n.folders;
  return n.size;
}

function shade(hex: string, factor: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * factor));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * factor));
  const b = Math.min(255, Math.round((n & 255) * factor));
  return `rgb(${r},${g},${b})`;
}

function pts(arr: [number, number][]): string {
  return arr.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
}

// Rotate world point around Y axis by θ radians, then isometric-project to screen
function project(wx: number, wy: number, wz: number, θ: number, ox: number, oy: number): [number, number] {
  const rx = wx * Math.cos(θ) + wz * Math.sin(θ);
  const rz = -wx * Math.sin(θ) + wz * Math.cos(θ);
  return [
    ox + (rx - rz) * TW,
    oy + (rx + rz) * TH - wy * BAR_SCALE,
  ];
}

interface Bar {
  node: NodeRecord;
  col: number;
  row: number;
  h: number;   // normalized 0..1
  color: string;
}

interface Props {
  nodeById: Map<number, NodeRecord>;
  viewId: number;
  metric: Metric;
  onClose: () => void;
  onNavigate: (id: number) => void;
}

export function Treemap3DModal({ nodeById, viewId, metric, onClose, onNavigate }: Props) {
  const [angle, setAngle] = useState(Math.PI / 5);
  const dragRef = useRef<{ startX: number; startAngle: number } | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const svgW = 820, svgH = 480;

  const items = useMemo(() => {
    const kids: NodeRecord[] = [];
    for (const cid of nodeById.get(viewId)?.children ?? []) {
      const child = nodeById.get(cid);
      if (child) kids.push(child);
    }
    return kids
      .filter(n => getValue(n, metric) > 0)
      .sort((a, b) => getValue(b, metric) - getValue(a, metric))
      .slice(0, MAX_ITEMS);
  }, [nodeById, viewId, metric]);

  const maxVal = useMemo(() => Math.max(1, ...items.map(n => getValue(n, metric))), [items, metric]);
  const cols = Math.max(1, Math.ceil(Math.sqrt(items.length)));
  const rows = Math.ceil(items.length / cols);

  const bars: Bar[] = useMemo(() => items.map((node, i) => ({
    node,
    col: i % cols,
    row: Math.floor(i / cols),
    // Use cube-root scaling so small items are still visible
    h: Math.max(0.04, Math.cbrt(getValue(node, metric) / maxVal)),
    color: BRANCH_COLORS[i % BRANCH_COLORS.length],
  })), [items, cols, maxVal, metric]);

  // Origin offset so the grid is centered in the SVG
  const ox = svgW / 2;
  const oy = svgH * 0.72;

  // Sort bars back-to-front for painter's algorithm (varies with angle)
  const sorted = useMemo(() => {
    return [...bars].sort((a, b) => {
      // Depth in rotated space: larger = further back = draw first
      const da = (a.col + 0.5) * Math.sin(angle) + (a.row + 0.5) * Math.cos(angle);
      const db = (b.col + 0.5) * Math.sin(angle) + (b.row + 0.5) * Math.cos(angle);
      return db - da;
    });
  }, [bars, angle]);

  const p = useCallback((wx: number, wy: number, wz: number): [number, number] => {
    // Center grid around origin
    return project(wx - cols / 2, wy, wz - rows / 2, angle, ox, oy);
  }, [angle, cols, rows, ox, oy]);

  // Mouse drag to rotate
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragRef.current = { startX: e.clientX, startAngle: angle };
    e.preventDefault();
  }, [angle]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      setAngle(dragRef.current.startAngle + (e.clientX - dragRef.current.startX) * 0.008);
    };
    const onUp = () => { dragRef.current = null; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const hoveredNode = hovered != null ? nodeById.get(hovered) : null;

  return (
    <div className="modal3d-overlay" onClick={onClose}>
      <div className="modal3d" onClick={e => e.stopPropagation()}>

        <div className="modal3d-header">
          <span className="modal3d-title">3D Chart</span>
          {hoveredNode && (
            <span className="modal3d-tooltip">
              {hoveredNode.name} — {formatBytes(hoveredNode.size)}
              {hoveredNode.dir ? ` · ${formatCount(hoveredNode.files)} files` : ""}
            </span>
          )}
          <button className="modal3d-close" onClick={onClose}>✕</button>
        </div>

        <div
          className="modal3d-scene"
          onMouseDown={onMouseDown}
          style={{ cursor: dragRef.current ? "grabbing" : "grab" }}
        >
          <svg
            width={svgW}
            height={svgH}
            style={{ display: "block", overflow: "visible" }}
          >
            {/* Floor grid lines */}
            <g opacity="0.18" stroke="#8ab" strokeWidth="0.5">
              {Array.from({ length: cols + 1 }, (_, i) => {
                const a0 = p(i, 0, 0), a1 = p(i, 0, rows);
                return <line key={`gc${i}`} x1={a0[0]} y1={a0[1]} x2={a1[0]} y2={a1[1]} />;
              })}
              {Array.from({ length: rows + 1 }, (_, j) => {
                const b0 = p(0, 0, j), b1 = p(cols, 0, j);
                return <line key={`gr${j}`} x1={b0[0]} y1={b0[1]} x2={b1[0]} y2={b1[1]} />;
              })}
            </g>

            {sorted.map(({ node, col, row, h, color }) => {
              const isHov = hovered === node.id;

              // 8 box corners — box occupies [col, col+1] × [0, h] × [row, row+1]
              const BFL = p(col,   0, row + 1);
              const BFR = p(col+1, 0, row + 1);
              const BBL = p(col,   0, row);
              const BBR = p(col+1, 0, row);
              const TFL = p(col,   h, row + 1);
              const TFR = p(col+1, h, row + 1);
              const TBL = p(col,   h, row);
              const TBR = p(col+1, h, row);

              // Face visibility from rotation angle (normals in world space)
              const sinA = Math.sin(angle), cosA = Math.cos(angle);
              const showFront = cosA > 0;   // z = row+1 face, normal +Z
              const showBack  = cosA < 0;   // z = row   face, normal -Z
              const showRight = sinA > 0;   // x = col+1 face, normal +X
              const showLeft  = sinA < 0;   // x = col   face, normal -X

              const topC   = isHov ? shade(color, 1.25) : shade(color, 1.0);
              const sideA  = isHov ? shade(color, 0.80) : shade(color, 0.65);
              const sideB  = isHov ? shade(color, 0.60) : shade(color, 0.45);

              const topMid: [number, number] = [
                (TBL[0]+TBR[0]+TFR[0]+TFL[0]) / 4,
                (TBL[1]+TBR[1]+TFR[1]+TFL[1]) / 4,
              ];
              const label = node.name.length > 12 ? node.name.slice(0, 11) + "…" : node.name;
              const stroke = "rgba(0,0,0,0.35)";
              const sw = "0.5";

              return (
                <g
                  key={node.id}
                  onMouseEnter={() => setHovered(node.id)}
                  onMouseLeave={() => setHovered(null)}
                  onClick={() => { onNavigate(node.id); onClose(); }}
                  style={{ cursor: "pointer" }}
                >
                  {showBack  && <polygon points={pts([BBL, TBL, TBR, BBR])} fill={sideA} stroke={stroke} strokeWidth={sw} />}
                  {showLeft  && <polygon points={pts([BBL, TBL, TFL, BFL])} fill={sideB} stroke={stroke} strokeWidth={sw} />}
                  {showFront && <polygon points={pts([BFL, TFL, TFR, BFR])} fill={sideA} stroke={stroke} strokeWidth={sw} />}
                  {showRight && <polygon points={pts([BFR, TFR, TBR, BBR])} fill={sideB} stroke={stroke} strokeWidth={sw} />}
                  {/* Top face — always visible */}
                  <polygon points={pts([TBL, TBR, TFR, TFL])} fill={topC} stroke={stroke} strokeWidth={sw} />
                  {/* Label on top */}
                  {h > 0.12 && (
                    <text
                      x={topMid[0]} y={topMid[1] - 2}
                      textAnchor="middle"
                      fontSize="9"
                      fontWeight="600"
                      fill="rgba(255,255,255,0.92)"
                      style={{ pointerEvents: "none" }}
                    >
                      {label}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>

          <div className="modal3d-hint">Drag left / right to rotate · Click a bar to navigate</div>
        </div>

      </div>
    </div>
  );
}
