// Tool layer for the multi-agent chat. Defines the tool schemas sent to the
// model and executes tool calls against an AgentApi facade backed by the active
// workspace tab (scan data + file operations).
//
// Tools are split into a read-only SEARCH set (handled by the Search agent) and
// a mutating ACTION set (handled by the Action agent, approval-gated). Both run
// through the same `executeTool` against the same `AgentApi`.

import type { NodeRecord, ScanResult } from "../api/types";
import { fetchFileText, type WebFetchResult, type WebSearchResult } from "../api/client";
import { loadAiSettings } from "./aiSettings";
import { appendMemory, memoryBlock } from "./aiMemory";

export interface RunCommandResult {
  ok: boolean;
  exit_code?: number | null;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
  error?: string;
}

// Result of a bounded, read-only file read (GET /api/file-text + client-side
// offset/limit windowing). `truncated` is true when more content exists than was
// returned (either the server's ~64 KiB cap, or the client offset/limit window).
export interface ReadFileResult {
  ok: boolean;
  path?: string;
  content?: string;
  /** Number of lines returned in `content`. */
  lines?: number;
  /** Total characters available in the server's (already-capped) read. */
  total_chars?: number;
  truncated?: boolean;
  /** Line offset to pass next to continue reading (when truncated by limit). */
  next_offset?: number;
  binary?: boolean;
  error?: string;
}

export interface ReadFileOpts {
  /** 0-based line offset to start reading from. */
  offset?: number;
  /** Max lines to return from `offset`. */
  limit?: number;
  /** Hard cap on returned characters (defaults to ~64 KiB). */
  maxBytes?: number;
}

