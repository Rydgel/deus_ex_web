# Original standalone PlayerPawn tick contract

Authority is the embedded GOTY declarations in `.cache/reference/PlayerPawn.uc`
and `DeusExPlayer.uc`, plus `Engine.dll` disassembly in
`.cache/reference/Engine.asm`. This document specifies the ordinary active,
standalone, local `DeusExPlayer` in script state `PlayerWalking`. Simulated
network movement, conversations, spy drone, special player states, browser
device sampling and render scheduling are not inferred from that route. The
native viewport input wrapper and its browser-device boundary are documented
in [script-console-command.md](script-console-command.md).

## Native entry, event order, and virtual dispatch

`AActor::Tick` is `Engine.dll 0x103a1aa0` (export thunk `0x10303daa`). After its
stasis/authority gates, the local-player path passes the frame DeltaSeconds to
the attached `UPlayer` interface virtual at object slot `+0x54` (`0x103a25b4`),
then dispatches script `PlayerInput(DeltaSeconds)` at `0x103a25d9`, followed by
`PlayerTick(DeltaSeconds)` at `0x103a25fd`. It then makes the second ReadInput
call with `-1.0` at `0x103a2600..0x103a260d`. These branches and their gates are
documented in [script-actor-tick.md](script-actor-tick.md). In the ordinary
local branch both script events receive the same actor-tick delta, followed by
native ProcessState with that delta; there is one PlayerMove from this
PlayerTick path.

After script PlayerTick returns, Actor.Tick calls virtual slot `+0x14` at
`0x103a2698` with the same delta: this is `UObject::ProcessState(FLOAT)` in the
recovered SDK vtable declaration. Timers/lifespan are next. If the actor still
has nonzero Physics and Role is not AutonomousProxy (3), Actor.Tick calls
virtual slot `+0x8c` at `0x103a276d`. For a Pawn object this resolves to
`APawn::performPhysics` (`0x103c9a70`); `Engine.asm 0x103c9ac2..0x103c9ae3`
shows its Physics jump table dispatching Walking=1 to `physWalking`
(`0x10303fd0`, call site `0x103c9ad1`) and Falling=2 to `physFalling`
(`0x10302fef`, call site `0x103c9ae3`). The non-Pawn implementation is the
distinct `AActor::performPhysics` body at `0x103c9770` and is not the player
path. `APawn::performPhysics` then applies its physics-rotation gate, decrements
MoveTimer, updates AvgPhysicsTime, posts at most one initial PendingTouch, then
re-reads the head after the callback and unlinks at most one current link, as described in
[actor-physics.md](actor-physics.md) and
[player-physics.md](player-physics.md). The live script-pawn adapter currently
supports only Walking/Falling.

After physics, Actor.Tick checks Pawn ancestry, `bIsPlayer`, Role>=3 and
`bViewTarget` (`0x103a288d..0x103a28ab`). A true gate dispatches
`UpdateEyeHeight(DeltaSeconds)` at `0x103a28cd`; false copies actor Rotation to
ViewRotation instead. Thus eye update runs after all physics and at most once
per admitted actor tick, including when walking physics temporarily becomes
Falling. It is not called per collision substep or per render. `PlayerCalcView`
is a separate render-side event, not a continuation of Actor.Tick.

This dispatch is confirmed directly by the machine-code indirect calls and
the recovered Engine SDK vtable: the Pawn override, not the non-Pawn AActor
body, receives the player's slot `+0x8c` call. `APawn::performPhysics` does not
make a general actor OldLocation snapshot. `physWalking` writes Location to
OldLocation once before its subdivision loop (`0x103ca80e..0x103ca83b`);
falling owns its own writes (`0x103d0ee2..0x103d0f01`). Use the final physics
field value as UpdateEyeHeight's OldLocation input.

## Script event chain

