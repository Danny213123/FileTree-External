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
import { searchNodes } from "../lib/search";

const VIEW_TITLES: Record<ViewId, string> = {
  explorer: "Explorer",
  search: "Search",
  treemap: "Treemap",
  reports: "Reports",
  duplicates: "Duplicates",
  cleanup: "Cleanup",
  snapshots: "Snapshots",
  gallery: "Gallery",
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
              <DriveCapacityBar total={d.total} free={d.free} />
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

function SearchView(props: SideBarProps) {
  const [query, setQuery] = useState("");
  const hasScan = props.data !== null;

  // Input is controlled by App's lifted searchQuery; debounce a local copy so
  // the shared matcher doesn't re-walk the node map on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQuery(props.searchQuery.trim().toLowerCase()), 180);
    return () => clearTimeout(t);
  }, [props.searchQuery]);

  // Shared name+path matcher, sorted largest-first to mirror the main table.
  const results = useMemo(
    () => searchNodes(props.nodeById, query, "size", -1, 300),
    [query, props.nodeById],
  );

  return (
    <div className="sidebar-content search-view">
      <div className="search-box">
        <span className="search-box-ico"><Icon name="search" size={13} /></span>
        <input
          autoFocus
          value={props.searchQuery}
          spellCheck={false}
          placeholder={hasScan ? "Search files and folders…" : "Run a scan first…"}
          onChange={(e) => props.onSearchQueryChange(e.target.value)}
        />
        {props.searchQuery && (
          <button className="search-save" title="Save this search as a smart folder" onClick={props.onSaveSmartFolder}>
            <Icon name="funnel" size={12} />
          </button>
        )}
        {props.searchQuery && (
          <button className="search-clear" title="Clear" onClick={() => props.onSearchQueryChange("")}>
            <Icon name="x" size={12} />
          </button>
        )}
      </div>

      {query.length >= 2 && (
        <div className="search-count">
          {results.length}{results.length >= 300 ? "+" : ""} result{results.length === 1 ? "" : "s"}
        </div>
      )}

      <div className="search-results">
        {results.map((node) => (
          <button
            key={node.id}
            className="search-result"
            title={node.path}
            onClick={() => props.onNavigate(node.id)}
          >
            <FileIcon ext={node.extension ?? ""} isDir={node.dir} isBundle={false} />
            <span className="sr-name">{node.name}</span>
            <span className="sr-size">{fmtSize(node.size)}</span>
            <span className="sr-path">{node.path}</span>
          </button>
        ))}
        {query.length >= 2 && results.length === 0 && (
          <div className="empty">No matches{hasScan ? "" : " — run a scan first"}.</div>
        )}
        {query.length < 2 && (
          <div className="empty">Type at least 2 characters to search the current scan.</div>
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
    view === "cleanup" || view === "snapshots" || view === "gallery";
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
