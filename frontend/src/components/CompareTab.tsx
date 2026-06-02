import { useCallback, useEffect, useMemo, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DiffResult, DiffRow, NodeRecord, ScanResult, SnapshotMeta } from "../api/types";
import {
  deleteSnapshot,
  fetchSnapshotDiff,
  fetchSnapshots,
  saveSnapshot,
} from "../api/client";
import { formatBytes } from "../utils/formatBytes";
import { formatDate } from "../utils/formatDate";
import { Icon } from "./Icon";
import { EmptyState } from "./EmptyState";

interface CompareTabProps {
  /** The focused tab's current scan (the live "current" comparison side). */
  data: ScanResult | null;
  nodeById: Map<number, NodeRecord>;
  /** Reveal + select a node in the tree (also switches back to Explorer). */
  onNavigate: (id: number) => void;
}

const CURRENT = "current";

// Fixed row height for the virtualized diff list (matches the .compare-row box:
// 12px vertical padding + ~17px line + 1px divider, box-sizing: border-box).
const DIFF_ROW_HEIGHT = 32;

function snapshotLabel(meta: SnapshotMeta): string {
  const when = meta.savedAt ? formatDate(meta.savedAt) : formatDate(meta.scannedAt);
  const tag = meta.label ? `${meta.label} — ` : "";
  return `${tag}${meta.rootPath} · ${formatBytes(meta.totalSize)} · ${when}`;
}

/** Signed byte delta, e.g. "+1.2 GB" / "−340 MB". */
function formatDelta(delta: number): string {
  const sign = delta >= 0 ? "+" : "\u2212";
  return `${sign}${formatBytes(Math.abs(delta))}`;
}

