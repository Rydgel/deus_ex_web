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

`fireTables` translates the construction. Its arguments are products on the
x87 model; appSin is Core's call into the CRT sine, an x87 transcendental the
host takes as the JS double sine. That cannot change a byte: the nearest
`f32(sin·127.5 + 127.45)` comes 1.2·10⁻⁴ from a rounding midpoint (i = 56),
while a float step there is 7.6·10⁻⁶. The appRand stream is Core's MSVCRT
rand; its position when Fire first constructs is the host's (Play does not
reproduce the original process's earlier rand calls).

## Loading

UTexture::Serialize (Engine `0x103ed470`) empties a parametric texture's
(`+0x84` bit 3) mips before reading and zero-fills `USize·VSize` bytes per mip
after, so a fire starts black. UFireTexture::Serialize reads the sparks (a
compact count of 8-byte records) after the mips and grows the array to the
raw SparksLimit. PostLoad then sets UMask/VMask, rebuilds RenderTable when
RenderHeat differs from OldRenderHeat (transient, so 0 at load):
`trunc(clamp(i/4 + 1 - (255 - RenderHeat)/16, 0, 255))` for `i < 1024`
(exact in doubles), and, only when the array is not already SparksLimit
long, clamps the limit to 4..8192, drops temporaries from the top while
ActiveSparkNum exceeds it and resizes the array. A limit above 8192 that
Serialize grew to stands. `firePostLoad` translates both; new slots are zero
here, the allocator's leftovers in the original.

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

## Sparks

Each spark is 8 bytes: Type, Heat, X, Y and A-D. Pixels are written at
`(Y << UBits) + X`, masked by UMask/VMask where the case masks. Emitters add
temporaries at ActiveSparkNum while it is below SparksLimit; those run in the
same pass (the loop re-reads the count), and a dying temporary takes the last
spark into its slot. Bytes an emitter does not set keep the slot's old value.

| Type | Case | Behaviour |
| --- | --- | --- |
| Burn, Sparkle, Pulse, Signal | `0x1050260d`- | random / jittered / pulsing / gated Heat at the spark |
| Cylinder, Cylinder3D, Jugglers, Lissajous, 0x1d, 0x1e | `0x105027fa`- | sine-table orbits (Cylinder3D the front half) |
| Blaze, OzHasSpoken, Cone, BlazeLeft/Right, Emit, Fountain | `0x10502b27`- | emit 0x20, 0x21, 0x22 or 0x2a particles |
| Organic, WanderOrganic, RandomCloud, CustomCloud, LocalCloud | `0x1050317a`- | emit 0x23/0x24/0x25 puffs; the emitter wanders or jitters |
| Eels, Gametes, Flocks, Wheel, Sprinkler | | emit 0x26, 0x2b, 0x27, 0x27, 0x28 swimmers steered by A/B or the sine tables |
| Stars | `0x105042ed` | B at the spark, with PostDrawSparks |
| Line/RampLightning | `0x10504315` / `0x105043ed` | flash (X, Y)+(A, B) while C counts down, re-armed when a draw reaches D |
| SphereLightning | `0x105044c8` | a ray of length C at a random angle |
| 0x1f, above 0x2b | | nothing (the loop's continue) |

**DrawFlashRamp** (`0x105022f0`) draws a jagged line from (X, Y) by the
deltas XD, YD (magnitude with the sign in bit 0), ramping from Color1 to
Color2: an odd YD with `2·YD >= XD`, or else an odd XD with `2·YD < XD`,
draws it from the other end with the colours swapped; `N = max(XD, YD) | 1`
random bytes jitter the minor axis in 6-bit fixed point and the colour steps
in 23-bit fixed point (`idiv N`).

## Validation

`scripts/validate-native-fire-texture.mjs` runs ConstantTimeTick in the
hash-pinned DLL (`native-fire-texture-oracle.py`: Fire.dll mapped alone, the
texture and module state fabricated, unresolved imports trapping) and
compares, after every tick, every pixel, spark, field and random byte. 780
cases match: the fire updates (6 sizes from 8×8 to 128×128 shapes, rising
and still, both CPU forms), 12 cases of each of the 49 table types over four
sizes and six ticks, 8 mixed populations of every authored type over 40
ticks, and 160 DrawFlashRamp segments called on their own (the fuzz that
found the fall-through in its flip test). The table construction runs whole
(appSin as FSIN, appRand from four MSVCRT seeds) and PostLoad from
`0x10507d62` (FArray Remove/Realloc as leaves) over 40 heat and spark-array
cases: 824 cases in all. `--types`, `--only` and `--redraw` (RedrawSparks
alone) narrow a run.

## Status

ConstantTimeTick, the module tables and the load state are translated. Not
yet in Play.
