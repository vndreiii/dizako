# SUMMARY

Work log: full codebase analysis of dizako (Tauri 2 + React 19 dithering studio).

## What was done

Analyzed all major areas of the repo:

- `src/` — React frontend; 29 dither algorithms running in a Web Worker.
- `src-tauri/` — thin Rust shell (dialog + fs plugins only).
- `dither-wasm/` — scaffolded but unwired Rust-to-WASM port.
- `packaging/` — PKGBUILD and flatpak stub.

Deliverable: `IMPROVEMENTS.md` at the repo root, documenting concrete
recommendations in four areas:

1. Overall app improvements: settings/appearance persistence, recent files,
   non-blocking export, i18n coverage gaps, keyboard shortcuts, code hygiene
   (version drift Cargo.toml 0.2.0 vs package.json 1.1.0, broken
   pnpm-workspace.yaml placeholder text, no tests/ESLint/CI, stray nested
   clones).
2. Responsiveness: memoizing coarse downscale plus prepare()/compilePalette(),
   killing per-dispatch buffer copies, OKLab LUT / quantized match cache,
   O(ranks) to O(pixels) dot-diffusion fix, rAF batching and shadowBlur cost
   in PreviewCanvas.
3. Cross-platform/distribution: missing Windows/macOS bundle targets and CI,
   broken flatpak manifest, PKGBUILD quirks, vite esnext target risk on
   WebKitGTK.
4. Render pipeline: staged plan — CPU quick wins, then finish dither-wasm
   with golden-image parity tests (current wasm is a feature subset that
   would diverge visually), then optional WebGL2 GPU path for the ordered
   family; alternative approach: move the pipeline to Rust commands.

## What it accomplished/enabled

- Complete inventory of app state across frontend, Rust shell, wasm port, and packaging.
- Prioritized, actionable improvement backlog captured in IMPROVEMENTS.md.
- Performance work staged so changes land without breaking visual parity.
- Distribution gaps (Windows/macOS bundles, flatpak, WebKitGTK target) identified with proposed fixes.

## Open items / next steps

- Implement CPU quick wins: memoization, buffer-copy removal, dot-diffusion fix.
- Decide between dither-wasm and Rust-command architecture for the pipeline.
- Finish dither-wasm with golden-image parity tests before wiring it into the app.
- Add tests, ESLint, and CI; resolve version drift and pnpm-workspace.yaml breakage.
- Add Windows/macOS bundle targets plus release CI; repair the flatpak manifest.
- Evaluate downgrading the vite target for WebKitGTK compatibility.

---

## 2026-08-21 — WASM_PLAN.md

New deliverable at the repo root: `WASM_PLAN.md`, a detailed engineering plan
for making dizako fully WebAssembly-compatible. Based on a close read of the
actual code: `src/dither/algorithms.ts` (29-algorithm TS engine),
`src/hooks/useDither.ts` (two-stage worker pipeline with watchdog demotion),
the half-finished `dither-wasm/` Rust scaffold, and the build configs.

### What was done

- **Parity contract**: byte-exact cross-engine equality requires replacing
  library transcendentals (`Math.pow/cbrt/cos/sin/exp`) with shared
  deterministic primitives (generated LUTs, Newton cbrt, minimax sincos),
  mirroring the f32-storage/f64-arithmetic model exactly; capture
  golden-image hashes from the CURRENT engine BEFORE refactoring, then pass a
  reviewed golden-regeneration checkpoint after the shared-primitives refactor.
- **Workstream A — finish dither-wasm to full parity**: all 29 algorithms,
  all 4 match modes, full prepare() grade/filter stage, crate setup changes
  (rlib target for native tests, opt-level 3 not "s"); module-by-module port
  map with per-module traps (jitter PRNG consumption order, omino always
  using matchRgb, errorClamp default active at 255); new zero-copy boundary
  API with resident source buffers.
- **Workstream B — render-pipeline integration**: backend negotiation ladder
  (worker+WASM → worker+JS → main+WASM → main+JS), settings-only render
  messages, OffscreenCanvas/ImageBitmap result delivery deleting toBuffer(),
  export moved into the worker with progress/cancel, eventual deletion of the
  TS engine after a burn-in release.
- **Workstream C — build/config**: wasm-pack chained into beforeBuildCommand,
  `file:` workspace dependency on pkg, Vite optimizeDeps.exclude + es2022
  target downgrade, CSP `'wasm-unsafe-eval'` addition (currently missing, so
  WASM would silently fall down the ladder), CI setup, pnpm-workspace.yaml
  placeholder fix.
- **Workstream D — parity assurance**: fixture corpus, declarative settings
  sweep (~thousands of cases), vitest+initSync Node runner running both
  engines against SHA-256 manifests, native cargo test cross-checks, runtime
  self-check toggle, four acceptance gates.
