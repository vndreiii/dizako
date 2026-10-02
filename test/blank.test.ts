import { describe, expect, test } from "vitest";
import { looksBlank } from "../src/video/blank";

function plane(w: number, h: number, alpha: (i: number) => number) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([10, 20, 30, alpha(i)], i * 4);
  return data;
}

describe("blank frame detection", () => {
  test("a surface that painted nothing is blank", () => {
    expect(looksBlank(plane(64, 64, () => 0))).toBe(true);
  });

  test("an opaque frame is not", () => {
    expect(looksBlank(plane(64, 64, () => 255))).toBe(false);
  });

  test("a partly painted frame is not, wherever the paint is", () => {
    expect(looksBlank(plane(64, 64, (i) => (i === 0 ? 255 : 0)))).toBe(false);
    expect(looksBlank(plane(64, 64, (i) => (i === 64 * 64 - 1 ? 255 : 0)))).toBe(false);
    expect(looksBlank(plane(64, 64, (i) => (i > 2048 ? 255 : 0)))).toBe(false);
  });

  test("an empty plane counts as blank rather than as a frame", () => {
    expect(looksBlank(new Uint8ClampedArray(0))).toBe(true);
  });

  test("a huge plane is judged from a bounded sample", () => {
    const big = plane(2000, 2000, () => 0);
    const t = performance.now();
    expect(looksBlank(big)).toBe(true);
    expect(performance.now() - t).toBeLessThan(20);
  });
});
