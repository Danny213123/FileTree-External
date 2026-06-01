import { useState, useRef, useEffect } from "react";
import { Icon } from "./Icon";
import type { ChatSessionMeta } from "../lib/chatSessions";
import type { SortKey, Unit } from "../api/types";
import { ColumnsMenuContent, FixedDropdown } from "./ConfigureColumnsMenu";

export interface MenuItem {
  label?: string;
  kbd?: string;
  onClick?: () => void;
  separator?: boolean;
  checked?: boolean;
  disabled?: boolean;
  /** Open the shared Configure Columns popup instead of running `onClick`. */
  opensColumns?: boolean;
}

export interface Menu {
  label: string;
  items: MenuItem[];
}

interface TitleBarProps {
  title: string;
  menus: Menu[];
  // Left cluster
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onPrevTab: () => void;
  onNextTab: () => void;
  canPrevTab: boolean;
  canNextTab: boolean;
  // Panel toggles
  terminalOpen: boolean;
  onToggleTerminal: () => void;
  // Right cluster (AI assistant / agent)
  chatOpen: boolean;
  onToggleChat: () => void;
  onOpenAgents: () => void;
  onNewSession: () => void;
  onCloseChat: () => void;
  getSessions: () => ChatSessionMeta[];
  onRestoreSession: (id: string) => void;
  optionsMenu: MenuItem[];
  // Configure Columns popup (View ▸ Configure Columns) — shares global details-
  // list prefs with the editor-toolbar control. `unit` is the active tab's unit.
  visibleColumns: Set<SortKey>;
  onVisibleColumnsChange: (cols: Set<SortKey>) => void;
  decimals: number;
  onDecimalsChange: (d: number) => void;
  unit: Unit;
  onUnitChange: (u: Unit) => void;
}

type Pop = "options" | "history" | null;

function relTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function TitleBar({
  title, menus,
  sidebarOpen, onToggleSidebar, onPrevTab, onNextTab, canPrevTab, canNextTab,
  terminalOpen, onToggleTerminal,
  chatOpen, onToggleChat, onOpenAgents, onNewSession, onCloseChat,
  getSessions, onRestoreSession, optionsMenu,
  visibleColumns, onVisibleColumnsChange, decimals, onDecimalsChange, unit, onUnitChange,
}: TitleBarProps) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [pop, setPop] = useState<Pop>(null);
  const [sessions, setSessions] = useState<ChatSessionMeta[]>([]);
  const [colCfgOpen, setColCfgOpen] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  // Anchor for the Configure Columns popup — the `.vsc-menu` container of the
  // menu whose items include `opensColumns` (the View menu). Anchoring to the
  // container (not the button) keeps the fixed popup a DOM descendant of the
  // anchor, so clicks inside it don't count as "outside" and dismiss it.
  const colAnchorRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (openIdx === null && pop === null) return;
    const onDown = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) {
        setOpenIdx(null);
        setPop(null);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [openIdx, pop]);

  const toggleHistory = () => {
    setOpenIdx(null);
    if (pop === "history") { setPop(null); return; }
    setSessions(getSessions());
    setPop("history");
  };
  const toggleOptions = () => {
    setOpenIdx(null);
    setPop(pop === "options" ? null : "options");
  };

  return (
    <div className="vsc-titlebar" ref={barRef}>
      <Icon name="folder" size={16} className="vsc-titlebar-logo" />
      <div className="vsc-menubar">
        {menus.map((menu, idx) => {
          const hasColumns = menu.items.some((it) => it.opensColumns);
          return (
          <div
            key={menu.label}
            className={`vsc-menu${openIdx === idx ? " open" : ""}`}
            ref={hasColumns ? (el) => { colAnchorRef.current = el; } : undefined}
          >
            <button
              className="vsc-menu-btn"
              onClick={() => { setPop(null); setColCfgOpen(false); setOpenIdx(openIdx === idx ? null : idx); }}
              onMouseEnter={() => { if (openIdx !== null) setOpenIdx(idx); }}
            >
              {menu.label}
            </button>
            {openIdx === idx && (
              <div className="vsc-menu-dropdown">
                {menu.items.map((item, i) =>
                  item.separator ? (
                    <div key={i} className="vsc-menu-sep" />
                  ) : (
                    <div
                      key={i}
                      className={`vsc-menu-item${item.disabled ? " disabled" : ""}${item.checked ? " checked" : ""}`}
                      onClick={() => {
                        if (item.disabled) return;
                        setOpenIdx(null);
                        if (item.opensColumns) { setColCfgOpen(true); return; }
                        item.onClick?.();
                      }}
                    >
                      <span>{item.label}</span>
                      {item.kbd && <span className="vsc-menu-kbd">{item.kbd}</span>}
                    </div>
                  )
                )}
              </div>
            )}
            {hasColumns && (
              <FixedDropdown anchorRef={colAnchorRef} open={colCfgOpen} onClose={() => setColCfgOpen(false)}>
                <ColumnsMenuContent
                  visibleColumns={visibleColumns}
                  onVisibleColumnsChange={onVisibleColumnsChange}
                  decimals={decimals}
                  onDecimalsChange={onDecimalsChange}
                  unit={unit}
                  onUnitChange={onUnitChange}
                  onRequestClose={() => setColCfgOpen(false)}
                />
              </FixedDropdown>
            )}
          </div>
          );
        })}
      </div>

      {/* Left controls: collapse side bar + move between tabs */}
      <div className="titlebar-actions">
        <button
          className={`titlebar-btn${sidebarOpen ? " active" : ""}`}
          title="Toggle left panel (Ctrl+B)"
          onClick={onToggleSidebar}
        >
          <Icon name="layout-sidebar" size={15} />
        </button>
        <span className="titlebar-navgroup">
          <button className="titlebar-btn" title="Previous tab" onClick={onPrevTab} disabled={!canPrevTab}>
            <Icon name="chevron-left" size={13} />
          </button>
          <button className="titlebar-btn" title="Next tab" onClick={onNextTab} disabled={!canNextTab}>
            <Icon name="chevron-right" size={13} />
          </button>
        </span>
        <button
          className={`titlebar-btn${terminalOpen ? " active" : ""}`}
          title="Toggle terminal (Ctrl+`)"
          onClick={onToggleTerminal}
        >
          <Icon name="terminal" size={15} />
        </button>
      </div>

      <div className="titlebar-spacer" />
      <div className="vsc-titlebar-title">{title}</div>

      {/* Right controls: chat / agents / sessions / options / collapse */}
      <div className="titlebar-actions right">
        <button
          className={`titlebar-btn${chatOpen ? " active" : ""}`}
          title="Open chat (Ctrl+Alt+B)"
          onClick={onToggleChat}
        >
          <Icon name="chat" size={15} />
        </button>
        <button className="titlebar-btn" title="Open AI Assistant" onClick={onOpenAgents}>
          <Icon name="window-stack" size={15} />
        </button>
        <button className="titlebar-btn" title="New agent session" onClick={onNewSession}>
          <Icon name="plus" size={16} />
        </button>

        <div className="titlebar-pop">
          <button
            className={`titlebar-btn${pop === "history" ? " active" : ""}`}
            title="Session history"
            onClick={toggleHistory}
          >
            <Icon name="clock-history" size={15} />
          </button>
          {pop === "history" && (
            <div className="titlebar-dropdown history">
              <div className="titlebar-dropdown-title">Session history</div>
              {sessions.length === 0 ? (
                <div className="titlebar-dropdown-empty">No saved sessions yet</div>
              ) : (
                sessions.map((s) => (
                  <div
                    key={s.id}
                    className="titlebar-session"
                    title={s.title}
                    onClick={() => { setPop(null); onRestoreSession(s.id); }}
                  >
                    <Icon name="chat" size={13} />
                    <span className="t">{s.title || "New chat"}</span>
                    <span className="m">{relTime(s.ts)}</span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        <div className="titlebar-pop">
          <button
            className={`titlebar-btn${pop === "options" ? " active" : ""}`}
            title="Options"
            onClick={toggleOptions}
          >
            <Icon name="three-dots" size={15} />
          </button>
          {pop === "options" && (
            <div className="vsc-menu-dropdown titlebar-dropdown options">
              {optionsMenu.map((item, i) =>
                item.separator ? (
                  <div key={i} className="vsc-menu-sep" />
                ) : (
                  <div
                    key={i}
                    className={`vsc-menu-item${item.disabled ? " disabled" : ""}${item.checked ? " checked" : ""}`}
                    onClick={() => {
                      if (item.disabled) return;
                      setPop(null);
                      item.onClick?.();
                    }}
                  >
                    <span>{item.label}</span>
                    {item.kbd && <span className="vsc-menu-kbd">{item.kbd}</span>}
                  </div>
                )
              )}
            </div>
          )}
        </div>

        <button className="titlebar-btn" title="Collapse right panel" onClick={onCloseChat}>
          <Icon name="layout-sidebar-reverse" size={15} />
        </button>
      </div>
    </div>
  );
}
