# Collector (GC) branch of the resource-class Serialize bodies

Step 4 research note, 2026-10-26. Static recovery from the hash-pinned retail
binaries; nothing here was executed. Every claim below cites the instruction
address that establishes it. Items that are derived rather than read from an
instruction are labelled **derived**; open points are collected under
"Unresolved".

## Authority

| Image | SHA-256 | Base |
| --- | --- | --- |
| `System/Engine.dll` | `0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4` | `0x10300000` |
| `System/Core.dll` | `8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4` | `0x10100000` |
| `System/Fire.dll` | `64bdcd86329f205fbae1a1bbc55dfcc8d14de23be9b9c35331ff06ff03644d28` | `0x10500000` |
| `System/Engine.u` | `1742d16f49492a02391fa6a9ca25887f0cc4f30ec9964925226217d8858737da` | (property flags) |
| `System/Fire.u` | `37346d809734188d7628115b12fb38280dc61f89b35e285d0cf39d3898183070` | (property flags) |

Engine bodies were read from `.cache/reference/Engine.asm` and re-disassembled
with capstone 5.0.7 (`.cache/native-probe-env`); Fire.dll has no prepared
listing, so it was disassembled with the same capstone, using a small PE
reader for exports, imports and vtables (scratch tooling, not committed). The
decisive Fire.dll lines are reproduced in the appendix. Script property
flags come from the compiled `Engine.u`/`Fire.u`/`Core.u` property exports
(Children/Next chain, `ArrayDim`, `PropertyFlags`), parsed with
`src/unreal/package.mjs` + `src/unreal/classes.mjs`.

## Collector archive facts used here (from existing notes)

- Collector ctor `Core 0x1015eac0`, vtable `0x1017a2f0`: `+0x04` Ver = `0x44`,
  `+0x08` = `0x44c`, `+0x0c` IsLoading = 0, `+0x10` IsSaving = 0,
  `+0x14` = 0, `+0x18` IsPersistent = 0, `+0x1c/+0x20/+0x24` = 1
  (`docs/script-class-serialization.md`).
- Archive slots: `+0x04` raw Serialize (collector: inherited no-op
  `0x10106760`), `+0x10` Preload (no-op `retl $4`), `+0x14` CountBytes (no-op
  `0x10106900`), `+0x18` `operator<<(UObject*&)` (mark + recurse, `0x1015ec90`),
  `+0x1c` `operator<<(FName&)` (clears the name's unreachable bit,
  `0x1015ee00`), `+0x28` Tell, `+0x34` Seek, `+0x38` AttachLazyLoader
  (`docs/script-object-serialization.md`, `docs/script-reference-serialization.md`,
  `docs/lodmesh-serialization.md`).
- The `+0x18` operator recurses immediately into the referent's `Serialize`
  (`+0x28`) when the referent is still unmarked, so object visits below are
  depth-first: e.g. a font page's texture (and its palette) is fully
  serialized before that page's character table is walked.
- `FCompactIndex` (`Core 0x10159b50`, import `0x10599b18` in Engine) takes its
  GC branch because `+0x0c`/`+0x10` are zero: one raw 4-byte call on the
  lvalue.
- The `+0x18` operator returns the archive itself, so helpers that chain on a
  returned archive (`eax`) still talk to the collector.

Every Engine TArray helper below has the same compiled shape:
`CountBytes(Num*size, Max*size)`, then `test [Ar+0x0c]; je <GC/save branch>`.
For each one the `je` target was checked to land on the **second**
`FCompactIndex` call (the non-loading branch), and the lvalue passed there is
the array's own `Num` word (`lea r, [array+4]` in the prologue). The single
exception is UTexture's mip array (stack copy of `Num`, see below).

## Serialize dispatch (vtable slot `+0x28`)

