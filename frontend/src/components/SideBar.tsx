import { useState, useMemo, useEffect } from "react";
import type { ViewId } from "./ActivityBar";
import type { DriveEntry, NodeRecord, ScanResult, SpecialFolder, Unit } from "../api/types";
import { BookmarksTab } from "./BookmarksTab";
import { ErrorsTab } from "./ErrorsTab";
import { FileIcon } from "./FileIcon";
import { Icon } from "./Icon";
import { DuplicatesConfigPanel } from "./DuplicatesConfigPanel";
import type { DuplicatesController } from "../hooks/useDuplicates";

const VIEW_TITLES: Record<ViewId, string> = {
  explorer: "Explorer",
  search: "Search",
  treemap: "Treemap",
  reports: "Reports",
  duplicates: "Duplicates",
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
  // duplicates page controller (shared with the app-level results view)
  dupes?: DuplicatesController;
}

function ExplorerView(props: SideBarProps) {
  const [locOpen, setLocOpen] = useState(true);
  const [foldersOpen, setFoldersOpen] = useState(true);
  const FOLDER_CAP = 800; // not virtualized — cap to avoid freezing on "Expand All"
  const allFolderRows = props.treeRows.filter((r) => r.dir && r.id >= 0);
  const folderRows = allFolderRows.slice(0, FOLDER_CAP);
  const hasScan = props.data !== null;

  return (
    <div className="sidebar-content">
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
          {props.drives.map((d) => {
            // Capacity/used bar (Explorer + TreeSize parity). total === 0 means
            // the volume couldn't be queried (e.g. empty CD) → show name only.
            const used = d.total > 0 ? Math.max(0, d.total - d.free) : 0;
            const pct = d.total > 0 ? Math.min(100, (used / d.total) * 100) : 0;
            const level = pct >= 90 ? " crit" : pct >= 75 ? " warn" : "";
            return (
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
                {d.total > 0 && (
                  <div className="drive-cap">
                    <div className="drive-cap-track">
                      <div className={`drive-cap-fill${level}`} style={{ width: `${pct}%` }} />
                    </div>
                    <div className="drive-cap-label">{fmtSize(d.free)} free of {fmtSize(d.total)}</div>
                  </div>
                )}
              </div>
            );
          })}
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
            <div className="folder-tree">
              {folderRows.map((row) => {
                const node = props.nodeById.get(row.id);
                const hasChildren = !!node && node.children.some((cid) => props.nodeById.get(cid)?.dir);
                const isOpen = props.expanded.has(row.id);
                return (
                  <div
                    key={row.id}
                    className={`folder-row${row.id === props.selectedId ? " selected" : ""}`}
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
              {allFolderRows.length > folderRows.length && (
                <div className="folder-row" style={{ paddingLeft: 8, color: "var(--muted-2)" }}>
                  …{allFolderRows.length - folderRows.length} more (collapse to narrow)
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SearchView(props: SideBarProps) {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const hasScan = props.data !== null;

  // Debounce so we don't re-scan the node map on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQuery(input.trim().toLowerCase()), 180);
    return () => clearTimeout(t);
  }, [input]);

  const results = useMemo(() => {
    if (query.length < 2) return [];
    const out: NodeRecord[] = [];
    for (const node of props.nodeById.values()) {
      if (node.id < 0) continue; // skip aggregated bundles
      if (node.name.toLowerCase().includes(query)) {
        out.push(node);
        if (out.length >= 1500) break;
      }
    }
    out.sort((a, b) => b.size - a.size);
    return out.slice(0, 300);
  }, [query, props.nodeById]);

  return (
    <div className="sidebar-content search-view">
      <div className="search-box">
        <span className="search-box-ico"><Icon name="search" size={13} /></span>
        <input
          autoFocus
          value={input}
          spellCheck={false}
          placeholder={hasScan ? "Search files and folders…" : "Run a scan first…"}
          onChange={(e) => setInput(e.target.value)}
        />
        {input && (
          <button className="search-clear" title="Clear" onClick={() => setInput("")}>
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
  // Reports/Treemap reuse the Explorer body so the scan controls, drive list
  // (with capacity bars) and folder tree stay available while their main panel
  // (treemap / analytics reports) shows in the editor area.
  const showExplorerBody = view === "explorer" || view === "treemap" || view === "reports";
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
