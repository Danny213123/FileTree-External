import { useState, useRef, useEffect } from "react";

interface WorkspaceTab {
  id: string;
  label: string;
  path: string;
  scanning: boolean;
}

interface TabBarProps {
  tabs: WorkspaceTab[];
  activeId: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onReorder: (fromId: string, toId: string) => void;
  onFolderDrop: (path: string, beforeId?: string) => void;
}

export function TabBar({ tabs, activeId, onActivate, onClose, onNew, onReorder, onFolderDrop }: TabBarProps) {
  const draggingTabIdRef = useRef<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const nativeDragPathRef = useRef<string | null>(null);
  // Index before which to show reorder indicator
  const [reorderInsertIdx, setReorderInsertIdx] = useState<number | null>(null);
  // Index before which to show folder ghost (tabs.length = append at end)
  const [folderInsertIdx, setFolderInsertIdx] = useState<number | null>(null);

  // Listen for native drag move/end events from Electron main process.
  useEffect(() => {
    type EAPI = {
      onNativeDragMove?: (cb: (x: number, y: number, path: string) => void) => void;
      onNativeDragEnd?: (cb: () => void) => void;
    };
    const eAPI = (window as unknown as { electronAPI?: EAPI }).electronAPI;
    if (!eAPI?.onNativeDragMove) return;

    eAPI.onNativeDragMove((cx, cy, dragPath) => {
      const bar = barRef.current;
      if (!bar) return;
      const rect = bar.getBoundingClientRect();
      if (cy < rect.top || cy > rect.bottom) {
        // Cursor outside tab bar — clear ghost
        if (folderInsertIdx !== null) setFolderInsertIdx(null);
        nativeDragPathRef.current = null;
        return;
      }
      // Cursor is inside tab bar — find insertion index
      nativeDragPathRef.current = dragPath;
      const tabEls = Array.from(bar.querySelectorAll<HTMLElement>(".wtab:not(.wtab-ghost)"));
      let insertIdx = tabs.length; // default: append
      for (let i = 0; i < tabEls.length; i++) {
        const tr = tabEls[i].getBoundingClientRect();
        if (cx < tr.left + tr.width / 2) { insertIdx = i; break; }
      }
      setFolderInsertIdx(insertIdx);
    });

    eAPI.onNativeDragEnd?.(() => {
      const path = nativeDragPathRef.current;
      const idx = folderInsertIdx;
      nativeDragPathRef.current = null;
      setFolderInsertIdx(null);
      if (path !== null && idx !== null) {
        const beforeTab = tabs[idx];
        onFolderDrop(path, beforeTab?.id);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, onFolderDrop]);

  const isTabDrag  = (e: React.DragEvent) => e.dataTransfer.types.includes("application/x-tab-id");
  const isFolderDrag = (e: React.DragEvent) => e.dataTransfer.types.includes("application/x-filetree-folder-path");

  const clearAll = () => { setReorderInsertIdx(null); setFolderInsertIdx(null); };

  // Decide insertion index from drag position within the tab bar.
  const insertIdxFor = (e: React.DragEvent, tabIdx: number) => {
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const mid = rect.left + rect.width / 2;
    return e.clientX < mid ? tabIdx : tabIdx + 1;
  };

  const insertIdxForBar = (clientX: number) => {
    const bar = barRef.current;
    if (!bar) return tabs.length;
    const tabEls = Array.from(bar.querySelectorAll<HTMLElement>(".wtab:not(.wtab-ghost)"));
    let insertIdx = tabs.length;
    for (let i = 0; i < tabEls.length; i++) {
      const rect = tabEls[i].getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) { insertIdx = i; break; }
    }
    return insertIdx;
  };

  const folderPathFromDrag = (e: React.DragEvent) =>
    e.dataTransfer.getData("application/x-filetree-folder-path");

  return (
    <div
      ref={barRef}
      className="workspace-tabbar"
      onDragOver={(e) => {
        if (!isFolderDrag(e) || isTabDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        const insertIdx = insertIdxForBar(e.clientX);
        if (folderInsertIdx !== insertIdx) setFolderInsertIdx(insertIdx);
      }}
      onDragLeave={(e) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) clearAll();
      }}
      onDrop={(e) => {
        if (!isFolderDrag(e) || isTabDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        const path = folderPathFromDrag(e);
        const beforeTab = tabs[insertIdxForBar(e.clientX)];
        clearAll();
        if (path) onFolderDrop(path, beforeTab?.id);
      }}
    >
      {tabs.map((tab, idx) => {
        const isThisTabDragging = draggingTabIdRef.current === tab.id;
        // Reorder: show blue line BEFORE this tab
        const showReorderLine = reorderInsertIdx === idx;
        // Folder ghost: show ghost BEFORE this tab
        const showFolderGhost = folderInsertIdx === idx;

        return (
          <div key={tab.id} className="wtab-wrapper" style={{ display: "contents" }}>
            {showReorderLine && <div className="wtab-reorder-line" />}
            {showFolderGhost && (
              <div className="wtab wtab-ghost">
                <span className="wtab-label">New tab</span>
              </div>
            )}
            <div
              className={[
                "wtab",
                tab.id === activeId ? "wtab-active" : "",
                isThisTabDragging ? "wtab-dragging" : "",
              ].filter(Boolean).join(" ")}
              draggable
              onClick={() => { if (!isThisTabDragging) onActivate(tab.id); }}
              title={tab.path || "New tab"}
              onDragStart={(e) => {
                draggingTabIdRef.current = tab.id;
                e.dataTransfer.setData("application/x-tab-id", tab.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => { draggingTabIdRef.current = null; clearAll(); }}
              onDragOver={(e) => {
                if (isTabDrag(e)) {
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = "move";
                  const insertIdx = insertIdxFor(e, idx);
                  if (reorderInsertIdx !== insertIdx) setReorderInsertIdx(insertIdx);
                } else if (isFolderDrag(e)) {
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = "copy";
                  const insertIdx = insertIdxFor(e, idx);
                  if (folderInsertIdx !== insertIdx) setFolderInsertIdx(insertIdx);
                }
              }}
              onDragLeave={(e) => {
                if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
                  // Only clear if also leaving neighbours — let parent onDragLeave handle it
                }
              }}
              onDrop={(e) => {
                e.stopPropagation();
                if (isTabDrag(e)) {
                  const fromId = e.dataTransfer.getData("application/x-tab-id");
                  const insertIdx = insertIdxFor(e, idx);
                  clearAll();
                  draggingTabIdRef.current = null;
                  if (fromId && fromId !== tab.id) {
                    // Find the tab that will be at insertIdx after removal of fromId
                    const filtered = tabs.filter(t => t.id !== fromId);
                    const beforeTab = filtered[insertIdx > idx ? insertIdx - 1 : insertIdx];
                    onReorder(fromId, beforeTab?.id ?? tab.id);
                  }
                } else if (isFolderDrag(e)) {
                  e.preventDefault();
                  const path = folderPathFromDrag(e);
                  const insertIdx = insertIdxFor(e, idx);
                  clearAll();
                  const beforeTab = tabs[insertIdx];
                  if (path) onFolderDrop(path, beforeTab?.id);
                }
              }}
            >
              {tab.scanning && <span className="wtab-spinner" />}
              <span className="wtab-label">{tab.label || "New tab"}</span>
              {tabs.length > 1 && (
                <button
                  className="wtab-close"
                  title="Close tab"
                  onClick={(e2) => { e2.stopPropagation(); onClose(tab.id); }}
                >×</button>
              )}
            </div>
          </div>
        );
      })}

      {/* Reorder line / folder ghost at the END (after all tabs) */}
      {reorderInsertIdx === tabs.length && <div className="wtab-reorder-line" />}
      {folderInsertIdx === tabs.length && (
        <div className="wtab wtab-ghost">
          <span className="wtab-label">New tab</span>
        </div>
      )}

      {/* New tab button — also acts as a drop zone for folders */}
      <button
        className="wtab-new"
        onClick={onNew}
        title="New tab"
        onDragOver={(e) => {
          if (isFolderDrag(e)) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "copy"; if (folderInsertIdx !== tabs.length) setFolderInsertIdx(tabs.length); }
        }}
        onDrop={(e) => {
          if (isFolderDrag(e)) { e.preventDefault(); e.stopPropagation(); const path = folderPathFromDrag(e); clearAll(); if (path) onFolderDrop(path); }
        }}
      >+</button>
    </div>
  );
}

export type { WorkspaceTab };
