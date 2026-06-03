import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { CleanupCategory, CleanupItem, CleanupScanResult } from "../api/types";
import { fetchCleanupScan, recycleItems, revealPath } from "../api/client";
import { formatBytes } from "../utils/formatBytes";
import { formatDate } from "../utils/formatDate";
import { confirmDialog } from "../lib/dialogs";
import { toast } from "../lib/toast";
import { Icon } from "./Icon";
import { EmptyState } from "./EmptyState";

// Disk Cleanup / Reclaim Space assistant (roadmap #1). A read-only
// /api/cleanup-scan buckets reclaimable space under the current scan root by
// category (temp, caches, build artifacts, recycle bin, old large downloads,
// confirmed duplicate sets). The user multi-selects whole categories or
// individual items and moves the selection to the Recycle Bin (/api/recycle-items).
//
// Categories + their items are flattened into one virtualized list (the same
// pattern as DuplicatesResults) so a category with thousands of temp files
// stays responsive instead of mounting every row.

type ScanState = "idle" | "scanning" | "done" | "error";

const CAT_ROW_H = 48;
const ITEM_ROW_H = 26;

type FlatRow =
  | { kind: "cat"; key: string; cat: CleanupCategory }
  | { kind: "item"; key: string; cat: CleanupCategory; item: CleanupItem };

interface CleanupViewProps {
  /** Current scan root the cleanup scan buckets reclaimable space under. */
  scanPath: string;
}

