//! Area-averaging downscale for RGBA planes.
//!
//! The preview renders a reduced copy of the image first so a slider drag gets
//! an answer quickly. That copy used to be made on the main thread through a
//! pair of canvases, which stalled the UI for a large image and needed a DOM
//! the worker does not have. It lives in the engine now: no canvas, no host
//! dependency, and the same result on every platform.
//!
//! Each destination pixel is the exact area-weighted mean of the source pixels
//! it covers, which is what a box filter is and what keeps a dithered preview
//! from aliasing.

/// Per-destination-pixel source span with fractional edge weights.
struct Spans {
    start: Vec<u32>,
    weights: Vec<Vec<f32>>,
}

fn spans(src: usize, dst: usize) -> Spans {
    let ratio = src as f64 / dst as f64;
    let mut start = Vec::with_capacity(dst);
    let mut weights = Vec::with_capacity(dst);
    for d in 0..dst {
        let lo = d as f64 * ratio;
        let hi = ((d + 1) as f64 * ratio).min(src as f64);
        let first = lo.floor() as usize;
        let last = (hi.ceil() as usize).min(src);
        let mut w = Vec::with_capacity(last.saturating_sub(first).max(1));
        let mut total = 0.0f64;
        for i in first..last.max(first + 1) {
            let overlap = (hi.min((i + 1) as f64) - lo.max(i as f64)).max(0.0);
            w.push(overlap as f32);
            total += overlap;
        }
        if total <= 0.0 {
            w = vec![1.0];
            total = 1.0;
        }
        let inv = (1.0 / total) as f32;
        for v in &mut w {
            *v *= inv;
        }
        start.push(first.min(src.saturating_sub(1)) as u32);
        weights.push(w);
    }
    Spans { start, weights }
}

/// Resamples `src` (`sw` x `sh` RGBA) to `dw` x `dh`.
pub fn area_downscale(src: &[u8], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u8> {
    if dw == 0 || dh == 0 || sw == 0 || sh == 0 || src.len() < sw * sh * 4 {
        return Vec::new();
    }
    if dw == sw && dh == sh {
        return src[..sw * sh * 4].to_vec();
    }

    let xs = spans(sw, dw);
    // Horizontal pass: every source row, narrowed to `dw`.
    let mut tmp = vec![0.0f32; dw * sh * 4];
    for y in 0..sh {
        let row = &src[y * sw * 4..(y + 1) * sw * 4];
        let out = &mut tmp[y * dw * 4..(y + 1) * dw * 4];
        for x in 0..dw {
            let s0 = xs.start[x] as usize;
            let (mut r, mut g, mut b, mut a) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
            for (k, &w) in xs.weights[x].iter().enumerate() {
                let p = (s0 + k).min(sw - 1) * 4;
                r += f32::from(row[p]) * w;
                g += f32::from(row[p + 1]) * w;
                b += f32::from(row[p + 2]) * w;
                a += f32::from(row[p + 3]) * w;
            }
            out[x * 4] = r;
            out[x * 4 + 1] = g;
            out[x * 4 + 2] = b;
            out[x * 4 + 3] = a;
        }
    }

    // Vertical pass: rows narrowed to `dh`, written back as bytes.
    let ys = spans(sh, dh);
    let mut out = vec![0u8; dw * dh * 4];
    let mut acc = vec![0.0f32; dw * 4];
    for y in 0..dh {
        acc.iter_mut().for_each(|v| *v = 0.0);
        let s0 = ys.start[y] as usize;
        for (k, &w) in ys.weights[y].iter().enumerate() {
            let row = &tmp[(s0 + k).min(sh - 1) * dw * 4..][..dw * 4];
            for (a, &v) in acc.iter_mut().zip(row) {
                *a += v * w;
            }
        }
        for (o, &a) in out[y * dw * 4..(y + 1) * dw * 4].iter_mut().zip(&acc) {
            *o = (a + 0.5).clamp(0.0, 255.0) as u8;
        }
    }
    out
}

/// Destination size that holds about `target` pixels and keeps the aspect.
pub fn fit_pixels(sw: usize, sh: usize, target: usize) -> (usize, usize) {
    let total = sw * sh;
    if total == 0 || total <= target {
        return (sw, sh);
    }
    let scale = (target as f64 / total as f64).sqrt();
    (
        ((sw as f64 * scale).round() as usize).clamp(1, sw),
        ((sh as f64 * scale).round() as usize).clamp(1, sh),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_colour_stays_flat_and_means_are_preserved() {
        let src: Vec<u8> = (0..30 * 20).flat_map(|_| [90u8, 140, 200, 255]).collect();
        let out = area_downscale(&src, 30, 20, 7, 5);
        assert_eq!(out.len(), 7 * 5 * 4);
        assert!(out.chunks(4).all(|p| p == [90, 140, 200, 255]));

        // Two columns, black and white, halved: one grey pixel.
        let src = [0, 0, 0, 255, 255, 255, 255, 255];
        assert_eq!(area_downscale(&src, 2, 1, 1, 1), vec![128, 128, 128, 255]);
    }

    #[test]
    fn fit_keeps_aspect_and_never_upscales() {
        assert_eq!(fit_pixels(100, 100, 1_000_000), (100, 100));
        let (w, h) = fit_pixels(4000, 2000, 240_000);
        assert!((w * h) as f64 / 240_000.0 > 0.95 && (w * h) as f64 / 240_000.0 < 1.05);
        assert!(w.abs_diff(h * 2) <= 2, "{w}x{h} lost the 2:1 aspect");
    }
}
