/**
 * Character repertoires for text mode.
 *
 * "Every Unicode character" is not a set anyone can rasterise: there are over
 * 150 000 assigned codepoints, no installed font covers more than a slice of
 * them, and the ones a font cannot draw come back as identical tofu boxes that
 * would flood the atlas with duplicates. So the repertoire is expressed as
 * ranges per script, and the builder filters to what the chosen font can
 * actually draw before anything reaches the engine.
 *
 * Ranges are deliberately the *printable* part of each block - no combining
 * marks, no format controls, no variation selectors. A combining acute has no
 * standalone shape and would sit in the atlas as a near-blank glyph competing
 * with the space.
 */

export interface ScriptRange {
  /** Inclusive start and end codepoints. */
  from: number;
  to: number;
}

export interface ScriptDef {
  id: string;
  /** English name; the UI translates via `script.<id>`. */
  name: string;
  /** Rough grouping for the picker. */
  group: "core" | "european" | "asian" | "african" | "indic" | "symbol" | "historic";
  ranges: ScriptRange[];
}

const r = (from: number, to: number): ScriptRange => ({ from, to });

export const SCRIPTS: ScriptDef[] = [
  // ---- core: the sets people reach for first ----
  { id: "ascii", name: "ASCII", group: "core", ranges: [r(0x21, 0x7e)] },
  { id: "ascii-dense", name: "ASCII (dense ramp)", group: "core", ranges: [r(0x21, 0x7e)] },
  { id: "blocks", name: "Block elements", group: "core", ranges: [r(0x2580, 0x259f)] },
  { id: "box", name: "Box drawing", group: "core", ranges: [r(0x2500, 0x257f)] },
  { id: "braille", name: "Braille patterns", group: "core", ranges: [r(0x2800, 0x28ff)] },
  { id: "shapes", name: "Geometric shapes", group: "core", ranges: [r(0x25a0, 0x25ff), r(0x1f780, 0x1f7d8)] },

  // ---- european ----
  { id: "latin", name: "Latin", group: "european", ranges: [r(0x21, 0x7e), r(0xa1, 0xff), r(0x100, 0x17f), r(0x180, 0x24f)] },
  { id: "greek", name: "Greek", group: "european", ranges: [r(0x386, 0x3ce), r(0x3d0, 0x3ff), r(0x1f00, 0x1ffe)] },
  { id: "cyrillic", name: "Cyrillic", group: "european", ranges: [r(0x400, 0x4ff), r(0x500, 0x52f)] },
  { id: "armenian", name: "Armenian", group: "european", ranges: [r(0x531, 0x556), r(0x561, 0x587)] },
  { id: "georgian", name: "Georgian", group: "european", ranges: [r(0x10a0, 0x10c5), r(0x10d0, 0x10ff)] },
  { id: "runic", name: "Runic", group: "historic", ranges: [r(0x16a0, 0x16ea)] },
  { id: "ogham", name: "Ogham", group: "historic", ranges: [r(0x1681, 0x169a)] },
  { id: "coptic", name: "Coptic", group: "historic", ranges: [r(0x2c80, 0x2cb1)] },
  { id: "glagolitic", name: "Glagolitic", group: "historic", ranges: [r(0x2c00, 0x2c5e)] },

  // ---- middle east ----
  { id: "hebrew", name: "Hebrew", group: "european", ranges: [r(0x5d0, 0x5ea), r(0xfb1d, 0xfb4f)] },
  { id: "arabic", name: "Arabic", group: "african", ranges: [r(0x621, 0x63a), r(0x641, 0x64a), r(0x66e, 0x6d3)] },
  { id: "syriac", name: "Syriac", group: "african", ranges: [r(0x710, 0x72f)] },
  { id: "thaana", name: "Thaana", group: "african", ranges: [r(0x780, 0x7a5)] },

  // ---- indic ----
  { id: "devanagari", name: "Devanagari", group: "indic", ranges: [r(0x905, 0x939), r(0x958, 0x961)] },
  { id: "bengali", name: "Bengali", group: "indic", ranges: [r(0x985, 0x98c), r(0x98f, 0x990), r(0x993, 0x9b0), r(0x9b2, 0x9b9)] },
  { id: "gurmukhi", name: "Gurmukhi", group: "indic", ranges: [r(0xa05, 0xa0a), r(0xa13, 0xa28), r(0xa2a, 0xa30)] },
  { id: "gujarati", name: "Gujarati", group: "indic", ranges: [r(0xa85, 0xa8d), r(0xa8f, 0xab0), r(0xab2, 0xab9)] },
  { id: "oriya", name: "Odia", group: "indic", ranges: [r(0xb05, 0xb0c), r(0xb13, 0xb28), r(0xb2a, 0xb30)] },
  { id: "tamil", name: "Tamil", group: "indic", ranges: [r(0xb85, 0xb8a), r(0xb92, 0xb95), r(0xb99, 0xb9a), r(0xb9e, 0xbb9)] },
  { id: "telugu", name: "Telugu", group: "indic", ranges: [r(0xc05, 0xc0c), r(0xc0e, 0xc28), r(0xc2a, 0xc39)] },
  { id: "kannada", name: "Kannada", group: "indic", ranges: [r(0xc85, 0xc8c), r(0xc8e, 0xca8), r(0xcaa, 0xcb9)] },
  { id: "malayalam", name: "Malayalam", group: "indic", ranges: [r(0xd05, 0xd0c), r(0xd0e, 0xd28), r(0xd2a, 0xd39)] },
  { id: "sinhala", name: "Sinhala", group: "indic", ranges: [r(0xd85, 0xd96), r(0xd9a, 0xdb1), r(0xdb3, 0xdbb)] },

  // ---- south-east and east asia ----
  { id: "thai", name: "Thai", group: "asian", ranges: [r(0xe01, 0xe3a), r(0xe40, 0xe4e)] },
  { id: "lao", name: "Lao", group: "asian", ranges: [r(0xe81, 0xe82), r(0xe87, 0xe88), r(0xe94, 0xe97), r(0xe99, 0xe9f), r(0xea1, 0xea3)] },
  { id: "tibetan", name: "Tibetan", group: "asian", ranges: [r(0xf40, 0xf6c)] },
  { id: "myanmar", name: "Myanmar", group: "asian", ranges: [r(0x1000, 0x102a)] },
  { id: "khmer", name: "Khmer", group: "asian", ranges: [r(0x1780, 0x17b3)] },
  { id: "mongolian", name: "Mongolian", group: "asian", ranges: [r(0x1820, 0x1842)] },
  { id: "hiragana", name: "Hiragana", group: "asian", ranges: [r(0x3041, 0x3096)] },
  { id: "katakana", name: "Katakana", group: "asian", ranges: [r(0x30a1, 0x30fa), r(0x31f0, 0x31ff)] },
  { id: "hangul", name: "Hangul", group: "asian", ranges: [r(0x3131, 0x318e), r(0xac00, 0xafff)] },
  { id: "han", name: "Han (Chinese)", group: "asian", ranges: [r(0x4e00, 0x5fff)] },
  { id: "kanbun", name: "CJK symbols", group: "asian", ranges: [r(0x3000, 0x303f), r(0x3190, 0x319f)] },
  { id: "yi", name: "Yi", group: "asian", ranges: [r(0xa000, 0xa0ff)] },
  { id: "cherokee", name: "Cherokee", group: "historic", ranges: [r(0x13a0, 0x13f4)] },
  { id: "canadian", name: "Canadian Aboriginal", group: "historic", ranges: [r(0x1400, 0x14ff)] },

  // ---- african ----
  { id: "ethiopic", name: "Ethiopic", group: "african", ranges: [r(0x1200, 0x1248), r(0x124a, 0x125d)] },
  { id: "tifinagh", name: "Tifinagh", group: "african", ranges: [r(0x2d30, 0x2d67)] },
  { id: "vai", name: "Vai", group: "african", ranges: [r(0xa500, 0xa5ff)] },
  { id: "nko", name: "N'Ko", group: "african", ranges: [r(0x7c0, 0x7e7)] },

  // ---- symbols ----
  { id: "math", name: "Mathematical", group: "symbol", ranges: [r(0x2200, 0x22ff), r(0x27c0, 0x27ef)] },
  { id: "arrows", name: "Arrows", group: "symbol", ranges: [r(0x2190, 0x21ff), r(0x2794, 0x27be)] },
  { id: "dingbats", name: "Dingbats", group: "symbol", ranges: [r(0x2701, 0x2775)] },
  { id: "currency", name: "Currency", group: "symbol", ranges: [r(0x20a0, 0x20bf)] },
  { id: "punctuation", name: "Punctuation", group: "symbol", ranges: [r(0x2010, 0x205e)] },
  { id: "musical", name: "Musical", group: "symbol", ranges: [r(0x2669, 0x266f)] },
];

