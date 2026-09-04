import { useEffect, useState } from "react";
import { invalidateShellIcon, loadShellIcon, peekShellIcon } from "../lib/shellImages";
import { Icon } from "./Icon";

interface FileIconProps {
  ext: string;
  isDir: boolean;
  isBundle: boolean;
  onMouseEnter?: (e: React.MouseEvent) => void;
  onMouseLeave?: (e: React.MouseEvent) => void;
}

export function FileIcon({ ext, isDir, isBundle, onMouseEnter, onMouseLeave }: FileIconProps) {
  const lext = ext.toLowerCase();
  const [resolved, setResolved] = useState<{ extension: string; source: string | null }>(
    () => ({ extension: lext, source: peekShellIcon(lext) ?? null }),
  );
  const [readySource, setReadySource] = useState<string | null>(null);
  const cachedSource = !isDir && !isBundle && lext ? peekShellIcon(lext) : undefined;
  const source = !isDir && !isBundle && lext
    ? (resolved.extension === lext ? resolved.source : null) ?? cachedSource ?? null
    : null;
  const imageReady = !!source && readySource === source;

  useEffect(() => {
    if (isDir || isBundle || !lext) return;
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retries = 0;
    const request = () => {
      const cached = peekShellIcon(lext);
      if (cached) {
        setResolved({ extension: lext, source: cached });
        return;
      }
      void loadShellIcon(lext).then((value) => {
        if (disposed) return;
        if (value) {
          setResolved({ extension: lext, source: value });
          return;
        }
        // Shell association lookups can fail while Windows is busy. Retry in
        // place so a transient miss does not remain generic until this row is
        // unmounted or scrolled away.
        if (retries < 2) {
          const delay = retries === 0 ? 120 : 500;
          retries++;
          retryTimer = setTimeout(request, delay);
        } else {
          setResolved({ extension: lext, source: null });
        }
      });
    };
    request();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [isBundle, isDir, lext]);

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

  // Keep a bundled document glyph painted underneath the asynchronous Windows
  // icon. The fallback disappears only after the <img> itself has decoded, so
  // a resolved data URL can never create an empty frame while WebView is busy.
  return (
    <span
      className="kind"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <span className={`kind-file-generic${imageReady ? " is-hidden" : ""}`}>
        <Icon name="file-text" size={14} />
      </span>
      {source && (
        <img
          className={`kind-shell-icon${imageReady ? " is-ready" : ""}`}
          src={source}
          width={16}
          height={16}
          alt=""
          draggable={false}
          onLoad={() => setReadySource(source)}
          onError={() => {
            invalidateShellIcon(lext);
            setReadySource(null);
            setResolved({ extension: lext, source: null });
          }}
        />
      )}
    </span>
  );
}
