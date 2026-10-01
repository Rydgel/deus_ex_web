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

`script-conplay-live.mjs` assigns them (`globalIndex`) when Play starts. A map
without a table plays until its first speech, which stops at "PlaySound
requires the registered global UObject index". Everything else in
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

Repeat the open/dump pair per map in one session (about a minute each with
the 30-second wait; 88 maps in `Maps/`). Restart the game between maps if the
dump of a later map shows objects of the previous one that a fresh open would
not hold (the convention above is a fresh open from the boot map). Not done
yet; the table would grow to one module per map, or one generated module
keyed by map.
