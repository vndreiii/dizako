# Dizako — WASM Compatibility Plan

A concrete plan for moving dizako's pixel engine from TypeScript to a fully
featured Rust→WebAssembly implementation, based on a close read of the code as
it exists today (`src/dither/algorithms.ts`, `src/hooks/useDither.ts`,
`src/dither/worker.ts`, `dither-wasm/src/lib.rs`, and the build configs).
Companion document to `IMPROVEMENTS.md` (§4.2 identified the half-finished
port; this plan finishes it and answers the §4.4 fork explicitly in §11).

---

## 0. Executive summary

- **Finish `dither-wasm/` to full engine parity** (all 29 algorithms, all four
  match modes, the entire `prepare()` grade/filter stage), wire it into the
  existing module-worker pipeline behind the watchdog that already exists,
  and **delete the TS engine after a burn-in release** so there is exactly one
  visual truth.
- **Parity is an engineering contract, not an aspiration.** The engine is
  deterministic today (fixed-seed xorshift PRNG, no clocks, no platform
  queries), which makes byte-for-byte cross-engine equality achievable — but
  only if the handful of library-dependent transcendental calls
  (`Math.pow`, `Math.cbrt`, `Math.cos/sin`) are replaced by *shared*
  implementations used by both engines. §4 explains why this is the crux.
- **Integration changes are modest and local**: the worker message protocol
  gains an init handshake and a resident source buffer; results come back as
  `ImageBitmap`s; the export path moves into the worker; the fallback ladder
  becomes worker+WASM → worker+JS → main-thread+WASM → main-thread+JS.
- **Build changes are small**: a `wasm-pack` step chained into
  `beforeBuildCommand`, a `file:` dependency on `dither-wasm/pkg`, one CSP
  token (`'wasm-unsafe-eval'`), and a `build.target` downgrade from `esnext`
  to `es2022`.
- **Recommendation (§11)**: WASM as the single engine; Rust/Tauri commands
  confined to the IO boundary (decode fallback codecs, export encode);
  WebGL2 rejected for now — it accelerates exactly the algorithms that are
  already cheap (ordered family) and cannot help the ones that are slow
  (sequential error diffusion).

---

## 1. Where the engine lives today

Facts this plan relies on, with references:

| Fact | Value | Where |
| --- | --- | --- |
| Engine | 29 algorithms: 15 named diffusion kernels + ostromoukhov + riemersma + dot-diffusion + omino + 8 ordered masks + threshold/random | `src/dither/algorithms.ts` |
| Match modes | rgb / luma / oklab / tonal, `tonalBias` bands, layer `width`→`pull = 2/(1+w)` | `algorithms.ts:64–214` |
| Grade/filter stage | tone LUT, temp/tint, hue rotation, saturation, grayscale, invert, box-blur ×3, unsharp — all in `prepare()` | `algorithms.ts:309–374` |
| Working precision | graded buffer is `Float32Array(w·h·3)` (f32 storage, f64 arithmetic); error planes are f32 | `algorithms.ts:311, 631` |
| Determinism | xorshift32 PRNG, fixed seed `0x2545f491` (`makeRandom`, `algorithms.ts:564`); blue-noise generator seeded `0x9e3779b9` (`masks.ts:59`) | — |
| Execution | module Web Worker; watchdog demotes to main thread on construct/send/timeout failure | `useDither.ts:224–284` |
| Staging | coarse ≤ 240 kpx (`COARSE_PIXELS`), fine pass cropped to viewport + 96 px `MARGIN` | `useDither.ts:31`, `region.ts:19` |
| Per-dispatch copy | `new Uint8ClampedArray(job.input.data)` on every job | `useDither.ts:264` |
| Result delivery | raw `ArrayBuffer` transfer → main thread does `putImageData` via `toBuffer()` | `worker.ts:37`, `PreviewCanvas.tsx:35` |
| Export | full-resolution `dither()` **synchronously on the main thread**, then `canvas.toBlob` | `App.tsx:266–288` |
| Limits | `MAX_PIXELS` 16 MP, `MAX_DIMENSION` 8192 | `App.tsx:53–54` |
| WASM state | scaffold only: floyd–steinberg + plain-nearest, `matchRgb` only, no `prepare()`, `errorClamp`/`jitter` parsed but unused, `Vec<u8>` copy-in/copy-out boundary | `dither-wasm/src/lib.rs` |
| Build | Vite `target: "esnext"` single chunk; CSP has `worker-src 'self' blob:` but **no** `'wasm-unsafe-eval'`; tauri 2.11.5 | `vite.config.ts:8`, `tauri.conf.json:28` |

Two structural observations drive everything below:

1. **All visual math funnels through one function.** `dither(image, settings)`
   (`algorithms.ts:1008`) is the only producer of dithered pixels: preview
   coarse pass, preview fine pass, the main-thread fallback, and export all
   call it. Replacing its internals swaps every consumer at once — there is no
   long tail of call sites.
2. **The architecture around the engine is already correct.** Job coalescing,
   stale-reply dropping, the watchdog, two-stage refinement, and region
   cropping are engine-independent. The WASM migration should not touch their
   semantics; it should only change what sits *inside* the worker.

---

## 2. Goals and non-goals

Goals:

- G1. Every algorithm, match mode, and setting behaves **identically** under
  WASM and the current TS engine — ultimately byte-identical output.
- G2. Preview stays interactive: slider drags coalesced, coarse-first, refined
  in place; measurable end-to-end latency improvement (target ≥5× on the
  matcher-bound paths).
- G3. Export stops freezing the UI and provably produces the same pixels as
  the preview (same engine, same job shape).
- G4. Plain-browser mode keeps working (`vite dev`/`preview` with the
  `<a download>` save path in `saveImage.ts`). Whatever we build must not
  require the Tauri host.
- G5. Graceful degradation survives the WebKitGTK module-worker flakiness the
  watchdog already codes around (`useDither.ts:84–91`).

Non-goals (explicitly deferred):

