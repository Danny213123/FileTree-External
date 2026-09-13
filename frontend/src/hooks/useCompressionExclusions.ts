import { useEffect, useState } from "react";
import { loadCompressionExclusions } from "../lib/compressionExclusions";
export function useCompressionExclusions() {
  const [paths, setPaths] = useState(loadCompressionExclusions);
  useEffect(() => {
    const refresh = () => setPaths(loadCompressionExclusions());
    window.addEventListener("compression-exclusions-changed", refresh);
    window.addEventListener("storage", refresh);
    return () => { window.removeEventListener("compression-exclusions-changed", refresh); window.removeEventListener("storage", refresh); };
  }, []);
  return [paths, setPaths] as const;
}
