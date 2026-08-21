import type { MatchMode, PaletteLayer, Settings } from "./types";
import { hexToRgb, luma, rgbToHex, rgbToOklab } from "./color";
import { powShared, sinCosDeg, sinRad } from "./sharedmath";
import {
  blueNoise,
  cachedBayer,
  checkerMask,
  clusteredDot,
  diagonalCluster,
  diagonalHatch,
  ign,
  lineScreen,
} from "./masks";

export { hexToRgb, rgbToHex };

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/* ------------------------------------------------------------------ */
/* Palette                                                             */
/* ------------------------------------------------------------------ */

/**
 * A palette compiled from the layer stack.
 *
 * Layers carry more than a colour: `level` is the tonal position the layer is
 * meant to occupy (0 shadows, 1 highlights) and `width` is how much of the
 * image it should claim. Both are precomputed here into the forms the matchers
 * want, so the inner loop only ever touches flat typed arrays.
 */
interface Palette {
  n: number;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  /** OKLab triples, 3 per entry. */
  lab: Float32Array;
  /** Perceived luminance, 0..255. */
  y: Float32Array;
  width: Float32Array;
  /**
   * Distance multiplier. A fat layer scores every candidate colour as if it
   * were closer than it is, so it wins more pixels and forms broad runs.
   */
  pull: Float32Array;
  /** Tonal band each layer owns, in 0..1, in `order` sequence. */
  bandEdge: Float32Array;
  /** Centre of that band, per layer index, in 0..1. */
  tone: Float32Array;
  /**
   * How strongly a layer's place in the stack pulls it toward pixels of the
   * matching brightness. 0 leaves the matchers as pure nearest-colour lookups.
   */
  bias: number;
  /** Layer indices sorted by tonal level. */
  order: Int32Array;
  hex: string[];
}

const FALLBACK: PaletteLayer[] = [
  { id: "k", hex: "#000000", level: 0, width: 2, enabled: true },
  { id: "w", hex: "#ffffff", level: 1, width: 2, enabled: true },
];

/**
 * Compiled palettes are pure functions of `(layers, limit, bias)` and are hit
 * once per render job - including every slider tick of a drag. Palette edits
 * are the common case during tuning, so the compile work (OKLab conversions,
 * band edges, sorts) is memoised on a cheap serialisation of the inputs.
 */
const paletteCache = new Map<string, Palette>();

export function compilePalette(layers: PaletteLayer[], limit = Infinity, bias = 0): Palette {
  const key = `${limit}|${bias}|${JSON.stringify(layers)}`;
  const hit = paletteCache.get(key);
  if (hit) return hit;

  let live = layers.filter((l) => l.enabled);
  if (live.length === 0) live = FALLBACK;
  if (live.length > limit) live = live.slice(0, Math.max(1, Math.floor(limit)));

  const n = live.length;
  const p: Palette = {
    n,
    r: new Float32Array(n),
    g: new Float32Array(n),
    b: new Float32Array(n),
    lab: new Float32Array(n * 3),
    y: new Float32Array(n),
    width: new Float32Array(n),
    pull: new Float32Array(n),
    bandEdge: new Float32Array(n),
    tone: new Float32Array(n),
    order: new Int32Array(n),
    bias,
    hex: live.map((l) => l.hex),
  };

  for (let i = 0; i < n; i++) {
    const [r, g, b] = hexToRgb(live[i].hex);
    p.r[i] = r;
    p.g[i] = g;
    p.b[i] = b;
    const [L, A, B] = rgbToOklab(r, g, b);
    p.lab[i * 3] = L;
    p.lab[i * 3 + 1] = A;
    p.lab[i * 3 + 2] = B;
    p.y[i] = luma(r, g, b);
    const w = Math.max(0.05, live[i].width);
    p.width[i] = w;
    // width 2 is neutral; wider pulls scores down, narrower pushes them up.
    p.pull[i] = 2 / (1 + w);
    p.order[i] = i;
  }

  // Tonal bands: sort by level, then hand each layer a slice of 0..1 sized by
  // its width. This is what makes "move a layer up" actually recolour the
  // highlights rather than just reorder a list.
  const idx = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => live[a].level - live[b].level || p.y[a] - p.y[b],
  );
  let total = 0;
  for (const i of idx) total += p.width[i];
  let acc = 0;
  for (let k = 0; k < n; k++) {
    const i = idx[k];
    p.order[k] = i;
    const lo = acc;
    acc += p.width[i] / total;
    p.bandEdge[k] = acc;
    p.tone[i] = (lo + acc) / 2;
  }
  p.bandEdge[n - 1] = 1;
  if (paletteCache.size > 64) paletteCache.clear();
  paletteCache.set(key, p);
  return p;
}

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */

/**
 * Penalty for using a layer on a pixel whose brightness sits far from the band
 * the layer occupies in the stack.
 *
 * Without this, nearest-colour matching ignores the stack order entirely: the
 * same two colours land on the same pixels however they are arranged, and the
 * reorder arrows appear broken. `scale` puts the penalty in the same units as
 * whichever distance it is being added to.
 */
