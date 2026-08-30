import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class MockChannel<T> {
    onmessage?: (value: T) => void;
  },
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { fetchServerSearch } from "./client";

describe("v2 server search", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    vi.mocked(invoke).mockReset();
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("issues one bounded SQLite page per search edit", async () => {
    vi.mocked(invoke).mockResolvedValue({
      items: [],
      total: 1_200,
      offset: 0,
      limit: 500,
      hasMore: true,
    });

    const result = await fetchServerSearch({
      rootPath: "E:\\",
      scanId: "search-regression",
      query: "summer video",
      limit: 2_000,
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("scan_page", expect.objectContaining({
      query: expect.objectContaining({ limit: 500, offset: 0, search: "summer video" }),
    }));
    expect(result).toEqual({ matches: [], total: 1_200, capped: true });
  });
});
