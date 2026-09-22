use dither_wasm::engine::dither;
use dither_wasm::settings::{AlgorithmLayer, AlgorithmParams, Settings};

fn image() -> Vec<u8> {
    (0..64).flat_map(|i| {
        let value = (i * 4) as u8;
        [value, value, value, 255]
    }).collect()
}

fn layer(id: &str, algorithm: &str, opacity: f64) -> AlgorithmLayer {
    AlgorithmLayer { id: id.into(), algorithm: algorithm.into(), opacity, enabled: true, params: AlgorithmParams::default() }
}

#[test]
fn single_pass_matches_legacy_and_disabled_pass_is_skipped() {
    let pixels = image();
    let mut settings = Settings::with_defaults();
    let legacy = dither(&pixels, 8, 8, &settings);
    settings.algorithm_layers = vec![layer("a", "floyd-steinberg", 1.0)];
    assert_eq!(dither(&pixels, 8, 8, &settings), legacy);
    settings.algorithm_layers.push(layer("b", "bayer", 1.0));
    settings.algorithm_layers[1].enabled = false;
    assert_eq!(dither(&pixels, 8, 8, &settings), legacy);
}

#[test]
fn pass_order_and_opacity_change_the_result() {
    let pixels = image();
    let mut settings = Settings::with_defaults();
    settings.algorithm_layers = vec![layer("a", "threshold", 0.5), layer("b", "bayer", 1.0)];
    let first = dither(&pixels, 8, 8, &settings);
    settings.algorithm_layers.reverse();
    let reversed = dither(&pixels, 8, 8, &settings);
    assert_ne!(first, reversed);
    settings.algorithm_layers[1].opacity = 0.0;
    let skipped = dither(&pixels, 8, 8, &settings);
    settings.algorithm_layers.truncate(1);
    assert_eq!(skipped, dither(&pixels, 8, 8, &settings));
}

#[test]
fn pass_controls_override_global_controls() {
    let pixels = image();
    let mut settings = Settings::with_defaults();
    settings.algorithm_layers = vec![layer("a", "threshold", 1.0)];
    settings.algorithm_layers[0].params.threshold = Some(16.0);
    let low = dither(&pixels, 8, 8, &settings);
    settings.algorithm_layers[0].params.threshold = Some(240.0);
    let high = dither(&pixels, 8, 8, &settings);
    assert_ne!(low, high);
    assert_eq!(settings.threshold, 128.0);
}
