import { useCallback, useEffect, useRef, useState } from "react";
import { IconButton } from "./primitives";
import { IconCompare, IconFit, IconTimer, IconZoomIn, IconZoomOut } from "./Icons";
import type { Rect } from "../dither/region";
import type { Layer } from "../hooks/useDither";
import { useI18n } from "../i18n";

interface Props {
  original: ImageData | null;
  /** Whole-image pass, possibly at reduced resolution. */
  coarse: Layer | null;
  /** Source pixels each coarse pixel stands for. */
  coarseScale: number;
  /** Full-resolution pass covering `region`, drawn over the coarse layer. */
  fine: Layer | null;
  region: Rect | null;
  busy: boolean;
  refining: boolean;
  ms: number;
  /** The preferred pipeline rung failed; running somewhere slower. */
  degraded?: boolean;
  /** Which rung rendered the current frame ("worker", "main", …). */
  backendLabel?: string;
  /** No engine could be initialised anywhere; the preview cannot render. */
  error?: string | null;
  /** Reports the visible part of the image, in source pixels. */
  onViewport?: (r: Rect | null) => void;
}

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 32;

/**
 * Copies an ImageData into an offscreen canvas we can `drawImage` from.
 *
 * These buffers are deliberately kept out of the document. An in-document
 * canvas at the image's natural size becomes a compositing layer of that size -
 * a 16 MP image is a ~64 MB surface, and WebKit simply fails to paint it,
 * leaving the stage blank while every other layer renders fine.
 *
 * Only the untouched source goes through here: dither results arrive as
 * `ImageBitmap`s from the worker and are drawn directly.
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

/** Full image size in source pixels, taken from whichever layer we have.
 *  A layer whose dimensions disagree with the original is stale output from
 *  a previous image; it must never be stretched over the new one. */
function layerSize(layer: ImageData | ImageBitmap | null, coarseScale: number) {
  if (!layer) return null;
  return { width: layer.width * coarseScale, height: layer.height * coarseScale };
}

