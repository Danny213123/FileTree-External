// Theme customization: accent color + UI font-size scaling (#50).
//
// Both prefs are persisted in localStorage (like the other lightweight UI
// toggles) and applied at runtime by overriding CSS variables on :root / a
// `zoom` on <body>. Applying on load (before paint) avoids a flash.

const ACCENT_KEY = "filetree_accent";
const SCALE_KEY = "filetree_ui_scale";

export const DEFAULT_ACCENT = ""; // empty ⇒ fall back to the theme's --accent
export const DEFAULT_SCALE = 100; // percent

export const ACCENT_PRESETS: { name: string; value: string }[] = [
  { name: "Blue", value: "#0078d4" },
  { name: "Teal", value: "#0d9488" },
  { name: "Green", value: "#16a34a" },
  { name: "Purple", value: "#7c3aed" },
  { name: "Pink", value: "#db2777" },
  { name: "Orange", value: "#ea580c" },
  { name: "Red", value: "#dc2626" },
];

export const MIN_SCALE = 90;
export const MAX_SCALE = 130;

function clampScale(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_SCALE;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(n)));
}

/** Parse "#rrggbb" → [r,g,b], or null when not a 6-digit hex color. */
function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const int = parseInt(m[1], 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

export function loadAccent(): string {
  try { return localStorage.getItem(ACCENT_KEY) ?? DEFAULT_ACCENT; } catch { return DEFAULT_ACCENT; }
}

export function loadScale(): number {
  try {
    const raw = localStorage.getItem(SCALE_KEY);
    return raw ? clampScale(parseInt(raw, 10)) : DEFAULT_SCALE;
  } catch {
    return DEFAULT_SCALE;
  }
}

/**
 * Apply (or clear) the accent override. Sets --accent plus a few derived tokens
 * (--selected / --bar tints, --vsc-focus) so the accent reads consistently. An
 * empty/invalid value removes the overrides, restoring the theme default.
 */
export function applyAccent(hex: string): void {
  const root = document.documentElement;
  const rgb = hexToRgb(hex);
  if (!rgb) {
    for (const v of ["--accent", "--selected", "--bar", "--vsc-focus", "--vsc-status-bg"]) {
      root.style.removeProperty(v);
    }
    return;
  }
  const [r, g, b] = rgb;
  root.style.setProperty("--accent", hex);
  root.style.setProperty("--selected", `rgba(${r}, ${g}, ${b}, 0.16)`);
  root.style.setProperty("--bar", `rgba(${r}, ${g}, ${b}, 0.22)`);
  root.style.setProperty("--vsc-focus", hex);
  root.style.setProperty("--vsc-status-bg", hex);
}

/**
 * Apply UI scaling. The app uses px in many places, so we scale the whole shell
 * via `zoom` on <body> (reliable in Electron/Chromium) and also expose a
 * `--ui-scale` variable for any rem-relative surfaces. FLAG: a few fixed-size,
 * absolutely-positioned overlays may not perfectly track extreme zoom levels.
 */
export function applyScale(percent: number): void {
  const s = clampScale(percent);
  document.documentElement.style.setProperty("--ui-scale", String(s / 100));
  // `zoom` isn't in the typed CSSStyleDeclaration; assign through a cast.
  (document.body.style as unknown as Record<string, string>).zoom = String(s / 100);
}

export function saveAccent(hex: string): void {
  try {
    if (hexToRgb(hex)) localStorage.setItem(ACCENT_KEY, hex);
    else localStorage.removeItem(ACCENT_KEY);
  } catch { /* ignore */ }
}

export function saveScale(percent: number): void {
  try { localStorage.setItem(SCALE_KEY, String(clampScale(percent))); } catch { /* ignore */ }
}

/** Apply both persisted prefs on startup. */
export function initAppearance(): void {
  applyAccent(loadAccent());
  applyScale(loadScale());
}
