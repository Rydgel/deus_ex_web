# Design: one class graph per process, collected at LoadMap

Status: design of 2026-10-26; migration steps 1 to 4 are implemented
(2026-10-27, see Migration). It builds on the original's behavior recorded in
[class lifetime](class-lifetime.md) and on the costs measured in
[load time](load-time.md).

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
  host-only record, it becomes original-loaded, and EndLoad's preload
  closure promotes what it reaches. *Assumption, tested by the gate:* the
  loader's CreateExport recursion and the collector's edges reach the same
  classes. Promotion uses the loader's closure.
  * The record's own state is pristine: nothing original could have
    touched it.
  * **Its inherited Defaults may not be (open).** The original builds a
    class's Defaults when it loads it: UClass::Serialize copies the
    super's Defaults (InitClassDefaultObject), then reads the class's own
    tagged properties. So a default written on the super before that load
    (a SET, a script's `Default.X =`) reaches the subclass, unless the
    subclass serializes the property itself.
  * Play built a host-only subclass's Defaults when it linked it, maybe
    before the write. `noteClassDefaultWrite` keeps that copy, as it does
    for a subclass the original had loaded.
  * Example: a SET on ScriptedPawn on DX.dx, where Play has linked
    AnnaNavarre only for readiness. A later AnnaNavarre spawn in that
    level gets the old value in Play and the new one in the original.
  * Fix: at a default write, give the new value to each host-only
    subclass reached through host-only classes that do not serialize the
    property. Until then this is a recorded gap, not modelled.
* **Lookups by name see only original-loaded objects.** StaticFindObject
  searches the objects in memory, so FindObject and StaticExec's GET and
  SET only find classes the original holds. So does a `class<...>`
  console parameter: ScriptConsoleExec's ImportText. A SET on a class the
  original has not loaded answers as the original does: "Unrecognized
  class". IsA by name walks the object's own class chain and looks
  nothing up.

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

**What step 1 built** is a walk over the graph's recorded load edges, which
preloads metadata only (see Migration, step 1), rather than EndLoad around
each request. It reaches the same classes on the three measured maps.

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

The purge also prunes the class loader graph's load edges and the
original-loaded tracker's marks for the purged records, or the edge map
keeps them alive. Before it marks, the collection calls the tracker's
`flush()`, so that a request which arrived during a load (a late
DynamicLoadObject) is walked first.

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
  a Mutator and a GameReplicationInfo. Play has none. Since step 4b the
  collection holds Entry.dx's import closure, as GEntry's live linker does
  (Title_Music, its LevelInfo's song).
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
   * *Second half, done 2026-10-26.* The live graph knows which of its
     records the original holds loaded (`src/runtime/original-loaded.mjs`).
     * **Load edges.** The class loader's graph records its load edges
       (`recordLoadEdges`):
       * every reference a Preload resolves, from the object whose
         serialization is in progress (`linkerPreload`'s `preloadStack`,
         including its own recursion into the class and the struct super);
       * each new object's Class, Outer and SuperField.

       On a cold Training load that is about 151,000 edges from 29,600
       records, about 7 MB.
     * **The walk.** Starting from the original's requests (the level's
       imports at LoadMap's collection point in `createScriptDoors`, each
       instantiated object's class in `linkInstance`, a graph
       StaticLoadObject/DynamicLoadObject), the tracker follows the edges.
       * A reached metadata record that Play has not preloaded is preloaded
         inside BeginLoad/EndLoad, as the original's EndLoad would.
       * Other kinds are marked and deferred: `setDeferPreload` leaves their
         flags alone, and EndLoad's post-load pass skips them. Their bulk
         data is not needed.
       * Level imports in a package Play has not prepared on the graph are
         skipped, and so are dynamic loads routed outside the graph. Preparing
         them would change a later DynamicLoadObject's route.
     * **Measured.**
       * On DX.dx, 00_Training and 01_NYC_UNATCOIsland the tracker reaches
         exactly the separate closure's classes, with no failed walk
         (`validate-original-loaded` now checks this).
       * It marks 32,400 to 33,500 objects; heap +28 MB after a cold load.
       * A cold Island boot is about 0.3 s slower (interleaved bench-sim
         medians, 5,949 → 6,261 ms). Step 3 makes that a once-per-page cost
         plus the next level's increment.
     * **Bind.** EndLoad's PostLoad now runs UFunction::Bind in Play. A
       numbered native's slot (`+0x7c`) holds a host token,
       `0x80000000 | iNative`, never dereferenced. A name-bound native's DLL
       export is not looked up, so its slot stays null. In the original it
       holds the export's address. Nothing in Play reads that slot.
     * **Unchanged behavior.** Nothing reads the marks yet.
       * bench-sim digests are unchanged, and the unit tests pass.
       * So do the load-graph, Player start, collection and dynamic-load
         validators, and the travel, restore and load-game validators that
         have captures on the Mac (load-game, travel-restore-objects,
         travel-transitions, restored-speech).
       * Chromium loads Training and the Island in worker and inline modes
         with no runtime error.
       * The loaded game's level, a `.dxs`, goes through `reachLevel`.
   * The host-only flag needs no extra state: a record is host-only
     exactly when the tracker has not reached it. Promotion is the walk.
   * **Done (2026-10-26, 1c, a behavior change toward fidelity): name
     lookups see only what the original holds.**
     * `findClass` (`original-loaded.mjs`) is StaticFindObject(UClass,
       ANY_PACKAGE, name) over the reached class records plus the
       registered ones. It follows ResolveName's package step, the
       package's hash bucket, then the ANY_PACKAGE walk by name alone.
       `ScriptRuntime.originalClass` maps the result to the linked class.
     * Used by StaticExec's SET and GET for script classes and by the
       `class<...>` console parameter. Before, SET found a class only
       through a live actor of it, and the parameter searched every class
       Play had linked.
     * A SET on a class the original holds with no live object now writes
       the Defaults; before, it was an explicit boundary. GET of a found
       script class stays one: ExportText of script Defaults is not linked.
     * Explicit boundaries, never a guessed miss:
       * a class the DLLs register without a graph record (25 on DX.dx:
         WinDrv, IpDrv, Render, …);
       * an original class Play has not linked (206 to 207 per map, mostly
         Core and Engine natives; linking is asynchronous);
       * two classes with one short name (none on the three maps), since
         the GObjObjects order between them is not kept;
       * a package Play cannot place;
       * a path below a package.
     * Reference: capture gc3 ([class lifetime](class-lifetime.md#name-lookups-gc3)),
       checked by `scripts/validate-original-lookups.mjs`.
       * Of the 890 classes Play links on DX.dx, the 760 the original's
         dump holds are found and the other 130 miss.
       * The four SETs print the original's console lines.
       * Training's 10 objects carry the original's ScaleGlow.
     * `validate-class-import-text` now checks that CheatView with an
       unknown name, or with a class linked only for readiness
       (`engine.testinfo`), is a NULL import: BadProperty, not called.
     * Found while doing this, open: a promoted class's inherited Defaults
       ("Host-only records are promoted" above).
2. **Identity split.**
   * the process package table and the runtime level table in
     `ScriptObjects`;
   * readiness keyed by export;
   * handles of process identities exempt from range release.

   No behavior change.

   *Done 2026-10-26* (`src/runtime/script-process.mjs`, `script-objects.mjs`).
   * **`ScriptProcess`** holds:
     * the package identities;
     * the readiness tables (linked bytecode, prepared functions and states,
       struct fields and layouts, context results);
     * the classes and linked classes, Engine.Actor's class, the class loader
       and the resource registry.

     A runtime built without one makes its own, so a single map is
     unchanged. The runtime's fields are the process's own Maps and Sets: no
     accessor sits on a hot path.
   * **The routing rule** (`exportScope`):
     * every export of a level package (`.dx`, `.dxs`, `.unr`) is the
       level's;
     * so are the objects a level attaches: DeusExConText's `Con*` objects,
       the ConAudioLists, DeusExText's ExtStrings;
     * metadata and resources are the process's;
     * any other kind throws.

     A host's `bindIdentity` may bind only a level export. On a cold Training
     load: 31,050 process identities, and 6,893 level ones (338 of the map,
     6,555 conversation objects).
   * **Readiness keyed by export.** Every readiness table is keyed by the
     identity's `key`, `${package}.${export path}`, and lives in the process.
     The readiness on an identity (`record.function`, `record.metadata`)
     stays there, since process identities persist per export. Carrying it
     to a new generation's identity belongs to step 4, which defines
     generations.
   * **Class images are per runtime** (`runtime.classImages`). The Rust
     interpreter reads an image only from its own arena.
   * **The class loader** mints a level's identities in the attached
     runtime's table. It caches them per level (`levelIdentities`, reset by
     `attachLevel`), and the process's for the process's life.
   * **Handles.** `releaseHandleRange` takes a keep predicate, and
     `releaseHandlesWhere` frees an abandoned process's handles.
   * **Gate.** Unchanged behavior:
     * bench-sim digests are unchanged (03_NYC_747 `0750ca718aa7c059`,
       01_NYC_UNATCOIsland `52595f00465194dd`);
     * the unit tests pass;
     * so do the class loader, dynamic load, LoadMap, resource, Player start,
       load graph, lookup and travel restore validators;
     * `scripts/validate-script-process.mjs` checks the split.
3. **`ScriptProcess`.**
   * The graph, loader, package identities, readiness and GConfig move into
     it, and a new runtime per level attaches to it.
   * Level services become per-level bindings, and class images are per
     arena.
   * Inline mode disposes before it builds.

   The second map onward skips re-linking and the readiness pass. Gate:
   travel validators, the Stage 6 chains, and the carried-defaults
   cross-check.

   *Done 2026-10-26.* A travel arrival attaches to the process of the level
   left. That covers an `open`, a LocalTravel, a level restored from `.dxs`
   and a loaded game.
   * **Where:**
     * the worker (`sim-worker.mjs`);
     * the page in inline mode (`main.mjs`);
     * the headless harness (`census-stage5-session.mjs` `openSession`).
   * **A new process instead:** the map list, a page load, `?process=new`,
     or `DX_SCRIPT_PROCESS=new` in the harness.
   * **`ScriptProcess.attach(runtime)`** hands the process to the new level:
     * the class loader mints in the level's table;
     * the class defaults the arrival carried apply to classes loaded from
       now on;
     * the resource registry resolves through the new level, takes its
       object-index provider, and forgets the level left's records
       (`forgetLevel`: DeusExConText's objects).
   * **Disposing a level** releases its handles except the process's.
   * **Inline mode keeps building before it disposes.** Each host's handle
     range starts when the host starts, so the new level's handles never fall
     in the old range, and the level left has stopped ticking. A failed load
     re-attaches the level left.
   * **The carried-defaults cross-check runs at attach**
     (`checkCarriedDefaults`): every default the travel carried for a class
     the process kept must equal the class's own.
   * **Measured,** headless (`validate-script-process`, one process over
     gc2's DX → Training → Island → Training):
     * the arrivals link 32, 72 and 0 classes (cold: 910, 967, 910);
     * every DX class keeps its class object, Defaults and counter;
     * the level left's identities all lose their handles;
     * no process identity is attached as an instance;
     * the carried defaults agree (4 and 12 compared);
     * each level runs 120 frames.
   * **Opening times,** two runs each, a new process per level → shared:
     * Training: 5.1–5.8 s → 1.1–1.2 s;
     * the Island: 6.1–7.6 s → 2.6–2.9 s;
     * Training again: 4.0–5.5 s → 0.9–1.2 s;
     * process RSS: 2.4 GB → 1.4 GB.
   * **In Chromium.** `scripts/profile-map-load.mjs --travel` reaches each
     map by the console's `open`, from 00_Training to the Island and back to
     Training. Three interleaved runs per side in worker mode, wall time to
     the first drawn frame, `?process=new` → shared (medians):
     * the Island: 6.9 s → 4.1 s, the worker's `createGame` 4.9 s → 2.2 s;
     * Training: 4.1 s → 1.5 s, `createGame` 3.3 s → 0.75 s.

     Inline mode, one run per side: the Island 8.0 → 5.1 s, Training 5.3 →
     2.5 s. No page or runtime error on either side.
   * **Memory over six Training ↔ Island round trips** in one headless
     process, heap after GC at each Training arrival:
     * shared: 747 to 761 MB. Handles (8,065), classes (990), identities,
       load edges, tracked objects and the registry's records stay constant.
       The residue is about 2 MB per round trip; step 4's gate (ten repeats
       of gc2's sequence, flat memory) covers it.
     * a new process per level: 491 to 496 MB;
     * the commit before step 1 (`db1452dc`): 467 to 473 MB.
   * **Fixed after the step 3 commit: the levels left stayed alive.**
     Repeated round trips hid it; distinct maps showed it. Over nine
     distinct maps in one process (the Island, UNATCO HQ, Battery Park, the
     Street, the Bar, the Hotel, the Warehouse, the Airfield, the 747), the
     heap grew about 125 MB per map, 576 → 1,697 MB. A new process per level
     stayed at 480–570 MB, and every runtime left stayed alive. Two holders,
     both readiness or process objects outliving a level:
     * a compiled body's operand cache (`script-vm.mjs` operandCache) kept
       the services of the runtime that ran it last. It now keeps their
       `cacheId`;
     * the class loader's service closures were made in the first runtime's
       constructor, whose scope captured that runtime's `this`. They are now
       made outside it (`createProcessClassLoader`).

     After both: one runtime alive (the level's own), and the heap at 544–606
     MB over the same maps. `validate-script-process` now checks that a GC
     frees every level left. It fails with the old operand cache.
   * **Open: an undisposed game keeps other levels alive.** In a node process
     that also holds an undisposed game of another process (a cold
     `createGame`), the shared process's left runtimes are not freed. The
     page disposes a game before the next one runs, so this is a test
     artifact; the path is not found.
   * **What it changes, until step 4 collects.** The original collects a
     level's own classes at the next LoadMap. Play now keeps every class
     linked in the process. So:
     * a level-only class keeps its Defaults (gc2's LightSwitch SET survives
       the round trip; the original reverts it) and its `ClassUnique` counter;
     * the kept ~1,000 classes now keep theirs, as in the original (before,
       every counter restarted at 0);
     * spawned names in a multi-map session move: Stage 5 and 6 pair actors
       by creation rank;
     * name lookups (1c) see the level-only classes of the levels left;
     * DeusExConText's linker and records stay in the graph (the original
       unloads the package at each collection that leaves no conversation
       object). Each level still gets its own conversation identities.
     * A resource keeps the global index the first level's object-index
       provider gave it. Sound channel ids compare only for equality.
4. **The collection over classes and resources** at LoadMap's point, for map
   changes and Player start.
   * Recover the remaining collector serializers.
   * Add DetachExport, generations and package unloading.

   Gate: gc2's sets and generations, and memory over the gc2 sequence
   repeated ten times staying flat.

   *4a, the classes, done 2026-10-26* (`src/runtime/script-process-collection.mjs`).
   * **The serializers.** The remaining collector branches were recovered
     from the hash-pinned binaries:
     * Core ([core GC serializers](core-gc-serializers.md)): UFunction,
       UEnum, UConst, UTextBuffer and UPackage add no object reference beyond
       UStruct, UField and UObject. ULinker adds its LinkerRoot and each
       import's SourceLinker, both native-only pointers.
     * Engine's resources ([resource GC serializers](resource-gc-serializers.md)):
       a mesh's Textures array and a font's page textures are the only native
       references. The rest go through script properties (Palette,
       DetailTexture, AnimNext, ...).

     That note also corrected the array order in
     [LodMesh serialization](lodmesh-serialization.md).
   * **Roots.**
     * The root array's GLevel: the level's live objects. Their classes
       (`attachedClasses`) are seeds, and so are the process objects their
       properties reference.
     * Every RF_Native object: in every dump of gc1 and gc2 that is exactly
       238 DLL-registered classes, recorded in
       `src/runtime/native-class-roots.mjs` (Play's graph registers only
       Core's, Engine's and DeusEx's).
   * **The mark** runs over the graph's records. Each kind follows its
     recovered branch:
     * the header's Class and Outer;
     * UField's SuperField and Next;
     * UStruct's ScriptText, Children and the object words of its expanded
       bytecode (`skipExpandedScriptExpression`'s `onIndex`, resolved by
       `graph.recordAtAddress`);
     * UClass's dependencies, ClassWithin and Defaults (SerializeBin: not the
       native properties, the transient ones too);
     * each property kind's references.

     A record's fixed references are read once and cached. A class's
     Defaults are read at every collection.
   * **Mark-only check.** On cold loads of DX.dx, 00_Training and
     01_NYC_UNATCOIsland, the mark reaches exactly the original-loaded
     classes: 959, 1,011 and 1,078.
   * **The purge.** It covers the original-loaded metadata the mark does not
     reach, except RF_Native records and group packages. A group package is
     its resources' Outer, and resources are 4b's.
     * The record is detached: the export map's object is nulled, the hash
       entry dropped, its load edges pruned, and any import that resolved to
       it reset.
     * It leaves Play's never-emptied GObjLoaded queue. Without that, every
       generation stayed alive: 5,406 records over six round trips.
     * The tracker forgets it.
     * The class's generation ends: it leaves `classes` and `linkedClasses`,
       its identity's handle is released, and an attach to a stale
       generation throws.
   * **Identities stay.** The next load makes a new record and a new class
     (package Defaults, counter 0) behind the same identity, and readiness
     is kept with it. This deviates from "a new identity per generation".
     Nothing reachable held a pointer to the purged object, so nothing can
     tell the two generations' identities apart.
   * **When it runs:** at an arrival in a shared process, at the LoadMap
     point (the level's imports reached, before the GameInfo spawn).
     * Player start's second LoadMap does not collect classes. The original
     does not run it after a level's load (step 5), and readiness could not
     be restored synchronously there.
     * Right after the purge, readiness links the purged classes again,
       host-only (`relinkPurged`). Play's synchronous VM runs only linked
       classes, and a body prepared earlier may name a purged class, or the
       travel's import of the player's inventory may spawn one.
     * Such a class is a new generation from its package that the original
       does not hold. A request of the original reaches it when the original
       loads it again. The first sweep without this failed the flag census:
       an arrival spawned a purged class.

     A shared arrival no longer applies the travel's carried defaults: a
     kept class holds them, and a collected one must reload with the
     package's.
   * **Gate** (`scripts/validate-process-collection.mjs`, gc2's steps in one
     process):
     * at each stop Play holds the dump's classes;
     * DX → Training collects 6, Training → the Island 28 and the Island →
       Training 95, as the original does;
     * 983 classes keep their generation from Training to Training again,
       and the 28 Training classes come back as new ones, in both;
     * PathNode's ExtraCost 77 survives and LightSwitch0 reads its package
       default 1 on the return.

     bench-sim digests and the unit tests are unchanged.
   * **Cost:** each collection takes about 80 ms on the Island (seeds read
     from object images, about 10 ms; the mark, about 70 ms).
     * In Chromium, worker mode, the Island's arrival takes 4.6–4.9 s and
       Training's 1.8 s. Step 3 measured 4.1 and 1.5 s: a class the
       collection purged loads again when a level needs it, as the
       original's does.
     * Memory over six Training ↔ Island round trips: purged records stay
       bounded (the latest generation, held by the level just left), and the
       heap grows about 2 MB per trip, as before the collection.
   * **Left for 4b:** resources, conversation objects, group packages,
     linkers and package unloading (DeusExConText's included), and the
     resources Play marks without preloading (1,082 textures, 285 sounds,
     26 fonts on Training). Their references do not exist in Play's graph yet.

   *4b, resources and packages, done 2026-10-27* (`script-process-collection.mjs`, `ScriptProcess.unloadPackages`).
   * **The reference capture.** gc2 was re-captured on the Linux host under
     Wine (`.work/travel/gc2.steps`). Its dumps hold the same objects as the
     Mac's (34,208, 42,058, 47,757 and 42,058) and both class validators pass
     against it. The Linux host's `dump-gobjects-win.exe` predated `--flags`
     and had to be rebuilt (it read the flag as a name filter and printed no
     rows).
   * **What the original unloads.** At every gc2 stop, the original's
     top-level packages are exactly the import closure of the level package
     and of Entry.dx, plus the process's (Transient, Entry, the native DLL
     packages) and DeusExConText while conversation objects live. This is the
     linker rule:
     * an object's header serializes its Linker;
     * a linker serializes each import's SourceLinker, which VerifyImport set
       for every import when the linker was made;
     * the level's linker is live, and so is GEntry's for the whole process.

     Title_Music is held past DX.dx because Entry.dx imports it: GEntry's
     `LevelInfo0` has `Song` = Title_Music (probe `gc2s`, read at `+0x4f4`
     in Training: two `LevelInfo0` objects, the Entry level's and the
     level's). Probe `gc2m` had found no reference to it in the first
     `0x600` bytes of the Galaxy subsystem, the viewport or the engine.
   * **The mark over resources** follows the recovered branches
     ([resource GC serializers](resource-gc-serializers.md)):
     * a resource's header;
     * once it is preloaded, its script properties, through SerializeBin;
     * a mesh's Textures array (`+0xd8`) and a font's page textures
       (`+0x2c`).

     Play preloads only meshes. Its textures, sounds and fonts stay
     deferred, so their own references (Palette, DetailTexture, AnimNext, a
     font's pages) are not known. Nothing Play holds is reached only through
     them on gc2's steps (the gate below).
   * **The resource registry** (`script-resources.mjs`) holds the objects
     Play reads outside the graph, a level's textures and sounds among them.
     The collection reaches the registry's records from the marked graph
     records, the level's seeds, the level's own objects and every record
     that is neither a resource nor a package, then follows their Outer,
     Class and a mesh's textures. A resource record it does not reach is
     forgotten, and the next request materializes a new one. A registry
     record's graph record is marked with it (a fixpoint, one round on gc2).
   * **The purge** now covers resources and group packages too.
     * A purged resource keeps its identity and its handle. A body
       prepared earlier may hold it as an operand, and nothing reachable can
       tell the generations apart.
     * A purged class still releases its handle, as in 4a.
   * **Demotion.** Play also creates records for its own readiness. The
     original never loads these, so the collection neither marks from them
     nor purges them.
     * **The problem:** such a record can be linked long after it was
       created, and it then reads what it references.
     * **The case:** `validate-full-run` stopped at mission 4's exit on
       `Duplicate native backing record: deusexitems.invisibleweapon`.
       DeusEx.WeaponKarkianBite, created for readiness, holds the LodMesh
       DeusExItems.InvisibleWeapon in its PlayerViewMesh default, and the
       purge had detached that mesh.
     * **The rule:** a resource or group package that such a record
       references is not purged. That covers the record's load edges and,
       for a class, its Defaults (a subclass's Defaults copy its super's,
       which its own load never resolves). What those resources reference
       in turn is kept too. Each kept one leaves the original-loaded set:
       it is demoted.
     * **Why only resources:** a demoted resource is the same object to
       anything that can see it. Classes are not demoted, because a class
       keeps its Defaults and ClassUnique counter in its generation. gc2's
       OutdoorThings and ElectricityEmitter, which readiness-linked
       subclasses name as their super, come back as new generations in the
       original (the gate failed when classes were demoted). A purged class
       is linked again at once, as in 4a.
   * **Unloading** (`heldPackages`, `ScriptProcess.unloadPackages`). A
     package is held while one of its objects is marked or a held package
     imports it. For every other package the process knows:
     * the identities of its exports end, handles included (no kept object
       or linker referenced them, and a later load mints new ones);
     * the registry forgets its records;
     * the graph drops its linker and package root, unless one of its
       exports is loaded (none on gc2);
     * the asset store releases its bytes, unless the graph prepared the
       package. A prepared package is readiness: `prefetchDynamicLoadPackage`
       fetched it once for the process, and a later synchronous load reads it.
   * **The asset store's released cache** (`AssetStore.release`) keeps
     released packages' bytes up to 64 MB, oldest out first. This is host
     policy, like an OS file cache. The original reads the file again;
     here DeusExConText, unloaded at every collection and loaded again by the
     next level's startup, would otherwise be parsed again each time (about
     45 ms).
   * **Found and fixed:** the Training DataLink catalog
     (`script-training-datalinks.mjs`) read and decoded 00_Training's map at
     every level's start. That held the map's package after the collection
     released it. The catalog depends on the package bytes only, so it is now
     made once per asset store.
   * **Gate** (`validate-process-collection`, extended):
     * of the resources both sides hold before each gc2 map change, Play
       collects the original's collected ones (13, 71 and 241) and keeps the
       others as the same records (1,594, 1,656 and 1,662);
     * of the packages both hold, Play unloads exactly the original's:
       * DX.dx → Training: DX;
       * Training → Island: 00_Training, area51textures, Cmd_tunnels,
         HK_MJ12Lab and Training_Music;
       * Island → Training: the Island and its twelve packages.

       Title_Music and Entry are compared, with no exception.
     * Unchanged: bench-sim digests (03_NYC_747 `0750ca718aa7c059`,
       01_NYC_UNATCOIsland `52595f00465194dd`) and the unit tests (845,
       three of them new for the released cache, `test/asset-release.test.mjs`).
     * The sweep (Linux host, 4 jobs): 659 passed, 3 skipped, 6 failed. The
       six fail the same way on the commit before 4b, each run alone: five
       page checks in headless Chromium (host-services-play,
       world-batch-gpu, texture-sampling, lodmesh-lod-play,
       master-frame-play) and conversations-census, whose full run exceeds
       the runner's ten minutes.
     * `validate-full-run` (Stage 6 row 6.6.1: New Game to `dxonly` in one
       process, about 60 levels) passes with demotion: the 13 missions' exit
       travel texts equal the original's.
   * **Memory** (`scripts/validate-process-memory.mjs`, run by hand,
     outside the sweep): ten Island ↔ Training round trips in one process.
     * Every Training arrival holds the same process state: 994 classes,
       about 31,300 identities, 34,547 export records, 7,176 registry records
       and 45 to 47 packages (two runs, the second with demotion).
     * ArrayBuffers stay at 225 MB. The heap grows 0.56 and 0.92 MB per
       round trip in the two runs (0.8 MB before 4b; the source of that
       residue is not found).
   * **Distinct maps** (`--maps`, twelve maps of missions 1 to 3 after
     DX.dx): the packages' bytes stay bounded.
     * Before 4b, ArrayBuffers rose with every new map: 229 MB on the
       Island, 332 MB on the twelfth map, and the registry grew from 9,979
       to 14,359 records.
     * After: 205 to 254 MB of held bytes, plus at most 64 MB in the
       released cache (282 MB in all on the twelfth map). Identities stay
       at about 31,600 and registry records at about 12,000.
     * Before 4b the AssetStore kept every package it had read, so a whole
       campaign would end holding nearly all 598 MB of the game's packages.
   * **Cost.** In node, a collection takes about 140 ms on these maps, most
     of it 4a's mark. A record's class name and full name are now read once
     per record (they never change while it is loaded); before that, the
     registry's reach and the native-root scan read them for every tracked
     record at every collection (225 ms). In Chromium's worker mode, three
     interleaved runs per side of `profile-map-load.mjs --travel` (Training,
     the Island, Training, the Island, Training), first drawn frame,
     medians before → after 4b:
     * the first three arrivals are unchanged or a little faster (the Island
       5.55 → 5.59 s, Training 1.82 → 1.77 s, the Island again 4.15 →
       4.10 s). The DataLink catalog is no longer rebuilt at each level;
     * the fifth load (Training a third time) took 1.76 → 1.94 s in two runs
       of three, with the worker's `createGame` 1.16 → 1.28 s. Node does not
       show it. A purged resource is loaded again when a level needs it, as
       in the original, and the extra garbage plausibly moves a collection
       into that load. Not investigated further.
   * **Not modelled, labelled:**
     * `Unloading: Package <name>` lines from the collection are not
       logged. The original prints them in GObjObjects order (DeusExConText
       first at the Island's collection), which Play does not keep for
       linkers.
     * The page's own asset store, in worker mode, still keeps every package
       it reads. Its texture and mesh caches (decals, coronas, sprites, the
       HUD, actor meshes) key on the asset, so releasing there needs those
       caches to follow.
     * Play loads packages for its own readiness that the original never
       holds at gc2's stops (DXFonts, InfoPortraits, Extras, the conversation
       audio and music packages). The collection unloads their objects; a
       package the graph prepared keeps its bytes.
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

*Measured after step 3* (Chromium, worker mode, a travel by `open`): the
Island 6.9 → 4.1 s and Training 4.1 → 1.5 s to the first drawn frame
(migration step 3 above). Player start's second startup is still in them
(step 5).

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
