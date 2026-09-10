# Bounded mover script natives

`src/runtime/script-mover-primitives.mjs` exposes the four original native
indices needed by the current mover paths:

```js
import { moverPrimitiveIndices, executeMoverPrimitive } from './script-mover-primitives.mjs';

moverPrimitiveIndices.has(214); // true
executeMoverPrimitive(214, [[10, 20, 30], 10]); // [1, 2, 3]
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
  as float32. The helper returns a new three-component array, preserving the
  component store boundaries and avoiding an input-array alias.
* Native `225` enters `0x10138d10`. Its established translation is shared with
  `finishVectorSize` in [mover-finish.md](mover-finish.md): the original order
  is `(Z*Z + Y*Y) + X*X`, the square root is called with the retained value,
  and the result is stored as float32.

`executeMoverPrimitive(index, args)` accepts evaluated values for `186`, `214`,
and `225`. Native `166` is the one exception: its argument must be a metadata
aware lvalue with `reference: true`, `get()`, and `set()` methods. Argument
evaluation, frame cursor movement, and generic native dispatch remain owned by
the VM.

The module covers ordinary finite float32 operands used by the two cited
scripts. It does not claim exhaustive extended-x87 edge-case equivalence for
NaN, infinities, or values outside that input contract, and it does not add a
general native-operation table.
