import { useState, useRef, useEffect, useMemo } from "react";
import { Icon } from "./Icon";

interface WorkspaceTab {
  id: string;
  label: string;
  path: string;
  scanning: boolean;
  /** #49 color label (hex) shown as an accent on the tab. */
  color?: string;
  /** #49 pinned tabs sort first and render compact/marked. */
  pinned?: boolean;
}

interface TabBarProps {
  /** Editor group this bar belongs to (used to route cross-group tab moves). */
  groupId: string;
  tabs: WorkspaceTab[];
  activeId: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  /**
   * Move `fromId` (from any group) into THIS bar's group, inserting it before
   * `beforeId` (append when omitted). Handles both intra-group reorder and
   * cross-group moves — App resolves the source group from the tab id.
   */
  onMoveTab: (fromId: string, toGroupId: string, beforeId?: string) => void;
  onFolderDrop: (path: string, beforeId?: string) => void;
  /** Split this group's active tab into a new pane (omit to hide the button). */
  onSplit?: () => void;
  /** Whether this group's controls toolbar (under the tabs) is currently shown. */
  toolbarVisible?: boolean;
  /** Toggle this group's controls toolbar visibility (omit to hide the button). */
  onToggleToolbar?: () => void;
  /** Allow closing the very last tab in this group (closes the pane). */
  canCloseLast?: boolean;
  // #49 Tab QoL actions (context menu + double-click rename).
  onRenameTab?: (id: string) => void;
  onResetTabName?: (id: string) => void;
  onSetTabColor?: (id: string, color: string) => void;
  onTogglePinTab?: (id: string) => void;
  /** Palette of color labels offered in the context menu. */
  tabColors?: string[];
}

interface TabMenuState { id: string; x: number; y: number; }

