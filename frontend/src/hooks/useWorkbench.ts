import { useSyncExternalStore } from "react";
import type { SidebarModel } from "../components/WorkspaceTab";
import type { ScanStatus, ProgressStore } from "./useScan";

// Everything the shared App-shell consumers (the Explorer side bar's folder
// list, the status bar counts, the inspector, the reports view) need from the
// CURRENTLY FOCUSED workspace pane. It bundles the focused pane's sidebar model
// (tree rows, expansion, selection, handlers…) with its scan status fields.
export interface WorkbenchSnapshot {
  sidebar: SidebarModel;
  status: ScanStatus;
  errorMessage: string;
  visibleCount: number;
  /** The focused pane's live scan-progress store (stable per tab), forwarded to
   *  the status bar so its counter subscribes independently. */
  progressStore: ProgressStore | null;
}

// A tiny external store (same shape + intent as useScan's ProgressStore): the
// focused pane PUBLISHES a fresh snapshot whenever its tree/selection/scan state
// changes, and only the leaf consumers that subscribe via useSyncExternalStore
// re-render — so expand / filter / select / scroll no longer re-render the whole
// App shell (title bar, menus, tab bar, side-bar chrome).
export interface WorkbenchStore {
  /** Current snapshot (also the useSyncExternalStore getSnapshot). */
  get: () => WorkbenchSnapshot;
  /** Publish a new snapshot and notify subscribers. */
  set: (s: WorkbenchSnapshot) => void;
  /** Subscribe to changes; returns an unsubscribe fn (useSyncExternalStore). */
  subscribe: (listener: () => void) => () => void;
}

export function createWorkbenchStore(initial: WorkbenchSnapshot): WorkbenchStore {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (s) => {
      value = s;
      for (const l of listeners) l();
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

/** Subscribe to a {@link WorkbenchStore}; the component re-renders only when the
 *  focused pane publishes a new snapshot. */
export function useWorkbench(store: WorkbenchStore): WorkbenchSnapshot {
  return useSyncExternalStore(store.subscribe, store.get);
}