| Class | Instance vtable | `+0x28` | Body | Super chain actually called |
| --- | --- | --- | --- | --- |
| UBitmap | `0x104266b8` | `0x1040c76a` = `jmp [0x10599b10]` | Core `0x1010178f -> 0x10150210` | UObject only (no override) |
| UTexture | `0x1042672c` | `0x10301a32` | `0x103ed470` | UObject (`call [0x10599b10]` at `0x103ed49f`; UBitmap has none) |
| UScriptedTexture | `0x10429648` | `0x10301a32` | `0x103ed470` | = UTexture (no override) |
| UPalette | `0x10426654` | `0x10303f6c` | `0x103ef430` | UObject (`0x103ef45e`) |
| USound | `0x10429580` | `0x103029fa` | `0x1036f900` | UObject (`0x1036f949`) |
| UMusic | `0x104295e4` | `0x10302eb4` | `0x10370bd0` | UObject (`0x10370c03`) |
| UFont | `0x10426878` | `0x10302342` | `0x10385400` | UObject (`0x10385431`) |
| UPrimitive | `0x1042655c` | `0x10303c0b` | `0x103d82d0` | UObject (`0x103d8301`) |
| UMesh | `0x104290b8` | `0x10301717` | `0x103a63b0` | UPrimitive (`0x103a63e1`) |
| ULodMesh | `0x1042942c` | `0x103024b9` | `0x10354ab0` | UMesh (`0x10354b03`) |
| Fire UFractalTexture | `0x10510ce4` | `0x1050e650` = `jmp [0x10510108]` | Engine UTexture `0x103ed470` | = UTexture |
| Fire UWaterTexture | `0x10510e5c` | `0x1050e650` | UTexture | = UTexture |
| Fire UWaveTexture | `0x10510edc` | `0x1050e650` | UTexture | = UTexture |
| Fire UWetTexture | `0x10510f80` | `0x1050e650` | UTexture | = UTexture |
| Fire UIceTexture | `0x10511000` | `0x1050e650` | UTexture | = UTexture |
| Fire UFireTexture | `0x10510d64` | `0x10508300` (exported body) | `0x10508300` | UTexture (`call [0x10510108]` at `0x1050832e`) |

`0x10510108` is Fire.dll's IAT entry for Engine `?Serialize@UTexture@@`.

## Part (b): what UObject::Serialize visits for these classes

UObject::Serialize (Core `0x10150210`, `docs/script-object-serialization.md`)
does, on this archive: Preload(Class) (no-op), Name `+0x20` via `+0x1c`,
Outer `+0x18`, Class `+0x24`, Linker `+0x10` via `+0x18`, the FStateFrame
block only when `ObjectFlags & 0x02000000`, then `Class->SerializeBin`
(`Core 0x10126610`) and `CountBytes(size, size)`.

SerializeBin walks the class's Children/Next chain filtered to UProperty
(`0x10102f9a -> 0x1012b1e0`), then each super's chain. Per property it skips
flag `0x1000` (Native) always and `0x2000` (Transient) only when Ar`+0x18` is
nonzero; the collector's `+0x18` is 0, so **transient properties are visited**.
ObjectProperty items go straight to archive `+0x18`
(`UObjectProperty::SerializeItem 0x10166bb0`).

- `Core.Object`'s five properties (`ObjectInternal[6]`, `Outer`,
  `ObjectFlags`, `Name`, `Class`) are all flag `0x1000` (Native): skipped.
- **Intrinsic classes** Sound, Music, Font, Primitive, Mesh, LodMesh have no
  Class export in `Engine.u` (Engine.u imports `Engine.Sound`, `Engine.Font`,
  `Engine.Mesh`, `Engine.Music`, `Engine.Primitive` as classes), and Engine
  exports no `StaticConstructor` for them, so they own no properties. Part
  (b) is **empty** for USound, UMusic, UFont, UPrimitive, UMesh, ULodMesh.

Script object references visited by SerializeBin, in visit order (own class
first, then supers). Flags are the compiled `PropertyFlags`.

