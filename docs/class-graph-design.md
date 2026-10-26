# Design: one class graph per process, collected at LoadMap

Status: design, 2026-10-26. Nothing here is implemented. It builds on the
original's behavior recorded in [class lifetime](class-lifetime.md) and on
the costs measured in [load time](load-time.md).

## What the original does

One process loads script classes and keeps them across map changes. Each
LoadMap does the following:

1. It loads the next level. Every class the level uses is found already
   loaded or is loaded now.
2. It tags the old level's actors and collects garbage
   (`CollectGarbage(RF_Native)`, Engine `0x1038d1e1`).
3. The collection purges every class that nothing reachable references.
   That is the old level's own classes, 28 to 95 per map change in the
   probe. About 1,000 classes keep their identity for the whole session.
4. A purged class that a later level uses loads again as a new object, with
   the package's defaults and a class name counter (`ClassUnique`) at 0.
5. Then the level's begin-play passes run, and SpawnPlayActor.

The counters show this directly (probe `gc1`: DX.dx → 00_Training →
01_NYC_UNATCOIsland → 00_Training):

| Spawned names | DX.dx | 00_Training | Island | 00_Training again |
| --- | --- | --- | --- | --- |
| Shadow | 0 | 1..19 | 20..72 | 73..91 |
| NanoKeyRing | 0..1 | 2..3 | 4..5 | 6..7 |
| AugmentationManager, SkillManager, BarkManager, DeusExRootWindow | 0 | 1 | 2 | 3 |
| LaserProxy | 0 | none | 1..8 | none |

The Island's Shadow20..72 and LaserProxy1..8 are the numbers the Stage 5
live captures hold ([Stage 5 exit criteria](stage-5-exit-criteria.md),
"A load-made actor's name does not name the original's object").

## What Play does today

Each level is a new `ScriptRuntime` (`script-doors.mjs:522`) with its own
load graph, class loader, identities, Rust VM and arena. A map change
re-serializes and re-links every class the level uses: 967 for the Island,
910 for Training. About 1.5 s of each cold load (1,482 ms on the Island,
1,658 ms in Training) is a readiness pass. It prepares every Function and
State of Core, Engine, Extension, ConSys and DeusEx (`script-doors.mjs:2305`),
which links 607 to 691 classes. Some of these the original never loads in
that level, such as AnnaNavarre and TracerTong in Training. The prepared
bodies of classes that the original has not loaded name them, and
`prepareClassOperands` (`script-runtime.mjs:724`) links every class a body
names.

Then Player start runs LoadMap over the same map again. That spawns a second
generation of load-made actors (Shadow53..105 on a cold Island).

