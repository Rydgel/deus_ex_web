# Core int/byte operator natives

The authority for these operators is the installed GOTY `System/Core.u` and
hash-pinned `System/Core.dll`:

```text
Core.dll SHA-256  8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4
Object.uc         the fourteen native() declarations quoted below
```

Each thunk below is the exported `UObject::exec*` entry; its `E9` jump targets
the recovered body.  Native indices, parameter `out` flags, operator
precedence and serialized script bytes are taken from the Core.u exports, not
assumed from the declaration text.

| Index | Declaration | Thunk | Body | Key instruction |
| --- | --- | --- | --- | --- |
| 135 | `operator(34) byte += (out byte A, byte B)` | `0x101011bd` | `0x10132f50` | `02c2` `add al,dl` at `0x10132fc0`, `8807` `mov [edi],al` |
| 138 | `preoperator byte -- (out byte A)` | `0x101016e0` | `0x101331d0` | `fec9` `dec cl` at `0x10133213`, `8808` `mov [eax],cl` |
| 139 | `postoperator byte ++ (out byte A)` | `0x1010189d` | `0x10133290` | `fec0` `inc al` at `0x101332dd` |
| 140 | `postoperator byte -- (out byte A)` | `0x10103215` | `0x10133350` | `fec8` `dec al` at `0x1013339d` |
| 141 | `preoperator int ~ (int A)` | `0x10102a68` | `0x10133410` | `f7d1` `not ecx` at `0x10133448` |
| 143 | `preoperator int - (int A)` | `0x10103323` | `0x10133590` | `f7d9` `neg ecx` at `0x101335c8` |
| 148 | `operator(22) int << (int A, int B)` | `0x101020f4` | `0x10133990` | `d3e2` `shl edx,cl` at `0x101339ef` |
| 149 | `operator(22) int >> (int A, int B)` | `0x101030d5` | `0x10133a60` | `d3fa` `sar edx,cl` at `0x10133abf` |
| 156 | `operator(28) int & (int A, int B)` | `0x1010324c` | `0x10134010` | `23d0` `and edx,eax` at `0x10134068` |
| 157 | `operator(28) int ^ (int A, int B)` | `0x10102482` | `0x101340e0` | `33d0` `xor edx,eax` at `0x10134138` |
| 158 | `operator(28) int \| (int A, int B)` | `0x101024c8` | `0x101341b0` | `0bd0` `or edx,eax` at `0x10134208` |
| 163 | `preoperator int ++ (out int A)` | `0x101012e4` | `0x10134660` | `41` `inc ecx` at `0x101346a6`, `8908` `mov [eax],ecx` |
| 164 | `preoperator int -- (out int A)` | `0x10101537` | `0x10134720` | `49` `dec ecx` at `0x10134766`, `8908` `mov [eax],ecx` |
| 196 | `operator(22) int >>> (int A, int B)` | `0x101021e9` | `0x101334c0` | `d3ea` `shr edx,cl` at `0x1013351f` |

## Recovered semantics

Every body reads each operand token from `FFrame.Code`, advances the cursor,
dispatches through the evaluator table at `0x101f41b8` with the caller's
`FFrame.Object`, then increments `Code` once more to consume
`EX_EndFunctionParms` (`0x16`).  Operands evaluate strictly left to right.

The pure int operators evaluate each operand into a DWORD stack temporary and
execute the machine instruction in the table: `~` is `NOT`, unary `-` is
`NEG`, `<<`/`>>`/`>>>` are `SHL`/`SAR`/`SHR` with the hardware count masking
(`CL & 31`), and `&`/`^`/`|` are `AND`/`XOR`/`OR`.  `NEG` of `INT_MIN`
returns `INT_MIN`; shift counts of 32, 33, 255 and -1 all alias to `& 31`
counts, so `A >> 32` is `A` and `A >>> -1` shifts by 31.  `>>` sign-extends
(`INT_MIN >> 4 = 0xf8000000`) while `>>>` zero-fills (`INT_MIN >>> 4 =
0x08000000`); the `>>>` dword stores back into the signed `int` result.

The six `out`-parameter operators clear `GPropAddr` (`0x101e32f8`, written by
`c705f8321e1000000000`) before the arg0 `Step`.  `execLocalVariable` /
`execInstanceVariable` publish the variable's address there and still copy
the value to the destination, so the body uses `GPropAddr` when it is nonzero
and the stack temporary otherwise:

- **Preoperators** 138 (`--` byte), 163 (`++` int), 164 (`--` int) mutate the
  target through that pointer and write the NEW value to `ReturnValue`.
- **Postoperators** 139 (`++` byte), 140 (`--` byte) write the OLD value to
  `ReturnValue` first, then increment/decrement the target.
- **`+=` byte** 135 loads `*ptr` into `al`, adds the evaluated `byte B`, and
  stores the sum byte to both `*ptr` and `ReturnValue`.

The byte operators read and write single bytes, so results wrap mod 256
(`255 + 1 = 0`, `0 - 1 = 255`); the int `++`/`--` wrap mod 2^32
(`INT_MAX + 1 = INT_MIN`, `INT_MIN - 1 = INT_MAX`).

The temporary fallback is observable: a non-lvalue arg0 leaves `GPropAddr`
zero, the body mutates only the temporary, and the result is still returned.
For the byte operators the temporary is one byte located below the caller's
saved return address, so only byte-writing evaluators (the `execIntToByte`
shape) reach it intact — an `execIntConstByte`-style DWORD store at that
destination overwrites the return address and the emulated `ret 8` jumps into
the import-thunk region.  Compiled UnrealScript never emits non-lvalue `out`
arguments, so the fallback is not reachable from shipped bytecode either way.

## Validation

`scripts/native-int-operators-oracle.py` executes the unchanged bodies in the
local x86 emulator.  Its replacement evaluators only supply operand values —
dword, dword-extended byte and single-byte stores for non-lvalue operands,
and the `GPropAddr` lvalue contract for `lint`/`lbyte` operands — and record
the evaluation events, the mutated variable and `GPropAddr` after the call.

`scripts/validate-native-int-operators.mjs` pins the DLL hash, thunk/body
bytes, the instruction pins above, the `GPropAddr` clears, Core.u
declarations, indices, precedence, serialized script and parameter `out`
flags, then compares all 80 original cases against the VM bit-exact —
covering negative operands, shift counts 0/31/32/33/255/-1, `INT_MIN` and
`INT_MAX` boundaries, byte wraparound at 0 and 255, the signed-vs-unsigned
`>>`/`>>>` difference, pre/post return values, lvalue mutation and the
temporary fallback — plus left-to-right evaluation and result-store width.

## Unverified scope

The probe establishes the GOTY Core build only.  The DWORD-store corruption
described for non-lvalue byte `out` arguments is recorded from the emulated
jump target, not from a Windows crash trace.  The VM skips assignment for
non-reference arg0 (returning the computed value), which matches the original
temporary fallback's observable behavior; the corrupting evaluator variant is
deliberately not reproduced.  `GPropObject` (`0x101e32c0`) is written by the
real variable evaluators but never read by these bodies, so the probe does
not populate it.  Other natives sharing these bodies' patterns but outside
the fourteen listed indices remain unbound.
