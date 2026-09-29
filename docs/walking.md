# Native dry player walking contract

Original GOTY APawn.physWalking103ca540–103cbdd3 is authority. Traced before
translation. Zero velocity/acceleration Z; calcVelocity once for whole dt;
Player desired motion adds ZoneVelocity*25*dt, zeroes Z. Save OldLocation,
clear bJustTeleported. Substep while remaining>0, iterations<8: if remaining>.05
use min(remaining*.5,.05f), otherwise remainder. Near-zero displacement
(all abs components<.0001) ends time and clears bHitSlopedWall.

MoveActor then stepUp with remaining displacement. Persistent bHitSlopedWall
(mask20 in Pawn318) probes ahead max(distance+4,30), flags6/full extent.
If normal.z in(.01,.7), horizontal normal projection alters delta. Otherwise
Player performs three zero-extent rays at foot+MaxStepHeight+4, forward100
and two diagonal directions, updating bHitSlopedWall only.

Floor: stationary foot ray from Position.z-Height down20 flags6/zero extent;
if actor==Base and time*20 in[4.1,4.6], skip floor adjustment. Else full extent
ray MaxStepHeight+2 in gravity Z sign with flags17. If hit actor differs from
Base or distance>2.4, move full floor delta and SetSupportBase. Otherwise if
distance<1.9, move up2.1-distance, preserve previous normal, force hit.time0.
Walkable floor normal.z>=.7; low friction normal.z*friction<3.3 additionally
slides by projected gravity (full dt twice, friction clamped>=.5). Floor absent
or too steep invokes Falling event then setPhysics2 if still walking, computes
remaining time from actual horizontal progress, reconstructs XY velocity from
OldLocation/(dt-remaining), preserves Z and invokes physFalling if remaining>.01.
End reconstructs velocity from total displacement/dt unless justTeleported,
then zeroes Z. X retains intermediate x87 subtraction/reciprocal precision.

Callbacks isolate original world movement, queries, support changes, script
wall/falling events and subsequent falling. Water/flying physics are outside this dry-player entry. CanJump/MayFall ledge
veto rolls back OldLocation with FarMoveActor and sets MoveTimer=-1.


## Integration API

`walking(pawn, seconds, iterations=0)` uses original Unreal axes and mutates
pawn fields, matching the existing falling/stepUp callback convention.
The timestep is float32 in (0,.4], with the caller's current shared physics
iteration count. Required numeric/vector state: position, velocity, acceleration,
groundSpeed, accelRate, friction (Zone.GroundFriction), zoneVelocity, gravity,
maxStepHeight, radius, height, mass. Required flags/references: physics,
isWalking (Pawn.bIsWalking), isPlayer, canJump, hitSlopedWall, base.
It writes oldLocation, justTeleported, hitSlopedWall, velocity, acceleration,
and moveTimer on rejected ledges. Support identity uses reference equality.

Callbacks, invoked with pawn as receiver:

| Callback | Contract |
|---|---|
| walkingPrelude(dt,iterations) | Original surface prelude; true means it handled movement and caller returns. Must be supplied explicitly. |
| move(delta) | MoveActor, updates pawn.position and returns {time,normal,actor}; may change physics/justTeleported. |
| lineCheck(start,end,extent,flags,extra=0) | Read-only SingleLineCheck, returns {time,normal,actor}. Preserve null actor on misses. |
| hitWall(hit) | processHitWall dispatch used by verified stepUp; may change physics and velocity. |
| setSupportBase(actor) | Original support-base change including updating pawn.base. |
| mayFall() | Original MayFall event; may change pawn.canJump. Empty inherited Pawn event is verified in embedded source. |
| fallingEvent() | Falling script dispatch; may change physics/velocity. |
| setPhysics(2) | Original setPhysics transition; updates pawn.physics and applies its separately implemented side effects. |
| falling(dt,iterations) | Continue remaining time in verified falling caller. |
| farMove(position,0,0) | Original rollback relocation; updates pawn.position. Its return is ignored here. |

PlayerPawn.Falling calls PlayInAir in original embedded source; its visual/script
work is external to this math caller. A callback that leaves PHYS_Swimming
hands off to startSwimming at the original checks ([swimming](swimming.md));
other transitions from callbacks are explicitly unsupported. Entry requires a valid dry PlayerPawn world region.
Native MoveActor/query/event internals are supplied callbacks, not proven by this
harness. MayFall probing/state-machine suppression is likewise the adapter's
responsibility; for ordinary PlayerPawn the inherited event is empty.

## Surface-prelude boundary

The original caller ALWAYS first invokes103cc450. It scans prospective wall
textures via103ccc40. A returned UTexture's Outer pointer+18 is checked for a name equal
(case-insensitive) to UTF16 `Ladder` at10481a74 (103cc4e7–103cc513). A matching
texture enables ladder behavior, which is outside Stage2 dry walking scope.
Otherwise103cc6cb–103cc78d trace downward by Height+2*Radius and retrieve a floor
texture. WalkTexture is dispatched (103cc81d) even for the ordinary branch.
If physics remains Walking, a texture exists, and its float at+70 is less than1,
103cc846–103cc9e0 additionally projects gravity along the surface. The +70 field is Texture.Friction: mapping is now established below. The
ordinary surface adapter performs the scanner/query explicitly and rejects
unsupported Ladder or Friction<1, so callers need no unconditional no-op.


## Original comparison

