# Controlled-player MoveActor commit contract

Source-first scope: original Engine.MoveActor103990e0, movable controlled-player
cylinder, unchanged rotation, four movement flags0, no based passengers. Query
prefix and independently stored displacement come from move-query.mjs. Pawn
ancestry bypasses CheckEncroachment at10399bd7; this does not make FarMove's
separate CheckEncroachment branch optional. Static/not-movable rejection and tiny
all-component moves return before queries or scene work; a normal collision
that yields Time0 still performs pose/hash/callback work before returning false.

Commit10399c9a–10399d17: if current bCollideActors, remove from hash at old pose;
write Location as separately stored Location+adjustedDelta and unchanged requested
Rotation; if current bCollideActors, add at committed pose. Then:

1. If hit.Actor is world LevelInfo, source.BumpWall(hit.Location,hit.Normal).
   If another actor and source is not based on it, hit.Actor.Bump(source) followed
   by source.Bump(hit.Actor). Dispatch is synchronous after hash insertion.
2. Unless no eligible candidate was scanned and source blocks actors AND players,
   scan original ordered MultiLineCheck records while raw candidate.Time is less
   than adjusted blocking hit.Time. Skip candidates based on source; default
   ignore-base flag is0. If !source.IsBlockedBy(candidate), BeginTouch(candidate).
3. Iterate source.Touching slots0..3, re-reading each slot. Nonnull entries with
   !source.IsOverlapping(other) call EndTouch(other,false).
4. level.SetActorZone(source,false,false), then return hit.Time>0.

The native 'eligible candidate scanned' local is set at10399683 for each
candidate not based on source, before its blocking classification, including the
selected blocking candidate. The scan is only entered when source flags&0x0e.
It must not be described merely as a nonblocking-hit flag. Touch candidates compare
against adjusted blocking Time, not its raw sweep Time. State-dependent callback
bodies remain explicit; a valid callback adapter cannot silently discard them.

API: `playerMove(source,delta,{worldActor,multiLineCheck,removeActor,addActor,
dispatch,isBlockedBy,isOverlapping,beginTouch,endTouch,setActorZone})` returns the
moveQuery result fields, with final `success` and the current post-event position.
`source` has controlledPlayer=true, position, integer rotation, radius, height,
flags (native collision bits), static/movable, base, standingCount0 and four
`touching` slots. It accepts unchanged rotation only; caller must use a separate
verified path for rotating actors or actors with based passengers.

Callbacks are synchronous. `dispatch(target,event,args)` receives BumpWall's
location/normal by value or Bump's original actor identity. `isBlockedBy(source,
other)` and `isOverlapping(source,other)` provide original native predicates.
`beginTouch(source,other)` and `endTouch(source,other,false)` own native touching
state and script callbacks. `setActorZone(source,false,false)` owns zone updates.
Hash callbacks operate on source's current pose, so remove sees old position and
add sees committed position. No callback has an empty default. Event bodies can
change state and the helper reads current flags/touching when the native path
would; body-specific side effects still need their own evidence.

Validation:30 original full MoveActor cases execute real Training world BSP,
both original door brushes, controlled-player class ancestry/non-null Player,
and controlled blocking/nonblocking cylinder fixtures. Original hash removal,
insertion, MultiLineCheck, IsBlockedBy, IsOverlapping and the final native return
execute; script dispatch, BeginTouch/EndTouch and SetActorZone remain explicitly
controlled boundaries. Cases cover tiny/static/nonmovable early exits, positive
and zero hit.Time, world BumpWall, actor/mover paired Bump, based-on-hit suppression,
nonblocking BeginTouch, EndTouch after original overlap checks, and collision-flag
variants. The initial24 reference cases were captured before helper translation;
6 final cases add base and flags. Four focused tests pass.

The validator replays original ordered query records and predicate outcomes to
compare helper pose, final Time/success, hash order, callback arguments and order.
This is an independently translated MoveActor composition comparison with
original geometry-derived inputs; it does not claim the supplied JavaScript
geometry, touching, script or zone adapters are all complete. Run
validate-native-mover-move.mjs first to generate the local original scene, then
`NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node
scripts/validate-native-player-move.mjs`. Captures stay in ignored
reports/movement/player-move. Native DLL hashes are embedded in capture results.
