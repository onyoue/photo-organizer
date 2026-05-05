import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { PixelOffset, PreviewMode } from "../types/preview";

interface Props {
  src: string | null;
  mode: PreviewMode;
  pixelOffset: PixelOffset;
  onPixelOffsetChange: (o: PixelOffset) => void;
}

export function PreviewPane({ src, mode, pixelOffset, onPixelOffsetChange }: Props) {
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

  const url = convertFileSrc(src);
  const ready = natural.w > 0 && natural.h > 0;

  if (mode === "fit") {
    return (
      <div className="preview-pane fit" ref={containerRef}>
        <img
          src={url}
          alt=""
          className="preview-img fit"
          onLoad={(e) =>
            setNatural({
              w: e.currentTarget.naturalWidth,
              h: e.currentTarget.naturalHeight,
            })
          }
          draggable={false}
        />
      </div>
    );
  }

  // full (100%) mode: pan with drag, position from pixelOffset.
  const imgX = (container.w - natural.w) / 2 + pixelOffset.dx;
  const imgY = (container.h - natural.h) / 2 + pixelOffset.dy;
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
        style={{ left: imgX, top: imgY, opacity: ready ? 1 : 0 }}
        onLoad={(e) =>
          setNatural({
            w: e.currentTarget.naturalWidth,
            h: e.currentTarget.naturalHeight,
          })
        }
        draggable={false}
      />
    </div>
  );
}
