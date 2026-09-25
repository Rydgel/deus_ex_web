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

Before this change, those script fields lived in a separate store. A script
write such as `CarriedDecoration.bCollideWorld = False` therefore left the
native word unchanged, and the carried decoration would still have been
blocked by walls. `script-doors.mjs` now binds the five collision bools onto
`flags` for every collidable non-player map export. It binds `bJustTeleported`
and `OldLocation` for non-pawn map actors.
`map-actor-native.mjs` `writeCollisionFlags` also refreshes the host's per-bit
copies (`collisionBits`, `collideActors`, `collideWorld`, `blockActors`,
`blockPlayers`, `blocking`), so no reader sees a stale bit.

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

  The controlled player keeps its movement port.
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

## Right click with nothing highlighted

The installed `RightMouse` binding is `ParseRightClick`. With `FrobTarget`
None it calls `PutInHand(None)`. That puts away the item in hand and drops or
throws a carried decoration (`DropDecoration`). The viewer's `use()` returned
"Nothing selected" instead, so a lifted plant could not be put down. It now
runs the original exec.

## Player start

The original reloads the map. The host restores the collision word in
`prepareActor` from the serialized fields, because the rebuilt hash
registers every serialized collider. It also drops FarMoveActor's
`motionFlags`/`oldLocation` so the serialized values return. A picked-up
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
