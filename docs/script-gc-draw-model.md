# UGC tile-draw command-capture model (Stage 3 keystone)

Every Extension UGC draw native funnels through one boundary: clip →
transform → emit `DrawTile` commands to the canvas object at `GC+0x28`.
This model captures that boundary once — the output is the **DrawTile
command stream**, not pixels.  A browser canvas backend that consumes the
stream is a separate app-side concern; nothing here rasterizes.

`src/runtime/script-gc-draw-model.mjs` holds the shared gate/sink/clip
translation and the command record.  Six tile natives are bound to it —
`DrawTexture` (1284), `DrawIcon` (1283), `DrawStretchedTexture` (1287),
`DrawPattern` (1285), `DrawBox` (1286), `DrawBorders` (1289) — each in its
own `src/runtime/script-gc-draw-*.mjs` module with a matching
`scripts/native-gc-draw-*-oracle.py` case driver and
`scripts/validate-gc-draw-*.mjs` bit-exactness gate.
`scripts/native-gc-draw-probe.py` runs the real bodies under Unicorn and
records the boundary calls.

`DrawText` (1282) is bound separately in
`src/runtime/script-gc-draw-text.mjs`: its glyph emits reach the same
render boundary one level deeper (see below).

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

## Reuse by the other draw natives — all bound

The gate/sink/clip trio is the shared engine for every tile draw.  All six
are implemented and oracle-validated bit-exact:

- `DrawTexture` (1284): gate `ul = destW`, `vl = destH` → proportional.
- `DrawIcon` (1283): method `0x10028f10` re-gates, leaf `0x10029010` emits
  `sink(tex, x, y, USize, VSize, 0, 0, USize, VSize, 0, 0)` — proportional
  mode over the full texture.
- `DrawStretchedTexture` (1287): exec calls the sink directly,
  `flagW = flagH = 0` — proportional with an independent UV rect.
- `DrawPattern` (1285): method `0x10028a60` emits
  `sink(tex, x, y, w, h, OrgX, OrgY, 0, 0, 1, 1)` — pixel-tracking.
- `DrawBox` (1286): method `0x10028c50` — four DrawPattern-shaped edge
  calls (top, bottom, left, right — pixel-tracking, OrgX/OrgY shifted per
  edge); a single full-rect tile when `destW <= 2T or destH <= 2T`.
- `DrawBorders` (1289): method `0x10028df0` — nine tiles from a
  `Texture[9]` array (TL, TR, BL, BR, L, R, T, B, C); corner/edge dims are
  max-folded per row/column, negative mid-dimensions rescale the border
  bands proportionally, `bStretch` flags pick per-tile proportional vs
  pixel-tracking.

## DrawText (1282) — the glyph path one level deeper

`DrawText` does NOT emit through the tile sink.  Its per-glyph helper
`drawGlyph` (`0x10029e40`) calls `FRenderInterface::DrawTile` at
`*(*(canvas+0x7c) + 0x64)` vtable `+0x7c` — the same boundary the real
`UCanvas::DrawTile` (Engine.dll `0x10376160`) delegates to internally.  The
emitted block is the DrawTile layout plus one trailing dword — 21 dwords:

```
DrawTile(FSceneNode* node, FTextureInfo* record,        // replaces `tex`
         FLOAT X, FLOAT Y, FLOAT XL, FLOAT YL,
         FLOAT U, FLOAT V, FLOAT UL, FLOAT VL,
         FSpanBuffer* span,                             // NULL
         FLOAT Z,                                       // canvas+0x4c raw
         FPlane Color,                                  // emit-state color
         FPlane Fog,                                    // (0,0,0,0)
         DWORD textPolyFlags)                           // GC+0x50, arg 21
```

The trailing `textPolyFlags` is pushed before the `FPlane(0,0,0,0)` ctor
and survives its arg cleanup; `fog.w` stays 0 — oracle-verified.

Supporting machinery:

- **Method `0x10028180`** — gates on drawing bit, canvas, and the text
  pointer (the exec substitutes the static empty wstring `0x10099ea8` for
  an empty FString, so `''` still enters).  PushGC →
  `Intersect(DestX, DestY, destWidth, destHeight)` → optional vAlign
  measure through the real `GetTextExtent` body (`0x10027bb0`) with
  `f32(wrapInt)` → per-line scan + per-glyph `drawGlyph` → `PopGC(-1)`.
  hAlign/vAlign use `ftol` + signed halving; line heights fold `vSize`
  maxes with a 1.0f floor that falls back to the space glyph's `vSize`.
- **Text pipeline** — the same `scanLine`/`nextChar`/escape-state model
  `GetTextExtent` uses (`script-gc-get-text-extent.mjs`); DrawText runs a
  second emit-state pair (`A` emit, `B` scan, `A ← B` per line).
- **Realize cache `0x1002a370`** — five 0x84-byte `FTextureInfo` records
  in Extension .bss (`0x100a2630`), an MRU head (`0x100a2dc8`) and count
  (`0x100a2dc4`): head-hit is a no-op; a mid-list hit unlinks and
  re-heads; a miss appends `records[count++]`; a miss with a full cache
  force-evicts the tail (`Unlock` old texture then `Lock` new —
  `UTexture::Lock(this, &record, vp+0xb0, vp+0xb4, -1, RI)` fills
  `record+0` with the texture).  Texture 0 returns the static record
  `0x100aeb20` unlocked.  The cache is process-global — it persists across
  calls, which the oracle exercises across cases.
- **Underline** — a second `DrawTile` emit when the emit state's `|&` flag
  is set and `GC+0x84` (underline texture) / `GC+0x88` (height > 0) are
  live: source (0,0), width `uSize - 1`, worldY
  `f32(vSize) - baselineOffset + originY + y`, same world-clip rules.

Glyph coordinate marshalling matches the tile sink
(`f32(imul(trunc(v + 0.1), multiplier))` on dest coords, `f32(trunc(+0.1))`
on UVs) but the clip is done inline against the GC clip rect — the clip
helper's pixel-tracking mode, not proportional UV.

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
- **`DrawActor` (1288) is intentionally unimplemented.**  It enters the 3D
  mesh-rendering path — `DrawActor` draws an `Actor` through the render
  interface's mesh pipeline, not the 2D tile emitter — so it is the
  documented 3D-renderer dependency boundary for this layer, not a
  candidate for the DrawTile command-capture model.
