//! wasm-bindgen boundary (WASM_PLAN §5.3).
//!
//! One `Engine` instance lives in the worker for the app's lifetime and owns
//! the resident pixel planes; jobs carry settings plus geometry only, so
//! slider ticks stop shipping megabytes across the boundary.
//!
//! It also owns everything derived from those planes: the reduced copies the
//! preview renders first, and the per-pass results of a stack. Both are pure
//! functions of the source and the settings, so keeping them here - rather than
//! rebuilding them on the main thread or recomputing them per tick - changes
//! how fast a frame arrives and nothing about what it looks like.

use crate::ascii::GlyphAtlas;
use crate::engine::{self, LayerCache};
use crate::region::Rect;
use crate::scale;
use crate::settings::Settings;
use std::borrow::Cow;
use wasm_bindgen::prelude::*;

/// Reduced copies kept at once. A drag settles on one size, so two is enough
/// to survive the engine stepping between neighbouring sizes without thrash.
const COARSE_PLANES: usize = 3;

/// Planes whose stacks stay cached together: the reduced preview, the full
/// image and a viewport crop.
const MAX_CACHES: usize = 3;
const CACHE_BYTES_EACH: usize = 96 << 20;

struct CoarsePlane {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

#[wasm_bindgen]
pub struct Engine {
    master: Vec<u8>,
    /// Caller-supplied companion from `set_coarse`; wins over derived planes.
    coarse: Vec<u8>,
    master_w: u32,
    master_h: u32,
    coarse_w: u32,
    coarse_h: u32,
    derived: Vec<CoarsePlane>,
    out: Vec<u8>,
    out_w: u32,
    out_h: u32,
    glyphs: GlyphAtlas,
    /// One stack cache per input plane, most recently used last. The coarse
    /// pass and its full-resolution follow-up render different planes, and
    /// sharing one cache would have each evict the other on every tick.
    caches: Vec<(u64, LayerCache)>,
    /// Bumped whenever a plane the cache keys on changes.
    source_gen: u64,
    last_reused: u32,
    last_computed: u32,
}

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Engine {
        Engine {
            master: Vec::new(),
            coarse: Vec::new(),
            master_w: 0,
            master_h: 0,
            coarse_w: 0,
            coarse_h: 0,
            derived: Vec::new(),
            out: Vec::new(),
            out_w: 0,
            out_h: 0,
            glyphs: GlyphAtlas::default(),
            caches: Vec::new(),
            source_gen: 0,
            last_reused: 0,
            last_computed: 0,
        }
    }

    /// Full-resolution source, copied once per load.
    pub fn set_source(&mut self, rgba: &[u8], w: u32, h: u32) {
        self.master = rgba.to_vec();
        self.master_w = w;
        self.master_h = h;
        self.coarse.clear();
        self.coarse_w = 0;
        self.coarse_h = 0;
        self.derived.clear();
        self.source_gen += 1;
        self.caches.clear();
    }

    /// Pre-downscaled companion, copied once per (source, scale).
    ///
    /// Retained for hosts that build the reduced copy themselves; the preview
    /// no longer does - see `render_coarse`.
    pub fn set_coarse(&mut self, rgba: &[u8], w: u32, h: u32) {
        self.coarse = rgba.to_vec();
        self.coarse_w = w;
        self.coarse_h = h;
        self.source_gen += 1;
        self.caches.clear();
    }

    /// Pre-rasterised glyph coverage for the text algorithm.
    ///
    /// Resident for the same reason the pixel planes are: an atlas is tens to
    /// hundreds of kilobytes and changes only when the character set, the font
    /// or the cell size does - never per slider tick. An empty call clears it.
    /// The stack cache notices the change through the atlas's own fingerprint,
    /// so only passes that read it are redone.
    pub fn set_glyphs(&mut self, bitmaps: &[u8], count: u32, cell_w: u32, cell_h: u32) {
        self.glyphs = GlyphAtlas::adopt(bitmaps, count as usize, cell_w as usize, cell_h as usize);
    }

    /// Renders a job into the reused output plane; returns its byte length.
    ///
    /// `stage` is `"coarse"` or `"fine"`; `region_js` is
    /// `{x,y,width,height}` or null for the whole plane.
    pub fn render(
        &mut self,
        stage: &str,
        region_js: JsValue,
        settings_js: JsValue,
    ) -> Result<usize, JsValue> {
        let settings = parse_settings(settings_js)?;
        let region = parse_region(region_js)?;
        self.render_inner(stage, region, &settings, 0)
    }

    /// Renders the whole image at roughly `target_pixels`, reducing it first
    /// when it is larger. The reduced plane is built here from the resident
    /// source (and kept), so the host never touches a canvas to get one.
    ///
    /// Check `out_width`/`out_height` for the size that came back.
    pub fn render_coarse(&mut self, target_pixels: u32, settings_js: JsValue) -> Result<usize, JsValue> {
        let settings = parse_settings(settings_js)?;
        self.render_inner("coarse", None, &settings, target_pixels as usize)
    }

    /// Width of the last rendered plane, in pixels.
    pub fn out_width(&self) -> u32 {
        self.out_w
    }

    /// Height of the last rendered plane, in pixels.
    pub fn out_height(&self) -> u32 {
        self.out_h
    }

    /// Stack passes the last render served from its cache, and passes it ran.
    pub fn last_reused(&self) -> u32 {
        self.last_reused
    }

    pub fn last_computed(&self) -> u32 {
        self.last_computed
    }

