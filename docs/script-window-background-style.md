# Window SetBackgroundStyle and XGC SetStyle contract

The installed GOTY `Extension.u` declares `Window.SetBackgroundStyle` as
export 2107, native 1422. Its `NewStyle` parameter is one `ByteProperty` with
flags `0x80`; the function flags are `0x401`, serialized size is 31 bytes,
and the script body is 5 bytes. The authority for the native behavior is the
unchanged `Extension.dll` with SHA-256
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`.

## Recovered bodies

The native exec thunk is `0x10051d50..0x10051d93` (67 bytes, SHA-256
`f14b3bef26df5eb1eeb0599a7d56218a3a98800ab5a1930740ae0091e58c3bee`). It
decodes the one byte argument and calls `Window.SetBackgroundStyle` at
`0x1004d670`.

The helper body is `0x1004d670..0x1004d6c1` (81 bytes, SHA-256
`dc0d596232cb8806176aa9f9bb90d4ede0b5c91bb8937e9b6e1aedd981a0d1ed`). It
writes the low byte of `NewStyle` to `Window+0x3c`, reads the XGC pointer at
`Window+0x130`, and returns when that pointer is null. For a non-null XGC it
passes the low byte to `XGC::SetStyle` at `0x10027170`.

`XGC::SetStyle` is hash checked over `0x10027170..0x1002724b` (219 bytes,
SHA-256 `2a8943910efa1a2bdd39f38f4bd791cbc37b168fbd72068c7057578d47be89c2`).
The body first reads `XGC+0x48`, then stores the style byte at `XGC+0x44`.
For style 0 it clears bit `0x02` in the flags dword, writes the result, and
returns without generating poly flags. Every nonzero style first writes the
flags with bit `0x02` set, then writes a second style-specific result:

    style 2: (flags & ~0x18) | 0x04
    style 3: (flags & ~0x14) | 0x08
    style 4: (flags & ~0x0c) | 0x10
    other:   flags & ~0x1c

The second write is followed synchronously by `GeneratePolyFlags` at
`0x1002af00`. The bitwise operations affect the low byte and retain all
unrelated upper bits. The `style 2/3/4/other` expressions operate after the
initial nonzero write has set bit `0x02`, exactly as in the native body.

## Translation boundary and validation

`src/runtime/script-window-background-style.mjs` exposes
`setBackgroundStyleNative({window, newStyle}, services)` and the direct helper
`setGcStyleNative(gc, newStyle, services)`. Raw storage uses synchronous
`read(object, offset, kind, details)` and
`write(object, offset, kind, value, details)` services. A nonzero style
requires the synchronous `generatePolyFlags({gc, style, flags, native})`
service after the final flags write; a missing or suspended service remains an
explicit boundary. Canonical object references, byte arguments, dword values,
and synchronous service behavior are checked rather than guessed.

`scripts/native-window-background-style-oracle.py` executes the unchanged
wrapper/helper/SetStyle x86 instructions after rebasing the image and
intercepts only `GeneratePolyFlags`. It records the relevant byte/dword access
order and final fields. `scripts/validate-window-background-style.mjs` checks
the package metadata and all three body hashes, then compares the translation
against native executions for the null-GC branch, style 0, and styles 1, 2, 3,
and 4. It verifies the two nonzero flag writes and one synchronous leaf call.

    node scripts/validate-window-background-style.mjs
