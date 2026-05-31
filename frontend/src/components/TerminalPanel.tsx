import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Icon } from "./Icon";

// ── Electron bridge (terminal slice) ──────────────────────────────────────────
interface TerminalAPI {
  profiles: () => Promise<{ id: string; label: string }[]>;
  spawn: (profileId: string, cwd: string, cols: number, rows: number) => Promise<{ id: number; title: string }>;
  write: (id: number, data: string) => void;
  resize: (id: number, cols: number, rows: number) => void;
  kill: (id: number) => void;
  onData: (cb: (id: number, data: Uint8Array) => void) => () => void;
  onExit: (cb: (id: number, code: number) => void) => () => void;
}

function getTerminalAPI(): TerminalAPI | null {
  return (window as unknown as { electronAPI?: { terminal?: TerminalAPI } }).electronAPI?.terminal ?? null;
}

interface TermEntry {
  term: Terminal;
  fit: FitAddon;
  ptyId: number | null;
  dead: boolean;
}

interface Session {
  localId: number;
  profileId: string;
  cwd: string;
  title: string;
}

interface TerminalProfile { id: string; label: string; }

interface TerminalPanelProps {
  open: boolean;
  height: number;
  /** Folder for the next terminal spawned by a request from the toolbar. */
  requestCwd: string;
  /** Bumped each time the user asks to open a terminal; triggers a new session. */
  requestNonce: number;
  darkMode: boolean;
  onClose: () => void;
}

function xtermTheme(dark: boolean) {
  return dark
    ? { background: "#1e1e1e", foreground: "#cccccc", cursor: "#cccccc", selectionBackground: "#264f78" }
    : { background: "#ffffff", foreground: "#333333", cursor: "#333333", selectionBackground: "#add6ff" };
}

const FONT_FAMILY = 'Cascadia Code, Consolas, "Courier New", monospace';

let nextLocalId = 1;

