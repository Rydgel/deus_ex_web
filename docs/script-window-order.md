# Window Raise and Hide

The installed `Extension.Window.Raise` declaration is export 2122, native1411;
`Hide` is export2091, native1414. Both have flags `0x401`, no parameters, and
serial size 27. Their unchanged Extension.dll bodies and wrappers are pinned in
`script-window-order.mjs`.

`XWindow::Raise` at `0x1004c250` reads parent `+0x138` and returns when it is
null. It then reads next sibling `+0x148` and returns when that is null. Only a
non-last child calls the parent's `AddChild(this,1)`, then
`AskParentForReconfigure(this)` and `CheckFocusWindow(this)`. The InfoLink
`winStatic` child is last when CreateControls raises it, so the recovered body
takes the verified no-op sibling branch.

`Hide` at `0x100031b0` pushes zero and directly calls the already recovered
`XWindow::SetVisibility`. Shared native1414 therefore reuses that exact
visibility translation, including the parent callback and local/effective
visibility distinction.

    node scripts/validate-window-order.mjs
