export type RGB = [number, number, number];

export interface Palette {
  name: string;
  colors: string[];
}

export type AlgorithmId =
  // threshold
  | "threshold"
  | "random"
  | "riemersma"
  // ordered
  | "bayer"
  | "halftone"
  | "cluster-diagonal"
  | "blue-noise"
  | "ign"
  | "halftone-line"
  | "diagonal-line"
  | "checker"
  // error diffusion
  | "atkinson"
  | "floyd-steinberg"
  | "false-floyd-steinberg"
  | "jarvis-judice-ninke"
  | "stucki"
  | "burkes"
  | "sierra"
  | "sierra-two-row"
  | "sierra-lite"
  | "stevenson-arce"
  | "fan"
  | "shiau-fan"
  | "shiau-fan-2"
  | "pigeon"
  | "simple-2d"
  | "ostromoukhov"
  // experimental
  | "dot-diffusion"
  | "omino";

export type AlgorithmFamily = "ordered" | "error-diffusion" | "threshold" | "experimental";

export interface AlgorithmMeta {
  id: AlgorithmId;
  name: string;
  family: AlgorithmFamily;
  /** Short description surfaced in the UI. */
  blurb: string;
  /** Setting keys this algorithm actually reads, used to build its controls. */
  params: ParamKey[];
}

export type ParamKey =
  | "strength"
  | "serpentine"
  | "jitter"
  | "errorClamp"
  | "bayerSize"
  | "threshold"
  | "noiseAmount"
  | "cellSize"
  | "screenAngle"
  | "noiseScale"
  | "riemersmaQueue"
  | "riemersmaDecay"
  | "dotClassSize"
  | "omino";

/**
 * One colour in the palette stack.
 *
 * Layers are ordered: `level` places a colour on the tonal range, 0 being deep
 * shadow and 1 being highlight. Reordering the stack rewrites levels, which is
 * what lets a colour be aimed at midtones rather than wherever its RGB distance
 * happens to land it.
 */
export interface PaletteLayer {
  id: string;
  hex: string;
  /** Tonal position, 0 (shadows) .. 1 (highlights). */
  level: number;
  /** Relative weight. Omino reads it as stripe width; matching reads it as bias. */
  width: number;
  enabled: boolean;
}

/**
 * How a source pixel is matched to a palette layer.
 * - `rgb`    - plain euclidean distance in sRGB.
 * - `luma`   - distance weighted toward perceived brightness.
 * - `oklab`  - perceptually uniform; the best default for photographic work.
 * - `tonal`  - ignores hue entirely and picks purely by the layer's `level`,
 *              so the stack order decides which colour covers which tones.
 */
export type MatchMode = "rgb" | "luma" | "oklab" | "tonal";

export type OminoDirection = "right" | "left" | "down" | "up";

export interface Settings {
  algorithm: AlgorithmId;
  layers: PaletteLayer[];
  matchMode: MatchMode;
  /**
   * How much a layer's place in the stack overrides plain nearest-colour
   * matching, 0..1. At 0 the arrangement is decorative and the same two colours
   * land on the same pixels however they are stacked; turning it up makes a
   * colour parked in the shadows actually claim the dark end of the image.
   */
  tonalBias: number;

  // --- error diffusion ---
  /** Scales how much error propagates, 0..2. Above 1 exaggerates. */
  strength: number;
  serpentine: boolean;
  /** Randomises the diffused error, 0..1, to break up structured artefacts. */
  jitter: number;
  /** Clamps accumulated error, 0..255. Lower tames runaway smearing. */
  errorClamp: number;

  // --- ordered ---
  /** Bayer matrix order: 2, 4, 8, 16 or 32. */
  bayerSize: number;
  /** Halftone / line screen cell size in pixels. */
  cellSize: number;
  /** Screen angle in degrees for halftone and line screens. */
  screenAngle: number;
  /** Blue-noise / IGN tile scale. */
  noiseScale: number;

  // --- threshold ---
  /** Threshold bias, 0..255. */
  threshold: number;
  /** Random threshold spread, 0..255. */
  noiseAmount: number;

  // --- riemersma ---
  riemersmaQueue: number;
  riemersmaDecay: number;

  // --- dot diffusion ---
  dotClassSize: number;

  // --- omino ---
  ominoDirection: OminoDirection;
  /** Overall error gain. Above 1 is where it gets krunk. */
  ominoErrorStrength: number;
  /** Fraction carried forward along the march. */
  ominoAcross: number;
  /** Fraction carried sideways to the neighbouring line. */
  ominoAside: number;
  /** Starting phase in degrees; offsets each line's seed error. */
  ominoPhase: number;
  /** How many of the palette layers take part, 1..12. */
  ominoColorCount: number;

