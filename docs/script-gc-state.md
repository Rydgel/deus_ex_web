# XGC graphics-context drawing state (Extension natives 1200-1272)

Authority is the shipped Extension.dll SHA-256
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`
(preferred image base `0x10000000`; the Unicorn oracle maps it at
`0x12000000`). Exec-body addresses come from `tools/native-registry.py`
(GRegisterNative stubs); every real method body below was recovered by
disassembling the exec trampoline to its `call` target. The per-native
JavaScript translations live in `src/runtime/script-gc-<name>.mjs`, share the
field model in `src/runtime/script-gc-state-model.mjs`, and are compared
bit-exact against the original bodies executed under Unicorn by
`scripts/native-gc-probe.py` / `scripts/native-gc-<name>-oracle.py` /
`scripts/validate-gc-<name>.mjs`.

Note: `src/runtime/script-gc.mjs` / `script-gc-bridge.mjs` are the Core
*garbage collector*, unrelated to this `GC` (UnrealScript class
`Extension.GC`, the C++ graphics context).

This note records drawing **state** only. The draw and measure natives
(1280 GetTextExtent, 1281 GetFontHeight, 1282-1289 Draw*) need a render
surface and font glyph data and are out of scope here. 1295 `ClearZ` is
also out of scope: its body `0x1002ae40` reads `this+0x28` (canvas), then
`canvas+0x78` (viewport) `+0x64` (render device) and calls virtual slot
`0x90` of the device with `canvas+0x7c` as the argument — it reaches
`URenderDevice`, so it is not state and is not implemented.

## Native table

Exec trampoline = the UnrealScript param-marshalling body registered with
GRegisterNative. "inline" means the exec body itself performs the field
access with no method call.

| native | export | function | method body | exec |
| ---: | ---: | --- | --- | --- |
| 1200 | 2010 | `Intersect(float ClipX, float ClipY, float clipWidth, float clipHeight)` | `0x10027000` | `0x1002af40` |
| 1210 | 2015 | `EnableSmoothing(bool)` | `0x100270e0` | `0x1002b030` |
| 1211 | 2017 | `IsSmoothingEnabled() : bool` | inline `(+0x48) & 1` | `0x1002b0a0` |
| 1212 | 2019 | `SetStyle(byte NewStyle)` | `0x10027170` | `0x1002b0e0` |
| 1213 | 2021 | `GetStyle() : byte` | inline byte `+0x44` | `0x1002b150` |
| 1214 | 2023 | `EnableDrawing(bool)` | `0x10027280` | `0x1002b190` |
| 1215 | 2025 | `IsDrawingEnabled() : bool` | inline `(+0x48 >> 1) & 1` | `0x1002b200` |
| 1216 | 2027 | `EnableMasking(bool)` | `0x100272a0` | `0x1002b240` |
| 1217 | 2029 | `IsMaskingEnabled() : bool` | inline `(+0x48 >> 2) & 1` | `0x1002b2b0` |
| 1218 | 2031 | `EnableTranslucency(bool)` | `0x10027330` | `0x1002b2f0` |
| 1219 | 2033 | `IsTranslucencyEnabled() : bool` | inline `(+0x48 >> 3) & 1` | `0x1002b360` |
| 1220 | 2035 | `EnableModulation(bool)` | `0x100273c0` | `0x1002b3a0` |
| 1221 | 2037 | `IsModulationEnabled() : bool` | inline `(+0x48 >> 4) & 1` | `0x1002b410` |
| 1230 | 2039 | `SetTileColor(Color)` | `0x100274f0` | `0x1002b450` |
| 1231 | 2041 | `GetTileColor(out Color)` | inline dword `+0x54` | `0x1002b4b0` |
| 1240 | 2043 | `SetTextColor(Color)` | `0x10027580` | `0x1002b530` |
| 1241 | 2045 | `GetTextColor(out Color)` | inline dword `+0x68` | `0x1002b590` |
| 1242 | 2047 | `SetFont(Font)` | `0x10027640(font, font)` | `0x1002b6c0` |
| 1243 | 2049 | `SetNormalFont(Font)` | `0x10027660` | `0x1002b730` |
| 1244 | 2051 | `SetBoldFont(Font)` | `0x10027670` | `0x1002b7a0` |
| 1245 | 2053 | `SetFonts(Font normal, Font bold)` | `0x10027640` | `0x1002b810` |
| 1246 | 2056 | `GetFonts(out Font, out Font)` | inline `+0x7c`, `+0x80` | `0x1002b8a0` |
| 1247 | 2059 | `EnableTranslucentText(bool)` | `0x10027610` | `0x1002b610` |
| 1248 | 2061 | `IsTranslucentTextEnabled() : bool` | inline `(+0x48 >> 5) & 1` | `0x1002b680` |
| 1250 | 2063 | `SetTextVSpacing(float)` | `0x100276a0` | `0x1002ba00` |
| 1251 | 2065 | `GetTextVSpacing() : float` | inline `fld/fstp +0x90` | `0x1002ba70` |
| 1252 | 2067 | `SetHorizontalAlignment(byte)` | `0x100276b0` | `0x1002bab0` |
| 1253 | 2069 | `GetHorizontalAlignment() : byte` | inline byte `+0x94` | `0x1002bb20` |
| 1254 | 2071 | `SetVerticalAlignment(byte)` | `0x100276c0` | `0x1002bb60` |
| 1255 | 2073 | `GetVerticalAlignment() : byte` | inline byte `+0x95` | `0x1002bbd0` |
| 1256 | 2075 | `SetAlignments(byte, byte)` | `0x100276d0` | `0x1002bc10` |
| 1257 | 2078 | `GetAlignments(out byte, out byte)` | `0x100276f0` | `0x1002bcb0` |
| 1258 | 2081 | `EnableWordWrap(bool)` | `0x10027720` | `0x1002bd90` |
| 1259 | 2083 | `IsWordWrapEnabled() : bool` | inline `(+0x98) & 1` | `0x1002be00` |
| 1260 | 2085 | `EnableSpecialText(bool)` | `0x10027740` | `0x1002be40` |
| 1261 | 2087 | `IsSpecialTextEnabled() : bool` | inline `(+0x98 >> 1) & 1` | `0x1002beb0` |
| 1262 | 2089 | `SetBaselineData(optional float = 2.0, optional float = 1.0)` | `0x10027680` | `0x1002b970` |
| 1270 | 2092 | `CopyGC(GC Copy)` | `0x10027760` | `0x1002bef0` |
| 1271 | 2094 | `PushGC() : int` | `0x100278d0` | `0x1002bf60` |
| 1272 | 2096 | `PopGC(optional int gcNum = -1)` | `-1 -> 0x100279f0`, else `0x10027a80(gcNum)` | `0x1002bfa0` |
| 1295 | 2171 | `ClearZ()` | `0x1002ae40` reaches the render device | out of scope |

All functions have `functionFlags 0x401`. The optional-parameter defaults
are the immediates the exec bodies preload into the argument slots before
evaluating the expression (`0x40000000`, `0x3f800000`, `0xffffffff`).

## GC object layout (size 0xb8)

`this` is the `UGC` UObject. Offsets below are the ones the bodies read or
write; field names are ours, roles are inferred from the arithmetic.

| offset | width | field | evidence |
| ---: | --- | --- | --- |
| `+0x00` | ptr | vtable, `0x100598dc` for a constructed `UGC` | ctor `0x10026c70` |
| `+0x28` | ptr | canvas (copied by CopyGC; dereferenced only by ClearZ) | CopyGC, ClearZ |
| `+0x2c` | f32 | originX | Intersect adds it to ClipX and to clip x |
| `+0x30` | f32 | originY | |
| `+0x34` | f32 | clipX (origin-relative) | Intersect stores `max(...) - originX` |
| `+0x38` | f32 | clipY | |
| `+0x3c` | f32 | clipWidth | |
| `+0x40` | f32 | clipHeight | |
| `+0x44` | u8 | style byte (`DSTY_*`): 0 none, 1 normal, 2 masked, 3 translucent, 4 modulated | SetStyle, `0x1002aed0` |
| `+0x48` | u32 | flags: bit0 smoothing, bit1 drawing, bit2 masked, bit3 translucent, bit4 modulated, bit5 translucentText; bits 6+ untouched by every body | all flag natives |
| `+0x4c` | u32 | tile polyflags recomputed by `0x1002af00` | |
| `+0x50` | u32 | text polyflags `0x804` / `0x802` | EnableTranslucentText |
| `+0x54` | u32 | tile color dword (struct `Color` bytes as stored) | SetTileColor |
| `+0x58..+0x64` | 4×f32 | tile color floats: byte0*K, byte1*K, byte2*K, 0 | SetTileColor |
| `+0x68` | u32 | text color dword | SetTextColor |
| `+0x6c..+0x78` | 4×f32 | text color floats: byte0*K, byte1*K, byte2*K, 0 | SetTextColor |
| `+0x7c` | ptr | normal font | SetFont/SetNormalFont/SetFonts |
| `+0x80` | ptr | bold font | SetFont/SetBoldFont/SetFonts |
| `+0x84` | u32 | copied by CopyGC; no state native touches it | CopyGC |
| `+0x88` | f32 | underline height (`newUnderlineHeight`, 2nd SetBaselineData arg) | `0x10027680` |
| `+0x8c` | f32 | baseline offset (`newBaselineOffset`, 1st arg) | `0x10027680` |
| `+0x90` | f32 | text vertical spacing | SetTextVSpacing |
| `+0x94` | u8 | horizontal alignment | |
| `+0x95` | u8 | vertical alignment | |
| `+0x98` | u32 | text flags: bit0 wordWrap, bit1 specialText; bits 2+ untouched | |
| `+0x9c`, `+0xa0` | u32 | copied by CopyGC; no state native touches them | CopyGC |
| `+0xa4` | u32 | stack-node flags: bit0 = node sits on the free list | PushGC/PopGC/ctor |
| `+0xa8` | i32 | stack depth (on `this`); on a saved node: the depth it restores to; on a free-list node: free-list count at insertion + 1 | |
| `+0xac` | ptr | top saved node (stack link) | |
| `+0xb0` | ptr | free-list head of released nodes | |
| `+0xb4` | ptr | owner GC (non-null only on saved/free nodes) | |

`K` is the double at `0x1005e3c0` = `0x3f70101010101010` (1/255 rounded to
double). Both color setters compute `fild byte; fmul qword K; fstp f32`.

## Helper bodies

`0x1002aed0` style-from-flags (writes `+0x44`):
`!(flags&2) -> 0; flags&4 -> 2; flags&8 -> 3; flags&0x10 -> 4; else 1`.

`0x1002af00` polyflags-from-flags (writes `+0x4c`):
`pf = 0x100; if flags&4: pf = 0x102; if flags&8: pf |= 4; if flags&0x10: pf |= 0x40; if !(flags&1): pf |= 0x800`.

## Method semantics

* `EnableSmoothing(b)`: `flags.bit0 = b&1`; then polyflags-from-flags. Does
  **not** recompute the style byte.
* `EnableDrawing(b)`: `flags = (flags & ~2) | ((b&1)<<1)`. No helper calls.
* `EnableMasking/Translucency/Modulation(b)`: set bit 2/3/4 to `b&1`, then
  style-from-flags **then** polyflags-from-flags.
* `SetStyle(s)`: `+0x44 = s`. `s==0`: `flags &= ~2`, return (no helper).
  Otherwise `flags |= 2`; `s==2`: `flags = (flags & ~0x18) | 4`; `s==3`:
  `(flags & ~0x14) | 8`; `s==4`: `(flags & ~0x0c) | 0x10`; any other
  nonzero: `flags &= ~0x1c`; then polyflags-from-flags (style byte is the
  raw argument, not recomputed).
* `EnableTranslucentText(b)`: `flags.bit5 = b&1`; `+0x50 = bit5 ? 0x804 : 0x802`.
* `SetTileColor(c)` / `SetTextColor(c)`: dword store, then the three
  `byte*K` floats and a zero fourth float (see layout).
* `SetFont(f)`: `+0x7c = +0x80 = f`. `SetNormalFont` -> `+0x7c`;
  `SetBoldFont` -> `+0x80`; `SetFonts(n, b)` -> `+0x7c = n, +0x80 = b`.
* `SetBaselineData(off, ul)`: `+0x8c = off`, `+0x88 = ul` (raw dword copies).
* `SetTextVSpacing(v)`: `+0x90 = v`. `GetTextVSpacing` returns it through
  `fld/fstp` (UNVERIFIED: real x87 hardware should quiet an SNaN payload on
  the load, but Unicorn's softfloat returns `0x7f800001` unchanged, so the
  oracle cannot prove it; JS numbers cannot carry NaN payloads, so the
  validator only compares NaN-ness there).
* `SetHorizontalAlignment(a)` -> byte `+0x94`; `SetVerticalAlignment` ->
  `+0x95`; `SetAlignments(h, v)` -> both. The exec bodies mask the evaluated
  slot with `& 0xff` before the call because only one byte of the slot is
  preinitialised.
* `GetAlignments(out h, out v)`: method `0x100276f0` writes the zero-extended
  byte as a dword through each non-null pointer; the exec then copies the low
  byte to each out property.
* `EnableWordWrap(b)`: `+0x98.bit0 = b&1`; `EnableSpecialText(b)`: bit1.
* `Intersect(x, y, w, h)` (x87, FPCW 0x037f): with `o = (+0x2c,+0x30)`,
  `c = (+0x34,+0x38)`, `s = (+0x3c,+0x40)`:
  `A = f(x+ox)`, `B = f(y+oy)`, `C = f(cx+ox)`, `D = f(cy+oy)`,
  `E = f(C+sx)`, `F = D+sy` (kept in st, not rounded), `G = A+w` (kept in
  st), `H = f(B+h)`. `C' = (C < A or unordered) ? A : C`;
  `D' = (D < B or unordered) ? B : D`; `R = (E > G) ? f(G) : E`
  (fcomp, `test ah,0x41`: equal/unordered keep E); `Bt = (F > H) ? H : F`.
  Stores: `+0x34 = f(C'-ox)`, `+0x38 = f(D'-oy)`, `+0x3c = f(R-C')`,
  `+0x40 = f(Bt-D')`. `+0x2c/+0x30` are read only.
