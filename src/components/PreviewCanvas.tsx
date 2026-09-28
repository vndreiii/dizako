import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconButton } from "./primitives";
import { IconCompare, IconFit, IconTimer, IconZoomIn, IconZoomOut } from "./Icons";
import type { Rect } from "../dither/region";
import type { Layer } from "../hooks/useDither";
import { createDrawableCache, drawVisible } from "./previewDrawing";
import { useI18n } from "../i18n";

interface Props {
  wheelBehavior: "pan" | "zoom";
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
  /** Extra chrome docked under the stage, e.g. the video transport. */
  footer?: React.ReactNode;
}

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 32;
/** The zoom readout is React state; this is how often it may re-render. */
const HUD_SYNC_MS = 120;

/** Full image size in source pixels, taken from whichever layer we have.
 *  A layer whose dimensions disagree with the original is stale output from
 *  a previous image; it must never be stretched over the new one. */
function layerSize(layer: ImageData | ImageBitmap | null, coarseScale: number) {
  if (!layer) return null;
  return { width: layer.width * coarseScale, height: layer.height * coarseScale };
}

export function PreviewCanvas({
  wheelBehavior,
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
  footer,
}: Props) {
  const { t } = useI18n();
  const stageRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const originalDrawable = useRef(createDrawableCache());
  const coarseDrawable = useRef(createDrawableCache());
  const fineDrawable = useRef(createDrawableCache());
  const viewportTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /**
   * The view transform lives in refs, not in state.
   *
   * A wheel or pinch produces events faster than the display refreshes. When
   * each one went through `setState` the sequence per frame was
   * event → commit → effect → paint, several times over, and React's
   * reconciliation was costing more than the drawing. Now the transform is
   * mutated directly and one rAF paints the result; React only ever learns the
   * zoom level so it can print it, on a timer. Navigation stops being a render
   * concern at all, which is what makes it feel attached to the finger.
   */
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const [hudZoom, setHudZoom] = useState(1);
  const hudTimer = useRef<number | undefined>(undefined);
  const paintFrame = useRef<number | undefined>(undefined);

  const [compare, setCompare] = useState(false);
  const [split, setSplit] = useState(0.5);
  const [zoomInput, setZoomInput] = useState("");
  const [isZoomFocused, setIsZoomFocused] = useState(false);
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const splitDragRef = useRef(false);
  /** Until the user zooms or pans, the view keeps re-fitting as the stage resizes. */
  const touchedRef = useRef(false);
  const reportedRef = useRef<string>("");
  const hasImageRef = useRef(false);

  /**
   * Everything `paint` reads, bound at render time.
   *
   * Keeping the scene in a ref is what lets `paint` be a stable function: it
   * never needs re-creating when a new pass lands, so no listener and no rAF
   * callback ever holds a stale closure.
   */
  const scene = useRef({ original, coarse, coarseScale, fine, region, compare, split, onViewport });
  // eslint-disable-next-line react-hooks/refs -- intentional render-time binding
  scene.current = { original, coarse, coarseScale, fine, region, compare, split, onViewport };

  const sourceSize = useCallback(() => {
    const s = scene.current;
    if (s.original) return { width: s.original.width, height: s.original.height };
    return layerSize(s.coarse, s.coarseScale);
  }, []);

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
  const baseIsStale = useCallback((layer: Layer | null) => {
    const { original: src, coarseScale: cs } = scene.current;
    if (!layer || !src) return false;
    if (cs === 1) return layer.width !== src.width || layer.height !== src.height;
    const ew = Math.round(src.width / cs);
    const eh = Math.round(src.height / cs);
    return Math.abs(layer.width - ew) > 1 || Math.abs(layer.height - eh) > 1;
  }, []);

  /** Mirrors the ref-held zoom into state at most every HUD_SYNC_MS. */
  const syncHud = useCallback(() => {
    if (hudTimer.current !== undefined) return;
    hudTimer.current = window.setTimeout(() => {
      hudTimer.current = undefined;
      setHudZoom(zoomRef.current);
    }, HUD_SYNC_MS);
  }, []);

  /**
   * Paints the visible region only. The canvas is always exactly the size of
   * the stage, so zoom and pan are just draw parameters - no oversized element
   * and no oversized compositing layer, at any zoom level.
   */
  const paint = useCallback(() => {
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
      // Resizing the backing store resets context state, so the cached context
      // has to be re-configured rather than merely reused.
      ctxRef.current = null;
    }
    // Style size is set once per size change; assigning it every frame forced a
    // style recalculation on the stage for no visible benefit.
    if (view.style.width !== `${cw}px`) view.style.width = `${cw}px`;
    if (view.style.height !== `${ch}px`) view.style.height = `${ch}px`;

    let g = ctxRef.current;
    if (!g) {
      // `desynchronized` lets WebKit skip a compositor round-trip per frame,
      // which is exactly the latency a pan gesture is judged on.
      g = view.getContext("2d", { alpha: true, desynchronized: true }) as CanvasRenderingContext2D | null;
      ctxRef.current = g;
    }
    if (!g) return;

    const s = scene.current;
    const zoom = zoomRef.current;
    const pan = panRef.current;

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cw, ch);

    const size = sourceSize();
    // A base layer from the previous image would render stretched into this
    // one's aspect ratio; drop stale layers instead of drawing them.
    if (!size || !s.coarse || baseIsStale(s.coarse)) return;

    const w = size.width * zoom;
    const h = size.height * zoom;
    const x = (cw - w) / 2 + pan.x;
    const y = (ch - h) / 2 + pan.y;

    // Nearest-neighbour at or above 1:1 - dithering is a per-pixel art form and
    // smoothing the preview would hide exactly what the user is tuning.
    g.imageSmoothingEnabled = zoom < 1;
    g.imageSmoothingQuality = "high";

    // Blurred canvas shadows rasterize the entire scaled image in WebKit.
    // Draw only the visible source rectangle, using already uploaded surfaces.
    const draw = (image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number) =>
      drawVisible(g!, image as CanvasImageSource & { width: number; height: number }, dx, dy, dw, dh, cw, ch);
    draw(coarseDrawable.current(s.coarse), x, y, w, h);

    // The sharp pass goes over the top, aligned to the region it covers. Until
    // it lands, the coarse layer showing through is what makes a slider drag
    // feel immediate.
    if (s.fine) {
      const sharp = fineDrawable.current(s.fine);
      if (s.region) {
        draw(sharp, x + s.region.x * zoom, y + s.region.y * zoom, s.region.width * zoom, s.region.height * zoom);
      } else {
        draw(sharp, x, y, w, h);
      }
    }

    if (s.compare && s.original) {
      g.save();
      g.beginPath();
      g.rect(0, 0, cw * s.split, ch);
      g.clip();
      draw(originalDrawable.current(s.original), x, y, w, h);
      g.restore();
    }

    // Tell the hook which source pixels are actually on screen, so the next
    // full-resolution pass can skip everything that is not.
    if (s.onViewport) {
      const vx = Math.max(0, -x / zoom);
      const vy = Math.max(0, -y / zoom);
      const vw = Math.min(size.width, (cw - x) / zoom) - vx;
      const vh = Math.min(size.height, (ch - y) / zoom) - vy;
      const next: Rect | null = vw <= 0 || vh <= 0 ? null : { x: vx, y: vy, width: vw, height: vh };
      // Quantise before comparing: sub-pixel drift during a drag would
      // otherwise fire a new render on every frame.
      const key = next
        ? [next.x, next.y, next.width, next.height].map((v) => Math.round(v / 24)).join(",")
        : "";
      if (key !== reportedRef.current) {
        reportedRef.current = key;
        // Refinement is useful after navigation settles. Reporting every frame
        // otherwise re-renders the entire algorithm stack while dragging.
        clearTimeout(viewportTimer.current);
        const report = s.onViewport;
        viewportTimer.current = setTimeout(() => report(next), 160);
      }
    }

    syncHud();
  }, [baseIsStale, sourceSize, syncHud]);

  /** Coalesces every transform change into one paint per displayed frame. */
  const schedulePaint = useCallback(() => {
    if (paintFrame.current !== undefined) return;
    paintFrame.current = requestAnimationFrame(() => {
      paintFrame.current = undefined;
      paint();
    });
  }, [paint]);

  useEffect(
    () => () => {
      // Clearing the handles as well as the timers is not tidiness: a cancelled
      // frame whose handle is left set makes `schedulePaint` believe a paint is
      // still pending, and the canvas never updates again. React 19's
      // mount/unmount/remount in development reaches this path on every launch.
      if (paintFrame.current !== undefined) {
        cancelAnimationFrame(paintFrame.current);
        paintFrame.current = undefined;
      }
      if (hudTimer.current !== undefined) {
        clearTimeout(hudTimer.current);
        hudTimer.current = undefined;
      }
      clearTimeout(viewportTimer.current);
      viewportTimer.current = undefined;
    },
    [],
  );

  // New pixels, a new compare split, a new region: all of them are just a
  // repaint of the same scene.
  useLayoutEffect(() => {
    schedulePaint();
  }, [schedulePaint, original, coarse, coarseScale, fine, region, compare, split]);

  const fit = useCallback(() => {
    const stage = stageRef.current;
    const size = sourceSize();
    if (!stage || !size) return;
    const pad = 48;
    const cw = stage.clientWidth;
    const ch = stage.clientHeight;
    if (cw === 0 || ch === 0) return;
    const scale = Math.min((cw - pad) / size.width, (ch - pad) / size.height, 1);
    zoomRef.current = Math.max(MIN_ZOOM, scale);
    panRef.current = { x: 0, y: 0 };
    setHudZoom(zoomRef.current);
    schedulePaint();
  }, [schedulePaint, sourceSize]);

  const setZoomTo = useCallback(
    (next: number) => {
      touchedRef.current = true;
      zoomRef.current = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
      setHudZoom(zoomRef.current);
      schedulePaint();
    },
    [schedulePaint],
  );

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
      // A clip changes frames constantly at one size; only a genuinely new
      // geometry should take the view back off the user.
      touchedRef.current = false;
      fit();
    }
  }, [coarse, sourceSize, fit]);

  // The stage has no size on the first paint, so an early fit computes a
  // nonsense zoom. Watching it means the fit lands once layout is real, and
  // keeps the image framed across window resizes until the user takes over.
  const resizeActions = useRef({ paint, fit });
  useLayoutEffect(() => {
    resizeActions.current = { paint, fit };
  }, [paint, fit]);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (touchedRef.current) resizeActions.current.paint();
      else resizeActions.current.fit();
    });
    ro.observe(stage);
    return () => ro.disconnect();
  }, []);

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
      schedulePaint();
    },
    [schedulePaint, sourceSize],
  );

  const panBy = useCallback(
    (dx: number, dy: number) => {
      touchedRef.current = true;
      const p = panRef.current;
      panRef.current = { x: p.x - dx, y: p.y - dy };
      schedulePaint();
    },
    [schedulePaint],
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

      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stage.clientHeight : 1;
      const dx = e.deltaX * unit;
      const dy = e.deltaY * unit;
      // A horizontal swipe always pans. Vertical wheel motion follows the
      // saved preference; ctrl/meta wheel is a touchpad pinch and always zooms.
      if (!pinch && (wheelBehavior === "pan" || (Math.abs(dx) > Math.abs(dy) && dx !== 0))) {
        if (e.deltaX === 0 && e.deltaY === 0) return;
        panBy(dx, dy);
        return;
      }

      if (dy === 0 && !pinch) return;
      zoomAt(e.clientX, e.clientY, Math.exp(-dy * (pinch ? 0.01 : 0.0015)));
    };

    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [panBy, wheelBehavior, zoomAt]);

  /** Safari/WebKit exposes some trackpad pinches as GestureEvents, not wheels. */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let previousScale = 1;
    const onStart = (event: Event) => {
      event.preventDefault();
      previousScale = 1;
    };
    const onChange = (event: Event) => {
      event.preventDefault();
      const gesture = event as Event & { scale?: number; clientX?: number; clientY?: number };
      const scale = gesture.scale;
      if (!hasImageRef.current || !scale || !Number.isFinite(scale) || scale <= 0) return;
      const factor = scale / previousScale;
      previousScale = scale;
      const rect = stage.getBoundingClientRect();
      zoomAt(gesture.clientX ?? rect.left + rect.width / 2, gesture.clientY ?? rect.top + rect.height / 2, factor);
    };
    stage.addEventListener("gesturestart", onStart, { passive: false });
    stage.addEventListener("gesturechange", onChange, { passive: false });
    return () => {
      stage.removeEventListener("gesturestart", onStart);
      stage.removeEventListener("gesturechange", onChange);
    };
  }, [zoomAt]);

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
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
    };
    window.addEventListener("dizako-pinch", onPinch);
    return () => window.removeEventListener("dizako-pinch", onPinch);
  }, [zoomAt]);

  /**
   * Canvas keyboard navigation.
   *
   * Every other image tool maps arrows to pan and 0/1 to fit and 1:1; reaching
   * for them and getting nothing is the kind of small absence that makes an app
   * feel unfinished.
   *
   * Bound on the window rather than the stage, because focus is almost never on
   * the stage in practice - pressing a HUD button moves it to that button, and
   * a shortcut that stops working after you click Zoom is worse than no
   * shortcut. The guards below hand the keys back to the two things that
   * legitimately want them: text fields and sliders.
   */
  const handleNavKey = useCallback(
    (e: KeyboardEvent) => {
      const nudge = e.shiftKey ? 200 : 60;
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          panBy(-nudge, 0);
          return;
        case "ArrowRight":
          e.preventDefault();
          panBy(nudge, 0);
          return;
        case "ArrowUp":
          e.preventDefault();
          panBy(0, -nudge);
          return;
        case "ArrowDown":
          e.preventDefault();
          panBy(0, nudge);
          return;
        case "0":
          e.preventDefault();
          fit();
          return;
        case "1":
          e.preventDefault();
          setZoomTo(1);
          return;
        case "+":
        case "=":
          e.preventDefault();
          setZoomTo(zoomRef.current * 1.4);
          return;
        case "-":
        case "_":
          e.preventDefault();
          setZoomTo(zoomRef.current / 1.4);
          return;
        default:
      }
    },
    [fit, panBy, setZoomTo],
  );

  // Read through a ref so the window listener never holds a stale copy.
  const navRef = useRef(handleNavKey);
  useLayoutEffect(() => {
    navRef.current = handleNavKey;
  }, [handleNavKey]);

  useEffect(() => {
    const ownsKeys = () => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName.toLowerCase();
      // A text field and a range slider both move by arrow key; a button, or
      // the document body, has no claim on them.
      return el.isContentEditable || tag === "input" || tag === "textarea" || tag === "select";
    };
    const onKey = (e: KeyboardEvent) => {
      if (!hasImageRef.current || e.ctrlKey || e.metaKey || e.altKey) return;
      if (ownsKeys()) return;
      // A modal owns the keyboard while it is up.
      if (document.querySelector(".m3-dialog-scrim, .sheet-scrim")) return;
      navRef.current(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!hasImage) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    if (splitDragRef.current) return;
    touchedRef.current = true;
    dragRef.current = { x: e.clientX, y: e.clientY, px: panRef.current.x, py: panRef.current.y };
    if (viewRef.current) viewRef.current.style.willChange = "transform";
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (splitDragRef.current && stageRef.current) {
      const r = stageRef.current.getBoundingClientRect();
      setSplit(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
      return;
    }
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    panRef.current = { x: d.px + dx, y: d.py + dy };

    // Move the already-painted viewport surface on the compositor while the
    // pointer is down. Re-rasterising a stage-sized canvas for every mouse
    // event is needlessly expensive, especially under WebKitGTK.
    if (viewRef.current) viewRef.current.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
  };

  const endDrag = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (drag) {
      panRef.current = { x: drag.px + (e.clientX - drag.x), y: drag.py + (e.clientY - drag.y) };
      dragRef.current = null;
      if (viewRef.current) {
        viewRef.current.style.transform = "";
        viewRef.current.style.willChange = "auto";
      }
      // The compositor transform got us here; one real paint puts the pixels
      // where the transform was pretending they already were.
      schedulePaint();
    }
    splitDragRef.current = false;
  };

  const zoomBy = (f: number) => {
    const stage = stageRef.current;
    if (!stage) {
      setZoomTo(zoomRef.current * f);
      return;
    }
    const r = stage.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, f);
  };

  // Derived straight from props rather than through `sourceSize()`, which
  // reads the render-time scene ref - correct inside `paint`, wrong in a render
  // body.
  const size = original ? { width: original.width, height: original.height } : layerSize(coarse, coarseScale);
  // The first pass on a large image can take seconds. Until it lands there is
  // no result to draw and the HUD is hidden, so without this the stage is
  // indistinguishable from a broken load.
  const firstPass = busy && !coarse;

  return (
    <div className="preview">
      {/* The frame is the positioning context for the HUD and the engine chip.
          They must sit outside the stage - the stage owns pan gestures, and a
          button inside it would start a drag on mousedown - but inside
          something that ends above the docked transport. */}
      <div className="preview__frame">
      <div
        ref={stageRef}
        className={`preview__stage ${hasImage ? "" : "is-empty"}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onDoubleClick={(e) => {
          if (!hasImageRef.current) return;
          // Alt inverts it, matching every other canvas app.
          zoomAt(e.clientX, e.clientY, e.altKey ? 1 / 2 : 2);
        }}
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
          title={degraded ? t("hud.degradedHint") : t("hud.engineHint")}
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
              value={isZoomFocused ? zoomInput : Math.round(hudZoom * 100) + "%"}
              onFocus={() => {
                setZoomInput(Math.round(zoomRef.current * 100).toString());
                setIsZoomFocused(true);
              }}
              onBlur={() => {
                setIsZoomFocused(false);
                const parsed = parseInt(zoomInput.replace(/[^0-9]/g, ""), 10);
                if (!isNaN(parsed)) setZoomTo(parsed / 100);
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
            <IconButton label={t("hud.compare")} selected={compare} onClick={() => setCompare((c) => !c)}>
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

      {footer}
    </div>
  );
}
