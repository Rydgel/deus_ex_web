# Training translating door pair audit

Authority: original embedded `Engine.Mover`, `DeusEx.DeusExMover`,
`DeusEx.DeusExPlayer` and `Engine.Actor` ScriptText in the local GOTY packages;
original `AMover.physMovingBrush` at `103de690`–`103dea2e`. Source extracts remain
ignored under `.cache/reference/`. This audit is limited to Training
`DeusExMover16`/`DeusExMover17`, normal standalone player use with no inventory
argument. It does not establish arbitrary mover states or mission execution.

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
deferred. General locks/inventory, rotating or multi-key movers, arbitrary state
dispatch, carrying and mission mutations are outside this subset.

Original evidence is split by boundary: [state scheduler](door-state.md),
[mover scene](mover-scene.md), [FinishNotify](mover-finish.md),
[PawnList startup](pawn-list.md), and [scene event bodies](scene-events.md).
The final original-game visual/motion acceptance remains open; this integration
is not a claim that every mover or script is supported.

## Delivered interpolation helper

`src/runtime/mover-interpolation.mjs` provides `interpolateMoverTo(mover,key,seconds)`
and `tickMoverInterpolation(mover,dt)`. Mutable state is `position`, `basePosition`,
`oldPosition` (UE float32 triples), `keyPositions` (two triples), constant `rotation`,
`key`, `previousKey`, `alpha`, `rate`, `glideType`, `interpolating` and `physics`.
The adapter must establish the constant-rotation/two-key precondition. This does
not interpret TriggerToggle, Frob, delay, sounds, tags or latent state execution.

`interpolateMoverTo` translates the embedded function's reversal/start arithmetic
and physics/key fields; optional `setPhysics(9)` supplies transition side effects.
`tickMoverInterpolation` calls `move(delta,rotation)`. That callback must perform
the movement, mutate `position` with native float stores, and return MoveActor's
boolean success. A pure offset assignment is only an explicitly controlled
unobstructed callback, not native encroachment. Map rendering/collision offset
must derive from this absolute position minus the initial authored Location;
do not independently integrate unrounded offsets. `onInterpolateEnd()` runs after
bInterpolating is cleared and the two-key script's previousKey=key/alpha=0 state
is applied. The adapter owns ambient sound, ClientUpdate, FinishedOpening/Closing
and latent continuation; the helper does not silently claim these effects.

The original `AMover.physMovingBrush` harness now executes through return with
controlled MoveActor responses and an explicitly source-derived two-key
InterpolateEnd callback. The script callback itself is not executed by a VM.
Twenty-nine original cases exactly match move requests, rotation, success/failure
branching, completion notification, position, alpha and interpolation flag.
They cover both travel directions, tiny/zero/regular dt, glide and linear modes,
endpoint overshoot, inactive movers and rejected movement with remaining time.
Four regression tests cover the first native 120Hz position, reversal, event
ordering and failed-move alpha. This establishes the helper's bounded numerical
and callback contract; full original-game visual/motion acceptance remains separate.

```sh
node scripts/validate-native-mover-interpolation.mjs
node scripts/validate-native-mover-interpolation.mjs --reuse
node --test test/mover-interpolation.test.mjs
```

Captured case/reference files are ignored `.cache/doors/{cases,original}.json`.
No original assets or extracted script text are checked in.
