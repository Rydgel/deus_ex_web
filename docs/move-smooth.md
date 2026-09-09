# Original moveSmooth

Source-first: Engine.AActor.moveSmooth103c9020–103c92aa. Calls original
MoveActor(delta,actor.Rotation,hit,0,0,0,0), saving its return bool. If hit.Time>=1,
return that bool. Otherwise calculate slide=(delta-normal*dot(delta,normal))*(1-Time).
The dot adds Z product, Y product, X product. Y/Z normal projections and differences
are stored float32; X projection/difference stay x87 until final slide output.
Y/Z final slide components store float32, while X retains its intermediate precision
for the dot(delta,slide) progress test. If progress<0 stop (zero still proceeds).
Save first normal; SafeNormal(original delta) supplies DesiredDir. Call second
MoveActor(slide,current actor.Rotation,...). If its hit.Time<1, dispatch script
HitWall(secondNormal,secondActor) directly, call original TwoWallAdjust with
DesiredDir,slide,secondNormal,firstNormal,secondTime, then third MoveActor.
Return the first MoveActor bool, regardless of subsequent moves. It does not
invoke processHitWall or stepUp. The move callback must commit position/hash and
post-commit effects; returned hit.Time and MoveActor bool are different values.

Post-commit MoveActor audit (research, not implementation): source10399d17 onward.
For world hit actor, dispatch source.BumpWall(Hit.Location,Hit.Normal) at10399e62;
for another actor, if source is not based on hit actor, dispatch hit.Bump(source)
then source.Bump(hit),10399e3f/10399e62. These are not native processHitWall.
Then ordered trace candidates earlier than blocking hit.Time can BeginTouch if
not based on source, not skipped by ignore-base flag, and !IsBlockedBy; this pass
is skipped in the ordinary both-block-flags case when no nonblocking hit was seen.
Four existing Touching slots are checked with IsOverlapping; separated entries
EndTouch(other,false). Finally level.SetActorZone(actor,test,0) at10399f0f.
Healthy JC PlayerWalking ignores Bump via its state mask, but state handling must
be established; BumpWall's inherited declaration is empty. Training mover moves
skip the sweep entirely and therefore have no sweep-hit Bump/BumpWall; existing
Touching cleanup and SetActorZone still remain. Direct encroachment notifications
are separate. Mover.Bump and TriggerToggle state effects must never be inferred
empty for actor-to-mover collisions.

API: `moveSmooth(actor,delta,{moveActor,dispatch})`, with actor.rotation using
integer native units. `moveActor(actor,delta,currentRotation,[0,0,0,0])` returns
`{result,time,normal,actor}`. Adapt the movement-query helper's `success` field to
`result`, including any subsequent scene rejection; it is not inferred from Time.
`dispatch(actor,'HitWall',[normal,other])` is synchronous and by-value for normal.
An event can change actor.rotation; the third MoveActor uses the changed rotation.

Original controlled captures preceded translation. Validation passes97 exact
cases covering planar/nonplanar and zero deltas, first-hit time0/.25/1,
first-call success/failure independent of later calls, orthogonal/angled normals,
direct event and event-induced rotation change. Four tests pass. With `--map`,
the validator additionally captures moveSmooth inside the original Training
mover harness: actual original brush/hash/world queries and nested MoveActor,
with script/zone boundaries kept explicit. Eight observed map moveSmooth calls
also match replay exactly, for105 total comparisons. Regenerate the map scene
first with validate-native-mover-move.mjs, then run
`NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node
scripts/validate-native-move-smooth.mjs --map`.

These comparisons validate moveSmooth's orchestration/math given MoveActor
responses. The map responses come from original geometry, but replay does not
claim that a JavaScript scene adapter has yet reproduced all post-commit effects.
The current map samples all complete their first nested MoveActor; slide and
second-hit event branches are established by the controlled native matrix, not
by those map samples. Dynamic actor contacts and callbacks that alter physics,
base or zone remain integration work even though the helper's numerical branches
are verified.
