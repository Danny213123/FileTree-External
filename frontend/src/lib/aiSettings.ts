// Persists the chat's provider/model choice and cloud API keys in localStorage.
// Keys never leave the machine: for cloud calls the renderer hands the key to
// Electron main over IPC, which makes the HTTPS request.

import type { LlmProvider } from "./llm";

export interface AiSettings {
  provider: LlmProvider;
  model: string;
  keys: { openai: string; anthropic: string };
}

const KEY = "filetree.ai.settings";

const DEFAULTS: AiSettings = {
  provider: "ollama",
  model: "",
  keys: { openai: "", anthropic: "" },
};

export function loadAiSettings(): AiSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS, keys: { ...DEFAULTS.keys } };
    const parsed = JSON.parse(raw) as Partial<AiSettings>;
    return {
      provider: parsed.provider ?? DEFAULTS.provider,
      model: parsed.model ?? DEFAULTS.model,
      keys: {
        openai: parsed.keys?.openai ?? "",
        anthropic: parsed.keys?.anthropic ?? "",
      },
    };
  } catch {
    return { ...DEFAULTS, keys: { ...DEFAULTS.keys } };
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
