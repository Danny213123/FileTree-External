// In-app undo (Phase 6).
//
// A bounded, in-session LIFO stack of the most recent *reversible* mutating
// operations. Each successful mutation in the UI / agent pushes a compact entry
// carrying exactly what's needed to reverse it; Ctrl+Z (wired in App.tsx) pops
// the newest entry and runs the reverse op.
//
// The executor reuses the existing, already-audited primitives so undo is
// audited for free and can never bypass the safety barriers built in earlier
// phases:
//   • move    → move the item(s) back into their original parent (POST
//               /api/move-items, token-gated + audited; conflicts are reported,
//               nothing is overwritten).
//   • rename  → rename back to the original name (POST /api/rename).
//   • recycle → restore each item from the Recycle Bin to its original path via
//               the native addon (audited there as a `restore` op).
//   • mkdir   → remove the just-created folder, but ONLY when it is still empty,
//               so an undo never sweeps files the user added into the bin.
//   • permanent delete → NOT undoable: the entry exists only so Ctrl+Z reports
//               clearly that it can't be reversed (we never offer a broken undo).
//
// Failure-tolerant by construction: a reverse op that fails surfaces a clear
// message and leaves state untouched (the underlying primitives never overwrite
// or delete on error).

import {
  moveItems,
  renameItem,
  deletePath,
  restoreFromRecycleBin,
  hasRecycleRestore,
  fetchScan,
} from "../api/client";

export type UndoEntry =
  | { kind: "move"; items: { name: string; originalParent: string }[]; destination: string }
  | { kind: "rename"; parent: string; from: string; to: string }
  // A bulk rename (F3): each item renamed `from`→`to` within its own `parent`.
  // Reversed as a batch (newest-first) by renaming each `to` back to `from`.
  | { kind: "bulkRename"; items: { parent: string; from: string; to: string }[] }
  | { kind: "recycle"; paths: string[] }
  | { kind: "mkdir"; path: string }
  | { kind: "permanentDelete"; count: number };

export interface UndoResult {
  ok: boolean;
  /** Short, user-facing status for the toast. */
  message: string;
  /** True when some — but not all — of a multi-item op was reversed. */
  partial?: boolean;
}

const MAX_ENTRIES = 20;
const stack: UndoEntry[] = [];

// Subscribers (the visible Undo control, F10) re-render when the stack changes.
// A monotonically-bumped version doubles as the useSyncExternalStore snapshot so
// a re-render fires on every push/pop without leaking the mutable array.
const listeners = new Set<() => void>();
let version = 0;
function emitUndoChange() {
  version++;
  for (const l of listeners) l();
}

