//! Wire schema for render jobs — mirror of `Settings` in types.ts.
//!
//! Every field defaults so UI/engine version skew degrades gracefully
//! (`#[serde(default)]` everywhere); unknown fields are ignored by serde,
//! which keeps the protocol forward-compatible.

use crate::palette::PaletteLayer;
use serde::Deserialize;

fn default_layers() -> Vec<PaletteLayer> {
    vec![
        PaletteLayer {
            id: "layer-1".into(),
            hex: "#000000".into(),
            level: 0.0,
            width: 2.0,
            enabled: true,
        },
        PaletteLayer {
            id: "layer-2".into(),
            hex: "#FFFFFF".into(),
            level: 1.0,
            width: 2.0,
            enabled: true,
        },
    ]
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub algorithm: String,
    #[serde(default = "default_layers")]
    pub layers: Vec<PaletteLayer>,
    #[serde(default)]
    pub match_mode: String,
    #[serde(default)]
    pub tonal_bias: f64,

    // --- error diffusion ---
    #[serde(default)]
    pub strength: f64,
    #[serde(default)]
    pub serpentine: bool,
    #[serde(default)]
    pub jitter: f64,
    #[serde(default)]
    pub error_clamp: f64,

    // --- ordered ---
    #[serde(default)]
    pub bayer_size: f64,
    #[serde(default)]
    pub cell_size: f64,
    #[serde(default)]
    pub screen_angle: f64,
    #[serde(default)]
    pub noise_scale: f64,

    // --- threshold ---
    #[serde(default)]
    pub threshold: f64,
    #[serde(default)]
    pub noise_amount: f64,

    // --- riemersma ---
    #[serde(default)]
    pub riemersma_queue: f64,
    #[serde(default)]
    pub riemersma_decay: f64,

    // --- dot diffusion ---
    #[serde(default)]
    pub dot_class_size: f64,

    // --- omino ---
    #[serde(default)]
    pub omino_direction: String,
    #[serde(default)]
    pub omino_error_strength: f64,
    #[serde(default)]
    pub omino_across: f64,
    #[serde(default)]
    pub omino_aside: f64,
    #[serde(default)]
    pub omino_phase: f64,
    #[serde(default)]
    pub omino_color_count: f64,

    // --- tone ---
    #[serde(default)]
    pub invert: bool,
    #[serde(default)]
    pub grayscale: bool,
    #[serde(default)]
    pub brightness: f64,
    #[serde(default)]
    pub contrast: f64,
    #[serde(default)]
    pub gamma: f64,
    #[serde(default)]
    pub exposure: f64,
    #[serde(default)]
    pub saturation: f64,
    #[serde(default)]
    pub hue_shift: f64,
    #[serde(default)]
    pub temperature: f64,
    #[serde(default)]
    pub tint: f64,

    // --- pre-process ---
    #[serde(default)]
    pub blur: f64,
    #[serde(default)]
    pub sharpen: f64,
    #[serde(default)]
    pub pixel_scale: f64,
}

impl Settings {
    /// Numeric defaults equal the TS `DEFAULT_SETTINGS`.
    pub fn with_defaults() -> Self {
        Self {
            algorithm: "floyd-steinberg".into(),
            layers: default_layers(),
            match_mode: "oklab".into(),
            tonal_bias: 0.5,
            strength: 1.0,
            serpentine: true,
            jitter: 0.0,
            error_clamp: 255.0,
            bayer_size: 4.0,
            cell_size: 8.0,
            screen_angle: 45.0,
            noise_scale: 1.0,
            threshold: 128.0,
            noise_amount: 0.5,
            riemersma_queue: 16.0,
            riemersma_decay: 0.75,
            dot_class_size: 8.0,
            omino_direction: "up".into(),
            omino_error_strength: 1.0,
            omino_across: 0.75,
            omino_aside: 0.25,
            omino_phase: 0.0,
            omino_color_count: 6.0,
            invert: false,
            grayscale: false,
            brightness: 0.0,
            contrast: 0.0,
            gamma: 1.0,
            exposure: 0.0,
            saturation: 0.0,
            hue_shift: 0.0,
            temperature: 0.0,
            tint: 0.0,
            blur: 0.0,
            sharpen: 0.0,
            pixel_scale: 1.0,
        }
    }
}
