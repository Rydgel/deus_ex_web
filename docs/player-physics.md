# Dry Play physics integration

Compiled-map `Player.tick` uses `runPlayerPhysics` in `player-physics.mjs`.
It connects the original-derived `walking`, `falling`, `processLanded`, surface
prelude, support and wall callbacks to the composed original level queries and
full player MoveActor scene adapter. Geometry-only fixtures retain the older fallback.
The numerical native evidence remains in the individual subsystem documents;
this adapter and route checks do not establish complete original tick parity.

One persistent pawn carries position, velocity, acceleration, Physics, Base,
sloped-wall state and native wall bookkeeping. Walking can continue falling,
and processLanded can continue walking with the remaining time and iteration
count on that same object. Player position/velocity are copied back at tick end.
The most recent walking OldLocation supplies camera old Z, and UpdateEyeHeight
runs once per tick. Reset discards this pawn; each tick reads the current query
world identity, including after a map collision-hash rebuild.

The original sources reviewed before connecting callbacks are Actor.SupportActor
(default SetBase), Pawn.BaseChange and its conditional damage/jump-off branches,
Pawn.MayFall and WalkTexture empty declarations, PlayerPawn.Falling (PlayInAir),
DeusExPlayer.Landed (overrides PlayerPawn, sets bJustLanded but no LandBob),
DeusExMover.SupportActor, and Mover.StandOpenTimed.Attach. Native support/physics/
wall state changes are delegated to the independently captured callback module
(`docs/walking-callbacks.md`). Falling's air-control query uses original
SingleLineCheck flags6 and source pawn at Engine103d0cdc/103d0cf1, with the pawn
extent. The controlled source pawn is registered in the scene actor hash. Movement,
resize and relocation share its position, dimensions, identity and motion-flags
word; the broader original startup/event graph remains outside this slice.

## Explicit callback limits

- Ordinary world SupportActor calls original-derived SetBase. DeusExMover support
  does so when the mover is not destroyed and incoming Z velocity is at least
  -500; destroyed movers switch the standing pawn to Falling. Hard stomp damage
  remains unsupported. Attach/Detach are accepted only for the implemented
  TriggerToggle mover state; other actor/state overrides require dispatch.
- Pawn.BaseChange accepts ordinary world/mover support. Pawn stomp/jump-off and
  hard Decoration landing damage fail explicitly. Generic actor SupportActor
  overrides are not inferred from cylinder geometry.
- Entering Walking without an explicit landing support would require original
  FindBase and currently fails. The ordinary landing path supplies its hit actor.
- FarMoveActor and original random-stream state are required only if processLanded
  finds a different recovery spot (or a ledge veto requests relocation). The
  Play scene installs both independently evidenced implementations. `player.nativeFarMove`
  receives `(pawn, position, 0, 0)` and must mutate pawn position;
  `player.nativeRandom()` supplies the shared original CRT stream. A caller that
  omits these hooks still fails explicitly when the branch is reached.
- Optional `player.physicsDispatch(target,event,args,pawn)` replaces the entire
  synchronous script event boundary. Without it, unsupported branches above fail.
- Water and bouncing physics, Ladder textures and Friction<1 texture sliding
  fail explicitly. The surface scanner and texture lookup still run before
  ordinary walking; Play provides original decoded texture metadata.
- PlayerPawn.PlayInAir and DeusExPlayer.Landed animation/audio/damage are recorded
  in `player.unimplementedPhysicsEffects`, not simulated. The latter sets
  `justLanded`; it does not assign LandBob. Pawn.MayFall and WalkTexture are empty
  in the ordinary inherited path. Native processHitWall bookkeeping still runs.

## Integration checks

`node --test test/player-physics.test.mjs` checks that falling→landing→walking
uses one pawn and walking OldLocation, and that unsupported landing relocation
fails before invented movement/randomness. These are wiring tests, not native
fidelity measurements.

`node scripts/validate-gameplay.mjs` passes the Training spawn, closed-door stop,
open-door traversal, descent, stair return and reset route, plus Liberty spawn
and walking. The current local result is retained at
`reports/movement/player-physics-routes.json`. The composed native comparison adds 10 sequences/63 frames/2,547 ordered
queries, including the three stair risers; see [player-sequence.md](player-sequence.md).
Script bodies and whole-game input/camera acceptance remain separate boundaries.

The ordinary HitWall probe is **false**. Original serialized JC ancestry masks
and both PlayerWalking state masks omit bit 0x200 (HitWall name index0x135 minus
300). Core.IsProbing10115670 reads that runtime probe bit. An empty Actor.HitWall
declaration does not enable it. Consequently walking uses original native
MoveTimer=-1 / bFromWall bookkeeping when its gates pass; falling still dispatches
the empty HitWall event because the native routine explicitly checks Physics2.
This adapter covers the ordinary state with no dynamic Enable('HitWall').

Core.GotoState1012ea1f–1012ea47 constructs the runtime mask as
`(Class.ProbeMask | State.ProbeMask) & State.IgnoreMask`. Original JCDentonMale
mask words f8040d02/800 and DeusExPlayer.PlayerWalking01031800/20 OR to
f9071d02/820; bit0x200 is absent before the ignore-mask AND. This verifies the
false probe from original frame initialization, not merely the script text.
