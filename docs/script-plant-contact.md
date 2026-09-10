# Plant contact: `Plant7.Bump`

This note records the confirmed training-map contact failure and the original
script path it is supposed to enter. It covers the `Plant7` actor only; the
general decoration physics and arbitrary scene events remain outside this
trace.

## Observed browser boundary

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
give `Mass=150`; `bOnFire`, `CarriedDecoration`, and
`AugmentationSystem` begin null/false for this branch.

For a player contact with vertical overlap, the original order is therefore:

1. The player cast succeeds; both burning tests short-circuit false.
2. `CarriedDecoration == Self` is false.
3. `bPushable`, `PlayerPawn(Other)`, and `Other.Mass > 40` pass.
4. If the hit's Z separation satisfies the exact source inequality
   `abs(Location.Z-Other.Location.Z) < CollisionHeight + Other.CollisionHeight - 1`,
   the overlap gate passes. `augMult` remains `1` when the player's
   augmentation system is null, so `maxPush=100`.
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

Play still prepares the door script subset and rejects Plant7.Bump at the
scene-event adapter. Completing the plant route requires the sound/AI services,
decoration physics/tick integration, and live collision-hash updates. The
original Bump body only assigns the decoration's velocity; advancing it belongs
to the subsequent native physics phase. IsInState281, burning-state transitions,
and the rolling SetPhysics3970 branch also remain required when their source
guards are reached. Plant2's initial falling branch skips that transition.

The browser reset check establishes error recovery only. It does not establish
working plant pushing in Play. The eventual scene adapter must preserve the
original target-first Bump dispatch and execute the actual inherited script.
