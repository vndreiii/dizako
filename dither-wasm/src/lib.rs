use wasm_bindgen::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct PaletteLayer {
    pub hex: String,
    pub level: f32,
    pub width: f32,
    pub enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub algorithm: String,
    pub strength: f32,
    pub threshold: f32,
    pub error_clamp: f32,
    pub serpentine: bool,
    pub layers: Vec<PaletteLayer>,
}

struct Rgb(f32, f32, f32);

fn hex_to_rgb(hex: &str) -> Rgb {
    let hex = hex.trim_start_matches('#');
    let full = if hex.len() == 3 {
        format!("{}{}{}{}{}{}", &hex[0..1], &hex[0..1], &hex[1..2], &hex[1..2], &hex[2..3], &hex[2..3])
    } else {
        hex.to_string()
    };
    let r = u8::from_str_radix(&full[0..2], 16).unwrap_or(0) as f32;
    let g = u8::from_str_radix(&full[2..4], 16).unwrap_or(0) as f32;
    let b = u8::from_str_radix(&full[4..6], 16).unwrap_or(0) as f32;
    Rgb(r, g, b)
}

struct Palette {
    r: Vec<f32>,
    g: Vec<f32>,
    b: Vec<f32>,
    pull: Vec<f32>,
    n: usize,
}

fn compile_palette(layers: &[PaletteLayer]) -> Palette {
    let mut r = Vec::new();
    let mut g = Vec::new();
    let mut b = Vec::new();
    let mut pull = Vec::new();
    
    let live: Vec<&PaletteLayer> = layers.iter().filter(|l| l.enabled).collect();
    
    for layer in &live {
        let Rgb(cr, cg, cb) = hex_to_rgb(&layer.hex);
        r.push(cr);
        g.push(cg);
        b.push(cb);
        let w = layer.width.max(0.05);
        pull.push(2.0 / (1.0 + w));
    }
    
    if r.is_empty() {
        r.push(0.0); g.push(0.0); b.push(0.0); pull.push(1.0);
        r.push(255.0); g.push(255.0); b.push(255.0); pull.push(1.0);
    }
    
    Palette { n: r.len(), r, g, b, pull }
}

fn match_rgb(p: &Palette, r: f32, g: f32, b: f32) -> usize {
    let mut best = 0;
    let mut best_d = f32::INFINITY;
    for i in 0..p.n {
        let dr = r - p.r[i];
        let dg = g - p.g[i];
        let db = b - p.b[i];
        let d = (0.299 * dr * dr + 0.587 * dg * dg + 0.114 * db * db) * p.pull[i];
        if d < best_d {
            best_d = d;
            best = i;
        }
    }
    best
}

#[wasm_bindgen]
pub fn process_dither(mut data: Vec<u8>, width: u32, height: u32, settings_val: JsValue) -> Vec<u8> {
    let settings: Settings = serde_wasm_bindgen::from_value(settings_val).unwrap_or_else(|_| {
        Settings {
            algorithm: "nearest".to_string(),
            strength: 1.0,
            threshold: 128.0,
            error_clamp: 0.0,
            serpentine: false,
            layers: vec![],
        }
    });
    
    let palette = compile_palette(&settings.layers);
    
    if settings.algorithm == "floyd-steinberg" {
        let mut err = vec![0.0f32; (width * height * 3) as usize];
        let strength = settings.strength;
        
        for y in 0..height {
            let reverse = settings.serpentine && y % 2 == 1;
            for step in 0..width {
                let x = if reverse { width - 1 - step } else { step };
                let i = (y * width + x) as usize;
                let j = i * 3;
                let src_idx = i * 4;
                
                let r = data[src_idx] as f32 + err[j];
                let g = data[src_idx + 1] as f32 + err[j + 1];
                let b = data[src_idx + 2] as f32 + err[j + 2];
                
                let best = match_rgb(&palette, r, g, b);
                
                data[src_idx] = palette.r[best] as u8;
                data[src_idx + 1] = palette.g[best] as u8;
                data[src_idx + 2] = palette.b[best] as u8;
                
                let er = (r - palette.r[best]) * strength;
                let eg = (g - palette.g[best]) * strength;
                let eb = (b - palette.b[best]) * strength;
                
                let taps = [
                    (1, 0, 7.0 / 16.0),
                    (-1, 1, 3.0 / 16.0),
                    (0, 1, 5.0 / 16.0),
                    (1, 1, 1.0 / 16.0),
                ];
                
                for (dx, dy, weight) in taps {
                    let nx = x as i32 + if reverse { -dx } else { dx };
                    let ny = y as i32 + dy;
                    if nx >= 0 && nx < width as i32 && ny < height as i32 {
                        let nj = ((ny * width as i32 + nx) * 3) as usize;
                        err[nj] += er * weight;
                        err[nj + 1] += eg * weight;
                        err[nj + 2] += eb * weight;
                    }
                }
            }
        }
    } else {
        for i in 0..(width * height) as usize {
            let src_idx = i * 4;
            let r = data[src_idx] as f32;
            let g = data[src_idx + 1] as f32;
            let b = data[src_idx + 2] as f32;
            let best = match_rgb(&palette, r, g, b);
            data[src_idx] = palette.r[best] as u8;
            data[src_idx + 1] = palette.g[best] as u8;
            data[src_idx + 2] = palette.b[best] as u8;
        }
    }
    
    data
}
