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
