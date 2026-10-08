# Core primitive casts

UnrealScript's primitive conversions are Core `GNatives` entries registered by
Core's static initialisers (`GCasts` in the SDK). The bytecode tokens
`0x39`–`0x59` are the cast codes themselves, and each handler is
`execX(FFrame& Stack, RESULT_DECL)`: it reads one token byte, evaluates the
operand into a zero-initialised local through `GNatives[token]`, converts the
local and stores the result.

The JavaScript VM already carried the casts the Training and Island scripts
reach (`ByteToInt`, `IntToFloat`, `FloatToInt/Byte`, `StringToInt`, the vector
and `…ToString` forms listed in [numeric conversions](script-numeric-conversions.md)
and [script window host](script-window-host.md)). The options menus
(`MenuChoice_*`, `MenuUIChoiceSlider`, `MenuScreenAdjustColors`) read config
text and booleans, so they reach nine more. `src/runtime/script-core-casts.mjs`
holds them; `script-vm.mjs` consults it in both the compiled path and the
tree-walking interpreter, and the Rust lowerer leaves them in JavaScript.

| Token | Cast | Core body | Behaviour |
| --- | --- | --- | --- |
| 0x3b | ByteToBool | `10131120` | `setne` on the operand byte. |
| 0x3e | IntToBool | `101314c0` | `test eax,eax; setne`. |
| 0x40 | BoolToByte | `101317b0` | `and dl,1`, stored as one byte. |
| 0x41 | BoolToInt | `10131850` | `and edx,1`, stored as a dword. |
| 0x42 | BoolToFloat | `101318f0` | `and edx,1; fild; fstp dword`. |
| 0x45 | FloatToBool | `10131be0` | `fcomp 0.0 (101765c8); test ah,0x40`: equal **or unordered** gives FALSE, so NaN is FALSE and -0 is FALSE. |
| 0x4c | StringToFloat | `101326b0` | `FSTP m32` of `appAtof` = MSVCRT `atof(appToAnsi(S))` (an empty FString reads as `L""`). |
| 0x52 | ByteToString | `10131270` | `Printf("%i", byte & 0xff)`, format at `101aaf68`. |
| 0x54 | BoolToString | `101319a0` | The constants `True` (`101a7d4c`) and `False` (`101a7dcc`); not localised. |

The registration cells come from the `mov [GNatives+4*token], eax` stores in
each static initialiser (for example `10131bb1–10131bc0` for token `0x44`).

## Checks

* `scripts/validate-core-casts.mjs` runs the original handlers for
  `0x3b 0x3e 0x40 0x41 0x42 0x45` in Unicorn
  (`scripts/native-core-cast-oracle.py`, hash-checked Core.dll; the operand
  evaluator writes each case value at the operand's own width). 30 cases are
  identical through the VM's bytecode path, including NaN/±Inf (built with
  `Divide_FloatFloat` because the package reader rejects non-finite literals),
  denormals, ±0 and the int32/byte boundaries. A mutation treating NaN as
  nonzero and one testing only the low byte of an int are both caught.
  Operands of `0x40–0x42` above 1 are not compared: the VM holds script bools
  as JavaScript booleans, so only 0 and 1 exist.
* `0x4c` is covered by `scripts/validate-msvcrt-text-hardware.mjs`: 11,551
  `atof` rows (`"0.600000"`, `".5"`, `"1e3"`, `" 7.25"`, `"12abc"`,
  denormals, overflow, 17+ digit strings, …) from the game's own MSVCRT.dll
  under Wine, with the double and its `FSTP m32` float32 both compared. See
  [value formatting](script-value-format.md).
* `0x52` and `0x54` are a printf of an int and two constants; they are checked
  against the values above, not an oracle.

## Not translated

The other cast tokens (`0x3b…0x59` not listed above and not in the VM) remain
explicit `VM expression opcode … is not supported` errors until a script
reaches them: ObjectToBool `0x47`, NameToBool `0x48`, StringToByte `0x49`,
StringToBool `0x4b`, StringToVector/Rotator `0x4d/0x4e`, VectorToBool `0x4f`,
RotatorToBool `0x51`, VectorToString `0x58`, RotatorToString `0x59`, and
StringToName `0x46`. Their handlers are at the thunk targets in the same
registration table.
