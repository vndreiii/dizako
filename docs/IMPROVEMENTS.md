# Dizako — Improvement Analysis

Findings below are based on a full read of the actual tree: `src/` (React 19 + TS frontend,
~29 dither algorithms in `src/dither/algorithms.ts`), `src-tauri/` (Rust shell, currently
7 lines of glue in `src-tauri/src/lib.rs`), `dither-wasm/` (scaffolded Rust→WASM port),
and `packaging/`. Line references point at today's code.

Current architecture summary, because everything below hangs off it:

- All pixel work runs **in TypeScript**, inside a module **Web Worker**
  (`src/dither/worker.ts`) with a watchdog that demotes to main thread if worker
  construction fails under WebKitGTK (`src/hooks/useDither.ts:205`).
- The preview is two-staged: a coarse whole-image pass capped at ~240 kpx
  (`COARSE_PIXELS`, `useDither.ts:31`), then a fine pass cropped to the visible
  viewport plus a 96 px diffusion margin (`src/dither/region.ts:19`). Requests coalesce;
  stale replies are dropped.
- `PreviewCanvas` draws only the stage-sized canvas and re-fits zoom/pan as draw
  parameters (`src/components/PreviewCanvas.tsx:98`), compositing coarse + fine +
  original layers from offscreen buffers.
- The Rust side registers only `dialog` and `fs` plugins; it does no image work.

---

## 1. Making the app better overall

### 1.1 Nothing except the UI language survives a restart
`localStorage` holds exactly one key: `dizako-locale` (`src/i18n.tsx:26`). Theme mode,
theme source, seed colour, algorithm, palette stack and all tuning values reset on every
launch. For a tuning tool whose default is "Floyd–Steinberg on a black/white stack",
users will rebuild their setup each session. Concretely:

- Persist at least `{mode, themeSource, seed, locale}` — the same shape
  `SettingsSheet.tsx` already edits — plus the full `Settings` object. A versioned JSON
  under `BaseDirectory.AppConfig` (the app already reads `colors.json` from there in
  `App.tsx:159`) keeps browser-mode and Tauri-mode behaviour identical via localStorage.
- Add *palette presets* save/load while you're in there: `PalettePanel` already has a
  library concept; user stacks are the natural next step and cost one serializer.

### 1.2 No recent-files / session restore / file associations
The window opens empty every time. Low-cost additions that fit the existing code:

- Remember the last N opened paths (dialog plugin already returns paths) and offer them
  on the empty state (`App.tsx:458`).
- Register `MimeType=image/png;image/jpeg;image/webp;...` in the desktop entry (see
  §3.4 — currently absent) and handle argv file-open in `lib.rs` so "Open With" works.

### 1.3 Export is PNG-only and freezes the UI
`exportPng` (`App.tsx:266`) runs the **full-resolution dither synchronously on the main
thread** (`dither(source, settings)` at line 270), then `canvas.toBlob(..., "image/png")`
on the main thread too. On a 16 MP source that is seconds of dead UI, twice. Fixes:

- Route the export through the existing worker (it already accepts arbitrary
  width/height buffers) or a dedicated export worker; show progress; make it cancellable.
  The infrastructure (job ids, queueing, watchdog) already exists in `useDither`.
- Encode in the worker via `OffscreenCanvas.convertToBlob()`, or move encoding to Rust
  (`image` crate) — the latter unlocks JPEG/WebP/AVIF/QoI controls almost for free and
  avoids shipping 64 MB pixel blobs through `postMessage`.

### 1.4 Translation coverage is partial — and enforced nowhere
The catalogue lives at `src/locales/translations.json`. Hardcoded English still lives in
`PreviewCanvas` HUD labels ("Fit to window", "refining…", `PreviewCanvas.tsx:332–388`),
snackbars in `App.tsx` ("Loaded …", "Exported PNG", "That file is not an image"),
`SettingsSheet` headings, and the empty-state body at `App.tsx:464`. Also:

- `t()` (`i18n.tsx:37`) does flat `dict[key]` lookups; add a dev-mode warning when a key
  resolves to itself so regressions are visible instead of silent.
