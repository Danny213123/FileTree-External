import { useEffect, useRef, useState } from "react";
import { loadShellThumbnail } from "../lib/shellImages";

interface ShellThumbnailProps {
  path: string;
  size?: number;
  iconFallback?: boolean;
  className?: string;
  alt?: string;
  loading?: "eager" | "lazy";
  draggable?: boolean;
  style?: React.CSSProperties;
  onLoad?: () => void;
  onUnavailable?: () => void;
}

export function ShellThumbnail({
  path,
  size = 480,
  iconFallback = true,
  className,
  alt = "",
  loading,
  draggable = false,
  style,
  onLoad,
  onUnavailable,
}: ShellThumbnailProps) {
  const [source, setSource] = useState<string | null>(null);
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;

  useEffect(() => {
    let disposed = false;
    setSource(null);
    void loadShellThumbnail(path, size, iconFallback).then((value) => {
      if (disposed) return;
      if (value) setSource(value);
      else onUnavailableRef.current?.();
    });
    return () => { disposed = true; };
  }, [iconFallback, path, size]);

  if (!source) return null;
  return (
    <img
      className={className}
      src={source}
      alt={alt}
      loading={loading}
      draggable={draggable}
      style={style}
      onLoad={onLoad}
      onError={onUnavailable}
    />
  );
}
