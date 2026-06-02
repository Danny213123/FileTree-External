import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

interface Segment {
  label: string;
  /** Full path this segment navigates to (drive roots include a trailing slash). */
  path: string;
}

// Split a Windows path into clickable breadcrumb segments, each carrying the
// absolute path it should navigate to. Handles drive letters ("C:" → "C:\")
// and UNC roots ("\\server\share") so clicking the first segment scans the
// volume/share root rather than a bogus partial path.
function buildSegments(fullPath: string): Segment[] {
  const trimmed = fullPath.replace(/[/\\]+$/, "");
  if (!trimmed) return [];
  const isUnc = /^[\\/]{2}/.test(fullPath);
  const parts = trimmed.split(/[/\\]+/).filter(Boolean);
  const segs: Segment[] = [];

  if (isUnc && parts.length > 0) {
    let acc = "\\\\" + parts[0];
    segs.push({ label: "\\\\" + parts[0], path: acc });
    for (let i = 1; i < parts.length; i++) {
      acc += "\\" + parts[i];
      segs.push({ label: parts[i], path: acc });
    }
    return segs;
  }

  let acc = "";
  for (let i = 0; i < parts.length; i++) {
    if (i === 0) {
      acc = parts[0];
      const isDrive = /^[a-zA-Z]:$/.test(parts[0]);
      segs.push({ label: parts[0], path: isDrive ? parts[0] + "\\" : parts[0] });
    } else {
      acc += "\\" + parts[i];
      segs.push({ label: parts[i], path: acc });
    }
  }
  return segs;
}

interface BreadcrumbProps {
  /** Current scanned/focused root path. */
  path: string;
  scanning: boolean;
  canBack: boolean;
  canForward: boolean;
  /** False at a drive/volume root (no parent), so the Up button is disabled
   *  like Back/Forward instead of being a silent no-op. */
  canUp: boolean;
  /** Navigate to (rescan as root) an arbitrary path — segment click or typed path. */
  onNavigate: (path: string) => void;
  onBack: () => void;
  onForward: () => void;
  onUp: () => void;
}

// Explorer-style address bar: Back / Forward / Up controls plus the current
// path as clickable segments. Clicking the empty track (or the "no folder"
// hint) switches to an editable input so a path can be typed directly.
export function Breadcrumb({ path, scanning, canBack, canForward, canUp, onNavigate, onBack, onForward, onUp }: BreadcrumbProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(path);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the draft synced to the live path while NOT editing (so navigation
  // elsewhere updates the box); leave it alone mid-edit so typing isn't lost.
  useEffect(() => { if (!editing) setDraft(path); }, [path, editing]);
  useEffect(() => {
    if (editing) { inputRef.current?.focus(); inputRef.current?.select(); }
  }, [editing]);

  const segments = buildSegments(path);

  const commit = () => {
    const value = draft.trim();
    setEditing(false);
    if (value && value !== path) onNavigate(value);
  };

  return (
    <div className="breadcrumb-bar">
      <div className="bc-nav">
        <button className="bc-btn" title="Back (Alt+Left)" disabled={!canBack} onClick={onBack} aria-label="Back">
          <Icon name="chevron-left" size={14} />
        </button>
        <button className="bc-btn" title="Forward (Alt+Right)" disabled={!canForward} onClick={onForward} aria-label="Forward">
          <Icon name="chevron-right" size={14} />
        </button>
        <button className="bc-btn" title="Up one level (Alt+Up)" disabled={!canUp} onClick={onUp} aria-label="Up one level">
          <Icon name="arrow-up" size={14} />
        </button>
      </div>

      {editing ? (
        <input
          ref={inputRef}
          className="bc-input"
          value={draft}
          spellCheck={false}
          placeholder="Enter a path…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") { setEditing(false); setDraft(path); }
          }}
          onBlur={() => { setEditing(false); setDraft(path); }}
        />
      ) : (
        <>
          <div
            className="bc-track"
            title="Click to edit path"
            onDoubleClick={() => setEditing(true)}
            onClick={(e) => { if (e.target === e.currentTarget) setEditing(true); }}
          >
            {segments.length === 0 ? (
              <span className="bc-empty" onClick={() => setEditing(true)}>No folder scanned — click to enter a path</span>
            ) : (
              segments.map((seg, i) => (
                <span className="bc-seg-wrap" key={seg.path}>
                  <button
                    className="bc-seg"
                    title={seg.path}
                    disabled={scanning}
                    onClick={() => onNavigate(seg.path)}
                  >
                    {seg.label}
                  </button>
                  {i < segments.length - 1 && <Icon name="chevron-right" size={10} className="bc-sep" />}
                </span>
              ))
            )}
          </div>
          {/* Explicit edit affordance — editing otherwise needs a double-click on
              the track. Focuses + selects the path input via the editing effect. */}
          <button
            className="bc-btn bc-edit"
            title="Edit path"
            aria-label="Edit path"
            onClick={() => setEditing(true)}
          >
            <Icon name="pencil-square" size={13} />
          </button>
        </>
      )}
    </div>
  );
}
