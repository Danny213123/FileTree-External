import { useState, useEffect, useRef, useCallback } from "react";
import type { Metric, Unit, DriveEntry, SpecialFolder, SortKey } from "../api/types";
import { exitApp } from "../api/client";

type RibbonTab = "home" | "scan" | "view" | "duplicates" | "treemapChart" | "options";

export interface RibbonBarProps {
  scanPath: string;
  onPathChange: (p: string) => void;
  onScan: () => void;
  onCancel: () => void;
  scanning: boolean;
  hasScan: boolean;
  drives: DriveEntry[];
  specialFolders: SpecialFolder[];
  metric: Metric;
  unit: Unit;
  filter: string;
  showFiles: boolean;
  includeHidden: boolean;
  followLinks: boolean;
  exclude: string;
  threads: number;
  onMetricChange: (m: Metric) => void;
  onUnitChange: (u: Unit) => void;
  onFilterChange: (f: string) => void;
  onShowFilesChange: (v: boolean) => void;
  onHiddenChange: (v: boolean) => void;
  onFollowLinksChange: (v: boolean) => void;
  onExcludeChange: (e: string) => void;
  onThreadsChange: (t: number) => void;
  onNavigateParent: () => void;
  onScanPath: (path: string) => void;
  onExpand: (level: number) => void;
  onNewFolder: () => void;
  onOpenFilter: () => void;
  onExport: (format: "csv" | "json") => void;
  onOpenLocation: () => void;
  onCopyFiles: () => void;
  bookmarks: string[];
  filterActive: boolean;
  darkMode: boolean;
  onDarkModeChange: (v: boolean) => void;
  activeTab: string;
  activeRibbonTab: string;
  onRibbonTabChange: (tab: string) => void;
  onShowDetails: () => void;
  onShowTreemap: () => void;
  treemapPosition: "bottom" | "right";
  treemapDetail: number;
  onTreemapPositionChange: (p: "bottom" | "right") => void;
  onTreemapDetailChange: (d: number) => void;
  tmShowSingleFiles: boolean;
  tmShow3D: boolean;
  tmShowHierarchy: boolean;
  tmShowLegend: boolean;
  tmShowLabels: boolean;
  tmDragDrop: boolean;
  onTmShowSingleFilesChange: (v: boolean) => void;
  onTmShow3DChange: (v: boolean) => void;
  onTmShowHierarchyChange: (v: boolean) => void;
  onTmShowLegendChange: (v: boolean) => void;
  onTmShowLabelsChange: (v: boolean) => void;
  onTmDragDropChange: (v: boolean) => void;
  // View tab
  decimals: number;
  visibleColumns: Set<SortKey>;
  sortKey: string;
  sortDir: 1 | -1;
  onDecimalsChange: (d: number) => void;
  onVisibleColumnsChange: (cols: Set<SortKey>) => void;
  onSortChange: (key: SortKey, dir: 1 | -1) => void;
  onSaveSession: () => void;
  onLoadSession: () => void;
}

// ── SVG icon components ────────────────────────────────────
// All icons match TreeSize's Office-ribbon icon style

function IcoFolder() {
  return (
    <svg width="26" height="22" viewBox="0 0 26 22" fill="none">
      <rect x="1" y="6" width="24" height="15" rx="2" fill="#F5C542" stroke="#C8981E" strokeWidth="1"/>
      <path d="M1 9h24V7a2 2 0 0 0-2-2h-9l-2-2H3a2 2 0 0 0-2 2v4z" fill="#F9D85A" stroke="#C8981E" strokeWidth="1"/>
    </svg>
  );
}

function IcoFolderOpen() {
  return (
    <svg width="26" height="22" viewBox="0 0 26 22" fill="none">
      <path d="M1 7h10l2 3h12v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V9a2 2 0 0 1 0-2z" fill="#F5C542" stroke="#C8981E" strokeWidth="1"/>
      <path d="M3 10h21l-3 9H2L1 11a1 1 0 0 1 .95-1H3z" fill="#F9D85A" stroke="#C8981E" strokeWidth="0.8"/>
    </svg>
  );
}

function IcoSize() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <rect x="2" y="16" width="6" height="6" rx="1" fill="#4A90D9"/>
      <rect x="2" y="10" width="10" height="5" rx="1" fill="#4A90D9" opacity="0.8"/>
      <rect x="2" y="4" width="20" height="5" rx="1" fill="#4A90D9" opacity="0.6"/>
    </svg>
  );
}

function IcoAllocated() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <rect x="2" y="16" width="6" height="6" rx="1" fill="#E8832A"/>
      <rect x="2" y="10" width="10" height="5" rx="1" fill="#E8832A" opacity="0.8"/>
      <rect x="2" y="4" width="20" height="5" rx="1" fill="#E8832A" opacity="0.6"/>
      <path d="M18 10l3 3-3 3M21 13H13" stroke="#E8832A" strokeWidth="1.8" strokeLinecap="round"/>
    </svg>
  );
}

function IcoFileCount() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <rect x="4" y="2" width="12" height="16" rx="1.5" fill="#6B7280" stroke="#9CA3AF" strokeWidth="1"/>
      <path d="M14 2l4 4h-4V2z" fill="#9CA3AF"/>
      <line x1="7" y1="8" x2="13" y2="8" stroke="white" strokeWidth="1.2" strokeLinecap="round"/>
      <line x1="7" y1="11" x2="13" y2="11" stroke="white" strokeWidth="1.2" strokeLinecap="round"/>
      <circle cx="18" cy="18" r="5" fill="#E53E3E"/>
      <text x="18" y="21.5" textAnchor="middle" fill="white" fontSize="7" fontWeight="bold">#</text>
    </svg>
  );
}

function IcoPercent() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <circle cx="8" cy="8" r="4" fill="#48BB78"/>
      <circle cx="16" cy="16" r="4" fill="#48BB78"/>
      <line x1="4" y1="20" x2="20" y2="4" stroke="#48BB78" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  );
}

function IcoAutoUnits() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      {/* ruler body */}
      <rect x="2" y="9" width="20" height="6" rx="1" fill="#4A90D9" opacity="0.85"/>
      {/* tick marks */}
      <line x1="6"  y1="9" x2="6"  y2="12" stroke="white" strokeWidth="1.2"/>
      <line x1="10" y1="9" x2="10" y2="11" stroke="white" strokeWidth="1.2"/>
      <line x1="14" y1="9" x2="14" y2="12" stroke="white" strokeWidth="1.2"/>
      <line x1="18" y1="9" x2="18" y2="11" stroke="white" strokeWidth="1.2"/>
    </svg>
  );
}

function IcoExpand() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <rect x="2" y="2" width="8" height="8" rx="1" stroke="#4A90D9" strokeWidth="1.5" fill="none"/>
      <rect x="12" y="2" width="8" height="8" rx="1" stroke="#4A90D9" strokeWidth="1.5" fill="none"/>
      <rect x="2" y="12" width="8" height="8" rx="1" stroke="#4A90D9" strokeWidth="1.5" fill="none"/>
      <rect x="12" y="12" width="8" height="8" rx="1" stroke="#4A90D9" strokeWidth="1.5" fill="none"/>
    </svg>
  );
}