function tonalPenalty(p: Palette, i: number, yn: number, scale: number): number {
  const dt = yn - p.tone[i];
  return p.bias * dt * dt * scale;
}

function matchRgb(p: Palette, r: number, g: number, b: number): number {
  const yn = p.bias === 0 ? 0 : luma(r, g, b) / 255;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < p.n; i++) {
    const dr = r - p.r[i];
    const dg = g - p.g[i];
    const db = b - p.b[i];
    let d = (0.299 * dr * dr + 0.587 * dg * dg + 0.114 * db * db) * p.pull[i];
    if (p.bias !== 0) d += tonalPenalty(p, i, yn, 65025);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function matchLuma(p: Palette, r: number, g: number, b: number): number {
  const y = luma(r, g, b);
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < p.n; i++) {
    let d = Math.abs(y - p.y[i]) * p.pull[i];
    if (p.bias !== 0) d += tonalPenalty(p, i, y / 255, 255);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function matchOklab(p: Palette, r: number, g: number, b: number): number {
  const [L, A, B] = rgbToOklab(r, g, b);
  const yn = p.bias === 0 ? 0 : luma(r, g, b) / 255;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < p.n; i++) {
    const dL = L - p.lab[i * 3];
    const dA = A - p.lab[i * 3 + 1];
    const dB = B - p.lab[i * 3 + 2];
    let d = (dL * dL + dA * dA + dB * dB) * p.pull[i];
    if (p.bias !== 0) d += tonalPenalty(p, i, yn, 1);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Straight tonal-band lookup: brightness decides the layer, nothing else. */
function matchTonal(p: Palette, r: number, g: number, b: number): number {
  const t = luma(r, g, b) / 255;
  for (let k = 0; k < p.n; k++) if (t <= p.bandEdge[k]) return p.order[k];
  return p.order[p.n - 1];
}

type Matcher = (p: Palette, r: number, g: number, b: number) => number;

function matcherFor(mode: MatchMode): Matcher {
  switch (mode) {
    case "luma":
      return matchLuma;
    case "oklab":
      return matchOklab;
    case "tonal":
      return matchTonal;
    default:
      return matchRgb;
  }
}

/* ------------------------------------------------------------------ */
/* Tone and pre-processing                                             */
/* ------------------------------------------------------------------ */

/**
 * Builds the per-channel transfer curve.
 *
 * Exposure, brightness, contrast and gamma are all scalar functions of a single
 * channel value, so they collapse into one 256-entry lookup no matter how many
 * of them are in play.
 */
function toneCurve(s: Settings): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  const gain = powShared(2, s.exposure);
  const bright = s.brightness * 2.55;
  const c = Math.max(-255, Math.min(255, s.contrast * 2.55));
  const cf = (259 * (c + 255)) / (255 * (259 - c));
  const invGamma = 1 / Math.max(0.01, s.gamma);
  for (let i = 0; i < 256; i++) {
    let v = i * gain + bright;
    v = cf * (v - 128) + 128;
    v = powShared(Math.max(0, v) / 255, invGamma) * 255;
    lut[i] = clamp255(v);
  }
  return lut;
}

/** Separable box blur run three times, which converges on a gaussian. */
function boxBlur(buf: Float32Array, w: number, h: number, radius: number) {
  const r = Math.max(1, Math.round(radius));
  const tmp = new Float32Array(buf.length);
  const passes = 3;
  let from: Float32Array = buf;
  let to: Float32Array = tmp;
  for (let pass = 0; pass < passes; pass++) {
    // Horizontal.
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let ch = 0; ch < 3; ch++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += from[(row + Math.min(w - 1, Math.max(0, k))) * 3 + ch];
        for (let x = 0; x < w; x++) {
          to[(row + x) * 3 + ch] = sum / (2 * r + 1);
          const out = Math.min(w - 1, Math.max(0, x - r));
          const inn = Math.min(w - 1, Math.max(0, x + r + 1));
          sum += from[(row + inn) * 3 + ch] - from[(row + out) * 3 + ch];
        }
      }
    }
    [from, to] = [to, from];
    // Vertical.
    for (let x = 0; x < w; x++) {
      for (let ch = 0; ch < 3; ch++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += from[(Math.min(h - 1, Math.max(0, k)) * w + x) * 3 + ch];
        for (let y = 0; y < h; y++) {
          to[(y * w + x) * 3 + ch] = sum / (2 * r + 1);
          const out = Math.min(h - 1, Math.max(0, y - r));
          const inn = Math.min(h - 1, Math.max(0, y + r + 1));
          sum += from[(inn * w + x) * 3 + ch] - from[(out * w + x) * 3 + ch];
        }
      }
    }
    [from, to] = [to, from];
  }
  if (from !== buf) buf.set(from);
}

