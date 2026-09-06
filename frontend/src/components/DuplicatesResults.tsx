import { useCallback, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DupeFileV2, DupeGroupV2 } from "../api/types";
import type { DuplicatesController, KeepStrategy } from "../hooks/useDuplicates";
import { formatBytes } from "../utils/formatBytes";
import { formatDate } from "../utils/formatDate";
import { openPath, revealPath } from "../api/client";
import { promptDialog } from "../lib/dialogs";
import { hashingDeterminate, hashingPercent, hashingTitle } from "../lib/duplicatesScanUi";
import { Icon } from "./Icon";
import { EmptyState } from "./EmptyState";
import { FixedDropdown } from "./ConfigureColumnsMenu";
import { DuplicateDeletionDialog } from "./DuplicateDeletionDialog";
import { DupeGroupPreview } from "./DupeGroupPreview";

const ROW_HEIGHT = 22;
const GUTTER = 26;
const MIN_COL_WIDTH = 56;

type DupeColKey = "name" | "folder" | "size" | "modified" | "match" | "content";
type SortKey = DupeColKey | "waste";
type ReviewFilter = "all" | "selected" | "needs-review" | "protected";

interface DupeCol {
  key: DupeColKey;
  label: string;
  width: number;
  align: "left" | "right" | "center";
}

/** Column order mirrors dupeGuru's results table (Filename, Folder, Size, Match %). */
const COLUMNS: DupeCol[] = [
  { key: "name",     label: "Filename", width: 300, align: "left" },
  { key: "folder",   label: "Folder",   width: 300, align: "left" },
  { key: "size",     label: "Size",     width: 92,  align: "right" },
  { key: "modified", label: "Modified", width: 132, align: "right" },
  { key: "match",    label: "Match %",  width: 74,  align: "right" },
  { key: "content",  label: "Content",  width: 74,  align: "center" },
];

const REVIEW_FILTERS: { value: ReviewFilter; label: string }[] = [
  { value: "all",          label: "All groups" },
  { value: "selected",     label: "Marked" },
  { value: "needs-review", label: "Unverified" },
  { value: "protected",    label: "Reference folders" },
];

const KEEP_RULES: { value: KeepStrategy; label: string }[] = [
  { value: "newest",       label: "Newest modified" },
  { value: "oldest",       label: "Oldest modified" },
  { value: "largest",      label: "Largest file" },
  { value: "smallest",     label: "Smallest file" },
  { value: "shortestPath", label: "Shortest path" },
  { value: "longestPath",  label: "Longest path" },
];

function folderOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return idx >= 0 ? path.slice(0, idx) : "";
}

/** Signed, human duration for a seconds difference in "Delta Values" mode. */
function fmtDuration(sec: number): string {
  const a = Math.abs(sec);
  if (a < 1) return "0";
  const sign = sec > 0 ? "+" : "−";
  if (a < 90) return `${sign}${Math.round(a)}s`;
  if (a < 5400) return `${sign}${Math.round(a / 60)}m`;
  if (a < 172800) return `${sign}${Math.round(a / 3600)}h`;
  return `${sign}${Math.round(a / 86400)}d`;
}

/** One table row. The first file of a group is its reference and acts as the
 *  group's parent row, so there is no separate group header (as in dupeGuru). */
interface FlatRow {
  key: string;
  gkey: string;
  group: DupeGroupV2;
  file: DupeFileV2;
  leader: boolean;
}

function groupKey(g: DupeGroupV2): string {
  return g.files[0]?.path ?? "g";
}

function isVerifiedGroup(group: DupeGroupV2): boolean {
  return group.files
    .filter((file) => !file.ref)
    .every((file) => (file.match?.content ?? 0) >= 100);
}

