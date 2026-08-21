/**
 * Generates the declarative parity sweep: testdata/suites/main.json
 *
 * The file is committed; regenerate only when adding coverage. Both runners
 * (vitest for TS/wasm, cargo test for native Rust) consume the exact same
 * array, in order, keyed by case id.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const palettes = {
  bw: {
    layers: [
      { id: "p0", hex: "#000000", level: 0, width: 2, enabled: true },
      { id: "p1", hex: "#FFFFFF", level: 1, width: 2, enabled: true },
    ],
  },
  stack12: {
    layers: [
      { id: "p0", hex: "#0B0D17", level: 0.0, width: 1.5, enabled: true },
      { id: "p1", hex: "#221A33", level: 0.09, width: 2, enabled: true },
      { id: "p2", hex: "#3E2A5B", level: 0.18, width: 3, enabled: true },
      { id: "p3", hex: "#7A3B6E", level: 0.27, width: 2.5, enabled: true },
      { id: "p4", hex: "#B8434F", level: 0.36, width: 2, enabled: true },
      { id: "p5", hex: "#E06C4A", level: 0.45, width: 3.5, enabled: true },
      { id: "p6", hex: "#F2A65A", level: 0.54, width: 2, enabled: true },
      { id: "p7", hex: "#F7D488", level: 0.63, width: 2.5, enabled: true },
      { id: "p8", hex: "#9FB87F", level: 0.72, width: 2, enabled: true },
      { id: "p9", hex: "#4E937A", level: 0.81, width: 3, enabled: true },
      { id: "p10", hex: "#33658A", level: 0.9, width: 2, enabled: true },
      { id: "p11", hex: "#F4F4F0", level: 1.0, width: 1.5, enabled: true },
    ],
  },
  reorder: {
    // Same two colours as `bw`, levels flipped: tonal matching must differ.
    layers: [
      { id: "q0", hex: "#FFFFFF", level: 0, width: 2, enabled: true },
      { id: "q1", hex: "#000000", level: 1, width: 2, enabled: true },
    ],
  },
};

const KERNELS = [
  "floyd-steinberg",
  "false-floyd-steinberg",
  "jarvis-judice-ninke",
  "stucki",
  "burkes",
  "sierra",
  "sierra-two-row",
  "sierra-lite",
  "stevenson-arce",
  "fan",
  "shiau-fan",
  "shiau-fan-2",
  "pigeon",
  "simple-2d",
  "atkinson",
];

const ORDERED = [
  "bayer",
  "halftone",
  "cluster-diagonal",
  "halftone-line",
  "diagonal-line",
  "checker",
  "blue-noise",
  "ign",
];

const cases = [];
let seq = 0;
const add = (c) => cases.push({ id: `case-${String(++seq).padStart(4, "0")}`, ...c });

// --- Core matrix: every algorithm x palette x match mode x bias x strength ---
for (const algorithm of [...KERNELS, ...ORDERED, "threshold", "random", "riemersma", "dot-diffusion", "ostromoukhov", "omino"]) {
  for (const palette of ["bw", "stack12"]) {
    for (const matchMode of ["rgb", "luma", "oklab", "tonal"]) {
      for (const tonalBias of [0, 0.5]) {
        add({ fixture: "gradient", algorithm, palette, matchMode, tonalBias });
      }
    }
  }
}

// --- Diffusion corners: serpentine / jitter / errorClamp on a photo -------
for (const algorithm of KERNELS) {
  for (const serpentine of [true, false]) {
    for (const jitter of [0, 0.4]) {
      for (const errorClamp of [0, 255]) {
        add({ fixture: "photo", algorithm, palette: "bw", matchMode: "oklab", serpentine, jitter, errorClamp });
      }
    }
  }
}
// Every kernel once against the awkward fixtures with defaults.
for (const algorithm of KERNELS) {
  for (const fixture of ["checker", "flat-noise", "posterized"]) {
    add({ fixture, algorithm, palette: "bw", matchMode: "oklab" });
  }
}

// --- Ostromoukhov ---
for (const serpentine of [true, false]) {
  for (const fixture of ["gradient", "photo"]) {
    add({ fixture, algorithm: "ostromoukhov", palette: "stack12", matchMode: "oklab", serpentine });
  }
}

// --- Riemersma queue/decay grid ---
for (const riemersmaQueue of [4, 16, 32]) {
  for (const riemersmaDecay of [0.3, 0.75, 0.95]) {
    add({ fixture: "photo", algorithm: "riemersma", palette: "stack12", matchMode: "oklab", riemersmaQueue, riemersmaDecay });
  }
}

// --- Dot diffusion class sizes ---
for (const dotClassSize of [2, 8, 16]) {
  for (const fixture of ["photo", "flat-noise"]) {
    add({ fixture, algorithm: "dot-diffusion", palette: "stack12", matchMode: "oklab", dotClassSize });
  }
}

// --- Omino directions / phase / color count ---
for (const ominoDirection of ["right", "left", "down", "up"]) {
  for (const ominoPhase of [0, 180]) {
    add({ fixture: "gradient", algorithm: "omino", palette: "stack12", matchMode: "rgb", ominoDirection, ominoPhase });
  }
}
for (const ominoColorCount of [2, 12]) {
  add({ fixture: "photo", algorithm: "omino", palette: "stack12", matchMode: "rgb", ominoColorCount });
}

// --- Ordered family parameters + threshold bias ---
for (const bayerSize of [2, 4, 8, 16, 32]) {
  add({ fixture: "gradient", algorithm: "bayer", palette: "bw", matchMode: "oklab", bayerSize });
}
for (const algorithm of ["halftone", "cluster-diagonal", "halftone-line", "diagonal-line"]) {
  for (const cellSize of [4, 12]) {
    for (const screenAngle of [0, 27, 90]) {
      add({ fixture: "gradient", algorithm, palette: "bw", matchMode: "oklab", cellSize, screenAngle });
    }
  }
}
for (const algorithm of ["blue-noise", "ign"]) {
  for (const noiseScale of [0.5, 2.7]) {
    add({ fixture: "gradient", algorithm, palette: "bw", matchMode: "oklab", noiseScale });
  }
}
for (const algorithm of ORDERED) {
  for (const threshold of [64, 200]) {
    add({ fixture: "photo", algorithm, palette: "bw", matchMode: "oklab", threshold });
  }
}

// --- Threshold family ---
for (const threshold of [10, 128, 245]) {
  add({ fixture: "gradient", algorithm: "threshold", palette: "bw", matchMode: "oklab", threshold });
}
for (const noiseAmount of [0.05, 1]) {
  add({ fixture: "photo", algorithm: "random", palette: "bw", matchMode: "oklab", noiseAmount });
}

// --- Filter stage parity (blur/unsharp exercise boxBlur) ---
for (const blur of [1, 4]) {
  for (const fixture of ["photo", "gradient"]) {
    add({ fixture, algorithm: "floyd-steinberg", palette: "bw", matchMode: "oklab", blur });
    add({ fixture, algorithm: "bayer", palette: "bw", matchMode: "oklab", blur });
  }
}
for (const sharpen of [0.5]) {
  for (const fixture of ["photo", "gradient"]) {
    add({ fixture, algorithm: "floyd-steinberg", palette: "bw", matchMode: "oklab", sharpen });
  }
}
for (const grayscale of [true, false]) {
  add({ fixture: "photo", algorithm: "floyd-steinberg", palette: "bw", matchMode: "oklab", grayscale, invert: !grayscale ? true : undefined });
}

// --- Large fixture (stride paths) and alpha preservation ---
for (const algorithm of ["floyd-steinberg", "bayer", "riemersma", "dot-diffusion", "omino", "halftone"]) {
  add({ fixture: "large", algorithm, palette: "bw", matchMode: "oklab" });
}
for (const algorithm of ["floyd-steinberg", "bayer"]) {
  add({ fixture: "alpha", algorithm, palette: "bw", matchMode: "oklab" });
}

mkdirSync(join(root, "testdata", "suites"), { recursive: true });
writeFileSync(
  join(root, "testdata", "suites", "main.json"),
  JSON.stringify({ version: 1, palettes, cases }, null, 1),
);
console.log(`wrote ${cases.length} cases to testdata/suites/main.json`);
