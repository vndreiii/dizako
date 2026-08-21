//! Shared deterministic math primitives — the Rust mirror of
//! `src/dither/sharedmath.ts`. Must stay operation-for-operation identical,
//! including evaluation order (WASM_PLAN §4.4).
//!
//! Everything here uses only IEEE-mandated operations (`+ - * /`),
//! comparisons, and exact ±2 scaling, so native and wasm32 builds agree
//! bitwise with each other and with both JS engines.

use crate::tables::{CCOS, CEXP, CLN, CSIN, LN2, PI_OVER_180, RAD_TO_DEG, SQRT2};

/// Splits x = m · 2^e with m ∈ [1, 2). Exact: only ±2 multiplies.
fn decompose(x: f64) -> (f64, i32) {
    let mut m = x;
    let mut e: i32 = 0;
    while m >= 2.0 {
        m *= 0.5;
        e += 1;
    }
    while m < 1.0 {
        m *= 2.0;
        e -= 1;
    }
    (m, e)
}

/// Returns y · 2^e by exact repeated doubling/halving.
fn scale_pow2(y: f64, e: i32) -> f64 {
    let mut out = y;
    let mut k = e;
    while k > 0 {
        out *= 2.0;
        k -= 1;
    }
    while k < 0 {
        out *= 0.5;
        k += 1;
    }
    out
}

/// Cube root via exponent decomposition + Newton iterations.
///
/// x = mm · 2^(3q); Newton refines cbrt(mm) with a fixed iteration count so
/// every engine lands on the same fixed point.
pub fn cbrt_shared(x: f64) -> f64 {
    if x == 0.0 || x.is_nan() {
        return x;
    }
    if !x.is_finite() {
        return if x > 0.0 { f64::INFINITY } else { f64::NEG_INFINITY };
    }
    let neg = x < 0.0;
    let ax = if neg { -x } else { x };

    let (m0, e) = decompose(ax);
    // Math.floor(e / 3): floor division, not truncation — matters for e < 0.
    let q = (e as f64 / 3.0).floor() as i32;
    let r = e - 3 * q;
    let mm = scale_pow2(m0, r);

    let mut y = 1.0 + (mm - 1.0) / 3.0;
    for _ in 0..9 {
        y = (2.0 * y + mm / (y * y)) / 3.0;
    }

    let out = scale_pow2(y, q);
    if neg { -out } else { out }
}

/// sin/cos of degrees reduced exactly to [-45°, 45°], then fixed-order
/// Taylor/Horner series over portable operations.
pub fn sincos_deg(d: f64) -> (f64, f64) {
    if d.is_nan() || !d.is_finite() {
        return (f64::NAN, f64::NAN);
    }

    // Mirrors Math.round semantics via Math.floor(d/90 + 0.5).
    let n = ((d / 90.0) + 0.5).floor();
    let rest = d - n * 90.0; // exact for |d| ≤ ~2^45
    let rad = rest * PI_OVER_180;

    let x2 = rad * rad;
    let mut s = CSIN[11];
    for k in (0..=10).rev() {
        s = s * x2 + CSIN[k];
    }
    let s = s * rad;

    let mut c = CCOS[12];
    for k in (0..=11).rev() {
        c = c * x2 + CCOS[k];
    }

    (s, c)
}

/// sine of radians — same deterministic series, degree-reduced internally.
pub fn sin_rad(x: f64) -> f64 {
    sincos_deg(x * RAD_TO_DEG).0
}

/// log2 via atanh series on a mantissa pre-squeezed toward 1.
fn log2_shared(x: f64) -> f64 {
    let (mut m, mut e) = decompose(x);
    if m > SQRT2 {
        m *= 0.5;
        e += 1;
    }
    let z = (m - 1.0) / (m + 1.0);
    let z2 = z * z;
    let mut acc = CLN[12];
    for k in (0..=11).rev() {
        acc = acc * z2 + CLN[k];
    }
    let ln = 2.0 * z * acc;
    e as f64 + ln / LN2
}

/// exp2 via Taylor on g = f·ln2 with f ∈ [-0.5, 0.5], scaled by doublings.
fn exp2_shared(t: f64) -> f64 {
    if t.is_nan() {
        return f64::NAN;
    }
    if t > 2000.0 {
        return f64::INFINITY;
    }
    if t < -1075.0 {
        return 0.0;
    }
    let i = (t + 0.5).floor();
    let f = t - i;
    // The 1/k! series computes e^g; feed it g = f·ln2 so the result is 2^f.
    let g = f * LN2;
    let mut acc = CEXP[17];
    for k in (0..=16).rev() {
        acc = acc * g + CEXP[k];
    }
    scale_pow2(acc, i as i32)
}

/// pow(x, y) for x > 0 — deterministic by construction instead of
/// libm-dependent. Identity exponents stay exact.
pub fn pow_shared(x: f64, y: f64) -> f64 {
    if y == 0.0 || x == 1.0 {
        return 1.0;
    }
    if y == 1.0 {
        return x;
    }
    if x == 0.0 {
        return 0.0;
    }
    if x.is_nan() || y.is_nan() {
        return f64::NAN;
    }
    exp2_shared(y * log2_shared(x))
}

const SRGB_LINEAR_CUTOFF: f64 = 10.31475; // 0.04045 × 255

/// sRGB channel (0..255 scale) → linear. Canonical fused constants; see
/// the TS mirror for why this is not a lookup table.
pub fn srgb_to_linear_shared(c: f64) -> f64 {
    if c <= SRGB_LINEAR_CUTOFF {
        c / 3294.6
    } else {
        pow_shared((c + 14.025) / 269.025, 2.4)
    }
}
