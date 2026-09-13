# Original `USound` resource serialization

Authority: the installed Deus Ex GOTY `Engine.dll`, SHA-256
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`, the
disassembly in `.cache/reference/Engine.asm`, and the serialized exports in
`Deus Ex GOTY Edition/System/DeusExSounds.u`. This document records the
Stage 3 resource boundary. It does not claim an audio device or native sound
service implementation.

## Native object and serializer

`USound` is registered by Engine registration body `0x1036fc02` as an Engine
object with static class `0x10580868`, instance size `0x54`, Core.Object as
both its superclass and Within class, and internal constructor thunk
`0x10303891`. Its default constructor is thunk `0x10303af3`, body
`0x1034cdc0`; its serializer is thunk `0x103029fa`, body `0x1036f900`.

The constructor initializes an embedded `FSoundData` at `USound+0x28`:

| Native offset | Recovered role |
| --- | --- |
| `+0x28` | `FSoundData` base and vtable `0x1042999c` |
| `+0x2c` | `FSoundData` external/service pointer; initialized null |
| `+0x34` | embedded `TArray` data pointer |
| `+0x38` | embedded `TArray` element count |
| `+0x3c` | embedded `TArray` allocation count |
| `+0x40` | `FSoundData` owner pointer; initialized to the `USound` |
| `+0x44` | `FName` format field serialized through `FArchive` slot `+0x1c` |
| `+0x48` | serialized sound byte count; `FSoundData::Load` copies its `TArray.Num` here and the serializer passes it to `CountBytes` |
| `+0x4c` | duration cache, initialized to `-1.0f` |
| `+0x50` | copied by the native copy constructor; exact role is not recovered |

The constructor initializes the embedded array through the Core `FArray`
service. The native copy constructor copies `FSoundData` and the fields at
`+0x44`, `+0x48`, `+0x4c`, and `+0x50`. These observations establish object
layout only; they do not authorize a JavaScript release of a native audio
handle.

`USound::Serialize` first sets an Engine global serialization flag, calls
`UObject::Serialize` through the Core import at `0x10599b10`, then passes
`USound+0x44` to the archive virtual at slot `+0x1c`, which Core exports as
`operator<<(FArchive&,FName&)`. It reads archive words at `FArchive+0x0c` and
`+0x10`. If either gate is nonzero, it calls the Engine helper `0x103039ef`
(body `0x10371140`) with the archive and `USound+0x28`; only when both gates
are zero does it pass `USound+0x48` twice to `CountBytes` at archive slot
`+0x14`. `FSoundData::Load` writes that field from its embedded `TArray.Num`
(`FSoundData+0x10`, absolute `USound+0x38`), so `+0x48` is a raw byte count,
not an object pointer or collector edge.

The archive slots used by the recovered path are established by Core's
`FArchive` vtable and exports: `+0x04` is raw `Serialize(void*,INT)`, `+0x14`
is `CountBytes`, `+0x18` is `operator<<(UObject*&)`, `+0x1c` is
`operator<<(FName&)`, `+0x28` is `Tell`, `+0x34` is `Seek`, and `+0x38` is
`AttachLazyLoader(FLazyLoader*)`. The `0x10371140` helper uses the latter
slots explicitly. For archive version `<=0x3d` it attaches the `FSoundData`
through `+0x38`, reads a compact offset, adds it to `Tell`, and seeks to the
result. For newer versions, including package version 68, it raw-reads a
four-byte offset through `+0x04`, attaches the data through `+0x38`, and then
seeks through `+0x34`. A global serialization flag gates the helper's virtual
`FSoundData` load call. The helper's save-side fallback calls generic array
helper `0x103038b9`, whose body is `0x1030cca0`; that body counts the array,
serializes its compact count, reallocates when loading, and transfers the raw
array bytes. The exact linker/service implementation behind these calls is
not translated.

The helper and the package bytes establish the saved prefix below. The first
byte is the `None` tagged-property terminator emitted by `UObject` property
serialization. The remaining values are the lazy sound data header and its
inline bytes:

| Relative offset | Width | Meaning supported by evidence |
| --- | ---: | --- |
| `0` | 1 | compact `None` property index (`0x00`) |
| `1` | compact | `FName` index for `USound+0x44`; recovered sounds use index `1`, `wav` |
| `2` | 4 | little-endian absolute package end position for the lazy data |
| `6` | compact | inline sound byte count (`USound+0x48` after `Load`) |
| `9` | count | RIFF/WAVE bytes |

For `Special.Switch4ClickOn` (export 253), package serial offset is
`11903835`, serial size is `11247`, the absolute end header is `11915082`,
the compact count is `11238`, and the RIFF bytes start at payload offset 9.
For `Special.Switch4ClickOff` (export 256), the corresponding values are
serial offset `11959112`, serial size `13375`, absolute end `11972487`, and
RIFF count `13366`. In both cases the absolute end equals
`serialOffset + serialSize`, and the compact count equals the exact RIFF
byte length. The `wav` value is a name-table value, not a UObject index. The
lazy end is a package file position, not a UObject index or host pointer.

## Recovered WAV payload

The Engine helper reached from `FSoundData::Load`/`GetPeriod` scans a RIFF
buffer held by the embedded `TArray`. It requires `RIFF` and `WAVE`, locates
the `fmt ` and `data` chunks, aligns chunk stepping to two-byte boundaries,
and optionally locates a `smpl` chunk. The Stage 3 adapter retains those
headers and bytes; it does not compute playback state or call `LoadSpecial`.

Both recovered switch sounds have this chunk sequence:

| Chunk | On | Off |
| --- | ---: | ---: |
| `fmt ` payload | 16 bytes | 16 bytes |
| `data` payload | 11118 bytes | 13246 bytes |
| `LIST` payload | 68 bytes | 68 bytes |

Both are PCM (`format=1`), mono, 22050 Hz, 44100 average bytes/sec, 2-byte
block alignment, and 16 bits/sample. The `LIST/INFO` entries are
`ICRD=1999-03-29`, `IENG=Stan Neuvo`, and `ISFT=Sound Forge 4.0`. These
values are measured package data, not generated audio metadata. Unknown RIFF
chunks are retained as descriptors; malformed or truncated chunks are an
explicit decoder error.

The empty payload-object reference result is supported by the native call
graph, rather than by the RIFF bytes alone. The tagged stream begins with
`None` in both recovered exports, so `UObject::Serialize` has no authored
property reference to visit. `USound::Serialize` then calls the FName slot
`+0x1c`, the lazy helper's raw/compact/seek/attach slots, or `CountBytes`
`+0x14`; neither `USound::Serialize` nor helper `0x10371140` calls the
UObject archive slot `+0x18`. The collector therefore returns no native
Sound-payload UObject edges for these exports. It retains the FName metadata
(`index=1`, `wav`) separately, and the package export's `Outer` and
`ClassIndex` remain the resource registry's object edges.

## Destruction and Stage 3 ownership boundary

The complete destructor thunk is `0x10303a5d`, body `0x1031cb60`. It sets the
`USound` vtable, calls Core `UObject::ConditionalDestroy` through
`0x10599b08`, destroys `FSoundData` at `+0x28`, and then calls Core
`UObject::~UObject` through `0x10599b04`. The `FSoundData` destructor body is
`0x1030ca50` (also reached through thunk `0x10301091`). If `FSoundData+0x04`
(`USound+0x2c`) is non-null, it calls that object's virtual slot `+0x3c`
with the `FSoundData` pointer before destroying the embedded `TArray`.

That virtual call is FArchive.DetachLazyLoader, as established by the recovered
archive vtables and [Sound lifecycle](script-sound-lifecycle.md) instructions.
The serializer/destructor translations now expose those calls explicitly.
Concrete linker attachment, seek and ownership integration remain incomplete.
The decoder reports its bytes as an owned host copy for inspection and leaves
the native archive/lazy-loader binding unbound. JavaScript garbage collection
is not equivalent to the native release sequence.

Resource-registry integration still ends at the decoded FName/lazy header,
RIFF chunk table and collector boundary. Audio playback, ClientHearSound,
LoadSpecial, native storage ownership, linker lazy-loader attachment, and a
complete save/load archive adapter remain unsupported. A WAV payload is
therefore marked `payloadStatus: "decoded-wave"` with
`payloadComplete: false`: the serialized bytes are parsed, while native
loader/service lifetime and playback are still incomplete. A known non-WAV
format, such as the package's `mp3` name, is reported as
`payloadStatus: "unsupported-format"` without treating its bytes as RIFF.

The focused implementation is `src/runtime/script-sound-resource.mjs`, and
`scripts/validate-script-sound-resource.mjs` checks the two original switch
exports against these measured facts.
