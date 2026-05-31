// Tool layer for the multi-agent chat. Defines the tool schemas sent to the
// model and executes tool calls against an AgentApi facade backed by the active
// workspace tab (scan data + file operations).
//
// Tools are split into a read-only SEARCH set (handled by the Search agent) and
// a mutating ACTION set (handled by the Action agent, approval-gated). Both run
// through the same `executeTool` against the same `AgentApi`.

import type { NodeRecord, ScanResult } from "../api/types";

export interface AgentApi {
  getScanPath: () => string;
  getScanResult: () => ScanResult | null;
  getNodes: () => NodeRecord[];
  scanFolder: (path: string) => Promise<void>;
  refresh: () => Promise<void>;
  findDuplicates: (minSizeBytes: number) => Promise<{ groups: { waste: number; files: { path: string; size: number }[] }[] }>;
  moveItems: (paths: string[], destination: string) => Promise<{ ok: boolean; error?: string }>;
  deleteItems: (paths: string[]) => Promise<{ ok: boolean; error?: string }>;
  renameItem: (path: string, newName: string) => Promise<{ ok: boolean; error?: string }>;
  createFolder: (path: string) => Promise<{ ok: boolean; error?: string }>;
  reveal: (path: string) => Promise<void>;
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export const MUTATING_TOOLS = new Set(["move_items", "delete_items", "rename_item", "create_folder"]);

// ── Read-only tools (Search agent) ───────────────────────────
export const SEARCH_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "get_stats",
      description: "Get totals for the current scan: scanned path, total size, file count and folder count.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_largest",
      description: "List the largest files and/or folders in the current scan, sorted by size descending.",
      parameters: {
        type: "object",
        properties: {
          count: { type: "integer", description: "How many items to return (default 15, max 40)." },
          files_only: { type: "boolean", description: "If true, only files (no folders)." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find",
      description: "Search the current scan for files/folders whose name matches. Use `glob` for wildcard patterns like *.png or report?.pdf, or `query` for a case-insensitive substring. Optionally restrict to a sub-folder with `dir`.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Case-insensitive substring to match in the name." },
          glob: { type: "string", description: "Wildcard pattern matched against the name, e.g. *.mp4" },
          dir: { type: "string", description: "Absolute folder path to restrict the search to." },
          files_only: { type: "boolean", description: "If true, only files (no folders)." },
          limit: { type: "integer", description: "Max results (default 30, max 100)." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List the immediate children (files and folders) of a folder in the current scan.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute folder path." } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_by_extension",
      description: "Summarize disk usage grouped by file extension for the current scan.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "find_duplicates",
      description: "Find duplicate files (identical content) in the current scan. Returns duplicate groups with wasted space.",
      parameters: {
        type: "object",
        properties: { min_size_mb: { type: "number", description: "Ignore files smaller than this many MB (default 1)." } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scan_folder",
      description: "Scan (open) a different folder or drive by absolute path. Use when the user wants to analyze another location.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute path to scan, e.g. C:\\\\Users\\\\me\\\\Downloads" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reveal",
      description: "Open a file or folder in Windows Explorer.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
];

// ── Mutating tools (Action agent) ────────────────────────────
export const ACTION_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "move_items",
      description: "Move one or more files/folders into a destination folder. Destructive: requires user confirmation.",
      parameters: {
        type: "object",
        properties: {
          paths: { type: "array", items: { type: "string" }, description: "Absolute source paths to move." },
          destination: { type: "string", description: "Absolute destination folder." },
        },
        required: ["paths", "destination"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_items",
      description: "Send files/folders to the Recycle Bin. Destructive: requires user confirmation.",
      parameters: {
        type: "object",
        properties: { paths: { type: "array", items: { type: "string" }, description: "Absolute paths to delete." } },
        required: ["paths"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rename_item",
      description: "Rename a single file or folder. Destructive: requires user confirmation.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path of the item to rename." },
          new_name: { type: "string", description: "New base name (not a full path)." },
        },
        required: ["path", "new_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_folder",
      description: "Create a new folder at an absolute path. Requires user confirmation.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute path of the folder to create." } },
        required: ["path"],
      },
    },
  },
];

// All tools (kept for single-agent fallbacks / back-compat).
export const TOOLS: ToolDef[] = [...SEARCH_TOOLS, ...ACTION_TOOLS];

function mb(bytes: number): number {
  return Math.round((bytes / 1e6) * 10) / 10;
}

// ── Path helpers (string-only, no fs) ────────────────────────
function parentOf(p: string): string {
  const norm = p.replace(/[\\/]+$/, "");
  const idx = Math.max(norm.lastIndexOf("\\"), norm.lastIndexOf("/"));
  return idx > 0 ? norm.slice(0, idx) : norm;
}
function eqPath(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();
}
function underPath(child: string, dir: string): boolean {
  const c = child.replace(/[\\/]+$/, "").toLowerCase();
  const d = dir.replace(/[\\/]+$/, "").toLowerCase();
  return c === d || c.startsWith(d + "\\") || c.startsWith(d + "/");
}

// Two-pointer wildcard match (* and ?), mirrors the Rust backend matcher.
export function wildcardMatch(pattern: string, value: string): boolean {
  const p = pattern, v = value;
  let pi = 0, vi = 0, star = -1, match = 0;
  while (vi < v.length) {
    if (pi < p.length && (p[pi] === "?" || p[pi] === v[vi])) {
      pi++; vi++;
    } else if (pi < p.length && p[pi] === "*") {
      star = pi; match = vi; pi++;
    } else if (star >= 0) {
      pi = star + 1; match++; vi = match;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === "*") pi++;
  return pi === p.length;
}

// ── Scan context (shared by all agent prompts) ───────────────
export function scanContext(api: AgentApi): string {
  const result = api.getScanResult();
  const scanPath = api.getScanPath();
  if (!result) return "No folder is scanned yet. Use scan_folder to begin.";
  const lines: string[] = [];
  const root = api.getNodes().find((n) => n.id === 0);
  lines.push(`Current scan: ${scanPath || result.rootPath}`);
  if (root) lines.push(`Total: ${mb(root.size)} MB across ${root.files} files / ${root.folders} folders.`);
  const top = api.getNodes()
    .filter((n) => n.id > 0 && n.path)
    .sort((a, b) => b.size - a.size)
    .slice(0, 10);
  if (top.length) {
    lines.push("Largest items:");
    for (const n of top) lines.push(`  ${n.dir ? "DIR " : "FILE"} ${n.path} - ${mb(n.size)} MB`);
  }
  return lines.join("\n");
}

// Minimal context for the Orchestrator: it should PLAN and DELEGATE, not answer
// from data it happens to hold. So it gets the scan root + totals only — never
// the file/folder listing — which forces it through the Search agent for any
// specifics (what's largest, duplicates, contents, sizes).
export function scanSummary(api: AgentApi): string {
  const result = api.getScanResult();
  const scanPath = api.getScanPath();
  if (!result) return "No folder is scanned yet. Delegate a scan to the Search agent before answering.";
  const root = api.getNodes().find((n) => n.id === 0);
  const lines: string[] = [`Current scan: ${scanPath || result.rootPath}`];
  if (root) lines.push(`Total: ${mb(root.size)} MB across ${root.files} files / ${root.folders} folders.`);
  lines.push("You do NOT have the file or folder listing — only the Search agent can read it.");
  return lines.join("\n");
}

// Legacy single-agent prompt (kept for fallback paths).
export function buildSystemPrompt(api: AgentApi): string {
  return [
    "You are FileTree's built-in disk assistant. You help the user understand and clean up disk usage.",
    "You can call tools to read scan data and to act on files. Prefer reading data before acting.",
    "Destructive actions (move, delete, rename, create folder) are shown to the user for explicit approval, so propose them when helpful.",
    "Always use absolute Windows paths exactly as they appear in the scan. Be concise.",
    "",
    scanContext(api),
  ].join("\n");
}

function asArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return (raw as Record<string, unknown>) ?? {};
}

export interface ToolCallView {
  name: string;
  args: Record<string, unknown>;
  mutating: boolean;
}

export function describeToolCall(name: string, rawArgs: unknown): ToolCallView {
  return { name, args: asArgs(rawArgs), mutating: MUTATING_TOOLS.has(name) };
}

// Execute a tool call and return a compact JSON-serializable result to feed back
// to the model as a role:"tool" message.
export async function executeTool(name: string, args: Record<string, unknown>, api: AgentApi): Promise<unknown> {
  switch (name) {
    case "get_stats": {
      const result = api.getScanResult();
      const root = api.getNodes().find((n) => n.id === 0);
      if (!result || !root) return { scanned: false, note: "No folder scanned yet." };
      return {
        scanned: true,
        path: api.getScanPath() || result.rootPath,
        total_mb: mb(root.size),
        files: root.files,
        folders: root.folders,
      };
    }
    case "list_largest": {
      const count = Math.min(Number(args.count) || 15, 40);
      const filesOnly = !!args.files_only;
      const items = api.getNodes()
        .filter((n) => n.id > 0 && n.path && (!filesOnly || !n.dir))
        .sort((a, b) => b.size - a.size)
        .slice(0, count)
        .map((n) => ({ path: n.path, name: n.name, is_dir: n.dir, size_mb: mb(n.size) }));
      return { items };
    }
    case "find": {
      const query = String(args.query || "").toLowerCase();
      const glob = String(args.glob || "").toLowerCase();
      const dir = String(args.dir || "");
      const filesOnly = !!args.files_only;
      const limit = Math.min(Number(args.limit) || 30, 100);
      if (!query && !glob) return { ok: false, error: "Provide a query or glob." };
      const matches = api.getNodes()
        .filter((n) => n.id > 0 && n.path && n.name)
        .filter((n) => (!filesOnly || !n.dir))
        .filter((n) => (!dir || underPath(n.path, dir)))
        .filter((n) => {
          const name = n.name.toLowerCase();
          if (glob) return wildcardMatch(glob, name);
          return name.includes(query);
        })
        .sort((a, b) => b.size - a.size);
      const items = matches.slice(0, limit).map((n) => ({ path: n.path, name: n.name, is_dir: n.dir, size_mb: mb(n.size) }));
      return { total_matches: matches.length, returned: items.length, items };
    }
    case "list_dir": {
      const dir = String(args.path || "");
      if (!dir) return { ok: false, error: "path required" };
      const children = api.getNodes()
        .filter((n) => n.id > 0 && n.path && eqPath(parentOf(n.path), dir))
        .sort((a, b) => b.size - a.size)
        .slice(0, 200)
        .map((n) => ({ name: n.name, is_dir: n.dir, size_mb: mb(n.size), path: n.path }));
      return { path: dir, count: children.length, children };
    }
    case "list_by_extension": {
      const result = api.getScanResult();
      const stats = (result?.extensionStats ?? []).slice(0, 25).map((s) => ({ ext: s.ext || "(none)", size_mb: mb(s.bytes), files: s.files }));
      return { extensions: stats };
    }
    case "find_duplicates": {
      const minBytes = Math.max(0, (Number(args.min_size_mb) || 1) * 1e6);
      const res = await api.findDuplicates(minBytes);
      const groups = res.groups.slice(0, 20).map((g) => ({
        waste_mb: mb(g.waste),
        files: g.files.map((f) => f.path),
      }));
      const totalWaste = res.groups.reduce((s, g) => s + g.waste, 0);
      return { group_count: res.groups.length, total_waste_mb: mb(totalWaste), groups };
    }
    case "scan_folder": {
      const path = String(args.path || "");
      if (!path) return { ok: false, error: "path required" };
      await api.scanFolder(path);
      return { ok: true, note: `Started scanning ${path}. Data will refresh shortly.` };
    }
    case "reveal": {
      const path = String(args.path || "");
      if (!path) return { ok: false, error: "path required" };
      await api.reveal(path);
      return { ok: true };
    }
    case "move_items": {
      const paths = (args.paths as string[]) ?? [];
      const destination = String(args.destination || "");
      return await api.moveItems(paths, destination);
    }
    case "delete_items": {
      const paths = (args.paths as string[]) ?? [];
      return await api.deleteItems(paths);
    }
    case "rename_item": {
      const path = String(args.path || "");
      const newName = String(args.new_name || "");
      return await api.renameItem(path, newName);
    }
    case "create_folder": {
      const path = String(args.path || "");
      return await api.createFolder(path);
    }
    default:
      return { ok: false, error: `unknown tool ${name}` };
  }
}

// Turn a read-only tool result into a readable, multi-line findings string with
// the REAL paths and sizes. Used as a deterministic fallback: if a weak model
// forces a tool but then refuses to phrase an answer, the runtime still returns
// these actual findings instead of nothing (and never fabricated data).
export function formatFindings(tool: string, result: unknown): string {
  const r = result as Record<string, unknown>;
  if (r?.ok === false) return `Could not read the folder (${tool}): ${String(r.error ?? "unknown error")}.`;
  const sz = (x: Record<string, unknown>) => (typeof x.size_mb === "number" ? ` — ${x.size_mb} MB` : "");
  const kind = (x: Record<string, unknown>) => (x.is_dir ? "DIR " : "FILE");
  switch (tool) {
    case "list_largest": {
      const items = (r.items as Record<string, unknown>[]) ?? [];
      if (!items.length) return "No files were found in the current scan. Make sure a folder has been scanned first.";
      return ["Largest items in the scan:", ...items.map((it) => `- ${kind(it)} ${it.path}${sz(it)}`)].join("\n");
    }
    case "find": {
      const items = (r.items as Record<string, unknown>[]) ?? [];
      if (!items.length) return "No files in the current scan matched that search.";
      return [`Found ${r.total_matches ?? items.length} match(es):`, ...items.map((it) => `- ${kind(it)} ${it.path}${sz(it)}`)].join("\n");
    }
    case "list_dir": {
      const items = (r.children as Record<string, unknown>[]) ?? [];
      if (!items.length) return `No entries were found under ${String(r.path ?? "that folder")}.`;
      return [`Contents of ${String(r.path ?? "")}:`, ...items.map((it) => `- ${kind(it)} ${it.path}${sz(it)}`)].join("\n");
    }
    case "find_duplicates": {
      const groups = (r.groups as { waste_mb?: number; files?: string[] }[]) ?? [];
      if (!groups.length) return "No duplicate files were found in the current scan.";
      const lines = [`${r.group_count ?? groups.length} duplicate group(s), ~${r.total_waste_mb ?? 0} MB wasted:`];
      for (const g of groups.slice(0, 10)) {
        lines.push(`- duplicate set (~${g.waste_mb ?? 0} MB reclaimable):`);
        for (const p of g.files ?? []) lines.push(`    ${p}`);
      }
      return lines.join("\n");
    }
    case "list_by_extension": {
      const exts = (r.extensions as Record<string, unknown>[]) ?? [];
      if (!exts.length) return "No extension breakdown is available for the current scan.";
      return ["Disk usage by extension:", ...exts.map((e) => `- ${e.ext}: ${e.size_mb} MB (${e.files} files)`)].join("\n");
    }
    case "get_stats":
      return r.scanned
        ? `Current scan: ${String(r.path)} — ${r.total_mb} MB across ${r.files} files / ${r.folders} folders.`
        : "No folder is scanned yet.";
    default:
      return "";
  }
}

// Compact, human-readable one-liner shown on the tool step card and fed to the
// orchestrator when summarizing a sub-agent's work.
export function summarizeToolResult(tool: string, result: unknown): string {
  const r = result as Record<string, unknown>;
  if (r?.ok === false) return String(r.error ?? "failed");
  switch (tool) {
    case "get_stats":
      return r.scanned ? `${r.total_mb} MB, ${r.files} files` : "no scan";
    case "find_duplicates":
      return `${r.group_count ?? 0} groups, ${r.total_waste_mb ?? 0} MB wasted`;
    case "list_largest":
      return `${(r.items as unknown[])?.length ?? 0} items`;
    case "find":
      return `${r.total_matches ?? 0} matches`;
    case "list_dir":
      return `${r.count ?? 0} children`;
    case "list_by_extension":
      return `${(r.extensions as unknown[])?.length ?? 0} extensions`;
    case "move_items":
      return "moved";
    case "delete_items":
      return "deleted";
    case "rename_item":
      return "renamed";
    case "create_folder":
      return "folder created";
    case "scan_folder":
      return "scanning…";
    case "reveal":
      return "opened in Explorer";
    default:
      return "done";
  }
}
