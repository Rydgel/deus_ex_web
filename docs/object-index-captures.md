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
| 00_Training | `src/runtime/training-npc-identities.mjs` | `original-gobjects-20260912-training-start.txt` |
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
