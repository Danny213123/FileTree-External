// Transfer manager queue (F10).
//
// A tiny in-session external store tracking file MOVE/COPY operations so the UI
// can show their progress + per-item status near the status bar. Every move /
// copy the app performs (drag-drop, paste, "Move to…", the AI agent, the
// treemap) routes through handleInternalMove / runPasteCopy in WorkspaceTab,
// which open a transfer here and mark it done/error when the native shell op
// returns. Native shell operations report their own granular progress in the OS
// dialog, so a queue entry tracks coarse status (running → done/error) plus the
// item count; the panel shows an overall "N running" indicator.
//
// Same shape/intent as useWorkbench's store: getSnapshot returns a STABLE array
// reference between mutations so useSyncExternalStore never loops.

import { useSyncExternalStore } from "react";

export type TransferKind = "move" | "copy";
export type TransferStatus = "running" | "done" | "error";

export interface TransferItem {
  id: number;
  kind: TransferKind;
  /** Short human label, e.g. `Move 3 items → Photos`. */
  label: string;
  /** Number of items in this operation (for the count badge). */
  count: number;
  status: TransferStatus;
  /** Error summary when status === "error". */
  error?: string;
  startedAt: number;
  endedAt?: number;
}

let items: TransferItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  // Replace the array reference so useSyncExternalStore sees a new snapshot.
  items = items.slice();
  for (const l of listeners) l();
}

/** Open a new running transfer; returns its id to finish later. */
export function beginTransfer(kind: TransferKind, label: string, count: number): number {
  const id = nextId++;
  items.push({ id, kind, label, count, status: "running", startedAt: Date.now() });
  emit();
  return id;
}

/** Mark a transfer finished (ok ⇒ done, else error with an optional message). */
export function finishTransfer(id: number, ok: boolean, error?: string): void {
  const idx = items.findIndex((t) => t.id === id);
  if (idx < 0) return;
  items[idx] = { ...items[idx], status: ok ? "done" : "error", error: ok ? undefined : (error || "failed"), endedAt: Date.now() };
  emit();
}

/** Remove a single transfer from the list (panel dismiss button). */
export function dismissTransfer(id: number): void {
  const next = items.filter((t) => t.id !== id);
  if (next.length === items.length) return;
  items = next;
  emit();
}

/** Drop every finished (done/error) transfer, keeping any still running. */
export function clearFinishedTransfers(): void {
  const next = items.filter((t) => t.status === "running");
  if (next.length === items.length) return;
  items = next;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): TransferItem[] {
  return items;
}

/** Subscribe to the transfer queue (re-renders only on add/finish/dismiss). */
export function useTransfers(): TransferItem[] {
  return useSyncExternalStore(subscribe, getSnapshot);
}