- N1. wasm threads / `SharedArrayBuffer` (needs COOP/COEP response headers;
  Tauri 2.11.5 can set them via `app.security.headers`, but WebKitGTK's SAB
  support is not something to bet the preview on). Row-parallel diffusion is a
  research project anyway.
- N2. GPU acceleration (evaluated and deferred in §11.2).
- N3. Moving the interactive pipeline into Tauri commands (evaluated and
  rejected in §11.3; a narrow Rust role at the IO boundary is adopted instead).
- N4. Raising `MAX_PIXELS`. Revisit only after measuring post-WASM timings
  (IMPROVEMENTS §4.5 last bullet).

---

## 3. Why WASM is the right destination for *this* app

Three properties of dizako decide this before any benchmark does:

1. **Browser-mode compatibility is a hard requirement.** The app already
   maintains a browser path (`savePng` anchor fallback in `saveImage.ts:26`;
   `decode()` via `createImageBitmap`). Any engine living only in the Rust
   process (Option C) either kills browser mode or forces a permanent second
   engine — the exact dual-engine drift IMPROVEMENTS §4.2 warns about. WASM
   runs identically in a browser tab and inside the WKWebView/WebKitGTK/WebView2
   hosts.
2. **The workload is scalar, sequential, and hot.** Error diffusion carries
   inter-pixel state row-by-row; the matcher is a ≤12-entry linear scan with
   transcendental setup per pixel. This is the profile where compiled WASM
   (tight loops, no JIT deopts, SIMD128 available, predictable) shines, and
   where GPU fan-out does not apply.
3. **Determinism is already engineered in.** Fixed seeds, no time/random
   entropy, stable sorts with explicit index tie-breaks (`classMatrix`,
   `algorithms.ts:848`). Byte-exact parity is therefore a *porting discipline*
   problem, not a research problem. §4 lays out the discipline.

The existing scaffold proves the toolchain end (commit `31fc0c3`, built
`pkg/` present) — what's missing is scope, boundary design, and parity
assurance, which is what the rest of this document supplies.

---

## 4. The parity contract — reasoning in depth

This is the heart of the plan. Everything else is plumbing; getting §4 wrong
is what produces "WASM previews that look *almost* right," which is worse than
no WASM at all.

### 4.1 Inventory of nondeterminism sources

For two engines to emit identical bytes, every step must be reproducible.
Auditing the TS engine:

| Source | Status | Notes |
| --- | --- | --- |
| PRNG (`makeRandom`) | ✅ portable | xorshift32 on u32; JS `<<`/`>>>` map to Rust wrapping shifts exactly. Must consume `rand()` in the **same order** — see the jitter caveat in §5.2. |
| Blue-noise generation | ⚠️ semi-portable | Uses `Math.exp` (Gaussian weights) and iterative argmax scans. Do **not** reimplement; embed the settled 64×64 mask as a checked-in constant (§5.2). |
| Bayer matrix | ✅ exact | Integer recursion; normalisation divides by a power of four — exact in binary FP. |
| IGN hash | ✅ exact | Pure `+`,`*`,`%1` on f64; JS `%` and Rust `%` share IEEE fmod semantics. |
| Hilbert curve | ✅ exact | Pure integer. Replace `Math.log2`-side computation (`riemersmaPass`, `dotDiffusePass` size selection) with integer `leading_zeros`/`ilog2` in Rust — same results, no libm. |
| Class matrix | ✅ portable | `abs/mod/+/*` keys, stable sort with explicit `(d, i)` tie-break; replicable in Rust with `sort_by`. |
| Storage rounding | ✅ replicable | JS `Float32Array` stores round-to-nearest-even f32; Rust `f32` fields/stores are the same operation. The subtlety is *where* f32 truncation happens (§4.2). |
| **Transcendentals** | ❌ **not portable** | `Math.pow`, `Math.cbrt`, `Math.cos/sin`, `Math.exp` are implementation-defined per ECMA-262. JSC (WebKitGTK), V8, SpiderMonkey, and Rust's compiled libm may differ in the last ulp. See §4.3. |

### 4.2 The f32/f64 storage model must be mirrored, not "improved"

JS numbers are f64, but the engine deliberately stores intermediates in f32
arrays: the graded buffer (`Float32Array(w·h·3)`, `algorithms.ts:311`), both
error planes (`err`, `algorithms.ts:631/687`), the palette channels, and the
omino side-buffers. Arithmetic happens in f64; every array store rounds to
f32; every load promotes back. Those round-trips are part of the algorithm's
behaviour — diffusion error *decays* differently if you widen the error plane
to f64.

Therefore the Rust port must reproduce the exact same storage widths: f32
arrays with f64 locals, never `Vec<f64>` planes "because Rust is easy that
way", and never `f32` locals throughout "because faster". The port checklist
per function is: same op order, same intermediate width, same store points.

### 4.3 Transcendentals are the real enemy

Where the engine calls library math:

- `srgbToLinear`: `Math.pow((v+0.055)/1.055, 2.4)` per channel per matched
  pixel (`color.ts:28–31`) — the inner-loop hot spot.
- `Math.cbrt` ×3 per pixel in `rgbToOklab` (`color.ts:38–40`).
- `toneCurve`: `Math.pow(i*gain+bright …, invGamma)` — 256 calls per job
  (`algorithms.ts:237`).
- `hueMatrix`: `cos/sin` once per job (`algorithms.ts:287`).
- Halftone spot functions: `rotate()` calls `Math.cos/sin` **per pixel**
  (`masks.ts:208–213`).
- Riemersma weights: `Math.pow(decay, k)` per job (`algorithms.ts:783`).

A 1-ulp difference in any of these seems harmless — until it isn't. In the
matcher, distances are compared with strict `<` (`algorithms.ts:186`): two
palette colours near-equidistant from a pixel can swap winner on a 1-ulp nudge.
In error diffusion a swapped pixel feeds different error forward, and because
diffusion is chaotic, one flipped pixel can cascade into a visibly different
texture downstream. Chasing JSC/V8/libm quirks to force agreement is a losing
game: it differs per engine version, per platform, and per optimisation level.

### 4.4 The fix: shared deterministic primitives

