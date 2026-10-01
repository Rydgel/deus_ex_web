# Original animation control natives

Authority is the installed, hash-checked GOTY Engine.dll and Actor.uc embedded
in Engine.u. This contract is recorded before extending the control natives.
`native-animation-oracle.py` executes the complete original exec bodies and
original mesh sequence lookup (`0x1031c000`). Parameter evaluation, warning
output and CRT double sqrt are explicit external leaves; animation arithmetic,
branches, flag writes and replication fields execute unchanged.

| Native | Index | Original body |
| --- | ---: | --- |
| PlayAnim | 259 | `0x103e0160` |
| LoopAnim | 260 | `0x103e05e0` |
| TweenAnim | 294 | `0x103e0bd0` |

Each evaluates its declared arguments in order, advances past EndFunctionParms,
then checks Mesh and searches its sequence table by FName. Missing mesh/sequence
logs and preserves all actor fields. Optional Play/Loop Rate defaults to 1,
TweenTime to -1, and Loop MinRate to 0, including EX_Nothing holes.

## Correction to the earlier PlayAnim transcription

The previous implementation misread x87 reverse-division instructions and
omitted the division before AnimLast. Direct original execution establishes:

* `AnimLast = f32(1 - 1 / NumFrames)`, not `1 - NumFrames`.
* Tween start is `f32(-1 / NumFrames)`.
* Positive tween time sets `TweenRate = f32(1 / (NumFrames * TweenTime))`;
  the single-frame branch uses `1 / TweenTime`.
* Automatic tween with zero OldAnimRate uses `1 / (0.025 * NumFrames)`.
* Play clears flag bits `0x38`, preserving bStatic (`0x01`).
* Play's SimAnim equality check also treats unordered as equal (x87 C3).
  All four components must compare equal or unordered to increment .last.
* The velocity norm is not rounded to float32 before multiplying OldAnimRate.

The first original reference, `PlayAnim('HitTorso',,0.1)` on a fresh actor with
the four-frame/rate-10 sequence, returns AnimFrame=0.001, AnimRate=2.5,
AnimLast=0.75 and SimAnim=(10,12500,0,7500). A four-frame TweenAnim with Time=0.5
returns AnimFrame=-0.25 and TweenRate=0.5. Prior self-tests asserting AnimLast=-3
or reciprocal tween values were not original-game evidence and must change.

## Shared start/tween path

Play and a restarted Loop set sequence, `f32(Rate * sequence.Rate / NumFrames)`
and AnimLast. With no previous sequence, TweenTime becomes zero. Flags clear
finished/notify; notify reflects sequence.Notify.Num, Loop sets the loop bit and
Play clears it. A single-frame sequence clears notify, AnimMinRate and
OldAnimRate, sets AnimRate=0, starts at -1 and uses positive-time reciprocal or
TweenRate=10. Otherwise positive time uses the reciprocal above; time equal to
-1 (also unordered under x87 C3) uses automatic tween: positive OldAnimRate,
or max(-OldAnimRate * |Velocity|, AnimRate * 0.5) for negative/unordered old rate,
or the zero-old-rate reciprocal. Other time values start immediately with
TweenRate=0, frame=0.001 for Play and 0.0001 for Loop.

SimAnim stores frame*10000, rate*5000 (clamped only above to 32767), tween*1000
and AnimLast*10000 for Play / *-10000 for Loop. OldAnimRate copies AnimRate.
The comparison increment described above is specific to Play's path; a new Loop
does not compare the previous SimAnim.

## Loop continuation

If the same non-None sequence is already looping and active (ordered nonzero
AnimRate for nonnegative frame, TweenRate otherwise), Loop preserves frame,
TweenRate, AnimLast and notify. It clears only bAnimFinished and updates AnimRate,
AnimMinRate and OldAnimRate. MinRate is zero for zero/unordered input; otherwise
it is `f32(sequence.Rate / NumFrames * MinRate)` on both start and continuation.

Continuation only writes SimAnim.rate and .last; its rate is **not clamped**.
Its last value uses `f32((1 - 1 / NumFrames) * -10000)` before any AnimLast
rounding. If every old/new SimAnim component compares equal or unordered, this
path adds one to .last. A stopped same sequence takes the full restart path.

## TweenAnim

Set the requested sequence, clear `0x38`, zero AnimLast/AnimMinRate/AnimRate/
OldAnimRate. Positive Time sets the reciprocal tween rate and -1/NumFrames start;
zero/negative/unordered Time sets both frame and TweenRate to zero. SimAnim gets
frame*10000, rate=0, tween*1000, last=0, with no comparison increment.

## IsAnimating

`AActor::execIsAnimating` (282, `0x103e15c0`) returns 0 for a None
AnimSequence (+0x54). Otherwise it compares AnimFrame (+0x58) with float 0.0:
below or unordered (C0) tests TweenRate (+0x60), else AnimRate (+0x5c), each
against double 0.0, and "equal or unordered" (C3) is not animating. So a
sequence that is tweening in is animating. The first translation had the
tween branch inverted (`TweenRate == 0`): `LoopBaseConvoAnim`'s
`if (!IsAnimating()) LoopAnim('BreatheLight')` then replaced every
conversation gesture in the tick that started it, and Pawn.Landed played
`PlayLanded` over startup idles. `isAnimating` in play-anim.mjs is the
translation; validate-animation-controls runs the original body on 15 cases
(tweens, both boundaries, signed zeros, denormals, NaN in each field) and
checks its verdicts, its untouched actor storage and its P_FINISH.

## Integration boundary

Control calls must read/write the linked Actor animation booleans and SimAnim
Plane, not a private flag copy invisible to UnrealScript. The original metadata
provides offsets/masks: +28 bits 08/10/20, and Plane +22c..238 (X/Y/Z/W). Flags
outside this set survive. These calls do not advance animation time or render
geometry. The subsequent [animation tick](script-animation-tick.md) implements
the original main/blend phases and notify/AnimEnd dispatch; world scheduling,
network reception and final vertex interpolation remain separate work.

## Reference and integration results

37 original exec cases compare every actor-storage byte through +23f (with NaN
payload/sign normalized only where the JS number representation cannot retain
them), argument-evaluation order, final bytecode cursor and warning gates.
Original GM_Trench sequence records drive single/multiframe, notify, optional
hole, automatic/explicit tween, velocity clamp, repeated-loop, rate-clamp and
SimAnim comparison branches. They pass the JavaScript translations.

The focused Play check executes original ScriptedPawn.LoopAnimPivot,
TweenAnimPivot and PlayAnimPivot bytecode on Training's JaimeReyes0 using his
GM_Trench_F mesh. It verifies loop continuation, positive tweening, PrePivotTime,
the metadata's +28 masks and +22c Plane layout, and script-visible flags/SimAnim.
The corrected HitTorso setup now lets native FinishAnim install latent action
181. The subsequent tick integration advances tween and animation, sets the
finished flag and releases the wait through ProcessState; the check no longer
sets bAnimFinished manually to complete the wait.

No NPC state startup or world-wide animation scheduling is enabled by these
helper calls. The animation phase is exposed separately for admitted actor ticks.

Focused regression checks pass for the 13 animation/FinishAnim unit cases,
Training's light-switch/TriggerLight route, general Frob, both damage-trigger
routes, the browser health/compass/InfoLink/reset scenario and the production
build. Damage-route references now use the same verified -0.25/2.5/0.75 tween
state instead of the earlier erroneous -4/0.4/-3 values.
