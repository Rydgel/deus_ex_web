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
