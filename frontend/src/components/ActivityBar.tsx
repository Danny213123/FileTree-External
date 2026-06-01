// Activity bar: a compact icon row at the top of the side bar that selects the
// active view. Icons come from the shared Bootstrap-based Icon set.
import { Icon, type IconName } from "./Icon";

export type ViewId = "explorer" | "search" | "treemap" | "duplicates" | "bookmarks" | "errors";

const ITEMS: { id: ViewId; label: string; icon: IconName }[] = [
  { id: "explorer", label: "Explorer", icon: "explorer" },
  { id: "search", label: "Search", icon: "search" },
  { id: "treemap", label: "Treemap", icon: "treemap" },
  { id: "duplicates", label: "Duplicates", icon: "duplicates" },
  { id: "bookmarks", label: "Bookmarks", icon: "bookmark" },
  { id: "errors", label: "Problems", icon: "warning" },
];

interface ActivityBarProps {
  activeView: ViewId;
  sidebarOpen: boolean;
  onSelect: (v: ViewId) => void;
  bookmarkCount: number;
  errorCount: number;
  darkMode: boolean;
  onToggleTheme: () => void;
}

export function ActivityBar({
  activeView, sidebarOpen, onSelect, bookmarkCount, errorCount,
  darkMode, onToggleTheme,
}: ActivityBarProps) {
  return (
    <div className="activitybar">
      {ITEMS.map((item) => {
        const isActive = sidebarOpen && activeView === item.id;
        const badge = item.id === "bookmarks" ? bookmarkCount : item.id === "errors" ? errorCount : 0;
        return (
          <button
            key={item.id}
            className={`activity-btn${isActive ? " active" : ""}`}
            title={item.label}
            onClick={() => onSelect(item.id)}
          >
            <Icon name={item.icon} />
            {badge > 0 && <span className={`activity-badge${item.id === "errors" ? " danger" : ""}`}>{badge > 99 ? "99+" : badge}</span>}
          </button>
        );
      })}
      <div className="spacer" />
      <button className="activity-btn" title={darkMode ? "Light theme" : "Dark theme"} onClick={onToggleTheme}>
        <Icon name={darkMode ? "sun" : "moon"} />
      </button>
    </div>
  );
}
