# Training weapon overlay and spawned mesh display

## Original contract established before the adapter

The local original Engine.u source `Weapon.RenderOverlays` (Engine Weapon.uc
143–207) is inherited by DeusExWeapon. It returns for bHideWeapon/null Owner,
for a PlayerPawn whose DesiredFOV differs from DefaultFOV, and on the client
Handedness=2 branch (which also writes bHideWeapon). It clears WalkBob only for
an absent player owner/viewport. The muzzle-flash branch is conditional; the
crowbar does not enter it. It then executes SetLocation(Owner.Location +
CalcDrawOffset()), copies Pawn.ViewRotation, replaces Roll with either
-2*Default.Rotation.Roll (Hand=0) or Default.Rotation.Roll*Hand, calls SetRotation,
and submits Canvas.DrawActor(self,false). No animation advances in this event.

DeusEx.u `DeusExWeapon.CalcDrawOffset` (local extracted source lines 2207–2234)
uses 0.9 / PawnOwner.Default.FOVAngle times PlayerViewOffset, rotated by
ViewRotation; adds EyeHeight on Z and BobDamping*WalkBob, with bob Z using
(0.45 + 0.55*BobDamping)*WalkBob.Z. ScriptedPawn uses its own FOVAngle and
BaseEyeHeight and has no bob term. These are existing original bytecode calls,
not a separate viewer implementation of the formulas.

Engine.dll UCanvas::execDrawActor thunk 0x10303d05 reaches 0x10377ed0. It
initializes the optional ClearZ word to zero (0x10377f3c), clears depth only
when nonzero (0x10377f85–0x10377f9e), and calls URender::DrawActor at
0x10377fae. Render.dll 0x10b262c0 creates an FDynamicSprite and dispatches
DrawActorSprite using the existing frame. The overlay therefore uses the world
camera/projection. A special overlay camera would contradict this path. The
browser Canvas is an explicit drawing boundary; native UCanvas construction and
unrelated Canvas natives are not claimed.

## Render entry: ClearZ and the viewing actor's event

An earlier version of this page said the crowbar keeps the world's depth. The
DrawActor argument alone did not establish that. The entry point is
`URender::DrawWorld` in Render.dll (0x10b1ce49–0x10b1cec8), after the world is
drawn. It reads the viewport Actor (`Viewport+0x30`). Target is None when
`bBehindView` (+0x318 bit 0) is set, else `ViewTarget` (+0x60c) or the Actor
itself. When `GIsEditor` is clear, Target is set and the Actor's `ShowFlags`
(+0x5fc) has `SHOW_Actors` (8), it does four things in order. It sets
`GUglyHackFlags |= 1` and calls `Viewport->RenDev` (+0x64) vtable +0x90 with
the frame. It calls `FindFunctionChecked(ENGINE_RenderOverlays)` and
`ProcessEvent` with `Viewport->Canvas` (+0x5c). Finally it clears the hack
bit. Vtable +0x90 is `ClearZ(FSceneNode*)` in the primary vtables of both
UD3DRenderDevice and USoftwareRenderDevice (their exported symbols). So depth
is cleared once before every player overlay, and overlays draw over world
geometry. `ENGINE_RenderOverlays` is the Engine.dll FName global 0x10583600;
Render.dll imports it (slot 0x10b5d704) and this is its only use. The field
offsets come from the shipped PlayerPawn declaration order: `Player` +0x5d4 …
`ShowFlags` +0x5fc, `RendMap` +0x600, `ViewTarget` +0x60c.

`ULevel::SpawnPlayActor` stores `ShowFlags = 0x480c` at 0x1039719d
(`SHOW_Backdrop|SHOW_Actors|SHOW_PlayerCtrl|SHOW_RealTime`). The store follows
`SetPlayer`, `Role = ROLE_Authority` and `RemoteRole`. Play applies it where
reset binds `Player`. The following `RendMap` store (+0x600, from `ebx`) is
not modeled. No original script reads `ShowFlags`.

