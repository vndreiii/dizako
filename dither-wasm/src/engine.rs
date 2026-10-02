//! The dither engine — mirror of the pass functions and `dither()` dispatcher
//! in `src/dither/algorithms.ts`.
//!
//! Storage widths are part of the parity contract: f32 planes with f64 local
//! arithmetic everywhere the TS engine uses Float32Arrays.

use crate::ascii::GlyphAtlas;
use crate::color::{luma, rgb_to_oklab};
use crate::kernels;
use crate::masks::{bayer_matrix, blue_noise, checker_mask, ign};
use crate::palette::{compile_palette, Palette};
use crate::prepare::{prepare, to_u8clamp};
use crate::settings::Settings;
use crate::shared::{pow_shared, sincos_deg, sin_rad};

type Matcher = fn(&Palette, f64, f64, f64) -> usize;

/// One slot of the match memo: the exact input triple and the layer it chose.
#[derive(Clone, Copy)]
struct MemoSlot {
    key: [u64; 3],
    idx: u32,
}

const MEMO_SLOTS: usize = 4096;
const MEMO_EMPTY: u32 = u32::MAX;

struct Ctx<'a> {
    src: &'a [f32],
    /// Pre-rasterised glyphs, only ever populated for the text algorithm.
    glyphs: &'a GlyphAtlas,
    out: &'a mut [u8],
    alpha: &'a [u8],
    w: usize,
    h: usize,
    p: &'a Palette,
    match_fn: Matcher,
    /// Direct-mapped memo of `match_fn`, only populated for the one matcher
    /// expensive enough to be worth it (OKLab). Matching is a pure function of
    /// `(palette, r, g, b)`, so replaying a stored answer for a bit-identical
    /// input is exact - this is a cache, not an approximation.
    memo: Vec<MemoSlot>,
    s: &'a Settings,
}

impl Ctx<'_> {
    /// Nearest layer for a colour, through the memo when there is one.
    ///
    /// Flat regions, posterised input (every pass after the first in a stack)
    /// and ordered masks with few distinct offsets all feed the matcher the
    /// same triple again and again.
    #[inline]
    fn find(&mut self, r: f64, g: f64, b: f64) -> usize {
        if self.memo.is_empty() {
            return (self.match_fn)(self.p, r, g, b);
        }
        let key = [r.to_bits(), g.to_bits(), b.to_bits()];
        let h = key[0].wrapping_mul(0x9E37_79B9_7F4A_7C15)
            ^ key[1].wrapping_mul(0xC2B2_AE3D_27D4_EB4F)
            ^ key[2].wrapping_mul(0x1656_67B1_9E37_79F9);
        let slot = (h >> 40) as usize & (MEMO_SLOTS - 1);
        let hit = self.memo[slot];
        if hit.idx != MEMO_EMPTY && hit.key == key {
            return hit.idx as usize;
        }
        let idx = (self.match_fn)(self.p, r, g, b);
        self.memo[slot] = MemoSlot { key, idx: idx as u32 };
        idx
    }
}

#[inline]
fn put(c: &mut Ctx, i: usize, idx: usize) {
    let o = i * 4;
    c.out[o] = to_u8clamp(f64::from(c.p.r[idx]));
    c.out[o + 1] = to_u8clamp(f64::from(c.p.g[idx]));
    c.out[o + 2] = to_u8clamp(f64::from(c.p.b[idx]));
    c.out[o + 3] = c.alpha[i];
}

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */

fn tonal_penalty(p: &Palette, i: usize, yn: f64, scale: f64) -> f64 {
    let dt = yn - f64::from(p.tone[i]);
    p.bias * dt * dt * scale
}

fn match_rgb(p: &Palette, r: f64, g: f64, b: f64) -> usize {
    let yn = if p.bias == 0.0 { 0.0 } else { luma(r, g, b) / 255.0 };
    let mut best = 0usize;
    let mut best_d = f64::INFINITY;
    for i in 0..p.n {
        let dr = r - f64::from(p.r[i]);
        let dg = g - f64::from(p.g[i]);
        let db = b - f64::from(p.b[i]);
        let mut d =
            (0.299 * dr * dr + 0.587 * dg * dg + 0.114 * db * db) * f64::from(p.pull[i]);
        if p.bias != 0.0 {
            d += tonal_penalty(p, i, yn, 65025.0);
        }
        if d < best_d {
            best_d = d;
            best = i;
        }
    }
    best
}

fn match_luma(p: &Palette, r: f64, g: f64, b: f64) -> usize {
    let y = luma(r, g, b);
    let mut best = 0usize;
    let mut best_d = f64::INFINITY;
    for i in 0..p.n {
        let mut d = (y - f64::from(p.y[i])).abs() * f64::from(p.pull[i]);
        if p.bias != 0.0 {
            d += tonal_penalty(p, i, y / 255.0, 255.0);
        }
        if d < best_d {
            best_d = d;
            best = i;
        }
    }
    best
}

fn match_oklab(p: &Palette, r: f64, g: f64, b: f64) -> usize {
    let (l, a, bb) = rgb_to_oklab(r, g, b);
    let yn = if p.bias == 0.0 { 0.0 } else { luma(r, g, b) / 255.0 };
    let mut best = 0usize;
    let mut best_d = f64::INFINITY;
    for i in 0..p.n {
        let dl = l - f64::from(p.lab[i * 3]);
        let da = a - f64::from(p.lab[i * 3 + 1]);
        let db = bb - f64::from(p.lab[i * 3 + 2]);
        let mut d = (dl * dl + da * da + db * db) * f64::from(p.pull[i]);
        if p.bias != 0.0 {
            d += tonal_penalty(p, i, yn, 1.0);
        }
        if d < best_d {
            best_d = d;
            best = i;
        }
    }
    best
}

/// Straight tonal-band lookup: brightness decides the layer, nothing else.
fn match_tonal(p: &Palette, r: f64, g: f64, b: f64) -> usize {
    let t = luma(r, g, b) / 255.0;
    for k in 0..p.n {
        if t <= f64::from(p.band_edge[k]) {
            return p.order[k];
        }
    }
    p.order[p.n - 1]
}

fn matcher_for(mode: &str) -> Matcher {
    match mode {
        "luma" => match_luma,
        "oklab" => match_oklab,
        "tonal" => match_tonal,
        _ => match_rgb,
    }
}

/* ------------------------------------------------------------------ */
/* Random                                                              */
/* ------------------------------------------------------------------ */

/// xorshift32 with the fixed seed — previews stay stable per setting.
pub struct Rng(u32);

impl Rng {
    pub fn new() -> Self {
        Rng(0x2545_f491)
    }

    #[inline]
    pub fn next(&mut self) -> f64 {
        let mut s = self.0;
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        self.0 = s;
        f64::from(s) / 4294967296.0
    }
}

impl Default for Rng {
    fn default() -> Self {
        Self::new()
    }
}

/* ------------------------------------------------------------------ */
/* Passes                                                              */
/* ------------------------------------------------------------------ */

