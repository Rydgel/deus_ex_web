# Original AActor::execPlayAnim (native 259)

The complete control contract, including LoopAnim and TweenAnim, is maintained
in [script-animation-controls.md](script-animation-controls.md). The current
translation is compared by executing the original GOTY Engine.dll; the earlier
assembly-only transcription in this document contained reciprocal errors.

## Original authority

Engine.dll SHA-256:
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`.
The exported thunk `0x103011b8` jumps to `0x103e0160`. Original mesh sequence
lookup at vtable +68 runs the linear 32-byte-record scan at `0x1031c000`.
The native evaluates Sequence, optional Rate=1 and TweenTime=-1 before checking
Mesh and looking up the sequence by FName. Missing optional arguments preserve
those defaults even when a later argument is supplied.

Original `FDIVR` at `0x103e0221` computes 1/NumFrames, then `FSUBR` at
`0x103e0227` computes 1 minus that reciprocal. The earlier omission of FDIVR
produced an incorrect negative AnimLast and prevented valid FinishAnim waits.
The same reverse-division mistake affected tween starts and tween rates.
Original execution now establishes all those paths; self-tests using the old
formulas have been corrected. The flag mask is `0xc7`, preserving bStatic while
clearing animation bits `0x38`.

## Current Play integration

`ScriptRuntime` prepares each mesh on the shared class-loader record and archive.
GM_Trench has 366 frames of 339 vertices and 71 sequences. HitTorso starts at
frame 71 with four frames at rate 10; HitLegLeft starts at 79 with four at 10.
`PlayAnim('HitTorso',,0.1)` on a fresh actor writes AnimFrame=0.001,
AnimRate=2.5, TweenRate=0, AnimLast=0.75 and OldAnimRate=2.5. With a previous
sequence, positive TweenTime=0.1 instead starts at -0.25 with TweenRate=2.5.

The control view reads/writes linked Actor animation booleans and the original
SimAnim Plane. It no longer keeps a private flag/SimAnim copy on the actor.
The selected light-switch Frob route calls native PlayAnim over its original
single-frame Off/On sequences; player hit animations share the same service.

`native-animation-oracle.py` and `validate-animation-controls.mjs` compare the
full actor storage and control-flow boundaries for PlayAnim/LoopAnim/TweenAnim.
`validate-gm-trench-play-anim.mjs` also executes original ScriptedPawn pivot
helper bytecode on Training's JaimeReyes0, checks linked flags/Plane fields and
verifies FinishAnim's pending action/poll boundary. `validate-script-lights.mjs`
checks the live LightSwitch route and original Frob/TriggerLight fanout.

The complete mesh payload, native loading and original vertex unpack are
separately documented in [script-mesh-payload.md](script-mesh-payload.md) and
[script-mesh-load-graph.md](script-mesh-load-graph.md). The subsequent
[animation tick](script-animation-tick.md) implements main/blend advancement
and notify/AnimEnd dispatch. World scheduling, interpolation and mesh rendering
remain open; successful control calls do not establish animated visual playback.
