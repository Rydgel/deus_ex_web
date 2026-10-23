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

## Zero-Delta changed rotation with a based rider

(A changed rotation with riders and a nonzero Delta under 0.0001 on every axis, which a turning pawn's rider pass produces, is the case `tiny-nonzero-delta-changed-rotation-with-rider`
of the same validator: the DLL runs the rider pass and moves the source by exactly that Delta, no line check ran, and `playerMove` takes the requested Delta as FinalDelta there;
docs/census-conversations.md.)

`scripts/validate-native-set-rotation-riders.mjs` adds two focused original
cases for changed rotation with `StandingCount != 0`. It uses the Training
map's real world model and existing native MoveActor/hash harness, with one
PlayerPawn at `[-300,800,-64]` and one noncolliding, inventory-like Actor whose
`Base` is that pawn. The harness calls original `ULevel::MoveActor`
(`0x103990e0`) with Delta `[0,0,0]`; the rider's recursive MoveActor, hash
operations, geometry routines and movement instructions execute as DLL code.
Script event dispatch and the `SetActorZone` virtual callback are controlled
harness boundaries. These cases establish pose, recursive arguments and
callback order, not a real zone transition's body.

The first case reproduces the live UpdateRotation failure pose: old player
rotation `[-7777,-16384,0]`, requested rotation `[57759,-16384,0]` (pitch
differs by a signed 16-bit wrap while yaw is unchanged), and rider position
`[-280,800,-64]`. `MoveActor` returns true and commits the requested player
rotation without changing either location. The exact three-integer comparison
detects a rotation change, the nonzero `StandingCount` gate enters
`0x10399240`, and the rider pass calls recursive MoveActor at `0x10399b51`
with rider Delta `[0,0,0]`, unchanged rider rotation `[0,100,0]`, and flags
`[0,0,1,0]`. The recursive call takes the unchanged rotation/zero-Delta early
return, so this noncolliding rider gets no hash or zone callback. The source
then records hash remove, hash add, and `SetActorZone(source,0,0)` in that
order.

The second case rotates player yaw from `0` to `16384` (a quarter turn) with
the same rider offset. Original rider arithmetic supplies Delta `[-20,20,0]`
and NewRotation `[0,16484,0]`; the real recursive move ends at
`[-300,820,-64]`, yaw `16484`. Its `SetActorZone(rider,0,0)` is observed before
the source hash remove/add and source `SetActorZone(source,0,0)`. The rider is
noncolliding, so the hash operations are for the source pawn only.

## Training stacked-crate rotation case

The authored `PlayerStart1 -> DL_part2` probe reached
`DeusExDecoration.Bump` on the original `CrateBreakableMedGeneral1` and
captured the live arguments immediately before the route's then-unlinked
MoveActor branch. `DeusExDecoration.uc:473–490` computes a yaw-only push
rotation and calls `SetRotation(Rotation + rot)`. The observed top-level native
entry has Delta `[0,0,0]`, requested Rotation `[0,-30,0]`, and four zero flags.
Its source was at `[1022.109741,-275.102783,-103.899864]`, with Rotation
`[0,0,0]`, `StandingCount=255`, radius `34`, height `23.25`, and collision
bits `13` (`bCollideActors`, `bBlockActors`, `bBlockPlayers`). The attached
`CrateBreakableMedGeneral2` rider was at
`[1022.596252,-278.577301,-55.393246]`, Rotation `[0,1948,0]`, with
`Base=CrateBreakableMedGeneral1`, `StandingCount=0`, and the same colliding
bits. The nonzero count selects the full rider path; this is not the ordinary
no-rider direct-rotation case.

The captured route source count was `255`, but that byte is not claimed as a
valid authored stacking count. Play had reached it through a host-side Base
update that bypassed original `SetBase` count maintenance. The focused reference
uses the same source/rider geometry with `StandingCount=1`, the valid one-rider
case established after the field-backed Falling/Rolling path was corrected. The
255 observation remains useful diagnostic provenance and is not normalized or
used as the expected original state.

