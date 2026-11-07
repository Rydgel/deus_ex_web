# The actors phase in Firefox (2026-11-05)

Step 4's second half of [the Firefox 60 fps plan](firefox-60fps-plan.md#plan-route-a): the hitch log's `p.actors`, 2.7 to 3.3 ms
a frame in Firefox against about 2.0 ms in Chrome. **Verdict: no family reaches 0.5 ms on any of the five maps, so no runtime
change was made at first** (a second pass the same day built three of the four cheap candidates together,
[below](#host-plumbing-2026-11-05-second-pass): -0.4 to -0.6 ms). The phase is a flat spread of per-actor host work and the OccludeBsp pass, and most of the gap to Chrome is
that Firefox adds the page's half to the same number.

**Revised 2026-11-06:** the reading "flat, so nothing to cut" was right for each function and wrong for their sum. The per-binding
host loops (the membership rebuild, the Mesh-change test, the pair table, the admission calls for ~500 bound actors, the candidate
pack, the update of the hidden bindings) are 3.4 ms of the Dockyard's 7.4 ms `p.actors` and about a fifth of the Island's. Moved into
the Rust core as one pass over a table of rows, they cut `p.actors` from 8.1 to 5.4 ms at the Dockyard (Firefox inline, four interleaved pairs) and from 4.0 to
3.2 ms on the Island, with every snapshot byte-identical: see [Actors layer in bulk](firefox-60fps-plan.md#actors-layer-in-bulk-2026-11-06).
What stays in the phase is the original OccludeBsp pass (1.1 to 1.6 ms in Rust) and the render iterators' rescans in the child
frames (1.0 ms at the Dockyard), which are the algorithm and its script callbacks, not host plumbing.

## What `p.actors` is

In inline mode the frame adds each simulation step's time to the page phase of the same name (main.mjs `drawFrame`:
`framePhases[name] += ms`), so `p.actors` is two things that Chrome's worker reports apart, and the hitch log already records
both (`w.actors` is kept in inline mode):

* **`w.actors`, the simulation half** (sim-session.mjs `frame`, from the sprite scan's end to the `actors` mark): the actor mesh
  layer's update (`actors()` → `actorScene.update`, actor-mesh-sim.mjs), the main frame's OccludeBsp when the layer runs it
  (`occludeMain`), and the Strobe scan of the light maps. This is the "about 2.0 ms in Chrome" (the worker profile of the Island,
  [play-frame-cost.md](play-frame-cost.md#where-the-islands-worker-frame-goes): 2.0 ms, BSP occlusion 1.1, the meshes 0.85).
* **The page's half** (`npcPreview.draw.apply(snap.actors, ...)`, actor-mesh-draw.mjs `apply`): each record applied to its
  binding, then the GPU mesh pass (`gpu.run`). In Chrome it runs on the page thread beside the worker, not in the worker's frame.

| Map (Firefox 155 inline, headless, scan route, 5 s after the map) | `p.actors` | `w.actors` | page half |
|---|---:|---:|---:|
| Island | 3.19 | 2.60 | 0.59 |
| Airfield | 3.33 | 2.72 | 0.61 |
| Wan Chai market | 2.70 | 2.21 | 0.49 |
| Area 51 bunker | 3.10 | 2.64 | 0.46 |
| Battery Park | 3.02 | 2.41 | 0.61 |

The Island's `w.actors` is 1.3 times the Chrome worker profile's 2.0 ms (that figure is the only Chrome one here; the other maps'
Chrome `w.actors` were not taken). So against Chrome's worker frame the excess is about 0.6 ms in the simulation half, and the
other 0.5 to 0.6 ms is work Chrome's page thread does in parallel.

## Method

Runs and Gecko profiles are in `.cache/perf/actors/` (outside Git). Master at 446c46dd, a quiet machine:

```
node scripts/hitch-run.mjs --browser firefox --map M --mode scan --seconds 60 --god --profile .cache/perf/actors/N.gecko.json --out .cache/perf/actors/N
node scripts/hitch-phase-means.mjs .cache/perf/actors/N.json --cols p.actors,w.actors,p.sprites,w.sprites
node scripts/gecko-phase.mjs N.json N.gecko.json --entry '^actors \(src/viewer/sim-session' --tree 0.05 --top 0     # the simulation half
node scripts/gecko-phase.mjs N.json N.gecko.json --entry '^apply \(src/viewer/actor-mesh-draw.mjs:537' --depth 2     # the page's half
node scripts/wasm-names.mjs .cache/wasm-names/wasm32-unknown-unknown/release/script_vm.wasm 576 407 405 ...         # wasm-function[N]
```

`gecko-phase.mjs`, `wasm-names.mjs` and `hitch-phase-means.mjs` are the HUD phase's tools (commit 5bfb87d5, branch
`worktree-agent-a658c0eed17c01543`). The sample rate is 1 ms, 6,900 to 8,200 samples under the entry per map; the profile's total
for the simulation half is within 6% of `w.actors` on every map (2.53, 2.69, 2.09, 2.56, 2.37 ms against 2.60, 2.72, 2.21, 2.64, 2.41).

## The simulation half, by family (ms a frame, inclusive, Gecko profile)

| Family | Island | Airfield | Wan Chai | Bunker | Battery Park |
|---|---:|---:|---:|---:|---:|
| **OccludeBsp, the Rust pass itself** (`occ_run` without its callbacks: `occlude`, `occlude_children`, `copy_from_raster`) | 0.44 | 0.19 | 0.39 | 0.50 | 0.24 |
| **Child frames' SetupDynamics** (`occ_frame_dynamics` → `childDynamics` → `rescan`: the laser and particle iterators run again, script `Init` through the Rust VM) | 0.15 | 0.37 | 0 | 0.36 | 0.12 |
| **`packDynamics`** (SetupDynamics' candidates from the mesh bindings, packed for `setup`) | 0.26 | 0.30 | 0.32 | 0.21 | 0.30 |
| `updateMovers` (a `readNamed` run of ~9 reads per moving brush) | 0.05 | 0.13 | 0.08 | 0.12 | 0.12 |
| `visibility`'s other glue (master frame, decal and detail blocks, `drawnOf`, mirror list) | 0.15 | 0.14 | 0.12 | 0.18 | 0.14 |
| **The bindings' `update`** (main-frame record per drawn binding: `updateDrawn`, SetupForActor `lightIn` 0.07 to 0.21, `planGpu`, `decideGroups`) | 0.53 | 0.20 + 0.40 items | 0.28 | 0.39 | 0.60 |
| **`reconcile`** (`admit` 0.07 to 0.12, `render_scan` 0.06 to 0.12, `meshChanged` 0.06 to 0.08) | 0.38 | 0.29 | 0.28 | 0.30 | 0.29 |
| **`meshReads`** (the `mesh_reads` call 0.07 to 0.12; the JavaScript pair table around it, `get block` up to 0.11) | 0.27 | 0.21 | 0.30 | 0.17 | 0.24 |
| weapons, `drawExtras`, `newScope` | 0.04 | 0.19 | 0.07 | 0.06 | under 0.05 |

("items" are the render-iterator items' bindings, `drawItems`: the Airfield's lasers, each one a full `updateDrawn`.) Wasm is
0.88 ms of the Island's 2.53 and the rest is JavaScript, 1.64 ms; the host's object-image reads (`readNamed` and under it
`readInstanceField`, `instance`, `namedHandle`) are 0.13 to 0.23 ms of the phase, from many callers none over 0.13.

**No family reaches 0.5 ms.** The two largest rows are the OccludeBsp pass (the original algorithm, bit-exact in Rust: it
is the compute, not a host cost; 0.19 to 0.50) and the bindings' own `update` (work that every drawn actor needs in the
original too: its SetupForActor lighting is already in Rust, `rustSetup`, 0.07 to 0.13). The remaining rows are 0.05 to 0.38.

## The page's half (ms a frame)

| Part | Island | Airfield | Wan Chai | Bunker | Battery Park |
|---|---:|---:|---:|---:|---:|
| `apply` per record (self) | 0.14 | 0.21 | 0.14 | 0.13 | 0.16 |
| `hideBatched` under it (a record that hides its binding) | 0.12 | 0.12 | 0.11 | 0.08 | 0.10 |
| `gpu.run` (Island whole; the others the listed children: pose and light uploads 0.04 to 0.13, the lighting, LOD and camera passes, `resetState`) | 0.22 | 0.16 | 0.15 | 0.16 | 0.20 |
| the rest (`setPose`, `setSpheres`, `batches.flush`, the entry's own) | 0.11 | 0.13 | 0.09 | 0.07 | 0.13 |
| **total** | 0.59 | 0.62 | 0.49 | 0.44 | 0.59 |

The record loop is 0.25 to 0.33 ms, and a record is sent for every binding every frame, hidden ones too (`newUpdateRecord`
returns `{id, visible: false, childOnly: false}` and `compactRecords` keeps it). Nothing in `gpu.run` is over 0.13 ms.

## Candidates, none of them 0.5 ms (estimates; nothing is built)

Each would give the Island about the stated part of its 3.19 ms, and each is under 1.5% of the Firefox frame (17 ms) by itself.
The first four together are about 0.5 to 0.65 ms, 3 to 4% of the frame, in four separate changes.

* **Skip a hidden record that follows a hidden record** (sim side keeps what it last sent; the page's `apply` of such a record
  sets fields to what they already are and re-hides entries that nothing has shown: a binding is touched between main frames
  only by child-frame passes, which send a visible `childOnly` record when they need it: read from the code, not tested). Saves most of `hideBatched` and part of
  `apply`'s self time: about 0.15 to 0.2 ms, in Chrome's page thread too.
* **Keep `meshReads`' pair table between frames** (the (handle, block) pairs are rewritten for every binding every frame, with a
  `binding.block` getter, `handleOf` and two `setUint32` each; they change only when `reconcile` admits or releases a binding).
  About 0.10 to 0.15 ms.
* **`packDynamics` from the mesh_reads block in Rust**: `packSetup` copies words out of the block into the candidate buffer;
  with the block and the candidate buffer both in the arena, the copy is Rust's. About 0.15 to 0.2 ms of its 0.21 to 0.32.
* **`updateMovers`**: the nine reads per mover run again each frame although most movers did not move; a changed-words
  check from the image would skip them. 0.05 to 0.1 ms (the bit-exact tracker update must still run for a moved mover).
* **Child-frame iterator rescans** (Airfield 0.37, bunker 0.36): original behavior (each frame's SetupDynamics runs the iterators'
  `Init`), the glue around the Rust VM's script run is `laserIteratorItems`/`particleIteratorItems` (`farMoveActor`,
  `currentItem`, `inRenderPass`, `processEvent`): flat, 0.05 to 0.09 each. The main frame's own scan, in the `sprites` phase,
  costs 0.78 ms on the Airfield and 0.54 on the bunker, so the render-iterator family as a whole (sprites, rescans and items) is
  about 1.5 ms on the Airfield; it is a separate step from this phase.
* **A Rust owner of the bindings' per-frame state** (admission, the mesh_reads pair table, `meshChanged`, the candidates' pack,
  the record's hidden test): the sum of the four rows above, `reconcile` and `meshReads`, about 0.5 to 0.7 ms on the Island and
  Wan Chai, but a multi-step program on verified code (`RENDER_SCAN=verify` and the dynamics checks cover it), each step under
  the 5% rule alone. It carries into Chrome's worker as well.

## Host plumbing (2026-11-05, second pass)

The four cheap candidates above, built as one step behind `?actorPlumbing=` (`ACTOR_PLUMBING=` in Node; actor-plumbing.mjs).
`js` keeps the reference bodies, `no-hidden`, `no-pairs`, `no-movers` keep one, `verify` runs the new bodies and checks each against the
reference as it goes. Three were built; the fourth was dropped (below).

### Skipped hidden records (`hidden`, actor-mesh-sim.mjs `compactRecords`)

The equivalence the first pass only read from the code, established now. A plain hidden record `{id, visible: false, childOnly: false}`
(a binding the frame does not draw, and the `hide()` of an unused item slot: nothing else puts fields on a record before `updateDrawn`'s
`visible = true`) leaves the page's binding in a state that depends on the record alone (`apply`): `latest.visible` and `childOnly`,
`cameraPoints` null, the main frame's LOD state put back on the slot if a child pass left one (`appliedLodKey`), `mainLighting` and
`variantLit` reset, the root and the batch entries hidden. A second one finds all of it as the first left it, **unless something else
touched the binding in between**, and the only other writers are:

* `applyPass`, which the page runs for the decisions of the sim's `passVisibility` and `framePass`. Those make a decision only for a
  binding whose last update drew it, in the main frame (`drawnMain`) or in child frames alone (`childOnly`). A plain hidden record is
  what `update` returns for a binding that is not drawn, so it has none, **except** the one hidden return that keeps `childOnly`: a
  binding only the child frames draw whose bounding sphere the main frustum culls. Its decisions show the root, select a child frame's
  LOD state and lighting (`appliedLodKey`, `variantLit`), and the next frame's hidden record is what resets them. So the sim marks a
  binding touched (`hiddenRun[id] = 0`) when a decision of its draws (`root` or `flipSide`), and sends the next plain hidden record. A
  decision that hides (`NOT_IN_FRAME`, the viewport pass's `{ root: false }`) returns in `applyPass` after hiding the root and the
  batches, which a hidden binding already is: nothing to mark. Also a context loss (`leaveGpu`) marks every binding.
* `updateView`, which returns at once for a root that is not visible.

The sim keeps the flag for records of both producers (`update` and the viewport window's `updateFrame` go through `compactRecords`),
in the order the page applies them. Records are not dropped anywhere in transit (the sim client queues snapshots in order), which the
existing delta fields (`material`, `plan`, ...) already rely on. `verify` sends the skippable records marked `quiet` and the page
(actor-mesh-draw.mjs `applyQuiet`) applies each one and throws if the binding's state (`hiddenState`: root and record visibility, LOD
key, lighting flags, flip side, path, every group's mesh, twin and batch entry visibility) differs after.

On the Island walking for 240 frames, **97% of the records are plain hidden records after a hidden record** (71,379 of 73,687 in
inline mode; 67,052 of 69,275 in the worker).

### The pair table (`pairs`, actor-mesh-sim.mjs `meshReads`)

`mesh_reads`' (handle, block) pairs are a function of the `actors` list: a binding's block is made with it and zeroed when it is retired
(which also takes it out of the list), and an actor's handle never changes. The table is written when the list changes
(`actorsVersion`: `take`, `retire`, the Training start-up) and kept; `verify` rewrites it into a scratch each frame and compares.

### The movers (`movers`, render.rs `mover_reads`, sim-session.mjs `updateMovers`)

`mover_reads` is the Rust form of `dynamicActorRoute` (Recursion 0, HighDetailActors set, a running level) on the tracker's movers plus
their Location and Rotation words, from the object image in one pass over a (handle, block) table made once per tracker. A mover whose
words equal the pair last given to the tracker (`MV_LAST`, written by the host when it gives them) is not given again: **`Update(mover)`
with the Location and Rotation the tracker already holds is a no-op** (tracker.rs `update`: `moved` is false against SavedPos and
SavedRot, the list is empty, nothing is marked or rebuilt; the tracker's status words and `sync_model`'s counts are the only writes, and
nothing reads them), and a repeated call after a rebuild finds SavedPos equal to Location. A mover Rust cannot read in the image (an
owner chain it cannot walk) takes the old body, which clears its last pair. `verify` compares the route and the words with
`dynamicActorRoute` and `readNamed` for every mover and checks that the tracker holds the words of every mover it skips. (First run:
the check failed, because the tracker is in the script-VM *kernel's* wasm memory and the object image in the *runtime's*; the copy
between them goes through `setMoverFrom`, which takes the source view.)

### Checks

* **State and snapshots.** `frame-alloc-meter.mjs` (the worker's `session.frame()` over 300 frames after 60, every snapshot hashed with its
  numbers' exact bits): `ACTOR_PLUMBING=no-hidden` (the pair table and the movers) gives the reference's hash at **every frame** on the
  Island, Airfield, Area 51 bunker and Wan Chai market. `bench-sim.mjs --warm 60 --ticks 300 --render-feedback` keeps the five
  digests (Island 5adb254a07b1ed6f, Training 07816ec472f29b84, Airfield 46ed0d32ae5b56af, Wan Chai 80d27b37e0944d88, bunker
  764a7bdffd2ebe59).
* **`verify`** runs clean over the same 300 frames on the Island, Airfield, bunker and Wan Chai (pair table, movers), and in Chromium
  (worker and inline) on the Island walking and on the Paris club's bar mirror and restroom mirror (`validate-mesh-path-frames.mjs
  --query '&actorPlumbing=verify'`: the child-frame passes that touch a hidden binding) with every quiet record applied and checked.
  `RENDER_SCAN=verify` fails on the Airfield with or without the plumbing (`LaserProxy0 word 4 differs in mesh_reads`): not from this step.
* **The page draws the same.** `validate-sim-split.mjs --draw-state --pixels` (new: a digest of every page binding's draw state, and the
  drawing buffer's hash, at each of 12 checkpoints over 240 walking frames; the sim state digest as before): default against
  `actorPlumbing=js`, in worker and inline mode, and verify against js, give the same draw states and pixels at every checkpoint.
  `validate-mesh-path-frames.mjs --plumbing` (new: one more run with `actorPlumbing=js`): the bar and restroom mirrors draw the same
  1280x720 pixels. Two of the seven Island runs where the js arm loaded third differed in the simulation's state digest at one
  checkpoint (frame 160 inline, 240 in the worker) and agreed again at the next, while page A and its repeat agreed; the reverse
  order (js first, default third), js against js and default against default all pass. That is asynchronous texture and binding
  admission shifting with the page's speed (the validator's own note), not the plumbing: the snapshot hashes above are exact.
* The other validators that read the actor layer, the tracker or the movers pass: actor-mesh-scene, gpu-mesh, play-frame, spawn-mesh,
  npc-mesh-preview, sprite-setup, umesh-play, page-movers, mover-vertices-play, brush-tracker, first-draw-pose, mover-light-maps-play,
  coronas-mover-play, tracked-collision, frame-projection-movers, lodmesh-lod-play, dynamic-light-mover, bsp-occlusion and mesh-path-frames
  (`run-validators.mjs --filter`).

### Measurements

Headless Firefox 155 inline, `hitch-ab.mjs --arms "new:,old:actorPlumbing=js" --pairs 3 ... --mode scan --god --seconds 60`, means over the
drawn frames from 5 s after the map, three interleaved pairs (the order alternates):

| | Island new | Island js | Airfield new | Airfield js |
|---|---|---|---|---|
| `p.actors` (three runs) | 2.53, 2.52, 2.47 | 2.95, 2.83, 2.87 | 2.28, 2.29, 2.35 | 2.87, 2.93, 2.92 |
| mean | **2.51** | 2.88 | **2.31** | 2.91 |
| `w.actors`, the simulation half | 2.25 | 2.37 | 2.10 | 2.35 |
| the page's half (`p.actors` - `w.actors`) | 0.26 | 0.52 | 0.21 | 0.56 |
| page p50 / p95 | 15, 15, 14 / 22 | 16, 15, 15 / 22 | 16 / 19-20 | 17 / 20 |
| drawn frame rate | 55.7 | 55.5 | 57.5 | 55.8 |

`p.actors` is lower in every pair: **-0.38 ms on the Island, -0.60 ms on the Airfield**, within the 0.5 to 0.65 the four candidates were
estimated at (the dropped pack was the fourth). The page's half falls by half: the record loop sends 3% of the records
(2,308 of 73,687 on the Island) and `hideBatched` is nearly gone. The simulation's half falls 0.12 ms (Island) and 0.25 ms (Airfield) from the
pair table, the movers and the shorter record list. Page p50 falls by about 1 ms on both maps (the figures are whole milliseconds); p95 is
unchanged on the Island and 0.5 to 1 ms lower on the Airfield. The tick, sprites and render phases are the same in both arms.
A V8 CPU profile of the same Island frames (Node, `--cpu-prof`, 460 frames) puts `meshReads` 0.29 → 0.10 ms a frame, `updateMovers`
0.043 → 0.012, and `compactRecords` 0.004 → 0.001.

### Dropped: the candidates' pack in Rust

`packSetup` copies 13 words from the `mesh_reads` block into the candidate. The block is in the runtime's arena and the candidates are in
the occlusion kernel's memory, which is another wasm instance (`loadScriptVmKernel`, one a realm), so Rust cannot copy between them; the
copy would need the Setup candidates to move into the arena together with `occ_setup`'s input. And it is not where the time is: a V8
CPU profile of 460 Island frames puts `packDynamics` at 0.29 ms a frame, of which the whole `packSetup` body is 0.03 and the loop that
admits the bindings (`iterators.has`, `levelIndex.get`, `admitted`'s and `blockAt`'s two `views()` calls each) is 0.16 ms. A
version that cut the copy would save under 0.03 ms. What is left there is hash lookups of an actor per binding per frame; a cache of
each binding's index in `levelIndex` (stamped with the map's rebuilds) is the next cut if it is wanted, 0.05 to 0.1 ms.

## Left open

* Chrome's `w.actors` on the Airfield, Wan Chai, bunker and Battery Park were not taken (only the Island's 2.0 ms from
  play-frame-cost.md), so how much of the 2.2 to 2.7 ms is Firefox-specific is known for the Island only: 1.3 times.
* The remaining candidates are the admission loop of `packDynamics` (above) and the child-frame rescans; the pack in Rust is dropped.
* Chrome's page thread gets the record skip too (its worker posts 3% of the records), but it was not measured here.
