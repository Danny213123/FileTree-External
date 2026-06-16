// Recent move/copy destinations (#42).
//
// A small, localStorage-backed MRU list of folders the user has moved or copied
// items into, surfaced in the Move-to / Copy-to dialog for one-click reuse.
// Deduped case-insensitively (Windows paths) and capped so it never grows
// unbounded. Best-effort: any storage failure degrades to an empty list rather
// than throwing (mirrors how bookmarks/settings tolerate a missing store).

const STORAGE_KEY = "filetree.recentDestinations";
const MAX_ENTRIES = 12;

/** Case/trailing-separator-insensitive key for de-duplication (Windows-first). */
function normKey(path: string): string {
  return path.replace(/[\\/]+$/, "").toLowerCase();
}

/** Read the recent-destinations list, newest first. Never throws. */
export function getRecentDestinations(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && v.trim() !== "");
  } catch {
    return [];
  }
}

/** Record a destination as most-recent (deduped, capped). Never throws. */
export function recordRecentDestination(path: string): void {
  const trimmed = path.trim();
  if (!trimmed) return;
  try {
    const key = normKey(trimmed);
    const next = [trimmed, ...getRecentDestinations().filter((p) => normKey(p) !== key)].slice(
      0,
      MAX_ENTRIES,
    );
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore — recents are a convenience, not critical */
  }
}

/** Remove one destination from the list (the dialog's per-row dismiss). */
export function removeRecentDestination(path: string): string[] {
  try {
    const key = normKey(path);
    const next = getRecentDestinations().filter((p) => normKey(p) !== key);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return next;
  } catch {
    return getRecentDestinations();
  }
}
