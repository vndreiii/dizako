import { rgbToHex, luma } from "./color";

/**
 * Pulls a palette out of an image: the colours it is actually made of.
 *
 * Median cut finds where the colour mass sits, then a few k-means passes pull
 * each swatch to the true mean of the pixels that claim it. Median cut alone
 * returns the middle of each *box*, which drifts off the data when a box is
 * lopsided; the refinement is what makes a flat blue sky come out as the
 * photo's blue rather than a blue-ish average of everything near it.
 *
 * Work is bounded by a pixel budget, not by image size, so a 16-megapixel
 * source costs the same few milliseconds as a thumbnail.
 */

const SAMPLE_BUDGET = 48_000;
/** Pixels below this alpha are not part of the picture. */
const MIN_ALPHA = 16;
const KMEANS_ROUNDS = 4;

interface Box {
  /** Indices into the sample arrays. */
  items: number[];
}

export interface ExtractOptions {
  /** Colours to return, 2..32. */
  count: number;
}

/** Strided sample of opaque pixels as three parallel arrays. */
function sample(data: Uint8ClampedArray, pixels: number) {
  const stride = Math.max(1, Math.floor(pixels / SAMPLE_BUDGET));
  const r: number[] = [];
  const g: number[] = [];
  const b: number[] = [];
  for (let i = 0; i < pixels; i += stride) {
    const o = i * 4;
    if (data[o + 3]! < MIN_ALPHA) continue;
    r.push(data[o]!);
    g.push(data[o + 1]!);
    b.push(data[o + 2]!);
  }
  return { r, g, b };
}

export function extractPalette(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  { count }: ExtractOptions,
): string[] {
  const want = Math.max(2, Math.min(32, Math.round(count)));
  const { r, g, b } = sample(data, width * height);
  if (r.length === 0) return ["#000000", "#FFFFFF"].slice(0, want);

  const channels = [r, g, b];
  const boxes: Box[] = [{ items: r.map((_, i) => i) }];

  const rangeOf = (box: Box) => {
    let best = 0;
    let bestRange = -1;
    for (let c = 0; c < 3; c++) {
      let lo = 255;
      let hi = 0;
      for (const i of box.items) {
        const v = channels[c]![i]!;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (hi - lo > bestRange) {
        bestRange = hi - lo;
        best = c;
      }
    }
    return { channel: best, range: bestRange };
  };

  while (boxes.length < want) {
    // Split the box with the most to gain: wide in colour and heavy in pixels.
    let pick = -1;
    let pickScore = 0;
    let pickChannel = 0;
    for (let k = 0; k < boxes.length; k++) {
      const box = boxes[k]!;
      if (box.items.length < 2) continue;
      const { channel, range } = rangeOf(box);
      const score = range * Math.sqrt(box.items.length);
      if (range > 0 && score > pickScore) {
        pick = k;
        pickScore = score;
        pickChannel = channel;
      }
    }
    // Every remaining box is a single flat colour: nothing left to separate.
    if (pick < 0) break;

    const box = boxes[pick]!;
    const ch = channels[pickChannel]!;
    box.items.sort((a, b2) => ch[a]! - ch[b2]!);
    const mid = box.items.length >> 1;
    boxes.splice(pick, 1, { items: box.items.slice(0, mid) }, { items: box.items.slice(mid) });
  }

  let centres = boxes.map((box) => {
    let sr = 0, sg = 0, sb = 0;
    for (const i of box.items) {
      sr += r[i]!;
      sg += g[i]!;
      sb += b[i]!;
    }
    const n = box.items.length || 1;
    return [sr / n, sg / n, sb / n] as [number, number, number];
  });

  for (let round = 0; round < KMEANS_ROUNDS; round++) {
    const sums = centres.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < r.length; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let k = 0; k < centres.length; k++) {
        const c = centres[k]!;
        // Perceptual-ish weights: the eye is far more sensitive to green.
        const d = 0.299 * (r[i]! - c[0]) ** 2 + 0.587 * (g[i]! - c[1]) ** 2 + 0.114 * (b[i]! - c[2]) ** 2;
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      }
      const s = sums[best]!;
      s[0]! += r[i]!;
      s[1]! += g[i]!;
      s[2]! += b[i]!;
      s[3]! += 1;
    }
    centres = centres.map((c, k) => {
      const s = sums[k]!;
      return s[3]! > 0 ? ([s[0]! / s[3]!, s[1]! / s[3]!, s[2]! / s[3]!] as [number, number, number]) : c;
    });
  }

  // Collapse swatches the refinement pulled onto each other.
  const unique: Array<[number, number, number]> = [];
  for (const c of centres) {
    const hex = rgbToHex([c[0], c[1], c[2]]);
    if (!unique.some((u) => rgbToHex([u[0], u[1], u[2]]) === hex)) unique.push(c);
  }

  const hexes = unique
    .sort((a, b2) => luma(a[0], a[1], a[2]) - luma(b2[0], b2[1], b2[2]))
    .map((c) => rgbToHex([c[0], c[1], c[2]]));

  // A flat image has fewer colours than were asked for; a palette needs two.
  if (hexes.length === 1) {
    const only = hexes[0]!;
    return luma(...(unique[0]!)) > 127 ? ["#000000", only] : [only, "#FFFFFF"];
  }
  return hexes;
}
