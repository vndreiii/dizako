import { describe, expect, test } from "vitest";
import { extractPalette } from "../src/dither/extract";
import { hexToRgb } from "../src/dither/color";

function image(w: number, h: number, pixel: (x: number, y: number) => [number, number, number, number]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = pixel(x, y);
      data.set([r, g, b, a], (y * w + x) * 4);
    }
  }
  return data;
}

const near = (hex: string, [r, g, b]: [number, number, number], tol = 12) => {
  const c = hexToRgb(hex);
  return Math.abs(c[0] - r) <= tol && Math.abs(c[1] - g) <= tol && Math.abs(c[2] - b) <= tol;
};

describe("palette extraction", () => {
  test("recovers the colours an image is made of", () => {
    const data = image(60, 60, (x) => (x < 20 ? [200, 30, 30, 255] : x < 40 ? [20, 160, 60, 255] : [30, 40, 220, 255]));
    const palette = extractPalette(data, 60, 60, { count: 3 });
    expect(palette).toHaveLength(3);
    for (const want of [[200, 30, 30], [20, 160, 60], [30, 40, 220]] as Array<[number, number, number]>) {
      expect(palette.some((hex) => near(hex, want)), `missing ${want}`).toBe(true);
    }
  });

  test("weights by how much of the image a colour covers", () => {
    // Mostly teal with a thin stripe of orange: two colours must be teal and orange.
    const data = image(80, 80, (_, y) => (y < 70 ? [10, 150, 160, 255] : [250, 120, 20, 255]));
    const palette = extractPalette(data, 80, 80, { count: 2 });
    expect(palette.some((h) => near(h, [10, 150, 160]))).toBe(true);
    expect(palette.some((h) => near(h, [250, 120, 20]))).toBe(true);
  });

  test("returns swatches darkest first, ready to be spread over the tonal range", () => {
    const data = image(50, 50, (x, y) => [x * 5, y * 5, (x + y) * 2, 255]);
    const palette = extractPalette(data, 50, 50, { count: 6 });
    const lumas = palette.map((h) => {
      const [r, g, b] = hexToRgb(h);
      return 0.299 * r + 0.587 * g + 0.114 * b;
    });
    expect(lumas).toEqual([...lumas].sort((a, b) => a - b));
  });

  test("never returns fewer than two colours, even for a flat image", () => {
    const flat = image(10, 10, () => [90, 90, 90, 255]);
    expect(extractPalette(flat, 10, 10, { count: 5 }).length).toBeGreaterThanOrEqual(2);
    const clear = image(10, 10, () => [0, 0, 0, 0]);
    expect(extractPalette(clear, 10, 10, { count: 4 })).toEqual(["#000000", "#FFFFFF"]);
  });

  test("ignores transparent pixels and stays within the requested count", () => {
    const data = image(40, 40, (x) => (x < 20 ? [255, 0, 0, 0] : [0, 0, 255, 255]));
    const palette = extractPalette(data, 40, 40, { count: 4 });
    expect(palette.length).toBeLessThanOrEqual(4);
    expect(palette.every((h) => !near(h, [255, 0, 0], 30))).toBe(true);
  });

  test("a huge image costs about the same as a small one", () => {
    const big = image(1500, 1500, (x, y) => [x % 256, y % 256, (x ^ y) % 256, 255]);
    const t = performance.now();
    extractPalette(big, 1500, 1500, { count: 8 });
    expect(performance.now() - t).toBeLessThan(400);
  });
});