/** Rotates hue in place using the standard luma-preserving RGB rotation. */
function hueMatrix(deg: number): number[] {
  // Shared deterministic sincos: library cos/sin differ per engine in the
  // last ulp and the matrix feeds every pixel of a graded frame.
  const [s, c] = sinCosDeg(deg);
  const lr = 0.213;
  const lg = 0.715;
  const lb = 0.072;
  return [
    lr + c * (1 - lr) - s * lr,
    lg - c * lg - s * lg,
    lb - c * lb + s * (1 - lb),
    lr - c * lr + s * 0.143,
    lg + c * (1 - lg) + s * 0.14,
    lb - c * lb - s * 0.283,
    lr - c * lr - s * (1 - lr),
    lg - c * lg + s * lg,
    lb + c * (1 - lb) + s * lb,
  ];
}

/**
 * Decodes the source into a float working buffer and applies everything that
 * happens before the dither itself: grading, then filtering.
 *
 * The result depends only on the source pixels and the tone/filter subset of
 * settings, so it is memoised on exactly that. Palette or dither-parameter
 * edits then skip grading entirely - which is the dominant cost whenever blur
 * or sharpen is engaged. Cached buffers are shared between jobs and must stay
 * read-only; every pass treats `src` as input-only (error planes are private).
 */
const prepareIds = new WeakMap<object, number>();
let prepareNextId = 1;
const prepareCache = new Map<string, Float32Array>();

function prepareKey(image: ImageData, s: Settings): string {
  let id = prepareIds.get(image);
  if (id === undefined) {
    id = ++prepareNextId;
    prepareIds.set(image, id);
  }
  return [
    id,
    image.width,
    image.height,
    s.brightness,
    s.contrast,
    s.gamma,
    s.exposure,
    s.saturation,
    s.hueShift,
    s.temperature,
    s.tint,
    s.grayscale ? 1 : 0,
    s.invert ? 1 : 0,
    s.blur,
    s.sharpen,
  ].join("|");
}

export function prepare(image: ImageData, s: Settings): Float32Array {
  const key = prepareKey(image, s);
  const hit = prepareCache.get(key);
  if (hit) return hit;

  const { width: w, height: h, data } = image;
  const buf = new Float32Array(w * h * 3);
  const lut = toneCurve(s);

  const hm = s.hueShift !== 0 ? hueMatrix(s.hueShift) : null;
  const temp = s.temperature * 0.6;
  const tint = s.tint * 0.5;
  const sat = 1 + s.saturation / 100;

  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    let r = lut[data[i]];
    let g = lut[data[i + 1]];
    let b = lut[data[i + 2]];

    if (temp !== 0) {
      r += temp;
      b -= temp;
    }
    if (tint !== 0) {
      g += tint;
      r -= tint * 0.5;
      b -= tint * 0.5;
    }
    if (hm) {
      const nr = r * hm[0] + g * hm[1] + b * hm[2];
      const ng = r * hm[3] + g * hm[4] + b * hm[5];
      const nb = r * hm[6] + g * hm[7] + b * hm[8];
      r = nr;
      g = ng;
      b = nb;
    }
    if (sat !== 1) {
      const y = luma(r, g, b);
      r = y + (r - y) * sat;
      g = y + (g - y) * sat;
      b = y + (b - y) * sat;
    }
    if (s.grayscale) {
      const y = luma(r, g, b);
      r = g = b = y;
    }
    if (s.invert) {
      r = 255 - r;
      g = 255 - g;
      b = 255 - b;
    }

    buf[j] = clamp255(r);
    buf[j + 1] = clamp255(g);
    buf[j + 2] = clamp255(b);
  }

  if (s.blur > 0) boxBlur(buf, w, h, s.blur);
  if (s.sharpen > 0) {
    // Unsharp mask: the difference against a blurred copy, added back.
    const soft = Float32Array.from(buf);
    boxBlur(soft, w, h, 1 + s.sharpen);
    const amount = s.sharpen;
    for (let i = 0; i < buf.length; i++) {
      buf[i] = clamp255(buf[i] + (buf[i] - soft[i]) * amount);
    }
  }

  if (prepareCache.size > 8) prepareCache.clear();
  prepareCache.set(key, buf);
  return buf;
}

/* ------------------------------------------------------------------ */
/* Kernels                                                             */
/* ------------------------------------------------------------------ */

type Tap = [number, number, number];
interface Kernel {
  taps: Tap[];
  /** Explicit when the kernel deliberately discards energy (Atkinson). */
  divisor?: number;
}

