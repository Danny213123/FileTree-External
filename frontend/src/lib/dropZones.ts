/**
 * Registry of drop targets for drags coming from the OS shell.
 *
 * Tauri intercepts a shell drag before the webview sees it and reports it
 * through `onDragDropEvent` with a window position instead, so HTML5 `ondrop`
 * never fires for a file dragged in from Explorer. App's native listener
 * hit-tests that position against the zones registered here, which lets any
 * view accept shell drops without knowing how they arrive.
 *
 * Drags that START inside the app (a row pulled out of the file table) do reach
 * the webview, so a zone still wants its own HTML5 handlers for those.
 */

const ATTR = "data-drop-zone";

export interface DropZone {
  /** The pointer entered, or moved within, the zone during a shell drag. */
  onOver?: () => void;
  /** The pointer left the zone, or the drag ended somewhere else. */
  onLeave?: () => void;
  /** Absolute paths dropped on the zone. */
  onDrop: (paths: string[]) => void;
}

const zones = new Map<HTMLElement, DropZone>();

/** Register `el` as a shell-drop target. Returns its unregister function. */
export function registerDropZone(el: HTMLElement, zone: DropZone): () => void {
  zones.set(el, zone);
  // Set here rather than in the caller's markup so the attribute can't drift
  // out of sync with the registry that `dropZoneAt` looks the element up in.
  el.setAttribute(ATTR, "");
  return () => {
    zones.delete(el);
    el.removeAttribute(ATTR);
  };
}

/** The innermost registered zone at a viewport point, if any. */
export function dropZoneAt(x: number, y: number): { el: HTMLElement; zone: DropZone } | null {
  const hit = document.elementFromPoint(x, y) as HTMLElement | null;
  const el = hit?.closest<HTMLElement>(`[${ATTR}]`) ?? null;
  const zone = el ? zones.get(el) : undefined;
  return el && zone ? { el, zone } : null;
}
