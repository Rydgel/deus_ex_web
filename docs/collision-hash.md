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
