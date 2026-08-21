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
