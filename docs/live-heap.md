# Live heap (Stage 7)

What Play keeps alive in the JavaScript heaps after a map load, who owns it, and the
plan to move the largest parts out of the garbage-collected heap. Host
representation only: nothing here changes what the simulation computes.

**Why.** A major GC's pause follows the live heap ([frame cost](play-frame-cost.md)
"October 27"). In Firefox, the default runs the simulation on the page. There, the
page's incremental GC raises its slice budgets to 100 ms once allocation during
marking reaches its limit, giving six to eight 100 to 133 ms frames a minute on the
Island. In Firefox's worker mode a major GC is one unbroken 320 to 340 ms slice, about
every 50 s. Allocating less helps only the first case, and only partly. A smaller live
heap helps both. Chromium's worker GC is short (26 ms majors on the Island), so
Chromium is not the target, but it gets the same savings.

## Measuring

Against a running dev server (`node .work/tools/serve.mjs 5190`, or the user's on
5173):

* `node scripts/profile-live-heap.mjs --url http://127.0.0.1:5190 --map 01_NYC_UNATCOIsland --sim worker`
  loads the map from the map list, walks forward for 30 s, and forces V8's GC three
  times in each realm. It then writes a heap snapshot of the page and of the
  simulation worker (`--sim inline`: the page only) to `.cache/perf/`. The Island
  worker's snapshot is about 2 GB. `--mode roam` plays as `hitch-run.mjs --mode roam` does (forward, turning when stuck or
  at random) instead of walking: after a 240 s roam on master 07de3088 the Island's worker holds 336 MB against 318 MB after
  the 30 s walk (8.21 M against 7.69 M objects).
* `node scripts/heap-families.mjs <snapshot> [depth] [top]` groups the live objects by
  owner. An object goes to the family named by the first `depth` property or
  closure-variable names on its shortest path from the roots. Reaching an owner
  object (a class with at most 8 instances: ScriptProcess, ScriptRuntime,
  ScriptClassLoader, AssetStore, CollisionWorld, and so on) starts that owner's own
  family, whatever the path.
  * Options: `--inside KEY,...` lists a family's object kinds and edges; `--sample KEY`
    shows paths into it.
  * A family is a first-reach attribution: an object shared by two owners counts once,
    under whichever the walk met first. Treat family sizes as approximate.
  * The snapshot adds a string node for each boxed number's value; these are left out
    of the counts.
* `node scripts/profile-firefox-memory.mjs --url http://127.0.0.1:5190 --sim inline|worker`
  does the same play in headless Firefox. It then has Gecko minimize memory and write
  its about:memory report (via the dump signal, Linux only), and prints the page's and
  the worker's JS memory by kind.
  * Firefox's report attributes memory by JS class (Array, Object, Map...), not by
    owner. The owners come from the V8 snapshots of the same code.

Objects are what a major GC marks, so the plan counts objects first and bytes second.
ArrayBuffer and Wasm memory is marked as one object per buffer, not element by
element.

## The Island, 2026-10-28 (before step 1)

Linux host, 30 s walk after a map-list load, after forced GCs.

| Realm | Chromium objects | Chromium JS heap | Firefox GC heap (+ slots, elements) | Buffers + Wasm (not traced per element) |
| --- | ---: | ---: | ---: | ---: |
| worker mode: page | 7.9 M | 248 MB | 268 + 57 MB (Arrays 214) | 309 MB |
| worker mode: worker | 18.0 M | 637 MB | 396 + 90 MB (Objects 174, Arrays 67) | 518 MB |
| inline: page (simulation + rendering) | 17.0 M | 579 MB | 596 + 132 MB (Arrays 268, Objects 184) | 633 MB |

The inline page holds less than page plus worker. The two realms each keep their own
copy of the asset store's packages and of the decoded map. In inline mode the page's
map object is also the simulation's.

The worker on 00_TrainingCombat holds 15.2 M objects, with the same top three owners.
The script object model is therefore roughly the same on every map; the world and
mesh data scale with the map.

### The page (worker mode, 7.9 M objects)

| Objects | Family | What it is |
| ---: | --- | --- |
| 5.54 M | lighting records' `points` | One `[x,y,z]` array per light-map texel of every lit surface: about 2.77 M texels, 140 MB |
| 0.35 M | `npcPreview` | The actor mesh renderer (needed in Play) and its debugging views |
| 0.22 M | `map.actors` | The decoded map's actors (properties, values) |
| 0.21 M | `map.model.vertices` | The decoded BSP model's vertices `{point, side}` |
| 0.45 M | AssetStore | The packages' export, import and name tables |
| 0.13 M | `map.triangles` | `{points:[3], surface, node}` per triangle, the world build's input |

### The worker (18.0 M objects)

| Objects | Family (owner.property) | What it is |
| ---: | --- | --- |
| 2.60 M | ScriptProcess.linkedOperands | Every linked script's decoded bytecode trees, the operand map node → identity, the name operands |
| 2.50 M | ScriptProcess.packageObjects | One identity per non-level export, with its metadata, function record and load-graph record |
| 1.94 M | host (actorSim, game) | Actor mesh faces per binding; the decoded map reached through the game |
| 1.91 M | ScriptClassLoader.graph | Load edges, per-package linkers with per-export copies |
| 0.91 M | CollisionWorld.bsp | The BSP collider: the decoded model's nodes, vertices, surfaces; one hull (plane and bevel arrays) per collision bound |
| 0.6 to 0.8 M each | ScriptRuntime.instances, memberCaches, AssetStore, identities, nativeRecords, linkedClasses, PreparedDynamicLoadGraph | See below |

V8 alone also boxes numbers: the worker has 3.9 M heap numbers. Fields whose values
were ever non-integer are stored as one boxed double each. Objects that gained
properties after construction get an out-of-line property array each (for example
`serializedOffset`/`serializedEnd` on bytecode nodes, which `decodeScript` adds late).
SpiderMonkey stores doubles unboxed, so these cost Firefox nothing. They are left to
the end.

## What each structure is

From reading the code (2026-10-28). The behavior of each reader is as found. Where a
claim is unverified it is said so.

**Light-map texel points (page; gone since step 1).** `src/unreal/lighting.mjs` `surface()`
built `points` eagerly for every lit surface. They held `transform(basis.point(x, y))`
for each texel, with `transform` the identity or a mover's matrix. The only reader was
`inFrustum` (`src/viewer/world.mjs`): `THREE.Sphere.setFromPoints` over them,
once per record. That happens only when a ViewportWindow's frustum culls light maps
(`syncMovingLights`, `updateTextureAnimation`), and mover records never reach it.
`refill`, `invalidate`, the animation kernel and the moving lights use `basis`,
`transform`, `model.points` and the texel bytes instead.

**Bytecode trees and operands.**
* `decodeScript` (`src/unreal/bytecode.mjs`) is called from `compileFunction`
  (`script-vm.mjs`). It builds `statements` and `expressions` Maps over node objects.
  `ScriptObjects.link` (`script-objects.mjs:98-124`) adds `objects` (Map node →
  identity) and `names`.
* The trees are read in four places:
  * the JS interpreter (through `operandCache`);
  * the Rust VM's lowering, which is lazy per function and re-run when `operandEpoch`
    changes;
  * statements the lowering did not take (`compiled.step`);
  * state labels (`script-state.mjs`).
* The Rust VM holds only the lowered words, which refer back to nodes by index.
* Node identity is the key of several caches: `nodeCode`, `contextResults`,
  `lowered.nodes`, `memberCaches`. (Since step 8 the operands, `contextResults` and
  the discarded calls are keyed by expression offset; `memberCaches` keys class and
  state nodes, not bytecode.)
* Each function also keeps a copy of its bytecode (`src/unreal/script-metadata.mjs:136`),
  though the package bytes hold the same.

**Package objects.** `ScriptObjects.exportIdentity` (`script-objects.mjs:60-72`) mints
one identity per export. `metadata`, `function`, `loadRecord` and the like are added
later. Four pieces of what it holds:
* `metadata.serialized` is a copy of every property export's bytes
  (`script-metadata.mjs:294`). Nothing in `src` reads it.
* A load-graph record kept a `nativeSlots` Map with a `{value, width}` object per
  slot, about 24 per record, read directly in 22 files, not only through `slotOf`
  (one array of pairs per record since step 7).
* `ScriptProcess.functions` (`script-runtime.mjs:806`) is written and never read.
* `contextResults` (`prepareContextResults`, `script-runtime.mjs:800, 816`) is built at
  link for every Context node. It is read only when a Context's receiver is None.

**Export tables, kept four times.**
* `parsePackage` (`src/unreal/package.mjs:157`) builds one `entry` object per export.
  This is the authoritative copy, shared by the identities.
* The class loader's `buildLinker` (`script-load-graph.mjs:436`) copies classIndex,
  superIndex, flags, serialSize and serialOffset into one more object per export.
* `PreparedDynamicLoadGraph.buildLinker` (`script-dynamic-load-object.mjs:165-205`)
  builds a third object per export of the packages DynamicLoadObject reaches. It adds
  the name index and hash chain, plus a lower-case path string per export.
* The asset store's `exportsByPath` and the `packageObjects` keys add further
  lower-case path strings.

**Class defaults.** `linkClassBody` builds `cls.defaults` (`script-class-loader.mjs:226`)
as a Map of Maps covering the whole property chain, inherited fields included, for
every class. The same values are in the load record's defaults and in the class
image the Rust core reads.

**Native object bindings.** `bindNativeObject` (`script-runtime.mjs:1105`) binds five
header fields per native object, each with its own getter and setter closures and
context. That is about 110 k closure pairs on the Island.
(Since step 5 the five are shared objects: see "Step 5's results".)

**The decoded map in the simulation.** There is one `map.model`, not copies:
`CollisionWorld` (`game.mjs:47`), the player scene's `level`, the level queries and the
kernels' uploads all start from it. A node is about five objects (plane, zone mask,
zones, leaves). `BspCollider` adds one hull per collision bound. The Rust kernels
(OccludeBsp, decals, traces, the brush tracker) already hold Wasm copies, but the
JavaScript readers of `model.nodes[i]` remain. Whether the legacy `BspCollider` sweep
(`player.mjs`, `doors.mjs`) still runs per tick in Play is unverified.

**Actor mesh faces (before step 4).** `actor-mesh-sim.mjs:191` read each binding's faces through
`readLodMeshSurfaces` (`lodmesh-materials.mjs:56`). A face was
`{wedges, vertices, uv[3], material, flags, texture}`, about nine objects (fifteen in the heap snapshot,
with the arrays' element stores). Nothing shared them between bindings of the same mesh. The topology already
existed typed (`lodMeshTopology`, `faceWords`). Since step 4 every binding of a mesh reads one typed block
(`src/runtime/mesh-faces.mjs`); see "Step 4's results".

## Plan

Each step changes how the host holds data, never what it computes. It ends with
these checks:
* the simulation's state digests unchanged (bench-sim on the Island, Training and
  747);
* the step's own validators;
* `profile-live-heap.mjs` and `profile-firefox-memory.mjs` before and after;
* draw gaps in Firefox, inline and worker, two interleaved Island pairs
  (`scripts/hitch-ab.mjs`, `hitch-summary.mjs --gaps 90`);
* a Chromium worker frame A/B, to show no regression.

Step 1 is done, and its measurement re-ranks the rest. A major GC's time follows the
pointer-rich structures, not the heap's bytes or object count (see "Step 1's
results"). Steps 2 to 9 keep their order of work, but are judged by the references
they remove (the edge counts in `heap-families.mjs`), and each is measured by the
Firefox GC markers, not only by heap size.

1. **Light-map texel points on demand (page): done 2026-10-28.** `surface()` no longer
   builds `points`. `inFrustum` computes the record's sphere on first need with
   `texelSphere` (`world.mjs`): the same points and the same box, centre and radius
   operations as `THREE.Sphere.setFromPoints`. `validate-texel-sphere` checks that
   both give the same doubles for every lit surface of the Island and Training, and
   for the Island under a mover's matrix: 18,602 records, 6.6 M texels.
2. **Copies nothing reads (both realms): done 2026-10-29, except two items.**
   * Dropped `metadata.serialized` and the serializer tail `extra`, the superField and next views, and the unread UField prefix
     objects (marker, base, next, scriptText, name).
   * The per-function bytecode copy is a view of the package bytes. `ScriptProcess.functions` is no longer filled. A function
     drops its children and parameters copies once its parameters' identities are linked.
   * Not done: `contextResults` stay built at link. They resolve and load classes (`loadClass` is asynchronous and changes the
     load order), and the null-Context read that needs them is synchronous inside a script event; a body without a result now
     shares one empty Map and a descriptor one zero function. `map.triangles` on the page is not done (not this step's files).
   * See "Steps 2 and 3's results".
3. **One export table: done 2026-10-29 for the linkers.** The class loader's linkers and `PreparedDynamicLoadGraph` read the
   package's export entries through a `LinkerExports` table (`linker-exports.mjs`) that owns only the interned names, the created
   objects and the hash chain; a record the native services read is a view.
   * Measured with step 2's and the integer fixes: see "Steps 2 and 3's results".
   * Left: `pkg.exports` and `pkg.names` themselves as columns behind accessors (about 130 reads of `entry.*` and about 45 of
     `names[i].name`).
4. **Mesh faces once per mesh: done 2026-10-29.** A per-mesh typed face block (the existing
   `faceWords`, plus UVs and material indices) shared by every binding of a mesh,
   cached per mesh. See "Step 4's results".
   * Readers converted: `mesh-lighting-view.mjs`, `meshFaceGroups`,
     `actor-umesh-sim.mjs`, and the page's `actor-mesh-draw.mjs`.
   * Expected: about 0.8 M objects on the Island; it grows with the actor count.
     Measured: see "Step 4's results".
5. **Bindings without per-object closures: done 2026-10-30.** A binding is an object whose `get(instance)` and `set(value, instance)`
   are methods, or a closure pair as before; the header bindings of every object are shared frozen objects, and the callers that took
   `binding.get` detached (`fieldReference`) read through a storage object. The receivers' image-backed members, the spawned actors'
   and pawn views' accessors share their functions; the cell masks are tagged and the cells shared; the per-object copies of the
   class defaults, the authored Maps, the state's locals and probe masks and the slots are shared or made when needed. See "Step 5's
   results".
   * Expected: about 0.5 M objects. Measured: the two families from 655 k objects and 3.80 M edges to 143 k and 1.07 M; the worker
     (240 s roam) from 5.33 M objects, 35.8 M edges and 29.63 M pointer references to 4.29 M, 30.1 M and 24.30 M.
6. **Class defaults once: first part done 2026-10-29.** `cls.defaults` keeps only defaults that changed after
   load. Reads fall back to the load record's defaults and the class image.
   * Expected: 0.3 to 0.5 M objects. This touches spawn, `defaultValue`,
     `classDefaultReference` and `refreshConfigDefaults`.
   * Done (see "Steps 2 and 3's results"): a field a class inherits with its base's values shares the base's Map; the
     per-class Map of Maps stays, so no reader changed. Left: the outer Map per class and the Maps of the fields a
     subclass overrides.
7. **Load-graph records without slot objects: done 2026-10-28.** A record's `nativeSlots`
   is a `NativeSlots` (`src/runtime/native-slots.mjs`): one array of key/value pairs, the
   key packing the offset and the width. `loadEdges` is a `LoadEdges`
   (`script-load-edges.mjs`): typed-array lists over record ordinals, holding one
   reference per record. See "Step 7's results".
   * Expected: 1.5 to 2.5 M objects. Measured: 1.72 M objects and 5.0 M pointer
     references.
8. **Bytecode trees released after lowering: first part done 2026-10-28.** Nothing
   outside a body's tree keys on its nodes any more: the linked operands, the null-Context
   results and the discarded calls are keyed by expression offset. A body's tree is
   released after its link and decoded again from the function's bytes at its first run;
   its JavaScript engine is built then too. See "Step 8's results".
   * Expected: most of the 2.6 M objects. Measured: see "Step 8's results".
   * Left: the trees of bodies that ran (about a tenth of them on the Island), which
     their Rust lowerings reach by node index for every import, a call's name and
     arguments included; and operands as handle arrays the Rust VM reads.
   * This is the Rust core's target ([Rust core](rust-core.md) "Target architecture").
     Verify against the interpreter's existing verify modes.
9. **The BSP model as typed arrays: done 2026-10-30.** `readModel` gives the nodes as the
   original 64-byte FBspNode block and the other records as small typed tables; the
   collision hulls are Float64Arrays built on first use; every simulation and page reader
   reads the views, and the Rust kernels' uploads copy the columns. See "Step 9's results".
   * Expected: 1 to 2 M objects on the Island; it scales with the map. Measured: see
     "Step 9's results".

Steps 1 and 2 are small. Steps 3 to 7 are medium, and each stands alone. Steps 8 and 9
are large and follow the Rust core's direction. The V8-only costs (boxed doubles,
late-added properties) come after, only if Chromium ever needs them.

Rough end state, an estimate to be replaced by measurement: the worker from 18 M to
about 6 to 8 M objects, and the inline page from 17 M to about 7 M. After step 1 the
page in worker mode holds 2.4 M.

## Step 1's results (2026-10-28)

Linux host, the Island, Firefox 155 and Chromium; before is master `d3040bad`.
* **The test that before and after compute the same:** `validate-texel-sphere`, the
  lighting validators that drive the frustum path (`validate-moving-lights-incremental`,
  `-auglight-lighting`, `-moving-light-effects`, `-light-animation-rust`), and the
  whole `-play` group (73 pass; the 3 failures are the known reds: `host-services-play`,
  and `lodmesh-lod-play` and `master-frame-play` timing out). The change is page-only
  (`createLighting` has no other user), so the simulation's digests cannot move.
* **Heaps.**

  | | Before | After |
  | --- | --- | --- |
  | Chromium page, worker mode | 7.89 M objects, 27.3 M edges, 248 MB | 2.39 M objects, 10.8 M edges, 108 MB |
  | Firefox inline page, GC heap | 596 MB (Arrays 268 MB) + 132 MB slots and elements | 404 MB (Arrays 80 MB) + 102 MB |

* **Load.** In Chromium inline, two interleaved pairs (`profile-map-load.mjs --sim
  inline`): the world build took 992 and 993 ms against 1,204 and 1,207 ms before. The
  first drawn frame came at 6.82 and 6.81 s against 7.09 and 7.11 s.
* **GC, from Gecko profiles.** One 100 s inline roam per side, the page's content
  process. The play-time major GCs marked for 303, 496, 496 and 498 ms in total, against
  340, 511, 523 and 522 ms before: about 5% less. There were 8 major GCs in each run. In
  both, the last slices' budgets still rise from about 30 to 100 ms.
* **Draw gaps.** Three interleaved pairs, 100 s roams, the 65 s after the first 40 s
  (`.work/hitch/ab-ff-code.sh` with a second server serving the old files,
  `.work/tools/serve-variant.mjs`):

  | | Gaps over 90 ms | Gaps over 50 ms | Longest gap | fps |
  | --- | --- | --- | --- | --- |
  | Before | 2, 6, 2 | 60, 25, 24 | 150, 134, 134 ms | 38.0, 44.0, 44.1 |
  | After | 6, 1, 9 | 23, 16, 25 | 134, 117, 150 ms | 45.4, 48.7, 39.5 |

  No change beyond the run-to-run spread.

**What it says about the plan.** A third of Firefox's inline GC heap went, and the
marking time fell by about 5%. The texel points were leaves (arrays of three doubles,
nothing inside to trace), so marking them was cheap. The marking cost is in what
remains: objects with many references (Objects 184 MB, Functions, Maps and closures,
mostly the script object model). The long frames come from the incremental slices'
budgets rising while the page keeps allocating during a mark of about 3 s. Two kinds
of change can therefore shorten them:
* fewer references to trace: steps 3 to 9, ranked by edges removed;
* less growth during a mark, ALLOC_TRIGGER and TOO_MUCH_MALLOC. Both reasons appear
  on the escalated slices; TOO_MUCH_MALLOC counts malloc'd memory such as ArrayBuffers
  made per frame.

## Chromium on a loaded machine (2026-10-28)

