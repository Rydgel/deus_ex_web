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
raw SparksLimit. The loader constructs the object before Serialize, so the
transient fields hold the C++ constructors' values: UFractalTexture
(`0x10507520`) zeroes the phases, UFireTexture (`0x10507840`) sets
OldRenderHeat to -1 and StarStatus to 1. PostLoad then sets UMask/VMask,
rebuilds RenderTable when RenderHeat differs from OldRenderHeat (always at
load; three fires, Wepn_EMPG_SFX, SparkFX1 and Spark_Electric, keep the class
default RenderHeat 0 and were black in Play before this was read):
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

## Wet textures

DX has two Fire.dll water classes in use, both in Effects: eight WetTextures
(drtywater_a and bluewater_a, named by 47 map files (40 and 11), the tear and poison gas
clouds, DrunkFX, DrunkBoy, Xplsn_EMPG, WavyBlade) and one WaveTexture
(waterfntn_a, not translated). Layout (SDK `FractalPrivate.h`, retail
offsets): DropType `+0xd8`, WaveAmp `+0xd9`, FX bytes `+0xda`-`+0xe1`,
NumDrops `+0xe4`, Drops `+0xe8`, SourceFields `+0x8e8`, RenderTable
`+0x8ec`, WaveTable `+0xcf0`, WaveParity `+0x12f0`, OldWaveAmp `+0x12f4`,
then UWetTexture's SourceTexture `+0x12f8`, OldSourceTex `+0x12fc` and
LocalSourceBitmap `+0x1300` (class `0x1304` bytes).

- **Construction.** The non-persistent fields keep the constructors'
  values. UWaterTexture (`0x10508540`) fills WaveTable,
  `clamp((i >> 1) - 0x100 + (i < 0x300), 0, 255)` for 1536 entries, and sets
  OldWaveAmp -1 and WaveParity 0. UWetTexture (`0x10509410`) clears
  OldSourceTex and LocalSourceBitmap.
- **PostLoad.** UWaterTexture's (`0x10508790`) sets the masks and allocates a
  SourceFields of `USize·VSize/2` bytes of 0x80. UWetTexture's (`0x10509590`)
  then, given a source, locks and unlocks it (loading its lazy mips). A
  source with the same bits is used directly. A smaller one is replicated up
  into LocalSourceBitmap. A larger one is dropped. A new source lends its
  palette. SetRefractionTable (`0x10509910`) runs when WaveAmp differs from
  OldWaveAmp, so always at load:
  `RenderTable[i] = clamp(ftol((i - 511)·WaveAmp/512), -128, 127)`. The
  products are exact at any x87 precision.
- **ConstantTimeTick** (`0x10509840`) needs a source and at least 8×8. It
  locks the source at LastUpdateTime: Engine's UTexture::Lock (`0x103ecc90`)
  runs the source's Update when the time is non-zero, which does nothing for
  the game's eight sources, all static P8 textures of the wet texture's size
  and palette. It then runs WaterRedrawDrops, CalculateWater and
  ApplyWetTexture (`0x10505a10`). That last step turns each mip-0 refraction
  offset into the source pixel that far along the row,
  `dst[x] = src[(dst[x] + x) & (USize-1)]` in byte arithmetic. Its byte
  counter could not finish a row wider than 256 pixels, and no wet texture
  is that wide.

`waterConstruct`, `waterPostLoad`, `setRefractionTable`, `wetPostLoad`,
`applyWetTexture` and `wetConstantTimeTick` translate these. The oracle
runs the constructor whole (UTexture's constructor as a leaf) and PostLoad
whole (UTexture::PostLoad as a leaf, GMalloc a fake allocator, the source's
Lock and Unlock recorded). It covers 45 PostLoad cases: same, smaller,
narrower and larger sources, none, the texture itself, kept tables, and a
LocalSourceBitmap freed or rebuilt. It also covers 20 ConstantTimeTick
cases of six ticks: the game's drop types, all types, a smaller source and
no source, at five sizes. All match the field, pixels, drops, phases, tables,
palette, generator and the source's Lock calls.

## Play

TextureStore reads a FireTexture's properties (DX names ActiveSparkNum
`NumSparks`), palette and sparks instead of decoding pixels. For a
WetTexture it reads the drops (ADrop structs, FDrop's 8 bytes in
SerializeBin order) and its source's P8 mip 0 and palette.
`src/viewer/procedural-textures.mjs` keeps one record per texture object:
the load state (the constructors' fields, then `firePostLoad` or
`wetPostLoad`), a zeroed P8 buffer, UTexture's animation
fields with PostLoad's Accumulator 0 and LastUpdateTime, and a
ConstantTimeTick that is the class's. Both inherit UTexture's
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

