// Media insight: what the video in a folder actually is, and what it wastes.
//
// The ranking is the product. A list of big files is what the scan already
// shows; this ranks by the bytes a re-encode would plausibly save, so the rows
// at the top are the ones worth queueing.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PluginPanelProps } from "../lib/plugins";

type Media = {
  path: string; name: string; size: number; duration: number | null; bitrate: number | null;
  videoCodec: string | null; audioCodec: string | null; width: number | null; height: number | null;
  targetBitrate: number | null; savings: number; error: string | null;
};
type Probe = { files: Media[]; probed: number; found: number; reclaimable: number; ffprobe: string };

const SETTINGS_KEY = "filetree.media.settings";
type Settings = { folder: string; limit: number; exe: string; preset: string };
const defaults: Settings = { folder: "", limit: 100, exe: "", preset: "balanced" };
const PRESETS = [["max", "Maximum savings"], ["more", "More savings"], ["balanced", "Balanced"], ["high", "High quality"]] as const;

function storedSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<Settings>;
    return {
      folder: typeof saved.folder === "string" ? saved.folder : defaults.folder,
      limit: Number.isFinite(saved.limit) ? Number(saved.limit) : defaults.limit,
      exe: typeof saved.exe === "string" ? saved.exe : defaults.exe,
      preset: PRESETS.some(([id]) => id === saved.preset) ? saved.preset! : defaults.preset,
    };
  } catch { return defaults; }
}

