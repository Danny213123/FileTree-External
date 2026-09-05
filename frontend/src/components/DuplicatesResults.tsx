import { useCallback, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DupeFileV2, DupeGroupV2 } from "../api/types";
import type { DuplicatesController, KeepStrategy } from "../hooks/useDuplicates";
import { formatBytes } from "../utils/formatBytes";
import { formatDate } from "../utils/formatDate";
import { openPath, revealPath } from "../api/client";
import { Icon } from "./Icon";
import { EmptyState } from "./EmptyState";
import { FixedDropdown } from "./ConfigureColumnsMenu";
import { DupeGroupPreview } from "./DupeGroupPreview";

const ROW_HEIGHT = 30;
const GUTTER = 42;
const MIN_COL_WIDTH = 56;

type DupeColKey = "name" | "match" | "dname" | "dsize" | "ddate" | "content" | "size" | "modified" | "folder";
type SortKey = DupeColKey | "waste";
type ReviewFilter = "all" | "selected" | "needs-review" | "protected";

interface DupeCol {
  key: DupeColKey;
  label: string;
  width: number;
  align: "left" | "right" | "center";
  delta?: boolean;
}

const COLUMNS: DupeCol[] = [
  { key: "name",     label: "Name",     width: 260, align: "left" },
  { key: "match",    label: "Evidence", width: 112, align: "center" },
  { key: "dname",    label: "Name Δ",   width: 70,  align: "center", delta: true },
  { key: "dsize",    label: "Size Δ",   width: 88,  align: "right",  delta: true },
  { key: "ddate",    label: "Date Δ",   width: 88,  align: "right",  delta: true },
  { key: "content",  label: "Content",  width: 72,  align: "center", delta: true },
  { key: "size",     label: "Size",     width: 92,  align: "right" },
  { key: "modified", label: "Modified", width: 134, align: "right" },
  { key: "folder",   label: "Folder",   width: 320, align: "left" },
];

function folderOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return idx >= 0 ? path.slice(0, idx) : "";
}

/** Signed, human duration for a seconds delta (Date Δ in "delta values" mode). */
function fmtDuration(sec: number): string {
  const a = Math.abs(sec);
  if (a < 1) return "0";
  const sign = sec > 0 ? "+" : "−";
  if (a < 90) return `${sign}${Math.round(a)}s`;
  if (a < 5400) return `${sign}${Math.round(a / 60)}m`;
  if (a < 172800) return `${sign}${Math.round(a / 3600)}h`;
  return `${sign}${Math.round(a / 86400)}d`;
}

type FlatRow =
  | { kind: "group"; key: string; group: DupeGroupV2 }
  | { kind: "file"; key: string; group: DupeGroupV2; file: DupeFileV2 };

function groupKey(g: DupeGroupV2): string {
  return g.files[0]?.path ?? "g";
}

function isVerifiedGroup(group: DupeGroupV2): boolean {
  return group.files
    .filter((file) => !file.ref)
    .every((file) => (file.match?.content ?? 0) >= 100);
}