Replace every library-dependent transcendental with a *shared implementation*
written once per language and unit-tested for bitwise agreement:

1. **`srgbToLinear`** → 4096-entry interpolated f64 LUT over `[0,255]`,
   generated by a committed script (`tools/gen_tables.ts` emits both a TS
   module and a Rust `const`). Table lookups + lerp are pure `+,*` — bitwise
   portable. This is also IMPROVEMENTS §2.2's performance suggestion, adopted
   here for correctness reasons first.
2. **`cbrtShared`** → Newton–Raphson from a bit-level initial guess
   (integer exponent-halving on the f64 bits), ~20 lines, converges to the
   correctly rounded result or a fixed, documented last-ulp approximation —
   identical in TS and Rust by construction.
3. **`sinDegCosDeg`** → argument reduction + minimax polynomial, used by
   `hueMatrix` and hoisted out of the halftone per-pixel `rotate()` (hoisting
   is value-identical and removes ~2 million libm calls per 16 MP halftone
   pass).
4. **`powShared(x, y)`** for `toneCurve`/Riemersma weights → `exp2(y·log2 x)`
   via the same shared primitives, or simply absorb `toneCurve` into another
   generated 256-entry LUT keyed by the (bounded) parameter grid — exposure/
   brightness/contrast/gamma change per drag, so compute the LUT per job with
   shared primitives; 256 calls per job is nothing.
5. **Blue-noise tile** → embedded constant, generated once by the existing TS
   implementation and frozen. The generator script stays in-tree for
   regeneration, with a test pinning the committed tile.

After this refactor, *both engines execute identical IEEE-754 operation
sequences on identical inputs*. Rust guarantees no fast-math contraction
(no implicit FMA fusion without explicit intrinsics; baseline wasm has no
FMA instruction at all), and JS engines are bound by spec to IEEE semantics
for `+ - * /`. Identical sequences ⇒ identical bits. That converts parity
from "hope the libs agree" to "diff the disassembly of the spec", enforceable
by tests.

### 4.5 Golden sequencing — capture behaviour *before* refactoring

Order matters, and it is subtle:

1. **M0 (first!): freeze today's behaviour.** Build the golden harness (§8)
   and capture goldens from the *current, unmodified* TS engine on the
   current runtime. These goldens document what ships in 1.1.0.
2. **Apply the shared-primitives refactor to the TS engine.** This will flip
   isolated pixels wherever `Math.*` disagreed with the shared primitives.
   Review the diffs visually and statistically (ΔE distribution; expected:
   imperceptible speckle-level changes on diffusion patterns, zero changes
   elsewhere). Regenerate goldens from the refactored TS engine. This is the
   **golden regeneration checkpoint** — the one deliberate, reviewed visual
   delta in the whole migration, announced in release notes.
3. **Port Rust to those goldens.** From here, the rule is absolute: any
   change to either engine that flips a single golden byte fails CI.
4. Only after byte-parity: optimise (SIMD128, caches, the dot-diffusion rank
   index) — each optimisation proven value-preserving against the frozen
   goldens. (The IMPROVEMENTS §2.3 rank-index rewrite, for example, preserves
   the exact mutation sequence if the per-rank lists are built in y-major
   scan order, so it stays byte-exact.)

Why generate the reference from TS and not Rust? Because the goal is stated as
*visual parity with the current JS implementation*. Pinning to today's
behaviour (step 1) means the migration can be audited as "nothing changed
except speed", rather than "everything changed a little, trust us".

---

## 5. Workstream A — finishing `dither-wasm`

### A0. Scope gap, precisely

Current `dither-wasm/src/lib.rs` vs the shipped engine:

| Capability | TS engine | WASM scaffold | Work |
| --- | --- | --- | --- |
| Grade/filter stage `prepare()` | yes | **absent** (operates on raw RGBA) | Port full stage incl. blur/unsharp |
| Match modes | rgb/luma/oklab/tonal + `tonalBias` bands | rgb only | Port 3 matchers + band machinery |
| Palette compilation | layers, `level`/`width`→`pull`, tonal bands, limit, fallback | minimal (pull only) | Port `compilePalette` exactly |
| Kernels | 15 named + Atkinson divisor semantics | FS hardcoded | Table-driven port |
| Special passes | ostromoukhov, riemersma, dot-diffusion, omino | — | Port each |
| Ordered family | 8 masks | — | Port (embed blue noise) |
| Threshold/random | seeded PRNG | — | Port xorshift32 |
| `errorClamp`, `jitter`, `strength`, serpentine | implemented | parsed-but-unused (clamp/jitter), FS-only | Wire through |
| Alpha preservation | copies input alpha | incidental (untouched byte) | Make explicit |
| Boundary | `&mut [u8]` views, resident buffers | `Vec<u8>` copy in/out | Redesign (§5.3) |

### A1. Crate setup

- `dither-wasm/Cargo.toml`:
  - `crate-type = ["cdylib", "rlib"]` — the rlib enables native
    `cargo test` of the engine (used by the parity harness, §8).
  - `[profile.release] lto = "fat"`, `codegen-units = 1`,
    `opt-level = 3` (this crate is hot-loop bound; the app shell's
    `opt-level = "s"` preference in `src-tauri/Cargo.toml:24` must **not**
    bleed into the engine), `panic = "abort"`.
  - Keep deps minimal: `wasm-bindgen`, `serde`, `serde-wasm-bindgen`
    (already present). No `js-sys` needed beyond bindgen's re-exports.
- Feature-gate a `simd128` path behind a cargo feature so the scalar path
  always exists for parity testing; enable the feature only after goldens
  pass scalar (§5.5).
- Align the crate version with the app (currently `0.1.0` vs app `1.1.0` /
  src-tauri `0.2.0` — IMPROVEMENTS §1.7 drift; pick one source of truth).

### A2. Module-by-module port map

Port in this order; each step lands with green goldens:

