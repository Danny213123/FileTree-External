// Which bookmarks the sidebar shows.
//
// A handful of bookmarks is a list; fifty is a wall that buries every section
// under it. So the section shows a short preview by default, filters by name or
// path when asked, and only grows to the full list on request — the same
// bargain the Recent section already makes by showing its last eight paths.

/** How many bookmarks the section shows before "Show all". */
export const BOOKMARK_PREVIEW = 8;

export interface BookmarkView {
  /** The rows to render. */
  visible: string[];
  /** Bookmarks matching the filter, before the preview cap. */
  matched: number;
  /** True when rows are being withheld and "Show all" is worth offering. */
  truncated: boolean;
}

/**
 * Filter is matched against the whole path, so "2024" finds
 * `D:\Photos\2024` even though the row shows only its leaf name.
 *
 * A filter always shows every match: someone who typed a query is looking for
 * something specific, and hiding matches behind "Show all" would be a trap.
 */
export function bookmarkView(
  bookmarks: string[],
  filter: string,
  showAll: boolean,
  preview = BOOKMARK_PREVIEW,
): BookmarkView {
  const needle = filter.trim().toLowerCase();
  const matches = needle
    ? bookmarks.filter((bookmark) => bookmark.toLowerCase().includes(needle))
    : bookmarks;
  if (needle || showAll || matches.length <= preview) {
    return { visible: matches, matched: matches.length, truncated: false };
  }
  return { visible: matches.slice(0, preview), matched: matches.length, truncated: true };
}
