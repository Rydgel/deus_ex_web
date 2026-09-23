# ComputerWindow native slice

`src/runtime/script-window-computer.mjs` translates the reached
`XComputerWindow` construction, `Init`, terminal configuration, and text
queue bodies from the installed Deus Ex GOTY `Extension.dll`.

The evidence image is `Extension.dll` SHA-256
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`, with
the preferred image base `0x10000000`. The focused x86 oracle rebases that
same image to `0x12000000` and intercepts only engine-owned leaves.
`scripts/validate-window-computer.mjs` checks the installed `Extension.u`
metadata, each implemented body hash, oracle addresses, constructor storage,
Init call order, and queue results.

## Constructor storage

`ComputerWindow` is export 1758, serial class size 191, and derives from
`Extension.Window`. The direct constructor is `XComputerWindow::XComputerWindow`
at `0x1000d4d0`; its InternalConstructor body is `0x100191e0`.

The InternalConstructor calls the Core UObject constructor, temporarily writes
the ExtensionObject vtable at `+0x00`, zeroes the six XClipRect dwords
`+0xd4..+0xe8`, zeroes the two FArray headers `+0x1d4..+0x1e8`, then writes the
XComputerWindow vtable `0x1005b2c8`. The direct constructor calls the XWindow
constructor with its parent, repeats the six dynamic-array dword stores, sets
bits `0x11` in `+0x190`, writes the final vtable, and sets bits `0x03` in
`+0x1c0`.

The native offsets used by this slice are:

| Storage | Offset |
| --- | ---: |
| `eventTimeInterval`, `timeNextEvent`, `timeLastEvent`, `timeCurrent` | `+0x14c`, `+0x150`, `+0x154`, `+0x158` |
| `fadeSpeed` | `+0x15c` |
| `textCols`, `textRows`, `textFont`, `fontWidth`, `fontHeight`, `FontColor` | `+0x16c`, `+0x170`, `+0x174`, `+0x178`, `+0x17c`, `+0x180` |
| packed flags (`bWordWrap`, `bFirstTick`) | `+0x190` |
| cursor color and packed cursor flags | `+0x1b0`, `+0x1c0` |
| `cursorBlinkSpeed` | `+0x1bc` |
| `TextWindow`, `Player` | `+0x1cc`, `+0x1d0` |
| `displayBuffer`, `queuedBuffer` | `+0x1d4`, `+0x1e0` |
| `TextX`, `TextY`, `inputWindow`, input flags | `+0x1f0`, `+0x1f4`, `+0x210`, `+0x214` |

## Init and CreateControls path

`XComputerWindow::Init` at `0x1000d530` first calls base
`XWindow::Init(parent)`, then calls `GetRootWindow` and `GetPlayerPawn`, storing
the result at `+0x1d0`. It reads the Player viewport FString name and compares
it with the static empty `NAME_None` string. A nonempty name sets input flag
`+0x214` bit `0x20` (`bIgnoreGamePaused`). It then creates the TextWindow
class at static address `0x100ae5b8` with `bShow=1` and stores it at `+0x1cc`.

When `textFont` and TextWindow are both non-null, Init calls `Resize` on the
ComputerWindow itself using `textCols*fontWidth` and `textRows*fontHeight`.
It sets TextWindow alignments to `(3, 3, 0, 0, 0, 0)`, creates the input
window class at `0x1009ae18` with `bShow=0`, stores it at `+0x210`, calls
`SetTextMargins(input, 0, 0)`, calls
`SetInsertionPointBlinkRate(input, 2*cursorBlinkSpeed, 0)`, and finally calls
`SetSelectability(this, 1)`.

The JavaScript module exposes each of those graph operations as a synchronous
service. The Player viewport FString graph remains an explicit
`readPlayerViewportName` service because it belongs to Engine/DeusEx object
storage outside the bounded Extension body.

## Implemented native methods

The following package exports and native indices are wired through
`ScriptRuntime.invokeNative`:

| Function | Export | Native | Body |
| --- | ---: | ---: | ---: |
| `SetTextSize` | 1822 | 1971 | `0x1000d8f0` |
| `SetTextFont` | 1828 | 1973 | `0x1000d970` |
| `SetTextTiming` | 1835 | 1975 | `0x1000db10` |
| `SetFadeSpeed` | 1837 | 1976 | `0x10031320` |
| `SetCursorColor` | 1843 | 1978 | `0x1000dab0` |
| `ShowTextCursor` | 1847 | 1980 | `0x1000daf0` |
| `ClearScreen` | 1857 | 1985 | `0x1000dcb0` |
| `Print` | 1860 | 1987 | `0x1000ddb0` |
| `EnableWordWrap` | 1897 | 2001 | `0x1000dbc0` |

`SetTextFont` appends a zeroed 0x20-byte queued event with type 1, the current
`timeNextEvent`, and the packed Color, copies `timeCurrent` to
`timeLastEvent`, then applies the same guarded ComputerWindow resize as
`SetTextSize`. `Print` clears `bWaitingForKey`, emits one event per UTF-16 code
unit, uses event type 4 for `^` (0x5e) and type 0 otherwise, stores `-1` in
the two event argument slots, clears the event flags bit, copies
`timeCurrent` to `timeLastEvent`, and advances `timeNextEvent` by
`eventTimeInterval`. The native body does not read `bNewLine`.

`ClearScreen` clears `bWaitingForKey`, empties the display FArray with element
size 0x20, and clears `TextX` and `TextY`. The module requires explicit
`arrayRealloc`, `appendQueuedEvent` (or `addZeroed` plus
`writeQueuedEvent`), and raw `read`/`write` services; this preserves allocator
ownership at the host boundary instead of replacing it with a guessed browser
array.

The direct Print temporary FString allocation/copy/free sequence is represented
by the already-resolved JavaScript string. The resulting UTF-16 event stream,
field values, and timing are bounded and validated against the original body;
allocator identity and lifetime are intentionally outside this slice.

## Shared Play root

The general HUD integration supplies `windowHost` to `createInfoLinkShellPreview`.
The shell then uses the existing DeusExRootWindow/DeusExHUD identities and the
host's native byte heap. It does not replace either initialized window or the
HUD's original receivedItems object. The original HUDInfoLinkDisplay.NewChild
and its six-control CreateControls path still execute through the shell's
previously recovered ComputerWindow boundary. ConPlay's first-person window
uses the same compatibility path.

While a DataLink/ConPlay callback runs, lifecycle calls on shell-owned windows
use that bounded implementation; calls on the general HUD use its own native
services. The general host delegates the InfoLink/ConPlay subtrees to the
existing specialized presentation and layout implementation. This is an
explicit remaining native-window gap, not a claim that ComputerWindow paint,
WindowReady, or general input handling are complete. Original actor-world
allocation is separated from DataLink playback setup so player subsystems can
exist before the full HUD's InitWindow reads them.

The existing shell, DataLink TransferObject, and player-subsystem validators
pass after this refactor. The shared native-host branch is verified with the
Play HUD integration rather than those headless shell-only cases.
