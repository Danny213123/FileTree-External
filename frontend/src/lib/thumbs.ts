import type { NodeRecord } from "../api/types";

// Image/video extensions that have a server-side thumbnail. Shared by the hover
// tooltip, the inspector preview and the folder-thumbnail picker so the notion
// of "previewable media" stays consistent across the app (previously these sets
// were duplicated inline in NodeTooltip).
export const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "tif", "tiff", "avif", "heic"]);
export const VIDEO_EXTS = new Set(["mp4", "mkv", "mov", "avi", "wmv", "webm", "m4v", "flv"]);

export function isImage(ext: string): boolean { return IMAGE_EXTS.has(ext.toLowerCase()); }
export function isVideo(ext: string): boolean { return VIDEO_EXTS.has(ext.toLowerCase()); }

// Upper bound on nodes visited during a single folder DFS. Hovering a folder
// near the root of a huge scan would otherwise walk hundreds of thousands of
// nodes synchronously and jank the UI; once exceeded we return the best match
// found so far.
const MAX_VISITED = 20000;

/**
 * Pick a representative thumbnail for a folder: the path of the LARGEST
 * bookmarked image/video anywhere beneath it, or — if none are bookmarked — the
 * path of the largest image/video. Returns null when the folder holds no media.
 *
 * DFS walks the folder's descendants via `node.children` (looked up in
 * `nodeById`), skipping aggregated bundle nodes (id < 0). When a `cache` map is
 * supplied the result is memoized per folder id so repeated hovers don't re-walk
 * the subtree.
 */
export function pickFolderThumb(
  folderId: number,
  nodeById: Map<number, NodeRecord>,
  bookmarks: Set<string>,
  cache?: Map<number, string | null>,
): string | null {
  if (cache && cache.has(folderId)) return cache.get(folderId) ?? null;

  const root = nodeById.get(folderId);
  if (!root) {
    cache?.set(folderId, null);
    return null;
  }

  let bestBookmarked: NodeRecord | null = null;
  let bestAny: NodeRecord | null = null;
  let visited = 0;

  const stack: number[] = [...root.children];
  while (stack.length) {
    const id = stack.pop()!;
    if (id < 0) continue; // skip aggregated bundle nodes
    const node = nodeById.get(id);
    if (!node) continue;
    if (++visited > MAX_VISITED) break; // bail on very large folders, keep best-so-far

    if (node.dir) {
      for (const cid of node.children) stack.push(cid);
      continue;
    }
    if (!isImage(node.extension ?? "") && !isVideo(node.extension ?? "")) continue;

    if (!bestAny || node.size > bestAny.size) bestAny = node;
    if (node.path && bookmarks.has(node.path)) {
      if (!bestBookmarked || node.size > bestBookmarked.size) bestBookmarked = node;
    }
  }

  const pick = (bestBookmarked ?? bestAny)?.path ?? null;
  cache?.set(folderId, pick);
  return pick;
}
