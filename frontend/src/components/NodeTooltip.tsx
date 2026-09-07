import { useEffect, useRef, useState } from "react";
import type { NodeRecord, Unit } from "../api/types";
import { formatBytes, formatCount } from "../utils/formatBytes";
import { formatDate } from "../utils/formatDate";
import { isImage, isVideo } from "../lib/thumbs";
import { localPoint, localRect, localViewport } from "../lib/overlay";
import { ShellThumbnail } from "./ShellThumbnail";

interface Props {
  node: NodeRecord;
  unit: Unit;
  anchorX: number;
  anchorY: number;
  /** Explicit thumbnail source path (e.g. a folder's representative media).
   *  When set it takes precedence over the node's own file thumbnail, enabling
   *  folder thumbnails in the hover card. */
  thumbPath?: string;
}

export function NodeTooltip({ node, unit, anchorX, anchorY, thumbPath }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchorX + 16, top: anchorY + 8 });
  const ext = (node.extension ?? "").toLowerCase();
  // Both images and videos are served as image/png from the server-side thumbnail route.
  const showThumb = !node.dir && (isImage(ext) || isVideo(ext)) && !!node.path;
  // A folder passes an explicit thumbPath (representative media beneath it); a
  // media file falls back to its own path. Whichever resolves drives the <img>.
  const effectiveThumb = thumbPath ?? (showThumb ? node.path : undefined);
  const [thumbLoaded, setThumbLoaded] = useState(false);
  const [thumbError, setThumbError] = useState(false);

  useEffect(() => {
    setThumbLoaded(false);
    setThumbError(false);
  }, [effectiveThumb, node.path]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Local (zoom-relative) space: the cursor and the measured box arrive in
    // viewport pixels, but `pos` is applied as an inline offset inside the
    // zoomed shell. See lib/overlay.ts.
    const view = localViewport();
    const rect = localRect(el);
    const { x: ax, y: ay } = localPoint(anchorX, anchorY);
    let left = ax + 16;
    let top = ay + 8;
    if (left + rect.width > view.width - 8) left = ax - rect.width - 8;
    if (top + rect.height > view.height - 8) top = ay - rect.height - 8;
    setPos({ left, top });
  }, [anchorX, anchorY, thumbLoaded, thumbError]);

  return (
    <div
      ref={ref}
      className="node-tooltip"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="node-tooltip-name">{node.name}</div>

      {effectiveThumb && !thumbError && (
        <div className="node-tooltip-thumb">
          <ShellThumbnail
            key={effectiveThumb}
            path={effectiveThumb}
            alt=""
            onLoad={() => setThumbLoaded(true)}
            onUnavailable={() => setThumbError(true)}
            style={{ maxWidth: "100%", maxHeight: 320, display: "block" }}
          />
        </div>
      )}

      <div className="node-tooltip-stats">
        <div className="nts-row">
          <span>Type</span>
          <span>{node.dir ? "Folder" : (ext ? `.${ext}` : "File")}</span>
        </div>
        <div className="nts-row"><span>Size</span><span>{formatBytes(node.size, unit)}</span></div>
        {node.dir && <div className="nts-row"><span>Files</span><span>{formatCount(node.files)}</span></div>}
        {node.dir && <div className="nts-row"><span>Folders</span><span>{formatCount(node.folders)}</span></div>}
        {node.modified > 0 && <div className="nts-row"><span>Modified</span><span>{formatDate(node.modified)}</span></div>}
        {node.errors > 0 && <div className="nts-row nts-error"><span>Errors</span><span>{node.errors}</span></div>}
      </div>
    </div>
  );
}
