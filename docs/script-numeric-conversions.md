# Original FloatToInt conversion

Core's execFloatToInt thunk `10102d15` jumps to `10131b40` in the hash-verified
GOTY Core.dll. The registration stores this handler in GNatives[0x44] at
`10131bb1–10131bc0`. The handler initializes a float32 local, evaluates one
expression into it, loads that float32 into x87 and calls `1016eec0`, which
forwards through IAT102ab4b8 to MSVCRT `_ftol`. It writes the low result DWORD
(EAX) to the caller at `10131b71–10131b75`.

The verified finite, signed-int64 `_ftol` path truncates toward zero and
returns its low 32 bits as the script int. The VM therefore rounds its input
to float32, truncates, and applies signed int32 wrapping. Nonfinite and int64
overflow values remain explicit unsupported cases, matching the existing
FloatToByte scope. The focused probe runs the original Core handler with the
existing explicit x87 `_ftol` bridge and compares positive/negative fractions,
zero and the int32 wrap boundary. Original Conversation.CheckActorDistances
then verifies that 300.9 units converts to 300 before the `dist > 300` test.
