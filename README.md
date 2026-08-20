<div align="center">

<img src="public/icon.png" width="128" alt="Dizako" />

# Dizako

**A dithering studio.** 29 algorithms, 130 palettes, and a tonal layer stack that
lets you decide which colour lands in the shadows and which lands in the highlights.

Built with Tauri, React and Material 3 Expressive. Everything runs locally —
no uploads, no network calls, no telemetry.

</div>

---

## Screenshots

<!-- Screenshots go here. -->

---

## What it does

Dizako takes an image and reduces it to a palette you control, using classic
halftoning and error-diffusion algorithms. It is built for tuning: every
parameter is live, the preview re-renders on a worker thread, and a split
compare wipe sits over the canvas so you can see what you changed.

### Algorithms

Twenty-nine, grouped by family.

| Family | Algorithms |
| --- | --- |
| **Error diffusion** | Floyd–Steinberg, False Floyd–Steinberg, Jarvis–Judice–Ninke, Stucki, Burkes, Sierra, Two-row Sierra, Sierra Lite, Stevenson–Arce, Atkinson, Fan, Shiau–Fan, Shiau–Fan 2, Pigeon, Simple 2D |
| **Ordered** | Bayer (2×2 – 16×16), Clustered halftone, Diagonal cluster, Line screen, Diagonal hatch, Checker, Blue noise, Interleaved gradient noise |
| **Threshold** | Hard threshold, Random threshold |
| **Experimental** | Riemersma (Hilbert curve), Dot diffusion (Knuth), Tone-adaptive diffusion, Omino-like |

Each one exposes only the parameters that actually apply to it — diffusion
strength, serpentine scanning, kernel jitter and error clamping for the
diffusion family; matrix size, cell size, screen angle and noise scale for the
ordered family; queue length and decay for Riemersma; and so on.

Notes on the less common ones:

- **Blue noise** uses a void-and-cluster mask generated at startup and cached —
  grain with no visible structure at any scale.
- **Riemersma** diffuses along a Hilbert curve with a short decaying error
  queue, so it has none of the diagonal worming that row-wise diffusion gets.
- **Dot diffusion** ranks pixels through a class matrix and only ever pushes
  error into pixels that have not been decided yet.
- **Tone-adaptive diffusion** varies its coefficients with brightness: near
  black and near white the error runs forward along the row instead of
  downward, which is what kills worm artefacts in the extremes.

### Omino-like

An error diffusion applied for the worse.

Instead of spreading error over a two-dimensional kernel, it marches in a single
direction — up, down, left or right — carrying one running error forward along
the line and shedding a share of it sideways into the next one. Nothing about
that is balanced, and that is the point: the error never settles, so it piles up
into long marching bands.

Fully controllable:

| Control | What it does |
| --- | --- |
| **March direction** | Which way the line walks. |
| **Error strength** | Global multiplier on the residual. Push past 100% for the runaway look. |
| **Error across** | Share carried forward to the next pixel in the march. |
| **Error aside** | Share pushed sideways into the neighbouring line. |
| **Initial phase** | Angle offsetting each line's starting error, bending straight bands into waves. |
| **Colour count** | How many layers of the stack the march is allowed to use. |

Stripe width comes from each layer's **weight** in the Palette tab — a wide
layer wins more pixels and holds them for longer runs, which is where the fat
stripes come from. Eyedropping a handful of colours straight out of the source
image is the classic way to use it.

Inspired by the Omino Diffusion plugin's behaviour and parameter vocabulary; the
implementation here is original.

### Palette layers

The palette is a **stack**, not a list. It is pinned to the bottom of the
Palette tab so it stays in reach while you scroll the library above it.

Each layer carries:

- a **colour**, editable in the built-in picker;
- a **tonal position**, set by where it sits in the stack — top is highlights,
  bottom is shadows. Move a layer up and it starts colouring brighter parts of
  the image;
- a **weight**, which sizes the tonal band it owns (and doubles as stripe width
  in Omino);
- an **enable toggle**, so you can audition a colour without deleting it.

Clicking any library preset sends its colours down into the stack as layers.
The `+` next to a preset appends instead of replacing.

Four matching modes decide how a pixel finds its layer:

| Mode | Behaviour |
| --- | --- |
| **RGB** | Nearest colour by luma-weighted RGB distance. |
| **Luma** | Brightness only; hue is ignored entirely. |
| **OKLab** | Perceptual distance. Best for photographic palettes. |
| **Tonal** | Each layer owns a slice of the tonal range. Stack position decides everything. |

### Colour picker

A hue ring with a saturation/value square inside it, live harmony markers on the
rim, and nine Adobe-style colour rules — analogous, monochromatic, triad,
complementary, split, double split, square, compound and shades. HEX, RGB and
HSB inputs all stay in sync, and the eyedropper samples straight from the loaded
image. The five-swatch harmony set can be dropped into the layer stack in one
click.

### Palettes

130 presets across 16 categories: Monochrome, Consoles, Home Computers,
Terminals, Editor Themes, Pixel Art, Duotone, Tritone, Film & Photo,
Print & Riso, Neon & Synth, Pastel, Nature, Earth & Clay, Metals and Web Safe.

### Image controls

- **Resolution** — pixel scale from 1:1 down to ⅛ for coarser, chunkier dots.
- **Tone** — exposure, brightness, contrast, gamma.
- **Colour** — saturation, hue shift, temperature, tint.
- **Filters** — gaussian blur, unsharp mask, grayscale, invert.

Everything is applied *before* the dither runs, so pushing contrast genuinely
changes which colours the algorithm has to reach for.

### Interface

Material 3 Expressive throughout, with a dynamic colour mode that extracts the
accent from whatever image you have loaded (via `material-color-utilities`
quantisation and scoring). Light and dark, and a custom title bar — no GTK
decorations.

---

## Building

Requires Rust, Node and pnpm, plus the usual Tauri Linux dependencies
(`webkit2gtk-4.1`, `libappindicator`, `librsvg`).

```bash
pnpm install
pnpm tauri dev            # development, with hot reload
pnpm tauri build          # AppImage, .deb and .rpm into src-tauri/target/release/bundle
```

Frontend only:

```bash
pnpm dev                  # vite dev server on :1420
pnpm build                # type-check and bundle into dist/
```

---

## Architecture

```
src/
  dither/
    types.ts        Settings, layers, algorithm metadata
    algorithms.ts   The engine — every pass lives here
    masks.ts        Ordered-dither threshold masks (Bayer, blue noise, screens)
    color.ts        Colour space conversions shared by engine and picker
    palettes.ts     The preset library
    worker.ts       Worker entry point
  components/       Panels, canvas, picker, M3 primitives
  hooks/
    useDither.ts    Worker dispatch, request coalescing, main-thread fallback
  theme/            M3 token generation and dynamic colour extraction
src-tauri/          Rust shell
legacy/             The original Qt/QML implementation (not tracked)
```

The dither pass runs in a web worker with the pixel buffer transferred rather
than copied. Requests coalesce: while one run is in flight the latest settings
replace any queued run, so dragging a slider never builds a backlog. If the
worker cannot be constructed — which happens under some WebKitGTK builds — the
hook detects it and falls back to the main thread rather than leaving the
preview blank.

The preview canvas is always exactly the size of its stage; zoom and pan are
draw parameters, not element dimensions. An in-document canvas at a large
image's natural size becomes a compositing layer of that size, which WebKit
silently fails to paint.

---

## Licence

MIT.