| Class | Object-reference properties in visit order |
| --- | --- |
| Bitmap | `Palette` (Palette, flags `0x1`) at `+0x2c` |
| Palette | none (`Colors` is `0x1002` Native, skipped) |
| Texture | `BumpMap`, `DetailTexture`, `MacroTexture` (Texture, `0x1`); `FootstepSound`, `HitSound` (Sound, `0x1`); `AnimNext` (Texture, `0x1`); `AnimCurrent` (Texture, `0x2000` Transient, **visited**); then Bitmap `Palette` |
| ScriptedTexture | `NotifyActor` (**Actor**, `0x0`), `SourceTexture` (Texture, `0x1`); then the Texture list, then `Palette` |
| FractalTexture (Fire) | none own (seven transient ints/bytes); then Texture list, then `Palette` |
| FireTexture | none own; `Sparks` (ArrayProperty of struct `Spark`, `0x402000` Transient+NeedCtorLink) **is visited** through `UArrayProperty::SerializeItem` (`Core 0x10168520`: count raw 4, then each element through `UStructProperty::SerializeItem 0x101691b0`) but `Spark` is eight bytes (`Type, Heat, X, Y, ByteA..ByteD`), no references; then FractalTexture, Texture, Bitmap |
| WaterTexture | none own; `Drops[256]` (struct `ADrop`, `0x0`) visited via StructProperty, eight bytes (`Type, depth, X, Y, ByteA..ByteD`), no references; then FractalTexture, Texture, Bitmap |
| WaveTexture | none own; then WaterTexture (Drops), FractalTexture, Texture, Bitmap |
| WetTexture | `SourceTexture` (Texture, `0x1`), `OldSourceTex` (Texture, `0x2000`, **visited**); then WaterTexture, FractalTexture, Texture, Bitmap |
| IceTexture | `GlassTexture`, `SourceTexture` (Texture, `0x1`), `OldGlassTex`, `OldSourceTex` (Texture, `0x2000`, **visited**); then FractalTexture, Texture, Bitmap |

So a plain Texture's full script reference order is:
BumpMap, DetailTexture, MacroTexture, FootstepSound, HitSound, AnimNext,
AnimCurrent, Palette.

Non-reference script properties (bytes, ints, floats, bools, the `Color`
structs `MipZero`/`MaxColor` whose members are four config bytes, enums) are
still dispatched through their SerializeItem slots but reach only raw/Preload
(both no-ops on the collector).

Offsets of the Texture script properties:

| Property | Offset | Evidence |
| --- | --- | --- |
| Bitmap.Palette | `+0x2c` | **derived** (SDK and retail agree before `+0x4c`; `docs/fire-texture.md` confirms UBits `+0x30`, USize `+0x34`) |
| BumpMap / DetailTexture / MacroTexture | `+0x54` / `+0x58` / `+0x5c` | **derived**: SDK offset - 4 (retail `InternalTime[2]` at `+0x4c` is not 8-aligned) |
| FootstepSound / HitSound | `+0x78` / `+0x7c` | **derived**, same shift |
| bool DWORD 2 (bParametric `0x08`, bHasComp `0x20`) | `+0x84` | instruction: `0x103ed4af`, `0x103ed4f7` |
| LODSet | `+0x88` | instruction: `0x103ed72b` |
| AnimNext / AnimCur(rent) | `+0x8c` / `+0x90` | instruction, `docs/texture-animation.md` |
| Mips / CompMips | `+0xa4` / `+0xb0` | instruction: `0x103ed4e0`, `0x103ed4fb` |
| ScriptedTexture NotifyActor / SourceTexture | `+0xc0` / `+0xc4` | **derived** (UTexture retail size `0xc0`, FractalTexture UMask at `+0xc0` per fire-texture.md) |
| Wet/Ice texture properties | linker-computed | not recovered here |

The live collector reads each property's linked offset at property `+0x48`,
so the host should use its own linked offsets; the table above is for
cross-checking.

## Part (a): native bodies, collector path, in order

Notation: `obj(+off)` = archive `+0x18` on that slot; `name(+off)` = archive
`+0x1c`; `raw(+off, n)` = archive `+0x04` (collector no-op);
`count(lv)` = FCompactIndex (raw 4 in GC); `CB(a, b)` = archive `+0x14`
CountBytes (collector no-op). Offsets are from the object unless an element
base is named.

