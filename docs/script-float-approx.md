# Core `ComplementEqual_FloatFloat` (native 210)

Core.u declares the operator as:

```text
native(210) static final operator(24) bool ~= ( float A, float B );
```

The installed GOTY Core.dll export thunk at `0x10103170` jumps to
`0x101357e0`. The body evaluates both expressions into four-byte temporaries,
loads them with `fld dword`, subtracts `B` from `A` in the x87 register stack,
and uses `fcom dword [0x101765c4]` against the original zero constant to
conditionally negate the difference. It then executes
`fcomp qword [0x101765b8]` against the original double constant `0.0001` and
stores true only when the x87 C0 bit is set. Both comparisons test C0, so an
unordered NaN comparison also takes the true result branch.

The browser VM in `src/runtime/script-vm.mjs` preserves this contract with
`Math.fround` on each operand, a binary64 subtraction (which is exact for two
float32 inputs), `Math.abs(difference) < 0.0001`, and an explicit NaN result.
The comparison is strict: the nearest float32 below the threshold
(`0.00009999999747378752`) succeeds, while the nearest float32 above it
(`0.00010000000474974513`) fails. No pair of float32 operands can equal the
embedded decimal value exactly; the native `fcomp` instruction is nevertheless
strictly less-than at that boundary. Signed zero produces an absolute zero
difference and succeeds. `+Infinity` versus `+Infinity` is unordered after
the subtraction and succeeds; infinity versus a finite value fails.

`scripts/native-float-approx-oracle.py` runs the unchanged Core body in the
existing x86 emulator. `scripts/validate-native-float-approx.mjs` pins the
Core.dll hash, thunk bytes, complete body span, both constants, Core.u
declaration, frame cursor advance of three bytes (two operands plus
`EX_EndFunctionParms`), and twelve original/native result cases.

This closes the VM primitive used by later damage code such as the
`Pawn.TakeDamage` `newDamage ~= 0.0` branch. It does not prepare
`Pawn.TakeDamage` or replace the existing DamageTrigger damage boundary.
