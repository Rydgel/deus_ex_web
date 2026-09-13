# Core `Divide_IntInt` (native 145)

The authority for this operator is the installed GOTY `System/Core.u` and
hash-pinned `System/Core.dll`:

```text
Core.dll SHA-256  8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4
Object.uc        native(145) static final operator(16) int / (int A, int B)
Core export      Object.Divide_IntInt (export 494)
```

The package function has expanded `scriptSize=10` and serialized bytecode
`29 7e 01 29 7f 01`. Its two non-return parameters are `int A` followed by
`int B`; the return property is the out/return `int ReturnValue`.

The export thunk at `0x10101677` is `E9 94 20 03 00` and jumps to the body at
`0x10133710`. The body performs the following sequence:

1. Read the first opcode from `FFrame.Code`, advance the cursor, and call the
   corresponding `GNatives` evaluator into a four-byte local.
2. Repeat the same operation for the second operand, retaining the caller's
   `FFrame.Object` for both evaluations.
3. Advance `FFrame.Code` once more to consume `EX_EndFunctionParms` (`0x16`).
4. Compare the signed second local with zero. If it is zero, write dword zero
   to `ReturnValue` and return without executing `IDIV`.
5. Otherwise sign-extend the first local with `CDQ`, execute signed `IDIV`,
   and write the quotient dword to `ReturnValue`.

The original machine operation therefore truncates signed division toward zero.
The divisor-zero branch returns `0`, including for a zero numerator. The one
unrepresentable signed quotient, `INT_MIN / -1`, reaches the processor divide
exception at `0x1013376c`; this browser runtime reports that reached exceptional
path explicitly instead of returning an IEEE-754 infinity or an invented wrap.

The VM implementation is in `src/runtime/script-vm.mjs`. It coerces each
operand to the original signed int32 domain, preserves left-to-right argument
evaluation, returns zero for a zero divisor, and throws an explicit error for
the signed-overflow pair. Inputs outside the reflected int32 storage domain
are represented by the same low-dword coercion used by the native body.

`scripts/native-divide-int-oracle.py` runs the unchanged wrapper/body in the
local x86 emulator. Its replacement evaluator only supplies operand values and
records the two evaluation events. `scripts/validate-native-divide-int.mjs`
pins the DLL hash, thunk/body bytes, Core.u declaration and bytecode metadata,
then compares ten original cases covering signed signs, truncation, int32
boundaries, the zero-divisor guard, operand order and the overflow exception.

The probe establishes the GOTY Core build only. It does not claim behavior for
other Unreal Engine binaries, malformed FFrame pointers, non-int property
storage, or exception handling outside this native body.
