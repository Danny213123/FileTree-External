// Event + context model shared by the orchestrator and its sub-agents.

import type { AgentApi, ToolDef } from "../agent";
import type { LlmOptions, LlmProvider } from "../llm";

export type AgentKind = "orchestrator" | "search" | "action";
export type RunStatus = "running" | "done" | "error";
export type StepStatus = "pending" | "running" | "done" | "error" | "rejected";

export interface ToolCallView {
  name: string;
  args: Record<string, unknown>;
  mutating: boolean;
}

// Structured events streamed from a run to the UI. Every event carries the
// runId of the agent that produced it; sub-agents reference their parent so the
// UI can render a nested timeline.
export type AgentEvent =
  | { kind: "agent_start"; runId: string; agent: AgentKind; parentId?: string; task?: string }
  | { kind: "thinking"; runId: string; delta: string }
  | { kind: "text"; runId: string; delta: string }
  // Discards the text streamed for this run so far. Emitted when a final-answer
  // guard rejects a would-be answer (e.g. the orchestrator tried to answer a
  // file question without reading the folder) so the provisional/fabricated
  // text never lingers on screen above the corrected answer.
  | { kind: "text_reset"; runId: string }
  | { kind: "tool_start"; runId: string; callId: string; tool: string; args: Record<string, unknown>; mutating: boolean; requiresApproval: boolean }
  | { kind: "tool_update"; runId: string; callId: string; status: StepStatus; summary?: string; output?: string }
  | { kind: "agent_end"; runId: string; agent: AgentKind; status: RunStatus; summary?: string }
  | { kind: "notice"; runId?: string; level: "info" | "warn" | "error"; text: string };

// Everything a run needs from its host (the ChatPanel) to execute.
export interface RunContext {
  provider: LlmProvider;
  model: string;
  apiKey?: string;
  // Decoding controls (temperature/repeat penalty/num_ctx/etc.) applied to every
  // LLM turn this run makes. Anti-repetition defaults apply when omitted.
  options?: LlmOptions;
  api: AgentApi;
  autoApprove: boolean;
  signal: AbortSignal;
  emit: (ev: AgentEvent) => void;
  // Resolves true to run a mutating tool, false to skip it.
  requestApproval: (callId: string, view: ToolCallView) => Promise<boolean>;
  // True when the user has "always allowed" this tool, so it runs without
  // surfacing an approval card (read live so a mid-run "always allow" applies).
  allowTool: (tool: string) => boolean;
  newId: (prefix?: string) => string;
  // Optional alternate model the runtime may switch to after a persistent
  // mid-stream error (rate limit / upstream failure). Empty/equal-to-model means
  // no fallback. Computed by the host (e.g. a sibling cloud model) — never local.
  fallbackModel?: string;
  // Optional per-turn debug sink. When provided, each agent run (orchestrator +
  // sub-agents) appends ONE structured entry (steps, tools, guard nudges, char
  // counts) so the host can offer a "copy debug bundle" affordance. No telemetry.
  debug?: AgentDebugEntry[];
  // The user's original request for this whole turn + a brief digest of prior
  // turns, threaded so the orchestrator can pass real context (not just a bare
  // task string) down to sub-agents.
  userTask?: string;
  priorDigest?: string;
  // Extra MCP tools (read-only / gated) discovered at run start, plus the
  // executor that runs them. Merged into the Search/Action agents' tool lists.
  mcpReadTools?: ToolDef[];
  mcpWriteTools?: ToolDef[];
  runMcpTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  // Tool names (beyond the static MUTATING/ALWAYS_APPROVE sets) that must surface
  // an approval card and run sequentially — e.g. side-effecting MCP tools.
  gatedTools?: Set<string>;
}

// Structured findings accumulated from a (sub-)agent's tool results, surfaced to
// the orchestrator ALONGSIDE the prose report so it has machine-readable facts
// (real paths it can cite/act on, counts) — not just narration.
export interface AgentFacts {
  paths: string[];
  counts: Record<string, number>;
  notes: string[];
  // Best-known size (MB) per path, keyed by NORMALIZED path. Lets the delegation
  // handoff dedupe + sort the verified paths by size so the largest survive the
  // cap and lead the "Verified paths" block fed back to the orchestrator.
  sizes?: Record<string, number>;
}

// One structured record per agent run, accumulated into RunContext.debug for an
// optional, local-only "copy debug bundle" affordance. char counts are rough
// (history length / output length), not real token counts.
export interface AgentDebugEntry {
  runId: string;
  agent: AgentKind;
  steps: number;
  tools: string[];
  guardNudges: number;
  inputChars: number;
  outputChars: number;
  status: RunStatus;
  notes: string[];
}

// Inputs to a final-answer guard: the user's request for this run, the answer
// the model is about to give, the tool names that actually executed this run,
// and how many times the guard has already intervened.
export interface GuardInfo {
  task: string;
  finalText: string;
  ranTools: string[];
  nudges: number;
}

// What a guard decides when the model produced a would-be-final turn (text, no
// tool call):
//   • accept — let the answer stand.
//   • nudge  — reject it, re-prompt the model with `message`, and loop again.
//   • force  — reject it and have the runtime deterministically run `call`
//              (a read-only tool) so the user gets real data regardless of
//              whether the model would ever comply on its own.
export type GuardDecision =
  | { action: "accept" }
  | { action: "nudge"; message: string; notice?: string }
  | { action: "force"; call: { name: string; args: Record<string, unknown> }; notice?: string };

// Describes a single agent's behavior. `runTool` executes one tool call and
// returns the result object (fed back to the model) plus a UI summary.
export interface AgentSpec {
  agent: AgentKind;
  systemPrompt: string;
  tools: ToolDef[];
  maxSteps: number;
  runTool: (
    name: string,
    args: Record<string, unknown>,
    ctx: RunContext,
    runId: string,
  ) => Promise<{ result: unknown; summary: string; status: StepStatus }>;
  // Optional gate consulted before a turn with no tool calls is accepted as the
  // final answer. Lets the orchestrator/search agents refuse answers that
  // skipped required investigation and force real tool use instead.
  guardFinal?: (info: GuardInfo) => GuardDecision;
  // Optional: turn a (read-only) tool result into human-readable findings text.
  // Used as a deterministic fallback so that, even if the model never phrases an
  // answer after a forced tool call, the run still returns the real data.
  formatFindings?: (toolName: string, result: unknown) => string;
  // Optional: pull structured facts (paths/counts) out of a tool result into the
  // run's accumulator, so the parent gets machine-readable findings.
  extractFacts?: (toolName: string, result: unknown, acc: AgentFacts) => void;
}

export interface RunResult {
  runId: string;
  text: string;
  status: RunStatus;
  // Structured findings gathered this run (empty unless the spec extracts them).
  facts?: AgentFacts;
}
