// Auto-snapshot history + growth alerts (roadmap #36 / #40).
//
// Builds on the existing compact snapshot store (src/snapshots.rs, reached via
// the client wrappers in api/client.ts). Everything here is FRONTEND-ONLY and
// reuses the existing endpoints: it never changes the snapshot file format. Two
// small bits of side-state live in localStorage:
//
//   1. Which saved snapshots were created automatically (vs. the user pressing
//      "Save snapshot"), so the UI can mark them distinctly and prune only the
//      auto ones. The snapshot meta itself has no "auto" flag, so we track ids.
//   2. The per-root throttle clock, the per-root growth-alert thresholds, and
//      the set of snapshot ids we've already alerted on (so an alert fires once).
//
// FLAG: marking auto-vs-manual lives client-side (localStorage), not in the
// snapshot file, to avoid a breaking change to the Rust snapshot format.

import { fetchSnapshots, saveSnapshot, deleteSnapshot, notify } from "../api/client";
import type { SnapshotMeta } from "../api/types";
import { formatBytes } from "../utils/formatBytes";

// At most one auto-snapshot per root per this window, so a history accumulates
// without one snapshot per refresh flooding the store.
export const AUTO_THROTTLE_MS = 6 * 60 * 60 * 1000; // 6 hours
// Keep at most this many AUTO snapshots per root (oldest pruned). Manual
// snapshots are never auto-pruned.
export const AUTO_CAP_PER_ROOT = 30;

const AUTO_IDS_KEY = "filetree.autoSnapshotIds";
const LAST_AUTO_KEY = "filetree.autoSnapshotLast";
const ALERTED_KEY = "filetree.snapshotAlertedIds";
const ALERT_CFG_KEY = "filetree.snapshotAlertConfigs";

/** Per-root growth-alert definition (roadmap #40). Either threshold (>0) arms. */
export interface GrowthAlertConfig {
  /** Watched folder (the scan root / scheduled-task path). */
  path: string;
  enabled: boolean;
  /** Alert when growth vs. the previous snapshot ≥ this %. 0 = ignore. */
  thresholdPct: number;
  /** Alert when growth vs. the previous snapshot ≥ this many bytes. 0 = ignore. */
  thresholdBytes: number;
}

/** Case-insensitive, separator-normalized key for a Windows path. */
export function rootKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore quota / disabled storage */
  }
}

// ── Auto-snapshot id set ─────────────────────────────────────

function readAutoIds(): Set<string> {
  return new Set(readJson<string[]>(AUTO_IDS_KEY, []));
}

function writeAutoIds(ids: Set<string>): void {
  writeJson(AUTO_IDS_KEY, [...ids]);
}

/** True when this snapshot id was created automatically (vs. a manual save). */
export function isAutoSnapshot(id: string): boolean {
  return readAutoIds().has(id);
}

function markAuto(id: string): void {
  const ids = readAutoIds();
  ids.add(id);
  writeAutoIds(ids);
}

function unmarkAuto(id: string): void {
  const ids = readAutoIds();
  if (ids.delete(id)) writeAutoIds(ids);
}

// ── Throttle clock ───────────────────────────────────────────

function lastAutoAt(key: string): number {
  return readJson<Record<string, number>>(LAST_AUTO_KEY, {})[key] ?? 0;
}

function setLastAutoAt(key: string, ms: number): void {
  const map = readJson<Record<string, number>>(LAST_AUTO_KEY, {});
  map[key] = ms;
  writeJson(LAST_AUTO_KEY, map);
}

// ── Auto-snapshot on scan complete (#36) ─────────────────────

/**
 * Save a compact auto-snapshot for `rootPath` if the throttle window has
 * elapsed, then prune the oldest auto-snapshots for that root beyond the cap.
 * Reuses POST /api/snapshots-save (the server snapshots its own cached scan of
 * `rootPath`, so there's no large client upload). Returns the refreshed
 * snapshot list when it saved, or `null` when it was throttled / failed (never
 * throws — auto behavior must not disrupt scanning).
 */
