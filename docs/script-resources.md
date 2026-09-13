# Script resource graph

This note defines the small resource graph that Stage 3 can rely on while the
full native loader is still being recovered. It is deliberately anchored to
the package linker tables and the installed Deus Ex GOTY `Engine.dll`; it does
not claim that JavaScript objects are native `UObject` allocations.

## Contract

`ScriptResourceRegistry` gives one cached record for each positive package
export and one cached package identity for each loaded package. A record keeps
the canonical `ScriptObjects` identity, its package export entry, its `Outer`,
and the class identity selected from the export's `ClassIndex`. A root export
whose serialized outer is zero points at the package identity. This is the
loader's important distinction from a bare package-table descriptor: the
original loader gives every export an implicit package owner even though that
owner is not written as a positive export index.

The installed Core.dll CreateExport body resolves ClassIndex at
`1012e2ab–1012e2b5`; a null result is replaced with the UClass static object
`101f1c18` at `1012e2bb`. Thus a class export whose ClassIndex is zero has
`Core.Class` as its class, including Core.Class itself. The registry follows
the serialized Core.Class export where available and uses its measured native
registration descriptor when that export is absent. This self-reference is
why internal graph traversal may see a published pending identity while
external materialization callers must await its completion.

An import is resolved by its complete package path. Known native class imports
are resolved through the measured Engine catalog below. Script class imports
are followed to a package export when that export exists, including classes
such as `Core.Object`, `Engine.Actor`, and `Engine.Texture` that are represented
by both native registration and a serialized script class. Those records reuse
the canonical `ScriptObjects` identity consumed by `ScriptRuntime.loadClass`;
the registry does not create a second UObject descriptor for them. Their
measured DLL metadata is available as `nativeRegistration` on that canonical
class record, so resource payload dispatch can use the native serializer
without changing class identity. If an import cannot be followed, the record
remains an explicit unresolved-import boundary; the loader never substitutes a
serialized `Class` export for a DLL-only class such as `Engine.LodMesh`.

The registry exposes `references(record, visit)` as the collector boundary.
The only edges emitted today are the serialized `Outer` and `ClassIndex`
edges. `ULodMesh`'s decoded eager prefix contains names, values, and lazy file
offsets, not known UObject pointers, so it adds no guessed payload edges. Its
lazy arrays and serialized tail remain an explicit incomplete branch; they may
still contain references that the collector does not see. Sound's recovered
WAV payload adds no UObject edges; its format FName is exposed separately by
`collectReferences` as `nameReferences`. Texture payloads remain opaque.
Destruction, allocator ownership, and save/load
mutation are intentionally outside this module.

`globalIndex` is populated only when a caller supplies a measured
`indexProvider.indexFor(className, name)` (for example the ignored original
GObjObjects capture). It is null otherwise; package export indices are never
used as native global indices.

## Native class evidence

The catalog below records addresses from the hash-verified original
`Engine.dll` (`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`).
Routines are image virtual addresses from the original binary. A constructor
or serializer address is metadata for later native integration; this module
does not execute it.

| Class | Static class | Instance size | Internal constructor | Default constructor body | Registration body | Serializer |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `Core.Object` | `0x1029e0d0` | `0x28` | — | — | `0x10150cc0` | — |
| `Core.Field` | `0x101f2b18` | `0x34` | — | — | `0x10125e50` | — |
| `Core.Struct` | `0x101f2618` | `0x6c` | — | — | `0x101273d0` | — |
| `Core.State` | `0x101f2118` | `0x484` | — | — | `0x10127760` | — |
| `Core.Package` | `0x1029b8e0` | `0x34` | — | — | `0x1015a710` | — |
| `Core.Class` | `0x101f1c18` | `0x4f4` | — | — | `0x10128750` | — |
| `Engine.Bitmap` | `0x1058eb48` | — | not recovered | not recovered | static identity only | — |
| `Engine.Primitive` | `0x1058d368` | `0x54` | `0x103023ce` | — | `0x103d8200` | thunk `0x10303c0b`, body `0x103d82d0` |
| `Engine.Mesh` | `0x10589758` | `0x12c` | `0x103020bd` | body `0x103a6130` | `0x103a6770` | thunk `0x10301717`, body `0x103a63b0` |
| `Engine.LodMesh` | `0x105359d0` | `0x1b0` | `0x10303855` | thunk `0x10302f09`, body `0x1034a760` | `0x10354f40` | thunk `0x103024b9`, body `0x10354ab0` |
| `Engine.Sound` | `0x10580868` | `0x54` | `0x10303891` | thunk `0x10303af3`, body `0x1034cdc0` | `0x1036fc02` | thunk `0x103029fa`, body `0x1036f900` |
| `Engine.Texture` | `0x1058e648` | `0xc0` | `0x1030249b` | body `0x103edb10` | `0x103edba0` | thunk `0x10301a32`, body `0x103ed470` |

