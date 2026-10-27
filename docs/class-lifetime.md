# Class lifetime across LoadMap

Which script classes the original keeps when it changes maps, which it
collects, and what that means for Play. This answers the open question in
[travel](travel.md#class-defaults-across-a-travel) ("Which classes live on"),
from the GOTY DLLs and from the running game under CrossOver (2026-10-26).

## The rule

A class is an ordinary collectable object.

* **Native classes are never collected.** A class export flagged `RF_Native`
  (`0x04000000`) keeps that flag when it loads. It is one of the
  collector's roots, and the purge skips it.
* **A script-only class lives while the collector reaches it.** The
  collector starts from the root array and every native object. It follows
  each object's references, including a class's dependency list, bytecode
  and defaults.
* **A linker does not keep its package's classes.** A package stays loaded
  while any of its objects is reachable, but its unreachable classes are
  collected one by one.
* **LoadMap loads the next level before it collects.** A class that the new
  level uses is found already loaded, so it keeps its identity, its defaults
  and its name counter.

In practice, measured over DX.dx → 00_Training → 01_NYC_UNATCOIsland →
00_Training:

* About 1,000 classes alive at the start never change identity. These are
  the native ones and what they reach: the player, inventory, weapons, HUD,
  menus and the engine's classes.
* Each level's own classes are collected when it is left. These are its NPCs
  and their carcasses, its decorations and its mission script. A later level
  that uses one of them loads it again as a new object, with the package's
  defaults and a class name counter (`ClassUnique`, `Class+0x488`) starting
  from 0.

In single-player, the collection runs only in LoadMap, and when the console's
`OBJ GARBAGE` is typed.

## Evidence from the binaries

**Flags.** CreateExport keeps `Export.ObjectFlags & 0x067f0025` (`RF_Load`,
which includes `RF_Native`) ([CreateExport](script-create-export.md)). The
shipped packages flag their class exports `0x040f0004` (native) or
`0x000f0004` (script-only):

| Package | Native classes | Script-only classes |
| --- | --- | --- |
| Core | 4 | 3 |
| Engine | 57 | 32 |
| Extension | 34 | 0 |
| DeusEx | 15 (DeusExPlayer, ScriptedPawn, Augmentation, DeusExDecoration, Skill, AugmentationManager, DeusExLevelInfo, DumpLocation, SkillManager, DeusExSaveInfo, DataVaultImageNote, GameDirectory, LaserIterator, DeusExLog, ParticleIterator) | 1,143 |
| ConSys | 33 | 2 |
| DeusExText | 1 | 1 |
| Fire | 6 | 0 |
| IpDrv | 3 | 2 |

**Roots.** `SerializeRootSet` (Core `0x101580b0`) serializes the root array
`GObjRoot` (`0x1029e5f8`). Then it serializes every registry object with a
keep flag and the archive bit, `(flags & keepFlags) && (flags & 0x40) ==
0x40`. It has no loader array. `PurgeGarbage` skips `0x04000000` objects in
both object passes ([Core garbage collection](script-gc.md)).

**Edges.**

* `UObject::Serialize` in the collector visits Name, Outer, Class and Linker
  ([UObject serialization](script-object-serialization.md)). Every reachable
  object therefore keeps its class and its linker.
* `UClass::Serialize` visits the super field, children, the bytecode's
  object references, the `FClassDependency` classes (`+0x4bc`),
  `ClassWithin` and the defaults' references
  ([Core metadata](script-class-serialization.md)).
* `ULinkerLoad::Serialize` (`0x10162670`) calls `ULinker::Serialize`
  (`0x1011df90`), then counts the lazy loaders' bytes. In the collector,
  `ULinker::Serialize` runs `UObject::Serialize` and counts the import map
  (28-byte entries, `+0x7c`/`+0x80`) and the export map (36-byte entries,
  `+0x88`/`+0x8c`). It then serializes:
  1. the name map (`+0x6c`);
  2. `LinkerRoot` (`+0x28`);
  3. for each export, its `ObjectName` (entry `+0x0c`), a name only;
  4. for each import, its object word at `+0x14` (the source linker) and two
     names.

  It never visits an export's object. A live linker therefore keeps the
  linkers it imports from, but not its exports.

**Callers.** In the shipped modules, Engine's LoadMap (`0x1038d1e1`, IAT
`0x10599f48`) is the only call. Engine's jump thunk to the same import
(`0x1040cd0a`) is never called. DeusEx.dll, Extension.dll, ConSys.dll,
Render, WinDrv, D3DDrv, Galaxy, IpDrv and Fire do not import
`CollectGarbage`. Core's own call (`0x10153404`) is `UObject::StaticExec`'s
`OBJ GARBAGE`: `CollectGarbage(RF_Native | (GIsEditor ? RF_Standalone : 0))`
with `NOGC` cleared for it. LoadMap's order (load the level, tag the old
level's actors `0x400`, collect) is in
[LoadMap's collection](script-loadmap-gc.md#loadmaps-collection-0x1038d0ee0x1038d1e1).

## Measurement: `gc1`

`scripts/travel-probe.sh gc1 @<steps file>` ran the original under the
Mac's CrossOver bottle. The game starts on DX.dx. The steps file:

```text
wait:5
gflags:dx
cmd:open 00_Training
arrive:00_training$
wait:5
gflags:training
cmd:open 01_NYC_UNATCOIsland
arrive:01_nyc_unatcoisland$
wait:5
gflags:island
cmd:open 00_Training
arrive:00_training$
wait:5
gflags:training2
snap:end
```

Each `gflags:<label>` step runs `tools/dump-gobjects-win.c --flags`, which gives
every registry object's address, index, ObjectFlags and Outer, and the root
array. The dumps stay in `.work/travel/gc1/`, outside Git. A class kept its
identity when the same address and index hold it before and after.

The root array held 5 objects at every stop: `Transient` (package),
`System0`, `WindowManager0`, `DeusExGameEngine0` and the current
`DeusExRootWindowN`. That is a new root window per level: `0` on DX.dx, then
`1`, `2` and `3`.

| Map change | Class objects kept | Collected | Loaded |
| --- | --- | --- | --- |
| DX.dx → 00_Training | 978 (238 native) | 6 (DXLogo, OutdoorThings, DXText, ElectricityEmitter, IonStormLogo, EidosLogo) | 55 (Training's NPCs and carcasses, decorations, Mission00, SecurityBot2, WeaponRobotMachinegun, …) |
| 00_Training → 01_NYC_UNATCOIsland | 1,005 | 28 (Training's NPCs and carcasses, Mission00, LightSwitch, Plant1, HUDRechargeWindow, …) | 95 (the Island's, including OutdoorThings and ElectricityEmitter again) |
| 01_NYC_UNATCOIsland → 00_Training | 1,005 | 95 (the Island's) | 28 (the same 28 Training classes) |

On the return to Training, the 28 classes came back as new objects at new
indices: Mission00 moved from 34861 to 48605, JaimeReyes from 34313 to 47528,
LightSwitch from 34245 to 47543. The classes kept from DX.dx have the same
address and index in all four dumps. WeaponCombatKnife, WeaponCrowbar,
WeaponAssaultGun and WeaponPistol (the four classes whose defaults Play
carries from Training), LevelInfo, PlayerStart, PathNode, NavigationPoint,
JCDentonMale and Shadow are among them.

No class was collected and loaded again within one LoadMap. The collector's
archive sets `0x40` on every object and leaves it set. An object built after
a collection has it clear until the next one:

* on DX.dx, the registered classes of D3DDrv and Galaxy;
* in Training, ConversationList, ConItem and ConEventComment. These are
  native ConSys classes whose script exports loaded in place during the
  level's startup, after the collection.

Every class in the Island and second Training dumps has `0x40`, so a kept
address is the same object.

The engine log records each collection
(`Garbage: objects: <before>-><after>`):

| LoadMap | Garbage | Unloaded packages |
| --- | --- | --- |
| DX.dx (from Entry) | 33603 → 33602 | Render |
| 00_Training | 35216 → 35011 | DX (before the load) |
| 01_NYC_UNATCOIsland | 45406 → 37756 | 00_Training (before), then DeusExConText, HK_MJ12Lab, area51textures, Cmd_tunnels, Training_Music |
| 00_Training | 48875 → 35017 | 01_NYC_UNATCOIsland (before), then DeusExConText, Mobile_Camp, Rocket, the CoreTex packages, Supertanker, Catacombs, V_Com_Center, BatteryPark, LibertyIsland_Music |

The script packages (Core, Engine, Extension, DeusEx, DeusExItems,
DeusExDeco, DeusExCharacters, DeusExUI, DeusExSounds, ConSys, UWindow,
UBrowser, IpDrv, Fire, DeusExText, Effects) are unloaded only at exit.
DeusExConText is unloaded at each collection where no conversation object
is left, and the next level's startup loads it again. Resources (Texture,
Palette, Sound, LodMesh) and linkers follow the same rule: Training's
level-only texture and music packages went away on the Island.

### Frozen arrivals and class defaults: `gc2`

gc1 read each level while it ran, for about 45 s. gc2 repeats gc1's steps
with `set LevelInfo bPlayersOnly True` typed on DX.dx before the first
`open`. LevelInfo is a native class, so its default carries, and every later
level arrives frozen: `LevelInfo0.bPlayersOnly` (`0x4f0`, mask 4) reads 1 on
DX.dx, both Training visits and the Island. The step files are
`.work/travel/gc2.steps`, then `gc2b`, `gc2c` and `gc2d` for the SET
read-backs.

**Class sets.** gc2's class sets equal gc1's at every stop: 984, 1,033, 1,100
and 1,033 classes. So do its map changes:
- DX.dx → Training: 978 kept, 6 collected, 55 loaded;
- Training → Island: 1,005 kept, 28 collected, 95 loaded;
- Island → Training: 1,005 kept, 95 collected, 28 loaded.

Garbage counts: 33603 → 33602, 35216 → 35011, 45376 → 37756 (gc1:
45406 → 37756), and the same unloaded packages.

**Class defaults.** Each SET was typed in Training, the first visit, and read
back with `tools/dump-actor-win.c` at the property's linked offset. None of
these objects serializes the property in the map, so each value comes from
the class default when the object is built.

| SET | Class | In Training | On the Island | Training again |
| --- | --- | --- | --- | --- |
| `set Engine.PathNode ExtraCost 77` (`0x444`) | native, kept | 12 PathNodes: 77 | 1,074 PathNodes: 77 | 12: 77 |
| `set DeusEx.Shadow ScaleGlow 0.75` (`0x18c`) | script-only, kept by reachability | 19 Shadows: 0.75 | 53 spawned Shadows: 0.75 | 19: 0.75 |
| `set DeusEx.LightSwitch ScaleGlow 0.25` (`0x18c`) | script-only, Training's own | LightSwitch0: 0.25 | (no LightSwitch) | LightSwitch0: 1.0, the package default |

A kept class keeps its defaults across map changes, and a collected class
loads again with the package's.

`dump-actor-win` prints a `u32` field in hex (`ExtraCost=0x4d`). The `gc2c`
step only isolated a misread of that output: it confirmed that
`set PathNode ...`, `set Engine.PathNode ...` and a SET through
`Engine.NavigationPoint` all apply.

**A static cross-check.** Follow only the super, `ClassWithin` and
dependency links from the native classes of Core, Engine, Extension, DeusEx,
ConSys, DeusExText, Fire, IpDrv, UWindow, UBrowser and IpServer. This reaches
248 of the 630 DeusEx classes alive on DX.dx. The other classes are reached
through edges the check leaves out (bytecode, defaults, live objects).

Every class the check reaches is alive on DX.dx except Engine.ZoneTrigger.
ZoneTrigger is a dependency of WarpZoneMarker, a class Engine.dll registers.
On DX.dx, WarpZoneMarker's script export has not loaded: its flags are
`0x44084044`, not a loaded export's `0x640f0044`. Its dependency list is
therefore not in memory. The check overcounts by starting from every native
class in the packages, loaded or not.

**Re-captured on the Linux host (2026-10-27).** gc2's base steps ran again
under Wine on the Linux host (`.work/travel/gc2.steps`), for step 4b of the
[class graph design](class-graph-design.md). The dumps hold 34,208, 42,058,
47,757 and 42,058 objects, the same class sets, and the same unloaded
packages in the engine log. `validate-process-collection` and
`validate-original-loaded` pass against it.

### Packages and resources across LoadMap

From gc2's dumps (top-level `Package` objects and the resource classes):

* **Packages.** At every stop the original's top-level packages are exactly
  the import closure (`pkg.dependencies`, followed transitively) of the level
  package and of Entry.dx, plus Transient, Entry, the native DLL packages
  (D3DDrv, Galaxy, Render, WinDrv, Window) and DeusExConText while the level's
  conversation objects live. That is the linker rule: an object's header
  serializes its Linker, a linker serializes each import's SourceLinker
  (VerifyImport sets it for every import), and the level's linker and
  GEntry's are live.
* **Title_Music** is held at every stop because Entry.dx imports it. Probe
  `gc2s` read the `Song` word (`+0x4f4`) of each `LevelInfo0` in Training:
  the level's holds Training_Music, the Entry level's Title_Music
  (`0x01054650`, the DX.dx player's `Song` too, `+0x670`). Probe `gc2m` had
  searched the Galaxy subsystem, the viewport and the engine (`+0x28` to
  `+0x5fc`) and found neither song.
* **Resources.** No resource is collected and loaded again within one
  LoadMap: each one keeps its address or is gone.

| Map change | Resources kept | Collected | Loaded |
| --- | --- | --- | --- |
| DX.dx → 00_Training | 2,449 | 21 (DeusExDeco 20, Ambient 1) | 370 |
| 00_Training → Island | 2,583 | 236 (DeusExCharacters 77, CoreTexMisc 46, UNATCO 40, …) | 547 |
| Island → 00_Training | 2,583 | 547 (DeusExDeco 152, UNATCO 65, DeusExCharacters 61, DeusExUI 52, …) | 236 |

### Name lookups: `gc3`

StaticFindObject (Core `0x10151de0`) searches the objects in memory, so a
lookup by name finds a class only while the original holds it. `gc3`
(`.work/travel/gc3.steps`) types four SETs on DX.dx before the first `open`.
Then it reads ScaleGlow (`0x18c`) back in Training, 3 s after arrival. The
DX.dx dump holds Multitool, NanoKey and SecurityCamera, and Training keeps
the same class objects. It does not hold LightSwitch. None of Training's
objects of these classes serializes ScaleGlow. Each SET is followed by a
shot of the console's message line. Re-captured on the Linux host
2026-10-27 (the first capture stayed on the Mac): the same four console
lines and the same values in Training.

| SET on DX.dx | Console line (shot) | In Training |
| --- | --- | --- |
| `set DeusEx.LightSwitch ScaleGlow 0.25` | Unrecognized class DeusEx.LightSwitch | LightSwitch0: 1, the package default |
| `set DeusEx.Multitool ScaleGlow 0.5` | none | Multitool0–2: 0.5 |
| `set Engine.NanoKey ScaleGlow 0.75` | none | NanoKey0, NanoKey1: 0.75 |
| `set NoSuchPackage.SecurityCamera ScaleGlow 0.4` | Unrecognized class NoSuchPackage.SecurityCamera | SecurityCamera0–3: 1 |

* **A class that is not loaded is not found.** The original prints its
  NAME_ExecWarning line and writes nothing.
* **A loaded class with no live object still takes the write.** Its Defaults
  are written, and the next level builds its objects from them.
* **A dotted name falls back to any package.** ResolveName finds `Engine`.
  Engine's hash bucket holds no NanoKey, so the ANY_PACKAGE walk over every
  object matches the name alone and finds DeusEx.NanoKey.
* **ResolveName fails on a package the process does not hold.** The lookup
  then misses before any walk.

## What it means for Play

*Done 2026-10-27* ([class graph design](class-graph-design.md), migration
steps 1 to 6): one script process keeps the classes, their Defaults and
counters across map changes, LoadMap collects as the original does, and the
travel no longer carries class defaults. The analysis below is the state it
started from (2026-10-26).

Before, each level had its own `ScriptRuntime`. It loads every class it uses
from the packages and carries the class defaults that earlier levels wrote
([travel](travel.md#class-defaults-across-a-travel)). Compared with the
original:

* **Kept classes** (about 1,000, so nearly all of a level's): the original
  keeps their defaults and their `ClassUnique` counters. Play carries the
  recorded default writes, which matches, but restarts every counter at 0.
  This is one source of the spawned-name differences in
  [load time](load-time.md#why-a-map-change-costs-this-much).
* **Collected classes** (a level's own): the original loads them again with
  the package's defaults and counter 0. Play carries any default a level
  wrote to them, which does not match. Training's four recorded writes are
  all on kept classes. Other levels' writes were not checked:
  `DeusExWeapon.PreBeginPlay` writes `Default.mpPickupAmmoCount` for every
  weapon class a level spawns, including an NPC's level-only weapon.
* **Loading cost**: the original loads 28 to 95 classes per map change here.
  Play links every class a level uses on every map change. A headless cold
  load links 967 classes for the Island and 910 for Training
  (`ScriptRuntime.linkedClasses`), and Player start links none again.

So Play should keep one class graph for the page's process, as the original
does, and collect at LoadMap like the original. This needs:

1. the recovered mark over class, linker and resource records;
2. the roots measured above;
3. the purge of unreached classes, which unlinks them from their linker's
   export map so that the next use loads them again.

The reference cases are this probe's four class sets and its `Garbage`
counts. A Play run over the same map sequence must keep and collect the same
classes. The design is in [class graph design](class-graph-design.md).

## Not yet traced

* **Which reference keeps each kept class.** The dependency closure explains
  248 of the 630 DeusEx classes on DX.dx. Play's mark over the class graph
  has to explain the rest, and is checked against the dumps.
* **What the boot loads before DX.dx.** The launch loads Entry, then the
  start map. The roots' first state (DeusExRootWindow0, the console, the
  menus) is part of why some classes are alive from the start.
* **Resources and linkers.** These were counted, not analyzed class by class.
* **A level restored from `Save\Current`, and a loaded game.** Both go
  through the same LoadMap, but neither was in this probe.
