// Theme customization (#50): theme mode, accent color, UI scale, row density,
// base text size, reduced motion and UI font family.
//
// Every pref is persisted in localStorage (like the other lightweight UI
// toggles) and applied at runtime by overriding CSS variables on :root / zooming
// the webview. Applying on load (before paint) avoids a flash.

import { isTauriV2 } from "../api/v2";

const ACCENT_KEY = "filetree_accent";
const SCALE_KEY = "filetree_ui_scale";
const THEME_KEY = "filetree_theme_mode";
const DENSITY_KEY = "filetree_row_density";
const MOTION_KEY = "filetree_reduce_motion";
const FONT_KEY = "filetree_ui_font";
const FONT_SIZE_KEY = "filetree_ui_font_size";

export const DEFAULT_ACCENT = ""; // empty ⇒ fall back to the theme's --accent
export const DEFAULT_SCALE = 100; // percent

export const ACCENT_PRESETS: { name: string; value: string }[] = [
  { name: "Blue", value: "#0078d4" },
  { name: "Indigo", value: "#4f46e5" },
  { name: "Cyan", value: "#0891b2" },
  { name: "Teal", value: "#0d9488" },
  { name: "Green", value: "#16a34a" },
  { name: "Purple", value: "#7c3aed" },
  { name: "Magenta", value: "#a21caf" },
  { name: "Pink", value: "#db2777" },
  { name: "Amber", value: "#d97706" },
  { name: "Orange", value: "#ea580c" },
  { name: "Red", value: "#dc2626" },
  { name: "Slate", value: "#475569" },
];

export const MIN_SCALE = 90;
export const MAX_SCALE = 130;

function clampScale(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_SCALE;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(n)));
}

/**
 * How the light/dark choice is made. "system" tracks the OS preference live;
 * the other two pin it regardless of what the OS reports.
 */
export type ThemeMode = "light" | "dark" | "system";

/** The app shipped dark-only, so an unconfigured install stays dark. */
export const DEFAULT_THEME_MODE: ThemeMode = "dark";

export type RowDensity = "compact" | "normal" | "relaxed";

export const DEFAULT_DENSITY: RowDensity = "normal";

/**
 * Row heights per density. "normal" is the 23px the table was hardcoded to, so
 * the default density reproduces the previous layout exactly.
 */
export const ROW_HEIGHTS: Record<RowDensity, number> = {
  compact: 19,
  normal: 23,
  relaxed: 28,
};

/**
 * Base text size. Only text that inherits it responds — that covers the file
 * table and most body copy, while chrome that pins its own px size does not.
 * `uiScale` remains the control that resizes everything uniformly.
 */
export const DEFAULT_FONT_SIZE = 12;
export const MIN_FONT_SIZE = 11;
export const MAX_FONT_SIZE = 16;

/** Empty value ⇒ keep the stylesheet's own stack. */
export const FONT_PRESETS: { name: string; value: string }[] = [
  { name: "System", value: "" },
  { name: "Segoe UI", value: '"Segoe UI", system-ui, sans-serif' },
  { name: "Inter", value: 'Inter, "Segoe UI", system-ui, sans-serif' },
  { name: "Roboto", value: 'Roboto, "Segoe UI", system-ui, sans-serif' },
  { name: "Arial", value: "Arial, Helvetica, sans-serif" },
  { name: "Verdana", value: "Verdana, Geneva, sans-serif" },
  { name: "Tahoma", value: "Tahoma, Geneva, sans-serif" },
  { name: "Georgia", value: 'Georgia, "Times New Roman", serif' },
  { name: "Consolas", value: 'Consolas, "Cascadia Mono", monospace' },
];

function clampFontSize(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_FONT_SIZE;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(n)));
}

/**
 * Everything another window would need to look like this one.
 *
 * These prefs live in this webview's own storage, which a separate app cannot
 * read, so they are also written to a file beside the other settings and
 * FileTree Explorer follows it. Read from the same loaders the app itself uses,
 * so what is published can never disagree with what is applied here.
 */
