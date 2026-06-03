import { useCallback, useEffect, useMemo, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DiffResult, DiffRow, DiffStatus, NodeRecord, ScanResult, SnapshotMeta } from "../api/types";
import { deleteSnapshot, fetchSnapshotDiff, fetchSnapshots, saveSnapshot } from "../api/client";
import { formatBytes } from "../utils/formatBytes";
import { formatDate } from "../utils/formatDate";
import { confirmDialog } from "../lib/dialogs";
import { toast } from "../lib/toast";
import { Icon } from "./Icon";
import { EmptyState } from "./EmptyState";

// Scan Snapshots + historical diff (F2). Save a compact snapshot of the current
// scan, then diff two saved points in time to see which folders were added /
// removed / changed, with per-folder size deltas.
//
// Backed by the NEW compact snapshot store (src/snapshots.rs) via the client
// wrappers: GET /api/snapshots (list), POST /api/snapshots-save,
// GET /api/snapshots-diff and POST /api/snapshots-delete. The diff endpoint
// compares two SAVED snapshots only (there is no "vs current scan" mode in this
// store). The client adapts its added/removed/changed buckets into the DiffRow
// view model used here; "grown"+"shrunk" are presented together as "changed".

const ROW_H = 30;

type DiffBucket = "added" | "removed" | "changed";
type FilterId = "all" | DiffBucket;
type SortKey = "path" | "sizeA" | "sizeB" | "delta";

interface SnapshotsViewProps {
  /** The focused tab's current scan (the live "current" comparison side). */
  data: ScanResult | null;
  nodeById: Map<number, NodeRecord>;
  /** Reveal + select a node in the tree (also switches back to Explorer). */
  onNavigate: (id: number) => void;
}

function bucketOf(status: DiffStatus): DiffBucket {
  if (status === "added") return "added";
  if (status === "removed") return "removed";
  return "changed";
}

function snapshotLabel(meta: SnapshotMeta): string {
  // createdAt is unix SECONDS; formatDate wants ms.
  return `${meta.path} · ${formatBytes(meta.total)} · ${formatDate(meta.createdAt * 1000)}`;
}

/** Signed, human byte delta, e.g. "+1.2 GB" / "−340 MB". */
function formatDelta(delta: number): string {
  if (delta === 0) return "0";
  const sign = delta >= 0 ? "+" : "\u2212";
  return `${sign}${formatBytes(Math.abs(delta))}`;
}

function rowValue(r: DiffRow, k: SortKey): number | string {
  switch (k) {
    case "path": return r.path.toLowerCase();
    case "sizeA": return r.oldSize;
    case "sizeB": return r.newSize;
    case "delta": return r.delta;
  }
}

