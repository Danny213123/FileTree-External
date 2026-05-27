import { useState, useEffect, useRef } from "react";
import {
  type FilterRule,
  type FilterField,
  type FilterOperator,
  type FilterJoin,
  FIELD_LABELS,
  OPERATOR_LABELS,
  makeRule,
} from "../hooks/useFilterRules";

const FIELDS: FilterField[] = ["name", "path", "parentFolder", "anyParentFolder"];
const OPERATORS: FilterOperator[] = [
  "startsWith", "contains", "endsWith", "equals",
  "matchesPattern", "matchesRegex",
  "notEquals", "notStartsWith", "notContains", "notEndsWith",
  "notMatchesPattern", "notMatchesRegex",
];

interface FilterDialogProps {
  initialRules: FilterRule[];
  onApply: (rules: FilterRule[]) => void;
  onClose: () => void;
}

export function FilterDialog({ initialRules, onApply, onClose }: FilterDialogProps) {
  const [rules, setRules] = useState<FilterRule[]>(
    initialRules.length > 0 ? initialRules : [makeRule("and")]
  );
  const firstInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstInputRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleApply();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rules]);

  function handleApply() {
    onApply(rules.filter((r) => r.value.trim() !== ""));
    onClose();
  }

  function handleClear() {
    onApply([]);
    onClose();
  }

  function addRule() {
    setRules((prev) => [...prev, makeRule(prev.length === 0 ? "and" : "and")]);
  }

  function removeRule(id: string) {
    setRules((prev) => {
      const next = prev.filter((r) => r.id !== id);
      return next.length === 0 ? [makeRule("and")] : next;
    });
  }

  function updateRule(id: string, patch: Partial<FilterRule>) {
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function moveRule(id: string, dir: -1 | 1) {
    setRules((prev) => {
      const idx = prev.findIndex((r) => r.id === id);
      if (idx < 0) return prev;
      const next = [...prev];
      const swap = idx + dir;
      if (swap < 0 || swap >= next.length) return prev;
      [next[idx], next[swap]] = [next[swap], next[idx]];
      return next;
    });
  }

  const hasActive = rules.some((r) => r.value.trim() !== "");

  return (
    <div className="filter-dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="filter-dialog" role="dialog" aria-modal="true" aria-label="Filter files">
        <div className="fd-header">
          <span className="fd-title">Include the following files</span>
          <div className="fd-header-actions">
            <button className="fd-icon-btn" title="Add rule" onClick={addRule}>＋</button>
            <button className="fd-icon-btn" title="Clear all rules" onClick={handleClear}>🗑</button>
            <button className="fd-icon-btn" title="Move up" disabled={rules.length < 2}
              onClick={() => rules.length > 0 && moveRule(rules[0].id, -1)}>▲</button>
            <button className="fd-icon-btn" title="Move down" disabled={rules.length < 2}
              onClick={() => rules.length > 0 && moveRule(rules[rules.length - 1].id, 1)}>▼</button>
          </div>
        </div>

        <div className="fd-body">
          {rules.map((rule, idx) => (
            <div key={rule.id} className="fd-rule">
              {/* And/Or join selector (first row shows nothing interactive, just "And") */}
              <JoinSelect
                value={rule.join}
                isFirst={idx === 0}
                onChange={(join) => updateRule(rule.id, { join })}
              />

              {/* Field dropdown */}
              <select
                className="fd-select fd-field"
                value={rule.field}
                onChange={(e) => updateRule(rule.id, { field: e.target.value as FilterField })}
              >
                {FIELDS.map((f) => (
                  <option key={f} value={f}>{FIELD_LABELS[f]}</option>
                ))}
              </select>

              {/* Operator dropdown */}
              <select
                className="fd-select fd-op"
                value={rule.operator}
                onChange={(e) => updateRule(rule.id, { operator: e.target.value as FilterOperator })}
              >
                {OPERATORS.map((op) => (
                  <option key={op} value={op}>{OPERATOR_LABELS[op]}</option>
                ))}
              </select>

              {/* Value input */}
              <input
                ref={idx === 0 ? firstInputRef : undefined}
                className="fd-value"
                type="text"
                placeholder="Enter value"
                value={rule.value}
                onChange={(e) => updateRule(rule.id, { value: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter") handleApply(); }}
              />

              {/* Delete */}
              <button
                className="fd-icon-btn fd-delete"
                title="Remove rule"
                onClick={() => removeRule(rule.id)}
              >
                🗑
              </button>

              {/* Move up/down */}
              <button
                className="fd-icon-btn fd-move"
                title="Move up"
                disabled={idx === 0}
                onClick={() => moveRule(rule.id, -1)}
              >▲</button>
              <button
                className="fd-icon-btn fd-move"
                title="Move down"
                disabled={idx === rules.length - 1}
                onClick={() => moveRule(rule.id, 1)}
              >▼</button>
            </div>
          ))}

          <button className="fd-add-btn" onClick={addRule}>
            <span>＋</span> Add new
          </button>
        </div>

        <div className="fd-footer">
          <button className="fd-ok primary" onClick={handleApply}>OK</button>
          <button className="fd-cancel" onClick={onClose}>Cancel</button>
          {hasActive && (
            <button className="fd-clear" onClick={handleClear}>Clear filter</button>
          )}
        </div>
      </div>
    </div>
  );
}

function JoinSelect({
  value,
  isFirst,
  onChange,
}: {
  value: FilterJoin;
  isFirst: boolean;
  onChange: (v: FilterJoin) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className="fd-join-wrap" ref={ref}>
      <button
        className={`fd-join-btn${value === "or" ? " fd-join-or" : " fd-join-and"}`}
        onClick={() => !isFirst && setOpen((v) => !v)}
        title={isFirst ? "First rule" : "Toggle And/Or"}
        style={{ cursor: isFirst ? "default" : "pointer" }}
      >
        {isFirst ? "And" : value === "and" ? "And" : "Or"}
        {!isFirst && <span className="fd-join-arrow">▾</span>}
      </button>
      {open && !isFirst && (
        <div className="fd-join-menu">
          {(["and", "or"] as FilterJoin[]).map((j) => (
            <button
              key={j}
              className={value === j ? "fd-join-active" : ""}
              onClick={() => { onChange(j); setOpen(false); }}
            >
              {j === "and" ? "And" : "Or"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
