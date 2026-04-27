import { useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { BundleSummary } from "../types/bundle";
import type { ThumbMap } from "../types/thumb";
import { BundleTile } from "./BundleTile";

interface Props {
  bundles: BundleSummary[];
  thumbs: ThumbMap;
  selectedId: string | null;
  onSelect: (id: string) => void;
  tileSize: number;
}

const COL_GAP = 8;
const ROW_GAP = 8;
const CAPTION_HEIGHT = 36;
const SCROLLER_PADDING = 8;

export function ThumbnailGrid({ bundles, thumbs, selectedId, onSelect, tileSize }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    if (!parentRef.current) return;
    const el = parentRef.current;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => {
      setWidth(el.clientWidth);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const usableWidth = Math.max(0, width - SCROLLER_PADDING * 2);
  const cols = Math.max(
    1,
    Math.floor((usableWidth + COL_GAP) / (tileSize + COL_GAP)),
  );
  const rows = Math.ceil(bundles.length / cols);
  const rowSize = tileSize + CAPTION_HEIGHT + ROW_GAP;

  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowSize,
    overscan: 3,
  });

  return (
    <div ref={parentRef} className="grid-scroller">
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: "100%",
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((row) => (
          <div
            key={row.key}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              height: rowSize,
              transform: `translateY(${row.start}px)`,
              display: "grid",
              gridTemplateColumns: `repeat(${cols}, ${tileSize}px)`,
              columnGap: `${COL_GAP}px`,
              justifyContent: "center",
              padding: `0 ${SCROLLER_PADDING}px`,
              boxSizing: "border-box",
            }}
          >
            {Array.from({ length: cols }, (_, c) => {
              const idx = row.index * cols + c;
              const b = bundles[idx];
              if (!b) return <div key={`pad-${c}`} />;
              const thumb = thumbs[b.bundle_id] ?? { kind: "none" as const };
              return (
                <BundleTile
                  key={b.bundle_id}
                  bundle={b}
                  thumb={thumb}
                  selected={selectedId === b.bundle_id}
                  size={tileSize}
                  onClick={() => onSelect(b.bundle_id)}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
