# Plant contact: `Plant7.Bump`

This note records the confirmed training-map contact failure and the original
script path it is supposed to enter. It covers the `Plant7` actor only; the
general decoration physics and arbitrary scene events remain outside this
trace.

## Observed browser boundary

> **Resolved** (see "Play integration" below): `Plant7.Bump` now runs the real
> script and pushes the plant; it no longer pauses. This section records the
> original failure and the path it was supposed to enter.

The focused browser check in
[`browser-tests/runtime-error.spec.mjs`](../browser-tests/runtime-error.spec.mjs)
moves JC into the training scene and waits for `runtimeError.message` to
contain `Plant7.Bump`. The error is caught by
[`src/viewer/main.mjs`](../src/viewer/main.mjs): play is paused, input and the
clock are reset, and Player start clears the error. No page error is emitted.

The first unsupported binding is the scene-event adapter, before the original
function is executed:

1. [`player-move.mjs`](../src/runtime/player-move.mjs) dispatches the hit
   actor's `Bump` first, with the player as its argument (the reciprocal player
   `Bump` follows only if the first call returns).
2. [`scene-events.mjs`](../src/runtime/scene-events.mjs) has explicit branches
   for JC, Trigger touch events, and the selected `DeusExMover` subset. A
   decoration such as Plant7 reaches its `unsupported(target, event)` fallback,
   producing `Unsupported original scene event: Plant7.Bump`.

Thus the current message identifies a missing host dispatch route, not a
failure raised by `DeusExDecoration.Bump` bytecode. The Actor event declaration
is `event Bump(Actor Other)` in
`.cache/research/pawn-startup/engine.actor.uc`; a real engine dispatch would
resolve the target's inherited script function through `ProcessEvent`.

## Original actor and function

The installed `00_Training.dx` record is:

| field | value |
| --- | --- |
| map actor index | `2459` |
| object name | `Plant7` |
| class | `Plant2` |
| lineage | `DeusEx.Plant2` → `DeusEx.DeusExDecoration` → `Engine.Decoration` → `Engine.Actor` → `Core.Object` |

`.cache/reference/Plant2.uc` declares `class Plant2 extends DeusExDecoration;`
and has no body. The inherited source body is
`.cache/reference/DeusExDecoration.uc:394-495`. Its serialized function is
`DeusEx.u` export `1448`, `DeusExDecoration.Bump`, with an expanded script
size of `1087` bytes. The function has one parameter child,
`DeusExDecoration.Bump.Other`; `augLevel`, `augMult`, `maxPush`, `velscale`,
`Player`, and `Rot` are locals.

The decoded statement offsets preserve the source order:

| expanded offset | source operation |
| ---: | --- |
| `0` | `Player = DeusExPlayer(Other)` |
| `16-123` | burning Pawn test, then `GotoState('Burning')` |
| `130-240` | burning `DeusExDecoration` test, then `GotoState('Burning')` |
| `247-278` | return when `player.CarriedDecoration == Self` |
| `280-394` | `bPushable`, `PlayerPawn(Other)`, mass, and vertical-overlap gates |
| `394-517` | augmentation multiplier and `maxPush` |
| `517-596` | mass limit and clamped velocity scale |
| `596-685` | write velocity and zero Z only when current physics is not falling |
| `685-771` | play push sound / AI loud-noise event and set `bPushSoundPlaying` |
| `771-812` | call `SetPhysics(PHYS_Rolling)` when current physics is not falling; then `SetTimer(0.2, False)` |
| `812-1085` | set `Instigator`, calculate and quantize yaw, then call `SetRotation` |

