# Original `AActor::execPlayAnim` (native 259) research

The live player path now also prepares `DeusExCharacters.GM_Trench`. The
correct UE1 signed compact-index reader decodes all 71 sequence records from
the original export; `HitTorso` starts at frame 71 with 4 frames at rate 10,
and `HitLegLeft` starts at frame 79 with 4 frames at rate 10. The hash-gated
original `ULodMesh::Serialize` oracle consumes all 1,019,128 bytes exactly.
`PlayAnim('HitTorso',,0.1)` retains the native optional Rate default of 1 when
UnrealScript supplies an `EX_Nothing` hole, preventing a non-original NaN rate.

Bound for the training `LightSwitch.Frob` route (`PlayAnim('Off'/'On')`).
Evidence recorded from the installed GOTY `Engine.dll` disassembly in
`.cache/reference/Engine.asm` and the serialized `DeusExDeco.u` export 606
(`LightSwitch`, class `LodMesh`, 1,272 bytes). Addresses are virtual addresses
in the `Engine.dll` image (image base `0x10300000`).

This file records the native contract. The eager sequence-table decode and the
LightSwitch/player PlayAnim state paths are covered; lazy geometry and visual
mesh animation remain Stage 4 presentation work.

## Entry

```
Engine.dll SHA-256  0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4
execPlayAnim  body   0x103e0160   (returns 0x103e0499)
```

Arguments are evaluated by the ordinary native parameter loop (helper import
`0x10599a38`, one call per parameter, cursor advanced past each) in declared
order, with the documented defaults read as floats:

| declaration order | default when omitted |
| --- | --- |
| `Sequence` | — (required name reference) |
| `Rate` | `1.0f` (`0x3f800000`) |
| `TweenTime` | `-1.0f` (`0xbf800000`) |

`Sequence` must supply the FName bits used by the mesh lookup. A name-only
callback would bypass the null-resource behavior and is unsupported.

## Guard gates

1. `mesh = actor[+0x174]`. If null, log import `0x10599a68` (format
   `0x10481dd8`) at `0x103e04d7` and return; no animation state is written.
2. `seq = mesh->vtable[+0x68](Sequence)` (`0x103e01eb–0x103e01f2`). If null,
   log with format `0x10481e04` reading mesh `+0x20` and the sequence FName
   through global table `0x10599a70`, then return at `0x103e049c`; no state
   is written.

## Sequence lookup (`mesh vtable +0x68`)

`0x1031c000` and `0x1031c050` are two identical linear scans:

```
count = mesh->+0x88            (signed int)
if count <= 0 return 0
data = mesh->+0x84
for i = 0..count-1:
  if *(data + i*0x20) == requested FName index: return data + i*0x20
return 0
```

Entry size = `0x20` (32) bytes. The body reads only these entry fields:

| entry offset | type | use |
| --- | --- | --- |
| +0x00 | FName | scan match |
| +0x0c | int32 | `fildl`/`fidivl` (the NumFrames value) |
| +0x10 | float32 | multiplied against `Rate` |
| +0x18 | dword | non-zero feeds the animation loop flag |

## Successful path

Actor animation fields (all float32 unless noted; `NF` = int32 at `seq+0x0c`):

```
if actor+0x54 == 0 (no previous sequence): TweenTime = 0        (0x103e01ff)
actor+0x54 = Sequence bits                                      (0x103e0210)
actor+0x5c = fl32( fl64(Rate) * fl64(seq+0x10) / fl64(seq+0x0c) )
actor+0x220 = fl32( 1.0 - fl64(seq+0x0c) )                      (0x103e022d)
flags = (flags & ~0x39) | ((seq+0x18 != 0) << 5)               (0x103e0244-56)
```

Then branch on `actor+0x220 == 0.0` (i.e. `seq+0x0c == 1`; x87 C3 test at
`0x103e0259`, `testb 0x40`, `je 0x103e02bd`).

### NumFrames == 1 (`0x103e025e`)

