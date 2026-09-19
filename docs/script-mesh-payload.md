# Original character mesh payload loading

This is a Stage 3 resource boundary toward visible NPCs. The separate
[GetFrame translation](script-lodmesh-frame.md) now consumes this payload for
continuous interpolation and transforms. [Surface/skin selection](script-lodmesh-materials.md)
now supplies full-resolution faces, raw UVs and canonical textures. Reduced LOD,
actor rendering and mesh lighting remain separate work.
Native LodMesh construction/serialization/PostLoad is now also connected to the
[shared load graph](script-mesh-load-graph.md); live Play finalization and final
release remain incomplete.

## Source and correction to the earlier probe

The hash-checked GOTY Engine.dll is the authority (SHA-256
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`).
`scripts/native-mesh-load-oracle.py` executes `ULodMesh`'s default constructor
`0x1034a760`, its `UMesh` constructor `0x103a6130`, and the complete original
serializers `0x10354ab0` / `0x103a63b0`. It retains the original four lazy-array
vtables and Core's actual linker AttachLazyLoader/DetachLazyLoader bodies.
Allocation, file reads/seeks, the tagged UObject prefix and compact name/object
reference resolution are explicit external services. Reference indices are kept
as stable tokens in this probe; it does not construct referenced Texture objects.

The earlier sequence-only probe put placeholder vtables in ordinary FArrays as
well as TLazyArrays. Its short consumption results were a probe artifact, not a
second lazy tail in the format. With actual construction, LightSwitch consumes
all 1,272 bytes and GM_Trench consumes all 1,019,128 bytes. Their earlier decoded
sequence tables remain valid. This supersedes the incomplete tail interpretation
in `lodmesh-serialization.md`.

## Version 68 loading contract

1. Tagged properties, primitive bounds, lazy arrays at `+54` and `+6c`, and
   the sequence/notify table at `+84` retain the established prefix contract.
2. Read the lazy array at `+90`, then overwrite the primitive bounds with the
   second serialized box/sphere. Read the lazy array at `+c0`, the object
   reference array at `+d8`, frame boxes at `+a8`, and frame spheres at `+b4`.
   These last three arrays are ordinary eager FArrays, with no lazy marker.
3. Read dwords in order `+f0..+128`: frame vertex count, frame count, two retained
   integer fields, three scale floats, three origin floats, three rotation
   integers, and two retained integers. Read the eager float array at `+e4`.
4. Read eight eager LOD arrays: `+12c`, `+138`, `+144`, `+150`, `+15c`, `+168`,
   `+174`, followed later by `+1a0`. Their element sizes are respectively
   2, 2, 8, 2, 4, 8, 8, 2 bytes. Serialize the eight intervening dwords in
   order `+180,+184,+188,+19c,+18c,+190,+194,+198`, then array `+1a0`, then
   dword `+1ac`.

Array helper bodies establish the widths and field transfers: `0x10356e60`
(u16), `0x10356fe0` (four u16), `0x103571f0` (u16/u8/u8), `0x103573d0`
(two dwords), `0x103a8cd0` (six floats plus valid byte, 28-byte memory stride),
`0x103a9b20` (four floats), `0x103a9f90` (compact UObject refs), and
`0x103aa110` (float array). LOD array entries remain available by native offset;
their renderer interpretation is not inferred merely from their shape.

Only four arrays are lazy, at `+54,+6c,+90,+c0`. Their FArray starts 12 bytes
after the lazy object, with element strides 8, 20, 8, 4. Version 68 serialization
reads a package-absolute end marker, attaches at the position just after that
marker, optionally invokes the actual lazy loader when GLazyLoad is zero, and
seeks to the end marker. Loading saves the archive cursor, reads the compact
count and elements, restores the cursor, and negates SavedPos. Repeated Load
does no additional work. The browser payload model retains this deferred state;
the shared graph retains its actual linker archive and the detached inspector
uses an explicit local archive adapter. Neither claims a live Core native heap.

The loading-only remap branch `0x10354c18..0x10354df8` runs when `+1a0.Num`
is nonzero: force vertex Load, build `frameCount * frameVertexCount` eight-byte
vertices by copying source `[frame * (+1ac) + remap[vertex]]`, and replace the
vertex array. This branch must be translated or explicitly unsupported.

The implementation translates the remap, including repeated source indices
that produce more output vertices than input vertices, preserves the original
array capacity rule, and clears the remap array afterward. Two original-code
fixtures cover reversed and expanded output.

## Vertex identity

The original `ULodMesh::GetFrame` unpack loop `0x10355779..0x103557d7`
reads `mesh+60` with stride eight. It sign-extends the low and high words of
the first dword, then the low word of the second dword, and converts these
three signed integers to floats. The last two bytes are retained but unused
by that loop. Thus the frame resource accessor may expose those exact local
XYZ values; scale/origin/actor transforms and tweening are separate work.

The other deferred element readers are `0x1031b840` (three u16, six u8,
two dwords, contiguous 20-byte storage), `0x1031bc10` (two dwords), and
`0x1031b460` (one dword). Their Load wrappers `0x1031a6b0`, `0x1031ac10`
and `0x1031b0f0` share the positive-SavedPos gate and cursor-restoring order.

GM_Trench contains 124,074 vertex records (339 vertices × 366 frames), 71
sequences, 366 frame boxes and spheres, 603 eight-byte records at `+144`, and
550 four-byte records at `+15c`. LightSwitch has 44 vertex records (22 × 2).
Interpreting the LOD records for rendering still needs its original-code contract.

## Verification scope

`validate-mesh-payload.mjs` compares eight original-code cases: LightSwitch and
GM_Trench with GLazyLoad both zero and one, SignFloor and Plant2 with deferred
loads, and reversed/expanded remap fixtures. Every array's bytes/count/capacity,
all scalar bits, sequence notifies, bounds, cursor and lazy state are compared.
The original unpack loop also supplies float32 frame vectors for comparison.
The SignFloor tail discrepancy from the earlier probe is resolved: its complete
625-byte export loads. Original assets and raw DLL captures stay outside Git.

`ScriptResourceRegistry` uses this payload model, resolves the original `+d8`
Texture references, and exposes sequence/notify FNames. Its objects are shared
with PlayAnim. `validate-gm-trench-play-anim.mjs` checks that the live player
receives all 366 frames/71 sequences, that frame data remains deferred until
requested, and that the original PlayAnim state writes still hold. Resource
identity/collector tests and the Training door integration remain focused gates.
