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
import { llmStream, type LlmImage, type LlmMessage, type LlmOptions, type LlmToolCall } from "../llm";
import type { AgentDebugEntry, AgentFacts, AgentSpec, RunContext, RunResult } from "./types";

// Abort an in-flight stream if no event arrives for this long (model wedged /
// upstream hung). Surfaced to the user as a timeout notice.
const STREAM_STALL_MS = 30_000;

// Replaces a guard-rejected assistant draft kept in history. Keeping the FULL
// fabricated draft is what fed the self-correction spiral ("Wait, I see a
// mistake in my previous response…"); a terse stub lets the model move on
// without re-reading its own invented file names/sizes.
const WITHHELD_DRAFT = "(draft withheld — it was not grounded in tool results; answer only from Search findings)";

// ── Degeneration detection (provider-agnostic, runs on accumulated text) ──────
// Two failure modes seen with weak local models on disk-usage queries:
//   (a) the same line/sentence repeated several times in a row, then
//   (b) a collapse into a short repeating unit (e.g. "나나나…", "....").
// Detect either on the growing text so the runtime can abort + retry before the
// stream wastes the whole context on junk.
const DEGEN_MIN_LEN = 80;

// (b) A unit of ≤3 chars repeated to cover >~40 chars at the tail. Skips
// whitespace/punctuation units (markdown rules, "----", "....", "***") which can
// legitimately run long; real degeneration collapses into repeated letters.
function hasShortCycleTail(text: string): boolean {
  const tail = text.slice(-240);
  for (let unit = 1; unit <= 3; unit++) {
    if (tail.length < unit * 4) continue;
    const cand = tail.slice(tail.length - unit);
    if (/^[\s\-=_*#.~`+|]+$/.test(cand)) continue;
    let i = tail.length;
    let reps = 0;
    while (i - unit >= 0 && tail.slice(i - unit, i) === cand) { reps++; i -= unit; }
    if (reps >= 4 && reps * unit >= 40) return true;
  }
  return false;
}

// (a) The last non-trivial unit (line or sentence) repeated ≥3 times in a row.
// Requires length ≥16 so legit short repeats (bullets, table rules) don't trip.
function hasRepeatedTailUnit(units: string[]): boolean {
  if (units.length < 3) return false;
  const last = units[units.length - 1];
  if (last.length < 16) return false;
  let reps = 1;
  for (let i = units.length - 2; i >= 0 && units[i] === last; i--) reps++;
  return reps >= 3;
}

export function isDegenerate(text: string): boolean {
  if (text.length < DEGEN_MIN_LEN) return false;
  if (hasShortCycleTail(text)) return true;
  const window = text.slice(-1200);
  const lines = window.split("\n").map((l) => l.trim()).filter(Boolean);
  if (hasRepeatedTailUnit(lines)) return true;
  // Sentence split without lookbehind (drops the terminator, which is fine for
  // equality of consecutive sentences).
  const sentences = window.split(/[.!?。！？]+\s+/).map((s) => s.trim()).filter(Boolean);
  return hasRepeatedTailUnit(sentences);
}

// Tools that ALWAYS surface an approval card, no matter the user's auto-approve
// setting or per-tool allowlist. These are the destructive ones: they move,
// rename, recycle, create, or run arbitrary shell, so the user must see and
// confirm each one every single time — auto-approve / "always allow" can never
// silently run them. Read-only tools (scan, search, reveal, find duplicates)
// stay auto-approvable. Keep this in sync with the mutating tools in agent.ts.
export const ALWAYS_APPROVE_TOOLS = new Set([
  "run_command",
  "move_items",
  "recycle_items",
  "rename_item",
  "create_folder",
  // New mutating edit tools — Tier-2 gated, never auto-approvable.
  "write_file",
  "edit_file",
  // Read-only but shell/network-touching, so they always need explicit approval.
  "git_status",
  "git_diff",
  "git_log",
  "web_fetch",
  "web_search",
]);

// A call needs ordered, blocking handling (its own approval card and/or sequential
// side effects) when it mutates, is the plan delegation, or is in ALWAYS_APPROVE.
// Everything else (plain read-only search tools, delegate_to_search) is safe to
// run concurrently with its siblings in the same turn.
function needsSerialHandling(name: string): boolean {
  return MUTATING_TOOLS.has(name) || ALWAYS_APPROVE_TOOLS.has(name) || name === "delegate_to_action";
}

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
  // Assistant stub-drafts + their paired nudge prompts created by guardFinal
  // "nudge" cycles. Tracked by reference so a later "force" can drop ALL of them
  // (not just the latest) and keep the model from re-reading withheld mistakes.
  const nudgeExchanges: LlmMessage[] = [];
  const ranTools = new Set<string>();
  // Structured findings accumulated from this run's tool results (paths/counts),
  // surfaced to the parent alongside the prose so it has machine-readable facts.
  const facts: AgentFacts = { paths: [], counts: {}, notes: [] };
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
  // Model actually used for streaming. May switch to ctx.fallbackModel after a
  // persistent mid-stream error (see the error-retry in the loop below), and
  // stays switched for the rest of this run once the fallback succeeds.
  let activeModel = ctx.model;
  let erroredRetried = false; // at most one automatic retry after a stream error
  // Per-turn debug accumulation (one entry per agent run): step count, tool
  // names, guard nudges, and rough input/output char counts. Only surfaced when
  // the host provides a sink (ctx.debug); never sent anywhere.
  const dbg: AgentDebugEntry = {
    runId, agent: spec.agent, steps: 0, tools: [], guardNudges: 0,
    inputChars: 0, outputChars: 0, status: "running", notes: [],
  };
  const historyChars = () =>
    history.reduce((n, m) => n + (m.content?.length ?? 0) + (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0), 0);

  // Append one tool result to history (and harvest structured facts). Kept
  // separate from execution so parallel calls record in a stable, original order.
  function recordToolResult(call: LlmToolCall, result: unknown): void {
    if (spec.extractFacts) {
      try { spec.extractFacts(call.name, result, facts); } catch { /* best-effort */ }
    }
    history.push({ role: "tool", content: safeJson(call.name, result), toolCallId: call.id, toolName: call.name });
  }

  // Execute a single tool call: validate args, approval-gate mutating/plan calls,
  // run it, and stream UI updates. Does NOT push to history (the caller records
  // results in order via recordToolResult). Shared by the model's own tool calls
  // and any call the runtime forces via the final-answer guard.
  async function runOneCall(call: LlmToolCall): Promise<{ result: unknown; status: "done" | "error" | "rejected" }> {
    ranTools.add(call.name);
    dbg.tools.push(call.name);
    // Malformed tool arguments: don't silently run with {} — feed a clear error
    // back so the model re-issues the call with valid JSON.
    if (call.argsError) {
      const resultObj = { ok: false, error: `Invalid JSON arguments for ${call.name}: ${call.argsError}. Re-call the tool with valid JSON arguments.` };
      ctx.emit({ kind: "tool_start", runId, callId: call.id, tool: call.name, args: call.args, mutating: MUTATING_TOOLS.has(call.name), requiresApproval: false });
      ctx.emit({ kind: "tool_update", runId, callId: call.id, status: "error", summary: "invalid arguments" });
      return { result: resultObj, status: "error" };
    }
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
    // Side-effecting MCP tools (declared at run start) always require approval,
    // exactly like ALWAYS_APPROVE_TOOLS — auto-approve/allowlist can't bypass them.
    const alwaysApprove = ALWAYS_APPROVE_TOOLS.has(call.name) || (ctx.gatedTools?.has(call.name) ?? false);
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
    return { result: resultObj, status: stepStatus };
  }

  // Run ONE streaming attempt with a stall timer and live degeneration detection,
  // both backed by a per-step AbortController chained to the run-wide signal (so a
  // user cancel still aborts, but we can also abort just this attempt to retry).
  // `optionsOverride` lets the degeneration retry crank up the anti-repetition
  // controls without disturbing the run's normal sampling options.
  async function streamOnce(optionsOverride?: LlmOptions, modelOverride?: string): Promise<{
    text: string;
    toolCalls: LlmToolCall[];
    errored: boolean;
    degenerated: boolean;
    stalled: boolean;
  }> {
    let text = "";
    const toolCalls: LlmToolCall[] = [];
    let errored = false;
    let degenerated = false;
    let stalled = false;
    // Rough input-size accounting for the debug bundle (measured before the call;
    // history is only mutated by the caller after streamOnce returns).
    dbg.inputChars += historyChars();

    const stepAbort = new AbortController();
    const onParentAbort = () => stepAbort.abort();
    if (ctx.signal.aborted) stepAbort.abort();
    else ctx.signal.addEventListener("abort", onParentAbort);

    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => { stalled = true; stepAbort.abort(); }, STREAM_STALL_MS);
    };
    armStall();

    try {
      for await (const ev of llmStream({
        provider: ctx.provider,
        model: modelOverride ?? activeModel,
        apiKey: ctx.apiKey,
        messages: history,
        tools: useTools ? spec.tools : undefined,
        signal: stepAbort.signal,
        options: optionsOverride ? { ...ctx.options, ...optionsOverride } : ctx.options,
      })) {
        armStall(); // any event = progress; reset the stall countdown
        if (ev.type === "thinking") {
          ctx.emit({ kind: "thinking", runId, delta: ev.value });
        } else if (ev.type === "text") {
          text += ev.value;
          ctx.emit({ kind: "text", runId, delta: ev.value });
          if (!degenerated && isDegenerate(text)) {
            degenerated = true;
            stepAbort.abort(); // stop the runaway stream immediately
            break;
          }
        } else if (ev.type === "tool_calls") {
          toolCalls.push(...ev.value);
        } else if (ev.type === "error") {
          ctx.emit({ kind: "notice", runId, level: "error", text: ev.value });
          errored = true;
        }
      }
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
      ctx.signal.removeEventListener("abort", onParentAbort);
    }
    dbg.outputChars += text.length + toolCalls.reduce((n, c) => n + (c.args ? JSON.stringify(c.args).length : 0), 0);
    return { text, toolCalls, errored, degenerated, stalled };
  }

  for (let step = 0; step < spec.maxSteps; step++) {
    if (ctx.signal.aborted) {
      status = "error";
      break;
    }
    dbg.steps++;

    let { text, toolCalls, errored, degenerated, stalled } = await streamOnce();

    // Degeneration / stall guard: the model started repeating itself or went
    // silent. Clear the on-screen partial and retry ONCE with stronger
    // anti-repetition + lower temperature. If it still fails, stop this step and
    // fall back to whatever real findings were gathered (never surface junk).
    if ((degenerated || stalled) && !ctx.signal.aborted) {
      const why = stalled ? "stalled (no output for 30s)" : "began repeating itself";
      dbg.notes.push(stalled ? "stalled" : "degenerated");
      ctx.emit({ kind: "notice", runId, level: "warn", text: `The model ${why} — retrying once with stronger anti-repetition settings.` });
      ctx.emit({ kind: "text_reset", runId });
      const retry = await streamOnce({ temperature: 0.2, topP: 0.85, repeatPenalty: 1.3 });
      text = retry.text;
      toolCalls = retry.toolCalls;
      errored = retry.errored;
      degenerated = retry.degenerated;
      stalled = retry.stalled;
      if ((degenerated || stalled) && !ctx.signal.aborted) {
        dbg.notes.push(stalled ? "stalled again" : "still degenerating");
        ctx.emit({ kind: "notice", runId, level: "error", text: `The model ${stalled ? "stalled again" : "kept degenerating"} — stopping this step and using the results gathered so far.` });
        ctx.emit({ kind: "text_reset", runId });
        finalText = "";
        reachedFinal = false;
        break;
      }
    }

    // Mid-stream error guard: retry ONCE per run. If the host supplied a distinct
    // fallback model (cloud only), switch to it for the retry — and keep using it
    // for the rest of the run if it succeeds — so a rate-limited / failing model
    // doesn't sink the whole turn. The cloud transport already did its own
    // HTTP-level 429/503 backoff before surfacing this error.
    if (errored && !ctx.signal.aborted && !erroredRetried) {
      erroredRetried = true;
      const useFallback = !!ctx.fallbackModel && ctx.fallbackModel !== activeModel;
      dbg.notes.push(useFallback ? `error → retry with ${ctx.fallbackModel}` : "error → retry");
      ctx.emit({
        kind: "notice", runId, level: "warn",
        text: useFallback ? `The model errored — retrying with ${ctx.fallbackModel}.` : "The model errored — retrying once.",
      });
      ctx.emit({ kind: "text_reset", runId });
      const retry = await streamOnce(undefined, useFallback ? ctx.fallbackModel : undefined);
      if (useFallback && !retry.errored && !ctx.signal.aborted) activeModel = ctx.fallbackModel!;
      text = retry.text;
      toolCalls = retry.toolCalls;
      errored = retry.errored;
      degenerated = retry.degenerated;
      stalled = retry.stalled;
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
      // Run independent READ-ONLY calls concurrently; keep serial-handling calls
      // (mutating, plan delegation, or always-approve) strictly sequential so
      // their approval cards surface and any side effects stay ordered. Then
      // record every result back into history in the ORIGINAL call order so the
      // model sees a stable, deterministic transcript.
      const serialName = (name: string) => needsSerialHandling(name) || (ctx.gatedTools?.has(name) ?? false);
      const parallel = toolCalls.filter((c) => !serialName(c.name));
      const serial = toolCalls.filter((c) => serialName(c.name));
      const resultById = new Map<string, unknown>();

      await Promise.all(
        parallel.map(async (call) => {
          const ran = await runOneCall(call);
          resultById.set(call.id, ran.result);
        }),
      );
      for (const call of serial) {
        if (ctx.signal.aborted) break;
        const ran = await runOneCall(call);
        resultById.set(call.id, ran.result);
      }

      for (const call of toolCalls) {
        if (!resultById.has(call.id)) continue; // aborted before this serial call ran
        const result = resultById.get(call.id);
        recordToolResult(call, result);
        // Capture renderable findings from real (model-issued) calls too, so a
        // model that gathers data but then stalls still yields a useful answer.
        if (spec.formatFindings) {
          const findings = spec.formatFindings(call.name, result);
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
      dbg.notes.push("empty → retry without tools");
      ctx.emit({ kind: "notice", runId, level: "warn", text: `${activeModel} returned no tool call — retrying without tools.` });
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
        // above the corrected answer.
        ctx.emit({ kind: "text_reset", runId });
        // Crucially, do NOT keep the full fabricated draft in history — the model
        // re-reading its own invented file names/sizes is what drove the
        // self-correction spiral ("Wait, I see a mistake in my previous
        // response…"). Replace it with a terse stub so the corrective nudge below
        // stands on its own. Track the stub + nudge so a later "force" can drop
        // the whole exchange.
        const draft = history[history.length - 1];
        if (draft && draft.role === "assistant") {
          draft.content = WITHHELD_DRAFT;
          draft.toolCalls = undefined;
          nudgeExchanges.push(draft);
        }
        const nudgeMsg: LlmMessage = { role: "user", content: decision.message };
        history.push(nudgeMsg);
        nudgeExchanges.push(nudgeMsg);
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
        // Also drop EARLIER nudge-cycle drafts + their nudge prompts (by
        // reference, so real tool exchanges between nudges are preserved). This
        // removes them in (assistant-stub, user-nudge) pairs, keeping role
        // alternation valid for strict providers like Anthropic.
        if (nudgeExchanges.length) {
          for (let i = history.length - 1; i >= 0; i--) {
            if (nudgeExchanges.includes(history[i])) history.splice(i, 1);
          }
          nudgeExchanges.length = 0;
        }
        if (decision.notice) ctx.emit({ kind: "notice", runId, level: "warn", text: decision.notice });
        const forced: LlmToolCall = { id: ctx.newId("call_"), name: decision.call.name, args: decision.call.args };
        history.push({ role: "assistant", content: "", toolCalls: [forced] });
        const ran = await runOneCall(forced);
        recordToolResult(forced, ran.result);
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
    dbg.notes.push("step limit");
    ctx.emit({ kind: "notice", runId, level: "warn", text: "Reached the step limit — wrapping up with what's been gathered so far." });
  }
  // If the model never produced a final answer but we gathered real findings
  // (forced or model-issued), return them so the user always sees actual data,
  // not a blank turn.
  if (status !== "error" && !finalText.trim() && fallbackFindings.trim()) {
    finalText = fallbackFindings;
  }
  if (status === "done" && !finalText.trim()) {
    dbg.notes.push("empty final");
    ctx.emit({ kind: "notice", runId, level: "warn", text: "The model returned an empty response. Try a tool-capable model (e.g. qwen2.5, llama3.1) or a cloud provider." });
  }
  if (ctx.debug) {
    dbg.guardNudges = nudges;
    dbg.status = status;
    ctx.debug.push(dbg);
  }
  ctx.emit({ kind: "agent_end", runId, agent: spec.agent, status, summary: finalText });
  return { runId, text: finalText, status, facts };
}

// Serialize a tool result for the model. When it exceeds the cap we keep the
// head and tell the model HOW MUCH was cut and how to get the rest (most
// read-only tools accept offset/limit and return next_offset), so a truncated
// result is actionable instead of a silent dead end.
const TOOL_JSON_CAP = 8000;
function safeJson(toolName: string, value: unknown): string {
  try {
    const s = JSON.stringify(value);
    if (s.length <= TOOL_JSON_CAP) return s;
    const cut = s.length - TOOL_JSON_CAP;
    return (
      s.slice(0, TOOL_JSON_CAP) +
      `…[truncated ${cut} more chars from the ${toolName} result. ` +
      `Narrow your query (dir/glob/ext/files_only) or paginate with offset/limit (use next_offset) to see the rest.]`
    );
  } catch {
    return String(value);
  }
}
