// Throwaway visual harness for the side bar. Renders every side-bar body with
// mock data in both themes so the layout can be screenshotted. Not shipped:
// delete this file and sidebar-preview.html when the design pass is done.
import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { DriveEntry, NodeRecord, ScanResult, SmartFolder, SpecialFolder, TagEntry } from "../api/types";
import { ActivityBar, type ViewId } from "../components/ActivityBar";
import { SideBar, type SideBarProps } from "../components/SideBar";
import type { DuplicatesController } from "../hooks/useDuplicates";
import { EMPTY_FILTERS } from "../lib/search";
import "../styles/global.css";

function node(id: number, name: string, depth: number, size: number, children: number[] = [], parent: number | null = null): NodeRecord {
  return {
    id, parent, name, path: `C:\\Projects\\${name}`, dir: true, link: false, hidden: false,
    readonly: false, size, allocated: size, files: 12, folders: children.length,
    modified: Date.now(), created: Date.now(), accessed: Date.now(), depth, errors: 0,
    extension: "", children,
  };
}

const rows: NodeRecord[] = [
  node(0, "Projects", 0, 184_000_000_000, [1, 6, 7, 8]),
  node(1, "filetree", 1, 92_400_000_000, [2, 3, 4, 5], 0),
  node(2, "node_modules", 2, 71_200_000_000, [], 1),
  node(3, "src-tauri", 2, 14_800_000_000, [], 1),
  node(4, "frontend", 2, 5_100_000_000, [], 1),
  node(5, "target", 2, 1_300_000_000, [], 1),
  node(6, "archived-builds", 1, 48_100_000_000, [], 0),
  node(7, "datasets", 1, 31_700_000_000, [], 0),
  node(8, "scratch", 1, 11_800_000_000, [], 0),
];
const nodeById = new Map(rows.map((r) => [r.id, r]));

const drives: DriveEntry[] = [
  { root: "C:\\", label: "Windows", total: 1_020_000_000_000, free: 214_000_000_000 },
  { root: "D:\\", label: "Data", total: 4_000_000_000_000, free: 1_870_000_000_000 },
  { root: "E:\\", label: "Backup", total: 2_000_000_000_000, free: 61_000_000_000 },
];
const specialFolders: SpecialFolder[] = [
  { label: "Desktop", path: "C:\\Users\\alex\\Desktop" },
  { label: "Documents", path: "C:\\Users\\alex\\Documents" },
  { label: "Downloads", path: "C:\\Users\\alex\\Downloads" },
  { label: "Pictures", path: "C:\\Users\\alex\\Pictures" },
];
const tagEntries: TagEntry[] = [
  { path: "C:\\Projects\\filetree", tags: ["active"], color: "#4ca6f0" },
  { path: "C:\\Projects\\datasets", tags: ["archive", "big"], color: "#e5c07b" },
];
const smartFolders: SmartFolder[] = [
  { id: "1", name: "Big videos", query: { text: "*.mkv" } },
  { id: "2", name: "Stale downloads", query: { text: "", rules: [] } },
];
const data: ScanResult = {
  app: "filetree", version: "0", rootPath: "C:\\Projects", scannedAt: Date.now(), elapsedMs: 4200,
  threadCount: 8, nodeCount: 412_004, errorCount: 3, nodes: rows, topFiles: [], largestDirs: [],
  extensionStats: [], ageStats: [], duplicateCandidates: [], scanErrors: [],
};

const noop = () => {};

// Only the members the side-bar card reads; the rest of the controller is
// exercised by the main-area Duplicates view.
const dupes = {
  selectedPaths: ["C:\\", "D:\\", "C:\\Users\\alex\\Pictures"],
  scanState: "idle",
  phase: "idle",
  progress: { scanned: 0, hashing: 0, hashed: 0 },
  groups: [],
  canScan: true,
  actionPending: false,
  startScan: noop,
  stopScan: noop,
} as unknown as DuplicatesController;

const scanningDupes = {
  ...dupes,
  scanState: "scanning",
  phase: "hashing",
  progress: { scanned: 412_004, hashing: 8_120, hashed: 3_402, stage: "hashing" },
} as unknown as DuplicatesController;

