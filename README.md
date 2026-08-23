<div align="center">

<img src="public/icon.png" width="128" alt="Dizako" />

# Dizako

**A dithering studio.** Turn an image into a palette you control — 29
algorithms, 130 palettes, and a layer stack that decides which colour lands
in the shadows and which in the highlights.

Built with Tauri, React and Material 3. Everything runs locally: no uploads,
no tracking.

<table>
  <tr>
    <td align="center" width="33%">
      <img src="screenshots/mockup__algo_1787436742.png" alt="Algorithm picker" />
      <br />
      <sub>Algorithms</sub>
    </td>
    <td align="center" width="33%">
      <img src="screenshots/mockup_palette_1787437669.png" alt="Palette editor" />
      <br />
      <sub>Palettes</sub>
    </td>
    <td align="center" width="33%">
      <img src="screenshots/mockup__image_1787437379.png" alt="Image controls" />
      <br />
      <sub>Image</sub>
    </td>
  </tr>
</table>

</div>

---

## What it does

Load an image, pick an algorithm and a palette, tune until it looks right,
export a PNG. Every slider re-renders live; a compare wipe shows original vs
dithered.

- **Error diffusion** — Floyd–Steinberg, Jarvis, Stucki, Sierra, Atkinson and friends.
- **Ordered** — Bayer, halftone screens, line screens, blue noise, checkerboard.
- **Threshold / experimental** — hard threshold, random noise, Riemersma, dot diffusion, Omino-like.
- **Palette layers** — colours stacked by tonal position, so you choose what goes where, not just what's closest.
- **Image controls** — exposure, contrast, gamma, saturation, hue shift, blur, sharpen, all applied before the dither.

## Building

Needs Rust, Node 22+, pnpm and wasm-pack, plus `webkit2gtk-4.1` on Linux.

```bash
pnpm install
pnpm tauri dev            # run it
pnpm tauri build          # bundles into src-tauri/target/release/bundle
```

Frontend only: `pnpm dev` / `pnpm build`.

## Matugen theming

Dizako can take its accent colour from [matugen](https://github.com/InioX/matugen):

1. Copy `templates/matugen-template.json` into your matugen templates directory.
2. Point matugen at it:
   ```toml
   [templates.dizako]
   input_path = "~/.config/matugen/templates/dizako-matugen.json"
   output_path = "~/.config/dizako/colors.json"
   ```
3. Run matugen, then pick **Settings → Accent → Matugen** in Dizako.

## Licence

MIT.
