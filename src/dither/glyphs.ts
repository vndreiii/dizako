/**
 * Glyph rasterisation for text mode.
 *
 * The engine has no fonts, so this is where type becomes pixels: each selected
 * character is drawn into a `cellWidth * cellHeight` coverage bitmap, and the
 * resulting atlas is shipped to the engine once per (characters, font, cell)
 * change rather than per render.
 *
 * Two filters matter more than anything else here.
 *
 * **Tofu.** A font asked for a character it does not have draws the missing-
 * glyph box, and every such character produces the *same* box. Without
 * filtering, picking "all scripts" under a Latin-only font yields an atlas of
 * a thousand identical rectangles and an image made entirely of one shape.
 * Each glyph is therefore compared against a known-absent codepoint's
 * rendering and dropped if it matches.
 *
 * **Duplicates.** Even within a font, many characters are visually identical at
 * a 10x16 cell. Keeping both wastes atlas space and biases the shape matcher
 * toward whatever is over-represented, so glyphs are de-duplicated on their
 * quantised coverage signature.
 */

export interface GlyphAtlas {
  /** `count * cellWidth * cellHeight` bytes of ink coverage. */
  bitmaps: Uint8Array;
  count: number;
  cellWidth: number;
  cellHeight: number;
  /** The characters that survived filtering, in atlas order. */
  chars: string[];
  /** How many candidates were asked for, for honest reporting. */
  requested: number;
  /** Dropped because the font had no glyph. */
  missing: number;
  /** Dropped as visually identical to one already kept. */
  duplicates: number;
}

export interface GlyphRequest {
  codepoints: number[];
  cellWidth: number;
  cellHeight: number;
  /** CSS font family list. */
  fontFamily: string;
  /** 100..900. */
  fontWeight: number;
  /** Fraction of the cell height used for the type size, 0.6..1.4. */
  fontScale: number;
  /** Upper bound on atlas size; the densest spread is kept. */
  maxGlyphs: number;
}

/** Atlas beyond which shape matching stops being interactive. */
export const MAX_GLYPHS = 512;

/**
 * Families worth offering: monospace first, since cells are a grid.
 *
 * `auto` is the default and exists because CSS falls back **per character**.
 * A single-script font silently reduces "everything the font can draw" to
 * whatever that font happens to cover - pick Roboto Mono and every CJK, Arabic
 * and Devanagari candidate is dropped as missing, leaving Latin. Chaining the
 * Noto families lets each character be drawn by whichever font actually has
 * it, which is what makes the full repertoire reachable without the user
 * having to know which font covers which script.
 */