- Ship locales as separate chunks (`import(`./locales/${locale}.json`)` on demand);
  today all 18 languages ride along in the main bundle via
  `src/locales/translations.json` (≈50 KB) even though most users need one.

### 1.5 Keyboard surface is minimal
Only Ctrl+Z/Y/A are handled (`App.tsx:307`). Cheap wins consistent with an editor app:
Ctrl+O open, Ctrl+E/Ctrl+S export, `+/-/0` zoom & fit, arrow-key nudging of focused
sliders, `F` fit, `C` compare. The handlers and focus management already exist; this is
pure addition.

### 1.6 Window behaviour details
With `decorations: false` (`tauri.conf.json:23`) the custom chrome owns everything:

- Double-click on the `data-tauri-drag-region` topbar doesn't toggle maximise
  (`WindowControls.tsx` handles button clicks only).
- Window geometry/state isn't restored between launches (worth folding into §1.1).

### 1.7 Code health
- **No tests anywhere**: no vitest/node test runner in `package.json`, no `cargo test`
  targets. The dither engine is pure and deterministic (`makeRandom` seeds fixed,
  `algorithms.ts:564`) — ideal for golden-image regression tests. This matters doubly
  given item §4.2 (WASM port must be provably identical to the TS engine).
- `eslint-disable` comments exist (`useDither.ts:250`) but no ESLint config is in the
  repo — either the config is missing or it's global-only; commit it.
- **Version drift**: `package.json` 1.1.0 and `tauri.conf.json` 1.1.0 vs
  `src-tauri/Cargo.toml` 0.2.0. Bump or generate from one source.
- `pnpm-workspace.yaml` contains literal placeholder text
  (`allowBuilds: esbuild: set this to true or false`). That key isn't real pnpm syntax;
  you presumably want `onlyBuiltDependencies: [esbuild]` — as written it can silently
  break fresh installs where esbuild's postinstall is blocked (which is also what the
  PKGBUILD's `pnpm install --ignore-scripts` collides with).
- Working-tree clutter (all gitignored, but confusing): `src/dizako/` is a *second full
  clone of this repo including its own `.git`*, plus `packaging/src/`,
  `packaging/dizako/`, `packaging/pkg/`, stray `dist/` trees. Move build scratch outside
  the repo or `make clean` it; anyone grepping the project will trip over four copies of
  the source.
- `legacy/` (Qt port) is intentionally untracked; consider a note in README so the
  CMakeLists/qml files aren't mistaken for active code.

---

## 2. Making it snappier / more responsive

The two-stage preview design is genuinely good — these are the remaining hot spots, in
order of measured-by-inspection impact:

### 2.1 Every slider tick copies and re-prepares far more than necessary
One settings change ⇒ new job ⇒ (`useDither.ts:253–285`):

- `new Uint8ClampedArray(job.input.data)` — a **full copy of the input buffer per
  dispatch** (line 264). For a fine pass over a zoomed viewport this is small, but the
  ≤420 kpx single-pass/coarse path copies up to ~1.7 MB per tick purely because the
  buffer must survive its own transfer. Keep two ping-pong ArrayBuffers (transfer A,
  keep B as master; refill B from `ImageData` only when the source actually changes),
  or hold the master copy *in the worker* and send only settings after the first frame.
