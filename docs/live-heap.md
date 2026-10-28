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
  `lowered.nodes`, `memberCaches`.
* Each function also keeps a copy of its bytecode (`src/unreal/script-metadata.mjs:136`),
  though the package bytes hold the same.

**Package objects.** `ScriptObjects.exportIdentity` (`script-objects.mjs:60-72`) mints
one identity per export. `metadata`, `function`, `loadRecord` and the like are added
later. Four pieces of what it holds:
* `metadata.serialized` is a copy of every property export's bytes
  (`script-metadata.mjs:294`). Nothing in `src` reads it.
* A load-graph record keeps a `nativeSlots` Map with a `{value, width}` object per
  slot, about ten per record. 100 uses across 22 files read it directly, not only
  through `slotOf`.
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
7. **Load-graph records without slot objects.** `nativeSlots` becomes parallel arrays
   per record, or typed storage for the numeric slots. `loadEdges` becomes typed edge
   lists over record ordinals.
   * Expected: 1.5 to 2.5 M objects.
   * Touches the 22 files that read `nativeSlots` directly. Verify with the class-graph
     validators (`validate-process-collection`, `validate-original-loaded`,
     `validate-original-lookups`, `validate-script-process`, `validate-linker-*`).
8. **Bytecode trees released after lowering.** Key the node caches by (function,
   offset) instead of node identity. Keep operands as handle arrays per function.
   Drop a function's decoded tree once the Rust VM has lowered all of it, and decode
   again from the package bytes when the JavaScript path needs a node.
   * Expected: most of the 2.6 M objects.
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

## Open

* **How the pauses follow the heap.** Step 1 (above) shows that bytes and leaf objects do
  not set the marking time. Whether removing pointer-rich structures shortens the
  escalated slices, and by how much, is open until a step from 3 to 9 is measured.
  The claim that the heap's size class matters (SpiderMonkey's default incremental limit is smaller for
  heaps over 500 MB) is still unchecked: the inline heap went from 596 to 404 MB and
  the slices escalated the same.
* **Allocation during a mark.** How much of the escalation the per-frame ArrayBuffer
  churn drives (the TOO_MUCH_MALLOC triggers) is unmeasured.
* **Measured on one machine.** All of it is from the Linux host. The Mac (the
  performance reference) and Safari are not measured.
* **Approximate families.** Family sizes are first-reach attributions. A structure
  reached first through an alias (a debugging hook, a WeakMap entry) can show under
  another name; `--sample` shows the path.
