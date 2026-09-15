# Window SetWidth contract

The installed `Extension.u` declares `Window.SetWidth` as export 2079, native
1433, flags `0x401`, serial size 31, and the single float parameter `newWidth`.
The hash-checked `Extension.dll` exec thunk at `0x100521f0` parses that
argument and calls `XWindow::SetWidth` at `0x1004d040`.

SetWidth compares the requested value with the float32 zero at `0x10059884`.
Negative and unordered values become positive zero; supplied negative zero
survives. It then compares the requested width with native `Window+0x9c` using
x87 C3 (equal and unordered both skip the store). Height at `Window+0xa0` is
never read or written. A differing width is stored and the body synchronously
calls `XWindow::AskParentForReconfigure`; otherwise it returns without writes.

`src/runtime/script-window-width.mjs` preserves that access and callback order.
`scripts/native-window-width-oracle.py` executes the unchanged x86 body with
reconfiguration intercepted as a leaf. The focused validator compares ordinary
changes, unchanged values, negative/NaN clamping, signed zero, and a stored-NaN
unordered comparison:

    node scripts/validate-window-width.mjs