### UPrimitive — thunk `0x10303c0b`, body `0x103d82d0`

1. UObject::Serialize.
2. `raw(+0x28..+0x3c, 4)` six times (BoundingBox Min/Max), `raw(+0x40, 1)`
   (IsValid) — `0x103d8311..0x103d835f`.
3. `Ver(+0x04) > 0x3d` (`0x103d8368`; collector `0x44` takes it): `raw(+0x44,4)`,
   `raw(+0x48,4)`, `raw(+0x4c,4)`, `raw(+0x50,4)` (BoundingSphere). The
   `<= 0x3d` side does three calls.

Native object references: **none**. Names: none.

### UMesh — thunk `0x10301717`, body `0x103a63b0`

1. UPrimitive::Serialize (`0x103a63e1`).
2. Verts lazy array `+0x54` (`0x103028c9 -> 0x103a8f70`). Like every lazy
   helper: IsLoading (`+0x0c`) false, then `IsSaving && Ver > 0x3d` false,
   so the else branch calls the TArray serializer on the FArray at
   `+0x60` (`lazy+0xc`): `0x1031b680`: `CB(N*8, M*8)`, `count(&Num)`,
   per element `raw(e+0,4)`, `raw(e+4,4)`.
3. Tris lazy array `+0x6c` (`0x103a9170 -> 0x1031b840`, FArray `+0x78`):
   `CB(N*0x14, M*0x14)`, `count`, per element raws
   `2@+0, 2@+2, 2@+4, 1@+6, 1@+7, 1@+8, 1@+9, 1@+0xa, 1@+0xb, 4@+0xc, 4@+0x10`.
4. Assert at `0x103a63fd`, **not mode-gated**: if `Tris.Num(+0x7c) != 0`
   and `WORD Tris(0)+0 >= Verts.Num(+0x64)`, `appFailAssert` (line `0x29`).
5. AnimSeqs `+0x84` (`0x10303107 -> 0x103a9370`), eager TArray:
   `CB(N*0x20, M*0x20)`, `count(&Num)`, per sequence `s` (stride `0x20`):
   `name(s+0x00)` Name, `name(s+0x04)` Group (`0x103a94ee`, `0x103a94f9`),
   `raw(s+0x08,4)` StartFrame, `raw(s+0x0c,4)` NumFrames, Notifys TArray at
   `s+0x14` (`0x103a9700`: `CB(N*8, M*8)`, `count`, per notify `n`:
   `raw(n+0,4)` Time then `name(n+4)` Function at `0x103a9818`), then
   `raw(s+0x10,4)` Rate.
6. Connects lazy array `+0x90` (`0x103a9920 -> 0x1031bc10`): `CB(N*8, M*8)`,
   `count`, per element `raw 4, raw 4`.
7. Second bounds pass on the archive returned by step 6: `raw(+0x28,4)`,
   `raw(+0x2c,4)`, `raw(+0x30,4)`, FVector helper `0x103a98d0` on `+0x34`
   (3 x raw 4), `raw(+0x40,1)`; `Ver > 0x3d`: FVector on `+0x44`, then
   `raw(+0x50,4)`.
8. VertLinks lazy array `+0xc0` (`0x103a9d90 -> 0x1031b460`): `CB(N*4, M*4)`,
   `count`, `raw 4` per element.
9. **Textures `+0xd8`** (`0x10303404 -> 0x103a9f90`): `CB(N*4, M*4)`,
   `count(&Num +0xdc)`, then for `i = 0 .. Num-1`: **`obj(Data + i*4)`**
   (`0x103aa076`). This is the only native object reference in the mesh
   chain.
10. BoundingBoxes `+0xa8` (`0x103014fb -> 0x103a8cd0`): `CB(N*0x1c, M*0x1c)`,
    `count`, per FBox `raw 4` x6 then `raw(+0x18,1)`.