function IcoCopyFiles() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <rect x="5" y="4" width="12" height="15" rx="1.5" fill="#DBEAFE" stroke="#4A90D9" strokeWidth="1.2"/>
      <rect x="3" y="2" width="12" height="15" rx="1.5" fill="#EFF6FF" stroke="#4A90D9" strokeWidth="1.2"/>
      <path d="M7 7h6M7 10h6M7 13h4" stroke="#4A90D9" strokeWidth="1" strokeLinecap="round"/>
    </svg>
  );
}

function IcoNewFolder() {
  return (
    <svg width="26" height="22" viewBox="0 0 26 22" fill="none">
      <rect x="1" y="6" width="20" height="15" rx="2" fill="#F5C542" stroke="#C8981E" strokeWidth="1"/>
      <path d="M1 9h20V7a2 2 0 0 0-2-2H9L7 3H3a2 2 0 0 0-2 2v4z" fill="#F9D85A" stroke="#C8981E" strokeWidth="1"/>
      <circle cx="21" cy="17" r="4.5" fill="white" stroke="#48BB78" strokeWidth="1"/>
      <line x1="21" y1="14.5" x2="21" y2="19.5" stroke="#48BB78" strokeWidth="1.8" strokeLinecap="round"/>
      <line x1="18.5" y1="17" x2="23.5" y2="17" stroke="#48BB78" strokeWidth="1.8" strokeLinecap="round"/>
    </svg>
  );
}

function IcoFiles() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <rect x="3" y="2" width="10" height="14" rx="1.5" fill="#E2E8F0" stroke="#94A3B8" strokeWidth="1"/>
      <path d="M11 2l4 4h-4V2z" fill="#CBD5E1"/>
      <rect x="8" y="7" width="10" height="14" rx="1.5" fill="#DBEAFE" stroke="#93C5FD" strokeWidth="1"/>
      <path d="M16 7l4 4h-4V7z" fill="#BFDBFE"/>
    </svg>
  );
}

function IcoHidden() {
  return (
    <svg width="24" height="22" viewBox="0 0 24 22" fill="none">
      <ellipse cx="12" cy="11" rx="10" ry="6" stroke="#6B7280" strokeWidth="1.5" fill="none"/>
      <circle cx="12" cy="11" r="3" fill="#6B7280"/>
      <line x1="4" y1="4" x2="20" y2="18" stroke="#EF4444" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  );
}

function IcoLinks() {
  return (
    <svg width="24" height="22" viewBox="0 0 24 22" fill="none">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" stroke="#4A90D9" strokeWidth="1.8" strokeLinecap="round" fill="none"/>
      <path d="M14 9a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" stroke="#4A90D9" strokeWidth="1.8" strokeLinecap="round" fill="none"/>
    </svg>
  );
}

function IcoFilter() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <path d="M2 4h18l-7 9v7l-4-2V13L2 4z" fill="#9CA3AF" stroke="#6B7280" strokeWidth="1" strokeLinejoin="round"/>
    </svg>
  );
}

function IcoSearch() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <circle cx="9" cy="9" r="6.5" stroke="#4A90D9" strokeWidth="2" fill="none"/>
      <line x1="13.8" y1="13.8" x2="20" y2="20" stroke="#4A90D9" strokeWidth="2.5" strokeLinecap="round"/>
    </svg>
  );
}

function IcoParent() {
  return (
    <svg width="26" height="22" viewBox="0 0 26 22" fill="none">
      <rect x="1" y="8" width="18" height="13" rx="2" fill="#F5C542" stroke="#C8981E" strokeWidth="1"/>
      <path d="M1 11h18V9a2 2 0 0 0-2-2H9L7 5H3a2 2 0 0 0-2 2v4z" fill="#F9D85A" stroke="#C8981E" strokeWidth="1"/>
      <path d="M19 4l4 4-4 4" stroke="#4A90D9" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
      <line x1="19" y1="8" x2="11" y2="8" stroke="#4A90D9" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  );
}


// ── primitive components ───────────────────────────────────

function RbGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rb-group">
      <div className="rb-group-body">{children}</div>
      <div className="rb-group-label">{label}</div>
    </div>
  );
}

function RbBtn({
  icon,
  label,
  active,
  disabled,
  wide,
  onClick,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  disabled?: boolean;
  wide?: boolean;
  onClick?: () => void;
  title?: string;
}) {
  return (
    <button
      className={`rb-btn${active ? " rb-active" : ""}${wide ? " rb-btn-wide" : ""}`}
      disabled={disabled}
      onClick={onClick}
      title={title ?? label}
    >
      <span className="rb-icon">{icon}</span>
      <span className="rb-label">{label}</span>
    </button>
  );
}

function RbBtnSm({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      className={`rb-btn-sm${active ? " rb-active" : ""}`}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

// ── Select Directory dropdown ──────────────────────────────

const RECENT_KEY = "filetree_recent_paths";
const MAX_RECENT = 8;

function loadRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

export function loadRecentPaths(): string[] {
  return loadRecent();
}

export function pushRecent(path: string) {
  const list = [path, ...loadRecent().filter((p) => p !== path)].slice(0, MAX_RECENT);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

export function setRecentPaths(paths: string[]) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(paths.slice(0, MAX_RECENT))); } catch { /* ignore */ }
}

// Inline SVG icons matching TreeSize's dropdown icon style
function IcoDropFolder() {
  return (
    <svg width="16" height="14" viewBox="0 0 16 14" fill="none" style={{ display: "block" }}>
      <rect x="0.5" y="3.5" width="15" height="10" rx="1" fill="#F5C542" stroke="#C8981E" strokeWidth="0.8"/>
      <path d="M0.5 6h15V4.5a1 1 0 0 0-1-1H7L5.5 2H1.5a1 1 0 0 0-1 1V6z" fill="#F9D85A" stroke="#C8981E" strokeWidth="0.8"/>
    </svg>
  );
}

function IcoDriveSmall() {
  return (
    <svg width="16" height="14" viewBox="0 0 16 14" fill="none" style={{ display: "block" }}>
      <rect x="0.5" y="1" width="15" height="11" rx="1.5" fill="#6B7280" stroke="#9CA3AF" strokeWidth="0.8"/>
      <rect x="1.5" y="2" width="13" height="5" rx="0.8" fill="#374151"/>
      <circle cx="3.5" cy="11" r="1" fill="#4ADE80"/>
    </svg>
  );
}

function IcoDocSmall() {
  return (
    <svg width="16" height="14" viewBox="0 0 16 14" fill="none" style={{ display: "block" }}>
      <rect x="2" y="1" width="9" height="12" rx="1" fill="#BFDBFE" stroke="#93C5FD" strokeWidth="0.8"/>
      <path d="M9 1l3 3h-3V1z" fill="#93C5FD"/>
      <line x1="4" y1="6" x2="9" y2="6" stroke="#60A5FA" strokeWidth="0.8"/>
      <line x1="4" y1="8" x2="9" y2="8" stroke="#60A5FA" strokeWidth="0.8"/>
    </svg>
  );
}

function IcoStarSmall() {
  return (
    <svg width="16" height="14" viewBox="0 0 16 14" fill="none" style={{ display: "block" }}>
      <path d="M8 1l1.8 3.6L14 5.3l-3 2.9.7 4.1L8 10.4l-3.7 1.9.7-4.1-3-2.9 4.2-.7z" fill="#F5C542" stroke="#C8981E" strokeWidth="0.8" strokeLinejoin="round"/>
    </svg>
  );
}

