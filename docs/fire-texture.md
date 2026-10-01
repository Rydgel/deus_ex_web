# Fire textures

`FireTexture` (Fire.dll, `64bdcd86…`) is the procedural texture behind
flames, laser spots and beams, the nano and EMP effects, smoke, fountains and
sparks: 38 distinct textures in Effects, BobPage and OceanLab. Their packages
store no pixels; each tick redraws the sparks into the P8 buffer, runs a
cellular "fire" pass through a heat table and finishes the stars.

## Layout

Retail offsets (the class is `0x50c` bytes, asserted by PostLoad); the SDK
header `Fire/Src/FractalPrivate.h` gives the order:

| Offset | Field |
| --- | --- |
| `+0x30` / `+0x34` / `+0x38` | UBits / USize / VSize |
| `+0xa4` | Mips; Mips(0).DataPtr at `+0x1c` |
| `+0xc0` / `+0xc4` | UMask / VMask (USize-1, VSize-1 at PostLoad) |
| `+0xd0` / `+0xd4` / `+0xd5` | GlobalPhase / DrawPhase / AuxPhase |
| `+0xd8` / `+0xd9` / `+0xdc` | SparkType / RenderHeat / bRising |
| `+0xe0`-`+0xe8` | FX_Heat, Size, AuxSize, Area, Frequency, Phase, HorizSpeed, VertSpeed, DrawMode |
| `+0xec` / `+0xf0` / `+0xf4` | SparksLimit / ActiveSparkNum / Sparks (8 bytes: Type Heat X Y A B C D) |
| `+0x100` / `+0x104` | OldRenderHeat / RenderTable[1028] |
| `+0x508` | StarStatus |

## Module state

The first UFractalTexture construction (`0x10507569` -> `0x10501020`)
builds, once: a 256-byte sine table at `0x1051723c` from Core `appSin`, the
same clamped after adding `0x20` (`0x10518250`) and plus `0x80`
(`0x10518f84`), and 512 bytes of `appRand()` at `0x10518358` with the byte
index `0x10518558` at 0. Every random draw of every fire and water texture
uses that one generator: it reads the dword `0x80` bytes ahead of the index,
steps the index by 4 (mod `0x100`) and XORs the read value into the new slot.

## ConstantTimeTick (`0x10507ff0`)

For a texture of at least 8×8: RedrawSparks, then the fire update, then
PostDrawSparks.

- **RedrawSparks** (`0x105025b0`) adds FX_Frequency to AuxPhase, increments
  GlobalPhase and runs every active spark through a 44-entry jump table
  (`0x10505874`; the 29 authored types and the temporary types they emit).
- **The fire update** is hand-written, self-modifying code in `.data`: the
  stubs at `0x1050e460`-`0x1050e504` store the bitmap, RenderTable, width and
  height and call one of four routines (GIsPentiumPro × bRising), which patch
  their own displacements. Rising (`0x10515cf0`): in place, top row down,
  `P[y][x] = T[P[y+1][x-1] + P[y+1][x] + P[y+1][x+1] + P[y+2][x]]`, columns
  wrapping and the last two rows reading a copy of the first two. Still
  (`0x10515f30`): `P[y][x] = T[P[y][x-1] + P[y][x] + P[y][x+1] +
  P[y+1][x]]` over the old values, the last row reading a copy of row 0. The
  Pentium and Pentium Pro forms give the same bytes.
- **PostDrawSparks** (`0x10505930`) handles Stars sparks while StarStatus is
  set: the pixel under each is kept in ByteB and, below `0x26`, replaced by
  ByteA; StarStatus clears when none is active.

## Validation

`scripts/validate-native-fire-texture.mjs` runs ConstantTimeTick in the
hash-pinned DLL (`native-fire-texture-oracle.py`: Fire.dll mapped alone, the
texture and module state fabricated, unresolved imports trapping) and
compares, after every tick, every pixel, spark, field and random byte. The
fire updates: 6 sizes from 8×8 to 64×64 and 16×128, rising and still, both
CPU forms, 4 ticks each, all equal.

## Status

The spark types are being translated one at a time; an untranslated type
throws. Not yet wired into Play.
