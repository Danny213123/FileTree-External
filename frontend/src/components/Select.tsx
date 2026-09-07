import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { localRect, localViewport } from "../lib/overlay";
import { Icon } from "./Icon";

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  /** Quiet trailing text in the menu — a unit, a count, a shortcut. */
  hint?: string;
  disabled?: boolean;
}

interface SelectProps<T extends string> {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  /** Sizing/skin class for the trigger; callers keep their own layout rules. */
  className?: string;
  title?: string;
  "aria-label"?: string;
  /** Keeps the click off a clickable row behind the control. */
  stopPropagation?: boolean;
}

/** Breathing room kept between the menu and the edge of the window. */
const GAP = 2;
const EDGE = 6;
const MAX_MENU_H = 420;

/**
 * The app's dropdown. It replaces `<select>` because three things a native one
 * cannot do were all wanted at once:
 *
 *  - **Theming.** Chromium paints the option list from the control's own
 *    `background-color`, so any select with a `transparent` background gets a
 *    white list no matter what `color-scheme` says. That is why the duplicates
 *    State column popped up light in dark mode.
 *  - **Matching width.** The native list is sized to its widest option and
 *    ignores the closed control, so the two visibly disagreed. Here the trigger
 *    *reserves* the widest label (see `.ft-select-sizer`) and the menu is
 *    measured from the trigger, so they cannot drift apart.
 *  - **Arrow direction.** The caret has to point at where the list will appear.
 *
 * The menu is a portal so it escapes the `overflow: hidden` of toolbars, table
 * cells and scroll containers, and it flips above the trigger when the space
 * below runs out rather than sliding off-screen.
 */
export function Select<T extends string>({
  value, options, onChange, disabled,
  className, title, "aria-label": ariaLabel, stopPropagation,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxHeight: number; flipped: boolean } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selectedIndex = options.findIndex((o) => o.value === value);
  const current = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setPos(null);
    if (refocus) triggerRef.current?.focus();
  }, []);

  // Measured every time the menu opens, and again on scroll/resize, because a
  // fixed-position portal does not travel with its anchor.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = triggerRef.current;
      if (!anchor) return;
      // Local (zoom-relative) space throughout, so these numbers can be
      // written straight back out as inline lengths. See lib/overlay.ts.
      const rect = localRect(anchor);
      const view = localViewport();
      const below = view.height - rect.bottom - GAP - EDGE;
      const above = rect.top - GAP - EDGE;
      // Only give up the natural position when flipping is genuinely roomier.
      const wanted = Math.min(MAX_MENU_H, options.length * 24 + 8);
      const flipped = below < wanted && above > below;
      // Never impose a minimum taller than the room we actually have: on a
      // short window that recreates the very bottom overflow this component is
      // meant to prevent. Twenty-four pixels still leaves one usable option.
      const room = Math.max(0, flipped ? above : below);
      const maxHeight = Math.max(24, Math.min(MAX_MENU_H, room));
      setPos({
        top: flipped ? Math.max(EDGE, rect.top - maxHeight - GAP) : rect.bottom + GAP,
        left: Math.max(EDGE, Math.min(rect.left, view.width - rect.width - EDGE)),
        width: rect.width,
        maxHeight,
        flipped,
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, close]);

  useEffect(() => {
    if (open) menuRef.current?.focus();
  }, [open, pos]);

  const step = (from: number, delta: number): number => {
    const n = options.length;
    for (let i = 1; i <= n; i += 1) {
      const next = (from + delta * i + n * n) % n;
      if (!options[next].disabled) return next;
    }
    return from;
  };

  const openMenu = () => {
    if (disabled) return;
    setActive(selectedIndex >= 0 ? selectedIndex : step(-1, 1));
    setOpen(true);
  };

  const commit = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    if (option.value !== value) onChange(option.value);
    close(true);
  };

  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openMenu();
    }
  };

  const onMenuKey = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); setActive((i) => step(i, 1)); break;
      case "ArrowUp": e.preventDefault(); setActive((i) => step(i, -1)); break;
      case "Home": e.preventDefault(); setActive(step(-1, 1)); break;
      case "End": e.preventDefault(); setActive(step(options.length, -1)); break;
      case "Enter":
      case " ": e.preventDefault(); commit(active); break;
      case "Escape": e.preventDefault(); close(true); break;
      case "Tab": close(false); break;
      default: break;
    }
  };

  // Every label is laid out on top of every other one, so this contributes the
  // width of the longest without contributing its height.
  const sizer = useMemo(() => (
    <span className="ft-select-sizer" aria-hidden="true">
      {options.map((o) => <span key={o.value}>{o.label}</span>)}
    </span>
  ), [options]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`ft-select${open ? " open" : ""}${className ? ` ${className}` : ""}`}
        disabled={disabled}
        title={title}
        // ARIA 1.2 combobox: the trigger owns the name and expanded state, the
        // portalled popup is the listbox. Keeps the control reachable by role
        // for assistive tech (and for tests) now that it is not a <select>.
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        // Mirrors a native select's `value` into the DOM. The visible label is
        // not a substitute: the trigger also carries the hidden width-reserving
        // copy of every other label.
        data-value={value}
        onKeyDown={onTriggerKey}
        onClick={(e) => {
          if (stopPropagation) e.stopPropagation();
          if (open) close(true); else openMenu();
        }}
      >
        <span className="ft-select-value">
          {sizer}
          <span className="ft-select-current">{current?.label ?? ""}</span>
        </span>
        {/* Points at the menu: down while closed, up once it is above/open. */}
        <Icon name="chevron-down" size={9} className="ft-select-caret" />
      </button>

      {open && pos && createPortal(
        <div
          ref={menuRef}
          className={`ft-select-menu${pos.flipped ? " flipped" : ""}`}
          role="listbox"
          tabIndex={-1}
          aria-activedescendant={active >= 0 ? `ft-opt-${active}` : undefined}
          style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}
          onKeyDown={onMenuKey}
        >
          {options.map((o, i) => (
            <div
              key={o.value}
              id={`ft-opt-${i}`}
              role="option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled || undefined}
              className={
                `ft-select-opt${o.value === value ? " sel" : ""}` +
                `${i === active ? " active" : ""}${o.disabled ? " disabled" : ""}`
              }
              onMouseEnter={() => !o.disabled && setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => commit(i)}
            >
              <span className="ft-select-check">{o.value === value && <Icon name="check" size={11} />}</span>
              <span className="ft-select-opt-label">{o.label}</span>
              {o.hint && <span className="ft-select-opt-hint">{o.hint}</span>}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
