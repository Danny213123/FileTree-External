import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { type AgentApi, readFileWindow, underPath } from "../lib/agent";
import { buildMcpRuntime } from "../lib/agents/mcp";
import {
  listModels,
  isToolCapable,
  isVisionCapable,
  llmStream,
  CLOUD_FALLBACK_MODELS,
  type LlmImage,
  type LlmMessage,
  type LlmProvider,
  uid,
} from "../lib/llm";
import { runOrchestrator } from "../lib/agents";
import type { AgentEvent } from "../lib/agents";
import { ALWAYS_APPROVE_TOOLS } from "../lib/agents/runtime";
import type { AgentKind, RunStatus, StepStatus, ToolCallView } from "../lib/agents/types";
import { loadAiSettings, saveAiSettings, loadAiKeys, saveAiKey, keyFor, type AiSettings, type McpServerConfig } from "../lib/aiSettings";
import { loadChatSession, saveChatSession, loadChatIndex, deleteChatSession, type ChatSessionBlob, type ChatSessionMeta } from "../lib/chatSessions";
import { scanStreamUrl, fetchDupesV2Bounded } from "../api/client";
import { getCached, setCached } from "../lib/scanCache";
import { readNdjsonStream } from "../hooks/useScan";
import type { NodeRecord, ScanResult, ExtensionStat } from "../api/types";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

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

// Memory tuning: once the running history exceeds SUMMARY_THRESHOLD messages,
// everything older than the most recent RECENT_WINDOW is folded into a rolling
// summary so long chats stay within context without dropping early facts.
const RECENT_WINDOW = 8;
const SUMMARY_THRESHOLD = 16;

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