/** Subscribe to undo-stack changes (returns an unsubscribe fn). */
export function subscribeUndo(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Monotonic version of the undo stack (useSyncExternalStore snapshot). */
export function undoVersion(): number {
  return version;
}

/** Push a reversible op onto the undo stack (drops the oldest past the cap). */
export function pushUndo(entry: UndoEntry): void {
  stack.push(entry);
  if (stack.length > MAX_ENTRIES) stack.shift();
  emitUndoChange();
}

/** Number of entries currently undoable. */
export function undoDepth(): number {
  return stack.length;
}

/** A short, human label for the newest undoable op (for the Undo control tooltip). */
export function peekUndoLabel(): string | null {
  const e = stack[stack.length - 1];
  if (!e) return null;
  switch (e.kind) {
    case "move": return `move of ${plural(e.items.length, "item")}`;
    case "rename": return `rename to "${e.to}"`;
    case "bulkRename": return `bulk rename of ${plural(e.items.length, "item")}`;
    case "recycle": return `recycle of ${plural(e.paths.length, "item")}`;
    case "mkdir": return `new folder "${baseName(e.path)}"`;
    case "permanentDelete": return `delete of ${plural(e.count, "item")}`;
    default: return "last action";
  }
}

/** Peek the newest entry without removing it (for an "Undo …" affordance). */
export function peekUndo(): UndoEntry | undefined {
  return stack[stack.length - 1];
}

/** Drop all entries (e.g. when the user explicitly clears history). */
export function clearUndo(): void {
  stack.length = 0;
  emitUndoChange();
}

// ── Path helpers (Windows-first, tolerant of forward slashes) ───────────────

function sepFor(p: string): string {
  return p.includes("\\") || !p.includes("/") ? "\\" : "/";
}

function joinPath(parent: string, name: string): string {
  const trimmed = parent.replace(/[\\/]+$/, "");
  return `${trimmed}${sepFor(parent)}${name}`;
}

export function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export function parentDir(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return idx > 0 ? trimmed.slice(0, idx) : trimmed;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// ── Reverse-op executor ─────────────────────────────────────────────────────

/**
 * Pop the newest entry and reverse it. Returns null when there's nothing to
 * undo; otherwise an {@link UndoResult} describing the outcome. Never throws.
 */
export async function undoLast(): Promise<UndoResult | null> {
  const entry = stack.pop();
  if (!entry) return null;
  emitUndoChange();
  try {
    switch (entry.kind) {
      case "permanentDelete":
        // Intentionally not reversible — report clearly, never a broken undo.
        return {
          ok: false,
          message: `Can't undo: ${plural(entry.count, "item")} ${entry.count === 1 ? "was" : "were"} permanently deleted (not recoverable).`,
        };

      case "rename": {
        const current = joinPath(entry.parent, entry.to);
        const r = await renameItem(current, entry.from);
        return r.ok
          ? { ok: true, message: `Undone — renamed "${entry.to}" back to "${entry.from}".` }
          : { ok: false, message: `Couldn't undo rename: ${r.error ?? "unknown error"}` };
      }

      case "move": {
        let back = 0;
        const errors: string[] = [];
        for (const it of entry.items) {
          const current = joinPath(entry.destination, it.name);
          const res = await moveItems([current], it.originalParent);
          if (res.moved.length > 0 || res.alreadyThere.length > 0) back++;
          else if (res.conflicts.length > 0) errors.push(`${it.name}: already exists at the original location`);
          else if (res.errors.length > 0) errors.push(`${it.name}: ${res.errors.join("; ")}`);
          else errors.push(`${it.name}: not found to move back`);
        }
        const total = entry.items.length;
        if (back === total) return { ok: true, message: `Undone — moved ${plural(back, "item")} back.` };
        if (back > 0) return { ok: true, partial: true, message: `Moved ${back} of ${total} back; ${errors.join("; ")}` };
        return { ok: false, message: `Couldn't undo move: ${errors.join("; ") || "items not found at destination"}` };
      }

      case "bulkRename": {
        // Reverse newest-last → rename each renamed item back to its original
        // name. A name that can't be put back (renamed again, collision) is
        // reported but never overwrites anything (renameItem is non-destructive).
        let back = 0;
        const errors: string[] = [];
        for (const it of entry.items) {
          const current = joinPath(it.parent, it.to);
          const r = await renameItem(current, it.from);
          if (r.ok) back++;
          else errors.push(`${it.to}: ${r.error ?? "couldn't rename back"}`);
        }
        const total = entry.items.length;
        if (back === total) return { ok: true, message: `Undone — reverted ${plural(back, "rename")}.` };
        const tail = errors.slice(0, 3).join("; ") + (errors.length > 3 ? "…" : "");
        if (back > 0) return { ok: true, partial: true, message: `Reverted ${back} of ${total}; ${tail}` };
        return { ok: false, message: `Couldn't undo bulk rename: ${tail || "items not found"}` };
      }

      case "recycle": {
        if (!hasRecycleRestore()) {
          return {
            ok: false,
            message: "Restore isn't available here — restore the item(s) manually from the Recycle Bin.",
          };
        }
        let restored = 0;
        const failed: string[] = [];
        for (const p of entry.paths) {
          const ok = await restoreFromRecycleBin(p);
          if (ok) restored++;
          else failed.push(baseName(p));
        }
        const total = entry.paths.length;
        if (restored === total) return { ok: true, message: `Undone — restored ${plural(restored, "item")} from the Recycle Bin.` };
        const tail = failed.slice(0, 3).join(", ") + (failed.length > 3 ? "…" : "");
        if (restored > 0) {
          return { ok: true, partial: true, message: `Restored ${restored} of ${total}; restore the rest manually from the Recycle Bin (${tail}).` };
        }
        return { ok: false, message: `Couldn't restore from the Recycle Bin — restore manually (${tail}).` };
      }

      case "mkdir": {
        // Only remove the folder if it's still empty: undoing "create folder"
        // must never sweep files the user has since added into the bin.
        const empty = await isEmptyDir(entry.path);
        if (empty !== true) {
          return { ok: false, message: `Folder "${baseName(entry.path)}" isn't empty — left in place.` };
        }
        const r = await deletePath(entry.path, false); // recycle (recoverable)
        return r.ok
          ? { ok: true, message: `Undone — removed the empty folder "${baseName(entry.path)}".` }
          : { ok: false, message: `Couldn't remove folder: ${r.error ?? "unknown error"}` };
      }
    }
  } catch (e) {
    return { ok: false, message: `Undo failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * True when `path` is a directory with no children, false when it has any, and
 * null when we can't tell (scan failed). A shallow scan is enough — the folder
 * we'd be undoing was just created, so it's tiny.
 */
async function isEmptyDir(path: string): Promise<boolean | null> {
  try {
    const res = await fetchScan({ path, maxDepth: 1, nocache: true });
    // nodeCount includes the root folder itself; >1 means it has children.
    return res.nodeCount <= 1;
  } catch {
    return null;
  }
}