`DeusExPlayer.PlayerInput` (`DeusExPlayer.uc:7377–7381`) skips inherited input
only inside a conversation. Otherwise it calls `PlayerPawn.PlayerInput`
(`PlayerPawn.uc:2619–2798`), which remaps already accumulated axes, detects
direction edges for dodge, applies mouse smoothing and sensitivity, updates
look/forward axes, then calls virtual `HandleWalking`. `DeusExPlayer.HandleWalking`
(`DeusExPlayer.uc:3085–3122`) calls `Super.HandleWalking`, chooses
bIsWalking from bRun/bDuck and bAlwaysRun, applies bToggleWalk, and updates the
bToggleCrouch state (`bCrouchOn`, `bWasCrouchOn`, `lastbDuck`, bIsCrouching and
bDuck). The shipped user config has bAlwaysRun=True and bToggleCrouch=False;
these are runtime config inputs, not class-default values.

`DeusExPlayer.PlayerWalking.PlayerTick` (`DeusExPlayer.uc:3674–3713`) performs
RefreshSystems, DrugEffects, Bleed, HighlightCenterObject, dynamic music, EMP,
MultiplayerTick, FrobTime, floor/wall material lookup, conversation-radius and
actor-distance checks, and playtime accounting before `Super.PlayerTick`. The
ordinary inherited `PlayerPawn.PlayerWalking.PlayerTick` (`PlayerPawn.uc:3605–
3611`) calls `PlayerMove(DeltaSeconds)` once (and conditionally
ClientUpdatePosition for a client).

Inherited `PlayerMove` (`PlayerPawn.uc:3613–3728`) reads axes from incoming
integer body Rotation, scales aForward/aStrafe by 0.4 and lookup/turn by 0.24,
forms NewAccel, selects dodge state from input edges/timers, and gets the current
animation group. If Physics is Walking and group is not Dodge, it processes
stair/view pitch then computes horizontal speed from the incoming Velocity and
calls CheckBob unless a menu is shown. Otherwise it resets BobTime and decays
WalkBob when no menu is shown. It then calls UpdateRotation, saves jump input
when the current animation group is Dodge, and for Role>=Authority calls
`ProcessMove(DeltaSeconds, NewAccel, DodgeMove, OldRotation-Rotation)`; finally
it restores the saved jump bit. Source-derived GetAxes/bob/rotation numerics and
current limits are in [camera.md](camera.md) and [player-input.md](player-input.md).

Dynamic dispatch selects `DeusExPlayer.PlayerWalking.ProcessMove`
(`DeusExPlayer.uc:3387–3663`). Spy-drone mode has an early return. Ordinary
mode gets integer defSpeed from GetCurrentGroundSpeed; if previous
bIsCrouching or bForceDuck is set, standalone calls SetBasedPawnSize to default
radius/height 16 and traces a ceiling-clearance extent of
`[CollisionRadius, CollisionRadius, 1]` from Location to a checkpoint whose Z
is `Location.Z - CollisionHeight + 2*GetDefaultCollisionHeight`. That result
replaces bForceDuck. The standing branch resets size (unless leaning). Speed is
then adjusted for leg/torso injury, carried decoration/weapon/in-hand object,
backward motion and the standalone 100-unit floor; healthy, unladen standalone
speed is covered in [player-input.md](player-input.md). Leaning and drone
branches remain outside the ordinary movement adapter. It calls the inherited
`PlayerPawn.PlayerWalking.ProcessMove` at DeusExPlayer source line 3662.

The inherited ProcessMove (`PlayerPawn.uc:3533–3562`) stores Acceleration,
computes bIsTurning from DeltaRot.Yaw/DeltaTime, handles active/initial Dodge,
then calls DoJump when bPressedJump. Only if Physics is still Walking and the
animation group is not Dodge does it update bIsCrouching from bDuck and trigger
PlayDuck/TweenToRunning plus later locomotion animation work. This sequencing
means stance flag changes occur after resize and jump: holding crouch first
changes physical height on a later PlayerMove; a first crouch+jump attempts
standing resize, then jumping to Falling prevents crouch-flag entry. Existing
crouch remains through falling and a release in air waits for a later Walking
ProcessMove. This boundary is specified more fully in [player-controls.md](player-controls.md).