/// Ordered family: perturb by a mask, then match. No error is carried.
fn ordered_pass(c: &mut Ctx, mask: impl Fn(usize, usize) -> f64) {
    let (w, h) = (c.w, c.h);
    let spread = (255.0 / (c.p.n as f64 - 1.0).max(1.0)) * c.s.strength;
    let bias = (c.s.threshold - 128.0) / 255.0;
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let j = i * 3;
            let shift = (mask(x, y) - 0.5 + bias) * spread;
            let r = f64::from(c.src[j]) + shift;
            let g = f64::from(c.src[j + 1]) + shift;
            let b = f64::from(c.src[j + 2]) + shift;
            let idx = c.find(r, g, b);
            put(c, i, idx);
        }
    }
}

/// Block quantisation followed by deterministic channel-data loss bursts.
fn jpeg_sort_pass(c: &mut Ctx) {
    let (w, h) = (c.w, c.h);
    let log = (1.0 + c.s.jpeg_damage.max(0.0)).log10();
    let block = c.s.jpeg_cell_size.round().clamp(2.0, 128.0) as usize;
    let quant = (1.0 + log * 8.0).max(1.0);
    let retention = 1.0 / (1.0 + log * 0.7);
    let bw = (w + block - 1) / block;
    let bh = (h + block - 1) / block;
    let mut avgs = vec![[0.0f64; 3]; bw * bh];
    for by_i in 0..bh {
        for bx_i in 0..bw {
            let bx = bx_i * block;
            let by = by_i * block;
            let ex = (bx + block).min(w);
            let ey = (by + block).min(h);
            let mut n = 0.0;
            for yy in by..ey {
                for xx in bx..ex {
                    let j = (yy * w + xx) * 3;
                    for ch in 0..3 { avgs[by_i * bw + bx_i][ch] += f64::from(c.src[j + ch]); }
                    n += 1.0;
                }
            }
            for ch in 0..3 { avgs[by_i * bw + bx_i][ch] /= n; }
        }
    }
    for y in 0..h {
        for x in 0..w {
            let avg = avgs[(y / block) * bw + x / block];
            let j = (y * w + x) * 3;
            let mut rgb = [0.0; 3];
            for ch in 0..3 {
                let v = avg[ch] + (f64::from(c.src[j + ch]) - avg[ch]) * retention;
                rgb[ch] = (v / quant).round() * quant;
            }
            let idx = c.find(rgb[0], rgb[1], rgb[2]);
            put(c, y * w + x, idx);
        }
    }

    let density = c.s.jpeg_error_density.clamp(0.0, 1.0);
    let rate = c.s.jpeg_error_rate.clamp(0.0, 8.0);
    let amplitude = c.s.jpeg_error_amplitude.clamp(0.0, 4.0);
    let coherence = c.s.jpeg_error_coherence.clamp(0.0, 1.0);
    if density <= 0.0 || rate <= 0.0 || amplitude <= 0.0 { return; }
    let cluster = 1 + (coherence * 15.0).round() as usize;
    let rw = block.min(w);
    for cy in 0..bh {
        for cx in 0..bw {
            let cell_hash = jpeg_hash((cx / cluster) as u32, (cy / cluster) as u32, 0);
            if jpeg_unit(cell_hash) >= density { continue; }
            let whole = rate.floor() as usize;
            let extra = usize::from(jpeg_unit(jpeg_hash(cx as u32, cy as u32, 1)) < rate.fract());
            for event in 0..whole + extra {
                let hash = jpeg_hash(cx as u32, cy as u32, event as u32 + 2);
                let x0 = cx * block;
                let y0 = cy * block;
                let cell_w = (x0 + block).min(w) - x0;
                let cell_h = (y0 + block).min(h) - y0;
                let y = y0 + (hash as usize % cell_h);
                let start = x0 + ((hash >> 8) as usize % cell_w);
                let max_span = ((amplitude * rw as f64).round() as usize).clamp(1, rw);
                let span = 1 + ((hash >> 16) as usize % max_span);
                let channels = 1 + ((hash >> 24) as usize % 3);
                let source_x = start.saturating_sub(1);
                for x in start..(start + span).min(x0 + cell_w) {
                    let dst = (y * w + x) * 4;
                    let src = (y * w + source_x) * 4;
                    for ch in 0..channels { c.out[dst + ch] = c.out[src + ch]; }
                }
            }
        }
    }
}

#[inline]
fn jpeg_hash(x: u32, y: u32, seed: u32) -> u32 {
    let mut value = x.wrapping_mul(0x9E37_79B9) ^ y.wrapping_mul(0x85EB_CA6B) ^ seed.wrapping_mul(0xC2B2_AE35);
    value ^= value >> 16;
    value = value.wrapping_mul(0x7FEB_352D);
    value ^= value >> 15;
    value = value.wrapping_mul(0x846C_A68B);
    value ^ (value >> 16)
}

#[inline]
fn jpeg_unit(value: u32) -> f64 { f64::from(value) / f64::from(u32::MAX) }

fn threshold_pass(c: &mut Ctx, noise: f64) {
    let (w, h) = (c.w, c.h);
    let mut rand = Rng::new();
    let n = c.p.n as f64;
    let bias = (c.s.threshold - 128.0) * (255.0 / (n - 1.0).max(1.0)) / 128.0;
    for i in 0..w * h {
        let j = i * 3;
        let nz = if noise > 0.0 { (rand.next() - 0.5) * noise * 255.0 } else { 0.0 };
        let r = f64::from(c.src[j]) + bias + nz;
        let g = f64::from(c.src[j + 1]) + bias + nz;
        let b = f64::from(c.src[j + 2]) + bias + nz;
        let idx = c.find(r, g, b);
        put(c, i, idx);
    }
}

fn error_diffuse_pass(c: &mut Ctx, kernel: &kernels::Kernel, div: f64) {
    let (w, h) = (c.w, c.h);
    let strength = c.s.strength;
    let clamp_to = c.s.error_clamp;
    let jitter = c.s.jitter;
    let serpentine = c.s.serpentine;
    let mut rand = Rng::new();
    let mut err = vec![0.0f32; w * h * 3];

    for y in 0..h {
        let reverse = serpentine && y % 2 == 1;
        for step in 0..w {
            let x = if reverse { w - 1 - step } else { step };
            let i = y * w + x;
            let j = i * 3;

            let r = f64::from(c.src[j]) + f64::from(err[j]);
            let g = f64::from(c.src[j + 1]) + f64::from(err[j + 1]);
            let b = f64::from(c.src[j + 2]) + f64::from(err[j + 2]);
            let idx = c.find(r, g, b);
            put(c, i, idx);

            let mut er = (r - f64::from(c.p.r[idx])) * strength;
            let mut eg = (g - f64::from(c.p.g[idx])) * strength;
            let mut eb = (b - f64::from(c.p.b[idx])) * strength;
            if clamp_to > 0.0 {
                er = er.max(-clamp_to).min(clamp_to);
                eg = eg.max(-clamp_to).min(clamp_to);
                eb = eb.max(-clamp_to).min(clamp_to);
            }

            for &(dx, dy, weight) in kernel.taps {
                // On a right-to-left row the kernel has to be mirrored.
                let nx = x as i32 + if reverse { -dx } else { dx };
                let ny = y as i32 + dy;
                if nx < 0 || nx >= w as i32 || ny >= h as i32 {
                    continue;
                }
                let mut f = weight / div;
                if jitter > 0.0 {
                    // PRNG is consumed only for taps that pass the bounds
                    // check; cloning this control flow verbatim matters.
                    f *= 1.0 + (rand.next() - 0.5) * jitter;
                }
                let nj = ((ny as usize) * w + nx as usize) * 3;
                // Float32Array semantics: f32 load, f64 add, one rounding.
                err[nj] = (f64::from(err[nj]) + er * f) as f32;
                err[nj + 1] = (f64::from(err[nj + 1]) + eg * f) as f32;
                err[nj + 2] = (f64::from(err[nj + 2]) + eb * f) as f32;
            }
        }
    }
}