Wet textures go through the same path: drtywater_a is live on Island's and
Training's BSP water, and the gas clouds tick at their MaxFrameRate of 20. A
masked use of a wet texture is refused, because it would need index 0 cut
out of the one shared state's upload; none has been seen.

`scripts/validate-fire-texture-play.mjs` loads UNATCO Island in headless
Chromium: its six fire skins (LaserBeam1, LaserSpot1, Nano_SFX, BioCell_SFX,
Flame_J, Nano_SFX_A) are live, no mesh face group is skipped any more (the
NanoKey's, LaserTriggers', BarrelFires' and canister's were), and each fire's
GlobalPhase and pixels advance between frames. With `--map 00_TrainingFinal`
the BSP's BP_FX_03 is live too and no BSP surface fails on a fire. On
Island and in Training it also requires drtywater_a live and ticking.

## Rust kernel

The per-tick work runs in the Rust core (`native/script-vm/src/fire.rs`)
as exact representation changes. `fire-texture.mjs` stays the reference and
the fallback. A 2026-10-02 browser census (`play-frame-cost.md`) measured
drtywater_a's `calculateWater` at ~1.7 ms on every map. It measured the fire
textures at 0.3–1.4 ms and their P8→RGBA uploads at 0.3–0.5 ms.

- **Where.** fire.rs runs in the script-VM kernel instance
  (`script-vm-kernel.mjs`). It has no statics: the interpreter instance
  shares the module's reserved 2 MiB (`build.rs`). Texture blocks come from
  `kernel.fire.alloc`, a bump allocator above the instance's initial memory,
  the only thing that grows that memory. Blocks live as long as the page's
  texture set.
