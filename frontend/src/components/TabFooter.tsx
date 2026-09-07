import { useEffect, useState } from "react";
import { formatBytes, formatCount } from "../utils/formatBytes";
import { fetchVolumeInfo } from "../api/client";
import type { VolumeInfo } from "../api/client";
import type { NodeRecord, ScanResult, Unit } from "../api/types";
import { Icon } from "./Icon";

interface TabFooterProps {
  /** Completed scan for this tab, or null before the first one finishes. */
  scanResult: ScanResult | null;
  /** Aggregated root row. Carries the live totals once a lazy scan is loaded. */
  root: NodeRecord | null;
  /** Path this tab scanned, used to locate the volume the figures describe. */
  scanPath: string;
  unit: Unit;
  decimals: number;
}

/**
 * Per-tab summary strip: how much room is left on the volume this tab scanned,
 * how much of it the scan accounts for, and the volume's geometry.
 *
 * It belongs to the tab rather than the window because each tab can be looking
 * at a different drive — a single shared bar would report whichever one happened
 * to be focused. Figures the platform can't supply are omitted outright; a
 * footer showing "0 bytes free" would be a lie, not a placeholder.
 *
 * The whole strip has to survive a half-width split pane, so every optional
 * segment carries a `tf-p<n>` rank and the stylesheet drops them in that order
 * as the footer narrows (see the `tabfooter` container queries). Each rank sits
 * on a wrapper that also holds the segment's divider, so a hidden segment never
 * leaves an orphaned separator behind.
 */
export function TabFooter({ scanResult, root, scanPath, unit, decimals }: TabFooterProps) {
  const [volume, setVolume] = useState<VolumeInfo | null>(null);
  const path = scanResult?.rootPath || scanPath;

  useEffect(() => {
    if (!path) {
      setVolume(null);
      return;
    }
    let cancelled = false;
    // Free space moves while the app is open, so this is polled rather than
    // read once — slowly, since it is decoration and not scan output.
    const read = () => {
      void fetchVolumeInfo(path).then((info) => {
        if (!cancelled) setVolume(info);
      });
    };
    read();
    const timer = setInterval(read, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [path]);

  const files = root?.files ?? 0;
  const folders = root?.folders ?? 0;
  const scanned = root?.size ?? 0;
  const errors = root?.errors || scanResult?.errorCount || 0;
  const used = volume && volume.totalBytes > 0 ? volume.totalBytes - volume.freeBytes : 0;
  const usedPercent = volume && volume.totalBytes > 0 ? (used / volume.totalBytes) * 100 : 0;

  return (
    <div className="tab-footer">
      {volume && volume.totalBytes > 0 && (
        <>
          <span className="tf-item" title={`${formatBytes(used, unit, decimals)} of ${formatBytes(volume.totalBytes, unit, decimals)} used`}>
            <span className="tf-label tf-p6">Free Space</span>
            <span className="tf-value">{formatBytes(volume.freeBytes, unit, decimals)}</span>
            <span className="tf-muted tf-p5">of {formatBytes(volume.totalBytes, unit, decimals)}</span>
          </span>
          <span className="tf-gauge tf-p2" aria-hidden="true">
            <span
              className={usedPercent >= 90 ? "tf-gauge-fill tf-gauge-low" : "tf-gauge-fill"}
              style={{ width: `${Math.min(100, Math.max(0, usedPercent))}%` }}
            />
          </span>
          <span className="tf-sep" />
        </>
      )}

      <span className="tf-item" title="Files in the scanned tree">
        <span className="tf-value">{formatCount(files)}</span>
        <span className="tf-label">Files</span>
      </span>
      <span className="tf-group tf-p4">
        <span className="tf-sep" />
        <span className="tf-item" title="Folders in the scanned tree">
          <span className="tf-value">{formatCount(folders)}</span>
          <span className="tf-label">Folders</span>
        </span>
      </span>
      <span className="tf-group tf-p3">
        <span className="tf-sep" />
        <span className="tf-item" title="Total size of the scanned tree">
          <span className="tf-label">Scanned</span>
          <span className="tf-value">{formatBytes(scanned, unit, decimals)}</span>
        </span>
      </span>

      {errors > 0 && (
        <span className="tf-group">
          <span className="tf-sep" />
          <span className="tf-item tf-errors" title="Folders that could not be read during the scan">
            <Icon name="warning" size={12} />
            <span className="tf-value">{formatCount(errors)}</span>
            <span className="tf-label tf-p4">Errors</span>
          </span>
        </span>
      )}

      <span className="tf-spacer" />

      {!!volume?.bytesPerCluster && (
        <span className="tf-item tf-quiet tf-p1" title="Allocation unit size on this volume">
          <span className="tf-value">{formatCount(volume.bytesPerCluster)}</span>
          <span className="tf-label">
            Bytes per Cluster{volume.filesystem ? ` (${volume.filesystem})` : ""}
          </span>
        </span>
      )}
      {/* Filesystem stands alone only when the cluster size was unavailable,
          so the two never appear twice. */}
      {!volume?.bytesPerCluster && !!volume?.filesystem && (
        <span className="tf-item tf-quiet tf-p1" title="Filesystem of the scanned volume">
          {volume.filesystem}
        </span>
      )}
    </div>
  );
}
