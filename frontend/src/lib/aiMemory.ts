// Tiny persistent "memory" store for the AI assistant, backed by localStorage.
// Separate from aiSettings (provider/model/keys) so it has ZERO imports and can
// be read safely from the tool layer (agent.ts) at run start without any risk
// of an import cycle. The agent reads the accumulated notes into its system
// prompt and may append new notes via the `remember` tool.

const MEMORY_KEY = "filetree.ai.memory";
const MAX_NOTES = 50;
const MAX_NOTE_LEN = 400;

export interface MemoryNote {
  ts: number;
  text: string;
}

export function loadMemory(): MemoryNote[] {
  try {
    const raw = localStorage.getItem(MEMORY_KEY);
    const list = raw ? (JSON.parse(raw) as MemoryNote[]) : [];
    return Array.isArray(list) ? list.filter((n) => n && typeof n.text === "string") : [];
  } catch {
    return [];
  }
}

/** Append one note, dedupe against the latest, and cap the store size. */
export function appendMemory(text: string): MemoryNote[] {
  const clean = (text ?? "").trim().slice(0, MAX_NOTE_LEN);
  if (!clean) return loadMemory();
  const list = loadMemory();
  if (list.some((n) => n.text === clean)) return list; // already remembered
  list.push({ ts: Date.now(), text: clean });
  const trimmed = list.slice(-MAX_NOTES);
  try {
    localStorage.setItem(MEMORY_KEY, JSON.stringify(trimmed));
  } catch {
    /* ignore quota */
  }
  return trimmed;
}

export function clearMemory(): void {
  try {
    localStorage.removeItem(MEMORY_KEY);
  } catch {
    /* ignore */
  }
}

/** Render the memory as a compact, prompt-ready block (empty string if none). */
export function memoryBlock(): string {
  const list = loadMemory();
  if (!list.length) return "";
  return ["Remembered notes (persisted across chats):", ...list.map((n) => `- ${n.text}`)].join("\n");
}
