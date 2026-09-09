# Stage 2 evidence and remaining acceptance

Status: **playable slice delivered; final acceptance deferred at the user's request**. The dry Training route and Liberty Island spawn/walk
route run in Play. Original-derived controls, CheckBob bytecode, camera math,
walking/falling/landing, stairs, actor collision and the selected Training door
pair are connected. The remaining checks below prevent a claim of fully verified
Stage 2 fidelity, but no longer block Stage 3. JavaScript remains the runtime;
optimization is deferred.

## Authority and supported scene

Authority is the local GOTY package data, embedded UnrealScript source/bytecode,
and execution/disassembly of its native DLL instructions. Extracts, binaries and
captures stay outside Git. Native comparisons hash the original inputs. Passing
a JavaScript route alone does not establish original behavior.

The scene uses healthy JC in PlayerWalking, dry floors/walls/stairs, and Training
DeusExMover16/17 (`UN_maindoor`). These panels translate by Y−56/+56 over two
seconds, use TriggerToggle/IgnoreWhenEncroach, and have no locks, delay or Event
targets. Training has 3,183 prepared world hulls, 95 authored actor cylinders and
25 movers. Actor meshes remain Stage 4 work.

## Connected behavior and original comparisons

Counts describe captured inputs, not exhaustive equivalence proofs. Controlled
script/callback boundaries are documented in the linked evidence records.

| Behavior | Evidence and scope |
| --- | --- |
| Bob and camera | Original CheckBob's 253 serialized bytes execute through the bounded VM. Native camera/input primitives have 555/132 cases; [camera](camera.md), [input](player-input.md). |
| Crouch and jump ordering | Original HandleWalking/ProcessMove resize from the prior crouch flag, jump, then update the flag while walking. Five source-ordered sequences/27 frames plus 27 original native eye expressions match; [controls](player-controls.md), [stance](stance.md), [ceiling trace](stance-trace.md). |
| Geometry and transforms | Original cylinder/brush/world geometry, float stores and quantized sine table; [primitives](primitive-collision.md), [extents](extent-trace.md), [bounds](brush-bounds.md). |
| Actor hash and level queries | Original actor order, class/owner filtering and sorting. 10,980 rays, 7,320 extent queries and 402 complete FindSpot query chains across both maps; [hash](collision-hash.md), [level queries](level-queries.md). |
| Point recovery and relocation | 2,178 direct model and 3,756 level point results; 1,316 relocation callback cases and 40 composed FarMove scenes; [points](level-points.md), [relocation](relocation.md), [FarMove scene](far-move-scene.md). |
| Player movement and events | MoveActor selection/return has 404 cases; full player boundary has 30. JC is registered in the hash; movement/resize/relocation update it; [move query](move-query.md), [player movement](player-move.md), [scene events](scene-events.md). |
| Encroachment and Touch | Real geometry, original policy and reciprocal Touch bookkeeping; 308 query and 825 policy/Touch cases; [encroachment](encroachment-query.md), [policy](check-encroachment.md). |
| Ground and stairs | Original velocity, corner adjustment and stepUp: 820 velocity, 1,138 corner and 348 controlled stair cases; [walking](walking.md) and corresponding native oracle scripts. |
| Falling and landing | Persistent pawn and remaining-time dispatch. 474 falling, 294 landing and 54 support/wall callback cases; [landing](landing.md), [callbacks](walking-callbacks.md), [physics](player-physics.md). |
| Combined player physics | 10 original sequences, 63 frames and 2,547 ordered queries match, including three Training stair risers. Real Play physics with controlled input/script boundaries; [player sequences](player-sequence.md). |
| Target and door state | Cached TraceActors target, separate IsHighlighted predicate, Frob tag linking, ProcessState and interpolation. 15 iterator cases, 29 interpolation cases and 13 native scheduler observations; [interaction](interaction.md), [doors](doors.md), [state timing](door-state.md). |
| Door pushing | Real encroachment, moveSmooth and nested player movement. Nine fresh controlled-player mover scenes match ordered queries/hash/events/positions; [mover scene](mover-scene.md). |
| Door completion | Source completion callbacks and original bounds/FinishNotify use the live pawn list. Native startup audit verifies authored insertion order for 22 Training and 63 Liberty Pawns; [FinishNotify](mover-finish.md), [PawnList](pawn-list.md). |
| RNG | Shared original CRT recurrence and FRand precision; 258 transitions match. Injectable scene seed and repeatable reset. Full-session call ordering remains incomplete; [RNG](rng.md). |

