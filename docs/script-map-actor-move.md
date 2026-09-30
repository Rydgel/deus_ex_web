# Map-actor movement — 2026-09-24

The [reach census](stage-3-exit-criteria.md) stopped seven probes on two
messages. Both came from Play admitting map actors (level exports) to the
recovered move bodies only as a special case:

- `FarMoveActor for a non-held map actor is not linked`. Lifting a plant or
  a crate runs `DeusExPlayer.PutCarriedDecorationInHand`, which calls
  `SetLocation` on the decoration.
- `MoveActor for a non-spawned rider is not linked`. After DoFrob's
  `SetBase(Frobber)`, the next player step moves each based child through
  the recursive rider `MoveActor`.

## One surface for map actors

A spawned actor carries a field-backed collision view
(`installActorCollisionView`). A map actor is the level-load host object. Its
`flags`, `position`, `radius`, `height`, `rotation`, `base`, `standingCount`
and `touching` are the native members the collision hash, line filter and
move bodies already read. The retail `AActor` layout
([SDK reference](sdk-reference.md)) agrees with the offsets recovered earlier:

| Native member | Script fields | Host member |
| --- | --- | --- |
| `+0x1dc` bits 0–4 | `bCollideActors`, `bCollideWorld`, `bBlockActors`, `bBlockPlayers`, `bProjTarget` | `flags` |
| `+0x1ec` bit 8 (`+0x1ed` bit 0) | `bJustTeleported` | `motionFlags` |
| `+0x12c` | `OldLocation` | `oldLocation` |
| `+0x144` / `+0x150` | `Velocity` / `Acceleration` | `velocity` / `acceleration` |

Before this change, those script fields lived in a separate store. A script
write such as `CarriedDecoration.bCollideWorld = False` therefore left the
native word unchanged, and the carried decoration would still have been
blocked by walls. `script-doors.mjs` now binds the five collision bools onto
`flags` for every collidable non-player map export. It binds `bJustTeleported`
and `OldLocation` for non-pawn map actors.
`map-actor-native.mjs` `writeCollisionFlags` also refreshes the host's per-bit
copies (`collisionBits`, `collideActors`, `collideWorld`, `blockActors`,
`blockPlayers`, `blocking`), so no reader sees a stale bit.

Since stage 1e step 1 ([Rust core](rust-core.md) 1e-1) the flag members are
the image itself. `flags`, `actorFlags` and a map actor's `motionFlags` are
accessors over the actor's `+0x1dc`, `+0x28` and `+0x1ec` dwords
(`actor-flag-words.mjs`), and the per-bit copies derive from them. The
collision bools, bDeleteMe and bJustTeleported therefore need no binding.
A map pawn's `motionFlags` is the same image accessor; its physics view
reads and writes it (see [Rust core](rust-core.md) 1e-1, "Pawn motion word").
Since step 3 (1e-3) `position`, `rotation`, `radius`, `height` and a map
move host's `oldLocation` are accessors over the actor's `+0x114`, `+0x120`,
`+0x1d4`, `+0x1d8` and `+0x12c` cells (`actor-pose-fields.mjs`), so
`Location`, `Rotation`, the collision size and `OldLocation` need no binding
either.

Batch 5 joins the map actor's `Acceleration` to the same native surface as
`Velocity`. The recovered `AActor::setPhysics` zeroes both members at
`0x103c9676` when its re-read mode is None or Rotating, including after a
landing callback. Previously the map host's acceleration could be zero while
the VM's separate field remained nonzero. The existing native SetPhysics body
and non-Pawn falling adapter now observe one value. Reload discards the native
acceleration mirror before restoring the original fields. The focused public
pickup check seeds a map crowbar's acceleration, then verifies that original
`Inventory.BecomeItem` (`Engine/Inventory.uc:298–308`) clears it through
`SetPhysics(PHYS_None)` in both native and script reads.
`validate-item-pickup.mjs` passed this boundary and its existing pickup,
carried-movement and reset checks under the RSS watchdog: 44 seconds,
729 MiB peak (2 GiB cap).

## Bodies

No new translation was needed. Map actors now run the recovered bodies the
spawned views already run:

- **SetCollision (262)** on a map actor now runs `execSetCollision`
  `0x103e1900` → `AActor::SetCollision` `0x10369200`
  (`script-actor-collision.mjs`). Two differences from the old host path:
  - A skipped argument keeps its current bit. The host path treated it as
    false.
  - The actor is re-added to the hash when the new word collides. The host
    path only removed it.

  Batch 6 routes the controlled player through its original script tick and
  field-backed Pawn physics; its collision entry remains the player scene.
- **Rider MoveActor** (`0x103998a0`–`0x10399c8e`, test 0, ignoreBases 1):
  `ScriptRuntime.moveMapRider` runs the same `playerMove` body as a spawned
  rider. It replaces `moveHeldRider`, which was hand-derived for an
  Inventory rider with no collision, and admits any non-pawn, non-brush
  collidable map actor. For a near-zero delta, the recovered body applies
  only the rotation. The shortcut had also added the delta and updated the
  zone.
