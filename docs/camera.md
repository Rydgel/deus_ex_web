# Camera adapter evidence

Research contract recorded before implementation. Embedded original source:
`PlayerPawn.uc` PlayerWalking.PlayerMove lines3613–3728, CheckBob255–278,
UpdateEyeHeight2803–2848; `DeusExPlayer.uc` UpdateEyeHeight7312–7324.

PlayerMove calls GetAxes on incoming body Rotation before any input adjustment,
then computes acceleration and dodge state. Walking and non-Dodge animation
compute Speed2D = Sqrt(Velocity.X*Velocity.X + Velocity.Y*Velocity.Y).
With no menu, CheckBob receives DeltaTime, Speed2D and Y. Air/Dodge instead reset
BobTime and decay WalkBob by 1-FMin(1,8*DeltaTime), unless menu is shown.
UpdateRotation follows bob; ProcessMove/ReplicateMove follows rotation. Thus
incoming body rotation, velocity and GroundSpeed must feed bob. Backward/crouch
speed changes later in ProcessMove must not change this frame's CheckBob input.

Core execGetAxes export0x10102d06 jumps to0x10139e90. Original native dispatch
reads Rotation, gets each sine from GMath table0x101b32a4 with `(angle>>2)&16383`,
cosine with angle+16384. It composes inverse roll, pitch, yaw coordinate matrices,
with float32 stores at each composition, returning axes. Continuous trig in
radians is not equivalent. Original execSqrt0x101027c0 ->0x10136140 reads a
float argument, calls appSqrt0x10123290 (`fsqrt`), stores float32. Float multiply,
add, subtract and divide are native171,174,175,172 and store float results.

PlayerPawn.UpdateEyeHeight walking&&!bJustLanded uses
smooth=FMin(1,10*DeltaTime/TimeDilation), stair delta from OldLocation.Z, and
ShakeVert+BaseEyeHeight target. Air/landing uses FClamp(...,.35,1), omits stair
delta, and clears bJustLanded. Original commented-out eye bounds are inactive.
DeusExPlayer then adds JoltMagnitude*5 only for walking and nonzero Bob, and
clears any nonzero JoltMagnitude. FOV/zoom branches are outside this adapter.

Native reference capture will execute original GetAxes and float-expression
primitives. The surrounding script branches are source-derived; this does not
claim execution of the entire original PlayerMove/UpdateEyeHeight event or
measurement of whole-game render/physics callback scheduling.

## Result and integration contract

The capture-only run preceded the independent adapter. **555/555 native
comparison cases match exactly**, and six adapter regression tests pass.
`reports/movement/native-camera/{cases,original,comparison}.json` holds ignored
inputs, original results, binary hashes and comparisons. The oracle's only
binding stubs supply the three GetAxes out-parameter addresses; they supply no
numerical result. Float expression trees follow the embedded source and execute
original native dispatch, including native FMin/FClamp. Branch selection is
source-derived Python scaffolding, not an execution of the whole script event.

The corpus covers four-unit angle boundaries and wrapping, cardinal and arbitrary
pitch/yaw/roll, zero/forward/backward horizontal velocities with independent Z,
0–0.2 second deltas, walking/air/landing, upward/downward stair deltas,
standing-to-crouching target eye heights, TimeDilation0.5/1/2, ShakeVert and jolt.
One useful result is that an idle eye height38 at1/120s becomes
38.000003814697266 in the original expression; algebraically simplifying the
blend to a difference-times-factor would erase its native float-store behavior.

Exports in `src/runtime/camera.mjs`:

* `getAxes([pitch,yaw,roll])` requires integer Unreal rotator units. It returns
  `[X,Y,Z]` from the original quantized table and composition order.
* `walkingBobInputs(deltaTime, velocity, rotation)` returns the exact
  `{DeltaTime,Speed2D,Y}` locals for the existing original CheckBob VM.
