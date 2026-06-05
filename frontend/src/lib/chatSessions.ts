// Lightweight chat-session persistence backed by localStorage. The title bar's
// "new session" / "session history" controls live in App, while the ChatPanel
// owns the actual message + model history. We persist a small index (for the
// history dropdown) plus one blob per session (messages + Ollama history) so a
// session can be fully restored after it has been closed or replaced.

export interface ChatSessionMeta {
  id: string;
  title: string;
  ts: number;
  count: number;
  /** Pinned sessions sort to the top of the history list and stay there. */
  pinned?: boolean;
  /** True once the user renamed the session, so auto-save stops overwriting the
   *  title with the (derived-from-first-message) default. */
  renamed?: boolean;
}

export interface ChatSessionBlob {
  // Multi-agent render model (current format).
  items?: unknown[];
  runs?: Record<string, unknown>;
  convo?: unknown[];
  // Rolling auto-summary of messages that have aged out of the recent window.
  summary?: string;
  // Legacy single-agent format (pre-overhaul); still loadable.
  messages?: unknown[];
  history?: unknown[];
}

const INDEX_KEY = "filetree.chat.sessions";
const MAX_SESSIONS = 50;
const blobKey = (id: string) => `filetree.chat.session.${id}`;

export function newChatSessionId(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// Pinned sessions float to the top (keeping recency order within each group).
function sortIndex(list: ChatSessionMeta[]): ChatSessionMeta[] {
  return list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.ts - a.ts);
}

export function loadChatIndex(): ChatSessionMeta[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    const list = raw ? (JSON.parse(raw) as ChatSessionMeta[]) : [];
    return Array.isArray(list) ? sortIndex(list) : [];
  } catch {
    return [];
  }
}

// Read the raw (unsorted) index without throwing — used internally by mutators.
function rawIndex(): ChatSessionMeta[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    const list = raw ? (JSON.parse(raw) as ChatSessionMeta[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function loadChatSession(id: string): ChatSessionBlob | null {
  try {
    const raw = localStorage.getItem(blobKey(id));
    return raw ? (JSON.parse(raw) as ChatSessionBlob) : null;
  } catch {
    return null;
  }
}

// Strip the heavy, non-essential bits before persisting so localStorage doesn't
// balloon: image data URLs (often hundreds of KB each) are dropped from the
// stored convo/items, and verbose tool `output` blobs in the UI runs are capped.
// The live in-memory session keeps everything; only what's WRITTEN is pruned.
const MAX_STORED_OUTPUT = 2000;
function pruneBlob(blob: ChatSessionBlob): ChatSessionBlob {
  return JSON.parse(
    JSON.stringify(blob, (key, value) => {
      // Drop multimodal image payloads wherever they appear (convo messages,
      // attached chips, etc.) — they don't need to survive a reload.
      if (key === "images" || key === "dataUrl") return undefined;
      // Cap long captured command/tool output kept in the rendered runs.
      if (key === "output" && typeof value === "string" && value.length > MAX_STORED_OUTPUT) {
        return value.slice(0, MAX_STORED_OUTPUT) + "\n…(truncated)";
      }
      return value;
    }),
  ) as ChatSessionBlob;
}

export function saveChatSession(id: string, title: string, blob: ChatSessionBlob, count: number): void {
  try {
    localStorage.setItem(blobKey(id), JSON.stringify(pruneBlob(blob)));
    const all = rawIndex();
    const prev = all.find((s) => s.id === id);
    const index = all.filter((s) => s.id !== id);
    // Preserve a user-set (renamed) title + the pinned flag across auto-saves.
    index.unshift({
      id,
      title: prev?.renamed ? prev.title : (title || "New chat"),
      ts: Date.now(),
      count,
      pinned: prev?.pinned,
      renamed: prev?.renamed,
    });
    const ordered = sortIndex(index);
    const trimmed = ordered.slice(0, MAX_SESSIONS);
    localStorage.setItem(INDEX_KEY, JSON.stringify(trimmed));
    // Drop blobs that fell out of the index so storage doesn't grow forever.
    for (const stale of ordered.slice(MAX_SESSIONS)) localStorage.removeItem(blobKey(stale.id));
  } catch {
    // Ignore quota / serialization errors — chat still works in-memory.
  }
}

export function deleteChatSession(id: string): void {
  try {
    localStorage.removeItem(blobKey(id));
    const index = rawIndex().filter((s) => s.id !== id);
    localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // ignore
  }
}

// Rename a session and mark it `renamed` so later auto-saves keep the new title.
export function renameChatSession(id: string, title: string): void {
  try {
    const clean = title.trim().slice(0, 80);
    if (!clean) return;
    const index = rawIndex().map((s) => (s.id === id ? { ...s, title: clean, renamed: true } : s));
    localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // ignore
  }
}

// Pin / unpin a session (pinned sessions sort to the top of the history list).
export function pinChatSession(id: string, pinned: boolean): void {
  try {
    const index = rawIndex().map((s) => (s.id === id ? { ...s, pinned } : s));
    localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // ignore
  }
}
