# Original object-index captures (per map)

Speech, and every other sound the original plays, gets a channel id built
from the emitter's `GObjObjects` index: `(Index << 4) + (Slot << 1) +
bNoOverride` (`execPlaySound`, [script-sound](script-sound.md)). The index of a
pre-placed actor depends on everything the process loaded before the map, so
it cannot be derived from the package (N0 + export index is wrong, see the
project memory note on the live capture oracle); it is measured on the
running original and kept in a per-map table:

| Map | Table | Capture (local, `.cache/`) |
| --- | --- | --- |
| 00_Training | `src/runtime/training-npc-identities.mjs` | `original-gobjects.txt` (2026-09-11; checked by validate-npc-mesh-preview) |
| 01_NYC_UNATCOIsland | `src/runtime/island-npc-identities.mjs` | `original-gobjects-20261001-island-open.txt` |
| the other 81 single-player maps | `src/runtime/map-npc-identities.mjs` (generated) | `original-gobjects-20261001-<map>-open.txt` |

`script-conplay-live.mjs` assigns them (`globalIndex`) when Play starts. A
pawn without an index (only 04_NYC_NSFHQ's UNATCOTroop27, below) stops its
first speech at "PlaySound requires the registered global UObject index". Everything else in
conversations (camera, letterbox, gestures, lip sync) is shared code and
needs nothing per map.

## Convention

Both captures open the map from the boot map's console (`open <map>`), not
by travelling from the previous mission. Our Play also loads each map fresh,
and on Island the convention matched: MeetPaul's channels use Paul's captured
35713. An index after the original's own travel (intro to Island, mission
to mission) was not measured; check one map that way before relying on the
convention for a travelled save.

## Procedure for one map

The original runs in the CrossOver bottle `DeusEx`; `ad/scripts/original-game.mjs`
drives it ([original-game camera capture](../ad/README.md) has the setup);
`tools/dump-gobjects-win.exe` (built from `tools/dump-gobjects-win.c`, see
[boot replay](boot-replay.md)) is copied into the game's `System` folder.

```
node ad/scripts/original-game.mjs launch
printf 'cmd open 02_NYC_BatteryPark\nsleep 30000\n' > /tmp/open.dxinput
node ad/scripts/original-game.mjs run /tmp/open.dxinput
CX_BOTTLE=DeusEx /Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine \
  'C:\Deus Ex GOTY Edition\System\dump-gobjects-win.exe' > .cache/original-gobjects-<date>-<map>-open.txt
