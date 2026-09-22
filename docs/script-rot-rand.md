# Core `Object.RotRand` (native 320)

`Core.u` declares `native(320) static final function rotator RotRand(optional
bool bRoll)` (flags `0x2401`: final, native, static; `bRoll` is an optional bool
parm, `ReturnValue` a struct).  In the GOTY `Core.dll` (SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`) the
registration stub at `0x10139271` loads the cell `0x101aa940`
(`intUObjectexecRotRand`, holding the export thunk `0x10102ebe`) into
`GNatives + 0x500` (`0x101f46b8`, base `0x101f41b8`, index 320).  The thunk is
`e9 ed 62 03 00` → body `0x101391b0` (140 bytes to the `ret 8` at
`0x10139239`, SHA-256 `8cce96f7…14f04940`).

The body:

1. `P_GET_UBOOL_OPTX(bRoll, 0)`: zeroes a DWORD, reads one token from
   `FFrame.Code` (`+0x0c`), advances it and calls `GNatives[token](Stack,
   &bRoll)`.  An omitted trailing optional is compiled with no argument token
   (`Projectile.RandSpin` has `61 40 16`), so the token read is
   `EX_EndFunctionParms` (0x16), whose handler (`0x1012f770`) decrements
   `Code` and leaves the zero; `EX_Nothing` (0x0b, `0x1012f660`) leaves it too.
2. `P_FINISH`: `inc FFrame.Code` (`0x101391da`).
3. `Yaw = (2*appRand()) % 65535` (`shl eax,1; cdq; idiv 0xffff`), then
   `Pitch` the same from the next value, then `Roll` from a third value only when
   `bRoll != 0` (`test eax,eax`), else `Roll = 0`.  `appRand` (`0x101032ec` →
   `0x101232d0`) tail-jumps to MSVCRT `rand` through `[0x102ab4fc]`, so every
   component is `2*rand()` in `[0, 65534]` and the modulus never changes it.
4. Stores `Pitch, Yaw, Roll` (int32) to the result.

`src/runtime/script-rot-rand.mjs` exports `execRotRand(call, {rng})` returning
`[Pitch, Yaw, Roll]`; the script runtime binds it at native index 320 next to
VRand, on the same shared `rng` stream (`src/runtime/rng.mjs`).  A missing or
`undefined` (EX_Nothing) argument is `bRoll = false`; `true`/nonzero rolls.

Validation executes the unchanged body in the emulator.  The four argument
token handlers are installed into the emulator's `GNatives` from Core's own
registration cells (`0x101aa6a4` EX_Nothing, `0x101aa6ac` EX_EndFunctionParms,
`0x101aa714` EX_True, `0x101aa718` EX_False), whose indexes were read from their
registration stubs, because static initializers do not run there.

```sh
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-native-rotrand.mjs
node --test test/script-rot-rand.test.mjs
```

Result: **132 cases** (33 seeds × {omitted, EX_Nothing, EX_True, EX_False}):
rotator components, CRT `rand` call count (2, or 3 with bRoll), FFrame cursor
advance and final shared RNG state all match.  The validator also pins the
binary registration/thunk/body bytes and the `Core.u` signature.

Consumer: `Projectile.RandSpin` (`DesiredRotation = RotRand(); RotationRate.* =
spinRate*2*FRand() - spinRate`), called from `Fragment` state `Flying`'s
`BeginState` during fragment spawn.  Historic game-session seeding is outside
this evidence.
