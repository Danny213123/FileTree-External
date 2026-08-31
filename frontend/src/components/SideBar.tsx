import { useState, useMemo, useEffect, useRef, useLayoutEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ViewId } from "./ActivityBar";
import type { DriveEntry, NodeRecord, ScanResult, SpecialFolder, Unit, TagEntry, SmartFolder } from "../api/types";
import { BookmarksTab } from "./BookmarksTab";
import { ErrorsTab } from "./ErrorsTab";
import { FileIcon } from "./FileIcon";
import { Icon } from "./Icon";
import { DuplicatesConfigPanel } from "./DuplicatesConfigPanel";
import { DriveCapacityBar } from "./DriveCapacityBar";
import type { DuplicatesController } from "../hooks/useDuplicates";
import {
  searchNodesAdvanced, compileNameMatcher, makeFilterPredicate, filtersActive,
  EMPTY_FILTERS, FILE_CATEGORIES, AGE_PRESETS,
  type SearchFilters, type FileCategory, type AgePreset,
} from "../lib/search";
import { getAllCached } from "../lib/scanCache";
import { exportResults } from "../lib/exportRows";
import { revealPath } from "../api/client";
import { compareNodes } from "../hooks/useTreeState";
import { loadPresets, addPreset, removePreset, type ScanPreset } from "../lib/scanPresets";
import { promptDialog } from "../lib/dialogs";
import { toast } from "../lib/toast";

const VIEW_TITLES: Record<ViewId, string> = {
  explorer: "Explorer",
  search: "Search",
  treemap: "Treemap",
  reports: "Reports",
  duplicates: "Duplicates",
  cleanup: "Cleanup",
  snapshots: "Snapshots",
  gallery: "Gallery",
  compress: "Compress",
  bookmarks: "Bookmarks",
  errors: "Problems",
};

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
  // Inline filters + regex toggle (#31), cross-scan toggle (#32), history (#33),
  // and select-all results (#35). All lifted in App so the pane's flat results
  // table stays in sync with what this sidebar Search view shows.
  searchFilters: SearchFilters;
  onSearchFiltersChange: (f: SearchFilters) => void;
  searchGlobal: boolean;
  onSearchGlobalChange: (v: boolean) => void;
  searchHistory: string[];
  onClearSearchHistory: () => void;
  onSelectAllSearchResults: (paths: string[]) => void;
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
  // duplicates page controller (shared with the app-level results view)
  dupes?: DuplicatesController;
  // exclude patterns (#12): the persisted scan-exclude list (parsed from the
  // comma-separated AppSettings.exclude) plus remove/clear actions and a rescan.
  excludePatterns?: string[];
  onRemoveExclude?: (pattern: string) => void;
  onClearExcludes?: () => void;
}

