import { useState, useMemo, useEffect, useRef, type ReactNode } from "react";
import type { ViewId } from "./ActivityBar";
import type { DriveEntry, NodeRecord, ScanResult, SpecialFolder, Unit, TagEntry, SmartFolder } from "../api/types";
import { BookmarksTab } from "./BookmarksTab";
import { ErrorsTab } from "./ErrorsTab";
import { FileIcon } from "./FileIcon";
import { Icon } from "./Icon";
import { Select } from "./Select";
import { DriveCapacityBar } from "./DriveCapacityBar";
import { PathPicker, splitPath } from "./PathPicker";
import type { DuplicatesController } from "../hooks/useDuplicates";
import {
  DUPLICATE_SCAN_STEPS,
  activeScanStep,
  hashingDeterminate,
  hashingPercent,
  hashingTitle,
  scanStepStatus,
} from "../lib/duplicatesScanUi";
import {
  compileNameMatcher, makeFilterPredicate, filtersActive, toServerSearchParams,
  EMPTY_FILTERS, FILE_CATEGORIES, AGE_PRESETS,
  type SearchFilters,
} from "../lib/search";
import { getAllCached } from "../lib/scanCache";
import { exportResults } from "../lib/exportRows";
import { revealPath, copyText, shellContextMenu, fetchServerSearch } from "../api/client";
import { compareNodes } from "../hooks/useTreeState";
import { loadPresets, addPreset, removePreset, type ScanPreset } from "../lib/scanPresets";
import { loadRecentPaths } from "./RibbonBar";
import { promptDialog } from "../lib/dialogs";
import { toast } from "../lib/toast";

const VIEW_TITLES: Record<ViewId, string> = {
  plugins: "Plugins",
  explorer: "Explorer",
  search: "Search",
  duplicates: "Duplicates",
  compress: "Compress",
  bookmarks: "Bookmarks",
  errors: "Problems",
};

/** Label on the side bar's primary action, per view. */
const SCAN_LABELS: Partial<Record<ViewId, string>> = {
  explorer: "Scan",
  compress: "Scan",
  duplicates: "Index",
};

// ── Shared side-bar primitives ───────────────────────────────────────────────
// One collapsible group heading and one row shape, so Explorer, Compress and
// Duplicates all read as the same panel instead of three different ones.

function SideSection({
  label, defaultOpen = true, open: openProp, onToggle, children,
}: {
  label: string;
  defaultOpen?: boolean;
  /** Set both to drive the section from outside (the folder tree needs the
   *  open flag to size its virtualizer). Omit for a self-managed section. */
  open?: boolean;
  onToggle?: (open: boolean) => void;
  children: ReactNode;
}) {
  const [openLocal, setOpenLocal] = useState(defaultOpen);
  const open = openProp ?? openLocal;
  return (
    <>
      <button
        type="button"
        className={`sb-section${open ? "" : " collapsed"}`}
        aria-expanded={open}
        onClick={() => (onToggle ? onToggle(!open) : setOpenLocal(!open))}
      >
        <span className="sb-section-chev"><Icon name="chevron-down" size={9} /></span>
        <span className="sb-section-label">{label}</span>
      </button>
      {open && children}
    </>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="sb-stat">
      <span className="sb-stat-value">{value}</span>
      <span className="sb-stat-label">{label}</span>
    </div>
  );
}

/** Last path segment, for chips and compact labels. */
function leafName(path: string): string {
  return splitPath(path).name || path;
}

