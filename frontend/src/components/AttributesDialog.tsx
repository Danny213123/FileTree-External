// Batch attribute + timestamp editor (#43).
//
// Edits metadata for the current selection: toggle the read-only / hidden
// attributes (tri-state: leave unchanged / set / clear) and set the
// created / modified / accessed timestamps. Nothing is changed unless the user
// explicitly opts a field in, and the footer states "applies to N items" with a
// confirm — these touch real files, so the default for every control is "no
// change".

import { useMemo, useState } from "react";
import type { NodeRecord } from "../api/types";

export type AttrChange = "keep" | "set" | "clear";

export interface AttributesPayload {
  attrs: { readonly?: boolean; hidden?: boolean };
  times: { created?: number; modified?: number; accessed?: number };
}

interface AttributesDialogProps {
  nodes: NodeRecord[];
  /** Apply the change. Resolves with overall ok + an error summary. */
  onApply: (payload: AttributesPayload) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
}

/** epoch ms → "YYYY-MM-DDTHH:mm" in LOCAL time for an <input type=datetime-local>. */
function toLocalInput(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

/** "YYYY-MM-DDTHH:mm" (local) → epoch ms. Returns null when unparseable. */
function fromLocalInput(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function TriState({ label, value, onChange }: { label: string; value: AttrChange; onChange: (v: AttrChange) => void }) {
  return (
    <div className="attr-row">
      <span className="attr-label">{label}</span>
      <select className="attr-select" value={value} onChange={(e) => onChange(e.target.value as AttrChange)}>
        <option value="keep">Leave unchanged</option>
        <option value="set">Set</option>
        <option value="clear">Clear</option>
      </select>
    </div>
  );
}

function TimeRow({
  label, enabled, onToggle, value, onValueChange,
}: {
  label: string; enabled: boolean; onToggle: (v: boolean) => void;
  value: string; onValueChange: (v: string) => void;
}) {
  return (
    <div className="attr-row">
      <label className="attr-label attr-check">
        <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
        <span>{label}</span>
      </label>
      <input
        className="attr-datetime"
        type="datetime-local"
        value={value}
        disabled={!enabled}
        onChange={(e) => onValueChange(e.target.value)}
      />
    </div>
  );
}

export function AttributesDialog({ nodes, onApply, onClose }: AttributesDialogProps) {
  const count = nodes.length;
  const first = nodes[0];

  const [readonly, setReadonly] = useState<AttrChange>("keep");
  const [hidden, setHidden] = useState<AttrChange>("keep");

  const [setMod, setSetMod] = useState(false);
  const [modVal, setModVal] = useState(() => toLocalInput(first?.modified ?? Date.now()));
  const [setCreated, setSetCreated] = useState(false);
  const [createdVal, setCreatedVal] = useState(() => toLocalInput(first?.created ?? Date.now()));
  const [setAccessed, setSetAccessed] = useState(false);
  const [accessedVal, setAccessedVal] = useState(() => toLocalInput(first?.accessed ?? Date.now()));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasChange = useMemo(
    () => readonly !== "keep" || hidden !== "keep" || setMod || setCreated || setAccessed,
    [readonly, hidden, setMod, setCreated, setAccessed],
  );

  const apply = async () => {
    if (!hasChange || busy) return;
    const attrs: AttributesPayload["attrs"] = {};
    if (readonly !== "keep") attrs.readonly = readonly === "set";
    if (hidden !== "keep") attrs.hidden = hidden === "set";
    const times: AttributesPayload["times"] = {};
    if (setMod) {
      const ms = fromLocalInput(modVal);
      if (ms == null) { setError("Enter a valid modified date."); return; }
      times.modified = ms;
    }
    if (setCreated) {
      const ms = fromLocalInput(createdVal);
      if (ms == null) { setError("Enter a valid created date."); return; }
      times.created = ms;
    }
    if (setAccessed) {
      const ms = fromLocalInput(accessedVal);
      if (ms == null) { setError("Enter a valid accessed date."); return; }
      times.accessed = ms;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await onApply({ attrs, times });
      if (!res.ok) { setError(res.error ?? "Some items could not be updated."); return; }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="filter-dialog-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="prompt-dialog attr-dialog" role="dialog" aria-modal="true" aria-label="Edit attributes and timestamps">
        <div className="fd-header">
          <span className="fd-title">Edit attributes &amp; timestamps</span>
        </div>
        <div className="cd-body">
          <p className="cd-msg">
            Applies to <strong>{count}</strong> {count === 1 ? "item" : "items"}
            {count === 1 && first ? ` — ${first.name}` : ""}.
          </p>

          <div className="attr-section">
            <div className="attr-section-head">Attributes</div>
            <TriState label="Read-only" value={readonly} onChange={setReadonly} />
            <TriState label="Hidden" value={hidden} onChange={setHidden} />
          </div>

          <div className="attr-section">
            <div className="attr-section-head">Timestamps</div>
            <TimeRow label="Modified" enabled={setMod} onToggle={setSetMod} value={modVal} onValueChange={setModVal} />
            <TimeRow label="Created" enabled={setCreated} onToggle={setSetCreated} value={createdVal} onValueChange={setCreatedVal} />
            <TimeRow label="Accessed" enabled={setAccessed} onToggle={setSetAccessed} value={accessedVal} onValueChange={setAccessedVal} />
          </div>

          {error && <span className="prompt-error">{error}</span>}
        </div>
        <div className="fd-footer">
          <button className="fd-ok primary" onClick={() => void apply()} disabled={!hasChange || busy}>
            {busy ? "Applying…" : `Apply to ${count} ${count === 1 ? "item" : "items"}`}
          </button>
          <button className="fd-cancel" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
