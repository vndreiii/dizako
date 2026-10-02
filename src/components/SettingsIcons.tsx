import type { ReactNode } from "react";

/**
 * Category glyphs for the settings navigation.
 *
 * Material 3 navigation swaps an outlined icon for a filled one when its item
 * is selected. Rather than two separate drawings that can only be swapped, each
 * glyph is one drawing in two parts: a `body` that is stroked and takes a fill
 * when selected, and `cut` details that are drawn in the pill's colour so they
 * read as holes in the filled body. CSS transitions the fill and the cut
 * colour, so the change animates instead of popping.
 */
export type NavGlyphId = "appearance" | "canvas" | "performance" | "language" | "shortcuts" | "about";

const PARTS: Record<NavGlyphId, ReactNode> = {
  appearance: (
    <>
      <path
        className="ng-body"
        d="M12 3.2a8.8 8.8 0 1 0 0 17.6c1.2 0 2-.9 2-2 0-.6-.2-1-.5-1.4-.3-.4-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8h2.2a4.6 4.6 0 0 0 4.6-4.6C21.1 6.8 17 3.2 12 3.2Z"
      />
      <path className="ng-cut ng-dot" d="M7.4 12.2h.01M9.3 8.2h.01M13.6 7.4h.01M17 10.6h.01" />
    </>
  ),
  canvas: (
    <>
      <rect className="ng-body" x="3.5" y="3.5" width="17" height="17" rx="3.5" />
      <path className="ng-cut" d="M9 15l6-6M10.2 9h4.8v4.8" />
    </>
  ),
  performance: (
    <>
      <circle className="ng-body" cx="12" cy="13.2" r="7.8" />
      <path className="ng-line" d="M9.5 2.8h5M18.4 6.2l1.3-1.3" />
      <path className="ng-cut" d="M12 13.2V9" />
    </>
  ),
  language: (
    <>
      <circle className="ng-body" cx="12" cy="12" r="8.8" />
      <path className="ng-cut" d="M3.2 12h17.6" />
      <path className="ng-cut" d="M12 3.2c2.3 2.4 3.5 5.3 3.5 8.8s-1.2 6.4-3.5 8.8c-2.3-2.4-3.5-5.3-3.5-8.8s1.2-6.4 3.5-8.8Z" />
    </>
  ),
  shortcuts: (
    <>
      <rect className="ng-body" x="2.6" y="5.6" width="18.8" height="12.8" rx="2.8" />
      <path className="ng-cut ng-dot" d="M6.6 9.6h.01M10.2 9.6h.01M13.8 9.6h.01M17.4 9.6h.01" />
      <path className="ng-cut" d="M7.6 14h8.8" />
    </>
  ),
  about: (
    <>
      <circle className="ng-body" cx="12" cy="12" r="8.8" />
      <path className="ng-cut" d="M12 11v5" />
      <path className="ng-cut ng-dot" d="M12 7.7h.01" />
    </>
  ),
};

export function NavGlyph({ id }: { id: NavGlyphId }) {
  return (
    <svg className="navglyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {PARTS[id]}
    </svg>
  );
}
