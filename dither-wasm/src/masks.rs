//! Threshold masks for the ordered family — mirror of `src/dither/masks.ts`.
//!
//! The blue-noise tile is the frozen constant from tables.rs; trig for the
//! halftone family is hoisted by callers through shared sincos.

use crate::tables::BLUE_NOISE_TILE;

/// Canonical recursive Bayer matrix, normalised to 0..1 (f32 stores, as TS).
pub fn bayer_matrix(n: usize) -> Vec<f32> {
    let mut size = 1usize;
    let mut m = vec![0.0f32];
    while size < n {
        let next = size * 2;
        let mut out = vec![0.0f32; next * next];
        for y in 0..size {
            for x in 0..size {
                let v = f64::from(m[y * size + x]) * 4.0;
                out[y * next + x] = v as f32;
                out[y * next + x + size] = (v + 2.0) as f32;
                out[(y + size) * next + x] = (v + 3.0) as f32;
                out[(y + size) * next + x + size] = (v + 1.0) as f32;
            }
        }
        m = out;
        size = next;
    }
    let total = (size * size) as f64;
    m.iter().map(|&v| ((f64::from(v)) / total) as f32).collect()
}

/// The frozen void-and-cluster tile as mask values.
pub fn blue_noise() -> Vec<f32> {
    // Math.fround((rank + 0.5) / n): the division in f64 then one rounding
    // reproduces the historical Float32Array store exactly.
    BLUE_NOISE_TILE
        .iter()
        .map(|&rank| ((f64::from(rank) + 0.5) / 4096.0) as f32)
        .collect()
}

/// Interleaved gradient noise - Jorge Jimenez's cheap, very even hash.
/// `%` on f64 is truncated remainder in both JS and Rust.
#[inline]
pub fn ign(x: f64, y: f64) -> f64 {
    (52.9829189 * ((0.06711056 * x + 0.00583715 * y) % 1.0)) % 1.0
}

/// Clustered dot: a spot function growing from the centre of each cell.
pub fn clustered_dot(x: usize, y: usize, cell: f64, cos_a: f64, sin_a: f64) -> f64 {
    let xf = x as f64;
    let yf = y as f64;
    let rx = xf * cos_a - yf * sin_a;
    let ry = xf * sin_a + yf * cos_a;
    let u = (rx % cell + cell) % cell;
    let v = (ry % cell + cell) % cell;
    let dx = (u / cell) * 2.0 - 1.0;
    let dy = (v / cell) * 2.0 - 1.0;
    // Euclidean spot: round dots that merge into a checker at 50%.
    0.999f64.min((dx * dx + dy * dy).sqrt() / core::f64::consts::SQRT_2)
}

/// Diagonal cluster: a rotated-square spot, closer to a classic 45° screen.
pub fn diagonal_cluster(x: usize, y: usize, cell: f64, cos_a: f64, sin_a: f64) -> f64 {
    let xf = x as f64;
    let yf = y as f64;
    let rx = xf * cos_a - yf * sin_a;
    let ry = xf * sin_a + yf * cos_a;
    let u = (rx % cell + cell) % cell;
    let v = (ry % cell + cell) % cell;
    let dx = (u / cell) * 2.0 - 1.0;
    let dy = (v / cell) * 2.0 - 1.0;
    0.999f64.min((dx.abs() + dy.abs()) / 2.0)
}

/// Line screen: rules perpendicular to the screen angle.
pub fn line_screen(x: usize, y: usize, cell: f64, cos_a: f64, sin_a: f64) -> f64 {
    let xf = x as f64;
    let yf = y as f64;
    let ry = xf * sin_a + yf * cos_a;
    let v = (ry % cell + cell) % cell;
    ((v / cell - 0.5).abs()) * 2.0
}

/// Crosshatch of two line screens 90° apart.
pub fn diagonal_hatch(
    x: usize,
    y: usize,
    cell: f64,
    cos_a: f64,
    sin_a: f64,
    cos_b: f64,
    sin_b: f64,
) -> f64 {
    let a = line_screen(x, y, cell, cos_a, sin_a);
    let b = line_screen(x, y, cell, cos_b, sin_b);
    0.999f64.min(a.min(b))
}

/// Two-phase checker at the given cell size.
pub fn checker_mask(x: usize, y: usize, cell: f64) -> f64 {
    // Math.max(1, Math.round(cell))
    let c = ((cell + 0.5).floor().max(1.0)) as usize;
    let cx = x / c;
    let cy = y / c;
    if (cx + cy) % 2 == 0 { 0.25 } else { 0.75 }
}
