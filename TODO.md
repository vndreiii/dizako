# Dizako TODO

Everything asked for, in one place. Checked items are implemented and building;
unchecked ones are still open.

## Rendering

- [x] **Progressive preview.** Show a fast, lower-quality pass immediately and
      replace it with the full-quality one as it lands, so heavy algorithms
      (dot matrix and friends) stay interactive while sliders move.
- [x] **Viewport cropping.** When zoomed in, work out which part of the image is
      actually on screen and run the sharp pass over that region only, instead
      of dithering pixels nobody can see.
- [x] **Omino "initial phase" did nothing.** The seed was being overwritten one
      pixel into each line, so the control had no effect. Now a standing
      per-line bias.

## Palette and layers

- [x] **Stack order had no effect.** Swapping the two colours of a monochrome
      preset changed nothing, because nearest-colour matching ignores order.
      Layer position now biases matching toward the tonal band it occupies.
- [x] Expose that as a "Stack influence" slider, so the behaviour is visible
      rather than mysterious.
- [x] Widen the palette sidebar.
- [x] Better weight slider. The old 4px track with a 12px thumb was a hairline
      to aim at; hex and weight now share a line and the slider gets the row.
- [x] Drop the odd 3D/inset look on the first layer row (a gradient behind the
      list was lighting the top row from above).
- [x] Icon plus "Highlights" at the top of the layer list, "Shadows" at the
      bottom, so the direction of the stack needs no explaining.
- [x] Reverse-stack button read as a random-colour button. It is now a
      swap-vertical icon, with a real randomise-stack-colours button next to it.
- [x] A "make your own" row at the top of the palette library: one empty card
      with a big plus, under Matching and above Monochrome.
- [x] The colour editor is the custom Adobe-style picker (wheel, harmony rules,
      SV square, eyedropper). No system colour input anywhere in the app.

## Image panel

- [x] The Colour section had no Reset while Tone and Filters did. It has one
      now, and Tone's reset no longer silently reaches into the colour keys.

## Preview HUD

- [x] Zoom in and zoom out were smaller and fainter than Fit and Compare.
      Matched.
- [x] Stopwatch icon to the left of the millisecond counter.

## Shell and input

- [x] Ctrl+Z undo, Ctrl+Shift+Z / Ctrl+Y redo, coalesced so one slider drag is
      one step.
- [x] Ctrl+A no longer selects the whole interface outside text fields.
- [x] Right-click menu suppressed on the canvas, kept as one handler so a real
      context menu can be routed in later.
- [x] Settings button moved into the left rail, pinned to the bottom, on the
      same X as Algorithm / Palette / Image.

## Theming

- [x] **matugen theme mode** next to Preset and Dynamic, driven by matugen's
      generated colours.
- [x] Ship a matugen template.
- [x] Document how to use matugen in the README.

## Localisation

- [x] Language option under Settings.
- [x] i18n wiring so every string in the UI comes from a catalogue rather than
      being hardcoded.
- [x] `TRANSLATIONS_TODO_FILL.json`: English filled in, every other language
      left as empty slots in a fixed format, so the file can be handed to
      another model to translate. Gemini via `agy -p` is an option for doing
      some of them in place.

## House style

- [x] No em dashes. Anywhere. UI copy, comments, docs, commit messages.

## Packaging

- [x] AppImage bundling fails (`failed to run linuxdeploy`). The release binary
      builds fine; because appimage is first in `bundle.targets`, .deb and .rpm
      never run.
