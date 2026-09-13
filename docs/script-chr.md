# Core `Object.Chr` (native 236)

The installed GOTY `Core.u` declares:

```text
native(236) static final function string Chr ( int i );
```

The package metadata identifies `Object.Chr` as a five-byte native function
with one required `int` parameter and a string `ReturnValue`. The serialized
script is `29 5e 01`; the declaration is the source of the native index and
parameter type. The authority binary is the hash-pinned GOTY
`Core.dll` (`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`).

The exported thunk at `0x1010279d` is `e9 7e 9d 03 00` and jumps to the
unchanged body at `0x1013c520`. The body initializes a local signed `int` to
zero, reads the next expression token from `FFrame.Code`, advances past that
token, and calls the corresponding `GNatives` evaluator with the current
frame object and the local result address. After the evaluator returns, it
advances `Code` once more over `EndFunctionParms`. Therefore a one-argument
`Chr` expression advances the caller cursor by two bytes, and the int operand
is evaluated exactly once before result construction.

The returned int is narrowed by `movw` into a two-unit stack buffer: the low
16 bits become the character and the following unit is zero. There is no
range clamp or error branch in the native body. Negative and oversized int32
values therefore wrap modulo `0x10000`; `Chr(-1)` and `Chr(0xffff)` produce
the single unit `0xffff`, while `Chr(0x10001)` produces unit `1`. Unit zero
takes the empty FString path.

The body assigns that terminated stack buffer directly to the caller's
`FString` result. For a nonzero unit it calls `appStrlen` (`0x10101b04`),
adds one for the terminator, sets both `ArrayNum` and `ArrayMax` to `2`,
reallocates with element size two through `FArray::Realloc` (`0x10101753`),
and copies the two UTF-16 units. The result is thus one character plus its
terminator (`count = capacity = 2`). For unit zero it sets both counts to
zero and calls the same element-size-two realloc path, yielding the raw empty
FString form (`count = capacity = 0`). The stack source has no heap ownership
and no temporary FString destructor; the caller-owned result owns the output
buffer. The separately exported `FString::Chr` thunk `0x10102117` reaches
body `0x10145570`, whose direct construction has the same zero/nonzero
header behavior.

The logical adapter in
[`src/runtime/script-string-operations.mjs`](../src/runtime/script-string-operations.mjs)
requires a signed int32 JavaScript number, masks it to one UTF-16 code unit,
returns the empty logical string for unit zero, and uses
`String.fromCharCode` for every other unit. This preserves lone surrogate
units and the native's UTF-16 indexing. VM dispatch registers primitive 236
alongside the other Core string operations.

[`scripts/native-chr-oracle.py`](../scripts/native-chr-oracle.py) executes the
original body against the hash-verified DLL. Its int evaluator and bounded
FString allocator are explicit synchronous harness services; conversion,
copying, header writes, and cursor advancement remain native execution.
[`scripts/validate-native-chr.mjs`](../scripts/validate-native-chr.mjs)
checks the DLL/Core.u hashes, thunk/body addresses and bytes, package metadata,
all 16 oracle cases, and VM dispatch. Focused unit coverage is in
[`test/script-chr.test.mjs`](../test/script-chr.test.mjs).

The complete native allocator implementation and arbitrary raw FString
storage are outside this logical adapter; the bounded oracle only establishes
the result states described above.