```
flags &= ~0x20; actor+0x224 = 0; actor+0x228 = 0
if TweenTime > 0:                    (testb 0x41 C3|C0, jne 0x103e02a2)
   actor+0x60 = fl32( fl64(TweenTime) / 1.0 )
   actor+0x5c = 0
   actor+0x58 = fl32( fl64(seq+0x0c) / -1.0 )        // -NF
else:                                 0x103e02a2
   actor+0x60 = 10.0f
   actor+0x5c = 0
   actor+0x58 = fl32( fl64(seq+0x0c) / -1.0 )        // -NF
```

### NumFrames != 1 (`0x103e02bd`, the training-switch path)

Compare `TweenTime` against `0.0` (`fcompl 0x10429838`):
- `TweenTime > 0` (testb 0x41 C3|C0 clear):
  ```
  actor+0x60 = fl32( fl64(seq+0x0c) * fl64(TweenTime) / 1.0 )   // fildl; fmuls
  actor+0x58 = fl32( fl64(seq+0x0c) / -1.0 )                    // -NF
  ```
- `TweenTime <= 0` (`0x103e02ef`): compare against `-1.0` (`fcompl 0x10429c58`).
  - `TweenTime == -1` (testb 0x40 C3 set):
    ```
    actor+0x58 = fl32( fl64(seq+0x0c) / -1.0 )                  // -NF
    compare actor+0x228 (float) with 0.0f (fcomps 0x10426d54):
      +0x228 > 0:  actor+0x60 = bits of actor+0x228              (0x103e0323)
      +0x228 == 0: actor+0x60 = fl32( fl64(seq+0x0c) * 0.025 / 1.0 )   (0x103e03a8)
      +0x228 < 0:  the norm path below                           (0x103e0344)
    ```
    (the `+0x228 > 0` vs `== 0` split is a second `fcomps 0.0f`: first
    `testb 0x41` C3|C0 `jne 0x103e0331` if `<=0`, then `testb 0x01` C0 `je
    0x103e03a8` if not `<0`.)
  - `TweenTime != -1` (and `<= 0`, i.e. `<0`): `0x103e03bc`
    ```
    actor+0x60 = 0
    actor+0x58 = 0.001f            // bits 0x3a83126f
    ```

### Negative `+0x228` norm path (`0x103e0344`)

```
dot = sqrt( fl64(actor+0x144)^2 + fl64(actor+0x148)^2 + fl64(actor+0x14c)^2 )
        // loaded in order +0x14c, +0x148, +0x144; each component fmul'd;
        // faddp to the sum; fstpl 8-byte on the stack; import 0x10599ca4 (sqrt)
A = fl32( fl64( fl32(sqrt(dot)) ) * fl64(actor+0x228) * fl64(-1.0) )   // -act228*dot > 0
B = fl32( fl64(actor+0x5c) * 0.5f )
actor+0x60 = (B < A) ? A : B       // max; fcomp C0 at 0x103e0398
```

The `+0x144/+0x148/+0x14c` vector is `Velocity`: docs/camera.md binds
Velocity+0x144, and the animation-tick body at `0x103a1c98` computes the
identical magnitude pattern for negative `AnimRate` while clamping with
`+0x224`. Actor.uc's declaration order after `AnimLast`
(`AnimMinRate`, `OldAnimRate`, `SimAnim`) plus those reads establish
`+0x224` = `AnimMinRate` (the velocity-scaled minimum-rate clamp) and
`+0x228` = `OldAnimRate` (the SimAnim tail copies `bits(+0x5c)` there,
matching its "= AnimRate until animation completes" comment).

## SimAnim tail (`0x103e03c6`)

```
actor+0x22c = fl32( fl64(actor+0x58) * 10000.0f )          // 0x1042ac0c
save old words +0x22c, +0x230, +0x234, +0x238 into locals
actor+0x230 = fl32( fl64(actor+0x5c) * 5000.0f )           // 0x1042f548
if (actor+0x230 > 32767.0f) actor+0x230 = 32767.0f          // fcomps 0x1042ae00; bits 0x46fffe00
actor+0x234 = fl32( fl64(actor+0x60) * 1000.0f )           // 0x10430a60
actor+0x238 = fl32( fl64(actor+0x220) * 10000.0f )
if (old +0x22c == new +0x22c AND old+0x230 == new AND
    old+0x234 == new AND old+0x238 == new):                 // four fcomps, each testb 0x40 C3
   actor+0x238 = fl32( fl64(actor+0x238) + 1.0f )          // fadds 0x10429c50
actor+0x228 = bits(actor+0x5c)                             // movl copy
```

