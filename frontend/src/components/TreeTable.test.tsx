import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 23,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({
      index,
      key: index,
      start: index * 23,
      size: 23,
    })),
  }),
}));

vi.mock("./FileIcon", () => ({
  FileIcon: () => <span data-testid="file-icon" />,
}));

import type { NodeRecord } from "../api/types";
import { TreeTable } from "./TreeTable";

const file: NodeRecord = {
  id: 42,
  parent: 9,
  name: "clip.mp4",
  path: "E:\\Media\\clip.mp4",
  dir: false,
  link: false,
  hidden: false,
  readonly: false,
  size: 1024,
  allocated: 4096,
  files: 1,
  folders: 0,
  modified: 0,
  created: 0,
  accessed: 0,
  depth: 2,
  errors: 0,
  extension: "mp4",
  children: [],
};

describe("TreeTable double click", () => {
  it("opens the displayed paged row even when it is absent from nodeById", () => {
    const onDoubleClick = vi.fn();
    render(
      <TreeTable
        rows={[file]}
        flat
        lazy
        nodeById={new Map()}
        expanded={new Set()}
        selectedId={0}
        selectedIds={new Set()}
        sortKey="name"
        sortDir={1}
        metric="size"
        unit="auto"
        decimals={1}
        visibleColumns={new Set(["name"])}
        columnWidths={{}}
        onColumnResize={vi.fn()}
        bookmarks={new Set()}
        onToggleExpand={vi.fn()}
        onSelect={vi.fn()}
        onDoubleClick={onDoubleClick}
        onContextMenu={vi.fn()}
        onSortChange={vi.fn()}
        onToggleBookmark={vi.fn()}
      />,
    );

    fireEvent.doubleClick(screen.getByText("clip.mp4"));
    expect(onDoubleClick).toHaveBeenCalledOnce();
    expect(onDoubleClick).toHaveBeenCalledWith(file);
  });
});

describe("TreeTable lazy expansion", () => {
  const unknownDirectory: NodeRecord = {
    ...file,
    id: 77,
    parent: 0,
    name: "New folder",
    path: "E:\\New folder",
    dir: true,
    size: 0,
    allocated: 0,
    files: 0,
    folders: 0,
    extension: "",
    children: [],
  };

  function renderDirectory(loadedDirs: ReadonlySet<number>) {
    const onToggleExpand = vi.fn();
    const view = render(
      <TreeTable
        rows={[unknownDirectory]}
        lazy
        loadedDirs={loadedDirs}
        nodeById={new Map([[unknownDirectory.id, unknownDirectory]])}
        expanded={new Set()}
        selectedId={0}
        selectedIds={new Set()}
        sortKey="name"
        sortDir={1}
        metric="size"
        unit="auto"
        decimals={1}
        visibleColumns={new Set(["name"])}
        columnWidths={{}}
        onColumnResize={vi.fn()}
        bookmarks={new Set()}
        onToggleExpand={onToggleExpand}
        onSelect={vi.fn()}
        onDoubleClick={vi.fn()}
        onContextMenu={vi.fn()}
        onSortChange={vi.fn()}
        onToggleBookmark={vi.fn()}
      />,
    );
    return { ...view, onToggleExpand };
  }

  it("keeps an unknown zero-count directory expandable until it is loaded", () => {
    const view = renderDirectory(new Set());
    const twisty = view.container.querySelector<HTMLButtonElement>("button.twisty");
    expect(twisty).not.toBeNull();
    fireEvent.click(twisty!);
    expect(view.onToggleExpand).toHaveBeenCalledWith(unknownDirectory.id);

    view.unmount();
    const loadedView = renderDirectory(new Set([unknownDirectory.id]));
    expect(loadedView.container.querySelector("button.twisty")).toBeNull();
  });
});
