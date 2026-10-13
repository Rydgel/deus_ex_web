# Training TriggerToggle scheduling

Original source-first scope: two translating Training TriggerToggle panels,
DelayTime0, bTriggerOnceOnlyfalse, no Event targets. The caller still owns Frob
permission/lock/one-way/inventory gates and native actor tick ordering.

DeusExMover.Frob656–664 invokes inherited Frob, selected.Trigger(Frobber,P),
then AllActors(DeusExMover,Tag) in original actor-array order, excluding selected;
linked panels receive Trigger directly rather than their Frob gates. Empty/default
DeusExMover tags do not fan out. DeusExMover.TriggerToggle.Trigger703 rejects
bDestroyed; inherited Mover.TriggerToggle.Trigger744 assigns SavedTrigger and
Instigator, calls SavedTrigger.BeginEvent, and GotoState's Open label when
KeyNum==0 or KeyNum<PrevKeyNum, Close otherwise. Trigger does not call DoOpen.
Two frobs before the mover's next ProcessState therefore both select Open when
its native key fields are still closed; immediate interpolation would incorrectly
turn the second frob into a Close. Retriggering replaces the latent continuation.

Core.GotoState1012e937 clears FStateFrame.LatentAction; GotoLabel1012eb10 clears
it again and sets Code to the resolved label (1012eb7d), without executing the
label's statements. AActor.Tick dispatches ordinary Tick at103a268d when probed,
then ProcessState103a2698, timers/lifespan, then performPhysics103a276d. Thus an
input-triggered label starts when that mover's ProcessState next runs. Whether
that is later in the same world tick or next tick depends on original actor order
and when the frob happened; a global after-input door update is not that contract.

With DelayTime0, ProcessState executes DoOpen immediately on its next call:
bOpeningtrue,bDelayingfalse,InterpolateTo(1,MoveTime),opening sound,AmbientSound.
Then FinishInterpolation native301 (103dfff0) advances over EndFunctionParms and
unconditionally installs latent302, so ProcessState stops on that call even if
bInterpolating is already false. ProcessState103e5bfb–103e5c16 polls existing
latent actions before normal statements. PollFinishInterpolation103e0100 clears
302 only when actor+1ec bit0x80 (bInterpolating) is clear; after clearing, the same
ProcessState call continues FinishedOpening.

physMovingBrush clears bInterpolating at103de9d1 and calls InterpolateEnd during
physics. Mover.InterpolateEnd353–384 updates PrevKeyNum,PhysAlpha,ClientUpdate,
AmbientSound and RealPosition/RealRotation as appropriate. It does not resume the
latent state. FinishedOpening occurs on the next ProcessState after that physics
completion: opened sound, FinishNotify, then SavedTrigger.EndEvent, then Stop.
SavedTrigger/Instigator remain assigned on the open path. The Close label similarly
calls DoClose (key=max(0,KeyNum-1)), waits latent302, then FinishedClosing: closed
sound, SavedTrigger.EndEvent, SavedTrigger=None,Instigator=None,FinishNotify.
FinishedClosing falls off the state code. No Toggle timer closes the door.

