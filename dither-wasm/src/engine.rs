//! The dither engine — mirror of the pass functions and `dither()` dispatcher
//! in `src/dither/algorithms.ts`.
//!
//! Storage widths are part of the parity contract: f32 planes with f64 local
//! arithmetic everywhere the TS engine uses Float32Arrays.

use crate::color::{luma, rgb_to_oklab};
use crate::kernels;
use crate::masks::{bayer_matrix, blue_noise, checker_mask, ign};
use crate::palette::{compile_palette, Palette};
use crate::prepare::{prepare, to_u8clamp};
use crate::settings::Settings;
use crate::shared::{pow_shared, sincos_deg, sin_rad};

type Matcher = fn(&Palette, f64, f64, f64) -> usize;

struct Ctx<'a> {
    src: &'a [f32],
    out: &'a mut [u8],
    alpha: &'a [u8],
    w: usize,
    h: usize,
    p: &'a Palette,
    match_fn: Matcher,
    s: &'a Settings,
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
            put(c, i, (c.match_fn)(c.p, r, g, b));
        }
    }
}

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
        put(c, i, (c.match_fn)(c.p, r, g, b));
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
            let idx = (c.match_fn)(c.p, r, g, b);
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
            let idx = (c.match_fn)(c.p, r, g, b);
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

fn riemersma_pass(c: &mut Ctx) {
    let (w, h) = (c.w, c.h);
    let side: usize = 1 << ceil_log2(w.max(h).max(2));
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

    let mut qr = vec![0.0f32; q_len];
    let mut qg = vec![0.0f32; q_len];
    let mut qb = vec![0.0f32; q_len];
    let mut head: usize = 0;

    let total = side * side;
    for d in 0..total {
        let (x, y) = hilbert_xy(side, d);
        if x >= w || y >= h {
            continue;
        }
        let i = y * w + x;
        let j = i * 3;

        let mut ar = 0.0;
        let mut ag = 0.0;
        let mut ab = 0.0;
        for k in 0..q_len {
            let slot = (head + k) % q_len;
            ar += f64::from(qr[slot]) * f64::from(weights[k]);
            ag += f64::from(qg[slot]) * f64::from(weights[k]);
            ab += f64::from(qb[slot]) * f64::from(weights[k]);
        }

        let r = f64::from(c.src[j]) + ar * c.s.strength;
        let g = f64::from(c.src[j + 1]) + ag * c.s.strength;
        let b = f64::from(c.src[j + 2]) + ab * c.s.strength;
        let idx = (c.match_fn)(c.p, r, g, b);
        put(c, i, idx);

        head = (head + q_len - 1) % q_len;
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

    for rank in 0..ranks {
        for y in 0..h {
            for x in 0..w {
                if cm[(y % size) * size + (x % size)] != rank as i32 {
                    continue;
                }
                let i = y * w + x;
                let j = i * 3;
                let r = f64::from(c.src[j]) + f64::from(err[j]);
                let g = f64::from(c.src[j + 1]) + f64::from(err[j + 1]);
                let b = f64::from(c.src[j + 2]) + f64::from(err[j + 2]);
                let idx = (c.match_fn)(c.p, r, g, b);
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
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

pub fn dither(data: &[u8], width: usize, height: usize, s: &Settings) -> Vec<u8> {
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
        out: &mut out,
        alpha: &alpha,
        w: width,
        h: height,
        p: &palette,
        match_fn: matcher_for(&s.match_mode),
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
