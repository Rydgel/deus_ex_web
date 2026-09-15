# ToggleWindow SetToggle contract

The installed `Extension.u` declares `ToggleWindow.SetToggle` as export 1043,
native 1611, function flags `0x401`, serial size 31, with the single bool
parameter `bNewToggle`. The hash-checked `Extension.dll` exec thunk at
`0x10049d10` marshals the argument and calls the method at `0x100499b0`.

## Method body `0x100499b0`–`0x10049a1c`

```text
flags = [this + 0x174]
if ((flags & 1) == bNewToggle) return
[this + 0x174] = flags ^ ((flags ^ bNewToggle) & 1)   ; bit-0 toggle, others kept
updateToggleStyle(this)        ; 0x10008380
notifyToggleChanged(this)      ; 0x10049910
```

Both callees run only when bit 0 actually changes; the early return is taken
before any store or callback.

## Callee `0x10008380` — style refresh

```text
walk = this
while walk != 0 and ([walk + 0x30] & 2):     ; +0x30 flags byte, bit 1 = sensitive
    walk = [walk + 0x138]                    ; parent
if walk != 0:
    state = 2                                 ; an ancestor was insensitive
else:
    state = isFocusWindow(this) != 0 ? 1 : 0  ; 0x1004ca20
toggle = [this + 0x174] & 1                   ; re-read after the store
index = state * 2 + toggle                    ; six-entry table at +0x1a4
f0 = [this + 0x1a4 + index*12]
f1 = [this + 0x1a8 + index*12]
f2 = [this + 0x1ac + index*12]
if f0 == 0:
    f0 = toggle ? ([this + 0x1b0] or [this + 0x1a4]) : [this + 0x1a4]
[this + 0x18c] = f2                           ; store order 0x18c, 0x184, 0x188
[this + 0x184] = f0
[this + 0x188] = f1
```

`isFocusWindow` (`0x1004ca20`) calls `getRootWindow` (`0x1004c5a0`), which
climbs `+0x138` to the topmost window and keeps it only when its `+0x28` type
byte is `>= 3`; it then returns `[root + 0x5c8] == this` as 0/1. A null root
returns 0 without reading `+0x5c8`.

## Callee `0x10049910` — toggle-changed notify

```text
cur = this
while cur != 0:
    t = [this + 0x174] & 1                    ; receiver's flags, re-read per node
    if cur->vtable[+0xf0](this, t) != 0:      ; ToggleChanged(source, toggle)
        return
    cur = [cur + 0x138]
```

The virtual is dispatched on each ancestor starting with the receiver itself,
through that node's own `+0x00` vtable slot `+0xf0`. This is the only leaf
boundary: the runtime calls `services.toggleChanged` and stops on a nonzero
result. The vtable fetch itself stays inside the leaf.

## Recovered offsets

| Offset | Kind | Meaning |
| --- | --- | --- |
| `+0x00` | ptr | vtable; slot `+0xf0` is the toggle-changed virtual |
| `+0x28` | u8 | window type; root walk accepts `>= 3` |
| `+0x30` | u8 | flags byte; bit 1 (`0x02`) = sensitive |
| `+0x138` | ptr | parent window |
| `+0x174` | u32 | ToggleWindow flags; bit 0 = toggle state |
| `+0x184`/`+0x188`/`+0x18c` | ptr | active style triple (f0, f1, f2) |
| `+0x1a4`..`+0x1eb` | ptr[6][3] | style table, indexed `(state*2 + toggle)` |
| `+0x5c8` | ptr | root window's focused window |

## Evidence

- `tools/native-registry.py Extension --index 1611`: thunk `0x10049d10`,
  body `0x100499b0`, cell `0x10098ea4`.
- Method body `0x100499b0`–`0x10049a1c`, exec `0x10049d10`–`0x10049d56`,
  callee bodies `0x10008380`–`0x10008441`, `0x1004ca20`–`0x1004ca86`,
  `0x1004c5a0`–`0x1004c5bf`, `0x10049910`–`0x100499a2`; SHA-256 values are
  recorded in `WINDOW_TOGGLE_SET_NATIVE*` constants.
- `scripts/native-window-toggle-set-oracle.py` runs the unchanged method and
  the three internal callees under Unicorn with the `+0xf0` virtual stubbed
  per object; ten cases cover the early return, all six table indices, both
  field-0 fallback orders, and the notify walk's stop/exhaust/self paths:

    node scripts/validate-window-toggle-set.mjs

Nothing inside the translated bodies is unverified; the `+0xf0` virtual's own
body remains an explicit synchronous leaf by design (it is script-overridable
behaviour, not part of this native).
