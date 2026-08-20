/**
 * Threshold masks for the ordered family.
 *
 * Every mask returns a value in 0..1 for a given pixel. Ordered dithering then
 * nudges the pixel by (mask - 0.5) before matching, so the mask decides which
 * pixels round up and which round down.
 */

/** Canonical recursive Bayer matrix, normalised to 0..1. */
export function bayerMatrix(n: number): Float32Array {
  let size = 1;
  let m = new Float32Array([0]);
  while (size < n) {
    const next = size * 2;
    const out = new Float32Array(next * next);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = m[y * size + x] * 4;
        out[y * next + x] = v;
        out[y * next + (x + size)] = v + 2;
        out[(y + size) * next + x] = v + 3;
        out[(y + size) * next + (x + size)] = v + 1;
      }
    }
    m = out;
    size = next;
  }
  const total = size * size;
  const norm = new Float32Array(total);
  for (let i = 0; i < total; i++) norm[i] = m[i] / total;
  return norm;
}

const bayerCache = new Map<number, Float32Array>();
export function cachedBayer(n: number): Float32Array {
  let m = bayerCache.get(n);
  if (!m) {
    m = bayerMatrix(n);
    bayerCache.set(n, m);
  }
  return m;
}

/**
 * Void-and-cluster blue noise (Ulichney).
 *
 * Starts from a sparse random binary pattern, then repeatedly moves the tightest
 * cluster into the largest void until the pattern is maximally uniform. That
 * settled pattern is then ranked to produce the mask. Generation is not cheap,
 * so tiles are built once and cached for the life of the worker.
 */
function voidAndCluster(size: number): Float32Array {
  const n = size * size;
  const binary = new Uint8Array(n);
  const initial = Math.max(1, Math.round(n * 0.1));

  // Deterministic seeding keeps the mask stable between runs.
  let seed = 0x9e3779b9;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  for (let placed = 0; placed < initial; ) {
    const i = Math.floor(rand() * n);
    if (!binary[i]) {
      binary[i] = 1;
      placed++;
    }
  }

  // Gaussian-weighted neighbourhood energy, wrapped so the tile is seamless.
  const sigma = 1.9;
  const radius = 4;
  const weights: number[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      weights.push(Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma)));
    }
  }

  const energy = new Float32Array(n);
  const stamp = (idx: number, sign: number) => {
    const px = idx % size;
    const py = (idx / size) | 0;
    let w = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      const y = (py + dy + size) % size;
      for (let dx = -radius; dx <= radius; dx++) {
        const x = (px + dx + size) % size;
        energy[y * size + x] += sign * weights[w++];
      }
    }
  };
  for (let i = 0; i < n; i++) if (binary[i]) stamp(i, 1);

  const tightestCluster = () => {
    let best = -1;
    let bestE = -Infinity;
    for (let i = 0; i < n; i++) {
      if (binary[i] && energy[i] > bestE) {
        bestE = energy[i];
        best = i;
      }
    }
    return best;
  };
  const largestVoid = () => {
    let best = -1;
    let bestE = Infinity;
    for (let i = 0; i < n; i++) {
      if (!binary[i] && energy[i] < bestE) {
        bestE = energy[i];
        best = i;
      }
    }
    return best;
  };

  // Settle the initial pattern.
  for (let iter = 0; iter < n; iter++) {
    const c = tightestCluster();
    binary[c] = 0;
    stamp(c, -1);
    const v = largestVoid();
    if (v === c) {
      binary[c] = 1;
      stamp(c, 1);
      break;
    }
    binary[v] = 1;
    stamp(v, 1);
  }

  const rank = new Int32Array(n).fill(-1);
  const settled = Uint8Array.from(binary);
  let ones = 0;
  for (let i = 0; i < n; i++) if (settled[i]) ones++;

  // Phase 1: rank the settled minority pattern downward.
  const work = Uint8Array.from(settled);
  for (let i = 0; i < n; i++) energy[i] = 0;
  for (let i = 0; i < n; i++) if (work[i]) stamp(i, 1);
  for (let r = ones - 1; r >= 0; r--) {
    const c = tightestClusterIn(work);
    work[c] = 0;
    stamp(c, -1);
    rank[c] = r;
  }

  function tightestClusterIn(bits: Uint8Array) {
    let best = -1;
    let bestE = -Infinity;
    for (let i = 0; i < n; i++) {
      if (bits[i] && energy[i] > bestE) {
        bestE = energy[i];
        best = i;
      }
    }
    return best;
  }

  // Phase 2 and 3: fill the remainder upward.
  const work2 = Uint8Array.from(settled);
  for (let i = 0; i < n; i++) energy[i] = 0;
  for (let i = 0; i < n; i++) if (work2[i]) stamp(i, 1);
  for (let r = ones; r < n; r++) {
    const v = largestVoidIn(work2);
    work2[v] = 1;
    stamp(v, 1);
    rank[v] = r;
  }

  function largestVoidIn(bits: Uint8Array) {
    let best = -1;
    let bestE = Infinity;
    for (let i = 0; i < n; i++) {
      if (!bits[i] && energy[i] < bestE) {
        bestE = energy[i];
        best = i;
      }
    }
    return best;
  }

  const mask = new Float32Array(n);
  for (let i = 0; i < n; i++) mask[i] = (rank[i] + 0.5) / n;
  return mask;
}

