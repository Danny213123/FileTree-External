// Multi-agent orchestration. The orchestrator is an LLM loop whose only tools
// are delegation calls; each delegation spawns a specialized sub-agent loop
// (read-only Search or mutating Action) and feeds its summarized findings back.
// The orchestrator never touches the filesystem itself.

import {
  ACTION_TOOLS,
  SEARCH_TOOLS,
  executeTool,
  formatFindings,
  normPath,
  scanContext,
  scanSummary,
  summarizeToolResult,
  type AgentApi,
  type ToolDef,
} from "../agent";
import type { LlmImage, LlmMessage } from "../llm";
import { runAgent } from "./runtime";
import type { AgentFacts, AgentSpec, RunContext, RunResult, StepStatus } from "./types";

function stepStatusOf(result: unknown): StepStatus {
  return (result as { ok?: boolean })?.ok === false ? "error" : "done";
}

// Harvest machine-readable facts (real paths + counts) from a tool result into
// the run accumulator, so the orchestrator gets structured findings — not just
// the sub-agent's prose. Shared by both sub-agents.
function extractAgentFacts(tool: string, result: unknown, acc: AgentFacts): void {
  const r = result as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return;
  const pushPath = (p: unknown) => {
    if (typeof p === "string" && p && acc.paths.length < 60 && !acc.paths.includes(p)) acc.paths.push(p);
  };
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  for (const it of arr(r.items)) pushPath((it as { path?: unknown })?.path);
  for (const it of arr(r.children)) pushPath((it as { path?: unknown })?.path);
  for (const m of arr(r.matches)) pushPath((m as { path?: unknown })?.path);
  for (const g of arr(r.groups)) {
    for (const f of arr((g as { files?: unknown }).files)) {
      pushPath(typeof f === "string" ? f : (f as { path?: unknown })?.path);
    }
  }
  if (typeof r.path === "string") pushPath(r.path);
  if (typeof r.total === "number") acc.counts[`${tool}_total`] = r.total;
  if (typeof r.total_matches === "number") acc.counts.matches = r.total_matches as number;
  if (typeof r.group_count === "number") acc.counts.duplicate_groups = r.group_count as number;
  if (typeof r.total_waste_mb === "number") acc.counts.waste_mb = r.total_waste_mb as number;
}

// Build the context note handed to a sub-agent so it sees the overall request
// and a digest of prior turns — not just its bare delegated task.
function subAgentContext(ctx: RunContext): LlmMessage[] {
  const parts: string[] = [];
  if (ctx.userTask) parts.push(`The user's overall request this turn: ${ctx.userTask}`);
  if (ctx.priorDigest) parts.push(`Relevant context from earlier in the conversation:\n${ctx.priorDigest}`);
  if (!parts.length) return [];
  return [{ role: "user", content: parts.join("\n\n") }];
}

// Route a tool call: known built-in tools go through executeTool; anything else
// is treated as an MCP tool and dispatched through the run context's MCP bridge.
async function runToolOrMcp(
  name: string,
  args: Record<string, unknown>,
  ctx: RunContext,
  builtins: Set<string>,
): Promise<unknown> {
  if (builtins.has(name)) return executeTool(name, args, ctx.api, ctx.signal);
  if (ctx.runMcpTool) return ctx.runMcpTool(name, args);
  return { ok: false, error: `unknown tool ${name}` };
}

const SEARCH_TOOL_NAMES = new Set(SEARCH_TOOLS.map((t) => t.function.name));
const ACTION_TOOL_NAMES = new Set([...SEARCH_TOOLS, ...ACTION_TOOLS].map((t) => t.function.name));

// Read-only tool names. The Search agent's findings are only trustworthy if at
// least one of these actually executed.
const READ_ONLY_TOOLS = new Set(SEARCH_TOOLS.map((t) => t.function.name));

