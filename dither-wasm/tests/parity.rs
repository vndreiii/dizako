//! Cross-engine parity: run the Rust engine over the exact sweep the vitest
//! golden harness captured from the TS engine, and require byte equality
//! (Gate 2 of WASM_PLAN §8).

mod sha256;

use dither_wasm::engine::dither;
use dither_wasm::palette::PaletteLayer;
use dither_wasm::settings::Settings;
use serde_json::Value;
use std::fs;

fn repo_path(rel: &str) -> std::path::PathBuf {
    // tests/ → crate root → repo root
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join(rel)
}

fn load_suite() -> (Value, Vec<Value>) {
    let text = fs::read_to_string(repo_path("testdata/suites/main.json")).expect("suite");
    let v: Value = serde_json::from_str(&text).expect("suite json");
    let cases = v["cases"].as_array().cloned().unwrap();
    (v["palettes"].clone(), cases)
}

fn layers_of(palettes: &Value, id: &str) -> Vec<PaletteLayer> {
    palettes[id]["layers"]
        .as_array()
        .expect("layers")
        .iter()
        .map(|l| PaletteLayer {
            id: l["id"].as_str().unwrap_or("").to_string(),
            hex: l["hex"].as_str().unwrap_or("#000000").to_string(),
            level: l["level"].as_f64().unwrap_or(0.0),
            width: l["width"].as_f64().unwrap_or(2.0),
            enabled: l["enabled"].as_bool().unwrap_or(true),
        })
        .collect()
}

/// Mirrors `settingsFor` in test/golden.test.ts: defaults overlaid with the
/// case's present fields.
fn settings_for(palettes: &Value, case: &Value) -> Settings {
    let mut s = Settings::with_defaults();
    s.layers = layers_of(palettes, case["palette"].as_str().expect("palette"));
    if let Some(v) = case["algorithm"].as_str() {
        s.algorithm = v.to_string();
    }
    if let Some(v) = case["matchMode"].as_str() {
        s.match_mode = v.to_string();
    }
    // Sweep cases use camelCase keys; map each Rust field explicitly.
    macro_rules! num {
        ($($key:ident => $json:literal),* $(,)?) => {$(
            if let Some(v) = case[$json].as_f64() { s.$key = v; }
        )*};
    }
    num!(
        tonal_bias => "tonalBias",
        strength => "strength",
        jitter => "jitter",
        error_clamp => "errorClamp",
        bayer_size => "bayerSize",
        cell_size => "cellSize",
        screen_angle => "screenAngle",
        noise_scale => "noiseScale",
        threshold => "threshold",
        noise_amount => "noiseAmount",
        riemersma_queue => "riemersmaQueue",
        riemersma_decay => "riemersmaDecay",
        dot_class_size => "dotClassSize",
        omino_error_strength => "ominoErrorStrength",
        omino_across => "ominoAcross",
        omino_aside => "ominoAside",
        omino_phase => "ominoPhase",
        omino_color_count => "ominoColorCount",
        brightness => "brightness",
        contrast => "contrast",
        gamma => "gamma",
        exposure => "exposure",
        saturation => "saturation",
        hue_shift => "hueShift",
        temperature => "temperature",
        tint => "tint",
        blur => "blur",
        sharpen => "sharpen",
    );
    if let Some(v) = case["serpentine"].as_bool() { s.serpentine = v; }
    if let Some(v) = case["grayscale"].as_bool() { s.grayscale = v; }
    if let Some(v) = case["invert"].as_bool() { s.invert = v; }
    if let Some(v) = case["ominoDirection"].as_str() {
        s.omino_direction = v.to_string();
    }
    s
}

fn fixture(name: &str) -> (Vec<u8>, usize, usize) {
    let meta: Value = serde_json::from_str(
        &fs::read_to_string(repo_path(&format!("testdata/images/{name}.json"))).expect("meta"),
    )
    .unwrap();
    let bytes = fs::read(repo_path(&format!("testdata/images/{name}.rgba"))).expect("rgba");
    (
        bytes,
        meta["width"].as_u64().unwrap() as usize,
        meta["height"].as_u64().unwrap() as usize,
    )
}

#[test]
fn rust_engine_matches_ts_goldens() {
    let manifest: Value = serde_json::from_str(
        &fs::read_to_string(repo_path("testdata/golden/ts.json")).expect("golden manifest"),
    )
    .unwrap();
    let hashes = &manifest["hashes"];

    let (palettes, cases) = load_suite();

    let mut checked = 0usize;
    let mut failures: Vec<String> = Vec::new();
    for case in &cases {
        let id = case["id"].as_str().expect("id");
        let expected = hashes[id].as_str().expect("hash");
        let (bytes, w, h) = fixture(case["fixture"].as_str().expect("fixture"));
        let settings = settings_for(&palettes, case);
        let out = dither(&bytes, w, h, &settings);
        let got = sha256::sha256_hex(&out);
        checked += 1;
        if got != expected {
            failures.push(format!(
                "{id} ({}, {}): got {got} want {expected}",
                case["algorithm"].as_str().unwrap_or("?"),
                case["fixture"].as_str().unwrap_or("?"),
            ));
        }
    }
    assert_eq!(checked, hashes.as_object().map(|o| o.len()).unwrap_or(0));
    assert!(
        failures.is_empty(),
        "parity drift in {} case(s):\n{}",
        failures.len(),
        failures.join("\n")
    );
}
