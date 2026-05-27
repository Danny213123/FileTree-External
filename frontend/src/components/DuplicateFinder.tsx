import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import type { DupeGroupV2, DupeFileV2, DupeScanMode, ReprioritizeCriterion } from "../api/types";
import type { DriveEntry, SpecialFolder } from "../api/types";
import {
  fetchDupesV2, fetchDupesProgress, dupeAction, dupeMakeRef,
  dupeIgnorePair, dupeClearIgnoreList,
} from "../api/client";
import type { DupesProgress } from "../api/client";
import { formatBytes } from "../utils/formatBytes";
import { formatDate } from "../utils/formatDate";

function formatWaste(bytes: number): string { return formatBytes(bytes, "auto"); }

// ── ScanTargets ───────────────────────────────────────────────────────────────

interface ScanTargetsProps {
  drives: DriveEntry[];
  specialFolders: SpecialFolder[];
  selectedPaths: string[];
  onTogglePath: (path: string) => void;
  onAddCustom: (path: string) => void;
  onRemoveCustom: (path: string) => void;
  customPaths: string[];
}

function ScanTargets({ drives, selectedPaths, onTogglePath, onAddCustom, onRemoveCustom, customPaths }: ScanTargetsProps) {
  const [expanded, setExpanded] = useState(true);
  const [customInput, setCustomInput] = useState("");

  const drivePaths = drives.map(d => d.root);
  const selectedSet = new Set(selectedPaths);

  const addCustom = () => {
    const p = customInput.trim();
    if (!p) return;
    onAddCustom(p);
    setCustomInput("");
  };

  return (
    <div className="df-targets">
      <button className="df-targets-header" onClick={() => setExpanded(v => !v)}>
        <span className="df-section-label" style={{ margin: 0 }}>Scan targets</span>
        <span className="df-targets-summary">
          {selectedPaths.length === 0 ? "none selected" : selectedPaths.map(p => p.replace(/\\$/, "")).join(", ")}
        </span>
        <span className="df-targets-arrow">{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div className="df-targets-body">
          {drives.map(d => (
            <label key={d.root} className="df-target-row">
              <input type="checkbox" className="df-checkbox" checked={selectedSet.has(d.root)}
                onChange={() => onTogglePath(d.root)} />
              <span className="df-target-icon">💾</span>
              <span className="df-target-path">{d.root}</span>
              {d.label && <span className="df-target-label">{d.label}</span>}
            </label>
          ))}
          {customPaths.filter(p => !drivePaths.includes(p)).map(p => (
            <label key={p} className="df-target-row">
              <input type="checkbox" className="df-checkbox" checked={selectedSet.has(p)}
                onChange={() => onTogglePath(p)} />
              <span className="df-target-icon">📁</span>
              <span className="df-target-path">{p}</span>
              <button className="df-filter-remove" onClick={e => { e.preventDefault(); onRemoveCustom(p); }} title="Remove">✕</button>
            </label>
          ))}
          <div className="df-target-add">
            <input className="df-filter-input" type="text" value={customInput}
              placeholder="Add path…" onChange={e => setCustomInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && addCustom()} />
            <button className="df-icon-btn" onClick={addCustom} title="Add path">＋</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── ScanModePanel ─────────────────────────────────────────────────────────────

const TAG_OPTIONS = ["artist", "title", "album", "genre", "track"] as const;

function ScanModePanel({
  mode, onModeChange,
  minScore, onMinScoreChange,
  weighted, onWeightedChange,
  mixKinds, onMixKindsChange,
  activeTags, onActiveTagsChange,
}: {
  mode: DupeScanMode; onModeChange: (m: DupeScanMode) => void;
  minScore: number; onMinScoreChange: (v: number) => void;
  weighted: boolean; onWeightedChange: (v: boolean) => void;
  mixKinds: boolean; onMixKindsChange: (v: boolean) => void;
  activeTags: string[]; onActiveTagsChange: (tags: string[]) => void;
}) {
  const toggleTag = (tag: string) => {
    onActiveTagsChange(
      activeTags.includes(tag) ? activeTags.filter(t => t !== tag) : [...activeTags, tag]
    );
  };

  return (
    <div className="df-sidebar-section df-mode-panel">
      <div className="df-section-label">Detection mode</div>
      <div className="df-mode-btns">
        {(["exact", "filename", "audio"] as DupeScanMode[]).map(m => (
          <button key={m} className={`df-mode-btn${mode === m ? " df-mode-btn-active" : ""}`}
            onClick={() => onModeChange(m)}>
            {m === "exact" ? "Exact" : m === "filename" ? "Filename ~" : "Audio 🎵"}
          </button>
        ))}
      </div>

      {mode === "filename" && (
        <div className="df-mode-opts">
          <div className="df-mode-opt-row">
            <span className="df-quick-label">Threshold</span>
            <input type="range" min={50} max={100} value={minScore}
              onChange={e => onMinScoreChange(Number(e.target.value))} style={{ flex: 1 }} />
            <span className="df-unit">{minScore}%</span>
          </div>
          <label className="df-mode-opt-row">
            <input type="checkbox" checked={weighted} onChange={e => onWeightedChange(e.target.checked)} />
            <span style={{ marginLeft: 6 }}>Word weighting</span>
          </label>
          <label className="df-mode-opt-row">
            <input type="checkbox" checked={mixKinds} onChange={e => onMixKindsChange(e.target.checked)} />
            <span style={{ marginLeft: 6 }}>Mix file types</span>
          </label>
        </div>
      )}

      {mode === "audio" && (
        <div className="df-mode-opts">
          <div className="df-mode-opt-row">
            <span className="df-quick-label">Threshold</span>
            <input type="range" min={50} max={100} value={minScore}
              onChange={e => onMinScoreChange(Number(e.target.value))} style={{ flex: 1 }} />
            <span className="df-unit">{minScore}%</span>
          </div>
          <div className="df-section-label" style={{ marginTop: 6, fontSize: 11 }}>Compare tags</div>
          <div className="df-tag-checks">
            {TAG_OPTIONS.map(t => (
              <label key={t} className="df-tag-check">
                <input type="checkbox" checked={activeTags.includes(t)} onChange={() => toggleTag(t)} />
                <span style={{ marginLeft: 4, textTransform: "capitalize" }}>{t}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── DuplicateFinder ───────────────────────────────────────────────────────────

interface DuplicateFinderProps {
  scanPath: string;
  hasScan: boolean;
  drives: DriveEntry[];
  specialFolders: SpecialFolder[];
  onNavigate: (id: number) => void;
  onRescan: () => void;
}

type ScanState = "idle" | "scanning" | "done" | "error";

const REPRIORITIZE_OPTIONS: { value: ReprioritizeCriterion; label: string }[] = [
  { value: "largest",      label: "Largest file as reference" },
  { value: "smallest",     label: "Smallest file as reference" },
  { value: "newest",       label: "Newest modified first" },
  { value: "oldest",       label: "Oldest modified first" },
  { value: "shortestPath", label: "Shortest path first" },
  { value: "longestPath",  label: "Longest path first" },
  { value: "alphaFirst",   label: "A-Z filename" },
  { value: "alphaLast",    label: "Z-A filename" },
];

export function DuplicateFinder({ scanPath, hasScan, drives, specialFolders, onNavigate, onRescan }: DuplicateFinderProps) {
  // Scan targets
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [customPaths, setCustomPaths] = useState<string[]>([]);

  // Scan mode & options
  const [scanMode, setScanMode] = useState<DupeScanMode>("exact");
  const [minScore, setMinScore] = useState(80);
  const [weighted, setWeighted] = useState(false);
  const [mixKinds, setMixKinds] = useState(false);
  const [activeTags, setActiveTags] = useState<string[]>(["artist", "title"]);

  // Quick filters
  const [quickMinKb, setQuickMinKb] = useState(1);
  const [extFilter, setExtFilter] = useState("");
  const [destPath, setDestPath] = useState("");

  // Results
  const [scanState, setScanState] = useState<ScanState>("idle");
  const [groups, setGroups] = useState<DupeGroupV2[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [ignoredCount, setIgnoredCount] = useState(0);
  const [progress, setProgress] = useState<DupesProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Selection & UI state
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [deleteMode, setDeleteMode] = useState<"recycle" | "permanent">("recycle");
  const [repriCriterion, setRepriCriterion] = useState<ReprioritizeCriterion>("largest");

  const handleTogglePath = (path: string) => {
    setSelectedPaths(prev => prev.includes(path) ? prev.filter(p => p !== path) : [...prev, path]);
  };
  const handleAddCustom = (path: string) => {
    setCustomPaths(prev => prev.includes(path) ? prev : [...prev, path]);
    setSelectedPaths(prev => prev.includes(path) ? prev : [...prev, path]);
  };
  const handleRemoveCustom = (path: string) => {
    setCustomPaths(prev => prev.filter(p => p !== path));
    setSelectedPaths(prev => prev.filter(p => p !== path));
  };

  // Poll progress while scanning
  useEffect(() => {
    if (scanState === "scanning") {
      pollRef.current = setInterval(async () => {
        const p = await fetchDupesProgress();
        setProgress(p);
      }, 400);
    } else {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      setProgress(null);
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [scanState]);

  const buildOpts = useCallback(() => ({
    paths: selectedPaths,
    mode: scanMode,
    minScore: scanMode !== "exact" ? minScore : undefined,
    weighted: scanMode === "filename" ? weighted : undefined,
    mixKinds: scanMode === "filename" ? mixKinds : undefined,
    tags: scanMode === "audio" ? activeTags : undefined,
    minSize: quickMinKb * 1024,
    extensions: extFilter.trim() || undefined,
  }), [selectedPaths, scanMode, minScore, weighted, mixKinds, activeTags, quickMinKb, extFilter]);

  const startScan = useCallback(async (sortBy?: ReprioritizeCriterion) => {
    if (selectedPaths.length === 0 && !hasScan) { onRescan(); return; }
    const paths = selectedPaths.length > 0 ? selectedPaths : [scanPath].filter(Boolean);
    if (!paths.length) return;

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setScanState("scanning");
    setGroups([]); setErrors([]); setSelected(new Set());

    try {
      const result = await fetchDupesV2({ ...buildOpts(), paths, sortBy }, ctrl.signal);
      setGroups(result.groups);
      setErrors(result.errors ?? []);
      setIgnoredCount(result.ignoredCount ?? 0);
      setScanState("done");
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      setScanState("error");
    }
  }, [selectedPaths, hasScan, scanPath, buildOpts, onRescan]);

  const stopScan = () => { abortRef.current?.abort(); setScanState("idle"); };

  const handleReprioritize = useCallback(async () => {
    if (!groups.length) return;
    const paths = selectedPaths.length > 0 ? selectedPaths : [scanPath].filter(Boolean);
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setScanState("scanning");
    try {
      const result = await fetchDupesV2({ ...buildOpts(), paths, sortBy: repriCriterion }, ctrl.signal);
      setGroups(result.groups);
      setErrors(result.errors ?? []);
      setIgnoredCount(result.ignoredCount ?? 0);
      setScanState("done");
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      setScanState("error");
    }
  }, [groups.length, selectedPaths, scanPath, buildOpts, repriCriterion]);

  const handleMakeRef = useCallback(async (group: DupeGroupV2, refPath: string) => {
    const updated = await dupeMakeRef(group.files.map(f => f.path), refPath);
    setGroups(prev => prev.map(g =>
      g.files[0].path === group.files[0].path ? updated : g
    ));
  }, []);

  const handleIgnoreGroup = useCallback(async (group: DupeGroupV2) => {
    if (group.files.length < 2) return;
    const result = await dupeIgnorePair(group.files[0].path, group.files[1].path);
    setIgnoredCount(result.count);
    setGroups(prev => prev.filter(g => g !== group));
  }, []);

  const handleClearIgnoreList = useCallback(async () => {
    await dupeClearIgnoreList();
    setIgnoredCount(0);
  }, []);

  // Stats
  const totalWaste = useMemo(() => groups.reduce((s, g) => s + g.waste, 0), [groups]);
  const totalFiles = useMemo(() => groups.reduce((s, g) => s + g.files.length, 0), [groups]);

  const allPaths = useMemo(() => groups.flatMap(g => g.files.map(f => f.path)), [groups]);

  const selectAll = () => setSelected(new Set(allPaths));
  const unselectAll = () => setSelected(new Set());
  const invertSelection = () => setSelected(prev => new Set(allPaths.filter(p => !prev.has(p))));
  const keepFirstInEachGroup = () => {
    const toCheck = new Set<string>();
    for (const g of groups) for (let i = 1; i < g.files.length; i++) toCheck.add(g.files[i].path);
    setSelected(toCheck);
  };

  const groupKey = (g: DupeGroupV2) => g.files[0]?.path ?? String(Math.random());

  const toggleFile = (path: string, isRef: boolean) => {
    if (isRef) return;
    setSelected(prev => { const n = new Set(prev); n.has(path) ? n.delete(path) : n.add(path); return n; });
  };
  const toggleGroup = (g: DupeGroupV2) => {
    const eligible = g.files.filter(f => !f.ref).map(f => f.path);
    const allChecked = eligible.length > 0 && eligible.every(p => selected.has(p));
    setSelected(prev => { const n = new Set(prev); allChecked ? eligible.forEach(p => n.delete(p)) : eligible.forEach(p => n.add(p)); return n; });
  };
  const toggleCollapse = (key: string) => setCollapsed(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });

  const deleteSelected = async () => {
    const paths = [...selected];
    if (!paths.length) return;
    const word = deleteMode === "permanent" ? "permanently delete" : "send to Recycle Bin";
    if (!window.confirm(`${word} ${paths.length} file${paths.length > 1 ? "s" : ""}?`)) return;
    const result = await dupeAction("delete", paths, { permanent: deleteMode === "permanent" });
    if (result.errors.length) alert(`Failed:\n${result.errors.join("\n")}`);
    await startScan();
  };

  const moveSelected = async () => {
    const paths = [...selected];
    if (!paths.length || !destPath.trim()) { alert("Select files and set a destination path."); return; }
    const result = await dupeAction("move", paths, { dest: destPath.trim() });
    if (result.errors.length) alert(`Failed:\n${result.errors.join("\n")}`);
    else await startScan();
  };

  const copySelected = async () => {
    const paths = [...selected];
    if (!paths.length || !destPath.trim()) { alert("Select files and set a destination path."); return; }
    const result = await dupeAction("copy", paths, { dest: destPath.trim() });
    if (result.errors.length) alert(`Failed:\n${result.errors.join("\n")}`);
  };

  const exportCsv = () => {
    const lines = ["Role,Name,Path,Size,Last Modified,Score"];
    for (const g of groups)
      for (const f of g.files)
        lines.push(`${f.ref ? "Reference" : "Duplicate"},"${f.name.replace(/"/g, '""')}","${f.path.replace(/"/g, '""')}",${f.size},${f.modified > 0 ? new Date(f.modified * 1000).toISOString() : ""},${g.score}`);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    a.download = "duplicates.csv"; a.click();
  };

  const selectedCount = selected.size;
  const canScan = selectedPaths.length > 0 || hasScan;
  const modeLabel = scanMode === "exact" ? "byte-identical" : scanMode === "filename" ? "similar filename" : "matching audio tags";

  return (
    <div className="df-root">
      {/* ── Sidebar ── */}
      <div className="df-sidebar">
        <div className="df-sidebar-header">
          <span className="df-sidebar-title">Duplicate file search</span>
        </div>

        {/* Scan targets */}
        <ScanTargets
          drives={drives} specialFolders={specialFolders}
          selectedPaths={selectedPaths} customPaths={customPaths}
          onTogglePath={handleTogglePath} onAddCustom={handleAddCustom} onRemoveCustom={handleRemoveCustom}
        />

        {/* Scan mode */}
        <ScanModePanel
          mode={scanMode} onModeChange={setScanMode}
          minScore={minScore} onMinScoreChange={setMinScore}
          weighted={weighted} onWeightedChange={setWeighted}
          mixKinds={mixKinds} onMixKindsChange={setMixKinds}
          activeTags={activeTags} onActiveTagsChange={setActiveTags}
        />

        {/* Quick filters */}
        <div className="df-sidebar-quick">
          <div className="df-section-label">Filters</div>
          <label className="df-quick-row">
            <span className="df-quick-label">Min size</span>
            <input className="df-num-input" type="number" min={0} value={quickMinKb}
              onChange={e => setQuickMinKb(Math.max(0, Number(e.target.value)))} />
            <span className="df-unit">KB</span>
          </label>
          <label className="df-quick-row">
            <span className="df-quick-label">Extensions</span>
            <input className="df-filter-input df-quick-text" type="text" value={extFilter}
              placeholder="mp3,flac" onChange={e => setExtFilter(e.target.value)} />
          </label>
        </div>

        {/* Move / Copy destination */}
        <div className="df-sidebar-quick">
          <div className="df-section-label">Move / Copy destination</div>
          <div className="df-dir-row">
            <input className="df-filter-input df-dir-input" type="text" value={destPath}
              placeholder="D:\Archive" onChange={e => setDestPath(e.target.value)} />
          </div>
        </div>

        {/* Re-prioritize */}
        <div className="df-sidebar-quick">
          <div className="df-section-label">Re-prioritize reference</div>
          <select className="df-select" value={repriCriterion}
            onChange={e => setRepriCriterion(e.target.value as ReprioritizeCriterion)}>
            {REPRIORITIZE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <button className="df-btn df-btn-sm" style={{ marginTop: 6 }}
            onClick={handleReprioritize} disabled={!groups.length || scanState === "scanning"}>
            Apply
          </button>
        </div>

        {/* Ignore list */}
        {ignoredCount > 0 && (
          <div className="df-sidebar-quick">
            <div className="df-section-label">Ignore list</div>
            <div className="df-quick-row" style={{ alignItems: "center" }}>
              <span style={{ flex: 1, fontSize: 12 }}>{ignoredCount} ignored pair{ignoredCount !== 1 ? "s" : ""}</span>
              <button className="df-icon-btn" onClick={handleClearIgnoreList} title="Clear ignore list">✕ Clear</button>
            </div>
          </div>
        )}

        <div className="df-sidebar-footer">
          {scanState === "scanning" ? (
            <button className="df-btn df-btn-stop" onClick={stopScan}>⏹ Stop</button>
          ) : (
            <button className="df-btn df-btn-scan" onClick={() => void startScan()} disabled={!canScan}>
              {selectedPaths.length > 0
                ? `🔍 Scan ${selectedPaths.length} target${selectedPaths.length > 1 ? "s" : ""}`
                : hasScan ? "🔍 Find Duplicates" : "⚠ Select targets or scan first"}
            </button>
          )}
          {selectedPaths.length === 0 && !hasScan && (
            <div className="df-footer-hint">Select drives above or scan a folder from Home first.</div>
          )}
        </div>
      </div>

      {/* ── Main ── */}
      <div className="df-main">
        {/* Toolbar */}
        <div className="df-toolbar">
          <div className="df-toolbar-group">
            <button className="df-tool-btn" onClick={selectAll} disabled={!groups.length}>Check All</button>
            <button className="df-tool-btn" onClick={unselectAll} disabled={!selectedCount}>Uncheck All</button>
            <button className="df-tool-btn" onClick={keepFirstInEachGroup} disabled={!groups.length} title="Check dupes, keep references">Keep First</button>
            <button className="df-tool-btn" onClick={invertSelection} disabled={!groups.length}>Invert</button>
          </div>
          <div className="df-toolbar-sep" />
          <div className="df-toolbar-group">
            <button className="df-tool-btn df-tool-btn-danger" onClick={deleteSelected} disabled={!selectedCount}>🗑 Delete ({selectedCount})</button>
            <select className="df-select df-select-sm" value={deleteMode} onChange={e => setDeleteMode(e.target.value as "recycle" | "permanent")}>
              <option value="recycle">→ Recycle Bin</option>
              <option value="permanent">Permanent</option>
            </select>
          </div>
          <div className="df-toolbar-sep" />
          <div className="df-toolbar-group">
            <button className="df-tool-btn" onClick={moveSelected} disabled={!selectedCount} title="Move to destination path">Move</button>
            <button className="df-tool-btn" onClick={copySelected} disabled={!selectedCount} title="Copy to destination path">Copy</button>
          </div>
          <div className="df-toolbar-sep" />
          <div className="df-toolbar-group">
            <button className="df-tool-btn" onClick={exportCsv} disabled={!groups.length}>Export CSV</button>
          </div>
          {scanMode !== "exact" && groups.length > 0 && (
            <><div className="df-toolbar-sep" /><span className="df-dir-mode-badge">{scanMode === "filename" ? "Filename" : "Audio"} match</span></>
          )}
        </div>

        {/* Column header */}
        <div className="df-col-header">
          <span className="df-col-check-hd" />
          <span className="df-col-role" />
          {scanMode !== "exact" && <span className="df-col-score">Score</span>}
          <span className="df-col-name">Name</span>
          <span className="df-col-size">Size</span>
          <span className="df-col-date">Last Modified</span>
          <span className="df-col-path">Path</span>
          <span className="df-col-actions" />
        </div>

        {/* Results */}
        <div className="df-results">
          {scanState === "idle" && !groups.length && (
            <div className="df-empty">
              <div className="df-empty-icon">⊟</div>
              <div className="df-empty-title">Find duplicate files</div>
              <div className="df-empty-sub">
                {selectedPaths.length > 0
                  ? `${selectedPaths.length} target${selectedPaths.length > 1 ? "s" : ""} selected. Click "Find Duplicates" to scan.`
                  : "Select drives in the sidebar or scan a folder from Home first."}
              </div>
            </div>
          )}

          {scanState === "scanning" && (
            <div className="df-empty">
              <div className="df-scanning-spinner" />
              <div className="df-empty-title">
                {progress?.phase === "hash" ? "Hashing files for duplicates…" : "Scanning for duplicates…"}
              </div>
              <div className="df-empty-sub">
                {progress?.phase === "scan" && progress.filesScanned > 0
                  ? `${progress.filesScanned.toLocaleString()} files found…`
                  : progress?.phase === "hash"
                    ? `${progress.filesScanned.toLocaleString()} files scanned`
                    : selectedPaths.length > 0
                      ? `Scanning ${selectedPaths.join(", ")}…`
                      : "Searching for duplicates…"}
              </div>
              <div className="df-progress-track">
                <div className={`df-progress-bar${progress?.phase === "hash" ? " df-progress-bar-pulse" : " df-progress-bar-sweep"}`} />
              </div>
              {progress && (
                <div className="df-progress-label">
                  {progress.phase === "scan" ? "Scanning filesystem…" : `Hashing ${progress.filesScanned.toLocaleString()} files`}
                </div>
              )}
            </div>
          )}

          {scanState === "error" && (
            <div className="df-empty df-empty-error">
              <div className="df-empty-icon">⚠</div>
              <div className="df-empty-title">Scan failed</div>
              <div className="df-empty-sub">Could not scan the selected paths.</div>
            </div>
          )}

          {scanState === "done" && !groups.length && (
            <div className="df-empty">
              <div className="df-empty-icon">✓</div>
              <div className="df-empty-title">No duplicates found</div>
              <div className="df-empty-sub">No {modeLabel} files matching your filters were found.</div>
            </div>
          )}

          {groups.map(group => {
            const key = groupKey(group);
            const isCollapsed = collapsed.has(key);
            const eligible = group.files.filter(f => !f.ref).map(f => f.path);
            const groupChecked = eligible.length > 0 && eligible.every(p => selected.has(p));
            const groupPartial = !groupChecked && eligible.some(p => selected.has(p));
            const refFile = group.files.find(f => f.ref);

            return (
              <div key={key} className="df-group">
                <div className={`df-group-header${groupChecked ? " df-checked" : ""}${groupPartial ? " df-partial" : ""}`}>
                  <button className="df-twisty" onClick={() => toggleCollapse(key)}>{isCollapsed ? "▶" : "▼"}</button>
                  <input type="checkbox" className="df-checkbox" checked={groupChecked}
                    ref={el => { if (el) el.indeterminate = groupPartial; }}
                    onChange={() => toggleGroup(group)} />
                  <span className="df-col-role" />
                  {scanMode !== "exact" && <span className="df-score-badge">{group.score}%</span>}
                  <span className="df-group-name">{refFile?.name ?? group.files[0]?.name ?? "—"}</span>
                  <span className="df-col-size">{formatBytes(refFile?.size ?? 0, "auto")}</span>
                  <span className="df-group-waste df-col-date">−{formatWaste(group.waste)}</span>
                  <span className="df-col-path df-group-count">{group.files.length} copies</span>
                  <span className="df-col-actions">
                    <button className="df-row-action" title="Ignore this group (won't reappear in future scans)"
                      onClick={() => void handleIgnoreGroup(group)}>✕ Ignore</button>
                  </span>
                </div>

                {!isCollapsed && group.files.map((file: DupeFileV2) => {
                  const isChecked = selected.has(file.path);
                  const isRef = file.ref;

                  return (
                    <div key={file.path} className={`df-file-row${isChecked ? " df-checked" : ""}${isRef ? " df-file-original" : " df-file-copy"}`}>
                      <span className="df-twisty" />
                      <input type="checkbox" className="df-checkbox" checked={isChecked}
                        disabled={isRef} onChange={() => toggleFile(file.path, isRef)} />
                      <span className={`df-role-badge ${isRef ? "df-role-original" : "df-role-copy"}`}>
                        {isRef ? "ref" : "dup"}
                      </span>
                      {scanMode !== "exact" && <span className="df-col-score" />}
                      <span className="df-file-name" title={file.path} onClick={() => onNavigate(0)}>
                        <span className="df-file-icon">{isRef ? "👑" : "📄"}</span>{file.name}
                      </span>
                      <span className="df-col-size">{formatBytes(file.size, "auto")}</span>
                      <span className="df-col-date">{file.modified > 0 ? formatDate(file.modified * 1000) : "—"}</span>
                      <span className="df-file-path df-col-path" title={file.path}>{file.path}</span>
                      <span className="df-col-actions">
                        {!isRef && (
                          <button className="df-row-action" title="Make this the reference file"
                            onClick={() => void handleMakeRef(group, file.path)}>↑ Make Ref</button>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Status bar */}
        <div className="df-statusbar">
          {scanState === "done" && (<>
            <span>{groups.length} group{groups.length !== 1 ? "s" : ""}</span>
            <span className="df-status-sep">·</span>
            <span>{totalFiles} files</span>
            <span className="df-status-sep">·</span>
            <span className="df-waste">{formatWaste(totalWaste)} wasted</span>
            {selectedCount > 0 && (<><span className="df-status-sep">·</span><span>{selectedCount} selected</span></>)}
            {ignoredCount > 0 && (<><span className="df-status-sep">·</span><span className="df-status-ignored">{ignoredCount} ignored</span></>)}
            <span className="df-status-sep">·</span>
            <span className="df-status-mode">{scanMode} mode</span>
          </>)}
          {scanState === "idle" && <span>Ready</span>}
          {scanState === "scanning" && (
            <span>
              {progress?.phase === "scan"
                ? `Scanning… ${progress.filesScanned > 0 ? `${progress.filesScanned.toLocaleString()} files` : ""}`
                : progress?.phase === "hash"
                  ? `Hashing ${progress.filesScanned.toLocaleString()} files…`
                  : "Scanning…"}
            </span>
          )}
          {errors.length > 0 && <span className="df-status-errors">{errors.length} error{errors.length !== 1 ? "s" : ""}</span>}
        </div>
      </div>
    </div>
  );
}
