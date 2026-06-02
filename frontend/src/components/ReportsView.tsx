import { useState } from "react";
import type { NodeRecord, ScanResult } from "../api/types";
import { formatBytes, formatCount } from "../utils/formatBytes";
import { TopFilesTab } from "./TopFilesTab";
import { LargestFoldersTab } from "./LargestFoldersTab";
import { ExtensionsTab } from "./ExtensionsTab";
import { AgeTab } from "./AgeTab";
import { ByOwnerTab } from "./ByOwnerTab";
import { CompareTab } from "./CompareTab";
import { EmptyState } from "./EmptyState";

// TreeSize-style analytics reports. All data is computed server-side and shipped
// in the scan meta line (topFiles, largestDirs, extensionStats, ageStats), so
// this view is pure presentation over the focused tab's ScanResult. Clicking a
// Top Files / Largest Folders entry reveals it in the tree (via onNavigate).
// "Compare" (roadmap #5) and "By Owner" (roadmap #7) are hosted here too.
type ReportId = "top-files" | "largest-folders" | "by-type" | "by-age" | "by-owner" | "compare";

const TABS: { id: ReportId; label: string }[] = [
  { id: "top-files", label: "Top Files" },
  { id: "largest-folders", label: "Largest Folders" },
  { id: "by-type", label: "By Type" },
  { id: "by-age", label: "By Age" },
  { id: "by-owner", label: "By Owner" },
  { id: "compare", label: "Compare" },
];

interface ReportsViewProps {
  data: ScanResult | null;
  nodeById: Map<number, NodeRecord>;
  /** Reveal + select a node in the tree (also switches back to the Explorer). */
  onNavigate: (id: number) => void;
}

export function ReportsView({ data, nodeById, onNavigate }: ReportsViewProps) {
  const [tab, setTab] = useState<ReportId>("top-files");

  if (!data) {
    return (
      <div className="reports-view">
        <EmptyState
          icon="bar-chart"
          title="No scan loaded"
          hint="Run a scan to see Top Files, Largest Folders, and other reports for this folder."
        />
      </div>
    );
  }

  const root = data.nodes?.[0];

  return (
    <div className="reports-view">
      <div className="reports-header">
        <span className="reports-title" title={data.rootPath}>{data.rootPath}</span>
        {root && (
          <span className="reports-sub">
            {formatBytes(root.size)} · {formatCount(root.files)} files · {formatCount(root.folders)} folders
          </span>
        )}
      </div>

      <div className="reports-tabstrip" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`reports-tab${tab === t.id ? " active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="reports-body">
        {tab === "top-files" && (
          <TopFilesTab topFileIds={data.topFiles ?? []} nodeById={nodeById} onNavigate={onNavigate} />
        )}
        {tab === "largest-folders" && (
          <LargestFoldersTab dirIds={data.largestDirs ?? []} nodeById={nodeById} onNavigate={onNavigate} />
        )}
        {tab === "by-type" && <ExtensionsTab extensionStats={data.extensionStats ?? []} />}
        {tab === "by-age" && <AgeTab ageStats={data.ageStats ?? []} />}
        {tab === "by-owner" && <ByOwnerTab data={data} />}
        {tab === "compare" && <CompareTab data={data} nodeById={nodeById} onNavigate={onNavigate} />}
      </div>
    </div>
  );
}