* `updateWalkingBob(bobState, checkBob, options)` mutates that VM instance;
  options contain `deltaTime`, incoming `velocity`, integer `rotation`,
  `physics`, `animationGroup`, and `showMenu`. It preserves GroundSpeed.
  Name comparisons for Dodge are case-insensitive. Menu freezes all bob fields;
  air/Dodge reset `bobtime` and decay `WalkBob` without calling CheckBob.
* `updateEyeHeight(state, deltaTime)` returns
  `{eyeHeight,justLanded,joltMagnitude}`. Supply `physics`, `justLanded`,
  `eyeHeight`, `baseEyeHeight`, `locationZ`, `oldLocationZ`, `timeDilation`,
  `shakeVert`, `joltMagnitude`, and `bob`. Actor movement remains caller-owned.

PlayerPawn.UpdateRotation3336–3374 sets body yaw from ViewRotation and explicitly
zeros body pitch/roll. The camera helper deliberately accepts a true integer
rotator; it does not invent an original mouse-to-rotator conversion for the
browser's continuous-radian input adapter. The caller must distinguish incoming
body rotation used by PlayerMove from the new view yaw used for rendering.

For crouching, DeusExPlayer.SetBasedPawnSize3208–3265 adjusts BaseEyeHeight to
newHeight minus the default eye-to-collision-height difference, and subtracts
centerDelta.Z from EyeHeight in single-player. These changes precede the eye
update. Do not apply the same crouch center shift again as a stair displacement.
The multiplayer2.5 factor, full stance fitting/rollback, and callback scheduling
are outside this helper. DeusExPlayer.Landed2803–2844 overrides the parent
PlayerPawn.Landed: it marks bJustLanded but does **not** assign LandBob. The parent
assignment must not be inherited into JC's callback. The eye event clears that
flag in its landing/air branch. Landing animation, footstep/audio and damage
branches remain separate integration work.

Validation commands:

```sh
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-native-camera.mjs --capture-only
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-native-camera.mjs
node --test test/camera.test.mjs
```

This completes the bounded math adapter, not whole-game camera acceptance.
Remaining integration evidence must establish the actual OldLocation lifecycle,
physics/render event cadence, successful stance correction ordering, and visual
original-game comparisons for idle/walk/back/crouch/stairs/jump/landing.
CheckBob itself remains the existing253-byte original bytecode, unchanged.

## Recovered actor-tick lifecycle (integration follow-up)

The native tick path is now traced; its lifecycle is no longer an unspecified
camera assumption. Engine export `AActor.Tick`0x10303daa jumps to0x103a1aa0.
For the ordinary local controlled PlayerPawn path that reaches simulation:

1. Player interface virtual slot+0x54 receives actor DeltaSeconds at0x103a25b4.
2. PlayerInput script event dispatch at0x103a25d9 (name0x1058368c).
3. PlayerTick script event dispatch at0x103a25fd (name0x105836b4).
   DeusExPlayer.PlayerWalking.PlayerTick runs its ancillary updates and calls
   Super.PlayerTick at source3712; inherited PlayerPawn.PlayerWalking.PlayerTick
  3605–3611 optionally corrects client position, then calls PlayerMove once.
4. Inside PlayerMove: GetAxes(incoming Rotation), acceleration/dodge setup,
   CheckBob or decay gate, UpdateRotation, then ProcessMove/ReplicateMove.
   The single-player ProcessMove stance/speed/jump effects occur here.
5. Native ProcessState virtual slot+0x14 at0x103a2698, followed by timer/lifespan
   handling. These callbacks can change actor state before physics.
6. With nonzero Physics and Role other than autonomous-proxy3, native
   performPhysics virtual slot+0x8c is called at0x103a276d. The ordinary standalone
   actor is Role4. APawn.performPhysics0x103c9a70 dispatches Walking at0x103c9ad1
   or Falling at0x103c9ae3; it does not itself take a universal OldLocation copy.
7. Following physics, UpdateEyeHeight event dispatch occurs at0x103a28cd
   (name0x105836a0). Its explicit gate at0x103a288d–0x103a28ab is a Pawn,
   bIsPlayer (`+0x318 & 0x02`), Role>=3, and bViewTarget (`+0x31c & 0x01`).
   Without bViewTarget, the alternative copies actor Rotation to ViewRotation.
   Pawn.BecomeViewTarget source439–442 sets that view-target flag.

