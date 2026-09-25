# Original texture and palette load lifecycle

Authority: GOTY Engine.dll SHA-256
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`,
Core.dll SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`.
This contract was traced before implementation. Original files and captures
remain outside Git. Rendering and procedural texture subclasses are separate.

## Texture constructor and serialization

UTexture constructor `0x103ed3d0` calls UBitmap `0x103ec690`. After the
UObject constructor, Bitmap installs vtable `0x104266b8`, sets +0x44 to
`0x00408040`, +0x48 to `0xffffffff`, clears Format byte +0x28, Palette
pointer +0x2c, UBits/VBits bytes +0x30/+0x31 and USize/VSize +0x34/+0x38,
and stores current appSeconds as a double at +0x4c. Texture zeroes both
FArray headers at +0xa4 and +0xb0, writes +0x68=0 and float 1 to
+0x60/+0x64/+0x6c/+0x70/+0x74, then installs vtable `0x1042672c`.
Untouched fields come from the already initialized object/template storage.
The base UObject constructor (`0x101021c6` -> `0x1014f340`) only stores
vtable `0x10179dfc` and returns this; the oracle executes that original body.

UTexture::Serialize (`0x103ed470`) calls UObject::Serialize. When either
archive +0x0c or +0x10 is nonzero and texture +0x84 has bit 8, it empties
each existing primary mip's byte-array storage (Num/Max zero, Realloc(1)).
It serializes the primary mip array at +0xa4 through `0x103ed690`, and the
compressed array at +0xb0 only if texture flag +0x84 has bit 0x20. The same
bit-8 gate then recreates each primary mip's bytes as Width*Height zero bytes.
Save and nonloading archive paths are distinct; no loading substitute proves
them.

Mip-array helper `0x103ed690` first CountBytes(Num*40, Max*40), reads a
compact count, destroys the old lazy arrays, sets Num=0/Max=count and
Realloc(40). It reads the engine's mip bias at GEngine (+`0x1058f044`),
engine+0x74+4*texture.LODSet (+0x88), or uses zero when GEngine is null.
It clamps that value only above to count-1. Before each mip, save GLazyLoad;
force it to 1 if index<bias, initialize the mip's lazy byte array and serialize
the mip; restore GLazyLoad after each successful call.

Each 40-byte FMipmap has Width +4, Height +8, UBits +0xc, VBits +0xd and
TLazyArray<byte> +0x10. Its serializer `0x103f0d80` reads the lazy bytes
first, then Width/Height (4 bytes each), then UBits/VBits (one byte each).
The lazy object's +0/+4/+8 are vtable/archive/signed SavedPos; its embedded
byte-array Data/Num/Max are at +0xc/+0x10/+0x14.
The zero-count FArray constructor `0x10107280` still calls Realloc(1), before
the FLazyLoader constructor; allocation-call comparisons retain that edge.

## Shared lazy-byte loader

Loading helper `0x10371140`: for archive version >61, read a four-byte
absolute end position, attach the lazy loader, call its Load virtual when
GLazyLoad is zero, then seek to the end. For <=61, attach before reading a
compact byte count and compute end=Tell+count. The existing original
Attach/Detach contract is [`script-linker-lazy-loader.md`](script-linker-lazy-loader.md).

Load body `0x1030cbb0` returns when SavedPos<=0. Otherwise save archive Tell,
seek to SavedPos, serialize the byte array via `0x1030cca0`, negate SavedPos,
then restore the saved position. The byte-array serializer CountBytes(Num,Max),
reads its compact count, sets Max=Num/Realloc(1) when loading, then raw-reads
Num bytes. The negative position prevents duplicate loads while retaining the
archive reference. Lazy destruction `0x1030ca50` detaches a nonnull archive
before releasing its byte-array storage.
Texture Load now uses the existing shared `loadLazyByteArray` body: archive and
SavedPos are reread after callbacks, matching the original reentrant reference
case in `native-lazy-byte-array-oracle.py`. Its byte transfer captures the
Data/Num arguments before the raw-reader callback, as the native call does.

## Texture PostLoad

