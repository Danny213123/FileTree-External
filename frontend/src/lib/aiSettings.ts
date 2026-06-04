// Persists the chat's provider/model choice and cloud API keys. Non-secret
// preferences (provider, model, always-allow list) live in localStorage; cloud
// API keys are stored in Electron's safeStorage via `electronAPI.secrets` so
// they are never written to disk in plaintext. Keys never leave the machine:
// for cloud calls the renderer hands the key to Electron main over IPC, which
// makes the HTTPS request. A localStorage fallback keeps plain-browser dev working.

import { DEFAULT_LLM_OPTIONS, type LlmOptions, type LlmProvider } from "./llm";

// One configured Model Context Protocol server. `transport` selects how Electron
// main reaches it: a spawned process speaking newline-delimited JSON-RPC over
// stdio, or an HTTP JSON-RPC endpoint. Disabled servers are kept but skipped.
export interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: "stdio" | "http";
  /** stdio: executable to spawn. */
  command?: string;
  /** stdio: arguments for the executable. */
  args?: string[];
  /** http: JSON-RPC endpoint URL. */
  url?: string;
}

export interface AiSettings {
  provider: LlmProvider;
  model: string;
  keys: { openai: string; anthropic: string };
  // Tool names the user chose to "always allow" — these run without surfacing a
  // per-action approval card (e.g. "move_items", "delegate_to_action"). Note:
  // run_command can never be allow-listed; it always requires explicit approval.
  allow: string[];
  // User-authored custom instructions / project rules injected into every
  // agent's system prompt (scanContext/scanSummary). Empty by default.
  rules: string;
  // Configured MCP servers whose tools are discovered + registered at run start.
  mcpServers: McpServerConfig[];
  // Decoding / sampling controls applied to every provider request (anti-
  // repetition defaults; see DEFAULT_LLM_OPTIONS in llm.ts). Persisted so they
  // survive reloads; defaults are applied on load when a value is unset.
  temperature: number;
  topP: number;
  repeatPenalty: number; // Ollama repeat_penalty
  repeatLastN: number; // Ollama repeat_last_n
  numCtx: number; // Ollama num_ctx context budget
  numPredict: number; // Ollama num_predict max output tokens
  maxTokens: number; // cloud (OpenAI/Anthropic) max output tokens
}

const KEY = "filetree.ai.settings";

// safeStorage entry names for each cloud provider's API key.
const SECRET_KEYS: Record<keyof AiSettings["keys"], string> = {
  openai: "filetree.ai.key.openai",
  anthropic: "filetree.ai.key.anthropic",
};

const DEFAULTS: AiSettings = {
  provider: "ollama",
  model: "",
  keys: { openai: "", anthropic: "" },
  allow: [],
  rules: "",
  mcpServers: [],
  temperature: DEFAULT_LLM_OPTIONS.temperature,
  topP: DEFAULT_LLM_OPTIONS.topP,
  repeatPenalty: DEFAULT_LLM_OPTIONS.repeatPenalty,
  repeatLastN: DEFAULT_LLM_OPTIONS.repeatLastN,
  numCtx: DEFAULT_LLM_OPTIONS.numCtx,
  numPredict: DEFAULT_LLM_OPTIONS.numPredict,
  maxTokens: DEFAULT_LLM_OPTIONS.maxTokens,
};

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** safeStorage-backed secret store exposed by the Electron preload. */
interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

function secretStore(): SecretStore | null {
  return (window as unknown as { electronAPI?: { secrets?: SecretStore } })
    .electronAPI?.secrets ?? null;
}

function readRaw(): Partial<AiSettings> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Partial<AiSettings>) : {};
  } catch {
    return {};
  }
}

export function loadAiSettings(): AiSettings {
  const parsed = readRaw();
  return {
    provider: parsed.provider ?? DEFAULTS.provider,
    model: parsed.model ?? DEFAULTS.model,
    // Legacy/fallback keys (plain-browser dev, or pre-migration). When
    // safeStorage is available the async loadAiKeys() supplies the real values.
    keys: {
      openai: parsed.keys?.openai ?? "",
      anthropic: parsed.keys?.anthropic ?? "",
    },
    allow: Array.isArray(parsed.allow) ? parsed.allow.filter((t): t is string => typeof t === "string") : [],
    rules: typeof parsed.rules === "string" ? parsed.rules : DEFAULTS.rules,
    mcpServers: Array.isArray(parsed.mcpServers)
      ? parsed.mcpServers.filter((m): m is McpServerConfig => !!m && typeof (m as McpServerConfig).id === "string")
      : [],
    temperature: numOr(parsed.temperature, DEFAULTS.temperature),
    topP: numOr(parsed.topP, DEFAULTS.topP),
    repeatPenalty: numOr(parsed.repeatPenalty, DEFAULTS.repeatPenalty),
    repeatLastN: numOr(parsed.repeatLastN, DEFAULTS.repeatLastN),
    numCtx: numOr(parsed.numCtx, DEFAULTS.numCtx),
    numPredict: numOr(parsed.numPredict, DEFAULTS.numPredict),
    maxTokens: numOr(parsed.maxTokens, DEFAULTS.maxTokens),
  };
}

