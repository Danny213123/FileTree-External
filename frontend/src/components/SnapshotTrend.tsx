import { useMemo } from "react";
import type { SnapshotMeta } from "../api/types";
import { formatBytes } from "../utils/formatBytes";
import { formatDate } from "../utils/formatDate";
import { isAutoSnapshot, rootKey } from "../lib/autoSnapshot";

// Growth-over-time trend (#36): a dependency-free SVG line/area chart of total
// size vs. snapshot timestamp for the CURRENT scan root. Auto-snapshots (#36)
// render as hollow dots, manual saves as filled, so the accumulated history is
// readable at a glance. Hover a dot for the exact size + date.

interface SnapshotTrendProps {
  snapshots: SnapshotMeta[];
  /** Current scan root; the trend is scoped to snapshots of this root. */
  rootPath: string;
}

const VB_W = 720;
const VB_H = 180;
const PAD_L = 8;
const PAD_R = 8;
const PAD_T = 14;
const PAD_B = 22;

export function SnapshotTrend({ snapshots, rootPath }: SnapshotTrendProps) {
  const points = useMemo(() => {
    if (!rootPath) return [];
    const key = rootKey(rootPath);
    return snapshots
      .filter((s) => rootKey(s.path) === key)
      .map((s) => ({ id: s.id, t: s.createdAt, total: s.total, auto: isAutoSnapshot(s.id) }))
      .sort((a, b) => a.t - b.t);
  }, [snapshots, rootPath]);

  const geom = useMemo(() => {
    if (points.length === 0) return null;
    const minT = points[0].t;
    const maxT = points[points.length - 1].t;
    const spanT = Math.max(1, maxT - minT);
    const maxV = Math.max(1, ...points.map((p) => p.total));
    const plotW = VB_W - PAD_L - PAD_R;
    const plotH = VB_H - PAD_T - PAD_B;
    // Single point sits centered; otherwise spread across the full plot width.
    const x = (t: number) => (points.length === 1 ? PAD_L + plotW / 2 : PAD_L + ((t - minT) / spanT) * plotW);
    const y = (v: number) => PAD_T + plotH - (v / maxV) * plotH;
    const xs = points.map((p) => ({ ...p, cx: x(p.t), cy: y(p.total) }));
    const line = xs.map((p, i) => `${i === 0 ? "M" : "L"}${p.cx.toFixed(1)},${p.cy.toFixed(1)}`).join(" ");
    const area = xs.length >= 2
      ? `${line} L${xs[xs.length - 1].cx.toFixed(1)},${(PAD_T + plotH).toFixed(1)} L${xs[0].cx.toFixed(1)},${(PAD_T + plotH).toFixed(1)} Z`
      : "";
    return { xs, line, area, maxV, baseY: PAD_T + plotH };
  }, [points]);

  if (!rootPath || points.length === 0 || !geom) return null;

  const first = points[0];
  const last = points[points.length - 1];
  const netDelta = last.total - first.total;
  const sign = netDelta >= 0 ? "+" : "\u2212";

  return (
    <div className="snap-trend">
      <div className="snap-trend-head">
        <span className="snap-trend-title">
          <Icon /> Growth over time
        </span>
        <span className="snap-trend-sub">
          {points.length} snapshot{points.length === 1 ? "" : "s"} · {formatBytes(first.total)} → {formatBytes(last.total)}
          {points.length > 1 && (
            <span className={`snap-trend-net ${netDelta >= 0 ? "pos" : "neg"}`}>
              {" "}({sign}{formatBytes(Math.abs(netDelta))})
            </span>
          )}
        </span>
      </div>
      <svg
        className="snap-trend-svg"
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Snapshot size trend"
      >
        {geom.area && <path className="snap-trend-area" d={geom.area} />}
        {points.length > 1 && <path className="snap-trend-line" d={geom.line} fill="none" />}
        {geom.xs.map((p) => (
          <circle
            key={p.id}
            className={`snap-trend-dot${p.auto ? " auto" : " manual"}`}
            cx={p.cx}
            cy={p.cy}
            r={3.2}
          >
            <title>
              {formatBytes(p.total)} · {formatDate(p.t * 1000)}{p.auto ? " · auto" : " · manual"}
            </title>
          </circle>
        ))}
      </svg>
    </div>
  );
}

// Tiny inline bar-chart glyph (avoids depending on the Icon set for one mark).
function Icon() {
  return (
    <svg width={13} height={13} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M0 0h1v15h15v1H0zm14.817 3.113a.5.5 0 0 1 .07.704l-4.5 5.5a.5.5 0 0 1-.74.037L7.06 6.767l-3.656 4.962a.5.5 0 1 1-.808-.594l4-5.428a.5.5 0 0 1 .758-.06l2.609 2.61 4.15-5.073a.5.5 0 0 1 .704-.071" />
    </svg>
  );
}
