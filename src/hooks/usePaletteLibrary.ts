import { useCallback, useEffect, useRef, useState } from "react";
import { emptyLibrary, parseLibrary, type PaletteLibrary } from "../dither/paletteLibrary";

/**
 * Persistence for the saved-palette library.
 *
 * localStorage, for the same reasons the session uses it: identical in the
 * browser and in the desktop webview, synchronous so there is no empty flash on
 * open, and nothing to configure. A failed write (private mode, a full quota)
 * is swallowed - the library still works for the session and the user is not
 * interrupted over a convenience.
 */
const KEY = "dizako-palettes.v1";

function load(): PaletteLibrary {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? parseLibrary(JSON.parse(raw)) : emptyLibrary();
  } catch {
    return emptyLibrary();
  }
}

export function usePaletteLibrary() {
  const [library, setLibraryState] = useState<PaletteLibrary>(load);
  const first = useRef(true);

  useEffect(() => {
    // Nothing to write until something changed.
    if (first.current) {
      first.current = false;
      return;
    }
    try {
      localStorage.setItem(KEY, JSON.stringify(library));
    } catch {
      // See above.
    }
  }, [library]);

  const update = useCallback((change: (current: PaletteLibrary) => PaletteLibrary) => {
    setLibraryState((current) => change(current));
  }, []);

  return { library, update, replace: setLibraryState };
}