node scripts/capture-npc-identities.mjs .cache/original-gobjects-<date>-<map>-open.txt 02_NYC_BatteryPark
node ad/scripts/original-game.mjs quit
```

`capture-npc-identities.mjs` loads the map in this checkout, matches every
pre-placed Pawn of the map's package to the capture by class and name and
prints `{count, missing, identities}`; `missing` must be empty. Put the
identities in `src/runtime/<map>-npc-identities.mjs` and add the map to the
`captured` table in `script-conplay-live.mjs`.

## All maps

`scripts/capture-object-indices.mjs` runs the procedure for every map in
`Maps/` (or `--maps a,b`): a fresh `DeusEx.exe` per map on `00_Training.dx`,
`open <map>`, the 30-second wait, the dump to
`.cache/original-gobjects-<date>-<map>-open.txt`, then `exit` (a forced
`wineserver -k` if the console is unavailable, whose "Recovery Mode" wizard the
next launch dismisses). A process per map keeps every capture the same
convention as Island's, whatever the order; about 70 s per map.

On the Linux host (plain Wine, docs/linux-host.md) the driver takes
`DX_WINE=/usr/bin/wine`, `DX_GAME=$WINEPREFIX/drive_c/Deus Ex GOTY Edition`
and an exported `WINEPREFIX`; `ad/tools/dxinput.exe` is built with
`i686-w64-mingw32-gcc -O2 -o dxinput.exe dxinput.c`. Run there on 2026-10-01,
Island reproduced the Mac (CrossOver) capture: all 58 pawn identities equal,
PaulDenton0 = 35713.

Done on the Linux host on 2026-10-01: all 88 maps captured (none needed more
than the one retry). `scripts/build-npc-identities.mjs` turned the 81
single-player maps other than Training and Island into
`src/runtime/map-npc-identities.mjs`: 1,425 pawn indices, every pre-placed
Pawn matched except 04_NYC_NSFHQ's `UNATCOTroop27`. The original loaded it
(index 34917 lies between Troop26's and Troop28's) and destroyed it before
the dump, so it never speaks there. The multiplayer maps (`DXMP_*`) are
captured but not tabled: multiplayer is deferred, and Play does not boot
DXMP_Cathedral. `scripts/validate-map-npc-identities.mjs` checks every entry
against its capture file; `build-npc-identities.mjs --check` rebuilds the
module from the captures and compares (it loads every map, so it is not part
of the sweep).

## Every pre-placed actor

`scripts/build-map-object-indices.mjs` reads the same captures for every
pre-placed actor of each map (the Level's actor list), not only pawns, and
writes `src/runtime/map-object-indices.mjs`: per map, the (export index,
global index) pairs as base-64 VLQ zigzag deltas (172 KB for all maps), with
`mapObjectIndex(map, exportIndex)`. Only a Class.Name that is unique in the
capture counts, as for pawns. A map whose pawn table came from another
capture session would be left out rather than mixing two index spaces.
Training's pawn table and LightSwitch0's 34242 come from the 2026-09-11
capture of the map itself (`original-gobjects.txt`), which the builder reads
for Training; its later captures are separate sessions whose free-slot reuse
differs (JaimeReyes0 is 34333 there, 34339 in `training-start` and 34327 in
`00_training-open`, and the offsets vary per actor). Every map's pawn entries
agree with the table.

`MAP_PLAYER_INDICES` holds, per map, the one JCDentonMale instance of the same
capture (JCDentonMale1: the Entry map's player took 0), 82 maps; Play gives it
to the player each Login spawns (`mapPlayerIndex`, script-doors.mjs), so the
player's sounds form their original channel ids (galaxy-audio.md "Play").

Coverage: 53,018 of 53,862 non-Brush actors (98.4%; Training 305 of 316),
and, before Training was added, 1,775 of 1,795 actors with an AmbientSound. The unmeasured ones are mostly CSG Brushes, which
are not resident in the running game's level, and 20 Lights whose names are
ambiguous in their capture. `measured-object-indices.mjs` gives every
measured actor its `globalIndex` before the map's startup runs; the pawn
tables take precedence.

## Runtime spawns (2026-10-14)

The tables above give the index of every actor the map placed. An actor created while the game runs (a fragment, a shell
casing, a weapon `summon`ed or dropped by a crate, a bullet hole, an AI event object) has none: the slot it holds is
whatever `UObject::AddObject` (Core `0x10157830`) gave it, the last entry of `GObjAvailable` (LIFO) or else a new slot at
`GObjObjects.Num`, and `~UObject` (`0x10150040`) gives the slot back
([object release](script-object-release.md)). A sound's channel id needs that slot, so until now their `PlaySound` stayed a
recorded boundary (channel 0, silent: the `decorationEffect` and `soundBoundary` paths of `script-doors.mjs`).

**The model.** `src/runtime/original-object-index.mjs` is that rule and nothing else, started from a measured state:

* The seed is the registry as the live dump shows it: `Num` and the free slots. `map-registry-seeds.mjs` holds it for every
  single-player map (`scripts/build-map-registry-seeds.mjs`, from the same captures as the tables above: Training's
  `Num` 42167 and its one hole 42156; 44 maps have no hole, 42 have more than one). The dump lists holes as a set, not in
  the order they were freed in, so a seed is `exact` only with at most one hole; with more, the order the first spawns reuse
  them in is an assumption (`seed.exact` says so).
* `createGame` seeds it when the boot is over (the capture's `Num` includes everything the boot made); a harness replaces
  it with the original's own dump at its start (`liveProbe objectTrace.seed`).
* Every object created afterwards takes `originalIndex` from it, and gives it back when it is released: registry objects
  (`ScriptObjectRegistry.add`, `destructScriptObject`: spawns, `new`s), windows and graphics contexts
  (`script-window-host.mjs`), the AI event manager's types, senders and receivers (`js_ai_slot`, `aievent.rs` `alloc`/`release`),
  FlagBase's `FlagBool`s, a pre-placed actor's own measured slot when `CleanupDestroyed` releases it, and, with a measured
  set of resident packages, the UPackage + LinkerLoad + export of a first speech-audio load.
* `ScriptRuntime.soundObjectIndex(actor)` answers `{index, source: 'measured'}` for the capture's indices and
  `{index, source: 'modeled'}` for a model slot; the host registry's own slot is neither and is never used for a sound.
  `execPlaySound` (via `playSoundServices`) and Galaxy's ambient scan use it, and `runtime.audio.modeledIds` counts the
  classes that played with a modeled id.
* The model never stops the game: a give-back it cannot match (an index outside `Num`, a slot already free) is counted in
  `rejected`.

**What the id is for.** Galaxy compares ids for equality only (`PlaySound` replaces a channel of the same id, `StopSoundId`
matches one, `Update` reads the slot bits `Id & 0xe`): the audible behaviour of an emitter needs an id that is unique among
live objects and the same for each of its sounds, and the model gives that. The magnitude is the original's only while
every creation and release since the seed is replayed in order; it is labelled modeled for that reason.

**Evidence: the weapon scene against the original (06_HongKong_WanChai_Underworld, 400 ticks).** The original, under
`live-original.sh --registry`, with the tracer's `call` breakpoints at `AddObject`, `UnhashObject`, `ClientHearSound` and
Galaxy's `PlaySound` (`tools/dx-live-win.c` `retname`; `tools/dump-gobjects-win.c --available` for the free list), typed
`summon DeusEx.WeaponPistol`, the pickup, the draw and three shots. The scene creates 563 objects and frees 235 (AI event
objects: 361 created and 211 freed; 17 graphics contexts; 10 glass fragments; NPC inventories; the pistol; a shell casing;
effects; a bark's windows and its audio package). Play replays the scene with the original's start registry as the seed and the run's own
indices for the pre-placed actors (`live-acceptance.mjs play --object-trace`), and `scripts/live-sound-compare.mjs` lines the
two up:

| What | Result |
| --- | --- |
| Registry takes in order (class and slot) | the first 310 agree, to tick 60; Play then creates the two startup flags of Mission06 (`M06_..._StartupText`, `M6MissionStart`) that the original does not create in these 400 ticks (an open difference of the mission script, not of the model). Without the flag objects 417 agree, to tick 212: the 217 objects of tick 1 (NPC inventories, AI event types and receivers), the AI event traffic, the pistol (it takes slot 50689, a sender event's freed slot), the glass shot's 10 fragments, shell casing, bullet holes and tracer, a conversation's windows and graphics contexts, and the bark's Package/LinkerLoad/Sound |
| Frees in order | the 21 of the first 22 agree; the 22nd is the sender event the player's landing left in the manager before the scene (Play replays it as a measured input, `preFrees`) |
| Galaxy `PlaySound`, pre-placed emitters | 85 of 85 calls matched in tick, emitter, sound, volume, radius and pitch have the original's channel id |
| Galaxy `PlaySound`, emitters spawned in the scene | the ones created before the first difference have the original's id: the pistol (`DropSmallWeapon`, slot 50689: the freed slot of a sender event) in the run above, and in the run without the flag objects also GlassFragment9 (817040) and ShellCasing0 (815680, three hits); the ones after it are off by the slots the difference shifted (GlassFragment9 at 817072, 2 slots up, with the flags) |
| Galaxy `PlaySound`, all | 93 of 112 calls matched, the rest differ in what the NPCs and the shots did (below), not in the channel logic |

The scene's second and third shots hit other things in Play than in the original (blood actors in Play, a wall in the
original), so from tick 270 the spawns themselves differ.

**What is not modeled, so the id of an emitter created after it is the model's alone:**

* temporary graphics contexts of window layout (five in the bark's display, created and freed in one tick) and any other
  object a window native creates and deletes inside one call;
* a runtime load of anything but speech audio (a texture, a font, a mesh; a `DynamicLoadObject` of a package), and every
  load before the seed;
* the intermediate objects of a conversation or a save/travel (`ConPlay`'s history and flag objects other than FlagBase's);
* frees of pre-placed objects that have no measured slot (counted in `unattributed`), the order `DeleteAllFlags` frees
  flags in (insertion order here, the native walks its hash buckets), and the free-list order of a seed with several holes;
* after a Player start (LoadMap) the model is not re-seeded: the map change frees and creates objects it does not see.

**Repeating the scene** (one original at a time, `scripts/live-original.sh`, the Wine lock; on the Mac also the sessions' bottle lock
`.work/bottle.lock`). The scene of row 4.3.6's capture `sndm5` (Mac, 2026-10-16):

```
scripts/live-original.sh 06_HongKong_WanChai_Underworld --tag sndm5 --ticks 400 --delta 0.0166666675 --no-ghost --registry \
  --extra-config sound.cfg --cmds "20:summon DeusEx.WeaponPistol|50:set DeusEx.JCDentonMale ViewRotation (Pitch=-10130,Yaw=49096,Roll=0)|90:ParseRightClick|130:ActivateBelt 1|170:set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=49096,Roll=0)|210:@down Enter|210:@up Enter|270:@down Enter|270:@up Enter|330:@down Enter|330:@up Enter"
