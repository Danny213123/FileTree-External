// Bulk rename dialog (F3).
//
// Opened from the workspace toolbar (or the Edit menu / command palette) when
// one or more rows are selected. Builds a new name for each selected item from
// a composable pipeline — find/replace (regex + $1 capture groups), case
// transform, a {date} token and sequential numbering (start/step/zero-pad) —
// and shows a LIVE before/after preview computed entirely client-side from the
// selected NodeRecords. Apply sends the batch to POST /api/bulk-rename via the
// bulkRename() client wrapper, surfaces per-op errors, pushes a single undo
// entry for the whole batch, and refreshes the tree.

import { useEffect, useMemo, useState } from "react";
import type { NodeRecord } from "../api/types";
import { bulkRename } from "../api/client";
import type { BulkRenameOp } from "../api/types";
import { pushUndo, parentDir } from "../lib/undo";
import { toast, type ToastAction } from "../lib/toast";
import { Icon } from "./Icon";

type CaseMode = "none" | "upper" | "lower" | "title";

export interface BulkRenameDialogProps {
  /** The selected items to rename (real files/folders; bundle nodes excluded). */
  nodes: NodeRecord[];
  onClose: () => void;
  /** Refresh the tree after a successful apply (the pane's rescan). */
  onApplied: () => void;
  /** Optional "Undo (Ctrl+Z)" action attached to the success toast. */
  undoAction?: ToastAction;
}

