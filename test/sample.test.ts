import { describe, expect, test } from "vitest";
import { neighbourhood, pixelAt, stepZoom, toImageCoords, ZOOM_STEPS } from "../src/dither/sample";

function plane(w: number, h: number) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([x * 10, y * 10, 7, 255], (y * w + x) * 4);
  return { data, width: w, height: h };
}

describe("image picker sampling", () => {
  test("maps the displayed position onto the source pixel under it, clamped inside", () => {
    const p = plane(100, 50);
    expect(toImageCoords(0, 0, 400, 200, p)).toEqual({ x: 0, y: 0 });
    expect(toImageCoords(200, 100, 400, 200, p)).toEqual({ x: 50, y: 25 });
    expect(toImageCoords(399.9, 199.9, 400, 200, p)).toEqual({ x: 99, y: 49 });
    expect(toImageCoords(-30, 900, 400, 200, p)).toEqual({ x: 0, y: 49 });
  });

  test("reads exact pixels and refuses to read off the plane", () => {
    const p = plane(8, 8);
    expect(pixelAt(p, 3, 2)).toEqual([30, 20, 7]);
    expect(pixelAt(p, -1, 0)).toBeNull();
    expect(pixelAt(p, 8, 0)).toBeNull();
  });

  test("the window is centred on the pixel and always has an odd size", () => {
    const p = plane(9, 9);
    const win = neighbourhood(p, 4, 4, 4); // 4 is forced to 5
    expect(win.length).toBe(5 * 5 * 4);
    const centre = (2 * 5 + 2) * 4;
    expect(Array.from(win.subarray(centre, centre + 4))).toEqual([40, 40, 7, 255]);
    const corner = 0;
    expect(Array.from(win.subarray(corner, corner + 4))).toEqual([20, 20, 7, 255]);
  });

  test("cells beyond the image edge are transparent, not smeared", () => {
    const p = plane(5, 5);
    const win = neighbourhood(p, 0, 0, 5);
    // Top-left 2x2 of the window are outside the plane.
    for (const [row, col] of [[0, 0], [1, 1], [0, 2], [2, 0]] as const) {
      expect(win[(row * 5 + col) * 4 + 3]).toBe(0);
    }
    expect(win[(2 * 5 + 2) * 4 + 3]).toBe(255);
  });

  test("zoom steps walk the ladder and stop at both ends", () => {
    expect(stepZoom(15, 1)).toBe(11);
    expect(stepZoom(15, -1)).toBe(21);
    expect(stepZoom(3, 1)).toBe(3);
    expect(stepZoom(41, -1)).toBe(41);
    expect(stepZoom(13, 1)).toBe(11);
    expect(stepZoom(13, -1)).toBe(15);
    expect(ZOOM_STEPS[0]).toBe(41);
  });
});
