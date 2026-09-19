// How many rows one directory expansion may pull, and how they are paged.
//
// Its own module because two places must agree on it and neither should import
// the other: `api/client` uses it to bound a fetch, and `hooks/useTreeState`
// sizes the renderer's node budget from it, so a directory that fits under the
// fetch limit always fits in the store. Putting it in `api/client` made every
// test that mocks that module fail to load.
//
// The pair used to be eight thousand each, chosen independently: a directory of
// that size filled the renderer's whole active reserve by itself, and a
// download folder of twelve thousand entries could never be shown whole
// however it was sorted. Raising it costs roughly a byte per row per node
// field — a few megabytes at this ceiling — against a folder that silently
// lost rows.

export const CHILD_FETCH_LIMIT = 40_000;
export const CHILD_PAGE_SIZE = 500;
