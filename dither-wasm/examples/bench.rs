//! Timing harness: `cargo run --release --example bench [width height]`.
//!
//! Not part of the shipped engine - it exists so a performance change is
//! judged against numbers rather than against how it feels.

use dither_wasm::ascii::GlyphAtlas;
use dither_wasm::engine::dither_with_glyphs;
use dither_wasm::settings::{AlgorithmLayer, AlgorithmParams, Settings};
use std::time::Instant;

fn photo(w: usize, h: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(w * h * 4);
    let mut s: u32 = 0x1234_5678;
    for y in 0..h {
        for x in 0..w {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            let n = (s & 31) as f64;
            let fx = x as f64 / w as f64;
            let fy = y as f64 / h as f64;
            let r = 255.0 * (0.5 + 0.5 * (fx * 9.0).sin()) + n;
            let g = 255.0 * fy + n;
            let b = 255.0 * (0.5 + 0.5 * ((fx + fy) * 7.0).cos()) + n;
            out.extend_from_slice(&[r.min(255.0) as u8, g.min(255.0) as u8, b.min(255.0) as u8, 255]);
        }
    }
    out
}

fn atlas() -> GlyphAtlas {
    // 95 pseudo-glyphs of 8x14: enough to exercise the matcher honestly.
    let (cw, ch, count) = (8usize, 14usize, 95usize);
    let mut bits = vec![0u8; cw * ch * count];
    let mut s: u32 = 0x9e37_79b9;
    for g in 0..count {
        let density = (g as u32 * 255 / count as u32) as u32;
        for i in 0..cw * ch {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            bits[g * cw * ch + i] = if (s & 255) < density { 255 } else { 0 };
        }
    }
    GlyphAtlas::adopt(&bits, count, cw, ch)
}

fn layer(id: usize, algorithm: &str) -> AlgorithmLayer {
    AlgorithmLayer {
        id: format!("l{id}"),
        algorithm: algorithm.into(),
        opacity: 1.0,
        enabled: true,
        params: AlgorithmParams::default(),
    }
}

fn time(label: &str, f: impl FnOnce() -> usize) {
    let t = Instant::now();
    let n = f();
    println!("{label:<34} {:>8.1} ms  ({n} bytes)", t.elapsed().as_secs_f64() * 1000.0);
}

fn main() {
    let args: Vec<usize> = std::env::args().skip(1).filter_map(|a| a.parse().ok()).collect();
    let (w, h) = if args.len() == 2 { (args[0], args[1]) } else { (1280, 720) };
    let data = photo(w, h);
    let glyphs = atlas();
    println!("{w}x{h}  ({:.2} MP)", (w * h) as f64 / 1e6);

    for algo in [
        "floyd-steinberg", "stucki", "bayer", "halftone", "threshold", "random", "ign",
        "riemersma", "dot-diffusion", "ostromoukhov", "omino", "jpeg-sort", "ascii",
    ] {
        let mut s = Settings::with_defaults();
        s.algorithm = algo.into();
        time(algo, || dither_with_glyphs(&data, w, h, &s, &glyphs).len());
    }

    for mode in ["rgb", "luma", "oklab", "tonal"] {
        let mut s = Settings::with_defaults();
        s.match_mode = mode.into();
        time(&format!("floyd-steinberg/{mode}"), || dither_with_glyphs(&data, w, h, &s, &glyphs).len());
    }

    let mut s = Settings::with_defaults();
    let kinds = ["floyd-steinberg", "ascii", "omino", "bayer", "riemersma", "dot-diffusion",
        "ostromoukhov", "jpeg-sort", "halftone", "atkinson"];
    s.algorithm_layers = kinds.iter().enumerate().map(|(i, k)| layer(i, k)).collect();
    time("stack of 10 (mixed)", || dither_with_glyphs(&data, w, h, &s, &glyphs).len());
}
