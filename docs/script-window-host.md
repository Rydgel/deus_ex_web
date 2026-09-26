# Original HUD window host

The host translates the installed `Extension.dll` (SHA-256
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`)
and executes the installed `DeusEx.u` / `Extension.u` functions. Local extracted
TextBuffers and disassembly remain outside Git.

The host now supplies the Play HUD tree. Unsupported native families, focus,
window timers and destruction stop at explicit boundaries. InfoLink/ConPlay
retain their documented compatibility owners within the same root/heap; see
[Play HUD scope](script-play-hud.md). Integration validation is distinct from
original-DLL comparison, and neither establishes complete renderer equivalence.

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
Deleting destructors and `FArray::Realloc` return their blocks to the heap: a
freed range is zeroed and reused first-fit, and a freed object's address stops
resolving. A released UObject's opaque handle is forgotten, so the heap does
not keep a collected actor alive ([Player start collection](script-loadmap-gc.md)).

## Continuation evidence

Text Draw (10046930) aligns/wraps, dispatches the script DrawWindow, then emits
the native text. Button Draw (100082c0) applies its current style, emits its
pattern, then executes Text Draw. RadioBox ToggleChanged (10038a60) maintains
the selected toggle and untoggles the previous entry before script dispatch.
TextLog AddLog/UpdateText/ConfigurationChanged/Tick/Draw are 100476a0,10047dc0,
10047910,10047c30,10047a10. The original separator at10098e58 is a single LF;
rows hold float timeout, FString and color. Paused logs preserve all timeouts.

Window.ConvertScriptString 10050710 scans UTF-16 pairs: `|n` becomes LF, other
pipe pairs remain literal (including `||n`). EnableTranslucentText1004dc90
writes bit1 of Window+74 and forwards it to the existing general GC.
GetGC1004ddc0 pushes the working GC and copies the window general GC;
ReleaseGC1004de50 pops it. GC cleanup100269b0→10026a20 unlocks and clears each
of the five native texture-cache records before resetting head/count.

GetTickOffset1004fda0 calls1003a3b0 with update=0: current monotonic time minus
the prior tick timestamp, stored to float. The browser supplies that monotonic
clock with performance.now; it does not substitute game TimeSeconds.
Full-viewport rendering makes GetRawBackgroundClipList1003c5f0 subtract the
null render clip at1003c6b3, so DrawRawBackground emits no tiles for that branch.

The VM IntToString token53 follows Core10131600's signed DWORD and `%i`
format string at101aaf70. FloatToString (token 0x55, Core `execFloatToString`
`0x10131ca0`) is `FString::Printf(L"%f", (double)F)` with the format constant
at `0x101aaf78`. `scriptFloatToString` prints the float's exact decimal
expansion to six places, rounding half away from zero. It does this only when
a 17-significant-digit intermediate would print the same text. NaN/Inf, -0,
more than 17 integer digits and those double-rounding cases are explicit,
because MSVCRT's spelling there is not measured. Aiming at a hackable device
reaches it: `FrobDisplayWindow.DrawWindow` → `FormatString` of the hack
strength.

The InfoLink/ConPlay presentation subtree that `delegateLegacySubtree`
registers belongs to its legacy shell. Tick, draw, reconfigure and WindowReady
already skip it. The visibility, sensitivity and init-count walks
(`RecomputeInitTree`, `InvokeVisibilityChange`, `InvokeSensitivityChange`) now
skip it too. Before, `DeusExRootWindow.ShowHud(False)` during a DataLink
reached a shell window with no host family. It also counted shell windows that
never receive WindowReady, which broke every later `InitializeWindows`. The
original sends those windows VisibilityChanged. Delivering it inside the
delegated shell is part of that shell's remaining work. The host's runaway guard was raised from2048 to16384
statements because original HUDMultiSkills.RefreshKey legitimately scans all
255 input keys; this limit is a host safeguard, not an original engine value.

The native family layout, root tick, actor reference and scene-frame modules
record their original addresses and comparison suites separately. The GC
dispatcher only marshals script references, bool DWORDs, colors, texture/font
pointers and raw float words into the already recovered GC bodies.
