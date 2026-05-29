import { useState, useCallback, useRef } from "react";
import { scanStreamUrl } from "../api/client";
import type { NodeRecord, ScanResult } from "../api/types";
import type { ScanOptions } from "../api/client";
import { getCached, setCached } from "../lib/scanCache";

// The backend omits children[] and path to save bandwidth.
// Multi-threaded scanning means array order != ID order, so we must use a Map for lookup.
// BFS from root ensures every parent's path is set before its children.
export function reconstructChildren<T extends ScanResult>(result: T): T {
  const nodes = result.nodes;

  // Build id→node map and init children arrays
  const byId = new Map<number, (typeof nodes)[0]>();
  for (const node of nodes) {
    node.children = [];
    byId.set(node.id, node);
  }

  // Wire up children relationships
  for (const node of nodes) {
    if (node.parent !== null && node.parent !== undefined) {
      byId.get(node.parent)?.children.push(node.id);
    }
  }

  // BFS from root to set paths in parent-first order
  const root = byId.get(0);
  if (root) {
    root.path = result.rootPath;
    const queue: (typeof nodes)[0][] = [root];
    for (let qi = 0; qi < queue.length; qi++) {
      const parent = queue[qi];
      const sep = parent.path.endsWith("\\") || parent.path.endsWith("/") ? "" : "\\";
      for (const childId of parent.children) {
        const child = byId.get(childId);
        if (child) {
          child.path = parent.path + sep + child.name;
          queue.push(child);
        }
      }
    }
  }

  return result;
}

export type ScanStatus = "idle" | "scanning" | "done" | "error" | "cancelled";

export interface ScanProgress {
  nodes: number;
  elapsed: number;
}

export interface UseScanReturn {
  data: ScanResult | null;
  status: ScanStatus;
  errorMessage: string;
  progress: ScanProgress | null;
  startScan: (opts: ScanOptions) => void;
  // Refresh: runs a new scan but never clears existing data mid-flight.
  // The tree stays fully visible; only the final result triggers a merge.
  startRefresh: (opts: ScanOptions) => Promise<ScanResult | null>;
  cancelScan: () => void;
}

// ── NDJSON stream parser ──────────────────────────────────────────────────────
// The server sends three line types:
//   {"type":"scanning","nodeCount":N,"elapsedMs":E}   — progress ping
//   {"type":"meta", "rootPath":"...", ...analytics...} — result header
//   {"type":"node", "id":N, "parent":N|null, ...}      — one per node
//   {"type":"done"}                                    — stream complete
//   {"type":"error","error":"..."}                     — scan failed
//
// Each line is a small JSON object (< 2 KB), so JSON.parse never sees a
// giant string and V8 never hits the string-length limit.

interface MetaLine extends Omit<ScanResult, "nodes"> {
  type: "meta";
}
interface NodeLine extends NodeRecord {
  type: "node";
}
interface DoneLine { type: "done"; }
interface ScanningLine { type: "scanning"; nodeCount: number; elapsedMs: number; }
interface ErrorLine { type: "error"; error: string; }

type StreamLine = MetaLine | NodeLine | DoneLine | ScanningLine | ErrorLine;

async function readNdjsonStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onProgress: (nodeCount: number, elapsed: number) => void,
): Promise<ScanResult> {
  const decoder = new TextDecoder();
  let buf = "";
  let meta: MetaLine | null = null;
  const nodes: NodeRecord[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const raw = JSON.parse(trimmed) as StreamLine;

      if (raw.type === "error") throw new Error(raw.error);
      if (raw.type === "scanning") {
        onProgress(raw.nodeCount, raw.elapsedMs);
        continue;
      }
      if (raw.type === "meta") {
        meta = raw;
        continue;
      }
      if (raw.type === "node") {
        const { type: _t, ...node } = raw;
        nodes.push(node as NodeRecord);
        continue;
      }
      if (raw.type === "done") break;
    }
  }

  if (!meta) throw new Error("Stream ended without meta line");

  const { type: _t, ...metaFields } = meta;
  const result: ScanResult = { ...metaFields, nodes };
  return reconstructChildren(result);
}

// ─────────────────────────────────────────────────────────────────────────────

export function useScan(): UseScanReturn {
  const [data, setData] = useState<ScanResult | null>(null);
  const [status, setStatus] = useState<ScanStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const cancelScan = useCallback(() => {
    if (controllerRef.current) {
      controllerRef.current.abort();
      controllerRef.current = null;
      setStatus("cancelled");
      setProgress(null);
    }
  }, []);

  const startScan = useCallback((opts: ScanOptions) => {
    if (controllerRef.current) return;

    // Serve from cache when available — avoids redundant network requests
    const cached = getCached(opts.path);
    if (cached) {
      console.log("[useScan] startScan CACHE HIT path=", opts.path, "nodes=", cached.nodes?.length);
      setData(cached);
      setStatus("done");
      setProgress(null);
      return;
    }
    console.log("[useScan] startScan CACHE MISS path=", opts.path, "— fetching from server");

    const controller = new AbortController();
    controllerRef.current = controller;
    setStatus("scanning");
    setErrorMessage("");
    setProgress(null);
    setData(null);

    const url = scanStreamUrl(opts);

    fetch(url, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const result = await readNdjsonStream(reader, (nodeCount, elapsed) => {
          setProgress({ nodes: nodeCount, elapsed });
        });
        console.log("[useScan] startScan DONE path=", opts.path, "nodes=", result.nodes?.length, "sample=", result.nodes?.slice(0,3).map(n=>`${n.name}:${n.size}B`));
        setCached(opts.path, result);
        setData(result);
        setStatus("done");
        setProgress(null);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setErrorMessage(err instanceof Error ? err.message : String(err));
        setStatus("error");
        setProgress(null);
      })
      .finally(() => {
        controllerRef.current = null;
      });
  }, []);

  // Refresh: runs a complete scan in background without ever clearing data.
  // Streams partial results but does NOT call setData on partials (tree stays stable).
  // Resolves with the final ScanResult (or null on error/cancel).
  const startRefresh = useCallback((opts: ScanOptions): Promise<ScanResult | null> => {
    if (controllerRef.current) {
      controllerRef.current.abort();
      controllerRef.current = null;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setStatus("scanning");
    setErrorMessage("");
    setProgress(null);
    // NOTE: we intentionally do NOT call setData(null) here

    const url = scanStreamUrl(opts);
    return fetch(url, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const result = await readNdjsonStream(reader, (nodeCount, elapsed) => {
          setProgress({ nodes: nodeCount, elapsed });
        });
        // Publish the final result so useEffect([data]) in WorkspaceTab can
        // drive the tree update through the same code path as startScan.
        // We do NOT clear data first (no setData(null)), so the tree never blanks.
        const folders = result.nodes?.filter(n=>n.dir).slice(0,5).map(n=>`${n.name}:size=${n.size},files=${n.files},folders=${n.folders}`) ?? [];
        console.log("[useScan] startRefresh DONE path=", opts.path, "nodes=", result.nodes?.length, "folders=", folders);
        setData(result);
        setStatus("done");
        setProgress(null);
        return result;
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return null;
        setErrorMessage(err instanceof Error ? err.message : String(err));
        setStatus("error");
        setProgress(null);
        return null;
      })
      .finally(() => {
        controllerRef.current = null;
      });
  }, []);

  return { data, status, errorMessage, progress, startScan, startRefresh, cancelScan };
}
