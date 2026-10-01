# Training translating door pair audit

Authority: original embedded `Engine.Mover`, `DeusEx.DeusExMover`,
`DeusEx.DeusExPlayer` and `Engine.Actor` ScriptText in the local GOTY packages;
original `AMover.physMovingBrush` at `103de690`–`103dea2e`. Source extracts remain
ignored under `.cache/reference/`. This audit is limited to Training
`DeusExMover16`/`DeusExMover17`, normal standalone player use with no inventory
argument. It does not establish arbitrary mover states or mission execution.
The interpolation body itself is now general for every mover; see
[physMovingBrush](#physmovingbrush).

## Actual selected inputs

An inherited-property audit of every Training actor finds exactly these two
actors tagged `UN_maindoor`, and no actor with Event=`UN_maindoor`.
Both have InitialState=TriggerToggle, NumKeys=2, MoveTime=2, MoverGlideType=1,
MoverEncroachType=3 (IgnoreWhenEncroach), bFrobbable/bHighlight=true,
KeyIDNeeded=FrontDoor and bPickable=false. Zero-initialized inherited properties
include KeyNum/PrevKeyNum, KeyPos[0], all KeyRot, DelayTime, bLocked, bOneWay,
bSlave, bTriggerOnceOnly and Event. StayOpenTime=4 and TimeToReset=28 do **not**
auto-close these standalone TriggerToggle doors.

| Panel | BasePos / initial Location | KeyPos[1] | BaseRot |
| --- | --- | --- | --- |
| 16 | [-220,800,-64] | [0,-56,0] | [0,16384,0] |
| 17 | [-219.998046875,863.99853515625,-64] | [0,56,0] | [0,16384,0] |

Local capture: `.cache/doors/training-pair.json`. Player inherited
MaxFrobDistance=112 and initial BaseEyeHeight=40.

## Frob and Trigger are separate operations

`DeusExPlayer.HighlightCenterObject` lines2732–2791 runs only when FrobTime>=0.1,
then resets FrobTime to zero. Its zero-extent TraceActors segment is from
Location+[0,0,BaseEyeHeight] along Vector(ViewRotation)*MaxFrobDistance.
It selects among nonhidden frobbable classes, excluding CarriedDecoration:
ScriptedPawn wins immediately; a Mover wins if it is the first eligible target;
otherwise smallest CollisionRadius wins. FrobTarget is cached. The use command
respects RestrictInput and consumes that target. Play now uses this cached
selection; the older Doors.target sweep is retained only for synthetic fixtures.
The separate IsHighlighted function checks bHidden/bDeleteMe/bHighlight and
bBehindView; it is not the IsFrobbable class predicate.

`DeusExMover.Frob` lines487–665 rejects !bFrobbable, bDestroyed, non-Pawns and
animals. For the selected ordinary player with frobWith=None, opening is allowed
when unlocked; KeyNum!=0 OR PrevKeyNum!=0 allows triggering regardless of lock
or one-way restrictions. This is a key-state predicate, not alpha==0.
One-way uses full native GetAxes(Rotation) X and current Location, not yaw alone.
Successful Frob calls empty Actor.Frob, then self.Trigger, then Trigger on every
other same-tag DeusExMover in AllActors order, excluding empty/default class
Tag. Name comparisons use Unreal names, not case-sensitive JS strings.
The linked panels receive Trigger directly: their Frob locks/oneway checks are
not repeated. The selected pair has neither lock nor one-way restriction.
No success ClientMessage is emitted; "Opening door"/"Closing door" and action
labels are browser UI additions, not original script messages.

`DeusExMover.TriggerToggle.Trigger` first rejects destroyed movers, then inherits
Mover.TriggerToggle.Trigger lines742–752: save Other/Instigator, Other.BeginEvent,
choose Open when KeyNum==0 OR KeyNum<PrevKeyNum, otherwise Close. Open optionally
Sleeps DelayTime **before** DoOpen changes keys; repeated triggers during that
delay restart Open rather than toggling a desired bit. Delay is zero for this
pair. GotoState changes latent execution. Play installs the label on use and runs it
at the mover's next ProcessState before physics; original actor/input ordering
is documented in [door-state.md](door-state.md).

DoOpen sets bOpening=true, bDelaying=false, InterpolateTo(1,MoveTime), opening
sound and ambient sound. After FinishInterpolation: FinishedOpening plays its
sound, triggers Event targets, FinishNotify, then SavedTrigger.EndEvent. The
selected Event is empty. Close sets bOpening=false, InterpolateTo(max(0,KeyNum-1),
MoveTime), closing sound, Event UnTrigger and ambient sound. FinishedClosing
plays ClosedSound, calls EndEvent, clears SavedTrigger/Instigator and FinishNotify.
Actor.BeginEvent/EndEvent and Actor.Frob are empty for the ordinary player;
audio and mover notifications remain distinct effects. No timer closes Toggle.

## Interpolation and collision blockers

Mover.InterpolateTo lines309–342 reverses when NewKeyNum==PrevKeyNum and keys
differ: PhysAlpha=float32(1-PhysAlpha), OldPos=BasePos+KeyPos[old KeyNum]. Otherwise
OldPos=Location and PhysAlpha=0. It then sets PHYS_MovingBrush/bInterpolating,
PrevKeyNum=old KeyNum, KeyNum=new key and PhysRate=1/FMax(Seconds,.005).
InterpolateEnd sets PrevKeyNum=KeyNum, PhysAlpha=0 and clears AmbientSound for the
two-key final endpoint. Global alpha increasing/decreasing with smoothstep is
algebraically equivalent for this ideal pair, but is not native float arithmetic
or native state (especially at completion and repeated triggers).

Original native code forms alpha=oldAlpha+float32(dt)*PhysRate, stores a float
copy while retaining the expression for glide, clamps at1, and computes
3*alpha²-2*alpha³ with a float store (`103de728`–`103de79c`). Target position,
target-minus-OldPos, glide-scaled difference and OldPos+offset each have float
stores (`103de877`–`103de934`). Then it calls ULevel.MoveActor at `103de999`;
only a successful move commits alpha (`103de9b3`). At completion it clears
bInterpolating, invokes InterpolateEnd and may loop over remaining tick time.
Play supplies real MoveActor encroachment and nested player movement before
committing the offset. IgnoreWhenEncroach means Mover.EncroachingOn returns false
for the selected pawn branch; it still displaces the pawn and dispatches native
callbacks. Nine composed native mover scenes verify this movement prefix; the
real-data route validator additionally exercises a closing panel pushing JC.
Based passengers and non-Pawn pushing remain unsupported.

Original instruction capture through `103de934` (stopped before MoveActor) is
`.cache/doors/native-interpolation.json`. For panel16, oldAlpha=0 and dt=1/120
produce stored alpha0.004166666883975267, glide0.000051938663091277704 and absolute
Y799.9970703125. Play preserves this original float result. These early arithmetic captures are
supplemented by the 29 through-return interpolation cases and the composed scene
cases below; each retains its explicit callback boundaries.

## Reset and bounded acceptance

Mover.BeginPlay clamps authored KeyNum, zeroes PhysAlpha, and Move/SetRotation to
BasePos+KeyPos[KeyNum]/BaseRot+KeyRot[KeyNum]. It does not force every mover to key0.
For this pair authored key0 equals initial Location, so zero visual offset is
correct. Browser reset must also restore mutable key/interpolation/state flags,
locked/destroyed state, latent delay and cached interaction target; it is a local
session reset, not an original automatic door event. DeusExMover's TimeToReset
relock/DoClose code is gated by NetMode!=Standalone and does not apply here.

Play connects the selected pair's cached targeting, Frob linking, original state
labels/latent completion, interpolation and real scene movement. Repeated use
before ProcessState retains the original closed key and selects Open twice;
use after interpolation has begun can reverse it. Completed physics resumes
FinishedOpening/Closing on the next ProcessState. Original FinishNotify uses
reconstructed bounds and the live authored PawnList plus JC.

The selected ordinary player's empty BeginEvent/EndEvent and mover event bodies
are source-derived; audio is recorded as deferred Stage 4 work. Original scene
Touch bookkeeping runs, while mission-trigger script bodies remain explicitly
deferred. General locks/inventory, arbitrary state dispatch, carrying and
mission mutations are outside this audit; rotating and multi-key interpolation
is the general body in [physMovingBrush](#physmovingbrush).

Original evidence is split by boundary: [state scheduler](door-state.md),
[mover scene](mover-scene.md), [FinishNotify](mover-finish.md),
[PawnList startup](pawn-list.md), and [scene event bodies](scene-events.md).
The final original-game visual/motion acceptance remains open; this integration
is not a claim that every mover or script is supported.

## physMovingBrush

`AMover::physMovingBrush` (Engine.dll `0x103de690`–`0x103dea2e`) is translated
in full by `physMovingBrush(state, seconds, {location, glideType, move,
interpolateEnd})` in `src/runtime/mover-interpolation.mjs`. Play runs it for
every map mover; it no longer stops at the Training pair's two-key,
constant-rotation subset. Field offsets are the SDK AMover layout:
KeyNum `+0x377`, MoverGlideType `+0x375`, bInterpolating `+0x1ec` bit 7,
PhysAlpha `+0x214`, PhysRate `+0x218`, KeyPos[8] `+0x3c8`, KeyRot[8] `+0x428`,
BasePos `+0x488`, OldPos `+0x494`, BaseRot `+0x4b8` and OldRot `+0x4c4`.

1. A non-Mover returns (class chain walk to `0x1058bb58`).
2. KeyNum is clamped to 0..8 **once**, before the loop (`0x103de6e1`). An
   InterpolateEnd that changes KeyNum does not change the key of the rest of
   that call. A clamped 8 reads one slot past both arrays: KeyPos[8] is
   KeyRot[0]'s three ints read as floats, and KeyRot[8] is BasePos's three
   floats read as ints.
3. The loop runs while bInterpolating is set and the float DeltaTime compares
   greater than double 0.0 (`test ah,0x41`: zero, negative and NaN exit).
4. `alpha = dt*PhysRate + PhysAlpha` stays extended; FCOM against double 1.0
   and FST of the float copy. Above 1 (only "greater", not unordered), the
   remaining time is `float32((alpha-1)/(alpha-PhysAlpha)*dt)`, alpha becomes
   1.0 and the stored copy 1. Otherwise dt becomes +0.
5. MoverGlideType 1 smoothsteps the extended alpha:
   `float32(a²*3.0 - 2*(a*a²))`; any other value stores alpha.
6. Rotation (`0x103de7c3`–`0x103de871`): per component, the int32
   `span = (BaseRot+KeyRot[k]) - OldRot` with wraparound, then
   `OldRot + _ftol(FILD span * glide)`. The product is exact (int32 × 24-bit
   float in the 64-bit significand); msvcrt `_ftol` truncates to int64 and
   keeps the low dword (0 for the indefinite).
7. Position (`0x103de877`–`0x103de954`): `Target = BasePos+KeyPos[k]`,
   `Target-OldPos`, `*glide`, `+OldPos`, each a float32 store, then Core's
   `FVector::operator-` against the live Location gives the delta.
8. `ULevel::MoveActor(this, delta, NewRot, Hit, 0, 0, 0, 0)` (level vtable
   `+0x88`). A failure loops again with the dt from step 4 (so only the
   overshoot branch retries) and commits nothing.
9. Success commits PhysAlpha from the stored copy. If it compares equal to
   1.0, or unordered (C3 is set either way), bInterpolating is cleared and
   `InterpolateEnd(None)` runs through FindFunctionChecked/ProcessEvent;
   the loop then rechecks bInterpolating.

`tickMoverInterpolation(mover, dt)` keeps the pre-VM door fixture: it calls
the same body over the host state, and without `scriptInterpolateEnd` applies
the two-key script's PrevKeyNum=KeyNum and PhysAlpha=0 before
`onInterpolateEnd()`. `interpolateMoverTo` remains that fixture's two-key
InterpolateTo; Play runs the original InterpolateTo bytecode.

### Play wiring

The Mover native fields are bound to the host's `interpolation` state
(`script-doors.mjs` makeBinding), with all eight KeyPos and KeyRot slots.
`seedMoverInterpolation` fills that state from the object's own storage
(the map-authored value or the class default, which the bindings never
write) after every property reset and before LoadMap's startup passes run
Mover.BeginPlay. A mover that starts at a nonzero KeyNum, or whose
MoverGlideType is the class default, now reads its real value rather than a
fixture zero. The physMovingBrush service passes the live Location, reads
MoverGlideType through the runtime, sends `move(delta, NewRotation)` to the
moving-brush MoveActor (`mover-move.mjs`, which already takes NewRotation
and checks encroachment at the new rotation), and dispatches the original
InterpolateEnd.

Collision follows a turned mover: the hash and the brush queries take ABrush
ToWorld of `collisionValues`, whose Location and Rotation read the live pose.
The renderer poses a rotated mover's group with `brushMatrix` of the live
Location and Rotation, and keeps the translation-only offset path for
movers at their authored rotation. Moving lights (`moving-lights.mjs`) still
receive only a mover's translation; on a rotated mover they light the
authored orientation, and the world notes say so.

### Validation

The oracle writes every field above and executes the original body with
MoveActor as a controlled leaf (recording delta, NewRotation and the four
flags, applying a success to Location and Rotation) and InterpolateEnd as a
recorded leaf. Floats are compared as float32 bit patterns. The 279 cases
are:

- the 29 Training-pair cases (both directions, tiny, zero and regular dt,
  glide and linear, overshoot, inactive, rejected moves);
- the UNATCO Island cell door's yaw quarter turn over four alphas, four dts
  and both glide types, plus reversed and VM-owned InterpolateEnd variants;
- every KeyNum 0..7 with distinct per-key positions and rotations, and
  KeyNum 8, 9 and 255 reading past both arrays;
- int32 span wraparound and products beyond int32 and int64;
- an initial alpha above 1, and an infinite alpha;
- 200 seeded random cases over every input, including rejected moves and
  NaN positions from the past-the-array reads.

All 279 match: 307 MoveActor calls and 134 InterpolateEnds, every
delta, NewRotation, Location, Rotation, PhysAlpha and bInterpolating.
`scripts/validate-island-cell-door.mjs` then triggers DeusExMover10
through its original state code in a booted Island and checks the seeded
KeyRot[1], a monotonic quarter turn over 60 frames ending on
BaseRot+KeyRot[1], the original InterpolateEnd, an unmoved Location, and the
collision transform following the turn. The intro's TriggerOpenTimed door
(DeusExMover20) and Gunther's GuntherRescued conversation, both stopped
before by the subset gate, now run headless without a runtime error.

```sh
node scripts/validate-native-mover-interpolation.mjs
node scripts/validate-native-mover-interpolation.mjs --reuse
node --test test/mover-interpolation.test.mjs
node scripts/validate-island-cell-door.mjs
```

Captured case/reference files are ignored `.cache/doors/{cases,original}.json`.
No original assets or extracted script text are checked in.
