# Map-to-map transitions of the campaign (travel step 5, second part)

2026-10-22. Companion of [travel.md](travel.md) (the chain, the Browse branches, the measured logs): which transitions the installed single-player maps contain, what is special about each
family, what Play does with every one of them, and what was measured against the original. Evidence kinds are those of travel.md: *script source* (`.cache/research/src/<Package>/*.uc`),
*native code* (hash-pinned GOTY DLLs read with `tools/disasm-annotated.py`, addresses are the DLLs' own), *measurement* (the original under Wine, `scripts/travel-probe.sh`; captures in
`.work/travel/<tag>`, outside Git; the step files are `scripts/travel-steps/`).

## What the installed maps contain

`scripts/census-transitions.mjs --plan` decodes every installed map (82 single-player maps; the `DXMP_*` maps and `Entry` are left out) and lists:

| Kind | Count | Notes |
| --- | --- | --- |
| `MapExit` | 47 | 20 with `bPlayTransition` (the camera path of a mission's end), 27 that travel at once (touched, or triggered when `bCollideActors` is false); 4 have no `DestMap` |
| `Teleporter` with a URL | 149 | 144 enabled, 5 disabled in the map (`bEnabled` false: `06_HongKong_TongBase` `lab`, `WanChai_Canal` `alleyin`, `WanChai_Garage` `market04`, `WanChai_Market` `compound`, `WanChai_Underworld` `market03`; no `Event` in any map and no script enables a Teleporter, so they never fire) |
| scripted `SendPlayer` | 2 (+ the endings, credits and `dxonly`, [step 5, first part](travel.md)) | `Mission04.Timer` (the captured player), `Mission11.Timer` (Toby Atanwe's teleport) |

The URL texts have five shapes: `Map#Portal` (164), `Map` (22), `Map.dx` (2: `03_NYC_Airfield` `MapExit0`, `05_NYC_UNATCOIsland` `MapExit1`), `Map.dx#Portal` (1: `14_OceanLab_Lab` `MapExit2`)
and `Map.dx #Portal` with a blank before the `#` (5: `14_OceanLab_Lab` `Teleporter2`, `14_OceanLab_UC` `Teleporter0`, `14_Oceanlab_Silo` `MapExit0`, `14_Vandenberg_Sub` `MapExit2`/`MapExit3`).

Portals that name no Teleporter (a start spot is then the first enabled single-player `PlayerStart`, `Engine/GameInfo.uc:1074..1093`): `02_NYC_BatteryPark` and `04_NYC_BatteryPark` `Teleporter1..3` (`Street#ToStreet`),
`03_NYC_Hangar` `Teleporter10` (`747#747CargoEnt`), `14_Oceanlab_Silo` `MapExit0` (`15_area51_bunker.dx #bunker_start`). The match of a portal against `Tag` is `~=` (case-insensitive).

## The Hong Kong lifts

Hong Kong is the one place where several maps of a mission are joined by `MapExit`s that are *triggered* (`bCollideActors` false), not touched. Each lift cabin holds a pair of `Button1` decorations, `ButtonType`
`BT_Up` (0) and `BT_Down` (1); the button that sends the cabin out of the map has an `Event`, and that event is the `Tag` of a `MapExit` in the same map (`DeusExDecoration.Frob` fires `Event` at every actor with that
tag, `DeusExDecoration.uc:972..974`; `MapExit.Trigger` -> `LoadMap` -> `SendPlayer(Player, DestMap)`, `MapExit.uc:38..42`). The two exits of a map are told apart by their tags, `change_floors` and `change_floors01`.
The links come in mutual pairs, each end an exit in one map that names a `Teleporter` portal in the other (all eight portals exist, matched case-insensitively):

| Map | exit (`Tag`), fired by | `DestMap` | the way back |
| --- | --- | --- | --- |
| `06_HongKong_Helibase` | `MapExit0` (`change_floors`), `Button3` (down) | `06_HongKong_WanChai_Market#cargoup` | Market `MapExit3` (`change_floors`, `Button1`, up) -> `06_HongKong_Helibase#HeliBase` |
| `06_HongKong_WanChai_Market` | `MapExit1` (`change_floors01`), `Button4` (up) | `06_HongKong_VersaLife#lobby` | VersaLife `MapExit2` (`change_floors01`, `Button12`, down) -> `06_HongKong_WanChai_Market#market` |
| `06_HongKong_VersaLife` | `MapExit3` (`change_floors`), `Button8` (down) | `06_HongKong_MJ12lab#cathedral` | MJ12lab `MapExit2` (`change_floors01`, `Button23`, up) -> `06_HongKong_VersaLife#secret` |
| `06_HongKong_MJ12lab` | `MapExit0` (`change_floors`), `Button44` (down) | `06_HongKong_Storage#basement` | Storage `MapExit0` (`change_floors`, `Button1`, up) -> `06_HongKong_MJ12lab#tubeend` |

All eight ends are mission 6 to mission 6, so every lift files the map left in `Save\Current` and restores the map entered when it is filed: the second visit in either direction is the warm
`LoadMap`. The mission's one exit that leaves Hong Kong is a different kind: `Market` `MapExit2` (`outro_trigger`, `bPlayTransition`, camera path `CameraPath`) to `08_NYC_Street`, mission 6 to 8 (no mission 7).
The second exit of a map does nothing the first does not: it is another `MapExit` of the same class with another `Tag`.

**Measured (`tr-a`, `validate-travel-transitions A`).** From the logo map: `Helibase` (`-2` -> `6`, wipe), `Market#cargoup` (`6, 6`: `Helibase` filed), `Helibase#HeliBase` (the filed `Helibase` restored,
`LoadMap: ..\Save\Current\06_HongKong_Helibase.dxs?...#HeliBase`, `Market` filed), `Market#cargoup` again (restored). Play's log lines, travel text (96 records), flags, arrival place and `Current` listing equal the capture's
in all four legs; the first arrival at the Market rests 0.2 units lower in Play than in the original (the fall from the `Teleporter` at z 62.7 settles by the frame times of the fall), the restored arrivals are equal to the last bit.
The Browse line prints the options before the portal, `Browse: 06_HongKong_WanChai_Market?Name=Player?Class=DeusEx.JCDentonMale#cargoup`, as `FURL::String` (Engine.dll `0x103f9210`: map, each option behind a `?`, then `#` and the portal) does.

## The four `MapExit`s without a destination

`00_Intro` `MapExit1` (`bPlayTransition`, camera path `versacam`), `12_Vandenberg_Gas` `MapExit6` and `MapExit7` and `14_Vandenberg_Sub` `MapExit0` (touched, radius 512) hold no `DestMap`. **Nothing sets one at run time**:
`DestMap` is read only by `MapExit.LoadMap` (`MapExit.uc:31,34`; a search of every extracted package finds no other mention, and no conversation or mission script writes it).
`SendPlayer(Player, "")` is `ClientTravel("", TRAVEL_Relative, true)`: `SetClientTravel` stores the empty `TravelURL` and sends `PreTravel` to every actor (the mission script's timer and flags go, `PlayerTraveling` and the
`SKTemp_*` skill flags are set), and then **nothing else happens**: the tick's travel step tests `TravelURL` against `""` with `appStricmp` and skips the whole step (`UGameEngine::Tick` `0x1039088e..0x103908b7`).
With `bPlayTransition` the player first rides the camera path, and `Interpolating.InterpolateEnd` sends the player only `if (NextMap != "")` (`DeusExPlayer.uc:4142..4156`), so the player stays in the `Interpolating` state at the path's end.
**Measured (`tr-a`, leg `a4`):** an empty `LocalTravel` leaves the log without a line, `Save\Current` as it was, the level running, and in the player's flags `PlayerTraveling` and the two `SKTemp_SkillPoints*` Int flags (value 5000, expiration 0)
that `PreTravel` made; Play's flags equal them (`validate-travel-transitions A`, leg 4). Nothing in the map or the scripts fires the intro's exit (no actor holds its tag as an `Event`).

## The URL forms with a map extension and a blank

Eight installed destinations carry the map extension (`Map.dx`, `Map.dx#Portal`, `Map.dx #Portal`: the campaign's way into missions 4, 6, 14 and 15 and around the Ocean Lab). What the original does with them, from the native code
and the capture `tr-c` (`LocalTravel` of each string from the logo map):

* **`FURL::FURL`** (Engine.dll `0x103f7b60`; `FURL::String` is `0x103f9210`). The head of the text ends at the first `?` or `#` (`0x103f803d..0x103f8065`); leading blanks are skipped (`0x103f8029`). If the first `.` of
  the head is followed by `FURL::DefaultMapExt` (`dx`) or `FURL::DefaultSaveExt` (`dxs`) and then a character that is not a letter or a digit (`0x103f8680..0x103f875d`, `appStrnicmp`), the host and port parsing (`/` and `:`)
  is skipped and the head is the map: **the extension and the blank stay in `Map`** (`14_OceanLab_UC.dx ` with its trailing blank; measured `URL.Map` of the arrived level `14_OceanLab_UC.dx `, `04_NYC_UNATCOIsland.dx`, `15_area51_bunker.dx `,
  `Portal` `UC`, ``, `bunker_start`). `String()` prints the map, each option behind a `?`, then `#` and the portal, so the log shows `Browse: 14_OceanLab_UC.dx ?Name=Player?Class=DeusEx.JCDentonMale#UC`.
  Play's `furl.mjs` accepts exactly these heads (`NAME.dx`, `NAME.dx` plus blanks) and still refuses every other path, host or blank by name.
* **The level file** is the map without the extension and the blank: `LoadMap` opens `Maps\14_OceanLab_UC...` (Windows drops the trailing blank), the loaded package is named by the URL's text without them (`Possessed PlayerPawn: JCDentonMale
  14_OceanLab_UC.JCDentonMale2`), and the DeusExLevelInfo's `MapName` names the filed copy. `mapFileStem` (`furl.mjs`) is the file a Play request names.
* **Browse's filed-level lookup** (`DDeusExGameEngine::Browse` `0x100119d7..0x10011a3c`) cuts `nextMap` at the **first `.dx`** with `appStrstr` (case-sensitive) and `FString::Left`, so `14_OceanLab_Lab.dx ` becomes `14_OceanLab_Lab`
  and the filed level is found: measured `LoadMap: ..\Save\Current\14_OceanLab_Lab.dxs?...#Sunkentunnel` for `LocalTravel 14_OceanLab_Lab.dx #Sunkentunnel` after the Lab had been filed. (An earlier port stripped only a trailing `.dx`
  and would have missed the blank.) `travel-browse.mjs` does the same cut.
* **Measured, all five shapes** (`validate-travel-transitions C`): `Map`, `Map.dx`, `Map.dx#Portal`, `Map.dx #Portal` (filed, restored, a mission change) -- the Browse and LoadMap lines, the travel text (96 records), the flags, the arrival
  place and the `Current` listing equal. A portal that names no Teleporter (`15_area51_bunker.dx #bunker_start`: the bunker has no `bunker_start`) starts the player at the first enabled `PlayerStart`, (-1778.6, 1741.0, -192.25) in
  both.

## PreTravel in the missions

`SetClientTravel` sends `PreTravel` to every actor at the moment `ClientTravel` is called, so a mission script sees the level it is leaving as it is (`flags` and `localURL` are set by `InitStateMachine`, which runs in the first
timer, so a level that has not run for a second has neither: the effects below need a level that has ticked).

* **Mission02** (`Mission02.uc:102..127`): leaving `02_NYC_BatteryPark` before `AmbrosiaTagged` and `SubTerroristsDead` are both set makes `MS_MapLeftEarly` (Bool, expiration 3); leaving `02_NYC_Underground` while
  `MS_FordFollowing` is set and `FordSchick_Dead` is not makes `FordSchickRescued` (expiration 9). Both before `Super.PreTravel` (`SetTimer(0, False)`, `flags = None`).
* **Mission08** (`Mission08.uc:42..54`): after `Super.PreTravel`, every `BlackHelicopter` tagged `EntranceCopter` of `08_NYC_Street` is destroyed, so the level is filed without it.
* **Mission10** (`Mission10.uc:57..69`): leaving `10_Paris_Club` after `MeetNicolette_Played` makes `NicoletteLeftClub` (expiration 11).
* Mission04's and Mission11's `Timer`s call `SendPlayer` themselves ([below](#the-scripted-sendplayers)); the other missions call only `Super`.

**Measured (`tr-d`, `validate-travel-transitions D`):** after six seconds in `02_NYC_BatteryPark`, `LocalTravel 02_NYC_Street#ToStreet` arrives with `MS_MapLeftEarly@3`; in `08_NYC_Street` the two `BlackHelicopter` actors are
`BlackHelicopter1` (`EntranceCopter`, path `CopterPath`) and `BlackHelicopter0` (`CopterExit`, hidden until the mission unhides it), and the Street restored after a visit to the Bar holds only `BlackHelicopter0`. Play's flags
and actors equal them. (`tr-b`, the same legs with the levels frozen from their load, shows the no-op: no `MS_MapLeftEarly`, both helicopters.)

## The scripted `SendPlayer`s

* **`Mission04.Timer`** (`Mission04.uc:80..96`), in every map of mission 4: when `TalkedToPaulAfterMessage_Played` is set and the player is in the `Dying` state, it sets `MS_PlayerCaptured` (expiration 5), completes the goal
  `EscapeToBatteryPark` and sends the player to `05_NYC_UNATCOMJ12Lab` (a different mission: the wipe branch). The player is exported while dying: `TravelPostAccept` restores `Health` to the default when it is not positive
  (`Engine/Pawn` `TravelPostAccept`, [travel.md](travel.md#login-and-the-callbacks-of-the-arrival)), so the player arrives walking with 100 health.
* **`Mission11.Timer`** (`Mission11.uc:56..62`), in `11_PARIS_UNDERGROUND`: once `MeetTobyAtanwe_Played` is set (and `MS_PlayerTeleported` is not) it sets `MS_PlayerTeleported` (expiration 12) and sends the player to `11_PARIS_EVERETT` (same
  mission: the Underground is filed, Everett is loaded from its map). `11_Paris_Everett` is the target of nothing else.
Both run as the census drives them: the flag a conversation sets is set through the flag store (and the player is killed by lethal `TakeDamage` for Mission04), then the real `Timer` runs. They were **not measured in the original**:
the conditions are script (Play's VM runs them), the `ClientTravel` they reach is the one `LocalTravel` measured, and the original's conversations that set the flags need a played game.

## The transition census

`node scripts/census-transitions.mjs` (the plan from the installed maps; `--frames 300`; output `.work/census-transitions.json`, outside Git; one Play process per transition, memory-bounded like `validate-load-saves.mjs`,
peak 4.0 GB). For each of the 198 transitions it opens the source level, reaches the exit the way the original's actor does, takes the request the tick's travel step makes, opens the arrival from it, ticks five seconds,
and drives the transition back when the arrival leads to the source map (so the filed level is restored).

* **The source level.** 104 transitions start in the level of a real save slot (the 41 desktop slots of `.work/internet-saves`, loaded with `LoadGame N` as the page does: a full inventory of 23 to 65 items, 24 to 348 flags, filed levels in `Save\Current`);
  93 start cold, where no slot reaches the map (the interiors, Paris, the Ocean Lab, Area 51 Entrance); 1 (the intro's exit) is step 5's. Mission 11 has no slot at all.
* **Reaching the exit.** A `Teleporter`: the player is placed 150 units away and walks into it (121 of 149; the other 28 are `Touch` calls where the walk finds no clear path). A touched `MapExit`: the same walk (4) or the `Touch` call (12).
  A triggered `MapExit`: **the Hong Kong exits are fired by the `Button1` the player frobs through the view trace (8 of 8, and the way back the same)**; the other 22 get the `Trigger` call of the actor that owns their tag in the original
  (a conversation, a `Dispatcher`, a `FlagTrigger`: the owner is named in the record's `firedBy`, from the [Stage 6 inventory](stage-6-inventory.md); a conversation's chain was not played). The two scripted `SendPlayer`s set the flag a
  conversation sets, and Mission04's player is killed by `TakeDamage`.
* **Checks per transition**, independent of Play's own decision: the Browse branch against the mission numbers and the `Save\Current` listing (`wipe` / `fresh-save` / `restore`), the `Current mission number is a, next is b` line, the arrival's place against
  the start spots the portal names (a `Teleporter` with that tag, else the first enabled single-player `PlayerStart`; read before the first tick, because the player may fall), one player pawn, no begin-play pass in a restored level, a sane player state
  (walking, swimming, falling, in a conversation or on a camera path), no import complaint in the log, and the inventory chain before and after.

**Result: 198 of 198 arrive** (143 into a fresh level with the left one filed, 30 into a filed level, 19 mission changes that wipe `Current`, 161 returns into the filed level; 5 exits that make no request on purpose):

| | |
| --- | --- |
| mission changes with a `#portal` | 1 (`14_Oceanlab_Silo` -> `15_area51_bunker.dx #bunker_start`, a portal the bunker does not hold: the first `PlayerStart`) |
| arrivals at the first `PlayerStart` (no portal, or a portal no `Teleporter` names) | 27 |
| `bPlayTransition` exits | 19 ride their camera path to the request (the intro's is step 5's) |
| the five that make no request | `12_Vandenberg_Gas` `MapExit6`/`MapExit7`, `14_Vandenberg_Sub` `MapExit0` (no `DestMap`), and the two disabled Teleporters that were walked into alone (`06_HongKong_TongBase` `lab`, `06_HongKong_WanChai_Underworld` `market03`): `PreTravel` ran, the player walks on. The other three disabled Teleporters stand beside an enabled twin with the same URL, which the walk reached |
| inventory | 187 arrivals: the chain is the same class for class, except Mission04's captured player (42 -> 24 items): `Mission05.FirstFrame` moves 18 items into the `player_inv` spawn points |
| deferred to [step 5, first part](travel.md#play-step-5-first-part-play-intro-credits-dxonly-and-the-endings) | the arrivals at `dx`, `DXOnly` and the three endings (5) and the intro's exit: only the request is checked here |

**The stops the census found, by family** (counts are the transitions affected; both are fixed, and the result above is the run after the fixes):

| Family | Transitions | Cause | Fix |
| --- | --- | --- | --- |
| `FURL::FURL: FURL form is not supported` | 8 (`03_NYC_Airfield` `MapExit0`, `05_NYC_UNATCOIsland` `MapExit1`, `14_OceanLab_Lab` `MapExit2` and `Teleporter2`, `14_OceanLab_UC` `Teleporter0`, `14_Oceanlab_Silo` `MapExit0`, `14_Vandenberg_Sub` `MapExit2` and `MapExit3`); six are the campaign's way into missions 4, 6, 14 and 15 | the map extension and the blank before the `#` ([above](#the-url-forms-with-a-map-extension-and-a-blank)) | `furl.mjs` accepts the pure-filename heads, `mapFileStem` names the file; Browse cuts the filed name at the first `.dx` |
| `Original mesh resource is not prepared: deusexitems.weaponmod` (arrival) | 9 of the 18 transitions that start in the three slots whose player carries a `WeaponMod` (the other nine restore a filed level, which had the mesh) | the travel import spawned the carried item, whose view mesh the pickup path prepares for a map item but the import did not | the importer prepares the view meshes of every `Inventory` class of the text (`prepareItemMeshes`) |

Check artifacts, corrected in the census and not in Play: the arrival read after a second of ticks (the 1600-unit fall of `06_HongKong_WanChai_Garage` `Teleporter0` -> `Storage#BackDoor` had left the start spot, and the original's player falls into the water and swims at
the surface too, measured `tr-e`), and the states a mission start can be in (`AnnaDock` starts by radius three seconds into `02_NYC_BatteryPark`; the Island's exit, Everett's and Toby's arrivals start in conversations).

**What the census does not establish.** The arrival is ticked for five seconds, not played; a conversation's chain to a triggered exit is not played; the camera paths' timing and the exits' physical reach from the arrival are not measured; the
original was measured for the samples below, not for every transition.

## Measured against the original

Five Wine sessions (`scripts/travel-probe.sh`, step files in `scripts/travel-steps/`; the captures are in `.work/travel/tr-a..tr-e`) replayed by `node scripts/validate-travel-transitions.mjs [--only A|B|C|D|E]`, which compares per leg the engine log
(the lines Play models, in order), the exported travel text, the arrived player's flags, location and `Current` listing:

| | Session | Result |
| --- | --- | --- |
| A | Hong Kong lifts: Helibase -> Market#cargoup -> Helibase#HeliBase (restored) -> empty SendPlayer -> Market (restored) | all equal; the empty one leaves `PlayerTraveling` and the `SKTemp_*` flags |
| B | Mission02/08 `PreTravel` on frozen levels, a portal no `Teleporter` names (`02_NYC_Street#ToStreet`), the `08_NYC_Street` <-> `08_NYC_Bar` teleporter pair | all equal: the no-op `PreTravel`, the `PlayerStart` fallback place, the restored Street |
| C | the `.dx` and `.dx #Portal` forms of mission 14 (filed and restored), `15_area51_bunker.dx #bunker_start` (a mission change with a `#portal`), `04_NYC_UNATCOIsland.dx` | all equal |
| D | Mission02/08 `PreTravel` on levels that ran | `MS_MapLeftEarly@3` in the arrival's flags; the filed `08_NYC_Street` holds `BlackHelicopter0` only (the `EntranceCopter` destroyed): equal; texts and flag sets after the first leg are not compared (the captured levels ran for an unmeasured time) |
| E | a start spot 1600 units above water: `06_HongKong_WanChai_Garage` -> `Storage#BackDoor` | the player falls and swims at the surface (Physics 3), z within 8 units of the original's bobbing |

Differences kept, with their reasons: a fresh arrival that falls to the floor rests up to 0.2 units apart (the frame times of the fall); `Warning: skipping N bytes of type 10` counts the size of a struct in the restored file (Play's writer orders the name
table differently from the original's, [travel.md](travel.md#unresolved) 4); the level package's spelling follows the URL text in the original (`14_Oceanlab_silo.JCDentonMale4`) and the file in Play (travel.md 19; step 5's first part has the rule).
The yaw of the player in `02_NYC_BatteryPark` after seconds of running differs because the `AnnaDock` conversation (a radius-140 invocation) turned the player three seconds in under Play's clock, after the capture froze the level.

## Unresolved in this part

1. **The camera paths of the `bPlayTransition` exits** (19): the exit rides the real `Interpolating` state and `InterpolateEnd` to the request in Play; the path's timing and the player's state during it are not measured in the original
   ([travel.md](travel.md#unresolved) 18).
2. **`FURL` with a base that holds options.** `TRAVEL_Relative` copies the base's options except `PUSH`, `POP`, `PEER` and `LOAD` (`0x103f7edb`, shared with `TRAVEL_Partial`), where `furl.mjs` starts from none and appends the `[DefaultPlayer]` options. Equal while the engine's `LastURL` holds
   `Name=Player?Class=...` (every flow measured); after `RestartLevel` the original's next `Browse:` line carried no defaults (capture `s4`), Play's does. Not changed: `LastURL` after a restart is not traced (travel.md 7).
3. **The scripted `SendPlayer`s were not measured in the original**: the conditions are script and the `ClientTravel` is the measured one; the flags that start them need a played game (`EditFlags` is a window).
4. **A triggered exit's owner chain** (a conversation, a `Dispatcher`) is taken from the Stage 6 inventory and not played; the census fires the exit as that actor's `Trigger` would.
5. **Disabled Teleporters.** Three of the five disabled `Teleporter`s with a URL could not be tested alone (an enabled twin with the same URL lies beside them); that a disabled one does not fire is shown by `06_HongKong_TongBase` `lab` and `WanChai_Underworld` `market03` (`Teleporter.Touch`: `if (!bEnabled) return`).
6. **Browser.** One page spec (`browser-tests/transitions.spec.mjs`, the debugging page in worker mode) covers the Hong Kong pair and the `.dx` forms; the other transitions ran in the headless sessions only.

**A harness fault found on the way, not a Play fault.** A first census took the *last* request when the player, still standing in the Teleporter, touched it again in the frames after the first (the level left does not tick again in the page:
`sim-session.mjs` sets `travelled` after the first request), so its walked Teleporter arrivals had lost their flag objects (`PruneTravelActors` had run); the census now ticks one frame at a time and takes the first request, and checks that a same-mission
arrival holds the flags the player had.
