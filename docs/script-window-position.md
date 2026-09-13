# Window SetPos and Move contract

The installed `Extension.u` declares `Window.SetPos` as export **2068**, a
native-final function with native index **1432**, flags `0x401`, serial size
`34`, and the float parameters `newX` and `newY`.  The authority for the
native behavior is the unchanged GOTY `Extension.dll`, whose SHA-256 is
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`.

## Recovered bodies

The `execSetPos` thunk occupies preferred address range
`0x10052160..0x100521cf` (exclusive end), and reads the two script float
parameters before calling the exported `XWindow::SetPos` helper at
`0x100032f0`.  The thunk hash is
`217e4fe092cdae7e4a572c76aca9c1deb33fbcda228a2c17bef72b8fabda0ff9`.

The helper range is `0x100032f0..0x10003302`, hash
`cd767b44d519592539d7a96bb2623345de488ab4ac9b6e3f8a0416c7c70338e1`.  It
pushes the two float arguments in reverse stack order, calls
`XWindow::Move` at `0x1004ce80`, and returns with `ret 8`.

The normal `XWindow::Move` body occupies `0x1004ce80..0x1004cf32`, hash
`95b43187b1f101475811136b3b98969a5fcdb50405f450bd4677e28d533327b6`.
It first reads the byte at `this+0x88`.  A nonzero value jumps directly to the
store path; otherwise it reads `this+0x89`, and a nonzero value also forces the
store path.  Thus the first alignment byte controls whether the second byte is
read, and either nonzero alignment byte forces an update.

When both alignment bytes are zero, the body compares `newX` with the raw
float32 at `this+0x8c`.  If that x87 `fcoms` result is equal, it compares
`newY` with the raw float32 at `this+0x94`.  The native tests the x87 C3 bit;
equal and unordered values, including NaNs, take the unchanged return.  A
changed position takes the following synchronous sequence:

1. write byte `this+0x88 = 0`;
2. write byte `this+0x89 = 0`;
3. write float32 `this+0x8c = newX`;
4. write float32 `this+0x94 = newY`;
5. call `XWindow::AskParentForReconfigure` at `0x1004e060`.

The stores retain the exact float32 argument bits supplied to the native
helper.  Signed zero compares equal, and the raw bytes of a stored NaN remain
untouched when the comparison is unordered.

## Translation and verification

`src/runtime/script-window-position.mjs` exposes the recovered body as
`moveWindowNative` and aliases it as `setWindowPositionNative` and
`setWindowPosNative`.  Raw fields use synchronous
`read(object, offset, kind, details)` and
`write(object, offset, kind, value, details)` services with `kind` `u8` or
`f32`.  `askParentForReconfigure` is an explicit synchronous leaf.  The
adapter preserves the native short-circuit and read/write order, rejects
suspended services and malformed storage values, and does not infer browser
layout behavior.

The focused oracle
`scripts/native-window-position-oracle.py` rebases the unchanged DLL to
`0x12000000`, executes the original `SetPos` helper and `Move` body with
Unicorn, and intercepts only `AskParentForReconfigure`.  The validator
`scripts/validate-window-position.mjs` checks the package metadata, DLL hash,
all three native body hashes, helper addresses, and seven reference cases:
alignment-forced updates, x and y changes, an unchanged position, signed
zero, and an unordered stored NaN.  It compares raw access order, exact bits,
final alignment bytes, final positions, and callback order.

Run the focused check with:

    node scripts/validate-window-position.mjs

The original reconfiguration body remains the separate boundary documented in
`docs/script-window-reconfigure.md`; the position adapter only guarantees the
call into that service after the four native stores.
