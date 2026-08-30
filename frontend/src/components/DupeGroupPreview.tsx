import { useEffect, useState } from "react";
import type { DupeFileV2, DupeGroupV2 } from "../api/types";
import { formatBytes } from "../utils/formatBytes";
import { formatDate } from "../utils/formatDate";
import { openPath, revealPath } from "../api/client";
import { Icon } from "./Icon";
import { FileIcon } from "./FileIcon";
import { ShellThumbnail } from "./ShellThumbnail";

// #25 Duplicate group preview: a lightweight side-by-side look at every member
// of a duplicate group before deleting/linking. Reuses the existing preview
// machinery — the bounded Windows Shell thumbnail cache for images/videos and
// `FileIcon` for everything else — so the user can visually confirm the copies match.

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "tif", "tiff", "avif", "heic", "ico"]);
const VIDEO_EXTS = new Set(["mp4", "mkv", "mov", "avi", "wmv", "webm", "m4v", "flv"]);

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function folderOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return idx >= 0 ? path.slice(0, idx) : "";
}

function MemberThumb({ file }: { file: DupeFileV2 }) {
  const ext = extOf(file.name);
  const isMedia = IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext);
  const [error, setError] = useState(false);
  useEffect(() => { setError(false); }, [file.path]);

  if (isMedia && !error) {
    return (
      <div className="dgp-thumb">
        <ShellThumbnail
          path={file.path}
          alt={file.name}
          onUnavailable={() => setError(true)}
        />
      </div>
    );
  }
  return (
    <div className="dgp-thumb dgp-thumb-icon">
      <FileIcon ext={ext} path={file.path} isDir={false} isBundle={false} />
    </div>
  );
}

export function DupeGroupPreview({ group, onClose }: { group: DupeGroupV2; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="dgp-overlay" onMouseDown={onClose}>
      <div className="dgp-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dgp-head">
          <span>Preview group · {group.files.length} copies</span>
          <button className="inspector-x" title="Close (Esc)" onClick={onClose} aria-label="Close preview">
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="dgp-body">
          {group.files.map((f) => (
            <div key={f.path} className={`dgp-card${f.ref ? " dgp-card-ref" : ""}`}>
              <MemberThumb file={f} />
              <div className="dgp-meta">
                <div className="dgp-name" title={f.path}>
                  {f.ref ? <Icon name="star-fill" size={11} /> : <Icon name="duplicates" size={11} />} {f.name}
                </div>
                <div className="dgp-sub">{formatBytes(f.size, "auto")} · {f.modified > 0 ? formatDate(f.modified * 1000) : "—"}</div>
                <div className="dgp-folder" title={f.path}>{folderOf(f.path)}</div>
                <div className="dgp-actions">
                  <button onClick={() => void openPath(f.path)}>Open</button>
                  <button onClick={() => void revealPath(f.path)}>Reveal</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
