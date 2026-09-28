//! Text-mode rendering: paint the image out of glyphs.
//!
//! The engine cannot rasterise type - it has no fonts and no text stack - so
//! the glyphs arrive pre-rendered from the host as a coverage atlas: `count`
//! cells of `cell_w * cell_h` bytes, one byte of ink coverage per pixel. That
//! keeps the split where it belongs. JS owns "what does U+4E2D look like at
//! 12x20", the engine owns "which glyph belongs in this cell and what colour
//! is it", and every consumer of the engine - preview, export, video - gets
//! the same answer without a second text pipeline.
//!
//! The atlas is resident for the same reason the pixel planes are: it is tens
//! to hundreds of kilobytes and changes only when the character set or the
//! cell size does, never per slider tick.

/// Pre-rasterised glyph coverage, shipped from the host.
#[derive(Default, Clone)]
pub struct GlyphAtlas {
    /// `count * cell_w * cell_h` bytes of coverage, 0 = paper, 255 = full ink.
    pub bitmaps: Vec<u8>,
    pub count: usize,
    pub cell_w: usize,
    pub cell_h: usize,
    /// Mean coverage per glyph, 0..1 — the brightness ramp, precomputed.
    pub ink: Vec<f32>,
    /// Glyph indices ordered by ascending ink, for the brightness matcher.
    pub by_ink: Vec<u32>,
}

impl GlyphAtlas {
    pub fn is_empty(&self) -> bool {
        self.count == 0 || self.cell_w == 0 || self.cell_h == 0
    }

    /// Adopts a host-supplied atlas, precomputing what matching needs.
    pub fn adopt(bitmaps: &[u8], count: usize, cell_w: usize, cell_h: usize) -> Self {
        let cell = cell_w * cell_h;
        if cell == 0 || count == 0 || bitmaps.len() < count * cell {
            return Self::default();
        }
        let mut ink = Vec::with_capacity(count);
        for g in 0..count {
            let slice = &bitmaps[g * cell..(g + 1) * cell];
            let sum: u32 = slice.iter().map(|&v| u32::from(v)).sum();
            ink.push((f64::from(sum) / (cell as f64 * 255.0)) as f32);
        }
        let mut by_ink: Vec<u32> = (0..count as u32).collect();
        by_ink.sort_by(|&a, &b| {
            ink[a as usize]
                .partial_cmp(&ink[b as usize])
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        Self {
            bitmaps: bitmaps[..count * cell].to_vec(),
            count,
            cell_w,
            cell_h,
            ink,
            by_ink,
        }
    }

    #[inline]
    fn glyph(&self, index: usize) -> &[u8] {
        let cell = self.cell_w * self.cell_h;
        &self.bitmaps[index * cell..(index + 1) * cell]
    }

    /// Nearest glyph by mean coverage — the classic brightness ramp.
    ///
    /// Binary search over the ink-sorted order rather than a linear scan: an
    /// atlas can hold a thousand glyphs and this runs once per cell.
    pub fn by_brightness(&self, target: f64) -> usize {
        let t = target.clamp(0.0, 1.0) as f32;
        let order = &self.by_ink;
        let mut lo = 0usize;
        let mut hi = order.len();
        while lo < hi {
            let mid = (lo + hi) / 2;
            if self.ink[order[mid] as usize] < t {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        // `lo` is the first glyph at or above the target; the neighbour below
        // is often the closer of the two.
        let above = lo.min(order.len() - 1);
        let below = lo.saturating_sub(1);
        let da = (self.ink[order[above] as usize] - t).abs();
        let db = (self.ink[order[below] as usize] - t).abs();
        order[if da <= db { above } else { below }] as usize
    }

    /// Best glyph by shape, comparing the cell's own coverage pixel for pixel.
    ///
    /// This is what makes the output look painted rather than merely shaded:
    /// an edge running through a cell picks a glyph with a stroke in the same
    /// place, so lines in the image survive as lines in the text.
    pub fn by_shape(&self, cell_cov: &[f32], contrast: f64) -> usize {
        let cell = self.cell_w * self.cell_h;
        // Centre both signals so a glyph is chosen on where its ink sits, not
        // on overall darkness, which the brightness term already handles.
        let mean: f64 = cell_cov.iter().map(|&v| f64::from(v)).sum::<f64>() / cell as f64;
        let mut best = 0usize;
        let mut best_score = f64::INFINITY;
        for g in 0..self.count {
            let bits = self.glyph(g);
            let g_mean = f64::from(self.ink[g]);
            let mut ssd = 0.0f64;
            for i in 0..cell {
                let a = f64::from(cell_cov[i]) - mean;
                let b = f64::from(bits[i]) / 255.0 - g_mean;
                let d = a - b;
                ssd += d * d;
            }
            // Keep overall density honest too, or a dense cell can pick a
            // sparse glyph whose strokes happen to line up.
            let dm = mean - g_mean;
            let score = ssd + dm * dm * cell as f64 * contrast;
            if score < best_score {
                best_score = score;
                best = g;
            }
        }
        best
    }
}
