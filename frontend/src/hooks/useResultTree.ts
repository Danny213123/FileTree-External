import { useEffect, useMemo, useRef, useState } from "react";
import type { NodeRecord } from "../api/types";

/** Filtered matches are independent tree roots; opening one reveals its children. */
export function useResultTree(key: string, roots: NodeRecord[], load: (node: NodeRecord) => Promise<NodeRecord[]>, compare: (a: NodeRecord, b: NodeRecord) => number, onError: (error: unknown) => void) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [children, setChildren] = useState<Map<number, NodeRecord[]>>(new Map());
  const generation = useRef(0);
  const pending = useRef(new Set<number>());
  useEffect(() => {
    generation.current++;
    pending.current = new Set();
    setExpanded(new Set());
    setChildren(new Map());
    return () => { generation.current++; };
  }, [key]);
  const rows = useMemo(() => {
    const out: NodeRecord[] = [];
    const seen = new Set<number>();
    const visit = (node: NodeRecord, depth: number) => {
      if (seen.has(node.id)) return;
      seen.add(node.id);
      const nested = children.get(node.id);
      out.push({ ...node, depth, children: nested ? nested.map(child => child.id) : node.children });
      if (expanded.has(node.id)) [...(nested ?? [])].sort(compare).forEach(child => visit(child, depth + 1));
    };
    roots.forEach(node => visit(node, 0));
    return out;
  }, [roots, children, expanded, compare]);
  const toggle = (id: number) => {
    setExpanded(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    const node = rows.find(row => row.id === id);
    if (!node?.dir || children.has(id) || pending.current.has(id)) return;
    const current = generation.current;
    pending.current.add(id);
    void load(node).then(items => {
      if (current === generation.current) setChildren(previous => new Map(previous).set(id, items));
    }).catch(error => {
      if (current === generation.current) {
        setExpanded(previous => { const next = new Set(previous); next.delete(id); return next; });
        onError(error);
      }
    }).finally(() => { if (current === generation.current) pending.current.delete(id); });
  };
  return { rows, expanded, toggle, loadedDirs: new Set(children.keys()) };
}