export function PreviewCanvas({
  original,
  coarse,
  coarseScale,
  fine,
  region,
  busy,
  refining,
  ms,
  degraded = false,
  backendLabel = "worker",
  error = null,
  onViewport,
}: Props) {
  const { t } = useI18n();
  const stageRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLCanvasElement>(null);
  const originalBuf = useRef<HTMLCanvasElement | null>(null);
  // Scratch uploads for the rare main-thread-fallback ImageData results.
  const coarseBuf = useRef<HTMLCanvasElement | null>(null);
  const fineBuf = useRef<HTMLCanvasElement | null>(null);

  /** Bitmaps draw directly; raw planes go through an offscreen canvas once. */
  function asDrawable(
    layer: Layer,
    slot: React.MutableRefObject<HTMLCanvasElement | null>,
  ): CanvasImageSource {
    if (layer instanceof ImageBitmap) return layer;
    toBuffer(layer, slot);
    return slot.current!;
  }

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [compare, setCompare] = useState(false);
  const [split, setSplit] = useState(0.5);
  const [zoomInput, setZoomInput] = useState("");
  const [isZoomFocused, setIsZoomFocused] = useState(false);
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const splitDragRef = useRef(false);
  /** Until the user zooms or pans, the view keeps re-fitting as the stage resizes. */
  const touchedRef = useRef(false);
  const reportedRef = useRef<string>("");
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  const hasImageRef = useRef(false);
  useEffect(() => {
    zoomRef.current = zoom;
    panRef.current = pan;
  }, [zoom, pan]);

  /**
   * Pointer and wheel events land faster than frames; applying them directly
   * makes React commit several times per frame on high-frequency mice. The
   * latest event wins and one rAF applies it - same frame budget, no queue.
   */
  const pendingGesture = useRef<(() => void) | null>(null);
  const gestureFrame = useRef<number | undefined>(undefined);
  const scheduleGesture = useCallback((apply: () => void) => {
    pendingGesture.current = apply;
    if (gestureFrame.current !== undefined) return;
    gestureFrame.current = requestAnimationFrame(() => {
      gestureFrame.current = undefined;
      const run = pendingGesture.current;
      pendingGesture.current = null;
      run?.();
    });
  }, []);
  useEffect(
    () => () => {
      if (gestureFrame.current !== undefined) cancelAnimationFrame(gestureFrame.current);
    },
    [],
  );

  /** Full image size in source pixels, taken from whichever layer we have. */
  const sourceSize = useCallback(() => {
    if (original) return { width: original.width, height: original.height };
    return layerSize(coarse, coarseScale);
  }, [original, coarse, coarseScale]);

  /**
   * True when the base layer belongs to a different image than `original`.
   *
   * Compares against the EXPECTED downscale dimensions rather than
   * reconstructing the full size from the scale factor: the scale is derived
   * from width alone, so `bitmapHeight * scale` drifts by a pixel on most
   * aspect ratios and strict equality rejected every legitimate frame
   * (blank canvas at 341 ms). Fine layers are viewport crops by construction,
   * so they are exempt; cross-image ghosts cannot reach them anyway because
   * the hook tags results with their source.
   */
  const baseIsStale = useCallback(
    (layer: Layer | null) => {
      if (!layer || !original) return false;
      if (coarseScale === 1) {
        return layer.width !== original.width || layer.height !== original.height;
      }
      const ew = Math.round(original.width / coarseScale);
      const eh = Math.round(original.height / coarseScale);
      return Math.abs(layer.width - ew) > 1 || Math.abs(layer.height - eh) > 1;
    },
    [original, coarseScale],
  );

  /**
   * Paints the visible region only. The canvas is always exactly the size of
   * the stage, so zoom and pan are just draw parameters - no oversized element
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

    const size = sourceSize();
    // A base layer from the previous image would render stretched into this
    // one's aspect ratio; drop stale layers instead of drawing them.
    if (!size || !coarse || baseIsStale(coarse)) return;

    const w = size.width * zoom;
    const h = size.height * zoom;
    const x = (cw - w) / 2 + pan.x;
    const y = (ch - h) / 2 + pan.y;

    // Nearest-neighbour at or above 1:1 - dithering is a per-pixel art form and
    // smoothing the preview would hide exactly what the user is tuning.
    g.imageSmoothingEnabled = zoom < 1;
    g.imageSmoothingQuality = "high";

    // A blurred shadow is one of the slowest 2D-canvas operations in WebKitGTK
    // and panning repaints continuously, so it is skipped mid-drag.
    g.save();
    if (!dragRef.current && !splitDragRef.current) {
      g.shadowColor = "rgba(0, 0, 0, 0.45)";
      g.shadowBlur = 18;
      g.shadowOffsetY = 4;
    }
    g.drawImage(asDrawable(coarse, coarseBuf), x, y, w, h);
    g.restore();

    // The sharp pass goes over the top, aligned to the region it covers. Until
    // it lands, the coarse layer showing through is what makes a slider drag
    // feel immediate.
    if (fine) {
      const sharp = asDrawable(fine, fineBuf);
      if (region) {
        g.drawImage(sharp, x + region.x * zoom, y + region.y * zoom, region.width * zoom, region.height * zoom);
      } else {
        g.drawImage(sharp, x, y, w, h);
      }
    }

    const orig = originalBuf.current;
    if (compare && orig) {
      g.save();
      g.beginPath();
      g.rect(0, 0, cw * split, ch);
      g.clip();
      g.drawImage(orig, x, y, w, h);
      g.restore();
    }

    // Tell the hook which source pixels are actually on screen, so the next
    // full-resolution pass can skip everything that is not.
    if (onViewport) {
      const vx = Math.max(0, -x / zoom);
      const vy = Math.max(0, -y / zoom);
      const vw = Math.min(size.width - vx, cw / zoom);
      const vh = Math.min(size.height - vy, ch / zoom);
      const next: Rect | null =
        vw <= 0 || vh <= 0 ? null : { x: vx, y: vy, width: vw, height: vh };
      // Quantise before comparing: sub-pixel drift during a drag would
      // otherwise fire a new render on every frame.
      const key = next
        ? [next.x, next.y, next.width, next.height].map((v) => Math.round(v / 24)).join(",")
        : "";
      if (key !== reportedRef.current) {
        reportedRef.current = key;
        onViewport(next);
      }
    }
  }, [zoom, pan, compare, split, region, sourceSize, baseIsStale, coarse, fine, onViewport]);

  const fit = useCallback(() => {
    const stage = stageRef.current;
    const size = sourceSize();
    if (!stage || !size) return;
    const pad = 48;
    const cw = stage.clientWidth;
    const ch = stage.clientHeight;
    if (cw === 0 || ch === 0) return;
    const scale = Math.min((cw - pad) / size.width, (ch - pad) / size.height, 1);
    setZoom(Math.max(MIN_ZOOM, scale));
    setPan({ x: 0, y: 0 });
  }, [sourceSize]);

  useEffect(() => {
    toBuffer(original, originalBuf);
    draw();
  }, [original, draw]);

  // Re-fit when a different image is loaded (dimensions change), but not on
  // every dither pass - that would fight the user's zoom while they tweak.
  const dimsRef = useRef("");
  useEffect(() => {
    const size = sourceSize();
    if (!size) {
      dimsRef.current = "";
      touchedRef.current = false;
      return;
    }
    const key = `${Math.round(size.width)}x${Math.round(size.height)}`;
    if (key !== dimsRef.current) {
      dimsRef.current = key;
      touchedRef.current = false;
      fit();
    }
  }, [coarse, sourceSize, fit]);

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

  const hasImage = Boolean(coarse);
  useEffect(() => {
    hasImageRef.current = hasImage;
  }, [hasImage]);

  /**
   * Zoom keeping the source pixel under the cursor fixed.
   *
   * Trackpad pinch and mouse-wheel zoom both land here. Without the pan
   * correction the image scales around the stage centre, which feels like the
   * page itself is zooming rather than the canvas contents.
   */
  const zoomAt = useCallback(
    (clientX: number, clientY: number, factor: number) => {
      const stage = stageRef.current;
      const size = sourceSize();
      if (!stage || !size) return;
      const cw = stage.clientWidth;
      const ch = stage.clientHeight;
      if (cw === 0 || ch === 0) return;
      const rect = stage.getBoundingClientRect();
      const mx = clientX - rect.left;
      const my = clientY - rect.top;
      const z = zoomRef.current;
      const p = panRef.current;
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor));
      if (next === z) return;
      const x = (cw - size.width * z) / 2 + p.x;
      const y = (ch - size.height * z) / 2 + p.y;
      const ix = (mx - x) / z;
      const iy = (my - y) / z;
      const nx = mx - ix * next;
      const ny = my - iy * next;
      touchedRef.current = true;
      zoomRef.current = next;
      panRef.current = {
        x: nx - (cw - size.width * next) / 2,
        y: ny - (ch - size.height * next) / 2,
      };
      setZoom(next);
      setPan(panRef.current);
    },
    [sourceSize],
  );

  /**
   * Native, non-passive wheel listener.
   *
   * React 17+ attaches root `wheel` listeners as passive, so `preventDefault`
   * inside `onWheel` cannot stop browser/WebView pinch-zoom of the whole UI.
   * Handling the event here keeps pinch on the canvas. Horizontal two-finger
   * swipes are swallowed so the WebView cannot navigate, then bubble to App
   * which maps them to undo/redo.
   */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const onWheel = (e: WheelEvent) => {
      // Always swallow ctrl/meta+wheel over the stage so the WebView cannot
      // page-zoom even before an image is loaded.
      const pinch = e.ctrlKey || e.metaKey;
      if (!hasImageRef.current) {
        if (pinch) e.preventDefault();
        return;
      }

      e.preventDefault();

      // Pinch is zoom-only. Two-finger trackpad motion (pixel deltas) pans /
      // orbits the canvas in any direction so it never becomes undo/redo.
      // Discrete mouse-wheel notches (line/page mode) still zoom.
      if (!pinch && e.deltaMode === 0) {
        if (e.deltaX === 0 && e.deltaY === 0) return;
        touchedRef.current = true;
        scheduleGesture(() => {
          const p = panRef.current;
          const next = { x: p.x - e.deltaX, y: p.y - e.deltaY };
          panRef.current = next;
          setPan(next);
        });
        return;
      }

      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 32 : e.deltaY;
      if (dy === 0 && !pinch) return;
      const factor = Math.exp(-dy * (pinch ? 0.01 : 0.0015));
      scheduleGesture(() => zoomAt(e.clientX, e.clientY, factor));
    };

    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [scheduleGesture, zoomAt]);

  /**
   * Native Linux pinch (WebKitGTK GestureZoom) is forwarded from Rust as
   * `dizako-pinch` because the gesture never becomes a cancellable wheel event.
   */
  useEffect(() => {
    const onPinch = (e: Event) => {
      if (!hasImageRef.current) return;
      const factor = (e as CustomEvent<{ factor?: number }>).detail?.factor;
      if (!factor || !Number.isFinite(factor) || factor <= 0) return;
      const stage = stageRef.current;
      if (!stage) return;
      const r = stage.getBoundingClientRect();
      scheduleGesture(() => zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor));
    };
    window.addEventListener("dizako-pinch", onPinch);
    return () => window.removeEventListener("dizako-pinch", onPinch);
  }, [scheduleGesture, zoomAt]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!hasImage) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    if (splitDragRef.current) return;
    touchedRef.current = true;
    dragRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (splitDragRef.current && stageRef.current) {
      const r = stageRef.current.getBoundingClientRect();
      scheduleGesture(() => setSplit(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))));
      return;
    }
    const d = dragRef.current;
    if (!d) return;
    scheduleGesture(() => setPan({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) }));
  };

  const endDrag = () => {
    dragRef.current = null;
    splitDragRef.current = false;
  };

  const zoomBy = (f: number) => {
    const stage = stageRef.current;
    if (!stage) {
      touchedRef.current = true;
      setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * f)));
      return;
    }
    const r = stage.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, f);
  };

  const size = sourceSize();
  // The first pass on a large image can take seconds. Until it lands there is
  // no result to draw and the HUD is hidden, so without this the stage is
  // indistinguishable from a broken load.
  const firstPass = busy && !coarse;

  return (
    <div className="preview">
      <div
        ref={stageRef}
        className={`preview__stage ${hasImage ? "" : "is-empty"}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        // Panning is a pointer gesture; without this WebKit also starts its own
        // image drag and the picture appears to be torn out of the window.
        onDragStart={(e) => e.preventDefault()}
      >
        <canvas ref={viewRef} className="preview__view" draggable={false} />

        {!coarse && error && (
          <div className="preview__loading" role="alert">
            <span>{t("preview.unavailable").replace("{error}", error)}</span>
          </div>
        )}

        {firstPass && (
          <div className="preview__loading" role="status" aria-live="polite">
            <span className="preview__spinner" aria-hidden="true" />
            <span>
              {original
                ? t("hud.ditheringWithSize")
                    .replace("{w}", String(original.width))
                    .replace("{h}", String(original.height))
                : t("hud.dithering")}
            </span>
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
        <div
          className={`preview__engine ${degraded ? "is-degraded" : ""}`}
          title={
            degraded
              ? "Preferred render pipeline unavailable - running on a slower rung"
              : "Render engine"
          }
        >
          {backendLabel}
        </div>
      )}

      {hasImage && (
        <div className="preview__hud">
          <div className="preview__hud-group">
            <IconButton label={t("hud.fit")} onClick={fit}>
              <IconFit />
            </IconButton>
            <IconButton label={t("hud.zoomOut")} onClick={() => zoomBy(1 / 1.4)}>
              <IconZoomOut />
            </IconButton>
            <input
              type="text"
              className="preview__zoom"
              title={t("hud.zoomPercent")}
              value={isZoomFocused ? zoomInput : Math.round(zoom * 100) + "%"}
              onFocus={() => {
                setZoomInput(Math.round(zoom * 100).toString());
                setIsZoomFocused(true);
              }}
              onBlur={() => {
                setIsZoomFocused(false);
                const parsed = parseInt(zoomInput.replace(/[^0-9]/g, ''), 10);
                if (!isNaN(parsed)) {
                  setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, parsed / 100)));
                }
              }}
              onChange={(e) => setZoomInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
            <IconButton label={t("hud.zoomIn")} onClick={() => zoomBy(1.4)}>
              <IconZoomIn />
            </IconButton>
          </div>
          <div className="preview__hud-group">
            <IconButton
              label={t("hud.compare")}
              selected={compare}
              onClick={() => setCompare((c) => !c)}
            >
              <IconCompare />
            </IconButton>
          </div>
          <div className="preview__stats">
            {size && (
              <span>
                {Math.round(size.width)}×{Math.round(size.height)}
              </span>
            )}
            <span className={`preview__timing ${refining ? "is-busy" : ""}`}>
              <IconTimer />
              {refining ? t("hud.refining") : `${ms.toFixed(0)} ms`}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
