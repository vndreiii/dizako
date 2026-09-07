//! Geometry shared across the boundary — mirror of `Rect` in region.ts.

use serde::Deserialize;

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}