- **State.** The load functions (constructors, Serialize's arrays,
  `firePostLoad`, `wetPostLoad`) still build plain objects.
  `fire-texture-kernel.mjs` `fire` or `wet` then copies the state into a
  block: a header of u32 words (scalars and buffer addresses, `F_*` / `W_*`
  in fire.rs) and the buffers.
  - A fire's buffers are the whole spark array, RenderTable, the P8 pixels
    and 2·USize bytes of scratch for the update's saved rows.
  - A wet texture's are the drops, SourceFields, RenderTable, WaveTable, the
    pixels and the source pixels (LocalSourceBitmap or the source's mip 0).
  - Both also hold a 1024-byte palette and the RGBA output.

  The returned state keeps the reference's shape. The fields a tick changes
  (GlobalPhase, AuxPhase, ActiveSparkNum, StarStatus, WaveParity) read the
  header, and the buffers are views re-derived when the memory grows, so the
  JavaScript bodies run on it unchanged.
- **Generator.** `fireTables` (with its x87 products and host sine) stays the
  module state. A Globals block holds a copy of the three tables. Around each
  kernel tick `globals.run` copies the 512 random bytes and the index in and
  back out. Kernel and JavaScript ticks therefore draw from one stream in
  acquisition order, as before.
- **Admission.** A texture whose tick would not run (under 8×8, or a wet
  texture without a source) stays in JavaScript; its tick does nothing.
  - A fire moves when its arrays have the sizes the body indexes: USize·VSize
    pixels, 1028 RenderTable bytes, and a spark array holding both
    ActiveSparkNum and SparksLimit sparks. firePostLoad guarantees the last.
  - A wet texture also needs USize and VSize equal to `1 << UBits` and
    `1 << VBits`.
  - Anything else ticks in JavaScript on the same stream. All 40 game fires
    and all 8 game wet textures are admitted.
- **The JavaScript typed-array rules are kept, not trapped.** Many writes
  are unmasked: spark pixels at `(Y << UBits) + X` (Burn, Pulse, Signal,
  Stars, the temporaries' draws, a DrawFlashRamp step when UBits is wider
  than USize) and drops' SourceFields cells. A write past the buffer's end
  is dropped. A PostDrawSparks read past the pixels gives 0 (stored in B)
  and writes nothing. Drops past the 256 the array holds do nothing.
- **Representation changes, with their arguments.**
  - `calculateWater` reads a copy of the fields. A pass writes only its own
    parity's rows. Besides each cell's own value, read before its one write,
    it reads only the other parity's rows, so the kernel updates in place.
  - The water and fire stencils carry their window along the row. They test
    wrapping only at the edges instead of per-texel modulo.
  - On a power-of-two texture the water pass writes every pixel exactly once
    (each cell its 2×2 block, the even pass's shifted with wrapping).
    `applyWetTexture` then maps each refraction offset through
    `src[row + ((offset + x) & 255 & (USize-1))]`. The kernel therefore
    writes the source byte directly, and the separate pass and the
    intermediate offsets are gone.
  - The fire update keeps the reference's saved rows. Rising keeps the
    first two rows. Still keeps the first row and each row's old copy.
  - RedrawSparks re-reads the count every step. A killed spark's
    replacement is not run until the next tick, as in the reference.
  - The upload's palette expansion (`fire_expand`) reads a zero-padded
    1024-byte copy of the palette, as the JavaScript loop reads `undefined`
    (stored as 0) past a short palette. The RGBA bytes are copied into the
    `THREE.DataTexture`'s own array, so three.js never holds a view that a
    memory growth could detach.
- **Switch.** `FIRE_KERNEL=js` (Node) or `?fireKernel=js` (viewer,
  `globalThis.DEUS_EX_FIRE_KERNEL`) keeps the JavaScript bodies. The choice is
  made once per texture set, at its first acquisition. The kernel is used
  when it is loaded by then, which world.mjs ensures before any surface.
  `records()` reports each texture's `backend`.

`scripts/validate-fire-texture-rust.mjs` checks the kernel against the
JavaScript bodies. A child process loads each map headless (world, game,
actor mesh layer) and lists the textures Play acquires. Two sets are built
from them, one per backend, with the same seed and order. Every texture
ticks 600 times. After every tick the pixels, the fields, drops or sparks
(whole arrays), the scalars, the 512 generator bytes and index, and the RGBA
upload must match. On 2026-10-02 every byte matched for each set:

| Set | Textures | Texture ticks |
| --- | --- | --- |
| 00_Training | drtywater_a, BioCell_SFX | 1200 |
| 10_Paris_Chateau | Auc_Nanofeed, drtywater_a, BP_FX_02, BioCell_SFX, Nano_SFX_A | 3000 |
| 15_Area51_Bunker | flame_b, bluewater_a, LaserBeam2, LaserSpot2, BioCell_SFX, LaserSpot1, Flame_J, Nano_SFX_A | 4800 |
| all of Effects, BobPage and OceanLab | 8 wet, 40 fire | 28800 |
| synthetic wet | 24 textures, 8×8 to 256×256 | 14400 |
| synthetic fire | 48 textures, 8×8 to 256×256 | 28800 |

The synthetic sets cover what the game's data does not (its wet textures
use only drop types 0x01, 0x02, 0x06, 0x0c and 0x10):

- Wet: every drop type (and unused ones), drops outside the half texture,
  NumDrops 300, smaller sources and short palettes.
- Fire: every spark type 0x00–0x2b (and 0x2c, 0x7f, 0xff); sparks off the
  texture; bytes at the borrow and carry edges; inactive serialized sparks;
  limits below, at and above the count and above 8192; both updates; a
  UBits wider than USize; short palettes.

Injected kernel bugs were all caught on their first tick: a refraction mask,
a generator XOR, a DrawFlashRamp colour and step, the kill's copy,
lightning's re-arm, PostDrawSparks' read past the end and its write, the
0x2a fall's GlobalPhase parity, and an unmasked 0x23 countdown (caught once
the edge bytes were added).

`--bench N` times both backends headless (Node, M2 Pro, median of 300).
Each row gives tick + upload in ms:

| Texture | JavaScript | Rust |
| --- | --- | --- |
| drtywater_a, bluewater_a (256², wet) | 1.53–1.57 + 0.25 | 0.084–0.087 + 0.027 |
| Auc_Nanofeed, BP_FX_02 (256² fire) | 0.18–0.19 + 0.27 | 0.040 + 0.026 |
| flame_b | 0.145 + 0.066 | 0.021 + 0.007 |
| Nano_SFX_A | 0.070 + 0.066 | 0.025 + 0.007 |
| BioCell_SFX | 0.012 + 0.004 | 0.004 + 0.001 |
| lasers, Flame_J | 0.005–0.008 + 0.002–0.004 | 0.001–0.003 + 0.001 |

Per map the procedural textures went from 1.81 to 0.12 ms (Training), 2.88
to 0.28 ms (Chateau) and 2.21 to 0.19 ms (Bunker). The fires' remaining
time is the 4-tap stencil through RenderTable, about 0.6 ns a pixel. Browser
A/B and the Play validator (`validate-fire-texture-play.mjs`, which needs a
browser) are not part of this record.
