/**
 * Resolving a drag-and-drop onto filesystem paths.
 *
 * Two kinds of drag reach our drop zones: an in-app row drag out of the file
 * table (which carries the paths directly, see TreeTable's `onDragStart`) and a
 * drag in from the shell (which carries `File` objects that have to be resolved
 * through the Electron bridge, because the web `File` API deliberately hides
 * absolute paths).
 *
 * Under Tauri a shell drag never reaches a webview drop handler at all — it
 * arrives as bare paths through `onDragDropEvent` (see lib/dropZones), which
 * `resolveDroppedPaths` classifies.
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauriV2 } from "../api/v2";

/** MIME types an in-app row drag carries. */
const INTERNAL_PATH = "application/x-filetree-path";
const INTERNAL_PATHS = "application/x-filetree-paths";
const INTERNAL_FOLDER = "application/x-filetree-folder-path";

/** A dropped item resolved to an absolute path. `isDir` is best effort: the
 *  entries API reports it for shell drags, but a multi-row in-app drag doesn't
 *  say, so callers that must distinguish should treat it as a hint. */
export interface DroppedEntry {
  path: string;
  isDir: boolean;
  size: number;
}

/** True when a drag carries something resolvable to filesystem paths, so a drop
 *  zone can light up (and call `preventDefault`) only for drags it can accept. */
export function isPathDrag(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false;
  const types = Array.from(dt.types);
  return types.includes("Files") || types.includes(INTERNAL_PATH) || types.includes(INTERNAL_PATHS);
}

function pathForFile(file: File): string {
  const bridge = (window as unknown as { electronAPI?: { getPathForFile?: (f: File) => string } })
    .electronAPI?.getPathForFile;
  try {
    return bridge?.(file) || (file as unknown as { path?: string }).path || "";
  } catch {
    return (file as unknown as { path?: string }).path || "";
  }
}

/**
 * Resolve a drop to absolute paths.
 *
 * MUST be called synchronously from the `drop` handler — `DataTransfer.items`
 * are neutered as soon as it returns, so nothing here may await.
 */
export function readDroppedEntries(dt: DataTransfer | null | undefined): DroppedEntry[] {
  if (!dt) return [];

  // An in-app drag already knows its paths, and knows whether a single-item
  // drag was a folder.
  const multi = dt.getData(INTERNAL_PATHS);
  const single = dt.getData(INTERNAL_PATH);
  if (multi || single) {
    let paths: string[] = [];
    if (multi) {
      try { paths = JSON.parse(multi) as string[]; } catch { paths = single ? [single] : []; }
    } else {
      paths = [single];
    }
    const folder = dt.getData(INTERNAL_FOLDER);
    return paths
      .filter(Boolean)
      .map((path) => ({ path, isDir: path === folder, size: 0 }));
  }

  const entries: DroppedEntry[] = [];
  const items = dt.items ? Array.from(dt.items) : [];
  const fileList = dt.files ? Array.from(dt.files) : [];
  const count = Math.max(items.length, fileList.length);
  for (let i = 0; i < count; i++) {
    const item = items[i];
    const file = item?.getAsFile?.() ?? fileList[i] ?? null;
    if (!file) continue;
    const path = pathForFile(file);
    if (!path) continue;
    // The entries API reports directories directly; fall back to the heuristic
    // that Explorer hands folders over as a 0-byte, type-less File.
    const entry = item?.webkitGetAsEntry?.();
    const isDir = entry ? entry.isDirectory : file.size === 0 && file.type === "";
    entries.push({ path, isDir, size: file.size });
  }
  return entries;
}

/**
 * Classify bare paths from a native (Tauri) shell drop.
 *
 * Stats each path on the Rust side rather than guessing from the name: an
 * extension heuristic misreads folders like `node_modules`, `.git` or `v1.2`,
 * and files need a real size to show. Paths that vanished mid-drag are omitted.
 */
export async function resolveDroppedPaths(paths: string[]): Promise<DroppedEntry[]> {
  if (!isTauriV2() || paths.length === 0) return [];
  return invoke<DroppedEntry[]>("stat_dropped_paths", { paths });
}
