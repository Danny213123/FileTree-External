import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NodeRecord } from "../api/types";
import { useResultTree } from "./useResultTree";

const folder = (id: number, parent: number | null = null) => ({ id, parent, name: String(id), dir: true, depth: 7, children: [] } as unknown as NodeRecord);
const compare = (a: NodeRecord, b: NodeRecord) => a.id - b.id;

describe("filtered result trees", () => {
  it("expands nested results, collapses and reuses loaded children", async () => {
    const load = vi.fn(async (node: NodeRecord) => [folder(node.id + 1, node.id)]);
    const { result } = renderHook(() => useResultTree("bookmarks", [folder(1)], load, compare, vi.fn()));
    act(() => result.current.toggle(1));
    await waitFor(() => expect(result.current.rows.map(row => row.id)).toEqual([1, 2]));
    act(() => result.current.toggle(2));
    await waitFor(() => expect(result.current.rows.map(row => row.depth)).toEqual([0, 1, 2]));
    act(() => result.current.toggle(1));
    expect(result.current.rows.map(row => row.id)).toEqual([1]);
    act(() => result.current.toggle(1));
    expect(result.current.rows.map(row => row.id)).toEqual([1, 2, 3]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("ignores an old expansion when the search or scan changes", async () => {
    let finish!: (rows: NodeRecord[]) => void;
    const load = vi.fn(() => new Promise<NodeRecord[]>(resolve => { finish = resolve; }));
    const { result, rerender } = renderHook(({ query }) => useResultTree(query, [folder(1)], load, compare, vi.fn()), { initialProps: { query: "old" } });
    act(() => result.current.toggle(1));
    rerender({ query: "new" });
    await act(async () => finish([folder(2, 1)]));
    expect(result.current.rows.map(row => row.id)).toEqual([1]);
    expect(result.current.loadedDirs.size).toBe(0);
  });
});
