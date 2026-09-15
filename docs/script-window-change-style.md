# Window ChangeStyle contract

The installed `Extension.u` declares `Window.ChangeStyle` as export 1831,
native 1493, flags `0x401`, serial size 27, and no parameters. The exec thunk
at `0x100542d0` increments the script frame and calls `0x10050310`.

That wrapper calls recovered `GetRootWindow` (`0x1004c5a0`: parent `+0x138`,
type byte `+0x28` `>= 3`). A null root returns without walking. Otherwise
`0x100510c0` visits the tree:

1. `call dword ptr [vtable+0xe4]`. Window's vtable at `0x10059930` stores
   `0x10003d10`, which loads the FName global at `0x1009b3c0` and calls
   `ProcessScript` with null parameters. The static image does not intern
   that FName; UTF-16 `StyleChanged` lives at `0x10097cb4`. The slot stays a
   host leaf.
2. `GetTopChild(this, 0)` at `0x1004c6b0` — flag 0 returns `+0x140` without
   reading the visible bit.
3. While that pointer is non-null, recurse, then
   `GetLowerSibling(child, 0)` at `0x1004c650` — flag 0 returns `+0x144`.

The walk is pre-order, top child then lower siblings. `+0x13c` / `+0x148` and
`+0x30` are not read. This is not a GC drawing native.

    node scripts/validate-window-change-style.mjs
