import { useEffect, useRef, useState } from "react";
import { formatBytes } from "../utils/formatBytes";
import type { DuplicateDeletionRequest } from "../hooks/useDuplicates";
import { Icon } from "./Icon";

export interface DuplicateDeletionDialogProps {
  fileCount: number;
  groupCount: number;
  bytes: number;
  linkEligible: boolean;
  unverifiedCount: number;
  pending: boolean;
  initialPermanent?: boolean;
  onCancel: () => void;
  onConfirm: (request: DuplicateDeletionRequest) => void;
}

export function DuplicateDeletionDialog({
  fileCount,
  groupCount,
  bytes,
  linkEligible,
  unverifiedCount,
  pending,
  initialPermanent = false,
  onCancel,
  onConfirm,
}: DuplicateDeletionDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [permanent, setPermanent] = useState(initialPermanent);
  const [replaceWithLink, setReplaceWithLink] = useState(false);
  const [linkMode, setLinkMode] = useState<"hardlink" | "symlink">("hardlink");

  useEffect(() => {
    confirmRef.current?.focus();
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!pending) onCancel();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!panelRef.current.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previouslyFocused?.focus();
    };
  }, [onCancel, pending]);

  const confirmLabel = pending
    ? "Working…"
    : replaceWithLink
      ? permanent
        ? `Delete and ${linkMode === "symlink" ? "symlink" : "hard-link"}`
        : `Recycle and ${linkMode === "symlink" ? "symlink" : "hard-link"}`
      : permanent
        ? "Delete permanently"
        : "Move to Recycle Bin";

  return (
    <div
      className="filter-dialog-overlay df-delete-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onCancel();
      }}
    >
      <div
        ref={panelRef}
        className="df-delete-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="df-delete-title"
      >
        <div className="df-delete-head">
          <span id="df-delete-title">Deletion options</span>
          <button
            type="button"
            className="inspector-x"
            onClick={onCancel}
            disabled={pending}
            aria-label="Cancel deletion"
          >
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="df-delete-body">
          <p className="df-delete-summary">
            {permanent ? "Permanently delete" : "Send to Recycle Bin"}{" "}
            <strong>{fileCount} file{fileCount === 1 ? "" : "s"}</strong>
            {" "}in {groupCount} group{groupCount === 1 ? "" : "s"}
            {" "}({formatBytes(bytes, "auto")}).
          </p>

          <div className="df-delete-modes" role="radiogroup" aria-label="Deletion method">
            <button
              type="button"
              role="radio"
              aria-checked={!permanent}
              className={`df-delete-mode${!permanent ? " active" : ""}`}
              disabled={pending}
              onClick={() => setPermanent(false)}
            >
              Recycle Bin
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={permanent}
              className={`df-delete-mode danger${permanent ? " active" : ""}`}
              disabled={pending}
              onClick={() => setPermanent(true)}
            >
              Delete permanently
            </button>
          </div>
          {permanent && (
            <p className="df-delete-warn">Permanent deletion cannot be undone.</p>
          )}

          <label className={`df-delete-option${replaceWithLink ? " on" : ""}`}>
            <input
              type="checkbox"
              className="df-checkbox"
              checked={replaceWithLink}
              disabled={pending || !linkEligible}
              onChange={(event) => setReplaceWithLink(event.target.checked)}
            />
            <span>
              <strong>Replace with a link</strong>
              <small>
                {linkEligible
                  ? "Keep the path working by pointing it at the kept original."
                  : `${unverifiedCount} marked file${unverifiedCount === 1 ? " is" : "s are"} not content-verified.`}
              </small>
            </span>
          </label>

          {replaceWithLink && (
            <div className="df-delete-link-modes" role="radiogroup" aria-label="Link type">
              <button
                type="button"
                role="radio"
                aria-checked={linkMode === "hardlink"}
                className={`df-delete-mode${linkMode === "hardlink" ? " active" : ""}`}
                disabled={pending}
                onClick={() => setLinkMode("hardlink")}
              >
                Hard link
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={linkMode === "symlink"}
                className={`df-delete-mode${linkMode === "symlink" ? " active" : ""}`}
                disabled={pending}
                onClick={() => setLinkMode("symlink")}
              >
                Symbolic link
              </button>
            </div>
          )}
          {replaceWithLink && linkMode === "symlink" && (
            <p className="df-delete-hint">Symbolic links may require Developer Mode on Windows.</p>
          )}
        </div>
        <div className="df-delete-footer">
          <button
            ref={confirmRef}
            type="button"
            className={`compress-btn ${permanent ? "danger" : "primary"}`}
            disabled={pending || fileCount === 0}
            onClick={() => onConfirm({
              permanent,
              replaceWithLink: replaceWithLink && linkEligible ? linkMode : undefined,
            })}
          >
            {confirmLabel}
          </button>
          <button type="button" className="compress-btn" onClick={onCancel} disabled={pending}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