The user feels GC pauses in Chrome on the Mac when the machine is already busy. The Linux host is fast enough to hide them, so
the browser was pinned to two cores (`taskset -c 0,1`: the page, the worker, the GPU process and V8's GC helper threads share them)
to stand in for a loaded machine. Each run is 120 s of Play on master `d746241a`: `hitch-run.mjs --mode roam --trace`, with
`--worker-profile` where marked, Chromium worker mode, from 5 s after the map.

| Map | Cores | Gaps over 50 ms | Over 100 ms | Longest | Worker major GCs | Worker heap after a major GC |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| UNATCO Island | 16 | 0 | 0 | 50 ms | 2 | 680, 687 MB |
| UNATCO Island | 2 | 10 | 4 | 300 ms | 2 | 668, 667 MB |
| UNATCO Island, profiled | 2 | 9 | 2 | 300 ms | 1 | 671 MB |
| WanChai Underworld | 16 | 0 | 0 | 50 ms | 1 | 645 MB |
| WanChai Underworld | 2 | 6 | 2 | 350 ms | 1 | 635 MB |

**Where the long frames go.** The long gaps are long worker frames, in pairs. The worker's CPU profile puts most of each in the
garbage collector: 212 of 273 ms and 185 of 255 ms on the Island, 263 of 315 ms and 84 of 138 ms in WanChai. The trace of the
Island pair shows one major GC cycle of the worker's heap. V8's background marking ran 1.4 s on the helper threads (one stretch
457 ms), could not keep up on two cores, and the rest fell to the worker thread: 68 incremental marking steps (378 ms) and a 37 ms
finalization. With all cores the same cycle stays in the background and no frame is late. The page's major GCs (3 to 8 a run)
take at most 17 ms.

**What it says.** A loaded machine turns each major GC of the worker into a pause of a few hundred milliseconds: about one pair
of long frames per one or two minutes of play here. The marking work follows what the worker keeps alive, 635 to 690 MB and about
91 M references on the Island (the families above). The marking time can only fall with fewer references to trace (steps 3 to 9).
Less garbage would make the cycles rarer, but not shorter (but see "The two-core long frame" under step 8: the worker's marking
runs inside one or two frames). Each step removes 5 to 12% of the references, so getting such a pause under 100 ms needs most of
the plan, not one step. Not measured: the Mac itself; play with fighting, conversations or explosions;
Firefox under the same pinning.

### What the worker kept by accident (2026-10-28)

The worker's families at depth 4 showed two parts of the level that play does not need:
* **The brush tracker's model as JavaScript.** `trackedModel()` (brush-tracker.mjs) builds a JavaScript copy of the tracker's
  arrays (every node with its plane, zone mask, zones and leaves, every vertex, point and vector), and `levelDecals` uploads it into
  the decal kernel once. The copy lived as long as the level. The handle `uploadDecalModel` returned held closures from the
  upload's own scope. Through that scope they held the `isMover` callback, and through it the copy (about 500,000 objects). The
  upload and the handle are now two functions (`writeDecalModel`, `decalModelHandle`), and the handle keeps only the kernel, the
  block's address, the point capacity and the surface records' word.
* **The BSP's triangle list.** Only the page's world build reads `map.triangles`. The worker decodes the map without it
  (`decodeMap(bytes, {triangles: false})`, about 110,000 objects on the Island).

The rest of what first appeared as "the decoded map" is the level itself (the BSP model's nodes, the actors, the decal store),
which play reads.

**Checks.** The state digests of bench-sim (300 ticks) are the same before and after on the Island (`15e3720088490242`), Training
(`148077479825af78`) and the 747 (`ad8e591a01434df5`). The five decal validators pass (`validate-decal-attach`, `-startup`,
`-order`, `-render`, `validate-decals-play`), and so do the 846 unit tests.

**Heap**, the Island's worker after 30 s of walking and forced GCs (`profile-live-heap.mjs`):

| | Objects | References | JS heap |
| --- | ---: | ---: | ---: |
| Before (master `cec0ee3c`) | 18.00 M | 91.4 M | 671 MB |
| After | 16.60 M (-7.8%) | 84.9 M (-7.1%) | 639 MB |

**Two cores**, the same 120 s roams. The worker's marking per major GC cycle (its incremental steps and the atomic pause) went
from about 428 to 408 ms on the Island (two runs each side) and from 378 to 358 ms in WanChai: about 5% less, in line with the
references removed. The pauses are within the run-to-run spread: on the Island 2 to 4 gaps over 100 ms and a longest of 250 or
300 ms (300 and 300 before); in WanChai a longest of 283 ms (350 before), 2 gaps over 100 ms both times. The worker's median
frame was 12.0 to 13.1 ms after against 13.2 to 14.7 before, which may be less marking competing for the two cores (indicative).
As expected, the pauses need the larger families removed: the load graph (step 7, about 11 M references) and the bytecode trees
(step 8, about 11 M).

**The bytecode nodes' package offsets.** `decodeScript` (bytecode.mjs) gave every expression `serializedOffset` and, after its
operands, `serializedEnd`: its byte range in the package, which nothing reads (the decoder keeps the start for its error message).
In the worker they were boxed numbers (376,000 each on the Island). Without them the worker holds 15.39 M objects (16.60 M), 80.7 M
references (84.9 M) and 625 MB (639 MB): 1.21 M fewer objects, more than the fields themselves, since the heap's boxed numbers
fell by 1.22 M. The state digests are the same on the Island, Training and the 747, and `validate-script-vm-interp` (539,583
checks against the JavaScript VM), `validate-script-process` and `validate-script-vm-x87` pass. Since this morning the worker has
lost 14.5% of its objects and 11.7% of its references.

## Step 7's results (2026-10-28)

**What the load graph held.** On the Island after a headless boot (bench-sim), the class loader's graph has 34,583 records with
819,951 native slots: 8 to 39 a record (two thirds 16 to 31), every one a `{value, width}` cell, widths 1, 2, 4, 8 or 16,
offsets under 0x1000. Its load edges are 176,836, from 34,487 records, at most 123 from one record. The browser's worker after a
map-list load and 30 s of play holds 69,172 records.

**The change.** Host representation only; the slots and edges hold the same values in the same order.
* A record's `nativeSlots` is a `NativeSlots` (`src/runtime/native-slots.mjs`): one array of pairs, the key (offset * 256 + width
  + 1, or offset * 256 with no width) then the value, in first-write order. A lookup scans the keys; past 64 slots (only test
  fixtures reach that) the store also indexes them. Its two writes are the cell's two: `set` replaces value and width (the Map's
  set of a new cell), `assign` keeps an existing slot's width (`cell.value = value`).
* The 22 files that read the Map directly now go through those methods. No cell escaped. Two adapters used the Map itself as their
  storage identity (the FArray view in `script-class-link.mjs`, the hash-table view in `script-state-link.mjs`); they use the
  store, which is still one object per record. `nativeClassSlot`'s accessors looked their cell up at each call, so reading the
  store instead sees the same value. Where a present slot holding no vtable stood as its cell in `script-property-copy.mjs`'s
  `?? raw` chain, the store stands instead, so that case still matches no kind.