- `prepare()` (`algorithms.ts:309`) reruns tone LUT + hue/temp/tint/sat + box-blur ×3 +
  optional unsharp on **every** pass, including palette-only edits. Split `Settings`
  into tone/filter keys vs dither keys and memoise `prepare()`'s Float32Array on the
  tone subset (it's pure). Palette tweaks then skip grading entirely — and grading is
  the dominant cost when blur/sharpen > 0 (box blur is separable but still O(3·passes·w·h)).
- `compilePalette()` (`algorithms.ts:64`) recomputes OKLab conversions, band edges and
  pull factors per call with no cache. Key it on a cheap hash of
  `(layers, limit, bias)` — layers change rarely relative to slider drags.

### 2.2 The OKLab matcher is the inner-loop bottleneck
`matchOklab` (`algorithms.ts:175`) calls `rgbToOklab` **per pixel**, which performs three
`Math.pow` calls (sRGB→linear) and three `Math.cbrt` per channel triple, *then* loops the
palette. Options, cheapest first:

- 256-entry (or 1024-entry interpolated) LUT for `srgbToLinear` — the input to matching
  comes from `prepare()` which clamps to 0..255, so precision loss is invisible.
- Cache `Math.cbrt` results via a small LUT over the MVS range, or replace
  `cbrt(x)` with `pow(x, 1/3)` hoisted out… better: precompute linear RGB per pixel once
  (3 LUT lookups), then the per-pixel transform is 9 multiplies + 3 cbrt + matrix.
  Even simpler and very effective: since palettes are tiny (≤12 entries), quantise the
  pixel to a 15-bit key `(r>>3,g>>3,b>>3)` and memoise nearest-match results in an
  Int32Array(32768) per compiled palette — classic trick, huge win on photos with flat
  regions, exact enough for dithering.
- Same treatment benefits `matchRgb`/`matchLuma` (they're cheap per-entry, but the
  quantised-match cache covers all modes uniformly).

### 2.3 Dot Diffusion is quadratic-ish and doesn't need to be
`dotDiffusePass` (`algorithms.ts:855`) scans the **entire image once per class-matrix
rank** — `size²` full-image passes (up to 64 scans at the default 8×8, 1024 at 32×32).
Precompute, for each rank, the list of pixels holding that rank (one counting pass), then
process ranks against those lists: O(w·h) total instead of O(w·h·ranks). This is the
single biggest algorithmic win in the engine; it directly extends the pixel budget the
coarse stage can afford for this algorithm.

### 2.4 Main-thread jank around the canvas
- `draw()` applies `shadowBlur = 18` + `shadowOffsetY` to the base layer on **every**
  repaint (`PreviewCanvas.tsx:137–141`). Blurred shadows are one of the slowest 2D-canvas
  operations in WebKitGTK, and pan/zoom redraw continuously. Either drop the shadow
  while dragging (`dragRef.current !== null`), bake it into a padded offscreen once per
  size change, or render it as CSS on the stage behind the canvas.
- Pointer events drive `setZoom`/`setPan` directly (`onWheel`/`onPointerMove`);
  React commits per event, so high-frequency mice can paint several times per frame.
  Coalesce with a `requestAnimationFrame` gate (store latest event, draw once per frame)
  — same pattern the viewport reporting already uses with its quantisation key.
- `toBuffer()` does `putImageData` for every arriving result; combined with §4.3 you can
  eliminate the extra upload entirely by receiving `ImageBitmap`s.

### 2.5 Downscaled coarse input is recomputed per tick
`coarseJobFor` → `downscale(src, w, h)` (`useDither.ts:41`) creates two canvases,
`putImageData` at up-to-full-size and `drawImage` scales down — **on every settings
change**, although its result depends only on `(source, pixelScale)`, never on dither
settings. Memoise the downscaled ImageData alongside the master source; a slider drag
then skips ~16 MP of canvas round-trip per tick.

### 2.6 Small ones
- The i18n context value is rebuilt every provider render (`i18n.tsx:44`) and panels
  aren't memoised, so every patch re-renders the whole sidebar tree. Wrap
  `AlgorithmPanel`/`PalettePanel`/`AdjustPanel` in `React.memo` (their props are
  stable-except-settings) and memoise the context value; costs nothing, trims JS time
  per tick.
- StrictMode double-mounts the worker effect in dev (`useDither.ts:224`) — harmless but
  worth knowing when profiling dev builds.
- Watchdog floor is 8 s (`watchdogMs`) before falling back to main thread; on machines
  where workers genuinely fail, the first interaction feels dead for 8 s. Consider
  probing worker liveness with a tiny warm-up job at startup (sub-ms) and demoting
  eagerly on failure rather than waiting for a timeout.

---

## 3. Cross-platform builds & distribution

Today Linux-only in practice: `bundle.targets` is `[deb, rpm, appimage]`
(`tauri.conf.json:33`), yet `.cargo/config.toml` carries a mingw linker for
`x86_64-pc-windows-gnu` and `icon.icns` exists — the cross-platform *intent* is there
but unbuilt. Gaps, concretely:

### 3.1 Windows and macOS targets don't exist
- Add `"nsis"` (or `"msi"`) and `"dmg"`/`"app"` targets; icons are already in place.
- The `windows-gnu` toolchain works for CI cross-compiles but NSIS bundling is smoother
  with `x86_64-pc-windows-msvc` on a Windows runner; decide one and encode it in CI.
- There is **no CI at all** (no `.github/`, no Forgejo/GitLab config). A GitHub Actions
  workflow doing `tauri build` matrix (linux, windows, macOS) + artifact upload would make the
  bundle targets real instead of aspirational.

### 3.2 The Flatpak manifest cannot work as written
`packaging/com.vndreiii.dizako.yml` installs a **prebuilt binary copied from your host
`target/release` dir** — it will fail in `flatpak-builder` (sandbox has no such file and
no node/rust modules declared), and even if the binary landed it wouldn't run:

- Missing `finish-args`: no `--socket=x11`/`--socket=wayland`, no
  `--device=dri`, no `--filesystem=home` for open/save dialogs.
- Missing the `org.freedesktop.Platform.WebKit6.0` extension as a dependency for
  webkitgtk, and `runtime-version: '23.08'` is aging — current freedesktop runtime is
  24.08.x.
- Either write a proper manifest (two modules: node/pnpm build of `dist`, cargo build of
  src-tauri — see the many Tauri-on-flathub manifests) or delete the stub until it's
  real; a broken manifest is worse than none.

### 3.3 PKGBUILD quirks (`packaging/PKGBUILD`)
- It runs `pnpm run tauri build --bundles deb,rpm` **inside an Arch PKGBUILD** — building
  Debian/RPM packages to throw away, then installing the raw binary anyway. Just invoke
  `pnpm build && cargo build --release` (or `tauri build --no-bundle`) and skip the
  bundler entirely.
- `makedepends` lists both `npm` and `pnpm`; only pnpm is used.
- Hand-written `.desktop` lacks `GenericName`, `Keywords`, `MimeType` (see §1.2), and
  duplicates what `tauri bundle` already generates for deb/rpm/appimage.
- Static `pkgver=v1.1.0.r0.g3bae2dc` contradicts the dynamic `pkgver()` function; leave
  the field at a plain `1.1.0` and let `pkgver()` compute the `-git` version at
  makepkg time.
- `arch=('aarch64')` claims ARM support that nothing else in the repo provides/CI-verifies.

### 3.4 Frontend build target vs WebKitGTK reality
`vite.config.ts:8` sets `build.target: "esnext"`. WebKitGTK's JavaScriptCore lags V8;
`esnext` risks shipping syntax the Linux webview parses but older versions don't (and
there's no ES-version guard anywhere). Target `es2022` (or `safari16`) — the bundle is
already transpile-free otherwise, so this costs nothing measurable.

### 3.5 Codec availability is platform-dependent
`decode()` relies on `createImageBitmap` for PNG/JPEG/WebP/GIF/AVIF (`App.tsx:75`,
empty-state text promises AVIF). On Linux, AVIF/WebP decode depends on the gstreamer
plugins the *user's system* webkitgtk pulls in — and Flatpak needs explicit codecs.
Either verify formats at decode failure with a helpful message (currently the snackbar
shows the raw error), or add a Rust-side fallback decoder (`image` crate) — which pairs
naturally with §4.4.

### 3.6 Smaller distribution items
- `capabilities/default.json` grants blanket `fs:allow-write-file`. It's justified (paths
  come from the native save dialog), but scoping writes to
  `$HOME/**` minus reads, or documenting why the blanket grant exists, keeps the
  capability audit clean.