Audio, FinishNotify (including DeusExMover's EncroachedByMover scan), interpolation
replication fields and external BeginEvent/EndEvent script bodies are explicit
callbacks; they must retain this order even when an implementation is unsupported.

## Integration API and validation

`createDoorState(interpolation,values)` holds the state frame separately from the
existing interpolation fields. Supply decoded/default-resolved MoveTime, Tag,
MoveAmbientSound and scope flags. `triggerDoorState(door,other,instigator,callbacks)`
is the original selected Trigger body. `triggerFrobbedDoor` additionally dispatches
to an already filtered AllActors(DeusExMover,Tag) list in its original order, after
caller-owned Frob gates and inherited Frob have completed. It does not discover
actors or implement permission gates.

Call `processDoorState(door,callbacks)` once at the mover's actual ProcessState
phase, before moving-brush physics. Required callbacks are `interpolateTo(door,key,
seconds)`, `playSound(door,propertyName)`, `finishNotify(door)`, and
`dispatch(actor,event,args)`. InterpolateTo must include the original replication
and physics bookkeeping in addition to the independently recovered interpolation
math. Sound property names denote the source statements, including their original
volume/radius arithmetic; this helper does not implement audio. InterpolateEnd
remains the physics completion callback and must clear ambient sound and update
replication fields itself. The helper's `ambientSound` is the script assignment,
so callers must synchronize it with actor state.

Reentrant callback state changes are explicitly rejected. Nonzero delay,
TriggerOnceOnly and Event targets are unsupported. Generic Frob, arbitrary state
bytecode, full-world actor/input tick ordering and whole-game scheduling remain
outside this bounded translation. In particular, this helper does not establish
when browser input should enter the original world's actor tick order.

`scripts/native-door-state-oracle.py` executes the original GotoLabel1012eb10,
ProcessState103e5b60, FinishInterpolation103dfff0 and polling103e0100 against
controlled actor/state-frame fixtures. Synthetic opcode bindings stand in for
DoOpen/DoClose/completion bodies, and a controlled physics-end boundary clears the
source-verified interpolation bit. This is an original native scheduler capture,
not execution of the full original TriggerToggle bytecode or original actor Tick.
Two captured sequences (13 phase observations) compare exactly, including repeated
Open labels and replacement of a pending opening completion by Close. Source
statements establish event order; five focused tests preserve that translation.

Run `NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node
scripts/validate-native-door-state.mjs` and `node --test test/door-state.test.mjs`.
Ignored captures are in `reports/movement/door-state`; original binary hashes are
included in the comparison report. These results do not establish full Stage2
completion or full-game door sound/notification fidelity.

## Selected mover / JC tick and press-command order

Original UGameEngine.LoadMap stable-partitions actors after startup: static actors
are copied in ascending old-array order1038dd49–1038dda3; Level.FirstDynamicActor
(+110) is stored1038ddb0; nonstatic actors are then copied in ascending order
1038ddb6–1038de0a. The selected Training16/17 are nonstatic, have no Owner or Base,
and retain their relative order. Dynamic SpawnActor appends the later local JC
(103951bc–10395222; see zone.md). ULevel.Tick103a51a0 iterates from FirstDynamicActor
at103a56a0, skips nulls and calls Actor.Tick vtable+64 at103a56c2, increments
103a56ca and reloads the array/count. Therefore the selected loaded movers run
before the spawned JC in this bounded scene. AActor.Tick can defer an actor whose
Owner(+3c) has not ticked (103a1b05–103a1b67); the selected movers have no such
owner dependency. Arbitrary ownership/stasis/network scheduling is not implied.

The ordinary local PlayerPawn branch of Actor.Tick calls viewport.ReadInput(dt)
103a25b4, PlayerInput(dt)103a25d9 (name global1058368c), PlayerTick(dt)103a25fd
(global105836b4), viewport.ReadInput(-1)103a260d, then ProcessState103a2698.
DeusExPlayer.PlayerWalking.PlayerTick3674–3712 performs HighlightCenterObject,
then increments FrobTime, then calls Super.PlayerTick. PlayerPawn's inherited
PlayerWalking.PlayerTick3605–3611 calls PlayerMove. PlayerMove contains GetAxes,
CheckBob, UpdateRotation and ProcessMove. Thus cached targeting precedes that
movement; it must not be refreshed eagerly by the use command.

Frob is a separate synchronous input execution path. Original DefUser.ini/User.ini
bind RightMouse=ParseRightClick (F is CenterView; browser F-for-use is a host binding).
UEngine.InputEvent103814e0 calls UInput.PreProcess at10381672 and, when accepted,
UInput.Process at10381698. Process10394410 writes Action/Delta10394493–99, then
calls ExecInputCommands103944b6 before clearing those fields. ExecInputCommands
10393bf0 parses command lines and routes Press(action1) immediately to viewport
Exec10393c90–a1. Non-press Hold(action2) uses the input-only Exec path10393c81–8c;
it does not repeatedly call ParseRightClick. The selected ParseRightClick branch
calls DoFrob(Self,None) at source4544, and DoFrob calls cached FrobTarget.Frob4778.
No native/script queue delays this command until PlayerTick or ProcessState.

UViewport.ReadInput10374990 also invokes viewport vtable+7c at103749ef for positive
dt, before UInput.ReadInput at10374a03. Platform input polling is consequently an
additional input-delivery boundary inside JC's tick; UInput.ReadInput itself
replays held keys(action2) at10394772–81. This trace does not claim equivalence
between Windows event/poll timing and browser DOM event timing.

Concrete bounded integration: keep selected doors' ProcessState→physics before
JC's target-update/movement phase. Execute each accepted browser use press once
at its arrival boundary against the already cached target, changing only the
state label/latent continuation; do not call DoOpen immediately and do not force
all use commands into PlayerTick. A press delivered between world ticks can start
on the next door phase. A press delivered during JC's input-read phase comes
after that tick's mover phase and starts on the following one. Multiple presses
before the same mover phase remain multiple synchronous Trigger calls (including
the evidenced repeated-Open case). These are source/instruction scheduling
contracts; exact cross-platform wall-clock input latency is not claimed.

## GotoState from script: the same state runs GotoLabel only (2026-10-13)

Question (the club-door divergence work, [visual acceptance](visual-acceptance.md)): does `GotoState('TriggerOpenTimed', 'Open')`,
issued while the mover is already in `TriggerOpenTimed`, recompute the StateFrame's ProbeMask, as `UObject::GotoState` (Core `0x1012e8f0`)
does at `0x1012ea1f` for any state it is given, the one it is already in included?

Answer, from the original's own code (`scripts/native-goto-state-oracle.py`: Core's GotoState, execGotoState and GotoLabel execute
unchanged under Unicorn over a fabricated frame and two states with label tables; FindState is the one explicit boundary):

* **The script native (113, `execGotoState` `0x1013dd00`)** reads NewState (default: the current state's name) and Label (default None, which
  GotoLabel reads as `Begin`, name index `0x64`). When the state named is the one the object is in, `0x1013dd86` skips `GotoState` and calls
  `GotoLabel` only: the ProbeMask is kept (a `Disable('Trigger')` stays in force), LatentAction is cleared, Code is the label's offset
  (None when the label is missing) and the Node is the node holding the label. A different state calls `GotoState` (ProbeMask =
  `(class | state) & state ignore`, Code cleared, flag `0x1000` set, EndState/BeginState events when probed) and then `GotoLabel`.
* **`UObject::GotoState` called directly** (native C++ callers; no script reaches it for the current state) recomputes the ProbeMask and clears
  Code for the same state too: `ScriptState.transition` is that body.

Play already did both (`ScriptRuntime.gotoState` short-circuits the same state to `gotoLabel`; `invokeNative` 113 supplies the defaults).
An attempt to reset the mask in the same-state script path, made from a reading of `0x1012ea1f` alone, broke the Underworld's TriadRedArrow
pawns at tick 72 and is exactly what `scripts/validate-native-goto-state.mjs` now rejects (2 direct-body cases and 5 exec cases against the
original; the earlier change fails `execNoParameters`).
