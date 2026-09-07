import { useState, useEffect, useRef, useCallback, useMemo, createContext, useContext, forwardRef, useImperativeHandle, Fragment } from "react";
import { type AgentApi, readFileWindow, underPath } from "../lib/agent";
import { buildMcpRuntime } from "../lib/agents/mcp";
import {
  listModels,
  isToolCapable,
  isVisionCapable,
  llmStream,
  CLOUD_FALLBACK_MODELS,
  fallbackModelFor,
  type LlmImage,
  type LlmMessage,
  type LlmOptions,
  type LlmProvider,
  uid,
} from "../lib/llm";
import { runOrchestrator } from "../lib/agents";
import type { AgentEvent } from "../lib/agents";
import { ALWAYS_APPROVE_TOOLS } from "../lib/agents/runtime";
import type { AgentDebugEntry, AgentKind, RunStatus, StepStatus, ToolCallView } from "../lib/agents/types";
import { loadAiSettings, saveAiSettings, loadAiKeys, saveAiKey, keyFor, samplingOptions, type AiSettings, type McpServerConfig } from "../lib/aiSettings";
import { loadChatSession, saveChatSession, loadChatIndex, deleteChatSession, renameChatSession, pinChatSession, type ChatSessionBlob, type ChatSessionMeta } from "../lib/chatSessions";
import { scanStreamUrl, fetchDupesV2Bounded } from "../api/client";
import { getCached, setCached } from "../lib/scanCache";
import { readNdjsonStream } from "../hooks/useScan";
import type { NodeRecord, ScanResult, ExtensionStat } from "../api/types";
import { Icon, type IconName } from "./Icon";
import { Markdown } from "./Markdown";
import { Select } from "./Select";

// Imperative handle the command palette uses to drive the chat (Chat: Stop /
// Clear / Switch session) from outside the panel.
export interface ChatPanelController {
  stop: () => void;
  clear: () => void;
  openHistory: () => void;
}

interface ChatPanelProps {
  getAgentApi: () => AgentApi | null;
  onClose: () => void;
  width?: number;
  /** Identifies the active conversation; changing it loads/starts a session. */
  sessionId: string;
  /** Start a brand-new conversation (used by the in-panel history view). */
  onNewSession?: () => void;
  /** Open an existing conversation by id (used by the in-panel history view). */
  onRestoreSession?: (id: string) => void;
  /** Scan settings used when pre-scanning attached folders for an isolated scope. */
  includeHidden?: boolean;
  threads?: number;
  /** Populated by the panel so the command palette can drive it (stop/clear/…). */
  controllerRef?: React.MutableRefObject<ChatPanelController | null>;
  /** Bumped by the palette's "Chat: Switch session" to open the history view. */
  openHistoryNonce?: number;
}

// A reference to past context (a message in this chat or a whole past chat),
// injected as plain text into the turn so the orchestrator sees it with no
// schema change.
interface RefItem {
  kind: "message" | "session";
  id: string;
  label: string;
  text: string;
}

// A slash command shown in the composer's "/" menu.
interface SlashCommand {
  id: string;
  label: string;
  hint: string;
  icon: IconName;
  run: () => void;
}

// One selectable row in either composer popup (mention or slash), used for the
// shared Arrow/Enter/Tab keyboard navigation.
type PopupItem =
  | { kind: "ref"; ref: RefItem }
  | { kind: "file"; node: NodeRecord }
  | { kind: "slash"; cmd: SlashCommand };

// Memory tuning: once the running history exceeds SUMMARY_THRESHOLD messages,
// everything older than the most recent RECENT_WINDOW is folded into a rolling
// summary so long chats stay within context without dropping early facts.
// RECENT_WINDOW is the SINGLE source of truth for the recent-message window —
// used both for the summary boundary and the plain recent slice (this replaced
// an earlier slice(-12)-vs-RECENT_WINDOW(8) mismatch that sent inconsistent
// amounts of history depending on whether summarization had kicked in).
const RECENT_WINDOW = 12;
const SUMMARY_THRESHOLD = 16;

// Rough context-token budget per provider, used to size the prior-conversation
// trim below. Ollama uses the configured (small) num_ctx; cloud models have far
// larger windows, so a generous budget means the trim effectively never fires
// for them (their own provider-side limits remain the real ceiling).
function providerCtxTokens(provider: LlmProvider, numCtx: number): number {
  if (provider === "ollama") return numCtx || 8192;
  if (provider === "anthropic") return 200_000;
  return 128_000; // openai
}

// Conservative prior-conversation trim. Estimates context size at ~4 chars/token
// and keeps the prior turns to roughly half the model's num_ctx window, leaving
// the rest for the system prompt, tool schemas, and the response. Drops the
// OLDEST non-system messages first; a leading summary system message is always
// kept. This only ever fires when well over budget — normal chats pass through
// untouched — so it's a safety net against silent context truncation.
function trimPriorConvo(messages: LlmMessage[], numCtx: number): LlmMessage[] {
  const budget = Math.max(4000, Math.floor((numCtx || 8192) * 4 * 0.5));
  const sizeOf = (m: LlmMessage) => (m.content?.length ?? 0) + 16;
  let total = messages.reduce((n, m) => n + sizeOf(m), 0);
  if (total <= budget) return messages;
  const out = [...messages];
  // Preserve a leading "Summary of earlier conversation" system message.
  const start = out[0]?.role === "system" ? 1 : 0;
  while (total > budget && out.length - start > 1) {
    total -= sizeOf(out[start]);
    out.splice(start, 1);
  }
  return out;
}

interface ToolState {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  mutating: boolean;
  requiresApproval: boolean;
  status: StepStatus;
  summary?: string;
  /** Verbose result (run_command stdout/stderr/exit) shown in the action card. */
  output?: string;
}
type OrderItem = { kind: "tool"; callId: string } | { kind: "child"; childId: string };
interface RunState {
  id: string;
  agent: AgentKind;
  parentId?: string;
  task?: string;
  status: RunStatus;
  thinking: string;
  text: string;
  order: OrderItem[];
  tools: Record<string, ToolState>;
  notices: { level: "info" | "warn" | "error"; text: string }[];
  // Reasoning timing: when the first thinking delta arrived and the finalized
  // thinking duration (ms), captured when the answer starts (or the run ends).
  // Drives the "Thought for Ns" label + auto-collapse on the ThinkingBlock.
  thinkStart?: number;
  thinkMs?: number;
}
type AttachKind = "path" | "image" | "video";
interface AttachedView { kind: AttachKind; name: string }
type ChatItem =
  | { type: "user"; id: string; text: string; attached?: (AttachedView | string)[] }
  | { type: "run"; id: string; runId: string }
  | { type: "notice"; id: string; level: "info" | "warn" | "error"; text: string };

interface AttachedItem {
  id: string;
  kind: AttachKind;
  name: string;
  path?: string;
  isDir?: boolean;
  dataUrl?: string;   // image only
  mediaType?: string; // image only
}

interface ModelGroup { provider: LlmProvider; label: string; models: string[] }

const SUGGESTIONS = [
  "What's using the most space?",
  "Find duplicate files I can remove",
  "Find all videos larger than 1 GB",
  "What can I safely delete?",
];

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const VIDEO_EXT = /\.(mp4|mov|avi|mkv|webm|m4v|wmv|flv|mpe?g|m2ts|ts)$/i;

function basename(p: string): string {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
}

// Render a turn's tool calls into a single compact line for conversation memory,
// e.g. `list_dir(C:\…\Downloads)→12 children; find_duplicates→3 groups`. Folded
// into convoRef so later turns recall what tools actually did, not just the prose.
function formatTurnToolTrace(map: Map<string, { name: string; args: Record<string, unknown>; summary?: string; status?: string }>): string {
  const parts: string[] = [];
  for (const t of map.values()) {
    if (!t.status) continue; // never completed (skipped pre-approval, etc.)
    const keyArg =
      (typeof t.args.path === "string" && t.args.path) ||
      (typeof t.args.dir === "string" && t.args.dir) ||
      (typeof t.args.query === "string" && `"${t.args.query}"`) ||
      (typeof t.args.glob === "string" && t.args.glob) ||
      (typeof t.args.destination === "string" && t.args.destination) ||
      (typeof t.args.command === "string" && t.args.command) ||
      (typeof t.args.url === "string" && t.args.url) ||
      "";
    const head = keyArg ? `${t.name}(${String(keyArg).slice(0, 80)})` : t.name;
    const tail = t.status === "rejected" ? "skipped" : (t.summary ? t.summary.slice(0, 80) : t.status);
    parts.push(`${head}→${tail}`);
    if (parts.length >= 12) break;
  }
  return parts.join("; ");
}

interface NativeDropAPI {
  onNativeDropInternal?: (cb: (x: number, y: number, paths: string[]) => void) => () => void;
  getPathForFile?: (file: File) => string;
  readFileBase64?: (filePath: string) => Promise<{ dataUrl?: string; mediaType?: string; error?: string }>;
}
const dropAPI = (): NativeDropAPI => (window as unknown as { electronAPI?: NativeDropAPI }).electronAPI ?? {};

// Merge several attached-folder scans into one synthetic scope: a single root
// node with summed totals plus every node re-IDed so only the root is id 0.
// The agent tools key off `path` (unique) and "id > 0" — never parent/children —
// so flat sequential ids are safe, and each original folder root surfaces as a
// top-level directory item.
function mergeScans(scans: ScanResult[], label: string): { result: ScanResult; nodes: NodeRecord[] } {
  let size = 0, allocated = 0, files = 0, folders = 0;
  const nodes: NodeRecord[] = [];
  const extMap = new Map<string, ExtensionStat>();
  let nextId = 1;
  for (const scan of scans) {
    for (const n of scan.nodes) {
      if (n.id === 0) {
        size += n.size; allocated += n.allocated; files += n.files; folders += n.folders;
      }
      nodes.push({ ...n, id: nextId++ });
    }
    for (const e of scan.extensionStats ?? []) {
      const cur = extMap.get(e.ext) ?? { ext: e.ext, bytes: 0, allocated: 0, files: 0 };
      cur.bytes += e.bytes; cur.allocated += e.allocated; cur.files += e.files;
      extMap.set(e.ext, cur);
    }
  }
  const root: NodeRecord = {
    id: 0, parent: null, name: label, path: label, dir: true, link: false,
    hidden: false, readonly: false, size, allocated, files, folders,
    modified: 0, created: 0, accessed: 0, depth: 0, errors: 0, extension: "", children: [],
  };
  nodes.unshift(root);
  const result: ScanResult = {
    ...scans[0],
    rootPath: label,
    nodeCount: nodes.length,
    nodes,
    topFiles: [],
    duplicateCandidates: [],
    extensionStats: [...extMap.values()].sort((a, b) => b.bytes - a.bytes),
  };
  return { result, nodes };
}

// Wrap a tab's AgentApi so the read surface (scan path/result/nodes + duplicate
// finding) is served from the attached folder scan(s) instead of the focused
// tab. All path-based operations (move/rename/create/reveal/run_command/scan/
// refresh) fall through to the underlying api unchanged via the spread.
function buildScopedApi(base: AgentApi, dirs: string[], scans: ScanResult[]): AgentApi {
  const single = scans.length === 1;
  const label = single ? dirs[0] : dirs.join(", ");
  const { result, nodes } = single ? { result: scans[0], nodes: scans[0].nodes } : mergeScans(scans, label);
  return {
    ...base,
    getScanPath: () => label,
    getScanResult: () => result,
    getNodes: () => nodes,
    findDuplicates: async (minSizeBytes: number, signal?: AbortSignal) => {
      const res = await fetchDupesV2Bounded({ paths: dirs, mode: "exact", minSize: minSizeBytes }, signal);
      return { groups: res.groups.map((g) => ({ waste: g.waste, files: g.files.map((f) => ({ path: f.path, size: f.size })) })) };
    },
    // Scoped reads: only allow reading files inside one of the attached folders
    // (the server is also scan-root gated, but enforce the scope here too so an
    // attached-folder chat can never read outside its declared scope).
    readFile: async (path, opts) => {
      if (!dirs.some((d) => underPath(path, d))) {
        return { ok: false, path, error: "Path is outside the attached folder scope." };
      }
      return readFileWindow(path, opts);
    },
  };
}

// Lets nested message renderers (RunView / SubAgentCard → Markdown) trigger a
// tree/Explorer reveal for a clicked Windows path without threading a callback
// through every intermediate component. Undefined outside a ChatPanel.
const RevealPathContext = createContext<((path: string) => void) | undefined>(undefined);

