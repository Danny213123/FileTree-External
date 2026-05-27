interface PathBarProps {
  path: string;
  onPathChange: (p: string) => void;
  onScan: () => void;
  onCancel: () => void;
  scanning: boolean;
  roots: string[];
}

export function PathBar({
  path,
  onPathChange,
  onScan,
  onCancel,
  scanning,
  roots,
}: PathBarProps) {
  return (
    <div className="topbar">
      <div className="brand">
        <div className="brand-mark" />
        <div>
          <strong>FileTree</strong>
          <span>Disk Usage Explorer</span>
        </div>
      </div>

      <div className="pathbar">
        <input
          className="path-input"
          type="text"
          value={path}
          onChange={(e) => onPathChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !scanning && onScan()}
          placeholder="Enter path to scan…"
          spellCheck={false}
        />
        <button
          className="primary"
          onClick={onScan}
          disabled={scanning || !path.trim()}
        >
          {scanning ? "Scanning…" : "Scan"}
        </button>
        {scanning ? (
          <button onClick={onCancel}>Cancel</button>
        ) : (
          <button onClick={onScan} disabled={!path.trim()}>
            Refresh
          </button>
        )}
      </div>

      <div className="top-actions">
        {roots.map((r) => (
          <button key={r} onClick={() => { onPathChange(r); onScan(); }}>
            {r}
          </button>
        ))}
      </div>
    </div>
  );
}
