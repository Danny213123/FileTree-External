// Multi-agent orchestration. The orchestrator is an LLM loop whose only tools
// are delegation calls; each delegation spawns a specialized sub-agent loop
// (read-only Search or mutating Action) and feeds its summarized findings back.
// The orchestrator never touches the filesystem itself.

import {
  ACTION_TOOLS,
  SEARCH_TOOLS,
  executeTool,
  formatFindings,
  scanContext,
  scanSummary,
  summarizeToolResult,
  type AgentApi,
  type ToolDef,
} from "../agent";
import type { LlmImage, LlmMessage } from "../llm";
import { runAgent } from "./runtime";
import type { AgentSpec, RunContext, RunResult, StepStatus } from "./types";

function stepStatusOf(result: unknown): StepStatus {
  return (result as { ok?: boolean })?.ok === false ? "error" : "done";
}

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
export function searchSpec(api: AgentApi): AgentSpec {
  return {
    agent: "search",
    maxSteps: 6,
    tools: SEARCH_TOOLS,
    systemPrompt: [
      "You are the Search agent inside FileTree, a disk-usage explorer.",
      "Your job is read-only investigation: find files/folders, list directories, compute sizes, and detect duplicates using the tools provided.",
      "Use absolute Windows paths exactly as they appear in the scan. Call tools to gather facts — never guess paths.",
      "NEVER output a file name, path, or size that did not come from a tool result in this run. If a tool returns no matching files, say so plainly — do not invent example files.",
      "When you have gathered what was asked, reply with a concise findings summary (key paths with sizes). Do not ask the user questions.",
      "",
      scanContext(api),
    ].join("\n"),
    runTool: async (name, args, ctx) => {
      const result = await executeTool(name, args, ctx.api);
      return { result, summary: summarizeToolResult(name, result), status: stepStatusOf(result) };
    },
    // Findings are only real if a read-only tool actually ran. If the model
    // tries to summarize without one, run the best-matching tool ourselves so
    // the report is backed by real data instead of guesses.
    guardFinal: ({ task, ranTools }) => {
      if (ranTools.some((t) => READ_ONLY_TOOLS.has(t))) return { action: "accept" };
      return {
        action: "force",
        call: chooseSearchTool(task),
        notice: "Reading the folder directly so the findings are real, not guessed.",
      };
    },
    formatFindings: (name, result) => formatFindings(name, result),
  };
}

export function actionSpec(api: AgentApi): AgentSpec {
  return {
    agent: "action",
    maxSteps: 6,
    tools: ACTION_TOOLS,
    systemPrompt: [
      "You are the Action agent inside FileTree, a disk-usage explorer.",
      "You perform file changes: move, delete (to Recycle Bin), rename, and create folders.",
      "You change files ONLY by calling the tools (move_items, delete_items, rename_item, create_folder). Never write a sentence claiming a file was moved, deleted, or renamed — only a real tool call counts. If you have not called the tool, nothing has happened.",
      "Every action is shown to the user for explicit approval before it runs, so call tools directly with precise absolute Windows paths.",
      "Use ONLY the exact absolute paths given in your task. If your task does not contain a concrete absolute path, do NOT guess or pick a file yourself — reply that an explicit path is required.",
      "Only perform the changes described in your task. Do not invent extra deletions.",
      "After the tool returns, reply with a short summary of what the tool actually did (or that it was rejected).",
      "",
      scanContext(api),
    ].join("\n"),
    runTool: async (name, args, ctx) => {
      const result = await executeTool(name, args, ctx.api);
      return { result, summary: summarizeToolResult(name, result), status: stepStatusOf(result) };
    },
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

export function orchestratorSpec(api: AgentApi, attachedContext: string): AgentSpec {
  return {
    agent: "orchestrator",
    maxSteps: 8,
    tools: DELEGATION_TOOLS,
    systemPrompt: [
      "You are the Orchestrator of FileTree's AI assistant. You coordinate two specialized sub-agents to help the user understand and clean up disk usage.",
      "You have NO file tools and NO file listing of your own. For ANY question about files, folders, sizes, what is taking up space, what is largest, duplicates, or folder contents, you MUST call delegate_to_search and answer ONLY from its findings. Never answer such questions from memory, assumptions, or the brief summary below — that summary has no file listing.",
      "NEVER write any file name, path, size, or count that did not appear in a Search agent finding earlier in THIS conversation. If you have not received Search findings yet, you do not know any file names or sizes — do not guess, recall, or make up examples; delegate to Search first. Inventing files (e.g. 'Untitled', 'Image.png', 'Report.docx') is a serious error.",
      "Do not narrate intentions like 'I will investigate' without acting. If you decide a step is needed, call the tool in that same turn — describing it is not doing it.",
      "To change files (move, delete, rename, create folder) call delegate_to_action. NEVER ask the user to confirm a change in chat, and NEVER ask them to retype, paste, or supply file paths — every proposed change is shown to the user as an on-screen approval card that they Approve or Reject, so just call delegate_to_action directly when a change is warranted. When you delegate an action you MUST include the exact absolute path(s) copied verbatim from the Search agent's findings — never delegate a vague action such as 'delete the largest file', and never propose deleting or moving a file you have not seen in Search findings. If the user rejects, acknowledge it and stop; do not retry the same action.",
      "Workflow: (1) briefly state your plan, (2) call delegate_to_search (or delegate_to_action) with one focused, self-contained task, (3) wait for the result, delegating again if needed, (4) give a clear, concise final answer in plain text with no tool call. Do not fabricate paths, sizes, or results.",
      "Use absolute Windows paths exactly as they appear in the findings the Search agent returns.",
      attachedContext ? "\nUser-attached context:\n" + attachedContext : "",
      "",
      scanSummary(api),
    ].join("\n"),
    runTool: async (name, args, ctx, runId) => {
      const task = coerceTask(args.task) || coerceTask(args);
      if (!task) return { result: { ok: false, error: "Missing task." }, summary: "no task", status: "error" };
      if (name === "delegate_to_search") {
        const sub = await runAgent(searchSpec(ctx.api), ctx, { task, parentId: runId });
        return {
          result: { agent: "search", report: sub.text || "(no findings)" },
          summary: "Search agent finished",
          status: sub.status === "error" ? "error" : "done",
        };
      }
      if (name === "delegate_to_action") {
        const sub = await runAgent(actionSpec(ctx.api), ctx, { task, parentId: runId });
        return {
          result: { agent: "action", report: sub.text || "(done)" },
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
      if (ranTools.includes("delegate_to_search")) return { action: "accept" };
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
    // If a search was forced but the model still won't phrase an answer, fall
    // back to the Search agent's real findings so the final reply shows actual
    // data rather than nothing.
    formatFindings: (name, result) =>
      name === "delegate_to_search" ? String((result as { report?: string })?.report ?? "") : "",
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
