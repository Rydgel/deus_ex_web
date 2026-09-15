# Window ConfigureChild contract

The installed `Extension.u` declares `Window.ConfigureChild` as export 1956,
native 1461, function flags `0x401`, serial size 40, with the four float
parameters `newX`, `newY`, `newWidth`, `NewHeight`. The hash-checked
`Extension.dll` exec thunk at `0x10052f60` marshals them and calls the method
at `0x1004ec50` (`ret 0x10`).

## Method body `0x1004ec50`–`0x1004eded`

```text
context = [0x100aeafc]                    ; current reconfigure context window
parent  = [this + 0x138]
if context != 0 and context != parent:    ; diagnostic: fname+log at line 0x2ff
if [0x100aeb04] > 0:  diagnostic          ; preferred-size depth counter
if [0x100aeb08] > 0:  diagnostic          ; granularity depth counter
lock(this)                                ; 0x1004c140: ++[this + 0x34]
[0x100aeb0c] += 1                         ; configure depth global
marks = [this + 0xb8]
visible = [this + 0x30]                   ; u8 flags byte
[this + 0xb8] = marks | 4                 ; reconfiguring bit
if visible & 1:
    changed = not x87C3Equal([this + 0x80], newWidth)       ; fld+fcomp, C3
    if not changed:
        changed = not x87C3Equal([this + 0x84], NewHeight)  ; short-circuit
    if not changed:
        changed = (marks | 4) & 1                            ; pending bit 0
    [this + 0xb8] = (marks | 4) & ~1      ; single store clears pending
    [this + 0x78] = newX                  ; store order 0x78, 0x7c, 0x80, 0x84
    [this + 0x7c] = newY
    [this + 0x80] = newWidth
    [this + 0x84] = NewHeight
    if changed:
        reconfigureChildren(this)         ; 0x10050f90 (translated below)
    if [0x100aeb0c] == 1 or [this + 0x28] >= 1:             ; depth re-read
        boundsUpdate(this)                ; 0x10051160 leaf
        ancestor = type1Ancestor(this)    ; 0x1004c560
        if ancestor != 0:
            sortWindowLists(ancestor)     ; 0x10045140 leaf
[0x100aeb0c] -= 1
unlock(this)                              ; 0x1004c150
```

The pending test folds bit 0 of the *already-marked* `marks | 4` register, so
it is the pre-existing pending bit that counts. The invisible path skips
everything between the `| 4` store and the depth decrement. The depth global
is re-read after `reconfigureChildren`, and the `+0x28` type byte is not read
at all when the depth is exactly 1. Both `fcomp` stores use x87 condition
codes: C3 is set on equal *and* unordered, so a stored NaN compares "equal"
to any argument and `-0 == +0`.

## Callee `0x10050f90` — reconfigure children (translated)

```text
; pass 1 — flat +0x148 sibling walk from +0x13c
for child in chain:
    m = [child + 0xb8]; f = [child + 0x30]
    [child + 0xb8] = m | 4
    if f & 1:
        if [child + 0x88] != 0 or [child + 0x89] != 0:
            [child + 0xb8] &= ~4          ; RMW: re-read then clear bit 2
; virtual dispatch under context/depth swap
depth = [0x100aeb00]; saved = [0x100aeafc]
[0x100aeafc] = this; [0x100aeb00] = depth + 1
this->vtable[+0x90](this)                 ; ConfigurationChanged, leaf
[0x100aeafc] = saved; [0x100aeb00] = [0x100aeb00] - 1
; pass 2 — same flat sibling walk
for child in chain:
    if [child + 0x30] & 1 and ([child + 0x88] or [child + 0x89]):
        if ([child + 0xb8] u8) & 4 == 0:  ; test byte ptr — u8 read
            [0x100aeafc] = this
            resizeChild(child)            ; 0x1004eab0 leaf
            [0x100aeafc] = saved
```

Pass 1 sets bit 2 on every child, then clears it again only for visible
children carrying an alignment byte — so exactly the visible aligned children
reach pass 2 with bit 2 clear and receive `ResizeChild`. Pass 2 reads `+0xb8`
as a single byte (`test byte ptr`), not a dword.

