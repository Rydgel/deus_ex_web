# Original moving-brush blocking predicate

Source first: Engine IsBlockedBy1034c5e0, exported thunk10301785. World target
returns source bCollideWorld. Brush target is tested before source Brush:
source bCollideWorld AND target bBlockActors (the source is not PlayerPawn).
Otherwise source Brush requires target bCollideWorld AND source bBlockPlayers
if target GetPlayerPawn is nonnull, or source bBlockActors otherwise. Target
Pawn ancestry is not a prerequisite. Projectile does not choose bBlockPlayers
in this brush branch. GetPlayerPawn requires PlayerPawn ancestry AND nonnull
native player pointer+0x5d4. An uncontrolled PlayerPawn uses bBlockActors.

These rules do not imply that every blocking non-Pawn has a verified push
implementation. They do allow nonblocking triggers returned by the original
broadphase to be skipped without an unsupported-ancestry error.

`moverBlockedBy(source, other, worldActor=source.worldActor)` is exported from
check-encroachment.mjs. It accepts the native collision `flags` word; existing
adapters may instead supply collideWorld/blockActors/blockPlayers booleans.
Brush identity is `movingBrush`; controlledPlayer retains its native meaning.
The mover wrapper still excludes self and world from its encroachment list.

672 original direct native cases match exactly, varying source masks, every
low collision target mask, and Actor/Pawn/controlled PlayerPawn/uncontrolled
PlayerPawn/Projectile/Brush/world targets. The oracle executes IsBlockedBy
itself with actual native class ancestry and control pointers. Captures precede
translation, are binary-hash gated, and input SHA256 protects reuse.

```sh
node scripts/validate-native-mover-blocking.mjs --capture-only
node scripts/validate-native-mover-blocking.mjs --reuse
node --test test/mover-blocking.test.mjs test/mover-move.test.mjs
```

All six predicate/mover regression tests pass. The wrapper skips nonblocking
non-Pawn query candidates using this predicate. Blocking non-Pawn candidates
are pushed like Pawns: CheckEncroachment1039a512–1039a577 has no Pawn test
before its `AActor::moveSmooth` call. That branch is captured and wired in
[mover-push](mover-push.md) (108 original cases, the Paris club toilet grill).
