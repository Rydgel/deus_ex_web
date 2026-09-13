# Original `ULodMesh::Serialize` (GOTY) recovered layout

Evidence for the mesh payload consumed by the training `LightSwitch.Frob`
route (stage-3-handoff item 1). This replaces the open question in
[script-play-anim.md](script-play-anim.md) ("Serialized mesh: GOTY does not
match SurrealEngine's reader") — the SurrealEngine `UMesh::Load` reader
indeed does not apply; the GOTY layout below was recovered from the original
native code, not from a public reader.

## Method

The original `ULodMesh::Serialize` (`Engine.dll` image base `0x10300000`,
thunk `0x10324b9` → body `0x10354ab0`, SHA-256
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`) was
executed in the unicorn x86 emulator against the real serialized
`DeusExDeco.u` export 606 payload, using a fake loading `FArchive`
(version 68) with Python-backed `FArchive` virtuals. The engine import
`0x10599b10` (`Core` `UObject::Serialize`) was stubbed to consume the
tagged-property prefix with the repo's existing verified tagged reader, and
`Core`'s `GMalloc` (`0x101a7c44`, `FArray::Realloc` target) was backed by a
Python allocator. Every raw `FArchive::Serialize(void*, INT)` call was
recorded as (archive offset → mesh field offset, length, bytes), producing
the layout below directly from original instructions rather than from a
guess. Driver: `scripts/native-lodmesh-oracle.py`.

`FArchive` virtual slots were identified from Core's own
`??_7FArchive@@6B@` vtable (`0x101751f8`): slot 1 `Serialize(void*, INT)`,
slot 6 `operator<<(UObject*&)`, slot 7 `operator<<(FName&)`, slot 10 `Tell`,
slot 13 `Seek`, slot 14 `AttachLazyLoader(FLazyLoader*)`. The base
`FArchive::operator<<(FName&)` body (`0x10106920`) is a no-op; package
loading supplies the linker override, which reads a compact index into the
package name table. Engine import `0x10599b18` is Core's
`operator<<(FArchive&, FCompactIndex&)` and `0x10599a20` is
`FArray::Realloc`.

## Serialized layout (package version 68)

### 1. Tagged properties

`UObject::Serialize` writes the tagged property stream in the repo's
established format. Native `LodMesh` exports carry no authored properties:
a single `0x00` byte (name index 0, `None`).

### 2. `UPrimitive::Serialize` (thunk `0x10303c0b`, body `0x103d82d0`)

```
UObject::Serialize(Ar)                      // tagged stream above
Ar.Serialize(this+0x28, 4)                  // BBox.Min.X
Ar.Serialize(this+0x2c, 4)                  // BBox Min.y
Ar.Serialize(this+0x30, 4)                  // BBox Min.z
Ar.Serialize(this+0x34, 4)                  // BBox Max.x
Ar.Serialize(this+0x38, 4)                  // BBox Max.y
Ar.Serialize(this+0x3c, 4)                  // BBox Max.z
Ar.Serialize(this+0x40, 1)                  // BBox valid byte
if (Ar.Ver() > 61):                         // DeusExDeco.u is 68
    Ar.Serialize(this+0x44, 4)              // Sphere center.x
    Ar.Serialize(this+0x48, 4)              // Sphere center.y
    Ar.Serialize(this+0x4c, 4)              // Sphere center.z
    Ar.Serialize(this+0x50, 4)              // Sphere radius
else:
    Ar.Serialize(this+0x44, 4)              // center only, no radius
```

The `Ar.Ver()` field lives at archive `+0x4` (compared with `0x3d` = 61).

### 3. `UMesh::Serialize` (thunk `0x10301717`, body `0x103a63b0`)

Calls `UPrimitive::Serialize`, then, in order, array serializers at
`mesh+0x54`, `mesh+0x6c` (via helpers `0x103028c9`→`0x103a8f70` and
`0x103024a0`→`0x103a9170`), an assertion comparing `WORD(mesh+0x78)` with
`mesh+0x64`, the AnimSeq serializer at `mesh+0x84` (helper `0x10303107` →
`0x103a9370`), a fourth array at `mesh+0x90` (helper `0x103010a5` →
`0x103a9920`), a second full bbox/sphere pass into `mesh+0x28..+0x50`
(direct `Ar.Serialize` calls plus helper `0x10301b54`→`0x103a98d0`), arrays
at `mesh+0xa8`, `mesh+0xb4` (helpers `0x103014fb`→`0x103a8cd0`,
`0x10302ff9`→`0x103a9b20`), `mesh+0xc0`, `mesh+0xd8` (helpers
`0x10303f8f`→`0x103a9d90`, `0x10303404`→`0x103a9f90`), and finally
`ULodMesh::Serialize`'s tail: compact-index/string fields at
`mesh+0x12c..+0x174` and raw dwords `mesh+0x180..+0x1ac`.

**Lazy arrays (version > 61):** the `TLazyArray` serializers at
`mesh+0x54`, `+0x6c`, `+0x90`, `+0xc0` (and, with slight variants,
`+0xa8`, `+0xb4`, `+0xd8`) serialize as:

1. `Ar.Serialize(&marker, 4)` — a 4-byte value interpreted as a package
   file offset (the lazy-load position).
2. `Ar.AttachLazyLoader(array)` (slot 14) — base `FArchive` implementation
   (`0x10106a40`) is a no-op `ret 4`; `ULinkerLoad` records the loader.
3. `if (GLazyLoad == 0) array->vt[0]()` — Core global `?GLazyLoad@@3HA`
   (`0x10599cc0` import) reentrancy gate.
4. `Ar.Seek(marker)` — the seek lands exactly on the next serialized field,
   so the array's inline blob is `[current position, marker)`.

The blob begins with a compact element count followed by the elements. For
LightSwitch the `mesh+0x54` blob is `0x2c` (compact 44) followed by 44×8
bytes = exactly the 353-byte gap the Seek skips. The element identity
(FMeshVert/Tris/other) is **not** established by this note; mesh geometry
decoding belongs to the Stage 4 renderer.

### 4. AnimSeq array (`mesh+0x84`, helper `0x103a9370`)

Serialized eagerly (no lazy marker):

```
count = Ar << FCompactIndex
destroy old elements; FArray::Realloc(0x20 × count)
for each entry (0x20 bytes):
    entry+0x00 = Ar << FName            (compact name index)
    entry+0x04 = Ar << FName            (compact name index, Group)
    entry+0x08 = Ar.Serialize(.., 4)    (StartFrame, int32)
    entry+0x0c = Ar.Serialize(.., 4)    (NumFrames, int32)
    entry+0x14 = notify TLazyArray      (compact count; count × 8 bytes,
                                         not lazy in this call)
    entry+0x10 = Ar.Serialize(.., 4)    (Rate, float32; default-filled 30.0f
                                         before reading)
```

Fields match the `execPlayAnim` consumer contract: `+0x0c` NumFrames (`int32`,
used as `fildl`/`fidivl`), `+0x10` Rate multiplier, and `+0x18` (the notify
array's `Num`) as the "non-zero feeds the animation loop flag" dword.

## Annotated parse of export 606 (LightSwitch, 1,272 bytes)

| payload offset | bytes | meaning |
| --- | --- | --- |
| 0x000 | `00` | tagged properties: `None` |
| 0x001–0x018 | 6×f32 | BBox Min `(-960, -162, -1600)`, Max `(960, 162, 1600)` |
| 0x019 | `01` | BBox valid |
| 0x01a–0x029 | 3×f32 + f32 | Sphere center `(0, 0, 0)`, radius `0x44ea5980` |
| 0x02a–0x02d | `1c 99 8d 00` | `mesh+0x54` lazy marker = file offset 9,279,772 (payload 0x18f) |
| 0x02e–0x18e | blob | compact count 44 (`0x2c`) + 44 × 8-byte elements (352 bytes) |
| 0x18f–0x192 | `21 99 8d 00` | `mesh+0x6c` lazy marker = payload 0x194 |
| 0x193 | `00` | `mesh+0x6c` blob (1 byte, empty) |
| 0x194 | `04` | AnimSeq compact count = 4 |
| 0x195–0x1d0 | 4 × entry | see table below |
| 0x1d1–0x1d4 | `63 99 8d 00` | `mesh+0x90` lazy marker = payload 0x1fe... (blob 1 byte) |
| 0x1d6–0x1ff | 41 bytes | second bbox/sphere pass (identical values) |
| 0x200–0x202 | `00 01 6a` | `mesh+0x90`/`+0xa8` tails, version-gated one-byte fields |
| ... | | remaining `mesh+0xa8/+0xb4/+0xc0/+0xd8/+0x12c..` fields |
| 0x2b4–0x4f7 | 580 bytes | lazy array data (not consumed by `Serialize`) |

LightSwitch AnimSeq table (names resolved against the `DeusExDeco.u` name
table: 12=`All`, 13=`Still`, 15=`Off`, 18=`On`):

| seq | Name | Group | StartFrame | NumFrames | Notifies | Rate |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | `All` (12) | None | 0 | 2 | 0 | 30.0 |
| 1 | `Still` (13) | None | 0 | 1 | 0 | 30.0 |
| 2 | `Off` (15) | None | 0 | 1 | 0 | 30.0 |
| 3 | `On` (18) | None | 1 | 1 | 0 | 30.0 |

The serialized `Rate` (30.0) is the value later multiplied by the actor's
Rate argument inside `execPlayAnim` (`seq+0x10`).

## Validation

The oracle ran the original serializer to completion (clean return) against:

| export | class | consumed |
| --- | --- | --- |
| 606 `LightSwitch` | LodMesh | 692 of 1272 (rest = lazy data) |
| 399 `Plant2` | LodMesh | 999 of 1588 |
| 398 `Buoy` | LodMesh | 1032 of 1475 |
| 454 `Tree1` | LodMesh | **992 of 992 (exact)** |
| 499 `Flask` | LodMesh | 842 of 943 |
| 401 `Bushes3` | LodMesh | 528 of 633 |
| `DeusExCharacters` 669 `GM_Trench` | LodMesh | **1,019,128 of 1,019,128 (exact)** |

`Tree1` consuming exactly the export size establishes the layout end-to-end
for a mesh without a lazy tail. `Pan1`, `CardReader`, `Trashbag`,
`CoffeeTable` and `ShowerFaucet` exceeded the probe's 0x23000000 scratch
allocation cap (probe limitation, not a format question). `SignFloor`
consumed 624 of 625 bytes and then requested four more; unexplained, flagged
open. Non-LodMesh exports (`Mesh` classes, textures) are out of scope for
`ULodMesh::Serialize` and were not validated.

The initial browser decoder and native-oracle archive shim accidentally treated
compact values as ordinary 7-bit LEB128. UE1 `FCompactIndex` instead uses sign,
continuation and six payload bits in byte zero, followed by 7+7+7+5 bits. The
small `DeusExDeco` sequence-name indices did not expose that difference.
`GM_Trench` does: after correcting both readers, the original serializer returns
at the exact end and the browser recovers 71 sequences, including `HitTorso`
at frame 71 (4 frames, rate 10) and `HitLegLeft` at frame 79 (4 frames, rate 10).

## Status

- The tagged prefix, bbox/sphere, lazy-array markers and AnimSeq entry
  layout above are established from executed original code and validated
  against real exports; the sequence table for LightSwitch is decoded.
- `GM_Trench` executes the original serializer to the exact end and its full
  71-entry AnimSeq table is available to native PlayAnim. Lazy geometry is not
  read by native 259 when it writes animation state.
- Open: the identity of the individual `mesh+0x54/+0x6c/+0x90/...` arrays
  (Verts/Tris/UVs) and the full LOD payload decode — needed for rendering
  meshes (Stage 4), not for `PlayAnim` animation state or the switch route.
- Open: the `SignFloor` tail discrepancy.