- **Milestones M0–M7** totaling ~3–5 focused weeks.
- **Architecture comparison**: WASM vs WebGL2 vs Rust/Tauri commands, each
  with pros/cons/performance numbers grounded in code facts (960 KB coarse
  frames, up-to-~50 MB zoomed-out fine-pass regions vs regionFor's 0.8
  coverage cap, WebKitGTK GL/DMABUF fragility, browser-mode support via
  saveImage.ts fallback).

### What it accomplished/enabled

- Decision-ready architecture plan resolving the IMPROVEMENTS.md §4.2/§4.4
  fork, with recommendation: WASM as the single engine; Rust/Tauri commands
  only at the IO boundary (decode fallback codecs + export encoding);
  WebGL2 rejected with a written revisit condition.
- Concrete, milestone-ordered execution path from golden harness to TS-engine
  deletion, with parity gates so visual output never regresses mid-migration.

### Open items / next steps

- Execute milestones M0–M7, starting with the golden harness (capture
  golden-image hashes from the current TS engine before any refactoring).
- Fold Workstream C's build fixes (CSP, vite target, pnpm-workspace.yaml)
  into the general backlog items above where they overlap.

---

## 2026-08-22 — Implementation: improvements + WASM engine (v2.0.0)

Executed the WASM_PLAN and IMPROVEMENTS backlogs. All committed in git
commit ae911de plus a follow-up commit.

### What was done

- **Golden parity harness** (WASM_PLAN M0): procedural RGBA fixture corpus
  (`testdata/images/`), declarative 732-case settings sweep
  (`testdata/suites/main.json` via `tools/gen-suite.mjs`), SHA-256 manifest
  capture/assert runner under vitest (`test/golden.test.ts`,
  `GOLDEN_CAPTURE=1` regenerates). Found and fixed a degenerate-fixture bug
  along the way.
- **Byte-exact TS optimizations** (IMPROVEMENTS §2): compilePalette
  memoisation, prepare() memoisation on tone/filter keys, coarse-downscale
  memoisation (WeakMap), dot-diffusion rank-index rewrite
  O(w·h·ranks)→O(w·h) (y-major order preserved, byte-exact), Hilbert curve
  cache for Riemersma.
- **Shared deterministic primitives** (WASM_PLAN M1/§4):
  `src/dither/sharedmath.ts` (cbrtShared Newton, sincosDeg/sinRad Taylor,
  powShared via exp2/log2 series, srgbToLinearShared fused constants) plus
  generated constants/blue-noise tile in `src/dither/tables.ts` and
  `dither-wasm/src/tables.rs` via `tools/gen-tables.mjs`; wired into color/
  toneCurve/hueMatrix/halftone trig hoisting/riemersma weights/omino bias.
  Golden regeneration checkpoint captured: pre-refactor manifest kept as
  `testdata/golden/ts-v1.json`; drift confined to screen-angle trig families
  (halftone-line, diagonal-line, omino phase).
- **Worker pipeline v2** (§6 B1–B3): resident source planes in the worker
  (settings-only render messages, per-dispatch frame copy eliminated),
  ImageBitmap results with legacy ArrayBuffer fallback, async full-res
  export through the worker with progress phases and supersede-cancellation,
  init handshake with backend field ("wasm"/"js"), demotion ladder now
  worker-wasm → worker-js → main-wasm → main-js, HUD shows which rung
  rendered (backendLabel).
- **Full Rust port (M2–M3)** in `dither-wasm/`: shared.rs/color.rs/palette.rs/
  prepare.rs/kernels.rs/engine.rs/settings.rs/masks.rs/region.rs/wasm_api.rs
  mirroring f32-storage/f64-arithmetic semantics; wasm-bindgen Engine API
  with resident planes and internal region cropping; native cargo-test parity
  suite (`tests/parity.rs` with embedded sha256) — ALL 732 CASES BYTE-EXACT
  vs TS goldens (Gate 2).
- **Wasm artifact gate**: `test/wasm-parity.test.ts` instantiates the shipped
  wasm32 binary via pkg glue initSync in Node and verifies all 732 hashes
  byte-exact (Gates 2+3). Built with RUSTFLAGS simd128, opt-level 3, lto
  fat, wasm-opt.
- **App improvements**: versioned localStorage session persistence (settings
  + appearance/mode/themeSource/seed, `src/session.ts`), keyboard shortcuts
  Ctrl+O/E/S(+Z/Y/A), i18n per-key en fallback chain + dev warnings +
  HUD/snackbar strings translated via new en keys, React.memo on the three
  sidebar panels, rAF-coalesced pointer/wheel gestures, canvas shadow skipped
  mid-drag, Export button shows in-flight state.
- **Hygiene/build**: versions unified at 2.0.0 across package.json /
  tauri.conf.json / src-tauri Cargo.toml / dither-wasm Cargo.toml;
  pnpm-workspace.yaml placeholder key removed; vite build.target es2022 +
  worker.format es + optimizeDeps.exclude dither-wasm; CSP gained
  'wasm-unsafe-eval'; ESLint flat config (typescript-eslint + react-hooks,
  0 errors); pnpm build chains build:wasm (wasm-pack --target web).
