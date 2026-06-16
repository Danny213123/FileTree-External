// Notification / activity center (#48).
//
// A module-level singleton log of notable app events (scans, compress jobs,
// transfers, errors, cleanup actions). Mirrors the toast store's pub/sub shape
// so any module — React or not — can record an event via `logActivity`. The
// toast helper feeds this centrally (every toast becomes an activity entry), so
// existing call sites need no changes; callers can also log directly for events
// that don't raise a toast.
//
// History is capped (200) and mirrored to localStorage so it survives reloads.

export type ActivityType = "success" | "warn" | "error" | "info";

export interface ActivityEntry {
  id: number;
  /** Epoch ms. */
  ts: number;
  type: ActivityType;
  message: string;
  /** Optional source tag (e.g. "scan", "compress", "transfer"). */
  source?: string;
}

const MAX_HISTORY = 200;
const STORAGE_KEY = "filetree_activity_log";

let nextId = 1;
let entries: ActivityEntry[] = loadPersisted();
let unread = 0;
const listeners = new Set<() => void>();

function loadPersisted(): ActivityEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ActivityEntry[];
    if (!Array.isArray(parsed)) return [];
    // Re-seed the id counter so new ids never collide with restored ones.
    for (const e of parsed) if (e.id >= nextId) nextId = e.id + 1;
    return parsed.slice(-MAX_HISTORY);
  } catch {
    return [];
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* ignore (quota / private mode) */
  }
}

function emit(): void {
  for (const l of listeners) l();
}

export function subscribeActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getActivitySnapshot(): ActivityEntry[] {
  return entries;
}

export function getUnreadCount(): number {
  return unread;
}

/** Record one event (newest last). Bumps the unread counter. */
export function logActivity(message: string, type: ActivityType = "info", source?: string): void {
  const msg = (message ?? "").trim();
  if (!msg) return;
  const entry: ActivityEntry = { id: nextId++, ts: Date.now(), type, message: msg, source };
  entries = [...entries, entry].slice(-MAX_HISTORY);
  unread += 1;
  persist();
  emit();
}

/** Clear the unread badge (called when the panel is opened). */
export function markActivityRead(): void {
  if (unread === 0) return;
  unread = 0;
  emit();
}

/** Wipe the whole history (and the badge). */
export function clearActivity(): void {
  if (entries.length === 0 && unread === 0) return;
  entries = [];
  unread = 0;
  persist();
  emit();
}
