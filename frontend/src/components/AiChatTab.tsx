import { useState, useEffect, useRef, useCallback } from "react";
import { fetchAiModels, streamAiChat } from "../api/client";
import type { NodeRecord } from "../api/types";

interface AiChatTabProps {
  scanPath: string;
  nodeById: Map<number, NodeRecord>;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
}

function buildContext(scanPath: string, nodeById: Map<number, NodeRecord>): string {
  const root = nodeById.get(0);
  if (!root) return `Analyzing: ${scanPath}`;

  const children = (root.children ?? [])
    .map((id) => nodeById.get(id))
    .filter(Boolean) as NodeRecord[];
  children.sort((a, b) => b.size - a.size);
  const top = children.slice(0, 15);

  const fmt = (bytes: number) => {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
    return `${(bytes / 1e3).toFixed(0)} KB`;
  };

  const lines = [
    `Disk usage scan of: ${scanPath}`,
    `Total size: ${fmt(root.size)}, Files: ${root.files}, Folders: ${root.folders}`,
    `Top items by size:`,
    ...top.map((n) => `  ${n.dir ? "DIR" : "FILE"} ${n.name} — ${fmt(n.size)}`),
  ];
  return lines.join("\n");
}

export function AiChatTab({ scanPath, nodeById }: AiChatTabProps) {
  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [ollamaStatus, setOllamaStatus] = useState<"unknown" | "ok" | "offline">("unknown");
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchAiModels().then((list) => {
      setModels(list);
      if (list.length > 0) {
        setSelectedModel(list[0]);
        setOllamaStatus("ok");
      } else {
        setOllamaStatus("offline");
      }
    }).catch(() => setOllamaStatus("offline"));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming || !selectedModel) return;
    setInput("");

    const context = buildContext(scanPath, nodeById);
    const userMsg: Message = { role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);

    const assistantMsg: Message = { role: "assistant", content: "", streaming: true };
    setMessages((prev) => [...prev, assistantMsg]);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    const systemMsg = { role: "system", content: `You are a disk cleanup assistant. Here is the current scan data:\n\n${context}\n\nAnswer concisely and helpfully.` };
    const history = [...messages, userMsg].map(({ role, content }) => ({ role, content }));

    try {
      for await (const chunk of streamAiChat(selectedModel, [systemMsg, ...history], controller.signal)) {
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.streaming) {
            next[next.length - 1] = { ...last, content: last.content + chunk };
          }
          return next;
        });
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.streaming) {
            next[next.length - 1] = { ...last, content: "Error: " + (err as Error).message, streaming: false };
          }
          return next;
        });
      }
    } finally {
      setMessages((prev) => prev.map((m) => m.streaming ? { ...m, streaming: false } : m));
      setStreaming(false);
      abortRef.current = null;
    }
  }, [input, streaming, selectedModel, messages, scanPath, nodeById]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  if (ollamaStatus === "offline") {
    return (
      <div className="ai-offline">
        <div className="ai-offline-icon">🤖</div>
        <strong>Ollama not running</strong>
        <p>Start Ollama and pull a model to use the AI assistant.</p>
        <code>ollama serve</code>
        <code>ollama pull llama3.2</code>
        <button onClick={() => {
          setOllamaStatus("unknown");
          fetchAiModels().then((list) => {
            setModels(list);
            if (list.length > 0) { setSelectedModel(list[0]); setOllamaStatus("ok"); }
            else setOllamaStatus("offline");
          }).catch(() => setOllamaStatus("offline"));
        }}>Retry</button>
      </div>
    );
  }

  return (
    <div className="ai-chat-tab">
      <div className="ai-chat-toolbar">
        <select
          className="ai-model-select"
          value={selectedModel}
          onChange={(e) => setSelectedModel(e.target.value)}
          disabled={streaming}
        >
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <button
          className="ai-clear-btn"
          onClick={() => setMessages([])}
          disabled={streaming}
          title="Clear chat"
        >Clear</button>
        {streaming && (
          <button className="ai-stop-btn" onClick={() => abortRef.current?.abort()} title="Stop">
            ⏹
          </button>
        )}
      </div>

      <div className="ai-messages">
        {messages.length === 0 && (
          <div className="ai-welcome">
            <div className="ai-welcome-icon">🤖</div>
            <p>Ask me anything about the scanned folder.</p>
            <div className="ai-suggestions">
              {["What's using the most space?", "What can I safely delete?", "Show me duplicate-heavy folders"].map((s) => (
                <button key={s} className="ai-suggestion" onClick={() => { setInput(s); }}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((msg, idx) => (
          <div key={idx} className={`ai-message ai-${msg.role}`}>
            <div className="ai-bubble">
              {msg.content}
              {msg.streaming && <span className="ai-cursor">▋</span>}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="ai-input-row">
        <textarea
          className="ai-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about this folder… (Enter to send)"
          disabled={streaming || !selectedModel}
          rows={2}
        />
        <button
          className="ai-send-btn"
          onClick={sendMessage}
          disabled={!input.trim() || streaming || !selectedModel}
        >Send</button>
      </div>
    </div>
  );
}