The map and class defaults make this a pushing path, rather than a harmless
empty callback. `ClassDefaults` on the installed packages gives Plant2
`bPushable=true`, `Mass=50`, `Physics=2` (`PHYS_Falling`),
`CollisionRadius=23.26`, and `CollisionHeight=43.88`. `bFlammable`,
`bFloating`, and `bPushSoundPlaying` are not authored by Plant2 or its
`DeusExDecoration` defaults, so their UnrealScript zero value is false. The
inherited `PushSound` default resolves to
`DeusExSounds.Generic.PushMetal` (export `50`). JC's `JCDentonMale` defaults
give `Mass=150`; serialized `bOnFire`, `CarriedDecoration`, and
`AugmentationSystem` begin false/null before `PostBeginPlay`. The current Play
host runs the standalone player startup first, so the live manager is present;
the unowned `AugMuscle` still leaves the source's `GetClassLevel` at `-1` and
therefore keeps `augMult=1`.

For a player contact with vertical overlap, the original order is therefore:

1. The player cast succeeds; both burning tests short-circuit false.
2. `CarriedDecoration == Self` is false.
3. `bPushable`, `PlayerPawn(Other)`, and `Other.Mass > 40` pass.
4. If the hit's Z separation satisfies the exact source inequality
   `abs(Location.Z-Other.Location.Z) < CollisionHeight + Other.CollisionHeight - 1`,
   the overlap gate passes. The live manager finds unowned `AugMuscle` at level
   `-1`, so `augMult` remains `1` and `maxPush=100`.
5. Plant2's mass passes the limit and `velscale=1`. Its velocity receives the
   player's velocity; because its current physics is `PHYS_Falling`, the body
   does not zero Z and does not call `SetPhysics(PHYS_Rolling)`.
6. The body calls native `PlaySound` (`264`, expanded offset `724`) and
   `AIStartEvent` (`714`, offset `747`), sets `bPushSoundPlaying`, calls
   `SetTimer(0.2, False)` (`280`, offset `803`), stores the player as
   `Instigator`, and applies the yaw-only `SetRotation` (`299`, offset
   `1069`).

The inherited `DeusExDecoration.Timer` at
`.cache/reference/DeusExDecoration.uc:503-511` later calls `StopSound` (`265`),
`AIEndEvent` (`715`), and clears `bPushSoundPlaying`. This timer callback is
part of the original sound lifetime after the contact.

## Current VM coverage and remaining Play integration

The original inherited Plant2 Bump and Timer bodies now execute through the
linked runtime. Dynamic/meta casts use the recovered Core handlers and canonical
class ancestry; [decoration arithmetic](script-decoration-primitives.md) and
VectorToRotator use the original instructions and constants. The ordinary
[SetRotation](script-set-rotation.md) short path writes the computed yaw through
typed actor storage.

`node scripts/validate-script-decoration.mjs` executes the actual package
bytecode. It checks velocity, Instigator, yaw, push-sound fields, timer cleanup,
carried-object early return, and ordered requests to sound/AI natives. Sound
264/265 and AI event 714/715 remain recorded external boundaries in that check;
it does not implement audio playback or AI propagation.

## Play integration (implemented)

