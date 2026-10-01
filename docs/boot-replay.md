# Engine boot replay: package-load index assignment

Authority: installed GOTY binaries (hash-verified), `.cache/reference/Engine.asm`
and `.cache/research/Core.asm`. Addresses are image-relative virtual addresses.
This note records the recovered load chain that assigns global UObject indices
during map load; the JS boot replay and its validation are still open work.

## Executable boot chain

`DeusEx.exe` (image base `0x10900000`) is a thin launcher: CRT startup →
`InitWindowing` (Window.dll) → `appInit` (Core IAT `0x10957b40`, called at
`0x10908d23`) → window creation → main loop with `UGameEngine` ticking.

`appInit` receives the engine class path from `ini:Engine.Engine.GameEngine`
(`DeusEx.DeusExGameEngine`, DeusEx.ini). In the DLL:

- `UEngine::Init` — thunk `0x10303da0` → body `0x1037ffb0`. It constructs the
  engine object (`GetTransientPackage` + `StaticConstructObject` imports at
  IAT `0x10599db0/db4`), then walks subsystems; its per-frame loops reference
  the global object registry.
- `UGameEngine::Browse` — thunk `0x103021d0` → body `0x1038ad30`.
- `UGameEngine::LoadMap` — thunk `0x103033a5` (mangled label in Engine.asm),
  body reached via jump from Browse at `0x1038c1f0`.

## Package-load path (Core.dll, image base `0x10100000`)

`UObject::LoadPackage` (thunk `0x10102e50`, body `0x10155290`):

1. `BeginLoad` (`0x10103328` → body `0x10155410` nest counter at `0x102a2650`).
2. `GetPackageLinker` (thunk `0x10101591`, body `0x10154530`):
   resolves the file through `appFindPackageFile` (IAT `0x10599e87`), creates
   the package via `CreatePackage` (thunk `0x10101ccb`), loads and verifies
   the linker, and returns it.
3. `ULinkerLoad::LoadAllObjects` — thunk `0x10101177` → body `0x10161bf0`:
   a linear loop `for i = 0 .. Linker->ExportCount-1` (count at `Linker+0x2c`,
   export table data at `Linker+0x28`, export record stride `0x24` — matching
   the export stride documented in [object lifecycle](script-object-lifecycle.md)),
   calling the export loader for each index in ascending order.
4. `VerifyLinker` (thunk `0x10101...`) and `EndLoad` (thunk `0x10102f27`).

**Export loading order is the export-table order of the package.** For
`00_Training.dx` (3347 exports, 181 imports), each map export receives its
global UObject index by ascending export index during this loop. Imports are
resolved by name (`StaticFindObject`/`LoadPackage` recursion through the same
path for dependency packages) and do not consume global indices for map data.

## Creation site (the AddObject caller)

`ULinkerLoad::CreateExport` (Core.dll `0x1012e230`, reached from
`thunk 0x101012fd`, itself called at `0x1012cb31` inside
`ULinkerLoad::CreateExport`'s lazy-load path, and from class-construction
helpers at `0x1012e5be/0x1012e72a` and `UObject::Register` at `0x10161c27`):

```
if (ExportTable[index].object != 0) return it            // +0x1c already created
if (GLazyLoad == 0) assert                                // Engine IAT 0x10599cc0
if (NeedDestruction bits...) assert
Ar.BeginLoad();                       // BeginLoad IAT 0x10599eec
object = StaticConstructObject(       // IAT 0x10101771
    Class, Outer, Name,
    Flags = 0x67F0025 | 0x1000200,    // RF_Load* mask plus LoadForClient/Server
    NullName, Transient, ...);
SetLinker(object, Linker, index);     // IAT 0x10101631
GObjLoaded.Add(object);               // FArray::Add, array at 0x1029e638
Logf(0x101aa5a0 NameLog, GetFullName(object));  // "Loading: %s" line
```

The registry insertion itself is the already-recovered `AddObject`
(`0x10157830`, see [construction](script-construction.md) step 7): global
array `0x1029e628`, LIFO free-slot reuse `0x1029e618`, append counter
`0x1029e62c`, `object+0x04 = slot`, then `HashObject`.