The `ULodMesh` registration body pushes the Engine package, `LodMesh` name,
`UMesh` as Super, `Core.Object` as Within, instance size `0x1b0`, and the
internal constructor before calling Core's UClass constructor on
`0x105359d0`. Its serializer first calls `UMesh::Serialize` and then reads the
eager AnimSeq and native tail fields. The recovered reader in
[`lodmesh-serialization.md`](lodmesh-serialization.md) and
`src/runtime/lodmesh.mjs` intentionally stops before the renderer's lazy
arrays.

The table records constructor and serializer entry points for Sound and
Texture because their registration and vtable evidence is concrete. Sound's
version 68/69 format-name/lazy header and inline WAV payload are now decoded;
its lazy-loader ownership and final release remain separate native boundaries.
The Texture construction chain is
`0x1030249b -> 0x10321260 -> 0x10302fa4 -> 0x103ed3d0`. It calls the UBitmap
constructor at `0x103ec690`, installs vtable `0x1042672c`, writes
`+0x44=0x00408040` and `+0x48=0xffffffff`, clears
`+0x28/+0x2c/+0x30/+0x31/+0x34/+0x38`, initializes the scalars at
`+0x60/+0x64/+0x6c/+0x70/+0x74` to `1.0`, and clears the bulk-array headers
from `+0xa4` through `+0xb8`.

That constructor state is not a loaded Texture. Serializer `0x103ed470` first
calls base UObject serialization and then native mip-array helper `0x103ed690`,
archive raw/reference/count operations, and allocator-backed bulk storage.
The native reader, heap ownership, mip-field mapping, and post-load service are
not yet recovered, so absent Texture exports remain at the explicit archive
`Preload`/serializer boundary. See [sound resources](script-sound-resource.md).

## Supported and unsupported paths

The first decoded resource is `DeusExDeco.u` export 606,
`LodMesh.LightSwitch`: the package entry has class import `-4` (`Engine.LodMesh`),
root outer `0`, serial size `1272`, and the decoder recovers the original four
`AnimSeq` entries and bounds in the eager prefix. Its outer is the canonical
`DeusExDeco` package identity and its class edge is the canonical
`Engine.LodMesh` descriptor. The payload status is
`decoded-eager-prefix`, not a complete mesh resource.

`Special.Switch4ClickOn` and `Special.Switch4ClickOff` in `DeusExSounds.u`
are materialized as canonical `Sound` records with decoded format-name, lazy
header, PCM WAV samples and metadata. Their FName edge is reported separately
from UObject references. `Texture` exports such as
`DeusExDeco.Skins.LightSwitchTex1` remain opaque. Decoding does not establish
audible playback or texture upload.

No final native destructor, allocator/free-list, lazy mesh geometry, texture
bulk-data decode, package save path, or global GObjObjects
registration is provided. Those are required follow-up work for the complete
Stage 3 graph or later presentation integration. The registry's unresolved and
opaque statuses are intentional acceptance evidence, not successful native
materialization.
`ScriptRuntime.prepareResource()` shares the runtime's existing `ScriptObjects`
registry. The Play host prepares the selected LightSwitch class, Mesh and both
Sound constants resolved from the original Frob bytecode after map-property
bindings are installed. `prepareMesh()` completes the LodMesh
eager serializer before an event runs; synchronous `meshPayload()` reads that
prepared resource, and rejects a later unprepared Mesh assignment explicitly.
The original LightSwitch Frob validator exercises this path through PlayAnim.