function fmtSize(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`;
  return `${bytes} B`;
}

export interface SideBarProps {
  view: ViewId;
  // shared scan data
  data: ScanResult | null;
  nodeById: Map<number, NodeRecord>;
  unit: Unit;
  // search (activity-bar Search view): the input is controlled by App's lifted
  // searchQuery so the sidebar list and the main-area results table stay in sync.
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  // Inline filters + regex toggle (#31), history (#33), and select-all results
  // (#35). All lifted in App so the pane's flat results table stays in sync
  // with what this sidebar Search view shows.
  searchFilters: SearchFilters;
  onSearchFiltersChange: (f: SearchFilters) => void;
  searchHistory: string[];
  onClearSearchHistory: () => void;
  onSelectAllSearchResults: (paths: string[]) => void;
  /** Every OPEN tab's scan, so Search spans all of them and not just the
   *  focused pane. Separate from the 60s scanCache, which expires too fast to
   *  answer "search everything I've scanned". */
  getOpenScans: () => { root: string; nodes: Iterable<NodeRecord> }[];
  onNavigate: (id: number) => void;
  // explorer: scan controls
  scanPath: string;
  scanning: boolean;
  onScanPathInput: (p: string) => void;
  onScan: () => void;
  onCancel: () => void;
  onRefresh: () => void;
  onUp: () => void;
  onNewFolder: () => void;
  onCollapseAll: () => void;
  // explorer: locations
  drives: DriveEntry[];
  specialFolders: SpecialFolder[];
  bookmarkList: string[];
  onOpenLocation: (path: string) => void;
  // explorer: folder tree (reuses the active tab's tree state)
  treeRows: NodeRecord[];
  expanded: Set<number>;
  expandedAll: boolean;
  collapsedOverrides: Set<number>;
  selectedId: number;
  onToggleExpand: (id: number) => void;
  onSelectFolder: (id: number) => void;
  // details
  selectedNode: NodeRecord | undefined;
  onOpen: () => void;
  onReveal: () => void;
  onCopyPath: () => void;
  // bookmarks
  onScanPath: (p: string) => void;
  onRemoveBookmark: (p: string) => void;
  // tags (F4): the full tag list (to aggregate the sidebar Tags list), the active
  // tag filter, and a setter that filters the focused tree to a tag (null clears).
  tagEntries: TagEntry[];
  activeTagFilter: string | null;
  onSelectTag: (tag: string | null) => void;
  // smart folders (F7): saved searches/filters + apply/save/delete actions.
  smartFolders: SmartFolder[];
  onApplySmartFolder: (sf: SmartFolder) => void;
  onSaveSmartFolder: () => void;
  onDeleteSmartFolder: (id: string) => void;
  // Duplicates controller, shared with the main-area results view. Only the
  // scope summary and scan lifecycle are surfaced here; the criteria editor
  // stays in the Directories tab of DuplicatesView.
  dupes?: DuplicatesController;
  // exclude patterns (#12): the persisted scan-exclude list (parsed from the
  // comma-separated AppSettings.exclude) plus remove/clear actions and a rescan.
  excludePatterns?: string[];
  onRemoveExclude?: (pattern: string) => void;
  onClearExcludes?: () => void;
}

// ── Tags list (F4) ───────────────────────────────────────────────────────────
// Aggregates every tag across the persisted tag entries into a name → {count,
// color} list. Clicking a tag filters the focused tree to its tagged paths
// (toggling it off when already active). The active tag is highlighted.
function TagsSection({
  tagEntries, activeTagFilter, onSelectTag,
}: {
  tagEntries: TagEntry[];
  activeTagFilter: string | null;
  onSelectTag: (tag: string | null) => void;
}) {
  const tags = useMemo(() => {
    const m = new Map<string, { count: number; color?: string }>();
    for (const e of tagEntries) {
      for (const t of e.tags) {
        const cur = m.get(t) ?? { count: 0, color: undefined as string | undefined };
        cur.count += 1;
        if (!cur.color && e.color) cur.color = e.color;
        m.set(t, cur);
      }
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [tagEntries]);

  if (tags.length === 0) return null;

  return (
    <SideSection label="Tags">
      <div className="sb-list">
        {tags.map(([tag, info]) => (
          <button
            key={tag}
            type="button"
            className={`sb-row${activeTagFilter === tag ? " selected" : ""}`}
            title={`${info.count} item${info.count === 1 ? "" : "s"} tagged \u201C${tag}\u201D`}
            onClick={() => onSelectTag(activeTagFilter === tag ? null : tag)}
          >
            <span className="sb-dot" style={{ background: info.color || "var(--accent)" }} />
            <span className="sb-row-label">{tag}</span>
            <span className="sb-row-meta">{info.count}</span>
          </button>
        ))}
        {activeTagFilter && (
          <button type="button" className="sb-link muted" onClick={() => onSelectTag(null)}>
            <Icon name="x" size={11} /> Clear tag filter
          </button>
        )}
      </div>
    </SideSection>
  );
}

// ── Recent scans ─────────────────────────────────────────────────────────────
// The drive/folder chips that used to live here duplicated both the Locations
// list and the target picker, so this section now only carries history: the
// paths actually scanned, most recent first.
function RecentSection({
  recent, onOpenLocation,
}: {
  recent: string[];
  onOpenLocation: (path: string) => void;
}) {
  if (recent.length === 0) return null;
  return (
    <SideSection label="Recent">
      <div className="sb-list">
        {recent.slice(0, 8).map((path) => (
          <button
            key={path}
            type="button"
            className="sb-row"
            title={path}
            onClick={() => onOpenLocation(path)}
          >
            <Icon name="clock-history" size={13} />
            <span className="sb-row-label">{leafName(path)}</span>
            <span className="sb-row-meta">{splitPath(path).parent}</span>
          </button>
        ))}
      </div>
    </SideSection>
  );
}

// ── Saved scans (#13) ────────────────────────────────────────────────────────
// User-named scan targets kept in localStorage. Multi-path presets scan their
// first path, since the backend scan takes a SINGLE root.
function SavedScansSection({
  scanPath, onOpenLocation,
}: {
  scanPath: string;
  onOpenLocation: (path: string) => void;
}) {
  const [presets, setPresets] = useState<ScanPreset[]>(() => loadPresets());

  const saveCurrent = async () => {
    const path = scanPath.trim();
    if (!path) { toast.info("Choose or scan a folder first, then save it."); return; }
    const name = await promptDialog({
      title: "Save scan preset",
      label: "Preset name",
      initialValue: leafName(path),
      placeholder: "My preset",
      confirmLabel: "Save",
    });
    if (name == null) return;
    setPresets(addPreset(name, [path]));
    toast.success("Scan preset saved.");
  };

  return (
    // Collapsed until something is saved, so an unused group is one quiet
    // header row rather than a heading over an empty list.
    <SideSection label="Saved" defaultOpen={presets.length > 0}>
      <div className="sb-list">
        {presets.map((preset) => (
          <div
            key={preset.id}
            className="sb-row"
            title={`Scan ${preset.paths.join(", ")}`}
            onClick={() => onOpenLocation(preset.paths[0])}
          >
            <Icon name="star-fill" size={12} className="sb-row-star" />
            <span className="sb-row-label">{preset.name}</span>
            <button
              type="button"
              className="sb-row-act"
              title="Delete preset"
              aria-label={`Delete preset ${preset.name}`}
              onClick={(event) => { event.stopPropagation(); setPresets(removePreset(preset.id)); }}
            >
              <Icon name="x" size={10} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="sb-link"
          title="Save the current target as a named preset"
          onClick={() => { void saveCurrent(); }}
        >
          <Icon name="plus" size={11} /> Save current target…
        </button>
      </div>
    </SideSection>
  );
}

// ── Excluded patterns list (#12) ─────────────────────────────────────────────
// Shows the persisted scan-exclude patterns as removable chips, with a one-click
// rescan so a change takes effect immediately. The list is empty (section hidden)
// until the user excludes a folder/pattern.
function ExcludesSection({
  patterns, onRemove, onClear,
}: {
  patterns: string[];
  onRemove: (pattern: string) => void;
  onClear: () => void;
}) {
  if (patterns.length === 0) return null;
  return (
    <SideSection label="Excluded">
      <div className="sb-list">
        {patterns.map((pattern) => (
          <div key={pattern} className="sb-row" title={pattern}>
            <Icon name="funnel" size={12} />
            <span className="sb-row-label mono">{pattern}</span>
            <button
              type="button"
              className="sb-row-act"
              title="Remove this exclude"
              aria-label={`Stop excluding ${pattern}`}
              onClick={() => onRemove(pattern)}
            >
              <Icon name="x" size={10} />
            </button>
          </div>
        ))}
        <button type="button" className="sb-link muted" onClick={onClear}>
          <Icon name="x" size={11} /> Clear all excludes
        </button>
      </div>
    </SideSection>
  );
}

// ── Per-view context cards ───────────────────────────────────────────────────
// Each of the three browsing views gets one card above the shared location
// lists, carrying the state and primary action that view actually cares about.

/** Deepest-first walk isn't needed: the scan root is the only depth-0 node. */
function findRoot(nodeById: Map<number, NodeRecord>): NodeRecord | undefined {
  for (const node of nodeById.values()) {
    if (node.depth === 0 && node.id >= 0) return node;
  }
  return undefined;
}

/** What Compress will read from: the folder selected in the tree, else the root. */
function CompressScopeCard({
  data, nodeById, selectedNode, scanning, onScan,
}: {
  data: ScanResult | null;
  nodeById: Map<number, NodeRecord>;
  selectedNode: NodeRecord | undefined;
  scanning: boolean;
  onScan: () => void;
}) {
  const root = useMemo(() => findRoot(nodeById), [nodeById]);
  const scope = selectedNode?.dir ? selectedNode : root;

  if (!data || !scope) {
    return (
      <div className="sb-card">
        <div className="sb-card-head">
          <Icon name="file-zip" size={13} />
          <span className="sb-card-title">Nothing to compress yet</span>
        </div>
        <p className="sb-card-note">
          Pick a drive or folder above and scan it — the candidate list is built from
          the scanned tree.
        </p>
        <div className="sb-card-actions">
          <button type="button" className="sb-btn primary" disabled={scanning} onClick={onScan}>
            {scanning ? "Scanning…" : "Scan now"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="sb-card">
      <div className="sb-card-head">
        <Icon name="file-zip" size={13} />
        <span className="sb-card-title" title={scope.path}>{scope.name}</span>
      </div>
      <div className="sb-stat-grid">
        <Stat value={fmtSize(scope.size)} label="In scope" />
        <Stat value={scope.files.toLocaleString()} label="Files" />
      </div>
      <p className="sb-card-note">
        {scope.id === root?.id
          ? "Whole scan is in scope. Select a folder below to narrow it."
          : "Scoped to the selected folder."}
      </p>
    </div>
  );
}

/** Duplicate scan scope + lifecycle. The full criteria editor stays in the
 *  main panel's Directories tab; this is the at-a-glance version. */
function DuplicatesScanCard({ ctrl }: { ctrl: DuplicatesController }) {
  const scanning = ctrl.scanState === "scanning";
  const activeStep = activeScanStep(ctrl.phase, ctrl.progress.stage);
  const determinate = hashingDeterminate(ctrl.phase, ctrl.progress);
  const hashedPct = hashingPercent(ctrl.progress);
  const shown = ctrl.selectedPaths.slice(0, 4);
  const extra = ctrl.selectedPaths.length - shown.length;

  return (
    <div className="sb-card">
      <div className="sb-card-head">
        <Icon name="duplicates" size={13} />
        <span className="sb-card-title">
          {scanning ? "Scanning for duplicates" : "Duplicate scan"}
        </span>
        {!scanning && ctrl.groups.length > 0 && (
          <span className="sb-row-meta">{ctrl.groups.length.toLocaleString()} groups</span>
        )}
      </div>

      {scanning ? (
        <div className="sb-progress" role="status" aria-live="polite">
          <div className="sb-steps">
            {DUPLICATE_SCAN_STEPS.map((step) => (
              <span key={step.id} className={`sb-step ${scanStepStatus(step.id, activeStep)}`}>
                {step.label}
              </span>
            ))}
          </div>
          <div className="sb-progress-line">
            <b>{hashingTitle(ctrl.phase, ctrl.progress)}</b>
            <span>
              {ctrl.phase === "hashing" && ctrl.progress.hashing > 0
                ? `${hashedPct}%`
                : ctrl.progress.scanned > 0
                  ? `${ctrl.progress.scanned.toLocaleString()} indexed`
                  : "starting"}
            </span>
          </div>
          <div
            className="sb-progress-track"
            role="progressbar"
            aria-label="Duplicate scan progress"
            aria-valuemin={0}
            aria-valuemax={determinate ? 100 : undefined}
            aria-valuenow={determinate ? hashedPct : undefined}
          >
            <div
              className={`sb-progress-fill${determinate ? "" : " sweep"}`}
              style={determinate ? { width: `${hashedPct}%` } : undefined}
            />
          </div>
        </div>
      ) : ctrl.selectedPaths.length === 0 ? (
        <p className="sb-card-note">
          No folders in scope. Add a target above, or set folder states in the
          Directories tab.
        </p>
      ) : (
        <div className="sb-chips">
          {shown.map((path) => (
            <span key={path} className="sb-chip on" title={path}>{leafName(path)}</span>
          ))}
          {extra > 0 && <span className="sb-chip">+{extra} more</span>}
        </div>
      )}

      <div className="sb-card-actions">
        {scanning ? (
          <button type="button" className="sb-btn danger" onClick={ctrl.stopScan}>Stop scan</button>
        ) : (
          <button
            type="button"
            className="sb-btn primary"
            disabled={!ctrl.canScan || ctrl.actionPending}
            onClick={ctrl.startScan}
          >
            {ctrl.groups.length > 0 ? "Scan again" : "Scan for duplicates"}
          </button>
        )}
      </div>
    </div>
  );
}

function LocationsView(props: SideBarProps) {
  const [locOpen, setLocOpen] = useState(true);

  // Recent targets feed the picker's own "Recent" group as well as the
  // side-bar section, so both stay in step after a scan.
  const [recentPaths, setRecentPaths] = useState<string[]>(() => loadRecentPaths());
  useEffect(() => { setRecentPaths(loadRecentPaths()); }, [props.scanPath]);

  const scanLabel = SCAN_LABELS[props.view] ?? "Scan";

  return (
    <div className="sidebar-content">
      <div className="sb-target">
        <PathPicker
          value={props.scanPath}
          onChange={props.onScanPathInput}
          onCommit={props.onOpenLocation}
          drives={props.drives}
          specialFolders={props.specialFolders}
          bookmarks={props.bookmarkList}
          recent={recentPaths}
          disabled={props.scanning}
          ariaLabel="Drive or folder to scan"
        />
        {props.scanning ? (
          <button type="button" className="sb-go danger" onClick={props.onCancel}>Stop</button>
        ) : (
          <button
            type="button"
            className="sb-go"
            disabled={!props.scanPath.trim()}
            onClick={props.onScan}
          >
            {scanLabel}
          </button>
        )}
      </div>

      {props.view === "duplicates" && props.dupes && <DuplicatesScanCard ctrl={props.dupes} />}
      {props.view === "compress" && (
        <CompressScopeCard
          data={props.data}
          nodeById={props.nodeById}
          selectedNode={props.selectedNode}
          scanning={props.scanning}
          onScan={props.onScan}
        />
      )}
      <SideSection label="Locations" open={locOpen} onToggle={setLocOpen}>
        <div className="sb-list">
          {props.drives.map((d) => (
            // total === 0 means the volume couldn't be queried (e.g. an empty
            // optical drive) → DriveCapacityBar renders nothing and only the
            // name shows. Used/free and the fill-up forecast are in the tooltip.
            <button
              key={d.root}
              type="button"
              className="sb-row"
              title={d.total > 0 ? `${d.label || d.root} — ${fmtSize(d.free)} free of ${fmtSize(d.total)}` : d.root}
              onClick={() => props.onOpenLocation(d.root)}
            >
              <Icon name="hdd" size={13} />
              <span className="sb-row-label">{d.label || d.root}</span>
              <DriveCapacityBar total={d.total} free={d.free} root={d.root} compact />
            </button>
          ))}
          {props.specialFolders.map((f) => (
            <button
              key={f.path}
              type="button"
              className="sb-row"
              title={f.path}
              onClick={() => props.onOpenLocation(f.path)}
            >
              <Icon name="folder" size={13} />
              <span className="sb-row-label">{f.label}</span>
            </button>
          ))}
          {props.bookmarkList.map((b) => (
            <button
              key={b}
              type="button"
              className="sb-row"
              title={b}
              onClick={() => props.onOpenLocation(b)}
            >
              <Icon name="star-fill" size={12} className="sb-row-star" />
              <span className="sb-row-label">{leafName(b)}</span>
            </button>
          ))}
        </div>
      </SideSection>

      <RecentSection recent={recentPaths} onOpenLocation={props.onOpenLocation} />

      <SavedScansSection scanPath={props.scanPath} onOpenLocation={props.onOpenLocation} />

      <ExcludesSection
        patterns={props.excludePatterns ?? []}
        onRemove={(p) => props.onRemoveExclude?.(p)}
        onClear={() => props.onClearExcludes?.()}
      />

      <TagsSection
        tagEntries={props.tagEntries}
        activeTagFilter={props.activeTagFilter}
        onSelectTag={props.onSelectTag}
      />
    </div>
  );
}

// Matches the backend's per-page maximum (TREE_PAGE_MAX), so the sidebar and the
// main results table report the same count for the same query.
const SEARCH_RESULT_CAP = 500;

// Bytes for a size value entered in a unit (used by the size filter inputs).
const SIZE_UNIT_BYTES: Record<string, number> = { KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024 };

// One flat search hit, tagged with the scan ROOT it came from and whether that
// root is the focused pane's current scan (cross-scan / global search, #32).
interface SearchHit {
  node: NodeRecord;
  root: string;
  isCurrent: boolean;
  /** Whether the id resolves in the focused pane's tree. Index-backed hits from
   *  the current scan are `isCurrent` but not navigable until their ancestors
   *  load, so selecting the id would land on nothing. */
  navigable: boolean;
}

function normRoot(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase().replace(/\/$/, "");
}

// ── Inline filters panel (#31) ───────────────────────────────────────────────
function SearchFiltersPanel({
  filters, onChange,
}: {
  filters: SearchFilters;
  onChange: (f: SearchFilters) => void;
}) {
  const [sizeUnit, setSizeUnit] = useState<keyof typeof SIZE_UNIT_BYTES>("MB");
  const set = (patch: Partial<SearchFilters>) => onChange({ ...filters, ...patch });

  const bytesToUnit = (b?: number) => (b == null ? "" : String(+(b / SIZE_UNIT_BYTES[sizeUnit]).toFixed(3)));
  const unitToBytes = (v: string): number | undefined => {
    const n = parseFloat(v);
    return Number.isFinite(n) && v.trim() !== "" ? Math.round(n * SIZE_UNIT_BYTES[sizeUnit]) : undefined;
  };
  // <input type=date> wants yyyy-mm-dd; convert to/from epoch ms.
  const msToDate = (ms?: number) => (ms == null ? "" : new Date(ms).toISOString().slice(0, 10));
  const dateToMs = (v: string, endOfDay: boolean): number | undefined => {
    if (!v) return undefined;
    const d = new Date(v + (endOfDay ? "T23:59:59.999" : "T00:00:00"));
    return Number.isNaN(d.getTime()) ? undefined : d.getTime();
  };

  return (
    <div className="search-filters">
      <div className="search-filter-row">
        <label className="search-filter-label">Size</label>
        <input
          type="number" min="0" inputMode="decimal" placeholder="min"
          className="search-filter-num"
          value={bytesToUnit(filters.minSize)}
          onChange={(e) => set({ minSize: unitToBytes(e.target.value) })}
        />
        <span className="search-filter-dash">–</span>
        <input
          type="number" min="0" inputMode="decimal" placeholder="max"
          className="search-filter-num"
          value={bytesToUnit(filters.maxSize)}
          onChange={(e) => set({ maxSize: unitToBytes(e.target.value) })}
        />
        <Select
          value={sizeUnit}
          options={[
            { value: "KB", label: "KB" },
            { value: "MB", label: "MB" },
            { value: "GB", label: "GB" },
          ]}
          aria-label="Size unit"
          onChange={setSizeUnit}
        />
      </div>

      <div className="search-filter-row">
        <label className="search-filter-label">Modified</label>
        <Select
          value={filters.agePreset}
          options={AGE_PRESETS}
          aria-label="Modified date"
          onChange={(agePreset) => set({ agePreset })}
        />
      </div>

      <div className="search-filter-row">
        <label className="search-filter-label">After</label>
        <input
          type="date" className="search-filter-date"
          value={msToDate(filters.modifiedAfter)}
          onChange={(e) => set({ modifiedAfter: dateToMs(e.target.value, false) })}
        />
        <label className="search-filter-label">Before</label>
        <input
          type="date" className="search-filter-date"
          value={msToDate(filters.modifiedBefore)}
          onChange={(e) => set({ modifiedBefore: dateToMs(e.target.value, true) })}
        />
      </div>

      <div className="search-filter-row">
        <label className="search-filter-label">Type</label>
        <Select
          value={filters.category}
          options={FILE_CATEGORIES}
          aria-label="File type"
          onChange={(category) => set({ category })}
        />
        <input
          type="text" spellCheck={false} placeholder="ext: jpg, png…"
          className="search-filter-ext"
          value={filters.ext}
          onChange={(e) => set({ ext: e.target.value })}
        />
      </div>

      {filtersActive(filters) && (
        <button
          className="search-filter-reset"
          onClick={() => onChange({ ...EMPTY_FILTERS, regex: filters.regex })}
        >
          <Icon name="x" size={11} /> Clear filters
        </button>
      )}
    </div>
  );
}

function SearchView(props: SideBarProps) {
  const [query, setQuery] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const { searchFilters } = props;

  // Input is controlled by App's lifted searchQuery; debounce a local copy so
  // the shared matcher doesn't re-walk the node map on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQuery(props.searchQuery.trim()), 80);
    return () => clearTimeout(t);
  }, [props.searchQuery]);

  const matcher = useMemo(
    () => compileNameMatcher(query, searchFilters.regex),
    [query, searchFilters.regex],
  );
  const regexInvalid = searchFilters.regex && matcher.invalid;
  const anyFilter = filtersActive(searchFilters);
  const active = query.length >= 2 || anyFilter;

  // The focused scan's matches come from the backend whenever the scan is
  // lazy — which, on the desktop build, is always. `nodeById` then holds only
  // the folders the user has actually expanded, so walking it answered "what
  // have I loaded?" instead of "what did I scan?": a search for "node" over a
  // freshly scanned tree found 2 matches while the main results table, which
  // queries the scan's on-disk index, found hundreds. This asks that same index.
  const lazyScan = props.data?.lazy ? props.data : null;
  const serverKey = lazyScan && active
    ? JSON.stringify([lazyScan.scanId ?? lazyScan.rootPath, query, searchFilters])
    : "";
  const [serverHits, setServerHits] = useState<{ key: string; matches: NodeRecord[] }>({ key: "", matches: [] });

  // Read through a ref so one request is issued per distinct query rather than
  // per render: `searchFilters` is an object, and a new identity carrying the
  // same values is already folded into `serverKey`.
  const serverInputs = useRef({ lazyScan, query, searchFilters });
  serverInputs.current = { lazyScan, query, searchFilters };

  useEffect(() => {
    if (!serverKey) return;
    const { lazyScan: scan, query: q, searchFilters: filters } = serverInputs.current;
    if (!scan) return;
    const controller = new AbortController();
    fetchServerSearch({
      rootPath: scan.rootPath,
      scanId: scan.scanId,
      query: q,
      limit: SEARCH_RESULT_CAP,
      signal: controller.signal,
      ...toServerSearchParams(filters),
    })
      .then((res) => setServerHits({ key: serverKey, matches: res.matches }))
      // An aborted or failed query leaves the in-memory hits below in place.
      .catch(() => { /* ignore */ });
    return () => controller.abort();
  }, [serverKey]);

  // Results span the focused pane, every other OPEN tab, and any scan still in
  // the short-lived cache — tagged with the root each hit came from. Scoping
  // this to the focused tab silently hid matches the user had already scanned
  // elsewhere. SAFE scope: only already-scanned trees, never a filesystem walk.
  const results = useMemo<SearchHit[]>(() => {
    if (!active || matcher.invalid) return [];
    const predicate = makeFilterPredicate(searchFilters);
    const nameMatchAll = query.length < 2;
    const currentRoot = props.data?.rootPath ?? "";
    const seenRoots = new Set<string>();
    const hits: SearchHit[] = [];

    const consider = (node: NodeRecord, root: string, isCurrent: boolean) => {
      if (node.id < 0) return;
      if (!nameMatchAll && !matcher.test(node.name, node.path || "", node)) return;
      if (!predicate(node)) return;
      hits.push({ node, root, isCurrent, navigable: isCurrent });
    };

    // Focused pane's tree first, so its hits keep their navigable ids.
    if (currentRoot) seenRoots.add(normRoot(currentRoot));
    if (serverKey && serverHits.key === serverKey) {
      // The backend already applied the query and every filter.
      for (const node of serverHits.matches) {
        hits.push({ node, root: currentRoot, isCurrent: true, navigable: props.nodeById.has(node.id) });
      }
    } else {
      for (const node of props.nodeById.values()) consider(node, currentRoot, true);
    }

    // Then the other open tabs, then whatever is left in the scan cache. Each
    // root is walked once; the first source to claim it wins.
    for (const { root, nodes } of props.getOpenScans()) {
      if (seenRoots.has(normRoot(root))) continue;
      seenRoots.add(normRoot(root));
      for (const node of nodes) consider(node, root, false);
    }
    for (const { path, result } of getAllCached()) {
      const root = result.rootPath || path;
      if (seenRoots.has(normRoot(root))) continue;
      seenRoots.add(normRoot(root));
      for (const node of result.nodes) consider(node, root, false);
    }

    hits.sort((a, b) => compareNodes(a.node, b.node, "size", -1));
    return hits.slice(0, SEARCH_RESULT_CAP);
  }, [active, matcher, searchFilters, query, props.nodeById, props.data, props.getOpenScans,
      serverKey, serverHits]);

  const allPaths = useMemo(() => results.map((r) => r.node.path).filter(Boolean), [results]);

  /** The folder a hit lives in, i.e. what "open location" should scan. */
  const containerOf = (hit: SearchHit): string =>
    hit.node.dir ? hit.node.path : splitPath(hit.node.path).parent || hit.root;

  const handleClickResult = (hit: SearchHit) => {
    if (hit.navigable) {
      props.onNavigate(hit.node.id);
    } else if (hit.isCurrent) {
      // Same scan, but this hit came from the index and its ancestors aren't
      // loaded — selecting the id would land on nothing. Open its folder, which
      // loads that branch and puts the file on screen.
      props.onOpenLocation(containerOf(hit));
    } else {
      // Foreign scan: ids aren't valid in the focused pane, so reveal the file
      // in File Explorer (always correct) — see FLAG in the search header note.
      revealPath(hit.node.path).catch(() => {});
    }
  };

  // Right-click hands the path to the Windows shell menu, the same one the
  // main tree uses, so search hits get Open / Open with / Properties / Delete.
  const handleResultMenu = (hit: SearchHit, e: React.MouseEvent) => {
    e.preventDefault();
    if (!hit.node.path) return;
    void shellContextMenu([hit.node.path], e.clientX, e.clientY).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : String(error));
    });
  };

  return (
    <div className="sidebar-content search-view">
      <div className={`search-box${regexInvalid ? " invalid" : ""}`}>
        <span className="search-box-ico"><Icon name="search" size={13} /></span>
        <input
          autoFocus
          value={props.searchQuery}
          spellCheck={false}
          placeholder="Search every scan…"
          onChange={(e) => props.onSearchQueryChange(e.target.value)}
        />
        <button
          className={`search-tool${searchFilters.regex ? " active" : ""}${regexInvalid ? " invalid" : ""}`}
          title={regexInvalid ? "Invalid regular expression" : "Match name as a regular expression"}
          onClick={() => props.onSearchFiltersChange({ ...searchFilters, regex: !searchFilters.regex })}
        >.*</button>
        <button
          className={`search-tool${anyFilter ? " active" : ""}${filtersOpen ? " open" : ""}`}
          title="Filters (size, date, type)"
          onClick={() => setFiltersOpen((v) => !v)}
        ><Icon name="funnel" size={12} /></button>
        {props.searchHistory.length > 0 && (
          <button
            className={`search-tool${historyOpen ? " open" : ""}`}
            title="Recent searches"
            onClick={() => setHistoryOpen((v) => !v)}
          ><Icon name="chevron-down" size={12} className={historyOpen ? "flip-y" : undefined} /></button>
        )}
        {props.searchQuery && (
          <button className="search-tool" title="Clear" onClick={() => props.onSearchQueryChange("")}>
            <Icon name="x" size={12} />
          </button>
        )}
      </div>

      {historyOpen && props.searchHistory.length > 0 && (
        <div className="search-history">
          {props.searchHistory.map((q) => (
            <button
              key={q}
              className="search-history-item"
              title={`Search “${q}”`}
              onClick={() => { props.onSearchQueryChange(q); setHistoryOpen(false); }}
            >
              <Icon name="search" size={11} />
              <span className="search-history-q">{q}</span>
            </button>
          ))}
          <button
            className="search-history-clear"
            onClick={() => { props.onClearSearchHistory(); setHistoryOpen(false); }}
          >
            <Icon name="x" size={11} /> Clear history
          </button>
        </div>
      )}

      {filtersOpen && (
        <SearchFiltersPanel filters={searchFilters} onChange={props.onSearchFiltersChange} />
      )}

      {props.searchQuery && (
        <div className="search-options">
          <button className="search-link" title="Save this search as a smart folder" onClick={props.onSaveSmartFolder}>
            Save
          </button>
        </div>
      )}

      {active && (
        <div className="search-count">
          <span>{results.length}{results.length >= SEARCH_RESULT_CAP ? "+" : ""} result{results.length === 1 ? "" : "s"}</span>
          {results.length > 0 && (
            <span className="search-count-actions">
              <button title="Select all results in the focused pane" onClick={() => props.onSelectAllSearchResults(allPaths)}>Select all</button>
              <button title="Export results to CSV" onClick={() => exportResults(results.map((r) => r.node), "csv")}>CSV</button>
              <button title="Export results to JSON" onClick={() => exportResults(results.map((r) => r.node), "json")}>JSON</button>
            </span>
          )}
        </div>
      )}

      <div className="search-results">
        {results.map((hit, i) => (
          <div
            key={`${hit.root}:${hit.node.id}:${i}`}
            className="sr-item"
            onContextMenu={(e) => handleResultMenu(hit, e)}
          >
            <button
              type="button"
              className="search-result"
              title={
                hit.navigable
                  ? hit.node.path
                  : hit.isCurrent
                    ? `${hit.node.path}\n(opens the containing folder)`
                    : `${hit.node.path}\n(in ${hit.root} — opens in File Explorer)`
              }
              onClick={() => handleClickResult(hit)}
            >
              <FileIcon ext={hit.node.extension ?? ""} isDir={hit.node.dir} isBundle={false} />
              <span className="sr-name">{hit.node.name}</span>
              {/* The path already begins with the scan root, so a separate root
                  badge only repeated it and cost a third row. Which scan a
                  foreign hit came from stays in the row's tooltip. */}
              <span className="sr-path">{hit.node.path}</span>
              <span className="sr-size">{fmtSize(hit.node.size)}</span>
            </button>
            <span className="sr-actions">
              <button
                type="button"
                className="sr-act"
                title="Scan this folder"
                aria-label={`Scan the folder containing ${hit.node.name}`}
                onClick={() => props.onOpenLocation(containerOf(hit))}
              >
                <Icon name="folder-open" size={12} />
              </button>
              <button
                type="button"
                className="sr-act"
                title="Reveal in File Explorer"
                aria-label={`Reveal ${hit.node.name} in File Explorer`}
                onClick={() => { revealPath(hit.node.path).catch(() => {}); }}
              >
                <Icon name="search" size={12} />
              </button>
              <button
                type="button"
                className="sr-act"
                title="Copy path"
                aria-label={`Copy the path of ${hit.node.name}`}
                onClick={() => { void copyText(hit.node.path); }}
              >
                <Icon name="copy" size={11} />
              </button>
            </span>
          </div>
        ))}
        {active && results.length === 0 && (
          <div className="empty">{regexInvalid ? "Invalid regular expression." : "No matches."}</div>
        )}
        {!active && (
          <div className="empty">Type at least 2 characters, or set a filter.</div>
        )}
      </div>
    </div>
  );
}

export function SideBar(props: SideBarProps) {
  const { view } = props;
  // Explorer, Compress and Duplicates share one browsing body — the target
  // picker, the location lists and the folder tree — and differ only in the
  // context card at the top and the label on the primary action.
  const showLocationsBody = view === "explorer" || view === "compress" || view === "duplicates";

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span className="title">{VIEW_TITLES[view]}</span>
        {showLocationsBody && (
          <div className="actions">
            <button type="button" title="New folder" onClick={props.onNewFolder}><Icon name="folder-plus" size={14} /></button>
            <button type="button" title="Refresh" onClick={props.onRefresh}><Icon name="refresh" size={13} /></button>
            <button type="button" title="Up one level" onClick={props.onUp}><Icon name="arrow-up" size={13} /></button>
            <button type="button" title="Collapse all" onClick={props.onCollapseAll}><Icon name="collapse" size={13} /></button>
          </div>
        )}
      </div>

      {showLocationsBody && <LocationsView {...props} />}

      {view === "search" && <SearchView {...props} />}

      {view === "bookmarks" && (
        <div className="sidebar-content">
          <BookmarksTab
            bookmarks={props.bookmarkList}
            drives={props.drives}
            onOpenLocation={props.onOpenLocation}
            onRemove={props.onRemoveBookmark}
          />
        </div>
      )}

      {view === "errors" && (
        <div className="sidebar-content">
          <div className="errors-tab">
            <ErrorsTab errors={props.data?.scanErrors ?? []} />
          </div>
        </div>
      )}
    </div>
  );
}