export function TabBar({ groupId, tabs, activeId, onActivate, onClose, onNew, onMoveTab, onFolderDrop, onSplit, toolbarVisible = true, onToggleToolbar, canCloseLast, onRenameTab, onResetTabName, onSetTabColor, onTogglePinTab, tabColors = [] }: TabBarProps) {
  const draggingTabIdRef = useRef<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const nativeDragPathRef = useRef<string | null>(null);
  // #49 right-click context menu (which tab + where).
  const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null);

  // Pinned tabs sort first (stable within each partition). Display-only — the
  // underlying id order (and drag reorder) is unchanged.
  const orderedTabs = useMemo(() => {
    const pinned = tabs.filter((t) => t.pinned);
    const rest = tabs.filter((t) => !t.pinned);
    return [...pinned, ...rest];
  }, [tabs]);

  // Dismiss the context menu on any outside click / Escape.
  useEffect(() => {
    if (!tabMenu) return;
    const close = () => setTabMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setTabMenu(null); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", onKey); };
  }, [tabMenu]);
  // Index before which to show reorder indicator
  const [reorderInsertIdx, setReorderInsertIdx] = useState<number | null>(null);
  // Index before which to show folder ghost (tabs.length = append at end)
  const [folderInsertIdx, setFolderInsertIdx] = useState<number | null>(null);

  // Listen for native drag move/end events from Electron main process.
  useEffect(() => {
    type EAPI = {
      onNativeDragMove?: (cb: (x: number, y: number, path: string) => void) => void | (() => void);
      onNativeDragEnd?: (cb: () => void) => void | (() => void);
    };
    const eAPI = (window as unknown as { electronAPI?: EAPI }).electronAPI;
    if (!eAPI?.onNativeDragMove) return;

    const unsubMove = eAPI.onNativeDragMove((cx, cy, dragPath) => {
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

    const unsubEnd = eAPI.onNativeDragEnd?.(() => {
      const path = nativeDragPathRef.current;
      const idx = folderInsertIdx;
      nativeDragPathRef.current = null;
      setFolderInsertIdx(null);
      if (path !== null && idx !== null) {
        const beforeTab = orderedTabs[idx];
        onFolderDrop(path, beforeTab?.id);
      }
    });

    // Remove exactly these listeners on each re-run / unmount so they don't
    // stack on every `tabs` change (multiplied across split panes).
    return () => {
      unsubMove?.();
      unsubEnd?.();
    };
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
      // Stable marker so a native folder drag (which carries no HTML5 MIME data)
      // can detect the tab strip by coordinates and open the folder in a new tab
      // of THIS group — see TreeTable's onNativeDropInternal handler.
      data-tabstrip="1"
      data-group-id={groupId}
      onDragOver={(e) => {
        // Tab drags that reach the bar (empty area, or a tab from another group)
        // show a reorder indicator; per-tab handlers stopPropagation for hovers
        // directly over a tab.
        if (isTabDrag(e)) {
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "move";
          const insertIdx = insertIdxForBar(e.clientX);
          if (reorderInsertIdx !== insertIdx) setReorderInsertIdx(insertIdx);
          return;
        }
        if (!isFolderDrag(e)) return;
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
        if (isTabDrag(e)) {
          e.preventDefault();
          e.stopPropagation();
          const fromId = e.dataTransfer.getData("application/x-tab-id");
          const beforeTab = orderedTabs[insertIdxForBar(e.clientX)];
          clearAll();
          draggingTabIdRef.current = null;
          if (fromId) onMoveTab(fromId, groupId, beforeTab?.id);
          return;
        }
        if (!isFolderDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        const path = folderPathFromDrag(e);
        const beforeTab = orderedTabs[insertIdxForBar(e.clientX)];
        clearAll();
        if (path) onFolderDrop(path, beforeTab?.id);
      }}
    >
      {orderedTabs.map((tab, idx) => {
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
                tab.pinned ? "wtab-pinned" : "",
                tab.color ? "wtab-colored" : "",
              ].filter(Boolean).join(" ")}
              // #49: color label as a left accent bar via a CSS variable.
              style={tab.color ? ({ ["--wtab-color" as string]: tab.color } as React.CSSProperties) : undefined}
              draggable
              onClick={() => { if (!isThisTabDragging) onActivate(tab.id); }}
              onDoubleClick={(e) => { e.stopPropagation(); onRenameTab?.(tab.id); }}
              onContextMenu={(e) => {
                if (!onRenameTab && !onSetTabColor && !onTogglePinTab) return;
                e.preventDefault();
                e.stopPropagation();
                setTabMenu({ id: tab.id, x: e.clientX, y: e.clientY });
              }}
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
                  // beforeId is the tab currently at insertIdx in THIS group's
                  // raw list; App removes fromId first, then inserts before it
                  // (works for both reorder and cross-group moves).
                  if (fromId) onMoveTab(fromId, groupId, orderedTabs[insertIdx]?.id);
                } else if (isFolderDrag(e)) {
                  e.preventDefault();
                  const path = folderPathFromDrag(e);
                  const insertIdx = insertIdxFor(e, idx);
                  clearAll();
                  const beforeTab = orderedTabs[insertIdx];
                  if (path) onFolderDrop(path, beforeTab?.id);
                }
              }}
            >
              {tab.pinned && <span className="wtab-pin" title="Pinned"><Icon name="star" size={10} /></span>}
              {tab.scanning && <span className="wtab-spinner" />}
              <span className="wtab-label">{tab.label || "New tab"}</span>
              {(tabs.length > 1 || canCloseLast) && (
                <button
                  className="wtab-close"
                  title="Close tab"
                  onClick={(e2) => { e2.stopPropagation(); onClose(tab.id); }}
                ><Icon name="x" size={12} /></button>
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
      ><Icon name="plus" size={14} /></button>

      <span className="wtab-spacer" />
      {(onToggleToolbar || onSplit) && (
        <div className="wtab-actions">
          {onToggleToolbar && (
            <button
              className={`wtab-new wtab-toolbar-toggle${toolbarVisible ? "" : " active"}`}
              onClick={onToggleToolbar}
              title={toolbarVisible ? "Hide toolbar" : "Show toolbar"}
              aria-pressed={!toolbarVisible}
            >
              <Icon name="window" size={14} />
            </button>
          )}
          {onSplit && (
            <button className="wtab-new wtab-split" onClick={onSplit} title="Split editor right">
              <Icon name="layout-split" size={14} />
            </button>
          )}
        </div>
      )}

      {tabMenu && (() => {
        const t = tabs.find((x) => x.id === tabMenu.id);
        if (!t) return null;
        return (
          <div
            className="wtab-context-menu"
            style={{ left: tabMenu.x, top: tabMenu.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {onRenameTab && (
              <div className="wtab-ctx-item" onClick={() => { setTabMenu(null); onRenameTab(t.id); }}>Rename…</div>
            )}
            {onResetTabName && (
              <div className="wtab-ctx-item" onClick={() => { setTabMenu(null); onResetTabName(t.id); }}>Use Folder Name</div>
            )}
            {onTogglePinTab && (
              <div className="wtab-ctx-item" onClick={() => { setTabMenu(null); onTogglePinTab(t.id); }}>{t.pinned ? "Unpin Tab" : "Pin Tab"}</div>
            )}
            {onSetTabColor && (
              <>
                <div className="wtab-ctx-sep" />
                <div className="wtab-ctx-colors">
                  <button
                    className={`wtab-ctx-swatch wtab-ctx-none${!t.color ? " active" : ""}`}
                    title="No color"
                    onClick={() => { setTabMenu(null); onSetTabColor(t.id, ""); }}
                  ><Icon name="x" size={10} /></button>
                  {tabColors.map((c) => (
                    <button
                      key={c}
                      className={`wtab-ctx-swatch${t.color?.toLowerCase() === c.toLowerCase() ? " active" : ""}`}
                      style={{ background: c }}
                      title={c}
                      onClick={() => { setTabMenu(null); onSetTabColor(t.id, c); }}
                    />
                  ))}
                </div>
              </>
            )}
            <div className="wtab-ctx-sep" />
            <div className="wtab-ctx-item" onClick={() => { setTabMenu(null); onNew(); }}>New Tab</div>
            {(tabs.length > 1 || canCloseLast) && (
              <div className="wtab-ctx-item" onClick={() => { setTabMenu(null); onClose(t.id); }}>Close Tab</div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

export type { WorkspaceTab };
