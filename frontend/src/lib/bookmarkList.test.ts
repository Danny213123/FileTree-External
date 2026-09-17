import { describe, expect, it } from "vitest";

import { BOOKMARK_PREVIEW, bookmarkView } from "./bookmarkList";

const many = Array.from({ length: 52 }, (_, index) => `D:\\Media\\Folder ${index + 1}`);

describe("bookmarkView", () => {
  it("shows a short preview when there are many", () => {
    const view = bookmarkView(many, "", false);
    expect(view.visible).toHaveLength(BOOKMARK_PREVIEW);
    expect(view.matched).toBe(52);
    expect(view.truncated).toBe(true);
  });

  it("does not truncate a list that already fits", () => {
    const view = bookmarkView(many.slice(0, 5), "", false);
    expect(view.visible).toHaveLength(5);
    expect(view.truncated).toBe(false);
  });

  it("shows everything once asked", () => {
    const view = bookmarkView(many, "", true);
    expect(view.visible).toHaveLength(52);
    expect(view.truncated).toBe(false);
  });

  it("matches the whole path, not just the leaf", () => {
    const view = bookmarkView(["D:\\Photos\\2024", "E:\\Backups\\old"], "photos", false);
    expect(view.visible).toEqual(["D:\\Photos\\2024"]);
  });

  it("never hides a match behind Show all", () => {
    const view = bookmarkView(many, "folder", false);
    expect(view.visible).toHaveLength(52);
    expect(view.truncated).toBe(false);
  });

  it("reports no matches for a filter that finds nothing", () => {
    expect(bookmarkView(many, "nothing here", false)).toEqual({ visible: [], matched: 0, truncated: false });
  });
});
