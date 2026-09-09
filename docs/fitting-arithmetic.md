# AdjustSpot retained Z arithmetic

Original Engine.dll AdjustSpot at 0x103983c3 loads float32 hit time and
subtracts it from binary64 constant 1.05 at 0x1042eab0. X and Y products are
stored as float32 at 0x103983d1/da and 0x103983e9/f5. Z stays in the x87
64-bit significand through multiplication by normal Z (0x103983de), distance
(0x103983f9), and addition to position Z (0x1039841a), before the float32 store
at 0x10398422. The translation now rounds those retained operations to 64
significand bits and the final value directly to float32; a binary64 intermediate
would introduce a second rounding step at a float32 midpoint.

A controlled original FindSpot capture preceded the change. Start Z is
-111.1500015258789, first line result has time zero and normal [0,0,-1], and
extent [20,20,43] supplies distance 20. Original next Z is
-132.15000915527344; JavaScript binary64 previously produced
-132.14999389648438. The native 1.05 constant is slightly above the exact decimal,
and its retained product moves the result below the midpoint. The capture is
in ignored `.cache/reference/fitting-z-boundary{,-original}.json`, using
`scripts/native-fitting-oracle.py` and the hash-checked original DLLs.

The regression is retained in `test/fitting-arithmetic.test.mjs` and in the
controlled native fitting validator. Other FindSpot arithmetic is unchanged;
this correction does not claim blanket x87 equivalence for the entire routine.

Verification after correction: all 421 controlled native fitting cases match
exactly (the prior 420 plus this boundary). The captured composed original
level query chain also matches all 402 fitting cases (225 Training,177 Liberty),
including every point and ray argument/result; its 10,980 standalone rays remain
exact. Commands:

```sh
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-native-fitting.mjs
node scripts/validate-native-level.mjs --compare-captured
node --test test/fitting-arithmetic.test.mjs
```
