use dither_wasm::ascii::GlyphAtlas;
use dither_wasm::engine::{dither, dither_stack, dither_with_glyphs, LayerCache};
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

fn photo(w: usize, h: usize) -> Vec<u8> {
    (0..h).flat_map(|y| (0..w).flat_map(move |x| {
        [((x * 255) / w) as u8, ((y * 255) / h) as u8, (((x ^ y) * 7) % 256) as u8, 255]
    })).collect()
}

fn atlas(density_shift: usize) -> GlyphAtlas {
    let (cw, ch, count) = (4usize, 6usize, 12usize);
    let mut bits = vec![0u8; cw * ch * count];
    for g in 0..count {
        for i in 0..cw * ch {
            bits[g * cw * ch + i] = if (i * 7 + g * 3 + density_shift) % 12 < g { 255 } else { 0 };
        }
    }
    GlyphAtlas::adopt(&bits, count, cw, ch)
}

const MIX: [&str; 10] = [
    "floyd-steinberg", "ascii", "omino", "bayer", "riemersma",
    "dot-diffusion", "ostromoukhov", "jpeg-sort", "halftone", "atkinson",
];

fn ten_layer_settings() -> Settings {
    let mut s = Settings::with_defaults();
    s.algorithm_layers = MIX
        .iter()
        .enumerate()
        .map(|(i, k)| layer(&format!("l{i}"), k, if i % 3 == 2 { 0.6 } else { 1.0 }))
        .collect();
    s
}

#[test]
fn ten_mixed_layers_render_and_match_the_uncached_path() {
    let (w, h) = (48, 36);
    let pixels = photo(w, h);
    let glyphs = atlas(0);
    let s = ten_layer_settings();

    let plain = dither_with_glyphs(&pixels, w, h, &s, &glyphs);
    assert_eq!(plain.len(), w * h * 4);

    let mut cache = LayerCache::new();
    let first = dither_stack(&pixels, w, h, &s, &glyphs, 1, &mut cache);
    assert_eq!(first, plain, "a cold cached run must equal the plain run");
    assert_eq!((cache.reused, cache.computed), (0, 10));

    let again = dither_stack(&pixels, w, h, &s, &glyphs, 1, &mut cache);
    assert_eq!(again, plain);
    assert_eq!((cache.reused, cache.computed), (10, 0));
}

#[test]
fn editing_a_layer_recomputes_only_from_that_layer_up() {
    let (w, h) = (40, 30);
    let pixels = photo(w, h);
    let glyphs = atlas(0);
    let mut s = ten_layer_settings();
    let mut cache = LayerCache::new();
    dither_stack(&pixels, w, h, &s, &glyphs, 7, &mut cache);

    // Top layer: nine reused.
    s.algorithm_layers[9].params.strength = Some(0.4);
    let out = dither_stack(&pixels, w, h, &s, &glyphs, 7, &mut cache);
    assert_eq!((cache.reused, cache.computed), (9, 1));
    assert_eq!(out, dither_with_glyphs(&pixels, w, h, &s, &glyphs));

    // Middle layer: everything above it follows.
    s.algorithm_layers[4].params.riemersma_decay = Some(0.5);
    let out = dither_stack(&pixels, w, h, &s, &glyphs, 7, &mut cache);
    assert_eq!((cache.reused, cache.computed), (4, 6));
    assert_eq!(out, dither_with_glyphs(&pixels, w, h, &s, &glyphs));

    // Bottom layer: nothing survives.
    s.algorithm_layers[0].params.strength = Some(0.7);
    let out = dither_stack(&pixels, w, h, &s, &glyphs, 7, &mut cache);
    assert_eq!((cache.reused, cache.computed), (0, 10));
    assert_eq!(out, dither_with_glyphs(&pixels, w, h, &s, &glyphs));

    // A new source plane invalidates the lot even with identical settings.
    dither_stack(&pixels, w, h, &s, &glyphs, 8, &mut cache);
    assert_eq!(cache.reused, 0);
}

