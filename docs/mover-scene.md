# Composed moving-door scene comparison

This validator uses the nine existing Training DeusExMover16/17 geometry and
movement cases from the original mover-move capture. The legacy native source
pawn was an uncontrolled Pawn. A new subclass of its oracle now supplies the
actual controlled PlayerPawn class ancestry, nonnull native Player pointer at
+0x5d4, and bIsPlayer flag at+0x318, with sufficient native actor storage. It
captures those nine original scenes again before the controlled-player runtime
comparison. No original movement or geometry response is substituted.

Original Native.MoveActor executes mover CheckEncroachment, real hash/bounds/
point queries, nested original moveSmooth/MoveActor, all nested world/owned-brush
and cylinder collision, hash updates, and native movement decisions. Script
EncroachingOn uses the case's explicit rejection reply; other script bodies and
SetActorZone remain controlled callback boundaries. The original mover call
stops after its pose/hash commit, before its own postcommit Bump/touch/zone
work. Nested pawn calls do complete their postcommit work.

JavaScript composes createLevelQueries, actorEncroachmentCheck,
moveTranslatingMover, moveSmooth, playerMove, and shared Touch helpers against
the same world/brush geometry and stable actor identities. Every query result,
pawn displacement and movement result comes from these runtime helpers; none
is replayed from the expected capture. Event and zone bodies use the same
explicit boundaries as the native fixture.

All nine freshly captured controlled-player cases match exactly: final return,
mover and every actor position, ordered queries and their returned actor lists,
moveSmooth entry vectors and mover poses, positionAfter each smooth call,
ordered nested/source hash removals and additions, script event order, and zone
boundaries. Cases include zero/tiny movement, positive and negative translation,
large lateral moves, explicit script rejection, and a pawn positioned away from
the moving brush. Shared Touch helpers are wired, but this small all-blocking
fixture does not itself exercise a new trigger Touch event; that is covered by
the separate FarMove scene corpus.

```sh
node scripts/validate-native-mover-scene.mjs --capture-only
node scripts/validate-native-mover-scene.mjs --reuse
```

The validator consumes the existing ignored mover-move scene/case files and
writes `controlled-original.json` plus `scene-comparison.json` beside them.
Scene/case SHA256 are checked against the new native capture, and comparison
records all three input hashes. The new oracle hashes Engine/Core/CRT via its
base harness. Legacy `original.json` and the shared oracle are unchanged.

This is the composed collision/movement prefix through mover commit, not full
DoorState/interpolation completion, FinishNotify, PawnList scheduling, arbitrary
script effects, based passengers, or blocking non-Pawn push acceptance. Those
remain separately evidenced integration dependencies.
