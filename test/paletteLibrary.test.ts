import { describe, expect, test } from "vitest";
import {
  createFolder, deleteFolder, deletePalette, emptyLibrary, layersFromSaved, movePalette, parseLibrary,
  renameFolder, renamePalette, sameAsStack, savePalette, setFolderExpanded, uniqueName, updatePaletteColours,
} from "../src/dither/paletteLibrary";
import { layersFromColors } from "../src/dither/types";

const stack = (...hex: string[]) => layersFromColors(hex);

describe("palette library", () => {
  test("names stay unique among siblings without ever being empty", () => {
    expect(uniqueName([], "Sunset")).toBe("Sunset");
    expect(uniqueName(["Sunset"], "sunset")).toBe("sunset 2");
    expect(uniqueName(["Sunset", "Sunset 2"], "Sunset")).toBe("Sunset 3");
    expect(uniqueName([], "   ")).toBe("Untitled");
  });

  test("a saved palette keeps colours, widths and visibility, and loads back as layers", () => {
    const layers = stack("#102030", "#aabbcc", "#ffeedd");
    layers[1]!.width = 5;
    layers[2]!.enabled = false;
    const { library, id } = savePalette(emptyLibrary(), { name: "Dusk", layers, folderId: null });
    const saved = library.palettes.find((p) => p.id === id)!;
    expect(saved.colours.map((c) => c.hex)).toEqual(["#102030", "#AABBCC", "#FFEEDD"]);
    const back = layersFromSaved(saved);
    expect(back.map((l) => [l.hex.toLowerCase(), l.width, l.enabled])).toEqual([
      ["#102030", 2, true], ["#aabbcc", 5, true], ["#ffeedd", 2, false],
    ]);
    expect(back.map((l) => l.level)).toEqual([0, 0.5, 1]);
    expect(sameAsStack(saved, back)).toBe(true);
    expect(sameAsStack(saved, stack("#102030", "#aabbcc"))).toBe(false);
  });

  test("palettes can live in folders, and the same name may repeat across folders", () => {
    let lib = emptyLibrary();
    const a = createFolder(lib, "Warm"); lib = a.library;
    const b = createFolder(lib, "Cool"); lib = b.library;
    lib = savePalette(lib, { name: "Base", layers: stack("#000000", "#ff0000"), folderId: a.id }).library;
    lib = savePalette(lib, { name: "Base", layers: stack("#000000", "#0000ff"), folderId: b.id }).library;
    lib = savePalette(lib, { name: "Base", layers: stack("#000000", "#ffffff"), folderId: a.id }).library;
    expect(lib.palettes.map((p) => [p.folderId === a.id ? "warm" : "cool", p.name])).toEqual([
      ["warm", "Base"], ["cool", "Base"], ["warm", "Base 2"],
    ]);
  });

  test("saving into a folder that does not exist falls back to the top level", () => {
    const { library, id } = savePalette(emptyLibrary(), { name: "X", layers: stack("#000", "#fff"), folderId: "ghost" });
    expect(library.palettes.find((p) => p.id === id)!.folderId).toBeNull();
  });

  test("moving renames on collision and refuses an unknown folder", () => {
    let lib = emptyLibrary();
    const f = createFolder(lib, "F"); lib = f.library;
    const top = savePalette(lib, { name: "Same", layers: stack("#000", "#fff"), folderId: null }); lib = top.library;
    lib = savePalette(lib, { name: "Same", layers: stack("#111", "#eee"), folderId: f.id }).library;
    const moved = movePalette(lib, top.id, f.id);
    expect(moved.palettes.filter((p) => p.folderId === f.id).map((p) => p.name).sort()).toEqual(["Same", "Same 2"]);
    expect(movePalette(lib, top.id, "ghost")).toBe(lib);
    expect(movePalette(lib, top.id, null)).toBe(lib);
  });

  test("deleting a folder either takes its palettes along or lifts them out", () => {
    let lib = emptyLibrary();
    const f = createFolder(lib, "F"); lib = f.library;
    lib = savePalette(lib, { name: "In", layers: stack("#000", "#fff"), folderId: f.id }).library;
    lib = savePalette(lib, { name: "Out", layers: stack("#111", "#eee"), folderId: null }).library;
    const lifted = deleteFolder(lib, f.id, true);
    expect(lifted.folders).toHaveLength(0);
    expect(lifted.palettes.map((p) => [p.name, p.folderId])).toEqual([["In", null], ["Out", null]]);
    const gone = deleteFolder(lib, f.id, false);
    expect(gone.palettes.map((p) => p.name)).toEqual(["Out"]);
  });

  test("rename, overwrite, expand and delete touch only their target", () => {
    let lib = emptyLibrary();
    const f = createFolder(lib, "F"); lib = f.library;
    const p = savePalette(lib, { name: "A", layers: stack("#000", "#fff"), folderId: null }); lib = p.library;
    lib = savePalette(lib, { name: "B", layers: stack("#111", "#eee"), folderId: null }).library;
    expect(renamePalette(lib, p.id, "B").palettes.map((x) => x.name)).toEqual(["B 2", "B"]);
    expect(renameFolder(lib, f.id, "Fresh").folders[0]!.name).toBe("Fresh");
    const updated = updatePaletteColours(lib, p.id, stack("#123456", "#abcdef"));
    expect(updated.palettes[0]!.colours.map((c) => c.hex)).toEqual(["#123456", "#ABCDEF"]);
    expect(updated.palettes[1]).toEqual(lib.palettes[1]);
    expect(setFolderExpanded(lib, f.id, false).folders[0]!.expanded).toBe(false);
    expect(deletePalette(lib, p.id).palettes.map((x) => x.name)).toEqual(["B"]);
    expect(lib.palettes).toHaveLength(2); // inputs are never mutated
  });

  test("a stored library survives a JSON round trip", () => {
    let lib = emptyLibrary();
    const f = createFolder(lib, "F"); lib = f.library;
    lib = savePalette(lib, { name: "A", layers: stack("#000000", "#ff8800", "#ffffff"), folderId: f.id }).library;
    expect(parseLibrary(JSON.parse(JSON.stringify(lib)))).toEqual(lib);
  });

  test("parsing keeps what is sound and drops what is not", () => {
    const parsed = parseLibrary({
      folders: [{ id: "f1", name: "Keep" }, { id: "f1", name: "Dup" }, { name: "no id" }, 7, null],
      palettes: [
        { id: "p1", name: "Good", folderId: "f1", colours: [{ hex: "#000000" }, { hex: "#ffffff", width: 99, enabled: false }] },
        { id: "p2", name: "Orphan", folderId: "gone", colours: [{ hex: "#111111" }, { hex: "#eeeeee" }] },
        { id: "p3", name: "One colour", colours: [{ hex: "#000000" }] },
        { id: "p4", name: "Bad hex", colours: [{ hex: "red" }, { hex: "#12" }] },
        { id: "p1", name: "Duplicate id", colours: [{ hex: "#000000" }, { hex: "#ffffff" }] },
        "junk",
      ],
    });
    expect(parsed.folders.map((f) => f.name)).toEqual(["Keep"]);
    expect(parsed.palettes.map((p) => [p.name, p.folderId])).toEqual([["Good", "f1"], ["Orphan", null]]);
    expect(parsed.palettes[0]!.colours[1]).toEqual({ hex: "#FFFFFF", width: 8, enabled: false });
    expect(parseLibrary(null)).toEqual(emptyLibrary());
    expect(parseLibrary("nope")).toEqual(emptyLibrary());
  });
});
