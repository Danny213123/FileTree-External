// Scan presets / quick targets (#13).
//
// User-saved named scan targets persisted in localStorage. The built-in quick
// targets ("This PC", each drive, special folders) are derived live from the
// drive/folder lists by the UI; only user-saved presets live here.
//
// NOTE: the backend scan API takes a SINGLE root path (see `scanStreamUrl`), so
// a multi-path preset is stored as a list but the quick-scan UI scans the first
// path. "This PC" is therefore scoped to the primary/system drive — see the
// flag in the SideBar quick-scan control. Everything here is best-effort and
// never throws.

export interface ScanPreset {
  id: string;
  name: string;
  /** One or more target paths. The current backend scans only `paths[0]`. */
  paths: string[];
}

const STORE_KEY = "filetree.scanPresets.v1";

export function loadPresets(): ScanPreset[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw) as ScanPreset[];
    return Array.isArray(data) ? data.filter((p) => p && p.id && Array.isArray(p.paths)) : [];
  } catch {
    return [];
  }
}

function savePresets(presets: ScanPreset[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(presets));
  } catch {
    /* quota / unavailable — ignore */
  }
}

/** Add a named preset; returns the updated list (newest first). */
export function addPreset(name: string, paths: string[]): ScanPreset[] {
  const presets = loadPresets();
  const preset: ScanPreset = {
    id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: name.trim() || paths[0] || "Preset",
    paths: paths.filter(Boolean),
  };
  const next = [preset, ...presets];
  savePresets(next);
  return next;
}

/** Remove a preset by id; returns the updated list. */
export function removePreset(id: string): ScanPreset[] {
  const next = loadPresets().filter((p) => p.id !== id);
  savePresets(next);
  return next;
}
