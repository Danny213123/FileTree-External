import { useState, useEffect, useCallback, useRef, createRef, Fragment } from "react";
import {
  fetchConfig,
  fetchDrives,
  fetchSpecialFolders,
  fetchBookmarks,
  saveBookmarks,
  fetchSettings,
  saveSettings,
} from "./api/client";
import type { AppSettings } from "./api/client";
import type { DriveEntry, SpecialFolder, SortKey, Unit, ScanResult } from "./api/types";
import { useDuplicatesController } from "./hooks/useDuplicates";
import { DuplicatesResults } from "./components/DuplicatesResults";
import { DEFAULT_VISIBLE_COLUMNS } from "./components/TreeTable";
import { pushRecent, loadRecentPaths, setRecentPaths } from "./components/RibbonBar";
import { StatusBar } from "./components/StatusBar";
import type { WorkspaceTab as WorkspaceTabMeta } from "./components/TabBar";
import { TabBar } from "./components/TabBar";
import { WorkspaceTab } from "./components/WorkspaceTab";
import type { WorkspaceTabHandle, SidebarModel } from "./components/WorkspaceTab";
import { TitleBar, type Menu, type MenuItem } from "./components/TitleBar";
import { loadChatIndex, newChatSessionId } from "./lib/chatSessions";
import { undoLast } from "./lib/undo";
import { ActivityBar, type ViewId } from "./components/ActivityBar";
import { SideBar } from "./components/SideBar";
import { ReportsView } from "./components/ReportsView";
import { InspectorPane } from "./components/InspectorPane";
import { ChatPanel } from "./components/ChatPanel";
import { TerminalPanel } from "./components/TerminalPanel";
import { ScheduleWizard } from "./components/ScheduleWizard";

const SETTINGS_DEBOUNCE_MS = 700;

let nextTabId = 1;
function newTabId() { return String(nextTabId++); }
let nextGroupId = 1;
function newGroupId() { return `g${nextGroupId++}`; }

interface TabEntry {
  id: string;
  initialPath: string;
  ref: React.RefObject<WorkspaceTabHandle>;
}

// An editor group is one column in the split layout: an ordered list of open
// tabs, the active (visible) one, and an optional explicit width in px (the
// last group always flexes to fill remaining space).
interface EditorGroup {
  id: string;
  tabIds: string[];
  activeTabId: string;
  width?: number;
  // Hide this pane's controls toolbar row (the Size/Unit/Files… row under the
  // tabs). Per-editor-group, toggled from the tab bar; defaults to shown.
  toolbarHidden?: boolean;
}

const MAX_GROUPS = 4;
// Floor a single split pane can shrink to. Kept modest so two panes comfortably
// coexist inside the editor area (between the side bar and the chat panel) on a
// typical window; wider/maximized windows fit 3–4.
const MIN_GROUP_WIDTH = 180;
const DEFAULT_GROUP_WIDTH = 520;

// Side-bar resize bounds (was previously inside WorkspaceTab).
const MIN_SIDEBAR_WIDTH = 170;
const MAX_SIDEBAR_WIDTH = 640;

// Fallback model for the shared Explorer side bar before the focused pane's
// handle has mounted. SideBar renders fine on this (no scan ⇒ no FOLDERS list).
const NOOP = () => {};
const EMPTY_SIDEBAR_MODEL: SidebarModel = {
  data: null,
  nodeById: new Map(),
  unit: "auto",
  scanPath: "",
  scanning: false,
  treeRows: [],
  expanded: new Set(),
  selectedId: 0,
  selectedNode: undefined,
  errorCount: 0,
  onNavigate: NOOP,
  onScanPathInput: NOOP,
  onScan: NOOP,
  onCancel: NOOP,
  onRefresh: NOOP,
  onUp: NOOP,
  onNewFolder: NOOP,
  onCollapseAll: NOOP,
  onOpenLocation: NOOP,
  onToggleExpand: NOOP,
  onSelectFolder: NOOP,
  onOpen: NOOP,
  onReveal: NOOP,
  onCopyPath: NOOP,
  onScanPath: NOOP,
};

