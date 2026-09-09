# Original relocation and stance contracts

Evidence recorded before translation: original Engine.dll FarMoveActor
`0x10398ba0`, SetCollisionSize `0x10369320`, MoveActor's return branch
`0x10399f48`–`0x10399f5f`, and embedded DeusExPlayer.SetBasedPawnSize.

FarMoveActor rejects a static or non-movable actor outside the editor, before
removing it from the collision hash. These are Actor boolean flags at +0x28
(bStatic=1, bMovable=0x80000), not UObject object flags. For accepted actors:

1. Remove a colliding actor from the existing hash before any query.
2. Unless noCheck, run FindSpot with the actor's cylinder extent and options0,0
   when bCollideWorld, or when bCollideWhenPlacing outside client NetMode3.
3. On fit success, when neither test nor noCheck, call CheckEncroachment with
   fitted position, current rotation, notify1. Encroachment rejects the move.
4. On success with test=false, detach actors based on this actor (Level.Actors
   order, gated by StandingCount) and set bJustTeleported. Both test modes then
   store fitted Location AND OldLocation. Thus the original test option still
   changes position; it is not an invented read-only test.
5. Reinsert a colliding actor regardless of success, using its then-current
   position. On success call SetActorZone(actor,test,0), after re-insertion.

The callback/order contract must be captured before connecting this to Play.
FindSpot, CheckEncroachment, SetBase and SetActorZone remain distinct routines;
an isolated relocation comparison cannot prove their scene effects.

SetCollisionSize unconditionally removes the actor from an existing hash if
bCollideActors, stores both requested floats, then reinserts it. It does not run
an overlap or fit test (`0x10369349`–`0x1036939b`).

Standalone SetBasedPawnSize clamps negative radius/height to zero, returns early
for unchanged dimensions, and forms centerDelta.Z=newHeight-oldHeight. Shrinking
sets collision size before Move(centerDelta), restoring old size if Move returns
false. Growing first calls Move with OLD size, then changes dimensions only on
success. Even a failed branch can retain a partial movement made by Move; there
is no script location rollback. On success it subtracts centerDelta from PrePivot,
sets BaseEyeHeight=newHeight-(GetDefaultCollisionHeight-Default.BaseEyeHeight),
and subtracts centerDelta.Z from EyeHeight. Carried decorations and multiplayer
branches require separate handling. A target-volume overlap shortcut does not
implement this original operation order.

Actor.Move returns ULevel.MoveActor's boolean. For a completed ordinary movement
the return is Hit.Time>0, not Hit.Time==1 (`0x10399f48`–`0x10399f5f`); tiny unchanged
translation/rotation returns true early. Scene rejection can return false before
the pose stores and must not be replaced by the final time predicate.

## Verified translation

`src/runtime/relocation.mjs` now supplies `farMoveActor(level,actor,destination,
test,noCheck)` and `setCollisionSize(level,actor,radius,height)`. Original native
entry-to-return captures match all 1,316 cases, including the ordered callback
arguments, actor position/OldLocation, dimensions, teleport flag, registration
state and child bases. The corpus varies static/movable/editor gates, collision
flags, test/noCheck, fit and encroachment outcomes, hash presence, client mode,
standing counts and negative resize arguments.

These are explicit scene callback fixtures. The original relocation and resize
instructions execute; FindSpot, CheckEncroachment, SetBase and SetActorZone are
controlled boundaries. This validates orchestration, not their combined geometry
or script effects. The helper supplies no invented fallback for these callbacks.
The actor uses `actorFlags` for +0x28, `flags` for +0x1dc and `motionFlags` for
+0x1ec. `level.hash` exposes removeActor/addActor with current bounds;
`level.findSpot(extent,position,0,0)` mutates its position argument and returns
the original boolean. Other callbacks retain the native argument order above.

Regenerate with `node scripts/validate-native-relocation.mjs`; `--reuse` compares
the ignored original capture. Four regression cases preserve the surprising
test-mode mutation, child detach order, failure reinsertion and unchecked native
resize behavior. Play integration of relocation is still awaiting the complete
encroachment and zone callback adapters.
