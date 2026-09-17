# UGC tile-draw command-capture model (Stage 3 keystone)

Every Extension UGC draw native funnels through one boundary: clip →
transform → emit `DrawTile` commands to the canvas object at `GC+0x28`.
This model captures that boundary once — the output is the **DrawTile
command stream**, not pixels.  A browser canvas backend that consumes the
stream is a separate app-side concern; nothing here rasterizes.

`src/runtime/script-gc-draw-model.mjs` holds the shared gate/sink/clip
translation and the command record.  `src/runtime/script-gc-draw-texture.mjs`
is the first native bound to it (`GC.DrawTexture`, native 1284).
`scripts/native-gc-draw-probe.py` runs the real bodies under Unicorn and
records the boundary calls; `scripts/native-gc-draw-texture-oracle.py` is the
case driver; `scripts/validate-gc-draw-texture.mjs` asserts bit-exact
agreement on raw f32 bit patterns.

## Native evidence (Extension.dll, base 0x10000000)

SHA-256 `93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`.
Oracle rebases to `0x12000000`; addresses below are preferred-base.

| piece | range | sha-256 (body bytes) |
|-------|-------|----------------------|
| exec trampoline 1284 | `0x1002c520..0x1002c660` | `baf90503…6377a7382` |
| `DrawTexture` method | `0x10028b00..0x10028ba0` | `8e0c6090…facfbe32` |
| tile-emit gate | `0x10028770..0x10028830` | `930bddf6…0c1a3f`  |
| draw sink | `0x1002a820..0x1002aa40` | `8ac3b403…d47b93a` |
| clip helper | `0x1002a4f0..0x1002a818` | `5253a297…f30365f` |

(`…` elided; full values in `script-gc-draw-model.mjs` header /
`GC_DRAW_TEXTURE_NATIVE`.)

Call chain: exec → method → gate → sink → clip helper → canvas vtable slot
`+0x5c`.  `Extension.u` export 2116, native index 1284, flags `0x401`,
serialSize 49, params `DestX, DestY, destWidth, destHeight, srcX, srcY`
(floats) + `tX` (object).

## GC fields the path reads

| offset | field | use |
|--------|-------|-----|
| `+0x28` | `canvas` | boundary object; non-null gate in the sink |
| `+0x2c/+0x30` | `originX/Y` | added into dest coords (f32) |
| `+0x34..+0x40` | `clipX/Y/W/H` | clip rect (f32, origin-relative) |
| `+0x48` bit1 | `drawing` | gate: method, gate and sink all re-test |
| `+0x4c` | `polyFlags` | forwarded as DrawTile PolyFlags |
| `+0x58` | `tilePlane` | 4 f32 → the DrawTile `Color` FPlane |
| `+0x9c/+0xa0` | `hMultiplier/vMultiplier` | i32 scale on dest coords AFTER ftol |
| `+0x4c` (canvas) | `CurZ` | f32 bits forwarded raw as DrawTile `Z` |

`GC.hMultiplier`/`vMultiplier` names come from the Extension.u class
metadata; `script-gc-state-model.mjs` still carries the legacy
`unknown9c`/`unknownA0` aliases so existing validators keep their find
strings.

## Gate `0x10028770`

Checks `tX != 0` and drawing, then computes two flags —
`flagW = (srcW == 0.0f or unordered)`, `flagH` likewise — and forwards
`(tX, x, y, w, h, u, v, ul, vl, flagW, flagH)` to the sink.
`DrawTexture` calls it with `ul = destWidth`, `vl = destHeight`: the source
UV extent always equals the pixel extent, so through this native the flags
only fire when `destW/destH == 0`, which the sink's post-checks reject
anyway.  The pixel-tracking clip path is still modelled faithfully because
the other draw natives reuse the same gate.

## Clip helper `0x1002a4f0`

In-place mutation of eight caller stack slots `{x, y, w, h, u, v, ul, vl}`:

1. `x += originX`, `y += originY`; `clipLeft = clipX + originX`,
   `clipTop = clipY + originY` (f32 adds).
2. Per axis, two modes selected by the gate flags:
   - **Pixel-tracking** (`srcSize == 0`): left/top clip shifts `u/v` by the
     clipped pixels, shrinks `w/h`, snaps `x/y` to the clip edge; right/
     bottom clip shrinks `w/h`; then `ul = w`, `vl = h` — UVs track pixels.
   - **Proportional UV** (`srcSize != 0`): left/top clip scales the UV
     shift by `ul/w` (`t = d*ul/w; ul += t; u -= t; w += d; x = clipLeft`),
     right/bottom clip scales `ul/vl` by the clipped fraction, then a
     texture-edge stage clamps `u`/`ul` against `texture+0x34` (i32 USize)
     and `v`/`vl` against `+0x38` (VSize), adjusting `x/w`/`y/h` inversely.
