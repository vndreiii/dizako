//! Grade/filter stage — mirror of `toneCurve`/`boxBlur`/`hueMatrix`/`prepare`.
//!
//! Parity-critical details: the graded plane is f32 storage with f64 local
//! arithmetic; blur accumulates in f64 over f32 loads; every store point and
//! operation order matches the TS engine.

use crate::color::luma;
use crate::settings::Settings;
use crate::shared::{pow_shared, sincos_deg};

/// Mirrors `Uint8ClampedArray` element stores (ToUint8Clamp: clamp, then
/// floor(x + 0.5)).
#[inline]
pub fn to_u8clamp(v: f64) -> u8 {
    if v.is_nan() {
        0
    } else if v <= 0.0 {
        0
    } else if v >= 255.0 {
        255
    } else {
        (v + 0.5).floor() as u8
    }
}

/// TS `clamp255`: clamps to range but keeps the float (f32 stores round).
#[inline]
pub fn clamp255(v: f64) -> f64 {
    if v < 0.0 {
        0.0
    } else if v > 255.0 {
        255.0
    } else {
        v
    }
}

fn tone_curve(s: &Settings) -> [u8; 256] {
    let mut lut = [0u8; 256];
    let gain = pow_shared(2.0, s.exposure);
    let bright = s.brightness * 2.55;
    let c = s.contrast * 2.55;
    let c = c.max(-255.0).min(255.0);
    let cf = (259.0 * (c + 255.0)) / (255.0 * (259.0 - c));
    let inv_gamma = 1.0 / s.gamma.max(0.01);
    for i in 0..256u16 {
        let mut v = f64::from(i) * gain + bright;
        v = cf * (v - 128.0) + 128.0;
        v = pow_shared(v.max(0.0) / 255.0, inv_gamma) * 255.0;
        lut[i as usize] = to_u8clamp(v);
    }
    lut
}

/// Separable box blur run three times, which converges on a gaussian.
fn box_blur(buf: &mut Vec<f32>, w: usize, h: usize, radius: f64) {
    let r = radius.max(1.0).round() as usize;
    let mut tmp = vec![0.0f32; buf.len()];
    let passes = 3;
    // The TS version ping-pongs `buf`/`tmp` three times (two swaps per pass,
    // so data ends back in `buf`); replicate with explicit double buffers.
    let mut from = buf.clone();
    for _ in 0..passes {
        // Horizontal.
        for y in 0..h {
            let row = y * w;
            for ch in 0..3 {
                let mut sum = 0.0f64;
                for k in -(r as isize)..=(r as isize) {
                    let x = (k.clamp(0, w as isize - 1)) as usize;
                    sum += f64::from(from[(row + x) * 3 + ch]);
                }
                for x in 0..w {
                    tmp[(row + x) * 3 + ch] = (sum / (2 * r + 1) as f64) as f32;
                    let out_i = (x as isize - r as isize).clamp(0, w as isize - 1) as usize;
                    let in_i = (x as isize + r as isize + 1).clamp(0, w as isize - 1) as usize;
                    sum += f64::from(from[(row + in_i) * 3 + ch])
                        - f64::from(from[(row + out_i) * 3 + ch]);
                }
            }
        }
        std::mem::swap(&mut from, &mut tmp);
        // Vertical.
        for x in 0..w {
            for ch in 0..3 {
                let mut sum = 0.0f64;
                for k in -(r as isize)..=(r as isize) {
                    let y = (k.clamp(0, h as isize - 1)) as usize;
                    sum += f64::from(from[(y * w + x) * 3 + ch]);
                }
                for y in 0..h {
                    tmp[(y * w + x) * 3 + ch] = (sum / (2 * r + 1) as f64) as f32;
                    let out_i = (y as isize - r as isize).clamp(0, h as isize - 1) as usize;
                    let in_i = (y as isize + r as isize + 1).clamp(0, h as isize - 1) as usize;
                    sum += f64::from(from[(in_i * w + x) * 3 + ch])
                        - f64::from(from[(out_i * w + x) * 3 + ch]);
                }
            }
        }
        std::mem::swap(&mut from, &mut tmp);
    }
    buf.copy_from_slice(&from);
}

/// Standard luma-preserving hue rotation matrix via shared sincos.
fn hue_matrix(deg: f64) -> [f64; 9] {
    let (s, c) = sincos_deg(deg);
    let lr = 0.213;
    let lg = 0.715;
    let lb = 0.072;
    [
        lr + c * (1.0 - lr) - s * lr,
        lg - c * lg - s * lg,
        lb - c * lb + s * (1.0 - lb),
        lr - c * lr + s * 0.143,
        lg + c * (1.0 - lg) + s * 0.14,
        lb - c * lb - s * 0.283,
        lr - c * lr - s * (1.0 - lr),
        lg - c * lg + s * lg,
        lb + c * (1.0 - lb) + s * lb,
    ]
}

/// Decodes RGBA into the f32 working plane with grading then filtering.
pub fn prepare(data: &[u8], w: usize, h: usize, s: &Settings) -> Vec<f32> {
    let mut buf = vec![0.0f32; w * h * 3];
    let lut = tone_curve(s);

    let hm: Option<[f64; 9]> = if s.hue_shift != 0.0 {
        Some(hue_matrix(s.hue_shift))
    } else {
        None
    };
    let temp = s.temperature * 0.6;
    let tint = s.tint * 0.5;
    let sat = 1.0 + s.saturation / 100.0;

    for i in 0..(w * h) {
        let o = i * 4;
        let j = i * 3;
        let mut r = f64::from(lut[data[o] as usize]);
        let mut g = f64::from(lut[data[o + 1] as usize]);
        let mut b = f64::from(lut[data[o + 2] as usize]);

        if temp != 0.0 {
            r += temp;
            b -= temp;
        }
        if tint != 0.0 {
            g += tint;
            r -= tint * 0.5;
            b -= tint * 0.5;
        }
        if let Some(hm) = hm {
            let nr = r * hm[0] + g * hm[1] + b * hm[2];
            let ng = r * hm[3] + g * hm[4] + b * hm[5];
            let nb = r * hm[6] + g * hm[7] + b * hm[8];
            r = nr;
            g = ng;
            b = nb;
        }
        if sat != 1.0 {
            let y = luma(r, g, b);
            r = y + (r - y) * sat;
            g = y + (g - y) * sat;
            b = y + (b - y) * sat;
        }
        if s.grayscale {
            let y = luma(r, g, b);
            r = y;
            g = y;
            b = y;
        }
        if s.invert {
            r = 255.0 - r;
            g = 255.0 - g;
            b = 255.0 - b;
        }

        buf[j] = clamp255(r) as f32;
        buf[j + 1] = clamp255(g) as f32;
        buf[j + 2] = clamp255(b) as f32;
    }

    if s.blur > 0.0 {
        box_blur(&mut buf, w, h, s.blur);
    }
    if s.sharpen > 0.0 {
        // Unsharp mask: the difference against a blurred copy, added back.
        let mut soft = buf.clone();
        box_blur(&mut soft, w, h, 1.0 + s.sharpen);
        let amount = s.sharpen;
        for i in 0..buf.len() {
            buf[i] = clamp255(f64::from(buf[i]) + (f64::from(buf[i]) - f64::from(soft[i])) * amount)
                as f32;
        }
    }

    buf
}
