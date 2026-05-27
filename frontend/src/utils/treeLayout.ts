// Squarified Treemap — Bruls, Huizing, van Wijk (2000)
// Critical orientation rule:
//   wide container (w >= h)  → vertical COLUMNS  (items stack top→bottom, strip width = area/h)
//   tall container (w <  h)  → horizontal ROWS    (items stack left→right, strip height = area/w)
// Passing 100×100 to a wide panel was backwards; always pass actual container dimensions.

import type { NodeRecord, Metric } from "../api/types";

export interface TileRect {
  node: NodeRecord;
  x: number; // percentage of container width  (0–100)
  y: number; // percentage of container height (0–100)
  w: number;
  h: number;
}

export function metricValue(node: NodeRecord, metric: Metric): number {
  switch (metric) {
    case "allocated": return node.allocated;
    case "files":     return node.files;
    case "folders":   return node.folders;
    default:          return node.size;
  }
}

// Worst aspect ratio of items in a row/column.
// w = the shorter edge of the current free rectangle (determines strip thickness).
function worstAspect(rMin: number, rMax: number, s: number, w: number): number {
  if (s === 0 || w === 0 || rMin === 0) return Infinity;
  const w2 = w * w, s2 = s * s;
  return Math.max((w2 * rMax) / s2, s2 / (w2 * rMin));
}

interface Item { node: NodeRecord; area: number; }

// Lay out one completed strip and return the remaining [x, y, w, h].
function layoutStrip(
  row: Item[],
  x: number, y: number, w: number, h: number,
  out: TileRect[],
): [number, number, number, number] {
  const s = row.reduce((t, d) => t + d.area, 0);
  if (s <= 0) return [x, y, w, h];

  if (w >= h) {
    // Wide container → vertical column: fixed width, items top→bottom
    const stripW = s / h;
    let py = y;
    for (const d of row) {
      const ih = d.area / stripW;
      out.push({ node: d.node, x, y: py, w: stripW, h: ih });
      py += ih;
    }
    return [x + stripW, y, w - stripW, h];
  } else {
    // Tall container → horizontal row: fixed height, items left→right
    const stripH = s / w;
    let px = x;
    for (const d of row) {
      const iw = d.area / stripH;
      out.push({ node: d.node, x: px, y, w: iw, h: stripH });
      px += iw;
    }
    return [x, y + stripH, w, h - stripH];
  }
}

function squarify(items: Item[], x: number, y: number, w: number, h: number, out: TileRect[]): void {
  let row: Item[] = [];
  let rowMin = Infinity, rowMax = 0, rowSum = 0;
  let ix = x, iy = y, iw = w, ih = h;

  for (const d of items) {
    const short = Math.min(iw, ih);
    if (short <= 0) break;

    const nMin = Math.min(rowMin, d.area);
    const nMax = Math.max(rowMax, d.area);
    const nSum = rowSum + d.area;

    if (row.length === 0 || worstAspect(nMin, nMax, nSum, short) <= worstAspect(rowMin, rowMax, rowSum, short)) {
      row.push(d); rowMin = nMin; rowMax = nMax; rowSum = nSum;
    } else {
      [ix, iy, iw, ih] = layoutStrip(row, ix, iy, iw, ih, out);
      row = [d]; rowMin = d.area; rowMax = d.area; rowSum = d.area;
    }
  }
  if (row.length > 0) layoutStrip(row, ix, iy, iw, ih, out);
}

// ─── Public entry point ───────────────────────────────────────────────────────
// Pass ACTUAL container pixel dimensions (or a value with the correct aspect
// ratio). Output coordinates are normalized back to 0–100 percentages.

export function layoutTreemap(
  items: NodeRecord[],
  containerW: number,
  containerH: number,
  metric: Metric,
): TileRect[] {
  if (!items.length || containerW <= 0 || containerH <= 0) return [];

  const entries: Item[] = items
    .map(n => ({ node: n, area: metricValue(n, metric) }))
    .filter(e => e.area > 0)
    .sort((a, b) => b.area - a.area);

  if (!entries.length) return [];

  // Normalize areas so they sum to exactly containerW × containerH.
  const rawTotal = entries.reduce((s, e) => s + e.area, 0);
  const totalArea = containerW * containerH;
  for (const e of entries) e.area = (e.area / rawTotal) * totalArea;

  const out: TileRect[] = [];
  squarify(entries, 0, 0, containerW, containerH, out);

  // Convert absolute coords → percentages of container.
  return out.map(r => ({
    node: r.node,
    x: (r.x / containerW) * 100,
    y: (r.y / containerH) * 100,
    w: (r.w / containerW) * 100,
    h: (r.h / containerH) * 100,
  }));
}
