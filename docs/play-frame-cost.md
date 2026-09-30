# Play frame cost from first principles

## September 30: GPU time isolated

`scripts/profile-play-browser.mjs --gpu` sets the viewer's `?gpuTimer=1`,
which wraps the frame's GL work (the mirror, sky, main scene, weapon and HUD
draws) in one `EXT_disjoint_timer_query_webgl2` TIME_ELAPSED query and reads
the results frames later; `phases.gpu` is GPU milliseconds per measured frame,
valid when `phases.gpuFrames` is near 1 and `phases.gpuDisjoint` is 0. The
Island walk (1440×960, DPR 1, ANGLE Metal on the M2 Pro, 300 frames) measured
**1.46 ms of GPU time per frame**, one result per frame and no disjoint event,
against 30.6 ms of host work (tick 14.1, actors 9.6, render 3.3, HUD 2.6). The
frame is CPU-bound on both halves: the presentation cost is preparation and
submission, not GPU load, so GPU vertex lighting would move work onto a GPU
that is idle rather than remove it. This closes the "GPU frame time has not
been isolated" caveat below. The 120 fps target is not met.

## September 30 continuation: movement, lighting and upload costs

The next pass targets measured work inside the existing contracts:

- `971320e` makes [noncolliding rider MoveActor](rider-move-kernel.md) use authoritative
  actor image cells and the existing zone kernel. Zone changes, collisions,
  Touching, standing riders, host bindings and unsupported image layouts
  fall back before any store. Two paired real Island workloads execute the
  same 23,905 rider calls and retain the same state digest. Instrumented
  rider-entry cost is 0.567/0.561 ms per tick in JavaScript versus
  0.081/0.088 ms in the image path: approximately 0.48 ms saved within that
  family. Total tick measurements do not establish a whole-tick speedup.
