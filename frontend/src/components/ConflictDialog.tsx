import { useEffect } from "react";

export type ConflictChoice = "replace" | "keep-both" | "skip" | "cancel";

interface ConflictDialogProps {
  /** Base names of the items that already exist in the destination. */
  names: string[];
  onChoice: (choice: ConflictChoice) => void;
}

const MAX_LISTED = 12;

export function ConflictDialog({ names, onChoice }: ConflictDialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onChoice("cancel");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onChoice]);

  const count = names.length;
  const title =
    count === 1
      ? "The destination already has a file with this name"
      : `${count} items already exist in the destination`;

  return (
    <div
      className="filter-dialog-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onChoice("cancel"); }}
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
        </div>
        <div className="fd-footer">
          <button
            className="fd-ok primary"
            onClick={() => onChoice("replace")}
            title="Overwrite the existing item(s) in the destination"
          >
            Replace
          </button>
          <button
            className="cd-keep"
            onClick={() => onChoice("keep-both")}
            title="Keep both by renaming the moved item(s), e.g. 'file (2).txt'"
          >
            Keep both
          </button>
          <button
            className="fd-cancel"
            onClick={() => onChoice("skip")}
            title="Leave the conflicting item(s) where they are"
          >
            Skip
          </button>
          <button className="fd-cancel" onClick={() => onChoice("cancel")}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
