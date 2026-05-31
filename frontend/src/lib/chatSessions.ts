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

export function loadChatIndex(): ChatSessionMeta[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    const list = raw ? (JSON.parse(raw) as ChatSessionMeta[]) : [];
    return Array.isArray(list) ? list.sort((a, b) => b.ts - a.ts) : [];
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

export function saveChatSession(id: string, title: string, blob: ChatSessionBlob, count: number): void {
  try {
    localStorage.setItem(blobKey(id), JSON.stringify(blob));
    const index = loadChatIndex().filter((s) => s.id !== id);
    index.unshift({ id, title: title || "New chat", ts: Date.now(), count });
    const trimmed = index.slice(0, MAX_SESSIONS);
    localStorage.setItem(INDEX_KEY, JSON.stringify(trimmed));
    // Drop blobs that fell out of the index so storage doesn't grow forever.
    for (const stale of index.slice(MAX_SESSIONS)) localStorage.removeItem(blobKey(stale.id));
  } catch {
    // Ignore quota / serialization errors — chat still works in-memory.
  }
}

export function deleteChatSession(id: string): void {
  try {
    localStorage.removeItem(blobKey(id));
    const index = loadChatIndex().filter((s) => s.id !== id);
    localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // ignore
  }
}
