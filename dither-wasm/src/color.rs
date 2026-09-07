//! Colour helpers — mirror of `src/dither/color.ts` (engine-relevant parts).

use crate::shared::{cbrt_shared, srgb_to_linear_shared};

/// Rec. 601 luma over f64, matching the TS `luma`.
#[inline]
pub fn luma(r: f64, g: f64, b: f64) -> f64 {
    0.299 * r + 0.587 * g + 0.114 * b
}

/// Parses `#rgb` / `#rrggbb` into channel triples.
pub fn hex_to_rgb(hex: &str) -> (f64, f64, f64) {
    let h = hex.trim_start_matches('#');
    let full: String = if h.len() == 3 {
        h.chars().flat_map(|c| [c, c]).collect()
    } else {
        h.to_string()
    };
    let byte = |i: usize| -> f64 {
        u8::from_str_radix(full.get(i..i + 2).unwrap_or("00"), 16).unwrap_or(0) as f64
    };
    (byte(0), byte(2), byte(4))
}

/// Björn Ottosson's OKLab via shared deterministic transcendentals.
pub fn rgb_to_oklab(r: f64, g: f64, b: f64) -> (f64, f64, f64) {
    let lr = srgb_to_linear_shared(r);
    let lg = srgb_to_linear_shared(g);
    let lb = srgb_to_linear_shared(b);

    let l = cbrt_shared(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    let m = cbrt_shared(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    let s = cbrt_shared(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

    (
        0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    )
}
