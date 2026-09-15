# Window GetParent contract

The installed `Extension.u` declares `Window.GetParent` as export 2093, native
1428, flags `0x401`, serial size 28, and a `Window` return value. The
hash-checked `Extension.dll` exec thunk at `0x10051f60` increments the
bytecode cursor and calls `XWindow::GetParent` at `0x1004c550`.

That body is a single dword load of native `Window+0x138` into EAX. The slot
is the same `winParent` pointer recovered by `GetRootWindow` and `AddChild`;
`UObject.Outer` at `+0x18` is not consulted. A null stored pointer returns
null. The body performs no writes.

`src/runtime/script-window-parent.mjs` preserves that single read.
`scripts/native-window-parent-oracle.py` executes the unchanged x86 body.

    node scripts/validate-window-parent.mjs
