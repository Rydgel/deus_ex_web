# Engine Font loading and the DynamicLoadObject first-load route

This closes the Training reach-census `ShowMainMenu` boundary
(`DynamicLoadObject package linker is not prepared: DXFonts`). It is also the
first resource that Play loads through the shared graph's own StaticLoadObject,
CreateExport, Preload and PostLoad, as
[exit criterion 4](stage-3-exit-criteria.md) requires.

Authorities (installed GOTY files; binaries and captures stay outside Git):

| file | SHA-256 |
| --- | --- |
| `System/Engine.dll` | `0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4` |
| `System/Core.dll` | `8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4` |
| `System/DeusEx.dll` | `b91002f3e7658c0562d28bccc887cf9db79a47a19f5e09e8be460c9d0c0bee04` |
| `System/DeusEx.exe` | `3e6fdb89b880a60ee984b885a48f262070019572f1531ed70d96108781bae00e` |
| `Textures/DXFonts.utx` | `065bac3493a1d281818ed9b3c328b648b9817bc3b060908d173f11a7cb297661` |

## Call site and the original branch

`MenuUIMenuButtonWindow.InitWindow` runs
`fontButtonText = Font(DynamicLoadObject("DXFonts.MainMenuTrueType", Class'Font'))`.
`MenuMain.CreateMenuButtons` creates one button per menu entry, so the first
button's call loads the package and later calls find it already loaded. The live
`00_Training` GObjObjects capture (`.cache/original-gobjects.txt`, 42,167 objects)
contains no `Package.DXFonts` and no `MainMenuTrueType`. From Training, the first
call therefore takes GetPackageLinker's **first-load** branch. Building the
linker ahead of time would instead take the already-loaded branch.

The only literal DynamicLoadObject targets in the shipped scripts are
`DXFonts.MainMenuTrueType` (twice) and `Extras.Matrix_A00`.

`DXFonts.utx` (version 68) imports `Engine` (`Core.Package`) and the classes
`Engine.Texture`, `Engine.Font` and `Engine.Palette`. It has eight exports:
two Fonts (`MainMenuTrueType`, `HUDMessageTrueType`), each owning two
256x256 page Textures and one Palette. Engine.u has no `Font` class export;
Font is native-only, like Sound.

## Font class registration

Engine initializer `0x103855b0` calls the UClass constructor (IAT
`0x10599de0`) with ENativeConstructor 0, instance size `0x38`, raw class flags 0,
Super and Within `0x1029e0d0` (Core.Object), a zero GUID, the names
`Font`/`Engine`/`System`, RF flags `0x4084004`, InternalConstructor `0x10303468`
and the static constructor `0x10101041`. It then registers the static-class
destructor `0x10385630` through the CRT atexit. UClass::Register (`0x10127800`)
leaves registered flags `0x12`, Defaults Num/Max `0x38`, and a 16-byte zero tail
after the UObject header. `script-native-class-registry.mjs` now records the
Font Super. The shared graph installs these fields next to Sound's.

## UFont constructor, Serialize and PostLoad

The SDK `UnTex.h` layout is confirmed by the bodies. `CharactersPerPage` is
at `+0x28`. `TArray<FFontPage> Pages` is at `+0x2c/+0x30/+0x34`. An FFontPage is
16 bytes: `UTexture*` then `TArray<FFontCharacter>`. An FFontCharacter is 16
bytes: StartU, StartV, USize, VSize.

- **Constructor** `0x103853d0` (thunks `0x10303468` -> `0x10322030` ->
  `0x1030245a`): calls the UObject constructor, zeroes Pages, then installs
  vtable `0x10426878`. `CharactersPerPage` keeps its template value.
- **Serialize** `0x10385400` (vtable `+0x28` -> `0x10302342`), loading branch:
  1. UObject::Serialize.
  2. Save GLazyLoad and force it to 1.
  3. `Ar << Pages` (`0x10385680`), then `Ar.Serialize(&CharactersPerPage, 4)`.
  4. `check(!(CharactersPerPage&(CharactersPerPage-1)))` at `UnFont.cpp` line
     `0x1a`.
  5. If GLazyLoad is now 0 (only when a nested callback cleared it), load each
     page texture's mip lazy arrays. A page counter and a running index that
     advances by `CharactersPerPage` to 256 drive this loop, and Pages, the
     texture pointer and its `Mips` are reread on each iteration.
  6. Restore GLazyLoad.
