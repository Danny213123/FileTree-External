import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CyberdropSummary, CyberdropCompression, type DashboardData } from "./CyberdropDashboard";
import { promptDialog } from "../lib/dialogs";
import { openPath } from "../api/client";
import { loadCompressionExclusions } from "../lib/compressionExclusions";
import type { PluginPanelProps } from "../lib/plugins";
type Document = { text: string; settings: Record<string, unknown>; folder: string; validationError?: string };
type Workspace = { folder: string; name: string; text: string; stations: { id: string; label: string; opened: number; edited: number }[]; revisions: string[]; loaded: { id: string } | null; activeText: string; compressionMode: string; sideload?: { preset: string; originalAction: string } };
type Transfer = { description: string; domain: string; size: number | null; completed: number; bytes_downloaded: number; speed: number | null; eta: number | null; hls: boolean };
type Monitor = { status: string; logs: string[]; started: number; progress?: DashboardData & { files: Transfer[]; active: number; bytes: number; speed: number } | null };
function bytes(value: number) { const unit = Math.min(4, Math.floor(Math.log2(Math.max(1, value)) / 10)); return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${["B", "KiB", "MiB", "GiB", "TiB"][unit]}`; }
function eta(value: number | null) { return value == null ? "Estimating" : value < 60 ? `${Math.ceil(value)}s` : `${Math.floor(value / 60)}m ${Math.ceil(value % 60)}s`; }
const initialRepo = "C:\\Tools\\CyberDropDownloader";
type FieldDef = readonly [path: string, label: string, type: "text" | "number" | "checkbox" | "select", fallback: string | number | boolean, extra?: { min?: number; max?: number; options?: readonly (readonly [string, string])[] }];
const fields: FieldDef[] = [
  ["download_folder", "Download folder", "text", "downloads/cyberdrop-dl"],
  ["downloads.concurrency", "Concurrent downloads", "number", 15],
  ["downloads.concurrency_per_domain", "Downloads per host", "number", 5],
  ["downloads.attempts", "Retry attempts", "number", 2],
  ["downloads.speed_limit", "Speed limit (0B = unlimited)", "text", "0B"],
  ["deep_scrape", "Deep scraping", "checkbox", false],
  ["ignore_history", "Download files already in history", "checkbox", false],
  ["filters.files.images", "Download images", "checkbox", true],
  ["filters.files.videos", "Download videos", "checkbox", true],
  ["filters.files.audio", "Download audio", "checkbox", true],
];
// cyberdrop-dl `compression_options` with its model defaults. `enabled` is
// owned by the Compression mode picker.
const compressionFields: FieldDef[] = [
  ["compression_options.compress_videos", "Compress videos", "checkbox", true],
  ["compression_options.compress_images", "Compress images", "checkbox", true],
  ["compression_options.video_backend", "Video backend", "select", "pynv", { options: [["pynv", "PyNvVideoCodec"], ["handbrake", "HandBrakeCLI"]] }],
  ["compression_options.video_codec", "Video codec", "select", "hevc", { options: [["hevc", "HEVC (H.265)"], ["av1", "AV1"]] }],
  ["compression_options.hevc_cq", "HEVC quality (CQ, lower is better)", "number", 23, { min: 0 }],
  ["compression_options.av1_cq", "AV1 quality (CQ, lower is better)", "number", 26, { min: 0 }],
  ["compression_options.video_cq_max", "Highest CQ when retrying", "number", 35],
  ["compression_options.video_workers_per_gpu", "Video encoders per GPU", "number", 2, { max: 2 }],
  ["compression_options.min_savings_percent", "Minimum video savings (%)", "number", 5, { min: 0, max: 100 }],
  ["compression_options.jpeg_quality", "JPEG quality", "number", 85, { max: 95 }],
  ["compression_options.webp_quality", "WebP quality", "number", 80, { max: 100 }],
  ["compression_options.png_optimize", "Optimize PNGs", "checkbox", true],
];
// FileTree's named Compress presets.
const sideloadPresets = [["max", "Maximum savings"], ["more", "More savings"], ["balanced", "Balanced"], ["high", "High quality"]] as const;
function get(settings: Record<string, unknown>, path: string, fallback: unknown): unknown {
  let value: unknown = settings;
  for (const key of path.split(".")) value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  return value ?? fallback;
}
const drafts = new Map<string, string>();
export function CyberdropView(_props: PluginPanelProps) {
  const [repo, setRepo] = useState(() => localStorage.getItem("filetree.cyberdrop.repo") || initialRepo);
  const [tab, setTab] = useState<"setup" | "monitor" | "edit">("setup");
  const [config, setConfig] = useState<Document | null>(null);
  const [ws, setWs] = useState<Workspace | null>(null);
  const [patch, setPatch] = useState<Record<string, unknown>>({});
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [file, setFile] = useState<"workstation" | "config.yml" | "URLs.txt">("workstation");
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [monitorTab, setMonitorTab] = useState<"progress" | "logs">("progress");
  const [monitor, setMonitor] = useState<Monitor>({ status: "Ready", logs: [], started: 0 });
  const [wrap, setWrap] = useState(true);
  const [follow, setFollow] = useState(true);
  const [revision, setRevision] = useState("");
  const [revisionText, setRevisionText] = useState<string | null>(null);
  const output = useRef<HTMLPreElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const dirty = text !== saved && file !== "URLs.txt";
  const running = monitor.status === "Running";
  const draftKey = file === "workstation" ? ws?.name ?? "" : file;
  const doc = (action: string, body: Record<string, unknown> = {}) => invoke<Document>("cyberdrop_document", { repo, action, name: "config.yml", ...body });
  const workspace = (action: string, body: Record<string, unknown> = {}) => invoke<Workspace>("cyberdrop_workspace", { repo, request: { action, ...body } });
  const perform = async (action: () => Promise<void>) => {
    setBusy(true); setError(""); setMessage("");
    try { await action(); } catch (error) { setError(String(error)); } finally { setBusy(false); }
  };
  const addEditorTab = (key: string) => setOpenTabs(previous => previous.includes(key) ? previous : [...previous, key]);
  const showStation = (value: Workspace) => {
    addEditorTab(value.name);
    setWs(value); setFile("workstation"); setSaved(value.text); setText(drafts.get(value.name) ?? value.text);
    setRevision(""); setRevisionText(null);
  };
  const initialize = async () => {
    localStorage.setItem("filetree.cyberdrop.repo", repo);
    showStation(await workspace("init"));
    const value = await doc("load"); setConfig(value);
    if (value.validationError) setError(value.validationError);
  };
  useEffect(() => { void perform(initialize); }, []);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const result = await invoke<Monitor>("cyberdrop_status"); if (!disposed) setMonitor(result); }
      catch (error) { if (!disposed) setError(String(error)); }
      if (!disposed) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, []);
  useEffect(() => { if (follow && output.current) output.current.scrollTop = output.current.scrollHeight; }, [monitor.logs, follow]);
  const saveEditor = async () => {
    if (!dirty) return;
    if (file === "config.yml") { const value = await doc("save", { text }); setConfig(value); setSaved(value.text); }
    else if (ws) { const value = await workspace("save", { name: ws.name, text }); setWs(value); setSaved(value.text); }
    drafts.delete(draftKey); setMessage("Saved revision");
  };
  const saveSetup = async () => {
    if (!Object.keys(patch).length) return;
    const value = await doc("patch", { patch }); setConfig(value); setPatch({});
    if (file === "config.yml") { setText(value.text); setSaved(value.text); }
    setMessage("Saved config.yml");
  };
  const switchTab = (next: typeof tab) => void perform(async () => { await saveEditor(); await saveSetup(); setTab(next); });
  const changeDocument = (next: typeof file) => void perform(async () => {
    await saveEditor(); setRevisionText(null); setRevision("");
    if (next !== "workstation") addEditorTab(next);
    if (next === "workstation" && ws) showStation(await workspace("load", { name: ws.name }));
    else if (next === "config.yml") { const value = await doc("load"); setConfig(value); setFile(next); setSaved(value.text); setText(drafts.get(next) ?? value.text); }
    else if (ws) { setFile(next); setText(ws.activeText); setSaved(ws.activeText); }
  });
  const selectEditorTab = async (key: string) => {
    await saveEditor();
    setRevisionText(null); setRevision("");
    if (key.startsWith("URLs-")) showStation(await workspace("load", { name: key }));
    else if (key === "config.yml") {
      const value = await doc("load"); setConfig(value); setFile(key); setSaved(value.text); setText(drafts.get(key) ?? value.text);
    } else if (ws) { setFile("URLs.txt"); setText(ws.activeText); setSaved(ws.activeText); }
  };
  const closeEditorTab = (key: string) => void perform(async () => {
    if (key === draftKey) await saveEditor();
    const remaining = openTabs.filter(item => item !== key);
    if (key === draftKey && remaining.length) await selectEditorTab(remaining[Math.max(0, openTabs.indexOf(key) - 1)] ?? remaining[0]);
    setOpenTabs(remaining);
  });
  const renameFile = async (key: string) => {
    const label = await promptDialog({ title: "Rename URL file", label: "Filename", initialValue: ws?.stations.find(item => item.id === key)?.label ?? "URLs.txt", confirmLabel: "Rename" });
    if (label === null) return;
    void perform(async () => { await saveEditor(); showStation(await workspace("rename", { name: key, label })); setMessage("File renamed. Revision history and loaded download input are preserved."); });
  };
  const start = () => void perform(async () => {
    if (file === "config.yml") await saveEditor();
    await saveSetup();
    await invoke("cyberdrop_start", { repo, excludePaths: loadCompressionExclusions() });
    setMonitor(await invoke<Monitor>("cyberdrop_status")); setTab("monitor");
  });
  const editText = (value: string) => { setText(value); drafts.set(draftKey, value); };
  const loadForDownload = () => void perform(async () => {
    if (!ws) return;
    await saveEditor(); showStation(await workspace("stage", { name: ws.name }));
    setMessage(`${ws.name} loaded into URLs.txt. Later edits will not change this download input until you load again.`);
  });
  const newStation = (contents = "", label = "Untitled") => void perform(async () => {
    await saveEditor(); showStation(await workspace("create", { text: contents, label })); setTab("edit");
  });
  const mode = ws?.compressionMode ?? "off";
  const saveSideload = (settings: Record<string, string>) => void perform(async () => { setWs(await workspace("sideload", { settings })); });
  const renderField = ([path, label, type, fallback, extra]: FieldDef) => {
    const value = path in patch ? patch[path] : get(config?.settings ?? {}, path, fallback);
    const update = (next: unknown) => setPatch(previous => ({ ...previous, [path]: next }));
    if (type === "select") return <label key={path}><span>{label}</span>
      <select aria-label={label} disabled={!config || busy} value={String(value)} onChange={event => update(event.target.value)}>
        {extra?.options?.map(([id, text]) => <option key={id} value={id}>{text}</option>)}
      </select></label>;
    return <label key={path} className={type === "checkbox" ? "cdl-check" : ""}>
      {type !== "checkbox" && <span>{label}</span>}
      <input aria-label={label} type={type} disabled={!config || busy} min={type === "number" ? extra?.min ?? 1 : undefined} max={type === "number" ? extra?.max : undefined}
        {...(type === "checkbox" ? { checked: !!value } : { value: String(value) })}
        onChange={event => update(type === "checkbox" ? event.target.checked : type === "number" ? Number(event.target.value) : event.target.value)} />
      {type === "checkbox" && <span>{label}</span>}
    </label>;
  };
  return <div className="cdl-view">
    <div className="plg-tabstrip" role="tablist" aria-label="Cyberdrop">
      {(["setup", "monitor", "edit"] as const).map(item => <button key={item} role="tab" aria-selected={tab === item} disabled={busy} className={`plg-tab${tab === item ? " active" : ""}`} onClick={() => switchTab(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}
      <span className="cdl-status" role="status">{busy ? "Working…" : monitor.status}</span>
    </div>
    {error && <div className="cdl-message error" role="alert">{error}</div>}
    {message && <div className="cdl-message" role="status">{message}</div>}
    <div className="cdl-toolbar">
      <span>Download input: <strong>{ws?.loaded?.id ?? "No workstation loaded"}</strong></span>
      <button disabled={busy || !ws} onClick={() => { setTab("edit"); changeDocument("URLs.txt"); }}>View URLs.txt</button>
      <button disabled={busy || running || !ws?.loaded || !config} onClick={start}>Start download</button>
      <button disabled={busy || !running} onClick={() => void perform(async () => { await invoke("cyberdrop_stop"); setMonitor(await invoke<Monitor>("cyberdrop_status")); })}>Stop</button>
      <button disabled={!ws || busy} onClick={() => { if (ws) void openPath(ws.folder).catch(error => setError(String(error))); }}>Open workspace folder</button>
    </div>
    {tab === "setup" && <div className="cdl-setup">
      <h2>Cyberdrop installation</h2>
      <div className="cdl-toolbar"><input aria-label="Cyberdrop installation folder" value={repo} onChange={event => setRepo(event.target.value)} /><button disabled={busy} onClick={() => void perform(initialize)}>Connect</button></div>
      <h2>Download settings</h2>
      <p>Configuration, cache, download history, logs and URL workstations live together in {ws?.folder ?? "the central workspace"}.</p>
      <div className="cdl-fields">{fields.map(renderField)}
      <label>Compression<select aria-label="Compression mode" disabled={busy || !ws} value={mode} onChange={event => { const mode = event.target.value; void perform(async () => { const value = await workspace("mode", { mode }); setWs(value); }); }}>
        <option value="off">Off</option><option value="cyberdrop">On — Cyberdrop pipeline</option><option value="filetree">Side-load — FileTree queue</option>
      </select></label></div>
      {mode === "cyberdrop" && <>
        <h2>Cyberdrop compression</h2>
        <p>Cyberdrop compresses finished downloads in its own pipeline. Save these with Save settings; they apply to the next download run.</p>
        <div className="cdl-fields">{compressionFields.map(renderField)}</div>
      </>}
      {mode === "filetree" && <>
        <h2>Side-load compression</h2>
        <p>Completed files are sent to Compress → Queue and honor your Do not compress exclusions. Cyberdrop compression is disabled in this mode. Changes save immediately and apply to the next download run.</p>
        <div className="cdl-fields">
          <label>Preset<select aria-label="Side-load preset" disabled={busy || !ws} value={ws?.sideload?.preset ?? "balanced"} onChange={event => saveSideload({ preset: event.target.value })}>
            {sideloadPresets.map(([id, text]) => <option key={id} value={id}>{text}</option>)}
          </select></label>
          <label>Originals<select aria-label="Side-load originals" disabled={busy || !ws} value={ws?.sideload?.originalAction ?? "keep"} onChange={event => saveSideload({ originalAction: event.target.value })}>
            <option value="keep">Keep originals</option><option value="recycle">Move originals to the Recycle Bin</option>
          </select></label>
        </div>
      </>}
      <button disabled={busy || !Object.keys(patch).length} onClick={() => void perform(saveSetup)}>Save settings</button>
      <button disabled={busy || !ws} onClick={() => { setTab("edit"); changeDocument("workstation"); }}>Edit URL workstations</button>
    </div>}
    {tab === "monitor" && <div className="cdl-monitor">
      <div className="cdl-toolbar"><strong>{monitor.status}</strong>{monitor.started > 0 && <span>Started {new Date(monitor.started * 1000).toLocaleString()}</span>}<label><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} /> Follow output</label></div>
      <div className="cdl-toolbar" role="tablist" aria-label="Download monitor"><button role="tab" aria-selected={monitorTab === "progress"} onClick={() => setMonitorTab("progress")}>Progress</button><button role="tab" aria-selected={monitorTab === "logs"} onClick={() => setMonitorTab("logs")}>Logs</button></div>
      {monitorTab === "progress" ? <div className="cdl-transfers">
        <CyberdropSummary data={monitor.progress} running={running} />
        <div className="cdl-toolbar"><strong>Downloads: {running ? monitor.progress?.active ?? 0 : 0} active</strong><span>{(monitor.progress?.downloadQueued ?? 0).toLocaleString()} files queued</span><span>{bytes(monitor.progress?.bytes ?? 0)} transferred</span><span>{bytes(running ? monitor.progress?.speed ?? 0 : 0)}/s</span></div>
        {running && !!monitor.progress?.files.length ? <table><thead><tr><th>File</th><th>Host</th><th>Progress</th><th>Transferred</th><th>Speed</th><th>ETA</th></tr></thead><tbody>{monitor.progress.files.map((file, index) => <tr key={`${file.description}-${index}`}><td title={file.description}>{file.description}</td><td>{file.domain}</td><td><progress max={file.size || undefined} value={file.size ? file.completed : undefined} aria-label={`Progress for ${file.description}`} /><span>{file.size ? `${Math.min(100, file.completed / file.size * 100).toFixed(1)}%` : "Unknown size"}{file.hls ? " (segments)" : ""}</span></td><td>{bytes(file.bytes_downloaded)}{!file.hls && file.size ? ` / ${bytes(file.size)}` : ""}</td><td>{file.speed == null ? "Estimating" : `${bytes(file.speed)}/s`}</td><td>{eta(file.eta)}</td></tr>)}</tbody></table> : <div className="cdl-empty">{running ? "Discovering URLs or waiting for the next transfer. See Logs for details." : monitor.status === "Ready" ? "Load a workstation and start a download to see live progress." : monitor.status}</div>}
        <CyberdropCompression data={monitor.progress} running={running} mode={ws?.compressionMode ?? "off"} bytes={bytes} eta={eta} />
      </div> : <pre ref={output} tabIndex={0} aria-label="Cyberdrop output">{monitor.logs.join("").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") || "Load a URL workstation and start a download to see activity here."}</pre>}
      <small>Recent CLI output. Full logs are in the central workspace. Side-loaded jobs remain available in FileTree’s compression queue after downloads stop.</small>
    </div>}
    {tab === "edit" && <div className="cdl-editor">
      <div className="cdl-file-tabs" role="tablist" aria-label="Editor documents">
        {openTabs.map(key => {
          const label = ws?.stations.find(item => item.id === key)?.label ?? key;
          return <div key={key} className={`cdl-file-tab${draftKey === key ? " active" : ""}`}>
            <button role="tab" aria-selected={draftKey === key} disabled={busy} title={key} onClick={() => void perform(() => selectEditorTab(key))} onDoubleClick={() => { if (key.startsWith("URLs-")) void renameFile(key); }}>
              {label}{draftKey === key && dirty ? " •" : ""}{key === "URLs.txt" ? " (read only)" : ""}
            </button>
            <button aria-label={`Close ${label}`} title="Close tab" disabled={busy} onClick={() => closeEditorTab(key)}>×</button>
          </div>;
        })}
      </div>
      <div className="cdl-toolbar">
        <button disabled={busy} onClick={() => newStation()}>New workstation</button>
        <label>Open URL file<input aria-label="Import URL list" type="file" accept=".txt,text/plain" disabled={busy} onChange={event => {
          const imported = event.target.files?.[0]; event.target.value = "";
          if (!imported) return;
          void perform(async () => {
            if (imported.size > 2 * 1024 * 1024) throw new Error("URL lists must be smaller than 2 MB");
            await saveEditor(); showStation(await workspace("create", { text: await imported.text(), label: imported.name }));
          });
        }} /></label>
        <label>Quick open<select aria-label="Recent workstations" value={ws?.name ?? ""} disabled={busy || !ws} onChange={event => { const name = event.target.value; void perform(async () => { await saveEditor(); showStation(await workspace("load", { name })); }); }}>
          {ws?.stations.map(item => <option key={item.id} value={item.id}>{item.id} · {item.label}</option>)}
        </select></label>
        <select aria-label="Open document" value={file} disabled={busy} onChange={event => changeDocument(event.target.value as typeof file)}>
          <option value="workstation">Workstation URLs</option><option>config.yml</option><option value="URLs.txt">URLs.txt — download input (read only)</option>
        </select>
        <button disabled={busy || !ws || file !== "workstation" || !openTabs.includes(draftKey)} onClick={() => { if (ws) void renameFile(ws.name); }}>Rename</button>
        <button disabled={busy || !dirty || !openTabs.includes(draftKey)} onClick={() => void perform(saveEditor)}>Save</button>
        <button disabled={busy || !ws || file !== "workstation" || running || revisionText !== null} onClick={loadForDownload}>Load for download</button>
        <label><input type="checkbox" checked={wrap} onChange={event => setWrap(event.target.checked)} /> Word wrap</label>
      </div>
      {openTabs.includes(draftKey) ? <>
      {file === "workstation" && <div className="cdl-toolbar">
        <strong>{ws?.name}</strong><span>{ws?.loaded?.id === ws?.name && text !== ws?.activeText ? "Changes are not loaded for download yet." : "Edit here, then load a saved copy for downloading."}</span>
        <select aria-label="Revision history" value={revision} disabled={busy} onChange={event => { const selected = event.target.value; setRevision(selected); if (!selected) { setRevisionText(null); return; } void perform(async () => { const value = await workspace("revision", { name: ws!.name, revision: selected }); setRevisionText(value.text); }); }}>
          <option value="">Current version</option>{ws?.revisions.map(item => <option key={item} value={item}>{new Date(Number(item) / 1e6).toLocaleString()} · {item.slice(-5)}</option>)}
        </select>
        {revisionText !== null && <button disabled={busy} onClick={() => void perform(async () => { await saveEditor(); showStation(await workspace("restore", { name: ws!.name, revision })); setMessage("Restored as a new revision"); })}>Restore revision</button>}
      </div>}
      {file === "URLs.txt" && <div className="cdl-message">Read-only snapshot from {ws?.loaded?.id ?? "no workstation"}. Use Load for download to replace it.</div>}
      <textarea ref={editor} aria-label={file === "workstation" ? "Workstation editor" : `${file} editor`} spellCheck={false} wrap={wrap ? "soft" : "off"} value={revisionText ?? text} disabled={busy} readOnly={file === "URLs.txt" || revisionText !== null}
        onChange={event => editText(event.target.value)} onKeyDown={event => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void perform(saveEditor); }
          if (event.key === "Tab" && file !== "URLs.txt" && revisionText === null) { event.preventDefault(); const start = event.currentTarget.selectionStart; const end = event.currentTarget.selectionEnd; editText(text.slice(0, start) + "  " + text.slice(end)); requestAnimationFrame(() => editor.current?.setSelectionRange(start + 2, start + 2)); }
        }} />
      <div className="cdl-toolbar"><span>{file === "workstation" ? ws?.name : file}{dirty ? " • Unsaved" : " • Saved"}</span><span>{(revisionText ?? text).split("\n").length.toLocaleString()} lines</span><span>UTF-8 · Ctrl+S to save</span></div>
      </> : <div className="cdl-message">Open a recent file or create a new workstation to start editing.</div>}
    </div>}
  </div>;
}