* `loadEdges` is a `LoadEdges` (`src/runtime/script-load-edges.mjs`): each record taking part gets an ordinal (`loadOrdinal`, set
  in makeRecord), and the entries and edges are typed-array linked lists over ordinals. It keeps the Map of Sets' order (targets
  in first-added order, entries in first-edge order, a deleted entry re-added last) and lifetimes: a record is held (`records`,
  one reference) while it has an entry or an edge points to it, with a count per ordinal. Its three readers
  (`original-loaded.mjs` walk, the collection's demotion pass and its purge) use `forEachTarget`, `forEachFrom` and
  `deleteTargets`.

**Checks.** bench-sim's state digests (300 ticks) are unchanged on the Island (`15e3720088490242`), Training
(`148077479825af78`) and the 747 (`ad8e591a01434df5`). The class-graph validators pass (`validate-process-collection`,
`-original-loaded`, `-original-lookups`, `-script-process`, `-linker-imports`, `-linker-preload`), and so do
`validate-script-vm-interp` (539,583 checks), `validate-class-loader`, `-inventory-spawn`, `-object-layout` and
`-weapon-construction` (their fixtures moved to the store) and the 848 unit tests. Two of those are new
(`test/native-slots.test.mjs`): random operation sequences against the Map of cells and the Map of Sets they replace, comparing
every value, width, order and which records are held.

**Heap**, the Island's worker after 30 s of walking and forced GCs (`profile-live-heap.mjs`). This Chromium's snapshots record
integers (Smis) as nodes, so their edge count includes integer fields the collector does not follow; "pointer references"
leaves those out, and the snapshot's own strings for boxed numbers' values (an ad hoc count over the same snapshots).

| | Objects | References (snapshot edges) | Pointer references | JS heap (used of total) |
| --- | ---: | ---: | ---: | ---: |
| Before (master `2115380c`) | 15.39 M | 80.7 M | 66.07 M | 596 of 624 MB |
| After | 13.67 M (-11.2%) | 75.8 M (-6.1%) | 61.07 M (-7.6%) | 530 of 547 MB |

By kind: 1.63 M fewer plain objects (the cells, -6.5 M edges), 69,300 fewer Maps and 68,400 fewer Sets with their tables; 69,172
`NativeSlots` and their pair arrays came in. The plan's "about 11 M references" for the load graph was a first-reach family that
included the records themselves, which stay. Since this morning (`cec0ee3c`) the worker has lost 24% of its objects (18.00 to
13.67 M) and 17% of its snapshot references (91.4 to 75.8 M).

**Two cores**, two interleaved pairs of the same 120 s roams (`taskset -c 0,1`, Chromium worker mode). Both arms were served the
same way, by `.work/tools/serve-variant.mjs` through `hitch-run.mjs --url` (the base arm with `2115380c`'s copies of the 19
changed files), so no server ran on the pinned cores during play.

| | Worker major GCs | Marking per cycle (incremental steps + atomic pause) | Gaps over 100 ms | Longest gap |
| --- | ---: | ---: | ---: | ---: |
| Before | 2, 1 | 413, 398 ms | 4, 2 | 317, 400 ms |
| After | 2, 2 | 361, 343 ms | 4, 3 | 283, 400 ms |

The marking per cycle fell by about 13% (406 to 352 ms on average), between the fall in pointer references (7.6%) and in objects
(11%). The atomic pause shrank most (74 and 35 ms a cycle before, 35 and 28 after); the incremental steps went from 338 and 364
to 326 and 315 ms a cycle. The pauses stay within the run-to-run spread: the long gaps are still worker frames where incremental
steps and minor GCs pile up, in both arms. Against this morning's runs (about 428 ms at `cec0ee3c`), the marking per cycle on two
cores is about 18% shorter. Not measured: Firefox, the Mac, WanChai.

**Load time.** The headless Island boot (bench-sim, three interleaved pairs, the base arm through a node load hook serving the
same copies) took 6,615 to 6,743 ms against 6,781 to 6,890 ms before: no slower. Both arms gave the same 3-tick digest.

## Step 8's results (2026-10-28)

**What the bytecode trees held.** In the worker's snapshot after step 7 (the Island, 13.67 M objects), the script process holds
14,447 decoded bodies (functions and states): 610,024 expression nodes, 125,267 statement entries and 984 label entries. Each node
also has an out-of-line property array (611,008: `decodeScript` adds fields after the node's literal), and 176,485 boxed numbers
sit in the nodes. Two what-ifs over the snapshot (ad hoc, outside Git: the objects no longer reachable once a set of objects is
cut from the graph):
* cutting the trees and the operand maps frees 2.01 M objects, 9.4 M snapshot edges and 6.35 M pointer references (10.4% of the
  worker's 61.07 M);
* cutting only the index (the decoded records, their `statements` and `expressions` Maps) and the operand maps leaves 218,675
  nodes and statement entries reachable through other holders: the null-Context results (about 72,000, keyed by node), the Rust
  lowerings' `entries` and `nodes` (65,000, bodies that ran), the discarded-call Sets (38,000) and the JavaScript engines' node
  code (5,000).

Beside the trees, `compileFunction` built a JavaScript engine for every linked body, whether it ran or not: 260,344 closures (18
per body) in 14,756 contexts, with 1.56 M and 0.33 M pointer references. The step's earlier family figures (2.6 M objects) were
first-reach families that included identities reached through the operand maps; those stay.

**The change.** Host representation only: every body computes what it did.
* Nothing outside a body's tree keys on its nodes. The linked operands (`ScriptObjects.link`) are a Map from the expression's
  expanded offset to its identity, and the GC's operand write replaces that entry. The `names` Set is gone: a name operand is an
  expression or label entry with a `nameIndex`. The null-Context results are keyed by the value expression's offset, and their
  descriptors keep the property's and the Context's offsets instead of the nodes. The discarded native calls are a Set of offsets
  inside the tree. An offset names one expression in every decode of a body.
* A compiled body (`CompiledFunction`, script-vm.mjs) holds its tree only while it may run. `prepareFunction` and `prepareState`
  release it after the link, the null-Context results and the DynamicLoadObject prefetch, before the body can run. The first read
  of `decoded` (a lowering, the JavaScript engine, a state label check) decodes it again from the function's bytes and keeps it,
  with the same jump checks. The load-time scans that run no code use `readDecoded()`: the held tree, or a decode that is not
  kept. These are the spawn closure's class constants, LightSwitch's sounds and the player start's class operands. The spawn
  closure's scan now reads each body once: it walked every actor's class chain, which with released trees meant a decode per
  actor (about 3 s more boot), and a second scan of a body names only classes already seen.
* The JavaScript engine (the node closures, the statement loop, the reference engine) is built at the body's first run. A body
  whose engine was built keeps its tree, since the engine's code holds its nodes.
* Not done (the rest of step 8): releasing the trees of bodies that ran, about a tenth of them on the Island. Their Rust lowerings
  reach the nodes by index for every import (a call's name and arguments, a field's fallback, a JavaScript leaf), and so do their
  engines. Operands as handle arrays that the Rust VM reads are not done either.

**Checks.** bench-sim's state digests (300 ticks) are unchanged on the Island (`15e3720088490242`), Training (`148077479825af78`)
and the 747 (`ad8e591a01434df5`). On the Island and Training they are also unchanged under the interpreter's verify modes:
the JavaScript engine (`SCRIPT_VM=js`), its reference engine (`SCRIPT_VM_REFERENCE=1`), and Rust with `SCRIPT_VM_CHECK=1
STATE_VERIFY=1 RECEIVER_VERIFY=1`, with no errors. `DISPATCH_VERIFY=1` stops on a call-cache slot's probe word (stored 0, fresh
0xffffffff) at master `039d8857` as well: `callResolve` does not write that word. These pass: `validate-script-vm-interp`
(539,583 checks against the JavaScript VM), `-script-vm-x87`, `-script-process`, the class-graph validators
(`validate-process-collection`, `-original-loaded`, `-original-lookups`, `-linker-imports`, `-linker-preload`),
`-script-serialization` (the GC's operand walk), `-script-sound-admission`, the validators that compile bodies directly
(`validate-core-casts`, `-core-damage-primitives`, the ten `validate-native-*` operator validators, `-numeric-conversions`,
`-pawn-direction-reach`, `-pawn-nav`, `-script-struct-values`; the two x87 hardware validators skip without CrossOver) and the
848 unit tests. No Rust changed.

**Heap**, the Island's worker after 30 s of walking and forced GCs (`profile-live-heap.mjs`); pointer references as in step 7.

| | Objects | References (snapshot edges) | Pointer references | JS heap (used of total) |
| --- | ---: | ---: | ---: | ---: |
| Before (master `039d8857`) | 13.67 M | 75.8 M | 61.07 M | 530 of 547 MB |
| After | 11.83 M (-13.5%) | 66.0 M (-12.9%) | 53.70 M (-12.1%) | 468 of 484 MB |

After 30 s of play the worker holds 1,433 trees (14,447 before): 101,150 expression nodes and 19,005 statement entries, against
610,024 and 125,267. The engines' closures number 18,486 in 1,519 contexts (260,344 in 14,756). No expression node is held outside a
held tree. A first version that kept the property node in the null-Context descriptors still held 16,554 nodes of released bodies
that way. Since this morning (`cec0ee3c`) the worker has lost 34% of its objects (18.00 to 11.83 M) and 28% of its snapshot
references (91.4 to 66.0 M).

**Load time.** The headless Island boot (bench-sim, three interleaved pairs on a loaded host, the base arm through a node load hook
serving `039d8857`'s copies of the six changed files) took 14,576 to 15,398 ms in both arms; both gave the same 3-tick digest.
The Island's tick (bench-sim, 300 ticks, four interleaved pairs on a quiet host): medians 8.46 to 8.75 ms before, 8.62 to 8.78 ms
after, about 0.1 ms apart, within the spread.

**Two cores**, three interleaved pairs of the same 120 s roams (`taskset -c 0,1`, Chromium worker mode), both arms served by
`serve-variant.mjs` through `hitch-run.mjs --url` (the base arm with `039d8857`'s copies of the six changed files). Other
sessions' work (a headless Chromium and the original under Wine) loaded the host during the first two pairs; the third ran on a
quiet host. Each run had one major GC of the worker.

| Pair (host load) | Marking per cycle, base / new | Gaps over 100 ms | Longest gap | Longest worker frames at the cycle |
| --- | ---: | ---: | ---: | ---: |
| 1 (6 to 12) | 454 / 366 ms | 7 / 5 | 300 / 317 ms | 247 + 275 / 306 ms |
| 2 (10 to 14) | 432 / 318 ms | 4 / 1 | 317 / 300 ms | 311 + 269 / 286 ms |
| 3 (1 to 2.5) | 328 / 295 ms | 2 / 1 | 217 / 317 ms | 211 / 304 ms |

On the quiet host the marking per cycle fell by 10% (328 to 295 ms), in line with the 12% fewer pointer references; the loaded
pairs fell by 19 and 26%, within their noise. The longest frame did not shorten: each cycle still has one or two long worker frames
of 200 to 310 ms in both arms. What those frames are is below.

### The two-core long frame (2026-10-28)

**It is the major GC's marking on the worker thread.** Three records of the same runs agree once they share a clock:
* **The trace, in its own clock.** Each long worker frame is one `v8.callFunction` task on the worker thread. Inside it, the
  worker runs the cycle's incremental marking steps (`V8.GC_MC_INCREMENTAL`) back to back, and the second frame of a pair ends
  with the atomic pause (`V8.GC_MARK_COMPACTOR`). In step 8's quiet pair, the new arm's 304 ms frame holds 46 steps of 5 to 8 ms
  each, 255 ms in all; the base arm's frames of 211 and 169 ms hold 174 and 129 ms of marking (the second: 96 ms of steps and
  the 33 ms atomic pause). In step 8's six runs, 81 to 98% of the worker's marking per cycle (the table's column) lands in the
  cycle's one or two long frames. Over the same windows the helper threads' background marking runs
  0.4 to 0.9 s on the same two cores.
* **The worker's CPU profile** (the profiled run at `d746241a`, its clock joined through `__hitchSync`): the frames of 273 and
  255 ms hold 212 and 185 ms of `(garbage collector)`. The trace gives 212 and 190 ms of marking in the same two tasks.
* **The frame timeline**: the drawn-frame gaps of 217 to 317 ms are those frames.

In all ten two-core runs of steps 7 and 8 (13 cycles), every worker frame of 200 ms or more during play holds a cycle's
incremental steps or its atomic pause; those frames reach 370 ms.

**Why it looked otherwise.** `hitch-run.mjs` recorded each GC event's time as the page's `performance.now()` (`pageMs`). The
hitch log's rows count from the log's own start (`meta.originMs`, 1.2 to 2.4 s into the page in these runs), so comparing the two
put every GC event 1.2 to 2.4 s late. The ad hoc gap tool (`.work/hitch/gc-2026-10-28/gc-gaps.mjs`) made that comparison, and so
did the analysis above until this check; its older sibling `.work/hitch/gc-align.mjs` subtracted the origin. `hitch-run.mjs` now
also writes `logMs`, the event's time in the log's clock, and gc-gaps.mjs uses it.

**What it says.** Steps 7 and 8 shortened the marking, and the worker's share of it with it: in the quiet pair, 380 ms over two
frames became 304 ms in one. The longest frame is the part of that share that lands in one frame, so it moves only when the share
falls well below 300 ms, or when the marking spreads over more frames. Less allocation per sim frame does not spread it (next
section).

### Allocation and the long frame (2026-10-28)

**The question.** V8's incremental marking takes its steps as the program allocates, and in the long frame they run back to back.
Would a worker that allocates less per sim frame spread its marking over more frames, and so shorten the longest one?

**What the worker allocates.** From the scavenges' heap sizes in the two-core traces, the worker allocates 157 to 177 MB a second
on the Island, about 3 MB a sim frame. The sampling heap profiler (`hitch-run.mjs --heap-sampling all`, a 60 s roam with all
cores, load included) samples 11.2 GB, 16% of it in one function: `decode` in bsp-occlusion.mjs. Each frame it turned OccludeBsp's
output into an object per draw entry and per polygon, and the child requests' span lines into arrays, for a caller
(sim-session.mjs `visibility`) that reads only each entry's surface and zone, its polygons' nodes, and the child requests' kind
and node.

**The cut.** Host representation only. `occlusion.run(..., {flatDraw: true})` decodes the draw lists as two arrays per list (each
entry's iSurf, iZone and polygon count, and the polygons' nodes, in the list's order) and steps over the child requests' lines;
`drawnOf` reads them in the same order as before. The same 60 s roam samples 8.4 GB, `decode` 46 MB instead of 1,763 MB.
`validate-occlusion-flat-draw` decodes each output of 192 views on four maps (the Island, Training, WanChai Underworld's mirrored
dance floor, Paris Club's mirrors) both ways: the entries, polygon nodes, child requests, sprites, screens, counters, streams and
child frames are the same (7,376 entries, 12,497 polygons, 55 child frames; a mutant miscounting one entry's polygons is caught).
`decodeLast()` gives it the second decode of the same words, since a second OccludeBsp run of a view can differ. These pass too:
`validate-bsp-occlusion`, `-child-frames` (against the original under Unicorn), the Play validators that read the visibility
result (`validate-underworld-panes-play`, `-sprite-tiles-mirror-play`, `-iterator-frames-play`, `-live-visibility-play`,
`-decal-vertices-play`, `-frame-projection-play`), the 848 unit tests, and the Island's state digest (`15e3720088490242`, unchanged; a headless frame
runs no occlusion). Two do not pass, as without the cut: `validate-master-frame-play` times out on this host (known), and
`validate-mover-light-maps-play` stops at 09_NYC_ShipFan, whose fan's light-map header Rotation does not change. That one fails
the same with the cut's two files, step 8's six files or 12e292ee's script change served from before (its Rust change is comments
only): a regression from elsewhere, not bisected (the validator came with `b7ecd2e0`). Found after (2026-10-29): not a
regression, the check's placement raced the fan's turn and left the fan out of view in about half of the runs; it now stands the
player at a fixed place ([static lighting](static-lighting.md), the `validate-mover-light-maps-play` notes).

**Two cores**, three interleaved pairs of the 120 s Island roams (`taskset -c 0,1`, both arms through `serve-variant.mjs`, the
base arm with `4ba63772`'s bsp-occlusion.mjs and sim-session.mjs), on a quiet host (load 1 to 3.6). From the traces, per major GC
cycle of the worker:

| Pair | Worker allocation, base / new | Marking per cycle | Most marking in one frame | Longest frame of the cycle | Gaps over 100 ms | Longest gap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 160 / 124 MB/s | 386 / 299, 301 ms | 195 / 167, 177 ms | 234 / 198, 207 ms | 2 / 4 | 233 / 200 ms |
| 2 | 177 / 149 MB/s | 320 / 324 ms | 245 / 188 ms | 283 / 224 ms | 1 / 2 | 300 / 233 ms |
| 3 | 157 / 123 MB/s | 159, 312 / 310, 313 ms | 104, 233 / 172, 205 ms | 187, 255 / 202, 236 ms | 4 / 4 | 267 / 250 ms |

**What it says.** Less allocation did not spread the marking. In every cycle of both arms the marking lands in two consecutive
frames, 340 to 440 ms from its start to the atomic pause. The first frame after the start takes steps back to back in proportion
to what it allocates (41 steps and 233 ms in a base cycle, 34 steps and 188 ms in a new one, near the 20% less allocation); the
second finishes the marking and runs the atomic pause. What the first frame no longer does moves into the second. The longest
frame of a cycle fell from 234 to 283 ms to 198 to 236 ms (means 257 and 213 ms, 17% less), but the gaps over 100 ms did not
fall (7 against 10), and the worker's median frame is the same (12.5 to 14.7 ms in both arms). The cycle's length follows how
fast the marking completes, not the allocation: in those 0.35 s the helper threads run about 0.9 s of background marking on the
same two cores. An inference, not measured: at best the worker's share splits evenly over the two frames, so the longest frame
stays above half of it (about 150 ms here). Under 100 ms then needs the worker's share of a cycle under about 200 ms, which is
the plan's heap reduction, or a longer cycle, which V8 decides. (2026-10-29: true only near today's allocation; V8's own log and
a synthetic sweep show that the frame's allocation sets its length, next section.)

## Allocation sets the long frame (2026-10-29)

V8's own log of the marking (`hitch-run.mjs --js-flags '--trace-gc --trace-incremental-marking'` under `DEBUG=pw:browser`,
read by `scripts/gc-marking-cycles.mjs`) shows what fills the long frame, and a synthetic worker shows how it scales.

**What V8 does.** On the two-core Island roam (master `0dbb253e`, 120 s), the worker's cycle starts from a task with the old
generation at 1,109 MB against a 1,301 MB limit. Its schedule expects the whole estimated live heap, 1,137 MB, marked in 500 ms
(each step's "expected marked" is that heap times the elapsed time over 500 ms). The helper threads fall behind at once, so each
main-thread step tries to make up the difference and runs to its 5 ms cap. The steps come from two places:
* the allocation observer (`origin: V8`), about one step per 64 KB the worker allocates;
* the marking job's tasks (1 ms each), which run between the worker's frames.

That cycle took 48 allocation steps (255 ms) and 4 task steps (6 ms). 25 steps (134 ms) fell in a 157 ms frame, and 22 (116 ms)
in the next, 177 ms with the 29 ms atomic pause; a frame without marking takes about 13 ms. The long part of a frame is its own
allocation, turned into 5 ms steps.

**Synthetic.** `scripts/gc-allocation-synth.mjs`: a dedicated worker holding 12 M four-reference objects, its old generation
about 1 GB at a cycle's start as the worker's, with 10 ms of work a frame at 60 Hz and 200 KB kept a frame (the worker promotes
120 to 320). Two cores, 120 s at each level:

| Allocated a frame | Allocation steps in a cycle's frames | Longest frame | Frames over 100 ms | Frames over 50 ms | Cycles |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 2.7 MB | 31 to 39 | 229 ms | 2 | 2 | 1 |
| 1.4 MB | 19 to 20 | 128 ms | 4 | 4 | 2 |
| 0.8 MB | 10 to 11 | 78 ms | 0 | 6 | 1 |
| 0.5 MB | 5 to 6 | 49 ms | 0 | 0 | 4 |

A cycle lasts 320 to 440 ms at every level, and the main thread's steps per cycle (210 to 380 ms) barely fall. Less
allocation spreads the same marking over more, shorter frames, at about one step per 70 KB.

**What it changes.** The heap's size sets how long a cycle runs and how much marking it needs; it does not set the length of a
frame inside the cycle. The longest frame is that frame's allocation in 5 ms steps until the marking completes. That is why steps
7 and 8 shortened the marking per cycle without shortening the longest frame, and why 20% less allocation ("Allocation and the
long frame") moved work between the two frames: 34 steps a frame instead of 41 is still far above the threshold. An inference
from the synthetic, not measured on the worker: on two cores, no frame over 100 ms needs the worker under about 0.8 MB a frame,
and none over 50 ms under about 0.5 MB. The synthetic's page draws nothing, while the real page and GPU process share the two
cores, so a real cycle may span more frames.

**Where the worker allocates.** `hitch-run.mjs --heap-sampling all`, a 60 s Island roam (not pinned): 8,391 MB sampled over the
3,799 worker frames the page drew, about 2.2 MB a frame.
* By the frame's steps (sim-session.mjs): the tick (`begin`) 893 KB, the HUD 698, actors 378, coronas 147, the rest under 60
  each.
* By subsystem (the 150 largest leaf functions, 1,955 of 2,262 KB):

| Subsystem | KB a frame |
| --- | ---: |
| The x87 model's BigInt intermediates (`x87mul`, `x87add`, `x87storeWord`, ...) | 298 |
| HUD and window drawing (`script-gc-*`, the window host) | 254 |
| The script VM's other paths (frames, locals, the Rust VM's resume, locomotion tables) | 213 |
| Builtins (Map and Set, arrays, iterators) | 205 |
| Actor mesh frames (`actor-mesh-sim.mjs`, `lodmesh-frame.mjs`) | 157 |
| Occlusion, coronas, sprites, lights, lasers | 134 |
| Collision and line checks | 122 |
| Actor and level ticks | 115 |
| Object image reads (`readComposite`) | 91 |
| Others among the 150 | 367 |

Reaching 0.8 MB a frame is a cut of about 2.8×, and 0.5 MB about 4.5×, spread over a dozen subsystems, none more than 13% of
the total. The heap plan's remaining steps would shorten the cycle, not the frames inside it.

### Cut: x87 math in Rust (2026-10-29)

The first row of that table, the x87 model's BigInt intermediates, is gone from the worker's frame except the HUD's. Host
representation only: what the simulation computes is bit-identical.
* **Galaxy's Update** (`galaxy-audio.mjs`, 136 to 152 KB a frame of the 232 to 252) now computes PlaySound's priority and channel
  choice, the ambient scan's and refresh's values, each channel's priority, listener-space location, pan, occlusion ramp, voice
  volume, Doppler shift and frequency, and the reverb tail on `Ext` in `native/script-vm/src/galaxy.rs`, through
  `galaxy-update-kernel.mjs` (one block of float32 words in the kernel instance's memory; nothing allocated per call). The world
  reads, the channel records and the services stay JavaScript, and FPATAN stays the host's `atan2` between the two halves of a
  channel's step (docs/galaxy-audio.md "Update in Rust"). The BigInt body is the reference: `createGalaxyAudio(..., {kernel: null})`.
* **Four smaller callers** (`native/script-vm/src/callers.rs`): `interpolationVelocity` (actor-physics.mjs, every PHYS_MovingBrush
  mover's tick), `fcoordsAxes` (script-pawn-locomotion.mjs, the `dot3` behind it; percep.rs already had its Rust form), `losWorker`'s
  sums and products (`magsq3`, the squared scaled visibility, the FOV path's Stimulus and distance) and the rider pass of
  `moveActorRiders` (move-riders.mjs `add32`, `dot3`). None was the fallback of an existing Rust lowering: percep.rs lowers
  AICanSee and the alliance natives, not `losWorker`, and the rider pass reaches JavaScript through `js_move_riders`. Each
  JavaScript function stays as the reference (`interpolationVelocityReference`, `fcoordsAxesReference`, `losReference`,
  `riderRotMotionReference`).
* **Left alone, the HUD step's**: `script-window-computer-playback.mjs` and `script-window-scene-frame.mjs` (about 27 KB a frame
  now). Also still on the BigInt model, outside the list: `glideAcceleration` and `turnSetup980` in script-pawn-locomotion.mjs (the
  TurnTo exec's JavaScript path, 3 KB in one of the runs) and the music section.

**Measured**: the same `hitch-run.mjs --heap-sampling all` 60 s Island roam as above (Chromium, worker mode, `--mode roam`), two
runs each side. The "before" runs were served from an export of `0d9c5fd6`, the "after" from this branch, each by its own dev
server. KB a worker frame (the hitch log's frame count: 4,571 to 4,703), the x87 rows being the 150 largest leaf functions (0.0 is
outside them):

| | before | before 2 | after | after 2 |
| --- | ---: | ---: | ---: | ---: |
| `x87mul` | 60.3 | 56.4 | 7.6 | 9.1 |
| `x87add` | 53.7 | 48.2 | 5.5 | 7.2 |
| `x87storeWord` | 50.8 | 47.9 | 13.2 | 15.8 |
| `x87loadWord` | 28.0 | 27.3 | 7.7 | 11.4 |
| `x87div` | 19.4 | 18.0 | 0.0 | 0.0 |
| `x87sqrt` | 16.8 | 15.0 | 0.0 | 0.0 |
| `x87load` | 13.5 | 10.7 | 5.3 | 4.5 |
| smaller ones (`x87storeDouble`, `x87cmp`, `x87ftol`) | 9.2 | 8.6 | 0.0 | 0.0 |
| **x87 functions** | **251.8** | **232.0** | **39.2** | **48.0** |
| **whole worker** | **1,855.5** | **1,746.7** | **1,535.1** | **1,690.9** |
| whole worker, a drawn frame (3,370 to 3,810) | 2,281 | 2,220 | 1,928 | 2,294 |

By the file of the first caller outside the x87 code (KB a worker frame, the 400 largest sites): `galaxy-audio.mjs` 152.1 and 136.2
before, 0 after; `actor-physics.mjs` 10.6 and 10.9, 0; `script-pawn-perception.mjs` 9.1 and 17.5, 0; `script-pawn-locomotion.mjs` 6.6
and 4.0, 0 and 3.4; `move-riders.mjs` 2.2 and 1.2, 0; the window files 26.3 and 22.7, 24.9 and 22.0. `galaxy-audio.mjs`'s own
allocation (the `map` calls and closures around the x87 calls) went from 18.3 KB a frame to none.

The x87 functions fell by 184 to 213 KB a worker frame (a 79 to 84% cut; per drawn frame, from 310 and 295 to 49 and 65), which
is the whole worker's cut once the two runs on a side are averaged (1,801 before, 1,613 after: -188 KB, -10%). Each side's two
runs differ by 6 to 9% from each other (the HUD step alone ranged 368 to 585 KB), so one pair of totals cannot show a 10%
change, and the x87 rows are the measure. The worker still allocates about 1.6 MB a worker frame (2.1 to 2.3 MB a drawn frame,
the unit of the table above): twice the 0.8 MB that the synthetic put under 100 ms for the longest frame, so this cut is about a
quarter of the way and the next sources are the ones in the table above (the HUD step, the script VM's other paths, builtins,
mesh frames). The two-core trace is the coordinator's.

**Checks.** bench-sim's state digests (300 ticks) are unchanged on the Island (`15e3720088490242`), Training
(`148077479825af78`) and the 747 (`ad8e591a01434df5`). The Rust bodies equal the BigInt ones as float32 words:
`validate-galaxy-audio-kernel` (3,330 cases, 33,908 operations and 10,361 voice calls of the oracle cases, those with a speaking
lip-sync pawn and a seeded sweep of extremes; 4,000 reverb zones; 20,008 range checks; 0 mismatches) and
`validate-x87-callers-kernel` (600,000 comparisons). The original: `validate-native-galaxy-audio` (165 cases against Galaxy.dll in
Unicorn, on the Rust path and on the reference), `validate-galaxy-music-update` (the reverb tail and the music section),
`validate-galaxy-reverb`, `validate-galaxy-effects`, `validate-galaxy-effects-play` (three maps, asserting the kernel is in use),
`validate-island-lipsync` and `validate-script-vm-x87` pass; so do the validators of the other files changed
(`validate-actor-physics-kernel`, `-locomotion-kernel`, `-native-actor-physics`, `-perception-kernel`, `-pawn-tick-visibility`,
`-native-set-rotation-riders`, `-native-mover-push`; `-pawn-perception` and `-pawn-locomotion` skip without CrossOver) and the
move-riders and ambient-range unit tests. `cargo build` has no warnings. The two "after" runs and a first one that was served
stale modules (the dev server was started with its file watcher off before the edits and had to be restarted; that run is not
used) ended with no errors.

**Pitfall for the measurements.** `hitch-run.mjs` listens for the browser's debugging port on `--cdp-port` (9336 by default),
and a second run at the same time found the other run's browser at `127.0.0.1:9336`: it attached to that run's worker and never
saw its own end. Give concurrent runs their own `--cdp-port`.

### Cut: HUD step (2026-10-29)

The `hud` step of sim-session.mjs allocated 698 KB of the worker's 2.2 MB a frame, the largest single step after the tick. Host
representation only: every change below leaves the HUD's commands as they were, and the per-frame hashes say so.

**Where the step's bytes were.** `hitch-run.mjs --heap-sampling` now keeps a step x leaf and step x 5-frame-site breakdown (`byStep`
in `<out>.heap.json`, `--heap-steps N`) and splits each step by whether it ran inside Galaxy's Update (`game.mjs` runs it inside
the HUD draw, `script-audio-live.mjs` `update`). In the browser's Island roam the step is about 580 KB, of which Galaxy's Update is
240 to 250: the x87 BigInt values of `galaxy-audio.mjs`'s `updateLocked` and `fastLineCheck`, not HUD drawing, and not part of this
cut. The other 330 to 340 KB were:
* `gcMemory` (every GC native took an object with six closures; a DrawText runs about ten of them);
* UGC::DrawText per character. The InfoLink and conversation text is a computer window drawn one character at a time
  (`computerDrawBuffer`), each a full DrawText: a code-unit array, an emit state and a scan state (each given a DataView, which makes
  the typed array's storage an ArrayBuffer), scanLine's three copies, cursors, pen cells, a glyph record per lookup, a
  `[0,1,2,3].map` colour and a frozen emit block with two copied arrays per glyph, and four x87 values for the cell coordinates;
* the tile commands: an object in the window host's `callVirtual`, a copy of the list, and a second object with a new texture
  object in `plainHudCommands`, each number a boxed double;
* the Rust GC natives' DrawTile (`js_gc_tile`: an array, an object of fields, a frozen command), `dispatchGcNative`, the window scene
  frame (36 BigInt dot products a frame), and a `Run` for each script body JavaScript began (about 200 a frame).

**The cut**, in the order it was made (each step's hashes below):
1. `gcMemory` returns one cached read/write pair per (services, address): a class's methods, and the heap service re-read and
   compared at each call. `gcIntersect` and `gcCopyGC` lose their array literals.
2. UGC::DrawText and the computer window's draw: shared unit buffer, emit/scan states, cursors, cells, glyph and extent records
   (module scratch, zeroed or set at the start of each call; a DrawText runs no other), one DataView per state array, one frozen
   colour array shared while the four words stay, and, for the window host's `callVirtual`, which reads a glyph's emit block at the
   call and keeps none of it (`services.transientPayloads`), one block rewritten per glyph. A host without the flag, and the
   validators' services, still get a frozen block per glyph. The computer window's cell coordinates are `cellBits`
   (`Math.fround` of the int32 = `f32Bits(S(I(v)))`: fild is exact, fstp rounds once) and its fade tests compare f32s with zero
   directly (`gt(X(a),X(0))` is `a > 0`, NaN unordered both ways).
3. The tile commands are built once, in the form the page takes (`game.hud.commands(w, h, view, plain)`), the texture one cached
   plain object per reference (`script-window-plain-texture.mjs`), the colour the previous command's frozen array while its words
   stay.
4. `js_gc_tile` reads the arena words into one reused DrawTile block (same flag); `dispatchGcNative` and the text and button
   draws drop their closures, `{length}` objects and array spreads.
5. `buildWindowSceneFrame` keeps the last rotation's rows and the last (FOV, precision control, size)'s tangent, projectionZ and
   centre; they are functions of those inputs alone.
6. `RustScriptVm.acquire` reuses one `Run` per depth for the bodies JavaScript begins (`release()` on return clears it); `scanLine`
   and `gcGetFontHeight` read glyphs into a record of their own.
7. The tile commands cross as numbers: `HudCommandStream` (`script-window-command-stream.mjs`) writes twelve doubles a command into
   a reused Float64Array, the texture and colour as indices into the frame's short tables, the viewport, actor and clearZ commands as
   objects in place among them; `hud({stream: true})` and `frame()` post `snapshot.hud.stream` (exact-length copies), and
   `main.mjs` `drawFrame` expands it with `expandHudStream` into the list the HUD renderer took before, key for key. The inline mode
   goes through the same `frame()`.

**Measured.**
* Exact, headless (`scripts/hud-stream-digest.mjs --alloc`: V8's new-space size around each `session.hud()` call, calls with a
  scavenge left out, `--min-semi-space-size=64`; Island roam of 1500 frames, a fixed forward/turn/jump schedule that meets a
  conversation, so about half of the frames draw text), KB a frame:

| | Whole `hud()` | Galaxy's Update inside it | The rest | The rest, text-free (p10) | The rest, median | p90 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Before (0d9c5fd6) | 1750.8 | 474.6 | 1276.2 | 190.0 | 781.5 | 2724.0 |
| After | 660.6 | 445.7 | 214.9 | 50.2 | 226.5 | 372.9 |

  (Galaxy's share differs by 29 KB between the two runs because it moved with a sound the roam reached; it is not touched here.)
* Browser, sampling heap profiler (`hitch-run.mjs --heap-sampling all --seconds 60 --mode roam --cdp-port 9352`; two interleaved
  pairs, the base arm the tree of 0d9c5fd6 with this branch's hitch-run.mjs; the profile's `frames` count, KB a worker frame):

| Run | Worker, all steps | `hud` step | of it Galaxy's Update | `hud` without it | `begin` (the tick) |
| --- | ---: | ---: | ---: | ---: | ---: |
| base 1 | 1857.9 | 588.1 | 245.8 | 342.2 | 721.0 |
| new 1 | 1601.1 | 314.6 | 227.8 | 86.8 | 729.3 |
| base 2 | 2200.4 | 573.1 | 241.3 | 331.8 | 1035.3 |
| new 2 | 2059.2 | 360.5 | 279.9 | 80.6 | 1095.4 |

  The HUD step went from 580 to 337 KB a frame (-243), and without Galaxy's Update from 337 to 84 (-75%). The worker's total fell by
  257 and 141 KB in the two pairs (14% and 6%): the tick's 720 to 1095 KB varies from run to run by more than that on either arm, since the roam
  is not pinned and meets different NPCs, so the totals are not a clean comparison; the step is. (An earlier run of each arm,
  before the harness got its own CDP port, is not used: another heap sampler may have attached to that browser.)

**Checks.**
* The HUD commands per frame, hashed by exact number bits and key order (`hud-stream-digest.mjs`, `--compare` against the build
  before): identical for the Island over 3000 frames (the posted stream form, expanded as the page expands it) and 1500 frames
  (objects, the stream, `GC_NATIVE=verify`, 600 frames also `GC_NATIVE=js` and `SCRIPT_VM=js`), Training over 1200 (the stream,
  `GC_NATIVE=verify`), the 747 over 900 and UNATCO HQ over 900 (the stream).
* validate-play-hud; all 53 validate-gc-* (draw-text, -box, -borders, -icon, -texture, -stretched-texture, -pattern, -actor,
  -actor-host and -actor-play among them; validate-gc-draw-text also replays its Unicorn cases with the transient block, and
  the mutants of validate-gc-copy-gc and -get-text-extent that matched the changed lines were moved to the new text); validate-gc-get-text-extent;
  validate-window-native-diff; validate-window-computer-playback (now also `cellBits` against `f32Bits(S(I(v)))` over 300,000
  int32); validate-window-scene-frame (real x87 through wine: `X87_PROBE_WINE=/usr/bin/wine WINEPREFIX=~/.wine-deusex`, bit-exact
  at both precision controls, and the kept rows and size values checked against other inputs in between);
  validate-instructor-conversation, -text-layout-diff, -hitch-log, validate-script-vm-interp, -script-vm-x87, -script-process.
* bench-sim, 300 ticks (`--bypass --continue --render-feedback --warm 60`, `SCRIPT_VM_CHECK=1`) on the Island, Training and the 747:
  digests `5adb254a07b1ed6f`, `07816ec472f29b84`, `48d8f27e772e5c70`, the same as the build before on each, no errors (the Island and
  Training also under `STATE_VERIFY=1 RECEIVER_VERIFY=1`). Unit tests: 850, 846 pass, 4 skipped, among them
  `test/window-command-stream.test.mjs`.
* Play: a 25 s worker-mode Island walk with a screenshot (`hitch-run.mjs --screenshot`) draws the conversation's subtitle from the
  stream, no errors; the four 60 s runs above ran with no errors.

**What is left, and why.**
* Galaxy's Update, 230 to 280 KB, is now 70% or more of the step. It is `galaxy-audio.mjs` and the x87 BigInt model, and was
  left to the x87 cut.
* The step's own 80 to 90 KB (50 KB in a text-free frame of the headless run): the frame objects of the window scripts' bodies
  (a frame object with its `resume` closure and iterator array, a `FrameLocals`: about 200 bodies a frame, shared VM code), the
  object-image reads (`readComposite`) and boxed doubles the script values and `gcMemory.read` return, `drawRawBackground`'s clip list
  and the window projection's x87 values.
* A Rust port of DrawText was not made: after this cut the JavaScript draw allocates nothing beyond the command it writes, so a
  port would save CPU, not allocation. gc.rs still covers only SetStyle, SetTileColor, SetTextColor, SetFont, SetAlignments,
  EnableWordWrap, DrawTexture and DrawPattern, plus PushGC and PopGC; its CPU worth is unmeasured.

### Both cuts on two cores (2026-10-29)

Master `2d041a9a` (the two cuts above merged) against `0d9c5fd6`.

**Allocation.** The same 60 s Island roam (`hitch-run.mjs --heap-sampling all`, Chromium worker mode, not pinned): 1,413 KB a
worker frame, 1,699 KB a drawn frame (4,664 and 3,879 frames), against about 2.2 MB a drawn frame before. By step, KB a drawn
frame against the table in "Where the worker allocates": the tick (`begin`) 863 (893), actors 376 (378), the HUD 165 (698),
coronas 149 (147). The tick is now half of what is left; its largest leaves are object-image reads (`readComposite`), Map and Set
operations, the actor tick kernel's `run`, the actor mesh layer's `update`, `tickStandaloneLevel` and collision-hash vectors.

**Two cores.** `taskset -c 0,1`, a 150 s Island roam each (`hitch-run.mjs --trace --js-flags '--trace-gc
--trace-incremental-marking'`, read by `gc-marking-cycles.mjs`), each tree served by its own dev server, run in the order new,
new, base, base, new (the first two base runs found their server refusing `.work/`, so they were run again). The two longest frames
of each complete major GC cycle of the worker, with the incremental steps on allocation inside each:

| | Cycle | Longest frame | Second |
| --- | --- | --- | --- |
| base 1 | 88.5 s | 226 ms (34 steps) | 144 ms (12) |
| base 2 | 77.1 s | 183 ms (26) | 176 ms (20) |
| base 2 | 121.3 s | 280 ms (39) | 83 ms (2) |
| new 1 | 75.7 s | 168 ms (17) | 141 ms (20) |
| new 1 | 107.4 s | 229 ms (24) | 153 ms (21) |
| new 2 | 78.6 s | 195 ms (19) | 179 ms (24) |
| new 2 | 160.8 s | 205 ms (23) | 135 ms (20) |
| new 3 | 49.5 s | 173 ms (26) | 135 ms (20) |
| new 3 | 106.1 s | 189 ms (23) | 133 ms (21) |

A cycle's main-thread work is unchanged (40 to 48 steps on allocation, 221 to 261 ms; atomic pause 24 to 35 ms; 300 to 347 ms
long). What moved is how it splits: at most 26 steps in a frame instead of 26 to 39, and a cycle's longest frame 193 ms on average
instead of 230. Every cycle still has two frames over 100 ms, as the synthetic puts it at 1.4 MB a frame ("Allocation sets the
long frame"). The cycles did not become rarer in these runs (one or two in each 150 s on both sides). Three base cycles and six
new ones: the averages are indicative, not a measured effect size.

### Cut: promoted garbage (2026-10-29)

The worker promoted 133 KB a worker frame on the Island roam (9.7 MB/s), 40% of it from `readComposite`. Almost none of it was
kept by anything.

**What the old generation grows by.** `--trace-gc-nvp` on the worker (`hitch-run.mjs --js-flags '--trace-gc-nvp'`, the slope of
`end_object_size` over the scavenges between two major GCs): 13.4 MB/s in the first minute, while the scavenger's own `promoted`
was 3.8 MB/s. A second master run, after its warm-up (25 to 80 s), grew 8.6 MB/s with a major GC at 79.9 s. The rest was allocated
in old space directly. The same roam under `--no-allocation-site-pretenuring` grew 3.6 MB/s and promoted 34 KB a worker frame
instead of 133, and everything that vanished is the list of sources below: `readComposite`, the script VM's `run`/`createFrame`/
`createFrameLocals`, the `update` record of actor-mesh-sim.mjs.

**Four causes, none a long-lived reference.**
* **A site decided "tenure" by the map load.** `--trace-pretenuring` prints each decision of an allocation site (an array or object
  literal, an `Array(n)`): "undecided", then "tenure" when at least 100 of its objects were counted in a scavenge and 80% were
  alive, "don't tenure" when they were counted and fewer were. In a session's log no site ever left "tenure" or "don't tenure"
  (545 and 47 repeated decisions, none a change), so the first window decides for good. The first windows of a worker are its map
  load, which keeps what it reads and builds, so the sites it shares with the frame loop were all decided "tenure" there: every
  vector, struct and script frame made through them since is born in old space and dies there.
  `src/runtime/allocation-site-warmup.mjs` runs a registered warmer for each such site on fabricated values before the first
  map is read (the worker's `init`, the inline host's `createSimHost`) and allocates garbage until a scavenge counts them, so
  the first window has no survivors and the decision is "don't tenure". Warmers: `readComposite`'s vector, rotator, struct,
  fixed-array and array reads (script-object-image.mjs), the script frame (script-vm.mjs `newFrame`) and the record of an actor
  mesh update (actor-mesh-sim.mjs `newUpdateRecord`, three lines in that file). A site the frame loop shares with the load and
  that nothing warms can still be decided "tenure"; `promotion-probe.mjs --sites` against the same run under
  `--no-allocation-site-pretenuring` names it.
* **A frame keeps a result until the frame ends.** The actors step keeps each binding's record until the snapshot is posted, so a
  scavenge inside the step finds them alive and decides their literal "tenure" (6 KB a worker frame in two of three runs, 1 in the
  third) unless a warmer got there first.
* **A function literal that is the right side of a property assignment is allocated in old space.** In the interpreter and in
  optimized code alike (a probe of 3,000 calls each with `%InYoungGeneration`): `o.a = () => x` 0 young, `const f = () => x;
  o.a = f` 3,000 young, `{a: () => x}`, `return () => x` and `push(() => x)` 3,000 young. The script frame's
  `frame.resume = () => engine.resumeCompiled(frame)` was that, one closure and context per script call, about 60 KB a worker
  frame in the headless roam. `resume` is now one shared function over `this` (script-vm.mjs `resumeFrame`).
* **A Set or Map in old space allocates its tables in old space.** Every table it clears or grows into: an old Set of 40 items
  refilled 20,000 times grows old space 0.42 KB a fill after `clear()` and 0.00 after `set = new Set()`. actor-weapon-sim.mjs
  `live` and the HUD command stream's `textureAt`/`colorAt` were cleared each frame; they are new collections now.

Two more cuts of real survivors:
* **A light record outlives its frame.** A setup keeps the lights it chose after the frame (actor-mesh-sim.mjs `lastSetup`), so a
  record lives as long as its actor stays out of view, and a Map made for each light was most of it. The fields now sit in fifteen
  slots of the values object, read through prototype accessors (`UNREAD` marks a slot nobody read, as the Map's `has` did), and the
  record is a class with a `flickerKey` getter instead of a `defineProperty` closure. The leaf light lists' handles are made once per
  list. mesh-lighting-view.mjs.
* **The level membership was rebuilt for every `actorsEpoch` advance.** 11 advances in 1,500 Island ticks, 6 of which changed the
  slots, all by appending: the kept Map and Set take the new tail when the slots seen last are all unchanged (a rebuild made about
  300 KB of tables, all promoted). A changed slot still rebuilds. `animationView` (script-anim.mjs), made for every `IsAnimating`
  poll and `PlayAnim` as an object of twenty accessors and closures, is a class.

**Measured.** Chromium, worker mode, a 60 s Island roam each (`hitch-run.mjs --mode roam`), KB a worker frame. The "before" runs
are master `314d6501` (exported to its own tree), the "after" this branch.

| `--heap-sampling promoted` | before | after | after 2 |
| --- | ---: | ---: | ---: |
| worker frames | 4,548 | 4,733 | 4,749 |
| **promoted, total** | **133.1** | **27.6** | **28.7** |
| `readComposite` | 53.0 | 0.2 | 0.2 |
| script VM `run` + `createFrame` + `createFrameLocals` | 28.9 | 0.1 | 0.1 |
| `set` (Map) | 9.2 | 3.2 | 4.1 |
| `update` (actor-mesh-sim.mjs) | 6.4 | 1.0 | 1.3 |
| `lightRecord` | 5.7 | 2.4 | 2.4 |
| `add` (Set) | 2.1 | 0.5 | 0.6 |
| `frameContext` (lodmesh-frame.mjs) | 1.3 | 1.3 | 1.7 |
| `animationView` | 0.9 | 0.0 | 0.0 |
| step `begin` (the tick) | 59.1 | 9.2 | 9.5 |
| step `actors` | 32.1 | 9.8 | 11.9 |
| step `hud` | 16.2 | 1.8 | 1.4 |
| step `lightFrame` | 12.3 | 4.9 | 4.5 |
| step `sprites` / `coronas` | 7.3 / 4.8 | 0.1 / 0.6 | 0.0 / 0.4 |

The target was 25. The same tree under `--no-allocation-site-pretenuring` promotes 30.2 KB, so what is left is real survival, not
pretenuring: `set` from `reconcile` (actor-mesh-sim.mjs, 1.4 to 1.5: it rebuilds a Set, a list and two Maps of the 2,620 actors at
every `actorsEpoch` advance, the same pattern as the membership above), `lightRecord` (2.2 real: records live about as long as a
scavenge interval, the holder is not found), `frameContext` and the `update` plan objects (1.3 to 1.7 each), `runActorRolling`
(1.0: nine accessors and eight closures made for each rolling decoration's tick), and a tail under 1 KB each in sim-session.mjs,
script-runtime.mjs and the window host.

| old generation, `--trace-gc-nvp` | master | this branch |
| --- | ---: | ---: |
| heap growth, first minute (12 to 44 s / 12 to 58 s) | 13.4 MB/s | 3.5 MB/s |
| heap growth after warm-up (25 to 80 s / 25 to 93 s) | 8.6 MB/s, a major GC at 79.9 s | 1.6 MB/s, none in 93 s |
| promoted by the scavenger | 3.8 / 2.2 MB/s | 1.6 / 1.0 MB/s |

Total allocation is unchanged, as it should be (host representation only). Headless, the same fixed route on both trees
(`scripts/promotion-probe.mjs`, 1,500 frames after 300, tick + sprites + hud): 3,522.5 KB a frame on master, 3,519.2 here; old
space grows 161.8 KB a frame on master, 20.1 here (12.9 under `--no-allocation-site-pretenuring`). In the browser
(`--heap-sampling all`, the roam differs from run to run) master 1,325 and 1,287 KB a worker frame, this branch 1,582 and 1,263:
the first of those runs spent its minute near more moving pawns (`removeActor`, `addActor` and the collision hash allocated about
50 KB more), the four numbers say only that a roam's allocation varies by a fifth.

**Checks.** bench-sim digests, 300 ticks: the Island `15e3720088490242`, Training `148077479825af78` and the 747
`ad8e591a01434df5`, all master's. `hud-stream-digest.mjs --frames 1500 --stream` identical to master's (`16bfe2bd08ed1653`).
`validate-script-vm-interp` (539,583 checks), `-script-vm-x87`, `-script-process`, `-mesh-lighting-play`, `-mesh-light-types-play`,
`-weapon-order`, `-anim-dilation-play`, `-play-hud`, `-galaxy-effects-play`, `-triggers`, `-object-layout` and
`-inline-restore-play` (Firefox inline) pass, and the 846 unit tests. Worker-mode Play on the Island: ten roams of 45 to 60 s
with no error. Not measured: Firefox's and Safari's pretenuring (SpiderMonkey pretenures too and the warm-up runs in its inline host, but
no allocation was measured there), and the Mac.

**Tools.** `scripts/promotion-probe.mjs` (headless roam; old-space growth and total allocation a frame, `--sites N` for the sampling
profile of what left the young generation), `hitch-run.mjs --heap-depth N` (frames per site; the default stays 5).
To find a site that needs a warmer: run the probe with and without `node --no-allocation-site-pretenuring` and read what vanishes.

### Cut: tick and actors (2026-10-29)

The tick (`begin`, 886 to 910 KB a worker frame) and the actor mesh layer (`actors`, 357 to 379) were the two largest steps left. The
profile named a few big sites (`tickStandaloneLevel`, the actor tick kernel's `run`, the collision hash, `update`, `admit`), and
behind them most of the allocation was one mechanism, not a dozen subsystems. Host representation only: nothing the simulation
computes changes.

**The mechanism: a function's context is allocated when it is entered.** V8 makes a function's context object at its first
instruction when an inner function refers to one of its parameters, its locals or `this`, whichever path the call then takes, 40 to
100 bytes a call. TurboFan removes it when the function is inlined and the closure never escapes; Maglev and the interpreter do not
(`%GetOptimizationStatus` after a 900-frame warm-up: `ActorTickHost.run`, `refresh` and `tickStandaloneLevel` are in Maglev; a
function with an early return in front of a `.forEach(... => ...)` allocated 64 bytes a call in a microbenchmark under
`--no-turbofan` and none under TurboFan). So `table()` (the registry check that runs for every actor of every tick, and
`LocomotionHost.table()` behind `events.allowed`), `describe()`, the per-binding `update()` (about 300 lines whose closures
capture its locals, entered for every binding though most return at its first checks), `admit()` (entered for every mesh actor each
frame and turning nearly all of them back), the collision hash's `addActor` and `removeActor`, `soundField` and the weapon layer's
loop body each paid it on the early-return path. `scripts/closure-context-scan.mjs` finds them: it parses `src/`, lists the
functions whose own scope (or a block's) is captured, and with `--profile FILE` (the leaf lists of `frame-alloc-meter.mjs
--sites`) only those a heap profile names, with their KB a frame. A related cost seen on the way: reading a double or a u32 above
the small-integer range from an object field is a heap number for each read in the tiers below TurboFan (a 3-store
`setUint32` of masks allocated 32 bytes in the micro test; 0.6 under TurboFan).

**What changed**, in the order made (the commits' messages have the detail):
1. The slow paths with the closures became functions of their own (`fillTable`, `describeNew`, `LocomotionHost.fillTable`,
   `reflectedField`, `linkActor`/`unlinkActor`, `updateDrawn`, `admitNew`, `weaponLodFrames`); the hot function keeps the checks.
2. ULevel.Tick's per-actor closure (`run=()=>processActorTick(actor,delta,options)`, with the lifecycle wrapper and `aroundActorTick`
   taking it) is gone: they take the tick's arguments, and script-doors.mjs makes the tick body once. This alone was 90 KB a frame
   (`tickStandaloneLevel`'s own allocation).
3. tick_actor's eleven arguments go through memory (tick.rs `tick_record`, `TickArgs`); the descriptor's masks are a Uint32Array.
4. The encroachment query copies the seven fields the bounds read, not a spread of the values facade (six getters, two read only to
   be replaced); the collision hash builds a registration's cells and compares a removal's location and cells without arrays
   (`cellTriple`, `sameVector`, `sameCells`), `addActor` returns the registration (a copy of each array was made per call and no
   caller changed it), `primitiveCollisionBounds` builds min and max without the extent and location arrays.
5. BindEvents' GObjObjects list is the last call's array while the level's actors are unchanged (a `filter` copy of 2,400 actors
   for every candidate it binds, 27 KB a frame in the sampled headless profile).
6. The layer's update gives every binding one view with the reads (a spread copy of about 30 properties each), `reconcile` walks
   `actors` by index (a Map iteration made two objects per binding), `meshReads`' `views()` returns one object, `packDynamics` reads
   a mesh's record fields only for a key it has not seen and keeps the record addresses in a scratch, and `lodMeshFrameMatrix`
   builds GetFrame's matrix in 12 doubles with the same f32 operations in the same order (about 50 arrays a rotate before). The
   rebuild when the level's actors change (`reconcile`) keeps the mesh accessors in place instead of filling a second Map and
   copying it back: the actors step's 99th-percentile frame in the headless roam went from 1,368 to 953 KB.
7. `fastLineCheck`'s traversal (Galaxy's Update in the HUD step, and the noise, trace and perception callers) reads planes and
   children from the node objects or the tracker's block through typed views, holds the points as scalars and keeps the pending
   sides in a reused Float64Array stack; `readLaserState` makes its beam keys once; the stamps step builds its binding map from one
   `all()` list.
8. `copyScalar` copies a vector or rotator without a map and its closure.

**Tools.** `scripts/frame-alloc-meter.mjs`: the worker's frame headless (`createSimHost` with the page's GPU mesh capacities, no
page world, a fixed roam as hud-stream-digest.mjs's), V8's new-space size around each step of `session.frame()` (exact and
repeatable, a frame a scavenge ran in left out), the sampling heap profile by step (`--sites N --steps begin,actors`) and a hash of
every snapshot with its numbers' exact bits (`--out FILE`, `--compare FILE`). Its absolute numbers differ from the browser's (the
roam is not the page's and the stamps step does not run), its comparisons between two trees are exact. `hitch-run.mjs` takes
`--heap-leaves N` (the leaves kept for each step in `<out>.heap.json`).

**Measured, browser** (`hitch-run.mjs --heap-sampling all --heap-leaves 120 --seconds 60 --mode roam`, Chromium, worker mode, the
Island, each tree on its own dev server and CDP port; the roam is not pinned, so two runs before and three after; KB a worker
frame, the profile's `frames` count 4,533 to 4,779). The "before" is an export of master `314d6501`, the "after" the branch:

| Step | before 1 | before 2 | after 2 | after 3 | after 4 |
| --- | ---: | ---: | ---: | ---: | ---: |
| tick (`begin`) | 885.6 | 909.6 | 444.8 | 456.4 | 503.2 |
| actors | 356.7 | 378.6 | 194.7 | 194.6 | 193.9 |
| hud (Galaxy's Update inside it) | 122.2 | 127.5 | 104.4 (17.1) | 107.3 (17.2) | 109.9 (17.2) |
| coronas | 84.7 | 95.7 | 120.8 | 120.5 | 120.1 |
| stamps | 41.4 | 46.6 | 34.8 | 34.2 | 34.8 |
| **whole worker** | **1,559.0** | **1,632.6** | **965.8** | **979.7** | **1,030.2** |
| whole worker, a drawn frame | 2,107.6 | 1,974.8 | 1,149.0 | 1,165.4 | 1,228.7 |

The whole worker fell from 1,596 to 992 KB a worker frame (-38%; 2,041 to 1,181 KB a drawn frame, -42%): the tick by about half
(898 to 468), the actors by 47% (368 to 194). A run between (after 1: 957.6, tick 404.6, actors 195.2) was made before the
FastLineCheck, laser and stamps changes and is not in the table. The "after 4" run is the head (`83eea77e`), the others the head
before its last commit, which changed only the frames the level's actors change in. A run's tick varies by 20% between runs of the
same code (405 to 503 KB, with `bindingSet` of the other branch, 12.6 to 23.3 KB, and `readComposite` moving with the roam: it is
not pinned and meets different NPCs and epochs); the leaves are the steadier comparison. Top leaves of the two steps (KB a worker
frame):

| Tick leaf | before 1, 2 | after 2, 3 |
| --- | ---: | ---: |
| `ActorTickHost.run` (actor-tick-kernel.mjs) | 50.5, 54.9 | 2.3, 2.6 |
| `readComposite` (the other branch's) | 56.5, 56.0 | 41.1, 40.8 |
| builtin `map` | 54.1, 54.5 | 17.5, 18.2 |
| `tickStandaloneLevel` | 31.0, 35.0 | 1.0, 0.9 |
| `table` (script-vm-locomotion.mjs) | 19.7, 22.0 | 0, 0 |
| collision-hash.mjs: anonymous, `vector`, `addActor`, `removeActor` | 32.1, 20.6, 15.8, 8.4 and 32.8, 20.7, 17.4, 8.5 | 0, 1.2, 0, 0 and 0, 1.4, 0, 0 |
| `actorEncroachmentCheck` | 17.2, 20.1 | 0, 0.7 |
| `soundField`; `fieldReference` | 16.9, 14.9; 14.7, 13.6 | 0, 0; 12.5, 12.6 |
| `copyScalar` (it now holds the arrays that `map` made) | 9.0, 10.1 | 20.6, 21.2 |

| Actors leaf | before 1, 2 | after 2, 3 |
| --- | ---: | ---: |
| `update` (actor-mesh-sim.mjs) | 53.1, 59.1 | 10.4, 10.3 |
| `admit`; `reconcile` | 14.8, 16.2; 8.7, 15.9 | 0, 0; 7.5, 8.3 |
| `packDynamics` | 17.5, 18.8 | 10.6, 10.4 |
| `rotate` (lodmesh-frame.mjs) | 29.2, 28.2 | 0.2, 0.3 |
| `update` (actor-weapon-sim.mjs) | 5.7, 6.2 | 0, 0 |
| `laserIteratorItems` | 9.0, 10.9 | 3.2, 3.3 |
| builtin `map` | 14.9, 15.0 | 5.5, 5.2 |
| `drawnOf`; `decode`; `readComposite` | 11.4, 11.2; 9.7, 10.4; 15.0, 16.7 | 11.2, 11.8; 10.9, 11.8; 16.4, 16.1 |

Headless (`frame-alloc-meter.mjs`, Island, 600 frames after 900 of warm-up, KB a frame, mean without the 1% largest frames): tick
1,040 to 703, actors 507 to 277, hud 191 to 104, whole call 2,098 to 1,453 (median 1,982 to 1,315). Coronas went the other way,
263 to 286 (and 85-96 to 115-121 in the browser): the corona line checks reach `primitiveLineHit`, whose `Math.fround` calls
allocate when it is below TurboFan; it is not in this cut's files, and which tier a function sits in moved with changes
elsewhere.

**Checks.**
* bench-sim state digests (300 ticks, plain `bench-sim.mjs --map M --ticks 300`): Island `15e3720088490242`, Training
  `148077479825af78`, 747 `ad8e591a01434df5`, the same as master's.
* The HUD stream: `hud-stream-digest.mjs --frames 1500 --stream` against master's export, identical (`16bfe2bd08ed1653`).
* The frame snapshots (`frame-alloc-meter.mjs --compare`: every key of `session.frame()`'s result but its timings, numbers by exact
  bits, hashed per frame) against master's: identical on the Island (600 frames), Training and the 747 (400 each).
* Differentials of the rewritten bodies against master's, bit for bit: `lodMeshFrameMatrix` on 255,000 random and edge inputs (NaN,
  infinities, -0, subnormals; the same throws) and `fastLineCheck` on 360,000 lines over random BSPs (node objects and a memory
  block, cyclic trees, non-finite endpoints).
* Validators (all exit 0): actor-tick-kernel, actor-physics-kernel, locomotion-kernel, perception-kernel, collision-kernel,
  lodmesh-frame, umesh-frame, sprite-setup, spawn-mesh-binding, infolink-shell, occlusion-flat-draw, child-frames, bsp-occlusion,
  brush-bounds-kernel, native-bounds, native-hash, native-hash-radius, native-encroachment, native-level, native-level-points,
  native-mover-push, world-destroy, datalink-transfer-object, script-vm-interp, play-hud, galaxy-effects-play, coronas,
  tracked-collision, leaf-lights, decal-attach, iterator-frames-play, mirrors-play, sky-in-mirror-play, terminals-camera-browser,
  instructor-conversation, level-tick, actor-tick, player-tick-order, decoration-settle-roll, training-cadet,
  training-datalink-live, mesh-lighting-play, stage3-training-conformance, gameplay, fast-line-check-tracked, native-fast-trace,
  native-make-noise, native-visible-actors, pawn-{flying,direction,jump,swimming}-reach, pawn-tick-visibility, pawn-nav,
  lasers-play, native-laser, native-galaxy-audio. Not run or not green: `validate-native-points` stops on a missing earlier
  report (`native-extents`) in this tree, and `validate-master-frame-play`, one of the page reds on a clean master on this host,
  hung for 17 minutes and was stopped. `native-level-points` ran on copies of the `native-level`, `-points`, `-bounds` and
  `-world-fitting` reports from the main checkout.
* Unit tests: 850, 846 pass, 4 skipped. `cargo build` (build:wasm) has no warnings.
* Play: the four 60 s Island runs above are worker-mode Play and ended with no errors.

**What is left, and why.**
* The tick's largest leaves are the other branch's (`readComposite` 41 KB, the script VM's frames and `Run`s, `bindingSet`,
  about 60 KB together).
* Value copies, 38 KB (`copyScalar` and the `map` behind it): a vector written through `writeNamed` is copied twice (once for
  the cell, once for the returned logical copy) and a call's arguments are copied by `processEvent`. Returning the stored copy
  would halve the first, but `writeCell` is not shown to keep nothing of the array for every field kind.
* The JS VM's entry glue in script-runtime.mjs, about 26 KB (`fieldReference`, `invokeNative`, `callFunction`, `localReference`):
  `invokeNative` is a 1,000-line function whose per-native closures give it a context on every call; splitting it by native is a
  larger change.
* Per-pawn move glue, 25 to 30 KB (`rider`, `moveActorRiders`, `begin` in pawn-physics-kernel.mjs, `tracked`, `js_move_hits`,
  `surfaceScanInputs`, `followDecalTracker`, `allocateDeferredActor`): small objects and maps, each 3 to 8 KB. Moving the
  walking surface prelude and the rider pass to Rust would remove them; none is large enough by itself.
* The frames the level's actors change in (six in 600 frames of the headless roam) allocate 5 MB in the tick, and one frame of 38 MB
  (a conversation starts; 54 MB before the BindEvents change) remains. At the epoch frames, `bindingSet`'s sort and join in
  script-vm-rust.mjs (the receiver set of the moving-light scan and of `compactScriptActors`: 3.7 of the 5 MB) is the other branch's;
  `surfacePan`'s Map in game.mjs and mesh-lighting-view.mjs's `levelMembership` (about 0.2 MB each) are not in this cut's files.
* The actors step: `readComposite` 16, `drawnOf` 11 (a Uint32Array of the drawn nodes each frame), `decode` 10, `packDynamics` 10
  (an entry object per binding), `movingLightLeafList` 8, `reconcile` 7 (the epoch rebuilds).
* The other steps are not in this cut: coronas 120 (line-check arrays, the tracked-model Proxy's `get`), hud 105, stamps 34.
* Which tier a function runs in decides what it allocates (Maglev against TurboFan), and it moved with edits elsewhere (the
  coronas step). Chromium's thresholds differ from Node's, so the headless meter orders the changes; the browser profile is the
  number. The two-core trace is the coordinator's.

### Both 2026-10-29 cuts on two cores

Master dd3187ee (the promoted-garbage and the tick-and-actors cuts merged on 314d6501) against 314d6501, the same two-core runs as
"Both cuts on two cores" but 300 s long and interleaved (new, base, new, base): `taskset -c 0,1 node scripts/hitch-run.mjs --map
01_NYC_UNATCOIsland --seconds 300 --mode roam --trace --js-flags '--trace-gc --trace-incremental-marking'`, each tree on its own
dev server, read with `scripts/gc-marking-cycles.mjs`. Frames are the worker's, from 5 s after the map's load (17,592 to 17,868 a
run); a cycle is one complete major GC of the worker in that window.

| run | cycles | frames over 50 ms | over 100 ms | longest frame | a cycle's longest frame, mean |
| --- | ---: | ---: | ---: | ---: | ---: |
| 314d6501, 1 | 10 | 38 | 19 | 356 ms | 224 ms |
| 314d6501, 2 | 6 | 26 | 15 | 358 ms | 237 ms |
| dd3187ee, 1 | 6 | 31 | 8 | 237 ms | 149 ms |
| dd3187ee, 2 | 5 | 25 | 9 | 267 ms | 161 ms |

The merged tree's checks: the bench-sim digests (Island 15e3720088490242, Training 148077479825af78, the 747
ad8e591a01434df5), `hud-stream-digest --frames 1500 --stream` and `frame-alloc-meter --compare` (every frame of `session.frame()`:
600 on the Island, 400 on the 747 and Training) are identical to 314d6501's, with 850 unit tests and the validators of the changed
families (script-vm-interp, script-vm-x87, script-process, play-hud, galaxy-effects-play, mesh-lighting-play, anim-dilation-play,
weapon-order, lasers-play, pawn-nav, triggers, inline-restore-play, the encroachment and hash natives, npc-door-encroach,
collision-kernel, tracked-collision, fast-line-check-tracked, lodmesh-frame).

**What starts the cycles.** The promotion cut made the major GCs rarer, but not by the factor of five the old generation's growth
suggested, because two of V8's triggers do not follow the growth:

* After a load-time cycle, the next one is the memory reducer's, about 100 s after the last mark-compact when none came sooner
  (111.2 s in both new runs; 143.6, 250.1, 184.1 and 290.5 s in the base runs, each about 103 s after a cycle). On the base the
  worker's V8 heap has grown to 1.6 to 1.7 GB by then and the cycle's atomic pause is 143 to 178 ms (its frame 314 to 358 ms, the
  runs' longest); on the new tree the heap is 0.72 to 0.76 GB, the atomic pause 51 to 56 ms and the frame 237 and 267 ms.
* After a memory-reducer cycle the limit sits about 32 MB above where the next cycle starts ("Start (task)" with 32 to 33 MB of
  slack, the old generation at 0.5 to 0.6 GB), so the steady cycles come as often as the old generation grows 32 MB: every 12 to
  13 s on the base (five in a row from 253.8 s in base 1, about 2.5 MB/s), every 33 to 82 s on the new tree (0.4 to 1.0 MB/s).

**What each cycle costs.** A cycle still marks about 250 ms on the worker's thread. Where it lands in two or three frames (the
memory reducer's, and the steady ones on the base), its longest frame is 150 to 270 ms, as before. The new tree's steady cycles
spread more often: 100 to 180 steps on allocation over five to eight frames, with the longest frame 79 to 180 ms, which the lower
allocation (about 1 MB a worker frame against 1.6) makes possible: a step is one per 64 KB allocated, so fewer of them fall in each
frame. Frames over 100 ms are halved (34 to 17 in two runs each), the longest frame falls from 356 and 358 ms to 237 and 267, and
frames over 50 ms barely change (64 to 56): what is left is the marking itself, about 250 ms of it per cycle on the frame thread.

### Cut: script VM values (2026-10-29)

The script VM and the value plumbing under it (the object image's reads, property references, parameter copies, the window host's
natives and tick, the HUD's glue) held about 200 KB of the tick (`begin`) and 80 of the HUD step a worker frame. Host representation
only: nothing the simulation computes changes. Most of it was again a few mechanisms, not one subsystem; the commits' messages have
the detail.

**What allocated, and what changed.**
1. **A binding set was built again at every receiver-epoch advance** (`bindingSet`: a key array, a sort and a join for each of the
   2,400 receivers the moving-light scan and `compactScriptActors` ask about, 13 KB a frame, and 3.7 MB in each frame the level's
   actors change in). The set is kept on the object until a binding is added or replaced (`bindingsVersion`, three sites), and
   the level-actors scan writes its pairs without arrays.
2. **DestroyActor read an actor's whole `Touching` array four times for every actor of the level** (`destroyScriptActor`, 0.77 MB a
   destroy, the biggest part of the 2 MB frames of the headless roam). `touchingSlot` compares the four slots in the image.
3. **A property reference was 13 fields and two closures with a context** (about 330 bytes) for each variable operand passed to a
   native or a call. It holds five fields now; key, metadata, the array shape and `get`/`set` are read from the descriptor or made
   when asked (callers that pass `ref.get` on as a detached accessor still get one), and the VM's own reads and writes call
   `getValue`/`setValue`. A whole-property store skips reading the old value unless a bit mask needs it (`pure` storage).
4. **Parameter copies** (`processEvent`, `callFunction`): a vector or rotator was copied into an array to be written into the frame
   block, and read back into one array and copied into another. `setLocalCopy`/`getLocalCopy` write from the argument's
   components and read the cell once. `writeStorage` writes a vector from the value's components, and the pawn physics services call
   `storeNamed`, which skips the copy `writeNamed` returns.
5. **Closure contexts on hot entries**, the mechanism of the previous cut: `dispatchWindowHostNative` (every native not its own, about
   30 a frame, built four closures), `handleNative` of the window host, `rootTickVirtual` (it merged the two window module
   namespaces into one object for each tick), `resolveNativeGetPlayerPawn` (native 720, 47 a frame), the primitive-native closure
   of the VM (it also made the values array twice), `callFunction`'s `entries()` iterator and `out` array, `native()`'s array
   destructuring, `destroyFunctionLocals`' default options object, `destroyProperties`' services object.
6. **Service tables made for every pawn tick**: `pawnPhysicsServices` (a dozen closures plus the zone view with six getters) is kept
   per pawn while its level, hash and world actor are the same; `spawnedMoveServices` (about 25 closures, and the spread of them
   for the rider entry) per level; the call object the VM builds for a native is handed to the host in place (`hostNative`) instead
   of a copy of it.
7. **Smaller sites**: the HUD tile's eight numbers are written into the stream where they are made (`beginTile`; they were eight
   boxed doubles passed to a call), `frames.length = id` after every body the HUD begins gave the run table a new backing store
   (`cutFrames` clears it where it stands: `resume` in the HUD 5.8 to 2.8 KB), a Rust body's JavaScript callbacks reuse the pooled `Run`,
   a frame has no iterators array until a foreach runs, the zone number of `Region` is read in place instead of building the
   struct (`readStructMember`, `level.zoneLastRenderTime`), `scriptCaps` uppercases an ASCII text without a regex callback,
   `encodeMusicBatch` reads its ops by index, the ambient actor list is one array, the conversation events' `isA` makes its key once.
8. **The computer window's tick** ran BigInt x87 values every frame for a blink step, a time step and the fades. They are
   `computer.rs` on the Rust x87 model (`computer-tick-kernel.mjs`; the BigInt bodies stay as the reference when the kernel is not
   loaded or the precision control is 24), and `gt(X(a), X(0))` of two float32 values is `a > 0`. `test/script-window-computer-tick.test.mjs`
   runs the kernel against the model over 200,000 random and edge float32 inputs for each step.

**Measured, browser** (`hitch-run.mjs --heap-sampling all --heap-leaves 120 --heap-depth 8 --seconds 60 --mode roam`, Chromium,
worker mode, the Island; a roam is not pinned, so three runs before (the two profiles of the brief, `alloc-1`/`alloc-2` at
`76495d62`, and my own `base1` on the same tree) and two after, the branch's head). KB a worker frame:

| | before 1 | before 2 | before 3 | after 1 | after 2 |
| --- | ---: | ---: | ---: | ---: | ---: |
| tick (`begin`) | 648 | 442 | 433 | 339 | 342 |
| actors | 246 | 189 | 188 | 185 | 195 |
| coronas | 95 | 119 | 122 | 121 | 121 |
| hud | 98 | 103 | 104 | 92 | 89 |
| **whole worker** | **1,176** | **942** | **938** | **825** | **835** |

Leaves of the two steps, my files' (`base1` against the two after runs):

| Tick leaf | before | after |
| --- | ---: | ---: |
| `readComposite` (script-object-image.mjs) | 38.4 | 29.0, 30.2 |
| `copyScalar` | 21.9 | 9.4, 9.2 |
| `(anon)` script-vm.mjs | 19.1 | 8.7, 9.4 |
| `fieldReference` | 13.3 | 4.0, 3.8 |
| `bindingSet` | 13.2 | 0, 0 |
| `invokeNative` | 9.5 | 3.2, 3.1 |
| `callFunction` | 6.0 | 1.8, 2.0 |
| `x87loadWord` | 5.3 | 1.4, 1.3 |
| `createFrame` | 5.1 | 3.9, 4.2 |
| `rootTickVirtual` | 4.4 | 0, 0 |
| `resume`; `run` (script-vm.mjs) | 4.3; 4.1 | 3.2, 3.8; 3.2, 3.4 |
| `run` (script-vm-rust.mjs) | 3.7 | 0, 0 |
| `dispatchWindowHostNative` | 2.9 | 0, 0 |
| builtin `replace` | 4.3 | 1.2, 1.3 |
| **my files' leaves, summed** | **196** | **109, 112** |

| Hud leaf | before | after |
| --- | ---: | ---: |
| `gcServices.callVirtual` | 10.6 | 11.1 |
| `read` (script-gc-state-model.mjs) | 7.8 | 8.1 |
| `resume` | 5.8 | 2.8 |
| `readComposite` | 5.6 | 5.9 |
| `run` (script-vm.mjs) | 3.4 | 2.5 |
| `processEvent`; `invokeNative`; `fieldReference` | 2.3; 1.7; 1.6 | 0.8; 0.6; 0.4 |
| `encodeMusicBatch` | 1.8 | 0.2 |
| **my files' leaves, summed** | **81** | **69, 66** |

(The sums count every leaf whose file is in my list, `readComposite` and `copyScalar` whole; the two other runs before were 238 and 154
in the tick and 62 and 67 in the HUD by the same count.) The brief's target was the tick's about 200 under 80 and the HUD under
50: the tick is at about 110, and `readComposite` is 30 of those, whose callers are in other files; the HUD is at about 66.
Headless, the exact meter (`frame-alloc-meter.mjs`, the Island, 600 frames after 900 of warm-up, KB a frame):

| | before mean / median | after mean / median |
| --- | ---: | ---: |
| tick | 788.7 / 697.7 (p99 1,903.5) | 652.7 / 547.1 (p99 1,130.6) |
| actors | 303.3 / 272.4 | 304.4 / 274.1 |
| coronas | 295.5 / 268.1 | 295.5 / 268.1 |
| hud | 122.1 / 71.4 | 106.4 / 67.9 |
| sprites | 57.0 / 55.7 | 54.5 / 53.5 |
| whole call | 1,580.6 / 1,390.9 (p99 4,028.3) | 1,429.9 / 1,233.3 (p99 2,922.3) |

and the sampling picture of the tick there (`--sites 300 --depth 6`): `readComposite` 70.7 to 47.2, `copyScalar` 40.0 to 14.4,
`(anon)` of script-vm.mjs 28.1 to 18.7, `PropertyReference` 18.4 to 0 (`storageReference` 12.5 to 5.7), `bindingSet` with its sort 27.5 to 0,
`rootTickVirtual` 11.0 to 0, `next` of `callFunction` 9.5 to 0.5.

**The frames the level's actors change in.** The sort and join are gone (the keys are built once for an object and kept). What
remains of those frames in the headless roam: frame 179 (1.8 MB), 190 (2.2 MB) and the conversation start at 189, which is 31 MB
before this cut's last commit and 29 after: 8 MB in `findExportIndex`'s hash walk of `staticLoadObject` (an export record, a
`requireInt` and an iterator for each entry of a chain: script-static-load-object.mjs, not changed), 1.3 MB in `bindEventsNative`, 1 MB
of `isA` (fixed), and the script decode and lowering of the bodies that run for the first time (several MB, once for each).

**Checks.**
* bench-sim digests, 300 ticks: Island `15e3720088490242`, 00_Training `148077479825af78`, 03_NYC_747 `ad8e591a01434df5`.
* `frame-alloc-meter --compare`, every frame of `session.frame()` against the untouched tree's: identical on the Island (600 frames,
  `c8cf5fff928609c1`), the 747 (400, `f6337bff0cf741fc`) and Training (400, `e4b017e7b1bc0439`). `hud-stream-digest --frames 1500
  --stream`: `16bfe2bd08ed1653`.
* Unit tests: 856, 852 pass, 4 skipped (the new test is six of them). `npm run build:wasm`: no warnings.
* Validators, one at a time (all exit 0): script-vm-interp (539,583 checks), script-vm-x87, script-process, play-hud,
  galaxy-effects-play, inline-restore-play (Firefox inline), triggers, pawn-nav, window-native-diff (1,056 cases over 76
  natives, the rewritten dispatcher), world-destroy, window-computer, window-computer-playback, gc-draw-{text,icon,pattern,
  texture,borders,box,stretched-texture,actor,actor-host}, gc-copy-gc, window-scroll-{area,children,configuration,layout,
  movement,removal,cleanup,exec}, edit-insert-text, mesh-lighting-play, lasers-play, training-cadet, training-datalink-live,
  instructor-conversation, island-conversation, gameplay, crowbar-crate, actor-tick, level-tick, player-tick-order,
  decoration-settle-roll, decal-attach, datalink-transfer-object and the conversation bind validators (action, base,
  check-object, move-camera, binding, item-lifecycle). validate-gc-draw-texture is a mutation test that looks for a source
  string: the first version of the tile colour read removed it, and it failed until the read kept its text.
* Six 60 s worker-mode Island runs on the branch (the head's two among them), none with an error.

**What is left, and why.**
* `readComposite` (29 to 30 KB in the tick, 6 in the HUD, 17 in the actors step) is a fresh array for every vector read, and the callers
  are not in this cut's files: the pose getters (`actor-pose-fields.mjs` through `decoration-physics.mjs` `get Location`, read by
  `lc_candidate` and the collision hash), the pawn view's `bind` getters (script-pawn-physics.mjs:98, `surfaceScanInputs`,
  `moveActorRiders`), the laser state arrays (`laserIteratorItems`: nested fixed arrays of structs, 13 KB between the actors
  and sprites steps, where `readNamedElements` and `readStructMember` now exist), `reconcile`, Galaxy's Update. The whole logical
  copy is what each of these asks for; each needs a scalar or in-place read.
* The VM's per-call objects: the call object, `evaluateArgument` closures and context of `compileCall`/`compileNative` (the
  `(anon)` rows, 9 KB), `invokeNative`'s context (66 closures in a 1,000-line function: 3 KB), a frame, its `FrameLocals` and
  the `zeroRefs` copy for each script call (`createFrame` 4, `createFrameLocals`/`frameLayout` 3), and the reference's own
  `CellStorage`. Each is about 1% of the tick.
* The HUD: `callVirtual` (11) and `GcMemory.read` (8) allocate boxed doubles in the tiers below TurboFan, and the headless meter
  does not show them (1.8 and about 1); a change of their shape could not be judged without more browser runs than the roam's
  variation allows. The raw background's clip list, the window scene frame and the computer window's drawing still use the BigInt
  x87 values (`ld` 2.4, `x87mul` 2.5, `x87storeWord` 2.0 in the HUD).
* The computer window's `computeTimeStep` in doubles was written first and dropped: the sum of the product of two 24-bit values and
  the time is exact in 64 bits but not in 53, and the window's throttle is such a value.
* Not measured: Firefox's and Safari's allocation, the Mac, and the two-core GC traces (the coordinator's).

### Cut: world queries and actors (2026-10-29)

The coronas (95 to 119 KB a worker frame), the actors (189 to 246), the tick's collision and walking glue, the stamps (35) and the
sprites (25) were the steps left after the tick-and-actors cut. Host representation only: nothing the simulation computes changes.
Most of it was the mechanisms already seen in the earlier cuts, plus these:

* **A kernel call that was never made.** The corona pass asked `level.hash.lineCheck(..., lineModel())` for each light, and a
  `worldModel` argument always took the JavaScript reference path (`modelLine`: `singleLineCheck`, `multiLineCheck`, the hash's cell
  arrays, `copyHit`, the Proxy over the tracker's nodes with a node object per first read). The tracker's collision model is the same
  block of memory the kernel imports for every other line check, so while the tracker lives `lineProbe` (level-queries.mjs) asks
  lc_line for the two answers the helper reads, `outside` and `actor`, and writes them into one record (collision-kernel.mjs `probe`).
  Mesh lighting's visibility trace does the same through `traceRayClear` (ray.mjs, trace-kernel.mjs `rayClear`), with no hit object.
  `lineModel()`'s view is built only where the JavaScript path runs (the validators, `?trackedCollision=off`, a kernel hand-back).
  `LINE_PROBE_DIFFERENTIAL=1` (or the hash and trace differentials) compares every probe and trace with the reference.
* **A typed array per read.** bsp-occlusion's `words()` made a new `Uint32Array` over the kernel's memory for every tracker header word
  (`live()`, `generation()` and `count()`, each read for a line check's world model) and every node; decal-kernel's `setRotation` one
  per surface per mover per AttachDecal; move-pawn-kernel one for each move's hit records and result. They are kept while
  `memory.buffer` is the same object.
* **`length = 0` is not free.** An array emptied by `length = 0` drops its backing store (measured in Node: 300 pushes after it
  allocate 7 KB, none when written by index). The actor layer's record list was `[]` pushed to for every binding each frame; it is a
  `RecordList` written by index and copied out once, exact.
* **Words above the small-integer range.** The flat draw lists read each entry's `polyFlags` and `zoneKey`, which that form drops: a
  word above 2^30 is a heap number for each read below TurboFan, as the earlier cut found for object fields. Play's decode also keeps
  a sprite as five words in a `Uint32Array` instead of two objects, a span and an array.
* **Scratch and pools** where nothing outlives the call: `movingLightLeafList` walks its path in module scratch arrays (three typed
  arrays per level before); `packDynamics` reuses its entry objects and sorts them with a stable merge in scratch (the main frame's
  call only); the pawn physics host keeps its pair of contexts at each depth; `js_move_hits` reads its query into one scratch;
  `walkingSurfacePrelude` of a pawn whose scan runs in the kernel fills one set of inputs, and `surfaceScan` answers into kept objects
  (valid until the next scan: WalkTexture's event copies its arguments, validate-collision-kernel's log copies what it keeps);
  `moveActorRiders` and `laserIteratorItems` hold no closure; the stamps step keeps its by-id Map of the bindings while the list is the
  same, and the layer's `all()` is one exact array; one frozen `{root:false}` serves every binding a child pass does not draw (a
  weapon's decision, which the sim marks `flipSide`, is a copy); the actor layer, the corona scan and `reconcile` extend their sets in
  place when Level.Actors only gained slots at its end.

**Measured, browser** (`hitch-run.mjs --heap-sampling all --heap-steps 10 --heap-leaves 30 --seconds 60 --mode roam`, Chromium, worker
mode, the Island, one dev server per tree on CDP port 9472; KB a worker frame, 4,530 to 4,672 frames a run). The "before" is an export
of master `76495d62` run on this machine, the "after" the branch (code at `81eb06a4`):

| Step | before 1 | before 2 | after 1 | after 2 |
| --- | ---: | ---: | ---: | ---: |
| **whole worker** | **1,007.8** | **962.0** | **742.0** | **696.7** |
| tick (`begin`) | 495.8 | 454.5 | 427.5 | 392.8 |
| actors | 194.3 | 193.4 | 115.7 | 113.2 |
| coronas | 120.3 | 121.9 | 20.7 | 17.2 |
| hud | 107.9 | 103.3 | 104.5 | 100.8 |
| stamps | 35.2 | 35.0 | 19.2 | 18.7 |
| sprites | 25.0 | 24.8 | 24.6 | 24.6 |
| lightFrame | 12.2 | 12.0 | 9.8 | 9.7 |

The whole worker fell by 26% (962 to 1,008 KB down to 697 to 742). The tick moves with the roam (the earlier cut saw 405 to 503 between
runs of the same code, and most of it is in the other agent's files); the leaves in this cut's files fell from about 58 to 19 KB.
Leaves (KB a worker frame, before 1 and 2 | after 1 and 2):

| Leaf | before | after |
| --- | ---: | ---: |
| coronas: `vector`, `multiLineCheck`, `get` (bsp-occlusion), `map`, `singleLineCheck`, `visit` | 18.7 19.2; 14.9 15.5; 12.4 12.5; 9.4 9.5; 7.5 7.8; 7.0 7.1 | 0 0; 0 0; 0 0; 0.6 0.6; 0 0; 0.4 0.3 |
| coronas: `actorLineCheck`, `collisionHashLineBounds`, `movingLightLeafList`, `lineCheck`, `modelLine`, `fround` | 4.2 4.1; 4.1 4.2; 4.1 4.1; 2.7 3.1; 2.7 2.7; 2.6 2.9 | 0 0; 0 0; 0.5 0.6; 0 0; 0 0; 0 0 |
| actors: `drawnOf`, `packDynamics`, `movingLightLeafList`, `reconcile`, `setZoneSkies`, `from` | 11.1 11.3; 10.4 10.5; 8.4 9.3; 6.8 6.6; 2.5 2.6; 3.2 3.1 | 0 0 each |
| actors: `update` (actor-mesh-sim), `decode`, `next`, `map`, `updateDrawn` | 10.4 10.1; 10.3 9.9; 8.3 8.1; 5.5 5.7; 4.6 4.7 | 7.5 7.2; 5.4 5.1; 3.5 2.9; 3.7 4.0; 3.8 4.1 |
| stamps: `set` (the by-id Map and the decisions' Maps), `framePasses` | 11.5 11.8; 12.1 11.2 | 0.5 0.3; 9 (`framePass`, below) |
| tick: `followDecalTracker`, `surfaceScanInputs`, `tracked`, `js_move_hits`, `moveActorRiders` | 9.0 8.9; 6.4 5.8; 5.9 5.2; 5.1 4.6; 4.7 4.4 | 0 0 each |
| tick: `rider`, `begin` (pawn-physics-kernel), `scanHit` + `surfaceScan` | 6.1 6.0; 5.8 5.4; 7.9 7.7 | 4.7 4.3; 3.7 3.4; 0 0 |
| tick: `primitiveCollisionBounds`; `lineCheck` + `hitObjects` (collision-kernel) | 4.5 4.3; 3.7 3.2 | 4.3 4.5; 6.3 6.0 |

**Headless** (`frame-alloc-meter.mjs`, KB a frame, mean without the 1% largest frames; before from the references written on the
untouched tree, after at the branch head):

| Map (frames after warm-up) | tick | actors | coronas | sprites | whole call (trimmed mean / median) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Island (600 after 900) | 763.9 to 645.7 | 292.8 to 185.3 | 293.6 to 25.4 | 56.8 to 55.9 | 1,545.7 to 1,048.9 / 1,396.0 to 936.6 |
| 747 (400 after 200) | 426.2 to 407.7 | 65.9 to 43.6 | 89.0 to 21.1 | 5.5 to 5.5 | 812.6 to 703.1 |
| Training (400 after 200) | 647.1 to 624.4 | 97.5 to 61.6 | 292.7 to 56.3 | 0.8 to 0.8 | 1,730.3 to 1,429.2 |

The Node tiers differ from Chromium's (the corona line checks were the JavaScript reference path in both, and cost 293 here against 95
to 119 there), so the headless meter orders the changes and the browser profile is the number.

**What each change was, in the order made** (the commits have the detail):
1. `lineProbe` and the kept memory views (coronas 295 to 28 KB headless; the browser's 120 to 20): corona-scan keeps its frame state
   and the light's float32 Location in objects made once, so `update` and `visit` hold no closure; `coronaSeenAt` takes the actors list
   instead of a closure; the zero extent is shared.
2. Flat draw lists into kept scratch and exact typed arrays (`drawnOf` takes the frame's whole node list as one view), pooled
   candidate entries, the record list, the sky records read once per sky actor, `reconcile`'s and the corona scan's sets extended.
3. The tick glue: pooled pawn physics contexts, `js_move_hits`' scratch, kept views, mesh lighting's traces in the kernel,
   the by-id Map, `all()`, `meshChanged` without a closure per binding per frame.
4. The shared not-in-frame decision, the laser iterator without closures, `finishSetup` by index.
5. The kernel scan's inputs and hits in scratch, `moveActorRiders` without closures.
6. Play's sprites as typed arrays, the unread draw words, the by-index record list.

**Checks.**
* `frame-alloc-meter.mjs --compare` against references written on the untouched tree (every key of `session.frame()` but its
  timings, numbers by exact bits): identical on the Island (600 frames after 900 of warm-up, `c8cf5fff928609c1`), the 747 (400,
  `f6337bff0cf741fc`) and Training (400, `e4b017e7b1bc0439`), and, against `76495d62`'s own output, on ShipFan (the fan lamps behind
  the movers), Paris_Club (mirrors) and HongKong_Helibase (200 frames each). `LINE_PROBE_DIFFERENTIAL=1` ran the Island and ShipFan
  (200-frame runs: 7,192 and 3,632 corona probes, 3,096 of them blocked on ShipFan), UNATCO HQ and Helibase with every probe and every mesh-light
  trace compared with the JavaScript reference: no difference.
* bench-sim digests (300 ticks): Island `15e3720088490242`, Training `148077479825af78`, 747 `ad8e591a01434df5`; the HUD stream
  (`hud-stream-digest.mjs --frames 1500 --stream`) `16bfe2bd08ed1653`. All as on master.
* `test/moving-light-leaf-list.test.mjs` (new): `movingLightLeafList` against the full Filter walk on 120 random BSP trees, leaf by
  leaf (also with the lights' kept locations), and `movingLightInView` against the destructuring body on 400 random planes and
  spheres. 852 unit tests, 848 pass, 4 skipped.
* Validators (exit 0): coronas, coronas-tracked, coronas-play, leaf-lights, collision-kernel, tracked-collision,
  fast-line-check-tracked, native-encroachment, native-hash, native-hash-radius, brush-bounds-kernel, native-fast-trace, native-level,
  bsp-occlusion, child-frames, occlusion-flat-draw, sprite-setup, pawn-physics-kernel, pawn-move-kernel, walk-loop-kernel, walk-kernel,
  actor-tick-kernel, actor-physics-kernel, native-walking-surface, native-ladder, x87-callers-kernel, native-mover-push,
  npc-door-encroach, decal-attach, decal-order, decals-play, plant-push, decoration-settle-roll, level-tick, lodmesh-frame, pawn-nav,
  mesh-lighting-play, lasers-play, mirrors-play, sky-in-mirror-play, iterator-frames-play, weapon-order. The page validators and the
  physics kernels were rerun at the head after their last change, the others at the commit that touched their family.
  validate-collision-kernel's log and validate-occlusion-flat-draw's comparison were adapted to the two representation changes
  (the kept scan hits; the sprite lists as typed arrays). `reports/movement` was copied from the main checkout for
  validate-native-encroachment, which reads an earlier validator's report.
* `npm run build:wasm`: no cargo warnings (no Rust file changed). The four 60 s worker-mode Island runs of the branch ended with no errors.

**What is left, and why.**
* Per-binding records: `update` 7.5 (the `{id, visible, childOnly}` record of each of 324 bindings; the page needs one for each to hide
  it, and the records are posted), `updateDrawn` 4 (its context and closures: a 250-line function whose closures capture the LOD and
  lighting state), and the per-drawn-actor arrays of `finishSetup`, `setupMesh`, `lightFrame` and the GPU plan (`viewBox`,
  `advanceChannelBox`, `lodMeshFrameMatrix`, `frameContext`), 2 to 4 KB each.
* The decode's result objects (child requests with their spans, the flat lists' six views, the sprite and screen arrays): `decode` 5.
  Their shape is read by validators; lazy views would remove about 1.5 KB.
* The stamps' pass decisions (`framePass` 9): the decision objects of the bindings a child frame draws (their group bits and spheres)
  and the `decisions` Map of every posed binding, 320 entries a pass, which the page reads by id.
* Lasers (`laserIteratorItems`, `float3`, `readLaserState`, about 8 KB over the sprites and actors steps): the beams' vectors are arrays
  read and converted for `laserCurrentItem`'s BigInt x87 model; a Rust port would carry the x87 PC24 chain and the random-beam
  rejection loop, which was not started.
* The tick's collision glue: `hitObjects` and the `cellTriple`/bounds arrays of the hash registrations (a moved pawn's remove and add
  each build `{min, max}`), `primitiveCollisionBounds` 4, `rider` 4.5, `begin` 3.5. They are result objects the JavaScript move body
  reads; moving MoveActor's hit selection and the rider pass to Rust would remove them.
* Not in this cut's files and larger than all of the above together: `readComposite` (about 16 KB in the actors step, 9 in the sprites),
  the VM's `copyScalar`, frames and `bindingSet` in the tick, and the HUD step.
* Not measured: the two-core traces (the coordinator's), Firefox, the Mac.

### The script VM and world query cuts on two cores

Master 2d93b472 (the script VM values and the world queries and actors cuts merged on 76495d62) against 76495d62, the runs of
"Both 2026-10-29 cuts on two cores": four interleaved 300 s Island roams on two cores (`taskset -c 0,1`, `--trace`, V8's marking
log), each tree on its own dev server, read with `scripts/gc-marking-cycles.mjs`; 17,754 to 17,922 worker frames a run, from 5 s
after the map's load.

Allocation first (`hitch-run.mjs --heap-sampling all`, 60 s Island roams on all cores, two runs): 580 and 604 KB a worker frame
against 942 to 1,176 on 76495d62. The steps: `begin` 286 and 304, actors 117 and 118, HUD 89 and 90, sprites 23 and 24, stamps 20
and 19, coronas 16 and 20, outside the frame 17, `lightFrame` 10.

| run | cycles | frames over 50 ms | over 100 ms | longest frame | a cycle's longest frame, mean |
| --- | ---: | ---: | ---: | ---: | ---: |
| 76495d62, 1 | 5 | 27 | 6 | 302 ms | 202 ms |
| 76495d62, 2 | 5 | 26 | 8 | 295 ms | 189 ms |
| 2d93b472, 1 | 5 | 24 | 8 | 192 ms | 139 ms |
| 2d93b472, 2 | 5 | 24 | 6 | 281 ms | 181 ms |

The merged tree's checks: the bench-sim digests (Island 15e3720088490242, Training 148077479825af78, the 747 ad8e591a01434df5),
`hud-stream-digest --frames 1500 --stream` (16bfe2bd08ed1653) and `frame-alloc-meter --compare` on the Island (600 frames), the 747
and Training (400 each) are identical to 76495d62's; 858 unit tests pass; 53 validators of both cuts' families exit 0 (the round-2
list, with native-hash-radius, the coronas (coronas, -tracked, -play, -mover-play, corona-tiles-play), leaf-lights,
iterator-frames-play, mirrors-play, mirror-plan-play, sky-in-mirror-play, occlusion-flat-draw, sprite-tiles-play, decals-play,
decal-attach, gc-draw-texture, window-computer, window-computer-playback, keypad, datacube-read, infolink-shell,
conversation-binding, property-destroy, cleanup-destroyed-live, the walking natives and kernels, walk-loop-branches,
rider-move-kernel, native-set-rotation-riders, mover-push-play and native-mover-push).

**Allocation no longer sets the long frames.** A worker frame allocates 40% less, and the frames over 100 ms are as many as before
(14 in two runs on each tree), the frames over 50 ms nearly so (48 against 53). The longest frame and a cycle's mean longest fall
(192 and 281 ms against 302 and 295; 139 and 181 against 202 and 189), within the spread of the runs. At most 32 steps on allocation
land in one frame against 67, but each cycle still runs 330 to 450 ms of wall time on both trees, and three or four of a run's five still
mark 180 to 250 ms on allocation within two to four frames (the others spread 70 to 125 ms over six to ten). That fits V8 pacing its incremental marking by time as well as by
allocation: with fewer steps, each does more (not checked against V8's source). The synthetic's thresholds (0.8 and 0.5 MB a
frame) were measured on a smaller heap and do not carry over to the worker's 0.5 GB old generation.

**What starts the cycles.** Both trees have five worker cycles a run and the same pattern: the memory reducer at 111 to 119 s
(the V8 heap at 681 to 718 MB), a "Start (task)" cycle 8 to 17 s later with 24 to 31 MB of slack (486 to 508 MB), then either a
second memory-reducer cycle (225.6 to 233.8 s) with its own task cycle, or task cycles every 39 to 52 s. The old generation after
a cycle is about 0.5 GB on both: the count of cycles now follows the memory reducer and the 32 MB slack after each cycle, and the
cost of each follows the live heap that is marked, not the allocation of a frame.

## Step 4's results (2026-10-29)

**What the faces held.** In the base worker's snapshot (07de3088, the Island after a 30 s walk) the `host.actorSim` family held 874 k
objects, 2.97 M snapshot edges and 30.7 MB. 635 k of the objects were faces: every one of the 324 bindings read its own copy of its
mesh's faces through `readLodMeshSurfaces`, one `{wedges, vertices, uv, material, flags, texture}` object a face, each with its
arrays of arrays (`uv` 390 k objects, `wedges` 98 k, `vertices` 98 k, the face objects 49 k). Bindings of the same mesh shared
nothing, and the Island's 324 bindings draw 88 meshes. The page held its faces once a mesh (`meshSource`), as objects
too.

**The change.** Host representation only; every value is the one the object readers gave.
* `src/runtime/mesh-faces.mjs`: a mesh's faces as one `MeshFaces` block, built on first use and kept per decoded payload (a
  WeakMap), so every binding of a mesh reads the same block. `words` (four per face: the three corners' vertex indices with the
  special prefix, then PolyFlags: the `faceWords` the lighting kernel, the GPU layout and the LOD already took), `wedges` (Uint16),
  `uv` (the six U and V bytes, Uint8), `material` and `texture`. A classic UMesh builds the same block from its triangles (no
  wedges). `readLodMeshSurfaces` and `readUMeshSurfaces` are now `faceObjects(buildLodMeshFaces(...))`: the objects the
  validators and `getActorMeshSurfaces` return, and `validate-lodmesh-materials` compares them with the original's Render ranges
  as before. The Rust lodmesh kernel keeps its uploaded lighting topology by the identity of the `words` array, so one upload now
  serves every binding of a mesh.
* The readers read the block: `meshFaceGroups(faces, skin(flags, texture))`, `groupCorners`, `createMeshLod` (its reduced lighting
  topologies keep only their words), `lightMesh` (the packed words in place of the `{vertices, flags}` list; the objects still work
  for the reference path and the tests), `actor-mesh-sim.mjs`, `actor-umesh-sim.mjs` and the page's `actor-mesh-draw.mjs`.
* Also per mesh, found by the same snapshots (all inside `host.actorSim`):
  * The GPU layout's per-mesh vertex adjacency and LOD vertex lists were an array of arrays each (24 k objects); they are offset
    and item arrays now (`vertexFaceLists`, `lodVertexLists`, read by `gpu-mesh.mjs`'s upload).
  * The payload view's arrays (`lodmesh-payload.mjs`) were objects of three getter closures each (about 25 heap objects a
    mesh array, 40 k objects for the family's payloads); they are `ProjectedArray` instances with the getters on the prototype
    (about 16 k objects fewer). `lodMeshTopology` spread such an array into a new object; it now reads the fields it needs, since a
    spread copies the own properties only (the first try at this change turned the LOD off for every mesh, which the frame digest
    caught at frame 0).
* Per binding, not per mesh, but the same kind of waste:
  * A group's five channel boxes and view box were six Float64Arrays, and its sorted vertex list an array kept after it had
    served `keyframeBoxes`; the boxes are one array with offsets (`gpu-mesh-bounds.mjs`), the view box a view of it, the list
    dropped.
  * The 23 field accessors of a binding (`fieldAccessors`: an arrow function, two contexts and the replacing function, about
    four objects each) are `fieldReaders` (`actor-fields.mjs`): methods of a class made once for the list, with one slot a name
    holding the field handle. The Mesh accessor of every actor in the level (2.6 k) is a `FieldReader` object, not a closure pair.
    `test/actor-fields.test.mjs` runs both forms against a logging runtime double: the same calls in the same order, for linked
    and unlinked receivers, a released object and a first read that throws.
  * A binding kept its creation record (the message that goes to the page: groups, first plan, posed pose, about forty objects)
    for its life; the layer drops it once it has emitted it.

**Checks.**
* References first, on the untouched tree: frame-alloc-meter Island (600 frames, warm 900) `c8cf5fff928609c1`, 03_NYC_747
  `f6337bff0cf741fc`, 00_Training `e4b017e7b1bc0439`, `hud-stream-digest --frames 1500 --stream` `16bfe2bd08ed1653`. After:
  `--compare` reports identical frames on all four, and bench-sim (300 ticks) gives Island `15e3720088490242`, 00_Training
  `148077479825af78`, 03_NYC_747 `ad8e591a01434df5`.
* Differentials: `test/mesh-faces.test.mjs` (the object readers verbatim in `test/helpers/mesh-faces-reference.mjs` against the
  blocks: every field of random meshes with and without PolyFlags, the errors of malformed data, the face groups and corners,
  the adjacency and LOD lists) and `scripts/validate-mesh-faces.mjs` (every LodMesh and classic Mesh of the game's 20 code packages and the
  Island, Training and 747: 437 meshes, 85,827 faces field by field, 1,108 face groups with their corners, and 432 meshes' GPU
  adjacency and LOD vertex lists). 868 unit tests pass (872, 4 skipped).
* Validators, each exit 0: lodmesh-materials, mesh-faces, lodmesh-lod, lodmesh-frame, mesh-payload, mesh-load-graph, mesh-lighting,
  mesh-environment, mesh-light-types, mesh-path-frames, umesh-draw, umesh-frame, umesh-wasm, actor-mesh-scene, weapon-attach,
  weapon-construction, weapon-lod, weapon-view-model, weapon-select, and in the browser (worker mode) gpu-mesh (run twice, at the first commit
  and at the head), mesh-lighting-play, anim-dilation-play, weapon-order, weapon-mirror-play, weapon-gpu-play, weapon-play,
  mirrors-play, iterator-frames-play, context-loss-play, umesh-play, easter-egg-play, mesh-light-types-play and npc-mesh-preview.
  `validate-lodmesh-lod-play` does not finish (900 s with no output on the Island, 600 s on Training); a base checkout of 07de3088
  does not finish either (300 s on Training): it is one of the page checks of the known red list (docs/class-graph-design.md), so the LOD in Play rests on
  validate-gpu-mesh's LOD variants (morph, dropped faces, child frames), validate-weapon-lod and validate-lodmesh-lod.
* A 60 s worker-mode Island roam (`hitch-run.mjs`): 4,726 frames, no error. `npm run build:wasm`: no Rust file changed, no cargo
  warnings.

**Heap**, the Island's worker after a 240 s roam and forced GCs (`profile-live-heap.mjs --mode roam --seconds 240`; both runs
walked and turned at random, so the routes differ; the base family was 874 k objects after the 30 s walk and 878 k after the roam,
with 324 bindings in the walk and 313 in the roam after). "Pointer references" leave out the edges
to Smi nodes and the weak edges.

| | Objects | References (snapshot edges) | Pointer references | JS heap (used of total) |
| --- | ---: | ---: | ---: | ---: |
| Worker, before (master `07de3088`) | 8.21 M | 45.3 M | 39.0 M | 336 of 350 MB |
| Worker, after | 7.48 M (-8.9%) | 43.3 M (-4.4%) | 37.3 M (-4.4%) | 312 of 323 MB |
| `host.actorSim`, before | 878,052 | 2,977,601 | 2,727,424 | 30.9 MB (10.6 MB native) |
| `host.actorSim`, after | 126,312 (-85.6%) | 739,284 (-75.2%) | 682,027 (-75.0%) | 6.9 MB (10.6 MB native) |
| Page, used heap | 115 MB | | | 108 MB |

Step by step, on the 30 s walk's snapshots: the faces alone took `host.actorSim` from 877 k to 229 k objects (2.97 M to 1.26 M edges;
the whole worker 7.69 M to 7.05 M objects, 42.2 M to 40.5 M edges), the per-mesh lists, payload views, group boxes and field
readers to 146 k (0.88 M edges), the creation record and the one-slot readers to the figures above. The family's 10.6 MB of native memory
(typed arrays' backing stores) is unchanged.

**Load time.** Three interleaved headless Island boots (bench-sim `bootMs`, the base arm an archive of 07de3088 with the same
Wasm): 7,147 / 7,180 / 6,861 ms before, 7,215 / 7,028 / 6,927 ms after: inside the spread. Both give the 3-tick digest
`c449c4831f1804dd`.

**What is left, and why.**
* The family is at 126 k objects (the aim was 150 k) and 0.74 M edges (the aim was 0.6 M). What is left in it:
  * Per binding, the closures of `meshBindingSteps` (`actor-mesh-sim.mjs`): 30 k closures over 313 bindings (96 a binding: the
    returned object's methods, the 24 helpers of the `try` block, the helpers of the generator's scope), 180 k edges, with their
    contexts (the generator scope has 72 slots, the `try` block's 41) and 787 out-of-object property arrays (34 k edges), about
    250 k of the edges in all.
    Removing them takes the binding as a class with its state as fields and the helpers as prototype methods (the work step 5
    describes for script bindings, here for ~900 lines of closure code); it is not started.
  * Script instances which this family reaches first through `binding.actor` (on the 30 s walk's snapshot: 19 k objects and 135 k
    edges, among them 2.5 k `Cell` objects, still 2.5 k after the roam): the script object model, not the mesh layer.
  * The decoded mesh payloads (88 meshes, 24 k objects: sequences with their notifies, name references, the typed arrays), shared by
    their bindings; the bindings' `Map`s (3.2 k Maps with their tables, 35 k edges); the 2.6 k `FieldReader` objects.
* Not changed: a binding's reduced-LOD lighting topologies (up to six `Uint32Array`s a binding, uploaded to the kernel each) could
  be shared per mesh and count.
* Not measured: the marking time per major GC on two cores, Firefox, the Mac. The whole worker has 9% fewer objects and 4% fewer
  references, a small step on the scale of steps 7 and 8; the family it empties was 11% of the worker's objects and 7% of its
  references.

## Steps 2 and 3's results (2026-10-29)

Host representation only: every change below keeps the values its readers see. Branch `worktree-agent-afe3513ed502b8fc4`, from master
07de3088; eight code commits, each checked as listed below.

**What V8 did to these structures.** Two costs the plan had set aside as "V8-only" were the largest single item.
* *Boxed integers.* A field whose shape has ever stored a heap number holds a heap number for every object of that shape. The first
  store came from `Reader.compact`: its `value += byte * 2 ** n` is a heap number in the interpreter whatever its value, so every
  export entry's `classIndex`, `superIndex`, `serialSize` and `serialOffset` (and every record copied from them, and every
  `readRef` index of the metadata) was an object of its own: 1.5 M of the worker's 8.2 M objects were heap numbers. Then one boxed
  `index` spread: object literals that start with the same keys (`{asset, index, entry, key}`, the metadata, the resource records)
  share a transition tree, and a value read back from a double-represented field (the map's `properties[].value`, a float field
  that also holds object references) is a heap number again, which `AssetStore.resolve` stored. In the browser the Smi range is 31 bits, so what the headless node run does not show:
  the synthetic record addresses (0x70000000 and up), the flag words with a high bit and the CRCs are heap numbers there.
* *Late-added properties.* An entry's `serialOffset`, `className` and `path`, the six flag booleans of a property's metadata and
  an import's `path` were added after the literal: an out-of-line property array each.

**What the structures were and what they are.** (The "What each structure is" section above describes the state at 07de3088.)

| Structure | Was | Is |
| --- | --- | --- |
| Export entry (`parsePackage`) | 4 heap numbers + a property array + the object | one object, every field in the literal, indices Smis (`Reader.compact` in integer arithmetic; also `compactDecode` of the property serializer) |
| Index of an identity, a metadata, a resource | a heap number once `assets.resolve` took one from a double field | `ref \| 0` where a table position enters (`AssetStore.resolve`, `exportIdentity`): a Smi |
| Class loader linker, per export | an object of 8 fields + a `hashNext` property | `LinkerExports` (`linker-exports.mjs`): the package's entries, an `Int32Array` of interned names, an array of created objects, an `Int32Array` hash chain; the FObjectExport slots the native services read are views (live: `object` and `hashNext` read and write the table), the export hash and VerifyImport's candidate scan read columns |
| DynamicLoadObject graph, per export | an object of 5 fields | the same table with the view FindExportIndex reads (`classIndex`, `outerIndex`, `nameIndex`, `nextHash`, `object`) |
| Property metadata | 36 keys, the export's bytes and its tail copied, a flag-bit table, two reference views | the same keys minus `serialized`, `extra`, `superField`, `next` (nothing reads them), one frozen flag-bit table per distinct flag word, the six booleans in the literal |
| Function, state, struct, class metadata | a copy of the script bytes, five UField prefix objects (marker, base, next, scriptText, name) | a view of the package bytes; the indices only; a function without FUNC_Net shares one `replication` |
| `record.function.script.children/parameters` | a second parse of every parameter's property metadata, kept | released once the parameters' identities are linked (`prepareFunction`) |
| `ScriptProcess.functions` | a Map filled by `prepareFunction`, read by nothing | stays a (now empty) Map for the identity check in `validate-script-process` |
| Null-Context result | an object + a `zero` closure and its context; a Map per body | the descriptor shares one `zero` function (`this`); a body with no result shares one empty Map |
| Load record `nativeAddress`, `address`, `objectFlags` | 2 or 3 heap numbers per record in the browser | start as `null`, assigned after the literal: V8 keeps the field tagged, a flag word is a Smi, the two addresses are one number |
| `recordsByAddress` keys | one heap number (the synthetic address) per record | a negative Smi ordinal for the synthetic range (the registered classes keep their native addresses) |
| Load record `instanceValues` | an empty Map + table on every record | `null` until a resource is constructed (or first written) |
| Load record `line`, `textPos`, `textPosition` | written beside the native slot by linker preload; only `slot()` read them, after the slot | slot only (an object without native slots keeps them) |
| Class defaults | a Map per class per field of the whole chain | an inherited field whose values are `Object.is`-equal to the base's shares the base's Map (nothing changes a defaults Map in place: a changed default replaces the class's entry) |
| Face-conversation baseline | a `[field, value]` pair array per property of every object the conversation list attached (71,000 arrays on the Island) | the class's field list (shared) and one array of values per object |

**Checks.**
* Fidelity, at every commit and on the final tree: `frame-alloc-meter --compare` identical on the Island (600 frames,
  `c8cf5fff928609c1`), the 747 (400, `f6337bff0cf741fc`) and Training (400, `e4b017e7b1bc0439`); `hud-stream-digest --stream
  --compare` identical (1500 frames, `16bfe2bd08ed1653`); bench-sim digests (300 ticks) Island `15e3720088490242`, Training
  `148077479825af78`, 747 `ad8e591a01434df5`.
* Differentials, old reader against new (ad hoc scripts, outside Git):
  * `parsePackage` on all 219 packages of Maps and System, Textures, Sounds and Music: 391,089 exports and 26,929 imports, every
    value and every key in order equal; the entries' `Object.is` of each field.
  * `readScriptMetadata` of 29,365 function, state, struct, class and property exports of the script packages: every key the new
    metadata has equals the old one's (the dropped keys are listed above).
  * The linkers' export tables: the Island's, Training's and the 747's class loader graph (20 linkers, 40,984 exports) and
    DynamicLoadObject graph (5 linkers, 74,248, 73,765 and 74,660 exports): every view field equals the per-export record's value,
    and the export hash rebuilt by the plain-array path of `buildLinkerExportHash` (the code the records ran through) gives the
    same heads and chains.
  * `cls.defaults` of every linked class against the unshared computation: 967 (Island), 910 (Training), 907 (747) classes, 219,386,
    203,784 and 201,263 fields, 0 mismatches; 75,126 of 90,212 entries of the Island are shared with a base.
* 863 unit tests (five new: `test/linker-exports.test.mjs`).
* Validators, one at a time (NATIVE_PROBE_PYTHON set), all exit 0: process-collection, original-loaded, original-lookups,
  script-process, linker-imports, linker-preload, class-loader, object-layout, inventory-spawn, weapon-construction,
  script-vm-interp, script-vm-x87, script-serialization, static-load-createexport, create-export, dynamic-load-object,
  font-load-graph, font-load, sound-load-graph, music-load-graph, mesh-load-graph, mesh-payload, texture-load, script-resources,
  sound-archive-integration, sound-period, galaxy-music-loader, -play, -update, gm-trench-play-anim, process-memory,
  object-image, map-actor-admission, script-state-queries, script-sound-admission, script-conversation-construction,
  script-conversation-events, script-datalink-transmission, script-string-operations, conversation-binding,
  instructor-conversation (the face baseline's reset), datalink-transfer-object, training-datalink-live, and the save, load and
  travel set: class-default-travel, level-save, load-game, load-saves (41 desktop saves), save-directory, save-game,
  save-info-corpus, save-snapshot, root-snapshot, travel, travel-restore, travel-restore-objects, travel-transitions,
  travel-endings, rotating-brush-save, restored-speech. The window, native-operator and gc-draw
  validators that read `readFunctionMetadata` also pass (window-lower, window-parent, native-at-string, native-chr,
  native-divide-int, gc-draw-icon, core-damage-primitives, native-object-log, window-text). `validate-linker-imports`' mutation
  anchors still hold (the module keeps the original comparison text); `validate-linker-preload` and `validate-process-collection`
  now read the export table through `exportRecord`, `exportObject` and `exportsHaveObject`.
* No Rust changed. A 60 s worker-mode Island roam (`hitch-run.mjs --mode roam`): 4,538 worker frames, 0 errors, 58.9 fps, no
  interval over 34 ms, no gap over 50 ms.

**Heap**, the Island's worker (Chromium, Linux), 240 s roam and forced GCs (`profile-live-heap.mjs --mode roam`), before the
snapshot of 07de3088 (`heap-island-r4-roam240`). "Pointer references" leave out the edges to Smis and to the snapshot's own number-value
strings (counted as in step 7); this Chromium's snapshots count each Smi as a node, so "objects" below include 96,000 (before)
and 184,000 (after) of them.

| | Objects | References (snapshot edges) | Pointer references | Heap numbers | JS heap (snapshot / used) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Before (07de3088) | 8.21 M | 45.3 M | 37.40 M | 1,495,000 | 340 MB / 352.7 MB |
| After | 6.09 M (-25.8%) | 38.2 M (-15.7%) | 31.28 M (-16.4%) | 301,000 | 292 MB / 303.7 MB (-14%) |

The 30 s walk (the quick snapshot) at an intermediate commit (1d718e05 plus the address keys, before the defaults and `instanceValues`
cuts) read 7.69 M to 5.78 M objects, 42.2 M to 35.3 M edges and 34.45 M to 28.49 M pointer references.

Per family of the task's list (`heap-families.mjs` depth 2, objects / edges; first-reach attributions, so a shared object can appear
under another family: `ScriptRuntime.instances.receiver` went from 171 k to 252 k objects while the total fell):

| Family | Before | After |
| --- | ---: | ---: |
| ScriptProcess.packageObjects.function | 630 k / 3.55 M | 258 k / 1.70 M |
| ScriptProcess.packageObjects.loadRecord | 498 k / 3.86 M | 356 k / 3.45 M |
| ScriptProcess.packageObjects.metadata | 275 k / 1.67 M | 41 k / 0.79 M |
| ScriptProcess.packageObjects.entry | 222 k / 0.82 M | 92 k / 0.44 M |
| AssetStore.ready.pkg | 471 k / 2.25 M | 230 k / 1.53 M |
| ScriptClassLoader.graph.linkers | 217 k / 0.87 M | 5 k / 0.12 M |
| ScriptClassLoader.graph.buildLinker | 75 k / 0.40 M | 41 k / 0.29 M |
| PreparedDynamicLoadGraph.linkers.exports | 166 k / 0.83 M | gone |
| host.disposeAudio | 148 k / 0.90 M | 111 k / 0.81 M |
| ScriptProcess.linkedClasses.defaults | 179 k / 0.62 M | 27 k / 0.31 M |
| Doors.scriptRuntime.faceConversations | 152 k / 0.61 M | 28 k / 0.18 M |
| ScriptProcess.packageObjects, PreparedDynamicLoadGraph.names, AssetStore.ready.exportsByPath, NameSpelling.entries | 95 k, 63 k, 42 k, 155 k | unchanged |

The listed families lose 1.84 M of the 2.12 M objects and 6.8 M of the 7.1 M references. `host.disposeAudio` is the decoded map's
property tags (`{name, type, struct, arrayIndex, value, decoded, byteLength}`, 44 k of them, and the actors' `values`) reached through
a closure of the host: the entries it held were the export entries of the sound packages.

**Load time.** The headless Island boot (`bench-sim`, interleaved pairs, the base arm an export of 07de3088's tree; both arms gave
the same 3-tick digest). Three pairs at load average 3: 7,763, 7,781 and 7,858 ms before, 6,970, 7,071 and 7,080 ms after. Three
pairs on the final tree at load average 8 (another session's runs): 8,888, 9,712 and 10,672 ms before, 10,184, 8,497 and 9,798 ms
after, medians 9,712 and 9,798, within the 1,800 ms spread of each arm. Not slower.

**The headless Island at each commit** (node, 60 ticks after a boot, forced GCs; node's Smi range is 32 bits, so the browser-only
heap numbers above are not in it): 6.35 M objects and 30.2 M edges at 07de3088; 5.19 M and 27.6 M after the integer fixes
(4f4a6c68); 5.04 M and 27.1 M with the export table; 4.81 M and 25.9 M with the metadata; 4.35 M and 24.4 M with the record,
defaults and children cuts.

**What is left.**
* `pkg.names` is one `{name, flags}` object per name (97 k on the headless Island, about 94 k in the worker) and `pkg.exports`
  one object per export (105 k): columns behind accessors would need the 130 reads of `entry.*` and the 46 of `names[i].name` (and the
  aliases of `pkg.names`) converted. Not done.
* The metadata objects of functions still have about 40 own keys (a property array each, and the `script` view); a function
  built as one literal, with the derived keys (`flags`, `size`, `repOffset`, `native`) on a prototype, would need the spread
  copies of `field.metadata` in `script-cleanup`, `script-values`, `script-struct-values` and `script-reference-serialization`
  to keep working.
* The alias properties linker preload writes beside each native slot (`flags`, `iNative`, `stateFlags`, ...; `flags` is still one heap
  number a record in the browser, 16 k) and the `NativeSlots` wrapper object (3 objects a record) remain.
* `contextResults` stay built at link (see step 2). The identities' late properties (`loadRecord`, `function`, `metadata`,
  `fieldPending`) are still a property array each (31 k): declaring them up front would trade the arrays for 5 undefined slots on every
  identity, more edges.
* The marking per major GC on two cores (the method of "Step 7's results") is not measured for this branch. By step 7's and 8's
  ratios (7.6% and 12% fewer pointer references for 13% and 10% shorter marking) 16% fewer would be expected to shorten it, which is
  a prediction.

### Steps 2, 3 and 4 on two cores

Master 3502f642 (steps 2, 3 and 4 merged) against 89bd1edd (07de3088 with the profiler's roam), the method of "The script VM and
world query cuts on two cores": four interleaved 300 s Island roams on two cores (`taskset -c 0,1`, `hitch-run.mjs --trace`), each
tree on its own dev server; 19,120 to 19,257 worker frames a run. V8's marking log was not captured this time (the runs left out
`DEBUG=pw:browser`, which forwards it), so the cycles are read from the trace alone with `scripts/gc-trace-cycles.mjs`: a cycle's
main-thread marking is the sum of the `V8.GC_MC_INCREMENTAL` events on the worker thread since the previous `MajorGC`, its atomic
pause the `MajorGC` event, and a GC frame is a worker frame over 100 ms with at least 20 ms of either inside.

The heap first (Island, 240 s roam, forced GCs; `.cache/perf/heap-island-r6-roam240`): the worker holds 5.33 M objects, 35.8 M
snapshot edges and 268 MB of JS heap, from 8.21 M, 45.3 M and 336 MB at 07de3088; the page's used heap is 106 MB (115 MB).

| run | worker major GCs | main-thread marking a cycle, mean (max) | atomic pause, mean | GC frames over 100 ms (longest) | other frames over 100 ms (longest) | first 20 s (longest) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 89bd1edd, 1 | 4 | 267 ms (285) | 46 ms | 10 (169 ms) | 2 (122 ms) | 3 (366 ms) |
| 89bd1edd, 2 | 5 | 224 ms (276) | 60 ms | 10 (326 ms) | 1 (143 ms) | 3 (348 ms) |
| 3502f642, 1 | 8 | 91 ms (251) | 40 ms | 7 (259 ms) | 4 (158 ms) | 3 (340 ms) |
| 3502f642, 2 | 4 | 113 ms (218) | 40 ms | 4 (215 ms) | 3 (203 ms) | 2 (429 ms) |

**The marking per cycle halves, the worst cycles do not.** With 35% fewer objects and 21% fewer edges the worker thread marks
91 and 113 ms a cycle on average against 267 and 224, and the GC frames over 100 ms fall from 20 to 11 in two runs. The cycles
are of two kinds on the merged tree: most finish in 68 to 154 short steps with 16 to 90 ms of main-thread marking, but four of
twelve (the memory reducer's at 111 to 120 s among them) still mark 170 to 251 ms in 33 to 48 steps, the base's kind (all nine
of its cycles: 132 to 285 ms in 43 to 83 steps), and those give the longest GC frames (259 and 215 ms against 169 and 326). Which
kind a cycle is was not traced to its cause; on two cores the concurrent markers share the cores with the page and the worker,
and how much of a cycle they take is the likely difference (the background marking events cannot be told apart by isolate in the
trace). One run had eight cycles against four or five on the others, every one of them cheaper.

**What else is long.** The first frames after the map's load are 340 to 429 ms on both trees, with no GC in them (the tick).
Frames over 50 ms without GC are more numerous on the merged tree (67 and 60 against 26 and 45), most in clusters where the
roam meets something (29 within 70 to 80 s in one run, 25 within 250 to 280 s in the other; the base's second run has 16 within
210 to 220 s); the worker's tick p90 is 12.4 and 12.5 ms against 11.1 and 11.9. An interleaved headless A/B (`bench-sim.mjs
--ticks 600`, four rounds a map, both trees on cores 4 to 7) gives equal tick medians on the Island (6.94 and 6.95 ms) and the
747 (1.78 and 1.73), Training 1.80 against 2.38 within a spread of 1.2 to 2.5 on both, and boots 0.1 to 0.7 s shorter: no tick
cost is established, and the next two-core A/B rechecks the 50 to 100 ms frames.

The merged tree's checks: the bench-sim digests (Island 15e3720088490242, Training 148077479825af78, the 747 ad8e591a01434df5),
`hud-stream-digest --frames 1500 --stream` (16bfe2bd08ed1653) and `frame-alloc-meter --compare` on the Island, the 747 and Training
are identical to 07de3088's; 877 unit tests pass; 30 validators of both branches' families exit 0 (class-loader,
class-loader-struct-bools, linker-preload, linker-imports, process-collection, script-process, script-vm-interp, script-vm-x87,
dynamic-load-object, font-load-graph, mesh-load-graph, static-load-object, create-export, end-load, script-serialization,
property-serialize-item, class-default-travel, config-persistence, native-config, load-saves (41 desktop saves), save-game,
save-load-play, travel, travel-endings, island-conversation, instructor-conversation, conversation-binding, mesh-faces, gpu-mesh,
play-hud), after the 31 mesh validators of step 4 on 243f2b2b.

## Step 9's results (2026-10-30)

**What the model held.** In the base worker's snapshot (07de3088, the Island after a 240 s roam; step 4 left these families as they were) the
decoded map and its collision hulls were three families:
* `CollisionWorld.bsp.model`: 490 k objects (245,905 Objects, 108,351 Arrays and as many element stores, 26,781 heap numbers), 2.18 M snapshot
  edges, 11.6 MB. That is `readModel`'s output: a node was an object with four arrays (plane, zone mask, zones, leaves: five objects), a vertex
  `{point, side}`, a surface an object with its `pan` array, a light map an object with four arrays, a render bound a box of two arrays, a
  leaf an object with its visible-zones array, and every point and texture vector an array of three.
* `CollisionWorld.bsp.hulls`: 191 k objects, 0.60 M edges. `BspCollider` made one hull per collision bound when the world was built: an object
  with `min`, `max`, `node`, a `planes` list (the compiled planes, six box planes, the bevels) and a `sweepPlanes` list, each plane an array
  of four doubles (91,571 arrays). `partitionPlanes` added one array per node (26 k objects) and `hullByBound` a Map.
* The page decoded the same `map.model` (and one more per mover brush) as objects too.

None of the hull structures is read in Play: with a compiled root (`rootOutside`, every map) `BspCollider.sweep` and `overlaps` call the
original model queries (`traceRay`, `traceExtent`, `modelPointCheck`) and reach the hulls only for a model with no root, which only unit-test
fixtures are. They were built for every collider at load and held for the level's life.

**The change.** Host representation only; every table holds the values the object reader gave.
* `src/unreal/bsp-model.mjs`: the model as typed tables, filled by `readModel` in the same read order with the same checks.
  * `nodes` is the original 64-byte FBspNode block (`BspNodes`: an Int32, a Float32 and a Uint8 view of one buffer; the plane, the two zone
    masks, `iVertPool`, `iSurf`, back, front, coplanar, collision and render bound, zones and vertex count and flags as bytes, the two leaves).
    It is the layout the Rust occlusion block, the brush tracker's memory, `fast-line-check.mjs` and the trace kernel's import already read, so
    the occlusion upload is one byte copy of the block, and the tracker's view of Level->Model (`lineModel()`, `collisionModel()`, which were a
    `Proxy` over node objects made at first read) is `MemoryNodes`: the same accessors over views of the kernel's memory, made again when it grew.
  * `Vec3s` (points, vectors: one Float32Array), `Surfaces` (eleven int words a surface), `Vertices`, `Zones`, `LightMaps` and `RenderBounds`
    (an Int32 and a Float32 view of one buffer), `Leaves`, and `leafHulls` and `lights` as Int32Arrays. Two zone values the old reader held
    outside a byte would have been truncated by the original's FBspNode (`BYTE iZone`) and by the occlusion upload; none of the 76,832 models of the
    game has one, and `readModel` now refuses it.
  * Each table's `at(i)` makes record `i` in the old object form and offers `map`, `forEach`, `filter`, `find` and iteration over those: cold readers
    (validators, exports, one-off tools) use them. `modelObjects(model)` makes the whole old form, `modelFromObjects(old)` goes the other way for
    fixtures (it refuses a value a table could not hold exactly: a plane that is not four float32s, a zone that is not a byte). `PolygonNodes`
    and `TrackedSurfaces` are the two other table shapes the host builds: a mover brush made of the tracker's polygons (`moverModelFromPolys`:
    the plane's offset is a double there, which a float32 table could not hold) and the tracker's model for the decal kernel (`trackedModel`,
    which was about 500,000 objects copied for one upload).
* Readers moved to the views (hot ones read `i32`/`f32`/`u8` and the node offset once per traversal): `traceRayFast` and its reference,
  `traceExtentJs`, `checkPoint`, `pointRegion`, `fastLineCheck` (which now has one path, the block, for the model and for the tracker), the
  moving-light filters and leaf lists (`dynamic-lighting.mjs`), mesh lighting and coronas' leaf lists, the strobe scan in `sim-session.mjs`,
  `lighting.mjs` (basis, `pointZone`, zones), `geometry.mjs`, the page's world build and mirrors, the detail table, `walkingSurfaceTextures`,
  the world-hit texture lookups, and the uploads: the occlusion block, `traceModelLayout` (the trace kernel's layout, from the block),
  the decal model (a counting sort of nodes by surface, points and vectors copied as words), the tracker's vectors and the zone block.
* `src/runtime/collision-hulls.mjs`: `BspCollider` builds its hulls at the first query that needs them, as typed arrays: a `HullSet`
  (`min`, `max`, `node` and `bound` columns; `planes` and `sweep` as two Float64Arrays with offsets per hull, holding the same doubles, computed by the same
  expressions in the same order, the box planes and the bevels included), `HullTree` (the box tree over hull indices, split as the object
  tree was so queries visit hulls in the same order) and the partition planes as one Float64Array. In Play they are never built; `status().hulls`
  reads `hullCount`, which counts the distinct collision bounds without building them.

**Checks.**
* References first, on the untouched tree (243f2b2b): frame-alloc-meter Island (600 frames, warm 900) `c8cf5fff928609c1`, 03_NYC_747 `f6337bff0cf741fc`,
  00_Training `e4b017e7b1bc0439`, `hud-stream-digest --frames 1500 --stream` `16bfe2bd08ed1653`. After: `--compare` reports identical frames on all four
  (and on 02_NYC_Hotel, 300 frames, `1631d9f98ba1623d`, against a copy of 243f2b2b), and bench-sim (300 ticks) gives Island `15e3720088490242`,
  00_Training `148077479825af78`, 03_NYC_747 `ad8e591a01434df5`.
  The meter found two mistakes the unit tests and the validators did not: `sim-host.mjs` caught a reader of the old form (`walkingSurfaceTextures`
  over the tracker's polygon textures) and reported "BSP occlusion unavailable", and the frames differed from frame 0; and the page's mover build
  (`polys.mjs`) raised "model.surfaces.flags is not a function" for every mover, which `validate-mirrors-play` caught as a missing surface on 02_NYC_Hotel
  (76 textures and 11,551 triangles against 80 and 11,973, "11 render issues"). Both are fixed; the page's world build (textures, triangles, render errors) is
  now identical to 243f2b2b's on 12 maps (Hotel, Training, Island, 747, Bar, Smug, Everett, Club, WanChai Market, Area51 Bunker, Ship, 04 Island).
* Differentials against the object forms, raw words (`Object.is` on every number): `scripts/validate-bsp-model.mjs` reads every Model export of every
  map of the game (76,832 models in 88 maps: 769,874 nodes, 401,470 surfaces, 11.06 M vertices, 1.19 M points, 89,462 vectors, 939 zones, 374,015
  light maps, 387,617 render bounds, 280,871 leaves, 2.90 M leaf-hull words, 4.27 M light references, 4.11 M triangles; 112 M fields) with the old reader
  (`test/helpers/model-reference.mjs`) and the new one, and compares every field and the fan triangulation. `scripts/validate-collision-hulls.mjs`
  compares the typed hulls with the object hulls (`test/helpers/collision-reference.mjs` is `BspCollider` of 243f2b2b) on 8 maps' level models
  and brushes, with and without a brush transform and root: 43,290 hulls, 1.40 M planes, 146,790 partition planes, and for 12,000 random boxes
  the candidates, the line-candidate walk (240,741 leaves in 6,000 walks), the sweeps (9,535 hits in 12,000) and the overlaps, all equal.
  `test/bsp-model.test.mjs`: 80 random compiled models (each table with special floats, full-range masks, random links) read by both readers, errors
  equal, the node block's byte layout, `MemoryNodes` over a kernel memory that grows, and random box fixtures through both colliders. 873 unit tests
  pass (877, 4 skipped); the fixtures of 14 test files and 20 validators build their models with `modelFromObjects`.
* Validators, each exit 0: bsp-occlusion, collision-kernel, tracked-collision, tracked-linecheck, fast-line-check-tracked, native-encroachment,
  native-walking, native-walking-surface, walk-kernel, pawn-nav, zone-kernel, native-zone, native-rays, native-brush-rays, native-level-points,
  native-owned-point, native-mover-push and native-rotating-brush (`--reuse`: the saved captures of the original replayed over the typed models),
  decal-attach, decal-order, brush-tracker, mirrors, child-frames, leaf-lights, coronas, coronas-tracked, texel-sphere, trace-kernel, dynamic-lighting,
  static-lighting, light-spatial, light-animation-rust, moving-light-effects, moving-lights-incremental, mover-light-maps, dynamic-light-mover,
  mesh-lighting, mesh-light-types, detail-pass, detail-pass-rust, sky-frame-camera, frame-projection, frame-projection-movers, occlusion-flat-draw,
  level-save (120 saved levels: the Model payloads write back byte for byte); in the browser (worker mode) decals-play (the shadow and the mover's bullet
  hole through the tracked model), mirrors-play, mover-push-play, coronas-play, coronas-mover-play, iterator-frames-play, moving-light-effects-play,
  mesh-lighting-play, decal-vertices-play, world-batches. `validate-world-batch-gpu` times out at its first wait in both trees (a copy of 243f2b2b too).
  `validate-native-mover-scene` and `-far-move-scene` were not finished: their oracle runs (one Python process each) took more than 25 minutes and were
  stopped; the same level-query code ran in the other native validators. `validate-master-frame-play` was skipped as asked.
* `npm run build:wasm`: no Rust file changed, no cargo warnings. 60 s worker-mode roams (`hitch-run.mjs --mode roam`): Island 4,867 frames and Training
  4,771, no error in either.

**Heap**, the Island's worker after a 240 s roam and forced GCs (`profile-live-heap.mjs --mode roam --seconds 240`). "Before" is step 4's "after" row
(master 243f2b2b is its merge; the routes of the two roams differ). Pointer references leave out the edges to Smi nodes and the weak edges (the method of
`.work/pointer-refs.mjs` gives 38,992,545 on the 07de3088 snapshot, step 4's 39.0 M).

| | Objects | References (snapshot edges) | Pointer references | JS heap (used of total) |
| --- | ---: | ---: | ---: | ---: |
| Worker, before (243f2b2b) | 7.48 M | 43.3 M | 37.3 M | 312 of 323 MB |
| Worker, after | 6.71 M (-10.3%) | 40.0 M (-7.6%) | 34.6 M (-7.2%) | 287 of 300 MB |
| BSP model tables, before (07de3088: `bsp.model`, `bsp.hulls`, `bsp.partitionPlanes`) | 707 k | 2.8 M | | 11.6 MB (model only) |
| BSP model tables, after (20 models) | 826 | 2,550 | | about 3.7 MB of typed arrays |
| Page (walk), before (07de3088) | 2.39 M | 10.8 M | 8.97 M | 109 MB |
| Page (walk), after | 1.87 M (-21.8%) | 8.5 M (-21.4%) | 7.24 M (-19.3%) | 94 MB |

The tables' row counts the instances of the table classes in the snapshot (`.work/count-tables.mjs`: 20 `BspNodes`, 40 `Vec3s` and 20 each of the other tables: the level's model and 19 mover brushes, and one `MemoryNodes`,
the tracker's view) and everything they reach
through their typed-array views and buffers, so the worker's whole decoded map, hulls included, is 826 objects and 2,550 edges; no `CollisionWorld.bsp.*`
family is left (the aim was under 20 k objects and 0.1 M edges). The page's tables, 18 of its mover brushes' polygon models included, are 843 objects and
2,592 edges and 3.7 MB. The 30 s walk gives the same picture: worker 6.21 M objects, 36.9 M edges, 272 MB; page 1.87 M objects.

**Load time.** Three interleaved headless Island boots (bench-sim `bootMs`, the base arm a copy of 243f2b2b with the same Wasm): 7,472 / 7,051 / 7,391 ms
before, 7,224 / 6,988 / 6,975 ms after (the hulls and the partition planes are no longer built). Both give the 3-tick digest `c449c4831f1804dd`.

**What is left, and why.**
* Not measured: the marking time per major GC on two cores, Firefox, the Mac. The worker has 10% fewer objects and 7% fewer pointer references than at the
  end of step 4, a step on the scale of step 4's; the three families it empties were 9% of the worker's objects and 6% of its snapshot edges.
* Cold readers still use the object form: the page's per-surface lighting records keep a `surface` and a `lightMap` object each
  (`lighting.mjs surface()` makes them with `at(i)`; 18,602 records on the Island), and the page decodes the BSP's `map.triangles` list as objects
  (110 k on the Island; step 2 of the plan releases it after the world build). The tracker's model for the decal kernel is copied once when a store
  is made (`trackedModel`), as typed tables now, not 500 k objects.
* The hulls are dead code in Play. They could be dropped with the legacy sweep branches once the unit-test fixtures use compiled roots; this step keeps
  them as the reference that `validate-collision-hulls` compares with the original's hull data.
* Unverified: `validate-native-mover-scene` and `-far-move-scene` against the original (see above); the Rust kernels' import of tracked nodes is
  unchanged and covered by `validate-tracked-collision` and `validate-tracked-linecheck`.

## Step 5's results (2026-10-30)

Host representation only: every change below keeps the values its readers see. Branch `worktree-agent-a6895f0594ffa7de5`, from master
3502f642; ten code commits and a test commit, each checked as listed below.

**What the families held.** In the base worker's snapshot (3502f642, the Island after a 240 s roam: 5.33 M objects, 35.8 M snapshot
edges, 268 MB; the families are the coordinator's listing of it, outside Git):
* `ScriptRuntime.instances.bindings`, 340 k objects and 1.80 M edges: the native-bound fields of about 12,000 script objects (2,425
  map actors, the rest the objects the conversation list loads and objects constructed natively). 72.5 k binding objects
  `{get, set}`, 80 k getter and 47.5 k setter closures, 61.5 k contexts and 12.6 k Maps. Five bindings of an object are its UObject
  header (ObjectFlags, Outer, Name, Class, ObjectInternal), the same for every object: their closures captured only the native object
  or the instance, so about twenty objects an object (a binding object and two closures a field, a context) held nothing that
  differs from one object to the next.
* `ScriptRuntime.instances.receiver`, 315 k and 2.00 M: the map actors' hosts and the views over them. 56.7 k AccessorPairs, 128 k
  closures and 12.5 k contexts. The image-backed members of a map actor (pose, mirror, link and flag-word installers: 24 a host) were
  each a getter and a setter closed over that host's entry, with a context; the pawn views (`_pawnPhysics`: about ninety accessors
  each: 19 k objects in the 30 s walk; in the roam, before this step reached them, 125 k under the receivers and 43 k under the
  identities) and the spawned actors' collision views did the same.
* The cells: `ScriptProcess.linkedClasses.cells` 76 k objects with 37 k heap numbers, and 91 k with 35 k under
  `CollisionWorld.actors.<symbol ScriptRuntime instance>` (the same Cell objects, first reached through an actor): the `mask` field.
* Related, by the same mechanisms: `identities.get touching` 37 k (four element accessors on each host's Touching array),
  `identities.initialProperty` 65 k (a copy of the class's defaults Map per actor, and a Map per authored property),
  `ScriptRuntime.instances.state` 66 k (a locals Map and a frozen probe-mask array per object), `ScriptRuntime.instances.slots` 24 k.

**What V8 did.**
* *A boxed bit mask.* A bool's cell holds its bit mask. With bit 31 set (`entry.mask | 0` is -2147483648) it is not a Smi in the browser
  (31-bit Smis), so the `mask` field of every Cell had the Double representation and each of the 77 k cells held its own boxed
  number, the masks that are zero included. Node's 32-bit Smis do not show it. Storing `null` first in the constructor makes the field
  tagged: a small mask is a Smi, and only the masks that are not Smis (bit 30 or 31: 280 cells in the 30 s walk's snapshot) are boxed.
* *A closure pair per member.* Every `Object.defineProperty(host, name, {get: () => entry.get(), ...})` made two JSFunctions and their
  context, kept alive by the host's AccessorPair. Accessor functions made once and finding the host's state through `this` leave
  the pair itself: V8 makes an AccessorPair for each accessor property of each object (88.6 k in the 30 s walk's base snapshot, 88.9 k
  after), so the saving is the functions and contexts (the worker's closures fell from 417 k to 169 k and its contexts from 218 k to
  77 k in that walk), not the pairs.
* *Late tables.* An empty Map for the locals of every state (11 k) and for every object's slots (12 k), a frozen two-word array per state
  for its probe mask, and one Map per authored property were made for objects that never use them or hold one element.
* *The measurement server keeps the first transform of each module* when it does not watch files (the dev server of
  the heap snapshots is started with `watch: null`). A snapshot taken after an edit needs a restarted server: this step's second snapshot, taken on the same server as
  its first, repeated the first one's numbers.

**What the structures were and what they are.**

| Structure | Was | Is |
| --- | --- | --- |
| Header bindings of a native object | `{get, set}` + two closures a field, one context an object | `NATIVE_HEADER_BINDINGS` (`script-bindings.mjs`): five frozen objects for every object; `get(instance)`, `set(value, instance)` read the instance's `nativeObject` |
| Header bindings of a loaded object (`prepareLoadedObject`) | five `immutable()` closure pairs and contexts | `LOADED_HEADER_BINDINGS`: five frozen objects; the reference and the resource are two fields of the instance |
| `Actor.Level` and `LevelInfo.NetMode` of a map actor; the mirror wrapper | closures in `makeBinding`'s context; a wrapper with a `write` closure | `RecordLevelBinding`, `RecordNetModeBinding`, `MirroredBinding` (get/set on the prototype; `mirror` and `mirrored` as before) |
| A window object's native member | read/write closures, a context, a clone of the layout entry | `FieldBinding` (`script-window-host.mjs`) |
| `fieldReference` of a bound field | `propertyReference(field, binding.get, binding.set)`, the functions detached | `storageReference` over a `BindingStorage` (the binding and its instance) |
| Pose, mirror, link and flag-word members of a map actor host | a getter and a setter closure and a context a member | functions shared by every host, made once for a slot symbol and an index (`host-accessors.mjs`), finding `this[slot][index]`; the entries arrays are indexed by the spec's position; the four Touching element accessors share their pairs and find their link through a symbol of the array |
| A spawned actor's collision view | 23 members, the Touching array's four, `values`' six: closures and contexts | shared functions over a `CollisionView` (`get(name)`, `put(name, value)`, the lazily bound entries); `ScriptRuntime.boundField` returns a `BoundField` object |
| A map pawn's physics view | about ninety members, a closure pair each, a context for each `bind()` | shared functions over an access object (`ACCESS`); `RegionBinding` is a class; the view's methods are still closures |
| `Cell` | the mask a boxed number; one cell for every class and property | the mask tagged; a leaf cell (scalar, pointer, vector, rotator) is one object for a property and every class that has it (`sharedCell`), its `ref` never read; struct members and `Actor.Base` stay a class's own |
| `Pose.stored` | the image value of each of a host's five pose members | only OldLocation's (its fallback is the only reader) |
| An object's defaults as of its attachment | a copy of the class's Map each (`new Map(cls.defaults)`) | one copy for the objects attached while the class's entries are the same ones (`class-defaults-snapshot.mjs`, compared entry by entry) |
| The elements a map authors of a property | a `Map` | element 0 alone is the bare value; an `AuthoredElements` for more |
| `ScriptState` | a locals Map each; a frozen array per probe mask | the Map made at the first frame; one frozen array per value |
| `ScriptInstance.slots` | a Map each | made on first use |

**Checks.**
* Fidelity, on the final tree: `frame-alloc-meter --compare` identical on the Island (600 frames, warm 900, `c8cf5fff928609c1`), the 747
  (400 frames, `f6337bff0cf741fc`) and Training (400 frames, `e4b017e7b1bc0439`); `hud-stream-digest --stream --compare` identical
  (1500 frames, `16bfe2bd08ed1653`); bench-sim (300 ticks) Island `15e3720088490242`, Training `148077479825af78`, 747
  `ad8e591a01434df5`. The references were written on the untouched worktree first. The Island's and Training's digests were also
  checked at the intermediate commits.
* Differentials: `test/collision-view.test.mjs` (the spawned actor's view of 3502f642 verbatim in
  `test/helpers/collision-view-reference.mjs` against this one, over logging storage, 12 combinations of bound/unbound, motion word and
  actor/pawn/projectile: the same members in the same order with the same attributes, the same values and the same storage calls;
  reading the old version for it showed that its four collision booleans (`collideActors`, `collideWorld`, `blockActors`,
  `blockPlayers`) were given a function where a descriptor belongs, so they are non-writable `undefined` members; they remain so).
  The pawn view, ad hoc and outside Git: the old file against the new over logging services, four
  variants of services and class ancestry, 376 member reads and writes with the same attributes, values and storage calls (the
  image-backed branches are covered by the digests and validators below). Unit tests for the new modules
  (`test/script-bindings.test.mjs`, `class-defaults-snapshot.test.mjs`, the state cases in `script-state.test.mjs`): 902 tests pass.
* Validators, one at a time, each exit 0 (NATIVE_PROBE_PYTHON set; the pawn and spawned-actor commits came last, so the first batch,
  on the tree without the bound-field commit, was followed by a second of the validators that spawn or move actors, on the final
  tree): script-vm-interp, -x87, script-process, class-loader, property-destroy, cleanup-destroyed-live, native-actor-physics,
  native-walking, walk-loop-kernel, rider-move-kernel, pawn-nav, mover-push-play, native-mover-scene (37 cases, no mismatch),
  triggers, window-computer, window-parent, keypad, play-hud, save-game, save-load-play, save-snapshot, level-save (128 saved
  levels), load-saves (41 of 41 slots), travel, travel-restore, travel-restore-objects, travel-transitions, travel-endings,
  island-conversation, instructor-conversation, conversation-binding, object-image, script-frame-ownership, actor-tick-kernel,
  script-lifecycle, script-cleanup, script-serialization, script-struct-values, name-spelling, class-default-travel, native-config,
  config-persistence, map-actor-admission, script-startup, script-spawn, script-spawn-touching, script-scripted-actor-spawn,
  mission-timer, crowbar-crate, item-pickup, decoration-settle-roll, plant-push, world-destroy and decals-play (in the worker-mode
  page); root-snapshot ran on the first batch's tree. `validate-lodmesh-lod-play` and the other known reds were not run.
* A 60 s worker-mode Island roam (`hitch-run.mjs --mode roam`, with validators running beside it): 4,685 frames in 61.7 s, 59.4 fps,
  0 errors, no gap over 50 ms (interval p99 16.8 ms, worker p50 12.0 ms, p95 17.6 ms); the run before the pawn and spawned-actor
  commits: 4,661 frames, 0 errors.
* No Rust changed (no `npm run build:wasm` warnings to check).

**Heap**, the Island's worker after a 240 s roam and forced GCs (`profile-live-heap.mjs --mode roam --seconds 240`, `heap-families.mjs`;
the two roams turn at random, so their routes differ). "Pointer references" leave out the edges to Smis and the weak edges
(`.work/tools/pointer-refs.mjs`, outside Git); this Chromium counts each Smi as a node, so "objects" in the closure counts further
down are heap-snapshot nodes.

| | Objects | References (snapshot edges) | Pointer references | JS heap (snapshot / used) |
| --- | ---: | ---: | ---: | ---: |
| Worker, before (master 3502f642) | 5.33 M | 35.8 M | 29.63 M | 268 MB / 265 MB |
| Worker, after | 4.29 M (-19.5%) | 30.1 M (-15.9%) | 24.30 M (-18.0%) | 236 MB / 233 MB (-12%) |
| `ScriptRuntime.instances.bindings` | 340 k / 1.80 M | | | 39 k / 0.26 M |
| `ScriptRuntime.instances.receiver` | 315 k / 2.00 M | | | 104 k / 0.81 M |
| Both | 655 k / 3.80 M | | | 143 k / 1.07 M |

The aim was the two families under 0.25 M objects and 1.2 M edges together: they hold 143 k and 1.07 M. The worker's closures fell from
652 k to 218 k, its contexts from 304 k to 78 k, its heap numbers from 301 k to 208 k; its AccessorPairs from 165 k to 143 k.

Other families of the task's list (objects / edges, base roam to final roam; the first-reach attribution moves members between
families): `CollisionWorld.actors.<symbol ScriptRuntime instance>` 91 k / 0.76 M to 17.7 k; `ScriptProcess.linkedClasses.cells` 76 k / 0.68 M
to 13.2 k; `identities.get touching` 37 k to gone (the hosts' element accessors share their functions; 19 k under
`identities.<symbol actorLinkFields>`, the pairs among them); `ScriptRuntime.instances.state` 66 k to 20 k; `identities.initialProperty`
65 k / 0.56 M to 25 k / 0.17 M; `ScriptRuntime.instances.slots` 24 k to gone; `identities._pawnPhysics` 19 k (30 s walk) / 43 k (an earlier
roam) to 13.7 k. Unchanged: `identities.properties` 83 k, `identities.values` 25 to 34 k, `ScriptRuntime.instances.refs` 33 k.

Step by step, on the 30 s walk's snapshots (4.79 M objects, 32.5 M edges, 26.37 M pointer references and 248 MB at 3502f642): the
bindings, the host accessors, the cell masks and the shared defaults copy took the worker to 4.25 M, 29.6 M and 233 MB; the state,
slots, authored, cell sharing and pose changes to 4.08 M objects, 28.5 M edges, 22.75 M pointer references (-13.7%) and 225 MB. The
pawn and spawned-actor views and the bound fields (the roam creates them, the walk hardly: about 11,000 resolved fields of spawned
actors in the roam) took the 240 s roam from 4.60 M objects, 31.8 M edges, 25.84 M pointer references and 244 MB (the roam before
those commits) to the figures above.

**Load time and speed.** Three interleaved headless Island boots (`bench-sim`, 300 ticks; the base arm an export of 3502f642 with the
same Wasm; both arms give the 300-tick digest `15e3720088490242`): on a loaded host (another session's runs) boot 7,670 / 7,234 /
7,630 ms before, 7,358 / 6,723 / 6,967 ms after, the simulation's CPU per tick 13.25 / 12.48 / 14.14 ms before and 11.71 / 13.87 /
12.49 ms after; on the final tree on a quiet host boot 6,735 / 6,202 / 6,025 ms before, 6,642 / 6,172 / 6,004 ms after, CPU per
tick 10.98 / 9.75 / 9.68 ms before, 9.36 / 10.91 / 9.49 ms after: not slower, inside the spread. The headless Island (node, forced
GCs after the boot) holds 355.7 MB used before and 309.0 MB after.

**What is left, and why.**
* The hosts' AccessorPairs: V8 makes one for each accessor property of each object, so a map actor still holds 24 (about 58 k) and a
  pawn view about ninety. They go only with the accessors on a shared prototype, which means hosts built from a class: the host
  literals are made in `map.mjs` and `game.mjs`, and an enumeration of a host (`Object.keys`, a spread) would lose the members.
  Not started.
* The entries behind those accessors: 14 objects a map actor (5 `Pose`, 4 `Mirror`, 2 link, 3 `FlagWord`, their arrays), 40 k on
  the Island. They could be one object a host, or per class with the instance read through `this`.
* A pawn view's ~35 methods are closures over its local readers (the 15.6 k anonymous closures of the receiver family in the last roam).
  Converting them means the view as a class with its state as fields (the work "Step 4's results" describes for the
  mesh bindings).
* `instance.bindings` is still a Map for each of the 12 k objects (24 k objects, 0.2 M edges), holding five shared entries. A shared
  immutable header table with copy on write would drop most of it; every writer (`bindProperty`, the window host, three validators)
  would go through one method.
* `identities.properties` (83 k, 0.51 M edges, the decoded map's property tags, read only by `prepareMapProperties`): each is an object with a
  late-added `byteLength` (a property array each, from the spread in `map.mjs:17`). Not this step's file.
* `ScriptRuntime.instances.refs` (12 k arrays and their element stores: every class has a reference slot), the Touching arrays' four
  AccessorPairs each (7 k), the `latent` and `cursor` accessors of each running state frame (1.4 k pairs), and `identities.values`'s
  boxed floats and accessors.
* The marking time per major GC on two cores is not measured for this branch. By step 7's and 8's ratios (7.6% and 12% fewer pointer
  references for 13% and 10% shorter marking) 18% fewer pointer references would be expected to shorten it, which is a prediction.
  The Mac and Firefox are not measured.

## Open

* **How the pauses follow the heap.** Step 1 (above) shows that bytes and leaf objects do
  not set the marking time. In Chromium's worker on two cores, step 7 (11% of the objects,
  7.6% of the pointer references) shortened the marking per major GC by about 13%, and
  step 8 (13% of the objects, 12% of the pointer references) by about 10% more, but not
  the longest frame yet: the worker does its share of a cycle's marking in one or two
  frames ("The two-core long frame"), and 20% less allocation per frame moved part of it
  from the first frame to the second without spreading it further ("Allocation and the
  long frame"). Whether the two steps shorten Firefox's escalated slices is not measured.
  The claim that the heap's size class matters (SpiderMonkey's default incremental limit is smaller for
  heaps over 500 MB) is still unchecked: the inline heap went from 596 to 404 MB and
  the slices escalated the same.
* **The allocation thresholds on the worker.** The 0.8 and 0.5 MB a frame come from the synthetic. The worker is now at 1.4 MB a
  worker frame (1.7 MB a drawn frame), and on two cores its cycles still give two frames over 100 ms ("Both cuts on two cores"),
  as the synthetic says at that level; the thresholds themselves are placed only once a cut takes it under 0.8 MB. Firefox
  inline is not measured against allocation.
* **What remains of the two-core freezes.** "The script VM and world query cuts on two cores": with the worker at about 0.6 MB
  a frame (from 1.6 two cuts ago) the major GCs are as many as before (five in five minutes, set by the memory reducer and the
  32 MB slack after each cycle), and most still mark 180 to 250 ms on the worker's thread within two to four frames: frames over
  100 ms are as many as on 76495d62 (14 against 14), the longest shorter (192 and 281 ms against 302 and 295). Cutting allocation
  further does not reach them; what is left is the marking of the worker's 0.5 GB live heap, which only a smaller heap (the
  simulation's data in Wasm memory, fewer objects and pointers) shortens. Step 4 ("Step 4's results") took 730 k objects and 2.0 M
  references out of the worker (the actor mesh faces, per mesh now), and "Steps 2 and 3's results" took its pointer references down
  by a further 16% (37.4 M to 31.3 M) and its objects by 26%. "Steps 2, 3 and 4 on two cores": together they halve the worker's
  main-thread marking a cycle (267 and 224 to 91 and 113 ms) and the GC frames over 100 ms (20 to 11 in two runs), but a third of
  the cycles still mark 170 to 250 ms within a few frames. Step 9 ("Step 9's results") then took 770 k objects and 2.7 M pointer
  references (the BSP model and its hulls, as typed tables) out of the worker; and step 5 ("Step 5's results") a further 18% of the pointer references (29.63 M to 24.30 M on its own branch) and 19% of the
  objects; their marking on two cores is not measured yet. The Mac (twelve cores, where the concurrent markers take more of it)
  and Firefox inline are not measured against these cuts.
* **Allocation during a mark.** How much of the escalation the per-frame ArrayBuffer
  churn drives (the TOO_MUCH_MALLOC triggers) is unmeasured.
* **Measured on one machine.** All of it is from the Linux host. The Mac (the
  performance reference) and Safari are not measured.
* **Approximate families.** Family sizes are first-reach attributions. A structure
  reached first through an alias (a debugging hook, a WeakMap entry) can show under
  another name; `--sample` shows the path.
