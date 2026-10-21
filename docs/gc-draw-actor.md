# GC.DrawActor (1288) and GC.ClearZ (1295)

`Extension.GC.DrawActor(Actor actor, optional bool bClearZ, optional bool
bConstrain, optional bool bUnlit, optional float drawScale, optional float
scaleGlow, optional texture skin)` draws an actor's mesh into the 3D frame the
GC's canvas holds, in the middle of the HUD paint. `Extension.GC.ClearZ()`
clears the depth buffer. Both are Extension.dll natives (GOTY, SHA-256
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`, image base
`0x10000000`). Everything below is traced from the binary; the addresses were
re-derived, not taken from the task description (the task's were right).

## Callers

The retail bytecode (`node scripts/dump-script-function.mjs DeusEx
AugmentationDisplayWindow.DrawVisionAugmentation`) calls 1288 three times, all
as `GC.DrawActor(A, false, false, true, 1, S, null)` with S = 2 (a heat source
in range; the multiplayer cloak branch) or `DrawGlow` (2.0 in single player,
a distance fade in multiplayer). `ActorDisplayWindow.DrawWindow` calls
`GC.ClearZ()` when `bShowMesh` and `GC.DrawActor(trackActor, false, false,
true, 1, 1, None)`: a developer tool (the `ShowActors` window). No shipped
script passes bClearZ, bConstrain or a skin as true or non-None; those paths
are translated and oracle-checked but have no Play caller.

Both callers save the actor's `Skin`/`MultiSkins` with `SetSkins` (grid
textures) before the call and restore them after. The retail vision loop is
single-player gated by `bVisionImportant`, `IsHeatSource`, the vision level's
range and `Player.LineOfSightTo`. ActorDisplayWindow saves and restores
`LastRenderTime` around the call because the render stamps it.

## ClearZ (exec `0x1002cee0`, method `0x1002ae40`)

Exec: `Code++` (EX_EndFunctionParms), `call 0x1002ae40`, `ret 8`. No argument,
no gate. Registration: cell `0x1009860c`, index `0x50f` = 1295.

Method (`ecx` = GC):

```
canvas = GC+0x28
if (canvas) canvas->Viewport(+0x78)->RenDev(+0x64)->vtable[+0x90](canvas->Frame(+0x7c))
```

`UCanvas.Viewport` +0x78, `.Frame` +0x7c, `.Render` +0x80 and
`UViewport.RenDev` +0x64 are the SDK layouts (`scripts/sdk-layouts.mjs --at`),
the same slots `UCanvas::execDrawActor` (Engine.dll `0x10377ed0`) uses.
Vtable +0x90 is `URenderDevice::ClearZ(FSceneNode*)`
([script-weapon-rendering.md](script-weapon-rendering.md): Render.dll's
`DrawWorld` calls the same slot before `RenderOverlays`). There is no
x87 arithmetic and no state change in the GC.

## DrawActor exec (`0x1002cd80`)

Registration: cell `0x10098608`, index `0x508` = 1288. The exec reads seven
argument expressions in declaration order with the usual
`Code++ / GNatives[token]` loop. Locals start at: actor 0, bClearZ 0,
bConstrain 0, bUnlit 0, drawScale `0x3f800000` (1.0f), scaleGlow `0x3f800000`
(1.0f), skin 0; an omitted optional argument keeps that value. Then `Code++`
(EX_EndFunctionParms). Then:

```
if (actor != 0 && (GC+0x48 & 2))        // drawing enabled
    XGC::DrawActor(this = GC, actor, bClearZ, bConstrain, bUnlit, drawScale, scaleGlow, skin)
```

(thiscall, seven stack dwords, callee pops `0x1c`). bClearZ and bConstrain are
tested as non-zero dwords; only bit 0 of bUnlit is used.

## DrawActor method (`0x1002aa60`..`0x1002ae03`)

Gates: `GC+0x48 & 2` (drawing), `GC+0x28` (canvas) non-null, actor non-null.
Otherwise it returns at once.

`Frame = canvas->Frame` (`canvas+0x7c`), read once. The actor fields it
touches (SDK layout, bit positions from `sdk-layouts.json`):

| offset | field |
|---|---|
| `+0x28` bit 1 | `bHidden` |
| `+0x165` | `Style` (byte) |
| `+0x170` | `Skin` |
| `+0x17c` | `DrawScale` (f32) |
| `+0x18c` | `ScaleGlow` (f32) |
| `+0x194` bit 0 | `bUnlit` |
| `+0x1a4..+0x1c3` | `MultiSkins[8]` |

and the `FSceneNode` fields `+0xa8 X`, `+0xac Y`, `+0xb0 XB`, `+0xb4 YB`
(ints; `UnRender.h`). GC fields read: `+0x2c originX`, `+0x30 originY`, `+0x34
clipX`, `+0x38 clipY`, `+0x3c clipW`, `+0x40 clipH` (f32), `+0x44 style`
(byte), `+0x9c hMultiplier`, `+0xa0 vMultiplier` (i32).

### 1. Save

`hidden = actor+0x28 bit 1`, `drawScale = actor+0x17c` (raw), `unlit =
actor+0x194 bit 0`, `style = actor+0x165`, `scaleGlow = actor+0x18c` (raw),
`skins[0..7] = MultiSkins`, `skins[8] = Skin`, and the frame's `XB, YB, X, Y`.

### 2. bConstrain: shrink the frame to the GC's clip box

This block runs only when bConstrain is non-zero. It is x87 code under the
render pass's precision control 24 (`0x007f`,
[render-pass-precision.md](render-pass-precision.md); the HUD paints inside
`PostRenderFlash`). Every FADD/FSUB/FMUL result is rounded to 24 bits;
stores (`fstp m32`) round to binary32; the register values the code keeps
(`Bf`, `r`, `H` below) are 24-bit values.

```
fXB, fYB, fX, fY = float(XB), float(YB), float(X), float(Y)   // fild: exact; stored f32
hm = float(GC.hMultiplier), vm = float(GC.vMultiplier)        // fild: exact
t0 = f32(hm*originX)   t1 = f32(vm*originY)
t2 = f32(hm*clipX)     t3 = f32(vm*clipY)
t4 = f32(hm*clipW)     t5 = f32(vm*clipH)
L  = f32(t2 + t0)      T  = f32(t3 + t1)                      // clip left / top
Rf = f32(fX + fXB)                                            // frame right
Bf = fY + fYB          (register, 24 bits)                    // frame bottom
r  = L + t4            (register)                             // clip right
b  = f32(T + t5)                                              // clip bottom
x0 = fXB;  if (L  >  x0) x0 = L                               // fcomp: unordered keeps x0
y0 = fYB;  if (!(y0 >= T)) y0 = T                             // unordered takes T
R  = Rf;   if (Rf >  r)  R  = f32(r)
B  = Bf;   if (Bf >  b)  B  = b
dx = f32(x0 - fXB)   dy = f32(y0 - fYB)   W = f32(R - x0)   H = B - y0 (register)
Frame.XB = _ftol(dx)   Frame.YB = _ftol(dy)   Frame.X = _ftol(W)   Frame.Y = _ftol(H)
FSceneNode::ComputeRenderSize(Frame)                          // Engine.dll import 0x10059324
```

The four conversions are `MSVCRT _ftol` through IAT thunk `0x1005480a`:
round toward zero (`fistp qword` with RC forced to truncate; the result is the
low dword, so NaN and magnitudes of 2^63 or more give 0), with no `+0.1` bias:
unlike the tile sink, this block adds nothing before `_ftol`. The comparisons
use `fcomp` and `test ah, 0x41` / `test ah, 1`, so an unordered (NaN) operand
takes the branch the C0 flag selects: skip for `Rf>r`, `Bf>b`, `L>x0`; take for
`y0<T`.

Note that XB/YB receive `x0 - fXB` and `y0 - fYB`, offsets from the old
XB/YB, not absolute coordinates; the translation reproduces exactly that.

### 3. Apply the draw state

```
if (skin) { MultiSkins[0..7] = skin; Skin = skin }
actor.bHidden = 0
actor.bUnlit  = bUnlit & 1
actor.Style   = GC.style (+0x44)
actor.ScaleGlow = scaleGlow (raw dword copy)
actor.DrawScale = f32(drawScale * actor.DrawScale)      // fmul then fstp m32
```

The DrawScale product of two binary32 values has at most 48 significant bits,
so rounding it once to 24 bits (PC24) or once to binary32 on the store gives
the same value.

### 4. Render

```
if (bClearZ) canvas->Viewport->RenDev->ClearZ(Frame)           // vtable +0x90
canvas->Render(+0x80)->DrawActor(Frame, actor)                 // URenderBase vtable +0x74
```

`Render` is `URenderBase` (`UCanvas.Render`); vtable +0x74 is
`URenderBase::DrawActor(FSceneNode*, AActor*)`, the slot `UCanvas::execDrawActor`
calls at Engine.dll `0x10377fae`. In Render.dll that is `URender::DrawActor`
(`0x10b262c0`): it builds an `FDynamicSprite` on the stack, calls
`FDynamicSprite::Setup(Frame, Actor)` and, if Setup accepts (DrawType, Mesh,
camera depth, bounds), `DrawActorSprite`, which stamps
`LastRenderTime` ([actor-render-feedback.mjs](../src/viewer/actor-render-feedback.mjs))
and draws the mesh in `Frame`'s camera with the actor's Location, Rotation,
the DrawScale, Style, skins, `bUnlit` and `ScaleGlow` it holds now. Unlike
`UCanvas::execDrawActor`, GC.DrawActor does not touch `RendMap` or `bHidden`
afterwards (Canvas.DrawActor leaves the actor `bHidden`; this restores it).

### 5. Restore

```
actor.bHidden := hidden;  actor.bUnlit := unlit;  actor.DrawScale := drawScale
actor.Style := style;  actor.ScaleGlow := scaleGlow
if (skin) MultiSkins[0..7], Skin := skins[0..8]
if (bConstrain) { Frame.XB, YB, X, Y := saved; ComputeRenderSize(Frame) }
```

Frame restore runs only for bConstrain, and the skins restore only when a
skin was passed. The method has an SEH frame for C++ exceptions only; a
script error raised inside the render call does not restore the actor.

## Validation

`scripts/native-gc-draw-actor-oracle.py` runs the real exec and method bodies
(and ClearZ's) under Unicorn at the render pass's control word `0x007f`, with
the real MSVCRT `_ftol`; the render-device ClearZ, `URenderBase::DrawActor`
and `ComputeRenderSize` are recording stubs that snapshot the actor and frame
fields at the call. `scripts/validate-gc-draw-actor.mjs` replays the same
cases through `src/runtime/script-gc-draw-actor.mjs` and compares every event
and the final byte image (actor, frame, GC). See the results section below.

## Play

The window host's HUD canvas gains the render graph the original canvas has
(Viewport, RenDev, Render); GC.DrawActor and GC.ClearZ append ordered
`actor` and `clearZ` commands to the HUD command stream, in window order with
the tile commands (the way a ViewportWindow's `viewport` command does). The
page draws an `actor` command's mesh in the master camera between the tile
batches. The details and what is left unsupported are in the
[Play wiring](#play-wiring) section.