function IcoOneDriveSmall() {
  return (
    <svg width="16" height="14" viewBox="0 0 16 14" fill="none" style={{ display: "block" }}>
      <path d="M2 9.5c0-2 1.5-3.5 3.3-3.5.2 0 .5 0 .7.1C6.5 4.5 8 3.5 9.8 3.5c2.1 0 3.8 1.6 3.9 3.6.7.3 1.3 1 1.3 1.9 0 1.1-.9 2-2 2H4a2 2 0 0 1-2-1.5z" fill="#0078D4" opacity="0.85"/>
    </svg>
  );
}

function IcoRecycleBinSmall() {
  return (
    <svg width="14" height="16" viewBox="0 0 14 16" fill="currentColor" style={{ display: "block" }}>
      <path d="M1 3.5h12M4.5 1.5h5M2 3.5l1 10h6l1-10M5.5 6v5M8.5 6v5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" fill="none"/>
    </svg>
  );
}

function ScanDropdown({
  drives,
  specialFolders,
  scanning,
  bookmarks,
  onScanPath,
}: {
  drives: DriveEntry[];
  specialFolders: SpecialFolder[];
  scanning: boolean;
  bookmarks: string[];
  onScanPath: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  const handleOpen = () => {
    setRecent(loadRecent());
    setOpen((o) => !o);
  };

  const pick = (path: string) => {
    onScanPath(path);
    close();
  };

  // Separate OneDrive entries from regular special folders and Recycle Bin
  const cloudFolders = specialFolders.filter((f) =>
    f.label.toLowerCase().startsWith("onedrive")
  );
  const docFolders = specialFolders.filter((f) =>
    !f.label.toLowerCase().startsWith("onedrive") && f.label !== "Recycle Bin"
  );
  const recycleBin = specialFolders.find((f) => f.label === "Recycle Bin");
  const hasCloud = cloudFolders.length > 0 || docFolders.length > 0;

  return (
    <div className="rb-dropdown-wrap" ref={ref}>
      <RbBtn
        icon={<IcoFolderOpen />}
        label="Select Directory ▾"
        wide
        onClick={handleOpen}
        disabled={scanning}
      />
      <FixedDropdown anchorRef={ref} open={open} onClose={close}>
        {/* Bookmarks */}
        {bookmarks.length > 0 && (
          <>
            <div className="rb-dd-section">Bookmarks</div>
            {bookmarks.map((p) => (
              <button key={p} onClick={() => pick(p)} title={p}>
                <IcoStarSmall />
                <span className="rb-dd-text">{p}</span>
              </button>
            ))}
            <div className="rb-dropdown-sep" />
          </>
        )}

        {/* Recently scanned */}
        <div className="rb-dd-section">Recently scanned</div>
        {recent.length === 0 && <div className="rb-dd-empty">(none)</div>}
        {recent.map((p) => (
          <button key={p} onClick={() => pick(p)} title={p}>
            <IcoDropFolder />
            <span className="rb-dd-text">{p}</span>
          </button>
        ))}

        <div className="rb-dropdown-sep" />

        {/* Directory */}
        <div className="rb-dd-section">Directory</div>
        <button onClick={close}>
          <IcoDropFolder />
          <span className="rb-dd-text">Select Directory to scan</span>
        </button>

        {/* Documents and cloud */}
        {hasCloud && (
          <>
            <div className="rb-dropdown-sep" />
            <div className="rb-dd-section">Documents and cloud</div>
            {cloudFolders.map((f) => (
              <button key={f.path} onClick={() => pick(f.path)} title={f.path}>
                <IcoOneDriveSmall />
                <span className="rb-dd-text">{f.label}</span>
              </button>
            ))}
            {docFolders.map((f) => (
              <button key={f.path} onClick={() => pick(f.path)} title={f.path}>
                <IcoDocSmall />
                <span className="rb-dd-text">{f.label}</span>
              </button>
            ))}
          </>
        )}

        {recycleBin && (
          <>
            <div className="rb-dropdown-sep" />
            <div className="rb-dd-section">System</div>
            <button onClick={() => pick(recycleBin.path)} title={recycleBin.path}>
              <IcoRecycleBinSmall />
              <span className="rb-dd-text">Recycle Bin</span>
            </button>
          </>
        )}

        <div className="rb-dropdown-sep" />

        {/* Drives */}
        <div className="rb-dd-section">Drives</div>
        {drives.map((d) => (
          <button key={d.root} onClick={() => pick(d.root)} title={d.root}>
            <IcoDriveSmall />
            <span className="rb-dd-text">{d.label}</span>
          </button>
        ))}
      </FixedDropdown>
    </div>
  );
}

// ── Expand dropdown ───────────────────────────────────────

function ExpandDropdown({ onExpand }: { onExpand: (level: number) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  const pick = (level: number) => { onExpand(level); close(); };

  return (
    <div className="rb-dropdown-wrap" ref={ref}>
      <RbBtn
        icon={<IcoExpand />}
        label="Expand ▾"
        onClick={() => setOpen((o) => !o)}
      />
      <FixedDropdown anchorRef={ref} open={open} onClose={close}>
        {[1, 2, 3, 4, 5, 6].map((lvl) => (
          <button key={lvl} onClick={() => pick(lvl)}>
            To Level {lvl}
          </button>
        ))}
        <div className="rb-dropdown-sep" />
        <button onClick={() => pick(Infinity)}>Full Expand</button>
      </FixedDropdown>
    </div>
  );
}

// ── ribbon tab panels ──────────────────────────────────────

const UNIT_OPTIONS: { v: Unit; l: string }[] = [
  { v: "auto",  l: "Automatic Units" },
  { v: "tb",    l: "Values in TB" },
  { v: "gb",    l: "Values in GB" },
  { v: "mb",    l: "Values in MB" },
  { v: "kb",    l: "Values in KB" },
  { v: "bytes", l: "Values in Byte" },
];

/** Renders a fixed-position dropdown anchored below its trigger button.
 *  Uses getBoundingClientRect so the menu escapes overflow:hidden parents. */
function FixedDropdown({
  anchorRef,
  open,
  onClose,
  children,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (anchorRef.current && anchorRef.current.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open, anchorRef, onClose]);

  if (!open || !anchorRef.current) return null;
  const rect = anchorRef.current.getBoundingClientRect();
  return (
    <div
      className="rb-dropdown-menu"
      style={{ position: "fixed", top: rect.bottom, left: rect.left, zIndex: 9999 }}
    >
      {children}
    </div>
  );
}

const UNIT_ABBREV: Record<Unit, string> = {
  auto: "Auto", tb: "TB", gb: "GB", mb: "MB", kb: "KB", bytes: "B",
};

function UnitDropdown({ unit, onUnitChange }: { unit: Unit; onUnitChange: (u: Unit) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);

  return (
    <div className="rb-dropdown-wrap" ref={ref}>
      <RbBtn
        icon={<IcoAutoUnits />}
        label={`${UNIT_ABBREV[unit]} ▾`}
        active={unit !== "auto"}
        onClick={() => setOpen((o) => !o)}
        title={`Units (current: ${UNIT_ABBREV[unit]})`}
      />
      <FixedDropdown anchorRef={ref} open={open} onClose={close}>
        {UNIT_OPTIONS.map((item) => (
          <button
            key={item.v}
            className={unit === item.v ? "rb-active" : ""}
            onClick={() => { onUnitChange(item.v); close(); }}
          >
            <span className="rb-dd-check">{unit === item.v ? "✓" : ""}</span>
            {item.l}
          </button>
        ))}
      </FixedDropdown>
    </div>
  );
}

function HomeRibbon({
  drives,
  specialFolders,
  scanning,
  metric,
  unit,
  includeHidden,
  followLinks,
  showFiles,
  bookmarks,
  onScan,
  onCancel,
  onScanPath,
  onMetricChange,
  onUnitChange,
  onHiddenChange,
  onFollowLinksChange,
  onShowFilesChange,
  onExpand,
  onNewFolder,
}: Pick<RibbonBarProps,
  | "drives" | "specialFolders" | "scanning" | "metric" | "unit"
  | "includeHidden" | "followLinks" | "showFiles" | "bookmarks"
  | "onScan" | "onCancel" | "onScanPath" | "onMetricChange" | "onUnitChange"
  | "onHiddenChange" | "onFollowLinksChange" | "onShowFilesChange"
  | "onExpand" | "onNewFolder"
>) {
  return (
    <>
      <RbGroup label="Scan">
        <div className="rb-col">
          <ScanDropdown
            drives={drives}
            specialFolders={specialFolders}
            scanning={scanning}
            bookmarks={bookmarks}
            onScanPath={onScanPath}
          />
        </div>
        <div className="rb-col rb-col-sm">
          <RbBtnSm label="⏹ Stop Scan" disabled={!scanning} onClick={onCancel} />
          <RbBtnSm label="↺ Refresh" disabled={scanning} onClick={onScan} />
        </div>
      </RbGroup>

      <RbGroup label="Mode">
        <RbBtn icon={<IcoSize />}      label="Size"             active={metric === "size"}      onClick={() => onMetricChange("size")} />
        <RbBtn icon={<IcoAllocated />} label="Allocated Space"  active={metric === "allocated"} onClick={() => onMetricChange("allocated")} />
        <RbBtn icon={<IcoFileCount />} label="File Count"       active={metric === "files"}     onClick={() => onMetricChange("files")} />
        <RbBtn icon={<IcoPercent />}   label="Percent"          active={metric === "folders"}   onClick={() => onMetricChange("folders")} />
      </RbGroup>

      <RbGroup label="Unit">
        <UnitDropdown unit={unit} onUnitChange={onUnitChange} />
      </RbGroup>

      <RbGroup label="Options">
        <RbBtn icon={<IcoFiles />}  label="Files"  active={showFiles}      onClick={() => onShowFilesChange(!showFiles)} />
        <RbBtn icon={<IcoHidden />} label="Hidden" active={includeHidden}  onClick={() => onHiddenChange(!includeHidden)} />
        <RbBtn icon={<IcoLinks />}  label="Links"  active={followLinks}    onClick={() => onFollowLinksChange(!followLinks)} />
      </RbGroup>

      <RbGroup label="Folder Operations">
        <ExpandDropdown onExpand={onExpand} />
        <RbBtn icon={<IcoNewFolder />} label="New Folder" onClick={onNewFolder} />
      </RbGroup>
    </>
  );
}

function ExportDropdown({ onExport, disabled }: { onExport: (f: "csv" | "json") => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div className="rb-dropdown-wrap" ref={ref}>
      <RbBtn icon={<IcoFolder />} label="Export ▾" disabled={disabled} onClick={() => setOpen((o) => !o)} />
      <FixedDropdown anchorRef={ref} open={open} onClose={() => setOpen(false)}>
        <div className="rb-dd-section">Export scan as</div>
        <button onClick={() => { onExport("csv"); setOpen(false); }}>
          <IcoDocSmall />
          <span className="rb-dd-text">CSV (.csv)</span>
        </button>
        <button onClick={() => { onExport("json"); setOpen(false); }}>
          <IcoDocSmall />
          <span className="rb-dd-text">JSON (.json)</span>
        </button>
      </FixedDropdown>
    </div>
  );
}

function ScanRibbon({
  drives,
  specialFolders,
  scanning,
  filter,
  exclude,
  includeHidden,
  followLinks,
  threads,
  bookmarks,
  filterActive,
  onScan,
  onCancel,
  onScanPath,
  onFilterChange,
  onExcludeChange,
  onHiddenChange,
  onFollowLinksChange,
  onThreadsChange,
  onNavigateParent,
  onExpand,
  onOpenFilter,
  onExport,
  onOpenLocation,
  onCopyFiles,
  hasScan,
}: Pick<RibbonBarProps,
  | "drives" | "specialFolders" | "scanning" | "hasScan" | "filter" | "exclude"
  | "includeHidden" | "followLinks" | "threads" | "bookmarks" | "filterActive"
  | "onScan" | "onCancel" | "onScanPath" | "onFilterChange" | "onExcludeChange"
  | "onHiddenChange" | "onFollowLinksChange" | "onThreadsChange" | "onNavigateParent"
  | "onExpand" | "onOpenFilter" | "onExport" | "onOpenLocation" | "onCopyFiles"
>) {
  return (
    <>
      <RbGroup label="Operations">
        <div className="rb-col">
          <ScanDropdown
            drives={drives}
            specialFolders={specialFolders}
            scanning={scanning}
            bookmarks={bookmarks}
            onScanPath={onScanPath}
          />
        </div>
        <div className="rb-col rb-col-sm">
          <RbBtnSm label="⏹ Stop Scan" disabled={!scanning} onClick={onCancel} />
          <RbBtnSm label="↺ Refresh"   disabled={scanning}  onClick={onScan} />
        </div>
      </RbGroup>

      <RbGroup label="Filter">
        <div className="rb-col">
          <RbBtn
            icon={<IcoFilter />}
            label="Filter"
            active={filterActive}
            onClick={onOpenFilter}
          />
        </div>
        <div className="rb-col rb-col-sm rb-col-inputs">
          <input
            className="rb-text-input"
            type="text"
            value={filter}
            onChange={(e) => onFilterChange(e.target.value.trim().toLowerCase())}
            placeholder="Quick filter rows…"
          />
          <input
            className="rb-text-input"
            type="text"
            value={exclude}
            onChange={(e) => onExcludeChange(e.target.value)}
            placeholder="Exclude (comma-sep)…"
          />
          <div className="rb-inline-row">
            <RbBtnSm label="Clear Filter" onClick={() => { onFilterChange(""); onExcludeChange(""); }} />
            <label className="rb-check">
              <input type="checkbox" checked={includeHidden} onChange={(e) => onHiddenChange(e.target.checked)} />
              Hide Empty Folders
            </label>
          </div>
        </div>
      </RbGroup>

      <RbGroup label="Directory Tree">
        <ExpandDropdown onExpand={onExpand} />
        <RbBtn icon={<IcoSearch />} label="Search Tree" onClick={onOpenFilter} active={filterActive} />
      </RbGroup>

      <RbGroup label="Tools">
        <RbBtn icon={<IcoParent />} label="Parent Folder"  onClick={onNavigateParent} />
        <ExportDropdown onExport={onExport} disabled={!hasScan} />
        <RbBtn icon={<IcoFolderOpen />} label="Open Location" onClick={onOpenLocation} disabled={!hasScan} />
        <RbBtn icon={<IcoCopyFiles />} label="Copy Files" onClick={onCopyFiles} disabled={!hasScan} title="Copy selected item to clipboard (paste in Explorer)" />
      </RbGroup>

      <RbGroup label="Threads">
        <div className="rb-col rb-col-sm">
          <label className="rb-field-label">Threads</label>
          <input
            className="rb-num-input"
            type="number"
            min={1}
            max={64}
            value={threads}
            onChange={(e) => onThreadsChange(Number(e.target.value))}
          />
          <label className="rb-check">
            <input type="checkbox" checked={followLinks} onChange={(e) => onFollowLinksChange(e.target.checked)} />
            Follow Links
          </label>
        </div>
      </RbGroup>
    </>
  );
}

function IcoDecimals() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <text x="2" y="15" fill="#4A90D9" fontSize="13" fontWeight="bold">.00</text>
    </svg>
  );
}

