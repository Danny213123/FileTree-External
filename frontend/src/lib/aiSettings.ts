// Persists the chat's provider/model choice and cloud API keys in localStorage.
// Keys never leave the machine: for cloud calls the renderer hands the key to
// Electron main over IPC, which makes the HTTPS request.

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

const DEFAULTS: AiSettings = {
  provider: "ollama",
  model: "",
  keys: { openai: "", anthropic: "" },
  allow: [],
};

export function loadAiSettings(): AiSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS, keys: { ...DEFAULTS.keys }, allow: [] };
    const parsed = JSON.parse(raw) as Partial<AiSettings>;
    return {
      provider: parsed.provider ?? DEFAULTS.provider,
      model: parsed.model ?? DEFAULTS.model,
      keys: {
        openai: parsed.keys?.openai ?? "",
        anthropic: parsed.keys?.anthropic ?? "",
      },
      allow: Array.isArray(parsed.allow) ? parsed.allow.filter((t): t is string => typeof t === "string") : [],
    };
  } catch {
    return { ...DEFAULTS, keys: { ...DEFAULTS.keys }, allow: [] };
  }
}

export function saveAiSettings(s: AiSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore quota errors */
  }
}

export function keyFor(s: AiSettings, provider: LlmProvider): string {
  if (provider === "openai") return s.keys.openai;
  if (provider === "anthropic") return s.keys.anthropic;
  return "";
}

export function isAllowed(s: AiSettings, tool: string): boolean {
  return s.allow.includes(tool);
}
