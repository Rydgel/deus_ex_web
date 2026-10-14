# Translating mover movement

Original source-first contract: Engine.MoveActor103990e0, CheckEncroachment
1039a350, AActor.moveSmooth103c9020; Mover.EncroachingOn584–651 and
DeusExMover.FinishNotify142–203. Scope: movable translating brush, unchanged
rotation, default movement flags, no based passengers, no collision with world,
blocking ordinary pawn cylinder; TriggerToggle Training pair IgnoreWhenEncroach3.

MoveActor rejects static/not-bMovable actors and returns early for unchanged
rotation and every absolute delta component below double0.0001. A moving brush
bypasses cylinder MultiLineCheck at1039943a. Proposed position is three separately
stored float32(Location+delta) components. Based actors would move first in level
array order (103998a0–10399bb5); this remains an explicit unsupported prerequisite.
Before committing the mover, CheckEncroachment queries the hash's original
ActorEncroachmentCheck virtual+1c at proposed position/rotation, extra0.

It keeps that initial result list for subsequent passes. For a blocking pawn,
1039a53a–577 calls pawn.moveSmooth(float32(proposed-old)); the return value does
not establish clearance. A second ActorEncroachmentCheck searches for the same
pawn identity. If absent, continue. If still present,1039a6f6–773 saves mover
Location, writes proposed Location without rehashing, calls pawn.moveSmooth of
componentwise negated delta (float constant104298f0=-1), and restores saved mover
Location. This is a collision move, not restoration of a saved pawn position.
Then mover.EncroachingOn(pawn) runs; true rejects immediately before mover pose
or hash commit. Pawn movement already performed is not rolled back by a snapshot.
False continues through the original list. After that pass, each original
blocking candidate receives EncroachedBy(mover), even if pushed clear. Nonblocking
Touch/EndTouch branches are controlled by notify; MoveActor uses notify0.

Only after CheckEncroachment allows movement: remove mover from hash at old
pose10399cb4, write Location/Rotation10399cb6–cf7, add mover at newpose10399d14.
Later MoveActor Bump/touch/SetActorZone effects remain caller responsibilities.
World BSP is not a sweep obstacle for this brush path. Other moving brushes
are skipped when the source does not collide with world; general actor class
blocking categories must not be guessed from a cylinder shape.

IgnoreWhenEncroach is not a universal empty callback. Mover.EncroachingOn can
crush Decoration/Carcass, destroy Fragment, damage through EncroachDamage, call
Bump via PlayerBumpEvent and UnderLift via MyMarker before its final false return.
DeusExMover.FinishNotify later separately scans nearby pawns and calls
EncroachedByMover; that is not CheckEncroachment's EncroachedBy event.

The initial native capture executed original MoveActor, original hash query,
original brush/cylinder point geometry, original moveSmooth and nested pawn
MoveActor. It showed push/requery/reverse/event/commit order with the real
Training brush and overlapping pawn. Script dispatch and SetActorZone are explicit
controlled boundaries; the outer call stops after original pose/hash commit.
No fake overlap list, fake moveSmooth or translated pawn displacement supplies
these original reference results. The harness repairs the fixture's class chain
Mover→Brush→Actor and supplies bMovable; without these native fields it would
silently miss the intended moving-brush branch.

`moveTranslatingMover(mover,delta,{encroachmentCheck,moveSmooth,dispatch,
removeActor,addActor})` implements the verified orchestration through pose/hash
commit. `encroachmentCheck(mover,proposed,rotation,0)` returns ordered actor
identities. `moveSmooth(actor,delta)` must commit that actor's original movement
and hash updates synchronously, including callbacks. `dispatch(target,event,args)`
returns the EncroachingOn bool when appropriate. None has a default no-op.
Mover fields: movingBrush,movable,static,collideWorld,collideActors,blockPlayers,
blockActors,standingCount,position,rotation. Candidate fields: world,movingBrush,
isPawn,controlledPlayer,collideWorld. Unknown actor ancestry, source collideWorld
and based passengers throw before the helper tries an unsupported branch.

Nine captured original cases and four focused tests pass. The validator constructs
actual Training brushes from original assets, adds a controlled pawn, and executes
original geometry for tiny/no-op, overlap, horizontal/vertical displacement,
clearance and controlled EncroachingOn rejection. It then replays only the captured
query/moveSmooth boundary outputs to compare the independent orchestration's
calls, event order, temporary mover pose, final actor poses and hash order. This
is not yet a composed JavaScript geometry/moveSmooth fidelity test. Captures are
under ignored reports/movement/mover-move; regenerate with
`NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node
scripts/validate-native-mover-move.mjs`.

Remaining actionable integration prerequisites: original runtime
ActorEncroachmentCheck query; original moveSmooth (103c9020) first MoveActor,
slide projection, optional second-hit direct HitWall event, TwoWallAdjust and
third MoveActor; based passenger movement; script effects described above;
post-commit Bump/touch/SetActorZone; finish-time EncroachedByMover. In particular,
moveSmooth's second-hit HitWall event103c9230 is direct script dispatch, not the
separate native processHitWall gate. It returns the first MoveActor bool even
when later sliding moves occur. These are required before calling full mover
integration complete; substituting moveQuery once for moveSmooth is insufficient.

Update: the pushed actor's `moveSmooth` is no longer limited to Pawns; any
blocking non-Brush hit is pushed through its own MoveActor
([mover-push](mover-push.md)).