const SIDEBAR_FOLDER_ROW_H = 22; // keep in sync with .folder-row height in global.css

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
  const [open, setOpen] = useState(true);
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
    <>
      <div className={`explorer-section-title${open ? "" : " collapsed"}`} onClick={() => setOpen((v) => !v)}>
        <span className="chev"><Icon name="chevron-down" size={11} /></span> Tags
      </div>
      {open && (
        <div className="tag-list">
          {activeTagFilter && (
            <button className="tag-list-clear" onClick={() => onSelectTag(null)}>
              <Icon name="x" size={11} /> Clear tag filter
            </button>
          )}
          {tags.map(([tag, info]) => (
            <button
              key={tag}
              className={`tag-list-item${activeTagFilter === tag ? " active" : ""}`}
              title={`${info.count} item${info.count === 1 ? "" : "s"} tagged \u201C${tag}\u201D`}
              onClick={() => onSelectTag(activeTagFilter === tag ? null : tag)}
            >
              <span className="tag-list-dot" style={{ background: info.color || "var(--accent, #61afef)" }} />
              <span className="tag-list-name">{tag}</span>
              <span className="tag-list-count">{info.count}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

// ── Smart folders list (F7) ──────────────────────────────────────────────────
// Lists saved searches/filters; the first row saves the CURRENT search query +
// active filter rules as a new smart folder, and each entry re-applies its query.
function describeSmartFolder(sf: SmartFolder): string {
  const parts: string[] = [];
  if (sf.query.text) parts.push(`search “${sf.query.text}”`);
  if (sf.query.rules?.length) parts.push(`${sf.query.rules.length} filter rule${sf.query.rules.length === 1 ? "" : "s"}`);
  return parts.length ? `Apply ${parts.join(" + ")}` : "Apply smart folder";
}

function SmartFoldersSection({
  smartFolders, onApply, onSave, onDelete,
}: {
  smartFolders: SmartFolder[];
  onApply: (sf: SmartFolder) => void;
  onSave: () => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <div className={`explorer-section-title${open ? "" : " collapsed"}`} onClick={() => setOpen((v) => !v)}>
        <span className="chev"><Icon name="chevron-down" size={11} /></span> Smart Folders
      </div>
      {open && (
        <div className="smartfolder-list">
          <button className="smartfolder-save" title="Save the current search and filter rules as a smart folder" onClick={onSave}>
            <Icon name="plus" size={11} /> Save current search…
          </button>
          {smartFolders.length === 0 && (
            <div className="smartfolder-empty">No smart folders yet.</div>
          )}
          {smartFolders.map((sf) => (
            <div key={sf.id} className="smartfolder-item">
              <button className="smartfolder-open" title={describeSmartFolder(sf)} onClick={() => onApply(sf)}>
                <Icon name="funnel" size={12} />
                <span className="smartfolder-name">{sf.name}</span>
              </button>
              <button className="smartfolder-del" title="Delete smart folder" onClick={() => onDelete(sf.id)}>
                <Icon name="x" size={10} />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ── Quick scan presets (#13) ─────────────────────────────────────────────────
// Compact one-click scan targets: "This PC", each fixed drive, the special
// folders, and user-saved named presets (localStorage). The backend scan takes
// a SINGLE root, so "This PC" is scoped to the primary/system drive (flagged in
// its tooltip) and multi-path presets scan their first path.
function QuickScanSection({
  drives, specialFolders, scanPath, onOpenLocation,
}: {
  drives: DriveEntry[];
  specialFolders: SpecialFolder[];
  scanPath: string;
  onOpenLocation: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [presets, setPresets] = useState<ScanPreset[]>(() => loadPresets());

  // "This PC" can't be a single backend root, so scan the primary/system drive.
  const systemDrive = drives[0]?.root;

  const saveCurrent = async () => {
    const path = scanPath.trim();
    if (!path) { toast.info("Enter or scan a folder first, then save it as a preset."); return; }
    const name = await promptDialog({
      title: "Save scan preset",
      label: "Preset name",
      initialValue: path.split(/[/\\]/).filter(Boolean).pop() || path,
      placeholder: "My preset",
      confirmLabel: "Save",
    });
    if (name == null) return;
    setPresets(addPreset(name, [path]));
    toast.success("Scan preset saved.");
  };

  return (
    <>
      <div className={`explorer-section-title${open ? "" : " collapsed"}`} onClick={() => setOpen((v) => !v)}>
        <span className="chev"><Icon name="chevron-down" size={11} /></span> Quick Scan
      </div>
      {open && (
        <div className="quickscan-list">
          <div className="quickscan-targets">
            {systemDrive && (
              <button
                className="quickscan-chip"
                title={`Scan this PC — scoped to the system drive (${systemDrive}); multi-drive scanning isn't supported by the scan API.`}
                onClick={() => onOpenLocation(systemDrive)}
              >
                <Icon name="hdd" size={12} /> This PC
              </button>
            )}
            {drives.map((d) => (
              <button
                key={d.root}
                className="quickscan-chip"
                title={`Scan ${d.label || d.root}`}
                onClick={() => onOpenLocation(d.root)}
              >
                <Icon name="hdd" size={12} /> {d.root.replace(/\\$/, "")}
              </button>
            ))}
            {specialFolders.slice(0, 6).map((f) => (
              <button
                key={f.path}
                className="quickscan-chip"
                title={`Scan ${f.path}`}
                onClick={() => onOpenLocation(f.path)}
              >
                <Icon name="folder" size={12} /> {f.label}
              </button>
            ))}
          </div>
          <button className="quickscan-save" title="Save the current scan path as a named preset" onClick={() => { void saveCurrent(); }}>
            <Icon name="plus" size={11} /> Save current path…
          </button>
          {presets.map((p) => (
            <div key={p.id} className="quickscan-preset">
              <button
                className="quickscan-preset-open"
                title={`Scan ${p.paths.join(", ")}`}
                onClick={() => onOpenLocation(p.paths[0])}
              >
                <Icon name="star-fill" size={11} />
                <span className="quickscan-preset-name">{p.name}</span>
              </button>
              <button
                className="quickscan-preset-del"
                title="Delete preset"
                onClick={() => setPresets(removePreset(p.id))}
              >
                <Icon name="x" size={10} />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
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
  const [open, setOpen] = useState(true);
  if (patterns.length === 0) return null;
  return (
    <>
      <div className={`explorer-section-title${open ? "" : " collapsed"}`} onClick={() => setOpen((v) => !v)}>
        <span className="chev"><Icon name="chevron-down" size={11} /></span> Excluded From Scans
      </div>
      {open && (
        <div className="excludes-list">
          {patterns.map((p) => (
            <div key={p} className="exclude-item" title={p}>
              <Icon name="funnel" size={11} />
              <span className="exclude-name">{p}</span>
              <button className="exclude-del" title="Remove this exclude" onClick={() => onRemove(p)}>
                <Icon name="x" size={10} />
              </button>
            </div>
          ))}
          <button className="excludes-clear" onClick={onClear}>
            <Icon name="x" size={11} /> Clear all excludes
          </button>
        </div>
      )}
    </>
  );
}

function ExplorerView(props: SideBarProps) {
  const [locOpen, setLocOpen] = useState(true);
  const [foldersOpen, setFoldersOpen] = useState(true);
  // Directory rows for the side-bar tree. Memoized so it isn't refiltered on
  // every virtualizer re-render (each scroll tick) — only when the tree changes.
  const folderRows = useMemo(
    () => props.treeRows.filter((r) => r.dir && r.id >= 0),
    [props.treeRows],
  );
  const hasScan = props.data !== null;

  // Virtualize the folder tree against the shared side-bar scroll container so
  // an "Expand All" with thousands of folders renders only the visible window
  // rather than every row (replaces the old hard 800-row cap). scrollMargin
  // offsets the list past the path box + Locations section so the whole side
  // bar still scrolls as one unit.
  const scrollRef = useRef<HTMLDivElement>(null);
  const folderTreeRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const folderVirtualizer = useVirtualizer({
    count: foldersOpen ? folderRows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => SIDEBAR_FOLDER_ROW_H,
    overscan: 15,
    scrollMargin,
  });
  // Re-measure the folder list's offset within the scroll container whenever the
  // content above it changes height (Locations toggled, drive/bookmark counts,
  // first scan). Runs before paint so row positions are never visibly off.
  useLayoutEffect(() => {
    const scrollEl = scrollRef.current;
    const treeEl = folderTreeRef.current;
    if (!scrollEl || !treeEl) return;
    const margin = treeEl.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop;
    setScrollMargin((prev) => (Math.abs(prev - margin) > 0.5 ? margin : prev));
  }, [locOpen, foldersOpen, hasScan, props.drives.length, props.specialFolders.length, props.bookmarkList.length]);

  return (
    <div className="sidebar-content" ref={scrollRef}>
      <div className="explorer-path">
        <input
          value={props.scanPath}
          spellCheck={false}
          placeholder="Folder or drive to scan..."
          onChange={(e) => props.onScanPathInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") props.onScan(); }}
        />
        {props.scanning ? (
          <button className="explorer-btn" onClick={props.onCancel}>Stop</button>
        ) : (
          <button className="explorer-btn" onClick={props.onScan}>Scan</button>
        )}
      </div>

      <div
        className={`explorer-section-title${locOpen ? "" : " collapsed"}`}
        onClick={() => setLocOpen((v) => !v)}
      >
        <span className="chev"><Icon name="chevron-down" size={11} /></span> Locations
      </div>
      {locOpen && (
        <div className="loc-list">
          {props.drives.map((d) => (
            // Capacity/used bar (Explorer + TreeSize parity). total === 0 means
            // the volume couldn't be queried (e.g. empty CD) → DriveCapacityBar
            // renders nothing and only the name shows.
            <div
              key={d.root}
              className="loc-item loc-drive"
              title={d.total > 0 ? `${d.label || d.root} — ${fmtSize(d.free)} free of ${fmtSize(d.total)}` : d.root}
              onClick={() => props.onOpenLocation(d.root)}
            >
              <div className="loc-drive-row">
                <span className="loc-ico"><Icon name="hdd" size={14} /></span>
                <span className="loc-name">{d.label || d.root}</span>
              </div>
              <DriveCapacityBar total={d.total} free={d.free} root={d.root} />
            </div>
          ))}
          {props.specialFolders.map((f) => (
            <div key={f.path} className="loc-item" title={f.path} onClick={() => props.onOpenLocation(f.path)}>
              <span className="loc-ico"><Icon name="folder" size={14} /></span>
              <span className="loc-name">{f.label}</span>
            </div>
          ))}
          {props.bookmarkList.map((b) => (
            <div key={b} className="loc-item" title={b} onClick={() => props.onOpenLocation(b)}>
              <span className="loc-ico loc-ico-star"><Icon name="star-fill" size={13} /></span>
              <span className="loc-name">{b.split(/[/\\]/).filter(Boolean).pop() || b}</span>
            </div>
          ))}
        </div>
      )}

      <QuickScanSection
        drives={props.drives}
        specialFolders={props.specialFolders}
        scanPath={props.scanPath}
        onOpenLocation={props.onOpenLocation}
      />

      <ExcludesSection
        patterns={props.excludePatterns ?? []}
        onRemove={(p) => props.onRemoveExclude?.(p)}
        onClear={() => props.onClearExcludes?.()}
      />

      {hasScan && (
        <>
          <div
            className={`explorer-section-title${foldersOpen ? "" : " collapsed"}`}
            onClick={() => setFoldersOpen((v) => !v)}
          >
            <span className="chev"><Icon name="chevron-down" size={11} /></span> Folders
          </div>
          {foldersOpen && (
            <div
              className="folder-tree"
              ref={folderTreeRef}
              style={{ height: folderVirtualizer.getTotalSize(), position: "relative" }}
            >
              {folderVirtualizer.getVirtualItems().map((vItem) => {
                const row = folderRows[vItem.index];
                const node = props.nodeById.get(row.id);
                const hasChildren = !!node && node.children.some((cid) => props.nodeById.get(cid)?.dir);
                const isOpen = props.expanded.has(row.id);
                return (
                  <div
                    key={row.id}
                    className={`folder-row${row.id === props.selectedId ? " selected" : ""}`}
                    style={{ position: "absolute", top: vItem.start - scrollMargin, left: 0, right: 0, height: SIDEBAR_FOLDER_ROW_H }}
                    onClick={() => props.onSelectFolder(row.id)}
                  >
                    {row.depth > 0 && (
                      <span className="indent" aria-hidden="true">
                        {Array.from({ length: row.depth }).map((_, i) => (
                          <span key={i} className="indent-guide" />
                        ))}
                      </span>
                    )}
                    <span
                      className="twisty"
                      onClick={(e) => { e.stopPropagation(); if (hasChildren) props.onToggleExpand(row.id); }}
                    >
                      {hasChildren && <Icon name={isOpen ? "chevron-down" : "chevron-right"} size={10} />}
                    </span>
                    <span className="fname">{row.name}</span>
                    <span className="fsize">{fmtSize(row.size)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      <TagsSection
        tagEntries={props.tagEntries}
        activeTagFilter={props.activeTagFilter}
        onSelectTag={props.onSelectTag}
      />
      <SmartFoldersSection
        smartFolders={props.smartFolders}
        onApply={props.onApplySmartFolder}
        onSave={props.onSaveSmartFolder}
        onDelete={props.onDeleteSmartFolder}
      />
    </div>
  );
}

const SEARCH_RESULT_CAP = 300;

// Bytes for a size value entered in a unit (used by the size filter inputs).
const SIZE_UNIT_BYTES: Record<string, number> = { KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024 };

// One flat search hit, tagged with the scan ROOT it came from and whether that
// root is the focused pane's current scan (cross-scan / global search, #32).
interface SearchHit {
  node: NodeRecord;
  root: string;
  isCurrent: boolean;
}

function rootLabel(root: string): string {
  return root.split(/[/\\]/).filter(Boolean).pop() || root;
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
        <select value={sizeUnit} onChange={(e) => setSizeUnit(e.target.value as keyof typeof SIZE_UNIT_BYTES)}>
          <option value="KB">KB</option>
          <option value="MB">MB</option>
          <option value="GB">GB</option>
        </select>
      </div>

      <div className="search-filter-row">
        <label className="search-filter-label">Modified</label>
        <select
          value={filters.agePreset}
          onChange={(e) => set({ agePreset: e.target.value as AgePreset })}
        >
          {AGE_PRESETS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
        </select>
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
        <select
          value={filters.category}
          onChange={(e) => set({ category: e.target.value as FileCategory })}
        >
          {FILE_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
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
  const hasScan = props.data !== null;
  const { searchFilters, searchGlobal } = props;

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

  // Local (current-scan) results via the shared advanced matcher, largest-first
  // to mirror the main table. Skipped when global search is on (handled below).
  const localResults = useMemo(
    () => (searchGlobal ? [] : searchNodesAdvanced(props.nodeById, query, searchFilters, "size", -1, SEARCH_RESULT_CAP)),
    [searchGlobal, props.nodeById, query, searchFilters],
  );

  // Cross-scan / global results (#32): match across EVERY cached scan plus the
  // focused pane's live tree, tagging each hit with its root. SAFE scope — this
  // searches only already-scanned trees (no filesystem-wide index).
  const globalResults = useMemo<SearchHit[]>(() => {
    if (!searchGlobal || (!active || matcher.invalid)) return [];
    const predicate = makeFilterPredicate(searchFilters);
    const nameMatchAll = query.length < 2;
    const currentRoot = props.data?.rootPath ?? "";
    const seenRoots = new Set<string>();
    const hits: SearchHit[] = [];

    const consider = (node: NodeRecord, root: string, isCurrent: boolean) => {
      if (node.id < 0) return;
      if (!nameMatchAll && !matcher.test(node.name, node.path || "", node)) return;
      if (!predicate(node)) return;
      hits.push({ node, root, isCurrent });
    };

    // Focused pane's live tree first.
    if (currentRoot) seenRoots.add(normRoot(currentRoot));
    for (const node of props.nodeById.values()) consider(node, currentRoot, true);

    // Then every other cached scan (skip the one we already walked live).
    for (const { path, result } of getAllCached()) {
      const root = result.rootPath || path;
      if (seenRoots.has(normRoot(root))) continue;
      seenRoots.add(normRoot(root));
      for (const node of result.nodes) consider(node, root, false);
    }

    hits.sort((a, b) => compareNodes(a.node, b.node, "size", -1));
    return hits.slice(0, SEARCH_RESULT_CAP);
  }, [searchGlobal, active, matcher, searchFilters, query, props.nodeById, props.data]);

  const results: SearchHit[] = searchGlobal
    ? globalResults
    : localResults.map((node) => ({ node, root: props.data?.rootPath ?? "", isCurrent: true }));

  const allPaths = useMemo(() => results.map((r) => r.node.path).filter(Boolean), [results]);

  const handleClickResult = (hit: SearchHit) => {
    if (hit.isCurrent) {
      props.onNavigate(hit.node.id);
    } else {
      // Foreign scan: ids aren't valid in the focused pane, so reveal the file
      // in File Explorer (always correct) — see FLAG in the search header note.
      revealPath(hit.node.path).catch(() => {});
    }
  };

  return (
    <div className="sidebar-content search-view">
      <div className={`search-box${regexInvalid ? " invalid" : ""}`}>
        <span className="search-box-ico"><Icon name="search" size={13} /></span>
        <input
          autoFocus
          value={props.searchQuery}
          spellCheck={false}
          placeholder={hasScan ? "Search files and folders…" : "Run a scan first…"}
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
          ><Icon name="chevron-down" size={12} /></button>
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

      <div className="search-options">
        <label className="search-global-toggle" title="Search across every scan cached this session (multiple roots), not just the current one. This is not a filesystem-wide index.">
          <input
            type="checkbox"
            checked={searchGlobal}
            onChange={(e) => props.onSearchGlobalChange(e.target.checked)}
          />
          Search all cached scans
        </label>
        {props.searchQuery && (
          <button className="search-link" title="Save this search as a smart folder" onClick={props.onSaveSmartFolder}>
            Save
          </button>
        )}
      </div>

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
          <button
            key={`${hit.root}:${hit.node.id}:${i}`}
            className="search-result"
            title={hit.isCurrent ? hit.node.path : `${hit.node.path}\n(in ${hit.root} — opens in File Explorer)`}
            onClick={() => handleClickResult(hit)}
          >
            <FileIcon ext={hit.node.extension ?? ""} isDir={hit.node.dir} isBundle={false} />
            <span className="sr-name">{hit.node.name}</span>
            <span className="sr-size">{fmtSize(hit.node.size)}</span>
            <span className="sr-path">{hit.node.path}</span>
            {searchGlobal && (
              <span className={`sr-root${hit.isCurrent ? " current" : ""}`} title={hit.root}>{rootLabel(hit.root)}</span>
            )}
          </button>
        ))}
        {active && results.length === 0 && (
          <div className="empty">{regexInvalid ? "Invalid regular expression." : `No matches${hasScan || searchGlobal ? "" : " — run a scan first"}.`}</div>
        )}
        {!active && (
          <div className="empty">Type at least 2 characters{searchGlobal ? "" : " to search the current scan"}, or set a filter.</div>
        )}
      </div>
    </div>
  );
}

export function SideBar(props: SideBarProps) {
  const { view } = props;
  // Reports/Treemap (and the Cleanup/Snapshots/Gallery editor views) reuse the
  // Explorer body so the scan controls, drive list (with capacity bars) and
  // folder tree stay available while their main panel shows in the editor area.
  const showExplorerBody =
    view === "explorer" || view === "treemap" || view === "reports" ||
    view === "cleanup" || view === "snapshots" || view === "gallery" ||
    view === "compress";
  const showFolderActions = showExplorerBody;

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span className="title">{VIEW_TITLES[view]}</span>
        {showFolderActions && (
          <div className="actions">
            <button title="New folder" onClick={props.onNewFolder}><Icon name="folder-plus" size={15} /></button>
            <button title="Refresh" onClick={props.onRefresh}><Icon name="refresh" size={14} /></button>
            <button title="Up one level" onClick={props.onUp}><Icon name="arrow-up" size={14} /></button>
            <button title="Collapse all" onClick={props.onCollapseAll}><Icon name="collapse" size={14} /></button>
          </div>
        )}
      </div>

      {showExplorerBody && <ExplorerView {...props} />}

      {view === "search" && <SearchView {...props} />}

      {view === "duplicates" && props.dupes && (
        <DuplicatesConfigPanel ctrl={props.dupes} drives={props.drives} specialFolders={props.specialFolders} />
      )}

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
