import { useCallback, useMemo, useRef, useState } from "react";
import type {
  DriveEntry,
  DupeCriterionKey,
  DupeScopeState,
  ReprioritizeCriterion,
  SpecialFolder,
} from "../api/types";
import { browseDirectories, type BrowseDirectoryEntry } from "../api/client";
import type { DuplicatesController } from "../hooks/useDuplicates";
import {
  DUPLICATE_SCAN_STEPS,
  activeScanStep,
  hashingDeterminate,
  hashingPercent,
  hashingTitle,
  scanStepStatus,
} from "../lib/duplicatesScanUi";
import { normalizeForKey, scopeStateForPath } from "../lib/duplicatesEngine";
import { formatBytes } from "../utils/formatBytes";
import { FixedDropdown } from "./ConfigureColumnsMenu";
import { Icon } from "./Icon";

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

/** dupeGuru terminology: folders are Normal, Reference or Excluded. */
const SCOPE_OPTIONS: { value: DupeScopeState; label: string }[] = [
  { value: "normal",   label: "Normal" },
  { value: "reference", label: "Reference" },
  { value: "excluded", label: "Excluded" },
];

const OPTIONAL_CRITERIA: { key: Exclude<DupeCriterionKey, "content">; label: string }[] = [
  { key: "size", label: "Size" },
  { key: "name", label: "Filename" },
  { key: "date", label: "Date" },
];

/** Scan types map onto which criteria the grouping pass treats as mandatory. */
type ScanType = "contents" | "contents-name" | "contents-name-date";

const SCAN_TYPES: { value: ScanType; label: string }[] = [
  { value: "contents",           label: "Contents" },
  { value: "contents-name",      label: "Contents + filename" },
  { value: "contents-name-date", label: "Contents + filename + date" },
];

/** Subfolders rendered for one expansion before the row list is truncated. */
const CHILDREN_SHOWN = 500;

interface TargetRow {
  path: string;
  kind: "drive" | "folder";
  label: string;
  detail: string;
}

/** A flattened directory-tree row: either a folder or a status line under one. */
type DirRow =
  | (TargetRow & { type: "dir"; key: string; depth: number; root: boolean; hidden: boolean })
  | { type: "note"; key: string; depth: number; text: string };

/** Lazily fetched immediate subfolders for one expanded folder. */
type ChildList =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; entries: BrowseDirectoryEntry[] };

