import { useEffect, useState } from "react";
import { loadShellIcon } from "../lib/shellImages";

// Module-level: tracks extensions whose shell icon fetch failed so virtualized
// row recreation does not repeatedly ask Windows for an unavailable icon.
const ICON_FAILED = new Set<string>();

interface FileIconProps {
  ext: string;
  isDir: boolean;
  isBundle: boolean;
  onMouseEnter?: (e: React.MouseEvent) => void;
  onMouseLeave?: (e: React.MouseEvent) => void;
}

export function FileIcon({ ext, isDir, isBundle, onMouseEnter, onMouseLeave }: FileIconProps) {
  const lext = ext.toLowerCase();
  // Initialize from ICON_FAILED so all instances for the same extension agree,
  // but still use useState so a fresh app load can retry after a transient failure.
  const [imgFailed, setImgFailed] = useState(() => ICON_FAILED.has(lext));
  const [source, setSource] = useState<string | null>(null);

  useEffect(() => {
    setImgFailed(ICON_FAILED.has(lext));
  }, [lext]);

  useEffect(() => {
    if (isDir || isBundle || !lext || imgFailed) {
      setSource(null);
      return;
    }
    let disposed = false;
    setSource(null);
    void loadShellIcon(lext).then((value) => {
      if (disposed) return;
      if (value) setSource(value);
      else {
        ICON_FAILED.add(lext);
        setImgFailed(true);
      }
    });
    return () => { disposed = true; };
  }, [imgFailed, isBundle, isDir, lext]);

  if (isBundle) {
    return <span className="kind kind-bundle">≡</span>;
  }

  if (isDir) {
    return (
      <span
        className="kind kind-dir"
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      />
    );
  }

  // Always use the Windows file-type icon. If the shell cannot supply one, keep
  // the neutral document glyph instead of inventing extension badges such as
  // RAR/ZIP/MP4, which look like thumbnails but are not Windows icons.
  if (lext) {
    return (
      <span
        className="kind"
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        {source ? (
          <img
            className="kind-shell-icon"
            src={source}
            width={16}
            height={16}
            alt=""
            draggable={false}
            onError={() => { ICON_FAILED.add(lext); setImgFailed(true); setSource(null); }}
          />
        ) : <span className="kind-file-generic" />}
      </span>
    );
  }

  return (
    <span
      className="kind"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <span className="kind-file-generic" />
    </span>
  );
}
