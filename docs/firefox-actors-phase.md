# The actors phase in Firefox (2026-11-05)

Step 4's second half of [the Firefox 60 fps plan](firefox-60fps-plan.md#plan-route-a): the hitch log's `p.actors`, 2.7 to 3.3 ms
a frame in Firefox against about 2.0 ms in Chrome. **Verdict: no family reaches 0.5 ms on any of the five maps, so no runtime
change is made.** The phase is a flat spread of per-actor host work and the OccludeBsp pass, and most of the gap to Chrome is
that Firefox adds the page's half to the same number.

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

## Left open

* Chrome's `w.actors` on the Airfield, Wan Chai, bunker and Battery Park were not taken (only the Island's 2.0 ms from
  play-frame-cost.md), so how much of the 2.2 to 2.7 ms is Firefox-specific is known for the Island only: 1.3 times.
* Counts of bindings and of drawn and hidden records per frame, which would size the hidden-record skip exactly, were not taken.
