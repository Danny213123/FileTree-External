// Theme customization: accent color + UI font-size scaling (#50).
//
// Both prefs are persisted in localStorage (like the other lightweight UI
// toggles) and applied at runtime by overriding CSS variables on :root / zooming
// the webview. Applying on load (before paint) avoids a flash.

import { isTauriV2 } from "../api/v2";

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
}

export function saveScale(percent: number): void {
  try { localStorage.setItem(SCALE_KEY, String(clampScale(percent))); } catch { /* ignore */ }
}

/** Apply both persisted prefs on startup. */
export function initAppearance(): void {
  applyAccent(loadAccent());
  applyScale(loadScale());
}