export function ChatPanel({ getAgentApi, onClose, width = 360, sessionId, onNewSession, onRestoreSession, includeHidden = false, threads }: ChatPanelProps) {
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
        break;
      case "text":
        queueDelta(ev.runId, "text", ev.delta);
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
        setRuns((prev) => { const r = prev[ev.runId]; return r ? { ...prev, [ev.runId]: { ...r, status: ev.status, text: r.text || ev.summary || "", notices: r.notices.filter((n) => n.level === "error") } } : prev; });
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
        const summary = await summarizeConversation({
          prevSummary: convoSummaryRef.current,
          messages: aged,
          provider, model: selectedModel, apiKey, signal: controller.signal,
        });
        if (summary) {
          convoSummaryRef.current = summary;
          summarizedCountRef.current = boundary;
        }
      }
      priorConvo = convoSummaryRef.current
        ? [{ role: "system", content: "Summary of earlier conversation:\n" + convoSummaryRef.current }, ...history.slice(-RECENT_WINDOW)]
        : history.slice(-12);
    } else {
      priorConvo = history.slice(-12);
    }

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
      abortRef.current = null;
      resolveAllApprovals(false);
    }
  }, [busy, getAgentApi, selectedModel, provider, apiKey, attached, references, autoApprove, applyEvent, requestApproval, resolveAllApprovals, buildAttachedContext, includeHidden, threads, ai.mcpServers]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    resolveAllApprovals(false);
    setBusy(false);
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
  }, [busy]);

  const banner = useMemo(() => {
    if (provider === "ollama" && modelStatus === "offline") return { text: "Ollama isn't running. Start it and pull a tool-capable model.", action: "retry" as const };
    if (provider !== "ollama" && !apiKey) return { text: `Add your ${provider} API key to use cloud models.`, action: "keys" as const };
    if (!selectedModel) return { text: "No model available for this provider.", action: "retry" as const };
    return null;
  }, [provider, modelStatus, apiKey, selectedModel]);

  // ── @-mention popup (reference past messages / chats) ───────
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

  const showMentions = mentionQuery !== null && mentionDismissed !== input && mentions.thisChat.length + mentions.past.length > 0;

  const selectMention = useCallback((ref: RefItem) => {
    setInput((prev) => prev.replace(/@[\w.-]*$/, ""));
    // Session references lazily pull a short transcript; message refs already
    // carry their text.
    const resolved: RefItem = ref.kind === "session" ? { ...ref, text: sessionTranscript(ref.id) } : ref;
    setReferences((prev) => (prev.some((r) => r.id === resolved.id && r.kind === resolved.kind) ? prev : [...prev, resolved]));
    setMentionDismissed(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const canSend = (!!input.trim() || attached.length > 0 || references.length > 0) && !!selectedModel;

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
        {items.map((m) => {
          if (m.type === "user") {
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
              </div>
            );
          }
          if (m.type === "notice") return <NoticeLine key={m.id} level={m.level} text={m.text} />;
          return <RunView key={m.id} runId={m.runId} runs={runs} onApprove={(c) => resolveApproval(c, true)} onReject={(c) => resolveApproval(c, false)} onApproveAll={approveAll} onAllowlist={allowlist} />;
        })}
        <div ref={bottomRef} />
      </div>

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
        {showMentions && (
          <div className="mention-popup">
            {mentions.thisChat.length > 0 && (
              <div className="mention-group">
                <div className="mention-group-label">This chat</div>
                {mentions.thisChat.map((r) => (
                  <button key={r.id} type="button" className="mention-item" onMouseDown={(e) => { e.preventDefault(); selectMention(r); }}>
                    <Icon name="chat" size={12} /><span className="mention-item-label">{r.label}</span>
                  </button>
                ))}
              </div>
            )}
            {mentions.past.length > 0 && (
              <div className="mention-group">
                <div className="mention-group-label">Past chats</div>
                {mentions.past.map((r) => (
                  <button key={r.id} type="button" className="mention-item" onMouseDown={(e) => { e.preventDefault(); selectMention(r); }}>
                    <Icon name="clock-history" size={12} /><span className="mention-item-label">{r.label}</span>
                  </button>
                ))}
              </div>
            )}
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
              if (showMentions && e.key === "Escape") { e.preventDefault(); setMentionDismissed(input); return; }
              if (showMentions && e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                const first = mentions.thisChat[0] ?? mentions.past[0];
                if (first) selectMention(first);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); }
            }}
            onPaste={onPaste}
            placeholder="Ask, instruct, or drop files & images for context…  (Enter to send, @ to reference)"
            rows={1}
          />
          <div className="composer-toolbar">
            <ModelPicker groups={groups} provider={provider} model={selectedModel} disabled={busy} onPick={pickModel} />
            <button
              className={`composer-tool${(showKeys || autoApprove) ? " on" : ""}`}
              title="Model settings — API keys & auto-approve"
              onClick={() => setShowKeys((v) => !v)}
            >
              <Icon name="three-dots" size={15} />
            </button>
            <span className="composer-spacer" />
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

// ── Run timeline ─────────────────────────────────────────────
function RunView({ runId, runs, onApprove, onReject, onApproveAll, onAllowlist }: { runId: string; runs: Record<string, RunState>; onApprove: (c: string) => void; onReject: (c: string) => void; onApproveAll: (c: string) => void; onAllowlist: (c: string, tool: string) => void }) {
  const run = runs[runId];
  if (!run) return null;
  const isOrch = run.agent === "orchestrator";
  const streaming = run.status === "running";

  const body = (
    <>
      {run.thinking.trim() && <ThinkingBlock text={run.thinking} open={streaming && !run.text} live={streaming && !run.text} />}
      <StepList run={run} runs={runs} onApprove={onApprove} onReject={onReject} onApproveAll={onApproveAll} onAllowlist={onAllowlist} />
      {run.text.trim() && (
        <div className="chat-msg-text">
          <Markdown text={run.text} />
          {streaming && <span className="chat-cursor">{"\u258B"}</span>}
        </div>
      )}
      {run.notices.map((n, i) => <NoticeLine key={i} level={n.level} text={n.text} />)}
      {streaming && <LiveStatus label={currentActivity(run, runs)} />}
    </>
  );

  if (isOrch) {
    return (
      <div className="chat-msg assistant orchestrator">
        <div className="chat-msg-role"><Icon name="robot" size={12} /> Assistant</div>
        <div className="chat-msg-body">{body}</div>
      </div>
    );
  }
  return body; // sub-agents render their own card via SubAgentCard
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

function SubAgentCard({ runId, runs, onApprove, onReject, onApproveAll, onAllowlist }: { runId: string; runs: Record<string, RunState>; onApprove: (c: string) => void; onReject: (c: string) => void; onApproveAll: (c: string) => void; onAllowlist: (c: string, tool: string) => void }) {
  const run = runs[runId];
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
          {run.thinking.trim() && <ThinkingBlock text={run.thinking} open={streaming && !run.text} live={streaming && !run.text} />}
          <StepList run={run} runs={runs} onApprove={onApprove} onReject={onReject} onApproveAll={onApproveAll} onAllowlist={onAllowlist} />
          {run.text.trim() && <div className="subagent-summary"><Markdown text={run.text} />{streaming && <span className="chat-cursor">{"\u258B"}</span>}</div>}
          {run.notices.map((n, i) => <NoticeLine key={i} level={n.level} text={n.text} />)}
          {streaming && <LiveStatus label={currentActivity(run, runs)} />}
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
        Allow <Icon name="chevron-down" size={10} />
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
          <button className="agent-btn-reject" onClick={() => onReject(tool.callId)}>Skip</button>
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
  // Read-only search steps stay as a compact one-liner.
  const argLine = compactArgs(tool);
  const dotClass = tool.status === "error" ? "err" : tool.status === "rejected" ? "rej" : tool.status === "done" ? "ok" : tool.status === "pending" ? "wait" : "run";
  return (
    <div className={`tool-step ${tool.status}`}>
      <div className="tool-step-head">
        <span className={`tool-dot ${dotClass}`} />
        <span className="tool-name">{tool.tool}</span>
        {argLine && <span className="tool-args">{argLine}</span>}
        {tool.summary && <span className={`tool-summary ${tool.status === "error" ? "err" : ""}`}>{tool.summary}</span>}
      </div>
    </div>
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
          <ul className="agent-card-paths">
            {paths.slice(0, 10).map((p, i) => <li key={i} title={p}>{p}</li>)}
            {paths.length > 10 && <li>…and {paths.length - 10} more</li>}
          </ul>
        )}
        {tool.output && <pre className="approval-output">{tool.output}</pre>}
      </div>
      {pending && (
        <div className="approval-card-actions">
          <button className="agent-btn-approve" onClick={() => onApprove(tool.callId)}>Approve</button>
          <button className="agent-btn-reject" onClick={() => onReject(tool.callId)}>Skip</button>
          {canAllow && (
            <>
              <span className="approval-actions-spacer" />
              <AllowMenu callId={tool.callId} tool={tool.tool} label={`Always allow ${tool.tool}`} onAllowlist={onAllowlist} onApproveAll={onApproveAll} />
            </>
          )}
        </div>
      )}
    </div>
  );
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
  if (tool.tool === "edit_file") {
    const oldStr = String(tool.args.old_string ?? "");
    const newStr = String(tool.args.new_string ?? "");
    return (
      <div className="approval-diff">
        <div className="approval-diff-path"><code>{String(tool.args.path ?? "")}</code></div>
        <pre className="approval-diff-block">
          {clip(oldStr).split("\n").map((l, i) => <div key={"o" + i} className="diff-line del">- {l}</div>)}
          {clip(newStr).split("\n").map((l, i) => <div key={"n" + i} className="diff-line add">+ {l}</div>)}
        </pre>
      </div>
    );
  }
  const content = String(tool.args.content ?? "");
  return (
    <div className="approval-diff">
      <div className="approval-diff-path"><code>{String(tool.args.path ?? "")}</code> · new content</div>
      <pre className="approval-diff-block">
        {clip(content).split("\n").map((l, i) => <div key={"n" + i} className="diff-line add">+ {l}</div>)}
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

function ThinkingBlock({ text, open, live }: { text: string; open: boolean; live?: boolean }) {
  return (
    <details className="thinking" open={open}>
      <summary>Thinking{live && <Dots />}</summary>
      <div className="thinking-body">{text}</div>
    </details>
  );
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
      if (t?.status === "running") return `Running ${t.tool}`;
    }
  }
  if (run.text.trim()) return "Writing response";
  if (run.agent === "orchestrator") return "Planning";
  return "Thinking";
}

