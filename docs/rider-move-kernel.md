# Noncolliding rider MoveActor

This is a bounded memory-backed path through original `ULevel::MoveActor`
(`Engine.dll 0x103990e0`), not permission to skip inventory movement. NPC
weapons and ammunition are based on their owners by original scripts and
must follow every accepted move. See [NPC inventory startup](script-npc-weapon-startup.md),
[MoveActor](move-query.md), [map actor moves](script-map-actor-move.md), and
[Rust core B4](rust-core.md).

## Measured scope before implementation

The September 30 `ef47f61` Island browser profile attributes about 0.57 ms
per frame to `moveSpawnedActor`, excluding the first AudioContext activation.
An untimed 60-warm/60-measured-tick census found 12,344 rider moves. Every
one was a spawned actor with no collision bits, no riders, empty Touching,
no brush/Pawn classification, no poisoned fields, and no bindings on the
required move/zone fields. 1,876 calls had a tiny delta. The capture and
instrumentation remain local under `.work/`; these are workload counts,
not an estimate of achieved speedup.

## Original contract

The authority is the hash-pinned installed Engine.dll used by the existing
native movement oracles. Admission requires the same image cells as the
spawned actor's native view, including the four authoritative Touching slots.
Bound map/player Touching arrays do not qualify.

For a movable, nonstatic, non-Pawn, non-Brush actor, with no collision or
blocking bits, no standing riders, and no current touches:

1. Convert the requested delta to float32. A component-wise delta below
   `0.0001` takes the recovered near-zero return: apply NewRotation, keep
   Location, and do not call SetActorZone. This includes exact zero and
   changed rotation with no standing riders (`0x1039915a–0x10399240`).
2. Otherwise collision selection makes no line query. The displacement is
   the requested delta and the hit remains empty at time 1.
3. The non-Pawn CheckEncroachment call (`0x10399bb5–0x10399c8e`) returns
   false before any query when collision bits `& 0x0d` are zero and Brush
   is null (`0x1039a350`). No hash remove/add, Bump or Touch callback runs.
4. Commit `Location = float32(Location + Delta)` component by component,
   then NewRotation. **OldLocation is untouched.**
5. SetActorZone(actor, false, false) follows. The optimized path may finish
   only if its original point query keeps the current zone (or bDeleteMe
   makes SetActorZone return immediately). A zone change, invalid BSP,
   released zone identity or non-authoritative field requires the existing
   JavaScript body. Determine this before any actor store.

## Implementation and focused verification

`move-actor-kernel.mjs` admits only spawned collision views whose named
fields resolve to the linked image cells. Pawn/Brush ancestry, a nonnull
Brush field, relevant host bindings, poison, released images and malformed
inputs retain the JavaScript path. It verifies the exact four-pointer
Touching layout and the byte cells for StandingCount and ZoneNumber.
Bindings only add or replace keys in the runtime; the cached per-instance
admission is invalidated when the key count changes. Replacement of an
already checked key cannot change admission.

`move_actor.rs` reads the remaining dynamic gates from the image and makes
no imports. A non-tiny move precomputes the resulting region before storing
anything. The existing `zone.rs` point query, released-handle check and
region-store helper are shared; their arithmetic is unchanged. The body
then writes Location, Rotation and Region in their original order. It does
not touch OldLocation. Every guard failure returns to the complete existing
`playerMove` body with the image unchanged.

`validate-rider-move-kernel.mjs` passes:

* 13 full original MoveActor cases through the installed Engine.dll,
  including positive/negative delta threshold neighbors, seven tiny moves,
  changed/unchanged rotations, int32 rotation limits and float32 addition
  boundaries. No scene instructions are bypassed. The original
  CheckEncroachment executes; SetActorZone is the explicit observed virtual
  call boundary, including its arguments and the newly committed pose.
* The same cases through the Rust image entry and JavaScript movement/zone
  references, preserving signed zero and adjacent image bytes.
* 16 hand-backs leaving the whole actor image unchanged: static/immovable,
  collision/block flags, riders, Brush, Touching, invalid position/extents,
  changed zone, invalid BSP, nonfinite delta and finite-input position overflow. A deleted actor commits its
  move while preserving Region, as SetActorZone returns immediately.
* Each of the 15 observed field bindings invalidates a cached admission;
  unrelated binding replacement remains admitted, and a shadowed Touching
  field is refused.

`MOVE_RIDER_DIFFERENTIAL=1` replays each completed Rust move on a virtual
actor through `playerMove` and `setActorZone`. It compares result,
Location/Rotation/Region, unchanged OldLocation, and expected callback
counts, while rejecting any unexpected query or event. At 60 warm plus 60
measured ticks with headless render feedback:

| Map | Rust calls | Tiny calls | State digest | Errors / unsupported |
|---|---:|---:|---|---|
| Island | 12,344 | 1,876 | `451ed65426ea38e7` | 0 / 0 |
| Training | 190 | 18 | `5aa52117609ca765` | 0 / 0 |