    /// Pointer to the output plane for `new Uint8Array(wasmMemory.buffer,
    /// ptr, len)` views.
    pub fn out_ptr(&self) -> *const u8 {
        self.out.as_ptr()
    }
}

impl Engine {
    fn derived_plane(&mut self, target: usize) -> Option<usize> {
        let (dw, dh) = scale::fit_pixels(self.master_w as usize, self.master_h as usize, target);
        if dw as u32 == self.master_w && dh as u32 == self.master_h {
            return None;
        }
        if let Some(at) = self
            .derived
            .iter()
            .position(|p| p.width as usize == dw && p.height as usize == dh)
        {
            return Some(at);
        }
        let pixels = scale::area_downscale(
            &self.master,
            self.master_w as usize,
            self.master_h as usize,
            dw,
            dh,
        );
        if self.derived.len() >= COARSE_PLANES {
            self.derived.remove(0);
        }
        self.derived.push(CoarsePlane { width: dw as u32, height: dh as u32, pixels });
        Some(self.derived.len() - 1)
    }

    fn render_inner(
        &mut self,
        stage: &str,
        region: Option<Rect>,
        settings: &Settings,
        coarse_target: usize,
    ) -> Result<usize, JsValue> {
        if self.master.is_empty() {
            return Err(JsValue::from_str("render before set_source"));
        }

        // Which plane is this job over, and what names it in the cache?
        let (data, w, h, plane_key): (Cow<[u8]>, u32, u32, u64) = if let Some(r) = region {
            let (x, y) = (r.x as usize, r.y as usize);
            let (rw, rh) = (r.width as usize, r.height as usize);
            let stride = self.master_w as usize * 4;
            if (x + rw) > self.master_w as usize || (y + rh) > self.master_h as usize {
                return Err(JsValue::from_str("region outside the source"));
            }
            // Region crops stride the resident master internally - no crop
            // copy crosses the boundary from JS.
            let mut cropped = vec![0u8; rw * rh * 4];
            for row in 0..rh {
                let from = (y + row) * stride + x * 4;
                cropped[row * rw * 4..(row + 1) * rw * 4]
                    .copy_from_slice(&self.master[from..from + rw * 4]);
            }
            let key = key_of(&[1, x as u64, y as u64, rw as u64, rh as u64]);
            (Cow::Owned(cropped), r.width, r.height, key)
        } else if stage == "coarse" && !self.coarse.is_empty() {
            (Cow::Borrowed(&self.coarse[..]), self.coarse_w, self.coarse_h, key_of(&[2]))
        } else if stage == "coarse" && coarse_target > 0 {
            match self.derived_plane(coarse_target) {
                Some(at) => {
                    let p = &self.derived[at];
                    (Cow::Borrowed(&p.pixels[..]), p.width, p.height, key_of(&[3, u64::from(p.width), u64::from(p.height)]))
                }
                None => (Cow::Borrowed(&self.master[..]), self.master_w, self.master_h, key_of(&[0])),
            }
        } else {
            (Cow::Borrowed(&self.master[..]), self.master_w, self.master_h, key_of(&[0]))
        };

        // A reduced plane is a smaller picture: pixel-length controls follow it.
        let scale = if region.is_none() && w > 0 { f64::from(self.master_w) / f64::from(w) } else { 1.0 };
        let scaled;
        let settings = if scale > 1.0001 {
            scaled = settings.for_preview_scale(scale);
            &scaled
        } else {
            settings
        };

        let base = key_of(&[self.source_gen, plane_key]);
        let at = match self.caches.iter().position(|(k, _)| *k == base) {
            Some(at) => at,
            None => {
                if self.caches.len() >= MAX_CACHES {
                    self.caches.remove(0);
                }
                self.caches.push((base, LayerCache::with_budget(CACHE_BYTES_EACH)));
                self.caches.len() - 1
            }
        };
        // Most recently used goes last so eviction takes the stalest.
        let last = self.caches.len() - 1;
        self.caches.swap(at, last);
        let cache = &mut self.caches[last].1;
        let out = engine::dither_stack(&data, w as usize, h as usize, settings, &self.glyphs, base, cache);
        self.last_reused = cache.reused as u32;
        self.last_computed = cache.computed as u32;
        self.out = out;
        self.out_w = w;
        self.out_h = h;
        Ok(self.out.len())
    }
}

fn key_of(parts: &[u64]) -> u64 {
    let mut h: u64 = 0xCBF2_9CE4_8422_2325;
    for &p in parts {
        h = (h ^ p).wrapping_mul(0x0000_0100_0000_01B3);
        h ^= h >> 31;
    }
    h
}

fn parse_settings(js: JsValue) -> Result<Settings, JsValue> {
    serde_wasm_bindgen::from_value(js).map_err(|e| JsValue::from_str(&format!("settings: {e}")))
}

fn parse_region(js: JsValue) -> Result<Option<Rect>, JsValue> {
    if js.is_null() || js.is_undefined() {
        return Ok(None);
    }
    serde_wasm_bindgen::from_value(js)
        .map(Some)
        .map_err(|e| JsValue::from_str(&format!("region: {e}")))
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
pub fn dither_bytes(rgba: &[u8], w: u32, h: u32, settings_js: JsValue) -> Result<Vec<u8>, JsValue> {
    let settings = parse_settings(settings_js)?;
    Ok(engine::dither(rgba, w as usize, h as usize, &settings))
}