| # | TS source | Rust module | Traps |
| --- | --- | --- | --- |
| 1 | `color.ts` hex/luma/oklab | `color.rs` | Shared LUT/cbrt (§4.4); keep f64 |
| 2 | `compat tables` (generated) | `tables.rs` | Script-generated; assert equality in tests |
| 3 | `compilePalette` | `palette.rs` | Band sort comparator incl. luma tie-break; `limit` floor/max; `bias` semantics (`tonal ⇒ 0`) |
| 4 | `toneCurve`/`prepare`/`boxBlur` | `prepare.rs` | Blur accumulation is f64 over f32 planes; edge-clamp index order; unsharp copies via f32 |
| 5 | `KERNELS` + `errorDiffusePass` | `kernels.rs`, `diffuse.rs` | Serpentine mirroring sign; **jitter consumes PRNG only for taps that pass the bounds check** (`algorithms.ts:660–662`) — clone the control flow verbatim; `errorClamp` default is 255 (active!) |
| 6 | `adaptiveDiffusePass` | `ostromoukhov.rs` | Per-tone coefficient formulas; same tap mirroring |
| 7 | `riemersmaPass` + `hilbertXY` | `riemersma.rs` | Queue head arithmetic; weight normalisation order |
| 8 | `classMatrix`/`dotDiffusePass` | `dotdiff.rs` | Quadrant bias `0.01`; stable-sort tie-break; port the naive rank-scan first (parity), optimise later |
| 9 | `ominoPass` | `omino.rs` | **Always uses `matchRgb` regardless of mode** (`algorithms.ts:982`); ±1024 error clamp; per-line phase bias via shared sin |
| 10 | `masks.ts` ordered family | `masks.rs` | Embed blue-noise tile; hoist `rotate` trig; IGN exact |
| 11 | `orderedPass`/`thresholdPass` | `ordered.rs` | Spread/bias formulas differ between families — transcribe literally |
| 12 | `dither()` dispatcher | `engine.rs` | `put()` writes palette ints + preserved alpha |

### A3. Boundary API — take the copies out

The scaffold's `process_dither(Vec<u8>, …) -> Vec<u8>` copies the frame in
and out on every call and re-parses nothing reusable. Design instead around
state owned by the wasm instance (one instance lives inside the worker for
the app's lifetime):

```rust
#[wasm_bindgen]
pub struct Engine {
    master: Vec<u8>,        // full-res RGBA, resident
    coarse: Vec<u8>,        // pre-downscaled RGBA, resident
    out: Vec<u8>,           // result plane, reused
    width: u32, height: u32,
    palette_cache: ...,     // keyed on (layers, limit, bias)
}

#[wasm_bindgen]
impl Engine {
    pub fn set_source(&mut self, rgba: &[u8], w: u32, h: u32);      // copied once per load
    pub fn set_coarse(&mut self, rgba: &[u8], w: u32, h: u32);      // copied once per (source, scale)
    /// Renders region (x,y,w,h) of master — or the whole coarse plane —
    /// into the reused out plane; returns (ptr, len) for JS to view.
    pub fn render(&mut self, job_js: JsValue) -> Result<usize, JsValue>;
    pub fn out_ptr(&self) -> *const u8;
}
```

Consequences, each of which removes a measured cost:

- **Kills the per-dispatch input copy** (`useDither.ts:264`): settings-only
  messages after `set_source`; IMPROVEMENTS §2.1's biggest traffic win falls
  out of the memory model for free.
- **Zero-copy cropping**: `render` takes region coordinates and strides the
  master buffer internally — `cropImage` (`region.ts:72`) disappears from the
  hot path entirely.
- **One output copy remains** (wasm heap → `ImageData` view → bitmap), which
  is unavoidable without `ImageBitmap` construction from raw memory and
  costs ~0.1 ms at the 960 kB coarse size.
- `serde_wasm_bindgen` parses settings once per job (fine at job granularity;
  never per pixel). Mark every field `#[serde(default)]` so a UI/engine
  version skew degrades gracefully instead of throwing.

### A4. Settings schema

Mirror the full `Settings` type (`types.ts:101–177`), `rename_all =
"camelCase"`, with range validation matching the UI sliders. Unknown fields
are ignored (forward-compatible), missing fields defaulted (backward-
compatible). A TS-side `toEngineSettings()` keeps the wire shape in one place.

### A5. Optimisation (strictly post-parity)

Each gated by goldens:

1. simd128 matcher: lanes = palette entries, horizontal combines in fixed
   scalar order to preserve summation semantics.
2. Dot-diffusion rank index (IMPROVEMENTS §2.3) — value-preserving if lists
   are y-major.
3. `prepare()` memoisation on tone-keys and palette cache on layer-hash —
   cache hits return the *same bits*, so parity is unaffected by design.
4. `wasm-opt -O3` (binaryen) in the build; compare goldens again after —
   wasm-opt respects IEEE semantics but verify anyway.

Expected payoff (consistent with IMPROVEMENTS §4.2): 5–15× on matcher-bound
passes; combined with the algorithmic fixes, the 240 kpx coarse pass drops
from tens of ms to low single-digit ms, and the fine pass on a 1080p-class
region lands in frame budget.

---

## 6. Workstream B — render-pipeline integration

### B1. Backend negotiation ladder

Today's ladder is: module worker → main thread (`demote()`,
`useDither.ts:205`). WASM adds one dimension (backend) without changing the
mechanism:

```
worker + WASM   ← preferred
worker + JS     ← wasm init failed in worker
main  + WASM    ← worker construction failed (existing demote path; sync initSync)
main  + JS      ← last resort during transition; deleted in Stage C
```

Protocol changes in `worker.ts`:

- On start, the worker loads the pkg glue and posts `{type:"ready",
  backend:"wasm"|"js"}`. The hook treats *anything else within an init
  timeout (3 s)* as init failure and demotes one rung — the same pattern as
  the existing watchdog, just applied to startup.
- `worker.onerror` / `onmessageerror` / send-throw keep their current demote
  semantics unchanged.
- The HUD's degraded badge (`PreviewCanvas.tsx:382–389`) grows a backend
  suffix (`wasm · worker`, `js · main`) — cheap observability while the
  ladder burns in.

