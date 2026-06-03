import { useEffect, useMemo, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { NodeRecord } from "../api/types";
import { isImage, isVideo } from "../lib/thumbs";
import { formatBytes } from "../utils/formatBytes";
import { formatDate } from "../utils/formatDate";
import { Icon } from "./Icon";
import { EmptyState } from "./EmptyState";

// Media gallery view (roadmap #8). A virtualized, responsive thumbnail grid over
// the current scan tree (images + videos), capitalizing on the server-side
// thumbnail cache (/api/thumbnail). Filter by type and sort by size/date/name;
// clicking a cell selects + reveals it in the tree (onNavigate).
//
// Virtualization is row-based: the container width determines the column count,
// the items are chunked into rows, and only the visible rows are mounted — so a
// scan with tens of thousands of photos scrolls smoothly.

const CELL_TARGET_W = 168; // target cell width (px) before column count is derived
const CELL_GAP = 10;
const ROW_H = 188; // thumbnail box + caption strip

type MediaFilter = "all" | "images" | "videos";
type SortKey = "size" | "date" | "name";

interface GalleryViewProps {
  nodeById: Map<number, NodeRecord>;
  /** Reveal + select a node in the tree. */
  onNavigate: (id: number) => void;
}

function thumbUrl(path: string): string {
  return `/api/thumbnail?path=${encodeURIComponent(path)}`;
}

export function GalleryView({ nodeById, onNavigate }: GalleryViewProps) {
  const [filter, setFilter] = useState<MediaFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("size");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [selectedId, setSelectedId] = useState<number>(-1);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  // All media files in the loaded scan (skip dirs + aggregated bundle nodes).
  const media = useMemo(() => {
    const out: NodeRecord[] = [];
    for (const node of nodeById.values()) {
      if (node.dir || node.id < 0 || !node.path) continue;
      const ext = node.extension ?? "";
      if (isImage(ext) || isVideo(ext)) out.push(node);
    }
    return out;
  }, [nodeById]);

  const counts = useMemo(() => {
    let images = 0, videos = 0;
    for (const n of media) { if (isImage(n.extension ?? "")) images++; else videos++; }
    return { all: media.length, images, videos };
  }, [media]);

  const items = useMemo(() => {
    const filtered = media.filter((n) => {
      if (filter === "images") return isImage(n.extension ?? "");
      if (filter === "videos") return isVideo(n.extension ?? "");
      return true;
    });
    const value = (n: NodeRecord): number | string =>
      sortKey === "name" ? n.name.toLowerCase() : sortKey === "date" ? n.modified : n.size;
    return filtered.sort((a, b) => {
      const av = value(a), bv = value(b);
      return (av < bv ? -1 : av > bv ? 1 : 0) * sortDir;
    });
  }, [media, filter, sortKey, sortDir]);

  // Track the scroll container's content width so the grid reflows responsively.
  useEffect(() => {
    if (!scrollEl) return;
    const measure = () => setWidth(scrollEl.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(scrollEl);
    return () => ro.disconnect();
  }, [scrollEl]);

  const cols = Math.max(1, Math.floor((width + CELL_GAP) / (CELL_TARGET_W + CELL_GAP)));
  const rowCount = Math.ceil(items.length / cols);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollEl,
    estimateSize: () => ROW_H,
    overscan: 4,
  });

  const select = (node: NodeRecord) => {
    setSelectedId(node.id);
    onNavigate(node.id);
  };

  // Click an active sort to flip direction; click a new one to switch to it
  // (size/date default high-first, name defaults A→Z).
  const onSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(key); setSortDir(key === "name" ? 1 : -1); }
  };

  const SORTS: { id: SortKey; label: string }[] = [
    { id: "size", label: "Size" },
    { id: "date", label: "Date" },
    { id: "name", label: "Name" },
  ];
  const FILTERS: { id: MediaFilter; label: string }[] = [
    { id: "all", label: `All (${counts.all.toLocaleString()})` },
    { id: "images", label: `Images (${counts.images.toLocaleString()})` },
    { id: "videos", label: `Videos (${counts.videos.toLocaleString()})` },
  ];

  return (
    <div className="gallery-view">
      <div className="gallery-toolbar">
        <div className="gallery-group" role="tablist" aria-label="Filter media">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              role="tab"
              aria-selected={filter === f.id}
              className={`gallery-chip${filter === f.id ? " active" : ""}`}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="gallery-toolbar-spacer" />
        <div className="gallery-group" aria-label="Sort media">
          <span className="gallery-sort-label">Sort</span>
          {SORTS.map((s) => (
            <button
              key={s.id}
              className={`gallery-chip${sortKey === s.id ? " active" : ""}`}
              onClick={() => onSort(s.id)}
              title={`Sort by ${s.label.toLowerCase()}`}
            >
              {s.label}
              {sortKey === s.id && <Icon name={sortDir === 1 ? "caret-up" : "caret-down"} size={9} className="sort-caret" />}
            </button>
          ))}
        </div>
      </div>

      <div className="gallery-body" ref={setScrollEl}>
        {items.length === 0 ? (
          <EmptyState
            icon="image"
            title={media.length === 0 ? "No media in this scan" : "No matching media"}
            hint={media.length === 0
              ? "Scan a folder with images or videos in the Explorer side bar to browse them here."
              : "No files match the current filter."}
          />
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((vr) => {
              const start = vr.index * cols;
              const rowItems = items.slice(start, start + cols);
              return (
                <div
                  key={vr.key}
                  className="gallery-row"
                  style={{
                    position: "absolute",
                    top: vr.start,
                    left: 0,
                    right: 0,
                    height: ROW_H,
                    gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                    gap: CELL_GAP,
                  }}
                >
                  {rowItems.map((node) => (
                    <GalleryCell
                      key={node.id}
                      node={node}
                      selected={node.id === selectedId}
                      onSelect={select}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function GalleryCell({
  node,
  selected,
  onSelect,
}: {
  node: NodeRecord;
  selected: boolean;
  onSelect: (node: NodeRecord) => void;
}) {
  const [failed, setFailed] = useState(false);
  const video = isVideo(node.extension ?? "");

  return (
    <button
      className={`gallery-cell${selected ? " selected" : ""}`}
      title={`${node.name}\n${formatBytes(node.size)} · ${node.modified ? formatDate(node.modified) : "—"}`}
      onClick={() => onSelect(node)}
    >
      <div className="gallery-thumb">
        {failed ? (
          <span className="gallery-fallback"><Icon name={video ? "film" : "image"} size={30} /></span>
        ) : (
          <img
            src={thumbUrl(node.path)}
            alt={node.name}
            loading="lazy"
            draggable={false}
            onError={() => setFailed(true)}
          />
        )}
        {video && <span className="gallery-badge"><Icon name="film" size={11} /></span>}
      </div>
      <div className="gallery-cap">
        <span className="gallery-name">{node.name}</span>
        <span className="gallery-size">{formatBytes(node.size)}</span>
      </div>
    </button>
  );
}
