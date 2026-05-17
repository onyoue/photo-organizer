import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { PixelOffset, PreviewMode } from "../types/preview";

interface Props {
  src: string | null;
  mode: PreviewMode;
  pixelOffset: PixelOffset;
  onPixelOffsetChange: (o: PixelOffset) => void;
  /** Optional cache-busting suffix appended as `?v=<cacheKey>` to the
   *  resolved asset URL. Used after an in-place file mutation (e.g.
   *  lossless rotate) so the browser doesn't keep serving the old
   *  bytes from its image cache under the same path. */
  cacheKey?: string;
}

export function PreviewPane({ src, mode, pixelOffset, onPixelOffsetChange, cacheKey }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [container, setContainer] = useState({ w: 0, h: 0 });
  const dragStart = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);

  useLayoutEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const update = () => setContainer({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Reset natural dims when src changes — onLoad will repopulate.
  useEffect(() => {
    setNatural({ w: 0, h: 0 });
  }, [src]);

  function clampOffset(dx: number, dy: number): { dx: number; dy: number } {
    // While the image dimensions or container size aren't known yet, leave
    // the offset alone — clamping against zeroed bounds would just snap
    // everything to (0,0).
    if (natural.w === 0 || container.w === 0) return { dx, dy };
    // Keep at least this many CSS pixels of the image visible inside the
    // container along each axis so the user can never drag the photo
    // entirely off-screen and read the pane as black.
    const margin = 60;
    const maxDx = Math.max(0, (container.w + natural.w) / 2 - margin);
    const maxDy = Math.max(0, (container.h + natural.h) / 2 - margin);
    return {
      dx: Math.max(-maxDx, Math.min(maxDx, dx)),
      dy: Math.max(-maxDy, Math.min(maxDy, dy)),
    };
  }

  // After the image dimensions or the container resizes, the previously-
  // stored offset may no longer leave the image on-screen — clamp it back
  // into the visible band so the next render isn't black.
  useEffect(() => {
    if (mode !== "full") return;
    const clamped = clampOffset(pixelOffset.dx, pixelOffset.dy);
    if (clamped.dx !== pixelOffset.dx || clamped.dy !== pixelOffset.dy) {
      onPixelOffsetChange(clamped);
    }
    // clampOffset closes over `natural` and `container`; we deliberately
    // don't list those as deps to keep the dependency list legible — the
    // body re-derives its bounds each call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [natural.w, natural.h, container.w, container.h, pixelOffset, mode]);

  function onMouseDown(e: React.MouseEvent) {
    if (mode !== "full" || !src) return;
    e.preventDefault();
    dragStart.current = {
      x: e.clientX,
      y: e.clientY,
      dx: pixelOffset.dx,
      dy: pixelOffset.dy,
    };

    const onMove = (ev: MouseEvent) => {
      const start = dragStart.current;
      if (!start) return;
      onPixelOffsetChange(
        clampOffset(
          start.dx + (ev.clientX - start.x),
          start.dy + (ev.clientY - start.y),
        ),
      );
    };
    const onUp = () => {
      dragStart.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  if (!src) {
    return (
      <div className="preview-pane empty" ref={containerRef}>
        <div className="preview-empty">No preview available</div>
      </div>
    );
  }

  const baseUrl = convertFileSrc(src);
  const url = cacheKey ? `${baseUrl}?v=${encodeURIComponent(cacheKey)}` : baseUrl;
  const onImgLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    setNatural({
      w: e.currentTarget.naturalWidth,
      h: e.currentTarget.naturalHeight,
    });
  };

  if (mode === "fit") {
    return (
      <div className="preview-pane fit" ref={containerRef}>
        <img
          src={url}
          alt=""
          className="preview-img fit"
          onLoad={onImgLoad}
          draggable={false}
        />
      </div>
    );
  }

  // 100% mode: the image is centered via CSS (`top/left: 50%` + a -50%
  // transform). The pan offset is composed into the same transform here.
  // We deliberately don't gate display on knowing `natural` — the browser
  // already knows the natural size from the file, and waiting for our
  // `onLoad` to round-trip into React state was leaving the pane black
  // for a frame on every fit → full switch.
  return (
    <div
      className="preview-pane full"
      ref={containerRef}
      onMouseDown={onMouseDown}
    >
      <img
        src={url}
        alt=""
        className="preview-img full"
        style={{
          transform: `translate(calc(-50% + ${pixelOffset.dx}px), calc(-50% + ${pixelOffset.dy}px))`,
        }}
        onLoad={onImgLoad}
        draggable={false}
      />
    </div>
  );
}