export function TerminalPanel({
  open, height, requestCwd, requestNonce, darkMode, onClose,
}: TerminalPanelProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [profiles, setProfiles] = useState<TerminalProfile[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);

  const terms = useRef(new Map<number, TermEntry>());
  const containers = useRef(new Map<number, HTMLDivElement | null>());
  const initializing = useRef(new Set<number>());
  const bodyRef = useRef<HTMLDivElement>(null);
  const lastNonce = useRef(0);
  const activeIdRef = useRef<number | null>(null);
  activeIdRef.current = activeId;

  const defaultProfileId = profiles[0]?.id ?? "powershell";

  // Load launch profiles once.
  useEffect(() => {
    getTerminalAPI()?.profiles().then(setProfiles).catch(() => {});
  }, []);

  const findByPty = useCallback((ptyId: number): TermEntry | undefined => {
    for (const e of terms.current.values()) if (e.ptyId === ptyId) return e;
    return undefined;
  }, []);

  // Route PTY output / exit to the matching xterm.
  useEffect(() => {
    const api = getTerminalAPI();
    if (!api) return;
    const offData = api.onData((id, data) => {
      findByPty(id)?.term.write(data);
    });
    const offExit = api.onExit((id) => {
      const entry = findByPty(id);
      if (entry) {
        entry.dead = true;
        entry.ptyId = null;
        entry.term.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n");
      }
    });
    return () => { offData(); offExit(); };
  }, [findByPty]);

  const addSession = useCallback((cwd: string, profileId: string) => {
    const localId = nextLocalId++;
    const label = profiles.find((p) => p.id === profileId)?.label ?? "Terminal";
    setSessions((prev) => [...prev, { localId, profileId, cwd, title: label }]);
    setActiveId(localId);
  }, [profiles]);

  // Spawn a real shell once the session's container is in the DOM.
  useEffect(() => {
    const api = getTerminalAPI();
    if (!api) return;
    for (const s of sessions) {
      if (terms.current.has(s.localId) || initializing.current.has(s.localId)) continue;
      const container = containers.current.get(s.localId);
      if (!container) continue;
      initializing.current.add(s.localId);

      const term = new Terminal({
        fontFamily: FONT_FAMILY,
        fontSize: 13,
        cursorBlink: true,
        theme: xtermTheme(darkMode),
        scrollback: 5000,
        allowProposedApi: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(container);
      try { fit.fit(); } catch { /* not laid out yet */ }

      const entry: TermEntry = { term, fit, ptyId: null, dead: false };
      terms.current.set(s.localId, entry);

      const cols = term.cols || 80;
      const rows = term.rows || 24;
      api.spawn(s.profileId, s.cwd, cols, rows).then(({ id }) => {
        entry.ptyId = id;
        term.onData((d) => { if (entry.ptyId != null) api.write(entry.ptyId, d); });
        term.onResize(({ cols, rows }) => { if (entry.ptyId != null) api.resize(entry.ptyId, cols, rows); });
        // A second fit after layout settles ensures the pty matches the view.
        requestAnimationFrame(() => { try { fit.fit(); } catch { /* ignore */ } });
      }).catch((err) => {
        term.write(`\r\n\x1b[31mFailed to start terminal: ${String(err)}\x1b[0m\r\n`);
        entry.dead = true;
      }).finally(() => {
        initializing.current.delete(s.localId);
      });
    }
  }, [sessions, darkMode]);

  // Honor open-terminal requests from the toolbar.
  useEffect(() => {
    if (requestNonce === lastNonce.current || requestNonce === 0) return;
    lastNonce.current = requestNonce;
    addSession(requestCwd, defaultProfileId);
  }, [requestNonce, requestCwd, defaultProfileId, addSession]);

  // Keep the active terminal fitted when shown / resized / panel toggled.
  const fitActive = useCallback(() => {
    const id = activeIdRef.current;
    if (id == null) return;
    const entry = terms.current.get(id);
    if (!entry) return;
    try { entry.fit.fit(); } catch { /* ignore */ }
    entry.term.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const r = requestAnimationFrame(fitActive);
    return () => cancelAnimationFrame(r);
  }, [open, activeId, height, fitActive]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const ro = new ResizeObserver(() => { if (open) fitActive(); });
    ro.observe(body);
    return () => ro.disconnect();
  }, [open, fitActive]);

  // Recolor every terminal when the theme flips.
  useEffect(() => {
    const theme = xtermTheme(darkMode);
    for (const e of terms.current.values()) e.term.options.theme = theme;
  }, [darkMode]);

  const closeSession = useCallback((localId: number) => {
    const entry = terms.current.get(localId);
    if (entry) {
      if (entry.ptyId != null) getTerminalAPI()?.kill(entry.ptyId);
      entry.term.dispose();
      terms.current.delete(localId);
    }
    containers.current.delete(localId);
    setSessions((prev) => {
      const next = prev.filter((s) => s.localId !== localId);
      setActiveId((cur) => {
        if (cur !== localId) return cur;
        return next.length ? next[next.length - 1].localId : null;
      });
      return next;
    });
  }, []);

  // Kill everything on unmount.
  useEffect(() => {
    const map = terms.current;
    return () => {
      const api = getTerminalAPI();
      for (const e of map.values()) {
        if (e.ptyId != null) api?.kill(e.ptyId);
        e.term.dispose();
      }
      map.clear();
    };
  }, []);

  const newTerminal = useCallback((profileId?: string) => {
    setMenuOpen(false);
    addSession(requestCwd, profileId ?? defaultProfileId);
  }, [addSession, requestCwd, defaultProfileId]);

  return (
    <div
      className="terminal-panel"
      style={{ height: open ? height : 0, display: open ? "flex" : "none", flex: open ? `0 0 ${height}px` : "0 0 0" }}
    >
      <div className="terminal-tabs">
        {sessions.map((s) => (
          <div
            key={s.localId}
            className={`terminal-tab${s.localId === activeId ? " active" : ""}`}
            onClick={() => setActiveId(s.localId)}
            title={s.title}
          >
            <Icon name="window-stack" size={12} />
            <span className="t">{s.title}</span>
            <button
              className="terminal-tab-close"
              title="Kill terminal"
              onClick={(e) => { e.stopPropagation(); closeSession(s.localId); }}
            >
              <Icon name="x" size={11} />
            </button>
          </div>
        ))}
        <div className="terminal-newgroup">
          <button className="terminal-new" title="New terminal" onClick={() => newTerminal()}>
            <Icon name="plus" size={13} />
          </button>
          <button
            className="terminal-new caret"
            title="Select shell"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <Icon name="chevron-down" size={11} />
          </button>
          {menuOpen && (
            <div className="terminal-profile-menu" onMouseLeave={() => setMenuOpen(false)}>
              {profiles.map((p) => (
                <div key={p.id} className="terminal-profile-item" onClick={() => newTerminal(p.id)}>
                  {p.label}
                </div>
              ))}
            </div>
          )}
        </div>
        <span className="spacer" />
        <button className="icon terminal-panel-close" title="Close panel" onClick={onClose}>
          <Icon name="chevron-down" size={13} />
        </button>
      </div>
      <div className="terminal-body" ref={bodyRef}>
        {sessions.length === 0 && (
          <div className="terminal-empty">No terminals. Click + to start one.</div>
        )}
        {sessions.map((s) => (
          <div
            key={s.localId}
            className="terminal-surface"
            style={{ display: s.localId === activeId ? "block" : "none" }}
            ref={(el) => { containers.current.set(s.localId, el); }}
          />
        ))}
      </div>
    </div>
  );
}