`Plant7.Bump` now runs the real inherited `DeusExDecoration.Bump` in Play. The
scene adapter ([`scene-events.mjs`](../src/runtime/scene-events.mjs)) routes a
`DeusExDecoration` `Bump` to the door runtime's VM instead of the `unsupported`
fallback, preserving `player-move`'s target-first dispatch. The pushed decoration
is already attached to that runtime (every live map actor is), so the Bump reads
its typed defaults (`bPushable`, `Physics`, `Mass`, `CollisionHeight`, the
player's live `Velocity`) and writes `Velocity`, `Instigator`, the yaw
`SetRotation`, and the push-sound state. Wiring:

- [`script-doors.mjs`](../src/runtime/script-doors.mjs) prepares
  `DeusExDecoration.Bump`/`Timer`, exposes `bumpDecoration`, records the push
  sound / AI loud-noise (`264`/`714`) and the `Timer`'s `StopSound`/`AIEndEvent`
  (`265`/`715`) as deferred boundaries, and advances the `SetTimer(0.2)`
  push-sound lifetime each tick.
- [`player-scene.mjs`](../src/runtime/player-scene.mjs) and
  [`game.mjs`](../src/viewer/game.mjs) late-bind that handler into the scene, and
  expose the player's live pawn `Velocity` to the runtime.

Validated by `scripts/validate-plant-push.mjs` (the full scene route in the Play
host: velocity/Instigator/rotation, recorded push sound + AI, and the timer
clearing `bPushSoundPlaying`), alongside the bytecode-level
`scripts/validate-script-decoration.mjs`. The browser check
([`runtime-error.spec.mjs`](../browser-tests/runtime-error.spec.mjs)) now asserts
the contact pushes without pausing and that Player start still resets.

## Decoration physics (in progress)

Advancing the pushed decoration's position is the native physics phase. It is
being built on the recovered movement primitives:

- **`MoveActor` for a decoration cylinder — done, validated.** The original
  `MoveActor` (`0x103990e0`) query/selection/math is source-type independent: it
  keys on each candidate's type and the source's block flags, never on whether the
  source is a controlled player. `native-move-query-oracle.py` now runs a
  decoration source (`sourceControlledPlayer:false`) and produces identical
  results, so `moveQuery` reuses the same path for a decoration
  (`scripts/validate-native-move-query.mjs`, 424 cases; `docs/move-query.md`).
- **`physFalling` for a non-Pawn decoration — done, validated.** `AActor::physFalling`
  (`0x103d0a50`) computes `Pawn = IsA(APawn) ? this : NULL` in its prologue
  (`0x103d0a7d`–`0x103d0aa7`) and, for a non-Pawn (`0x103d0bca`), jumps past the
  entire air-control/acceleration-clamp block, copying `Acceleration` unchanged.
  The general integration is `Velocity = OldVelocity + 0.5*(Gravity + Acceleration)*step`
  (`0x103d1157`, taken by any non-PlayerPawn; Path A at `0x103d1039` is
  PlayerPawn-only, and the half-gravity branch at `0x103d0f42` is gated by
  `IsA(ADecoration 0x10578d48) && bBobbing` — Decoration `+0x31c` bit 8, not
  bBounce; see [actor-physics.md](actor-physics.md)). That is exactly `falling()`'s integration, and the
  existing player oracle already ran that path (zone flag `+0x388=0`). The oracle
  now runs a **non-Pawn** actor (`native-falling-oracle.py`, `nonPawn:true`, a
  class whose null SuperField makes every inlined `IsA` false); `falling()` with a
  decoration proxy (acceleration `[0,0,0]`, airControl `0`) reproduces it
  bit-exactly — `scripts/validate-native-falling.mjs`, **562 cases, maxError 0**.
- **Landing transition — done, validated (`AActor::processLanded`, `0x103cef60`).**
  For a non-Pawn it skips the Pawn landing-animation block (`0x103cf124`
  `IsA(Pawn)` → `0x103cf597`), runs a decoration-class landing-footprint branch
  (`IsA(0x10578d48) && actor+0x324 < 5`), then **dispatches the script
  `Landed(HitNormal)` via `ProcessEvent`** (the VM boundary — `DeusExDecoration.Landed`
  runs here). Only if Physics is *still* `PHYS_Falling(2)` after that event does it
  call `setPhysics(PHYS_None, floor)` (`0x103c95f0`), which sets `Physics=PHYS_None`,
  `Base=floor`, and zeroes `Velocity` and `Acceleration`. The footprint probe set is
  **read-only**: a footprint-present (counter `<5`) and a footprint-absent (`>=5`)
  landing reach a byte-identical outcome — asserted directly as a footprint-invariance
  check. `native-landing-oracle.py` gained a non-Pawn/decoration mode (class
  `0x10578d48`); `decorationLanded()` (`src/runtime/landing.mjs`) reproduces the
  native outcome and transition events exactly — `scripts/validate-native-landing.mjs`,
  **356 cases, maxError 0, 4 invariance pairs**. `DeusExDecoration.Landed`
  (`.cache/reference/DeusExDecoration.uc:156`) clears `bFixedRotationDir`, lays the
  plant flat (`Pitch=Roll=0`, `SetRotation`), and only plays a fragType/Mass hit
  sound + `AISendEvent('LoudNoise')` when `Velocity.Z <= -200` (fall damage only for
  `Velocity.Z < -500`) — it never changes Physics, so the engine `setPhysics(0)`
  fires. A settled decoration is therefore `PHYS_None` on its floor; `BaseChange()`
  (`:295`) re-enters `PHYS_Falling` when a pushable decoration loses its base.
- **Open question surfaced by the landing model:** the forced-`PHYS_Falling`
  `validate-plant-push` masked that a settled Plant7 is `PHYS_None`. This is now
  resolved: decorations advance their recovered physics every actor phase, so a
  loaded Plant7 settles to `PHYS_None`, and at bump time the `Bump` body's
  `Physics != PHYS_Falling` gate zeroes Z **and** calls
  `SetPhysics(PHYS_Rolling)` (`3970`). That branch is implemented (the door
  runtime's decoration `SetPhysics`, `src/runtime/rolling.mjs`), so the settled
  plant rolls instead of pausing.
- **Decoration-physics tick — wired.** [`decoration-physics.mjs`](../src/runtime/decoration-physics.mjs)
  (`runDecorationPhysics`) advances one decoration a timestep by selecting the
  recovered native on `Physics`: `falling()` with a non-Pawn proxy (zero
  acceleration/air control), `rolling()` for `PHYS_Rolling`
  ([rolling.md](rolling.md)), `moveQuery` as the collision move against the live
  level queries (`multiLineCheck` + `changeActor` hash update), and
  `decorationLanded()` on a floor hit (VM `Landed`, then `setPhysics(PHYS_None)`:
  rebase on the floor, zero velocity/acceleration). An airborne push works,
  wall contacts in rolling run the script `HitWall`/slide response, and a
  falling wall contact runs the recovered, oracle-validated non-Pawn
  `processHitWall` (`processDecorationHitWall`, `0x103cecc0`): return for a Pawn
  wall, else dispatch the unmodified `HitWall(normal,wall)` solely while the
  decoration probes `HitWall`, with none of the Pawn direction/`MinHitWall`/
  `MoveTimer`/`bFromWall` bookkeeping ([walking-callbacks.md](walking-callbacks.md)).
  `linkDecorationCollision` links a decoration's static hash `Location` to its live
  `position` before it moves (non-mover decorations otherwise keep a static
  cylinder). `test/decoration-physics.test.mjs` covers free-fall, floor landing,
  the falling wall dispatch, the missing-handler guard, and the resting no-op;
  `scripts/validate-plant-push.mjs` and the Firefox runtime check exercise the
  live Play route.
- **Wired into Play.** [`script-doors.mjs`](../src/runtime/script-doors.mjs)
  enumerates the live decoration identities and runs `runDecorationPhysics` after
  each actor's `ProcessState` and timer phase, using `collision.queries` and the
  per-position zone from [`game.mjs`](../src/viewer/game.mjs). `DeusExDecoration.Landed`,
  the inherited `Actor.HitWall`/`Actor.Landed`, and the decoration `SetPhysics`
  native are prepared/bound so a settled plant rolls when pushed. The falling
  wall contact's `onHitWall` calls `processDecorationHitWall` with the runtime's
  live `isProbing` (state-frame probe mask) and `ProcessEvent` dispatch, replacing
  the earlier ad-hoc branch that relied on `ProcessEvent`'s incidental probe gate.
  Audible playback and AI propagation stay Stage-4 boundaries; whole-scene rolling
  acceptance is not claimed.