- **Pages** `0x10385680`: CountBytes(Num*16, Max*16), then a compact count.
  Every existing page's glyph array is destroyed (`0x10385860`: Remove(0, Num,
  16), then Free), followed by Num=0, Max=count and Realloc(16). Each new page
  goes through inline FArray::Add; placement-new zeroes only Characters. It then
  serializes the page (`0x10385940`): `Ar << Texture` (FArchive `+0x18`), then
  the glyph array.
- **Glyphs** `0x10385a00`: CountBytes, a compact count, an empty destructor loop,
  Max=count, Num=0 and Realloc(16), then four 4-byte Serialize calls per glyph
  (`0x10385bb0`).
- **PostLoad**: vtable `+0x20` is `0x1040c72e`, a direct jump to Core
  `UObject::PostLoad` (the same thunk Palette and LodMesh use).

[`script-font-load.mjs`](../src/runtime/script-font-load.mjs) translates these.
Save/nonloading archives are not translated. A `CharactersPerPage <= 0` reaching
the lazy loop is refused because the original loop does not terminate.

## Client loading inputs

The page Textures run the existing [texture serializer](script-texture-loading.md),
which reads two process globals:

- **GLazyLoad.** DeusEx.exe `0x10908da6`-`0x10908e42` sets
  `GIsClient = !ParseParam(cmd, "SERVER")`, then
  `GLazyLoad = !GIsClient || ParseParam(cmd, "LAZY")`. It forces GLazyLoad to 1
  only when `GPhysicalMemory <= 0x4000000`, and logs "Low memory conditions
  detected - Forcing lazy loading" when it does. A browser client launched
  without `-LAZY` on a machine with more than 64 MB therefore uses 0
  (`CLIENT_LAZY_LOAD`). The physical-memory value is a host input and is
  labelled as such. Play's mesh archive keeps its own, separately documented,
  deferred policy.
- **Mip bias.** `0x1058f044` is `UBitmap::__Client`. The mip helper reads
  `Client.TextureLODSet[LODSet]` (`+0x74`). UClient::StaticConstructor
  (`0x10375010`) registers enum `Details {High, Medium, Low, Ultra Low}` and two
  CPF_Config UByteProperty fields: `TextureDetail` at `+0x78` (LODSET_World)
  and `SkinDetail` at `+0x7c` (LODSET_Skin). Slot 0 (LODSET_None) and slots 3-7
  have no property, so they stay 0. `clientTextureLodSet` reads
  `[WinDrv.WindowsClient]` from GConfig. The installed `High`/`High` gives
  `[0, 0, 0]`.

The texture constructor and PostLoad also read appSeconds, which Play takes from
the host clock.

## Load order through the shared graph

`validate-font-load-graph.mjs` first flushes a startup load of Core.Object and
the Engine Texture/Palette classes, using the original Core native-registration
inputs. It then runs BeginLoad, GetPackageLinker (`buildLinker('DXFonts')`),
CreateExport of `MainMenuTrueType` and EndLoad. The Font's own Preload creates
`Texture0` (export 5) and `Texture1` (export 3). The first texture's tagged
`Palette` creates `Palette1`. CreateExport and PostLoad therefore both run in
the order Font, Texture0, Texture1, Palette1.

Results:

- The Font has `CharactersPerPage` 128 and two 128-glyph pages. Its glyphs,
  page count and capacities match the retail serializer over the same bytes.
- Each page texture has one 256x256 mip, and its bytes, dimensions, clamps and
  shared palette match the retail Texture/Palette bodies.
- GLazyLoad is restored and all load/postload flags clear.

## DynamicLoadObject route in Play

- **Prefetch.** `ScriptRuntime.prefetchDynamicLoadPackages` runs while a
  function or state is prepared (asynchronously). For each literal
  `DynamicLoadObject("Pkg.Obj", ...)` call it fetches that package's bytes into
  the graph's `packageAssets`. It creates no package object, linker or export,
  so the synchronous call still reaches the first-load branch.
