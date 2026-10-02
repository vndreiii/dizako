//! The fast shared-math paths must return the *same bits* as the original
//! loop-based implementations. The golden hashes depend on it: a one-ulp drift
//! in `cbrt` or `pow` flips nearest-colour ties and the parity gate fails.
//!
//! The reference below is the pre-optimisation code, kept verbatim.

use dither_wasm::shared::{cbrt_shared, pow_shared, srgb_to_linear_shared};
use dither_wasm::tables::{CEXP, CLN, LN2, SQRT2};

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

fn ref_cbrt(x: f64) -> f64 {
    if x == 0.0 || x.is_nan() {
        return x;
    }
    if !x.is_finite() {
        return if x > 0.0 { f64::INFINITY } else { f64::NEG_INFINITY };
    }
    let neg = x < 0.0;
    let ax = if neg { -x } else { x };
    let (m0, e) = decompose(ax);
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

fn ref_log2(x: f64) -> f64 {
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

fn ref_exp2(t: f64) -> f64 {
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
    let g = f * LN2;
    let mut acc = CEXP[17];
    for k in (0..=16).rev() {
        acc = acc * g + CEXP[k];
    }
    scale_pow2(acc, i as i32)
}

fn ref_pow(x: f64, y: f64) -> f64 {
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
    ref_exp2(y * ref_log2(x))
}

fn ref_srgb(c: f64) -> f64 {
    if c <= 10.31475 {
        c / 3294.6
    } else {
        ref_pow((c + 14.025) / 269.025, 2.4)
    }
}

struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 11) as f64) / ((1u64 << 53) as f64)
    }
}

fn same(a: f64, b: f64) -> bool {
    a.to_bits() == b.to_bits() || (a.is_nan() && b.is_nan())
}

#[test]
fn cbrt_matches_reference_bit_for_bit() {
    let mut rng = Lcg(0xC0FFEE);
    for _ in 0..1_500_000 {
        // The domain the engine actually feeds it: linear-light mixes, 0..~1.1.
        let x = rng.next() * 1.2;
        assert!(same(cbrt_shared(x), ref_cbrt(x)), "cbrt({x:e})");
        // And a wide log-spread sweep so exponent handling is exercised.
        let wide = (rng.next() * 40.0 - 20.0).exp2();
        assert!(same(cbrt_shared(wide), ref_cbrt(wide)), "cbrt({wide:e})");
        assert!(same(cbrt_shared(-wide), ref_cbrt(-wide)), "cbrt(-{wide:e})");
    }
    for x in [0.0, -0.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 1.0, 8.0, 27.0, 1e-300, 5e-324, f64::MAX] {
        assert!(same(cbrt_shared(x), ref_cbrt(x)), "cbrt({x:e})");
    }
}

#[test]
fn pow_and_srgb_match_reference_bit_for_bit() {
    let mut rng = Lcg(0xBADF00D);
    for _ in 0..1_500_000 {
        let c = rng.next() * 270.0 - 8.0;
        assert!(same(srgb_to_linear_shared(c), ref_srgb(c)), "srgb({c})");

        let x = rng.next() * 3.0 + 1e-6;
        let y = rng.next() * 6.0 - 3.0;
        assert!(same(pow_shared(x, y), ref_pow(x, y)), "pow({x}, {y})");
    }
    for (x, y) in [(2.0, 0.0), (0.0, 2.4), (1.0, 9.0), (0.5, 1.0), (1e-300, 0.5), (1e300, 0.5), (3.0, -1075.0)] {
        assert!(same(pow_shared(x, y), ref_pow(x, y)), "pow({x}, {y})");
    }
    // Every integer channel value, which is what palette colours and flat
    // regions of an image actually hit.
    for i in 0..=255 {
        let c = i as f64;
        assert!(same(srgb_to_linear_shared(c), ref_srgb(c)), "srgb({c})");
    }
}