The `+0x22c` block is the 16-byte `SimAnim` region (`0x22c..0x238`).

## x87 status-bit mapping used above

The disassembly tests `%ah` (FPU status word bits 8–15) after `fnstsw %ax`:

| AH mask | SW bit | condition-code meaning |
| --- | --- | --- |
| `0x01` | 8 (C0) | `ST < operand` (or unordered) |
| `0x40` | 14 (C3) | `ST == operand` (or unordered) |
| `0x41` | C3\|C0 | `ST <= operand` (or unordered) |

## Constants (engine image, base 0x10300000)

`fcompl`/`fdivrl`/`fmull` read 8-byte doubles; `fcomps`/`fmuls`/`fadds` read
4-byte singles:

| VA | single | double | use |
| --- | --- | --- | --- |
| 0x10429838 | 0.0 | 0.0 | `fcompl` bases |
| 0x104298a0 | 0.0 | 1.0 | `fdivrl`/`fsubrl` divisors |
| 0x10429c58 | -1.0 | -1.0 | negation / `-1.0` test |
| 0x10432b48 | — | 0.025 | zero-rate tween `fmull` |
| 0x10426d54 | 0.0 | — | `+0x228` comparisons |
| 0x10426d74 | 0.5 | — | tween blend |
| 0x104298f0 | -1.0 | — | norm-path sign |
| 0x1042ac0c | 10000.0 | — | frame/SimAnim scale |
| 0x1042f548 | 5000.0 | — | rate scale |
| 0x1042ae00 | 32767.0 | — | clamp ceiling |
| 0x10430a60 | 1000.0 | — | tween scale |
| 0x10429c50 | 1.0 | — | SimAnim wrap increment |

## Serialized mesh: GOTY does not match SurrealEngine's reader

This repo validated several readers against SurrealEngine
(`docs/rendering.md`). Reproducing SurrealEngine's `UMesh::Load` +
`ULodMesh::Load` byte-for-byte against export 606 fails immediately: the
payload does **not** begin with the `UPrimitive` bounding-box/sphere floats.
The first dword is `0x70000000` and the first lazy-array
`Tell() == Offset` verification fails. The 1,272 bytes begin with
vertex-scale data instead.

So the GOTY `LodMesh` serialized layout has a different leading structure
than the SurrealEngine reference reader and must be recovered from the
original native loader/serialization before the sequence table
(`+0x84`/`+0x88`, stride 0x20) and its `+0x00/+0x0c/+0x10/+0x18` fields can
be bound from the real `LightSwitch` mesh. That decode is open (handoff item
1).

Dataset notes (export 606, class `LodMesh`, 1,272 bytes):
- no 4-byte LE value equals the `DeusExDeco.u` local name index of `Off` (15)
  or `On` (18), nor the `DeusEx.u` bytecode indices 431 / 593;
- the tail contains two `22` (`0x16`) values and a final `20 00 00 00` region
  plausible for `AnimFrames`/`FrameVerts`, but the fields around them do not
  line up with the SurrealEngine `MeshAnimSeq` record.

## Status

- The complete `execPlayAnim` body is transcribed above from `Engine.asm`,
  with every float constant read from the installed binary.
- Translated into `src/runtime/play-anim.mjs` and wired as native `259` in the
  shared `ScriptRuntime.invokeNative` (mesh payloads decoded once per identity
  by `ScriptRuntime.meshPayload`); the field identities above are bound to the
  linked Actor fields. The real mesh sequence table comes from the recovered
  serialized decode (`docs/lodmesh-serialization.md`).
  `scripts/validate-script-lights.mjs` drives the real LightSwitch mesh
  through the native in the Play host; the negative-`OldAnimRate` norm branch
  and the `+0x224` clamp are covered by `test/play-anim.test.mjs` against the
  recovered identities. Audible playback and the full `LightSwitch.Frob`
  wrapper (native 264 integration, post-startup conversation binding) remain
  open.
