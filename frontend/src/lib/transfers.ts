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
// "queued" — waiting in the serial queue (e.g. while the queue is paused or an
// earlier transfer is still running); "running" — the underlying op is in
// flight; then terminal "done"/"error".
export type TransferStatus = "queued" | "running" | "done" | "error";

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

/** Outcome a queued transfer's worker resolves with. */
export interface TransferResult {
  ok: boolean;
  error?: string;
}

let items: TransferItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

// ── Queue + pause/resume state ──────────────────────────────────────────────
// Move/copy operations enqueue here and run ONE AT A TIME. `paused` gates the
// START of the next queued transfer only — an already-running native shell
// transfer keeps going (the OS owns its progress; the native mover has no
// mid-file pause hook). See enqueueTransfer / pauseTransfers below.
let paused = false;
let processing = false;
const workers = new Map<number, () => Promise<TransferResult>>();
const resolvers = new Map<number, (r: TransferResult) => void>();
const dedupedTransfers = new Map<string, { promise: Promise<TransferResult>; expiresAt: number }>();

export function transferDedupeKey(kind: TransferKind, paths: string[], destination: string): string {
  const normalizedPaths = paths
    .map((path) => path.replace(/\//g, "\\").replace(/\\+$/g, "").toLowerCase())
    .sort();
  const normalizedDestination = destination.replace(/\//g, "\\").replace(/\\+$/g, "").toLowerCase();
  return `${kind}\n${normalizedDestination}\n${normalizedPaths.join("\n")}`;
}

function emit() {
  // Replace the array reference so useSyncExternalStore sees a new snapshot.
  items = items.slice();
  for (const l of listeners) l();
}

function setStatus(id: number, status: TransferStatus, error?: string): void {
  const idx = items.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const ended = status === "done" || status === "error";
  items[idx] = {
    ...items[idx],
    status,
    error: status === "error" ? (error || "failed") : items[idx].error,
    ...(ended ? { endedAt: Date.now() } : {}),
  };
  emit();
}

/**
 * Drive the serial queue: while not paused, pick the oldest "queued" transfer,
 * run its worker to completion, then move on. Re-entrancy-guarded so multiple
 * enqueues / a resume can't start parallel pumps. The currently-running worker
 * is never interrupted by a pause — pause only stops us from starting the next.
 */
async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (!paused) {
      const next = items.find((t) => t.status === "queued" && workers.has(t.id));
      if (!next) break;
      const worker = workers.get(next.id)!;
      workers.delete(next.id);
      setStatus(next.id, "running");
      let result: TransferResult;
      try {
        result = await worker();
      } catch (e) {
        result = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      setStatus(next.id, result.ok ? "done" : "error", result.error);
      const resolve = resolvers.get(next.id);
      resolvers.delete(next.id);
      resolve?.(result);
    }
  } finally {
    processing = false;
  }
}

/**
 * Enqueue a move/copy operation. The `worker` performs the actual transfer and
 * resolves with its outcome; the queue marks the entry running/done/error and
 * serializes it behind any earlier transfers (and behind a pause). Returns the
 * worker's result so callers can run their follow-up (rescan, undo, toast).
 */
export function enqueueTransfer(
  kind: TransferKind,
  label: string,
  count: number,
  worker: () => Promise<TransferResult>,
  dedupeKey?: string,
  onDedupe?: () => void,
): Promise<TransferResult> {
  if (dedupeKey) {
    const existing = dedupedTransfers.get(dedupeKey);
    if (existing && existing.expiresAt > Date.now()) {
      onDedupe?.();
      return existing.promise;
    }
    if (existing) dedupedTransfers.delete(dedupeKey);
  }
  const id = nextId++;
  items.push({ id, kind, label, count, status: "queued", startedAt: Date.now() });
  workers.set(id, worker);
  const promise = new Promise<TransferResult>((resolve) => resolvers.set(id, resolve));
  if (dedupeKey) {
    const entry = { promise, expiresAt: Number.POSITIVE_INFINITY };
    dedupedTransfers.set(dedupeKey, entry);
    void promise.then(() => {
      entry.expiresAt = Date.now() + 3000;
      window.setTimeout(() => {
        if (dedupedTransfers.get(dedupeKey) === entry) dedupedTransfers.delete(dedupeKey);
      }, 3100);
    });
  }
  emit();
  void processQueue();
  return promise;
}

/** Pause the queue: no further queued transfers start until {@link resumeTransfers}. */
export function pauseTransfers(): void {
  if (paused) return;
  paused = true;
  emit();
}

/** Resume the queue and pump any transfers that were held back. */
export function resumeTransfers(): void {
  if (!paused) return;
  paused = false;
  emit();
  void processQueue();
}

/** True when the queue is paused (no new transfers will start). */
export function isPaused(): boolean {
  return paused;
}

/** Subscribe to the paused flag (for the panel's Pause/Resume control). */
export function useTransfersPaused(): boolean {
  return useSyncExternalStore(subscribe, isPaused);
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

/** Drop every finished (done/error) transfer, keeping any running or queued. */
export function clearFinishedTransfers(): void {
  const next = items.filter((t) => t.status === "running" || t.status === "queued");
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
