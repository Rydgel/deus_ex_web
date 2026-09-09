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