/// Tone-adaptive diffusion in the spirit of Ostromoukhov's variable
/// coefficients.
fn adaptive_diffuse_pass(c: &mut Ctx) {
    let (w, h) = (c.w, c.h);
    let strength = c.s.strength;
    let clamp_to = c.s.error_clamp;
    let serpentine = c.s.serpentine;
    let mut err = vec![0.0f32; w * h * 3];

    for y in 0..h {
        let reverse = serpentine && y % 2 == 1;
        for step in 0..w {
            let x = if reverse { w - 1 - step } else { step };
            let i = y * w + x;
            let j = i * 3;

            let r = f64::from(c.src[j]) + f64::from(err[j]);
            let g = f64::from(c.src[j + 1]) + f64::from(err[j + 1]);
            let b = f64::from(c.src[j + 2]) + f64::from(err[j + 2]);
            let idx = c.find(r, g, b);
            put(c, i, idx);

            // Extremity: 0 in the midtones, 1 at either end of the range.
            let t = (luma(r, g, b) / 255.0).clamp(0.0, 1.0);
            let ext = (t - 0.5).abs() * 2.0;
            let forward = 7.0 + 9.0 * ext * ext;
            let down = 5.0 * (1.0 - ext);
            let left = 3.0 * (1.0 - ext);
            let diag = 1.0 * (1.0 - ext);
            let div = forward + down + left + diag;

            let mut er = (r - f64::from(c.p.r[idx])) * strength;
            let mut eg = (g - f64::from(c.p.g[idx])) * strength;
            let mut eb = (b - f64::from(c.p.b[idx])) * strength;
            if clamp_to > 0.0 {
                er = er.max(-clamp_to).min(clamp_to);
                eg = eg.max(-clamp_to).min(clamp_to);
                eb = eb.max(-clamp_to).min(clamp_to);
            }

            let taps: [(i32, i32, f64); 4] =
                [(1, 0, forward), (-1, 1, left), (0, 1, down), (1, 1, diag)];
            for (dx, dy, weight) in taps {
                if weight <= 0.0 {
                    continue;
                }
                let nx = x as i32 + if reverse { -dx } else { dx };
                let ny = y as i32 + dy;
                if nx < 0 || nx >= w as i32 || ny >= h as i32 {
                    continue;
                }
                let f = weight / div;
                let nj = ((ny as usize) * w + nx as usize) * 3;
                err[nj] = (f64::from(err[nj]) + er * f) as f32;
                err[nj + 1] = (f64::from(err[nj + 1]) + eg * f) as f32;
                err[nj + 2] = (f64::from(err[nj + 2]) + eb * f) as f32;
            }
        }
    }
}

/* -------------------------- Riemersma ---------------------------- */

/// Hilbert index → coordinate, for a curve of side `n` (a power of two).
/// Only the equivalence test walks the curve this way now; the pass itself
/// uses the pruned traversal.
#[cfg(test)]
fn hilbert_xy(n: usize, d: usize) -> (usize, usize) {
    let mut x: usize = 0;
    let mut y: usize = 0;
    let mut t = d;
    let mut s: usize = 1;
    while s < n {
        let rx = 1 & (t >> 1);
        let ry = 1 & (t ^ rx);
        if ry == 0 {
            if rx == 1 {
                x = s - 1 - x;
                y = s - 1 - y;
            }
            std::mem::swap(&mut x, &mut y);
        }
        x += s * rx;
        y += s * ry;
        t >>= 2;
        s *= 2;
    }
    (x, y)
}

/// ceil(log2(n)) for n ≥ 2 via bit length, matching Math.ceil(Math.log2(n))
/// exactly over the engine's input range without libm.
fn ceil_log2(n: usize) -> u32 {
    (n - 1).bit_length()
}

/// round(log2(n)) for integer n ≥ 1, exact with integers so it agrees with
/// Math.round(Math.log2(n)) everywhere without libm. frac ≥ 0.5 ⇔ n² ≥ 2^(2·bl−1).
fn round_log2(n: usize) -> u32 {
    if n <= 1 {
        return 0;
    }
    let bl = (n - 1).bit_length();
    let t = 1u64 << (bl - 1);
    let nu = n as u64;
    if nu == t {
        bl - 1
    } else if nu * nu >= t * t * 2 {
        bl
    } else {
        bl - 1
    }
}

trait BitLengthExt {
    fn bit_length(self) -> u32;
}

impl BitLengthExt for usize {
    fn bit_length(self) -> u32 {
        usize::BITS - self.leading_zeros()
    }
}

/// Integer affine map, enough to carry a Hilbert sub-square's orientation.
#[derive(Clone, Copy)]
struct Affine {
    a: i64,
    b: i64,
    c: i64,
    d: i64,
    e: i64,
    f: i64,
}

