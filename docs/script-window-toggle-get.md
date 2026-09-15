# ToggleWindow GetToggle contract

The installed `Extension.u` declares `ToggleWindow.GetToggle` as export 1033,
native 1612, function flags `0x401`, serial size 28, with the single bool result
parameter `ReturnValue`. The hash-checked `Extension.dll` exec thunk at
`0x10049d80` advances the script frame past the call token, calls the method at
`0x10049a50`, and stores the returned dword into the result slot.

The method body is a leaf:

```asm
mov eax, dword ptr [ecx + 0x174]
and eax, 1
ret
```

It reads the ToggleWindow toggle-flags dword at `+0x174` and returns only bit 0
(`value & 1`). All other flag bits are masked out. There are no callees, no
stores, and no x87 operations.

## Recovered offsets

| Offset | Kind | Meaning |
| --- | --- | --- |
| `+0x174` | u32 | ToggleWindow flags; bit 0 is the toggle state (also written by `SetToggle` at `0x100499b0`) |

## Callees

None.

## Evidence

- `tools/native-registry.py Extension --index 1612`: thunk/body `0x10049d80`,
  cell `0x10098ea8`, stub `0x10049da0`.
- Method body `0x10049a50`–`0x10049a5a`, SHA-256 recorded in
  `WINDOW_TOGGLE_GET_NATIVE.bodySha256`.
- `scripts/native-window-toggle-get-oracle.py` runs the unchanged body under
  Unicorn and records the `+0x174` read plus the dword result over clear/set
  and other-bits-set states:

    node scripts/validate-window-toggle-get.mjs

Nothing is left unverified inside the method; the semantics of sibling bits in
`+0x174` are not part of this body.