`0x103ed8f0` calls UObject::PostLoad first. If Palette is null it allocates
a Palette through Engine helper `0x1030308f`, with the texture's outer,
NAME_None and flags zero, runs the Palette constructor, stores its identity
and appends 256 entries `(i,i,i,0)`. Native object allocation/identity remains
an explicit service; creating a JS palette without that service is not enough.

It clamps signed UClamp/VClamp (+0x3c/+0x40) using the original order:
negative -> 0, otherwise values >= USize/VSize -> that size. It clears
+0xa0, then stores appSeconds in the +0x4c double. Clock acquisition has
RDTSC and appSecondsSlow branches; the time value is an explicit host input,
not a guessed constant. Existing palette identity is retained.

## Palette

UPalette constructor `0x103ef3c0` calls UObject, clears its color-array
header +0x28/+0x2c/+0x30 and installs vtable `0x10426654`.
Serialize `0x103ef430` calls UObject then color-array helper `0x103f0a00`:
CountBytes(Num*4,Max*4), compact count, reset/reallocate on loading, then
serialize each entry as four consecutive one-byte transfers. For version<66,
set every alpha byte to 255 after the array call. Palette vtable +0x20 is
`0x1040c72e`, a direct jump through Engine IAT `0x10599ae4` to the original
UObject::PostLoad. It therefore uses that base body without a resource override.

## Open boundaries

The existing viewer decoder is not the authority for this lifecycle. Native
allocation is represented through explicit FArray/object services; native heap
collection remains separate. The shared graph must supply canonical archive
identity and preserve lazy attach/detach ordering. Original class-template
values and recovered C++ constructor writes must precede tagged instance reads.
Procedural texture subclass constructors/serializers, save/nonloading behavior,
compressed-format rendering and final resource destruction remain unverified.

## Implemented boundary and comparisons

`script-texture-load.mjs` implements the constructors, loading serializers,
lazy-byte Load and Texture PostLoad above. `native-texture-load-oracle.py`
executes the hash-checked original bodies, including original lazy Attach/Detach,
FArray helpers and base UObject constructor/PostLoad. The raw reader, allocator,
clock and fallback palette allocation are explicit probe services; the base
UObject serializer is isolated at its call boundary with supplied property words.

Nine focused reference cases compare constructor words, FArray reallocation
arguments, archive read/seek/call
order, mip data and capacities, GLazyLoad restoration, repeated lazy Load,
reload detachment, compressed chains, the <=61 format, temporary zero storage,
palette alpha before version 66, clamps, timing and missing-palette creation.
They are checked by `node scripts/validate-texture-load.mjs`.

The shared graph admits exact `Engine.Texture` and `Engine.Palette` instances
when `resourceServices` supplies seconds, GLazyLoad get/set and mip bias. It
copies the already-loaded class template then applies the recovered constructor
before tagged serialization. Bitmap color words are converted through the
original linked Color field offsets into the graph's struct representation.
The preload and lazy-loader methods now share one branded embedded archive;
lazy reads retain that archive and restore its actual package cursor.

Real `Engine.S_Camera` and `Engine.DefaultTexture` exports, their two palettes
and all nine mips pass through CreateExport/Preload and conditional PostLoad.
Their original absolute-offset payloads also execute in the DLL oracle, and the
graph's bytes, dimensions, deferred state, palette identity and post-load fields
match. These compare the resource boundary; they do not flush or filter the
larger Engine metadata/resource queue through EndLoad.

Play now supplies these resource services (client GLazyLoad, the WindowsClient
TextureLODSet mip bias and the host appSeconds clock; see
[Font loading](script-font-load.md)) but does not finalize its whole load
queue. The DXFonts page textures and palette are the first Play resources
preloaded and post-loaded through them. Other resource classes and procedural subclasses remain rejected before
their RF_NeedLoad/RF_NeedPostLoad flags are consumed. Native resource
reconstruction is also explicitly refused because its destructor/allocation
sequence is not integrated. Missing-palette object allocation is still a
required external service. General CDO/native defaults, config/localization,
native heap ownership and final release remain separate open boundaries.
