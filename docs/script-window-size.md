# Window SetSize and Resize contract

The installed `Extension.u` declares `Window.SetSize` as export 2055, native
1431, with the two float parameters `newWidth` and `NewHeight`. The hash-checked
`Extension.dll` exec thunk at `0x100520d0` passes those values to `SetSize` at
`0x10003310`, which forwards them to `XWindow::Resize` at `0x1004cf70`.

Resize compares each requested value with the float32 zero at `0x10059884`.
Negative and unordered values become positive zero; supplied negative zero
survives. It then compares the requested width with native `Window+0x9c` and,
only when x87 C3 says equal, compares height with `Window+0xa0`. C3 is set for
unordered comparisons as well as equality. If either comparison differs, the
body stores width followed by height and synchronously calls
`XWindow::AskParentForReconfigure`; otherwise it returns without writes.

`src/runtime/script-window-size.mjs` preserves that access and callback order.
`scripts/native-window-size-oracle.py` executes the unchanged x86 body with the
reconfiguration call intercepted as a leaf. The focused validator compares
ordinary changes, unchanged values, negative/NaN clamping, signed zero and a
stored-NaN unordered comparison:

    node scripts/validate-window-size.mjs