- **Packaging/CI**: `.github/workflows/ci.yml` (lint/typecheck/golden-parity
  frontend job, native cargo parity job, Linux/Windows/macOS bundle jobs with
  artifacts); PKGBUILD rewritten (no deb/rpm inside makepkg, proper desktop
  entry with GenericName/Keywords/MimeType, hicolor icon, static pkgver
  placeholder + dynamic pkgver()); flatpak manifest rewritten honestly
  (GNOME runtime 48 since WebKitGTK lives there, sdk-extensions
  node22/rust-stable, finish-args wayland/x11/dri/home fs, marked as
  not-yet-exercised); desktop file extracted to
  `packaging/com.alex.dizako.desktop`.

### What it accomplished/enabled

- Visual output is now provably frozen: any change to either engine that
  flips one golden byte fails vitest or cargo test.
- ONE visual truth available on every rung of the execution ladder
  (byte-exact engines), with observability in the HUD.
- Slider ticks no longer copy frames into the worker nor putImageData on the
  main thread; export no longer freezes the UI and shares the preview's
  exact engine path.
- Distribution story moved from aspirational to scripted (CI bundles for all
  three OSes).

### Open items / next steps

- Burn-in release with HUD ladder visible, then delete the TS engine
  (Stage C, M7) and shrink the harness to ordinary regression tests.
- Optional M6 optimisations gated by goldens: simd128 matcher lanes,
  quantised match cache, prepare/palette caches inside wasm Engine, raising
  COARSE_PIXELS/watchdog retune after measurement.
- Runtime self-check toggle (dev builds running both engines per coarse job)
  not yet implemented.
- Flatpak manifest needs an actual flatpak-builder exercise; AUR PKGBUILD
  untested against the new wasm-pack makedep.
- Recent-files/session-restore (IMPROVEMENTS §1.2), window double-click
  maximise toggle (§1.6), locale chunk lazy-loading (§1.4) remain open.
- Rust/Tauri-command IO boundary (decode fallback codecs + JPEG/WebP export
  encode, §11.5 hybrid) scheduled as fast-follow.

## 2026-08-22 (later) — Stage C: TS engine deleted from runtime

### What was done
- Moved the TypeScript engine to `legacy/dither/` as a self-contained frozen
  copy (algorithms/color/masks/sharedmath/tables/types); removed
  `src/dither/algorithms.ts` and `src/dither/masks.ts`.
- Worker renders only through the wasm engine and posts an explicit error
  response if it is unavailable; main-thread fallback uses initSync; ladder is
  now worker-wasm → worker-js(no-op) → main-wasm, with a visible error state
  when no engine can initialise at all.
- Golden harness repointed at the frozen legacy engine; both harnesses
  (legacy TS + shipped wasm binary) still assert all 732 goldens byte-exact.
- Main JS bundle shrank ~35 KB gzip-neutral (427 → 392 KB raw) now that the
  interpreter engine is gone.
- Extras: double-click on the topbar drag region toggles maximise (§1.6);
  README documents what legacy/ contains.

### Open items / next steps
- M6 measured tuning (COARSE_PIXELS/watchdog retune), flatpak exercise,
  AUR PKGBUILD test against new makedeps, Rust IO-boundary commands
  (decode fallback codecs, JPEG/WebP export).

## 2026-08-22 (final) — UX pass, packaging fixes, PKGBUILD install

### What was done
- Stale-canvas bug fixed: loading a second image no longer shows the old
  picture stretched into the new aspect. Preview layers drop when the source
  plane changes and draw() rejects layers whose size disagrees with the
  current image.
- Every slider in the app now uses the M3 expressive style (gap around the
  bar handle, end dots) including layer-weight sliders; scroll wheel moves
  any slider with a persisted per-notch increment setting (Settings →
  Appearance, 1–10×).
- Randomise in the palette stack rolls each colour independently.
- PalettePanel strings translated (title, preset count, match-mode notes,
  tooltips, layer ops); HUD engine badge moved out of the stats row into a
  subtle bottom-right popup.
- Matugen toggle moved from the Light/Dark mode row to the Accent source
  group in Settings; README rewritten short and plain.
- build-all.sh: linux full build with best-effort bundles; windows/macos
  scaffolding for running on those platforms.
- PKGBUILD fixes discovered by actually running it: wasm-pack must run
  before pnpm install (file: dependency on dither-wasm/pkg), direct
  wasm-pack call (pnpm's dep-status check trips first), and
  --config.strict-dep-builds=false for esbuild's postinstall.
- Installed system-wide via makepkg + pacman -U (dizako-git); v2.0.0 tag
  created so pkgver() reports correctly going forward.

### Open items / next steps
- AppImage bundling still fails at linuxdeploy on this machine (deb/rpm/
  raw binary fine; CI covers appimage).
- Push commits/tags so the published PKGBUILD source URL builds the same
  code as local installs.
