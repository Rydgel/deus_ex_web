# Sound through the shared package loader

Authority is the original GOTY Engine/Core pair identified by the SHA-256
hashes in [`script-sound-lifecycle.md`](script-sound-lifecycle.md). Existing
constructor, serialization, lazy-byte and period translations are reused.
The integration contract below was established before wiring them into the
shared graph.

## Native-only class and defaults

Engine.u contains no Sound class export. Engine initializer `0x1036fbe0`
calls the native UClass constructor at `0x1036fc56` with instance size `0x54`,
raw class flags `0x40`, Super/Within both Core.Object (`0x1029e0d0`), internal
constructor `0x10303891`, and inherited UObject static constructor `0x10101041`.
Its name/package/config strings are Sound/Engine/System. The UClass constructor
ORs the raw class flags with `0x12`; the resulting registered flags are `0x52`.

The native class-default reference executes `UClass::Register` (`0x10127800`),
including the original InitClassDefaultObject/InitProperties, Class/State/Struct
Link and config/localization gates. Registry insertion and FName interning are
explicit boundary services. Core.Object supplies its `0x28`-byte default block,
empty property list, flags `0x13` and the same static constructor. The resulting
Sound Defaults.Num/Max and PropertiesSize are `0x54`; all 44 bytes following
the UObject header are zero. No C++ Sound instance constructor runs on this
CDO. The zero tail follows the original default initializer, not the Sound
constructor (which preserves +0x44, +0x48 and +0x50).

This establishes the selected native-only Sound class's bootstrap metadata
and template. It does not establish the entire registration queue or native
defaults for other resource classes. The graph must keep the same static
class identity when resolving an import whose Engine.u export is absent.
The graph also retains registered instance sizes before an export is loaded,
so the grouped sound's Core.Package base serializer sees `0x34`, not zero.
Core.Object's initializer self-Super argument is normalized to null by the
original UClass constructor (`0x10128630`–`0x1012865c`); the graph now applies
that existing [construction contract](script-native-class-registration.md)
before any package loads, avoiding a false cycle on a direct resource load.

## Resource lifecycle

CreateExport constructs the Sound using the recovered
[`constructSoundNative`](script-sound-construction.md) after default copying.
The shared UObject serializer consumes tagged properties first; the original
Sound serializer then reads format FName and attaches its lazy bytes to the
same canonical embedded archive. Sound Serialize forces GLazyLoad to 1 and
restores its previous value on normal return, so the bytes remain deferred
even when the incoming global is zero.

Sound's PostLoad vtable entry is `0x103027de` -> `0x1036fb20`. Its entire normal
path calls UObject::PostLoad through IAT `0x10599ae4` at `0x1036fb4f` and returns
at `0x1036fb9e`. It performs no sound-data load or audio registration. This
wrapper may therefore dispatch to the existing base PostLoad translation.

Explicit byte loading uses the existing FSoundData.Load translation, generic
lazy Load/byte serialization and GetPeriod. With the original Audio global
null, it computes the duration, writes owner byte count and retains the archive
while restoring its cursor. A nonnull audio backend still requires the separate
query/conversion/registration branches; it must not silently use the null path.
LoadSpecial only loads the bytes, preserving duration/count fields, as required
by conversation timing. Neither path changes the format-name identity.

Full Sound destruction and native allocation/collection remain separate from
loading. Play's entire resource queue also includes LodMesh and procedural
texture types; Sound support alone does not complete that queue.

## Implemented boundary and focused validation

`createScriptLoadGraph` now binds these existing translations for exact
Engine.Sound instances when resource services are enabled. The Sound vtable,
format, duration, byte count and embedded data aliases share native backing
storage. Native-only class imports retain the existing static class identity;
no Engine.u Sound export is invented. `loadSoundResource(sound, {special})`
uses the original normal or LoadSpecial entry point. Normal loading requires
an explicit Audio-global service; the host cannot silently assume null.

`validate-sound-load-graph.mjs` checks the entire registered default tail and
metadata against `native-sound-graph-oracle.py`, then loads original
`DeusExSounds.Special.Switch4ClickOn` and
`DeusExConAudioMission00.ConAudioMission00_79`. Their two-object and one-object
queues respectively pass through the shared EndLoad without filtering. The
grouped Package uses the previously recovered UObject-forwarding serializer.
The tests compare original constructor/serializer/load fields, 11,238 WAV
bytes, 43,056 MP3 bytes, the exact `0.2521088421344757` WAV duration, retained
archive/format/owner identities, repeat loads, global restoration and the
LoadSpecial no-owner-write path. The MP3 is not decoded or mixed here.

The canonical texture and sound loaders now reuse the same generic lazy Load
translation. The texture adapter also checks the already-established original
case that changes SavedPos during a callback, verifying the final negative
position comes from the live field rather than a cached initial value.

Ten focused loader validators pass with four jobs. The 12 original function
binding cases, 652-object Core.Object metadata queue and build also pass.
These results establish the named loading boundaries, not complete resource
construction/collection, native audio conversion, or Stage 3 completion.
