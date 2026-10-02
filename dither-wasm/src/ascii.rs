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
    /// Each glyph's coverage as the shape matcher reads it: byte / 255 with the
    /// glyph's own mean removed, in f64. Computed once here with the same
    /// expression the matcher used per pixel, so scores are bit-identical.
    pub centred: Vec<f64>,
    fp: u64,
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
        let mut centred = Vec::with_capacity(count * cell);
        for g in 0..count {
            let g_mean = f64::from(ink[g]);
            for &v in &bitmaps[g * cell..(g + 1) * cell] {
                centred.push(f64::from(v) / 255.0 - g_mean);
            }
        }
        Self {
            bitmaps: bitmaps[..count * cell].to_vec(),
            count,
            cell_w,
            cell_h,
            ink,
            by_ink,
            centred,
            fp: Self::compute_fingerprint(&bitmaps[..count * cell], count, cell_w, cell_h),
        }
    }

    /// Identity of this atlas's contents, for cache keys. Two atlases with the
    /// same glyphs at the same cell size agree; any difference changes it.
    pub fn fingerprint(&self) -> u64 {
        self.fp
    }

    fn compute_fingerprint(bitmaps: &[u8], count: usize, cell_w: usize, cell_h: usize) -> u64 {
        let mut h: u64 = 0xCBF2_9CE4_8422_2325 ^ (count as u64) ^ ((cell_w as u64) << 20) ^ ((cell_h as u64) << 40);
        for chunk in bitmaps.chunks(8) {
            let mut word = [0u8; 8];
            word[..chunk.len()].copy_from_slice(chunk);
            h = (h ^ u64::from_le_bytes(word)).wrapping_mul(0x0000_0100_0000_01B3);
            h ^= h >> 29;
        }
        h
    }

    /// A glyph's coverage bytes.
    #[inline]
    pub fn glyph(&self, index: usize) -> &[u8] {
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
    ///
    /// Scores are sums of squares, so they only grow as pixels are added. A
    /// candidate whose running sum already exceeds the best score so far can
    /// never win and is abandoned mid-way; the winner and the tie-break (lowest
    /// index) are exactly what a full scan of every glyph would pick. The
    /// brightness-nearest glyph is scored first so the bound is tight from the
    /// start.
    pub fn by_shape(&self, cell_cov: &[f32], contrast: f64) -> usize {
        let cell = self.cell_w * self.cell_h;
        // Centre both signals so a glyph is chosen on where its ink sits, not
        // on overall darkness, which the brightness term already handles.
        let mean: f64 = cell_cov.iter().map(|&v| f64::from(v)).sum::<f64>() / cell as f64;
        let centred_cov: Vec<f64> = cell_cov.iter().map(|&v| f64::from(v) - mean).collect();

        let score_of = |g: usize, bound: f64| -> Option<f64> {
            let bits = &self.centred[g * cell..(g + 1) * cell];
            let mut ssd = 0.0f64;
            for (row_cov, row_bits) in centred_cov
                .chunks(self.cell_w)
                .zip(bits.chunks(self.cell_w))
            {
                for (a, b) in row_cov.iter().zip(row_bits) {
                    let d = a - b;
                    ssd += d * d;
                }
                if ssd > bound {
                    return None;
                }
            }
            // Keep overall density honest too, or a dense cell can pick a
            // sparse glyph whose strokes happen to line up.
            let dm = mean - f64::from(self.ink[g]);
            Some(ssd + dm * dm * cell as f64 * contrast)
        };

        let mut best = self.by_brightness(mean);
        let mut best_score = score_of(best, f64::INFINITY).unwrap_or(f64::INFINITY);
        for g in 0..self.count {
            if g == best {
                continue;
            }
            // `ssd` is at most the score, so anything past the bound is out.
            if let Some(score) = score_of(g, best_score) {
                if score < best_score || (score == best_score && g < best) {
                    best_score = score;
                    best = g;
                }
            }
        }
        best
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The matcher as it was before pruning: every glyph, every pixel.
    fn reference(atlas: &GlyphAtlas, cell_cov: &[f32], contrast: f64) -> usize {
        let cell = atlas.cell_w * atlas.cell_h;
        let mean: f64 = cell_cov.iter().map(|&v| f64::from(v)).sum::<f64>() / cell as f64;
        let mut best = 0usize;
        let mut best_score = f64::INFINITY;
        for g in 0..atlas.count {
            let bits = atlas.glyph(g);
            let g_mean = f64::from(atlas.ink[g]);
            let mut ssd = 0.0f64;
            for i in 0..cell {
                let a = f64::from(cell_cov[i]) - mean;
                let b = f64::from(bits[i]) / 255.0 - g_mean;
                let d = a - b;
                ssd += d * d;
            }
            let dm = mean - g_mean;
            let score = ssd + dm * dm * cell as f64 * contrast;
            if score < best_score {
                best_score = score;
                best = g;
            }
        }
        best
    }

    #[test]
    fn pruned_shape_match_equals_exhaustive_scan() {
        let (cw, ch, count) = (6usize, 10usize, 60usize);
        let mut seed: u32 = 0xDEAD_BEEF;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed
        };
        let mut bits = vec![0u8; cw * ch * count];
        for (i, b) in bits.iter_mut().enumerate() {
            // Repeat a few glyphs so exact score ties actually occur.
            let g = i / (cw * ch);
            let within = i % (cw * ch);
            let src = if g % 7 == 0 { 0 } else { g };
            *b = if (src * 31 + within * 17) % 5 < 2 { 255 } else { 0 };
            if next() % 11 == 0 {
                *b = 255 - *b;
            }
        }
        // Force a duplicate so the lowest-index tie-break is exercised.
        let first: Vec<u8> = bits[..cw * ch].to_vec();
        bits[7 * cw * ch..8 * cw * ch].copy_from_slice(&first);
        let atlas = GlyphAtlas::adopt(&bits, count, cw, ch);

        for round in 0..400 {
            let cov: Vec<f32> = (0..cw * ch)
                .map(|_| if round % 5 == 0 { (next() % 2) as f32 } else { (next() % 1000) as f32 / 999.0 })
                .collect();
            for contrast in [0.0, 1.0, 3.5] {
                assert_eq!(
                    atlas.by_shape(&cov, contrast),
                    reference(&atlas, &cov, contrast),
                    "round {round} contrast {contrast}"
                );
            }
        }
    }
}
