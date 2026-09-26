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

#[test]
fn jpeg_error_controls_apply_repeatable_pixel_data_loss() {
    let pixels: Vec<u8> = (0..32).flat_map(|y| (0..32).flat_map(move |x| {
        [((x * 8) as u8), ((y * 8) as u8), (((x + y) * 4) as u8), 255]
    })).collect();
    let mut settings = Settings::with_defaults();
    settings.algorithm = "jpeg-sort".into();
    settings.jpeg_damage = 0.0;
    settings.jpeg_error_rate = 0.0;
    let clean = dither(&pixels, 32, 32, &settings);
    settings.jpeg_error_rate = 3.0;
    settings.jpeg_error_density = 1.0;
    settings.jpeg_error_amplitude = 4.0;
    let damaged = dither(&pixels, 32, 32, &settings);
    assert_ne!(damaged, clean, "JPEG errors must alter rendered pixel data");
    assert_eq!(damaged, dither(&pixels, 32, 32, &settings), "damage must be repeatable");
    settings.jpeg_error_density = 0.0;
    assert_eq!(dither(&pixels, 32, 32, &settings), clean, "zero density disables damage");
}

#[test]
fn jpeg_cell_size_can_be_overridden_per_algorithm_layer() {
    let pixels: Vec<u8> = (0..32).flat_map(|y| (0..32).flat_map(move |x| {
        [((x * 8) as u8), ((y * 8) as u8), 128, 255]
    })).collect();
    let mut settings = Settings::with_defaults();
    settings.algorithm_layers = vec![layer("jpeg", "jpeg-sort", 1.0)];
    settings.algorithm_layers[0].params.jpeg_cell_size = Some(2.0);
    let small = dither(&pixels, 32, 32, &settings);
    settings.algorithm_layers[0].params.jpeg_cell_size = Some(24.0);
    let large = dither(&pixels, 32, 32, &settings);
    assert_ne!(small, large);
}
