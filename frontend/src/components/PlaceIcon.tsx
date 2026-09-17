// The icon Explorer shows for a drive or folder, with our own glyph underneath.
//
// A generic disk shape for every volume tells you nothing; Windows already has
// the right picture for each one — the manufacturer's icon on an external
// drive, the arrow on Downloads — so the places list asks the shell and falls
// back to the bundled glyph when it cannot answer (browser builds, a drive that
// has been unplugged, or any non-Windows host).

import { useEffect, useState } from "react";
import { loadShellPathIcon, peekShellPathIcon } from "../lib/shellImages";
import { Icon, type IconName } from "./Icon";

export function PlaceIcon({
  path, fallback, size = 13,
}: {
  path: string;
  /** Drawn until the shell answers, and permanently if it never does. */
  fallback: IconName;
  size?: number;
}) {
  const [source, setSource] = useState<string | null>(() => peekShellPathIcon(path) ?? null);

  useEffect(() => {
    const cached = peekShellPathIcon(path);
    if (cached) { setSource(cached); return; }
    let disposed = false;
    void loadShellPathIcon(path).then((value) => { if (!disposed) setSource(value); });
    return () => { disposed = true; };
  }, [path]);

  if (!source) return <Icon name={fallback} size={size} />;
  return <img className="place-icon" src={source} alt="" width={size + 3} height={size + 3} loading="lazy" />;
}
