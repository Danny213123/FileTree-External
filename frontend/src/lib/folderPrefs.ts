import type { SortKey } from "../api/types";

// ── Per-folder remembered sort + column widths (#5) ───────────────────────────
// A small localStorage-backed map keyed by NORMALIZED folder path. When a folder
// has a saved entry, its sort key/dir + column widths are restored on navigate;
// otherwise the current/global default is left in place. The map is capped at
// the most-recent CAP folders (oldest evicted) so a long browsing session can't
// grow it without bound. Layered ON TOP of the global default — never replaces it.

export interface FolderPref {
  sortKey: SortKey;
  sortDir: 1 | -1;
  columnWidths: Partial<Record<SortKey, number>>;
}

const KEY = "filetree_folder_prefs";
const CAP = 100;

interface Store {
  // Most-recent-first list of keys, used for LRU eviction.
  order: string[];
  prefs: Record<string, FolderPref>;
}

/** Case-insensitive, trailing-separator-insensitive folder key (Windows). */
export function normFolderKey(p: string): string {
  return p.replace(/[/\\]+$/, "").toLowerCase();
}

function load(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { order: [], prefs: {} };
    const j = JSON.parse(raw) as Partial<Store>;
    if (j && typeof j === "object" && j.prefs && typeof j.prefs === "object") {
      return { order: Array.isArray(j.order) ? j.order : [], prefs: j.prefs };
    }
  } catch { /* ignore */ }
  return { order: [], prefs: {} };
}

export function loadFolderPref(key: string): FolderPref | null {
  return load().prefs[key] ?? null;
}

export function saveFolderPref(key: string, pref: FolderPref): void {
  if (!key) return;
  const s = load();
  s.prefs[key] = pref;
  s.order = [key, ...s.order.filter((k) => k !== key)];
  if (s.order.length > CAP) {
    for (const k of s.order.slice(CAP)) delete s.prefs[k];
    s.order = s.order.slice(0, CAP);
  }
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}
