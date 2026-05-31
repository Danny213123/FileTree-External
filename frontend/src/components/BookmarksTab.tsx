import type { DriveEntry } from "../api/types";
import { Icon } from "./Icon";

interface BookmarksTabProps {
  bookmarks: string[];
  drives: DriveEntry[];
  onOpenLocation: (path: string) => void;
  onRemove: (path: string) => void;
}

// The drive / share a path lives on, used to group the quicklinks.
function driveKeyOf(path: string): string {
  const drive = path.match(/^[A-Za-z]:/);
  if (drive) return drive[0].toUpperCase();
  const unc = path.match(/^\\\\[^\\/]+/);
  if (unc) return unc[0];
  const seg = path.split(/[/\\]/).filter(Boolean)[0];
  return seg || path;
}

function baseName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() || path;
}

export function BookmarksTab({ bookmarks, drives, onOpenLocation, onRemove }: BookmarksTabProps) {
  if (bookmarks.length === 0) {
    return (
      <div className="empty">
        No bookmarks yet — click the star on any folder or file in the tree to add one.
      </div>
    );
  }

  const labelFor = (key: string): string => {
    const match = drives.find((d) => driveKeyOf(d.root) === key);
    if (match && match.label) return `${match.label} (${key})`;
    if (key.startsWith("\\\\")) return key;
    return key;
  };

  // Group bookmarks by drive, then sort the groups and the links within them.
  const groups = new Map<string, string[]>();
  for (const b of bookmarks) {
    const key = driveKeyOf(b);
    const list = groups.get(key);
    if (list) list.push(b);
    else groups.set(key, [b]);
  }
  const sortedKeys = [...groups.keys()].sort((a, b) => a.localeCompare(b));

  return (
    <div className="bookmarks-quicklinks">
      {sortedKeys.map((key) => {
        const items = groups.get(key)!
          .slice()
          .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        return (
          <div key={key} className="bm-group">
            <div className="bm-group-title">
              <Icon name="hdd" size={13} />
              <span>{labelFor(key)}</span>
            </div>
            {items.map((path) => (
              <div key={path} className="bm-link" title={path}>
                <button className="bm-link-open" onClick={() => onOpenLocation(path)}>
                  <Icon name="folder" size={14} className="bm-link-folder" />
                  <span className="bm-link-name">{baseName(path)}</span>
                  <span className="bm-link-path">{path}</span>
                </button>
                <button className="bm-link-remove" title="Remove bookmark" onClick={() => onRemove(path)}>
                  <Icon name="star-fill" size={12} />
                </button>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
