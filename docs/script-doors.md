# Bytecode driven TriggerToggle doors

`createScriptDoors({assets,asset,movers,playerActor,level,callbacks})` loads the
original Engine and DeusEx classes, prepares the original `DeusExMover` and
`Mover` functions/states, and returns `{reset,use,tick,runtime}`. `use` receives
the mover selected by the caller and its already filtered like-tag group. It
does not perform Frob permission checks or discover linked actors.

`callbacks.playSound(view,propertyName,details)` is the audio boundary; `view`
contains the original mover at `view.actor`, and `details` retains the script's
sound, slot, volume, radius, and pitch arguments. `callbacks.dispatch(actor,
event,args)` is used only for native actor branches such as `StopWaiting`.
`callbacks.getBoundingBox(actor,exact,position,rotation)` is optional; when it
is omitted, the established `moverFinishBounds` implementation is used.

The supported records are the existing standalone two-key Training subset:
`InitialState=TriggerToggle`, `NumKeys=2`, a zero first key and translating
second key, zero key rotations, no slave/once-only/delay/event branch. The
adapter keeps each original actor identity and binds `Level`, `PawnList`,
`NextPawn`, movement fields, replication fields, and the mover's mutable
interpolation state through `ScriptRuntime.bindProperty`.

## Original execution order

The function bodies are loaded from the installed packages. The selected
`DeusExMover.TriggerToggle.Trigger` calls the inherited
`Mover.TriggerToggle.Trigger`; native 113 selects the same state's `Open` or
`Close` label. On the mover's next `tick`, `ScriptState.process` runs that label
before the timer phase and `tickMoverInterpolation` physics. `DoOpen`/`DoClose` call the
original `InterpolateTo`, sound remains an explicit callback, and native 301
installs latent 302. The following ProcessState phase polls 302 only after
`bInterpolating` is clear. The interpolation completion hook executes the
original `Mover.InterpolateEnd` bytecode, which owns `PrevKeyNum`, `PhysAlpha`,
`ClientUpdate`, `AmbientSound`, and real-position replication updates.

`FinishedOpening` and `FinishedClosing` then execute their original sound,
trigger-event, `FinishNotify`, and state-cleanup statements. The derived
`DeusExMover.FinishNotify` body calls the inherited body and reaches native 724
for the established nonexact brush bounds path; `getBoundingBox` may be
provided by the caller or the adapter uses `moverFinishBounds` on the existing
mover model. Native pawn event boundaries such as `StopWaiting` use
`callbacks.dispatch` when those source branches are reached.

The adapter binds native 264 (PlaySound), 301/302 (FinishInterpolation),
3970 (the selected
already active `PHYS_MovingBrush` mode), and 724 (GetBoundingBox). The common
runtime supplies GotoState, Sleep and SetTimer, while this adapter retains its zero-delay
scope. Play now supplies the complete [map actor array](script-map-actors.md),
including non-colliding actors and null slots, for native AllActors. Each map
export shares one live identity across tagged defaults, bytecode references and
enumeration. Other physics modes and unprepared state/event
branches fail explicitly. No script body is reimplemented in JavaScript.

The source contract is recorded in `Mover.uc` lines 309–342, 353–383,
389–445, and 448–474; `DeusExMover.uc` lines 148–203, 667–707; and the
original Engine.dll native traces for GotoLabel, FinishInterpolation,
PollFinishInterpolation, SetPhysics, PlaySound, and GetBoundingBox. The
focused bytecode linker/runtime check is `scripts/validate-script-runtime.mjs`;
whole-game scheduling and arbitrary actor lifetimes remain outside this adapter.

The Play integration passed actual Training targeted use, mid-move reversal,
opening/closing completion, closing contact that displaces JC, and Player start
reset. Native collision evidence is reused from Stage 2; these checks target the
new script/host connections. All attached actors retain their actual original
classes; attaching metadata alone does not enable their unprepared behavior.
