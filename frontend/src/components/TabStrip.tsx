export type TabId = "chart" | "details" | "extensions" | "age" | "top" | "duplicates" | "errors" | "bookmarks" | "ai";

// 14×14 inline SVG icons for each tab
function IcoChart() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
      <rect x="1" y="6" width="3" height="7" rx="0.5" />
      <rect x="5.5" y="3" width="3" height="10" rx="0.5" />
      <rect x="10" y="0.5" width="3" height="12.5" rx="0.5" />
    </svg>
  );
}
function IcoDetails() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
      <rect x="1" y="2" width="12" height="1.5" rx="0.5" />
      <rect x="1" y="5.5" width="12" height="1.5" rx="0.5" />
      <rect x="1" y="9" width="8" height="1.5" rx="0.5" />
    </svg>
  );
}
function IcoExtensions() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
      <polygon points="7,1 13,4.5 13,9.5 7,13 1,9.5 1,4.5" />
    </svg>
  );
}
function IcoAge() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
      <circle cx="7" cy="7" r="5.5" />
      <line x1="7" y1="7" x2="7" y2="3" />
      <line x1="7" y1="7" x2="10" y2="7" />
    </svg>
  );
}
function IcoTop() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
      <path d="M7 1 L10.5 6 H7.8 V13 H6.2 V6 H3.5 Z" />
    </svg>
  );
}
function IcoDuplicates() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="4" y="1" width="8" height="9" rx="1" />
      <rect x="1" y="4" width="8" height="9" rx="1" fill="var(--bg,#fff)" />
      <rect x="1" y="4" width="8" height="9" rx="1" />
    </svg>
  );
}
function IcoErrors() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
      <path d="M7 1 L13 12 H1 Z" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <rect x="6.3" y="5" width="1.4" height="4" rx="0.5" />
      <circle cx="7" cy="10.5" r="0.8" />
    </svg>
  );
}
function IcoBookmarks() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
      <path d="M3 1 H11 V13 L7 10 L3 13 Z" />
    </svg>
  );
}
function IcoAi() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
      <circle cx="7" cy="7" r="3" />
      <line x1="7" y1="1" x2="7" y2="3" />
      <line x1="7" y1="11" x2="7" y2="13" />
      <line x1="1" y1="7" x2="3" y2="7" />
      <line x1="11" y1="7" x2="13" y2="7" />
    </svg>
  );
}

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: "details",    label: "Details",      icon: <IcoDetails /> },
  { id: "extensions", label: "Extensions",   icon: <IcoExtensions /> },
  { id: "age",        label: "Age of Files", icon: <IcoAge /> },
  { id: "top",        label: "Top Files",    icon: <IcoTop /> },
  { id: "duplicates", label: "Duplicates",   icon: <IcoDuplicates /> },
  { id: "errors",     label: "Errors",       icon: <IcoErrors /> },
  { id: "bookmarks",  label: "Bookmarks",    icon: <IcoBookmarks /> },
  { id: "ai",         label: "AI",           icon: <IcoAi /> },
];

interface TabStripProps {
  active: TabId;
  onChange: (id: TabId) => void;
  errorCount: number;
  bookmarkCount: number;
}

export function TabStrip({ active, onChange, errorCount, bookmarkCount }: TabStripProps) {
  return (
    <div className="tabs">
      {/* Chart toggle opens/closes the full-width bottom chart panel */}
      <button
        className={active === "chart" ? "active" : ""}
        onClick={() => onChange(active === "chart" ? "details" : "chart")}
        title="Toggle chart panel"
      >
        <span className="tab-icon"><IcoChart /></span>
        Chart
      </button>
      {TABS.map((tab) => (
        <button
          key={tab.id}
          className={active === tab.id ? "active" : ""}
          onClick={() => onChange(tab.id)}
        >
          <span className="tab-icon">{tab.icon}</span>
          {tab.label}
          {tab.id === "errors" && errorCount > 0 && (
            <span className="tab-badge">{errorCount}</span>
          )}
          {tab.id === "bookmarks" && bookmarkCount > 0 && (
            <span className="tab-badge" style={{ background: "#c8920a" }}>{bookmarkCount}</span>
          )}
        </button>
      ))}
    </div>
  );
}
