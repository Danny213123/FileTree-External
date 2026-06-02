import { useState } from "react";
import type { DriveEntry, DupeCriterionKey, ReprioritizeCriterion, SpecialFolder } from "../api/types";
import type { DuplicatesController } from "../hooks/useDuplicates";
import { Icon } from "./Icon";
import { DriveCapacityBar } from "./DriveCapacityBar";

const REPRIORITIZE_OPTIONS: { value: ReprioritizeCriterion; label: string }[] = [
  { value: "largest",      label: "Largest file" },
  { value: "smallest",     label: "Smallest file" },
  { value: "newest",       label: "Newest modified" },
  { value: "oldest",       label: "Oldest modified" },
  { value: "shortestPath", label: "Shortest path" },
  { value: "longestPath",  label: "Longest path" },
  { value: "alphaFirst",   label: "A-Z filename" },
  { value: "alphaLast",    label: "Z-A filename" },
];

const CRITERIA: { key: DupeCriterionKey; label: string; hint: string }[] = [
  { key: "content", label: "Content", hint: "byte-identical (hash + verify)" },
  { key: "size",    label: "Size",    hint: "same byte length" },
  { key: "name",    label: "Name",    hint: "same / similar filename" },
  { key: "date",    label: "Date",    hint: "same last-modified time" },
];

interface ScanTargetsProps {
  drives: DriveEntry[];
  selectedPaths: string[];
  customPaths: string[];
  onToggle: (p: string) => void;
  onAddCustom: (p: string) => void;
  onRemoveCustom: (p: string) => void;
}