All three script event parameter blocks take the same actor Tick DeltaSeconds
argument (`[ebp+8]`), not a walking subdivision's remaining-time value.
CheckBob and UpdateEyeHeight therefore each run at most once along this ordinary
actor-tick path. Do not invoke either per physWalking collision/substep or again
when rendering. Pause/stasis, networking, special player states and event-caused
destruction can take other branches; this contract is for active standalone
PlayerWalking, including its temporary falling physics.

### OldLocation ownership

Actor's native layout is Location+0x114, Rotation+0x120,
**OldLocation+0x12c**, ColLocation+0x138, Velocity+0x144. Actor.uc201 calls
OldLocation the location one tick ago, but the instructions are more precise:

* physWalking copies current Location to OldLocation at0x103ca80e–0x103ca83b,
  **once before its subdivision loop**. This is after PlayerMove/ProcessMove
  (including successful crouch center correction) and state/timer callbacks.
* Walking substeps store separate local origins. They do not replace that actor
  field on every collision or step. The final walking velocity reconstruction
  reads actor OldLocation at0x103cbd47–0x103cbd77.
* The physics module's returned `pawn.oldLocation` is therefore the authoritative
  input to the eye helper. Retain it through physics completion. Do not replace
  it with frame-start position, final substep origin, or post-physics position.
* Falling writes OldLocation at0x103d0ee2–0x103d0f01 as part of its own iteration
  path. Air and just-landed eye branches do not consume the Z displacement.
  If remaining-time dispatch enters walking, that walking invocation owns its
  new snapshot. Physics remains responsible for these transitions.

This resolves the crouch ambiguity: SetBasedPawnSize first adjusts EyeHeight by
minus centerDelta.Z; walking subsequently snapshots the already-adjusted actor
Location. Its eye stair delta thus covers the physics displacement, not the
same crouch center correction a second time. Use the original `bJustLanded`
state set by Landed and cleared by UpdateEyeHeight; do not substitute only an
inferred grounded false-to-true edge.

### Body rotation and render ownership

Rotation is three signed32-bit integer components. PlayerMove uses the incoming
body Rotation, not ViewRotation and not this tick's newly applied browser yaw.
PlayerPawn.UpdateRotation3336–3374 updates ViewRotation using input, copies its
Yaw into body rotation, and explicitly sets body Pitch and Roll to zero before
SetRotation. Preserve that body rotator for next tick's GetAxes. Do not retain a
continuous fractional body yaw and independently call trigonometry for bob.
How browser mouse input becomes those integer view units is still an adapter
boundary, not evidence of the original input-device accumulation behavior.

Normal DeusExPlayer.PlayerCalcView7353–7362 consumes completed state:
CameraRotation=ViewRotation; CameraLocation=Location; add EyeHeight to Z;
then add WalkBob. It does not call CheckBob or UpdateEyeHeight. Multiple renders
between actor ticks therefore consume unchanged camera state. The browser's
fixed120Hz tick schedule has not been established as the original scheduling
policy; preserve this within-tick ordering without calling fixed120Hz original
frame-cadence fidelity.

The event's inputs come from `UGameEngine::Draw` (Engine `0x1038f155..0x1038f1ac`):
ViewActor = `Viewport->Actor`, CameraLocation = its `Location` (`+0x114`) and
CameraRotation = its `Rotation` (`+0x120`), not its ViewRotation. A branch that
does not assign CameraRotation keeps the body's rotation: `state Dying`'s death
camera, the hidden branch's roll, and the spy drone's frozen first-person view.
`game.view()` passes the same three values (Stage 5 work item 16, `emp2`).

This follow-up changed only documentation: source/native instruction evidence
settled the ownership contract without adding a second camera scheduler or
reworking the already-compared555-case math adapter. Whole-game captures remain
necessary for end-to-end visual acceptance and special-state/callback effects.
