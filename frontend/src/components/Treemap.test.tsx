import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeRecord } from "../api/types";
import { Treemap, resolveTreemapViewId } from "./Treemap";

function node(overrides: Partial<NodeRecord> = {}): NodeRecord {
  return {
    id: 0,
    parent: null,
    name: "C:",
    path: "C:\\",
    dir: true,
    link: false,
    hidden: false,
    readonly: false,
    size: 100,
    allocated: 100,
    files: 0,
    folders: 0,
    modified: 0,
    created: 0,
    accessed: 0,
    depth: 0,
    errors: 0,
    extension: "",
    children: [],
    ...overrides,
  };
}

const baseProps = {
  metric: "size" as const,
  unit: "auto" as const,
  detail: 2,
  darkMode: true,
  showSingleFiles: true,
  show3D: false,
  showHierarchy: true,
  showLegend: true,
  showLabels: true,
  dragDrop: false,
  onSelect: vi.fn(),
  onNavigate: vi.fn(),
};

describe("Treemap lazy folder loading", () => {
  beforeEach(() => {
    class ResizeObserverMock {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() {
        this.callback(
          [{ contentRect: { width: 640, height: 240 } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      fillText: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("requests the selected folder and replaces loading once children arrive", async () => {
    const root = node({ children: [1], folders: 1 });
    const folder = node({
      id: 1,
      parent: 0,
      name: "Users",
      path: "C:\\Users",
      depth: 1,
      files: 1,
    });
    const onViewChange = vi.fn();
    const view = render(
      <Treemap
        {...baseProps}
        nodeById={new Map([[0, root], [1, folder]])}
        selectedId={1}
        loadedDirs={new Set([0])}
        onViewChange={onViewChange}
      />,
    );

    expect(screen.getByText("Loading folder contents…")).toBeInTheDocument();
    await waitFor(() => expect(onViewChange).toHaveBeenCalledWith(1));

    const file = node({
      id: 2,
      parent: 1,
      name: "file.bin",
      path: "C:\\Users\\file.bin",
      dir: false,
      depth: 2,
      size: 100,
      allocated: 100,
      files: 1,
      extension: "bin",
    });
    view.rerender(
      <Treemap
        {...baseProps}
        nodeById={new Map([
          [0, root],
          [1, { ...folder, children: [2] }],
          [2, file],
        ])}
        selectedId={1}
        loadedDirs={new Set([0, 1])}
        onViewChange={onViewChange}
      />,
    );

    expect(screen.queryByText("Loading folder contents…")).not.toBeInTheDocument();
  });

  it("uses a selected file's parent as the treemap scope", () => {
    const parent = node({ id: 5, parent: 0, name: "Downloads", path: "C:\\Downloads" });
    const file = node({
      id: 6,
      parent: 5,
      name: "archive.zip",
      path: "C:\\Downloads\\archive.zip",
      dir: false,
      extension: "zip",
    });
    const nodes = new Map([[0, node({ children: [5] })], [5, parent], [6, file]]);

    expect(resolveTreemapViewId(6, nodes)).toBe(5);
  });

  it("shows a real empty state for a loaded empty folder", () => {
    const root = node();
    render(
      <Treemap
        {...baseProps}
        nodeById={new Map([[0, root]])}
        selectedId={0}
        loadedDirs={new Set([0])}
      />,
    );

    expect(screen.getByText("This folder is empty.")).toBeInTheDocument();
  });

  it("keeps the previous frame while a first-time folder visit loads", async () => {
    const folder = node({
      id: 1,
      parent: 0,
      name: "Users",
      path: "C:\\Users",
      depth: 1,
      files: 1,
      size: 60,
    });
    const rootFile = node({
      id: 2,
      parent: 0,
      name: "pagefile.sys",
      path: "C:\\pagefile.sys",
      dir: false,
      depth: 1,
      files: 1,
      size: 40,
    });
    const root = node({ children: [1, 2], folders: 1, files: 2 });
    const initialNodes = new Map([[0, root], [1, folder], [2, rootFile]]);
    const view = render(
      <Treemap
        {...baseProps}
        nodeById={initialNodes}
        selectedId={0}
        loadedDirs={new Set([0])}
      />,
    );
    expect(screen.getByRole("button", { name: /export the treemap/i })).toBeEnabled();

    view.rerender(
      <Treemap
        {...baseProps}
        nodeById={initialNodes}
        selectedId={1}
        loadedDirs={new Set([0])}
      />,
    );

    expect(screen.getByText("Loading Users…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /export the treemap/i })).toBeEnabled();
    expect(screen.queryByText("Loading folder contents…")).not.toBeInTheDocument();

    const child = node({
      id: 3,
      parent: 1,
      name: "profile.dat",
      path: "C:\\Users\\profile.dat",
      dir: false,
      depth: 2,
      files: 1,
      size: 60,
    });
    view.rerender(
      <Treemap
        {...baseProps}
        nodeById={new Map([
          [0, root],
          [1, { ...folder, children: [3] }],
          [2, rootFile],
          [3, child],
        ])}
        selectedId={1}
        loadedDirs={new Set([0, 1])}
      />,
    );

    await waitFor(() => expect(screen.queryByText("Loading Users…")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /export the treemap/i })).toBeEnabled();
  });
});