  // --- tone ---
  invert: boolean;
  grayscale: boolean;
  brightness: number; // -100..100
  contrast: number; // -100..100
  gamma: number; // 0.1..3.0
  exposure: number; // -3..3 stops
  saturation: number; // -100..100
  hueShift: number; // -180..180
  temperature: number; // -100..100
  tint: number; // -100..100

  // --- pre-process ---
  /** Gaussian blur radius applied before dithering. */
  blur: number;
  /** Unsharp amount applied before dithering. */
  sharpen: number;
  /** Downsample factor applied before dithering, 1 = native resolution. */
  pixelScale: number;
}

let layerSeq = 0;
export function makeLayer(hex: string, level: number, width = 2): PaletteLayer {
  return { id: `layer-${++layerSeq}`, hex, level, width, enabled: true };
}

/** Spreads colours evenly across the tonal range, darkest first. */
export function layersFromColors(colors: string[]): PaletteLayer[] {
  const sorted = [...colors].sort((a, b) => luminanceOf(a) - luminanceOf(b));
  const n = Math.max(1, sorted.length - 1);
  return sorted.map((hex, i) => makeLayer(hex, sorted.length === 1 ? 0.5 : i / n));
}

function luminanceOf(hex: string): number {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

export const DEFAULT_SETTINGS: Settings = {
  algorithm: "floyd-steinberg",
  layers: layersFromColors(["#000000", "#FFFFFF"]),
  matchMode: "oklab",
  tonalBias: 0.5,

  strength: 1,
  serpentine: true,
  jitter: 0,
  errorClamp: 255,

  bayerSize: 4,
  cellSize: 8,
  screenAngle: 45,
  noiseScale: 1,

  threshold: 128,
  noiseAmount: 0.5,

  riemersmaQueue: 16,
  riemersmaDecay: 0.75,

  dotClassSize: 8,

  ominoDirection: "up",
  ominoErrorStrength: 1,
  ominoAcross: 0.75,
  ominoAside: 0.25,
  ominoPhase: 0,
  ominoColorCount: 6,

  invert: false,
  grayscale: false,
  brightness: 0,
  contrast: 0,
  gamma: 1,
  exposure: 0,
  saturation: 0,
  hueShift: 0,
  temperature: 0,
  tint: 0,

  blur: 0,
  sharpen: 0,
  pixelScale: 1,
};

const DIFFUSION_PARAMS: ParamKey[] = ["strength", "serpentine", "jitter", "errorClamp"];

export const ALGORITHMS: AlgorithmMeta[] = [
  // ---------------- error diffusion ----------------
  {
    id: "floyd-steinberg",
    name: "Floyd–Steinberg",
    family: "error-diffusion",
    blurb: "The classic. Balanced detail and grain.",
    params: DIFFUSION_PARAMS,
  },
  {
    id: "false-floyd-steinberg",
    name: "False Floyd–Steinberg",
    family: "error-diffusion",
    blurb: "3-tap variant. Faster, coarser texture.",
    params: DIFFUSION_PARAMS,
  },
  {
    id: "jarvis-judice-ninke",
    name: "Jarvis–Judice–Ninke",
    family: "error-diffusion",
    blurb: "12-tap. Smooth gradients, softer edges.",
    params: DIFFUSION_PARAMS,
  },
  {
    id: "stucki",
    name: "Stucki",
    family: "error-diffusion",
    blurb: "Sharper than Jarvis with similar spread.",
    params: DIFFUSION_PARAMS,
  },
  {
    id: "burkes",
    name: "Burkes",
    family: "error-diffusion",
    blurb: "Two-row Stucki. Fast with good tonality.",
    params: DIFFUSION_PARAMS,
  },
  {
    id: "atkinson",
    name: "Atkinson",
    family: "error-diffusion",
    blurb: "Classic Mac look. Partial diffusion, high contrast.",
    params: DIFFUSION_PARAMS,
  },
  {
    id: "sierra",
    name: "Sierra",
    family: "error-diffusion",
    blurb: "Three-row diffusion. Rich midtones.",
    params: DIFFUSION_PARAMS,
  },
  {
    id: "sierra-two-row",
    name: "Sierra Two-Row",
    family: "error-diffusion",
    blurb: "Lighter Sierra. Less smearing.",
    params: DIFFUSION_PARAMS,
  },
  {
    id: "sierra-lite",
    name: "Sierra Lite",
    family: "error-diffusion",
    blurb: "Minimal 3-tap kernel. Crisp and cheap.",
    params: DIFFUSION_PARAMS,
  },
  {
    id: "stevenson-arce",
    name: "Stevenson–Arce",
    family: "error-diffusion",
    blurb: "Hexagonal 12-tap. Designed for print.",
    params: DIFFUSION_PARAMS,
  },
  {
    id: "fan",
    name: "Fan",
    family: "error-diffusion",
    blurb: "Floyd–Steinberg shifted to cut worm artefacts.",
    params: DIFFUSION_PARAMS,
  },
  {
    id: "shiau-fan",
    name: "Shiau–Fan",
    family: "error-diffusion",
    blurb: "Weighted toward the pixel ahead. Tight grain.",
    params: DIFFUSION_PARAMS,
  },
  {
    id: "shiau-fan-2",
    name: "Shiau–Fan 2",
    family: "error-diffusion",
    blurb: "Wider Shiau–Fan. Smoother in flat areas.",
    params: DIFFUSION_PARAMS,
  },
  {
    id: "pigeon",
    name: "Pigeon",
    family: "error-diffusion",
    blurb: "Sparse kernel. Clean, slightly posterised.",
    params: DIFFUSION_PARAMS,
  },
  {
    id: "simple-2d",
    name: "Simple 2D",
    family: "error-diffusion",
    blurb: "Two taps only. Strong directional texture.",
    params: DIFFUSION_PARAMS,
  },
  {
    id: "ostromoukhov",
    name: "Ostromoukhov",
    family: "error-diffusion",
    blurb: "Coefficients vary per tone. Very even grain.",
    params: DIFFUSION_PARAMS,
  },
  // ---------------- ordered ----------------
  {
    id: "bayer",
    name: "Bayer (Ordered)",
    family: "ordered",
    blurb: "Recursive threshold matrix. Clean crosshatch texture.",
    params: ["bayerSize", "threshold"],
  },
  {
    id: "halftone",
    name: "Clustered Dot",
    family: "ordered",
    blurb: "Newsprint-style clustered halftone dots.",
    params: ["cellSize", "screenAngle", "threshold"],
  },
  {
    id: "cluster-diagonal",
    name: "Diagonal Cluster",
    family: "ordered",
    blurb: "Clustered dots on a diagonal lattice.",
    params: ["cellSize", "screenAngle", "threshold"],
  },
  {
    id: "halftone-line",
    name: "Line Screen",
    family: "ordered",
    blurb: "Parallel rules that thicken with tone.",
    params: ["cellSize", "screenAngle", "threshold"],
  },
  {
    id: "diagonal-line",
    name: "Diagonal Hatch",
    family: "ordered",
    blurb: "Engraving-style diagonal hatching.",
    params: ["cellSize", "screenAngle", "threshold"],
  },
  {
    id: "checker",
    name: "Checkerboard",
    family: "ordered",
    blurb: "Two-phase checker. Harsh and graphic.",
    params: ["cellSize", "threshold"],
  },
  {
    id: "blue-noise",
    name: "Blue Noise",
    family: "ordered",
    blurb: "Void-and-cluster mask. Grain without structure.",
    params: ["noiseScale", "threshold"],
  },
  {
    id: "ign",
    name: "Interleaved Gradient",
    family: "ordered",
    blurb: "IGN from realtime rendering. Fine, even dither.",
    params: ["noiseScale", "threshold"],
  },
  // ---------------- threshold ----------------
  {
    id: "threshold",
    name: "Threshold",
    family: "threshold",
    blurb: "Hard cut at the threshold value. No dithering.",
    params: ["threshold"],
  },
  {
    id: "random",
    name: "Random Noise",
    family: "threshold",
    blurb: "Per-pixel random threshold. Grainy, film-like.",
    params: ["threshold", "noiseAmount"],
  },
  // ---------------- experimental ----------------
  {
    id: "riemersma",
    name: "Riemersma",
    family: "experimental",
    blurb: "Diffuses along a Hilbert curve. No directional bias.",
    params: ["riemersmaQueue", "riemersmaDecay"],
  },
  {
    id: "dot-diffusion",
    name: "Dot Diffusion",
    family: "experimental",
    blurb: "Knuth's class matrix. Ordered structure, diffused tone.",
    params: ["dotClassSize", "strength"],
  },
  {
    id: "omino",
    name: "Omino-like",
    family: "experimental",
    blurb: "Error diffusion applied for the worse. Marching stripes.",
    params: ["omino"],
  },
];
