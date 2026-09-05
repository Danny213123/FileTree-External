import { useEffect, useRef, useState } from "react";
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
      <FileIcon ext={ext} isDir={false} isBundle={false} />
    </div>
  );
}

interface DupeGroupPreviewProps {
  group: DupeGroupV2;
  selected: Set<string>;
  onToggle: (path: string) => void;
  onKeep: (path: string) => void;
  onClose: () => void;
  disabled?: boolean;
}

export function DupeGroupPreview({
  group,
  selected,
  onToggle,
  onKeep,
  onClose,
  disabled = false,
}: DupeGroupPreviewProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const hasProtectedKeeper = group.files.some((file) => file.protected);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )];
      if (focusable.length === 0) {
        e.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!panelRef.current.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (active === first || active === panelRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previouslyFocused?.focus();
    };
  }, []);

  return (
    <div className="dgp-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className="dgp-panel"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dgp-title"
        tabIndex={-1}
      >
        <div className="dgp-head">
          <span id="dgp-title">Compare copies</span>
          <span className="dgp-head-meta">{group.files.length} files · {formatBytes(group.waste, "auto")} reclaimable</span>
          <button className="inspector-x" title="Close (Esc)" onClick={onClose} aria-label="Close preview">
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="dgp-body">
          {group.files.map((f) => (
            <div
              key={f.path}
              className={`dgp-card${f.ref ? " dgp-card-ref" : ""}${f.protected ? " dgp-card-protected" : ""}${selected.has(f.path) ? " dgp-card-selected" : ""}`}
            >
              <MemberThumb file={f} />
              <div className="dgp-meta">
                <div className={`dgp-role${f.protected ? " protected" : f.ref ? " keeper" : " copy"}`}>
                  {f.protected ? <><Icon name="bookmark" size={10} /> Protected</> : f.ref ? <><Icon name="star-fill" size={10} /> Keeper</> : "Actionable copy"}
                </div>
                <div className="dgp-name" title={f.path}>
                  {f.name}
                </div>
                <div className="dgp-sub">{formatBytes(f.size, "auto")} · {f.modified > 0 ? formatDate(f.modified * 1000) : "—"}</div>
                <div className="dgp-folder" title={f.path}>{folderOf(f.path)}</div>
                <div className="dgp-actions">
                  <button onClick={() => void openPath(f.path)}>Open</button>
                  <button onClick={() => void revealPath(f.path)}>Reveal</button>
                  {!f.ref && !hasProtectedKeeper && (
                    <button className="dgp-keep" onClick={() => onKeep(f.path)} disabled={disabled}>Keep this copy</button>
                  )}
                  {!f.ref && !f.protected && (
                    <label className="dgp-select">
                      <input
                        type="checkbox"
                        checked={selected.has(f.path)}
                        disabled={disabled}
                        onChange={() => onToggle(f.path)}
                      />
                      Select for action
                    </label>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
