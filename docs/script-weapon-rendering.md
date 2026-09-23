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
DrawActorSprite using the existing frame. Thus the crowbar uses the world
camera/projection and existing depth; a special overlay camera or unconditional
clearDepth would contradict this selected path. The browser Canvas is an
explicit drawing boundary; native UCanvas construction and unrelated Canvas
natives are not claimed.

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
to its existing texture-only inspection shading, and uses its existing recovered
blend functions for the live Style value. This is a partial presentation of
the original damage/fade fields, not a claim of recovered native mesh lighting.
Original mesh lighting and distance LOD remain the existing explicitly
unsupported renderer branches. Texture-only inspection shading is not an
original-game lighting claim.

## Integration and scope

`createWeaponViewModel(runtime,assets,player)` prepares a typed Canvas drawing
boundary. Call `render(renderer,camera)` after the world draw and before HUD in
Play, and `dispose()` when replacing the map. `ready()` awaits the selected
weapon's decoded draw resources for focused checks; ordinary frames stage them
on demand. The native-467 hook exists only during synchronous RenderOverlays
and is restored even on an error. SetLocation still goes through the runtime's
FarMoveActor binding. The script event writes the actual held actor transform,
as the original does; the next pawn tick places Weapon at its owner's Location.

Only the player's Weapon route is wired here. Nonweapon inHand overlays, muzzle
flash Canvas.DrawIcon, original mesh lighting, distance LOD, native Canvas
construction, and all other Canvas effects remain unsupported. An unbuilt
Canvas effect raises its existing native boundary rather than substituting art.
The crowbar's live mesh pose is sampled without calling Fire, advancing time or
running a separate animation. A pending GPU resource can delay its first draw.

Focused validation uses the original Training package and real runtime actors:
`validate-weapon-view-model.mjs` checks the bytecode placement, unchanged animation
during drawing, live scheduler-driven Select pose, original visibility gates,
retained camera/depth, and reset. `validate-actor-mesh-scene.mjs` adds a display
fixture for runtime identity reconciliation, deleted visibility, ScaleGlow and
translucent Style. These integration checks reuse GetFrame/material evidence;
they do not establish whole-renderer visual equivalence.