## Small callees (translated)

- `0x1004c140` lock: `++[this + 0x34]`.
- `0x1004c150` unlock: if `[this + 0x34] > 0` decrement it, and when
  `[this + 0x30] & 0x10` (being-destroyed) dispatch `SafeDestroy`
  (`0x1004c0b0`, leaf — same boundary `Window.Destroy` uses). A residual
  positive count still fires `SafeDestroy` when the bit is set.
- `0x1004c560` type-1 ancestor: walk `this` then `+0x138` parents, return the
  first node whose `+0x28` type byte is `>= 1`, else 0.

## Leaf callees (explicit synchronous boundaries)

- `0x10051160` bounds update: dense x87 rectangle/clip accumulation — kept as
  a leaf rather than invented.
- `0x10045140` sort window lists: CRT `qsort` with comparators over ancestor
  child lists — kept as a leaf.
- `0x1004eab0` `ResizeChild`: per-child resize callback — leaf.
- vtable `+0x90`: `ConfigurationChanged` virtual — leaf (script-overridable).
- `0x1004c0b0` `SafeDestroy` — leaf shared with `Window.Destroy`.
- Diagnostics: `fname` (`0x10059180` IAT) + `appMsgf`-style log
  (`0x100591a8` IAT) writing through `GError` (`0x100590b4` IAT) at line
  `0x2ff`; formats `0x100993c0` (context/parent), `0x1009933c`
  (preferred-size depth), `0x100992c4` (granularity depth).

## Recovered offsets

| Offset | Kind | Meaning |
| --- | --- | --- |
| `+0x00` | ptr | vtable; slot `+0x90` = configuration-changed virtual |
| `+0x28` | u8 | window type; bounds gate accepts `>= 1` |
| `+0x30` | u8 | flags; bit 0 (`0x01`) = visible, bit 4 (`0x10`) = being destroyed |
| `+0x34` | u32 | lock count |
| `+0x78`/`+0x7c` | f32 | x / y |
| `+0x80`/`+0x84` | f32 | width / height (compared before the store) |
| `+0x88`/`+0x89` | u8 | alignment bytes; nonzero = aligned |
| `+0xb8` | u32 | configuration flags; bit 0 = pending, bit 2 = reconfiguring |
| `+0x138` | ptr | parent window |
| `+0x13c` | ptr | first child (sibling-chain head) |
| `+0x148` | ptr | next sibling |

Globals: `0x100aeafc` context window pointer, `0x100aeb00` reconfiguration
depth, `0x100aeb04` preferred-size depth, `0x100aeb08` granularity depth,
`0x100aeb0c` configure depth.

## Evidence

- `tools/native-registry.py Extension --index 1461`: thunk `0x10052f60`,
  body `0x1004ec50`, cell `0x10099030`.
- Method body `0x1004ec50`–`0x1004eded`, exec `0x10052f60`–`0x10053025`,
  callee bodies `0x1004c140`–`0x1004c144`, `0x1004c150`–`0x1004c1a0`,
  `0x1004c560`–`0x1004c578`, `0x10050f90`–`0x100510bf`; SHA-256 values are
  recorded in `WINDOW_CONFIGURE_CHILD_NATIVE*` constants.
- `scripts/native-window-configure-child-oracle.py` runs the unchanged method
  plus lock/unlock/type-1-ancestor/reconfigure-children under Unicorn with
  the five leaves stubbed per object; fifteen cases cover hidden/unchanged/
  pending states, both align-clear orders, the depth-1 and type gates,
  ancestor sort, all three diagnostics, both unlock paths, and x87 NaN/-0:

    node scripts/validate-window-configure-child.mjs

Nothing inside the translated bodies is unverified. `0x10051160`,
`0x10045140`, `0x1004eab0`, the `+0x90` virtual, `0x1004c0b0`, and the
diagnostic IAT pair remain explicit synchronous leaves by design: the bounds
accumulator and qsort bodies are dense CRT/x87 code outside this native's
contract, and the rest are overridable or shared boundaries.
