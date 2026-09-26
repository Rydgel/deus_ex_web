# Live NPC frame-time investigation

The current account of a real Play frame, measured in the browser, is
[frame cost](play-frame-cost.md) (September 26, 2026). The numbers below
predate Login, the native HUD and the object-model work.

The subsequent [measured Rust/Wasm vertex kernel](lodmesh-wasm.md) reduces
Training mesh posing from 13.0 to 2.3 ms/frame while retaining the same 46
original-DLL byte comparisons. The investigation below describes the earlier
scheduling and JavaScript arithmetic changes.

The September 20, 2026 local Training profile found two costs introduced into
ordinary Play when NPC startup/ticking and animated meshes became live:

* The host replayed all actor work through its browser-only 120 Hz accumulator.
  A 200 ms rendered frame therefore requested 24 complete actor passes, each
  including the original walking surface/ladder scans and collision queries.
  Increasing frame time increased the next frame's work. This was host
  scheduling overhead, not evidence that NPC physics should be skipped.
* GetFrame repeated identical extended-coordinate loads and origin
  subtractions for each output axis. Its shared x87 significand-width helper
  allocated binary strings in the inner arithmetic loops.

## Original contract and bounded correction

Existing hash-checked Engine.dll disassembly was reviewed before changing
cadence: `ULevel::Tick 103a5468..103a5487` multiplies input float time by
TimeDilation, stores the double level clock and float LevelInfo.TimeSeconds
before clamping actor time to 0.005–0.4 seconds. `103a5698..103a56cd` performs
one ascending actor pass, followed by owner-deferred retries, not a fixed
120 Hz replay. The complete contract and native cases are in
[level scheduling](script-level-tick.md). The existing original physics
routines already own their remaining-time subdivisions.

Play now uses the scheduler's shared time calculation once per browser
animation frame. It reads live TimeDilation, publishes script TimeSeconds
before actor execution, and preserves the existing admitted actor order.
Browser animation frames remain the host time source; this does not claim
original device input timing, full-world admission, or complete level
scheduler integration. NPC startup/AI boundaries remain as documented in
[NPC startup](script-npc-startup-animation.md).

GetFrame reuses loaded operands and identical subexpressions within one call.
It retains extended arithmetic, float stores, cache/tween history, blend order,
all admitted meshes, and sampling on every changed pose. No distance/visibility
throttling, guessed LOD, animation-rate reduction or precision substitution is
introduced. See [frame evidence](script-lodmesh-frame.md).

## Measurements and checks

Local Node profiling, using original Training data, seed 1, 14 displayed
meshes, 30 warmup frames and 120 measured 1/60-second inputs, initially measured
12.7 ms simulation plus 20.1 ms mesh posing per frame. Removing redundant
arithmetic alone reduced mesh posing to 12.2 ms in the same profiled workload.
The final unprofiled benchmark measured 6.5 ms simulation plus 12.6 ms posing
(19.2 ms combined mean, 21.4 ms p95). These CPU timings exclude GPU rendering;
profiler overhead and machine/browser differences prevent treating them as
promised display FPS.

A separate Chromium headless check at 1440×960 measured average rendered
frame intervals of 207.7 ms before and 88.6 ms after the scheduling/arithmetic
correction (roughly 5 to 12 fps). WebGL renderer inspection identified the
default headless backend as SwiftShader software rendering. With
`--use-angle=metal`, WebGL reports the Apple M2 Pro Metal renderer; the final
build measured 18.6 ms average intervals (about 54 fps), with a 16.7 ms median
and 33.3 ms p95. The unchanged previous build (`62739cc`), served separately
with the same viewport and Metal backend, measured 64.6 ms average intervals
(about 15 fps), a 50.1 ms median and 116.6 ms p95. The average frame interval
therefore improved by about 3.5×. Both sessions remained in Play without a
runtime error and submitted 409 draw calls. This still is not a measurement of the user's interactive
browser session. Raw local profiles stay outside Git in
`.cache/perf/`. `node scripts/benchmark-play.mjs` reproduces the CPU workload
and reports existing unsupported NPCs alongside timings.

Verification stays focused on changed boundaries:

* `validate-level-tick.mjs`: all 31 original-DLL scheduling/clock cases pass.
* `validate-lodmesh-frame.mjs --captured`: all 46 matching original input specs
  and output/cache bytes pass, including transforms, tweens and blends.
* `validate-native-float-vector-operators.mjs`: all 116 original arithmetic
  cases pass, including precision boundaries, NaN payloads and signed zeros.
* `validate-play-frame.mjs`: actual Play gives each supported NPC/player/HUD
  one pass at normal, slow, minimum-clamped and maximum-clamped deltas; checks
  time dilation, unclamped clock advancement, script time and reset.
* `validate-npc-mesh-preview.mjs`: the 14-mesh runtime/buffer integration passes.
* `validate-gameplay.mjs`: both original-data map routes pass, including
  closing-door contact and reset.
* All 487 unit tests and the production build pass. Both browser gameplay
  tests pass, covering Training movement/doors/stairs/reset and Liberty Island
  movement/Inspect switching.

These performance and host-integration checks do not establish new original
gameplay fidelity beyond the reused native contracts.
