/**
 * Shared deterministic math primitives (WASM_PLAN §4.4).
 *
 * `Math.pow`, `Math.cbrt` and friends are implementation-defined per
 * ECMA-262 — JSC, V8 and Rust's compiled libm may disagree in the last ulp.
 * In a matcher that compares distances with strict `<`, one flipped ulp can
 * swap the winning palette entry, and in error diffusion that swap cascades
 * into visibly different texture. These primitives use only IEEE-mandated
 * operations (+ - * /) plus exact ±2 scaling, so both engines execute the
 * identical operation sequence and therefore produce identical bits.
 *
 * The Rust mirror lives in dither-wasm/src/shared.rs and must stay
 * operation-for-operation identical, including evaluation order.
 */
import {
  CCOS,
  CEXP,
  CLN,
  CSIN,
  LN2,
  PI_OVER_180,
  RAD_TO_DEG,
  SQRT2,
} from "./tables";

/** Splits x = m · 2^e with m ∈ [1, 2). Exact: only ±2 multiplies. */
function decompose(x: number): [number, number] {
  let m = x;
  let e = 0;
  while (m >= 2) {
    m *= 0.5;
    e += 1;
  }
  while (m < 1) {
    m *= 2;
    e -= 1;
  }
  return [m, e];
}

/** Returns y · 2^e by exact repeated doubling/halving. */
function scalePow2(y: number, e: number): number {
  let out = y;
  let k = e;
  while (k > 0) {
    out *= 2;
    k -= 1;
  }
  while (k < 0) {
    out *= 0.5;
    k += 1;
  }
  return out;
}

/**
 * Cube root via exponent decomposition + Newton iterations.
 *
 * x = mm · 2^(3q+r); Newton refines cbrt(mm), then exact factors restore the
 * power-of-two part. A fixed iteration count guarantees the same fixed point
 * in every engine regardless of timing or optimisation level.
 */
export function cbrtShared(x: number): number {
  if (x === 0 || Number.isNaN(x)) return x;
  if (!Number.isFinite(x)) return x > 0 ? Infinity : -Infinity;
  const neg = x < 0;
  const ax = neg ? -x : x;

  const [m0, e] = decompose(ax);
  const q = Math.floor(e / 3);
  const r = e - 3 * q;
  // x = m0·2^e = (m0·2^r)·2^(3q), so the residual mantissa sits in [1, 4)
  // and its cube root carries the remainder exactly — no fractional factors.
  const mm = scalePow2(m0, r);

  let y = 1 + (mm - 1) / 3;
  for (let i = 0; i < 9; i++) {
    y = (2 * y + mm / (y * y)) / 3;
  }

  return neg ? -scalePow2(y, q) : scalePow2(y, q);
}

/**
 * sin/cos of an angle in degrees, reduced to [-45°, 45°] exactly and then
 * evaluated with fixed-order Taylor/Horner series over portable operations.
 */
export function sinCosDeg(d: number): [number, number] {
  if (Number.isNaN(d)) return [NaN, NaN];
  if (!Number.isFinite(d)) return [NaN, NaN];

  // Nearest multiple of 90°. Math.round(x) === Math.floor(x + 0.5) over the
  // finite range; spell it as floor so Rust mirrors one construct.
  const n = Math.floor(d / 90 + 0.5);
  const rest = d - n * 90; // exact for |d| ≤ ~2^45
  const rad = rest * PI_OVER_180;

  const x2 = rad * rad;
  // Horner, high order first; coefficient tables come from generated tables.ts.
  let s = CSIN[11];
  for (let k = 10; k >= 0; k--) s = s * x2 + CSIN[k];
  s *= rad;

  let c = CCOS[12];
  for (let k = 11; k >= 0; k--) c = c * x2 + CCOS[k];

  return [s, c];
}

/** sine of radians — same deterministic series, degree-reduced internally. */
export function sinRad(x: number): number {
  return sinCosDeg(x * RAD_TO_DEG)[0];
}

/** log2 via atanh series on a mantissa pre-squeezed toward 1. */
function log2Shared(x: number): number {
  let [m, e] = decompose(x);
  if (m > SQRT2) {
    m *= 0.5;
    e += 1;
  }
  const z = (m - 1) / (m + 1);
  const z2 = z * z;
  let acc = CLN[12];
  for (let k = 11; k >= 0; k--) acc = acc * z2 + CLN[k];
  const ln = 2 * z * acc;
  return e + ln / LN2;
}

/** exp2 via Taylor on f ∈ [-0.5, 0.5], scaled by exact doublings. */
function exp2Shared(t: number): number {
  if (Number.isNaN(t)) return NaN;
  if (t > 2000) return Infinity;
  if (t < -1075) return 0;
  const i = Math.floor(t + 0.5);
  const f = t - i;
  // The 1/k! series computes e^g; feed it g = f·ln2 so the result is 2^f.
  const g = f * LN2;
  let acc = CEXP[17];
  for (let k = 16; k >= 0; k--) acc = acc * g + CEXP[k];
  return scalePow2(acc, i);
}

/**
 * pow(x, y) for x > 0 — the tone-curve/Riemersma workhorse, deterministic by
 * construction instead of libm-dependent.
 */
export function powShared(x: number, y: number): number {
  if (y === 0 || x === 1) return 1;
  // Identity exponents stay exact (Math.pow(x, 1) is exactly x), which keeps
  // neutral tone curves bit-stable against the pre-refactor engine.
  if (y === 1) return x;
  if (x === 0) return 0;
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  return exp2Shared(y * log2Shared(x));
}

/**
 * sRGB (0..255 channel scale) → linear.
 *
 * The canonical form is `(c + 14.025) / 269.025` — algebraically equal to
 * `((c/255) + 0.055) / 1.055` but with one exact-decimal constant pair, so
 * both engines evaluate identical operations. Below the threshold a single
 * division is exact in any IEEE implementation. Not a lookup table: the
 * curve's knee makes uniform-grid interpolation lose multiple digits, and
 * powShared is deterministic anyway.
 */
const SRGB_LINEAR_CUTOFF = 10.31475; // 0.04045 × 255

export function srgbToLinearShared(c: number): number {
  // Below the knee the original computes (c/255)/12.92; fused into one
  // division by the exact decimal product.
  return c <= SRGB_LINEAR_CUTOFF ? c / 3294.6 : powShared((c + 14.025) / 269.025, 2.4);
}
