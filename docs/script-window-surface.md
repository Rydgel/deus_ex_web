# Window surface setters

The final `HUDInfoLinkDisplay.CreateControls` statements configure `winLine`
through `Window.SetBackground` (native 1421) and `Window.SetTileColor` (native
1475). Authority is installed `Extension.u` and unchanged `Extension.dll`
(SHA-256 `93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`).

`XWindow::SetBackground` at `0x1004d5e0` compares the texture identity at
`Window+0xec`. A changed identity is stored and followed by
`AskParentForReconfigure`; an unchanged identity returns without a write or
callback.

`XWindow::SetTileColor` at `0x1004dae0` stores the packed RGBA dword at
`Window+0x60`, converts RGB bytes through the original `1/255` double constant
to float32 at `+0x64..+0x6c`, writes zero at `+0x70`, and, when `Window+0x130`
is non-null, mirrors the same values through `XGC::SetTileColor` at
`0x100274f0` (`XGC+0x54/+0x58`). This setter does not request reconfiguration.

`scripts/validate-window-surface.mjs` pins the package declarations and hashes
the exec/native bodies before checking the translated branch and write order.
The texture and graphics objects remain canonical references supplied by the
window host; their renderer-side sampling is Stage 4 work.
