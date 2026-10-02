/**
 * Pixel sampling for the image picker's loupe.
 *
 * Everything here reads straight from the source plane, never from a scaled
 * preview, so what the loupe shows - and what a click returns - is the exact
 * pixel at that position and not an average of its neighbours.
 */

export interface Plane {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Maps a point on a displayed (fitted) image to a source pixel, clamped inside. */
export function toImageCoords(
  px: number,
  py: number,
  viewWidth: number,
  viewHeight: number,
  plane: Pick<Plane, "width" | "height">,
): { x: number; y: number } {
  const x = Math.floor((px / Math.max(1, viewWidth)) * plane.width);
  const y = Math.floor((py / Math.max(1, viewHeight)) * plane.height);
  return {
    x: Math.min(plane.width - 1, Math.max(0, x)),
    y: Math.min(plane.height - 1, Math.max(0, y)),
  };
}

/** The pixel at `(x, y)`, or null off the plane. */
export function pixelAt(plane: Plane, x: number, y: number): [number, number, number] | null {
  if (x < 0 || y < 0 || x >= plane.width || y >= plane.height) return null;
  const o = (y * plane.width + x) * 4;
  return [plane.data[o]!, plane.data[o + 1]!, plane.data[o + 2]!];
}

/**
 * An `n` x `n` window of the plane centred on `(cx, cy)`, as RGBA.
 *
 * `n` is forced odd so there is a single centre pixel to point at. Cells that
 * fall off the plane are transparent rather than clamped, so the edge of the
 * image reads as an edge in the loupe instead of smearing outward.
 */
export function neighbourhood(plane: Plane, cx: number, cy: number, n: number): Uint8ClampedArray<ArrayBuffer> {
  const size = Math.max(1, n | 1);
  const half = size >> 1;
  const out = new Uint8ClampedArray(size * size * 4);
  for (let row = 0; row < size; row++) {
    const y = cy - half + row;
    for (let col = 0; col < size; col++) {
      const x = cx - half + col;
      if (x < 0 || y < 0 || x >= plane.width || y >= plane.height) continue;
      const from = (y * plane.width + x) * 4;
      const to = (row * size + col) * 4;
      out[to] = plane.data[from]!;
      out[to + 1] = plane.data[from + 1]!;
      out[to + 2] = plane.data[from + 2]!;
      out[to + 3] = 255;
    }
  }
  return out;
}

/** Window sizes the loupe steps through, from wide context down to near-pixel. */
export const ZOOM_STEPS = [41, 31, 21, 15, 11, 7, 5, 3] as const;

/**
 * Next window size on the ladder. `direction` +1 zooms in (a smaller window),
 * -1 zooms out. A size between rungs moves to the adjacent rung in that
 * direction rather than skipping one.
 */
export function stepZoom(current: number, direction: 1 | -1): number {
  if (direction === 1) {
    const smaller = ZOOM_STEPS.find((s) => s < current);
    return smaller ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]!;
  }
  const larger = [...ZOOM_STEPS].reverse().find((s) => s > current);
  return larger ?? ZOOM_STEPS[0]!;
}
