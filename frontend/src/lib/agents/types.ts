// Event + context model shared by the orchestrator and its sub-agents.

import type { AgentApi, ToolDef } from "../agent";
import type { LlmProvider } from "../llm";

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
}

export interface RunResult {
  runId: string;
  text: string;
  status: RunStatus;
}
