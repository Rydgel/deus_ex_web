# Training nano key

The first locked door on the Training course is the trainer door. It does not
open because the player is nearby, and Play does not clear `bLocked` itself.
The installed bodies below are the only unlock path this slice runs.

## Where the key is

`00_Training` `NanoKey0` (`DeusEx.NanoKey`) sits at
`(415.199, 1072.180, -144.800)` with `KeyID=Train` and
`Description="Trainer Door"`. It is a small inventory cylinder
(`CollisionRadius=2.05`, `CollisionHeight=3.11`, `bCollideActors=true`).

`DeusExMover47` / `DeusExMover48` (`Tag=keydoor`) are the door it fits:
`KeyIDNeeded=Train`, `bLocked=true`, `bFrobbable=true`, `lockStrength=0.25`,
`InitialState=TriggerToggle`, locations `(352, 576, -64)` and
`(416, 576, -64)`. Nothing else in this map uses `KeyIDNeeded=Train`.

The spawn door `UN_maindoor` (`DeusExMover16` / `17`) is unlocked and
frobbable. It is not this key.

## Original call order

Standalone `DeusExPlayer.InitializeSubSystems` calls `CreateKeyRing`
(`.cache/reference/DeusExPlayer.uc` 1257–1265):

```text
KeyRing = Spawn(class'NanoKeyRing', Self)
KeyRing.InitialState = 'Idle2'
KeyRing.GiveTo(Self)
KeyRing.SetBase(Self)
```

`NanoKeyRing` is a script-only `SkilledTool → DeusExPickup → Pickup → Inventory`
class (`classFlags=0x32`). Its constructor is the inherited `Engine.Inventory`
constructor already used for other script-only inventory. Class defaults keep
`bCollideWorld` and `bCollideWhenPlacing` clear, so Spawn does not enter
`FindSpot`. `GiveTo` is `Inventory.GiveTo`: `BecomeItem`, `AddInventory`,
`GotoState('Idle2')`. `DeusExPlayer.AddInventory` calls `Pawn.AddInventory`
and, when `rootWindow` is None, skips the object-belt UI.

Right mouse is `ParseRightClick` (`DefUser.ini`). On a `NanoKey` frob target
the body does not call `Frob` (`.cache/reference/DeusExPlayer.uc` 4459–4468):

```text
PickupNanoKey(NanoKey(FrobTarget))
FrobTarget.Destroy()
FrobTarget = None
return
```

`PickupNanoKey` calls `KeyRing.GiveKey(KeyID, Description)`. In standalone the
`GiveClientKey` branch is skipped (`NetMode == NM_Standalone`). `GiveKey`
(export `NanoKeyRing.GiveKey`) returns when `GetPlayer()` is None or
`HasKey(newKeyID)` is already true. Otherwise:

```text
aKey = GetPlayer().CreateNanoKeyInfo()
aKey.KeyID = newKeyID
aKey.Description = newDescription
aKey.NextKey = GetPlayer().KeyList
GetPlayer().KeyList = aKey
```

`CreateNanoKeyInfo` is `new(Self) class'NanoKeyInfo'` (opcode `0x11`: outer,
optional name, optional flags, class). The installed operands are Self,
`EX_Nothing`, `EX_Nothing`, `class'NanoKeyInfo'`. Omitted optionals stay
`NAME_None` and flags `0`. `NanoKeyInfo` is a script-only `Object` subclass
(`KeyID`, `Description`, `NextKey`). The fresh object goes through the
existing `StaticConstructObject` host with the `UObject` vtable store
`0x10179dfc` (the first store in the actor constructor path). This opcode is
admitted only for that class.

`HasKey` walks `GetPlayer().KeyList` and compares `KeyID` with the original
name-equality operator (native 254).

Using the key is not a second right-click. `ParseRightClick` frobs a door
with `frobWith=None`, and a locked door with an empty hand only reports
`msgLocked`. Left mouse is `ParseLeftClick`. When `inHand` is the
`NanoKeyRing` (`bActivatable=false`) and the target is a `DeusExMover`, it
calls `DoFrob(Self, inHand)`. `DeusExMover.Frob` then requires
`KeyIDNeeded != ''`, `frobWith` is a `NanoKeyRing`, and `lockStrength > 0`.
`PlayUseAnim` (`GotoState('UseIt')` unless already there) runs, then
`HasKey`. A match toggles `bLocked` on that mover and every other
`DeusExMover` with the same tag, and sets `bOpenIt=false`. The door stays
shut. A later frob with `frobWith=None` while `!bLocked` takes the open
branch and `Trigger`s the `TriggerToggle` state.

`PutInHand` only stores `inHandPending`. `UpdateInHand`, which
`MultiplayerTick` calls for `ROLE_Authority`, copies it to `inHand` and
calls `SkilledTool.BringUp` (`GotoState('Idle')` unless already idle). The
object belt that normally calls `PutInHand` is still a HUD boundary.
The `1` key calls those two original functions for the ring. Browser `F` /
right-click stays `ParseRightClick` (`frobWith` none), so it picks the key
up and later opens an unlocked door. `Enter` is the installed
`ParseLeftClick` binding and, with the ring in hand, frobs the door with
that ring.

`ClientMessage` on the pickup and on the unlock string stays the recorded
root-window boundary. The key list and `bLocked` writes are not that message.

## What this does not do

`paddoor` and `hackdoor` stay locked, not frobbable, and are opened by
`Keypad1` actors, not by this key. The belt window, lockpicks, and
`GiveClientKey` are not this path. Stage 3 is not complete.
