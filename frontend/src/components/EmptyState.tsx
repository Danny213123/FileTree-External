import { Icon, type IconName } from "./Icon";

export interface EmptyStateAction {
  label: string;
  onClick: () => void;
}

interface EmptyStateProps {
  /** Bootstrap-icon name shown above the title (see Icon.tsx). */
  icon: IconName;
  title: string;
  /** Supporting copy / hint under the title. */
  hint?: string;
  /** Optional call-to-action rendered as a primary button. */
  action?: EmptyStateAction;
  /** Tint the title with the danger color (failed states). */
  error?: boolean;
  /** Tighter padding for narrow hosts (e.g. the inspector pane). */
  compact?: boolean;
}

/**
 * Shared designed empty-state: a centered icon + title + hint (+ optional CTA).
 * Generalized from the Duplicates view's `DfEmpty` so every view can show the
 * same polished "nothing here yet" treatment instead of bare italic text.
 */
export function EmptyState({ icon, title, hint, action, error, compact }: EmptyStateProps) {
  return (
    <div
      className={`empty-state${error ? " empty-state-error" : ""}${compact ? " empty-state-compact" : ""}`}
      role="status"
    >
      <div className="empty-state-icon">
        <Icon name={icon} size={compact ? 22 : 28} />
      </div>
      <div className="empty-state-title">{title}</div>
      {hint && <div className="empty-state-hint">{hint}</div>}
      {action && (
        <button type="button" className="empty-state-action primary" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}