The selected DeusExPlayer DoJump (`DeusExPlayer.uc:3132–3175`) rejects carried
Decoration mass >20 and bForceDuck/leaning, then requires Walking. It plays
sound/noise/air effects, sets Velocity.Z=JumpZ, adds Base.Velocity.Z when
`Base != Level`, sets Physics=Falling, and conditionally records a jump. Its
crouch-jump reduction is commented out. The inherited PlayerPawn DoJump
(`PlayerPawn.uc:1916–1934`) has a different carried-object/standing-only rule;
do not dispatch it for JC. Jumping from a moving base therefore depends on
the actual Base and its velocity. Audio, random FRand pitch, noise, animation,
inventory callback and decoration mass are not supplied by a geometry-only
jump helper.

`DeusExPlayer.UpdateEyeHeight` (`DeusExPlayer.uc:7312–7322`) calls parent
`PlayerPawn.UpdateEyeHeight` (`PlayerPawn.uc:2803–2848`) then, if JoltMagnitude
is nonzero, adds `5*JoltMagnitude` only for Walking with nonzero Bob and clears
JoltMagnitude. Parent walking/not-just-landed branch uses
`smooth=FMin(1,10*DeltaSeconds/Level.TimeDilation)` and stair delta
`-Location.Z+OldLocation.Z`, blending toward ShakeVert+BaseEyeHeight. Air or
just-landed branch uses `FClamp(10*DeltaSeconds/TimeDilation,0.35,1)`, clears
bJustLanded, and blends without stair delta. FOV return and zoom fields also
run here. The original commented eye-height clamps are inactive. Numerical
expression capture and the current intentionally bounded adapter are detailed
in [camera.md](camera.md).

For the ordinary first-person/no-conversation/no-view-target case,
`DeusExPlayer.PlayerCalcView` (`DeusExPlayer.uc:7328–7370`) sets ViewActor=self,
CameraRotation=ViewRotation, CameraLocation=Location, adds EyeHeight to Z and
then WalkBob (`7353–7361`). ViewTarget, spy-drone, behind-view and conversation
camera branches precede or replace this path. It consumes completed tick state;
it does not update bob or eye height.

## Reached work and support status

The following are already bounded by original source/native evidence and have
translations: Actor.Tick gates and event ordering (`script-actor-tick.md`),
HandleWalking state transformations (`player-controls.md`), quantized GetAxes,
healthy walking axes/speed and camera expression captures (`player-input.md`,
`camera.md`), script Trace wrapper (`stance-trace.md`), ProcessMove crouch
clearance query, walking/falling native movement and the reached ordinary
callbacks (`player-physics.md`, `walking-callbacks.md`, `player-sequence.md`),
and first-person camera location/rotation assembly. The original `CheckBob`
bytecode is run by the existing VM; the independent 27-frame tick comparison
and native eye-expression cases are recorded in `player-controls.md`.

The reached movement/native leaves currently have this narrower status:

