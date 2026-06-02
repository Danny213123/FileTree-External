// Persists the chat's provider/model choice and cloud API keys. Non-secret
// preferences (provider, model, always-allow list) live in localStorage; cloud
// API keys are stored in Electron's safeStorage via `electronAPI.secrets` so
// they are never written to disk in plaintext. Keys never leave the machine:
// for cloud calls the renderer hands the key to Electron main over IPC, which
// makes the HTTPS request. A localStorage fallback keeps plain-browser dev working.

import type { LlmProvider } from "./llm";

export interface AiSettings {
  provider: LlmProvider;
  model: string;
  keys: { openai: string; anthropic: string };
  // Tool names the user chose to "always allow" — these run without surfacing a
  // per-action approval card (e.g. "move_items", "delegate_to_action"). Note:
  // run_command can never be allow-listed; it always requires explicit approval.
  allow: string[];
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
};

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
  };
}

export function saveAiSettings(s: AiSettings): void {
  try {
    const payload: Partial<AiSettings> = { provider: s.provider, model: s.model, allow: s.allow };
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
