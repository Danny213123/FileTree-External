import { uiZoom } from "./appearance";

/**
 * Geometry helpers for overlays — menus, popovers, tooltips, drag pills — that
 * measure the page and then position themselves with inline lengths.
 *
 * ## Why this exists
 *
 * Outside Tauri the UI-scale preference falls back to `zoom` on <body>. `zoom`
 * multiplies the used value of every length inside that subtree, but the DOM
 * measurement APIs (`getBoundingClientRect`, `clientX`, `innerWidth`) all
 * answer in real viewport pixels. So the obvious code
 *
 * ```ts
 * const rect = anchor.getBoundingClientRect();
 * <div style={{ position: "fixed", top: rect.bottom }} />
 * ```
 *
 * is wrong at any scale but 100%: the measured `rect.bottom` is already in
 * viewport pixels, and writing it back into a subtree with `zoom: 0.9` renders
 * it at `0.9 × rect.bottom`. Every overlay drifted toward the top-left, by more
 * the further down the window it was, and height budgets computed from
 * `innerHeight` were off by the same factor — which is what clipped the
 * dropdowns.
 *
 * `position: fixed` does not help: it makes the viewport the containing block,
 * but the offsets are still interpreted in the zoomed coordinate space.
 *
 * The desktop build zooms the webview itself, which rescales the CSS pixel so
 * both spaces coincide and these helpers become the identity — but placement
 * code should still go through them so it stays correct under the fallback.
 *
 * ## How to use it
 *
 * Do all placement maths in *local* space — the space inline styles are read
 * in. Convert the anchor with `localRect` and take the window size from
 * `localViewport`, then the arithmetic is uniform and the result can be written
 * straight to `style.top` / `style.left`.
 */

/** An anchor box in local (zoom-relative) pixels. */
export interface LocalRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

/**
 * An element's box converted from viewport pixels into the local pixels that an
 * inline `top`/`left`/`width` on an overlay is interpreted in.
 */
export function localRect(el: Element): LocalRect {
  const z = uiZoom() || 1;
  const r = el.getBoundingClientRect();
  return {
    top: r.top / z,
    right: r.right / z,
    bottom: r.bottom / z,
    left: r.left / z,
    width: r.width / z,
    height: r.height / z,
  };
}

/** The window's usable area, in the same local pixels as `localRect`. */
export function localViewport(): { width: number; height: number } {
  const z = uiZoom() || 1;
  return { width: window.innerWidth / z, height: window.innerHeight / z };
}

/**
 * A viewport point — a `clientX`/`clientY` pair from a mouse event — converted
 * into local pixels, for overlays that follow the cursor rather than an anchor.
 */
export function localPoint(clientX: number, clientY: number): { x: number; y: number } {
  const z = uiZoom() || 1;
  return { x: clientX / z, y: clientY / z };
}

/**
 * A cursor *distance* in viewport pixels, converted into local pixels.
 *
 * Drag-to-resize needs this: the pointer delta is measured on screen, but it is
 * added to a panel width that is applied as an inline length inside the zoomed
 * shell. Without the conversion the divider drifts away from the cursor — by
 * 11% per pixel dragged at 90% scale.
 */
export function localDelta(viewportPx: number): number {
  return viewportPx / (uiZoom() || 1);
}