export function appearanceSnapshot(): string {
  return JSON.stringify({
    accent: loadAccent(),
    font: loadFont(),
    fontSize: loadFontSize(),
    scale: loadScale(),
    density: loadDensity(),
    reduceMotion: loadReduceMotion(),
    themeMode: loadThemeMode() ?? DEFAULT_THEME_MODE,
  });
}

/** Coalesces a slider drag into one write instead of one per tick. */
let publishTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Tell the other window how this one looks now.
 *
 * Best-effort on purpose: a companion app not picking up a colour change is
 * not worth interrupting anyone over, and there is nothing useful to do about
 * it here.
 */
export function publishAppearance(): void {
  if (!isTauriV2()) return;
  clearTimeout(publishTimer);
  publishTimer = setTimeout(() => {
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("publish_appearance", { appearance: appearanceSnapshot() }))
      .catch(() => { /* the companion app simply keeps its current look */ });
  }, 150);
}

/**
 * The row height to lay rows out at.
 *
 * Density picks the base, but a row shorter than its own text clips the
 * descenders, so the larger text sizes raise the floor — otherwise "compact"
 * plus 16px text would cut the names off.
 */
export function rowHeightFor(density: RowDensity, fontSize: number): number {
  return Math.max(ROW_HEIGHTS[density] ?? ROW_HEIGHTS.normal, clampFontSize(fontSize) + 7);
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

/** Mirrors the CSS fallback's zoom; stays 1 whenever the webview zooms itself. */
let zoomFactor = 1;
/** Mirrors the webview's own zoom; stays 1 whenever the CSS fallback is used. */
let nativeZoomFactor = 1;
/** Latest requested factor, so a fast slider drag settles on its final value. */
let requestedFactor = 1;
/** Latches once native zoom fails, so we stop retrying it on every slider tick. */
let nativeZoomUnavailable = false;
/** Serializes the async native calls; out-of-order ones would fight each other. */
let nativeZoomQueue: Promise<void> = Promise.resolve();

/**
 * The scale factor the app shell is rendered at, in the coordinate space that
 * inline lengths are read in (1 whenever measurements already agree).
 *
 * Under the CSS fallback this is the `zoom` on <body>, and it matters: `zoom`
 * multiplies the used value of every length inside the subtree, but
 * `getBoundingClientRect`, `clientX` and `innerHeight` all report real viewport
 * pixels — so feeding a measured coordinate straight back into an inline
 * `top`/`left` scales it a second time. Native webview zoom rescales the CSS
 * pixel itself, so both spaces coincide and this returns 1. `lib/overlay.ts`
 * converts between the two; prefer those helpers over calling this directly.
 */
export function uiZoom(): number {
  return zoomFactor;
}

/**
 * The webview's own zoom factor — 1 unless the desktop build applied native
 * zoom.
 *
 * This is the *inverse* concern to `uiZoom`. Native zoom rescales the CSS pixel
 * relative to the window, so the layout viewport grows as the app scales down:
 * at 90% a 1000px-wide window reports `innerWidth` ≈ 1111. A position reported
 * in window pixels rather than CSS pixels — Tauri's native drag-drop payload is
 * the one case — must be divided by this before it can be hit-tested with
 * `elementFromPoint`, or it lands short of the cursor by more the further from
 * the top-left corner it is.
 */
export function nativeZoom(): number {
  return nativeZoomFactor;
}

/**
 * Apply UI scaling.
 *
 * The desktop build zooms the webview itself. That rescales the CSS pixel, so
 * the layout viewport keeps matching the window frame and every measurement API
 * keeps agreeing with the lengths we write back — no shell overflow, and no
 * coordinate conversion needed for overlays.
 *
 * Outside Tauri (browser dev, tests) there is no such control, so fall back to
 * `zoom` on <body> plus a `--ui-scale` the stylesheet divides the shell size by.
 * Those two MUST be applied together: `--ui-scale` alone lays the shell out
 * larger than the window and pushes its top-left corner outside the frame.
 */
export function applyScale(percent: number): void {
  const factor = clampScale(percent) / 100;
  requestedFactor = factor;
  if (isTauriV2() && !nativeZoomUnavailable) {
    clearCssZoom();
    nativeZoomQueue = nativeZoomQueue.then(async () => {
      if (requestedFactor !== factor) return; // superseded mid-drag
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        await getCurrentWebview().setZoom(factor);
        nativeZoomFactor = factor;
      } catch (error) {
        nativeZoomUnavailable = true;
        nativeZoomFactor = 1;
        console.warn("Webview zoom unavailable; scaling with CSS instead.", error);
        applyCssZoom(requestedFactor);
      }
    });
    return;
  }
  applyCssZoom(factor);
}

