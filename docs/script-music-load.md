# UMusic loading (endgame credits music)

`CreditsScrollWindow.StartMusic` loads the credits song with
`DynamicLoadObject(ScrollMusicString, class'Music')`; `CreditsWindow` and
`QuotesWindow` give `ScrollMusicString` its default
`"Credits_Music.Credits_Music"`. The three `99_Endgame` maps reach it, and it
stopped them at "DynamicLoadObject package linker is not prepared".

## Prefetch

A synchronous native frame cannot wait for package bytes, so
`ScriptRuntime.prefetchDynamicLoadPackages` fetches, while a function is
prepared, the package each `DynamicLoadObject` path names. It already took
literal paths. An instance-variable path now takes the default values the
string property has in its declaring class and in each subclass that class's
package exports (`defaultStringValues`). Fetching bytes is not observable; a
path the script builds at run time outside those defaults still reaches the
first-load boundary.

## Registration

`Music` is native-only (Engine.u has no export for it). Engine.dll's
initializer `0x10370eb0` constructs the static class `0x10580368` with size
`0x4c`, class flags `0x40` (registered `0x52`), Super and Within
`UObject` (IAT `0x105999f8`, Core's `PrivateStaticClass` `0x1029e0d0`), config
System, InternalConstructor `0x103036a7` and UObject's static constructor.
`UClass::Register` leaves a zero default tail from `0x28` to `0x4c`, as for
Sound and Font. (`script-native-class-registry.mjs` lacked the Super.)

## Constructor and fields

`UMusic::UMusic` (`0x1034d170`): UObject's constructor; the FArray at `+0x34`
zeroed and `Realloc(1)`; SavedAr `+0x2c` and SavedPos `+0x30` zero; the
`TLazyArray<BYTE>` loader vtable `0x104267fc` at `+0x28`; the UMusic vtable
`0x104295e4`. `+0x40` FileType (FName), `+0x44` OriginalSize and `+0x48` the
audio subsystem's handle keep the default zeros.

## Serialize (`0x10370bd0`)

`UObject::Serialize`; `Ar << FileType` (FArchive vtable `+0x1c`); when the
archive is loading (`+0x0c`) or saving (`+0x10`), `Ar << Data` with the
shared `TLazyArray<BYTE>` operator `0x103039ef` and, loading,
`OriginalSize = Data.Num` (`+0x38`); otherwise `Ar.CountBytes(OriginalSize,
OriginalSize)`. Unlike USound, UMusic does not raise `GLazyLoad` around its
Serialize, so the lazy array's `Load` (`0x1030cbb0`) reads the song at once.
`PostLoad` (`0x10370df0`) only forwards to `UObject::PostLoad`. `Destroy`
(`0x10370d20`) unregisters the music from the audio subsystem before
`UObject::Destroy`; loaded resources are outside the host's purge set, so it is
not reached.

`src/runtime/script-music-load.mjs` translates the constructor and the loading
Serialize; the load graph registers the class, constructs and serializes
Music through them and reuses the texture loader's `serializeLazyBytes`
(`0x103039ef`, loading branch).

## Validation

`scripts/validate-music-load-graph.mjs` loads every music export of
`Credits_Music`, `Intro_Music` and `LibertyIsland_Music` through the graph's
BeginLoad/CreateExport/EndLoad queue and checks the registration, the
vtables, FileType, `Data` (every byte) and `OriginalSize` against an
independent parse of each export. The map census then has the three endgames
Stage 3 complete. Galaxy's Update now loads, plays and unloads the songs
`ClientSetMusic` selects, including the Data lifecycle (Load, Add(1024),
Handle = -1, Unload): [galaxy-music](galaxy-music.md) "Phase 4". A
DynamicLoadObject UMusic goes through `galaxy-music-objects.mjs`'s
load-graph adapter (validate-galaxy-music-play.mjs loads Credits_Music this
way, plays it, and reloads its emptied Data through the linker archive).