export function ChatPanel({ getAgentApi, onClose, width = 360, sessionId, onNewSession, onRestoreSession, includeHidden = false, threads, controllerRef, openHistoryNonce }: ChatPanelProps) {
  const [ai, setAi] = useState<AiSettings>(() => loadAiSettings());
  const [groups, setGroups] = useState<ModelGroup[]>([]);
  const [modelStatus, setModelStatus] = useState<"unknown" | "ok" | "offline">("unknown");
  const [showKeys, setShowKeys] = useState(false);

  const [items, setItems] = useState<ChatItem[]>([]);
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [attached, setAttached] = useState<AttachedItem[]>([]);
  const [references, setReferences] = useState<RefItem[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [autoApprove, setAutoApprove] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  // The input value at which the user pressed Escape to dismiss the @-mention
  // popup; the popup re-opens once the input changes again.
  const [mentionDismissed, setMentionDismissed] = useState<string | null>(null);
  // Same idea for the "/" slash-command popup.
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null);
  // Highlighted row in whichever popup (mention or slash) is open, for keyboard
  // navigation (Arrow Up/Down + Enter/Tab to select).
  const [activeIdx, setActiveIdx] = useState(0);
  // True after the user Stops a run, so the last turn can offer a "Continue"
  // affordance (cleared on the next send / clear / edit).
  const [justStopped, setJustStopped] = useState(false);
  // Per-message edit-and-resend: the user message currently being edited inline
  // (null = none) plus its working draft.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  // True while the pre-turn rolling summary is being computed, so the UI can show
  // a "Compressing earlier messages…" status instead of an unexplained pause.
  const [summarizing, setSummarizing] = useState(false);
  // Per-turn debug bundle (last turn): a JSON snapshot of each agent run's steps,
  // tools, guard nudges, and char counts, copied on demand. No external telemetry.
  const [debugReady, setDebugReady] = useState(false);
  const lastDebugRef = useRef<string>("");

  const provider = ai.provider;
  const selectedModel = ai.model;
  const apiKey = keyFor(ai, provider);

  const abortRef = useRef<AbortController | null>(null);
  const approvalRef = useRef<Record<string, (approved: boolean) => void>>({});
  const convoRef = useRef<LlmMessage[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelPickerRef = useRef<ModelPickerHandle>(null);
  const dragDepthRef = useRef(0);
  const loadedSessionRef = useRef("");
  const saveTimerRef = useRef<number | null>(null);
  // Per-turn "approve all" latch (Tier-2 cards) and rolling-memory bookkeeping.
  const runAutoApproveRef = useRef(false);
  const convoSummaryRef = useRef("");
  const summarizedCountRef = useRef(0);
  // Tool-trace memory: per-turn record of tool calls (name + key args + result
  // digest), keyed by callId, folded into convoRef so follow-up turns remember
  // what the tools actually did — not just the final prose answer.
  const turnToolsRef = useRef<Map<string, { name: string; args: Record<string, unknown>; summary?: string; status?: string }>>(new Map());
  // Coalesce text/thinking stream deltas: buffer per-run deltas and flush on a
  // rAF so a long answer doesn't trigger a re-render per token.
  const deltaBufRef = useRef<Map<string, { text: string; thinking: string }>>(new Map());
  const rafRef = useRef<number | null>(null);

  const updateAi = useCallback((patch: { provider?: LlmProvider; model?: string; keys?: Partial<AiSettings["keys"]>; allow?: string[]; rules?: string; mcpServers?: McpServerConfig[] }) => {
    setAi((prev) => {
      const next: AiSettings = {
        ...prev,
        provider: patch.provider ?? prev.provider,
        model: patch.model ?? prev.model,
        keys: { ...prev.keys, ...(patch.keys ?? {}) },
        allow: patch.allow ?? prev.allow,
        rules: patch.rules ?? prev.rules,
        mcpServers: patch.mcpServers ?? prev.mcpServers,
      };
      saveAiSettings(next);
      return next;
    });
  }, []);

  const setRules = useCallback((rules: string) => updateAi({ rules }), [updateAi]);
  const setMcpServers = useCallback((mcpServers: McpServerConfig[]) => updateAi({ mcpServers }), [updateAi]);

  // Cloud API keys are stored in Electron safeStorage (with a localStorage
  // fallback for plain-browser dev). Reflect each edit in state immediately and
  // persist it to the secret store — never to localStorage.
  const setKeys = useCallback((keys: Partial<AiSettings["keys"]>) => {
    updateAi({ keys });
    for (const [provider, value] of Object.entries(keys)) {
      void saveAiKey(provider as keyof AiSettings["keys"], value ?? "");
    }
  }, [updateAi]);

  // Build one grouped model list (Ollama local + cloud) for the composer's
  // single model picker. Ollama is probed live; cloud lists are curated.
  const loadModels = useCallback(() => {
    setModelStatus("unknown");
    const finish = (ollama: string[]) => {
      const g: ModelGroup[] = [
        { provider: "ollama", label: "Ollama · local", models: ollama },
        { provider: "openai", label: "OpenAI", models: CLOUD_FALLBACK_MODELS.openai },
        { provider: "anthropic", label: "Anthropic", models: CLOUD_FALLBACK_MODELS.anthropic },
      ];
      setGroups(g);
      setModelStatus(ollama.length ? "ok" : "offline");
      setAi((prev) => {
        const valid = g.some((grp) => grp.provider === prev.provider && grp.models.includes(prev.model));
        if (prev.model && valid) return prev;
        // First run / stale selection: prefer a local model, else this provider's first.
        let next = prev;
        if (ollama.length) next = { ...prev, provider: "ollama", model: ollama[0] };
        else {
          const cur = g.find((grp) => grp.provider === prev.provider);
          if (cur?.models.length) next = { ...prev, model: cur.models[0] };
        }
        if (next !== prev) saveAiSettings(next);
        return next;
      });
    };
    listModels("ollama").then(finish).catch(() => finish([]));
  }, []);

  useEffect(() => { loadModels(); }, [loadModels]);

  // Cancel any pending stream-delta rAF on unmount.
  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); }, []);

  // Load cloud keys from safeStorage on mount, migrating any legacy localStorage
  // keys into the secret store, then merge the resolved keys into settings state.
  useEffect(() => {
    let cancelled = false;
    void loadAiKeys().then((keys) => { if (!cancelled) setAi((prev) => ({ ...prev, keys })); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [items, runs]);

  // Auto-grow the composer textarea up to a cap.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [input]);

  const pickModel = useCallback((p: LlmProvider, m: string) => updateAi({ provider: p, model: m }), [updateAi]);

  // ── Session load / save ────────────────────────────────────
  const resolveAllApprovals = useCallback((approved: boolean) => {
    const map = approvalRef.current;
    approvalRef.current = {};
    for (const fn of Object.values(map)) fn(approved);
  }, []);

  useEffect(() => {
    abortRef.current?.abort();
    resolveAllApprovals(false);
    abortRef.current = null;
    setBusy(false);

    const blob = loadChatSession(sessionId) as ChatSessionBlob | null;
    setItems((blob?.items as ChatItem[]) ?? []);
    setRuns((blob?.runs as Record<string, RunState>) ?? {});
    convoRef.current = (blob?.convo as LlmMessage[]) ?? [];
    convoSummaryRef.current = (blob?.summary as string) ?? "";
    // The saved summary always covered everything except the recent window, so
    // restore that boundary to avoid re-summarizing the same prefix on reload.
    summarizedCountRef.current = convoSummaryRef.current ? Math.max(0, convoRef.current.length - RECENT_WINDOW) : 0;
    runAutoApproveRef.current = false;
    setAttached([]);
    setReferences([]);
    setShowHistory(false);
    loadedSessionRef.current = sessionId;
  }, [sessionId, resolveAllApprovals]);

  useEffect(() => {
    if (loadedSessionRef.current !== sessionId || items.length === 0) return;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    const id = sessionId;
    const snapshot = { items, runs, convo: convoRef.current, summary: convoSummaryRef.current };
    saveTimerRef.current = window.setTimeout(() => {
      const title = (items.find((m) => m.type === "user") as { text?: string } | undefined)?.text?.slice(0, 48) ?? "New chat";
      saveChatSession(id, title, snapshot as ChatSessionBlob, items.length);
    }, 400);
    return () => { if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current); };
  }, [items, runs, sessionId]);

  // Flush buffered text/thinking deltas into run state in one batched update.
  const flushDeltas = useCallback(() => {
    rafRef.current = null;
    const buf = deltaBufRef.current;
    if (!buf.size) return;
    const pending = new Map(buf);
    buf.clear();
    setRuns((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [runId, d] of pending) {
        const r = next[runId];
        if (!r) continue;
        next[runId] = { ...r, text: r.text + d.text, thinking: r.thinking + d.thinking };
        changed = true;
      }
      return changed ? next : prev;
    });
  }, []);

  const queueDelta = useCallback((runId: string, kind: "text" | "thinking", delta: string) => {
    const buf = deltaBufRef.current;
    const cur = buf.get(runId) ?? { text: "", thinking: "" };
    cur[kind] += delta;
    buf.set(runId, cur);
    if (rafRef.current == null) {
      rafRef.current = window.requestAnimationFrame(flushDeltas);
    }
  }, [flushDeltas]);

  // ── Event reducer ──────────────────────────────────────────
  const applyEvent = useCallback((ev: AgentEvent) => {
    switch (ev.kind) {
      case "agent_start": {
        setRuns((prev) => ({
          ...prev,
          [ev.runId]: { id: ev.runId, agent: ev.agent, parentId: ev.parentId, task: ev.task, status: "running", thinking: "", text: "", order: [], tools: {}, notices: [] },
        }));
        if (ev.parentId) {
          const pid = ev.parentId;
          setRuns((prev) => {
            const par = prev[pid];
            if (!par) return prev;
            return { ...prev, [pid]: { ...par, order: [...par.order, { kind: "child", childId: ev.runId }] } };
          });
        } else {
          setItems((prev) => [...prev, { type: "run", id: ev.runId, runId: ev.runId }]);
        }
        break;
      }
      case "thinking":
        queueDelta(ev.runId, "thinking", ev.delta);
        // Stamp the moment reasoning began (first thinking delta only).
        setRuns((prev) => {
          const r = prev[ev.runId];
          if (!r || r.thinkStart != null) return prev;
          return { ...prev, [ev.runId]: { ...r, thinkStart: Date.now() } };
        });
        break;
      case "text":
        queueDelta(ev.runId, "text", ev.delta);
        // First answer token after some reasoning: freeze the thinking duration
        // so the ThinkingBlock can relabel to "Thought for Ns" and collapse.
        setRuns((prev) => {
          const r = prev[ev.runId];
          if (!r || r.thinkStart == null || r.thinkMs != null || !ev.delta) return prev;
          return { ...prev, [ev.runId]: { ...r, thinkMs: Date.now() - r.thinkStart } };
        });
        break;
      case "text_reset":
        // A final-answer guard rejected the streamed text (e.g. a fabricated
        // file list). Drop it (and any buffered deltas) so only the corrected,
        // tool-backed answer shows.
        deltaBufRef.current.delete(ev.runId);
        setRuns((prev) => { const r = prev[ev.runId]; return r && r.text ? { ...prev, [ev.runId]: { ...r, text: "" } } : prev; });
        break;
      case "tool_start": {
        // Search delegation is represented purely by its child agent card.
        // delegate_to_action keeps a ToolState so the Tier-1 plan card renders.
        if (ev.tool === "delegate_to_search") break;
        // Record into per-turn tool-trace memory (skip the action plan wrapper;
        // its real tools are recorded when the sub-agent runs them).
        if (ev.tool !== "delegate_to_action") {
          turnToolsRef.current.set(ev.callId, { name: ev.tool, args: ev.args });
        }
        setRuns((prev) => {
          const r = prev[ev.runId];
          if (!r) return prev;
          const tool: ToolState = { callId: ev.callId, tool: ev.tool, args: ev.args, mutating: ev.mutating, requiresApproval: ev.requiresApproval, status: ev.requiresApproval ? "pending" : "running" };
          return { ...prev, [ev.runId]: { ...r, order: [...r.order, { kind: "tool", callId: ev.callId }], tools: { ...r.tools, [ev.callId]: tool } } };
        });
        break;
      }
      case "tool_update":
        {
          const trace = turnToolsRef.current.get(ev.callId);
          if (trace && (ev.status === "done" || ev.status === "error" || ev.status === "rejected")) {
            trace.status = ev.status;
            if (ev.summary) trace.summary = ev.summary;
          }
        }
        setRuns((prev) => {
          const r = prev[ev.runId];
          const t = r?.tools[ev.callId];
          if (!r || !t) return prev;
          return { ...prev, [ev.runId]: { ...r, tools: { ...r.tools, [ev.callId]: { ...t, status: ev.status, summary: ev.summary ?? t.summary, output: ev.output ?? t.output } } } };
        });
        break;
      case "agent_end":
        // Flush any buffered stream deltas first so the run's `text` is complete
        // before we finalize it (otherwise the tail token could be lost).
        flushDeltas();
        // The run (orchestrator or a sub-agent) just finished. Keep its final
        // answer + step timeline, but drop the transient process-chatter
        // notices (retry/force/step-limit/empty-response, guard nudges, …) that
        // were only useful as live activity and otherwise pile up forever. Keep
        // level "error" so genuine failures stay visible after the turn ends.
        setRuns((prev) => {
          const r = prev[ev.runId];
          if (!r) return prev;
          // Finalize thinking duration for tool-only / no-stream-text runs that
          // never tripped the first-token stamp above.
          const thinkMs = r.thinkMs ?? (r.thinkStart != null ? Date.now() - r.thinkStart : undefined);
          return { ...prev, [ev.runId]: { ...r, status: ev.status, text: r.text || ev.summary || "", notices: r.notices.filter((n) => n.level === "error"), thinkMs } };
        });
        // If a top-level run ended (one tracked directly in the chat list, i.e.
        // the orchestrator) the whole turn is done — sweep any standalone
        // info/warn notice lines from this turn too, keeping errors. Sub-agent
        // ends leave `items` untouched (the filter returns the same reference).
        setItems((prev) => {
          if (!prev.some((it) => it.type === "run" && it.runId === ev.runId)) return prev;
          const next = prev.filter((it) => it.type !== "notice" || it.level === "error");
          return next.length === prev.length ? prev : next;
        });
        break;
      case "notice":
        if (ev.runId) {
          const rid = ev.runId;
          setRuns((prev) => { const r = prev[rid]; return r ? { ...prev, [rid]: { ...r, notices: [...r.notices, { level: ev.level, text: ev.text }] } } : prev; });
        } else {
          setItems((prev) => [...prev, { type: "notice", id: uid(), level: ev.level, text: ev.text }]);
        }
        break;
    }
  }, [queueDelta, flushDeltas]);

  const requestApproval = useCallback((callId: string, view: ToolCallView) => {
    // Once the user picks "Approve all in this run", later actions in the same
    // turn resolve immediately without surfacing another card — EXCEPT tools in
    // ALWAYS_APPROVE_TOOLS (run_command), which must be confirmed every time.
    if (runAutoApproveRef.current && !ALWAYS_APPROVE_TOOLS.has(view.name)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      approvalRef.current[callId] = (approved: boolean) => {
        delete approvalRef.current[callId];
        resolve(approved);
      };
    });
  }, []);

  const resolveApproval = useCallback((callId: string, approved: boolean) => {
    approvalRef.current[callId]?.(approved);
  }, []);

  // Approve the current action and latch auto-approve for the remainder of this
  // turn. The latch is cleared at the start of each send().
  const approveAll = useCallback((callId: string) => {
    runAutoApproveRef.current = true;
    resolveApproval(callId, true);
  }, [resolveApproval]);

  // Persist a tool to the "always allow" list so future calls to it skip the
  // approval card (machine-local, like the other AI settings).
  const addAllow = useCallback((tool: string) => {
    setAi((prev) => {
      if (prev.allow.includes(tool)) return prev;
      const next = { ...prev, allow: [...prev.allow, tool] };
      saveAiSettings(next);
      return next;
    });
  }, []);

  const removeAllow = useCallback((tool: string) => {
    setAi((prev) => {
      if (!prev.allow.includes(tool)) return prev;
      const next = { ...prev, allow: prev.allow.filter((t) => t !== tool) };
      saveAiSettings(next);
      return next;
    });
  }, []);

  // "Always allow <tool>": persist it, then approve the call that prompted it.
  const allowlist = useCallback((callId: string, tool: string) => {
    addAllow(tool);
    resolveApproval(callId, true);
  }, [addAllow, resolveApproval]);

  // ── Attached context ───────────────────────────────────────
  const pushAttached = useCallback((item: AttachedItem) => {
    setAttached((prev) => {
      if (item.path && prev.some((a) => a.path && a.path.toLowerCase() === item.path!.toLowerCase())) return prev;
      return [...prev, item];
    });
  }, []);

  // Paths coming from the file tree (HTML5 or native drag). Images are read off
  // disk to data URLs so they can be sent to vision models; videos are kept as
  // context references; everything else is a plain path context entry.
  const addPaths = useCallback((paths: string[]) => {
    if (!paths.length) return;
    const api = getAgentApi();
    const nodes = api?.getNodes() ?? [];
    const byPath = new Map(nodes.filter((n) => n.path).map((n) => [n.path.toLowerCase(), n]));
    const readImg = dropAPI().readFileBase64;
    for (const p of paths) {
      if (!p) continue;
      const node = byPath.get(p.toLowerCase());
      const isDir = node?.dir;
      if (!isDir && IMAGE_EXT.test(p) && readImg) {
        readImg(p)
          .then((r) => r?.dataUrl
            ? pushAttached({ id: uid(), kind: "image", name: basename(p), path: p, dataUrl: r.dataUrl, mediaType: r.mediaType })
            : pushAttached({ id: uid(), kind: "path", name: basename(p), path: p }))
          .catch(() => pushAttached({ id: uid(), kind: "path", name: basename(p), path: p }));
      } else if (!isDir && VIDEO_EXT.test(p)) {
        pushAttached({ id: uid(), kind: "video", name: basename(p), path: p });
      } else {
        pushAttached({ id: uid(), kind: "path", name: basename(p), path: p, isDir });
      }
    }
  }, [getAgentApi, pushAttached]);

  // Files coming from the OS (picker / paste / external drop). Images are read
  // in-renderer via FileReader; videos are referenced by name/path.
  const addFiles = useCallback((files: File[]) => {
    const get = dropAPI().getPathForFile;
    for (const f of files) {
      let path = "";
      try { path = get?.(f) || (f as unknown as { path?: string }).path || ""; } catch { /* ignore */ }
      if (f.type.startsWith("image/")) {
        const reader = new FileReader();
        reader.onload = () => pushAttached({ id: uid(), kind: "image", name: f.name, path: path || undefined, dataUrl: String(reader.result), mediaType: f.type || "image/png" });
        reader.readAsDataURL(f);
      } else if (f.type.startsWith("video/")) {
        pushAttached({ id: uid(), kind: "video", name: f.name, path: path || undefined });
      } else if (path) {
        pushAttached({ id: uid(), kind: "path", name: f.name || basename(path), path });
      }
    }
  }, [pushAttached]);

  const buildAttachedContext = useCallback((list: AttachedItem[]): string => {
    if (!list.length) return "";
    const api = getAgentApi();
    const nodes = api?.getNodes() ?? [];
    const byPath = new Map(nodes.filter((n) => n.path).map((n) => [n.path.toLowerCase(), n]));
    return list.map((a) => {
      if (a.kind === "image") return `- IMAGE ${a.name} (attached as visual input)`;
      if (a.kind === "video") return `- VIDEO ${a.path ?? a.name}`;
      const n = a.path ? byPath.get(a.path.toLowerCase()) : undefined;
      const kind = (a.isDir ?? n?.dir) ? "DIR" : "FILE";
      const size = n ? ` (${Math.round((n.size / 1e6) * 10) / 10} MB)` : "";
      return `- ${kind} ${a.path ?? a.name}${size}`;
    }).join("\n");
  }, [getAgentApi]);

  // HTML5 drop (folders + mixed drags carry the filetree MIME types; OS files
  // arrive as dt.files and route through addFiles for image/video handling).
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepthRef.current = 0;
    setDragOver(false);
    const dt = e.dataTransfer;
    const multi = dt.getData("application/x-filetree-paths");
    if (multi) {
      try { addPaths(JSON.parse(multi) as string[]); } catch { /* ignore */ }
    } else if (dt.getData("application/x-filetree-path")) {
      addPaths([dt.getData("application/x-filetree-path")]);
    } else if (dt.files?.length) {
      addFiles(Array.from(dt.files));
    }
  }, [addPaths, addFiles]);

  const onPaste = useCallback((e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/"));
    if (files.length) { e.preventDefault(); addFiles(files); }
  }, [addFiles]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    const t = e.dataTransfer.types;
    if (t.includes("application/x-filetree-path") || t.includes("application/x-filetree-paths") || t.includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);
  const onDragEnter = useCallback((e: React.DragEvent) => {
    const t = e.dataTransfer.types;
    if (t.includes("application/x-filetree-path") || t.includes("application/x-filetree-paths") || t.includes("Files")) {
      dragDepthRef.current += 1;
      setDragOver(true);
    }
  }, []);
  const onDragLeave = useCallback(() => {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragOver(false);
  }, []);

  // Native file-only drag from the tree: paths arrive via IPC with a drop point.
  // Claim the drop only when it lands inside the chat panel's rect.
  useEffect(() => {
    const api = dropAPI();
    if (!api.onNativeDropInternal) return;
    const off = api.onNativeDropInternal((x, y, paths) => {
      const rect = panelRef.current?.getBoundingClientRect();
      if (!rect) return;
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) addPaths(paths);
    });
    return () => { off?.(); };
  }, [addPaths]);

  // ── Send / stop ────────────────────────────────────────────
  const send = useCallback(async (raw: string) => {
    const api = getAgentApi();
    const attachedSnapshot = attached;
    const referencesSnapshot = references;
    let text = raw.trim();
    if (busy || !api) return;
    if (!text && attachedSnapshot.length === 0) return;
    if (!text) text = "Take a look at the attached file(s)/image(s).";
    if (!selectedModel) { applyEvent({ kind: "notice", level: "error", text: "Select a model first." }); return; }
    if (provider !== "ollama" && !apiKey) { setShowKeys(true); applyEvent({ kind: "notice", level: "error", text: `Add your ${provider} API key to continue.` }); return; }

    const images: LlmImage[] = attachedSnapshot
      .filter((a) => a.kind === "image" && a.dataUrl)
      .map((a) => ({ dataUrl: a.dataUrl as string, mediaType: a.mediaType || "image/png" }));

    setInput("");
    setAttached([]);
    setReferences([]);
    setMentionDismissed(null);
    setSlashDismissed(null);
    setJustStopped(false);
    setBusy(true);
    // Fresh turn → require approval again (clears any prior "approve all").
    runAutoApproveRef.current = false;
    turnToolsRef.current = new Map();
    setItems((prev) => [...prev, { type: "user", id: uid(), text: raw.trim() || text, attached: attachedSnapshot.map((a) => ({ kind: a.kind, name: a.name })) }]);

    if (provider === "ollama" && !isToolCapable(provider, selectedModel)) {
      applyEvent({ kind: "notice", level: "warn", text: `${selectedModel} may not support tool-calling. For full agent features try qwen2.5 or llama3.1.` });
    }
    if (images.length && !isVisionCapable(provider, selectedModel)) {
      applyEvent({ kind: "notice", level: "warn", text: `${selectedModel} may not read images. Try a vision model (e.g. gpt-4o, claude-3.5, llava).` });
    }

    const controller = new AbortController();
    abortRef.current = controller;

    // Rolling memory: once the chat grows long, fold everything older than the
    // recent window into a cached summary and send [summary, ...recent] as the
    // prior conversation instead of a raw slice. Only newly aged-out messages
    // are summarized each turn; if summarization fails we fall back to recent.
    const history = convoRef.current;
    let priorConvo: LlmMessage[];
    if (history.length > SUMMARY_THRESHOLD) {
      const boundary = Math.max(0, history.length - RECENT_WINDOW);
      if (boundary > summarizedCountRef.current) {
        const aged = history.slice(summarizedCountRef.current, boundary);
        // Surface progress: summarization is a blocking pre-turn LLM call, so
        // show a status line (and a notice if it fails) instead of a silent pause.
        setSummarizing(true);
        let summary: string | null;
        try {
          summary = await summarizeConversation({
            prevSummary: convoSummaryRef.current,
            messages: aged,
            provider, model: selectedModel, apiKey, signal: controller.signal,
            // Summaries must be faithful, not creative — push temperature lower than
            // the chat default while keeping the same anti-repetition guards.
            options: { ...samplingOptions(ai), temperature: 0.2 },
          });
        } finally {
          setSummarizing(false);
        }
        if (summary === null) {
          applyEvent({ kind: "notice", level: "warn", text: "Couldn't compress earlier messages — continuing with the most recent ones." });
        } else if (summary) {
          convoSummaryRef.current = summary;
          summarizedCountRef.current = boundary;
        }
      }
      priorConvo = convoSummaryRef.current
        ? [{ role: "system", content: "Summary of earlier conversation:\n" + convoSummaryRef.current }, ...history.slice(-RECENT_WINDOW)]
        : history.slice(-RECENT_WINDOW);
    } else {
      priorConvo = history.slice(-RECENT_WINDOW);
    }
    // Conservative safety net: keep the prior-conversation context within a rough
    // char budget derived from the PROVIDER's context window so a long history
    // can't blow the model's window (a contributor to the silent-truncation
    // degeneration). Cloud models have huge windows so this rarely fires for them;
    // for Ollama it tracks the configured num_ctx. A leading summary is preserved.
    priorConvo = trimPriorConvo(priorConvo, providerCtxTokens(provider, ai.numCtx));

    convoRef.current.push({ role: "user", content: text, images: images.length ? images : undefined });

    // @-referenced messages/chats ride along as plain context text (no schema
    // change), prepended to any attached file/image context.
    const refBlock = referencesSnapshot.length
      ? "Referenced context (the user pointed at these earlier messages/chats):\n" +
        referencesSnapshot.map((r) => `--- ${r.label} ---\n${r.text}`).join("\n\n")
      : "";
    const attachedCtx = buildAttachedContext(attachedSnapshot);
    const combinedContext = [refBlock, attachedCtx].filter(Boolean).join("\n\n");

    // Attached folders define an ISOLATED scope: pre-scan each one and build a
    // scoped AgentApi so every tool (listing, sizes, duplicates, scanSummary)
    // runs against the attached folder(s) instead of the focused tab's scan —
    // without disturbing any open tab. File operations still delegate to the
    // underlying tab api unchanged.
    const attachedDirs = attachedSnapshot
      .filter((a) => a.kind === "path" && a.isDir && a.path)
      .map((a) => a.path as string);

    // Per-turn debug log: each agent run (orchestrator + sub-agents) appends one
    // structured entry as it finishes. Serialized into a copyable bundle below.
    const debugLog: AgentDebugEntry[] = [];

    try {
      let effectiveApi = api;
      if (attachedDirs.length) {
        // Pre-scan every attached folder IN PARALLEL (reusing the scan cache) so
        // the orchestrator starts as soon as the slowest scan resolves — never
        // serialized folder-by-folder.
        const scanOne = async (dir: string): Promise<{ dir: string; scan: ScanResult } | null> => {
          try {
            let scan = getCached(dir);
            if (!scan) {
              const res = await fetch(scanStreamUrl({ path: dir, includeHidden, threads }), { signal: controller.signal });
              if (res.ok && res.body) {
                scan = await readNdjsonStream(res.body.getReader(), () => {});
                setCached(dir, scan);
              }
            }
            return scan ? { dir, scan } : null;
          } catch (e) {
            if ((e as Error).name === "AbortError") throw e;
            applyEvent({ kind: "notice", level: "warn", text: `Couldn't read attached folder ${dir}: ${(e as Error).message}` });
            return null;
          }
        };
        const scoped = (await Promise.all(attachedDirs.map(scanOne))).filter((s): s is { dir: string; scan: ScanResult } => !!s);
        if (scoped.length) {
          effectiveApi = buildScopedApi(api, scoped.map((s) => s.dir), scoped.map((s) => s.scan));
        }
      }

      // Discover configured MCP servers' tools (best-effort) and register them
      // into the agent's tool list for this run. Read-only by default; tools that
      // declare side effects are approval-gated like other mutating tools.
      const mcpRuntime = await buildMcpRuntime(ai.mcpServers).catch(() => null);

      const res = await runOrchestrator(
        {
          provider, model: selectedModel, apiKey, api: effectiveApi,
          // Anti-repetition + context-budget decoding controls applied to every
          // turn the orchestrator and its sub-agents make this run.
          options: samplingOptions(ai),
          // Optional alternate model the runtime switches to after a persistent
          // mid-stream error (cloud only; undefined for Ollama / no distinct peer).
          fallbackModel: fallbackModelFor(provider, selectedModel),
          // Per-turn structured debug sink (steps/tools/nudges/char counts).
          debug: debugLog,
          autoApprove, signal: controller.signal,
          emit: applyEvent, requestApproval, newId: uid,
          // Read the allowlist live so an "Always allow" chosen mid-run applies
          // to the rest of this turn without a stale closure.
          allowTool: (t) => loadAiSettings().allow.includes(t),
          // Thread the overall request + a brief digest of prior turns so the
          // orchestrator can pass real context (not a bare task) to sub-agents.
          userTask: text,
          priorDigest: convoSummaryRef.current || undefined,
          // MCP tools discovered this run (empty when none configured).
          mcpReadTools: mcpRuntime?.readTools ?? [],
          mcpWriteTools: mcpRuntime?.writeTools ?? [],
          runMcpTool: mcpRuntime?.runTool,
          gatedTools: mcpRuntime?.approvalNames.length ? new Set(mcpRuntime.approvalNames) : undefined,
        },
        { userText: text, attachedContext: combinedContext, priorConvo, images: images.length ? images : undefined },
      );
      // Tool-trace memory: fold a compact record of what the tools did this turn
      // into the assistant message kept in convoRef, so follow-up turns recall
      // the real actions/results, not just the prose. (convoRef is never rendered;
      // it only feeds prior-conversation context back to the model.)
      const trace = formatTurnToolTrace(turnToolsRef.current);
      const assistantContent = (res.text || "") + (trace ? `\n\n[tools this turn: ${trace}]` : "");
      convoRef.current.push({ role: "assistant", content: assistantContent });
    } catch (err) {
      if ((err as Error).name !== "AbortError") applyEvent({ kind: "notice", level: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
      setSummarizing(false);
      abortRef.current = null;
      resolveAllApprovals(false);
      // Snapshot a copyable debug bundle for this turn (built even on error/abort,
      // since the per-agent entries are recorded as each run ends).
      if (debugLog.length) {
        lastDebugRef.current = JSON.stringify({
          at: new Date().toISOString(),
          provider, model: selectedModel,
          fallbackModel: fallbackModelFor(provider, selectedModel) ?? null,
          task: text,
          orchestratorRunId: debugLog.find((d) => d.agent === "orchestrator")?.runId,
          agents: debugLog,
        }, null, 2);
        setDebugReady(true);
      }
    }
  }, [busy, getAgentApi, selectedModel, provider, apiKey, attached, references, autoApprove, applyEvent, requestApproval, resolveAllApprovals, buildAttachedContext, includeHidden, threads, ai]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    resolveAllApprovals(false);
    setBusy(false);
    // Mark the turn as user-stopped so the last run can offer "Continue".
    setJustStopped(true);
  }, [resolveAllApprovals]);

  const clear = useCallback(() => {
    if (busy) return;
    convoRef.current = [];
    convoSummaryRef.current = "";
    summarizedCountRef.current = 0;
    runAutoApproveRef.current = false;
    setItems([]);
    setRuns({});
    setAttached([]);
    setReferences([]);
    setEditingId(null);
    setJustStopped(false);
  }, [busy]);

  // Expose stop / clear / openHistory to the command palette (App) via the
  // shared controller ref while this panel is mounted.
  useEffect(() => {
    if (!controllerRef) return;
    controllerRef.current = { stop, clear, openHistory: () => setShowHistory(true) };
    return () => { controllerRef.current = null; };
  }, [controllerRef, stop, clear]);

  // Palette "Chat: Switch session" bumps this nonce to open the history view.
  useEffect(() => {
    if (openHistoryNonce) setShowHistory(true);
  }, [openHistoryNonce]);

  // Reveal a Windows path (clicked in assistant markdown) in Explorer via the
  // tab's AgentApi facade. Best-effort: ignored if no tab/api is available.
  const revealPath = useCallback((path: string) => {
    try { void getAgentApi()?.reveal(path); } catch { /* no active scan */ }
  }, [getAgentApi]);

  const copyText = useCallback((text: string) => {
    if (text) void navigator.clipboard?.writeText(text).catch(() => {});
  }, []);

  const copyDebug = useCallback(() => {
    if (lastDebugRef.current) void navigator.clipboard?.writeText(lastDebugRef.current).catch(() => {});
  }, []);

  // Truncate the conversation at the user message rendered as `items[itemIndex]`
  // (dropping it and everything after, in BOTH the UI list and the model-history
  // convoRef), then resubmit `newText`. Backs both "regenerate last turn" (same
  // text) and "edit a prior user message and resend" (changed text). `send`
  // re-adds the user bubble + history entry and runs a fresh turn.
  const resendFrom = useCallback((itemIndex: number, newText: string) => {
    if (busy) return;
    const text = newText.trim();
    if (!text) return;
    // Which user-turn (0-based) this item is, so we can find the matching message
    // in convoRef (a flat [user, assistant, …] list).
    const userOrdinal = items.slice(0, itemIndex + 1).filter((it) => it.type === "user").length - 1;
    if (userOrdinal < 0) return;
    const convo = convoRef.current;
    let cut = convo.length;
    let seen = 0;
    for (let i = 0; i < convo.length; i++) {
      if (convo[i].role !== "user") continue;
      if (seen === userOrdinal) { cut = i; break; }
      seen++;
    }
    convoRef.current = convo.slice(0, cut);
    // The rolling-summary boundary may now point past the trimmed history; reset
    // it so the next turn re-derives the summary from a consistent prefix.
    if (summarizedCountRef.current > convoRef.current.length) {
      summarizedCountRef.current = 0;
      convoSummaryRef.current = "";
    }
    // Drop run state for the runs in/after the truncated tail (and their children).
    const removed = new Set(
      items.slice(itemIndex).filter((it) => it.type === "run").map((it) => (it as { runId: string }).runId),
    );
    if (removed.size) {
      setRuns((prev) => {
        const next: Record<string, RunState> = {};
        for (const [id, r] of Object.entries(prev)) {
          if (removed.has(id) || (r.parentId && removed.has(r.parentId))) continue;
          next[id] = r;
        }
        return next;
      });
    }
    setItems((prev) => prev.slice(0, itemIndex));
    setEditingId(null);
    void send(text);
  }, [busy, items, send]);

  // Regenerate the last turn: re-run the orchestrator on the most recent user
  // message (after rewinding its user+assistant pair from history).
  const regenerate = useCallback(() => {
    if (busy) return;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].type === "user") { resendFrom(i, (items[i] as { text: string }).text); return; }
    }
  }, [busy, items, resendFrom]);

  const startEdit = useCallback((id: string, text: string) => { setEditingId(id); setEditDraft(text); }, []);
  const submitEdit = useCallback((id: string) => {
    const idx = items.findIndex((it) => it.id === id);
    if (idx >= 0) resendFrom(idx, editDraft);
  }, [items, editDraft, resendFrom]);

  const banner = useMemo(() => {
    if (provider === "ollama" && modelStatus === "offline") return { text: "Ollama isn't running. Start it and pull a tool-capable model.", action: "retry" as const };
    if (provider !== "ollama" && !apiKey) return { text: `Add your ${provider} API key to use cloud models.`, action: "keys" as const };
    if (!selectedModel) return { text: "No model available for this provider.", action: "retry" as const };
    return null;
  }, [provider, modelStatus, apiKey, selectedModel]);

  // ── @-mention popup (messages / chats / files & folders) ────
  const mentionQuery = useMemo(() => {
    const m = input.match(/(?:^|\s)@([\w.-]*)$/);
    return m ? m[1].toLowerCase() : null;
  }, [input]);

  const mentions = useMemo(() => {
    if (mentionQuery === null) return { thisChat: [] as RefItem[], past: [] as RefItem[] };
    const thisChat: RefItem[] = [];
    for (const it of items) {
      if (it.type === "user" && it.text.trim()) {
        thisChat.push({ kind: "message", id: it.id, label: "You: " + it.text.trim().slice(0, 60), text: it.text.trim() });
      } else if (it.type === "run") {
        const t = runs[it.runId]?.text?.trim();
        if (t) thisChat.push({ kind: "message", id: it.id, label: "Assistant: " + t.slice(0, 60), text: t });
      }
    }
    const past: RefItem[] = loadChatIndex()
      .filter((s) => s.id !== sessionId)
      .map((s) => ({ kind: "session" as const, id: s.id, label: s.title, text: "" }));
    const match = (r: RefItem) => !mentionQuery || r.label.toLowerCase().includes(mentionQuery);
    return { thisChat: thisChat.filter(match).reverse().slice(0, 6), past: past.filter(match).slice(0, 6) };
  }, [mentionQuery, items, runs, sessionId]);

  // Files & folders from the active tab's scan tree, fuzzy-matched on name/path
  // (Cursor's @file feel). Only computed once at least one char follows the @,
  // so the popup keeps showing messages/chats on a bare "@".
  const fileMentions = useMemo<NodeRecord[]>(() => {
    if (mentionQuery === null || mentionQuery.length < 1) return [];
    const nodes = getAgentApi()?.getNodes() ?? [];
    const q = mentionQuery;
    const scored: { n: NodeRecord; rank: number }[] = [];
    for (const n of nodes) {
      if (!n.path || n.id === 0) continue;
      const name = n.name.toLowerCase();
      let s = -1;
      if (name === q) s = 0;
      else if (name.startsWith(q)) s = 1;
      else if (name.includes(q)) s = 2;
      else if (n.path.toLowerCase().includes(q)) s = 3;
      if (s < 0) continue;
      // Slight preference for directories (the @file/@folder scope feel).
      scored.push({ n, rank: s * 10 + (n.dir ? 0 : 1) });
      if (scored.length > 400) break; // bound work on very large scans
    }
    scored.sort((a, b) => a.rank - b.rank || a.n.name.length - b.n.name.length);
    return scored.slice(0, 8).map((x) => x.n);
  }, [mentionQuery, getAgentApi]);

  const mentionItems = useMemo<PopupItem[]>(() => {
    if (mentionQuery === null) return [];
    return [
      ...mentions.thisChat.map((ref): PopupItem => ({ kind: "ref", ref })),
      ...fileMentions.map((node): PopupItem => ({ kind: "file", node })),
      ...mentions.past.map((ref): PopupItem => ({ kind: "ref", ref })),
    ];
  }, [mentionQuery, mentions, fileMentions]);

  const showMentions = mentionQuery !== null && mentionDismissed !== input && mentionItems.length > 0;

  const selectMention = useCallback((ref: RefItem) => {
    setInput((prev) => prev.replace(/@[\w.-]*$/, ""));
    // Session references lazily pull a short transcript; message refs already
    // carry their text.
    const resolved: RefItem = ref.kind === "session" ? { ...ref, text: sessionTranscript(ref.id) } : ref;
    setReferences((prev) => (prev.some((r) => r.id === resolved.id && r.kind === resolved.kind) ? prev : [...prev, resolved]));
    setMentionDismissed(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  // Selecting a file/folder node adds it as a context chip; addPaths also feeds
  // directories into the folder-scope set (chips with isDir) so an @folder
  // scopes the turn like a dragged-in folder.
  const selectFileNode = useCallback((node: NodeRecord) => {
    setInput((prev) => prev.replace(/@[\w.-]*$/, ""));
    addPaths([node.path]);
    setMentionDismissed(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [addPaths]);

  // ── Slash-command popup (Cursor/Claude-style "/" menu) ──────
  const slashQuery = useMemo(() => {
    const m = input.match(/^\/([a-z-]*)$/i);
    return m ? m[1].toLowerCase() : null;
  }, [input]);

  // A short, persistent help notice listing the commands + key shortcuts.
  const showHelp = useCallback(() => {
    applyEvent({
      kind: "notice", level: "info",
      text: "Commands: /new /clear /model /scan /stop /approve-all · @ to add a message, chat, file or folder · Shortcuts: Enter send, Shift+Enter newline, Ctrl+Enter send, Esc stop, ↑ on an empty box edits your last message.",
    });
  }, [applyEvent]);

  const slashItems = useMemo<PopupItem[]>(() => {
    if (slashQuery === null) return [];
    const cmds: SlashCommand[] = [
      { id: "new", label: "/new", hint: "Start a new chat", icon: "plus", run: () => onNewSession?.() },
      { id: "clear", label: "/clear", hint: "Clear this conversation", icon: "trash", run: () => clear() },
      { id: "model", label: "/model", hint: "Choose the model", icon: "robot", run: () => modelPickerRef.current?.open() },
      { id: "scan", label: "/scan", hint: "Rescan the current folder", icon: "hdd", run: () => {
        const api = getAgentApi();
        if (api) { void api.refresh(); applyEvent({ kind: "notice", level: "info", text: "Rescanning the current folder…" }); }
        else applyEvent({ kind: "notice", level: "warn", text: "No folder is scanned in the active tab." });
      } },
      { id: "stop", label: "/stop", hint: "Stop the current run", icon: "stop-fill", run: () => stop() },
      { id: "help", label: "/help", hint: "Show commands & shortcuts", icon: "info-circle", run: showHelp },
      { id: "approve-all", label: "/approve-all", hint: "Auto-approve file actions", icon: "check", run: () => setAutoApprove(true) },
    ];
    const q = slashQuery;
    return cmds.filter((c) => !q || c.id.includes(q)).map((cmd): PopupItem => ({ kind: "slash", cmd }));
  }, [slashQuery, onNewSession, clear, getAgentApi, stop, applyEvent, showHelp]);

  const showSlash = slashQuery !== null && slashDismissed !== input && slashItems.length > 0;

  const runSlashItem = useCallback((cmd: SlashCommand) => {
    setInput("");
    setSlashDismissed(null);
    cmd.run();
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  // The currently-open popup's flat item list (slash takes precedence — the two
  // are mutually exclusive in practice) and a unified selector for keyboard nav.
  const popupOpen = showSlash || showMentions;
  const popupItems = showSlash ? slashItems : showMentions ? mentionItems : [];
  const selectPopupItem = useCallback((item: PopupItem | undefined) => {
    if (!item) return;
    if (item.kind === "slash") runSlashItem(item.cmd);
    else if (item.kind === "file") selectFileNode(item.node);
    else selectMention(item.ref);
  }, [runSlashItem, selectFileNode, selectMention]);

  // Reset the highlighted row whenever the active query changes.
  useEffect(() => { setActiveIdx(0); }, [mentionQuery, slashQuery]);
  // Keep the highlight in range as the filtered list shrinks/grows.
  useEffect(() => {
    setActiveIdx((i) => (popupItems.length === 0 ? 0 : Math.min(i, popupItems.length - 1)));
  }, [popupItems.length]);

  const canSend = (!!input.trim() || attached.length > 0 || references.length > 0) && !!selectedModel;

  // Continue after a user Stop: resume the last intent as a fresh turn (the
  // partial answer is already in convoRef as context). Distinct from regenerate.
  const continueAfterStop = useCallback(() => {
    if (busy) return;
    setJustStopped(false);
    void send("Please continue from where you left off.");
  }, [busy, send]);

  // Context/token meter: a rough ~4-chars/token estimate of the prior
  // conversation (convoRef) plus the live draft, against the active model's
  // window. Recomputed as the conversation/draft grows (items/runs/input deps).
  const ctxWindow = providerCtxTokens(provider, ai.numCtx);
  const ctxUsed = useMemo(() => {
    let chars = input.length;
    for (const m of convoRef.current) chars += (m.content?.length ?? 0) + 16;
    if (convoSummaryRef.current) chars += convoSummaryRef.current.length;
    return Math.round(chars / 4);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, items, runs]);
  const ctxPct = Math.min(100, Math.round((ctxUsed / Math.max(1, ctxWindow)) * 100));

  return (
    <div
      ref={panelRef}
      className={`chatpanel${dragOver ? " drag-over" : ""}`}
      style={{ width, flex: `0 0 ${width}px` }}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
    >
      <div className="chat-header">
        <span className="title">AI Assistant</span>
        <span className="spacer" />
        {debugReady && (
          <button className="icon" title="Copy debug bundle for the last turn (steps, tools, char counts)" onClick={copyDebug}><Icon name="list-task" size={14} /></button>
        )}
        <button className={`icon${showHistory ? " on" : ""}`} title="Chat history" onClick={() => setShowHistory((v) => !v)}><Icon name="clock-history" size={14} /></button>
        <button className="icon" title="Clear chat" onClick={clear} disabled={busy}><Icon name="trash" size={14} /></button>
        <button className="icon" title="Hide assistant" onClick={onClose}><Icon name="chevron-double-right" size={14} /></button>
      </div>

      {showHistory && (
        <HistoryView
          sessionId={sessionId}
          onOpen={(id) => { setShowHistory(false); onRestoreSession?.(id); }}
          onNew={() => { setShowHistory(false); onNewSession?.(); }}
          onClose={() => setShowHistory(false)}
        />
      )}

      {banner && (
        <div className="chat-banner">
          <Icon name="warning" size={13} />
          <span>{banner.text}</span>
          {banner.action === "retry"
            ? <button onClick={loadModels}>Retry</button>
            : <button onClick={() => setShowKeys(true)}>Add key</button>}
        </div>
      )}

      <RevealPathContext.Provider value={revealPath}>
      <div className="chat-messages">
        {items.length === 0 && (
          <div className="chat-welcome">
            <div className="big"><Icon name="robot" size={40} /></div>
            <p>I coordinate a <strong>Search</strong> agent and an <strong>Action</strong> agent to analyze this folder and clean it up — with your approval for any changes. Drag files or folders here to add context.</p>
            <div className="chat-suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chat-suggestion" onClick={() => send(s)} disabled={busy || !selectedModel}>{s}</button>
              ))}
            </div>
          </div>
        )}
        {items.map((m, mi) => {
          if (m.type === "user") {
            if (editingId === m.id) {
              return (
                <div key={m.id} className="chat-msg user editing">
                  <div className="chat-msg-role">You</div>
                  <textarea
                    className="chat-edit-input"
                    value={editDraft}
                    autoFocus
                    rows={Math.min(8, Math.max(1, editDraft.split("\n").length))}
                    onChange={(e) => setEditDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") { e.preventDefault(); setEditingId(null); }
                      else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitEdit(m.id); }
                    }}
                  />
                  <div className="chat-edit-actions">
                    <button className="agent-btn-approve" onClick={() => submitEdit(m.id)} disabled={busy || !editDraft.trim()}>Send</button>
                    <button className="agent-btn-ghost" onClick={() => setEditingId(null)}>Cancel</button>
                  </div>
                </div>
              );
            }
            return (
              <div key={m.id} className="chat-msg user">
                <div className="chat-msg-role">You</div>
                <div className="chat-msg-text">{m.text}</div>
                {m.attached && m.attached.length > 0 && (
                  <div className="chat-attached-row">
                    {m.attached.map((a, i) => {
                      const v: AttachedView = typeof a === "string" ? { kind: "path", name: basename(a) } : a;
                      const icon = v.kind === "image" ? "image" : v.kind === "video" ? "film" : "explorer";
                      return <span key={i} className="chat-chip ro" title={v.name}><Icon name={icon} size={11} />{v.name}</span>;
                    })}
                  </div>
                )}
                <div className="chat-msg-actions">
                  <button className="chat-msg-action" title="Copy" onClick={() => copyText(m.text)}><Icon name="duplicates" size={12} /></button>
                  <button className="chat-msg-action" title="Edit & resend" onClick={() => startEdit(m.id, m.text)} disabled={busy}><Icon name="pencil-square" size={12} /></button>
                </div>
              </div>
            );
          }
          if (m.type === "notice") return <NoticeLine key={m.id} level={m.level} text={m.text} />;
          return (
            <RunView
              key={m.id}
              runId={m.runId}
              runs={runs}
              isLast={mi === items.length - 1}
              busy={busy}
              canContinue={justStopped}
              onRegenerate={regenerate}
              onContinue={continueAfterStop}
              onFollowup={(t) => send(t)}
              onCopy={copyText}
              onApprove={(c) => resolveApproval(c, true)}
              onReject={(c) => resolveApproval(c, false)}
              onApproveAll={approveAll}
              onAllowlist={allowlist}
            />
          );
        })}
        {summarizing && <LiveStatus label="Compressing earlier messages" />}
        <div ref={bottomRef} />
      </div>
      </RevealPathContext.Provider>

      <div className="composer-wrap">
        {showKeys && (
          <SettingsMenu
            ai={ai}
            autoApprove={autoApprove}
            onChange={setKeys}
            onToggleAuto={setAutoApprove}
            onRemoveAllow={removeAllow}
            onChangeRules={setRules}
            onChangeMcp={setMcpServers}
            onClose={() => setShowKeys(false)}
          />
        )}
        {autoApprove && (
          <div className="composer-autobar">
            <Icon name="warning" size={12} />
            <span>Auto-approve is on — file actions run without confirmation</span>
            <button onClick={() => setAutoApprove(false)} title="Require approval again">Turn off</button>
          </div>
        )}
        {showSlash && (
          <div className="mention-popup slash-popup" role="listbox">
            <div className="mention-group-label">Commands</div>
            {slashItems.map((item, i) => item.kind === "slash" && (
              <button
                key={item.cmd.id}
                type="button"
                role="option"
                aria-selected={activeIdx === i}
                className={`mention-item slash-item${activeIdx === i ? " active" : ""}`}
                onMouseDown={(e) => { e.preventDefault(); runSlashItem(item.cmd); }}
                onMouseEnter={() => setActiveIdx(i)}
              >
                <Icon name={item.cmd.icon} size={12} />
                <span className="mention-item-label">{item.cmd.label}</span>
                <span className="slash-item-hint">{item.cmd.hint}</span>
              </button>
            ))}
          </div>
        )}
        {showMentions && (
          <div className="mention-popup" role="listbox">
            {mentionItems.map((item, i) => {
              const showLabel = i === 0 || popupGroupLabel(mentionItems[i - 1]) !== popupGroupLabel(item);
              return (
                <Fragment key={popupItemKey(item)}>
                  {showLabel && <div className="mention-group-label">{popupGroupLabel(item)}</div>}
                  <button
                    type="button"
                    role="option"
                    aria-selected={activeIdx === i}
                    className={`mention-item${activeIdx === i ? " active" : ""}`}
                    onMouseDown={(e) => { e.preventDefault(); selectPopupItem(item); }}
                    onMouseEnter={() => setActiveIdx(i)}
                  >
                    {item.kind === "file" ? (
                      <>
                        <Icon name={item.node.dir ? "folder" : "file-text"} size={12} />
                        <span className="mention-item-label">{item.node.name}</span>
                        <span className="mention-item-path">{item.node.path}</span>
                      </>
                    ) : item.kind === "ref" ? (
                      <>
                        <Icon name={item.ref.kind === "session" ? "clock-history" : "chat"} size={12} />
                        <span className="mention-item-label">{item.ref.label}</span>
                      </>
                    ) : null}
                  </button>
                </Fragment>
              );
            })}
          </div>
        )}
        <div className="composer">
          {(attached.length > 0 || references.length > 0) && (
            <div className="composer-context">
              {references.map((r) => (
                <span key={r.kind + r.id} className="composer-chip ref" title={r.text || r.label}>
                  <Icon name={r.kind === "session" ? "clock-history" : "chat"} size={12} />
                  <span className="composer-chip-name">@{r.label}</span>
                  <button className="composer-chip-x" onClick={() => setReferences((prev) => prev.filter((x) => !(x.id === r.id && x.kind === r.kind)))} title="Remove"><Icon name="x" size={9} /></button>
                </span>
              ))}
              {attached.map((a) => (
                <span key={a.id} className={`composer-chip ${a.kind}`} title={a.path ?? a.name}>
                  {a.kind === "image" && a.dataUrl
                    ? <img className="composer-thumb" src={a.dataUrl} alt={a.name} />
                    : <Icon name={a.kind === "video" ? "film" : a.isDir ? "folder" : "explorer"} size={12} />}
                  <span className="composer-chip-name">{a.name}</span>
                  <button className="composer-chip-x" onClick={() => setAttached((prev) => prev.filter((x) => x.id !== a.id))} title="Remove"><Icon name="x" size={9} /></button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            className="composer-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // Popup navigation (slash or mention) takes priority.
              if (popupOpen) {
                if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, popupItems.length - 1)); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); return; }
                if (e.key === "Escape") { e.preventDefault(); if (showSlash) setSlashDismissed(input); else setMentionDismissed(input); return; }
                if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); selectPopupItem(popupItems[activeIdx]); return; }
              }
              // Esc stops an in-flight run when no popup is open.
              if (e.key === "Escape" && busy) { e.preventDefault(); stop(); return; }
              // Up-arrow on an empty composer edits the last user message.
              if (e.key === "ArrowUp" && !input && !busy) {
                for (let k = items.length - 1; k >= 0; k--) {
                  if (items[k].type === "user") { e.preventDefault(); startEdit(items[k].id, (items[k] as { text: string }).text); return; }
                }
              }
              // Ctrl/Cmd+Enter always sends; plain Enter sends unless Shift (newline).
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(input); return; }
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); return; }
            }}
            onPaste={onPaste}
            placeholder="Ask, instruct, or drop files for context…  (Enter to send · / for commands · @ for context)"
            rows={1}
          />
          <div className="composer-toolbar">
            <ModelPicker ref={modelPickerRef} groups={groups} provider={provider} model={selectedModel} disabled={busy} onPick={pickModel} />
            <button
              className={`composer-tool${(showKeys || autoApprove) ? " on" : ""}`}
              title="Model settings — API keys & auto-approve"
              onClick={() => setShowKeys((v) => !v)}
            >
              <Icon name="three-dots" size={15} />
            </button>
            <span className="composer-spacer" />
            {items.length > 0 && <ContextMeter pct={ctxPct} used={ctxUsed} window={ctxWindow} />}
            <button className="composer-tool" title="Attach images or videos" onClick={() => fileInputRef.current?.click()} disabled={busy}>
              <Icon name="paperclip" size={15} />
            </button>
            {busy ? (
              <button className="composer-send stop" onClick={stop} title="Stop"><Icon name="stop-fill" size={14} /></button>
            ) : (
              <button className="composer-send" onClick={() => send(input)} disabled={!canSend} title="Send (Enter)"><Icon name="arrow-up" size={16} /></button>
            )}
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*"
          multiple
          style={{ display: "none" }}
          onChange={(e) => { const fs = e.target.files; if (fs) addFiles(Array.from(fs)); e.target.value = ""; }}
        />
      </div>
    </div>
  );
}