### B2. New message protocol (resident buffers)

```
→ {type:"setSource", buffer, w, h}        // transferred once per load / pixelScale
→ {type:"setCoarseSource", buffer, w, h}  // worker-side downscale result, memoised
→ {type:"render", id, stage, settings, region?}   // region omitted ⇒ coarse/full
← {type:"result", id, bitmap, ms}         // ImageBitmap, transferred
← {type:"progress", id, done, total}      // export jobs only
```

- The coarse downscale moves **into the worker** via `OffscreenCanvas`
  (same `drawImage` box filter as `downscale()`, `useDither.ts:41`) and is
  memoised on `(source, scale)` — closing IMPROVEMENTS §2.5's per-tick
  canvas round-trip. `pixelScale` downscaling in `App.tsx:112` can share it.
- Results arrive as `ImageBitmap`s built inside the worker
  (`putImageData` onto an `OffscreenCanvas` + `createImageBitmap`), so
  `PreviewCanvas.drawImage` consumes them directly and **`toBuffer()`
  (`PreviewCanvas.tsx:35–53`) is deleted** — IMPROVEMENTS §2.4's upload
  elimination.
- `regionFor`/`sameRect` stay in JS (pure geometry, no pixels) — the hook's
  viewport logic is untouched.

### B3. Export path

`exportPng` (`App.tsx:266–288`) currently duplicates the engine call on the
main thread. Replace with an export job through the same worker:

- `{type:"export", id, settings}` → renders at native resolution from the
  resident master (no re-upload), streams `{progress}`, encodes PNG in the
  worker via `OffscreenCanvas.convertToBlob("image/png")`.
- Cancellable: a newer job id supersedes, as preview jobs already do.
- Because preview and export now share the engine *and* the job shape, the
  "preview ≠ export" class of bugs is structurally closed (G3).

### B4. Tuning after measurement

With WASM speeds, revisit — in this order: shrink the watchdog
(`watchdogMs`, `useDither.ts:36`) toward ~2× measured p99; raise
`COARSE_PIXELS`/`SINGLE_PASS_PIXELS` (possibly 2–4×); consider skipping the
coarse stage outright below ~2 MP. These are measured follow-ups, not part of
the parity milestone.

### B5. Stage C — delete the TS engine

After one release of burn-in with the ladder visible in the HUD:

- Remove `algorithms.ts`/`color.ts` engine internals (keep `types.ts`,
  `region.ts`, and the shared-primitive modules used by tests).
- Main-thread fallback becomes `Engine` + `initSync` (wasm instantiation is
  synchronous-capable and safe off the hot path).
- The bundle sheds the interpreter-JS engine (~half of the current 400 KB
  chunk is engine+palettes+masks) while gaining the ~150–300 kB wasm module;
  net neutral-to-smaller, and gzip favours the wasm.

Keeping two engines forever is explicitly rejected: IMPROVEMENTS §4.2's
warning stands — a half-wired WASM fast path makes output depend on which
rung of the ladder a given machine landed on. One engine, one truth.

---

## 7. Workstream C — build, packaging, config

1. **wasm-pack step** (`package.json`):
   ```jsonc
   "build:wasm": "wasm-pack build dither-wasm --release --target web --out-dir pkg",
   "build": "pnpm build:wasm && tsc --noEmit && vite build"
   ```
   Chain the same (or an up-to-date guard) into `beforeBuildCommand` /
   `beforeDevCommand` (`tauri.conf.json:7–9`). `--target web` matches the
   existing pkg glue; do not switch to `bundler` mid-flight.
2. **Dependency wiring**: `"dither-wasm": "file:./dither-wasm/pkg"` in
   `dependencies`, or — cleaner given `pnpm-workspace.yaml` already exists —
   register `dither-wasm/pkg` as a workspace package and depend via
   `workspace:*`. Either way, **do not commit `pkg/`** (wasm-pack drops a
   `pkg/.gitignore` containing `*`; respect that and build fresh in CI).
3. **Vite** (`vite.config.ts`):
   - `optimizeDeps.exclude: ["dither-wasm"]` so the glue's
     `new URL('…bg.wasm', import.meta.url)` asset handling stays intact
     inside the worker chunk.
   - `build.target: "es2022"` (from `esnext`) — IMPROVEMENTS §3.4; WebKitGTK's
     JSC lags V8 and there is no ES-version guard anywhere. Costless today.
   - Verify three modes manually on Linux before trusting CI: `vite dev`,
     `vite build && vite preview`, and `tauri dev` (custom-protocol base URL
     is the one that historically bites worker asset resolution).
4. **CSP** (`tauri.conf.json:28`): append `'wasm-unsafe-eval'` to
   `default-src` (there is no separate `script-src`). Without it,
   `WebAssembly.instantiate` of compiled bytes is blocked in modern engines —
   the app would silently fall down the whole degradation ladder to JS-main.
   Keep `worker-src 'self' blob:` as is.
5. **TypeScript**: commit `dither_wasm.d.ts` consumption via the pkg types;
   add a thin typed wrapper module (`src/dither/engine.ts`) so no component
   imports pkg glue directly.
6. **CI** (none exists today; IMPROVEMENTS §3.1): one workflow with
   - `cargo fmt/clippy/test` (native — valid because the engine avoids libm
     dependence by §4.4, so native and wasm32 agree bitwise),
   - `wasm-pack build` + `vitest` parity suite (§8),
   - `pnpm build` + `tauri build` matrix later (out of scope here).
7. **Hygiene folded in**: fix the placeholder `allowBuilds` key in
   `pnpm-workspace.yaml` (real key is `onlyBuiltDependencies`, which is
   already present below it) so esbuild's postinstall isn't blocked on fresh
   installs; align the three version numbers.

---

## 8. Workstream D — parity assurance infrastructure

The engine is pure and deterministic — this is the cheapest insurance the
project can buy, and IMPROVEMENTS §1.7 already flagged it as prerequisite.

