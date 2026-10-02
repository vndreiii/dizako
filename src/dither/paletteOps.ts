import { hexToRgb, hsvToRgb, rgbToHex, rgbToHsv } from "./color";
import { layersFromColors, makeLayer, type PaletteLayer } from "./types";

/** Upper bound on colours in a stack; past this the matcher cost outweighs the use. */
export const MAX_COLOURS = 32;
/** A palette needs at least two colours to dither between. */
export const MIN_COLOURS = 2;

/**
 * Re-spaces tonal levels across the stack.
 *
 * Layers are stored shadows-first. After any reorder the levels are spread
 * evenly again so position in the list *is* the tonal band the layer owns -
 * which is what makes dragging a colour toward the highlights actually move it
 * there.
 */
export function respread(layers: PaletteLayer[]): PaletteLayer[] {
  const n = layers.length;
  return layers.map((l, i) => ({ ...l, level: n <= 1 ? 0.5 : i / (n - 1) }));
}

/** A colour chosen by rolling hue, saturation and value independently. */
export function randomColor(rand: () => number = Math.random): string {
  return rgbToHex(hsvToRgb(rand() * 360, rand(), 0.05 + rand() * 0.95));
}

export function randomStack(n: number, rand: () => number = Math.random): string[] {
  return Array.from({ length: n }, () => randomColor(rand));
}

/**
 * What "make your own" starts from: five colours from shadow to highlight, tinted
 * enough to read as a palette rather than a grey ramp, ready to be edited one at a time.
 */
export const STARTER_COLOURS = ["#14141C", "#4B4A6B", "#8E7CB3", "#D6B4D9", "#FFF3E6"] as const;

export function starterLayers(): PaletteLayer[] {
  return layersFromColors([...STARTER_COLOURS]);
}

/**
 * A new colour for the "+" tile: related to the end of the stack it lands on
 * but pushed far enough away to be a distinct swatch, not a near-duplicate.
 */
export function nextColour(layers: PaletteLayer[]): string {
  const last = layers[layers.length - 1];
  if (!last) return "#808080";
  const [r, g, b] = hexToRgb(last.hex);
  const [h, s, v] = rgbToHsv(r, g, b);
  const brighter = v < 0.75;
  return rgbToHex(
    hsvToRgb((h + 42) % 360, Math.max(0.35, s), brighter ? Math.min(1, v + 0.28) : Math.max(0.12, v - 0.42)),
  );
}

/** Appends a colour at the highlight end and re-spreads the levels. */
export function appendColour(layers: PaletteLayer[], hex: string): PaletteLayer[] {
  if (layers.length >= MAX_COLOURS) return layers;
  return respread([...layers, makeLayer(hex, 1)]);
}

/** Moves a layer by `delta` places in storage order; no-op at the ends. */
export function shiftLayer(layers: PaletteLayer[], id: string, delta: -1 | 1): PaletteLayer[] {
  const from = layers.findIndex((l) => l.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= layers.length) return layers;
  const next = [...layers];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return respread(next);
}

/** Removes a layer unless that would leave fewer than two. */
export function dropLayer(layers: PaletteLayer[], id: string): PaletteLayer[] {
  if (layers.length <= MIN_COLOURS) return layers;
  return respread(layers.filter((l) => l.id !== id));
}