export interface AgentApi {
  getScanPath: () => string;
  getScanResult: () => ScanResult | null;
  getNodes: () => NodeRecord[];
  scanFolder: (path: string) => Promise<void>;
  refresh: () => Promise<void>;
  findDuplicates: (minSizeBytes: number, signal?: AbortSignal) => Promise<{ groups: { waste: number; files: { path: string; size: number }[] }[] }>;
  moveItems: (paths: string[], destination: string) => Promise<{ ok: boolean; error?: string }>;
  renameItem: (path: string, newName: string) => Promise<{ ok: boolean; error?: string }>;
  createFolder: (path: string) => Promise<{ ok: boolean; error?: string }>;
  reveal: (path: string) => Promise<void>;
  // Run an arbitrary shell command (approval-gated in the UI). Used for general
  // CLI work and, crucially, for deletions via the Recycle Bin recipe so the
  // model can report a real exit code instead of fabricating "moved to trash".
  // `shell` selects PowerShell (default) or cmd.
  runCommand: (command: string, cwd?: string, shell?: "powershell" | "cmd") => Promise<RunCommandResult>;
  // Read a bounded text window of a file (read-only). Scoped apis restrict reads
  // to the attached folder(s).
  readFile: (path: string, opts?: ReadFileOpts) => Promise<ReadFileResult>;
  // Create/overwrite a text file (Tier-2 mutating; implemented via run_command).
  writeFile: (path: string, content: string) => Promise<RunCommandResult>;
  // Replace `oldString` with `newString` in a file (Tier-2 mutating).
  editFile: (path: string, oldString: string, newString: string) => Promise<RunCommandResult>;
  // Approval-gated network fetch (Electron main IPC). Returns bounded text.
  webFetch: (url: string, opts?: { maxBytes?: number }) => Promise<WebFetchResult>;
  // Approval-gated, best-effort keyless web search.
  webSearch: (query: string) => Promise<WebSearchResult>;
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

export const MUTATING_TOOLS = new Set([
  "move_items",
  "rename_item",
  "create_folder",
  "run_command",
  "recycle_items",
  "write_file",
  "edit_file",
]);

// Read-only tools that nonetheless ALWAYS require explicit approval because they
// shell out or reach the network (so they can never run silently under
// auto-approve / allowlist). Kept in sync with ALWAYS_APPROVE_TOOLS in runtime.ts.
// These are NOT in MUTATING_TOOLS (they don't change the scanned tree) but they
// still surface a Tier-2 approval card.
export const APPROVAL_ONLY_TOOLS = new Set([
  "git_status",
  "git_diff",
  "git_log",
  "web_fetch",
  "web_search",
]);

// Build ONE resilient PowerShell batch that sends every given path to the
// Recycle Bin (recoverable). It continues past per-item failures, handles file
// vs folder, collects the failures, and exits non-zero if any item failed — so
// the model gets a real exit code instead of fabricating "moved to trash".
// Each path is single-quote-escaped (' -> '') for safe embedding in the array.
export function buildRecycleCommand(paths: string[]): string {
  const escaped = paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(",");
  return [
    "Add-Type -AssemblyName Microsoft.VisualBasic",
    `$paths = @(${escaped})`,
    "$failed = @()",
    "foreach ($p in $paths) {",
    "  try {",
    "    if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,'OnlyErrorDialogs','SendToRecycleBin') }",
    "    elseif (Test-Path -LiteralPath $p) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin') }",
    "    else { $failed += \"$p (not found)\" }",
    "  } catch { $failed += \"$p ($($_.Exception.Message))\" }",
    "}",
    "if ($failed.Count) { Write-Error ('Failed: ' + ($failed -join '; ')); exit 1 } else { Write-Output \"Recycled $($paths.Count) item(s).\"; exit 0 }",
  ].join("\n");
}

// Base64 the UTF-8 payload so arbitrary file content (quotes, newlines, $, etc.)
// can never break out of the PowerShell string or inject commands. The path is
// single-quote escaped. WriteAllText creates parent-existing files / overwrites.
function b64Utf8(s: string): string {
  // btoa needs latin1; encode UTF-8 first so non-ASCII survives the round-trip.
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// One PowerShell batch that writes `content` to `path` (create or overwrite),
// reporting a real exit code. Parent directory is created if missing.
export function buildWriteFileCommand(path: string, content: string): string {
  const p = `'${path.replace(/'/g, "''")}'`;
  const b = b64Utf8(content);
  return [
    `$p = ${p}`,
    `$bytes = [Convert]::FromBase64String('${b}')`,
    "$text = [Text.Encoding]::UTF8.GetString($bytes)",
    "$dir = Split-Path -LiteralPath $p -Parent",
    "if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }",
    "[IO.File]::WriteAllText($p, $text, (New-Object Text.UTF8Encoding $false))",
    "Write-Output \"Wrote $($text.Length) chars to $p\"",
  ].join("\n");
}

// One PowerShell batch that replaces every occurrence of `oldString` with
// `newString` in `path`, on the FULL on-disk content (not a truncated preview),
// and fails (exit 1) if the old text is not present.
export function buildEditFileCommand(path: string, oldString: string, newString: string): string {
  const p = `'${path.replace(/'/g, "''")}'`;
  const bOld = b64Utf8(oldString);
  const bNew = b64Utf8(newString);
  return [
    `$p = ${p}`,
    "if (-not (Test-Path -LiteralPath $p)) { Write-Error 'File not found'; exit 1 }",
    `$old = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${bOld}'))`,
    `$new = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${bNew}'))`,
    "$c = [IO.File]::ReadAllText($p)",
    "$count = ([regex]::Matches($c, [regex]::Escape($old))).Count",
    "if ($count -eq 0) { Write-Error 'old_string not found in file'; exit 1 }",
    "$c = $c.Replace($old, $new)",
    "[IO.File]::WriteAllText($p, $c, (New-Object Text.UTF8Encoding $false))",
    "Write-Output \"Replaced $count occurrence(s) in $p\"",
  ].join("\n");
}

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
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the text contents of a file (read-only). Returns a bounded window (the server caps reads at ~64 KiB). Use `offset` (0-based line number) and `limit` (max lines) to page through larger files; the result reports `truncated` and `next_offset` so you can continue.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute file path to read." },
          offset: { type: "integer", description: "0-based line to start from (default 0)." },
          limit: { type: "integer", description: "Max lines to return (default 400)." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description:
        "Search file CONTENTS in the current scan for a string or simple regex. Optionally restrict candidate files by `dir`, `glob`, or `ext`. Returns matches with path, line number and a snippet. Bounded: caps how many files are read and total bytes scanned, and reports `truncated` when limits were hit.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text or regex to find in file contents." },
          regex: { type: "boolean", description: "Treat `query` as a JS regular expression (default false = literal)." },
          dir: { type: "string", description: "Absolute folder to restrict the search to." },
          glob: { type: "string", description: "Filename wildcard filter, e.g. *.ts" },
          ext: { type: "string", description: "Extension filter, e.g. txt (no dot)." },
          max_results: { type: "integer", description: "Max matches to return (default 50, max 200)." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description: "Show `git status` for a git repository folder (read-only). Requires approval (runs a shell command).",
      parameters: {
        type: "object",
        properties: { dir: { type: "string", description: "Absolute path of the repo (defaults to the scanned folder)." } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "Show `git diff` (unstaged, or staged with staged=true) for a repo folder (read-only). Requires approval.",
      parameters: {
        type: "object",
        properties: {
          dir: { type: "string", description: "Absolute path of the repo (defaults to the scanned folder)." },
          staged: { type: "boolean", description: "Diff staged changes (--cached) instead of the working tree." },
          path: { type: "string", description: "Optional file/subpath to limit the diff to." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_log",
      description: "Show recent commits (`git log`) for a repo folder (read-only). Requires approval.",
      parameters: {
        type: "object",
        properties: {
          dir: { type: "string", description: "Absolute path of the repo (defaults to the scanned folder)." },
          count: { type: "integer", description: "How many commits to show (default 20, max 100)." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch the text content of a web URL (http/https). Requires approval (makes a network request). Returns bounded text.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "Absolute http(s) URL to fetch." } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for a query (best-effort, keyless). Requires approval. Returns a short list of result titles, URLs and snippets.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Search query." } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember",
      description: "Persist a short note to long-term memory so it is available in future chats (e.g. a user preference or an important fact). Read-only with respect to files.",
      parameters: {
        type: "object",
        properties: { note: { type: "string", description: "The fact to remember (kept brief)." } },
        required: ["note"],
      },
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
      name: "recycle_items",
      description:
        "Delete files and/or folders by sending them to the Windows Recycle Bin (recoverable). This is the ONLY way to delete — NEVER use run_command, Remove-Item, or rm to delete anything. Pass EVERY path you want to delete in a SINGLE call via the `paths` array (do NOT call this once per file); they are shown to the user as ONE approval card and recycled together, and you get back a real exit code (0 = all recycled). Never claim a file was deleted unless this returns exit 0.",
      parameters: {
        type: "object",
        properties: {
          paths: { type: "array", items: { type: "string" }, description: "Absolute paths of every file/folder to send to the Recycle Bin — include them all in this one call." },
        },
        required: ["paths"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command on the user's Windows machine (PowerShell by default). Every command is shown to the user for explicit approval before it runs, and you get back the real exit code plus captured stdout/stderr. Use this for general (non-delete) CLI work. " +
        "For deletions use recycle_items, never run_command (and never use Remove-Item or rm).",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The exact command line to run (PowerShell syntax by default)." },
          cwd: { type: "string", description: "Optional absolute working directory. Defaults to the scanned folder." },
          shell: { type: "string", enum: ["powershell", "cmd"], description: "Shell to use. Defaults to powershell." },
        },
        required: ["command"],
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
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create a new text file or OVERWRITE an existing one with the given content. Destructive: the user sees a diff preview and must approve. Use absolute paths.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path of the file to write." },
          content: { type: "string", description: "The full new text content of the file." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Edit an existing text file by replacing an exact substring. `old_string` must appear verbatim in the file. Destructive: the user sees a diff preview and must approve. To insert/append, read the file first and use write_file instead.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path of the file to edit." },
          old_string: { type: "string", description: "Exact existing text to replace." },
          new_string: { type: "string", description: "Replacement text." },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
];

// All tools (kept for single-agent fallbacks / back-compat).
export const TOOLS: ToolDef[] = [...SEARCH_TOOLS, ...ACTION_TOOLS];

const TOOL_BY_NAME = new Map<string, ToolDef>(TOOLS.map((t) => [t.function.name, t]));

// Required string fields where an EMPTY value is legitimate (edit_file deletes
// text by replacing with ""). Every other required string must be non-empty.
const EMPTY_OK_FIELDS = new Set(["new_string"]);

// Validate a MUTATING tool call's args against its declared schema BEFORE it
// executes: each `required` field must be present and of the right type (and
// non-empty for strings/arrays, the `new_string` deletion case aside). Returns
// an error message, or null when valid. This stops a malformed or silently-empty
// cloud tool call (e.g. a model emitting {} for recycle_items, or move_items
// with no destination) from running a destructive op with no real target.
function validateRequiredArgs(name: string, args: Record<string, unknown>): string | null {
  const params = TOOL_BY_NAME.get(name)?.function.parameters;
  const required = params?.required ?? [];
  if (!required.length) return null;
  const props = (params?.properties ?? {}) as Record<string, { type?: string }>;
  for (const field of required) {
    const v = args[field];
    if (v === undefined || v === null) return `missing required field: ${field}`;
    const type = props[field]?.type;
    if (type === "array") {
      if (!Array.isArray(v) || v.length === 0) return `missing required field: ${field} (expected a non-empty array)`;
    } else if (type === "string") {
      if (typeof v !== "string") return `invalid type for field: ${field} (expected a string)`;
      if (!v.trim() && !EMPTY_OK_FIELDS.has(field)) return `missing required field: ${field} (expected a non-empty string)`;
    } else if (type === "integer" || type === "number") {
      if (typeof v !== "number" || !Number.isFinite(v)) return `invalid type for field: ${field} (expected a number)`;
    } else if (type === "boolean") {
      if (typeof v !== "boolean") return `invalid type for field: ${field} (expected a boolean)`;
    }
  }
  return null;
}

function mb(bytes: number): number {
  return Math.round((bytes / 1e6) * 10) / 10;
}

// ── Path helpers (string-only, no fs) ────────────────────────
// Windows-safe normalization shared by every path comparison below: unify
// separators (/ → \), drop trailing separators, and lowercase (NTFS/Windows are
// case-insensitive). Comparing normalized forms is what makes the move guards
// reliable regardless of how a path was typed or which slash style it used.
export function normPath(p: string): string {
  return p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}
export function parentOf(p: string): string {
  const norm = p.replace(/[\\/]+$/, "");
  const idx = Math.max(norm.lastIndexOf("\\"), norm.lastIndexOf("/"));
  return idx > 0 ? norm.slice(0, idx) : norm;
}
export function eqPath(a: string, b: string): boolean {
  return normPath(a) === normPath(b);
}
export function underPath(child: string, dir: string): boolean {
  const c = normPath(child);
  const d = normPath(dir);
  return c === d || c.startsWith(d + "\\");
}
// True when moving `source` into `destination` would do nothing meaningful — or
// would be outright unsafe. Returns true when ANY of these hold:
//   • source IS the destination (dropping a folder onto itself),
//   • the destination lives inside the source (moving into your own descendant),
//   • the source already sits directly in the destination (same-folder no-op).
// Case-insensitive and separator-normalized so it behaves on Windows. Shared by
// the tree drag, the treemap drag, and the "Move to…" action so they all refuse
// the exact same no-ops instead of each guarding differently (or not at all).
export function isNoOpMove(source: string, destination: string): boolean {
  if (!source || !destination) return false;
  return (
    eqPath(source, destination) ||
    underPath(destination, source) ||
    eqPath(parentOf(source), destination)
  );
}

// Shared read-only file reader used by BOTH the real api (WorkspaceTab) and the
// scoped api (ChatPanel). Fetches the server's bounded text head (GET
// /api/file-text, ~64 KiB, scan-root gated) and applies a client-side line
// window (offset/limit) plus an optional hard byte cap, reporting truncation and
// the next line offset so the model can page. Scoping (which paths are allowed)
// is enforced by the caller BEFORE invoking this.
const READ_FILE_MAX_BYTES = 64 * 1024;
export async function readFileWindow(path: string, opts: ReadFileOpts = {}, signal?: AbortSignal): Promise<ReadFileResult> {
  if (!path) return { ok: false, error: "path required" };
  let preview: Awaited<ReturnType<typeof fetchFileText>>;
  try {
    preview = await fetchFileText(path, signal);
  } catch (e) {
    return { ok: false, path, error: (e as Error).message };
  }
  if (preview.binary) return { ok: true, path, binary: true, content: "", lines: 0 };
  let text = preview.text ?? "";
  const cap = Math.max(1, Math.min(opts.maxBytes ?? READ_FILE_MAX_BYTES, READ_FILE_MAX_BYTES));
  let capTruncated = false;
  if (text.length > cap) { text = text.slice(0, cap); capTruncated = true; }
  const allLines = text.split(/\r?\n/);
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const limit = opts.limit != null ? Math.max(1, Math.floor(opts.limit)) : 400;
  const windowLines = allLines.slice(offset, offset + limit);
  const moreLines = offset + limit < allLines.length;
  // Truncated if the server capped the file, our byte cap cut it, or there are
  // more lines beyond this window.
  const truncated = !!preview.truncated || capTruncated || moreLines;
  return {
    ok: true,
    path,
    content: windowLines.join("\n"),
    lines: windowLines.length,
    total_chars: text.length,
    truncated,
    next_offset: moreLines ? offset + limit : undefined,
  };
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

// ── Per-scan node index (perf) ───────────────────────────────
// find/list_dir/list_by_extension/list_largest used to re-scan and re-sort the
// full getNodes() array on every call. We build a reusable index ONCE per nodes
// array and cache it keyed on that array's identity (a WeakMap). The index is
// invalidated automatically whenever the scan changes, because a new scan yields
// a new nodes array reference (so callers must return a STABLE array per scan —
// WorkspaceTab memoizes it; the scoped api holds one array per build).
interface NodeIndex {
  /** Real items (id>0, has path), sorted by size descending — reused by find/list_largest. */
  bySizeDesc: NodeRecord[];
  /** normPath(parentDir) → immediate children. */
  byParent: Map<string, NodeRecord[]>;
}
const indexCache = new WeakMap<NodeRecord[], NodeIndex>();
export function getNodeIndex(nodes: NodeRecord[]): NodeIndex {
  const cached = indexCache.get(nodes);
  if (cached) return cached;
  const real = nodes.filter((n) => n.id > 0 && n.path);
  const bySizeDesc = [...real].sort((a, b) => b.size - a.size);
  const byParent = new Map<string, NodeRecord[]>();
  for (const n of real) {
    const key = normPath(parentOf(n.path));
    const arr = byParent.get(key);
    if (arr) arr.push(n);
    else byParent.set(key, [n]);
  }
  const idx: NodeIndex = { bySizeDesc, byParent };
  indexCache.set(nodes, idx);
  return idx;
}

// ── Content-match scorer (semantic groundwork) ───────────────
// `grep` ranks/keeps matches through a pluggable scorer. The default is a
// literal/regex matcher. This interface is the seam where an embeddings-backed
// ranker could later be dropped in (score by semantic similarity) without
// touching the grep plumbing — implement `score()` and pass it to runGrep.
export interface MatchScorer {
  /** Compile any per-query state (e.g. a RegExp, or later an embedding). */
  prepare(query: string, opts: { regex?: boolean }): void;
  /** Return a >0 score for a matching line, or 0/negative to reject it. */
  score(line: string): number;
}

class LiteralRegexScorer implements MatchScorer {
  private needle = "";
  private re: RegExp | null = null;
  prepare(query: string, opts: { regex?: boolean }): void {
    this.re = null;
    this.needle = query.toLowerCase();
    if (opts.regex) {
      try { this.re = new RegExp(query, "i"); } catch { this.re = null; }
    }
  }
  score(line: string): number {
    if (this.re) return this.re.test(line) ? 1 : 0;
    return line.toLowerCase().includes(this.needle) ? 1 : 0;
  }
}

// ── Scan context (shared by all agent prompts) ───────────────
// User project rules + persisted memory, read at run start and appended to every
// agent's system prompt. Empty string when neither is set.
function instructionsBlock(): string {
  const out: string[] = [];
  try {
    const rules = loadAiSettings().rules?.trim();
    if (rules) out.push("User project rules (follow these):\n" + rules);
  } catch { /* ignore */ }
  try {
    const mem = memoryBlock();
    if (mem) out.push(mem);
  } catch { /* ignore */ }
  return out.join("\n\n");
}

// `listTop` controls whether the embedded top-10 "Largest items" listing is
// included. Sub-agents pass `false` (stats-only) so this heavy, stale listing
// isn't re-embedded in every sub-agent system prompt across a turn — they read
// real data via tools anyway. The legacy single-agent prompt keeps it.
export function scanContext(api: AgentApi, opts: { listTop?: boolean } = {}): string {
  const listTop = opts.listTop ?? true;
  const result = api.getScanResult();
  const scanPath = api.getScanPath();
  if (!result) return "No folder is scanned yet. Use scan_folder to begin.";
  const lines: string[] = [];
  const root = api.getNodes().find((n) => n.id === 0);
  lines.push(`Current scan: ${scanPath || result.rootPath}`);
  if (root) lines.push(`Total: ${mb(root.size)} MB across ${root.files} files / ${root.folders} folders.`);
  if (listTop) {
    const top = api.getNodes()
      .filter((n) => n.id > 0 && n.path)
      .sort((a, b) => b.size - a.size)
      .slice(0, 10);
    if (top.length) {
      // Framed as stale hints, NOT a source of truth: this listing can be out of
      // date (files moved/deleted since the scan), so the model must confirm via
      // list_largest/find before quoting anything as a final answer.
      lines.push("Largest items (STALE HINTS from the last scan — do NOT quote these as final; always confirm current paths/sizes via list_largest/find):");
      for (const n of top) lines.push(`  ${n.dir ? "DIR " : "FILE"} ${n.path} - ${mb(n.size)} MB`);
    }
  } else {
    lines.push("Use the tools to read the file/folder listing — do not guess paths or sizes.");
  }
  const extra = instructionsBlock();
  if (extra) lines.push("", extra);
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
  const extra = instructionsBlock();
  if (extra) lines.push("", extra);
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
export async function executeTool(name: string, args: Record<string, unknown>, api: AgentApi, signal?: AbortSignal): Promise<unknown> {
  // Schema-level guard for destructive tools: never execute a mutating action
  // with missing/empty/wrong-typed required args (a silently-empty {} from the
  // model would otherwise act on nothing — or, for move/recycle, the wrong set).
  if (MUTATING_TOOLS.has(name)) {
    const invalid = validateRequiredArgs(name, args);
    if (invalid) return { ok: false, error: invalid };
  }
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
      const offset = Math.max(0, Number(args.offset) || 0);
      const filesOnly = !!args.files_only;
      const all = getNodeIndex(api.getNodes()).bySizeDesc.filter((n) => !filesOnly || !n.dir);
      const page = all.slice(offset, offset + count);
      const items = page.map((n) => ({ path: n.path, name: n.name, is_dir: n.dir, size_mb: mb(n.size) }));
      return paginate({ items }, all.length, offset, items.length);
    }
    case "find": {
      const query = String(args.query || "").toLowerCase();
      const glob = String(args.glob || "").toLowerCase();
      const dir = String(args.dir || "");
      const filesOnly = !!args.files_only;
      const limit = Math.min(Number(args.limit) || 30, 100);
      const offset = Math.max(0, Number(args.offset) || 0);
      if (!query && !glob) return { ok: false, error: "Provide a query or glob." };
      const matches = getNodeIndex(api.getNodes()).bySizeDesc
        .filter((n) => n.name)
        .filter((n) => (!filesOnly || !n.dir))
        .filter((n) => (!dir || underPath(n.path, dir)))
        .filter((n) => {
          const name = n.name.toLowerCase();
          if (glob) return wildcardMatch(glob, name);
          return name.includes(query);
        });
      const page = matches.slice(offset, offset + limit);
      const items = page.map((n) => ({ path: n.path, name: n.name, is_dir: n.dir, size_mb: mb(n.size) }));
      // Keep the legacy `total_matches`/`returned` fields plus the standard
      // pagination envelope so older prompts and the new ones both work.
      return { total_matches: matches.length, ...paginate({ items }, matches.length, offset, items.length) };
    }
    case "list_dir": {
      const dir = String(args.path || "");
      if (!dir) return { ok: false, error: "path required" };
      const limit = Math.min(Number(args.limit) || 200, 500);
      const offset = Math.max(0, Number(args.offset) || 0);
      const all = (getNodeIndex(api.getNodes()).byParent.get(normPath(dir)) ?? [])
        .slice()
        .sort((a, b) => b.size - a.size);
      const page = all.slice(offset, offset + limit);
      const children = page.map((n) => ({ name: n.name, is_dir: n.dir, size_mb: mb(n.size), path: n.path }));
      return { path: dir, count: children.length, ...paginate({ children }, all.length, offset, children.length) };
    }
    case "list_by_extension": {
      const result = api.getScanResult();
      const limit = Math.min(Number(args.limit) || 25, 100);
      const offset = Math.max(0, Number(args.offset) || 0);
      const all = result?.extensionStats ?? [];
      const page = all.slice(offset, offset + limit).map((s) => ({ ext: s.ext || "(none)", size_mb: mb(s.bytes), files: s.files }));
      return paginate({ extensions: page }, all.length, offset, page.length);
    }
    case "read_file": {
      const path = String(args.path || "");
      if (!path) return { ok: false, error: "path required" };
      const offset = Math.max(0, Number(args.offset) || 0);
      const limit = args.limit != null ? Math.max(1, Number(args.limit)) : undefined;
      return await api.readFile(path, { offset, limit });
    }
    case "grep": {
      return await runGrep(api, args, signal);
    }
    case "git_status":
    case "git_diff":
    case "git_log": {
      const dir = String(args.dir || api.getScanPath() || "").trim();
      if (!dir) return { ok: false, error: "No folder is scanned and no dir provided." };
      const command = buildGitCommand(name, args, dir);
      const res = await api.runCommand(command, dir);
      return { ...res, git: name };
    }
    case "web_fetch": {
      const url = String(args.url || "").trim();
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: "Provide an absolute http(s) URL." };
      return await api.webFetch(url);
    }
    case "web_search": {
      const query = String(args.query || "").trim();
      if (!query) return { ok: false, error: "query required" };
      return await api.webSearch(query);
    }
    case "remember": {
      const note = String(args.note || "").trim();
      if (!note) return { ok: false, error: "note required" };
      appendMemory(note);
      return { ok: true, remembered: note };
    }
    case "find_duplicates": {
      const minBytes = Math.max(0, (Number(args.min_size_mb) || 1) * 1e6);
      const res = await api.findDuplicates(minBytes, signal);
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
    case "recycle_items": {
      const raw = args.paths;
      const paths = Array.isArray(raw) ? raw.map((p) => String(p)).filter((p) => p.trim()) : [];
      if (!paths.length) return { ok: false, error: "paths required" };
      return await api.runCommand(buildRecycleCommand(paths));
    }
    case "run_command": {
      const command = String(args.command || "");
      if (!command.trim()) return { ok: false, error: "command required" };
      const cwd = args.cwd ? String(args.cwd) : undefined;
      // Forward the shell selector (the schema exposes it but it was previously
      // dropped, so `shell:"cmd"` silently ran under PowerShell).
      const shell = args.shell === "cmd" || args.shell === "powershell" ? args.shell : undefined;
      return await api.runCommand(command, cwd, shell);
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
    case "write_file": {
      const path = String(args.path || "");
      const content = typeof args.content === "string" ? args.content : String(args.content ?? "");
      if (!path) return { ok: false, error: "path required" };
      return await api.writeFile(path, content);
    }
    case "edit_file": {
      const path = String(args.path || "");
      const oldString = typeof args.old_string === "string" ? args.old_string : "";
      const newString = typeof args.new_string === "string" ? args.new_string : "";
      if (!path) return { ok: false, error: "path required" };
      if (!oldString) return { ok: false, error: "old_string required" };
      return await api.editFile(path, oldString, newString);
    }
    default:
      return { ok: false, error: `unknown tool ${name}` };
  }
}

// Standard pagination envelope so the model knows how much it got, how much
// exists, and how to fetch the rest. `key` is the array field name in `base`.
function paginate<T extends Record<string, unknown>>(
  base: T,
  total: number,
  offset: number,
  returned: number,
): T & { returned: number; total: number; truncated: boolean; next_offset: number | null } {
  const end = offset + returned;
  const truncated = end < total;
  return {
    ...base,
    returned,
    total,
    truncated,
    next_offset: truncated ? end : null,
  };
}

// Build a read-only git command for the requested subcommand. Output is parsed
// by the server's run-command; we just shape the argument string.
function buildGitCommand(tool: string, args: Record<string, unknown>, _dir: string): string {
  if (tool === "git_status") return "git status --porcelain=v1 -b";
  if (tool === "git_log") {
    const count = Math.min(Math.max(Number(args.count) || 20, 1), 100);
    return `git log --oneline -n ${count}`;
  }
  // git_diff
  const staged = args.staged ? " --cached" : "";
  const sub = args.path ? ` -- "${String(args.path).replace(/"/g, '\\"')}"` : "";
  return `git --no-pager diff${staged}${sub}`;
}

// Bounded content search across in-memory candidate files. Picks candidates from
// the scan tree (dir/glob/ext filters), reads each via api.readFile, and keeps
// lines the (pluggable) scorer accepts. Caps files read AND total bytes so a
// huge tree can never stall the turn; signals `truncated` when a cap was hit.
const GREP_MAX_FILES = 80;
const GREP_MAX_BYTES = 2 * 1024 * 1024;
const GREP_MAX_FILE_BYTES = 64 * 1024;

async function runGrep(
  api: AgentApi,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  scorer: MatchScorer = new LiteralRegexScorer(),
): Promise<unknown> {
  const query = String(args.query || "");
  if (!query) return { ok: false, error: "query required" };
  const dir = String(args.dir || "");
  const glob = String(args.glob || "").toLowerCase();
  const ext = String(args.ext || "").replace(/^\./, "").toLowerCase();
  const maxResults = Math.min(Math.max(Number(args.max_results) || 50, 1), 200);
  scorer.prepare(query, { regex: !!args.regex });

  const candidates = getNodeIndex(api.getNodes()).bySizeDesc.filter((n) => {
    if (n.dir) return false;
    if (dir && !underPath(n.path, dir)) return false;
    if (ext && (n.extension || "").toLowerCase().replace(/^\./, "") !== ext) return false;
    if (glob && !wildcardMatch(glob, n.name.toLowerCase())) return false;
    return true;
  });

  const matches: { path: string; line: number; snippet: string }[] = [];
  let filesRead = 0;
  let bytesRead = 0;
  let truncated = false;

  for (const node of candidates) {
    if (signal?.aborted) { truncated = true; break; }
    if (filesRead >= GREP_MAX_FILES || bytesRead >= GREP_MAX_BYTES) { truncated = true; break; }
    let res: ReadFileResult;
    try { res = await api.readFile(node.path, { maxBytes: GREP_MAX_FILE_BYTES }); }
    catch { continue; }
    if (!res.ok || res.binary || !res.content) continue;
    filesRead++;
    bytesRead += res.content.length;
    if (res.truncated) truncated = true;
    const lines = res.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (scorer.score(lines[i]) > 0) {
        matches.push({ path: node.path, line: i + 1, snippet: lines[i].trim().slice(0, 200) });
        if (matches.length >= maxResults) { truncated = true; break; }
      }
    }
    if (matches.length >= maxResults) break;
  }

  return {
    ok: true,
    query,
    matches,
    files_scanned: filesRead,
    candidates: candidates.length,
    returned: matches.length,
    truncated,
    note: truncated ? "Results capped — narrow with dir/glob/ext or a more specific query." : undefined,
  };
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
  // run_command (and the git_* tools that route through it) report their own
  // status from the real exit code, so handle them before the generic ok===false
  // shortcut (which would hide the exit/stderr).
  if (tool === "run_command" || tool === "git_status" || tool === "git_diff" || tool === "git_log" || tool === "write_file" || tool === "edit_file") {
    if (typeof r?.error === "string" && r.error) return r.error;
    const code = r?.exit_code;
    const codeLabel = code === null || code === undefined ? "?" : String(code);
    const firstLine = (s: unknown) => String(s ?? "").split(/\r?\n/).map((l) => l.trim()).find((l) => l.length) ?? "";
    if (r?.ok) {
      const out = firstLine(r.stdout);
      return out ? `exit ${codeLabel} · ${out}` : `exit ${codeLabel}`;
    }
    const err = firstLine(r?.stderr) || firstLine(r?.stdout);
    return err ? `exit ${codeLabel} · ${err}` : `exit ${codeLabel} (failed)`;
  }
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
    case "rename_item":
      return "renamed";
    case "create_folder":
      return "folder created";
    case "scan_folder":
      return "scanning…";
    case "reveal":
      return "opened in Explorer";
    case "read_file":
      return r.binary ? "binary (not text)" : `${r.lines ?? 0} lines${r.truncated ? " (truncated)" : ""}`;
    case "grep":
      return `${(r.matches as unknown[])?.length ?? 0} matches in ${r.files_scanned ?? 0} files`;
    case "web_fetch":
      return r.ok ? `fetched${r.truncated ? " (truncated)" : ""}` : String(r.error ?? "failed");
    case "web_search":
      return `${(r.results as unknown[])?.length ?? 0} results`;
    case "remember":
      return "noted";
    default:
      return "done";
  }
}

// Verbose, multi-line output for a tool result, rendered inside the approval
// card so the user can verify what actually happened. Only run_command produces
// output worth showing in full (the real stdout/stderr + exit code); everything
// else returns "" and the card falls back to its compact summary.
const COMMAND_OUTPUT_TOOLS = new Set(["run_command", "git_status", "git_diff", "git_log", "write_file", "edit_file"]);
export function formatToolOutput(tool: string, result: unknown): string {
  if (tool === "web_fetch") {
    const r = result as Record<string, unknown>;
    if (r?.ok === false) return String(r.error ?? "fetch failed");
    const text = String(r?.text ?? "").slice(0, 4000);
    return text + (r?.truncated ? "\n(output truncated)" : "");
  }
  if (!COMMAND_OUTPUT_TOOLS.has(tool)) return "";
  const r = result as Record<string, unknown>;
  if (typeof r?.error === "string" && r.error && r.exit_code === undefined && r.stdout === undefined) {
    return r.error;
  }
  const code = r?.exit_code;
  const lines: string[] = [`exit code: ${code === null || code === undefined ? "(none)" : code}`];
  const stdout = String(r?.stdout ?? "").replace(/\s+$/, "");
  const stderr = String(r?.stderr ?? "").replace(/\s+$/, "");
  if (stdout) lines.push("stdout:", stdout);
  if (stderr) lines.push("stderr:", stderr);
  if (r?.truncated) lines.push("(output truncated)");
  return lines.join("\n");
}
