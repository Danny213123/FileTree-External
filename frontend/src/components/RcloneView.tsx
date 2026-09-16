// rclone panel, read-only.
//
// Two questions, in this order: what remotes do I have and what do they cost,
// and does this local folder actually exist on one of them? The second is the
// reason the plugin exists, so the coverage answer is a count and a list of the
// biggest files that are not there — not a percentage.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PluginPanelProps } from "../lib/plugins";

type Remote = { name: string; kind: string };
type Entry = { Path: string; Name: string; Size: number; IsDir: boolean; ModTime?: string };
type About = { total?: number; used?: number; free?: number; trashed?: number; unsupported?: boolean; reason?: string };
type Missing = { relative: string; path: string; size: number; differs: boolean };
type Coverage = { localFiles: number; remoteFiles: number; missing: Missing[]; missingCount: number; missingBytes: number };

const SETTINGS_KEY = "filetree.rclone.settings";
type Settings = { exe: string; remote: string; path: string; local: string };
const defaults: Settings = { exe: "", remote: "", path: "", local: "" };

function storedSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<Settings>;
    return { ...defaults, ...Object.fromEntries(Object.entries(saved).filter(([, v]) => typeof v === "string")) };
  } catch { return defaults; }
}

export function formatSize(bytes: number | null | undefined): string {
  if (bytes == null || bytes < 0) return "—";
  const unit = Math.min(4, Math.floor(Math.log2(Math.max(1, bytes)) / 10));
  return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${["B", "KiB", "MiB", "GiB", "TiB"][unit]}`;
}

export function RcloneView(_props: PluginPanelProps) {
  const [settings, setSettings] = useState<Settings>(storedSettings);
  const [remotes, setRemotes] = useState<Remote[]>([]);
  const [about, setAbout] = useState<About | null>(null);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* blocked */ }
  }, [settings]);

  const perform = useCallback(async (label: string, work: () => Promise<void>) => {
    setBusy(label); setError("");
    try { await work(); } catch (reason) { setError(String(reason)); } finally { setBusy(""); }
  }, []);

  const loadRemotes = useCallback(() => void perform("remotes", async () => {
    const value = await invoke<{ remotes: Remote[] }>("rclone_remotes", { exe: settings.exe });
    setRemotes(value.remotes);
  }), [perform, settings.exe]);

  useEffect(() => { loadRemotes(); }, [loadRemotes]);

  const open = (remote: string, path: string) => void perform("list", async () => {
    setSettings((previous) => ({ ...previous, remote, path }));
    setEntries(await invoke<Entry[]>("rclone_list", { exe: settings.exe, remote, path }));
    setAbout(await invoke<About>("rclone_about", { exe: settings.exe, remote }));
  });

  const check = () => void perform("coverage", async () => {
    setCoverage(await invoke<Coverage>("rclone_coverage", {
      exe: settings.exe, remote: settings.remote, path: settings.path, local: settings.local,
    }));
  });

  const up = () => {
    const at = settings.path.replace(/\/+$/, "").lastIndexOf("/");
    open(settings.remote, at > 0 ? settings.path.slice(0, at) : "");
  };

  return <div className="rcl-view">
    <div className="cdl-toolbar">
      <label>rclone<input aria-label="Path to rclone.exe" placeholder="Found automatically when on PATH" value={settings.exe} onChange={(event) => setSettings({ ...settings, exe: event.target.value })} /></label>
      <button disabled={!!busy} onClick={loadRemotes}>{busy === "remotes" ? "Reading…" : "Refresh remotes"}</button>
      <span className="cdl-muted">{remotes.length ? `${remotes.length} remote${remotes.length === 1 ? "" : "s"} configured` : "No remotes yet"}</span>
    </div>

    {error && <div className="cdl-message error" role="alert">{error}</div>}

    <div className="rcl-body">
      <aside className="rcl-remotes" aria-label="Remotes">
        {remotes.map((remote) => <button
          key={remote.name}
          className={`rcl-remote${settings.remote === remote.name ? " active" : ""}`}
          onClick={() => open(remote.name, "")}
        >
          <strong>{remote.name}</strong><span className="cdl-muted">{remote.kind || "remote"}</span>
        </button>)}
      </aside>

      <section className="rcl-main">
        {settings.remote ? <>
          <div className="cdl-toolbar">
            <strong>{settings.remote}:{settings.path}</strong>
            <button disabled={!!busy || !settings.path} onClick={up}>Up</button>
            <span className="spacer" />
            {about && (about.unsupported
              ? <span className="cdl-muted" title={about.reason}>This backend does not report quota</span>
              : <span className="cdl-muted">
                  {formatSize(about.used)} used{about.total ? ` of ${formatSize(about.total)}` : ""}
                  {about.free != null ? ` · ${formatSize(about.free)} free` : ""}
                </span>)}
          </div>

          <ul className="rcl-listing">
            {(entries ?? []).map((entry) => <li key={entry.Path}>
              {entry.IsDir
                ? <button className="rcl-dir" onClick={() => open(settings.remote, settings.path ? `${settings.path}/${entry.Name}` : entry.Name)}>{entry.Name}/</button>
                : <span className="rcl-file">{entry.Name}</span>}
              <span className="rcl-size">{entry.IsDir ? "" : formatSize(entry.Size)}</span>
            </li>)}
            {entries?.length === 0 && <li className="cdl-muted">Empty.</li>}
          </ul>

          <div className="cdl-toolbar rcl-coverage-bar">
            <label>Local folder<input aria-label="Local folder to compare" placeholder="D:\Media" value={settings.local} onChange={(event) => setSettings({ ...settings, local: event.target.value })} /></label>
            <button disabled={!!busy || !settings.local.trim()} onClick={check}>
              {busy === "coverage" ? "Comparing…" : "Is it on this remote?"}
            </button>
            {coverage && <span className={coverage.missingCount ? "rcl-gap" : "rcl-ok"}>
              {coverage.missingCount
                ? `${coverage.missingCount.toLocaleString()} of ${coverage.localFiles.toLocaleString()} files missing · ${formatSize(coverage.missingBytes)}`
                : `All ${coverage.localFiles.toLocaleString()} files are on the remote`}
            </span>}
          </div>

          {coverage && coverage.missing.length > 0 && <ul className="rcl-missing" aria-label="Files not on the remote">
            {coverage.missing.map((item) => <li key={item.relative}>
              <span className="rcl-file" title={item.path}>{item.relative}</span>
              <span className="cdl-muted">{item.differs ? "different size" : "not there"}</span>
              <span className="rcl-size">{formatSize(item.size)}</span>
            </li>)}
          </ul>}
        </> : <div className="cdl-empty">
          Pick a remote to see what it holds, then point it at a local folder to find
          out which files have no copy there. This panel only reads: no copy, sync or
          delete is run from here.
        </div>}
      </section>
    </div>
  </div>;
}
