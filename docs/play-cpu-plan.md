# Play CPU plan: less main-thread work, more Rust and GPU

Written 2026-10-03 after the Linux-host measurements in
[play frame cost](play-frame-cost.md) ("October 3"). The savings are
estimates from CPU-profile attribution, and each step's A/B decides what it
really saves. Done steps and their measurements are under
[Progress](#progress) at the end.

## Starting point

UNATCO Island, standing at Player start, costs about 42 ms per frame of
main-thread JavaScript on the Linux host (Arch Chromium, 1920×1080). The GPU
works 2.5 ms of it. Galaxy audio (about 2.8 ms) is left out: it is work in
progress.

| Family | ms/frame | Where it goes |
|---|---:|---|
| `game.tick` | 16.7 | About 2.2 in Rust. The rest is JavaScript behind the kernel's imports: `js_eval` 2.65, wrappers and the player 2.4, `js_tick_physics` 1.74, `js_object` 1.5, CycleActors 1.16, walking prelude 0.85, riders 0.74, `js_step` 0.65 |
| actors | 6.8–7.2 | Admission over about 2,600 Level.Actors, about 10,000 field reads, SetupForActor for about 220 drawn actors |
| render (three.js) | 5.4–5.9 | The world-matrix cascade runs twice (sky and main pass); about 470 draws each refresh their material |
| moving lights | 3.3 + ~1 | One global signature, so the three flickering ElectricityEmitters force a full recompute (185 light maps) almost every frame |
| HUD | ~2.0 | 81 script DrawWindow/PostDrawWindow events and the native window-tree passes |
| sprites | 2.3 | SetupDynamics admission, about 4,600 reads |
| lighting phase | 1.2 | A second scan for moving-light candidates, with the same gate as `game.movingLights` |

The game itself is not heavy. Natively, a field read is one instruction and
x87 extended arithmetic runs in hardware. Here a field read is a chain of
JavaScript calls (`readNamed` → `instance` → `readInstanceField` →
`readComposite`) at about 50–120 ns, and exact x87 results that a double cannot
give are emulated with BigInt. The parts already in Rust run close to native
speed, so the plan removes JavaScript rather than tuning it.

## Method for every step

- The JavaScript body stays as the reference behind a switch, like
  `?fireKernel=js`, `RUST_POLLS=0` or `PERCEPTION_DIFFERENTIAL`.
- A differential or native-oracle validator passes before the step is wired
  into Play. The existing validators are named in each step.
- Island and Training digests stay unchanged (`.work/tools/digests-linux.sh`;
  recompute the references at HEAD first).
- Timing: three interleaved pairs on the Linux host with
  `node scripts/profile-play-browser.mjs --executable /usr/bin/chromium --size 1920x1080 --map 01_NYC_UNATCOIsland --no-profile`,
  checking `errors` and `stoppedAt`. At the end of each phase, A/B on the
  M2 Pro too, since the 120 fps target is defined there.
- One commit per verified step. A full sweep (`--jobs 8 --mem-budget 16384`)
  ends each phase.

## Phase 1: delete waste in JavaScript (no behavior change)

Estimate −6 to −8 ms.

1. **Moving lights recompute only what changed** (`src/viewer/moving-lights.mjs`,
   `src/unreal/lighting.mjs` `setMoving`).
   - Detect changes per light instead of one JSON signature over every light and
     mover.
   - Cache the spatial bytes per (light, surface) pair.
   - Recompose only the light maps a changed light touches, under both its old
     and new rectangles. Capped additions of non-negative bytes give the same
     result in any order, so the output is identical.
   - On Island, a flicker frame drops from 185 maps to about 36, and the
     BarrelFire float path is no longer redone.
   - Validators: `validate-dynamic-lighting`, `validate-normal-moving-lighting`,
     `validate-auglight-lighting` and `validate-light-atlas-upload`, plus a new
     differential: full against incremental atlas bytes on captured frames
     (Island flicker, Training AugLight, Airfield).
2. **One moving-light candidate scan per frame.** `game.movingLights`
   (game.mjs:268) and `meshLighting.beginFrame` (mesh-lighting-view.mjs:69)
   each scan Level.Actors with the same gate. The original runs it once, in
   SetupDynamics.
3. **Stop the three.js matrix cascade.**
   - `scene`, `world.root` and the markers keep `matrixAutoUpdate`, so every
     `render()` recomputes every descendant's world matrix: hidden subtrees
     included, twice per frame. Their matrices are identity, so they can be
     set once.
   - `syncMovers` (world.mjs:344) should flag only the movers that moved.
   - Check that every `matrixWorld` is identical over a run;
     `validate-world-batches`, `validate-mirrors-play`.
4. **Actor admission** (npc-mesh-preview.mjs:128-181).
   - Every frame reads Mesh for the about 2,300 actors that have no preview.
     Bump a Mesh epoch on stores to `Actor.Mesh`, as Base already does
     (script-object-image.mjs:298).
   - Read each field once per actor per frame: Location is read 3–4 times now.
   - Validators: `validate-actor-mesh-scene`, `validate-npc-mesh-preview`,
     `validate-gpu-mesh`, `validate-render-visibility`.
5. **Tick plumbing.**
   - Hoist `events.allowed(services)` out of the per-actor loop: its 15 identity
     comparisons do not change within a level tick.
   - Fold the pass-through `withLifecycle` wrappers.
   - Replace the `js_tick_probing` crossing with the probe bits dispatch.rs
     already reads.
   - Keep `collectSpawned` per actor: it records the spawn's Owner at that point
     in the tick.
   - Digests unchanged.
6. **Small items.**
   - Cache the corona pass's `level.actors.includes` per `actorsEpoch`.
   - Replace `zoneSpeeds`' `actors.find` with a lookup.
   - Stamp render feedback once per actor per pass.
   - Profiler: `--no-sky` still patches `if (world.sky) {`, which main.mjs no
     longer has. Make it match and throw on a miss, and tag actor batch meshes
     so `--draw-counts` stops filing them under "other".

## Phase 2: one Rust render scan over the object image

Estimate −5 to −7 ms.

1. **A second class-row field table**, "render fields", in `native/script-vm`.
   - It follows locomotion's third class-row word, with bit 31 meaning
     computed (loco.rs, script-vm-locomotion.mjs). The perception word is full
     at 31 of 32.
   - Fields: bHidden, bDeleteMe, Mesh, DrawType, Style, Location, PrePivot,
     DrawScale, Owner, bOnlyOwnerSee, bOwnerNoSee and RenderIteratorClass; the
     moving-light gate fields; AnimSequence, AnimFrame and the BlendAnim pair;
     ScaleGlow, AmbientGlow, bUnlit, bMeshEnviroMap, bMeshCurvy, bNoSmooth and
     bSpecialLit.
   - Hand-back rules as for perception: HOST receivers, bound keys, poisoned
     and released objects.
   - The same table unblocks Galaxy's ambient scan later.
2. **`render_scan(view)`**: one pass over Level.Actors that returns a compact
   list.
   - It contains SetupDynamics' sprite admission in array order, the
     moving-light candidates, and per mesh actor: admission, visibility through
     the Owner chain, the cull sphere and pose-changed flags.
   - `spriteScene`, the shared light scan and `npcPreview` consume the list.
   - A differential mode compares the JavaScript and Rust lists every frame.
   - Validators: `validate-particles-play`, `validate-lasers-play`,
     `validate-actor-mesh-scene`, `validate-render-visibility`.
   - The render-iterator protocol stays in JavaScript: it fires script events
     and FarMoveActor.
3. **SetupForActor in Rust.**
   - The light fade caches move into Rust memory, keeping the sort and the
     120/8/16 limits.
   - The x87 helpers (`fgetHsv`, `movingLightConstants`, `lightTypeBrightness`,
     `worldLightRadius`) are ported to x87.rs, or filled by JavaScript into a
     table on a miss.
   - Line checks go through the existing `js_light_trace` import.
   - Validators: `validate-mesh-lighting`, `validate-mesh-lighting-play`, plus a
     differential.
   - GetFrame planning stays in JavaScript. Its BigInt-keyed caches and op logs
     make it the riskiest part.

## Phase 3: fewer draw submissions

Estimate −1 to −2 ms. Merge the actor batches across textures (124 to about
20 draws), with multi-sampler selection as in world-batches.mjs. This first
needs an actor-batch pixel validator: batched against unbatched `readPixels` on
the same frame, Island and Training. A raw-WebGL path for the static world
waits until a real-map pixel validator exists.

## Phase 4: the tick

Estimate 16.7 → about 9 ms. These are the open steps of
[Rust core](rust-core.md), in order of measured cost:

1. CycleActors (1002) in Rust (step 3b; `js_iterator_next` 1.16 ms).
2. The natives still valued in JavaScript through `js_eval`/`js_object`:
   SetRotation, SetLocation and FarMoveActor (step 7), plus virtual and
   context call effects through the call cache.
3. Rider MoveActor, the weapons' FarMove and the hash updates in Rust
   (0.74 + 0.37 + 0.24 ms).
4. B6: falling, landing, rotation and swimming, plus non-pawn physics
   (`js_tick_physics` 1.74 ms).
5. 1e-6 and B7: the player's tick, which still runs entirely in JavaScript.
6. Step 8: the level loop's DistanceFromPlayer and compaction.

Each family gets a kernel validator in the style of perception and
locomotion, and keeps its native-oracle validator.

## Phase 5: the HUD

Estimate −1.5 ms, after Phase 4's event work. Dispatch DrawWindow and
PostDrawWindow without JavaScript plumbing, and move the GC draw natives and
the window-tree passes (`resizeRoot`, `reconfigureTree`, `paintWindows`) to
Rust over the native heap. The scripts still run every frame; the HUD
batching boundary forbids skipping or caching them.

## GPU

Little of the remaining work suits the GPU: simulation, actor scans and
script work stay on the CPU. Moving-light texels could run in a pass that
renders into an atlas layer. That needs extended-precision emulation (about
48 bits as float-float, as in [GPU mesh](gpu-mesh.md)), a certainty test and a
CPU fallback. It is worth it only if lights that move every frame (AugLight,
Airfield) are still expensive after Phase 1.1 and a Rust texel kernel. The
idle GPU is better used through the existing GPU mesh path and larger
batches (Phase 3).

## Threads

Play runs on one thread today: the simulation and all render preparation are
on the page's main thread.

- **The tick cannot run in parallel.** The original is single-threaded and
  order-dependent: actors tick in Level.Actors order, script events fire
  mid-tick, one random stream is shared, and spawns, destroys, Touching and
  the collision hash change as each actor moves.
- **Pure loops can (Phase 6, after Phases 1–2).** Per-texel and per-actor work
  with no shared state can be split across workers with identical results,
  merged in the original order: moving-light texels, fog, light-map merges,
  SetupForActor per actor, read-only scans.
  - It needs cross-origin isolation (COOP/COEP headers on the dev server and
    any host) for shared memory.
  - It needs Rust Wasm threads; check whether those still require a nightly
    build-std setup.
  - The gain is bounded by those loops' size once Phases 1–2 are done.
- **Simulation and drawing overlapped (Phase 7, the user's decision).**
  - Drawing is not read-only here: the HUD runs UnrealScript, render
    iterators fire events and move actors, and LastRenderTime stamps feed the
    next tick. All of that stays in the simulation's sequence.
  - Only the GL work (three.js submission, uploads, GPU mesh passes), about
    6–8 ms, can move to a worker with an OffscreenCanvas.
  - It needs every viewer module split into extract and draw halves, and it
    adds up to a frame of latency.
  - Phase 2's draw list is the extract half, so Phase 2 keeps this option
    open.

## Fidelity questions found along the way

These are not performance work; they are tracked here because they change
the cost:

- **ElectricityEmitter flicker.** The Island emitters flicker because Play
  stamps their LaserProxy's LastRenderTime with no BSP or span occlusion
  ([particles](particles.md), "Visibility"). The original probably keeps them
  frozen while unseen. Unverified.
- **Sprites in the sky pass.** Sprites stay visible in the sky pass and are
  stamped there. The original rule is unverified.

## Expected on the Linux host

| After | ms/frame |
|---|---:|
| today | ~42 |
| Phase 1 | ~34 |
| Phase 2 | ~27 |
| Phase 3 | ~25 |
| Phase 4 | ~17, 60 fps on this machine |

The M2 Pro runs the tick about 1.35× faster (bench-sim, 17.6 against about
13 ms). These are attribution estimates, not measurements.

## Progress

Island standing at Player start, Linux host, Arch Chromium, 1920×1080,
`--no-profile`, medians of three interleaved pairs against the previous
commit (`.work/tools/ab-play.sh`, baseline tree served on a second port).

| Step | Commit | total ms | Phase change |
|---|---|---:|---|
| 1.1 moving lights incremental | c072cd0 | 45.5 → 39.8 | tick 21.0 → 17.2 |
| 1.2 one moving-light scan | 8eabcc4 | 39.7 → 39.5 (noise) | lighting 0.75 → 0.23 |
| 1.3 no matrix cascade | 90a083d | 42.1 → 40.5 (noisy runs) | render 5.99 → 4.92 |
| 1.6 small items | b3b16f8 | 38.6 → 38.8 (noise) | render 4.77 → 4.61 |
| 1.5 IsProbing in Rust | this commit | bench-sim tick −0.24 (noise) | 700 crossings per tick removed |

Step 1.5's other items were dropped after measuring: `events.allowed` costs
a few identity comparisons per actor tick, and the pass-through
`withLifecycle` wrappers sit under 0.01 ms of self time. Step 1.4 (a Mesh
epoch for actor admission, about 0.3 ms of Mesh reads) is folded into Phase 2:
`render_scan` reads Mesh in Rust, and a JavaScript epoch would need every
Actor.Mesh writer, Rust stores included, to bump it.

Step 1.3 found a latent trap: three's `updateWorldMatrix(true, false)`, which
the mirror pass calls on a mover's mirror mesh, recomputes a flagged parent
group and clears its flag without updating the group's other children. The
forced cascade hid this; a mover group now updates its subtree at once when
its brush matrix changes. `validate-scene-matrices.mjs` compares every
object's `matrixWorld` after the renderer's update with a forced cascade, in
the browser (Island, Smug, Training) and in Node with moving and rotating
movers on Smug.
