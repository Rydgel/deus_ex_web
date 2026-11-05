# Original collision hash evidence

Static registration, removal before transform changes, and line-query ordering
are translated and compared with original native execution. This document does
not establish complete Stage2 integration.
Authority is the hash-verified local GOTY Engine.dll/Core.dll/MSVCRT.dll, not an
external engine implementation. Disassemblies and native captures remain ignored.

## Contract recovered before implementation

Engine `10357ab0` initializes three identity permutations of 16384 entries and,
for each index, swaps X, Y, then Z with `rand()%16384`. Original CRT rand and
srand use thread data +0x14; process-start seed is not established here. A fixture
seed is an explicit input, never evidence of actual game's startup RNG state.

`10357e30` selects Brush, Mesh, then level engine primitive and requests its
collision box through vtable +0x64. Each float32 box coordinate becomes
float32((coordinate+32768)/256), then x87 nearest-even FISTP, clamped 0..16383.
No validity-byte check appears in this conversion.

`103580b0` requires bCollideActors, skips Actor+0x28 flag0x80 (bDeleteMe), asserts no existing
reference, traverses inclusive cells X outer/Y middle/Z inner, and prepends
{actor,next,tag} to buckets. Bucket = X[x]^Y[y]^Z[z]; tag is unsigned
`((z*256+y)*256+x)`. Finally Location is copied to hash-location.

`10359160` makes the query box from start/end and extent. X's extent arithmetic
stays on x87 until the cell conversion float store; Y/Z store the expanded bound
to float32 first. It traverses the same cell order, rejects different packed
tags, marks actors before primitive checking, calls primitive vtable +0x58 with
end/start/extent and the low byte of flags, then prepends each collision result.
There is no sorting or 64-result limit in this hash routine; upstream behavior
must handle those separately. Even misses are deduplicated.

## Boundaries

Primitive callbacks isolate the hash algorithm and do not prove primitive
geometry fidelity. Destruction beyond the Actor flags0x80 (bDeleteMe) skip, nested queries, query-tag overflow,
and the complete MoveActor scheduling contract remain unsupported. Original
startup RNG state remains unknown. Level actor registration order is traced below.

## Removal evidence (captured before translation)

`103583a0` checks the same flags, compares current Location with hash-location
(and logs a mismatch), then obtains the current primitive box. For every cell
bucket it unlinks **all** references to the actor, without checking packed tags,
and returns links to the free list. It asserts that no references remain.
The supported API requires removal before changing the actor transform/bounds;
it uses registered cells as a snapshot of that unchanged original input.
Original captures of overlapping multicell actors a,b return a,b; removing and
re-adding a in identical cells returns b,a. Moving a away after removal leaves b.
Updating only when cell occupancy changes would therefore lose original ties.

## Original initial registration order

`ULevel.SetActorCollision` at `1039d390`, enabling branch `1039d3d1`, creates the
hash. `1039d3dc..1039d404` iterates Level.Actors from index zero upward, skips null
actors and actors without bCollideActors, and calls hash vtable +8 (AddActor).
`decodeMap.actors` preserves this original Level.Actors order. Export-table order
is not the registration contract. The disassembly is in ignored
`.cache/reference/SetActorCollision.asm`. Full movement scheduling and the exact
conditions under which original MoveActor removes/re-adds remain caller work.

## Seed-independent domain and exact full-domain mode

With every registered and queried cell in 0..255 on each axis, the packed tag
is an injective base256 encoding. Bucket permutation collisions only insert
links with different tags, which are skipped without marking actors. Filtering
those links leaves each cell's reverse insertion order unchanged. Cell traversal
is independent of the tables, and the first matching occurrence alone marks an
actor. Thus candidate visitation and prepended hit order are seed-independent
in this domain. This remains true after removal because it preserves the order
of surviving links. `createCollisionHash()` enforces that domain for both
registration and queries; it throws before a larger operation mutates anything.

Original captures with seeds1,123,2882400001 verify identical cell/callback/hit
orders, including multicell deduplication, misses, repeated queries and more
than64 hits. The separate original bounds corpus has132 real mover transforms
(25 Training and19 Liberty movers at closed/mid/open). Their cell range is
min[103,86,125], max[158,149,128], with no outlier; local inventory is
`reports/movement/native-hash/bounds-domain.json`. This does not establish all
possible movement queries or arbitrary mod-map bounds; each operation checks.

Full-domain `createCollisionHash({tables})` accepts three captured permutations
in X,Y,Z order. `{seed}` constructs the original CRT fixture permutations and
must never be described as the unknown original session startup state. Native
seed1 has a real alias: cells[8,206,128] and[264,205,128] share **both** packed tag
and bucket. Querying either visits both actors. Full-domain mode reproduces that
behavior; replacing buckets with unique cell keys would incorrectly omit one.