* `CopyGC(src)`: copies `+0x28`, `+0x2c..+0x40`, byte `+0x44`, bits 0-5 of
  `+0x48` (bits 6+ of the destination survive), `+0x4c`, `+0x50`, `+0x54`,
  `+0x58..+0x64`, `+0x68`, `+0x6c..+0x78`, `+0x7c`, `+0x80`, `+0x84`,
  `+0x88`, `+0x8c`, `+0x90`, bytes `+0x94`, `+0x95`, bits 0-1 of `+0x98`,
  `+0x9c`, `+0xa0`. Stack fields `+0xa4..+0xb4` are not copied.
* `PushGC() : int` returns the depth before the push (`+0xa8`). If
  `+0xb4 != 0` (this GC is itself a saved node) nothing happens. If the free
  list `+0xb0` is non-empty its head is unlinked (`+0xb0 = head+0xac`) and
  `head.CopyGC(this)` runs; otherwise a new `UGC` is created through
  `UGC::operator new` = `StaticAllocateObject(&UGC::PrivateStaticClass
  (0x100a28c8), Outer=this, FName(NAME_None), SetFlags=0, Template=0,
  GError, Ptr=0)` followed by the copy constructor `0x10026c70(this)`
  (`UObject::UObject()`, vtable `0x100598dc`, zero `+0x2c..+0x40`,
  `CopyGC(this)`, `+0xa4 &= ~1`, `+0xac = +0xb0 = +0xb4 = 0`, `+0xa8 = 1`).
  A null allocation returns the old depth unchanged. The node is then
  linked: `node+0xb4 = this`, `node+0xa4 &= ~1`, `node+0xb0 = 0`,
  `node+0xa8 = this+0xa8`, `node+0xac = this+0xac`, `this+0xac = node`,
  `this+0xa8 += 1`.
* `PopGC(gcNum)`: exec dispatch `gcNum == -1 -> 0x100279f0` which calls
  `0x10027a80(top ? top+0xa8 : this+0xa8 - 1)`; otherwise `0x10027a80(gcNum)`.
  `0x10027a80(n)`: return if `n >= this+0xa8` or `this+0xb4 != 0`. Walk
  `node = this+0xac` while `node && node+0xa8 >= n`: unlink
  (`this+0xac = node+0xac`, `this+0xa8 = node+0xa8`), move the node to the
  free list (`node+0xa8 = free ? free+0xa8 + 1 : 1`, `node+0xb4 = this`,
  `node+0xa4 |= 1`, `node+0xac = this+0xb0`, `node+0xb0 = 0`,
  `this+0xb0 = node`) and stop after the node whose depth equalled `n`.
  If any node was unlinked, `CopyGC(lastUnlinkedNode)` restores its state.

## Validation status

Filled in per native by the validators (see the table maintained below by
`scripts/validate-gc-*.mjs` runs); a native is not considered bound until
its row records a passing bit-exact run and live mutations.