- **Routing.** `loadPreparedDynamicObject` keeps the focused prepared routes
  (the InfoPortraits portrait, conversation lists and TransferObject classes)
  for the packages they own. Any other prefetched package runs the recovered
  StaticLoadObject over `graph.staticLoadServices()`:
  - [ResolveName](script-resolve-name.md) with Create=1 calls the recovered
    CreatePackage, which allocates a new top-level UPackage and runs
    **BindPackage** (`0x10152ff0`). BindPackage builds
    `appSprintf("%s%s", appBaseDir(), Name)`, clears GObjNoRegister, sets
    `AttemptedBind`, stores `DllHandle = appGetDllHandle(...)`, then sets
    GObjNoRegister again. The installed System directory has no `DXFonts.dll`,
    so the handle is null. `AssetStore.libraries` lists `System/*.dll` names
    (the dev manifest lists names only and serves no bytes). A package with a
    DLL would need ProcessRegistrants and is refused.
  - GetPackageLinker's first-load constructor edge builds the graph's linker
    from the fetched tables: export hash, import verification and embedded
    archive. The `0x10160000` constructor body itself is not translated; its
    table construction is the graph's existing linker build.
  - FindExportIndex walks the graph's own export hash.
  - `resolveExport` calls the recovered CreateExport body.
  - EndLoad preloads and postloads the created queue through the graph.
- **Queue scope (host scheduling boundary).** Play's class loader creates and
  preloads exports lazily and never runs EndLoad. Its GObjLoaded and
  GImportCount therefore still hold entries that the original flushed at
  startup, and the original outermost BeginLoad asserts an empty queue.
  `graph.suspendLoadQueue()` holds that deferred state aside, so both bodies run
  unchanged over exactly the objects this load creates. It restores that state
  afterwards.
- **Casts.** `Font(...)`, and the wrapper's class check, target the native-only
  class descriptor. `castToNativeClass` walks the loaded record's
  Class/SuperField chain, as Engine's inlined IsA does.
- **Enabled services.** Play's graph now supplies the resource services, so
  Texture, Palette, Sound and Font exports created later are constructed by
  their recovered constructors. Class-default font references are constructed
  but still not preloaded in Play. The window host keeps its decoder for those,
  and uses the loaded UFont record (`nativeFontImage`) for a fully loaded font.

## Main menu version text

After the fonts load, `MenuMain.ShowVersionInfo` reaches native 1099.
`ADeusExPlayer::GetDeusExVersion` (`0x10014270`) runs
`appSprintf(0x1003afcc, L"%s %s", appFromAnsi("Mon Mar 19 12:06:14 2001"), L"v1.112fm")`.
Its exec (`0x100147b0`) steps past EX_EndFunctionParms and assigns that buffer to
the FString result. `validate-deusex-version.mjs` checks the body bytes, the
push order, the three strings and the DeusEx.u native index.

## Validation

- `node scripts/validate-font-load.mjs`: 7 cases against
  `native-font-load-oracle.py`, which runs the registration, UClass::Register,
  constructor, Serialize, both array serializers, the reload destructor and the
  PostLoad thunk unchanged. The cases are the real `MainMenuTrueType`, a reload
  of `HUDMessageTrueType` with GLazyLoad 1, `Engine.SmallFont`,
  `DeusExUI.FontMenuSmall` (GLazyLoad 7), an empty font, the non-power-of-two
  assertion, and the lazy mip-load loop. Two mutations (glyph field order and
  loop bound) each fail it.
- `node scripts/validate-font-load-graph.mjs`: the graph load order and results
  above.
- `node scripts/validate-deusex-version.mjs`.
- Census `--only '^exec:ShowMainMenu$'`: the main menu opens and closes through
  original code with no boundary. The one unsupported native left on that path is
  `PlayerPawn.ConsoleCommand("FLUSH")` in `DeusExPlayer.ShowMainMenu`, which
  was reached before this change. It is a render-cache flush with a discarded
  result, and remains open (exec routing through UPlayer/Console).

## Unverified or unsupported

- Save and nonloading archive branches of all four Font serializers.
- A package DLL bound by BindPackage (ProcessRegistrants), and ResolveName's
  `ini:`/`usr:` config alias branch.
- GObjObjects index allocation for the new UPackage, linker and exports is not
  modelled on this route.
- The queue scope above, which exists only until Play flushes its own startup
  load queue.
- The prepared DynamicLoadObject routes still return prebound identities
  and should migrate to this route.
- `Extras.Matrix_A00` is prefetched when reached, but its load has not been
  exercised.
