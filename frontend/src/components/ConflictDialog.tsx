import { useEffect, useState } from "react";

// Internal resolution choices passed back to the mover. The button labels
// surfaced to the user are Skip / Overwrite / Rename / Cancel; they map to the
// backend's conflict modes: "replace" (Overwrite), "keep-both" (Rename, keeps
// both by auto-suffixing), "skip", and "cancel".
export type ConflictChoice = "replace" | "keep-both" | "skip" | "cancel";

interface ConflictDialogProps {
  /** Base names of the items that already exist in the destination. */
  names: string[];
  /**
   * Resolve the conflict. `applyToAll` tells the caller whether to use this one
   * choice for every remaining collision (checked, the default) or just the
   * one currently being shown (unchecked ⇒ the caller re-prompts per item).
   */
  onChoice: (choice: ConflictChoice, applyToAll: boolean) => void;
  /** 1-based index of the conflict being resolved (for the per-item header). */
  index?: number;
  /** Total number of conflicting items in this operation. */
  total?: number;
}

const MAX_LISTED = 12;

export function ConflictDialog({ names, onChoice, index, total }: ConflictDialogProps) {
  // Default to "apply to all" — the common case for a batch — but let the user
  // opt into per-item decisions for a mixed selection.
  const [applyToAll, setApplyToAll] = useState(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onChoice("cancel", applyToAll);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onChoice, applyToAll]);

  const count = names.length;
  const showProgress = typeof index === "number" && typeof total === "number" && total > 1;
  const title = showProgress
    ? `Name conflict ${index} of ${total}`
    : count === 1
      ? "The destination already has a file with this name"
      : `${count} items already exist in the destination`;

  return (
    <div
      className="filter-dialog-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onChoice("cancel", applyToAll); }}
    >
      <div className="conflict-dialog" role="dialog" aria-modal="true" aria-label="Resolve file conflict">
        <div className="fd-header">
          <span className="fd-title">{title}</span>
        </div>
        <div className="cd-body">
          <p className="cd-msg">
            Choose what to do with {count === 1 ? "this item" : "these items"}:
          </p>
          <ul className="cd-list">
            {names.slice(0, MAX_LISTED).map((name) => (
              <li key={name} title={name}>{name}</li>
            ))}
            {count > MAX_LISTED && <li className="cd-more">…and {count - MAX_LISTED} more</li>}
          </ul>
          <label className="cd-apply-all">
            <input
              type="checkbox"
              checked={applyToAll}
              onChange={(e) => setApplyToAll(e.target.checked)}
            />
            <span>Apply to all conflicts</span>
          </label>
        </div>
        <div className="fd-footer">
          <button
            className="fd-ok primary"
            onClick={() => onChoice("replace", applyToAll)}
            title="Overwrite the existing item(s) in the destination (the overwritten copy goes to the Recycle Bin)"
          >
            Overwrite
          </button>
          <button
            className="cd-keep"
            onClick={() => onChoice("keep-both", applyToAll)}
            title="Rename the moved item(s) to keep both, e.g. 'file (2).txt'"
          >
            Rename
          </button>
          <button
            className="fd-cancel"
            onClick={() => onChoice("skip", applyToAll)}
            title="Leave the conflicting item(s) where they are"
          >
            Skip
          </button>
          <button className="fd-cancel" onClick={() => onChoice("cancel", applyToAll)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