11. BoundingSpheres `+0xb4` (`0x10302ff9 -> 0x103a9b20`): `CB(N*0x10, M*0x10)`,
    `count`, per FSphere `Ver > 0x3d`: `raw 4` x4 (else x3).
12. Scalars, `raw 4` each: `+0xf0` FrameVerts, `+0xf4` AnimFrames, `+0xf8`
    AndFlags, `+0xfc` OrFlags, `+0x100/+0x104/+0x108` Scale,
    `+0x10c/+0x110/+0x114` Origin, `+0x118/+0x11c/+0x120` RotOrigin,
    `+0x124` CurPoly, `+0x128` CurVertex.
13. `Ver == 0x41` → one raw 4 into a stack temporary: **not taken** (`0x44`).
14. `Ver >= 0x42` (taken): TextureLOD `+0xe4` (`0x10301fd2 -> 0x103aa110`):
    `CB(N*4, M*4)`, `count`, `raw 4` per float.

Native object references, in order: `Textures(i)` at `*(+0xd8) + 4i` for each
`i`. Native name references, in order: per AnimSeq `Name(+0)`, `Group(+4)`,
then each notify's `Function(+4)`.

Field names for `+0x54..+0x128` are from the SDK layout (`.cache/sdk-layouts.json`),
whose UMesh/ULodMesh offsets match every native access above.

### ULodMesh — thunk `0x103024b9`, body `0x10354ab0`

1. `IsSaving (+0x10)` → empty the Tris FArray: **skipped** (`0x10354ae3`).
2. UMesh::Serialize (`0x10354b03`) — everything above.
3. TArray<WORD> CollapsePointThus `+0x12c` (`0x10356e60`: `CB(N*2, M*2)`,
   `count`, `raw 2` each).
4. TArray<WORD> FaceLevel `+0x138` (same helper).
5. Faces `+0x144` (`0x10356fe0`: `CB(N*8, M*8)`, `count`, per face `raw 2` x4).
6. TArray<WORD> CollapseWedgeThus `+0x150`.
7. Wedges `+0x15c` (`0x103571f0`: `CB(N*4, M*4)`, `count`, per wedge
   `raw 2`, `raw 1`, `raw 1`).
8. Materials `+0x168` (`0x103573d0`: `CB(N*8, M*8)`, `count`, per material
   `raw 4` PolyFlags, `raw 4` TextureIndex). Integer index into
   `UMesh.Textures`, not an object reference.
9. SpecialFaces `+0x174` (Faces helper).
10. `raw 4` each, in this order: `+0x180` ModelVerts, `+0x184` SpecialVerts,
    `+0x188` MeshScaleMax, `+0x19c` LODHysteresis, `+0x18c` LODStrength,
    `+0x190` LODMinVerts, `+0x194` LODMorph, `+0x198` LODZDisplace.
11. TArray<WORD> RemapAnimVerts `+0x1a0`; then `raw(+0x1ac,4)` OldFrameVerts
    on the returned archive.
12. `IsLoading && RemapAnimVerts.Num` → vertex remap: **skipped** (`0x10354c18`).

Native object references added by ULodMesh: **none**. Total for a LodMesh:
the UMesh `Textures` elements only, plus the AnimSeq/notify names.

### UTexture — thunk `0x10301a32`, body `0x103ed470` (also UScriptedTexture and the five Fire subclasses)

1. UObject::Serialize (`0x103ed49f`).
2. `(IsSaving || IsLoading) && (+0x84 & 0x08 bParametric)` → empty each mip's
   data: **skipped** (`0x103ed4a5..0x103ed4b6`).
3. Mips `+0xa4` (`0x103ed690(this, Ar, &Mips)`): `CB(N*0x28, M*0x28)`;
   GC branch `0x103ed7f5`: `count(stack copy of Num)` (`0x103ed7f5..0x103ed800`:
   `Num` is copied to `[ebp+0xc]` and that address is passed; the only helper
   here that passes a copy), then per mip `m` (stride `0x28`)
   `0x103f0d80`:
   - lazy DataArray `m+0x10` (`0x103039ef -> 0x10371140`): neither IsLoading
     nor IsSaving → `0x1030cca0` on the FArray at `m+0x1c`: `CB(N, M)`,
     `count(&Num m+0x20)`, `raw(Data, Num)`;
   - `raw(m+4,4)` USize, `raw(m+8,4)` VSize, `raw(m+0xc,1)` UBits,
     `raw(m+0xd,1)` VBits.