## Consequences for index assignment

- Within one map load, `LoadAllObjects` walks the export table 0..N-1 in
  ascending order and calls `CreateExport` for each (confirmed; our package
  parser reproduces that table). **But `CreateExport` is recursive:**
  constructing an export first constructs its class, its `Outer`, and any
  referenced objects not yet loaded, each taking the next global slot as it is
  first constructed. A map package's exports are therefore **not** assigned a
  contiguous global-index block.
- **A map actor's index is not `N0 + exportIndex`.** That closed form was a
  hypothesis; the live capture below disproves it. `N0` is not a usable
  constant, because the map's own exports interleave with class members and
  imported resources during the recursive load.

## Ground truth from the live process (2026-09-11)

The global registry is now read directly from the running retail game under
CrossOver/Wine by a sibling Win32 process (`tools/dump-gobjects-win.c`:
`OpenProcess` + `ReadProcessMemory` on `Core.dll` `GObjObjects` at base+0x19e628,
count base+0x19e62c; UObject index +0x04, Name +0x20, Class +0x24; `FNameEntry`
text +0x0c, UTF-16). This is the authority for any object's global index, and it
is reproducible: re-capture in any state or map. Standing in `00_Training`,
Core.dll loaded at its preferred base `0x10100000`, `GObjObjects` held **42,167**
dense entries (every slot equals the object's stored index — no free-slot reuse
in this state) and `GNames` **80,996**.

The neighbourhood of the training `LightSwitch0` actor (global index **34242**)
shows the recursive construction order, not an export block:

```
34240 ShopLight.ShopLight1         34262 Function.Tick
34242 LightSwitch.LightSwitch0     34269 State.TriggerPound
34243 Sound.Switch4ClickOff        34270 Class.TriggerLight
34245 Function.Frob                34271 LodMesh.LightSwitch
34259 BoolProperty.bDelayFullOn    34273 Class.LightSwitch
                                   34274 DeusExLevelInfo.DeusExLevelInfo0
```

The actor is interleaved with its class being loaded (`Class.LightSwitch`,
`Class.TriggerLight`), that class's members (`Function.Frob/Tick`,
`State.TriggerPound`, `BoolProperty.bDelayFullOn`, …), its resources
(`LodMesh.LightSwitch`, `Sound.Switch4Click*`, `Texture.LightSwitchTex1`) and
on-demand `Package`/`LinkerLoad` placeholders — precisely the `CreateExport`
recursion. The capture is parsed by `scripts/original-gobjects.mjs`.

## Runtime-spawn index model (implemented)

The load-time indices are measured evidence: the live capture is the authority
for every object created during `LoadAllObjects`, and the runtime resolves a
pre-placed object's slot from it by `(class, name)` (a capture-backed provider on
`ScriptRuntime`, installed with `setOriginalObjectIndex`; `soundField('ObjectIndex')`
consults it, `docs/script-sound.md`). The provider never guesses — an ambiguous
reflection key such as `Function.Tick` yields null, so the object falls through
to its modeled slot rather than borrowing a wrong one.

Objects the capture cannot cover on its own are **runtime spawns**, created after
the snapshot. Their indices come from the recovered Core `AddObject` rule
(`0x10157830`) continued from the measured registry state, not from re-deriving
the load-time order:

- `seedScriptObjectRegistry({count, freeIndices})` (`src/runtime/script-object-construction.mjs`)
  builds a `ScriptObjectRegistry` whose object array is `count` long (the live
  high-water mark, `GObjObjects` count `+0x19e62c`) with the freed slots as holes.
- `ScriptObjectRegistry.add` (already the recovered rule) reuses the last freed
  slot LIFO, else appends at the high-water count; the UObject destructor
  (`docs/script-object-release.md`) nulls the slot and pushes its index to the
  free list.

