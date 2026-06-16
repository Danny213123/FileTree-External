import { useCallback, useEffect, useState } from "react";
import { fetchRecycledLog, hasRecycleRestore, restoreFromRecycleBin, type RecycledItem } from "../api/client";
import { toast } from "../lib/toast";
import { Icon } from "./Icon";
import { EmptyState } from "./EmptyState";

// #30 In-app Recycle Bin viewer + restore.
//
// IMPLEMENTED (safe subset): lists the items FileTree itself sent to the Recycle
// Bin, read from the append-only audit log (`/api/audit-recycled`), newest-first.
// Restore reuses the existing native Recycle Bin restore path (the same one
// Ctrl+Z uses for a recycle undo), which locates the item in the bin and moves
// it back to its original path.
//
// FLAGGED / deferred: full enumeration of the entire Windows Recycle Bin (across
// all apps, via the Shell API) is the ideal but riskier addition and is NOT done
// here — this lists only what FileTree recycled. Permanent-delete-from-bin is
// likewise left to Windows (Empty Recycle Bin) to avoid a destructive new path.

function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function formatTs(ts: string): string {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? ts : d.toLocaleString();
}

export function RecycleBinTab() {
  const [items, setItems] = useState<RecycledItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [restored, setRestored] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const canRestore = hasRecycleRestore();

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    const list = await fetchRecycledLog(signal);
    if (signal?.aborted) return;
    setItems(list);
    setLoading(false);
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const handleRestore = useCallback(async (path: string) => {
    if (!canRestore) {
      toast.warn("Restore isn't available here — restore manually from the Windows Recycle Bin.");
      return;
    }
    setBusy(true);
    try {
      const ok = await restoreFromRecycleBin(path);
      if (ok) {
        toast.success(`Restored "${baseName(path)}" to its original location.`);
        setRestored((prev) => { const next = new Set(prev); next.add(path); return next; });
      } else {
        toast.error(`Couldn't restore "${baseName(path)}" — restore it manually from the Recycle Bin.`);
      }
    } finally {
      setBusy(false);
    }
  }, [canRestore]);

  return (
    <div className="rep-panel">
      <div className="rep-panel-toolbar">
        <span className="rep-panel-summary">
          {loading ? "Loading…" : `${items.length.toLocaleString()} item${items.length === 1 ? "" : "s"} FileTree recycled`}
        </span>
        <div className="rep-panel-spacer" />
        <button className="cleanup-btn" onClick={() => void load()} disabled={loading}>
          <Icon name="refresh" size={13} /> Refresh
        </button>
      </div>

      {!canRestore && (
        <div className="rep-note">
          In-place restore needs the FileTree desktop app. You can still see what was recycled here; restore items from the Windows Recycle Bin.
        </div>
      )}

      {!loading && items.length === 0 ? (
        <EmptyState icon="trash" title="Nothing recycled yet" hint="Items you delete to the Recycle Bin from FileTree appear here, newest first, ready to restore." />
      ) : (
        <div className="rep-table rep-rb">
          <div className="rep-row rep-head">
            <span className="rep-col-name">Name</span>
            <span className="rep-col-date">Recycled</span>
            <span className="rep-col-path">Original path</span>
            <span className="rep-col-act" />
          </div>
          {items.map((it, i) => {
            const done = restored.has(it.path);
            return (
              <div key={`${it.path}|${i}`} className={`rep-row${done ? " rep-done" : ""}`}>
                <span className="rep-col-name" title={it.path}>
                  <Icon name="trash" size={12} /> {baseName(it.path)}
                </span>
                <span className="rep-col-date">{formatTs(it.ts)}</span>
                <span className="rep-col-path" title={it.path}>{it.path}</span>
                <span className="rep-col-act">
                  {done ? (
                    <span className="rep-restored">Restored</span>
                  ) : (
                    <button
                      className="rep-restore-btn"
                      onClick={() => void handleRestore(it.path)}
                      disabled={busy || !canRestore}
                      title="Restore to original location"
                    >
                      <Icon name="arrow-counterclockwise" size={12} /> Restore
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
