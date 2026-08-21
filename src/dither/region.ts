import type { Settings } from "./types";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * How much context to dither beyond the visible area.
 *
 * Error diffusion is order-dependent: a pixel's value depends on error that
 * arrived from its neighbours. Cutting a tile straight out of the image and
 * dithering that alone would start every row from a clean slate and leave a
 * visible seam along the crop. Rendering a margin that is then never drawn
 * gives the diffusion room to settle before it reaches anything on screen.
 */
const MARGIN = 96;

/**
 * Widens a viewport rect into the region actually worth dithering.
 *
 * Returns `null` when the region would cover essentially the whole image, in
 * which case the caller should just render the lot and skip the bookkeeping.
 */
export function regionFor(
  viewport: Rect | null,
  width: number,
  height: number,
  settings: Settings,
): Rect | null {
  if (!viewport) return null;

  let x0 = Math.floor(viewport.x) - MARGIN;
  let y0 = Math.floor(viewport.y) - MARGIN;
  let x1 = Math.ceil(viewport.x + viewport.width) + MARGIN;
  let y1 = Math.ceil(viewport.y + viewport.height) + MARGIN;

  // Omino marches a whole line at a time and its bands are the accumulated
  // error of everything behind them, so a partial line is a different picture
  // rather than a slightly rougher one. Crop across the march, never along it.
  if (settings.algorithm === "omino") {
    if (settings.ominoDirection === "left" || settings.ominoDirection === "right") {
      x0 = 0;
      x1 = width;
    } else {
      y0 = 0;
      y1 = height;
    }
  }

  const rect: Rect = {
    x: Math.max(0, x0),
    y: Math.max(0, y0),
    width: Math.min(width, x1) - Math.max(0, x0),
    height: Math.min(height, y1) - Math.max(0, y0),
  };
  if (rect.width <= 0 || rect.height <= 0) return null;

  // Not worth the extra pass if it saves less than a fifth of the work.
  if (rect.width * rect.height > width * height * 0.8) return null;
  return rect;
}

export function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Copies a sub-rectangle out of an ImageData without touching a canvas. */
export function cropImage(src: ImageData, r: Rect): ImageData {
  const out = new Uint8ClampedArray(r.width * r.height * 4);
  const stride = src.width * 4;
  for (let row = 0; row < r.height; row++) {
    const from = (r.y + row) * stride + r.x * 4;
    out.set(src.data.subarray(from, from + r.width * 4), row * r.width * 4);
  }
  return new ImageData(out, r.width, r.height);
}
