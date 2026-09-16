// Everything search panel: type, get filenames from the whole machine.
//
// The point of this plugin is speed on drives FileTree has never scanned, so
// the panel searches as you type (debounced) rather than behind a button, and
// keeps its results when you leave the page.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath, revealPath } from "../api/client";
import type { PluginPanelProps } from "../lib/plugins";

type Hit = { name: string; path: string; size: number | null; modified: number | null; isDir: boolean };
type Results = { results: Hit[]; total: number; source: "es" | "http" };
type Status = { es: string | null; http: boolean; ready: boolean };
type Settings = { esPath: string; host: string; port: number; prefer: "auto" | "http"; limit: number };

const SETTINGS_KEY = "filetree.everything.settings";
const defaults: Settings = { esPath: "", host: "127.0.0.1", port: 80, prefer: "auto", limit: 200 };

function storedSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<Settings>;
    return {
      esPath: typeof saved.esPath === "string" ? saved.esPath : defaults.esPath,
      host: typeof saved.host === "string" && saved.host ? saved.host : defaults.host,
      port: Number.isFinite(saved.port) ? Number(saved.port) : defaults.port,
      prefer: saved.prefer === "http" ? "http" : "auto",
      limit: Number.isFinite(saved.limit) ? Number(saved.limit) : defaults.limit,
    };
  } catch { return defaults; }
}

export function formatSize(bytes: number | null): string {
  if (bytes == null) return "";
  const unit = Math.min(4, Math.floor(Math.log2(Math.max(1, bytes)) / 10));
  return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${["B", "KiB", "MiB", "GiB", "TiB"][unit]}`;
}

export function formatDate(seconds: number | null): string {
  return seconds == null ? "" : new Date(seconds * 1000).toLocaleDateString();
}

/** The folder a hit lives in, for "reveal" and for the second column. */
export function parentOf(path: string): string {
  const at = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return at > 2 ? path.slice(0, at) : path.slice(0, 3);
}

// Kept across visits to the Plugins page.
let session: { query: string; results: Results | null } = { query: "", results: null };

/** Testing seam: drops the results kept across visits. */
export function resetSearchSession(): void {
  session = { query: "", results: null };
}

export function EverythingView(_props: PluginPanelProps) {
  const [settings, setSettings] = useState<Settings>(storedSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [query, setQuery] = useState(session.query);
  const [results, setResults] = useState<Results | null>(session.results);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hits = results?.results ?? [];

  useEffect(() => { session = { query, results }; }, [query, results]);
  useEffect(() => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* blocked */ }
  }, [settings]);

  const checkStatus = useCallback(() => {
    invoke<Status>("everything_status", { esPath: settings.esPath, host: settings.host, port: settings.port })
      .then(setStatus)
      .catch(() => setStatus({ es: null, http: false, ready: false }));
  }, [settings.esPath, settings.host, settings.port]);

  useEffect(() => { checkStatus(); }, [checkStatus]);

  const search = useCallback((text: string) => {
    if (!text.trim()) { setResults(null); setError(""); return; }
    setBusy(true);
    invoke<Results>("everything_search", {
      query: text, limit: settings.limit, esPath: settings.esPath,
      host: settings.host, port: settings.port, prefer: settings.prefer,
    })
      .then((value) => { setResults(value); setError(""); })
      .catch((reason) => { setError(String(reason)); setResults(null); })
      .finally(() => setBusy(false));
  }, [settings]);

  // Everything answers in milliseconds; the wait here is only to avoid a query
  // per keystroke while someone is still typing a word.
  const onType = (text: string) => {
    setQuery(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => search(text), 250);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  return <div className="evr-view">
    <div className="cdl-toolbar">
      <input
        className="evr-query"
        aria-label="Search every drive"
        placeholder="Filename, or an Everything query like *.mp4 size:>1gb"
        value={query}
        onChange={(event) => onType(event.target.value)}
      />
      <span className="cdl-muted">
        {busy ? "Searching…"
          : results ? `${results.total.toLocaleString()} match${results.total === 1 ? "" : "es"}${results.total > hits.length ? ` · showing ${hits.length}` : ""}`
          : status?.ready ? `Ready via ${status.es ? "es.exe" : "HTTP"}` : "Everything not reachable"}
      </span>
      <span className="spacer" />
      <button onClick={() => { checkStatus(); setShowSettings((open) => !open); }}>Settings</button>
    </div>

    {showSettings && <div className="cdl-toolbar evr-settings">
      <label>es.exe<input aria-label="Path to es.exe" placeholder="Found automatically when installed" value={settings.esPath} onChange={(event) => setSettings({ ...settings, esPath: event.target.value })} /></label>
      <label>HTTP host<input aria-label="HTTP server host" value={settings.host} onChange={(event) => setSettings({ ...settings, host: event.target.value })} /></label>
      <label>Port<input aria-label="HTTP server port" type="number" min={1} max={65535} value={settings.port} onChange={(event) => setSettings({ ...settings, port: Number(event.target.value) })} /></label>
      <label>Prefer<select aria-label="Preferred source" value={settings.prefer} onChange={(event) => setSettings({ ...settings, prefer: event.target.value as Settings["prefer"] })}>
        <option value="auto">es.exe, then HTTP</option>
        <option value="http">HTTP server</option>
      </select></label>
      <label>Results<input aria-label="Result limit" type="number" min={1} max={5000} value={settings.limit} onChange={(event) => setSettings({ ...settings, limit: Number(event.target.value) })} /></label>
      <span className="cdl-muted">{status?.es ? `es.exe: ${status.es}` : "es.exe: not found"} · HTTP server: {status?.http ? "answering" : "no answer"}</span>
    </div>}

    {error && <div className="cdl-message error" role="alert">{error}</div>}

    {hits.length > 0 && <div className="evr-results" role="table" aria-label="Search results">
      <div className="evr-row evr-head" role="row">
        <span role="columnheader">Name</span>
        <span role="columnheader">Folder</span>
        <span role="columnheader">Size</span>
        <span role="columnheader">Modified</span>
      </div>
      {hits.map((hit) => <div
        key={hit.path}
        className="evr-row"
        role="row"
        tabIndex={0}
        title={hit.path}
        onDoubleClick={() => void openPath(hit.path).catch((reason) => setError(String(reason)))}
        onKeyDown={(event) => { if (event.key === "Enter") void openPath(hit.path).catch((reason) => setError(String(reason))); }}
      >
        <span role="cell" className="evr-name">{hit.name}</span>
        <span role="cell" className="evr-folder">{parentOf(hit.path)}</span>
        <span role="cell" className="evr-size">{formatSize(hit.size)}</span>
        <span role="cell" className="evr-date">{formatDate(hit.modified)}</span>
        <button className="evr-reveal" title="Show in Explorer" onClick={() => void revealPath(hit.path).catch((reason) => setError(String(reason)))}>Reveal</button>
      </div>)}
    </div>}

    {!hits.length && !busy && <div className="cdl-empty">
      {!status?.ready
        ? "Everything is not reachable yet. Install voidtools' \"ES\" command-line tool, or turn on Everything's HTTP server under Tools → Options → HTTP Server, then open Settings above."
        : query.trim() ? "No matches." : "Type to search every indexed drive, including ones FileTree has never scanned."}
    </div>}
  </div>;
}