- `976edab` removes formatted strings and temporary arrays from the
  [mesh-light constant memo lookup](mesh-lighting.md#constant-cache-lookup-cost).
  Two paired setup-only workloads over 304 nonhidden Island mesh actors
  measure 2.69 to 2.46 ms and 2.85 to 2.60 ms. All 64 compared frames retain
  exact selected lights, traces, colors and fade records. This workload
  includes actors outside the viewport and is not a browser FPS result.
- `b643085` avoids redundant Mesh reads and identical
  [actor color-buffer uploads](actor-mesh-updates.md). The walking census
  finds 45.5% of group updates already equal, about 239 graphics-buffer
  updates per frame and 14.1% of the color bytes. Lighting calculations and
  state updates still execute. Scatter CPU timing is effectively unchanged.

### Browser comparison

Reference `ef47f61` and the retained candidate were run in alternating order,
twice each, with the same Island walk, 1440×960/DPR 1, Chromium/Metal M2 Pro,
300 measured frames, 1,500 ms settling and fixed `dt=1/120`. There is no CPU
sampler, bypass or concurrent project validation job in the timed windows.
Every run remains in active Play with no runtime/page errors.

| Per-frame metric | Reference, two run means | Retained candidate, two run means |
| --- | ---: | ---: |
| Simulation | 12.15 / 12.62 ms | 12.74 / 12.64 ms |
| Light collection | 0.68 / 0.70 ms | 0.74 / 0.69 ms |
| Actor preparation | 9.56 / 9.80 ms | 9.91 / 9.71 ms |
| Render | 3.32 / 3.37 ms | 3.51 / 3.43 ms |
| HUD | 1.81 / 1.87 ms | 1.99 / 1.96 ms |
| Total host work | 27.81 / 28.68 ms | 29.23 / 28.74 ms |
| Median display interval | 33.3 / 33.3 ms | 33.3 / 33.3 ms |

These browser runs **do not establish an overall speedup**; candidate means
are slightly higher. Several unchanged phases vary as well. The isolated
work reductions above must not be presented as achieved FPS. Main-scene
calls stay near 661 and HUD calls near 55. Raw reports are
`.cache/perf/runtime-{base,after}{1,2}.json`, outside Git. The candidate is
still far from the 8.33 ms total budget for 120 fps.
The browser captures precede the final conservative hand-back for a
nonfinite resulting position. Final real-data differentials and the isolated
rider timings include that guard; it rejected no moves in those workloads.

### Why the next change needs a larger boundary

The fresh sampled profile attributes about 5.5 ms to actor relighting,
2.0 ms to poses and 0.8 ms to scene reconciliation. About 2.75 ms of lighting
is already inside Wasm. Most meshes in the lighting census have active
lights; broad unlit/modulated shortcuts would remove little work. On the
simulation side, the Rust actor-tick loop still calls back into the existing
physics and event families. Completing a small loop's port does not remove
the work those callbacks perform.

`5452a0b` recovers the original
[mesh bounds and raster admission rules](render-visibility.md) and compares
them with native code. At Island start, they
reject 17 of the 220 host-visible previews because their native projected
integer Y range is empty. No guessed distance threshold is involved. The
standalone exact box transform plus projection costs 7.20 ms for those 220
actors (9.32 ms for all 291 prepared actors); projection alone with cached
boxes costs 0.41 ms (0.47 ms for all 291). No net avoided-work gain is
established, so this is deliberately outside Play. A practical integration
needs cheap bounds invalidation/transforms, native child-frame inputs and
the remaining BSP/span visibility contract. Full movement B4–B6 and that
visibility work remain the substantial targets; the 120 fps milestone is
not complete.

All 576 unit tests and the production build pass. Focused native movement,
lighting and bounds comparisons, real-data movement differentials, and the
actor-scene/upload boundary checks pass. These checks verify the changed
boundaries; they do not establish complete renderer fidelity. The previous
spawned Touching fix remains in place, and the new movement path explicitly
rejects actors with nonempty Touching before any write.
The temporary comparison server is stopped and its managed baseline worktree
archived. All changes and captures remain local.

## September 30 follow-up: verified reductions in rendering work

Three runtime changes are committed on master:

- `60c587e` applies the recovered moving-light gate before constructing full
  light records. Island's collection builds 16 instead of 436 records; a live
  Play-start frame ends with 273 after actor lighting requests the static lights
  it needs. The whole frame avoids 163 records, not 420. See
  [lighting evidence and focused checks](mesh-lighting.md#moving-light-collection-and-deferred-records-september-30).
- `1d8486c` shares immutable GPU actor skins while retaining private materials,
  decode awaits and material allocation order. The complete Island actor scene
  uses 128 textures instead of 739; associated RGBA mip payload falls from
  51,673,564 to 12,354,928 bytes. Unchanged Style/ScaleGlow also avoids redundant
  material assignments. [Resource and state verification](actor-mesh-texture-sharing.md)
  includes every group, sampler and texel, plus resource lifetime checks.
- `eb04aab` merges consecutive compatible opaque world draws in their existing
  material order. Up to eight separate base samplers and array lightmaps preserve
  filtering, depth ties, transparency and mirrors. The final shader retains the
  original vertex varying layout and decodes its packed indices with integer
  arithmetic. [Geometry and GPU checks](lighting.md#ordered-world-submission-boundary)
  cover 57,574 original-map triangles, 17,868,096 real-map pixel channels and
  3,538,944 synthetic channels, including context restoration.

### Final Play measurement and its limits

The reference is `96d0203`, which already includes the HUD batching and spawned
Touching fix. The final run uses `eb04aab`. All runs use Island walking,
1440×960/DPR 1, Chromium/Metal on the M2 Pro, 300 measured frames, 1,500 ms
settling, fixed `dt=1/120`, and no CPU sampler or bypass. Simulation remains
active with no runtime errors. This is a controlled workload, not a claim of
120 fps interaction. Two baseline runs and one final retained-code run give:

| Per-frame metric | Reference (two run means) | Final run |
| --- | ---: | ---: |
| World mesh submissions, including sky | 336 | 65 |
| Main scene WebGL calls | 932.46–932.47 | 660.95 |
| Render phase | 4.09–4.61 ms | 3.50 ms |
| Light collection phase | 1.45–1.51 ms | 0.74 ms |
| Actor preparation | 9.34–9.94 ms | 9.81 ms |
| Simulation | 12.72–14.20 ms | 12.88 ms |
| HUD phase | 1.87–2.09 ms | 1.85 ms |
| Total host work | 29.80–32.71 ms | 29.10 ms |
| Median display interval | 33.3 ms | 33.3 ms |

The submission/resource reductions are repeatable. Earlier interleaved runs
of the batching candidate reduced render and collection time but did not show
a stable total-frame gain: simulation and actor time moved enough to erase it
in one pair. The final run is encouraging but does not establish a stable FPS
improvement. Some light-record work moves from collection into actor preparation;
the collection timer alone overstates the saved work. Raw reports are
`.cache/perf/renderer-{base1,base2,committed}.json`; exploratory reports retain
their `after1`, `after2` and `final` suffixes outside Git.

World triangles submitted increase from 30,852 to 33,544 because merged bounds
are coarser; clipping preserves the checked pixels. Actor submissions remain
about 494 groups and movers remain 20. Batching also performs extra GPU texture
fetches, and layers still used by unbatched surfaces retain separate GPU page
storage. These trades are explicit; neither total VRAM nor final whole-frame
GPU busy time was measured.

The 8.33 ms target remains unmet. Simulation plus actor preparation alone is
22.69 ms in the final run. The next substantial work remains original
bounds/BSP/span visibility and the complete memory-backed movement family,
not another isolated scalar Rust port. `78331fd` recovers and validates the
[early native visibility gates](render-visibility.md), but deliberately leaves
them outside Play: all 220 currently visible Island-start previews pass them,
so those gates alone would save no draws in that capture.

Verification: all 574 unit tests and the production build pass. Focused native
mesh-lighting, actor-scene, original-map geometry, GPU and visibility-oracle
checks pass. These results establish the changed boundaries, not completion
of original renderer fidelity or the 120 fps milestone. The temporary baseline
server was stopped and its managed worktree archived; the working preview and
all commits remain local.

## Initial September 30 investigation: the 120 fps budget after the Rust port

The initial Island investigation supersedes the older stopping point below.
The workload is original-data Play at 1440×960, DPR 1, Chromium/Metal on an
Apple M2 Pro, walking forward. No original boundaries were bypassed and Play
remained active without runtime errors. The reference code is `1a17e36`
(`0de223c` has identical executable code). The new submission counters run
after the timed window; CPU sampling can now be disabled with `--no-profile`.

The initial 180-frame profiled run's wall timers measure 16.83 ms in simulation,
9.90 ms in actor meshes, 1.54 ms in lighting setup, 4.84 ms in the render phase
(sky, main scene and weapon), 3.35 ms in the HUD and 0.38 ms in mirror setup
(no child mirror was drawn).
The mean host frame work is 36.84 ms. These are host measurements, not a
benchmark of the original executable. The 120 fps budget is **8.33 ms for
everything**, not 8.33 ms for each subsystem.

The actor-mesh profile is particularly useful: 4.64 ms is relighting (2.62 ms
inside the Rust lighting kernel), 2.16 ms is GetFrame/its adapter, about
0.9 ms is normals/position copies/bounds, and 0.82 ms is scene reconciliation.
The earlier statement that most mesh time is JavaScript around the kernels
is incomplete: significant numeric cost is already in Rust. Further Rust
ports do not eliminate poses, light evaluations or submissions.

An after-timing submission census at the end of the Island walking route
found 336 static-world groups/30,852 triangles, 20 mover groups/120 triangles,
and 495 actor-mesh groups/32,011 triangles per frame. These include the sky
pass. A mesh group is not always one WebGL call (double-sided transparency
can use two); the timed main pass reported about 913–916 WebGL calls plus
10 in the sky. It is not accurate to call all of those world-BSP draws.

### Verified change: consecutive HUD batches

The previous compositor populated and submitted one retained mesh for every
tile or glyph, allocating temporary vertex/UV/color arrays per draw.
`e3484a0` concatenates only consecutive equal-material commands
in reusable buffers. It preserves command, triangle and blend order. It does
not cache or skip the original HUD/window scripts. The exact boundary and
pixel checks are in [Play HUD](script-play-hud.md#compositor-batching-boundary).

The first exploratory unprofiled walking pair reduced the HUD/weapon-overlay
submission counter from
185.86 to 58.12 and HUD phase time from 3.34 to 2.30 ms. Total host work was
39.79 versus 33.33 ms, but simulation and other phases also varied; that whole
6.46 ms difference must not be credited to HUD batching. Both median display
intervals were still about 33.3 ms. This is a useful reduction, not 120 fps.

Two further interleaved A/B pairs, without concurrent project validation jobs,
used `--fixed-dt 0.008333333333333333`, 180 measured frames, the same walk,
viewport and backend, and no CPU sampler. This fixes simulation step length;
it does not pin browser startup timing, the viewport clock or JIT/GC stalls.

| Per-frame metric (range of two run means) | Reference | Reworked |
| --- | ---: | ---: |
| HUD phase | 2.18–2.21 ms | 1.87–2.08 ms |
| HUD/weapon-overlay submissions | 146.24–146.59 | 53.77–53.83 |
| Main scene submissions | 939.95–940.12 | 939.91–940.12 |
| Simulation | 13.97–14.11 ms | 13.84–15.95 ms |
| Actor preparation | 9.58–10.01 ms | 9.68–10.49 ms |
| Total host work | 32.07–32.66 ms | 31.61–35.56 ms |

The submission reduction is repeatable, and the HUD phase improves in both
pairs, but **there is no stable total-frame speedup demonstrated by these
short runs**. The slower second reworked run rises across simulation, actors
and rendering too. Both builds remain near a 33.3 ms median display interval.
Do not present the earlier exploratory total reduction as a benchmark win.
The retained change has exact adapter equivalence and removes measured
submission work; the dominant costs still need the work below. Local reports
are `sept30-fixed-{base,after}{1,2}.json` in `.cache/perf/`.

### What should happen next

1. **Recover the original visibility path.** The current renderer batches
   whole-world surfaces and uses host frustum checks for actor meshes. It
   lacks original BSP/span/portal visibility, so occluded actors can still
   be posed, lit and submitted. Recover Render.dll OccludeBsp/SetupDynamics,
   the dynamic-actor filters and their ordering, with original visible actor
   and zone reference cases before implementation. This also affects
   LastRenderTime/zone feedback and thus simulation behavior; it is not safe
   to substitute line-of-sight rays or arbitrary distance throttling.
   [Existing timestamp evidence and gaps](script-loadmap-startup.md#renderer-feedback)
   explain why the renderer and simulation must be verified together.
2. **Remove submission splits that carry no distinct draw state.** This
   investigation led to the verified ordered world batches and actor texture
   sharing above. The initial static Island census had 14 lightmap pages and about 403
   texture/all-flags/page groups before texture-property flags and movers.
   Grouping by actual rendering flags gave 302 candidates; removing page
   splits gave about 160 texture/flags candidates. Subsequent depth-order
   analysis ruled out freely regrouping those meshes: only consecutive
   compatible runs may merge. The retained change verifies order, gamma,
   filtering, mirrors and dynamic atlas updates as described above.
3. **Finish movement as a whole memory-backed family.** Pawn physics,
   walking, rider moves, collision updates and their host field adapters
   still occupy several milliseconds. The 37-trace walking scan is already
   one Rust call, so another scalar port is not the answer. R3-b B4–B6 must
   retain original callback order/reentrancy and operate on the live image.
   CycleActors/resumption is a smaller secondary candidate. The
   [simulation investigation](rust-core.md#september-30-choosing-the-next-simulation-change)
   also records why another class cache and a per-object field bitmap were
   rejected as the next changes.
4. **Consider concurrency after those boundaries are explicit.** A worker
   can overlap simulation and presentation, but neither currently fits
   8.33 ms alone. Moving work off-thread cannot by itself produce 120 fps;
   previous-frame render feedback, synchronous events, input and snapshot
   timing need a fidelity contract first.

The original game executes native property loads, arithmetic and visibility
traversal. This port still pays for host field adapters, exact numeric
translation, per-mesh CPU preparation and hundreds of WebGL submissions.
The small original workload does not make those per-unit costs disappear.
There is no evidence here that a modern GPU's triangle throughput is the
primary limit; CPU submission and preparation are measured, while GPU frame
time has not been isolated.

Reproduce without sampling overhead:

```sh
node scripts/profile-play-browser.mjs --map 01_NYC_UNATCOIsland --walk \
  --frames 180 --settle 500 --no-profile --draw-counts --tag island
# Optional fixed-step comparison; this is an artificial timing workload,
# not proof of interactive/display FPS:
node scripts/profile-play-browser.mjs --map 01_NYC_UNATCOIsland --walk \
  --frames 180 --settle 500 --no-profile --fixed-dt 0.008333333333333333 --tag island-120
```

Reports identify the GPU, sampler use and fixed-step override. They retain
partial diagnostics but exit unsuccessfully if Play stops, pauses or errors.
Use interleaved runs on an otherwise idle machine; a 60 Hz display quantizes
frame intervals, so compare the host phases as well. Raw profiles and
captures remain outside Git in `.cache/perf/` and `.work/`.

Verification for this rework: all 567 unit tests and the production build
pass; the original Play HUD integration and compositor pixel/attribute
checks pass. The separate [spawned Touching correction](script-spawn-touching.md)
passes six original-DLL cases and both-engine/both-map checkpoint checks.
These focused checks do not claim completion of original renderer visibility
or the 120 fps milestone.

This September 26, 2026 investigation (commit `5978bf3`) measures real Play in
the Training map, where the user reported an average of about 34 fps with
occasional drops. It replaces the earlier headless CPU numbers in
[play performance](play-performance.md) and [the mesh kernel](lodmesh-wasm.md)
as the current account of where a frame goes. Everything here is host
measurement. No finding in this note is original-game behavior, and no change
it motivated alters an original behavior contract.

## Method

`node scripts/profile-play-browser.mjs --walk --alloc --counts` drives
Chromium with `--use-angle=metal` (Apple M2 Pro Metal renderer) at 1440×960.
It targets the running dev server, waits for the HUD, clicks into Play, holds
W and records 300 animation frames. The CPU profile is bucketed by the direct
callees of `animate()` in `src/viewer/main.mjs`; samples outside it keep their
top frame, such as `(garbage collector)` or `(program)` (browser-native work,
WebGL command encoding and compositing included). Allocation sampling counts
objects later collected by minor and major GC. The counts phase wraps
`ScriptRuntime` methods after the timed phase. Raw profiles go to
`.cache/perf/`, outside Git.

`scripts/benchmark-play.mjs` no longer measures what the player sees. It builds
a game without Play's startup, Login and presentation path and reports 6.2 ms
simulation and 0.6 ms mesh posing per frame, where real Play spends 12.4 ms and
6.8 ms. Use the browser profile for decisions.

## Baseline frame

Median of three walking runs at `5978bf3`:

| Per frame | Cost |
| --- | ---: |
| Frame interval | 29.7 ms mean (≈34 fps); 221 of 300 frames miss vsync |
| `game.tick` (simulation) | 12.4 ms |
| NPC mesh posing and upload | 6.8 ms |
| HUD window tree (Extension/GC natives) | 4.8 ms |
| three.js submit, ~600 draw calls | 2.4 ms |
| Garbage collector | 1.9 ms average |
| Allocation | 22 MB per frame |
| Retained heap after forced GC | 326 MB, stable (no leak) |

The drops are GC and presentation stalls. One captured 92 ms frame was 88 ms
of garbage collector. Another 150 ms gap was main-thread idle, waiting on the
GPU/compositor side; that stall is not yet attributed.

## Work versus cost per unit

A frame's cost is its units of work multiplied by the cost of each unit. The
counts below were taken standing and walking at the Training start:

| Unit of work per frame | Count | Our cost per unit | Native cost, order of magnitude |
| --- | ---: | ---: | ---: |
| Host reads/writes of script properties by name | ~5,400 (`namedReference`) | ~1 µs plus ~1 KB garbage | a struct member load |
| VM property references | ~1,600 | same path | same |
| Map-actor default rebuilds (`defaultValue`) | ~3,000 | full default copy | none: copied once by InitProperties |
| Line checks (`singleLineCheck`) | 647 | ~5 µs | well under 1 µs |
| UnrealScript function executions | ~340 | ~4 µs | well under 1 µs |
| Natives invoked | ~270 | | |
| Posed mesh vertices (30 GetFrame kernel calls) | 10,420 | ~220 ns in Wasm, plus ~3.5 ms of JavaScript around the kernel | a few ns |

The line-check count is original behavior. The DeusEx walking-surface scanner
`103ccc40` ([walking](walking.md)) fires four directions by nine heights plus
a floor trace for every walking-pawn physics step, 37 traces per step. The
workload is faithful and small. The per-unit costs are one to three orders of
magnitude above native. The native column is an order of magnitude, not a
measurement of the original.

## Why the units are expensive

**The object model allocates on every access.** A script property lived in
`instance.slots` or a host binding. Each access lowercased the name and walked
the class chain (`lookupMember`), then rebuilt a descriptor (`describe`, with
object spreads). It then allocated a reference with two closures, a state
object with four more, and a `defineProperty`, and copied the value. An
unwritten map-actor property rebuilt its default on every read. Host code
(pawn physics, animation, actor tick, mesh preview) made most of these
accesses by name, so the lookup was repeated thousands of times per frame. The
original reads `*(T*)(Object + Offset)`, with defaults copied once by
`UObject::InitProperties` ([object properties](script-object-properties.md)).

**x87 arithmetic uses BigInt on hot paths.** Every trace computes its
collision-hash X cells through BigInt 64-bit rounding
(`collision-hash.mjs expandedXCell`), and the VM's float natives use the same
BigInt model. These are exact, but each intermediate is a heap allocation.

**The retained heap is millions of small objects.** Of about 290 MB sampled,
lighting arrays hold 62 MB, decoded bytecode trees 31 MB and linker, load-graph
and metadata records about 75 MB. Each major GC marks all of them, which is
why an ordinary collection costs close to 90 ms.

**Presentation repeats per-frame CPU work.** NPC normals and bounding volumes
are recomputed on the CPU every frame (~1 ms). The HUD walks the emulated
window tree (3–5 ms). The sky pass re-renders the scene from the sky camera.

## Direction

The costs are representation, not work, so the order is:

1. **Object memory** ([contract and plan](object-memory.md)). Value access
   without references, then original-layout storage at the recovered UProperty
   offsets. Stages 1a to 1d are below.
2. **Exact x87 fast paths.** A single `+ − × ÷ √` on float32 operands stored to
   float32 is identical with 53- and 64-bit intermediates: double rounding is
   innocuous when the intermediate precision is at least twice the target's
   plus two. Chained 80-bit sequences can use f64 only where an error-free
   transformation proves the result exact, and fall back to BigInt otherwise.
   The argument needs the recorded control word 0x037f (nearest-even, 64-bit
   significand; [collision hash](collision-hash.md)). The existing BigInt code
   is the reference for differential tests, and the native oracle cases stay
   authoritative ([actor physics](actor-physics.md)).
3. **Allocation-free traces.** No per-query `Set`, closures or arrays. Target:
   the 647 traces under 0.5 ms.
4. **A smaller retained heap.** Typed storage for lighting and bytecode, so
   major GCs stay short.
5. **Presentation.** Normals, bounds, the sky pass and the HUD tree.

**Stage 1 status: stopped after stage 1d (`74e37a3`).** Walking Training went from
29.7 ms per frame (about 34 fps) to 17.3 ms (about 58 fps; the machine's speed
varies between A/B rounds, so these come from different rounds). That meets the
then-current goal of basic playability. Stage 1e, steps 2 to 5 and the VM
rvalue path stayed deferred until a new measurement identified a matching
problem.

WebAssembly follows the data. Porting the VM or the natives now would add
marshaling on every native call, because actor state lives in JavaScript
objects. Once objects live in one `ArrayBuffer`, that buffer can be a
`WebAssembly.Memory`, and a measured hot kernel (traces, walking, GetFrame) can
move to Rust without copying, like [the mesh kernel](lodmesh-wasm.md).

## September 28 Stage 4 reprofile

Stage 4 actor lighting and mirror rendering invalidated the earlier stopping
point. A new Training walk measured 47.75 ms mean, with 12.70 ms in simulation,
12.39 ms in four mirror child views, 9.78 ms in the actor-mesh update, 5.86 ms
in the HUD and 29.17 MB/frame allocation. Disabling mirrors reduced the mean
to 31.95 ms; disabling mesh lighting as well reduced it to 23.94 ms. Those are
separate costs: WebAssembly cannot remove extra render submissions, while the
lighting arithmetic is a suitable bulk kernel.

The Island finding is stronger. Its live simulation currently stops at known,
explicit fidelity boundaries (`aiPickSearch` requiring original `waterMove`,
or an unrecovered door native), so `--no-simulation` isolates presentation
without hiding that limitation. The comparison at the same initial view was:

| `01_NYC_UNATCOIsland`, 1440×960 Metal | Mean interval | Median | Actor update | Allocation |
| --- | ---: | ---: | ---: | ---: |
| Stage 4 JavaScript lighting | 36.08 ms | 33.3 ms | 21.58 ms | not sampled |
| Lighting disabled | 16.63 ms | 16.7 ms | 2.42 ms | not sampled |
| Rust lighting, first bulk boundary | 25.81 ms | 33.3 ms | 13.37 ms | 12.92 MB/frame |
| Rust + retained topology/allocation fix | 20.97 ms | 16.7 ms | 9.25 ms | 4.03 MB/frame |

The last row is a representative run; an identical later run measured 25.87
ms because browser-native `(program)` work rose from 12.02 to 22.07 sampled
ms/frame. The profiler host's display is 60 Hz, so its frame intervals cannot
demonstrate 120 fps. The actionable result is the ablation and component cost:
lighting fell substantially but it is not the whole frame. At this Island
view there are still 1,072 WebGL submissions, roughly 4.8 ms attributed to the
main render and 2.9 ms to the HUD before simulation. Rust cannot improve those
GPU/DOM submission costs.

The response therefore keeps the recovered `SetupForActor` state machine in
JavaScript and moves only the measured numeric loop—camera transforms, ordered
normals/culling, vertex `Light`, unlit overwrite and D3D diffuse conversion—to
the existing Rust/Wasm module. Mirror child passes now reuse the main actor
lighting/pose, keep one clipping-program shape, compensate reflected handedness
in the camera/target sample and scissor to each mirror's screen bounds. See
[the kernel boundary](lodmesh-wasm.md) and [mirror surfaces](mirror-surfaces.md)
for the behavior and verification contracts.

A final 300-frame Training walk with simulation and all four mirror planes
active measured 33.20 ms mean / 33.3 ms median / 49.9 ms p95. Against the new
47.75 ms regression baseline, actor update fell from 9.78 to 5.95 ms, mirrors
from 12.39 to 6.41 ms, and allocation from 29.17 to 16.00 MB/frame. Simulation
(11.32 ms) and the HUD (5.71 ms) are now the largest JavaScript components in
that run. This restores substantial headroom but does not establish the user's
120 fps target; those components and the render submission count require their
own measured work rather than a broader speculative port.

## September 28 running-Island profile

The user reported at most 10 fps on `01_NYC_UNATCOIsland` and asked for 120 fps
(an 8.3 ms frame). The earlier Island rows above were render isolation. A
per-second timeline shows why they missed the report: after Player start the
simulation runs for about two seconds at 100 ms per frame, then stops at an
explicit, unimplemented original boundary (`aiPickSearch` needs `waterMove`
0x103c3ca0), and the paused scene draws at the 60 Hz display cap. Behind that
boundary wait native 708 `AIDirectionReachable`, latent 506 `StrafeFacing` and
`altMove`. Island is not playable past those seconds regardless of speed.
Swimming physics (`APawn::performPhysics Physics=3`), once listed here, is now
linked ([swimming](swimming.md)), and so is `waterMove` (`APawn::swimMove`,
2026-09-29, [pawn navigation](script-pawn-nav.md)), and so is the jump
(`altMove`, `APawn::FindBestJump`), and so is native 708
(`AIDirectionReachable`): the forward-walk workload now runs unbypassed until
ConSys native 2051 (the third-person conversation camera) at tick 1872, and
the bypass list below is empty ([roadmap](roadmap.md)).

To measure a *running* Island, two host tools apply the same measurement-only
bypass (`scripts/bench-sim-hooks.mjs`): those throws become early returns. The
frames after a bypass are a workload, not original behavior.

* `scripts/bench-sim.mjs` boots a map through Play's `createGame` in Node, holds
  forward and times `game.tick` at 60 Hz. It then hashes every script property
  of every `Level.Actors` entry, with the calendar and clocks pinned to the
  simulated time. `--continue` returns declared zero values from unsupported
  natives, as the census does. A representation change must leave the digest
  identical, and the digest is deterministic run to run. `--tickstats` times
  each Actor.Tick by class.
* `scripts/profile-play-browser.mjs --bypass --settle 500` profiles the browser.
  It now also reports `deusExViewer.framePhases()`, which is wall time per
  `animate()` phase: tick, lighting setup, actor meshes, mirrors, render, HUD.

Running Island, walking, Chromium/Metal 1440×960 at DPR 1 (DPR 2 at 1728×1000
measured the same, so fill rate is not the limit):

| Per frame | Before | After |
| --- | ---: | ---: |
| `game.tick` | 50.4 ms | 31.5 ms |
| Actor meshes (pose, light, upload) | 22.9 ms | 15.0 ms |
| HUD window tree | 5.1 ms | 4.2 ms |
| three.js render (~1,070 draw calls) | 4.8 ms | 4.4 ms |
| Mesh-lighting frame setup | 1.9 ms | 1.5 ms |
| **Frame interval, mean** | **86 ms (≈12 fps)** | **57 ms (≈17.5 fps)** |
| Headless Island tick (bench-sim) | 54.7 ms | ≈23 ms |
| Headless Training tick | 7.5 ms | 5.3 ms |

Headless per-class Actor.Tick after the changes: 29 Terrorists at about
270 µs each (7.8 ms), the player 1.1 ms, 10 UNATCO troops at 140 µs, and 35
pistols at 29 µs. An NPC tick splits roughly 40% pawn physics (walking moves,
the rider scan, the 37-trace walking-surface scanner) and 40% UnrealScript.

Changes. Each one is a host representation or ordering change; the original
behavior contract is untouched.

1. **Bound field accessors.** `ScriptRuntime.boundField` resolves the instance
   and handle once. Collision views bind each field on first access, so lookup
   errors keep their timing. The MoveActor rider pass scans `Level.Actors`
   (about 2,600 entries, 26 times per tick) and reads each `Base`: 67k reads per
   tick for 77 riders. Base writes span host records, view cells and physics
   helpers, so an exact rider index was rejected. Rider `baseOf` also read the
   `base` getter twice; it now reads it once. Headless tick: 54.7 → 30.6 ms.
2. **Line checks.** Collision-hash X-cell expansion used BigInt x87 arithmetic
   on every trace. When error-free TwoSum shows both adds are exact in a
   double, the x87 64-bit roundings are identities and one `Math.fround`
   equals the BigInt result; otherwise the BigInt path runs. A 2M-case
   randomized differential against the committed version found 0
   differences. The hash query no longer uses a Set or closures.
   `primitiveLineHit` is `primitiveLineCheck`'s arithmetic without
   temporaries: over 3M cases (856k hits) it matched, including key order and
   −0. The native hash and primitive oracle validators pass. Walking-surface
   traces went from 5.7 to 2.3 ms per tick.
3. **Script values.** Reading one fixed-array element no longer copies the
   whole array: image-backed storage reads the element's own cell, and a
   poisoned cell keeps the whole-value path. The VM reads plain variable
   operands through `fieldValue`/`localValue`, which reproduce
   `refValue(fieldReference(...))` without the lvalue.
4. **Quadratic or eager host work.** `ConBindEvents` re-filtered all level
   actors at every iteration step. It now reloads the array only after a
   candidate's binding, because the other steps only read. `soundField`
   resolves the level container only for level/graph names, and
   `levelFor` is a pure lookup. The GC, text, edit and window-list heap models
   built an error label on every access; they now build it only on failure.
   Actor.Tick builds the timer accessor view only for a running timer, and
   the scheduler builds its per-actor services once per tick type.
5. **Actor meshes.** An actor outside the view frustum is not posed or lit.
   The test uses a conservative sphere: the farthest vertex of every
   animation frame, scaled, around Location+PrePivot. On posed Island actors
   the worst vertex reached 1.00004 of the unmargined radius, and the test
   adds 1% + 1 unit. Render.dll also calls GetFrame only for drawn actors,
   and three.js would cull those groups anyway, so render feedback is
   unchanged. Culling is off whenever a mirror plane may render. It culled
   27% of actors at the open Island view. Environment normals use flat
   buffers, with a bitwise differential over 920k components: 4.8 → 0.4 ms.
   The GetFrame kernel has an exact integer path
   ([mesh kernel](lodmesh-wasm.md)): 6.5 → 4.1 ms.

Verification: the Island digest (`5483419aeb08dd30`, 300 walking ticks) was
identical after every change. Training and Battery Park digests match a HEAD
worktree at every 50-tick checkpoint. The full validator sweep passes
418/418, as do all 546 unit tests, `validate-lodmesh-frame --wasm` (46
original GetFrame captures), the mesh-lighting, NPC preview and mirror
validators, and the Wasm and mirror browser specs.

What remains toward 8.3 ms is not one bottleneck.

* **The tick (31.5 ms)** is spread across property access, VM plumbing (a
  locals `Map` and value copies per call), BigInt x87 natives, collision and
  animation. The next multiples need structural work:
  * compiling UnrealScript bytecode to JavaScript, with array locals and
    direct cell access, differential-checked against the interpreter;
  * the collision core (BSP traces, hash, primitives) in Rust over actor
    collision data kept in Wasm memory;
  * a rounding-unambiguity (Ziv) f64 fast path for the x87 natives, which
    falls back to the exact path.
* **Actor meshes (15 ms)** are about half Wasm kernels and half per-actor
  JavaScript. They can run in a worker pool, or overlap the tick. Exact
  integer posing measures 154 ns per vertex natively (the extended loop is
  270 ns), so an f64 path with a Ziv rounding test would be the next kernel
  step.
* **Render and HUD (8.6 ms):** about 1,070 draw calls for world surfaces could
  be batched, and the HUD window tree still runs through the byte-level heap
  model.

## September 29: render-feedback workload, VM compiler and exact caches

**Measuring the browser workload headless.** The browser tick was about 1.5×
the headless one. In Play, drawn actor meshes copy TimeSeconds into
LastRenderTime (`actor-render-feedback.mjs`), and scripts read it through
`LastRendered()`, so seen NPCs run branches that never run headless.
`bench-sim.mjs --render-feedback` stamps visible mesh actors inside an
approximate player frustum after each tick. It is a workload approximation
that brings the headless tick in line with the browser. A HEAD worktree
produces the same digest in this mode (`5496f30ee89033fc`), so every earlier
change is exact under that workload too.
`--tickstats` (per-class Actor.Tick time), `--counts`, `--script-profile`
(per-UnrealScript-function inclusive and self time), `--script-frames`
(CPU-profile frames named after UnrealScript functions) and `--read-sites`
located the costs below.

Changes. Each was verified against the Island digests (with and without
render feedback), the Training digest, unit tests, the relevant oracle
validators and a browser run.

* **Compiled VM** (`script-vm.mjs`). Each decoded node compiles once into
  `ev`/`rv` closures, transcribed case by case from the reference `evaluate`,
  with children precompiled and the frame passed explicitly.
  `SCRIPT_VM_REFERENCE=1` selects the reference engine. Variable nodes cache
  their resolved operand while `ScriptObjects.operandEpoch` is unchanged (it
  advances on link and on any GC operand rewrite). A script call evaluates
  non-out arguments by value (`evaluateArgumentValue`), and struct-member
  reads skip the second struct copy (`structValue`).
* **Rider scan cache** (`move-riders.mjs`, `base-epoch.mjs`). The MoveActor
  rider pass reuses a mover's rider list from a full `Level.Actors` scan while
  a global epoch is unchanged. The epoch advances on every Base write (image
  cell, slot, host binding and record), every structural `Level.Actors`
  change, bulk restores, poisoning and releases. If a rider's move advances
  it, the original loop resumes reading from the next index.
  `RIDER_VERIFY=1` compares each cached list with a full scan (no mismatch
  over the Island, Training and Battery Park runs). Tick: about 2.5–3 ms less.
* **Iterator and event paths.**
  * `classIsA` memoizes class-chain tests per class for the actor iterators.
  * `ConBindEvents` reloads its object array only after a candidate.
  * `processEvent` memoizes the engine.actor chain test and lowercased names.
  * Locals maps are built without intermediate pair arrays.
  * `destroyFunctionLocals` caches its filtered field lists.
* **Values.** A fixed-array element read touches its own cell, and alliance
  natives read `AlliancesEx` entries in place. The descriptor entry is linked
  from the field record, with the same currency checks.
* **x87 fast paths** (`x87-fast.mjs`). `playerDistance` and the GetFrame
  matrix setup (`lodMeshFrameMatrix`) compute in doubles. TwoSum detects
  exact results; otherwise an f32 store is accepted only when every value
  within a proven bound rounds to it, and anything else runs the BigInt x87
  model. Differentials: 3M distances and 200k matrices with no difference;
  the 46 original GetFrame captures still pass.
* **Collision.** `traceRay` no longer allocates per call and caches mover
  planes per coords. Mover `ToWorld` coords are cached per unchanged inputs.
  The line-filter class keys are precomputed. The multiline, hash, primitive,
  ray, brush-ray, fitting and walking-surface native oracles all pass, and
  `RAY_DIFFERENTIAL=1` checks every live trace against the reference.
* **Presentation.** Mesh bounds replicate three.js's box/sphere arithmetic in
  one pass (bit-identical over 20k buffers). The HUD heap uses direct
  DataView calls, and GC heap-model labels are built lazily.

* **Assignments and bool reads without lvalues.** An assignment to a local or
  instance variable (`0x0f`, and `0x14` through a `BoolVariable` target) goes
  through `assignLocalOf`/`assignField`. They keep the reference's order
  (scope check, storage selection, poison pre-read, slot default, descriptor,
  then the value, then the read-merge-store) without allocating the reference.
  A `BoolVariable` read of a variable is `Boolean` of its value. The last
  linked receiver's instance is remembered, since its symbol link is
  permanent.

Headless Island tick (render-feedback workload, alternating A/B, 400 ticks):
HEAD 47.0 ms against 25.5 ms now, with identical digests. The browser
running-Island frame went from 57 ms (September 28 evening) to about 45–48 ms,
with the tick at 24–27 ms and the actor meshes at about 10 ms.

Where the tick still goes, and why further JavaScript tuning stops here, is in
[Rust simulation core](rust-core.md#why-now).

## Stage 1a: value access without references

Changes, all host representation:

* `ScriptRuntime.lookupMember` memoizes each prepared node's resolution per
  table and spelling, misses included. The class loader fills member tables
  and base chains before a class is returned, and nothing mutates them later.
* `describe` caches descriptors per metadata and key. It rebuilds if the
  linker later rewrites `arrayDim`, `elementSize`, `structKey`,
  `structFields` or `innerMetadata`, the slots filled by `ScriptRuntime.field`,
  the class loader and struct layout. Normalized struct members are cached per
  `structFields` array.
* References are one `PropertyReference` object. Its `get`/`set` stay own
  functions because callers pass them on detached, and its backing state is a
  private field. Get/set order and returned copies are unchanged.
* `readField`/`writeField` and `readNamed`/`writeNamed` return exactly what
  `fieldReference(...).get()/.set()` returned, including default
  materialization and binding precedence, without allocating an lvalue.
  Literal `namedReference(...).get()/.set()` sites in `src/` use them. Pawn
  physics, the animation views, actor tick and the mesh preview go through
  value services. An in-range blend element read indexes the copied whole
  value; anything else keeps `arrayReference`'s clamp and warning.
* A map actor's unwritten property keeps its initial value in `record.store`
  on first read, as InitProperties does once at construction. Resets already
  clear the store.

Rejected alternative: caching one reference per (instance, field) removed the
per-access allocation but kept ~23,000 references alive in headless startup
alone. Real Play retained 45 MB more, which lengthens every major GC. Memoizing
`describe` and `lookupMember` alone moved the tick by 0.3 ms, because the cost
moved into reference construction.

Paired A/B, alternating HEAD (a worktree on port 5199) with the working tree
(port 5173), three walking runs each, medians:

| Per frame | `5978bf3` | Stage 1a |
| --- | ---: | ---: |
| Frame interval | 29.7 ms (≈34 fps) | 21.6 ms (≈46 fps) |
| Frames missing vsync (of 300) | 221 | 90 |
| Sampled main-thread CPU | 35.8 ms | 24.7 ms |
| `game.tick` | 12.4 ms | 8.8 ms |
| Mesh update | 6.8 ms | 5.3 ms |
| HUD | 4.8 ms | 3.9 ms |
| Garbage collector | 1.94 ms | 0.68 ms |
| Allocation | 22.1 MB | 14.8 MB |
| Retained heap | 327 MB | 326 MB |
| `namedReference` / `fieldReference` / `defaultValue` calls | 5,391 / 7,033 / 3,019 | 274 / 1,821 / 1 |

Nothing measured here establishes original fidelity. The changes keep every
read, write, default and error path of the previous implementation. The
existing suites show no behavior change:

* All 541 unit tests pass.
* The full sweep (`npm run validate -- --jobs 4`) passed 393 of 397. Every
  failure was checked against `5978bf3`:
  * The Stage 3 Training gate is red by design. Its output is identical to
    HEAD for all 90 probes; it now takes 145 s instead of 203 s and peaks at
    1,760 MiB instead of 2,187 MiB.
  * `validate-npc-mesh-preview` fails with the same assertion on HEAD.
  * `validate-player-tick-order` was killed at the runner's per-validator
    memory cap. Standalone it passes on both trees with identical output and
    the same cost (about 225 s, 2.9 GB peak).
  * `validate-animation-controls` failed because its Unicorn oracle blocked
    with 0.1 s of CPU. Standalone it passes all 37 original cases, which
    exercise the changed animation view.
* The browser suite passed 11 of 17. The six failures are pre-existing:
  Liberty Island's `NativeHeapError`, the instructor conversation, the
  training walk, pointer-lock Escape and the lodmesh fallback's mesh count all
  fail identically on HEAD. The production-build spec runs against a `dist/`
  that predates these changes.

A related finding, not caused by this work: every `createGame` on a shared
`AssetStore` retains about 315 MB after forced GC, on HEAD and here alike
(39 → 403 → 719 → 1,034 → 1,349 MB over four games). Validators that build
many games pay for it in memory.

## Stage 1b: resolved field handles

After stage 1a, Play still made about 5,300 host reads and 260 writes per
frame by name. Pawn physics made about 1,100 of them, NPC mesh admission and
posing about 2,000 (`Mesh` for every level actor), actor tick about 1,000 and
the animation views about 750. In Node, one scalar read cost about 145 ns:
38 ns resolving the name, about 30 ns validating the cached descriptor and
16 ns for an instance lookup that ran twice. The binding lookup and the copy
itself took about 10 ns each.

Changes, all host representation:

* Each class has a table from spelled property name to a handle: the linked
  field, found once through `lookupMember`, and its value codec. Handles for
  a name that does not exist are cached as misses. `readNamed`/`writeNamed`
  look up the instance once and go straight to its class table.
* `propertyCodec` in `script-values.mjs` specializes a property's read, store
  and copy operations once from its descriptor. It is cached with the
  validated descriptor entry, and a linked field record reaches that entry
  through one lookup keyed by the record. A single non-bool scalar reads
  through the same per-type copy that `copyScalar` uses. Arrays and bools, whose
  bit mask is read live, keep the general path.
* A class-table handle keeps its codec without validating it again. A field
  enters a class's member table only after `ScriptRuntime.field` and the class
  loader have written the metadata slots the descriptor depends on. A
  headless Training run (startup plus 900 ticks) checked 3,842 handle codecs
  against the validated descriptor 29,373 times and found none stale.
* The per-tick animation view is built once per attached instance. The tick
  phase writes only through the view's accessors. The blend-starting natives
  keep a fresh view per call, because `startAnimation` can add a plain
  `animFlags` property to a blend object.
* Allocations are gone from four paths:
  * bytecode object operand reads;
  * the level's `DistanceFromPlayer` pass;
  * the `pendingKill` getter;
  * the timer state accessors.

  A map actor's generic binding now does one store lookup where it did two.

Every read, write, default and error path is unchanged. In Node, a scalar
`readNamed` now costs about 55 ns; a vector about 100 ns and an `FName[4]`
about 127 ns, because both copy the whole value.

Paired A/B, alternating `3ed84fe` (a worktree on port 5199) with the working
tree (port 5173), three walking runs each, medians. The machine ran slower in
this round than in stage 1a's (HEAD 23.5 ms against 20.8 ms in an earlier
round), so compare within the table:

| Per frame | `3ed84fe` | Stage 1b |
| --- | ---: | ---: |
| Frame interval | 23.5 ms | 21.2 ms |
| Frames missing vsync (of 300) | 125 | 83 |
| Sampled main-thread CPU | 26.6 ms | 23.9 ms |
| `game.tick` | 9.6 ms | 8.4 ms |
| Mesh update | 5.6 ms | 5.1 ms |
| HUD | 4.2 ms | 3.9 ms |
| Garbage collector | 0.74 ms | 0.55 ms |
| Allocation | 14.6 MB | 14.0 MB |
| Retained heap | 325 MB | 326 MB |
| Object-model self time (mean of runs) | 3.9 ms | 2.3 ms |
| `lookupMember` / `fieldReference` / `namedReference` calls | 6,290 / 1,834 / 288 | 782 / 1,438 / 60 |

Verification: all 541 unit tests pass, and the full sweep passed 395 of 397.
The Stage 3 gate (red by design) gives the same 90 probe outcomes as
`3ed84fe`. `validate-npc-mesh-preview` fails with the same assertion recorded
at `5978bf3` ("unchanged poses do not re-upload geometry").

The largest object-model cost left is the VM's own property access. The VM
evaluates every variable operand to an lvalue, so about 1,440
`fieldReference` calls per frame still build a `PropertyReference`, 0.7 MB per
frame, even where the value is only read. An rvalue path in the VM, or 1d's
image addresses, removes it. The rest of the frame is now dominated by work
outside the object model: line checks and their BigInt x87 arithmetic, GetFrame
and normals, the HUD's native heap and three.js submission.

## Stages 1c and 1d: layout tables and object images

Stage 1c reads each class's property table from the linker and checks it
against the recovered Link bodies and retail offsets. Stage 1d stores
script-owned properties in a byte image per object at those offsets
([object memory](object-memory.md) has the contract, the evidence and what
remains). Before 1d, Training's 1,817 attached objects held 45,801 logical
slot entries and 94,885 bindings. Most actor fields were bindings over a map
of stored values. After 1d:

* 1,816 objects hold images, 620 KB in total. The remaining object's class
  has no linked record.
* One slot entry remains.
* Bindings number 18,975, only the host-owned fields and headers.

Changes, all host representation:

* `script-object-layout.mjs` reads each class's table from the linker's own
  records. `script-object-image.mjs` turns it into cells: one hidden class,
  scalar reads and writes small enough to inline, and composite values in a
  separate path.
* Each class has a default image, copied when an object attaches or is
  constructed. It replaces a default rebuild for every property of every
  spawned object and every first read of a map actor property.
* A map actor writes its authored values over the copy, and resets restore a
  snapshot.
* Instance records are one class. The `pendingKill` accessor that
  `bindNativeObject` defined on each actor record had left all 423 Training
  actor records in dictionary mode, so every record property load was a
  hash lookup. That dated from before 1d.
* VM references over an image cell use a storage object with methods, not
  two closures per reference.
* A record copies its class defaults only when some property lacks an image
  cell. That removes 55,010 retained map entries in Training. This change
  came after the A/B below and is not in its numbers.

In Node, per access on a Training pawn, compared with `be02895`:

| Access | `be02895` | 1c + 1d |
| --- | ---: | ---: |
| Scalar read by name (byte, int, float, name, object, bool) | 50–65 ns | 30–39 ns |
| Scalar write by name | 78–97 ns | 46–58 ns |
| `BlendAnimSequence` (`FName[4]`) read | 135 ns | 61 ns |
| `Region` (PointRegion struct) read | 300 ns | 91 ns |
| VM `fieldReference(...).get()` | 125 ns | 108 ns |

Paired A/B, alternating `be02895` (a worktree on port 5199) with the working
tree (port 5173), three walking runs each, medians. This round ran faster
overall than stage 1b's, where HEAD measured 21.2 ms, so compare within the
table:

| Per frame | `be02895` | Stages 1c + 1d |
| --- | ---: | ---: |
| Frame interval | 18.4 ms | 17.3 ms |
| Frames missing vsync (of 300) | 33 | 13 |
| Sampled main-thread CPU | 20.9 ms | 19.9 ms |
| `game.tick` | 7.27 ms | 6.70 ms |
| Mesh update | 4.71 ms | 4.36 ms |
| HUD | 3.25 ms | 3.24 ms |
| Garbage collector | 0.50 ms | 0.45 ms |
| Allocation | 14.1 MB | 13.9 MB |
| Retained heap | 326 MB | 319 MB |
| Object-model self time (median of runs) | 2.06 ms | 1.83 ms |

Verification:

* Both new validators pass. `validate-object-layout` covers 1,474 classes: the
  placement replay, the struct members, 153 retail offsets and 142 window
  offsets. `validate-object-image` checks defaults, writes, byte placements,
  bool words and the timing of unproducible-value errors for one object of
  every class.
* A headless Training run reads every property of every attached object after
  startup (138,725 reads), after 600 idle and walking ticks, and after a
  Player-start reset plus 300 ticks. It gives identical results on `be02895`
  and here, including 2,643, 2,656 and 7,950 error messages.
* All 541 unit tests pass. The full sweep passed 396 of 399:
  * `validate-script-frame-ownership` assigned `pendingKill` on a fixture
    record, which the first version of the record class refused. Records
    other than actors accept the assignment again, and the validator passes.
  * The Stage 3 gate (red by design) gives output identical to `be02895` for
    all 90 probes, in 106 s instead of 153 s.
  * `validate-npc-mesh-preview` fails with the assertion recorded at
    `5978bf3`.

The VM's per-operand references remain the largest object-model cost: about
1,300 per frame, plus the whole-value copies `copyScalar` makes for each. An
rvalue path in the VM would remove most of them. It is deferred with the rest
of the direction (see [Direction](#direction)).

## Reproduce

```sh
npm run dev   # or reuse the running server on 5173
node scripts/profile-play-browser.mjs --walk --alloc --counts --tag mine
# A running Island (measurement-only bypass of its early boundaries):
node scripts/profile-play-browser.mjs --map 01_NYC_UNATCOIsland --walk --bypass --settle 500
# Headless tick timing and state digest (compare digests between builds):
node scripts/bench-sim.mjs --map 01_NYC_UNATCOIsland --bypass --continue --ticks 300 [--tickstats]
```

Frame intervals depend on the display cadence; compare A/B runs on one machine,
alternating builds. Play skips `game.tick` while `document.hidden`, so an
interactive check needs a visible tab; the script's own Chromium page is visible.