The Island digest equals the pre-change census. A small zone-helper regression check passed
1,050 points, including 33 expected invalid/cyclic cases. A Training run
with `ZONE_KERNEL=js` completed zero rider-kernel calls and kept digest
`5aa52117609ca765`, with no errors or unsupported natives. The final Island
differential was repeated after all admission guards with the same counts
and digest. These differential runs are correctness checks, not performance
measurements.

`MOVE_RIDER_KERNEL=js` (Node) or `DEUS_EX_MOVE_RIDER_KERNEL='js'` (browser,
before module loading) keeps this family in JavaScript for isolated A/B
measurement. `ZONE_KERNEL=js` also disables this path so every zone body
continues to use the JavaScript reference. This implements one B4 family slice; colliding actors,
nonempty Touching, standing riders, brushes, pawns and zone-change callbacks
continue through the existing path. Full B4–B6 remains open.


## Isolated cost, September 30

Two interleaved pairs ran the same 60-warm/300-measured-tick Island workload
with headless render feedback. The order was JS → image → image → JS. Only
`MOVE_RIDER_KERNEL=js` differed between modes. A diagnostic wrapper timed
`moveSpawnedActor` with the saved real clock during the benchmark's measured
steps; this includes the host admission, image call and result construction,
and includes the same timer overhead in each mode.

| Pair | JS rider entry, ms/tick | Image rider entry, ms/tick | JS whole-tick median, ms | Image whole-tick median, ms |
|---|---:|---:|---:|---:|
| 1 | 0.567 | 0.081 | 13.17 | 13.11 |
| 2, reverse order | 0.561 | 0.088 | 12.69 | 14.17 |

All four runs made exactly 23,905 rider calls during the measured 300 ticks,
had digest `b767a7e417fe5968`, and had no errors or unsupported natives.
The isolated rider entry took about 85% less time, saving about 0.48 ms per
headless tick in this workload. Whole-tick means were 13.64/13.86 ms in
pair 1 and 13.45/14.92 ms in pair 2 (JS/image). **No overall tick-time or FPS
improvement is established by these runs.** These are instrumented host
measurements, and the renderer is absent. The separately measured browser
frame budget remains the relevant limit for 120 fps.

The local records and preload wrapper are `.work/logs/rider-cost-{js,rust}-{1,2}.{json,log}`
and `.work/tools/rider-cost.mjs`. Reproduction uses:

```
MOVE_RIDER_KERNEL=js node --import ./.work/tools/rider-cost.mjs scripts/bench-sim.mjs --map 01_NYC_UNATCOIsland --render-feedback --warm 60 --ticks 300
node --import ./.work/tools/rider-cost.mjs scripts/bench-sim.mjs --map 01_NYC_UNATCOIsland --render-feedback --warm 60 --ticks 300
```

The wrapper saves `performance.now.bind(performance)` before bench-sim pins
the clock, and surrounds `ScriptRuntime.prototype.moveSpawnedActor` with
that real clock only while `globalThis.__boundReadsOn` is true (the existing
benchmark's measured-step gate). It sums elapsed milliseconds and counts
calls; neither that instrument nor the local captures is shipped in Play.

## Noncolliding FarMoveActor

`render.rs` `far_move` runs `ULevel::FarMoveActor` (`0x10398ba0`,
`relocation.mjs farMoveActor`) with Test 0 on a spawned non-Pawn,
non-Brush collision view, where that body would run no callback and no
query. Its gates, all read in the object image through the render field
table before any store:

1. Movable and not static (else the body returns false at its first test;
   the JavaScript returns that).
2. No bCollideActors, bBlockActors or bBlockPlayers and no Brush: the hash
   remove/add is skipped (`collides` is bCollideActors), and the non-Pawn
   CheckEncroachment (`0x1039a350`) returns false before any query, as in
   step 3 above.
3. No FindSpot: bCollideWorld and bCollideWhenPlacing clear, or bNoCheck.
4. StandingCount 0, so no rider is detached through SetBase.
5. A finite destination, and SetActorZone keeping the current zone (the
   same point query and hand-back as the rider move), or bDeleteMe, where
   SetActorZone returns at once.

It then stores bJustTeleported, Location and OldLocation (the float32
destination) and the new Region, and returns success. Anything else
leaves the actor untouched for the JavaScript body. Island's users are the
pawns' carried weapons (Actor.Tick's FarMoveActor of a drawn weapon, about
23 per tick), the Shadows' SetLocation and the LaserIterator's proxy
segments. `FAR_MOVE=js` (`?farMove=js`) keeps the JavaScript body;
`FAR_MOVE=verify` runs it again from the restored state after every Rust
move and compares the result, Location, OldLocation, bJustTeleported and
Region. Island and Training digests (both engines), browser runs on Island,
Training and 02_NYC_Street (400 frames walking), `validate-lasers-play`,
`-npc-weapon-startup`, `-weapon-select`, `-native-relocation` and
`-script-set-location` pass under it.
