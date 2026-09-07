import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SortKey, Unit } from "../api/types";
import { ALL_COLUMNS, DEFAULT_VISIBLE_COLUMNS, type ColumnDef } from "./TreeTable";
import { localRect, localViewport } from "../lib/overlay";
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
const DEFERRED_COLUMNS = ["Author", "File Version", "Description", "Permissions"];

/** Breathing room between the menu and its trigger, and the window edge. */
const GAP = 2;
const EDGE = 6;
/** One menu row; never force a minimum larger than the available viewport. */
const MIN_MENU_H = 24;

/**
 * Fixed-position dropdown anchored to its trigger. Escapes `overflow: hidden`
 * parents (getBoundingClientRect + position: fixed).
 *
 * Placement is measured rather than assumed: a menu taller than the room under
 * its trigger flips above it, and one near the right edge is pulled back inside
 * the window. Anchoring blindly at `rect.bottom` is what pushed the taller
 * menus (columns, sort) off the bottom of the screen. Because the height needed
 * depends on the caller's children, the menu is rendered hidden for one frame,
 * measured, then shown — so there is no visible jump into place.
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
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number; flipped: boolean } | null>(null);

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

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      const anchor = anchorRef.current;
      const menu = menuRef.current;
      if (!anchor || !menu) return;
      // Local (zoom-relative) space throughout, matching the units that
      // `scrollHeight`/`offsetWidth` and inline lengths use. See lib/overlay.ts.
      const rect = localRect(anchor);
      const view = localViewport();
      const below = view.height - rect.bottom - GAP - EDGE;
      const above = rect.top - GAP - EDGE;
      // Measure the content with the cap lifted. The menu is a flex column, so
      // an applied max-height makes the rows shrink to fit rather than overflow
      // — reading scrollHeight through the cap returns that shrunken height, and
      // since the ResizeObserver below re-places on every height change, each
      // pass would ratchet the cap down until the menu collapsed to MIN_MENU_H.
      const capped = menu.style.maxHeight;
      menu.style.maxHeight = "none";
      const natural = menu.scrollHeight;
      menu.style.maxHeight = capped;
      const flipped = natural > below && above > below;
      const room = flipped ? above : below;
      const maxHeight = Math.max(MIN_MENU_H, Math.min(natural, Math.max(0, room)));
      const next = {
        top: flipped ? Math.max(EDGE, rect.top - maxHeight - GAP) : rect.bottom + GAP,
        left: Math.max(EDGE, Math.min(rect.left, view.width - menu.offsetWidth - EDGE)),
        maxHeight,
        flipped,
      };
      // Returning the previous object lets React bail out, so a re-place that
      // changes nothing can't feed the observer another layout pass.
      setPos((prev) => (
        prev
        && prev.top === next.top
        && prev.left === next.left
        && prev.maxHeight === next.maxHeight
        && prev.flipped === next.flipped
          ? prev
          : next
      ));
    };
    place();
    // Menus whose contents change while open (filtered lists) need re-placing.
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined" && menuRef.current) {
      observer = new ResizeObserver(place);
      observer.observe(menuRef.current);
    }
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchorRef]);

  if (!open || !anchorRef.current) return null;
  return (
    <div
      ref={menuRef}
      className={`rb-dropdown-menu${pos?.flipped ? " flipped" : ""}`}
      style={{
        position: "fixed",
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        maxHeight: pos?.maxHeight ?? "72vh",
        zIndex: 9999,
        overflowY: "auto",
        // Hidden only for the measuring frame, before `pos` exists.
        visibility: pos ? undefined : "hidden",
      }}
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