export function saveAiSettings(s: AiSettings): void {
  try {
    const payload: Partial<AiSettings> = {
      provider: s.provider,
      model: s.model,
      allow: s.allow,
      rules: s.rules,
      mcpServers: s.mcpServers,
      temperature: s.temperature,
      topP: s.topP,
      repeatPenalty: s.repeatPenalty,
      repeatLastN: s.repeatLastN,
      numCtx: s.numCtx,
      numPredict: s.numPredict,
      maxTokens: s.maxTokens,
    };
    // Cloud keys belong in safeStorage when available; never persist them as
    // plaintext in localStorage. Only the plain-browser fallback writes them.
    if (!secretStore()) payload.keys = s.keys;
    localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    /* ignore quota errors */
  }
}

/**
 * Resolve the cloud API keys, preferring safeStorage. Any key still sitting in
 * localStorage (from an older build) is migrated into safeStorage and then
 * stripped from localStorage. Falls back to the localStorage copy when
 * safeStorage is unavailable (plain-browser dev). Never throws.
 */
export async function loadAiKeys(): Promise<AiSettings["keys"]> {
  // Capture legacy keys synchronously up front so a concurrent saveAiSettings()
  // (which strips keys once safeStorage is present) can't race the migration.
  const legacy: Partial<AiSettings["keys"]> = readRaw().keys ?? {};
  const store = secretStore();
  if (!store) {
    return { openai: legacy.openai ?? "", anthropic: legacy.anthropic ?? "" };
  }

  const result: AiSettings["keys"] = { openai: "", anthropic: "" };
  let hadLegacyKeys = false;
  for (const provider of Object.keys(SECRET_KEYS) as (keyof AiSettings["keys"])[]) {
    const secretKey = SECRET_KEYS[provider];
    let value = "";
    try { value = (await store.get(secretKey)) ?? ""; } catch { value = ""; }
    const legacyValue = legacy[provider] ?? "";
    if (legacyValue) {
      hadLegacyKeys = true;
      if (!value) {
        // Migrate the plaintext localStorage key into safeStorage.
        try { await store.set(secretKey, legacyValue); } catch { /* keep in-memory only */ }
        value = legacyValue;
      }
    }
    result[provider] = value;
  }

  // Remove any plaintext keys left behind in localStorage after migration.
  if (hadLegacyKeys) {
    const raw = readRaw();
    if (raw.keys) {
      delete raw.keys;
      try { localStorage.setItem(KEY, JSON.stringify(raw)); } catch { /* ignore */ }
    }
  }
  return result;
}

/** Persist a single provider key — to safeStorage when available, else the
 *  localStorage fallback. Empty value clears the stored key. Never throws. */
export async function saveAiKey(provider: keyof AiSettings["keys"], value: string): Promise<void> {
  const store = secretStore();
  const secretKey = SECRET_KEYS[provider];
  if (store) {
    try {
      if (value) await store.set(secretKey, value);
      else await store.delete(secretKey);
    } catch {
      /* best-effort; key simply won't persist this session */
    }
    return;
  }
  // Fallback: persist inside the localStorage settings blob.
  const raw = readRaw();
  const keys = { openai: raw.keys?.openai ?? "", anthropic: raw.keys?.anthropic ?? "" };
  keys[provider] = value;
  raw.keys = keys;
  try { localStorage.setItem(KEY, JSON.stringify(raw)); } catch { /* ignore */ }
}

export function keyFor(s: AiSettings, provider: LlmProvider): string {
  if (provider === "openai") return s.keys.openai;
  if (provider === "anthropic") return s.keys.anthropic;
  return "";
}

export function isAllowed(s: AiSettings, tool: string): boolean {
  return s.allow.includes(tool);
}

/** Map the persisted sampling settings into the provider-agnostic LlmOptions
 *  passed to llmStream. frequencyPenalty (OpenAI-only) is left to the provider
 *  default in Electron main. */
export function samplingOptions(s: AiSettings): LlmOptions {
  return {
    temperature: s.temperature,
    topP: s.topP,
    repeatPenalty: s.repeatPenalty,
    repeatLastN: s.repeatLastN,
    numCtx: s.numCtx,
    numPredict: s.numPredict,
    maxTokens: s.maxTokens,
  };
}
