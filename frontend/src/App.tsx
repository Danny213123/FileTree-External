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
import type { DriveEntry, SpecialFolder, SortKey } from "./api/types";
import { DEFAULT_VISIBLE_COLUMNS } from "./components/TreeTable";
import { RibbonBar, pushRecent, loadRecentPaths, setRecentPaths } from "./components/RibbonBar";
import { StatusBar } from "./components/StatusBar";
import { TabBar } from "./components/TabBar";
import type { WorkspaceTab as WorkspaceTabMeta } from "./components/TabBar";
import { WorkspaceTab } from "./components/WorkspaceTab";
import type { WorkspaceTabHandle } from "./components/WorkspaceTab";

const SETTINGS_DEBOUNCE_MS = 800;
const TABS_DEBOUNCE_MS = 600;

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
  const [darkMode, setDarkModeState] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [treemapPosition, setTreemapPosition] = useState<"bottom" | "right">("bottom");
  const [treemapDetail, setTreemapDetail] = useState(3);
  const [tmShowSingleFiles, setTmShowSingleFiles] = useState(true);
  const [tmShow3D, setTmShow3D] = useState(false);
  const [tmShowHierarchy, setTmShowHierarchy] = useState(true);
  const [tmShowLegend, setTmShowLegend] = useState(true);
  const [tmShowLabels, setTmShowLabels] = useState(true);
  const [tmDragDrop, setTmDragDrop] = useState(false);
  const [decimals, setDecimals] = useState(2);
  const [visibleColumns, setVisibleColumns] = useState<Set<SortKey>>(DEFAULT_VISIBLE_COLUMNS);

  // Multi-tab state
  const [tabs, setTabs] = useState<TabEntry[]>(() => [{ id: newTabId(), initialPath: "", ref: createRef<WorkspaceTabHandle>() }]);
  const [activeTabId, setActiveTabId] = useState<string>(tabs[0].id);

  // Ribbon re-render trigger: changes when the active tab's ribbon state changes
  const [ribbonTick, setRibbonTick] = useState(0);
  const notifyRibbon = useCallback(() => setRibbonTick((n) => n + 1), []);

  // Controlled ribbon tab — lives here so WorkspaceTab can read it as a prop
  const [activeRibbonTab, setActiveRibbonTab] = useState("home");

  const getActiveRef = useCallback((): WorkspaceTabHandle | null => {
    const tab = tabs.find((t) => t.id === activeTabId);
    return tab?.ref.current ?? null;
  }, [tabs, activeTabId]);

  // Settings save debounce
  const settingsSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tabsSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleSaveSettings = useCallback(() => {
    if (!settingsLoaded) return;
    if (settingsSaveTimer.current) clearTimeout(settingsSaveTimer.current);
    settingsSaveTimer.current = setTimeout(() => {
      const active = getActiveRef();
      const rs = active?.getRibbonState();
      saveSettings({
        darkMode,
        threads,
        includeHidden,
        followLinks,
        exclude,
        lastPath: rs?.scanPath ?? "",
        metric: rs?.metric ?? "size",
        unit: rs?.unit ?? "auto",
        showFiles: rs?.showFiles ?? true,
        recentPaths: loadRecentPaths(),
      }).catch(() => {});
    }, SETTINGS_DEBOUNCE_MS);
  }, [settingsLoaded, darkMode, threads, includeHidden, followLinks, exclude, getActiveRef]);

  useEffect(() => {
    scheduleSaveSettings();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [darkMode, threads, includeHidden, followLinks, exclude]);

  // Auto-save open tab paths whenever the tab list changes
  useEffect(() => {
    if (!settingsLoaded) return;
    if (tabsSaveTimer.current) clearTimeout(tabsSaveTimer.current);
    tabsSaveTimer.current = setTimeout(() => {
      const paths = tabs.map((t) => t.ref.current?.getScanPath() ?? t.initialPath);
      saveSettings({ openTabs: paths }).catch(() => {});
    }, TABS_DEBOUNCE_MS);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, settingsLoaded]);

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
          setTabs(paths.map((p) => ({ id: newTabId(), initialPath: p, ref: createRef<WorkspaceTabHandle>() })));
          setActiveTabId((prev) => prev); // reset to first handled by setTabs
        } catch { /* malformed */ }
      };
      reader.readAsText(file);
    };
    input.click();
  }, []);

  const handleDarkModeChange = useCallback((v: boolean) => {
    setDarkModeState(v);
    document.documentElement.dataset.theme = v ? "dark" : "light";
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
      // Restore recent paths into localStorage so the dropdown shows them immediately
      if (settings.recentPaths?.length) setRecentPaths(settings.recentPaths);

      setDrives(driveList.drives ?? []);
      setSpecialFolders(folderList.folders ?? []);
      setBookmarkList(savedBookmarks);

      // Restore saved tabs (or fall back to lastPath / initialPath)
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

  // External file/folder drop into FileTree:
  // In Electron, files dropped onto the window are handled by the main process
  // which sends the absolute paths back via ipcRenderer → preload → electronAPI.
  // Additionally accept HTML5 dragover/drop for when running in dev (Vite server).
  useEffect(() => {
    // Register Electron IPC drop handler (production path).
    const eAPI = (window as unknown as { electronAPI?: { onExternalDrop: (cb: (paths: string[]) => void) => void } }).electronAPI;
    if (eAPI?.onExternalDrop) {
      eAPI.onExternalDrop((paths) => paths.forEach((p) => handleOpenInNewTab(p)));
    }

    // HTML5 drop fallback for dev mode / non-Electron environments.
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      if (!Array.from(e.dataTransfer.types).includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      // In Electron, (file as any).path gives the absolute path.
      for (const f of Array.from(e.dataTransfer.files)) {
        const p = (f as unknown as { path?: string }).path;
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

  const handleScanPath = useCallback((path: string) => {
    getActiveRef()?.doScanPath(path);
    if (path.trim()) {
      pushRecent(path.trim());
      scheduleSaveSettings();
    }
  }, [getActiveRef, scheduleSaveSettings]);

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
        // Activate adjacent tab
        const newIdx = Math.min(idx, next.length - 1);
        return next[newIdx]?.id ?? cur;
      });
      return next;
    });
  }, []);

  // Build tab bar metadata from active refs each render
  const tabBarMeta: WorkspaceTabMeta[] = tabs.map((t) => {
    const handle = t.ref.current;
    const path = handle?.getScanPath() ?? t.initialPath;
    const label = path ? path.split(/[/\\]/).filter(Boolean).pop() ?? path : "New tab";
    return {
      id: t.id,
      label,
      path,
      scanning: handle?.getScanning() ?? false,
    };
  });

  // Ribbon reads from active tab
  const activeRef = getActiveRef();
  const rs = activeRef?.getRibbonState();
  const ribbonScanPath = rs?.scanPath ?? "";
  const ribbonScanning = rs?.scanning ?? false;
  const ribbonMetric = rs?.metric ?? "size";
  const ribbonUnit = rs?.unit ?? "auto";
  const ribbonFilter = rs?.filter ?? "";
  const ribbonShowFiles = rs?.showFiles ?? true;
  const ribbonFilterActive = rs?.filterActive ?? false;
  const ribbonActiveTab = rs?.activeTab ?? "chart";
  const ribbonSortKey = rs?.sortKey ?? "size";
  const ribbonSortDir = rs?.sortDir ?? -1;

  // Status bar reads from active tab
  const statusData = activeRef?.getData() ?? null;
  const statusStatus = activeRef?.getStatus() ?? "idle";
  const statusError = activeRef?.getErrorMessage() ?? "";
  const statusProgress = activeRef?.getProgress() ?? null;
  const statusVisible = activeRef?.getVisibleCount() ?? 0;

  // Suppress ribbonTick lint — it's used to force re-render when tab state changes
  void ribbonTick;

  return (
    <div className="shell">
      <RibbonBar
        scanPath={ribbonScanPath}
        onPathChange={(p) => activeRef?.setScanPath(p)}
        onScan={() => activeRef?.doScan()}
        onCancel={() => activeRef?.doCancel()}
        scanning={ribbonScanning}
        hasScan={statusData !== null}
        drives={drives}
        specialFolders={specialFolders}
        metric={ribbonMetric as never}
        unit={ribbonUnit as never}
        filter={ribbonFilter}
        showFiles={ribbonShowFiles}
        includeHidden={includeHidden}
        followLinks={followLinks}
        exclude={exclude}
        threads={threads}
        onMetricChange={(m) => activeRef?.setMetric(m)}
        onUnitChange={(u) => activeRef?.setUnit(u)}
        onFilterChange={(f) => activeRef?.setFilter(f)}
        onShowFilesChange={(v) => activeRef?.setShowFiles(v)}
        onHiddenChange={setIncludeHidden}
        onFollowLinksChange={setFollowLinks}
        onExcludeChange={setExclude}
        onThreadsChange={setThreads}
        onNavigateParent={() => activeRef?.doNavigateParent()}
        onScanPath={handleScanPath}
        onExpand={(level) => activeRef?.doExpand(level)}
        onNewFolder={() => activeRef?.doNewFolder()}
        onOpenFilter={() => activeRef?.doOpenFilter()}
        onExport={(format) => activeRef?.doExport(format)}
        onOpenLocation={() => activeRef?.doReveal()}
        onCopyFiles={() => activeRef?.doCopyFiles()}
        filterActive={ribbonFilterActive}
        bookmarks={bookmarkList}
        darkMode={darkMode}
        onDarkModeChange={handleDarkModeChange}
        activeTab={ribbonActiveTab}
        activeRibbonTab={activeRibbonTab}
        onRibbonTabChange={setActiveRibbonTab}
        onSaveSession={handleSaveSession}
        onLoadSession={handleLoadSession}
        onShowDetails={() => activeRef?.showDetailsPane()}
        onShowTreemap={() => activeRef?.showTreemapPane()}
        treemapPosition={treemapPosition}
        treemapDetail={treemapDetail}
        onTreemapPositionChange={setTreemapPosition}
        onTreemapDetailChange={setTreemapDetail}
        tmShowSingleFiles={tmShowSingleFiles}
        tmShow3D={tmShow3D}
        tmShowHierarchy={tmShowHierarchy}
        tmShowLegend={tmShowLegend}
        tmShowLabels={tmShowLabels}
        tmDragDrop={tmDragDrop}
        onTmShowSingleFilesChange={setTmShowSingleFiles}
        onTmShow3DChange={setTmShow3D}
        onTmShowHierarchyChange={setTmShowHierarchy}
        onTmShowLegendChange={setTmShowLegend}
        onTmShowLabelsChange={setTmShowLabels}
        onTmDragDropChange={setTmDragDrop}
        decimals={decimals}
        visibleColumns={visibleColumns}
        sortKey={ribbonSortKey}
        sortDir={ribbonSortDir}
        onDecimalsChange={setDecimals}
        onVisibleColumnsChange={setVisibleColumns}
        onSortChange={(key, dir) => activeRef?.setSortKeyDir(key, dir)}
      />

      <TabBar
        tabs={tabBarMeta}
        activeId={activeTabId}
        onActivate={setActiveTabId}
        onClose={handleCloseTab}
        onNew={() => handleOpenInNewTab("")}
        onReorder={handleReorderTab}
        onFolderDrop={(path, beforeId) => handleOpenInNewTab(path, beforeId)}
      />

      <div className="workspace-area">
        {tabs.map((tab) => (
          <WorkspaceTab
            key={tab.id}
            ref={tab.ref}
            tabId={tab.id}
            initialPath={tab.initialPath}
            active={tab.id === activeTabId}
            showDuplicateFinder={activeRibbonTab === "duplicates"}
            drives={drives}
            specialFolders={specialFolders}
            bookmarkList={bookmarkList}
            threads={threads}
            includeHidden={includeHidden}
            followLinks={followLinks}
            exclude={exclude}
            treemapPosition={treemapPosition}
            treemapDetail={treemapDetail}
            tmShowSingleFiles={tmShowSingleFiles}
            tmShow3D={tmShow3D}
            tmShowHierarchy={tmShowHierarchy}
            tmShowLegend={tmShowLegend}
            tmShowLabels={tmShowLabels}
            tmDragDrop={tmDragDrop}
            decimals={decimals}
            visibleColumns={visibleColumns}
            onClose3D={() => setTmShow3D(false)}
            onToggleBookmark={handleToggleBookmark}
            onScanPath={handleScanPath}
            onStateChange={notifyRibbon}
          />
        ))}
      </div>

      <StatusBar
        scanResult={statusData}
        status={statusStatus}
        errorMessage={statusError}
        progress={statusProgress}
        visibleCount={statusVisible}
      />
    </div>
  );
}