- No updater/signing configuration; fine for now, but if releases go beyond the AUR,
  `tauri-plugin-updater` + signing keys belong in the same CI that builds bundles.
- Single JS chunk is 400 KB uncompressed (`dist/assets/index-yFy19tcS.js`); lazy-load
  the ColorPicker/PalettePanel and material-color-utilities (already dynamic-imported
  for tauri plugins elsewhere) via `manualChunks`. Minor for a desktop app, but startup
  parse time shows up on weaker ARM boxes the PKGBUILD claims.

---

## 4. Render pipeline improvements

Question 4 deserves a staged answer, because there are three credible destinations and
the right move is sequencing, not a rewrite.

### 4.1 Stage 0 — fix the CPU pipeline first (days, not weeks)
Everything in §2 compounds here; specifically the pipeline-order wins:

1. Memoise `prepare()` on tone-keys and `compilePalette()` on layers (§2.1) — makes
   palette edits ~free regardless of engine.
2. Kill the per-dispatch buffer copy; keep the working buffer resident in the worker
   (§2.1) — halves memory traffic per tick.
3. Return `ImageBitmap` from the worker instead of raw ArrayBuffers
   (`worker.ts:37`): do `putImageData` + optional `createImageBitmap` resize *inside*
   the worker (OffscreenCanvas is supported wherever module workers are), transfer the
   bitmap (zero-copy), and let `PreviewCanvas.drawImage` consume it directly. Removes
   the last big main-thread blit per result and drops `toBuffer()` entirely.