const KERNELS: Record<string, Kernel> = {
  "floyd-steinberg": {
    taps: [
      [1, 0, 7],
      [-1, 1, 3],
      [0, 1, 5],
      [1, 1, 1],
    ],
  },
  "false-floyd-steinberg": {
    taps: [
      [1, 0, 3],
      [0, 1, 3],
      [1, 1, 2],
    ],
  },
  "jarvis-judice-ninke": {
    taps: [
      [1, 0, 7],
      [2, 0, 5],
      [-2, 1, 3],
      [-1, 1, 5],
      [0, 1, 7],
      [1, 1, 5],
      [2, 1, 3],
      [-2, 2, 1],
      [-1, 2, 3],
      [0, 2, 5],
      [1, 2, 3],
      [2, 2, 1],
    ],
  },
  stucki: {
    taps: [
      [1, 0, 8],
      [2, 0, 4],
      [-2, 1, 2],
      [-1, 1, 4],
      [0, 1, 8],
      [1, 1, 4],
      [2, 1, 2],
      [-2, 2, 1],
      [-1, 2, 2],
      [0, 2, 4],
      [1, 2, 2],
      [2, 2, 1],
    ],
  },
  burkes: {
    taps: [
      [1, 0, 8],
      [2, 0, 4],
      [-2, 1, 2],
      [-1, 1, 4],
      [0, 1, 8],
      [1, 1, 4],
      [2, 1, 2],
    ],
  },
  sierra: {
    taps: [
      [1, 0, 5],
      [2, 0, 3],
      [-2, 1, 2],
      [-1, 1, 4],
      [0, 1, 5],
      [1, 1, 4],
      [2, 1, 2],
      [-1, 2, 2],
      [0, 2, 3],
      [1, 2, 2],
    ],
  },
  "sierra-two-row": {
    taps: [
      [1, 0, 4],
      [2, 0, 3],
      [-2, 1, 1],
      [-1, 1, 2],
      [0, 1, 3],
      [1, 1, 2],
      [2, 1, 1],
    ],
  },
  "sierra-lite": {
    taps: [
      [1, 0, 2],
      [-1, 1, 1],
      [0, 1, 1],
    ],
  },
  "stevenson-arce": {
    taps: [
      [2, 0, 32],
      [-3, 1, 12],
      [-1, 1, 26],
      [1, 1, 30],
      [3, 1, 16],
      [-2, 2, 12],
      [0, 2, 26],
      [2, 2, 12],
      [-3, 3, 5],
      [-1, 3, 12],
      [1, 3, 12],
      [3, 3, 5],
    ],
  },
  fan: {
    taps: [
      [1, 0, 7],
      [-2, 1, 1],
      [-1, 1, 3],
      [0, 1, 5],
    ],
  },
  "shiau-fan": {
    taps: [
      [1, 0, 4],
      [-2, 1, 1],
      [-1, 1, 1],
      [0, 1, 2],
    ],
  },
  "shiau-fan-2": {
    taps: [
      [1, 0, 8],
      [-3, 1, 1],
      [-2, 1, 1],
      [-1, 1, 2],
      [0, 1, 4],
    ],
  },
  pigeon: {
    taps: [
      [1, 0, 2],
      [2, 0, 1],
      [-1, 1, 2],
      [0, 1, 2],
      [1, 1, 2],
      [-1, 2, 1],
      [1, 2, 1],
    ],
  },
  "simple-2d": {
    taps: [
      [1, 0, 1],
      [0, 1, 1],
    ],
  },
  atkinson: {
    // Six unit taps over a divisor of eight: a quarter of the error is thrown
    // away on purpose, which is exactly where the crisp early-Mac look and the
    // blown highlights come from.
    taps: [
      [1, 0, 1],
      [2, 0, 1],
      [-1, 1, 1],
      [0, 1, 1],
      [1, 1, 1],
      [0, 2, 1],
    ],
    divisor: 8,
  },
};

function divisorOf(k: Kernel): number {
  if (k.divisor) return k.divisor;
  let sum = 0;
  for (const t of k.taps) sum += t[2];
  return sum || 1;
}

/* ------------------------------------------------------------------ */
/* Random                                                              */
/* ------------------------------------------------------------------ */

/** Small deterministic PRNG - a fixed seed keeps previews stable per setting. */
function makeRandom(seed = 0x2545f491) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Passes                                                              */
/* ------------------------------------------------------------------ */

interface Ctx {
  src: Float32Array;
  out: Uint8ClampedArray;
  alpha: Uint8ClampedArray;
  w: number;
  h: number;
  p: Palette;
  match: Matcher;
  s: Settings;
}

function put(c: Ctx, i: number, idx: number) {
  const o = i * 4;
  c.out[o] = c.p.r[idx];
  c.out[o + 1] = c.p.g[idx];
  c.out[o + 2] = c.p.b[idx];
  c.out[o + 3] = c.alpha[i];
}

/** Ordered family: perturb by a mask, then match. No error is carried. */
function orderedPass(c: Ctx, mask: (x: number, y: number) => number) {
  const { w, h, src, p, s } = c;
  const spread = (255 / Math.max(1, p.n - 1)) * s.strength;
  const bias = (s.threshold - 128) / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const j = i * 3;
      const shift = (mask(x, y) - 0.5 + bias) * spread;
      put(c, i, c.match(p, src[j] + shift, src[j + 1] + shift, src[j + 2] + shift));
    }
  }
}