function IcoColumns() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <rect x="2" y="3" width="20" height="18" rx="1.5" stroke="currentColor" strokeWidth="1.4" fill="none"/>
      <line x1="9" y1="3" x2="9" y2="21" stroke="currentColor" strokeWidth="1.2"/>
      <line x1="16" y1="3" x2="16" y2="21" stroke="currentColor" strokeWidth="1.2"/>
      <line x1="2" y1="8" x2="22" y2="8" stroke="currentColor" strokeWidth="1"/>
    </svg>
  );
}

function IcoSort() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <line x1="3" y1="6" x2="21" y2="6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <line x1="3" y1="12" x2="15" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <line x1="3" y1="18" x2="9" y2="18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M19 10l3 4-3 4M22 14h-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

const SORT_COLUMNS: { key: SortKey; label: string }[] = [
  { key: "name",        label: "Name" },
  { key: "size",        label: "Size" },
  { key: "allocated",   label: "Allocated" },
  { key: "files",       label: "Files" },
  { key: "folders",     label: "Folders" },
  { key: "percent",     label: "% of Parent" },
  { key: "type",        label: "Type" },
  { key: "modified",    label: "Last Modified" },
  { key: "created",     label: "Creation Date" },
  { key: "accessed",    label: "Last Accessed" },
  { key: "avgFileSize", label: "Avg. File Size" },
  { key: "pathLength",  label: "Path Length" },
  { key: "dirLevel",    label: "Dir Level" },
];