| Original operation reached by the live route | Evidence / current status |
| --- | --- |
| `UPlayer::ReadInput` / viewport axis collection | Live Play calls the recovered `UViewport::ReadInput` wrapper: for ordinary Delta it runs `UpdateInput(0)`, then `UInput::ReadInput(Delta,*GLog)` replays held keys and scales CPF_Input floats. The browser host supplies event-fed key state and integer mouse deltas at that sampling boundary. Native wrapper order and game-side accumulation are recovered; OS cursor/DPI cadence and joystick samples remain platform boundaries. See [script-console-command.md](script-console-command.md). |
| `Core.GetAxes`, `Core.Sqrt`, float/vector math in PlayerMove | Original native expressions are captured and matched; see `camera.md` and `player-input.md`. |
| `Actor.Trace` for crouch headroom | `execTrace` entry/return and 24 controlled-query cases match; original query/identity still comes from the supplied live scene. See `stance-trace.md`. |
| Original `PlayerInput`, `PlayerTick`, `HandleWalking`, `PlayerMove` / `ProcessMove`, `DoJump`, and `UpdateEyeHeight` bytecode | The live local-player Actor.Tick route executes the prepared original functions in the VM; source order is detailed above. A 60-tick Training zero-input run reached real Landed, PlayerMove and UpdateEyeHeight without a boundary. This is reach evidence, not a reference-output comparison of every script side effect or input branch. |
| `SetBasedPawnSize` / `SetCollisionSize` / `Move` | Original ProcessMove and SetBasedPawnSize bytecode use the existing native imports, preserving resize-before-jump/stance ordering. The source contract in `stance.md`, 404 native MoveActor cases, the relocation harness's SetCollisionSize cases, and 24 Trace cases establish the reused leaves. Live gameplay checks the crouch/release floor and size transition. The 63-frame physics corpus starts crouched cases at their requested dimensions; it is not an additional whole-stance reference capture. |
| `APawn::performPhysics`, `physWalking`, `physFalling`, `processLanded`, native `MoveActor` and scene collision queries | The clone-aware field-backed adapter matches 63 frames/2,547 ordered queries, including the 12-frame Training stair approach (`validate-field-player-sequence-adapter.mjs`). This verifies the mapped physical fields and query order; the sequence oracle keeps script dispatch as an explicit no-op boundary, while live Play dispatches prepared original events. Native landing separately matches 506 original cases exactly. See `player-sequence.md` and `player-physics.md`. |
| `APawn::IsBlockedBy` policy for a controlled player | The field-backed view now derives `controlledPlayer` from original PlayerPawn ancestry and a non-null Player field. This is the predicate required by the original `GetPlayerPawn` path in [move-query.md](move-query.md), not a host `isPlayer` label. |
| `APawn::PendingTouch` queue and `PostTouch` callbacks | The view binds PendingTouch and dispatches PostTouch through the live synchronous ScriptRuntime when present, then rereads and unlinks one current head in native write order. A direct DLL fixture verified the nonempty-list unlink with a ProcessEvent stub; the callback body and callback-driven head replacement/clear remain unverified. See the native-tail contract below. |
| ProcessMove stance `Move`, mover/rider pushes, `FarMoveActor`, and zone changes | Live Play connects `playerScene.hooks.dispatchEvent` to `ScriptRuntime.dispatchEvent`, so prepared events and the recovered zone script run on that route. Isolated Stage-2 geometry fixtures retain their explicit dry callbacks; missing live events fail at the dispatch boundary. Full mover/push/landing combinations and associated random-stream behavior remain limited; see `player-physics.md` and `walking-callbacks.md`. |
| First-person `PlayerCalcView` | The live view path invokes the prepared original `PlayerCalcView` event with out references. First-person output uses Location, EyeHeight, WalkBob and ViewRotation; no render-capture comparison is claimed. Behind-view, view-target, spy-drone and conversation branches remain separate. |

The live route now executes the ordinary original script chain, but the checks
above do not establish every input, movement, side-effect or camera branch.
Remaining boundaries for Training-style walking/crouching/jump/fall/camera are:

* Viewport input substitutes browser device events at the platform boundary.
  The native wrapper, keyboard reconciliation, mouse-delta sign and User.ini
  axis accumulation are recovered; browser event cadence, OS cursor/DPI
  quantization and joystick polling remain platform differences. See
  [script-console-command.md](script-console-command.md).
* Original Dodge selection and its complete velocity/sound/animation callbacks,
  leaning, carried-object and equipment speed branches, spy drone and damage
  branches now execute their source bytecode where reached, but native imports,
  mission side effects and reference cases are not all established. Do not
  equate VM execution with validation of every branch.
* PlayerTick's DrugEffects/Bleed/system, highlight/interactions, dynamic music,
  EMP, material, conversation and playtime calls execute on the live script
  route when their prepared dependencies are present. Mission/audio-dependent
  side effects and non-ordinary states remain unvalidated as a whole chain.
* DoJump bytecode uses the canonical Base and velocity fields, and Walking /
  Falling are linked. Moving-base, carried-mass/equipment, landed damage,
  audio, animation and relocation outcomes still need their focused original
  cases. Training's WaterZone path also needs the player's PHYS_Swimming=3:
  `APawn::performPhysics` dispatches it to `physSwimming` at `0x103d3cd0`.
  Script pawns now run it through `runScriptPawnPhysics`
  ([swimming](swimming.md)), but the player route (`runPlayerPhysics`, the
  PlayerSwimming state and breath effects) still refuses water regions. The
  source route and native work boundary are recorded in `player-physics.md`.
* Eye/FOV/zoom bytecode executes on the live route and the eye expressions have
  original-native comparisons. Jolt production and full rendered camera parity
  or viewport cadence are not established by those expression checks.