function thresholdPass(c: Ctx, noise: number) {
  const { w, h, src, p, s } = c;
  const rand = makeRandom();
  const bias = (s.threshold - 128) * (255 / Math.max(1, p.n - 1)) / 128;
  for (let i = 0, j = 0; i < w * h; i++, j += 3) {
    const n = noise > 0 ? (rand() - 0.5) * noise * 255 : 0;
    put(c, i, c.match(p, src[j] + bias + n, src[j + 1] + bias + n, src[j + 2] + bias + n));
  }
}

function errorDiffusePass(c: Ctx, kernel: Kernel) {
  const { w, h, src, p, s } = c;
  const div = divisorOf(kernel);
  const strength = s.strength;
  const clampTo = s.errorClamp;
  const jitter = s.jitter;
  const rand = makeRandom();
  const err = new Float32Array(w * h * 3);

  for (let y = 0; y < h; y++) {
    const reverse = s.serpentine && y % 2 === 1;
    for (let step = 0; step < w; step++) {
      const x = reverse ? w - 1 - step : step;
      const i = y * w + x;
      const j = i * 3;

      const r = src[j] + err[j];
      const g = src[j + 1] + err[j + 1];
      const b = src[j + 2] + err[j + 2];
      const idx = c.match(p, r, g, b);
      put(c, i, idx);

      let er = (r - p.r[idx]) * strength;
      let eg = (g - p.g[idx]) * strength;
      let eb = (b - p.b[idx]) * strength;
      if (clampTo > 0) {
        er = Math.max(-clampTo, Math.min(clampTo, er));
        eg = Math.max(-clampTo, Math.min(clampTo, eg));
        eb = Math.max(-clampTo, Math.min(clampTo, eb));
      }

      for (const [dx, dy, weight] of kernel.taps) {
        // On a right-to-left row the kernel has to be mirrored, otherwise the
        // error is pushed back into pixels that are already final.
        const nx = x + (reverse ? -dx : dx);
        const ny = y + dy;
        if (nx < 0 || nx >= w || ny >= h) continue;
        let f = weight / div;
        if (jitter > 0) f *= 1 + (rand() - 0.5) * jitter;
        const nj = (ny * w + nx) * 3;
        err[nj] += er * f;
        err[nj + 1] += eg * f;
        err[nj + 2] += eb * f;
      }
    }
  }
}

/**
 * Tone-adaptive diffusion in the spirit of Ostromoukhov's variable-coefficient
 * halftoning.
 *
 * The published method drives the three Floyd–Steinberg-shaped coefficients
 * from a hand-tuned 256-entry table. This implements the same idea with a
 * smooth curve rather than that table: near black and near white the error is
 * pushed forward along the row and almost nothing goes down, which is what
 * breaks up the worm artefacts those tones are prone to; in the midtones the
 * split relaxes back toward the familiar 7/3/5/1 balance.
 */
function adaptiveDiffusePass(c: Ctx) {
  const { w, h, src, p, s } = c;
  const strength = s.strength;
  const clampTo = s.errorClamp;
  const err = new Float32Array(w * h * 3);

  for (let y = 0; y < h; y++) {
    const reverse = s.serpentine && y % 2 === 1;
    for (let step = 0; step < w; step++) {
      const x = reverse ? w - 1 - step : step;
      const i = y * w + x;
      const j = i * 3;

      const r = src[j] + err[j];
      const g = src[j + 1] + err[j + 1];
      const b = src[j + 2] + err[j + 2];
      const idx = c.match(p, r, g, b);
      put(c, i, idx);

      // Extremity: 0 in the midtones, 1 at either end of the range.
      const t = Math.min(1, Math.max(0, luma(r, g, b) / 255));
      const ext = Math.abs(t - 0.5) * 2;
      const forward = 7 + 9 * ext * ext;
      const down = 5 * (1 - ext);
      const left = 3 * (1 - ext);
      const diag = 1 * (1 - ext);
      const div = forward + down + left + diag;

      let er = (r - p.r[idx]) * strength;
      let eg = (g - p.g[idx]) * strength;
      let eb = (b - p.b[idx]) * strength;
      if (clampTo > 0) {
        er = Math.max(-clampTo, Math.min(clampTo, er));
        eg = Math.max(-clampTo, Math.min(clampTo, eg));
        eb = Math.max(-clampTo, Math.min(clampTo, eb));
      }

      const taps: Tap[] = [
        [1, 0, forward],
        [-1, 1, left],
        [0, 1, down],
        [1, 1, diag],
      ];
      for (const [dx, dy, weight] of taps) {
        if (weight <= 0) continue;
        const nx = x + (reverse ? -dx : dx);
        const ny = y + dy;
        if (nx < 0 || nx >= w || ny >= h) continue;
        const f = weight / div;
        const nj = (ny * w + nx) * 3;
        err[nj] += er * f;
        err[nj + 1] += eg * f;
        err[nj + 2] += eb * f;
      }
    }
  }
}