**Corpus** (`testdata/images/`): ~12 fixtures covering the decision space —
smooth gradient ramp, photographic portrait, hard-edged graphics, high-
frequency checker, flat regions with slight noise, an alpha-bearing PNG,
a 3-bit posterised source, and one >4 MP image (for region/stride paths).

**Sweep** (`testdata/suites/*.json`): declarative cases — all 29 algorithms ×
representative palettes (2-colour B/W, 12-colour stack, reordered stack) ×
all four match modes × tonalBias {0, 0.5, 1} × strength {0.5, 1, 1.8} ×
serpentine on/off × errorClamp {0, 255} × jitter {0, 0.4} × blur/sharpen
nonzero (exercises `boxBlur` parity) × pixelScale 2. Target a few thousand
cases; each records `SHA-256(output RGBA)` in a committed manifest.

**Runner**: vitest, Node environment. The pkg glue exports `initSync`, so a
single Node process instantiates the wasm module and imports the TS engine
and runs **both sides against the same manifest** — no browser farm needed.
Native `cargo test` additionally asserts Rust-native == Rust-wasm on a
smoke subset (cheap because of §4.4).

**Failure UX**: on mismatch, dump both outputs as PNGs plus a max-channel-
diff heatmap artifact and print ΔE statistics — a reviewable bug report, not
just a red ❌.

**Runtime self-check** (dev builds only, behind a settings toggle): run both
engines on the coarse job and log/snackbar any hash divergence. This catches
platform-specific drift (JSC vs V8 fallback differences) in real installs
during burn-in, then gets deleted with the TS engine.

**Acceptance gates**:
- Gate 1 (checkpoint, §4.5): refactored-TS goldens visually reviewed.
- Gate 2: Rust == goldens, byte-exact, entire sweep, scalar build.
- Gate 3: simd128/optimised build == scalar build.
- Gate 4: ladder drill — force each rung (worker kill, wasm init failure via
  feature flag, etc.) and confirm identical pixels per rung.

---

## 9. Milestones and effort

| # | Milestone | Exit criteria | Effort |
| --- | --- | --- | --- |
| M0 | Harness + goldens from *current* engine | Manifest committed; runner red/green demonstrably | 1–2 d |
| M1 | Shared-primitives refactor (TS side) + regeneration checkpoint | Gate 1 signed off; TS engine still ships | 1–2 d |
| M2 | Core Rust port: color/palette/prepare/FS-kernel | Subset of suite byte-green | 3–5 d |
| M3 | All remaining passes | Gate 2 green on full sweep | 4–6 d |
| M4 | Integration: worker protocol, ladder, export, bitmaps | Gate 4 passes; export async | 3–4 d |
| M5 | Build/CI/CSP wiring | Clean `tauri build` on Linux; CI gates live | 1–2 d |
| M6 | Optimisation + tuning | Gates 3; measured ≥5× on matcher-bound paths | 2–4 d |
| M7 | Burn-in release → flip default → delete TS engine | One release cycle; HUD shows wasm everywhere | 1–2 wk elapsed |

Total: roughly 3–5 focused weeks, of which the engine port itself (M2–M3) is
the bulk. This is deliberately wider than IMPROVEMENTS' "1–2 weeks" line item
because it prices in the harness (§8) and the integration ladder — skipping
those is how the half-port happened in the first place.

---

## 10. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| wasm init blocked by CSP/host quirk on some WebKitGTK build | Med | Silent ladder descent (perf loss, not breakage) | HUD backend badge (§6 B1); CSP token in M5; self-check toggle |
| Parity fails on transcendental-heavy paths despite §4.4 | Low | Schedule slip on M3 | The failing site is always a newly noticed libm call — audit is finite (§4.3 lists all six sites); harness localises it in minutes |
| Module-worker asset resolution breaks under `tauri://` for the pkg glue | Med | Falls to main+wasm (still correct, slower first paint) | Manual tri-mode check (§7.3); worst case inline the glue and fetch bytes explicitly |
| `wasm-opt`/LLVM update changes floating-point codegen | Low | Golden failures in CI | Pin toolchain versions; goldens catch instantly |
| Golden corpus misses a setting corner (e.g. omino direction × region crop) | Med | Post-release pixel diffs on that corner | Sweep is declarative JSON — adding cases is trivial; fuzz a few thousand random settings tuples in CI nightly |
| Dual-engine confusion persists longer than planned | Med | Maintenance drag | Stage C deletion is a named milestone with a release attached, not "later" |

---

## 11. Comparison — WASM vs WebGL2 vs Rust/Tauri commands

Three credible destinations for the pipeline. Each is assessed concretely for
*dizako as built*: a Tauri v2 desktop app (tauri 2.11.5) whose frontend must
also run standalone in a browser, whose hot path is sequential error
diffusion over ≤16 MP images, and whose preview architecture (two-stage,
coalesce, watchdog) is already correct.

### 11.1 Option A — WASM engine (recommended)

*What it means here:* finish `dither-wasm/` per §5–§8; the worker executes
compiled Rust; JS retains orchestration, geometry, and compositing.

**Pros**

- Single visual truth achievable *provably* (byte-exact goldens, §4) — the
  only option where parity is enforceable rather than approximated, because
  both candidate engines can be made to execute identical IEEE sequences.
- Browser-mode preserved with zero extra work (wasm runs in a tab).
- Kills the per-dispatch buffer copy and the main-thread `putImageData` as
  side effects of the memory model (§5.3, §6 B2) — wins IMPROVEMENTS credits
  to "Stage 0" for free.
- Keeps the existing, already-correct scheduling machinery (coalesce,
  watchdog demote, stale-drop) intact; integration surface is one file
  (`worker.ts`) plus the hook's init handshake.
- Predictable performance: no JIT warm-up variance, no GC pauses in the hot
  loop (all big arrays live in wasm linear memory), SIMD128 available.
- Export moves off the main thread with progress/cancel nearly free (§6 B3).

**Cons**

- Two languages in the tree; Rust compile times enter the edit loop.
- Toolchain surface to maintain: wasm-pack/wasm-bindgen/wasm-opt versions.
- Threading ceiling: single-threaded until SAB+COOP/COEP (N1) — fine for
  this workload, but it caps the upside vs native threads.