// Group header for a mention popup row (drives the section labels).
function popupGroupLabel(item: PopupItem): string {
  if (item.kind === "file") return "Files & folders";
  if (item.kind === "ref") return item.ref.kind === "session" ? "Past chats" : "This chat";
  return "Commands";
}
// Stable React key for a mention popup row.
function popupItemKey(item: PopupItem): string {
  if (item.kind === "file") return "f:" + item.node.path;
  if (item.kind === "ref") return "r:" + item.ref.kind + ":" + item.ref.id;
  return "s:" + item.cmd.id;
}

// Compact context-window usage meter near the composer: a thin bar + percent,
// with the rough token estimate in the tooltip. Turns amber as it fills up.
function ContextMeter({ pct, used, window: windowTokens }: { pct: number; used: number; window: number }) {
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
  const level = pct >= 90 ? " danger" : pct >= 75 ? " warn" : "";
  return (
    <div className={`ctx-meter${level}`} title={`Context: ~${fmt(used)} / ${fmt(windowTokens)} tokens (${pct}%)`}>
      <span className="ctx-meter-bar"><span className="ctx-meter-fill" style={{ width: `${Math.max(2, pct)}%` }} /></span>
      <span className="ctx-meter-pct">{pct}%</span>
    </div>
  );
}

// ── Run timeline ─────────────────────────────────────────────
function RunView({ runId, runs, isLast, busy, canContinue, onRegenerate, onContinue, onFollowup, onCopy, onApprove, onReject, onApproveAll, onAllowlist }: { runId: string; runs: Record<string, RunState>; isLast?: boolean; busy?: boolean; canContinue?: boolean; onRegenerate?: () => void; onContinue?: () => void; onFollowup?: (text: string) => void; onCopy?: (text: string) => void; onApprove: (c: string) => void; onReject: (c: string) => void; onApproveAll: (c: string) => void; onAllowlist: (c: string, tool: string) => void }) {
  const run = runs[runId];
  const onRevealPath = useContext(RevealPathContext);
  if (!run) return null;
  const isOrch = run.agent === "orchestrator";
  const streaming = run.status === "running";

  const body = (
    <>
      {isOrch && <PlanChecklist run={run} runs={runs} />}
      {run.thinking.trim() && <ThinkingBlock text={run.thinking} open={streaming && !run.text} live={streaming && !run.text} durationMs={run.thinkMs} />}
      <StepList run={run} runs={runs} onApprove={onApprove} onReject={onReject} onApproveAll={onApproveAll} onAllowlist={onAllowlist} />
      {run.text.trim() && (
        <div className="chat-msg-text">
          <Markdown text={run.text} onPathClick={onRevealPath} />
          {streaming && <span className="chat-cursor">{"\u258B"}</span>}
        </div>
      )}
      {run.notices.map((n, i) => <NoticeLine key={i} level={n.level} text={n.text} />)}
      {streaming && <LiveStatus label={currentActivity(run, runs)} showElapsed />}
    </>
  );

  if (isOrch) {
    // Post-turn follow-up chips: only on the last finished turn with an answer.
    const showFollowups = !streaming && isLast && !canContinue && run.text.trim() && onFollowup;
    const followups = showFollowups ? buildFollowups(run, runs) : [];
    return (
      <div className="chat-msg assistant orchestrator">
        <div className="chat-msg-role"><Icon name="robot" size={12} /> Assistant</div>
        <div className="chat-msg-body">{body}</div>
        {!streaming && (run.text.trim() || isLast) && (
          <div className="chat-msg-actions">
            {run.text.trim() && onCopy && (
              <button className="chat-msg-action" title="Copy response" onClick={() => onCopy(run.text)}><Icon name="duplicates" size={12} /></button>
            )}
            {isLast && onRegenerate && (
              <button className="chat-msg-action" title="Regenerate response" onClick={onRegenerate} disabled={busy}><Icon name="arrow-repeat" size={12} /></button>
            )}
            {isLast && canContinue && onContinue && (
              <button className="chat-msg-action continue" title="Continue from where it stopped" onClick={onContinue} disabled={busy}><Icon name="arrow-repeat" size={12} /> Continue</button>
            )}
          </div>
        )}
        {followups.length > 0 && onFollowup && (
          <div className="chat-followups">
            {followups.map((s) => (
              <button key={s} type="button" className="chat-followup" onClick={() => onFollowup(s)} disabled={busy}>{s}</button>
            ))}
          </div>
        )}
      </div>
    );
  }
  return body; // sub-agents render their own card via SubAgentCard
}

