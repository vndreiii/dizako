import { makeLayer, type PaletteLayer } from "./types";
import { respread } from "./paletteOps";

/**
 * The user's saved palettes and the folders that hold them.
 *
 * Pure data and pure functions: every operation takes a library and returns a
 * new one, so the UI can keep it in React state, undo a delete by restoring the
 * previous value, and persist it with a plain JSON round trip.
 *
 * Folders are one level deep. That is deliberate - the point is to keep a
 * handful of related palettes together, and a tree you have to navigate stops
 * being quicker than the flat list it replaced.
 */

export interface SavedColour {
  hex: string;
  /** Relative weight; see `PaletteLayer.width`. */
  width: number;
  enabled: boolean;
}

export interface SavedPalette {
  id: string;
  name: string;
  /** Shadows first, as the stack stores them. */
  colours: SavedColour[];
  /** Null for a palette that lives at the top level. */
  folderId: string | null;
  savedAt: number;
}

export interface PaletteFolder {
  id: string;
  name: string;
  expanded: boolean;
}

export interface PaletteLibrary {
  version: 1;
  folders: PaletteFolder[];
  palettes: SavedPalette[];
}

export const emptyLibrary = (): PaletteLibrary => ({ version: 1, folders: [], palettes: [] });

let seq = 0;
/** Unique within a session and across reloads: time plus a counter plus noise. */
export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(++seq).toString(36)}-${Math.floor(Math.random() * 1296).toString(36)}`;
}

/** `base`, or `base 2`, `base 3`... - the first that nothing else already uses. */
export function uniqueName(taken: string[], base: string): string {
  const clean = base.trim() || "Untitled";
  const used = new Set(taken.map((n) => n.trim().toLowerCase()));
  if (!used.has(clean.toLowerCase())) return clean;
  for (let n = 2; ; n++) {
    const candidate = `${clean} ${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

export function coloursFromLayers(layers: PaletteLayer[]): SavedColour[] {
  return layers.map((l) => ({ hex: l.hex.toUpperCase(), width: l.width, enabled: l.enabled }));
}

/** Fresh layers from a saved palette, with levels spread across the range. */
export function layersFromSaved(palette: SavedPalette): PaletteLayer[] {
  return respread(
    palette.colours.map((c) => {
      const layer = makeLayer(c.hex, 0, c.width);
      layer.enabled = c.enabled;
      return layer;
    }),
  );
}

/** Does the stack hold exactly this palette's colours, in order? */
export function sameAsStack(palette: SavedPalette, layers: PaletteLayer[]): boolean {
  return (
    palette.colours.length === layers.length &&
    palette.colours.every((c, i) => c.hex.toLowerCase() === layers[i]!.hex.toLowerCase())
  );
}

export function savePalette(
  library: PaletteLibrary,
  input: { name: string; layers: PaletteLayer[]; folderId: string | null },
): { library: PaletteLibrary; id: string } {
  const folderId = library.folders.some((f) => f.id === input.folderId) ? input.folderId : null;
  const siblings = library.palettes.filter((p) => p.folderId === folderId).map((p) => p.name);
  const palette: SavedPalette = {
    id: newId("pal"),
    name: uniqueName(siblings, input.name),
    colours: coloursFromLayers(input.layers),
    folderId,
    savedAt: Date.now(),
  };
  return { library: { ...library, palettes: [...library.palettes, palette] }, id: palette.id };
}

export function createFolder(library: PaletteLibrary, name: string): { library: PaletteLibrary; id: string } {
  const folder: PaletteFolder = {
    id: newId("fld"),
    name: uniqueName(library.folders.map((f) => f.name), name),
    expanded: true,
  };
  return { library: { ...library, folders: [...library.folders, folder] }, id: folder.id };
}

export function renamePalette(library: PaletteLibrary, id: string, name: string): PaletteLibrary {
  const target = library.palettes.find((p) => p.id === id);
  if (!target) return library;
  const siblings = library.palettes.filter((p) => p.folderId === target.folderId && p.id !== id).map((p) => p.name);
  const next = uniqueName(siblings, name);
  return { ...library, palettes: library.palettes.map((p) => (p.id === id ? { ...p, name: next } : p)) };
}

export function renameFolder(library: PaletteLibrary, id: string, name: string): PaletteLibrary {
  if (!library.folders.some((f) => f.id === id)) return library;
  const siblings = library.folders.filter((f) => f.id !== id).map((f) => f.name);
  const next = uniqueName(siblings, name);
  return { ...library, folders: library.folders.map((f) => (f.id === id ? { ...f, name: next } : f)) };
}

export function deletePalette(library: PaletteLibrary, id: string): PaletteLibrary {
  return { ...library, palettes: library.palettes.filter((p) => p.id !== id) };
}

/** Removes a folder; its palettes either go with it or move up to the top level. */
export function deleteFolder(library: PaletteLibrary, id: string, keepPalettes: boolean): PaletteLibrary {
  return {
    ...library,
    folders: library.folders.filter((f) => f.id !== id),
    palettes: keepPalettes
      ? library.palettes.map((p) => (p.folderId === id ? { ...p, folderId: null } : p))
      : library.palettes.filter((p) => p.folderId !== id),
  };
}

export function movePalette(library: PaletteLibrary, id: string, folderId: string | null): PaletteLibrary {
  const target = library.palettes.find((p) => p.id === id);
  if (!target || target.folderId === folderId) return library;
  if (folderId !== null && !library.folders.some((f) => f.id === folderId)) return library;
  const siblings = library.palettes.filter((p) => p.folderId === folderId).map((p) => p.name);
  const name = uniqueName(siblings, target.name);
  return { ...library, palettes: library.palettes.map((p) => (p.id === id ? { ...p, folderId, name } : p)) };
}

export function setFolderExpanded(library: PaletteLibrary, id: string, expanded: boolean): PaletteLibrary {
  return { ...library, folders: library.folders.map((f) => (f.id === id ? { ...f, expanded } : f)) };
}

/** Overwrites a saved palette's colours with the current stack, keeping its name and place. */
export function updatePaletteColours(library: PaletteLibrary, id: string, layers: PaletteLayer[]): PaletteLibrary {
  return {
    ...library,
    palettes: library.palettes.map((p) => (p.id === id ? { ...p, colours: coloursFromLayers(layers), savedAt: Date.now() } : p)),
  };
}

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * Reads a stored library, keeping whatever is sound.
 *
 * Storage can hold anything - an older build's shape, a hand-edited file, half
 * a write - and one bad entry must not cost the user the rest. Anything that
 * does not validate is dropped; palettes pointing at a missing folder move to
 * the top level.
 */
export function parseLibrary(raw: unknown): PaletteLibrary {
  const lib = emptyLibrary();
  if (!raw || typeof raw !== "object") return lib;
  const data = raw as { folders?: unknown; palettes?: unknown };

  const folderIds = new Set<string>();
  for (const f of Array.isArray(data.folders) ? data.folders : []) {
    if (!f || typeof f !== "object") continue;
    const { id, name, expanded } = f as Record<string, unknown>;
    if (typeof id !== "string" || typeof name !== "string" || folderIds.has(id)) continue;
    folderIds.add(id);
    lib.folders.push({ id, name: name.slice(0, 80), expanded: expanded !== false });
  }

  const paletteIds = new Set<string>();
  for (const p of Array.isArray(data.palettes) ? data.palettes : []) {
    if (!p || typeof p !== "object") continue;
    const { id, name, colours, folderId, savedAt } = p as Record<string, unknown>;
    if (typeof id !== "string" || typeof name !== "string" || paletteIds.has(id) || !Array.isArray(colours)) continue;
    const valid: SavedColour[] = [];
    for (const c of colours) {
      if (!c || typeof c !== "object") continue;
      const { hex, width, enabled } = c as Record<string, unknown>;
      if (typeof hex !== "string" || !HEX.test(hex)) continue;
      valid.push({
        hex: hex.toUpperCase(),
        width: typeof width === "number" && Number.isFinite(width) ? Math.min(8, Math.max(0.25, width)) : 2,
        enabled: enabled !== false,
      });
    }
    if (valid.length < 2) continue;
    paletteIds.add(id);
    lib.palettes.push({
      id,
      name: name.slice(0, 80),
      colours: valid.slice(0, 32),
      folderId: typeof folderId === "string" && folderIds.has(folderId) ? folderId : null,
      savedAt: typeof savedAt === "number" ? savedAt : 0,
    });
  }
  return lib;
}