function applyCssZoom(factor: number): void {
  const body = document.body;
  if (!body) {
    // Applying --ui-scale now and the zoom later would size the shell larger
    // than the window in between, so defer the whole pair.
    document.addEventListener("DOMContentLoaded", () => applyCssZoom(factor), { once: true });
    return;
  }
  zoomFactor = factor;
  nativeZoomFactor = 1;
  // `zoom` isn't in the typed CSSStyleDeclaration; assign through a cast.
  (body.style as unknown as Record<string, string>).zoom = String(factor);
  document.documentElement.style.setProperty("--ui-scale", String(factor));
}

function clearCssZoom(): void {
  zoomFactor = 1;
  document.documentElement.style.setProperty("--ui-scale", "1");
  const body = document.body;
  if (body) (body.style as unknown as Record<string, string>).zoom = "";
}

export function saveAccent(hex: string): void {
  try {
    if (hexToRgb(hex)) localStorage.setItem(ACCENT_KEY, hex);
    else localStorage.removeItem(ACCENT_KEY);
  } catch { /* ignore */ }
  publishAppearance();
}

export function saveScale(percent: number): void {
  try { localStorage.setItem(SCALE_KEY, String(clampScale(percent))); } catch { /* ignore */ }
  publishAppearance();
}

// ── Theme mode (light / dark / system) ──────────────────────────────────────

function darkQuery(): MediaQueryList | null {
  try { return window.matchMedia?.("(prefers-color-scheme: dark)") ?? null; } catch { return null; }
}

/**
 * The stored mode, or null when this install has never chosen one.
 *
 * Null is distinct from the default: it tells the caller to fall back to the
 * `darkMode` boolean in the saved session, so upgrading doesn't flip the theme
 * out from under someone who had set it before this pref existed.
 */
export function loadThemeMode(): ThemeMode | null {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return raw === "light" || raw === "dark" || raw === "system" ? raw : null;
  } catch { return null; }
}

export function saveThemeMode(mode: ThemeMode): void {
  try { localStorage.setItem(THEME_KEY, mode); } catch { /* ignore */ }
  publishAppearance();
}

/** Whether `mode` means "dark" right now — reads the OS only for "system". */
export function resolveDark(mode: ThemeMode): boolean {
  if (mode === "system") return darkQuery()?.matches ?? false;
  return mode === "dark";
}