```

with `sound.cfg`:

```
call-ticks 1 400
call-frames
call 0x10157830 addobj 1 always retname
call 0x10157760 unhash 1 always retname
call 0x10608100 gplay 9 always name0 namearg 2 -1
call 0x103e1b00 hear 7 always name0 namee namearg 2 -1
call 0x103814e0 inputevent 4 always
call 0x10382c60 aisend 5 always name0 fname 1
call 0x10382fe0 aistart 5 always name0 fname 1
call 0x103831e0 aiend 3 always name0 fname 1
call 0x103832c0 aiclear 2 always name0 fname 1
call 0x10384980 aievent 5 always name0 fname 1 fname 4 namearg 3 0 deref 3 5 0
call Extension.dll@0x1003be90 roottick 1 always
```

(`live-acceptance.mjs population --map ... --seed 1` first; rebuild `ad/build/dx-live-win.exe` from `tools/dx-live-win.c`.) Then
`live-acceptance.mjs play --map ... --seed 1 --tag T --no-ghost --object-trace 1:400` and `live-sound-compare.mjs --tag T --gate`. The
replay takes four measured inputs from the capture besides the deltas and the stream: the key edges' stream state (`inputevent`), the
receiver AIProcess's 2 ms rdtsc budget left `firstProcess` at each tick (the trace rows' `aiFirst`,
[AI event manager](ai-event-manager.md) "The time budget"), the window system's wall-clock deltas (`roottick`,
[interface frames](interface-frames.md) 2b) and the pre-scene objects the original frees (`preFrees`, the AI ones at the end of the
manager's Tick). The captures stay in `.work/` (outside Git).

**Row 4.3.6 on `sndm5` (2026-10-16).** Every registry take and free of the 400 ticks is the original's (557 of 557 takes, class and
slot), so every runtime-spawned emitter has the original's id: the summoned pistol, the glass fragment, the three shell casings, the
tracers. What it took, in the order the captures found it ([galaxy-audio](galaxy-audio.md) "Row 4.3.6"): FastLineCheck over the
tracker's model, XGC::PushGC's registered nodes, AIProcess's budget, the window clock and order, and the landing sender's free in
CleanupEvents.