interface ColGroup { label: string; cols: { key: SortKey; label: string; disabled?: boolean }[] }

const COL_GROUPS: ColGroup[] = [
  {
    label: "Common",
    cols: [
      { key: "name",        label: "Name" },
      { key: "path",        label: "Full Path" },
      { key: "folderPath",  label: "Folder Path" },
      { key: "size",        label: "Size" },
      { key: "allocated",   label: "Allocated" },
      { key: "type",        label: "Type" },
      { key: "files",       label: "Files" },
      { key: "folders",     label: "Folders" },
      { key: "attributes",  label: "Attributes" },
      { key: "percent",     label: "% of Parent" },
    ],
  },
  {
    label: "Date and time",
    cols: [
      { key: "created",  label: "Creation Date" },
      { key: "accessed", label: "Last Accessed" },
      { key: "modified", label: "Last Modified" },
    ],
  },
  {
    label: "Extended",
    cols: [
      { key: "avgFileSize", label: "Avg. File Size" },
      { key: "pathLength",  label: "Path Length" },
      { key: "dirLevel",    label: "Dir Level (Relative)" },
    ],
  },
];

function DecimalsDropdown({ decimals, onDecimalsChange }: { decimals: number; onDecimalsChange: (d: number) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className="rb-dropdown-wrap" ref={ref}>
      <RbBtn icon={<IcoDecimals />} label={`Decimals ▾`} onClick={() => setOpen((o) => !o)} title={`${decimals} decimal places`} />
      <FixedDropdown anchorRef={ref} open={open} onClose={close}>
        {[0,1,2,3,4,5].map((d) => (
          <button key={d} className={decimals === d ? "rb-active" : ""} onClick={() => { onDecimalsChange(d); close(); }}>
            {d === 0 ? "0 — No decimals" : `${d} — ${(1.23456789).toFixed(d)} ...`}
          </button>
        ))}
      </FixedDropdown>
    </div>
  );
}

const DEFAULT_COL_SET = new Set<SortKey>(["name", "size", "allocated", "files", "folders", "percent", "modified"]);

function ConfigureColumnsDropdown({ visibleColumns, onVisibleColumnsChange }: { visibleColumns: Set<SortKey>; onVisibleColumnsChange: (cols: Set<SortKey>) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const toggle = (key: SortKey) => {
    if (key === "name") return;
    const next = new Set(visibleColumns);
    if (next.has(key)) next.delete(key); else next.add(key);
    onVisibleColumnsChange(next);
  };
  return (
    <div className="rb-dropdown-wrap" ref={ref}>
      <RbBtn icon={<IcoColumns />} label="Configure columns ▾" onClick={() => setOpen((o) => !o)} />
      <FixedDropdown anchorRef={ref} open={open} onClose={close}>
        {COL_GROUPS.map((group) => (
          <div key={group.label}>
            <div className="rb-dd-section">{group.label}</div>
            {group.cols.map((col) => (
              <button
                key={col.key}
                onClick={() => toggle(col.key)}
                disabled={col.key === "name"}
                className="rb-col-row"
              >
                <span className="rb-col-check">{visibleColumns.has(col.key) ? "✓" : ""}</span>
                {col.label}
              </button>
            ))}
          </div>
        ))}
        <div className="rb-dropdown-sep" />
        <div className="rb-dd-section">Settings</div>
        <button className="rb-col-reset" onClick={() => { onVisibleColumnsChange(new Set(DEFAULT_COL_SET)); close(); }}>
          <span className="rb-col-reset-icon">↺</span>
          <span>
            <strong>Reset Columns</strong>
            <br />
            <span style={{ fontSize: 11, opacity: 0.7 }}>Reset the columns of the details list to the default settings.</span>
          </span>
        </button>
      </FixedDropdown>
    </div>
  );
}

function SortDropdown({ sortKey, sortDir, onSortChange }: { sortKey: string; sortDir: 1 | -1; onSortChange: (key: SortKey, dir: 1 | -1) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className="rb-dropdown-wrap" ref={ref}>
      <RbBtn icon={<IcoSort />} label="Sort ▾" onClick={() => setOpen((o) => !o)} />
      <FixedDropdown anchorRef={ref} open={open} onClose={close}>
        {SORT_COLUMNS.map((col) => (
          <button key={col.key} className={sortKey === col.key ? "rb-active" : ""} onClick={() => { onSortChange(col.key, sortDir); close(); }}>
            {col.label}
          </button>
        ))}
        <div className="rb-dropdown-sep" />
        <button className={sortDir === 1 ? "rb-active" : ""} onClick={() => { onSortChange(sortKey as SortKey, 1); close(); }}>↑ Ascending</button>
        <button className={sortDir === -1 ? "rb-active" : ""} onClick={() => { onSortChange(sortKey as SortKey, -1); close(); }}>↓ Descending</button>
      </FixedDropdown>
    </div>
  );
}

function ViewRibbon({
  metric,
  unit,
  onMetricChange,
  onUnitChange,
  activeTab,
  onShowDetails,
  onShowTreemap,
  decimals,
  visibleColumns,
  sortKey,
  sortDir,
  onDecimalsChange,
  onVisibleColumnsChange,
  onSortChange,
}: Pick<RibbonBarProps, "metric" | "unit" | "onMetricChange" | "onUnitChange" | "activeTab" | "onShowDetails" | "onShowTreemap" | "decimals" | "visibleColumns" | "sortKey" | "sortDir" | "onDecimalsChange" | "onVisibleColumnsChange" | "onSortChange">) {
  return (
    <>
      <RbGroup label="Mode">
        <RbBtn icon={<IcoSize />}      label="Size"       active={metric === "size"}      onClick={() => onMetricChange("size")} />
        <RbBtn icon={<IcoAllocated />} label="Allocated"  active={metric === "allocated"} onClick={() => onMetricChange("allocated")} />
        <RbBtn icon={<IcoFileCount />} label="File Count" active={metric === "files"}     onClick={() => onMetricChange("files")} />
        <RbBtn icon={<IcoPercent />}   label="Percent"    active={metric === "folders"}   onClick={() => onMetricChange("folders")} />
      </RbGroup>

      <RbGroup label="Unit">
        <UnitDropdown unit={unit} onUnitChange={onUnitChange} />
      </RbGroup>

      <RbGroup label="Visible columns">
        <DecimalsDropdown decimals={decimals} onDecimalsChange={onDecimalsChange} />
        <ConfigureColumnsDropdown visibleColumns={visibleColumns} onVisibleColumnsChange={onVisibleColumnsChange} />
      </RbGroup>

      <RbGroup label="Sort">
        <SortDropdown sortKey={sortKey} sortDir={sortDir} onSortChange={onSortChange} />
      </RbGroup>

      <RbGroup label="Show or hide">
        <RbBtn icon={<IcoFiles />}  label="Details" active={activeTab === "details"} onClick={onShowDetails} />
        <RbBtn icon={<IcoExpand />} label="Treemap" active={activeTab === "chart"}   onClick={onShowTreemap} />
      </RbGroup>
    </>
  );
}

function IcoRightPane() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <rect x="2" y="3" width="20" height="18" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none"/>
      <line x1="14" y1="4" x2="14" y2="20" stroke="currentColor" strokeWidth="1.5"/>
      <rect x="15" y="5" width="6" height="14" rx="1" fill="currentColor" opacity="0.35"/>
    </svg>
  );
}