Original MoveActor extends movement by two units and removes those units from
the returned hit distance. Extent LineCheck adds its own backoff. Walking's
27-unit floor probe corrects its measured distance into the 1.9–2.4 band. With
radius20/half-height43, Training's floor Z−128 gives standing center Z−80.2;
alternate stair/landing paths can settle elsewhere within that band.

## Tick and camera contract

The ordinary local PlayerPawn path is PlayerInput, PlayerTick/PlayerMove, ProcessState,
physics, then UpdateEyeHeight. CheckBob runs before rotation and ProcessMove;
rendering consumes completed camera fields. Physics owns OldLocation through
remaining-time transitions, so crouch correction is not applied twice. Native
addresses are in [camera.md](camera.md).

Loaded selected movers tick before the appended JC. Frob runs synchronously on
an accepted press against the cached target, installing a label for the mover's
next ProcessState. Browser use does not immediately interpolate or force Frob
into PlayerTick. Original actor/input evidence is in [door-state.md](door-state.md).

The browser uses a fixed 120 Hz accumulator and the original 0.4-second maximum
actor-time ceiling. Fixed 120 Hz is a browser choice, not original frame cadence.
Mouse radians are converted at the integer rotator boundary; exact device
accumulation/custom bindings are not claimed. Controls currently match the
installed always-run/hold-crouch settings. Browser F-use is an added binding;
right-click corresponds to the original ParseRightClick command.

## Checks and open acceptance

`node scripts/validate-gameplay.mjs` checks both maps: spawn/floor placement,
crouch/stand clearance, blocked/open door traversal, descent/stair return,
closing-door displacement and reset. Door contact uses explicit fixture
placement; cached targeting is checked separately. This is an integration check,
distinct from original mover captures.

The latest run passes 203 unit tests, the production build, both real-data map
routes and all five affected browser checks (46.5 seconds). The composed native
physics/mover and source-ordered tick comparisons also pass after the control
and shared motion-flag corrections.

Deferred acceptance, retained for later validation:

- Complete final original-game visual/motion comparison for the declared route.
  Native helper, source-ordered tick and composed physics evidence do not replace
  this whole-scene acceptance check.
- Verify actual window/tab pause delivery. Automated blur handling already proves
  held-key clearing, frozen simulation and resumption without catch-up;
  Playwright's forced focus does not prove real OS delivery.

## Later-stage boundaries

General script execution/startup actor creation, mission flags/trigger bodies,
AI, damage, audio, animation and wider interactions remain later roadmap work.
Trigger contacts and presentation callbacks are recorded in
`game.status().deferredEffects`; their outcomes are not invented. Arbitrary
physical callbacks fail explicitly; see [scene events](scene-events.md).

This slice does not claim water/ladder/texture sliding, movable non-Pawn pushing,
based passengers/elevators, arbitrary mover states, mission changes, full original
Login/SpawnPlayActor lifecycle or historic whole-game RNG state. Unsupported
physical branches on the accepted route must be resolved; these limits do not
authorize guessed outcomes.

## Reproduction

```sh
npm test
npm run build
node scripts/validate-gameplay.mjs
node scripts/validate-player-tick-order.mjs
node scripts/validate-native-player-sequence.mjs --reuse
node scripts/validate-native-player-sequence.mjs --stairs-only --reuse
node scripts/validate-native-mover-scene.mjs --reuse
npx playwright test browser-tests/gameplay.spec.mjs browser-tests/native-math.spec.mjs browser-tests/pointer-lock.spec.mjs
```

Native capture creation uses local originals and Unicorn2.1.4, normally through
`.cache/native-probe-env/bin/python`; individual documents give capture commands.
`--reuse` compares against saved, hash-checked local evidence. No original code,
data or captures are included in the browser build.
