// Keyboard shortcuts editor (#47).
//
// Lists every rebindable command with its current chord, lets the user record a
// new chord (capturing the next keydown), warns on conflicts, and supports
// reset-to-default per row and for all. Edits are applied to a working copy and
// committed via `onApply` (which persists + rebinds the live handler).

import { useEffect, useMemo, useState } from "react";
import { Icon } from "./Icon";
import {
  SHORTCUT_COMMANDS,
  type ShortcutBindings,
  getChord,
  formatChord,
  findConflicts,
  chordFromEvent,
} from "../lib/shortcuts";

interface ShortcutsDialogProps {
  bindings: ShortcutBindings;
  onApply: (bindings: ShortcutBindings) => void;
  onClose: () => void;
}

export function ShortcutsDialog({ bindings, onApply, onClose }: ShortcutsDialogProps) {
  const [draft, setDraft] = useState<ShortcutBindings>(() => ({ ...bindings }));
  const [recordingId, setRecordingId] = useState<string | null>(null);

  // While recording, capture the next non-modifier keydown as the new chord.
  useEffect(() => {
    if (!recordingId) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { setRecordingId(null); return; }
      const chord = chordFromEvent(e);
      if (!chord) return; // modifier alone — keep waiting
      setDraft((prev) => {
        const cmd = SHORTCUT_COMMANDS.find((c) => c.id === recordingId);
        const next = { ...prev };
        if (cmd && chord === cmd.defaultChord) delete next[recordingId];
        else next[recordingId] = chord;
        return next;
      });
      setRecordingId(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recordingId]);

  // Dismiss on Escape (when not recording).
  useEffect(() => {
    if (recordingId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recordingId, onClose]);

  const grouped = useMemo(() => {
    const m = new Map<string, typeof SHORTCUT_COMMANDS>();
    for (const cmd of SHORTCUT_COMMANDS) {
      const arr = m.get(cmd.category) ?? [];
      arr.push(cmd);
      m.set(cmd.category, arr);
    }
    return Array.from(m.entries());
  }, []);

  const resetOne = (id: string) => {
    setDraft((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };
  const resetAll = () => setDraft({});

  const apply = () => { onApply(draft); onClose(); };

  return (
    <div className="filter-dialog-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="shortcuts-dialog" role="dialog" aria-modal="true" aria-label="Keyboard Shortcuts">
        <div className="fd-header">
          <span className="fd-title">Keyboard Shortcuts</span>
          <button className="fd-close" aria-label="Close" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div className="shortcuts-body">
          {grouped.map(([category, cmds]) => (
            <div key={category} className="shortcuts-group">
              <div className="shortcuts-group-title">{category}</div>
              {cmds.map((cmd) => {
                const chord = getChord(cmd.id, draft);
                const recording = recordingId === cmd.id;
                const conflicts = findConflicts(chord, cmd.id, draft);
                const isCustom = !!draft[cmd.id];
                return (
                  <div key={cmd.id} className="shortcut-row">
                    <span className="shortcut-label">{cmd.label}</span>
                    {conflicts.length > 0 && !recording && (
                      <span className="shortcut-conflict" title={`Also used by: ${conflicts
                        .map((id) => SHORTCUT_COMMANDS.find((c) => c.id === id)?.label ?? id)
                        .join(", ")}`}>
                        <Icon name="warning" size={11} /> conflict
                      </span>
                    )}
                    <button
                      className={`shortcut-chord${recording ? " recording" : ""}${isCustom ? " custom" : ""}`}
                      onClick={() => setRecordingId(recording ? null : cmd.id)}
                      title="Click, then press a key combination"
                    >
                      {recording ? "Press keys…" : formatChord(chord)}
                    </button>
                    <button
                      className="shortcut-reset"
                      title="Reset to default"
                      disabled={!isCustom}
                      onClick={() => resetOne(cmd.id)}
                    >
                      <Icon name="arrow-repeat" size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="fd-footer">
          <button className="fd-ok primary" onClick={apply}>Apply</button>
          <button className="fd-cancel" onClick={resetAll}>Reset All</button>
          <button className="fd-cancel" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
