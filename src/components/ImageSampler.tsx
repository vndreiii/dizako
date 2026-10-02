import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { rgbToHex } from "../dither/color";
import { neighbourhood, pixelAt, stepZoom, toImageCoords } from "../dither/sample";
import { useI18n } from "../i18n";

interface Props {
  /** The plane to sample - read directly, so a pick is the exact source pixel. */
  source: ImageData;
  /** Fires continuously while the pointer is held, for live preview. */
  onLive?: (hex: string) => void;
  /** The pointer was released over the image: this is the colour. */
  onPick: (hex: string) => void;
  /** Escape, or the pointer left without a pick. */
  onCancel?: () => void;
}

/** Longest edge of the displayed preview, in CSS pixels. */
const MAX_VIEW_W = 560;
const MAX_VIEW_H = 380;
/** Floating loupe that tracks the cursor while hovering. */
const HOVER_CELLS = 11;
const HOVER_SIZE = 132;
/** Corner zoom shown while the pointer is held down. */
const HOLD_SIZE = 240;

interface Cursor {
  /** Position inside the frame, in CSS pixels. */
  px: number;
  py: number;
  /** Source pixel under it. */
  x: number;
  y: number;
}

/**
 * Paints a magnified neighbourhood with nearest-neighbour scaling, so every
 * source pixel is a crisp square, a pixel grid once cells are big enough, and
 * a marker on the one that will be picked.
 */
function paintLoupe(
  canvas: HTMLCanvasElement,
  scratch: HTMLCanvasElement,
  source: ImageData,
  x: number,
  y: number,
  cells: number,
  size: number,
) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const px = Math.round(size * dpr);
  if (canvas.width !== px) {
    canvas.width = px;
    canvas.height = px;
  }
  const g = canvas.getContext("2d");
  const sg = scratch.getContext("2d");
  if (!g || !sg) return;

  const n = cells | 1;
  if (scratch.width !== n) {
    scratch.width = n;
    scratch.height = n;
  }
  const window_ = neighbourhood(source, x, y, n);
  sg.putImageData(new ImageData(window_, n, n), 0, 0);

  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, px, px);
  g.drawImage(scratch, 0, 0, n, n, 0, 0, px, px);

  const cell = px / n;
  if (cell >= 7) {
    g.strokeStyle = "rgba(0,0,0,0.22)";
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 1; i < n; i++) {
      const p = Math.round(i * cell) + 0.5;
      g.moveTo(p, 0);
      g.lineTo(p, px);
      g.moveTo(0, p);
      g.lineTo(px, p);
    }
    g.stroke();
  }

  // The pixel that will be picked: a dark ring with a light one inside, so the
  // marker reads against both a black and a white pixel.
  const mid = (n >> 1) * cell;
  g.lineWidth = Math.max(1.5, dpr * 1.5);
  g.strokeStyle = "rgba(0,0,0,0.9)";
  g.strokeRect(mid - 0.5, mid - 0.5, cell + 1, cell + 1);
  g.strokeStyle = "rgba(255,255,255,0.95)";
  g.strokeRect(mid + g.lineWidth, mid + g.lineWidth, cell - g.lineWidth * 2, cell - g.lineWidth * 2);
}