export function formatSize(bytes: number | null): string {
  if (bytes == null) return "—";
  const unit = Math.min(4, Math.floor(Math.log2(Math.max(1, bytes)) / 10));
  return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${["B", "KiB", "MiB", "GiB", "TiB"][unit]}`;
}

/** Mbit/s, the unit people actually compare video in. */
export function formatBitrate(bits: number | null): string {
  return bits == null ? "—" : `${(bits / 1_000_000).toFixed(1)} Mb/s`;
}

export function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  const total = Math.round(seconds);
  const parts = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  return parts[0]
    ? `${parts[0]}:${String(parts[1]).padStart(2, "0")}:${String(parts[2]).padStart(2, "0")}`
    : `${parts[1]}:${String(parts[2]).padStart(2, "0")}`;
}

/** "1080p", or the raw height when it is not a familiar one. */
export function formatResolution(media: Media): string {
  if (!media.height) return "—";
  return [2160, 1440, 1080, 720, 480].includes(media.height) ? `${media.height}p` : `${media.width ?? "?"}×${media.height}`;
}

let session: { probe: Probe | null } = { probe: null };
/** Testing seam: drops the results kept across visits. */
export function resetProbeSession(): void { session = { probe: null }; }

export function MediaInsightView(_props: PluginPanelProps) {
  const [settings, setSettings] = useState<Settings>(storedSettings);
  const [probe, setProbe] = useState<Probe | null>(session.probe);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const files = probe?.files ?? [];
  const worthwhile = files.filter((file) => file.savings > 0);

  useEffect(() => { session = { probe }; }, [probe]);
  useEffect(() => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* blocked */ }
  }, [settings]);

  const run = () => {
    setBusy(true); setError(""); setMessage("");
    invoke<Probe>("media_probe", { folder: settings.folder, limit: settings.limit, exe: settings.exe })
      .then((value) => {
        setProbe(value);
        setSelected(new Set(value.files.filter((file) => file.savings > 0).map((file) => file.path)));
      })
      .catch((reason) => { setError(String(reason)); setProbe(null); })
      .finally(() => setBusy(false));
  };

  const toggle = (path: string) => setSelected((previous) => {
    const next = new Set(previous);
    if (!next.delete(path)) next.add(path);
    return next;
  });

  const queue = () => {
    const paths = files.filter((file) => selected.has(file.path)).map((file) => file.path);
    if (!paths.length) return;
    setBusy(true); setError(""); setMessage("");
    invoke("compression_start", { request: { paths, preset: settings.preset } })
      .then(() => setMessage(`Queued ${paths.length} file${paths.length === 1 ? "" : "s"}. Watch them on Compress → Monitor.`))
      .catch((reason) => setError(String(reason)))
      .finally(() => setBusy(false));
  };

  const selectedSavings = files
    .filter((file) => selected.has(file.path))
    .reduce((total, file) => total + file.savings, 0);

  return <div className="mdi-view">
    <form className="cdl-toolbar" onSubmit={(event) => { event.preventDefault(); run(); }}>
      <label>Folder<input aria-label="Folder to probe" placeholder="D:\Media\Videos" value={settings.folder} onChange={(event) => setSettings({ ...settings, folder: event.target.value })} /></label>
      <label>Largest<input aria-label="How many files" type="number" min={1} max={500} value={settings.limit} onChange={(event) => setSettings({ ...settings, limit: Number(event.target.value) })} /></label>
      <button type="submit" disabled={busy || !settings.folder.trim()}>{busy ? "Probing…" : "Probe media"}</button>
      {probe && <span className="cdl-muted">
        Probed {probe.probed} of {probe.found} media files · <strong>{formatSize(probe.reclaimable)}</strong> reclaimable
      </span>}
    </form>

    {error && <div className="cdl-message error" role="alert">{error}</div>}
    {message && <div className="cdl-message" role="status">{message}</div>}

    {files.length > 0 && <>
      <div className="cdl-toolbar">
        <button onClick={() => setSelected(selected.size ? new Set() : new Set(worthwhile.map((file) => file.path)))}>
          {selected.size ? "Clear selection" : "Select every candidate"}
        </button>
        <span className="cdl-muted">{selected.size} selected · {formatSize(selectedSavings)} estimated saving</span>
        <span className="spacer" />
        <label>Preset<select aria-label="Compression preset" value={settings.preset} onChange={(event) => setSettings({ ...settings, preset: event.target.value })}>
          {PRESETS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select></label>
        <button disabled={busy || !selected.size} onClick={queue}>Send to Compress</button>
      </div>

      <div className="mdi-table" role="table" aria-label="Media files">
        <div className="mdi-row mdi-head" role="row">
          <span role="columnheader" />
          <span role="columnheader">File</span>
          <span role="columnheader">Size</span>
          <span role="columnheader">Length</span>
          <span role="columnheader">Video</span>
          <span role="columnheader">Bitrate</span>
          <span role="columnheader">Target</span>
          <span role="columnheader">Could save</span>
        </div>
        {files.map((file) => <div key={file.path} className={`mdi-row${file.savings > 0 ? " candidate" : ""}`} role="row">
          <input type="checkbox" aria-label={file.name} checked={selected.has(file.path)} onChange={() => toggle(file.path)} />
          <span role="cell" className="mdi-name" title={file.error ?? file.path}>{file.name}{file.error && <span className="mdi-error"> · unreadable</span>}</span>
          <span role="cell" className="mdi-num">{formatSize(file.size)}</span>
          <span role="cell" className="mdi-num">{formatDuration(file.duration)}</span>
          <span role="cell">{file.videoCodec ?? "—"} {formatResolution(file)}</span>
          <span role="cell" className="mdi-num">{formatBitrate(file.bitrate)}</span>
          <span role="cell" className="mdi-num cdl-muted">{formatBitrate(file.targetBitrate)}</span>
          <span role="cell" className="mdi-num mdi-savings">{file.savings ? formatSize(file.savings) : "—"}</span>
        </div>)}
      </div>
    </>}

    {!files.length && !busy && <div className="cdl-empty">
      Point this at a folder of video and it reads each file with ffprobe, then ranks
      them by the bytes a re-encode would plausibly save at a sane bitrate for the
      resolution. Tick the ones you want and send them to the compression queue.
    </div>}
  </div>;
}
