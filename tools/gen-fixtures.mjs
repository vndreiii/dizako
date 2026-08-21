/**
 * Deterministic fixture corpus for the golden/parity harness.
 *
 * Fixtures are raw RGBA buffers described by meta JSON, so neither the TS
 * runner (Node) nor the Rust one needs an image decoder. Generation is pure
 * integer/float math with no library calls beyond Math.sin on synthetic
 * patterns — the *outputs* are hashed, not the inputs, so generator
 * portability is irrelevant as long as it is run once and committed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "testdata", "images");

function makeRgba(w, h, fill) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const [r, g, b, a] = fill(x, y, w, h);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return data;
}

// Deterministic value noise (not a crypto PRNG — stability across runs is all
// that matters, and this is frozen into committed bytes anyway).
function noiseGen(seed) {
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

const fixtures = {
  // Smooth horizontal ramp with a vertical gradient component: exercises tone
  // curve + every matcher across the full 0..255 range.
  "gradient": {
    w: 96,
    h: 72,
    fill: (x, y, w, h) => {
      const t = x / (w - 1);
      const v = y / (h - 1);
      return [255 * t, 255 * (1 - t), 128 + 127 * Math.sin(v * Math.PI), 255];
    },
  },
  // Photographic stand-in: soft radial blobs plus mild noise, i.e. flat-ish
  // regions where diffusion texture and matcher ties actually show.
  "photo": {
    w: 96,
    h: 72,
    fill: (() => {
      const rand = noiseGen(0x1234abcd);
      const grain = new Float32Array(96 * 72);
      for (let i = 0; i < grain.length; i++) grain[i] = (rand() - 0.5) * 14;
      return (x, y) => {
        const d1 = Math.hypot(x - 30, y - 26);
        const d2 = Math.hypot(x - 68, y - 50);
        const v =
          200 * Math.exp(-(d1 * d1) / 900) +
          90 * Math.exp(-(d2 * d2) / 1400) +
          40 +
          grain[y * 96 + x];
        return [v, v * 0.92 + 12, 255 - v * 0.6, 255];
      };
    })(),
  },
  // Hard edges: worst case for error diffusion overshoot along boundaries.
  "checker": {
    w: 96,
    h: 72,
    fill: (x, y) => ((Math.floor(x / 8) + Math.floor(y / 8)) % 2 ? [250, 250, 250, 255] : [8, 8, 8, 255]),
  },
  // Large flat region with faint noise: matcher tie-breaks and dot-diffusion
  // rank cascades live here.
  "flat-noise": {
    w: 96,
    h: 72,
    fill: (() => {
      const rand = noiseGen(0xdeadbeef);
      const g = new Float32Array(96 * 72);
      for (let i = 0; i < g.length; i++) g[i] = (rand() - 0.5) * 3;
      return (x, y) => {
        const v = 118 + g[y * 96 + x];
        return [v, v, v, 255];
      };
    })(),
  },
  // Coarse posterisation leaves exact ties between neighbouring tones.
  "posterized": {
    w: 96,
    h: 72,
    fill: (x, y) => {
      const q = (v) => Math.round((v / 32)) * 32;
      return [q(x * 2.4), q(y * 3.2), q((x + y) * 1.3), 255];
    },
  },
  // Alpha-bearing: transparency must survive to the output byte-for-byte.
  "alpha": {
    w: 64,
    h: 64,
    fill: (x, y) => {
      const d = Math.hypot(x - 32, y - 32);
      const a = d < 28 ? 255 : d < 30 ? 128 : 0;
      return [220, 60, 130, a];
    },
  },
  // Bigger frame for stride / region-crop paths; used by a reduced sweep.
  "large": {
    w: 512,
    h: 384,
    fill: (x, y) => [
      (x * 255) / 511,
      (y * 255) / 383,
      96 + 80 * Math.sin((x + y) / 24),
      255,
    ],
  },
};

mkdirSync(outDir, { recursive: true });
for (const [name, f] of Object.entries(fixtures)) {
  const data = makeRgba(f.w, f.h, f.fill);
  writeFileSync(join(outDir, `${name}.rgba`), Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify({ name, width: f.w, height: f.h }));
}
console.log(`wrote ${Object.keys(fixtures).length} fixtures to ${outDir}`);
