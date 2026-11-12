# The script process's object model out of JavaScript objects (plan, 2026-11-10)

Host representation only: none of this changes what the simulation computes, and each step is held to the same digests the earlier
live-heap steps were ([live heap](live-heap.md), [object memory](object-memory.md), [Rust core](rust-core.md), [class graph](class-graph-design.md)).
This is the plan behind [row 7.2.4](firefox-60fps-plan.md#native-slots-out-of-the-collectors-marking-2026-11-10): the collections that run
past 1.5 s in Firefox's inline mode, whose marking is spread over the script process's objects. Steps 1 (the load graph's native slots) and 2
(the per-script offset tables) are done and measured; the rest is ordered here by value slots and risk. A statement marked *(guess)* has no measurement or source behind it yet.

## What the measurements say

* **The table.** `heap-families.mjs --slots` on the Chromium snapshot of the Island page at 30 s, master 13ce5312: 13.87 M value slots
  and 1.55 M SpiderMonkey-like cells (objects, closures, strings; the estimator counts V8 element and property stores and each object's
  named fields). Run the same tool on the same build before and after a step; it is an estimate of what SpiderMonkey would visit, not a
  measurement of Gecko.
* **What the marker does with a slot** *(reading of the structure, not yet measured here)*. SpiderMonkey's marker visits every value of a
  marked object's slots and elements; a number is a tag test, a reference to a cell is a mark-bit test and, for a cell not yet marked, a
  push and a later visit of that cell. So the time follows the cells and the references to them first, and the numbers in arrays only
  as memory traffic. The earlier interleaved A/B (a cut of 20% of the cells took 3 to 20% off the marking) fits that; it does not by
  itself say that the numeric slots matter. What a typed array or a chunk of one costs the marker is its own cell, once, and nothing
  per word. Step 1 therefore avoids one typed array a record (35,000 cells) and shares chunks; the Firefox marking before and after is in
  [the plan](firefox-60fps-plan.md#native-slots-out-of-the-collectors-marking-2026-11-10).
* **What can leave the collector's reach without changing a lifetime.** Numbers (typed storage), and references whose target is held
  by something else for at least as long (an index into the holder's own table, a dense array in place of a Map). What cannot, in
  JavaScript: a reference whose target is kept alive only by it (a record in a table the collection forgets, the identities of a
  level). The original's own lifetimes are explicit (the collection purges objects, [class graph](class-graph-design.md) "Identities and
  generations"), so a table of indices into an object table can model them, but only once a release is wired at every place a JS
  reference used to keep an object alive. That is the Rust core's object image's job (below), and the risk of each step is mostly this.

## Families, in the table's order

Slots are the thousands the table gives for the Island page on 13ce5312, before step 1; "now" is after step 1 (the Chromium snapshot of
the branch, same method). What each holds is from the code named, or labelled.

### The load graph (the step 1 families; script-load-graph.mjs, native-slots.mjs, load-record.mjs, script-load-edges.mjs)

| Family | Slots | What it holds | Typed JS | Rust image | Risk | Checks |
| --- | ---: | --- | --- | --- | --- | --- |
| `packageObjects.loadRecord` + `LoadEdges.records` (first-reach halves of one population) | 1,156 + 569 | 34,583 `LoadRecord`s on the Island (those the load edges and the package table reach): 16 named fields (13 of the record, 3 of the store; `address` is an alias of `nativeAddress`, so the record stays within SpiderMonkey's 16 fixed slots) and the native words at their offsets (820,000: 63% int32, 19% records, 11% null, 4.6% the package's linker, 1.1% byte arrays, 0.5% arrays, 0.3% uint32) | int32 words done (step 1); the named fields' numbers (`nativeAddress` = `address`, `loadOrdinal`, `objectFlags`) could be columns behind getters *(guess: 10% of what is left)* | the records themselves as rows of an object table (header words as ints, links as indices) is the design of [rust-core.md](rust-core.md) "Target architecture"; a JS record becomes a handle | typed: low (done); rows: high: every module reads `record.nativeSlots`/`slotOf` and the `instanceof NativeSlots` checks, and a record's lifetime is its last JS reference | bench-sim digests, class-link and load validators, save/travel |
| `loadRecord.instanceValues`, `.defaults.data`, `.data` | 164, 127, 123 | a resource's instance memory above +0x28 and a class's default data: a `Map` offset -> value: 2,140 instance maps (40,833 int32, 11,878 objects, 1,418 null, 1,418 double, 1,142 uint32 values) and 1,103 default maps (27,709 int32, 6,124 strings, 4,220 records, 3,071 objects, 2,489 doubles, 87 null, 52 BigInt, 11 uint32) | done (step 1): `OffsetMap` over the same chunks (no shapes: each class's defaults have an order of their own); the doubles could be a second typed block *(guess: 5k slots)* | per-class default images exist already in the Rust core ("Class images are per arena") *(whether the JS maps can be dropped for a class is unmeasured)* | typed: low (done) | as above |
| `loadRecord.hashBuckets` | 156 (343 raw) | 1,339 tables (1,097 classes, 242 states) of 256 entries: 229,286 record references, 113,498 null; 7,414 distinct (bucket, record) pairs, 949 distinct contents; read only by UState::Link (script-state-link.mjs) | not typed: the entries are records. Delta tables (a derived state's table = its super's plus the entries it changes) keep the lifetime (the super is held anyway) but the original *copies* the table, so the super's table must not change after a child is linked *(unchecked: whether anything writes a linked state's table later)* | a `u32[256]` of object-table indices per table; the lifetime question above | delta: medium; indices: high | state-link validators, class loader, bench-sim digests; a check that no table is written after a child copied it |
| `buildLinker.objectHash` | 115 | `Map` "outer:name:class" string -> record: 35,000 string cells and entries | an open-addressing table of three int words per entry (addresses past int32 need Float64 or a split) over record ordinals, same lifetime | an object-table lookup | low-medium; keys include null and `undefined` pieces that must stay distinguishable | class-load validators; the digest |
| `buildLinker.recordsOfAddress` | 115 | `Map` address -> record | done: the synthetic addresses (every record's) are the elements of an array by ordinal; the registered classes' native addresses stay Map keys | | low (done) | as above |
| `LoadEdges.records` itself | 35 | one array element per held record | not removable: it is the strong hold the edges' lifetimes are defined by (a record is held while it has an entry or is an edge target); the typed lists around it are already int arrays | the same hold in the object table | n/a | |

### Instances (another worker is changing these tonight; listed for the order)

| Family | Slots | What it holds | Typed JS | Rust image |
| --- | ---: | --- | --- | --- |
| `sim.sprites`, `simHost.actorSim`, `map.actors` (page) | 624, 369, 360 | the actor hosts, the actor mesh layer's per-actor state, the decoded actors and their tags | per-actor numeric state into columns | the actor rows the Rust loops already read |
| `ScriptRuntime.instances` (+ `.cells`, `.state`) | 403 (+143, 133) | one instance a script object: its class, arena, base, reference array, cells and state | the byte image is already in Wasm memory ([object memory](object-memory.md) "Current storage"); what is left is the JS shell and the `refs` array | the object table (references as indices) |
| `CollisionWorld.actors...fieldTable`, `.cells`, `.collisionValues` | 205, 146, 115 | per-actor field tables and cells for the collision adapter | | |

### Linked classes, operands, functions and metadata (the script process's `linkedClasses`, `packageObjects`)

| Family | Slots | What it holds | Typed JS | Rust image | Risk |
| --- | ---: | --- | --- | --- | --- |
| `linkedOperands` + `linkedScripts` + `contextResults` (step 2, done) | 253 + 132 + 200 -> 99 | `WeakMap` script -> `Map` expression offset -> identity (script-objects.mjs `link`), script -> `Map` package index -> identity and script -> `Map` offset -> null-Context descriptor object: 7,222 scripts on the Island, 86,443 operands, 37,845 bindings, 11,651 descriptors | done: one `ScriptLinks` object a script (script-links.mjs, an Array subclass: the bindings' identities, then the context results' key and metadata, as its elements; offsets, binding positions, widths and the like in shared Int32 chunks); 28 k cells -> 8 k, 585 k slots -> 99 k | *(guess)* the lowered words could index the same dense array | low (done) | the digests, the link and class validators, the unit tests against the Maps |
| `linkedClasses.defaults` | 326 | `cls.defaults`: a `DefaultsMap` of field key -> `Map` array index -> value; *measured:* 85,437 entries over the Island's 967 classes, 75,126 of them the base's entry again, and 10,311 different value Maps (9,782 with one entry: 6,986 a scalar at index 0, 1,873 different) | **done (step 3):** the table is its own entries over a frozen layer of its base's (`snapshot()` is the layer, so images and attached objects share it), the value Maps are immutable and the scalar ones interned; 322 k + 77 k (`classImages.defaults`) slots to 59 k + 24 k | the class image holds the same values (script-runtime.mjs `imageCheckMode`) | low-medium |
| `linkedClasses.fields`, `.propertyLink`, `linkedClasses` | 331, 143, 123 | per class a `Map` name -> field identity (direct fields), the inherited chain as an array, and the class object | a dense array and a name index; the identities are objects and stay. `propertyLink` and `destructorLink` of a class that declares no property are its base's arrays: **done (step 3)**, 143 k to 59 k slots | the class rows for BindEvents ([rust-core.md](rust-core.md) 2026-11-10) are the start | medium |
| `packageObjects.function.body.tree`, `.built`, `.script` | 356, 138, 91 | decoded statements and expressions of the 900 functions that ran (nodes as literals since step 8), their compiled closures and the script's bytes view | a policy, not a representation: decode when a function runs and release it after, as step 8 did for operands *(guess: costs decode time on hot functions)* | the lowering (`RustScriptVm.lowerings.lowered.nodes`, 93, and `.entries.node`, 92) holds the words; the trees stay only for statements the lowering leaves to JavaScript | medium: the JS leaves need the nodes |
| `packageObjects.metadata` (`contextResults`: step 2, above) | 351 | `PropertyMetadata` (14 stored fields and the type's own), `FunctionMetadata` (13), `ClassMetadata` (7); `contextResults`: a null-Context result per Context node | columns for the numeric fields (`arrayDim`, `elementSize`, `flags`, offsets) behind the same getters | the property rows of the class image are the same numbers (offset, size, flags) | medium: readers use `Object.hasOwn` and spreads in places |
| `packageObjects` | 412 | the process table: 31,050 identities `{asset, index, key, kind, name, loadRecord, function, metadata, fieldPending}`, 32,000 key strings | the key strings could be dropped for a (package, export) int key; identity objects stay (they are the public handle) | | medium |
| `ScriptResourceRegistry.resources` | 219 | `Map` key -> resource record (textures, sounds, meshes, fonts: byte arrays and header values) | | | |
| `ScriptObjects.objects` | 126 | the level's identities | cleared per level already | | |

## Order

By value slots recovered per unit of risk, and by what each unlocks:

1. **Done (step 1):** the records' int words, `instanceValues` and `defaults.data` as `OffsetMap`, `recordsOfAddress`. About 0.6 M slots
   by the estimator; the numbers are in [the plan](firefox-60fps-plan.md#native-slots-out-of-the-collectors-marking-2026-11-10). It costs the Island's boot 30 to 90 ms (0.6 to 2.6% on a quiet host, interleaved, more under load): a slot read is a typed load and a compare, a write a little more.
2. **Done (step 2): the per-script offset tables** (`linkedOperands`, `linkedScripts`, `contextResults`: 585 k slots and 28 k cells by
   the estimator on the Island, 99 k and 8 k after; the whole page 12.13 M to 11.57 M slots and 1.49 M to 1.46 M cells). One `ScriptLinks`
   object a script in one `WeakMap` (the key keeps the lifetime), no lifetime change; the numbers are in
   [the plan](firefox-60fps-plan.md#the-per-script-offset-tables-2026-11-11). No measurable cost: the Island's boot 5,716 against 5,679 ms
   and its tick 4.38 ms against 4.38 ms (interleaved medians, four runs an arm).
3. **Done (step 3): the linked classes' defaults and property links.** A class's defaults table is its own entries over a frozen layer of
   its base's (88% of the Island's 85,000 entries repeated the base's), a class image and an attached object's snapshot are that layer
   instead of a copy, a default's values are immutable and a scalar is one shared object, and a class that declares no property holds
   its base's `propertyLink` and `destructorLink`. Whole page 12,133,600 to 11,684,788 value slots (-3.7%), cells 1,485,826 to
   1,480,334 (-0.37%); the five families it touched 553 K to 144 K slots. Output identical (digests, frame and HUD streams, `npm test`,
   38 validator filters with the links frozen); the Island's tick -1.4% and boot -0.1% to -1.8%, within the spread. The numbers, checks and load time are in
   [the plan](firefox-60fps-plan.md#the-linked-classes-defaults-and-property-links-2026-11-11); Firefox's marking, with step 2: [six cuts against the base](firefox-60fps-plan.md#six-cuts-against-the-base-interleaved-2026-11-12) (`CC_FINISHED` -17%, `FULL_GC_TIMER` -13% and still past 1.5 s).
4. **Hash tables** (343 k raw, 229 k references): delta tables if nothing writes a linked table afterwards (a check to write first);
   otherwise indices into the object table when it exists.
5. **`objectHash`** (115 k, 35 k strings) and the identity table's key strings (32 k): numeric keys.
6. **Metadata columns** (351 k): the numbers behind getters; compare against the class image's rows (`verify` mode).
7. **The function trees' policy** (356 k + 138 k + 91 k): decode on demand and release, measured against the first-tick cost.
8. **The records as object-table rows**, with the hash tables and class defaults as tables of indices, and the explicit releases the
   collection performs: the Rust core's design, and the only step that moves reference slots (the 160 k record references of the load
   graph, 229 k of the hash tables, 331 k of the class field maps) out of the marker's reach. It needs a release at every place a JS
   reference kept an object alive today (`script-process-collection.mjs` purges, `forgetLevel`, `detachExport`): the memory over many
   maps (row 7.4.2) is its check, and a differential of the survivors of each collection against the JS references.

Instances (the third table) go with the other worker's object-image changes and are not ordered here.

## What step 1 taught

* **The estimator is attribution-sensitive, the sum is not.** A family is the first path the walk met, so a cut moves objects between
  families (the `defaults.data` maps' contents were counted under other families after it); compare the whole page's slots, and read a
  family only with `--inside`.
* **A record's named fields are most of what is left of it.** 16 fields a record is 550,000 slots (the elements are 304,000): the
  numbers among them (`nativeAddress`, `loadOrdinal`, `objectFlags`) and the nulls (`script`, `hashBuckets`, `farrays`, `instanceValues`,
  `defaults`, `nativeConstructor`, `base`, null for most records) are the next layer, and a SpiderMonkey object holds 16 fixed slots, so a
  17th field is a slots buffer of its own *(from the engine's design as I read it; not measured here)*.
* **A typed array per record is a cell per record**, which is the wrong currency: the chunks are shared and the store keeps no object.
* **Shapes must not carry values' kinds** (6,935 shapes and 25 MB of position tables against 304), and an offset map whose entries come
  in a per-class order must not have shapes at all.
* **Tests must not assert on graphs**: a failing `assert.equal(shapeA, shapeB)` makes node inspect the shape graph without a limit (75 GB).

## What step 2 taught

* **Identities cannot go into a shared chunk of references.** The numbers of a script's tables (indexes, offsets, positions, widths) are in
  shared Int32 chunks, but the identities are elements of the script's own object: a chunk of references would keep the identities of every
  dead script that shares it alive, which is the lifetime change this plan avoids. The same holds for the descriptors' metadata.
* **V8's element store for an object that grows one element at a time is 17 slots at least**, and the estimator counts it; an `Array`
  subclass made with its length is exact (`%DebugPrint`). Growing it later is not exact either, so a script whose results are prepared after
  its link gets a new object sized for them.
* **Dropping what nothing reads cut more than the container swap.** The descriptors kept a spread copy of each function result's property and
  its own metadata (3,374 of each for 349 functions): the three families fell from 585 k to 99 k slots, the page by 0.56 M.
* **The tables no longer exist as Maps for the validators**: a check that compared the process's `contextResults` field now compares
  `scriptLinks`.

## What step 3 taught

* **Measure the table before choosing the representation.** The plan guessed 25,000 inner Maps and an inline-first-entry store; the Island has 10,300 value
  Maps, and 88% of the 85,000 outer entries repeat the base's. A layered table over frozen layers took 75,000 entries out; interning the scalar value Maps took
  5,100 objects.
* **A class image is a snapshot, so a frozen layer is the right copy.** `new Map(cls.defaults)` for each image and attached object was another 77 K slots
  (14% of the four families); `snapshot()` costs nothing.
* **The cell count barely moves when the references do** (-0.3% cells against -3.7% slots): this family's gain is in what the marker visits, not in how many
  objects it marks.

## Checks every step needs

* Output identical: bench-sim digests (Island `15e3720088490242`, Training `148077479825af78`, 747 `ad8e591a01434df5` at 300 ticks),
  `frame-alloc-meter --compare` (Island 600 frames, 747 and Training 400), `hud-stream-digest --frames 1500 --stream --compare`, the unit tests,
  and the validators of the area (load graph, class link, state link, save and load, travel).
* The estimator's slots and cells, base and branch from the same method (`map-memory-census.mjs --snapshots 1`, `heap-families.mjs
  4 40 --slots`).
* The marking itself: the interleaved Firefox roams of [Both cuts against the base](firefox-60fps-plan.md#both-cuts-against-the-base-interleaved-2026-11-10)
  (`hitch-run.mjs --gc-markers`, `gecko-gc-windows.mjs`); a step that moves references also needs the memory over many maps.
* Boot time (`bench-sim --ticks 3`, interleaved): the load graph is built at every map load.

## Unresolved

* Whether SpiderMonkey's marking time follows slots, cells or edges to cells in this heap. Step 1's before and after is one data point;
  a synthetic page (N records of each representation, a major collection forced through the profiler's markers) would separate them.
* Which of the 1,339 hash tables are ever written after a derived state copied them.
* Whether the Rust object table's design (indices, explicit release) can carry the load graph's records without a JS shadow for the
  validators and the save path that read `record.nativeSlots` directly.
