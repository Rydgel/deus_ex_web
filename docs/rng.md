# Original explicit-seed random stream

Source before translation: MSVCRT.dll rand78008936 calls the original per-thread
state lookup780015c3, reads its word+0x14, updates modulo 2^32 with
`state*214013+2531011`, then returns `(state>>>16)&32767`. srand780097ef stores
its unsigned argument directly into that same word. Original thread-data
initialization780016ce stores 1; this is not the game's startup seed.

Core appRand101232d0 jumps directly to rand. appFrand101232e0 calls rand,
FILDs the integer and multiplies by the float32 constant at10176d70,
3.0518509447574615e-5. It returns the retained x87 product without a float32
store. The product fits exactly in JavaScript binary64; a caller's float32 store
is a separate rounding operation. The maximum retained product is slightly
below1, although a float32 store rounds it to1.

Core appInit10149840 calls10102e46 at10149e2f, entering the initialization
routine1016d720. That routine clears EDI at1016d741; instructions1016d7b8–c6
call imported MSVCRT time with null, then pass its returned 32-bit word straight
to srand. There is no constant seed 1 at that game initialization call site.
Time's implementation780086e9 reads Windows clock/time-zone inputs. An exact
past game-session seed requires capturing the time result, and a later RNG
state additionally requires preserving all intervening consumers. Rendering,
scripts, collision-hash table initialization and physics can share this stream
on the same thread; a seed alone does not establish their consumption order.

Original captures must precede JavaScript comparison. Only OS TLS and last-error
bridges are supplied; native rand/srand/appRand/appFrand all execute unchanged.

## API and captured scope

`createNativeRng(seed)` requires an explicit unsigned 32-bit seed, with no default.
It returns `rand()` (also the appRand behavior), `frand()` (retained appFrand
product), a read-only `state` getter, and `seed(value)` (srand). A captured state
can initialize another stream directly. Separate instances represent separate
explicit CRT thread states; callers must decide the original thread ownership.

Nine original sequences contain 258 transitions: seven 36-call mixed sequences
at seeds 0,1,42,32767,2147483648,4294967295,1700000000, plus two three-call
sequences whose first native appFrand result hits its endpoint integer 0 or 32767.
All returned integers, retained doubles, float32 stores, and internal state
words match exactly. Those endpoint seeds were selected algebraically from the
native recurrence, then captured in the original before translation. Three
regression tests retain sequence/state restore, endpoint rounding, and explicit
seed requirements.

```sh
node scripts/validate-native-rng.mjs --capture-only
node scripts/validate-native-rng.mjs --reuse
node --test test/rng.test.mjs
```

Ignored reports are under `reports/movement/native-rng/`; capture reuse checks
input SHA256, and all three original binaries are hash-gated. The oracle uses
an allocated TLS record and bridges only GetLastError/SetLastError/TlsGetValue;
original per-thread lookup code, srand/rand, and Core wrappers run unchanged.
A tiny caller stores the returned x87 appFrand value once as float32 without
popping it and once as double, exposing the original return/store distinction.

Seed initialization is a static original instruction trace, not an observed
historic game-launch timestamp. Play now owns one shared scene stream, initialized
from the current Unix seconds as the original time(NULL) input, or an explicit
`createGame(...,{randomSeed})` value for comparison. The initial seed and current
state are exposed in diagnostics; browser scene reset restores the initial state.
Landing recovery consumes the original retained FRand result from this stream.
Future script/animation/audio consumers must share it, not create independent
physics or audio streams. Full-session random-call ordering is still incomplete
while those subsystems are absent; this does not claim the same historic game
state or all original startup calls have been replayed.

## UnrealScript FRand wrapper

Native 195 in Object.uc uses Core `execFRand`, thunk `101033cd`, body
`101362a0`. It advances FFrame.Code over EndFunctionParms, calls original
`appFrand` at `101362a7`, and stores ST0 to the float32 Result at `101362b0`.
It accepts no expressions and consumes exactly one shared-stream random value.
The common ScriptRuntime binding therefore requires an explicit shared `rng`
service and returns `Math.fround(rng.frand())`. Play passes its existing scene
stream to the script runtime, preserving the same state used by physics.

## Load-time random state in a live comparison (2026-10-13)

The live-scene pilot on 01_NYC_UNATCOIsland (docs/visual-acceptance.md "Live scenes") replays the original's ticks in
Play with the original's stream state at each tick's entry, and found the stream drawn a different number of times at
unfrozen tick 24 (original 8, Play 16 in one run; 10 and 18 in the pilot's).

**It is not an accounting difference and not a code-path difference.** Per-actor draw counts for the original
(`tools/dx-live-win.c` `actor-trace`: the stream state at every AActor::Tick entry, whose differences are the draws between
two entries) and for Play (`live-acceptance.mjs play --draw-trace`: the actor whose tick drew) agree for every
ScriptedPawn, every WaterRing and the player, tick by tick. The 8 extra draws are `SeagullGenerator1` and
`SeagullGenerator3`, four each (`PawnGenerator.GeneratePawn`), which the original makes at tick 31 and again at 47, 63;
Play at 24, 40, 56 (the same 16-tick cadence, `TryTimer = 0.25` after each). The original's call breakpoints on appRand
`0x101232d0` and appFrand `0x101232e0` name every draw's caller (script FRand `0x101362ac`, script Rand `0x1013499e`,
the Engine AI draws `0x1036d0de`/`0x1036d152`); none is a draw Play lacks in kind.

**Cause.** `PawnGenerator.PostBeginPlay` sets `TryTimer = 0.25 + FRand() * 0.75` (and with `bRandomCount` a random
`PoolCount`) from the load's stream, which the two sides do not share (the original seeds the CRT with time(NULL), Play
with its own seed). A generator first spawns when its TryTimer has run down, so Play's own draws start the same script
7 ticks earlier than the original's.

**Treatment.** Like the player's pose and OddsOfAppearing, the original's values are a measured input:
`live-acceptance.mjs original` watches `TryTimer` and `PoolCount` of every PawnGenerator, and `play` writes the last
frozen row's values into Play before its first tick. With them the stream's draw count is equal for all 100 ticks
compared, and no watched pawn differs.

### More load-time state in a live comparison (2026-10-13)

Besides the PawnGenerators' TryTimer and PoolCount, two more load-time draws decide which tick things run on and so which tick draws:
`Pawn.PostBeginPlay`'s `SightCounter = 0.2 * FRand()` (it decides on which tick each listener's visibility check, and so the player's
`ShowSelf` far-path `appFrand`, runs) and every `SetTimer(... FRand() ...)` in a PostBeginPlay (Tree: `4 + 2 * FRand()`, so a tree's
Timer, one to three draws, fires on a different tick). `live-acceptance.mjs` reads `SightCounter` and `TimerRate`/`TimerCounter` of the
pawns and of the actors Play's population step found with a running timer from the original's frozen phase and writes them into
Play before the first tick. With them, 600-tick runs of Island and the Club have equal stream draws on every tick (before: one tick
in each differed, the ghost's `ShowSelf` draw or a tree's), and the Underworld's 120.

