// Export search/filter result rows to CSV / JSON (#35).
//
// A small, dependency-free download built from the in-memory result rows. Unlike
// the server `/api/export.*` endpoints (which report on the WHOLE last scan plus
// analytics), this exports exactly the rows the user is currently looking at in
// the search/filter results, with the columns: Name, Size, Type, Modified, Full
// path. Everything is frontend-only.

import type { NodeRecord } from "../api/types";

/** A category/type label for a node, used as the "Type" column. */
function typeLabel(node: NodeRecord): string {
  if (node.dir) return "Folder";
  const ext = (node.extension || "").replace(/^\./, "");
  return ext ? ext.toLowerCase() : "File";
}

function isoOrEmpty(epochSeconds: number): string {
  if (!epochSeconds) return "";
  try {
    return new Date(epochSeconds * 1000).toISOString();
  } catch {
    return "";
  }
}

interface ResultRow {
  name: string;
  size: number;
  type: string;
  modified: string;
  path: string;
}

function toRows(nodes: NodeRecord[]): ResultRow[] {
  return nodes.map((n) => ({
    name: n.name,
    size: n.size,
    type: typeLabel(n),
    modified: isoOrEmpty(n.modified),
    path: n.path,
  }));
}

function csvCell(value: string | number): string {
  const s = String(value);
  // Quote when the cell contains a comma, quote, or newline (RFC 4180).
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function buildResultsCsv(nodes: NodeRecord[]): string {
  const header = ["Name", "Size", "Type", "Modified", "Full path"];
  const lines = [header.join(",")];
  for (const r of toRows(nodes)) {
    lines.push([r.name, r.size, r.type, r.modified, r.path].map(csvCell).join(","));
  }
  return lines.join("\r\n");
}

export function buildResultsJson(nodes: NodeRecord[]): string {
  return JSON.stringify(toRows(nodes), null, 2);
}

/** Trigger a client-side download of `text` as `filename`. */
export function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on the next tick so the click has consumed the URL.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Build + download the result rows in the requested format. */
export function exportResults(nodes: NodeRecord[], format: "csv" | "json"): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  if (format === "csv") {
    downloadText(`search-results-${stamp}.csv`, buildResultsCsv(nodes), "text/csv;charset=utf-8");
  } else {
    downloadText(`search-results-${stamp}.json`, buildResultsJson(nodes), "application/json");
  }
}
