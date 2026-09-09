# Composed original level queries

`scripts/native-level-oracle.py` runs the original Engine/Core/MSVCRT routines
against decoded Training and Liberty Island geometry. The fixture retains the
original relative `Level.Actors` order, resolves inherited collision defaults and
class ancestry, and registers all actors with `bCollideActors`, including actors
that do not block players. It runs original `SetActorCollision`, hash registration,
bounds, primitive/brush/world checks, MultiLineCheck, CRT sorting and SingleLineCheck.
The hash factory supplies an already originally constructed hash; geometry and
query callbacks are not replaced. Native DLL and serialized scene/case hashes
are recorded with each capture under ignored `reports/movement/native-level/`.

The source contracts for each component are in `fitting.md`, `collision-hash.md`,
`brush-bounds.md`, `primitive-collision.md` and `extent-trace.md`. The composition
is `src/runtime/level-queries.mjs`. Its ancestry comes from original class export
superclass references, with package identity preserved by `ClassDefaults.lineage`.

All 10,980 zero-extent rays and 7,320 nonzero-extent queries match exactly across
120 Training actors and 490 Liberty Island actors. All 402 placement cases match
the complete original FindSpot query sequence, including 3,556 ray calls and
465 point checks. The combined cases exposed world point-overlap errors and two
x87 rounding boundaries; their source-derived corrections are recorded in
`point-check.md`, `extent-trace.md` and `fitting-arithmetic.md`.

Walking texture lookup uses the original ray result's Primitive (UModel) and
Item (BSP node), stored at `0x103f3a89`/`0x103f3a8c`. Another 192 composed original
ray cases verify Item, including world and owned-brush results. The walking
caller accepts world LevelInfo results and maps that node to its authored
surface texture; it does not substitute a mover or cylinder's surface.

These are reproducible original-DLL fixtures at authored transforms with resolved
defaults, not captures of a fully initialized original game session. They do not
prove startup scripts, spawn policy, live actor flags, physics scheduling,
encroachment, touch/bump events, or player registration. Point recovery vectors
and actor point-query ordering are separate from the placement boolean checks.

Play now registers original collidable actors in level order and maintains this
query structure when the existing translating-door prototype changes offsets.
The reconstructed MoveActor query prefix consumes the raw MultiLine result list;
it must not consume SingleLine's differently filtered list. The native prefix's
displacement is authoritative; multiplying input delta by adjusted time loses
the original componentwise rounding. See `move-query.md` for its explicit scope.
The application reset rebuilds original actor registration order after restoring
door offsets. The door state machine and remaining MoveActor effects still need
their own original evidence and acceptance.

```sh
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-native-level.mjs --capture-only
node scripts/validate-native-level.mjs --compare-captured
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-native-level.mjs --extents
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-native-level.mjs --surfaces
```
