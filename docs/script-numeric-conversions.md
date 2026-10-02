# Original FloatToInt conversion

Core's execFloatToInt thunk `10102d15` jumps to `10131b40` in the hash-verified
GOTY Core.dll. The registration stores this handler in GNatives[0x44] at
`10131bb1–10131bc0`. The handler initializes a float32 local, evaluates one
expression into it, loads that float32 into x87 and calls `1016eec0`, which
forwards through IAT102ab4b8 to MSVCRT `_ftol`. It writes the low result DWORD
(EAX) to the caller at `10131b71–10131b75`.

The verified finite, signed-int64 `_ftol` path truncates toward zero and
returns its low 32 bits as the script int. The VM therefore rounds its input
to float32, truncates, and applies signed int32 wrapping. The focused probe runs the original Core handler with the
existing explicit x87 `_ftol` bridge and compares positive/negative fractions,
zero and the int32 wrap boundary. Original Conversation.CheckActorDistances
then verifies that 300.9 units converts to 300 before the `dist > 300` test.

## Nonfinite and int64 overflow

The game ships its own `System/MSVCRT.dll` (SHA-256 `e390b052…843d210`).
Its `_ftol` export at `0x78004dc1` is:

```
push ebp; mov ebp,esp; add esp,-0xc
wait; fnstcw [ebp-2]; wait
mov ax,[ebp-2]; or ah,0xc; mov [ebp-4],ax; fldcw [ebp-4]   ; RC = truncate
fistp qword [ebp-0xc]; fldcw [ebp-2]
mov eax,[ebp-0xc]; mov edx,[ebp-8]; leave; ret
```

A NaN, an infinity or a truncated value outside int64 is an invalid
operation for `FISTP`. With the invalid-operation exception masked, as in
every control word observed for the game (`037f` and `027f`), the store
writes the integer indefinite `0x8000000000000000`. FloatToInt therefore
returns 0, and FloatToByte, which stores AL, also returns 0. `-2^63` itself is
in range and has the same low DWORD.

`scripts/validate-x87-ftol-hardware.mjs` measures this. It builds
`tools/x87-ftol-probe.c` and loads a privately named copy of the game's
MSVCRT.dll, so Wine's builtin msvcrt cannot stand in; the validator asserts
the export offset `0x4dc1`. Under Wine it then runs `FLDS m32; CALL _ftol` on
the real FPU for 20,034 float32 inputs, which give 5,126 integer-indefinite
results. Each row is compared with the JavaScript VM's 0x44/0x43 bytecode, the
shared `floatToInt` and `x87ftol` helpers, and, through
`validate-script-vm-interp.mjs`, the Rust interpreter. Script float literals
are always finite (the package reader rejects others), so the fixtures build
nonfinite operands with Divide_FloatFloat. The probe's control word under Wine
is `027f`; the precision field does not affect `FISTP`.

Original content reaches this path. HangingDecoration.UpdateWind assigns
`Smerp(windTimer / windPeriod, …)` to the int rotator `wind`. `windPeriod`
is set only by `Timer()`, which BeginPlay calls only when `bRandomize` is set.
09_NYC_Ship's HangingShopLight0–2 have `bFixedSwaying` without `bRandomize`, so
every Tick divides by zero and converts a NaN. The original stores 0, and the
lights sway only along FixedSwayDirection.