export function CleanupView({ scanPath }: CleanupViewProps) {
  const [result, setResult] = useState<CleanupScanResult | null>(null);
  const [scanState, setScanState] = useState<ScanState>("idle");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const runScan = useCallback(async () => {
    abortRef.current?.abort();
    if (!scanPath) { setScanState("idle"); setResult(null); return; }
    const ac = new AbortController();
    abortRef.current = ac;
    setScanState("scanning");
    setError("");
    try {
      const res = await fetchCleanupScan(scanPath, ac.signal);
      if (ac.signal.aborted) return;
      const categories = (res.categories ?? []).filter((c) => c.total > 0 || c.count > 0);
      setResult({ categories });
      setSelected(new Set());
      setScanState("done");
    } catch (e) {
      if (ac.signal.aborted) return;
      setError(e instanceof Error ? e.message : String(e));
      setScanState("error");
    }
  }, [scanPath]);

  // Auto-scan when the scan root changes; abort an in-flight scan on unmount.
  useEffect(() => {
    void runScan();
    return () => abortRef.current?.abort();
  }, [runScan]);

  const categories = useMemo(() => result?.categories ?? [], [result]);

  const totalReclaimable = useMemo(
    () => categories.reduce((s, c) => s + c.total, 0),
    [categories],
  );

  // Path → size index across every category (selection-size math).
  const sizeByPath = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of categories) for (const it of c.items) m.set(it.path, it.size);
    return m;
  }, [categories]);

  const selectedBytes = useMemo(() => {
    let total = 0;
    for (const p of selected) total += sizeByPath.get(p) ?? 0;
    return total;
  }, [selected, sizeByPath]);

  const rows = useMemo(() => {
    const out: FlatRow[] = [];
    for (const cat of categories) {
      out.push({ kind: "cat", key: cat.id, cat });
      if (collapsed.has(cat.id)) continue;
      for (const item of cat.items) {
        out.push({ kind: "item", key: `${cat.id}|${item.path}`, cat, item });
      }
    }
    return out;
  }, [categories, collapsed]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollEl,
    estimateSize: (i) => (rows[i]?.kind === "cat" ? CAT_ROW_H : ITEM_ROW_H),
    overscan: 12,
  });

  const toggleItem = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }, []);

  const toggleCategory = useCallback((cat: CleanupCategory) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const allOn = cat.items.length > 0 && cat.items.every((it) => next.has(it.path));
      if (allOn) for (const it of cat.items) next.delete(it.path);
      else for (const it of cat.items) next.add(it.path);
      return next;
    });
  }, []);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const handleRecycle = useCallback(async () => {
    const paths = Array.from(selected);
    if (paths.length === 0) return;
    const ok = await confirmDialog({
      title: "Move to Recycle Bin",
      message: `Move ${paths.length.toLocaleString()} item${paths.length === 1 ? "" : "s"} (${formatBytes(selectedBytes)}) to the Recycle Bin? You can restore them from there if needed.`,
      confirmLabel: "Move to Recycle Bin",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await recycleItems(paths);
      if (res.ok) {
        toast.success(`Moved ${paths.length.toLocaleString()} item${paths.length === 1 ? "" : "s"} to the Recycle Bin.`);
        await runScan();
      } else {
        toast.error(res.error ?? "Failed to move items to the Recycle Bin.");
      }
    } finally {
      setBusy(false);
    }
  }, [selected, selectedBytes, runScan]);

  if (!scanPath) {
    return (
      <div className="cleanup-view">
        <EmptyState
          icon="trash"
          title="No scan loaded"
          hint="Scan a folder or drive in the Explorer side bar, then return here to find reclaimable space."
        />
      </div>
    );
  }

  const showList = scanState === "done" && rows.length > 0;

  return (
    <div className="cleanup-view">
      <div className="cleanup-toolbar">
        <div className="cleanup-summary">
          <span className="cleanup-total">{formatBytes(totalReclaimable)}</span>
          <span className="cleanup-total-label">reclaimable</span>
          {selected.size > 0 && (
            <span className="cleanup-selected">
              {formatBytes(selectedBytes)} selected · {selected.size.toLocaleString()} item{selected.size === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <div className="cleanup-toolbar-spacer" />
        <button
          className="cleanup-btn"
          onClick={() => void runScan()}
          disabled={scanState === "scanning"}
          title="Re-scan for reclaimable space"
        >
          <Icon name="refresh" size={13} /> {scanState === "scanning" ? "Scanning…" : "Rescan"}
        </button>
        <button
          className="cleanup-btn danger"
          onClick={() => void handleRecycle()}
          disabled={selected.size === 0 || busy}
        >
          <Icon name="trash" size={13} /> Move selected to Recycle Bin
        </button>
      </div>

      <div className="cleanup-body" ref={setScrollEl}>
        {scanState === "scanning" && rows.length === 0 && (
          <div className="cleanup-loading">
            <div className="cleanup-spinner" />
            <span>Scanning <code>{scanPath}</code> for reclaimable space…</span>
          </div>
        )}
        {scanState === "error" && (
          <EmptyState icon="warning" title="Cleanup scan failed" hint={error || "Could not scan for reclaimable space."} error />
        )}
        {scanState === "done" && rows.length === 0 && (
          <EmptyState icon="check" title="Nothing to clean up" hint="No reclaimable space was found under this folder." />
        )}

        {showList && (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const row = rows[vi.index];
              if (!row) return null;
              const common = {
                position: "absolute" as const,
                top: vi.start,
                left: 0,
                right: 0,
                height: vi.size,
              };
              if (row.kind === "cat") {
                const cat = row.cat;
                const allOn = cat.items.length > 0 && cat.items.every((it) => selected.has(it.path));
                const someOn = !allOn && cat.items.some((it) => selected.has(it.path));
                const isCollapsed = collapsed.has(cat.id);
                return (
                  <div key={row.key} className="cleanup-cat-row" style={common}>
                    <button className="cleanup-twisty" onClick={() => toggleCollapse(cat.id)} title={isCollapsed ? "Expand" : "Collapse"}>
                      <Icon name={isCollapsed ? "chevron-right" : "chevron-down"} size={11} />
                    </button>
                    <input
                      type="checkbox"
                      className="cleanup-check"
                      checked={allOn}
                      ref={(el) => { if (el) el.indeterminate = someOn; }}
                      onChange={() => toggleCategory(cat)}
                      disabled={cat.items.length === 0}
                      title="Select / clear this category"
                    />
                    <div className="cleanup-cat-text" onClick={() => toggleCollapse(cat.id)}>
                      <div className="cleanup-cat-label">
                        {cat.label}
                        <span className="cleanup-cat-count">{cat.count.toLocaleString()} item{cat.count === 1 ? "" : "s"}</span>
                      </div>
                      {cat.description && <div className="cleanup-cat-desc" title={cat.description}>{cat.description}</div>}
                    </div>
                    <span className="cleanup-cat-size">{formatBytes(cat.total)}</span>
                  </div>
                );
              }
              const { item } = row;
              const isChecked = selected.has(item.path);
              return (
                <div
                  key={row.key}
                  className={`cleanup-item-row${isChecked ? " on" : ""}`}
                  style={common}
                  onContextMenu={(e) => { e.preventDefault(); void revealPath(item.path); }}
                >
                  <input type="checkbox" className="cleanup-check" checked={isChecked} onChange={() => toggleItem(item.path)} />
                  <span className="cleanup-item-path" title={item.path} onDoubleClick={() => void revealPath(item.path)}>{item.path}</span>
                  <span className="cleanup-item-date">{item.modified ? formatDate(item.modified * 1000) : "—"}</span>
                  <span className="cleanup-item-size">{formatBytes(item.size)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
