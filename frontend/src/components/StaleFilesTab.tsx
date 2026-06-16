import { useCallback, useMemo, useState } from "react";
import type { NodeRecord } from "../api/types";
import { recycleItems, revealPath } from "../api/client";
import { formatBytes } from "../utils/formatBytes";
import { formatDate } from "../utils/formatDate";
import { confirmDialog } from "../lib/dialogs";
import { toast } from "../lib/toast";
import { Icon } from "./Icon";
import { EmptyState } from "./EmptyState";
import { FileIcon } from "./FileIcon";

// #29 Stale-files report: files that are large AND old, derived from the scan
// tree (`nodeById`). "Old" uses the file's access time when the scan captured
// one (accessed > 0), otherwise its modified time (noted in the UI). Thresholds
// for size + age are adjustable; rows are sortable and can be revealed or moved
// to the Recycle Bin via the existing recycle API.

const DAY_MS = 86_400_000;

interface StaleFilesTabProps {
  nodeById: Map<number, NodeRecord>;
  onNavigate: (id: number) => void;
}

type SortKey = "size" | "age";

function ageTimeOf(n: NodeRecord): { ms: number; usedAccessed: boolean } {
  if (n.accessed > 0) return { ms: n.accessed, usedAccessed: true };
  return { ms: n.modified, usedAccessed: false };
}

export function StaleFilesTab({ nodeById, onNavigate }: StaleFilesTabProps) {
  const [minSizeMb, setMinSizeMb] = useState(100);
  const [minAgeDays, setMinAgeDays] = useState(365);
  const [sortKey, setSortKey] = useState<SortKey>("size");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const now = Date.now();
  const minBytes = minSizeMb * 1024 * 1024;
  const minAgeMs = minAgeDays * DAY_MS;

  const rows = useMemo(() => {
    const out: NodeRecord[] = [];
    for (const n of nodeById.values()) {
      if (n.dir || n.link) continue;
      if (removed.has(n.path)) continue;
      if (n.size < minBytes) continue;
      const { ms } = ageTimeOf(n);
      if (!ms || now - ms < minAgeMs) continue;
      out.push(n);
    }
    out.sort((a, b) => {
      const av = sortKey === "size" ? a.size : ageTimeOf(a).ms;
      const bv = sortKey === "size" ? b.size : ageTimeOf(b).ms;
      // For "age", smaller timestamp = older; flip so sortDir reads intuitively.
      const cmp = sortKey === "size" ? av - bv : bv - av;
      return cmp * sortDir;
    });
    return out.slice(0, 2000);
  }, [nodeById, removed, minBytes, minAgeMs, now, sortKey, sortDir]);

  const usesAccessed = useMemo(() => {
    for (const n of nodeById.values()) { if (!n.dir && n.accessed > 0) return true; }
    return false;
  }, [nodeById]);

  const totalBytes = useMemo(() => rows.reduce((s, n) => s + n.size, 0), [rows]);
  const allSelected = rows.length > 0 && rows.every((n) => selected.has(n.path));
  const someSelected = !allSelected && rows.some((n) => selected.has(n.path));

  const onSort = useCallback((key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(key); setSortDir(-1); }
  }, [sortKey]);

  const toggle = useCallback((path: string) => {
    setSelected((prev) => { const next = new Set(prev); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  }, []);
  const toggleAll = useCallback(() => {
    setSelected((prev) => (prev.size === rows.length ? new Set() : new Set(rows.map((n) => n.path))));
  }, [rows]);

  const handleRecycle = useCallback(async () => {
    const paths = rows.filter((n) => selected.has(n.path)).map((n) => n.path);
    if (paths.length === 0) return;
    const bytes = rows.filter((n) => selected.has(n.path)).reduce((s, n) => s + n.size, 0);
    const ok = await confirmDialog({
      title: "Move stale files to Recycle Bin",
      message: `Move ${paths.length.toLocaleString()} file${paths.length === 1 ? "" : "s"} (${formatBytes(bytes)}) to the Recycle Bin? You can restore them from there if needed.`,
      confirmLabel: "Move to Recycle Bin",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await recycleItems(paths);
      if (res.ok) toast.success(`Moved ${paths.length.toLocaleString()} file${paths.length === 1 ? "" : "s"} to the Recycle Bin.`);
      else toast.error(res.error ?? "Some files could not be moved.");
      setRemoved((prev) => { const next = new Set(prev); for (const p of paths) next.add(p); return next; });
      setSelected(new Set());
    } finally {
      setBusy(false);
    }
  }, [rows, selected]);

  return (
    <div className="rep-panel">
      <div className="rep-panel-toolbar">
        <label className="rep-thresh">Min size
          <input type="number" min={0} value={minSizeMb} onChange={(e) => setMinSizeMb(Math.max(0, Number(e.target.value)))} />
          <span className="rep-unit">MB</span>
        </label>
        <label className="rep-thresh">Older than
          <input type="number" min={0} value={minAgeDays} onChange={(e) => setMinAgeDays(Math.max(0, Number(e.target.value)))} />
          <span className="rep-unit">days</span>
        </label>
        <span className="rep-panel-summary">
          {rows.length.toLocaleString()} file{rows.length === 1 ? "" : "s"} · {formatBytes(totalBytes)} · by {usesAccessed ? "last access" : "modified (no access time)"}
        </span>
        <div className="rep-panel-spacer" />
        <button className="cleanup-btn danger" onClick={() => void handleRecycle()} disabled={selected.size === 0 || busy}>
          <Icon name="trash" size={13} /> Remove to Recycle Bin ({selected.size})
        </button>
      </div>

      {rows.length === 0 ? (
        <EmptyState icon="check" title="No stale files" hint="No files matched the current size and age thresholds. Lower them to widen the search." />
      ) : (
        <div className="rep-table rep-stale">
          <div className="rep-row rep-head">
            <span className="rep-check">
              <input type="checkbox" checked={allSelected} ref={(el) => { if (el) el.indeterminate = someSelected; }} onChange={toggleAll} />
            </span>
            <span className="rep-col-name">Name</span>
            <span className="rep-col-size rep-sortable" onClick={() => onSort("size")}>
              Size {sortKey === "size" && <Icon name={sortDir === 1 ? "caret-up" : "caret-down"} size={9} />}
            </span>
            <span className="rep-col-date rep-sortable" onClick={() => onSort("age")}>
              {usesAccessed ? "Accessed" : "Modified"} {sortKey === "age" && <Icon name={sortDir === 1 ? "caret-up" : "caret-down"} size={9} />}
            </span>
            <span className="rep-col-path">Path</span>
          </div>
          {rows.map((n) => {
            const { ms } = ageTimeOf(n);
            return (
              <div key={n.path} className={`rep-row${selected.has(n.path) ? " on" : ""}`}>
                <span className="rep-check">
                  <input type="checkbox" checked={selected.has(n.path)} onChange={() => toggle(n.path)} />
                </span>
                <span className="rep-col-name" title={n.path} onDoubleClick={() => onNavigate(n.id)}>
                  <FileIcon ext={n.extension ?? ""} isDir={false} isBundle={false} /> {n.name}
                </span>
                <span className="rep-col-size">{formatBytes(n.size)}</span>
                <span className="rep-col-date">{formatDate(ms)}</span>
                <span className="rep-col-path" title={n.path} onContextMenu={(e) => { e.preventDefault(); void revealPath(n.path); }}>{n.path}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