const ILLEGAL = /[\\/:*?"<>|]/;

function sepFor(p: string): string {
  return p.includes("\\") || !p.includes("/") ? "\\" : "/";
}

/** Split a name into [stem, ext] where ext includes the leading dot. Folders and
 *  "keep extension off" return the whole name as the stem. */
function splitNameExt(name: string, isDir: boolean, keepExt: boolean): [string, string] {
  if (isDir || !keepExt) return [name, ""];
  const dot = name.lastIndexOf(".");
  if (dot > 0) return [name.slice(0, dot), name.slice(dot)];
  return [name, ""];
}

function applyCase(s: string, mode: CaseMode): string {
  switch (mode) {
    case "upper": return s.toUpperCase();
    case "lower": return s.toLowerCase();
    case "title":
      return s.toLowerCase().replace(/(^|[\s\-_.()[\]]+)([a-z0-9])/g, (_, p: string, c: string) => p + c.toUpperCase());
    default: return s;
  }
}

function dateToken(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

interface PreviewRow {
  node: NodeRecord;
  oldName: string;
  newName: string;
  targetPath: string;
  changed: boolean;
  error?: string;
}

export function BulkRenameDialog({ nodes, onClose, onApplied, undoAction }: BulkRenameDialogProps) {
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [regex, setRegex] = useState(false);
  const [keepExt, setKeepExt] = useState(true);
  const [caseMode, setCaseMode] = useState<CaseMode>("none");
  const [numEnabled, setNumEnabled] = useState(false);
  const [start, setStart] = useState(1);
  const [step, setStep] = useState(1);
  const [pad, setPad] = useState(2);
  const [sep, setSep] = useState("-");
  const [numPos, setNumPos] = useState<"suffix" | "prefix">("suffix");
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Compile the regex once per change; an invalid pattern disables Apply.
  const compiled = useMemo<{ re: RegExp | null; error: string | null }>(() => {
    if (!regex || !find) return { re: null, error: null };
    if (find.length > 200) return { re: null, error: "Pattern too long." };
    try { return { re: new RegExp(find, "g"), error: null }; }
    catch (e) { return { re: null, error: (e as Error).message }; }
  }, [regex, find]);

  // Stable numbering order: sort by path so the sequence is deterministic
  // regardless of selection order.
  const ordered = useMemo(
    () => [...nodes].sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase())),
    [nodes],
  );

  const preview = useMemo<PreviewRow[]>(() => {
    const rows: PreviewRow[] = ordered.map((node, i) => {
      const [stem, ext] = splitNameExt(node.name, node.dir, keepExt);
      let w = stem;
      // 1. find / replace
      if (find) {
        if (regex) {
          if (compiled.re) {
            try { w = w.replace(compiled.re, replace); } catch { /* leave as-is */ }
          }
        } else {
          w = w.split(find).join(replace);
        }
      }
      // 2. case transform
      w = applyCase(w, caseMode);
      // 3. {date} token
      if (w.includes("{date}")) w = w.split("{date}").join(dateToken());
      // 4. numbering (replace {n} token, else prefix/suffix it)
      if (numEnabled) {
        const seq = String(start + i * step).padStart(Math.max(0, pad), "0");
        if (w.includes("{n}")) {
          w = w.split("{n}").join(seq);
        } else if (numPos === "prefix") {
          w = `${seq}${sep}${w}`;
        } else {
          w = `${w}${sep}${seq}`;
        }
      } else if (w.includes("{n}")) {
        // Token present but numbering off → drop it so it never lands literally.
        w = w.split("{n}").join("");
      }
      const newName = `${w}${ext}`;
      const parent = parentDir(node.path);
      const targetPath = `${parent}${sepFor(node.path)}${newName}`;
      let error: string | undefined;
      if (!w.trim()) error = "Empty name";
      else if (ILLEGAL.test(newName)) error = "Illegal character";
      return { node, oldName: node.name, newName, targetPath, changed: newName !== node.name, error };
    });
    // Detect duplicate target paths within the batch (case-insensitive).
    const seen = new Map<string, number>();
    for (const r of rows) {
      const key = r.targetPath.toLowerCase();
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    for (const r of rows) {
      if (!r.error && seen.get(r.targetPath.toLowerCase())! > 1) r.error = "Duplicate target";
    }
    return rows;
  }, [ordered, find, replace, regex, keepExt, caseMode, numEnabled, start, step, pad, sep, numPos, compiled]);

  const changedRows = preview.filter((r) => r.changed);
  const blockingErrors = preview.some((r) => r.changed && r.error);
  const canApply = !applying && !compiled.error && changedRows.length > 0 && !blockingErrors;

  const onApply = async () => {
    if (!canApply) return;
    setApplying(true);
    const ops: BulkRenameOp[] = changedRows.map((r) => ({ from: r.node.path, to: r.targetPath }));
    try {
      const { results } = await bulkRename(ops);
      // Match results back to ops by `from`; treat a missing/empty result list as
      // "unknown" → report that nothing was confirmed rather than claiming success.
      const byFrom = new Map(results.map((res) => [res.from, res]));
      const succeeded: { parent: string; from: string; to: string }[] = [];
      const failures: string[] = [];
      for (const r of changedRows) {
        const res = byFrom.get(r.node.path);
        const ok = res ? res.ok : results.length === 0 ? false : false;
        if (ok) {
          succeeded.push({ parent: parentDir(r.node.path), from: r.oldName, to: r.newName });
        } else {
          failures.push(`${r.oldName}: ${res?.error ?? "rename failed"}`);
        }
      }
      if (succeeded.length > 0) {
        pushUndo({ kind: "bulkRename", items: succeeded });
      }
      if (failures.length === 0 && succeeded.length > 0) {
        toast.success(`Renamed ${succeeded.length} item${succeeded.length === 1 ? "" : "s"}.`, { action: undoAction });
      } else if (succeeded.length > 0) {
        const shown = failures.slice(0, 6).join("\n");
        const more = failures.length > 6 ? `\n…and ${failures.length - 6} more` : "";
        toast.warn(`Renamed ${succeeded.length} of ${changedRows.length}; ${failures.length} failed:\n\n${shown}${more}`, { action: undoAction });
      } else {
        const shown = failures.slice(0, 6).join("\n");
        toast.error(`Bulk rename failed:\n\n${shown}`);
      }
      onApplied();
      onClose();
    } catch (e) {
      toast.error(`Bulk rename failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="filter-dialog-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="brn-dialog" role="dialog" aria-modal="true" aria-label="Bulk rename">
        <div className="fd-header">
          <span className="fd-title">Bulk rename — {nodes.length} item{nodes.length === 1 ? "" : "s"}</span>
          <div className="fd-header-actions">
            <button className="fd-icon-btn" title="Close" onClick={onClose}><Icon name="x" size={12} /></button>
          </div>
        </div>

        <div className="brn-controls">
          <div className="brn-row">
            <label className="brn-field brn-grow">
              <span>Find</span>
              <input value={find} spellCheck={false} placeholder={regex ? "(\\d+)" : "text to find"} onChange={(e) => setFind(e.target.value)} />
            </label>
            <label className="brn-field brn-grow">
              <span>Replace</span>
              <input value={replace} spellCheck={false} placeholder={regex ? "$1" : "replacement"} onChange={(e) => setReplace(e.target.value)} />
            </label>
          </div>
          <div className="brn-row brn-row-opts">
            <label className="brn-check" title="Interpret Find as a regular expression; use $1, $2… in Replace for capture groups">
              <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} /> Regex
            </label>
            <label className="brn-check" title="Apply changes to the name only and keep the file extension">
              <input type="checkbox" checked={keepExt} onChange={(e) => setKeepExt(e.target.checked)} /> Keep extension
            </label>
            <label className="brn-field">
              <span>Case</span>
              <select value={caseMode} onChange={(e) => setCaseMode(e.target.value as CaseMode)}>
                <option value="none">No change</option>
                <option value="upper">UPPERCASE</option>
                <option value="lower">lowercase</option>
                <option value="title">Title Case</option>
              </select>
            </label>
          </div>
          <div className="brn-row brn-row-opts">
            <label className="brn-check" title="Append or insert a sequence number ({n} token, or appended/prefixed)">
              <input type="checkbox" checked={numEnabled} onChange={(e) => setNumEnabled(e.target.checked)} /> Number
            </label>
            <label className="brn-field brn-num"><span>Start</span>
              <input type="number" value={start} disabled={!numEnabled} onChange={(e) => setStart(Number(e.target.value) || 0)} />
            </label>
            <label className="brn-field brn-num"><span>Step</span>
              <input type="number" value={step} disabled={!numEnabled} onChange={(e) => setStep(Number(e.target.value) || 1)} />
            </label>
            <label className="brn-field brn-num"><span>Pad</span>
              <input type="number" min={0} max={8} value={pad} disabled={!numEnabled} onChange={(e) => setPad(Math.max(0, Math.min(8, Number(e.target.value) || 0)))} />
            </label>
            <label className="brn-field brn-num"><span>Sep</span>
              <input value={sep} disabled={!numEnabled} maxLength={4} onChange={(e) => setSep(e.target.value)} />
            </label>
            <label className="brn-field"><span>Position</span>
              <select value={numPos} disabled={!numEnabled} onChange={(e) => setNumPos(e.target.value as "suffix" | "prefix")}>
                <option value="suffix">Suffix</option>
                <option value="prefix">Prefix</option>
              </select>
            </label>
          </div>
          <div className="brn-hint">
            Tokens: <code>{"{n}"}</code> sequence number, <code>{"{date}"}</code> today ({dateToken()}). In regex mode use <code>$1</code> for capture groups.
            {compiled.error && <span className="brn-error"> Invalid regex: {compiled.error}</span>}
          </div>
        </div>

        <div className="brn-preview" role="table" aria-label="Rename preview">
          <div className="brn-preview-head" role="row">
            <span role="columnheader">Before</span>
            <span role="columnheader">After</span>
          </div>
          <div className="brn-preview-body">
            {preview.map((r) => (
              <div className={`brn-preview-row${r.error ? " brn-bad" : ""}${!r.changed ? " brn-unchanged" : ""}`} role="row" key={r.node.id}>
                <span className="brn-before" role="cell" title={r.oldName}>{r.oldName}</span>
                <span className="brn-after" role="cell" title={r.error ? r.error : r.newName}>
                  {r.error ? <span className="brn-error">{r.error}: {r.newName}</span> : (r.changed ? r.newName : <span className="brn-dim">(unchanged)</span>)}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="fd-footer brn-footer">
          <span className="brn-summary">
            {changedRows.length} of {preview.length} will change
            {blockingErrors ? " · fix errors to apply" : ""}
          </span>
          <span className="spacer" />
          <button className="fd-ok primary" onClick={onApply} disabled={!canApply}>
            {applying ? "Renaming…" : "Apply"}
          </button>
          <button className="fd-cancel" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