The original DLL comparison uses the Training world model and runs the
non-Pawn, colliding `$crate` and `$crate-rider` through `ULevel::MoveActor`. It
returns true with source Location unchanged and Rotation `[0,-30,0]`; the rider
ends at `[1022.5855713,-278.5787659,-55.3932457]`, Rotation `[0,1918,0]`. The
recursive MoveActor call receives Delta `[-0.01066195965,-0.00147628784,0]`,
Rotation `[0,1918,0]`, flags `[0,0,1,0]`, and a clear `FCheckResult`
(`Time=1`, no actor). Native `CheckEncroachment` runs first for the moved rider
with its final pose and then for the source with `[1022.1097412,-275.1027832,
-103.8998642]`, Rotation `[0,-30,0]`; both return false (no rejection). Hash
remove/add and zone order is rider first, then source. The validator compares
these values against translated `playerMove`/`moveActorRiders`, including the
CheckEncroachment call sequence.

The native side uses the Training world queries and original
CheckEncroachment. The translation comparison supplies controlled empty line
hits and the captured clear encroachment result; it checks call arguments and
ordering, not the query implementations again. Live Play uses the previously
verified collision/encroachment bodies, and the continuous route checks that
adapter separately. Script callbacks and zone-update effects remain explicit
controlled leaves in this small arithmetic comparison.

This establishes only zero source Delta, one based colliding map-identity rider,
non-brush movable actors, and this clear movement result. Additional riders,
nonzero source Delta, brushes, blocked movement, rejection, and callback
mutation remain outside the case.

Relevant instructions: changed integer rotation and `StandingCount` gate are
at `0x103991c8`–`0x10399240`; the full zero-Delta route reaches `0x10399795`;
the rider loop and `Base == source` filter are `0x103998a0`–`0x103998e7`;
changed-rotation detection and reduced-yaw mask (`& 0xfffc`) are
`0x10399901`–`0x10399939`; rider translation/rotation and recursive call are
`0x10399939`–`0x10399b57`; Pawn rider `ViewRotation` adjustment is
`0x10399b5d`–`0x10399ba6`. Source pose/hash commit is
`0x10399c9a`–`0x10399d17`; final source zone dispatch is
`0x10399f03`–`0x10399f15`. The cases support this zero-Delta, non-brush, one-rider slice only.
Translation, brushes, multiple riders, rejected movement, callback mutation,
and actual zone updates remain unverified; the crate case does cover one
colliding rider with clear encroachment.

## Runtime integration boundary

`src/runtime/script-set-rotation.mjs` implements native 299 through the
common runtime dispatcher. It requires a live level and its explicit editor
flag and preserves the static/movable rejection before the equal-rotation
return. Equal rotations return before the StandingCount/Brush checks. Changed
rotations with no riders keep the original short path; changed rotations with
a nonzero `StandingCount` and no Brush now call the live level's zero-flag
MoveActor adapter. `player-scene.mjs` routes the controlled pawn through
`playerMove` and the recovered `moveActorRiders` arithmetic. The pitch-wrap/yaw
player cases and the one-rider Training crate case above
match the original scalar pose, recursive call arguments, CheckEncroachment
results and hash/zone boundary order. Brush movement still raises an explicit
unsupported error.

`collision-hash.mjs` and `zone` services supply the existing movement bodies.
`player-move.mjs` admits controlled players and the documented zero-Delta
map-actor rider path; its ordinary translation path retains
the prior rotation constraints. `mover-move.mjs` is for translating brushes,
and `relocation.mjs` implements different FarMoveActor semantics. Those
separate adapters do not establish general native 299 support.

The full MoveActor branches remain generally excluded from the SetRotation
adapter: translation, brushes, multi-rider scenes, blocked movement, and their
complete collision/zone/network effects. Verified slices are zero Delta for a
controlled player pawn with one noncolliding rider, and the single Training map
crate with one colliding rider and a clear encroachment result. These cases do
not establish general native 299 support.
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
Location. `scripts/validate-native-set-rotation-riders.mjs` executes the two player
cases and the original Training crate case, then compares the translated
`setScriptRotation` → level MoveActor → `playerMove`/`moveActorRiders` path,
including recursive arguments, CheckEncroachment calls/results, and callback
order. All three comparisons pass. No visual comparison or broad native corpus is
required.