const blueCache = new Map<number, Float32Array>();
export function blueNoise(size = 64): Float32Array {
  let m = blueCache.get(size);
  if (!m) {
    m = voidAndCluster(size);
    blueCache.set(size, m);
  }
  return m;
}

/** Interleaved gradient noise — Jorge Jimenez's cheap, very even hash. */
export function ign(x: number, y: number): number {
  return (52.9829189 * ((0.06711056 * x + 0.00583715 * y) % 1)) % 1;
}

/** Rotates a coordinate into screen space for the halftone family. */
function rotate(x: number, y: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}

/** Clustered dot: a spot function growing from the centre of each cell. */
export function clusteredDot(x: number, y: number, cell: number, angle: number): number {
  const [rx, ry] = rotate(x, y, angle);
  const u = ((rx % cell) + cell) % cell;
  const v = ((ry % cell) + cell) % cell;
  const dx = (u / cell) * 2 - 1;
  const dy = (v / cell) * 2 - 1;
  // Euclidean spot: round dots that merge into a checker at 50%.
  return Math.min(0.999, Math.sqrt(dx * dx + dy * dy) / Math.SQRT2);
}

/** Diagonal cluster: a rotated-square spot, closer to a classic 45° screen. */
export function diagonalCluster(x: number, y: number, cell: number, angle: number): number {
  const [rx, ry] = rotate(x, y, angle);
  const u = ((rx % cell) + cell) % cell;
  const v = ((ry % cell) + cell) % cell;
  const dx = (u / cell) * 2 - 1;
  const dy = (v / cell) * 2 - 1;
  return Math.min(0.999, (Math.abs(dx) + Math.abs(dy)) / 2);
}

/** Line screen: rules perpendicular to the screen angle. */
export function lineScreen(x: number, y: number, cell: number, angle: number): number {
  const [, ry] = rotate(x, y, angle);
  const v = ((ry % cell) + cell) % cell;
  return Math.abs(v / cell - 0.5) * 2;
}

/** Crosshatch of two line screens 90° apart. */
export function diagonalHatch(x: number, y: number, cell: number, angle: number): number {
  const a = lineScreen(x, y, cell, angle);
  const b = lineScreen(x, y, cell, angle + 90);
  return Math.min(0.999, Math.min(a, b));
}

/** Two-phase checker at the given cell size. */
export function checkerMask(x: number, y: number, cell: number): number {
  const c = Math.max(1, Math.round(cell));
  const cx = Math.floor(x / c);
  const cy = Math.floor(y / c);
  return (cx + cy) % 2 === 0 ? 0.25 : 0.75;
}
