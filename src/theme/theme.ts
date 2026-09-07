import {
  argbFromHex,
  hexFromArgb,
  QuantizerCelebi,
  Score,
  themeFromSourceColor,
  type Theme,
} from "@material/material-color-utilities";

export type Mode = "light" | "dark";

/**
 * The M3 colour roles we surface as CSS custom properties. Names match the
 * spec's `md-sys-color-*` convention so component CSS reads like the docs.
 */
const ROLE_KEYS = [
  "primary", "onPrimary", "primaryContainer", "onPrimaryContainer",
  "secondary", "onSecondary", "secondaryContainer", "onSecondaryContainer",
  "tertiary", "onTertiary", "tertiaryContainer", "onTertiaryContainer",
  "error", "onError", "errorContainer", "onErrorContainer",
  "background", "onBackground",
  "surface", "onSurface", "surfaceVariant", "onSurfaceVariant",
  "outline", "outlineVariant", "shadow", "scrim",
  "inverseSurface", "inverseOnSurface", "inversePrimary",
] as const;

function kebab(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/**
 * M3 defines five tonal "surface container" levels used for layering panels.
 * material-color-utilities exposes the neutral palette, so we derive them at
 * the tones the spec prescribes for each mode.
 */
function surfaceContainers(theme: Theme, mode: Mode): Record<string, string> {
  const neutral = theme.palettes.neutral;
  const tones =
    mode === "dark"
      ? { lowest: 4, low: 10, base: 12, high: 17, highest: 22, dim: 6, bright: 24 }
      : { lowest: 100, low: 96, base: 94, high: 92, highest: 90, dim: 87, bright: 98 };

  return {
    "surface-container-lowest": hexFromArgb(neutral.tone(tones.lowest)),
    "surface-container-low": hexFromArgb(neutral.tone(tones.low)),
    "surface-container": hexFromArgb(neutral.tone(tones.base)),
    "surface-container-high": hexFromArgb(neutral.tone(tones.high)),
    "surface-container-highest": hexFromArgb(neutral.tone(tones.highest)),
    "surface-dim": hexFromArgb(neutral.tone(tones.dim)),
    "surface-bright": hexFromArgb(neutral.tone(tones.bright)),
  };
}

export interface ThemeOptions {
  /** Seed colour the whole tonal system is generated from. */
  seed: string;
  mode: Mode;
}

export function applyTheme({ seed, mode }: ThemeOptions): void {
  const theme = themeFromSourceColor(argbFromHex(seed));
  const scheme = mode === "dark" ? theme.schemes.dark : theme.schemes.light;
  const root = document.documentElement;

  for (const key of ROLE_KEYS) {
    const argb = (scheme as unknown as Record<string, number>)[key];
    if (typeof argb === "number") {
      root.style.setProperty(`--md-sys-color-${kebab(key)}`, hexFromArgb(argb));
    }
  }

  for (const [name, value] of Object.entries(surfaceContainers(theme, mode))) {
    root.style.setProperty(`--md-sys-color-${name}`, value);
  }

  root.style.colorScheme = mode;
  root.dataset.theme = mode;
}

export const SEED_PRESETS: Array<{ name: string; seed: string }> = [
  { name: "Violet", seed: "#6750A4" },
  { name: "Ocean", seed: "#00639B" },
  { name: "Forest", seed: "#3F6A3F" },
  { name: "Ember", seed: "#9C4234" },
  { name: "Plum", seed: "#8B418F" },
  { name: "Slate", seed: "#4A6267" },
];

/** Accent source: a fixed preset, or one extracted from the loaded image. */
export type ThemeSource = "preset" | "dynamic" | "matugen";

export const DEFAULT_SEED = SEED_PRESETS[0].seed;

/**
 * Derives a Material You seed colour from the loaded image.
 *
 * This is the same pipeline the spec uses for dynamic colour: quantise to a
 * small set of representative colours, then score them for suitability as a
 * theme source (Score rejects colours too grey or too close to each other).
 * Pixels are sampled on a stride - a full 16 MP scan costs far more than it
 * improves the result, and quantisation is stable under sampling.
 */
export function seedFromImageData(image: ImageData): string | null {
  const { data, width, height } = image;
  const target = 48_000;
  const stride = Math.max(1, Math.floor(Math.sqrt((width * height) / target)));

  const pixels: number[] = [];
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const i = (y * width + x) * 4;
      // Skip near-transparent pixels; they would drag the theme toward black.
      if (data[i + 3] < 200) continue;
      pixels.push((255 << 24) | (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    }
  }
  if (pixels.length === 0) return null;

  const ranked = Score.score(QuantizerCelebi.quantize(pixels, 96));
  return ranked.length > 0 ? hexFromArgb(ranked[0]) : null;
}

export function applyMatugenTheme(colors: Record<string, string>, mode: Mode): void {
  const root = document.documentElement;

  for (const [key, value] of Object.entries(colors)) {
    const varName = (ROLE_KEYS as readonly string[]).includes(key) ? kebab(key) : key;
    root.style.setProperty(`--md-sys-color-${varName}`, value);
  }

  root.style.colorScheme = mode;
  root.dataset.theme = mode;
}
