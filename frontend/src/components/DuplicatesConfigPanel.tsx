import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DriveEntry,
  DupeCriterionKey,
  DupeScopeState,
  ReprioritizeCriterion,
  SpecialFolder,
} from "../api/types";
import { browseDirectories, shellContextMenu, type BrowseDirectoryEntry } from "../api/client";
import type { DuplicatesController } from "../hooks/useDuplicates";
import { DuplicateScanProgress } from "./DuplicateScanProgress";
import { isUnder, normalizeForKey, scopeStateForPath } from "../lib/duplicatesEngine";
import { isPathDrag, readDroppedEntries, resolveDroppedPaths } from "../lib/dropPaths";
import { registerDropZone } from "../lib/dropZones";
import { parentDir } from "../lib/undo";
import { formatBytes } from "../utils/formatBytes";
import { FixedDropdown } from "./ConfigureColumnsMenu";
import { Icon } from "./Icon";
import { Select, type SelectOption } from "./Select";

const REPRIORITIZE_OPTIONS: SelectOption<ReprioritizeCriterion>[] = [
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
const SCOPE_OPTIONS: SelectOption<DupeScopeState>[] = [
  { value: "normal",   label: "Normal" },
  { value: "reference", label: "Reference" },
  { value: "excluded", label: "Excluded" },
];

const OPTIONAL_CRITERIA: { key: Exclude<DupeCriterionKey, "content">; label: string }[] = [
  { key: "size", label: "Size" },
  { key: "name", label: "Filename" },
  { key: "date", label: "Date" },
];

type ScanType = "contents" | "metadata";
const SCAN_TYPES: SelectOption<ScanType>[] = [
  { value: "contents", label: "Content" },
  { value: "metadata", label: "Metadata" },
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
  // Dragging over nested rows fires enter/leave per element, so the highlight is
  // refcounted rather than toggled.
  const [dragActive, setDragActive] = useState(false);
  const dragDepthRef = useRef(0);
  const gridRef = useRef<HTMLDivElement>(null);
  // Folder-tree expansion. Keyed by normalized path so a drive typed as "c:\"
  // and one listed as "C:\" are the same node. The child cache survives a
  // collapse so re-expanding a branch doesn't re-hit the filesystem.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [childLists, setChildLists] = useState<Map<string, ChildList>>(new Map());

  const scanning = ctrl.scanState === "scanning";
  const locked = scanning || ctrl.actionPending;


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
    const listed = [...driveRows, ...folderRows];
    // Saved drive selections survive disconnects. Keep them visible and removable
    // even when the operating system no longer lists the drive.
    for (const path of ctrl.selectedPaths) {
      if (!listed.some((row) => isUnder(path, row.path))) {
        listed.push({ path, kind: "folder", label: path, detail: "Saved scan target (not listed among connected drives)" });
      }
    }
    return listed.filter((row) => !(ctrl.removedPaths ?? []).some((path) => isUnder(row.path, path)));
  }, [ctrl.customPaths, ctrl.selectedPaths, ctrl.removedPaths, drives]);

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

  const scanType: ScanType = ctrl.criteria.content.enabled ? "contents" : "metadata";
  const setScanType = (value: ScanType) => {
    ctrl.setCriterion("content", { enabled: value === "contents", required: value === "contents" });
    if (value === "metadata") {
      ctrl.setCriterion("size", { enabled: true, required: true });
      ctrl.setCriterion("name", { enabled: true, required: true });
    }
  };

  const addFolder = (raw?: string) => {
    const path = (raw ?? input).trim();
    if (!path) return;
    ctrl.addCustomPath(path);
    setActivePath(path);
    if (raw === undefined) setInput("");
  };

  // Drag folders/drives straight onto the list instead of typing a path. A
  // dropped FILE adds the folder containing it, since a scan target is always a
  // directory — dropping a file and getting nothing would just look broken.
  const addDroppedFolders = (entries: { path: string; isDir: boolean }[]) => {
    const folders = new Map<string, string>();
    for (const entry of entries) {
      const folder = entry.isDir ? entry.path : parentDir(entry.path);
      if (folder) folders.set(normalizeForKey(folder), folder);
    }
    for (const folder of folders.values()) addFolder(folder);
  };

  // Shell drags never reach the webview's drop handlers (Tauri consumes them
  // first), so the list registers as a native drop zone too. The HTML5 handlers
  // below still cover drags that start inside the app, which do reach us.
  // Read through a ref so the zone is registered once and never re-registered
  // as this component re-renders.
  const nativeDropRef = useRef<(paths: string[]) => void>(() => {});
  nativeDropRef.current = (paths: string[]) => {
    if (locked) return;
    resolveDroppedPaths(paths)
      .then(addDroppedFolders)
      .catch(() => { /* nothing resolvable in the drop */ });
  };

  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    return registerDropZone(el, {
      onOver: () => setDragActive(true),
      onLeave: () => { dragDepthRef.current = 0; setDragActive(false); },
      onDrop: (paths) => {
        dragDepthRef.current = 0;
        setDragActive(false);
        nativeDropRef.current(paths);
      },
    });
  }, []);

  const onZoneDragEnter = (event: React.DragEvent) => {
    if (locked || !isPathDrag(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  };

  const onZoneDragOver = (event: React.DragEvent) => {
    if (locked || !isPathDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const onZoneDragLeave = (event: React.DragEvent) => {
    if (locked || !isPathDrag(event.dataTransfer)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  };

  const onZoneDrop = (event: React.DragEvent) => {
    dragDepthRef.current = 0;
    setDragActive(false);
    if (locked || !isPathDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    addDroppedFolders(readDroppedEntries(event.dataTransfer));
  };

  const removable = activePath !== null
    && dirRows.some((row) => row.type !== "note" && row.path === activePath);
  const included = ctrl.selectedPaths.length;
  const unlistedFolders = [...specialFolders, ...(ctrl.removedPaths ?? []).map((path) => ({ path, label: path }))].filter(
    (folder) => !roots.some((row) => normalizeForKey(row.path) === normalizeForKey(folder.path)),
  );

  return (
    <div className="dg-page">
      <div className="dg-optbar">
        <label className="dg-field">
        <span>Scan type:</span>
        <Select
          className="dg-select"
          value={scanType}
          options={SCAN_TYPES}
          disabled={locked}
          aria-label="Scan type"
          onChange={setScanType}
        />
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
                title="Read file contents to match exact duplicates"
              >
                Contents
              </span>
              <input type="checkbox" className="df-checkbox" checked={ctrl.criteria.content.enabled} disabled={locked} aria-label="Use Contents" onChange={(event) => setScanType(event.target.checked ? "contents" : "metadata")} />
              <input type="checkbox" className="df-checkbox" checked={ctrl.criteria.content.required} disabled={locked || !ctrl.criteria.content.enabled} aria-label="Require Contents" onChange={(event) => ctrl.setCriterion("content", { required: event.target.checked })} />
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
              <span>Name similarity:</span>
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
            <h3>Keep preference</h3>
            <label className="dg-field dg-field-inline">
              <span>Keep:</span>
              <Select
                className="dg-select"
                value={ctrl.repriCriterion}
                options={REPRIORITIZE_OPTIONS}
                disabled={locked}
                aria-label="Keep"
                onChange={ctrl.setRepriCriterion}
              />
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

      <div
        ref={gridRef}
        className={`dg-grid${dragActive ? " drag-active" : ""}`}
        role="tree"
        aria-label="Folders to scan"
        onDragEnter={onZoneDragEnter}
        onDragOver={onZoneDragOver}
        onDragLeave={onZoneDragLeave}
        onDrop={onZoneDrop}
      >
        {dragActive && (
          <div className="dg-dnd-overlay" aria-hidden="true">
            <div className="dg-dnd-card">
              <Icon name="folder" size={20} />
              <span>Drop to add to the scan</span>
            </div>
          </div>
        )}
        <div className="dg-grid-head" role="presentation">
          <span>Name</span>
          <span>State</span>
        </div>
        <div className="dg-grid-body">
          {dirRows.filter((row) => row.type === "note" || !(ctrl.removedPaths ?? []).some((path) => isUnder(row.path, path))).map((row) => {
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
                onContextMenu={(event) => {
                  event.preventDefault();
                  setActivePath(row.path);
                  void shellContextMenu([row.path], event.clientX, event.clientY);
                }}
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
                  <Select
                    className="dg-cell-select"
                    value={state}
                    options={SCOPE_OPTIONS}
                    disabled={locked}
                    aria-label={`State for ${row.path}`}
                    title={explicit ? undefined : "Inherited from a parent folder"}
                    stopPropagation
                    onChange={(next) => ctrl.setPathState(row.path, next)}
                  />
                  <button type="button" className="dg-icon-btn dg-remove-target"
                    aria-label={`Remove ${row.path} from scan`} title="Remove from scan"
                    disabled={locked}
                    onClick={(event) => { event.stopPropagation(); ctrl.removeCustomPath(row.path); }}>
                    <Icon name="x" size={12} />
                  </button>
                </span>
              </div>
            );
          })}
          {dirRows.length === 0 && (
            <div className="dg-grid-empty">No folders yet. Type a path below or use the + button.</div>
          )}
          {/* Standing target so the list advertises that it takes a drop even
              when nothing is being dragged. */}
          {!locked && (
            <div className="dg-dropzone" role="presentation">
              <Icon name="plus" size={11} />
              <span>Drag folders or drives here to add them</span>
            </div>
          )}
        </div>
      </div>

      <div className="dg-footer">
        <button
          type="button"
          className="dg-icon-btn"
          title="Remove selected target from scan (does not delete files)"
          aria-label="Remove selected target"
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
            <Icon name={addMenuOpen ? "caret-up" : "caret-down"} size={8} />
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

        {ctrl.scanState === "error" && ctrl.errors.length > 0 && (
          <span role="alert" className="dg-status-errors" title={ctrl.errors.join("\n")}>
            Scan failed: {ctrl.errors[0]}
          </span>
        )}
        {scanning ? <DuplicateScanProgress ctrl={ctrl} /> : (
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
