# World item pickup (Training)

Frobbing a world weapon, ammo, tool, food or key in Play takes it into JC's
inventory through the original frob give path. Before this, frobbing an item did
nothing: map-placed inventory items never entered their auto Pickup state, so the
item's `Frob` resolved to the empty base `Engine.Actor.Frob`.

## Evidence

`Engine.Inventory` (and every subclass — `Weapon`, `Ammo`, `Pickup`,
`DeusExPickup`, `DeusExWeapon`) declares an `auto state Pickup` (STATE_Auto,
`stateFlags & 2`). `AActor::SetInitialState` enters that auto state when
`InitialState` is None. The runtime's LoadMap startup runs SetInitialState, but
`startupAdmitted` covered only pawns and patrol points, so a world item stayed
stateless and `runtime.lookup(item,'Frob')` returned `engine.actor.frob`.

The give itself is entirely original bytecode:

- `DeusExPlayer.ParseRightClick` → `HandleItemPickup(FrobTarget)`:
  `GetWeaponOrAmmo`/`FindInventoryType` decide combine-vs-new, `FindInventorySlot`
  assigns the inventory-grid slot (`invPosX/invPosY`), then it calls
  `DoFrob(Self, inHand)`.
- `DeusExPlayer.DoFrob` runs `foreach FrobTarget.BasedActors(...)` (a
  context-wrapped native iterator, native 306), calls the item's Pickup-state
  `Frob`, and `FrobTarget.SetBase(Frobber)`.
- `Inventory.Pickup.Frob` asks `Level.Game.PickupQuery`, plays the pickup sound,
  and gives the item — `Weapon.GiveTo` also spawns the weapon's default ammo and
  calls `Weapon.SetSwitchPriority` (which reads `Class.Name`).

## What the port adds

- **Startup admission.** World Inventory-ancestry pickups (no Owner, not hidden,
  positioned) join the LoadMap startup set so SetInitialState puts them in their
  Pickup state. The spawned nanokey ring is Owner-carried and excluded.
- **Give-path preparation.** The `Level.Game` GameInfo (PickupQuery) and, for
  weapons, the default ammo class link at load, next to the existing
  Decoration/Inventory class-chain preparation. The give path is otherwise
  already prepared bytecode.
- **Two enabling runtime fixes.** The VM now unwraps a context-wrapped `foreach`
  iterator (`FrobTarget.BasedActors`), and `fieldReference` serves the immutable
  `Name` on an unattached class object (`SetSwitchPriority`'s `Class.Name`).
- **Pickup sound boundary.** `Inventory.Pickup.Frob`'s `PlaySound` records a
  deferred audio boundary (channel id 0), like the decoration/pawn sounds.
- **Public path.** `game.use()` routes an inventory frob through
  `ParseRightClick` (the same path the nanokey ring uses), so the grid slot is
  assigned; the item's world mesh then hides through the actor mesh scene's own
  `bHidden` path.
- **Reset lifecycle.** The retired player's `Pawn.Destroyed` destroys the
  items JC carried. The reload then restores the serialized pickups in place,
  un-owned (via `store.clear`), so **Player start** returns the items and
  leaves only the new player's key ring. The ammo a weapon pickup spawns is a
  play-time spawn; LoadMap's collection releases it with the rest of the old
  level ([Player start collection](script-loadmap-gc.md)).

## Carrying a picked-up item while walking

`DoFrob` ends with `FrobTarget.SetBase(Frobber)`, so every item JC picks up
becomes a **based rider** on the player (its `Base` is the player, and the
player's `StandingCount` rises). The recovered `ULevel::MoveActor` runs the
based-rider section (`0x103998a0`–`0x10399bb0`) whenever a mover with a nonzero
`StandingCount` moves, recursing into `MoveActor` for each based child. Before
this the recursive call reached `moveSpawnedActor`, which admits only
runtime-spawned collision views (the NPC-carried weapons, the spawned key ring),
and a serialized (map) pickup raised `MoveActor for a non-spawned rider is not
linked` — so the first step JC took after picking anything up paused Play.

A held item is `bCollideActors = bCollideWorld = false`, `Physics =
PHYS_None`, `StandingCount 0` after `GiveTo`'s `BecomeItem`. The recursive
`MoveActor` (documented in
[npc-weapon-startup](script-npc-weapon-startup.md#ulevelmoveactor-based-rider-section-0x103998a00x10399bb0))
now runs on the map actor itself (`ScriptRuntime.moveMapRider`,
[map-actor move](script-map-actor-move.md)). For that null cylinder it skips
the `MultiLineCheck` query and the hash. The non-pawn `CheckEncroachment`
tail (`0x10399bf5`) early-returns false (`+0x1dc & 0x0d == 0`, null Brush).
The move commits `Location += FinalDelta` / `Rotation = NewRotation`, then
runs `SetActorZone(item, 0, 0)`. The carried item tracks the player's
`Location` step for step (the same f32 `Location + delta` arithmetic), which
is what the validator checks. The earlier `moveHeldRider` shortcut is gone;
unlike it, a near-zero delta now changes only the rotation, as in the
recovered body.

`scripts/validate-item-pickup.mjs` covers the startup Pickup state, the grid
give (a weapon takes a real slot; ammo/tool/food enter the list), the NanoKey key
ring, the mesh hide, walking with a carried item (the held-rider move), and the
reset lifecycle. Verified for
`WeaponCrowbar1`, `WeaponCombatKnife0`, `Ammo10mm2`, `Candybar0`, `HazMatSuit2`,
`Multitool0` and `NanoKey0`.

## Selecting a picked-up weapon into hand

Selecting a picked-up weapon draws it in hand through the original
`PutInHand` -> `UpdateInHand` -> `SwitchWeapon` -> `ChangedWeapon` ->
`Weapon.RaiseUp` -> `BringUp` -> `PlaySelect` path, now that the weapon's
first-person mesh is decoded and the weapon-select sound is a recorded audio
boundary. Number keys select by the weapon's `InventoryGroup` through the
engine's `Inventory.WeaponChange` walk (no object belt is modeled). See
[weapon equip](script-weapon-equip.md). Weapon fire / damage and the crate's
`TakeDamage` -> destruction remain the next increment.
