# Selecting a picked-up weapon into hand

Play uses the installed object belt and original `DeusExPlayer.ActivateBelt N`
bytecode. A pickup reaches the belt through `DeusExPlayer.AddInventory` →
`DeusExRootWindow.AddInventory` → `HUDObjectBelt.AddObjectToBelt`.
`CreateNanoKeySlot` reserves slot zero for the canonical key ring; the first
eligible pickup occupies slot one. The crowbar's inventory group remains 10,
but that group number is not its belt position.

## Original path

`DeusExRootWindow.ActivateObjectInBelt(pos)` reads the slot and calls
`player.PutInHand(item)`. It passes the item unchanged: selecting a populated
slot again retains it; selecting an empty slot passes None and requests that
the current item be put away. `PutInHand` validates the request and calls
`SetInHandPending`. It does not immediately change `inHand`.

Original `DeusExPlayer.PlayerWalking.PlayerTick` calls
`HighlightCenterObject`, then `MultiplayerTick`, then `Super.PlayerTick`.
Despite its name, `MultiplayerTick` also serves single player. After its
client-authority guard, it calls `UpdateInHand`. The viewer's existing player
tick route now dispatches that original function after publishing the frob
result and before movement. The remaining unrecovered PlayerTick effects are
separate boundaries.

When no item is held, `UpdateInHand` calls `SetInHand(inHandPending)`, sets
`SelectedItem`, and for a weapon calls `SwitchWeapon(InventoryGroup)`:

```text
UpdateInHand (DeusExPlayer)
  -> SwitchWeapon (PlayerPawnExt)
  -> Inventory.WeaponChange(group)
  -> PendingWeapon = newWeapon; ChangedWeapon()
  -> Weapon = PendingWeapon
  -> Weapon.RaiseUp -> DeusExWeapon.BringUp -> Weapon.BringUp
  -> PlaySelect -> PlayAnim('Select') -> GotoState('Active')
```

Original `Active` state code waits for the selection animation under the
latent scheduler, then enters idle. To put an idle weapon away,
`UpdateInHand` calls `PutDown`; `DownWeapon` runs `TweenDown`, `FinishAnim`,
and `Pawn(Owner).ChangedWeapon`. A later `UpdateInHand` sees `Weapon == None`
and completes the hand transition. All state code and animation progress run
through the real level scheduler, including owner deferral. No helper drives
weapon fire, state code or animation notifies outside that scheduler.

## Host integration

`game.activateBelt(position)` prepares the selected item's original Mesh
resource before dispatching `ActivateBelt`. `GiveTo`/`BecomeItem` already
selected its PlayerViewMesh; preparation allows the synchronous `PlayAnim`
leaf to read that resource. Digit keys and Crowbar preview use this actual
belt path. The original HUD displays belt selection and weapon ammunition;
there is no separate in-hand icon. First-person view-model submission and
weapon damage are documented with [weapon fire](script-weapon-fire.md).

The older `selectItem`, `selectWeaponGroup`, and `selectNanoKeyRing` methods
remain research/test helpers. `selectItem` chooses item or None using a host
toggle before invoking the original hand functions. That toggle is not the
original belt-key behavior and is not used by the Play digit bindings.

Weapon sound requests remain deferred at the original native PlaySound call
boundary until audio playback is connected. Original mesh lighting and whole
rasterizer identity remain separate rendering work.

## Reset lifecycle

Player start reloads the level and logs a new player in
([player login](script-player-login.md#reset-reload-and-a-second-login)).
The previous player, its hand/weapon state, belt and HUD are retired with the
old level. Picked-up map items return to the world with their serialized
state. The new player's Login builds a fresh root window, belt and key ring,
and the ring's `GiveTo`/`AddInventory` route fills slot zero.

## Focused checks

`node scripts/validate-play-hud.mjs` checks actual pickup-to-belt placement,
`ActivateBelt`, shared in-hand/weapon/ammo identity, same-slot selection,
empty-slot put-away under the scheduler, native HUD drawing and reset.
`node scripts/validate-weapon-select.mjs` retains coverage of the older group
selection research helper and original mesh preparation.

The original authority is the installed DeusEx.u/Extension.u/Engine.u embedded
source and bytecode: `DeusExRootWindow.ActivateObjectInBelt`,
`DeusExPlayer.PutInHand`, `SetInHandPending`, `UpdateInHand`,
`PlayerWalking.PlayerTick`, `MultiplayerTick`, `PlayerPawnExt.SwitchWeapon`,
and the Engine/DeusEx Weapon state functions. Extracted sources remain ignored.
