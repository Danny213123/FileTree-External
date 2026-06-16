// Move-to / Copy-to destination picker (#42).
//
// Enhances the old plain text prompt with:
//   • a list of RECENT destination folders (persisted in localStorage) for
//     one-click choosing, and
//   • a "New folder…" affordance that creates a subfolder under the typed
//     destination (reusing the existing create-folder API) and targets it,
//     without leaving the dialog.
//
// Resolves to the chosen absolute destination path, or null on cancel.

import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

interface MoveToDialogProps {
  title: string;
  confirmLabel: string;
  /** Pre-fill the destination field (e.g. the current scan root). */
  initialPath?: string;
  /** Recent destinations, newest first. */
  recents: string[];
  /** Create `name` under `parent`; resolves the created path or an error. */
  onCreateFolder: (parent: string, name: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
  /** Forget a recent destination (the per-row ✕). */
  onRemoveRecent: (path: string) => void;
  onConfirm: (destination: string) => void;
  onCancel: () => void;
}

function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export function MoveToDialog({
  title,
  confirmLabel,
  initialPath,
  recents,
  onCreateFolder,
  onRemoveRecent,
  onConfirm,
  onCancel,
}: MoveToDialogProps) {
  const [path, setPath] = useState(initialPath ?? "");
  const [recentList, setRecentList] = useState(recents);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const newNameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);
  useEffect(() => { if (creating) newNameRef.current?.focus(); }, [creating]);

  const canSubmit = path.trim() !== "" && !busy;

  const submit = () => {
    if (!canSubmit) return;
    onConfirm(path.trim());
  };

  const handleCreateFolder = async () => {
    const parent = path.trim();
    const name = newName.trim();
    if (!parent) { setError("Enter a destination folder first."); return; }
    if (!name) { setError("Enter a name for the new folder."); return; }
    if (/[\\/:*?"<>|]/.test(name)) { setError("Illegal character in folder name."); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await onCreateFolder(parent, name);
      if (!res.ok) { setError(res.error ?? "Could not create the folder."); return; }
      const created = res.path ?? joinPath(parent, name);
      setPath(created);
      setCreating(false);
      setNewName("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="filter-dialog-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="prompt-dialog moveto-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="fd-header">
          <span className="fd-title">{title}</span>
        </div>
        <div className="cd-body">
          <div className="prompt-field">
            <label className="prompt-label">Destination folder</label>
            <input
              ref={inputRef}
              className="prompt-input"
              type="text"
              value={path}
              placeholder="C:\\path\\to\\folder"
              onChange={(e) => { setPath(e.target.value); setError(null); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !creating) { e.preventDefault(); submit(); }
                else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
              }}
            />
          </div>

          {creating ? (
            <div className="moveto-newfolder">
              <input
                ref={newNameRef}
                className="prompt-input"
                type="text"
                value={newName}
                placeholder="New folder name"
                onChange={(e) => { setNewName(e.target.value); setError(null); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); void handleCreateFolder(); }
                  else if (e.key === "Escape") { e.preventDefault(); setCreating(false); setNewName(""); setError(null); }
                }}
              />
              <button className="fd-ok" disabled={busy} onClick={() => void handleCreateFolder()}>Create</button>
              <button className="fd-cancel" onClick={() => { setCreating(false); setNewName(""); setError(null); }}>Cancel</button>
            </div>
          ) : (
            <button className="moveto-newfolder-btn" onClick={() => setCreating(true)} disabled={path.trim() === ""}>
              <Icon name="folder-plus" size={13} /> New folder…
            </button>
          )}

          {error && <span className="prompt-error">{error}</span>}

          {recentList.length > 0 && (
            <div className="moveto-recents">
              <div className="moveto-recents-head">Recent destinations</div>
              <ul className="moveto-recents-list">
                {recentList.map((r) => (
                  <li key={r} className={r === path ? "selected" : ""}>
                    <button
                      className="moveto-recent"
                      title={r}
                      onClick={() => setPath(r)}
                      onDoubleClick={() => onConfirm(r)}
                    >
                      <Icon name="folder" size={13} />
                      <span className="moveto-recent-name">{baseName(r)}</span>
                      <span className="moveto-recent-path">{r}</span>
                    </button>
                    <button
                      className="moveto-recent-remove"
                      title="Remove from recents"
                      onClick={() => { onRemoveRecent(r); setRecentList((list) => list.filter((p) => p !== r)); }}
                    >
                      <Icon name="x" size={11} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="fd-footer">
          <button className="fd-ok primary" onClick={submit} disabled={!canSubmit}>{confirmLabel}</button>
          <button className="fd-cancel" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function joinPath(parent: string, name: string): string {
  const sep = parent.includes("/") && !parent.includes("\\") ? "/" : "\\";
  return `${parent.replace(/[\\/]+$/, "")}${sep}${name}`;
}