The live game now routes the controlled actor through Actor.Tick once per actor
tick: PlayerInput precedes PlayerTick, ProcessState and timers precede Pawn
physics, and UpdateEyeHeight follows that physics call. Jump's Physics write is
read by the subsequent native physics dispatch; ProcessMove keeps stance resize
before inherited jump/stance-flag updates. Rendering consumes completed
ViewRotation, Location, EyeHeight and WalkBob through PlayerCalcView. Extend
this path only with branches backed by original source, native evidence or a
reproducible original-game measurement.

## APawn tail and field-backed adapter follow-up

### Live vector storage boundary

The first live stair descent exposed discarded component stores: script
`readNamed` returns vector values, while the earlier physics fixture returned
mutable arrays. Native physWalking explicitly clears Velocity.Z and
Acceleration.Z (and clears/restores Velocity.Z at its falling transition and
return); the existing translation's `pawn.velocity[2] = ...` therefore changed
only a temporary value on the live field-backed view. A live sample retained
Velocity.Z=-1919.9998779296875 with Physics=Walking, exposing the integration
failure. These original stores are already recovered in
[walking.md](walking.md); landing's two randomized horizontal component stores
have the same storage requirement ([landing.md](landing.md)).

The native translations must write the completed vector back through the
field setter after a component change. No physics expression or rounding
point changes. The adapter replay must copy vectors on reads and writes to
exercise the actual script storage boundary; a mutable-only fixture cannot
validate this integration. Before that fix, a clone-aware replay reproduced
the exposed writeback bugs: Training/drop frame 4 had Velocity.Z
`6.574846267700195` instead of the native zero; the recorded stair approach
had Velocity.Z `315.999755859375` instead of zero on frame 0. After the whole-
vector stores were added, the same replay passed all 63 frames and 2,547
ordered queries. The reusable check is
[`validate-field-player-sequence-adapter.mjs`](../scripts/validate-field-player-sequence-adapter.mjs).
The focused landing validator also passed all 506 original cases exactly
(state, query parameters and callback order; maxError 0) after its randomized
horizontal component stores were routed through the field setter.

The Pawn-specific tail was checked directly in `Engine.asm` at
`0x103c9c20..0x103c9ca8`. After the Physics switch and Pawn physics-rotation
branch, it subtracts float32 DeltaSeconds from MoveTimer and stores float32
(`0x103c9c20..0x103c9c31`). It reads the initial PendingTouch pointer, then
updates AvgPhysicsTime using x87 extended intermediates:

```text
flds old AvgPhysicsTime (+0x32c)
fmull qword [0x10431418]       // 0.8
flds DeltaSeconds
fmull qword [0x1042b8e8]       // 0.2
faddp st(1), st(0)
fstps AvgPhysicsTime (+0x32c)  // one float32 rounding at the field store
```

The translation now uses the existing exact x87 model (`x87double`,
`x87load`, `x87mul`, `x87add`, `x87store`) for this expression. JS binary64
intermediates would round the products/sum at 53 bits instead of x87's 64-bit
significand and can disagree at a float32 midpoint. The constant operands are
binary64 qwords, while old field and DeltaSeconds are float32. Evidence here is
the unchanged native instruction sequence, existing script-VM x87 helpers,
and direct DLL calls to `APawn::performPhysics` (`0x103c9a70`) for four
Walking cases. AvgPhysicsTime matched exactly: `(old,dt)=(0,.1) ->
.019999999552965164`, `(1,.1) -> .8199999928474426`,
`(123.456,1/120) -> 98.76646423339844`, and `(.001,.05) ->
.01080000028014183`; MoveTimer also matched its float32 decrement in each
case. These are focused tail cases, not a whole-player-tick differential.

The native deferred-touch sequence is also direct in the disassembly. If the
initial `PendingTouch` is non-null, `0x103c9c56..0x103c9c75` resolves the
PostTouch function (`NAME_PostTouch` global `0x105835d0`) and ProcessEvents it
on that linked actor with the Pawn as `Other`. The tail then re-reads
`Pawn.PendingTouch` (`0x103c9c78`); null returns without unlinking. Otherwise
it loads that current link's `PendingTouch`, stores it as the Pawn head, and
clears the link's field (`0x103c9c82..0x103c9c91`). This ordering means a
callback can replace or clear the head, and the post-callback head determines
which single link is removed. `pawnPhysicsView` now binds this inherited Actor
field, routes PostTouch through the caller's synchronous script dispatcher,
then performs those rereads/writes through field services. An unprepared
PostTouch event remains an explicit dispatch error; the adapter does not skip a
nonempty list.

