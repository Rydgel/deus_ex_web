# Window Lower contract

The installed `Extension.u` declares `Window.Lower` as export 2125, native
1412, flags `0x401`, serial size 27, and no parameters. The exec thunk at
`0x10051930` calls `XWindow::Lower` at `0x1004c2f0`.

Lower is the inverse of recovered `XWindow::Raise`. It reads parent `+0x138`
and returns when that pointer is null. It then reads the lower sibling at
`+0x144` and returns when that pointer is null. Only a non-first child calls
the parent's `AddChild(this, 0)`, then `AskParentForReconfigure(this)` and
`CheckFocusWindow(this)`. Raise uses next sibling `+0x148` and `AddChild`
flag 1; Lower uses previous sibling `+0x144` and flag 0.

AddChild, AskParentForReconfigure, and CheckFocusWindow remain explicit
synchronous leaves. `src/runtime/script-window-lower.mjs` preserves the
guard and leaf order.

    node scripts/validate-window-lower.mjs
