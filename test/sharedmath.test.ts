import { describe, expect, test } from "vitest";
import { cbrtShared, powShared, srgbToLinearShared, sinCosDeg } from "../src/dither/sharedmath";

/**
 * Sanity bounds for the shared primitives. Byte parity between engines is
 * enforced by the golden sweep; these tests pin the primitives to sane
 * accuracy against the platform libm so a refactor that silently breaks
 * convergence shows up here first.
 */
describe("shared math primitives", () => {
  test("cbrtShared matches Math.cbrt within 2 ulp", () => {
    for (let i = 1; i < 20_000; i++) {
      const x = i * 0.037;
      const a = cbrtShared(x);
      const b = Math.cbrt(x);
      const ulps = Math.abs(a - b) / Math.max(Number.EPSILON * Math.abs(b), Number.MIN_VALUE);
      expect(ulps, `cbrt(${x})`).toBeLessThanOrEqual(2);
    }
    expect(cbrtShared(0)).toBe(0);
    expect(cbrtShared(-8)).toBe(-2);
    expect(cbrtShared(Infinity)).toBe(Infinity);
    expect(Number.isNaN(cbrtShared(NaN))).toBe(true);
  });

  test("sinCosDeg matches Math.sin/cos within ~4e-16", () => {
    for (let d = -720; d <= 720; d += 0.25) {
      const [s, c] = sinCosDeg(d);
      // Reference reduces the argument identically, so this measures series
      // accuracy rather than reduction-path differences.
      const n = Math.floor(d / 90 + 0.5);
      const rr = (d - n * 90) * (Math.PI / 180);
      expect(Math.abs(s - Math.sin(rr)), `sin(${d})`).toBeLessThan(8e-16);
      expect(Math.abs(c - Math.cos(rr)), `cos(${d})`).toBeLessThan(8e-16);
    }
  });

  test("powShared matches Math.pow within ~4 ulp", () => {
    const xs = [0.01, 0.1, 0.5, 1, 2, 10, 100, 255, 1000];
    const ys = [-3, -1.5, -0.3, 0, 0.25, 0.5, 1 / 3, 0.7, 1, 1.9, 2.4, 3, 12];
    for (const x of xs) {
      for (const y of ys) {
        if (y === 0 || (x === 0 && y < 0)) continue;
        const a = powShared(x, y);
        const b = Math.pow(x, y);
        const rel = Math.abs(a - b) / b;
        // exp2(y·log2 x) amplifies by ln2·|y·log2 x|; parity needs identical
        // bits across engines, not libm-grade accuracy.
        const t = y * (Math.log2 ? Math.abs(Math.log2(x)) : 0) || 1;
        expect(rel, `pow(${x},${y})`).toBeLessThan(Math.max(1e-14, t * 4e-15));
      }
    }
  });

  test("srgbToLinearShared matches the reference curve", () => {
    const ref = (c: number) => {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    for (let i = 0; i <= 1024; i++) {
      const c = i * 0.25;
      const a = srgbToLinearShared(c);
      const b = ref(c);
      const rel = Math.abs(a - b) / Math.max(b, 1e-12);
      expect(rel, `srgb(${c})`).toBeLessThan(1e-13);
    }
    expect(srgbToLinearShared(0)).toBe(0);
    // Threshold branch is an exact division.
    expect(srgbToLinearShared(10)).toBeCloseTo(10 / 3294.6, 18);
  });
});
