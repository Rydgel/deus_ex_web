# Selected Training mover FinishNotify

Source-first: DeusExMover.uc142–203 first calls Mover.FinishNotify389–411.
When StandingCount>0, that superclass traverses Level.PawnList/NextPawn and for
Base==self calls StopWaiting, then clears SpecialGoal if self or myMarker, then
clears WaitingPawn if this pawn. A remaining WaitingPawn receives StopWaiting,
SpecialGoal cleanup and WaitingPawn=None. Reads occur after synchronous callbacks.
The second scan starts again at Level.PawnList; no array/hash sorting is equivalent
without establishing the actual linked-list order.

NumKeys>0 and MoverEncroachType3 enable the derived scan. It requests explicit
KeyPos[KeyNum]+BasePos and KeyRot[KeyNum]+BaseRot, not current accepted Location.
Engine execGetBoundingBox10301140→1036dea0 temporarily substitutes that pose,
selects Brush+178 before Mesh+174, and calls primitive vtable+5c at1036e054:
GetRenderBoundingBox. It restores pose1036e070–93 and returns bounds validity.
UModel.GetRenderBoundingBox103027b1→103f1190 with bExact=false branches103f11e4
to103f13c9 and transforms all eight primitive+28 bounds corners by ToWorld.
This matches collision bounds for this model/nonexact path by instruction evidence;
it is not an assumption that the two APIs are generally interchangeable.

center=(box1+box2)/2; area=box2-center; maxDist=VSize(area)+200. PawnList scan
requires VSize(pawn.Location-mover.Location)<maxDist+pawn.CollisionRadius, then
strict Z and X/Y expanded-box tests. The corner branch (both distances>=area)
requires VSize([distX-area.X,distY-area.Y,0])<MOVER.CollisionRadius, not pawn radius.
Every passing pawn receives EncroachedByMover(self) synchronously. Pawn.uc377
contains its empty declaration; recovered PlayerPawn/DeusExPlayer/Human do not
override it. JC's event is therefore an evidenced empty script body; arbitrary
pawn overrides and StopWaiting remain explicit dispatch dependencies.

## API and comparisons

`moverFinishBounds(model,owner,position,rotation)` implements that nonexact brush
render-bounds branch using the separately verified common corner translation.
`finishMoverNotify(mover,level,{dispatch,getBoundingBox})` expects camel-case fields
position/radius, standingCount/waitingPawn/marker, numKeys/encroachType/key,
basePosition/baseRotation, keyPositions/keyRotations. Level has live pawnList and
pawns have nextPawn, base, specialGoal, position, radius, height. Callbacks are
synchronous: dispatch(pawn,event,args), getBoundingBox(mover,false,position,rotation).
The bounds validity return is intentionally unused, as in source. Both list scans
read NextPawn after the event, preserving callback changes to list order.

The original execGetBoundingBox native wrapper and real UModel render method were
captured on the actual Training16/17 authored brushes at both key endpoints.
All four outputs match exactly, and original actor Location/Rotation are restored.
Argument evaluation opcodes are controlled harness boundaries; geometry and pose
substitution/restoration execute original instructions. Five original Core
execVSize10138d10 inputs compare exactly. The native computes (z*z+y*y)+x*x,
stores a double for appSqrt, then stores float output. The JS translation uses
that operation order; exhaustive adversarial extended-precision midpoint coverage
is not claimed. Two source-contract tests cover strict boundary/corner predicates
and superclass/derived event order. Full original FinishNotify bytecode execution
and arbitrary AI event bodies are not claimed by these captures.

Run `NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node
scripts/validate-native-mover-finish.mjs` after the existing mover-move scene
fixture has been produced; `node --test test/mover-finish.test.mjs` runs focused
contracts. Captures stay in ignored reports/movement/mover-finish.
