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
  worker's snapshot is about 2 GB.
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

**The decoded map in the simulation.** There is one `map.model`, not copies:
`CollisionWorld` (`game.mjs:47`), the player scene's `level`, the level queries and the
kernels' uploads all start from it. A node is about five objects (plane, zone mask,
zones, leaves). `BspCollider` adds one hull per collision bound. The Rust kernels
(OccludeBsp, decals, traces, the brush tracker) already hold Wasm copies, but the
JavaScript readers of `model.nodes[i]` remain. Whether the legacy `BspCollider` sweep
(`player.mjs`, `doors.mjs`) still runs per tick in Play is unverified.

**Actor mesh faces.** `actor-mesh-sim.mjs:191` reads each binding's faces through
`readLodMeshSurfaces` (`lodmesh-materials.mjs:56`). A face is
`{wedges, vertices, uv[3], material, flags, texture}`, about nine objects. Nothing
shares them between bindings of the same mesh. The topology already exists typed
(`lodMeshTopology`, `faceWords`).

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
2. **Copies nothing reads (both realms).**
   * Drop `metadata.serialized`.
   * Drop the per-function bytecode copy once decoded; the package bytes stay.
   * Remove the `ScriptProcess.functions` Map.
   * Build `contextResults` at the first None receiver instead of at link.
   * Release `map.triangles` after the world build on the page.
   * Expected: a few hundred thousand objects and their buffers. Each removal needs a
     reader check across `scripts/` validators too.
3. **One export table.** The class loader's linkers and `PreparedDynamicLoadGraph`
   read `pkg.exports` (or columns built from it) instead of copying each export.
   They keep only their own mutable parts (the created object, the hash chains) as
   typed arrays and one array of objects.
   * Expected: about 1 M objects in the worker, plus the page's share.
   * A later, larger step makes `pkg.exports` itself columnar behind accessors, since
     about 130 reads use `entry.*`.
4. **Mesh faces once per mesh.** A per-mesh typed face block (the existing
   `faceWords`, plus UVs and material indices) shared by every binding of a mesh,
   cached per mesh.
   * Readers to convert: `mesh-lighting-view.mjs`, `meshFaceGroups`,
     `actor-umesh-sim.mjs`, and the page's `actor-mesh-draw.mjs`.
   * Expected: about 0.8 M objects on the Island; it grows with the actor count.
5. **Bindings without per-object closures.** A binding becomes one object whose
   getter and setter live on its prototype, or a handler table per field key. Callers
   that take `binding.get` detached (`script-runtime.mjs:1345`) are adapted.
   * Expected: about 0.5 M objects.
6. **Class defaults once.** `cls.defaults` keeps only defaults that changed after
   load. Reads fall back to the load record's defaults and the class image.
   * Expected: 0.3 to 0.5 M objects. This touches spawn, `defaultValue`,
     `classDefaultReference` and `refreshConfigDefaults`.
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
9. **The BSP model as typed arrays in the simulation.** Nodes, vertices and surfaces as
   column arrays, and the JavaScript readers moved to them or to the Rust kernels that
   already hold Wasm copies (point region, zone, line checks, hull build).
   * Expected: 1 to 2 M objects on the Island; it scales with the map.

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
* **Whether the major GCs are rarer and the cycles shorter.** "Cut: promoted garbage" takes the old generation's growth from 8.6 to
  13.4 MB/s down to 1.6 to 3.5 MB/s and the scavenger's promotion from 133 to 28 KB a worker frame, which should lengthen the
  interval between major GCs by the same ratio (no major GC in a 93 s run, one at 79.9 s on master). The two-core cycle trace
  was not rerun, and a cycle's length and its longest frame are not changed by this cut.
* **Allocation during a mark.** How much of the escalation the per-frame ArrayBuffer
  churn drives (the TOO_MUCH_MALLOC triggers) is unmeasured.
* **Measured on one machine.** All of it is from the Linux host. The Mac (the
  performance reference) and Safari are not measured.
* **Approximate families.** Family sizes are first-reach attributions. A structure
  reached first through an alias (a debugging hook, a WeakMap entry) can show under
  another name; `--sample` shows the path.