function LiveStatus({ label }: { label: string }) {
  return (
    <div className="agent-live">
      <span className="ai-spinner" aria-hidden />
      <span>{label}</span>
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
  const needle = q.trim().toLowerCase();
  const filtered = needle ? list.filter((s) => (s.title || "").toLowerCase().includes(needle)) : list;
  const remove = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    deleteChatSession(id);
    setList(loadChatIndex());
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
        {filtered.map((s) => (
          <div
            key={s.id}
            className={`chat-history-item${s.id === sessionId ? " active" : ""}`}
            onClick={() => onOpen(s.id)}
            title={s.title}
          >
            <Icon name="chat" size={13} />
            <div className="chat-history-item-main">
              <span className="chat-history-item-title">{s.title || "New chat"}</span>
              <span className="chat-history-item-meta">{relativeTime(s.ts)} · {s.count} msg{s.count === 1 ? "" : "s"}</span>
            </div>
            {s.id === sessionId && <span className="chat-history-current">current</span>}
            <button className="chat-history-del" title="Delete chat" onClick={(e) => remove(e, s.id)}><Icon name="trash" size={12} /></button>
          </div>
        ))}
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
}): Promise<string> {
  const transcript = opts.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .filter((l) => l.trim().length > 6)
    .join("\n");
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
    })) {
      if (ev.type === "text") out += ev.value;
      else if (ev.type === "error") return "";
    }
  } catch {
    return "";
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

// Custom, fully-themed model dropdown. Replaces a native <select> so the closed
// control hugs its label (no far-away arrow) and the open menu always uses the
// app's dark theme instead of the OS-drawn list.
function ModelPicker({ groups, provider, model, disabled, onPick }: {
  groups: ModelGroup[];
  provider: LlmProvider;
  model: string;
  disabled?: boolean;
  onPick: (provider: LlmProvider, model: string) => void;
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

  const empty = groups.every((g) => g.models.length === 0);
  return (
    <div className="model-picker" ref={ref}>
      <button type="button" className="model-picker-btn" disabled={disabled} onClick={() => setOpen((v) => !v)} title={model || "Select model"}>
        <span className="model-picker-label">{model || "Select model"}</span>
        <Icon name="chevron-down" size={11} />
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
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

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
                <select value={s.transport} onChange={(e) => update(s.id, { transport: e.target.value as "stdio" | "http" })}>
                  <option value="stdio">stdio</option>
                  <option value="http">http</option>
                </select>
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
