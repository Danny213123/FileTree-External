import { useState, useEffect, useCallback, useRef, createRef } from "react";
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
import type { DriveEntry, SpecialFolder, SortKey } from "./api/types";
import { DEFAULT_VISIBLE_COLUMNS } from "./components/TreeTable";
import { pushRecent, loadRecentPaths, setRecentPaths } from "./components/RibbonBar";
import { StatusBar } from "./components/StatusBar";
import type { WorkspaceTab as WorkspaceTabMeta } from "./components/TabBar";
import { WorkspaceTab } from "./components/WorkspaceTab";
import type { WorkspaceTabHandle } from "./components/WorkspaceTab";
import { TitleBar, type Menu, type MenuItem } from "./components/TitleBar";
import { loadChatIndex, newChatSessionId } from "./lib/chatSessions";
import type { ViewId } from "./components/ActivityBar";
import { ChatPanel } from "./components/ChatPanel";
import { TerminalPanel } from "./components/TerminalPanel";

const SETTINGS_DEBOUNCE_MS = 700;

let nextTabId = 1;
function newTabId() { return String(nextTabId++); }

interface TabEntry {
  id: string;
  initialPath: string;
  ref: React.RefObject<WorkspaceTabHandle>;
}

export default function App() {
  const [threads, setThreads] = useState(8);
  const [exclude, setExclude] = useState("");
  const [includeHidden, setIncludeHidden] = useState(false);
  const [followLinks, setFollowLinks] = useState(false);
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
  const [decimals] = useState(2);
  const [visibleColumns] = useState<Set<SortKey>>(DEFAULT_VISIBLE_COLUMNS);

  // VS Code workbench layout
  const [activeView, setActiveView] = useState<ViewId>("explorer");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelHeight, setPanelHeight] = useState(320);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatWidth, setChatWidth] = useState(360);
  const [chatSessionId, setChatSessionId] = useState<string>(() => newChatSessionId());

  // Integrated terminal (global bottom panel). Mounted lazily on first open and
  // kept mounted thereafter so sessions survive hiding the panel.
  const [terminalMounted, setTerminalMounted] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(260);
  const [terminalCwd, setTerminalCwd] = useState("");
  const [terminalReq, setTerminalReq] = useState(0);
  const terminalOpenRef = useRef(false);
  useEffect(() => { terminalOpenRef.current = terminalOpen; }, [terminalOpen]);

  const [tabs, setTabs] = useState<TabEntry[]>(() => [{ id: newTabId(), initialPath: "", ref: createRef<WorkspaceTabHandle>() }]);
  const [activeTabId, setActiveTabId] = useState<string>(tabs[0].id);

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

  const getActiveRef = useCallback((): WorkspaceTabHandle | null => {
    const tab = tabs.find((t) => t.id === activeTabId);
    return tab?.ref.current ?? null;
  }, [tabs, activeTabId]);

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
      darkMode, threads, includeHidden, followLinks, exclude,
      lastPath: rs?.scanPath ?? "",
      metric: rs?.metric ?? "size",
      unit: rs?.unit ?? "auto",
      showFiles: rs?.showFiles ?? true,
      recentPaths: loadRecentPaths(),
      openTabs: tabs.map((t) => t.ref.current?.getScanPath() ?? t.initialPath),
      activeView, sidebarOpen, sidebarWidth, panelOpen, panelHeight, chatOpen, chatWidth,
    };
  }, [darkMode, threads, includeHidden, followLinks, exclude, getActiveRef, tabs,
      activeView, sidebarOpen, sidebarWidth, panelOpen, panelHeight, chatOpen, chatWidth]);

  const persist = useCallback(() => {
    if (!settingsLoaded) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { saveSettings(buildSettings()).catch(() => {}); }, SETTINGS_DEBOUNCE_MS);
  }, [settingsLoaded, buildSettings]);

  useEffect(() => { persist(); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [darkMode, threads, includeHidden, followLinks, exclude, tabs,
     activeView, sidebarOpen, sidebarWidth, panelOpen, panelHeight, chatOpen, chatWidth]);

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
          setTabs(restored);
          setActiveTabId(restored[0].id);
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
      if (settings.exclude !== undefined) setExclude(settings.exclude);
      if (settings.recentPaths?.length) setRecentPaths(settings.recentPaths);
      // Layout
      if (settings.activeView && ["explorer", "search", "treemap", "bookmarks", "errors"].includes(settings.activeView)) {
        setActiveView(settings.activeView as ViewId);
      }
      if (settings.sidebarOpen !== undefined) setSidebarOpen(settings.sidebarOpen);
      if (settings.sidebarWidth) setSidebarWidth(settings.sidebarWidth);
      if (settings.panelOpen !== undefined) setPanelOpen(settings.panelOpen);
      if (settings.panelHeight) setPanelHeight(settings.panelHeight);
      if (settings.chatOpen !== undefined) setChatOpen(settings.chatOpen);
      if (settings.chatWidth) setChatWidth(settings.chatWidth);

      setDrives(driveList.drives ?? []);
      setSpecialFolders(folderList.folders ?? []);
      setBookmarkList(savedBookmarks);

      const savedPaths = settings.openTabs?.filter(Boolean);
      if (savedPaths && savedPaths.length > 0) {
        const restoredTabs = savedPaths.map((p) => ({ id: newTabId(), initialPath: p, ref: createRef<WorkspaceTabHandle>() }));
        setTabs(restoredTabs);
        setActiveTabId(restoredTabs[0].id);
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

  const handleOpenInNewTab = useCallback((path: string, beforeId?: string) => {
    const id = newTabId();
    const ref = createRef<WorkspaceTabHandle>();
    setTabs((prev) => {
      if (beforeId) {
        const idx = prev.findIndex((t) => t.id === beforeId);
        if (idx >= 0) {
          const next = [...prev];
          next.splice(idx, 0, { id, initialPath: path, ref });
          return next;
        }
      }
      return [...prev, { id, initialPath: path, ref }];
    });
    setActiveTabId(id);
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
      for (const f of Array.from(e.dataTransfer.files)) {
        const p = pathForFile(f);
        if (p) handleOpenInNewTab(p);
      }
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [handleOpenInNewTab]);

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

  // ── VS Code keybindings ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (e.ctrlKey && e.altKey && k === "b") { e.preventDefault(); setChatOpen((v) => !v); }
      else if (e.ctrlKey && !e.altKey && !e.shiftKey && k === "b") { e.preventDefault(); setSidebarOpen((v) => !v); }
      else if (e.ctrlKey && k === "j") { e.preventDefault(); setPanelOpen((v) => !v); }
      else if (e.ctrlKey && k === "t") { e.preventDefault(); handleOpenInNewTab(""); }
      else if (e.ctrlKey && (k === "`" || e.code === "Backquote")) { e.preventDefault(); handleToggleTerminal(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleOpenInNewTab, handleToggleTerminal]);

  const handleScanPath = useCallback((path: string) => {
    if (path.trim()) { pushRecent(path.trim()); persist(); }
  }, [persist]);

  const handleReorderTab = useCallback((fromId: string, toId: string) => {
    setTabs((prev) => {
      const fromIdx = prev.findIndex((t) => t.id === fromId);
      const toIdx = prev.findIndex((t) => t.id === toId);
      if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  }, []);

  const handleCloseTab = useCallback((id: string) => {
    setTabs((prev) => {
      if (prev.length <= 1) return prev;
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      setActiveTabId((cur) => {
        if (cur !== id) return cur;
        const newIdx = Math.min(idx, next.length - 1);
        return next[newIdx]?.id ?? cur;
      });
      return next;
    });
  }, []);

  // Stable identities so memoized WorkspaceTabs don't re-render on every App render.
  const handleNewTab = useCallback(() => handleOpenInNewTab(""), [handleOpenInNewTab]);
  const handleFolderDrop = useCallback(
    (path: string, beforeId?: string) => handleOpenInNewTab(path, beforeId),
    [handleOpenInNewTab],
  );
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

  const handlePrevTab = useCallback(() => {
    setActiveTabId((cur) => {
      const i = tabs.findIndex((t) => t.id === cur);
      return i > 0 ? tabs[i - 1].id : cur;
    });
  }, [tabs]);
  const handleNextTab = useCallback(() => {
    setActiveTabId((cur) => {
      const i = tabs.findIndex((t) => t.id === cur);
      return i >= 0 && i < tabs.length - 1 ? tabs[i + 1].id : cur;
    });
  }, [tabs]);

  const handleSelectView = useCallback((v: ViewId) => {
    // Activity icons now live inside the side bar, so selecting a view always
    // keeps the panel open (collapsing it would hide the icons). Use Ctrl+B
    // (or the View menu) to toggle the side bar.
    setActiveView(v);
    setSidebarOpen(true);
  }, []);

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

  // Build editor-tab metadata from active refs each render
  const tabBarMeta: WorkspaceTabMeta[] = tabs.map((t) => {
    const handle = t.ref.current;
    const path = handle?.getScanPath() ?? t.initialPath;
    const label = path ? path.split(/[/\\]/).filter(Boolean).pop() ?? path : "New tab";
    return { id: t.id, label, path, scanning: handle?.getScanning() ?? false };
  });

  const activeRef = getActiveRef();
  const statusData = activeRef?.getData() ?? null;
  const statusStatus = activeRef?.getStatus() ?? "idle";
  const statusError = activeRef?.getErrorMessage() ?? "";
  const statusProgress = activeRef?.getProgress() ?? null;
  const statusVisible = activeRef?.getVisibleCount() ?? 0;
  const activeLabel = tabBarMeta.find((t) => t.id === activeTabId)?.label ?? "FileTree";
  const activeTabIndex = tabs.findIndex((t) => t.id === activeTabId);

  const menus: Menu[] = [
    {
      label: "File",
      items: [
        { label: "New Tab", kbd: "Ctrl+T", onClick: () => handleOpenInNewTab("") },
        { label: "Close Tab", onClick: () => handleCloseTab(activeTabId), disabled: tabs.length <= 1 },
        { separator: true },
        { label: "Save Session…", onClick: handleSaveSession },
        { label: "Load Session…", onClick: handleLoadSession },
        { separator: true },
        { label: "Export as CSV", onClick: () => getActiveRef()?.doExport("csv"), disabled: !statusData },
        { label: "Export as JSON", onClick: () => getActiveRef()?.doExport("json"), disabled: !statusData },
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
        { label: "Up One Level", onClick: () => getActiveRef()?.doNavigateParent() },
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
    { label: "Export as CSV", onClick: () => getActiveRef()?.doExport("csv"), disabled: !statusData },
    { label: "Export as JSON", onClick: () => getActiveRef()?.doExport("json"), disabled: !statusData },
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
        canPrevTab={activeTabIndex > 0}
        canNextTab={activeTabIndex >= 0 && activeTabIndex < tabs.length - 1}
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
      />

      <div className="vsc-middle">
      <div className="vsc-body">
        <div className="workbench-tabs" style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex" }}>
          {tabs.map((tab) => (
            <WorkspaceTab
              key={tab.id}
              ref={tab.ref}
              tabId={tab.id}
              initialPath={tab.initialPath}
              active={tab.id === activeTabId}
              onOpenTerminal={handleOpenTerminal}
              activeView={activeView}
              onSelectView={handleSelectView}
              chatOpen={chatOpen}
              onToggleChat={handleToggleChat}
              darkMode={darkMode}
              onToggleTheme={handleToggleDark}
              sidebarOpen={sidebarOpen}
              sidebarWidth={sidebarWidth}
              onSidebarWidthChange={setSidebarWidth}
              panelOpen={panelOpen}
              onPanelOpenChange={setPanelOpen}
              panelHeight={panelHeight}
              onPanelHeightChange={setPanelHeight}
              tabBarMeta={tabBarMeta}
              activeTabId={activeTabId}
              onActivateTab={setActiveTabId}
              onCloseTab={handleCloseTab}
              onNewTab={handleNewTab}
              onReorderTab={handleReorderTab}
              onFolderDrop={handleFolderDrop}
              drives={drives}
              specialFolders={specialFolders}
              bookmarkList={bookmarkList}
              threads={threads}
              includeHidden={includeHidden}
              followLinks={followLinks}
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
              onClose3D={handleClose3D}
              onToggleBookmark={handleToggleBookmark}
              onScanPath={handleScanPath}
              onStateChange={notifyState}
            />
          ))}
        </div>

        {chatOpen && (
          <>
            <div className="resizer-x" onMouseDown={handleChatResize} />
            <ChatPanel
              width={chatWidth}
              sessionId={chatSessionId}
              getAgentApi={() => getActiveRef()?.getAgentApi() ?? null}
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