Class defaults written in one level are carried by the travel request
([travel](travel.md#class-defaults-across-a-travel)). Name counters restart
at 0 in every level.

## Two kinds of state

The design rests on separating two things that today's runtime mixes.

* **The original's state** is what the original process holds and a script
  can observe:
  * loaded objects (classes, their functions, states and properties,
    resources, packages, linkers) and their native slots;
  * a class's Defaults block and its `ClassUnique` counter;
  * GConfig, FNames, and the objects the game constructs.

  It exists from the original's load of an object to the collection that
  purges it.
* **Host readiness** is what Play computes so that its synchronous VM can
  run a body when the original would:
  * compiled and lowered bodies, prepared states, struct layouts, field
    metadata, context results;
  * member and IsA caches, decoded packages, prepared meshes.

  It depends only on the package bytes. Play may compute it early, for any
  class, and keep it for the life of the page. It must never be observable.

**Rule.** Readiness may be built and kept for anything at any time. The
original's state of an object is created fresh from its package at the
original's load of it, and ends at the original's collection of it.

## The process and the level

`ScriptProcess` is new: one per realm, which is the worker, or the page
when the simulation runs inline. It holds:

| Part | Today |
| --- | --- |
| AssetStore (packages, `nameSpelling`, config store) | already per realm |
| Load graph and `ScriptClassLoader`: linkers, `objectHash`, package roots, static records, `gnames`, `syntheticAddress`, import and load state | per runtime |
| GConfig (`configCache`) | re-read for each runtime |
| Script-package identities (`ScriptObjects` entries of Core, Engine, Extension, ConSys, DeusEx and the other script and resource packages) | per runtime, mixed with level identities |
| Resource registry's `packages` and `nativeClasses` | per runtime |
| Readiness: `functions`, `states`, `structs`, `structLayouts`, `contextResults`, prepared function records, field metadata | per runtime |
| Each loaded class's current generation (below) | `runtime.classes` per runtime |
| The handle table, name ids, lowering ids, image cells, and the module caches keyed by `cls` | already module-level |

`ScriptRuntime` stays per level and attaches to the process. It holds:
- the Rust VM interpreter and its arena: object images, class rows, lowered
  code, frames;
- instances;
- the level's identities: map exports, `.dxs` placeholders, and the
  attached package objects of `prepareObject`;
- the level services that are today constructor closures (`levelFor`,
  `native`, `rng`, `conversationObjects`, `logDevice`) and later
  assignments (`actorLifecycle`, `nameServices`, `audio`, `textSource`,
  `travelServices`, `actorPhysics`, `relocation`, `pollLatent`, the window
  and conversation lifecycles). These become per-level bindings of the
  runtime, never wrapped twice;
- the object registry, the host FName table and the object-index model, as
  today (see "What stays per level").

Keeping the runtime per level keeps each level's arena, VM and identity
tables bounded by that level. That is the safer first shape for long
sessions. Merging the runtime into the process, as the original's single
UObject heap does, remains a later option. It becomes worth doing if a
measurement names the per-level VM costs: lowering code again in each VM,
and building class images again in each arena.

## Identities and generations

* **An identity lives as long as its original object.**
  * A class that the original keeps keeps its identity object across
    levels.
  * A purged class's identity ends. The next original load of the same
    export makes a new identity and a new `cls`: a new generation, with
    package defaults and `nameCounter` 0.
  * The same holds for every package object the collection purges:
    DeusExConText's conversation objects, which are unloaded at each
    collection, and level-only resources.
* **Readiness is keyed by the export, not the identity.** Readiness depends
  only on bytes, so it is keyed by package and export index or path. A new
  generation finds its prepared functions, layouts and metadata ready.
  Today readiness hangs on identity records (`record.function`,
  `record.metadata`). It moves to a process table keyed by export.
* **A process identity is never attached as an instance.** `linkInstance`
  defines the runtime's non-configurable `instanceKey` symbol on the
  receiver and keeps the instance in `runtime.instances`. An attached
  identity would pin its runtime. Classes, functions and properties are not
  attached. `prepareObject` attaches loaded package objects, and these must
  be per-generation identities of the level.
* **Map identities are per level.** `ScriptObjects` splits into the
  process's package table and the runtime's level table. `bindIdentity`
  writes only the level table. This removes today's "already resolved"
  failure on a revisited map and on a `.dxs` named like its `.dx`.
* **Handles end with their identity.**
  * Handles are minted lazily (`handleOf`) in whatever host window is open,
    so no fixed range can be set aside for the process.
  * Level identities keep today's per-host range release.
  * A process identity's handle is released when the collection purges its
    object, one identity at a time. `releaseHandleRange` skips process
    identities.
* **Class images are per arena.** The VM reads a default image only from
  its own arena (`script-vm-rust.mjs:438`). So `classImages` keeps one
  entry per (generation, arena), and an arena's entries go with it.
* **GObjObjects indices are unchanged.**
  * Loaded objects (classes, resources, map exports) still have no modeled
    slot. Runtime spawns keep the per-map seed (`map-registry-seeds.mjs`).
  * After a travel, the original's indices follow its whole history.
    JaimeReyes0 is 34327 on the probe's first Training visit, 47523 on the
    second, and 34333 in the stored Training table. Play's stay at the per-map
    capture.
  * Sound channel ids are compared for equality only, so this is labelled,
    not audible ([object-index captures](object-index-captures.md)).

## Loaded in the original's sense

Play loads classes for two reasons, and they must be told apart.

* **The original's requests.** As measured (below), they are:
  * loading the level, which resolves every import of the level package;
  * the class of every object the game instantiates: a spawned actor
    (including the GameInfo and the player from `Class=`), a window, a `new`
    object, an attached map or package object;
  * the load natives: DynamicLoadObject, StaticLoadObject, LoadPackage;
  * the boot.
* **Host readiness requests.**
  * The prepare-every-body pass, with its `prepareClassOperands`.
  * `prepareSpawnClosure`, `prepareNpcs`, the mesh and conversation
    preparation, and `prefetchDynamicLoadPackages`.

How the two kinds of request behave:

* **Load requests carry their kind.** An original request runs the
  recovered BeginLoad/EndLoad around the load, as dynamic loads already do
  (`suspendLoadQueue`, `script-load-graph.mjs:1267`). EndLoad preloads every
  object the load created, transitively, and flushes GObjLoaded. The
  original-loaded set is then the original's closure. Today the graph
  creates objects lazily, so its set is both smaller than the original's
  (objects created but never preloaded) and larger (readiness loads).
* **Readiness loads stay host-only.** The records they create are flagged
  host-only and sit outside GObjLoaded, the collection and the gate. They
  still go through the same graph, because the VM needs a linked class.
* **Host-only records are promoted.** When an original request reaches a
  host-only record, the record's state is still pristine: nothing original
  could have touched it. It becomes original-loaded, and EndLoad's preload
  closure promotes what it reaches. *Assumption, tested by the gate:* the
  loader's CreateExport recursion and the collector's edges reach the same
  classes. Promotion uses the loader's closure.
* **Lookups by name see only original-loaded objects.** FindObject,
  StaticExec's GET and SET, and IsA by name are examples. A SET on a class
  the original has not loaded answers as the original does
  ("Unrecognized class").

**Measured (2026-10-26, step 1's first half).** `scripts/original-load-closure.mjs`
records these requests during a cold Play load. It replays each one on a
load graph of its own, inside the recovered BeginLoad/EndLoad. Bind's native
pointers answer with placeholders, since a pointer creates no object. An
object whose Serialize body is not recovered is kept created and unloaded:
FireTexture, WetTexture, ConversationList.

Against gc2's frozen dumps (`scripts/validate-original-loaded.mjs`):

| Map, cold | Requests (level imports, instantiated classes, DynamicLoadObject) | Closure | The original's classes |
| --- | --- | --- | --- |
| DX.dx | 16, 147, 0 | 959 classes (33,301 objects) | 984 = 959 + 25 |
| 00_Training | 133, 198, 56 | 1,011 (34,054) | 1,033 = 1,011 + 22 |
| 01_NYC_UNATCOIsland | 293, 288, 223 | 1,078 (34,861) | 1,100 = 1,078 + 22 |

* **Nothing extra, and every loaded class accounted for.** The closure
  holds no class the original lacks. Every class only the original holds
  carries flags `0x44084044` or `0x04084004`. Such a class is registered by
  a DLL at startup and never loaded from its package:
  * WinDrv's WindowsClient and WindowsViewport, Render, D3DDrv, Galaxy;
  * IpDrv's drivers and commandlets;
  * ConSys and Extension natives whose script exports never loaded;
  * Core's Factory and Exporter, Engine's DemoPlayPendingLevel.

  The boot's UWindow and UBrowser classes and DeusExGameEngine are in the
  closure.
* **A level's class set does not depend on the history before it.** The
  original's Island set was built after DX.dx and Training, yet it equals the
  cold Island closure. Each map change collects exactly the first level's
  closure minus the second's, and loads the second's minus the first's:
  * DX.dx → Training: 6 and 55;
  * Training → Island: 28 and 95;
  * Island → Training: 95 and 28.

  On these maps, then, what the collection keeps is what the new level's
  requests reach. That gives step 4 a gate independent of the mark it
  implements.
* **Play's live graph differs on both sides.** It holds more classes than
  the original (the readiness passes link 607 to 691 per level) and fewer
  objects (it preloads lazily and never runs EndLoad).

**Long-term shape.** Once the script packages are resident in the process,
fetching is no longer asynchronous. If nothing else in `prepareFunction` is
asynchronous, the VM could load and link a class on demand, synchronously,
when the original does. The host-only flag and promotion would then go
away. The flag is a bridge to that, not the end state. Whether anything
besides the fetch is asynchronous is not checked.

## LoadMap in Play

A map change is a travel, an `open`, a loaded game or a level restored from
`Save\Current`. In order:

1. **The old level ends** as today: PreTravel, travel export and Browse
   (`travel.mjs`). The old player's `DestroyActor` in the old world is still
   not modeled ([travel](travel.md), "One session per map").
2. **The old runtime is disposed before the new one is built.**
   * Worker mode does this already (`sim-worker.mjs:143`).
   * Inline mode builds the new host first (`main.mjs:948`, disposing at
     `1031`). It must dispose first.
   * Disposing releases the level's identities and handles and its arena.
     The process keeps its graph.
3. **A new runtime attaches to the process.** It binds the map's actors as
   level identities. Their classes and referenced objects are original
   requests: kept classes are found, the others load fresh as new
   generations.
4. **The collection** runs at LoadMap's point: after the level's load,
   before the GameInfo spawn, which is the original's first post-collection
   spawn (`0x1038d59d`).
   * In the cold startup this is just before `prepareLoadMapGame(...).reload()`
     (`script-doors.mjs:2396`), after the map actors are attached and before
     the begin-play passes. Player start already collects before
     `reload()` (`1873` → `1874`).
   * The old level's objects are gone with the old runtime. That is the
     original's `0x400` exclusion: nothing they referenced is marked through
     them.
   * The collection marks from the roots (next section) and purges every
     original-loaded class, package object and resource it does not reach.
5. **The begin-play passes, then SpawnPlayActor:** Login and the travel
   import, as in today's cold startup.
6. **No Player start afterwards.** This is migration step 5 and needs your
   approval. With the rerun, Player start purges the cold load's Shadows
   while the kept Shadow class keeps counting. Training after DX.dx would
   then hold Shadow20..38, where the original holds Shadow1..19.

Player start (the same map, the same runtime) keeps its in-place reload. Its
collection now also covers the process's classes, so a class loaded during
the level that nothing reaches any more is purged, as in the original.

A **level restored from `.dxs`** and a **loaded game** are the same LoadMap
with the level package taken from `Save\Current`. They have no begin-play
passes, as today. Inline mode must restore them: today it cold-loads the
`.dx` (`main.mjs:898` drops `restore` without a worker). That fix is a
prerequisite.

The **debug page's map list** and a **page reload** start a new process,
which is today's meaning: a new run of the original. A `?process=keep` switch
could make the list an `open` in the same process.

## The collection over classes

**Registry.** The original-loaded records of the process graph, plus the
level's object registry, as today. A record carries `RF_Native` when its
export flags do (`Export.ObjectFlags & 0x067f0025` keeps `0x04000000`). A
class Engine.dll registers but whose script export has not loaded carries it
too (flags `0x44084044` in the dumps).

**Roots**, measured: the root array (`Transient`, `System0`,
`WindowManager0`, `DeusExGameEngine0`, the current `DeusExRootWindowN`),
then every `RF_Native` object.
* Play has the transient package.
* System, the window manager and the engine are host stand-ins. The engine
  leads to GLevel and its actors, and to the client viewports and console.
* Whether the old root window is still in the root array at LoadMap's
  collection is not measured. The old player, which owns it, is destroyed
  before the load.

**Edges**: the recovered collector serializers.
* Already recovered:
  * the UObject header, which includes Class and Linker
    ([UObject serialization](script-object-serialization.md));
  * UField, UStruct with its bytecode, UState and UClass, the last with
    dependencies, `ClassWithin` and defaults
    ([Core metadata](script-class-serialization.md));
  * all thirteen UProperty kinds
    ([property metadata](script-property-serialization.md));
  * ULinker, whose addresses and order are recorded in
    [class lifetime](class-lifetime.md).
* To recover before this step: UFunction, UEnum, UConst, UTextBuffer and
  UPackage, and the resource classes (UTexture, UPalette, USound, ULodMesh
  and UMesh, UFont, UMusic).
* Until a resource's own Serialize is recovered, the resource is walked as a
  leaf: no outgoing edges, labelled. This assumes that no resource
  references a class, which the recovered serializers must confirm.

**Purging a class** (and each of its functions, states, properties,
consts, enums and structs, whose Outer chain leads to it):
* DetachExport: the linker export's object becomes null, and the
  `objectHash` entry is deleted.
* The generation ends: `runtime.classes` and `linkedClasses` drop it, and
  its class images are released in their arenas.
* Its handles are released one by one.
* Its readiness stays.

**A package** whose objects are all purged is unloaded: its linker leaves
`linkers`, and the log line is `Unloading: Package <name>`. The AssetStore
keeps its bytes.

**Resources are collected the same way, in the same step.** Classes keep
their meshes, textures and sounds. A level's own resources, such as its
texture and music packages, must go at the collection, or every level's
resources accumulate for the session. That makes resource collection a
reliability requirement (Stage 7: "long sessions and repeated map changes
remain stable"), not a follow-up.

**Bounded growth.** With EndLoad on original loads, GObjLoaded is emptied
after each load. `graph.warnings`, which `load()` scans on every call, needs
a bound or a per-load window.

## Carried defaults

Kept classes keep their Defaults and collected ones load fresh, so the
travel's `classDefaults` (`classDefaultsForTravel`, `applyCarriedDefaults`)
become redundant. During migration they stay as a cross-check: what the
travel would carry must equal what the kept classes hold. They are retired
after the gate passes.

## What stays per level, labelled

The original keeps the following per process. In this design they stay per
level, and each difference is labelled:

* **The host FName table and its collector name pass.** The graph's
  `gnames` becomes process-wide and never deletes. It is also
  case-sensitive, unlike a real FName.
* **The object registry and its index model**, with the per-map seeds (see
  Identities).
* **The RNG seed.** Play seeds one per level (`game.mjs:142`, and again at
  Player start). The original seeds once per process.
* **The Entry level.** The original's GEntry keeps a LevelInfo, a GameInfo,
  a Mutator and a GameReplicationInfo. Play has none.
* **The client viewport and console.** Play rebuilds them per level. They
  are process objects in the original.

## The gate

Play replays the probe in one process:
1. original start on DX.dx;
2. `open 00_Training`, `open 01_NYC_UNATCOIsland`, `open 00_Training` through
   the console's `OPEN`.

At each stop Play dumps its state after the startup passes and before the
first tick, which is what a frozen original shows. Each stop is compared
with the original:

1. **The original-loaded class set** equals the original's dump, except
   classes a DLL registered and never loaded (flags without `0x70000`).
   Step 1's measurement already holds for cold loads (above).
2. **Each map change's kept, collected and loaded sets** are equal.
3. **The 28 Training classes** are new generations on the return.
4. **The spawned-name counters** match the table at the top.
5. **The class defaults** behave as the original's: a SET on a kept class
   survives two map changes, and a SET on a level-only class reverts on the
   return.

The reference capture is **gc2** (2026-10-26,
[class lifetime](class-lifetime.md#frozen-arrivals-and-class-defaults-gc2)):
* gc1's steps, with every level arriving frozen;
* class sets equal to gc1's at every stop;
* the measured SETs of check 5:
  * `Engine.PathNode ExtraCost`, a native class: kept;
  * `DeusEx.Shadow ScaleGlow`, script-only and kept by reachability;
  * `DeusEx.LightSwitch ScaleGlow`, Training's own class: back to the
    package default after the round trip.

## Migration

Each step is verified before the next. Through step 4, bench-sim's digests
stay equal for single-map sessions.

1. **Original-loaded vs host-only.**
   * *First half, done 2026-10-26.* Record the original's requests, compute
     their EndLoad closure on a separate graph, and gate it with
     `validate-original-loaded` (above).
     * The only runtime change is the load graph's opt-in `skipUnrecovered`
       hook, which is off unless a measurement passes it.
     * bench-sim digests are unchanged (03_NYC_747 `0750ca718aa7c059`,
       01_NYC_UNATCOIsland `52595f00465194dd`).
   * *Second half.* The live graph knows which of its records are
     original-loaded:
     * the request kinds at the measured entry points;
     * EndLoad's closure on original requests;
     * the host-only flag and promotion;
     * name lookups restricted to original-loaded objects.

     The closure costs about 2 to 2.7 s per cold map on a separate graph,
     and 33,000 to 35,000 objects. Whether the live graph pays that at the
     first map, or the process keeps a shadow closure by key, is decided
     against a profile. No behavior change. Gate: `validate-original-loaded`
     computed from the live graph.
2. **Identity split.**
   * the process package table and the runtime level table in
     `ScriptObjects`;
   * readiness keyed by export;
   * handles of process identities exempt from range release.

   No behavior change.
3. **`ScriptProcess`.**
   * The graph, loader, package identities, readiness and GConfig move into
     it, and a new runtime per level attaches to it.
   * Level services become per-level bindings, and class images are per
     arena.
   * Inline mode disposes before it builds.

   The second map onward skips re-linking and the readiness pass. Gate:
   travel validators, the Stage 6 chains, and the carried-defaults
   cross-check.
4. **The collection over classes and resources** at LoadMap's point, for map
   changes and Player start.
   * Recover the remaining collector serializers.
   * Add DetachExport, generations and package unloading.

   Gate: gc2's sets and generations, and memory over the gc2 sequence
   repeated ten times staying flat.
5. **One LoadMap per arrival**, with no Player start after a cold load. This
   needs your approval. Gate: gc2's counters. Then re-run the Stage 5 and
   Stage 6 comparisons. Their load-made actors are paired by creation rank,
   so their names should not matter.
6. **Retire carried defaults**, and make inline mode restore `.dxs` levels and
   loaded games (that fix may come earlier).

## Expected effect

The first map loads as today. From the second map on, the load skips:
- the readiness pass, about 1.5 s;
- re-linking the ~900 kept classes;
- Player start's second startup, 0.7 to 0.9 s.

Only the new level's 28 to 95 classes load. Estimate, not a measurement:
the Island's 7.1 s to the first frame would fall to roughly 3 to 4 s.
Profile each step with `scripts/profile-map-load.mjs` and interleaved A/B
medians.

## Open

* Whether anything in `prepareFunction` is asynchronous besides the fetch,
  which decides whether the host-only flag can become synchronous loading.
* The root window at LoadMap's collection.
* The cost of EndLoad's full preload closure on the first map's original
  loads.
* The per-level VM costs (lowering, class images), which decide whether the
  runtime merges into the process.
* The level collection rewriting bytecode operand links
  (`script-objects.mjs:90-96`): these must stay level-scoped when operands
  are readiness.
* GEntry, the boot's classes, and the old player's `DestroyActor` in the old
  world: the boundaries the gate's exception list names.