4. `+0x84 & 0x20` (bHasComp) → the same helper on CompMips `+0xb0`
   (`0x103ed4f7`). Data-dependent; not mode-gated.
5. `(IsSaving || IsLoading) && bParametric` → zero-fill: **skipped**
   (`0x103ed50c..0x103ed525`).

Native object references: **none**. The mip helper's loading branch touches
`GEngine`/LODSet and `GLazyLoad` (`0x103ed71d..0x103ed7f0`), outside GC.

### UFireTexture (Fire.dll) — body `0x10508300`

1. UTexture::Serialize (`0x1050832e`).
2. `IsSaving (+0x10)` → drop temporary sparks (`Type >= 0x1f`) and trim to
   SparksLimit: **skipped** (`0x10508334..0x1050840a`).
3. Sparks `+0xf4` (`0x1050a3f0`): `CB(N*8, M*8)`; GC branch `0x1050a522`:
   `count(&Num +0xf8)`, per spark `raw 1` x8 (`+0..+7`).
4. **Ungated side effect** (`0x1050841a..0x10508455`): if
   `Sparks.Num(+0xf8) < SparksLimit(+0xec)`, `Num` is raised to `SparksLimit`
   and `FArray::Realloc(8)` runs when it exceeds `Max`; the new elements are
   not initialised. This runs on the collector path. Normally a no-op after
   load (fire-texture.md: PostLoad sizes the array to the clamped limit), but
   it is a mutation, not an archive operation.

Native object references: **none**. (The `Sparks` array is serialized twice in
GC: once by SerializeBin through the transient ArrayProperty, once here.)

### UPalette — thunk `0x10303f6c`, body `0x103ef430`

1. UObject::Serialize.
2. Colors `+0x28` (`0x10302b35 -> 0x103f0a00`): `CB(N*4, M*4)`; GC branch
   `0x103f0afb`: `count(&Num +0x2c)`, per color `raw 1` x4 (R,G,B,A).
3. `Ver < 0x42` → force alpha `0xff`: **skipped** — version-gated
   (`0x103ef474`), not mode-gated.

Native object references: **none**.

### UBitmap — no Serialize override

`+0x28` jumps to the Core UObject::Serialize import. Native part: nothing
beyond UObject. Part (b): `Palette`.

### UFont — thunk `0x10302342`, body `0x10385400`

1. UObject::Serialize (`0x10385431`).
2. Save `GLazyLoad`, set it to 1 (`0x10385437..0x10385449`).
3. Pages `+0x2c` (`0x1030354e -> 0x10385680`): `CB(N*0x10, M*0x10)`; GC branch
   `0x10385783`: `count(&Num +0x30)`, then per page `p` (stride `0x10`),
   `0x10385940`:
   - **`obj(p+0)` Texture** (`0x10385971`);
   - Characters TArray `p+4` on the returned archive (`0x10385a00`):
     `CB(N*0x10, M*0x10)`, `count(&Num p+8)`, per character `raw 4` x4
     (StartU, StartV, USize, VSize; `0x10385bb0`).
4. `raw(+0x28, 4)` CharactersPerPage on the archive returned by step 3
   (`0x1038545e`).
5. Assert `(CharactersPerPage & (CharactersPerPage-1)) == 0`, reached on this
   path (`0x10385461..0x10385476`).
6. The page-texture mip-load loop at `0x1038548a` runs only if the *current*
   `GLazyLoad` is 0 (`0x1038547f`); step 2 set it to 1, so it is skipped here.
   Observation: as compiled it appears unreachable on every path unless a
   nested call clears the global; not needed for GC.
7. Restore `GLazyLoad` (`0x103854e6`).

