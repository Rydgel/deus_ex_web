# Original MoveActor translation query

Evidence contract recorded before implementation, Engine MoveActor0x103990e0:
ordinary movable controlled-player cylinder, unchanged rotation, default four
movement flags0. A componentwise `abs(delta)<0.0001` test returns success early
when rotation is unchanged (0x1039915a–0x1039923d), with no query or translation.
The constant is original double0x1042ac40, not a vector-length epsilon.

Nontrivial delta uses sqrt(Z²+Y²+X²), stored size float but reciprocal of retained
sqrt then stored float. Direction is float(delta*reciprocal). Extended delta is
float(delta+2*direction), end=float(Location+extendedDelta).

0x103995c8 calls virtual ULevel.MultiLineCheck (+0xc8), not SingleLineCheck:
GMem, end, start, cylinder extent, checkActors=bCollideActors,
worldActor=LevelInfo iff bCollideWorld, extraNodeFlags=0. No source actor or trace
bit mask is passed; MoveActor separately selects from the ordered hit list.

Selection scans first-to-last, skips actors based on source (including self),
accepts LevelInfo if source collides with world, moving brushes if source
bCollideWorld and brush bBlockPlayers, generic actor if candidate bBlockPlayers
and source blocks the candidate category (bBlockPlayers for controlled players
or projectiles, bBlockActors otherwise). Ownership is not the SingleLine owner
filter. Nondefault ignore-pawn/base flags, source brush, actor scene mutation,
encroachment, touch/bump/base/zone events and rotation are outside this adapter.

For selected rawTime<1, original0x103997c9 stores distance=(size+2)*rawTime.
If retained distance<=2, displacement and reported time become0. Otherwise,
displacement is float(float(extendedDelta*rawTime)-float(direction*2)); reported
time separately is float((storedDistance-2)/storedSize). Multiplying original
delta by adjusted time is not equivalent. Position stores at0x10399cb6–0x10399ce9
add this displacement to Location separately per float32 component.

Native oracle will execute original prefix and final position-store instructions,
with only MultiLineCheck results supplied as controlled input and scene mutation
skipped explicitly. This proves query construction/selection/math, not omitted
MoveActor effects or fidelity of callbacks supplying the input hit list.

## Captured result and API

The first capture-only run established304 reference cases before the independent
helper. The final corpus adds96 deterministic noncardinal displacement/location
cases: **400/400 comparisons match exactly**, with five regression tests passing.
Captured fields are complete query arguments, selected input-list index, adjusted
Time, displacement and final Position. Cases cover tiny-component boundaries,
zero/nonzero movement, no hit, rawTime0/1 and intermediate hits, world/static
cylinder/controlled-player/projectile/moving-brush categories, all relevant
source/target flag combinations, self and based-on-source exclusions.

The original native prefix executes from0x103990e0. At0x103998a0 the harness
records planned translation and explicitly jumps over scene mutation checks to
original Location stores0x10399cb6; at0x10399cef it jumps over downstream scene callbacks to the original final return branch0x10399f48.
The original MultiLineCheck virtual callback alone returns a supplied ordered
44-byte FCheckResult chain. No Python movement/selection/numerical substitute
provides expected results. The captures therefore do **not** prove omitted
encroachment checks would always permit that translation.

`moveQuery({source,worldActor,start,delta,extent,multiLineCheck})` returns
`{success,delta,position,time,hit}` without mutating actor state. The hit is copied with
adjusted time; original hit Location/Normal and other caller metadata remain.
A selected Time1 record remains selected, although the full input delta is used.
Caller commits returned Position only at its appropriate movement phase.

Actor traits are deliberately explicit for this bounded path:

* `source.controlledPlayer` must be true (original GetPlayerPawn requires
  PlayerPawn ancestry and nonnull Player+0x5d4); source must not be a brush.
* `flags` uses native collision bits:1 bCollideActors,2 bCollideWorld,
  4 bBlockActors,8 bBlockPlayers. `source.static` or `source.movable===false` reproduce non-editor
  early rejection before the tiny gate. Omitted movable means the ordinary
  movable-player precondition. Editor mode and rotation changes are outside the helper.
* Candidate `controlledPlayer`, `projectile`, `movingBrush`, and `base` identify
  the recovered category and ancestry checks. Here `movingBrush` means nonnull
  Brush field and IsA(Brush), the original predicate; it is not merely a visual
  classification. The owned actor and source must retain identity across queries.
* `base` chains implement IsBasedOn, including self. The ordinary default path
  always skips actors based on source. It does not skip source's own base unless
  the separate nondefault ignore-bases argument is set; that option is unsupported.

The callback receives `{end,start,extent,checkActors,worldActor,extra}` and must
invoke the existing original ULevel.MultiLineCheck composition. `extra` is0,
not a SingleLine trace mask. Callback output is the original ordered list; do
not run SingleLineCheck's source/owner filtering or resort it by Time. The helper
selects the first qualifying blocker, preserving native equal-time ordering.
World inclusion and hash actor inclusion belong to that callback according to
`worldActor` and `checkActors`.

Default flags only: test-move, ignore-pawns/decorations, ignore-bases and no-fail
are0 in the native corpus. Movement of bases/riders, brush encroachment, collision
hash removal/reinsertion, touch/bump/zone callbacks, attachment updates and the
scene rejection branches are caller responsibilities and unimplemented by
this query helper. It returns a planned translation, not a complete scene move.

Commands:

```sh
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-native-move-query.mjs --capture-only
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-native-move-query.mjs
node --test test/move-query.test.mjs
```

Ignored results live in `reports/movement/native-move-query/`. Binary hashes are
included in each capture through the existing hash-gated native oracle. Original
map/BSP query composition needs separate combined comparisons at integration;
the supplied lists here deliberately isolate MoveActor's own behavior.


## Native boolean extension for stance

The updated capture executes the original final comparison at `10399f48`–`10399f5f`
and its original true/false epilogues. The double at `10429838` is exactly0.
Thus the accepted-scene final result is Hit.Time>0, including partial travel;
zero-time collisions return false. Tiny unchanged translation/rotation returns
true earlier. Static or non-movable actors reject before this tiny gate outside
the editor, leaving the supplied initial hit time1 and position unchanged.

The expanded404-case corpus matches all prior fields plus the captured boolean;
seven regression tests pass. `success` is the native return **for the captured
accepted-scene path**, not authority to override an omitted encroachment or other
scene rejection. A caller must preserve a scene rejection's false result. A
stance Move callback needs this boolean, not `time===1`, and must never treat the
returned result object itself as the boolean. The original downstream touch/base/
zone effects are still outside the controlled harness.