function IcoBottomPane() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <rect x="2" y="3" width="20" height="18" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none"/>
      <line x1="3" y1="14" x2="21" y2="14" stroke="currentColor" strokeWidth="1.5"/>
      <rect x="3" y="15" width="18" height="5" rx="1" fill="currentColor" opacity="0.35"/>
    </svg>
  );
}

function TmCheck({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`rb-tm-check${disabled ? " rb-tm-check-disabled" : ""}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function DuplicatesRibbon({
  scanning, hasScan,
}: { scanning: boolean; hasScan: boolean }) {
  return (
    <>
      <RbGroup label="Find">
        <RbBtn
          icon={<IcoSearch />}
          label="Find Duplicates"
          active
          disabled={scanning}
          onClick={undefined}
        />
      </RbGroup>
      <RbGroup label="About">
        <div style={{ padding: "4px 8px", fontSize: 11.5, color: "var(--muted)", maxWidth: 260, lineHeight: 1.4, overflow: "hidden" }}>
          Find byte-identical files. Select drives in the sidebar, then click <strong>Scan</strong>.
          {!hasScan && <span style={{ color: "var(--warn)", display: "block", marginTop: 2 }}>⚠ Select drives or scan a folder first.</span>}
        </div>
      </RbGroup>
    </>
  );
}

function TreemapChartRibbon({
  treemapPosition, treemapDetail,
  onTreemapPositionChange, onTreemapDetailChange,
  tmShowSingleFiles, tmShow3D, tmShowHierarchy, tmShowLegend, tmShowLabels, tmDragDrop,
  onTmShowSingleFilesChange, onTmShow3DChange, onTmShowHierarchyChange,
  onTmShowLegendChange, onTmShowLabelsChange, onTmDragDropChange,
}: Pick<RibbonBarProps,
  | "treemapPosition" | "treemapDetail" | "onTreemapPositionChange" | "onTreemapDetailChange"
  | "tmShowSingleFiles" | "tmShow3D" | "tmShowHierarchy" | "tmShowLegend" | "tmShowLabels" | "tmDragDrop"
  | "onTmShowSingleFilesChange" | "onTmShow3DChange" | "onTmShowHierarchyChange"
  | "onTmShowLegendChange" | "onTmShowLabelsChange" | "onTmDragDropChange"
>) {
  return (
    <>
      <RbGroup label="Position">
        <RbBtn icon={<IcoRightPane />}  label="Right Pane"  active={treemapPosition === "right"}  onClick={() => onTreemapPositionChange("right")} />
        <RbBtn icon={<IcoBottomPane />} label="Bottom Pane" active={treemapPosition === "bottom"} onClick={() => onTreemapPositionChange("bottom")} />
      </RbGroup>

      <RbGroup label="Level of Detail">
        <div className="rb-col rb-col-sm">
          <div className="rb-detail-labels">
            <span>More</span>
            <span>Fewer</span>
          </div>
          <input
            className="rb-detail-slider"
            type="range"
            min={1}
            max={5}
            step={1}
            /* Invert: left end = "More" = highest detail (5), like TreeSize. */
            value={6 - treemapDetail}
            onChange={(e) => onTreemapDetailChange(6 - Number(e.target.value))}
          />
        </div>
      </RbGroup>

      <RbGroup label="Appearance">
        <div className="rb-tm-check-grid">
          <TmCheck label="Show single files" checked={tmShowSingleFiles} onChange={onTmShowSingleFilesChange} />
          <TmCheck label="Show legend"       checked={tmShowLegend}      onChange={onTmShowLegendChange} />
          <TmCheck label="Show chart in 3D"  checked={tmShow3D}          onChange={onTmShow3DChange} />
          <TmCheck label="Show labels"       checked={tmShowLabels}      onChange={onTmShowLabelsChange} />
          <TmCheck label="Show hierarchy"    checked={tmShowHierarchy}   onChange={onTmShowHierarchyChange} />
          <TmCheck label="Show free space on drive" checked={false} onChange={() => {}} disabled />
        </div>
      </RbGroup>

      <RbGroup label="Options">
        <TmCheck label="Enable Drag && Drop operations" checked={tmDragDrop} onChange={onTmDragDropChange} />
      </RbGroup>
    </>
  );
}

function IcoDarkMode() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" fill="#7B8FA8" stroke="#A0B0C4" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function IcoLightMode() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="5" fill="#F5C542" stroke="#C8981E" strokeWidth="1.5"/>
      <line x1="12" y1="2" x2="12" y2="5" stroke="#C8981E" strokeWidth="1.5" strokeLinecap="round"/>
      <line x1="12" y1="19" x2="12" y2="22" stroke="#C8981E" strokeWidth="1.5" strokeLinecap="round"/>
      <line x1="2" y1="12" x2="5" y2="12" stroke="#C8981E" strokeWidth="1.5" strokeLinecap="round"/>
      <line x1="19" y1="12" x2="22" y2="12" stroke="#C8981E" strokeWidth="1.5" strokeLinecap="round"/>
      <line x1="4.22" y1="4.22" x2="6.34" y2="6.34" stroke="#C8981E" strokeWidth="1.5" strokeLinecap="round"/>
      <line x1="17.66" y1="17.66" x2="19.78" y2="19.78" stroke="#C8981E" strokeWidth="1.5" strokeLinecap="round"/>
      <line x1="19.78" y1="4.22" x2="17.66" y2="6.34" stroke="#C8981E" strokeWidth="1.5" strokeLinecap="round"/>
      <line x1="6.34" y1="17.66" x2="4.22" y2="19.78" stroke="#C8981E" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  );
}

function OptionsRibbon({
  darkMode,
  onDarkModeChange,
}: Pick<RibbonBarProps, "darkMode" | "onDarkModeChange">) {
  return (
    <>
      <RbGroup label="Appearance">
        <RbBtn
          icon={darkMode ? <IcoLightMode /> : <IcoDarkMode />}
          label={darkMode ? "Light Mode" : "Dark Mode"}
          active={darkMode}
          onClick={() => onDarkModeChange(!darkMode)}
        />
      </RbGroup>
    </>
  );
}

// ── main export ────────────────────────────────────────────

// ── File menu (replaces brand) ─────────────────────────────

function IcoSelectDir() {
  return (
    <svg width="22" height="20" viewBox="0 0 22 20" fill="none">
      <rect x="1" y="5" width="20" height="14" rx="2" fill="#F5C542" stroke="#C8981E" strokeWidth="1"/>
      <path d="M1 8h20V6a2 2 0 0 0-2-2H9L7 2H3a2 2 0 0 0-2 2v4z" fill="#F9D85A" stroke="#C8981E" strokeWidth="1"/>
    </svg>
  );
}
function IcoRefresh() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <path d="M4 11a7 7 0 1 1 2 4.9" stroke="#4A90D9" strokeWidth="2" strokeLinecap="round" fill="none"/>
      <path d="M4 16V11H9" stroke="#4A90D9" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    </svg>
  );
}
function IcoStop() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <rect x="4" y="4" width="14" height="14" rx="2" fill="#E53E3E"/>
    </svg>
  );
}
function IcoNewWindow() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <rect x="2" y="5" width="13" height="13" rx="1.5" stroke="#4A90D9" strokeWidth="1.5" fill="none"/>
      <rect x="7" y="2" width="13" height="13" rx="1.5" fill="#DBEAFE" stroke="#4A90D9" strokeWidth="1.5"/>
    </svg>
  );
}
function IcoExportFile() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <rect x="3" y="2" width="12" height="16" rx="1.5" fill="#BFDBFE" stroke="#93C5FD" strokeWidth="1"/>
      <path d="M13 2l4 4h-4V2z" fill="#93C5FD"/>
      <path d="M11 18l3 3M11 18l-3 3M11 18v-5" stroke="#4A90D9" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
function IcoAbout() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <circle cx="11" cy="11" r="9" fill="#DBEAFE" stroke="#4A90D9" strokeWidth="1.5"/>
      <text x="11" y="15.5" textAnchor="middle" fill="#4A90D9" fontSize="11" fontWeight="bold">i</text>
    </svg>
  );
}
function IcoExit() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <path d="M9 3H4a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h5" stroke="#E53E3E" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M15 15l4-4-4-4M19 11H9" stroke="#E53E3E" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
function IcoSaveSession() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <rect x="3" y="2" width="16" height="18" rx="2" fill="#DBEAFE" stroke="#4A90D9" strokeWidth="1.2"/>
      <rect x="6" y="2" width="7" height="6" rx="0.5" fill="#4A90D9" opacity="0.6"/>
      <path d="M6 14l3 3 5-5" stroke="#48BB78" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
function IcoLoadSession() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <rect x="3" y="2" width="16" height="18" rx="2" fill="#FEF3C7" stroke="#C8981E" strokeWidth="1.2"/>
      <rect x="6" y="2" width="7" height="6" rx="0.5" fill="#C8981E" opacity="0.6"/>
      <path d="M11 9v6M8 12l3 3 3-3" stroke="#C8981E" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function FileMenu({
  scanning, hasScan, scanPath,
  onScan, onCancel, onSaveSession, onLoadSession,
}: Pick<RibbonBarProps,
  | "scanning" | "hasScan" | "scanPath"
  | "onScan" | "onCancel" | "onSaveSession" | "onLoadSession"
>) {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<"main" | "export">("main");
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => { setOpen(false); setSection("main"); }, []);

  // Close when clicking outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, close]);

  const csvUrl = hasScan ? `/api/export.csv?path=${encodeURIComponent(scanPath)}` : "#";
  const jsonUrl = hasScan ? `/api/export.json?path=${encodeURIComponent(scanPath)}` : "#";

  const doExit = () => { close(); exitApp().catch(() => {}); };
  const doNewInstance = () => { close(); window.open(window.location.href, "_blank"); };

  // anchor position
  const getAnchorRect = () => ref.current?.getBoundingClientRect() ?? new DOMRect();

  return (
    <div ref={ref} className="file-menu-wrap">
      <button
        className={`file-menu-btn${open ? " file-menu-btn-open" : ""}`}
        onClick={() => { setOpen(o => !o); if (!open) setSection("main"); }}
      >
        File
      </button>

      {open && (() => {
        const rect = getAnchorRect();
        return (
          <div
            className="file-menu-panel"
            style={{ position: "fixed", top: rect.bottom, left: rect.left, zIndex: 9999 }}
          >
            {/* Left nav */}
            <div className="fm-nav">
              <button className="fm-item" onClick={() => { close(); onScan(); }} disabled={scanning}>
                <span className="fm-icon"><IcoSelectDir /></span>
                <span className="fm-text">Select Directory to scan</span>
              </button>
              <button className="fm-item" onClick={() => { close(); onScan(); }} disabled={scanning}>
                <span className="fm-icon"><IcoRefresh /></span>
                <span className="fm-text">Refresh</span>
              </button>
              <button className="fm-item" onClick={() => { close(); onCancel(); }} disabled={!scanning}>
                <span className="fm-icon"><IcoStop /></span>
                <span className="fm-text">Stop Scan</span>
              </button>
              <div className="fm-sep" />
              <button className="fm-item" onClick={doNewInstance}>
                <span className="fm-icon"><IcoNewWindow /></span>
                <span className="fm-text">New Instance</span>
              </button>
              <div className="fm-sep" />
              <button className="fm-item" onClick={() => { close(); onSaveSession(); }}>
                <span className="fm-icon"><IcoSaveSession /></span>
                <span className="fm-text">Save Session</span>
              </button>
              <button className="fm-item" onClick={() => { close(); onLoadSession(); }}>
                <span className="fm-icon"><IcoLoadSession /></span>
                <span className="fm-text">Load Session</span>
              </button>
              <div className="fm-sep" />
              <button
                className={`fm-item${section === "export" ? " fm-item-active" : ""}`}
                onMouseEnter={() => setSection("export")}
                onClick={() => setSection("export")}
                disabled={!hasScan}
              >
                <span className="fm-icon"><IcoExportFile /></span>
                <span className="fm-text">Export</span>
                <span className="fm-arrow">›</span>
              </button>
              <div className="fm-sep" />
              <button className="fm-item" onClick={() => { close(); alert(`FileTree\nA fast, standalone Windows disk-usage explorer.\nBuilt with Rust + React.`); }}>
                <span className="fm-icon"><IcoAbout /></span>
                <span className="fm-text">About</span>
              </button>
              <button className="fm-item fm-item-danger" onClick={doExit}>
                <span className="fm-icon"><IcoExit /></span>
                <span className="fm-text">Exit</span>
              </button>
            </div>

            {/* Right content panel */}
            {section === "export" && (
              <div className="fm-content">
                <div className="fm-content-section">File</div>
                <a
                  className={`fm-content-item${!hasScan ? " fm-content-item-disabled" : ""}`}
                  href={csvUrl}
                  download
                  onClick={hasScan ? close : (e) => e.preventDefault()}
                >
                  <span className="fm-content-icon">
                    <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                      <rect x="4" y="2" width="18" height="24" rx="2" fill="#E2F5E2" stroke="#48BB78" strokeWidth="1.2"/>
                      <path d="M20 2l6 6h-6V2z" fill="#9AE6B4"/>
                      <text x="7" y="22" fill="#276749" fontSize="8" fontWeight="bold">CSV</text>
                    </svg>
                  </span>
                  <span className="fm-content-label">
                    <span className="fm-content-title">CSV File</span>
                    <span className="fm-content-desc">Export directory tree to a CSV spreadsheet</span>
                  </span>
                </a>
                <a
                  className={`fm-content-item${!hasScan ? " fm-content-item-disabled" : ""}`}
                  href={jsonUrl}
                  download
                  onClick={hasScan ? close : (e) => e.preventDefault()}
                >
                  <span className="fm-content-icon">
                    <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                      <rect x="4" y="2" width="18" height="24" rx="2" fill="#DBEAFE" stroke="#4A90D9" strokeWidth="1.2"/>
                      <path d="M20 2l6 6h-6V2z" fill="#93C5FD"/>
                      <text x="5" y="22" fill="#1e40af" fontSize="7" fontWeight="bold">JSON</text>
                    </svg>
                  </span>
                  <span className="fm-content-label">
                    <span className="fm-content-title">JSON File</span>
                    <span className="fm-content-desc">Export directory tree as a JSON document</span>
                  </span>
                </a>
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

export function RibbonBar(props: RibbonBarProps) {
  const ribbonTab = props.activeRibbonTab as RibbonTab;

  const TABS: { id: RibbonTab; label: string }[] = [
    { id: "home",         label: "Home" },
    { id: "scan",         label: "Scan" },
    { id: "view",         label: "View" },
    { id: "duplicates",   label: "Duplicates" },
    { id: "treemapChart", label: "Treemap Chart" },
    { id: "options",      label: "Options" },
  ];

  return (
    <div className="ribbon-bar">
      {/* Tab nav row */}
      <div className="ribbon-tab-nav">
        <FileMenu
          scanning={props.scanning}
          hasScan={props.hasScan}
          scanPath={props.scanPath}
          onScan={props.onScan}
          onCancel={props.onCancel}
          onSaveSession={props.onSaveSession}
          onLoadSession={props.onLoadSession}
        />
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`ribbon-tab-btn${ribbonTab === t.id ? " active" : ""}`}
            onClick={() => props.onRibbonTabChange(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Ribbon content */}
      <div className="ribbon-content">
        {ribbonTab === "home" && (
          <HomeRibbon
            drives={props.drives}
            specialFolders={props.specialFolders}
            scanning={props.scanning}

            metric={props.metric}
            unit={props.unit}
            includeHidden={props.includeHidden}
            followLinks={props.followLinks}
            showFiles={props.showFiles}
            onScan={props.onScan}
            onCancel={props.onCancel}
            onScanPath={props.onScanPath}
            onExpand={props.onExpand}
            onNewFolder={props.onNewFolder}
            bookmarks={props.bookmarks}
            onMetricChange={props.onMetricChange}
            onUnitChange={props.onUnitChange}
            onHiddenChange={props.onHiddenChange}
            onFollowLinksChange={props.onFollowLinksChange}
            onShowFilesChange={props.onShowFilesChange}
          />
        )}
        {ribbonTab === "scan" && (
          <ScanRibbon
            drives={props.drives}
            specialFolders={props.specialFolders}
            scanning={props.scanning}

            filter={props.filter}
            exclude={props.exclude}
            includeHidden={props.includeHidden}
            followLinks={props.followLinks}
            threads={props.threads}
            filterActive={props.filterActive}
            onScan={props.onScan}
            onCancel={props.onCancel}
            onScanPath={props.onScanPath}
            onExpand={props.onExpand}
            bookmarks={props.bookmarks}
            onFilterChange={props.onFilterChange}
            onExcludeChange={props.onExcludeChange}
            onHiddenChange={props.onHiddenChange}
            onFollowLinksChange={props.onFollowLinksChange}
            onThreadsChange={props.onThreadsChange}
            onNavigateParent={props.onNavigateParent}
            onOpenFilter={props.onOpenFilter}
            onExport={props.onExport}
            onOpenLocation={props.onOpenLocation}
            onCopyFiles={props.onCopyFiles}
            hasScan={props.hasScan}
          />
        )}
        {ribbonTab === "view" && (
          <ViewRibbon
            metric={props.metric}
            unit={props.unit}
            onMetricChange={props.onMetricChange}
            onUnitChange={props.onUnitChange}
            activeTab={props.activeTab}
            onShowDetails={props.onShowDetails}
            onShowTreemap={props.onShowTreemap}
            decimals={props.decimals}
            visibleColumns={props.visibleColumns}
            sortKey={props.sortKey}
            sortDir={props.sortDir}
            onDecimalsChange={props.onDecimalsChange}
            onVisibleColumnsChange={props.onVisibleColumnsChange}
            onSortChange={props.onSortChange}
          />
        )}
        {ribbonTab === "duplicates" && (
          <DuplicatesRibbon
            scanning={props.scanning}
            hasScan={props.hasScan}
          />
        )}
        {ribbonTab === "treemapChart" && (
          <TreemapChartRibbon
            treemapPosition={props.treemapPosition}
            treemapDetail={props.treemapDetail}
            onTreemapPositionChange={props.onTreemapPositionChange}
            onTreemapDetailChange={props.onTreemapDetailChange}
            tmShowSingleFiles={props.tmShowSingleFiles}
            tmShow3D={props.tmShow3D}
            tmShowHierarchy={props.tmShowHierarchy}
            tmShowLegend={props.tmShowLegend}
            tmShowLabels={props.tmShowLabels}
            tmDragDrop={props.tmDragDrop}
            onTmShowSingleFilesChange={props.onTmShowSingleFilesChange}
            onTmShow3DChange={props.onTmShow3DChange}
            onTmShowHierarchyChange={props.onTmShowHierarchyChange}
            onTmShowLegendChange={props.onTmShowLegendChange}
            onTmShowLabelsChange={props.onTmShowLabelsChange}
            onTmDragDropChange={props.onTmDragDropChange}
          />
        )}
        {ribbonTab === "options" && (
          <OptionsRibbon
            darkMode={props.darkMode}
            onDarkModeChange={props.onDarkModeChange}
          />
        )}
      </div>

      {/* Address bar */}
      <div className="ribbon-address">
        <button className="addr-nav-btn" title="Parent folder" onClick={props.onNavigateParent}>↑</button>
        <input
          className="addr-input"
          type="text"
          value={props.scanPath}
          onChange={(e) => props.onPathChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !props.scanning && props.onScan()}
          placeholder="Path to scan…"
          spellCheck={false}
        />
        <button
          className="addr-scan-btn"
          onClick={props.scanning ? props.onCancel : props.onScan}
          disabled={!props.scanPath.trim()}
        >
          {props.scanning ? "Cancel" : "Scan"}
        </button>
      </div>
    </div>
  );
}