## API and intentional unsupported behavior

- `addActor(actor,bounds,{collideActors,actorFlags,location})` stores actor identity,
  returns `{cells:{min,max},hashLocation}`, or null for Actor flags0x80 (bDeleteMe). Supply the
  original flags/location explicitly when the actor representation uses capitalized
  property names. Bounds use `{min,max,valid}`; original hash ignores `valid`.
- `removeActor(actor,bounds?,{collideActors,actorFlags,location}?)` removes before
  changing the registered transform; optional bounds/location check this precondition.
  The saved cells represent the unchanged primitive bounds. Unsupported changed
  cells/location throw instead of guessing original logging/error behavior.
- `actorLineCheck({start,end,extent,extraNodeFlags},callback)` calls
  `callback(actor,{start,end,extent,extraNodeFlags})` once per candidate. Return
  null/undefined for clear or a hit value for collision. Returned hits preserve
  native linked-list order, without sorting or limiting. Callback inputs are
  float32 and flags are masked to the original low byte.
- Nested queries and mutation from a callback throw. A per-operation cell budget
  defaults to1000000; exceeding it throws before registration/query work instead
  of returning partial results. This is an explicit host limit, not game behavior.

The X query cell expression uses64-bit binary significand rounding to match x87.
Original point128.001953125 with extent1e-12 or1e-14 yields X max cell129 while
Y/Z remain128; extent1e-16 yields128 on all axes. JS double arithmetic alone
lost the small term and failed these native cases. The translation retains it
until the original float32 store.

## Reproduction and limits of validation

```sh
node --test test/collision-hash.test.mjs
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-native-hash.mjs
```

The driver requires Unicorn2.1.4 and the hash-verified local GOTY Engine/Core/CRT
DLLs. It writes cases, original outputs and summary under ignored
`reports/movement/native-hash/`. The original constructor, CRT rand/srand,
GetActorExtent, AddActor, RemoveActor, ActorLineCheck and FMemStack run natively.
The fixture supplies OS thread-local/error state, a bounded free-link pool and
bounded FMemStack storage. Primitive bbox/line callbacks supply controlled boxes
and hit outcomes; no hash/math/sorting response is replaced. Unknown imports fail.
This establishes hash mechanics and order independently of primitive geometry;
combined world/brush/primitive validation remains an integration requirement.

Current differential result:6 case groups,510 registration comparisons,62 query
comparisons,3426 primitive callback comparisons and294912 permutation entries,
zero mismatches. Six regression tests pass. These counts include exact-table
and seed-independent executions where applicable. Emulation uses the base
harness's x87 control word0x037f (nearest-even,64-bit significand); alternate
control-word states are not established.

Actor+0x28 is the first Actor boolean word, not UObject ObjectFlags. Original
Actor.uc places bDeleteMe eighth in that word (mask0x80). The API now names this
`actorFlags`; `objectFlags` remains a deprecated compatibility alias for old
controlled fixtures, with actorFlags taking precedence. Existing native fixtures
used zero for this live-actor word and remain valid.

## The hash reads the image (2026-11-05)

Row 7.2.2 and 7.2.4 plan, step 1/2 ([the Firefox plan](firefox-60fps-plan.md)). The Rust line checks (R3-b) came back
to JavaScript for every candidate actor (`lc_candidate`), every joined actor hit (`lc_mover`) and every examined hit
(`lc_accept`). On the Wan Chai scan route (1,500 ticks, `scan-scenario.mjs`) that was 1,022,815 candidate, 45,098 isMover
and 116,623 filter imports, about 680, 30 and 78 a tick, and in Firefox's slowest tenth of frames `candidate` held 1.10 ms
(Wan Chai), 0.69 ms (Battery Park) and 0.22 ms (Island) of the tick.

### Placement

The hash lived in the trace kernel's own instance (R3-b B0), which cannot address a runtime's object image. It now moves
to the runtime's interpreter instance once that exists:

* `runtimeLineKernel(vm)` makes a `TraceKernel` over the interpreter's exports and object arena (`createRuntimeTraceKernel`:
  its views follow the arena's growth, and its released ranges wait for the level tick's `reclaim()`). The interpreter's
  imports now include hash.rs's three (`lineCheckImports`).
* game.mjs calls `collision.adoptRuntime(scriptVm)` once `createScriptDoors` has returned. `KernelHashStore.adopt` builds a
  new hash in the runtime's arena and adds every registration again **in the order it was first added**
  (`cellsOf`, a Map in add order), which gives every cell's LIFO list the order it had: the visit order, hence every
  query's candidate order, is unchanged. Registrations made after that (the next `registerActors`, on reset) go straight
  to the runtime's instance. Models (the world BSP, mover brushes) are uploaded there on first use, as they were in the
  trace kernel's instance.
