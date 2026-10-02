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

## Sibling native 1003 TraceVisibleActors

Deus Ex's `execTraceVisibleActors` (`0x1036ec50`, thunk `0x10302847`) is the
309 exec above with one change. Its `MultiLineCheck` passes
`ExtraNodeFlags = 4` (`NF_NotVisBlocking`, `push 4` at `1036edfe`) instead of
0. It has no bHidden or other per-hit filter. ScriptedPawn's Wandering
GetNextLocation is its only caller.
`createTraceVisibleActorsIterator` shares the 309 controller. The
`native-trace-actors-oracle.py` captures cover it: 5 cases, including a
bHidden actor and hits after the world hit, plus a 6-argument short call.
Instruction coverage is 244/261. Details are in `docs/script-trace.md`.

## Geometry-driven Play probes

The shared Training probe fixture no longer assigns `FrobTarget` or
`FrobTime`. It places the test pawn near the requested actor, aims by writing
the fixture pose to `Location`, `Rotation` and `ViewRotation`, then advances
the ordinary Play tick until the original `HighlightCenterObject` trace selects
that actor. Each aim step reads the actor's current `Location` and computes its
angle from the pawn's current `Location + BaseEyeHeight`, so settling and
falling targets continue to be aimed at. A missing target is a failed probe;
the fixture does not inject the expected result.

These pose writes are isolated in `scripts/player-input-fixture.mjs` and only
set up a test vantage point. Input itself goes through `game.inputKey`,
`game.inputAxis` or `game.inputButton`, and simulation advances with
`game.tick(seconds)` so the original scheduler consumes those events. The
legacy movement adapter translates bound forward, strafe, jump and walk keys
into held User.ini key events; it does not reinterpret old yaw/pitch values as
mouse motion. Validators that need angular movement must provide explicit raw
axis samples; fixtures that need a precise sight line use the pose setup API.

Four small-object probes use scoped approach poses selected from the original
`TraceActors` query. DataCube0 uses `Location - (s, s, 0)` and Plant11 uses
`Location + (s, -s, 0)`, where `s = 48/sqrt(2)`. Their default fixture origins
hit BSP at the trace origin before the actor. Candybar0 uses
`Location + (0, -64, 0)`; from the default approach its BSP hit at `t=.309`
precedes the candybar, while this pose returns the candybar first and has no
player/world overlap. Multitool0 uses `Location - (40, 0, 0)`: in the item-pickup
sequence the default origin was clipped by BSP at `t=0`, while the scoped full
world-and-actor query hit Multitool0 first and the player did not overlap. In
every case the fixture still requires the original tick to set `FrobTarget`; it
never assigns that field. The DataCube preview uses the same target-relative
pose as its validator.

The Training nano-key route remains an authored traversal: its turn controller
feeds `MouseX`/`MouseY` through installed InputEvent bindings and adjusts later
samples from measured `ViewRotation` response. Isolated per-class checks use the
fixture's placement/aim helpers instead. Pickup, crate, keypad, datacube,
weapon-view, actor-scene, light-cache, Frob, HUD and dark-door probes now share
that geometry trace path instead of assigning the cached target themselves.

Play integration runs the original PlayerWalking `HighlightCenterObject`
bytecode on its native cadence and retains `FrobTarget` across simulation
calls. HUD paints provide the current `game.view()` result from PlayerCalcView
to the original HUD DrawDisplay path, so text drawing receives its FSceneNode.
Browser keyboard and mouse events enter through installed User.ini bindings; selection reads the cached target at use time instead of deriving a
second pitch/yaw target. UI hint visibility uses `IsHighlighted` separately,
without changing target selection. The recovered RightMouse path continues
through original `ParseRightClick` and `DoFrob`; information-device text and
HUD presentation have their own evidence in [script-text-parser.md](script-text-parser.md),
[script-play-hud.md](script-play-hud.md), and
[script-viewport-console.md](script-viewport-console.md). Reset clears
`FrobTime` and `FrobTarget` through the player-start path.

Focused verification after the fixture migration: the DataCube read validator passed
with its HUD paint, text and note lifecycle checks; the item-pickup validator
passed for Crowbar, Combat Knife, ammo, Candybar, HazMat suit and Multitool,
including reset; and the filtered Stage 3 gate passed Plant11, DataCube0,
Candybar0 and DataCube-to-ShowGoalsWindow. The dedicated Multitool filter also
passed both its Frob and fire/alt-fire probes. These are bounded original-path
comparisons, not a full Stage 3 sweep. Filtered gate runs can leave the
StaticLoadObject lifecycle coverage row open because that filter does not visit
the broader load probe.
