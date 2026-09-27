# Source-ordered dry walking controls

## Batch 6 live route

Play now runs original `PlayerInput`, `HandleWalking`, state `PlayerTick`,
`PlayerMove`, `ProcessMove`, `UpdateRotation`, ProcessState/timers, Pawn physics
and `UpdateEyeHeight` through the shared scheduler. The helpers and 27-frame
comparison below are retained Stage 2 fixtures, not Play's execution path.
The native input contract and comparisons are in
[script-console-command.md](script-console-command.md), and the full tick
integration is recorded in [script-player-tick.md](script-player-tick.md).

Installed `User.ini` uses W/A/S/D or arrows for movement, X=Duck,
Shift=Walking, Space=Jump, Q/E=LeanLeft/LeanRight, F=CenterView,
RightMouse=ParseRightClick, and Enter/LeftMouse=ParseLeftClick|Fire.
Play delivers those bindings. Native ReadInput scales held axes per admitted
frame; Play no longer has a fixed 120 Hz player port.

The original Dodge selection/animation code is prepared and executes as
bytecode, but installed User.ini and DefUser.ini both set DodgeClickTime=0
(line 249), so the `PlayerMove` `DodgeClickTime > 0` gate does not enter its
double-tap path. Changing that config, non-world moving-base jumps, swimming
and ladder traversal remain outside the bounded Training route's verification.
Browser device sampling, OS acceleration and physical-device equivalence are
also unverified. No visual comparison is claimed by the native/script checks.

Original authority: embedded DeusExPlayer.HandleWalking3085–3121,
PlayerWalking.ProcessMove3422–3662, DoJump3132–3175; inherited
PlayerPawn.PlayerWalking.ProcessMove3534–3562. Actual local System/User.ini and
shipped DefUser.ini both set bAlwaysRun=True and bToggleCrouch=False, lines8–9.
These config values are not serialized class-default booleans.

Source contract recorded before helper implementation:

1. PlayerInput calls HandleWalking before PlayerTick. It derives bIsWalking from
   bRun/bDuck and bAlwaysRun, then applies bToggleWalk. In hold-crouch mode it
   does not change bIsCrouching. Toggle mode maintains bCrouchOn/bWasCrouchOn/
   lastbDuck and can force bIsCrouching=true and bDuck=1 immediately.
2. DeusExPlayer.ProcessMove selects resize from the existing bIsCrouching OR
   bForceDuck. It computes the ceiling trace and replaces bForceDuck. Existing
   bIsCrouching or new bForceDuck then forces bIsWalking=true.
3. Healthy speed calculation runs; Super.ProcessMove assigns Acceleration,
   performs any Dodge handling, and invokes DoJump if bPressedJump.
4. Only if physics remains Walking and the animation group is not Dodge does
   Super update bIsCrouching from bDuck. Enter calls PlayDuck; leave calls
   TweenToRunning(.1) and resets its local OldAccel. These animation/local effects
   remain explicit caller actions.

Thus hold-crouch press/release affects collision size one PlayerMove later.
On first crouch+jump, resizing still sees the prior standing flag; DoJump changes
physics to Falling, so the crouching flag stays false. A previously crouched
Pawn retains its flag/size during falling. Releasing crouch in air retains the
flag until a later Walking ProcessMove; another tick then restores size. The
resize function itself has no walking gate; it reads the persistent flag.
DoJump rejects forceDuck or leaning, and heavy carried decorations, then requires
Walking. Its commented crouch jump reduction is inactive. Ordinary world-base
jump uses JumpZ; other moving bases add Base.Velocity.Z.

The helper exposes four pure state operations, deliberately keeping actual
resize, native movement, jump effects and animation callbacks in the caller:
`handleWalkingControls(previous,buttons,settings)`,
`stanceCrouchRequested(state)`, `afterStanceControls(state,forceDuck)`, and
`afterJumpControls(state,physics,animationGroup='')`.
State names are isCrouching/isWalking/forceDuck/duck/crouchOn/wasCrouchOn/lastDuck.
Buttons are duck/run; settings are alwaysRun/toggleWalk/toggleCrouch. The last
operation returns `{state,animation}`; animation is PlayDuck or TweenToRunning,
and null when no transition. Dodge and unrelated animation execution remain
outside this helper. No new numerical collision algorithm is introduced.

This is source translation and source-prescribed control regression coverage,
not original VM execution of complete HandleWalking/ProcessMove. The native
movement, resize and camera primitives retain their separate original captures.

## Tick acceptance comparison

`node scripts/validate-player-tick-order.mjs` instantiates the actual Training
scene twice: one executes Player.tick, and the other explicitly composes the
source-prescribed HandleWalking, incoming bob, ProcessMove stance/speed/jump/flag
phases, evidenced physics, and final eye update. Five small sequences cover
forward/backward, jump, hold-crouch press/release, first duck+jump, and crouch
release in air. All 27 frames match in pose, velocity, physical dimensions,
control crouching/walking flags, eye/base-eye height, WalkBob, BobTime and body/
view rotation. Input yaw is fixed0; this is not a mouse-conversion comparison.

The actual tick eye inputs are also captured and passed independently to the
original native camera expression oracle; all 27 eye outputs match exactly.
These remain source-selected numerical expressions, not execution of the whole
UpdateEyeHeight script event. CheckBob runs its original embedded bytecode in
the existing JS VM; this comparison does not introduce a second implementation
or claim a complete original native Actor.Tick capture. Ignored references and
first-divergence reports are under `reports/movement/player-tick-order/`.

The source audit found and corrected the hold-crouch one-tick ordering bug in
Player.tick. Incoming body Rotation/velocity/previous GroundSpeed now feed bob
before current stance/speed/jump effects; physics owns OldLocation; eye updates
once after completed physics. The independent native composed physics corpus
remains the evidence for the underlying geometry path (63frames/2547queries).

Remaining original boundaries: input-device accumulation and fixed120Hz cadence;
actual ProcessState/timer/mission effects between PlayerMove and physics; full
Dodge/menu/animation state evaluation; non-world vertical moving-base jumps;
original callback audio/damage/AI; camera FOV/zoom, ViewShake and visual captures.
Those are not covered by the five ordinary dry, fixed-view cases. Healthy speed
resolution and original config values are explicit preconditions, not inferred
from class-default values.
