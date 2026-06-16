// Search history (#33).
//
// Recent search queries persisted in localStorage: deduped (case-insensitive),
// most-recent-first, capped at HISTORY_MAX. The Search view shows these in a
// dropdown under the search box for one-click re-run, plus a clear action.
// Everything here is best-effort and never throws.

const STORE_KEY = "filetree.searchHistory.v1";
const HISTORY_MAX = 20;

export function loadSearchHistory(): string[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw) as unknown;
    return Array.isArray(data) ? data.filter((q): q is string => typeof q === "string") : [];
  } catch {
    return [];
  }
}

function save(list: string[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch {
    /* quota / unavailable — ignore */
  }
}

/** Record a committed query: dedupes case-insensitively, moves it to the front,
 *  and caps the list. Blank / sub-2-char queries are ignored. Returns the
 *  updated list (most-recent-first). */
export function addSearchHistory(query: string): string[] {
  const q = query.trim();
  if (q.length < 2) return loadSearchHistory();
  const lower = q.toLowerCase();
  const existing = loadSearchHistory().filter((e) => e.toLowerCase() !== lower);
  const next = [q, ...existing].slice(0, HISTORY_MAX);
  save(next);
  return next;
}

export function clearSearchHistory(): string[] {
  save([]);
  return [];
}