export function SnapshotsView({ data, nodeById, onNavigate }: SnapshotsViewProps) {
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
  const [aId, setAId] = useState("");
  const [bId, setBId] = useState("");
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<FilterId>("all");
  const [sortKey, setSortKey] = useState<SortKey>("delta");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);

  const rootPath = data?.rootPath ?? "";

  // Path → node id for the CURRENT scan so a diff row can reveal in the tree
  // when that path still exists in the loaded scan.
  const pathToId = useMemo(() => {
    const map = new Map<string, number>();
    for (const node of nodeById.values()) if (node.path) map.set(node.path.toLowerCase(), node.id);
    return map;
  }, [nodeById]);

  const refreshSnapshots = useCallback(async () => {
    const list = await fetchSnapshots();
    setSnapshots(list);
    return list;
  }, []);

  useEffect(() => { void refreshSnapshots(); }, [refreshSnapshots]);

  // Sensible defaults: diff the previous snapshot (base) → the newest (target).
  useEffect(() => {
    if (snapshots.length === 0) return;
    setAId((prev) => prev || (snapshots[1]?.id ?? snapshots[0].id));
    setBId((prev) => prev || snapshots[0].id);
  }, [snapshots]);

  const handleSave = useCallback(async () => {
    if (!rootPath) return;
    setSaving(true);
    setError("");
    try {
      const list = await saveSnapshot(rootPath);
      setSnapshots(list);
      // Default the diff to PREVIOUS snapshot (base) → the one just saved (target),
      // so an immediate Compare shows real growth instead of an empty (self) diff.
      setBId(list[0]?.id ?? "");
      setAId(list[1]?.id ?? list[0]?.id ?? "");
      toast.success("Saved a snapshot of the current scan.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }, [rootPath]);

  const handleDelete = useCallback(async (id: string) => {
    const ok = await confirmDialog({
      title: "Delete snapshot",
      message: "Delete this saved snapshot? This cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    const list = await deleteSnapshot(id);
    setSnapshots(list);
    if (aId === id) setAId(list[1]?.id ?? list[0]?.id ?? "");
    if (bId === id) setBId(list[0]?.id ?? "");
    if (diff && (diff.a.id === id || diff.b.id === id)) setDiff(null);
  }, [aId, bId, diff]);

  const handleCompare = useCallback(async () => {
    if (!aId || !bId) return;
    if (aId === bId) { setError("Pick two different snapshots to compare."); return; }
    const a = snapshots.find((s) => s.id === aId);
    const b = snapshots.find((s) => s.id === bId);
    if (!a || !b) { setError("Pick two saved snapshots to compare."); return; }
    setBusy(true);
    setError("");
    setDiff(null);
    try {
      const result = await fetchSnapshotDiff(a, b);
      setDiff(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }, [aId, bId, snapshots]);

  const onSort = useCallback((key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(key); setSortDir(key === "path" ? 1 : -1); }
  }, [sortKey]);

  const counts = useMemo(() => {
    const c = { all: 0, added: 0, removed: 0, changed: 0 };
    for (const r of diff?.rows ?? []) { c.all++; c[bucketOf(r.status)]++; }
    return c;
  }, [diff]);

  const visibleRows = useMemo(() => {
    const rows = (diff?.rows ?? []).filter((r) => filter === "all" || bucketOf(r.status) === filter);
    const cmp = (a: number | string, b: number | string) => (a < b ? -1 : a > b ? 1 : 0) * sortDir;
    return [...rows].sort((a, b) => cmp(rowValue(a, sortKey), rowValue(b, sortKey)));
  }, [diff, filter, sortKey, sortDir]);

  const virtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => ROW_H,
    overscan: 16,
  });

  const revealRow = useCallback((row: DiffRow) => {
    const id = pathToId.get(row.path.toLowerCase());
    if (id != null) onNavigate(id);
  }, [pathToId, onNavigate]);

  const options = useMemo(
    () => snapshots.map((s) => ({ value: s.id, label: snapshotLabel(s) })),
    [snapshots],
  );

  const sortIcon = (key: SortKey) =>
    sortKey === key ? <Icon name={sortDir === 1 ? "caret-up" : "caret-down"} size={9} className="sort-caret" /> : null;

  const FILTERS: { id: FilterId; label: string }[] = [
    { id: "all", label: `All (${counts.all})` },
    { id: "added", label: `Added (${counts.added})` },
    { id: "removed", label: `Removed (${counts.removed})` },
    { id: "changed", label: `Changed (${counts.changed})` },
  ];

  return (
    <div className="snap-view">
      <div className="snap-controls">
        <div className="snap-save">
          <button
            className="snap-btn"
            onClick={() => void handleSave()}
            disabled={!rootPath || saving}
            title={rootPath ? "Save the current scan as a snapshot" : "Run a scan first"}
          >
            <Icon name="clock-history" size={13} /> {saving ? "Saving…" : "Save snapshot of current scan"}
          </button>
        </div>

        <div className="snap-pick">
          <label>
            <span>Base</span>
            <select value={aId} onChange={(e) => setAId(e.target.value)} disabled={busy}>
              {options.length === 0 && <option value="">No snapshots yet</option>}
              {options.map((o) => <option key={`a-${o.value}`} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <Icon name="chevron-right" size={14} className="snap-arrow" />
          <label>
            <span>Compare to</span>
            <select value={bId} onChange={(e) => setBId(e.target.value)} disabled={busy}>
              {options.length === 0 && <option value="">No snapshots yet</option>}
              {options.map((o) => <option key={`b-${o.value}`} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <button className="snap-btn primary" onClick={() => void handleCompare()} disabled={busy || !aId || !bId}>
            {busy ? "Comparing…" : "Compare"}
          </button>
        </div>
      </div>

      {error && <div className="snap-error">{error}</div>}

      {snapshots.length > 0 && (
        <details className="snap-manage">
          <summary>{snapshots.length} saved snapshot{snapshots.length === 1 ? "" : "s"}</summary>
          <ul className="snap-list">
            {snapshots.map((s) => (
              <li key={s.id}>
                <span className="snap-meta" title={s.path}>{snapshotLabel(s)}</span>
                <button className="snap-del" title="Delete snapshot" onClick={() => void handleDelete(s.id)}>
                  <Icon name="trash" size={12} />
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {diff ? (
        <div className="snap-results">
          <div className="snap-summary">
            <span className="snap-net" title="Net change in total size">Net {formatDelta(diff.summary.netDelta)}</span>
            <span>{formatBytes(diff.summary.oldTotal)} → {formatBytes(diff.summary.newTotal)}</span>
            {diff.summary.capped && (
              <span className="snap-capped" title={`Showing the ${diff.rows.length} largest of ${diff.summary.rowCount} changes`}>
                top {diff.rows.length.toLocaleString()} of {diff.summary.rowCount.toLocaleString()}
              </span>
            )}
          </div>

          <div className="snap-filters" role="tablist">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                role="tab"
                aria-selected={filter === f.id}
                className={`snap-filter${filter === f.id ? " active" : ""} ${f.id}`}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="snap-table">
            <div className="snap-row snap-head">
              <button className="s-name" onClick={() => onSort("path")}>Path {sortIcon("path")}</button>
              <span className="s-status">Change</span>
              <button className="s-num" onClick={() => onSort("sizeA")}>Size A {sortIcon("sizeA")}</button>
              <button className="s-num" onClick={() => onSort("sizeB")}>Size B {sortIcon("sizeB")}</button>
              <button className="s-num" onClick={() => onSort("delta")}>Delta {sortIcon("delta")}</button>
            </div>
            <div className="snap-body" ref={setScrollEl}>
              {visibleRows.length === 0 ? (
                <div className="snap-empty-rows">No {filter === "all" ? "" : `${filter} `}changes to show.</div>
              ) : (
                <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                  {virtualizer.getVirtualItems().map((vi) => {
                    const row = visibleRows[vi.index];
                    if (!row) return null;
                    const revealable = pathToId.has(row.path.toLowerCase());
                    return (
                      <div
                        key={`${row.path}-${vi.index}`}
                        className={`snap-row${revealable ? " revealable" : ""}`}
                        style={{ position: "absolute", top: vi.start, left: 0, right: 0, height: ROW_H }}
                        title={revealable ? `${row.path}\nClick to reveal in the tree` : row.path}
                        onClick={() => { if (revealable) revealRow(row); }}
                      >
                        <span className="s-name">
                          <span className={`snap-kind ${row.dir ? "dir" : "file"}`} />
                          {row.path}
                        </span>
                        <span className="s-status">
                          <span className={`snap-badge ${bucketOf(row.status)}`}>{bucketOf(row.status)}</span>
                        </span>
                        <span className="s-num">{row.oldSize ? formatBytes(row.oldSize) : "—"}</span>
                        <span className="s-num">{row.newSize ? formatBytes(row.newSize) : "—"}</span>
                        <span className={`s-num ${row.delta >= 0 ? "pos" : "neg"}`}>{formatDelta(row.delta)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        !busy && (
          <EmptyState
            icon="clock-history"
            title="Track disk usage over time"
            hint={options.length === 0
              ? "Save a snapshot of the current scan, then come back later to see what grew."
              : "Pick a base and a comparison, then press Compare to see what was added, removed or changed."}
          />
        )
      )}
    </div>
  );
}
