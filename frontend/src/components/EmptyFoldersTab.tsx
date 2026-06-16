import { useCallback, useMemo, useState } from "react";
import type { NodeRecord } from "../api/types";
import { recycleItems, revealPath } from "../api/client";
import { confirmDialog } from "../lib/dialogs";
import { toast } from "../lib/toast";
import { Icon } from "./Icon";
import { EmptyState } from "./EmptyState";

// #27 Empty-folder finder: folders with no files anywhere beneath them, derived
// entirely from the scan tree (`nodeById`). A folder is "empty" when its
// recursive file count is 0. The scan root is never flagged. Selected folders
// can be moved to the Recycle Bin, reusing the existing recycle API.

interface EmptyFoldersTabProps {
  nodeById: Map<number, NodeRecord>;
  onNavigate: (id: number) => void;
}

export function EmptyFoldersTab({ nodeById, onNavigate }: EmptyFoldersTabProps) {
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const empties = useMemo(() => {
    const out: NodeRecord[] = [];
    for (const n of nodeById.values()) {
      // Skip the scan root (no parent) so we never flag the whole scan, and any
      // node still on screen that was already recycled this session.
      if (!n.dir || n.link) continue;
      if (n.parent == null) continue;
      if (n.files !== 0) continue;
      if (removed.has(n.path)) continue;
      out.push(n);
    }
    // Deepest / longest paths first so a parent doesn't hide a nested empty.
    out.sort((a, b) => b.path.length - a.path.length);
    return out;
  }, [nodeById, removed]);

  const allSelected = empties.length > 0 && empties.every((n) => selected.has(n.path));
  const someSelected = !allSelected && empties.some((n) => selected.has(n.path));

  const toggle = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((prev) => (prev.size === empties.length ? new Set() : new Set(empties.map((n) => n.path))));
  }, [empties]);

  const handleRecycle = useCallback(async () => {
    const paths = empties.filter((n) => selected.has(n.path)).map((n) => n.path);
    if (paths.length === 0) return;
    const ok = await confirmDialog({
      title: "Move empty folders to Recycle Bin",
      message: `Move ${paths.length.toLocaleString()} empty folder${paths.length === 1 ? "" : "s"} to the Recycle Bin? You can restore them from there if needed.`,
      confirmLabel: "Move to Recycle Bin",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await recycleItems(paths);
      if (res.ok) {
        toast.success(`Moved ${paths.length.toLocaleString()} empty folder${paths.length === 1 ? "" : "s"} to the Recycle Bin.`);
      } else {
        toast.error(res.error ?? "Some folders could not be moved.");
      }
      // Drop everything we attempted from the list regardless (rescan to refresh).
      setRemoved((prev) => { const next = new Set(prev); for (const p of paths) next.add(p); return next; });
      setSelected(new Set());
    } finally {
      setBusy(false);
    }
  }, [empties, selected]);

  if (empties.length === 0) {
    return (
      <EmptyState
        icon="check"
        title="No empty folders"
        hint="Every folder under this scan contains at least one file. Empty folders found in a scan appear here."
      />
    );
  }

  return (
    <div className="rep-panel">
      <div className="rep-panel-toolbar">
        <span className="rep-panel-summary">{empties.length.toLocaleString()} empty folder{empties.length === 1 ? "" : "s"}</span>
        <div className="rep-panel-spacer" />
        <button
          className="cleanup-btn danger"
          onClick={() => void handleRecycle()}
          disabled={selected.size === 0 || busy}
        >
          <Icon name="trash" size={13} /> Remove to Recycle Bin ({selected.size})
        </button>
      </div>
      <div className="rep-table rep-ef">
        <div className="rep-row rep-head">
          <span className="rep-check">
            <input
              type="checkbox"
              checked={allSelected}
              ref={(el) => { if (el) el.indeterminate = someSelected; }}
              onChange={toggleAll}
            />
          </span>
          <span className="rep-col-name">Folder</span>
          <span className="rep-col-path">Path</span>
        </div>
        {empties.map((n) => (
          <div key={n.path} className={`rep-row${selected.has(n.path) ? " on" : ""}`}>
            <span className="rep-check">
              <input type="checkbox" checked={selected.has(n.path)} onChange={() => toggle(n.path)} />
            </span>
            <span className="rep-col-name" title={n.path} onDoubleClick={() => onNavigate(n.id)}>
              <Icon name="folder" size={12} /> {n.name}
            </span>
            <span className="rep-col-path" title={n.path} onContextMenu={(e) => { e.preventDefault(); void revealPath(n.path); }}>
              {n.path}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
