// Unified LLM gateway for the multi-agent chat.
//
// One `llmStream()` abstraction normalizes three transports into a single event
// stream so the agent runtime never has to care which provider it talks to:
//   • ollama    → POST /api/ai-chat on the Rust server (NDJSON). Works in both
//                 Electron and the dev-web build.
//   • openai    → Electron main IPC (Node `fetch` handles TLS + SSE).
//   • anthropic → Electron main IPC.
// The cloud providers are routed through Electron main because the Rust server
// is a no-TLS custom HTTP server and can't call HTTPS APIs cleanly.

import type { ToolDef } from "./agent";

export type LlmProvider = "ollama" | "openai" | "anthropic";

export interface LlmToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type LlmRole = "system" | "user" | "assistant" | "tool";

// A base64 image attachment. `dataUrl` is the full `data:<mime>;base64,…` form;
// providers that want the raw payload (Ollama/Anthropic) strip the prefix.
export interface LlmImage {
  dataUrl: string;
  mediaType: string;
}

export interface LlmMessage {
  role: LlmRole;
  content: string;
  toolCalls?: LlmToolCall[];
  // role:"tool" only — links a result back to the assistant tool call.
  toolCallId?: string;
  toolName?: string;
  // role:"user" only — multimodal image inputs for vision-capable models.
  images?: LlmImage[];
}