#[test]
fn global_grading_and_the_atlas_invalidate_the_right_layers() {
    let (w, h) = (36, 24);
    let pixels = photo(w, h);
    let glyphs = atlas(0);
    let mut s = ten_layer_settings();
    let mut cache = LayerCache::new();
    dither_stack(&pixels, w, h, &s, &glyphs, 3, &mut cache);

    // Grading applies to the first executed pass only, but it feeds the chain.
    s.brightness = 20.0;
    let out = dither_stack(&pixels, w, h, &s, &glyphs, 3, &mut cache);
    assert_eq!(cache.reused, 0);
    assert_eq!(out, dither_with_glyphs(&pixels, w, h, &s, &glyphs));

    // A different atlas leaves the pass below the text layer alone.
    let other = atlas(5);
    let out = dither_stack(&pixels, w, h, &s, &other, 3, &mut cache);
    assert_eq!((cache.reused, cache.computed), (1, 9));
    assert_eq!(out, dither_with_glyphs(&pixels, w, h, &s, &other));

    // Disabling a layer shifts the chain from that position.
    s.algorithm_layers[5].enabled = false;
    let out = dither_stack(&pixels, w, h, &s, &other, 3, &mut cache);
    assert_eq!(cache.reused, 5);
    assert_eq!(out, dither_with_glyphs(&pixels, w, h, &s, &other));
}

#[test]
fn a_tiny_budget_degrades_to_recomputing_never_to_wrong_pixels() {
    let (w, h) = (32, 32);
    let pixels = photo(w, h);
    let glyphs = atlas(0);
    let s = ten_layer_settings();
    // Room for two planes only.
    let mut cache = LayerCache::with_budget(w * h * 4 * 2);
    for _ in 0..3 {
        let out = dither_stack(&pixels, w, h, &s, &glyphs, 5, &mut cache);
        assert_eq!(out, dither_with_glyphs(&pixels, w, h, &s, &glyphs));
    }
    assert_eq!(cache.reused, 2);
}

fn flat(w: usize, h: usize, value: u8) -> Vec<u8> {
    (0..w * h).flat_map(|_| [value, value, value, 255]).collect()
}

fn dot_settings(cell: f64) -> Settings {
    let mut s = Settings::with_defaults();
    s.algorithm = "dot-grid".into();
    s.cell_size = cell;
    s
}

fn ink_pixels(out: &[u8]) -> usize {
    out.chunks_exact(4).filter(|p| p[0] < 128).count()
}

#[test]
fn dot_grid_draws_nothing_on_paper_and_fills_cells_on_black() {
    let s = dot_settings(8.0);
    let white = dither(&flat(32, 32, 255), 32, 32, &s);
    assert_eq!(ink_pixels(&white), 0, "a white image has no dots");
    let black = dither(&flat(32, 32, 0), 32, 32, &s);
    assert_eq!(ink_pixels(&black), 32 * 32, "full tone at scale 1 fills the cell");
}

#[test]
fn dot_grid_dots_grow_with_tone_in_every_shape() {
    for shape in ["square", "circle", "diamond"] {
        let mut s = dot_settings(8.0);
        s.dot_shape = shape.into();
        let mut last = 0;
        for value in [230u8, 190, 150, 110, 70, 30] {
            let ink = ink_pixels(&dither(&flat(32, 32, value), 32, 32, &s));
            assert!(ink >= last, "{shape}: tone {value} drew {ink}, fewer than {last}");
            last = ink;
        }
        assert!(last > 0, "{shape}: dark tones must draw dots");
    }
}

#[test]
fn dot_grid_square_dots_are_centred_and_gapped() {
    let mut s = dot_settings(8.0);
    s.dot_scale = 0.5;
    let out = dither(&flat(8, 8, 0), 8, 8, &s);
    // Scale 0.5 of an 8px cell at full tone: a 4x4 dot with a 2px margin.
    let at = |x: usize, y: usize| out[(y * 8 + x) * 4] < 128;
    for y in 0..8 {
        for x in 0..8 {
            let inside = (2..6).contains(&x) && (2..6).contains(&y);
            assert_eq!(at(x, y), inside, "({x},{y})");
        }
    }
}

