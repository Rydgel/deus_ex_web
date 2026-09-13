# Walking callback contract

Source-first trace, original Engine.dll:
SetSupportBase0x103c9390, SetBase0x10369c80, setPhysics0x103c95f0,
processHitWall0x103cecc0. Script evidence: Actor.SupportActor823–826,
Pawn.BaseChange813–830, DeusExMover.SupportActor322–345, Actor.HitWall803.

SetSupportBase(nonnull) dispatches **target.SupportActor(pawn)**. It does not
assign Base. Null calls SetBase(null,true). Default Actor.SupportActor calls
standingActor.SetBase(self). DeusExMover first applies stomp damage for incoming
Velocity.Z<-500, then calls SetBase if not destroyed, or Falling if destroyed.
Other cylinder classes must use their inherited/overridden SupportActor; geometry
shape alone does not identify this event behavior.

SetBase rejects a target Base chain containing self and returns on same Base.
Otherwise: old non-world base standing-count byte(+d8)--, old.Detach(self), write
Base(+c4), new non-world standing-count++, new.Attach(self), then self.BaseChange
if notify is true. World identity is actor.Level(+a8), not null. Counts wrap as
bytes. Old.Detach sees old Base; Attach and BaseChange see assigned Base.

setPhysics returns immediately if type unchanged (no base work). On change it
writes Physics(+30) first. Falling2 clears existing Base via SetBase(null,true).
Walking1 uses explicit different support via SetSupportBase, otherwise FindBase
when no support argument. FindBase uses SingleLineCheck trace0x17, extent cylinder,
start Location, end Z-8 (constant at1042b148), extra0; if hit actor differs from
Base and is not based on self, SetSupportBase(hit actor). Neither transition
zeros velocity/acceleration; zeroing in native setPhysics is only types0/5.
Neither helper alters hitSlopedWall, justTeleported, or bJustLanded.
The zeroing decision re-reads Physics after synchronous events: an event that
changes it to0/5 causes velocity and acceleration to be cleared. The8-unit
FindBase constant was read directly as float32 from the original DLL.

processHitWall103cecc0 has two source branches, selected by an inlined
this->IsA(APawn) at0x103ced17. Both first return when the wall actor IsA(Pawn)
(0x103cecf4). **Pawn source** (0x103ced3d): zero acceleration also returns.
Otherwise normalize Destination-Location using native SafeNormal; walking zeros
both direction.Z and supplied normal.Z for the remaining expression/event. If
dot(direction,normal)>MinHitWall, return. If HitWall is probed OR Physics==Falling,
dispatch HitWall(normal,wall). Otherwise set MoveTimer=-1 and bFromWall
(+318 mask100000). Thus even an empty HitWall script body does not justify
replacing all native bookkeeping with a no-op.

**Non-Pawn source** (0x103cee37, e.g. a falling DeusExDecoration): the entire
Pawn subtree — the zero-acceleration return, the SafeNormal/MinHitWall dot gate,
the walking normal.Z/direction.Z flatten, and the MoveTimer/bFromWall
bookkeeping — is skipped. The path is only: return for a Pawn wall, then
`if IsProbing(HitWall) dispatch HitWall(normal,wall)` with the normal unmodified.
It touches no other actor state.

The native entry's HitWall event is Actor's empty declaration in the recovered
JC ancestry. Runtime must still model native gates/bookkeeping and explicitly
establish inherited/event overrides before treating any script callback as empty.
BaseChange can cause stomp damage/jump-off for Pawn support and damage for hard
landing on Decoration. Mover Attach can activate StandOpenTimed. These callbacks
must not silently disappear in generic-cylinder/mover paths.

`src/runtime/walking-callbacks.mjs` supplies `setBase`, `setSupportBase`,
`setWalkingPhysics`, `processPlayerHitWall` (Pawn source) and
`processDecorationHitWall` (non-Pawn source). State uses numeric native
`physics`1/2, `base`/`worldActor` identity, actor `standingCount`, and pawn
`position`, `destination`, `acceleration`, `velocity`, `minHitWall`, `moveTimer`,
`pawnFlags`. `wall.isPawn` must come from decoded class ancestry. Native
`bFromWall` is pawnFlags mask0x100000, distinct from hitSlopedWall mask0x20.
No helper changes `justTeleported` or `bJustLanded`.
`processDecorationHitWall(source,normal,wall,{isProbing,dispatch})` is the whole
non-Pawn path: `if(wall.isPawn)return; if(isProbing(source,'HitWall'))dispatch(...)`.
The decoration-physics tick wires it (docs/script-plant-contact.md): `isProbing`
routes to the runtime's live state-frame probe mask and `dispatch` to ProcessEvent.

The mandatory synchronous `dispatch(target,event,args)` callback executes the
resolved script event, including its state-dependent overrides. It has no
default no-op. `isProbing(pawn,'HitWall')` supplies the current native/script
probe state. `setWalkingPhysics(pawn,next,support,{dispatch,findBase})` accepts
only Walking/Falling destinations; `findBase(pawn)` is required on a changed
transition to Walking with no explicit support. The query contract is above;
the helper deliberately leaves that uncaptured query to its supplied callback.
Collision response owns hitSlopedWall; physWalking clears justTeleported at its
substep-loop entry. Base changes neither replace that work nor clear these flags.

Validation: `NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node
scripts/validate-native-walking-callbacks.mjs` executes the hash-gated original
instructions and compares102 cases exactly. Pawn-source cases (54) cover
self/cycle rejection, same/different/world/null bases, both physics transitions,
SupportActor dispatch, Pawn-wall rejection, zero acceleration, direction gates,
probing, walking normal flattening, and Falling event dispatch. Non-Pawn-source
cases (48) drive the0x103cee37 branch through a self-contained source class with a
null SuperField, sweeping {Pawn/non-Pawn wall}×{probing on/off}×{PHYS_None/Falling/
Rolling}×four float32-exact normals: they confirm the wall-Pawn return, the
probe-gated unmodified dispatch, the absence of any MoveTimer/bFromWall/direction
bookkeeping, and (via the Physics sweep) that the non-Pawn path never reads Physics.
Original Pawn cases were captured before the helper was written; the final matrix
adds degenerate direction cases and the non-Pawn source sweep. Five focused tests
cover event-visible state and preservation of unrelated flags.
The native harness deliberately supplies controlled empty script callbacks and
probe answers: it validates native bookkeeping and call order, not the script
effects themselves. Mover damage/destruction, Pawn JumpOffPawn, Decoration damage,
stateful Attach, FindBase query execution, and whole-game callback observation
remain outside this bounded comparison. Callers must resolve or explicitly
reject those effects rather than treating the capture's empty events as gameplay.

Ordinary JC PlayerWalking **does not probe HitWall**. Original serialized masks:
JCDentonMale class ProbeMask=`f8040d02/00000800`; DeusExPlayer.PlayerWalking
ProbeMask=`01031800/00000020`, IgnoreMask=`ffffffff/ffffffff`. Core.GotoState
0x1012ea1f–0x1012ea47 writes `(class.ProbeMask | state.ProbeMask) & state.IgnoreMask`
into FStateFrame+1c/+20: `f9071d02/00000820`. Core.IsProbing0x10115670 tests
bit(nameIndex-300); HitWall name0x135 is bit9, which is clear. Actor's empty event
has no probe bit. The extracted ancestry contains no Enable('HitWall') call.
Thus the ordinary walking path takes MoveTimer/bFromWall bookkeeping when its
other gates pass; Falling still dispatches the empty inherited HitWall event.