3. All comparisons are x87 `fcomp` condition-code tests: **unordered (NaN)
   operands skip the branch** rather than taking it — the JS model encodes
   this with `!(a >= b)` / explicit NaN-skipping forms, not `!(a <= b)`.
   Every stored slot is `fstp f32` (single rounding); intermediates stay in
   extended precision — `Math.fround` on stores plus f64 intermediates is
   oracle-verified bit-exact on every emitted integer.

## Sink `0x1002a820` → the DrawTile boundary

Gates: drawing bit, canvas non-null.  After the clip helper, rejects when
`w`, `h`, `ul` or `vl` is non-positive or unordered (checked in that
order), or the texture is null.  Then pushes 20 dwords — thiscall with
`ecx = canvas`, callee cleans `0x50` (the real `UCanvas::DrawTile`,
`Engine.dll 0x103019fb → 0x10376160`, confirms the cleanup):

```
DrawTile(UTexture* tex,                                  // = tX, identity ptr
         FLOAT X, FLOAT Y, FLOAT XL, FLOAT YL,           // dest rect
         FLOAT U, FLOAT V, FLOAT UL, FLOAT VL,           // source UV rect
         FSpanBuffer* span,                              // always NULL
         FLOAT Z,                                        // canvas+0x4c raw f32 bits
         FPlane Color,                                   // copy of GC+0x58 (4 f32)
         FPlane Fog,                                     // FPlane(0,0,0,0)
         DWORD PolyFlags)                                // GC+0x4c
```

Coordinate conversion is MSVCRT `_ftol` (`0x78004dc1`) reached through IAT
thunk `0x1005480a`.  The shipped MSVCRT `_ftol` does `fnstcw; or ah,0xc;
fldcw; fistp qword; fldcw` — it forces RC=truncate, so conversion is
**`trunc(value + 0.1)`**, NOT round-to-nearest.  `+0.1` is the f64 constant
at `0x1005e470` (`0x3fb999999999999a`).

```
X  = f32( trunc(clippedX + 0.1) * hMultiplier )   // imul, then i32→f32
Y  = f32( trunc(clippedY + 0.1) * vMultiplier )
XL = f32( trunc(clippedW + 0.1) * hMultiplier )
YL = f32( trunc(clippedH + 0.1) * vMultiplier )
U/V/UL/VL = f32( trunc(clipped + 0.1) )           // NO multiplier
```

The `Color`/`Fog` FPlanes are built by the two Core.dll ctors the sink calls
through IAT `0x100590bc` (copy) / `0x1005912c` (4-float) — verified trivial
value copies, so the command records the raw GC tile-plane bits and four
zeroes.

## Command capture, not rasterization

`gcCallDrawTile` reads `GC+0x28` → `*canvas` (vtable) → `vtable+0x5c` and
hands the marshalled record to `services.callVirtual`.  In the Unicorn
probe the vtable slot holds a `ret 0x50` stub whose code-hook captures the
20-dword argument block as an ordered event; in the validator the service
rebuilds the identical event.  Events carry raw u32 bit patterns — texture
and canvas as canonicalized heap labels — and are compared bit-for-bit.

## Reuse by the other draw natives

The gate/sink/clip trio is the shared engine for every tile draw:

- `DrawTexture` (this task): one command; `ul = destW`, `vl = destH`.
- `DrawStretchedTexture`: same single command with independent UV extent —
  exercises the proportional clip path the zero-size flags gate here.
- `DrawBox`/`DrawPattern`/`DrawBorders`: emit one command per tile piece
  through the same sink.
- `DrawText`: one command per glyph (font model supplies per-glyph rects).

Each follow-on native supplies its own argument marshalling up to the gate;
below the gate the model is unchanged.

## Out of scope / explicit unknowns

- **Downstream canvas clipping is not modelled.**  Engine's real
  `UCanvas::DrawTile` (`0x10376160`) performs a second clip against the
  render frame; that is the consumer's business, not the command stream.
- **Texture reads**: the only texture fields touched on this path are the
  i32 dims at `+0x34/+0x38` in the proportional texture-edge clamps
  (`fild`).  No pixel data is read; the texture pointer is forwarded
  verbatim.
- **Pixel-tracking mode** is unreachable through DrawTexture (its
  `srcW = destW` makes the flag imply `destW == 0`, rejected post-clip) but
  is implemented per the body for the other draws; its branches are
  oracle-covered indirectly by proportional-mode equivalents only — flagged
  honestly as the one path with no DrawTexture-level coverage.
- Extended-precision x87 intermediates are approximated by f64 with f32
  stores; every emitted integer is proven bit-exact by the oracle, but a
  pathological extended-precision-boundary input could in principle diverge
  without a case covering it.
