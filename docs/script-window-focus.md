# Window SetFocusWindow contract

The installed `Extension.u` declares `Window.SetFocusWindow` as export 2058,
native 1440, flags `0x401`, serial size 31, with `NewFocusWindow` and a bool
return. The exec thunk at `0x10052690` calls `XWindow::SetFocusWindow` at
`0x1004f0e0`.

The recovered body:

1. Calls `GetRootWindow` (`0x1004c5a0`) on `this` using parent `+0x138` and
   type byte `+0x28` (`>= 3`).
2. If `NewFocusWindow` is non-null, walks that object's parent chain until
   `+0x30` bit `0x04` (`bIsSelectable`) is set. A chain with no selectable
   window keeps the original pointer.
3. A null root returns 0. If `RootWindow+0x5c8` already equals the resolved
   focus pointer, it returns 1.
4. A non-null focus calls `0x1004c460(this=focus, 1)` as a host leaf. A zero
   result returns 0 without writing `+0x5c8`.
5. `0x1004c580` (type `>= 2` ancestor walk) then writes the focus pointer to
   that ancestor's `+0x178` when the ancestor exists.
6. It rereads `RootWindow+0x5c8`, stores the new pointer, and:
   - old focus: vtable `+0xac`, read `+0x108`, `0x1004ffb0` with `-1.0`/`1.0`,
     then vtable `+0xb4(old)` up the `+0x138` chain;
   - reloads `+0x5c8`; new focus: read `+0x84` then `+0x80`, `0x1004e230(0,0,
     +0x80, +0x84)`, read `+0x104`, `0x1004ffb0`, vtable `+0xa8`, then vtable
     `+0xb0(new)` up the parent chain.

`0x1004e230` and `0x1004ffb0` contain `fst`/`fstp` layout math and stay
explicit leaves. The four vtable slots are `ProcessScript` thunks; this
adapter does not intern their FName globals.

    node scripts/validate-window-focus.mjs
