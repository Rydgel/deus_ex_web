# Core `Object.VRand` (native 252)

`Core.u` declares `Object.VRand` as a zero-argument native function returning a
`Vector` through its `ReturnValue` struct parameter.  The GOTY `Core.dll` used
for this translation has SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`.
Its export thunk at `0x101031ed` is `e9 8e 5e 03 00` and targets the body at
`0x10139080` (body SHA-256
`0f4fdbc23dd7096e18cd650e1f8dad5f3c63691b179e7a2076865406760c03f6`).

The body increments `FFrame+0x0c` once and then repeatedly calls Core's
`appFrand` three times.  Each retained x87 sample is doubled and has the
float32 constant at `0x10177f9c` (exactly `1.0f`) subtracted before a float32
store.  The three stored components are tested as a point in the unit cube.
The x87 sum is compared with the double constant at `0x101765a8` (exactly
`1.0`); `test ah,0x41` followed by `je` retries when the ordered sum is greater
than one.  Thus every rejected or accepted attempt consumes exactly three
shared-stream `appFrand` values.

The accepted point's magnitude is recomputed from the stored float32 X/Y/Z
values, stored as a double for Core's `appSqrt` (`0x10123290`), and inverted by
the native `fdivrl 1.0`.  The reciprocal remains in the x87 extended register
until each component is multiplied and stored as float32 in X, Y, Z order.
The rejection expression retains the third `2*appFrand()-1` x87 value while
multiplying it by the stored Z; the runtime keeps that comparison exact rather
than rounding it through a JavaScript double first.

`src/runtime/script-vrand.mjs` translates this finite original stream contract.
Its small integer significand helpers model the x87 64-bit precision used by
FSQRT, reciprocal division and the final FMUL/float32 stores.  The runtime
dispatch at native index `252` requires the same shared `rng` service used by
native `Rand`/`FRand`; it evaluates no arguments.

The original oracle `scripts/native-vrand-oracle.py` executes the unchanged
Core body and CRT stream in the x86 emulator.  The validator
`scripts/validate-native-vrand.mjs` checks the binary thunk/body/constants,
`Core.u` metadata, FFrame cursor update, three-call rejection cadence, result
bits and final shared RNG state across 33 explicit seeds.  It passed with:

```sh
node scripts/validate-native-vrand.mjs
node --test test/script-vrand.test.mjs
```

This establishes `Object.VRand` and its random-stream arithmetic.  It does not
establish historic game-session seeding or the consumers that may call VRand
outside the currently prepared script subset.