* `HASH_KERNEL=js`, `TRACE_KERNEL=js`, `SCRIPT_VM=js` and `COLLISION_HOST=js` keep the hash in the trace kernel's instance
  with the three JavaScript imports.
* Line checks reach the instance from JavaScript imports of the interpreter itself (the pawn MoveActor's `js_move_hits`,
  perception's `lightLineCheck`, the walking prelude), so `lc_line` and `lc_scan` run nested inside interpreter frames.
  Only the shadow stack pointer is shared with them; the host puts it back after an import that throws (`stackPointer`).

### What each registration's JavaScript reads

`valuesOf(actor)` is `actor.collisionValues ?? actor.values`; the filter reads `actor.owner`, `actor.lineage` and
`actor.collisionBits`. Wan Chai's candidates by kind (1,500 ticks, counted in `candidate`):

| Kind | Candidates | `valuesOf` | Image cells? | hash.rs |
|---|---:|---|---|---|
| Map mover brush (`actor.model`) | 394,328 | game.mjs's `collisionValues`: `Location` and `Rotation` getters over the host's `position` and `rotation` (pose members), `PrePivot`, `PostScale` and `MainScale` copied from the serialized values and written by nothing | `position` and `rotation` are accessors over the image once installed (`actor-pose-fields.mjs`); the rest are constants of the copy | ToWorld memo keyed by the image's Location and Rotation bits |
| Map actor with live collision (`linkDecorationCollision`, `linkLiveCollision`: decorations, map pawns, move hosts) | 408,269 and 92,530 (pawns) | getters over `host.position`, `host.radius`, `host.height` | the same pose accessors: image cells at +0x114, +0x1d4, +0x1d8 | image read |
| Map actor never moved (no `collisionValues`) | 104,736 | the serialized `values` object, a snapshot, not the image | not the storage, but equal to it until the actor moves | the snapshot's numbers, while the image holds the same floats |
| Spawned actor (collision view) | 16,334 | getters through the view: `readNamed` storage, the image for a linked class | yes (`values === collisionValues`, both carry the view) | image read |
| The player's facade | 6,264 | getters over `player.position` and friends (JavaScript state) | no | JavaScript |

`collisionBits` is the +0x1dc word without bCollideWorld for a map actor whose flag words are installed
(`actor-flag-words.mjs`), the four bools composed from its fields for a spawned actor, and a host copy for the player
and for a host whose flag words are not installed. The owner chain is `actor.owner`: a host member (a host copy for a map
actor, the `Owner` field for a spawned one).

### What hash.rs answers, and when it hands the question to JavaScript

Each registration has a descriptor (`images` in the header: handle, flags, memo record):

* **Class facts** (`D_KIND`, `D_MOVER`, filter flag), written when it is registered, from `actor.lineage`, which fixes
  `isMover(actor)` and the first of LevelInfo (4), Pawn (1), Mover (2), ZoneInfo (8) that SingleLineCheck's filter tests. A registration whose
  lineage is not an array has none.
* **A live cylinder** (`D_IMAGE`) when `collision-image.mjs cylinderImageHandle` says `valuesOf(actor)` reads the image's own
  cells (the two kinds above), and the actor has a handle. hash.rs reads Location, CollisionRadius and CollisionHeight
  through `Obj::of(handle).has(...)`, the render scan's test that the image holds the fields as `readNamed` reads them
  (not a HOST receiver, no bound key, a class row that resolves the spelling to the key); it answers from the image
  only then and calls `lc_candidate` otherwise. The first import of a registration that was not examined at
  registration (a spawned actor registered before its collision view exists) examines it (`consider`).
* **A serialized-values actor** (`D_STATIC`): the registration keeps the five numbers `valuesOf(actor)` gives it (Location,
  CollisionRadius, CollisionHeight of the serialized `values`) in a record, and hash.rs answers with them only while the
  image's three cells hold those same floats (exact comparison; NaN declines). Nothing in `src/` stores to a host's
  `values.Location`, `CollisionRadius` or `CollisionHeight`, so the record is what the JavaScript reads; the image
  comparison is the guard for the case the JavaScript's snapshot is stale against the image (a script writes `Location` of
  an actor that was never given live collision): the image then differs from the record, hash.rs asks the
  JavaScript, and the answer is the one it gave before. An actor that moves natively gets live `collisionValues`
  (`linkDecorationCollision`, `linkLiveCollision`) inside a remove and add, which describes it again as a live cylinder.
  This is the one claim that rests on "nothing writes `values`" rather than on a shared cell; `COLLISION_HOST=verify`
  checks every such answer against the JavaScript's.
