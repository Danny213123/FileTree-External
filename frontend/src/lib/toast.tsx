// Global toast system.
//
// A tiny, framework-light notification stack. The store is a module-level
// singleton with a pub/sub list, so toasts can be raised from anywhere —
// including plain modules and event handlers OUTSIDE the React tree — via the
// imperative `toast` helper (toast.success(), toast.error(), …). The
// <ToastProvider/> (mounted once at the app root in App.tsx) subscribes to the
// store and renders the visible stack.
//
// Variants: success / warn / error / info. Each toast auto-dismisses after a
// timeout (errors linger a little longer), can be dismissed manually, and may
// carry one optional action link (e.g. "Undo (Ctrl+Z)").

import { useEffect, useSyncExternalStore } from "react";
import { Icon, type IconName } from "../components/Icon";

export type ToastVariant = "success" | "warn" | "error" | "info";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  variant?: ToastVariant;
  /** Auto-dismiss after this many ms. Pass 0 to keep it until dismissed. */
  duration?: number;
  /** Optional single action link rendered on the right (e.g. "Undo"). */
  action?: ToastAction;
}

export interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
  duration: number;
  action?: ToastAction;
}

const DEFAULT_DURATION = 4000;
const ERROR_DURATION = 7000;

let nextId = 1;
let items: ToastItem[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ToastItem[] {
  return items;
}

/** Remove a toast by id (no-op if already gone). */
export function dismissToast(id: number): void {
  const next = items.filter((t) => t.id !== id);
  if (next.length !== items.length) {
    items = next;
    emit();
  }
}

function show(message: string, opts: ToastOptions = {}): number {
  const variant = opts.variant ?? "info";
  const duration = opts.duration ?? (variant === "error" ? ERROR_DURATION : DEFAULT_DURATION);
  const id = nextId++;
  items = [...items, { id, message, variant, duration, action: opts.action }];
  emit();
  return id;
}

/** Imperative helper usable anywhere (React or not). Returns the toast id. */
export const toast = {
  show,
  success: (message: string, opts?: Omit<ToastOptions, "variant">) => show(message, { ...opts, variant: "success" }),
  warn: (message: string, opts?: Omit<ToastOptions, "variant">) => show(message, { ...opts, variant: "warn" }),
  error: (message: string, opts?: Omit<ToastOptions, "variant">) => show(message, { ...opts, variant: "error" }),
  info: (message: string, opts?: Omit<ToastOptions, "variant">) => show(message, { ...opts, variant: "info" }),
  dismiss: dismissToast,
};

const VARIANT_ICON: Record<ToastVariant, IconName> = {
  success: "check",
  warn: "warning",
  error: "warning",
  info: "info-circle",
};

function ToastRow({ item }: { item: ToastItem }) {
  // Self-contained auto-dismiss timer (errors linger longer; 0 = sticky).
  useEffect(() => {
    if (item.duration <= 0) return;
    const timer = window.setTimeout(() => dismissToast(item.id), item.duration);
    return () => window.clearTimeout(timer);
  }, [item.id, item.duration]);

  return (
    <div
      className={`toast toast-${item.variant}`}
      role={item.variant === "error" || item.variant === "warn" ? "alert" : "status"}
    >
      <span className="toast-icon">
        <Icon name={VARIANT_ICON[item.variant]} size={15} />
      </span>
      <span className="toast-msg">{item.message}</span>
      {item.action && (
        <button
          className="toast-action"
          onClick={() => {
            item.action!.onClick();
            dismissToast(item.id);
          }}
        >
          {item.action.label}
        </button>
      )}
      <button className="toast-close" aria-label="Dismiss" onClick={() => dismissToast(item.id)}>
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}

/** Mounts the visible toast stack. Render once near the app root. */
export function ToastProvider() {
  const list = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (list.length === 0) return null;
  return (
    <div className="toast-stack" role="region" aria-label="Notifications">
      {list.map((item) => (
        <ToastRow key={item.id} item={item} />
      ))}
    </div>
  );
}
