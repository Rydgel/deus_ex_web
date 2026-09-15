# Window SetWindowAlignments contract

The installed `Extension.u` declares `Window.SetWindowAlignments` as export
2054, native 1438, flags `0x401`, serial size 46, with parameters `HAlign`,
`VAlign`, `hMargin0`, `vMargin0`, `hMargin1`, and `vMargin1`. The four floats
are optional and the exec thunk initializes omitted values to zero. The
hash-checked `Extension.dll` exec thunk at `0x10052360` calls
`XWindow::SetWindowAlignments` at `0x1004d300`.

The C++ body compares, in order:

1. requested `HAlign` against the zero-extended byte at `Window+0x88`;
2. requested `VAlign` against `Window+0x89`;
3. `hMargin0` against float32 `Window+0x8c` (the same slot as `SetPos` X);
4. `hMargin1` against float32 `Window+0x90`;
5. `vMargin0` against float32 `Window+0x94` (the same slot as `SetPos` Y);
6. `vMargin1` against float32 `Window+0x98`.

Byte compares are integer `cmp`. Float compares use x87 C3; equal and unordered
values (including NaN) are treated as unchanged, and signed zero compares
equal. The first difference takes the store path and skips remaining compares.

Stores, when taken, write `+0x88`, `+0x8c`, `+0x89`, `+0x94`, `+0x90`, `+0x98`
in that order, then synchronously call `AskParentForReconfigure` at
`0x1004e060`. Alignment bytes keep only the low 8 bits.

`src/runtime/script-window-alignments.mjs` preserves that compare/store order.
`scripts/native-window-alignments-oracle.py` executes the unchanged x86 body.

    node scripts/validate-window-alignments.mjs