4. Quantised nearest-colour cache (§2.2) + rank-indexed dot diffusion (§2.3).

Expected outcome based on the code paths involved: typical slider ticks stop touching
grading, scaling, and palette compilation altogether, leaving only the matcher + kernel
loop — likely a multiple-fold improvement on large images without changing a single
visual output.

### 4.2 Stage 1 — finish the WASM port that's already started
`dither-wasm/` was scaffolded (commit `31fc0c3`) but is **dead code today**: nothing in
`src/` imports it, it's absent from `package.json` dependencies, and the built `pkg/`
isn't referenced. More importantly, the current Rust implementation is a *subset* that
would produce different output than the shipped engine if wired up naively:

| Engine feature | TS (`algorithms.ts`) | WASM (`dither-wasm/src/lib.rs`) |
| --- | --- | --- |
| Match modes | rgb / luma / oklab / tonal + `tonalBias` bands | rgb distance + `pull` only |
| Kernels | 17 named kernels + ostromoukhov + riemersma + dot-diffusion + omino | floyd-steinberg + plain nearest |
| `errorClamp`, `jitter` | implemented | parsed but unused |
| Serpentine mirroring | yes | yes |

To make it real:

- Build with `wasm-pack build --release --target web -d pkg` (+ `RUSTFLAGS="-C
  target-feature=+simd128"`, `opt-level="z"`/`3` as appropriate) as part of
  `beforeBuildCommand`, and add the crate as a `file:dither-wasm/pkg` dependency.
- Take the `Vec<u8>` boundary away: accept `&mut [u8]` via `js_sys::Uint8Array` views
  (wasm-bindgen slices) so pixels never copy in/out; parse settings once per job, not
  per pixel row (it already does per-call — keep it that way).
- Port the *whole* engine or nothing in between: a half-parity WASM fast path means the
  preview and the main-thread fallback disagree visually depending on which machine ran.
  The deterministic-seeded PRNG and golden-image tests from §1.7 become the acceptance
  harness for parity (same bytes out, both engines, all 29 algorithms).
- Realistic payoff: SIMD128 + tight loops typically buy 5–15× over the JS matcher loop,
  which converts "coarse-first-then-refine" from a necessity into barely a stutter —
  possibly letting you raise `COARSE_PIXELS` or skip staging for mid-size images.

### 4.3 Stage 2 (optional) — GPU for the ordered family
Bayer/halftone/lines/checker/blue-noise/IGN/threshold/random are embarrassingly parallel:
mask value + match, zero inter-pixel state. As WebGL2 fragment shaders the entire ordered
family renders in <1 ms at any resolution, making those sliders literally instant and
freeing the worker for diffusion. A pragmatic hybrid:

- Upload the graded image (output of memoised `prepare()`) as a texture once per tone
  change; palette becomes a uniform array (palettes are ≤12 colours).
- Keep error diffusion (sequential by nature) on CPU/WASM — GPU wave-front diffusion
  exists but is a research project, not a win here.