// Contextual next-action chips after a finished turn: a couple of generic
// follow-ups plus an op-specific one inferred from the tools the turn ran
// (search → "what's biggest", duplicates → "what can I delete", …). Reuses the
// empty-state SUGGESTIONS chip styling.
function buildFollowups(run: RunState, runs: Record<string, RunState>): string[] {
  const tools = new Set<string>();
  const collect = (r: RunState) => {
    for (const o of r.order) {
      if (o.kind === "tool") { const t = r.tools[o.callId]; if (t) tools.add(t.tool); }
      else { const c = runs[o.childId]; if (c) collect(c); }
    }
  };
  collect(run);
  const out: string[] = [];
  if (tools.has("find_duplicates")) out.push("Which of these can I safely delete?");
  if (tools.has("list_largest") || tools.has("get_stats") || tools.has("scan_folder") || tools.has("list_by_extension")) out.push("What's taking up the most space?");
  if (tools.has("read_file") || tools.has("grep")) out.push("Summarize what you found");
  out.push("Show more detail");
  if (out.length < 2) out.push("What can I safely delete?");
  return [...new Set(out)].slice(0, 3);
}

// Renders a run's ordered timeline: child sub-agents, the Tier-1 plan card for
// delegate_to_action, and per-tool steps (Tier-2 action cards / search steps).
function StepList({ run, runs, onApprove, onReject, onApproveAll, onAllowlist }: { run: RunState; runs: Record<string, RunState>; onApprove: (c: string) => void; onReject: (c: string) => void; onApproveAll: (c: string) => void; onAllowlist: (c: string, tool: string) => void }) {
  return (
    <>
      {run.order.map((o) => {
        if (o.kind === "child") return <SubAgentCard key={o.childId} runId={o.childId} runs={runs} onApprove={onApprove} onReject={onReject} onApproveAll={onApproveAll} onAllowlist={onAllowlist} />;
        const tool = run.tools[o.callId];
        if (tool?.tool === "delegate_to_action") return <PlanCard key={o.callId} tool={tool} onApprove={onApprove} onReject={onReject} onApproveAll={onApproveAll} onAllowlist={onAllowlist} />;
        return <ToolStep key={o.callId} tool={tool} onApprove={onApprove} onReject={onReject} onApproveAll={onApproveAll} onAllowlist={onAllowlist} />;
      })}
    </>
  );
}