- Debugging across the wasm boundary is less comfortable than pure JS
  (though wasm-bindgen panics surface decently, and the rlib target allows
  native debugging of the engine itself).

**Performance characteristics**

- Matcher-bound diffusion passes: 5–15× over the current JS loop
  (IMPROVEMENTS §4.2 estimate; conservative given the LUT work in §4.4 also
  applies). Concretely: a Floyd–Steinberg fine pass over a 1920×1080+margin
  region (~2.4 MP) goes from ~150–300 ms-class JS to ~15–30 ms-class wasm;
  the 240 kpx coarse pass lands in low single-digit ms — under one frame.
- Memory traffic per slider tick: from (input copy + output transfer +
  main-thread blit) to (settings JSON + one bitmap transfer).
- Bundle: −~200 KB JS engine + ~150–300 KB wasm; net neutral, gzip favours
  wasm; parse/instantiate cost amortises to ~nothing after first job.

**Cross-platform implications**

- Identical bytes everywhere by construction — the strongest possible answer
  to "why does my Windows build look slightly different".
- No GPU, no codec, no header dependencies; works under Flatpak sandboxing
  without extra `finish-args`.
- The only platform variable left is the *worker* (WebKitGTK), which the
  ladder already handles and which costs a rung, not correctness.

**Maintenance cost**

- Ongoing: port every future algorithm twice? **No — after Stage C there is
  one engine.** Adding an algorithm means writing it once in Rust plus a
  settings field; the harness gains a case.
- Periodic: bump wasm-bindgen/wasm-pack; re-run goldens (minutes).

### 11.2 Option B — WebGL2 for the pipeline (or parts)

*What it means here:* fragment shaders implement match+mask; the graded
image uploads as a texture; palettes become uniform arrays (≤12 entries fits
comfortably). Error diffusion stays on CPU — GPU wave-front diffusion is a
research project, not a feature.

**Pros**

- The ordered family (bayer, halftone screens, blue-noise, IGN, checker) is
  embarrassingly parallel: <1 ms at any resolution, sliders effectively
  instant, zero CPU contention with a concurrently running diffusion job.
- Texture upload of the memoised `prepare()` output is paid once per tone
  change, and GPU resize/filtering could eventually replace canvas
  `drawImage` scaling in `downscale()`/preview compositing.
- Modern, well-trodden path on macOS (WKWebView) and Windows (WebView2).

**Cons — and they are decisive for this app**

- **It accelerates the wrong half.** The expensive algorithms in dizako are
  precisely the sequential ones (multi-tap diffusion, riemersma, dot-
  diffusion's rank cascade, omino's marching lines). The ordered family is
  already the *cheapest* family on CPU — after WASM it is sub-millisecond
  anyway. GPU buys back a problem the CPU no longer has.
- **Parity is structurally out of reach.** GLSL offers no f64 (highp is
  f32), so oklab matching and error arithmetic diverge from the CPU engine
  at the last-bit level — the same tie-flip cascade §4.3 describes, now
  permanently baked in. A GPU path means either a second visual truth
  (preview-GPU vs export-CPU) or shipping f32 everywhere and regenerating
  expectations.
- **Compositing friction.** The preview stack (coarse+fine+original layers,
  compare-split clip, drop shadow, HUD) is 2D-canvas based
  (`PreviewCanvas.tsx:136–163`). A WebGL canvas in that stack forces
  readback (`readPixels` stalls) or a layered-canvas redesign with its own
  blend-order subtleties.
- **WebKitGTK risk concentration.** The DMABUF/GL renderer has a history of
  driver-combo breakage on Linux — the exact environment this project
  develops for and ships first (deb/rpm/appimage targets). Context-loss
  handling, feature detection, and a CPU fallback ladder would be mandatory,
  i.e. the CPU engine must be kept in full anyway.
- Testing GPU shaders headlessly in CI means SwiftShader — more moving
  parts, weaker signal.

**Performance characteristics:** ordered pass <1 ms GPU at any resolution;
texture upload of a 16 MP RGBA source ≈ 64 MB ≈ 6–15 ms; readback of a full
frame similar, unless rendering directly to the displayed canvas. Net win
exists only for the family that is already fast.

**Cross-platform implications:** good on Win/mac; fragile story on
Linux/WebKitGTK; Flatpak needs DRI permissions; browser mode fine where GL
is sane.

**Maintenance cost:** highest of the three — shader code is a third language
in effect, driver matrices replace deterministic unit tests, and the CPU
fallback must be maintained in perpetuity, doubling the engine burden that
Option A just eliminated.

**Verdict:** reject for now; revisit only if, *after* WASM, profiling shows
users interacting primarily with the ordered family at resolutions where
even WASM feels heavy — an unlikely combination given ordered passes will be
sub-millisecond.

### 11.3 Option C — pipeline in Rust/Tauri commands

*What it means here:* delete the worker; `invoke("dither_frame", …)` carries
pixels/settings across IPC; the Rust process (currently 7 lines of glue,
`src-tauri/src/lib.rs`) hosts the engine with `rayon` + `image`.

**Pros**

- Native speed ceiling above WASM: auto-vectorisation against the host ISA
  (AVX2/NEON beats simd128), real threads via rayon (ordered/threshold
  families scale with cores; even diffusion benefits for *independent*
  tiles in the coarse pass).
