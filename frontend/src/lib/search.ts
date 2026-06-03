import type { NodeRecord, SortKey } from "../api/types";
import { compareNodes } from "../hooks/useTreeState";

/**
 * Shared search matcher used by both the activity-bar Search list and the
 * main-area results table. Case-insensitive substring match over BOTH the node
 * name AND its full path (so extension / folder-path queries hit), skipping
 * aggregated bundle nodes (id < 0). Matches are sorted by the active table
 * sort and capped at `limit`.
 *
 * Returns [] for queries shorter than 2 characters (after trim).
 */
export function searchNodes(
  nodeById: Map<number, NodeRecord>,
  query: string,
  sortKey: SortKey,
  sortDir: 1 | -1,
  limit: number,
): NodeRecord[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];

  const matches: NodeRecord[] = [];
  for (const node of nodeById.values()) {
    if (node.id < 0) continue; // skip aggregated bundle nodes
    if (node.name.toLowerCase().includes(q) || (node.path && node.path.toLowerCase().includes(q))) {
      matches.push(node);
    }
  }
  matches.sort((a, b) => compareNodes(a, b, sortKey, sortDir));
  return matches.slice(0, limit);
}