The capture is itself a valid state of that model, which cross-checks it: for
`00_Training`, `GObjObjects` count is **42167**, dense from 0 with exactly one
freed slot (**42156**) as its only hole, and nothing at or above the count. The
capture's own tail is the evidence — indices 42157–42166 are transient runtime
spawns (`GC*`, `AIReceiverEvent*`, `UNATCOTroopCarcass0`), the highest slots
precisely because they were appended last, while pre-placed `LightSwitch0` is
measured far below at 34242. Seeding at that state and allocating forward reuses
42156 then appends 42167, 42168, … into slots the capture left free — never
colliding with a measured object.

Validation: `test/script-object-index.test.mjs` (the pure seed + append/LIFO
rule) and `scripts/validate-object-index-model.mjs` (the rule cross-checked
against the live capture and fed through the PlaySound channel-id formula).

## Status

- Recovered: the full load chain (`Browse` → `LoadMap` → `LoadPackage` →
  `GetPackageLinker` → `LoadAllObjects` → `CreateExport` → `StaticConstructObject`
  → `AddObject`), with every IAT slot named.
- Superseded: the static `N0`-emulation plan (a ~29-minute bounded run that was
  also built on the disproved `N0 + exportIndex` model). The earlier note that
  "a live measured capture cannot substitute for the replay" reasoned only about
  **in-game console commands** (UE1 `obj list`/`getall`, indeed absent from the
  retail strings); it does not apply to reading `GObjObjects` out of process
  memory, which is now the authority.
- Implemented: pre-placed lookup from the capture, and the runtime-spawn model
  (seeded `AddObject` append + LIFO free list) above. Open only as later
  integration: wiring the seeded registry into the live `createGame` spawn path
  (spawns are currently gated to CameraPoint) and a distilled, shippable
  load-time index table for the browser (the `.cache` capture is local evidence).

### Play's registry against the capture (2026-10-02)

