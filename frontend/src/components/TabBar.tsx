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
}

export function TabBar({ tabs, activeId, onActivate, onClose, onNew }: TabBarProps) {
  return (
    <div className="workspace-tabbar">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`wtab${tab.id === activeId ? " wtab-active" : ""}`}
          onClick={() => onActivate(tab.id)}
          title={tab.path || "New tab"}
        >
          {tab.scanning && <span className="wtab-spinner" />}
          <span className="wtab-label">{tab.label || "New tab"}</span>
          {tabs.length > 1 && (
            <button
              className="wtab-close"
              title="Close tab"
              onClick={(e) => { e.stopPropagation(); onClose(tab.id); }}
            >
              ×
            </button>
          )}
        </div>
      ))}
      <button className="wtab-new" onClick={onNew} title="New tab">+</button>
    </div>
  );
}

export type { WorkspaceTab };