type ChecklistState = "pending" | "running" | "done" | "error" | "rejected";
interface ChecklistRow { key: string; label: string; icon: IconName; state: ChecklistState }

// Map a tool's StepStatus to a checklist state (rejected = user-skipped).
function stepState(status: StepStatus): ChecklistState {
  return status === "done" ? "done" : status === "error" ? "error" : status === "rejected" ? "rejected" : status === "pending" ? "pending" : "running";
}

// Derive a Claude-Code-style step list from the orchestrator's run.order: one
// row per child delegation (Search/Action agent) and per significant tool, each
// carrying a live state. delegate_to_search has no ToolState (it's represented
// by its child card), so only real tools + children appear. No agent-loop change.
function buildChecklist(run: RunState, runs: Record<string, RunState>): ChecklistRow[] {
  const rows: ChecklistRow[] = [];
  for (const o of run.order) {
    if (o.kind === "child") {
      const c = runs[o.childId];
      const isSearch = c?.agent === "search";
      rows.push({
        key: o.childId,
        label: isSearch ? "Search agent" : "Action agent",
        icon: isSearch ? "search" : "folder-open",
        state: !c ? "pending" : c.status === "running" ? "running" : c.status === "error" ? "error" : "done",
      });
    } else {
      const t = run.tools[o.callId];
      if (!t) continue;
      rows.push({
        key: o.callId,
        label: t.tool === "delegate_to_action" ? "Apply proposed changes" : toolCardTitle(t),
        icon: toolCardIcon(t.tool),
        state: stepState(t.status),
      });
    }
  }
  return rows;
}