/* -------------------------- Riemersma ---------------------------- */

/** Hilbert index → coordinate, for a curve of side `n` (a power of two). */
function hilbertXY(n: number, d: number): [number, number] {
  let x = 0;
  let y = 0;
  let t = d;
  for (let s = 1; s < n; s *= 2) {
    const rx = 1 & (t >> 1);
    const ry = 1 & (t ^ rx);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const swap = x;
      x = y;
      y = swap;
    }
    x += s * rx;
    y += s * ry;
    t >>= 2;
  }
  return [x, y];
}

/**
 * Riemersma dithering: walks a Hilbert curve and carries a short, decaying
 * queue of past errors instead of a spatial kernel. Because the curve has no
 * preferred direction the result has none of the diagonal worming that row-wise
 * diffusion produces.
 */
const hilbertCache = new Map<number, Int32Array>();

/** Cached `x,y` pairs for the curve of side `n`; identical to live computation. */
function hilbertCurve(n: number): Int32Array | null {
  // Bound the memory: beyond this side length a pass is minutes anyway, so
  // just compute coordinates inline as before.
  if (n > 1024) return null;
  let cached = hilbertCache.get(n);
  if (!cached) {
    const total = n * n;
    cached = new Int32Array(total * 2);
    for (let d = 0; d < total; d++) {
      const [x, y] = hilbertXY(n, d);
      cached[d * 2] = x;
      cached[d * 2 + 1] = y;
    }
    hilbertCache.set(n, cached);
  }
  return cached;
}

function riemersmaPass(c: Ctx) {
  const { w, h, src, p, s } = c;
  const side = 1 << Math.ceil(Math.log2(Math.max(w, h, 2)));
  const qLen = Math.max(1, Math.round(s.riemersmaQueue));
  const decay = Math.max(0.01, Math.min(0.99, s.riemersmaDecay));

  // Exponential weights, normalised so the queue is energy-preserving.
  const weights = new Float32Array(qLen);
  let wsum = 0;
  for (let k = 0; k < qLen; k++) {
    weights[k] = powShared(decay, k);
    wsum += weights[k];
  }
  for (let k = 0; k < qLen; k++) weights[k] /= wsum;

  const qr = new Float32Array(qLen);
  const qg = new Float32Array(qLen);
  const qb = new Float32Array(qLen);
  let head = 0;

  const total = side * side;
  const curve = hilbertCurve(side);
  for (let d = 0; d < total; d++) {
    let x: number;
    let y: number;
    if (curve) {
      x = curve[d * 2];
      y = curve[d * 2 + 1];
    } else {
      [x, y] = hilbertXY(side, d);
    }
    if (x >= w || y >= h) continue;
    const i = y * w + x;
    const j = i * 3;

    let ar = 0;
    let ag = 0;
    let ab = 0;
    for (let k = 0; k < qLen; k++) {
      const slot = (head + k) % qLen;
      ar += qr[slot] * weights[k];
      ag += qg[slot] * weights[k];
      ab += qb[slot] * weights[k];
    }

    const r = src[j] + ar * s.strength;
    const g = src[j + 1] + ag * s.strength;
    const b = src[j + 2] + ab * s.strength;
    const idx = c.match(p, r, g, b);
    put(c, i, idx);

    head = (head + qLen - 1) % qLen;
    qr[head] = r - p.r[idx];
    qg[head] = g - p.g[idx];
    qb[head] = b - p.b[idx];
  }
}

/* ------------------------- Dot diffusion -------------------------- */

/**
 * Knuth's dot diffusion.
 *
 * A class matrix assigns every pixel a rank; pixels are then quantised in rank
 * order and each one's error is shared only with neighbours of a higher rank -
 * that is, ones not yet decided. The result keeps the ordered structure of a
 * halftone while still carrying tone the way diffusion does.
 */
function classMatrix(size: number): Int32Array {
  const n = size * size;
  const m = new Int32Array(n);
  // Rank cells by distance from a set of dot centres, which produces the
  // clustered growth pattern Knuth's published matrix has.
  const cells: Array<{ i: number; d: number }> = [];
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.abs(((x + 0.5) % half) - half / 2);
      const dy = Math.abs(((y + 0.5) % half) - half / 2);
      const quadrant = (Math.floor(x / half) + Math.floor(y / half) * 2) * 0.01;
      cells.push({ i: y * size + x, d: dx * dx + dy * dy + quadrant });
    }
  }
  cells.sort((a, b) => a.d - b.d || a.i - b.i);
  for (let rank = 0; rank < n; rank++) m[cells[rank].i] = rank;
  return m;
}

const classCache = new Map<number, Int32Array>();

/**
 * Per-rank pixel lists, built in the same y-major scan order the naive
 * implementation walks the image in. Diffusion is order-dependent, so keeping
 * that sequence identical makes this rewrite byte-exact while dropping the
 * cost from a full-image scan per rank to one counting pass plus O(pixels).
 */