One direct native nonempty-list check called original `APawn::performPhysics`
with `PendingTouch=Plant2` and `Plant2.PendingTouch=Plant3`. The original DLL
reached its ProcessEvent boundary at caller `0x103c9c78`; after the harness's
explicit ProcessEvent return, native code stored Plant3 as the pawn head and
cleared Plant2's link, as the field-backed adapter does. The harness event
stub did not run the actual PostTouch script body, so callback replacement or
clearing of the head is supported by the recovered reread ordering but has not
been differentially exercised. The APawn null-after-callback branch
(`Pawn.PendingTouch == null`) remains disassembly-only evidence.

The field-backed Pawn adapter computes controlled-player identity from
PlayerPawn ancestry plus non-null `Player`, matching the native move-query
predicate. `APawn::physicsRotation` still has its separate native gate: it
returns for PlayerPawn ancestry even where the Player attachment is null. The
adapter's supported physics modes remain Walking and Falling. The current
Training zero-input Actor.Tick run observed by the parent covered 60 ticks and
reached real Landed, PlayerMove and UpdateEyeHeight with no exception at
689 MiB RSS; that scoped smoke observation does not compare output fields to an
original 60-tick capture and does not establish all branches above.

## Batch 6 live route and initial reach measurement

Before Play was wired to the complete local-player route,
`.cache/batch6-player-inspect.mjs` ran 60 original actor ticks with no held keys
or mouse samples. ReadInput was an explicitly controlled zero-input leaf; this
is a script/physics reach measurement, not input fidelity.
The unchanged PlayerInput/PlayerTick bodies, ProcessState, Pawn physics, Landed
and UpdateEyeHeight completed without a boundary (20 seconds, 689 MiB peak).
The installed player has `bViewTarget=True`. The original callback chain can
therefore replace the former early-return `controlledPlayerTick` hook; the live
game now runs that chain and does not apply a second host PlayerMove, hand
update, highlight or eye update afterward.

The original actor fields remain authoritative across their existing storage
bindings. ViewRotation is an unmodified signed-int rotator field: the Pitch
mask belongs to UpdateRotation's bytecode, not every field read. The interaction
display reads FrobTarget/FrobTime without writing either. Public use/fire
and belt helpers emit their installed input bindings, preserving root-window
consumption and original cached targeting. The renderer calls PlayerCalcView
with out references and reads FOVAngle; it retains no second Play yaw/pitch.

For stance relocation and mover pushes, `playerScene` retains the already
captured native MoveActor/FarMove/SetActorZone algorithms, while their callback
leaves dispatch the prepared original script events whenever the runtime is
linked. The original zone body calls ActorLeaving/ActorEntered, ZoneChange,
FootZoneChange and HeadZoneChange in its recovered order (`zone.md`). There
must be no catch-and-defer of a script boundary on this live route. Isolated
Stage-2 geometry fixtures can still explicitly use their original bounded
callback fixtures without claiming a complete Play tick.

Browser mouse axes replace platform device samples at the `InputEvent`
boundary. WinDrv `UWindowsViewport::UpdateInput` at `0x11109280` samples
integer cursor coordinates, stores current and prior positions, then sends
changed X as float32 to `CauseInputEvent(IK_MouseX=0xe4, IST_AXIS=4, X)` at
`0x11109677..0x11109687`. It negates Y before sending
`CauseInputEvent(IK_MouseY=0xe5, 4, -Y)` at `0x11109690..0x111096a5`. The
browser adapter accumulates integer relative movement until the next native
sampling boundary and uses that Y sign. Browser event cadence, physical mouse
DPI, OS acceleration and the difference between relative browser movement and
native cursor coordinates remain platform differences. User.ini AXIS Speed,
PlayerInput sensitivity/smoothing and UpdateRotation remain original code; see
[script-console-command.md](script-console-command.md) for the full wrapper and
device trace.
