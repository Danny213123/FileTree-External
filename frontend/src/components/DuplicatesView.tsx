import { useEffect, useRef, useState } from "react";
import type { DriveEntry, SpecialFolder } from "../api/types";
import type { DuplicatesController } from "../hooks/useDuplicates";
import { DuplicatesConfigPanel } from "./DuplicatesConfigPanel";
import { DuplicatesResults } from "./DuplicatesResults";

type DuplicatesTab = "directories" | "results";

export function DuplicatesView({
  ctrl,
  drives,
  specialFolders,
}: {
  ctrl: DuplicatesController;
  drives: DriveEntry[];
  specialFolders: SpecialFolder[];
}) {
  const [tab, setTab] = useState<DuplicatesTab>(() =>
    ctrl.groups.length > 0 || ctrl.scanState === "done" ? "results" : "directories",
  );
  const previousScan = useRef(ctrl.scanState);

  useEffect(() => {
    const previous = previousScan.current;
    previousScan.current = ctrl.scanState;
    if (previous === "scanning" && ctrl.scanState === "done") {
      setTab("results");
    }
  }, [ctrl.scanState]);

  const resultCount = ctrl.groups.length;

  return (
    <div className="df-view">
      <div className="dg-tabstrip" role="tablist" aria-label="Duplicate finder">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "directories"}
          className={`dg-tab${tab === "directories" ? " active" : ""}`}
          onClick={() => setTab("directories")}
        >
          Directories
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "results"}
          className={`dg-tab${tab === "results" ? " active" : ""}`}
          onClick={() => setTab("results")}
        >
          Results
          <span className="dg-tab-badge">{resultCount}</span>
        </button>
      </div>
      {tab === "directories" ? (
        <DuplicatesConfigPanel
          ctrl={ctrl}
          drives={drives}
          specialFolders={specialFolders}
        />
      ) : (
        <DuplicatesResults ctrl={ctrl} onOpenSetup={() => setTab("directories")} />
      )}
    </div>
  );
}
