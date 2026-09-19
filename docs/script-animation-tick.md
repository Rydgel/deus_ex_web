# Original Actor animation tick

The authority is the hash-checked GOTY Engine.dll `AActor::Tick` body
`0x103a1aa0` and the embedded Engine.Actor declarations. This contract and the
original reference capture precede its JavaScript implementation.

`native-animation-tick-oracle.py` executes the unchanged animation instructions
from `0x103a1bf0` to `0x103a1fd2`, including the branch out to
`0x103a21bc..0x103a23c9`. The outer Tick admission and its simulated-pawn local
are supplied inputs. Original mesh sequence lookup executes at `0x1031c000`.
Core FindFunction/FindFunctionChecked, ProcessEvent callback effects and double
appSqrt are explicit service leaves. This is not a complete Actor.Tick oracle.
The AnimEnd global at `0x105836e0` is established by the original name initializer
at `0x10380169..0x1038017f` from the UTF-16 `AnimEnd` at `0x1047d8b8`, and is
also used by the exported eventAnimEnd wrapper at `0x10323470`.

## Main animation

The outer body determines simulated pawn from bIsPawn (+28 bit 800000), the
Pawn class ancestry and Role (+31) equal to ROLE_SimulatedProxy (2). Animation
precedes the later script Tick/ProcessState/timer/physics phases. The phase
initializes remaining time from DeltaSeconds and a shared iteration counter.

Each pass requires a non-None AnimSequence, ordered nonzero AnimRate for frame
>=0 (TweenRate for negative/unordered frame), positive ordered remaining time,
and the incremented iteration count <=4. Normal advancement stores
`f32(AnimFrame + remaining * AnimRate)`. A negative rate uses
`max(AnimMinRate, -AnimRate * sqrt(Velocity.SizeSquared()))`; sqrt returns double,
and the main path does not round the product before the clamp. Comparisons
retain x87 unordered branch semantics.

For bAnimNotify (+28 bit 20) and a non-null Mesh, find the current sequence and
scan its eight-byte time/FName records. Choose the earliest time crossed with
`oldFrame < time <= newFrame`. Replace the selected record only for a strictly
smaller distance; the stored comparison distance is float32. Equal-time records
in the reference case preserve the first record. Set remaining time to
`f32((newFrame-time)*remaining/(newFrame-oldFrame))` and frame to the notify time.
FindFunction(name,0) may return null; otherwise ProcessEvent executes. Both
paths restart the loop, rereading actor fields after the callback.

Without a crossed notify, stop main advancement below AnimLast. A looping
sequence (+28 bit 10) at/above AnimLast sets remaining time to zero while its
frame is below 1. At/above 1, preserve the proportion after the wrap and set
frame to zero. If oldFrame was below AnimLast, set bAnimFinished (+28 bit 08)
only when StateFrame.LatentAction is 181 (FinishAnim); then call checked AnimEnd
unless this is a simulated pawn. If oldFrame already passed AnimLast, wrapping
does not emit another AnimEnd.

A nonlooping sequence at/above AnimLast preserves the proportion after AnimLast,
clamps frame to AnimLast, clears AnimRate and sets bAnimFinished. AnimEnd runs
unless this is a simulated pawn. **After** the callback, RemoteRole <2 and
non-Weapon actors copy the current frame/rate to SimAnim.X/Y with scales
10000/5000 and only an upper rate clamp of 32767. Callback animation changes
therefore affect both this replication write and subsequent passes.

Negative frames tween by `frame + remaining*TweenRate`. The zero comparison
uses the unrounded intermediate, although frame storage is float32. On crossing
zero, calculate the remaining proportion, set frame to zero and restart. For
zero/unordered AnimRate, also set bAnimFinished and emit AnimEnd unless simulated
pawn. Tween completion does not perform the nonlooping SimAnim tail.

## Four blend slots

The original flow has a second loop, reached on main-loop exit. It repeats the
**main animation** activity/time gate and increments the **same** counter, then
visits slots 0..3. It returns to this gate after every pass. Consequently a
normal main update below AnimLast leaves time available for three blend passes.
This behavior is confirmed by original execution, not inferred from a preferred
engine design. A stopped main animation prevents blend advancement.

| Field | Actor offset | Stride |
| --- | --- | --- |
| BlendAnimSequence | 68 | 4 |
| BlendAnimFrame | 78 | 4 |
| BlendAnimRate | 88 | 4 |
| BlendTweenRate | 98 | 4 |
| BlendAnimLast | 23c | 4 |
| BlendAnimMinRate | 24c | 4 |
| OldBlendAnimRate | 25c | 4 |
| SimBlendAnim | 26c | 16 |

Each non-None blend below its last frame advances using the same remaining
time. Its velocity-scaled rate product **is** stored as float32 before the
minimum comparison. Completion updates the shared remaining time, clamps its
frame, clears its rate, and applies the same RemoteRole/Weapon replication gate
to SimBlendAnim.X/Y. Negative blend frames tween and update the shared remaining
time at zero. Blends do not emit notifies/AnimEnd or set bAnimFinished here.

## Original reference cases and scope

38 original cases were captured in ignored
`.cache/research/animation-tick-original.json`. They cover normal/tween/loop
progress, remainder and iteration limits, velocity scaling, actual GM_Trench
Walk's PlayFootStep notify, reordered/tied/missing callbacks, callback animation
mutations, simulated-pawn and replication gates, plus all blend branches above.
Every case records actor storage through +2ab, event order and event-time frame/
rate/flags, remaining-time bits, iteration count and callback count.

Examples: main frame .1/rate .5/delta .2 ends at .2; an identical blend ends at
.4 after three passes. A .8/rate .5/last .875 one-shot with delta .5 clamps to
.875, sets finished and dispatches AnimEnd once. A tween from -.5 at rate 2
with delta .4 then advances the main .5-rate animation to .075.

The phase does not establish world actor eligibility/order, Pawn state startup,
blend-control natives, network reception or final mesh interpolation/rendering.
Those remain separate original-evidence boundaries. No guessed idle state or
replacement NPC animation scheduler is implied by this component.

## Translation and runtime boundary

All 38 cases pass `src/runtime/animation-tick.mjs`, comparing the complete actor
storage range, event-time values/order, callbacks and loop accounting described
above. `ScriptRuntime.processActorAnimation` uses linked Actor fields, four
fixed-array blend views, the current StateFrame latent slot and actual linked
class ancestry. It looks up callbacks afresh and routes them through the
existing original ProcessEvent translation, preserving probe and state lookup
behavior. Missing prepared resources/functions remain explicit errors.

Training's JaimeReyes0 integration executes original PlayAnimPivot bytecode,
installs FinishAnim, advances the tween/HitTorso animation in two tick phases,
and releases latent 181 during ProcessState. It no longer writes a synthetic
finished flag. Original property offsets and four-slot dimensions are checked,
including a completion write to SimBlendAnim slot 2. Jaime's original
RemoteRole=2 correctly suppresses the main completion replication write.

This synchronous phase does not automatically enroll NPCs in the world's tick
list. The subsequent [standalone Actor.Tick](script-actor-tick.md) supplies
the outer per-actor gates and ordering. Event preparation, startup states,
world scheduling and reached native services remain requirements for wider
Play admission.
