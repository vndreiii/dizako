<div align="center">

<img src="public/icon.png" width="128" alt="Dizako" />

# Dizako

**A dithering studio.** Load an image, pick from 29 algorithms and 130
palettes, and decide which colours land in the shadows and which in the
highlights.

Built with Tauri, React, and Material 3. Everything runs locally. No uploads,
no tracking.

<table>
  <tr>
    <td align="center" width="33%">
      <a href="https://code.milfs.party/alex/dizako/src/branch/master/screenshots/mockup__algo_1787436742.png">
        <img src="screenshots/mockup__algo_1787436742.png" alt="Algorithm picker" />
      </a>
      <br />
      <sub>Algorithms</sub>
    </td>
    <td align="center" width="33%">
      <a href="https://code.milfs.party/alex/dizako/src/branch/master/screenshots/mockup_palette_1787437669.png">
        <img src="screenshots/mockup_palette_1787437669.png" alt="Palette editor" />
      </a>
      <br />
      <sub>Palettes</sub>
    </td>
    <td align="center" width="33%">
      <a href="https://code.milfs.party/alex/dizako/src/branch/master/screenshots/mockup__image_1787437379.png">
        <img src="screenshots/mockup__image_1787437379.png" alt="Image controls" />
      </a>
      <br />
      <sub>Image</sub>
    </td>
  </tr>
</table>

</div>

---

## What it does

Open an image, choose an algorithm and a palette, tune until it looks right,
then export a PNG. Sliders re-render live. A compare wipe shows original vs
dithered.

| Area | Includes |
| --- | --- |
| **Error diffusion** | Floyd-Steinberg, Jarvis, Stucki, Sierra, Atkinson, and friends |
| **Ordered** | Bayer, halftone screens, line screens, blue noise, checkerboard |
| **Threshold / experimental** | Hard threshold, random noise, Riemersma, dot diffusion, Omino-like |
| **Palette layers** | Colours stacked by tonal position, so you choose what goes where |
| **Image controls** | Exposure, contrast, gamma, saturation, hue, blur, sharpen (before dither) |

## Building

Dizako includes a `./build-all.sh` script that automatically checks for missing dependencies, compiles the WebAssembly engine, builds the frontend, and bundles the application for your operating system (producing `.deb`, `.rpm`, `.AppImage`, and an Arch `.pkg.tar.zst` package on Linux).

To build everything, just run:
```bash
./build-all.sh
```

### Dependencies
Before building, ensure you have the following installed:
- **Core build tools**: Node 22+, `pnpm`, Rust (`cargo`), and `wasm-pack`.
- **Rust Wasm target**: The WebAssembly target for Rust must be installed (`rustup target add wasm32-unknown-unknown` or the `rust-wasm` package via `pacman`).
- **Linux Tauri dependencies**: `webkit2gtk-4.1`, `base-devel`, `curl`, `wget`, `openssl`, `appmenu-gtk-module`, `gtk3`, `libvips`, `libayatana-appindicator`. *(Note: `./build-all.sh` will automatically prompt to install these for you via `pkexec pacman` if you are on Arch Linux)*.

### Manual Build
If you prefer not to use the automated script:
```bash
# Compile the WebAssembly engine first
wasm-pack build dither-wasm --release --target web --out-dir pkg

# Install frontend dependencies
pnpm install

# Run the app
pnpm tauri dev            # development mode
pnpm tauri build          # bundle into src-tauri/target/release/bundle
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

## License

MIT.
