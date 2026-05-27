import { useEffect, useRef, useState } from "react";
import type { NodeRecord, Unit } from "../api/types";
import { formatBytes, formatCount } from "../utils/formatBytes";
import { formatDate } from "../utils/formatDate";

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "tif", "tiff", "avif", "heic"]);
const VIDEO_EXTS = new Set(["mp4", "mkv", "mov", "avi", "wmv", "webm", "m4v", "flv"]);

function isImage(ext: string) { return IMAGE_EXTS.has(ext.toLowerCase()); }
function isVideo(ext: string) { return VIDEO_EXTS.has(ext.toLowerCase()); }

interface Props {
  node: NodeRecord;
  unit: Unit;
  anchorX: number;
  anchorY: number;
}

// VideoThumb: captures a frame from a video at 2s using canvas
function VideoThumb({ path }: { path: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onLoaded = () => {
      // Seek to 2s or 10% into the video, whichever is smaller
      video.currentTime = Math.min(2, video.duration * 0.1);
    };
    const onSeeked = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = video.videoWidth || 240;
      canvas.height = video.videoHeight || 135;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      setDataUrl(canvas.toDataURL("image/jpeg", 0.8));
    };

    video.addEventListener("loadedmetadata", onLoaded);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", () => setFailed(true));

    return () => {
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("seeked", onSeeked);
    };
  }, [path]);

  if (failed) return null;

  return (
    <>
      {/* Hidden video element for frame extraction */}
      <video
        ref={videoRef}
        src={`/api/thumbnail?path=${encodeURIComponent(path)}`}
        preload="metadata"
        muted
        crossOrigin="anonymous"
        style={{ display: "none" }}
      />
      <canvas ref={canvasRef} style={{ display: "none" }} />
      {dataUrl && (
        <img src={dataUrl} alt="" style={{ maxWidth: "100%", maxHeight: 320, display: "block" }} />
      )}
    </>
  );
}

export function NodeTooltip({ node, unit, anchorX, anchorY }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchorX + 16, top: anchorY + 8 });
  const ext = (node.extension ?? "").toLowerCase();
  const showImage = !node.dir && isImage(ext) && !!node.path;
  const showVideo = !node.dir && isVideo(ext) && !!node.path;
  const [thumbLoaded, setThumbLoaded] = useState(false);
  const [thumbError, setThumbError] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rect = el.getBoundingClientRect();
    let left = anchorX + 16;
    let top = anchorY + 8;
    if (left + rect.width > vw - 8) left = anchorX - rect.width - 8;
    if (top + rect.height > vh - 8) top = anchorY - rect.height - 8;
    setPos({ left, top });
  }, [anchorX, anchorY, thumbLoaded, thumbError]);

  return (
    <div
      ref={ref}
      className="node-tooltip"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="node-tooltip-name">{node.name}</div>

      {showImage && !thumbError && (
        <div className="node-tooltip-thumb">
          <img
            src={`/api/thumbnail?path=${encodeURIComponent(node.path)}`}
            alt=""
            onLoad={() => setThumbLoaded(true)}
            onError={() => setThumbError(true)}
          />
        </div>
      )}

      {showVideo && (
        <div className="node-tooltip-thumb">
          <VideoThumb path={node.path} />
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
