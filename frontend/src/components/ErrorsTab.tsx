import type { ScanError } from "../api/types";

interface ErrorsTabProps {
  errors: ScanError[];
}

export function ErrorsTab({ errors }: ErrorsTabProps) {
  if (errors.length === 0) {
    return <div className="empty">No scan errors</div>;
  }
  return (
    <div className="item-list">
      {errors.map((e, i) => (
        <div className="item-row" key={i}>
          <header>
            <strong style={{ color: "var(--danger)" }}>{e.path}</strong>
          </header>
          <small>{e.message}</small>
        </div>
      ))}
    </div>
  );
}