- **FarMoveActor** (`0x10398ba0`, `relocation.mjs`):
  `ScriptRuntime.relocateMapActor` passes the actor to the recovered
  relocation with the spawned path's level services: FindSpot,
  CheckEncroachment, SetBase detach and SetActorZone. It replaces
  `relocateHeldItem`. The Actor.Tick pawn tail's `FarMoveActor(Weapon,
  Location, 0, 0)` and `SetLocation` now both go through
  `ScriptRuntime.farMoveActor`.

Before a map actor first moves, `linkLiveCollision` points its hash
registration at the live `Location`/radius/height, as
`linkDecorationCollision` already does for a falling decoration. A map actor
registers with its serialized `values`, so the moved cylinder would otherwise
be removed and re-added at the load position.

Pawns keep their own move entry (`script-pawn-physics.mjs`), and movers keep
the brush entry. Neither is admitted here.

## Pawn view identity

The pawn entry moves a field view of the pawn (`pawnPhysicsView`), but the
original stores and compares `AActor*`, so Touching slots must hold actor
identities. BeginTouch `0x10369570` writes the source into the other
actor's slot through the reciprocal AddTouch. DestroyActor's Touching scan
and EndTouch `0x10369970` later match that slot against the registered actor.
The pawn move services therefore pass the host (`pawn.self`) to BeginTouch
and EndTouch, as they already do for hash registration and riders. Batch 6
first ran the controlled player through this entry, and it exposed the
earlier view identity: after `OrdersTrigger2.Touch` destroyed the trigger,
its slot kept the view, and EndTouch could not clear it
(`validate-world-destroy.mjs`).

The pawn's FarMoveActor kept the view. FarMoveActor `0x10398ba0` calls
CheckEncroachment with notify 1 ([relocation](relocation.md), step 3), and
its EndTouch/BeginTouch pass (`0x1039a7e7`–`0x1039a8d6`,
[check-encroachment](check-encroachment.md)) ran on
`checkActorEncroachment`'s default touch services, with the view as the
source. On Island, `ScriptedPawn.Sitting.Tick` calls `SetLocation` (native
267) every tick to slide UNATCOTroop6 onto OfficeChair0. At bench tick 271
(after the 60 warm ticks) the first overlap wrote the view into
`OfficeChair0.Touching[3]`. The path was execSetLocation →
`ScriptRuntime.farMoveActor` → `pawn.farMove` → `farMoveActor` →
`farLevel.checkEncroachment` → `beginTouch(view, OfficeChair0)`. Touch
events were right, because the pawn's dispatch maps the view, but the slot
was wrong. Neither DestroyActor(UNATCOTroop6) nor the EndTouch from a later
MoveActor could match it, so the chair would never get its UnTouch, and
bench-sim's digest walked the view's getters. `farLevel` now passes the host
to BeginTouch and EndTouch.

Two guards keep views out:

* The view carries its host under `ACTOR_IDENTITY` (a symbol, so not one of
  the view's keys). `beginTouch`/`endTouch` throw on a view
  (`actor-touch.mjs`).
* `identityOf` maps a view to its host where the original compares
  pointers:
  * IsBasedOn `0x1034c8d0` in MoveActor's candidate and touch filters
    (`move-query.mjs`, `player-move.mjs`) and in FindBase
    (`findActorBase`);
  * SetBase `0x10369c80`'s guard, which walks NewBase's chain for `this`
    ([actor queries](script-actor-queries.md) 298).

  The view never matched there before, so:
  * an actor based on a moving pawn could block it or receive its BeginTouch;
  * SetBase could build a Base cycle;
  * FindBase could send SupportActor to a floor riding the pawn.

  Throwaway counters over 300-tick Training and Island bench runs found no
  comparison that differs:
  * Island: 12,756 pawn MoveActors past the tiny-delta gate and 3,347
    move-query candidates;
  * Training: 1,302 MoveActors and 617 candidates;
  * in neither map did SetBase or FindBase run on a view.

  This part does not move either digest.

SingleLineCheck's owner chain (`line-filter.mjs`, the kernel's `accept` in
`collision-kernel.mjs`) still starts at the view, the plan's third view
comparison. It is the same bug class, and it is left:

* Only its first link, the pawn itself, differs. In the same runs the pawn's
  own cylinder was a candidate only in flags-6 queries (Island 8,950,
  Training 5,266). There the Pawn class test (flags bit 1 clear) rejects the
  pawn anyway.
* The pawn's Pawn-flag queries start at its own center: FindBase 0x17, the
  walking floor probe 0x17 and processLanded 0x37. From there,
  `primitiveLineHit` returns no hit on its own cylinder.
* Passing the host would lose the view's live `Owner` link. A map host's
  `owner` is the serialized load-time Owner (`game.mjs`), not the script
  field.

`test/pawn-view-identity.test.mjs` fails on the previous sources and covers
the slot, the guards and the three IsBasedOn/SetBase sites.

The Island bench digest moved from `babe023941d42a3c` to `6a178ec7baf98078`.
Checkpoints 10–270 are unchanged. Per-field digests at 280, 290 and 300
differ only in `OfficeChair0.Touching`: the slot now records
`@UNATCOTroop6`, where it used to walk the view. The touch sequence is
identical. The troop re-enters BeginTouch each tick, finds itself present,
and dispatches nothing, and no EndTouch falls in the window. Training
(`04f77dc631509ae4`) is unchanged. The JavaScript and Rust VMs agree at all
30 checkpoints of both maps, with no errors.

## Batch 6 stacked-decoration rotation contract

The continuous Training route reaches `DeusExDecoration.Bump` on a breakable
crate. Installed `DeusExDecoration.uc:425–490` gates pushing by pawn mass,
vertical overlap and the strength-derived maximum mass, writes Velocity,
starts Rolling/timer/noise as applicable, then computes a small yaw change
and calls `SetRotation(Rotation + rot)`. A crate with another actor based on
it has nonzero StandingCount, so native MoveActor cannot use the no-rider
rotation-only return. The local player's equivalent branch is documented in
[SetRotation](script-set-rotation.md).

The native entry is the same zero-Delta MoveActor with four zero flags.
`0x103998a0–0x10399bb0` recurses over actors based on the source; the recursive
calls use ignoreBases=1, but the top-level SetRotation call does not. The
non-Pawn source then passes the recovered CheckEncroachment gate
(`0x10399bb5–0x10399c8e`) before its pose/hash commit and zone/touch tail.
Existing map actor fields, collision services, rider body and
CheckEncroachment translation supply these operations. Calling `moveMapRider`
as the top-level entry would incorrectly force ignoreBases=1.

The focused original-DLL reference retains the actual crate/rider transforms
and collision cylinders. The top-level call succeeds, changes crate1 yaw by
-30 without translation, and recursively moves crate2 by
`[-0.010661959648132324, -0.001476287841796875, 0]`, also subtracting 30 from
its yaw. Recursive flags are `[0,0,1,0]`. Hash remove/add and zone update run
for crate2 before crate1; CheckEncroachment receives crate1's unchanged
Location, requested Rotation and notify=0, and returns false. The hit time is
1 with no hit actor. The first diagnostic capture had StandingCount=255 due
to the older decoration adapter's direct Base stores; the field-backed
falling/rolling adapter restores the fresh route's count to 1. Both enter the
native nonzero-count branch; the malformed count is not an original-world
reference. See [SetRotation](script-set-rotation.md).

`rotateMapActor` binds this zero-Delta entry to the same recovered MoveActor
body and services. The scene admits only non-brush zero-flag rotation calls;
`mapMoveLevel` further checks the full map collision surface. Canonical actor
identities and original script callbacks remain intact, while other scene
branches stay explicit. The native reference precedes this adapter; its
translation comparison and continuous-route integration are recorded
separately.

## Right click with nothing highlighted

The installed `RightMouse` binding is `ParseRightClick`. With `FrobTarget`
None it calls `PutInHand(None)`. That puts away the item in hand and drops or
throws a carried decoration (`DropDecoration`). The viewer's `use()` returned
"Nothing selected" instead, so a lifted plant could not be put down. It now
runs the original exec.

## Player start

The original reloads the map. The host restores the collision word in
`prepareActor` from the serialized fields, because the rebuilt hash
registers every serialized collider. It also returns FarMoveActor's
`motionFlags`/`oldLocation` to the serialized values. A picked-up
item returns to its serialized `Location` and `Base` inside the hash's
remove/re-add, as decorations already did. The player's `CarriedDecoration`
is cleared with the other in-hand fields.

Before this change, reset restored a picked-up item's fields but kept its
host `base` on the player. The next probe's player step then moved the stale
item as a rider. That caused the census's Candybar and HazMatSuit failures,
not a missing body. The census now reboots after any recorded error, even
one `game.use()` turned into a message.

## Evidence and checks

The admitted bodies are the existing oracle-validated translations
([move-query](move-query.md), [relocation](relocation.md),
[check-encroachment](check-encroachment.md)). This change only binds map
actors to them. The layout facts come from the retail-checked SDK records and
the earlier FarMoveActor recovery. Play checks:

- Lifting Plant2 runs `GrabDecoration` → `PutCarriedDecorationInHand`. The
  plant ends at `Base = JCDentonMale`, `Physics = PHYS_None`, collision word
  0 and `Style = STY_Translucent`. Walking moves it by the player's exact f32
  delta (58.12 units in both).
- Right-clicking with nothing highlighted runs `DropDecoration`. The plant
  flies, lands on the floor, settles with its collision word back at 15, and
  comes to rest at `Base = LevelInfo0`.
- Player start returns it to its serialized state.
- The pickup, weapon, crowbar/crate, decoration, plant-push, NPC-weapon,
  inventory-spawn, DataLink and keypad validators still pass.

Not covered:

- A map actor that does not collide at load has no native word on its host.
  Its move entries keep the explicit boundary, and its collision fields keep
  the store.
- Bytecode that writes `Location` directly on a registered map actor moves
  the host without the hash's remove/re-add. That case is unmodeled.
