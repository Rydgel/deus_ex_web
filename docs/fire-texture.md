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

## Water (CalculateWater)

UWaterTexture::CalculateWater (`0x105059c0`) increments WaveParity and runs
one of two self-modifying routines in `.data` by its parity (`0x10516ce0`
odd, `0x10516470` even, set up by `0x10516988`). Their reconstruction came
from the oracle: running them on buffers at recognisable addresses, tracing
which cells and pixels each block writes, and disassembling the patched code
mid-run. SourceFields is a half-resolution height field `USize/2` wide and
`VSize` rows tall: even rows are buffer A, odd rows buffer B, on a staggered
grid. The odd pass rewrites every B cell from the A cells at its corners
(columns x and x+1, rows above and below), the even pass every A cell from
the B cells at its corners (columns x-1 and x), wrapping both ways:
`new = WaveTable[corner sum - 2·old + 0x200]`. Each cell also writes its 2×2
pixels from horizontal slopes through RenderTable (+0x200): `s` on the south
row (`x+1` minus `x-1`, one column further left for A cells) and
`h = (s + north slope) >> 1`; the right pixels take `2·slope`, the left
ones the slope plus its left neighbour's (the routine carries it). A cells'
blocks sit half a cell up and left. `calculateWater` translates it; 12
oracle cases (6 sizes to 256×256, both parities, 4 ticks) match fields and
pixels byte for byte.

## Water drops (WaterRedrawDrops)

UWaterTexture::WaterRedrawDrops (`0x10506410`) increments GlobalPhase and
runs the drops (8 bytes at `+0xe8`, NumDrops `+0xe4`: Type, Depth, X, Y,
A-D) through a byte map (`0x10506e94`) and jump table (`0x10506e38`). A drop
sits in half-size coordinates: `(Y << UBits) + X` is buffer A's row Y, and
every write goes to that A cell and the B cell under it (`+USize/2`); the
half masks are the bytes `UMask >> 1` and `VMask >> 1`.

| Type | Case | Cell value |
| --- | --- | --- |
| FixedDepth | `0x105064c1` | D |
| PhaseSpot, ShallowSpot, HalfAmpl | `0x105064d5`- | Depth += D; sine, `sine/2 + 0x40`, `max(sine, 0x80)` |
| RandomMover | `0x1050655a` | `0xb9` over `0x47`; X and Y step by the difference of two 2-bit draws |
| FixedRandomSpot | `0x1050666d` | two random bytes |
| WhirlyThing, BigWhirly (0x40, 0x41 backwards) | `0x105066e4`- | Depth on a sine-table circle (`>> 4`, `>> 3`), angle B:A += D:C |
| Horizontal/Vertical/Diagonal Line1/Line2 | `0x1050683a`- | Depth along `D/2 + 1` cells (Line1 runs left-down) |
| the four Osc forms | `0x105069e6`- | the same lines with Depth += C, sine |
| RainDrops | `0x10506c81` | one draw in 16: Depth over its complement within D of (X, Y) |
| AreaClamp | `0x10506be6` | a `D/2` square of Depth |
| LeakyTap, DrippyTap | `0x10506d9a`- | A += D; when it wraps to `<= D`, Depth over its complement (DrippyTap re-draws A) |
| 0x14-0x3f, above 0x41 | `0x10506e15` | nothing |

`waterRedrawDrops` translates it: 276 oracle cases (each type, four sizes
to 256×256, five ticks) match fields, drops, GlobalPhase and the generator.
The case generator draws from its LCG's top bits: its low bits cycle, which
had kept RainDrops' one-in-16 gate (and every random-gated fire branch)
from being reached with useful variety; all 1112 cases pass on the new draws.

## Play

TextureStore reads a FireTexture's properties (DX names ActiveSparkNum
`NumSparks`), palette and sparks instead of decoding pixels.
`src/viewer/procedural-textures.mjs` keeps one record per texture object:
the load state (`firePostLoad`), a zeroed P8 buffer, UTexture's animation
fields with PostLoad's Accumulator 0 and LastUpdateTime, and a
ConstantTimeTick that is UFireTexture's. UFireTexture inherits UTexture's
Tick, so `texture-animation.mjs` gates it: PrimeCount ticks at the first
update (100 for the flames), and with no MaxFrameRate (none of the game's
fires set one) one tick per drawn frame, so a fire runs at the frame rate as
in the original. After a tick the buffer goes through the palette into a
`THREE.DataTexture` (PostLoad clears PF_Masked from a fire, so index 0 keeps
its colour). One page-wide set (`sharedProceduralTextures`) serves BSP
surfaces (`world.mjs`, 140 surfaces in 13 maps: WhiteStatic, flame_b,
Virus_SFX, Nano_SFX_A, Auc_Nanofeed, BobPage's BP_FX_03...) and mesh skins
(`actor-mesh-textures.mjs`), so a texture object has one state as in the
original; the world's per-frame update runs it.

Host choices, noted in the viewer: every acquired fire updates each frame in
acquisition order (the original updates the drawn ones in draw order with one
shared generator), and the module tables take their appRand bytes from a
host-seeded MSVCRT stream. Sprites (a ParticleGenerator's SmokePuff1, for
one) are not drawn yet.

`scripts/validate-fire-texture-play.mjs` loads UNATCO Island in headless
Chromium: its six fire skins (LaserBeam1, LaserSpot1, Nano_SFX, BioCell_SFX,
Flame_J, Nano_SFX_A) are live, no mesh face group is skipped any more (the
NanoKey's, LaserTriggers', BarrelFires' and canister's were), and each fire's
GlobalPhase and pixels advance between frames. With `--map 00_TrainingFinal`
the BSP's BP_FX_03 is live too and no BSP surface fails on a fire.