After a Training boot, Play's object registry lists, from the player on, the
same classes in the same order as the capture's contiguous tail from
`JCDentonMale1` (41639): FlagBase, PlayerReplicationInfo, Shadow,
BarkManager, the 50 color themes, AugmentationManager and its 24
augmentations, the skills, NanoKeyRing, DumpLocation — 167 objects. The
names differ only by the Entry map's counter (Play's `AugSpeed0`, the
original's `AugSpeed1`). The original then creates `DeusExRootWindow1`, its
`GC*` graphics contexts and every HUD window (360 more objects up to the
capture); Play keeps windows host-owned outside the registry, so the
sequences part there. Giving runtime spawns their original indices needs the
window objects in the registry in this order, then the capture's tail
(the one freed slot 42156 reused first, then appends from 42167). Until then
Play uses measured indices only for pre-placed actors and the player
([galaxy audio](galaxy-audio.md#play)).

## Harness replay progress (2026-09-10)

`scripts/native-boot-replay.py` executes the original DLL bootstrap in the
Unicorn harness. It is research-only and never imported by the browser.

### Static-initializer arrays (recovered)

Each DLL's `_CRT_INIT` calls `_initterm`; the array entries are the MSVC C++
static initializers, including every native `UClass` static object constructor
that queues itself for registration. Core/Engine/Fire/IpDrv/Extension/ConSys
import `_initterm` from msvcrt; DeusEx.dll statically links its CRT and drives
its arrays through the internal `_initterm` at `0x1001bf67`.

| DLL | preferred base | loaded base | init ranges | entries |
| --- | --- | --- | --- | ---: |
| Core.dll | `0x10100000` | `0x10100000` | `0x101a7000`–`0x101a78a4` | 553 |
| Engine.dll | `0x10300000` | `0x10300000` | `0x10479000`–`0x10479b28` | 714 |
| Fire.dll | `0x10500000` | `0x12200000` | `0x10515000`–`0x10515034` | 13 |
| IpDrv.dll | `0x10700000` | `0x12300000` | `0x10723000`–`0x107232e8` | 186 |
| Extension.dll | `0x10000000` | `0x12000000` | `0x10097000`–`0x10097914` | 581 |
| ConSys.dll | `0x10000000` | `0x12100000` | `0x1001d000`–`0x1001d13c` | 79 |
| DeusEx.dll | `0x10000000` | `0x11000000` | `0x10034178`–`0x1003418c`, `0x10034000`–`0x10034174` | 98 |
| DeusExText.dll | `0x10000000` | `0x12800000` | `0x1000a000`–`0x1000a044` | 17 |

Core is listed first in the table but registers last: the queue is drained in
reverse construction order, so the last-loaded DLL's classes get the lowest
indices. Known Core registration bodies sit at construction indices Field 89,
Struct 91, State 93, Class 95, Object 424, Package 441, Property 453,
ObjectProperty 463, ClassProperty 465.

Engine's mapped image spans `0x10300000`–`0x105ba000`, so even Fire/IpDrv
overlap it. `Image.rebase` in `scripts/native-collision-oracle.py` applies the
PE `.reloc` `IMAGE_REL_BASED_HIGHLOW` fixups and changes the image base; all
init-array addresses shift by the same delta.

### Bootstrap supplied by the harness

- Fake `FMalloc` at `0x71000000` with an emulator-backed bump allocator:
  slot `+0x00` = Malloc, `+0x04` = Realloc, `+0x08` = Free. Reallocation must
  copy the old block from **guest memory**; a Python mirror goes stale because
  the emulated code writes directly to guest RAM.
- `GObjObjects` (`0x1029e628` data, `0x1029e62c` count, `0x1029e630` capacity),
  free-index array `0x1029e618`, 4096 hash buckets `0x1029e644`, FName table
  `0x102961f0` and `GNameAvail` `0x102961e0`, all zero.
- `appFailAssert` (`0x10102c70`) overwritten with `ret` to match the release
  assert-and-continue behavior without the log/config device graph.
- CRT (`msvcrt.dll`) and kernel32 import handlers. msvcrt calls are cdecl;
  kernel32 calls are stdcall and must clean their own arguments
  (`WideCharToMultiByte` has **8** args, not 6). DeusEx.dll's statically-linked
  CRT additionally needs the Win32 heap (`GetProcessHeap`, `HeapCreate`,
  `HeapAlloc`, `HeapReAlloc`, `HeapFree`, `HeapSize`), critical sections and
  `SetUnhandledExceptionFilter`, plus `GetACP`/locale stubs; these map onto the
  harness allocator / are no-ops.

### Result

All 2,241 static initializers across the eight native DLLs execute with
**zero** failures. `FName::StaticInit` (`0x1014bbc0`) is called before the
drain, exactly as `appInit` does: it zeroes the 4096 name buckets and seeds the
hardcoded name table with `None` at index 0, then 1,024 hardcoded names follow
(a static run ends with 1,091 interned names). Without it the first real name
receives index 0 and collides with `NAME_None`, which makes
`StaticAllocateObject` take the generated-name path.

With that in place, `ProcessRegistrants` (`0x10152a40`) completes: the recovered
constructor/queue, `UObject::Register`, `CreatePackage`,
`StaticAllocateObject`, `AddObject` (`0x10157830`) and `HashObject`
(`0x10157730`) assign **296** global `GObjObjects` indices, deterministically
across runs, covering the package objects, every native class object and its
`InitClassDefaultObject` default object. `--json` emits the index→name table.
This is the DLL-static-constructor component of `N0`.

One explicit index-recovery boundary was needed: `UObject::LoadConfig`
(`0x101023dd`) and `UObject::LoadLocalized` (`0x1010306c`) are stubbed with
their correct thiscall returns. Both require the Engine config/localization
device graph (already recovered as a separate subsystem,
[object config](script-object-config.md)) and do not create registry objects, so
they cannot change an index count. Nothing else about the drain is stubbed.

### DLL load order is package-driven (decisive)

The pre-run order above is **not** the original order. `DeusEx.exe` statically
imports only `Window.dll`, `Core.dll`, `Engine.dll` (then USER32/KERNEL32/
GDI32/ADVAPI32/SHELL32/MSVCRT). `appInit` (`0x10149840`, thunk `0x10102e55`)
sets up `GMalloc`/`GLog`/`appFindPackageFile`-support globals, calls
`FName::StaticInit`, then `UObject::StaticInit` (`0x10152790`) which drains the
statically-queued Window/Core/Engine classes and creates the transient package.
It does not load game packages.

The game native DLLs load later, one per package, from
`UObject::BindPackage` (`0x10152ff0`, thunk `0x101017e9`). `BindPackage` is
called at the end of the **`UPackage` constructor** (`0x1015a418`, right after
the `UPackage` vtable write `0x101753a0`). It builds `<PackageName>%s%s` with
`".dll"`, calls `appGetDllHandle` (`0x1010181b`), stores the handle at
`linker+0x28`, logs `Bound to %s%s`, and calls `ProcessRegistrants`
(`0x10152a40`). So the sequence per package is: construct `UPackage` → bind and
run that package's DLL static initializers → drain them → then create the
package's exports.

Consequences for `N0`:

- The native-class indices are interleaved with package-object and (for later
  packages) export-object creation; the eight-DLL single drain yields the right
  class set but not the right order.
- Exact indices require replaying package construction in dependency order, with
  `appGetDllHandle` dynamically loading (rebasing + initializing) each DLL at
  its bind point.
- Core has **no file I/O imports**: `GetPackageLinker` resolves the path through
  `appFindPackageFile` (`0x10102e87`) and reads through the `FFileManager`
  passed to `appInit` (stored at `0x101a7c48`). A faithful replay therefore
  needs a fake `FFileManager`/archive like the LodMesh oracle's.

### Package-loader replay (working)

`scripts/native-boot-replay.py --package-load` runs the package-driven replay:

- Only the exe's static DLLs (Core/Engine/Window) are preloaded; every other
  native DLL is loaded on demand by the `appGetDllHandle` (`0x1010181b`) hook,
  which rebases/maps the image, recursively loads native dependencies, wires its
  IAT and runs its `_initterm` arrays.
- `appFindPackageFile` (`0x10102e87`) resolves a name across
  Maps/System/Sounds/Textures/Music, preferring `.u`/`.dx`/`.uax`/`.utx`/`.umx`
  over same-stem `.ini`/`.int`/`.dll`.
- `UObject::StaticInit` (`0x101011c7`) creates the transient package that
  `GetPackageLinker` uses as the linker Outer.
- A fake `FFileManager` at `GFileManager` (`0x101a7c48`) serves package bytes
  through virtual slot `+0x00` (`CreateFileReader`; the linker calls
  `[vtable+0]`, not `+4`), with a fake `FArchive` (`Serialize` slot 1, compact
  `operator<<` 6/7, `Tell` 10, `Seek` 13, `AttachLazyLoader` 14).
- The `ULinkerLoad` constructor (`0x10160000`) builds its `CreateExport` flag
  mask at `+0xa0` from `GIsEditor`/`GIsClient`/`GIsServer`
  (`0x101e5544/48/4c`); single-player sets client+server. With all three zero
  the mask is zero and **every export is skipped**, which was the last blocker.

Result: the loader works. `LoadPackage(Core)` walks all **699** exports
(`GObjObjects` 192 → 881) and `LoadPackage(Engine)` adds its **5622** exports
(→ **6356**). The full boot index table through Engine is saved to the ignored
`.cache/boot-replay-core-engine.json` (6356 objects, 4651 names), written by
`--out=PATH`; the first entries are `Window, WindowManager, Core, Object,
Engine, NetPendingLevel, …`.

### Ranged code hooks (2026-09-10)

The global per-instruction hook was replaced with ranged `UC_HOOK_CODE` hooks
covering only the thunk (`0x70000000`–`0x70200000`) and fake-handler
(`0x71000000`–`0x71200000`) regions plus the two intercepted Core entry points.
The earlier attempt failed because `Uc.hook_add` is
`(htype, callback, user_data, begin, end)` — passing the range positionally put
it in `user_data`/`begin` with `end=0`, so no hook fired. With `user_data=None`
and explicit `begin`/`end` the hooks work: the default run is ~5 s (was ~9 s)
and `LoadPackage(Core)` ~9 s (was ~16 s). Core/Engine code now runs with no
Python callback.

This did **not** make DeusEx practical: `Core,Engine,DeusEx` still exceeds a
~29-minute bounded run. The remaining cost is raw emulation of the linker
(millions of property links for 27k+ exports), not hook overhead, so completing
the full emulated `N0` this way is a multi-hour/day job. The practical path is
to model index assignment in JS from the recovered rules (ascending export
order per package, DLL binds at `UPackage` construction), seeded and
cross-checked by the harness tables already saved (Core+Engine in
`.cache/boot-replay-core-engine.json`).

### Open harness blockers

1. The full emulated boot sequence (`Core`, `Engine`, the game-engine package,
   then the map and its transitive dependencies) is not practical at emulator
   speed. Either accept the JS model for the remaining index assignment or find
   a faster way to run the original linker.
2. Confirm which driver DLLs (`Render`/`WinDrv`/`D3DDrv`/`Galaxy`) register
   native classes and when they bind, and add them to `DLL_INFO`.
3. Compare the harness index table against the JS registry.

These are harness/bootstrap issues, not evidence about the original game.

## Original-game registry capture (preferred evidence)

The user can run the original game, so the authoritative source for `N0` and
every object index is a live dump of its registry — not the emulator or a model.
`tools/dump-gobjects.py` reads the recovered `Core.dll` structures from the
running process with `ReadProcessMemory`:

- `GObjObjects` FArray: data `+0x19e628`, count `+0x19e62c` (module-relative)
- `GNames` FArray: data `+0x1961f0`, count `+0x1961f4`
- object `+0x04` global index, `+0x20` FName index, `+0x24` class `UClass*`
- `FNameEntry` text at `+0x0c` (UTF-16)

It finds `DeusEx.exe`, looks up the actual `Core.dll` base (so ASLR/relocation
is handled), and prints `slot index Class.Name` for every registered object.

Procedure:

1. Start the original game and load training (so the map and its dependency
   packages are resident).
2. Run `python tools/dump-gobjects.py --find LightSwitch --json gobjects.json`.
3. Send back `gobjects.json` (or just the `LightSwitch0` line). Its `index` is
   the true global UObject index the sound native needs; the largest index seen
   is `N0`-plus-map for that load.

This measurement supersedes the emulated/harness `N0`: the harness remains useful
for understanding the load order and for cross-checking, but the running game is
the reference. Keep the dump outside Git (it contains live addresses only).

If Windows Python is unavailable (e.g. CrossOver/Wine on macOS), the same read
can be done with Cheat Engine (attach to `DeusEx.exe`, open the `Core.dll`
memory region, follow the pointers at the offsets above) or any debugger, or by
running this script with Python-for-Windows inside the same Wine prefix.

### CrossOver/Wine on macOS

The host cannot read Wine's translated 32-bit address space, so run the dumper
inside the bottle. `tools/dump-gobjects-win.c` is the Win32 build; compile and
run it with the game's Wine:

```sh
brew install mingw-w64
i686-w64-mingw32-gcc -O2 -o tools/dump-gobjects-win.exe \
    tools/dump-gobjects-win.c -lpsapi
cp tools/dump-gobjects-win.exe \
   "$HOME/Library/Application Support/CrossOver/Bottles/DeusEx/drive_c/Deus Ex GOTY Edition/System/"
```

With the original game running and training loaded:

```sh
CX="/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin"
CX_BOTTLE=DeusEx "$CX/wine" \
  'C:\Deus Ex GOTY Edition\System\dump-gobjects-win.exe' LightSwitch
```

It prints `slot <slot> index <index> <Class>.<Name>`. Run with no filter (redirect
to a file) for the full table, which gives the true `N0` and every index. The
compiled `.exe` is a local build artifact and stays out of Git (`*.exe`).