/** A curated ramp: the classic dense-to-sparse ASCII gradient. */
export const DENSE_RAMP = "@%#*+=-:. ";

export const SCRIPTS_BY_ID = new Map(SCRIPTS.map((s) => [s.id, s]));

/**
 * Expands a selection into codepoints.
 *
 * `all` unions every script above. That is roughly 12 000 codepoints before
 * filtering, which the builder then reduces to what the font draws and what is
 * visually distinct - the cap is applied there, not here, because how many
 * survive depends entirely on the font.
 */
export function codepointsFor(selection: string): number[] {
  if (selection === "all") {
    const seen = new Set<number>();
    for (const script of SCRIPTS) {
      for (const range of script.ranges) {
        for (let cp = range.from; cp <= range.to; cp++) seen.add(cp);
      }
    }
    return [...seen].sort((a, b) => a - b);
  }
  if (selection === "ascii-dense") return [...DENSE_RAMP].map((ch) => ch.codePointAt(0)!);
  const script = SCRIPTS_BY_ID.get(selection);
  if (!script) return [...DENSE_RAMP].map((ch) => ch.codePointAt(0)!);
  const out: number[] = [];
  for (const range of script.ranges) {
    for (let cp = range.from; cp <= range.to; cp++) out.push(cp);
  }
  return out;
}

/** Characters typed by the user, de-duplicated, order preserved. */
export function codepointsFromText(text: string): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    // Control characters have no shape; a space is legitimate and kept.
    if (cp === undefined || cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) continue;
    if (seen.has(cp)) continue;
    seen.add(cp);
    out.push(cp);
  }
  return out;
}
