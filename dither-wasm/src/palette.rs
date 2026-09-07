//! Palette compilation — mirror of `compilePalette` in algorithms.ts.
//!
//! Storage widths matter for parity: every array here is f32 (the TS engine
//! keeps them in Float32Arrays), while arithmetic happens in f64.

use crate::color::{hex_to_rgb, luma, rgb_to_oklab};

pub struct Palette {
    pub n: usize,
    pub r: Vec<f32>,
    pub g: Vec<f32>,
    pub b: Vec<f32>,
    /// OKLab triples, 3 per entry.
    pub lab: Vec<f32>,
    /// Perceived luminance, 0..255.
    pub y: Vec<f32>,
    pub width: Vec<f32>,
    /// Distance multiplier; fat layers win more pixels.
    pub pull: Vec<f32>,
    /// Tonal band each layer owns, in 0..1, in `order` sequence.
    pub band_edge: Vec<f32>,
    /// Centre of that band, per layer index, in 0..1.
    pub tone: Vec<f32>,
    /// How strongly stack position pulls a layer toward its brightness band.
    pub bias: f64,
    /// Layer indices sorted by tonal level.
    pub order: Vec<usize>,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaletteLayer {
    #[allow(dead_code)]
    pub id: String,
    pub hex: String,
    pub level: f64,
    pub width: f64,
    pub enabled: bool,
}

const FALLBACK: [&str; 2] = ["#000000", "#ffffff"];

fn to_layers(hexes: &[&str]) -> Vec<PaletteLayer> {
    hexes
        .iter()
        .enumerate()
        .map(|(i, h)| PaletteLayer {
            id: format!("k{i}"),
            hex: h.to_string(),
            level: if i == 0 { 0.0 } else { 1.0 },
            width: 2.0,
            enabled: true,
        })
        .collect()
}

pub fn compile_palette(layers: &[PaletteLayer], limit: usize, bias: f64) -> Palette {
    // Materialise the fallback so every layer lives in one owned Vec and the
    // borrow stays trivially valid (mirrors the TS filter + FALLBACK swap).
    let owned: Vec<PaletteLayer> = if layers.iter().any(|l| l.enabled) {
        layers.to_vec()
    } else {
        to_layers(&FALLBACK)
    };
    let mut live: Vec<&PaletteLayer> = owned.iter().filter(|l| l.enabled).collect();
    let max = limit.max(1);
    if live.len() > max {
        live.truncate(max);
    }

    let n = live.len();
    let mut p = Palette {
        n,
        r: vec![0.0; n],
        g: vec![0.0; n],
        b: vec![0.0; n],
        lab: vec![0.0; n * 3],
        y: vec![0.0; n],
        width: vec![0.0; n],
        pull: vec![0.0; n],
        band_edge: vec![0.0; n],
        tone: vec![0.0; n],
        order: (0..n).collect(),
        bias,
    };

    for i in 0..n {
        let (r, g, b) = hex_to_rgb(&live[i].hex);
        p.r[i] = r as f32;
        p.g[i] = g as f32;
        p.b[i] = b as f32;
        let (l, a, bb) = rgb_to_oklab(r, g, b);
        p.lab[i * 3] = l as f32;
        p.lab[i * 3 + 1] = a as f32;
        p.lab[i * 3 + 2] = bb as f32;
        p.y[i] = luma(r, g, b) as f32;
        let w = live[i].width.max(0.05);
        p.width[i] = w as f32;
        // width 2 is neutral; wider pulls scores down, narrower pushes them up.
        p.pull[i] = (2.0 / (1.0 + w)) as f32;
    }

    // Tonal bands: sort by level, then hand each layer a slice of 0..1 sized
    // by its width. Stable sort with the same tie-break as the TS comparator
    // (`level` then current-index luminance — indices start unique).
    let mut idx: Vec<usize> = (0..n).collect();
    idx.sort_by(|&a, &b| {
        live[a]
            .level
            .partial_cmp(&live[b].level)
            .unwrap()
            .then(p.y[a].partial_cmp(&p.y[b]).unwrap())
    });
    let total: f64 = idx.iter().map(|&i| p.width[i] as f64).sum();
    let mut acc = 0.0f64;
    for (k, &i) in idx.iter().enumerate() {
        p.order[k] = i;
        let lo = acc;
        acc += p.width[i] as f64 / total;
        p.band_edge[k] = acc as f32;
        p.tone[i] = ((lo + acc) / 2.0) as f32;
    }
    p.band_edge[n - 1] = 1.0;
    p
}