#[test]
fn dot_grid_cutoff_threshold_and_levels_shape_the_result() {
    let grey = flat(32, 32, 200);
    let mut s = dot_settings(8.0);
    s.dot_cutoff = 0.0;
    let with = ink_pixels(&dither(&grey, 32, 32, &s));
    assert!(with > 0);
    s.dot_cutoff = 0.9;
    assert_eq!(ink_pixels(&dither(&grey, 32, 32, &s)), 0, "a high cutoff removes light dots");

    // Raising the threshold brightens the read, so there is less ink.
    s.dot_cutoff = 0.0;
    s.threshold = 128.0;
    let base = ink_pixels(&dither(&grey, 32, 32, &s));
    s.threshold = 220.0;
    assert!(ink_pixels(&dither(&grey, 32, 32, &s)) < base);
    s.threshold = 30.0;
    assert!(ink_pixels(&dither(&grey, 32, 32, &s)) > base);

    // Two levels means every drawn dot is one of two sizes.
    s.threshold = 128.0;
    s.dot_levels = 2.0;
    let ramp: Vec<u8> = (0..32).flat_map(|_| (0..32).flat_map(|x| { let v = (x * 8) as u8; [v, v, v, 255] })).collect();
    let out = dither(&ramp, 32, 32, &s);
    let mut sizes = std::collections::BTreeSet::new();
    for cell_x in 0..4 {
        let n = (0..8).flat_map(|y| (0..8).map(move |x| (x, y)))
            .filter(|&(x, y)| out[(y * 32 + cell_x * 8 + x) * 4] < 128).count();
        sizes.insert(n);
    }
    assert!(sizes.len() <= 2, "levels=2 produced sizes {sizes:?}");
}

#[test]
fn dot_grid_stagger_ink_modes_and_edges_stay_well_formed() {
    let pixels = photo(37, 29); // not a multiple of the cell on either axis
    for stagger in [false, true] {
        for invert in [false, true] {
            for ink in ["palette", "mono"] {
                let mut s = dot_settings(6.0);
                s.dot_stagger = stagger;
                s.dot_invert = invert;
                s.dot_ink = ink.into();
                let out = dither(&pixels, 37, 29, &s);
                assert_eq!(out.len(), 37 * 29 * 4);
                assert!(out.chunks_exact(4).all(|p| p[3] == 255));
                assert_eq!(out, dither(&pixels, 37, 29, &s), "must be repeatable");
            }
        }
    }
    // Inverting swaps ink and paper, so the two readings are complements here.
    let mut s = dot_settings(6.0);
    s.dot_ink = "mono".into();
    let normal = ink_pixels(&dither(&flat(24, 24, 40), 24, 24, &s));
    s.dot_invert = true;
    let inverted = dot_ink_light(&dither(&flat(24, 24, 0), 24, 24, &s));
    assert!(normal > 0);
    assert_eq!(inverted, 0, "black has no light dots when dots stand for light");
}

fn dot_ink_light(out: &[u8]) -> usize {
    out.chunks_exact(4).filter(|p| p[0] >= 128).count()
}

#[test]
fn dot_grid_stacks_with_per_layer_overrides() {
    let (w, h) = (40, 30);
    let pixels = photo(w, h);
    let mut s = Settings::with_defaults();
    s.algorithm_layers = vec![layer("a", "dot-grid", 1.0), layer("b", "bayer", 0.5)];
    s.algorithm_layers[0].params.cell_size = Some(5.0);
    s.algorithm_layers[0].params.dot_shape = Some("circle".into());
    let coarse = dither(&pixels, w, h, &s);
    s.algorithm_layers[0].params.cell_size = Some(10.0);
    assert_ne!(coarse, dither(&pixels, w, h, &s), "per-layer cell size must apply");
    assert_eq!(s.cell_size, 8.0, "the global value is untouched");
}
