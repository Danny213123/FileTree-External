// Generic agent loop. Streams one LLM turn at a time, surfaces thinking/text,
// executes any tool calls (with approval gating for mutating ones), and feeds
// results back until the model answers with plain text or the step budget runs
// out. The same loop powers the orchestrator and both sub-agents.
//
// A spec may also provide a `guardFinal` hook (see types.ts). When the model
// tries to end a turn with plain text and no tool call, the guard can reject
// that answer — nudging the model to actually act, or, as a last resort, having
// the runtime deterministically run a read-only tool so the user gets REAL data
// instead of fabricated prose. This is what stops a weak model from inventing
// file names/sizes when it refuses to delegate to the Search agent.

import { MUTATING_TOOLS, formatToolOutput } from "../agent";
import { llmStream, type LlmImage, type LlmMessage, type LlmToolCall } from "../llm";
import type { AgentSpec, RunContext, RunResult } from "./types";

// Tools that ALWAYS surface an approval card, no matter the user's auto-approve
// setting or allowlist. run_command runs arbitrary shell, so the user must see
// and confirm the exact command every single time — it can never be bypassed.
export const ALWAYS_APPROVE_TOOLS = new Set(["run_command"]);

export async function runAgent(
  spec: AgentSpec,
  ctx: RunContext,
  opts: { task: string; parentId?: string; priorMessages?: LlmMessage[]; userImages?: LlmImage[] },
): Promise<RunResult> {
  const runId = ctx.newId(spec.agent + "_");
  ctx.emit({ kind: "agent_start", runId, agent: spec.agent, parentId: opts.parentId, task: opts.task });

  const history: LlmMessage[] = [
    { role: "system", content: spec.systemPrompt },
    ...(opts.priorMessages ?? []),
    { role: "user", content: opts.task, images: opts.userImages?.length ? opts.userImages : undefined },
  ];

  let useTools = spec.tools.length > 0;
  let toolsDisabled = false;
  let nudged = false; // generic one-shot nudge for agents without a guardFinal
  let nudges = 0; // interventions made by guardFinal (nudge or force)
  const ranTools = new Set<string>();
  let finalText = "";
  // Best real findings gathered this run — from ANY tool whose result
  // formatFindings can render, not just a forced one. Used as a fallback answer
  // if the model never phrases a final reply of its own, so the run never ends
  // blank (a major cause of the assistant "quitting early").
  let fallbackFindings = "";
  // True once we leave the loop via a real, accepted final answer (vs. running
  // out of the step budget mid-task). Drives the step-limit notice below.
  let reachedFinal = false;
  let status: RunResult["status"] = "done";

  // Execute a single tool call: approval-gate mutating/plan calls, run it,
  // stream UI updates, and append the result to history. Shared by the model's
  // own tool calls and any call the runtime forces via the final-answer guard.
  async function runOneCall(call: LlmToolCall): Promise<{ result: unknown; status: "done" | "error" | "rejected" }> {
    ranTools.add(call.name);
    const mutating = MUTATING_TOOLS.has(call.name);
    // Two-tier approval: mutating tools are the per-action gate (Tier 2), and
    // delegate_to_action is the plan gate (Tier 1) — both pause for the user
    // unless global auto-approve is on. (The guard only ever forces read-only
    // tools, so a forced call never silently runs a mutating action.)
    const isPlanDelegation = call.name === "delegate_to_action";
    // Mutating/plan calls need a review card, unless the user globally
    // auto-approves or has "always allowed" this specific tool. Tools in
    // ALWAYS_APPROVE_TOOLS (run_command) override that escape hatch entirely —
    // they always require an explicit, per-call approval.
    const alwaysApprove = ALWAYS_APPROVE_TOOLS.has(call.name);
    const requiresApproval =
      alwaysApprove || ((mutating || isPlanDelegation) && !ctx.autoApprove && !ctx.allowTool(call.name));
    ctx.emit({ kind: "tool_start", runId, callId: call.id, tool: call.name, args: call.args, mutating, requiresApproval });

    let approved = true;
    if (requiresApproval) {
      approved = await ctx.requestApproval(call.id, { name: call.name, args: call.args, mutating });
    }

    let resultObj: unknown;
    let summary: string;
    let stepStatus: "done" | "error" | "rejected";
    if (!approved) {
      // The user skipped this step. Feed a clear, non-retry signal back so the
      // agent moves on (or finalizes) instead of re-proposing or fabricating it.
      resultObj = {
        ok: false,
        error: isPlanDelegation
          ? "User skipped this plan. Do not retry it; continue or give your final answer."
          : "User skipped this action. Do not retry it; continue with the rest of the task or give your final answer.",
      };
      summary = "Skipped";
      stepStatus = "rejected";
    } else {
      ctx.emit({ kind: "tool_update", runId, callId: call.id, status: "running" });
      try {
        const r = await spec.runTool(call.name, call.args, ctx, runId);
        resultObj = r.result;
        summary = r.summary;
        stepStatus = r.status === "error" ? "error" : "done";
      } catch (e) {
        resultObj = { ok: false, error: (e as Error).message };
        summary = (e as Error).message;
        stepStatus = "error";
      }
    }

    const output = formatToolOutput(call.name, resultObj);
    ctx.emit({ kind: "tool_update", runId, callId: call.id, status: stepStatus, summary, output: output || undefined });
    history.push({ role: "tool", content: safeJson(resultObj), toolCallId: call.id, toolName: call.name });
    return { result: resultObj, status: stepStatus };
  }

  for (let step = 0; step < spec.maxSteps; step++) {
    if (ctx.signal.aborted) {
      status = "error";
      break;
    }

    let text = "";
    const toolCalls: LlmToolCall[] = [];
    let errored = false;

    for await (const ev of llmStream({
      provider: ctx.provider,
      model: ctx.model,
      apiKey: ctx.apiKey,
      messages: history,
      tools: useTools ? spec.tools : undefined,
      signal: ctx.signal,
    })) {
      if (ev.type === "thinking") {
        ctx.emit({ kind: "thinking", runId, delta: ev.value });
      } else if (ev.type === "text") {
        text += ev.value;
        ctx.emit({ kind: "text", runId, delta: ev.value });
      } else if (ev.type === "tool_calls") {
        toolCalls.push(...ev.value);
      } else if (ev.type === "error") {
        ctx.emit({ kind: "notice", runId, level: "error", text: ev.value });
        errored = true;
      }
    }

    if (errored) {
      status = "error";
      finalText = text;
      break;
    }
    if (ctx.signal.aborted) {
      finalText = text;
      status = "error";
      break;
    }

    history.push({
      role: "assistant",
      content: text,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    });

    if (toolCalls.length) {
      for (const call of toolCalls) {
        if (ctx.signal.aborted) break;
        const ran = await runOneCall(call);
        // Capture renderable findings from real (model-issued) calls too, so a
        // model that gathers data but then stalls still yields a useful answer.
        if (spec.formatFindings) {
          const findings = spec.formatFindings(call.name, ran.result);
          if (findings.trim()) fallbackFindings = findings;
        }
      }
      continue;
    }

    // ── No tool calls: the model produced a would-be-final turn ──────────────

    // (a) Truly empty turn: a model that can't tool-call returns nothing.
    // Retry once as a plain chat so the user still gets an answer.
    if (!text.trim() && useTools && !toolsDisabled) {
      useTools = false;
      toolsDisabled = true;
      history.pop();
      ctx.emit({ kind: "notice", runId, level: "warn", text: `${ctx.model} returned no tool call — retrying without tools.` });
      continue;
    }

    // (b) Final-answer guard (orchestrator / search). Refuses an answer that
    // skipped required investigation: it nudges the model to actually delegate
    // or, as a hard guarantee, forces a read-only tool so the user gets REAL
    // data rather than invented file names/sizes.
    if (spec.guardFinal) {
      const decision = spec.guardFinal({ task: opts.task, finalText: text, ranTools: [...ranTools], nudges });
      if (decision.action === "nudge") {
        nudges++;
        // Drop the provisional/fabricated text from the UI so it never lingers
        // above the corrected answer. (We keep it in history for the model's own
        // context; the explicit nudge tells it those specifics were not real.)
        ctx.emit({ kind: "text_reset", runId });
        history.push({ role: "user", content: decision.message });
        if (decision.notice) ctx.emit({ kind: "notice", runId, level: "info", text: decision.notice });
        continue;
      }
      if (decision.action === "force") {
        nudges++;
        ctx.emit({ kind: "text_reset", runId });
        // Discard the fabricated assistant text entirely (never shown, never
        // persisted), then run the read-only tool ourselves and feed the real
        // result back so the model can phrase the answer strictly from it.
        history.pop();
        if (decision.notice) ctx.emit({ kind: "notice", runId, level: "warn", text: decision.notice });
        const forced: LlmToolCall = { id: ctx.newId("call_"), name: decision.call.name, args: decision.call.args };
        history.push({ role: "assistant", content: "", toolCalls: [forced] });
        const ran = await runOneCall(forced);
        if (spec.formatFindings) {
          const findings = spec.formatFindings(forced.name, ran.result);
          if (findings.trim()) fallbackFindings = findings;
        }
        continue;
      }
      // decision.action === "accept" → fall through and finalize.
    } else if (text.trim() && useTools && ranTools.size === 0 && !nudged) {
      // (c) Generic one-shot nudge for agents without a guard (the Action
      // agent): it narrated an intention or claimed an action as done without
      // ever calling a tool. Nudge once so real work happens and destructive
      // ops hit the approval gate instead of being fabricated in prose.
      nudged = true;
      history.push({
        role: "user",
        content:
          "Do not just describe what you will do, and never state an action as completed unless a tool actually returned success. If you need information or need to change files, call the appropriate tool now, in this turn. Otherwise, give your final answer.",
      });
      ctx.emit({ kind: "notice", runId, level: "info", text: "The model didn't act — asking it to use its tools." });
      continue;
    }

    finalText = text;
    reachedFinal = true;
    break;
  }

  if (ctx.signal.aborted) status = "error";
  // Budget exhausted mid-task (the loop ran out of steps without a clean final
  // answer). Tell the user we're wrapping up rather than ending silently, and
  // still return the best content gathered below.
  if (status === "done" && !reachedFinal && !ctx.signal.aborted) {
    ctx.emit({ kind: "notice", runId, level: "warn", text: "Reached the step limit — wrapping up with what's been gathered so far." });
  }
  // If the model never produced a final answer but we gathered real findings
  // (forced or model-issued), return them so the user always sees actual data,
  // not a blank turn.
  if (status !== "error" && !finalText.trim() && fallbackFindings.trim()) {
    finalText = fallbackFindings;
  }
  if (status === "done" && !finalText.trim()) {
    ctx.emit({ kind: "notice", runId, level: "warn", text: "The model returned an empty response. Try a tool-capable model (e.g. qwen2.5, llama3.1) or a cloud provider." });
  }
  ctx.emit({ kind: "agent_end", runId, agent: spec.agent, status, summary: finalText });
  return { runId, text: finalText, status };
}

function safeJson(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s.length > 4000 ? s.slice(0, 4000) + "…(truncated)" : s;
  } catch {
    return String(value);
  }
}