export const FONT_FAMILIES = [
  {
    id: "auto",
    name: "Auto — broadest coverage",
    css: '"Noto Sans Mono", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Noto Sans CJK KR", "Noto Sans Arabic", "Noto Sans Hebrew", "Noto Sans Devanagari", "Noto Sans Bengali", "Noto Sans Tamil", "Noto Sans Thai", "Noto Sans Ethiopic", "Noto Sans Armenian", "Noto Sans Georgian", "Noto Sans Cherokee", "Noto Sans Vai", "Noto Sans Tifinagh", "DejaVu Sans", "Symbola", sans-serif',
  },
  { id: "mono", name: "Roboto Mono", css: '"Roboto Mono", ui-monospace, monospace' },
  { id: "system-mono", name: "System monospace", css: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
  { id: "courier", name: "Courier", css: '"Courier New", Courier, monospace' },
  { id: "dejavu-mono", name: "DejaVu Sans Mono", css: '"DejaVu Sans Mono", monospace' },
  { id: "liberation-mono", name: "Liberation Mono", css: '"Liberation Mono", monospace' },
  { id: "noto-mono", name: "Noto Sans Mono", css: '"Noto Sans Mono", monospace' },
  { id: "sans", name: "Roboto Flex", css: '"Roboto Flex", system-ui, sans-serif' },
  { id: "system-sans", name: "System sans", css: "system-ui, -apple-system, sans-serif" },
  { id: "serif", name: "Serif", css: "Georgia, 'Times New Roman', serif" },
  { id: "noto-cjk", name: "Noto CJK", css: '"Noto Sans CJK SC", "Noto Sans CJK JP", sans-serif' },
  { id: "noto-arabic", name: "Noto Arabic", css: '"Noto Sans Arabic", "Noto Naskh Arabic", sans-serif' },
  { id: "noto-devanagari", name: "Noto Devanagari", css: '"Noto Sans Devanagari", sans-serif' },
] as const;

export type FontFamilyId = (typeof FONT_FAMILIES)[number]["id"];

export function fontCss(id: string, custom: string): string {
  if (id === "custom") return custom.trim() || "monospace";
  return FONT_FAMILIES.find((f) => f.id === id)?.css ?? "monospace";
}

/** A codepoint no font assigns, used to learn what "missing" looks like. */
const TOFU_PROBE = 0x10fffd;

function signatureOf(cov: Uint8Array): string {
  // Quantise hard: two glyphs that differ only in antialiasing are the same
  // glyph as far as a cell-sized match is concerned.
  let out = "";
  for (let i = 0; i < cov.length; i++) out += cov[i]! >> 6;
  return out;
}

/**
 * Rasterises the requested characters into a coverage atlas.
 *
 * Synchronous and main-thread by necessity - canvas text is the only font
 * access a web view offers - but bounded: the cost is one small fill per
 * candidate, and the result is cached by the caller against its inputs.
 */
export function buildGlyphAtlas(request: GlyphRequest): GlyphAtlas {
  const { cellWidth: cw, cellHeight: ch } = request;
  const cell = cw * ch;
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    return { bitmaps: new Uint8Array(0), count: 0, cellWidth: cw, cellHeight: ch, chars: [], requested: request.codepoints.length, missing: 0, duplicates: 0 };
  }

  const size = Math.max(4, Math.round(ch * request.fontScale));
  ctx.font = `${request.fontWeight} ${size}px ${request.fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const draw = (text: string): Uint8Array => {
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = "#fff";
    ctx.fillText(text, cw / 2, ch / 2);
    const px = ctx.getImageData(0, 0, cw, ch).data;
    const cov = new Uint8Array(cell);
    // The glyph is drawn white on transparent, so alpha *is* the coverage.
    for (let i = 0; i < cell; i++) cov[i] = px[i * 4 + 3]!;
    return cov;
  };

  const tofu = signatureOf(draw(String.fromCodePoint(TOFU_PROBE)));

  const kept: Array<{ cov: Uint8Array; ink: number; char: string }> = [];
  const seen = new Set<string>();
  let missing = 0;
  let duplicates = 0;

  for (const cp of request.codepoints) {
    let char: string;
    try {
      char = String.fromCodePoint(cp);
    } catch {
      continue;
    }
    const cov = draw(char);
    const signature = signatureOf(cov);

    if (signature === tofu) {
      missing++;
      continue;
    }
    if (seen.has(signature)) {
      duplicates++;
      continue;
    }
    seen.add(signature);

    let sum = 0;
    for (let i = 0; i < cell; i++) sum += cov[i]!;
    kept.push({ cov, ink: sum / (cell * 255), char });
  }

  // A space is what renders the lightest tones; if the selection had none that
  // survived, the ramp cannot reach paper-white and everything looks muddy.
  if (!kept.some((g) => g.ink < 0.005)) {
    kept.push({ cov: new Uint8Array(cell), ink: 0, char: " " });
  }

  kept.sort((a, b) => a.ink - b.ink);

  // Over the cap, keep an even spread across the ink range rather than the
  // first N: the atlas has to span paper to solid or the image loses its
  // tonal range.
  const limit = Math.max(2, Math.min(request.maxGlyphs, MAX_GLYPHS));
  const chosen =
    kept.length <= limit
      ? kept
      : Array.from({ length: limit }, (_, i) => kept[Math.round((i * (kept.length - 1)) / (limit - 1))]!);

  const bitmaps = new Uint8Array(chosen.length * cell);
  chosen.forEach((g, i) => bitmaps.set(g.cov, i * cell));

  canvas.width = 0;
  canvas.height = 0;

  return {
    bitmaps,
    count: chosen.length,
    cellWidth: cw,
    cellHeight: ch,
    chars: chosen.map((g) => g.char),
    requested: request.codepoints.length,
    missing,
    duplicates,
  };
}

/** Cache key covering everything that changes the rasterisation. */
export function atlasKey(request: GlyphRequest): string {
  return [
    request.cellWidth,
    request.cellHeight,
    request.fontFamily,
    request.fontWeight,
    request.fontScale.toFixed(2),
    request.maxGlyphs,
    request.codepoints.length,
    // Endpoints plus length identify a range selection cheaply; a custom set
    // is short enough to hash in full.
    request.codepoints.length > 64
      ? `${request.codepoints[0]}-${request.codepoints[request.codepoints.length - 1]}`
      : request.codepoints.join(","),
  ].join("|");
}
