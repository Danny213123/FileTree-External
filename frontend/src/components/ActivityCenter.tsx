// Activity center bell + panel (#48).
//
// A self-contained status-bar control: a bell button with an unread badge that
// opens a panel listing recent events (icon, message, relative time, type),
// with clear-all. It subscribes to the activity store directly so it re-renders
// only on new events — App never re-renders for it.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon, type IconName } from "./Icon";
import {
  subscribeActivity,
  getActivitySnapshot,
  getUnreadCount,
  markActivityRead,
  clearActivity,
  type ActivityType,
} from "../lib/activity";

const TYPE_ICON: Record<ActivityType, IconName> = {
  success: "check",
  warn: "warning",
  error: "warning",
  info: "info-circle",
};

function relTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function ActivityCenter() {
  const entries = useSyncExternalStore(subscribeActivity, getActivitySnapshot, getActivitySnapshot);
  const unread = useSyncExternalStore(subscribeActivity, getUnreadCount, getUnreadCount);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    markActivityRead();
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const recent = [...entries].reverse();

  return (
    <div className="activity-center" ref={rootRef}>
      <button
        className={`sb-item activity-bell${open ? " active" : ""}`}
        title="Activity"
        aria-label={unread > 0 ? `Activity (${unread} new)` : "Activity"}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="bell" size={13} />
        {unread > 0 && <span className="activity-badge">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div className="activity-panel" role="dialog" aria-label="Activity">
          <div className="activity-panel-head">
            <span>Activity</span>
            <button
              className="activity-clear"
              onClick={clearActivity}
              disabled={entries.length === 0}
              title="Clear all"
            >
              Clear all
            </button>
          </div>
          <div className="activity-list">
            {recent.length === 0 ? (
              <div className="activity-empty">No activity yet</div>
            ) : (
              recent.map((e) => (
                <div key={e.id} className={`activity-item activity-${e.type}`}>
                  <span className="activity-icon"><Icon name={TYPE_ICON[e.type]} size={13} /></span>
                  <span className="activity-msg" title={e.message}>{e.message}</span>
                  <span className="activity-time">{relTime(e.ts)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
