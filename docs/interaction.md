# Original interaction targeting

Authority is the original embedded DeusExPlayer ScriptText and original
Engine `execTraceActors103e4bc0`–`103e4ec3` plus Core FRotator.Vector.
Local original text/disassembly/captures remain ignored. Inventory activation
and Frob effects are separate; this subsystem must preserve eligible targets
whose use is not yet supported.

## Contract traced before translation

DeusExPlayer.HighlightCenterObject2732–2791 exits in Dying, otherwise queries
only when FrobTime>=float32(.1). It starts at Location, ends at
Location+Vector(ViewRotation)*MaxFrobDistance, then adds BaseEyeHeight separately
to both Z components. This is not the rendered camera eye/bob/lean position.
It calls zero-extent TraceActors with Actor base class. It resets FrobTime=0
after assigning FrobTarget. PlayerWalking.PlayerTick3683–3692 calls highlighting
before incrementing FrobTime by dt, and before Super.PlayerTick movement.
PlayerFlying and PlayerSwimming preserve that check-before-increment ordering;
their movement behavior is outside the dry Stage2 task.

Native execTraceActors parses BaseClass/out Actor/out HitLoc/out HitNorm/End,
defaults Start to caller.Location and Extent to zero, then calls
ULevel.MultiLineCheck with GMem, End, Start, Extent, checkActors=1,
world=caller.LevelInfo(+a8), extra=0 (`103e4dc5`). BaseClass defaults to Actor
but no subsequent native class test appears. The iterator copies actor/location/
normal from each returned hit and executes the loop body, preserving linked-list
order. It does not run SingleLineCheck filters, skip caller/owned actors, or stop
at a world hit. MultiLine's world shortening bounds the actor query separately.
At exhaustion it clears out Actor; a bytecode break preserves the last actor.
Controlled native cases must confirm these surprising omissions before use.

IsFrobbable2716–2723 checks !bHidden and membership in Mover, DeusExDecoration,
Inventory, ScriptedPawn, DeusExCarcass or DeusExProjectile. It does not check
bFrobbable/bHighlight/bDeleteMe. Selection excludes CarriedDecoration. First
eligible ScriptedPawn wins immediately. A Mover wins immediately while
bFirstTarget is true; otherwise strictly smaller CollisionRadius replaces the
candidate (initial minSize99999). bFirstTarget becomes false only when a radius
candidate is accepted. Equal-radius candidates preserve the earlier one.

IsHighlighted2675–2707 is separate: bBehindView rejects everything; for nonnull
actors reject bDeleteMe/bHidden, all Pawns when !bNPCHighlighting, DeusExMover
without bHighlight, non-DeusEx Mover, DeusExDecoration/DeusExCarcass/
ThrownProjectile/ScriptedPawn without bHighlight, and DeusExProjectile when
!bStuck. Original branch ordering matters for inherited classes. Null otherwise
returns true. This predicate must not filter FrobTarget selection itself.

## Captures and delivered API

The native capture confirms the iterator omissions above. Five iterator cases
execute original `execTraceActors` from entry to return with controlled argument
and loop-body evaluation and a controlled MultiLine linked list. They cover
caller/self, wrong BaseClass, an owned actor, a world result followed by another
actor, bytecode break, empty-list out parameters, and explicit/default
start/extents. These are iterator/query-boundary comparisons; MultiLine sorting,
hash and primitive behavior are established by their separate native corpora.
No fake filtering or ordering is supplied by the harness.

Ten additional cases execute original Core `FRotator.Vector1011d1c0` after the
original GlobalMath constructor initializes its lookup table. They match
`getAxes(rotation)[0]`, including negative integer angles, four-unit lookup
quantization, pitch/yaw and nonzero roll. The interaction segment uses the
script's float stores after vector*distance, Location+offset and adding
BaseEyeHeight. Source selection/cadence predicates are translated directly from
embedded scripts; these predicates are not represented as native VM captures.

`src/runtime/interaction.mjs` exports:

- `traceActors(queries,source,end,start=source.position,extent=[0,0,0],out={})`:
  generator over `createLevelQueries`' original MultiLine results. The optional
  out object gets actor/location/normal; normal exhaustion clears actor, early
  generator termination preserves the current actor. Returned hits retain
  additional query metadata for inspection, although the script only receives
  actor/location/normal. Class filtering is intentionally absent as evidenced.
- `highlightCenterObject(state,trace)`: updates cached frobTarget/frobTime only
  when the original cadence fires; Dying leaves both unchanged.
- `tickWalkingInteraction(state,dt,trace)`: dry PlayerWalking's query-then-add
  ordering, including float32 accumulation. Call before UpdateRotation/ProcessMove
  and native movement. Physical Falling can still be this PlayerWalking script
  state. Other script-state tick functions are explicitly outside this wrapper.
- `isFrobbable(actor)`, `isHighlighted(state,actor)` and
  `interactionDirection(integerViewRotation)`.

State supplies `position`, integer Unreal `viewRotation`, `baseEyeHeight`,
`maxFrobDistance`, `frobTime`, `frobTarget`, `carriedDecoration`, and `stateName`.
The separate highlight predicate reads `behindView` and `npcHighlighting`.
Initialize the authored ordinary PlayerWalking cache to frobTime=0,
frobTarget=null; retain it between uses and simulation ticks. Rechecking a use
ray at click time changes the original cached-target behavior.
`trace(end,start,extent)` returns raw TraceActors hits, e.g.
`traceActors(collision.queries,player,end,start,extent)`.
Actor records need original `.lineage` plus inherited `.values`; missing ancestry
fails explicitly. Eligible unsupported non-door targets must survive selection
and be reported as unsupported by the use layer, not treated as empty space.
For third-party view modes or UI input restrictions, the use layer remains
responsible for original RestrictInput and Frob dispatch.

Fifteen captured native comparisons match exactly and six regression tests pass.
At a fixed 1/120 tick with initial timer0, the first query occurs on the thirteenth
PlayerTick: the first twelve calls only accumulate time, then the next call tests
that prior accumulated value and resets it before adding the current dt.
The first eligible mover ends the search even if a ScriptedPawn is later in the
list; source comments about pawn precedence must not replace actual branch order.

```sh
node scripts/validate-native-trace-actors.mjs
node scripts/validate-native-trace-actors.mjs --reuse
node --test test/interaction.test.mjs
```

Inputs/results remain ignored `.cache/interaction/{cases,original}.json`.
Inventory use, mission state changes, visual highlight rendering and sound/UI
are not implemented by this targeting helper. Original native iterator body
callbacks can mutate the world; this bounded consumer performs only selection.

Play integration now retains this cache across simulation calls, runs it before
player rotation/movement, and consumes it at use time. The browser passes pitch
and yaw through the documented integer-rotator boundary. UI hint visibility uses
IsHighlighted separately, without removing an eligible cached target. Unsupported
non-door interactions report the selected actor instead of tracing through it.
Reset clears FrobTime and FrobTarget. UI action labels and toast messages remain
browser additions; this does not claim the rest of ParseRightClick or a general
original HUD implementation.