Native object references, in order: `Pages(i).Texture` for each page `i`
(each followed by that page's raw character table).

### USound — thunk `0x103029fa`, body `0x1036f900`

1. Save `GLazyLoad`, set it to 1 (`0x1036f92c..0x1036f93c`) — *before*
   UObject::Serialize, so collector recursion out of a sound's header
   references runs with it set (no GC-visible effect found: every
   GLazyLoad test in these bodies is on a loading branch).
2. UObject::Serialize (`0x1036f949`).
3. **`name(+0x44)` FileType** (`0x1036f95e`).
4. `IsLoading || IsSaving` → lazy `Data` `+0x28` serializer: **skipped**.
   GC else branch: `CB(OriginalSize +0x48, OriginalSize +0x48)` (`0x1036f9aa`).
5. Restore `GLazyLoad`.

Native object references: **none**. Name: FileType.

### UMusic — thunk `0x10302eb4`, body `0x10370bd0`

1. UObject::Serialize.
2. **`name(+0x40)` FileType** (`0x10370c18`).
3. `IsLoading || IsSaving` → lazy `Data` `+0x28` (+ OriginalSize fix-up on
   load): **skipped**. GC: `CB(OriginalSize +0x44, OriginalSize +0x44)`
   (`0x10370c85`).

No GLazyLoad handling. Native object references: **none**. Name: FileType.

USound/UMusic field offsets (`Data +0x28`, `FileType`, `OriginalSize`) agree
with the SDK layout.

## Summary of collector-visited references

| Class | Native body: object refs (order) | Native body: names | Script object properties via UObject::Serialize |
| --- | --- | --- | --- |
| UPrimitive | none | none | none (intrinsic) |
| UMesh | `Textures(i)` at `[+0xd8]+4i` | AnimSeq Name, Group, notify Function | none (intrinsic) |
| ULodMesh | UMesh's only | UMesh's only | none (intrinsic) |
| UBitmap | none (no override) | none | Palette |
| UTexture | none | none | BumpMap, DetailTexture, MacroTexture, FootstepSound, HitSound, AnimNext, AnimCurrent, Palette |
| UScriptedTexture | none | none | NotifyActor, SourceTexture, then the Texture list |
| UPalette | none | none | none |
| UFont | `Pages(i).Texture` at `[+0x2c]+0x10i` | none | none (intrinsic) |
| USound | none | FileType `+0x44` | none (intrinsic) |
| UMusic | none | FileType `+0x40` | none (intrinsic) |
| Fractal/Water/Wave (Fire) | none | none | Texture list only |
| UFireTexture | none | none | Texture list only (Sparks visited, no refs) |
| UWetTexture | none | none | SourceTexture, OldSourceTex, then Texture list |
| UIceTexture | none | none | GlassTexture, SourceTexture, OldGlassTex, OldSourceTex, then Texture list |

The UObject header (Name, Outer, Class, Linker) precedes all of these for
every class.

## Discrepancies with existing notes (corrected 2026-10-26)

- `docs/lodmesh-serialization.md` lists UMesh's later arrays as "`mesh+0xa8`,
  `mesh+0xb4` ..., `mesh+0xc0`, `mesh+0xd8`". The call order at
  `0x103a64d5..0x103a650d` is `+0xc0` (VertLinks), `+0xd8` (Textures),
  `+0xa8` (BoundingBoxes), `+0xb4` (BoundingSpheres). Its helper-to-offset
  pairs are right; only the order is wrong. It also calls the ULodMesh tail
  "compact-index/string fields at `+0x12c..+0x174`"; they are TArrays of
  WORD / FMeshFace / FMeshWedge / FMeshMaterial.
- The SDK UTexture layout is 4 bytes larger than retail from `+0x4c`
  (already recorded in `docs/texture-animation.md`); do not take UTexture or
  UScriptedTexture property offsets from `.cache/sdk-layouts.json`.

## Unresolved / not verified

- Nothing was executed. The order and branch selection are read from
  instructions; an oracle run of these bodies with the collector state would
  confirm the traces but was not done.
- BumpMap..HitSound and ScriptedTexture property offsets are derived (see
  table). Fire-class property offsets were not recovered; the collector uses
  the linked property offset anyway.
- `RF_HasStack` (`0x02000000`) on a resource object would add the FStateFrame
  references. Checked: none of the 17,985 serialized Texture/ScriptedTexture/
  Palette/Sound/Music/Font/Mesh/LodMesh/Fire-texture exports in the 219
  packages under `System`, `Textures`, `Sounds`, `Music` and `Maps` carries
  the flag in its export-table flags. Runtime-constructed resource objects
  (and flags set after load) were not checked.
- UFireTexture's ungated Sparks growth on the GC path (above) and the UMesh
  Tris/Verts assert are side effects/asserts on the collector path, not
  archive operations; a host that implements this path must decide how to
  model them.
- Fire.dll also imports `UPalette::Serialize` (IAT `0x10510128`); its user was
  not traced (no Fire class's `+0x28` points at it).
- CountBytes argument order for the Tris helper (`0x1031b840`) was not
  individually checked; both arguments are `*0x14` and the collector body is
  a no-op.
- The UFont mip-load loop reachability (step 6) is an observation only.

## Appendix: decisive Fire.dll instructions (capstone 5.0.7, Intel syntax)

UFireTexture::Serialize `0x10508300`:

```
1050832e: call dword ptr [0x10510108]   ; Engine.dll!?Serialize@UTexture@@UAEXAAVFArchive@@@Z
10508334: mov eax, dword ptr [ebx + 0x10]   ; Ar.IsSaving
10508337: test eax, eax
10508339: je 0x1050840d                     ; collector: skip temporary-spark removal
...
1050840d: lea edi, [esi + 0xf4]             ; &Sparks
10508413: push edi
10508414: push ebx
10508415: call 0x1050a3f0                   ; Sparks TArray serializer
1050841a: mov eax, dword ptr [esi + 0xf8]   ; Sparks.Num
10508420: mov esi, dword ptr [esi + 0xec]   ; SparksLimit
10508429: cmp eax, esi
1050842b: jge 0x1050845b                    ; no mode gate before this growth
1050842d: mov ecx, dword ptr [edi + 4]
10508430: sub esi, eax
10508432: mov eax, dword ptr [edi + 8]
10508435: add ecx, esi
10508437: cmp ecx, eax
10508439: mov dword ptr [edi + 4], ecx      ; Num = SparksLimit
1050843c: jle 0x1050845b
...
10508455: call dword ptr [0x10510098]       ; Core.dll!?Realloc@FArray@@IAEXH@Z
```

Sparks serializer `0x1050a3f0`:

```
1050a41c: lea edi, [ebx + 4]                ; &Sparks.Num
1050a422: shl ecx, 3                        ; Max*8
1050a425: shl edx, 3                        ; Num*8
1050a428: push ecx
1050a429: push edx
1050a433: call dword ptr [eax + 0x14]       ; CountBytes(Num*8, Max*8)
1050a436: mov eax, dword ptr [esi + 0xc]    ; Ar.IsLoading
1050a439: test eax, eax
1050a43b: je 0x1050a522                     ; collector branch
...
1050a522: push edi
1050a523: push esi
1050a524: call dword ptr [0x105100b4]       ; Core FCompactIndex (raw 4 in GC)
1050a532: cmp eax, dword ptr [ebx + 4]
1050a53b: push 1
1050a53d: lea edi, [ecx + eax*8]
1050a543: call dword ptr [edx + 4]          ; raw(spark+0, 1)
...                                         ; raw(spark+1..+6, 1)
1050a596: add edi, 7
1050a599: push 1
1050a59e: call dword ptr [edx + 4]          ; raw(spark+7, 1)
```

Fire vtable `+0x28` stub shared by FractalTexture/Water/Wave/Wet/Ice:

```
1050e650: jmp dword ptr [0x10510108]        ; Engine.dll!?Serialize@UTexture@@UAEXAAVFArchive@@@Z
```
