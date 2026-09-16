// restic panel, read-only.
//
// The password is held in component state for as long as the panel is open and
// is never written to localStorage: it is the key to the whole repository, and
// a disk-usage tool has no business persisting it. Everything else — the
// repository location and the exe path — is remembered.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PluginPanelProps } from "../lib/plugins";

type Snapshot = { id: string; time: string; hostname: string; paths: string[]; tags: string[] };
type Stats = { total_size?: number; total_file_count?: number; snapshots_count?: number };
type Coverage = { covered: boolean; snapshots: Snapshot[]; latest: string | null; total: number };

const SETTINGS_KEY = "filetree.restic.settings";
type Settings = { exe: string; repo: string; folder: string };
const defaults: Settings = { exe: "", repo: "", folder: "" };

function storedSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<Settings>;
    return { ...defaults, ...Object.fromEntries(Object.entries(saved).filter(([, v]) => typeof v === "string")) };
  } catch { return defaults; }
}

export function formatSize(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  const unit = Math.min(4, Math.floor(Math.log2(Math.max(1, bytes)) / 10));
  return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${["B", "KiB", "MiB", "GiB", "TiB"][unit]}`;
}

export function formatWhen(time: string): string {
  const at = new Date(time);
  return Number.isNaN(at.getTime()) ? time : at.toLocaleString();
}

export function ResticView(_props: PluginPanelProps) {
  const [settings, setSettings] = useState<Settings>(storedSettings);
  const [password, setPassword] = useState("");
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
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

  const args = { exe: settings.exe, repo: settings.repo, password };

  const open = () => void perform("open", async () => {
    const value = await invoke<{ snapshots: Snapshot[] }>("restic_snapshots", args);
    setSnapshots(value.snapshots);
    setStats(await invoke<Stats>("restic_stats", args).catch(() => null));
  });

  const check = () => void perform("coverage", async () => {
    setCoverage(await invoke<Coverage>("restic_coverage", { ...args, folder: settings.folder }));
  });

  return <div className="rst-view">
    <form className="cdl-toolbar" onSubmit={(event) => { event.preventDefault(); open(); }}>
      <label>restic<input aria-label="Path to restic.exe" placeholder="Found automatically when on PATH" value={settings.exe} onChange={(event) => setSettings({ ...settings, exe: event.target.value })} /></label>
      <label>Repository<input aria-label="Repository" placeholder="E:\restic-repo or s3:…" value={settings.repo} onChange={(event) => setSettings({ ...settings, repo: event.target.value })} /></label>
      <label>Password<input aria-label="Repository password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <button type="submit" disabled={!!busy || !settings.repo.trim()}>{busy === "open" ? "Reading…" : "Open repository"}</button>
    </form>
    <div className="cdl-toolbar cdl-muted">
      The password is kept only while this panel is open, and is passed straight to restic.
      {stats && <> · Repository holds <strong>{formatSize(stats.total_size)}</strong>{stats.total_file_count ? ` across ${stats.total_file_count.toLocaleString()} files` : ""}.</>}
    </div>

    {error && <div className="cdl-message error" role="alert">{error}</div>}

    {snapshots && <>
      <div className="cdl-toolbar rst-coverage-bar">
        <label>Folder<input aria-label="Folder to check" placeholder="D:\Media" value={settings.folder} onChange={(event) => setSettings({ ...settings, folder: event.target.value })} /></label>
        <button disabled={!!busy || !settings.folder.trim()} onClick={check}>
          {busy === "coverage" ? "Checking…" : "Is this folder backed up?"}
        </button>
        {coverage && <span className={coverage.covered ? "rst-ok" : "rst-gap"}>
          {coverage.covered
            ? `Covered by ${coverage.snapshots.length} snapshot${coverage.snapshots.length === 1 ? "" : "s"}${coverage.latest ? `, latest ${formatWhen(coverage.latest)}` : ""}`
            : `No snapshot covers this folder (${coverage.total} in the repository)`}
        </span>}
      </div>

      <div className="rst-snapshots" role="table" aria-label="Snapshots">
        <div className="rst-row rst-head" role="row">
          <span role="columnheader">Snapshot</span>
          <span role="columnheader">Taken</span>
          <span role="columnheader">Host</span>
          <span role="columnheader">Paths</span>
        </div>
        {snapshots.map((snapshot) => <div key={snapshot.id} className="rst-row" role="row">
          <span role="cell" className="rst-id">{snapshot.id}</span>
          <span role="cell">{formatWhen(snapshot.time)}</span>
          <span role="cell" className="cdl-muted">{snapshot.hostname}</span>
          <span role="cell" className="rst-paths" title={snapshot.paths.join("\n")}>
            {snapshot.paths.join(", ")}
            {snapshot.tags.map((tag) => <span key={tag} className="rst-tag">{tag}</span>)}
          </span>
        </div>)}
        {snapshots.length === 0 && <div className="cdl-empty">The repository has no snapshots yet.</div>}
      </div>
    </>}

    {!snapshots && !error && <div className="cdl-empty">
      Point this at a restic repository to see its snapshots and what it costs, then
      ask whether a folder is covered by any of them. This panel only reads: no backup,
      forget or prune is run from here.
    </div>}
  </div>;
}