const rankListCache = new Map<string, Int32Array[]>();

function rankListsFor(cm: Int32Array, size: number, w: number, h: number): Int32Array[] {
  const key = `${size}|${w}x${h}`;
  const hit = rankListCache.get(key);
  if (hit) return hit;

  const cells = size * size;
  const counts = new Int32Array(cells);
  for (let y = 0; y < h; y++) {
    const row = y % size;
    for (let x = 0; x < w; x++) counts[row * size + (x % size)]++;
  }
  // A rank owns every pixel whose *cell* maps to it, so its list needs the
  // summed population of those cells - not the population of cell `rank`.
  const rankTotals = new Int32Array(cells);
  for (let cIdx = 0; cIdx < cells; cIdx++) rankTotals[cm[cIdx]] += counts[cIdx];

  const lists: Int32Array[] = [];
  const cursors = new Int32Array(cells);
  for (let r = 0; r < cells; r++) lists.push(new Int32Array(rankTotals[r]));
  for (let y = 0; y < h; y++) {
    const row = y % size;
    for (let x = 0; x < w; x++) {
      const cell = row * size + (x % size);
      lists[cm[cell]][cursors[cell]++] = y * w + x;
    }
  }
  if (rankListCache.size > 8) rankListCache.clear();
  rankListCache.set(key, lists);
  return lists;
}

function dotDiffusePass(c: Ctx) {
  const { w, h, src, p, s } = c;
  const size = Math.max(2, 1 << Math.round(Math.log2(Math.max(2, s.dotClassSize))));
  let cm = classCache.get(size);
  if (!cm) {
    cm = classMatrix(size);
    classCache.set(size, cm);
  }
  const ranks = size * size;
  const err = new Float32Array(w * h * 3);
  const neighbours: Tap[] = [
    [1, 0, 2],
    [-1, 0, 2],
    [0, 1, 2],
    [0, -1, 2],
    [1, 1, 1],
    [-1, 1, 1],
    [1, -1, 1],
    [-1, -1, 1],
  ];

  const lists = rankListsFor(cm, size, w, h);
  for (let rank = 0; rank < ranks; rank++) {
    const pixels = lists[rank];
    for (let n = 0; n < pixels.length; n++) {
      const i = pixels[n];
      const j = i * 3;
      const r = src[j] + err[j];
      const g = src[j + 1] + err[j + 1];
      const b = src[j + 2] + err[j + 2];
      const idx = c.match(p, r, g, b);
      put(c, i, idx);

      const er = (r - p.r[idx]) * s.strength;
      const eg = (g - p.g[idx]) * s.strength;
      const eb = (b - p.b[idx]) * s.strength;

      // Only neighbours that are still undecided may receive error.
      const x = i % w;
      const y = (i / w) | 0;
      let div = 0;
      for (const [dx, dy, weight] of neighbours) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        if (cm[(ny % size) * size + (nx % size)] <= rank) continue;
        div += weight;
      }
      if (div === 0) continue;
      for (const [dx, dy, weight] of neighbours) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        if (cm[(ny % size) * size + (nx % size)] <= rank) continue;
        const f = weight / div;
        const nj = (ny * w + nx) * 3;
        err[nj] += er * f;
        err[nj + 1] += eg * f;
        err[nj + 2] += eb * f;
      }
    }
  }
}

/* ----------------------------- Omino ------------------------------ */

/**
 * Omino-like diffusion.
 *
 * Deliberately bad error diffusion. Instead of spreading error over a
 * two-dimensional kernel it marches in one direction along a line, carrying a
 * single running error forward and shedding a share of it sideways into the
 * next line. Nothing about that is balanced, and that is the point: the error
 * never settles, so it accumulates into long marching bands.
 *
 * The layer widths bias colour selection rather than merely weighting error, so
 * a wide layer keeps winning for long stretches and the bands come out fat. The
 * phase angle offsets each line's starting error, which bends the bands into
 * waves rather than leaving them perfectly parallel.
 */
