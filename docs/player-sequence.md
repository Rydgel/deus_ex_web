# Composed original dry player physics reference

`scripts/native-player-sequence-oracle.py` composes the existing hash-gated
original DLL level and controlled-player MoveActor harnesses. It does not supply
collision results or translated positions: native physWalking103ca540,
calcVelocity103cd7a0, stepUp103ce4a0, physFalling103d0a50,
processLanded103cef60, setPhysics103c95f0, MoveActor103990e0,
SingleLineCheck/MultiLineCheck, original actor hash and brush/cylinder/BSP
queries execute in the same Unicorn instance throughout each sequence.

The native world uses serialized Training/Liberty nodes, leaf hulls, actor
geometry and collision flags from the existing native-level scene corpus.
The additional surface table carries each original texture's Outer name and
Friction, resolved from serialized properties and original inherited defaults.
Consequently the original walking scanner executes its actual world queries.
The Ladder branch103cc519 fails explicitly. Original SetActorZone and PointRegion
execute after ordinary moves; non-LevelInfo center/foot/head membership rejects
the sequence. An ordinary-room leaf or zone-number change is allowed.

JC GroundSpeed, AccelRate, MaxStepHeight, AirControl and BaseEyeHeight and map
LevelInfo gravity/friction/terminal speed come from original defaults.
MinHitWall=-.6 is Pawn.PreBeginPlay source line968, rather than a class default.
Each fixture explicitly supplies initial position, velocity, acceleration,
physics, collision dimensions and timestep. The harness initializes OldLocation before each physics call; native walking/
falling then perform their own authoritative stores. This initialization is not
a claim that performPhysics universally copies OldLocation (see camera.md).
The inserted controlled player is last in the original hash registration order;
this does not recreate GameInfo.Login's full actor-spawn chronology.

Script dispatch is recorded and returns without running the VM. WalkTexture is
source-backed empty for JC; Landed damage/audio, Bump/Touch mission effects and
other events remain explicit boundaries. BeginTouch/EndTouch follow the existing
player-move oracle's controlled bookkeeping boundary. IsProbing returns false,
so this does not prove script observer/probe registration. Physics and geometry
continue independently of those script effects. No audio, AI, inventory, input
polling or camera lifecycle is claimed.

The `upward-launch` fixture starts PHYS_Falling with an upward velocity; it is
not proof of the original jump input/script transition. `crouch-dimensions`
starts with the requested radius/height; it does not execute SetBasedPawnSize.
The stair position is a route-derived candidate whose support is determined by
native geometry, not a previously recorded original gameplay pose.

Run `node scripts/validate-native-player-sequence.mjs` after native-level scene
captures exist. Original references and their complete scene/case inputs are
ignored under `reports/movement/player-sequence/<map>/`. SHA-256 identifies each
input. Frame snapshots and cumulative trace/query/event boundaries allow the
integration layer to compare the whole trajectory. The validator instantiates createGame and calls runPlayerPhysics directly with
the same fixture dimensions, base=LevelInfo, rotation0 and physics inputs. It
compares every frame's position/velocity/physics and ordered SingleLineCheck
inputs, times, actor identities and valid hit normals. Missed-hit normals are
excluded: original scratch fields can retain a previous query's normal. It
reports the first divergent frame/query. This does not establish Player.tick
input/camera/script parity.

## Verified comparison and remaining limit

Nine successful native sequences contain 51 frames: Training and Liberty walk,
crouch dimensions, drop, upward launch, plus Training walk-wall. All 51 frame
positions, velocities and physics states initially matched the composed JS scene
exactly. The stronger query comparison exposed missing surface-prelude queries
in JS falling: original103d0a7d–aa9 casts the actor to Pawn,103d0aba calls
103cc450 with pawn/deltaSeconds/iterations, and103d0ac2–c4 exits when handled.
This runs before zone/acceleration handling. Ordinary Friction1 paths retain
the same trajectory despite the missing queries; Ladder detection cannot be
claimed without this caller. The runtime caller was corrected from this evidence. Rerunning the composed
comparison matches all 51 frames and 2,079 ordered line queries exactly.

The route-derived Training stair candidate initially reached an unbound native
diagnostic output callback at Core10145433 on frame0. A separate original run
with a recorded Serialize sink revealed the message "fell out of the world!":
the first move enters ZoneNumber0 at [-16,832,-144.2]. This is an invalid stair
approach fixture, retained as unsupported. The diagnostic capture is
`reports/movement/player-sequence/stairs-original.json`; no stair support was
invented. Future captures reject that native out-of-world diagnostic explicitly. The wall sequence does execute original
stepUp and HitWall, but does not establish successful stair traversal.

## Recorded stair approach

The later recorded route fixture replaces the invalid tentative stair position:
position [181.2455291748047,825.8439331054688,-128.09999084472656],
velocity [-164.99082946777344,0,0], acceleration [-2400,0,0],
GroundSpeed207, radius20/height43, walking with LevelInfo base and rotation0.
Its provenance is the local route sample
`/tmp/deus-ex-gameplay-stair-sample.json`, maps[0].stairApproach; all numerical
inputs are retained in the ignored corpus, so reruns do not depend on that file.

`node scripts/validate-native-player-sequence.mjs --stairs-only` captures twelve
0.05-second original physics frames. Original stepUp executes five times and
successfully climbs three risers: center Z becomes -112.30000305175781,
-96.30000305175781, then -80.30000305175781. It ends at
[57.04546356201172,825.8439331054688,-80.30000305175781], still walking.
No door motion or collision outcome is supplied. The closed pair remains clear
of this bounded trajectory. All twelve frame positions, velocities and physics
states and 468 ordered line queries match the composed JS simulation exactly.
Use `--stairs-only --reuse` to compare against the saved original capture under
`reports/movement/player-sequence/00_Training-stairs/`.

Combined successful coverage is ten sequences, 63 frames and 2,547 ordered line
queries. This establishes the selected stair physics path, retaining the script,
input, camera and startup limits described above.
