# Measured mesh kernel boundary

The September 20 Training profile (seed 1, 14 meshes, 30 warmup and 120
measured frames at 1/60 second) attributes 13.55 ms/frame to mesh posing and
7.42 ms to simulation. The browser CPU profile also puts GetFrame's BigInt
x87 arithmetic at the top. This is a measured reason for one Rust/Wasm
kernel; it is not evidence for porting the script VM or changing tick rates.
Raw profiles remain in `.cache/perf/wasm-baseline.cpuprofile` and
`.cache/perf/browser-wasm-baseline.cpuprofile`, outside Git.

## Original contract, before the port

The authority and complete contract are in [GetFrame](script-lodmesh-frame.md).
The hash-checked original Engine.dll body `10355360..103568e5`, with Core
coordinate helpers, already has 46 complete captured reference calls. Reuse
those exact input specs and compare every output/cache byte, padding, cache
event, lock, count and archive position before enabling the kernel in Play.

Only the repeated vertex loops cross into Wasm. JavaScript retains lazy Load,
sequence lookup, owner selection, matrix construction, cache identity/leases,
negative-frame tween decisions/completion and the four-slot call order.

* Source vertices are three signed i16 components in an eight-byte record.
* Normal interpolation stores local pose in the existing f32 cache. X retains
  subtraction/product in extended precision; Y/Z store each to f32 first.
* Tween interpolation uses the existing cached pose and the target frame.
  Zero alpha keeps the cache unchanged. Completion/count expansion stays in JS.
* Main publication subtracts mesh origin with f32 stores, then coordinate
  origin without an intermediate store, and computes `(x*a + y*b) + z*c`.
* Each blend subtracts absolute frame zero with f32 stores, transforms without
  coordinate origin, adds to existing output and stores f32 in slot order.
* The caller's stride/padding and untouched vertices must survive. Actor state
  remains read-only. No mesh detail or animation cadence changes.

Wasm exposes f32/f64 rather than the original x87 format
([WebAssembly numeric types](https://webassembly.org/docs/portability/)). The
kernel therefore needs integer software arithmetic retaining a 64-bit
significand, nearest-even rounding at each original operation and f32 store,
signed zeros and the existing original NaN-selection rules. Ordinary Rust f32
or f64 expressions would not establish fidelity. Integer ABI arguments and
linear-memory buffers avoid per-operation JS/Wasm calls and NaN conversion.

Existing unsupported GetFrame branches and native heap/exception services
remain as documented in the original contract. Arithmetic differential tests
check the new language boundary; only the original captures establish native
agreement for their covered behavior.

## Results

Unprofiled Training CPU runs with the same seed, data, 14 displayed meshes,
30 warmup frames and 120 measured 1/60-second frames:

| CPU time per frame | JavaScript | Rust/Wasm |
| --- | ---: | ---: |
| Simulation mean | 6.85 ms | 6.69 ms |
| Mesh posing mean | 12.99 ms | 2.33 ms |
| Combined mean | 19.84 ms | 9.02 ms |
| Combined p95 | 21.29 ms | 10.76 ms |

The measured posing speedup is 5.6×, and combined CPU time drops 55%. These
measurements exclude GPU rendering and do not predict larger, unsupported NPC
populations. Both runs report the same ten existing NPC startup/AI failures.

Chromium on the Apple M2 Pro Metal backend, 1440×960/DPR 1, with 60 warmup and
300 measured frames, gives 18.33 ms mean / 33.3 ms p95 for JavaScript and
16.67 ms mean / 16.7 ms p95 for Wasm (roughly 55 to 60 fps). Both retain all
14 meshes, 409 draw calls, active Play, and no page/runtime errors. The 60 Hz
display cadence limits the visible FPS gain; the CPU reduction provides more
headroom. This does not reproduce the user's particular browser/session.

Raw timing reports: `.cache/perf/wasm-{js,rust}.json` and
`.cache/perf/wasm-browser-{js,rust}.json`, outside Git. The existing 46 original
GetFrame captures match **both** backends byte for byte. The 14-mesh runtime
validator and all 490 unit tests pass; the production build includes the kernel.
Four focused Chromium/Metal browser tests pass: Training movement/doors/stairs/
reset, Liberty Island movement and mode switching, loading the production build
from local files with the Wasm asset, and moving in Play after the Wasm request
is blocked. Rust formatting and Clippy with warnings denied also pass.

## Build and reproduce

Install a Rust toolchain and `rustup target add wasm32-unknown-unknown` once.
The dependency-free crate uses the [Rust Wasm target](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html)
and integer/buffer exports, with no wasm-bindgen or host imports. Tested with
Rust 1.95. `npm run dev`, `npm run build` and `npm test` compile it via
`npm run build:wasm`. The generated 31 KiB `.wasm` stays out of Git and Vite
ships it as a hashed static asset. No original assets enter the module.

Play loads the kernel once and reuses scratch memory across meshes/channels.
The adapter refreshes views after memory growth and copies only the requested
vertices. The original JavaScript implementation remains the fallback if
loading fails. `deusExViewer.status().npcPreview` reports `poseBackend` and
`kernelError`; `?meshBackend=javascript` forces the comparison path.

## Developing across the boundary

New gameplay, NPC scripts, inventory and mission behavior continue in
JavaScript. Actors using the existing mesh path benefit from the kernel without
a second implementation of their gameplay behavior. Rust owns only the bulk
vertex interpolation and publication operations described above.

Changes to those accelerated operations must update both the Rust kernel and
the retained JavaScript fallback. Rebuild with `npm run build:wasm`, run the
focused ABI tests and compare both backends against the matching original
GetFrame references. JavaScript/Rust agreement alone is not original-game
evidence. If behavior expands, establish its original contract and reference
cases before admitting it into either backend.

Keep the interface bulk-oriented: pass vertex buffers and channel parameters,
with no per-arithmetic-operation JS/Wasm calls. Preserve cache ownership and
control flow in the shared JavaScript caller. Port other subsystems only when
profiling identifies a specific bottleneck that warrants the added maintenance.

```
npm run build:wasm
node scripts/validate-lodmesh-frame.mjs --captured --wasm
node scripts/validate-npc-mesh-preview.mjs
node --test test/lodmesh-wasm.test.mjs
node scripts/benchmark-play.mjs --javascript
node scripts/benchmark-play.mjs
# With npm run dev running; --metal selects real GPU rendering on this Mac:
node scripts/benchmark-browser.mjs --metal --javascript
node scripts/benchmark-browser.mjs --metal
```

Browser benchmarking reports the actual WebGL device and samples 300 frames
after 60 warmup frames at 1440×960, DPR 1. `--profile PATH` optionally saves a
Chromium CPU profile (use a path outside Git); profiling adds overhead. The
default headless backend may be software rendering, so compare like backends.

Nonfinite cache experiments exposed NaN canonicalization in the existing JS
array/presentation path. The Rust integer ABI preserves payloads according to
the scalar x87 model; its focused nonfinite test compares to that model. The
46 original complete GetFrame fixtures do not establish full nonfinite mesh
behavior. This remains outside the native coverage claim, rather than treating
agreement with JS canonicalization as original-game evidence.
