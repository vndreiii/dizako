import { describe, expect, test } from "vitest";
import {
  appendColour, dropLayer, MAX_COLOURS, nextColour, respread, shiftLayer, starterLayers,
} from "../src/dither/paletteOps";
import { layersFromColors } from "../src/dither/types";
import { hexToRgb } from "../src/dither/color";

describe("palette operations", () => {
  test("levels are spread evenly from shadow to highlight", () => {
    const l = respread(layersFromColors(["#000000", "#555555", "#aaaaaa", "#ffffff"]));
    expect(l.map((x) => Number(x.level.toFixed(3)))).toEqual([0, 0.333, 0.667, 1]);
    expect(respread(layersFromColors(["#123456"]))[0]!.level).toBe(0.5);
  });

  test("the starter palette is five tinted colours running dark to light", () => {
    const l = starterLayers();
    expect(l).toHaveLength(5);
    const lum = l.map((x) => { const [r, g, b] = hexToRgb(x.hex); return 0.299 * r + 0.587 * g + 0.114 * b; });
    expect(lum).toEqual([...lum].sort((a, b) => a - b));
    expect(new Set(l.map((x) => x.hex)).size).toBe(5);
  });

  test("a new colour is distinct from the one it follows", () => {
    for (const start of ["#000000", "#ffffff", "#336699", "#cc3300", "#808080"]) {
      const layers = layersFromColors(["#101010", start]);
      const next = nextColour(layers);
      expect(next.toLowerCase()).not.toBe(start.toLowerCase());
      const [r1, g1, b1] = hexToRgb(start);
      const [r2, g2, b2] = hexToRgb(next);
      expect(Math.hypot(r1 - r2, g1 - g2, b1 - b2)).toBeGreaterThan(40);
    }
  });

  test("append adds at the highlight end, respreads, and stops at the cap", () => {
    let l = layersFromColors(["#000000", "#ffffff"]);
    l = appendColour(l, "#ff0000");
    expect(l.map((x) => x.hex)).toEqual(["#000000", "#ffffff", "#ff0000"]);
    expect(l[2]!.level).toBe(1);
    while (l.length < MAX_COLOURS) l = appendColour(l, "#00ff00");
    expect(appendColour(l, "#0000ff")).toBe(l);
  });

  test("shifting swaps neighbours, never walks off an end", () => {
    const l = layersFromColors(["#000000", "#888888", "#ffffff"]);
    const id = l[1]!.id;
    expect(shiftLayer(l, id, -1).map((x) => x.hex)).toEqual(["#888888", "#000000", "#ffffff"]);
    expect(shiftLayer(l, l[0]!.id, -1)).toBe(l);
    expect(shiftLayer(l, l[2]!.id, 1)).toBe(l);
  });

  test("removing keeps at least two colours", () => {
    const three = layersFromColors(["#000000", "#888888", "#ffffff"]);
    const two = dropLayer(three, three[1]!.id);
    expect(two).toHaveLength(2);
    expect(dropLayer(two, two[0]!.id)).toBe(two);
  });
});