// Live, collapsible "Steps" checklist rendered near the top of an orchestrator
// turn. A lightweight summary of the timeline; the detailed cards remain below.
function PlanChecklist({ run, runs }: { run: RunState; runs: Record<string, RunState> }) {
  const [open, setOpen] = useState(true);
  const rows = useMemo(() => buildChecklist(run, runs), [run, runs]);
  // Only worth showing when there's a real plan: a delegation, or 2+ steps.
  const hasChild = run.order.some((o) => o.kind === "child");
  if (!rows.length || (rows.length < 2 && !hasChild)) return null;
  const done = rows.filter((r) => r.state === "done").length;
  return (
    <div className="plan-checklist">
      <div className="plan-checklist-head" onClick={() => setOpen((v) => !v)}>
        <Icon name="list-task" size={12} />
        <span className="plan-checklist-title">Steps</span>
        <span className="plan-checklist-count">{done}/{rows.length}</span>
        <span className="spacer" />
        <Icon name={open ? "chevron-down" : "chevron-right"} size={11} />
      </div>
      {open && (
        <ol className="plan-checklist-body">
          {rows.map((r) => (
            <li key={r.key} className={`plan-step ${r.state}`}>
              <StepStateIcon state={r.state} />
              <Icon name={r.icon} size={12} className="plan-step-glyph" />
              <span className="plan-step-label">{r.label}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// State glyph for a checklist row: dim circle (pending), spinner (running),
// check (done), x (error), or a muted dash (user-skipped).
function StepStateIcon({ state }: { state: ChecklistState }) {
  if (state === "running") return <span className="ai-spinner plan-step-icon" aria-hidden />;
  if (state === "done") return <span className="plan-step-icon ok"><Icon name="check" size={11} /></span>;
  if (state === "error") return <span className="plan-step-icon err"><Icon name="x" size={11} /></span>;
  if (state === "rejected") return <span className="plan-step-icon rej"><Icon name="x" size={10} /></span>;
  return <span className="plan-step-icon pending" aria-hidden />;
}

function SubAgentCard({ runId, runs, onApprove, onReject, onApproveAll, onAllowlist }: { runId: string; runs: Record<string, RunState>; onApprove: (c: string) => void; onReject: (c: string) => void; onApproveAll: (c: string) => void; onAllowlist: (c: string, tool: string) => void }) {
  const run = runs[runId];
  const onRevealPath = useContext(RevealPathContext);
  const [collapsed, setCollapsed] = useState(false);
  if (!run) return null;
  const isSearch = run.agent === "search";
  const streaming = run.status === "running";
  return (
    <div className={`subagent ${run.agent} ${run.status}`}>
      <div className="subagent-head" onClick={() => setCollapsed((v) => !v)}>
        <Icon name={isSearch ? "search" : "folder-open"} size={13} />
        <span className="subagent-name">{isSearch ? "Search agent" : "Action agent"}</span>
        <span className={`subagent-badge ${run.status}`}>
          {streaming && <span className="ai-spinner sm" aria-hidden />}
          {streaming ? "working" : run.status}
        </span>
        <span className="spacer" />
        <Icon name={collapsed ? "chevron-right" : "chevron-down"} size={12} />
      </div>
      {!collapsed && (
        <div className="subagent-body">
          {run.task && <div className="subagent-task">{String(run.task)}</div>}
          {run.thinking.trim() && <ThinkingBlock text={run.thinking} open={streaming && !run.text} live={streaming && !run.text} durationMs={run.thinkMs} />}
          <StepList run={run} runs={runs} onApprove={onApprove} onReject={onReject} onApproveAll={onApproveAll} onAllowlist={onAllowlist} />
          {run.text.trim() && <div className="subagent-summary"><Markdown text={run.text} onPathClick={onRevealPath} />{streaming && <span className="chat-cursor">{"\u258B"}</span>}</div>}
          {run.notices.map((n, i) => <NoticeLine key={i} level={n.level} text={n.text} />)}
          {streaming && <LiveStatus label={currentActivity(run, runs)} showElapsed />}
        </div>
      )}
    </div>
  );
}

// Cursor-style "Allow" split menu: a secondary control offering "Always allow
// <tool>" (persists to the allowlist, then approves) and "Approve all in this
// run" (per-turn latch). Closes on outside click / Escape.
function AllowMenu({ callId, tool, label, onAllowlist, onApproveAll }: {
  callId: string;
  tool: string;
  label: string;
  onAllowlist: (c: string, tool: string) => void;
  onApproveAll: (c: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div className="approval-allow" ref={ref}>
      <button className="agent-btn-ghost approval-allow-trigger" onClick={() => setOpen((v) => !v)} title="More approval options">
        Allow <Icon name="chevron-down" size={10} className={open ? "flip-y" : undefined} />
      </button>
      {open && (
        <div className="approval-allow-menu" role="menu">
          <button role="menuitem" onClick={() => { setOpen(false); onAllowlist(callId, tool); }}>
            <Icon name="check" size={11} /> {label}
          </button>
          <button role="menuitem" onClick={() => { setOpen(false); onApproveAll(callId); }} title="Approve this and all remaining actions in this run">
            <Icon name="check" size={11} /> Approve all in this run
          </button>
        </div>
      )}
    </div>
  );
}

// Tier-1 plan card: the whole proposed change (delegate_to_action) the user
// approves before the Action agent starts.
function PlanCard({ tool, onApprove, onReject, onApproveAll, onAllowlist }: { tool?: ToolState; onApprove: (c: string) => void; onReject: (c: string) => void; onApproveAll: (c: string) => void; onAllowlist: (c: string, tool: string) => void }) {
  if (!tool) return null;
  const task = taskText(tool.args.task);
  const paths = parsePlanPaths(task);
  const pending = tool.status === "pending";
  const dotClass = tool.status === "error" ? "err" : tool.status === "rejected" ? "rej" : tool.status === "done" ? "ok" : pending ? "wait" : "run";
  return (
    <div className={`approval-card plan-card ${tool.status}`}>
      <div className="approval-card-head">
        <span className={`tool-dot ${dotClass}`} />
        <Icon name="folder-open" size={13} />
        <span className="approval-card-title">Proposed changes</span>
        {tool.status === "rejected" && <span className="approval-status rej">Skipped</span>}
        {tool.status === "done" && <span className="approval-status ok">Approved</span>}
      </div>
      <div className="approval-card-body">
        {task && <div className="plan-card-task">{task}</div>}
        {paths.length > 0 && (
          <ul className="agent-card-paths">
            {paths.slice(0, 12).map((p, i) => <li key={i} title={p}>{p}</li>)}
            {paths.length > 12 && <li>…and {paths.length - 12} more</li>}
          </ul>
        )}
      </div>
      {pending && (
        <div className="approval-card-actions">
          <button className="agent-btn-approve" onClick={() => onApprove(tool.callId)}>Approve plan</button>
          <button className="agent-btn-reject" onClick={() => onReject(tool.callId)}>Reject</button>
          <span className="approval-actions-spacer" />
          <AllowMenu callId={tool.callId} tool="delegate_to_action" label="Always allow action plans" onAllowlist={onAllowlist} onApproveAll={onApproveAll} />
        </div>
      )}
    </div>
  );
}

function ToolStep({ tool, onApprove, onReject, onApproveAll, onAllowlist }: { tool?: ToolState; onApprove: (c: string) => void; onReject: (c: string) => void; onApproveAll: (c: string) => void; onAllowlist: (c: string, tool: string) => void }) {
  if (!tool) return null;
  // Mutating action tools — and read-only tools that still require explicit
  // approval (git/web/side-effecting MCP) — render as the richer Tier-2 card so
  // the user actually gets Approve/Skip buttons.
  if (tool.mutating || tool.requiresApproval) return <ActionCard tool={tool} onApprove={onApprove} onReject={onReject} onApproveAll={onApproveAll} onAllowlist={onAllowlist} />;
  // Read-only search steps render as an expandable rich card (Cursor/Claude
  // style): a per-tool icon + human title + compact args hint + status dot in the
  // collapsed header, with the full args and any result output in the body.
  const argLine = compactArgs(tool);
  const dotClass = tool.status === "error" ? "err" : tool.status === "rejected" ? "rej" : tool.status === "done" ? "ok" : tool.status === "pending" ? "wait" : "run";
  const argEntries = toolArgEntries(tool.args);
  return (
    <details className={`tool-step tool-card ${tool.status}`}>
      <summary className="tool-step-head">
        <span className={`tool-dot ${dotClass}`} />
        <Icon name={toolCardIcon(tool.tool)} size={12} className="tool-card-icon" />
        <span className="tool-card-title">{toolCardTitle(tool)}</span>
        {argLine && <span className="tool-args">{argLine}</span>}
        <span className="tool-card-meta">
          {tool.summary && <span className={`tool-summary ${tool.status === "error" ? "err" : ""}`}>{tool.summary}</span>}
          <Icon name="chevron-right" size={11} className="tool-card-caret" />
        </span>
      </summary>
      <div className="tool-step-detail">
        {argEntries.length > 0 ? (
          <div className="tool-card-args">
            {argEntries.map(([k, v]) => (
              <div className="tool-card-arg-row" key={k}>
                <span className="tool-card-arg-key">{k}</span>
                <span className="tool-card-arg-val">{v}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="tool-card-summary-full">No arguments.</div>
        )}
        {tool.summary && !tool.output && <div className="tool-card-summary-full">Result: {tool.summary}</div>}
        {tool.output && <pre className="tool-card-output">{tool.output}</pre>}
      </div>
    </details>
  );
}

// Tier-2 command-approval card (Codex/Cursor style): a humanized command line,
// the affected paths, and Approve / Reject (+ optional Approve-all-in-run).
function ActionCard({ tool, onApprove, onReject, onApproveAll, onAllowlist }: { tool: ToolState; onApprove: (c: string) => void; onReject: (c: string) => void; onApproveAll: (c: string) => void; onAllowlist: (c: string, tool: string) => void }) {
  const paths = (tool.args.paths as string[]) ?? (tool.args.path ? [String(tool.args.path)] : []);
  const dest = tool.args.destination as string | undefined;
  const newName = tool.args.new_name as string | undefined;
  const isCmd = tool.tool === "run_command";
  const isEdit = tool.tool === "write_file" || tool.tool === "edit_file";
  const cwd = isCmd ? (tool.args.cwd as string | undefined) : undefined;
  const pending = tool.status === "pending";
  const dotClass = tool.status === "error" ? "err" : tool.status === "rejected" ? "rej" : tool.status === "done" ? "ok" : pending ? "wait" : "run";
  const statusLabel = tool.status === "rejected" ? "Skipped" : tool.status === "done" ? (tool.summary || "Done") : tool.status === "error" ? (tool.summary || "Failed") : "";
  // Ran without surfacing a card (global auto-approve or an allowlisted tool).
  const autoRan = !tool.requiresApproval && tool.status !== "pending";
  // run_command + always-approve tools can never be bypassed, so don't offer the
  // allow/approve-all menu for them.
  const canAllow = !ALWAYS_APPROVE_TOOLS.has(tool.tool);
  return (
    <div className={`approval-card action-card ${tool.status}`}>
      <div className="approval-card-head">
        <span className={`tool-dot ${dotClass}`} />
        <span className="approval-card-title">{actionCardTitle(tool.tool)}</span>
        {autoRan && <span className="approval-status auto" title="Ran without a review card (auto-approved or on the allowlist)">Auto-approved</span>}
        {!pending && statusLabel && <span className={`approval-status ${tool.status === "error" ? "err" : tool.status === "done" ? "ok" : "rej"}`}>{statusLabel}</span>}
      </div>
      <div className="approval-card-body">
        <div className={`approval-command${isCmd ? " cmd" : ""}`}><Icon name="terminal" size={12} /><code>{humanizeCommand(tool)}</code></div>
        {cwd && <div className="approval-meta">Working dir: <code>{cwd}</code></div>}
        {dest && <div className="approval-meta">Destination: <code>{dest}</code></div>}
        {newName && <div className="approval-meta">New name: <code>{newName}</code></div>}
        {isEdit && <DiffPreview tool={tool} />}
        {paths.length > 0 && !isEdit && (
          <div className="approval-paths">
            <div className="approval-paths-label">{paths.length === 1 ? "Affected path" : `Affected paths (${paths.length})`}</div>
            <ul className="agent-card-paths">
              {paths.slice(0, 10).map((p, i) => <li key={i} title={p}>{p}</li>)}
              {paths.length > 10 && <li>…and {paths.length - 10} more</li>}
            </ul>
          </div>
        )}
        {tool.output && <pre className="approval-output">{tool.output}</pre>}
      </div>
      {pending && (
        <div className="approval-card-actions">
          <button className="agent-btn-approve" onClick={() => onApprove(tool.callId)} title="Run this action once">Allow once</button>
          <button className="agent-btn-reject" onClick={() => onReject(tool.callId)} title="Don't run this action">Reject</button>
          {canAllow && (
            <>
              <span className="approval-actions-spacer" />
              <AllowMenu callId={tool.callId} tool={tool.tool} label={`Always allow ${actionVerb(tool.tool)}`} onAllowlist={onAllowlist} onApproveAll={onApproveAll} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Short, friendly verb for a tool used in "Always allow <verb>" menu labels.
function actionVerb(tool: string): string {
  const map: Record<string, string> = {
    move_items: "moving items", recycle_items: "recycling items", rename_item: "renaming",
    create_folder: "creating folders", write_file: "writing files", edit_file: "editing files",
    delegate_to_action: "action plans", git_status: "git status", git_diff: "git diff",
    git_log: "git log", web_fetch: "web fetches", web_search: "web searches",
  };
  return map[tool] ?? tool.replace(/^mcp__/, "").replace(/__/g, " · ");
}

// Best-effort coercion of a delegate task into display text.
function taskText(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["task", "query", "description", "text", "prompt", "instruction"]) {
      const val = o[k];
      if (typeof val === "string" && val.trim()) return val.trim();
    }
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return v == null ? "" : String(v);
}

// Pull absolute Windows paths out of a plan task for the plan card's preview.
function parsePlanPaths(text: string): string[] {
  const matches = text.match(/[A-Za-z]:\\[^\n"]+/g) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    const p = m.trim().replace(/[).,;]+$/, "");
    if (p && !seen.has(p)) { seen.add(p); out.push(p); }
  }
  return out;
}

// Title line for the Tier-2 approval card, tuned to the tool family.
function actionCardTitle(tool: string): string {
  if (tool === "run_command") return "Action agent wants to run a command";
  if (tool === "write_file" || tool === "edit_file") return "Action agent wants to edit a file";
  if (tool === "git_status" || tool === "git_diff" || tool === "git_log") return "Assistant wants to run a git command";
  if (tool === "web_fetch") return "Assistant wants to fetch a web page";
  if (tool === "web_search") return "Assistant wants to search the web";
  if (tool.startsWith("mcp__")) return "Assistant wants to use an MCP tool";
  return "Action agent wants to run";
}

// Turn a mutating tool call into a plain-language command line for the card.
function humanizeCommand(tool: ToolState): string {
  const paths = (tool.args.paths as string[]) ?? (tool.args.path ? [String(tool.args.path)] : []);
  const n = paths.length;
  const items = `${n} item${n === 1 ? "" : "s"}`;
  switch (tool.tool) {
    case "run_command": return String(tool.args.command ?? "");
    case "recycle_items": return `Send ${items} to Recycle Bin`;
    case "move_items": return `Move ${items} to ${basename(String(tool.args.destination ?? ""))}`;
    case "rename_item": return `Rename ${basename(String(tool.args.path ?? ""))} → ${String(tool.args.new_name ?? "")}`;
    case "create_folder": return `Create folder ${basename(String(tool.args.path ?? ""))}`;
    case "write_file": return `Write ${basename(String(tool.args.path ?? ""))}`;
    case "edit_file": return `Edit ${basename(String(tool.args.path ?? ""))}`;
    case "git_status": return "git status";
    case "git_diff": return `git diff${tool.args.staged ? " --staged" : ""}`;
    case "git_log": return `git log -n ${Number(tool.args.count) || 20}`;
    case "web_fetch": return `Fetch ${String(tool.args.url ?? "")}`;
    case "web_search": return `Search “${String(tool.args.query ?? "")}”`;
    default: return tool.tool.startsWith("mcp__") ? tool.tool.replace(/^mcp__/, "").replace(/__/g, " · ") : tool.tool;
  }
}

// Old-vs-new preview for write_file / edit_file so the user sees the change
// before approving. edit_file shows the exact substring replacement; write_file
// shows the (bounded) new content being created/overwritten.
function DiffPreview({ tool }: { tool: ToolState }) {
  const clip = (s: string, n = 1200) => (s.length > n ? s.slice(0, n) + "\n… (truncated)" : s);
  const path = String(tool.args.path ?? "");
  if (tool.tool === "edit_file") {
    const oldLines = clip(String(tool.args.old_string ?? "")).split("\n");
    const newLines = clip(String(tool.args.new_string ?? "")).split("\n");
    return (
      <div className="approval-diff">
        <div className="approval-diff-head">
          <code className="approval-diff-path">{path}</code>
          <span className="approval-diff-stat"><span className="del">-{oldLines.length}</span> <span className="add">+{newLines.length}</span></span>
        </div>
        <pre className="approval-diff-block">
          {oldLines.map((l, i) => <div key={"o" + i} className="diff-line del">- {l}</div>)}
          {newLines.map((l, i) => <div key={"n" + i} className="diff-line add">+ {l}</div>)}
        </pre>
      </div>
    );
  }
  const contentLines = clip(String(tool.args.content ?? "")).split("\n");
  return (
    <div className="approval-diff">
      <div className="approval-diff-head">
        <code className="approval-diff-path">{path}</code>
        <span className="approval-diff-stat new">new file · <span className="add">+{contentLines.length}</span></span>
      </div>
      <pre className="approval-diff-block">
        {contentLines.map((l, i) => <div key={"n" + i} className="diff-line add">+ {l}</div>)}
      </pre>
    </div>
  );
}

function compactArgs(tool: ToolState): string {
  const a = tool.args;
  switch (tool.tool) {
    case "find": return [a.glob && `glob:${a.glob}`, a.query && `"${a.query}"`, a.dir && `in ${basename(String(a.dir))}`].filter(Boolean).join(" ");
    case "list_dir": return a.path ? basename(String(a.path)) : "";
    case "list_largest": return a.count ? `top ${a.count}` : "top 15";
    case "scan_folder": return a.path ? String(a.path) : "";
    case "reveal": return a.path ? basename(String(a.path)) : "";
    case "find_duplicates": return a.min_size_mb ? `≥ ${a.min_size_mb} MB` : "";
    default: return "";
  }
}

// Per-tool glyph for the rich read-only tool card and the plan checklist rows,
// following the inlined-Bootstrap icon set in Icon.tsx.
function toolCardIcon(tool: string): IconName {
  switch (tool) {
    case "list_dir": return "folder";
    case "list_largest": return "bar-chart";
    case "find":
    case "grep": return "search";
    case "read_file": return "file-text";
    case "scan_folder": return "hdd";
    case "find_duplicates": return "duplicates";
    case "reveal": return "explorer";
    case "list_by_extension": return "list-ul";
    case "get_stats": return "bar-chart";
    case "remember": return "bookmark";
    case "delegate_to_action": return "folder-open";
    case "delegate_to_search": return "search";
    case "run_command": return "terminal";
    case "write_file":
    case "edit_file":
    case "rename_item": return "pencil-square";
    case "recycle_items": return "trash";
    case "move_items": return "folder-open";
    case "create_folder": return "folder-plus";
    case "web_fetch":
    case "web_search": return "search";
    default: return "tools";
  }
}

// Human-readable, past-tense title for a read-only tool card, derived from the
// tool name + its args (e.g. list_dir → "Listed Downloads", find → 'Searched
// for "report"'). Falls back to a humanized MCP name or the raw tool name.
function toolCardTitle(tool: ToolState): string {
  const a = tool.args;
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
  switch (tool.tool) {
    case "list_dir": { const p = s(a.path); return p ? `Listed ${basename(p)}` : "Listed folder"; }
    case "list_largest": return a.files_only ? "Found largest files" : "Found largest items";
    case "find": {
      const q = s(a.query); if (q) return `Searched for "${q}"`;
      const g = s(a.glob); if (g) return `Searched for ${g}`;
      const d = s(a.dir); return d ? `Searched ${basename(d)}` : "Searched files";
    }
    case "grep": { const q = s(a.query); return q ? `Searched contents for "${q}"` : "Searched file contents"; }
    case "read_file": { const p = s(a.path); return p ? `Read ${basename(p)}` : "Read file"; }
    case "scan_folder": { const p = s(a.path); return p ? `Scanned ${basename(p)}` : "Scanned folder"; }
    case "find_duplicates": return a.min_size_mb ? `Found duplicates ≥ ${a.min_size_mb} MB` : "Found duplicate files";
    case "reveal": { const p = s(a.path); return p ? `Revealed ${basename(p)}` : "Revealed in Explorer"; }
    case "list_by_extension": return "Grouped files by type";
    case "get_stats": return "Read folder stats";
    case "remember": return "Noted a detail";
    default: return tool.tool.startsWith("mcp__") ? tool.tool.replace(/^mcp__/, "").replace(/__/g, " · ") : tool.tool;
  }
}

// Flatten a tool's args into [key, value] rows for the expandable card body,
// dropping empties and bounding very long values so the body stays compact.
function toolArgEntries(args: Record<string, unknown>): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null || v === "") continue;
    let val = typeof v === "string" ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
    if (val.length > 400) val = val.slice(0, 400) + "…";
    out.push([k, val]);
  }
  return out;
}

function ThinkingBlock({ text, open, live, durationMs }: { text: string; open: boolean; live?: boolean; durationMs?: number }) {
  // While reasoning is live, label "Thinking…"; once the answer begins (or the
  // run ends) relabel to "Thought for Ns" and let the parent collapse it.
  const label = !live && durationMs != null && durationMs >= 500 ? `Thought for ${formatThoughtDuration(durationMs)}` : "Thinking";
  return (
    <details className="thinking" open={open}>
      <summary>{label}{live && <Dots />}</summary>
      <div className="thinking-body">{text}</div>
    </details>
  );
}

// Compact human duration for the reasoning summary: seconds up to a minute,
// then "Nm Ns". Rounds to the nearest second (floor at 1s).
function formatThoughtDuration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

// Describes, in plain language, what an agent is doing right now — surfaced as
// an animated status line so the user can always see live progress.
function currentActivity(run: RunState, runs: Record<string, RunState>): string {
  for (let i = run.order.length - 1; i >= 0; i--) {
    const o = run.order[i];
    if (o.kind === "child") {
      const c = runs[o.childId];
      if (c && c.status === "running") return `Working with the ${c.agent === "search" ? "Search" : "Action"} agent`;
    } else {
      const t = run.tools[o.callId];
      if (t?.status === "pending") return "Waiting for your approval";
      if (t?.status === "running") return runningActivity(t);
    }
  }
  if (run.text.trim()) return "Writing response";
  if (run.agent === "orchestrator") return "Planning";
  return "Thinking";
}

// Path-specific present-tense phrase for a tool that is currently running, used
// by the live status line (e.g. "Searching E:\Downloads", "Reading config.json")
// instead of a bare "Running list_dir". Directory targets show the full path;
// file targets show the basename. The elapsed timer is appended by LiveStatus.
function runningActivity(tool: ToolState): string {
  const a = tool.args;
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
  switch (tool.tool) {
    case "list_dir": { const p = s(a.path); return p ? `Listing ${basename(p)}` : "Listing folder"; }
    case "list_largest": return a.files_only ? "Finding largest files" : "Finding largest items";
    case "find": {
      const q = s(a.query); if (q) return `Searching for "${q}"`;
      const g = s(a.glob); if (g) return `Searching for ${g}`;
      const d = s(a.dir); return d ? `Searching ${d}` : "Searching files";
    }
    case "grep": { const q = s(a.query); return q ? `Searching contents for "${q}"` : "Searching file contents"; }
    case "read_file": { const p = s(a.path); return p ? `Reading ${basename(p)}` : "Reading file"; }
    case "scan_folder": { const p = s(a.path); return p ? `Scanning ${p}` : "Scanning folder"; }
    case "find_duplicates": return "Finding duplicate files";
    case "reveal": { const p = s(a.path); return p ? `Revealing ${basename(p)}` : "Revealing in Explorer"; }
    case "list_by_extension": return "Grouping files by type";
    case "get_stats": return "Reading folder stats";
    case "run_command": { const c = s(a.command); return c ? `Running ${c.split(/\s+/)[0]}` : "Running command"; }
    case "write_file":
    case "edit_file": { const p = s(a.path); return p ? `Editing ${basename(p)}` : "Editing file"; }
    case "move_items": return "Moving items";
    case "recycle_items": return "Recycling items";
    case "rename_item": return "Renaming item";
    case "create_folder": return "Creating folder";
    case "web_fetch": return "Fetching web page";
    case "web_search": { const q = s(a.query); return q ? `Searching the web for "${q}"` : "Searching the web"; }
    default: return tool.tool.startsWith("mcp__") ? `Running ${tool.tool.replace(/^mcp__/, "").replace(/__/g, " · ")}` : `Running ${tool.tool}`;
  }
}

function LiveStatus({ label, showElapsed }: { label: string; showElapsed?: boolean }) {
  // Elapsed timer for the active run/step: counts seconds since `label` last
  // changed (each new activity resets it). The 1s interval is torn down on
  // unmount and re-armed whenever the activity changes — so it never leaks.
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (!showElapsed) return;
    setSecs(0);
    const start = Date.now();
    const id = window.setInterval(() => setSecs(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [label, showElapsed]);
  return (
    <div className="agent-live">
      <span className="ai-spinner" aria-hidden />
      <span className="agent-live-label" title={label}>{label}</span>
      {showElapsed && secs > 0 && <span className="agent-live-elapsed">({secs}s)</span>}
      <Dots />
    </div>
  );
}

function Dots() {
  return <span className="ai-dots"><i /><i /><i /></span>;
}

function NoticeLine({ level, text }: { level: "info" | "warn" | "error"; text: string }) {
  return (
    <div className={`chat-notice ${level}`}>
      <Icon name={level === "error" ? "warning" : level === "warn" ? "warning" : "chat"} size={12} />
      <span>{text}</span>
    </div>
  );
}

// ── In-panel conversation history ────────────────────────────
function HistoryView({ sessionId, onOpen, onNew, onClose }: {
  sessionId: string;
  onOpen: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [list, setList] = useState<ChatSessionMeta[]>(() => loadChatIndex());
  // Inline rename: the session being edited + its working title draft.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const needle = q.trim().toLowerCase();
  const filtered = needle ? list.filter((s) => (s.title || "").toLowerCase().includes(needle)) : list;
  const refresh = () => setList(loadChatIndex());
  const remove = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    deleteChatSession(id);
    refresh();
  };
  const togglePin = (e: React.MouseEvent, s: ChatSessionMeta) => {
    e.stopPropagation();
    pinChatSession(s.id, !s.pinned);
    refresh();
  };
  const beginRename = (e: React.MouseEvent, s: ChatSessionMeta) => {
    e.stopPropagation();
    setRenamingId(s.id);
    setDraft(s.title || "");
  };
  const commitRename = (id: string) => {
    if (draft.trim()) renameChatSession(id, draft);
    setRenamingId(null);
    refresh();
  };
  return (
    <div className="chat-history">
      <div className="chat-history-head">
        <span className="chat-history-heading">Chat history</span>
        <span className="spacer" />
        <button className="chat-history-new" onClick={onNew}><Icon name="plus" size={12} /> New chat</button>
        <button className="icon" title="Close history" onClick={onClose}><Icon name="x" size={13} /></button>
      </div>
      <div className="chat-history-search">
        <Icon name="search" size={12} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats…" autoFocus spellCheck={false} />
      </div>
      <div className="chat-history-list">
        {filtered.length === 0 && (
          <div className="chat-history-empty">{needle ? "No chats match your search." : "No saved chats yet."}</div>
        )}
        {filtered.map((s) => {
          const renaming = renamingId === s.id;
          return (
            <div
              key={s.id}
              className={`chat-history-item${s.id === sessionId ? " active" : ""}${s.pinned ? " pinned" : ""}`}
              onClick={() => { if (!renaming) onOpen(s.id); }}
              title={s.title}
            >
              <Icon name={s.pinned ? "star-fill" : "chat"} size={13} />
              <div className="chat-history-item-main">
                {renaming ? (
                  <input
                    className="chat-history-rename"
                    value={draft}
                    autoFocus
                    spellCheck={false}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => commitRename(s.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); commitRename(s.id); }
                      else if (e.key === "Escape") { e.preventDefault(); setRenamingId(null); }
                    }}
                  />
                ) : (
                  <span className="chat-history-item-title">{s.title || "New chat"}</span>
                )}
                <span className="chat-history-item-meta">{relativeTime(s.ts)} · {s.count} msg{s.count === 1 ? "" : "s"}</span>
              </div>
              {s.id === sessionId && !renaming && <span className="chat-history-current">current</span>}
              {!renaming && (
                <div className="chat-history-actions">
                  <button className="chat-history-act" title={s.pinned ? "Unpin" : "Pin to top"} onClick={(e) => togglePin(e, s)}><Icon name={s.pinned ? "star-fill" : "star"} size={12} /></button>
                  <button className="chat-history-act" title="Rename" onClick={(e) => beginRename(e, s)}><Icon name="pencil-square" size={12} /></button>
                  <button className="chat-history-act del" title="Delete chat" onClick={(e) => remove(e, s.id)}><Icon name="trash" size={12} /></button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Build a short plain-text transcript of a saved session for @-references.
function sessionTranscript(id: string): string {
  const blob = loadChatSession(id);
  if (!blob) return "";
  const items = (blob.items as ChatItem[]) ?? [];
  const runs = (blob.runs as Record<string, RunState>) ?? {};
  const lines: string[] = [];
  for (const it of items) {
    if (it.type === "user" && it.text?.trim()) lines.push(`User: ${it.text.trim()}`);
    else if (it.type === "run") {
      const t = runs[it.runId]?.text?.trim();
      if (t) lines.push(`Assistant: ${t}`);
    }
  }
  return lines.join("\n").slice(0, 2000);
}

// One-shot, tool-free summary of aged-out messages using the active model.
// Returns "" on any failure so the caller can fall back to recent-only memory.
async function summarizeConversation(opts: {
  prevSummary: string;
  messages: LlmMessage[];
  provider: LlmProvider;
  model: string;
  apiKey?: string;
  signal: AbortSignal;
  options?: LlmOptions;
}): Promise<string | null> {
  const transcript = opts.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .filter((l) => l.trim().length > 6)
    .join("\n");
  // Nothing summarizable (e.g. all-empty aged messages): keep the prior summary
  // unchanged — this is success, not a failure, so callers shouldn't warn.
  if (!transcript.trim()) return opts.prevSummary;
  const system =
    "You maintain a concise running summary of a conversation between a user and a file-management assistant. " +
    "Preserve concrete facts: folders/paths discussed, findings (sizes, duplicates, counts), decisions made, and any pending or completed file actions. " +
    "Keep it to a short paragraph. Output only the updated summary, with no preamble.";
  const user = (opts.prevSummary ? `Current summary:\n${opts.prevSummary}\n\n` : "") + `New messages to fold in:\n${transcript}`;
  let out = "";
  try {
    for await (const ev of llmStream({
      provider: opts.provider,
      model: opts.model,
      apiKey: opts.apiKey,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      signal: opts.signal,
      options: opts.options,
    })) {
      if (ev.type === "text") out += ev.value;
      // Distinguish a real failure (null → caller warns + falls back to recent)
      // from a legitimately empty result.
      else if (ev.type === "error") return null;
    }
  } catch (e) {
    // Abort is expected on stop/new-turn; treat as a non-event (no warning).
    if ((e as Error).name === "AbortError") return opts.prevSummary;
    return null;
  }
  return out.trim();
}

function relativeTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return `${Math.round(d / 7)}w ago`;
}

// Imperative handle so the composer's "/model" slash command can pop the menu.
export interface ModelPickerHandle { open: () => void }

// Custom, fully-themed model dropdown. Replaces a native <select> so the closed
// control hugs its label (no far-away arrow) and the open menu always uses the
// app's dark theme instead of the OS-drawn list.
const ModelPicker = forwardRef<ModelPickerHandle, {
  groups: ModelGroup[];
  provider: LlmProvider;
  model: string;
  disabled?: boolean;
  onPick: (provider: LlmProvider, model: string) => void;
}>(function ModelPicker({ groups, provider, model, disabled, onPick }, handleRef) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useImperativeHandle(handleRef, () => ({ open: () => setOpen(true) }), []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const empty = groups.every((g) => g.models.length === 0);
  return (
    <div className="model-picker" ref={ref}>
      <button type="button" className="model-picker-btn" disabled={disabled} onClick={() => setOpen((v) => !v)} title={model || "Select model"}>
        <span className="model-picker-label">{model || "Select model"}</span>
        <Icon name="chevron-down" size={11} className={open ? "flip-y" : undefined} />
      </button>
      {open && (
        <div className="model-picker-menu" role="listbox">
          {empty && <div className="model-picker-empty">No models found. Start Ollama or add an API key.</div>}
          {groups.map((g) => g.models.length > 0 && (
            <div key={g.provider} className="model-picker-group">
              <div className="model-picker-group-label">{g.label}</div>
              {g.models.map((m) => {
                const sel = g.provider === provider && m === model;
                return (
                  <button
                    key={g.provider + m}
                    type="button"
                    role="option"
                    aria-selected={sel}
                    className={`model-picker-item${sel ? " sel" : ""}`}
                    onClick={() => { onPick(g.provider, m); setOpen(false); }}
                  >
                    <span className="model-picker-check">{sel && <Icon name="check" size={12} />}</span>
                    <span className="model-picker-item-name">{m}</span>
                    <span className="model-picker-badges">
                      {isToolCapable(g.provider, m) && (
                        <span className="model-badge tool" title="Supports tool-calling (required for agent actions)"><Icon name="tools" size={9} /> Tools</span>
                      )}
                      {isVisionCapable(g.provider, m) && (
                        <span className="model-badge vision" title="Can read attached images"><Icon name="image" size={9} /> Vision</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

function SettingsMenu({ ai, autoApprove, onChange, onToggleAuto, onRemoveAllow, onChangeRules, onChangeMcp, onClose }: {
  ai: AiSettings;
  autoApprove: boolean;
  onChange: (keys: Partial<AiSettings["keys"]>) => void;
  onToggleAuto: (v: boolean) => void;
  onRemoveAllow: (tool: string) => void;
  onChangeRules: (rules: string) => void;
  onChangeMcp: (servers: McpServerConfig[]) => void;
  onClose: () => void;
}) {
  const ALLOW_LABELS: Record<string, string> = {
    run_command: "Run command",
    recycle_items: "Recycle items",
    move_items: "Move items",
    rename_item: "Rename item",
    create_folder: "Create folder",
    delegate_to_action: "Action plans",
  };
  return (
    <div className="chat-keys">
      <div className="chat-keys-head">
        <span>Settings</span>
        <button className="icon" onClick={onClose} title="Close"><Icon name="x" size={12} /></button>
      </div>
      <label className="chat-keys-toggle" title="Skip the approval step for file actions">
        <input type="checkbox" checked={autoApprove} onChange={(e) => onToggleAuto(e.target.checked)} />
        <span>Auto-approve file actions</span>
      </label>
      <div className="chat-keys-divider" />
      <label>Custom instructions / project rules
        <textarea
          className="chat-rules-input"
          value={ai.rules}
          placeholder="e.g. Always prefer recycling over permanent deletion. Treat C:\Work as read-only."
          onChange={(e) => onChangeRules(e.target.value)}
          rows={3}
          spellCheck={false}
        />
      </label>
      <p className="chat-keys-note">Injected into the assistant's system prompt every turn.</p>
      <McpServersEditor servers={ai.mcpServers} onChange={onChangeMcp} />
      <div className="chat-keys-allow">
        <div className="chat-keys-allow-head">Always-allowed actions</div>
        {ai.allow.length === 0 ? (
          <p className="chat-keys-note">None yet. Choose "Always allow" on an action's review box to skip its card next time.</p>
        ) : (
          <ul className="allow-list">
            {ai.allow.map((t) => (
              <li key={t} className="allow-row">
                <Icon name="check" size={11} />
                <span className="allow-name">{ALLOW_LABELS[t] ?? t}</span>
                <span className="spacer" />
                <button className="icon" onClick={() => onRemoveAllow(t)} title={`Stop always allowing ${t}`}><Icon name="x" size={11} /></button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="chat-keys-divider" />
      <label>OpenAI API key
        <input type="password" value={ai.keys.openai} placeholder="sk-…" onChange={(e) => onChange({ openai: e.target.value })} autoComplete="off" spellCheck={false} />
      </label>
      <label>Anthropic API key
        <input type="password" value={ai.keys.anthropic} placeholder="sk-ant-…" onChange={(e) => onChange({ anthropic: e.target.value })} autoComplete="off" spellCheck={false} />
      </label>
      <p className="chat-keys-note">Keys are stored locally on this machine and sent only to the provider you select.</p>
    </div>
  );
}

// Minimal MCP server management: add/remove/enable servers (stdio command or
// http URL). Discovered tools are registered into the agent at run start.
function McpServersEditor({ servers, onChange }: { servers: McpServerConfig[]; onChange: (s: McpServerConfig[]) => void }) {
  const add = () => {
    const id = `mcp${Date.now().toString(36)}`;
    onChange([...servers, { id, name: "New server", enabled: true, transport: "stdio", command: "", args: [] }]);
  };
  const update = (id: string, patch: Partial<McpServerConfig>) =>
    onChange(servers.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const remove = (id: string) => onChange(servers.filter((s) => s.id !== id));
  return (
    <div className="chat-keys-allow">
      <div className="chat-keys-allow-head">
        MCP servers
        <span className="spacer" />
        <button className="icon" onClick={add} title="Add an MCP server"><Icon name="plus" size={12} /></button>
      </div>
      {servers.length === 0 ? (
        <p className="chat-keys-note">None. Add a Model Context Protocol server to give the assistant extra tools.</p>
      ) : (
        <ul className="mcp-list">
          {servers.map((s) => (
            <li key={s.id} className="mcp-row">
              <label className="mcp-row-top" title="Enable this server">
                <input type="checkbox" checked={s.enabled} onChange={(e) => update(s.id, { enabled: e.target.checked })} />
                <input className="mcp-name" value={s.name} placeholder="Name" onChange={(e) => update(s.id, { name: e.target.value })} />
                <Select
                  value={s.transport}
                  options={[
                    { value: "stdio", label: "stdio" },
                    { value: "http", label: "http" },
                  ]}
                  aria-label={`Transport for ${s.name}`}
                  onChange={(transport) => update(s.id, { transport })}
                />
                <button className="icon" onClick={() => remove(s.id)} title="Remove"><Icon name="x" size={11} /></button>
              </label>
              {s.transport === "stdio" ? (
                <input
                  className="mcp-cmd"
                  value={[s.command ?? "", ...(s.args ?? [])].join(" ").trim()}
                  placeholder="command arg1 arg2 (e.g. npx -y @modelcontextprotocol/server-filesystem C:\\)"
                  onChange={(e) => {
                    const parts = e.target.value.split(/\s+/).filter(Boolean);
                    update(s.id, { command: parts[0] ?? "", args: parts.slice(1) });
                  }}
                  spellCheck={false}
                />
              ) : (
                <input
                  className="mcp-cmd"
                  value={s.url ?? ""}
                  placeholder="https://host/mcp (JSON-RPC endpoint)"
                  onChange={(e) => update(s.id, { url: e.target.value })}
                  spellCheck={false}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
