# Dizako - Summer 2026 Feature Batch

## What was done

Dizako, a Tauri + React + TypeScript + Material 3 Expressive dithering studio, received a major engine and interface overhaul.

### Engine rewrite

The palette shifted from a flat array to a **tonal layer stack**. Each `PaletteLayer` carries:
- A hex colour, editable in the built-in picker
- A tonal position (`level`, 0–1 shadow to highlight), set by stack order
- A weight, sizing the tonal band it owns (and doubling as stripe width in Omino)
- An enable toggle to audition colours without deletion

Four colour matching modes read the stack differently:
- **RGB**: nearest colour by luma-weighted distance
- **Luma**: brightness only; hue ignored
- **OKLab**: perceptually uniform; best for photographs
- **Tonal**: each layer owns a slice of the range, sized by its weight; stack position decides everything

### Algorithms: 14 → 29

Added: Fan, Shiau-Fan, Shiau-Fan 2, Pigeon, Simple 2D, tone-adaptive diffusion, clustered diagonal, line screen, diagonal hatch, checker, blue noise (void-and-cluster), interleaved gradient noise, Riemersma (Hilbert curve), Knuth dot diffusion, and Omino-like.

**Omino-like** marches in one direction (up/down/left/right) carrying a single running error forward and shedding a share sideways into the next line. Fully controllable via:
- March direction
- Error strength (global multiplier; >100% for runaway look)
- Error across (fraction carried forward along the march)
- Error aside (fraction pushed sideways to neighbouring line)
- Initial phase (angle offset, bends straight bands into waves)
- Colour count (how many palette layers participate)

Stripe width comes from each layer's weight. Inspired by the Omino Diffusion After Effects plugin's behaviour and parameter vocabulary; implementation is original.

### Tone and filters

Extended tone controls: exposure, saturation, hue shift, temperature, tint (joining the existing brightness, contrast, gamma, grayscale, invert).

New filters: gaussian blur, unsharp mask.

All applied before dithering so parameter changes genuinely alter what the algorithms must reach for.

### UI

- **Palette panel**: preset library (130 presets across 16 categories) scrolls above; layer stack pinned to bottom. Clicking a preset sends its colours down as layers. Append mode available.
- **Colour picker**: Adobe-style hue ring + saturation/value square, live harmony markers, nine colour rules, HEX/RGB/HSB inputs (all synced), eyedropper sampling the loaded image, five-swatch harmony export.
- **Algorithm panel**: renders only the parameters the selected algorithm declares in its metadata, not a fixed control set.

### Architecture

New modules:
- `src/dither/masks.ts` - ordered-dither threshold masks (Bayer, blue noise, screens)
- `src/dither/color.ts` - colour space conversions shared by engine and picker

Existing modules restructured around the layer model; `src-tauri/` Rust shell untouched.

Legacy Qt/QML implementation lives untracked in `legacy/` and is gitignored.

### Documentation

README written with algorithm families, palette layers explanation, Omino-like detail, colour picker walkthrough, and build instructions. Screenshots pending (user will add).

## Verification

- TypeScript: `tsc --noEmit` clean
- Build: `pnpm build` clean
- Algorithms: headless probe ran all 29 across all 4 match modes; 0 failures, alpha preserved, all 29 producing distinct output
- Native build: `pnpm tauri build` succeeded; release binary at `src-tauri/target/release/dizako` launched successfully on Wayland/Hyprland

All work committed as Alex <alex@milfs.party>; pushed to `ssh://git@code.milfs.party:2222/alex/dizako.git` branch master.

## 2026-08-21 - Rendering, engine fixes, and shell polish

### Rendering pipeline

Two-stage progressive rendering for heavy algorithms. `src/dither/region.ts` computes the visible crop rect with a 96px context margin so error diffusion settles before it reaches the screen; Omino crops only across its march axis, never along it. `src/hooks/useDither.ts` rewritten to run a coarse whole-image pass first (capped at 240k pixels) then a full-resolution pass over the viewport region only, with id-matched worker replies so stale results are dropped.

`src/components/PreviewCanvas.tsx` rewritten: keeps offscreen buffers, draws the coarse layer stretched to the full image rect then the fine layer on top at its region offset, and reports the visible rect back via `onViewport` (quantised so a drag does not re-render every frame).

`src/App.tsx` wired to the new hook contract; export now runs its own full-resolution whole-image pass rather than reusing the (possibly coarse or cropped) preview.

### Engine

Omino "initial phase" control was dead: the running error fully replaced the seed one pixel into each line. Fixed with a standing per-line sinusoidal bias.

Layer stack order previously had no effect in rgb/luma/oklab matching, so swapping colours in a monochrome preset changed nothing. `compilePalette` now computes a tonal centre per layer and the matchers add a tonal penalty scaled by a new `tonalBias` setting (default 0.5), exposed in the UI as a "Stack influence" slider.

### UI

- Palette sidebar widened to 420px on the palette tab.
- Layer rows restructured: hex and weight on one line, a full-width 16px-tall weight slider below.
- Removed the gradient behind the layer list that made the top row look embossed.
- Highlights marker (with icon) above the layer list, Shadows marker below it.
- Reverse-stack button now uses a swap-vertical icon; a new randomise-stack-colours button sits next to it and generates a coherent shadows-to-highlights ramp rather than uniform noise.
- New "Make your own" empty card at the top of the palette library.
- Colour section of the Image panel gained its own Reset; Tone's reset no longer reaches into colour keys.
- Preview HUD: zoom in/out icons enlarged to match Fit and Compare; stopwatch icon added beside the ms counter.
- Settings button moved from the top bar into the left nav rail, pinned to the bottom.
- New icons: `IconSwapVert`, `IconCasino`, `IconTimer`, `IconHighlights`, `IconShadows`.

### Shell

- Ctrl+Z undo, Ctrl+Shift+Z and Ctrl+Y redo, with time-coalesced history (450ms) so one slider drag is one undo step.
- Ctrl+A no longer selects the whole interface outside text fields.
- Right-click context menu suppressed, kept as a single handler so a real menu can be routed in later.

## Open / future items

- **matugen theme mode** next to Preset and Dynamic, a matugen template, and README docs for it.
- **Language option** under Settings, i18n wiring, and a `TRANSLATIONS_TODO_FILL.json` with English filled in and empty slots for other languages.
- **House style rule**: no em dashes anywhere (UI copy, comments, docs, commit messages). Not yet swept from the codebase.
- **AppImage bundling** fails with "failed to run linuxdeploy"; release binary builds fine. Because appimage is first in `bundle.targets` in `src-tauri/tauri.conf.json`, .deb and .rpm targets never run.
