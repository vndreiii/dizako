import { useCallback, useEffect, useRef, useState } from "react";
import { IconButton } from "./primitives";
import { IconCompare, IconFit, IconZoomIn, IconZoomOut } from "./Icons";

interface Props {
  original: ImageData | null;
  result: ImageData | null;
  busy: boolean;
  ms: number;
  /** Worker unavailable; running on the main thread. */
  degraded?: boolean;
}

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 32;

/**
 * Copies an ImageData into an offscreen canvas we can `drawImage` from.
 *
 * These buffers are deliberately kept out of the document. An in-document
 * canvas at the image's natural size becomes a compositing layer of that size —
 * a 16 MP image is a ~64 MB surface, and WebKit simply fails to paint it,
 * leaving the stage blank while every other layer renders fine.
 */
function toBuffer(
  data: ImageData | null,
  ref: React.MutableRefObject<HTMLCanvasElement | null>,
) {
  if (!data) {
    ref.current = null;
    return;
  }
  let c = ref.current;
  if (!c) {
    c = document.createElement("canvas");
    ref.current = c;
  }
  if (c.width !== data.width || c.height !== data.height) {
    c.width = data.width;
    c.height = data.height;
  }
  c.getContext("2d")!.putImageData(data, 0, 0);
}

export function PreviewCanvas({ original, result, busy, ms, degraded = false }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLCanvasElement>(null);
  const resultBuf = useRef<HTMLCanvasElement | null>(null);
  const originalBuf = useRef<HTMLCanvasElement | null>(null);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [compare, setCompare] = useState(false);
  const [split, setSplit] = useState(0.5);
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const splitDragRef = useRef(false);
  /** Until the user zooms or pans, the view keeps re-fitting as the stage resizes. */
  const touchedRef = useRef(false);

  /**
   * Paints the visible region only. The canvas is always exactly the size of
   * the stage, so zoom and pan are just draw parameters — no oversized element
   * and no oversized compositing layer, at any zoom level.
   */
  const draw = useCallback(() => {
    const view = viewRef.current;
    const stage = stageRef.current;
    if (!view || !stage) return;

    const cw = stage.clientWidth;
    const ch = stage.clientHeight;
    if (cw === 0 || ch === 0) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const bw = Math.round(cw * dpr);
    const bh = Math.round(ch * dpr);
    if (view.width !== bw || view.height !== bh) {
      view.width = bw;
      view.height = bh;
    }
    view.style.width = `${cw}px`;
    view.style.height = `${ch}px`;

    const g = view.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cw, ch);

    const buf = resultBuf.current;
    if (!buf) return;

    const w = buf.width * zoom;
    const h = buf.height * zoom;
    const x = (cw - w) / 2 + pan.x;
    const y = (ch - h) / 2 + pan.y;

    // Nearest-neighbour at or above 1:1 — dithering is a per-pixel art form and
    // smoothing the preview would hide exactly what the user is tuning.
    g.imageSmoothingEnabled = zoom < 1;
    g.imageSmoothingQuality = "high";

    g.save();
    g.shadowColor = "rgba(0, 0, 0, 0.45)";
    g.shadowBlur = 18;
    g.shadowOffsetY = 4;
    g.drawImage(buf, x, y, w, h);
    g.restore();

    const orig = originalBuf.current;
    if (compare && orig) {
      g.save();
      g.beginPath();
      g.rect(0, 0, cw * split, ch);
      g.clip();
      g.drawImage(orig, x, y, w, h);
      g.restore();
    }
  }, [zoom, pan, compare, split]);

  const fit = useCallback(() => {
    const stage = stageRef.current;
    const buf = resultBuf.current;
    if (!stage || !buf) return;
    const pad = 48;
    const cw = stage.clientWidth;
    const ch = stage.clientHeight;
    if (cw === 0 || ch === 0) return;
    const scale = Math.min((cw - pad) / buf.width, (ch - pad) / buf.height, 1);
    setZoom(Math.max(MIN_ZOOM, scale));
    setPan({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    toBuffer(result, resultBuf);
    draw();
  }, [result, draw]);

  useEffect(() => {
    toBuffer(original, originalBuf);
    draw();
  }, [original, draw]);

  // Re-fit when a different image is loaded (dimensions change), but not on
  // every dither pass — that would fight the user's zoom while they tweak.
  const dimsRef = useRef("");
  useEffect(() => {
    if (!result) {
      dimsRef.current = "";
      touchedRef.current = false;
      return;
    }
    const key = `${result.width}x${result.height}`;
    if (key !== dimsRef.current) {
      dimsRef.current = key;
      touchedRef.current = false;
      fit();
    }
  }, [result, fit]);

  // The stage has no size on the first paint, so an early fit computes a
  // nonsense zoom. Watching it means the fit lands once layout is real, and
  // keeps the image framed across window resizes until the user takes over.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (touchedRef.current) draw();
      else fit();
    });
    ro.observe(stage);
    return () => ro.disconnect();
  }, [draw, fit]);

  const onWheel = (e: React.WheelEvent) => {
    if (!result) return;
    e.preventDefault();
    touchedRef.current = true;
    const factor = Math.exp(-e.deltaY * 0.0015);
    setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor)));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!result) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    if (splitDragRef.current) return;
    touchedRef.current = true;
    dragRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (splitDragRef.current && stageRef.current) {
      const r = stageRef.current.getBoundingClientRect();
      setSplit(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
      return;
    }
    const d = dragRef.current;
    if (!d) return;
    setPan({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) });
  };

  const endDrag = () => {
    dragRef.current = null;
    splitDragRef.current = false;
  };

  const zoomBy = (f: number) => {
    touchedRef.current = true;
    setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * f)));
  };

  const hasImage = Boolean(result);
  // The first pass on a large image can take seconds. Until it lands there is
  // no result to draw and the HUD is hidden, so without this the stage is
  // indistinguishable from a broken load.
  const firstPass = busy && !result;

  return (
    <div className="preview">
      <div
        ref={stageRef}
        className={`preview__stage ${hasImage ? "" : "is-empty"}`}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        // Panning is a pointer gesture; without this WebKit also starts its own
        // image drag and the picture appears to be torn out of the window.
        onDragStart={(e) => e.preventDefault()}
      >
        <canvas ref={viewRef} className="preview__view" draggable={false} />

        {firstPass && (
          <div className="preview__loading" role="status" aria-live="polite">
            <span className="preview__spinner" aria-hidden="true" />
            <span>Dithering{original ? ` ${original.width}×${original.height}` : ""}…</span>
          </div>
        )}

        {compare && hasImage && (
          <div
            className="preview__split"
            style={{ left: `${split * 100}%` }}
            onPointerDown={(e) => {
              e.stopPropagation();
              splitDragRef.current = true;
              (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
            }}
          >
            <span className="preview__split-handle" />
          </div>
        )}
      </div>

      {hasImage && (
        <div className="preview__hud">
          <div className="preview__hud-group">
            <IconButton label="Zoom out" onClick={() => zoomBy(1 / 1.4)}>
              <IconZoomOut />
            </IconButton>
            <button className="preview__zoom" onClick={fit} title="Fit to window">
              {Math.round(zoom * 100)}%
            </button>
            <IconButton label="Zoom in" onClick={() => zoomBy(1.4)}>
              <IconZoomIn />
            </IconButton>
            <IconButton label="Fit to window" onClick={fit}>
              <IconFit />
            </IconButton>
          </div>
          <div className="preview__hud-group">
            <IconButton
              label="Compare with original"
              selected={compare}
              onClick={() => setCompare((c) => !c)}
            >
              <IconCompare />
            </IconButton>
          </div>
          <div className="preview__stats">
            {result && (
              <span>
                {result.width}×{result.height}
              </span>
            )}
            <span className={busy ? "is-busy" : ""}>
              {busy ? "rendering…" : `${ms.toFixed(0)} ms`}
            </span>
            {degraded && (
              <span
                className="is-degraded"
                title="Web worker unavailable — dithering on the main thread"
              >
                main thread
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