// Does the user's request require real file data? The orchestrator holds no
// file listing, so any question about files/sizes/space/etc. must go through
// the Search agent before it can be answered.
const FILE_INTENT_RE =
  /\b(file|files|folder|folders|directory|directories|dir|subfolder|size|sizes|sized|large|larger|largest|big|bigger|biggest|huge|small|smaller|smallest|space|disk|storage|occupy|occupying|taking up|duplicate|duplicates|dupe|dupes|redundant|delete|deleting|remove|removing|clean|cleanup|free up|extension|extensions|contents?|inside|what'?s in|list|scan|video|videos|image|images|photo|photos|document|documents|download|downloads)\b/i;

// Concrete file specifics (a drive path, a "NNN MB" size, or a real-looking
// filename.ext) that the orchestrator could only have produced from a tool
// result. If these appear without a search having run, they were invented.
const SPECIFICS_RE =
  /[A-Za-z]:\\|\b\d+(?:\.\d+)?\s?(?:[KMGT]i?B|bytes?)\b|\b[\w()\-. ]+\.(?:exe|msi|zip|tar|gz|tgz|7z|rar|iso|mp4|mov|mkv|avi|webm|m4v|wmv|png|jpe?g|gif|webp|bmp|pdf|docx?|xlsx?|pptx?|txt|csv|json|dll|psd|ai|wav|mp3|flac|dmg)\b/i;

function needsRealData(task: string, finalText: string): boolean {
  return FILE_INTENT_RE.test(task) || SPECIFICS_RE.test(finalText);
}

// Does the user's request ask for an actual file change (not just a question)?
// Used to nudge the orchestrator to follow through with delegate_to_action
// after Search has located the files, instead of stopping at the listing.
const ACTION_INTENT_RE =
  /\b(delete|deleting|delete'?s|remove|removing|move|moving|clean|cleaning|cleanup|clean up|free up|freeing|rename|renaming|organi[sz]e|organi[sz]ing|trash|purge|get rid of|tidy|consolidate)\b/i;

// Deterministically pick the most relevant read-only tool (and args) for a
// natural-language task. Used when a weak model refuses to call a tool itself,
// so the runtime can fetch real data without the model's cooperation. Always
// resolves to a read-only tool — never a mutating one.
function chooseSearchTool(task: string): { name: string; args: Record<string, unknown> } {
  const t = task.toLowerCase();
  if (/\b(duplicate|duplicates|dupe|dupes|identical|redundant|copies)\b/.test(t)) {
    return { name: "find_duplicates", args: {} };
  }
  if (/\b(extension|extensions|file ?type|by type|grouped by)\b/.test(t)) {
    return { name: "list_by_extension", args: {} };
  }
  const pathMatch = task.match(/[A-Za-z]:\\[^\n"]+/);
  if (pathMatch && /\b(content|contents|inside|list|under|what'?s in|files? in)\b/.test(t)) {
    return { name: "list_dir", args: { path: pathMatch[0].trim().replace(/[).,;]+$/, "") } };
  }
  const ext = t.match(/\*?\.([a-z0-9]{1,5})\b/);
  if (ext && /\b(find|all|search|every|list|videos?|images?|photos?|documents?)\b|\*?\.[a-z0-9]/.test(t)) {
    const glob = ext[0].startsWith("*") ? ext[0] : "*" + ext[0];
    return { name: "find", args: { glob } };
  }
  // Default: the largest items — covers "largest", "biggest", "most space",
  // "what's taking up room", and generic "what can I delete".
  const filesOnly = /\bfiles?\b/.test(t) && !/\bfolders?\b/.test(t);
  const num = t.match(/\b(\d{1,2})\b/);
  const count = num ? Math.min(Math.max(Number(num[1]), 1), 40) : 15;
  return { name: "list_largest", args: { count, files_only: filesOnly } };
}

// Models sometimes return the delegation task as an object (e.g. {"query": …})
// instead of a plain string. Coerce robustly so the sub-agent receives real
// text and the UI never shows "[object Object]".
function coerceTask(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["task", "query", "description", "text", "prompt", "instruction", "request", "goal"]) {
      const val = o[k];
      if (typeof val === "string" && val.trim()) return val.trim();
    }
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return v == null ? "" : String(v).trim();
}

// ── Sub-agents ───────────────────────────────────────────────
export function searchSpec(api: AgentApi, extraTools: ToolDef[] = []): AgentSpec {
  const builtins = SEARCH_TOOL_NAMES;
  const mcpLine = extraTools.length
    ? "Additional external (MCP) tools are available; use them when relevant to gather information.\n"
    : "";
  return {
    agent: "search",
    maxSteps: 8,
    tools: [...SEARCH_TOOLS, ...extraTools],
    systemPrompt: [
      "You are the Search agent inside FileTree, a disk-usage explorer.",
      "Your job is read-only investigation: find files/folders, list directories, read file contents, search inside files (grep), compute sizes, and detect duplicates using the tools provided.",
      "Use absolute Windows paths exactly as they appear in the scan. Call tools to gather facts — never guess paths.",
      "Large results are paginated: when a tool result has truncated=true, use offset/limit (and next_offset) to read more instead of guessing the rest.",
      "NEVER output a file name, path, or size that did not come from a tool result in this run. If a tool returns no matching files, say so plainly — do not invent example files.",
      mcpLine + "When you have gathered what was asked, reply with a concise findings summary (key paths with sizes). Do not ask the user questions.",
      "",
      scanContext(api),
    ].join("\n"),
    runTool: async (name, args, ctx) => {
      const result = await runToolOrMcp(name, args, ctx, builtins);
      return { result, summary: summarizeToolResult(name, result), status: stepStatusOf(result) };
    },
    // Findings are only real if a read-only tool actually ran. If the model
    // tries to summarize without one, run the best-matching tool ourselves so
    // the report is backed by real data instead of guesses.
    guardFinal: ({ task, ranTools }) => {
      if (ranTools.some((t) => READ_ONLY_TOOLS.has(t) || !builtins.has(t))) return { action: "accept" };
      return {
        action: "force",
        call: chooseSearchTool(task),
        notice: "Reading the folder directly so the findings are real, not guessed.",
      };
    },
    formatFindings: (name, result) => formatFindings(name, result),
    extractFacts: extractAgentFacts,
  };
}

export function actionSpec(api: AgentApi, extraTools: ToolDef[] = []): AgentSpec {
  const builtins = ACTION_TOOL_NAMES;
  return {
    agent: "action",
    maxSteps: 8,
    tools: [...ACTION_TOOLS, ...extraTools],
    systemPrompt: [
      "You are the Action agent inside FileTree, a disk-usage explorer.",
      "You perform file changes: move, delete (recycle), rename, create folders, write/edit text files, and run shell commands.",
      "You change files ONLY by calling the tools (move_items, recycle_items, rename_item, create_folder, write_file, edit_file, run_command). Never write a sentence claiming a file was moved, deleted, renamed, written, or that a command ran — only a real tool call counts. If you have not called the tool, nothing has happened.",
      "To DELETE files or folders, call recycle_items ONCE, passing ALL of the absolute paths to delete in its `paths` array. They go to the Recycle Bin (recoverable), the user sees a SINGLE approval card for the whole batch, and you get back a real exit code — never claim anything was deleted unless recycle_items returns exit code 0. Do NOT delete with run_command/Remove-Item/rm, and do NOT call recycle_items once per file.",
      "To create or overwrite a text file use write_file; to change part of an existing file use edit_file (old_string must match exactly). Use run_command only for general (non-delete) shell work.",
      "Every action is shown to the user for explicit approval before it runs, so call tools directly with precise absolute Windows paths.",
      "Use ONLY the exact absolute paths given in your task. If your task does not contain a concrete absolute path, do NOT guess or pick a file yourself — reply that an explicit path is required.",
      "Only perform the changes described in your task. Do not invent extra deletions or run unrelated commands.",
      "After the tool returns, reply with a short summary of what the tool actually did, citing the real exit code for commands (or that it was rejected).",
      "",
      scanContext(api),
    ].join("\n"),
    runTool: async (name, args, ctx) => {
      const result = await runToolOrMcp(name, args, ctx, builtins);
      return { result, summary: summarizeToolResult(name, result), status: stepStatusOf(result) };
    },
    extractFacts: extractAgentFacts,
  };
}

// ── Orchestrator ─────────────────────────────────────────────
const DELEGATION_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "delegate_to_search",
      description:
        "Delegate a read-only investigation to the Search agent (finding files, listing folders, scanning, sizes, duplicates). Provide a clear, self-contained task. Returns the agent's findings.",
      parameters: {
        type: "object",
        properties: { task: { type: "string", description: "What to investigate, in plain language." } },
        required: ["task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delegate_to_action",
      description:
        "Delegate file changes to the Action agent (move, delete, rename, create folder). Each action is shown to the user for approval. Provide explicit absolute paths. Returns what was done.",
      parameters: {
        type: "object",
        properties: { task: { type: "string", description: "The exact changes to make, with absolute paths." } },
        required: ["task"],
      },
    },
  },
];

// Deterministic path-verification: pull every absolute Windows path cited in the
// draft final answer and return those that are NOT present in the current scan
// tree. Used to catch fabricated/hallucinated file names before they reach the
// user — supplementing (and reducing reliance on) the SPECIFICS_RE heuristic.
// Tolerates the scan root and any path that is a real ancestor of a scanned node.
function missingCitedPaths(text: string, api: AgentApi): string[] {
  const matches = text.match(/[A-Za-z]:\\[^\n"'`<>|]+/g);
  if (!matches || !matches.length) return [];
  const nodes = api.getNodes();
  const known = new Set<string>();
  for (const n of nodes) if (n.path) known.add(normPath(n.path));
  const scanRoot = normPath(api.getScanPath() || "");
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const raw of matches) {
    const p = raw.trim().replace(/[).,;:]+$/, "");
    const np = normPath(p);
    if (!np || seen.has(np)) continue;
    seen.add(np);
    if (np === scanRoot || known.has(np)) continue;
    // Accept a cited folder that is a real ancestor of some scanned node.
    let isAncestor = false;
    for (const k of known) { if (k.startsWith(np + "\\")) { isAncestor = true; break; } }
    if (isAncestor) continue;
    missing.push(p);
    if (missing.length >= 8) break;
  }
  return missing;
}

export function orchestratorSpec(api: AgentApi, attachedContext: string): AgentSpec {
  // Fires at most once per turn: after Search finds the files for an action
  // request, nudge the orchestrator to actually propose the change instead of
  // stopping at the listing. Kept here (not via the shared nudges counter) so
  // it can never loop regardless of how many search nudges happened.
  let continuationNudged = false;
  // Fires at most once per turn: if the draft answer cites a path that isn't in
  // the scan, send the model back to Search to correct it before answering.
  let pathNudged = false;
  return {
    agent: "orchestrator",
    maxSteps: 12,
    tools: DELEGATION_TOOLS,
    systemPrompt: [
      "You are the Orchestrator of FileTree's AI assistant. You coordinate two specialized sub-agents to help the user understand and clean up disk usage.",
      "You have NO file tools and NO file listing of your own. For ANY question about files, folders, sizes, what is taking up space, what is largest, duplicates, or folder contents, you MUST call delegate_to_search and answer ONLY from its findings. Never answer such questions from memory, assumptions, or the brief summary below — that summary has no file listing.",
      "NEVER write any file name, path, size, or count that did not appear in a Search agent finding earlier in THIS conversation. If you have not received Search findings yet, you do not know any file names or sizes — do not guess, recall, or make up examples; delegate to Search first. Inventing files (e.g. 'Untitled', 'Image.png', 'Report.docx') is a serious error.",
      "Do not narrate intentions like 'I will investigate' without acting. If you decide a step is needed, call the tool in that same turn — describing it is not doing it.",
      "To change files (move, delete, rename, create folder) call delegate_to_action. NEVER ask the user to confirm a change in chat, and NEVER ask them to retype, paste, or supply file paths — every proposed change is shown to the user as an on-screen approval card that they Approve or Reject, so just call delegate_to_action directly when a change is warranted. When you delegate an action you MUST include the exact absolute path(s) copied verbatim from the Search agent's findings — never delegate a vague action such as 'delete the largest file', and never propose deleting or moving a file you have not seen in Search findings. If the user rejects, acknowledge it and stop; do not retry the same action.",
      "Workflow: (1) briefly state your plan, (2) call delegate_to_search (or delegate_to_action) with one focused, self-contained task, (3) wait for the result, delegating again if needed, (4) give a clear, concise final answer in plain text with no tool call. Do not fabricate paths, sizes, or results.",
      "After a delete or move action SUCCEEDS, do NOT automatically re-run a duplicate search (or any other search) just to double-check your own work. If the Action agent's report shows the targeted files were recycled/moved (exit code 0), summarize what was done and finalize with plain text. Only delegate_to_search again if the action failed or only partially succeeded, or the user explicitly asks for a fresh scan.",
      "Use absolute Windows paths exactly as they appear in the findings the Search agent returns.",
      attachedContext ? "\nUser-attached context:\n" + attachedContext : "",
      "",
      scanSummary(api),
    ].join("\n"),
    runTool: async (name, args, ctx, runId) => {
      const task = coerceTask(args.task) || coerceTask(args);
      if (!task) return { result: { ok: false, error: "Missing task." }, summary: "no task", status: "error" };
      const priorMessages = subAgentContext(ctx);
      if (name === "delegate_to_search") {
        const sub = await runAgent(searchSpec(ctx.api, ctx.mcpReadTools ?? []), ctx, { task, parentId: runId, priorMessages });
        // Return STRUCTURED findings (paths/counts the orchestrator can cite and
        // act on) alongside the prose report, not just `sub.text`.
        return {
          result: { agent: "search", report: sub.text || "(no findings)", facts: sub.facts ?? { paths: [], counts: {}, notes: [] } },
          summary: "Search agent finished",
          status: sub.status === "error" ? "error" : "done",
        };
      }
      if (name === "delegate_to_action") {
        const sub = await runAgent(actionSpec(ctx.api, ctx.mcpWriteTools ?? []), ctx, { task, parentId: runId, priorMessages });
        return {
          result: { agent: "action", report: sub.text || "(done)", facts: sub.facts ?? { paths: [], counts: {}, notes: [] } },
          summary: "Action agent finished",
          status: sub.status === "error" ? "error" : "done",
        };
      }
      return { result: { ok: false, error: `unknown delegation ${name}` }, summary: "unknown", status: "error" };
    },
    // Final-answer gate: a file-related answer is only valid if a Search ran
    // this turn. Otherwise nudge the model to delegate; if it still refuses,
    // force a real read-only investigation so the user gets actual data instead
    // of fabricated file names/sizes. (Read-only only — never forces an action.)
    guardFinal: ({ task, finalText, ranTools, nudges }) => {
      const searched = ranTools.includes("delegate_to_search");
      const acted = ranTools.includes("delegate_to_action");
      // Follow-through: the user asked for a change and Search located the
      // files, but no action has been proposed yet. Nudge once to call
      // delegate_to_action (the user still approves/skips on screen). Gated by
      // the closure flag so it can fire only once and never loops.
      if (searched && !acted && !continuationNudged && ACTION_INTENT_RE.test(task)) {
        continuationNudged = true;
        return {
          action: "nudge",
          message:
            "You found the files but haven't made the change the user asked for. Call delegate_to_action now with the EXACT absolute path(s) copied from the Search findings — the user will see an on-screen approval card and Approve or Skip it. Do NOT ask the user to confirm in chat.",
          notice: "Found the files but no change proposed yet — prompting the assistant to take the action.",
        };
      }
      // Deterministic path-verification gate: if the draft answer cites concrete
      // absolute paths that are NOT in the current scan tree, the model likely
      // fabricated them. Send it back to Search once to correct. Skipped after an
      // action ran (the tree may legitimately have changed and the scan is stale).
      if (!acted && !pathNudged) {
        const missing = missingCitedPaths(finalText, api);
        if (missing.length) {
          pathNudged = true;
          return {
            action: "nudge",
            message:
              `These path(s) in your answer are NOT in the current scan tree: ${missing.join(", ")}. ` +
              "Do not cite paths from memory or assumption. Call delegate_to_search to locate the real path(s), then answer using ONLY paths returned by a tool.",
            notice: "Draft answer cited a path that isn't in the scan — verifying via Search before replying.",
          };
        }
      }
      if (searched) return { action: "accept" };
      if (!needsRealData(task, finalText)) return { action: "accept" };
      if (nudges === 0) {
        return {
          action: "nudge",
          message:
            "You answered without reading the folder. You have NO file listing and the brief scan summary contains none — so any file names, sizes, or counts you just gave are NOT real. Call delegate_to_search now, in this turn, with a clear task, then answer only from its findings.",
          notice: "The assistant tried to answer without reading the folder — directing it to the Search agent.",
        };
      }
      if (nudges === 1) {
        return {
          action: "nudge",
          message:
            "Stop. Do not output any file name, path, or size from memory or assumption — your only way to see real files is the Search agent. Call delegate_to_search right now with the user's request as the task.",
          notice: "Still no investigation — prompting once more before reading the folder automatically.",
        };
      }
      return {
        action: "force",
        call: { name: "delegate_to_search", args: { task } },
        notice: "The model wouldn't use its tools — running the Search agent automatically to get real data.",
      };
    },
    // If the model won't phrase an answer of its own, fall back to a sub-agent's
    // real report (Search findings or the Action agent's result) so the final
    // reply shows actual data/outcome rather than nothing.
    formatFindings: (name, result) =>
      name === "delegate_to_search" || name === "delegate_to_action"
        ? String((result as { report?: string })?.report ?? "")
        : "",
  };
}

// Entry point used by the ChatPanel for a single user turn.
export function runOrchestrator(
  ctx: RunContext,
  opts: { userText: string; attachedContext: string; priorConvo: LlmMessage[]; images?: LlmImage[] },
): Promise<RunResult> {
  return runAgent(orchestratorSpec(ctx.api, opts.attachedContext), ctx, {
    task: opts.userText,
    priorMessages: opts.priorConvo,
    userImages: opts.images,
  });
}

export type { AgentEvent, RunContext, RunResult } from "./types";