impl Affine {
    const IDENTITY: Affine = Affine { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

    #[inline]
    fn apply(&self, x: i64, y: i64) -> (i64, i64) {
        (self.a * x + self.b * y + self.e, self.c * x + self.d * y + self.f)
    }

    /// `self ∘ inner`: apply `inner` first.
    fn after(&self, inner: &Affine) -> Affine {
        Affine {
            a: self.a * inner.a + self.b * inner.c,
            b: self.a * inner.b + self.b * inner.d,
            c: self.c * inner.a + self.d * inner.c,
            d: self.c * inner.b + self.d * inner.d,
            e: self.a * inner.e + self.b * inner.f + self.e,
            f: self.c * inner.e + self.d * inner.f + self.f,
        }
    }
}

/// Quadrant `q` of a size-`2s` Hilbert square, as the map from the quadrant's
/// own coordinates into its parent's. The four cases are exactly the
/// rotate-then-offset step of `hilbert_xy`, one per value of the digit.
fn hilbert_quadrant(q: usize, s: i64) -> Affine {
    match q {
        0 => Affine { a: 0, b: 1, c: 1, d: 0, e: 0, f: 0 },
        1 => Affine { a: 1, b: 0, c: 0, d: 1, e: 0, f: s },
        2 => Affine { a: 1, b: 0, c: 0, d: 1, e: s, f: s },
        _ => Affine { a: 0, b: -1, c: -1, d: 0, e: 2 * s - 1, f: s - 1 },
    }
}

fn hilbert_collect(
    size: i64,
    map: &Affine,
    w: i64,
    h: i64,
    out: &mut Vec<u32>,
) {
    // The map is a signed permutation, so a square lands on a square and two
    // opposite corners bound it.
    let (x0, y0) = map.apply(0, 0);
    let (x1, y1) = map.apply(size - 1, size - 1);
    if x0.min(x1) >= w || y0.min(y1) >= h {
        return;
    }
    if size == 1 {
        out.push((y0 * w + x0) as u32);
        return;
    }
    let half = size / 2;
    for q in 0..4 {
        let child = map.after(&hilbert_quadrant(q, half));
        hilbert_collect(half, &child, w, h, out);
    }
}

/// Pixel indices of a `w` x `h` image in Hilbert-curve order.
///
/// This is the curve of the enclosing power-of-two square with the cells
/// outside the image removed, which is what the pass has always walked - but
/// whole quadrants that fall outside are skipped instead of being generated one
/// cell at a time and discarded. On a 16:9 frame the square is several times
/// the image, and that discarded work was most of the pass's overhead.
fn hilbert_order(w: usize, h: usize) -> Vec<u32> {
    let side: usize = 1 << ceil_log2(w.max(h).max(2));
    let mut out = Vec::with_capacity(w * h);
    hilbert_collect(side as i64, &Affine::IDENTITY, w as i64, h as i64, &mut out);
    out
}

fn riemersma_pass(c: &mut Ctx) {
    let (w, h) = (c.w, c.h);
    let q_len = (c.s.riemersma_queue.round().max(1.0)) as usize;
    let decay = c.s.riemersma_decay.clamp(0.01, 0.99);

    // Exponential weights, normalised so the queue is energy-preserving.
    // Stored through f32 like the TS Float32Array.
    let mut weights = vec![0.0f32; q_len];
    let mut wsum = 0.0f64;
    for k in 0..q_len {
        weights[k] = pow_shared(decay, k as f64) as f32;
        wsum += f64::from(weights[k]);
    }
    for k in 0..q_len {
        weights[k] = (f64::from(weights[k]) / wsum) as f32;
    }
    let weights: Vec<f64> = weights.iter().map(|&v| f64::from(v)).collect();

    let mut qr = vec![0.0f32; q_len];
    let mut qg = vec![0.0f32; q_len];
    let mut qb = vec![0.0f32; q_len];
    let mut head: usize = 0;

    for pixel in hilbert_order(w, h) {
        let i = pixel as usize;
        let j = i * 3;

        let mut ar = 0.0;
        let mut ag = 0.0;
        let mut ab = 0.0;
        let mut slot = head;
        for &weight in &weights {
            ar += f64::from(qr[slot]) * weight;
            ag += f64::from(qg[slot]) * weight;
            ab += f64::from(qb[slot]) * weight;
            slot += 1;
            if slot == q_len {
                slot = 0;
            }
        }

        let r = f64::from(c.src[j]) + ar * c.s.strength;
        let g = f64::from(c.src[j + 1]) + ag * c.s.strength;
        let b = f64::from(c.src[j + 2]) + ab * c.s.strength;
        let idx = c.find(r, g, b);
        put(c, i, idx);

        head = if head == 0 { q_len - 1 } else { head - 1 };
        qr[head] = (r - f64::from(c.p.r[idx])) as f32;
        qg[head] = (g - f64::from(c.p.g[idx])) as f32;
        qb[head] = (b - f64::from(c.p.b[idx])) as f32;
    }
}

/* ------------------------- Dot diffusion -------------------------- */

/// Knuth's class matrix: rank cells by distance from dot centres.
fn class_matrix(size: usize) -> Vec<i32> {
    let n = size * size;
    let half = size as f64 / 2.0;
    let mut cells: Vec<(usize, f64)> = Vec::with_capacity(n);
    for y in 0..size {
        for x in 0..size {
            let xf = x as f64;
            let yf = y as f64;
            let dx = (((xf + 0.5) % half) - half / 2.0).abs();
            let dy = (((yf + 0.5) % half) - half / 2.0).abs();
            let quadrant =
                ((xf / half).floor() + (yf / half).floor() * 2.0) * 0.01;
            cells.push((y * size + x, dx * dx + dy * dy + quadrant));
        }
    }
    cells.sort_by(|a, b| {
        a.1.partial_cmp(&b.1)
            .unwrap()
            .then(a.0.cmp(&b.0))
    });
    let mut m = vec![0i32; n];
    for (rank, (idx, _)) in cells.iter().enumerate() {
        m[*idx] = rank as i32;
    }
    m
}

const NEIGHBOURS: [(i32, i32, f64); 8] = [
    (1, 0, 2.0),
    (-1, 0, 2.0),
    (0, 1, 2.0),
    (0, -1, 2.0),
    (1, 1, 1.0),
    (-1, 1, 1.0),
    (1, -1, 1.0),
    (-1, -1, 1.0),
];

#[inline]
fn s_dot_class(s: &Settings) -> usize {
    s.dot_class_size.max(2.0) as usize
}

fn dot_diffuse_pass(c: &mut Ctx) {
    let (w, h) = (c.w, c.h);
    // Math.max(2, 1 << Math.round(Math.log2(Math.max(2, s.dotClassSize))))
    let size = 1usize << round_log2(s_dot_class(c.s));
    let cm = class_matrix(size);
    let ranks = size * size;
    let mut err = vec![0.0f32; w * h * 3];

    // Pixels of each class, in the scan order the pass has always used (row by
    // row, left to right within a row). Walking the whole image once per rank
    // to find them was `ranks` full scans; bucketing it is one, and visits the
    // same pixels in the same order.
    let mut buckets: Vec<Vec<u32>> = vec![Vec::new(); ranks];
    for y in 0..h {
        for x in 0..w {
            buckets[cm[(y % size) * size + (x % size)] as usize].push((y * w + x) as u32);
        }
    }

    for rank in 0..ranks {
        for &pixel in &buckets[rank] {
            let i = pixel as usize;
            let (x, y) = (i % w, i / w);
            let j = i * 3;
            let r = f64::from(c.src[j]) + f64::from(err[j]);
            let g = f64::from(c.src[j + 1]) + f64::from(err[j + 1]);
            let b = f64::from(c.src[j + 2]) + f64::from(err[j + 2]);
            let idx = c.find(r, g, b);
            put(c, i, idx);

            let er = (r - f64::from(c.p.r[idx])) * c.s.strength;
            let eg = (g - f64::from(c.p.g[idx])) * c.s.strength;
            let eb = (b - f64::from(c.p.b[idx])) * c.s.strength;

            // Only neighbours that are still undecided may receive error.
            let mut div = 0.0;
            for &(dx, dy, weight) in &NEIGHBOURS {
                let nx = x as i32 + dx;
                let ny = y as i32 + dy;
                if nx < 0 || nx >= w as i32 || ny < 0 || ny >= h as i32 {
                    continue;
                }
                if cm[(ny as usize % size) * size + (nx as usize % size)] <= rank as i32 {
                    continue;
                }
                div += weight;
            }
            if div == 0.0 {
                continue;
            }
            for &(dx, dy, weight) in &NEIGHBOURS {
                let nx = x as i32 + dx;
                let ny = y as i32 + dy;
                if nx < 0 || nx >= w as i32 || ny < 0 || ny >= h as i32 {
                    continue;
                }
                if cm[(ny as usize % size) * size + (nx as usize % size)] <= rank as i32 {
                    continue;
                }
                let f = weight / div;
                let nj = ((ny as usize) * w + nx as usize) * 3;
                err[nj] = (f64::from(err[nj]) + er * f) as f32;
                err[nj + 1] = (f64::from(err[nj + 1]) + eg * f) as f32;
                err[nj + 2] = (f64::from(err[nj + 2]) + eb * f) as f32;
            }
        }
    }
}

/* ----------------------------- Omino ------------------------------ */

/// Omino-like diffusion — deliberately bad, marching-band aesthetic.
/// Always matches in RGB regardless of the selected mode (as in TS).
fn omino_pass(c: &mut Ctx) {
    let (w, h) = (c.w, c.h);
    let s = c.s;
    let dir = s.omino_direction.as_str();
    let vertical = dir == "down" || dir == "up";
    let backwards = dir == "left" || dir == "up";

    let lines = if vertical { w } else { h };
    let steps = if vertical { h } else { w };

    let across = s.omino_across;
    let aside = s.omino_aside;
    let gain = s.omino_error_strength;
    let phase = (s.omino_phase * core::f64::consts::PI) / 180.0;

    let mut aside_in = vec![0.0f32; steps * 3];
    let mut aside_out = vec![0.0f32; steps * 3];

    for l in 0..lines {
        // Standing per-step bias offsetting each line around the phase wheel;
        // the half-line offset keeps 0° neutral. Shared deterministic sin.
        let bias = if phase == 0.0 {
            0.0
        } else {
            sin_rad((l as f64 + 0.5) * phase) * 110.0
        };
        let mut cr = 0.0f64;
        let mut cg = 0.0f64;
        let mut cb = 0.0f64;
        aside_out.iter_mut().for_each(|v| *v = 0.0);

        for t in 0..steps {
            let pos = if backwards { steps - 1 - t } else { t };
            let x = if vertical { l } else { pos };
            let y = if vertical { pos } else { l };
            let i = y * w + x;
            let j = i * 3;
            let aj = t * 3;

            let r = f64::from(c.src[j]) + cr + f64::from(aside_in[aj]) + bias;
            let g = f64::from(c.src[j + 1]) + cg + f64::from(aside_in[aj + 1]) + bias;
            let b = f64::from(c.src[j + 2]) + cb + f64::from(aside_in[aj + 2]) + bias;

            let idx = match_rgb(c.p, r, g, b);
            put(c, i, idx);

            // Runaway error is the whole aesthetic, but it stays finite.
            let dr = ((r - f64::from(c.p.r[idx])) * gain).clamp(-1024.0, 1024.0);
            let dg = ((g - f64::from(c.p.g[idx])) * gain).clamp(-1024.0, 1024.0);
            let db = ((b - f64::from(c.p.b[idx])) * gain).clamp(-1024.0, 1024.0);

            cr = dr * across;
            cg = dg * across;
            cb = db * across;
            aside_out[aj] = (dr * aside) as f32;
            aside_out[aj + 1] = (dg * aside) as f32;
            aside_out[aj + 2] = (db * aside) as f32;
        }

        std::mem::swap(&mut aside_in, &mut aside_out);
    }
}

/* ------------------------------------------------------------------ */
/* Dot grid                                                            */
/* ------------------------------------------------------------------ */

/// Rounds a square dot's side to a whole number of pixels *with the parity of
/// the cell it sits in*. An even cell's centre lies on a pixel boundary and an
/// odd cell's on a pixel, so a dot of the wrong parity would sit half a pixel
/// off-centre and look lopsided.
fn snap_side(side: f64, cell: usize) -> f64 {
    let mut v = side.round();
    if (v as i64 - cell as i64).rem_euclid(2) != 0 {
        v += if side >= v { 1.0 } else { -1.0 };
    }
    v.max(if cell % 2 == 1 { 1.0 } else { 2.0 })
}

/// Pixel-grid halftone: the image is read in coarse cells and each cell is
/// redrawn as a single crisp dot whose size follows the tone underneath.
///
/// Unlike the screen-angle halftones this works on a plain axis-aligned grid
/// and decides each dot from the *mean* of its cell, so every dot is a clean
/// shape on whole pixels with paper showing between them - the chunky
/// bitmap-print look. Tone is mapped to area, not width, so a half-tone cell
/// gets half the ink.
///
/// Cells at the right and bottom edges are usually partial. They are measured
/// on the pixels that exist and their dot is centred on the cell as drawn, so
/// an edge never turns into a column of runts.
fn dot_grid_pass(c: &mut Ctx) {
    let (w, h) = (c.w, c.h);
    let cell = c.s.cell_size.round().clamp(2.0, 256.0) as usize;
    let scale = if c.s.dot_scale > 0.0 { c.s.dot_scale.clamp(0.2, 1.5) } else { 1.0 };
    let gamma = if c.s.dot_gamma > 0.0 { c.s.dot_gamma.clamp(0.2, 3.0) } else { 1.0 };
    let cutoff = c.s.dot_cutoff.clamp(0.0, 1.0);
    let levels = c.s.dot_levels.round().clamp(0.0, 32.0) as usize;
    let bias = (c.s.threshold - 128.0) / 255.0;
    let invert = c.s.dot_invert;
    let mono = c.s.dot_ink == "mono";
    let stagger = c.s.dot_stagger;
    let shape = match c.s.dot_shape.as_str() {
        "circle" => 1u8,
        "diamond" => 2u8,
        _ => 0u8,
    };

    // The palette's extremes are the paper and, in mono, the ink.
    let (mut dark, mut light) = (0usize, 0usize);
    for i in 1..c.p.n {
        if c.p.y[i] < c.p.y[dark] { dark = i; }
        if c.p.y[i] > c.p.y[light] { light = i; }
    }

    let half = cell / 2;
    let rows = h.div_ceil(cell) + 1;
    for cy in 0..rows {
        let y0 = (cy * cell) as isize;
        // Odd rows slide left by half a cell; one extra column covers the gap
        // that opens up on the right.
        let shift = if stagger && cy % 2 == 1 { half as isize } else { 0 };
        let cols = w.div_ceil(cell) + 1;
        for cx in 0..cols {
            let x0 = (cx * cell) as isize - shift;
            let (ax, bx) = (x0.max(0), (x0 + cell as isize).min(w as isize));
            let (ay, by) = (y0.max(0), (y0 + cell as isize).min(h as isize));
            if ax >= bx || ay >= by {
                continue;
            }
            let (cols_n, rows_n) = ((bx - ax) as usize, (by - ay) as usize);

            let (mut sr, mut sg, mut sb) = (0.0f64, 0.0f64, 0.0f64);
            for y in ay as usize..by as usize {
                for x in ax as usize..bx as usize {
                    let j = (y * w + x) * 3;
                    sr += f64::from(c.src[j]);
                    sg += f64::from(c.src[j + 1]);
                    sb += f64::from(c.src[j + 2]);
                }
            }
            let n = (cols_n * rows_n) as f64;
            let (ar, ag, ab) = (sr / n, sg / n, sb / n);

            // Tone is how much ink the cell asks for: dark by default, light
            // when the dots stand for highlights.
            let lum = (luma(ar, ag, ab) / 255.0 + bias).clamp(0.0, 1.0);
            let mut t = if invert { lum } else { 1.0 - lum };
            if (gamma - 1.0).abs() > 1e-6 { t = pow_shared(t, gamma); }
            if levels >= 2 {
                let top = (levels - 1) as f64;
                t = (t * top).round() / top;
            }
            // Paper is fixed: the light end of the palette, or the dark end when
            // the dots stand for highlights. The ink is the palette colour
            // nearest the cell that is not the paper, so a mid-grey cell on a
            // black-and-white palette gets a black dot, never an invisible
            // white one.
            let paper_idx = if invert { dark } else { light };
            let ink_idx = if mono || c.p.n < 2 {
                if invert { light } else { dark }
            } else {
                let (l, a, b) = rgb_to_oklab(ar, ag, ab);
                let mut best = if paper_idx == 0 { 1 } else { 0 };
                let mut best_d = f64::INFINITY;
                for i in 0..c.p.n {
                    if i == paper_idx {
                        continue;
                    }
                    let dl = l - f64::from(c.p.lab[i * 3]);
                    let da = a - f64::from(c.p.lab[i * 3 + 1]);
                    let db = b - f64::from(c.p.lab[i * 3 + 2]);
                    let d = dl * dl + da * da + db * db;
                    if d < best_d {
                        best_d = d;
                        best = i;
                    }
                }
                best
            };

            // Cell background first, then the dot over it.
            for y in ay as usize..by as usize {
                for x in ax as usize..bx as usize {
                    put(c, y * w + x, paper_idx);
                }
            }
            if t <= 0.0 || t < cutoff {
                continue;
            }

            // Dot geometry in cell coordinates, centred on the drawn cell.
            let cxm = (ax + bx) as f64 / 2.0;
            let cym = (ay + by) as f64 / 2.0;
            let span = cell as f64 * scale;
            let (side_x, side_y, radius, reach) = match shape {
                1 => (0.0, 0.0, span * (t / core::f64::consts::PI).sqrt(), 0.0),
                2 => (0.0, 0.0, 0.0, span * (t / 2.0).sqrt()),
                _ => {
                    let side = span * t.sqrt();
                    (snap_side(side, cols_n), snap_side(side, rows_n), 0.0, 0.0)
                }
            };
            let r2 = radius * radius;
            for y in ay as usize..by as usize {
                let dy = (y as f64 + 0.5) - cym;
                for x in ax as usize..bx as usize {
                    let dx = (x as f64 + 0.5) - cxm;
                    let inside = match shape {
                        1 => dx * dx + dy * dy <= r2,
                        2 => dx.abs() + dy.abs() <= reach,
                        _ => dx.abs() <= side_x / 2.0 && dy.abs() <= side_y / 2.0,
                    };
                    if inside {
                        put(c, y * w + x, ink_idx);
                    }
                }
            }
        }
    }
}

/* ------------------------------------------------------------------ */
/* Text mode                                                           */
/* ------------------------------------------------------------------ */

/// Paints the image out of glyphs, one per cell.
///
/// Each cell contributes two things: a coverage map, which decides *which*
/// glyph belongs there, and a mean colour, which decides what colour its ink
/// is. Keeping those separate is what lets the output stay a palette image -
/// the ink is matched through the same palette machinery every other algorithm
/// uses, so stacking, tonal bias and match mode all behave as expected.
///
/// Cells at the right and bottom edges are usually partial. They are matched
/// on the pixels that exist rather than padded, so a half cell picks a glyph
/// for the half it can see instead of one biased toward empty paper.
fn ascii_pass(c: &mut Ctx) {
    let atlas = c.glyphs;
    if atlas.is_empty() {
        // No atlas shipped: a flat threshold is a far better failure than a
        // blank frame, and the host raises the real error.
        threshold_pass(c, 0.0);
        return;
    }

    let cw = atlas.cell_w;
    let ch = atlas.cell_h;
    let gamma = c.s.ascii_gamma.clamp(0.2, 3.0);
    let contrast = c.s.ascii_contrast.clamp(0.0, 4.0);
    let invert = c.s.ascii_invert;
    let by_shape = c.s.ascii_match != "brightness";
    let mono = c.s.ascii_ink == "mono";

    // The palette's extremes are the paper and, in mono, the ink.
    let (mut dark, mut light) = (0usize, 0usize);
    for i in 1..c.p.n {
        if c.p.y[i] < c.p.y[dark] { dark = i; }
        if c.p.y[i] > c.p.y[light] { light = i; }
    }

    let mut cover = vec![0f32; cw * ch];

    let mut cy = 0usize;
    while cy < c.h {
        let mut cx = 0usize;
        while cx < c.w {
            let rows = ch.min(c.h - cy);
            let cols = cw.min(c.w - cx);

            let mut sum_r = 0.0f64;
            let mut sum_g = 0.0f64;
            let mut sum_b = 0.0f64;
            let mut n = 0.0f64;
            for v in cover.iter_mut() { *v = 0.0; }

            for y in 0..rows {
                for x in 0..cols {
                    let i = ((cy + y) * c.w + (cx + x)) * 3;
                    let r = f64::from(c.src[i]);
                    let g = f64::from(c.src[i + 1]);
                    let b = f64::from(c.src[i + 2]);
                    sum_r += r;
                    sum_g += g;
                    sum_b += b;
                    n += 1.0;
                    // Coverage is ink, so a dark pixel is a full one.
                    let mut t = 1.0 - (luma(r, g, b) / 255.0).clamp(0.0, 1.0);
                    if invert { t = 1.0 - t; }
                    if (gamma - 1.0).abs() > 1e-6 { t = pow_shared(t, gamma); }
                    cover[y * cw + x] = t as f32;
                }
            }
            if n == 0.0 { cx += cw; continue; }

            let mean_ink = {
                let mut acc = 0.0f64;
                for y in 0..rows { for x in 0..cols { acc += f64::from(cover[y * cw + x]); } }
                acc / n
            };

            let glyph = if by_shape {
                atlas.by_shape(&cover, contrast)
            } else {
                atlas.by_brightness(mean_ink)
            };

            let avg_r = sum_r / n;
            let avg_g = sum_g / n;
            let avg_b = sum_b / n;
            let ink_idx = if mono {
                if invert { dark } else { light }
            } else {
                c.find(avg_r, avg_g, avg_b)
            };
            // Paper is whichever extreme the ink is not, so text never
            // disappears into its own background.
            let paper_idx = if mono {
                if invert { light } else { dark }
            } else if f64::from(c.p.y[ink_idx]) > 127.5 { dark } else { light };

            let bits = atlas.glyph(glyph);
            for y in 0..rows {
                for x in 0..cols {
                    let i = (cy + y) * c.w + (cx + x);
                    let on = bits[y * cw + x] >= 128;
                    put(c, i, if on { ink_idx } else { paper_idx });
                }
            }

            cx += cw;
        }
        cy += ch;
    }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

fn dither_single(
    data: &[u8],
    width: usize,
    height: usize,
    s: &Settings,
    glyphs: &GlyphAtlas,
) -> Vec<u8> {
    let px = width * height;
    let mut out = vec![0u8; px * 4];
    let alpha: Vec<u8> = data.chunks_exact(4).map(|q| q[3]).collect();

    let src = prepare(data, width, height, s);
    let limit: usize = if s.algorithm == "omino" {
        (s.omino_color_count.floor().max(1.0)) as usize
    } else {
        usize::MAX
    };
    let bias = if s.match_mode == "tonal" { 0.0 } else { s.tonal_bias };
    let palette = compile_palette(&s.layers, limit, bias);

    let mut ctx = Ctx {
        src: &src,
        glyphs,
        out: &mut out,
        alpha: &alpha,
        w: width,
        h: height,
        p: &palette,
        match_fn: matcher_for(&s.match_mode),
        memo: if s.match_mode == "oklab" {
            vec![MemoSlot { key: [0; 3], idx: MEMO_EMPTY }; MEMO_SLOTS]
        } else {
            Vec::new()
        },
        s,
    };

    let cell = s.cell_size.max(1.0);
    let angle = s.screen_angle;

    match s.algorithm.as_str() {
        "bayer" => {
            let n = (s.bayer_size.max(2.0)) as usize;
            let m = bayer_matrix(n);
            ordered_pass(&mut ctx, |x, y| {
                f64::from(m[(y % n) * n + (x % n)])
            });
        }
        "halftone" => {
            let (sin_a, cos_a) = sincos_deg(angle);
            ordered_pass(&mut ctx, |x, y| {
                crate::masks::clustered_dot(x, y, cell, cos_a, sin_a)
            });
        }
        "cluster-diagonal" => {
            let (sin_a, cos_a) = sincos_deg(angle);
            ordered_pass(&mut ctx, |x, y| {
                crate::masks::diagonal_cluster(x, y, cell, cos_a, sin_a)
            });
        }
        "halftone-line" => {
            let (sin_a, cos_a) = sincos_deg(angle);
            ordered_pass(&mut ctx, |x, y| {
                crate::masks::line_screen(x, y, cell, cos_a, sin_a)
            });
        }
        "diagonal-line" => {
            let (sin_a, cos_a) = sincos_deg(angle);
            let (sin_b, cos_b) = sincos_deg(angle + 90.0);
            ordered_pass(&mut ctx, |x, y| {
                crate::masks::diagonal_hatch(x, y, cell, cos_a, sin_a, cos_b, sin_b)
            });
        }
        "checker" => {
            ordered_pass(&mut ctx, |x, y| checker_mask(x, y, cell));
        }
        "blue-noise" => {
            let m = blue_noise();
            let scale = s.noise_scale.max(0.1);
            ordered_pass(&mut ctx, |x, y| {
                let sx = ((x as f64 / scale).floor() as usize) & 63;
                let sy = ((y as f64 / scale).floor() as usize) & 63;
                f64::from(m[sy * 64 + sx])
            });
        }
        "ign" => {
            let scale = s.noise_scale.max(0.1);
            ordered_pass(&mut ctx, |x, y| ign(x as f64 / scale, y as f64 / scale));
        }
        "threshold" => threshold_pass(&mut ctx, 0.0),
        "random" => threshold_pass(&mut ctx, s.noise_amount),
        "riemersma" => riemersma_pass(&mut ctx),
        "dot-diffusion" => dot_diffuse_pass(&mut ctx),
        "ostromoukhov" => adaptive_diffuse_pass(&mut ctx),
        "omino" => omino_pass(&mut ctx),
        "jpeg-sort" => jpeg_sort_pass(&mut ctx),
        "ascii" => ascii_pass(&mut ctx),
        "dot-grid" => dot_grid_pass(&mut ctx),
        other => {
            match kernels::kernel_for(other) {
                Some((k, div)) => error_diffuse_pass(&mut ctx, k, div),
                None => {
                    let (k, div) = kernels::default_kernel();
                    error_diffuse_pass(&mut ctx, k, div);
                }
            }
        }
    }

    out
}

/// Run enabled passes from top to bottom. A later pass consumes the blended
/// pixels from the preceding pass; grading and filters apply only once.
pub fn dither(data: &[u8], width: usize, height: usize, s: &Settings) -> Vec<u8> {
    dither_with_glyphs(data, width, height, s, &GlyphAtlas::default())
}

/// As `dither`, with a glyph atlas available to the text algorithm.
///
/// Kept as a separate entry point so the parity harness and every existing
/// caller keep the signature they were written against; text mode is the only
/// pass that reads the atlas, and it degrades to a threshold without one.
pub fn dither_with_glyphs(
    data: &[u8],
    width: usize,
    height: usize,
    s: &Settings,
    glyphs: &GlyphAtlas,
) -> Vec<u8> {
    dither_stack(data, width, height, s, glyphs, 0, &mut LayerCache::disabled())
}

/// Finished output of every executed pass, so an edit to pass `k` only has to
/// redo passes `k..n`.
///
/// A stack is a chain: pass `k` consumes exactly what pass `k-1` produced, so
/// its result is a pure function of the source plus the settings of passes
/// `0..=k`. Each entry is keyed by a hash chained through every pass beneath
/// it; on the next render the longest run of matching keys is reused as-is and
/// only the rest is recomputed. Dragging a slider on the top of a ten-pass
/// stack costs one pass instead of ten.
///
/// Reuse is exact - a cached plane is the plane the pass would have produced -
/// so it can never change what is drawn, only how long drawing takes.
pub struct LayerCache {
    enabled: bool,
    entries: Vec<CacheEntry>,
    bytes: usize,
    budget: usize,
    /// Passes the last run served from the cache.
    pub reused: usize,
    /// Passes the last run actually computed.
    pub computed: usize,
}

struct CacheEntry {
    key: u64,
    pixels: Vec<u8>,
}

/// Resident memory the cache may hold. Past it later passes simply are not
/// kept, which costs speed on the next edit and nothing else.
const CACHE_BUDGET_BYTES: usize = 192 << 20;

impl LayerCache {
    pub fn new() -> Self {
        Self { enabled: true, entries: Vec::new(), bytes: 0, budget: CACHE_BUDGET_BYTES, reused: 0, computed: 0 }
    }

    /// A cache that stores nothing, for one-shot renders.
    pub fn disabled() -> Self {
        Self { enabled: false, ..Self::new() }
    }

    pub fn with_budget(bytes: usize) -> Self {
        Self { budget: bytes, ..Self::new() }
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.bytes = 0;
    }

    fn truncate(&mut self, keep: usize) {
        while self.entries.len() > keep {
            if let Some(e) = self.entries.pop() {
                self.bytes -= e.pixels.len();
            }
        }
    }
}

impl Default for LayerCache {
    fn default() -> Self {
        Self::new()
    }
}

#[inline]
fn mix(h: u64, v: u64) -> u64 {
    // FNV-1a step over a whole word, then a xor-shift so nearby inputs spread.
    let mut x = (h ^ v).wrapping_mul(0x0000_0100_0000_01B3);
    x ^= x >> 29;
    x.wrapping_mul(0xBF58_476D_1CE4_E5B9)
}

fn hash_bytes(mut h: u64, bytes: &[u8]) -> u64 {
    for chunk in bytes.chunks(8) {
        let mut word = [0u8; 8];
        word[..chunk.len()].copy_from_slice(chunk);
        h = mix(h, u64::from_le_bytes(word));
    }
    mix(h, bytes.len() as u64)
}

/// Same as `dither_with_glyphs`, reusing whatever prefix of `cache` still holds.
///
/// `base_key` names the input plane (source identity, stage, region); callers
/// must change it whenever `data` changes. `glyph_key` does the same for the
/// atlas, which only the text pass reads.
pub fn dither_stack(
    data: &[u8],
    width: usize,
    height: usize,
    s: &Settings,
    glyphs: &GlyphAtlas,
    base_key: u64,
    cache: &mut LayerCache,
) -> Vec<u8> {
    cache.reused = 0;
    cache.computed = 0;
    if s.algorithm_layers.is_empty() {
        cache.clear();
        cache.computed = 1;
        return dither_single(data, width, height, s, glyphs);
    }

    let defaults = Settings::with_defaults();
    // One entry per executed pass: its effective settings and opacity.
    struct Pass {
        settings: Settings,
        opacity: f64,
    }
    let mut passes: Vec<Pass> = Vec::new();
    for layer in &s.algorithm_layers {
        if !layer.enabled {
            continue;
        }
        let opacity = layer.opacity.clamp(0.0, 1.0);
        if opacity == 0.0 {
            continue;
        }
        let mut pass_settings = s.clone();
        layer.params.apply(&mut pass_settings);
        if !passes.is_empty() {
            pass_settings.invert = defaults.invert;
            pass_settings.grayscale = defaults.grayscale;
            pass_settings.brightness = defaults.brightness;
            pass_settings.contrast = defaults.contrast;
            pass_settings.gamma = defaults.gamma;
            pass_settings.exposure = defaults.exposure;
            pass_settings.saturation = defaults.saturation;
            pass_settings.hue_shift = defaults.hue_shift;
            pass_settings.temperature = defaults.temperature;
            pass_settings.tint = defaults.tint;
            pass_settings.blur = defaults.blur;
            pass_settings.sharpen = defaults.sharpen;
        }
        pass_settings.algorithm = layer.algorithm.clone();
        passes.push(Pass { settings: pass_settings, opacity });
    }

    if passes.is_empty() {
        cache.clear();
        return data.to_vec();
    }

    // Chain the keys. The pass list is stripped from each fingerprint - it
    // describes the whole stack, and including it would invalidate every pass
    // whenever any one of them changed.
    let mut keys = Vec::with_capacity(passes.len());
    let mut key = mix(mix(base_key, width as u64), height as u64);
    for (n, pass) in passes.iter().enumerate() {
        let mut fingerprint = pass.settings.clone();
        fingerprint.algorithm_layers.clear();
        // The first pass is the only one that grades; later passes were reset
        // above, so position is already part of the settings. It is mixed in
        // anyway so the meaning of "first" can never alias.
        key = hash_bytes(key, format!("{n}|{:?}|{}", fingerprint, pass.opacity).as_bytes());
        if pass.settings.algorithm == "ascii" {
            key = mix(key, glyphs.fingerprint());
        }
        keys.push(key);
    }

    let mut reuse = 0usize;
    if cache.enabled {
        while reuse < passes.len()
            && reuse < cache.entries.len()
            && cache.entries[reuse].key == keys[reuse]
        {
            reuse += 1;
        }
        cache.truncate(reuse);
    }
    cache.reused = reuse;
    cache.computed = passes.len() - reuse;

    let mut current: Vec<u8> = if reuse > 0 {
        cache.entries[reuse - 1].pixels.clone()
    } else {
        data.to_vec()
    };
    let mut storing = cache.enabled;

    for (n, pass) in passes.iter().enumerate().skip(reuse) {
        let rendered = dither_single(&current, width, height, &pass.settings, glyphs);
        if pass.opacity == 1.0 {
            current = rendered;
        } else {
            for (dst, target) in current.chunks_exact_mut(4).zip(rendered.chunks_exact(4)) {
                for channel in 0..3 {
                    dst[channel] = to_u8clamp(
                        f64::from(dst[channel]) * (1.0 - pass.opacity)
                            + f64::from(target[channel]) * pass.opacity,
                    );
                }
            }
        }
        if storing {
            if cache.bytes + current.len() > cache.budget {
                storing = false;
            } else {
                cache.bytes += current.len();
                cache.entries.push(CacheEntry { key: keys[n], pixels: current.clone() });
            }
        }
    }
    current
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The curve the pass originally walked: every cell of the enclosing
    /// square in index order, keeping those inside the image.
    fn reference_order(w: usize, h: usize) -> Vec<u32> {
        let side: usize = 1 << ceil_log2(w.max(h).max(2));
        let mut out = Vec::new();
        for d in 0..side * side {
            let (x, y) = hilbert_xy(side, d);
            if x < w && y < h {
                out.push((y * w + x) as u32);
            }
        }
        out
    }

    #[test]
    fn rect_limited_hilbert_walk_matches_the_full_curve() {
        let mut cases = vec![(1, 1), (2, 2), (3, 1), (1, 7), (5, 5), (16, 16), (17, 3), (64, 33)];
        for w in [7usize, 31, 48, 100, 129] {
            for h in [4usize, 9, 50, 96, 130] {
                cases.push((w, h));
            }
        }
        for (w, h) in cases {
            assert_eq!(hilbert_order(w, h), reference_order(w, h), "{w}x{h}");
        }
    }
}
