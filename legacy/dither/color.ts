import type { RGB } from "./types";
import { cbrtShared, srgbToLinearShared } from "./sharedmath";

export function hexToRgb(hex: string): RGB {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

const hex2 = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");

export function rgbToHex([r, g, b]: RGB): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`.toUpperCase();
}

/** Rec. 601 luma, matching what the eye weights most. */
export function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

// ---------------------------------------------------------------- OKLab
// Björn Ottosson's OKLab. Perceptually uniform, so "nearest colour" in this
// space actually looks nearest, which sRGB distance frequently does not.
//
// Transcendentals go through the shared deterministic primitives: library
// `pow`/`cbrt` differ in the last ulp between engines, and in a strict-`<`
// nearest-colour scan one flipped ulp cascades into visibly different dither
// texture (WASM_PLAN §4).

export function rgbToOklab(r: number, g: number, b: number): RGB {
  const lr = srgbToLinearShared(r);
  const lg = srgbToLinearShared(g);
  const lb = srgbToLinearShared(b);

  const l = cbrtShared(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = cbrtShared(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = cbrtShared(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

// ---------------------------------------------------------------- HSL / HSV

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;

  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

export function hsvToRgb(h: number, s: number, v: number): RGB {
  const c = v * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = v - c;

  let rgb: RGB;
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];

  return [(rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255];
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const [h, sv, v] = rgbToHsv(r, g, b);
  const l = v * (1 - sv / 2);
  const s = l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l);
  return [h, s, l];
}

export function hslToRgb(h: number, s: number, l: number): RGB {
  const v = l + s * Math.min(l, 1 - l);
  const sv = v === 0 ? 0 : 2 * (1 - l / v);
  return hsvToRgb(h, sv, v);
}