export function base64Of(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

export type LlmEvent =
  | { type: "text"; value: string }
  | { type: "thinking"; value: string }
  | { type: "tool_calls"; value: LlmToolCall[] }
  | { type: "done" }
  | { type: "error"; value: string };

export interface LlmRequest {
  provider: LlmProvider;
  model: string;
  apiKey?: string;
  messages: LlmMessage[];
  tools?: ToolDef[];
  signal?: AbortSignal;
}

// ── id helpers ───────────────────────────────────────────────
let SEQ = 0;
export function uid(prefix = ""): string {
  SEQ = (SEQ + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${SEQ.toString(36)}`;
}

// ── Electron bridge ──────────────────────────────────────────
interface LlmBridge {
  models: (provider: LlmProvider, apiKey?: string) => Promise<string[]>;
  start: (reqId: string, payload: unknown) => void;
  cancel: (reqId: string) => void;
  onEvent: (cb: (reqId: string, ev: LlmEvent) => void) => () => void;
}
type WithLlm = { electronAPI?: { llm?: LlmBridge } };
function bridge(): LlmBridge | null {
  return (window as unknown as WithLlm).electronAPI?.llm ?? null;
}
export function hasCloudGateway(): boolean {
  return bridge() != null;
}

// ── Public model listing ─────────────────────────────────────
export async function listModels(provider: LlmProvider, apiKey?: string): Promise<string[]> {
  if (provider === "ollama") {
    try {
      const res = await fetch("/api/ai-models");
      if (!res.ok) return [];
      const data = (await res.json()) as { models?: { name: string }[] };
      return (data.models ?? []).map((m) => m.name);
    } catch {
      return [];
    }
  }
  const b = bridge();
  if (!b) return CLOUD_FALLBACK_MODELS[provider] ?? [];
  try {
    const list = await b.models(provider, apiKey);
    return list.length ? list : CLOUD_FALLBACK_MODELS[provider] ?? [];
  } catch {
    return CLOUD_FALLBACK_MODELS[provider] ?? [];
  }
}

export const CLOUD_FALLBACK_MODELS: Record<LlmProvider, string[]> = {
  ollama: [],
  openai: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1", "o3-mini"],
  anthropic: [
    "claude-3-5-haiku-latest",
    "claude-3-5-sonnet-latest",
    "claude-3-7-sonnet-latest",
  ],
};

// Ollama families that reliably support tool-calling. Used to warn the user
// when an agent run is started with a model that will silently ignore tools.
const TOOL_CAPABLE_RE = /(llama3\.[123]|llama-3\.[123]|qwen2\.5|qwen2|qwen3|qwq|mistral|mixtral|command-r|firefunction|hermes|granite3|smollm2|cogito)/i;
export function isToolCapable(provider: LlmProvider, model: string): boolean {
  if (provider !== "ollama") return true; // all supported cloud models tool-call
  return TOOL_CAPABLE_RE.test(model);
}

// Models that accept image inputs. Soft check — used only to warn the user when
// they attach an image to a model that will ignore or reject it.
const VISION_RE = /(gpt-4o|gpt-4\.1|gpt-4-vision|o4|llava|bakllava|moondream|minicpm-v|qwen2\.?5?-?vl|qwen2-vl|llama3\.2-vision|llama-3\.2-vision|llama4|gemma3|pixtral|vision)/i;
export function isVisionCapable(provider: LlmProvider, model: string): boolean {
  if (provider === "anthropic") return /claude-3|claude-4|claude-opus|claude-sonnet|claude-haiku/i.test(model);
  return VISION_RE.test(model);
}

// ── Main entry: unified stream ───────────────────────────────
export async function* llmStream(req: LlmRequest): AsyncGenerator<LlmEvent> {
  if (req.provider === "ollama") {
    yield* streamOllama(req);
  } else {
    yield* streamCloud(req);
  }
}

// ── Ollama (Rust /api/ai-chat, NDJSON) ───────────────────────
function toOllamaMessages(messages: LlmMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args } })),
      };
    }
    if (m.role === "tool") {
      return { role: "tool", content: m.content, tool_name: m.toolName };
    }
    if (m.role === "user" && m.images?.length) {
      // Ollama takes raw base64 strings (no data: prefix) in `images`.
      return { role: "user", content: m.content, images: m.images.map((im) => base64Of(im.dataUrl)) };
    }
    return { role: m.role, content: m.content };
  });
}

async function* streamOllama(req: LlmRequest): AsyncGenerator<LlmEvent> {
  let res: Response;
  try {
    res = await fetch("/api/ai-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: req.model,
        messages: toOllamaMessages(req.messages),
        tools: req.tools && req.tools.length ? req.tools : undefined,
        stream: true,
      }),
      signal: req.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    yield { type: "error", value: `Could not reach Ollama: ${(e as Error).message}` };
    return;
  }
  if (!res.ok || !res.body) {
    yield { type: "error", value: `Ollama HTTP ${res.status}` };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const think = createThinkSplitter();
  const toolCalls: LlmToolCall[] = [];
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: {
          message?: { content?: string; thinking?: string; tool_calls?: { function: { name: string; arguments: unknown } }[] };
          error?: string;
        };
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (parsed.error) {
          yield { type: "error", value: parsed.error };
          return;
        }
        const msg = parsed.message;
        if (msg?.thinking) yield { type: "thinking", value: msg.thinking };
        if (msg?.content) {
          for (const piece of think.push(msg.content)) yield piece;
        }
        if (msg?.tool_calls?.length) {
          for (const tc of msg.tool_calls) {
            toolCalls.push({ id: uid("call_"), name: tc.function.name, args: asObject(tc.function.arguments) });
          }
        }
      }
    }
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    yield { type: "error", value: (e as Error).message };
    return;
  }
  for (const piece of think.flush()) yield piece;
  if (toolCalls.length) yield { type: "tool_calls", value: toolCalls };
  yield { type: "done" };
}

function asObject(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return (raw as Record<string, unknown>) ?? {};
}

// ── Cloud (Electron main IPC) ────────────────────────────────
async function* streamCloud(req: LlmRequest): AsyncGenerator<LlmEvent> {
  const b = bridge();
  if (!b) {
    yield { type: "error", value: "Cloud providers require the FileTree desktop app." };
    return;
  }
  if (!req.apiKey) {
    yield { type: "error", value: `No API key set for ${req.provider}. Open the key settings in the chat header.` };
    return;
  }

  const reqId = uid("llm_");
  const queue: LlmEvent[] = [];
  let wake: (() => void) | null = null;
  let finished = false;

  const off = b.onEvent((id, ev) => {
    if (id !== reqId) return;
    queue.push(ev);
    if (ev.type === "done" || ev.type === "error") finished = true;
    wake?.();
  });
  const onAbort = () => {
    b.cancel(reqId);
    finished = true;
    wake?.();
  };
  req.signal?.addEventListener("abort", onAbort);

  b.start(reqId, {
    provider: req.provider,
    model: req.model,
    apiKey: req.apiKey,
    messages: req.messages,
    tools: req.tools && req.tools.length ? req.tools : undefined,
  });

  try {
    while (true) {
      while (queue.length) {
        const ev = queue.shift()!;
        yield ev;
        if (ev.type === "done" || ev.type === "error") return;
      }
      if (finished) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = null;
    }
  } finally {
    off();
    req.signal?.removeEventListener("abort", onAbort);
  }
}

// ── <think> stream splitter ──────────────────────────────────
// Many local reasoning models interleave chain-of-thought inside
// <think>…</think>. Split the stream into text vs thinking deltas, holding back
// a few trailing chars so a tag split across chunks is not misclassified.
const OPEN = "<think>";
const CLOSE = "</think>";
const HOLD = CLOSE.length; // longest tag we must not split mid-way

export function createThinkSplitter() {
  let pending = "";
  let inside = false;

  function drain(flush: boolean): LlmEvent[] {
    const out: LlmEvent[] = [];
    while (true) {
      const tag = inside ? CLOSE : OPEN;
      const idx = pending.indexOf(tag);
      if (idx >= 0) {
        const chunk = pending.slice(0, idx);
        if (chunk) out.push({ type: inside ? "thinking" : "text", value: chunk });
        pending = pending.slice(idx + tag.length);
        inside = !inside;
        continue;
      }
      // No complete tag. Emit everything except a possible partial tag tail.
      const keep = flush ? 0 : HOLD;
      if (pending.length > keep) {
        const chunk = pending.slice(0, pending.length - keep);
        if (chunk) out.push({ type: inside ? "thinking" : "text", value: chunk });
        pending = pending.slice(pending.length - keep);
      }
      break;
    }
    return out;
  }

  return {
    push(delta: string): LlmEvent[] {
      pending += delta;
      return drain(false);
    },
    flush(): LlmEvent[] {
      return drain(true);
    },
  };
}