export function DuplicatesResults({ ctrl }: { ctrl: DuplicatesController }) {
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const [widths, setWidths] = useState<Partial<Record<DupeColKey, number>>>({});
  const [visibleCols, setVisibleCols] = useState<Set<DupeColKey>>(
    () => new Set(COLUMNS.map((c) => c.key)),
  );
  const [sortKey, setSortKey] = useState<SortKey>("waste");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [search, setSearch] = useState("");
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");
  const [dupesOnly, setDupesOnly] = useState(false);
  const [deltaValues, setDeltaValues] = useState(false);
  const [colsMenuOpen, setColsMenuOpen] = useState(false);
  const colsBtnRef = useRef<HTMLDivElement>(null);
  const [linkMode, setLinkMode] = useState<"hardlink" | "symlink">("hardlink");
  const [previewGroup, setPreviewGroup] = useState<DupeGroupV2 | null>(null);
  const [activeRowKey, setActiveRowKey] = useState<string | null>(null);

  // Drive letters present across all groups (for the "keep on drive" strategy).
  const driveLetters = useMemo(() => {
    const set = new Set<string>();
    for (const g of ctrl.groups) {
      for (const f of g.files) {
        const m = /^([a-zA-Z]):/.exec(f.path);
        if (m) set.add(m[1].toUpperCase());
      }
    }
    return [...set].sort();
  }, [ctrl.groups]);

  // #24: apply an auto-pick strategy from the dropdown, then reset it to the
  // placeholder (it's an action, not a persistent mode).
  const onStrategy = useCallback((value: string) => {
    if (!value) return;
    if (value.startsWith("drive:")) ctrl.keepStrategy("drive", value.slice("drive:".length));
    else ctrl.keepStrategy(value as KeepStrategy);
  }, [ctrl]);

  const widthOf = useCallback((c: DupeCol) => widths[c.key] ?? c.width, [widths]);
  const cols = useMemo(() => COLUMNS.filter((c) => c.key === "name" || visibleCols.has(c.key)), [visibleCols]);

  const gridTemplate = useMemo(
    () => `${GUTTER}px ${cols.map((c) => `${widthOf(c)}px`).join(" ")} minmax(0,1fr)`,
    [cols, widthOf],
  );
  const minTableWidth = useMemo(
    () => GUTTER + cols.reduce((s, c) => s + widthOf(c), 0),
    [cols, widthOf],
  );

  const startResize = useCallback((e: React.MouseEvent, c: DupeCol) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[c.key] ?? c.width;
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(MIN_COL_WIDTH, Math.round(startW + (ev.clientX - startX)));
      setWidths((prev) => ({ ...prev, [c.key]: next }));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [widths]);
  const resizeColumn = useCallback((column: DupeCol, delta: number) => {
    setWidths((prev) => ({
      ...prev,
      [column.key]: Math.max(MIN_COL_WIDTH, (prev[column.key] ?? column.width) + delta),
    }));
  }, []);

  const onSort = useCallback((key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 1 ? -1 : 1));
    } else {
      // New column: text defaults to A-Z, numeric/score/date to high-first.
      setSortKey(key);
      setSortDir(key === "name" || key === "folder" ? 1 : -1);
    }
  }, [sortKey]);

  // ── Display groups: search filter + per-group file sort + group sort ─────────
  const fileValue = useCallback((f: DupeFileV2, key: SortKey): number | string => {
    switch (key) {
      case "name": return f.name.toLowerCase();
      case "folder": return folderOf(f.path).toLowerCase();
      case "match": return f.score ?? 0;
      case "dname": return f.match?.name ?? 0;
      case "dsize": return f.match?.size ?? 0;
      case "ddate": return f.match?.date ?? 0;
      case "content": return f.match?.content ?? 0;
      case "size": return f.size;
      case "modified": return f.modified;
      case "waste": return f.size;
    }
  }, []);

  const sortedGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const cmp = (a: number | string, b: number | string) =>
      (a < b ? -1 : a > b ? 1 : 0) * sortDir;

    const out: DupeGroupV2[] = [];
    for (const g of ctrl.groups) {
      if (q) {
        const hit = g.files.some((f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q));
        if (!hit) continue;
      }
      // Sort duplicates within the group; the reference always stays first.
      const ref = g.files.find((f) => f.ref) ?? g.files[0];
      const dups = g.files.filter((f) => f !== ref);
      dups.sort((a, b) => cmp(fileValue(a, sortKey), fileValue(b, sortKey)));
      out.push({ ...g, files: [ref, ...dups] });
    }
    // Sort the groups themselves (by reference value, or waste at group level).
    out.sort((a, b) => {
      if (sortKey === "waste") return (a.waste - b.waste) * sortDir;
      if (sortKey === "match") return (a.score - b.score) * sortDir;
      return cmp(fileValue(a.files[0], sortKey), fileValue(b.files[0], sortKey));
    });
    return out;
  }, [ctrl.groups, search, sortKey, sortDir, fileValue]);

  const displayGroups = useMemo(
    () => sortedGroups.filter((group) => {
      if (reviewFilter === "selected") {
        return group.files.some((file) => ctrl.selected.has(file.path));
      }
      if (reviewFilter === "needs-review") return !isVerifiedGroup(group);
      if (reviewFilter === "protected") return group.files.some((file) => file.protected);
      return true;
    }),
    [ctrl.selected, reviewFilter, sortedGroups],
  );

  const flatRows = useMemo(() => {
    const rows: FlatRow[] = [];
    for (const g of displayGroups) {
      const key = groupKey(g);
      rows.push({ kind: "group", key, group: g });
      if (ctrl.collapsed.has(key)) continue;
      for (const f of g.files) {
        if (dupesOnly && f.ref) continue;
        rows.push({ kind: "file", key: `${key}|${f.path}`, group: g, file: f });
      }
    }
    return rows;
  }, [displayGroups, ctrl.collapsed, dupesOnly]);

  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => ROW_HEIGHT,
    overscan: 14,
  });

  const activeRowIndex = Math.max(
    0,
    flatRows.findIndex((row) => row.key === activeRowKey),
  );
  const focusRow = useCallback((index: number) => {
    if (flatRows.length === 0) return;
    const nextIndex = Math.max(0, Math.min(index, flatRows.length - 1));
    setActiveRowKey(flatRows[nextIndex].key);
    virtualizer.scrollToIndex(nextIndex, { align: "auto" });
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        scrollRef.current
          ?.querySelector<HTMLElement>(`[data-dupe-row-index="${nextIndex}"]`)
          ?.focus();
      });
    });
  }, [flatRows, virtualizer]);
  const navigateRows = useCallback((event: React.KeyboardEvent<HTMLElement>, index: number) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusRow(index + 1);
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusRow(index - 1);
      return true;
    }
    if (event.key === "Home") {
      event.preventDefault();
      focusRow(0);
      return true;
    }
    if (event.key === "End") {
      event.preventDefault();
      focusRow(flatRows.length - 1);
      return true;
    }
    return false;
  }, [flatRows.length, focusRow]);

  const visibleDupPaths = useMemo(
    () => displayGroups.flatMap((g) =>
      g.files.filter((f) => !f.ref && !f.protected).map((f) => f.path),
    ),
    [displayGroups],
  );
  const allChecked = visibleDupPaths.length > 0 && visibleDupPaths.every((p) => ctrl.selected.has(p));
  const someChecked = !allChecked && visibleDupPaths.some((p) => ctrl.selected.has(p));
  const visibleSelectedCount = visibleDupPaths.filter((path) => ctrl.selected.has(path)).length;
  const hiddenSelectedCount = Math.max(0, ctrl.selectedCount - visibleSelectedCount);
  const visibleWaste = useMemo(
    () => displayGroups.reduce((sum, group) => sum + group.waste, 0),
    [displayGroups],
  );
  const protectedCopies = useMemo(
    () => ctrl.groups.reduce(
      (sum, group) => sum + group.files.filter((file) => file.protected).length,
      0,
    ),
    [ctrl.groups],
  );

  const renderCell = (f: DupeFileV2, g: DupeGroupV2, key: DupeColKey) => {
    const ref = g.files.find((file) => file.ref) ?? g.files[0];
    switch (key) {
      case "name":
        return (
          <span className="df-file-name" title={f.path} onDoubleClick={() => void openPath(f.path)}>
            <span className="df-file-icon">
              {f.protected
                ? <Icon name="bookmark" size={11} />
                : f.ref
                  ? <Icon name="star-fill" size={11} />
                  : <Icon name="duplicates" size={11} />}
            </span>
            <span className={`df-file-role${f.protected ? " protected" : f.ref ? " keeper" : ""}`}>
              {f.protected ? "Protected" : f.ref ? "Keeper" : "Copy"}
            </span>
            <span className="df-file-name-text">{f.name}</span>
          </span>
        );
      case "match":
        if (f.ref) return <span className="df-evidence keeper">Kept copy</span>;
        if ((f.match?.content ?? 0) >= 100) {
          return <span className="df-evidence verified"><Icon name="check" size={11} /> Verified</span>;
        }
        return <MatchBar pct={f.score ?? 0} />;
      case "dname":
        return f.ref ? <span className="df-dim">—</span> : <MatchBar pct={f.match?.name ?? 0} />;
      case "dsize":
        if (f.ref) return <span className="df-dim">—</span>;
        return deltaValues
          ? <span className={f.size === ref.size ? "df-dim" : "df-delta"}>{f.size === ref.size ? "0" : `${f.size > ref.size ? "+" : "−"}${formatBytes(Math.abs(f.size - ref.size), "auto")}`}</span>
          : <MatchBar pct={f.match?.size ?? 0} />;
      case "ddate":
        if (f.ref) return <span className="df-dim">—</span>;
        return deltaValues
          ? <span className={f.modified === ref.modified ? "df-dim" : "df-delta"}>{fmtDuration(f.modified - ref.modified)}</span>
          : <MatchBar pct={f.match?.date ?? 0} />;
      case "content":
        if (f.ref) return <span className="df-dim">—</span>;
        return (f.match?.content ?? 0) >= 100
          ? <span className="df-content-yes" title="Full-content hash match; rechecked byte-for-byte before file changes"><Icon name="check" size={12} /> Yes</span>
          : <span className="df-evidence possible" title="Not content-hash verified">Review</span>;
      case "size": return <span>{formatBytes(f.size, "auto")}</span>;
      case "modified": return <span>{f.modified > 0 ? formatDate(f.modified * 1000) : "—"}</span>;
      case "folder": return <span className="df-file-folder" title={f.path}>{folderOf(f.path)}</span>;
    }
  };

  const scanning = ctrl.scanState === "scanning";
  const toggleableCols = COLUMNS.filter((c) => c.key !== "name");
  const needsReviewCount = ctrl.groups.filter((group) => !isVerifiedGroup(group)).length;
  const protectedGroupCount = ctrl.groups.filter((group) =>
    group.files.some((file) => file.protected),
  ).length;

  return (
    <div className="df-results-root" aria-busy={ctrl.actionPending}>
      <header className="df-overview">
        <div className="df-overview-copy">
          <div className="df-overview-eyebrow">Storage cleanup</div>
          <h1>Duplicate files</h1>
          <p>
            {ctrl.criteria.content.enabled
              ? "Content matches use full-file hashes and are rechecked byte-for-byte before cleanup."
              : "Custom metadata matches need manual review before cleanup."}
          </p>
        </div>
        {ctrl.scanState === "done" && (
          <div className="df-overview-stats" aria-label="Duplicate scan summary">
            <span><strong>{ctrl.groups.length.toLocaleString()}</strong> groups</span>
            <span><strong>{ctrl.totalFiles.toLocaleString()}</strong> files</span>
            <span className="reclaimable"><strong>{formatBytes(ctrl.totalWaste, "auto")}</strong> reclaimable</span>
            {protectedCopies > 0 && (
              <span className="protected"><Icon name="bookmark" size={11} /><strong>{protectedCopies}</strong> protected</span>
            )}
          </div>
        )}
      </header>

      {/* Review and display controls stay stable; file actions appear contextually below. */}
      <div className="df-toolbar">
        <div className="df-review-filters" aria-label="Review filters">
          {([
            ["all", "All", ctrl.groups.length],
            ["selected", "Selected", ctrl.selectedGroups],
            ["needs-review", "Needs review", needsReviewCount],
            ["protected", "Protected", protectedGroupCount],
          ] as const).map(([value, label, count]) => (
            <button
              key={value}
              className={`df-review-filter${reviewFilter === value ? " active" : ""}`}
              onClick={() => setReviewFilter(value)}
              aria-pressed={reviewFilter === value}
            >
              {label}<span>{count}</span>
            </button>
          ))}
        </div>

        <div className="df-toolbar-spacer" />

        <div className="df-search">
          <Icon name="search" size={12} />
          <input
            value={search}
            aria-label="Search duplicate results"
            placeholder="Search name or path"
            spellCheck={false}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && <button className="df-search-clear" onClick={() => setSearch("")} title="Clear search" aria-label="Clear search"><Icon name="x" size={11} /></button>}
        </div>
        <button
          className={`df-tool-btn df-toggle${dupesOnly ? " df-toggle-on" : ""}`}
          onClick={() => setDupesOnly((v) => !v)}
          aria-pressed={dupesOnly}
          title="Hide keeper rows"
        >
          Copies only
        </button>
        <button
          className={`df-tool-btn df-toggle${deltaValues ? " df-toggle-on" : ""}`}
          onClick={() => setDeltaValues((v) => !v)}
          aria-pressed={deltaValues}
          title="Show raw size and date differences"
        >
          Differences
        </button>
        <div className="rb-dropdown-wrap" ref={colsBtnRef}>
          <button
            className={`df-tool-btn${colsMenuOpen ? " df-toggle-on" : ""}`}
            onClick={() => setColsMenuOpen((o) => !o)}
            aria-expanded={colsMenuOpen}
            title="Configure columns"
          >
            <Icon name="columns" size={13} /> Columns
          </button>
          <FixedDropdown anchorRef={colsBtnRef} open={colsMenuOpen} onClose={() => setColsMenuOpen(false)}>
            <div className="rb-dd-section">Columns</div>
            {toggleableCols.map((c) => (
              <button key={c.key} className="rb-col-row" onClick={() => setVisibleCols((prev) => {
                const next = new Set(prev);
                if (next.has(c.key)) next.delete(c.key); else next.add(c.key);
                return next;
              })}>
                <span className="rb-col-check">{visibleCols.has(c.key) ? <Icon name="check" size={11} /> : ""}</span>
                {c.label}
              </button>
            ))}
          </FixedDropdown>
        </div>
        <button className="df-tool-btn" onClick={ctrl.exportCsv} disabled={!ctrl.groups.length}>CSV</button>
        <button className="df-tool-btn" onClick={ctrl.exportJson} disabled={!ctrl.groups.length}>JSON</button>
      </div>

      {ctrl.groups.length > 0 && (
        <div className="df-marking-bar">
          <div className="df-toolbar-group">
            <button
              className="df-tool-btn"
              onClick={() => ctrl.selectAll(visibleDupPaths)}
              disabled={!visibleDupPaths.length || ctrl.actionPending}
            >
              Select visible copies
            </button>
            <button
              className="df-tool-btn"
              onClick={() => ctrl.invertSelection(visibleDupPaths)}
              disabled={!visibleDupPaths.length || ctrl.actionPending}
            >
              Invert visible
            </button>
            <button className="df-tool-btn" onClick={() => ctrl.unselectAll()} disabled={!ctrl.selectedCount || ctrl.actionPending}>Clear selection</button>
          </div>
          <div className="df-toolbar-spacer" />
          <label className="df-keeper-rule">
            <span>Choose files to keep</span>
            <select
              className="df-select df-select-sm"
              value=""
              disabled={ctrl.actionPending}
              onChange={(e) => { onStrategy(e.target.value); e.target.value = ""; }}
              title="Choose one keeper per group and select the remaining actionable copies"
            >
              <option value="" disabled>Apply a rule…</option>
              <option value="first">Current keeper</option>
              <option value="newest">Newest modified</option>
              <option value="oldest">Oldest modified</option>
              <option value="largest">Largest file</option>
              <option value="smallest">Smallest file</option>
              <option value="shortestPath">Shortest path</option>
              <option value="longestPath">Longest path</option>
              {driveLetters.map((drive) => (
                <option key={drive} value={`drive:${drive}`}>Copy on {drive}:</option>
              ))}
            </select>
          </label>
        </div>
      )}

      {ctrl.selectedCount > 0 && (
        <div className="df-selection-bar" role="region" aria-label="Actions for selected copies">
          <div className="df-selection-summary" role="status">
            <strong>{ctrl.selectedCount} selected</strong>
            <span>{formatBytes(ctrl.selectedBytes, "auto")} across {ctrl.selectedGroups} group{ctrl.selectedGroups !== 1 ? "s" : ""}</span>
            {hiddenSelectedCount > 0 && <span className="df-hidden-selection">{hiddenSelectedCount} hidden by filters</span>}
          </div>
          <label className="df-destination">
            <span>Destination <small>inside a scanned location</small></span>
            <input
              className="df-filter-input"
              value={ctrl.destPath}
              placeholder="Enter a scanned folder"
              spellCheck={false}
              disabled={ctrl.actionPending}
              onChange={(event) => ctrl.setDestPath(event.target.value)}
            />
          </label>
          <button className="df-tool-btn" onClick={() => void ctrl.moveSelected()} disabled={!ctrl.destPath.trim() || ctrl.actionPending}>Move</button>
          <button className="df-tool-btn" onClick={() => void ctrl.copySelected()} disabled={!ctrl.destPath.trim() || ctrl.actionPending}>Copy</button>
          <div className="df-toolbar-group">
            <button className="df-tool-btn" onClick={() => void ctrl.linkSelected(linkMode)} disabled={ctrl.actionPending}>
              <Icon name="link" size={12} /> Replace with link
            </button>
            <select
              className="df-select df-select-sm"
              value={linkMode}
              disabled={ctrl.actionPending}
              onChange={(e) => setLinkMode(e.target.value as "hardlink" | "symlink")}
              aria-label="Link type"
            >
              <option value="hardlink">Hard link</option>
              <option value="symlink">Symbolic link</option>
            </select>
          </div>
          <div className="df-toolbar-group df-delete-action">
            <select
              className="df-select df-select-sm"
              value={ctrl.deleteMode}
              disabled={ctrl.actionPending}
              onChange={(e) => ctrl.setDeleteMode(e.target.value as "recycle" | "permanent")}
              aria-label="Delete method"
            >
              <option value="recycle">Recycle Bin</option>
              <option value="permanent">Permanent</option>
            </select>
            <button
              className={`df-tool-btn${ctrl.deleteMode === "permanent" ? " df-tool-btn-danger" : " df-tool-btn-primary"}`}
              onClick={() => void ctrl.deleteSelected()}
              disabled={ctrl.actionPending}
            >
              <Icon name="trash" size={12} />
              {ctrl.actionPending ? "Working…" : ctrl.deleteMode === "permanent" ? "Delete permanently" : "Recycle selected"}
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      <div
        className="df-table"
        ref={(el) => { scrollRef.current = el; setScrollEl(el); }}
        role="treegrid"
        aria-label="Duplicate file groups"
        aria-rowcount={flatRows.length + 1}
        aria-multiselectable="true"
      >
        <div className="df-thead" role="row" aria-rowindex={1} style={{ gridTemplateColumns: gridTemplate, minWidth: minTableWidth }}>
          <div className="df-th df-th-gutter" role="columnheader">
            <input
              type="checkbox"
              className="df-checkbox"
              checked={allChecked}
              disabled={!visibleDupPaths.length || ctrl.actionPending}
              ref={(el) => { if (el) el.indeterminate = someChecked; }}
              onChange={() => (allChecked ? ctrl.unselectAll(visibleDupPaths) : ctrl.selectAll(visibleDupPaths))}
              aria-label="Select or clear all visible actionable copies"
            />
          </div>
          {cols.map((c) => (
            <div
              key={c.key}
              className={`df-th df-th-${c.align}`}
              data-col={c.key}
              role="columnheader"
              aria-sort={sortKey === c.key ? (sortDir === 1 ? "ascending" : "descending") : "none"}
            >
              <button onClick={() => onSort(c.key)}>
                {c.label}
                {sortKey === c.key && <Icon name={sortDir === 1 ? "caret-up" : "caret-down"} size={9} className="sort-caret" />}
              </button>
              <div
                className="col-resizer"
                role="separator"
                tabIndex={0}
                aria-label={`Resize ${c.label} column`}
                aria-orientation="vertical"
                aria-valuemin={MIN_COL_WIDTH}
                aria-valuenow={widthOf(c)}
                title="Drag or use arrow keys to resize"
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft") { event.preventDefault(); resizeColumn(c, -12); }
                  if (event.key === "ArrowRight") { event.preventDefault(); resizeColumn(c, 12); }
                  if (event.key === "Home") { event.preventDefault(); setWidths((prev) => ({ ...prev, [c.key]: c.width })); }
                }}
                onMouseDown={(e) => startResize(e, c)}
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          ))}
          <div className="df-th-filler" aria-hidden="true" />
        </div>

        {/* States */}
        {ctrl.scanState === "idle" && !ctrl.groups.length && (
          <DfEmpty icon="duplicates" title="Find duplicate files"
            sub="Pick scan targets and criteria in the left panel, then run a scan. Open tabs are reused automatically." />
        )}
        {scanning && (
          <div className="df-empty" role="status" aria-live="polite" aria-atomic="true">
            <div className="df-scanning-spinner" aria-hidden="true" />
            <div className="df-empty-title">
              {ctrl.phase === "hashing"
                ? ctrl.progress.hashing > 0 ? "Hashing candidate files…" : "Preparing candidate hashes…"
                : ctrl.phase === "grouping"
                  ? "Grouping matches…"
                  : ctrl.progress.scanned > 0 ? "Collecting files…" : "Starting file scan…"}
            </div>
            <div className="df-empty-sub">
              {ctrl.phase === "hashing"
                ? ctrl.progress.hashing > 0
                  ? `${ctrl.progress.hashed.toLocaleString()} / ${ctrl.progress.hashing.toLocaleString()} files read`
                  : "Finding files that share the same size"
                : ctrl.progress.scanned > 0
                  ? `${ctrl.progress.scanned.toLocaleString()} items indexed`
                  : "Waiting for the first file-system update"}
            </div>
            <div
              className="df-progress-track"
              role="progressbar"
              aria-label="Duplicate scan progress"
              aria-valuemin={0}
              aria-valuemax={ctrl.phase === "hashing" ? ctrl.progress.hashing : undefined}
              aria-valuenow={ctrl.phase === "hashing" ? ctrl.progress.hashed : undefined}
              aria-valuetext={
                ctrl.phase === "hashing" && ctrl.progress.hashing > 0
                  ? `${ctrl.progress.hashed} of ${ctrl.progress.hashing} files read`
                  : ctrl.progress.scanned > 0
                    ? `${ctrl.progress.scanned} items indexed`
                    : "Starting scan"
              }
            >
              <div className={`df-progress-bar ${ctrl.phase === "hashing" && ctrl.progress.hashing > 0 ? "df-progress-bar-determinate" : "df-progress-bar-sweep"}`}
                style={ctrl.phase === "hashing" && ctrl.progress.hashing > 0 ? { width: `${Math.min(100, (ctrl.progress.hashed / ctrl.progress.hashing) * 100)}%` } : undefined} />
            </div>
          </div>
        )}
        {ctrl.scanState === "error" && (
          <DfEmpty icon="warning" title="Scan failed" sub={ctrl.errors[0] ?? "Could not scan the selected paths."} error />
        )}
        {ctrl.scanState === "canceled" && !ctrl.groups.length && (
          <DfEmpty icon="duplicates" title="Scan stopped" sub="No files were changed. Adjust the scan settings or start again when you are ready." />
        )}
        {ctrl.scanState === "done" && !ctrl.groups.length && (
          <DfEmpty icon="check" title="No duplicates found" sub="No files matched your criteria and filters." />
        )}
        {ctrl.groups.length > 0 && displayGroups.length === 0 && (
          <DfEmpty icon="duplicates" title="No groups in this view" sub="Clear the search or choose a different review filter." />
        )}

        {/* Virtualized rows */}
        {displayGroups.length > 0 && (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative", minWidth: minTableWidth }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const row = flatRows[vi.index];
              if (!row) return null;
              const common = { position: "absolute" as const, top: vi.start, left: 0, right: 0, height: ROW_HEIGHT };
              if (row.kind === "group") {
                const g = row.group;
                const eligible = g.files.filter((f) => !f.ref && !f.protected).map((f) => f.path);
                const checked = eligible.length > 0 && eligible.every((p) => ctrl.selected.has(p));
                const partial = !checked && eligible.some((p) => ctrl.selected.has(p));
                const isCollapsed = ctrl.collapsed.has(row.key);
                const refFile = g.files.find((file) => file.ref) ?? g.files[0];
                const verified = isVerifiedGroup(g);
                const hasProtected = g.files.some((file) => file.protected);
                return (
                  <div
                    key={row.key}
                    className={`df-grp-row${checked ? " df-checked" : ""}`}
                    style={common}
                    role="row"
                    aria-level={1}
                    aria-expanded={!isCollapsed}
                    aria-rowindex={vi.index + 2}
                    aria-selected={checked}
                    data-dupe-row-index={vi.index}
                    tabIndex={activeRowIndex === vi.index ? 0 : -1}
                    onFocus={() => setActiveRowKey(row.key)}
                    onKeyDown={(event) => {
                      if (navigateRows(event, vi.index)) return;
                      if (event.key === "ArrowRight" && !isCollapsed) {
                        const child = flatRows[vi.index + 1];
                        if (child?.kind === "file" && child.group === g) {
                          event.preventDefault();
                          focusRow(vi.index + 1);
                          return;
                        }
                      }
                      if (event.target !== event.currentTarget) return;
                      if (event.key === " ") { event.preventDefault(); ctrl.toggleGroup(g); }
                      if (event.key === "ArrowLeft" && !isCollapsed) { event.preventDefault(); ctrl.toggleCollapse(row.key); }
                      if (event.key === "ArrowRight" && isCollapsed) { event.preventDefault(); ctrl.toggleCollapse(row.key); }
                      if (event.key === "Enter") { event.preventDefault(); setPreviewGroup(g); }
                    }}
                  >
                    <div className="df-grp-row-content" role="gridcell" aria-colspan={cols.length + 2}>
                    <button
                      className="df-twisty"
                      onClick={() => ctrl.toggleCollapse(row.key)}
                      aria-expanded={!isCollapsed}
                      aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${refFile?.name ?? "duplicate group"}`}
                    >
                      <Icon name={isCollapsed ? "chevron-right" : "chevron-down"} size={10} />
                    </button>
                    <input type="checkbox" className="df-checkbox" checked={checked}
                      ref={(el) => { if (el) el.indeterminate = partial; }}
                      onChange={() => ctrl.toggleGroup(g)}
                      disabled={!eligible.length || ctrl.actionPending}
                      aria-label={`Select actionable copies in ${refFile?.name ?? "group"}`}
                    />
                    <span className={`df-verification-badge ${verified ? "verified" : "possible"}`}>
                      {verified ? <><Icon name="check" size={10} /> Content match</> : `Review · ${g.score}%`}
                    </span>
                    <span className="df-grp-name" title={refFile?.path}>{refFile?.name ?? "—"}</span>
                    <span className="df-grp-count">{g.files.length} copies</span>
                    {hasProtected && <span className="df-protected-badge"><Icon name="bookmark" size={10} /> Protected keeper</span>}
                    <span className="df-grp-waste">{formatBytes(g.waste, "auto")} reclaimable</span>
                    <button className="df-grp-action" title="Preview the files in this group" onClick={() => setPreviewGroup(g)}>
                      <Icon name="image" size={11} /> Preview
                    </button>
                    <button className="df-grp-action" title="Hide this group from review" onClick={() => ctrl.ignoreGroup(g)} disabled={ctrl.actionPending}>
                      <Icon name="x" size={11} /> Hide
                    </button>
                    </div>
                  </div>
                );
              }
              const f = row.file;
              const isChecked = ctrl.selected.has(f.path);
              return (
                <div
                  key={row.key}
                  className={`df-file-row${isChecked ? " df-checked" : ""}${f.ref ? " df-is-ref" : ""}${f.protected ? " df-is-protected" : ""}`}
                  style={{ ...common, display: "grid", gridTemplateColumns: gridTemplate }}
                  role="row"
                  aria-level={2}
                  aria-rowindex={vi.index + 2}
                  aria-selected={isChecked}
                  data-dupe-row-index={vi.index}
                  tabIndex={activeRowIndex === vi.index ? 0 : -1}
                  onFocus={() => setActiveRowKey(row.key)}
                  onKeyDown={(event) => {
                    if (navigateRows(event, vi.index)) return;
                    if (event.key === "ArrowLeft") {
                      for (let index = vi.index - 1; index >= 0; index -= 1) {
                        if (flatRows[index]?.kind === "group") {
                          event.preventDefault();
                          focusRow(index);
                          return;
                        }
                      }
                    }
                    if (event.target !== event.currentTarget) return;
                    if (event.key === " " && !f.ref && !f.protected) {
                      event.preventDefault();
                      ctrl.toggleFile(f.path);
                    }
                    if (event.key === "Enter") {
                      event.preventDefault();
                      setPreviewGroup(row.group);
                    }
                  }}
                  onContextMenu={(e) => { e.preventDefault(); void revealPath(f.path); }}
                >
                  <div className="df-cell df-cell-gutter" role="gridcell">
                    <input
                      type="checkbox"
                      className="df-checkbox"
                      checked={isChecked}
                      disabled={f.ref || f.protected || ctrl.actionPending}
                      onChange={() => ctrl.toggleFile(f.path)}
                      aria-label={f.ref ? `${f.name} is the keeper` : f.protected ? `${f.name} is protected` : `Select ${f.name} for action`}
                    />
                  </div>
                  {cols.map((c) => (
                    <div key={c.key} className={`df-cell df-cell-${c.align}`} role="gridcell">{renderCell(f, row.group, c.key)}</div>
                  ))}
                  <div className="df-cell df-row-actions" role="gridcell">
                    {!f.ref && !row.group.files.some((file) => file.protected) && (
                      <button className="df-row-action" title="Keep this copy instead" onClick={() => ctrl.makeRef(row.group, f.path)} disabled={ctrl.actionPending}>Keep this</button>
                    )}
                    <button className="df-row-action" title="Reveal in Explorer" aria-label={`Reveal ${f.name} in Explorer`} onClick={() => void revealPath(f.path)}><Icon name="folder-open" size={12} /></button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="df-statusbar">
        {ctrl.scanState === "done" && (
          <>
            <span>{displayGroups.length} of {ctrl.groups.length} group{ctrl.groups.length !== 1 ? "s" : ""}</span>
            <span className="df-status-sep">·</span>
            <span>{displayGroups.reduce((sum, group) => sum + group.files.length, 0)} visible files</span>
            <span className="df-status-sep">·</span>
            <span className="df-waste">{formatBytes(visibleWaste, "auto")} reclaimable in view</span>
            {ctrl.selectedCount > 0 && (<><span className="df-status-sep">·</span><span>{ctrl.selectedCount} selected</span></>)}
            {ctrl.ignoredCount > 0 && (<><span className="df-status-sep">·</span><span className="df-status-ignored">{ctrl.ignoredCount} hidden</span></>)}
          </>
        )}
        {ctrl.scanState === "idle" && <span>Ready</span>}
        {ctrl.scanState === "canceled" && <span>Scan stopped · no files changed</span>}
        {scanning && <span>{ctrl.phase === "hashing" ? "Hashing…" : ctrl.phase === "grouping" ? "Grouping…" : "Scanning…"}</span>}
        {ctrl.errors.length > 0 && <span className="df-status-errors">{ctrl.errors.length} error{ctrl.errors.length !== 1 ? "s" : ""}</span>}
      </div>

      {previewGroup && (
        <DupeGroupPreview
          group={previewGroup}
          selected={ctrl.selected}
          disabled={ctrl.actionPending}
          onToggle={ctrl.toggleFile}
          onKeep={(path) => {
            ctrl.makeRef(previewGroup, path);
            setPreviewGroup(null);
          }}
          onClose={() => setPreviewGroup(null)}
        />
      )}
    </div>
  );
}

function MatchBar({ pct }: { pct: number }) {
  const v = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <span className="df-pct" title={`${v}% similarity`} aria-label={`${v}% similarity`}>
      <span className="df-pct-bar" style={{ width: `${v}%` }} aria-hidden="true" />
      <span className="df-pct-num">{v}%</span>
    </span>
  );
}

function DfEmpty({ icon, title, sub, error }: { icon: "duplicates" | "warning" | "check"; title: string; sub: string; error?: boolean }) {
  // Thin wrapper over the shared EmptyState so the duplicates view and the rest
  // of the app share one empty-state treatment.
  return <EmptyState icon={icon} title={title} hint={sub} error={error} />;
}