export function applyTheme(dark: boolean): void {
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

/**
 * Subscribe to OS light/dark changes. Fires regardless of the current mode, so
 * the caller must ignore it unless the mode is "system".
 */
export function watchSystemTheme(onChange: (dark: boolean) => void): () => void {
  const query = darkQuery();
  if (!query) return () => { /* no matchMedia */ };
  const handler = (e: MediaQueryListEvent) => onChange(e.matches);
  query.addEventListener("change", handler);
  return () => query.removeEventListener("change", handler);
}

// ── Row density + base text size ────────────────────────────────────────────

export function loadDensity(): RowDensity {
  try {
    const raw = localStorage.getItem(DENSITY_KEY);
    return raw === "compact" || raw === "normal" || raw === "relaxed" ? raw : DEFAULT_DENSITY;
  } catch { return DEFAULT_DENSITY; }
}

export function saveDensity(density: RowDensity): void {
  try { localStorage.setItem(DENSITY_KEY, density); } catch { /* ignore */ }
  publishAppearance();
}

export function loadFontSize(): number {
  try {
    const raw = localStorage.getItem(FONT_SIZE_KEY);
    return raw ? clampFontSize(parseInt(raw, 10)) : DEFAULT_FONT_SIZE;
  } catch { return DEFAULT_FONT_SIZE; }
}

export function saveFontSize(px: number): void {
  try { localStorage.setItem(FONT_SIZE_KEY, String(clampFontSize(px))); } catch { /* ignore */ }
  publishAppearance();
}

/**
 * Publish the row metrics the stylesheet needs. The table virtualizer takes the
 * same number through a prop rather than reading it back out of CSS, so both
 * must be driven from `rowHeightFor` to stay in step.
 */
export function applyMetrics(density: RowDensity, fontSize: number): void {
  const root = document.documentElement;
  root.style.setProperty("--row-h", `${rowHeightFor(density, fontSize)}px`);
  root.style.setProperty("--ui-font-size", `${clampFontSize(fontSize)}px`);
}

// ── Reduce motion ───────────────────────────────────────────────────────────

export function loadReduceMotion(): boolean {
  try { return localStorage.getItem(MOTION_KEY) === "1"; } catch { return false; }
}

export function saveReduceMotion(on: boolean): void {
  try {
    if (on) localStorage.setItem(MOTION_KEY, "1");
    else localStorage.removeItem(MOTION_KEY);
  } catch { /* ignore */ }
  publishAppearance();
}

/**
 * Opt into the reduced-motion rules from inside the app.
 *
 * The stylesheet already suppresses decorative animation under
 * `prefers-reduced-motion`; this sets an attribute those same rules also match,
 * so the toggle layers over the OS preference instead of replacing it. There is
 * deliberately no "force motion on" — the OS preference always wins.
 */
export function applyReduceMotion(on: boolean): void {
  const root = document.documentElement;
  if (on) root.dataset.motion = "reduce";
  else delete root.dataset.motion;
}

// ── UI font family ──────────────────────────────────────────────────────────

export function loadFont(): string {
  try { return localStorage.getItem(FONT_KEY) ?? ""; } catch { return ""; }
}

export function saveFont(stack: string): void {
  try {
    if (stack) localStorage.setItem(FONT_KEY, stack);
    else localStorage.removeItem(FONT_KEY);
  } catch { /* ignore */ }
  publishAppearance();
}

/** Drives both family tokens: --font for the shell, --vsc-font for the workbench. */
export function applyFont(stack: string): void {
  const root = document.documentElement;
  if (!stack) {
    root.style.removeProperty("--font");
    root.style.removeProperty("--vsc-font");
    return;
  }
  root.style.setProperty("--font", stack);
  root.style.setProperty("--vsc-font", stack);
}

/**
 * Apply every persisted appearance pref on startup, before first paint.
 *
 * The theme is applied here too so there is no flash of the wrong palette; the
 * return value hands the resolved mode back to the caller, which owns the
 * `darkMode` React state the rest of the app renders from.
 */
export function initAppearance(): ThemeMode | null {
  applyAccent(loadAccent());
  applyScale(loadScale());
  applyMetrics(loadDensity(), loadFontSize());
  applyReduceMotion(loadReduceMotion());
  applyFont(loadFont());
  // Apply the default too, not just a stored mode: the stylesheet's base
  // palette is the *light* one and dark is opt-in via [data-theme], so leaving
  // the attribute unset would render light while the state said dark. A session
  // `darkMode` from an install predating this pref overrides it just after.
  const mode = loadThemeMode();
  applyTheme(resolveDark(mode ?? DEFAULT_THEME_MODE));
  // Publish once on startup too, so a companion window opened later matches
  // even when nothing has been changed since it was last published.
  publishAppearance();
  return mode;
}