function ScanTargets({ drives, selectedPaths, customPaths, onToggle, onAddCustom, onRemoveCustom }: ScanTargetsProps) {
  const [expanded, setExpanded] = useState(true);
  const [input, setInput] = useState("");
  const drivePaths = drives.map((d) => d.root);
  const selectedSet = new Set(selectedPaths);

  const add = () => {
    const p = input.trim();
    if (!p) return;
    onAddCustom(p);
    setInput("");
  };

  return (
    <div className="df-targets">
      <button className="df-targets-header" onClick={() => setExpanded((v) => !v)}>
        <span className="df-section-label" style={{ margin: 0 }}>Scan targets</span>
        <span className="df-targets-summary">
          {selectedPaths.length === 0 ? "none selected" : selectedPaths.map((p) => p.replace(/\\$/, "")).join(", ")}
        </span>
        <span className="df-targets-arrow">{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div className="df-targets-body">
          {drives.map((d) => (
            <label key={d.root} className="df-target-row df-target-drive">
              <span className="df-target-main">
                <input type="checkbox" className="df-checkbox" checked={selectedSet.has(d.root)} onChange={() => onToggle(d.root)} />
                <span className="df-target-icon"><Icon name="hdd" size={13} /></span>
                <span className="df-target-path">{d.root}</span>
                {d.label && <span className="df-target-label">{d.label}</span>}
              </span>
              <DriveCapacityBar total={d.total} free={d.free} />
            </label>
          ))}
          {customPaths.filter((p) => !drivePaths.includes(p)).map((p) => (
            <label key={p} className="df-target-row">
              <input type="checkbox" className="df-checkbox" checked={selectedSet.has(p)} onChange={() => onToggle(p)} />
              <span className="df-target-icon"><Icon name="folder" size={13} /></span>
              <span className="df-target-path">{p}</span>
              <button className="df-filter-remove" onClick={(e) => { e.preventDefault(); onRemoveCustom(p); }} title="Remove">✕</button>
            </label>
          ))}
          <div className="df-target-add">
            <input
              className="df-filter-input"
              type="text"
              value={input}
              placeholder="Add folder path…"
              spellCheck={false}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
            />
            <button className="df-icon-btn" onClick={add} title="Add path">＋</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function DuplicatesConfigPanel({
  ctrl,
  drives,
  specialFolders,
}: {
  ctrl: DuplicatesController;
  drives: DriveEntry[];
  specialFolders: SpecialFolder[];
}) {
  const scanning = ctrl.scanState === "scanning";
  const phaseLabel =
    ctrl.phase === "aggregating" ? "Reading file lists…"
    : ctrl.phase === "hashing" ? `Hashing ${ctrl.progress.hashed.toLocaleString()} / ${ctrl.progress.hashing.toLocaleString()}`
    : ctrl.phase === "grouping" ? "Grouping matches…"
    : "";

  // Quick-add the user's special folders (Documents, Pictures, …) as targets.
  const quickFolders = specialFolders.slice(0, 8);

  return (
    <div className="df-config">
      <ScanTargets
        drives={drives}
        selectedPaths={ctrl.selectedPaths}
        customPaths={ctrl.customPaths}
        onToggle={ctrl.togglePath}
        onAddCustom={ctrl.addCustomPath}
        onRemoveCustom={ctrl.removeCustomPath}
      />

      {quickFolders.length > 0 && (
        <div className="df-sidebar-quick">
          <div className="df-section-label">Quick add</div>
          <div className="df-quick-chips">
            {quickFolders.map((f) => {
              const on = ctrl.selectedPaths.includes(f.path);
              return (
                <button
                  key={f.path}
                  className={`df-chip${on ? " df-chip-on" : ""}`}
                  title={f.path}
                  onClick={() => (on ? ctrl.removeCustomPath(f.path) : ctrl.addCustomPath(f.path))}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Match criteria */}
      <div className="df-sidebar-quick">
        <div className="df-section-label">Match criteria</div>
        <div className="df-crit-head">
          <span className="df-crit-head-spacer" />
          <span className="df-crit-head-col" title="Include this criterion in matching & show its delta column">use</span>
          <span className="df-crit-head-col" title="Duplicates must match the reference on this criterion">req</span>
        </div>
        {CRITERIA.map((c) => {
          const st = ctrl.criteria[c.key];
          return (
            <div key={c.key} className="df-crit-row">
              <span className="df-crit-name" title={c.hint}>
                {c.label}
                <span className="df-crit-hint">{c.hint}</span>
              </span>
              <label className="df-crit-box" title="Use this criterion">
                <input type="checkbox" className="df-checkbox" checked={st.enabled}
                  onChange={(e) => ctrl.setCriterion(c.key, { enabled: e.target.checked })} />
              </label>
              <label className="df-crit-box" title="Required to match">
                <input type="checkbox" className="df-checkbox" checked={st.required} disabled={!st.enabled}
                  onChange={(e) => ctrl.setCriterion(c.key, { required: e.target.checked })} />
              </label>
            </div>
          );
        })}

        {ctrl.criteria.name.enabled && (
          <div className="df-crit-sub">
            <label className="df-mode-opt-row">
              <input type="checkbox" className="df-checkbox" checked={ctrl.criteria.nameFuzzy}
                onChange={(e) => ctrl.setNameFuzzy(e.target.checked)} />
              <span style={{ marginLeft: 6 }}>Fuzzy filename</span>
            </label>
            {ctrl.criteria.nameFuzzy && (
              <div className="df-mode-opt-row">
                <span className="df-quick-label">Threshold</span>
                <input type="range" min={50} max={100} value={ctrl.criteria.nameThreshold}
                  onChange={(e) => ctrl.setNameThreshold(Number(e.target.value))} style={{ flex: 1 }} />
                <span className="df-unit">{ctrl.criteria.nameThreshold}%</span>
              </div>
            )}
          </div>
        )}

        {ctrl.criteria.date.enabled && (
          <div className="df-crit-sub">
            <label className="df-quick-row">
              <span className="df-quick-label">Date tolerance</span>
              <input className="df-num-input" type="number" min={0} value={ctrl.criteria.dateToleranceSec}
                onChange={(e) => ctrl.setDateToleranceSec(Math.max(0, Number(e.target.value)))} />
              <span className="df-unit">sec</span>
            </label>
          </div>
        )}

        {!ctrl.criteria.content.enabled && (
          <div className="df-footer-hint" style={{ textAlign: "left", marginTop: 6 }}>
            Content off — matching by metadata only (no hashing). Enable a Size/Name/Date criterion as the key.
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="df-sidebar-quick">
        <div className="df-section-label">Filters</div>
        <label className="df-quick-row">
          <span className="df-quick-label">Min size</span>
          <input className="df-num-input" type="number" min={0} value={ctrl.minSizeKb}
            onChange={(e) => ctrl.setMinSizeKb(Math.max(0, Number(e.target.value)))} />
          <span className="df-unit">KB</span>
        </label>
        <label className="df-quick-row">
          <span className="df-quick-label">Max size</span>
          <input className="df-num-input" type="number" min={0} value={ctrl.maxSizeKb} placeholder="∞"
            onChange={(e) => ctrl.setMaxSizeKb(e.target.value)} />
          <span className="df-unit">KB</span>
        </label>
        <label className="df-quick-row">
          <span className="df-quick-label">Extensions</span>
          <input className="df-filter-input df-quick-text" type="text" value={ctrl.extensions}
            placeholder="jpg,png,mp3" spellCheck={false} onChange={(e) => ctrl.setExtensions(e.target.value)} />
        </label>
        <label className="df-mode-opt-row">
          <input type="checkbox" className="df-checkbox" checked={ctrl.includeHidden}
            onChange={(e) => ctrl.setIncludeHidden(e.target.checked)} />
          <span style={{ marginLeft: 6 }}>Include hidden files</span>
        </label>
      </div>

      {/* Move / Copy destination */}
      <div className="df-sidebar-quick">
        <div className="df-section-label">Move / Copy destination</div>
        <div className="df-dir-row">
          <input className="df-filter-input df-dir-input" type="text" value={ctrl.destPath}
            placeholder="D:\Archive" spellCheck={false} onChange={(e) => ctrl.setDestPath(e.target.value)} />
        </div>
      </div>

      {/* Re-prioritize */}
      <div className="df-sidebar-quick">
        <div className="df-section-label">Reference file</div>
        <select className="df-select" value={ctrl.repriCriterion}
          onChange={(e) => ctrl.setRepriCriterion(e.target.value as ReprioritizeCriterion)}>
          {REPRIORITIZE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <button className="df-btn df-btn-sm" style={{ marginTop: 6 }}
          onClick={ctrl.reprioritizeApply} disabled={!ctrl.groups.length || scanning}>
          Re-prioritize references
        </button>
      </div>

      {/* Ignore list */}
      {ctrl.ignoredCount > 0 && (
        <div className="df-sidebar-quick">
          <div className="df-section-label">Ignore list</div>
          <div className="df-quick-row" style={{ alignItems: "center" }}>
            <span style={{ flex: 1, fontSize: 12 }}>{ctrl.ignoredCount} ignored</span>
            <button className="df-icon-btn" onClick={ctrl.clearIgnoreList} title="Clear ignore list">Clear</button>
          </div>
        </div>
      )}

      <div className="df-sidebar-footer">
        {scanning ? (
          <button className="df-btn df-btn-stop" onClick={ctrl.stopScan}>■ Stop</button>
        ) : (
          <button className="df-btn df-btn-scan" onClick={ctrl.startScan} disabled={!ctrl.canScan}>
            {ctrl.canScan
              ? `Find duplicates in ${ctrl.selectedPaths.length} target${ctrl.selectedPaths.length > 1 ? "s" : ""}`
              : "Select targets to scan"}
          </button>
        )}
        {scanning && phaseLabel && <div className="df-footer-hint">{phaseLabel}</div>}
        {!ctrl.canScan && !scanning && (
          <div className="df-footer-hint">Tick a drive or add a folder above. Already-open tabs are reused — no rescan needed.</div>
        )}
      </div>
    </div>
  );
}
