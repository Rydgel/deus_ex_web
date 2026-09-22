# Selecting a picked-up weapon into hand

After a world weapon is frobbed into JC's inventory
([item pickup](script-item-pickup.md)), selecting it draws it in hand through
the original object-belt equip path — no host-scripted weapon logic. This is
the increment past pickup toward "equip the crowbar and break a crate".

## Original path

`DeusExRootWindow.ActivateObjectInBelt(pos)` (the belt-slot key handler) reads
the slot's item and calls `player.PutInHand(item)`. `PutInHand`
(`DeusExPlayer.uc:4806`) validates and calls `SetInHandPending(item)` — it sets
`inHandPending`, **not** `inHand`. `UpdateInHand` (`:4917`, "called every
frame") runs the transition: with `inHand == None` it takes `bSwitch = True`,
calls `SetInHand(inHandPending)` and `SelectedItem = inHandPending`, and for a
`DeusExWeapon` calls `SwitchWeapon(inHand.InventoryGroup)`:

```text
UpdateInHand  (DeusExPlayer)
  -> SetInHand(inHandPending)                       inHand = weapon
  -> SwitchWeapon(weapon.InventoryGroup)            (PlayerPawnExt.uc:125)
       newWeapon = Inventory.WeaponChange(group)    (Weapon.uc:373 walk of the chain)
       Weapon == None -> PendingWeapon = newWeapon; ChangedWeapon()
  -> PlayerPawn.ChangedWeapon -> Pawn.ChangedWeapon (Pawn.uc:726)
       PlayWeaponSwitch; Weapon = PendingWeapon
       -> Weapon.RaiseUp(OldWeapon) -> DeusExWeapon.BringUp -> Weapon.BringUp (Weapon.uc:903)
            -> PlaySelect (Weapon.uc:948)
                 -> PlayAnim('Select', 1.0, 0.0)          native 259 on the weapon's Mesh
                 -> Owner.PlaySound(SelectSound, SLOT_Misc) native 264 (audio boundary)
            -> GotoState('Active')
```

The result is `inHand = SelectedItem = Weapon = the weapon`, `PendingWeapon =
None`, and the weapon in its `DeusExWeapon.Active` state.

## Two boundaries this crosses

1. **Player-view mesh preparation.** `PlaySelect` runs
   `PlayAnim('Select')` (native 259) on the weapon, which reads the weapon's
   `Mesh`. `GiveTo`'s `BecomeItem` already set `Mesh = PlayerViewMesh`
   (`deusexitems.crowbar` for the crowbar), but the pickup path only prepared
   the item's class chain, not that first-person LodMesh resource, so the
   synchronous `meshPayload` boundary raised `Original mesh resource is not
   prepared`. `game.selectItem` awaits `runtime.prepareMesh(item)` (decodes the
   `Mesh` LodMesh) before the synchronous `PutInHand`/`UpdateInHand` pair, so
   the animation runs over a decoded resource. The **rendering** of the
   first-person view model in the viewport is a separate surface and is not
   built here — only the pose/animation state is applied, exactly as the world
   and third-person meshes were before it.

2. **Weapon select/idle/fire sound (native 264).** `Owner.PlaySound(SelectSound
   …)` is one-shot effect audio whose return the script discards. It is recorded
   as a deferred audio boundary (channel id 0) in `script-doors.mjs`'s native
   264 handler — the same lifetime contract as the decoration / pawn / pickup
   sounds; audible playback is Stage 4. Weapon fire's PlaySound sites
   (`weapon.` / `deusexweapon.` paths) take the same branch.

No object belt is modeled: `bInObjectBelt`/`beltPos` stay unset. Number-key
selection resolves the weapon from JC's **real** inventory chain through the
engine's own `Inventory.WeaponChange(group)` walk (the same resolution
`ActivateObjectInBelt` reaches before `PutInHand`), never a fabricated slot
table. The crowbar is group 10 (`Digit0`).

## Host wiring

- `game.selectItem(item)` — prepares the item's `Mesh` LodMesh (if any) then
  runs the original `PutInHand`/`UpdateInHand` toggle. Re-selecting the in-hand
  item requests it be put away (`PutInHand(None)`).
- `game.selectWeaponGroup(group)` — `Inventory.WeaponChange(group)` on JC's
  chain, then `selectItem` the resolved weapon.
- `game.selectNanoKeyRing()` — the key ring's slot, unchanged, now sharing the
  same `PutInHand` toggle primitive.
- Number keys `1`–`0` map to weapon groups 1–10 (`main.mjs`); key `1` keeps the
  nanokey ring when group 1 holds no weapon. The `Crowbar preview` button
  places JC beside the Training weapon crate, picks up the crowbar, and equips
  it (the crowbar and crates sit past the locked keypad doors the training
  scripts open — the same curated placement the other preview buttons use).
- The HUD in-hand indicator (`hud.mjs`) lazily decodes a picked-up item's belt
  Icon on first selection, since the map-start preload holds only JC's starting
  inventory.

## What is NOT built past this