- Caveat worth respecting: WebKitGTK's WebGL path (DMABUF renderer) has had breakage
  across driver combos; gate GPU behind a setting with automatic CPU fallback on context
  loss — the app already has the perfect pattern for graceful degradation in
  `useDither.demote()`.
- If you later want wasm threads + SharedArrayBuffer for parallel diffusion rows,
  Tauri v2 exposes custom response headers (`app.security.headers`) to set
  COOP/COEP on the asset protocol — verify your pinned tauri version supports it
  before designing around it.

### 4.4 Alternative worth weighing — push the pipeline into Rust commands
Given the Rust process sits idle, another route is moving decode → grade → dither →
encode entirely into Tauri commands (`src-tauri/src/lib.rs` grows, the worker disappears):

- Pros: kills the WebKitGTK module-worker fragility you already coded around
  (`useDither.ts:84–91` comments), removes the 400 KB engine from the bundle, gives you
  `rayon` multithreading and the `image` crate for free (fixing §1.3 and §3.5 together),
  and progress events via channels replace the watchdog.
- Cons: every preview frame crosses IPC (a 240 kpx RGBA buffer ≈ 1 MB per coarse pass —
  acceptable; full-res exports return a *file path*, not pixels, sidestepping the cost).
- Honest assessment: WASM-in-worker (§4.2) preserves the current architecture with less
  churn; the Rust-command route is the better endgame if you also want non-webview
  codec guarantees, but doing both is wasted motion. Pick one lane.

### 4.5 Pipeline correctness notes spotted along the way
- The fine pass crops to `region` and runs `prepare()` *after* cropping
  (`useDither.ts:126–139` → `algorithms.ts:1014`). Grading is per-pixel so cropping is
  safe, but `boxBlur`/unsharp sample with edge clamping inside the crop, so blur near a
  fine-region border differs slightly from a whole-image render. The 96 px `MARGIN`
  hides it at radius ≤ ~32 (blur slider maxes well below that today) — worth an assert
  or comment binding `MARGIN ≥ 3 × maxBlurRadius` so future filter increases don't
  introduce seams.
- `orderedPass` evaluates the mask closure per pixel with live `%`/floor math
  (`algorithms.ts:1026–1057`); for bayer specifically, pre-tile the cached matrix into a
  `w×h` Uint8 ramp once per pass (or use power-of-two bitmask indexing) — measurable at
  16 MP, trivial to do.
- `riemersmaPass` computes `hilbertXY` per step with a division-free loop — fine — but
  allocates nothing reusable across passes; a static curve table per `side` (cached like
  `classCache`) saves a few hundred ms on big images.
- `MAX_PIXELS`/`MAX_DIMENSION` guards (`App.tsx:53`) are documented and sensible; if
  §2 lands, the 16 MP ceiling can rise without UX damage — revisit the constant after
  measuring.

---

## Suggested order of attack

| # | Item | Effort | Payoff |
| --- | --- | --- | --- |
| 1 | §2.5 memoise coarse downscale · §2.1 kill per-dispatch copy · memoise `prepare`/`compilePalette` | hours–1 day | immediate slider-drag smoothness |
| 2 | §2.2 matcher LUT/quantised cache · §2.3 dot-diffusion rank index | 1–2 days | biggest engine speedups |
| 3 | §1.3 export via worker + progress (+ JPEG/WebP via Rust encode) | 1 day | removes worst freeze |
| 4 | §1.1 persist settings/appearance · §1.5 shortcuts | 1 day | daily-use quality |
| 5 | §1.7 hygiene: versions, pnpm-workspace, ESLint, tests harness, clone cleanup | ½–1 day | prevents drift |
| 6 | §4.2 finish dither-wasm with golden-image parity | 1–2 weeks | order-of-magnitude engine |
| 7 | §3.1–3.3 CI + Win/macOS bundles, fix flatpak manifest & PKGBUILD | 2–4 days | real distribution |
| 8 | §4.3 GPU ordered family (optional, after 6 proves the architecture) | open-ended | instant sliders |

Items 1–5 are independent quick wins; 6 is the strategic fork in the road (WASM vs
Rust-commands, §4.4) and everything past it depends on that choice.