* **A mover brush** (`D_BRUSH`) when its pose members are image-backed (`moverPoseInImage`). The ToWorld the JavaScript
  computed last is kept in a 128-byte record with the Location and Rotation it was computed for; hash.rs reuses it while
  the image's Location and Rotation bits are those, and `lc_candidate` runs (and refreshes the record) otherwise.
* **The filter**: owner chain (computed once per query by the host, as registration ids, into `CTX`), class flag, and for
  an actor of none of the four classes under `flags & 0x20` the image's four collision bits (`bCollideActors`,
  `bBlockActors`, `bBlockPlayers`, `bProjTarget`, `Obj::has` again). Without a descriptor, a chain longer than
  twelve or a getter that throws, `lc_accept` answers.
* **Not answered**: a map actor with no `collisionValues`, the player, a registration without a handle, a field the
  receiver table does not hold in the image, and everything inside `trace.rs` that was already Rust.

### Modes and the check

`COLLISION_HOST=js|verify|rust` (`?collisionHost=` in the viewer, default rust). `verify` makes hash.rs compute its image
answer for every candidate, isMover and filter test it could answer, then call the import as before; the import
compares (`Object.is` on every number, the brush's twelve ToWorld numbers and model address) and throws
`collision host differential` on a difference. `COLLISION_STATS=1` prints the crossings and the answers from the image at
exit (`kernelStats`, `imageAnswers()`), with the milliseconds the imports took.

`scripts/validate-collision-kernel.mjs` runs its level section with the hash in a runtime's instance
(`COLLISION_INSTANCE=runtime`) and after `adoptKernel` (`COLLISION_INSTANCE=adopt`); the fixtures have no image
identity, so it covers the placement, the migration, the class facts and the owner-chain context. The image reads are
checked in Play by `bench-sim` runs under `COLLISION_HOST=verify` (below).

### Results (2026-11-05, Linux host, Node, `bench-sim --render-feedback`)

State digests are unchanged in `js`, `rust` and `verify` (`verify` throws on any difference):

| Map | Run | Digest | js | rust | verify |
|---|---|---|:-:|:-:|:-:|
| 01_NYC_UNATCOIsland | 60 warm + 300 ticks | 5adb254a07b1ed6f | = | = | = |
| 00_Training | same | 07816ec472f29b84 | not run | = | = |
| 03_NYC_Airfield | same | 46ed0d32ae5b56af | not run | = | = |
| 06_HongKong_WanChai_Market | same | 80d27b37e0944d88 | not run | = | = |
| 15_Area51_Bunker | same | 764a7bdffd2ebe59 | not run | = | = |
| 06_HongKong_WanChai_Market | `scan-scenario.mjs`, 300 warm + 1200 ticks | 25db7596647e2aeb | = | = | = (7.8 million answers compared) |
| 01_NYC_UNATCOIsland | same | 0b4d06c72afd1c1d | = | = | not run |
| 15_Area51_Bunker | same | ccd09a24aaaad820 | = | = | = |

(The five baseline digests are the ones recorded before this change. The long-route digests are the first runs of that
route in `js` and `rust`; the Wan Chai one also matches the 2026-11-05 census run before any of this code.)

The crossings dropped (`COLLISION_STATS=1`, the long route, 1,500 ticks; "ms" is the time inside the imports, nested time and
the timers' own cost included):

| Map | Imports in `js` (candidate, isMover, filter) | ms | Imports in `rust` | ms |
|---|---|---:|---|---:|
| Wan Chai | 1,022,815, 45,098, 116,623 | 750 | 7,014, 0, 51 | 18 |
| Island | 640,568, 57,316, 178,742 | 475 | 6,830, 4, 46 | 22 |
| Bunker | 439,187, 25,937, 61,776 | 309 | 6,213, 8, 56 | 23 |

What is left in `rust` is the player's cylinder (6,264 of Wan Chai's 7,014; its facade is JavaScript state), 240 to 354
imports before the hash moves into the runtime's instance, and the first visit of each mover (a memo miss).
Candidates answered from the image on the Wan Chai route: 517,133 cylinders, 104,366 serialized-values actors and
394,302 mover brushes, 335,169 isMover and 489,033 filter tests. The Rust side caches a registration's cylinder for the length
of a walking-surface scan, as the import's answers were (the first version read the image at every visit: 3.4 million reads on the
Island's route against 640,568 imports, which cost about what the imports had).

Headless `bench-sim` tick means on a machine shared with other agents' runs (not an A/B): Wan Chai 4.35 ms in `js`, 3.83 and
4.2 in two `rust` runs; Island 6.82 and 7.39; bunker 5.57 and 5.99. The imports' share of the tick in `js` was about 0.5 ms a tick
on Wan Chai, 0.3 on the Island and 0.2 on the bunker; the browser A/B is the main session's.