export function DuplicatesConfigPanel({
  ctrl,
  drives,
  specialFolders,
}: {
  ctrl: DuplicatesController;
  drives: DriveEntry[];
  specialFolders: SpecialFolder[];
}) {
  const [input, setInput] = useState("");
  const [moreOptions, setMoreOptions] = useState(false);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement>(null);
  // Folder-tree expansion. Keyed by normalized path so a drive typed as "c:\"
  // and one listed as "C:\" are the same node. The child cache survives a
  // collapse so re-expanding a branch doesn't re-hit the filesystem.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [childLists, setChildLists] = useState<Map<string, ChildList>>(new Map());

  const scanning = ctrl.scanState === "scanning";
  const locked = scanning || ctrl.actionPending;
  const hashedPct = hashingPercent(ctrl.progress);
  const activeStep = activeScanStep(ctrl.phase, ctrl.progress.stage);
  const determinate = hashingDeterminate(ctrl.phase, ctrl.progress);

  const roots = useMemo<TargetRow[]>(() => {
    const drivePaths = new Set(drives.map((drive) => normalizeForKey(drive.root)));
    const driveRows: TargetRow[] = drives.map((drive) => ({
      path: drive.root,
      kind: "drive",
      label: drive.root,
      detail: [
        drive.label,
        drive.total > 0
          ? `${formatBytes(drive.free, "auto")} free of ${formatBytes(drive.total, "auto")}`
          : "",
      ].filter(Boolean).join(" · "),
    }));
    const folderRows: TargetRow[] = ctrl.customPaths
      .filter((path) => !drivePaths.has(normalizeForKey(path)))
      .map((path) => ({ path, kind: "folder", label: path, detail: "" }));
    return [...driveRows, ...folderRows];
  }, [ctrl.customPaths, drives]);

  const loadChildren = useCallback(async (path: string) => {
    const key = normalizeForKey(path);
    setChildLists((prev) => new Map(prev).set(key, { status: "loading" }));
    try {
      const entries = await browseDirectories(path);
      setChildLists((prev) => new Map(prev).set(key, { status: "ready", entries }));
    } catch (error) {
      setChildLists((prev) => new Map(prev).set(key, {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  }, []);

  const toggleExpand = useCallback((path: string) => {
    const key = normalizeForKey(path);
    const opening = !expanded.has(key);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (opening) next.add(key); else next.delete(key);
      return next;
    });
    if (opening && !childLists.has(key)) void loadChildren(path);
  }, [childLists, expanded, loadChildren]);

  // Depth-first flatten of the expanded branches. Children come from the browse
  // cache, so a folder that is expanded but still loading renders a status row.
  const dirRows = useMemo<DirRow[]>(() => {
    const out: DirRow[] = [];
    const walk = (rows: TargetRow[], depth: number, root: boolean, hidden: boolean) => {
      for (const row of rows) {
        const key = normalizeForKey(row.path);
        out.push({ ...row, type: "dir", key, depth, root, hidden });
        if (!expanded.has(key)) continue;
        const list = childLists.get(key);
        if (!list || list.status === "loading") {
          out.push({ type: "note", key: `${key}|loading`, depth: depth + 1, text: "Reading folder…" });
          continue;
        }
        if (list.status === "error") {
          out.push({ type: "note", key: `${key}|error`, depth: depth + 1, text: list.message });
          continue;
        }
        if (list.entries.length === 0) {
          out.push({ type: "note", key: `${key}|empty`, depth: depth + 1, text: "No subfolders" });
          continue;
        }
        for (const entry of list.entries.slice(0, CHILDREN_SHOWN)) {
          walk(
            [{ path: entry.path, kind: "folder", label: entry.name, detail: "" }],
            depth + 1,
            false,
            hidden || entry.hidden,
          );
        }
        if (list.entries.length > CHILDREN_SHOWN) {
          out.push({
            type: "note",
            key: `${key}|more`,
            depth: depth + 1,
            text: `${(list.entries.length - CHILDREN_SHOWN).toLocaleString()} more subfolders not shown`,
          });
        }
      }
    };
    walk(roots, 0, true, false);
    return out;
  }, [childLists, expanded, roots]);

  // Paths the user has given a state of their own. Every other row inherits
  // from its nearest configured ancestor, the way dupeGuru's tree does.
  const explicitPaths = useMemo(
    () => new Set(ctrl.scopeRules.map((rule) => normalizeForKey(rule.path))),
    [ctrl.scopeRules],
  );

  const scanType: ScanType = ctrl.criteria.name.required
    ? (ctrl.criteria.date.required ? "contents-name-date" : "contents-name")
    : "contents";

  const setScanType = (value: ScanType) => {
    ctrl.setCriterion("name", {
      enabled: value !== "contents" ? true : ctrl.criteria.name.enabled,
      required: value !== "contents",
    });
    ctrl.setCriterion("date", {
      enabled: value === "contents-name-date" ? true : ctrl.criteria.date.enabled,
      required: value === "contents-name-date",
    });
  };

  const addFolder = (raw?: string) => {
    const path = (raw ?? input).trim();
    if (!path) return;
    ctrl.addCustomPath(path);
    setActivePath(path);
    if (raw === undefined) setInput("");
  };

  const removable = activePath !== null
    && roots.some((row) => row.kind === "folder" && row.path === activePath);
  const included = ctrl.selectedPaths.length;
  const unlistedFolders = specialFolders.filter(
    (folder) => !roots.some((row) => normalizeForKey(row.path) === normalizeForKey(folder.path)),
  );

  return (
    <div className="dg-page">
      <div className="dg-optbar">
        <label className="dg-field">
          <span>Scan type:</span>
          <select
            className="dg-select"
            value={scanType}
            disabled={locked}
            onChange={(event) => setScanType(event.target.value as ScanType)}
          >
            {SCAN_TYPES.map((type) => (
              <option key={type.value} value={type.value}>{type.label}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={`dg-btn${moreOptions ? " dg-btn-on" : ""}`}
          aria-expanded={moreOptions}
          onClick={() => setMoreOptions((open) => !open)}
        >
          More Options
        </button>
        <div className="dg-spacer" />
        <span className="dg-note">
          {included === 0 ? "No folders selected" : `${included} folder${included === 1 ? "" : "s"} to scan`}
        </span>
      </div>

      {moreOptions && (
        <div className="dg-options">
          <section className="dg-optgroup">
            <h3>Match criteria</h3>
            <div className="dg-crit">
              <span className="dg-crit-head" />
              <span className="dg-crit-head">Use</span>
              <span className="dg-crit-head">Required</span>
              <span
                className="dg-crit-name"
                title="Byte-identical content is always required, and re-checked before any file action"
              >
                Contents
              </span>
              <input type="checkbox" className="df-checkbox" checked disabled aria-label="Contents always used" />
              <input type="checkbox" className="df-checkbox" checked disabled aria-label="Contents always required" />
              {OPTIONAL_CRITERIA.map((criterion) => {
                const state = ctrl.criteria[criterion.key];
                return [
                  <span key={`${criterion.key}-name`} className="dg-crit-name">{criterion.label}</span>,
                  <input
                    key={`${criterion.key}-use`}
                    type="checkbox"
                    className="df-checkbox"
                    checked={state.enabled}
                    disabled={locked}
                    aria-label={`Use ${criterion.label}`}
                    onChange={(event) => ctrl.setCriterion(criterion.key, { enabled: event.target.checked })}
                  />,
                  <input
                    key={`${criterion.key}-req`}
                    type="checkbox"
                    className="df-checkbox"
                    checked={state.required}
                    disabled={locked || !state.enabled}
                    aria-label={`Require ${criterion.label}`}
                    onChange={(event) => ctrl.setCriterion(criterion.key, { required: event.target.checked })}
                  />,
                ];
              })}
            </div>
            <label className="dg-check">
              <input
                type="checkbox"
                className="df-checkbox"
                checked={ctrl.criteria.nameFuzzy}
                disabled={locked || !ctrl.criteria.name.enabled}
                onChange={(event) => ctrl.setNameFuzzy(event.target.checked)}
              />
              <span>Match similar filenames</span>
            </label>
            <label className="dg-field dg-field-inline">
              <span>Filter hardness:</span>
              <input
                type="range"
                min={50}
                max={100}
                value={ctrl.criteria.nameThreshold}
                disabled={locked || !ctrl.criteria.nameFuzzy}
                onChange={(event) => ctrl.setNameThreshold(Number(event.target.value))}
              />
              <output>{ctrl.criteria.nameThreshold}%</output>
            </label>
            <label className="dg-field dg-field-inline">
              <span>Date tolerance:</span>
              <input
                className="dg-input dg-input-num"
                type="number"
                min={0}
                value={ctrl.criteria.dateToleranceSec}
                disabled={locked || !ctrl.criteria.date.enabled}
                onChange={(event) => ctrl.setDateToleranceSec(Math.max(0, Number(event.target.value)))}
              />
              <span className="dg-unit">sec</span>
            </label>
          </section>

          <section className="dg-optgroup">
            <h3>Filters</h3>
            <label className="dg-field dg-field-inline">
              <span>Minimum size:</span>
              <input
                className="dg-input dg-input-num"
                type="number"
                min={0}
                value={ctrl.minSizeKb}
                disabled={locked}
                onChange={(event) => ctrl.setMinSizeKb(Math.max(0, Number(event.target.value)))}
              />
              <span className="dg-unit">KB</span>
            </label>
            <label className="dg-field dg-field-inline">
              <span>Maximum size:</span>
              <input
                className="dg-input dg-input-num"
                type="number"
                min={0}
                value={ctrl.maxSizeKb}
                placeholder="none"
                disabled={locked}
                onChange={(event) => ctrl.setMaxSizeKb(event.target.value)}
              />
              <span className="dg-unit">KB</span>
            </label>
            <label className="dg-field dg-field-inline" title="Comma-separated list; all types are scanned when empty">
              <span>Extensions:</span>
              <input
                className="dg-input"
                type="text"
                value={ctrl.extensions}
                placeholder="jpg,png,mp3"
                spellCheck={false}
                disabled={locked}
                onChange={(event) => ctrl.setExtensions(event.target.value)}
              />
            </label>
            <label className="dg-check">
              <input
                type="checkbox"
                className="df-checkbox"
                checked={ctrl.includeHidden}
                disabled={locked}
                onChange={(event) => ctrl.setIncludeHidden(event.target.checked)}
              />
              <span>Include hidden and system files</span>
            </label>
          </section>

          <section className="dg-optgroup">
            <h3>Re-prioritize</h3>
            <label className="dg-field dg-field-inline">
              <span>Keep:</span>
              <select
                className="dg-select"
                value={ctrl.repriCriterion}
                disabled={locked}
                onChange={(event) => ctrl.setRepriCriterion(event.target.value as ReprioritizeCriterion)}
              >
                {REPRIORITIZE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="dg-btn"
              onClick={ctrl.reprioritizeApply}
              disabled={!ctrl.groups.length || scanning}
            >
              Apply to results
            </button>
            {ctrl.ignoredCount > 0 && (
              <button type="button" className="dg-btn" onClick={ctrl.restoreIgnoredGroups}>
                Restore {ctrl.ignoredCount} ignored group{ctrl.ignoredCount === 1 ? "" : "s"}
              </button>
            )}
          </section>
        </div>
      )}

      <p className="dg-hint">
        Expand a drive to set a state per subfolder, then press &ldquo;Scan&rdquo;. Subfolders
        inherit their parent&rsquo;s state until you change them.
      </p>

      <div className="dg-grid" role="tree" aria-label="Folders to scan">
        <div className="dg-grid-head" role="presentation">
          <span>Name</span>
          <span>State</span>
        </div>
        <div className="dg-grid-body">
          {dirRows.map((row) => {
            if (row.type === "note") {
              return (
                <div
                  key={row.key}
                  className="dg-grid-note"
                  role="treeitem"
                  aria-level={row.depth + 1}
                  style={{ paddingLeft: 8 + row.depth * 15 }}
                >
                  {row.text}
                </div>
              );
            }
            const state = scopeStateForPath(row.path, ctrl.scopeRules) ?? "excluded";
            const explicit = explicitPaths.has(row.key);
            const open = expanded.has(row.key);
            const active = activePath === row.path;
            return (
              <div
                key={row.key}
                className={[
                  "dg-grid-row",
                  `dg-state-${state}`,
                  explicit ? "" : "dg-state-inherited",
                  row.hidden ? "dg-row-hidden" : "",
                  active ? "active" : "",
                ].filter(Boolean).join(" ")}
                role="treeitem"
                tabIndex={0}
                aria-level={row.depth + 1}
                aria-expanded={open}
                aria-selected={active}
                onFocus={() => setActivePath(row.path)}
                onClick={() => setActivePath(row.path)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowRight" && !open) toggleExpand(row.path);
                  else if (event.key === "ArrowLeft" && open) toggleExpand(row.path);
                  else return;
                  event.preventDefault();
                }}
              >
                <span className="dg-cell dg-cell-name" title={row.path}>
                  {row.depth > 0 && (
                    <span className="dg-indent" style={{ width: row.depth * 15 }} aria-hidden="true" />
                  )}
                  <button
                    type="button"
                    className="dg-dir-twisty"
                    aria-label={`${open ? "Collapse" : "Expand"} ${row.label}`}
                    onClick={(event) => { event.stopPropagation(); toggleExpand(row.path); }}
                  >
                    <Icon name={open ? "chevron-down" : "chevron-right"} size={9} />
                  </button>
                  <Icon name={row.kind === "drive" ? "hdd" : "folder"} size={12} />
                  <span className="dg-cell-label">{row.label}</span>
                  {row.detail && <small>{row.detail}</small>}
                </span>
                <span className="dg-cell">
                  <select
                    className="dg-cell-select"
                    value={state}
                    disabled={locked}
                    aria-label={`State for ${row.path}`}
                    title={explicit ? undefined : "Inherited from a parent folder"}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => ctrl.setPathState(row.path, event.target.value as DupeScopeState)}
                  >
                    {SCOPE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </span>
              </div>
            );
          })}
          {dirRows.length === 0 && (
            <div className="dg-grid-empty">No folders yet. Type a path below or use the + button.</div>
          )}
        </div>
      </div>

      <div className="dg-footer">
        <button
          type="button"
          className="dg-icon-btn"
          title="Remove the selected folder"
          aria-label="Remove selected folder"
          disabled={locked || !removable}
          onClick={() => {
            if (activePath) ctrl.removeCustomPath(activePath);
            setActivePath(null);
          }}
        >
          <Icon name="dash" size={12} />
        </button>
        <div className="rb-dropdown-wrap" ref={addMenuRef}>
          <button
            type="button"
            className="dg-icon-btn"
            title="Add a known folder"
            aria-label="Add a known folder"
            aria-expanded={addMenuOpen}
            disabled={locked || unlistedFolders.length === 0}
            onClick={() => setAddMenuOpen((open) => !open)}
          >
            <Icon name="plus" size={12} />
            <Icon name="caret-down" size={8} />
          </button>
          <FixedDropdown anchorRef={addMenuRef} open={addMenuOpen} onClose={() => setAddMenuOpen(false)}>
            <div className="rb-dd-section">Known folders</div>
            {unlistedFolders.map((folder) => (
              <button
                key={folder.path}
                className="rb-col-row"
                title={folder.path}
                onClick={() => { addFolder(folder.path); setAddMenuOpen(false); }}
              >
                <span>{folder.label}</span>
              </button>
            ))}
          </FixedDropdown>
        </div>
        <input
          className="dg-input dg-footer-path"
          type="text"
          value={input}
          disabled={locked}
          placeholder="C:\path\to\folder"
          spellCheck={false}
          aria-label="Folder path to add"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && addFolder()}
        />
        <button
          type="button"
          className="dg-btn"
          disabled={locked || !input.trim()}
          onClick={() => addFolder()}
        >
          Add
        </button>

        <div className="dg-spacer" />

        {scanning ? (
          <div className="dg-scan" role="status" aria-live="polite">
            <div className="dg-scan-steps">
              {DUPLICATE_SCAN_STEPS.map((step) => (
                <span key={step.id} className={`dg-scan-step ${scanStepStatus(step.id, activeStep)}`}>
                  {step.label}
                </span>
              ))}
            </div>
            <div className="dg-scan-line">
              <span className="dg-scan-text">
                {hashingTitle(ctrl.phase, ctrl.progress)}
                {" · "}
                {ctrl.phase === "hashing" && ctrl.progress.hashing > 0
                  ? `${ctrl.progress.hashing.toLocaleString()} candidates, ${hashedPct}%`
                  : ctrl.progress.scanned > 0
                    ? `${ctrl.progress.scanned.toLocaleString()} indexed`
                    : "starting"}
              </span>
              <div
                className="df-progress-track dg-scan-track"
                role="progressbar"
                aria-label="Duplicate scan progress"
                aria-valuemin={0}
                aria-valuemax={ctrl.phase === "hashing" ? ctrl.progress.hashing : undefined}
                aria-valuenow={ctrl.phase === "hashing" ? ctrl.progress.hashed : undefined}
                aria-valuetext={
                  ctrl.phase === "hashing" && ctrl.progress.hashing > 0
                    ? `${hashedPct}% of ${ctrl.progress.hashing} candidates processed`
                    : ctrl.progress.scanned > 0
                      ? `${ctrl.progress.scanned} items indexed`
                      : "Starting scan"
                }
              >
                <div
                  className={`df-progress-bar ${determinate ? "df-progress-bar-determinate" : "df-progress-bar-sweep"}`}
                  style={determinate
                    ? { width: `${Math.min(100, (ctrl.progress.hashed / ctrl.progress.hashing) * 100)}%` }
                    : undefined}
                />
              </div>
            </div>
            <button type="button" className="dg-btn dg-btn-danger" onClick={ctrl.stopScan}>Stop</button>
          </div>
        ) : (
          <button
            type="button"
            className="dg-btn dg-btn-default"
            onClick={ctrl.startScan}
            disabled={!ctrl.canScan || ctrl.actionPending}
          >
            Scan
          </button>
        )}
      </div>
    </div>
  );
}