function formatPct(row: DiffRow): string {
  if (row.status === "added") return "new";
  if (row.status === "removed") return "gone";
  if (row.oldSize === 0) return "new";
  const pct = ((row.newSize - row.oldSize) / row.oldSize) * 100;
  const sign = pct >= 0 ? "+" : "\u2212";
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

export function CompareTab({ data, nodeById, onNavigate }: CompareTabProps) {
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
  const [aId, setAId] = useState<string>("");
  const [bId, setBId] = useState<string>("");
  const [label, setLabel] = useState<string>("");
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");

  const rootPath = data?.rootPath ?? "";

  // Path → node id for the CURRENT scan, so a diff row can reveal in the tree
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

  // Sensible defaults: compare the newest snapshot (base) against the current
  // scan (target) — i.e. "what changed since I last saved a snapshot".
  useEffect(() => {
    if (!aId && snapshots.length) setAId(snapshots[0].id);
    if (!bId) setBId(data ? CURRENT : (snapshots[0]?.id ?? ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshots, data]);

  const handleSave = useCallback(async () => {
    if (!rootPath) return;
    setBusy(true);
    setError("");
    try {
      const list = await saveSnapshot(rootPath, label.trim() || undefined);
      setSnapshots(list);
      setLabel("");
      // Default the base to the PREVIOUS snapshot (if any) so an immediate
      // Compare-vs-current shows real growth instead of an empty (self) diff.
      setAId(list[1]?.id ?? list[0]?.id ?? "");
      if (data) setBId(CURRENT);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [rootPath, label, data]);

  const handleDelete = useCallback(async (id: string) => {
    const list = await deleteSnapshot(id);
    setSnapshots(list);
    if (aId === id) setAId(list[0]?.id ?? "");
    if (bId === id) setBId(data ? CURRENT : (list[0]?.id ?? ""));
  }, [aId, bId, data]);

  const handleCompare = useCallback(async () => {
    if (!aId || !bId) return;
    if (aId === bId) { setError("Pick two different sides to compare."); return; }
    if ((aId === CURRENT || bId === CURRENT) && !rootPath) {
      setError("No current scan is loaded to compare against.");
      return;
    }
    setBusy(true);
    setError("");
    setDiff(null);
    try {
      const result = await fetchSnapshotDiff(aId, bId, rootPath || undefined);
      setDiff(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [aId, bId, rootPath]);

  const revealRow = useCallback((row: DiffRow) => {
    const id = pathToId.get(row.path.toLowerCase());
    if (id != null) onNavigate(id);
  }, [pathToId, onNavigate]);

  const options = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    if (data) opts.push({ value: CURRENT, label: `Current scan · ${rootPath}` });
    for (const s of snapshots) opts.push({ value: s.id, label: snapshotLabel(s) });
    return opts;
  }, [data, rootPath, snapshots]);

  return (
    <div className="compare-tab">
      <div className="compare-controls">
        <div className="compare-save">
          <input
            className="compare-label-input"
            placeholder="Optional label (e.g. before cleanup)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={!rootPath || busy}
          />
          <button className="compare-btn" onClick={() => void handleSave()} disabled={!rootPath || busy} title={rootPath ? "Save the current scan as a snapshot" : "Run a scan first"}>
            <Icon name="clock-history" size={13} /> Save current as snapshot
          </button>
        </div>

        <div className="compare-pick">
          <label>
            <span>Base</span>
            <select value={aId} onChange={(e) => setAId(e.target.value)} disabled={busy}>
              {options.length === 0 && <option value="">No snapshots yet</option>}
              {options.map((o) => <option key={`a-${o.value}`} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <Icon name="chevron-right" size={14} className="compare-arrow" />
          <label>
            <span>Compare to</span>
            <select value={bId} onChange={(e) => setBId(e.target.value)} disabled={busy}>
              {options.length === 0 && <option value="">No snapshots yet</option>}
              {options.map((o) => <option key={`b-${o.value}`} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <button className="compare-btn primary" onClick={() => void handleCompare()} disabled={busy || !aId || !bId}>
            {busy ? "Comparing…" : "Compare"}
          </button>
        </div>
      </div>

      {error && <div className="compare-error">{error}</div>}

      {snapshots.length > 0 && (
        <details className="compare-manage">
          <summary>{snapshots.length} saved snapshot{snapshots.length === 1 ? "" : "s"}</summary>
          <ul className="compare-snap-list">
            {snapshots.map((s) => (
              <li key={s.id}>
                <span className="compare-snap-meta" title={s.rootPath}>{snapshotLabel(s)}</span>
                <button className="compare-snap-del" title="Delete snapshot" onClick={() => void handleDelete(s.id)}>
                  <Icon name="trash" size={12} />
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {diff && <DiffView diff={diff} onRevealRow={revealRow} canReveal={(p) => pathToId.has(p.toLowerCase())} />}

      {!diff && !busy && (
        <EmptyState
          icon="clock-history"
          title="Compare disk usage over time"
          hint={options.length === 0
            ? "Save a snapshot of the current scan, then come back later to see what grew."
            : "Pick a base and a comparison, then press Compare to see what grew or shrank."}
        />
      )}
    </div>
  );
}

function DiffView({
  diff,
  onRevealRow,
  canReveal,
}: {
  diff: DiffResult;
  onRevealRow: (row: DiffRow) => void;
  canReveal: (path: string) => boolean;
}) {
  const { summary } = diff;
  const rows = diff.rows;

  // Virtualize the diff rows the same way TreeTable / DuplicatesResults do
  // (@tanstack/react-virtual): the scroll element is the .compare-body, and only
  // the visible window of rows is mounted. A capped diff can still hold thousands
  // of rows, so this keeps the Compare report responsive instead of rendering all.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => DIFF_ROW_HEIGHT,
    overscan: 20,
  });

  return (
    <div className="compare-results">
      <div className="compare-summary">
        <span className="compare-net" title="Net change in total size">
          Net {formatDelta(summary.netDelta)}
        </span>
        <span>{formatBytes(summary.oldTotal)} → {formatBytes(summary.newTotal)}</span>
        <span className="compare-chip grown">{summary.grown} grew</span>
        <span className="compare-chip shrunk">{summary.shrunk} shrank</span>
        <span className="compare-chip added">{summary.added} added</span>
        <span className="compare-chip removed">{summary.removed} removed</span>
        {summary.capped && (
          <span className="compare-capped" title={`Showing the ${rows.length} largest of ${summary.rowCount} changes`}>
            top {rows.length} of {summary.rowCount}
          </span>
        )}
      </div>

      <div className="compare-table">
        <div className="compare-row compare-head">
          <span className="c-name">Name</span>
          <span className="c-status">Change</span>
          <span className="c-num">Before</span>
          <span className="c-num">After</span>
          <span className="c-num">Delta</span>
          <span className="c-num">%</span>
        </div>
        <div className="compare-body" ref={setScrollEl}>
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((vItem) => {
              const row = rows[vItem.index];
              if (!row) return null;
              const revealable = canReveal(row.path);
              return (
                <div
                  key={`${row.path}-${vItem.index}`}
                  className={`compare-row${revealable ? " revealable" : ""}`}
                  style={{ position: "absolute", top: vItem.start, left: 0, right: 0, height: DIFF_ROW_HEIGHT }}
                  title={revealable ? `${row.path}\nClick to reveal in the tree` : row.path}
                  onClick={() => { if (revealable) onRevealRow(row); }}
                >
                  <span className="c-name">
                    <span className={`compare-kind ${row.dir ? "dir" : "file"}`} />
                    {row.name}
                  </span>
                  <span className="c-status">
                    <span className={`compare-badge ${row.status}`}>{row.status}</span>
                  </span>
                  <span className="c-num">{row.oldSize ? formatBytes(row.oldSize) : "—"}</span>
                  <span className="c-num">{row.newSize ? formatBytes(row.newSize) : "—"}</span>
                  <span className={`c-num ${row.delta >= 0 ? "pos" : "neg"}`}>{formatDelta(row.delta)}</span>
                  <span className={`c-num ${row.delta >= 0 ? "pos" : "neg"}`}>{formatPct(row)}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
