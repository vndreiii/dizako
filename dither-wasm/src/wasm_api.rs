//! wasm-bindgen boundary (WASM_PLAN §5.3).
//!
//! One `Engine` instance lives in the worker for the app's lifetime and owns
//! the resident pixel planes; jobs carry settings plus geometry only, so
//! slider ticks stop shipping megabytes across the boundary.

use crate::engine;
use crate::region::Rect;
use crate::settings::Settings;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct Engine {
    master: Vec<u8>,
    coarse: Vec<u8>,
    master_w: u32,
    master_h: u32,
    coarse_w: u32,
    coarse_h: u32,
    out: Vec<u8>,
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
            out: Vec::new(),
        }
    }

    /// Full-resolution source, copied once per load.
    pub fn set_source(&mut self, rgba: &[u8], w: u32, h: u32) {
        self.master = rgba.to_vec();
        self.master_w = w;
        self.master_h = h;
    }

    /// Pre-downscaled companion, copied once per (source, scale).
    pub fn set_coarse(&mut self, rgba: &[u8], w: u32, h: u32) {
        self.coarse = rgba.to_vec();
        self.coarse_w = w;
        self.coarse_h = h;
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
        let settings: Settings = serde_wasm_bindgen::from_value(settings_js)
            .map_err(|e| JsValue::from_str(&format!("settings: {e}")))?;

        let region: Option<Rect> = if region_js.is_null() || region_js.is_undefined() {
            None
        } else {
            Some(
                serde_wasm_bindgen::from_value(region_js)
                    .map_err(|e| JsValue::from_str(&format!("region: {e}")))?,
            )
        };

        // Region crops stride the resident master internally — no crop copy
        // crosses the boundary from JS.
        let owned: Option<Vec<u8>> = region.map(|r| {
            let x = r.x as usize;
            let y = r.y as usize;
            let rw = r.width as usize;
            let rh = r.height as usize;
            let stride = self.master_w as usize * 4;
            let mut cropped = vec![0u8; rw * rh * 4];
            for row in 0..rh {
                let from = (y + row) * stride + x * 4;
                cropped[row * rw * 4..(row + 1) * rw * 4]
                    .copy_from_slice(&self.master[from..from + rw * 4]);
            }
            cropped
        });

        let (data, w, h): (Vec<u8>, u32, u32) = match (stage, owned) {
            (_, Some(cropped)) => {
                let r = region.unwrap();
                (cropped, r.width, r.height)
            }
            ("coarse", _) if !self.coarse.is_empty() => {
                (self.coarse.clone(), self.coarse_w, self.coarse_h)
            }
            _ => (self.master.clone(), self.master_w, self.master_h),
        };

        let out = engine::dither(&data, w as usize, h as usize, &settings);
        self.out = out;
        Ok(self.out.len())
    }

    /// Pointer to the output plane for `new Uint8Array(wasmMemory.buffer,
    /// ptr, len)` views.
    pub fn out_ptr(&self) -> *const u8 {
        self.out.as_ptr()
    }
}

#[wasm_bindgen]
pub fn dither_bytes(rgba: &[u8], w: u32, h: u32, settings_js: JsValue) -> Result<Vec<u8>, JsValue> {
    let settings: Settings = serde_wasm_bindgen::from_value(settings_js)
        .map_err(|e| JsValue::from_str(&format!("settings: {e}")))?;
    Ok(engine::dither(rgba, w as usize, h as usize, &settings))
}