function ominoPass(c: Ctx) {
  const { w, h, src, s } = c;
  const p = c.p;
  const dir = s.ominoDirection;
  const vertical = dir === "down" || dir === "up";
  const backwards = dir === "left" || dir === "up";

  const lines = vertical ? w : h;
  const steps = vertical ? h : w;

  const across = s.ominoAcross;
  const aside = s.ominoAside;
  const gain = s.ominoErrorStrength;
  const phase = (s.ominoPhase * Math.PI) / 180;

  let asideIn = new Float32Array(steps * 3);
  let asideOut = new Float32Array(steps * 3);

  for (let l = 0; l < lines; l++) {
    // Each line is offset around the phase wheel, which slides its bands
    // along the march relative to its neighbours and bends what would
    // otherwise be dead-straight stripes into waves.
    //
    // This has to be a standing bias applied at every step, not just a seed
    // for the first pixel: the running error is fully replaced each step, so
    // anything injected only at the start of the line is gone one pixel later
    // and the control does nothing at all.
    //
    // The half-line offset keeps 0° neutral. 180° flips alternating lines
    // against each other, and 360° puts every line back in step.
    const bias = phase === 0 ? 0 : sinRad((l + 0.5) * phase) * 110;
    let cr = 0;
    let cg = 0;
    let cb = 0;
    asideOut.fill(0);

    for (let t = 0; t < steps; t++) {
      const pos = backwards ? steps - 1 - t : t;
      const x = vertical ? l : pos;
      const y = vertical ? pos : l;
      const i = y * w + x;
      const j = i * 3;
      const aj = t * 3;

      const r = src[j] + cr + asideIn[aj] + bias;
      const g = src[j + 1] + cg + asideIn[aj + 1] + bias;
      const b = src[j + 2] + cb + asideIn[aj + 2] + bias;

      const idx = matchRgb(p, r, g, b);
      put(c, i, idx);

      // Runaway error is the whole aesthetic, but it still has to stay finite.
      const dr = Math.max(-1024, Math.min(1024, (r - p.r[idx]) * gain));
      const dg = Math.max(-1024, Math.min(1024, (g - p.g[idx]) * gain));
      const db = Math.max(-1024, Math.min(1024, (b - p.b[idx]) * gain));

      cr = dr * across;
      cg = dg * across;
      cb = db * across;
      asideOut[aj] = dr * aside;
      asideOut[aj + 1] = dg * aside;
      asideOut[aj + 2] = db * aside;
    }

    const swap = asideIn;
    asideIn = asideOut;
    asideOut = swap;
  }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export function dither(image: ImageData, s: Settings): ImageData {
  const { width: w, height: h } = image;
  const out = new Uint8ClampedArray(w * h * 4);
  const alpha = new Uint8ClampedArray(w * h);
  for (let i = 0, o = 3; i < w * h; i++, o += 4) alpha[i] = image.data[o];

  const src = prepare(image, s);
  const limit = s.algorithm === "omino" ? s.ominoColorCount : Infinity;
  const p = compilePalette(s.layers, limit, s.matchMode === "tonal" ? 0 : s.tonalBias);
  const ctx: Ctx = { src, out, alpha, w, h, p, match: matcherFor(s.matchMode), s };

  const cell = Math.max(1, s.cellSize);
  const angle = s.screenAngle;

  switch (s.algorithm) {
    case "bayer": {
      const n = Math.max(2, s.bayerSize);
      const m = cachedBayer(n);
      orderedPass(ctx, (x, y) => m[(y % n) * n + (x % n)]);
      break;
    }
    case "halftone": {
      const [sinA, cosA] = sinCosDeg(angle);
      orderedPass(ctx, (x, y) => clusteredDot(x, y, cell, cosA, sinA));
      break;
    }
    case "cluster-diagonal": {
      const [sinA, cosA] = sinCosDeg(angle);
      orderedPass(ctx, (x, y) => diagonalCluster(x, y, cell, cosA, sinA));
      break;
    }
    case "halftone-line": {
      const [sinA, cosA] = sinCosDeg(angle);
      orderedPass(ctx, (x, y) => lineScreen(x, y, cell, cosA, sinA));
      break;
    }
    case "diagonal-line": {
      const [sinA, cosA] = sinCosDeg(angle);
      const [sinB, cosB] = sinCosDeg(angle + 90);
      orderedPass(ctx, (x, y) => diagonalHatch(x, y, cell, cosA, sinA, cosB, sinB));
      break;
    }
    case "checker":
      orderedPass(ctx, (x, y) => checkerMask(x, y, cell));
      break;
    case "blue-noise": {
      const m = blueNoise(64);
      const scale = Math.max(0.1, s.noiseScale);
      orderedPass(ctx, (x, y) => {
        const sx = Math.floor(x / scale) & 63;
        const sy = Math.floor(y / scale) & 63;
        return m[sy * 64 + sx];
      });
      break;
    }
    case "ign": {
      const scale = Math.max(0.1, s.noiseScale);
      orderedPass(ctx, (x, y) => ign(x / scale, y / scale));
      break;
    }
    case "threshold":
      thresholdPass(ctx, 0);
      break;
    case "random":
      thresholdPass(ctx, s.noiseAmount);
      break;
    case "riemersma":
      riemersmaPass(ctx);
      break;
    case "dot-diffusion":
      dotDiffusePass(ctx);
      break;
    case "ostromoukhov":
      adaptiveDiffusePass(ctx);
      break;
    case "omino":
      ominoPass(ctx);
      break;
    default: {
      const k = KERNELS[s.algorithm];
      if (k) errorDiffusePass(ctx, k);
      else errorDiffusePass(ctx, KERNELS["floyd-steinberg"]);
      break;
    }
  }

  return new ImageData(out, w, h);
}