- **Putting a drawn weapon away** finishes over frames: `UpdateInHand` for an
  in-hand weapon in `Active` state does not immediately clear `inHand`; the
  weapon must tween `Active -> DownWeapon` and reach `Weapon == None` across
  later `UpdateInHand` ticks, which the host does not yet drive per frame. The
  toggle flips `inHandPending` (and requests the put-away) but the weapon stays
  drawn in a single call.
- **First-person view-model rendering** in the viewport (only the pose state is
  applied).
- **Weapon fire / damage** and the crate's `TakeDamage` -> destruction (see the
  traced path and boundaries below).

## Crate breaking: traced path and boundaries

The original chain from a crowbar swing to a broken crate was traced end to end;
several subsystems between "fire runs" and "the crate breaks" are unbuilt, so
this increment stops here and records them precisely rather than faking a break.

```text
(fire input, unwired) -> DeusExWeapon.Fire (bHandToHand)
  -> GotoState('NormalFire'); PlaySelectiveFiring (PlayAnim 'Attack'); PlayFiringSound
  -> [MESH NOTIFY on the Attack animation] -> HandToHandAttack -> TraceFire(0.0)
       GetAxes(ViewRotation); ComputeProjectileStart; AdjustAim
       -> Pawn.TraceShot(HitLocation,HitNormal,EndTrace,StartTrace)   Pawn.uc:1173
            -> Trace(...,True)  native 277, five args (Extent omitted)
       -> ProcessTraceHit(Other,...) -> Other.TakeDamage(HitDamage*mult, Pawn(Owner), HitLocation, 1000*X, damageType)
  -> DeusExDecoration Active.TakeDamage: HitPoints -= Damage; when <=0:
       DropThings; Frag(WoodFragment,...) -> Spawn(WoodFragment)xN -> Destroy()
       -> Containers.Destroyed (Spawn TrashPaper/Rat/contents) -> DeusExDecoration.Destroyed
```

Landed here: the native-277 `Trace` optional-argument fix, so `TraceShot`'s
five-argument call runs instead of raising the arg-count boundary
(`validate-trace-shot.mjs`).

Boundaries that still stand (each a real, separate slice):

1. **No fire input is wired in Play.** Only equip/selection is connected; there
   is no left-click -> `Fire`. This is deliberate — see boundary 2.
2. **The crowbar's hit is a mesh notify.** `HandToHandAttack` /
   `OwnerHandToHandAttack` are "called by the MESH NOTIFY for the H2H weapons"
   during the `Attack` animation. The animation-notify subsystem (decoding and
   dispatching a `LodMesh` sequence's notify frames) is not implemented, so a
   swing never triggers `TraceFire` on its own.
3. **The weapon fire state machine is latent and must run under the tick
   scheduler.** `Fire` -> `GotoState('NormalFire')` -> `Sleep(GetShotTime())` /
   `FinishAnim` are latent actions. Driving `Fire`/`TraceFire`/`HandToHandAttack`
   directly, outside the ticked latent scheduler, runs the state body without
   its suspension points and grows memory without bound (an *external*-memory
   runaway that a JS heap cap does not contain — it OOM-killed the process in
   testing). This path must only be exercised through the real per-frame latent
   scheduler; the safe `TraceShot`-into-the-floor check
   (`validate-trace-shot.mjs`) covers the native-277 fix without touching it.
   `Pawn.TraceShot` is itself recursive (re-traces from the hit on a Pawn); any
   future wiring must bound that (and, per the project's direction, heavy or
   recursive per-frame work belongs in the Rust/Wasm kernel, not deep JS
   recursion).
4. **Breakable decorations are not in their auto state `Active`.** LoadMap
   startup state admission covers pawns, patrol points and Inventory pickups,
   not decorations, so a crate's `Active.TakeDamage` (the whole destruction
   logic) is out of scope — its damage resolves to the empty base `Actor.TakeDamage`.
5. **HitDamage math:** one crowbar hit is 6, below the crate's 10 HitPoints, so
   at least two connecting swings are required.
6. **Destruction spawns are unadmitted:** `Frag` -> `Spawn(WoodFragment)`,
   `DropThings` -> `Spawn(contents)` and `Containers.Destroyed` ->
   `Spawn(TrashPaper/Rat)` need `SpawnActor` admission for those Fragment /
   Decoration / Pawn / content classes.

## Reset lifecycle

The original Player start reloads the level, giving a fresh player with an empty
hand. This host reuses the player identity, so `resetNpcs` clears the player's
`inHand`, `inHandPending`, `ClientInHandPending`, `SelectedItem`, `Weapon`,
`PendingWeapon` (to None) and `bInHandTransition` (to false) after returning the
picked-up items to the world — their map-start values.

## Focused check

    node scripts/validate-weapon-select.mjs

It picks up the crowbar, selects it via group 10 (`WeaponChange` -> PutInHand),
asserts `inHand`/`SelectedItem`/`Weapon` are the crowbar and its state reached
`DeusExWeapon.Active`, that the player-view LodMesh resource is now decoded,
that walking with the equipped weapon runs the held-rider move (the crowbar
tracks the player), that re-selection requests put-away, that no actor failure
was introduced, and that the nanokey ring still selects after reset.