export function ImageSampler({ source, onLive, onPick, onCancel }: Props) {
  const { t } = useI18n();
  const frameRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const hoverRef = useRef<HTMLCanvasElement>(null);
  const holdRef = useRef<HTMLCanvasElement>(null);
  const scratch = useMemo(() => document.createElement("canvas"), []);

  const [width, setWidth] = useState(MAX_VIEW_W);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [pressed, setPressed] = useState(false);
  const [zoom, setZoom] = useState(15);
  const pressedRef = useRef(false);

  // Fit the image into the available width, keeping aspect.
  const view = useMemo(() => {
    // Small images are scaled *up* to fill the frame: a larger target is the
    // whole point of the picker, and the loupe handles the pixel-level view.
    const s = Math.min(width / source.width, MAX_VIEW_H / source.height);
    return {
      w: Math.max(1, Math.round(source.width * s)),
      h: Math.max(1, Math.round(source.height * s)),
    };
  }, [width, source.width, source.height]);

  useLayoutEffect(() => {
    const frame = frameRef.current?.parentElement;
    if (!frame) return;
    const measure = () => setWidth(Math.max(160, Math.min(MAX_VIEW_W, frame.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(frame);
    return () => ro.disconnect();
  }, []);

  // The preview is a reduced copy made without a canvas round-trip of the full
  // source; the loupe never looks at it, so its quality only has to please the eye.
  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas) return;
    let cancelled = false;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(view.w * dpr);
    const h = Math.round(view.h * dpr);
    canvas.width = w;
    canvas.height = h;
    const draw = (image: CanvasImageSource) => {
      if (cancelled) return;
      const g = canvas.getContext("2d");
      if (!g) return;
      g.imageSmoothingQuality = "high";
      g.drawImage(image, 0, 0, w, h);
    };
    if (typeof createImageBitmap === "function") {
      createImageBitmap(source, { resizeWidth: w, resizeHeight: h, resizeQuality: "high" }).then(
        (bitmap) => {
          draw(bitmap);
          bitmap.close();
        },
        () => {
          // Hosts that cannot resize while decoding: go through a canvas.
          const full = document.createElement("canvas");
          full.width = source.width;
          full.height = source.height;
          full.getContext("2d")?.putImageData(source, 0, 0);
          draw(full);
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [source, view.w, view.h]);

  const locate = useCallback(
    (e: { clientX: number; clientY: number }): Cursor => {
      const rect = previewRef.current!.getBoundingClientRect();
      const px = Math.min(rect.width, Math.max(0, e.clientX - rect.left));
      const py = Math.min(rect.height, Math.max(0, e.clientY - rect.top));
      const { x, y } = toImageCoords(px, py, rect.width, rect.height, source);
      return { px, py, x, y };
    },
    [source],
  );

  const hexAt = useCallback(
    (x: number, y: number) => {
      const p = pixelAt(source, x, y);
      return p ? rgbToHex(p) : null;
    },
    [source],
  );

  // Repaint whichever loupes are showing whenever the target pixel moves.
  useEffect(() => {
    if (!cursor) return;
    if (!pressed && hoverRef.current) {
      paintLoupe(hoverRef.current, scratch, source, cursor.x, cursor.y, HOVER_CELLS, HOVER_SIZE);
    }
    if (pressed && holdRef.current) {
      paintLoupe(holdRef.current, scratch, source, cursor.x, cursor.y, zoom, HOLD_SIZE);
    }
  }, [cursor, pressed, zoom, source, scratch]);

  const hex = cursor ? hexAt(cursor.x, cursor.y) : null;
  const rgb = cursor ? pixelAt(source, cursor.x, cursor.y) : null;

  // While held, the picked colour is live so the swatch and the image behind
  // the dialog follow the pointer. The callback is read through a ref: parents
  // pass fresh closures every render, and an effect keyed on one would report
  // its own echo forever.
  const liveRef = useRef(onLive);
  // eslint-disable-next-line react-hooks/refs -- latest-ref pattern
  liveRef.current = onLive;
  useEffect(() => {
    if (pressed && hex) liveRef.current?.(hex);
  }, [pressed, hex]);

  const release = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!pressedRef.current) return;
      pressedRef.current = false;
      setPressed(false);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Capture may already be gone if the pointer was cancelled.
      }
      const at = locate(e);
      const picked = hexAt(at.x, at.y);
      if (picked) onPick(picked);
    },
    [hexAt, locate, onPick],
  );

  // Move the sampled pixel one source pixel at a time from the keyboard.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onCancel?.();
      return;
    }
    const step = e.shiftKey ? 10 : 1;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const d = delta[e.key];
    if (d) {
      e.preventDefault();
      const base = cursor ?? { x: source.width >> 1, y: source.height >> 1, px: 0, py: 0 };
      const x = Math.min(source.width - 1, Math.max(0, base.x + d[0]));
      const y = Math.min(source.height - 1, Math.max(0, base.y + d[1]));
      setCursor({ x, y, px: ((x + 0.5) / source.width) * view.w, py: ((y + 0.5) / source.height) * view.h });
      return;
    }
    if ((e.key === "Enter" || e.key === " ") && cursor) {
      e.preventDefault();
      const picked = hexAt(cursor.x, cursor.y);
      if (picked) onPick(picked);
    }
  };

  // Place the floating loupe beside the cursor, flipped away from the edges.
  const hoverStyle = (() => {
    if (!cursor) return undefined;
    const pad = 18;
    const flipX = cursor.px + pad + HOVER_SIZE > view.w;
    const flipY = cursor.py + pad + HOVER_SIZE > view.h;
    return {
      left: flipX ? cursor.px - pad - HOVER_SIZE : cursor.px + pad,
      top: flipY ? cursor.py - pad - HOVER_SIZE : cursor.py + pad,
      width: HOVER_SIZE,
      height: HOVER_SIZE,
    };
  })();

  // The held-down zoom lives in a corner and hops to the other side when the
  // pointer gets close to it, so it never sits under the pixel being aimed at.
  const holdSide = cursor && cursor.px > view.w - HOLD_SIZE - 40 && cursor.py < HOLD_SIZE + 60 ? "left" : "right";

  return (
    <div className="sampler" ref={frameRef}>
      <div
        className={`sampler__frame ${pressed ? "is-pressed" : ""}`}
        style={{ width: view.w, height: view.h }}
        tabIndex={0}
        role="application"
        aria-label={t("picker.imageAria")}
        onKeyDown={onKeyDown}
        onPointerMove={(e) => setCursor(locate(e))}
        onPointerLeave={() => {
          if (!pressedRef.current) setCursor(null);
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.focus({ preventScroll: true });
          pressedRef.current = true;
          setPressed(true);
          setCursor(locate(e));
        }}
        onPointerUp={release}
        onPointerCancel={() => {
          pressedRef.current = false;
          setPressed(false);
          onCancel?.();
        }}
        onWheel={(e) => {
          if (!pressedRef.current && !cursor) return;
          e.preventDefault();
          setZoom((z) => stepZoom(z, e.deltaY < 0 ? 1 : -1));
        }}
      >
        <canvas ref={previewRef} className="sampler__image" style={{ width: view.w, height: view.h }} />

        {cursor && (
          <span
            className="sampler__cross"
            style={{ left: cursor.px, top: cursor.py }}
            aria-hidden="true"
          />
        )}

        {cursor && !pressed && (
          <div className="sampler__hover" style={hoverStyle} aria-hidden="true">
            <canvas ref={hoverRef} />
            {hex && (
              <span className="sampler__chip">
                <i style={{ background: hex }} />
                {hex}
              </span>
            )}
          </div>
        )}

        {cursor && pressed && (
          <div className={`sampler__hold sampler__hold--${holdSide}`} aria-hidden="true">
            <canvas ref={holdRef} style={{ width: HOLD_SIZE, height: HOLD_SIZE }} />
            <div className="sampler__readout">
              <i style={{ background: hex ?? "transparent" }} />
              <span className="sampler__hex">{hex}</span>
              {rgb && <span className="sampler__rgb">{rgb.join(" · ")}</span>}
              <span className="sampler__xy">
                {cursor.x}, {cursor.y}
              </span>
            </div>
            <span className="sampler__zoomnote">
              {t("picker.zoomNote").replace(/\{n\}/g, String(zoom | 1))}
            </span>
          </div>
        )}
      </div>

      <p className="sampler__hint">{pressed ? t("picker.releaseToPick") : t("picker.holdToZoom")}</p>
    </div>
  );
}