export async function maybeAutoSnapshot(rootPath: string): Promise<SnapshotMeta[] | null> {
  const path = rootPath?.trim();
  if (!path) return null;
  const key = rootKey(path);
  const now = Date.now();
  if (now - lastAutoAt(key) < AUTO_THROTTLE_MS) return null;

  try {
    // Stamp the clock first so two scans completing back-to-back can't both pass
    // the throttle and double-save.
    setLastAutoAt(key, now);
    const list = await saveSnapshot(path);

    // The just-created snapshot is the newest one for this root.
    const mine = list
      .filter((s) => rootKey(s.path) === key)
      .sort((a, b) => b.createdAt - a.createdAt);
    if (mine[0]) markAuto(mine[0].id);

    // Prune oldest AUTO snapshots beyond the cap (manual ones are untouched).
    const autoIds = readAutoIds();
    const autoForRoot = mine.filter((s) => autoIds.has(s.id)); // newest-first
    const stale = autoForRoot.slice(AUTO_CAP_PER_ROOT);
    if (stale.length > 0) {
      for (const s of stale) {
        try {
          await deleteSnapshot(s.id);
          unmarkAuto(s.id);
        } catch {
          /* best-effort prune */
        }
      }
      return fetchSnapshots();
    }
    return list;
  } catch {
    return null;
  }
}

// ── Growth alert configs (#40) ───────────────────────────────

export function getAlertConfigs(): GrowthAlertConfig[] {
  return readJson<GrowthAlertConfig[]>(ALERT_CFG_KEY, []);
}

export function saveAlertConfigs(list: GrowthAlertConfig[]): void {
  writeJson(ALERT_CFG_KEY, list);
}

/** Add or replace the alert config for a path (keyed case-insensitively). */
export function upsertAlertConfig(cfg: GrowthAlertConfig): void {
  const key = rootKey(cfg.path);
  const next = getAlertConfigs().filter((c) => rootKey(c.path) !== key);
  next.push(cfg);
  saveAlertConfigs(next);
}

export function removeAlertConfig(path: string): void {
  const key = rootKey(path);
  saveAlertConfigs(getAlertConfigs().filter((c) => rootKey(c.path) !== key));
}

function readAlertedIds(): Set<string> {
  return new Set(readJson<string[]>(ALERTED_KEY, []));
}

function writeAlertedIds(ids: Set<string>): void {
  // Bound the set so it can't grow forever (newest kept).
  const arr = [...ids];
  writeJson(ALERTED_KEY, arr.slice(Math.max(0, arr.length - 200)));
}

/**
 * Evaluate every enabled growth-alert config against the snapshot history and
 * fire ONE native notification per newly-qualifying snapshot (de-duped by the
 * triggering snapshot id). Compares the two most recent snapshots for a watched
 * path; the auto-snapshots from #36 supply that history as scans accumulate.
 *
 * FLAG (#40 runtime boundary): this runs INSIDE the app (on app start and right
 * after an auto-snapshot is saved), NOT inside the headless Windows scheduled
 * task — that task is a separate FileTree CLI process that only scans + exports
 * and has no renderer / notification channel. So a threshold breach is surfaced
 * the next time the app is open and a snapshot for that root lands, rather than
 * at the exact scheduled moment while the app is closed.
 */
export async function checkGrowthAlerts(snapshots?: SnapshotMeta[]): Promise<void> {
  const configs = getAlertConfigs().filter((c) => c.enabled && (c.thresholdPct > 0 || c.thresholdBytes > 0));
  if (configs.length === 0) return;

  let list = snapshots;
  if (!list) {
    try { list = await fetchSnapshots(); } catch { return; }
  }
  const alerted = readAlertedIds();
  let changed = false;

  for (const cfg of configs) {
    const key = rootKey(cfg.path);
    const mine = list
      .filter((s) => rootKey(s.path) === key)
      .sort((a, b) => b.createdAt - a.createdAt);
    if (mine.length < 2) continue;
    const [newest, prev] = mine;
    if (alerted.has(newest.id)) continue;

    const growthBytes = newest.total - prev.total;
    if (growthBytes <= 0) continue;
    const pct = prev.total > 0 ? (growthBytes / prev.total) * 100 : 100;

    const breach =
      (cfg.thresholdPct > 0 && pct >= cfg.thresholdPct) ||
      (cfg.thresholdBytes > 0 && growthBytes >= cfg.thresholdBytes);
    if (!breach) continue;

    const name = cfg.path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || cfg.path;
    void notify(
      `Folder grew: ${name}`,
      `${cfg.path} grew ${formatBytes(growthBytes)} (+${pct.toFixed(1)}%) since the previous snapshot.`,
    );
    alerted.add(newest.id);
    changed = true;
  }

  if (changed) writeAlertedIds(alerted);
}