export function DuplicatesResults({
  ctrl,
  onOpenSetup,
}: {
  ctrl: DuplicatesController;
  onOpenSetup?: () => void;
}) {
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
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const actionsBtnRef = useRef<HTMLDivElement>(null);
  const [colsMenuOpen, setColsMenuOpen] = useState(false);
  const colsBtnRef = useRef<HTMLDivElement>(null);
  const [previewGroup, setPreviewGroup] = useState<DupeGroupV2 | null>(null);
  const [activeRowKey, setActiveRowKey] = useState<string | null>(null);
  const [deletion, setDeletion] = useState<{ open: boolean; permanent: boolean }>({
    open: false,
    permanent: false,
  });

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
      const gkey = groupKey(g);
      const collapsed = ctrl.collapsed.has(gkey);
      g.files.forEach((file, index) => {
        const leader = index === 0;
        // "Dupes Only" drops the reference rows and flattens the tree.
        if (leader && dupesOnly) return;
        if (!leader && collapsed && !dupesOnly) return;
        rows.push({ key: `${gkey}|${file.path}`, gkey, group: g, file, leader: leader && !dupesOnly });
      });
    }
    return rows;
  }, [displayGroups, ctrl.collapsed, dupesOnly]);
  const activeRow = flatRows.find((row) => row.key === activeRowKey) ?? null;
  const activeGroup = activeRow?.group ?? null;
  const activeFile = activeRow?.file ?? null;

  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => ROW_HEIGHT,
    overscan: 24,
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
  const duplicateCount = useMemo(
    () => ctrl.groups.reduce((sum, group) => sum + Math.max(0, group.files.length - 1), 0),
    [ctrl.groups],
  );
  const protectedCopies = useMemo(
    () => ctrl.groups.reduce(
      (sum, group) => sum + group.files.filter((file) => file.protected).length,
      0,
    ),
    [ctrl.groups],
  );
  const selectedFiles = useMemo(
    () => ctrl.groups.flatMap((group) => group.files.filter((file) => ctrl.selected.has(file.path))),
    [ctrl.groups, ctrl.selected],
  );
  const unverifiedSelectedCount = selectedFiles.filter((file) => (file.match?.content ?? 0) < 100).length;
  const linkEligible = ctrl.selectedCount > 0 && unverifiedSelectedCount === 0;

  const renderCell = (f: DupeFileV2, g: DupeGroupV2, key: DupeColKey, leader: boolean) => {
    const ref = g.files.find((file) => file.ref) ?? g.files[0];
    switch (key) {
      case "name":
        return (
          <span className="dg-name" title={f.path} onDoubleClick={() => void openPath(f.path)}>
            {f.protected && <Icon name="bookmark" size={10} className="dg-name-flag" />}
            {f.name}
          </span>
        );
      case "folder":
        return <span className="dg-ellipsis" title={f.path}>{folderOf(f.path)}</span>;
      case "size":
        if (deltaValues && !leader) {
          const delta = f.size - ref.size;
          return <span className={delta === 0 ? "dg-zero" : "dg-delta"}>{delta === 0 ? "0" : `${delta > 0 ? "+" : "−"}${formatBytes(Math.abs(delta), "auto")}`}</span>;
        }
        return <span>{formatBytes(f.size, "auto")}</span>;
      case "modified":
        if (deltaValues && !leader) {
          const delta = f.modified - ref.modified;
          return <span className={delta === 0 ? "dg-zero" : "dg-delta"}>{fmtDuration(delta)}</span>;
        }
        return <span>{f.modified > 0 ? formatDate(f.modified * 1000) : "—"}</span>;
      case "match": {
        if (leader) return <span className="dg-zero">—</span>;
        const pct = Math.round(f.score ?? 0);
        return <span className={pct >= 100 ? "dg-match-full" : "dg-match-partial"}>{pct}</span>;
      }
      case "content":
        if (leader) return <span className="dg-zero">—</span>;
        return (f.match?.content ?? 0) >= 100
          ? <span className="dg-yes" title="Full-content hash match; rechecked byte-for-byte before any file changes">Yes</span>
          : <span className="dg-no" title="Not content-hash verified">Review</span>;
    }
  };

  const scanning = ctrl.scanState === "scanning";
  const hashedPct = hashingPercent(ctrl.progress);
  const hashingTitleText = hashingTitle(ctrl.phase, ctrl.progress);
  const hashingBarDeterminate = hashingDeterminate(ctrl.phase, ctrl.progress);
  const toggleableCols = COLUMNS.filter((c) => c.key !== "name");
  const openDeletion = useCallback((permanent = false) => {
    if (!ctrl.selectedCount || ctrl.actionPending) return;
    setDeletion({ open: true, permanent });
  }, [ctrl.actionPending, ctrl.selectedCount]);

  const transferMarked = useCallback(async (mode: "move" | "copy") => {
    if (!ctrl.selectedCount || ctrl.actionPending) return;
    const dest = await promptDialog({
      title: mode === "move" ? "Move marked files" : "Copy marked files",
      label: "Destination folder",
      message: `${ctrl.selectedCount} marked file${ctrl.selectedCount === 1 ? "" : "s"} will be ${mode === "move" ? "moved" : "copied"} there.`,
      initialValue: ctrl.destPath,
      placeholder: "D:\\quarantine",
      confirmLabel: mode === "move" ? "Move" : "Copy",
    });
    if (!dest) return;
    ctrl.setDestPath(dest);
    if (mode === "move") await ctrl.moveSelected(dest);
    else await ctrl.copySelected(dest);
  }, [ctrl]);

  const onResultsShortcut = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!event.ctrlKey || ctrl.actionPending) return;
    const key = event.key.toLowerCase();
    if (key === "a") {
      event.preventDefault();
      if (event.shiftKey) ctrl.invertSelection(visibleDupPaths);
      else ctrl.selectAll(visibleDupPaths);
      return;
    }
    if (key === "d" && ctrl.selectedCount > 0) {
      event.preventDefault();
      openDeletion(false);
      return;
    }
    if (key === "delete" && ctrl.selectedCount > 0) {
      event.preventDefault();
      openDeletion(true);
      return;
    }
    if (key === "m" && ctrl.selectedCount > 0) {
      event.preventDefault();
      void transferMarked(event.shiftKey ? "copy" : "move");
      return;
    }
    if (key === "r" && ctrl.selectedCount > 0) {
      event.preventDefault();
      ctrl.removeSelectedFromResults();
      return;
    }
    if (key === " " && activeGroup && activeFile && !activeFile.ref && !activeFile.protected) {
      event.preventDefault();
      event.stopPropagation();
      ctrl.makeRef(activeGroup, activeFile.path);
      return;
    }
    if (key === "o" && activeFile) {
      event.preventDefault();
      if (event.shiftKey) void revealPath(activeFile.path);
      else void openPath(activeFile.path);
    }
  }, [activeFile, activeGroup, ctrl, openDeletion, transferMarked, visibleDupPaths]);

  return (
    <div className="dg-page dg-results" aria-busy={ctrl.actionPending}>
      {/* Single dupeGuru-style toolbar: menu, view toggles, search. */}
      <div className="dg-toolbar">
        <div className="rb-dropdown-wrap" ref={actionsBtnRef}>
          <button
            type="button"
            className={`dg-btn${actionsMenuOpen ? " dg-btn-on" : ""}`}
            onClick={() => setActionsMenuOpen((open) => !open)}
            aria-expanded={actionsMenuOpen}
          >
            Actions <Icon name="caret-down" size={8} />
          </button>
          <FixedDropdown
            anchorRef={actionsBtnRef}
            open={actionsMenuOpen}
            onClose={() => setActionsMenuOpen(false)}
          >
            <div className="rb-dd-section">Mark</div>
            <button
              className="rb-col-row df-action-menu-row"
              disabled={!visibleDupPaths.length || ctrl.actionPending}
              onClick={() => { ctrl.selectAll(visibleDupPaths); setActionsMenuOpen(false); }}
            >
              <span>Mark All</span><kbd>Ctrl+A</kbd>
            </button>
            <button
              className="rb-col-row df-action-menu-row"
              disabled={!visibleDupPaths.length || ctrl.actionPending}
              onClick={() => { ctrl.invertSelection(visibleDupPaths); setActionsMenuOpen(false); }}
            >
              <span>Invert Marks</span><kbd>Ctrl+Shift+A</kbd>
            </button>
            <button
              className="rb-col-row df-action-menu-row"
              disabled={!ctrl.selectedCount || ctrl.actionPending}
              onClick={() => { ctrl.unselectAll(); setActionsMenuOpen(false); }}
            >
              <span>Mark None</span>
            </button>
            <div className="rb-dropdown-sep" />
            <div className="rb-dd-section">Re-prioritize &mdash; keep</div>
            {KEEP_RULES.map((rule) => (
              <button
                key={rule.value}
                className="rb-col-row df-action-menu-row"
                disabled={!ctrl.groups.length || ctrl.actionPending}
                onClick={() => { ctrl.keepStrategy(rule.value); setActionsMenuOpen(false); }}
              >
                <span>{rule.label}</span>
              </button>
            ))}
            {driveLetters.map((drive) => (
              <button
                key={drive}
                className="rb-col-row df-action-menu-row"
                disabled={!ctrl.groups.length || ctrl.actionPending}
                onClick={() => { ctrl.keepStrategy("drive", drive); setActionsMenuOpen(false); }}
              >
                <span>Copy on {drive}:</span>
              </button>
            ))}
            <div className="rb-dropdown-sep" />
            <div className="rb-dd-section">Marked files</div>
            <button
              className="rb-col-row df-action-menu-row"
              disabled={!ctrl.selectedCount || ctrl.actionPending}
              onClick={() => { setActionsMenuOpen(false); openDeletion(false); }}
            >
              <span>Send Marked to Recycle Bin&hellip;</span><kbd>Ctrl+D</kbd>
            </button>
            <button
              className="rb-col-row df-action-menu-row df-action-menu-danger"
              disabled={!ctrl.selectedCount || ctrl.actionPending}
              onClick={() => { setActionsMenuOpen(false); openDeletion(true); }}
            >
              <span>Delete Marked Permanently&hellip;</span><kbd>Ctrl+Del</kbd>
            </button>
            <button
              className="rb-col-row df-action-menu-row"
              disabled={!ctrl.selectedCount || ctrl.actionPending}
              onClick={() => { setActionsMenuOpen(false); void transferMarked("move"); }}
            >
              <span>Move Marked to&hellip;</span><kbd>Ctrl+M</kbd>
            </button>
            <button
              className="rb-col-row df-action-menu-row"
              disabled={!ctrl.selectedCount || ctrl.actionPending}
              onClick={() => { setActionsMenuOpen(false); void transferMarked("copy"); }}
            >
              <span>Copy Marked to&hellip;</span><kbd>Ctrl+Shift+M</kbd>
            </button>
            <button
              className="rb-col-row df-action-menu-row"
              disabled={!ctrl.selectedCount || ctrl.actionPending}
              onClick={() => { setActionsMenuOpen(false); ctrl.removeSelectedFromResults(); }}
            >
              <span>Remove Marked from Results</span><kbd>Ctrl+R</kbd>
            </button>
            <div className="rb-dropdown-sep" />
            <div className="rb-dd-section">Selected</div>
            <button
              className="rb-col-row df-action-menu-row"
              disabled={
                !activeFile
                || activeFile.ref
                || activeFile.protected
                || !!activeGroup?.files.some((file) => file.protected)
                || ctrl.actionPending
              }
              onClick={() => {
                if (activeGroup && activeFile) ctrl.makeRef(activeGroup, activeFile.path);
                setActionsMenuOpen(false);
              }}
            >
              <span>Make Selected into Reference</span><kbd>Ctrl+Space</kbd>
            </button>
            <button
              className="rb-col-row df-action-menu-row"
              disabled={!activeFile}
              onClick={() => {
                if (activeFile) void openPath(activeFile.path);
                setActionsMenuOpen(false);
              }}
            >
              <span>Open Selected</span><kbd>Ctrl+O</kbd>
            </button>
            <button
              className="rb-col-row df-action-menu-row"
              disabled={!activeFile}
              onClick={() => {
                if (activeFile) void revealPath(activeFile.path);
                setActionsMenuOpen(false);
              }}
            >
              <span>Open Containing Folder</span><kbd>Ctrl+Shift+O</kbd>
            </button>
            <button
              className="rb-col-row df-action-menu-row"
              disabled={!activeGroup || ctrl.actionPending}
              onClick={() => {
                if (activeGroup) ctrl.ignoreGroup(activeGroup);
                setActionsMenuOpen(false);
              }}
            >
              <span>Ignore Selected Group</span>
            </button>
            <button
              className="rb-col-row df-action-menu-row"
              disabled={!activeGroup}
              onClick={() => { setPreviewGroup(activeGroup); setActionsMenuOpen(false); }}
            >
              <span>Preview Selected Group</span>
            </button>
            <div className="rb-dropdown-sep" />
            <div className="rb-dd-section">Export</div>
            <button className="rb-col-row df-action-menu-row" disabled={!ctrl.groups.length} onClick={() => { ctrl.exportCsv(); setActionsMenuOpen(false); }}>
              <span>Export to CSV</span>
            </button>
            <button className="rb-col-row df-action-menu-row" disabled={!ctrl.groups.length} onClick={() => { ctrl.exportJson(); setActionsMenuOpen(false); }}>
              <span>Export to JSON</span>
            </button>
            {ctrl.ignoredCount > 0 && (
              <button className="rb-col-row df-action-menu-row" onClick={() => { ctrl.restoreIgnoredGroups(); setActionsMenuOpen(false); }}>
                <span>Restore {ctrl.ignoredCount} Ignored Group{ctrl.ignoredCount === 1 ? "" : "s"}</span>
              </button>
            )}
          </FixedDropdown>
        </div>

        <button
          type="button"
          className="dg-btn"
          disabled={!ctrl.selectedCount || ctrl.actionPending}
          onClick={() => openDeletion(false)}
        >
          <Icon name="trash" size={11} />
          {ctrl.actionPending ? "Working…" : "Delete Marked…"}
        </button>

        <span className="dg-toolbar-sep" />

        <button
          type="button"
          className={`dg-btn${detailsOpen ? " dg-btn-on" : ""}`}
          aria-pressed={detailsOpen}
          onClick={() => setDetailsOpen((open) => !open)}
        >
          Details
        </button>
        <label className="dg-check dg-check-inline">
          <input
            type="checkbox"
            className="df-checkbox"
            checked={dupesOnly}
            onChange={(event) => setDupesOnly(event.target.checked)}
          />
          <span>Dupes Only</span>
        </label>
        <label className="dg-check dg-check-inline">
          <input
            type="checkbox"
            className="df-checkbox"
            checked={deltaValues}
            onChange={(event) => setDeltaValues(event.target.checked)}
          />
          <span>Delta Values</span>
        </label>
        <label className="dg-field dg-field-inline">
          <span>Show:</span>
          <select
            className="dg-select"
            value={reviewFilter}
            onChange={(event) => setReviewFilter(event.target.value as ReviewFilter)}
          >
            {REVIEW_FILTERS.map((filter) => (
              <option key={filter.value} value={filter.value}>{filter.label}</option>
            ))}
          </select>
        </label>
        <div className="rb-dropdown-wrap" ref={colsBtnRef}>
          <button
            type="button"
            className={`dg-btn${colsMenuOpen ? " dg-btn-on" : ""}`}
            onClick={() => setColsMenuOpen((o) => !o)}
            aria-expanded={colsMenuOpen}
          >
            Columns <Icon name="caret-down" size={8} />
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

        <div className="dg-spacer" />

        <div className="dg-search">
          <Icon name="search" size={11} />
          <input
            value={search}
            aria-label="Search duplicate results"
            placeholder="Search"
            spellCheck={false}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button className="dg-search-clear" onClick={() => setSearch("")} title="Clear search" aria-label="Clear search">
              <Icon name="x" size={10} />
            </button>
          )}
        </div>
      </div>

      <div
        className="dg-grid dg-grid-flex"
        ref={(el) => { scrollRef.current = el; setScrollEl(el); }}
        role="treegrid"
        aria-label="Duplicate files"
        aria-rowcount={flatRows.length + 1}
        aria-multiselectable="true"
        onKeyDownCapture={onResultsShortcut}
      >
        <div className="dg-grid-head dg-grid-cols" role="row" aria-rowindex={1} style={{ gridTemplateColumns: gridTemplate, minWidth: minTableWidth }}>
          <div className="dg-th dg-th-gutter" role="columnheader">
            <input
              type="checkbox"
              className="df-checkbox"
              checked={allChecked}
              disabled={!visibleDupPaths.length || ctrl.actionPending}
              ref={(el) => { if (el) el.indeterminate = someChecked; }}
              onChange={() => (allChecked ? ctrl.unselectAll(visibleDupPaths) : ctrl.selectAll(visibleDupPaths))}
              aria-label="Mark or unmark all visible duplicates"
            />
          </div>
          {cols.map((c) => (
            <div
              key={c.key}
              className={`dg-th dg-th-${c.align}`}
              data-col={c.key}
              role="columnheader"
              aria-sort={sortKey === c.key ? (sortDir === 1 ? "ascending" : "descending") : "none"}
            >
              <button onClick={() => onSort(c.key)}>
                {c.label}
                {sortKey === c.key && <Icon name={sortDir === 1 ? "caret-up" : "caret-down"} size={8} className="sort-caret" />}
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
          <div className="dg-th-filler" aria-hidden="true" />
        </div>

        {/* States */}
        {ctrl.scanState === "idle" && !ctrl.groups.length && (
          <EmptyState
            icon="duplicates"
            title="No results"
            hint="Pick folders on the Directories tab, then press Scan."
            action={onOpenSetup ? { label: "Open Directories", onClick: onOpenSetup } : undefined}
          />
        )}
        {scanning && (
          <div className="df-empty" role="status" aria-live="polite" aria-atomic="true">
            <div className="df-scanning-spinner" aria-hidden="true" />
            <div className="df-empty-title">{hashingTitleText}</div>
            <div className="df-empty-sub">
              {ctrl.phase === "hashing"
                ? ctrl.progress.hashing > 0
                  ? `${ctrl.progress.hashing.toLocaleString()} candidates · ${hashedPct}%`
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
                  ? `${hashedPct}% of ${ctrl.progress.hashing} candidates processed`
                  : ctrl.progress.scanned > 0
                    ? `${ctrl.progress.scanned} items indexed`
                    : "Starting scan"
              }
            >
              <div
                className={`df-progress-bar ${hashingBarDeterminate ? "df-progress-bar-determinate" : "df-progress-bar-sweep"}`}
                style={hashingBarDeterminate
                  ? { width: `${Math.min(100, (ctrl.progress.hashed / ctrl.progress.hashing) * 100)}%` }
                  : undefined}
              />
            </div>
          </div>
        )}
        {ctrl.scanState === "error" && (
          <EmptyState icon="warning" title="Scan failed" hint={ctrl.errors[0] ?? "Could not scan the selected paths."} error />
        )}
        {ctrl.scanState === "canceled" && !ctrl.groups.length && (
          <EmptyState
            icon="duplicates"
            title="Scan stopped"
            hint="No files were changed."
            action={onOpenSetup ? { label: "Open Directories", onClick: onOpenSetup } : undefined}
          />
        )}
        {ctrl.scanState === "done" && !ctrl.groups.length && (
          <EmptyState
            icon="check"
            title="No duplicates found"
            hint="No files matched the current scan type and filters."
            action={onOpenSetup ? { label: "Open Directories", onClick: onOpenSetup } : undefined}
          />
        )}
        {ctrl.groups.length > 0 && displayGroups.length === 0 && (
          <EmptyState icon="duplicates" title="Nothing matches this view" hint="Clear the search box or change the Show filter." />
        )}

        {/* Virtualized rows */}
        {displayGroups.length > 0 && (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative", minWidth: minTableWidth }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const row = flatRows[vi.index];
              if (!row) return null;
              const f = row.file;
              const g = row.group;
              const isChecked = ctrl.selected.has(f.path);
              const collapsed = ctrl.collapsed.has(row.gkey);
              const markable = !f.ref && !f.protected;
              const classes = [
                "dg-row",
                row.leader ? "dg-row-leader" : "dg-row-child",
                isChecked ? "dg-row-marked" : "",
                f.protected ? "dg-row-protected" : "",
                activeRowKey === row.key ? "dg-row-active" : "",
              ].filter(Boolean).join(" ");
              return (
                <div
                  key={row.key}
                  className={classes}
                  style={{
                    position: "absolute",
                    top: vi.start,
                    left: 0,
                    right: 0,
                    height: ROW_HEIGHT,
                    display: "grid",
                    gridTemplateColumns: gridTemplate,
                  }}
                  role="row"
                  aria-level={row.leader ? 1 : 2}
                  aria-expanded={row.leader ? !collapsed : undefined}
                  aria-rowindex={vi.index + 2}
                  aria-selected={isChecked}
                  data-dupe-row-index={vi.index}
                  tabIndex={activeRowIndex === vi.index ? 0 : -1}
                  onFocus={() => setActiveRowKey(row.key)}
                  onClick={() => setActiveRowKey(row.key)}
                  onKeyDown={(event) => {
                    if (navigateRows(event, vi.index)) return;
                    if (event.target !== event.currentTarget) return;
                    if (event.key === " ") {
                      event.preventDefault();
                      if (row.leader) ctrl.toggleGroup(g);
                      else if (markable) ctrl.toggleFile(f.path);
                      return;
                    }
                    if (event.key === "ArrowLeft") {
                      if (row.leader && !collapsed) { event.preventDefault(); ctrl.toggleCollapse(row.gkey); return; }
                      for (let index = vi.index - 1; index >= 0; index -= 1) {
                        if (flatRows[index]?.leader) { event.preventDefault(); focusRow(index); return; }
                      }
                      return;
                    }
                    if (event.key === "ArrowRight" && row.leader && collapsed) {
                      event.preventDefault();
                      ctrl.toggleCollapse(row.gkey);
                      return;
                    }
                    if (event.key === "Enter") { event.preventDefault(); setPreviewGroup(g); }
                  }}
                  onContextMenu={(e) => { e.preventDefault(); void revealPath(f.path); }}
                >
                  <div className="dg-cell dg-cell-gutter" role="gridcell">
                    {row.leader ? (
                      <button
                        className="dg-twisty"
                        onClick={(event) => { event.stopPropagation(); ctrl.toggleCollapse(row.gkey); }}
                        tabIndex={-1}
                        aria-label={`${collapsed ? "Expand" : "Collapse"} group ${f.name}`}
                        title={collapsed ? "Expand group" : "Collapse group"}
                      >
                        <Icon name={collapsed ? "chevron-right" : "chevron-down"} size={9} />
                      </button>
                    ) : (
                      <input
                        type="checkbox"
                        className="df-checkbox"
                        checked={isChecked}
                        disabled={!markable || ctrl.actionPending}
                        onChange={() => ctrl.toggleFile(f.path)}
                        onClick={(event) => event.stopPropagation()}
                        aria-label={f.protected ? `${f.name} is in a reference folder` : `Mark ${f.name}`}
                      />
                    )}
                  </div>
                  {cols.map((c) => (
                    <div key={c.key} className={`dg-cell dg-cell-${c.align}`} data-col={c.key} role="gridcell">
                      {renderCell(f, g, c.key, row.leader)}
                    </div>
                  ))}
                  <div className="dg-cell dg-row-tail" role="gridcell">
                    {row.leader
                      ? <span className="dg-tail-note">{g.files.length} files · {formatBytes(g.waste, "auto")}</span>
                      : markable && (
                        <button
                          className="dg-row-action"
                          title="Make this file the group reference"
                          onClick={(event) => { event.stopPropagation(); ctrl.makeRef(g, f.path); }}
                          disabled={ctrl.actionPending || g.files.some((file) => file.protected)}
                        >
                          Make reference
                        </button>
                      )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {detailsOpen && (
        <DetailsPane file={activeFile} group={activeGroup} onPreview={() => setPreviewGroup(activeGroup)} />
      )}

      {/* dupeGuru status line: "1 / 937 (484 KB / 910 MB) duplicate marked" */}
      <div className="dg-statusbar">
        <span>
          {ctrl.selectedCount.toLocaleString()} / {duplicateCount.toLocaleString()}
          {" ("}{formatBytes(ctrl.selectedBytes, "auto")} / {formatBytes(ctrl.totalWaste, "auto")}{") "}
          duplicate{duplicateCount === 1 ? "" : "s"} marked
        </span>
        <span className="dg-status-sep">·</span>
        <span>{ctrl.groups.length.toLocaleString()} group{ctrl.groups.length === 1 ? "" : "s"}</span>
        {displayGroups.length !== ctrl.groups.length && (
          <><span className="dg-status-sep">·</span><span>{displayGroups.length.toLocaleString()} shown</span></>
        )}
        {protectedCopies > 0 && (
          <><span className="dg-status-sep">·</span><span>{protectedCopies.toLocaleString()} in reference folders</span></>
        )}
        {hiddenSelectedCount > 0 && (
          <><span className="dg-status-sep">·</span><span className="dg-status-warn">{hiddenSelectedCount} marked outside this view</span></>
        )}
        {ctrl.ignoredCount > 0 && (
          <><span className="dg-status-sep">·</span><span>{ctrl.ignoredCount} ignored</span></>
        )}
        <div className="dg-spacer" />
        {scanning && <span>{ctrl.phase === "hashing" ? "Hashing…" : ctrl.phase === "grouping" ? "Grouping…" : "Scanning…"}</span>}
        {ctrl.scanState === "canceled" && <span>Scan stopped — no files changed</span>}
        {ctrl.errors.length > 0 && (
          <span className="dg-status-errors" title={ctrl.errors.slice(0, 8).join("\n")}>
            {ctrl.errors.length} error{ctrl.errors.length === 1 ? "" : "s"}
          </span>
        )}
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
      {deletion.open && (
        <DuplicateDeletionDialog
          key={`${deletion.permanent ? "permanent" : "recycle"}-${ctrl.selectedCount}`}
          fileCount={ctrl.selectedCount}
          groupCount={ctrl.selectedGroups}
          bytes={ctrl.selectedBytes}
          linkEligible={linkEligible}
          unverifiedCount={unverifiedSelectedCount}
          pending={ctrl.actionPending}
          initialPermanent={deletion.permanent}
          onCancel={() => setDeletion({ open: false, permanent: false })}
          onConfirm={(request) => {
            void ctrl.executeDeletion(request).finally(() => {
              setDeletion({ open: false, permanent: false });
            });
          }}
        />
      )}
    </div>
  );
}

/** dupeGuru's Details panel: the selected file next to its group reference. */
function DetailsPane({
  file,
  group,
  onPreview,
}: {
  file: DupeFileV2 | null;
  group: DupeGroupV2 | null;
  onPreview: () => void;
}) {
  if (!file || !group) {
    return (
      <div className="dg-details" role="region" aria-label="File details">
        <div className="dg-details-empty">Select a row to compare it with its reference.</div>
      </div>
    );
  }
  const ref = group.files.find((f) => f.ref) ?? group.files[0];
  const isRef = ref === file;
  const rows: { label: string; a: string; b: string }[] = [
    { label: "Filename", a: file.name, b: ref.name },
    { label: "Folder", a: folderOf(file.path), b: folderOf(ref.path) },
    { label: "Size", a: formatBytes(file.size, "auto"), b: formatBytes(ref.size, "auto") },
    { label: "Modified", a: file.modified > 0 ? formatDate(file.modified * 1000) : "—", b: ref.modified > 0 ? formatDate(ref.modified * 1000) : "—" },
    { label: "Match %", a: isRef ? "—" : `${Math.round(file.score ?? 0)}`, b: "—" },
    { label: "Content verified", a: isRef ? "—" : (file.match?.content ?? 0) >= 100 ? "Yes" : "No", b: "—" },
    { label: "State", a: file.protected ? "Reference folder" : isRef ? "Reference" : "Duplicate", b: ref.protected ? "Reference folder" : "Reference" },
  ];
  return (
    <div className="dg-details" role="region" aria-label="File details">
      <div className="dg-details-head">
        <span>Details</span>
        <button type="button" className="dg-btn" onClick={onPreview}>Preview group</button>
      </div>
      <table className="dg-details-table">
        <thead>
          <tr>
            <th scope="col">Attribute</th>
            <th scope="col">Selected</th>
            <th scope="col">Reference</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className={row.a !== row.b ? "dg-details-diff" : undefined}>
              <th scope="row">{row.label}</th>
              <td title={row.a}>{row.a}</td>
              <td title={row.b}>{row.b}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
