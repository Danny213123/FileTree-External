import { useEffect, useRef, useState } from "react";
import type { SortKey, Unit } from "../api/types";
import { ALL_COLUMNS, DEFAULT_VISIBLE_COLUMNS, type ColumnDef } from "./TreeTable";
import { Icon } from "./Icon";

// Groups derive from ALL_COLUMNS (single source of truth) so the menu never
// drifts from what the table can actually render.
const GROUP_LABELS: Record<ColumnDef["group"], string> = {
  common: "Common",
  date: "Date and time",
  extended: "Extended",
};
const GROUP_ORDER: ColumnDef["group"][] = ["common", "date", "extended"];
const COL_GROUPS = GROUP_ORDER.map((group) => ({
  group,
  label: GROUP_LABELS[group],
  cols: ALL_COLUMNS.filter((c) => c.group === group),
}));

// Columns that need data the scan does not yet emit. Shown greyed/disabled to
// match TreeSize's menu. Wiring any of these up means: emit the field from the
// native scan in `src/model.rs` + serialize it in `src/export.rs`, then rebuild
// it on the client in `useScan.ts` (reconstructChildren) and add it to
// ALL_COLUMNS / SortKey — only then can it be toggled here.
const DEFERRED_COLUMNS = ["Owner", "Author", "File Version", "Description", "Permissions"];

/**
 * Fixed-position dropdown anchored under its trigger. Escapes overflow:hidden
 * parents (getBoundingClientRect + position:fixed). Closes on outside mousedown
 * or Escape.
 */
export function FixedDropdown({
  anchorRef,
  open,
  onClose,
  children,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (anchorRef.current && anchorRef.current.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, anchorRef, onClose]);

  if (!open || !anchorRef.current) return null;
  const rect = anchorRef.current.getBoundingClientRect();
  return (
    <div
      className="rb-dropdown-menu"
      style={{ position: "fixed", top: rect.bottom, left: rect.left, zIndex: 9999, maxHeight: "72vh", overflowY: "auto" }}
    >
      {children}
    </div>
  );
}

interface ColumnsMenuProps {
  visibleColumns: Set<SortKey>;
  onVisibleColumnsChange: (cols: Set<SortKey>) => void;
  decimals: number;
  onDecimalsChange: (d: number) => void;
  unit: Unit;
  onUnitChange: (u: Unit) => void;
}

/**
 * Inner content of the Configure Columns menu: grouped column checkboxes (Name
 * locked on) + a Decimals picker + an Automatic Units toggle + Reset. Rendered
 * both by the editor-toolbar control (`ConfigureColumnsMenu`) and by the title
 * bar's View ▸ Configure Columns popup, so the two stay identical. View prefs
 * are global (columns/decimals) except `unit`, which is the active tab's unit.
 * Reuses the ribbon `.rb-dropdown-menu`/`.rb-col-row` CSS.
 */
export function ColumnsMenuContent({
  visibleColumns,
  onVisibleColumnsChange,
  decimals,
  onDecimalsChange,
  unit,
  onUnitChange,
  onRequestClose,
}: ColumnsMenuProps & { onRequestClose?: () => void }) {
  const toggle = (key: SortKey) => {
    if (key === "name") return; // Name is the tree cell — always shown
    const next = new Set(visibleColumns);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    next.add("name");
    onVisibleColumnsChange(next);
  };

  return (
    <>
      {COL_GROUPS.map((group) => (
        <div key={group.group}>
          <div className="rb-dd-section">{group.label}</div>
          {group.cols.map((col) => (
            <button
              key={col.key}
              className="rb-col-row"
              disabled={col.key === "name"}
              title={col.key === "name" ? "Name is always shown" : undefined}
              onClick={() => toggle(col.key)}
            >
              <span className="rb-col-check">
                {visibleColumns.has(col.key) ? <Icon name="check" size={11} /> : ""}
              </span>
              {col.label}
            </button>
          ))}
        </div>
      ))}

      <div className="rb-dd-section">Requires scan support</div>
      {DEFERRED_COLUMNS.map((label) => (
        <button
          key={label}
          className="rb-col-row"
          disabled
          title="Requires scan support — not yet emitted by the scanner"
        >
          <span className="rb-col-check" />
          {label}
        </button>
      ))}

      <div className="rb-dropdown-sep" />
      <div className="rb-dd-section">Decimal places</div>
      <div className="cfg-cols-decimals">
        {[0, 1, 2, 3, 4, 5].map((d) => (
          <button
            key={d}
            className={decimals === d ? "rb-active" : ""}
            onClick={() => onDecimalsChange(d)}
          >
            {d}
          </button>
        ))}
      </div>

      <button
        className="rb-col-row"
        onClick={() => onUnitChange(unit === "auto" ? "gb" : "auto")}
        title="Pick units automatically based on size"
      >
        <span className="rb-col-check">
          {unit === "auto" ? <Icon name="check" size={11} /> : ""}
        </span>
        Automatic Units
      </button>

      <div className="rb-dropdown-sep" />
      <button
        className="rb-col-reset"
        onClick={() => { onVisibleColumnsChange(new Set(DEFAULT_VISIBLE_COLUMNS)); onRequestClose?.(); }}
      >
        <span className="rb-col-reset-icon"><Icon name="refresh" size={16} /></span>
        <span>
          <strong>Reset Columns</strong>
          <br />
          <span style={{ fontSize: 11, opacity: 0.7 }}>Restore the details list to the default columns.</span>
        </span>
      </button>
    </>
  );
}

/**
 * Editor-toolbar control: a "Columns" button that opens the Configure Columns
 * menu anchored under itself. Shares its body with the title-bar View menu
 * entry via `ColumnsMenuContent`.
 */
export function ConfigureColumnsMenu(props: ColumnsMenuProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  return (
    <div className="rb-dropdown-wrap" ref={anchorRef}>
      <button
        className={`cfg-cols-btn${open ? " active" : ""}`}
        title="Configure columns"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="columns" size={14} />
        <span>Columns</span>
      </button>
      <FixedDropdown anchorRef={anchorRef} open={open} onClose={() => setOpen(false)}>
        <ColumnsMenuContent {...props} onRequestClose={() => setOpen(false)} />
      </FixedDropdown>
    </div>
  );
}