Run `node scripts/validate-native-walking.mjs` to generate 43 deterministic branch
cases, execute original Engine/Core with controlled prelude/world/event
callbacks, and compare state plus the complete ordered callback arguments.
The result is **43 cases, zero mismatches**, including float32 position,
velocity, acceleration, physics, persistent slope flag and ordered callback
arguments. Covers timestep splitting/iteration cap, braking/acceleration/walking,
zone velocity, stationary footray[4.1,4.6], floor1.9/2.4 boundaries, base changes,
stepping/slopes, low-friction slope gravity, ledge falling and remaining-time
continuation, MayFall veto rollback, step wall→falling, and justTeleported.
Raw inputs/results/comparison stay ignored under `.cache/walking`.
`node --test test/walking.test.mjs` passes native-derived state/event regressions.
The harness executes native calcVelocity and stepUp instructions; only its
explicit prelude, MoveActor, line query, support/physics dispatch, wall/script
events, FarMove and falling-continuation boundaries are controlled callbacks.
Engine/Core hashes are enforced by the shared native-collision loader.
Override `DEUS_EX_ROOT` and `NATIVE_PROBE_PYTHON` when reproducing elsewhere.
This proves the ordinary dry caller contract on these meaningful branches;
it does not verify all possible numerical inputs, surface-prelude behavior,
full movement collision/event dispatch, or visual/in-game fidelity.


## Surface dependency resolved

Original `Engine.u` class exports Bitmap and Texture, their embedded ScriptText,
and tagged Texture class defaults establish Friction=1. Texture.Friction is
FloatProperty export5100. Field order derives the native layout from UObject's
0x28-byte base: Bitmap.Format28, Palette2c, UBits30/VBits31, USize34/VSize38,
UClamp3c/VClamp40, MipZero44/MaxColor48, InternalTime[2]4c/50; Texture starts54:
BumpMap54, DetailTexture58, MacroTexture5c, Diffuse60, Specular64, Alpha68,
DrawScale6c, **Friction70**, MipMult74. These original native/script layouts match
the prelude's native float70 read. The source explicitly defines Friction1 as
no surface effect and .95 as some effect. No public engine implementation is
used as authority for this identification.

The name checked for Ladder is **the texture Outer object's name**, typically
its serialized package group. It is not a MaterialType property. Scanner
103ccc40 uses case-sensitive appStrcmp; the caller103cc450 uses appStricmp.
Starting from Position minus(0,0,Height*.95f), it scans four directions in order:
yaw, yaw-16384, yaw+16384, yaw+32768. Pitch is cleared; XAxis is independent of
roll. Each direction has distance 2*Radius and 9 rays with endpoint Z offsets
0,4,...,32; the ray START remains constant. Every query is zero extent, flags6.
A selected world texture with null Outer or exact `Ladder` ends scanning.
Only LevelInfo hits retrieve BSP Nodes[hit.item].iSurf → surface texture;
mesh/brush actor hits do not substitute their visual texture. The caller then
case-insensitively tests the final selected texture Outer for Ladder.
The supported adapter fails explicitly there. Original ladder branch dispatches
WalkTexture, derives movement from ViewRotation (pitch shifted by±6144), sets
bIsWalking, calls physFlying103cc64e, zeroes velocity when acceleration is zero,
and returns handled=true. That ladder movement remains outside Stage2 scope.

For ordinary surfaces the next ray goes from Position down Height+2*Radius,
zero extent flags6. It retrieves the world texture and dispatches WalkTexture
with hit location/normal. Original Pawn.WalkTexture is an empty event declaration
(embedded Pawn source1612); PlayerPawn and DeusExPlayer embedded sources contain
no override. An empty callback is therefore source-backed for this lineage.
Texture.Friction<1 enables the original extra-slide branch, which the adapter
rejects explicitly until implemented. This is separate from ZoneGroundFriction.

`walkingSurfaceTextures(assets,mapAsset,model)` asynchronously decodes original
class defaults and stored overrides into a table indexed by BSP surface:
`{key,outerName,friction}`. `walkingSurfacePrelude(pawn)` uses pawn.position,
rotation,radius,height,physics plus lineCheck; caller supplies
`textureForHit(hit)` (world LevelInfo/BSP item mapping only) and
`walkTexture(texture,location,normal)` (empty for original PlayerPawn lineage).
Assign it as walking's explicit prelude. It returns false after supported
ordinary handling and throws for selected Ladder or sliding texture.

`node scripts/audit-walking-surfaces.mjs` resolves actual referenced texture
packages and inherited defaults, retaining the local report in
`.cache/walking/texture-audit.json`. Training: 5,333 BSP surfaces,71 unique textures,
1,028 surfaces with normal.z>=.7. Liberty: 6,821 surfaces,107 textures,1,382 with
normal.z>=.7. **Every referenced texture has effective Friction1**, including
all candidate walkable floors; neither map uses a below1 override. Both maps
DO contain Ladder groups, so the spatial scanner remains necessary. This audit
covers static world surface texture references, not future changing surfaces.

`node scripts/validate-native-walking-surface.mjs` executes original103cc450
including its original scanner, name comparisons and floor retrieval with
controlled line-query/empty-event callbacks. 17 focused cases have zero
mismatches in every ordered ray and WalkTexture argument: misses, concrete
textures, yaw/pitch/roll/crouch height, each scan direction, final floor query,
and Ladder selection. Positive Ladder cases stop native execution at103cc519,
the unsupported movement branch; ladder motion is not claimed. Original
MSVCRT hash is enforced in addition to Engine/Core. The unit surface tests pass.