function props(view: ViewId): SideBarProps {
  return {
    view, data, nodeById, unit: "auto",
    searchQuery: "", onSearchQueryChange: noop, searchFilters: EMPTY_FILTERS,
    onSearchFiltersChange: noop, getOpenScans: () => [],
    searchHistory: [], onClearSearchHistory: noop, onSelectAllSearchResults: noop, onNavigate: noop,
    scanPath: "C:\\Projects", scanning: false, onScanPathInput: noop, onScan: noop, onCancel: noop,
    onRefresh: noop, onUp: noop, onNewFolder: noop, onCollapseAll: noop,
    drives, specialFolders, bookmarkList: ["C:\\Users\\alex\\Documents\\Reports"], onOpenLocation: noop,
    treeRows: rows, expanded: new Set([0, 1]), expandedAll: false, collapsedOverrides: new Set(),
    selectedId: 1, onToggleExpand: noop, onSelectFolder: noop,
    selectedNode: rows[1], onOpen: noop, onReveal: noop, onCopyPath: noop,
    onScanPath: noop, onRemoveBookmark: noop,
    tagEntries, activeTagFilter: null, onSelectTag: noop,
    smartFolders, onApplySmartFolder: noop, onSaveSmartFolder: noop, onDeleteSmartFolder: noop,
    dupes,
    excludePatterns: ["node_modules", "*.tmp"], onRemoveExclude: noop, onClearExcludes: noop,
  };
}

const PANELS: { view: ViewId; label: string; override?: Partial<SideBarProps> }[] = [
  { view: "explorer", label: "Home / Explorer" },
  { view: "compress", label: "Compress" },
  { view: "duplicates", label: "Duplicates" },
  { view: "duplicates", label: "Duplicates (scanning)", override: { dupes: scanningDupes } },
  { view: "explorer", label: "Explorer (no scan)", override: { data: null, treeRows: [], scanPath: "" } },
];

function Panel({ view, label, override }: { view: ViewId; label: string; override?: Partial<SideBarProps> }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ font: "600 10px ui-sans-serif", letterSpacing: ".08em", padding: "4px 6px", opacity: 0.5, textTransform: "uppercase" }}>
        {label}
      </div>
      <div className="sidebar" style={{ width: 268, flex: "1 1 0", minHeight: 0 }}>
        <ActivityBar
          activeView={view} sidebarOpen onSelect={noop}
          bookmarkCount={1} errorCount={3} darkMode={false} onToggleTheme={noop}
        />
        <SideBar {...props(view)} {...override} />
      </div>
    </div>
  );
}

function Board({ theme }: { theme: "light" | "dark" }) {
  return (
    <div
      data-theme={theme}
      style={{
        display: "flex", gap: 10, padding: 10, height: 760, boxSizing: "border-box",
        background: "var(--bg)", color: "var(--text)",
      }}
    >
      {PANELS.map((panel) => (
        <Panel key={panel.label} view={panel.view} label={panel.label} override={panel.override} />
      ))}
    </div>
  );
}

// `?menu` renders a single panel per theme with the target picker already open,
// so the dropdown itself can be screenshotted (it portals to <body>).
function OpenPickerBoard({ theme }: { theme: "light" | "dark" }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The popup portals to <body>; the app themes <html>, so match that here or
    // the menu screenshots in the wrong palette.
    document.documentElement.dataset.theme = theme;
    document.body.style.background = "var(--bg)";
    hostRef.current?.querySelector<HTMLButtonElement>(".sb-picker")?.click();
  }, [theme]);
  return (
    <div
      ref={hostRef}
      data-theme={theme}
      style={{
        display: "flex", padding: 10, height: 560, width: 300, boxSizing: "border-box",
        background: "var(--bg)", color: "var(--text)",
      }}
    >
      <Panel view="explorer" label={`picker — ${theme}`} />
    </div>
  );
}

const showMenu = window.location.search.includes("menu");

createRoot(document.getElementById("root")!).render(
  <div style={{ font: "13px ui-sans-serif" }}>
    {showMenu ? (
      <OpenPickerBoard theme="dark" />
    ) : (
      <>
        <Board theme="light" />
        <Board theme="dark" />
      </>
    )}
  </div>,
);
