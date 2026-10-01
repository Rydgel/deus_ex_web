# Bounded mover script natives

`src/runtime/script-mover-primitives.mjs` exposes three of the four original
native indices needed by the current mover paths; the fourth, `214`, runs the
x87 kernel's DivideEqual_VectorFloat body in `script-vm.mjs` since 2026-10-01
(docs/script-float-vector-operators.md, "Host-arithmetic operators"):

```js
import { moverPrimitiveIndices, executeMoverPrimitive } from './script-mover-primitives.mjs';

moverPrimitiveIndices.has(225); // true
executeMoverPrimitive(225, [[3, 4, 0]]); // 5
```

The declarations are from the installed original `Object.uc`:

| index | original declaration | current use |
| ---: | --- | --- |
| `166` | `postoperator int -- (out int A)` | `Mover.InterpolateEnd`'s `ClientUpdate--` |
| `186` | `function float Abs(float A)` | `DeusExMover.FinishNotify` distance tests |
| `214` | `operator(16) vector / (vector A, float B)` | `DeusExMover.FinishNotify` bounding-box center/area |
| `225` | `function float VSize(vector A)` | both distance paths |

The source declarations are `.cache/reference/Object.uc:149`, `:178`,
`:199`, and `:215`. The two call sites are
`.cache/reference/Mover.uc:353–383` and
`.cache/reference/DeusExMover.uc:148–202`.

The native implementation authority is the local Deus Ex GOTY
`System/Core.dll`, SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`:

* Native `166` enters `0x101348a0`. It evaluates the operand lvalue, copies
  the old signed dword to the result, decrements the same address, and returns
  the old value. `executeMoverPrimitive(166, [ref])` therefore reads once,
  stores `(old - 1) | 0`, and returns `old`; it rejects a non-reference first
  argument rather than silently mutating a temporary.
* Native `186` enters `0x10135c60`. It evaluates one float, compares the
  stored value with the +0 constant at `0x101765c4`, stores it unchanged when
  nonnegative, and applies x87 `FCHS` only for a negative value. The helper
  rounds the argument to float32 and preserves `-0` (a plain `Math.abs` would
  change it to `+0`).
* Native `214` enters `0x10137ab0`. It evaluates the vector before the scalar,
  forms a retained x87 reciprocal from the 1.0 constant at `0x101765a8`,
  multiplies each float component by that reciprocal, and stores each result
  as float32. This was a double reciprocal here; it is now the kernel body it
  shares with 222, whose 80-bit reciprocal the oracle observes
  (`divvf-recip-extended`).
* Native `225` enters `0x10138d10`. Its established translation is shared with
  `finishVectorSize` in [mover-finish.md](mover-finish.md): the original order
  is `(Z*Z + Y*Y) + X*X`, the square root is called with the retained value,
  and the result is stored as float32.

`executeMoverPrimitive(index, args)` accepts evaluated values for `186` and
`225`. Native `166` is the one exception: its argument must be a metadata
aware lvalue with `reference: true`, `get()`, and `set()` methods. Argument
evaluation, frame cursor movement, and generic native dispatch remain owned by
the VM.

The module covers ordinary finite float32 operands used by the two cited
scripts. `225`'s NaN components follow the x87 rules (`vsize-*` oracle
cases); otherwise it does not claim exhaustive extended-x87 edge-case
equivalence for infinities or values outside that input contract, and it does
not add a general native-operation table.
