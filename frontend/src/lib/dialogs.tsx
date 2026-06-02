// Themed, promise-based confirm & prompt modals.
//
// Replacements for the native window.confirm / window.prompt that match the
// app's in-house dialog styling (the filter / conflict dialogs). Like the
// toast store, the request queue is a module-level singleton, so these can be
// invoked from anywhere — including plain modules such as confirmRisky.ts that
// live outside the React tree:
//
//   const ok = await confirmDialog({ message: "Delete 3 files?" });
//   const name = await promptDialog({ title: "New folder", label: "Name" });
//
// The <DialogProvider/> (mounted once at the app root) renders the active
// request. Requests are served one at a time, in order.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive (red). */
  danger?: boolean;
}

export interface PromptOptions {
  title?: string;
  /** Field label shown above the input. */
  label?: string;
  /** Optional helper text shown under the title. */
  message?: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Return an error string to block submission, or null when the value is OK.
   *  (An empty/whitespace value always blocks submission regardless.) */
  validate?: (value: string) => string | null;
}

type DialogRequest =
  | { kind: "confirm"; id: number; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: "prompt"; id: number; opts: PromptOptions; resolve: (v: string | null) => void };

let nextId = 1;
let queue: DialogRequest[] = [];
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
function getSnapshot(): DialogRequest[] {
  return queue;
}
function settle(id: number): void {
  queue = queue.filter((r) => r.id !== id);
  emit();
}

/** Show a themed confirm modal. Resolves true to proceed, false to cancel. */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    queue = [...queue, { kind: "confirm", id: nextId++, opts, resolve }];
    emit();
  });
}

/** Show a themed text-input modal. Resolves the entered value, or null on cancel. */
export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    queue = [...queue, { kind: "prompt", id: nextId++, opts, resolve }];
    emit();
  });
}

function ConfirmModal({ req }: { req: Extract<DialogRequest, { kind: "confirm" }> }) {
  const { opts, resolve, id } = req;
  const okRef = useRef<HTMLButtonElement>(null);

  const finish = (value: boolean) => {
    resolve(value);
    settle(id);
  };

  useEffect(() => {
    okRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="filter-dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) finish(false);
      }}
    >
      <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-label={opts.title ?? "Confirm"}>
        <div className="fd-header">
          <span className="fd-title">{opts.title ?? "Confirm"}</span>
        </div>
        <div className="cd-body">
          <p className="cd-msg">{opts.message}</p>
        </div>
        <div className="fd-footer">
          <button
            ref={okRef}
            className={`fd-ok primary${opts.danger ? " fd-danger" : ""}`}
            onClick={() => finish(true)}
          >
            {opts.confirmLabel ?? "OK"}
          </button>
          <button className="fd-cancel" onClick={() => finish(false)}>
            {opts.cancelLabel ?? "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PromptModal({ req }: { req: Extract<DialogRequest, { kind: "prompt" }> }) {
  const { opts, resolve, id } = req;
  const [value, setValue] = useState(opts.initialValue ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  const trimmed = value.trim();
  const error = trimmed === "" ? null : opts.validate ? opts.validate(value) : null;
  const canSubmit = trimmed !== "" && !error;

  const submit = () => {
    if (!canSubmit) return;
    resolve(value);
    settle(id);
  };
  const cancel = () => {
    resolve(null);
    settle(id);
  };

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div
      className="filter-dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div className="prompt-dialog" role="dialog" aria-modal="true" aria-label={opts.title ?? "Enter a value"}>
        <div className="fd-header">
          <span className="fd-title">{opts.title ?? "Enter a value"}</span>
        </div>
        <div className="cd-body">
          {opts.message && <p className="cd-msg">{opts.message}</p>}
          <div className="prompt-field">
            {opts.label && <label className="prompt-label">{opts.label}</label>}
            <input
              ref={inputRef}
              className="prompt-input"
              type="text"
              value={value}
              placeholder={opts.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancel();
                }
              }}
            />
            <span className="prompt-error">{error ?? ""}</span>
          </div>
        </div>
        <div className="fd-footer">
          <button className="fd-ok primary" onClick={submit} disabled={!canSubmit}>
            {opts.confirmLabel ?? "OK"}
          </button>
          <button className="fd-cancel" onClick={cancel}>
            {opts.cancelLabel ?? "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Renders the active confirm/prompt modal. Mount once near the app root. */
export function DialogProvider() {
  const requests = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const active = requests[0];
  if (!active) return null;
  return active.kind === "confirm" ? (
    <ConfirmModal key={active.id} req={active} />
  ) : (
    <PromptModal key={active.id} req={active} />
  );
}
