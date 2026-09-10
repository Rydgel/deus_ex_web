# `Actor.SetRotation` native 299

This note records the original call contract needed by the ordinary training
map `Plant2` contact.  `Actor.uc` declares `native(299) final function bool
SetRotation(rotator NewRotation)`.  `Plant2.uc` has no body and inherits
`DeusExDecoration.Bump`; after calculating its yaw-only `rot`, that script
calls `SetRotation(Rotation+rot)` and ignores the Boolean result.  The scoped
actor is a standalone, movable, non-pawn decoration with `StandingCount == 0`
and a null `Brush`.

## Wrapper and call ABI

The exported thunk at `0x103015aa` jumps to `execSetRotation` at
`0x103e31b0` (`.cache/reference/Engine.asm`).  The wrapper:

1. Evaluates the script `Rotator` expression through the expression dispatch
   table at `0x10599a38`, advances the `FFrame` code pointer, and retains the
   three integer components of `NewRotation`.
2. Initializes a zero `FVector Delta`, four zero movement flags, and the local
   `FCheckResult` used by `MoveActor` (the initial result carries `Time = 1`
   and no hit actor, as in the adjacent `execMove` setup).
3. Loads `Actor+0xac` (`Level`) and calls that level's virtual slot `+0x88`.
   The exported symbol at `0x10303c60` identifies this slot as
   `ULevel::MoveActor`, whose body is `0x103990e0`.
4. Stores the callee's `EAX` Boolean through the script result pointer and
   returns with `ret 8`.

There is no independent actor-side rotation setter in this wrapper.  The
level pointer must therefore be live; a missing level is outside the native
contract rather than a reason to silently write the property.

## Ordinary Plant2 path

The relevant `MoveActor` instructions are `0x10399104` through `0x1039923d`:

1. A null source actor returns `false`.  Outside editor mode, a source with
   `bStatic` set or `bMovable` clear is rejected before any rotation work
   (`Actor+0x28`, `0x1039912d`–`0x10399157`).  The Plant2 defaults are
   `bStatic = false` and `bMovable = true`.
2. The callee tests each Delta component independently against the original
   small threshold (`0x1042ac40`, `0x1039915a`–`0x103991c6`).  The wrapper's
   Delta is exactly zero, so this gate succeeds.
3. It compares all three requested rotation integers with `Actor+0x120`
   (`0x103991c8`–`0x103991ed`).  An unchanged rotation returns `true` at
   `0x10399228` without writing or touching scene state.
4. For a changed rotation, a nonzero `StandingCount` (`Actor+0xd8`) enters
   the full movement path at `0x10399240`.  With `StandingCount == 0`, the
   native code checks `Actor+0x178` (`Brush`).  The ordinary Plant2 fixture
   has no Brush, so it takes the short path at `0x1039921a`.
5. The short path stores the requested pitch, yaw, and roll directly at
   `Actor+0x120`, returns `true` at `0x10399228`, and does not change
   `Location` (`Actor+0x114`) or `OldLocation`.

This short path is the path reached by the Plant2 Bump contact after the
inherited script has produced its new yaw.  A changed rotation therefore does
**not** imply collision-hash maintenance or a zone update for this actor.

## Collision, zone, and encroachment effects

For the scoped short path there are no collision or scene callbacks:

* It does not remove or reinsert the actor in the level hash, even when
  `bCollideActors` is set.
* It does not call `MultiLineCheck` (`ULevel` virtual `+0xc8`, used by the
  translating branch near `0x103995c8`).
* It does not call `CheckEncroachment` (export thunk `0x10302536`, body
  `0x1039a350`) or `FCollisionHash::ActorEncroachmentCheck` (export thunk
  `0x10301497`, body `0x10358d50`).  Those are separate query paths, not
  implicit parts of native 299.
* It does not dispatch a hit Bump/BumpWall, touch callbacks, or
  `SetActorZone`.

For comparison, a caller that deliberately supports the excluded full
`MoveActor` branch must preserve its later order.  On the zero-Delta route,
the exact-zero tests reach `0x10399795`; the ordinary commit at
`0x10399c9a`–`0x10399d17` removes the actor from `Level+0xf8`'s hash through
virtual `+0xc`, writes Location and Rotation, and reinserts through virtual
`+0x8` when `bCollideActors` (`Actor+0x1dc` bit 1) and the hash are present.
After touch cleanup, `0x10399f03` calls `ULevel::SetActorZone` through virtual
`+0xac` (`0x10302a77` thunk, body `0x1039b940`).  These effects belong to the
full branch and must not be added to the ordinary Plant2 short path.  A
nonzero translating branch, brush branch, or based/rider branch has further
scene work and is not covered here.

## Runtime integration boundary

`src/runtime/script-set-rotation.mjs` implements native 299 through the
common runtime dispatcher. It requires a live level and its explicit editor
flag, preserves the static/movable rejection before the equal-rotation return,
and writes only Rotation for the changed-rotation short path. Equal rotations
return before the StandingCount/Brush checks. A changed rotation requiring the
full MoveActor path raises an explicit unsupported error.

`collision-hash.mjs` and `zone` services are reusable if a separately
verified full `MoveActor` adapter is added.  `player-move.mjs` requires a
controlled pawn and unchanged rotation, `mover-move.mjs` is for translating
brushes, and `relocation.mjs` implements different FarMoveActor semantics;
none is a native 299 substitute.

The full MoveActor branches remain excluded: translation, nonzero
StandingCount and passengers, brushes, and their collision/zone/network effects.
The source's editor bypass of the static/movable guard is translated; it does
not establish general editor movement support.

## Evidence and validation

The contract is based on the original `Actor.uc`, `Plant2.uc`,
`DeusExDecoration.uc`, and the Engine.dll disassembly in
`.cache/reference/Engine.asm` and `.cache/reference/moveActor.asm`.  The
related movement and zone ordering is cross-referenced in
`docs/move-query.md`, `docs/player-move.md`, `docs/move-smooth.md`, and
`docs/zone.md`.  `scripts/validate-script-decoration.mjs` executes the original inherited Plant2
Bump body through native 299 and checks its quantized yaw of 63 with unchanged
Location. No visual comparison or broad native corpus is required here.