- Best-in-class IO: the `image` crate fixes the AVIF/WebP codec lottery
  (IMPROVEMENTS §3.5 — decode currently rides whatever gstreamer plugins the
  user's webkitgtk pulls in) and unlocks JPEG/WebP/AVIF export with QoI
  controls (§1.3) without shipping megabyte blobs through the webview.
- Removes the WebKitGTK module-worker fragility from the equation entirely;
  progress arrives via IPC channels instead of the watchdog.
- The 400 KB engine leaves the JS bundle completely.

**Cons — one of them fatal for this app**

- **Browser mode dies.** `saveImage.ts` and the empty-state promise
  ("Everything is processed locally") presuppose the app runs as a plain
  page too. Commands don't exist in a tab, so the JS engine would have to be
  kept forever as the browser fallback — permanently reintroducing the
  dual-engine drift this plan exists to eliminate, and making the §8 parity
  harness a permanent tax instead of a temporary bridge.
- **Per-frame IPC tax on the interactive path.** A coarse pass is 960 KB
  (240 kpx × 4 B); a zoomed-out fine pass legitimately covers up to 80% of a
  16 MP image (`region.ts:62` caps regions at 0.8 coverage) ≈ **51 MB per
  frame** crossing the process boundary, versus zero-copy reads from wasm
  linear memory in Option A. Tauri v2's raw IPC payloads reduce JSON
  overhead but not the copies; sustained slider drags turn this into
  tens of MB/s plus per-call latency (~0.3–2 ms fixed) — budget that competes
  directly with the 16 ms frame the preview lives in.
- Architecture churn with real risk: cancellation, coalescing, and
  stale-reply dropping must be rebuilt atop futures/channels; the current
  hook logic transfers wholesale but its invariants (single-flight + queued
  latest) need re-proving.
- Dev-loop and CI cost: every engine change rebuilds the shell; CI grows a
  per-target matrix; logging spans two processes.

**Performance characteristics:** compute 2–5× beyond wasm on scalar code and
near-linear scaling on parallelisable families — but the interactive path
gains a fixed serialisation+copy+latency toll per frame that Option A does
not pay, and the worst-case frames (zoomed-out fine passes) are exactly the
big-buffer ones.

**Cross-platform implications:** excellent consistency (native code, no
webview maths), and it is the only option that fixes codecs at the root.
But bundles grow (codec crates), and the browser story is sacrificed or
split-maintained.

**Maintenance cost:** one engine language (good), but two runtime processes,
an IPC protocol to version, and either a lost feature (browser mode) or a
permanent second engine (worst outcome).

### 11.4 Head-to-head

| Criterion | A — WASM | B — WebGL2 | C — Rust commands |
| --- | --- | --- | --- |
| Provable visual parity | **byte-exact (§4)** | structurally impossible (f32 GLSL) | byte-exact vs itself, but browser mode needs engine #2 |
| Browser mode | **kept free** | kept | lost or dual-engine |
| Speed on slow algorithms (diffusion) | 5–15× | no help (sequential) | fastest (native + threads) |
| Speed on fast algorithms (ordered) | sub-ms (enough) | <1 ms (redundant) | fast |
| Worst-case frame cost (zoomed-out fine) | zero-copy | readback stalls | ~50 MB IPC |
| WebKitGTK risk | low (worker rung only) | **high (GL/DMABUF)** | lowest |
| Export/codec story | PNG via OffscreenCanvas; codecs still webview's | same as A | **best (`image` crate)** |
| Integration churn | moderate (one worker file) | high (compositing redesign) | **high (replace scheduler)** |
| Long-term engine count | **1 (after Stage C)** | 2 (GPU + CPU fallback) | 1–2 (browser question) |
| Toolchain burden | wasm-pack trio | shaders + driver matrix + Swiftshader CI | rust toolchain only |

### 11.5 Combinations

- **A + narrow C (recommended):** WASM engine for everything interactive;
  Tauri commands confined to the IO boundary — `decode_fallback(path)` for
  formats the webview can't decode (fixing §3.5 where gstreamer lets users
  down) and `encode(path, pixels-or-source-ref, format, qoi)` for JPEG/WebP
  export (fixing §1.3's PNG-only gap). Pixels cross IPC once per *load/save*,
  never per frame, so the IPC objection doesn't apply. This pairing takes
  each technology where it is uniquely strong.
- A + B: technically coherent (GPU ordered family, wasm diffusion) but
  buys sub-millisecond relief for algorithms that are already sub-millisecond
  under A, at the price of a permanent second truth and the WebKitGTK GL
  lottery. Only justified by evidence gathered after M7.
- B + C: maximum capability, maximum surface area; no scenario in this
  codebase motivates it.
- Full C alone: cleanest desktop architecture in the abstract; wrong for an
  app whose repo demonstrates it wants to keep running as a web page.

### 11.6 Recommendation for dizako

1. **Adopt Option A as the engine strategy** (this document, §5–§9). It is
   the only path that simultaneously satisfies browser compatibility (G4),
   provable parity (G1), and the existing preview architecture (G2) without
   permanent dual-engine maintenance.
2. **Adopt the A+C hybrid at the IO boundary only**: Rust commands for
   decode fallback and export encoding, scheduled as a fast-follow after M7
   — small, separately valuable, no per-frame IPC.
3. **Reject Option B** with a written revisit condition: post-M7 profiling
   showing ordered-family interaction pain at scale. On current evidence
   that condition cannot be met, because WASM puts the ordered family in
   the same class as the GPU would.
4. Keep the degradation ladder and the HUD badge through one full release
   (burn-in), then execute Stage C — one engine, one visual truth, and the
   parity harness shrinks from "cross-engine treaty enforcement" to ordinary
   regression tests.

---

## Appendix — quick reference: determinism-critical call sites

| Call site | Library fn | Replacement |
| --- | --- | --- |
| `color.ts:28` srgbToLinear | `Math.pow` | generated 4096-entry interpolated LUT |
| `color.ts:38–40` rgbToOklab | `Math.cbrt` ×3 | shared Newton `cbrtShared` |
| `algorithms.ts:229/237` toneCurve | `Math.pow` ×2 | per-job LUT via shared pow |
| `algorithms.ts:287–288` hueMatrix | `cos`, `sin` | shared minimax sincos |
| `masks.ts:209–212` rotate | `cos`, `sin` per pixel | hoist per job via shared sincos |
| `algorithms.ts:783` riemersma weights | `Math.pow` | shared pow |
| `masks.ts:79` void-and-cluster | `exp` | embed frozen 64×64 tile |
| `algorithms.ts:564` makeRandom | — | port xorshift32 verbatim (wrapping ops) |
| `algorithms.ts:775/857` size selection | `log2`/`round` | integer `ilog2`/bit tricks |
