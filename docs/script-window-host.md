# Original HUD window host

The host translates the installed `Extension.dll` (SHA-256
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`)
and executes the installed `DeusEx.u` / `Extension.u` functions. Local extracted
TextBuffers and disassembly remain outside Git.

This is work in progress and is not yet the Play HUD. Unsupported native
families, layout branches, drawing and destruction stop at explicit boundaries.
The existing Play presentation bridge remains active until construction and
rendering are verified. A new module alone does not establish compatibility.

## Source contract

`DeusExRootWindow.InitWindow` creates ActorDisplayWindow, DeusExHUD and a hidden
DeusExScopeView; calls HUD.UpdateSettings; and gives all three full alignments.
`DeusExHUD.InitWindow` creates ammo, hit, cross, belt, active items, damage,
compass, multiplayer skills, information, log, frob, augmentation, mission text,
bark and received-item windows. Its own ConfigurationChanged negotiates and
places the children. `HUDObjectBelt.InitWindow` creates ten toggle slots in a
RadioBoxWindow/TileWindow, sets ORDER_LeftThenUp, assigns slot zero the KeyRing,
and restores inventory belt positions. AddInventory uses AddObjectToBelt;
ActivateBelt uses the same slots. The host must not synthesize a second belt.

## Native evidence

The window tree translation records original preferred-base addresses at each
body. Construction starts with `APlayerPawnExt::ConstructRootWindow` 0x10037e70,
then XRootWindow Init 0x10039050, ProcessScript InitWindow and SetVisibility.
The native family constructor and Init addresses are in
`script-window-families.mjs`; the reflected native field offsets are bound to a
single byte-addressed heap shared with GC and UFont translations.

Native leaves added during continuation:

* Window.SetDefaultCursor: body 0x1004fab0 stores texture, shadow texture,
  X/Y hotspot and packed color at +0xf0/+0xf4/+0xf8/+0xfc/+0x100. Exec 0x10052c20
  defaults the shadow to null and hotspots to -1; RGB defaults to 255. Its
  uninitialized alpha byte is recorded as a host assumption (zero), as it is
  neither a HUD color nor used by this path's renderer.
* RootWindow.SetDefaultEditCursor 0x10039390 stores +0x5a8;
  SetDefaultMovementCursors 0x100393a0 stores its five pointers at +0x5ac..+0x5bc.
* QueryPreferredSize/Width/Height/Granularity route to the recovered tree
  bodies. Out parameters remain references to their calling script locals.

Heap allocation addresses are host storage. They are not original pointer
values; pointer tie-breaking in otherwise equal focus ordering is therefore an
unverified boundary. Uninitialized native alpha bytes are zeroed explicitly.