The event is `DeusExPlayer.RenderOverlays`. It calls `Super.RenderOverlays`,
which is PlayerPawnExt → PlayerPawn: `Weapon.RenderOverlays`, then
`myHUD.RenderOverlays` (no HUD class overrides the empty Actor event; myHUD is
None in Training). Unless the player is in state Interpolating or Paralyzed,
it then calls `inHand.RenderOverlays` for a non-Weapon inHand. For the
NanoKeyRing and other pickups, that is `Inventory.RenderOverlays`: owner/net
gates, `SetLocation(Owner.Location + CalcDrawOffset())`,
`SetRotation(Pawn(Owner).ViewRotation)` and `Canvas.DrawActor(self,false)`.
The item draws its `PlayerViewMesh`, which `BecomeItem` assigns. Carried
runtime-spawned items, such as the KeyRing spawned at startup, relocate
through the recovered spawned-actor FarMoveActor path.
`GUglyHackFlags` bit 1 and its mesh-renderer effects are not modeled.

The display uses the native-compared LodMesh GetFrame/material accessors already
used by the actor mesh scene. DrawActor is allowed to draw carried bHidden
actors; ordinary world scene visibility must still exclude those actors.

## Spawned props and damage feedback

The world mesh layer must reconcile the live Level.Actors list, not only its
load-time contents. Spawned actors are admitted after their original spawn and
mesh preparation; deleted actors stop rendering, and removed identities are
disposed. Reset is the same reconciliation, with restored map identities and
removed runtime identities. Pose time is exclusively the shared scheduler.

DeusExDecoration.ResetScaleGlow writes HitPoints/Default.HitPoints*0.9+0.1;
DeusExFragment.Tick writes LifeSpan/2 below two seconds. The linked
Actor.ScaleGlow property offset is 0x18c. Render.dll DrawLodMesh
0x10b0f85d–0x10b0f8b7 multiplies the three light-color components by this
property (with float stores), then caps each at 1. Engine Actor.uc declares
ScaleGlow as "Multiplies lighting" (line 261),
and its ERenderStyle declaration records the exact Normal/Masked/Translucent/
Modulated values 1/2/3/4. The display applies this documented lighting multiplier
through the recovered per-vertex mesh-lighting path, and uses its recovered
blend functions for the live Style value. Distance LOD, fog and volumetric
mesh lights remain explicit renderer boundaries; see
[mesh lighting](mesh-lighting.md).

## Integration and scope

`createWeaponViewModel(runtime,assets,player)` prepares a typed Canvas drawing
boundary. Call `render(renderer,camera)` after the world draw and before HUD in
Play, and `dispose()` when replacing the map. `render` applies the DrawWorld
gates, clears depth, dispatches the viewing actor's RenderOverlays event and
draws each submitted DrawActor. `ready()` awaits the Weapon and inHand draw
resources for focused checks; ordinary frames stage them on demand. The native-467 hook exists only during synchronous RenderOverlays
and is restored even on an error. SetLocation still goes through the runtime's
FarMoveActor binding. The script event writes the actual held actor transform,
as the original does; the next pawn tick places Weapon at its owner's Location.

The Weapon and non-Weapon inHand routes are wired through the player's event.
Muzzle flash Canvas.DrawIcon, GUglyHackFlags, original mesh lighting, distance LOD, native Canvas
construction, and all other Canvas effects remain unsupported. An unbuilt
Canvas effect raises its existing native boundary rather than substituting art.
The crowbar's live mesh pose is sampled without calling Fire, advancing time or
running a separate animation. A pending GPU resource can delay its first draw.

Focused validation uses the original Training package and real runtime actors:
`validate-weapon-view-model.mjs` checks the bytecode placement, unchanged animation
during drawing, live scheduler-driven Select pose, original visibility gates,
the shared camera, one ClearZ per overlay pass, the bBehindView/SHOW_Actors
gates, the key ring's Inventory.RenderOverlays placement, and reset. `validate-actor-mesh-scene.mjs` adds a display
fixture for runtime identity reconciliation, deleted visibility, ScaleGlow and
translucent Style. These integration checks reuse GetFrame/material evidence;
they do not establish whole-renderer visual equivalence.

The full `validate-crowbar-crate.mjs` ticked input case also binds this draw
layer: it verifies the surviving crate's damage glow, disposal of the destroyed
crate mesh, six actual spawned WoodFragment meshes with the inherited crate
skin, the dropped Lockpick mesh, live fragment translucent fade, and restored
crate/removed spawned meshes on reset. No synthetic Spawn or direct fire call
is used in that integration case.
