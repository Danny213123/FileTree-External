import { useCallback, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DupeFileV2, DupeGroupV2 } from "../api/types";
import type { DuplicatesController } from "../hooks/useDuplicates";
import { formatBytes } from "../utils/formatBytes";
import { formatDate } from "../utils/formatDate";
import { openPath, revealPath } from "../api/client";
import { Icon } from "./Icon";
import { EmptyState } from "./EmptyState";
import { FixedDropdown } from "./ConfigureColumnsMenu";

const ROW_HEIGHT = 24;
const GUTTER = 42;
const MIN_COL_WIDTH = 56;

type DupeColKey = "name" | "match" | "dname" | "dsize" | "ddate" | "content" | "size" | "modified" | "folder";
type SortKey = DupeColKey | "waste";

interface DupeCol {
  key: DupeColKey;
  label: string;
  width: number;
  align: "left" | "right" | "center";
  delta?: boolean;
}

const COLUMNS: DupeCol[] = [
  { key: "name",     label: "Name",     width: 240, align: "left" },
  { key: "match",    label: "Match",    width: 80,  align: "center" },
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
  const [dupesOnly, setDupesOnly] = useState(false);
  const [deltaValues, setDeltaValues] = useState(false);
  const [colsMenuOpen, setColsMenuOpen] = useState(false);
  const colsBtnRef = useRef<HTMLDivElement>(null);

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

  const displayGroups = useMemo(() => {
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

  const allDupPaths = useMemo(
    () => ctrl.groups.flatMap((g) => g.files.filter((f) => !f.ref).map((f) => f.path)),
    [ctrl.groups],
  );
  const allChecked = allDupPaths.length > 0 && allDupPaths.every((p) => ctrl.selected.has(p));
  const someChecked = !allChecked && allDupPaths.some((p) => ctrl.selected.has(p));

  const renderCell = (f: DupeFileV2, g: DupeGroupV2, key: DupeColKey) => {
    const ref = g.files[0];
    switch (key) {
      case "name":
        return (
          <span className="df-file-name" title={f.path} onDoubleClick={() => void openPath(f.path)}>
            <span className="df-file-icon">{f.ref ? <Icon name="star-fill" size={11} /> : <Icon name="duplicates" size={11} />}</span>
            {f.name}
          </span>
        );
      case "match": return <MatchBar pct={f.ref ? 100 : f.score ?? 0} />;
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
          ? <span className="df-content-yes" title="Byte-identical"><Icon name="check" size={12} /></span>
          : <span className="df-dim" title="Not byte-verified">·</span>;
      case "size": return <span>{formatBytes(f.size, "auto")}</span>;
      case "modified": return <span>{f.modified > 0 ? formatDate(f.modified * 1000) : "—"}</span>;
      case "folder": return <span className="df-file-folder" title={f.path}>{folderOf(f.path)}</span>;
    }
  };

  const scanning = ctrl.scanState === "scanning";
  const toggleableCols = COLUMNS.filter((c) => c.key !== "name");

  return (
    <div className="df-results-root">
      {/* Toolbar */}
      <div className="df-toolbar">
        <div className="df-toolbar-group">
          <button className="df-tool-btn" onClick={ctrl.selectAll} disabled={!ctrl.groups.length}>Check All</button>
          <button className="df-tool-btn" onClick={ctrl.unselectAll} disabled={!ctrl.selectedCount}>Uncheck All</button>
          <button className="df-tool-btn" onClick={ctrl.keepFirst} disabled={!ctrl.groups.length} title="Check every duplicate, keep the reference">Keep First</button>
          <button className="df-tool-btn" onClick={ctrl.invertSelection} disabled={!ctrl.groups.length}>Invert</button>
        </div>
        <div className="df-toolbar-sep" />
        <div className="df-toolbar-group">
          <button className="df-tool-btn df-tool-btn-danger" onClick={() => void ctrl.deleteSelected()} disabled={!ctrl.selectedCount}>
            <Icon name="trash" size={12} /> Delete ({ctrl.selectedCount})
          </button>
          <select className="df-select df-select-sm" value={ctrl.deleteMode} onChange={(e) => ctrl.setDeleteMode(e.target.value as "recycle" | "permanent")}>
            <option value="recycle">Recycle Bin</option>
            <option value="permanent">Permanent</option>
          </select>
        </div>
        <div className="df-toolbar-sep" />
        <div className="df-toolbar-group">
          <button className="df-tool-btn" onClick={() => void ctrl.moveSelected()} disabled={!ctrl.selectedCount} title="Move checked files to destination">Move</button>
          <button className="df-tool-btn" onClick={() => void ctrl.copySelected()} disabled={!ctrl.selectedCount} title="Copy checked files to destination">Copy</button>
        </div>
        <div className="df-toolbar-sep" />
        <button className="df-tool-btn" onClick={ctrl.exportCsv} disabled={!ctrl.groups.length}>Export CSV</button>

        <div className="df-toolbar-spacer" />

        <div className="df-search">
          <Icon name="search" size={12} />
          <input value={search} placeholder="Filter results…" spellCheck={false} onChange={(e) => setSearch(e.target.value)} />
          {search && <button className="df-search-clear" onClick={() => setSearch("")} title="Clear"><Icon name="x" size={11} /></button>}
        </div>
        <button className={`df-tool-btn df-toggle${dupesOnly ? " df-toggle-on" : ""}`} onClick={() => setDupesOnly((v) => !v)} title="Hide reference rows">Dupes only</button>
        <button className={`df-tool-btn df-toggle${deltaValues ? " df-toggle-on" : ""}`} onClick={() => setDeltaValues((v) => !v)} title="Show raw differences instead of match %">Δ values</button>
        <div className="rb-dropdown-wrap" ref={colsBtnRef}>
          <button className={`df-tool-btn${colsMenuOpen ? " df-toggle-on" : ""}`} onClick={() => setColsMenuOpen((o) => !o)} title="Configure columns">
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
      </div>

      {/* Table */}
      <div className="df-table" ref={(el) => { scrollRef.current = el; setScrollEl(el); }}>
        <div className="df-thead" style={{ gridTemplateColumns: gridTemplate, minWidth: minTableWidth }}>
          <div className="df-th df-th-gutter">
            <input
              type="checkbox"
              className="df-checkbox"
              checked={allChecked}
              ref={(el) => { if (el) el.indeterminate = someChecked; }}
              onChange={() => (allChecked ? ctrl.unselectAll() : ctrl.selectAll())}
              title="Check / uncheck all duplicates"
            />
          </div>
          {cols.map((c) => (
            <div key={c.key} className={`df-th df-th-${c.align}`} data-col={c.key}>
              <button onClick={() => onSort(c.key)}>
                {c.label}
                {sortKey === c.key && <Icon name={sortDir === 1 ? "caret-up" : "caret-down"} size={9} className="sort-caret" />}
              </button>
              <div className="col-resizer" role="separator" title="Drag to resize"
                onMouseDown={(e) => startResize(e, c)} onClick={(e) => e.stopPropagation()} />
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
          <div className="df-empty">
            <div className="df-scanning-spinner" />
            <div className="df-empty-title">
              {ctrl.phase === "hashing" ? "Hashing candidate files…" : ctrl.phase === "grouping" ? "Grouping matches…" : "Collecting files…"}
            </div>
            <div className="df-empty-sub">
              {ctrl.phase === "hashing"
                ? `${ctrl.progress.hashed.toLocaleString()} / ${ctrl.progress.hashing.toLocaleString()} reads`
                : `${ctrl.progress.scanned.toLocaleString()} files`}
            </div>
            <div className="df-progress-track">
              <div className={`df-progress-bar ${ctrl.phase === "hashing" && ctrl.progress.hashing > 0 ? "df-progress-bar-determinate" : "df-progress-bar-sweep"}`}
                style={ctrl.phase === "hashing" && ctrl.progress.hashing > 0 ? { width: `${Math.min(100, (ctrl.progress.hashed / ctrl.progress.hashing) * 100)}%` } : undefined} />
            </div>
          </div>
        )}
        {ctrl.scanState === "error" && (
          <DfEmpty icon="warning" title="Scan failed" sub={ctrl.errors[0] ?? "Could not scan the selected paths."} error />
        )}
        {ctrl.scanState === "done" && !ctrl.groups.length && (
          <DfEmpty icon="check" title="No duplicates found" sub="No files matched your criteria and filters." />
        )}

        {/* Virtualized rows */}
        {ctrl.groups.length > 0 && (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative", minWidth: minTableWidth }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const row = flatRows[vi.index];
              if (!row) return null;
              const common = { position: "absolute" as const, top: vi.start, left: 0, right: 0, height: ROW_HEIGHT };
              if (row.kind === "group") {
                const g = row.group;
                const eligible = g.files.filter((f) => !f.ref).map((f) => f.path);
                const checked = eligible.length > 0 && eligible.every((p) => ctrl.selected.has(p));
                const partial = !checked && eligible.some((p) => ctrl.selected.has(p));
                const isCollapsed = ctrl.collapsed.has(row.key);
                const refFile = g.files[0];
                return (
                  <div key={row.key} className={`df-grp-row${checked ? " df-checked" : ""}`} style={common}>
                    <button className="df-twisty" onClick={() => ctrl.toggleCollapse(row.key)}>
                      <Icon name={isCollapsed ? "chevron-right" : "chevron-down"} size={10} />
                    </button>
                    <input type="checkbox" className="df-checkbox" checked={checked}
                      ref={(el) => { if (el) el.indeterminate = partial; }} onChange={() => ctrl.toggleGroup(g)} />
                    {g.score < 100 && <span className="df-score-badge">{g.score}%</span>}
                    <span className="df-grp-name" title={refFile?.path}>{refFile?.name ?? "—"}</span>
                    <span className="df-grp-count">{g.files.length} copies</span>
                    <span className="df-grp-waste">−{formatBytes(g.waste, "auto")}</span>
                    <button className="df-grp-ignore" title="Ignore this group" onClick={() => ctrl.ignoreGroup(g)}>
                      <Icon name="x" size={11} /> Ignore
                    </button>
                  </div>
                );
              }
              const f = row.file;
              const isChecked = ctrl.selected.has(f.path);
              return (
                <div
                  key={row.key}
                  className={`df-file-row${isChecked ? " df-checked" : ""}${f.ref ? " df-is-ref" : ""}`}
                  style={{ ...common, display: "grid", gridTemplateColumns: gridTemplate }}
                  onContextMenu={(e) => { e.preventDefault(); void revealPath(f.path); }}
                >
                  <div className="df-cell df-cell-gutter">
                    <input type="checkbox" className="df-checkbox" checked={isChecked} disabled={f.ref}
                      onChange={() => ctrl.toggleFile(f.path)} />
                  </div>
                  {cols.map((c) => (
                    <div key={c.key} className={`df-cell df-cell-${c.align}`}>{renderCell(f, row.group, c.key)}</div>
                  ))}
                  <div className="df-cell df-row-actions">
                    {!f.ref && (
                      <button className="df-row-action" title="Make this the reference" onClick={() => ctrl.makeRef(row.group, f.path)}>Make Ref</button>
                    )}
                    <button className="df-row-action" title="Reveal in Explorer" onClick={() => void revealPath(f.path)}><Icon name="folder-open" size={12} /></button>
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
            <span>{ctrl.groups.length} group{ctrl.groups.length !== 1 ? "s" : ""}</span>
            <span className="df-status-sep">·</span>
            <span>{ctrl.totalFiles} files</span>
            <span className="df-status-sep">·</span>
            <span className="df-waste">{formatBytes(ctrl.totalWaste, "auto")} reclaimable</span>
            {ctrl.selectedCount > 0 && (<><span className="df-status-sep">·</span><span>{ctrl.selectedCount} checked</span></>)}
            {ctrl.ignoredCount > 0 && (<><span className="df-status-sep">·</span><span className="df-status-ignored">{ctrl.ignoredCount} ignored</span></>)}
          </>
        )}
        {ctrl.scanState === "idle" && <span>Ready</span>}
        {scanning && <span>{ctrl.phase === "hashing" ? "Hashing…" : ctrl.phase === "grouping" ? "Grouping…" : "Scanning…"}</span>}
        {ctrl.errors.length > 0 && <span className="df-status-errors">{ctrl.errors.length} error{ctrl.errors.length !== 1 ? "s" : ""}</span>}
      </div>
    </div>
  );
}

function MatchBar({ pct }: { pct: number }) {
  const v = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <span className="df-pct" title={`${v}%`}>
      <span className="df-pct-bar" style={{ width: `${v}%` }} />
      <span className="df-pct-num">{v}</span>
    </span>
  );
}

function DfEmpty({ icon, title, sub, error }: { icon: "duplicates" | "warning" | "check"; title: string; sub: string; error?: boolean }) {
  // Thin wrapper over the shared EmptyState so the duplicates view and the rest
  // of the app share one empty-state treatment.
  return <EmptyState icon={icon} title={title} hint={sub} error={error} />;
}