export default function App() {
  const [threads, setThreads] = useState(8);
  const [exclude, setExclude] = useState("");
  const [includeHidden, setIncludeHidden] = useState(false);
  const [followLinks, setFollowLinks] = useState(false);
  // Opt-in: resolve each node's Windows owner during scans. OFF by default
  // because per-file owner lookups slow large scans (see crate::owner cache).
  const [collectOwners, setCollectOwners] = useState(false);
  const [drives, setDrives] = useState<DriveEntry[]>([]);
  const [bookmarkList, setBookmarkList] = useState<string[]>([]);
  const [specialFolders, setSpecialFolders] = useState<SpecialFolder[]>([]);
  const [darkMode, setDarkModeState] = useState(true);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [treemapDetail] = useState(3);
  const [tmShowSingleFiles] = useState(true);
  const [tmShow3D, setTmShow3D] = useState(false);
  const [tmShowHierarchy, setTmShowHierarchy] = useState(true);
  const [tmShowLegend, setTmShowLegend] = useState(true);
  const [tmShowLabels, setTmShowLabels] = useState(true);
  const [tmDragDrop] = useState(false);
  // Details-list view prefs are GLOBAL (shared by every tab/pane) and persisted
  // server-side like metric/unit. `unit` stays per-tab (in useTreeState).
  const [decimals, setDecimals] = useState(2);
  const [visibleColumns, setVisibleColumns] = useState<Set<SortKey>>(DEFAULT_VISIBLE_COLUMNS);

  // VS Code workbench layout
  const [activeView, setActiveView] = useState<ViewId>("explorer");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelHeight, setPanelHeight] = useState(320);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatWidth, setChatWidth] = useState(360);
  const [chatSessionId, setChatSessionId] = useState<string>(() => newChatSessionId());
  // Right-side inspector: Preview and Details panes (independently toggleable).
  const [previewOpen, setPreviewOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [inspectorWidth, setInspectorWidth] = useState(320);
  // Scheduled-scan wizard (#10) — a modal over the workbench.
  const [scheduleOpen, setScheduleOpen] = useState(false);

  // Integrated terminal (global bottom panel). Mounted lazily on first open and
  // kept mounted thereafter so sessions survive hiding the panel.
  const [terminalMounted, setTerminalMounted] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(260);
  const [terminalCwd, setTerminalCwd] = useState("");
  const [terminalReq, setTerminalReq] = useState(0);
  const terminalOpenRef = useRef(false);
  useEffect(() => { terminalOpenRef.current = terminalOpen; }, [terminalOpen]);

  // Flat registry of every open tab (id → path + imperative ref). Group order
  // and per-pane active tab live in `groups`; this stays the single home for
  // the WorkspaceTab refs so getActiveRef/status/chat keep working unchanged.
  const [tabs, setTabs] = useState<TabEntry[]>(() => [{ id: newTabId(), initialPath: "", ref: createRef<WorkspaceTabHandle>() }]);
  const [groups, setGroups] = useState<EditorGroup[]>(() => [{ id: newGroupId(), tabIds: [tabs[0].id], activeTabId: tabs[0].id }]);
  const [focusedGroupId, setFocusedGroupId] = useState<string>(() => groups[0].id);

  // Live mirrors so the (stable) tab/group event handlers below can read current
  // state without being re-created on every tab/group/focus change.
  const tabsRef = useRef(tabs);
  const groupsRef = useRef(groups);
  const focusedGroupIdRef = useRef(focusedGroupId);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  useEffect(() => { groupsRef.current = groups; }, [groups]);
  useEffect(() => { focusedGroupIdRef.current = focusedGroupId; }, [focusedGroupId]);

  // Re-render trigger when the active tab's state changes (status bar / labels).
  // Throttled (leading + trailing, ~120ms): scan-progress storms from every tab
  // would otherwise fire ~30x/sec each and re-render App constantly. The leading
  // edge keeps single user actions instant; the guaranteed trailing call lets
  // end-of-scan counts settle.
  const [, setTick] = useState(0);
  const notifyLastRef = useRef(0);
  const notifyTimerRef = useRef<number | null>(null);
  const notifyState = useCallback(() => {
    const now = Date.now();
    const elapsed = now - notifyLastRef.current;
    if (elapsed >= 120) {
      notifyLastRef.current = now;
      setTick((n) => n + 1);
    } else if (notifyTimerRef.current === null) {
      notifyTimerRef.current = window.setTimeout(() => {
        notifyTimerRef.current = null;
        notifyLastRef.current = Date.now();
        setTick((n) => n + 1);
      }, 120 - elapsed);
    }
  }, []);

  // The "active tab" is the active tab of the FOCUSED group, so the status bar,
  // chat, title-bar menus and keybindings all follow the pane the user last
  // clicked into.
  const getActiveRef = useCallback((): WorkspaceTabHandle | null => {
    const group = groups.find((g) => g.id === focusedGroupId) ?? groups[0];
    const tab = group ? tabs.find((t) => t.id === group.activeTabId) : undefined;
    return tab?.ref.current ?? null;
  }, [tabs, groups, focusedGroupId]);

  // Every open tab's in-memory scan — the Duplicates page aggregates these (plus
  // the client scanCache) before walking any uncached target, so already-scanned
  // roots cost nothing. Stable identity (reads the live tabsRef mirror).
  const getScanResults = useCallback((): ScanResult[] => {
    return tabsRef.current
      .map((t) => t.ref.current?.getData() ?? null)
      .filter((r): r is ScanResult => !!r);
  }, []);

  const dupes = useDuplicatesController({ getScanResults, threads, defaultIncludeHidden: includeHidden });

  // Ctrl+` toggle: open the terminal at the active tab's root, or hide it.
  const handleToggleTerminal = useCallback(() => {
    if (terminalOpenRef.current) { setTerminalOpen(false); return; }
    const cwd = getActiveRef()?.getScanPath() || "";
    setTerminalCwd(cwd);
    setTerminalMounted(true);
    setTerminalOpen(true);
    setTerminalReq((n) => n + 1);
  }, [getActiveRef]);

  // ── Consolidated settings persistence (server overwrites the whole file) ──
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const buildSettings = useCallback((): AppSettings => {
    const rs = getActiveRef()?.getRibbonState();
    return {
      darkMode, threads, includeHidden, followLinks, collectOwners, exclude,
      lastPath: rs?.scanPath ?? "",
      metric: rs?.metric ?? "size",
      unit: rs?.unit ?? "auto",
      showFiles: rs?.showFiles ?? true,
      recentPaths: loadRecentPaths(),
      openTabs: tabs.map((t) => t.ref.current?.getScanPath() ?? t.initialPath),
      visibleColumns: Array.from(visibleColumns),
      decimals,
      // Split-pane layout as indices into openTabs (best-effort; load falls back
      // to a single group when absent or malformed).
      paneGroups: groups.map((g) => ({
        tabs: g.tabIds.map((id) => tabs.findIndex((t) => t.id === id)).filter((i) => i >= 0),
        active: Math.max(0, tabs.findIndex((t) => t.id === g.activeTabId)),
        width: g.width,
        toolbarHidden: g.toolbarHidden,
      })),
      activeView, sidebarOpen, sidebarWidth, panelOpen, panelHeight, chatOpen, chatWidth,
      previewOpen, detailsOpen, inspectorWidth,
    };
  }, [darkMode, threads, includeHidden, followLinks, collectOwners, exclude, getActiveRef, tabs, groups,
      visibleColumns, decimals,
      activeView, sidebarOpen, sidebarWidth, panelOpen, panelHeight, chatOpen, chatWidth,
      previewOpen, detailsOpen, inspectorWidth]);

  const persist = useCallback(() => {
    if (!settingsLoaded) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { saveSettings(buildSettings()).catch(() => {}); }, SETTINGS_DEBOUNCE_MS);
  }, [settingsLoaded, buildSettings]);

  useEffect(() => { persist(); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [darkMode, threads, includeHidden, followLinks, collectOwners, exclude, tabs, groups, focusedGroupId,
     visibleColumns, decimals,
     activeView, sidebarOpen, sidebarWidth, panelOpen, panelHeight, chatOpen, chatWidth,
     previewOpen, detailsOpen, inspectorWidth]);

  const handleSaveSession = useCallback(() => {
    const paths = tabs.map((t) => t.ref.current?.getScanPath() ?? t.initialPath).filter(Boolean);
    const json = JSON.stringify({ version: 1, tabs: paths }, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "filetree-session.ftt";
    a.click();
    URL.revokeObjectURL(url);
  }, [tabs]);

  const handleLoadSession = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".ftt,.json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = JSON.parse(e.target?.result as string) as { tabs?: string[] };
          const paths = (data.tabs ?? []).filter(Boolean);
          if (paths.length === 0) return;
          const restored = paths.map((p) => ({ id: newTabId(), initialPath: p, ref: createRef<WorkspaceTabHandle>() }));
          // Sessions are a flat tab list — restore them into a single pane.
          const gid = newGroupId();
          setTabs(restored);
          setGroups([{ id: gid, tabIds: restored.map((t) => t.id), activeTabId: restored[0].id }]);
          setFocusedGroupId(gid);
        } catch { /* malformed */ }
      };
      reader.readAsText(file);
    };
    input.click();
  }, []);

  const handleToggleDark = useCallback(() => {
    setDarkModeState((v) => {
      const next = !v;
      document.documentElement.dataset.theme = next ? "dark" : "light";
      return next;
    });
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? "dark" : "light";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load settings + config + drives on mount
  useEffect(() => {
    Promise.all([
      fetchConfig(),
      fetchDrives(),
      fetchSpecialFolders(),
      fetchBookmarks(),
      fetchSettings(),
    ]).then(([config, driveList, folderList, savedBookmarks, settings]) => {
      if (settings.darkMode !== undefined) {
        setDarkModeState(settings.darkMode);
        document.documentElement.dataset.theme = settings.darkMode ? "dark" : "light";
      }
      if (settings.threads !== undefined) setThreads(settings.threads);
      if (settings.includeHidden !== undefined) setIncludeHidden(settings.includeHidden);
      if (settings.followLinks !== undefined) setFollowLinks(settings.followLinks);
      if (settings.collectOwners !== undefined) setCollectOwners(settings.collectOwners);
      if (settings.exclude !== undefined) setExclude(settings.exclude);
      if (settings.recentPaths?.length) setRecentPaths(settings.recentPaths);
      // Details-list prefs (global). Name is always kept on.
      if (settings.visibleColumns?.length) {
        setVisibleColumns(new Set<SortKey>([...(settings.visibleColumns as SortKey[]), "name"]));
      }
      if (settings.decimals !== undefined) setDecimals(settings.decimals);
      // Layout
      if (settings.activeView && ["explorer", "search", "treemap", "reports", "duplicates", "bookmarks", "errors"].includes(settings.activeView)) {
        setActiveView(settings.activeView as ViewId);
      }
      if (settings.sidebarOpen !== undefined) setSidebarOpen(settings.sidebarOpen);
      if (settings.sidebarWidth) setSidebarWidth(settings.sidebarWidth);
      if (settings.panelOpen !== undefined) setPanelOpen(settings.panelOpen);
      if (settings.panelHeight) setPanelHeight(settings.panelHeight);
      if (settings.chatOpen !== undefined) setChatOpen(settings.chatOpen);
      if (settings.chatWidth) setChatWidth(settings.chatWidth);
      if (settings.previewOpen !== undefined) setPreviewOpen(settings.previewOpen);
      if (settings.detailsOpen !== undefined) setDetailsOpen(settings.detailsOpen);
      if (settings.inspectorWidth) setInspectorWidth(settings.inspectorWidth);

      setDrives(driveList.drives ?? []);
      setSpecialFolders(folderList.folders ?? []);
      setBookmarkList(savedBookmarks);

      const savedPaths = settings.openTabs?.filter(Boolean);
      if (savedPaths && savedPaths.length > 0) {
        const restoredTabs = savedPaths.map((p) => ({ id: newTabId(), initialPath: p, ref: createRef<WorkspaceTabHandle>() }));
        setTabs(restoredTabs);

        // Rebuild the split layout from paneGroups (indices into openTabs).
        // Anything malformed or missing collapses to a single pane.
        let built: EditorGroup[] = [];
        const pg = settings.paneGroups;
        if (pg && pg.length > 0) {
          const used = new Set<number>();
          for (const g of pg.slice(0, MAX_GROUPS)) {
            const ids = (g.tabs ?? [])
              .filter((i) => i >= 0 && i < restoredTabs.length && !used.has(i))
              .map((i) => { used.add(i); return restoredTabs[i].id; });
            if (ids.length === 0) continue;
            const activeId = (g.active >= 0 && g.active < restoredTabs.length && ids.includes(restoredTabs[g.active].id))
              ? restoredTabs[g.active].id : ids[0];
            built.push({ id: newGroupId(), tabIds: ids, activeTabId: activeId, width: g.width, toolbarHidden: g.toolbarHidden });
          }
          const leftover = restoredTabs.filter((_, i) => !used.has(i)).map((t) => t.id);
          if (leftover.length > 0) {
            if (built.length > 0) built[0].tabIds.push(...leftover);
            else built.push({ id: newGroupId(), tabIds: leftover, activeTabId: leftover[0] });
          }
        }
        if (built.length === 0) {
          built = [{ id: newGroupId(), tabIds: restoredTabs.map((t) => t.id), activeTabId: restoredTabs[0].id }];
        }
        built[built.length - 1].width = undefined; // last pane always flexes
        setGroups(built);
        setFocusedGroupId(built[0].id);
      } else {
        const path = settings.lastPath || config.initialPath || "";
        if (path) {
          setTabs((prev) => {
            const first = prev[0];
            return [{ ...first, initialPath: path }, ...prev.slice(1)];
          });
        }
      }
      setSettingsLoaded(true);
    }).catch(() => { setSettingsLoaded(true); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleToggleBookmark = useCallback((path: string) => {
    setBookmarkList((prev) => {
      const next = prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path];
      saveBookmarks(next).catch(() => {});
      return next;
    });
  }, []);

  // Open a new tab inside a specific group (before `beforeId`, else appended),
  // make it that group's active tab, and focus the group.
  const openTabInGroup = useCallback((groupId: string, path: string, beforeId?: string) => {
    const id = newTabId();
    const ref = createRef<WorkspaceTabHandle>();
    setTabs((prev) => [...prev, { id, initialPath: path, ref }]);
    setGroups((prev) => {
      if (prev.length === 0) return prev;
      const targetId = prev.some((g) => g.id === groupId) ? groupId : prev[0].id;
      return prev.map((g) => {
        if (g.id !== targetId) return g;
        const tabIds = [...g.tabIds];
        const at = beforeId ? tabIds.indexOf(beforeId) : -1;
        if (at >= 0) tabIds.splice(at, 0, id); else tabIds.push(id);
        return { ...g, tabIds, activeTabId: id };
      });
    });
    setFocusedGroupId((cur) => (groupsRef.current.some((g) => g.id === groupId) ? groupId : cur));
  }, []);

  // New tabs from global actions (Ctrl+T, external file drop, File ▸ New Tab)
  // land in the currently focused pane.
  const handleOpenInNewTab = useCallback((path: string) => {
    openTabInGroup(focusedGroupIdRef.current, path);
  }, [openTabInGroup]);

  // Open a folder in a new tab of a SPECIFIC group (used when a native folder
  // drag is dropped on that group's tab strip — see TreeTable). Falls back to
  // the focused group when no/unknown group id is supplied. Stable identity so
  // it doesn't defeat WorkspaceTab's memoization.
  const handleOpenFolderInTab = useCallback((path: string, groupId?: string) => {
    const target = groupId && groupsRef.current.some((g) => g.id === groupId)
      ? groupId
      : focusedGroupIdRef.current;
    openTabInGroup(target, path);
  }, [openTabInGroup]);

  const handleActivateTab = useCallback((groupId: string, tabId: string) => {
    setGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, activeTabId: tabId } : g)));
    setFocusedGroupId(groupId);
  }, []);

  useEffect(() => {
    type ElectronAPI = {
      onExternalDrop?: (cb: (paths: string[]) => void) => void;
      getPathForFile?: (file: File) => string;
    };
    const eAPI = (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
    if (eAPI?.onExternalDrop) {
      eAPI.onExternalDrop((paths) => paths.forEach((p) => handleOpenInNewTab(p)));
    }
    const pathForFile = (file: File) => {
      try {
        return eAPI?.getPathForFile?.(file) || (file as unknown as { path?: string }).path || "";
      } catch {
        return (file as unknown as { path?: string }).path || "";
      }
    };
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      if (!Array.from(e.dataTransfer.types).includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      const paths = Array.from(e.dataTransfer.files).map(pathForFile).filter(Boolean);
      if (paths.length === 0) return;
      // Explorer drag-in (#9): if dropped onto a folder row, move/copy INTO it
      // (Explorer-like) through the guarded engine; the row exposes its path +
      // dir flag (see TreeTable). Dropping on empty/background opens new tabs.
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const folderRow = el?.closest<HTMLElement>('.row[data-node-dir="1"]');
      const destFolder = folderRow?.dataset.nodePath;
      if (destFolder) {
        void getActiveRef()?.dropExternalInto(paths, destFolder);
        return;
      }
      paths.forEach((p) => handleOpenInNewTab(p));
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [handleOpenInNewTab, getActiveRef]);

  useEffect(() => {
    type ElectronAPI = {
      onContextMenuAction?: (cb: (action: string, path: string) => void) => void | (() => void);
    };
    const eAPI = (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
    const cleanup = eAPI?.onContextMenuAction?.((action, message) => {
      if (action === "rename") getActiveRef()?.doRenamePath(message);
      else if (action === "delete") getActiveRef()?.doDeletePaths([message]);
      else if (action === "refresh") getActiveRef()?.doScan();
      else if (action === "error") window.alert(message);
    });
    return typeof cleanup === "function" ? cleanup : undefined;
  }, [getActiveRef]);

  // Phase 6 in-app undo: reverse the most recent reversible file op (move back,
  // rename back, restore from the Recycle Bin) and toast the outcome in the
  // active pane. The fs change then refreshes the tree (we also force a rescan).
  const handleUndo = useCallback(async () => {
    const active = getActiveRef();
    const res = await undoLast();
    if (!res) { active?.showNotice("Nothing to undo."); return; }
    active?.showNotice(res.message);
    if (res.ok) active?.refresh();
  }, [getActiveRef]);

  // ── VS Code keybindings ──
  useEffect(() => {
    // Ctrl+Z must never hijack text-editing undo: bail when focus is in an
    // input/textarea/select or any contentEditable (rename box, chat composer,
    // path bar, terminal) — those get the browser's native edit undo instead.
    const inEditable = (el: EventTarget | null): boolean => {
      const node = el as HTMLElement | null;
      if (!node || typeof node.tagName !== "string") return false;
      const tag = node.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node.isContentEditable === true;
    };
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (e.ctrlKey && e.altKey && k === "b") { e.preventDefault(); setChatOpen((v) => !v); }
      else if (e.ctrlKey && !e.altKey && !e.shiftKey && k === "b") { e.preventDefault(); setSidebarOpen((v) => !v); }
      else if (e.ctrlKey && k === "j") { e.preventDefault(); setPanelOpen((v) => !v); }
      else if (e.ctrlKey && k === "t") { e.preventDefault(); handleOpenInNewTab(""); }
      else if (e.ctrlKey && (k === "`" || e.code === "Backquote")) { e.preventDefault(); handleToggleTerminal(); }
      // Per-tab navigation history (acts on the focused pane).
      else if (e.altKey && !e.ctrlKey && !e.shiftKey && k === "arrowleft") { e.preventDefault(); getActiveRef()?.doBack(); }
      else if (e.altKey && !e.ctrlKey && !e.shiftKey && k === "arrowright") { e.preventDefault(); getActiveRef()?.doForward(); }
      else if (e.altKey && !e.ctrlKey && !e.shiftKey && k === "arrowup") { e.preventDefault(); getActiveRef()?.doNavigateParent(); }
      // Inspector pane toggles (mirror Explorer): Alt+P preview, Alt+Shift+P details.
      else if (e.altKey && !e.ctrlKey && !e.shiftKey && k === "p") { e.preventDefault(); setPreviewOpen((v) => !v); }
      else if (e.altKey && !e.ctrlKey && e.shiftKey && k === "p") { e.preventDefault(); setDetailsOpen((v) => !v); }
      else if (e.ctrlKey && !e.altKey && !e.shiftKey && k === "z") {
        if (inEditable(e.target) || inEditable(document.activeElement)) return;
        e.preventDefault();
        void handleUndo();
      }
      // Clipboard file ops (#9). Never hijack a text edit, and never steal Ctrl+C
      // when the user has a real text selection (let the browser copy that text).
      else if (e.ctrlKey && !e.altKey && !e.shiftKey && k === "c") {
        if (inEditable(e.target) || inEditable(document.activeElement)) return;
        if ((window.getSelection()?.toString() ?? "") !== "") return;
        e.preventDefault();
        getActiveRef()?.doCopyFiles();
      }
      else if (e.ctrlKey && !e.altKey && !e.shiftKey && k === "x") {
        if (inEditable(e.target) || inEditable(document.activeElement)) return;
        e.preventDefault();
        getActiveRef()?.doCutFiles();
      }
      else if (e.ctrlKey && !e.altKey && !e.shiftKey && k === "v") {
        if (inEditable(e.target) || inEditable(document.activeElement)) return;
        e.preventDefault();
        getActiveRef()?.doPaste();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleOpenInNewTab, handleToggleTerminal, handleUndo, getActiveRef]);

  const handleScanPath = useCallback((path: string) => {
    if (path.trim()) { pushRecent(path.trim()); persist(); }
  }, [persist]);

  // Move a tab into `toGroupId` before `beforeId` (append if omitted). Handles
  // both intra-group reorder and cross-group moves. On a cross-group move the
  // pane unmounts/remounts at its new column, so we snapshot its current scan
  // path into initialPath first — the path-keyed scan cache then restores it
  // instantly. Empties source groups are removed and focus follows the tab.
  const handleMoveTab = useCallback((fromId: string, toGroupId: string, beforeId?: string) => {
    if (fromId === beforeId) return;
    const prev = groupsRef.current;
    const src = prev.find((g) => g.tabIds.includes(fromId));
    const dst = prev.find((g) => g.id === toGroupId);
    if (!src || !dst) return;
    const crossGroup = src.id !== dst.id;
    if (!crossGroup) {
      const curIdx = src.tabIds.indexOf(fromId);
      const beforeIdx = beforeId ? src.tabIds.indexOf(beforeId) : src.tabIds.length;
      if (beforeIdx === curIdx || beforeIdx === curIdx + 1) return; // no-op reorder
    }
    if (crossGroup) {
      const p = tabsRef.current.find((t) => t.id === fromId)?.ref.current?.getScanPath();
      if (p) setTabs(tabsRef.current.map((t) => (t.id === fromId ? { ...t, initialPath: p } : t)));
    }
    let next = prev.map((g) => {
      if (!g.tabIds.includes(fromId)) return g;
      const idx = g.tabIds.indexOf(fromId);
      const tabIds = g.tabIds.filter((t) => t !== fromId);
      const activeTabId = g.activeTabId === fromId ? (tabIds[Math.max(0, idx - 1)] ?? tabIds[0] ?? "") : g.activeTabId;
      return { ...g, tabIds, activeTabId };
    });
    next = next.map((g) => {
      if (g.id !== toGroupId) return g;
      const tabIds = [...g.tabIds];
      const at = beforeId ? tabIds.indexOf(beforeId) : -1;
      if (at >= 0) tabIds.splice(at, 0, fromId); else tabIds.push(fromId);
      return { ...g, tabIds, activeTabId: fromId };
    });
    next = next.filter((g) => g.tabIds.length > 0);
    if (next.length > 0) next[next.length - 1] = { ...next[next.length - 1], width: undefined };
    setGroups(next);
    setFocusedGroupId(toGroupId);
  }, []);

  const handleCloseTab = useCallback((groupId: string, id: string) => {
    if (tabsRef.current.length <= 1) return; // always keep one tab open
    const prev = groupsRef.current;
    const group = prev.find((g) => g.id === groupId);
    if (!group || !group.tabIds.includes(id)) return;
    const idx = group.tabIds.indexOf(id);
    let next = prev.map((g) => {
      if (g.id !== groupId) return g;
      const tabIds = g.tabIds.filter((t) => t !== id);
      const activeTabId = g.activeTabId === id ? (tabIds[Math.min(idx, tabIds.length - 1)] ?? "") : g.activeTabId;
      return { ...g, tabIds, activeTabId };
    });
    const emptied = next.some((g) => g.id === groupId && g.tabIds.length === 0);
    next = next.filter((g) => g.tabIds.length > 0);
    if (next.length > 0) next[next.length - 1] = { ...next[next.length - 1], width: undefined };
    setGroups(next);
    setTabs(tabsRef.current.filter((t) => t.id !== id));
    if (emptied && focusedGroupIdRef.current === groupId) setFocusedGroupId(next[0]?.id ?? "");
  }, []);

  // Split editor: open a new pane immediately to the right of `groupId` and
  // focus it. When the source pane has ≥2 tabs we MOVE its active tab into the
  // new pane (per the plan); when it has only one tab we instead open a fresh
  // empty tab there so the current view is preserved (otherwise the source pane
  // would just empty out and the split would be a no-op). Capped at MAX_GROUPS.
  const handleSplitFromGroup = useCallback((groupId: string) => {
    const prev = groupsRef.current;
    if (prev.length >= MAX_GROUPS) return;
    const srcIdx = prev.findIndex((g) => g.id === groupId);
    const src = prev[srcIdx];
    if (!src) return;
    const newGid = newGroupId();
    let next: EditorGroup[];
    if (src.tabIds.length >= 2) {
      const moveId = src.activeTabId;
      next = prev.map((g) => {
        if (g.id !== groupId) return g;
        const idx = g.tabIds.indexOf(moveId);
        const tabIds = g.tabIds.filter((t) => t !== moveId);
        const activeTabId = tabIds[Math.max(0, idx - 1)] ?? tabIds[0] ?? "";
        return { ...g, tabIds, activeTabId };
      });
      next.splice(srcIdx + 1, 0, { id: newGid, tabIds: [moveId], activeTabId: moveId, width: DEFAULT_GROUP_WIDTH });
    } else {
      const id = newTabId();
      const ref = createRef<WorkspaceTabHandle>();
      setTabs((tp) => [...tp, { id, initialPath: "", ref }]);
      next = [...prev];
      next.splice(srcIdx + 1, 0, { id: newGid, tabIds: [id], activeTabId: id, width: DEFAULT_GROUP_WIDTH });
    }
    next[next.length - 1] = { ...next[next.length - 1], width: undefined };
    setGroups(next);
    setFocusedGroupId(newGid);
  }, []);

  // Toggle the controls toolbar (Size/Unit/Files… row) for one pane. Scoped
  // per-editor-group to match the toolbar and the split button, which are both
  // per-pane; persisted alongside the pane layout in paneGroups.
  const handleToggleToolbar = useCallback((groupId: string) => {
    setGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, toolbarHidden: !g.toolbarHidden } : g)));
  }, []);

  // Drag the divider left of group `groupId` to set that pane's width (the last
  // pane always flexes, so resizers only ever target a fixed-width pane).
  const handleGroupResize = useCallback((e: React.MouseEvent, groupId: string) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = groupsRef.current.find((g) => g.id === groupId)?.width ?? DEFAULT_GROUP_WIDTH;
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(MIN_GROUP_WIDTH, Math.min(1600, startW + (ev.clientX - startX)));
      setGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, width: w } : g)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const handleClose3D = useCallback(() => setTmShow3D(false), []);
  const handleToggleChat = useCallback(() => setChatOpen((v) => !v), []);
  const handleOpenChat = useCallback(() => setChatOpen(true), []);
  const handleCloseChat = useCallback(() => setChatOpen(false), []);
  const handleNewAgentSession = useCallback(() => {
    setChatSessionId(newChatSessionId());
    setChatOpen(true);
  }, []);
  const handleRestoreSession = useCallback((id: string) => {
    setChatSessionId(id);
    setChatOpen(true);
  }, []);

  // Prev/Next cycle within the focused pane only.
  const handlePrevTab = useCallback(() => {
    setGroups((prev) => prev.map((g) => {
      if (g.id !== focusedGroupIdRef.current) return g;
      const i = g.tabIds.indexOf(g.activeTabId);
      return i > 0 ? { ...g, activeTabId: g.tabIds[i - 1] } : g;
    }));
  }, []);
  const handleNextTab = useCallback(() => {
    setGroups((prev) => prev.map((g) => {
      if (g.id !== focusedGroupIdRef.current) return g;
      const i = g.tabIds.indexOf(g.activeTabId);
      return i >= 0 && i < g.tabIds.length - 1 ? { ...g, activeTabId: g.tabIds[i + 1] } : g;
    }));
  }, []);

  const handleSelectView = useCallback((v: ViewId) => {
    // Activity icons now live inside the side bar, so selecting a view always
    // keeps the panel open (collapsing it would hide the icons). Use Ctrl+B
    // (or the View menu) to toggle the side bar.
    setActiveView(v);
    setSidebarOpen(true);
  }, []);

  // Drag the divider on the right edge of the shared Explorer side bar. The
  // side bar is a single left panel (hoisted out of the editor groups), so this
  // lives in App alongside sidebarWidth.
  const handleSidebarResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, startW + (ev.clientX - startX)));
      setSidebarWidth(w);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [sidebarWidth]);

  const handleChatResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = chatWidth;
    const onMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX; // drag left = wider chat
      setChatWidth(Math.max(260, Math.min(620, startW + delta)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [chatWidth]);

  // Drag the divider on the left edge of the inspector pane (sits left of chat).
  const handleInspectorResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = inspectorWidth;
    const onMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX; // drag left = wider inspector
      setInspectorWidth(Math.max(240, Math.min(640, startW + delta)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [inspectorWidth]);

  // Open a terminal at `cwd` (called by the editor-toolbar Terminal button).
  const handleOpenTerminal = useCallback((cwd: string) => {
    setTerminalCwd(cwd || "");
    setTerminalMounted(true);
    setTerminalOpen(true);
    setTerminalReq((n) => n + 1);
  }, []);

  const handleTerminalResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = terminalHeight;
    const onMove = (ev: MouseEvent) => {
      const delta = startY - ev.clientY; // drag up = taller
      setTerminalHeight(Math.max(120, Math.min(window.innerHeight - 220, startH + delta)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [terminalHeight]);

  // Editor-tab metadata (label/path/scanning) per tab, rebuilt from live refs
  // each render and looked up per group in the split layout below.
  const metaById = new Map<string, WorkspaceTabMeta>(tabs.map((t) => {
    const handle = t.ref.current;
    const path = handle?.getScanPath() ?? t.initialPath;
    const label = path ? path.split(/[/\\]/).filter(Boolean).pop() ?? path : "New tab";
    return [t.id, { id: t.id, label, path, scanning: handle?.getScanning() ?? false }];
  }));

  const focusedGroup = groups.find((g) => g.id === focusedGroupId) ?? groups[0];
  const focusedTabId = focusedGroup?.activeTabId ?? "";

  const activeRef = getActiveRef();
  // The shared Explorer side bar is driven by the focused group's active tab.
  const sidebarModel = activeRef?.getSidebarModel() ?? EMPTY_SIDEBAR_MODEL;
  const statusData = activeRef?.getData() ?? null;
  const statusStatus = activeRef?.getStatus() ?? "idle";
  const statusError = activeRef?.getErrorMessage() ?? "";
  const statusProgress = activeRef?.getProgress() ?? null;
  const statusVisible = activeRef?.getVisibleCount() ?? 0;
  const navState = activeRef?.getNavState() ?? { canBack: false, canForward: false };
  const activeLabel = metaById.get(focusedTabId)?.label ?? "FileTree";
  const focusedTabIndex = focusedGroup ? focusedGroup.tabIds.indexOf(focusedTabId) : -1;
  const canPrevTab = focusedTabIndex > 0;
  const canNextTab = !!focusedGroup && focusedTabIndex >= 0 && focusedTabIndex < focusedGroup.tabIds.length - 1;

  const menus: Menu[] = [
    {
      label: "File",
      items: [
        { label: "New Tab", kbd: "Ctrl+T", onClick: () => handleOpenInNewTab("") },
        { label: "Close Tab", onClick: () => handleCloseTab(focusedGroupId, focusedTabId), disabled: tabs.length <= 1 },
        { separator: true },
        { label: "Save Session…", onClick: handleSaveSession },
        { label: "Load Session…", onClick: handleLoadSession },
        { separator: true },
        { label: "Export ▸ HTML Report", onClick: () => getActiveRef()?.doExport("html"), disabled: !statusData },
        { label: "Export ▸ Excel (.xlsx)", onClick: () => getActiveRef()?.doExport("xlsx"), disabled: !statusData },
        { label: "Export ▸ PDF (print report)", onClick: () => getActiveRef()?.doExport("pdf"), disabled: !statusData },
        { label: "Export ▸ XML", onClick: () => getActiveRef()?.doExport("xml"), disabled: !statusData },
        { label: "Export ▸ CSV", onClick: () => getActiveRef()?.doExport("csv"), disabled: !statusData },
        { label: "Export ▸ JSON", onClick: () => getActiveRef()?.doExport("json"), disabled: !statusData },
        { separator: true },
        { label: "Scheduled Scans…", onClick: () => setScheduleOpen(true) },
        { separator: true },
        { label: "Exit", onClick: () => window.close() },
      ],
    },
    {
      label: "Edit",
      items: [
        { label: "New Folder", onClick: () => getActiveRef()?.doNewFolder() },
        { label: "Rename", kbd: "F2", onClick: () => getActiveRef()?.doRename() },
        { label: "Delete", kbd: "Del", onClick: () => getActiveRef()?.doDelete() },
        { separator: true },
        { label: "Cut", kbd: "Ctrl+X", onClick: () => getActiveRef()?.doCutFiles() },
        { label: "Copy", kbd: "Ctrl+C", onClick: () => getActiveRef()?.doCopyFiles() },
        { label: "Paste", kbd: "Ctrl+V", onClick: () => getActiveRef()?.doPaste() },
        { label: "Move to…", onClick: () => getActiveRef()?.doMoveTo() },
        { label: "Copy Path", onClick: () => getActiveRef()?.doCopyPath() },
        { separator: true },
        { label: "Filter…", onClick: () => getActiveRef()?.doOpenFilter() },
      ],
    },
    {
      label: "View",
      items: [
        { label: "Toggle Side Bar", kbd: "Ctrl+B", checked: sidebarOpen, onClick: () => setSidebarOpen((v) => !v) },
        { label: "Toggle Panel", kbd: "Ctrl+J", checked: panelOpen, onClick: () => setPanelOpen((v) => !v) },
        { label: "Toggle Terminal", kbd: "Ctrl+`", checked: terminalOpen, onClick: handleToggleTerminal },
        { label: "Toggle AI Assistant", kbd: "Ctrl+Alt+B", checked: chatOpen, onClick: () => setChatOpen((v) => !v) },
        { separator: true },
        { label: "Preview Pane", kbd: "Alt+P", checked: previewOpen, onClick: () => setPreviewOpen((v) => !v) },
        { label: "Details Pane", kbd: "Alt+Shift+P", checked: detailsOpen, onClick: () => setDetailsOpen((v) => !v) },
        { separator: true },
        { label: "Configure Columns…", opensColumns: true },
        { separator: true },
        { label: "Dark Theme", checked: darkMode, onClick: handleToggleDark },
        { separator: true },
        { label: "Treemap: Labels", checked: tmShowLabels, onClick: () => setTmShowLabels((v) => !v) },
        { label: "Treemap: Hierarchy", checked: tmShowHierarchy, onClick: () => setTmShowHierarchy((v) => !v) },
        { label: "Treemap: Legend", checked: tmShowLegend, onClick: () => setTmShowLegend((v) => !v) },
        { separator: true },
        { label: "Expand All", onClick: () => getActiveRef()?.doExpand(Infinity) },
        { label: "Collapse All", onClick: () => getActiveRef()?.doExpand(0) },
      ],
    },
    {
      label: "Go",
      items: [
        { label: "Back", kbd: "Alt+Left", onClick: () => getActiveRef()?.doBack(), disabled: !navState.canBack },
        { label: "Forward", kbd: "Alt+Right", onClick: () => getActiveRef()?.doForward(), disabled: !navState.canForward },
        { label: "Up One Level", kbd: "Alt+Up", onClick: () => getActiveRef()?.doNavigateParent() },
        { separator: true },
        { label: "Reveal in Explorer", onClick: () => getActiveRef()?.doReveal() },
        { separator: true },
        { label: "Refresh", onClick: () => getActiveRef()?.doScan() },
      ],
    },
    {
      label: "Help",
      items: [
        { label: "About FileTree", onClick: () => window.alert("FileTree — a fast disk-usage analyzer with a built-in local-AI assistant.") },
      ],
    },
  ];

  // Overflow menu for the right-hand "⋯" control in the title bar.
  const optionsMenu: MenuItem[] = [
    { label: "New Agent Session", onClick: handleNewAgentSession },
    { label: chatOpen ? "Hide AI Assistant" : "Open AI Assistant", onClick: handleToggleChat },
    { separator: true },
    { label: "Toggle Side Bar", kbd: "Ctrl+B", checked: sidebarOpen, onClick: () => setSidebarOpen((v) => !v) },
    { label: "Toggle Treemap Panel", kbd: "Ctrl+J", checked: panelOpen, onClick: () => setPanelOpen((v) => !v) },
    { separator: true },
    { label: "Dark Theme", checked: darkMode, onClick: handleToggleDark },
    { separator: true },
    { label: "Export ▸ HTML Report", onClick: () => getActiveRef()?.doExport("html"), disabled: !statusData },
    { label: "Export ▸ Excel (.xlsx)", onClick: () => getActiveRef()?.doExport("xlsx"), disabled: !statusData },
    { label: "Export ▸ PDF (print report)", onClick: () => getActiveRef()?.doExport("pdf"), disabled: !statusData },
    { label: "Export ▸ XML", onClick: () => getActiveRef()?.doExport("xml"), disabled: !statusData },
    { label: "Export ▸ CSV", onClick: () => getActiveRef()?.doExport("csv"), disabled: !statusData },
    { label: "Export ▸ JSON", onClick: () => getActiveRef()?.doExport("json"), disabled: !statusData },
    { label: "About FileTree", onClick: () => window.alert("FileTree — a fast disk-usage analyzer with a built-in local-AI assistant.") },
  ];

  return (
    <div className="vscode">
      <TitleBar
        title={`${activeLabel} — FileTree`}
        menus={menus}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        onPrevTab={handlePrevTab}
        onNextTab={handleNextTab}
        canPrevTab={canPrevTab}
        canNextTab={canNextTab}
        terminalOpen={terminalOpen}
        onToggleTerminal={handleToggleTerminal}
        chatOpen={chatOpen}
        onToggleChat={handleToggleChat}
        onOpenAgents={handleOpenChat}
        onNewSession={handleNewAgentSession}
        onCloseChat={handleCloseChat}
        getSessions={loadChatIndex}
        onRestoreSession={handleRestoreSession}
        optionsMenu={optionsMenu}
        visibleColumns={visibleColumns}
        onVisibleColumnsChange={setVisibleColumns}
        decimals={decimals}
        onDecimalsChange={setDecimals}
        unit={(activeRef?.getRibbonState()?.unit as Unit) ?? "auto"}
        onUnitChange={(u) => { getActiveRef()?.setUnit(u); notifyState(); }}
      />

      <div className="vsc-middle">
      <div className="vsc-body">
        {sidebarOpen && (
          <>
            <div className="sidebar" style={{ width: sidebarWidth, flex: `0 0 ${sidebarWidth}px` }}>
              <ActivityBar
                activeView={activeView}
                sidebarOpen={sidebarOpen}
                onSelect={handleSelectView}
                bookmarkCount={bookmarkList.length}
                errorCount={sidebarModel.errorCount}
                darkMode={darkMode}
                onToggleTheme={handleToggleDark}
              />
              <SideBar
                view={activeView}
                data={sidebarModel.data}
                nodeById={sidebarModel.nodeById}
                unit={sidebarModel.unit}
                onNavigate={sidebarModel.onNavigate}
                scanPath={sidebarModel.scanPath}
                scanning={sidebarModel.scanning}
                onScanPathInput={sidebarModel.onScanPathInput}
                onScan={sidebarModel.onScan}
                onCancel={sidebarModel.onCancel}
                onRefresh={sidebarModel.onRefresh}
                onUp={sidebarModel.onUp}
                onNewFolder={sidebarModel.onNewFolder}
                onCollapseAll={sidebarModel.onCollapseAll}
                drives={drives}
                specialFolders={specialFolders}
                bookmarkList={bookmarkList}
                onOpenLocation={sidebarModel.onOpenLocation}
                treeRows={sidebarModel.treeRows}
                expanded={sidebarModel.expanded}
                selectedId={sidebarModel.selectedId}
                onToggleExpand={sidebarModel.onToggleExpand}
                onSelectFolder={sidebarModel.onSelectFolder}
                selectedNode={sidebarModel.selectedNode}
                onOpen={sidebarModel.onOpen}
                onReveal={sidebarModel.onReveal}
                onCopyPath={sidebarModel.onCopyPath}
                onScanPath={sidebarModel.onScanPath}
                onRemoveBookmark={handleToggleBookmark}
                dupes={dupes}
              />
            </div>
            <div className="resizer-x" onMouseDown={handleSidebarResize} />
          </>
        )}
        <div className="workbench-tabs" style={activeView === "duplicates" || activeView === "reports" ? { display: "none" } : undefined}>
          {groups.map((group, gi) => {
            const isLast = gi === groups.length - 1;
            const isFocused = group.id === focusedGroupId;
            const groupMeta = group.tabIds
              .map((id) => metaById.get(id))
              .filter((m): m is WorkspaceTabMeta => !!m);
            const canSplit = groups.length < MAX_GROUPS;
            return (
              <Fragment key={group.id}>
                {gi > 0 && (
                  <div className="resizer-x" onMouseDown={(e) => handleGroupResize(e, groups[gi - 1].id)} />
                )}
                <div
                  className={`editor-group${isFocused && groups.length > 1 ? " focused" : ""}`}
                  // The last pane flexes to fill leftover space; earlier panes
                  // keep their resized width but stay shrinkable (flex-shrink:1)
                  // so a tight editor area squeezes them down to MIN_GROUP_WIDTH
                  // instead of overflowing the container into the chat panel.
                  style={isLast
                    ? { flex: "1 1 0", minWidth: MIN_GROUP_WIDTH, minHeight: 0 }
                    : { flex: `0 1 ${group.width ?? DEFAULT_GROUP_WIDTH}px`, minWidth: MIN_GROUP_WIDTH, minHeight: 0 }}
                  onMouseDownCapture={() => { if (focusedGroupId !== group.id) setFocusedGroupId(group.id); }}
                >
                  <TabBar
                    groupId={group.id}
                    tabs={groupMeta}
                    activeId={group.activeTabId}
                    onActivate={(id) => handleActivateTab(group.id, id)}
                    onClose={(id) => handleCloseTab(group.id, id)}
                    onNew={() => openTabInGroup(group.id, "")}
                    onMoveTab={handleMoveTab}
                    onFolderDrop={(path, beforeId) => openTabInGroup(group.id, path, beforeId)}
                    onSplit={canSplit ? () => handleSplitFromGroup(group.id) : undefined}
                    toolbarVisible={!group.toolbarHidden}
                    onToggleToolbar={() => handleToggleToolbar(group.id)}
                    canCloseLast={groups.length > 1}
                  />
                  {group.tabIds.map((tabId) => {
                    const tab = tabs.find((t) => t.id === tabId);
                    if (!tab) return null;
                    const visible = tabId === group.activeTabId;
                    return (
                      <WorkspaceTab
                        key={tab.id}
                        ref={tab.ref}
                        tabId={tab.id}
                        initialPath={tab.initialPath}
                        active={visible}
                        onOpenTerminal={handleOpenTerminal}
                        activeView={activeView}
                        toolbarVisible={!group.toolbarHidden}
                        darkMode={darkMode}
                        panelOpen={panelOpen}
                        onPanelOpenChange={setPanelOpen}
                        panelHeight={panelHeight}
                        onPanelHeightChange={setPanelHeight}
                        bookmarkList={bookmarkList}
                        threads={threads}
                        includeHidden={includeHidden}
                        followLinks={followLinks}
                        collectOwners={collectOwners}
                        onCollectOwnersChange={setCollectOwners}
                        exclude={exclude}
                        treemapDetail={treemapDetail}
                        tmShowSingleFiles={tmShowSingleFiles}
                        tmShow3D={tmShow3D}
                        tmShowHierarchy={tmShowHierarchy}
                        tmShowLegend={tmShowLegend}
                        tmShowLabels={tmShowLabels}
                        tmDragDrop={tmDragDrop}
                        decimals={decimals}
                        visibleColumns={visibleColumns}
                        onVisibleColumnsChange={setVisibleColumns}
                        onDecimalsChange={setDecimals}
                        onClose3D={handleClose3D}
                        onToggleBookmark={handleToggleBookmark}
                        onScanPath={handleScanPath}
                        onStateChange={notifyState}
                        onOpenFolderInTab={handleOpenFolderInTab}
                      />
                    );
                  })}
                </div>
              </Fragment>
            );
          })}
        </div>

        {activeView === "duplicates" && (
          <div className="dupes-editor">
            <DuplicatesResults ctrl={dupes} />
          </div>
        )}

        {activeView === "reports" && (
          <div className="reports-editor">
            <ReportsView
              data={sidebarModel.data}
              nodeById={sidebarModel.nodeById}
              onNavigate={(id) => { sidebarModel.onNavigate(id); setActiveView("explorer"); }}
            />
          </div>
        )}

        {(previewOpen || detailsOpen) && (
          <>
            <div className="resizer-x" onMouseDown={handleInspectorResize} />
            <InspectorPane
              width={inspectorWidth}
              node={sidebarModel.selectedNode}
              data={sidebarModel.data}
              nodeById={sidebarModel.nodeById}
              unit={sidebarModel.unit}
              showPreview={previewOpen}
              showDetails={detailsOpen}
              onClosePreview={() => setPreviewOpen(false)}
              onCloseDetails={() => setDetailsOpen(false)}
              onOpen={sidebarModel.onOpen}
              onReveal={sidebarModel.onReveal}
              onCopyPath={sidebarModel.onCopyPath}
            />
          </>
        )}

        {chatOpen && (
          <>
            <div className="resizer-x" onMouseDown={handleChatResize} />
            <ChatPanel
              width={chatWidth}
              sessionId={chatSessionId}
              getAgentApi={() => getActiveRef()?.getAgentApi() ?? null}
              includeHidden={includeHidden}
              threads={threads}
              onClose={() => setChatOpen(false)}
              onNewSession={handleNewAgentSession}
              onRestoreSession={handleRestoreSession}
            />
          </>
        )}
      </div>

        {terminalMounted && (
          <>
            {terminalOpen && <div className="resizer-y" onMouseDown={handleTerminalResize} />}
            <TerminalPanel
              open={terminalOpen}
              height={terminalHeight}
              requestCwd={terminalCwd}
              requestNonce={terminalReq}
              darkMode={darkMode}
              onClose={() => setTerminalOpen(false)}
            />
          </>
        )}
      </div>

      {scheduleOpen && (
        <ScheduleWizard
          initialPath={activeRef?.getScanPath() ?? ""}
          onClose={() => setScheduleOpen(false)}
        />
      )}

      <StatusBar
        scanResult={statusData}
        status={statusStatus}
        errorMessage={statusError}
        progress={statusProgress}
        visibleCount={statusVisible}
        scanPath={activeRef?.getScanPath() ?? ""}
      />
    </div>
  );
}
