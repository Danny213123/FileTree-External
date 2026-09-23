import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CyberdropSummary, CyberdropCompression, type DashboardData } from "./CyberdropDashboard";
import { confirmDialog, promptDialog } from "../lib/dialogs";
import { openPath } from "../api/client";
import { loadCompressionExclusions } from "../lib/compressionExclusions";
import type { PluginPanelProps } from "../lib/plugins";
type Document = { text: string; settings: Record<string, unknown>; folder: string; validationError?: string };
type Workspace = { folder: string; name: string; text: string; stations: { id: string; label: string; opened: number; edited: number }[]; revisions: string[]; loaded: { id: string } | null; activeText: string; compressionMode: string; sideload?: Partial<Sideload> };
type Transfer = { description: string; domain: string; size: number | null; completed: number; bytes_downloaded: number; speed: number | null; eta: number | null; hls: boolean };
type Monitor = { status: string; logs: string[]; started: number; progress?: DashboardData & { files: Transfer[]; active: number; bytes: number; speed: number } | null };
function bytes(value: number) { const unit = Math.min(4, Math.floor(Math.log2(Math.max(1, value)) / 10)); return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${["B", "KiB", "MiB", "GiB", "TiB"][unit]}`; }
function eta(value: number | null) { return value == null ? "Estimating" : value < 60 ? `${Math.ceil(value)}s` : `${Math.floor(value / 60)}m ${Math.ceil(value % 60)}s`; }
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
// Side-load batches become FileTree compression jobs, so these mirror the
// Compress page's options; the workspace validates the same choices.
type Sideload = { preset: string; originalAction: string; tagFilename: boolean; codec: string; encoder: string; concurrency: number; zipLevel: number; minSizeBytes: number; customMaxHeight: number; customQuality: number };
const SIDELOAD_DEFAULTS: Sideload = { preset: "balanced", originalAction: "keep", tagFilename: true, codec: "h264", encoder: "auto", concurrency: 2, zipLevel: -1, minSizeBytes: 0, customMaxHeight: 1080, customQuality: 26 };
const sideloadPresets = [["max", "Maximum savings"], ["more", "More savings"], ["balanced", "Balanced"], ["high", "High quality"], ["custom", "Custom"]] as const;
// Resolution cap and quality (RF) behind each named preset, as on the Compress page.
const presetValues: Record<string, { height: number; quality: number }> = { max: { height: 480, quality: 30 }, more: { height: 720, quality: 27 }, balanced: { height: 1080, quality: 24 }, high: { height: 0, quality: 20 } };
const heights = [[0, "Original"], [1440, "1440p"], [1080, "1080p"], [720, "720p"], [480, "480p"]] as const;
const minSizes: [number, string][] = [[0, "No minimum"], ...[256, 512].map(kb => [kb * 1024, `${kb} KB`] as [number, string]), ...[1, 2, 5, 10, 25, 50, 100].map(mb => [mb * 1024 * 1024, `${mb} MB`] as [number, string])];
function get(settings: Record<string, unknown>, path: string, fallback: unknown): unknown {
  let value: unknown = settings;
  for (const key of path.split(".")) value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  return value ?? fallback;
}
const drafts = new Map<string, string>();
type EditorFile = "workstation" | "config.yml" | "URLs.txt";
// Leaving the Plugins page unmounts this panel, and connecting again costs two
// Python launches (workspace init, then the config parse) — seconds on Windows.
// The last view is kept here so coming back is instant, and refreshed quietly
// behind the restored screen.
type Session = { repo: string; ws: Workspace | null; config: Document | null; openTabs: string[]; file: EditorFile; text: string; saved: string };
let session: Session | null = null;
const TAB_KEY = "filetree.cyberdrop.tab";
const MONITOR_TAB_KEY = "filetree.cyberdrop.monitorTab";
function storedTab(): "setup" | "monitor" | "edit" {
  const value = localStorage.getItem(TAB_KEY);
  return value === "monitor" || value === "edit" ? value : "setup";
}
export function CyberdropView(_props: PluginPanelProps) {
  const [repo, setRepo] = useState(() => localStorage.getItem("filetree.cyberdrop.repo") || "");
  const [tab, setTab] = useState<"setup" | "monitor" | "edit">(storedTab);
  const [config, setConfig] = useState<Document | null>(() => session?.config ?? null);
  const [ws, setWs] = useState<Workspace | null>(() => session?.ws ?? null);
  const [patch, setPatch] = useState<Record<string, unknown>>({});
  const [openTabs, setOpenTabs] = useState<string[]>(() => session?.openTabs ?? []);
  const [file, setFile] = useState<EditorFile>(() => session?.file ?? "workstation");
  const [text, setText] = useState(() => session?.text ?? "");
  const [saved, setSaved] = useState(() => session?.saved ?? "");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [autoSave, setAutoSave] = useState(() => localStorage.getItem("filetree.cyberdrop.autoSave") !== "false");
  const saveTail = useRef<Promise<void>>(Promise.resolve());
  const pendingSaves = useRef(0);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [monitorTab, setMonitorTab] = useState<"progress" | "logs">(() => localStorage.getItem(MONITOR_TAB_KEY) === "logs" ? "logs" : "progress");
  const [monitor, setMonitor] = useState<Monitor>({ status: "Ready", logs: [], started: 0 });
  const [wrap, setWrap] = useState(true);
  const [follow, setFollow] = useState(true);
  const [revision, setRevision] = useState("");
  const [revisionText, setRevisionText] = useState<string | null>(null);
  const output = useRef<HTMLPreElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  // The native file input is kept out of sight; its own button opens it, so the
  // toolbar shows one control in the app's style instead of "Choose File".
  const importer = useRef<HTMLInputElement>(null);
  const dirty = text !== saved && file !== "URLs.txt";
  const running = monitor.status === "Running";
  const draftKey = file === "workstation" ? ws?.name ?? "" : file;
  const currentEditor = useRef({ repo, draftKey, text });
  currentEditor.current = { repo, draftKey, text };
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
  // Reconnecting quietly: the restored view stays on screen (and keeps any
  // unsaved draft) while the workspace and config are re-read behind it.
  const reconnect = async () => {
    try {
      const value = await workspace("load", { name: session?.ws?.name });
      setWs(previous => previous?.name === value.name ? { ...previous, revisions: value.revisions, stations: value.stations, loaded: value.loaded, activeText: value.activeText } : previous);
      setConfig(await doc("load"));
    } catch { /* keep showing the cached view */ }
  };
  // Nothing to connect to until the user has chosen an installation folder.
  useEffect(() => {
    if (!repo) return;
    if (session?.repo === repo && session.ws) void reconnect();
    else void perform(initialize);
  }, []);
  useEffect(() => { localStorage.setItem(TAB_KEY, tab); }, [tab]);
  useEffect(() => { localStorage.setItem(MONITOR_TAB_KEY, monitorTab); }, [monitorTab]);
  useEffect(() => { session = { repo, ws, config, openTabs, file, text, saved }; }, [repo, ws, config, openTabs, file, text, saved]);
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
  const saveEditor = () => {
    if (!dirty || revisionText !== null) return saveTail.current;
    const snapshot = { repo, key: draftKey, file, text, name: ws?.name };
    pendingSaves.current++; setSaving(true); setSaveError("");
    const operation = saveTail.current.catch(() => {}).then(async () => {
      const value = snapshot.file === "config.yml"
        ? await invoke<Document>("cyberdrop_document", { repo: snapshot.repo, action: "save", name: "config.yml", text: snapshot.text })
        : await invoke<Workspace>("cyberdrop_workspace", { repo: snapshot.repo, request: { action: "save", name: snapshot.name, text: snapshot.text } });
      setSaveError("");
      const current = currentEditor.current;
      if (current.repo === snapshot.repo && current.draftKey === snapshot.key) {
        if (snapshot.file === "config.yml") setConfig(value as Document);
        else setWs(previous => previous && previous.name === snapshot.name ? { ...previous, revisions: (value as Workspace).revisions } : previous);
        // Only the submitted text is saved. Typing during I/O remains a draft.
        setSaved(snapshot.text);
        if (current.text === snapshot.text) drafts.delete(snapshot.key);
      }
    }).catch(error => { setSaveError(String(error)); throw error; }).finally(() => {
      pendingSaves.current--; setSaving(pendingSaves.current > 0);
    });
    saveTail.current = operation;
    return operation;
  };
  const saveQuietly = () => { void saveEditor().catch(() => {}); };
  const latestSave = useRef(saveQuietly);
  latestSave.current = saveQuietly;
  useEffect(() => {
    localStorage.setItem("filetree.cyberdrop.autoSave", String(autoSave));
    if (!autoSave || tab !== "edit" || file !== "workstation" || !dirty || busy || revisionText !== null) return;
    const timer = setTimeout(() => latestSave.current(), 1000);
    return () => clearTimeout(timer);
  }, [autoSave, tab, file, text, dirty, busy, revisionText]);
  useEffect(() => {
    const saveOnLeave = () => {
      if (autoSave && tab === "edit" && file === "workstation" && !busy && revisionText === null) latestSave.current();
    };
    window.addEventListener("blur", saveOnLeave);
    return () => window.removeEventListener("blur", saveOnLeave);
  }, [autoSave, tab, file, busy, revisionText]);
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
  // Option changes show at once and save behind the form: nothing is disabled
  // while they save, so the form does not flash. Quick successive changes (a
  // dragged slider) coalesce into one save, since each save launches Python.
  const pendingSideload = useRef<Partial<Sideload>>({});
  const sideloadTimer = useRef<ReturnType<typeof setTimeout>>();
  const sideloadTail = useRef<Promise<void>>(Promise.resolve());
  const saveSideload = (settings: Partial<Sideload>) => {
    setWs(previous => previous && { ...previous, sideload: { ...previous.sideload, ...settings } });
    pendingSideload.current = { ...pendingSideload.current, ...settings };
    clearTimeout(sideloadTimer.current);
    sideloadTimer.current = setTimeout(() => {
      const batch = pendingSideload.current; pendingSideload.current = {};
      sideloadTail.current = sideloadTail.current.then(() => workspace("sideload", { settings: batch }).then(() => {}, async error => {
        setError(String(error));
        // Show what was actually saved.
        const value = await workspace("load", { name: ws?.name }).catch(() => null);
        if (value) setWs(previous => previous && { ...previous, sideload: value.sideload });
      }));
    }, 250);
  };
  useEffect(() => () => clearTimeout(sideloadTimer.current), []);
  const changeMode = (next: string) => {
    const previous = mode;
    setWs(value => value && { ...value, compressionMode: next }); setError("");
    workspace("mode", { mode: next }).catch(error => { setError(String(error)); setWs(value => value && { ...value, compressionMode: previous }); });
  };
  const sideload: Sideload = { ...SIDELOAD_DEFAULTS, ...ws?.sideload };
  const named = presetValues[sideload.preset];
  const sideloadHeight = named ? named.height : sideload.customMaxHeight;
  const sideloadQuality = named ? named.quality : sideload.customQuality;
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
      <div className="cdl-toolbar"><input aria-label="Cyberdrop installation folder" placeholder="Folder that contains cyberdrop_dl and .venv" value={repo} onChange={event => setRepo(event.target.value)} /><button disabled={busy || !repo.trim()} onClick={() => void perform(initialize)}>Connect</button></div>
      <h2>Download settings</h2>
      <p>Configuration, cache, download history, logs and URL workstations live together in {ws?.folder ?? "the central workspace"}.</p>
      <div className="cdl-fields">{fields.map(renderField)}
      <label>Compression<select aria-label="Compression mode" disabled={!ws} value={mode} onChange={event => changeMode(event.target.value)}>
        <option value="off">Off</option><option value="cyberdrop">On — Cyberdrop pipeline</option><option value="filetree">Side-load — FileTree queue</option>
      </select></label></div>
      {mode === "cyberdrop" && <section className="cdl-section" key="cyberdrop">
        <h2>Cyberdrop compression</h2>
        <p>Cyberdrop compresses finished downloads in its own pipeline. Save these with Save settings; they apply to the next download run.</p>
        <div className="cdl-fields">{compressionFields.map(renderField)}</div>
      </section>}
      {mode === "filetree" && <section className="cdl-section" key="filetree">
        <h2>Side-load compression</h2>
        <p>Completed files are sent to Compress → Queue and honor your Do not compress exclusions. Cyberdrop compression is disabled in this mode. Changes save immediately and apply to the next download run.</p>
        <div className="cdl-fields">
          <label>Preset<select aria-label="Side-load preset" disabled={!ws} value={sideload.preset} onChange={event => saveSideload({ preset: event.target.value })}>
            {sideloadPresets.map(([id, text]) => <option key={id} value={id}>{text}</option>)}
          </select></label>
          <label title="Videos taller than this are scaled down. Changing it switches to the Custom preset.">Resolution<select aria-label="Side-load resolution" disabled={!ws} value={sideloadHeight} onChange={event => saveSideload({ preset: "custom", customMaxHeight: Number(event.target.value), customQuality: sideloadQuality })}>
            {heights.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
          </select></label>
          <label title="Lower is better quality and larger files. Changing it switches to the Custom preset.">
            <span>Quality <output className="cdl-value">RF {sideloadQuality}</output></span>
            <input aria-label="Side-load quality" type="range" min={16} max={40} step={1} disabled={!ws} value={sideloadQuality} onChange={event => saveSideload({ preset: "custom", customQuality: Number(event.target.value), customMaxHeight: sideloadHeight })} />
          </label>
          <label>Codec<select aria-label="Side-load codec" disabled={!ws} value={sideload.codec} onChange={event => saveSideload({ codec: event.target.value })}>
            <option value="h264">H.264 (compatible)</option><option value="h265">H.265 (smaller)</option><option value="av1">AV1 (hardware only)</option>
          </select></label>
          <label>Encoder<select aria-label="Side-load encoder" disabled={!ws} value={sideload.encoder} onChange={event => saveSideload({ encoder: event.target.value })}>
            <option value="auto">Auto GPU (best available)</option><option value="nvenc">NVENC (NVIDIA)</option><option value="qsv">QSV (Intel)</option><option value="vce">AMF/VCE (AMD)</option>
          </select></label>
          <label>Parallel files<select aria-label="Side-load parallel files" disabled={!ws} value={sideload.concurrency} onChange={event => saveSideload({ concurrency: Number(event.target.value) })}>
            <option value={1}>1</option><option value={2}>2</option>
          </select></label>
          <label title="Deflate level for zip archives.">Zip level<select aria-label="Side-load zip level" disabled={!ws} value={sideload.zipLevel} onChange={event => saveSideload({ zipLevel: Number(event.target.value) })}>
            <option value={-1}>Default</option>{Array.from({ length: 10 }, (_, level) => <option key={level} value={level}>{level}{level === 0 ? " (store)" : level === 9 ? " (smallest)" : ""}</option>)}
          </select></label>
          <label title="Smaller files are left untouched.">Minimum size<select aria-label="Side-load minimum size" disabled={!ws} value={sideload.minSizeBytes} onChange={event => saveSideload({ minSizeBytes: Number(event.target.value) })}>
            {minSizes.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
          </select></label>
          <label>Originals<select aria-label="Side-load originals" className={sideload.originalAction === "delete" ? "cdl-danger" : ""} disabled={!ws} value={sideload.originalAction} onChange={event => {
            const originalAction = event.target.value;
            if (originalAction !== "delete") { saveSideload({ originalAction }); return; }
            // Applies to every later download run, unattended, and cannot be undone.
            void confirmDialog({
              title: "Delete originals permanently",
              message: "Every file compressed from later download runs will have its original permanently deleted once the compressed copy is verified. This cannot be undone, and it stays on until you change it here.",
              confirmLabel: "Delete originals", danger: true,
            }).then(ok => { if (ok) saveSideload({ originalAction }); });
          }}>
            <option value="keep">Keep originals</option><option value="recycle">Move originals to the Recycle Bin</option><option value="delete">Delete originals permanently</option>
          </select></label>
          <label className="cdl-check"><input aria-label="Add [COMPRESSED] tag" type="checkbox" disabled={!ws} checked={sideload.tagFilename} onChange={event => saveSideload({ tagFilename: event.target.checked })} /><span>Add [COMPRESSED] tag</span></label>
        </div>
      </section>}
      <button disabled={busy || !Object.keys(patch).length} onClick={() => void perform(saveSetup)}>Save settings</button>
      <button disabled={busy || !ws} onClick={() => { setTab("edit"); changeDocument("workstation"); }}>Edit URL workstations</button>
    </div>}
    {tab === "monitor" && <div className="cdl-monitor">
      <div className="cdl-toolbar"><strong className={`cdl-run-status${running ? " running" : ""}`}>{monitor.status}</strong>{monitor.started > 0 && <span>Started {new Date(monitor.started * 1000).toLocaleString()}</span>}<label><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} /> Follow output</label></div>
      <div className="cdl-toolbar" role="tablist" aria-label="Download monitor"><button role="tab" aria-selected={monitorTab === "progress"} onClick={() => setMonitorTab("progress")}>Progress</button><button role="tab" aria-selected={monitorTab === "logs"} onClick={() => setMonitorTab("logs")}>Logs</button></div>
      {monitorTab === "progress" ? <div className="cdl-transfers">
        <CyberdropSummary data={monitor.progress} running={running} />
        <div className="cdl-toolbar cdl-downloads-bar"><strong>Downloads: {running ? monitor.progress?.active ?? 0 : 0} active</strong><span className="cdl-eta">{(monitor.progress?.downloadQueued ?? 0).toLocaleString()} files queued</span><span className="cdl-bytes">{bytes(monitor.progress?.bytes ?? 0)} transferred</span><span className="cdl-speed">{bytes(running ? monitor.progress?.speed ?? 0 : 0)}/s</span></div>
        {running && !!monitor.progress?.files.length ? <table><thead><tr><th>File</th><th>Host</th><th>Progress</th><th>Transferred</th><th>Speed</th><th>ETA</th></tr></thead><tbody>{monitor.progress.files.map((file, index) => <tr key={`${file.description}-${index}`}><td title={file.description}>{file.description}</td><td className="cdl-host">{file.domain}</td><td><progress max={file.size || undefined} value={file.size ? file.completed : undefined} aria-label={`Progress for ${file.description}`} /><span className="cdl-pct">{file.size ? `${Math.min(100, file.completed / file.size * 100).toFixed(1)}%` : "Unknown size"}{file.hls ? " (segments)" : ""}</span></td><td className="cdl-bytes">{bytes(file.bytes_downloaded)}{!file.hls && file.size ? ` / ${bytes(file.size)}` : ""}</td><td className="cdl-speed">{file.speed == null ? "Estimating" : `${bytes(file.speed)}/s`}</td><td className="cdl-eta">{eta(file.eta)}</td></tr>)}</tbody></table> : <div className="cdl-empty">{running ? "Discovering URLs or waiting for the next transfer. See Logs for details." : monitor.status === "Ready" ? "Load a workstation and start a download to see live progress." : monitor.status}</div>}
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
        <button className="cdl-tab-action" aria-label="New workstation" title="New workstation" disabled={busy} onClick={() => newStation()}>+</button>
        <button className="cdl-tab-action" aria-label="Open URL file…" title="Open URL file…" disabled={busy} onClick={() => importer.current?.click()}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1.5 3.5h4l1.5 1.5h7.5v8h-13z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>
        </button>
        <input ref={importer} className="cdl-file-input" aria-label="Import URL list" type="file" accept=".txt,text/plain" disabled={busy} tabIndex={-1} onChange={event => {
          const imported = event.target.files?.[0]; event.target.value = "";
          if (!imported) return;
          void perform(async () => {
            if (imported.size > 2 * 1024 * 1024) throw new Error("URL lists must be smaller than 2 MB");
            await saveEditor(); showStation(await workspace("create", { text: await imported.text(), label: imported.name }));
          });
        }} />
      </div>
      <div className="cdl-toolbar cdl-editor-bar">
        <div className="cdl-group">
          <select aria-label="Recent workstations" title="Switch workstation" value={ws?.name ?? ""} disabled={busy || !ws} onChange={event => { const name = event.target.value; void perform(async () => { await saveEditor(); showStation(await workspace("load", { name })); }); }}>
            {ws?.stations.map(item => <option key={item.id} value={item.id}>{item.label} · {item.id}</option>)}
          </select>
          <button className="cdl-icon-button" aria-label="Rename" title="Rename workstation (or double-click its tab)" disabled={busy || !ws || file !== "workstation" || !openTabs.includes(draftKey)} onClick={() => { if (ws) void renameFile(ws.name); }}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M10.5 2.5l3 3-8 8h-3v-3z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>
          </button>
          <select aria-label="Open document" title="Document" value={file} disabled={busy} onChange={event => changeDocument(event.target.value as typeof file)}>
            <option value="workstation">Workstation URLs</option><option>config.yml</option><option value="URLs.txt">URLs.txt — download input (read only)</option>
          </select>
        </div>
        <div className="cdl-group cdl-group-end">
          <label><input type="checkbox" checked={wrap} onChange={event => setWrap(event.target.checked)} /> Word wrap</label>
          <label title="Save URL workstations after typing and when switching to another app. Download input changes only when you load it."><input type="checkbox" checked={autoSave} onChange={event => setAutoSave(event.target.checked)} /> Auto-save</label>
          <button disabled={busy || !dirty || !openTabs.includes(draftKey)} title="Save (Ctrl+S)" onMouseDown={event => event.preventDefault()} onClick={() => { editor.current?.focus({ preventScroll: true }); saveQuietly(); }}>Save</button>
          <button className="primary" title="Copy this workstation into URLs.txt, the list the next download reads" disabled={busy || !ws || file !== "workstation" || running || revisionText !== null} onClick={loadForDownload}>Load for download</button>
        </div>
      </div>
      {openTabs.includes(draftKey) ? <>
      {file === "workstation" && <div className="cdl-toolbar cdl-revision-bar">
        {ws?.loaded?.id !== ws?.name ? <span className="cdl-hint">Edit here, then load it for downloading.</span> : text === ws?.activeText && <span className="cdl-pill">Loaded for download</span>}
        <label className="cdl-group-end">History<select aria-label="Revision history" value={revision} disabled={busy} onChange={event => { const selected = event.target.value; setRevision(selected); if (!selected) { setRevisionText(null); return; } void perform(async () => { const value = await workspace("revision", { name: ws!.name, revision: selected }); setRevisionText(value.text); }); }}>
          <option value="">Current version</option>{ws?.revisions.map(item => <option key={item} value={item}>{new Date(Number(item) / 1e6).toLocaleString()} · {item.slice(-5)}</option>)}
        </select></label>
        {revisionText !== null && <button disabled={busy} onClick={() => void perform(async () => { await saveEditor(); showStation(await workspace("restore", { name: ws!.name, revision })); setMessage("Restored as a new revision"); })}>Restore revision</button>}
      </div>}
      {file === "URLs.txt" && <div className="cdl-message">Read-only snapshot from {ws?.loaded?.id ?? "no workstation"}. Use Load for download to replace it.</div>}
      <textarea ref={editor} aria-label={file === "workstation" ? "Workstation editor" : `${file} editor`} spellCheck={false} wrap={wrap ? "soft" : "off"} value={revisionText ?? text} disabled={busy} readOnly={file === "URLs.txt" || revisionText !== null}
        onChange={event => editText(event.target.value)} onKeyDown={event => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); event.stopPropagation(); saveQuietly(); }
          if (event.key === "Tab" && file !== "URLs.txt" && revisionText === null) { event.preventDefault(); const start = event.currentTarget.selectionStart; const end = event.currentTarget.selectionEnd; editText(text.slice(0, start) + "  " + text.slice(end)); requestAnimationFrame(() => editor.current?.setSelectionRange(start + 2, start + 2)); }
        }} />
      <div className="cdl-toolbar cdl-editor-status"><span>{file === "workstation" ? ws?.name : file}</span><span role="status" title={saveError}>{saveError ? `Save failed: ${saveError}` : saving ? "Saving…" : dirty ? "Unsaved" : "Saved"}</span><span>{(revisionText ?? text).split("\n").length.toLocaleString()} lines</span><span>UTF-8 · Ctrl+S to save</span></div>
      </> : <div className="cdl-empty cdl-editor-empty">
        <p>No workstation open.</p>
        <div><button className="primary" disabled={busy} onClick={() => newStation()}>Create workstation</button><button disabled={busy} onClick={() => importer.current?.click()}>Open URL file…</button></div>
        <small>Or pick a recent one from the list above.</small>
      </div>}
    </div>}
  </div>;
}
