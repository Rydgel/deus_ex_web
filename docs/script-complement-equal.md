# Core `ComplementEqual_StrStr` (native 124)

The installed GOTY `Core.u` declares `Object.ComplementEqual_StrStr` as a
native function at index **124**, with two required `string` parameters (`A`
and `B`) and a `bool` return. The current inventory records 147 direct
bytecode uses of this index: Engine 28, DeusEx 102, and UWindow 17.

The hash-pinned Core.dll export thunk at `0x10101f50` jumps to the unchanged
native body at `0x1013b900`. The body evaluates the two FString expressions in
declaration order, calls `appStricmp` through `0x1010239c` (wrapper body
`0x10123560`, which forwards to the imported `_wcsicmp`), and normalizes the
comparison result with `neg`/`sbb`/`inc` before writing `ReturnValue`. The
result is therefore true only when the case-insensitive comparison returns
zero. Empty FString storage (`ArrayNum == 0`) reaches Core's static empty
string path; text after a zero UTF-16 unit is ignored by the C string call.

The logical adapter in
[`src/runtime/script-string-operations.mjs`](../src/runtime/script-string-operations.mjs)
uses the same terminated-text view and folds only ASCII `A`–`Z`, preserving
non-ASCII units instead of applying host Unicode case mapping. VM native
dispatch registers index 124 as a primitive.

[`scripts/native-complement-equal-oracle.py`](../scripts/native-complement-equal-oracle.py)
executes the original `0x1013b900` instructions against the hash-verified
Core.dll. Its FFrame evaluators and `_wcsicmp` result are explicit harness
services; the oracle records both operand evaluation order and the exact
`appStricmp` arguments before the original bool normalization. The focused
validator is
[`scripts/validate-native-complement-equal.mjs`](../scripts/validate-native-complement-equal.mjs),
and the runtime checks are in
[`test/script-complement-equal.test.mjs`](../test/script-complement-equal.test.mjs).

The complete CRT locale behavior outside the ASCII cases exercised here and
the raw native FString allocator remain explicit boundaries. The browser
adapter does not claim those unmeasured storage details.
