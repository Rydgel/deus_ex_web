# Stage 6 inventory: what the original's data says about every mission of the campaign

Status: read-only inventory (2026-10-22, from master 1510ed8e). It is the input of the Stage 6 exit criteria, the way [the Stage 5 inventory](stage-5-inventory.md) was the input of [Stage 5's](stage-5-exit-criteria.md); nothing here is a Stage 6 claim.
Roadmap section 6 ([roadmap](roadmap.md#6-persist-progress-and-complete-the-campaign)) ends: *the campaign can be completed through representative choices and endings without progression blockers. Validate each mission's conversations, events, and transitions against the original game;
keep a per-mission compatibility checklist.* To say what "representative choices", "progression blocker" and "compatibility checklist" mean per mission, this note lists, for Training, missions 1 to 15, the intro, the endgames and the logo maps: the maps and how the player arrives,
the mission script, the conversations and InfoLinks with their flags, the objectives, the choices that last, the shortest chain of events from arrival to exit, and the real save slots that sit in each mission.

**Sources, all original data.** The installed maps (`Maps/*.dx`, 83 single-player files decoded with Play's own `decodeMap` and the class defaults of `ClassDefaults.forActor`; the 5 `DXMP_*` multiplayer maps are out of scope);
`DeusExConText.u`'s `ConList_Mission00` to `ConList_Mission16`, `98` and `99`, walked ConItem by ConItem with every conversation's event chain; the embedded DeusEx script sources
(`Mission00.uc` to `Mission15.uc`, `MissionIntro.uc`, `MissionEndgame.uc`, `MissionScript.uc`, `FlagTrigger.uc`, `ConPlayBase.uc`, `ScriptedPawn.uc` and the classes named below), read from `.cache/research/src/DeusEx` (not in Git; `file.uc:line` references are lines of those files);
[map travel](travel.md) for the arrival and the flag lifetime; the 41 real save slots of `.work/internet-saves` (SOURCES.md there), read with the repository's `parseSaveInfo` and package reader without modifying them. Nothing was driven in Play and no Wine session was started.
`node scripts/inventory-campaign.mjs conversations|maps|scripts|flags|slots|report` re-extracts everything (output under `.work/campaign-inventory/`, outside Git); `node scripts/inventory-campaign.mjs chain <map> <tag> [depth]` prints the upstream of an event tag
(the exit chains below are its output). The tables of this note are the `report` step's fragments pasted. "Choice" labels a decision of mine; "unverified" marks what the data does not settle.

## How to read the tables

* **Own conversations.** Every `ConList_MissionNN` holds the same 384 shared AI bark conversations (`ConList_Mission16` holds only those) besides its mission's own. All counts below are of the **own** ones; the shared barks are not repeated. The lists exist for 0 to 12, 14, 15, 16, 98 and 99; **there is no list 13 and no mission 13**,
  and **`ConList_Mission07` is an exact duplicate of 06** (680 conversations, same names and ids; no single-player map has `missionNumber` 7), so Hong Kong is counted once, as mission 6. The installed game has no `Mission07.uc` or `Mission13.uc` either.
* **Kinds.** *InfoLink* (`bDataLinkCon`): the DataLink window, started by a `DataLinkTrigger` or a `Mission` script. *Talk*: a conversation with a letterbox or a bump/frob/radius invocation and (usually) choices. *Overheard*: first person and non-interactive (barks and eavesdropping).
  "Owner" is the `BindName` the conversation binds to; the parenthesis names the maps of the mission that hold an actor with that name (`no actor` = none: the owner of every InfoLink is `JCDenton`, the player; `other missions` = the actor exists, in maps of other missions only).
  In the conversation tables: `Sets` are the flags the events set (`=0` sets false, `@label` is the branch), `Needs` are the flags the conversation requires to start (`req`, the `flagRefList`, all of which must hold) or checks (`?`, a `CheckFlag` event); `Goals`: `+P` adds a primary goal, `+S` a secondary,
  `done` completes; `Other`: `trig` fires an event tag, `give`/`take` transfer an item to/from the player, `has?` checks an item, `sp` skill points, `cr` credits. The "Choices" tables show each choice, the block its speech jumps to and what that block (and the blocks it jumps to) does.
* **Slots.** The slot tables list, per real slot, its map, the name it was saved under, the number of saves and the play time, the `bImportant` NPCs whose `_Dead` flags the file holds (a knocked-out one also has `_Unconscious`) and the *carried* lasting-choice flags the file holds
  (`=0` = present with value false), both cumulative: each slot is a start point whose whole state is listed. "Goals still open" are the saved goals not completed (the first five).
* **Required (progression) conversation** (my definition, a choice): a conversation, InfoLink or flag that lies on every chain of the data from the mission's arrival to a `MapExit`/`Teleporter` that leaves it, so that without it the exit actor is never fired or the door never opens. It is read off the
  exit chains (an AND/OR graph: the flags of one conversation are ANDed, the setters of one flag are alternatives; `inventory-campaign.mjs chain`), not played. It does not include the geometry between the player and a door; where the data names only the exit actor ("touch only"), the section says so.
  A **progression blocker** is the first element of that chain that does not happen in a run.
* **Doors ("gates").** The `gates` tables list the `DeusExMover`s that start locked, need a key whose `NanoKey` exists in a map of the game, or are fired by an event; "not frobbable" means the player cannot open it with the use key. A key id with no `NanoKey` actor in any map (for example Training's `FrontDoor`) cannot be satisfied by a placed key
  (a conversation may hand one over: Filben's, Alex Jacobson's). Whether a gate is on the only route needs geometry and is not read here.
* **Evidence.** Facts of the map and conversation data and of the script sources are from the installed files; the flag lifetimes follow [travel](travel.md#playertraveling) and are checked against the 41 real slots (below). Everything that needs a play-through (can the player reach X, does Y happen first) is marked unverified.

## Flag lifetime: the model behind every lasting choice

A flag is created with an expiration: **0 never expires**; omitted (a script's `SetBool(name, True)` or a `FlagTrigger` with `flagExpiration` -1) it is `MissionNumber + 1` of the level that creates it (`MissionScript.InitStateMachine` calls `SetDefaultExpiration(MissionNumber + 1)`);
an explicit fourth argument sets it (`SetBool('PlayerKilledLebedev', True,, 6)`). Entering a level of mission *M* by travel runs `flags.DeleteExpiredFlags(M)` (only when `PlayerTraveling` is set, i.e. not after a load), which removes every flag whose expiration is non-zero and `<= M`.
So **a flag set in mission *S* with expiration *E* is still there in a later mission *R* exactly when `E == 0` or `E > R`.** What the original's own code puts in the store:

* **Conversation `SetFlag` events are all permanent.** All 4,000 `ConFlagRef` objects of `DeusExConText.u` store no `expiration` (checked), and `ConPlayBase.SetFlag` applies `SetExpiration(flag, FLAG_Bool, ref.expiration)` (`ConPlayBase.uc:425-432`): expiration 0. Every flag a conversation sets lasts for the rest of the game
  (until `DeleteAllFlags` in the intro and endgames, or a New Game's `ResetFlags`).
* **`<conversation>_Played`** is set by `ConPlayBase.SetPlayedFlag` at the end of every conversation with the default expiration (mission + 1), unless the flag already exists (`ConPlayBase.uc:318-335`: "some conversations set this intentionally with a longer expiration").
  `<conversation>_Interrupted` likewise (`:366-372`).
* **`<BindName>_Dead` and `<BindName>_Unconscious`** are set by `ScriptedPawn.Died` for every pawn with `bImportant`, with expiration 0 (`ScriptedPawn.uc:8543-8558`); `MissionScript.FirstFrame` then **destroys every important pawn whose `<BindName>_Dead` is set** in every later map (`MissionScript.uc:96-105`).
  This is how a killed Anna, Manderley or Paul stays gone.
* **Scripts and `FlagTrigger`s** use the default or an explicit expiration (the tables name them). Several scripts give their `MS_*` bookkeeping flags the expiration of the *next-but-one* mission (Mission 6's are 8, Mission 8's 9, ...), so they survive the whole mission and its skipped successor.
* `PlayerTraveling` (expiration 0) is the one flag that travels between `PreTravel` and the next level's first `Timer`; [travel](travel.md#playertraveling).

**Checked against the 41 real slots.** The 41 saved `FlagBase`es hold 8,048 flags: 6,518 permanent (81%), 1,391 with the default expiration, 139 with an explicit one; in every slot the stored `defaultFlagExpiration` equals the mission number plus 1 (M1 -> 2, M6 -> 7, M8 -> 9, M12 -> 13, M15 -> 16, ...), and **no saved flag has a non-zero expiration at or below its slot's mission** (0 violations).
The model above is what the original wrote. Counting only conversation-set flags that a later mission reads **while no setter exists in the reader's own mission** gives the 36 *carried* flags of [the choices with lasting consequences](#the-choices-with-lasting-consequences-across-missions); the death flags are a separate table.

## The campaign at a glance

Missions 1 to 15 skip 7 and 13 (no maps, no scripts). Training is entered from the menu; the intro from New Game or the Intro item; the endgames from Area 51. The travel graph of the data (every `MapExit` and `Teleporter` URL of the 83 maps; 18 mission-changing edges):

* `00_TrainingFinal` -> `dx`; `01_NYC_UNATCOIsland` -> `02_NYC_BatteryPark`; `02_NYC_BatteryPark` and `02_NYC_Warehouse` -> `03_NYC_UNATCOIsland`; `03_NYC_Airfield` -> `04_NYC_UNATCOIsland`; `04_NYC_BatteryPark` (two exits at one place) -> `05_NYC_UNATCOMJ12lab`;
  `05_NYC_UNATCOIsland` -> `06_hongkong_helibase`; `06_HongKong_WanChai_Market` -> `08_NYC_Street`; `08_NYC_Street` -> `09_NYC_Dockyard`; `09_NYC_Graveyard` -> `10_Paris_Catacombs`; `10_Paris_Chateau` (a teleporter) -> `11_Paris_Cathedral`;
  `11_Paris_Everett` -> `12_vandenberg_cmd`; `12_Vandenberg_Gas` -> `14_vandenberg_sub`; `14_Oceanlab_Silo` -> `15_area51_bunker`; `15_Area51_Final` -> `99_Endgame1` and `99_Endgame2`; `15_Area51_Page` -> `99_endgame3`.
* **Two travels are not exits of any actor**: `Mission04.Timer` sends a *dying* player to `05_NYC_UNATCOMJ12Lab` (`Mission04.uc:93`), and `Mission11.Timer` sends the player to `11_Paris_Everett` after Toby (`Mission11.uc:61`); `11_Paris_Everett` is the target of nothing else.
* Maps never the target of an exit: `00_Intro`, `11_Paris_Everett` (script), `99_Endgame4`, `DXOnly`, `Entry`. Maps without an exit: the intro, `99_Endgame2/3/4`, `DX`, `DXOnly`, `Entry`; the endgame cinematics end through the credits ([the endgames](#the-intro-the-endgames-and-the-logo-maps-missions-98-99--2--1)).
* Destination strings the engine must resolve as written: `04_NYC_UNATCOIsland.dx`, `06_hongkong_helibase.dx`, `14_Vandenberg_sub.dx#subbay`, `15_area51_bunker.dx #bunker_start` (a space before the `#`), `14_Oceanlab_silo.dx #frontgate`, `14_OceanLab_Lab.dx #Sunkenlab`, `99_endgame3`.

| Mission | Maps | Location (`MissionLocation`) | Script | Arrives from | Leaves to | Real slots |
| --- | --- | --- | --- | --- | --- | --- |
| 0 (Training) | Training, TrainingCombat, TrainingFinal | UNATCO Training Course | Mission00 | the menu: Training button | DX | 0 |
| 1 | NYC_UNATCOHQ, NYC_UNATCOIsland | NYC - UNATCO HQ; NYC - Liberty Island | Mission01 | New Game (the intro, then StartNewGame) | 02_NYC_BatteryPark | 2 |
| 2 | NYC_Bar, NYC_BatteryPark, NYC_FreeClinic, NYC_Hotel, NYC_Smug, NYC_Street, NYC_Underground, NYC_Warehouse | NYC - Underworld Tavern; NYC - Battery Park; NYC - Free Clinic; NYC - 'Ton Hotel; NYC - Smuggler's Lair; NYC - Hell's Kitchen; NYC - New York Sewers; NYC - Warehouse District | Mission02 | 01_NYC_UNATCOIsland | 03_NYC_UNATCOIsland | 2 |
| 3 | NYC_747, NYC_Airfield, NYC_AirfieldHeliBase, NYC_BatteryPark, NYC_BrooklynBridgeStation, NYC_Hangar, NYC_MolePeople, NYC_UNATCOHQ, NYC_UNATCOIsland | NYC - 747 Airplane; NYC - Airfield; NYC - Helibase; NYC - Battery Park; NYC - Brooklyn Bridge; NYC - Hangar; NYC - Mole Tunnels; NYC - UNATCO HQ; NYC - Liberty Island | Mission03 | 02_NYC_BatteryPark; 02_NYC_Warehouse | 04_NYC_UNATCOIsland | 4 |
| 4 | NYC_Bar, NYC_BatteryPark, NYC_Hotel, NYC_NSFHQ, NYC_Smug, NYC_Street, NYC_UNATCOHQ, NYC_UNATCOIsland, NYC_Underground | NYC - Underworld Tavern; NYC - Battery Park; NYC - 'Ton Hotel; NYC - 20th Street Warehouse; NYC - Smuggler's Lair; NYC - Hell's Kitchen; NYC - UNATCO HQ; NYC - Liberty Island; NYC - Sewers | Mission04 | 03_NYC_Airfield | 05_NYC_UNATCOMJ12lab | 2 |
| 5 | NYC_UNATCOHQ, NYC_UNATCOIsland, NYC_UNATCOMJ12lab | NYC - UNATCO HQ; NYC - Liberty Island; Secret MJ12 Facility | Mission05 | 04_NYC_BatteryPark | 06_HongKong_Helibase | 3 |
| 6 | HongKong_Helibase, HongKong_MJ12lab, HongKong_Storage, HongKong_TongBase, HongKong_VersaLife, HongKong_WanChai_Canal, HongKong_WanChai_Garage, HongKong_WanChai_Market, HongKong_WanChai_Street, HongKong_WanChai_Underworld | Hong Kong - MJ12 Helibase; Hong Kong - MJ12 Lab; Hong Kong - Nano Manufacturing; Hong Kong - Tong's Base; Hong Kong - VersaLife; Hong Kong - Waterways; Hong Kong - Canal Road; Hong Kong - Market; Hong Kong - Tonnochi Road; Hong Kong - Lucky Money Club | Mission06 | 05_NYC_UNATCOIsland | 08_NYC_Street | 5 |
| 8 | NYC_Bar, NYC_FreeClinic, NYC_Hotel, NYC_Smug, NYC_Street, NYC_Underground | NYC - Underworld Tavern; NYC - Free Clinic; NYC - 'Ton Hotel; NYC - Smuggler's Lair; NYC - Hell's Kitchen; NYC - Sewers | Mission08 | 06_HongKong_WanChai_Market | 09_NYC_Dockyard | 1 |
| 9 | NYC_Dockyard, NYC_Graveyard, NYC_Ship, NYC_ShipBelow, NYC_ShipFan | NYC - Brooklyn Naval Shipyards; NYC - Lower East Side Cemetary; NYC - Naval Assembly Building and Ship; NYC - Ship Lower Decks; NYC - Naval Assembly Building AC System | Mission09 | 08_NYC_Street | 10_Paris_Catacombs | 5 |
| 10 | Paris_Catacombs, Paris_Catacombs_Tunnels, Paris_Chateau, Paris_Club, Paris_Metro | Paris - Denfert-Rochereau; Paris - Catacombs; Paris - Chateau DuClare; Paris - Nightclub La Porte de l'Enfer; Paris - Near Champs Elysses | Mission10 | 09_NYC_Graveyard | 11_Paris_Cathedral#cathedralstart | 3 |
| 11 | Paris_Cathedral, Paris_Everett, Paris_Underground | Paris - Knights Templar Cathedral; Paris - Morgan Everett's Home; Paris - Metro Station | Mission11 | 10_Paris_Chateau#cathedralstart | 12_Vandenberg_Cmd | 0 |
| 12 | Vandenberg_Cmd, Vandenberg_Computer, Vandenberg_Gas, Vandenberg_Tunnels | Vandenberg - Command; Vandenberg - Computer; Vandenberg - Gas; Vandenberg - Tunnels | Mission12, (none) | 11_Paris_Everett | 14_Vandenberg_Sub | 3 |
| 14 | OceanLab_Lab, OceanLab_UC, Oceanlab_Silo, Vandenberg_Sub | New West Coast - OceanLab; New West Coast - OceanLab UC; New West Coast - Missile Silo; New West Coast - Sub Base | Mission14 | 12_Vandenberg_Gas | 15_Area51_Bunker#bunker_start | 5 |
| 15 | Area51_Bunker, Area51_Entrance, Area51_Final, Area51_Page | Area 51 - Bunker; Area51 - Entrance; Area51 - Final; Area51 - Page | Mission15 | 14_Oceanlab_Silo#bunker_start | 99_Endgame1; 99_Endgame2; 99_Endgame3 | 6 |
| 98 (Intro) | Intro |  | MissionIntro | the menu: New Game or Intro | - | 0 |
| 99 (Endgames) | Endgame1, Endgame2, Endgame3 |  | MissionEndgame | 15_Area51_Final; 15_Area51_Page | - | 0 |

The table's "Arrives from" and "Leaves to" list the exits of other missions (the in-mission edges are in each section). Mission 1's two maps are the reused Liberty Island and UNATCO HQ; missions 2, 4 and 8 reuse the Hell's Kitchen set, and missions 3, 4 and 5 the island/HQ pair, with different content (the mission number selects the conversation list, the script and the flag lifetimes).

## Mission 00: Training (UNATCO Training Course)

Three maps, one script, no objectives, no flags that outlive the mission, no real save slot. The course is the original's own tutorial: 70 InfoLinks in the voice of Jaime Reyes, a
holo-room conversation with Bob Page, and doors that open only when the course says so. [The Stage 5 inventory](stage-5-inventory.md#1-the-training-course-three-maps-one-mission-script)
lists what the course teaches; this section adds the data a Stage 6 row needs (arrival, exit, gates, flags).

### 00.1 Maps and arrival

| Map | Actors | Level info (`MapName`; `MissionLocation`) | Startup text | Script | Arrives from | Leaves to |
| --- | --- | --- | --- | --- | --- | --- |
| `00_Training` | 1308 | 00_training; UNATCO Training Course | UNATCO Training Facilities / Continental United States | Mission00 | 00_TrainingCombat#backtotrainer | 00_TrainingCombat#combat |
| `00_TrainingCombat` | 875 | 00_TrainingCombat; UNATCO Training Course | - | Mission00 | 00_Training#combat; 00_TrainingFinal#backtocombat | 00_Training#backtotrainer; 00_TrainingFinal#stealth |
| `00_TrainingFinal` | 1147 | 00_TrainingFinal; UNATCO Training Course | - | Mission00 | 00_TrainingCombat#stealth | DX; 00_TrainingCombat#backtocombat |

* **How the player arrives.** The main menu's Training button on the logo map calls `ClientTravel("00_Training")` (items on; [travel](travel.md#which-branch-each-single-player-entry-takes): `cur -2`, `next 0`,
  the save directory wiped). Nothing else in the campaign leads here: no exit or teleporter of another mission names a Training map. `DeusExPlayer.uc:1014` is that `SendPlayer(Self, "00_Training")`.
* **Inside the mission.** Three teleporter pairs link the maps (portal names `combat`, `backtotrainer`, `stealth`, `backtocombat`), so a player can go back. The only way out is `00_TrainingFinal`'s
  `MapExit0` (`DestMap dx`, no transition path): the game returns to the logo map, not to a mission. Starting the game proper is the menu's New Game (`DeusExPlayer.uc:988`, Liberty Island).
* **Level info.** `missionNumber` is not stored in the three maps (0 is the property default). Only `00_Training` has a startup text (`UNATCO Training Facilities / Continental United States`); the other two print nothing.
  `00_Training` has `PlayerStart1`; `00_TrainingCombat` and `00_TrainingFinal` have `PlayerStart0`.

| Map | Actor | At | Leads to | Fired by (events targeting its tag) |
| --- | --- | --- | --- | --- |
| `00_TrainingFinal` | MapExit `MapExit0` | 6580,-5924,88 | `dx` | touch |

### 00.2 Mission script `Mission00`

`.cache/research/src/DeusEx/Mission00.uc`, 235 lines; one script for all three maps (the `localURL` of the level picks the branch).

* `FirstFrame` (`:12-40`): `Super.FirstFrame` (`MissionScript.uc:88-131`), then `SkillPointsTotal = SkillPointsAvail = 0` (`:20-21`). In `00_Training` every `UNATCOTroop` tagged `Test_Subject` is knocked out (`Health = 0`,
  `bStunned`, `TakeDamage(1, ..., 'KnockedOut')`, `:23-33`: the cadet to carry to the table). In `00_TrainingCombat` the `LAM`s tagged `Bot1LAM` get the player as owner (`:34-39`).
* `PreTravel` (`:48-51`): `Super` only. No `SendPlayer`, `ClientTravel` or `NextMap` anywhere in the script.
* `Timer` (`:59-188`), per map:
  * `00_Training` (`:71-102`): `MunitionsTrooperReady` set -> `RemoveAllInventory` (`:74-75`, `:190-231`: weapons, ammo, pickups, deactivates scope/laser/charged items); either `Cratepick1`/`Cratepick2` crate gone
    -> `DL_Lockpick` once (`MS_CratesBroken`, `:78-91`); `M00MeetPage_Played` -> `LeaveWorld` on the `BobPage` tagged `holobob` (`:94-101`; **no actor tagged `holobob` exists in the three maps, and `M00MeetPage` plays in
    `00_TrainingFinal`, so this block can never act**: unverified why it is here).
  * `00_TrainingCombat` (`:103-165`): the same inventory removal; no `SecurityBot2` tagged `LAMBot1` left -> `DL_ReleaseBot2` (`:110-121`); none tagged `LAMBot2` -> `DL_DemolitionLast` (`:124-135`); no `LAM` tagged
    `DefuseLAM` left -> `DL_DefuseFinish` (`:138-149`); `DL_RifleRangeShot1_Played` -> `SkillWeaponRifle.CurrentLevel = 3` (`:152-164`, `MS_SkillIncreased`).
  * `00_TrainingFinal` (`:166-187`): `JaimeAppears` -> `EnterWorld` on the `JaimeReyes` tagged `holojaime` (`MS_ReyesUnhidden`); `JaimeBark_Played` -> `LeaveWorld` (`MS_ReyesHidden`).
* Flags read: `MunitionsTrooperReady`, `MS_CratesBroken`, `M00MeetPage_Played`, `MS_PageHidden`, `MS_LAMBot1Destroyed`, `MS_LAMBot2Destroyed`, `MS_LAMsDestroyed`, `DL_RifleRangeShot1_Played`, `MS_SkillIncreased`, `JaimeAppears`,
  `MS_ReyesUnhidden`, `JaimeBark_Played`, `MS_ReyesHidden`. Flags set by the script: the `MS_*` ones. All have the default expiration (mission 1), so none reaches Liberty Island.
* Actors it touches: `Test_Subject`, `Bot1LAM`, `Cratepick1/2`, `LAMBot1/2`, `DefuseLAM`, `holojaime` (destroys nothing, spawns nothing).
* FlagTriggers that feed it: six of them set `MunitionsTrooperReady` (two in `00_Training` at (2950,857,-80) and (4667,-4421,8), four in `00_TrainingCombat`), one sets `JaimeAppears` in `00_TrainingFinal`.

Generated from the script's calls (`inventory-campaign.mjs scripts`; `:N` is the first line):

* **Flags set** (8; `eN` = explicit expiration N, otherwise the default): `MS_CratesBroken` (:89), `MS_PageHidden` (:100), `MS_LAMBot1Destroyed` (:119), `MS_LAMBot2Destroyed` (:133), `MS_LAMsDestroyed` (:147), `MS_SkillIncreased` (:163), `MS_ReyesUnhidden` (:175), `MS_ReyesHidden` (:185).
* **Flags read** (13): `MunitionsTrooperReady`, `MS_CratesBroken`, `M00MeetPage_Played`, `MS_PageHidden`, `MS_LAMBot1Destroyed`, `MS_LAMBot2Destroyed`, `MS_LAMsDestroyed`, `DL_RifleRangeShot1_Played`, `MS_SkillIncreased`, `JaimeAppears`, `MS_ReyesUnhidden`, `JaimeBark_Played`, `MS_ReyesHidden`.
* **InfoLinks it starts**: `DL_Lockpick` (:88), `DL_ReleaseBot2` (:118), `DL_DemolitionLast` (:132), `DL_DefuseFinish` (:146). **Conversations it starts by name**: none. **Goals it completes**: none.
* **Spawns**: none. **Destroy calls**: 1; **EnterWorld/LeaveWorld calls**: 3. **Travel calls**: none.

### 00.3 Conversations and InfoLinks

86 conversations of the mission list that are not among the 384 shared AI barks: 70 InfoLinks, 7 talk-type (the Walton/Manderley/Gunther/Anna bark conversations that every early list carries,
`MunitionsTrooperFrob`, `JaimeBark`, `M00MeetPage`), 9 overheard (first person, non-interactive: `MunitionsTrooperTake`, `LAMBarks`, ...). **No conversation has a choice** (0); one sets a flag
(`MunitionsTrooperTake` clears `MunitionsTrooperReady`); four need a flag (`MunitionsTrooperTake` and `MunitionsTrooperFrob` need `MunitionsTrooperReady`, `DL_StealthAdvice2` needs `DL_FailedStealth_Played`, `DL_lockstr` needs `dl_crate_played`). The InfoLinks are started by `DataLinkTrigger` proximity actors (57 in the three maps) and, for four of them, by `Mission00.Timer`;
12 InfoLinks have no starter in the data (`DL_WelcomeArena`, `DL_Sniping`, `DL_Pistols`, `DL_OutdoorRange`, `DL_NotOutdoor`, `DL_NotArena`, `DL_LAW`, `DL_LAM`, `DL_Golphers`, `DL_GEP`, `DL_EMP`, `DL_Arena`: never played in this
installation's data; unverified that nothing else starts them). 19 InfoLinks end with a `Trigger` event that opens a door or arms a target (the table).

Bound actors: `MunitionsTrooper` (the `UNATCOTroop`s of Training and Combat; the take-your-gear conversation is `bump/frob/radius 350`), `LAMTrooper`, `JaimeReyes` (instructor and `holojaime`), `BobPage` (tag `BobPage2`/`BobPage`),
`PaulDenton`, `AnnaNavarre`, `WaltonSimons`, `JosephManderley`, `GuntherHermann` (the holo-room cast of the identify-the-enemy lessons; their conversations are only barks).

**Conversations that change state** (choices, flags set, goals, items, events, skill points; the `Needs` column is kept on these rows):

| Conversation | Owner (BindName; maps with that actor) | Kind | Choices | Sets | Needs | Goals | Other |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `DL_TargetRangeShot2` | JCDenton | DL once |  |  |  |  | trig gunrangeexit |
| `DL_TargetRangeShot1` | JCDenton | DL once |  |  |  |  | trig shield2 |
| `DL_TargetRange` | JCDenton | DL once |  |  |  |  | trig shield1, trig BallisticStore |
| `DL_RifleRangeShot2` | JCDenton | DL once |  |  |  |  | trig riflerangeexit |
| `DL_RifleRangeShot1` | JCDenton | DL once |  |  |  |  | trig shield4 |
| `DL_RifleRange` | JCDenton | DL once |  |  |  |  | trig shield3, trig BallisticStore2 |
| `DL_ReleaseBot2` | JCDenton | DL once |  |  |  |  | trig LAMDoor, trig LAMstore2 |
| `DL_Releasebot1` | JCDenton | DL once |  |  |  |  | trig shield5 |
| `DL_Pistols` | JCDenton | DL once |  |  |  |  | trig Ballistic2Store |
| `DL_LAW` | JCDenton | DL once |  |  |  |  | trig LAWStore |
| `DL_LAM` | JCDenton | DL once |  |  |  |  | trig LAMStore |
| `DL_GEP` | JCDenton | DL once |  |  |  |  | trig GEPStore |
| `DL_EMP` | JCDenton | DL once |  |  |  |  | trig EMPStore |
| `DL_DestroyObject` | JCDenton | DL once |  |  |  |  | trig ArenaDoors |
| `DL_DemolitionLast` | JCDenton | DL once |  |  |  |  | trig DemolitionExitDoors |
| `DL_DefusingEntry` | JCDenton | DL once |  |  |  |  | trig bd2 |
| `DL_DefuseFinish` | JCDenton | DL once |  |  |  |  | trig BombSquad_DoorExit |
| `DL_CombatEntry` | JCDenton | DL once |  |  |  |  | trig combatentry |
| `DL_Arena` | JCDenton | DL once |  |  |  |  | trig ArenaDoors |
| `MunitionsTrooperTake` | MunitionsTrooper (Training, TrainingCombat) | ovh bump/frob/radius 350 |  | MunitionsTrooperReady=0 | req MunitionsTrooperReady |  | take Multitool, take Lockpick, take WeaponPistol, take WeaponRifle, take WeaponLAM, take WeaponGEPGun, take WeaponLAW, take WeaponEMPGrenade, take WeaponCrowbar, take WeaponCombatKnife, take WeaponProd |
| `LAMBarks` | LAMTrooper (TrainingCombat) | ovh bump/frob/radius 160 |  |  |  |  | give WeaponLAM*4, has? WeaponLAM |

Conversations that only wait for a flag or check one, and change no state (4; `?` = a `CheckFlag` event): `GuntherHermann_BarkFutz` (? GuntherRespectsPlayer), `DL_StealthAdvice2` (DL_FailedStealth_Played), `DL_lockstr` (dl_crate_played), `MunitionsTrooperFrob` (!MunitionsTrooperReady).

Plain InfoLinks, no flag and no event: 49 (listed with their starters in the InfoLink table).

Plain conversations with an actor (7): WaltonSimons: WaltonSimons_BarkAllianceHostile WaltonSimons_BarkAllianceFriendly; GuntherHermann: GuntherHermann_BarkAllianceHostile GuntherHermann_BarkAllianceFriendly; AnnaNavarre: AnnaNavarre_BarkAllianceHostile AnnaNavarre_BarkAllianceFriendly; BobPage: M00MeetPage.

Plain overheard conversations (5): WaltonSimons: WaltonSimons_BarkFutz; JosephManderley: JosephManderley_BarkAllianceHostile JosephManderley_BarkAllianceFriendly; AnnaNavarre: AnnaNavarre_BarkFutz; JaimeReyes: JaimeBark.

InfoLinks and what starts them:

| InfoLink | Started by | Needs | Sets / does |
| --- | --- | --- | --- |
| `DL_WelcomeStealth` | TrainingFinal/DataLinkTrigger29 (-201,-340) |  |  |
| `DL_WelcomeArena` | (none found) |  |  |
| `DL_unatcotroop` | TrainingFinal/DataLinkTrigger15 (6293,-3969) |  |  |
| `DL_unatcobot` | TrainingFinal/DataLinkTrigger16 (6301,-4480) |  |  |
| `DL_tnt` | TrainingFinal/DataLinkTrigger22 (4112,-1295) |  |  |
| `DL_terrorbot` | TrainingFinal/DataLinkTrigger5 (6849,-4481) |  |  |
| `DL_TargetRangeShot2` | TrainingCombat/DataLinkTrigger5 (274,-733) |  | trig gunrangeexit |
| `DL_TargetRangeShot1` | TrainingCombat/DataLinkTrigger4 (253,-690) |  | trig shield2 |
| `DL_TargetRangeIntro` | TrainingCombat/DataLinkTrigger1 (66,-115) |  |  |
| `DL_TargetRange` | TrainingCombat/DataLinkTrigger2 (65,-544) |  | trig shield1, trig BallisticStore |
| `DL_swim` | Training/DataLinkTrigger12 (6538,-4009) |  |  |
| `DL_StealthMaze` | TrainingFinal/DataLinkTrigger0 (19,106) |  |  |
| `DL_StealthComplete` | TrainingFinal/DataLinkTrigger6 (3199,139) |  |  |
| `DL_StealthAdvice4` | TrainingFinal/DataLinkTrigger4 (1560,127) |  |  |
| `DL_StealthAdvice3` | TrainingFinal/DataLinkTrigger30 (1123,111) |  |  |
| `DL_StealthAdvice2` | TrainingFinal/DataLinkTrigger28 (18,346) | DL_FailedStealth_Played |  |
| `DL_StealthAdvice1` | TrainingFinal/DataLinkTrigger2 (503,767) |  |  |
| `DL_Start` | Training/DataLinkTrigger23 (-812,832) |  |  |
| `DL_Sniping` | (none found) |  |  |
| `DL_RifleRangeShot2` | TrainingCombat/DataLinkTrigger10 (1389,-690) |  | trig riflerangeexit |
| `DL_RifleRangeShot1` | TrainingCombat/DataLinkTrigger9 (1350,-662) |  | trig shield4 |
| `DL_RifleRangeIntro` | TrainingCombat/DataLinkTrigger6 (1057,-121) |  |  |
| `DL_RifleRange` | TrainingCombat/DataLinkTrigger8 (1061,-542) |  | trig shield3, trig BallisticStore2 |
| `DL_repairbot` | Training/DataLinkTrigger19 (5109,488) |  |  |
| `DL_ReleaseBot2` | TrainingCombat/DataLinkTrigger17 (1798,1473), Mission00.uc:118 |  | trig LAMDoor, trig LAMstore2 |
| `DL_Releasebot1` | TrainingCombat/DataLinkTrigger16 (1798,1512) |  | trig shield5 |
| `DL_PlaceLam` | TrainingCombat/DataLinkTrigger13 (1818,1689) |  |  |
| `DL_Pistols` | (none found) |  | trig Ballistic2Store |
| `DL_paul` | TrainingFinal/DataLinkTrigger3 (6844,-4994) |  |  |
| `DL_part2` | Training/DataLinkTrigger9 (5465,550) |  |  |
| `DL_OutdoorRange` | (none found) |  |  |
| `DL_ObserveDoors` | TrainingCombat/DataLinkTrigger19 (2987,1298) |  |  |
| `DL_nsf` | TrainingFinal/DataLinkTrigger14 (6840,-3968) |  |  |
| `DL_NotOutdoor` | (none found) |  |  |
| `DL_NotArena` | (none found) |  |  |
| `DL_multitool` | Training/DataLinkTrigger18 (2316,826) |  |  |
| `DL_medbot` | Training/DataLinkTrigger20 (5069,-4054) |  |  |
| `DL_mechagent` | TrainingFinal/DataLinkTrigger17 (6298,-4992) |  |  |
| `DL_lockstr` | Training/DataLinkTrigger25 (1289,143) needs dl_crate_played | dl_crate_played |  |
| `DL_lockpick` | Mission00.uc:88 |  |  |
| `DL_LAW` | (none found) |  | trig LAWStore |
| `DL_LAM` | (none found) |  | trig LAMStore |
| `DL_ladder` | Training/DataLinkTrigger11 (6992,-2363) |  |  |
| `DL_keypad` | Training/DataLinkTrigger7 (1738,853) |  |  |
| `DL_key` | Training/DataLinkTrigger4 (385,849) |  |  |
| `DL_jump` | Training/DataLinkTrigger10 (6991,-55) |  |  |
| `DL_holoroom` | TrainingFinal/DataLinkTrigger1 (6575,-3810) |  |  |
| `DL_holojaime` | TrainingFinal/DataLinkTrigger21 (7044,-4222) |  |  |
| `DL_Golphers` | (none found) |  |  |
| `DL_GEP` | (none found) |  | trig GEPStore |
| `DL_FinishWall` | TrainingCombat/DataLinkTrigger11 (2976,1786) |  |  |
| `DL_final` | TrainingFinal/DataLinkTrigger13 (3581,-482) |  |  |
| `DL_FailedStealth` | TrainingFinal/DataLinkTrigger7 (749,-353) |  |  |
| `DL_F1F2` | Training/DataLinkTrigger1 (381,449) |  |  |
| `DL_EMP` | (none found) |  | trig EMPStore |
| `DL_door` | Training/DataLinkTrigger24 (-310,841) |  |  |
| `DL_DestroyObject` | TrainingCombat/DataLinkTrigger12 (1325,1932) |  | trig ArenaDoors |
| `DL_DemolitionLast` | TrainingCombat/DataLinkTrigger14 (1799,1434), Mission00.uc:132 |  | trig DemolitionExitDoors |
| `DL_Demolition` | TrainingCombat/DataLinkTrigger3 (1951,976) |  |  |
| `DL_DefusingEntry` | TrainingCombat/DataLinkTrigger15 (3785,1769) |  | trig bd2 |
| `DL_DefuseProcess` | TrainingCombat/DataLinkTrigger25 (3784,1425) |  |  |
| `DL_DefuseFinish` | TrainingCombat/DataLinkTrigger27 (3784,1014), Mission00.uc:146 |  | trig BombSquad_DoorExit |
| `DL_dark` | Training/DataLinkTrigger8 (4264,846) |  |  |
| `DL_cratestack` | Training/DataLinkTrigger27 (7064,-1632) |  |  |
| `DL_crate` | Training/DataLinkTrigger31 (1067,128) |  |  |
| `DL_CombatEntry` | TrainingCombat/DataLinkTrigger20 (-382,10) |  | trig combatentry |
| `DL_BreechDoor` | TrainingCombat/DataLinkTrigger7 (3003,1061) |  |  |
| `DL_bodyexit` | Training/DataLinkTrigger32 (3748,443) |  |  |
| `DL_body` | Training/DataLinkTrigger6 (3685,855) |  |  |
| `DL_Arena` | (none found) |  | trig ArenaDoors |

**Required (progression) conversations.** Two doors can only be opened by an InfoLink: `combatentry` (the entry to `00_TrainingCombat`'s ranges, not frobbable, opened by the `Trigger` event at the end of `DL_CombatEntry`,
which `DataLinkTrigger20` starts at (-382,10,-39)) and `BombSquad_DoorExit` (not frobbable, `DL_DefuseFinish`; started by `DataLinkTrigger27` at (3784,1014,-56) or by `Mission00.Timer` when every `DefuseLAM` is gone).
The other doors on the way through the ranges also have a proximity `Trigger` (`gunrangeexit` <- `Trigger1`, `riflerangeexit` <- `Trigger3`, `DemolitionExitDoors` <- `Trigger4`, `bd2` <- `Trigger2`, `StealthEntry` <- `Trigger5/6`,
`demolitionsdoor` <- `Trigger0/7`), so their InfoLinks are not on the minimum chain. The InfoLink-only openers that remain (`BallisticStore`, `ballisticstore2`, `LAMStore2`, the `shield1..6` target shields, `LAMdoor`) guard the weapon stores and targets of the lessons, not the way out. (Data only: whether a player can reach the proximity trigger without the InfoLink is geometry, unverified.)

### 00.4 Objectives

None. The mission list holds no `AddGoal` event, no `AddNote` event, the three maps have no `GoalCompleteTrigger`, and `Mission00` completes no goal. The lessons are InfoLinks (above) and the HUD's goals screen stays empty
(`FirstFrame` still runs `ResetGoals`/`ResetConversationHistory` at `M0MissionStart`). Skill points: `Mission00` zeroes them; the `DL_*` lessons award none (`AddSkillPoints` events in the list: 0).

### 00.5 Choices with lasting consequences

None. Nothing set in Training is read in a later mission: the flags above expire at mission 1, `MunitionsTrooperReady` and the `MS_*` flags are read only here, and the inventory taken by `RemoveAllInventory` is
lost on purpose (the New Game that follows builds its own starting inventory: `StartNewGame`, [travel](travel.md#play-step-2-new-game-and-items)). Training deaths are not recorded either: the `bImportant` pawns here
(`JaimeReyes`, `JosephManderley`, `WaltonSimons`, `PaulDenton`, `AnnaNavarre`, `BobPage`) would set permanent `<BindName>_Dead` flags if killed, but the New Game that follows resets the player and wipes the flag store
(`StartNewGame` -> `ResetPlayer` -> `DeusExRootWindow.ResetFlags`, [travel](travel.md#playertraveling)).

### 00.6 Progression path

From the menu's Training button to the logo map:

1. `00_Training`, arrival at `PlayerStart1` (-1149,826,-65) through the open `UN_maindoor` pair. Gates, in the order the course puts them (data: tag, lock, opener; geometry assumed linear as the
   [authored route](script-training-route.md) walks it): `keydoor` (locked, key `Train` = `NanoKey0` on the desk), `gundoor` (locked, pick strength 0.05; **the maps hold no `Lockpick` actor**, the lockpick comes from a
   `Cratepick` crate, hence `DL_Lockpick`), `paddoor` (locked, not frobbable, `Keypad0` code `0012`, written on `DataCube0`; or hack), `hackdoor` (`Keypad2`, empty code: hack with one of the 3 placed `Multitool`s),
   `bodydoorsopen` (locked, not frobbable, opened by `Trigger0` `OpenDummyDoor`, a class-proximity trigger for the knocked-out cadet carried to the table), then the dark room (`darkdoor`, `darkdoor2`: unlocked),
   the course (`dl_jump`, `dl_ladder`, `dl_cratestack`, `dl_swim`), `Teleporter0` (4801,-4858,8) to `00_TrainingCombat#combat`.
2. `00_TrainingCombat`: `combatentry` <- `DL_CombatEntry` (required, above); range gates `gunrangeexit`, `riflerangeexit`, `demolitionsdoor`, `DemolitionExitDoors`, `bd2`, `BombSquad_DoorExit` (required `DL_DefuseFinish`),
   `StealthEntry`; `Teleporter5` (5184,-254,-56) to `00_TrainingFinal#stealth`.
3. `00_TrainingFinal`: stealth maze (`Switch1` x2 open `FirstStealthDoor`/`SecondStealthDoor`; the `Soldier`s are `bInvincible` and alarms are `AlarmUnit`s), `bridge` (`Keypad1`, code `0089`, hackable), `finaldoorsenter`
   (locked, key `Train`, opened by `Trigger0/1`), the holo room doors (`holodoors`, `holodoor2`, `hd`: key `Train`, unlocked), `MapExit0` (6580,-5924,88) -> `dx`.

| Map | Tag (movers) | Lock | Opened by |
| --- | --- | --- | --- |
| `00_Training` | `paddoor` (2) | locked, not frobbable | Keypad1 Keypad0 |
| `00_Training` | `keydoor` (2) | locked, key Train | frob |
| `00_Training` | `hackdoor` (2) | locked, not frobbable | Keypad1 Keypad2 |
| `00_Training` | `bodydoorsopen` (2) | locked, not frobbable | Trigger Trigger0 |
| `00_Training` | `MedDoor` (1) | locked | frob |
| `00_TrainingCombat` | `combatentry` (2) | unlocked, not frobbable | conversation DL_CombatEntry |
| `00_TrainingCombat` | `BallisticStore` (1) | unlocked, pick 0.20, not frobbable | conversation DL_TargetRange |
| `00_TrainingCombat` | `LAMStore2` (1) | unlocked, not frobbable | conversation DL_ReleaseBot2 |
| `00_TrainingCombat` | `BombSquad_DoorExit` (2) | unlocked, not frobbable | conversation DL_DefuseFinish |
| `00_TrainingCombat` | `bd2` (2) | unlocked, not frobbable | Trigger Trigger2, conversation DL_DefusingEntry |
| `00_TrainingCombat` | `StealthEntry` (1) | unlocked, not frobbable | Trigger Trigger5, Trigger Trigger6 |
| `00_TrainingCombat` | `DeusExMover2` (1) | locked, not frobbable | (nothing found) |
| `00_TrainingCombat` | `DeusExMover3` (1) | locked, not frobbable | (nothing found) |
| `00_TrainingCombat` | `gunrangeexit` (2) | locked, not frobbable | Trigger Trigger1, conversation DL_TargetRangeShot2 |
| `00_TrainingCombat` | `ballisticstore2` (1) | unlocked, pick 0.20, not frobbable | conversation DL_RifleRange |
| `00_TrainingCombat` | `riflerangeexit` (2) | locked, not frobbable | Trigger Trigger3, conversation DL_RifleRangeShot2 |
| `00_TrainingCombat` | `DemolitionExitDoors` (2) | unlocked, not frobbable | Trigger Trigger4, conversation DL_DemolitionLast |
| `00_TrainingCombat` | `demolitionsdoor` (2) | unlocked, not frobbable | Trigger Trigger0, Trigger Trigger7 |
| `00_TrainingCombat` | `guntarget1` (1) | unlocked, pick 0.20, not frobbable | Switch1 Switch3 |
| `00_TrainingCombat` | `guntarget2` (1) | unlocked, pick 0.20, not frobbable | Switch1 Switch13 |
| `00_TrainingCombat` | `rifletarget1` (1) | unlocked, pick 0.20, not frobbable | Switch1 Switch0 |
| `00_TrainingCombat` | `rifletarget2` (1) | unlocked, pick 0.20, not frobbable | Switch1 Switch1 |
| `00_TrainingCombat` | `LAMdoor` (1) | locked, not frobbable | Dispatcher Dispatcher0, conversation DL_ReleaseBot2 |
| `00_TrainingCombat` | `shield5` (1) | unlocked, pick 0.20, not frobbable | conversation DL_Releasebot1 |
| `00_TrainingCombat` | `shield1` (1) | unlocked, pick 0.20, not frobbable | conversation DL_TargetRange |
| `00_TrainingCombat` | `shield2` (1) | unlocked, pick 0.20, not frobbable | conversation DL_TargetRangeShot1 |
| `00_TrainingCombat` | `shield3` (1) | unlocked, pick 0.20, not frobbable | conversation DL_RifleRange |
| `00_TrainingCombat` | `shield4` (1) | unlocked, pick 0.20, not frobbable | conversation DL_RifleRangeShot1 |
| `00_TrainingCombat` | `shield6` (1) | unlocked, pick 0.20, not frobbable | DataLinkTrigger DataLinkTrigger13 |
| `00_TrainingCombat` | `targetblastdoor` (1) | unlocked, pick 0.20 | DirectionalTrigger DirectionalTrigger0, DirectionalTrigger DirectionalTrigger1, DirectionalTrigger DirectionalTrigger2, DirectionalTrigger DirectionalTrigger3 |
| `00_TrainingCombat` | `rifleblastdoor` (1) | unlocked, pick 0.20 | DirectionalTrigger DirectionalTrigger4, DirectionalTrigger DirectionalTrigger5, DirectionalTrigger DirectionalTrigger6, DirectionalTrigger DirectionalTrigger7 |
| `00_TrainingFinal` | `SecondStealthDoor` (1) | unlocked, not frobbable | Switch1 Switch2 |
| `00_TrainingFinal` | `FirstStealthDoor` (1) | unlocked, not frobbable | Switch1 Switch1 |
| `00_TrainingFinal` | `bridge` (1) | unlocked, pick 0.20, not frobbable | Keypad1 Keypad1 |
| `00_TrainingFinal` | `holodoors` (2) | unlocked, key Train | frob |
| `00_TrainingFinal` | `holodoor2` (2) | unlocked, key Train | frob |
| `00_TrainingFinal` | `hd` (2) | unlocked, key Train | frob |
| `00_TrainingFinal` | `DeusExMover35` (1) | unlocked, key Train | frob |
| `00_TrainingFinal` | `DeusExMover36` (1) | unlocked, key Train | frob |
| `00_TrainingFinal` | `SecretDoor` (1) | unlocked, pick 0.20, not frobbable | DeusExMover DeusExMover39, Switch1 Switch3 |
| `00_TrainingFinal` | `door` (2) | unlocked, key Train | frob |
| `00_TrainingFinal` | `finaldoorsenter` (2) | locked, key Train, not frobbable | Trigger Trigger0, Trigger Trigger1 |

(2 further movers of these maps are locked with a pickable lock or breakable, take no key that exists as a placed `NanoKey` and are fired by no event: not listed.)

**Progression blocker (Training).** The run does not reach the next map: a gate above stays closed after its opener fired (the inventory is also taken at each exit by design), or `DL_CombatEntry` /
`DL_DefuseFinish` does not play, or `Teleporter0`/`Teleporter5`/`MapExit0` does not carry the player. A missing lesson (an InfoLink that never plays) is not a blocker.

### 00.7 Slots

None of the 41 real slots is in Training (0). Training is entered from the menu, so a row starts from the Training button, not from a slot.

## Mission 01: Liberty Island and UNATCO HQ (NYC)

Two maps and one script. The player is put on the dock of Liberty Island, meets Paul Denton, takes the Statue from the NSF (the commander is killed or talked down), is debriefed at UNATCO HQ
(the HQ map is reached by a teleporter from the island's west side), and leaves by the police boat at the south dock. The NSF commander's fate, the key from the informant Harley Filben and
the weapon offered to Gunther Hermann are the choices that later missions read.

### 01.1 Maps and arrival

| Map | Actors | Level info (`MapName`; `MissionLocation`) | Startup text | Script | Arrives from | Leaves to |
| --- | --- | --- | --- | --- | --- | --- |
| `01_NYC_UNATCOHQ` | 1474 | 01_NYC_UNATCOHQ; NYC - UNATCO HQ | UNATCO HQ / United Nations Antiterrorist / Coalition | Mission01 | 01_NYC_UNATCOIsland#Inside_UN_HQ | 01_NYC_UNATCOIsland#tunnel_drop_nyc |
| `01_NYC_UNATCOIsland` | 3658 | 01_NYC_UNATCOIsland; NYC - Liberty Island | Liberty Island, New York / UNATCO HQ | Mission01 | 01_NYC_UNATCOHQ#tunnel_drop_nyc | 02_NYC_BatteryPark (path Dock_boatpath); 01_NYC_UNATCOHQ#Inside_UN_HQ |

* **Start of the game.** New Game runs the intro (`00_Intro`, mission 98), then `StartNewGame` -> `SendPlayer(Self, "01_NYC_UNATCOIsland")` (`DeusExPlayer.uc:988`): the player arrives at `PlayerStart0` (-4761,10431,-281) on the dock with the
  starting inventory ([travel](travel.md#play-step-2-new-game-and-items)). The island's `DeusExLevelInfo` startup text is `Liberty Island, New York / UNATCO HQ`; HQ's is `UNATCO HQ / United Nations Antiterrorist / Coalition`.
* **Between the two maps.** Island `Teleporter3` (-3375,704,-536) -> `01_NYC_UNATCOHQ#Inside_UN_HQ`; HQ `Teleporter2` (-2344,1791,582) -> `01_NYC_UNATCOIsland#tunnel_drop_nyc`. Both are touch teleporters; both maps are mission 1,
  so the first leaving files the map in `Save\Current` and the return restores it ([travel](travel.md#which-branch-each-single-player-entry-takes), `next == cur`).
* **Leaving the mission.** `MapExit0` on the island (`bPlayTransition`, camera path `Dock_boatpath`) -> `02_NYC_BatteryPark`; its tag `Dock_boat` is fired only by the `Trigger` event of the conversation `GotoM02` (nothing else in the map targets it).

| Map | Actor | At | Leads to | Fired by (events targeting its tag) |
| --- | --- | --- | --- | --- |
| `01_NYC_UNATCOIsland` | MapExit `MapExit0` | -4779,10346,-206 | `02_NYC_BatteryPark` (path `Dock_boatpath`) | tag `Dock_boat`: conversation GotoM02 |

### 01.2 Mission script `Mission01`

`.cache/research/src/DeusEx/Mission01.uc`, 219 lines; the same script serves both maps.

* `FirstFrame` (`:12-33`): `Super.FirstFrame`; on the island, when `M02Briefing_Played` is set (a return visit after the briefing) it destroys every `PaulDenton`, the `UNATCOTroop` tagged `custodytroop` and the `TerroristCommander` (`:23-31`).
* `PreTravel` (`:41-44`): `Super` only. No `SendPlayer`/`ClientTravel`/`NextMap` in the script.
* `Timer` (`:52-215`):
  * island, `M01PlayerAggressive` not yet set (`:71-92`): counts the `Terrorist`s alive plus the `TerroristCarcass`es (a carcass counts unless `JCDenton` killed it and it is not "Unconscious"); the map starts with 29 `Terrorist` actors and
    one placed `TerroristCarcass` (30), so fewer than 23 means **8 or more lethal kills** -> `SetBool('M01PlayerAggressive', True,, 6)` ("don't expire until mission 6": alive through mission 5, gone on entering mission 6).
  * `TerroristCommander_Dead` set and `MS_DL_Played` not -> `DL_LeaderKilled`, or `DL_LeaderKilledInSpite` when `DL_LeaderNotKilled_Played` (`:95-106`; `MS_DL_Played`, expiration 2).
  * `PlayerAttackedStatueTerrorist` false, `MeetTerrorist_Played` and not `MS_DL2_Played` -> `DL_LeaderNotKilled` (`:109-116`).
  * `StatueMissionComplete` (`:118-198`, once, `MS_MissionComplete`): unlocks `UN_maindoor` (`bLocked = False`, `lockStrength 0`, `Trigger`) and `StatueRuinDoors`/`temp_celldoor` (`:123-135`); in one pass over the `ScriptedPawn`s
    makes the `UNATCOTroop`s `custodytroop` and `postmissiontroops` enter the world, destroys every `ThugMale2`, `SecurityBot3` and the pawn `GuntherHermann` (`Destroy`, not `Died`: no `_Dead` flag), kills every `Terrorist` except the
    commander (health 0, `TakeDamage 'Shot'`, inventory deleted), and moves Paul to the `SpawnPoint` `PaulTeleport` (`:139-181`); destroys `NSFTurret01/02`, the `statue_lasertrap` lasers (`:184-190`) and sets `bNoAlarm` on `NSFCam01..03` (`:193-195`).
  * HQ (`:201-214`): `M01ReadyForBriefing` set and not `MS_ReadyForBriefing` -> `EnterWorld` on Paul.
* Flags read: `M01PlayerAggressive`, `MS_DL_Played`, `TerroristCommander_Dead`, `DL_LeaderNotKilled_Played`, `PlayerAttackedStatueTerrorist`, `MeetTerrorist_Played`, `MS_DL2_Played`, `MS_MissionComplete`, `StatueMissionComplete`, `MS_ReadyForBriefing`,
  `M01ReadyForBriefing`, `M02Briefing_Played`. Flags set: `M01PlayerAggressive` (expiration 6), `MS_DL_Played`, `MS_DL2_Played`, `MS_MissionComplete`, `MS_ReadyForBriefing` (expiration 2).
* Actors it touches: `Terrorist`, `TerroristCarcass`, `DeusExMover` tagged `UN_maindoor`/`StatueRuinDoors`/`temp_celldoor`, `SpawnPoint PaulTeleport`, `AutoTurret NSFTurret01/02`, `LaserTrigger statue_lasertrap`, `SecurityCamera NSFCam01..03`, `PaulDenton`.
* FlagTriggers in the maps: `FlagTrigger0` (`helicopter_launched`), `FlagTrigger2` (`GuntherFreed`, **expiration 12**, fired through `FlagTrigger4`/`guntherdoor` while `StatueMissionComplete` is still false), `FlagTrigger3` (`StatueAlarmTriggered`, from an `AlarmUnit`),
  `FlagTrigger1` (`bTrigger` only, **no `flagName` in the map**: the flag name `MeetTerrorist_Played` sits in its `Tag`; event `DL_LeaderNotKilled`; the test `GetBool(None) == flagValue(true)` cannot pass, so it never fires, and the script's `:109-116` does what it was meant to do).

Generated from the script's calls (`inventory-campaign.mjs scripts`; `:N` is the first line):

* **Flags set** (5; `eN` = explicit expiration N, otherwise the default): `M01PlayerAggressive` e6 (:91), `MS_DL_Played` e2 (:104), `MS_DL2_Played` e2 (:114), `MS_MissionComplete` e2 (:197), `MS_ReadyForBriefing` e2 (:211).
* **Flags read** (12): `M02Briefing_Played`, `M01PlayerAggressive`, `MS_DL_Played`, `TerroristCommander_Dead`, `DL_LeaderNotKilled_Played`, `PlayerAttackedStatueTerrorist`, `MeetTerrorist_Played`, `MS_DL2_Played`, `MS_MissionComplete`, `StatueMissionComplete`, `MS_ReadyForBriefing`, `M01ReadyForBriefing`.
* **InfoLinks it starts**: `DL_LeaderKilled` (:100), `DL_LeaderKilledInSpite` (:102), `DL_LeaderNotKilled` (:113). **Conversations it starts by name**: none. **Goals it completes**: none.
* **Spawns**: none. **Destroy calls**: 8; **EnterWorld/LeaveWorld calls**: 3. **Travel calls**: none.

### 01.3 Conversations and InfoLinks

110 conversations in the mission list besides the 384 shared barks: 28 InfoLinks, 30 talk-type (letterboxed or bump/frob), 52 overheard (first person, non-interactive).
7 have choices (`MeetPaul`, `MeetKaplan`, `MeetCarter`, `MoleConvos`, `MeetFilben`, `MeetTerrorist`, `GuntherRescued`; table below), 23 set flags, 73 need a flag to start
(`flagRefList`), 16 add or complete goals, 14 fire events. The owner column is the `BindName` the conversation binds to; the parenthesis lists the maps of this mission that hold an actor with it
(`no actor` = none in any map: the owner is `JCDenton` for InfoLinks, which the player's own pawn answers).

**Choices.** Every choice that changes state, the block its speech jumps to and what that block does (choices that change no state are counted in one row per conversation):

| Conversation | Owner | Choice | Effects of the branch |
| --- | --- | --- | --- |
| `MeetTerrorist` | TerroristCommander | Except send YOU back to the people -- in a body bag. | -> Aggressive: set PlayerAttackedStatueTerrorist, set StatueMissionComplete, trig TerroristCommanderAttacks |
| `MeetTerrorist` | TerroristCommander | Tell me about the shipment and I'll order the troops to pick you up as | -> Curious: set PlayerAttackedStatueTerrorist=0, set StatueMissionComplete, trig DL_LeaderNotKilled |
| `MeetKaplan` | TechSergeantKaplan | I can't speak for command, but I'm gonna clean the place out. | -> Boss: set KaplanLikesPlayer |
| `MeetKaplan` | TechSergeantKaplan | We're taking a minimum-force approach. We're cops, after all. | -> Pussy: set KaplanLikesPlayer=0 |
| `MeetKaplan` | TechSergeantKaplan | I'll take the scope for 700. [needs !M01BoughtScope, M01CanBuyScope] | -> BuyScope: set M01BoughtScope, give WeaponModScope |
| `MeetKaplan` | TechSergeantKaplan | 200 for 10 mm ammo -- sounds good. [needs !M01Bought10mm, M01CanBuy10mm] | -> Buy10mm: set M01Bought10mm, give Ammo10mm |
| `MeetKaplan` | TechSergeantKaplan | Here's 60 for the tranquilizer darts. [needs !M01BoughtDarts, M01CanBuyDarts] | -> BuyDarts: set M01BoughtDarts, give AmmoDartPoison |
| `MeetKaplan` | TechSergeantKaplan | (4 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `MeetCarter` | SamCarter | A "smart" lock pick is always handy. | -> Picks: set M01CarterDone, give Lockpick, done GetEquippedForNSFPursuit |
| `MeetCarter` | SamCarter | Can you spare a nanotech tech-tool? | -> Tech: set M01CarterDone, give Multitool, done GetEquippedForNSFPursuit |
| `MeetCarter` | SamCarter | Just give me ammo. | -> Ammo: set M01CarterDone, give Ammo10mm, done GetEquippedForNSFPursuit |
| `MeetPaul` | PaulDenton | I like to pick 'em off from a distance. I'll take the rifle. | -> GiveRifle: give WeaponRifle |
| `MeetPaul` | PaulDenton | Never know when I might come up against heavy armor. Give me the GEP g | -> GiveRocket: give WeaponGEPGun, give Image01_LibertyIsland, trig PaulWandering |
| `MeetPaul` | PaulDenton | The crossbow. Sometimes you've got to make a silent takedown. | -> GiveCrossbow: give WeaponMinicrossbow |
| `MoleConvos` | Mole | I'll take the 10 mm clip for 175. [needs !M01MoleBought10mm, M01MoleCanBuy10mm] | -> Buy10mm: set M01MoleBought10mm, give Ammo10mm, trig BumFemaleWanders |
| `MoleConvos` | Mole | Here's 300. Give me the 30.06 ammo. [needs !M01MoleBought3006, M01MoleCanBuy3006] | -> Buy3006: set M01MoleBought3006, give Ammo3006 |
| `MoleConvos` | Mole | I'll give you 50 for the darts. [needs !M01MoleBoughtDarts, M01MoleCanBuyDarts] | -> BuyDarts: set M01MoleBoughtDarts, give AmmoDart, trig BumFemaleWanders |
| `MoleConvos` | Mole | No thanks. | -> bye: trig BumFemaleWanders |
| `MoleConvos` | Mole | (3 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `MeetFilben` | HarleyFilben | You can trust me. | -> GetKeyB: set FilbenGaveKey, give NanoKey, trig HarleyStartsToWander |
| `MeetFilben` | HarleyFilben | I can't promise. In the line of duty I may have to use force. | -> NoKeyB: set FilbenGaveKey=0, trig HarleyStartsToWander |
| `GuntherRescued` | GuntherHermann | As you wish. Take my assault gun. | -> GiveAssault: take WeaponAssaultGun, set GuntherRespectsPlayer, trig GuntherAttacks |
| `GuntherRescued` | GuntherHermann | First thing is to get you out of here. I'll handle the enemy. | -> GiveNothing: set GuntherRespectsPlayer=0 |
| `GuntherRescued` | GuntherHermann | As you wish. Take my stealth pistol. | -> GiveStealth: take WeaponStealthPistol, set GuntherRespectsPlayer, trig GuntherAttacks |
| `GuntherRescued` | GuntherHermann | First thing is to get you out of here. I'll handle the enemy. | -> GiveNothing: set GuntherRespectsPlayer=0 |
| `GuntherRescued` | GuntherHermann | As you wish. Take my pistol. | -> GivePistol: take WeaponPistol, set GuntherRespectsPlayer, trig GuntherAttacks |
| `GuntherRescued` | GuntherHermann | First thing is to get you out of here. I'll handle the enemy. | -> GiveNothing: set GuntherRespectsPlayer=0 |
| `GuntherRescued` | GuntherHermann | As you wish. Take my knife. | -> GiveKnife: take WeaponCombatKnife, set GuntherRespectsPlayer, trig GuntherAttacks |
| `GuntherRescued` | GuntherHermann | First thing is to get you out of here. I'll handle the enemy. | -> GiveNothing: set GuntherRespectsPlayer=0 |
| `GuntherRescued` | GuntherHermann | Wish I could help, but I'm not very well armed myself. | -> GiveNothingNicely: set GuntherRespectsPlayer, trig GuntherAttacks |
| `GuntherRescued` | GuntherHermann | First thing is to get you out of here. I'll handle the enemy. | -> GiveNothing: set GuntherRespectsPlayer=0 |

**Conversations that change state** (choices, flags set, goals, items, events, skill points; the `Needs` column is kept on these rows):

| Conversation | Owner (BindName; maps with that actor) | Kind | Choices | Sets | Needs | Goals | Other |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `DL_WarmCold` | JCDenton | DL |  | M01WarmCold=0@Cold, M01WarmCold@Warm | req !MeetJacobson_Played, ? !M01WarmCold |  |  |
| `DL_StartGame` | JCDenton | DL once |  |  |  |  | trig PaulRunningToPlayer |
| `DL_Office` | JCDenton | DL once |  | PlayerKnowsUNATCOLogin@NoLogin | ? !MeetJanice_Played | +note |  |
| `DL_NearTop` | JCDenton | DL once |  | KnowsShipment |  |  |  |
| `DL_MissedManderley` | JCDenton | DL once |  | M01JaimeCarterGoalsSet | req !M01JaimeCarterGoalsSet | +P GetEquippedForNSFPursuit, +P MedicalCheckup |  |
| `DL_LeaderNotKilled` | JCDenton | DL once |  |  | req StatueMissionComplete, req !TerroristCommander_Dead | +P ReportToBase |  |
| `DL_LeaderKilledInSpite` | JCDenton | DL once |  | StatueMissionComplete | ? !DL_LeaderNotKilled_Played | +P ReportToBase |  |
| `DL_LeaderKilled` | JCDenton | DL once |  | StatueMissionComplete@Start | ? DL_LeaderNotKilled_Played | +P ReportToBase, done DefeatNSFCommandCenter, done RescueAgent, done MeetFilben |  |
| `DL_FrontEntrance` | JCDenton | DL once |  | PlayerEnteredStatue | req !PlayerEnteredStatue |  |  |
| `DL_BackEntrance` | JCDenton | DL once |  | PlayerEnteredStatue | req !PlayerEnteredStatue |  |  |
| `DL_AnnaIntro` | JCDenton | DL once |  |  | req !MeetJaime_Played, req !MeetManderley_Played | +S MeetPartner |  |
| `Trooper2Barks` | Trooper2 (NYC_UNATCOHQ) | ovh bump/frob/radius 100 |  | Trooper2FamiliarName@A1 | ? Trooper2FamiliarName |  |  |
| `MeetTerrorist` | TerroristCommander (NYC_UNATCOIsland) | talk bump/frob/radius 140 once | 2 | PlayerAttackedStatueTerrorist@Aggressive, StatueMissionComplete@Aggressive, PlayerAttackedStatueTerrorist=0@Curious, StatueMissionComplete@Curious |  | done DefeatNSFCommandCenter, done RescueAgent, done MeetFilben | trig TerroristCommanderAttacks, trig DL_LeaderNotKilled |
| `MeetKaplan` | TechSergeantKaplan (NYC_UNATCOIsland) | talk bump/frob/radius 100 | 9 | KaplanLikesPlayer@Boss, KaplanLikesPlayer=0@Pussy, M01CanBuy10mm=0@ChoiceStart, M01CanBuyDarts=0@ChoiceStart, M01CanBuyScope=0@ChoiceStart, M01KaplanDone@Done, M01BoughtScope@BuyScope, M01Bought10mm@Buy10mm (+4 more) | req !M01KaplanDone, ? MeetKaplan_Played, ? StatueMissionComplete, ? M01Bought10mm, ? M01BoughtDarts, ? M01BoughtScope, ? KaplanLikesPlayer, ? !KaplanLikesPlayer, ? M02Briefing_Played, ? M01PlayerAggressive | +note | give WeaponModScope, give Ammo10mm, give AmmoDartPoison, has? WeaponRifle, cr -960 |
| `BathroomBarks` | Shannon (NYC_UNATCOHQ) | ovh bump/frob/radius 100 |  | BathroomBarks_Played |  |  |  |
| `MeetCarter` | SamCarter (NYC_UNATCOHQ) | talk radius 160 | 3 | M01GotStealth, M01CarterDone@Picks, M01CarterDone@Tech, M01CarterDone@Ammo, M01ReadyForBriefing@SetFlag, M01GotStealth@Stealth2 | req !M01CarterDone, ? MeetCarter_Played, ? !TerroristCommander_Dead, ? TerroristCommander_Unconscious, ? MeetJaime_Played, ? MeetKaplan_Played, ? !M01GotStealth | done GetEquippedForNSFPursuit, +P Briefing | give WeaponStealthPistol, give Lockpick, give Multitool, give Ammo10mm |
| `PaulDockChat2` | PaulDenton (NYC_UNATCOHQ, NYC_UNATCOIsland) | talk frob once |  |  | req !StatueMissionComplete, req PaulDockChat1_Played |  | trig PaulWandering |
| `PaulDockChat1` | PaulDenton (NYC_UNATCOHQ, NYC_UNATCOIsland) | talk frob once |  |  | req !StatueMissionComplete, req MeetPaul_Played |  | trig PaulWandering |
| `PaulCongratulations` | PaulDenton (NYC_UNATCOHQ, NYC_UNATCOIsland) | talk radius 160 once |  |  | req StatueMissionComplete, req !M01ReadyForBriefing, ? DL_LeaderNotKilled_Played, ? TerroristCommander_Dead, ? !TerroristCommander_Unconscious, ? DL_LeaderKilled_Played, ? PlayerAttackedStatueTerrorist (+2 more) | +P ReportToManderley, done ReportToBase, done RescueAgent, done MeetFilben | trig PaulWandering |
| `MeetPaul` | PaulDenton (NYC_UNATCOHQ, NYC_UNATCOIsland) | talk bump/frob/radius 180 once | 3 |  | req !StatueMissionComplete | +P DefeatNSFCommandCenter, +S RescueAgent, +S MeetFilben | trig PaulWandering, give WeaponRifle, give WeaponGEPGun, give WeaponMinicrossbow, give Image01_LibertyIsland |
| `GotoM02` | NYPoliceBoat (NYC_UNATCOIsland) | ovh bump/frob/radius 240 |  |  | req M02Briefing_Played | done GetToDock | trig Dock_boat |
| `MoleConvos` | Mole (NYC_UNATCOIsland) | talk bump/frob | 7 | KnowsShipment@Continue, M01MoleCanBuy10mm=0@ChoiceStart, M01MoleCanBuyDarts=0@ChoiceStart, M01MoleCanBuy3006=0@ChoiceStart, MoleDone@Done, M01MoleBought3006@Buy3006, M01MoleBought10mm@Buy10mm, M01MoleBoughtDarts@BuyDarts (+3 more) | req !MoleDone, req !StatueMissionComplete, ? MoleConvos_Played, ? KnowsShipment, ? M01MoleBought10mm, ? M01MoleBoughtDarts, ? M01MoleBought3006, ? StatueMissionComplete |  | trig BumFemaleWanders, give Ammo3006, give Ammo10mm, give AmmoDart, cr -525 |
| `MeetManderley` | JosephManderley (NYC_UNATCOHQ) | talk bump/frob/radius 160 once |  | M01JaimeCarterGoalsSet@goodbye2, CustodyChastise@CustodyContinue | req !M01ReadyForBriefing, ? !TerroristCommander_Dead, ? TerroristCommander_Unconscious, ? MeetCarter_Played, ? MeetJaime_Played, ? CustodyTroop_Dead, ? !CustodyChastise, ? M01JaimeCarterGoalsSet (+2 more) | done ReportToBase, done ReportToManderley, +S MedicalCheckup, +S GetEquippedForNSFPursuit |  |
| `M02Briefing` | JosephManderley (NYC_UNATCOHQ) | talk sight/radius 240 once |  | M01JumpHack@Chastise | req M01ReadyForBriefing, ? GuntherFreed, ? TerroristCommander_Dead, ? !TerroristCommander_Unconscious, ? !CustodyChastise, ? CustodyTroop_Dead, ? BathroomBarks_Played | done ReportToBase, done ReportToManderley, done Briefing, +P GetToDock | trig PaulWandering, cr 4100 |
| `Prebriefing` | JaniceReed (NYC_UNATCOHQ) | ovh bump/frob/radius 100 |  | PlayerKnowsUNATCOLogin@FirstVisit | req !M02Briefing_Played, req M01ReadyForBriefing, ? Prebriefing_Played, ? !MeetJanice_Played | +note |  |
| `MeetJanice` | JaniceReed (NYC_UNATCOHQ) | talk bump/frob/radius 100 once |  | PlayerKnowsUNATCOLogin@Common | req !MeetManderley_Played, ? TerroristCommander_Dead, ? CustodyTroop_Dead, ? PlayerKnowsUNATCOLogin | +note |  |
| `MeetJaime` | JaimeReyes (NYC_UNATCOHQ) | talk bump/frob/radius 100 once |  | M01ReadyForBriefing@SetFlag, M01ReadyForBriefing@SetFlag2 | ? !MeetAnna_Played, ? M01CarterDone | done MedicalCheckup, +P Briefing, +S MeetPartner | has? AugmentationCannister |
| `MeetFilbenAfterStatue` | HarleyFilben (NYC_UNATCOIsland) | talk bump/frob/radius 60 once |  | M01PlayerMetFilben, PlayerMetFilben | req !M01PlayerMetFilben, req StatueMissionComplete |  | trig HarleyStartsToWander |
| `MeetFilben2` | HarleyFilben (NYC_UNATCOIsland) | talk bump/frob once |  |  | req !StatueMissionComplete, req MeetFilben_Played, ? FilbenGaveKey |  | trig HarleyStartsToWander |
| `MeetFilben` | HarleyFilben (NYC_UNATCOIsland) | talk bump/frob/radius 60 once | 2 | M01PlayerMetFilben, PlayerMetFilben, FilbenGaveKey=0@NoKeyB, FilbenGaveKey@GetKeyB | req !StatueMissionComplete | done MeetFilben | trig HarleyStartsToWander, give Image01_TerroristCommander, give NanoKey, sp 150 |
| `GuntherRescued` | GuntherHermann (NYC_UNATCOHQ, NYC_UNATCOIsland) | talk bump/frob/radius 70 once | 10 | GuntherRespectsPlayer@GiveSpeech, GuntherRespectsPlayer=0@GiveNothing, GuntherRespectsPlayer@GiveNothingNicely | req GuntherFreed, req !StatueMissionComplete | done RescueAgent | trig GuntherAttacks, take WeaponPistol, take WeaponStealthPistol, take WeaponAssaultGun, take WeaponCombatKnife, has? WeaponAssaultGun, has? WeaponStealthPistol, has? WeaponPistol, has? WeaponCombatKnife, sp 150 |
| `MeetAnna` | AnnaNavarre (NYC_UNATCOHQ) | talk bump/frob/radius 160 once |  |  | ? GuntherRespectsPlayer, ? !MeetManderley_Played, ? !MeetJaime_Played, ? !MeetCarter_Played, ? !M02Briefing_Played, ? !GuntherFreed, ? GuntherFreed, ? !GuntherRespectsPlayer | done MeetPartner | trig GuntherWanders, trig AnnaWanders |
| `TerroristsOverheard` | Amos (NYC_UNATCOIsland) | ovh radius 350 once |  | KnowsShipment |  |  |  |

Conversations that only wait for a flag or check one, and change no state (57; `?` = a `CheckFlag` event): `GuntherHermann_BarkFutz` (? GuntherRespectsPlayer), `DL_SeePeople` (? !MeetJaime_Played, ? !MeetCarter_Played, ? !M02Briefing_Played), `DL_RedHot` (!MeetJacobson_Played), `DL_MissedPaul` (!MeetPaul_Played), `DL_MissedHermann` (? GuntherFreed), `DL_lightningemp` (!StatueMissionComplete), `DL_libertyruinsairshaft` (!StatueMissionComplete), `DL_LeaveDockNoGun` (MeetPaul_Played, !DL_MissedPaul_Played), `DL_lasertrigger` (!StatueMissionComplete, !GuntherFreed, !StatueAlarmTriggered), `DL_HermannGone` (StatueMissionComplete, !GuntherFreed, !PaulCongratulations_Played), `DL_Hermann` (!StatueMissionComplete), `DL_gameplayintro` (!StatueMissionComplete), `DL_FrontEntranceBot` (!StatueMissionComplete, ? StatueMissionComplete), `DL_barge` (!StatueMissionComplete), `UNATCOTroopSecondBarks` (StatueMissionComplete), `UNATCOTroopInitialBarks` (!StatueMissionComplete), `TerroristStatueBarks` (TerroristFollowup2_Played), `TerroristFollowup2` (TerroristFollowup_Played), `TerroristFollowup` (MeetTerrorist_Played), `TopTerroristsOverheard` (? StatueAlarmTriggered (+1 more)), `KaplanOutsideBarks` (!StatueMissionComplete (+2 more)), `KaplanFinalBarks` (StatueMissionComplete, M01KaplanDone, ? KaplanLikesPlayer), `KaplanDefaultBarks` (StatueMissionComplete, M01KaplanDone), `ScottBarks` (ScottWelcome_Played (+1 more)), `CarterBarks` (M01CarterDone), `TrooperCongratulation` (? GuntherFreed (+1 more)), `LloydBarks` (TrooperCongratulation_Played (+1 more)), `postmissiontroopsssecure` (!M02Briefing_Played (+3 more)), `postmissiontroopsluck` (M02Briefing_Played), `PaulWaitingOutside` (PaulCongratulations_Played (+1 more)), `PaulFinalBark` (M02Briefing_Played), `PaulDockBarks` (PaulDockChat2_Played (+1 more)), `JustArrived` (!StatueMissionComplete), `BoatWaitingForBriefing` (StatueMissionComplete (+1 more)), `MoleNotMet` (!MoleConvos_Played (+1 more)), `MoleJump` (MoleConvos_Played, StatueMissionComplete, !MoleDone), `MoleBarks` (MoleDone), `ManderleyWaiting` (MeetManderley_Played (+1 more)), `ManderleyBarks` (M02Briefing_Played (+1 more)), `PreMeeting` (MeetJanice_Played (+1 more)), `JaniceFinalBarks` (M02Briefing_Played), `JaniceBarks` (!M02Briefing_Played (+2 more)), `JaimeBarks` (DatalinkBriefing_Played (+2 more)), `DatalinkBriefing` (MeetJaime_Played), `FilbenSecondBark` (!StatueMissionComplete (+2 more)), `FilbenFinalBark` (StatueMissionComplete (+5 more)), `GuntherTrappedBarks` (!GuntherFreed (+1 more)), `GuntherOverheard` (StatueMissionComplete), `GuntherHQBarks` (StatueMissionComplete (+1 more)), `GuntherAttackingBarks` (!StatueMissionComplete (+2 more)), `CustodyTroopBarks` (? TerroristCommander_Dead), `CollinsExpos` (MeetPaul_Played, !StatueMissionComplete, ? GuntherFreed), `CollinsDockBarks3` (StatueMissionComplete), `CollinsDockBarks2` (CollinsExpos_Played), `CollinsDockBarks` (!MeetPaul_Played (+2 more)), `AnnaBarks` (MeetAnna_Played, ? !MeetJaime_Played (+2 more)), `JacobsonBarks` (MeetJacobson_Played).

Plain InfoLinks, no flag and no event: 4 (listed with their starters in the InfoLink table).

Plain conversations with an actor (7): WaltonSimons: WaltonSimons_BarkAllianceHostile WaltonSimons_BarkAllianceFriendly; GuntherHermann: GuntherHermann_BarkAllianceHostile GuntherHermann_BarkAllianceFriendly; AnnaNavarre: AnnaNavarre_BarkAllianceHostile AnnaNavarre_BarkAllianceFriendly; AlexJacobson: MeetJacobson.

Plain overheard conversations (9): WaltonSimons: WaltonSimons_BarkFutz; JosephManderley: JosephManderley_BarkAllianceHostile JosephManderley_BarkAllianceFriendly; AnnaNavarre: AnnaNavarre_BarkFutz; Trooper3: Trooper3Barks; Trooper1: Trooper1Barks; Terrorist3: Terrorist3Overheard; Scott: ScottWelcome; MichaelBerry: BerryBarks.

InfoLinks and what starts them:

| InfoLink | Started by | Needs | Sets / does |
| --- | --- | --- | --- |
| `DL_WarmCold` | NYC_UNATCOHQ/DataLinkTrigger17 (1101,-285) | !MeetJacobson_Played, !M01WarmCold | set M01WarmCold=0, set M01WarmCold |
| `DL_Top` | NYC_UNATCOIsland/DataLinkTrigger12 (2864,-91) |  |  |
| `DL_StartGame` | NYC_UNATCOIsland/DataLinkTrigger0 (-4336,10355) |  | trig PaulRunningToPlayer |
| `DL_SeePeople` | (none found) | !MeetJaime_Played, !MeetCarter_Played, !M02Briefing_Played |  |
| `DL_SeeManderley` | NYC_UNATCOHQ/DataLinkTrigger16 (-1443,311) |  |  |
| `DL_RedHot` | NYC_UNATCOHQ/DataLinkTrigger14 (1430,-501) | !MeetJacobson_Played |  |
| `DL_Office` | NYC_UNATCOHQ/DataLinkTrigger0 (-213,1126) | !MeetJanice_Played | set PlayerKnowsUNATCOLogin |
| `DL_NearTop` | NYC_UNATCOIsland/DataLinkTrigger5 (2776,-32) |  | set KnowsShipment |
| `DL_MissedPaul` | NYC_UNATCOIsland/DataLinkTrigger8 (-2329,7504) | !MeetPaul_Played |  |
| `DL_MissedManderley` | NYC_UNATCOHQ/DataLinkTrigger1 (-370,-436), NYC_UNATCOHQ/DataLinkTrigger4 (-193,-345) | !M01JaimeCarterGoalsSet | set M01JaimeCarterGoalsSet, +goal GetEquippedForNSFPursuit, +goal MedicalCheckup |
| `DL_MissedHermann` | NYC_UNATCOIsland/DataLinkTrigger10 (3154,248) | GuntherFreed |  |
| `DL_lightningemp` | NYC_UNATCOIsland/DataLinkTrigger17 (7538,-3210) | !StatueMissionComplete |  |
| `DL_LibHead` | NYC_UNATCOIsland/DataLinkTrigger15 (5598,123) |  |  |
| `DL_libertyruinsairshaft` | NYC_UNATCOIsland/DataLinkTrigger19 (2362,-675), NYC_UNATCOIsland/DataLinkTrigger20 (3546,-1116), NYC_UNATCOIsland/DataLinkTrigger21 (3452,-1579) | !StatueMissionComplete |  |
| `DL_LeaveDockNoGun` | NYC_UNATCOIsland/DataLinkTrigger2 (-2368,7522) | MeetPaul_Played, !DL_MissedPaul_Played |  |
| `DL_LeaderNotKilled` | NYC_UNATCOIsland/DataLinkTrigger7 (2887,39), Mission01.uc:113 | StatueMissionComplete, !TerroristCommander_Dead | +goal ReportToBase |
| `DL_LeaderKilledInSpite` | NYC_UNATCOIsland/DataLinkTrigger25 (2948,34), Mission01.uc:102, jump from DL_LeaderKilled | !DL_LeaderNotKilled_Played | set StatueMissionComplete, +goal ReportToBase |
| `DL_LeaderKilled` | NYC_UNATCOIsland/DataLinkTrigger18 (2904,91), Mission01.uc:100, jump from DL_LeaderKilledInSpite | DL_LeaderNotKilled_Played | set StatueMissionComplete, +goal ReportToBase, done DefeatNSFCommandCenter, done RescueAgent, done MeetFilben |
| `DL_lasertrigger` | NYC_UNATCOIsland/DataLinkTrigger16 (1837,-571) needs !DL_MissedHermann_played | !StatueMissionComplete, !GuntherFreed, !StatueAlarmTriggered |  |
| `DL_HermannGone` | NYC_UNATCOIsland/DataLinkTrigger1 (1770,-1388) needs DL_MissedHermann_played | StatueMissionComplete, !GuntherFreed, !PaulCongratulations_Played |  |
| `DL_Hermann` | NYC_UNATCOIsland/DataLinkTrigger4 (1754,-1404) needs !DL_MissedHermann_played | !StatueMissionComplete |  |
| `DL_GateEntrance` | NYC_UNATCOIsland/DataLinkTrigger11 (-3880,1993) |  |  |
| `DL_gameplayintro` | NYC_UNATCOIsland/DataLinkTrigger13 (-2346,6054) | !StatueMissionComplete |  |
| `DL_FrontEntranceBot` | NYC_UNATCOIsland/DataLinkTrigger22 (-1030,167) needs !StatueMissionComplete, NYC_UNATCOIsland/DataLinkTrigger23 (-2362,154) (+1 more) | !StatueMissionComplete, StatueMissionComplete |  |
| `DL_FrontEntrance` | NYC_UNATCOIsland/DataLinkTrigger9 (-1438,136) | !PlayerEnteredStatue | set PlayerEnteredStatue |
| `DL_barge` | NYC_UNATCOIsland/DataLinkTrigger14 (2710,-6010) | !StatueMissionComplete |  |
| `DL_BackEntrance` | NYC_UNATCOIsland/DataLinkTrigger6 (6028,-2457) | !PlayerEnteredStatue | set PlayerEnteredStatue |
| `DL_AnnaIntro` | NYC_UNATCOHQ/DataLinkTrigger2 (12,692), NYC_UNATCOHQ/DataLinkTrigger3 (13,945) | !MeetJaime_Played, !MeetManderley_Played | +goal MeetPartner |

**Required (progression) conversations**, from the chain read off the data (`inventory-campaign.mjs chain 01_NYC_UNATCOIsland Dock_boat`):
`GotoM02` (the police boat's conversation; needs `M02Briefing_Played`) <- `M02Briefing` (Manderley, `sight/radius 240`; needs `M01ReadyForBriefing`) <- `MeetJaime` and `MeetCarter`, whichever plays second (each
sets `M01ReadyForBriefing` only after the other has set `MeetJaime_Played`/`M01CarterDone`: `MeetJaime` checks `M01CarterDone`, `MeetCarter` checks `MeetJaime_Played`). The commander's fate is required in the sense that one of `MeetTerrorist` (either choice),
`DL_LeaderKilled` or `DL_LeaderKilledInSpite` must set `StatueMissionComplete`, which `Mission01.Timer` needs to unlock `UN_maindoor`. `MeetPaul`, `MeetFilben` and `GuntherRescued` are not required by any flag on the way to the exit.

### 01.4 Objectives

| Goal | Kind | Text | Added by | Completed by |
| --- | --- | --- | --- | --- |
| `GetEquippedForNSFPursuit` | primary | See Sam Carter for equipment. | DL_MissedManderley, MeetManderley | MeetCarter |
| `MedicalCheckup` | primary | See Jaime Reyes for a medical exam. | DL_MissedManderley, MeetManderley | MeetJaime |
| `ReportToBase` | primary | Report to headquarters on the west side of the island for a debriefing. | DL_LeaderNotKilled, DL_LeaderKilledInSpite, DL_LeaderKilled | PaulCongratulations, MeetManderley, M02Briefing |
| `DefeatNSFCommandCenter` | primary | The NSF seem to be directing the attack from the Statue. Get inside and locate the threat. | MeetPaul | DL_LeaderKilled, MeetTerrorist |
| `RescueAgent` | secondary | One of UNATCO's top agents is being held inside the Statue. Break him out, and he'll back you up against the NSF. | MeetPaul | DL_LeaderKilled, MeetTerrorist, PaulCongratulations, GuntherRescued |
| `MeetFilben` | secondary | Meet UNATCO informant Harley Filben at the North Docks. He has a key to the Statue doors. | MeetPaul | DL_LeaderKilled, MeetTerrorist, PaulCongratulations, MeetFilben |
| `MeetPartner` | secondary | Go to the break room on Level 2 and check in with your partner, Agent Anna Navarre. | DL_AnnaIntro, MeetJaime | MeetAnna |
| `Briefing` | primary | Go to Manderley's office on Level 2 for the mission briefing. | MeetCarter, MeetJaime | M02Briefing |
| `ReportToManderley` | primary | Report to Manderley's office on Level 2. | PaulCongratulations | MeetManderley, M02Briefing |
| `GetToDock` | primary | Go to the South Dock and take the police boat to Manhattan. | M02Briefing | GotoM02 |

Notes added by conversations: `DL_Office`, `Prebriefing` and `MeetJanice` add a data-vault note (the UNATCO login); `SkillAwardTrigger`s: 7 on the island (115+25+50+750+250+150+50 = 1,390 points, the 750 one is the `Critical Location Bonus` at the
Statue's top) and 4 in HQ (400 points). Carried goals: `GetToDock` is the last primary goal; goals that are neither completed nor primary are deleted by the next mission's `ResetGoals` (`DeusExPlayer.uc:8656`).

### 01.5 Choices with lasting consequences

Flags set here and still alive in a later mission (the expiration model: [flags](#flag-lifetime-the-model-behind-every-lasting-choice)):

| Flag | Set here by | Expires | Read later by |
| --- | --- | --- | --- |
| `BathroomBarks_Played` | conversation BathroomBarks; played BathroomBarks | never; mission 2 | M3 checks in M03ShannonBarks; M4 checks in M04ShannonBarks |
| `FilbenGaveKey` | conversation MeetFilben@NoKeyB (=0); conversation MeetFilben@GetKeyB | never | M3 checks in M03MeetFilben; M3 checks in FilbenAngryBarks |
| `GuntherFreed` | trigger 01_NYC_UNATCOIsland/FlagTrigger2 | mission 12 | M11 checks in M11MeetGunther |
| `GuntherRespectsPlayer` | conversation GuntherRescued@GiveSpeech; conversation GuntherRescued@GiveNothing (=0); conversation GuntherRescued@GiveNothingNicely | never | M11 checks in M11MeetGunther; M2 checks in GuntherHermann_BarkFutz; M3 checks in GuntherHermann_BarkFutz; M3 checks in TroopBarks2 |
| `M01PlayerAggressive` | script Mission01.Timer:91 | mission 6 | M2 checks in PaulLeaving; M3 checks in TroopBarks2; M3 checks in TroopBarks1 |
| `M01PlayerMetFilben` | conversation MeetFilbenAfterStatue; conversation MeetFilben | never | M3 checks in M03MeetFilben |
| `PlayerMetFilben` | conversation MeetFilbenAfterStatue; conversation MeetFilben | never | M4 checks in M04MeetFilben |

* **The commander lives or dies** (`MeetTerrorist`: "Except send YOU back..." sets `PlayerAttackedStatueTerrorist` and `StatueMissionComplete` and fires `TerroristCommanderAttacks` (an `OrdersTrigger`: he attacks); "Tell me about the shipment..." leaves him alive,
  `DL_LeaderNotKilled`). Both set `StatueMissionComplete`. `TerroristCommander_Dead` / `_Unconscious` are permanent and are read in mission 3 (see the table of who can die).
* **Filben's key** (`MeetFilben`: "You can trust me." gives the `NanoKey` and sets `FilbenGaveKey`; "I can't promise..." sets it false): read in mission 3 by `M03MeetFilben` and `FilbenAngryBarks` (his attitude).
* **Gunther** (`GuntherRescued`: handing over his gun/knife/pistol sets `GuntherRespectsPlayer`; refusing sets it false; "Wish I could help, but I'm not very well armed myself" sets it true) and `GuntherFreed` (expiration 12, from the island's `FlagTrigger2`): `M11MeetGunther` in Paris reads both; mission 2 and 3 barks read `GuntherRespectsPlayer`.
* **Aggression** (`M01PlayerAggressive`, expiration 6): UNATCO troop barks in missions 2 and 3 and `PaulLeaving` (mission 2).
* Pawns that can die here and never return if they do (the table of who can die lists every mission): `PaulDenton`, `JosephManderley`, `SamCarter`, `JaimeReyes`, `JaniceReed`, `GuntherHermann`, `AnnaNavarre`, `Shannon`, `AlexJacobson`, `PrivateLloyd`, `CorporalCollins`,
  `custodytroop`, `TerroristCommander` (all `bImportant`; HQ's NPCs are `bInvincible` in the map).

### 01.6 Progression path

1. Island, `PlayerStart0`. `DL_StartGame` (proximity, once) starts and fires `PaulRunningToPlayer`; `MeetPaul` (bump/frob/radius 180, once; 3 choices of weapon, adds `DefeatNSFCommandCenter`, `RescueAgent`, `MeetFilben`) is not on the chain, only `DL_MissedPaul`/`DL_LeaveDockNoGun` remind.
2. Reach the Statue and make `StatueMissionComplete` true: `MeetTerrorist` (commander, radius 140) either branch, or kill him (`Mission01.Timer` -> `DL_LeaderKilled`). Gates on the way, from the map (not exhaustive; geometry not checked): the Statue ruins
   (`StatueRuinDoors` x4 and `temp_celldoor`, key `ruin_key`, pick strength 0.10; the key that matches is **probably** the `NanoKey` Filben hands over: the decoded map does not show his `InitialInventory`, unverified), `DeusExMover1/0/2/5/13` (locked, pickable 0.40/0.10, breakable), the `commvan_door` (keypad `0451`, hackable) and the electricity/laser/turret systems.
3. `Mission01.Timer` (`StatueMissionComplete`, on its next tick) unlocks and opens `UN_maindoor` and clears the Statue's defences; Paul is moved to `PaulTeleport`.
4. `Teleporter3` to HQ (`Inside_UN_HQ`). In HQ: `MeetJaime` and `MeetCarter` (both; the second sets `M01ReadyForBriefing`), then `M02Briefing` with Manderley.
5. `Teleporter2` back to the island (`tunnel_drop_nyc`), walk to the police boat: `GotoM02` (radius 240) fires `Dock_boat`; `MapExit0` plays the camera path `Dock_boatpath` and the engine calls `SendPlayer(..., "02_NYC_BatteryPark")` (mission 2 by travel, the flag store trimmed: `DeleteExpiredFlags(2)`).

| Map | Tag (movers) | Lock | Opened by |
| --- | --- | --- | --- |
| `01_NYC_UNATCOHQ` | `alexcloset` (1) | locked, pick 0.25, not frobbable | Keypad2 Keypad1 |
| `01_NYC_UNATCOHQ` | `DeusExMover20` (1) | locked | frob |
| `01_NYC_UNATCOHQ` | `cannotopen` (1) | locked | frob |
| `01_NYC_UNATCOHQ` | `UN_blastdoor` (1) | unlocked, not frobbable | RetinalScanner RetinalScanner0, Button1 Button0 |
| `01_NYC_UNATCOHQ` | `UN_blastdoor2` (1) | locked, not frobbable | (nothing found) |
| `01_NYC_UNATCOIsland` | `commvan_door` (1) | locked | Keypad1 Keypad0, Switch2 Switch0 |
| `01_NYC_UNATCOIsland` | `temp_celldoor` (1) | locked, pick 0.10, breakable 0.75 | DeusExMover DeusExMover8, script Mission01:131 |
| `01_NYC_UNATCOIsland` | `UN_maindoor` (2) | locked | Switch1 Switch2, script Mission01:125 |
| `01_NYC_UNATCOIsland` | `fork` (1) | unlocked, pick 0.20, not frobbable | Button1 Button2 |
| `01_NYC_UNATCOIsland` | `StatueRuinDoors` (4) | locked, pick 0.10 | script Mission01:131 |

Key doors (a placed `NanoKey` opens them, or the lock is picked; frob only): `UNOfficeDoorKey` x3, `UNcloset` x2, `JaimeClosetKey`, `UNhatchdoor`.

(8 further movers of these maps are locked with a pickable lock or breakable, take no key that exists as a placed `NanoKey` and are fired by no event: not listed.)

**Progression blocker (mission 1).** The first of these not happening: `StatueMissionComplete` never set (and so `UN_maindoor` stays locked); `MeetJaime` or `MeetCarter` not completing; `M02Briefing` not playing;
`GotoM02` not firing `Dock_boat`; `MapExit0` not loading `02_NYC_BatteryPark`.

### 01.7 Slots

| Slot | Map | Saved as | Saves, play time | Important NPCs dead or knocked out (all) | Lasting-choice flags in the file (all) | Goals still open |
| --- | --- | --- | --- | --- | --- | --- |
| N0001 | `01_NYC_UNATCOIsland` | NYC - Liberty Island | 17, 22 min | - | FilbenGaveKey, M01PlayerMetFilben, PlayerMetFilben | DefeatNSFCommandCenter, RescueAgent |
| N0002 | `01_NYC_UNATCOIsland` | NYC - Liberty Island | 42, 54 min | - | FilbenGaveKey, GuntherFreed, GuntherRespectsPlayer=0, M01PlayerMetFilben, PlayerMetFilben | DefeatNSFCommandCenter |

N0001 is the Statue not yet taken, Filben's key given; N0002 is later: Gunther freed and refused (`GuntherRespectsPlayer=0`), `RescueAgent` and `MeetFilben` done. Neither slot is HQ or the end of the island, so `StatueMissionComplete` has to be
reached by the row. HQ itself has no slot.

## Mission 02: Battery Park and Hell's Kitchen (NYC)

Eight maps joined by a hub: `02_NYC_Street` holds 24 teleporters (to the bar, clinic, hotel, smuggler's lair, sewers, warehouse alley and Battery Park, plus the portals the others return to) and a `MapExit` to the warehouse roof. The player arrives by the police boat at Battery Park, clears
the subway of NSF and hostages, reports to Paul at the Street's barricade, finds the NSF's generator in the warehouse district (the bar and the clinic are where the locals say so), blows it, and is taken out by the boat or the
helicopter. It is the first mission with real side objectives (the hotel hostages, a pimp, Ford Schick in the sewers) and the first whose small decisions are read later.

### 02.1 Maps and arrival

| Map | Actors | Level info (`MapName`; `MissionLocation`) | Startup text | Script | Arrives from | Leaves to |
| --- | --- | --- | --- | --- | --- | --- |
| `02_NYC_Bar` | 492 | 02_NYC_Bar; NYC - Underworld Tavern | - | Mission02 | 02_NYC_Street#ToBarBackEntrance/ToBarFrontEntrance x2 | 02_NYC_Street#FromBarBackEntrance/FromBarFrontEntrance x2 |
| `02_NYC_BatteryPark` | 1994 | 02_NYC_BatteryPark; NYC - Battery Park | New York City, Battery Park | Mission02 | 01_NYC_UNATCOIsland (path Dock_boatpath); 02_NYC_Street#ToBatteryPark x3 | 03_NYC_UNATCOIsland; 02_NYC_Street#ToStreet x3 |
| `02_NYC_FreeClinic` | 542 | 02_NYC_FreeClinic; NYC - Free Clinic | - | Mission02 | 02_NYC_Street#FromStreet | 02_NYC_Street#FromClinic |
| `02_NYC_Hotel` | 909 | 02_NYC_Hotel; NYC - 'Ton Hotel | - | Mission02 | 02_NYC_Street#ToHotelFrontDoor/ToHotelBedroom x2 | 02_NYC_Street#BedroomWindow/FromHotelFrontDoor x2 |
| `02_NYC_Smug` | 539 | 02_NYC_Smug; NYC - Smuggler's Lair | - | Mission02 | 02_NYC_Street#ToSmugFrontDoor/ToSmugBackDoor x2 | 02_NYC_Street#FromSmugBackDoor/FromSmugFrontDoor x2 |
| `02_NYC_Street` | 2064 | 02_NYC_Street; NYC - Hell's Kitchen | New York City, Hell's Kitchen | Mission02 | 02_NYC_Bar#FromBarBackEntrance/FromBarFrontEntrance x2; 02_NYC_BatteryPark#ToStreet x3; 02_NYC_FreeClinic#FromClinic; 02_NYC_Hotel#BedroomWindow/FromHotelFrontDoor x2; 02_NYC_Smug#FromSmugBackDoor/FromSmugFrontDoor x2; 02_NYC_Underground#FromNYCUndergroundSewer2/FromNYCSump x2; 02_NYC_Warehouse#FromRoofTop/FromWarehouseAlley x2 | 02_NYC_Warehouse#ToRoofTop/ToWarehouseAlley x2; 02_NYC_Smug#ToSmugFrontDoor/ToSmugBackDoor x2; 02_NYC_Bar#ToBarBackEntrance/ToBarFrontEntrance x2; 02_NYC_Hotel#ToHotelFrontDoor/ToHotelBedroom x2; 02_NYC_FreeClinic#FromStreet; 02_NYC_BatteryPark#ToBatteryPark x3; 02_NYC_Underground#ToNYCUndergroundSewer2/ToNYCSump x2 |
| `02_NYC_Underground` | 826 | 02_NYC_Underground; NYC - New York Sewers | - | Mission02 | 02_NYC_Street#ToNYCUndergroundSewer2/ToNYCSump x2 | 02_NYC_Street#FromNYCUndergroundSewer2/FromNYCSump x2 |
| `02_NYC_Warehouse` | 2131 | 02_NYC_Warehouse; NYC - Warehouse District | - | Mission02 | 02_NYC_Street#ToRoofTop/ToWarehouseAlley x2 | 03_NYC_UNATCOIsland (path CameraPath); 02_NYC_Street#FromRoofTop/FromWarehouseAlley x2 |

* **Arrival.** `01_NYC_UNATCOIsland` `MapExit0` (transition `Dock_boatpath`) -> `02_NYC_BatteryPark`, no portal: the player is placed at `PlayerStart5` (-620,-3679,255). Mission 1 -> 2 changes `missionNumber`, so `Save\Current` is wiped and the flag store trimmed (`DeleteExpiredFlags(2)`).
* **Inside the mission** everything goes through the Street: Battery Park's three subway teleporters (-5430, y 2735/3035/3538) and the Street's three (1983, y -745/-443/65) join the two; the bar, hotel, smuggler's lair and warehouse alley each have two teleporters to the Street; the clinic and sewers (two hatches) one or two. Leaving by a
  teleporter between two maps of the mission files the map left and restores it on return.
* **Leaving.** (a) `02_NYC_BatteryPark` `MapExit0` (no transition) -> `03_NYC_UNATCOIsland`, tag `Boat_Exit`, fired only by `BoatLeaving` (the police boat's conversation, which needs `GeneratorBlown`). (b) `02_NYC_Warehouse` `MapExit0`
  (touch, radius 100 at (-384,-155,991) on the roof; transition `CameraPath`) -> `03_NYC_UNATCOIsland`; the `BlackHelicopter` tagged `Helicopter` parks at (-222,-295,1133) and `Mission02.Timer` unhides it (with Gunther) only after `GeneratorBlown`.

| Map | Actor | At | Leads to | Fired by (events targeting its tag) |
| --- | --- | --- | --- | --- |
| `02_NYC_BatteryPark` | MapExit `MapExit0` | -421,-3827,278 | `03_NYC_UNATCOIsland` | tag `Boat_Exit`: conversation BoatLeaving |
| `02_NYC_Street` | MapExit `MapExit0` | 446,4635,-833 | `02_NYC_Warehouse#ToRoofTop` | tag `ToWarehouse`: Button1 Button3 |
| `02_NYC_Warehouse` | MapExit `MapExit0` | -384,-155,991 | `03_NYC_UNATCOIsland` (path `CameraPath`) | touch |
| `02_NYC_Warehouse` | MapExit `MapExit1` | -678,3108,1604 | `02_NYC_Street#FromRoofTop` | tag `ToStreet`: Button1 Button0 |

Event chains behind each tagged exit (read off the data, `inventory-campaign.mjs chain`):

**02_NYC_BatteryPark MapExit0 -> 03_NYC_UNATCOIsland** (tag `Boat_Exit`)

```text
event Boat_Exit
  conversation event Trigger "Boat_Exit" in BoatLeaving
    conversation BoatLeaving [ovh bump/frob; owner NYPoliceBoat]
      starts: its actor (bump/frob)
      flag GeneratorBlown: set by trigger 02_NYC_Warehouse/FlagTrigger0
        event Debris
          (in 02_NYC_Warehouse)
          BreakableWall BreakableWall2 (Event) tag Generator
            event Generator
```

**02_NYC_Street MapExit0 -> 02_NYC_Warehouse#ToRoofTop** (tag `ToWarehouse`)

```text
event ToWarehouse
  Button1 Button3 (Event)
```

**02_NYC_Warehouse MapExit0 -> 03_NYC_UNATCOIsland**

Touch only: no event source in the data; what keeps the player from the actor is geometry (doors, locks) and is not read here.

**02_NYC_Warehouse MapExit1 -> 02_NYC_Street#FromRoofTop** (tag `ToStreet`)

```text
event ToStreet
  Button1 Button0 (Event)
```

### 02.2 Mission script `Mission02`

`.cache/research/src/DeusEx/Mission02.uc`, 446 lines, one script for all eight maps (`localURL` picks the branch).

* `FirstFrame` (`:12-94`): in the Street, `M02StreetLoaded` (expiration 3); if `WarehouseDistrictEntered` and the street is not yet open or the clinic not cleared, the `ClinicGuards`/`HotelGuards` `UNATCOTroop`s go `Wandering` (`MS_GuardsWandering`, `:24-40`);
  `M02ManderleyDisappointed` (expiration 3) when `BatteryParkComplete` is false (**`BatteryParkComplete` is read here and set nowhere in the data**, so `M02ManderleyDisappointed` is always set; unverified that nothing else sets it); `MeetSandraRenton_Played` destroys the `SandraRenton` pawn in the Street (`:50-55`);
  `EscapeSuccessful` brings the hostage bums (`hostageMan`, `hostageWoman`) into the Street (`:58-67`). Bar: `MeetSandraRenton_Played` -> Sandra `EnterWorld` (`MS_SandraInBar`). Smuggler's lair: `FordSchickRescued` -> Ford `EnterWorld` and `SchickThankedPlayer` (default expiration, `:85-92`).
* `PreTravel` (`:102-127`): leaving Battery Park without `AmbrosiaTagged` or without `SubTerroristsDead` sets `MS_MapLeftEarly` (expiration 3; Anna's `AnnaDock`/`AnnaThanks` need it false); leaving the sewers with `MS_FordFollowing` and `FordSchick` alive sets
  **`FordSchickRescued` with expiration 9** (`:119-123`). **`MS_FordFollowing` is set nowhere** (not in this script, not in any conversation event, not by a FlagTrigger, not in any other package's script source): the exp-9 branch cannot run from the data
  (unverified that no native code sets it), and the Underground's own `FlagTrigger0` sets `FordSchickRescued` with the default expiration 3, which `DeleteExpiredFlags(3)` removes on entering mission 3.
* `Timer` (`:135-442`), per map:
  * Battery Park: `BatteryParkSlaughter` (expiration 6) when 3 or fewer of the `Terrorist`s/unconscious carcasses tagged `ClintonTerrorist` remain (`:158-180`; the `ClintonGuard`s go `Wandering`); `SubTerroristsDead` (expiration 6) when no `SubTerrorist` is
    left (`GoalCompleted('LiberateBatteryParkSubway')`, `SubGuards` wander, `:183-197`); `HostagesKilled` (expiration 3) when both `SubHostageMale_Dead` and `SubHostageFemale_Dead`; `DL_SubwayComplete3`/`2`/`DL_SubwayComplete` by the combination of
    `SubTerroristsDead`, `EscapeSuccessful`, `HostagesKilled` once (`MS_DL_Played`, `:208-229`); `ShantyTownSecure` when no `ShantyTerrorists` is left.
  * Street: `ClinicCleared` / `StreetOpened` (expiration 6) when the `ClinicTerrorist` / `StreetTerrorist` tags are empty (the `ClinicGuards` / `HotelGuards` wander); `TenderloinSlaughter` (expiration 6) when 3 or more `StreetTerrorist` carcasses were killed (not knocked out) by the player (`:262-286`);
    `MS_ThugsDead` / `AlleyBumRescued`; `SandrasPimpDone` and `GoalCompleted('HelpJaneysFriend')` when the `Pimp` is gone; `MS_SandraDead` when no `SandraRenton` pawn is left (`:322-333`); `OverhearAlleyThug_Played` fires the `ThugAttacks` actors.
  * Warehouse: `GeneratorBlown` and `DL_Pickup_Played` not yet -> `DL_Pickup`, the helicopter and Gunther enter the world (`MS_GeneratorStuff`, `:348-363`).
  * Free clinic: the sick bum leaves when `Doctor2_Saved` (`SickBum1` goes to `SickBumDestination`); Bar: `M02ViolenceInBar` (expiration 4) once any `DeusExCarcass` exists in the bar; Hotel: `M02HostagesRescued` when no `SecondFloorTerrorist` is left;
    Underground: `FordSchickRescueDone` (expiration 9) when `FordSchick_Dead` (so the smuggler can say so).
* Flags it sets that outlive the mission: `BatteryParkSlaughter`, `SubTerroristsDead`, `ClinicCleared`, `StreetOpened`, `TenderloinSlaughter` (6); `M02ViolenceInBar` (4); `FordSchickRescued`, `FordSchickRescueDone` (9). The rest have expiration 3 (mission 3 deletes them).
* Actors it touches: `Terrorist`/`TerroristCarcass` by tag, `UNATCOTroop` guards by tag, `ThugMale`/`ThugMale2`/`BumMale` by tag, `SandraRenton`, `BlackHelicopter`, `GuntherHermann`, `Doctor`, `BumMale SickBum1`, `FordSchick`.

Generated from the script's calls (`inventory-campaign.mjs scripts`; `:N` is the first line):

* **Flags set** (27; `eN` = explicit expiration N, otherwise the default): `M02StreetLoaded` e3 (:20), `MS_GuardsWandering` e3 (:39), `M02ManderleyDisappointed` e3 (:46), `MS_SandraInBar` e3 (:78), `SchickThankedPlayer` (:91), `MS_MapLeftEarly` e3 (:112), `FordSchickRescued` e9 (:122), `BatteryParkSlaughter` e6 (:178), `SubTerroristsDead` e6 (:196), `HostagesKilled` e3 (:204), `MS_DL_Played` e3 (:216), `ShantyTownSecure` (:239), `ClinicCleared` e6 (:257), `StreetOpened` e6 (:274), `TenderloinSlaughter` e6 (:285), `AlleyBumRescued` e3 (:301), `MS_ThugsDead` e3 (:303), `SandrasPimpDone` e3 (:316), `MS_SandraDead` e3 (:330), `MS_ThugAttacks` e3 (:341), `MS_GeneratorStuff` e3 (:361), `MS_BumRemoved` e3 (:375), `MS_BumLeaving` e3 (:387), `MS_BumTurned` e3 (:402), `M02ViolenceInBar` e4 (:416), `M02HostagesRescued` e3 (:431), `FordSchickRescueDone` e9 (:439).
* **Flags read** (36): `MS_GuardsWandering`, `WarehouseDistrictEntered`, `StreetOpened`, `ClinicCleared`, `M02ManderleyDisappointed`, `BatteryParkComplete`, `MeetSandraRenton_Played`, `EscapeSuccessful`, `FordSchickRescued`, `MS_MapLeftEarly`, `AmbrosiaTagged`, `SubTerroristsDead`, `MS_FordFollowing`, `FordSchick_Dead`, `BatteryParkSlaughter`, `HostagesKilled`, `SubHostageMale_Dead`, `SubHostageFemale_Dead`, `MS_DL_Played`, `ShantyTownSecure`, `MS_ThugsDead`, `SandrasPimpDone`, `MS_SandraDead`, `OverhearAlleyThug_Played`, `MS_ThugAttacks`, `MS_GeneratorStuff`, `DL_Pickup_Played`, `GeneratorBlown`, `MS_BumLeaving`, `MS_BumRemoved`, `Doctor2_Saved`, `SickBumInterrupted_Played`, `MS_BumTurned`, `M02ViolenceInBar`, `M02HostagesRescued`, `FordSchickRescueDone`.
* **InfoLinks it starts**: `DL_SubwayComplete3` (:215), `DL_SubwayComplete2` (:220), `DL_SubwayComplete` (:226), `DL_Pickup` (:353). **Conversations it starts by name**: none. **Goals it completes**: `LiberateBatteryParkSubway` (:195), `HelpJaneysFriend` (:317).
* **Spawns**: none. **Destroy calls**: 2; **EnterWorld/LeaveWorld calls**: 6. **Travel calls**: none.

### 02.3 Conversations and InfoLinks

193 conversations of the list besides the shared barks: 21 InfoLinks, 64 talk-type, 108 overheard. 19 have choices (shops and bartering dominate:
`Doctor1Barter`, `MeetSmuggler` (the 3-item vending), `JordanSheaConvos`, `MeetPimp`, `MeetJosh`, `MeetJock`/`JockSecondStory`, `MeetSally2`, `CounselWorker`, `MeetJoeGreen2`, `UNATCOGrenade1Meet`, `SickBum1Interrupted`, `MeetFordSchickQuestion`, `MeetSickWoman(2)`),
46 set flags, 131 need a flag, 20 add or complete goals, 14 fire events.

**Choices.** Every choice that changes state, the block its speech jumps to and what that block does (choices that change no state are counted in one row per conversation):

| Conversation | Owner | Choice | Effects of the branch |
| --- | --- | --- | --- |
| `Doctor1Barter` | Doctor1 | I'll take a medkit. [needs CanAffordMedkit, CanAffordBots] | -> Medkit: give MedKit |
| `Doctor1Barter` | Doctor1 | All I can afford is a medkit. [needs !CanAffordBots, CanAffordMedkit] | -> Medkit: give MedKit |
| `Doctor1Barter` | Doctor1 | I want the full program. [needs CanAffordBots] | -> Full: set BoughtClinicPlan |
| `Doctor1Barter` | Doctor1 | Sure. | -> Medkit: give MedKit |
| `Doctor1Barter` | Doctor1 | (2 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `MeetSmuggler` | Smuggler | I'll give you 2100 for the scope. [needs !M03BoughtScope, M03CanBuyScope] | -> BuyScope: set M03BoughtScope, give WeaponModScope |
| `MeetSmuggler` | Smuggler | How about you give me the bioelectric cell for 750? [needs !M03BoughtCell, M03CanBuyCell] | -> BuyCell: set M03BoughtCell, give BioelectricCell |
| `MeetSmuggler` | Smuggler | Sell me the Light Amplification Goggles for 3375. [needs !M03BoughtGoggles, M03CanBuyGoggles] | -> BuyGoggles: set M03BoughtGoggles, give TechGoggles |
| `MeetSmuggler` | Smuggler | Too expensive. Maybe I'll try to locate your friend. | -> NotInterested: trig BotToNeutral |
| `MeetSmuggler` | Smuggler | I'll take the scope for 700. [needs !M03BoughtScope, M03CanBuyScope] | -> BuyScopeCheap: set M03BoughtScope, give WeaponModScope |
| `MeetSmuggler` | Smuggler | 700's a bargain on that scope, but I'm low on cash. [needs !M03CanBuyScope, !M03BoughtScope] | -> NotInterested: trig BotToNeutral |
| `MeetSmuggler` | Smuggler | Here's 250 for the bioelectric cell. [needs !M03BoughtCell, M03CanBuyCell] | -> BuyCellCheap: set M03BoughtCell, give BioelectricCell |
| `MeetSmuggler` | Smuggler | I'd take the bioelectric cell for 250 if I had the cash. [needs !M03BoughtCell, !M03CanBuyCell] | -> NotInterested: trig BotToNeutral |
| `MeetSmuggler` | Smuggler | 1125 for Light Amplification Goggles? Sure. [needs !M03BoughtGoggles, M03CanBuyGoggles] | -> BuyGogglesCheap: set M03BoughtGoggles, give TechGoggles |
| `MeetSmuggler` | Smuggler | 1125 for Light Amplification Goggles sounds fair, but I don't have the [needs !M03BoughtGoggles, !M03CanBuyGoggles] | -> NotInterested: trig BotToNeutral |
| `MeetSmuggler` | Smuggler | Not interested. | -> NotInterested: trig BotToNeutral |
| `MeetSmuggler` | Smuggler | (3 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `MeetFordSchickQuestion` | FordSchick | Make a break for it. I'll protect you. | -> Go: set FordRan, trig FordExit |
| `MeetFordSchickQuestion` | FordSchick | (1 further choice that change no state: refusals, "never mind", unaffordable offers) | - |
| `CounselWorker` | Worker | Just curious. Thought I heard you say Ambrosia. | -> Curious: set WorkerCounseled, set WorkerChattedAboutAmbrosia, set KnowsOfJoJo |
| `CounselWorker` | Worker | Tell me where you plan to get Ambrosia or I'll make sure you're arrest | -> Threat: set WorkerChattedAboutAmbrosia, set M02SheaAnnoyed |
| `UNATCOGrenade1Meet` | UNATCOGrenade1 | Sure, hand'em over. | -> thanks: set GrenadeGiveDone, give WeaponGasGrenade |
| `UNATCOGrenade1Meet` | UNATCOGrenade1 | Keep'em. Those things save lives. | -> nothanks: set GrenadeGiveDone |
| `MeetSickWoman2` | SickWoman | (2 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `MeetSickWoman` | SickWoman | Here you go. | -> Compassion: set GaveSickWomanCredits |
| `MeetSickWoman` | SickWoman | (1 further choice that change no state: refusals, "never mind", unaffordable offers) | - |
| `SickBum1Interrupted` | SickBum1 | You should be more appreciative. By helping you, this gentleman risks  | -> Diplomat: set Doctor2_Saved, trig SickBumLeaves |
| `SickBum1Interrupted` | SickBum1 | (1 further choice that change no state: refusals, "never mind", unaffordable offers) | - |
| `MeetSally2` | Sally | Sure | -> GetInfo: set KnowsAboutWarehouse, set M02SallyDone, done InterviewLocals |
| `MeetSally2` | Sally | (1 further choice that change no state: refusals, "never mind", unaffordable offers) | - |
| `MeetPimp` | Pimp | Leave her alone or I'll have your ass picked up for pandering. | -> Copper: set ThreatenedPimpWithArrest, trig PimpAttacksPlayer |
| `MeetPimp` | Pimp | You've got 10 seconds to beat it before I add you to the list of NSF c | -> ToughGuy: set PlayerIntimidatedSandrasPimp, set SandrasPimpDone, done HelpJaneysFriend, trig PimpStandsDown, trig SandraTalksToPlayer |
| `MeetPimp` | Pimp | Deal. | -> Trickery2: set PaidForJaney |
| `MeetPimp` | Pimp | (3 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `MeetJosh` | Josh | You don't look that bad. Tell me what you know about the NSF. | -> Stingy: set JoshFed=0, set JoshPlayed |
| `MeetJosh` | Josh | How about some soy food? | -> GenerousSoy: take Soyfood, set JoshDone, set JoshFed |
| `MeetJosh` | Josh | You don't look that bad. Tell me what you know about the NSF. | -> Stingy: set JoshFed=0, set JoshPlayed |
| `MeetJosh` | Josh | All I have is a candy bar. | -> Generous: take Candybar |
| `MeetJosh` | Josh | You don't look that bad. Tell me what you know about the NSF. | -> Stingy: set JoshFed=0, set JoshPlayed |
| `MeetJosh` | Josh | (1 further choice that change no state: refusals, "never mind", unaffordable offers) | - |
| `JordanSheaConvos` | JordanShea | A beer, please. | -> BuyBooze: set M02BoughtBooze1, give Liquor40oz |
| `JordanSheaConvos` | JordanShea | I'll take a candy bar. | -> BuyCandyBar: give Candybar |
| `JordanSheaConvos` | JordanShea | How 'bout a soda? | -> BuySoda: give Sodacan |
| `JordanSheaConvos` | JordanShea | (4 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `MeetJoeGreen2` | JoeGreene | Heard anything about a secret NSF power-generator? [needs !FoundWarehouse] | -> GreenQuestioned: set M02QuestionedGreen |
| `MeetJoeGreen2` | JoeGreene | What do you know about the NSF? [needs FoundWarehouse] | -> GreenQuestioned: set M02QuestionedGreen |
| `MeetJoeGreen2` | JoeGreene | (1 further choice that change no state: refusals, "never mind", unaffordable offers) | - |
| `MeetJock` | Jock | You can have this beer. | -> GiveBooze: take Liquor40oz |
| `MeetJock` | Jock | (5 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `JockSecondStory` | Jock | You can have this beer. | -> GiveBooze: take Liquor40oz |
| `JockSecondStory` | Jock | (5 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `Doctor2Barter` | Doctor2 | I'll take a medkit. [needs CanAffordBots] | -> Medkit: give MedKit |
| `Doctor2Barter` | Doctor2 | All I can afford is a medkit. [needs !CanAffordBots] | -> Medkit: give MedKit |
| `Doctor2Barter` | Doctor2 | I want the full program. [needs CanAffordBots] | -> Full: set BoughtClinicPlan |
| `Doctor2Barter` | Doctor2 | Sure. | -> MedKit: give MedKit |
| `Doctor2Barter` | Doctor2 | (2 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `JockExit` | BlackHelicopter | Let's go. | -> Go: set M01JockDone, trig ChopperExit |
| `JockExit` | BlackHelicopter | (1 further choice that change no state: refusals, "never mind", unaffordable offers) | - |
| `MeetBilly` | Billy | You can have this soy food. | -> GiveSoy: take Soyfood, set M02BillyDone |
| `MeetBilly` | Billy | Want this candy bar? | -> GiveCandy: take Candybar |
| `MeetBilly` | Billy | (2 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `AnnaThanks` | AnnaNavarre | You mechs might have copper-wiring to re-route your fear of pain, but  | -> Cocky: set M02MechSlur, set AnnaThanksChatDone, +goal LiberateBatteryParkSubway |
| `AnnaThanks` | AnnaNavarre | I'm learning as I go. | -> TeamPlayer: set M02MechSlur=0, +goal LiberateBatteryParkSubway |

**Conversations that change state** (choices, flags set, goals, items, events, skill points; the `Needs` column is kept on these rows):

| Conversation | Owner (BindName; maps with that actor) | Kind | Choices | Sets | Needs | Goals | Other |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `Doctor1Barter` | Doctor1 (NYC_FreeClinic) | talk bump/frob | 6 | CanAffordBots=0@Continue, CanAffordMedkit@Continue, BoughtClinicPlan@Full, CanAffordBots@AffordBots | ? BoughtClinicPlan, ? !Doctor1Barter_Played | +note | give MedKit, cr -2300 |
| `SmugglerThanks` | Smuggler (NYC_Smug) | talk bump/frob |  | SmugglerThankedPlayer, SmugglerLamenting@SchickDead | req FordSchickRescueDone, req MeetSmuggler_Played, req !SmugglerThankedPlayer, ? FordSchick_Dead, ? SmugglerDoneVending, ? FordSchickRescued, ? !SmugglerThanksTag |  |  |
| `MeetSmuggler` | Smuggler (NYC_Smug) | talk radius 80 once | 14 | MetSmuggler, PlayerHeardAboutSmuggler, GotSchickGoal, SmugglerLamenting@SchickDead, SmugglerThankedPlayer@RescueAlreadyDone, M03SmugglerGaveOptions@YuckyHack, M03SmugglerGaveOptions@Choices (+19 more) | ? FordSchickRescued, ? FordSchick_Dead, ? M03SmugglerGaveOptions, ? !SmugglerThanksTag, ? M03BoughtCell, ? M03BoughtGoggles, ? M03BoughtScope, ? !KnowsSmugglerPassword | +S RescueFordSchick, +note | trig BotToNeutral, give NanoKey, give TechGoggles, give BioelectricCell, give WeaponModScope, cr -8300 |
| `SckickThanks` | FordSchick (NYC_Underground) | ovh radius 200 once |  | SchickThankedPlayer@Hop | req !SchickThankedPlayer, req FordSchickRescued |  | sp 80 |
| `MeetFordSchickRescue` | FordSchick (NYC_Underground) | talk bump/frob/radius 120 |  | MetFord | req MeetSmuggler_Played, req !FordRan, ? MetFord |  |  |
| `MeetFordSchickQuestion` | FordSchick (NYC_Underground) | talk bump/frob/radius 120 | 2 | MetFord, FordRan@Go | req !MeetSmuggler_Played, req !FordRan, ? MetFord |  | trig FordExit |
| `DL_TenderloinSubway` | JCDenton | DL once |  |  |  | +S ReportToPaul |  |
| `DL_SubwayComplete` | JCDenton | DL once |  |  | req SubTerroristsDead, req !MS_MapLeftEarly, ? AmbrosiaTagged, ? SubHostageMale_Dead, ? SubHostageFemale_Dead | done LiberateBatteryParkSubway, +P ReportToPaul | sp 800 |
| `DL_StreetOpened` | JCDenton | DL once |  |  | ? FoundWarehouse, ? TenderloinSlaughter | done SubdueAlleyTerrorists |  |
| `DL_Rooftops` | JCDenton | DL once |  |  | req !FoundWarehouse, ? DL_Alleys_Played |  | give Image02_NYC_Warehouse |
| `DL_Pickup` | JCDenton | DL once |  |  |  | done DestroyGenerator, done InterviewLocals |  |
| `DL_ParkSubway` | JCDenton | DL once |  |  |  | +P LiberateBatteryParkSubway |  |
| `DL_HotelBriefing` | JCDenton | DL once |  |  |  | +S RescueRenton |  |
| `DL_AmbrosiaFound` | JCDenton | DL once |  | AmbrosiaTagged | ? MS_MapLeftEarly | done FindAmbrosia, +S ReportToAnna |  |
| `DL_Alleys` | JCDenton | DL once |  |  | req !FoundWarehouse, ? DL_Rooftops_Played |  | give Image02_NYC_Warehouse |
| `WorkerOverheard2` | Worker (NYC_Bar) | ovh radius 320 once |  | WorkerHeard | req WorkerOverheard_Played, req !WorkerChattedAboutAmbrosia |  |  |
| `WorkerOverheard` | Worker (NYC_Bar) | ovh radius 320 once |  | WorkerHeard |  |  |  |
| `WorkerGivesInfo` | Worker (NYC_Bar) | talk bump/frob once |  | KnowsAboutWarehouse, KnowsSmugglerPassword@MissionDone | req WorkerCounseled, ? FoundWarehouse, ? MeetSmuggler_Played | done InterviewLocals, +note |  |
| `ReconciledBarks` | Worker (NYC_Bar) | ovh bump/frob |  | WorkerBeerComment@NoBeer, WorkerBeerComment=0@BeerRepeat | req WorkerReconciled_Played, req WorkerGivesInfo_Played, ? WorkerBeerComment |  |  |
| `CounselWorkerHack` | Worker (NYC_Bar) | talk bump/frob once |  | M02SheaAnnoyed@Hop | req AlwaysFalse |  |  |
| `CounselWorker` | Worker (NYC_Bar) | talk bump/frob once | 2 | WorkerChattedAboutAmbrosia@Threat, M02SheaAnnoyed@Threat, WorkerCounseled@Curious, WorkerChattedAboutAmbrosia@Curious, KnowsOfJoJo@Curious | req !WorkerCounseled, req WorkerHeard |  |  |
| `MeetWindowBum` | WindowBum (NYC_FreeClinic) | talk bump/frob/radius 140 once |  |  |  | done InterviewLocals, +note |  |
| `UNATCOGrenade1Meet` | UNATCOGrenade1 (NYC_Street) | talk bump/frob/radius 200 | 2 | HeardGrenadeTalk, GrenadeGiveDone@thanks, GrenadeGiveDone@nothanks, GrenadeGiveDone@SubsequentVisit | req !GrenadeGiveDone, ? UNATCOGrenade1Meet_Played |  | give WeaponGasGrenade*3, give WeaponGasGrenade*8 |
| `SubHostageMaleEscape` | SubHostageMale (NYC_BatteryPark, NYC_Street) | talk bump/frob/radius 160 once |  | SubHostageEscapePlayed | req !SubFrontEntry, req !SubTerroristsDead, req !SubHostageEscapePlayed, req !TrainDoorsOpened, req !M02StreetLoaded |  |  |
| `SubHostageFemaleEscape` | SubHostageFemale (NYC_BatteryPark, NYC_Street) | talk bump/frob/radius 160 once |  | SubHostageEscapePlayed | req !SubFrontEntry, req !SubTerroristsDead, req !SubHostageEscapePlayed, req !TrainDoorsOpened, req !EscapeSuccessful, req !M02StreetLoaded |  |  |
| `SmugglerDoorBellConvo` | SmugglerDoorBell (NYC_Street) | talk frob |  | SmugglerDoorDone@KnowsPassword | ? KnowsSmugglerPassword, ? SmugglerDoorBellConvo_Played |  | trig SmugglersFrontDoor |
| `SickWomanBarks` | SickWoman (NYC_BatteryPark) | ovh bump/frob/radius 160 |  | PlaySickWomanBarks@Bark, PlaySickWomanBarks@Bark2, PlaySickWomanBarks=0@Block | req PlaySickWomanBarks |  |  |
| `MeetSickWoman2` | SickWoman (NYC_BatteryPark) | talk bump/frob | 2 |  | req GaveSickWomanCredits, req !PlaySickWomanBarks |  | cr -5 |
| `MeetSickWoman` | SickWoman (NYC_BatteryPark) | talk bump/frob | 2 | GaveSickWomanCredits@Compassion | req !GaveSickWomanCredits, req !PlaySickWomanBarks |  | cr -5 |
| `SickBum1Interrupted` | SickBum1 (NYC_FreeClinic) | talk bump/frob once | 2 | Doctor2_Saved@Diplomat | req SickBumHeard, req !Doctor2_Dead |  | trig SickBumLeaves |
| `SandraSmugglerConvoStub1` | SandraRenton (NYC_Bar, NYC_Street) | talk bump/frob once |  | KnowsSmugglerPassword | req !MS_SandraInBar, req MeetSandraRenton_Played, req !KnowsSmugglerPassword, req PlayerHeardAboutSmuggler | +note |  |
| `SandraSmugglerConvo` | SandraRenton (NYC_Bar, NYC_Street) | talk bump/frob once |  | PlayerHeardAboutSmuggler, KnowsSmugglerPassword | req !MS_SandraInBar, req MeetSandraRenton_Played, req !PlayerHeardAboutSmuggler | +note |  |
| `SandraInBar` | SandraRenton (NYC_Bar, NYC_Street) | talk bump/frob/radius 100 once |  | DeliveredFathersMessage, KnowsSmugglerPassword@MessageDelivered, SandraHeardDadDead@Dead | req MS_SandraInBar, ? GilbertRenton_Dead, ? DeliveredFathersMessage, ? !RentonRescued_Played, ? KnowsSmugglerPassword | +note |  |
| `MeetSandraRenton` | SandraRenton (NYC_Bar, NYC_Street) | talk bump/frob/radius 0 once |  | PlayerKnowsSandraRenton, DeliveredFathersMessage@TalkedToRenton, KnowsOfJoJo@CResume | req SandrasPimpDone, req !MS_SandraInBar, ? PlayerHeardAboutSmuggler, ? Pimp_Dead, ? PlayerIntimidatedSandrasPimp, ? !RentonRescued_Played, ? GilbertRenton_Dead, ? KnowsOfJoJo, ? StreetOpened, ? RentonRescued_Played (+1 more) | done HelpJaneysFriend, done InterviewLocals, +note | trig SandraGoesToBar |
| `MeetSally2` | Sally (NYC_Street) | talk bump/frob | 2 | KnowsAboutWarehouse@GetInfo, M02SallyDone@GetInfo, M02SallyDone@MissionDone | req PaulBarricade_Played, req !M02SallyDone, ? MeetSally2_Played, ? FoundWarehouse | done InterviewLocals | cr -50 |
| `PimpOverheard` | Pimp (NYC_Street) | ovh radius 400 once |  | SawSandra | req !SandraRenton_Dead |  |  |
| `PimpBark` | Pimp (NYC_Street) | ovh radius 400 |  |  | req PimpOverheard_Played, req !SandrasPimpDone, req !SandraRenton_Dead |  | trig PimpAttacksSandra |
| `MeetPimp` | Pimp (NYC_Street) | talk bump/frob | 6 | PaidForJaney@Trickery2, PlayerIntimidatedSandrasPimp@ToughGuy, SandrasPimpDone@ToughGuy, ThreatenedPimpWithArrest@Copper | req !SandrasPimpDone, req !SandraRenton_Dead | done HelpJaneysFriend | trig PimpStandsDown, trig SandraTalksToPlayer, trig PimpAttacksPlayer, cr -100 |
| `PaulBarricade` | PaulDenton (NYC_Street) | talk bump/frob/radius 120 |  | PaulGaveGrenades@Transfers2, PaulGivesTried@NoRoomCommon | req !PaulGaveGrenades, ? PaulGivesTried, ? !SubTerroristsDead, ? !EscapeSuccessful, ? SubHostageFemale_Dead, ? SubHostageMale_Dead, ? PaulBarricade_Played | done ReportToPaul, done ReportToAnna, +S InterviewLocals, +P DestroyGenerator, +note | trig MakePaulGo, give NanoKey, give AmmoBattery |
| `BoatLeaving` | NYPoliceBoat (other missions) | ovh bump/frob |  |  | req GeneratorBlown |  | trig Boat_Exit |
| `MaleHostageRescued` | MaleHostage (NYC_Hotel) | talk bump/frob/radius 160 once |  |  | req M02HostagesRescued | +note |  |
| `MeetJosh` | Josh (NYC_BatteryPark) | talk bump/frob/radius 0 | 6 | JoshFed=0@Stingy, JoshPlayed@Stingy, JoshDone@GenerousContinue, JoshFed@GenerousContinue, JoshDone@jerk | req !JoshDone, ? JoshPlayed | +note | take Soyfood, take Candybar, has? Soyfood, has? Candybar |
| `JordanSheaConvos` | JordanShea (NYC_Bar) | talk bump/frob/radius 160 | 7 | M02BoughtBooze1@BuyBooze, KnowsAboutWarehouse@resume, M02BoughtBooze2@SetTwo | ? FoundWarehouse, ? !JordanSheaConvos_Played, ? M02SheaAnnoyed, ? M02BoughtBooze1, ? !KnowsAboutWarehouse | done InterviewLocals, +note | give Liquor40oz, give Candybar, give Sodacan, cr -10 |
| `MeetJoeGreen2` | JoeGreene (NYC_Bar) | talk bump/frob once | 3 | M02QuestionedGreen@GreenQuestioned | req MeetJoeGreen_Played |  |  |
| `MeetJoeGreen` | JoeGreene (NYC_Bar) | talk bump/frob once |  | PlayerKnowsJoeGreen, MeetJoeGreen_Played |  |  |  |
| `MeetJock` | Jock (NYC_Bar) | talk bump/frob | 6 | PlayerHeardAboutSmuggler@boozecommon, JockFirstStory@resume | req !JockFirstStory, ? MeetJock_Played, ? !PlayerHeardAboutSmuggler, ? !M02BoughtBooze1, ? KnowsAboutWarehouse, ? KnowsOfJoJo, ? FoundWarehouse | +note | take Liquor40oz, has? Liquor40oz, has? LiquorBottle, has? WineBottle |
| `JockSecondStory` | Jock (NYC_Bar) | talk bump/frob | 6 | JockSecondStory@boozecommon | req JockFirstStory, req !JockSecondStory, ? !M02BoughtBooze2 |  | take Liquor40oz, has? Liquor40oz, has? LiquorBottle, has? WineBottle |
| `JaneyThankful` | Janey (NYC_Bar) | talk bump/frob once |  | MetJaney | req MS_SandraInBar, ? JaneyDistraught_Played, ? !SandraRenton_Dead, ? SandraRenton_Dead, ? Pimp_Dead, ? PaidForJaney, ? !Pimp_Dead | +note |  |
| `JaneyDistraught` | Janey (NYC_Bar) | talk bump/frob once |  | MetJaney | req !MS_SandraInBar, ? PaidForJaney, ? SawSandra | +S HelpJaneysFriend | trig JaneyDistraughtConvoFinished |
| `TellAboutSandra` | GilbertRenton (NYC_Hotel) | talk bump/frob once |  | ToldRentonAboutSandra | req SawSandra, req !ToldRentonAboutSandra, req RentonRescued_Played, req RentonUpstairsComment |  |  |
| `RentonRescued` | GilbertRenton (NYC_Hotel) | talk bump/frob once |  | RentonUpstairsComment, ToldRentonAboutSandra@SandraResume, SawSandra=0@Dead, SawSandra=0@Dead2 | req GilbertTerrorist_Dead, ? !M02HostagesRescued, ? SandraRenton_Dead, ? SawSandra, ? SandrasPimpDone, ? !Pimp_Dead | done RescueRenton |  |
| `RentonLateComment` | GilbertRenton (NYC_Hotel) | talk bump/frob once |  | RentonUpstairsComment | req RentonRescued_Played, req !RentonUpstairsComment, req M02HostagesRescued |  |  |
| `Doctor2Overheard` | Doctor2 (NYC_FreeClinic) | ovh radius 400 |  | SickBumHeard | req !SickBumHeard, req !SickBum1Interrupted_Played |  |  |
| `Doctor2Barter` | Doctor2 (NYC_FreeClinic) | talk bump/frob | 6 | CanAffordBots=0@Continue, BoughtClinicPlan@Full, CanAffordBots@AffordBots | req Doctor2_Saved, ? BoughtClinicPlan, ? !Doctor2Barter_Played | +note | give MedKit, cr -1380 |
| `MeetClinicOlderBum` | ClinicOlderBum (NYC_FreeClinic) | talk bump/frob once |  |  |  | done InterviewLocals, +note |  |
| `ClinicMaleBum1Overhead` | ClinicMaleBum1 (NYC_FreeClinic) | ovh radius 320 |  | HeardClinicMaleBumSqualnomie@A1, HeardClinicMaleBum2Military@A2 |  |  |  |
| `JockExit` | BlackHelicopter (NYC_Warehouse) | talk bump/frob/radius 240 | 2 | ExitJockComment@MetJock, ExitJockComment@NoJock, M01JockDone@Go | ? !MeetJock_Played, ? !ExitJockComment, ? MeetJock_Played |  | trig ChopperExit |
| `MeetBilly` | Billy (NYC_BatteryPark) | talk bump/frob | 4 | M02BillyDone@GiveCiggs | req !M02BillyDone, ? MeetBilly_Played |  | take Soyfood, take Candybar, has? Soyfood, has? Candybar, sp 50 |
| `AnnaUpset` | AnnaNavarre (NYC_BatteryPark) | ovh bump/frob/radius 200 |  |  | req MS_MapLeftEarly, ? AmbrosiaTagged |  | trig AnnaWandersAfterAmbrosia |
| `AnnaThanks` | AnnaNavarre (NYC_BatteryPark) | talk bump/frob/radius 100 | 2 | M02MechSlur@Cocky, AnnaThanksChatDone@Cocky, AnnaThanksChatDone@SubwayDone, AnnaGivesTwo@Grenades2, AnnaThanks_Done@Grenades2, M02MechSlur=0@TeamPlayer, AnnaGivesThree@Grenades3, AnnaThanksChatDone@Grenades3 (+1 more) | req AmbrosiaTagged, req !AnnaThanks_Done, req !MS_MapLeftEarly, ? AnnaThanks_Played, ? BatteryParkSlaughter, ? SubTerroristsDead, ? EscapeSuccessful, ? SubHostageMale_Dead, ? SubHostageFemale_Dead, ? !AnnaThanksChatDone (+1 more) | done ReportToAnna, done LiberateBatteryParkSubway, +P ReportToPaul, +P LiberateBatteryParkSubway | give WeaponEMPGrenade, give WeaponEMPGrenade*2, sp 10 |
| `AnnaDock` | AnnaNavarre (NYC_BatteryPark) | talk bump/frob/radius 140 once |  |  | req !MS_MapLeftEarly | +S FindAmbrosia | trig AnnaRun, give Image02_Ambrosia_Flyer |
| `OverhearAlleyThug` | AlleyThug (NYC_Street) | ovh radius 400 once |  |  |  |  | trig ThugAttacks |
| `AlleyBumRescued` | AlleyBum (NYC_Street) | talk bump/frob once |  | PlayerKnowsUnderworldPassword | req AlleyBumRescued | +note |  |

Conversations that only wait for a flag or check one, and change no state (92; `?` = a `CheckFlag` event): `GuntherHermann_BarkFutz` (? GuntherRespectsPlayer), `SmugglerWaiting` (!FordSchickRescueDone, MeetSmuggler_Played, !SmugglerDoneVending), `SmugglerVending` (!SmugglerLamenting, !SmugglerDoneVending, SmugglerThankedPlayer), `SmugglerLamenting` (SmugglerLamenting, ? !GotSchickGoal), `SmugglerDoneVending` (SmugglerDoneVending (+1 more)), `FordBarks` (FordRan, ? FordSchickRescued (+2 more)), `DL_Warehouse` (!FoundWarehouse), `DL_SubwayComplete3` (EscapeSuccessful), `DL_SubwayComplete2` (SubHostageFemale_Dead, SubHostageMale_Dead), `DL_Smuggler2` (PlayerHeardAboutSmuggler, !DL_Smuggler1_Played), `DL_Smuggler1` (!PlayerHeardAboutSmuggler, !DL_Smuggler2_Played), `DL_CokeMachine` (!DL_Kiosk_Played), `DL_CastleClinton` (!MS_MapLeftEarly), `WorkerTightLipped` (WorkerChattedAboutAmbrosia, !WorkerCounseled), `WorkerReconciledHack` (AlwaysFalse), `WorkerReconciled` (WorkerCounseled), `WorkerOverheardHack` (AlwaysFalse), `WorkerMurderous` (WorkerChattedAboutAmbrosia (+1 more)), `WorkerDefault` (!WorkerHeard), `ReconciledBarksHack` (AlwaysFalse), `MurderousBarks` (!WorkerMurderous_Played (+1 more)), `WindowBumBarks` (MeetWindowBum_Played), `VeteranFinalBarks` (AmbrosiaTagged), `VeteranBarks` (!AmbrosiaTagged), `UNATCOTroop` (? AmbrosiaTagged (+3 more)), `UNATCOHotelWaiting` (!M02HostagesRescued (+1 more)), `UNATCOHotelMeet2` (M02HostagesRescued, ? MaleHostage_Dead, ? FemaleHostage_Dead, ? GilbertRenton_Dead (+1 more)), `UNATCOHotelMeet` (!M02HostagesRescued), `HotelTroopsFinalBarks` (UNATCOHotelMeet2_Played (+2 more)), `UNATCOGrenade1Barks` (GrenadeGiveDone), `SubMaleRescued` (SubTerroristsDead, !M02StreetLoaded), `SubHostageMaleStreet` (M02StreetLoaded), `SubHostageMaleRescuedBarks` (SubMaleRescued_Played (+2 more)), `SubHostageMaleBarks` (!SubTerroristsDead, !M02StreetLoaded), `SubHostageFemaleStreet` (M02StreetLoaded), `SubHostageFemaleRescuedBarks` (SubTerroristsDead, !M02StreetLoaded), `SubHostageFemaleInCar` (EscapeSuccessful, !SubTerroristsDead (+2 more)), `SubHostageFemaleBarks` (!SubTerroristsDead (+2 more)), `SubGuardsBarks` (? SubTerroristsDead (+1 more)), `SickManInitialBarks` (!MeetSickMan_Played), `SickManBarks` (MeetSickMan_Played), `SickBum1DefaultBarks2` (Doctor2_Dead), `SickBum1DefaultBarks` (!SickBumHeard, !Doctor2_Dead), `SickBum1Barks` (SickBum1Interrupted_Played (+2 more)), `SandraFirstBarks` (!SandrasPimpDone), `SandraBarks` (MeetSandraRenton_Played (+2 more)), `SandraBarBarks2` (SandraHeardDadDead), `SandraBarBarks` (SandraInBar_Played (+1 more)), `SallyFinalBarks` (M02SallyDone, ? FoundWarehouse), `SallyBarks` (!PaulBarricade_Played (+1 more)), `MeetSally` (!PaulBarricade_Played), `PimpKilledSandra` (SandraRenton_Dead), `AskForMoney` (PaidForJaney, SandrasPimpDone), `PaulLeaving` (PaulGaveGrenades (+1 more)), `ParkBum2Barks` (? AmbrosiaTagged), `BoatWaiting` (!GeneratorBlown), `MaleHostageInitialBarks` (!M02HostagesRescued), `MaleHostageBarks` (MaleHostageRescued_Played), `JoshBarks` (JoshDone, ? JoshFed), `GreenBarks` (MeetJoeGreen2_Played), `JockThirdStory` (JockSecondStory), `JockFourthStory` (JockThirdStory_Played), `JockBarks` (JockFourthStory_Played), `JaneyWaitingBarks` (JaneyDistraught_Played (+1 more)), `JaneyFinalBarks` (MS_SandraInBar, JaneyThankful_Played (+1 more)), `HotelTroopsBarks` (? StreetOpened (+1 more)), `M02GuntherBarks` (M02MeetGunther_Played), `RentonWaiting` (MeetRenton_Played (+1 more)), `RentonRescuedNoCommentBarks` (RentonRescued_Played (+2 more)), `RentonRescuedBarks2` (RentonRescued_Played (+3 more)), `RentonRescuedBarks` (RentonRescued_Played (+3 more)), `MeetRenton` (!GilbertTerrorist_Dead, ? StreetOpened), `FemaleHostageInitialBarks` (!M02HostagesRescued), `FemaleHostageBarks` (M02HostagesRescued), `Doctor2StillArguing2` (DoctorStillArguing_Played), `Doctor2StillArguing` (!Doctor2_Saved (+1 more)), `Doctor2Busy` (!Doctor2_Saved), `ClinicOlderBumBarks` (MeetClinicOlderBum_Played), `ClinicMaleBum3Barks` (MeetClinicMaleBum3_Played), `ClinicMaleBum2Squalnomie` (HeardClinicMaleBumSqualnomie), `ClinicMaleBum2Military` (HeardClinicMaleBum2Military), `ClinicTroopsBarks` (? ClinicCleared), `BystanderWaiting` (!AlleyBumRescued, !AlleyBum_Dead), `BystanderPlea` (!AlleyBumRescued, !AlleyBum_Dead), `BystanderFinalBarks` (AlleyBumRescued, !AlleyBum_Dead), `BumDead` (AlleyBum_Dead), `BillyBarks` (M02BillyDone), `BarWoman1Barks` (? WorkerCounseled), `AnnaFinalBarks` (AnnaThanks_Done, !MS_MapLeftEarly (+4 more)), `AnnaFightingBarks` (AnnaDock_Played, !AmbrosiaTagged (+2 more)), `AlleyBumBarksB` (!AlleyBumRescued), `AlleyBumBarks` (AlleyBumRescued_Played).

Plain InfoLinks, no flag and no event: 5 (listed with their starters in the InfoLink table).

Plain conversations with an actor (9): WaltonSimons: WaltonSimons_BarkAllianceHostile WaltonSimons_BarkAllianceFriendly; GuntherHermann: GuntherHermann_BarkAllianceHostile GuntherHermann_BarkAllianceFriendly M02MeetGunther; AnnaNavarre: AnnaNavarre_BarkAllianceHostile AnnaNavarre_BarkAllianceFriendly; SickMan: MeetSickMan; ClinicMaleBum3: MeetClinicMaleBum3.

Plain overheard conversations (24): WaltonSimons: WaltonSimons_BarkFutz; JosephManderley: JosephManderley_BarkAllianceHostile JosephManderley_BarkAllianceFriendly; AnnaNavarre: AnnaNavarre_BarkFutz; Nurse2: Nurse2Barks; Nurse1: Nurse1Barks; ClinicSecretary: ClinicSecretaryBarks; UNATCOGrenade2: UNATCOGrenade2Barks; StreetBum4: StreetBum4Barks; StreetBum3: StreetBum3Barks; StreetBum2: StreetBum2Barks; StreetBum1: StreetBum1Barks; SickBum2: SickBum2Barks; ParkBum3: ParkBum3Barks; ParkBum1: ParkBum1Barks; MaleCop: MaleCopBarks; Junkie: JunkieBarks; ClinicSickWoman: ClinicSickWomanBarks; ClinicMaleBum2: ClinicMaleBum2Barks; ClinicMaleBum1: ClinicMaleBum1Barks; ClinicFemaleBum2: ClinicFemaleBum2Barks; ClinicFemaleBum1: ClinicFemaleBum1Barks; BarWoman2: BarWoman2Barks; AlleyThug: AlleyThugBarks.

InfoLinks and what starts them (`DL_Warehouse`, `DL_Rooftops` need `FoundWarehouse`, a flag that **nothing sets**, so they cannot play; `DL_StreetOpened` checks it):

| InfoLink | Started by | Needs | Sets / does |
| --- | --- | --- | --- |
| `DL_WaterTreatment` | NYC_Underground/DataLinkTrigger13 (-3281,594) |  |  |
| `DL_Warehouse` | NYC_Warehouse/DataLinkTrigger2 (-390,847), NYC_Warehouse/DataLinkTrigger3 (-705,632), NYC_Warehouse/DataLinkTrigger4 (-1046,333) | !FoundWarehouse |  |
| `DL_Underground` | NYC_Underground/DataLinkTrigger9 (1734,-705), NYC_Underground/DataLinkTrigger0 (-68,-1082) |  |  |
| `DL_TenderloinSubway` | (none found) |  | +goal ReportToPaul |
| `DL_SubwayComplete3` | Mission02.uc:215 | EscapeSuccessful |  |
| `DL_SubwayComplete2` | Mission02.uc:220 | SubHostageFemale_Dead, SubHostageMale_Dead |  |
| `DL_SubwayComplete` | NYC_BatteryPark/DataLinkTrigger11 (-4995,3393) needs SubTerroristsDead, NYC_BatteryPark/DataLinkTrigger12 (-4995,3011) needs SubTerroristsDead, Mission02.uc:226 (+2 more) | SubTerroristsDead, !MS_MapLeftEarly, AmbrosiaTagged, SubHostageMale_Dead, SubHostageFemale_Dead | done LiberateBatteryParkSubway, +goal ReportToPaul, sp 800 |
| `DL_StreetOpened` | (none found) | FoundWarehouse, TenderloinSlaughter | done SubdueAlleyTerrorists |
| `DL_Smuggler2` | NYC_Smug/DataLinkTrigger1 (-1027,-761), NYC_Smug/DataLinkTrigger2 (-4,-1214) | PlayerHeardAboutSmuggler, !DL_Smuggler1_Played |  |
| `DL_Smuggler1` | NYC_Smug/DataLinkTrigger0 (-7,-1217), NYC_Smug/DataLinkTrigger4 (-1036,-765) | !PlayerHeardAboutSmuggler, !DL_Smuggler2_Played |  |
| `DL_Rooftops` | NYC_Warehouse/DataLinkTrigger1 (-928,3148) | !FoundWarehouse, DL_Alleys_Played | give Image02_NYC_Warehouse |
| `DL_ReminderJaney` | NYC_Bar/DataLinkTrigger1 (-282,-620) |  |  |
| `DL_Pickup` | Mission02.uc:353 |  | done DestroyGenerator, done InterviewLocals |
| `DL_ParkSubway` | NYC_BatteryPark/DataLinkTrigger0 (-4557,1665), NYC_BatteryPark/DataLinkTrigger2 (-4439,2616), NYC_BatteryPark/DataLinkTrigger3 (-4469,3014) (+6 more) |  | +goal LiberateBatteryParkSubway |
| `DL_Panel` | (none found) |  |  |
| `DL_Kiosk` | NYC_BatteryPark/DataLinkTrigger8 (801,-501) |  |  |
| `DL_HotelBriefing` | NYC_Street/DataLinkTrigger3 (1329,-1823) |  | +goal RescueRenton |
| `DL_CokeMachine` | NYC_BatteryPark/DataLinkTrigger9 (-619,-3421) needs !DL_Kiosk_Played | !DL_Kiosk_Played |  |
| `DL_CastleClinton` | (none found) | !MS_MapLeftEarly |  |
| `DL_AmbrosiaFound` | NYC_BatteryPark/DataLinkTrigger1 (485,-1066) | MS_MapLeftEarly | set AmbrosiaTagged, done FindAmbrosia, +goal ReportToAnna |
| `DL_Alleys` | NYC_Warehouse/DataLinkTrigger0 (-2087,2753) | !FoundWarehouse, DL_Rooftops_Played | give Image02_NYC_Warehouse |

**Required (progression) conversations.** By the exit chains above only `BoatLeaving` (the boat) is a conversation on a chain, and it needs the trigger-set flag `GeneratorBlown` (the wall `BreakableWall2` at (576,-512,72) takes `minDamageThreshold 75`; its `Event` chain
`Generator` -> eleven `Debris` movers -> `FlagTrigger0`, which sets `GeneratorBlown` and fires `MissionComplete`/`GoalCompleteTrigger0`). The helicopter route needs no conversation. **Not required by any flag on the way out**: `AnnaDock`, `AnnaThanks`, `PaulBarricade`, `MeetSmuggler`,
the interviews. (They gate goals and items, not a door the data shows: `PaulBarricade` hands over a `NanoKey` and a battery, `PaulGaveGrenades`; what that key opens is unverified.)

### 02.4 Objectives

| Goal | Kind | Text | Added by | Completed by |
| --- | --- | --- | --- | --- |
| `RescueFordSchick` | secondary | Rescue Smuggler's friend Ford Schick from a secret laboratory in the sewers. The sewers are accessed by the grates in the street. | MeetSmuggler | 02_NYC_Underground/GoalCompleteTrigger0 |
| `ReportToPaul` | primary | Report to Paul in Hell's Kitchen. | DL_TenderloinSubway, DL_SubwayComplete, AnnaThanks | PaulBarricade |
| `LiberateBatteryParkSubway` | primary | Free the hostages in the Battery Park subway station, east of Castle Clinton. | DL_ParkSubway, AnnaThanks | DL_SubwayComplete, AnnaThanks, Mission02.Timer:195, 02_NYC_BatteryPark/GoalCompleteTrigger4, 02_NYC_BatteryPark/GoalCompleteTrigger5, 02_NYC_BatteryPark/GoalCompleteTrigger1, 02_NYC_BatteryPark/GoalCompleteTrigger2 |
| `SubdueAlleyTerrorists` | carried |  | - | DL_StreetOpened |
| `DestroyGenerator` | primary | Find the NSF's secret generator. Paul's team will raid the warehouse when the generator is destroyed and the EMP field goes down. | PaulBarricade | DL_Pickup |
| `InterviewLocals` | secondary | Talk to the locals in the bar or the clinic for clues to the location of the generator. | PaulBarricade | DL_Pickup, WorkerGivesInfo, MeetWindowBum, MeetSandraRenton, MeetSally2, JordanSheaConvos, MeetClinicOlderBum, 02_NYC_Bar/GoalCompleteTrigger1, 02_NYC_FreeClinic/GoalCompleteTrigger1 |
| `RescueRenton` | secondary | Investigate the hostage situation in the 'Ton Hotel, at the southeast corner of the block. Rescue the Rentons, if they are still inside. | DL_HotelBriefing | RentonRescued |
| `FindAmbrosia` | secondary | Locate the stolen barrel of Ambrosia in Castle Clinton. | AnnaDock | DL_AmbrosiaFound, 02_NYC_BatteryPark/GoalCompleteTrigger0 |
| `ReportToAnna` | secondary | Report to Agent Navarre to receive your orders. | DL_AmbrosiaFound | PaulBarricade, AnnaThanks |
| `HelpJaneysFriend` | secondary | A man named Johnny took a woman into an alley west of the Underworld Bar. Investigate the situation. | JaneyDistraught | MeetSandraRenton, MeetPimp, Mission02.Timer:317, Mission02.Timer:331 |
| `GeneratorBlown` | carried |  | - | 02_NYC_Warehouse/GoalCompleteTrigger0 |

`SkillAwardTrigger`s: Bar 150, Battery Park 335 (6), Clinic 150, Hotel 105, Smuggler's lair 20, Street 190, Underground 100, Warehouse 890 (13, one of 500). `GoalCompleteTrigger`s complete `FindAmbrosia`, `LiberateBatteryParkSubway` (four actors),
`InterviewLocals` (bar and clinic), `RescueFordSchick`, `GeneratorBlown`. Goals still open on entering mission 3 stay if primary, are dropped if secondary (`ResetGoals`).

### 02.5 Choices with lasting consequences

Set here, alive in a later mission:

| Flag | Set here by | Expires | Read later by |
| --- | --- | --- | --- |
| `AmbrosiaTagged` | conversation DL_AmbrosiaFound; trigger 02_NYC_BatteryPark/FlagTrigger1 | never; mission 6 | M3 checks in CarterGreeting03; M3 checks in ManderleyDebriefing02; M3 checks in AnnaManderley1; M3 checks in AnnaAtUNATCO |
| `BatteryParkSlaughter` | script Mission02.Timer:178 | mission 6 | M3 checks in TroopBarks2; M3 checks in TroopBarks1; M3 checks in CarterGreeting03; M3 checks in CarterBarks; M3 checks in AnnaManderley2; ... |
| `EscapeSuccessful` | trigger 02_NYC_BatteryPark/FlagTrigger7; trigger 02_NYC_BatteryPark/FlagTrigger8 | mission 7 | M3 checks in ManderleyDebriefing02; M3 checks in AnnaAtUNATCO |
| `FordSchickRescued` | script Mission02.PreTravel:122 | mission 9 | M3 checks in SmugglerThanks; M3 checks in MeetSmuggler; M3 needed by SckickThanks; M3 checks in FordBarks; M4 checks in M04MeetSmuggler; ... |
| `FordSchickRescueDone` | script Mission02.Timer:439 | mission 9 | M3 needed by SmugglerWaiting; M3 needed by SmugglerThanks |
| `HeardGrenadeTalk` | conversation UNATCOGrenade1Meet | never | M3 checks in ManderleyDebriefing02 |
| `KnowsOfJoJo` | conversation CounselWorker@Curious; conversation MeetSandraRenton@CResume | never | M3 checks in ManderleyDebriefing02 |
| `M02MechSlur` | conversation AnnaThanks@Cocky; conversation AnnaThanks@TeamPlayer (=0) | never | M3 checks in TroopBarks2; M3 checks in AnnaEntrance; M3 checks in AnnaAtUNATCO |
| `M02QuestionedGreen` | conversation MeetJoeGreen2@GreenQuestioned | never | M3 checks in ManderleyDebriefing02; M4 checks in M04MeetJoeGreen |
| `M02ViolenceInBar` | script Mission02.Timer:416 | mission 4 | M3 checks in ManderleyDebriefing02 |
| `MeetJoeGreen_Played` | conversation MeetJoeGreen; played MeetJoeGreen | never; mission 3 | M4 checks in M04MeetJoeGreen |
| `SubTerroristsDead` | script Mission02.Timer:196 | mission 6 | M3 checks in ManderleyDebriefing02; M3 checks in AnnaAtUNATCO |
| `TenderloinSlaughter` | script Mission02.Timer:285 | mission 6 | M3 checks in TroopBarks2; M3 checks in TroopBarks1; M3 checks in CarterGreeting03; M3 checks in PrivateLloydBark; M3 checks in ManderleyDebriefing02 |

Read here, set in mission 1:

| Flag | Set earlier by | Read here by |
| --- | --- | --- |
| `GuntherRespectsPlayer` | M1 conversation GuntherRescued@GiveSpeech; M1 conversation GuntherRescued@GiveNothing; M1 conversation GuntherRescued@GiveNothingNicely | checks in GuntherHermann_BarkFutz |
| `M01PlayerAggressive` | M1 script Mission01.Timer:91 | checks in PaulLeaving |

* **Battery Park**: `AmbrosiaTagged` (the barrel in Castle Clinton found, by `DL_AmbrosiaFound` or the `FlagTrigger1` at (491,-1069,-392)), `SubTerroristsDead`, `EscapeSuccessful` (hostages out through the train), `BatteryParkSlaughter` (the Clinton terrorists mostly dead): mission 3's UNATCO
  conversations (`ManderleyDebriefing02`, `CarterGreeting03`, `AnnaManderley1/2`, `AnnaAtUNATCO`, troop barks) change with them.
* **Anna** (`AnnaThanks`): the "Cocky" branch sets `M02MechSlur`, "TeamPlayer" sets it false; mission 3's `AnnaEntrance`, `AnnaAtUNATCO` read it.
* **The street and the bar**: `TenderloinSlaughter` (3 or more street terrorists killed), `M02ViolenceInBar` (a body in the bar), `KnowsOfJoJo`, `HeardGrenadeTalk`, `M02QuestionedGreen`, `MeetJoeGreen_Played` (permanent, read in mission 4 by `M04MeetJoeGreen`).
* **Ford Schick**: see the `PreTravel` note above. Ford's death (`FordSchick_Dead`, permanent) and `FordSchickRescueDone` (expiration 9) are readable in mission 3 and later; his rescue flag is not (per the data).
* Pawns here that stay dead for later maps: `PaulDenton`, `AnnaNavarre`, `GuntherHermann`, `JoeGreene`, `JordanShea`, `Jock`, `SandraRenton`, `GilbertRenton`, `Sally`, `Pimp`, `FordSchick`, `SubHostageMale/Female`, ...: the table of who can die lists the missions each reappears in.

### 02.6 Progression path

1. Battery Park, `PlayerStart5`. `AnnaDock` (Anna, radius 140) adds `FindAmbrosia`; the Ambrosia barrel and the subway are optional for the exit but decide `AmbrosiaTagged`, `SubTerroristsDead`, `EscapeSuccessful`.
2. Reach the Street: the train doors (`TrainDoors`, three movers opened by `SubwayControlPanel3/4/5`) and one of the three Battery Park subway teleporters; the Street's hub teleporters.
3. `PaulBarricade` (optional for the chain), then the warehouse district: `Teleporter25` from the alley or the `ToWarehouse` button (`MapExit0` of the Street -> `02_NYC_Warehouse#ToRoofTop`); `OuterDoor`/`DoorToWarehouse`/`SecurityDoor` are keypad doors (see the table).
4. Destroy `BreakableWall2` (explosive of at least 75 damage: the Warehouse has 2 `CrateExplosiveSmall` and 32 `Barrel1`; what damage the grenades that Anna and `UNATCOGrenade1` hand out do to it was not read) -> `GeneratorBlown`.
5. Exit: touch `02_NYC_Warehouse` `MapExit0` on the roof (helicopter), or return to Battery Park and use `BoatLeaving`.

| Map | Tag (movers) | Lock | Opened by |
| --- | --- | --- | --- |
| `02_NYC_BatteryPark` | `TrainDoors` (3) | unlocked, not frobbable | SubwayControlPanel SubwayControlPanel3, SubwayControlPanel SubwayControlPanel4, SubwayControlPanel SubwayControlPanel5 |
| `02_NYC_BatteryPark` | `KioskDoor` (1) | unlocked, not frobbable | Keypad1 Keypad2, Switch2 Switch0 |
| `02_NYC_BatteryPark` | `DrinkMachine` (1) | unlocked, breakable 0.50, not frobbable | Keypad1 Keypad1, Trigger Trigger1 |
| `02_NYC_FreeClinic` | `OutClinic` (1) | unlocked, breakable 0.50, not frobbable | Trigger Trigger1 |
| `02_NYC_FreeClinic` | `InClinic` (1) | unlocked, breakable 0.50, not frobbable | Trigger Trigger2 |
| `02_NYC_FreeClinic` | `InSurgery` (1) | unlocked, breakable 0.50, not frobbable | Keypad2 Keypad0 |
| `02_NYC_FreeClinic` | `OutSurgery` (1) | unlocked, breakable 0.50, not frobbable | Trigger Trigger0 |
| `02_NYC_Hotel` | `SecretRoom` (2) | unlocked, pick 0.20, not frobbable | Keypad1 Keypad0, Switch1 Switch0 |
| `02_NYC_Smug` | `elevatorbutton` (1) | unlocked, pick 0.20, not frobbable | Switch1 Switch4, Switch1 Switch5, Switch1 Switch1 |
| `02_NYC_Smug` | `mirrordoor` (1) | locked, breakable 1.00, not frobbable | Keypad3 Keypad1 |
| `02_NYC_Smug` | `botordertrigger` (1) | unlocked, pick 0.20, not frobbable | BeamTrigger BeamTrigger0, BeamTrigger BeamTrigger1, BeamTrigger BeamTrigger2, Switch2 Switch0 |
| `02_NYC_Street` | `elevatorbutton` (1) | unlocked, pick 0.20, not frobbable | Switch1 Switch0, Switch1 Switch4, Switch1 Switch2 |
| `02_NYC_Street` | `ElevatorDoor` (1) | unlocked, pick 0.20, not frobbable | Trigger Trigger1, Keypad1 Keypad0 |
| `02_NYC_Street` | `DeusExMover16` (1) | locked | frob |
| `02_NYC_Street` | `DeusExMover11` (1) | locked | frob |
| `02_NYC_Street` | `TrainDoors` (3) | unlocked, not frobbable | SubwayControlPanel SubwayControlPanel6, SubwayControlPanel SubwayControlPanel7, SubwayControlPanel SubwayControlPanel8 |
| `02_NYC_Street` | `SmugglersFrontDoor` (1) | unlocked, not frobbable | Button1 Button0, conversation SmugglerDoorBellConvo[KnowsPassword] |
| `02_NYC_Street` | `AugStore` (1) | locked, breakable 0.80, not frobbable | Keypad1 Keypad1 |
| `02_NYC_Underground` | `SewerHatch` (1) | unlocked, not frobbable | Keypad1 Keypad0, Keypad1 Keypad2 |
| `02_NYC_Underground` | `DoorA` (1) | unlocked, not frobbable | Keypad1 Keypad11, Keypad1 Keypad12 |
| `02_NYC_Underground` | `DoorC` (1) | unlocked, pick 0.20, not frobbable | Keypad1 Keypad9, Trigger Trigger2 |
| `02_NYC_Underground` | `ArmoryDoor` (1) | unlocked, pick 0.20, not frobbable | Trigger Trigger20, Keypad3 Keypad18 |
| `02_NYC_Underground` | `Door3` (1) | unlocked, not frobbable | Keypad1 Keypad16, Trigger Trigger1 |
| `02_NYC_Underground` | `Door2` (1) | unlocked, not frobbable | Keypad1 Keypad1, Trigger Trigger0 |
| `02_NYC_Underground` | `GuardDoor` (1) | unlocked, pick 0.20 | AlarmUnit AlarmUnit3, AlarmUnit AlarmUnit4 |
| `02_NYC_Underground` | `The` (1) | unlocked, pick 0.20 | Trigger Trigger3 |
| `02_NYC_Warehouse` | `LiftDoor` (1) | unlocked, pick 0.20, not frobbable | Trigger Trigger0 |
| `02_NYC_Warehouse` | `Debris` (11) | unlocked, pick 0.20, not frobbable | BreakableWall BreakableWall2 |
| `02_NYC_Warehouse` | `OuterDoor` (1) | unlocked, not frobbable | Keypad1 Keypad1, Keypad1 Keypad2 |
| `02_NYC_Warehouse` | `DrainGrate` (1) | unlocked, not frobbable | Valve Valve1 |
| `02_NYC_Warehouse` | `Generator` (1) | unlocked, breakable 0.05, not frobbable | DeusExMover DeusExMover1, DeusExMover DeusExMover9, DeusExMover DeusExMover3, DeusExMover DeusExMover4, DeusExMover DeusExMover14, DeusExMover DeusExMover16 |
| `02_NYC_Warehouse` | `SecurityDoor` (1) | unlocked, pick 0.20, not frobbable | Keypad2 Keypad0, Trigger Trigger1 |
| `02_NYC_Warehouse` | `DoorToWarehouse` (1) | unlocked, not frobbable | Keypad2 Keypad10 |

Key doors (a placed `NanoKey` opens them, or the lock is picked; frob only): `KioskDoors` x3, `CrackRoom`, `WarehouseBasementStorage` x2.

(21 further movers of these maps are locked with a pickable lock or breakable, take no key that exists as a placed `NanoKey` and are fired by no event: not listed.)

**Progression blocker (mission 2).** `GeneratorBlown` never set (the wall stays whole), or the exit actor not carrying the player to `03_NYC_UNATCOIsland`. A subway hostage, a side quest or a shop that does not work is not a blocker.

### 02.7 Slots

| Slot | Map | Saved as | Saves, play time | Important NPCs dead or knocked out (all) | Lasting-choice flags in the file (all) | Goals still open |
| --- | --- | --- | --- | --- | --- | --- |
| N0003 | `02_NYC_BatteryPark` | NYC - Battery Park | 52, 98 min | - | BathroomBarks_Played, FilbenGaveKey, GuntherFreed, GuntherRespectsPlayer=0, M01PlayerMetFilben, PlayerMetFilben | FindAmbrosia |
| N0004 | `02_NYC_Street` | NYC - Hell's Kitchen | 91, 163 min | GilbertTerrorist, Terrorist | AmbrosiaTagged, BathroomBarks_Played, BatteryParkSlaughter, FilbenGaveKey, GuntherFreed, GuntherRespectsPlayer=0, HeardGrenadeTalk, M01PlayerMetFilben, M02MechSlur=0, PlayerMetFilben, SubTerroristsDead | DestroyGenerator, InterviewLocals |

N0003 is Battery Park (arrival goals only); N0004 is the Street (more choices already made, see the flags column). Both can start a row; the warehouse and the exit have no slot.

## Mission 03: the Airfield (NYC)

Nine maps. The player returns to Liberty Island (UNATCO HQ again, `03_NYC_*` copies of the mission 1 maps), is debriefed, flies with Jock to Battery Park, goes through the Brooklyn Bridge subway station and the mole people's tunnels
to the NSF's airfield and helicopter base, and may assassinate Juan Lebedev in the 747 hangar. The mission is built around the search for three Ambrosia barrels (`HelicopterBaseAmbrosia`, `BoatDocksAmbrosia`, `747Ambrosia`)
and Lebedev; its exit is the airfield's helicopter, which does not need Lebedev dead.

### 03.1 Maps and arrival

| Map | Actors | Level info (`MapName`; `MissionLocation`) | Startup text | Script | Arrives from | Leaves to |
| --- | --- | --- | --- | --- | --- | --- |
| `03_NYC_747` | 525 | 03_NYC_747; NYC - 747 Airplane | - | Mission03 | 03_NYC_Hangar#747CargoEnt/747PassEnt x2 | 03_NYC_Hangar#747PassExit |
| `03_NYC_Airfield` | 2860 | 03_NYC_Airfield; NYC - Airfield | - | Mission03 | 03_NYC_AirfieldHeliBase#BHElevatorExit/ToOcean x2; 03_NYC_Hangar#HangarExit | 04_NYC_UNATCOIsland (path CameraPath); 03_NYC_AirfieldHeliBase#BHElevatorEnt/FromOcean x2; 03_NYC_Hangar#HangarEnt |
| `03_NYC_AirfieldHeliBase` | 1970 | 03_NYC_AirfieldHeliBase; NYC - Helibase | New York City / Unknown Location | Mission03 | 03_NYC_Airfield#BHElevatorEnt/FromOcean x2; 03_NYC_MolePeople#SewerEnt | 03_NYC_Airfield#BHElevatorExit/ToOcean x2; 03_NYC_MolePeople#SewerExit |
| `03_NYC_BatteryPark` | 1117 | 03_NYC_BatteryPark; NYC - Battery Park | New York City, / Battery Park | Mission03 | 03_NYC_BrooklynBridgeStation#BBSExit; 03_NYC_UNATCOIsland (path Camera1) | 03_NYC_BrooklynBridgeStation#FromNYCStreets |
| `03_NYC_BrooklynBridgeStation` | 1247 | 03_NYC_BrooklynBridgeStation; NYC - Brooklyn Bridge | New York City,  / Brooklyn Bridge Station | Mission03 | 03_NYC_BatteryPark#FromNYCStreets; 03_NYC_MolePeople#MoleExit | 03_NYC_MolePeople#MoleEnt; 03_NYC_BatteryPark#BBSExit |
| `03_NYC_Hangar` | 660 | 03_NYC_Hangar; NYC - Hangar | - | Mission03 | 03_NYC_747#747PassExit; 03_NYC_Airfield#HangarEnt | 03_NYC_Airfield#HangarExit; 03_NYC_747#747CargoEnt/747PassEnt x2 |
| `03_NYC_MolePeople` | 699 | 03_NYC_MolePeople; NYC - Mole Tunnels | - | Mission03 | 03_NYC_AirfieldHeliBase#SewerExit; 03_NYC_BrooklynBridgeStation#MoleEnt | 03_NYC_BrooklynBridgeStation#MoleExit; 03_NYC_AirfieldHeliBase#SewerEnt |
| `03_NYC_UNATCOHQ` | 1441 | 03_NYC_UNATCOHQ; NYC - UNATCO HQ | - | Mission03 | 03_NYC_UNATCOIsland#unatcohq | 03_NYC_UNATCOIsland#unatcoisland |
| `03_NYC_UNATCOIsland` | 905 | 03_NYC_UNATCOIsland; NYC - Liberty Island | New York City,  / Liberty Island / UNATCO Headquarters | Mission03 | 02_NYC_BatteryPark; 02_NYC_Warehouse (path CameraPath); 03_NYC_UNATCOHQ#unatcoisland | 03_NYC_BatteryPark (path Camera1); 03_NYC_UNATCOHQ#unatcohq |

* **Arrival.** `02_NYC_BatteryPark` `MapExit0` or `02_NYC_Warehouse` `MapExit0` -> `03_NYC_UNATCOIsland` (no portal). Mission change 2 -> 3: `Save\Current` wiped, `DeleteExpiredFlags(3)`.
* **Inside.** Island <-> HQ by teleporters (`unatcohq`, `unatcoisland`); Island -> Battery Park by `MapExit0` (camera `Camera1`, tag `ChopperLeave`, the chopper with Jock); Battery Park <-> Brooklyn Bridge Station <-> Mole People <-> Airfield Heli Base (`SewerEnt`/`SewerExit`)
  <-> Airfield (`BHElevatorEnt`/`BHElevatorExit` and `ToOcean`/`FromOcean`) <-> Hangar <-> 747 (cargo and passenger doors).
* **Leaving.** `03_NYC_Airfield` `MapExit0` (camera `CameraPath`) -> `04_NYC_UNATCOIsland.dx` (the destination string carries the `.dx`), tag `MoveHelicopter`.

| Map | Actor | At | Leads to | Fired by (events targeting its tag) |
| --- | --- | --- | --- | --- |
| `03_NYC_Airfield` | MapExit `MapExit0` | 3370,-2868,278 | `04_NYC_UNATCOIsland.dx` (path `CameraPath`) | tag `MoveHelicopter`: Dispatcher Dispatcher0 |
| `03_NYC_UNATCOIsland` | MapExit `MapExit0` | -5756,2510,-10 | `03_NYC_BatteryPark` (path `Camera1`) | tag `ChopperLeave`: Dispatcher Dispatcher0 |

**03_NYC_Airfield MapExit0 -> 04_NYC_UNATCOIsland** (tag `MoveHelicopter`)

```text
event MoveHelicopter
  Dispatcher Dispatcher0 (OutEvents) tag HelicopterPickUp
    event HelicopterPickUp
      BlackHelicopter BlackHelicopter0 (Event)
      conversation event Trigger "HelicopterPickUp" in M03JockLeave branch Ready
        conversation M03JockLeave [talk bump/frob/radius 240; owner Jock]
          starts: its actor (bump/frob/radius 240)
          flag DL_Airfield_Played (set when conversation DL_Airfield ends): 
            conversation DL_Airfield [DL bump/frob; owner JCDenton]
```

**03_NYC_UNATCOIsland MapExit0 -> 03_NYC_BatteryPark** (tag `ChopperLeave`)

```text
event ChopperLeave
  Dispatcher Dispatcher0 (OutEvents) tag ChopperExit
    event ChopperExit
      conversation event Trigger "ChopperExit" in JockBarks branch Ready
        conversation JockBarks [ovh bump/frob/radius 300; owner Jock]
          starts: its actor (bump/frob/radius 300)
          flag !DL_Airfield_Played (set when conversation DL_Airfield ends): 
            conversation DL_Airfield [DL bump/frob; owner JCDenton]
```

### 03.2 Mission script `Mission03`

`.cache/research/src/DeusEx/Mission03.uc`, 366 lines.

* `FirstFrame` (`:12-102`): in the heli base, airfield, hangar and 747, if `MeetLebedev_Played` or `JuanLebedev_Dead` (a return visit after the Lebedev scene) every `Terrorist` and `SecurityBot3` is destroyed; the `UNATCOTroop`s tagged `UNATCOTroop` enter the world (heli base, airfield, hangar); the airfield
  also unhides the `BlackHelicopter`, untriggers cameras and turrets and unhides Gunther; the hangar destroys Paul.
* `PreTravel` (`:110-113`): `Super` only. No `SendPlayer`/`ClientTravel`.
* `Timer` (`:121-362`), per map: HQ: `SimonsOverheard_Played` -> Walton walks to `SimonsInterrogating` (`MS_SimonsWalking`, expiration 4), `UnlockDoor` unlocks the `Manderley_Office` movers, `AnnaAtDesk`/`AnnaInOffice` set Anna's home base. Heli base, airfield, 747: when a barrel flag
  (`HelicopterBaseAmbrosia`, `BoatDocksAmbrosia`, `747Ambrosia`) is set, `DL_TaggedOne/Two/Three` by how many are set (`Barrel1/2/3Checked`, expiration 4). Airfield: Gunther unhidden after the Lebedev scene. 747: Anna unhidden when `JuanLebedev_Dead`
  or after the scene; **Lebedev's carcass is classified by who killed it** (`:298-323`): `KillerBindName` `JCDenton` or empty -> `GoalCompleted('AssassinateLebedev')` and `PlayerKilledLebedev` (expiration 6); `AnnaNavarre` -> `AnnaKilledLebedev` (6); anyone else ->
  `JuanLebedev_Dead` (permanent); no carcass and no pawn with `JuanLebedev_Dead` -> `PlayerKilledLebedev`. Mole People: `MolePeopleSlaughtered` (4) when fewer than 4 pawns tagged `MolePeople` remain, `MoleTerroristsDefeated` (4) when fewer than 3 `MoleTerrorist`s;
  Brooklyn Bridge Station: `JugHeadGangDefeated` (4) when no `ThugMale2` remains.
* Flags it sets that outlive the mission: `PlayerKilledLebedev`, `AnnaKilledLebedev` (6), `JuanLebedev_Dead` (0); the rest have expiration 4. The map's own FlagTriggers/conversations set the barrel flags and `MeetLebedev_Played`.
* Actors it touches: `WaltonSimons`, `AnnaNavarre`, `GuntherHermann`, `JuanLebedev(Carcass)`, `PaulDenton`, `BlackHelicopter`, `Terrorist`, `SecurityBot3`, `UNATCOTroop`, `SecurityCamera`, `AutoTurret`, `DeusExMover Manderley_Office`.

Generated from the script's calls (`inventory-campaign.mjs scripts`; `:N` is the first line):

* **Flags set** (17; `eN` = explicit expiration N, otherwise the default): `MS_SimonsWalking` e4 (:148), `SimonsInterrogating` e4 (:159), `MS_MoverUnlocked` e4 (:172), `MS_AnnaDeskHome` e4 (:180), `MS_AnnaOfficeHome` e4 (:188), `Barrel1Checked` e4 (:211), `Barrel2Checked` e4 (:235), `MS_GuntherUnhidden` e4 (:247), `MS_Anna747Unhidden` e4 (:260), `Barrel3Checked` e4 (:281), `MS_AnnaUnhidden` e4 (:293), `PlayerKilledLebedev` e6 (:309), `AnnaKilledLebedev` e6 (:312), `JuanLebedev_Dead` e0 (:314), `MolePeopleSlaughtered` e4 (:335), `MoleTerroristsDefeated` e4 (:346), `JugHeadGangDefeated` e4 (:359).
* **Flags read** (25): `MeetLebedev_Played`, `JuanLebedev_Dead`, `MS_SimonsWalking`, `SimonsOverheard_Played`, `SimonsInterrogating`, `MS_MoverUnlocked`, `UnlockDoor`, `AnnaAtDesk`, `MS_AnnaDeskHome`, `AnnaInOffice`, `MS_AnnaOfficeHome`, `Barrel1Checked`, `HelicopterBaseAmbrosia`, `BoatDocksAmbrosia`, `747Ambrosia`, `Barrel2Checked`, `MS_GuntherUnhidden`, `MS_Anna747Unhidden`, `Barrel3Checked`, `MS_AnnaUnhidden`, `PlayerKilledLebedev`, `AnnaKilledLebedev`, `MolePeopleSlaughtered`, `MoleTerroristsDefeated`, `JugHeadGangDefeated`.
* **InfoLinks it starts**: `DL_TaggedOne` (:205), `DL_TaggedTwo` (:207), `DL_TaggedThree` (:209). **Conversations it starts by name**: none. **Goals it completes**: `AssassinateLebedev` (:308).
* **Spawns**: none. **Destroy calls**: 9; **EnterWorld/LeaveWorld calls**: 8. **Travel calls**: none.

### 03.3 Conversations and InfoLinks

187 conversations of the list besides the shared barks: 13 InfoLinks, 53 talk-type, 121 overheard. 11 have choices (vending: `MeetSmuggler`, `Doctor1Barter`; trades:
`MeetLenny` (a LAM for a vial of zyme), `ElReyScared`, `M03MeetJugHead` (kill the drug dealer for the Rooks), `MeetFordSchickQuestion`; and the exit's `M03JockLeave`), 33 set flags, 115 need a flag, 17 add or complete goals.

**Choices.** Every choice that changes state, the block its speech jumps to and what that block does (choices that change no state are counted in one row per conversation):

| Conversation | Owner | Choice | Effects of the branch |
| --- | --- | --- | --- |
| `MeetSmuggler` | Smuggler | I'll give you 2100 for the scope. [needs !M03BoughtScope, M03CanBuyScope] | -> BuyScope: set M03BoughtScope, give WeaponModScope |
| `MeetSmuggler` | Smuggler | How about you give me the bioelectric cell for 750? [needs !M03BoughtCell, M03CanBuyCell] | -> BuyCell: set M03BoughtCell, give BioelectricCell |
| `MeetSmuggler` | Smuggler | Sell me the Light Amplification Goggles for 3375. [needs !M03BoughtGoggles, M03CanBuyGoggles] | -> BuyGoggles: set M03BoughtGoggles, give TechGoggles |
| `MeetSmuggler` | Smuggler | Too expensive. Maybe I'll try to locate your friend. | -> NotInterested: trig BotToNeutral |
| `MeetSmuggler` | Smuggler | I'll take the scope for 700. [needs !M03BoughtScope, M03CanBuyScope] | -> BuyScopeCheap: set M03BoughtScope, give WeaponModScope |
| `MeetSmuggler` | Smuggler | 700's a bargain on that scope, but I'm low on cash. [needs !M03CanBuyScope, !M03BoughtScope] | -> NotInterested: trig BotToNeutral |
| `MeetSmuggler` | Smuggler | Here's 250 for the bioelectric cell. [needs !M03BoughtCell, M03CanBuyCell] | -> BuyCellCheap: set M03BoughtCell, give BioelectricCell |
| `MeetSmuggler` | Smuggler | I'd take the bioelectric cell for 250 if I had the cash. [needs !M03BoughtCell, !M03CanBuyCell] | -> NotInterested: trig BotToNeutral |
| `MeetSmuggler` | Smuggler | 1125 for Light Amplification Goggles? Sure. [needs !M03BoughtGoggles, M03CanBuyGoggles] | -> BuyGogglesCheap: set M03BoughtGoggles, give TechGoggles |
| `MeetSmuggler` | Smuggler | 1125 for Light Amplification Goggles sounds fair, but I don't have the [needs !M03BoughtGoggles, !M03CanBuyGoggles] | -> NotInterested: trig BotToNeutral |
| `MeetSmuggler` | Smuggler | Not interested. | -> NotInterested: trig BotToNeutral |
| `MeetSmuggler` | Smuggler | (3 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `MeetFordSchickQuestion` | FordSchick | Make a break for it. I'll protect you. | -> Go: set FordRan, trig FordExit |
| `MeetFordSchickQuestion` | FordSchick | (1 further choice that change no state: refusals, "never mind", unaffordable offers) | - |
| `VeteranConvos` | Veteran | I'll take both of them for 600. [needs !M03Bought3006_1, !M03Bought3006_2, M03CanBuyBoth3006] | -> BuyBoth: set M03Bought3006_1, set M03Bought3006_2, set M03VeteranDone, give Ammo3006 |
| `VeteranConvos` | Veteran | Here's 300 for one clip. [needs M03CanBuy3006] | -> BuyOne: set M03Bought3006_1, give Ammo3006 |
| `VeteranConvos` | Veteran | (2 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `MeetLenny` | Lenny | Suppose I could part with a vial of zyme, if you'll give me the LAM. | -> Trade: set LennyDone, set LAMSkillPoints, give WeaponLAM, take VialCrack |
| `MeetLenny` | Lenny | (1 further choice that change no state: refusals, "never mind", unaffordable offers) | - |
| `M03MeetJugHead` | JugHead | I'll take the LAM for 750. [needs M03CanAffordLAM] | -> BuyLAM: set JugheadDone, set LAMSkillPoints, give WeaponLAM |
| `M03MeetJugHead` | JugHead | (3 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `ElReyScared` | JugHead | I want more. Either your life is worth more than a LAM, or it's not wo | -> More: set ElReyScaredDone, trig ElReyAttacks |
| `ElReyScared` | JugHead | (1 further choice that change no state: refusals, "never mind", unaffordable offers) | - |
| `M03JockLeave` | Jock | I'm ready. Let's move out. | -> Ready: trig HelicopterPickUp |
| `M03JockLeave` | Jock | (1 further choice that change no state: refusals, "never mind", unaffordable offers) | - |
| `HaroldConvos` | Harold | Here's 400 for the recoil weapon mod. [needs !M03BoughtRecoil, M03CanBuyRecoil] | -> BuyRecoil: set M03BoughtRecoil, give WeaponModRecoil |
| `HaroldConvos` | Harold | I'll take the shotgun shells for 300. [needs !M03BoughtShells, M03CanBuyShells] | -> BuyShells: set M03BoughtShells, give AmmoShell |
| `HaroldConvos` | Harold | (3 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `M03MeetFilben` | HarleyFilben | Fine. 1000 for where I can find the code to the phone booth. [needs !PlayerKnowsUnderworldPassword, !M03FoundUnderground] | -> UnderworldAnswerExpensive: set PlayerKnowsUnderworldPassword, set KnowsOfMolePeople, set FilbenToldAboutCurly, set M03FilbenDoneSelling |
| `M03MeetFilben` | HarleyFilben | (3 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `M03DrugDealerConvos` | DrugDealer | I'll take a vial of zyme. [needs M03Have120] | -> BuyVial: give Vialcrack |
| `M03DrugDealerConvos` | DrugDealer | What do you know about a gang called the rooks? [needs !M03DrugDealerChat1, KnowsOfJughead] | -> Gang: set M03DrugDealerChat1, set KnowsOfJunkiesLAMs |
| `M03DrugDealerConvos` | DrugDealer | Tell me what you've heard about the NSF. [needs !M03DrugDealerChat0, !KnowsOfMolePeople] | -> Interrogate: set M03DrugDealerChat0 |
| `M03DrugDealerConvos` | DrugDealer | Know where I can find the mole people? [needs !M03DrugDealerChat0, KnowsOfMolePeople] | -> Interrogate: set M03DrugDealerChat0 |
| `M03DrugDealerConvos` | DrugDealer | I'm with UNATCO. Start talking. [needs !M03DrugDealerChat2, M03DrugDealerChat0] | -> Chat2: set M03DrugDealerChat2, trig DrugDealerAttacks |
| `M03DrugDealerConvos` | DrugDealer | (2 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `MeetDon` | Don | Take a vial. [needs M03GotCrack] | -> GiveCrack: set DonDone, take Vialcrack |
| `MeetDon` | Don | I hear someone found a box of LAMs down here. [needs KnowsOfJunkiesLAMs, !DonLAMComment] | -> LAMComment: set DonLAMComment |
| `MeetDon` | Don | Sorry. | -> Sorry: set DonSorryQuestion |

**Conversations that change state** (choices, flags set, goals, items, events, skill points; the `Needs` column is kept on these rows):

| Conversation | Owner (BindName; maps with that actor) | Kind | Choices | Sets | Needs | Goals | Other |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `SmugglerThanks` | Smuggler (other missions) | talk bump/frob |  | SmugglerThankedPlayer, SmugglerLamenting@SchickDead | req FordSchickRescueDone, req MeetSmuggler_Played, req !SmugglerThankedPlayer, ? FordSchick_Dead, ? SmugglerDoneVending, ? FordSchickRescued, ? !SmugglerThanksTag |  |  |
| `MeetSmuggler` | Smuggler (other missions) | talk radius 80 once | 14 | MetSmuggler, PlayerHeardAboutSmuggler, GotSchickGoal, SmugglerLamenting@SchickDead, SmugglerThankedPlayer@RescueAlreadyDone, M03SmugglerGaveOptions@YuckyHack, M03SmugglerGaveOptions@Choices (+19 more) | ? FordSchickRescued, ? FordSchick_Dead, ? M03SmugglerGaveOptions, ? !SmugglerThanksTag, ? M03BoughtCell, ? M03BoughtGoggles, ? M03BoughtScope, ? !KnowsSmugglerPassword | +S RescueFordSchick, +note | trig BotToNeutral, give NanoKey, give TechGoggles, give BioelectricCell, give WeaponModScope, cr -8300 |
| `SckickThanks` | FordSchick (other missions) | ovh radius 200 once |  | SchickThankedPlayer@Hop | req !SchickThankedPlayer, req FordSchickRescued |  | sp 80 |
| `MeetFordSchickRescue` | FordSchick (other missions) | talk bump/frob/radius 120 |  | MetFord | req MeetSmuggler_Played, req !FordRan, ? MetFord |  |  |
| `MeetFordSchickQuestion` | FordSchick (other missions) | talk bump/frob/radius 120 | 2 | MetFord, FordRan@Go | req !MeetSmuggler_Played, req !FordRan, ? MetFord |  | trig FordExit |
| `DL_WelcomeBack` | JCDenton | DL once |  |  |  | +P ReportToManderley |  |
| `DL_TaggedTwo` | JCDenton | DL once |  |  | ? !747Ambrosia | +S LastBarrel747 |  |
| `DL_TaggedThree` | JCDenton | DL once |  | BarrelsTagged |  | done FindAmbrosiaBarrels, done LastBarrel747 |  |
| `DL_TaggedOne` | JCDenton | DL once |  |  |  | +S FindAmbrosiaBarrels |  |
| `DL_LebedevKill` | JCDenton | DL once |  |  |  | done LocateAirfield, +P AssassinateLebedev | give Image03_NYC_Airfield |
| `dl_gochopper` | JCDenton | DL once |  |  |  | done AssassinateLebedev, +P GoToHelicopter |  |
| `DL_AlexShocked` | JCDenton | DL once |  | M03PlayerKilledAnna | ? AnnaEntrance_Played, ? !PlayerKilledLebedev |  |  |
| `DL_Airfield` | JCDenton | DL once |  |  |  | +note |  |
| `SimonsInterrogating` | WaltonSimons (NYC_UNATCOHQ) | ovh radius 400 once |  |  | req SimonsInterrogating, req !Prisoner1_Dead, req !Prisoner2_Dead |  | trig EveryoneWalking |
| `SimonsBarks` | WaltonSimons (NYC_UNATCOHQ) | ovh radius 400 |  | SimonsAssassination@A4 | req SimonsInterrogating3_Played, req !Prisoner1_Dead, req !Prisoner2_Dead, req !SimonsAssassination, ? SimonsAssassination |  | trig SimonsAttacks |
| `VeteranConvos` | Veteran (NYC_BatteryPark) | talk bump/frob | 4 | M03CanBuy3006=0@ChoiceStart, M03CanBuyBoth3006=0@ChoiceStart, M03Bought3006_1@BuyOne, M03Bought3006_1@BuyBoth, M03Bought3006_2@BuyBoth, M03VeteranDone@BuyBoth, M03Bought3006_2@BuyAgain, M03VeteranDone@BuyAgain (+3 more) | req !M03VeteranDone, ? VeteranConvos_Played, ? M03Bought3006_1 |  | give Ammo3006, give Ammo3006*2, cr -900 |
| `TroopBarks2` | UNATCOTroop (NYC_AirfieldHeliBase, NYC_Hangar, NYC_UNATCOHQ, ...) | ovh |  | M03TrooperBarkHack=0@Troop2 | req NeverTrue, ? M01PlayerAggressive, ? GuntherRespectsPlayer, ? TenderloinSlaughter, ? BatteryParkSlaughter, ? M02MechSlur |  |  |
| `TroopBarks1` | UNATCOTroop (NYC_AirfieldHeliBase, NYC_Hangar, NYC_UNATCOHQ, ...) | ovh |  | M03TrooperBarkHack@Troop1 | req NeverTrue, ? M01PlayerAggressive, ? TenderloinSlaughter, ? BatteryParkSlaughter |  |  |
| `M03MeetTerroristLeader` | TerroristLeader (NYC_MolePeople) | talk radius 100 once |  |  | req !M03TerroristLeaderAttacked, ? ToldAboutAmbrosiaThruMoleArea, ? MoleBathroomComment |  | trig Surrender, sp 100 |
| `CarterGreeting03` | SamCarter (NYC_UNATCOHQ) | talk radius 90 |  | M03GotMod@Continue, M03CarterDone@Continue, M03GotTool@Continue, M03GotMod@SkipResume, M03GotTool@SkipResume, M03CarterDone@SkipResume, M03UNATCOBriefingsDone@AllDone, M03GotMod@SubsequentVisit, M03GotTool@SkipMod (+1 more) | req !M03CarterDone, ? CarterGreeting03_Played, ? BatteryParkSlaughter, ? !BatteryParkSlaughter, ? !AmbrosiaTagged, ? ManderleyDebriefing02_Played, ? M03GotMod, ? M03GotTool, ? TenderloinSlaughter | done SeeCarter | give WeaponModAccuracy, give Multitool*2, give Ammo762mm |
| `M03MeetPaul` | PaulDenton (NYC_Hangar) | talk bump/frob/radius 120 once |  | ToldOffPaul@Dead | ? NiceTerrorist_Dead, ? M03MeetPaul_Played |  | trig PaulMoves |
| `M03MolePersonBarks` | MolePerson (NYC_MolePeople) | ovh bump/frob |  | M03MoleWifeLament@WifeDead | ? MoleFemale_Dead, ? MolePeopleSlaughtered, ? M03MoleWifeLament |  |  |
| `M03MoleFemaleBarks` | MoleFemale (NYC_MolePeople) | ovh bump/frob |  | M03MoleSonLament@SonDead | ? MoleKid_Dead, ? MolePeopleSlaughtered, ? M03MoleSonLament |  |  |
| `MeetLenny` | Lenny (NYC_BrooklynBridgeStation) | talk bump/frob | 2 | LennyDone@Trade, LAMSkillPoints@Trade | req !LennyDone, req !FoundMoles, ? MeetLenny_Played, ? LAMSkillPoints, ? DrugDealer_Dead |  | give WeaponLAM, take VialCrack, has? Vialcrack, sp 100 |
| `MeetKevinBradley` | KevinBradley (NYC_MolePeople) | talk bump/frob once |  | ToldAboutAmbrosiaThruMoleArea, MoleBathroomComment | ? TerroristLeader_Dead, ? !M03MeetTerroristLeader_Played, ? M03MeetTerroristLeader_Played | +note | sp 25 |
| `M03MeetJugHead` | JugHead (NYC_BrooklynBridgeStation) | talk bump/frob | 4 | KnowsOfJughead, M03CanAffordLAM=0@ChoiceBegin, JugheadDone@BuyLAM, LAMSkillPoints@BuyLAM, M03CanAffordLAM@CanAffordLAM, JugheadReadyToGive@GiveReturn, JugheadGave@Give, JugheadDone@Give, JugheadThanked@Give (+1 more) | req !JugheadGangDefeated, req !JugheadDone, ? JugheadReadyToGive, ? M03MeetJugHead_Played, ? DrugDealer_Dead, ? KnowsOfJughead, ? !DrugDealer_Unconscious, ? DrugDealer_Unconscious, ? LAMSkillPoints | +S KillDealer, done KillDealer | give WeaponLAM, sp 200, cr -750 |
| `JugheadThanks` | JugHead (NYC_BrooklynBridgeStation) | talk bump/frob once |  | JugheadThanked | req JugheadDone, req !JugheadThanked, req DrugDealer_Dead, req !JugheadGangDefeated, req !DrugDealer_Unconscious |  |  |
| `ElReyScared` | JugHead (NYC_BrooklynBridgeStation) | talk bump/frob/radius 100 | 2 | ElReyScaredDone@More, ElReyScaredDone@Transfer | req JugheadGangDefeated, req !ElReyScaredDone, ? ElReyScared_Played |  | trig ElReyAttacks, give WeaponLAM |
| `MeetLebedev3` | JuanLebedev (NYC_747) | talk bump/frob once |  | KnowsOfTracerTong, LebedevAward | req MeetLebedev2_Played, req !AnnaNavarre_Dead, ? LebedevAward |  | trig AnnaAttacks, sp 175 |
| `MeetLebedev2` | JuanLebedev (NYC_747) | talk bump/frob once |  | LebedevAward@Majestic2 | req AlwaysFalse, ? AnnaNavarre_Dead, ? LebedevAward |  | sp 200 |
| `ManderleyDebriefing02` | JosephManderley (NYC_UNATCOHQ) | talk radius 200 once |  | M03UNATCOBriefingsDone@AllDone | ? EscapeSuccessful, ? !SubHostageFemale_Dead, ? !SubHostageMale_Dead, ? SubTerroristsDead, ? !AmbrosiaTagged, ? KnowsOfJoJo, ? TenderloinSlaughter, ? HeardGrenadeTalk, ? CarterGreeting03_Played, ? M02QuestionedGreen (+1 more) | +P LocateAirfield, done ReportToManderley, +S SeeCarter, +note | cr 3400 |
| `M03JockLeave` | Jock (NYC_Airfield, NYC_UNATCOIsland) | talk bump/frob/radius 240 | 2 |  | req DL_Airfield_Played, ? M03JockLeave_Played |  | trig HelicopterPickUp |
| `JockBarks` | Jock (NYC_Airfield, NYC_UNATCOIsland) | ovh bump/frob/radius 300 |  |  | req !DL_Airfield_Played, ? ManderleyDebriefing02_Played |  | trig ChopperExit |
| `JimmyHint` | Jimmy (NYC_MolePeople) | talk bump/frob once |  |  | ? TerroristLeader_Dead, ? M03MeetTerroristLeader_Played | +note |  |
| `ReyesGreeting03` | JaimeReyes (NYC_UNATCOHQ) | talk bump/frob once |  |  |  |  | trig JaimeWanders |
| `InjuredTrooper1Barks` | InjuredTrooper1 (NYC_UNATCOHQ) | ovh bump/frob/radius 80 |  | M03InjuredTrooperWaiting@A1, M03InjuredTrooperWaiting=0@MetInjuredGuy | ? M03InjuredTrooperWaiting, ? MeetInjuredTrooper2_Played |  |  |
| `HaroldConvos` | Harold (NYC_Hangar) | talk bump/frob | 5 | M03CanBuyRecoil=0@ChoiceStart, M03CanBuyShells=0@ChoiceStart, HaroldDone@Done, M03BoughtRecoil@BuyRecoil, M03BoughtShells@BuyShells, M03CanBuyRecoil@CanBuyRecoil, M03CanBuyShells@CanBuyShells | req !HaroldDone, ? HaroldConvos_Played, ? MeetLebedev_Played, ? JuanLebedev_Dead, ? M03BoughtRecoil, ? M03BoughtShells |  | give WeaponModRecoil, give AmmoShell, cr -700 |
| `M03MeetFilben` | HarleyFilben (NYC_BatteryPark) | talk bump/frob | 4 | KnowsAboutUnderworld, PlayerMetFilben@FirstMeeting, FilbenAirportAnswer@AirfieldAnswer, PlayerKnowsUnderworldPassword@UnderworldContinue, KnowsOfMolePeople@UnderworldContinue, FilbenToldAboutCurly@UnderworldContinue (+4 more) | req !M03FilbenDone, ? M03MeetFilben_Played, ? !FilbenAirportAnswer, ? !M01PlayerMetFilben, ? !PlayerMetFilben, ? TerroristCommander_Dead, ? !TerroristCommander_Unconscious, ? !FilbenGaveKey, ? PlayerKnowsPhoneCode (+5 more) | +note | sp 55, cr -1500 |
| `M03DrugDealerConvos` | DrugDealer (NYC_BrooklynBridgeStation) | talk bump/frob | 7 | M03Have120=0@BeginChoices, M03Have120@Have120, M03DrugDealerChat1@Gang, KnowsOfJunkiesLAMs@Gang, M03DrugDealerChat0@Interrogate, M03DrugDealerChat2@Chat2 | ? M03DrugDealerConvos_Played | +note | trig DrugDealerAttacks, give Vialcrack, cr -250 |
| `MeetDon` | Don (NYC_BrooklynBridgeStation) | talk bump/frob | 3 | M03GotCrack=0, M03GotCrack, DonDone@GiveCrack, DonSorryQuestion@Sorry, DonLAMComment@LAMComment | req !DonDone, req !FoundMoles, ? DonLAMComment, ? !M03GotCrack, ? !KnowsOfJunkiesLAMs, ? KnowsOfMolePeople, ? DonSorryQuestion, ? DonDone | +note | take Vialcrack, has? Vialcrack |
| `CurlyWomanOverheard` | CurlyWoman (NYC_BatteryPark) | ovh radius 330 |  | CurlyWomanDone@A3 | req !CurlyWomanDone |  |  |
| `MeetCurly` | Curly (NYC_BatteryPark) | talk bump/frob |  | KnowsAboutUnderworld, KnowsOfMolePeople, CurlyHack1, PlayerKnowsPhoneCode@PasswordContinue, GaveCurlyPassword@PasswordContinue, CurlyHack2@KnowsContinue | req !M03FoundUnderground, req !PlayerKnowsPhoneCode, ? FilbenToldAboutCurly, ? MeetCurly_Played, ? PlayerKnowsUnderworldPassword, ? CurlyHack1, ? CurlyHack2 | +S TalkToCharlie, +note | sp 175 |
| `CurlyBarks` | Curly (NYC_BatteryPark) | ovh bump/frob |  | CurlyA3BarkPlayed@A3 | req PlayerKnowsPhoneCode, ? M03FoundUnderground, ? FoundMoles, ? !FoundMoles, ? CurlyA3BarkPlayed | +note |  |
| `MeetCharlieFann` | CharlieFann (NYC_BrooklynBridgeStation) | talk bump/frob once |  | KnowsOfJughead@continue | req !FreshWaterOpened, req !FoundMoles, ? !KnowsOfMolePeople, ? JugheadDone | done TalkToCharlie, +S OpenFreshWater |  |
| `FannSatisfied` | CharlieFann (NYC_BrooklynBridgeStation) | talk bump/frob once |  | KnowsMolePassword@resume | req FreshWaterOpened, req !FoundMoles, ? !MeetCharlieFann_Played | done TalkToCharlie, done OpenFreshWater, +note | sp 25 |
| `FannFinalBarks` | CharlieFann (NYC_BrooklynBridgeStation) | ovh bump/frob |  |  | req FoundMoles | done TalkToCharlie |  |
| `AnnaUNATCOBarks3` | AnnaNavarre (NYC_747, NYC_UNATCOHQ) | ovh bump/frob/radius 160 |  |  | req ManderleyDebriefing02_Played, req !DL_Airfield_Played, ? AnnaManderley2_Played |  | trig AnnaDoneTalking |
| `AnnaManderley2` | AnnaNavarre (NYC_747, NYC_UNATCOHQ) | ovh radius 300 once |  |  | req ManderleyDebriefing02_Played, req AnnaManderley1_Played, req !DL_Airfield_Played, ? BatteryParkSlaughter |  | trig AnnaDoneTalking |
| `AnnaExcuse` | AnnaNavarre (NYC_747, NYC_UNATCOHQ) | ovh bump/frob/radius 100 once |  |  | req AnnaEntrance_Played, req AnnaKilledLebedev | done AssassinateLebedev, +P GoToHelicopter |  |
| `AnnaEntrance` | AnnaNavarre (NYC_747, NYC_UNATCOHQ) | talk bump/frob/radius 200 once |  |  | req DL_Airfield_Played, ? PlayerKilledLebedev, ? !AnnaThanks_Played, ? M02MechSlur | +P GoToHelicopter, done AssassinateLebedev | trig AnnaPosition |
| `AnnaCongrats` | AnnaNavarre (NYC_747, NYC_UNATCOHQ) | ovh bump/frob/radius 100 once |  |  | req PlayerKilledLebedev, req AnnaEntrance_Played | done AssassinateLebedev, +P GoToHelicopter |  |

Conversations that only wait for a flag or check one, and change no state (90; `?` = a `CheckFlag` event): `GuntherHermann_BarkFutz` (? GuntherRespectsPlayer), `SmugglerWaiting` (!FordSchickRescueDone, MeetSmuggler_Played, !SmugglerDoneVending), `SmugglerVending` (!SmugglerLamenting, !SmugglerDoneVending, SmugglerThankedPlayer), `SmugglerLamenting` (SmugglerLamenting, ? !GotSchickGoal), `SmugglerDoneVending` (SmugglerDoneVending (+1 more)), `FordBarks` (FordRan, ? FordSchickRescued (+2 more)), `DL_MissionDone` (? PlayerKilledLebedev), `SimonsWalking2` (SimonsOverheard_Played (+2 more)), `SimonsWalking` (SimonsOverheard_Played (+2 more)), `SimonsPissed2` (SimonsInterrogating, Prisoner2_Dead (+1 more)), `SimonsPissed` (Prisoner1_Dead, SimonsInterrogating (+1 more)), `SimonsInterrogating3` (SimonsInterrogating2_Played (+2 more)), `SimonsInterrogating2` (SimonsInterrogating_Played (+2 more)), `SimonsFrobbed2` (SimonsInterrogating, !Prisoner1_Dead (+2 more)), `SimonsFrobbed` (MeetWalton_Played (+1 more)), `SimonsExecuted` (SimonsAssassination, Prisoner1_Dead (+1 more)), `MeetWalton` (SimonsOverheard_Played, !SimonsInterrogating), `M03VeteranBarks` (M03VeteranDone), `TroopBarksMain` (!DL_Airfield_Played (+1 more)), `CleanupTroopBarksHack` (DL_Airfield_Played), `TerroristLeaderBarks` (M03MeetTerroristLeader_Played (+1 more)), `M03ShannonBarks` (? BathroomBarks_Played (+1 more)), `ScottBark2` (ManderleyDebriefing02_Played), `ScottBark` (!ManderleyDebriefing02_Played), `CarterBarks` (M03CarterDone (+1 more)), `PrivateLloydBark` (? ManderleyDebriefing02_Played (+1 more)), `PrisonGuard1Bark` (? SimonsInterrogating_Played (+2 more)), `Prisoner2Bark` (MeetPrisoner2Three_Played), `MeetPrisoner2Two` (MeetPrisoner2_Played, ? !SimonsInterrogating_Played), `MeetPrisoner2Three` (MeetPrisoner2Two_Played, ? !SimonsInterrogating_Played), `M03PaulWaiting2` (M03MeetPaul2_Played (+2 more)), `M03PaulWaiting` (M03MeetPaul2_Played (+1 more)), `M03PaulPissed` (!ToldOffPaul, NiceTerrorist_Dead), `M03MeetPaul22` (M03MeetPaul_Played, NiceTerrorist_Dead, ToldOffPaul), `M03MeetPaul2` (M03MeetPaul_Played, !NiceTerrorist_Dead), `Crate2SurrenderFrob` (M03MeetTerroristLeader_Played), `Crate2Surrender` (CrateNSFOverheard_Played (+1 more)), `Crate1SurrenderFrob` (M03MeetTerroristLeader_Played), `Crate1Surrender` (CrateNSFOverheard_Played (+1 more)), `NiceTerroristBarks` (? M03MeetPaul_Played (+1 more)), `MoleTerroristBarks` (M03MeetTerroristLeader_Played), `LennyFinalBarks2` (FoundMoles), `LennyFinalBarks` (LennyDone, !FoundMoles), `LennyBarks` (!LennyDone, !FoundMoles), `KevinBradleyBarks` (MeetKevinBradley_Played (+3 more)), `jugheadgangBarks` (jugheadgangIntro_played), `M03JugHeadFinalBarks` (ElReyScaredDone), `M03JugHeadBarks3` (JugheadDone, DrugDealer_Dead (+3 more)), `M03JugHeadBarks2` (JugheadDone, DrugDealer_Dead (+2 more)), `M03JugHeadBarks` (JugheadDone, !DrugDealer_Dead (+2 more)), `MeetLebedevAnnaHack` (AlwaysFalse), `MeetLebedev2Trigger` (AnnaEntrance_Played, MeetLebedev_Played, !AnnaNavarre_Dead), `LebedevBarks` (LebedevAnnaDead_Played), `LebedevAnnaDead` (AnnaNavarre_Dead, ? !MeetLebedev2_Played), `ManderleyWaiting` (ManderleyDebriefing02_Played), `JimmyBarks` (JimmyHint_Played), `OverhearLebedev` (!MeetLebedev_Played (+1 more)), `JaniceDone` (ManderleyDebriefing02_Played), `JaniceDenial` (!SimonsOverheard_Played), `JaniceDebriefing` (SimonsOverheard_Played (+1 more)), `ReyesBarks` (ReyesGreeting03_Played), `InjuredTrooperBark` (MeetInjuredTrooper2_Played), `HaroldBarks` (HaroldDone), `FilbenNormalBarks2` (M03FilbenDone (+1 more)), `FilbenNormalBarks` (M03FilbenDone (+1 more)), `FilbenAngryBarks` (TerroristCommander_Dead (+3 more)), `M03MeetGunther` (? PlayerKilledLebedev, ? AnnaNavarre_Dead), `M03GuntherBarks` (M03MeetGunther_Played), `GangMemberFemaleBarks` (? Jughead_Dead (+1 more)), `MeetExMolePerson` (!FoundMoles), `ExMolePersonBarks2` (FoundMoles), `ExMolePersonBarks` (MeetExMolePerson_Played, !FoundMoles), `LAMQuestionHack` (DonDone, !DonLAMComment, KnowsOfJunkiesLAMs, !FoundMoles), `DonReturnBarks` (FoundMoles), `DonFinalBarks2` (DonDone, !DonLAMComment (+2 more)), `DonFinalBarks` (DonDone, DonLAMComment, !FoundMoles (+1 more)), `DonBarks` (!DonDone, !FoundMoles, ? FoundMoles), `CurlyBarks2` (M03FoundUnderground (+1 more)), `FannWaiting` (MeetCharlieFann_Played (+2 more)), `FannBarks` (FreshWaterOpened (+2 more)), `ReadyToGo` (ManderleyDebriefing02_Played (+1 more)), `MeetMiB` (!ManderleyDebriefing02_Played), `BodyguardBarks` (MeetMiB_Played (+1 more)), `AnnaWaiting` (AnnaEntrance_Played (+1 more)), `AnnaUNATCOBarks2` (SimonsOverheard_Played (+2 more)), `AnnaUNATCOBarks` (AnnaAtUNATCO_Played (+3 more)), `AnnaManderley1` (ManderleyDebriefing02_Played (+3 more)), `AnnaHelicopterPleasedBarks` (AnnaCongrats_Played), `AnnaHelicopterBarks` (AnnaExcuse_Played), `AnnaAtUNATCO` (!BoatDocksAmbrosia, !ManderleyDebriefing02_Played, !DL_Airfield_Played, ? AmbrosiaTagged (+5 more)).

Plain InfoLinks, no flag and no event: 4 (listed with their starters in the InfoLink table).

Plain conversations with an actor (10): WaltonSimons: WaltonSimons_BarkAllianceHostile WaltonSimons_BarkAllianceFriendly; GuntherHermann: GuntherHermann_BarkAllianceHostile GuntherHermann_BarkAllianceFriendly; AnnaNavarre: AnnaNavarre_BarkAllianceHostile AnnaNavarre_BarkAllianceFriendly; Prisoner2: MeetPrisoner2; jugheadgang: jugheadgangIntro; JuanLebedev: MeetLebedev; InjuredTrooper2: MeetInjuredTrooper2.

Plain overheard conversations (32): WaltonSimons: WaltonSimons_BarkFutz SimonsOverheard; JosephManderley: JosephManderley_BarkAllianceHostile JosephManderley_BarkAllianceFriendly; AnnaNavarre: AnnaNavarre_BarkFutz; ThugWoman3: GangMemberFemale1Barks; TechBum: M03TechBumBarks; SickWoman: M03SickWomanRadiusBarks M03SickWomanBarks; SickMan: M03SickManBarks; Sally: M03SallyBarks; PrisonGuard2: PrisonGuard2Barks; Prisoner1: Prisoner1Barks; PerimeterGuard: PerimeterGuardBarks; ParkBumFemale2: M03ParkBumFemale2Barks; ParkBumFemale1: M03ParkBumFemale1Barks; ParkBum1: M03ParkBum1Barks; NSFCrate1: CrateNSFOverheard; MoleKid: M03MoleKidBarks; MichaelBerry: MeetMichael; Kid: KidBarks; JunkieFemale: M03JunkieFemaleBarks; Hooker: M03HookerBarks; GangMemberFemale2: GangMemberFemale2Barks; CurlyWoman: CurlyWomanBarks; CorporalCollins: CollinsBarks; CokeTroop: CokeTroopBarks; ClintonGuard: M03ClintonGuardBarks; CleanupTroop: CleanupTroopBarks; BPRiotCop: BPRiotCopBarks; Billy: M03BillyBarks; AnsweringMachine: M03AnsweringMachineMessage.

InfoLinks and what starts them:

| InfoLink | Started by | Needs | Sets / does |
| --- | --- | --- | --- |
| `DL_WelcomeBack` | NYC_UNATCOIsland/DataLinkTrigger0 (-5030,2714), NYC_UNATCOIsland/DataLinkTrigger1 (-4206,2735) |  | +goal ReportToManderley |
| `DL_TaggedTwo` | Mission03.uc:207, Mission03.uc:231, Mission03.uc:277 | !747Ambrosia | +goal LastBarrel747 |
| `DL_TaggedThree` | Mission03.uc:209, Mission03.uc:233, Mission03.uc:279 |  | set BarrelsTagged, done FindAmbrosiaBarrels, done LastBarrel747 |
| `DL_TaggedOne` | Mission03.uc:205, Mission03.uc:229, Mission03.uc:275 |  | +goal FindAmbrosiaBarrels |
| `DL_PaulWarning` | NYC_Hangar/DataLinkTrigger1 (3567,967), NYC_Hangar/DataLinkTrigger2 (3442,307), NYC_Hangar/DataLinkTrigger3 (2587,586), NYC_Hangar/DataLinkTrigger4 (3949,530) |  |  |
| `DL_MissionDone` | (none found) | PlayerKilledLebedev |  |
| `DL_LebedevKill` | NYC_Airfield/DataLinkTrigger0 (-2253,3168), NYC_Airfield/DataLinkTrigger1 (2048,-2433) |  | done LocateAirfield, +goal AssassinateLebedev, give Image03_NYC_Airfield |
| `dl_gochopper` | NYC_Hangar/DataLinkTrigger0 (4855,-469) needs AnnaEntrance_Played |  | done AssassinateLebedev, +goal GoToHelicopter |
| `DL_BoobyTrap` | NYC_AirfieldHeliBase/DataLinkTrigger2 (-11070,3369) |  |  |
| `dl_bbs` | NYC_BrooklynBridgeStation/DataLinkTrigger1 (652,-916) |  |  |
| `dl_batterypark` | NYC_BatteryPark/DataLinkTrigger2 (-1098,2193), NYC_BatteryPark/DataLinkTrigger0 (-1227,2215) |  |  |
| `DL_AlexShocked` | NYC_747/DataLinkTrigger0 (406,-473) needs AnnaNavarre_Dead | AnnaEntrance_Played, !PlayerKilledLebedev | set M03PlayerKilledAnna |
| `DL_Airfield` | NYC_AirfieldHeliBase/DataLinkTrigger0 (-297,2075) |  |  |

**Required (progression) conversations**, from the exit chains: `ManderleyDebriefing02` (HQ, radius 200; adds `LocateAirfield`, `SeeCarter`): `JockBarks` fires `ChopperExit` only when `ManderleyDebriefing02_Played` is set (its `Ready` branch), so the island's
helicopter needs the debriefing; `DL_Airfield` (heli base, `DataLinkTrigger0` at (-297,2075): sets `DL_Airfield_Played`) and `M03JockLeave` (Jock at the airfield, bump/frob/radius 240; its `Ready` choice "I'm ready. Let's move out." fires `HelicopterPickUp`, which
moves the helicopter and the dispatcher fires `MoveHelicopter`). `M03JockLeave` needs `DL_Airfield_Played` (a default-expiration flag: kept through the mission's maps). The assassination
(`DL_LebedevKill`, `AnnaEntrance`/`AnnaCongrats`, `dl_gochopper`) is not on the chain.

### 03.4 Objectives

| Goal | Kind | Text | Added by | Completed by |
| --- | --- | --- | --- | --- |
| `RescueFordSchick` | secondary | Rescue Smuggler's friend Ford Schick from a secret laboratory in the sewers. The sewers are accessed by the grates in the street. | MeetSmuggler | - |
| `ReportToManderley` | primary | Report to Manderley. | DL_WelcomeBack | ManderleyDebriefing02 |
| `LastBarrel747` | secondary | Gain access to the 747 hangar and locate the final barrel. | DL_TaggedTwo | DL_TaggedThree |
| `FindAmbrosiaBarrels` | secondary | Locate the three missing barrels of Ambrosia. UNATCO will send a team to recover them. | DL_TaggedOne | DL_TaggedThree |
| `LocateAirfield` | primary | Locate the airfield where the NSF has moved the Ambrosia. Investigate the subway system, because the terrorists may be hiding underground. | ManderleyDebriefing02 | DL_LebedevKill |
| `AssassinateLebedev` | primary | Assassinate Juan Ivanovich Lebedev. | DL_LebedevKill | dl_gochopper, AnnaExcuse, AnnaEntrance, AnnaCongrats, Mission03.Timer:308 |
| `GoToHelicopter` | primary | Go to the helicopter at the airfield. | dl_gochopper, AnnaExcuse, AnnaEntrance, AnnaCongrats | 03_NYC_Airfield/GoalCompleteTrigger2 |
| `SeeCarter` | secondary | Report to Sam Carter to receive your equipment. | ManderleyDebriefing02 | CarterGreeting03 |
| `KillDealer` | secondary | Kill the drug dealer in the Brooklyn Bridge Station for the Rooks, then inform El Rey. | M03MeetJugHead | M03MeetJugHead |
| `TalkToCharlie` | secondary | Talk to Charlie in the Brooklyn Bridge Station for information on the mole people. | MeetCurly | MeetCharlieFann, FannSatisfied, FannFinalBarks |
| `OpenFreshWater` | secondary | Open a fresh water supply for the homeless in Brooklyn Bridge Station. The valve is in a utility room at the north end of the train tracks that has be | MeetCharlieFann | FannSatisfied |
| `GetToAirfield` | carried |  | - | 03_NYC_Airfield/GoalCompleteTrigger0, 03_NYC_Airfield/GoalCompleteTrigger1 |

### 03.5 Choices with lasting consequences

Set here, alive in a later mission:

| Flag | Set here by | Expires | Read later by |
| --- | --- | --- | --- |
| `AnnaKilledLebedev` | script Mission03.Timer:312 | mission 6 | M4 checks in M04LloydBarks |
| `M03PlayerKilledAnna` | conversation DL_AlexShocked | never | M4 checks in ManderleyDebriefing03; M4 checks in GuntherShowdown; M4 checks in CokeTroopBarks |
| `PlayerKilledLebedev` | script Mission03.Timer:309; script Mission03.Timer:322 | mission 6 | M4 checks in DL_SeeManderley; M4 checks in M04TroopBarks; M4 checks in M04ScottBarks; M4 checks in M04MeetCarter; M4 checks in M04LloydBarks; ... |
| `PlayerMetFilben` | conversation M03MeetFilben@FirstMeeting | never | M4 checks in M04MeetFilben |
| `SimonsAssassination` | conversation SimonsBarks@A4 | never | M14 checks in DL_Simons2 |

Read here, set earlier (this mission reads more of the past than any other, because it is the first full day after missions 1 and 2):

| Flag | Set earlier by | Read here by |
| --- | --- | --- |
| `AmbrosiaTagged` | M2 conversation DL_AmbrosiaFound; M2 trigger 02_NYC_BatteryPark/FlagTrigger1 | checks in CarterGreeting03; checks in ManderleyDebriefing02; checks in AnnaManderley1; checks in AnnaAtUNATCO |
| `BathroomBarks_Played` | M1 conversation BathroomBarks | checks in M03ShannonBarks |
| `BatteryParkSlaughter` | M2 script Mission02.Timer:178 | checks in TroopBarks2; checks in TroopBarks1; checks in CarterGreeting03; checks in CarterBarks; checks in AnnaManderley2; checks in AnnaManderley1 |
| `EscapeSuccessful` | M2 trigger 02_NYC_BatteryPark/FlagTrigger7; M2 trigger 02_NYC_BatteryPark/FlagTrigger8 | checks in ManderleyDebriefing02; checks in AnnaAtUNATCO |
| `FilbenGaveKey` | M1 conversation MeetFilben@NoKeyB; M1 conversation MeetFilben@GetKeyB | checks in M03MeetFilben; checks in FilbenAngryBarks |
| `FordSchickRescued` | M2 script Mission02.PreTravel:122 | checks in SmugglerThanks; checks in MeetSmuggler; needed by SckickThanks; checks in FordBarks |
| `FordSchickRescueDone` | M2 script Mission02.Timer:439 | needed by SmugglerWaiting; needed by SmugglerThanks |
| `GuntherRespectsPlayer` | M1 conversation GuntherRescued@GiveSpeech; M1 conversation GuntherRescued@GiveNothing; M1 conversation GuntherRescued@GiveNothingNicely | checks in GuntherHermann_BarkFutz; checks in TroopBarks2 |
| `HeardGrenadeTalk` | M2 conversation UNATCOGrenade1Meet | checks in ManderleyDebriefing02 |
| `KnowsOfJoJo` | M2 conversation CounselWorker@Curious; M2 conversation MeetSandraRenton@CResume | checks in ManderleyDebriefing02 |
| `M01PlayerAggressive` | M1 script Mission01.Timer:91 | checks in TroopBarks2; checks in TroopBarks1 |
| `M01PlayerMetFilben` | M1 conversation MeetFilbenAfterStatue; M1 conversation MeetFilben | checks in M03MeetFilben |
| `M02MechSlur` | M2 conversation AnnaThanks@Cocky; M2 conversation AnnaThanks@TeamPlayer | checks in TroopBarks2; checks in AnnaEntrance; checks in AnnaAtUNATCO |
| `M02QuestionedGreen` | M2 conversation MeetJoeGreen2@GreenQuestioned | checks in ManderleyDebriefing02 |
| `M02ViolenceInBar` | M2 script Mission02.Timer:416 | checks in ManderleyDebriefing02 |
| `SubTerroristsDead` | M2 script Mission02.Timer:196 | checks in ManderleyDebriefing02; checks in AnnaAtUNATCO |
| `TenderloinSlaughter` | M2 script Mission02.Timer:285 | checks in TroopBarks2; checks in TroopBarks1; checks in CarterGreeting03; checks in PrivateLloydBark; checks in ManderleyDebriefing02 |

* **Lebedev**: who kills him decides `PlayerKilledLebedev` (player), `AnnaKilledLebedev` (Anna) or `JuanLebedev_Dead`; mission 4's UNATCO conversations (`DL_SeeManderley`, `M04MeetCarter`, `M04LloydBarks`, `M04MeetAlex`, `ManderleyDebriefing03`, troop barks) read them. If Anna dies at the 747 after
  `AnnaEntrance` (`DL_AlexShocked`, started by the 747's `DataLinkTrigger0` once `AnnaNavarre_Dead`, sets `M03PlayerKilledAnna`, permanent) mission 4's `ManderleyDebriefing03` and `GuntherShowdown` change; `AnnaNavarre_Dead` is permanent and her pawn never returns.
* **Filben** (`M03MeetFilben@FirstMeeting` sets `PlayerMetFilben`): mission 4's `M04MeetFilben`.
* **Simons** (`SimonsBarks@A4` sets `SimonsAssassination`): read in mission 14 by `DL_Simons2`.
* Missions 1 and 2 reach mission 3 through the table above: `AmbrosiaTagged`, `BatteryParkSlaughter`, `SubTerroristsDead`, `EscapeSuccessful`, `TenderloinSlaughter`, `FilbenGaveKey`, `M01PlayerAggressive`, `GuntherRespectsPlayer`, `M02MechSlur`, ... decide the UNATCO dialogue of this mission.
  (`FordSchickRescued` and `FordSchickRescueDone` are listed as read here but, per the `PreTravel` note in mission 2's script section, cannot be true in this mission from the data.)
* Pawns here that stay dead: `JuanLebedev`, `AnnaNavarre`, `PaulDenton`, `JosephManderley`, `SamCarter`, `JaimeReyes`, `JaniceReed`, `Shannon`, `WaltonSimons`, `GuntherHermann`, `PrivateLloyd`, ... (the table of who can die).

### 03.6 Progression path

1. Island arrival; `DL_WelcomeBack` (adds `ReportToManderley`); HQ via the island teleporter; `ManderleyDebriefing02` (required, above); `CarterGreeting03` (equipment, `SeeCarter`) is optional.
2. Back to the island: `JockBarks` (radius 300) -> `ChopperExit` -> `ChopperLeave` -> `MapExit0` -> `03_NYC_BatteryPark`.
3. Battery Park -> Brooklyn Bridge Station (`FromNYCStreets`) -> Mole People (`MoleEnt`) -> Airfield Heli Base (`SewerEnt`); `DL_Airfield` plays on reaching the heli base. Gates seen on the way: `DeusExMover1` (pick 0.10) in the station, `MoleHideoutOpened` (keypad), the heli base's
   `Bridge1Fall`/`Bridge2Fall`/`MoveableBridge`, `DeusExMover13/14/15` (pick 0.50-0.70).
4. Heli base -> Airfield (the elevator teleporter or the ocean one): `eastgate` (two locked movers, switches `Switch2 Switch0/Switch4`), `HangarDoorOpen` (`Keypad3 Keypad12`, switches) for the optional hangar/747 branch.
5. At the airfield: `M03JockLeave` -> "I'm ready" -> `HelicopterPickUp` -> `MoveHelicopter` -> `MapExit0` -> `04_NYC_UNATCOIsland`.

| Map | Tag (movers) | Lock | Opened by |
| --- | --- | --- | --- |
| `03_NYC_747` | `hangardoor` (1) | unlocked, not frobbable | Switch1 Switch1, Switch1 Switch2 |
| `03_NYC_747` | `field001` (4) | unlocked, pick 0.20, not frobbable | Keypad3 Keypad1 |
| `03_NYC_Airfield` | `eastgate` (2) | locked, not frobbable | Switch2 Switch0, Switch2 Switch4 |
| `03_NYC_Airfield` | `DeusExMover4` (1) | locked, not frobbable | (nothing found) |
| `03_NYC_Airfield` | `DeusExMover7` (1) | locked, not frobbable | (nothing found) |
| `03_NYC_Airfield` | `HangarDoorOpen` (1) | unlocked, not frobbable | Keypad3 Keypad12, Switch1 Switch1, Switch1 Switch3 |
| `03_NYC_Airfield` | `secretarmory` (1) | unlocked, pick 0.20, not frobbable | DeusExMover DeusExMover46, Switch1 Switch2 |
| `03_NYC_Airfield` | `DeusExMover1` (1) | locked, key eastgate | frob |
| `03_NYC_Airfield` | `DeusExMover16` (1) | unlocked, key eastgate | frob |
| `03_NYC_AirfieldHeliBase` | `Bridge1Fall` (1) | unlocked, pick 0.20, not frobbable | Dispatcher Dispatcher2 |
| `03_NYC_AirfieldHeliBase` | `Bridge2Fall` (1) | unlocked, pick 0.20, not frobbable | Dispatcher Dispatcher3 |
| `03_NYC_AirfieldHeliBase` | `MoveableBridge` (1) | unlocked, pick 0.20, not frobbable | Button1 Button5 |
| `03_NYC_AirfieldHeliBase` | `SecretDoor` (1) | unlocked, pick 0.20, not frobbable | Pinball Pinball2, Switch1 Switch5 |
| `03_NYC_AirfieldHeliBase` | `WeaponStash` (1) | unlocked, pick 0.20, not frobbable | Switch1 Switch0, Switch1 Switch6 |
| `03_NYC_BatteryPark` | `ElevatorPhone` (1) | unlocked, not frobbable | Keypad2 Keypad2 |
| `03_NYC_BrooklynBridgeStation` | `MoleHideoutOpened` (1) | unlocked, pick 0.20, breakable 0.25, not frobbable | Keypad2 Keypad0 |
| `03_NYC_Hangar` | `hangardoor` (1) | unlocked, not frobbable | Switch1 Switch1, Switch1 Switch2 |
| `03_NYC_Hangar` | `cargodoor` (1) | unlocked, pick 0.20, not frobbable | Trigger Trigger1 |
| `03_NYC_MolePeople` | `DeusExMover65` (1) | locked, key MoleRestroomKey | frob |
| `03_NYC_MolePeople` | `WaterChanges` (2) | unlocked, pick 0.20 | FlagTrigger FlagTrigger5 |
| `03_NYC_MolePeople` | `SecretDoor` (1) | unlocked, pick 0.20, not frobbable | DeusExMover DeusExMover3 |
| `03_NYC_UNATCOHQ` | `Manderley_Office` (1) | locked, key ManderleyOfficeDoor | script Mission03:166 |
| `03_NYC_UNATCOHQ` | `alexcloset` (1) | locked, pick 0.20 | Keypad2 Keypad1 |
| `03_NYC_UNATCOHQ` | `DeusExMover20` (1) | locked | frob |
| `03_NYC_UNATCOHQ` | `CellDoorOpen` (1) | unlocked, not frobbable | Trigger Trigger0, Trigger Trigger1 |
| `03_NYC_UNATCOHQ` | `UN_blastdoor` (1) | unlocked, not frobbable | RetinalScanner RetinalScanner0, Button1 Button0 |
| `03_NYC_UNATCOHQ` | `cannotopen` (1) | locked | Switch1 Switch1 |
| `03_NYC_UNATCOHQ` | `UN_blastdoor2` (1) | locked, not frobbable | (nothing found) |
| `03_NYC_UNATCOIsland` | `commvan_door` (1) | locked | Keypad1 Keypad0, Switch2 Switch0 |
| `03_NYC_UNATCOIsland` | `UNATCOHQEntDoor` (2) | unlocked | Switch1 Switch2 |

Key doors (a placed `NanoKey` opens them, or the lock is picked; frob only): `lebedevdoor` x2, `Dormitory`, `UNcloset` x2, `JaimeClosetKey`, `UNhatchdoor`.

(25 further movers of these maps are locked with a pickable lock or breakable, take no key that exists as a placed `NanoKey` and are fired by no event: not listed.)

**Progression blocker (mission 3).** `ManderleyDebriefing02` not played (the island chopper does not leave); the Battery Park -> station -> tunnels -> heli base -> airfield walk stops; `DL_Airfield_Played` not set; `M03JockLeave` not reaching its `Ready` branch;
`HelicopterPickUp`/`MoveHelicopter` not firing; `MapExit0` not loading mission 4. Lebedev's death, the barrels and the side objectives are not blockers.

### 03.7 Slots

| Slot | Map | Saved as | Saves, play time | Important NPCs dead or knocked out (all) | Lasting-choice flags in the file (all) | Goals still open |
| --- | --- | --- | --- | --- | --- | --- |
| N0005 | `03_NYC_BatteryPark` | NYC - Battery Park | 112, 223 min | GilbertTerrorist, Terrorist | AmbrosiaTagged, BathroomBarks_Played, BatteryParkSlaughter, FilbenGaveKey, GuntherFreed, GuntherRespectsPlayer=0, HeardGrenadeTalk, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, MeetJoeGreen_Played, PlayerMetFilben, SubTerroristsDead | LocateAirfield |
| N0006 | `03_NYC_AirfieldHeliBase` | NYC - Helibase | 127, 255 min | DrugDealer, GilbertTerrorist, Terrorist | AmbrosiaTagged, BathroomBarks_Played, BatteryParkSlaughter, FilbenGaveKey, GuntherFreed, GuntherRespectsPlayer=0, HeardGrenadeTalk, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, MeetJoeGreen_Played, PlayerMetFilben, SubTerroristsDead | LocateAirfield |
| N0007 | `03_NYC_Airfield` | NYC - Airfield | 145, 275 min | DrugDealer, GilbertTerrorist, Terrorist | AmbrosiaTagged, BathroomBarks_Played, BatteryParkSlaughter, FilbenGaveKey, GuntherFreed, GuntherRespectsPlayer=0, HeardGrenadeTalk, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, MeetJoeGreen_Played, PlayerMetFilben, SubTerroristsDead | LocateAirfield, FindAmbrosiaBarrels |
| N0008 | `03_NYC_747` | NYC - 747 Airplane | 162, 302 min | DrugDealer, GilbertTerrorist, Terrorist | AmbrosiaTagged, BathroomBarks_Played, BatteryParkSlaughter, FilbenGaveKey, GuntherFreed, GuntherRespectsPlayer=0, HeardGrenadeTalk, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, MeetJoeGreen_Played, PlayerMetFilben, SubTerroristsDead | AssassinateLebedev |

All four slots are the same playthrough; the three on the way to the airfield carry the same lasting flags, so they differ only in map and progress. N0008 (the 747) has `AssassinateLebedev` open and is the only slot where the Lebedev branch can be played from the start.

## Mission 04: Paul's apartment, the NSF headquarters and Battery Park (NYC)

Nine maps, reusing the Hell's Kitchen street, bar, hotel, smuggler's lair, sewers, Battery Park and the UNATCO island/HQ of earlier missions with new content. The player is debriefed (Manderley), flown to Hell's Kitchen by Jock, finds Paul wounded
in the hotel, sends the NSF's distress signal from the satellite dishes of the captured NSF headquarters, and is confronted by Gunther at Battery Park. The mission has two ways out and neither is a plain door: a conversation choice, and
**the player's own death**.

### 04.1 Maps and arrival

| Map | Actors | Level info (`MapName`; `MissionLocation`) | Startup text | Script | Arrives from | Leaves to |
| --- | --- | --- | --- | --- | --- | --- |
| `04_NYC_Bar` | 491 | 04_NYC_Bar; NYC - Underworld Tavern | - | Mission04 | 04_NYC_Street#ToBarBackEntrance/ToBarFrontEntrance x2 | 04_NYC_Street#FromBarBackEntrance/FromBarFrontEntrance x2 |
| `04_NYC_BatteryPark` | 1139 | 04_NYC_BatteryPark; NYC - Battery Park | New York City, / Battery Park | Mission04 | 04_NYC_Street#ToBatteryPark x3 | 05_NYC_UNATCOMJ12lab x2 (path CameraPath); 04_NYC_Street#ToStreet x3 |
| `04_NYC_Hotel` | 936 | 04_NYC_Hotel; NYC - 'Ton Hotel | - | Mission04 | 04_NYC_Street#ToHotelFrontDoor/ToHotelBedroom x2 | 04_NYC_Street#BedroomWindow/FromHotelFrontDoor x2 |
| `04_NYC_NSFHQ` | 1997 | 04_NYC_NSFHQ; NYC - 20th Street Warehouse | - | Mission04 | 04_NYC_Street#ToNSFHQ | 04_NYC_Street#FromNSFHQ |
| `04_NYC_Smug` | 530 | 04_NYC_Smug; NYC - Smuggler's Lair | - | Mission04 | 04_NYC_Street#ToSmugFrontDoor/ToSmugBackDoor x2 | 04_NYC_Street#FromSmugBackDoor/FromSmugFrontDoor x2 |
| `04_NYC_Street` | 1934 | 04_NYC_Street; NYC - Hell's Kitchen | New York City, Hell's Kitchen | Mission04 | 04_NYC_Bar#FromBarBackEntrance/FromBarFrontEntrance x2; 04_NYC_BatteryPark#ToStreet x3; 04_NYC_Hotel#BedroomWindow/FromHotelFrontDoor x2; 04_NYC_NSFHQ#FromNSFHQ; 04_NYC_Smug#FromSmugBackDoor/FromSmugFrontDoor x2; 04_NYC_UNATCOIsland (path Camera1); 04_NYC_Underground#FromNYCUndergroundSewer2/FromNYCSump x2 | 04_NYC_Smug#ToSmugFrontDoor/ToSmugBackDoor x2; 04_NYC_Bar#ToBarBackEntrance/ToBarFrontEntrance x2; 04_NYC_Hotel#ToHotelFrontDoor/ToHotelBedroom x2; 04_NYC_BatteryPark#ToBatteryPark x3; 04_NYC_NSFHQ#ToNSFHQ; 04_NYC_Underground#ToNYCUndergroundSewer2/ToNYCSump x2 |
| `04_NYC_UNATCOHQ` | 1447 | 04_NYC_UNATCOHQ; NYC - UNATCO HQ | UNATCO HQ / United Nations Antiterrorist / Coalition | Mission04 | 04_NYC_UNATCOIsland#unatcohq | 04_NYC_UNATCOIsland#unatcoisland |
| `04_NYC_UNATCOIsland` | 938 | 04_NYC_UNATCOIsland; NYC - Liberty Island | New York City,  / Liberty Island / UNATCO Headquarters | Mission04 | 03_NYC_Airfield (path CameraPath); 04_NYC_UNATCOHQ#unatcoisland | 04_NYC_Street (path Camera1); 04_NYC_UNATCOHQ#unatcohq |
| `04_NYC_Underground` | 338 | 04_NYC_Underground; NYC - Sewers | - | Mission04 | 04_NYC_Street#ToNYCUndergroundSewer2/ToNYCSump x2 | 04_NYC_Street#FromNYCUndergroundSewer2/FromNYCSump x2 |

* **Arrival.** `03_NYC_Airfield` `MapExit0` (camera `CameraPath`, tag `MoveHelicopter`) -> `04_NYC_UNATCOIsland.dx`: mission change 3 -> 4, `Save\Current` wiped, `DeleteExpiredFlags(4)`.
* **Inside.** Island <-> HQ (`unatcohq`/`unatcoisland`); Island -> Street by `MapExit0` (camera `Camera1`, tag `ChopperLeave`: the helicopter); the Street hub again (bar, hotel, smuggler, sewers, Battery Park, and a new `ToNSFHQ`/`FromNSFHQ` pair to the captured NSF building).
* **Leaving.** (a) `04_NYC_BatteryPark` `MapExit0` and `MapExit1` (same place, same tag `Mission4Exit`, camera `CameraPath`) -> `05_NYC_UNATCOMJ12lab`. (b) **`Mission04.Timer` calls `Level.Game.SendPlayer(Player, "05_NYC_UNATCOMJ12Lab")` (`:93`) when the player is in the `Dying` state
  after `TalkedToPaulAfterMessage_Played`** (it first sets `MS_PlayerCaptured`, expiration 5, and completes `EscapeToBatteryPark`): death after that conversation is the same scripted travel, which happens before the generic death flow (`OPEN DXONLY` at 20 s,
  [travel](travel.md#which-branch-each-single-player-entry-takes)).

| Map | Actor | At | Leads to | Fired by (events targeting its tag) |
| --- | --- | --- | --- | --- |
| `04_NYC_BatteryPark` | MapExit `MapExit1` | -3253,1276,368 | `05_NYC_UNATCOMJ12lab` (path `CameraPath`) | tag `Mission4Exit`: conversation GuntherShowdown[Surrender], conversation GuntherShowdown[AnnaDead2] |
| `04_NYC_BatteryPark` | MapExit `MapExit0` | -3253,1276,368 | `05_NYC_UNATCOMJ12lab` (path `CameraPath`) | tag `Mission4Exit`: conversation GuntherShowdown[Surrender], conversation GuntherShowdown[AnnaDead2] |
| `04_NYC_UNATCOIsland` | MapExit `MapExit0` | -5769,2496,22 | `04_NYC_Street` (path `Camera1`) | tag `ChopperLeave`: Dispatcher Dispatcher0 |

**04_NYC_BatteryPark MapExit1 -> 05_NYC_UNATCOMJ12lab** (tag `Mission4Exit`)

```text
event Mission4Exit
  conversation event Trigger "Mission4Exit" in GuntherShowdown branch Surrender
    conversation GuntherShowdown [talk sight/radius 300; owner GuntherHermann]
      starts: its actor (sight/radius 300)
      flag TalkedToPaulAfterMessage_Played (set when conversation TalkedToPaulAfterMessage ends): 
        conversation TalkedToPaulAfterMessage [talk; owner PaulDenton]
          starts: Mission04.uc:141
          flag PaulInjured_Played (set when conversation PaulInjured ends): 
            conversation PaulInjured [talk bump/frob/radius 100; owner PaulDenton]
          flag NSFSignalSent: set by conversation DL_PaulGoodJob@GoodAlign; trigger 04_NYC_NSFHQ/FlagTrigger10
            conversation DL_PaulGoodJob [DL bump/frob; owner JCDenton]
            event SendingSignal
  conversation event Trigger "Mission4Exit" in GuntherShowdown branch AnnaDead2
    conversation GuntherShowdown [talk sight/radius 300; owner GuntherHermann] (seen above)
```

**04_NYC_BatteryPark MapExit0 -> 05_NYC_UNATCOMJ12lab** (tag `Mission4Exit`)

```text
event Mission4Exit
  conversation event Trigger "Mission4Exit" in GuntherShowdown branch Surrender
    conversation GuntherShowdown [talk sight/radius 300; owner GuntherHermann]
      starts: its actor (sight/radius 300)
      flag TalkedToPaulAfterMessage_Played (set when conversation TalkedToPaulAfterMessage ends): 
        conversation TalkedToPaulAfterMessage [talk; owner PaulDenton]
          starts: Mission04.uc:141
          flag PaulInjured_Played (set when conversation PaulInjured ends): 
            conversation PaulInjured [talk bump/frob/radius 100; owner PaulDenton]
          flag NSFSignalSent: set by conversation DL_PaulGoodJob@GoodAlign; trigger 04_NYC_NSFHQ/FlagTrigger10
            conversation DL_PaulGoodJob [DL bump/frob; owner JCDenton]
            event SendingSignal
  conversation event Trigger "Mission4Exit" in GuntherShowdown branch AnnaDead2
    conversation GuntherShowdown [talk sight/radius 300; owner GuntherHermann] (seen above)
```

**04_NYC_UNATCOIsland MapExit0 -> 04_NYC_Street** (tag `ChopperLeave`)

```text
event ChopperLeave
  Dispatcher Dispatcher0 (OutEvents) tag TimeToGo
    event TimeToGo
      FlagTrigger FlagTrigger1 (Event) tag ChopperExit
        FlagTrigger flag ManderleyDebriefing03_Played (needs true)
        event ChopperExit
          BlackHelicopter BlackHelicopter0 (Event)
      conversation event Trigger "TimeToGo" in JockTellsAboutPaul
        conversation JockTellsAboutPaul [talk bump/frob/radius 250; owner Jock]
          starts: its actor (bump/frob/radius 250)
          flag !M04PlayerLeftUNATCO: set by conversation JockTellsAboutPaul; trigger 04_NYC_UNATCOIsland/FlagTrigger5
            conversation JockTellsAboutPaul [talk bump/frob/radius 250; owner Jock] (seen above)
            event BlackHelicopter
          flag ManderleyDebriefing03_Played (set when conversation ManderleyDebriefing03 ends): 
            conversation ManderleyDebriefing03 [talk radius 160; owner JosephManderley]
```

### 04.2 Mission script `Mission04`

`.cache/research/src/DeusEx/Mission04.uc`, 289 lines.

* `FirstFrame` (`:12-49`): after `TalkedToPaulAfterMessage_Played`, the Street and Free Clinic `UNATCOTroop`s (and the Street's `SecurityBot2`s) enter the world; in the Hotel, when `SandraRenton_Dead` or `GilbertRenton_Dead` and not `JoJoFine_Dead`, the `JoJoInLobby` pawn enters.
* `PreTravel` (`:57-60`): `Super` only.
* `Timer` (`:68-285`): **capture by death** (`:85-96`, above); Hotel: `PlayerKilledRenton` (expiration 5) when fewer than two of Sandra/Gilbert (pawns) remain or one carcass was killed by `JCDenton` (fires `RentonsHatePlayer`, `:101-124`); the post-raid teleport (`:126-147`):
  `ApartmentEntered` and `NSFSignalSent` -> every `UNATCOTroop`/`MIB` enters the world, Sandra, Gilbert and Filben leave, the conversation `TalkedToPaulAfterMessage` is started with Paul (`StartConversationByName`, `:141`; `M04RaidTeleportDone`, expiration 5);
  `MS_MIBMortal` (the `MIB` lose `bInvincible` after that conversation); JoJo's stages (`JoJoUpstairs` enters, `GilbertAttacksJoJo`/`JoJoAttacksGilbert` by `GaveRentonGun`, `SandraLeaves`; `MS_JoJo1/2/3Triggered`, expiration 5). NSF HQ:
  `DishN` rotates when `DishNInPosition` (yaw 49152, 0, 16384; `MS_DishNRotated`), `CanSendSignal` (expiration 5) when all three are in position; `MostWarehouseTroopsDead` (default expiration) when 2 or fewer `UNATCOTroop` remain.
* Flags that outlive the mission: `M04MetWalton` and `SandraWentToCalifornia` (conversations, permanent), `PlayerBailedOutWindow` (FlagTrigger, expiration 6), `NSFSignalSent` (permanent via `DL_PaulGoodJob`, expiration 16 via `04_NYC_NSFHQ/FlagTrigger10`).
* Actors it touches: `UNATCOTroop`, `SecurityBot2`, `MIB`, `SandraRenton`, `GilbertRenton`, `HarleyFilben`, `PaulDenton`, `SatelliteDish`, `Player` (state `Dying`), tags `JoJoInLobby`, `JoJoUpstairs`, `RentonsHatePlayer`, `GilbertAttacksJoJo`, `JoJoAttacksGilbert`, `SandraLeaves`, `Dish1..3`.

Generated from the script's calls (`inventory-campaign.mjs scripts`; `:N` is the first line):

* **Flags set** (13; `eN` = explicit expiration N, otherwise the default): `MS_PlayerCaptured` e5 (:91), `PlayerKilledRenton` e5 (:120), `M04RaidTeleportDone` e5 (:145), `MS_MIBMortal` e5 (:158), `MS_JoJoUnhidden` e5 (:172), `MS_JoJo1Triggered` e5 (:205), `MS_JoJo2Triggered` e5 (:214), `MS_JoJo3Triggered` e5 (:223), `MS_Dish1Rotated` e5 (:236), `MS_Dish2Rotated` e5 (:248), `MS_Dish3Rotated` e5 (:260), `CanSendSignal` e5 (:270), `MostWarehouseTroopsDead` (:282).
* **Flags read** (30): `TalkedToPaulAfterMessage_Played`, `SandraRenton_Dead`, `GilbertRenton_Dead`, `JoJoFine_Dead`, `MS_PlayerCaptured`, `PlayerKilledRenton`, `M04RaidTeleportDone`, `ApartmentEntered`, `NSFSignalSent`, `MS_MIBMortal`, `MS_JoJoUnhidden`, `SandraWaitingForJoJoBarks_Played`, `GilbertWaitingForJoJoBarks_Played`, `M03OverhearSquabble_Played`, `JoJoOverheard_Played`, `JoJoEntrance`, `MS_JoJo1Triggered`, `GaveRentonGun`, `JoJoAndSandraOverheard_Played`, `MS_JoJo2Triggered`, `JoJoAndGilbertOverheard_Played`, `MS_JoJo3Triggered`, `MS_Dish1Rotated`, `Dish1InPosition`, `MS_Dish2Rotated`, `Dish2InPosition`, `MS_Dish3Rotated`, `Dish3InPosition`, `CanSendSignal`, `MostWarehouseTroopsDead`.
* **InfoLinks it starts**: none. **Conversations it starts by name**: `TalkedToPaulAfterMessage` (:141). **Goals it completes**: `EscapeToBatteryPark` (:92).
* **Spawns**: none. **Destroy calls**: 0; **EnterWorld/LeaveWorld calls**: 7. **Travel calls**: `:93 Level.Game.SendPlayer(Player, "05_NYC_UNATCOMJ12Lab");`.

### 04.3 Conversations and InfoLinks

136 conversations of the list besides the shared barks: 8 InfoLinks, 36 talk-type, 92 overheard. 6 have choices (the vendor/bartender conversations `M04MeetSmuggler`, `Doctor1Barter`, `M04JordanSheaConvos`,
Carter's ammunition choice `M04MeetCarter`, Renton's gun `InterruptFamilySquabble`, and **`GuntherShowdown`**: "I surrender." / "Here comes your chance to be a hero."), 22 set flags, 82 need a flag, 11 add or complete goals.

**Choices.** Every choice that changes state, the block its speech jumps to and what that block does (choices that change no state are counted in one row per conversation):

| Conversation | Owner | Choice | Effects of the branch |
| --- | --- | --- | --- |
| `Doctor1Barter` | Doctor1 | I'll take a medkit. [needs CanAffordMedkit, CanAffordBots] | -> Medkit: give MedKit |
| `Doctor1Barter` | Doctor1 | All I can afford is a medkit. [needs !CanAffordBots, CanAffordMedkit] | -> Medkit: give MedKit |
| `Doctor1Barter` | Doctor1 | I want the full program. [needs CanAffordBots] | -> Full: set BoughtClinicPlan |
| `Doctor1Barter` | Doctor1 | Sure. | -> Medkit: give MedKit |
| `Doctor1Barter` | Doctor1 | (2 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `M04MeetSmuggler` | Smuggler | I'll give you 2400 for the range mod. [needs M04CanBuyBinoculars, !M04BoughtBinoculars] | -> BuyBinoculars: set M04BoughtBinoculars, give WeaponModRange |
| `M04MeetSmuggler` | Smuggler | How about you give me the napalm canister for 2250? [needs M04CanBuyFlame, !M04BoughtFlame] | -> BuyFlame: set M04BoughtFlame, give AmmoNapalm |
| `M04MeetSmuggler` | Smuggler | Sell me the extended clip for 1500. [needs M04CanBuyClip, !M04BoughtClip] | -> BuyClip: set M04BoughtClip, give WeaponModClip |
| `M04MeetSmuggler` | Smuggler | Not interested. | -> NotInterested: trig BotToNeutral |
| `M04MeetSmuggler` | Smuggler | I'll take the range mod for 800. [needs M04CanBuyBinoculars, !M04BoughtBinoculars] | -> BuyBinocularsCheap: set M04BoughtBinoculars, give WeaponModRange |
| `M04MeetSmuggler` | Smuggler | 800's a bargain on the range mod, but I'm low on cash. [needs !M04CanBuyBinoculars, !M04BoughtBinoculars] | -> NotInterested: trig BotToNeutral |
| `M04MeetSmuggler` | Smuggler | Here's 750 for the napalm canister. [needs M04CanBuyFlame, !M04BoughtFlame] | -> BuyFlameCheap: set M04BoughtFlame, give AmmoNapalm |
| `M04MeetSmuggler` | Smuggler | I'd take the napalm for 750 if I had the cash. [needs !M04CanBuyFlame, !M04BoughtFlame] | -> NotInterested: trig BotToNeutral |
| `M04MeetSmuggler` | Smuggler | 500 for an extended clip? Sure. [needs M04CanBuyClip, !M04BoughtClip] | -> BuyClipCheap: set M04BoughtClip, give WeaponModClip |
| `M04MeetSmuggler` | Smuggler | 500 for an extended clip sounds fair, but I don't have the money. [needs !M04CanBuyClip, !M04BoughtClip] | -> NotInterested: trig BotToNeutral |
| `M04MeetSmuggler` | Smuggler | Not interested. | -> NotInterested: trig BotToNeutral |
| `M04MeetSmuggler` | Smuggler | (3 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `M04MeetCarter` | SamCarter | I'll take tranquilizer darts for the crossbow. | -> giveassault: set M04WantDart, set M04CarterDone, give AmmoDartPoison |
| `M04MeetCarter` | SamCarter | I've been using a shotgun. | -> giveshotgun: set M04WantShotgun, set M04CarterDone, give AmmoShell |
| `M04MeetCarter` | SamCarter | Sniper rifle, thirty-ought-six | -> givesniper: set M04WantSniper, set M04CarterDone, give Ammo3006 |
| `M04MeetCarter` | SamCarter | A GEP rocket. | -> givepistol: set M04WantPistol, set M04CarterDone, give AmmoRocket |
| `M04JordanSheaConvos` | JordanShea | A bottle of booze, please. | -> BuyBooze: give Liquor40oz |
| `M04JordanSheaConvos` | JordanShea | A can of soda, please. | -> BuySoda: give SodaCan |
| `M04JordanSheaConvos` | JordanShea | A candy bar, please. | -> BuyCandybar: give Candybar |
| `M04JordanSheaConvos` | JordanShea | (4 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `GuntherShowdown` | GuntherHermann | I surrender. | -> Surrender: trig Mission4Exit |
| `GuntherShowdown` | GuntherHermann | Here comes your chance to be a hero. | -> Fight: trig GuntherAttacksJC |
| `InterruptFamilySquabble` | GilbertRenton | You can have my pistol. That'll keep you safe. | -> GivePistol: take WeaponPistol, set GaveRentonGun |
| `InterruptFamilySquabble` | GilbertRenton | You can have my stealth pistol. That'll keep you safe. | -> GiveStealth: take WeaponStealthPistol, set GaveRentonGun |
| `InterruptFamilySquabble` | GilbertRenton | You can have my sawed-off shotgun. That'll keep you safe. | -> GiveSawedOffShotgun: take WeaponSawedOffShotgun, set GaveRentonGun |
| `InterruptFamilySquabble` | GilbertRenton | You can have my knife. That'll keep you safe. | -> GiveKnife: take WeaponCombatKnife, set GaveRentonGun |
| `InterruptFamilySquabble` | GilbertRenton | You can have my mini-crossbow. That'll keep you safe. | -> GiveCrossbow: take WeaponMiniCrossbow, set GaveRentonGun |
| `InterruptFamilySquabble` | GilbertRenton | (5 further choices that change no state: refusals, "never mind", unaffordable offers) | - |

**Conversations that change state** (choices, flags set, goals, items, events, skill points; the `Needs` column is kept on these rows):

| Conversation | Owner (BindName; maps with that actor) | Kind | Choices | Sets | Needs | Goals | Other |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `Doctor1Barter` | Doctor1 (other missions) | talk bump/frob | 6 | CanAffordBots=0@Continue, CanAffordMedkit@Continue, BoughtClinicPlan@Full, CanAffordBots@AffordBots | ? BoughtClinicPlan, ? !Doctor1Barter_Played | +note | give MedKit, cr -2300 |
| `DL_SimonsPissed` | JCDenton | DL once |  |  | ? MostWarehouseTroopsDead | done InvestigateNSF |  |
| `DL_SeeManderley` | JCDenton | DL once |  |  | ? PlayerKilledLebedev | done AssassinateLebedev, +P SeeManderley |  |
| `DL_PaulNSFHQ` | JCDenton | DL once |  |  |  | +note |  |
| `DL_PaulGoodJob` | JCDenton | DL |  | NSFSignalSent@GoodAlign | req !NSFSignalSent, ? CanSendSignal | +P ReturnToPaul, done SendSignal | sp 300 |
| `DL_JockParkStart` | JCDenton | DL once |  |  |  | +P CheckOnPaul |  |
| `DL_GotUplinkCode` | JCDenton | DL once |  |  | req GotUplinkCode | done InvestigateNSF, +P SendSignal |  |
| `M04MeetWalton` | WaltonSimons (NYC_UNATCOHQ) | talk bump/frob once |  | M04MetWalton |  |  |  |
| `SmugglerDoorBellConvo` | SmugglerDoorBell (NYC_Street) | talk frob |  | SmugglerDoorDone@KnowsPassword | ? KnowsSmugglerPassword, ? SmugglerDoorBellConvo_Played |  | trig SmugglersFrontDoor |
| `M04SmugglerBarks` | Smuggler (NYC_Smug) | ovh bump/frob |  | M04SmugglerShootingComment@Shooting | req M04SmugglerDoneVending, ? TalkedToPaulAfterMessage_Played, ? !MetSmuggler, ? !M04SmugglerShootingComment, ? PaulDenton_Dead |  |  |
| `M04MeetSmuggler` | Smuggler (NYC_Smug) | talk bump/frob/radius 80 | 14 | PlayerKnowsAboutRaid, MetSmuggler@FirstMeeting, M04SmugglerShootingComment@OnTheRun, M04SmugglerShootingComment@FirstRun, M04SmugglerGaveOptions@HardwareDescriptionCheap, M04SmugglerGaveOptions@HardwareDescription (+16 more) | req !M04SmugglerDoneVending, ? !MetSmuggler, ? TalkedToPaulAfterMessage_Played, ? !M04SmugglerShootingComment, ? M04MeetSmuggler_Played, ? PaulDenton_Dead, ? FordSchickRescued, ? !FordSchick_Dead (+4 more) |  | trig BotToNeutral, give WeaponModClip, give AmmoNapalm, give WeaponModRange, cr -8200 |
| `SandraAttackedByJoJoThanks` | SandraRenton (NYC_Hotel) | talk radius 120 once |  | PlayerKnowsSandraRenton, SandraWentToCalifornia | req JoJoAndSandraOverheard_Played, req JoJoFine_Dead, req !PlayerKilledRenton |  | trig SandraLeaves |
| `FamilySquabbleWrapUpS` | SandraRenton (NYC_Hotel) | talk bump/frob/radius 160 |  | FamilySquabbleWrapUp_Played | req JoJoFine_Dead, req !GilbertRenton_Dead, req !SandraRenton_Dead, req M03OverhearSquabble_Played, req !FamilySquabbleWrapUp_Played, req SandraGilbertTogether, req !PlayerKilledRenton |  |  |
| `FamilySquabbleWrapUpGilbertDead` | SandraRenton (NYC_Hotel) | talk radius 120 once |  | PlayerKnowsSandraRenton, SandraWentToCalifornia | req JoJoFine_Dead, req GilbertRenton_Dead, req !SandraRenton_Dead, req M03OverhearSquabble_Played, req !PlayerKilledRenton |  | trig SandraLeaves |
| `M04MeetCarter` | SamCarter (NYC_UNATCOHQ) | talk bump/frob/radius 80 | 4 | M04WantDart@giveassault, M04CarterDone@giveassault, M04WantShotgun@giveshotgun, M04CarterDone@giveshotgun, M04WantSniper@givesniper, M04CarterDone@givesniper, M04WantPistol@givepistol, M04CarterDone@givepistol (+1 more) | req !M04CarterDone, ? M04MeetCarter_Played, ? PlayerKilledLebedev, ? ManderleyDebriefing03_Played, ? M04WantPistol, ? M04WantSniper, ? M04WantShotgun |  | give AmmoDartPoison, give AmmoShell, give Ammo3006, give AmmoRocket |
| `M04MeetSally` | Sally (NYC_Street) | talk radius 140 once |  | PlayerKnowsAboutRaid, M04MeetSally2_Played@Dead | req !TalkedToPaulAfterMessage_Played, ? JoJoFine_Dead |  |  |
| `M04RiotCop2Barks` | RiotCop2 (NYC_Street) | ovh bump/frob/radius 200 |  | PlayerKnowsAboutRaid |  |  |  |
| `TalkedToPaulAfterMessage` | PaulDenton (NYC_Hotel) | talk once |  |  | req PaulInjured_Played, req NSFSignalSent | done ReturnToPaul, +P EscapeToBatteryPark, +note |  |
| `PaulInjured` | PaulDenton (NYC_Hotel) | talk bump/frob/radius 100 once |  | GatesOpen@continue, KnowsSmugglerPassword@Password | ? PlayerKnowsAboutRaid, ? AnnaNavarre_Dead, ? !KnowsSmugglerPassword | done CheckOnPaul, +P InvestigateNSF, +note | give Image04_NSFHeadquarters |
| `PaulBeforeAttack2` | PaulDenton (NYC_Hotel) | ovh bump/frob/radius 100 once |  |  | req !M04RaidBegan, req PaulBeforeAttack_Played |  | trig RaidBegin |
| `ManderleyDebriefing03` | JosephManderley (NYC_UNATCOHQ) | talk radius 160 once |  |  | ? M03PlayerKilledAnna, ? !PlayerKilledLebedev | done SeeManderley, +P GoToHelipad | cr 3000 |
| `M04JordanSheaConvos` | JordanShea (NYC_Bar) | talk bump/frob/radius 80 | 7 | M04JordanHack3, M04JordanHack1@SecondVisit, PlayerKnowsAboutRaid@SecondVisit, M04JordanHack2@ThirdVisit, M04JordanWarning2@Warning2, M04JordanWarning1@Warning1 | ? TalkedToPaulAfterMessage_Played, ? !M04JordanWarning1, ? M04JordanWarning1, ? !M04JordanWarning2, ? !M04JordanSheaConvos_Played, ? M04JordanSheaConvos_Played, ? !M04JordanHack1, ? M04JordanHack1, ? !M04JordanHack2 (+1 more) |  | give Liquor40oz, give SodaCan, give Candybar, cr -10 |
| `M04MeetJoeGreen` | JoeGreene (NYC_Bar) | talk bump/frob/radius 100 once |  | PlayerKnowsAboutRaid, PlayerKnowsJoeGreen | req !TalkedToPaulAfterMessage_Played, ? !MeetJoeGreen_Played, ? !JordanShea_Dead, ? M02QuestionedGreen, ? JordanShea_Dead |  |  |
| `JockTellsAboutPaul` | Jock (NYC_BatteryPark, NYC_Street, NYC_UNATCOIsland) | talk bump/frob/radius 250 once |  | M04PlayerLeftUNATCO | req !M04PlayerLeftUNATCO, req ManderleyDebriefing03_Played | done GoToHelipad | trig TimeToGo |
| `M04MeetJanice` | JaniceReed (NYC_UNATCOHQ) | talk bump/frob/radius 60 once |  | LookingForSimons | ? JaimeOverheard_Played | +S TellJaime |  |
| `M04MeetJaime2` | JaimeReyes (NYC_UNATCOHQ) | talk bump/frob once |  |  | req M04MeetJaime_Played, ? PlayerKilledLebedev, ? JuanLebedev_Dead, ? ManderleyDebriefing03_Played, ? M04HurtingBad, ? !M04JaimeGaveMedkit |  | trig JaimeLeaves, give medkit |
| `M04MeetJaime` | JaimeReyes (NYC_UNATCOHQ) | talk bump/frob once |  | M04HurtingBad@hurtingbad, M04JaimeGaveMedkit@hurtingbad | ? !LookingForSimons | done TellJaime | trig WaltonLeaves, give medkit |
| `M04MeetFilben` | HarleyFilben (NYC_Bar) | ovh bump/frob/radius 100 |  | PlayerKnowsAboutRaid | req !M04RaidBegan, ? PlayerMetFilben, ? M03MeetFilben_Played, ? JoJoFine_Dead |  |  |
| `GuntherShowdown` | GuntherHermann (NYC_BatteryPark) | talk sight/radius 300 once | 2 |  | req TalkedToPaulAfterMessage_Played, ? PaulDenton_Dead, ? M03PlayerKilledAnna |  | trig Mission4Exit, trig GuntherAttacksJC |
| `M03OverhearSquabble` | GilbertRenton (NYC_Hotel) | ovh radius 680 once |  | M03OverhearSquabble_Played, SandraGilbertTogether | req !GilbertRenton_Dead, req !SandraRenton_Dead, req !PlayerKilledRenton |  |  |
| `InterruptFamilySquabble` | GilbertRenton (NYC_Hotel) | talk bump/frob once | 10 | GaveRentonGun@GiveCommon | req !GilbertRenton_Dead, req !SandraRenton_Dead, req !PlayerKilledRenton |  | take WeaponAssaultShotgun, take WeaponSawedOffShotgun, take WeaponRifle, take WeaponMiniCrossbow, take WeaponAssaultGun, take WeaponStealthPistol, take WeaponPistol, take WeaponCombatKnife, has? WeaponPistol (+4 more) |
| `FamilySquabbleWrapUpSandraDead` | GilbertRenton (NYC_Hotel) | talk bump/frob/radius 120 once |  |  | req JoJoFine_Dead, req !GilbertRenton_Dead, req SandraRenton_Dead, req M03OverhearSquabble_Played, req !PlayerKilledRenton |  | trig GilbertWanders |
| `FamilySquabbleWrapUp` | GilbertRenton (NYC_Hotel) | talk bump/frob/radius 160 |  | SandraWentToCalifornia@Hop, GilbertDamagedJoJo@GilbertAStud | req JoJoFine_Dead, req !GilbertRenton_Dead, req !SandraRenton_Dead, req M03OverhearSquabble_Played, req !FamilySquabbleWrapUp_Played, req SandraGilbertTogether, req !PlayerKilledRenton, ? JoJoOverheard_Played (+1 more) |  | trig SandraLeaves, trig GilbertWanders, trig SandraWanders |
| `AnnaBadMama` | AnnaNavarre (NYC_BatteryPark) | talk radius 200 once |  |  | req TalkedToPaulAfterMessage_Played |  | trig AnnaAttacksJC |

Conversations that only wait for a flag or check one, and change no state (70; `?` = a `CheckFlag` event): `DL_PaulCalling` (!PaulInjured_Played), `DL_JockTakesOff` (TalkedToPaulAfterMessage_Played), `M04WaltonBarks` (M04MeetWalton2_Played), `M04MeetWalton2` (M04MeetWalton_Played), `M04TroopBarks` (? !AnnaNavarre_Dead (+4 more)), `GateGuardBarks` (M04MeetGateGuard_Played), `M04TrooperTalking2Barks` (M04TroopersOverheard_Played), `M04TrooperTalking1Barks` (M04TroopersOverheard_Played), `M04StreetBumBarks` (? TalkedToPaulAfterMessage_Played), `M04SickWomanBarks` (? M04SickWomanBarks_Played), `M04SickManBarks` (? M04SickManBarks_Played), `M04ShannonBarks` (? BathroomBarks_Played (+1 more)), `M04ScottBarks` (? ManderleyDebriefing03_Played (+1 more)), `SandraWaitingForJoJoBarks` (!GilbertRenton_Dead (+5 more)), `SandraStayingBarks` (FamilySquabbleWrapUp_Played (+3 more)), `SandraMadAtPlayer` (PlayerKilledRenton), `SandraLeavingBarks` (FamilySquabbleWrapUp_Played (+2 more)), `SandraFightingWithGilbertBarks` (!GilbertRenton_Dead (+4 more)), `SandraFightingLostGilbertBarks` (GilbertRenton_Dead (+4 more)), `SandraFightingAloneBarks` (!JoJoFine_Dead (+2 more)), `M03SandraFamilyBarks` (!GilbertRenton_Dead (+4 more)), `FamilySquabbleWalkingToWrapUpS` (JoJoFine_Dead, !GilbertRenton_Dead (+5 more)), `M04CarterBarks` (M04CarterDone), `M04SallyScared` (TalkedToPaulAfterMessage_Played), `M04SallyBarks2` (M04MeetSally2_Played (+1 more)), `M04SallyBarks` (M04MeetSally_Played, !JoJoFine_Dead (+1 more)), `M04MeetSally2` (M04MeetSally_Played, JoJoFine_Dead, !TalkedToPaulAfterMessage_Played), `M04LloydBarks` (? ManderleyDebriefing03_Played (+2 more)), `PaulInjured2` (PaulInjured_Played, !NSFSignalSent, ? MeetLebedev2_Played), `PaulDuringAttack` (M04RaidBegan, !M04RaidDone), `PaulDummyHopBarks` (M04PlayerLikesUNATCO_Played (+1 more)), `PaulBeforeAttack` (TalkedToPaulAfterMessage_Played (+1 more)), `PaulAfterBadMama` (AnnaBadMama_Played), `PaulAfterAttack` (M04RaidBegan, M04RaidDone (+1 more)), `M04PlayerLikesUNATCO` (M04MeetGateGuard_Played, !NSFSignalSent), `M04PaulWaiting` (!NSFSignalSent, PaulInjured2_Played), `LoveTroopOverheard2` (LoveTroopOverheard_Played), `M04ManderleyBarks` (ManderleyDebriefing03_Played), `JoJoOverheard` (!GilbertRenton_Dead (+5 more)), `JoJoEntering2` (!JoJoAlone_Played (+1 more)), `JoJoEntering` (!JoJoAlone_Played (+1 more)), `JoJoAndSandraOverheard` (GilbertRenton_Dead (+2 more)), `JoJoAndGilbertOverheard` (!GilbertRenton_Dead (+2 more)), `JoJoAloneBarks` (JoJoAlone_Played), `JoJoAlone` (GilbertRenton_Dead, SandraRenton_Dead, !JoJoAndGilbertOverheard_Played (+1 more)), `M04MeetJoeGreen2` (M04MeetJoeGreen_Played, !TalkedToPaulAfterMessage_Played), `M04GreenInitialBarks` (!TalkedToPaulAfterMessage_Played (+1 more)), `M04GreenFinalBarks` (M04GreenAdvice_Played), `M04GreenAdvice` (TalkedToPaulAfterMessage_Played), `JockUNATCOWaiting` (!M04PlayerLeftUNATCO (+1 more)), `JockUNATCOFinalWaiting` (!M04PlayerLeftUNATCO (+2 more)), `JockBatteryPark2` (M04PlayerLeftUNATCO (+2 more)), `JockBatteryPark` (M04PlayerLeftUNATCO (+1 more)), `M04JaniceBarks` (M04MeetJanice_Played (+1 more)), `M04JaimeBarks` (M04MeetJaime2_Played (+1 more)), `GilbertWaitingForJoJoBarks` (InterruptFamilySquabble_Played (+4 more)), `GilbertMadAtPlayer` (PlayerKilledRenton), `GilbertFightingWithDaughterBarks` (!GilbertRenton_Dead (+4 more)), `GilbertFightingLostDaughterBarks` (!GilbertRenton_Dead (+4 more)), `GilbertFightingJoJoBarks` (!JoJoFine_Dead (+2 more)), `GilbertDaughterStayedBarks` (FamilySquabbleWrapUp_Played (+2 more)), `GilbertDaughterLeftBarks` (FamilySquabbleWrapUp_Played (+2 more)), `GilbertDaughterDeadBarks` (FamilySquabbleWrapUpSandraDead_Played (+1 more)), `GilbertAttackedByJoJoBarks` (JoJoAndGilbertOverheard_Played (+2 more)), `FamilySquabbleWalkingToWrapUp` (JoJoFine_Dead, !GilbertRenton_Dead (+5 more)), `M04SchickBarks` (M04MeetSchick_Played (+1 more)), `CokeTroopBarks` (!TalkedToPaulAfterMessage_Played (+2 more)), `M04ClintonGuardBarks` (? AnnaNavarre_Dead), `M04MeetAlex` (? AnnaNavarre_Dead, ? !PlayerKilledLebedev), `M04AlexBarks` (M04MeetAlex_Played).

Plain InfoLinks, no flag and no event: 0 (listed with their starters in the InfoLink table).

Plain conversations with an actor (5): WaltonSimons: WaltonSimons_BarkAllianceHostile WaltonSimons_BarkAllianceFriendly; UNATCOGateGuard: M04MeetGateGuard; FordSchick: M04MeetSchick; ComputerVoice: SendingSignal.

Plain overheard conversations (27): WaltonSimons: WaltonSimons_BarkFutz; JosephManderley: JosephManderley_BarkAllianceHostile JosephManderley_BarkAllianceFriendly; Nurse2: Nurse2Barks; Nurse1: Nurse1Barks; ClinicSecretary: ClinicSecretaryBarks; Veteran: M04VeteranBarks; UNATCOCrimeSceneGuard: UNATCOCrimeSceneGuardBarks; TrooperTalking1: M04TroopersOverheard; StreetBumOld: StreetBumOldBarks; StreetBum: M04StreetBumBarksBump; Smuggler: M04SmugglerIdleBarks; SickWoman: M04Sickies; PrisonGuard: M04PrisonGuard; PerimeterGuard: M04PerimeterGuardBarks; ParkBumFemale1: M04ParkBumFemale1; ParkBum2: M04ParkBum2Barks; ParkBum1: M04ParkBum1Barks; NSFHQUpstairsGuard: UpstairsBarks; NSFHQBalconyGuard: BalconyBarks; MichaelBerry: M04BerryOverheard M04BerryBarks; LoveTroop: LoveTroopOverheard LoveTroopBarks; JaimeReyes: JaimeOverheard; CorporalCollins: M04CollinsBarks; Billy: M04BillyBarks.

InfoLinks and what starts them:

| InfoLink | Started by | Needs | Sets / does |
| --- | --- | --- | --- |
| `DL_SimonsPissed` | NYC_NSFHQ/DataLinkTrigger1 (16,169) needs NSFSignalSent, NYC_NSFHQ/DataLinkTrigger2 (-18,-43) needs NSFSignalSent (+5 more) | MostWarehouseTroopsDead | done InvestigateNSF |
| `DL_SeeManderley` | NYC_UNATCOIsland/DataLinkTrigger0 (-4688,2712) | PlayerKilledLebedev | done AssassinateLebedev, +goal SeeManderley |
| `DL_PaulNSFHQ` | NYC_NSFHQ/DataLinkTrigger0 (-242,-1331) needs PaulInjured_Played |  |  |
| `DL_PaulGoodJob` | NYC_NSFHQ/DataLinkTrigger8 (104,458) | !NSFSignalSent, CanSendSignal | set NSFSignalSent, +goal ReturnToPaul, done SendSignal, sp 300 |
| `DL_PaulCalling` | (none found) | !PaulInjured_Played |  |
| `DL_JockTakesOff` | NYC_Street/DataLinkTrigger1 (2411,-1822) needs TalkedToPaulAfterMessage_Played | TalkedToPaulAfterMessage_Played |  |
| `DL_JockParkStart` | NYC_Street/DataLinkTrigger0 (-532,366), NYC_Street/DataLinkTrigger2 (878,887), NYC_Street/DataLinkTrigger3 (-384,871) |  | +goal CheckOnPaul |
| `DL_GotUplinkCode` | NYC_NSFHQ/DataLinkTrigger4 (1093,1388) needs !NSFSignalSent | GotUplinkCode | done InvestigateNSF, +goal SendSignal |

**Required (progression) conversations**, from the chains: the island's helicopter needs `ManderleyDebriefing03` (HQ, radius 160; adds `GoToHelipad`) and `JockTellsAboutPaul` (Jock, radius 250; needs `ManderleyDebriefing03_Played`, fires `TimeToGo`; a `FlagTrigger`
on `ManderleyDebriefing03_Played` fires `ChopperExit`). At the hotel `PaulInjured` (Paul, bump/frob/radius 100) adds `InvestigateNSF` and `TalkedToPaulAfterMessage` needs `PaulInjured_Played` and `NSFSignalSent`; `NSFSignalSent` is set by
`DL_PaulGoodJob` (needs `CanSendSignal`: all three dishes in position, each set by an NSFHQ FlagTrigger) or by `04_NYC_NSFHQ/FlagTrigger10`; `GuntherShowdown` (Gunther, `sight/radius 300`, needs `TalkedToPaulAfterMessage_Played`) fires `Mission4Exit`
on "I surrender." (or without a choice when Anna was killed, branch `AnnaDead2`). "Here comes your chance to be a hero." fires `GuntherAttacksJC` and leaves only the death exit.

### 04.4 Objectives

| Goal | Kind | Text | Added by | Completed by |
| --- | --- | --- | --- | --- |
| `InvestigateNSF` | primary | Investigate the captured NSF base to the west behind the bar to see if Paul is telling the truth about UNATCO. If he is, help the rebels by sending a  | PaulInjured | DL_SimonsPissed, DL_GotUplinkCode |
| `AssassinateLebedev` | carried |  | - | DL_SeeManderley |
| `SeeManderley` | primary | See Manderley for a debriefing. | DL_SeeManderley | ManderleyDebriefing03 |
| `ReturnToPaul` | primary | Meet up with Paul and help him leave New York. | DL_PaulGoodJob | TalkedToPaulAfterMessage |
| `SendSignal` | primary | Send the NSF distress signal from the satellite transmitter on the roof of NSFHQ. | DL_GotUplinkCode | DL_PaulGoodJob |
| `CheckOnPaul` | primary | Your brother's in trouble. Go to the apartment in Hell's Kitchen and see if he needs your help. | DL_JockParkStart | PaulInjured |
| `EscapeToBatteryPark` | primary | Find Jock's helicopter in Battery Park, the only way out of New York not controlled by UNATCO. The code to the Hell's Kitchen subway station is 6282. | TalkedToPaulAfterMessage | Mission04.Timer:92, 04_NYC_BatteryPark/GoalCompleteTrigger0, 04_NYC_BatteryPark/GoalCompleteTrigger1, 04_NYC_BatteryPark/GoalCompleteTrigger2 |
| `GoToHelipad` | primary | Meet Jock at the helipad to be taken to a new assignment in Hong Kong. | ManderleyDebriefing03 | JockTellsAboutPaul |
| `TellJaime` | secondary | Tell Jaime that Walton Simons is looking for him. | M04MeetJanice | M04MeetJaime |

### 04.5 Choices with lasting consequences

Set here, alive in a later mission:

| Flag | Set here by | Expires | Read later by |
| --- | --- | --- | --- |
| `M04MetWalton` | conversation M04MeetWalton | never | M14 checks in WaltonShowdown |
| `PlayerBailedOutWindow` | trigger 04_NYC_Hotel/FlagTrigger9 | mission 6 | M5 script Mission05.FirstFrame:37 |
| `SandraWentToCalifornia` | conversation SandraAttackedByJoJoThanks; conversation FamilySquabbleWrapUpGilbertDead; conversation FamilySquabbleWrapUp@Hop | never | M12 checks in MeetBum_M; M12 checks in BumsOverheard2; M12 checks in BumsOverheard; M8 checks in M08MeetSailor; M8 script Mission08.FirstFrame:19; ... |

Read here, set earlier:

| Flag | Set earlier by | Read here by |
| --- | --- | --- |
| `AnnaKilledLebedev` | M3 script Mission03.Timer:312 | checks in M04LloydBarks |
| `BathroomBarks_Played` | M1 conversation BathroomBarks | checks in M04ShannonBarks |
| `FordSchickRescued` | M2 script Mission02.PreTravel:122 | checks in M04MeetSmuggler |
| `M02QuestionedGreen` | M2 conversation MeetJoeGreen2@GreenQuestioned | checks in M04MeetJoeGreen |
| `M03PlayerKilledAnna` | M3 conversation DL_AlexShocked | checks in ManderleyDebriefing03; checks in GuntherShowdown; checks in CokeTroopBarks |
| `MeetJoeGreen_Played` | M2 conversation MeetJoeGreen | checks in M04MeetJoeGreen |
| `PlayerKilledLebedev` | M3 script Mission03.Timer:309; M3 script Mission03.Timer:322 | checks in DL_SeeManderley; checks in M04TroopBarks; checks in M04ScottBarks; checks in M04MeetCarter; checks in M04LloydBarks; checks in ManderleyDebriefing03 |
| `PlayerMetFilben` | M1 conversation MeetFilbenAfterStatue; M1 conversation MeetFilben; M3 conversation M03MeetFilben@FirstMeeting | checks in M04MeetFilben |

* **Surrender or fight** (`GuntherShowdown`): both end in mission 5 (the MJ12 lab); the difference is only how (travel by conversation event vs by death), the arrival state (what the travel text carries from a pawn that is in the `Dying` state was not read: unverified) and `GuntherHermann_Dead` if the player kills him.
* **Renton**: `PlayerKilledRenton` (expiration 5), `GaveRentonGun` (permanent; chooses who attacks whom in the hotel: `GilbertAttacksJoJo` vs `JoJoAttacksGilbert`), and the later `SandraWentToCalifornia` (permanent; read in missions 8 and 12 where Sandra's whereabouts change).
* **Walton Simons** (`M04MetWalton`): read in mission 14 by `WaltonShowdown`.
* **The dead**: `JoJoFine_Dead`, `SandraRenton_Dead`, `GilbertRenton_Dead`, `HarleyFilben_Dead` (read in mission 8, `Mission08.Timer:175`), `Sally_Dead`, `Pimp_Dead`, `FordSchick_Dead`, `GuntherHermann_Dead`, `JoeGreene_Dead` (read in mission 8, `Mission08.uc:77`).

### 04.6 Progression path

1. Island arrival; HQ: `ManderleyDebriefing03`; back to the island: `JockTellsAboutPaul` -> `ChopperLeave` -> `MapExit0` -> `04_NYC_Street`.
2. Street -> hotel (`ToHotelFront`/`ToHotelBedroom`): `FlagTrigger16` sets `ApartmentEntered`; `PaulInjured` (Paul) adds `InvestigateNSF` and gives the smuggler's password (`KnowsSmugglerPassword`).
3. Street -> `04_NYC_NSFHQ` (`ToNSFHQ`): position the three dishes (`FlagTrigger3/17/18` set `Dish1/2/3InPosition`), `CanSendSignal`, send the signal (`DL_PaulGoodJob` or `FlagTrigger10`) -> `NSFSignalSent`.
4. At the hotel, `Mission04.Timer` runs the raid (`M04RaidTeleportDone`) and starts `TalkedToPaulAfterMessage`; goals `ReturnToPaul` done, `EscapeToBatteryPark` added ("the code to the Hell's Kitchen subway station is 6282").
5. Battery Park (`ToBatteryPark` teleporters): `GuntherShowdown` -> "I surrender." -> `Mission4Exit` -> `MapExit0/1` -> `05_NYC_UNATCOMJ12lab`; or die after step 4 -> `SendPlayer`.

| Map | Tag (movers) | Lock | Opened by |
| --- | --- | --- | --- |
| `04_NYC_BatteryPark` | `DeusExMover16` (1) | locked | frob |
| `04_NYC_BatteryPark` | `TrainDoors` (3) | unlocked, not frobbable | SubwayControlPanel SubwayControlPanel3, SubwayControlPanel SubwayControlPanel4, SubwayControlPanel SubwayControlPanel5 |
| `04_NYC_Hotel` | `SecretRoom` (2) | unlocked, not frobbable | Keypad1 Keypad0, Switch1 Switch0 |
| `04_NYC_NSFHQ` | `SlidingDoor2Move` (1) | unlocked, not frobbable | Trigger Trigger5 |
| `04_NYC_NSFHQ` | `SlidingDoor1Move` (1) | unlocked, not frobbable | Trigger Trigger6 |
| `04_NYC_NSFHQ` | `TurretDoor1` (1) | unlocked, pick 0.20, breakable 0.75, not frobbable | Trigger Trigger1 |
| `04_NYC_NSFHQ` | `TurretDoor2` (1) | unlocked, pick 0.20, breakable 0.75, not frobbable | Trigger Trigger3 |
| `04_NYC_NSFHQ` | `TurretDoor3` (1) | unlocked, pick 0.20, breakable 0.75, not frobbable | Trigger Trigger0 |
| `04_NYC_NSFHQ` | `ExitDoor` (1) | unlocked, breakable 0.75, not frobbable | Switch2 Switch2 |
| `04_NYC_NSFHQ` | `RoofDoor` (1) | unlocked, pick 0.20 | Trigger Trigger2 |
| `04_NYC_Smug` | `elevatorbutton` (1) | unlocked, pick 0.20, not frobbable | Switch1 Switch4, Switch1 Switch5, Switch1 Switch3 |
| `04_NYC_Smug` | `mirrordoor` (1) | locked, breakable 1.00, not frobbable | Keypad3 Keypad1 |
| `04_NYC_Smug` | `botordertrigger` (1) | unlocked, pick 0.20, not frobbable | BeamTrigger BeamTrigger0, BeamTrigger BeamTrigger1, BeamTrigger BeamTrigger2, Switch2 Switch0 |
| `04_NYC_Street` | `elevatorbutton` (1) | unlocked, pick 0.20, not frobbable | Switch1 Switch0, Switch1 Switch31, Switch1 Switch4, Switch1 Switch5 |
| `04_NYC_Street` | `TrainDoors` (3) | unlocked, not frobbable | SubwayControlPanel SubwayControlPanel6, SubwayControlPanel SubwayControlPanel7, SubwayControlPanel SubwayControlPanel8 |
| `04_NYC_Street` | `MainGates` (2) | unlocked, not frobbable | FlagTrigger FlagTrigger0 |
| `04_NYC_Street` | `SmugglersFrontDoor` (1) | unlocked, not frobbable | Button1 Button0, conversation SmugglerDoorBellConvo[KnowsPassword] |
| `04_NYC_Street` | `SubGate` (1) | unlocked, pick 0.20, not frobbable | Keypad2 Keypad0 |
| `04_NYC_UNATCOHQ` | `alexcloset` (1) | locked, not frobbable | Keypad2 Keypad1 |
| `04_NYC_UNATCOHQ` | `DeusExMover20` (1) | locked | frob |
| `04_NYC_UNATCOHQ` | `DeusExMover26` (1) | locked, not frobbable | (nothing found) |
| `04_NYC_UNATCOHQ` | `UN_blastdoor` (1) | unlocked, not frobbable | RetinalScanner RetinalScanner0, Button1 Button0 |
| `04_NYC_UNATCOHQ` | `cannotopen` (1) | locked | Switch2 Switch0 |
| `04_NYC_UNATCOHQ` | `UN_blastdoor2` (1) | locked, not frobbable | (nothing found) |
| `04_NYC_UNATCOIsland` | `commvan_door` (1) | locked | Keypad1 Keypad0, Switch2 Switch0 |
| `04_NYC_UNATCOIsland` | `UNATCOHQEntDoor` (2) | unlocked | Switch1 Switch2 |
| `04_NYC_Underground` | `SewerHatch` (1) | unlocked, not frobbable | Keypad1 Keypad2, Switch2 Switch1 |
| `04_NYC_Underground` | `DoorA` (1) | unlocked, not frobbable | Keypad1 Keypad11, Switch2 Switch0 |

Key doors (a placed `NanoKey` opens them, or the lock is picked; frob only): `CrackRoom`, `BasementDoor` x3, `UNcloset` x2, `JaimeClosetKey`, `UNhatchdoor`.

(19 further movers of these maps are locked with a pickable lock or breakable, take no key that exists as a placed `NanoKey` and are fired by no event: not listed.)

**Progression blocker (mission 4).** Any of: `ManderleyDebriefing03` or `JockTellsAboutPaul` not playing (no helicopter); `ApartmentEntered`/`PaulInjured_Played` not set; a dish not reaching `DishNInPosition` (no `CanSendSignal`, so no `NSFSignalSent`);
`TalkedToPaulAfterMessage` not starting (`Mission04.uc:141`); `GuntherShowdown` not firing; the death exit not calling `SendPlayer` (the Play-side
risk: a death in this mission must travel, not reach `DXOnly`).

### 04.7 Slots

| Slot | Map | Saved as | Saves, play time | Important NPCs dead or knocked out (all) | Lasting-choice flags in the file (all) | Goals still open |
| --- | --- | --- | --- | --- | --- | --- |
| N0010 | `04_NYC_Hotel` | NYC - 'Ton Hotel | 170, 327 min | DrugDealer, GilbertTerrorist, JuanLebedev, Terrorist | AmbrosiaTagged, AnnaKilledLebedev, BathroomBarks_Played, BatteryParkSlaughter, FilbenGaveKey, GuntherFreed, GuntherRespectsPlayer=0, HeardGrenadeTalk, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, M04MetWalton, MeetJoeGreen_Played, PlayerMetFilben, SubTerroristsDead | InvestigateNSF |
| N0011 | `04_NYC_Hotel` | NYC - 'Ton Hotel | 195, 364 min | DrugDealer, GilbertTerrorist, JuanLebedev, Terrorist | AmbrosiaTagged, AnnaKilledLebedev, BathroomBarks_Played, BatteryParkSlaughter, FilbenGaveKey, GuntherFreed, GuntherRespectsPlayer=0, HeardGrenadeTalk, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, M04MetWalton, MeetJoeGreen_Played, PlayerMetFilben, SubTerroristsDead | ReturnToPaul |

Both slots are in the hotel, N0010 with `InvestigateNSF` open and N0011 later (the three dishes in position, `CanSendSignal` and `NSFSignalSent` set, goal `ReturnToPaul`). Neither is at Battery Park, so `GuntherShowdown` and the death exit have to be reached by the row.

## Mission 05: the MJ12 lab and UNATCO (NYC)

Three maps. The player wakes in the secret MJ12 facility (arrival is a *capture*: inventory taken, health restored to at least 50 per region), finds Paul, gets out through the UNATCO HQ, has to deal with Anna Navarre, and leaves from the island's helipad
with Jock for Hong Kong. The two decisions with a future are Anna's death (forced by the key to the exit) and whom to take with you (Jaime, Alex, Miguel).

### 05.1 Maps and arrival

| Map | Actors | Level info (`MapName`; `MissionLocation`) | Startup text | Script | Arrives from | Leaves to |
| --- | --- | --- | --- | --- | --- | --- |
| `05_NYC_UNATCOHQ` | 1488 | 05_NYC_UNATCOHQ; NYC - UNATCO HQ | - | Mission05 | 05_NYC_UNATCOIsland#unatcohq; 05_NYC_UNATCOMJ12lab#UN_med | 05_NYC_UNATCOIsland#unatcoisland; 05_NYC_UNATCOMJ12lab#mj12 |
| `05_NYC_UNATCOIsland` | 901 | 05_NYC_UNATCOIsland; NYC - Liberty Island | - | Mission05 | 05_NYC_UNATCOHQ#unatcoisland | 06_HongKong_Helibase (path Camera1); 05_NYC_UNATCOHQ#unatcohq |
| `05_NYC_UNATCOMJ12lab` | 3043 | 05_NYC_UNATCOMJ12lab; Secret MJ12 Facility | Location: Unknown / Time:  Unknown | Mission05 | 04_NYC_BatteryPark x2 (path CameraPath); 05_NYC_UNATCOHQ#mj12 | 05_NYC_UNATCOHQ#UN_med |

* **Arrival.** `04_NYC_BatteryPark` `MapExit0`/`MapExit1` (camera `CameraPath`, tag `Mission4Exit`) or the scripted `SendPlayer(..., "05_NYC_UNATCOMJ12Lab")` of `Mission04.uc:93` -> `05_NYC_UNATCOMJ12lab`: `PlayerStart0` (-3087,1400,-155). The mission change 4 -> 5 wipes `Save\Current` and runs `DeleteExpiredFlags(5)`.
* **Inside.** Lab `Teleporter4` (portal `mj12`) <-> HQ `Teleporter4` (portal `UN_med`); HQ `Teleporter3` <-> Island `Teleporter1`.
* **Leaving.** `05_NYC_UNATCOIsland` `MapExit1` (camera `Camera1`, tag `ChopperExit`) -> `06_hongkong_helibase.dx`, fired by the `Trigger` events of `M05MeetJock` (branch `continue`) and `MiguelHack` (branch `Hop`, when Miguel is brought along).

| Map | Actor | At | Leads to | Fired by (events targeting its tag) |
| --- | --- | --- | --- | --- |
| `05_NYC_UNATCOIsland` | MapExit `MapExit1` | -5759,2214,-113 | `06_hongkong_helibase.dx` (path `Camera1`) | tag `ChopperExit`: conversation MiguelHack[Hop], conversation M05MeetJock[continue] |

**05_NYC_UNATCOIsland MapExit1 -> 06_hongkong_helibase** (tag `ChopperExit`)

```text
event ChopperExit
  conversation event Trigger "ChopperExit" in MiguelHack branch Hop
    conversation MiguelHack [talk; owner Jock]
      starts: jump from M05MeetJock
        conversation M05MeetJock [talk bump/frob/radius 240; owner Jock]
          starts: its actor (bump/frob/radius 240)
  conversation event Trigger "ChopperExit" in M05MeetJock branch continue
    conversation M05MeetJock [talk bump/frob/radius 240; owner Jock] (seen above)
```

### 05.2 Mission script `Mission05`

`.cache/research/src/DeusEx/Mission05.uc`, 239 lines.

* `FirstFrame` (`:12-121`): lab: `GoalCompleted('EscapeToBatteryPark')` (`:26`); `PaulDentonCarcass` destroyed unless `PaulDenton_Dead`; when `M05PaulDentonDone` or `PlayerBailedOutWindow` (**set in mission 4 by the hotel's `FlagTrigger9`, expiration 6**) the Paul pawn is destroyed
  (`:36-41`); Miguel destroyed if `MeetMiguel_Played` and not `MiguelFollowing`. **First entry (`MS_InventoryRemoved` unset, `:54-95`)**: every body-region health is raised to at least 50; each displayable inventory item (not the `NanoKeyRing`) is removed from the player
  and dropped at the next `SpawnPoint` tagged `player_inv`, weapons get their default pickup ammo (`MS_InventoryRemoved`, expiration 6). HQ and island: Miguel enters the world when `MiguelFollowing`; HQ: `Anna.MinHealth = 0`.
* `PreTravel` (`:129-132`): `Super` only. No `SendPlayer`/`ClientTravel`.
* `Timer` (`:140-235`): HQ: `CarterUnlock` unlocks the `supplydoor` movers (`MS_DoorUnlocked`, expiration 6); `annadies` kills Anna (`TakeDamage ... 'Shot'`, `MS_AnnaKilled`); `M05AnnaAtExit_Played` -> Anna `Attacking`; `simonsappears` / `M05MeetManderley_Played`
  or `M05SimonsAlone_Played` -> Walton `EnterWorld` / `LeaveWorld`; both killphrase pieces (`KnowsAnnasKillphrase1` and `2`) complete `FindAnnasKillphrase`; `AnnaNavarre_Dead` completes `EliminateAnna`. Lab: `PaulInMedLab_Played` -> `DL_Paul` (`MS_DL_Played`, expiration 6).
* Flags it sets: all with expiration 6 (alive through mission 5, deleted on entering mission 6): none outlives the mission. The flags that do (`JacobsonRecruited`, `JaimeRecruited`, `KnowsAboutKillphrase`) are set by conversations.
* Actors it touches: `PaulDenton(Carcass)`, `Terrorist` bound `Miguel`, `AnnaNavarre`, `WaltonSimons`, `DeusExMover supplydoor`, `SpawnPoint player_inv`, the player's inventory and health.

Generated from the script's calls (`inventory-campaign.mjs scripts`; `:N` is the first line):

* **Flags set** (9; `eN` = explicit expiration N, otherwise the default): `MS_InventoryRemoved` e6 (:94), `MS_DoorUnlocked` e6 (:160), `MS_AnnaKilled` e6 (:174), `MS_AnnaAttacking` e6 (:184), `MS_SimonsUnhidden` e6 (:194), `MS_SimonsHidden` e6 (:205), `MS_KillphraseGoalCleared` e6 (:214), `MS_EliminateAnna` e6 (:222), `MS_DL_Played` e6 (:232).
* **Flags read** (24): `PaulDenton_Dead`, `M05PaulDentonDone`, `PlayerBailedOutWindow`, `MeetMiguel_Played`, `MiguelFollowing`, `MS_InventoryRemoved`, `CarterUnlock`, `MS_DoorUnlocked`, `annadies`, `MS_AnnaKilled`, `M05AnnaAtExit_Played`, `MS_AnnaAttacking`, `simonsappears`, `MS_SimonsUnhidden`, `M05MeetManderley_Played`, `M05SimonsAlone_Played`, `MS_SimonsHidden`, `KnowsAnnasKillphrase1`, `KnowsAnnasKillphrase2`, `MS_KillphraseGoalCleared`, `AnnaNavarre_Dead`, `MS_EliminateAnna`, `MS_DL_Played`, `PaulInMedLab_Played`.
* **InfoLinks it starts**: `DL_Paul` (:231). **Conversations it starts by name**: none. **Goals it completes**: `EscapeToBatteryPark` (:26), `FindAnnasKillphrase` (:213), `EliminateAnna` (:221).
* **Spawns**: none. **Destroy calls**: 3; **EnterWorld/LeaveWorld calls**: 4. **Travel calls**: none.

### 05.3 Conversations and InfoLinks

61 conversations of the list besides the shared barks: 13 InfoLinks, 19 talk-type, 29 overheard. 5 have choices (the vendors `SvenConvos` and `M05ShannonConvos`, Miguel's
three `MeetMiguel` options and `ChangeMiguel`, and **`M05MeetJaime`**: "I'm going over to the resistance..." or "Stay here..."), 13 set flags, 33 need a flag, 11 add or complete goals.

**Choices.** Every choice that changes state, the block its speech jumps to and what that block does (choices that change no state are counted in one row per conversation):

| Conversation | Owner | Choice | Effects of the branch |
| --- | --- | --- | --- |
| `SvenConvos` | Sven | Here's 500. Tell me the security login. [needs !M03BoughtInfo, M03CanBuyInfo] | -> BuyInfo: set M03BoughtInfo |
| `SvenConvos` | Sven | I'll take the 762 ammo for 600. [needs !M03Bought762, M03CanBuy762] | -> Buy762: set M03Bought762, give Ammo762mm |
| `SvenConvos` | Sven | Give me the accuracy weapon mod for 750. [needs !M03BoughtAccuracy, M03CanBuyAccuracy] | -> BuyAccuracy: set M03BoughtAccuracy, give WeaponModAccuracy |
| `SvenConvos` | Sven | (4 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `M05ShannonConvos` | Shannon | Give me one of the scrambler grenades for 1250. [needs !M05BoughtScrambler3, M05CanBuyOne] | -> BuyOne: set M05BoughtScrambler1, give WeaponNanoVirusGrenade |
| `M05ShannonConvos` | Shannon | I'll take two for 2500. [needs !M05BoughtScrambler2, M05CanBuyTwo] | -> BuyTwo: set M05BoughtScrambler1, set M05BoughtScrambler2, give WeaponNanoVirusGrenade |
| `M05ShannonConvos` | Shannon | I'll give you 3750 for all three. [needs !M05BoughtScrambler1, M05CanBuyThree] | -> BuyThree: set M05BoughtScrambler1, set M05BoughtScrambler2, set M05BoughtScrambler3, give WeaponNanoVirusGrenade |
| `M05ShannonConvos` | Shannon | (2 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `MeetMiguel` | Miguel | Sure, come on. | -> GiveCommon: set MiguelFollowing, trig nsftrigger |
| `MeetMiguel` | Miguel | I'd rather that you wait here. | -> Wander: set MiguelWandering, trig nsfwander |
| `MeetMiguel` | Miguel | Just slip out. I'll handle the guards. | -> GiveNothing: set MiguelLeaving, trig nsfleave |
| `ChangeMiguel` | Miguel | Stay close. | -> Follow: set MiguelFollowing, set MiguelLeaving=0, set MiguelWandering=0, trig nsftrigger |
| `ChangeMiguel` | Miguel | Wait here. | -> Wander: set MiguelFollowing=0, set MiguelLeaving=0, set MiguelWandering, trig nsfwander |
| `ChangeMiguel` | Miguel | Make a break for it. | -> Leave: set MiguelFollowing=0, set MiguelLeaving, set MiguelWandering=0, trig nsfleave |
| `M05MeetJaime` | JaimeReyes | I'm going over to the resistance. Why don't you join me? We could meet | -> Recruit: set JaimeRecruited |
| `M05MeetJaime` | JaimeReyes | Stay here. I could use an ally inside UNATCO. | -> LeaveJaime: set JaimeLeftBehind |

**Conversations that change state** (choices, flags set, goals, items, events, skill points; the `Needs` column is kept on these rows):

| Conversation | Owner (BindName; maps with that actor) | Kind | Choices | Sets | Needs | Goals | Other |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `DL_UNATCO_Escape` | JCDenton | DL once |  |  | ? AnnaNavarre_Dead | done Escape, +P GoToHelipad |  |
| `DL_PrisonCell` | JCDenton | DL once |  |  | req AnnaNavarre_Dead, req !DL_PrisonCell2_Played | +P Escape | trig Lights_Out |
| `DL_PaulDead` | JCDenton | DL once |  | DatavaultImageSent |  | done FindPaul, +note |  |
| `DL_paul` | JCDenton | DL once |  | DatavaultImageSent |  | done FindPaul, +note |  |
| `DL_key` | JCDenton | DL once |  | AlexSaidKillAnna | req !M05MeetAlexJacobson_Played, ? AnnaNavarre_Dead | +P EliminateAnna, +P GetKeyFromAlex |  |
| `DL_Equipment` | JCDenton | DL once |  |  |  | done FindEquipment |  |
| `DL_Choice` | JCDenton | DL once |  |  | ? PaulDenton_Dead | +S FindEquipment, +P FindPaul | give Image05_NYC_MJ12Lab |
| `SvenConvos` | Sven (NYC_UNATCOMJ12lab) | talk bump/frob | 7 | M03CanBuy762=0@ChoiceStart, M03CanBuyAccuracy=0@ChoiceStart, M03CanBuyInfo=0@ChoiceStart, SvenDone@Done, M03BoughtInfo@BuyInfo, M03Bought762@Buy762, M03BoughtAccuracy@BuyAccuracy, M03CanBuyInfo@CanBuyInfo (+2 more) | req !SvenDone, ? SvenConvos_Played, ? BotModified, ? M03Bought762, ? M03BoughtAccuracy, ? M03BoughtInfo | +note | give Ammo762mm, give WeaponModAccuracy, cr -1850 |
| `M05ShannonConvos` | Shannon (NYC_UNATCOHQ) | talk bump/frob | 5 | M05CanBuyOne=0@ChoiceStart, M05CanBuyThree=0@ChoiceStart, M05CanBuyTwo=0@ChoiceStart, M05ShannonDone@Done, ShannonHushComment@Hush, M05BoughtScrambler1@BuyOne, M05BoughtScrambler3@SetThree, M05BoughtScrambler2@SetTwo (+13 more) | req !M05ShannonDone, ? M05ShannonConvos_Played, ? !ShannonHushComment, ? M05BoughtScrambler1, ? M05BoughtScrambler2, ? M05BoughtScrambler3 |  | give WeaponNanoVirusGrenade, give WeaponNanoVirusGrenade*2, give WeaponNanoVirusGrenade*3, cr -7500 |
| `M05MeetSamCarter` | SamCarter (NYC_UNATCOHQ) | talk radius 160 once |  | CarterRecruited, CarterShannonTruth@Shannon | ? M05ShannonConvos_Played, ? M05MeetSamCarter_Played |  | trig open_door |
| `PaulInMedLab` | PaulDenton (NYC_UNATCOMJ12lab) | talk bump/frob/radius 100 once |  | KnowsAboutKillphrase@Killphrase | ? !AnnaNavarre_Dead | +S FindAnnasKillprhase, +note | trig DL_paul |
| `MeetMiguel` | Miguel (NYC_UNATCOHQ, NYC_UNATCOIsland, NYC_UNATCOMJ12lab) | talk bump/frob | 3 | MiguelGaveMedkit@continue, MiguelFollowing@GiveCommon, MiguelLeaving@GiveNothing, MiguelWandering@Wander | req !MiguelGaveMedkit, ? MeetMiguel_Played, ? DL_Choice_Played, ? PaulDenton_Dead |  | trig nsftrigger, trig nsfleave, trig nsfwander, give Medkit |
| `ChangeMiguel` | Miguel (NYC_UNATCOHQ, NYC_UNATCOIsland, NYC_UNATCOMJ12lab) | talk frob | 3 | MiguelFollowing@Follow, MiguelLeaving=0@Follow, MiguelWandering=0@Follow, MiguelFollowing=0@Wander, MiguelLeaving=0@Wander, MiguelWandering@Wander, MiguelFollowing=0@Leave, MiguelLeaving@Leave, MiguelWandering=0@Leave | req MiguelGaveMedkit |  | trig nsftrigger, trig nsfwander, trig nsfleave |
| `MiguelHack` | Jock (NYC_UNATCOIsland) | talk once |  | MiguelFollowing=0@Hop, MiguelLeaving=0@Hop, MiguelWandering@Hop |  |  | trig nsfwander, trig ChopperExit |
| `M05MeetJock` | Jock (NYC_UNATCOIsland) | talk bump/frob/radius 240 once |  |  | ? !PaulDenton_Dead, ? MiguelFollowing, ? !Miguel_Dead | done Escape, done GoToHelipad | trig ChopperExit |
| `M05MeetJaime` | JaimeReyes (NYC_UNATCOHQ) | talk bump/frob once | 2 | JaimeRecruited@Recruit, JaimeLeftBehind@LeaveJaime | ? PaulDenton_Dead |  |  |
| `MeetDoctorMoreau` | DoctorMoreau (NYC_UNATCOMJ12lab) | talk bump/frob/radius 120 once |  |  | ? PaulInMedLab_Played, ? !PaulDenton_Dead, ? PaulDenton_Dead | +note | trig moreaudone |
| `ChattingMJ12Overheard` | ChattingMJ12 (NYC_UNATCOMJ12lab) | ovh radius 300 once |  |  |  |  | trig chatdone |
| `M05AnnaTaunt` | AnnaNavarre (NYC_UNATCOHQ, NYC_UNATCOMJ12lab) | talk radius 128 once |  |  | req !DL_Choice_Played |  | trig AnnaDone |
| `M05AnnaAtExit` | AnnaNavarre (NYC_UNATCOHQ, NYC_UNATCOMJ12lab) | talk radius 475 once |  | M05AnnaAtExit_Played@Hop | req DL_Choice_Played, req !KnowsAnnasKillphrase1, req !KnowsAnnasKillphrase2, req !M05AnnaAtExit_Played |  | trig annahate |
| `AnnaExitKillphrase` | AnnaNavarre (NYC_UNATCOHQ, NYC_UNATCOMJ12lab) | talk radius 475 once |  |  | req KnowsAnnasKillphrase1, req DL_Choice_Played, req KnowsAnnasKillphrase2 | done FindAnnasKillprhase | trig AnnaDies |
| `M05MeetAlexJacobson` | AlexJacobson (NYC_UNATCOHQ) | talk bump/frob |  | JacobsonRecruited, M05AlexDone@common | req !M05AlexDone, ? !M05MeetAlexJacobson_Played, ? !AnnaNavarre_Dead, ? M05MeetAlexJacobson_Played, ? AnnaNavarre_Dead, ? DL_Key_Played, ? !AlexSaidKillAnna, ? AlexSaidKillAnna | done EliminateAnna, done GetKeyFromAlex, +P EliminateAnna, +P GetKeyFromAlex | give NanoKey |

Conversations that only wait for a flag or check one, and change no state (27; `?` = a `CheckFlag` event): `DL_PrisonCell2` (!AnnaNavarre_Dead, M05AnnaTaunt_Played, !DL_PrisonCell_Played), `DL_NoPaul` (!DatavaultImageSent), `DL_GuntherPissed` (AnnaNavarre_Dead), `M05WaltonAlone` (JosephManderley_Dead), `SvenBarks` (SvenDone), `M05ShannonBarks` (M05ShannonDone), `ScientistsConsulting2` (ScientistsConsulting_Played (+1 more)), `ScientistsConsulting` (? ScientistFemaleConsulting_Dead), `M05ScientistBarks` (M05ScientistInitialBark_Played), `M05CarterBarks2` (M05MeetSamCarter_Played (+2 more)), `M05CarterBarks` (M05MeetSamCarter_Played (+1 more)), `CarterTruth` (M05MeetSamCarter_Played, M05ShannonConvos_Played, !CarterShannonTruth), `M05PaulBarks` (PaulInMedLab_Played), `NurseBarks` (? PaulDenton_Dead), `MiguelWanderingBarks` (MiguelWandering), `MiguelLeavingBarks` (MiguelLeaving), `MiguelFightingBarks` (MiguelFollowing), `M05MeetManderley` (? AnnaNavarre_Dead), `M05ManderleyBarks` (M05MeetManderley_Played), `M05JaniceFinalBarks` (M05JaniceBark2_Played), `M05JaniceBark2` (M05JaniceBark1_Played), `M05JaimeBarks` (M05MeetJaime_Played (+1 more)), `MoreauBarks` (MeetDoctorMoreau_Played (+1 more)), `M05DoctorBarks` (? PaulDenton_Dead), `M05AnnaAtExit3` (DL_Choice_Played, !KnowsAnnasKillphrase2, KnowsAnnasKillphrase1, !M05AnnaAtExit_Played), `M05AnnaAtExit2` (DL_Choice_Played, KnowsAnnasKillphrase2, !KnowsAnnasKillphrase1, !M05AnnaAtExit_Played), `M05JacobsonBarks` (M05AlexDone, ? JosephManderley_Dead).

Plain InfoLinks, no flag and no event: 3 (listed with their starters in the InfoLink table).

Plain conversations with an actor (0): none.

Plain overheard conversations (9): Secretary: M05SecretaryScared; ScientistFemaleConsulting: ScientistFemaleConsultingBarks GreaselBark; ScientistFemale: ScientistFemaleBarks; ScientistConsulting: ScientistConsultingBarks; Scientist: M05ScientistInitialBark; Mechanic: M05MechanicBarks; JaniceReed: M05JaniceBark1; Doctor: M05DoctorRadiusBarks.

InfoLinks and what starts them:

| InfoLink | Started by | Needs | Sets / does |
| --- | --- | --- | --- |
| `DL_UNATCO_Escape` | NYC_UNATCOHQ/DataLinkTrigger0 (2809,2014) | AnnaNavarre_Dead | done Escape, +goal GoToHelipad |
| `DL_PrisonCell2` | NYC_UNATCOMJ12lab/DataLinkTrigger5 (-2946,1322) | !AnnaNavarre_Dead, M05AnnaTaunt_Played, !DL_PrisonCell_Played |  |
| `DL_PrisonCell` | NYC_UNATCOMJ12lab/DataLinkTrigger0 (-2941,1324), jump from DL_PrisonCell2 | AnnaNavarre_Dead, !DL_PrisonCell2_Played | +goal Escape, trig Lights_Out |
| `DL_PaulDead` | NYC_UNATCOMJ12lab/DataLinkTrigger6 (2179,-563) needs PaulDenton_Dead |  | set DatavaultImageSent, done FindPaul |
| `DL_paul` | NYC_UNATCOMJ12lab/DataLinkTrigger1 (2248,-532), Mission05.uc:231 |  | set DatavaultImageSent, done FindPaul |
| `DL_NoPaul` | NYC_UNATCOMJ12lab/DataLinkTrigger7 (-895,-518) | !DatavaultImageSent |  |
| `DL_Nano` | NYC_UNATCOMJ12lab/DataLinkTrigger3 (-834,2344) |  |  |
| `DL_key` | NYC_UNATCOHQ/DataLinkTrigger1 (-898,293) | !M05MeetAlexJacobson_Played, AnnaNavarre_Dead | set AlexSaidKillAnna, +goal EliminateAnna, +goal GetKeyFromAlex |
| `DL_GuntherPissed` | NYC_UNATCOIsland/DataLinkTrigger1 (-3863,1750) needs AnnaNavarre_Dead | AnnaNavarre_Dead |  |
| `DL_Equipment` | NYC_UNATCOMJ12lab/DataLinkTrigger10 (-8478,1244) |  | done FindEquipment |
| `DL_Comm` | NYC_UNATCOMJ12lab/DataLinkTrigger4 (-900,643) |  |  |
| `DL_Choice` | NYC_UNATCOMJ12lab/DataLinkTrigger2 (-1385,1600) | PaulDenton_Dead | +goal FindEquipment, +goal FindPaul, give Image05_NYC_MJ12Lab |
| `DL_BotBay` | NYC_UNATCOMJ12lab/DataLinkTrigger9 (-2978,2089) |  |  |

**Required (progression) conversations.** The chain's end is `M05MeetJock` (talk, bump/frob/radius 240, no required flag; it fires `ChopperExit`). The exit from the HQ is the unpickable, unbreakable, key-locked `levelone` mover (`DeusExMover29`, key `levelone`
at (-928,320,416)): the `NanoKey` comes from `M05MeetAlexJacobson`, whose three key-giving branches (`common`, `AlexContactedPlayer`, `AlexContactedPlayerB`) are all reached when `AnnaNavarre_Dead` is set (with Anna alive his `FirstVisitAlive` branch only adds
`EliminateAnna`/`GetKeyFromAlex`). So `AnnaNavarre_Dead` is required, by killing her or by the killphrase: `AnnaExitKillphrase` (radius 475; needs `KnowsAnnasKillphrase1`, `KnowsAnnasKillphrase2`, `DL_Choice_Played`) triggers `AnnaDies`, and `PaulInMedLab`'s
`Killphrase` branch (reached while `AnnaNavarre_Dead` is not set) sets `KnowsAboutKillphrase`. `DL_Choice` (lab, needs `PaulDenton_Dead` to add `FindEquipment`/`FindPaul`) and `DL_PrisonCell`, `DL_UNATCO_Escape`, `DL_key` mostly add goals and are not on the chain.

### 05.4 Objectives

| Goal | Kind | Text | Added by | Completed by |
| --- | --- | --- | --- | --- |
| `Escape` | primary | Escape from the Majestic 12 facility. | DL_PrisonCell | DL_UNATCO_Escape, M05MeetJock |
| `GoToHelipad` | primary | Escape from UNATCO and go to the helipad. | DL_UNATCO_Escape | M05MeetJock |
| `FindPaul` | primary | Find your brother and access information in his datavault that Tracer Tong will need to defeat the killswitch. | DL_Choice | DL_PaulDead, DL_paul |
| `EliminateAnna` | primary | Eliminate Anna Navarre. | DL_key, M05MeetAlexJacobson | M05MeetAlexJacobson, Mission05.Timer:221 |
| `GetKeyFromAlex` | primary | When Anna Navarre is dead, see Alex for a key to the exit. | DL_key, M05MeetAlexJacobson | M05MeetAlexJacobson |
| `FindEquipment` | secondary | Find the equipment taken from you when you were captured by UNATCO. | DL_Choice | DL_Equipment |
| `FindAnnasKillprhase` | secondary | Find Anna Navarre's killphrase. It is stored in two pieces on two computers, each with the login "demiurge" in the password "archon". | PaulInMedLab | AnnaExitKillphrase |
| `EscapeToBatteryPark` | carried |  | - | Mission05.FirstFrame:26 |
| `FindAnnasKillphrase` | carried |  | - | Mission05.Timer:213 |

### 05.5 Choices with lasting consequences

Set here, alive in a later mission:

| Flag | Set here by | Expires | Read later by |
| --- | --- | --- | --- |
| `JacobsonRecruited` | conversation M05MeetAlexJacobson | never | M6 script Mission06.FirstFrame:86 |
| `JaimeRecruited` | conversation M05MeetJaime@Recruit | never | M10 checks in DL_metrosewer; M6 checks in Base_Guard_MiddleBarks; M6 checks in M07AlexJacobsonBarks; M6 checks in M06MeetAlexJacobson; M6 checks in M06AlexJacobsonBarks; ... |
| `KnowsAboutKillphrase` | conversation PaulInMedLab@Killphrase | never | M10 checks in M10MeetJaime |

Read here, set earlier:

| Flag | Set earlier by | Read here by |
| --- | --- | --- |
| `PlayerBailedOutWindow` | M4 trigger 04_NYC_Hotel/FlagTrigger9 | script Mission05.FirstFrame:37 |

* **Jaime** (`M05MeetJaime`): "Join me" sets `JaimeRecruited`, which in Hong Kong makes `Mission06.FirstFrame:76` unhide him in the Tong base (after VersaLife) and drives the Alex/Jaime barks; in mission 10 `Mission10.FirstFrame:31` unhides Jaime in the Paris metro only when `JaimeRecruited` is **false** (the Jaime left behind meets the player at the cafe: goal `MeetJaime`), and `DL_metrosewer` reads the flag. "Stay here" sets `JaimeLeftBehind` (no reader in the data).
* **Alex Jacobson** (`M05MeetAlexJacobson`, always `JacobsonRecruited`): `Mission06.FirstFrame:86` unhides him in Hong Kong.
* **Anna** is dead for the rest of the game by construction (`AnnaNavarre_Dead`, permanent; read again in mission 11). **Paul**: `PaulDenton_Dead` is read through mission 6 and again in 15; `PlayerBailedOutWindow` (from the hotel in mission 4) decides whether he is in the lab at all.
* `KnowsAboutKillphrase` (Paul's killphrase talk) is read in mission 10 by `M10MeetJaime`.
* Miguel's flags (`MiguelFollowing`, `MiguelLeaving`, `MiguelWandering`) are set and read only in this mission.

### 05.6 Progression path

1. Lab, `PlayerStart0`. Leave the cells and reach `Teleporter4` (`mj12`); `DL_PrisonCell` fires `Lights_Out`. The lab's locked movers are in the table below.
2. HQ (`UN_med` arrival): Anna must die (the two killphrase pieces on two computers, whose login and password the goal text gives as `demiurge` and `archon`, then `AnnaExitKillphrase`; or force). Other HQ doors in the table: `supplydoor` (opened by `CarterUnlock`, `Mission05:154`), `UN_blastdoor2`, `cannotopen`.
3. `M05MeetAlexJacobson` after `AnnaNavarre_Dead`: the `NanoKey` for `levelone`; open it and go through `Teleporter3` to the island.
4. Island: walk to Jock at the helipad: `M05MeetJock` -> `ChopperExit` -> `MapExit1` -> `06_hongkong_helibase`.

| Map | Tag (movers) | Lock | Opened by |
| --- | --- | --- | --- |
| `05_NYC_UNATCOHQ` | `UNblastdoor` (1) | unlocked, not frobbable | Button1 Button0 |
| `05_NYC_UNATCOHQ` | `levelone` (1) | locked | frob |
| `05_NYC_UNATCOHQ` | `alexcloset` (1) | locked, pick 0.25 | Keypad2 Keypad1 |
| `05_NYC_UNATCOHQ` | `UN_blastdoor2` (1) | locked, not frobbable | Button1 Button1 |
| `05_NYC_UNATCOHQ` | `supplydoor` (1) | locked | Dispatcher Dispatcher0, Switch1 Switch0, script Mission05:154 |
| `05_NYC_UNATCOHQ` | `cannotopen` (1) | locked, not frobbable | Switch1 Switch1 |
| `05_NYC_UNATCOIsland` | `commvan_door` (1) | locked | Keypad1 Keypad0, Switch2 Switch0 |
| `05_NYC_UNATCOIsland` | `UN_maindoor` (2) | unlocked | Switch1 Switch2 |
| `05_NYC_UNATCOMJ12lab` | `Beastdoor` (2) | unlocked, not frobbable | Button1 Button4, Button1 Button1 |
| `05_NYC_UNATCOMJ12lab` | `nanocage` (4) | unlocked, pick 0.20, not frobbable | Button1 Button2 |
| `05_NYC_UNATCOMJ12lab` | `celldoor1` (1) | unlocked, not frobbable | Keypad3 Keypad4 |
| `05_NYC_UNATCOMJ12lab` | `celldoor2` (1) | unlocked, not frobbable | Dispatcher Dispatcher0, Trigger Trigger2 |
| `05_NYC_UNATCOMJ12lab` | `celldoor3` (1) | unlocked, not frobbable | Keypad3 Keypad6 |
| `05_NYC_UNATCOMJ12lab` | `celldoor4` (1) | unlocked, not frobbable | Keypad3 Keypad7 |
| `05_NYC_UNATCOMJ12lab` | `prisondoor` (1) | unlocked, pick 0.20, not frobbable | Keypad3 Keypad1, Keypad3 Keypad9, FlagTrigger FlagTrigger0 |
| `05_NYC_UNATCOMJ12lab` | `ExitDoor` (1) | unlocked, pick 0.20, not frobbable | Keypad3 Keypad11 |
| `05_NYC_UNATCOMJ12lab` | `armorydoor1` (1) | unlocked, pick 0.20, not frobbable | Keypad3 Keypad8, Button1 Button5 |
| `05_NYC_UNATCOMJ12lab` | `armorydoor2` (1) | unlocked, pick 0.20, not frobbable | Keypad3 Keypad13, Button1 Button6 |
| `05_NYC_UNATCOMJ12lab` | `MedDoor` (1) | unlocked, pick 0.20, not frobbable | Keypad3 Keypad3, Button1 Button7 |
| `05_NYC_UNATCOMJ12lab` | `lift` (1) | unlocked, pick 0.20, not frobbable | Dispatcher Dispatcher1, Dispatcher Dispatcher2 |
| `05_NYC_UNATCOMJ12lab` | `mirror` (1) | unlocked, pick 0.20, not frobbable | PatrolPoint PatrolPoint32, Trigger Trigger0, Trigger Trigger1 |
| `05_NYC_UNATCOMJ12lab` | `nanolabdoor` (1) | unlocked, pick 0.20, not frobbable | Switch1 Switch0, Switch1 Switch1 |
| `05_NYC_UNATCOMJ12lab` | `field002` (4) | unlocked, pick 0.20, not frobbable | Keypad3 Keypad2 |
| `05_NYC_UNATCOMJ12lab` | `screen` (3) | unlocked, pick 0.20, not frobbable | Keypad1 Keypad0 |

Key doors (a placed `NanoKey` opens them, or the lock is picked; frob only): `UNOfficeDoorKey` x3, `UNcloset` x2, `JaimeClosetKey`, `UNhatchdoor`.

(8 further movers of these maps are locked with a pickable lock or breakable, take no key that exists as a placed `NanoKey` and are fired by no event: not listed.)

**Progression blocker (mission 5).** `AnnaNavarre_Dead` never set (no key, `levelone` stays shut); `M05MeetAlexJacobson` not giving the `NanoKey`; the lab -> HQ -> island teleporters; `M05MeetJock` not firing `ChopperExit`; `MapExit1` not loading Hong Kong.
A bad inventory restore at the capture (`MS_InventoryRemoved`) is not a blocker but changes what the player carries into mission 6.

### 05.7 Slots

| Slot | Map | Saved as | Saves, play time | Important NPCs dead or knocked out (all) | Lasting-choice flags in the file (all) | Goals still open |
| --- | --- | --- | --- | --- | --- | --- |
| N0012 | `05_NYC_UNATCOMJ12lab` | Secret MJ12 Facility | 198, 375 min | DrugDealer, GilbertTerrorist, JoJoFine, JuanLebedev, Terrorist | AmbrosiaTagged, AnnaKilledLebedev, BathroomBarks_Played, BatteryParkSlaughter, FilbenGaveKey, GuntherFreed, GuntherRespectsPlayer=0, HeardGrenadeTalk, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, M04MetWalton, MeetJoeGreen_Played, PlayerMetFilben, SandraWentToCalifornia, SubTerroristsDead | - |
| N0013 | `05_NYC_UNATCOMJ12lab` | Secret MJ12 Facility | 226, 397 min | DrugDealer, GilbertTerrorist, JoJoFine, JuanLebedev, Terrorist | AmbrosiaTagged, AnnaKilledLebedev, BathroomBarks_Played, BatteryParkSlaughter, FilbenGaveKey, GuntherFreed, GuntherRespectsPlayer=0, HeardGrenadeTalk, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, M04MetWalton, MeetJoeGreen_Played, PlayerMetFilben, SandraWentToCalifornia, SubTerroristsDead | Escape, FindPaul |
| N0014 | `05_NYC_UNATCOHQ` | NYC - UNATCO HQ | 242, 420 min | DrugDealer, GilbertTerrorist, JoJoFine, JuanLebedev, Terrorist | AmbrosiaTagged, AnnaKilledLebedev, BathroomBarks_Played, BatteryParkSlaughter, FilbenGaveKey, GuntherFreed, GuntherRespectsPlayer=0, HeardGrenadeTalk, KnowsAboutKillphrase, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, M04MetWalton, MeetJoeGreen_Played, PlayerMetFilben, SandraWentToCalifornia, SubTerroristsDead | FindAnnasKillprhase, GoToHelipad |

N0012 and N0013 are both in the lab (N0013 later), N0014 in the HQ with `KnowsAboutKillphrase` set. None has Anna dead (the flag list has no `AnnaNavarre_Dead`), so the Alex/key step is reachable from all three.

## Mission 06: Hong Kong

Ten maps and the longest mission script of the game. The player lands on the MJ12 helibase, finds Tracer Tong, and has to unite the Red Arrow and Luminous Path triads (the Dragon's Tooth sword, Maggie Chow, the ceremony),
steal the plague schematic and destroy the Universal Constructor at VersaLife, before Tong's final briefing sends him to New York with Jock. The mission carries the beats of the story's old missions 6, 7 and 8:
the script and the conversations are full of `M07Briefing`/`M08Briefing` and the list of mission 7 (`ConList_Mission07`) is a byte-for-byte duplicate of mission 6's (checked: the 680 conversations, names and ids equal), which
no single-player map uses (the `DXMP_*` multiplayer maps carry the number 7, among others). There is no mission 7 or 13 in the installed game: no map, no script class, no `DeusExLevelInfo` with that number.

### 06.1 Maps and arrival

| Map | Actors | Level info (`MapName`; `MissionLocation`) | Startup text | Script | Arrives from | Leaves to |
| --- | --- | --- | --- | --- | --- | --- |
| `06_HongKong_Helibase` | 1917 | 06_HongKong_Helibase; Hong Kong - MJ12 Helibase | Hong Kong, Peoples Republic of China / Secret MJ12 helicopter base / High atop the VersaLife building | Mission06 | 05_NYC_UNATCOIsland (path Camera1); 06_HongKong_WanChai_Market#HeliBase | 06_HongKong_WanChai_Market#cargoup |
| `06_HongKong_MJ12lab` | 2308 | 06_HongKong_MJ12lab; Hong Kong - MJ12 Lab | Majestic Twelve Development Program / Pacific Rim Research Facility | Mission06 | 06_HongKong_Storage#tubeend; 06_HongKong_VersaLife#cathedral | 06_HongKong_VersaLife#secret; 06_HongKong_Storage#basement |
| `06_HongKong_Storage` | 1370 | 06_HongKong_Storage; Hong Kong - Nano Manufacturing | Level 2: / Nanotech Containment Facility / Deep beneath the VersaLife Building | Mission06 | 06_HongKong_MJ12lab#basement; 06_HongKong_WanChai_Canal#waterpipe; 06_HongKong_WanChai_Garage#BackDoor | 06_HongKong_MJ12lab#tubeend; 06_HongKong_WanChai_Canal#canal |
| `06_HongKong_TongBase` | 657 | 06_HongKong_TongBase; Hong Kong - Tong's Base | Tracer Tong's Laboratory | Mission06 | 06_HongKong_WanChai_Market#lab x2 | 06_HongKong_WanChai_Market#compound x2 |
| `06_HongKong_VersaLife` | 1760 | 06_HongKong_VersaLife; Hong Kong - VersaLife | The VersaLife Corporation / Data Entry Facility | Mission06 | 06_HongKong_MJ12lab#secret; 06_HongKong_WanChai_Market#lobby | 06_HongKong_MJ12lab#cathedral; 06_HongKong_WanChai_Market#market |
| `06_HongKong_WanChai_Canal` | 2750 | 06_HongKong_WanChai_Canal; Hong Kong - Waterways | - | Mission06 | 06_HongKong_Storage#canal; 06_HongKong_WanChai_Market#market01/double x2; 06_HongKong_WanChai_Street#Street/alleyin x2 | 06_HongKong_WanChai_Street#alleyout/Canal x3; 06_HongKong_WanChai_Market#canal01/chinahand x2; 06_HongKong_Storage#waterpipe |
| `06_HongKong_WanChai_Garage` | 356 | 06_HongKong_WanChai_Garage; Hong Kong - Canal Road | Canal Road Tunnel / WanChai Terminal | Mission06 | 06_HongKong_WanChai_Market#market04 | 06_HongKong_WanChai_Market#garage01 x2; 06_HongKong_Storage#BackDoor |
| `06_HongKong_WanChai_Market` | 2293 | 06_HongKong_WanChai_Market; Hong Kong - Market | Wan Chai Market / Hong Kong | Mission06 | 06_HongKong_Helibase#cargoup; 06_HongKong_TongBase#compound x2; 06_HongKong_VersaLife#market; 06_HongKong_WanChai_Canal#canal01/chinahand x2; 06_HongKong_WanChai_Garage#garage01 x2; 06_HongKong_WanChai_Underworld#canal03 x2 | 06_HongKong_Helibase#HeliBase; 06_HongKong_VersaLife#lobby; 08_NYC_Street (path CameraPath); 06_HongKong_TongBase#lab x2; 06_HongKong_WanChai_Garage#market04; 06_HongKong_WanChai_Canal#market01/double x2; 06_HongKong_WanChai_Underworld#market03 |
| `06_HongKong_WanChai_Street` | 2351 | 06_HongKong_WanChai_Street; Hong Kong - Tonnochi Road | Tonnochi Road / Wan Chai District | Mission06 | 06_HongKong_WanChai_Canal#alleyout/Canal x3 | 06_HongKong_WanChai_Canal#Street/alleyin x2 |
| `06_HongKong_WanChai_Underworld` | 1863 | 06_HongKong_WanChai_Underworld; Hong Kong - Lucky Money Club | Wan Chai Underground Mall / Home of the Lucky Money Club | Mission06 | 06_HongKong_WanChai_Market#market03 | 06_HongKong_WanChai_Market#canal03 x2 |

* **Arrival.** `05_NYC_UNATCOIsland` `MapExit1` (camera `Camera1`) -> `06_hongkong_helibase.dx`: `PlayerStart2` (1931,-32,496). Mission change 5 -> 6: `Save\Current` wiped, `DeleteExpiredFlags(6)` (removes `M01PlayerAggressive`).
* **Inside.** The elevators and lifts between the layers are `MapExit` actors with tags `change_floors`/`change_floors01` fired by buttons (Helibase -> Market `cargoup`; Market -> Helibase, Market <-> VersaLife; VersaLife <-> MJ12 lab; lab <-> Storage); the street level uses teleporters.
* **Leaving.** `06_HongKong_WanChai_Market` `MapExit2` (camera `CameraPath`, tag `outro_trigger`) -> `08_NYC_Street` (mission 8: the new numbering skips 7).

| Map | Actor | At | Leads to | Fired by (events targeting its tag) |
| --- | --- | --- | --- | --- |
| `06_HongKong_Helibase` | MapExit `MapExit0` | -2030,45,406 | `06_HongKong_WanChai_Market#cargoup` | tag `change_floors`: Button1 Button3 |
| `06_HongKong_MJ12lab` | MapExit `MapExit2` | 175,1740,150 | `06_HongKong_VersaLife#secret` | tag `change_floors01`: Button1 Button23 |
| `06_HongKong_MJ12lab` | MapExit `MapExit0` | -1249,972,-106 | `06_HongKong_Storage#basement` | tag `change_floors`: Button1 Button44 |
| `06_HongKong_Storage` | MapExit `MapExit0` | -911,-1038,1046 | `06_HongKong_MJ12lab#tubeend` | tag `change_floors`: Button1 Button1 |
| `06_HongKong_VersaLife` | MapExit `MapExit3` | -39,404,438 | `06_HongKong_MJ12lab#cathedral` | tag `change_floors`: Button1 Button8 |
| `06_HongKong_VersaLife` | MapExit `MapExit2` | -20,432,-138 | `06_HongKong_WanChai_Market#market` | tag `change_floors01`: Button1 Button12 |
| `06_HongKong_WanChai_Market` | MapExit `MapExit3` | -1086,-1171,22 | `06_HongKong_Helibase#HeliBase` | tag `change_floors`: Button1 Button1 |
| `06_HongKong_WanChai_Market` | MapExit `MapExit1` | 1967,-866,-137 | `06_HongKong_VersaLife#lobby` | tag `change_floors01`: Button1 Button4 |
| `06_HongKong_WanChai_Market` | MapExit `MapExit2` | 247,571,15 | `08_NYC_Street` (path `CameraPath`) | tag `outro_trigger`: Dispatcher Dispatcher1 |

**06_HongKong_Helibase MapExit0 -> 06_HongKong_WanChai_Market#cargoup** (tag `change_floors`)

```text
event change_floors
  Button1 Button3 (Event)
```

**06_HongKong_MJ12lab MapExit2 -> 06_HongKong_VersaLife#secret** (tag `change_floors01`)

```text
event change_floors01
  Button1 Button23 (Event)
```

**06_HongKong_MJ12lab MapExit0 -> 06_HongKong_Storage#basement** (tag `change_floors`)

```text
event change_floors
  Button1 Button44 (Event)
```

**06_HongKong_Storage MapExit0 -> 06_HongKong_MJ12lab#tubeend** (tag `change_floors`)

```text
event change_floors
  Button1 Button1 (Event)
```

**06_HongKong_VersaLife MapExit3 -> 06_HongKong_MJ12lab#cathedral** (tag `change_floors`)

```text
event change_floors
  Button1 Button8 (Event)
```

**06_HongKong_VersaLife MapExit2 -> 06_HongKong_WanChai_Market#market** (tag `change_floors01`)

```text
event change_floors01
  Button1 Button12 (Event)
```

**06_HongKong_WanChai_Market MapExit3 -> 06_HongKong_Helibase#HeliBase** (tag `change_floors`)

```text
event change_floors
  Button1 Button1 (Event)
```

**06_HongKong_WanChai_Market MapExit1 -> 06_HongKong_VersaLife#lobby** (tag `change_floors01`)

```text
event change_floors01
  Button1 Button4 (Event)
```

**06_HongKong_WanChai_Market MapExit2 -> 08_NYC_Street** (tag `outro_trigger`)

```text
event outro_trigger
  Dispatcher Dispatcher1 (OutEvents) tag jock_chopper
    event jock_chopper
      conversation event Trigger "Jock_Chopper" in M06JockExit
        conversation M06JockExit [talk bump/frob/radius 240; owner Jock]
          starts: its actor (bump/frob/radius 240)
          flag M08Briefing_Played (set when conversation M08Briefing ends): 
            conversation M08Briefing [talk bump/frob; owner TracerTong]
```

### 06.2 Mission script `Mission06`

`.cache/research/src/DeusEx/Mission06.uc`, 669 lines, one script for the ten maps, with a helper `TeleportPawn` and `FireMissilesAt`.

* `FirstFrame` (`:14-284`): VersaLife and the MJ12 lab: `M07Briefing_Played` -> the `MJ12Commando`s (and the lab's `SpiderBot`s, real keypad shown instead of the dummy) enter; Canal: `John_Smith_Body` unhidden if `HaveROM` (**the flag is spelled `Have_ROM` everywhere else; `HaveROM` has no setter**:
  the block can never run); Tong base: `Versalife_Done` -> Paul and the Red Arrow enter, `JaimeRecruited` and `Versalife_Done` -> Jaime enters (`:76-83`), `JacobsonRecruited` -> Alex enters (`:86-93`); Underworld: `QuickLetPlayerIn` -> commandos; `TriadCeremony_Played` -> `DragonHeadsInLuckyMoney` (expiration 8), carcasses destroyed;
  Garage: after `M07Briefing_Played` the cops, carcasses, van, wrecks and roadblocks are removed; Market: `Have_ROM`, `MeetTracerTong_Played` and not `TriadCeremony_Played` -> Quick and Chen teleported to the temple, the monk enters, the kid removed, `CeremonyReadyToBegin` (expiration 8);
  the tea-house, shopper, caterer and kid sequences (a dozen `*_Played` flags drive teleports of the `MarketKid`, `TeaHouseRedArrow`, `MarketShopperFlowers`); `M08Briefing_Played` -> the `BlackHelicopter` enters; `M07Briefing_Played` -> the `TempleBook` unhidden; the `MarketGoth` pawns are placed at random
  (`FRand`, three spots, `GothAtFlower/Butcher/Vase`, expiration 8).
* `PreTravel` (`:292-295`): `Super` only. No `SendPlayer`/`ClientTravel` in the script.
* `Timer` (`:303-620`): Street: `WaltonAppears` -> Walton enters, `M06WaltonHolo_Played` -> leaves; Underworld: `MaxChenConvinced` -> the `RaidingCommando`s enter, `Raid_Underway` with none left -> `M06AmbushDone`; `ReadyForMercedes2` sets a home base; Garage: `RumbleCops_Lost`, `RumbleRedArrow_Lost`,
  `RumbleLumPath_Lost` when the tagged groups are empty; Market: rats released, `MS_ConvoTrigger1..8` fire the wandering/patrol tags of the sequences, `QuickLetPlayerIn` moves the keypads; **Helibase** (`:521-593`): `helicopter_armed` -> `DL_Jock_02` (completes `DeactivateWeaponLock`);
  `helicopter_fire` -> `DL_Jock_Fired`, the `Blast_doors` become breakable and `FireMissilesAt('Blast_doors')` spawns two tracking `RocketLAW`s from the `chopper`; while the doors stand it fires again every 3 s; when none stand, `DL_Jock_03`, the `AlarmUnit`s and the `Go` dispatcher fire
  (`MS_DoorsBlown`) and the `DoorWreckage` becomes breakable; Storage: `ReadyToDestroyAUC` makes the pods and `AUC` breakable; Canal: `Overhear_Canal_Thug1_Played` fires `CanalDrugDealersAttack`.
* Flags it sets: all with expiration 8 (alive through mission 7, deleted on entering mission 8): none outlives the mission. The map FlagTriggers use expirations 7 and 8 as well (`Have_ROM`, `helicopter_armed`, ...).
* Actors it touches: `MJ12Commando`, `SpiderBot`, `Keypad1/3` (dummy vs real), `PaulDenton`, `JaimeReyes`, `AlexJacobson`, `GordonQuick`, `MaxChen`, `WaltonSimons`, `BlackHelicopter`, `RocketLAW`, `DeusExMover` by tag, `RatGenerator`, `AlarmUnit`, `Dispatcher Go`, `LowerClassFemale ClubTessa`, the market's tagged pawns.

Generated from the script's calls (`inventory-campaign.mjs scripts`; `:N` is the first line):

* **Flags set** (36; `eN` = explicit expiration N, otherwise the default): `DragonHeadsInLuckyMoney` e8 (:105), `MS_ChenTeleported` e8 (:122), `CeremonyReadyToBegin` e8 (:171), `ReadyForCaterer` e8 (:192), `MarketKidReadyForFifth` e8 (:218), `MarketKidReadyForFourth` e8 (:225), `MarketKidReadyForThird` e8 (:232), `MarketKidReadyForSecond` e8 (:239), `GothAtFlower` e8 (:264), `GothAtButcher` e8 (:265), `GothAtVase` e8 (:266), `MS_WaltonUnhidden` e8 (:331), `MS_WaltonHidden` e8 (:341), `MS_CommandosUnhidden` e8 (:352), `Raid_Underway` e8 (:364), `M06AmbushDone` e8 (:365), `MS_HomeBaseSet` e8 (:379), `RumbleCops_Lost` e8 (:392), `RumbleRedArrow_Lost` e8 (:403), `RumbleLumPath_Lost` e8 (:414), `MS_RatsReleased` e8 (:426), `MS_ConvoTrigger1` e8 (:436), `MS_ConvoTrigger2` e8 (:449), `MS_ConvoTrigger3` e8 (:459), `MS_ConvoTrigger4` e8 (:469), `MS_ConvoTrigger5` e8 (:477), `MS_ConvoTrigger6` e8 (:485), `MS_ConvoTrigger7` e8 (:493), `MS_ConvoTrigger8` e8 (:501), `MS_KeypadsMoved` e8 (:518), `MS_JockInfoLink` e8 (:528), `MS_RubbleBreakable` e8 (:538), `MS_DoorsBlown` e8 (:564), `MS_HelicopterFired` e8 (:591), `MS_ReadyAUC` e8 (:606), `MS_DrugDealersAttacking` e8 (:617).
* **Flags read** (55): `M07Briefing_Played`, `Supervisor01_Dead`, `HaveROM`, `Versalife_Done`, `JaimeRecruited`, `JacobsonRecruited`, `QuickLetPlayerIn`, `TriadCeremony_Played`, `DragonHeadsInLuckyMoney`, `MS_ChenTeleported`, `Have_ROM`, `MeetTracerTong_Played`, `MarketShopperOverheard_Played`, `CatererConvo_Played`, `TeaHouseDrama_Played`, `KidGetsMoney_Played`, `KidSetsFire_Played`, `M06_Fire_Set`, `KidAsksForHelp_Played`, `KidAsksForWork_Played`, `M08Briefing_Played`, `WaltonAppears`, `MS_WaltonUnhidden`, `M06WaltonHolo_Played`, `MS_WaltonHidden`, `MaxChenConvinced`, `MS_CommandosUnhidden`, `Raid_Underway`, `ReadyForMercedes2`, `MS_HomeBaseSet`, `RumbleCops_Lost`, `RumbleRedArrow_Lost`, `RumbleLumPath_Lost`, `MS_RatsReleased`, `MS_ConvoTrigger1`, `MS_ConvoTrigger2`, `FlowerShopperOverheard_Played`, `MS_ConvoTrigger3`, `MS_ConvoTrigger4`, `MS_ConvoTrigger5`, `KidStealsSomething_Played`, `MS_ConvoTrigger6`, `MS_ConvoTrigger7`, `MS_ConvoTrigger8`, `MS_KeypadsMoved`, `helicopter_armed`, `MS_JockInfoLink`, `MS_DoorsBlown`, `MS_RubbleBreakable`, `MS_HelicopterFired`, `helicopter_fire`, `ReadyToDestroyAUC`, `MS_ReadyAUC`, `Overhear_Canal_Thug1_Played`, `MS_DrugDealersAttacking`.
* **InfoLinks it starts**: `DL_Jock_02` (:527), `DL_Jock_03` (:554), `DL_Jock_Fired` (:582). **Conversations it starts by name**: none. **Goals it completes**: none.
* **Spawns**: `RocketLAW` (:640). **Destroy calls**: 14; **EnterWorld/LeaveWorld calls**: 14. **Travel calls**: none.

### 06.3 Conversations and InfoLinks

296 conversations of the list besides the shared barks: 27 InfoLinks, 65 talk-type, 204 overheard.
15 have choices, but almost all are shops and small talk (the Canal pilot's weapon mods `Meet_Canal_Pilot`, `MarketBumSelling`, the club's admission fees, `M06MeetJunkie`); none of the story steps is a branching choice. 53 set flags, 204 need a flag,
25 add or complete goals (20 goals below, one of them carried), 24 fire events.

**Choices.** Every choice that changes state, the block its speech jumps to and what that block does (choices that change no state are counted in one row per conversation):

| Conversation | Owner | Choice | Effects of the branch |
| --- | --- | --- | --- |
| `M06SupervisorConvos` | Supervisor01 | Sure. | -> Buy: set Supervisor_Paid |
| `M06SupervisorConvos` | Supervisor01 | (1 further choice that change no state: refusals, "never mind", unaffordable offers) | - |
| `MarketWaiterConvos` | MarketWaiter | Something to eat, please. [needs M06HaveEnoughMoney] | -> BuySoy: give SoyFood |
| `MarketWaiterConvos` | MarketWaiter | I'll take a soda. [needs M06HaveEnoughMoney] | -> BuySoda: give Sodacan |
| `MarketWaiterConvos` | MarketWaiter | What do you think of the Triads? [needs !M06WaiterQuestion1, !TriadCeremony_Played, KnowsAboutTriads] | -> Triads: set KnowsAboutNanoSword, set M06WaiterQuestion1 |
| `MarketWaiterConvos` | MarketWaiter | What do you know about Maggie Chow? [needs M06WaiterQuestion1, !M06WaiterQuestion2, KnowsAboutMaggie] | -> MaggieChow: set M06WaiterQuestion2 |
| `MarketWaiterConvos` | MarketWaiter | Think the truce will improve business? [needs TriadCeremony_Played, M06WaiterQuestion2, !M06WaiterQuestion3] | -> Truce: set M06WaiterQuestion3 |
| `MarketWaiterConvos` | MarketWaiter | Think the truce will improve business? [needs TriadCeremony_Played, !M06WaiterQuestion1] | -> Truce: set M06WaiterQuestion3 |
| `MarketWaiterConvos` | MarketWaiter | (2 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `MarketNewsWomanConvos2` | MarketNewsWoman | What do you think of the Triad situation? [needs !NewsB1] | -> Triads: set NewsB1 |
| `MarketNewsWomanConvos2` | MarketNewsWoman | So it was Maggie Chow who stole the sword. [needs !NewsB2] | -> MaggieChow: set NewsB2 |
| `MarketNewsWomanConvos2` | MarketNewsWoman | (1 further choice that change no state: refusals, "never mind", unaffordable offers) | - |
| `MarketNewsWomanConvos1` | MarketNewsWoman | What do you think of the Luminous Path Triad? [needs !NewsA1] | -> LuminousPath: set KnowsAboutNanoSword, set NewsA1 |
| `MarketNewsWomanConvos1` | MarketNewsWoman | What do you think of the Red Arrow Triad? [needs !NewsA2] | -> RedArrow: set NewsA2 |
| `MarketNewsWomanConvos1` | MarketNewsWoman | Have you heard of Maggie Chow? [needs !NewsA3, KnowsAboutMaggie] | -> MaggieChow: set NewsA3 |
| `MarketNewsWomanConvos1` | MarketNewsWoman | (1 further choice that change no state: refusals, "never mind", unaffordable offers) | - |
| `MarketBumSelling` | MarketBum1 | Give me the VersaLife blueprints for 2000. [needs M06CanAffordVersaLife, !M06BoughtVersaLife] | -> BuyVersaLife: set M06BoughtVersaLife, give Image06_HK_Market, give Image06_HK_MJ12Helipad, give Image06_HK_MJ12Lab, give Image06_HK_VersaLife |
| `MarketBumSelling` | MarketBum1 | I'll take the scrambler grenade for 1250. [needs !M06BoughtScrambler, M06CanAffordScrambler] | -> BuyScrambler: set M06BoughtScrambler, give WeaponNanoVirusGrenade |
| `MarketBumSelling` | MarketBum1 | 4,000 for thermoptic camo -- deal. [needs !M06BoughtArmor, M06CanAffordArmor] | -> BuyArmor: set M06BoughtArmor, give AdaptiveArmor |
| `MarketBumSelling` | MarketBum1 | (4 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `MamasanConvos` | Mamasan | Sure. [needs !M06JCHasDate, !M06DateDone] | -> BuyGirl: set M06JCHasDate |
| `MamasanConvos` | Mamasan | Where can I find Max Chen? [needs KnowsAboutMaxChen, !MeetMaxChen_Played, !MamasanMaxComment] | -> MamaMax: set MamasanMaxComment |
| `MamasanConvos` | Mamasan | (3 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `M06MeetJunkie` | M06Junkie | A forgotten virtue like honesty is worth at least twenty credits. | -> Pay: set M06PaidJunkie |
| `M06MeetJunkie` | M06Junkie | (1 further choice that change no state: refusals, "never mind", unaffordable offers) | - |
| `ClubMercedesConvo2` | ClubMercedes | Sorry. You'll have to fend for yourself. | -> NoPay: set ReadyForMercedes3 |
| `ClubMercedesConvo2` | ClubMercedes | (1 further choice that change no state: refusals, "never mind", unaffordable offers) | - |
| `ClubMercedesConvo1` | ClubMercedes | Sure. | -> Pay: set ClubMercedesConvo1_Done, trig JC_Paid_Admission01, trig JC_Paid_Admission02 |
| `ClubMercedesConvo1` | ClubMercedes | (1 further choice that change no state: refusals, "never mind", unaffordable offers) | - |
| `ClubDoorGirlConvos` | ClubDoorGirl | Here you go. | -> Pay: set PaidForLuckyMoney |
| `ClubDoorGirlConvos` | ClubDoorGirl | (1 further choice that change no state: refusals, "never mind", unaffordable offers) | - |
| `BouncerPissed` | ClubBouncer | On second thought, maybe I'll go somewhere else. | -> Refuse: set BouncerAttacking |
| `BouncerPissed` | ClubBouncer | (1 further choice that change no state: refusals, "never mind", unaffordable offers) | - |
| `ClubBartenderConvos` | ClubBartender | Can I ask you something? [needs !M06BartenderQuestion1] | -> One: set M06BartenderQuestion1 |
| `ClubBartenderConvos` | ClubBartender | You said "outside influences." What does China fear? [needs M06BartenderQuestion1, !M06BartenderQuestion2] | -> Two: set M06BartenderQuestion2 |
| `ClubBartenderConvos` | ClubBartender | The separation of powers acknowledges the petty ambitions of individua [needs M06BartenderQuestion2, !M06BartenderQuestion3] | -> Three: set M06BartenderQuestion3 |
| `ClubBartenderConvos` | ClubBartender | I'm looking for Max Chen. [needs KnowsAboutMaxChen, !MeetMaxChen_Played, !ClubBartenderMaxQuestion] | -> Max: set ClubBartenderMaxQuestion |
| `ClubBartenderConvos` | ClubBartender | Gimme a forty. [needs M06HaveEnoughMoney] | -> BuyLiquor: give Liquor40oz |
| `ClubBartenderConvos` | ClubBartender | Wine, please. [needs M06HaveEnoughMoneyWine] | -> BuyWine: give WineBottle |
| `ClubBartenderConvos` | ClubBartender | (6 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `Meet_Canal_Pilot` | Canal_Pilot | I'll take the accuracy mod for 750. [needs M06CanAffordAccuracy, !M06BoughtAccuracy] | -> BuyAccuracy: set M06BoughtAccuracy, give WeaponModAccuracy |
| `Meet_Canal_Pilot` | Canal_Pilot | 600 for a reload mod -- deal. [needs !M06BoughtReload, M06CanAffordReload] | -> BuyReload: set M06BoughtReload, give WeaponModReload |
| `Meet_Canal_Pilot` | Canal_Pilot | Here's 400 for the recoil mod. [needs !M06BoughtRecoil, M06CanAffordRecoil] | -> BuyRecoil: set M06BoughtRecoil, give WeaponModRecoil |
| `Meet_Canal_Pilot` | Canal_Pilot | (4 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `Canal_Bartender_Convos` | Canal_Bartender | Something to drink. [needs M06HaveEnoughMoney] | -> BuyDrink: give Liquor40oz |
| `Canal_Bartender_Convos` | Canal_Bartender | Whatever you've got to eat. [needs M06HaveEnoughMoney, !KnowsAboutMaggie] | -> BuyFood: give SoyFood |
| `Canal_Bartender_Convos` | Canal_Bartender | Whatever you've got to eat. [needs KnowsAboutMaggie, CanalBarSaidMaggie] | -> BuyFood: give SoyFood |
| `Canal_Bartender_Convos` | Canal_Bartender | Heard the name Tracer Tong? [needs !Canal_Bartender_Question1] | -> Tong: set KnowsTongPathConnection, set Canal_Bartender_Question1, set KnowsAboutTriads |
| `Canal_Bartender_Convos` | Canal_Bartender | Is there a lot of crime in Hong Kong? [needs Canal_Bartender_Question1, !Canal_Bartender_Question2] | -> Canals: set Canal_Bartender_Question2 |
| `Canal_Bartender_Convos` | Canal_Bartender | What sort of biotech smuggling goes on? [needs Canal_Bartender_Question2, !Canal_Bartender_Question3] | -> Biotech: set Canal_Bartender_Question3 |
| `Canal_Bartender_Convos` | Canal_Bartender | The Second Men? [needs Canal_Bartender_Question3, !Canal_Bartender_Question4] | -> Olaf: set Canal_Bartender_Question4 |
| `Canal_Bartender_Convos` | Canal_Bartender | Do you know of a Maggie Chow? [needs KnowsAboutMaggie, !CanalBarSaidMaggie] | -> Maggie: set CanalBarSaidMaggie |
| `Canal_Bartender_Convos` | Canal_Bartender | (1 further choice that change no state: refusals, "never mind", unaffordable offers) | - |
| `BarSuitMeet` | BarSuit | Great place here! [needs !SuitGeneralInfo] | -> GeneralInfo: set SuitGeneralInfo |
| `BarSuitMeet` | BarSuit | Do you know a man named Max Chen? [needs KnowsAboutMaxChen, !SuitToldMax, !MeetMaxChen_Played] | -> MaxInfo: set SuitToldMax |
| `BarSuitMeet` | BarSuit | (1 further choice that change no state: refusals, "never mind", unaffordable offers) | - |

**Conversations that change state** (choices, flags set, goals, items, events, skill points; the `Needs` column is kept on these rows):

| Conversation | Owner (BindName; maps with that actor) | Kind | Choices | Sets | Needs | Goals | Other |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `DL_TongFixesKillswitch2` | JCDenton | DL once |  | KillswitchFixed |  | done RestoreAugmentations |  |
| `DL_Tong_07` | JCDenton | DL once |  |  | req !M07Briefing_Played, req Have_ROM | done GetROM, +P UniteTriads |  |
| `DL_Tong_05` | JCDenton | DL once |  |  | req VL_Got_Schematic | done EscapeVersaLife, +P ReportToTong2 |  |
| `DL_Tong_04` | JCDenton | DL once |  | VL_Got_Schematic, Versalife_Done@Done | req M07Briefing_Played, ? VL_Got_Schematic, ? VL_UC_Destroyed | done GetVirusSchematic |  |
| `DL_Tong_00B` | JCDenton | DL once |  |  |  | +P GetSword |  |
| `DL_Tong_00` | JCDenton | DL once |  | Have_Evidence, NoticedMJ12ChowConnection |  | done InvestigateMaggieChow, done GetSword, +P ConvinceRedArrow |  |
| `DL_Jock_05` | JCDenton | DL once |  |  |  | +P FindTracerTong, +P CheckCompound, +note |  |
| `DL_Jock_02` | JCDenton | DL once |  |  |  | done DeactivateWeaponLock |  |
| `DL_Jock_01` | JCDenton | DL once |  |  |  | +P DeactivateWeaponLock |  |
| `DL_Daedalus_05` | JCDenton | DL once |  | VL_UC_Destroyed, Versalife_Done@Done | req M07Briefing_Played, ? VL_Got_Schematic, ? VL_UC_Destroyed | done DestroyUniversalConstructor, +P EscapeVersaLife |  |
| `DL_Daedalus_04` | JCDenton | DL once |  |  | req M07Briefing_Played | +P DestroyUniversalConstructor, +note |  |
| `DL_Daedalus_01` | JCDenton | DL once |  |  |  | +P FindTracerTong |  |
| `M06WaltonHolo` | WaltonSimons (HongKong_WanChai_Street) | ovh bump/frob/radius 80 |  | SimonsConvoPlaying=0 |  |  |  |
| `MeetTracerTong2` | TracerTong (HongKong_TongBase) | talk radius 90 once |  | KnowsAboutHundley@resume | req KillswitchFixed, ? PaulDenton_Dead | +P GetROM, +note | trig TracerWanders |
| `MeetTracerTong` | TracerTong (HongKong_TongBase) | talk radius 90 once |  |  | ? PaulDenton_Dead | done FindTracerTong, done CheckCompound, +P RestoreAugmentations | trig To_Operating_Room |
| `M08Briefing` | TracerTong (HongKong_TongBase) | talk bump/frob once |  |  | req Versalife_Done, ? AlexDaedalusClue | done ReportToTong2, +P LeaveHongKong |  |
| `M07Briefing` | TracerTong (HongKong_TongBase) | talk bump/frob once |  |  | req TriadCeremony_Played, ? FoundScientistBody | done ReportToTong, +P GetVirusSchematic, +note |  |
| `M06TongBarks2` | TracerTong (HongKong_TongBase) | ovh bump/frob |  |  | req MeetTracerTong2_Played, req !TriadCeremony_Played, req Have_ROM | +P UniteTriads |  |
| `TeaHouseCustomerBarks` | TeaHouseCustomer (HongKong_WanChai_Market) | ovh bump/frob |  | TeaHouseCustomerRatComment@RatComment | ? TeaHouseDrama_Played, ? !TeaHouseCustomerRatComment |  | trig TeaHouseWomanLeaves |
| `Table_DancerBarks` | Table_Dancer (HongKong_WanChai_Underworld) | ovh bump/frob/radius 200 |  | Table_Dancer_Got_Mad@Mad | ? Table_Dancer_Got_Mad, ? M06AmbushDone, ? Raid_Underway, ? !TableDancerPresent |  |  |
| `M06SupervisorConvos` | Supervisor01 (HongKong_VersaLife) | talk bump/frob | 2 | Supervisor_Paid@Buy | req !Supervisor_Paid, ? M06SupervisorConvos_Played | +note | cr -2000 |
| `MeetRed_Arrow_01_2` | Red_Arrow_01 (HongKong_WanChai_Market) | talk bump/frob once |  |  | req MeetRed_Arrow_01_Played |  | trig BackToBase |
| `MeetRed_Arrow_01` | Red_Arrow_01 (HongKong_WanChai_Market) | talk bump/frob/radius 40 once |  |  | ? PaulDenton_Dead | +P VisitMaggieChow | trig BackToBase |
| `M06MeetReceptionist` | Receptionist (HongKong_VersaLife) | talk bump/frob/radius 160 once |  | DirectedToHundley |  |  |  |
| `ClubTriadBackroomMeet` | OfficeRedArrow (HongKong_WanChai_Underworld) | talk bump/frob/radius 180 once |  | KnowsAboutMaxChen | req !MaxChenConvinced, req !Raid_Underway, ? KnowsAboutMaxChen |  |  |
| `Meet_MJ12Lab_Supervisor` | MJ12Lab_Supervisor (HongKong_MJ12lab) | talk radius 100 once |  |  |  |  | trig Harrison_Wandering |
| `MJ12Lab_BioWeapons_Overheard` | MJ12Lab_BioWeapons (HongKong_MJ12lab) | ovh radius 160 once |  |  |  |  | trig BioWeapons_Wander |
| `MeetMaySung` | MaySung (HongKong_WanChai_Street) | talk bump/frob/radius 120 once |  | MaySungBlue, MaySungYellow=0, MaySungRed=0 | req !MaggieChow_Dead, req !MeetMaggie_Played, req !BeenToCops, ? !KnowsAboutMaggie |  | trig Introduce_JC |
| `MaySungWhupass` | MaySung (HongKong_WanChai_Street) | talk bump/frob/radius 120 once |  |  | req BeenToCops |  | trig MaySungWhupass |
| `MaySungBarks` | MaySung (HongKong_WanChai_Street) | ovh bump/frob/radius 200 |  | MaySungGotTesty@Yellow, MaySungGotTesty@Red | req MeetMaySung_Played, req !BeenToCops, ? MaySungRed, ? MaySungYellow, ? BeenToCops, ? MaySungGotTesty |  |  |
| `MeetMaxChen` | MaxChen (HongKong_WanChai_Market, HongKong_WanChai_Underworld) | talk bump/frob/radius 190 once |  | KnowsAboutTriads, KnowsTongPathConnection@FirstMeeting, MaxPissed@FirstMeeting, MadeChenAccusation@FoundEvidence, MaxChenConvinced@GordoSkip, Raid_Underway@GordoSkip, MaxChenConvinced@NoHand, Raid_Underway@NoHand (+3 more) | ? Gate_Guard2_Played, ? Have_Evidence, ? BeenToCops, ? MeetMaggie_Played, ? !KnowsAboutNanoSword, ? RightHandMan_Dead | done ConvinceRedArrow, +P DeliverChensResponse | has? WeaponNanoSword |
| `M07ChenSecondGive` | MaxChen (HongKong_WanChai_Market, HongKong_WanChai_Underworld) | talk bump/frob once |  | M07ChenIdle | req M07GordonSecondGive_Played |  | give WineBottle |
| `M07ChenFirstGive` | MaxChen (HongKong_WanChai_Market, HongKong_WanChai_Underworld) | talk bump/frob once |  | M07ChenIdle, M07GordonIdle=0 | req M07GordonFirstGive_Played |  | give WineBottle |
| `MarketWaiterConvos` | MarketWaiter (HongKong_WanChai_Market) | talk bump/frob | 8 | M06HaveEnoughMoney=0@Choices, KnowsAboutNanoSword@TriadContinue, M06WaiterQuestion1@TriadContinue, M06WaiterQuestion2@MaggieChow, M06WaiterQuestion3@Truce, M06HaveEnoughMoney@EnoughMoney, M06WaiterQuestion1@SkipQuestions (+1 more) | ? Have_Evidence, ? KnowsAboutNanoSword |  | give SoyFood, give Sodacan, cr -24 |
| `FlowerShopperOverheard` | MarketShopperFlowers (HongKong_WanChai_Market) | ovh radius 200 once |  |  |  |  | trig MarketShopperFlowersWanders |
| `MarketNewsWomanConvos2` | MarketNewsWoman (HongKong_WanChai_Market) | talk bump/frob | 3 | NewsB1@Triads, NewsB2@MaggieChow, NewsB2@MaggieDead, NewsBDone@Done | req TriadCeremony_Played, req !NewsBDone, ? MarketNewsWomanConvos1_Played, ? MaggieChow_Dead, ? NewsB1, ? NewsB2 |  |  |
| `MarketNewsWomanConvos1` | MarketNewsWoman (HongKong_WanChai_Market) | talk bump/frob | 4 | KnowsAboutTriads@A1, KnowsAboutMaggie@A3, KnowsAboutNanoSword@LuminousPath, NewsA1@LuminousPath, NewsA1@KnowsSword, NewsA2@RedArrow, NewsA3@MaggieChow, NewsADone@Done | req !TriadCeremony_Played, req !NewsADone, ? KnowsAboutNanoSword, ? NewsA1, ? NewsA2, ? NewsA3 |  |  |
| `KidStealsSomething` | MarketKid (HongKong_WanChai_Market) | ovh radius 350 once |  | M06_Fire_Set | req MarketKidReadyForThird |  | trig KidGoesToLumPath |
| `KidSetsFire` | MarketKid (HongKong_WanChai_Market) | ovh radius 260 once |  |  | req MarketKidReadyForFourth |  | trig KidGoesToNewsStand |
| `KidGetsMoney` | MarketKid (HongKong_WanChai_Market) | ovh radius 260 once |  |  | req MarketKidReadyForFifth |  | trig KidWanders |
| `KidAsksForWork` | MarketKid (HongKong_WanChai_Market) | ovh radius 260 once |  |  | req !MarketKidReadyForSecond |  | trig KidGoesToLumPath |
| `KidAsksForHelp` | MarketKid (HongKong_WanChai_Market) | ovh radius 260 once |  |  | req MarketKidReadyForSecond |  | trig KidGoesToNewsStand |
| `GothAtFlower` | MarketGoth (HongKong_WanChai_Market) | ovh radius 200 |  | GothAtButcher=0@G1, GothAtFlower=0@G1, GothAtVase=0@G1, GothAtButcher=0@G2, GothAtFlower=0@G2, GothAtVase=0@G2, GothAtButcher=0@G3, GothAtFlower=0@G3, GothAtVase=0@G3 | req GothAtFlower, ? GothAtFlower, ? GothAtButcher, ? GothAtVase |  | trig GothGoesToFlower, trig GothGoesToButcher, trig GothGoesToVase |
| `MarketButcherBarks` | MarketButcher (HongKong_WanChai_Market) | ovh bump/frob/radius 160 |  |  |  | +note |  |
| `MarketBumSelling` | MarketBum1 (HongKong_WanChai_Canal) | talk bump/frob | 7 | M06CanAffordVersaLife=0@StartChoices, M06CanAffordScrambler=0@StartChoices, M06CanAffordArmor=0@StartChoices, MarketBumDoneSelling@Done, M06BoughtVersaLife@BuyVersaLife, M06BoughtScrambler@BuyScrambler (+4 more) | req MarketBumStartedSelling, req !MarketBumDoneSelling, ? MarketBumSelling_Played, ? M06BoughtVersaLife, ? M06BoughtScrambler, ? M06BoughtArmor |  | give Image06_HK_Market, give Image06_HK_MJ12Helipad, give Image06_HK_MJ12Lab, give Image06_HK_VersaLife, give WeaponNanoVirusGrenade, give AdaptiveArmor, cr -7250 |
| `MarketBum1Barks` | MarketBum1 (HongKong_WanChai_Canal) | ovh bump/frob |  | MarketBumStartedSelling@A2 | req MeetMarketBum1_Played, req !MarketBumStartedSelling |  |  |
| `MamasanConvos` | Mamasan (HongKong_WanChai_Underworld) | talk bump/frob | 5 | M06HaveEnoughMoney=0@A3, M06JCHasDate@BuyGirl, M06HaveEnoughMoney@EnoughMoney, MamasanMaxComment@MamaMax, MamasanDone@AllDone | req !Raid_Underway, req !MamasanDone, req !M06AmbushDone, req !Date1_Dead, ? MamasanMaxComment, ? MeetMaxChen_Played, ? M06JCHasDate |  | cr -100 |
| `MeetMaggie` | MaggieChow (HongKong_MJ12lab, HongKong_Storage, HongKong_WanChai_Street) | talk bump/frob/radius 120 once |  | KnowsAboutMaggie, KnowsAboutTriads, FoundMaggieChow, KnowsAboutNanoSword@Sly, KnowsAboutMaxChen@MaxInfo | req !M07Briefing_Played, req !MaggieFled, ? !MaySungInLivingRoom, ? MaySung_Dead, ? !Gate_Guard2_Played, ? KnowsAboutNanoSword, ? Gate_Guard2_Played, ? PaulDenton_Dead | done VisitMaggieChow, +S InvestigatePolice, +note | trig MaggieWanders |
| `MaggieChowShowdown` | MaggieChow (HongKong_MJ12lab, HongKong_Storage, HongKong_WanChai_Street) | talk radius 160 once |  |  | req M07Briefing_Played, ? !MeetMaggie_Played, ? !BeenToCops |  | trig MaggieAttacks |
| `BobMaggieOverheard` | MaggieChow (HongKong_MJ12lab, HongKong_Storage, HongKong_WanChai_Street) | ovh once |  |  |  |  | trig MaggieLeaves, trig BobLeaves |
| `M06MeetJunkie` | M06Junkie (HongKong_WanChai_Street) | talk bump/frob/radius 60 once | 2 | M06PaidJunkie@Pay |  |  | cr -20 |
| `Meet_Lumpath_Street_Guard` | Lumpath_Street_Guard (HongKong_VersaLife, HongKong_WanChai_Street) | talk radius 120 once |  | Lumpath_Street_Guard_Happy@KnowsGordo | req !MaxChenConvinced, ? Gate_Guard2_Played |  | trig Lumpath_Street_Guard_Wanders |
| `Lumpath_Street_GuardBarks` | Lumpath_Street_Guard (HongKong_VersaLife, HongKong_WanChai_Street) | ovh bump/frob |  | KnowsAboutMaxChen@B1 | req Meet_Lumpath_Street_Guard_Played, req !MaxChenConvinced, ? Lumpath_Street_Guard_Happy |  |  |
| `JockBarksLumPath` | JockInHelicopter (HongKong_Helibase) | ovh bump/frob/radius 200 |  |  | req M08Briefing_Played | done LeaveHongKong |  |
| `M06JockExit` | Jock (HongKong_WanChai_Market) | talk bump/frob/radius 240 once |  |  | req M08Briefing_Played | done LeaveHongKong | trig Jock_Chopper |
| `M07MeetJaime` | JaimeReyes (HongKong_TongBase) | talk bump/frob |  | M06JaimeDone@Transfer | req !M06JaimeDone, ? M07MeetJaime_Played |  | give AugmentationUpgradeCannister |
| `TriadCeremony` | GordonQuick (HongKong_WanChai_Market, HongKong_WanChai_Underworld) | talk bump/frob/radius 160 once |  |  | req Have_ROM, req MeetTracerTong_Played | done UniteTriads, +P ReportToTong, +S HaveDrinksWithDragonHeads | trig QuickLeaves, trig ChenLeaves, sp 150 |
| `QuickFinalTalk` | GordonQuick (HongKong_WanChai_Market, HongKong_WanChai_Underworld) | talk bump/frob once |  | QuickLetPlayerIn | req !QuickLetPlayerIn, req MaxChenConvinced, req QuickConvinced |  |  |
| `M07GordonSecondGive` | GordonQuick (HongKong_WanChai_Market, HongKong_WanChai_Underworld) | talk bump/frob once |  | M07GordonIdle, M07ChenIdle=0 | req M07ChenFirstGive_Played |  | give WineBottle |
| `M07GordonFirstGive` | GordonQuick (HongKong_WanChai_Market, HongKong_WanChai_Underworld) | talk bump/frob/radius 100 once |  | M07GordonIdle, M07ChenIdle=0 | req DragonHeadsInLuckyMoney | done HaveDrinksWithDragonHeads | give WineBottle |
| `Gate_Guard2` | GordonQuick (HongKong_WanChai_Market, HongKong_WanChai_Underworld) | talk bump/frob once |  | KnowsAboutMaggie@resume, KnowsAboutNanoSword@resume, KnowsAboutTriads@resume, QuickMaggieComment@MetMaggie, QuickConvinced@Evidence, ToldQuickAboutMJ12@ResumeEvidence, KnowsAboutMaxChen@ResumeEvidence (+2 more) | ? PaulDenton_Dead, ? Have_Evidence, ? BeenToCops, ? MeetMaggie_Played, ? MaxChenConvinced | done CheckCompound, +P InvestigateMaggieChow, done ConvinceLuminousPath, done InvestigatePolice, +P ConvinceRedArrow, +P DeliverChensResponse, done DeliverChensResponse, +note |  |
| `ConvinceQuick` | GordonQuick (HongKong_WanChai_Market, HongKong_WanChai_Underworld) | talk bump/frob once |  | QuickConvinced | req Have_Evidence, req !QuickConvinced, req Gate_Guard2_Played |  |  |
| `DrinkingWomanOverheard` | DrinkingWoman (HongKong_WanChai_Underworld) | ovh radius 200 once |  | DrinkingWomanHeard | req !Raid_Underway, req !M06AmbushDone |  |  |
| `Disgruntled_Guy_Convos` | Disgruntled_Guy (HongKong_VersaLife) | talk bump/frob |  | BarneyGaveAccess@GiveAccess, Disgruntled_Guy_Done@GiveAccess, Disgruntled_Guy_Done@End1, Disgruntled_Guy_Done@NoKill, DG_Nix_Comment@Supervisor2 | req !VL_Found_Labs, req !Disgruntled_Guy_Done, ? DG_Nix_Comment, ? !Supervisor01_Dead, ? Supervisor01_Dead, ? !Disgruntled_Guy_Convos_Played, ? Supervisor_Paid | +note |  |
| `Date1Barks` | Date1 (HongKong_WanChai_Underworld) | ovh bump/frob/radius 350 |  | M06DateDone@Red | ? Raid_Underway, ? M06DateDone, ? M06DateRed, ? M06DateYellow, ? M06JCHasDate |  | trig Date1Returns |
| `DataEntry_WanderBarks` | DataEntry_Wander (HongKong_VersaLife) | ovh bump/frob |  | M06HeardAboutShipment@A1, DataEntry_Wander_Done@A8 | req MeetDataEntry_Wander_Played, ? DataEntry_Wander_Done |  |  |
| `DataEntry_BreakBarks` | DataEntry_Break (HongKong_VersaLife) | ovh bump/frob |  | DataEntry_Break_Done@A11 | ? DataEntry_Break_Done |  |  |
| `ClubMercedesConvo2` | ClubMercedes (HongKong_WanChai_Underworld) | talk bump/frob | 2 | KnowsAboutMaxChen, ReadyForMercedes3@NoPay, ReadyForMercedes3@Broke | req ReadyForMercedes2, req !ReadyForMercedes3, req !Raid_Underway, ? ClubMercedesConvo2_Played |  | cr -10 |
| `ClubMercedesConvo1` | ClubMercedes (HongKong_WanChai_Underworld) | talk bump/frob/radius 120 | 2 | ClubMercedesConvo1_Done@Pay | req !ClubMercedesConvo1_Done, req !Raid_Underway, req !ReadyForMercedes2, ? ClubMercedesConvo1_Played |  | trig JC_Paid_Admission01, trig JC_Paid_Admission02, cr -40 |
| `ClubDoorGirlConvos` | ClubDoorGirl (HongKong_WanChai_Underworld) | talk bump/frob/radius 80 | 2 | PaidForLuckyMoney@Pay | req !PaidForLuckyMoney, req !Raid_Underway |  | cr -25 |
| `BouncerPissed` | ClubBouncer (HongKong_WanChai_Underworld) | talk bump/frob | 2 | BouncerComing=0, BouncerAttacking@Refuse, BouncerAttacking@Broke | req !PaidForLuckyMoney, req BouncerComing, req !Raid_Underway |  | cr -30 |
| `ClubBartenderConvos` | ClubBartender (HongKong_WanChai_Underworld) | talk bump/frob/radius 100 | 12 | M06HaveEnoughMoney=0@continue, M06HaveEnoughMoneyWine=0@continue, M06BartenderQuestion1@One, M06BartenderQuestion2@Two, M06BartenderQuestion3@Three, M06HaveEnoughMoney@EnoughMoney, M06HaveEnoughMoneyWine@EnoughMoneyWine (+1 more) | req !Raid_Underway |  | give Liquor40oz, give WineBottle, cr -135 |
| `Meet_Canal_Pilot` | Canal_Pilot (HongKong_WanChai_Canal) | talk bump/frob | 7 | M06CanAffordAccuracy=0@StartChoice, M06CanAffordRecoil=0@StartChoice, M06CanAffordReload=0@StartChoice, Canal_Pilot_Done@Done, M06BoughtAccuracy@BuyAccuracy, M06BoughtReload@BuyReload, M06BoughtRecoil@BuyRecoil (+3 more) | req !Canal_Pilot_Done, ? Meet_Canal_Pilot_Played, ? M06BoughtAccuracy, ? M06BoughtRecoil, ? M06BoughtReload | +note | give WeaponModAccuracy, give WeaponModReload, give WeaponModRecoil, cr -1750 |
| `Meet_Canal_Merchant2C` | Canal_Merchant (HongKong_WanChai_Canal) | talk bump/frob once |  | Meet_Canal_Merchant2_Played | req Meet_Canal_Merchant_Played, req Versalife_Done, req !Meet_Canal_Merchant2_Played, req !CanalMerchantLostComment |  |  |
| `Meet_Canal_Merchant2B` | Canal_Merchant (HongKong_WanChai_Canal) | talk bump/frob once |  | Meet_Canal_Merchant2_Played | req Meet_Canal_Merchant_Played, req Versalife_Done, req !Meet_Canal_Merchant2_Played, req CanalMerchantLostComment |  |  |
| `Meet_Canal_Merchant` | Canal_Merchant (HongKong_WanChai_Canal) | talk bump/frob once |  | CanalMerchantLostComment@VersaLifeDone | ? Versalife_Done |  |  |
| `Canal_Bartender_Convos` | Canal_Bartender (HongKong_WanChai_Canal) | talk bump/frob/radius 120 | 9 | M06HaveEnoughMoney=0@Choices, KnowsTongPathConnection@Tong, Canal_Bartender_Question1@Tong, KnowsAboutTriads@Tong, Canal_Bartender_Question2@Canals, Canal_Bartender_Question3@Biotech, Canal_Bartender_Question4@Olaf (+3 more) | ? !Canal_Bartender_Question1, ? QuickLetPlayerIn |  | give SoyFood, give Liquor40oz, cr -16 |
| `Base_Guard_InitialBarks` | Base_Guard (HongKong_TongBase) | ovh bump/frob |  | Base_Guard_InitialBarks_Played@FirstMeeting | req !TriadCeremony_Played, ? !Base_Guard_InitialBarks_Played |  |  |
| `M06MeetBarThug2` | BarThug (HongKong_WanChai_Underworld) | talk bump/frob once |  | M06MeetBarThug_Played | req M06AmbushDone, req !M06MeetBarThug_Played |  |  |
| `M06MeetBarThug` | BarThug (HongKong_WanChai_Underworld) | talk bump/frob once |  |  | req !MaxChenConvinced | +note |  |
| `BarSuitMeet` | BarSuit (HongKong_WanChai_Underworld) | talk bump/frob | 3 | SuitGeneralInfo@GeneralInfo, SuitToldMax@MaxInfo, SuitWordComment@Stalling, SuitDone@AllDone | req !Raid_Underway, req !SuitDone, ? SuitGeneralInfo, ? !KnowsAboutMaxChen, ? MeetMaxChen_Played, ? SuitToldMax, ? !SuitWordComment | +note |  |
| `M06MeetAlexJacobson` | AlexJacobson (HongKong_TongBase) | talk bump/frob once |  | AlexDaedalusClue@daedalus | ? Versalife_Done, ? JaimeRecruited, ? M07MeetJaime_Played |  |  |

Conversations that only wait for a flag or check one, and change no state (165; `?` = a `CheckFlag` event): `DL_Tong_08` (!M07Briefing_Played, !Have_ROM), `DL_Tong_06` (VL_Got_Schematic), `DL_Tong_03` (M07Briefing_Played), `DL_Tong_02` (M07Briefing_Played), `DL_Tong_01` (M07Briefing_Played), `DL_Daedalus_07` (M07Briefing_Played, VL_Got_Schematic, !VL_UC_Destroyed), `DL_Daedalus_06` (M07Briefing_Played), `DL_Daedalus_03` (M07Briefing_Played, !VL_UC_Destroyed), `DL_Daedalus_02` (!MeetTracerTong_Played), `TrooperBarks` (!M06TroopersDefeated), `M08ReadyBarks` (M08Briefing2_Played), `M08Briefing2` (M08Briefing_Played, ? AlexDaedalusClue), `M07TongBarks` (M07Briefing_Played, !Versalife_Done (+1 more)), `M06TongBarks0` (MeetTracerTong_Played (+1 more)), `M06TongBarks` (MeetTracerTong2_Played, !Have_ROM (+1 more)), `TeaHouseWomanBarks` (? TeaHouseCustomerRatComment), `RatReaction` (TeaHouseDrama_Played), `TeaHouseRedArrowWalkingBarks` (TeaHouseDrama_Played (+1 more)), `TeaHouseRedArrowBarks` (CatererConvo_Played), `CatererConvo` (ReadyForCaterer), `SupervisorPaidBarks` (Supervisor_Paid, ? Have_ROM), `Street_Bum2Barks2` (Meet_Street_Bum2_Played (+1 more)), `Street_Bum2Barks` (Have_Evidence), `Meet_Street_Bum2` (!Have_Evidence), `RightHandManBarks` (? MeetMaxChen_Played), `Red_Arrow_Street_GuardBarks3` (Have_Evidence), `Red_Arrow_Street_GuardBarks2` (MeetMaggie_Played), `Red_Arrow_Street_GuardBarks` (Meet_Red_Arrow_Street_Guard_Played (+1 more)), `Meet_Red_Arrow_Street_Guard` (!MeetMaggie_Played, !Have_Evidence, ? KnowsAboutMaggie), `Red_Arrow_01Barks` (!Have_Evidence (+1 more)), `ReceptionistBarks` (M06MeetReceptionist_Played), `M07PaulBarks` (M07MeetPaul_Played), `M07MeetPaul` (? M08Briefing_Played), `OfficeRedArrowHeadBarks` (? M06AmbushDone), `ClubTriadBackroomHappyBarks` (ClubTriadBackroomMeet_Played (+2 more)), `ClubTriadBackroomBarksFrob` (ClubTriadBackroomMeet_Played (+3 more)), `ClubTriadBackroomBarks` (ClubTriadBackroomMeet_Played (+3 more)), `ClubTriadBackroomAmbushBarks` (Raid_Underway), `MJ12Lab_SupervisorBarks` (Meet_MJ12Lab_Supervisor_Played), `MJ12Lab_Physics_Overheard2` (MJ12Lab_Physics_Overheard_Played), `MJ12Lab_Genetics_Overheard2` (MJ12Lab_Genetics_Overheard_Played), `MJ12Lab_DoctorBarks` (? Labrat_Released, ? Labrat_Bum_Dead), `BioAssistBarks` (MJ12Lab_BioWeapons_Overheard_Played), `MaySungStranger2` (!MeetMaySung_Played (+3 more)), `MaySungStranger` (!MeetMaySung_Played, MaggieChow_Dead (+1 more)), `Show_Chen` (Have_Evidence, !MaxChenConvinced, MeetMaxChen_Played), `RightHandHack` (AlwaysFalse), `MaxChenPissedBarks` (MaxPissed, !Have_Evidence (+1 more)), `MaxChenBarBarks` (M07ChenIdle), `M06ChenFinalBarks` (TriadCeremony_Played (+2 more)), `ChenWaiting` (MeetMaxChen_Played, !Have_Evidence (+1 more)), `ChenBeforeCeremony` (QuickLetPlayerIn (+3 more)), `ChenAmbushDone` (M06AmbushDone, !QuickLetPlayerIn), `ChenAmbushBarks` (Raid_Underway), `FlowerShopperBarks` (FlowerShopperOverheard_Played), `MarketNewsWomanBarks2` (TriadCeremony_Played, NewsBDone), `MarketNewsWomanBarks1` (!TriadCeremony_Played, NewsADone), `MarketMonk1FinalBarks` (TriadCeremony_Played), `MarketMonk1Barks` (!TriadCeremony_Played), `MarketLum2Barks` (? !QuickLetPlayerIn (+2 more)), `MarketLum1Barks` (QuickLetPlayerIn (+3 more)), `KidWalking5` (KidGetsMoney_Played), `KidWalking4` (KidSetsFire_Played (+1 more)), `KidWalking3` (KidStealsSomething_Played (+1 more)), `KidWalking2` (KidAsksForHelp_Played (+1 more)), `KidWalking` (KidAsksForWork_Played (+1 more)), `MarketHKMilitaryBarks` (? Have_ROM), `GothAtVase` (GothAtVase), `GothAtButcher` (GothAtButcher), `MarketBum1Barks2` (MarketBumDoneSelling), `MamasanBarks` (!Raid_Underway, MamasanDone (+2 more)), `MamasanAmbushBarks` (Raid_Underway), `MamasanAfterAmbush2` (Date1_Dead, !Raid_Underway), `MamasanAfterAmbush` (!Raid_Underway, M06AmbushDone (+2 more)), `MallGuardFinalBarks` (M06AmbushDone), `MallGuardBarksRaid` (Raid_Underway), `MallGuardBarks` (!Raid_Underway, !M06AmbushDone), `MeetMaggie2` (MeetMaggie_Played, !M07Briefing_Played, !MaggieFled, ? PaulDenton_Dead), `MaggieBarks` (MeetMaggie2_Played (+5 more)), `M06JunkieBarks` (M06MeetJunkie_Played (+1 more)), `Lumpath_Street_GuardBarksFinal` (MaxChenConvinced), `Labrat_BumBarks` (? Labrat_Released), `M06JockTrappedBarksRadius` (!helicopter_armed), `M06JockTrappedBarksFrob` (!helicopter_armed), `M07JaimeBarks` (M06JaimeDone), `QuickWaiting3` (QuickLetPlayerIn, !Have_ROM (+1 more)), `QuickWaiting2` (QuickConvinced, !MaxChenConvinced), `QuickWaiting_1_5` (Gate_Guard2_Played, !Have_Evidence (+1 more)), `QuickWaiting` (Gate_Guard2_Played, !Have_Evidence (+3 more)), `QuickOverheard3` (QuickOverheard2_Played (+1 more)), `QuickOverheard2` (QuickOverheard1_Played (+1 more)), `QuickOverheard1` (DragonHeadsInLuckyMoney), `QuickLouisDead` (MarketKid_Dead (+1 more)), `QuickAfterMaggie` (Gate_Guard2_Played, MeetMaggie_Played, !Have_Evidence, !QuickMaggieComment), `M06GordonFinalBarks` (TriadCeremony_Played (+1 more)), `GordonBarBarks` (M07GordonIdle), `DrinkingWomanOverheard3` (DrinkingWomanOverheard2_Played (+2 more)), `DrinkingWomanOverheard2` (DrinkingWomanOverheard_Played (+2 more)), `DrinkingWomanInterrupted` (!Raid_Underway, DrinkingWomanHeard, !M06AmbushDone), `DrinkingWomanDefaultBarks2` (M06AmbushDone), `DrinkingWomanDefaultBarks` (!Raid_Underway, !DrinkingWomanHeard (+1 more)), `DrinkingWomanBarks` (DrinkingWomanInterrupted_Played (+4 more)), `DrinkingWomanAmbushBarks` (Raid_Underway), `DrinkingManBarks` (? Raid_Underway (+2 more)), `Disgruntled_GuyBarks` (!VL_Found_Labs, Disgruntled_Guy_Done), `Disgruntled_Guy_Return` (VL_Found_Labs), `Disgruntled_Guy_Final_Barks` (Disgruntled_Guy_Return_Played), `Date2Barks` (? Raid_Underway), `DanceLisaBarks` (!Raid_Underway, ? M06AmbushDone), `DanceLisaAmbushBarks` (Raid_Underway), `DanceGirlBarks` (!Raid_Underway, ? M06AmbushDone), `DanceGirlAmbushBarks` (Raid_Underway), `DanceCaroleOverheard` (!Raid_Underway), `DanceCaroleBarks` (? Raid_Underway, ? M06AmbushDone), `ClubTriadFinalBarks` (M06AmbushDone), `ClubTriadBarks` (!Raid_Underway, !M06AmbushDone), `ClubTriadAmbushBarks` (Raid_Underway), `ClubTessaNormalHackBarks` (!Raid_Underway, ReadyForMercedes2 (+1 more)), `ClubTessaBarks` (!Raid_Underway, !ReadyForMercedes2 (+1 more)), `ClubTessaAmbushHackBarks` (!Raid_Underway, ReadyForMercedes2 (+1 more)), `ClubTessaAmbushBarks` (Raid_Underway), `ClubMercedesWalkingBarks` (!Raid_Underway (+2 more)), `ClubMercedesFinalBarks` (ReadyForMercedes3, !Raid_Underway), `ClubMercedesAmbushHackBarks` (!Raid_Underway, ReadyForMercedes2 (+1 more)), `ClubMercedesAmbushBarks` (Raid_Underway), `ClubDoorGirlBarks` (PaidForLuckyMoney, !Raid_Underway), `ClubDoorGirlAmbushBarks` (Raid_Underway), `ClubDoorGirlAfterRaid` (M06AmbushDone), `BouncerBarks` (!BouncerComing, !Raid_Underway (+2 more)), `BouncerAmbushBarks` (Raid_Underway), `ClubBartenderAmbushBarks` (Raid_Underway), `Canal_Pilot_Barks` (Canal_Pilot_Done), `Meet_Canal_Merchant2D` (Versalife_Done, Meet_Canal_Merchant2_Played, !CanalMerchantLostComment), `Meet_Canal_Merchant2` (Meet_Canal_Merchant_Played, !Versalife_Done), `Canal_MerchantBarks2` (Meet_Canal_Merchant2_Played (+2 more)), `Canal_MerchantBarks` (Meet_Canal_Merchant2_Played (+1 more)), `Meet_Canal_Drunk2` (Meet_Canal_Drunk_Played, TriadCeremony_Played), `Meet_Canal_Drunk` (? !KnowsTongPathConnection, ? !QuickLetPlayerIn), `Canal_DrunkBarks2` (Meet_Canal_Drunk2_Played), `Canal_DrunkBarks` (Meet_Canal_Drunk_Played (+1 more)), `Brawl_Red_ArrowBarks` (? RumbleCops_Lost (+1 more)), `Brawl_Lum_PathBarks` (? RumbleRedArrow_Lost (+1 more)), `Brawl_CopBarks` (? RumbleLumPath_Lost (+1 more)), `BathroomGirlBarks` (!Raid_Underway), `BathroomGirlAmbushBarks` (Raid_Underway), `Base_Guard_MiddleBarks` (TriadCeremony_Played (+5 more)), `Base_Guard_FinalBarks` (Versalife_Done, ? M08Briefing_Played), `BarWomanLingBarks` (!M07Briefing_Played, !Raid_Underway (+2 more)), `BarWomanLingAmbushBarks` (Raid_Underway), `BarWomanLingAfterMugging` (M07Briefing_Played, !Raid_Underway), `BarThugBarks2` (M06AmbushDone, M06MeetBarThug_Played), `BarThugBarks` (!MaxChenConvinced (+1 more)), `BarThugAmbushBarks` (!M06AmbushDone, MaxChenConvinced), `BarSuitBarks` (SuitDone, !Raid_Underway), `BarSuitAmbushBarks` (Raid_Underway), `BarSailorRaidBarks` (Raid_Underway), `BarSailorBumpBarks` (!Raid_Underway, !M06AmbushDone), `BarSailorBarks` (!Raid_Underway, !M06AmbushDone (+2 more)), `BarSailorAfterRaidBarks` (M06AmbushDone), `LawrenceOverheard3` (LawrenceOverheard2_Played (+1 more)), `LawrenceOverheard2` (LawrenceOverheard_Played (+1 more)), `LawrenceOverheard` (!Raid_Underway), `LawrenceBarks` (? Raid_Underway), `M07AlexJacobsonBarks` (Versalife_Done, ? !JaimeRecruited), `M06AlexJacobsonBarks` (!Versalife_Done (+4 more)).

Plain InfoLinks, no flag and no event: 6 (listed with their starters in the InfoLink table).

Plain conversations with an actor (3): MaySung: MaySungIntroHack; MarketBum1: MeetMarketBum1; DataEntry_Wander: MeetDataEntry_Wander.

Plain overheard conversations (40): VL_Secretary: VL_SecretaryBarks; VL_Cop: VL_CopBarks; TeaHouseRedArrow: TeaHouseDrama; Street_Man: Street_ManBarks; Street_Doorman: Street_DoormanBarks; Street_Cop: Street_CopBarks; Street_Bum1: Street_Bum1Barks; Storage_ComputerTech: Storage_ComputerTechBarks; MJ12Lab_WiB: MJ12Lab_WiBBarks; MJ12Lab_TroopWindow: MJ12Lab_TroopWindowBarks; MJ12Lab_TroopBlue: MJ12Lab_TroopBlueBarks; MJ12Lab_TroopBarracks: MJ12Lab_TroopBarracksBarks; MJ12Lab_Troop_Level2: MJ12Lab_Troop_Level2Barks; MJ12Lab_Troop: MJ12Lab_TroopBarks; MJ12Lab_Psionics: MJ12Lab_PsionicsBarks; MJ12Lab_Physics: MJ12Lab_PhysicsBarks MJ12Lab_Physics_Overheard; MJ12Lab_Nanotech: MJ12Lab_NanotechBarks; MJ12Lab_MiB: MJ12Lab_MiBBarks; MJ12Lab_Genetics: MJ12Lab_GeneticsBarks MJ12Lab_Genetics_Overheard; MJ12Lab_Computer: MJ12Lab_ComputerBarks; MJ12Lab_BioWeapons: MJ12Lab_BioWeaponsBarks; MJ12Lab_Biotech: MJ12Lab_BiotechBarks; MJ12Lab_Assistant_Level2: MJ12Lab_Assistant_Level2Barks; MJ12Lab_Assistant: MJ12Lab_AssistantBarks; MarketVaceShop: MarketVaseShopBarks; MarketMonk: MarketMonkBarks; MarketGoth: MarketGothBarks; MarketFlorist: MarketFloristBarks; MarketBum: MarketBumBarks; MarketBeatCop: MarketBeatCopBarks; Market_Lumpath: Market_LumpathBarks; Company_Man: Company_ManBarks; ClubLumpath: ClubLumpathBarks; Caterer: CatererBarks; Canal_Whore: Canal_WhoreBarks; Canal_Thug1: Overhear_Canal_Thug1; Canal_Cop: Canal_CopBarks; BarManVince: BarManVinceBarks.

InfoLinks and what starts them:

| InfoLink | Started by | Needs | Sets / does |
| --- | --- | --- | --- |
| `DL_TongFixesKillswitch2` | HongKong_TongBase/DataLinkTrigger1 (1160,128) |  | set KillswitchFixed, done RestoreAugmentations |
| `DL_TongFixesKillswitch1` | HongKong_TongBase/DataLinkTrigger0 (1630,127) |  |  |
| `DL_Tong_08` | HongKong_MJ12lab/DataLinkTrigger8 (-2,-40) | !M07Briefing_Played, !Have_ROM |  |
| `DL_Tong_07` | HongKong_MJ12lab/DataLinkTrigger3 (-3,-236) needs !Have_ROM, HongKong_MJ12lab/DataLinkTrigger4 (-152,-83), HongKong_MJ12lab/DataLinkTrigger5 (156,-77) (+2 more) | !M07Briefing_Played, Have_ROM | done GetROM, +goal UniteTriads |
| `DL_Tong_06` | HongKong_Storage/DataLinkTrigger2 (-2631,-1298) | VL_Got_Schematic |  |
| `DL_Tong_05` | HongKong_Storage/DataLinkTrigger3 (-133,-80), HongKong_Storage/DataLinkTrigger6 (123,-80) | VL_Got_Schematic | done EscapeVersaLife, +goal ReportToTong2 |
| `DL_Tong_04` | HongKong_Storage/DataLinkTrigger1 (2,-663) | M07Briefing_Played, VL_Got_Schematic, VL_UC_Destroyed | set VL_Got_Schematic, set Versalife_Done, done GetVirusSchematic |
| `DL_Tong_03` | HongKong_Storage/DataLinkTrigger17 (-4,-2538) | M07Briefing_Played |  |
| `DL_Tong_02` | HongKong_Storage/DataLinkTrigger15 (3,-2499), HongKong_Storage/DataLinkTrigger16 (-7,-846) | M07Briefing_Played |  |
| `DL_Tong_01` | HongKong_Storage/DataLinkTrigger13 (10,-1508) | M07Briefing_Played |  |
| `DL_Tong_00B` | HongKong_WanChai_Street/DataLinkTrigger1 (-1395,-449) |  | +goal GetSword |
| `DL_Tong_00` | HongKong_WanChai_Street/DataLinkTrigger0 (-2580,-224) |  | set Have_Evidence, set NoticedMJ12ChowConnection, done InvestigateMaggieChow, done GetSword, +goal ConvinceRedArrow |
| `DL_PoisonGas` | HongKong_Helibase/DataLinkTrigger13 (-479,-1036) |  |  |
| `DL_Jock_Fired` | Mission06.uc:582 |  |  |
| `DL_Jock_05` | HongKong_WanChai_Market/DataLinkTrigger2 (-756,-1344) |  | +goal FindTracerTong, +goal CheckCompound |
| `DL_Jock_04` | HongKong_WanChai_Market/DataLinkTrigger0 (213,328), HongKong_WanChai_Market/DataLinkTrigger1 (221,938) |  |  |
| `DL_Jock_03` | Mission06.uc:554 |  |  |
| `DL_Jock_02` | Mission06.uc:527 |  | done DeactivateWeaponLock |
| `DL_Jock_01` | HongKong_Helibase/DataLinkTrigger1 (1928,60), HongKong_Helibase/DataLinkTrigger4 (1764,-14), HongKong_Helibase/DataLinkTrigger0 (1934,-121) (+6 more) |  | +goal DeactivateWeaponLock |
| `DL_FuelTank` | HongKong_Helibase/DataLinkTrigger12 (16,-767) |  |  |
| `DL_Daedalus_07` | HongKong_Storage/DataLinkTrigger0 (-811,-514) | M07Briefing_Played, VL_Got_Schematic, !VL_UC_Destroyed |  |
| `DL_Daedalus_06` | HongKong_Storage/DataLinkTrigger10 (-723,-204), HongKong_Storage/DataLinkTrigger11 (-428,3), HongKong_Storage/DataLinkTrigger12 (430,8) | M07Briefing_Played |  |
| `DL_Daedalus_05` | HongKong_Storage/DataLinkTrigger4 (14,873) | M07Briefing_Played, VL_Got_Schematic, VL_UC_Destroyed | set VL_UC_Destroyed, set Versalife_Done, done DestroyUniversalConstructor, +goal EscapeVersaLife |
| `DL_Daedalus_04` | HongKong_Storage/DataLinkTrigger9 (-733,-874), HongKong_Storage/DataLinkTrigger5 (513,-1070) | M07Briefing_Played | +goal DestroyUniversalConstructor |
| `DL_Daedalus_03` | HongKong_MJ12lab/DataLinkTrigger7 (7,752) | M07Briefing_Played, !VL_UC_Destroyed |  |
| `DL_Daedalus_02` | HongKong_WanChai_Market/DataLinkTrigger5 (2187,-707) | !MeetTracerTong_Played |  |
| `DL_Daedalus_01` | (none found) |  | +goal FindTracerTong |

**Required (progression) conversations**, from the chain read with `inventory-campaign.mjs chain 06_HongKong_WanChai_Market outro_trigger 40`: `M06JockExit` (Jock, bump/frob/radius 240; fires `Jock_Chopper` -> `jock_chopper` -> `outro_trigger`) needs `M08Briefing_Played`; `M08Briefing` (Tracer Tong) needs
`Versalife_Done`, set by `DL_Tong_04@Done`, `DL_Daedalus_05@Done` or the Storage's `FlagTrigger6` at (-1,8,-1390); `DL_Tong_04` and `DL_Daedalus_05` (Storage `DataLinkTrigger1`/`4`) need `M07Briefing_Played`; `M07Briefing` (Tong) needs `TriadCeremony_Played`; `TriadCeremony` (Gordon Quick,
radius 160) needs `Have_ROM` (the MJ12 lab's `FlagTrigger0` at (-1,-265,-184), tag `TongHasRom`) and `MeetTracerTong_Played`; `MeetTracerTong` (Tong, radius 90) has no flag requirement. Before that the Helibase's blast doors have to be blown: `DL_Jock_01`
(adds `DeactivateWeaponLock`), `jockweapons` button -> `helicopter_armed` (`FlagTrigger0`), `DL_Jock_02`, `helicopter_fire` (`FlagTrigger2`, tag `fire_missile`) -> `Mission06.Timer`.
The side chains (`Gate_Guard2`, `MeetMaxChen`, `MeetMaggie`, the police vault, the kid and tea-house sequences, Mercedes) are not on this chain.

### 06.4 Objectives

| Goal | Kind | Text | Added by | Completed by |
| --- | --- | --- | --- | --- |
| `RestoreAugmentations` | primary | Go to the center of the Operating Theater so that Tracer Tong can deactivate the killswitch and restore augmentation functionality. | MeetTracerTong | DL_TongFixesKillswitch2 |
| `GetROM` | primary | Get the ROM-encoding for the Dragon's Tooth sword from the basement laboratories at VersaLife. | MeetTracerTong2 | DL_Tong_07, 06_HongKong_MJ12lab/GoalCompleteTrigger0 |
| `UniteTriads` | primary | Go to the temple in Wan Chai to cement the alliance between the Triads. | DL_Tong_07, M06TongBarks2 | TriadCeremony |
| `EscapeVersaLife` | primary | Escape the VersaLife facility through the floor of the Universal Constructor chamber. | DL_Daedalus_05 | DL_Tong_05 |
| `ReportToTong2` | primary | Report to Tracer Tong for information on Stanton Dowd and the Illuminati. | DL_Tong_05 | M08Briefing |
| `GetVirusSchematic` | primary | Gain access to the Level 2 labs at VersaLife and locate information on the structure of the plague virus. | M07Briefing | DL_Tong_04 |
| `GetSword` | primary | Retrieve the Dragon's Tooth sword and await further instructions from Tracer Tong. | DL_Tong_00B | DL_Tong_00 |
| `InvestigateMaggieChow` | primary | Find and examine the Dragon's Tooth sword as proof regarding whether or not Maggie Chow is telling the truth. | Gate_Guard2 | DL_Tong_00 |
| `ConvinceRedArrow` | primary | Demonstrate Maggie Chow's guilt to the Red Arrow by showing Max Chen the Dragon's Tooth sword. Find Max Chen in the Lucky Money Club in the mall near  | DL_Tong_00, Gate_Guard2 | MeetMaxChen |
| `FindTracerTong` | primary | Find Tracer Tong somewhere in Hong Kong. | DL_Jock_05, DL_Daedalus_01 | MeetTracerTong |
| `CheckCompound` | primary | Look for clues to finding Tracer Tong at the compound that Paul used to visit, to the east of the Wan Chai market. | DL_Jock_05 | MeetTracerTong, Gate_Guard2 |
| `DeactivateWeaponLock` | primary | Deactivate the weapon-lock on Jock's helicopter. The remote control-panel is on Flight Control Deck One. | DL_Jock_01 | DL_Jock_02 |
| `DestroyUniversalConstructor` | primary | Destroy the Universal Constructor used for manufacturing plague virus. | DL_Daedalus_04 | DL_Daedalus_05, 06_HongKong_Storage/GoalCompleteTrigger0 |
| `LeaveHongKong` | primary | Board Jock's helicopter in the Luminous Path compound. | M08Briefing | JockBarksLumPath, M06JockExit |
| `ReportToTong` | primary | Report to Tracer Tong inside the Luminous Path compound to deliver the good news of the truce. | TriadCeremony | M07Briefing |
| `VisitMaggieChow` | primary | Visit Maggie Chow, at 1313 Tonnochi Road. | MeetRed_Arrow_01 | MeetMaggie |
| `DeliverChensResponse` | primary | Tell Gordon Quick how the Red Arrow responded to the news about Maggie Chow. He should be near the Luminous Path compound next to the Wan Chai market. | MeetMaxChen, Gate_Guard2 | Gate_Guard2 |
| `InvestigatePolice` | secondary | Find evidence in the police station in the Wan Chai Market that will settle the Triad dispute. Bring it to Maggie Chow to earn her trust. | MeetMaggie | Gate_Guard2 |
| `HaveDrinksWithDragonHeads` | secondary | Meet the dragon heads at the Lucky Money for drinks. | TriadCeremony | M07GordonFirstGive |
| `ConvinceLuminousPath` | carried |  | - | Gate_Guard2 |

### 06.5 Choices with lasting consequences

Set here, alive in a later mission: **none**. Every flag this mission's script and FlagTriggers create expires by mission 8 (expiration 7 or 8, entering mission 8 deletes both). Read here, set earlier:

| Flag | Set earlier by | Read here by |
| --- | --- | --- |
| `JacobsonRecruited` | M5 conversation M05MeetAlexJacobson | script Mission06.FirstFrame:86 |
| `JaimeRecruited` | M5 conversation M05MeetJaime@Recruit | checks in Base_Guard_MiddleBarks; checks in M07AlexJacobsonBarks; checks in M06MeetAlexJacobson; checks in M06AlexJacobsonBarks; script Mission06.FirstFrame:76 |

* `JaimeRecruited` (mission 5): Jaime appears in the Tong base after VersaLife (`Mission06.FirstFrame:76`), and the Alex/Jaime conversations (`M06MeetAlexJacobson`, `M06AlexJacobsonBarks`, `M07AlexJacobsonBarks`, `Base_Guard_MiddleBarks`) change; `JacobsonRecruited` (mission 5): Alex appears in the Tong base (`:86`).
* Permanent deaths made here and read later: `TracerTong_Dead` (read in missions 12 and 15 and in the endgames); `MaggieChow_Dead` and `MarketKid_Dead` are read only here and in the intro/endgame maps; the table of who can die lists every important pawn (`GordonQuick`, `MaxChen`, `Supervisor01`, ...).
  `Supervisor01_Dead` is read by `Mission06.uc:39` (the Canal block that unhides `John_Smith_Body`).

### 06.6 Progression path

1. Helibase, `PlayerStart2`. `DL_Jock_01` (nine `DataLinkTrigger`s) adds `DeactivateWeaponLock`; press the weapon-lock panel (`Button1 Button8`, door `jockweapons`) -> `helicopter_armed`; `FlagTrigger2` `fire_missile` -> `helicopter_fire`: Jock's rockets destroy `Blast_doors`.
2. Elevator `cargoup` (`MapExit0`, tag `change_floors`, button) to the Market. `DL_Jock_05` adds `FindTracerTong`, `CheckCompound`; the compound is the Tong base (`Teleporter1/11` from the Market's `lab` portal). `MeetTracerTong` (radius 90).
3. Get the ROM: Market -> VersaLife lobby (`MapExit1`, `change_floors01`) -> MJ12 lab -> `FlagTrigger0` (`Have_ROM`, the Dragon's Tooth ROM).
4. `TriadCeremony` (Gordon Quick in the temple; the Market's `FirstFrame` sets the scene on `Have_ROM` and `MeetTracerTong_Played`), then `M07Briefing` (Tong).
5. Storage (via the lab): `VL_UC_Destroyed`, the schematic upload (`VL_Got_Schematic`), `FlagTrigger6` or `DL_Tong_04`/`DL_Daedalus_05` -> `Versalife_Done`.
6. `M08Briefing` (Tong), `M06JockExit` (Jock, Luminous Path compound) -> `outro_trigger` -> `MapExit2` -> `08_NYC_Street`.

The gates are many (the Helibase `Blast_doors` and `elevator_door`, the hangar, the club's keypads and bouncers, the MJ12 lab's real/dummy keypads, the VersaLife and Storage security):

| Map | Tag (movers) | Lock | Opened by |
| --- | --- | --- | --- |
| `06_HongKong_Helibase` | `robobay` (2) | unlocked, pick 0.20, not frobbable | Dispatcher Dispatcher5 |
| `06_HongKong_Helibase` | `robobay_01` (2) | unlocked, pick 0.20, not frobbable | Dispatcher Dispatcher5 |
| `06_HongKong_Helibase` | `DeusExMover20` (1) | unlocked, key control_door01 | frob |
| `06_HongKong_Helibase` | `DeusExMover21` (1) | locked, key control_door01 | frob |
| `06_HongKong_Helibase` | `Blast_doors` (1) | unlocked, not frobbable | script Mission06:547, script Mission06:571, script Mission06:585, script Mission06:589 |
| `06_HongKong_Helibase` | `hangar_door` (2) | unlocked, not frobbable | Dispatcher Dispatcher1 |
| `06_HongKong_Helibase` | `ordinance_door` (1) | locked, key Ordinance_bay | frob |
| `06_HongKong_Helibase` | `jockweapons` (1) | unlocked, not frobbable | Button1 Button8 |
| `06_HongKong_Helibase` | `Helipad` (1) | unlocked, not frobbable | Dispatcher Dispatcher1 |
| `06_HongKong_Helibase` | `elevator_door` (2) | unlocked, not frobbable | Button1 Button0, Button1 Button6, Button1 Button7 |
| `06_HongKong_Helibase` | `DoorWreckage` (1) | unlocked, not frobbable | script Mission06:535 |
| `06_HongKong_MJ12lab` | `upper_lab_doors` (2) | unlocked, not frobbable | Button1 Button32, Button1 Button34 |
| `06_HongKong_MJ12lab` | `Lower_lab_doors` (2) | unlocked, not frobbable | Trigger Trigger2 |
| `06_HongKong_MJ12lab` | `eledoor02` (4) | locked, not frobbable | DirectionalTrigger DirectionalTrigger0, Button1 Button27, Button1 Button29, Button1 Button0, Button1 Button3, Button1 Button4 |
| `06_HongKong_MJ12lab` | `security_doors` (2) | unlocked, not frobbable | Trigger Trigger3 |
| `06_HongKong_MJ12lab` | `trap_door` (1) | unlocked, not frobbable | Keypad2 Keypad4, Switch1 Switch0 |
| `06_HongKong_MJ12lab` | `SubjectDoors` (1) | locked, key SubjectDoors | frob |
| `06_HongKong_MJ12lab` | `SubjectDoors1` (2) | locked, key SubjectDoors | frob |
| `06_HongKong_MJ12lab` | `SubjectDoors2` (2) | locked, key SubjectDoors | frob |
| `06_HongKong_MJ12lab` | `GreyDoors` (4) | unlocked, key SubjectDoors | frob |
| `06_HongKong_MJ12lab` | `Nano_Chamber_Door` (1) | locked, key Magnetic_Chamber, breakable 0.70 | Keypad2 Keypad2 |
| `06_HongKong_MJ12lab` | `elevator_door01` (2) | locked, pick 0.20 | Button1 Button20, Button1 Button42, Button1 Button43 |
| `06_HongKong_MJ12lab` | `elevator_door` (2) | locked, pick 0.20, not frobbable | Keypad3 Keypad0, Button1 Button22 |
| `06_HongKong_MJ12lab` | `Pod01` (4) | locked, not frobbable | Keypad2 Keypad5, script Mission06:601 |
| `06_HongKong_MJ12lab` | `Pod02` (4) | locked | script Mission06:601 |
| `06_HongKong_Storage` | `Door_seal` (7) | unlocked, not frobbable | Dispatcher Dispatcher2 |
| `06_HongKong_Storage` | `Shocker` (5) | locked, not frobbable | Dispatcher Dispatcher3, ControlPanel ControlPanel1 |
| `06_HongKong_Storage` | `control_cover` (1) | unlocked, not frobbable | Trigger Trigger0, FlagTrigger FlagTrigger9 |
| `06_HongKong_Storage` | `FloodDoor01` (1) | locked, breakable 0.70, not frobbable | Dispatcher Dispatcher2, Dispatcher Dispatcher1, Dispatcher Dispatcher4 |
| `06_HongKong_Storage` | `FloodDoor02` (1) | locked, breakable 0.70, not frobbable | Dispatcher Dispatcher2, Dispatcher Dispatcher1, Dispatcher Dispatcher4, Dispatcher Dispatcher5 |
| `06_HongKong_Storage` | `FloodDoor03` (1) | locked, breakable 0.70, not frobbable | Dispatcher Dispatcher2, Dispatcher Dispatcher4, Dispatcher Dispatcher5, Dispatcher Dispatcher6 |
| `06_HongKong_Storage` | `FloodDoor04` (1) | locked, breakable 0.70, not frobbable | Dispatcher Dispatcher2, Dispatcher Dispatcher5, Dispatcher Dispatcher6, Dispatcher Dispatcher7 |
| `06_HongKong_Storage` | `FloodDoor05` (1) | locked, breakable 0.70, not frobbable | Dispatcher Dispatcher2, Dispatcher Dispatcher6, Dispatcher Dispatcher7, Dispatcher Dispatcher8 |
| `06_HongKong_Storage` | `FloodDoor06` (1) | locked, breakable 0.70, not frobbable | Dispatcher Dispatcher2, Dispatcher Dispatcher7, Dispatcher Dispatcher8, Dispatcher Dispatcher9 |
| `06_HongKong_Storage` | `FloodDoor07` (1) | locked, breakable 0.70, not frobbable | Dispatcher Dispatcher2, Dispatcher Dispatcher8, Dispatcher Dispatcher9 |
| `06_HongKong_Storage` | `VirusUploaded` (1) | unlocked, key NanoContainmentDoor, not frobbable | (nothing found) |
| `06_HongKong_Storage` | `Self_Destruct` (2) | unlocked, not frobbable | Keypad1 Keypad2 |
| `06_HongKong_Storage` | `FloodDoor08` (1) | locked | Button1 Button2 |
| `06_HongKong_Storage` | `AUC` (1) | unlocked, not frobbable | script Mission06:603 |
| `06_HongKong_Storage` | `Pod01` (2) | locked | Keypad1 Keypad5, Dispatcher Dispatcher0, script Mission06:601 |
| `06_HongKong_Storage` | `Pod02` (2) | locked | Keypad1 Keypad6, Dispatcher Dispatcher0, script Mission06:601 |
| `06_HongKong_Storage` | `Pod03` (2) | locked | Keypad1 Keypad7, Dispatcher Dispatcher0, script Mission06:602 |
| `06_HongKong_Storage` | `Pod04` (2) | locked | Keypad1 Keypad8, Dispatcher Dispatcher0, script Mission06:602 |
| `06_HongKong_Storage` | `elevator_door` (2) | unlocked, pick 0.20 | Button1 Button0, Button1 Button6, Button1 Button5 |
| `06_HongKong_Storage` | `Control_Rod` (1) | unlocked, not frobbable | Dispatcher Dispatcher3 |
| `06_HongKong_Storage` | `UC_Chamber_Door` (3) | locked | frob |
| `06_HongKong_Storage` | `control_platform` (1) | unlocked, not frobbable | Trigger Trigger1, FlagTrigger FlagTrigger8 |
| `06_HongKong_TongBase` | `Secretdoor01` (1) | unlocked, not frobbable | Button1 Button7, Button1 Button8 |
| `06_HongKong_TongBase` | `hatch01` (1) | unlocked, not frobbable | Button1 Button4, Dispatcher Dispatcher2 |
| `06_HongKong_TongBase` | `hatch02` (1) | unlocked, not frobbable | Button1 Button2, Dispatcher Dispatcher2 |
| `06_HongKong_TongBase` | `killswitch_top1` (1) | unlocked, not frobbable | Dispatcher Dispatcher0 |
| `06_HongKong_TongBase` | `NormalLight` (1) | unlocked, not frobbable | Dispatcher Dispatcher0 |
| `06_HongKong_VersaLife` | `security` (1) | locked, breakable 0.75, not frobbable | Keypad1 Keypad0 |
| `06_HongKong_VersaLife` | `elevator_door` (2) | locked, pick 0.20, not frobbable | Button1 Button5, Keypad1 Keypad1 |
| `06_HongKong_VersaLife` | `LobbyDoor` (2) | locked, pick 0.20 | Button1 Button16, Button1 Button13, Button1 Button1 |
| `06_HongKong_VersaLife` | `main_doors` (2) | unlocked, pick 0.20, breakable 0.25, not frobbable | Trigger Trigger13 |
| `06_HongKong_WanChai_Canal` | `SecretHold` (1) | unlocked, pick 0.20, breakable 0.50, not frobbable | HKHangingLantern HKHangingLantern1 |
| `06_HongKong_WanChai_Canal` | `StationDoor` (1) | locked, not frobbable | Switch1 Switch1 |
| `06_HongKong_WanChai_Canal` | `MaintDoor` (1) | locked | Switch1 Switch0 |
| `06_HongKong_WanChai_Garage` | `secret_door` (1) | unlocked, breakable 0.75 | Keypad1 Keypad3 |
| `06_HongKong_WanChai_Garage` | `Barricade` (1) | unlocked, not frobbable | LogicTrigger LogicTrigger0 |
| `06_HongKong_WanChai_Market` | `compound_gate` (2) | locked, not frobbable | Keypad1 Keypad8, Button1 Button13 |
| `06_HongKong_WanChai_Market` | `station_door_04` (2) | locked | Button1 Button9, Button1 Button2 |
| `06_HongKong_WanChai_Market` | `station_door_05` (1) | locked | Keypad1 Keypad6, Button1 Button10 |
| `06_HongKong_WanChai_Market` | `secret_door` (1) | locked, pick 0.20, breakable 0.60 | Keypad1 Keypad7, Button1 Button11 |
| `06_HongKong_WanChai_Market` | `Basement_door` (1) | locked | Keypad1 Keypad0 |
| `06_HongKong_WanChai_Market` | `elevator_door` (2) | locked, not frobbable | Keypad3 Keypad5, Button1 Button0 |
| `06_HongKong_WanChai_Market` | `station_door_01` (1) | locked | Keypad1 Keypad1, Button1 Button16 |
| `06_HongKong_WanChai_Market` | `station_door_02` (1) | locked | Keypad1 Keypad2, Button1 Button15 |
| `06_HongKong_WanChai_Market` | `elevator_door01` (2) | locked, not frobbable | Button1 Button14, Keypad1 Keypad3 |
| `06_HongKong_WanChai_Street` | `bedroom_door` (2) | locked, pick 0.20, breakable 0.25, not frobbable | LightSwitch LightSwitch1, LightSwitch LightSwitch5 |
| `06_HongKong_WanChai_Street` | `study_door` (2) | locked, pick 0.20, breakable 0.25, not frobbable | LightSwitch LightSwitch2, LightSwitch LightSwitch4 |
| `06_HongKong_WanChai_Street` | `bath_doors` (2) | unlocked, pick 0.20, breakable 0.25, not frobbable | Button1 Button2, Button1 Button5 |
| `06_HongKong_WanChai_Street` | `SecretDoor02` (1) | locked, breakable 0.50 | HKHangingLantern HKHangingLantern4, Button1 Button19 |
| `06_HongKong_WanChai_Street` | `LowerGate` (1) | locked, pick 0.40, breakable 0.75 | LightSwitch LightSwitch3 |
| `06_HongKong_WanChai_Street` | `old_Dispalycase` (1) | locked, not frobbable | (nothing found) |
| `06_HongKong_WanChai_Street` | `BreakableWall0` (1) | locked, breakable 0.65 | frob |
| `06_HongKong_WanChai_Street` | `eledoor02` (2) | locked, breakable 0.65, not frobbable | Dispatcher Dispatcher4, Dispatcher Dispatcher8, Dispatcher Dispatcher9, Button1 Button17, Trigger Trigger2 |
| `06_HongKong_WanChai_Street` | `Eledoor01` (3) | locked, pick 0.20 | Dispatcher Dispatcher2, Dispatcher Dispatcher6, Dispatcher Dispatcher7, Dispatcher Dispatcher10, Button1 Button13 |
| `06_HongKong_WanChai_Street` | `RoofEntrance` (1) | locked, breakable 0.75, not frobbable | Button1 Button14, Keypad3 Keypad1 |
| `06_HongKong_WanChai_Street` | `main_doors` (2) | unlocked, pick 0.20, not frobbable | Trigger Trigger13 |
| `06_HongKong_WanChai_Street` | `vault_door` (1) | locked | Keypad1 Keypad0, Button1 Button18 |
| `06_HongKong_WanChai_Street` | `ServiceDoor` (1) | locked, pick 0.80, breakable 0.75 | Switch2 Switch0 |
| `06_HongKong_WanChai_Street` | `DeusExMover44` (1) | locked, key JocksKey | frob |
| `06_HongKong_WanChai_Street` | `JockShaftBottom` (1) | unlocked, not frobbable | DirectionalTrigger DirectionalTrigger5, Trigger Trigger4 |
| `06_HongKong_WanChai_Street` | `JockShaftTop` (1) | unlocked, not frobbable | Button1 Button0, ElevatorMover ElevatorMover2, DirectionalTrigger DirectionalTrigger4, Trigger Trigger6 |
| `06_HongKong_WanChai_Street` | `Sword_Piston` (1) | locked, not frobbable | Dispatcher Dispatcher0 |
| `06_HongKong_WanChai_Street` | `Sword_Cover` (1) | locked, not frobbable | Dispatcher Dispatcher0 |
| `06_HongKong_WanChai_Street` | `Sword_Arm4` (1) | locked, not frobbable | Dispatcher Dispatcher0 |
| `06_HongKong_WanChai_Street` | `Sword_Arm3` (1) | locked, not frobbable | Dispatcher Dispatcher0 |
| `06_HongKong_WanChai_Street` | `Sword_Arm2` (1) | locked, not frobbable | Dispatcher Dispatcher0 |
| `06_HongKong_WanChai_Street` | `Sword_Arm1` (1) | locked, not frobbable | Dispatcher Dispatcher0 |
| `06_HongKong_WanChai_Street` | `Dispalycase` (1) | locked, not frobbable | LightSwitch LightSwitch0, Trigger Trigger0 |
| `06_HongKong_WanChai_Underworld` | `club_doors` (2) | unlocked, not frobbable | Trigger Trigger0, FlagTrigger FlagTrigger0, Trigger Trigger1, Trigger Trigger2, Trigger Trigger3 |
| `06_HongKong_WanChai_Underworld` | `Safe_door` (1) | locked, breakable 0.75, not frobbable | Keypad3 Keypad2 |
| `06_HongKong_WanChai_Underworld` | `Strongbox` (1) | locked, breakable 0.75, not frobbable | Keypad3 Keypad1 |
| `06_HongKong_WanChai_Underworld` | `DeusExMover16` (1) | locked, not frobbable | (nothing found) |

Key doors (a placed `NanoKey` opens them, or the lock is picked; frob only): `LockerMasterKey` x9.

(29 further movers of these maps are locked with a pickable lock or breakable, take no key that exists as a placed `NanoKey` and are fired by no event: not listed.)

**Progression blocker (mission 6).** The first of: the Helibase blast doors not breaking (no `helicopter_fire` / no rocket hit); `MeetTracerTong` unreachable; `Have_ROM` never set; `TriadCeremony`, `M07Briefing`, the VersaLife flag, `M08Briefing` or `M06JockExit` not playing; the elevator
`MapExit`s or `MapExit2` not travelling. The triad side quests, Maggie, Mercedes and the market sequences are not blockers.

### 06.7 Slots

| Slot | Map | Saved as | Saves, play time | Important NPCs dead or knocked out (all) | Lasting-choice flags in the file (all) | Goals still open |
| --- | --- | --- | --- | --- | --- | --- |
| N0015 | `06_HongKong_Helibase` | Hong Kong - MJ12 Helibase | 259, 447 min | AnnaNavarre, DrugDealer, GilbertTerrorist, JoJoFine, JosephManderley, JuanLebedev, PrivateLloyd, Terrorist | AmbrosiaTagged, BathroomBarks_Played, FilbenGaveKey, GuntherFreed, GuntherRespectsPlayer=0, HeardGrenadeTalk, JacobsonRecruited, JaimeRecruited, KnowsAboutKillphrase, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, M04MetWalton, MeetJoeGreen_Played, PlayerMetFilben, SandraWentToCalifornia | - |
| N0016 | `06_HongKong_WanChai_Market` | Hong Kong - Market | 274, 467 min | AnnaNavarre, DrugDealer, GilbertTerrorist, JoJoFine, JosephManderley, JuanLebedev, PrivateLloyd, Terrorist | AmbrosiaTagged, BathroomBarks_Played, FilbenGaveKey, GuntherFreed, GuntherRespectsPlayer=0, HeardGrenadeTalk, JacobsonRecruited, JaimeRecruited, KnowsAboutKillphrase, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, M04MetWalton, MeetJoeGreen_Played, PlayerMetFilben, SandraWentToCalifornia | FindTracerTong, CheckCompound |
| N0017 | `06_HongKong_WanChai_Underworld` | Hong Kong - Lucky Money Club | 291, 506 min | AnnaNavarre, DrugDealer, GilbertTerrorist, JoJoFine, JosephManderley, JuanLebedev, PrivateLloyd, Terrorist | AmbrosiaTagged, BathroomBarks_Played, FilbenGaveKey, GuntherFreed, GuntherRespectsPlayer=0, HeardGrenadeTalk, JacobsonRecruited, JaimeRecruited, KnowsAboutKillphrase, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, M04MetWalton, MeetJoeGreen_Played, PlayerMetFilben, SandraWentToCalifornia | FindTracerTong, InvestigatePolice, ConvinceRedArrow |
| N0018 | `06_HongKong_WanChai_Market` | Hong Kong - Market | 301, 531 min | AnnaNavarre, DrugDealer, GilbertTerrorist, JoJoFine, JosephManderley, JuanLebedev, MJ12Commando, PrivateLloyd, Terrorist | AmbrosiaTagged, BathroomBarks_Played, FilbenGaveKey, GuntherFreed, GuntherRespectsPlayer=0, HeardGrenadeTalk, JacobsonRecruited, JaimeRecruited, KnowsAboutKillphrase, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, M04MetWalton, MeetJoeGreen_Played, PlayerMetFilben, SandraWentToCalifornia | GetROM |
| N0019 | `06_HongKong_WanChai_Garage` | Hong Kong - Canal Road | 322, 576 min | AnnaNavarre, DrugDealer, GilbertTerrorist, JoJoFine, JosephManderley, JuanLebedev, MJ12Commando, PrivateLloyd, Supervisor01, Terrorist | AmbrosiaTagged, BathroomBarks_Played, FilbenGaveKey, GuntherFreed, GuntherRespectsPlayer=0, HeardGrenadeTalk, JacobsonRecruited, JaimeRecruited, KnowsAboutKillphrase, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, M04MetWalton, MeetJoeGreen_Played, PlayerMetFilben, SandraWentToCalifornia | GetVirusSchematic |

Five slots cover the mission from the helibase (N0015) to the garage (N0019, 14 goals recorded): N0015 is the start with all of mission 5's choices already made; N0016 and N0018 are the Market, N0017 the club. Every slot has `AnnaNavarre`, `JosephManderley`, `PrivateLloyd` already dead, so Hong Kong rows start from a world in which those pawns never return.

## Mission 08: Hell's Kitchen again (NYC)

Six maps, the third visit to the Hell's Kitchen set (street, bar, clinic, hotel, smuggler's lair, sewers), now under FEMA/MJ12 pressure. The player lands in the Street from Hong Kong (`PlayerStart0` at (-354,795,594), well above the street level), finds Harley Filben in the bar (or the janitor Thomas Dieter if Filben is dead),
meets Stanton Dowd, gets explosives from the smuggler to scuttle the PCS Wall Cloud, and leaves with Jock for the Brooklyn Naval Shipyard.

### 08.1 Maps and arrival

| Map | Actors | Level info (`MapName`; `MissionLocation`) | Startup text | Script | Arrives from | Leaves to |
| --- | --- | --- | --- | --- | --- | --- |
| `08_NYC_Bar` | 484 | 08_NYC_Bar; NYC - Underworld Tavern | - | Mission08 | 08_NYC_Street#ToBarBackEntrance/ToBarFrontEntrance x2 | 08_NYC_Street#FromBarBackEntrance/FromBarFrontEntrance x2 |
| `08_NYC_FreeClinic` | 502 | 08_NYC_FreeClinic; NYC - Free Clinic | - | Mission08 | 08_NYC_Street#FromStreet | 08_NYC_Street#FromClinic |
| `08_NYC_Hotel` | 881 | 08_NYC_Hotel; NYC - 'Ton Hotel | - | Mission08 | 08_NYC_Street#ToHotelFrontDoor/ToHotelBedroom x2 | 08_NYC_Street#BedroomWindow/FromHotelFrontDoor x2 |
| `08_NYC_Smug` | 536 | 08_NYC_Smug; NYC - Smuggler's Lair | - | Mission08 | 08_NYC_Street#ToSmugFrontDoor/ToSmugBackDoor x2 | 08_NYC_Street#FromSmugBackDoor/FromSmugFrontDoor x2 |
| `08_NYC_Street` | 1580 | 08_NYC_Street; NYC - Hell's Kitchen | New York City, Hell's Kitchen | Mission08 | 06_HongKong_WanChai_Market (path CameraPath); 08_NYC_Bar#FromBarBackEntrance/FromBarFrontEntrance x2; 08_NYC_FreeClinic#FromClinic; 08_NYC_Hotel#BedroomWindow/FromHotelFrontDoor x2; 08_NYC_Smug#FromSmugBackDoor/FromSmugFrontDoor x2; 08_NYC_Underground#FromNYCUndergroundSewer2/FromNYCSump x2 | 09_NYC_Dockyard (path CameraPath); 08_NYC_Smug#ToSmugFrontDoor/ToSmugBackDoor x2; 08_NYC_Bar#ToBarBackEntrance/ToBarFrontEntrance x2; 08_NYC_Hotel#ToHotelFrontDoor/ToHotelBedroom x2; 08_NYC_FreeClinic#FromStreet; 08_NYC_Underground#ToNYCUndergroundSewer2/ToNYCSump x2 |
| `08_NYC_Underground` | 413 | 08_NYC_Underground; NYC - Sewers | - | Mission08 | 08_NYC_Street#ToNYCUndergroundSewer2/ToNYCSump x2 | 08_NYC_Street#FromNYCUndergroundSewer2/FromNYCSump x2 |

* **Arrival.** `06_HongKong_WanChai_Market` `MapExit2` (camera `CameraPath`, tag `outro_trigger`) -> `08_NYC_Street` (no portal). Mission change 6 -> 8: `Save\Current` wiped, `DeleteExpiredFlags(8)` (the expiration-8 flags of Hong Kong go).
* **Inside.** The Street hub: bar (2 teleporters), clinic, hotel (front door and bedroom), smuggler (front and back doors), sewers (2); there are no Battery Park or warehouse maps in this mission.
* **Leaving.** `08_NYC_Street` `MapExit0` (camera `CameraPath`, tag `CameraExit`) -> `09_NYC_Dockyard`, fired by `Dispatcher0` (`OutEvents[1]` = `TriggerExit`), which `M08JockExit` triggers on its `Go` branch.

| Map | Actor | At | Leads to | Fired by (events targeting its tag) |
| --- | --- | --- | --- | --- |
| `08_NYC_Street` | MapExit `MapExit0` | 224,1306,606 | `09_NYC_Dockyard` (path `CameraPath`) | tag `CameraExit`: Dispatcher Dispatcher0 |

**08_NYC_Street MapExit0 -> 09_NYC_Dockyard** (tag `CameraExit`)

```text
event CameraExit
  Dispatcher Dispatcher0 (OutEvents[1]) tag TriggerExit
    event TriggerExit
      conversation event Trigger "TriggerExit" in M08JockExit branch Go
        conversation M08JockExit [talk bump/frob/radius 250; owner Jock]
          starts: its actor (bump/frob/radius 250)
          flag StantonDowd_Played (set when conversation StantonDowd ends): 
            conversation StantonDowd [talk bump/frob; owner StantonDowd]
```

### 08.2 Mission script `Mission08`

`.cache/research/src/DeusEx/Mission08.uc`, 281 lines.

* `FirstFrame` (`:12-34`): `SandraWentToCalifornia` (**set in mission 4, permanent**) destroys every `SandraRenton` pawn (`:19-23`); in the smuggler's lair `FordSchickRescued` makes Ford enter (`:28-32`; per the mission 2 `PreTravel` note the data cannot make this flag true here).
* `PreTravel` (`:42-54`): in the Street, the `BlackHelicopter` tagged `EntranceCopter` is destroyed. No `SendPlayer`/`ClientTravel`.
* `Timer` (`:62-277`): clinic: `JoeGreene_Dead` completes `KillGreene` (`MS_GreeneGoalSet`, expiration 9); Street: for each `RiotCop` tag `Cop1..6` that is gone, the `UNATCOTroop` tagged `troop1..6` enters (`MS_UnhideTroopN`); `HarleyFilben_Dead` -> the `ThomasDieter` janitor enters (`:173-183`);
  `M08MeetHarleyFilben_Played` or `MeetThomasDieter_Played` -> `StantonDowd` enters (`:186-196`); once he has, `GreenKnowsAboutDowd` (and Joe alive by the test `JoeGreen_Dead`, **a misspelling of `JoeGreene_Dead`, which no code sets**, so Joe's death never blocks it) or `SheaKnowsAboutDowd` -> the `ShadyGuy` thug enters;
  the MJ12 ambush (`StantonAmbush`) comes when the thug is within 128 units of Stanton or when `MJ12Converging` (set by `DL_Exit`); `StantonAmbushDefeated` when the `MJ12AttackForce` is gone; `StantonDowd_Played` and `DL_Exit_Played` -> the helicopter tagged `CopterExit` enters (`:267-275`).
* Flags it sets: all with expiration 9 (alive through mission 8, gone on entering mission 9). The ones that outlive the mission come from conversations.
* Actors it touches: `SandraRenton`, `FordSchick`, `BlackHelicopter` (`EntranceCopter`, `CopterExit`), `RiotCop`/`UNATCOTroop` by tag, `Janitor ThomasDieter`, `StantonDowd`, `ThugMale ShadyGuy`, `MJ12Troop MJ12AttackForce`.

Generated from the script's calls (`inventory-campaign.mjs scripts`; `:N` is the first line):

* **Flags set** (13; `eN` = explicit expiration N, otherwise the default): `MS_GreeneGoalSet` e9 (:81), `MS_UnhideTroop1` e9 (:98), `MS_UnhideTroop2` e9 (:112), `MS_UnhideTroop3` e9 (:126), `MS_UnhideTroop4` e9 (:140), `MS_UnhideTroop5` e9 (:154), `MS_UnhideTroop6` e9 (:168), `MS_ThomasUnhidden` e9 (:181), `MS_StantonUnhidden` e9 (:195), `MS_ShadyGuyUnhidden` e9 (:212), `StantonAmbush` e9 (:238), `StantonAmbushDefeated` e9 (:263), `MS_Helicopter_Unhidden` e9 (:274).
* **Flags read** (25): `SandraWentToCalifornia`, `FordSchickRescued`, `JoeGreene_Dead`, `MS_GreeneGoalSet`, `MS_UnhideTroop1`, `MS_UnhideTroop2`, `MS_UnhideTroop3`, `MS_UnhideTroop4`, `MS_UnhideTroop5`, `MS_UnhideTroop6`, `MS_ThomasUnhidden`, `HarleyFilben_Dead`, `MS_StantonUnhidden`, `M08MeetHarleyFilben_Played`, `MeetThomasDieter_Played`, `MS_ShadyGuyUnhidden`, `GreenKnowsAboutDowd`, `JoeGreen_Dead`, `SheaKnowsAboutDowd`, `StantonAmbush`, `MJ12Converging`, `StantonAmbushDefeated`, `StantonDowd_Played`, `DL_Exit_Played`, `MS_Helicopter_Unhidden`.
* **InfoLinks it starts**: none. **Conversations it starts by name**: none. **Goals it completes**: `KillGreene` (:80).
* **Spawns**: none. **Destroy calls**: 2; **EnterWorld/LeaveWorld calls**: 13. **Travel calls**: none.

### 08.3 Conversations and InfoLinks

50 conversations of the list besides the shared barks: 9 InfoLinks, 15 talk-type, 26 overheard. 6 have choices (the smuggler's shop `M08SmugglerConvos`, `Doctor1Barter`,
`M08JordanSheaConvos`, `M08MeetSailor`, `M08MeetJoeGreen`, `M08JockExit`), 11 set flags, 21 need a flag, 6 add or complete goals.

**Choices.** Every choice that changes state, the block its speech jumps to and what that block does (choices that change no state are counted in one row per conversation):

| Conversation | Owner | Choice | Effects of the branch |
| --- | --- | --- | --- |
| `Doctor1Barter` | Doctor1 | I'll take a medkit. [needs CanAffordMedkit, CanAffordBots] | -> Medkit: give MedKit |
| `Doctor1Barter` | Doctor1 | All I can afford is a medkit. [needs !CanAffordBots, CanAffordMedkit] | -> Medkit: give MedKit |
| `Doctor1Barter` | Doctor1 | I want the full program. [needs CanAffordBots] | -> Full: set BoughtClinicPlan |
| `Doctor1Barter` | Doctor1 | Sure. | -> Medkit: give MedKit |
| `Doctor1Barter` | Doctor1 | (2 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `M08SmugglerConvos` | Smuggler | I'll give you 7500 for the assault shotgun. [needs !M08BoughtShotgun, M08CanBuyShotgun] | -> BuyShotgun: set M08BoughtShotgun, give WeaponAssaultShotgun, trig BotToNeutral |
| `M08SmugglerConvos` | Smuggler | How about some Sabot rounds for 750. [needs !M08BoughtSabot, M08CanBuySabot] | -> BuySabot: set M08BoughtSabot, give AmmoSabot, trig BotToNeutral |
| `M08SmugglerConvos` | Smuggler | I'll take the five LAMs for 3500. [needs !M08BoughtLAMs, M08CanBuyLams] | -> BuyLAMs: set M08BoughtLAMs, give WeaponLAM, trig BotToNeutral |
| `M08SmugglerConvos` | Smuggler | Never mind. | -> bye: trig BotToNeutral |
| `M08SmugglerConvos` | Smuggler | I'll take the GEP ammo for 2500. [needs !M08BoughtGEP, M08CanBuyGEP] | -> BuyGEP: set M08BoughtGEP, give AmmoRocket, done GetExplosives, trig BotToNeutral |
| `M08SmugglerConvos` | Smuggler | 2500 for GEP ammo sounds great, but I don't have that much. [needs !M08BoughtGEP, !M08CanBuyGEP] | -> PrematureOffer2: trig BotToNeutral |
| `M08SmugglerConvos` | Smuggler | Give me the LAMs for 2400. What a deal. [needs !M08BoughtLAMs2, M08CanBuyLams2] | -> BuyLAMS2: set M08BoughtLAMs2, give WeaponLAM, done GetExplosives, trig BotToNeutral |
| `M08SmugglerConvos` | Smuggler | Wish I had a 2400 credits. I could use a half-dozen LAMs. [needs !M08BoughtLAMs2, !M08CanBuyLams2] | -> PrematureOffer2: trig BotToNeutral |
| `M08SmugglerConvos` | Smuggler | Give me a break. Hundreds of millions of lives are at stake. | -> AskForMoney2: trig BotToNeutral |
| `M08SmugglerConvos` | Smuggler | Forget it. | -> bye2: trig BotToNeutral |
| `M08SmugglerConvos` | Smuggler | Relax. No one followed me. | -> NoWarning: trig BotToNeutral |
| `M08SmugglerConvos` | Smuggler | Actually, UNATCO's planning an operation of some kind. You might want  | -> GiveWarning: set M08WarnedSmuggler, trig BotToNeutral |
| `M08SmugglerConvos` | Smuggler | (4 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `M08MeetSailor` | Sailor | I would, too. Maybe I'll check it out for you. | -> GetPass: set HelpSailor |
| `M08MeetSailor` | Sailor | (1 further choice that change no state: refusals, "never mind", unaffordable offers) | - |
| `M08JordanSheaConvos` | JordanShea | Give me something to drink. [needs HasEnoughMoney] | -> BuyDrink: give Liquor40oz |
| `M08JordanSheaConvos` | JordanShea | I'll have one of those candy bars. [needs HasEnoughMoney] | -> BuyCandybar: give Candybar |
| `M08JordanSheaConvos` | JordanShea | Heard the name Stanton Dowd? [needs !SheaKnowsAboutDowd] | -> TellAboutDowd: set SheaKnowsAboutDowd |
| `M08JordanSheaConvos` | JordanShea | (2 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `M08MeetJoeGreen` | JoeGreene | Could be. Hey -- you're a reporter. Heard the name Stanton Dowd? | -> TellsAboutDowd: set GreenKnowsAboutDowd |
| `M08MeetJoeGreen` | JoeGreene | You aren't a reporter at all. You work for UNATCO. | -> Threaten: trig JoeAttacks |
| `M08MeetJoeGreen` | JoeGreene | (2 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `M08JockExit` | Jock | I'm ready. | -> Go: trig TriggerExit |
| `M08JockExit` | Jock | I'll raid the armory at the shipyard. Let's go. | -> Go: trig TriggerExit |
| `M08JockExit` | Jock | (2 further choices that change no state: refusals, "never mind", unaffordable offers) | - |

**Conversations that change state** (choices, flags set, goals, items, events, skill points; the `Needs` column is kept on these rows):

| Conversation | Owner (BindName; maps with that actor) | Kind | Choices | Sets | Needs | Goals | Other |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `Doctor1Barter` | Doctor1 (other missions) | talk bump/frob | 6 | CanAffordBots=0@Continue, CanAffordMedkit@Continue, BoughtClinicPlan@Full, CanAffordBots@AffordBots | ? BoughtClinicPlan, ? !Doctor1Barter_Played | +note | give MedKit, cr -2300 |
| `DL_JockShipWarning` | JCDenton | DL once |  |  |  | +P GetBackToRoof |  |
| `DL_Exit` | JCDenton | DL once |  | MJ12Converging |  |  |  |
| `DL_Entry` | JCDenton | DL once |  |  |  | +P FindHarleyFilben |  |
| `StantonDowdBarks` | StantonDowd (NYC_Street) | ovh bump/frob/radius 200 |  | M08DowdReachedEnd@A12 | req !StantonAmbush, req StantonDowd_Played, ? M08DowdReachedEnd |  |  |
| `StantonDowd` | StantonDowd (NYC_Street) | talk bump/frob once |  | KnowsSmugglerPassword@Password, PlayerHasExplosives@PlayerHasExplosives | ? M08MeetSailor_Played, ? !KnowsSmugglerPassword | done MeetStantonDowd, +S GetAmbrosia, +S GetExplosives, +P ScuttleShip, +note | give Image09_NYC_Ship_Bottom, give Image09_NYC_Ship_Top, has? WeaponLAW, has? WeaponGEPGun, has? AmmoRocket, has? AmmoRocketWP, has? WeaponLAM, sp 900 |
| `SmugglerDoorBellConvo` | SmugglerDoorBell (NYC_Street) | talk frob |  | SmugglerDoorDone@KnowsPassword | ? KnowsSmugglerPassword, ? SmugglerDoorBellConvo_Played |  | trig SmugglersFrontDoor |
| `M08SmugglerConvos` | Smuggler (NYC_Smug) | talk bump/frob | 16 | M08BoughtBefore@BuyDescription, M08CanBuyLams=0@SkipDescription, M08CanBuySabot=0@SkipDescription, M08CanBuyShotgun=0@SkipDescription, M08BoughtAll@BoughtAll, M08BoughtShotgun@BuyShotgun, M08BoughtSabot@BuySabot (+17 more) | req !M08BoughtAll, req !StantonDowd_Played, ? M08SmugglerConvos_Played, ? StantonDowd_Played, ? !ExplosivePickup_Played, ? !M08SmugglerConvos_Played, ? !MetSmuggler, ? !StantonDowd_Played, ? ExplosivePickup_Played (+10 more) | done GetExplosives | trig BotToNeutral, give WeaponAssaultShotgun, give AmmoSabot, give WeaponLAM*6, give AmmoRocket, sp 50, cr -16650 |
| `M08MeetSandra` | SandraRenton (NYC_Bar) | talk bump/frob once |  | PlayerKnowsSandraRenton@common2 | ? !PlayerKnowsSandraRenton, ? JordanShea_Dead |  |  |
| `M08MeetSailor` | Sailor (NYC_Bar) | talk bump/frob once | 2 | HelpSailor@GetPass | ? SandraWentToCalifornia, ? SandraRenton_Dead | +note | sp 100 |
| `M08JordanSheaConvos` | JordanShea (NYC_Bar) | talk bump/frob/radius 70 | 5 | HasEnoughMoney=0, SheaKnowsAboutDowd@TellAboutDowd, HasEnoughMoney@Enough | ? !HasEnoughMoney, ? SheaKnowsAboutDowd |  | give Liquor40oz, give Candybar, cr -30 |
| `M08MeetJoeGreen` | JoeGreene (NYC_FreeClinic) | talk bump/frob once | 4 | GreenKnowsAboutDowd@TellsAboutDowd, AccusedJoeGreen@Spy, PlayerKnowsJoeGreen@FirstMeeting, PokerHack@FirstMeeting, AccusedJoeGreen@Spy2 | ? !PlayerKnowsJoeGreen, ? M08MeetHarleyFilben_Played, ? StantonDowd_Played, ? M08MeetJoeGreen_Played, ? Spy2Hack, ? PokerHack |  | trig JoeAttacks |
| `M08JockExit` | Jock (NYC_Street) | talk bump/frob/radius 250 | 4 |  | req StantonDowd_Played, ? ExplosivePickup_Played | done GetExplosives, done GetBackToRoof | trig TriggerExit, has? WeaponLAM, sp 100 |
| `M08MeetHarleyFilben` | HarleyFilben (NYC_Bar) | talk bump/frob once |  | PlayerMetFilben@FirstMeeting, FilbenDeadComment@Hop | ? !PlayerMetFilben, ? JoeGreene_Dead | done FindHarleyFilben, +P MeetStantonDowd, +S KillGreene | give Image08_JoeGreenMIBMJ12, sp 100 |
| `M08MeetFordSchick` | FordSchick (NYC_Smug) | talk bump/frob once |  |  |  |  | give AugmentationUpgrade |

Conversations that only wait for a flag or check one, and change no state (18; `?` = a `CheckFlag` event): `DL_GuntherThreat` (StantonDowd_Played), `StantonAmbushHappening` (StantonAmbush (+1 more)), `StantonAmbushDone` (StantonAmbush, StantonAmbushDefeated), `SmugglerDone` (M08BoughtAll2), `M08SmugglerSecondBuy` (StantonDowd_Played, !M08BoughtAll2), `M08SmugglerCleanedOut` (!StantonDowd_Played, M08BoughtAll), `M08SandraBarks` (M08MeetSandra2_Played), `M08MeetSandra2` (M08MeetSandra_Played, ? M08MeetSailor_Played), `SailorBarks` (M08MeetSailor_Played (+2 more)), `M08GreenFinalBarks` (AccusedJoeGreen), `M08GreenBarks1` (M08MeetJoeGreen_Played (+2 more)), `AccuseJoeGreen` (M08MeetJoeGreen_Played, !AccusedJoeGreen, M08MeetHarleyFilben_Played), `M08JockWaiting` (!M08MeetHarleyFilben_Played), `M08JockMiddle0` (!StantonDowd_Played (+1 more)), `M08FlibenBarks2` (M08MeetHarleyFilben_Played (+1 more)), `M08FlibenBarks` (M08MeetHarleyFilben_Played (+3 more)), `FilbenCongrats` (M08MeetHarleyFilben_Played, JoeGreene_Dead, !FilbenDeadComment), `M08SchickBarks` (M08MeetFordSchick_Played).

Plain InfoLinks, no flag and no event: 5 (listed with their starters in the InfoLink table).

Plain conversations with an actor (0): none.

Plain overheard conversations (12): Nurse2: Nurse2Barks; Nurse1: Nurse1Barks; ClinicSecretary: ClinicSecretaryBarks; ShadyGuy: ShadyGuyBarks; M08Nurse: NurseBarks; HotelBum: HotelBumBarks; ClinicBum2: ClinicBum2Barks; ClinicBum1: ClinicBum1Overhead ClinicBum1Barks; AlleyBum2: AlleyBum2Barks2 AlleyBum2Barks; AlleyBum1: AlleyBum1Barks.

InfoLinks and what starts them:

| InfoLink | Started by | Needs | Sets / does |
| --- | --- | --- | --- |
| `DL_SmugglerHome` | NYC_Smug/DataLinkTrigger3 (-6,-1211), NYC_Smug/DataLinkTrigger5 (-1045,-766) |  |  |
| `DL_JockShipWarning` | NYC_Smug/DataLinkTrigger8 (-129,1179) needs StantonDowd_Played |  | +goal GetBackToRoof |
| `DL_GuntherThreat` | NYC_Street/DataLinkTrigger1 (2682,-864) needs StantonDowd_Played | StantonDowd_Played |  |
| `DL_Exit` | NYC_Street/DataLinkTrigger10 (2377,-1274) needs M08SmugglerConvos_Played, NYC_Street/DataLinkTrigger4 (166,2182) needs PlayerHasExplosives |  | set MJ12Converging |
| `DL_EntryDaedalus` | NYC_Street/DataLinkTrigger15 (-1645,206) |  |  |
| `DL_Entry` | NYC_Street/DataLinkTrigger0 (-617,407), NYC_Street/DataLinkTrigger3 (682,891) |  | +goal FindHarleyFilben |
| `DL_DangerUnderground` | (none found) |  |  |
| `DL_DangerOnStreets` | NYC_Street/DataLinkTrigger2 (-509,258) |  |  |
| `DL_DaedalusEnd` | NYC_Street/DataLinkTrigger14 (-347,196) needs DL_JockShipWarning_Played |  |  |

**Required (progression) conversations**, from `inventory-campaign.mjs chain 08_NYC_Street CameraExit`: `M08JockExit` (Jock, bump/frob/radius 250; "I'm ready." or "I'll raid the armory at the shipyard. Let's go." fire `TriggerExit`) needs `StantonDowd_Played`. `StantonDowd` has no flag requirement
but the pawn is hidden until `Mission08.Timer` sees `M08MeetHarleyFilben_Played` or `MeetThomasDieter_Played` (Thomas Dieter replaces a dead Filben); `M08MeetHarleyFilben` (the bar) has none. `DL_Exit` (needs `M08SmugglerConvos_Played`, or `PlayerHasExplosives` from `StantonDowd`)
sets `MJ12Converging` and, with `StantonDowd_Played`, brings the helicopter in. `M08SmugglerConvos` (explosives: `GEP` ammo or LAMs complete `GetExplosives`) is not required by a flag on the exit but `DL_Exit`'s first trigger needs it.

### 08.4 Objectives

| Goal | Kind | Text | Added by | Completed by |
| --- | --- | --- | --- | --- |
| `GetBackToRoof` | primary | Once you obtain items from Smuggler, get back to the hotel roof and take the helicopter to Brooklyn Naval Shipyard. | DL_JockShipWarning | M08JockExit |
| `FindHarleyFilben` | primary | Get to the Underworld Tavern and meet with Harley Filben. | DL_Entry | M08MeetHarleyFilben |
| `MeetStantonDowd` | primary | Meet Stanton Dowd at the Osgood & Son's storefront, near the tunnels leading to the warehouse district. | M08MeetHarleyFilben | StantonDowd |
| `GetAmbrosia` | secondary | Bring Stanton Dowd some Ambrosia to counteract the Gray Death. | StantonDowd | - |
| `GetExplosives` | secondary | See the Smuggler for explosives for scuttling the superfreighter. | StantonDowd | M08SmugglerConvos, M08JockExit |
| `ScuttleShip` | primary | Scuttle the PCS Wall Cloud by destroying the 5 tri-hull welds with explosives and by reversing the bilge-pump flow. Pumping water into the bilges will | StantonDowd | - |
| `KillGreene` | secondary | Kill the traitor, Joe Greene in the Free Clinic | M08MeetHarleyFilben | Mission08.Timer:80 |
| `GetToRoof` | carried |  | - | 08_NYC_Street/GoalCompleteTrigger0 |

### 08.5 Choices with lasting consequences

Set here, alive in a later mission:

| Flag | Set here by | Expires | Read later by |
| --- | --- | --- | --- |
| `GreenKnowsAboutDowd` | conversation M08MeetJoeGreen@TellsAboutDowd | never | M9 script Mission09.Timer:170 |
| `HelpSailor` | conversation M08MeetSailor@GetPass | never | M9 checks in MeetFrontGuard; M9 checks in FrontGuardBarks; M9 checks in DoorGuardBarks; M9 needed by CafWorker1Help; M9 needed by CafWorker1Barks2; ... |
| `M08WarnedSmuggler` | conversation M08SmugglerConvos@GiveWarning | never | M9 checks in DL_BadNews |

Read here, set earlier:

| Flag | Set earlier by | Read here by |
| --- | --- | --- |
| `FordSchickRescued` | M2 script Mission02.PreTravel:122 | script Mission08.FirstFrame:28 |
| `SandraWentToCalifornia` | M4 conversation SandraAttackedByJoJoThanks; M4 conversation FamilySquabbleWrapUpGilbertDead; M4 conversation FamilySquabbleWrapUp@Hop | checks in M08MeetSailor; script Mission08.FirstFrame:19 |

* **Joe Greene** (`M08MeetJoeGreen`, the Free Clinic): "Heard the name Stanton Dowd?" sets `GreenKnowsAboutDowd` (read in mission 9 by `Mission09.Timer:170`); "You aren't a reporter at all..." fires `JoeAttacks`; his death (`JoeGreene_Dead`, permanent; mission 2's and 4's too) completes `KillGreene`.
* **The sailor** (`M08MeetSailor`): "Maybe I'll check it out for you." sets `HelpSailor`, which mission 9's shipyard guards, cafeteria worker and two `FlagTrigger`s (`09_NYC_Dockyard/FlagTrigger0` fires `ChangeAlliances`, `09_NYC_Ship/FlagTrigger0` fires `Welcome`) read: the sailor's help changes how the shipyard receives the player.
* **The smuggler** (`M08SmugglerConvos`): "UNATCO's planning an operation..." sets `M08WarnedSmuggler`, read in mission 9 by `DL_BadNews`.
* Filben's and Greene's deaths from mission 4 change who is in the bar (`HarleyFilben_Dead` reads here: `Mission08.uc:175`).

### 08.6 Progression path

1. Arrival at `PlayerStart0`; `DL_Entry` adds `FindHarleyFilben` (two `DataLinkTrigger`s).
2. Bar: `M08MeetHarleyFilben` (or, if Filben is dead, `MeetThomasDieter` once the janitor enters); `Mission08.Timer` unhides `StantonDowd`.
3. `StantonDowd` at the Osgood & Son's storefront (near the sewer tunnels): `GetExplosives`, `ScuttleShip`, `GetAmbrosia` added.
4. Smuggler's lair (password `KnowsSmugglerPassword` from `StantonDowd`): `M08SmugglerConvos` (optional shop; `DL_JockShipWarning` adds `GetBackToRoof` after `StantonDowd_Played`). `DL_Exit` plays.
5. Back to Jock (the goal text says the hotel roof; `GetToRoof` is completed by a `GoalCompleteTrigger` in the Street): `M08JockExit` -> `TriggerExit` -> `Dispatcher0` -> `CameraExit` -> `MapExit0` -> `09_NYC_Dockyard`.

| Map | Tag (movers) | Lock | Opened by |
| --- | --- | --- | --- |
| `08_NYC_Hotel` | `SecretRoom` (2) | unlocked, pick 0.20, not frobbable | Keypad1 Keypad0, Switch1 Switch0 |
| `08_NYC_Smug` | `elevatorbutton` (1) | unlocked, pick 0.20, not frobbable | Switch1 Switch4, Switch1 Switch5, Switch1 Switch6 |
| `08_NYC_Smug` | `mirrordoor` (1) | locked, not frobbable | Keypad3 Keypad1 |
| `08_NYC_Smug` | `botordertrigger` (1) | unlocked, pick 0.20, not frobbable | BeamTrigger BeamTrigger0, BeamTrigger BeamTrigger1, BeamTrigger BeamTrigger2, Switch2 Switch0 |
| `08_NYC_Street` | `elevatorbutton` (1) | unlocked, pick 0.20, not frobbable | Switch1 Switch2, Switch1 Switch3, Switch1 Switch7 |
| `08_NYC_Street` | `SmugglersFrontDoor` (1) | unlocked, not frobbable | Button1 Button0, conversation SmugglerDoorBellConvo[KnowsPassword] |
| `08_NYC_Underground` | `SewerHatch` (1) | unlocked, not frobbable | Keypad1 Keypad2, Switch2 Switch1 |
| `08_NYC_Underground` | `DoorA` (1) | unlocked, not frobbable | Keypad1 Keypad11, Switch2 Switch0 |

Key doors (a placed `NanoKey` opens them, or the lock is picked; frob only): `CrackRoom`.

(1 further movers of these maps are locked with a pickable lock or breakable, take no key that exists as a placed `NanoKey` and are fired by no event: not listed.)

**Progression blocker (mission 8).** `StantonDowd` not entering (neither `M08MeetHarleyFilben_Played` nor `MeetThomasDieter_Played`); `StantonDowd_Played` not set; `M08JockExit` not reaching its `Go` branch; `TriggerExit`/`CameraExit` not firing; `MapExit0` not loading mission 9.
The MJ12 ambush, Joe Greene and the explosives are not blockers.

### 08.7 Slots

| Slot | Map | Saved as | Saves, play time | Important NPCs dead or knocked out (all) | Lasting-choice flags in the file (all) | Goals still open |
| --- | --- | --- | --- | --- | --- | --- |
| N0020 | `08_NYC_Street` | NYC - Hell's Kitchen | 342, 609 min | AnnaNavarre, DrugDealer, GilbertTerrorist, JoJoFine, JosephManderley, JuanLebedev, MaggieChow, MJ12Commando, PrivateLloyd, Supervisor01, Terrorist | AmbrosiaTagged, BathroomBarks_Played, FilbenGaveKey, GuntherFreed, GuntherRespectsPlayer=0, HeardGrenadeTalk, JacobsonRecruited, JaimeRecruited, KnowsAboutKillphrase, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, M04MetWalton, MeetJoeGreen_Played, PlayerMetFilben, SandraWentToCalifornia | - |

N0020 is the Street at the start of the mission (`GetToRoof` carried; the flag list shows the earlier missions' choices, Anna, Manderley, Lloyd, Maggie Chow, the supervisor and the commandos already dead). Every later step of the chain has to be reached.

## Mission 09: the Brooklyn Naval Shipyard (NYC)

Five maps: the dockyard, the Naval Assembly building and ship, its lower decks (`ShipBelow`), the air-conditioning duct (`ShipFan`) and the graveyard. The player is flown in, gets past the shipyard guards (the sailor from mission 8 helps), scuttles the PCS Wall Cloud
(five hull welds and the bilge pumps), and is flown to the graveyard where Stanton Dowd's device and the EM disruption field decide whether Jock can come back for him. It has few conversations for its size (more than half of them InfoLinks) and a mid-mission
`MapExit` ride (dockyard -> graveyard).

### 09.1 Maps and arrival

| Map | Actors | Level info (`MapName`; `MissionLocation`) | Startup text | Script | Arrives from | Leaves to |
| --- | --- | --- | --- | --- | --- | --- |
| `09_NYC_Dockyard` | 2767 | 09_NYC_Dockyard; NYC - Brooklyn Naval Shipyards | New York City, Brooklyn Naval Shipyards / Submarine Warfare Division  | Mission09 | 08_NYC_Street (path CameraPath); 09_NYC_Ship#ExitShip/ToDockyardSewer x2; 09_NYC_ShipFan#FromAircondDuct | 09_NYC_Graveyard (path CameraPath); 09_NYC_Ship#FromDockyardSewer/EnterShip x2; 09_NYC_ShipFan#ToAircondDuct |
| `09_NYC_Graveyard` | 1008 | 09_NYC_Graveyard; NYC - Lower East Side Cemetary | New York City, Lower East Side Cemetary | Mission09 | 09_NYC_Dockyard (path CameraPath) | 10_Paris_Catacombs (path CameraPath) |
| `09_NYC_Ship` | 2287 | 09_NYC_Ship; NYC - Naval Assembly Building and Ship | - | Mission09 | 09_NYC_Dockyard#FromDockyardSewer/EnterShip x2; 09_NYC_ShipBelow#FromBelow; 09_NYC_ShipFan#FromFanRoom/FromDuctRoom x2 | 09_NYC_Dockyard#ExitShip/ToDockyardSewer x2; 09_NYC_ShipFan#ToFanRoom/ToDuctRoom x2; 09_NYC_ShipBelow#FromAbove |
| `09_NYC_ShipBelow` | 2137 | 09_NYC_ShipBelow; NYC - Ship Lower Decks | - | Mission09 | 09_NYC_Ship#FromAbove | 09_NYC_Ship#FromBelow |
| `09_NYC_ShipFan` | 294 | 09_NYC_ShipFan; NYC - Naval Assembly Building AC System | - | Mission09 | 09_NYC_Dockyard#ToAircondDuct; 09_NYC_Ship#ToFanRoom/ToDuctRoom x2 | 09_NYC_Ship#FromFanRoom/FromDuctRoom x2; 09_NYC_Dockyard#FromAircondDuct |

* **Arrival.** `08_NYC_Street` `MapExit0` (camera `CameraPath`, tag `CameraExit`) -> `09_NYC_Dockyard`: `PlayerStart0` (3317,1396,40). Mission change 8 -> 9, `Save\Current` wiped, `DeleteExpiredFlags(9)`.
* **Inside.** Dockyard <-> Ship (`EnterShip`/`ExitShip`, sewer `FromDockyardSewer`/`ToDockyardSewer`), Ship <-> ShipBelow (`FromAbove`/`FromBelow`), Ship <-> ShipFan (fan and duct rooms), Dockyard -> ShipFan (`ToAircondDuct`). Dockyard `MapExit0` (tag `ToGraveyard`, camera `CameraPath`) -> `09_NYC_Graveyard`.
* **Leaving.** `09_NYC_Graveyard` `MapExit0` (camera `CameraPath`, tag `CopterCam`) -> `10_Paris_Catacombs`, fired by `Dispatcher1` (`OutEvents[1]` = `ChopperExit`), which `M09JockLeave` triggers on its `Go` branch.

| Map | Actor | At | Leads to | Fired by (events targeting its tag) |
| --- | --- | --- | --- | --- |
| `09_NYC_Dockyard` | MapExit `MapExit0` | 3157,6667,1413 | `09_NYC_Graveyard` (path `CameraPath`) | tag `ToGraveyard`: BlackHelicopter BlackHelicopter0 |
| `09_NYC_Graveyard` | MapExit `MapExit0` | 1084,-236,96 | `10_Paris_Catacombs` (path `CameraPath`) | tag `CopterCam`: Dispatcher Dispatcher1 |

**09_NYC_Dockyard MapExit0 -> 09_NYC_Graveyard** (tag `ToGraveyard`)

```text
event ToGraveyard
  BlackHelicopter BlackHelicopter0 (Event)
```

**09_NYC_Graveyard MapExit0 -> 10_Paris_Catacombs** (tag `CopterCam`)

```text
event CopterCam
  Dispatcher Dispatcher1 (OutEvents[1]) tag ChopperExit
    event ChopperExit
      conversation event Trigger "ChopperExit" in M09JockLeave branch Go
        conversation M09JockLeave [talk bump/frob/radius 240; owner Jock]
          starts: its actor (bump/frob/radius 240)
```

### 09.2 Mission script `Mission09`

`.cache/research/src/DeusEx/Mission09.uc`, 271 lines; `ShipExplosionEffects` is the ship's collapse effect.

* `FirstFrame` (`:12-46`): ship: `ShipBreech` (**read here and set nowhere**: the block never runs; `DL_BuildingEntryAir`'s trigger reads it too) would lock the `SewerGrate`/`FrontDoor` movers; dockyard: `MS_ShipBreeched` (the flag the `Timer` sets, a return visit) -> the `BlackHelicopter` tagged `BlackHelicopter` enters.
* `PreTravel` (`:54-57`): `Super` only. No `SendPlayer`/`ClientTravel`.
* `Timer` (`:65-180`): ship: `SummonSimons` -> Walton enters (`MS_SimonsAppeared`, expiration 10), `M09SimonsDisappears` -> he leaves and the three flags are cleared; with `MS_ShipBreeched`, `ShipExplosionEffects(False)` every tick (random shakes, sounds, view roll, velocity kicks, `Cart`s rolling, `HangingDecoration`s swaying, klaxon in the head zone);
  `ShipBelow`: when no `ShipBreech`-tagged mover is left and `Bilge` is set -> `DL_AllDone` and `MS_ShipBreeched`, with no `Bilge` yet `DL_AllPlaced` (once), then `ShipExplosionEffects(True)` (metal fragments); graveyard: `deviceDestroyed` and `M09MeetStantonDowd_Played` -> the helicopter enters, `DL_ComingIn`, `TroopSupport` enters
  (`MS_UnhideHelicopter`, expiration 10); after `M09MeetStantonDowd_Played` the `TunnelTrigger`s are armed and `TroopInsertion` enters (`MS_TriggerOn`); `GreenKnowsAboutDowd` and `suprisePoint` (**set nowhere**) -> the `paratroop` commandos (`MS_UnhideCommandos`).
* Flags it sets: all with expiration 10 (alive through mission 9). None outlives the mission.
* Actors it touches: `DeusExMover` by tag, `BlackHelicopter`, `WaltonSimons`, `MJ12Troop`, `MJ12Commando`, `Trigger TunnelTrigger`, `HangingDecoration`, `Cart`, `MetalFragment`, the player's view and velocity.

Generated from the script's calls (`inventory-campaign.mjs scripts`; `:N` is the first line):

* **Flags set** (7; `eN` = explicit expiration N, otherwise the default): `MS_SimonsAppeared` e10 (:86), `M09SimonsDisappears` e10 (:96), `SummonSimons` e10 (:98), `MS_ShipBreeched` e10 (:121), `MS_UnhideHelicopter` e10 (:151), `MS_TriggerOn` e10 (:166), `MS_UnhideCommandos` e10 (:177).
* **Flags read** (14): `ShipBreech`, `MS_ShipBreeched`, `MS_SimonsAppeared`, `SummonSimons`, `M09SimonsDisappears`, `Bilge`, `DL_AllPlaced_Played`, `MS_UnhideHelicopter`, `deviceDestroyed`, `M09MeetStantonDowd_Played`, `MS_TriggerOn`, `GreenKnowsAboutDowd`, `suprisePoint`, `MS_UnhideCommandos`.
* **InfoLinks it starts**: `DL_AllDone` (:120), `DL_AllPlaced` (:125), `DL_ComingIn` (:146). **Conversations it starts by name**: none. **Goals it completes**: none.
* **Spawns**: `MetalFragment` (:248). **Destroy calls**: 0; **EnterWorld/LeaveWorld calls**: 7. **Travel calls**: none.

### 09.3 Conversations and InfoLinks

58 conversations of the list besides the shared barks: 27 InfoLinks (the largest share of any list: the mission is told by the DataLink), 6 talk-type, 25 overheard. 1 has choices (`M09JockLeave`: "Let's go." / "Wait here while I look around."),
4 set flags, 23 need a flag, 12 add or complete goals.

**Choices.** Every choice that changes state, the block its speech jumps to and what that block does (choices that change no state are counted in one row per conversation):

| Conversation | Owner | Choice | Effects of the branch |
| --- | --- | --- | --- |
| `M09JockLeave` | Jock | Let's go. | -> Go: trig ChopperExit |
| `M09JockLeave` | Jock | (1 further choice that change no state: refusals, "never mind", unaffordable offers) | - |

**Conversations that change state** (choices, flags set, goals, items, events, skill points; the `Needs` column is kept on these rows):

| Conversation | Owner (BindName; maps with that actor) | Kind | Choices | Sets | Needs | Goals | Other |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `DL_VentOpening` | JCDenton | DL once |  |  | req !MS_ShipBreeched | +P GetOntoShip |  |
| `DL_ShipView` | JCDenton | DL once |  |  | req !MS_ShipBreeched | +P GetOntoShip |  |
| `DL_ShipExit` | JCDenton | DL once |  |  |  | +P Escape |  |
| `DL_ShipEntry` | JCDenton | DL once |  |  | req !MS_ShipBreeched | +P GetBelowDecks, done GetOntoShip |  |
| `DL_Problem` | JCDenton | DL once |  |  |  | +P EliminateField |  |
| `DL_JockDropOff` | JCDenton | DL once |  |  |  |  | trig CopterLeaves |
| `DL_Insertion` | JCDenton | DL once |  |  |  | done GetToDockyard, +P GetIntoSubPen, +S GetAmmo |  |
| `DL_Entry` | JCDenton | DL once |  |  |  | +P TalkToDowd | trig JockLeaves |
| `DL_ComingIn` | JCDenton | DL once |  |  |  | done EliminateField |  |
| `DL_BuildingEntrySewer` | JCDenton | DL once |  |  | req !MS_ShipBreeched | +P GetOntoShip |  |
| `DL_AllDone` | JCDenton | DL once |  |  |  | done ScuttleShip |  |
| `M09MeetStantonDowd` | StantonDowd (NYC_Graveyard) | talk bump/frob once |  | GaveDowdAmbrosia@continue | ? Gatekeeper_Dead, ? !GaveDowdAmbrosia | done TalkToDowd, +P FindSilhouette | take VialAmbrosia, give Image10_Paris_Catacombs, has? VialAmbrosia, sp 200 |
| `M09SimonsMessage` | SimonsButton (NYC_Ship) | ovh radius 400 |  | M09SimonsDisappears |  |  | trig HologramSound |
| `Ops1DummyOverheard` | Ops1Dummy (NYC_ShipBelow) | ovh radius 300 |  | OpsA1Played@A1, OpsA2Played@A2, OpsA3Played@A3, OpsB1Played@B1, OpsB2Played@B2, OpsB3Played@B3 | req !Ops1_Dead, req !Ops2_Dead, ? ShipPowerCut, ? OpsA1Played, ? !OpsA3Played, ? OpsA2Played, ? OpsB1Played, ? !OpsB3Played, ? OpsB2Played |  |  |
| `Ops1Overheard` | Ops1 (NYC_ShipBelow) | ovh radius 350 |  | OpsA1Played@A1, OpsA2Played@A2, OpsA3Played@A3, OpsB1Played@B1, OpsB2Played@B2, OpsB3Played@B3 | ? ShipPowerCut, ? OpsA1Played, ? !OpsA3Played, ? OpsA2Played, ? OpsB1Played, ? !OpsB3Played, ? OpsB2Played |  |  |
| `M09JockLeave` | Jock (NYC_Graveyard) | talk bump/frob/radius 240 | 2 |  | ? M03JockLeave_Played |  | trig ChopperExit |
| `RingForService` | GatekeepersCallButton (NYC_Graveyard) | talk frob once |  |  | req !GatekeeperBarks_Played |  | trig CallKeeper |
| `MeetFrontGuard` | FrontGuard (NYC_Dockyard) | talk radius 160 once |  |  | req !MS_ShipBreeched, ? HelpSailor, ? !Sailor_Dead |  | trig GuardsWander, give NanoKey |
| `MeetElectrician` | Electrician (NYC_ShipBelow) | talk bump/frob/radius 100 once |  |  | req !ShipPowerCut, req !MS_ShipBreeched | +S CutPower |  |
| `CafWorker1Help` | CafWorker1 (NYC_Ship) | talk bump/frob/radius 120 once |  |  | req HelpSailor, req !Sailor_Dead | +note |  |

Conversations that only wait for a flag or check one, and change no state (18; `?` = a `CheckFlag` event): `DL_UseCrane` (!MS_ShipBreeched), `DL_SewerEntry` (!MS_ShipBreeched), `DL_OnRoof` (!MS_ShipBreeched), `DL_BuildingEntryMain` (!MS_ShipBreeched), `DL_BuildingEntryAir` (!MS_ShipBreeched), `DL_BadNews` (? M08WarnedSmuggler), `DowdChatting` (M09MeetStantonDowd_Played), `Ops1Bump` (? !ShipPowerCut), `FrontGuardBarks` (MeetFrontGuard_Played (+4 more)), `AfterBreeched` (MS_ShipBreeched), `ElectricianShortCircuit` (ShipPowerCut (+2 more)), `ElectricianFleeing` (MS_ShipBreeched), `ElectricianBarks` (MeetElectrician_Played (+2 more)), `DoorGuardBarks` (? MS_ShipBreeched, ? !HelpSailor (+1 more)), `CafWorker2Barks` (? CafWorker1Help_Played), `CafWorker1FriendlyBarks` (CafWorker1Help_Played), `CafWorker1Barks2` (HelpSailor, Sailor_Dead), `CafWorker1Barks` (!HelpSailor).

Plain InfoLinks, no flag and no event: 10 (listed with their starters in the InfoLink table).

Plain conversations with an actor (0): none.

Plain overheard conversations (10): Ops2: Ops2Bump; Mechanic3: Mechanic3Barks; Mechanic2: Mechanic2Barks; Mechanic1: Mechanic1Overheard Mechanic1Barks; LockerWorker: LockerWorkerBarks; Guard3: Guard3Overheard; Guard1: Guard1Overheard; Gatekeeper: GatekeeperBarks; BarracksSoldier: BarracksSoldierBarks.

InfoLinks and what starts them:

| InfoLink | Started by | Needs | Sets / does |
| --- | --- | --- | --- |
| `DL_WeldPoint` | NYC_ShipBelow/DataLinkTrigger8 (802,-976), NYC_ShipBelow/DataLinkTrigger0 (865,976), NYC_ShipBelow/DataLinkTrigger2 (-6480,230) (+2 more) |  |  |
| `DL_VentOpening` | NYC_Ship/DataLinkTrigger1 (2945,-1394) needs DL_ShipView | !MS_ShipBreeched | +goal GetOntoShip |
| `DL_UseCrane` | NYC_Dockyard/DataLinkTrigger12 (4526,5970) | !MS_ShipBreeched |  |
| `DL_ShipView` | NYC_Ship/DataLinkTrigger8 (2132,-1315), NYC_Ship/DataLinkTrigger9 (1938,-1316), NYC_Ship/DataLinkTrigger10 (1743,-1315) | !MS_ShipBreeched | +goal GetOntoShip |
| `DL_ShipExit` | NYC_Ship/DataLinkTrigger3 (2707,163) needs MS_ShipBreeched |  | +goal Escape |
| `DL_ShipEntry` | NYC_Ship/DataLinkTrigger4 (-2136,1029), NYC_Ship/DataLinkTrigger5 (2972,1042), NYC_Ship/DataLinkTrigger6 (-1839,790), NYC_Ship/DataLinkTrigger2 (2361,-915) (+1 more) | !MS_ShipBreeched | +goal GetBelowDecks, done GetOntoShip |
| `DL_SewerEntry` | NYC_Dockyard/DataLinkTrigger2 (1620,1670) needs !SewerBackwards | !MS_ShipBreeched |  |
| `DL_Scuttled` | NYC_Dockyard/DataLinkTrigger7 (4288,6922) needs MS_ShipBreeched |  |  |
| `DL_Problem` | NYC_Graveyard/DataLinkTrigger3 (-1067,-473) needs !deviceDestroyed |  | +goal EliminateField |
| `DL_OnRoof` | NYC_Dockyard/DataLinkTrigger3 (4290,6917) needs !MS_ShipBreeched | !MS_ShipBreeched |  |
| `DL_MainGate` | NYC_Dockyard/DataLinkTrigger1 (699,1589) |  |  |
| `DL_JockDropOff` | NYC_Dockyard/DataLinkTrigger8 (2904,1211), NYC_Dockyard/DataLinkTrigger10 (3639,1400) |  | trig CopterLeaves |
| `DL_JockCryptWarning` | (none found) |  |  |
| `DL_Insertion` | NYC_Dockyard/DataLinkTrigger0 (2432,1319) |  | done GetToDockyard, +goal GetIntoSubPen, +goal GetAmmo |
| `DL_Entry` | NYC_Graveyard/DataLinkTrigger0 (375,1941), NYC_Graveyard/DataLinkTrigger5 (424,1297) |  | +goal TalkToDowd, trig JockLeaves |
| `DL_Daedalus3` | NYC_ShipBelow/DataLinkTrigger13 (-3293,158) |  |  |
| `DL_Daedalus2` | NYC_Ship/DataLinkTrigger12 (1718,46) |  |  |
| `DL_Daedalus1` | NYC_Dockyard/DataLinkTrigger9 (1658,3860) |  |  |
| `DL_ComingIn` | Mission09.uc:146 |  | done EliminateField |
| `DL_BuildingEntrySewer` | NYC_Ship/DataLinkTrigger7 (-870,-1749) | !MS_ShipBreeched | +goal GetOntoShip |
| `DL_BuildingEntryMain` | NYC_Ship/DataLinkTrigger0 (2175,-1792) | !MS_ShipBreeched |  |
| `DL_BuildingEntryAir` | NYC_ShipFan/DataLinkTrigger0 (88,-389) needs !ShipBreech, NYC_ShipFan/DataLinkTrigger2 (70,479) | !MS_ShipBreeched |  |
| `DL_BilgeOpenHullPointsLeft` | NYC_ShipBelow/DataLinkTrigger16 (-2495,-775) needs !DL_AllPlaced_Played |  |  |
| `DL_Bilge` | NYC_ShipBelow/DataLinkTrigger4 (-2496,-721) |  |  |
| `DL_BadNews` | NYC_Dockyard/DataLinkTrigger4 (3989,3287), NYC_Dockyard/DataLinkTrigger5 (1983,6231), NYC_Dockyard/DataLinkTrigger6 (4093,6920) | M08WarnedSmuggler |  |
| `DL_AllPlaced` | Mission09.uc:125 |  |  |
| `DL_AllDone` | Mission09.uc:120 |  | done ScuttleShip |

**Required (progression) conversations.** The last step is `M09JockLeave` (Jock, bump/frob/radius 240, no flag requirement; "Let's go." fires `ChopperExit`). Upstream, `Mission09.Timer` brings the helicopter in only when `deviceDestroyed` (the graveyard's `FlagTrigger0`, tag `EMOff`)
and `M09MeetStantonDowd_Played` are set; `M09MeetStantonDowd` (the crypt) therefore is required, and `DL_Problem`/`DL_ComingIn` carry `EliminateField`. The mid-mission ride needs the dockyard helicopter, which is unhidden by `MS_ShipBreeched` (`DL_AllDone`, `Bilge` from `ShipBelow`'s `FlagTrigger1`
and all `ShipBreech` movers destroyed); the helicopter's own `Event` `ToGraveyard` fires the dockyard `MapExit0` (what makes the helicopter fire it was not read).

### 09.4 Objectives

| Goal | Kind | Text | Added by | Completed by |
| --- | --- | --- | --- | --- |
| `GetOntoShip` | primary | Get onto ship | DL_VentOpening, DL_ShipView, DL_BuildingEntrySewer | DL_ShipEntry |
| `Escape` | primary | Meet Jock on the roof. At the west end of the dock is a maintenance store to the air conditioning system. Use the ladder inside to get into the ventil | DL_ShipExit | 09_NYC_Dockyard/GoalCompleteTrigger0 |
| `GetBelowDecks` | primary | Find a way to the lower decks. | DL_ShipEntry | 09_NYC_ShipBelow/GoalCompleteTrigger0 |
| `EliminateField` | primary | Disable the EM disruption field that is preventing Jock from landing. The source seems to be a small building just inside the cemetery gate. | DL_Problem | DL_ComingIn |
| `GetToDockyard` | carried |  | - | DL_Insertion |
| `GetIntoSubPen` | primary | Enter Main building on north side of Dockyard. There may be more than one entry point. | DL_Insertion | 09_NYC_Ship/GoalCompleteTrigger3, 09_NYC_Ship/GoalCompleteTrigger4, 09_NYC_Ship/GoalCompleteTrigger5, 09_NYC_Ship/GoalCompleteTrigger6 |
| `GetAmmo` | secondary | Find Ammo Storage warehouse and raid ammo bunkers for more LAMs or Rockets. | DL_Insertion | 09_NYC_Dockyard/GoalCompleteTrigger7 |
| `TalkToDowd` | primary | Meet Stanton Dowd at his family crypt inside the graveyard. | DL_Entry | M09MeetStantonDowd |
| `ScuttleShip` | carried |  | - | DL_AllDone |
| `FindSilhouette` | primary | Take the helicopter to Paris. Make contact with Silhouette in the Paris catacombs. | M09MeetStantonDowd | - |
| `CutPower` | secondary | Cut the power to the transformers that are shorting out and electrifying the overhead walkway. Two control panels must be shut down, one of them under | MeetElectrician | 09_NYC_ShipBelow/GoalCompleteTrigger1 |

### 09.5 Choices with lasting consequences

Set here, alive in a later mission: **none** (the script's flags expire at mission 10; the only permanent flag is `M09SimonsDisappears` and it is toggled inside the mission). Read here, set earlier:

| Flag | Set earlier by | Read here by |
| --- | --- | --- |
| `GreenKnowsAboutDowd` | M8 conversation M08MeetJoeGreen@TellsAboutDowd | script Mission09.Timer:170 |
| `HelpSailor` | M8 conversation M08MeetSailor@GetPass | checks in MeetFrontGuard; checks in FrontGuardBarks; checks in DoorGuardBarks; needed by CafWorker1Help; needed by CafWorker1Barks2; needed by CafWorker1Barks |
| `M08WarnedSmuggler` | M8 conversation M08SmugglerConvos@GiveWarning | checks in DL_BadNews |

* `HelpSailor` (mission 8) is the way into the shipyard: the guards (`MeetFrontGuard`, `FrontGuardBarks`, `DoorGuardBarks`), the cafeteria worker (`CafWorker1*`) and the two `FlagTrigger`s that fire `ChangeAlliances`/`Welcome` read it.
* `GreenKnowsAboutDowd` (mission 8) is read by `Mission09.Timer:170` together with `suprisePoint`, which nothing sets: the `paratroop` commandos therefore never appear in this installation's data (unverified that nothing else sets `suprisePoint`).
* `M08WarnedSmuggler` is read by `DL_BadNews`.
* Pawns here with `bImportant`: `StantonDowd` (graveyard), `Gatekeeper`, `SimonsButton`; the death flags are read in this mission only (`StantonDowd_Dead` is also read in 8).

### 09.6 Progression path

1. Dockyard, `PlayerStart0`. `DL_Entry` adds `TalkToDowd`; `DL_Insertion` adds `GetIntoSubPen`/`GetAmmo` (`GoalCompleteTrigger`s in the Ship complete `GetIntoSubPen`). Past the front guards with `HelpSailor`, or through the sewer / the air-conditioning duct (`DL_VentOpening`, `DL_BuildingEntrySewer`, `DL_BuildingEntryAir`).
2. Ship: `DL_ShipEntry` (completes `GetOntoShip`, adds `GetBelowDecks`); the ShipBelow's `GoalCompleteTrigger0`; `ShipBelow`: destroy the five `ShipBreech` hull-weld movers with explosives and set `Bilge` (the pump trigger `FlagTrigger1`, plus `BilgeValve2`): `DL_AllDone` -> `MS_ShipBreeched`; the ship now shakes and fragments.
3. `DL_ShipExit` adds `Escape`; the dockyard helicopter (unhidden by `MS_ShipBreeched`) takes the player to the graveyard (`ToGraveyard`).
4. Graveyard: meet Stanton Dowd (`M09MeetStantonDowd`, completes `TalkToDowd`, adds `FindSilhouette`); destroy the EM field device (`FlagTrigger0` -> `deviceDestroyed`); `DL_ComingIn` and the helicopter; `M09JockLeave` -> "Let's go." -> `ChopperExit` -> `CopterCam` -> `MapExit0` -> `10_Paris_Catacombs`.

| Map | Tag (movers) | Lock | Opened by |
| --- | --- | --- | --- |
| `09_NYC_Dockyard` | `FrontGate` (1) | locked | frob |
| `09_NYC_Dockyard` | `SecurityDoor` (1) | unlocked, breakable 0.35, not frobbable | Keypad3 Keypad1 |
| `09_NYC_Dockyard` | `Lift` (1) | unlocked, not frobbable | Button1 Button0, Button1 Button1 |
| `09_NYC_Dockyard` | `Crane` (1) | unlocked, not frobbable | Switch2 Switch0 |
| `09_NYC_Dockyard` | `DeusExMover130` (1) | locked, breakable 0.25 | frob |
| `09_NYC_Dockyard` | `BackGate` (1) | unlocked, not frobbable | Keypad3 Keypad0 |
| `09_NYC_Dockyard` | `AmmoStorageDoor` (1) | locked, key WeaponWarehouse, breakable 0.50 | frob |
| `09_NYC_Dockyard` | `DeusExMover138` (1) | locked, breakable 0.50 | frob |
| `09_NYC_Dockyard` | `DrainGrate` (1) | unlocked, pick 0.20, not frobbable | Valve Valve0 |
| `09_NYC_Dockyard` | `BlastDoor1` (3) | unlocked, not frobbable | Button1 Button4 |
| `09_NYC_Dockyard` | `BlastDoor2` (3) | unlocked, not frobbable | Button1 Button5 |
| `09_NYC_Dockyard` | `BlastDoor3` (3) | unlocked, not frobbable | Button1 Button6 |
| `09_NYC_Dockyard` | `DeusExMover29` (1) | locked, key WeaponWarehouse, breakable 1.00 | frob |
| `09_NYC_Dockyard` | `BotDrop` (1) | unlocked, not frobbable | BeamTrigger BeamTrigger0, BeamTrigger BeamTrigger1, BeamTrigger BeamTrigger2, BeamTrigger BeamTrigger3, BeamTrigger BeamTrigger4, BeamTrigger BeamTrigger5 |
| `09_NYC_Dockyard` | `SubPenDoor` (1) | locked, not frobbable | Keypad3 Keypad2, Switch2 Switch1 |
| `09_NYC_Dockyard` | `MilBotStor` (1) | unlocked, not frobbable | Switch2 Switch2, BeamTrigger BeamTrigger6, BeamTrigger BeamTrigger7, BeamTrigger BeamTrigger8 |
| `09_NYC_Graveyard` | `Bookcase` (1) | unlocked, pick 0.20, breakable 0.25, not frobbable | Keypad3 Keypad1 |
| `09_NYC_Graveyard` | `SecretDoor` (1) | unlocked, not frobbable | Trigger Trigger0 |
| `09_NYC_Graveyard` | `MainGate` (1) | unlocked, not frobbable | Button1 Button0, Dispatcher Dispatcher0, FlagTrigger FlagTrigger6 |
| `09_NYC_Ship` | `ShipRamp` (1) | unlocked, not frobbable | Keypad3 Keypad5 |
| `09_NYC_Ship` | `Crane` (1) | unlocked, not frobbable | Button1 Button17 |
| `09_NYC_Ship` | `Eledoor01` (1) | unlocked, pick 0.20 | DirectionalTrigger DirectionalTrigger1, Switch1 Switch0 |
| `09_NYC_Ship` | `eledoor04` (1) | unlocked, pick 0.20 | DirectionalTrigger DirectionalTrigger0 |
| `09_NYC_Ship` | `SewerGrate` (1) | unlocked, not frobbable | script Mission09:25 |
| `09_NYC_Ship` | `ArmoryDoor` (1) | unlocked, pick 0.20, breakable 0.50, not frobbable | Keypad2 Keypad0 |
| `09_NYC_Ship` | `SecDoor2` (1) | unlocked, breakable 35.00, not frobbable | Keypad3 Keypad1, Button1 Button4, Trigger Trigger0 |
| `09_NYC_Ship` | `SecDoor1` (1) | unlocked, pick 0.20, breakable 35.00, not frobbable | Keypad3 Keypad2, Button1 Button3, Trigger Trigger1 |
| `09_NYC_Ship` | `CaptDoor` (1) | unlocked, pick 0.20, breakable 35.00, not frobbable | Keypad3 Keypad3, Button1 Button2 |
| `09_NYC_Ship` | `DeusExMover7` (1) | locked, key EngineRoomDoor | frob |
| `09_NYC_Ship` | `OpsDoor` (1) | unlocked, breakable 35.00, not frobbable | Keypad3 Keypad4, Button1 Button5 |
| `09_NYC_Ship` | `FrontDoor` (1) | locked, pick 0.20 | Dispatcher Dispatcher0, script Mission09:25 |
| `09_NYC_Ship` | `SubPenDoor` (1) | locked, breakable 0.25, not frobbable | (nothing found) |
| `09_NYC_ShipBelow` | `Bridge` (1) | unlocked, not frobbable | Keypad2 Keypad0 |
| `09_NYC_ShipBelow` | `EngineeringDoor` (1) | unlocked, not frobbable | Keypad3 Keypad1 |
| `09_NYC_ShipBelow` | `SpiderBotDoor` (1) | unlocked, not frobbable | BeamTrigger BeamTrigger0 |
| `09_NYC_ShipBelow` | `Pistons` (4) | unlocked, not frobbable | LightSwitch LightSwitch0 |
| `09_NYC_ShipBelow` | `ShipBreech` (5) | unlocked, breakable 0.90, not frobbable | script Mission09:21, script Mission09:112 |
| `09_NYC_ShipBelow` | `LowBayDoor` (1) | unlocked, not frobbable | Keypad3 Keypad3, Keypad3 Keypad4 |
| `09_NYC_ShipBelow` | `DeckDoor` (1) | locked | Keypad3 Keypad2, Switch1 Switch2 |
| `09_NYC_ShipBelow` | `OpsDoor` (1) | locked, key HeliBayDoorLock, pick 0.80 | Keypad3 Keypad5, Switch1 Switch1 |
| `09_NYC_ShipBelow` | `OpsAccess` (1) | unlocked, not frobbable | Keypad3 Keypad6, Switch1 Switch0 |
| `09_NYC_ShipBelow` | `AugSafe` (1) | unlocked, not frobbable | Keypad3 Keypad7 |
| `09_NYC_ShipFan` | `Door1` (1) | unlocked, pick 0.20 | Trigger Trigger0 |
| `09_NYC_ShipFan` | `Door2` (1) | unlocked, pick 0.20 | Trigger Trigger1 |
| `09_NYC_ShipFan` | `MainDuctVent` (1) | unlocked, pick 0.80 | Switch2 Switch2 |

Key doors (a placed `NanoKey` opens them, or the lock is picked; frob only): `CommandersOffice`, `WeaponLocker`, `SemiKey` x6, `FanDoor`.

(30 further movers of these maps are locked with a pickable lock or breakable, take no key that exists as a placed `NanoKey` and are fired by no event: not listed.)

**Progression blocker (mission 9).** The first of: no way into the shipyard building (guards, sewer and duct all closed); `ShipBreech` movers not destroyed or `Bilge` not set (no `MS_ShipBreeched`: no helicopter); the dockyard `MapExit0` not travelling; `M09MeetStantonDowd` not played or `deviceDestroyed` not set (no helicopter at the graveyard); `M09JockLeave` not firing `ChopperExit`; `MapExit0` not loading Paris.

### 09.7 Slots

| Slot | Map | Saved as | Saves, play time | Important NPCs dead or knocked out (all) | Lasting-choice flags in the file (all) | Goals still open |
| --- | --- | --- | --- | --- | --- | --- |
| N0021 | `09_NYC_Dockyard` | NYC - Brooklyn Naval Shipyards | 359, 642 min | AnnaNavarre, DrugDealer, GilbertTerrorist, JoeGreene, JoJoFine, JosephManderley, JuanLebedev, MaggieChow, MJ12Commando, PrivateLloyd, Supervisor01, Terrorist | AmbrosiaTagged, BathroomBarks_Played, FilbenGaveKey, GreenKnowsAboutDowd, GuntherFreed, GuntherRespectsPlayer=0, HeardGrenadeTalk, HelpSailor, JacobsonRecruited, JaimeRecruited, KnowsAboutKillphrase, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, M04MetWalton, M08WarnedSmuggler, MeetJoeGreen_Played, PlayerMetFilben, SandraWentToCalifornia | ScuttleShip |
| N0022 | `09_NYC_Dockyard` | NYC - Brooklyn Naval Shipyards | 372, 661 min | AnnaNavarre, DrugDealer, GilbertTerrorist, JoeGreene, JoJoFine, JosephManderley, JuanLebedev, MaggieChow, MJ12Commando, PrivateLloyd, Supervisor01, Terrorist | AmbrosiaTagged, BathroomBarks_Played, FilbenGaveKey, GreenKnowsAboutDowd, GuntherFreed, GuntherRespectsPlayer=0, HeardGrenadeTalk, HelpSailor, JacobsonRecruited, JaimeRecruited, KnowsAboutKillphrase, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, M04MetWalton, M08WarnedSmuggler, MeetJoeGreen_Played, PlayerMetFilben, SandraWentToCalifornia | ScuttleShip, GetIntoSubPen, GetAmmo |
| N0023 | `09_NYC_ShipFan` | NYC - Naval Assembly Building AC System | 388, 684 min | AnnaNavarre, DrugDealer, GilbertTerrorist, JoeGreene, JoJoFine, JosephManderley, JuanLebedev, MaggieChow, MJ12Commando, PrivateLloyd, Supervisor01, Terrorist | AmbrosiaTagged, BathroomBarks_Played, FilbenGaveKey, GreenKnowsAboutDowd, GuntherFreed, GuntherRespectsPlayer=0, HeardGrenadeTalk, HelpSailor, JacobsonRecruited, JaimeRecruited, KnowsAboutKillphrase, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, M04MetWalton, M08WarnedSmuggler, MeetJoeGreen_Played, PlayerMetFilben, SandraWentToCalifornia | ScuttleShip, GetIntoSubPen |
| N0024 | `09_NYC_Ship` | NYC - Naval Assembly Building and Ship | 400, 698 min | AnnaNavarre, DrugDealer, GilbertTerrorist, JoeGreene, JoJoFine, JosephManderley, JuanLebedev, MaggieChow, MJ12Commando, PrivateLloyd, Supervisor01, Terrorist | AmbrosiaTagged, BathroomBarks_Played, FilbenGaveKey, GreenKnowsAboutDowd, GuntherFreed, GuntherRespectsPlayer=0, HeardGrenadeTalk, HelpSailor, JacobsonRecruited, JaimeRecruited, KnowsAboutKillphrase, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, M04MetWalton, M08WarnedSmuggler, MeetJoeGreen_Played, PlayerMetFilben, SandraWentToCalifornia | ScuttleShip, GetBelowDecks |
| R0021 | `09_NYC_ShipFan` | NYC - Brooklyn Naval Shipyards | 165, 877 min | AnnaNavarre, DrinkingMan, DrugDealer, GilbertTerrorist, JoJoFine, JosephManderley, JuanLebedev, MaggieChow, MJ12Commando, PrivateLloyd, Supervisor01, Terrorist | AmbrosiaTagged, FilbenGaveKey, GuntherFreed, GuntherRespectsPlayer, HeardGrenadeTalk, HelpSailor, JacobsonRecruited, KnowsAboutKillphrase, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, M04MetWalton, PlayerMetFilben, SandraWentToCalifornia | ScuttleShip |

Five slots: two Dockyard (N0021, N0022), the air-conditioning duct (N0023), the Ship (N0024), plus the GOTY slot R0021 (the duct, with modded rifles and Regeneration/Cloak; the only slot Play's load stops on, because `DeusExMover1`, the running fan, rotates a brush: [travel](travel.md#play-step-4-loading-a-saved-game)). None is in `ShipBelow` or the Graveyard.

## Mission 10: Paris (catacombs, club, metro, chateau)

Five maps. The player lands in the Paris catacombs, looks for Silhouette's people (free and escort their hostages), finds Nicolette DuClare at Club La Porte de l'Enfer, goes with her and Jock from the metro to her mother's chateau, finds the traces of Morgan Everett
and reaches the Knights Templar cathedral through the crypt maze. The mission is a chain of "meet X, then Y appears": most of the script is unhiding pawns and recording who was rescued.

### 10.1 Maps and arrival

| Map | Actors | Level info (`MapName`; `MissionLocation`) | Startup text | Script | Arrives from | Leaves to |
| --- | --- | --- | --- | --- | --- | --- |
| `10_Paris_Catacombs` | 2715 | 10_Paris_Catacombs; Paris - Denfert-Rochereau | Denfert-Rochereau, Paris / Abandoned Skyrise | Mission10 | 09_NYC_Graveyard (path CameraPath); 10_Paris_Catacombs_Tunnels#spiralstair | 10_Paris_Catacombs_Tunnels#spiralstair |
| `10_Paris_Catacombs_Tunnels` | 1695 | 10_Paris_Catacombs_tunnels; Paris - Catacombs | Les catacombes de Paris | Mission10 | 10_Paris_Catacombs#spiralstair | 10_Paris_Catacombs#spiralstair; 10_Paris_Metro#sewer |
| `10_Paris_Chateau` | 2130 | 10_Paris_Chateau; Paris - Chateau DuClare | Chateau DuClare / Outside Paris | Mission10 | 10_Paris_Metro (path Camera1) | 11_Paris_Cathedral#cathedralstart |
| `10_Paris_Club` | 792 | 10_Paris_Club; Paris - Nightclub La Porte de l'Enfer | La Porte de l'Enfer / Parisian Nightclub | Mission10 | 10_Paris_Metro#Paris_Club1/Paris_Club2 x2 | 10_Paris_Metro#Paris_Metro1/Paris_Metro2 x2 |
| `10_Paris_Metro` | 3183 | 10_Paris_Metro; Paris - Near Champs Elysses | Paris Under Martial Law | Mission10 | 10_Paris_Catacombs_Tunnels#sewer; 10_Paris_Club#Paris_Metro1/Paris_Metro2 x2 | 10_Paris_Chateau (path Camera1); 10_Paris_Club#Paris_Club1/Paris_Club2 x2 |

* **Arrival.** `09_NYC_Graveyard` `MapExit0` (camera `CameraPath`, tag `CopterCam`) -> `10_Paris_Catacombs`. Mission change 9 -> 10: `Save\Current` wiped, `DeleteExpiredFlags(10)`.
* **Inside.** Catacombs <-> Catacombs Tunnels <-> Metro (sewer teleporters), Club <-> Metro/Chateau by teleporters, Metro -> Chateau by `MapExit1` (camera `Camera1`, tag `ChopperExit`).
* **Leaving.** `10_Paris_Chateau` `Teleporter0` (-1638,-3416,-181, touch) -> `11_Paris_Cathedral#cathedralstart`: a teleporter, not a `MapExit`, but its destination is a map of mission 11, so `Browse` takes the next-mission branch (`next != cur`: `Save\Current` wiped) exactly as for a `MapExit`.

| Map | Actor | At | Leads to | Fired by (events targeting its tag) |
| --- | --- | --- | --- | --- |
| `10_Paris_Chateau` | Teleporter `Teleporter0` | -1638,-3416,-181 | `11_Paris_Cathedral#cathedralstart` | touch |
| `10_Paris_Metro` | MapExit `MapExit1` | 2919,1400,231 | `10_Paris_Chateau` (path `Camera1`) | tag `ChopperExit`: conversation JockReady[A1] |

**10_Paris_Metro MapExit1 -> 10_Paris_Chateau** (tag `ChopperExit`)

```text
event ChopperExit
  conversation event Trigger "ChopperExit" in JockReady branch A1
    conversation JockReady [ovh bump/frob/radius 200; owner Jock]
      starts: its actor (bump/frob/radius 200)
      flag NicoletteReadyToLeave: set by conversation NicoletteOutside@Go
        conversation NicoletteOutside [talk bump/frob; owner NicoletteDuClare]
          starts: its actor (bump/frob)
          flag !ClubComplete: set by script Mission10.FirstFrame:47
          flag NicoletteLeftClub: set by script Mission10.PreTravel:64
          flag !NicoletteReadyToLeave: set by conversation NicoletteOutside@Go
```

### 10.2 Mission script `Mission10`

`.cache/research/src/DeusEx/Mission10.uc`, 188 lines.

* `FirstFrame` (`:12-49`): Metro: `NicoletteLeftClub` -> Nicolette and the `BlackHelicopter` tagged `BlackHelicopter` enter; **`!JaimeRecruited` -> Jaime enters** (`:31-35`); Club: `NicoletteLeftClub` -> Nicolette destroyed; Chateau: `ClubComplete` (expiration 11).
* `PreTravel` (`:57-69`): leaving the Club with `MeetNicolette_Played` and not `NicoletteLeftClub` sets `NicoletteLeftClub` (expiration 11). No `SendPlayer`/`ClientTravel`.
* `Timer` (`:77-184`): Catacombs: `SewerGreaselsDead` and `defoequestcomplete` (no `mj12metroguards` left) (expiration 11); Tunnels: counts the pawns bound `hostage`/`hostage_female` against `CataMaleSafe`/`CataFemaleSafe`: all safe or none alive ->
  `SilhouetteRescueComplete`, `EscortHostages` done, and `SilhouetteHostagesDead` / `SilhouetteHostagesSomeRescued` / `SilhouetteHostagesAllRescued` (expiration 11); Metro: `JockReady_Played` -> Gunther enters (`MS_GuntherUnhidden`), `AlleyCopSeesPlayer_Played` fires `AlleyCopAttacks`;
  Chateau: `everettsignal` -> the `MJ12Commando`s enter.
* Flags it sets: all with expiration 11 (alive through mission 10, gone on entering 11). The permanent one comes from a conversation.
* Actors it touches: `NicoletteDuClare`, `BlackHelicopter`, `JaimeReyes`, `Greasel`, `ScriptedPawn` by tag/BindName, `GuntherHermann`, `MJ12Commando`.

Generated from the script's calls (`inventory-campaign.mjs scripts`; `:N` is the first line):

* **Flags set** (11; `eN` = explicit expiration N, otherwise the default): `ClubComplete` e11 (:47), `NicoletteLeftClub` e11 (:64), `SewerGreaselsDead` e11 (:99), `defoequestcomplete` e11 (:110), `SilhouetteRescueComplete` e11 (:138), `SilhouetteHostagesDead` e11 (:142), `SilhouetteHostagesSomeRescued` e11 (:144), `SilhouetteHostagesAllRescued` e11 (:146), `MS_GuntherUnhidden` e11 (:159), `MS_CopBarked` e11 (:169), `MS_CommandosUnhidden` e11 (:181).
* **Flags read** (14): `NicoletteLeftClub`, `JaimeRecruited`, `MeetNicolette_Played`, `SewerGreaselsDead`, `defoequestcomplete`, `SilhouetteRescueComplete`, `CataMaleSafe`, `CataFemaleSafe`, `MS_GuntherUnhidden`, `JockReady_Played`, `AlleyCopSeesPlayer_Played`, `MS_CopBarked`, `MS_CommandosUnhidden`, `everettsignal`.
* **InfoLinks it starts**: none. **Conversations it starts by name**: none. **Goals it completes**: `EscortHostages` (:139).
* **Spawns**: none. **Destroy calls**: 1; **EnterWorld/LeaveWorld calls**: 5. **Travel calls**: none.

### 10.3 Conversations and InfoLinks

174 conversations of the list besides the shared barks: 51 InfoLinks (the largest count of any mission), 36 talk-type, 87 overheard. 14 have choices (shops: the bakery, `MeetRenault`;
`M10MeetJaime`, Nicolette's, Chad's and the club's conversations), 33 set flags, 95 need a flag, 20 add or complete goals.

**Choices.** Every choice that changes state, the block its speech jumps to and what that block does (choices that change no state are counted in one row per conversation):

| Conversation | Owner | Choice | Effects of the branch |
| --- | --- | --- | --- |
| `RenaultPays` | Renault | I'll make the trade. [needs HaveCrack, M10EnteredBakery] | -> Sell: set RenaultPaid |
| `RenaultPays` | Renault | I don't deal in zyme. [needs !RenaultOffered65] | -> NoDeal: set RenaultOffered65 |
| `RenaultPays` | Renault | I don't like your business. Period. [needs RenaultOffered65] | -> NoDeal2: set RenaultAttacked, trig GuyAttacks, trig RenaultAttacks |
| `RenaultPays` | Renault | (3 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `NicoletteOutside` | NicoletteDuClare | Let's go. | -> Go: set NicoletteReadyToLeave, trig NicoletteFollows |
| `NicoletteOutside` | NicoletteDuClare | How does Everett threaten Bob Page? [needs !M10EverettQuestion] | -> Everett: set M10EverettQuestion |
| `NicoletteOutside` | NicoletteDuClare | (1 further choice that change no state: refusals, "never mind", unaffordable offers) | - |
| `MichelleConvos` | Michelle | A bottle of wine. [needs M10CanAffordWine] | -> BuyWine: give WineBottle |
| `MichelleConvos` | Michelle | A snack. [needs M10CanAfford] | -> BuySnack: give CandyBar |
| `MichelleConvos` | Michelle | Know the name Nicolette DuClare? [needs !NicoletteQuestionDone, !MeetNicolette_Played] | -> Nicolette: set NicoletteQuestionDone |
| `MichelleConvos` | Michelle | What do you think of Silhouette? [needs NicoletteQuestionDone, !SilhouetteQuestionDone] | -> Silhouette: set SilhouetteQuestionDone |
| `MichelleConvos` | Michelle | (2 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `LouisConvosSneak` | Louis | Please accept my apology. Here you are. | -> Pay: set M10PaidForClub, give Nanokey |
| `LouisConvosSneak` | Louis | (1 further choice that change no state: refusals, "never mind", unaffordable offers) | - |
| `LouisConvos` | Louis | Here you go. | -> Pay: set M10PaidForClub, give Nanokey |
| `LouisConvos` | Louis | (1 further choice that change no state: refusals, "never mind", unaffordable offers) | - |
| `KristiConvos` | Kristi | A soda, please. [needs M10CanAfford] | -> BuyWine: give SodaCan |
| `KristiConvos` | Kristi | Have anything to eat? [needs M10CanAfford] | -> BuySnack: give SoyFood |
| `KristiConvos` | Kristi | At least one cafe stayed open during the crackdown. [needs !CafeQuestionDone] | -> CafeQuestion: set CafeQuestionDone |
| `KristiConvos` | Kristi | I'm looking for a friend, Nicolette DuClare. [needs !CafeQuestion2Done, !MeetNicolette_Played, CafeQuestionDone] | -> Nicolette: set CafeQuestion2Done |
| `KristiConvos` | Kristi | The police are just pawns of Majestic 12. [needs MeetNicolette_Played, !CafeQuestion2Done, CafeQuestionDone] | -> Majestic12: set CafeQuestion2Done, set CafeMJ12QuestionDone |
| `KristiConvos` | Kristi | This crackdown is the work of Majestic 12. [needs CafeQuestion2Done, !CafeMJ12QuestionDone] | -> Majestic12: set CafeQuestion2Done, set CafeMJ12QuestionDone |
| `KristiConvos` | Kristi | Sorry, I'm broke. [needs !M10CanAfford] | -> Broke: set CafeBrokeComment |
| `KristiConvos` | Kristi | (1 further choice that change no state: refusals, "never mind", unaffordable offers) | - |
| `JocquesSellInfo` | Jocques | Okay. | -> BuyInfo: set JocquesDoneSelling |
| `JocquesSellInfo` | Jocques | (1 further choice that change no state: refusals, "never mind", unaffordable offers) | - |
| `JeanConvos` | Jean | The best wine you've got for 120. [needs M10CanAffordWine] | -> BuyWine: give WineBottle |
| `JeanConvos` | Jean | Ten credits' worth of food. [needs M10CanAfford] | -> BuySnack: give CandyBar |
| `JeanConvos` | Jean | Thin crowd. Has martial law hurt business? [needs !MartialLawQuestionDone] | -> MartialLaw: set MartialLawQuestionDone |
| `JeanConvos` | Jean | Gestapo? [needs !GestapoQuestionDone, MartialLawQuestionDone] | -> Gestapo: set GestapoQuestionDone |
| `JeanConvos` | Jean | (2 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `HotelBartenderConvos` | HotelBartender | A bottle of wine. [needs M10CanAfford] | -> BuyWine: give WineBottle |
| `HotelBartenderConvos` | HotelBartender | A snack. [needs M10CanAfford] | -> BuySnack: set BoughtCandyFromHotelBartender, give CandyBar |
| `HotelBartenderConvos` | HotelBartender | Heard of Nicolette DuClare? [needs !HotelNicoletteQuestionDone] | -> Nicolette: set HotelNicoletteQuestionDone |
| `HotelBartenderConvos` | HotelBartender | No revolutionaries? You must not mind martial law. [needs HotelNicoletteQuestionDone, !HotelRevolutionariesQuestionDone] | -> Revolutionaries: set HotelRevolutionariesQuestionDone |
| `HotelBartenderConvos` | HotelBartender | The conspiracy is real. [needs !HotelMJ12QuestionDone, HotelRevolutionariesQuestionDone] | -> MJ12: set HotelMJ12QuestionDone |
| `HotelBartenderConvos` | HotelBartender | (2 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `DefoeConvos` | Defoe | 1750 for the rockets. Sounds good. [needs M10CanBuyRockets, !M10BoughtRockets] | -> BuyRockets: give AmmoRocket, set M10BoughtRockets |
| `DefoeConvos` | Defoe | How about the recoil suppressor for 400. [needs M10CanBuyMod, !M10BoughtMod] | -> BuyMod: give WeaponModRecoil, set M10BoughtMod |
| `DefoeConvos` | Defoe | I'll take the three LAMs for 2250. [needs M10CanBuyLams, !M10BoughtLAMs] | -> BuyLAMs: give WeaponLAM, set M10BoughtLAMs |
| `DefoeConvos` | Defoe | 5250 for the rockets. Sounds good. [needs M10CanBuyRockets, !M10BoughtRockets] | -> BuyRockets: give AmmoRocket, set M10BoughtRockets |
| `DefoeConvos` | Defoe | How about the recoil suppressor for 1200. [needs M10CanBuyMod, !M10BoughtMod] | -> BuyMod: give WeaponModRecoil, set M10BoughtMod |
| `DefoeConvos` | Defoe | I'll take the three LAMs for 6750. [needs M10CanBuyLams, !M10BoughtLAMs] | -> BuyLAMs: give WeaponLAM, set M10BoughtLAMs |
| `DefoeConvos` | Defoe | (8 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `MeetCassandra` | Cassandra | Sure. [needs !GaveCassandraMoney, !ClubVaultEntered] | -> Give: set GaveCassandraMoney |
| `MeetCassandra` | Cassandra | What about Nicolette DuClare? Know her? [needs !CassandraNicoQuestion, !MeetNicolette_Played] | -> NicoQuestion: set CassandraNicoQuestion |
| `MeetCassandra` | Cassandra | Already been there. [needs !GaveCassandraMoney, ClubVaultEntered] | -> BeenThere: set GaveCassandraMoney |
| `MeetCassandra` | Cassandra | (3 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `CamilleConvos` | Camille | (4 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `BumsConvos` | Bums | I'll take a medkit for 600. [needs M10CanAffordMedKit, !BoughtMedkit3] | -> BuyMedkit: set BoughtMedkit3, give Medkit |
| `BumsConvos` | Bums | I'll take the darts for 200. [needs M10CanAffordDarts, !M10BoughtDarts] | -> BuyDarts: give AmmoDartPoison |
| `BumsConvos` | Bums | (1 further choice that change no state: refusals, "never mind", unaffordable offers) | - |
| `AntoineConvos` | Antoine | I'll take one. | -> Buy: set BoughtAntoine4, give BioelectricCell |
| `AntoineConvos` | Antoine | (1 further choice that change no state: refusals, "never mind", unaffordable offers) | - |

**Conversations that change state** (choices, flags set, goals, items, events, skill points; the `Needs` column is kept on these rows):

| Conversation | Owner (BindName; maps with that actor) | Kind | Choices | Sets | Needs | Goals | Other |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `DL_tunnels_down` | JCDenton | DL once |  |  | ? !ChadThankful_Played | +P FindNicolette |  |
| `DL_reached_computer` | JCDenton | DL once |  |  | req !DL_EverettContact_Played | done FindDuClareComputer |  |
| `DL_paris_10_start` | JCDenton | DL once |  |  |  | +P ContactIlluminati, +P FindSilhouette |  |
| `DL_metrosewer` | JCDenton | DL once |  |  | ? !JaimeRecruited | done FreeHostages, done EscortHostages, done ReportToChad, +S MeetJaime |  |
| `DL_EverettMaze` | JCDenton | DL once |  |  | req DL_EverettContact_Played | done GoToCrypt, +P AccessTemplarComputer |  |
| `DL_EverettContact` | JCDenton | DL once |  |  | req everettsignal | done FindEverett, +P GetKeyToCrypt | trig NicoletteRuns |
| `DL_entered_sewer` | JCDenton | DL once |  |  |  | done GetKeyToCrypt |  |
| `ReneBarks` | Rene (Paris_Metro) | ovh bump/frob/radius 150 |  |  |  |  | trig ReneAttacks |
| `RenaultPays` | Renault (Paris_Metro) | talk bump/frob | 6 | RenaultBustedComment@Busted, HaveCrack@Choice, RenaultPaid@Sell, HaveCrack=0@NoCrack, RenaultOffered65@NoDeal, RenaultAttacked@NoDeal2 | req !RenaultPaid, req MeetRenault_Played, req !RenaultAttacked, ? !M10EnteredBakery, ? M10EnteredBakery, ? !RenaultBustedComment, ? RenaultBustedComment, ? RenaultOffered65, ? RenaultBakeryComment | done GetCrack | trig GuyAttacks, trig RenaultAttacks, take VialCrack, has? VialCrack, cr 115 |
| `MeetRenault` | Renault (Paris_Metro) | talk bump/frob once |  | RenaultBustedComment@BeenThere | req !RenaultAttacked, ? MeetLeone_Played, ? M10EnteredBakery | +S GetCrack, +note |  |
| `NicoletteOutside` | NicoletteDuClare (Paris_Chateau, Paris_Club, Paris_Metro) | talk bump/frob | 3 | M10EverettQuestion@Everett, NicoletteReadyToLeave@Go | req !ClubComplete, req NicoletteLeftClub, req !NicoletteReadyToLeave, ? NicoletteOutside_Played | done FindNicolette, done MeetNicolette, +P FindEverett | trig NicoletteFollows, sp 300 |
| `NicoletteInStudy` | NicoletteDuClare (Paris_Chateau, Paris_Club, Paris_Metro) | ovh radius 350 once |  |  | req ClubComplete, req ChateauInStudy | +note |  |
| `NicoletteInNicolettesRoom` | NicoletteDuClare (Paris_Chateau, Paris_Club, Paris_Metro) | ovh radius 350 |  | M10NicolettesRoomDone@A2 | req ClubComplete, req ChateauInNicolettesRoom, req !M10NicolettesRoomDone |  |  |
| `NicoletteInKitchen` | NicoletteDuClare (Paris_Chateau, Paris_Club, Paris_Metro) | ovh radius 350 |  | M10DoneInKitchen@A2 | req ClubComplete, req ChateauInKitchen, req !M10DoneInKitchen |  |  |
| `NicoletteInComputerRoom` | NicoletteDuClare (Paris_Chateau, Paris_Club, Paris_Metro) | ovh radius 350 |  | M10ComputerRoomDone@A2 | req ClubComplete, req ChateauInComputerRoom, req !M10ComputerRoomDone |  |  |
| `NicoletteInCellar` | NicoletteDuClare (Paris_Chateau, Paris_Club, Paris_Metro) | ovh radius 350 |  | M10CellarDone@A2 | req ClubComplete, req ChateauInCeller, req !M10CellarDone |  |  |
| `NicoletteFinalBarks2` | NicoletteDuClare (Paris_Chateau, Paris_Club, Paris_Metro) | ovh bump/frob/radius 200 |  |  | req NicoletteDoneFollowing |  | trig NicoletteLeaves |
| `NicoletteChateauBarks` | NicoletteDuClare (Paris_Chateau, Paris_Club, Paris_Metro) | ovh bump/frob |  | NicoletteChatDone@A14 | req ClubComplete, req NicoletteAtChateau_Played, req !DL_EverettContact_Played, ? NicoletteFoundSecretArea, ? NicoletteChatDone |  |  |
| `NicoletteAtChateau` | NicoletteDuClare (Paris_Chateau, Paris_Club, Paris_Metro) | talk bump/frob/radius 120 once |  |  | req ClubComplete | +P FindDuClareComputer |  |
| `NicoletteAfterEverett` | NicoletteDuClare (Paris_Chateau, Paris_Club, Paris_Metro) | talk bump/frob/radius 100 once |  |  | req DL_EverettContact_Played | done GetKeyToCrypt, +P GoToCrypt | trig NicoletteFollows, give Nanokey |
| `MeetNicolette` | NicoletteDuClare (Paris_Chateau, Paris_Club, Paris_Metro) | talk bump/frob once |  | NicoletteQuestionDone, CassandraDone@Hack | ? !ChadThankful_Played, ? GaveCassandraMoney | +P MeetNicolette |  |
| `MichelleConvos` | Michelle (Paris_Club) | talk bump/frob | 6 | M10CanAfford=0, M10CanAffordWine=0, NicoletteQuestionDone@Nicolette, SilhouetteQuestionDone@Silhouette, M10CanAfford@CanAfford, M10CanAffordWine@CanAffordWine | ? !M10CanAfford, ? SilhouetteQuestionDone |  | give WineBottle, give CandyBar, cr -130 |
| `LouisExpelling` | Louis (Paris_Club) | ovh bump/frob/radius 200 |  | LoiusBeenInBooth | req LouisBerates |  |  |
| `LouisConvosSneak` | Louis (Paris_Club) | talk bump/frob/radius 160 | 2 | M10PaidForClub@Pay | req M10SeenSneakingOut, req !M10PaidForClub, req !LouisBerates, ? !LouisDancerComment, ? LouisLikesDancer |  | give Nanokey, cr -300 |
| `LouisConvos` | Louis (Paris_Club) | talk bump/frob/radius 160 | 2 | M10PaidForClub@Pay, LouisDancerComment@DancerComment | req !M10SeenSneakingOut, req !M10PaidForClub, req !LouisBerates, ? LouisLikesDancer, ? !LouisDancerComment, ? LoiusBeenInBooth, ? M10PaidForClub, ? !M10PaidForClub, ? M10SeenSneakingOut |  | give Nanokey, cr -300 |
| `MeetLeone` | Leone (Paris_Metro) | talk bump/frob once |  |  | ? MeetNicolette_Played, ? RenaultPaid, ? MeetRenault_Played, ? Renault_Dead | +note |  |
| `KristiConvos` | Kristi (Paris_Metro) | talk bump/frob | 8 | M10CanAfford=0, CafeBrokeComment@Broke, CafeQuestionDone@CafeQuestion, CafeQuestion2Done@Nicolette, CafeQuestion2Done@Majestic12, CafeMJ12QuestionDone@Majestic12, M10CanAfford@CanAfford | ? !M10CanAfford, ? CafeMJ12QuestionDone, ? CafeBrokeComment |  | give SodaCan, give SoyFood, cr -20 |
| `JoshuaOverheard2` | Joshua (Paris_Metro) | ovh radius 300 once |  | AgatheJushuaHeard | req JoshuaOverheard_Played |  |  |
| `JoshuaOverheard` | Joshua (Paris_Metro) | ovh radius 300 once |  | AgatheJushuaHeard |  |  |  |
| `JoshuaInterrupted` | Joshua (Paris_Metro) | talk bump/frob once |  |  | req AgatheJushuaHeard | +note |  |
| `JocquesSellInfo` | Jocques (Paris_Club) | talk bump/frob | 2 | JocquesDoneSelling@BuyInfo, JocquesSnubbed@BeenThere, JocquesDoneSelling@BeenThere | req !JocquesDoneSelling, ? JocquesSellInfo_Played, ? AssassinApartment | +note | cr -1000 |
| `JockReady` | Jock (Paris_Metro) | ovh bump/frob/radius 200 |  |  | req NicoletteReadyToLeave |  | trig ChopperExit |
| `JeanConvos` | Jean (Paris_Club) | talk bump/frob | 6 | M10CanAfford=0@StartChoice, M10CanAffordWine=0@StartChoice, MartialLawQuestionDone@MartialLaw, GestapoQuestionDone@Gestapo, M10CanAffordWine@CanAffordWine, M10CanAfford@CanAfford | ? !M10CanAfford, ? GestapoQuestionDone |  | give WineBottle, give CandyBar, cr -130 |
| `M10MeetJaime` | JaimeReyes (Paris_Metro) | talk bump/frob once |  | KnowsGuntherKillphrase@Continue | ? KnowsAboutKillphrase | done MeetJaime, +note |  |
| `HotelBartenderConvos` | HotelBartender (Paris_Metro) | talk bump/frob | 7 | M10CanAfford=0@Continue, M10CanAffordSnack=0@Continue, BoughtCandyFromHotelBartender@BuySnack, HotelBartenderArmsComment@Arms, HotelNicoletteQuestionDone@Nicolette, HotelRevolutionariesQuestionDone@Revolutionaries (+4 more) | ? RenaultAttacked, ? !HotelBartenderArmsComment, ? Renault_Dead, ? Guy_Dead, ? HotelBartenderConvos_Played, ? MeetRenault_Played, ? BoughtCandyFromHotelBartender, ? MeetNicolette_Played, ? M10FoundClub (+1 more) | +note | give WineBottle, give CandyBar, cr -125 |
| `MeetDefoe` | Defoe (Paris_Catacombs) | talk bump/frob/radius 160 once |  |  | ? DefoeQuestComplete | +S ClearMall |  |
| `DefoeConvos` | Defoe (Paris_Catacombs) | talk bump/frob | 14 | M10CanBuyLams=0@SkipDescription, M10CanBuyMod=0@SkipDescription, M10CanBuyRockets=0@SkipDescription, M10BoughtAll@BoughtAll, M10BoughtRockets@ContinueRocket, M10BoughtMod@ContinueMod, M10BoughtLAMs@ContinueLAMs (+9 more) | req !M10BoughtAll, req MeetDefoe_Played, ? DefoeQuestComplete, ? !DefoeDroppedPrices, ? !MeetChad_Played, ? !DafoeSilhouette1, ? !DafoeSilhouette2, ? M10BoughtRockets, ? M10BoughtMod, ? M10BoughtLAMs | done ClearMall, +note | give AmmoRocket, give WeaponModRecoil, give WeaponLAM*3, cr -17600 |
| `CharlotteInterrupted` | Charlotte (Paris_Club) | talk bump/frob once |  | AnnetteCharlotteInterruptionDone | req AnnetteCharlotteHeard |  |  |
| `MeetChad` | Chad (Paris_Catacombs_Tunnels) | talk bump/frob/radius 100 once |  |  | ? SilhouetteHostagesFreed | done FindSilhouette, +S FreeHostages, +S EscortHostages, +S ReportToChad | give NanoKey, give Image10_Paris_CatacombsTunnels |
| `ChadWaiting` | Chad (Paris_Catacombs_Tunnels) | ovh bump/frob |  | ChadBarkADone@A4, ChadBarkBDone@B6, ChadBarkCDone@C9 | req !SilhouetteRescueComplete, req MeetChad_Played, ? ChadBarkCDone, ? ChadBarkBDone, ? ChadBarkADone, ? ChadThankful_Played |  |  |
| `ChadThankful` | Chad (Paris_Catacombs_Tunnels) | talk bump/frob once |  | ChadThankful_Played@PrematureEscape | req MeetChad_Played, req SilhouetteHostagesFreed, ? SilhouetteHostagesDead, ? SilhouetteHostagesAllRescued, ? SilhouetteRescueComplete, ? Hostage_Female_Dead, ? Hostage_Dead, ? DL_Tunnels_Down_Played | done ReportToChad, +P FindNicolette | has? NK_Catacombs_Blastdoor02, sp 2250 |
| `MeetCassandra` | Cassandra (Paris_Club) | talk bump/frob/radius 100 | 6 | GaveCassandraMoney@Give, CassandraNicoQuestion@NicoQuestion, CassandraDone@Done, GaveCassandraMoney@BeenThere | req !CassandraDone, ? MeetCassandra_Played, ? !LouisConvos_Played, ? CassandraNicoQuestion, ? MeetNicolette_Played, ? GaveCassandraMoney |  | cr -200 |
| `CamilleConvos` | Camille (Paris_Club) | talk bump/frob/radius 70 | 4 | CamilleConvosDone@A3 | req !CamilleConvosDone, ? CamilleConvos_Played, ? MeetNicolette_Played | +note | cr -40 |
| `BumsConvos` | Bums (Paris_Catacombs_Tunnels) | talk bump/frob | 3 | M10CanAffordMedKit=0@StartChoice, M10CanAffordDarts=0@StartChoice, BoughtMedkit3@BuyMedKit, BoughtMedkit3@AllDone, M10BoughtDarts@AllDone, M10BumsDone@AllDone, M10CanAffordMedKit@CanAffordAll (+4 more) | req !M10BumsDone, ? BumsConvos_Played, ? !BoughtMedkit1, ? !BoughtMedkit2, ? M10BoughtDarts, ? BoughtMedkit3 |  | give Medkit, give AmmoDartPoison, cr -800 |
| `AntoineConvos` | Antoine (Paris_Club) | talk radius 160 once | 2 | BoughtAntoine4@Buy, AntoineIntroduced@BuyContinue, BoughtAntoine1@SetOne, BoughtAntoine2@SetTwo, BoughtAntoine3@SetThree | ? !AntoineConvos_Played, ? BoughtAntoine1, ? !BoughtAntoine1, ? !BoughtAntoine2, ? !BoughtAntoine3, ? AntoineIntroduced |  | give BioelectricCell, cr -250 |
| `AnnetteOverheard` | Annette (Paris_Club) | ovh radius 300 once |  | AnnetteCharlotteHeard |  |  |  |
| `AnnetteInterrupted` | Annette (Paris_Club) | talk bump/frob once |  | AnnetteCharlotteInterruptionDone | req AnnetteCharlotteHeard, ? MeetNicolette_Played, ? !NicoletteOutside_Played, ? NicoletteOutside_Played |  |  |
| `MeetAimee` | Aimee (Paris_Catacombs) | talk bump/frob once |  | AimeeThankedPlayer@Dead | ? SewerGreaselsDead | +S KillGreasels, +note | sp 200 |
| `GreazelsDead` | Aimee (Paris_Catacombs) | talk bump/frob once |  |  | req MeetAimee_Played, req SewerGreaselsDead, req !AimeeThankedPlayer | done KillGreasels |  |
| `AimeeBarks` | Aimee (Paris_Catacombs) | ovh radius 350 |  | AimeeDeadGreazelComment@Dead | ? AimeeThankedPlayer, ? !AimeeDeadGreazelComment, ? SewerGreaselsDead |  |  |
| `AgatheInterrupted` | Agathe (Paris_Metro) | talk bump/frob once |  | JoshuaInterrupted_Played |  |  |  |

Conversations that only wait for a flag or check one, and change no state (68; `?` = a `CheckFlag` event): `DL_upstairs` (!NicoletteInBethsRoom_Played), `DL_tunnels_oldplace3` (DL_tunnels_oldplace2_Played), `DL_tunnels_oldplace2` (DL_tunnels_oldplace_Played), `DL_tunnels_hostagesinside` (MeetChad_Played, !SilhouetteHostagesFreed), `DL_graveyard_ambush` (DL_EverettContact_Played), `DL_entered_maze` (!DL_EverettContact_Played), `DL_entered_graveyard` (!DL_EverettContact_Played), `DL_crawling_troops` (M10_mj12_attack), `Silhouette_FemaleBarks` (? SilhouetteHostagesAllRescued (+4 more)), `SilhouetteBarks` (? SilhouetteHostagesAllRescued (+4 more)), `ReneOverheard3` (ReneOverheard2_Played), `ReneOverheard2` (ReneOverheard_Played), `RenaultWaiting` (MeetRenault_Played (+2 more)), `RenaultFinalBarks` (RenaultPaid, !RenaultAttacked (+1 more)), `RenaultAttacked` (RenaultAttacked), `Silhouette_FemaleChildWaiting` (MeetSilhouette_FemaleChild_Played (+1 more)), `Silhouette_FemaleChildSobbing` (Hostage_Female_Dead), `Silhouette_FemaleChildFinalBarks` (SilhouetteHostagesFreed (+2 more)), `MeetSilhouette_FemaleChild` (!SilhouetteRescueComplete, ? MeetChad_Played), `ODeadBarks` (Rene_Dead), `OBarks` (!Rene_Dead), `NightManagerBarks` (MeetNightManager_Played), `MeetNightManager` (? MeetNicolette_Played), `NicoletteWaitingToLeave` (!NicoletteLeftClub (+1 more)), `NicoletteWaitingForHelicopter` (!ClubComplete, NicoletteLeftClub (+1 more)), `NicoletteInUnderground2` (ClubComplete, ChateauInUnderground2 (+1 more)), `NicoletteInUnderground` (ClubComplete, ChateauInUnderground (+1 more)), `NicoletteInLivingRoom` (ClubComplete, ChateauInLivingRoom), `NicoletteInLabyrinth` (ClubComplete, ChateauInLabyrinth), `NicoletteInKeyRoom` (ClubComplete, ChateauInKeyRoom), `NicoletteInGarden2` (ClubComplete, ChateauInGarden2), `NicoletteInGarden` (ClubComplete, ChateauInGarden), `NicoletteInBethsRoom` (ClubComplete, ChateauInBethsRoom), `NicoletteFinalBarks` (NicoletteAfterEverett_Played (+1 more)), `MetroJanitorConvos` (!MetroJanitorDone), `LouisUpsetBark2` (M10PaidForClub, M10SeenSneakingOut (+3 more)), `LouisUpsetBark` (M10PaidForClub, M10SeenSneakingOut (+2 more)), `LouisSatisfiedBark2` (M10PaidForClub, !M10SeenSneakingOut (+3 more)), `LouisSatisfiedBark` (M10PaidForClub, !M10SeenSneakingOut (+2 more)), `LouisComment` (!LouisDancerComment, LouisLikesDancer, M10PaidForClub), `LeoneBarks` (MeetLeone_Played), `JoshuaBarksDefault` (!AgatheJushuaHeard), `JoshuaBarks` (JoshuaInterrupted_Played), `JocquesBarks` (JocquesDoneSelling, ? JocquesSnubbed), `JockNotReady` (!NicoletteReadyToLeave (+1 more)), `M10JaimeBarks` (M10MeetJaime_Played), `Hostage_FemaleBarks` (SilhouetteRescueComplete), `Hostage_Female_RunningBarks` (!SilhouetteRescueComplete), `HostageRunningBarks` (!SilhouetteRescueComplete), `HostageBarks` (SilhouetteRescueComplete), `GuyBarks` (? RenaultAttacked, ? RenaultPaid (+2 more)), `DefoeBarks` (M10BoughtAll), `CharlotteDefaultBarks` (!AnnetteCharlotteHeard), `CharlotteBarks` (AnnetteCharlotteInterruptionDone (+1 more)), `ChadFinalBarks` (ChadThankful_Played), `CassandraBarks` (CassandraDone, ? ClubVaultEntered), `CamilleBarks` (CamilleConvosDone), `BumBarks` (M10BumsDone), `AntoineDone` (BoughtAntoine4), `AntoineBump` (AntoineConvos_Played, !BoughtAntoine4), `AnnetteOverheard3` (AnnetteOverheard2_Played), `AnnetteOverheard2` (AnnetteOverheard_Played), `AnnetteFinalBarks` (AnnetteCharlotteInterruptionDone (+1 more)), `AnnetteDefaultBarks` (!AnnetteCharlotteHeard), `AlleyCopSeesPlayer` (PlayerInBakery), `AimeeBarksBump2` (AimeeThankedPlayer (+1 more)), `AimeeBarksBump` (MeetAimee_Played, !SewerGreaselsDead), `AgatheBarks` (JoshuaInterrupted_Played).

Plain InfoLinks, no flag and no event: 36 (listed with their starters in the InfoLink table).

Plain conversations with an actor (1): AI_phonecall_paris01: IcarusCalls.

Plain overheard conversations (18): Rene: ReneOverheard; Raymond: RaymondBarks; mj12_special01: SpecialGuys; MetroMJ12Troop_special01: SpecialGuardsChatting; MetroCop: MetroCopBumpBarks MetroCopBarks; KiergardTarot: KiergardBarks; Katarina: KatarinaBarks; Karenna: KarennaBarks; Jon: JonBarks; HotelMaid: HoteMaidBarks; HostelCop: HostelCopBarks; Female: SamiBarks; ClubSecurity: clubsecuritybarks; CafeChef: CafeChefBarks; BusinessWoman1: KaraBarks; Arthur: ArthurBarks; AlleyCop: AlleyCopBarks.

InfoLinks and what starts them (`DL_entered_maze` has no starter in the data; the others in the chateau chain need `everettsignal` or `DL_EverettContact_Played`):

| InfoLink | Started by | Needs | Sets / does |
| --- | --- | --- | --- |
| `DL_upstairs` | Paris_Chateau/DataLinkTrigger14 (-1039,32) | !NicoletteInBethsRoom_Played |  |
| `DL_tunnels_silhouette` | Paris_Catacombs_Tunnels/DataLinkTrigger2 (-2723,709) |  |  |
| `DL_tunnels_rearentry` | Paris_Catacombs_Tunnels/DataLinkTrigger0 (-2273,-2338) |  |  |
| `DL_tunnels_oldplace3` | Paris_Catacombs_Tunnels/DataLinkTrigger13 (-155,1015), Paris_Catacombs_Tunnels/DataLinkTrigger14 (-3569,-334) | DL_tunnels_oldplace2_Played |  |
| `DL_tunnels_oldplace2` | (none found) | DL_tunnels_oldplace_Played |  |
| `DL_tunnels_oldplace` | Paris_Catacombs_Tunnels/DataLinkTrigger1 (-1939,-639) |  |  |
| `DL_tunnels_oldexit` | Paris_Catacombs_Tunnels/DataLinkTrigger4 (1119,1172) |  |  |
| `DL_tunnels_newexit` | Paris_Catacombs_Tunnels/DataLinkTrigger5 (786,-38) |  |  |
| `DL_tunnels_mj12primary` | Paris_Catacombs_Tunnels/DataLinkTrigger6 (337,-30) |  |  |
| `DL_tunnels_mj12hunt` | Paris_Catacombs_Tunnels/DataLinkTrigger3 (-2095,1275) |  |  |
| `DL_tunnels_hostagesinside` | Paris_Catacombs_Tunnels/DataLinkTrigger7 (478,-762), Paris_Catacombs_Tunnels/DataLinkTrigger15 (-312,-1015) | MeetChad_Played, !SilhouetteHostagesFreed |  |
| `DL_tunnels_down` | Paris_Catacombs_Tunnels/DataLinkTrigger9 (1968,-1269) | !ChadThankful_Played | +goal FindNicolette |
| `DL_tunnels_abandoned` | Paris_Catacombs_Tunnels/DataLinkTrigger11 (-569,2145) |  |  |
| `DL_restaurant` | Paris_Metro/DataLinkTrigger6 (-2962,391), Paris_Metro/DataLinkTrigger7 (-1419,1344) |  |  |
| `DL_reached_computer` | Paris_Chateau/DataLinkTrigger0 (-30,3864), Paris_Chateau/DataLinkTrigger1 (419,4071) | !DL_EverettContact_Played | done FindDuClareComputer |
| `DL_penetrated_bunker` | Paris_Chateau/DataLinkTrigger2 (953,2867) |  |  |
| `DL_paris_10_start` | Paris_Catacombs/DataLinkTrigger0 (-3559,4105), Paris_Catacombs/DataLinkTrigger9 (-2556,4048), Paris_Catacombs/DataLinkTrigger10 (-3136,4353) |  | +goal ContactIlluminati, +goal FindSilhouette |
| `DL_paris_10_shaft` | Paris_Catacombs/DataLinkTrigger1 (-3550,4256) |  |  |
| `DL_paris_10_sewerexit` | Paris_Catacombs/DataLinkTrigger3 (-26,-68) |  |  |
| `DL_paris_10_radiation` | Paris_Catacombs/DataLinkTrigger2 (-2078,4262) |  |  |
| `DL_paris_10_metro` | Paris_Catacombs/DataLinkTrigger4 (408,-1601) |  |  |
| `DL_paris_10_catacombs` | Paris_Catacombs/DataLinkTrigger6 (231,1148), Paris_Catacombs/DataLinkTrigger7 (-843,1459) |  |  |
| `DL_otherplaces` | Paris_Metro/DataLinkTrigger3 (3453,-2070), Paris_Metro/DataLinkTrigger4 (145,-1749), Paris_Metro/DataLinkTrigger5 (-3608,-2305) |  |  |
| `DL_nico_bedroom` | (none found) |  |  |
| `DL_military` | Paris_Metro/DataLinkTrigger24 (1971,-3620) |  |  |
| `DL_metrostreetstair` | (none found) |  |  |
| `DL_metrosewer` | Paris_Metro/DataLinkTrigger0 (1705,-4236), Paris_Metro/DataLinkTrigger13 (1560,-4242) | !JaimeRecruited | done FreeHostages, done EscortHostages, done ReportToChad, +goal MeetJaime |
| `DL_metroentrance` | Paris_Metro/DataLinkTrigger1 (2426,-2307), Paris_Metro/DataLinkTrigger2 (1023,-735), Paris_Metro/DataLinkTrigger8 (-733,2321) |  |  |
| `DL_mediastore` | Paris_Metro/DataLinkTrigger21 (636,1852) |  |  |
| `DL_jock_club` | (none found) |  |  |
| `DL_Icarus_Speaks` | Paris_Catacombs/DataLinkTrigger5 (-16,3647) |  |  |
| `DL_Icarus_optional_law` | Paris_Metro/DataLinkTrigger23 (2423,2630) |  |  |
| `DL_Icarus_chateau02` | Paris_Chateau/DataLinkTrigger17 (-734,286) |  |  |
| `DL_Icarus_chateau01` | Paris_Chateau/DataLinkTrigger16 (-820,1090) |  |  |
| `DL_Icarus_cata_taunt` | (none found) |  |  |
| `DL_hotel` | Paris_Metro/DataLinkTrigger11 (3528,1728), Paris_Metro/DataLinkTrigger12 (3748,2817) |  |  |
| `DL_graveyard_ambush` | Paris_Chateau/DataLinkTrigger15 (-573,-3634), Paris_Chateau/DataLinkTrigger18 (-530,-4449) | DL_EverettContact_Played |  |
| `DL_EverettMaze` | Paris_Chateau/DataLinkTrigger8 (-259,-1997) | DL_EverettContact_Played | done GoToCrypt, +goal AccessTemplarComputer |
| `DL_EverettContact` | Paris_Chateau/DataLinkTrigger12 (429,4042) needs everettsignal, Paris_Chateau/DataLinkTrigger9 (11,3918) needs everettsignal (+3 more) | everettsignal | done FindEverett, +goal GetKeyToCrypt, trig NicoletteRuns |
| `DL_entered_sewer` | Paris_Chateau/DataLinkTrigger7 (-1126,-4306) |  | done GetKeyToCrypt |
| `DL_entered_maze` | (none found) | !DL_EverettContact_Played |  |
| `DL_entered_graveyard` | Paris_Chateau/DataLinkTrigger6 (-496,-3995) | !DL_EverettContact_Played |  |
| `DL_entered_chateau` | Paris_Chateau/DataLinkTrigger4 (107,-93), Paris_Chateau/DataLinkTrigger5 (-561,-1095) |  |  |
| `DL_entered_cellar` | Paris_Chateau/DataLinkTrigger3 (1380,1228) |  |  |
| `DL_creaturecorpse` | Paris_Catacombs/DataLinkTrigger8 (-2962,3854) |  |  |
| `DL_crawling_troops` | (none found) | M10_mj12_attack |  |
| `DL_clubentrance` | Paris_Metro/DataLinkTrigger9 (701,960), Paris_Metro/DataLinkTrigger10 (1906,217), Paris_Metro/DataLinkTrigger14 (2017,65) (+8 more) |  |  |
| `DL_club_entry` | Paris_Club/DataLinkTrigger0 (-2150,-526), Paris_Club/DataLinkTrigger1 (1901,-42) |  |  |
| `DL_beth_bedroom` | (none found) |  |  |
| `DL_bakery` | Paris_Metro/DataLinkTrigger15 (1378,3106), Paris_Metro/DataLinkTrigger16 (724,3104), Paris_Metro/DataLinkTrigger17 (360,2972) (+3 more) |  |  |
| `DL_apartments` | Paris_Metro/DataLinkTrigger22 (2570,1549) |  |  |

**Required (progression) conversations**, from `inventory-campaign.mjs chain 10_Paris_Metro ChopperExit`: `JockReady` (Jock at the metro, bump/frob/radius 200, `A1` branch fires `ChopperExit`) needs `NicoletteReadyToLeave`, set by `NicoletteOutside@Go`; `NicoletteOutside` (Nicolette, bump/frob) needs `NicoletteLeftClub`
(from `Mission10.PreTravel` after `MeetNicolette_Played`) and `!ClubComplete`; `MeetNicolette` is therefore required too. For the last stretch the data names no conversation as a condition of the exit teleporter (`Teleporter0` is touch-only): the chateau's story chain is
`DL_EverettContact` (needs `everettsignal`; adds `GetKeyToCrypt`, fires `NicoletteRuns`) -> `NicoletteAfterEverett` -> `DL_entered_sewer` (completes `GetKeyToCrypt`) -> `DL_EverettMaze` (completes `GoToCrypt`, adds `AccessTemplarComputer`), and the doors on that route (`everettsignal`, `field002`, the crypt)
are what stop the player, not a conversation flag (not proven to be the only route). The hostages' escort, the greasels, the bakery and Defoe are not on the chain.

### 10.4 Objectives

| Goal | Kind | Text | Added by | Completed by |
| --- | --- | --- | --- | --- |
| `FindNicolette` | primary | Find Nicolette DuClare. She is known to frequent Club La Porte de l'Enfer. | DL_tunnels_down, ChadThankful | NicoletteOutside |
| `FindDuClareComputer` | primary | Find Beth DuClare's secret computer room, which should contain clues to the whereabouts of Morgan Everett. | NicoletteAtChateau | DL_reached_computer |
| `ContactIlluminati` | primary | Make contact with the Illuminati in Paris, where the former Illuminati leader, Morgan Everett, is rumored to be in hiding. | DL_paris_10_start | - |
| `FindSilhouette` | primary | Find Silhouette's hideout in the catacombs and talk to their leader. | DL_paris_10_start | MeetChad |
| `FreeHostages` | secondary | Free the members of Silhouette being held in Bunker 03. | MeetChad | DL_metrosewer, 10_Paris_Catacombs_Tunnels/GoalCompleteTrigger0 |
| `EscortHostages` | secondary | Protect the hostages as they try to make it back to Silhouette's bunker. | MeetChad | DL_metrosewer, Mission10.Timer:139, 10_Paris_Catacombs_Tunnels/GoalCompleteTrigger2 |
| `ReportToChad` | secondary | After the rescue attempt, inform Chad of the hostages' fate. | MeetChad | DL_metrosewer, ChadThankful |
| `MeetJaime` | secondary | Meet Jaime at a cafe in building 19. | DL_metrosewer | M10MeetJaime |
| `GoToCrypt` | primary | Go to the family crypt in the maze behind the chateau and await instructions from Morgan Everett. | NicoletteAfterEverett | DL_EverettMaze |
| `AccessTemplarComputer` | primary | Access the Templar computer system so that Morgan Everett can complete work on a cure for the Gray Death. | DL_EverettMaze | - |
| `FindEverett` | primary | Search the DuClare chateau for evidence of Morgan Everett's relationship with Beth DuClare. | NicoletteOutside | DL_EverettContact |
| `GetKeyToCrypt` | primary | Find Nicolette and get the key to the family crypt. | DL_EverettContact | DL_entered_sewer, NicoletteAfterEverett |
| `GetCrack` | secondary | Get the zyme from the bakery and sell it to Renault. | MeetRenault | RenaultPays |
| `MeetNicolette` | primary | Meet Nicolette behind Club La Porte de l'Enfer. | MeetNicolette | NicoletteOutside |
| `ClearMall` | secondary | Kill the three MJ12 soldiers in the metro station next to the underground mall. Report back to Defoe. | MeetDefoe | DefoeConvos |
| `KillGreasels` | secondary | Kill the four greasels in the sewers, then inform the frightened woman who lives in the apartment ruins. | MeetAimee | GreazelsDead |

### 10.5 Choices with lasting consequences

Set here, alive in a later mission:

| Flag | Set here by | Expires | Read later by |
| --- | --- | --- | --- |
| `KnowsGuntherKillphrase` | conversation M10MeetJaime@Continue | never | M11 checks in M11MeetGunther |

Read here, set earlier:

| Flag | Set earlier by | Read here by |
| --- | --- | --- |
| `JaimeRecruited` | M5 conversation M05MeetJaime@Recruit | checks in DL_metrosewer; script Mission10.FirstFrame:31 |
| `KnowsAboutKillphrase` | M5 conversation PaulInMedLab@Killphrase | checks in M10MeetJaime |

* **Jaime**: see mission 5. `M10MeetJaime@Continue` (the cafe in building 19) sets `KnowsGuntherKillphrase`, which mission 11's `M11MeetGunther` reads; the conversation checks `KnowsAboutKillphrase` (set in mission 5 by `PaulInMedLab`'s `Killphrase` branch) to pick its branch.
* **The hostages**: `SilhouetteHostagesDead` / `SomeRescued` / `AllRescued` (expiration 11) change `ChadThankful` and the catacomb conversations inside this mission only.
* Pawns here with `bImportant`: `NicoletteDuClare`, `Chad`, `Louis`, `Antoine`, `Charlotte`, `Renault`, `Guy`, `MJ12Commando`, `MJ12Troop`, `hostage`, `hostage_female`, `JaimeReyes`, `GuntherHermann`; their death flags are read in this mission (`Chad_Dead` also in the intro map); the rest of the cast of later missions is unaffected.

### 10.6 Progression path

1. Catacombs, then the tunnels (Chad, Silhouette; `MeetChad` completes `FindSilhouette` and adds the hostage goals), the sewer to the metro (`DL_metrosewer`); `DL_tunnels_down` adds `FindNicolette`.
2. Club La Porte de l'Enfer: `MeetNicolette` (behind the club; goal `MeetNicolette`); leaving the club sets `NicoletteLeftClub` through `Mission10.PreTravel`.
3. Metro: Nicolette (`NicoletteOutside`, "Go") and Jock (`JockReady`, branch `A1`) -> `ChopperExit` -> `MapExit1` -> `10_Paris_Chateau` (this entry runs `Mission10.FirstFrame`'s chateau block: `ClubComplete`).
4. Chateau: find Everett's trace (`DL_EverettContact` after `everettsignal`), the key to the crypt (`NicoletteAfterEverett`, `DL_entered_sewer`), the maze (`DL_EverettMaze`).
5. `Teleporter0` (touch) -> `11_Paris_Cathedral#cathedralstart`.

| Map | Tag (movers) | Lock | Opened by |
| --- | --- | --- | --- |
| `10_Paris_Catacombs` | `paris_blastdoor` (2) | locked | Keypad3 Keypad2, Switch2 Switch0 |
| `10_Paris_Catacombs` | `roof_elevator` (1) | unlocked, pick 0.20, not frobbable | Keypad2 Keypad0, LightSwitch LightSwitch1 |
| `10_Paris_Catacombs` | `ug_warehousedoors` (2) | locked, key ug_warehousedoors | Switch2 Switch2 |
| `10_Paris_Catacombs_Tunnels` | `catacombs_blastdoorC` (1) | unlocked, key catacombs_blastdoor | frob |
| `10_Paris_Catacombs_Tunnels` | `catacombs_blastdoorB` (1) | locked, key catacombs_blastdoor | frob |
| `10_Paris_Catacombs_Tunnels` | `catacombs_blastdoor02` (1) | locked, key catacombs_blastdoor02 | frob |
| `10_Paris_Catacombs_Tunnels` | `SilSecretDoor` (1) | unlocked, pick 0.20, not frobbable | DeusExMover DeusExMover10, LightSwitch LightSwitch0, DeusExMover DeusExMover3 |
| `10_Paris_Catacombs_Tunnels` | `maintdoors` (2) | locked, pick 0.85, breakable 0.50 | Switch1 Switch1 |
| `10_Paris_Chateau` | `everettsignal` (2) | locked | script Mission10:176 |
| `10_Paris_Chateau` | `cellar_door` (1) | unlocked, not frobbable | LightSwitch LightSwitch2, Dispatcher Dispatcher0 |
| `10_Paris_Chateau` | `dumbwaiter` (1) | unlocked, pick 1.00, not frobbable | LightSwitch LightSwitch0, LightSwitch LightSwitch1 |
| `10_Paris_Chateau` | `nico_fireplace` (1) | unlocked, pick 0.20, not frobbable | BoneSkull BoneSkull1 |
| `10_Paris_Chateau` | `field002` (4) | locked, pick 0.20, not frobbable | Keypad3 Keypad2 |
| `10_Paris_Chateau` | `secret_candle` (1) | unlocked, pick 0.20, not frobbable | Dispatcher Dispatcher0 |
| `10_Paris_Club` | `club_maindoors02` (1) | locked, breakable 0.90 | frob |
| `10_Paris_Club` | `storeroom_door` (1) | locked, breakable 0.75 | Keypad1 Keypad0, Switch2 Switch0 |

Key doors (a placed `NanoKey` opens them, or the lock is picked; frob only): `cata_officedoor` x3, `catacombs_blastdoor`, `nico_room`, `beth_room` x2, `duclare_chateau` x4, `club_maindoors` x3, `hotel_roomdoor` x2.

(25 further movers of these maps are locked with a pickable lock or breakable, take no key that exists as a placed `NanoKey` and are fired by no event: not listed.)

**Progression blocker (mission 10).** The first of: `MeetNicolette` not played / `NicoletteLeftClub` not set by the Club's `PreTravel`; `NicoletteOutside` "Go" or `JockReady` `A1` not firing `ChopperExit`; the `everettsignal` doors; the chateau key chain; `Teleporter0` not carrying the player to the cathedral.

### 10.7 Slots

| Slot | Map | Saved as | Saves, play time | Important NPCs dead or knocked out (all) | Lasting-choice flags in the file (all) | Goals still open |
| --- | --- | --- | --- | --- | --- | --- |
| N0025 | `10_Paris_Catacombs` | Paris - Denfert-Rochereau | 444, 765 min | AnnaNavarre, DrugDealer, Gatekeeper, GilbertTerrorist, JoeGreene, JoJoFine, JosephManderley, JuanLebedev, MaggieChow, MJ12Commando, PrivateLloyd, Supervisor01, Terrorist | AmbrosiaTagged, BathroomBarks_Played, FilbenGaveKey, GreenKnowsAboutDowd, GuntherFreed, GuntherRespectsPlayer=0, HeardGrenadeTalk, HelpSailor, JacobsonRecruited, JaimeRecruited, KnowsAboutKillphrase, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, M04MetWalton, M08WarnedSmuggler, MeetJoeGreen_Played, PlayerMetFilben, SandraWentToCalifornia | FindSilhouette, ContactIlluminati |
| N0026 | `10_Paris_Catacombs_tunnels` | Paris - Catacombs | 463, 792 min | AnnaNavarre, DrugDealer, Gatekeeper, GilbertTerrorist, JoeGreene, JoJoFine, JosephManderley, JuanLebedev, MaggieChow, MJ12Commando, MJ12Troop, PrivateLloyd, Supervisor01, Terrorist | AmbrosiaTagged, BathroomBarks_Played, FilbenGaveKey, GreenKnowsAboutDowd, GuntherFreed, GuntherRespectsPlayer=0, HeardGrenadeTalk, HelpSailor, JacobsonRecruited, JaimeRecruited, KnowsAboutKillphrase, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, M04MetWalton, M08WarnedSmuggler, MeetJoeGreen_Played, PlayerMetFilben, SandraWentToCalifornia | FindSilhouette, ContactIlluminati |
| N0027 | `10_Paris_Metro` | Paris - Near Champs Elysses | 486, 823 min | AnnaNavarre, DrugDealer, Gatekeeper, GilbertTerrorist, JoeGreene, JoJoFine, JosephManderley, JuanLebedev, MaggieChow, MJ12Commando, MJ12Troop, PrivateLloyd, Supervisor01, Terrorist | AmbrosiaTagged, BathroomBarks_Played, FilbenGaveKey, GreenKnowsAboutDowd, GuntherFreed, GuntherRespectsPlayer=0, HeardGrenadeTalk, HelpSailor, JacobsonRecruited, JaimeRecruited, KnowsAboutKillphrase, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, M04MetWalton, M08WarnedSmuggler, MeetJoeGreen_Played, PlayerMetFilben, SandraWentToCalifornia | ContactIlluminati, FindNicolette |

Three slots: the catacombs (N0025), the tunnels (N0026) and the metro (N0027). All three have `JaimeRecruited` (so `Mission10.FirstFrame:31` does not unhide Jaime in them). N0027 has `MeetChad_Played` and `SilhouetteRescueComplete` but not `MeetNicolette_Played`/`NicoletteLeftClub`: the Club step and
`JockReady` are still ahead. The chateau and the cathedral have no slot.

## Mission 11: Paris (cathedral, metro, Everett's estate)

Three maps and the shortest list of the Paris pair. The player takes the Templar cathedral from MJ12 (gold, the Templar computer, and Gunther Hermann, who is a killswitch-controlled MJ12 agent now), meets Toby Atanwe in the metro station, is *taken* by a script to Morgan Everett's home,
and leaves with Jock for Vandenberg. Of the missions 1 to 15 it is the only one with **no real save slot**.

### 11.1 Maps and arrival

| Map | Actors | Level info (`MapName`; `MissionLocation`) | Startup text | Script | Arrives from | Leaves to |
| --- | --- | --- | --- | --- | --- | --- |
| `11_Paris_Cathedral` | 3005 | 11_Paris_Cathedral; Paris - Knights Templar Cathedral | Paris / Near Target Complex: / Knights Templar Cathedral | Mission11 | 10_Paris_Chateau#cathedralstart; 11_Paris_Underground#Paris_Underground | 11_Paris_Underground#Paris_Underground |
| `11_Paris_Everett` | 1526 | 11_Paris_Everett; Paris - Morgan Everett's Home | Morgan Everett's Home / Somewhere In Paris | Mission11 | - | 12_Vandenberg_Cmd (path Camera1) |
| `11_Paris_Underground` | 586 | 11_Paris_Underground; Paris - Metro Station | Metro Station | Mission11 | 11_Paris_Cathedral#Paris_Underground | 11_Paris_Cathedral#Paris_Underground |

* **Arrival.** `10_Paris_Chateau` `Teleporter0` -> `11_Paris_Cathedral#cathedralstart`. Mission change 10 -> 11, `Save\Current` wiped, `DeleteExpiredFlags(11)`.
* **Inside.** Cathedral `Teleporter0` <-> Underground `Teleporter0` (portal `Paris_Underground`, both ways). **`11_Paris_Everett` is the target of no exit and no teleporter**: `Mission11.Timer` calls `Level.Game.SendPlayer(Player, "11_PARIS_EVERETT")` (`:61`) when `MeetTobyAtanwe_Played` is set in the Underground (flag `MS_PlayerTeleported`).
* **Leaving.** `11_Paris_Everett` `MapExit1` (camera `Camera1`, tag `CalledByDispatcher`) -> `12_Vandenberg_cmd`, fired by `Dispatcher0` (`OutEvents` = `ChopperExit`), which `TakeOff` triggers on its `Go` branch.

| Map | Actor | At | Leads to | Fired by (events targeting its tag) |
| --- | --- | --- | --- | --- |
| `11_Paris_Everett` | MapExit `MapExit1` | 299,1827,1207 | `12_Vandenberg_cmd` (path `Camera1`) | tag `CalledByDispatcher`: Dispatcher Dispatcher0 |

**11_Paris_Everett MapExit1 -> 12_Vandenberg_cmd** (tag `CalledByDispatcher`)

```text
event CalledByDispatcher
  Dispatcher Dispatcher0 (OutEvents) tag ChopperExit
    event ChopperExit
      conversation event Trigger "ChopperExit" in TakeOff branch Go
        conversation TakeOff [talk bump/frob/radius 350; owner BlackHelicopter]
          starts: its actor (bump/frob/radius 350)
```

### 11.2 Mission script `Mission11`

`.cache/research/src/DeusEx/Mission11.uc`, 137 lines. `FirstFrame` and `PreTravel` only call `Super`.

* `Timer` (`:34-133`): **Underground**: `templar_upload` -> Toby enters (`MS_TobyUnhidden`); `MeetTobyAtanwe_Played` -> **`SendPlayer(Player, "11_PARIS_EVERETT")`** (`:57-62`). **Everett's**: `MeetEverett_Played` -> the `BlackHelicopter` enters (`MS_ChopperUnhidden`); `AtanweAtEveretts_Played` -> Alex Jacobson enters;
  `Ray_Dead` completes `KillMechanic`. **Cathedral**: `M11MeetGunther_Played` and `KillGunther` -> Gunther loses `bInvincible`, is set to health 0 and sent to the state `KillswitchActivated`, and the script sets **`GuntherHermann_Dead` permanently** (`flags.SetBool('GuntherHermann_Dead', True,, 0)`, `:107`) and `MS_GuntherKilled`;
  `templar_upload` and `M11NearWalt` -> Walton enters (`MS_M11WaltAppeared`), `M11WaltonHolo_Played` -> he leaves.
* Flags it sets: `MS_*` with expiration 12 (alive through mission 11) and `GuntherHermann_Dead` (0). Map FlagTriggers: `templar_upload` (`11_Paris_Cathedral/FlagTrigger2`), `M11NearWalt` (`FlagTrigger1`), `MeetEverett_Played` (`11_Paris_Everett/FlagTrigger1`), all expiration 12.
* Actors it touches: `TobyAtanwe`, `BlackHelicopter`, `AlexJacobson`, `GuntherHermann`, `WaltonSimons`.

Generated from the script's calls (`inventory-campaign.mjs scripts`; `:N` is the first line):

* **Flags set** (9; `eN` = explicit expiration N, otherwise the default): `MS_TobyUnhidden` e12 (:53), `MS_PlayerTeleported` e12 (:60), `MS_ChopperUnhidden` e12 (:73), `MS_AlexUnhidden` e12 (:83), `MS_RayDead` e12 (:91), `GuntherHermann_Dead` e0 (:107), `MS_GuntherKilled` e12 (:108), `MS_M11WaltAppeared` e12 (:120), `MS_M11WaltRemoved` e12 (:130).
* **Flags read** (17): `templar_upload`, `MS_TobyUnhidden`, `MeetTobyAtanwe_Played`, `MS_PlayerTeleported`, `MeetEverett_Played`, `MS_ChopperUnhidden`, `AtanweAtEveretts_Played`, `MS_AlexUnhidden`, `Ray_Dead`, `MS_RayDead`, `M11MeetGunther_Played`, `KillGunther`, `MS_GuntherKilled`, `M11NearWalt`, `MS_M11WaltAppeared`, `M11WaltonHolo_Played`, `MS_M11WaltRemoved`.
* **InfoLinks it starts**: none. **Conversations it starts by name**: none. **Goals it completes**: `KillMechanic` (:90).
* **Spawns**: none. **Destroy calls**: 0; **EnterWorld/LeaveWorld calls**: 5. **Travel calls**: `:61 Level.Game.SendPlayer(Player, "11_PARIS_EVERETT");`.

### 11.3 Conversations and InfoLinks

72 conversations of the list besides the shared barks: 24 InfoLinks, 25 talk-type, 23 overheard. 5 have choices (`MetroTechnicianConvos` (a shop and a revenge branch), `TellLucius`, `MeetTobyAtanwe`,
**`M11MeetGunther`**, `TakeOff`), 11 set flags, 53 need a flag, 14 add or complete goals.

**Choices.** Every choice that changes state, the block its speech jumps to and what that block does (choices that change no state are counted in one row per conversation):

| Conversation | Owner | Choice | Effects of the branch |
| --- | --- | --- | --- |
| `MeetTobyAtanwe` | TobyAtanwe | (2 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `MetroTechnicianConvos` | MetroTechnician | Here's 750 for the accuracy weapon mod. [needs !M11BoughtAccuracy, M11CanBuyAccuracy] | -> BuyAccuracy: set M11BoughtAccuracy, give WeaponModAccuracy |
| `MetroTechnicianConvos` | MetroTechnician | A range weapon mod for 800 -- deal. [needs !M11BoughtRange, M11CanBuyRange] | -> BuyRange: set M11BoughtRange, give WeaponModRange |
| `MetroTechnicianConvos` | MetroTechnician | I'll take the thermoptic camo for 5000. [needs !M11BoughtArmor, M11CanBuyArmor] | -> BuyArmor: set M11BoughtArmor, give AdaptiveArmor |
| `MetroTechnicianConvos` | MetroTechnician | I turned you in. Maybe you should've given me that discount. | -> Confront: set MetroTechnicianFleeing, trig MetroTechnicianFlees |
| `MetroTechnicianConvos` | MetroTechnician | I'm willing to pay full price. Let's see the hardware. | -> FullPrice: set M11CanBuyAccuracy=0, set M11CanBuyArmor=0, set M11CanBuyRange=0 |
| `MetroTechnicianConvos` | MetroTechnician | (4 further choices that change no state: refusals, "never mind", unaffordable offers) | - |
| `TellLucius` | LuciusDeBeers | Everett has no intention of reviving you. | -> Truth: set LuciusKnowsTruth, done TellLucius |
| `TellLucius` | LuciusDeBeers | Everett will be here as soon as he can. | -> Lie: done TellLucius |
| `M11MeetGunther` | GuntherHermann | I know your UNATCO killphrase: Laputan machine. | -> Kill: set KillGunther, trig GuntherKillSwitch |
| `M11MeetGunther` | GuntherHermann | I know you hate being a tool for a bunch of bureaucrats as much as I d | -> Gentleman: trig CathedralGuntherAttacks |
| `TakeOff` | BlackHelicopter | Let's go. | -> Go: +goal MeetJock, trig ChopperExit |
| `TakeOff` | BlackHelicopter | (1 further choice that change no state: refusals, "never mind", unaffordable offers) | - |

**Conversations that change state** (choices, flags set, goals, items, events, skill points; the `Needs` column is kept on these rows):

| Conversation | Owner (BindName; maps with that actor) | Kind | Choices | Sets | Needs | Goals | Other |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `DL_tobywaiting` | JCDenton | DL once |  |  | req templar_upload | done GoToMetroStation |  |
| `DL_morganraythanks` | JCDenton | DL once |  | MorganRayDeadComment | req Ray_Dead, req MorganMechanicComment, req !MorganRayDeadComment | done KillMechanic |  |
| `DL_morganhelipad` | JCDenton | DL once |  |  |  | done MeetJock | trig TobyLeaving |
| `DL_morgan_uplink` | JCDenton | DL once |  |  | req templar_upload | done AccessTemplarComputer, +P GoToMetroStation |  |
| `DL_metroentrance_after` | JCDenton | DL once |  |  | req templar_upload | done GoToMetroStation, +P MeetTobyAtanwe |  |
| `DL_intro_cathedral` | JCDenton | DL once |  |  |  | +S RecoverGold | give Image11_Paris_Cathedral |
| `DL_gold_found` | JCDenton | DL once |  |  |  | done RecoverGold |  |
| `DL_cathedralfirst` | JCDenton | DL once |  |  | req !templar_upload |  | give Image11_Paris_CathedralEntrance |
| `MeetTobyAtanwe` | TobyAtanwe (Paris_Everett, Paris_Underground) | talk bump/frob/radius 160 once | 2 |  |  | done MeetTobyAtanwe | sp 150 |
| `AtanweAtEveretts` | TobyAtanwe (Paris_Everett, Paris_Underground) | talk bump/frob/radius 120 once |  |  | req MeetTobyAtanwe_Played |  | trig TobyWanders |
| `MeetSwelter` | Swelter (Paris_Cathedral) | talk bump/frob once |  |  | ? !templar_upload, ? !dl_gold_found_played | +note |  |
| `MeetRay2` | Ray (Paris_Everett) | talk bump/frob once |  |  | req EverettMechanicComment |  | trig RayRuns |
| `MeetRay` | Ray (Paris_Everett) | talk bump/frob/radius 160 once |  | NeedRayComment |  |  |  |
| `TalkAboutAI` | MorganEverett (Paris_Everett) | talk bump/frob |  | EverettAIComment@Start | req MeetAI_Played, req MeetEverett_Played, req !MeetEverett2_Played, req !EverettAIComment, req !NeedRayComment, ? MeetRay_Played, ? !EverettMechanicComment, ? Ray_Dead, ? EverettRayDeadComment |  |  |
| `MeetEverett2` | MorganEverett (Paris_Everett) | talk bump/frob once |  | EverettMechanicComment@RayComment, NeedRayComment=0@RayComment, EverettMechanicComment@deadset, EverettRayDeadComment@deadset, NeedRayComment=0@deadset, NeedRayDeadComment=0@deadset, EverettRayDeadComment@Dead (+1 more) | req MeetEverett_Played, ? M11MeetAlex_Played, ? MeetRay_Played, ? MeetLuciusDeBeers_Played, ? !DeBeersDead, ? !PlayerColdComment, ? Ray_Dead | +S KillMechanic, done KillMechanic |  |
| `MeetEverett` | MorganEverett (Paris_Everett) | talk bump/frob/radius 100 once |  | PlayerColdComment@LuciusHop | ? MeetLuciusDeBeers_Played, ? !DeBeersDead, ? MeetRay_Played, ? !EverettMechanicComment, ? Ray_Dead, ? EverettRayDeadComment | done ContactIlluminati, +P MeetJock, done TellEverett, +S TellLucius | give Nanokey |
| `MetroTechnicianConvos` | MetroTechnician (Paris_Underground) | talk bump/frob | 9 | M11CanBuyAccuracy=0@ChoiceStart, M11CanBuyArmor=0@ChoiceStart, M11CanBuyRange=0@ChoiceStart, MetroTechnicianDone@Done, M11BoughtAccuracy@BuyAccuracy, M11BoughtRange@BuyRange, M11BoughtArmor@BuyArmor (+6 more) | req !MetroTechnicianDone, req !MetroTechnicianFleeing, ? MetroTechnicianConvos_Played, ? !AccusedMetroTechnician, ? KnowsAboutTheft, ? M11BoughtAccuracy, ? M11BoughtArmor, ? M11BoughtRange, ? Taddle_Played (+1 more) |  | trig MetroTechnicianFlees, give WeaponModAccuracy, give WeaponModRange, give AdaptiveArmor, cr -6550 |
| `M11WaltonHolo` | M11WaltonButton (Paris_Cathedral) | talk bump/frob/radius 600 once |  | M11MetWalton | req templar_upload, req MS_M11WaltAppeared, req GuntherHermann_Dead |  |  |
| `TellLucius` | LuciusDeBeers (Paris_Everett) | talk bump/frob/radius 100 once | 2 | LuciusKnowsTruth@Truth | req !DeBeersDead, req PlayerColdComment | done TellLucius |  |
| `MeetLuciusDeBeers` | LuciusDeBeers (Paris_Everett) | talk bump/frob/radius 100 once |  |  | req !DeBeersDead | +S TellEverett |  |
| `LuciusDies` | LuciusDeBeers (Paris_Everett) | ovh bump/frob/radius 300 once |  |  | req DeBeersDead | done TellEverett |  |
| `M11MeetGunther` | GuntherHermann (Paris_Cathedral) | talk bump/frob/radius 280 once | 2 | KillGunther@Kill | ? !GuntherFreed, ? GuntherFreed, ? !GuntherRespectsPlayer, ? !KnowsGuntherKillphrase |  | trig CathedralGuntherAttacks, trig GuntherKillSwitch |
| `CarmelaBarks` | Carmela (Paris_Everett) | ovh bump/frob/radius 300 |  | CarmelaLuciusComment@Comment | req !CarmelaLuciusComment, ? !CarmelaLuciusComment, ? MeetEverett_Played |  |  |
| `TakeOff` | BlackHelicopter (Paris_Everett) | talk bump/frob/radius 350 | 2 | GotHelicopterInfo@Mechanic, GotHelicopterInfo@DeadMechanic, GotHelicopterInfo@UnconsciousMechanic | ? TakeOff_Played, ? !GotHelicopterInfo, ? Ray_Dead, ? !EverettMechanicComment, ? Ray_Unconscious, ? EverettMechanicComment | +P MeetJock, done KillMechanic | trig ChopperExit |

Conversations that only wait for a flag or check one, and change no state (38; `?` = a `CheckFlag` event): `DL_roof` (!templar_upload), `DL_metroentrance_before` (!templar_upload), `DL_Icarus_optional_cathedral` (!templar_upload), `DL_Icarus_badmove` (templar_upload), `DL_Icarus_aggressive` (templar_upload), `DL_guntherroof` (!templar_upload, !GuntherHermann_Dead), `DL_guntherprowling` (!templar_upload, !GuntherHermann_Dead, ? AnnaNavarre_Dead), `DL_gunthernearcomp` (!templar_upload, !GuntherHermann_Dead), `DL_guntherbalcony` (!templar_upload, !GuntherHermann_Dead), `DL_EverettDeBeersComment` (DeBeersDead, ? PlayerColdComment, ? !MeetEverett_Played), `AtanweBarks` (AtanweAtEveretts_Played), `SwelterBarks` (MeetSwelter_Played), `RayBarks2` (MeetRay2_Played), `RayBarks` (MeetRay_Played (+1 more)), `TalkAboutRay` (MeetEverett2_Played, NeedRayComment), `TalkAboutAI2` (MeetAI_Played, MeetEverett2_Played, !EverettAIComment, !NeedRayComment), `LuciusCold` (MeetLuciusDeBeers_Played, !PlayerColdComment, !DeBeersDead, MeetEverett2_Played (+1 more)), `EverettBarks5` (!PlayerColdComment (+5 more)), `EverettBarks4` (!PlayerColdComment (+5 more)), `EverettBarks3` (PlayerColdComment, EverettAIComment (+2 more)), `EverettBarks2` (PlayerColdComment, !MeetAI_Played (+2 more)), `EverettBarks` (!PlayerColdComment (+3 more)), `MetroTechnicianFleeing` (MetroTechnicianFleeing), `MetroTechnicianBarks` (MetroTechnicianDone (+1 more)), `Taddle` (AccusedMetroTechnician), `MetroStationCopBumpBarks` (Taddle_Played), `MetroStationCopBumpBarks` (!AccusedMetroTechnician), `LuciusFinalIrate` (LuciusKnowsTruth, TellLucius_Played (+1 more)), `LuciusFinalCalm` (!LuciusKnowsTruth, TellLucius_Played (+1 more)), `LuciusDeBeersBarks` (MeetLuciusDeBeers_Played (+2 more)), `CarmelaDeBeers` (CarmelaLuciusComment, ? !MeetLuciusDeBeers_Played), `CarmelaBarks2` (CarmelaLuciusComment (+1 more)), `M11MeetAlex2` (M11MeetAlex_Played), `M11AlexBarks` (M11MeetAlex2_Played), `MeetAI4` (MeetAI3_Played), `MeetAI3` (MeetAI2_Played), `MeetAI2` (MeetAI_Played), `AIBarks` (MeetAI4_Played).

Plain InfoLinks, no flag and no event: 6 (listed with their starters in the InfoLink table).

Plain conversations with an actor (2): AlexJacobson: M11MeetAlex; AIPrototype: MeetAI.

Plain overheard conversations (2): MetroStationCop: MetroStationCopBarks; FirePlaceMJ12Troop01: FirePlaceBarks.

InfoLinks and what starts them:

| InfoLink | Started by | Needs | Sets / does |
| --- | --- | --- | --- |
| `DL_tobywaiting` | Paris_Underground/DataLinkTrigger0 (381,-1769) | templar_upload | done GoToMetroStation |
| `DL_roof` | Paris_Cathedral/DataLinkTrigger18 (3424,297) needs !templar_upload | !templar_upload |  |
| `DL_oddlight` | (none found) |  |  |
| `DL_morganraythanks` | (none found) | Ray_Dead, MorganMechanicComment, !MorganRayDeadComment | set MorganRayDeadComment, done KillMechanic |
| `DL_morganhelipad` | Paris_Everett/DataLinkTrigger0 (-526,1455) |  | done MeetJock, trig TobyLeaving |
| `DL_morgan_uplink` | Paris_Cathedral/DataLinkTrigger1 (3714,-1087) needs templar_upload, Paris_Cathedral/DataLinkTrigger8 (4510,-626) needs templar_upload | templar_upload | done AccessTemplarComputer, +goal GoToMetroStation |
| `DL_metroentrance_before` | Paris_Underground/DataLinkTrigger20 (384,-1752) | !templar_upload |  |
| `DL_metroentrance_after` | Paris_Cathedral/DataLinkTrigger21 (-4174,-1591), Paris_Cathedral/DataLinkTrigger31 (-4178,-2224), Paris_Cathedral/DataLinkTrigger32 (-4102,-1150) | templar_upload | done GoToMetroStation, +goal MeetTobyAtanwe |
| `DL_knightslibrary` | Paris_Cathedral/DataLinkTrigger2 (3022,10) |  |  |
| `DL_intro_cathedral` | Paris_Cathedral/DataLinkTrigger5 (-2722,3274) |  | +goal RecoverGold, give Image11_Paris_Cathedral |
| `DL_Icarus_optional_cathedral` | Paris_Cathedral/DataLinkTrigger24 (3404,-2191) | !templar_upload |  |
| `DL_Icarus_Everett` | Paris_Everett/DataLinkTrigger25 (95,2037) |  |  |
| `DL_Icarus_badmove` | Paris_Cathedral/DataLinkTrigger13 (314,-798) needs templar_upload | templar_upload |  |
| `DL_Icarus_aggressive` | Paris_Cathedral/DataLinkTrigger12 (-2132,-929) needs templar_upload | templar_upload |  |
| `DL_guntherroof` | Paris_Cathedral/DataLinkTrigger16 (3140,-162) needs !templar_upload | !templar_upload, !GuntherHermann_Dead |  |
| `DL_guntherprowling` | Paris_Cathedral/DataLinkTrigger15 (2200,-551) needs !templar_upload | !templar_upload, !GuntherHermann_Dead, AnnaNavarre_Dead |  |
| `DL_gunthernearcomp` | Paris_Cathedral/DataLinkTrigger14 (3685,-1123) needs !templar_upload, Paris_Cathedral/DataLinkTrigger10 (3677,-1123) needs !templar_upload | !templar_upload, !GuntherHermann_Dead |  |
| `DL_guntherbalcony` | Paris_Cathedral/DataLinkTrigger17 (3570,-1336) needs templar_upload | !templar_upload, !GuntherHermann_Dead |  |
| `DL_goldstorage` | Paris_Cathedral/DataLinkTrigger6 (3939,-3598) |  |  |
| `DL_gold_found` | Paris_Cathedral/DataLinkTrigger0 (3394,-2774) |  | done RecoverGold |
| `DL_EverettDeBeersComment` | Paris_Everett/DataLinkTrigger1 (1385,1431) | DeBeersDead, PlayerColdComment, !MeetEverett_Played |  |
| `DL_chapel` | Paris_Cathedral/DataLinkTrigger9 (1755,-146) |  |  |
| `DL_cathedralfirst` | Paris_Cathedral/DataLinkTrigger19 (-4178,-1583) | !templar_upload | give Image11_Paris_CathedralEntrance |
| `DL_cathedral` | Paris_Cathedral/DataLinkTrigger3 (303,-802), Paris_Cathedral/DataLinkTrigger4 (3315,-1016) |  |  |

**Required (progression) conversations.** Chain: `TakeOff` (the helicopter's conversation, bump/frob/radius 350, no flag requirement; "Let's go." fires `ChopperExit`) needs the helicopter to be in the world: `MeetEverett_Played` (Everett's `MeetEverett`, radius 100, or his `FlagTrigger1`);
Everett's map is reached only by the script travel after `MeetTobyAtanwe` (Toby, radius 160), who appears when `templar_upload` is set (the Cathedral's `FlagTrigger2`; `DL_morgan_uplink` completes `AccessTemplarComputer` and adds `GoToMetroStation`; `DL_metroentrance_after` adds `MeetTobyAtanwe`).
`M11MeetGunther` is **not required**: both choices ("I know your UNATCO killphrase: Laputan machine" -> `KillGunther`; "How 'bout we make a deal?" -> `CathedralGuntherAttacks`) leave the chain intact; `DL_gold_found`/`RecoverGold` is a side goal.

### 11.4 Objectives

| Goal | Kind | Text | Added by | Completed by |
| --- | --- | --- | --- | --- |
| `GoToMetroStation` | primary | Go to the metro station and await further instructions. | DL_morgan_uplink | DL_tobywaiting, DL_metroentrance_after |
| `KillMechanic` | secondary | Kill the phony mechanic who infiltrated Everett's estate. | MeetEverett2 | DL_morganraythanks, MeetEverett2, TakeOff, Mission11.Timer:90, 11_Paris_Everett/GoalCompleteTrigger0 |
| `MeetJock` | primary | Meet Jock at the helipad. Leave for Vandenberg Airforce Base. | MeetEverett, TakeOff | DL_morganhelipad |
| `AccessTemplarComputer` | carried |  | - | DL_morgan_uplink, 11_Paris_Cathedral/GoalCompleteTrigger0 |
| `MeetTobyAtanwe` | primary | Meet Toby Atanwe, Everett's associate, in the metro station. | DL_metroentrance_after | MeetTobyAtanwe |
| `RecoverGold` | secondary | Recover the gold from the Templars' cathedral, now occupied by MJ12. | DL_intro_cathedral | DL_gold_found, 11_Paris_Cathedral/GoalCompleteTrigger1 |
| `ContactIlluminati` | carried |  | - | MeetEverett |
| `TellEverett` | secondary | Tell Everett that Lucius DeBeers is cold. | MeetLuciusDeBeers | MeetEverett, LuciusDies |
| `TellLucius` | secondary | Tell Lucius that Everett does not intend to revive him? | MeetEverett | TellLucius |

### 11.5 Choices with lasting consequences

Set here, alive in a later mission:

| Flag | Set here by | Expires | Read later by |
| --- | --- | --- | --- |
| `EverettMechanicComment` | conversation MeetEverett2@RayComment; conversation MeetEverett2@deadset | never | M12 checks in TongSick; M14 checks in JockArea51; M15 checks in M15MeetEverett |
| `M11MetWalton` | conversation M11WaltonHolo | never | M14 checks in WaltonShowdown |

Read here, set earlier:

| Flag | Set earlier by | Read here by |
| --- | --- | --- |
| `GuntherFreed` | M1 trigger 01_NYC_UNATCOIsland/FlagTrigger2 | checks in M11MeetGunther |
| `GuntherRespectsPlayer` | M1 conversation GuntherRescued@GiveSpeech; M1 conversation GuntherRescued@GiveNothing; M1 conversation GuntherRescued@GiveNothingNicely | checks in M11MeetGunther |
| `KnowsGuntherKillphrase` | M10 conversation M10MeetJaime@Continue | checks in M11MeetGunther |

* **Gunther** (`M11MeetGunther`): the killphrase branch needs `KnowsGuntherKillphrase` (mission 10, from Jaime, whose conversation checks Paul's `KnowsAboutKillphrase` from mission 5); without it only `NoKillswitch` is offered and Gunther attacks. The branches read `GuntherFreed` (mission 1; false = "not rescued"), `GuntherRespectsPlayer`
  (mission 1; false = "the player refused to arm Gunther"). The killphrase path ends with `KillGunther` and the script's permanent `GuntherHermann_Dead`; the fight path leaves Gunther attacking.
* **The mechanic** (`MeetEverett2`): `EverettMechanicComment` (permanent) is read in mission 12 by `TongSick`, in mission 14 by `JockArea51` and in mission 15 by `M15MeetEverett`; `Ray_Dead` (permanent) is read through mission 15.
* **Walton** (`M11WaltonHolo`, needs `templar_upload`, `MS_M11WaltAppeared` and `GuntherHermann_Dead`): sets `M11MetWalton`, read in mission 14 by `WaltonShowdown`. (So the hologram conversation only plays after Gunther is dead.)
* **Lucius DeBeers** (`TellLucius`: "Everett has no intention of reviving you." sets `LuciusKnowsTruth`; the lie leaves nothing): no reader outside the mission.

### 11.6 Progression path

1. Cathedral, arrival at the `cathedralstart` portal. Take the cathedral (optional: gold, Gunther). Reach the Templar computer (`FlagTrigger2` sets `templar_upload`; `DL_morgan_uplink`).
2. `DL_metroentrance_after` -> `Teleporter0` to the Underground (metro station): Toby appears; `MeetTobyAtanwe` ("Do what you must." / "Forget it. I will find Everett on my own." both continue; the script's `SendPlayer` needs only `MeetTobyAtanwe_Played`).
3. Everett's estate: `MeetEverett` (`FlagTrigger1` sets `MeetEverett_Played`; the helicopter enters; `MeetJock` added); `MeetEverett2`, the mechanic Ray (`KillMechanic`), Alex, Toby are optional.
4. `TakeOff` -> `ChopperExit` -> `CalledByDispatcher` -> `MapExit1` -> `12_Vandenberg_cmd`.

| Map | Tag (movers) | Lock | Opened by |
| --- | --- | --- | --- |
| `11_Paris_Cathedral` | `computervault` (1) | locked | Keypad1 Keypad0 |
| `11_Paris_Cathedral` | `goldvaultdoor` (1) | locked | Keypad1 Keypad1, Switch1 Switch0 |
| `11_Paris_Cathedral` | `secretdoor01` (1) | unlocked, pick 1.00, not frobbable | DeusExMover DeusExMover16, LightSwitch LightSwitch0 |
| `11_Paris_Everett` | `morganhelibaydoor` (1) | locked | frob |
| `11_Paris_Everett` | `AI_room` (1) | locked | Keypad2 Keypad0, Switch1 Switch1 |
| `11_Paris_Everett` | `field001` (4) | unlocked, pick 0.20, not frobbable | Keypad3 Keypad1 |
| `11_Paris_Everett` | `field002` (4) | unlocked, pick 0.20, not frobbable | Keypad3 Keypad2 |
| `11_Paris_Underground` | `pa_slidedoor01` (1) | unlocked, pick 0.20 | Trigger Trigger2 |
| `11_Paris_Underground` | `pa_slidedoor02` (1) | unlocked, pick 0.20 | Trigger Trigger1 |

Key doors (a placed `NanoKey` opens them, or the lock is picked; frob only): `cathedralgatekey`, `cath_maindoors` x5, `fishtankdoor`, `morganmirror`.

(7 further movers of these maps are locked with a pickable lock or breakable, take no key that exists as a placed `NanoKey` and are fired by no event: not listed.)

**Progression blocker (mission 11).** `templar_upload` never set; Toby not appearing or `MeetTobyAtanwe` not played; the script `SendPlayer` not travelling to `11_Paris_Everett` (this travel has no `MapExit` or teleporter behind it: a Play without script-initiated travel would stop here);
`MeetEverett_Played` not set (no helicopter); `TakeOff` not firing `ChopperExit`; `MapExit1` not loading Vandenberg.

### 11.7 Slots

None of the 41 real slots is in Paris' second half: the playthrough's slots go from the metro of mission 10 (N0027) to Vandenberg (N0028). A row for mission 11 starts from the previous mission's exit or from a harness placement.

## Mission 12: Vandenberg Air Force Base

Four maps (`12_Vandenberg_Tunnels` has **no mission script**). The player lands at the base's command building, destroys the bots that hold it, finds Gary Savage, restores the computer system so Daedalus can be uplinked, listens to Bob Page's hostage demand,
and flies with Jock to the gas station to rescue Gary's daughter Tiffany before leaving for the sub base. The mission is told by its goals: 8 of the list's 22 InfoLinks add or complete one.

### 12.1 Maps and arrival

| Map | Actors | Level info (`MapName`; `MissionLocation`) | Startup text | Script | Arrives from | Leaves to |
| --- | --- | --- | --- | --- | --- | --- |
| `12_Vandenberg_Cmd` | 3365 | 12_Vandenberg_cmd; Vandenberg - Command | Command Center / Vandenberg Airforce Base | Mission12 | 11_Paris_Everett (path Camera1); 12_Vandenberg_Computer#hall; 12_Vandenberg_Tunnels#commstat/storage x5 | 12_Vandenberg_Tunnels#start/end x2; 12_Vandenberg_Gas (path heli_camera); 12_Vandenberg_Computer#computer |
| `12_Vandenberg_Computer` | 1215 | 12_vandenberg_computer; Vandenberg - Computer | - | Mission12 | 12_Vandenberg_Cmd#computer | 12_Vandenberg_Cmd#hall |
| `12_Vandenberg_Gas` | 1338 | 12_vandenberg_gas; Vandenberg - Gas | Abandoned Gas Station / Central California | Mission12 | 12_Vandenberg_Cmd (path heli_camera) | 14_Vandenberg_Sub (path heli_camera) |
| `12_Vandenberg_Tunnels` | 1537 | 12_Vandenberg_tunnels; Vandenberg - Tunnels | - | (none) | 12_Vandenberg_Cmd#start/end x2 | 12_Vandenberg_Cmd#commstat/storage x5 |

* **Arrival.** `11_Paris_Everett` `MapExit1` (camera `Camera1`, tag `CalledByDispatcher`) -> `12_vandenberg_cmd`: `PlayerStart2` (657,2502,-909). Mission change 11 -> 12 (`Save\Current` wiped, `DeleteExpiredFlags(12)`).
* **Inside.** Cmd <-> Computer (`hall`/`computer` teleporters); Cmd <-> Tunnels by `MapExit`s (Cmd: `start`, `end`; Tunnels: `commstat` and four to `storage`, all touch except `MapExit0`, `tunnels_end`, which a dispatcher fires); Cmd `MapExit0` (camera `heli_camera`, tag `mission_done`) -> `12_Vandenberg_gas`.
  `12_Vandenberg_Gas` also has two `MapExit`s without a destination (`MapExit6`, `MapExit7`): set by script or unused (unverified).
* **Leaving.** `12_Vandenberg_Gas` `MapExit0` (camera `heli_camera`, tag `UN_BlackHeli`) -> `14_Vandenberg_sub` (mission 14: the numbering skips 13).
* **Tunnels have no script**: with `Script` None in their `DeusExLevelInfo`, no `MissionScript` is spawned there, so no `Timer`, no `FirstFrame` (the `PlayerTraveling` flag set by the travel in is not removed in this map; the next map's first Timer finds it still set and runs its `DeleteExpiredFlags`/`FirstFrame`): unverified in Play.

| Map | Actor | At | Leads to | Fired by (events targeting its tag) |
| --- | --- | --- | --- | --- |
| `12_Vandenberg_Cmd` | MapExit `MapExit4` | -1593,4570,-2297 | `12_vandenberg_tunnels#start` | touch |
| `12_Vandenberg_Cmd` | MapExit `MapExit1` | 813,1258,-2164 | `12_vandenberg_tunnels#end` | touch |
| `12_Vandenberg_Cmd` | MapExit `MapExit0` | 6685,8130,-2369 | `12_Vandenberg_gas` (path `heli_camera`) | tag `mission_done`: Dispatcher Dispatcher10 |
| `12_Vandenberg_Gas` | MapExit `MapExit6` | -4144,-3328,-1503 | `` | touch |
| `12_Vandenberg_Gas` | MapExit `MapExit7` | -4135,-4125,-1503 | `` | touch |
| `12_Vandenberg_Gas` | MapExit `MapExit0` | -2640,-235,-978 | `14_Vandenberg_sub` (path `heli_camera`) | tag `UN_BlackHeli`: conversation M12JockFinal2[Start], conversation M12JockFinal2[Dead] |
| `12_Vandenberg_Tunnels` | MapExit `MapExit1` | -1626,5744,-2365 | `12_vandenberg_cmd#commstat` | touch |
| `12_Vandenberg_Tunnels` | MapExit `MapExit0` | 121,1127,-2212 | `12_vandenberg_cmd#storage` | tag `tunnels_end`: Dispatcher Dispatcher2 |
| `12_Vandenberg_Tunnels` | MapExit `MapExit2` | 410,867,-2140 | `12_vandenberg_cmd#storage` | touch |
| `12_Vandenberg_Tunnels` | MapExit `MapExit3` | 692,1192,-2140 | `12_vandenberg_cmd#storage` | touch |
| `12_Vandenberg_Tunnels` | MapExit `MapExit4` | 396,1468,-2140 | `12_vandenberg_cmd#storage` | touch |

**12_Vandenberg_Cmd MapExit4 -> 12_vandenberg_tunnels#start**

Touch only: no event source in the data; what keeps the player from the actor is geometry (doors, locks) and is not read here.

**12_Vandenberg_Cmd MapExit1 -> 12_vandenberg_tunnels#end**

Touch only: no event source in the data; what keeps the player from the actor is geometry (doors, locks) and is not read here.

**12_Vandenberg_Cmd MapExit0 -> 12_Vandenberg_gas** (tag `mission_done`)

```text
event mission_done
  Dispatcher Dispatcher10 (OutEvents[1]) tag map_exit
    event map_exit
      conversation event Trigger "Map_Exit" in TongSick branch Hop
        conversation TongSick [talk; owner Jock]
          starts: jump from TongTrigger
            conversation TongTrigger [talk bump/frob/radius 300; owner TracerTong]
      conversation event Trigger "Map_Exit" in TongSick branch Rattle
        conversation TongSick [talk; owner Jock] (seen above)
```

**12_Vandenberg_Gas MapExit0 -> 14_Vandenberg_sub** (tag `UN_BlackHeli`)

```text
event UN_BlackHeli
  conversation event Trigger "UN_BlackHeli" in M12JockFinal2 branch Start
    conversation M12JockFinal2 [talk bump/frob/radius 200; owner Jock]
      starts: jump from M12JockFinal; its actor (bump/frob/radius 200)
        conversation M12JockFinal [talk bump/frob/radius 200; owner Jock]
          starts: its actor (bump/frob/radius 200)
          flag TiffanyRescued: set by conversation DL_TiffanyDead; conversation MeetTiffanySavage; script Mission12.Timer:124
            conversation DL_TiffanyDead [DL bump/frob; owner JCDenton]
            conversation MeetTiffanySavage [talk bump/frob/radius 70; owner TiffanySavage]
          flag !TiffanySavage_Dead: set by death TiffanySavage dies (ScriptedPawn.Died, bImportant)
          flag TiffanyHeli: set by trigger 12_Vandenberg_Gas/FlagTrigger2
      flag TiffanySavage_Dead: set by death TiffanySavage dies (ScriptedPawn.Died, bImportant)
      flag TiffanyRescued: set by conversation DL_TiffanyDead; conversation MeetTiffanySavage; script Mission12.Timer:124
  conversation event Trigger "UN_BlackHeli" in M12JockFinal2 branch Dead
    conversation M12JockFinal2 [talk bump/frob/radius 200; owner Jock] (seen above)
```

**12_Vandenberg_Tunnels MapExit1 -> 12_vandenberg_cmd#commstat**

Touch only: no event source in the data; what keeps the player from the actor is geometry (doors, locks) and is not read here.

**12_Vandenberg_Tunnels MapExit0 -> 12_vandenberg_cmd#storage** (tag `tunnels_end`)

```text
event tunnels_end
  Dispatcher Dispatcher2 (OutEvents) tag end_cmd
    event end_cmd
      DeusExMover DeusExMover30 (Event) tag storage_door
        event storage_door
```

**12_Vandenberg_Tunnels MapExit2 -> 12_vandenberg_cmd#storage**

Touch only: no event source in the data; what keeps the player from the actor is geometry (doors, locks) and is not read here.

**12_Vandenberg_Tunnels MapExit3 -> 12_vandenberg_cmd#storage**

Touch only: no event source in the data; what keeps the player from the actor is geometry (doors, locks) and is not read here.

**12_Vandenberg_Tunnels MapExit4 -> 12_vandenberg_cmd#storage**

Touch only: no event source in the data; what keeps the player from the actor is geometry (doors, locks) and is not read here.

### 12.2 Mission script `Mission12`

`.cache/research/src/DeusEx/Mission12.uc`, 169 lines.

* `FirstFrame` (`:12-43`): Cmd: `GaryHostageBriefing_Played` -> the helicopter enters, Jock and Tracer Tong enter (`:23-31`); Gas: `RescueBegan` (expiration 14); `SandraWentToCalifornia` (**mission 4, permanent**) -> Sandra Renton enters (`:37-41`).
* `PreTravel` (`:51-54`): `Super` only. No `SendPlayer`/`ClientTravel`.
* `Timer` (`:62-165`): Cmd: counts the `Robot`s tagged `enemy_bot` with EMP hit points left: 3, 2, 1 -> `DL_bots_left_3/2/1`, 0 -> `DL_command_bots_destroyed` (`MS_DL_Played`, expiration 14); `CapturedScientistRescued` when both `MJ12_hazlab_troopN` are gone; Gas: `MeetTiffanySavage_Played` or `TiffanySavage_Dead` ->
  the helicopter enters, the `junkyard_doors` blow up, `TiffanyRescued` (expiration 14, **which `M12JockFinal2` needs even when she is dead**) and `MS_ChopperGasUnhidden`; `TiffanySavage_Dead` -> `DL_JockTiffanyDead`; Computer: `M12PageAppears` -> `Earth` hidden, Bob Page enters (`MS_M12PageAppeared`),
  `PageHostageBriefing_Played` -> Page leaves.
* Flags it sets: all with expiration 14 (alive through mission 12 and 13, deleted on entering 14).
* Actors it touches: `BlackHelicopter`, `Jock`, `TracerTong`, `SandraRenton`, `Robot enemy_bot`, `MJ12Troop` by tag, `DeusExMover junkyard_doors`, `Earth`, `BobPage`.

Generated from the script's calls (`inventory-campaign.mjs scripts`; `:N` is the first line):

* **Flags set** (8; `eN` = explicit expiration N, otherwise the default): `RescueBegan` e14 (:35), `MS_DL_Played` e14 (:94), `CapturedScientistRescued` e14 (:107), `TiffanyRescued` e14 (:124), `MS_ChopperGasUnhidden` e14 (:125), `MS_TiffanyDLPlayed` e14 (:133), `MS_M12PageAppeared` e14 (:148), `MS_BobPageHidden` e14 (:162).
* **Flags read** (12): `GaryHostageBriefing_Played`, `SandraWentToCalifornia`, `MS_DL_Played`, `CapturedScientistRescued`, `MS_ChopperGasUnhidden`, `MeetTiffanySavage_Played`, `TiffanySavage_Dead`, `MS_TiffanyDLPlayed`, `MS_M12PageAppeared`, `M12PageAppears`, `MS_BobPageHidden`, `PageHostageBriefing_Played`.
* **InfoLinks it starts**: `DL_bots_left_3` (:86), `DL_bots_left_2` (:88), `DL_bots_left_1` (:90), `DL_command_bots_destroyed` (:93), `DL_JockTiffanyDead` (:132). **Conversations it starts by name**: none. **Goals it completes**: none.
* **Spawns**: none. **Destroy calls**: 0; **EnterWorld/LeaveWorld calls**: 6. **Travel calls**: none.

### 12.3 Conversations and InfoLinks

66 conversations of the list besides the shared barks: 22 InfoLinks, 21 talk-type, 23 overheard. 2 have choices (`MeetTiffanySavage` and the vendor `MeetBum_M`),
7 set flags, 38 need a flag, 16 add or complete goals.

**Choices.** Every choice that changes state, the block its speech jumps to and what that block does (choices that change no state are counted in one row per conversation):

| Conversation | Owner | Choice | Effects of the branch |
| --- | --- | --- | --- |
| `MeetTiffanySavage` | TiffanySavage | Make a break for the helicopter; it's in the junkyard. | -> Go: set TiffanyRunning, trig TiffanyGo |
| `MeetTiffanySavage` | TiffanySavage | (1 further choice that change no state: refusals, "never mind", unaffordable offers) | - |
| `MeetBum_M` | Bum_M | Give me the accuracy weapon mod for 750. [needs !M12BoughtAccuracy, M12CanBuyAccuracy] | -> BuyAccuracy: set M12BoughtAccuracy, give WeaponModAccuracy |
| `MeetBum_M` | Bum_M | Here's 400 for the recoil weapon mod. [needs !M12BoughtRecoil, M12CanBuyRecoil] | -> BuyRecoil: set M12BoughtRecoil, give WeaponModRecoil |
| `MeetBum_M` | Bum_M | I'll take the rebreather for 1500. [needs !M12BoughtRebreather, M12CanBuyRebreather] | -> BuyRebreather: set M12BoughtRebreather, give Rebreather |
| `MeetBum_M` | Bum_M | (4 further choices that change no state: refusals, "never mind", unaffordable offers) | - |

**Conversations that change state** (choices, flags set, goals, items, events, skill points; the `Needs` column is kept on these rows):

| Conversation | Owner (BindName; maps with that actor) | Kind | Choices | Sets | Needs | Goals | Other |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `DL_TiffanyDead` | JCDenton | DL once |  | TiffanyRescued | req TiffanySavage_Dead, req !MeetTiffanySavage_Played | done RescueTiffany, +P ReturnToHelicopter |  |
| `DL_override_activated` | JCDenton | DL once |  |  | req !M12BotsDestroyed | done ActivatePower |  |
| `DL_no_carla` | JCDenton | DL once |  |  | req !MeetCarlaBrown_Played | +P DestroyBots, +S ActivatePower, +note | give Image12_Vandenberg_Command |
| `DL_JockTiffanyDead` | JCDenton | DL once |  |  |  | +P ReturnToHelicopter |  |
| `DL_JockLeaving` | JCDenton | DL once |  |  |  | +P UplinkDaedalus |  |
| `DL_JockBack` | JCDenton | DL once |  |  | req GaryHostageBriefing_Played | +P FindJock |  |
| `DL_HeliosBorn` | JCDenton | DL once |  |  | req HeliosBorn | done UplinkDaedalus, done FixComputer, +P ListenToPage | trig GaryWalksToPosition |
| `DL_command_bots_destroyed` | JCDenton | DL once |  | M12BotsDestroyed |  | done DestroyBots, +P GoToCommunicationsCenter | trig comhqdoor |
| `MeetTonyMares` | TonyMares (Vandenberg_Cmd) | talk bump/frob/radius 100 once |  |  |  | done GoToCommunicationsCenter, +P FindGarySavage, +note | trig TonyWanders |
| `MeetTimBaker` | TimBaker (Vandenberg_Cmd) | talk bump/frob/radius 70 |  | TimBakerDone@Give | req !TimBakerDone, ? MeetTimBaker_Played, ? GaryComputerBriefing_Played, ? TunnelsAccessed | +note | give WeaponEMPGrenade |
| `MeetTiffanySavage` | TiffanySavage (Vandenberg_Gas) | talk bump/frob/radius 70 | 2 | TiffanyRescued, TiffanyRunning@Go | req !TiffanyRunning, ? MeetTiffanySavage_Played | done RescueTiffany, +P ReturnToHelicopter | trig TiffanyGo, give Image12_Vandenberg_Sub |
| `StephanieRescued` | StephanieMaxwell (Vandenberg_Cmd) | talk bump/frob once |  |  | ? DL_override_activated_Played, ? GaryComputerBriefing_Played | +note | trig StephWanders |
| `StephanieMaxwellOverheard` | StephanieMaxwell (Vandenberg_Cmd) | ovh radius 500 once |  |  |  |  | trig MJ12ToughGuyAttacks |
| `MeetStacyWebber` | StacyWebber (Vandenberg_Cmd) | talk bump/frob once |  |  | req CapturedScientistRescued, ? MeetTimBaker_Played | +note |  |
| `M12MeetCarter` | SamCarter (Vandenberg_Computer) | talk bump/frob once |  | CarterGaveAdvice@Advice | ? GaryHostageBriefing_Played |  |  |
| `TongSick` | Jock (Vandenberg_Cmd, Vandenberg_Gas) | talk once |  |  | ? !Ray_Dead, ? !EverettMechanicComment | done FindJock | trig TongWalks, trig Map_Exit |
| `M12JockFinal2` | Jock (Vandenberg_Cmd, Vandenberg_Gas) | talk bump/frob/radius 200 once |  |  | req TiffanySavage_Dead, req TiffanyRescued, ? TiffanySavage_Dead | done ReturnToHelicopter, +P GetSchematic | trig UN_BlackHeli |
| `PageHostageBriefing` | GarySavage (Vandenberg_Computer) | talk radius 200 once |  |  | req MS_M12PageAppeared | done ListenToPage | trig GaryTalksToPlayer |
| `GaryHostageBriefing` | GarySavage (Vandenberg_Computer) | talk bump/frob/radius 120 once |  |  | req HeliosBorn, req PageHostageBriefing_Played | +P RescueTiffany | trig GaryWanders, give Image12_Tiffany_HostagePic |
| `GaryComputerBriefing` | GarySavage (Vandenberg_Computer) | talk bump/frob once |  |  |  | done FindGarySavage, +P FixComputer, +note | trig control_doors1 |
| `MeetCarlaBrown` | CarlaBrown (Vandenberg_Cmd) | talk bump/frob/radius 160 once |  |  | ? dl_no_carla_played | +P DestroyBots, +S ActivatePower, +note | trig CarlaWanders, give Image12_Vandenberg_Command |
| `MeetBum_M` | Bum_M (Vandenberg_Gas) | talk bump/frob | 7 | MetBums@BumCommon, M12CanBuyAccuracy=0@ChoiceStart, M12CanBuyRebreather=0@ChoiceStart, M12CanBuyRecoil=0@ChoiceStart, Bum_M_Done@Done, M12BoughtAccuracy@BuyAccuracy, M12BoughtRecoil@BuyRecoil (+4 more) | req !Bum_M_Done, ? MetBums, ? M12BoughtAccuracy, ? M12BoughtRebreather, ? M12BoughtRecoil, ? !SandraRenton_Dead, ? SandraWentToCalifornia, ? !M12MeetSandraRenton_Played, ? !M12SandraRentonAside_Played |  | give NanoKey, give WeaponModAccuracy, give WeaponModRecoil, give Rebreather, cr -2650 |
| `MeetBum_F` | Bum_F (Vandenberg_Gas) | talk bump/frob once |  | MetBums | req !MetBums |  |  |

Conversations that only wait for a flag or check one, and change no state (28; `?` = a `CheckFlag` event): `DL_TonyScared` (!M12BotsDestroyed), `DL_override_activated_part` (!M12BotsDestroyed), `DL_HeliosGreeting` (TiffanyRescued), `DL_Everett_Computer_Apology` (HeliosBorn), `TonyBarks` (MeetTonyMares_Played (+2 more)), `TimBarks` (TimBakerDone (+1 more)), `TiffanyBarks` (TiffanyRunning), `StephanieBarks` (StephanieRescued_Played), `StacyScared` (!CapturedScientistRescued), `StacyBarks` (MeetStacyWebber_Played (+1 more)), `Savage_assistant_MBarks` (? !GaryComputerBriefing_Played (+3 more)), `Savage_assistant_FBarks` (? !GaryComputerBriefing_Played (+3 more)), `SandraBarks` (M12MeetSandraRenton_Played), `M12SandraRentonAside` (AlwaysFalse), `M12CarterBarks2` (CarterHelios_Played), `M12CarterBarks` (M12MeetCarter_Played (+2 more)), `CarterHelios` (CarterGaveAdvice), `CarterAdvice` (GaryHostageBriefing_Played, M12MeetCarter_Played, !CarterGaveAdvice), `M12JockFinal` (TiffanyRescued, !TiffanySavage_Dead, TiffanyHeli), `M12JockBarks2` (TiffanyRescued, !TiffanySavage_Dead (+2 more)), `SavageFinalBarks` (GaryHeliosBriefing_Played), `SavageBarks` (GaryComputerBriefing_Played (+2 more)), `GaryHeliosBriefing` (GaryHostageBriefing_Played), `CarlaBarks` (MeetCarlaBrown_Played (+8 more)), `BumsOverheard2` (BumsOverheard_Played (+2 more)), `BumsOverheard` (? !SandraRenton_Dead (+1 more)), `Bum_MBarks` (Bum_M_Done, ? TiffanyRescued), `Bum_FBarks` (MetBums, ? TiffanyRescued).

Plain InfoLinks, no flag and no event: 10 (listed with their starters in the InfoLink table).

Plain conversations with an actor (2): TracerTong: TongTrigger; SandraRenton: M12MeetSandraRenton.

Plain overheard conversations (3): MiBChatting: M12MiBOverheard; Mechanic_comm_2: Mechanic_comm_2Barks; Mechanic_comm_1: Mechanic_comm_1Barks.

InfoLinks and what starts them:

| InfoLink | Started by | Needs | Sets / does |
| --- | --- | --- | --- |
| `DL_underwater_stairwell` | (none found) |  |  |
| `DL_TonyScared` | Vandenberg_Cmd/DataLinkTrigger2 (-1782,5252) | !M12BotsDestroyed |  |
| `DL_TiffanyDead` | Vandenberg_Gas/DataLinkTrigger0 (143,686) needs TiffanySavage_Dead | TiffanySavage_Dead, !MeetTiffanySavage_Played | set TiffanyRescued, done RescueTiffany, +goal ReturnToHelicopter |
| `DL_sub_base_start` | (none found) |  |  |
| `DL_override_activated_part` | Vandenberg_Cmd/DataLinkTrigger1 (-1891,-97) | !M12BotsDestroyed |  |
| `DL_override_activated` | Vandenberg_Cmd/DataLinkTrigger0 (-2287,-106) | !M12BotsDestroyed | done ActivatePower |
| `DL_no_carla` | Vandenberg_Cmd/DataLinkTrigger34 (-1679,2482), Vandenberg_Cmd/DataLinkTrigger35 (-2464,1417), Vandenberg_Cmd/DataLinkTrigger36 (-1749,388) (+8 more) | !MeetCarlaBrown_Played | +goal DestroyBots, +goal ActivatePower, give Image12_Vandenberg_Command |
| `DL_JockTiffanyDead` | Mission12.uc:132 |  | +goal ReturnToHelicopter |
| `DL_JockLeaving` | Vandenberg_Tunnels/DataLinkTrigger0 (-1306,5527) |  | +goal UplinkDaedalus |
| `DL_JockBack` | Vandenberg_Computer/DataLinkTrigger2 (171,2745) needs GaryHostageBriefing_Played | GaryHostageBriefing_Played | +goal FindJock |
| `DL_Icarus` | Vandenberg_Cmd/DataLinkTrigger3 (1130,1326) |  |  |
| `DL_HeliosGreeting` | Vandenberg_Gas/DataLinkTrigger2 (-605,574) | TiffanyRescued |  |
| `DL_HeliosBorn` | Vandenberg_Computer/DataLinkTrigger0 (2050,2438) needs Heliosborn, Vandenberg_Computer/DataLinkTrigger1 (1970,2647) needs Heliosborn (+1 more) | HeliosBorn | done UplinkDaedalus, done FixComputer, +goal ListenToPage, trig GaryWalksToPosition |
| `DL_gas_start` | Vandenberg_Gas/DataLinkTrigger1 (1731,-2218) |  |  |
| `DL_Everett_Computer_Start` | Vandenberg_Computer/DataLinkTrigger4 (1493,2952) |  |  |
| `DL_Everett_Computer_Apology` | Vandenberg_Computer/DataLinkTrigger5 (1408,2958) needs Heliosborn | HeliosBorn |  |
| `DL_Everett_Computer` | (none found) |  |  |
| `DL_Daedalus` | Vandenberg_Computer/DataLinkTrigger6 (143,2783), Vandenberg_Computer/DataLinkTrigger7 (159,3063) |  |  |
| `DL_command_bots_destroyed` | Vandenberg_Cmd/DataLinkTrigger7 (1252,4891), Mission12.uc:93 |  | set M12BotsDestroyed, done DestroyBots, +goal GoToCommunicationsCenter, trig comhqdoor |
| `DL_bots_left_3` | Vandenberg_Cmd/DataLinkTrigger4 (998,4890), Mission12.uc:86 |  |  |
| `DL_bots_left_2` | Vandenberg_Cmd/DataLinkTrigger5 (1091,4890), Mission12.uc:88 |  |  |
| `DL_bots_left_1` | Vandenberg_Cmd/DataLinkTrigger6 (1181,4891), Mission12.uc:90 |  |  |

**Required (progression) conversations**, from the chains (`inventory-campaign.mjs chain`): the Gas exit is `M12JockFinal2` (Jock, bump/frob/radius 200; fires `UN_BlackHeli` on `Start`, or on `Dead`), reached directly when Tiffany is dead (it needs `TiffanySavage_Dead` and `TiffanyRescued`) or through `M12JockFinal`
(needs `TiffanyRescued`, `TiffanyHeli`, not dead; it only jumps to `M12JockFinal2`'s `Start`). `TiffanyRescued` comes from `MeetTiffanySavage`, from `DL_TiffanyDead` or from `Mission12.Timer:124`; `TiffanyHeli` from the Gas map's `FlagTrigger2` at (-3254,-451,-959).
The Cmd -> Gas ride is `TongSick` (Jock, Hop/Rattle branches fire `Map_Exit`), started only by a **jump from `TongTrigger`** (Tracer Tong, bump/frob/radius 300, no flag requirement), and Tong and Jock are in the world only after `GaryHostageBriefing_Played`
(`Mission12.FirstFrame:23-31`, which needs the map to be loaded again). `GaryHostageBriefing` needs `HeliosBorn` (the Computer map's `FlagTrigger0`, tag `Daedalus_linked`) and `PageHostageBriefing_Played` (needs `MS_M12PageAppeared`, from `M12PageAppears`, `FlagTrigger1` tag `bobtalk`).
Before that the goals chain: `DestroyBots` (`DL_no_carla`/`MeetCarlaBrown`; `DL_command_bots_destroyed`) -> `GoToCommunicationsCenter` -> `MeetTonyMares` -> `FindGarySavage` -> `GaryComputerBriefing` -> `FixComputer` -> `DL_HeliosBorn` -> `ListenToPage`.

### 12.4 Objectives

| Goal | Kind | Text | Added by | Completed by |
| --- | --- | --- | --- | --- |
| `RescueTiffany` | primary | Rescue Gary Savage's daughter, Tiffany, from the gas station where Majestic 12 is holding her. | GaryHostageBriefing | DL_TiffanyDead, MeetTiffanySavage |
| `ReturnToHelicopter` | primary | Return to the helicopter. | DL_TiffanyDead, DL_JockTiffanyDead, MeetTiffanySavage | M12JockFinal2 |
| `ActivatePower` | secondary | Activate backup power for the X-51 scientists' bot security system. | DL_no_carla, MeetCarlaBrown | DL_override_activated, 12_Vandenberg_Cmd/GoalCompleteTrigger0 |
| `DestroyBots` | primary | Destroy the 2 MJ12 military bots and 2 MJ12 security bots. Base will remain under lockdown until the bots are destroyed. | DL_no_carla, MeetCarlaBrown | DL_command_bots_destroyed |
| `UplinkDaedalus` | primary | Uplink Daedalus to the military computers near the control room on the second floor of the command building. | DL_JockLeaving | DL_HeliosBorn |
| `FindJock` | primary | Meet Jock at the front entrance to Vandenberg, northeast of the base. | DL_JockBack | TongSick |
| `FixComputer` | primary | Bring up the Vandenberg computer system, needed to operate the UC and to allow Everett to defend Daedalus. | GaryComputerBriefing | DL_HeliosBorn |
| `ListenToPage` | primary | Go to the control room to receive a communication from Bob Page. | DL_HeliosBorn | PageHostageBriefing |
| `GoToCommunicationsCenter` | primary | Go to the communications center to gain access to Gary Savage. | DL_command_bots_destroyed | MeetTonyMares |
| `FindGarySavage` | primary | Find Gary Savage, believed to be in the control room. | MeetTonyMares | GaryComputerBriefing |
| `GetSchematic` | primary | From the recently damaged MJ12 Ocean Lab, recover the schematic Gary Savage needs to complete a Universal Constructor. | M12JockFinal2 | - |

### 12.5 Choices with lasting consequences

Set here, alive in a later mission: **none** (everything the script and the FlagTriggers create expires by 14/15; the permanent flags are conversation flags read inside the mission). Read here, set earlier:

| Flag | Set earlier by | Read here by |
| --- | --- | --- |
| `EverettMechanicComment` | M11 conversation MeetEverett2@RayComment; M11 conversation MeetEverett2@deadset | checks in TongSick |
| `SandraWentToCalifornia` | M4 conversation SandraAttackedByJoJoThanks; M4 conversation FamilySquabbleWrapUpGilbertDead; M4 conversation FamilySquabbleWrapUp@Hop | checks in MeetBum_M; checks in BumsOverheard2; checks in BumsOverheard; script Mission12.FirstFrame:37 |

* **Tiffany** (`MeetTiffanySavage`: "Make a break for the helicopter" sets `TiffanyRunning`; "Wait here..." does not): `TiffanySavage_Dead` (permanent) is read in this mission and in mission 14 (the table of who can die).
* **Sandra** (`SandraWentToCalifornia`, mission 4): she is in the Gas map and the bums' conversations (`MeetBum_M`, `BumsOverheard`, `BumsOverheard2`) read the flag.
* **The mechanic** (`EverettMechanicComment`, mission 11) is read by `TongSick`: with `Ray_Dead` false or the flag unset the `Rattle` branch plays, otherwise `Hop`; both fire `Map_Exit`.
* `GarySavage_Dead` (read in 12, 14, 15), `TracerTong_Dead` (12, 15), `SamCarter_Dead`, `BobPage_Dead`, `SandraRenton_Dead` appear in the table of who can die.

### 12.6 Progression path

1. Cmd, `PlayerStart2`. `DL_no_carla` (eleven proximity triggers) until Carla Brown is met; `MeetCarlaBrown` adds `DestroyBots` and `ActivatePower`; the two security and two military bots (`enemy_bot`) must be destroyed (EMP): `DL_command_bots_destroyed` also unlocks `comhqdoor`.
2. `MeetTonyMares` -> `GaryComputerBriefing` (opens `control_doors1`) -> in the Computer map `FlagTrigger0` -> `Heliosborn`, `DL_HeliosBorn`; `M12PageAppears` -> `PageHostageBriefing` -> `GaryHostageBriefing` (adds `RescueTiffany`) -> `DL_JockBack` (adds `FindJock`).
3. Reload Cmd (a travel in): Jock, Tong and the helicopter are in; `TongTrigger` -> `TongSick` -> `Map_Exit` -> `mission_done` -> `MapExit0` -> `12_Vandenberg_gas`.
4. Gas: Tiffany (`MeetTiffanySavage` or dead), `TiffanyHeli`, `junkyard_doors`; `M12JockFinal` -> `M12JockFinal2` -> `UN_BlackHeli` -> `MapExit0` -> `14_Vandenberg_sub`.

| Map | Tag (movers) | Lock | Opened by |
| --- | --- | --- | --- |
| `12_Vandenberg_Cmd` | `security_tunnels` (1) | locked | Switch2 Switch2 |
| `12_Vandenberg_Cmd` | `comhqdoor` (1) | unlocked, pick 0.20, not frobbable | conversation DL_command_bots_destroyed |
| `12_Vandenberg_Cmd` | `bunker_door1` (2) | unlocked, not frobbable | Switch2 Switch3 |
| `12_Vandenberg_Cmd` | `outer_door` (1) | unlocked, pick 0.20, not frobbable | Switch2 Switch1 |
| `12_Vandenberg_Cmd` | `bunker_door2` (2) | unlocked, not frobbable | Switch2 Switch4 |
| `12_Vandenberg_Cmd` | `bot_online` (1) | unlocked, pick 0.20, not frobbable | Dispatcher Dispatcher6 |
| `12_Vandenberg_Cmd` | `door_controlroom` (3) | locked | frob |
| `12_Vandenberg_Cmd` | `lab_door1` (1) | unlocked, pick 0.20, not frobbable | LightSwitch LightSwitch0, LightSwitch LightSwitch6 |
| `12_Vandenberg_Cmd` | `lab_door2` (1) | unlocked, pick 0.20, not frobbable | LightSwitch LightSwitch1, LightSwitch LightSwitch5 |
| `12_Vandenberg_Cmd` | `front_door1` (2) | unlocked, pick 0.20, not frobbable | Trigger Trigger5, Trigger Trigger6 |
| `12_Vandenberg_Cmd` | `front_door2` (2) | unlocked, pick 0.20, not frobbable | Trigger Trigger7, Trigger Trigger8 |
| `12_Vandenberg_Cmd` | `bot_power` (1) | unlocked, pick 0.20 | Dispatcher Dispatcher6 |
| `12_Vandenberg_Cmd` | `override1` (1) | unlocked, pick 0.20 | Dispatcher Dispatcher7 |
| `12_Vandenberg_Cmd` | `override2` (1) | unlocked, pick 0.20 | Dispatcher Dispatcher8 |
| `12_Vandenberg_Cmd` | `control_doors2` (2) | unlocked, pick 0.20, not frobbable | Trigger Trigger3, Trigger Trigger4 |
| `12_Vandenberg_Cmd` | `bot_offline` (1) | unlocked, pick 0.20, not frobbable | Dispatcher Dispatcher6 |
| `12_Vandenberg_Cmd` | `roof_door` (1) | unlocked, pick 0.20, not frobbable | Switch1 Switch5 |
| `12_Vandenberg_Computer` | `control_doors1` (2) | unlocked, pick 0.20, not frobbable | conversation GaryComputerBriefing |
| `12_Vandenberg_Computer` | `control_doors2` (2) | unlocked, pick 0.20, not frobbable | Trigger Trigger3, Trigger Trigger4 |
| `12_Vandenberg_Computer` | `DeusExMover0` (1) | locked, key Lab02 | frob |
| `12_Vandenberg_Computer` | `door_controlroom` (2) | locked | frob |
| `12_Vandenberg_Computer` | `bobtalk_disp` (1) | unlocked, breakable 0.40, not frobbable | LogicTrigger LogicTrigger0 |
| `12_Vandenberg_Gas` | `DeusExMover4` (1) | unlocked, key maintenancekey | frob |
| `12_Vandenberg_Gas` | `DeusExMover21` (1) | locked, key truck, pick 0.20, not frobbable | (nothing found) |
| `12_Vandenberg_Gas` | `DeusExMover22` (1) | locked, key truck, pick 0.20, not frobbable | (nothing found) |
| `12_Vandenberg_Gas` | `junkyard_doors` (2) | unlocked, pick 0.20, not frobbable | script Mission12:121 |
| `12_Vandenberg_Tunnels` | `Wall` (1) | unlocked, breakable 0.40, not frobbable | Trigger Trigger1 |
| `12_Vandenberg_Tunnels` | `turret_support` (1) | unlocked, pick 0.20 | Dispatcher Dispatcher1 |
| `12_Vandenberg_Tunnels` | `turret_door` (1) | unlocked, pick 0.20 | Dispatcher Dispatcher1 |
| `12_Vandenberg_Tunnels` | `Safe` (1) | unlocked, pick 0.20 | Button1 Button3, Button1 Button8 |
| `12_Vandenberg_Tunnels` | `error1` (1) | unlocked, pick 0.20 | Button1 Button10 |
| `12_Vandenberg_Tunnels` | `error2` (1) | unlocked, pick 0.20 | Button1 Button11 |
| `12_Vandenberg_Tunnels` | `security_tunnels` (1) | locked | Button1 Button12 |

Key doors (a placed `NanoKey` opens them, or the lock is picked; frob only): `pipe` x2, `garage_entrance`, `truck` x2, `maintenancekey`.

(16 further movers of these maps are locked with a pickable lock or breakable, take no key that exists as a placed `NanoKey` and are fired by no event: not listed.)

**Progression blocker (mission 12).** The first of: the bots not destroyed (`DL_command_bots_destroyed` never plays); `Heliosborn`/`M12PageAppears` not set; `GaryHostageBriefing` not played; Cmd not reloaded with `GaryHostageBriefing_Played` (no Jock and Tong); `TongTrigger` -> `TongSick` -> `Map_Exit` not firing;
`TiffanyRescued`/`TiffanyHeli` not set; `M12JockFinal`/`M12JockFinal2` not firing `UN_BlackHeli`; either `MapExit` not travelling.

### 12.7 Slots

| Slot | Map | Saved as | Saves, play time | Important NPCs dead or knocked out (all) | Lasting-choice flags in the file (all) | Goals still open |
| --- | --- | --- | --- | --- | --- | --- |
| N0028 | `12_Vandenberg_cmd` | Vandenberg - Command | 545, 943 min | AnnaNavarre, DrugDealer, Gatekeeper, GilbertTerrorist, GuntherHermann, JoeGreene, JoJoFine, JosephManderley, JuanLebedev, MaggieChow, MJ12Commando, MJ12Troop, PrivateLloyd, Ray, Supervisor01, Terrorist | AmbrosiaTagged, BathroomBarks_Played, FilbenGaveKey, GreenKnowsAboutDowd, GuntherRespectsPlayer=0, HeardGrenadeTalk, HelpSailor, JacobsonRecruited, JaimeRecruited, KnowsAboutKillphrase, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, M04MetWalton, M08WarnedSmuggler, M11MetWalton, MeetJoeGreen_Played, PlayerMetFilben, SandraWentToCalifornia | DestroyBots, ActivatePower |
| N0029 | `12_Vandenberg_tunnels` | Vandenberg - Tunnels | 572, 992 min | AnnaNavarre, DrugDealer, Gatekeeper, GilbertTerrorist, GuntherHermann, JoeGreene, JoJoFine, JosephManderley, JuanLebedev, MaggieChow, MJ12Commando, MJ12Troop, PrivateLloyd, Ray, Supervisor01, Terrorist | AmbrosiaTagged, BathroomBarks_Played, FilbenGaveKey, GreenKnowsAboutDowd, GuntherRespectsPlayer=0, HeardGrenadeTalk, HelpSailor, JacobsonRecruited, JaimeRecruited, KnowsAboutKillphrase, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, M04MetWalton, M08WarnedSmuggler, M11MetWalton, MeetJoeGreen_Played, PlayerMetFilben, SandraWentToCalifornia | FindGarySavage |
| N0030 | `12_vandenberg_gas` | Vandenberg - Gas | 592, 1021 min | AnnaNavarre, DrugDealer, Gatekeeper, GilbertTerrorist, GuntherHermann, JoeGreene, JoJoFine, JosephManderley, JuanLebedev, MaggieChow, MJ12Commando, MJ12Troop, PrivateLloyd, Ray, Supervisor01, Terrorist | AmbrosiaTagged, BathroomBarks_Played, FilbenGaveKey, GreenKnowsAboutDowd, GuntherRespectsPlayer=0, HeardGrenadeTalk, HelpSailor, JacobsonRecruited, JaimeRecruited, KnowsAboutKillphrase, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, M04MetWalton, M08WarnedSmuggler, M11MetWalton, MeetJoeGreen_Played, PlayerMetFilben, SandraWentToCalifornia | RescueTiffany |

Three slots: N0028 (Cmd), N0029 (Tunnels; the only slot in a map with no script) and N0030 (Gas, nine goals recorded). All carry `NicoletteReadyToLeave`, a permanent flag from mission 10 (the slots from N0028 to N0032 hold it), and the dead list shows Gunther and the mechanic Ray among the important NPCs already dead.

## Mission 14: the sub base, the Ocean Lab and the missile silo

Four maps. The player lands at the Vandenberg submarine base, steals a mini-sub to the sunken Ocean Lab, downloads the Universal Constructor schematic (with Bob Page's taunt and Walton Simons' showdown on the way), returns to Gary Savage, and is flown to the missile silo
off the coast, where the launch has to be aborted and re-aimed at Area 51 and Howard Strong's sabotage stopped before Jock takes the player to Area 51. The mission has **no choice in any conversation** (0 with choices) and no lasting flag of its own: its decisions are about the missile.

### 14.1 Maps and arrival

| Map | Actors | Level info (`MapName`; `MissionLocation`) | Startup text | Script | Arrives from | Leaves to |
| --- | --- | --- | --- | --- | --- | --- |
| `14_OceanLab_Lab` | 2750 | 14_OceanLab_Lab; New West Coast - OceanLab | MJ12 OceanLab / Oceanic Floor | Mission14 | 14_OceanLab_UC#Sunkentunnel; 14_Vandenberg_Sub#Sunkenlab | 14_Vandenberg_Sub#subbay (path Camera1); 14_OceanLab_UC#UC |
| `14_OceanLab_UC` | 1641 | 14_OceanLab_UC; New West Coast - OceanLab UC | - | Mission14 | 14_OceanLab_Lab#UC | 14_OceanLab_Lab#Sunkentunnel |
| `14_Oceanlab_Silo` | 2517 | 14_OceanLab_silo; New West Coast - Missile Silo | - | Mission14 | 14_Vandenberg_Sub#frontgate (path Camera2) | 15_Area51_Bunker#bunker_start (path Camera1) |
| `14_Vandenberg_Sub` | 2403 | 14_Vandenberg_sub; New West Coast - Sub Base | MJ12 Sub Base / SoCal Seawall | Mission14 | 12_Vandenberg_Gas (path heli_camera); 14_OceanLab_Lab#subbay (path Camera1) | 14_Oceanlab_Silo#frontgate (path Camera2); 14_OceanLab_Lab#Sunkenlab |

* **Arrival.** `12_Vandenberg_Gas` `MapExit0` (camera `heli_camera`, tag `UN_BlackHeli`) -> `14_Vandenberg_sub`: `PlayerStart1` (6593,4126,-373). Mission change 12 -> 14: `Save\Current` wiped, `DeleteExpiredFlags(14)`.
* **Inside.** Sub base `MapExit3` (camera none, tag `reallysubexit`) -> `14_OceanLab_Lab#Sunkenlab` and Lab `MapExit2` (camera `Camera1`, tag `reallysubexit`) -> `14_Vandenberg_sub.dx#subbay`: the mini-sub rides, each fired by a `FlagTrigger` chain
  (`doors_open` / `door_open` in the right place, and `DL_downloaded_Played` false going down, true coming back; the `MiniSub0` actor carries the event); Lab `Teleporter2` <-> UC `Teleporter0` (touch, destination strings with a space before the `#`).
  Sub base `MapExit2` (camera `Camera2`, tag `ChopperExit`) -> `14_Oceanlab_silo.dx #frontgate`, fired by `JockBarks`'s `Go` branch.
* **Leaving.** `14_Oceanlab_Silo` `MapExit0` (camera `Camera1`, tag `ExitPath`) -> `15_area51_bunker.dx #bunker_start`, fired by `Dispatcher0` (`SiloExit`), which `JockArea51` triggers on `continue`. `14_Vandenberg_Sub` `MapExit0` has no destination (touch; unused or script-set: unverified).

| Map | Actor | At | Leads to | Fired by (events targeting its tag) |
| --- | --- | --- | --- | --- |
| `14_OceanLab_Lab` | MapExit `MapExit2` | 403,424,-2193 | `14_Vandenberg_sub.dx#subbay` (path `Camera1`) | tag `reallysubexit`: FlagTrigger FlagTrigger2 |
| `14_Oceanlab_Silo` | MapExit `MapExit0` | 449,-6354,1435 | `15_area51_bunker.dx #bunker_start` (path `Camera1`) | tag `ExitPath`: Dispatcher Dispatcher0 |
| `14_Vandenberg_Sub` | MapExit `MapExit0` | -388,9721,1002 | `` | touch |
| `14_Vandenberg_Sub` | MapExit `MapExit2` | 2601,3285,743 | `14_Oceanlab_silo.dx #frontgate` (path `Camera2`) | tag `ChopperExit`: conversation JockBarks[Go] |
| `14_Vandenberg_Sub` | MapExit `MapExit3` | 5645,-2208,-1585 | `14_OceanLab_Lab.dx #Sunkenlab` | tag `reallysubexit`: FlagTrigger FlagTrigger4 |

**14_OceanLab_Lab MapExit2 -> 14_Vandenberg_sub#subbay** (tag `reallysubexit`)

```text
event reallysubexit
  FlagTrigger FlagTrigger2 (Event) tag flag2
    FlagTrigger flag DL_downloaded_Played (needs true)
    event flag2
      FlagTrigger FlagTrigger1 (Event) tag subexit
        FlagTrigger flag door_open (needs true)
        event subexit
          MiniSub MiniSub0 (Event)
```

**14_Oceanlab_Silo MapExit0 -> 15_area51_bunker#bunker_start** (tag `ExitPath`)

```text
event ExitPath
  Dispatcher Dispatcher0 (OutEvents) tag SiloExit
    event SiloExit
      conversation event Trigger "SiloExit" in JockArea51 branch continue
        conversation JockArea51 [talk bump/frob/radius 160; owner Jock]
          starts: its actor (bump/frob/radius 160)
          flag DL_Dead_Played (set when conversation DL_Dead ends): 
            conversation DL_Dead [DL bump/frob; owner JCDenton]
```

**14_Vandenberg_Sub MapExit2 -> 14_Oceanlab_silo#frontgate** (tag `ChopperExit`)

```text
event ChopperExit
  conversation event Trigger "ChopperExit" in JockBarks branch Go
    conversation JockBarks [ovh bump/frob; owner Jock]
      starts: its actor (bump/frob)
      flag !DL_Dead_Played (set when conversation DL_Dead ends): 
        conversation DL_Dead [DL bump/frob; owner JCDenton]
          starts: DataLinkTrigger 14_Oceanlab_Silo/DataLinkTrigger2; Mission14.uc:111
```

**14_Vandenberg_Sub MapExit3 -> 14_OceanLab_Lab#Sunkenlab** (tag `reallysubexit`)

```text
event reallysubexit
  FlagTrigger FlagTrigger4 (Event) tag flag2
    FlagTrigger flag DL_downloaded_Played (needs false)
    event flag2
      FlagTrigger FlagTrigger1 (Event) tag subexit
        FlagTrigger flag doors_open (needs true)
        event subexit
          MiniSub MiniSub0 (Event)
```

### 14.2 Mission script `Mission14`

`.cache/research/src/DeusEx/Mission14.uc`, 142 lines.

* `FirstFrame` (`:12-20`): the Ocean Lab completes `StealSub` (`GoalCompleted`).
* `PreTravel` (`:28-31`): `Super` only. No `SendPlayer`/`ClientTravel`.
* `Timer` (`:39-138`): sub base: `DL_downloaded_Played` -> `MiniSub2` and the `welding_stuff` destroyed, the helicopter and Gary Savage enter (`MS_DestroySub`, expiration 15); Lab: the same flag -> Walton, `MiniSub2` and the `scubateam` divers enter (`MS_UnhideSub`);
  Silo: no `HowardStrong` left -> the helicopter enters and `DL_Dead` plays (`MS_UnhideHelicopter`); UC: `schematic_downloaded` -> Bob Page enters (`MS_UnhideBobPage`), `PageTaunt_Played` -> leaves (`MS_HideBobPage`).
* Flags it sets: all with expiration 15 (alive through mission 14, gone on entering mission 15); the map FlagTriggers too (`doors_open`, `door_open`, `schematic_downloaded`, `missile_launched`, `missile_aborted`).
* Actors it touches: `MiniSub`, `Actor welding_stuff`, `BlackHelicopter`, `GarySavage`, `WaltonSimons`, `ScubaDiver`, `HowardStrong`, `BobPage`.

Generated from the script's calls (`inventory-campaign.mjs scripts`; `:N` is the first line):

* **Flags set** (5; `eN` = explicit expiration N, otherwise the default): `MS_DestroySub` e15 (:73), `MS_UnhideSub` e15 (:93), `MS_UnhideHelicopter` e15 (:112), `MS_UnhideBobPage` e15 (:125), `MS_HideBobPage` e15 (:135).
* **Flags read** (8): `MS_DestroySub`, `DL_downloaded_Played`, `MS_UnhideSub`, `MS_UnhideHelicopter`, `MS_UnhideBobPage`, `schematic_downloaded`, `MS_HideBobPage`, `PageTaunt_Played`.
* **InfoLinks it starts**: `DL_Dead` (:111). **Conversations it starts by name**: none. **Goals it completes**: `StealSub` (:18).
* **Spawns**: none. **Destroy calls**: 2; **EnterWorld/LeaveWorld calls**: 8. **Travel calls**: none.

### 14.3 Conversations and InfoLinks

53 conversations of the list besides the shared barks: 26 InfoLinks (half of the list), 11 talk-type, 16 overheard; **none has a choice** (0), 3 set flags, 31 need a flag,
11 add or complete goals.

**Conversations that change state** (choices, flags set, goals, items, events, skill points; the `Needs` column is kept on these rows):

| Conversation | Owner (BindName; maps with that actor) | Kind | Choices | Sets | Needs | Goals | Other |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `DL_subnotready` | JCDenton | DL once |  |  |  | done StealSub |  |
| `DL_Start` | JCDenton | DL once |  |  |  | +P StealSub |  |
| `DL_Sealed` | JCDenton | DL once |  |  |  | done StealSub |  |
| `DL_Savage3` | JCDenton | DL once |  |  | req missile_launched | done AbortLaunch, done ReprogramMissile, +P PreventSabotage |  |
| `DL_Savage2` | JCDenton | DL once |  |  | req !missile_launched, req missile_aborted | done AbortLaunch, +P ReprogramMissile |  |
| `DL_Intro` | JCDenton | DL once |  | TookSub |  | done StealSub |  |
| `DL_FrontGate` | JCDenton | DL once |  |  |  | +P AbortLaunch, +note |  |
| `DL_Downloaded` | JCDenton | DL once |  |  | req schematic_downloaded | done GetSchematic, +P MeetSavage | give Image14_Schematic |
| `DL_Dead` | JCDenton | DL once |  |  |  | done PreventSabotage, +P MeetJock |  |
| `WaltonShowdown` | WaltonSimons (OceanLab_Lab) | talk bump/frob/radius 400 once |  |  | ? !M04MetWalton, ? !M11MetWalton |  | trig SimonsAttacks |
| `TiffanyGuardsOverheard` | TiffanyMiB (no actor) | ovh radius 400 once |  |  |  |  | trig TiffanyGuardAttacks |
| `MeetNasir` | Nasir (Vandenberg_Sub) | talk bump/frob once |  |  | req !schematic_downloaded | +note |  |
| `JockBarks` | Jock (Oceanlab_Silo, Vandenberg_Sub) | ovh bump/frob |  |  | req !DL_Dead_Played, ? GaryWaitingForSchematics_Played |  | trig ChopperExit |
| `JockArea51` | Jock (Oceanlab_Silo, Vandenberg_Sub) | talk bump/frob/radius 160 once |  |  | req DL_Dead_Played, ? !EverettMechanicComment, ? !Ray_Dead | done MeetJock | trig SiloExit |
| `GaryWaitingForSchematics` | GarySavage (Vandenberg_Sub) | talk bump/frob/radius 120 |  | M14GaryDone@continue, M14GaryDone@SubsequentVisit, M14GaryDone@GaryAddition | req !M14GaryDone, ? GaryWaitingForSchematics_Played, ? PageTaunt_Played, ? TiffanySavage_Dead | done MeetSavage | give AugmentationUpgradeCannister, sp 500 |
| `MeetDrPinkerton` | DrPinkerton (Vandenberg_Sub) | talk bump/frob/radius 120 once |  |  | req !schematic_downloaded | +note | give Image14_OceanLab |
| `MeetDrCorwell` | DrCorwell (Vandenberg_Sub) | talk bump/frob/radius 120 once |  |  | ? swim_backentrance, ? TankKharkian_Dead | +note |  |
| `MeetDrBrittanyPrinzler` | DrBrittanyPrinzler (Vandenberg_Sub) | talk bump/frob/radius 120 once |  |  | req !schematic_downloaded | +note |  |
| `MeetDrBernard` | DrBernard (Oceanlab_Silo) | talk bump/frob once |  | HasSiloCode@BernardCommon2 | ? HowardStrong_Dead, ? !missile_launched |  |  |

Conversations that only wait for a flag or check one, and change no state (22; `?` = a `CheckFlag` event): `DL_Submarine` (schematic_downloaded), `DL_Simons3` (schematic_downloaded), `DL_Simons2` (schematic_downloaded, ? SimonsAssassination), `DL_Simons1` (schematic_downloaded), `DL_SecondDoors` (schematic_downloaded), `DL_PageCall` (schematic_downloaded), `DL_Everett_Congrats` (schematic_downloaded), `DL_Everett_Area51` (DL_Dead_Played), `NasirBarks2` (schematic_downloaded), `NasirBarks` (!schematic_downloaded (+1 more)), `GaryBarks` (M14GaryDone, ? TiffanySavage_Dead), `PinkertonBarks2` (schematic_downloaded (+1 more)), `PinkertonBarks` (MeetDrPinkerton2_Played (+1 more)), `MeetDrPinkerton2` (MeetDrPinkerton_Played, !schematic_downloaded), `CorwellBarks` (MeetDrCorwell_Played (+1 more)), `BrittanyBarks2` (schematic_downloaded), `BrittanyBarks` (MeetDrBrittanyPrinzler_Played (+1 more)), `BernardSecondMeeting` (missile_launched, !HasSiloCode, !HowardStrong_Dead, MeetDrBernard_Played), `BernardBarks3` (HowardStrong_Dead (+1 more)), `BernardBarks2` (MeetDrBernard_Played (+3 more)), `BernardBarks` (MeetDrBernard_Played (+1 more)), `PageTaunt` (schematic_downloaded).

Plain InfoLinks, no flag and no event: 9 (listed with their starters in the InfoLink table).

Plain conversations with an actor (0): none.

Plain overheard conversations (3): ScientistMale: M15ScientistMaleBarks; ScientistFemale: M15ScientistFemaleBarks; CardPlayer1: ChattingGuards.

InfoLinks and what starts them:

| InfoLink | Started by | Needs | Sets / does |
| --- | --- | --- | --- |
| `DL_Underwater` | Vandenberg_Sub/DataLinkTrigger1 (3746,-580) |  |  |
| `DL_uc` | OceanLab_UC/DataLinkTrigger0 (507,3837) |  |  |
| `DL_Tunnel` | OceanLab_Lab/DataLinkTrigger1 (3363,561) |  |  |
| `DL_subnotready` | OceanLab_Lab/DataLinkTrigger7 (91,218) needs !DL_downloaded_Played |  | done StealSub |
| `DL_Submarine` | OceanLab_Lab/DataLinkTrigger3 (1481,3531) | schematic_downloaded |  |
| `DL_Start` | Vandenberg_Sub/DataLinkTrigger3 (6589,4151) |  | +goal StealSub |
| `DL_Simons3` | (none found) | schematic_downloaded |  |
| `DL_Simons2` | OceanLab_Lab/DataLinkTrigger6 (3291,3528) | schematic_downloaded, SimonsAssassination |  |
| `DL_Simons1` | OceanLab_Lab/DataLinkTrigger5 (1500,3530) | schematic_downloaded |  |
| `DL_SecondDoors` | OceanLab_Lab/DataLinkTrigger8 (172,-136) needs !door_open | schematic_downloaded |  |
| `DL_Sealed` | OceanLab_Lab/DataLinkTrigger4 (129,412) |  | done StealSub |
| `DL_ScientistHelp` | Vandenberg_Sub/DataLinkTrigger0 (2333,3361) |  |  |
| `DL_Savage3` | Oceanlab_Silo/DataLinkTrigger4 (-166,-1267) | missile_launched | done AbortLaunch, done ReprogramMissile, +goal PreventSabotage |
| `DL_Savage2` | Oceanlab_Silo/DataLinkTrigger6 (-160,-1278) | !missile_launched, missile_aborted | done AbortLaunch, +goal ReprogramMissile |
| `DL_Savage1` | Oceanlab_Silo/DataLinkTrigger1 (30,-1398) |  |  |
| `DL_Savage` | OceanLab_UC/DataLinkTrigger1 (819,7387) |  |  |
| `DL_PageCall` | OceanLab_UC/DataLinkTrigger3 (1470,6883), OceanLab_UC/DataLinkTrigger5 (831,6972) | schematic_downloaded |  |
| `DL_Intro` | OceanLab_Lab/DataLinkTrigger0 (254,760) |  | set TookSub, done StealSub |
| `DL_HeliosPleased` | (none found) |  |  |
| `DL_FrontGate` | Oceanlab_Silo/DataLinkTrigger0 (-4,-2447) |  | +goal AbortLaunch |
| `DL_Flooded` | OceanLab_Lab/DataLinkTrigger2 (-1970,590) |  |  |
| `DL_Everett_Congrats` | (none found) | schematic_downloaded |  |
| `DL_Everett_Area51` | Oceanlab_Silo/DataLinkTrigger7 (-444,-6806), Oceanlab_Silo/DataLinkTrigger8 (862,-3654) | DL_Dead_Played |  |
| `DL_Downloaded` | OceanLab_UC/DataLinkTrigger2 (814,7156) | schematic_downloaded | done GetSchematic, +goal MeetSavage, give Image14_Schematic |
| `DL_Dead` | Oceanlab_Silo/DataLinkTrigger2 (-33,-6739), Mission14.uc:111 |  | done PreventSabotage, +goal MeetJock |
| `DL_Ambush` | Oceanlab_Silo/DataLinkTrigger5 (22,-4042) |  |  |

**Required (progression) conversations**, from `inventory-campaign.mjs chain 14_Oceanlab_Silo ExitPath`: `JockArea51` (Jock outside the silo, bump/frob/radius 160; fires `SiloExit` on `continue`) needs `DL_Dead_Played`; `DL_Dead` is started by the Silo's `DataLinkTrigger2` at (-33,-6739) or by
`Mission14.Timer:111` when no `HowardStrong` is left; it completes `PreventSabotage` and adds `MeetJock`. The silo's `DL_FrontGate` -> `DL_Savage2` (needs `missile_aborted`, not `missile_launched`) / `DL_Savage3` (needs `missile_launched`) track `AbortLaunch`/`ReprogramMissile`/`PreventSabotage`
(the flags come from the Silo's three `FlagTrigger`s) but are not conditions of the exit. The way to the silo is `JockBarks` (sub base, `Go`; needs `!DL_Dead_Played` and checks `GaryWaitingForSchematics_Played`), so `GaryWaitingForSchematics` (Gary Savage, radius 120; needs `schematic_downloaded`
via `DL_Downloaded`) is required, and the Lab's `schematic_downloaded` (`14_OceanLab_UC/FlagTrigger0` at (646,7359,-3208)). `WaltonShowdown` (radius 400) reads `M04MetWalton` and `M11MetWalton` to choose its opening (`try2`/`try3`) and fires `SimonsAttacks`.

### 14.4 Objectives

| Goal | Kind | Text | Added by | Completed by |
| --- | --- | --- | --- | --- |
| `StealSub` | primary | Steal a mini-sub from the URV module submerged just offshore, then take it to the ocean lab. | DL_Start | DL_subnotready, DL_Sealed, DL_Intro, Mission14.FirstFrame:18 |
| `AbortLaunch` | primary | Abort the launch of the nuclear missile. | DL_FrontGate | DL_Savage3, DL_Savage2 |
| `ReprogramMissile` | primary | Reprogram the missile to strike Area 51. | DL_Savage2 | DL_Savage3 |
| `PreventSabotage` | primary | Go to the launch tube and make sure MJ12 does not sabotage the missile launch. | DL_Savage3 | DL_Dead |
| `GetSchematic` | carried |  | - | DL_Downloaded |
| `MeetSavage` | primary | Meet Gary Savage and Jock on top of the sub base's command module, just onshore. | DL_Downloaded | GaryWaitingForSchematics |
| `MeetJock` | primary | Meet Jock outside the silo. | DL_Dead | JockArea51 |

### 14.5 Choices with lasting consequences

Set here, alive in a later mission: **none**. Read here, set earlier:

| Flag | Set earlier by | Read here by |
| --- | --- | --- |
| `EverettMechanicComment` | M11 conversation MeetEverett2@RayComment; M11 conversation MeetEverett2@deadset | checks in JockArea51 |
| `M04MetWalton` | M4 conversation M04MeetWalton | checks in WaltonShowdown |
| `M11MetWalton` | M11 conversation M11WaltonHolo | checks in WaltonShowdown |
| `SimonsAssassination` | M3 conversation SimonsBarks@A4 | checks in DL_Simons2 |

* **Walton Simons** (`WaltonShowdown`): `M04MetWalton` (mission 4) and `M11MetWalton` (mission 11) change what he says; `SimonsAssassination` (mission 3) changes `DL_Simons2`.
* **The mechanic** (`EverettMechanicComment`, mission 11) and `Ray_Dead` choose `JockArea51`'s `Rattle` branch.
* **Tiffany** (`TiffanySavage_Dead`) is read by `GaryWaitingForSchematics` (branch `Dead`), `TankKharkian_Dead` by `MeetDrCorwell`, `GarySavage_Dead` in 12, 14, 15.
* The missile is the mission's own decision: the Silo's `missile_launched` (the player let it go) vs `missile_aborted` (computer doors) pick which of `DL_Savage2`/`DL_Savage3` plays; both end at the same exit.

### 14.6 Progression path

1. Sub base, `PlayerStart1`. `DL_Start` adds `StealSub`; the mini-sub: `doors_open` (`FlagTrigger0` at (5132,-2717,-1736)) and `MapExit3` (`reallysubexit`) -> Ocean Lab `Sunkenlab`.
2. Lab: `DL_Sealed` completes `StealSub` (`Mission14.FirstFrame` too); `Teleporter2` to the UC: `FlagTrigger0` -> `schematic_downloaded`; `DL_Downloaded` (completes `GetSchematic`, adds `MeetSavage`, gives `Image14_Schematic`); Bob Page then appears in the UC (`Mission14.Timer`, until `PageTaunt_Played`) and Walton enters the Lab once `DL_downloaded_Played` (`WaltonShowdown`).
3. Back: Lab `MapExit2` (`DL_downloaded_Played` true, `door_open`) -> sub base `subbay`; `GaryWaitingForSchematics`.
4. `JockBarks` `Go` -> `ChopperExit` -> `MapExit2` -> `14_Oceanlab_silo#frontgate`.
5. Silo: `DL_FrontGate` (adds `AbortLaunch`), the computer doors (`FlagTrigger2`, `missile_aborted`) or the klaxon (`FlagTrigger1`, `missile_launched`), `DL_Savage2`/`DL_Savage3`; Howard Strong; `DL_Dead`; `JockArea51` `continue` -> `SiloExit` -> `ExitPath` -> `MapExit0` -> `15_area51_bunker#bunker_start`.

| Map | Tag (movers) | Lock | Opened by |
| --- | --- | --- | --- |
| `14_OceanLab_Lab` | `DeusExMover49` (1) | locked, key Glab | frob |
| `14_OceanLab_Lab` | `Access` (1) | locked | Keypad2 Keypad1 |
| `14_OceanLab_UC` | `lift1` (1) | unlocked, pick 0.20, not frobbable | Button1 Button2, Button1 Button4 |
| `14_OceanLab_UC` | `lift2` (1) | unlocked, pick 0.20, not frobbable | Button1 Button3, Button1 Button5 |
| `14_OceanLab_UC` | `bridge` (1) | unlocked, pick 0.20, not frobbable | Dispatcher Dispatcher0 |
| `14_OceanLab_UC` | `Releasebots` (4) | unlocked, pick 0.20, not frobbable | BeamTrigger BeamTrigger0, BeamTrigger BeamTrigger1, BeamTrigger BeamTrigger2, BeamTrigger BeamTrigger3 |
| `14_Oceanlab_Silo` | `rocket_doors` (2) | unlocked, pick 0.20, not frobbable | Dispatcher Dispatcher0 |
| `14_Oceanlab_Silo` | `hatch` (1) | locked | Button1 Button0 |
| `14_Oceanlab_Silo` | `computerdoors` (2) | unlocked, pick 0.20, not frobbable | FlagTrigger FlagTrigger0 |
| `14_Oceanlab_Silo` | `blastdoor3` (2) | locked, not frobbable | Keypad3 Keypad1, Keypad3 Keypad7 |
| `14_Oceanlab_Silo` | `blastdoor2` (2) | locked, not frobbable | Keypad3 Keypad10, Keypad3 Keypad17 |
| `14_Oceanlab_Silo` | `blastdoor1` (2) | locked, not frobbable | Keypad3 Keypad15, Keypad3 Keypad16 |
| `14_Oceanlab_Silo` | `metaldoor1` (1) | locked, pick 0.80, breakable 0.25 | Button1 Button1 |
| `14_Oceanlab_Silo` | `Rocket` (1) | unlocked, pick 0.20, not frobbable | Dispatcher Dispatcher0 |
| `14_Vandenberg_Sub` | `door_pod1` (1) | unlocked, key Sub_base | frob |
| `14_Vandenberg_Sub` | `door_closet` (1) | unlocked, not frobbable | Keypad2 Keypad5, Button1 Button6 |
| `14_Vandenberg_Sub` | `door_base` (1) | locked, key Sub_base | frob |
| `14_Vandenberg_Sub` | `tank` (1) | unlocked, pick 0.20, not frobbable | Keypad3 Keypad0 |
| `14_Vandenberg_Sub` | `Elevator1` (1) | unlocked, pick 0.20, not frobbable | Switch2 Switch0 |

Key doors (a placed `NanoKey` opens them, or the lock is picked; frob only): `storage` x3, `crewkey`, `truck` x2, `woodgate` x2, `shed`.

(12 further movers of these maps are locked with a pickable lock or breakable, take no key that exists as a placed `NanoKey` and are fired by no event: not listed.)

**Progression blocker (mission 14).** The mini-sub rides not travelling (the `FlagTrigger` chains and `MiniSub0` events); `schematic_downloaded` never set; `GaryWaitingForSchematics` not played; `JockBarks` not reaching `Go` (it needs `DL_Dead_Played` false, so it stops working once the silo has been done);
`DL_Dead` not playing; `JockArea51` not firing `SiloExit`; `MapExit0` not loading Area 51.

### 14.7 Slots

| Slot | Map | Saved as | Saves, play time | Important NPCs dead or knocked out (all) | Lasting-choice flags in the file (all) | Goals still open |
| --- | --- | --- | --- | --- | --- | --- |
| N0031 | `14_Vandenberg_sub` | New West Coast - Sub Base | 601, 1035 min | AnnaNavarre, DrugDealer, Gatekeeper, GilbertTerrorist, GuntherHermann, JoeGreene, JoJoFine, JosephManderley, JuanLebedev, MaggieChow, MJ12Commando, MJ12Troop, PrivateLloyd, Ray, Supervisor01, Terrorist | AmbrosiaTagged, BathroomBarks_Played, FilbenGaveKey, GreenKnowsAboutDowd, GuntherRespectsPlayer=0, HeardGrenadeTalk, HelpSailor, JacobsonRecruited, JaimeRecruited, KnowsAboutKillphrase, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, M04MetWalton, M08WarnedSmuggler, M11MetWalton, MeetJoeGreen_Played, PlayerMetFilben, SandraWentToCalifornia | GetSchematic, StealSub |
| N0032 | `14_OceanLab_Lab` | New West Coast - OceanLab | 618, 1058 min | AnnaNavarre, DrugDealer, Gatekeeper, GilbertTerrorist, GuntherHermann, JoeGreene, JoJoFine, JosephManderley, JuanLebedev, MaggieChow, MJ12Commando, MJ12Troop, PrivateLloyd, Ray, Supervisor01, Terrorist | AmbrosiaTagged, BathroomBarks_Played, FilbenGaveKey, GreenKnowsAboutDowd, GuntherRespectsPlayer=0, HeardGrenadeTalk, HelpSailor, JacobsonRecruited, JaimeRecruited, KnowsAboutKillphrase, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, M04MetWalton, M08WarnedSmuggler, M11MetWalton, MeetJoeGreen_Played, PlayerMetFilben, SandraWentToCalifornia | GetSchematic |
| N0033 | `14_OceanLab_UC` | New West Coast - OceanLab UC | 650, 1088 min | AnnaNavarre, DrugDealer, Gatekeeper, GilbertTerrorist, GuntherHermann, JoeGreene, JoJoFine, JosephManderley, JuanLebedev, MaggieChow, MJ12Commando, MJ12Troop, PrivateLloyd, Ray, Supervisor01, Terrorist | AmbrosiaTagged, BathroomBarks_Played, FilbenGaveKey, GreenKnowsAboutDowd, GuntherRespectsPlayer=0, HeardGrenadeTalk, HelpSailor, JacobsonRecruited, JaimeRecruited, KnowsAboutKillphrase, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, M04MetWalton, M08WarnedSmuggler, M11MetWalton, MeetJoeGreen_Played, PlayerMetFilben, SandraWentToCalifornia | GetSchematic |
| N0034 | `14_OceanLab_Lab` | New West Coast - OceanLab | 658, 1102 min | AnnaNavarre, DrugDealer, Gatekeeper, GilbertTerrorist, GuntherHermann, JoeGreene, JoJoFine, JosephManderley, JuanLebedev, MaggieChow, MJ12Commando, MJ12Troop, PrivateLloyd, Ray, Supervisor01, Terrorist | AmbrosiaTagged, BathroomBarks_Played, FilbenGaveKey, GreenKnowsAboutDowd, GuntherRespectsPlayer=0, HeardGrenadeTalk, HelpSailor, JacobsonRecruited, JaimeRecruited, KnowsAboutKillphrase, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, M04MetWalton, M08WarnedSmuggler, M11MetWalton, MeetJoeGreen_Played, PlayerMetFilben, SandraWentToCalifornia | MeetSavage |
| N0035 | `14_OceanLab_silo` | New West Coast - Missile Silo | 664, 1110 min | AnnaNavarre, DrugDealer, Gatekeeper, GilbertTerrorist, GuntherHermann, JoeGreene, JoJoFine, JosephManderley, JuanLebedev, MaggieChow, MJ12Commando, MJ12Troop, PrivateLloyd, Ray, Supervisor01, Terrorist, WaltonSimons | AmbrosiaTagged, BathroomBarks_Played, FilbenGaveKey, GreenKnowsAboutDowd, GuntherRespectsPlayer=0, HeardGrenadeTalk, HelpSailor, JacobsonRecruited, JaimeRecruited, KnowsAboutKillphrase, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, M04MetWalton, M08WarnedSmuggler, M11MetWalton, MeetJoeGreen_Played, PlayerMetFilben, SandraWentToCalifornia | AbortLaunch |

Five slots: sub base (N0031), Ocean Lab (N0032, N0034), UC (N0033), Silo (N0035). N0034 and N0035 already hold `schematic_downloaded` and `PageTaunt_Played`; N0035 is in the Silo, the nearest to the exit, with neither `missile_launched` nor `missile_aborted` set yet.

## Mission 15: Area 51

Four maps and three endings. The player arrives at the Area 51 bunker with Jock (when the mechanic Ray is not dead, Jock's helicopter is sabotaged and blown up on the helipad within seconds of arrival), fights down through the bunker and the sectors, and at the end chooses one of three
exits by what he does at the reactors, at Helios' hub and at Bob Page's bunker. The choice is not a conversation choice (**no conversation of the list has a choice**) but the ending the player reaches: `99_Endgame1` (destroy the generator: "New Dark Age", Tracer Tong),
`99_Endgame2` (merge with Helios) or `99_Endgame3` (join the Illuminati and kill Page).

### 15.1 Maps and arrival

| Map | Actors | Level info (`MapName`; `MissionLocation`) | Startup text | Script | Arrives from | Leaves to |
| --- | --- | --- | --- | --- | --- | --- |
| `15_Area51_Bunker` | 2645 | 15_Area51_bunker; Area 51 - Bunker | Area 51 / Rachel Nevada | Mission15 | 14_Oceanlab_Silo#bunker_start (path Camera1) | 15_Area51_Entrance#start |
| `15_Area51_Entrance` | 1893 | 15_Area51_entrance; Area51 - Entrance | - | Mission15 | 15_Area51_Bunker#start | 15_Area51_Final#start |
| `15_Area51_Final` | 3073 | 15_Area51_final; Area51 - Final | - | Mission15 | 15_Area51_Entrance#start; 15_Area51_Page#final_end | 99_Endgame1; 99_Endgame2; 15_Area51_Page#page_start |
| `15_Area51_Page` | 3537 | 15_Area51_page; Area51 - Page | - | Mission15 | 15_Area51_Final#page_start | 99_Endgame3; 15_Area51_Final#final_end |

* **Arrival.** `14_Oceanlab_Silo` `MapExit0` (camera `Camera1`, tag `ExitPath`) -> `15_area51_bunker.dx #bunker_start`: mission change 14 -> 15 (`Save\Current` wiped, `DeleteExpiredFlags(15)`). The `Bunker` has `PlayerStart2` (-1779,1741,-214) and `PlayerStart0` (600,-2024,-488).
* **Inside.** Bunker `Teleporter0` (portal `start`) -> Entrance -> Final (`start`); Final `Teleporter2` (`page_start`) <-> Page `Teleporter8` (`final_end`): the Page's bunker is below the Final's sectors.
* **Leaving (three exits).** Final `MapExit0` (tag `map_exit_generator`) -> `99_Endgame1`; Final `MapExit1` (tag `Merge_helios_exit`) -> `99_Endgame2`; Page `MapExit0` (tag `start_endgame`) -> `99_endgame3` (the string is lower case).

| Map | Actor | At | Leads to | Fired by (events targeting its tag) |
| --- | --- | --- | --- | --- |
| `15_Area51_Final` | MapExit `MapExit0` | -3300,-5249,-1625 | `99_Endgame1` | tag `map_exit_generator`: Dispatcher Dispatcher7 |
| `15_Area51_Final` | MapExit `MapExit1` | -3737,2093,480 | `99_Endgame2` | tag `Merge_helios_exit`: FlagTrigger FlagTrigger3 |
| `15_Area51_Page` | MapExit `MapExit0` | 6312,-6530,-5169 | `99_endgame3` | tag `start_endgame`: Dispatcher Dispatcher1, script Mission15:433 |

**15_Area51_Final MapExit0 -> 99_Endgame1** (tag `map_exit_generator`)

```text
event map_exit_generator
  Dispatcher Dispatcher7 (OutEvents[3]) tag destroy_generator
    event destroy_generator
      Switch1 Switch4 (Event)
```

**15_Area51_Final MapExit1 -> 99_Endgame2** (tag `Merge_helios_exit`)

```text
event Merge_helios_exit
  FlagTrigger FlagTrigger3 (Event)
    FlagTrigger flag HeliosFree (needs true)
```

**15_Area51_Page MapExit0 -> 99_endgame3** (tag `start_endgame`)

```text
event start_endgame
  Dispatcher Dispatcher1 (OutEvents[5]) tag kill_page
    event kill_page
      Switch1 Switch4 (Event)
  Mission15.uc:433: foreach AllActors(class'Actor', A, 'start_endgame')
```

### 15.2 Mission script `Mission15`

`.cache/research/src/DeusEx/Mission15.uc`, 509 lines (with a table of twelve respawn records for the Page's bunker, `spawnData`, and the Page's death effects).

* `FirstFrame` (`:26-55`): Bunker, if `Ray_dead` is **not** set: the sabotaged helicopter (`heli_sabotaged`) enters, Jock's (`UN_BlackHeli`) leaves, the `InterpolateTrigger`s fire, `jockTimer` starts and `MS_BeginSabotage` (expiration 16) is set. (With the mechanic Ray dead, nobody sabotages it and Jock lives.)
* `PreTravel` (`:63-66`): `Super` only. No `SendPlayer`/`ClientTravel`.
* `Timer` (`:74-438`): Bunker: 8 s after the arrival `DL_JockDeath` plays; once played the helicopter is destroyed with 20 explosions, 20 metal fragments and a sphere (`DL_JockDeathTongComment`, `MS_JockDead`); at 11 s without the DL, 6 small explosions; `MS_FanDestroyed` when no `Fan1`
  tagged `Fan_vertical_shaft_1` remains (triggers the `fan` zone). Entrance: `EverettAppears` -> Everett (and the `Earth` hologram hidden), `M15MeetEverett_Played` -> he leaves. Final: `MeetHelios_Played` -> three commandos enter; `coolantcut` -> the reactor generator switches swap;
  `TongAppears` / `M15MeetTong_Played`; `PaulAppears` -> **Paul if alive, Gary Savage if `PaulDenton_Dead`** enters (the hologram of whom `M15PaulHolo_Played`/`M15GaryHolo_Played` hides again, `:281-308`). Page: **respawn** of up to twelve classes of MJ12 pawns 20 s after the last of a group dies
  (sparks, an `ElectricityEmitter` column, `InitializePawn`, `SetOrders('Patrolling')`, hostile to the player, neutral to MJ12); the four blue-fusion `NodeN_Frobbed` flags drive `DL_Blue1..4` (`MS_DL_Played`, expiration 16); `killpage` -> the `BobPageAugmented` explodes (3 s effects, 6 s `platform_pieces` blown up and
  `LifeSupportBase` destroyed, 9 s `start_endgame` triggered; **no code, conversation or trigger in the data sets `killpage`**, so this branch never runs; `kill_page`/`start_endgame` are fired by the Page map's switch and dispatcher instead).
* Flags it sets: all with expiration 16 (they live to the end of the game); none is read by a later map (the endgames wipe the flag store).
* Actors it touches: `BlackHelicopter`, `InterpolateTrigger`, `Fan1`, `ZoneInfo fan`, `Earth`, `MorganEverett`, `TracerTong`, `MJ12Commando`, `Switch2`, `ScriptedPawn` by tag (`PaulDenton`, `GarySavage`), `BobPageAugmented`, `LifeSupportBase`, `DeusExMover platform_pieces`.

Generated from the script's calls (`inventory-campaign.mjs scripts`; `:N` is the first line):

* **Flags set** (14; `eN` = explicit expiration N, otherwise the default): `MS_BeginSabotage` e16 (:52), `MS_JockDead` e16 (:156), `MS_FanDestroyed` e16 (:195), `MS_EverettAppeared` e16 (:211), `MS_MorganEverettHidden` e16 (:224), `MS_CommandosUnhidden` e16 (:237), `MS_ButtonsHidden` e16 (:251), `MS_TongAppeared` e16 (:264), `MS_TracerTongHidden` e16 (:277), `MS_PaulOrGaryAppeared` e16 (:295), `MS_PaulOrGaryHidden` e16 (:307), `MS_DL_Played` e16 (:395), `MS_PageExploding` e16 (:407), `MS_PageDestroyed` e16 (:428).
* **Flags read** (35): `Ray_dead`, `MS_BeginSabotage`, `MS_JockDead`, `DL_JockDeath_Played`, `MS_FanDestroyed`, `MS_EverettAppeared`, `EverettAppears`, `MS_MorganEverettHidden`, `M15MeetEverett_Played`, `MeetHelios_Played`, `MS_CommandosUnhidden`, `MS_ButtonsHidden`, `coolantcut`, `MS_TongAppeared`, `TongAppears`, `MS_TracerTongHidden`, `M15MeetTong_Played`, `MS_PaulOrGaryAppeared`, `PaulAppears`, `PaulDenton_Dead`, `MS_PaulOrGaryHidden`, `M15PaulHolo_Played`, `M15GaryHolo_Played`, `MS_DL_Played`, `Node1_Frobbed`, `Node2_Frobbed`, `Node3_Frobbed`, `Node4_Frobbed`, `DL_Blue1_Played`, `DL_Blue2_Played`, `DL_Blue3_Played`, `DL_Blue4_Played`, `killpage`, `MS_PageExploding`, `MS_PageDestroyed`.
* **InfoLinks it starts**: `DL_JockDeath` (:106), `DL_JockDeathTongComment` (:155), `DL_Blue1` (:387), `DL_Blue2` (:389), `DL_Blue3` (:391), `DL_Blue4` (:394). **Conversations it starts by name**: none. **Goals it completes**: none.
* **Spawns**: `ExplosionMedium` (:120), `ExplosionLarge` (:122), `MetalFragment` (:132), `SphereEffect` (:144), `ExplosionSmall` (:168), `ExplosionLight` (:333), `EllipseEffect` (:334), `ElectricityEmitter` (:344). **Destroy calls**: 3; **EnterWorld/LeaveWorld calls**: 10. **Travel calls**: none.

### 15.3 Conversations and InfoLinks

81 conversations of the list besides the shared barks: 59 InfoLinks (the largest share of any list: the mission is narrated by Tong, Everett and Helios), 10 talk-type, 12 overheard;
**none has a choice**, 11 set flags, 38 need a flag, 15 add or complete goals.

**Conversations that change state** (choices, flags set, goals, items, events, skill points; the `Needs` column is kept on these rows):

| Conversation | Owner (BindName; maps with that actor) | Kind | Choices | Sets | Needs | Goals | Other |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `DL_tong7` | JCDenton | DL once |  | ReactorReady | req CoolantCut, req ReactorSwitch1, req ReactorSwitch2 | +S ActivateReactors |  |
| `DL_tong4` | JCDenton | DL once |  |  | req CoolantCut | done ReturnToReactorLab |  |
| `DL_tong3` | JCDenton | DL once |  |  | req CoolantCut | +S ReturnToReactorLab |  |
| `DL_tong1` | JCDenton | DL once |  |  |  | +P EnterBlastDoors, +P PenetrateBunker | give Image15_Area51Bunker |
| `DL_tong_reached_bunker` | JCDenton | DL once |  |  |  | done PenetrateBunker, done PowerElevator |  |
| `DL_PageBarks3` | JCDenton | DL |  | PageBarks1=0, PageBarks2=0, PageBarks3=0, PageBarks1@F1, PageBarks2@F2 | req PageBarks3, req !DL_Blue4_Played |  |  |
| `DL_PageBarks2` | JCDenton | DL |  | PageBarks1=0, PageBarks2=0, PageBarks3=0, PageBarks1@F1, PageBarks3@F2 | req PageBarks2, req !DL_Blue4_Played |  |  |
| `DL_PageBarks1` | JCDenton | DL |  | PageBarks1=0, PageBarks2=0, PageBarks3=0, PageBarks2@F1, PageBarks3@F2 | req PageBarks1, req !DL_Blue4_Played |  |  |
| `DL_Page_Dead` | JCDenton | DL once |  | endgame_page |  |  |  |
| `DL_Morgan_Talk` | JCDenton | DL once |  |  | req !M15MeetEverett_Played | +S TalkToMorgan |  |
| `DL_Morgan_Missed_Convo` | JCDenton | DL once |  |  | req !M15MeetEverett_Played | +S KillPage |  |
| `DL_JockDeath` | JCDenton | DL once |  | JockBlewUp |  |  |  |
| `DL_Helios_Intro` | JCDenton | DL once |  |  |  | +P SeeHelios |  |
| `DL_Helios_Door2` | JCDenton | DL once |  |  | req MeetHelios_Played |  | trig page_blastdoors |
| `DL_Final_Page02` | JCDenton | DL once |  | HealthEnd10, HealthEnd20, HealthEnd30, HealthEnd40, HealthEnd50, HealthEnd60, HealthEnd70, HealthEnd80, HealthEnd90, HealthEnd100 | ? !HealthEnd40, ? HealthStart100, ? !HealthEnd100, ? HealthStart90, ? !HealthEnd90, ? HealthStart80, ? !HealthEnd80, ? HealthStart70, ? !HealthEnd70, ? HealthStart60, ? !HealthEnd60, ? HealthStart50, ? !HealthEnd50 |  |  |
| `DL_Final_Morgan` | JCDenton | DL once |  |  |  | +S OverloadForceField, +note | give Image15_BlueFusionDevice |
| `DL_Final_Helios06_5` | JCDenton | DL once |  |  | req HeliosFree | done DeactivateLocks, +S MergeWithHelios |  |
| `DL_Final_Helios06` | JCDenton | DL once |  |  | req UplinkLock1, req UplinkLock2 | +note |  |
| `DL_Final_Helios03_5` | JCDenton | DL once |  |  |  | +note |  |
| `DL_elevator` | JCDenton | DL once |  | HealthStart10, HealthStart20, HealthStart30, HealthStart40, HealthStart50, HealthStart60, HealthStart70, HealthStart80, HealthStart90, HealthStart100 |  |  |  |
| `DL_Bunker_Power` | JCDenton | DL once |  |  |  | done PowerElevator |  |
| `DL_Bunker_blastdoor` | JCDenton | DL once |  |  |  | done EnterBlastDoors, +S PowerElevator |  |
| `DL_Blue4` | JCDenton | DL once |  |  |  |  | trig page_button |
| `WaltonBadass` | WaltonSimons (Area51_Bunker) | talk bump/frob/radius 250 once |  |  |  |  | trig WaltonAttacks |
| `M15MeetTong` | TracerTong (Area51_Entrance, Area51_Final) | talk bump/frob/radius 400 once |  |  | req MS_TongAppeared | +S DestroyArea51 | trig blastdoor_final, give Image15_Area51_sector3 |
| `MeetScaredSoldier` | ScaredSoldier (Area51_Bunker) | talk bump/frob once |  |  | ? blast_door_open | +note |  |
| `PowerGuyScared3` | PowerGuy (Area51_Final) | ovh bump/frob/radius 200 |  |  | req ReactorButton3 |  | trig power_guy_attacks |
| `PowerGuyFollowup` | PowerGuy (Area51_Final) | talk bump/frob once |  | AppeasedPowerGuy | req ReactorGray1_Dead, req ReactorGray2_Dead, req !AppeasedPowerGuy, req !ReactorReady |  |  |
| `MeetPowerGuy` | PowerGuy (Area51_Final) | talk bump/frob/radius 120 once |  | AppeasedPowerGuy | ? ReactorGray1_Dead, ? !ReactorGray2_Dead, ? !ReactorGray1_Dead, ? ReactorGray2_Dead | +note |  |
| `M15MeetEverett` | MorganEverett (Area51_Entrance) | talk bump/frob/radius 400 once |  |  | req MS_EverettAppeared, ? !EverettMechanicComment, ? !Ray_Dead | done TalkToMorgan, +S KillPage, +note |  |
| `MeetHelios` | Helios (Area51_Final) | talk bump/frob/radius 150 once |  |  |  | done SeeHelios, +S DeactivateLocks |  |
| `MeetBobPage` | BobPage (Area51_Page) | talk radius 450 once |  | PageBarks1 |  |  | trig page_turrets |

Conversations that only wait for a flag or check one, and change no state (24; `?` = a `CheckFlag` event): `DL_tong6` (CoolantCut, !ReactorSwitch1, ReactorSwitch2), `DL_tong5` (CoolantCut, ReactorSwitch1, !ReactorSwitch2), `DL_Helios_Door1` (!MeetHelios_Played), `DL_Final_Tong` (!CoolantCut), `DL_Final_Paul` (!PaulDenton_Dead), `DL_Final_Morgan02` (DL_Final_Morgan_Played), `DL_Final_Helios07` (HeliosFree), `DL_Final_Helios05` (!UplinkLock1, UplinkLock2), `DL_Final_Helios04` (UplinkLock1, !UplinkLock2), `DL_Final_Helios02` (MeetHelios_Played), `DL_Bunker_Start` (!JockBlewUp), `DL_Bunker_Hangar` (!JockBlewUp), `DL_Bunker_Elevator` (!DL_Bunker_Power_Played), `DL_Blue2` (? CoolantCut), `DL_blastdoor_shut` (!blast_door_open), `ScaredSoldierBarks` (MeetScaredSoldier_Played), `PowerGuyScared2` (ReactorButton1, !ReactorButton3), `PowerGuyScared1` (ReactorReady, !ReactorButton1), `PowerGuyBarksA2` (MeetPowerGuy_Played (+3 more)), `PowerGuyBarksA1` (MeetPowerGuy_Played (+3 more)), `PowerGuyBarks2` (MeetPowerGuy_Played (+2 more)), `M15PaulHolo` (!PaulDenton_Dead), `HangarOverheard2` (HangarOverheard_Played), `M15GaryHolo` (PaulDenton_Dead).

Plain InfoLinks, no flag and no event: 21 (listed with their starters in the InfoLink table).

Plain conversations with an actor (0): none.

Plain overheard conversations (4): ScaredSoldier: ScaredSoldierInitialBark; MiBSpecial: OverhearMiBSpecial; MechanicSpecial: MechanicSpecialBarks; HangarMiB: HangarOverheard.

InfoLinks and what starts them:

| InfoLink | Started by | Needs | Sets / does |
| --- | --- | --- | --- |
| `DL_tong7` | Area51_Final/DataLinkTrigger20 (-3405,-4436), Area51_Final/DataLinkTrigger21 (-3666,-4411), Area51_Final/DataLinkTrigger24 (-2906,-4459) (+3 more) | CoolantCut, ReactorSwitch1, ReactorSwitch2 | set ReactorReady, +goal ActivateReactors |
| `DL_tong6` | Area51_Final/DataLinkTrigger17 (-3407,-4435), Area51_Final/DataLinkTrigger18 (-3668,-4410), Area51_Final/DataLinkTrigger23 (-2909,-4459) (+3 more) | CoolantCut, !ReactorSwitch1, ReactorSwitch2 |  |
| `DL_tong5` | Area51_Final/DataLinkTrigger15 (-3406,-4433), Area51_Final/DataLinkTrigger16 (-3667,-4408), Area51_Final/DataLinkTrigger22 (-2910,-4458) (+4 more) | CoolantCut, ReactorSwitch1, !ReactorSwitch2 |  |
| `DL_tong4` | Area51_Final/DataLinkTrigger11 (-3181,-3952) needs CoolantCut | CoolantCut | done ReturnToReactorLab |
| `DL_tong3` | Area51_Final/DataLinkTrigger14 (-2964,-951), Area51_Page/DataLinkTrigger2 (7356,-10870) needs coolantcut (+2 more) | CoolantCut | +goal ReturnToReactorLab |
| `DL_tong2` | Area51_Page/DataLinkTrigger11 (7495,-8414) |  |  |
| `DL_tong1` | Area51_Bunker/DataLinkTrigger13 (-1316,418), Area51_Bunker/DataLinkTrigger14 (712,3122), Area51_Bunker/DataLinkTrigger15 (-98,-293) (+2 more) |  | +goal EnterBlastDoors, +goal PenetrateBunker, give Image15_Area51Bunker |
| `DL_tong_reminder` | Area51_Page/DataLinkTrigger6 (6686,-7286), Area51_Page/DataLinkTrigger7 (5385,-7283) |  |  |
| `DL_tong_reached_bunker` | Area51_Bunker/DataLinkTrigger0 (4219,-1035) |  | done PenetrateBunker, done PowerElevator |
| `DL_Taunt_overload` | Area51_Entrance/DataLinkTrigger1 (1673,-2249) |  |  |
| `DL_SubStationExplodes` | Area51_Page/DataLinkTrigger0 (7325,-5900) |  |  |
| `DL_PageBarks3` | Area51_Page/DataLinkTrigger10 (6282,-7148), Area51_Page/DataLinkTrigger33 (6267,-7838), Area51_Page/DataLinkTrigger34 (7494,-9869) (+2 more) | PageBarks3, !DL_Blue4_Played | set PageBarks1=0, set PageBarks2=0, set PageBarks3=0, set PageBarks1, set PageBarks2 |
| `DL_PageBarks2` | Area51_Page/DataLinkTrigger9 (4907,-7548), Area51_Page/DataLinkTrigger31 (7497,-6093), Area51_Page/DataLinkTrigger32 (5352,-7241) (+2 more) | PageBarks2, !DL_Blue4_Played | set PageBarks1=0, set PageBarks2=0, set PageBarks3=0, set PageBarks1, set PageBarks3 |
| `DL_PageBarks1` | Area51_Page/DataLinkTrigger8 (7074,-6127), Area51_Page/DataLinkTrigger29 (4696,-7042), Area51_Page/DataLinkTrigger30 (6910,-7668) (+4 more) | PageBarks1, !DL_Blue4_Played | set PageBarks1=0, set PageBarks2=0, set PageBarks3=0, set PageBarks2, set PageBarks3 |
| `DL_Page_Dead` | Area51_Page/DataLinkTrigger36 (6337,-6511) |  | set endgame_page |
| `DL_Morgan_Talk` | Area51_Entrance/DataLinkTrigger4 (1695,-458), Area51_Entrance/DataLinkTrigger5 (3113,-1455) | !M15MeetEverett_Played | +goal TalkToMorgan |
| `DL_Morgan_Missed_Convo` | Area51_Final/DataLinkTrigger6 (-4682,-2150) needs !M15MeetEverett_Played | !M15MeetEverett_Played | +goal KillPage |
| `DL_main_control` | (none found) |  |  |
| `DL_JockDeathTongComment` | Mission15.uc:155 |  |  |
| `DL_JockDeath` | Mission15.uc:106 |  | set JockBlewUp |
| `DL_Helios_Intro` | Area51_Final/DataLinkTrigger34 (-4666,-2914) |  | +goal SeeHelios |
| `DL_Helios_Door2` | Area51_Final/DataLinkTrigger28 (-4196,-905) | MeetHelios_Played | trig page_blastdoors |
| `DL_Helios_Door1` | Area51_Final/DataLinkTrigger1 (-4203,-905) | !MeetHelios_Played |  |
| `DL_Final_Tong` | Area51_Final/DataLinkTrigger13 (-3176,-3989) | !CoolantCut |  |
| `DL_Final_Stanton01` | Area51_Final/DataLinkTrigger5 (-5306,-1739) |  |  |
| `DL_Final_Paul` | Area51_Entrance/DataLinkTrigger3 (-1004,186) | !PaulDenton_Dead |  |
| `DL_Final_Page03` | Area51_Final/DataLinkTrigger12 (-3462,-895) |  |  |
| `DL_Final_Page02` | Area51_Entrance/DataLinkTrigger2 (-1792,721) | !HealthEnd40, HealthStart100, !HealthEnd100, HealthStart90, !HealthEnd90, HealthStart80, !HealthEnd80, HealthStart70 (+5 more) | set HealthEnd10, set HealthEnd20, set HealthEnd30, set HealthEnd40, set HealthEnd50, set HealthEnd60, set HealthEnd70, set HealthEnd80, set HealthEnd90 (+1 more) |
| `DL_Final_Page01` | Area51_Final/DataLinkTrigger7 (-4695,-3067), Area51_Final/DataLinkTrigger8 (-4551,-3363), Area51_Final/DataLinkTrigger9 (-5556,-4653) (+1 more) |  |  |
| `DL_Final_Morgan03` | (none found) |  |  |
| `DL_Final_Morgan02` | Area51_Page/DataLinkTrigger4 (5019,-11075) needs DL_Final_Morgan_Played | DL_Final_Morgan_Played |  |
| `DL_Final_Morgan` | Area51_Page/DataLinkTrigger42 (6276,-8173), Area51_Page/DataLinkTrigger1 (6520,-8157), Area51_Page/DataLinkTrigger3 (6743,-8145) |  | +goal OverloadForceField, give Image15_BlueFusionDevice |
| `DL_Final_Helios07` | Area51_Final/DataLinkTrigger29 (-3880,1652) | HeliosFree |  |
| `DL_Final_Helios06_5` | Area51_Page/DataLinkTrigger5 (5452,-5581) needs HeliosFree, Area51_Page/DataLinkTrigger14 (5956,-5813) needs HeliosFree (+2 more) | HeliosFree | done DeactivateLocks, +goal MergeWithHelios |
| `DL_Final_Helios06` | Area51_Page/DataLinkTrigger24 (5708,-5708) | UplinkLock1, UplinkLock2 |  |
| `DL_Final_Helios05` | Area51_Page/DataLinkTrigger23 (5711,-5700) | !UplinkLock1, UplinkLock2 |  |
| `DL_Final_Helios04` | Area51_Page/DataLinkTrigger22 (5705,-5702), jump from DL_Final_Helios05 | UplinkLock1, !UplinkLock2 |  |
| `DL_Final_Helios03_5` | Area51_Page/DataLinkTrigger35 (6201,-6146) needs !Router_door_open |  |  |
| `DL_Final_Helios03` | Area51_Page/DataLinkTrigger20 (5831,-6156) |  |  |
| `DL_Final_Helios02` | Area51_Final/DataLinkTrigger2 (-3988,1476) | MeetHelios_Played |  |
| `DL_Final_Helios01` | Area51_Final/DataLinkTrigger0 (-5227,-2664) |  |  |
| `DL_Final_Helios_Come` | Area51_Final/DataLinkTrigger3 (-4001,885) |  |  |
| `DL_elevator` | Area51_Entrance/DataLinkTrigger18 (-1430,705) |  | set HealthStart10, set HealthStart20, set HealthStart30, set HealthStart40, set HealthStart50, set HealthStart60, set HealthStart70, set HealthStart80 (+2 more) |
| `DL_DoorExplodes` | Area51_Page/DataLinkTrigger41 (5987,-9993) |  |  |
| `DL_conveyor_room` | Area51_Entrance/DataLinkTrigger0 (3612,-2457) |  |  |
| `DL_ButtonWarning` | Area51_Page/DataLinkTrigger37 (7521,-10801) |  |  |
| `DL_Bunker_Start` | Area51_Bunker/DataLinkTrigger4 (-2153,1880), Area51_Bunker/DataLinkTrigger2 (-587,3718), Area51_Bunker/DataLinkTrigger7 (-441,3869) | !JockBlewUp |  |
| `DL_Bunker_PowerRoom` | Area51_Bunker/DataLinkTrigger12 (3712,2664) |  |  |
| `DL_Bunker_Power` | Area51_Bunker/DataLinkTrigger8 (4359,4090) |  | done PowerElevator |
| `DL_Bunker_Hangar` | Area51_Bunker/DataLinkTrigger11 (935,-881) | !JockBlewUp |  |
| `DL_Bunker_Fan` | Area51_Bunker/DataLinkTrigger6 (364,-2751) |  |  |
| `DL_Bunker_Elevator` | Area51_Bunker/DataLinkTrigger5 (3643,-1326) needs !DL_Bunker_Power_Played | !DL_Bunker_Power_Played |  |
| `DL_Bunker_blastdoor` | Area51_Bunker/DataLinkTrigger10 (2227,1222) |  | done EnterBlastDoors, +goal PowerElevator |
| `DL_Blue4` | Area51_Page/DataLinkTrigger28 (4401,-8773), Mission15.uc:394 |  | trig page_button |
| `DL_Blue3` | Area51_Page/DataLinkTrigger27 (4875,-8772), Mission15.uc:391 |  |  |
| `DL_Blue2` | Area51_Page/DataLinkTrigger26 (4715,-8775), Mission15.uc:389 | CoolantCut |  |
| `DL_Blue1` | Area51_Page/DataLinkTrigger25 (4565,-8779), Mission15.uc:387 |  |  |
| `DL_Blue_Fusion` | Area51_Page/DataLinkTrigger17 (6378,-6721), Area51_Page/DataLinkTrigger18 (6331,-7145), Area51_Page/DataLinkTrigger19 (4977,-6321) (+1 more) |  |  |
| `DL_blastdoor_shut` | Area51_Bunker/DataLinkTrigger9 (1550,1214) | !blast_door_open |  |

**Required (progression) conversations.** None for the exits as such: the three exits are fired by switches, a dispatcher and a `FlagTrigger`, not by conversations (chains above). The conversations that set the *scene* of each ending are `M15MeetTong` (adds `DestroyArea51`), `MeetHelios` (completes `SeeHelios`, adds `DeactivateLocks`),
`M15MeetEverett` (completes `TalkToMorgan`, adds `KillPage`), with the InfoLink families `DL_tong*`, `DL_Final_Helios*`, `DL_Final_Morgan`. Flags that gate an ending: **New Dark Age**: `CoolantCut` (Page `FlagTrigger0`, tag `coolant`), `ReactorSwitch1/2`, `ReactorButton1..3`, `ReactorReady`
(`FlagTrigger5` -> `Generator_panel`), `Generator_overload` (`FlagTrigger9`), then the Final map's `Switch4` fires `destroy_generator`, the tag of `Dispatcher7`, whose fourth output is `map_exit_generator` -> `MapExit0`. **Helios**: `MeetHelios_Played`, `UplinkLock1/2` (Page `FlagTrigger2/3`, tags `emitter_helios1/2`), `HeliosFree` (Page `FlagTrigger1`, tag `Set_flag_helios`), then the Final's `FlagTrigger3` at (-3768,2023,496) fires
`Merge_helios_exit` -> `MapExit1`. **Illuminati**: the four `NodeN_Frobbed` flags (Page `FlagTrigger14..17`), the Page map's `Switch4` -> `Dispatcher1` `kill_page` -> `start_endgame` -> `MapExit0`.

### 15.4 Objectives

| Goal | Kind | Text | Added by | Completed by |
| --- | --- | --- | --- | --- |
| `ActivateReactors` | secondary | Go to the reactor control room. Activate the three ion injectors, then initiate the antimatter-matter reaction. Run. | DL_tong7 | - |
| `ReturnToReactorLab` | secondary | (New Dark Age) Return to the reactor lab in Sector 3 to initiate a meltdown and destroy Area 51's global communications hub. | DL_tong3 | DL_tong4 |
| `EnterBlastDoors` | primary | Get past the blast doors north of the helipad. | DL_tong1 | DL_Bunker_blastdoor |
| `PenetrateBunker` | primary | Get access to the Area 51 Bunker. | DL_tong1 | DL_tong_reached_bunker |
| `PowerElevator` | secondary | Bring up the power to the elevator system in order to access Page's bunker below. | DL_Bunker_blastdoor | DL_tong_reached_bunker, DL_Bunker_Power |
| `TalkToMorgan` | secondary | Gain Sector 2 access by talking to Morgan Everett at the Station 5 holographic communicator. | DL_Morgan_Talk | M15MeetEverett |
| `KillPage` | secondary | (Join Illuminati) Kill Bob Page and clear the way for the former Illuminati leaders to restore an age-old secret government. Rule the world with compa | DL_Morgan_Missed_Convo, M15MeetEverett | - |
| `SeeHelios` | primary | Talk to Helios at the Aquinas Hub to gain access to Sector 4. | DL_Helios_Intro | MeetHelios |
| `OverloadForceField` | secondary | (Join Illuminati) Bring down the four blue-fusion reactors in Page's bunker then go to the infusion control room on the upper level to cut all power t | DL_Final_Morgan | - |
| `DeactivateLocks` | secondary | (Merge with Helios AI) Deactivate the uplink locks on the Aquinas Router at the east end of Sector 4, thus allowing Helios to exchange information wit | MeetHelios | DL_Final_Helios06_5 |
| `MergeWithHelios` | secondary | (Merge with Helios AI) Return to the Sector 3 Aquinas Hub to merge with Helios and rule earth with benevolence, wisdom, and absolute power. | DL_Final_Helios06_5 | - |
| `DestroyArea51` | secondary | (New Dark Age) First go to the coolant control room at the northwest corner of Sector 4 and cut off coolant to the reactors, then return to the reacto | M15MeetTong | - |

### 15.5 Choices with lasting consequences

Set here, alive in a later mission: **none** (there is no later mission). Read here, set earlier:

| Flag | Set earlier by | Read here by |
| --- | --- | --- |
| `EverettMechanicComment` | M11 conversation MeetEverett2@RayComment; M11 conversation MeetEverett2@deadset | checks in M15MeetEverett |

* **Ray** (mission 11): `Ray_Dead` decides whether the helicopter is sabotaged on arrival (`Mission15.FirstFrame:37`: `Ray_dead` is spelled with a lower-case d, which does not matter for a name) and `EverettMechanicComment` changes `M15MeetEverett`.
* **Paul or Gary**: `PaulDenton_Dead` (permanent, set in missions 0 to 6, 15) decides who the hologram in the Final is (`Mission15.Timer:284`).
* The endings themselves are the three `MapExit`s above; the death flags of `TracerTong`, `MorganEverett`, `GarySavage`, `BobPage`, `SamCarter`, `PaulDenton` are read in the endgame maps (`MissionEndgame` calls `DeleteAllFlags`).

### 15.6 Progression path

1. Bunker: `PlayerStart2`/`PlayerStart0`; `DL_tong1` adds `EnterBlastDoors` and `PenetrateBunker`; `blast_door_open` (`FlagTrigger0` at (1730,1673,-830)); `DL_Bunker_blastdoor`/`DL_Bunker_Power` (`PowerElevator`); `Teleporter0` to the Entrance.
2. Entrance: `Tong_talk` (`TongAppears`), `M15MeetEverett` (`EverettAppears`; completes `TalkToMorgan`), Entrance `Teleporter0` (`start`) to the Final.
3. Final (sector 3, 4): `SeeHelios`/`MeetHelios`, the reactor, the coolant control room, Paul or Gary's hologram; `Teleporter2` (`page_start`) to the Page's bunker for the Illuminati and Helios endings (the uplink locks and the nodes are in the Page map).
4. One of the three exits above.

| Map | Tag (movers) | Lock | Opened by |
| --- | --- | --- | --- |
| `15_Area51_Bunker` | `fan_door` (1) | locked, pick 0.80 | Switch1 Switch3 |
| `15_Area51_Bunker` | `power` (1) | unlocked, pick 0.20, not frobbable | Dispatcher Dispatcher0 |
| `15_Area51_Bunker` | `power_display` (5) | unlocked, pick 0.20 | DataLinkTrigger DataLinkTrigger8, Dispatcher Dispatcher0 |
| `15_Area51_Bunker` | `bot_door` (1) | unlocked, pick 0.20, not frobbable | Dispatcher Dispatcher1 |
| `15_Area51_Bunker` | `lower_elevator_sw` (1) | unlocked, pick 0.20, not frobbable | Dispatcher Dispatcher4 |
| `15_Area51_Bunker` | `lower_elevator_sw_works` (1) | unlocked, pick 0.20, not frobbable | Dispatcher Dispatcher4 |
| `15_Area51_Bunker` | `upper_elevator_sw` (1) | unlocked, pick 0.20, not frobbable | Dispatcher Dispatcher4 |
| `15_Area51_Bunker` | `upper_elevator_sw_works` (1) | unlocked, pick 0.20, not frobbable | Dispatcher Dispatcher4 |
| `15_Area51_Bunker` | `Aug_door` (1) | unlocked, pick 0.20, not frobbable | Keypad2 Keypad0 |
| `15_Area51_Bunker` | `doors_lower` (2) | unlocked, pick 0.20, not frobbable | Switch2 Switch0 |
| `15_Area51_Bunker` | `Shack_door` (1) | locked, pick 0.60 | Switch1 Switch7 |
| `15_Area51_Entrance` | `chamber1` (1) | unlocked, pick 0.20, not frobbable | Keypad3 Keypad1 |
| `15_Area51_Entrance` | `chamber3` (1) | unlocked, pick 0.20, not frobbable | Keypad3 Keypad3 |
| `15_Area51_Entrance` | `chamber4` (1) | unlocked, pick 0.20, not frobbable | Keypad3 Keypad6 |
| `15_Area51_Entrance` | `chamber5` (1) | unlocked, pick 0.20, not frobbable | Keypad3 Keypad7 |
| `15_Area51_Entrance` | `elevator_doors` (2) | unlocked, pick 0.20, not frobbable | Dispatcher Dispatcher0, DirectionalTrigger DirectionalTrigger2 |
| `15_Area51_Entrance` | `doors_lower` (2) | unlocked, pick 0.20, not frobbable | Dispatcher Dispatcher1, LogicTrigger LogicTrigger3 |
| `15_Area51_Entrance` | `door_lab1` (1) | unlocked, pick 0.20, not frobbable | Keypad1 Keypad4, LightSwitch LightSwitch5 |
| `15_Area51_Entrance` | `door_lab2` (1) | unlocked, pick 0.20, not frobbable | Keypad1 Keypad5, LightSwitch LightSwitch6 |
| `15_Area51_Entrance` | `door_start` (2) | unlocked, pick 0.20, not frobbable | Trigger Trigger3 |
| `15_Area51_Final` | `door_generator` (1) | unlocked, pick 0.20, not frobbable | Switch1 Switch11, Keypad1 Keypad14 |
| `15_Area51_Final` | `Page_Blastdoors` (2) | unlocked, pick 0.20, not frobbable | conversation DL_Helios_Door2 |
| `15_Area51_Final` | `door_storage` (1) | unlocked, pick 0.20, not frobbable | Keypad1 Keypad13, Switch1 Switch32 |
| `15_Area51_Final` | `blastdoor_final` (1) | unlocked, pick 0.20, not frobbable | conversation M15MeetTong |
| `15_Area51_Final` | `forks` (1) | unlocked, pick 0.20, not frobbable | Dispatcher Dispatcher2 |
| `15_Area51_Final` | `door_pagearea` (1) | unlocked, pick 0.20, not frobbable | Switch1 Switch8, Switch1 Switch18 |
| `15_Area51_Final` | `blastdoor_upper` (1) | unlocked, pick 0.20, not frobbable | Keypad1 Keypad4, Switch1 Switch15 |
| `15_Area51_Final` | `tram` (1) | unlocked, pick 0.20, not frobbable | Dispatcher Dispatcher3 |
| `15_Area51_Final` | `tram_door` (2) | unlocked, pick 0.20 | Dispatcher Dispatcher3 |
| `15_Area51_Final` | `Generator_panel` (1) | unlocked, pick 0.20, not frobbable | FlagTrigger FlagTrigger5 |
| `15_Area51_Final` | `injector2` (1) | unlocked, pick 0.20, not frobbable | Dispatcher Dispatcher1 |
| `15_Area51_Final` | `injector3` (1) | unlocked, pick 0.20, not frobbable | Dispatcher Dispatcher4 |
| `15_Area51_Final` | `Aug_door` (1) | unlocked, pick 0.20, not frobbable | Keypad2 Keypad0 |
| `15_Area51_Final` | `Helios_connected` (8) | unlocked, pick 0.20 | FlagTrigger FlagTrigger15 |
| `15_Area51_Final` | `bot_doors` (2) | unlocked, pick 0.20, not frobbable | Dispatcher Dispatcher8 |
| `15_Area51_Final` | `door_storage2` (1) | unlocked, pick 0.20, not frobbable | Keypad1 Keypad12, Switch1 Switch31 |
| `15_Area51_Final` | `door_storage1` (1) | unlocked, pick 0.20, not frobbable | Keypad1 Keypad1, Switch1 Switch6 |
| `15_Area51_Final` | `Generator_overload` (1) | unlocked, pick 0.20, not frobbable | FlagTrigger FlagTrigger9 |
| `15_Area51_Page` | `doors_lab_2` (2) | unlocked, pick 0.20, not frobbable | Switch2 Switch25, Switch2 Switch26 |
| `15_Area51_Page` | `doors_lab_1` (2) | unlocked, pick 0.20, not frobbable | Keypad2 Keypad4, Switch2 Switch10 |
| `15_Area51_Page` | `Doors_page` (2) | unlocked, pick 0.20, not frobbable | Dispatcher Dispatcher4 |
| `15_Area51_Page` | `doors_lab_3` (2) | unlocked, pick 0.20, not frobbable | Keypad2 Keypad7, Switch2 Switch11 |
| `15_Area51_Page` | `coolant_doors` (2) | unlocked, pick 0.20, not frobbable | Switch2 Switch2 |
| `15_Area51_Page` | `power_on2` (1) | unlocked, pick 0.20 | Dispatcher Dispatcher0 |
| `15_Area51_Page` | `power_on1` (1) | unlocked, pick 0.20 | Dispatcher Dispatcher2 |
| `15_Area51_Page` | `Doors_page2` (2) | unlocked, pick 0.20, not frobbable | Dispatcher Dispatcher3 |
| `15_Area51_Page` | `door_helios_room` (1) | locked, pick 0.20, not frobbable | Keypad1 Keypad2 |
| `15_Area51_Page` | `coolant` (1) | unlocked, pick 0.20 | LogicTrigger LogicTrigger4 |
| `15_Area51_Page` | `shield1` (1) | unlocked, pick 0.20, not frobbable | Dispatcher Dispatcher1, LogicTrigger LogicTrigger0 |
| `15_Area51_Page` | `platform_pieces` (3) | unlocked, not frobbable | Dispatcher Dispatcher1, script Mission15:417 |
| `15_Area51_Page` | `node1` (1) | unlocked, pick 0.20, not frobbable | Keypad3 Keypad0 |
| `15_Area51_Page` | `node2` (1) | unlocked, pick 0.20, not frobbable | Keypad3 Keypad1 |
| `15_Area51_Page` | `node3` (1) | unlocked, pick 0.20, not frobbable | Keypad3 Keypad5 |
| `15_Area51_Page` | `node4` (1) | unlocked, pick 0.20, not frobbable | Keypad3 Keypad6 |
| `15_Area51_Page` | `door_clone_entrance` (1) | unlocked, pick 0.20, not frobbable | Switch1 Switch7, Switch1 Switch19 |
| `15_Area51_Page` | `door_page_overlook` (1) | unlocked, pick 0.20, not frobbable | Switch1 Switch5 |
| `15_Area51_Page` | `door_clone_exit` (1) | unlocked, pick 0.20, not frobbable | Dispatcher Dispatcher16 |
| `15_Area51_Page` | `bot_doors` (2) | unlocked, pick 0.20, not frobbable | Dispatcher Dispatcher5 |
| `15_Area51_Page` | `Page_turrets` (4) | unlocked, pick 0.20, not frobbable | conversation MeetBobPage |
| `15_Area51_Page` | `Page_button` (1) | unlocked, pick 0.20, not frobbable | conversation DL_Blue4 |
| `15_Area51_Page` | `door3` (1) | locked, pick 0.90, breakable 0.50 | Keypad1 Keypad3 |
| `15_Area51_Page` | `lower1_door` (1) | unlocked, pick 0.20, not frobbable | Dispatcher Dispatcher9 |
| `15_Area51_Page` | `upper1_door` (1) | unlocked, pick 0.20, not frobbable | Dispatcher Dispatcher10 |
| `15_Area51_Page` | `door2` (1) | locked, pick 0.90, breakable 0.50 | Keypad1 Keypad8 |
| `15_Area51_Page` | `door1` (1) | locked, pick 0.90, breakable 0.50 | Keypad1 Keypad9 |
| `15_Area51_Page` | `SubjectDoors1` (2) | locked, key SubjectDoors, not frobbable | Switch2 Switch15, Switch2 Switch16, Trigger Trigger0 |
| `15_Area51_Page` | `GreyDoors` (4) | unlocked, key SubjectDoors, not frobbable | Dispatcher Dispatcher16 |
| `15_Area51_Page` | `radiation_exit` (2) | locked, key SubjectDoors, not frobbable | Switch2 Switch22, Keypad2 Keypad10 |
| `15_Area51_Page` | `exitdoor` (2) | locked, key SubjectDoors, not frobbable | Switch2 Switch17, Switch2 Switch18 |
| `15_Area51_Page` | `router_door` (4) | unlocked, pick 0.20, not frobbable | Dispatcher Dispatcher17 |

Key doors (a placed `NanoKey` opens them, or the lock is picked; frob only): `storage`, `tower`, `Factory`, `door_lower`.

(19 further movers of these maps are locked with a pickable lock or breakable, take no key that exists as a placed `NanoKey` and are fired by no event: not listed.)

**Progression blocker (mission 15).** The first of: the bunker's blast door / elevator power; the Entrance and Final teleporters; for the chosen ending, the flags in 15.3 not set or the final `Switch4` / `FlagTrigger3` / dispatcher not firing; the `MapExit` of the ending not loading its endgame map.
A run needs one ending; the census can pick all three. The Page respawns, Jock's sabotage and the holograms are not blockers.

### 15.7 Slots

| Slot | Map | Saved as | Saves, play time | Important NPCs dead or knocked out (all) | Lasting-choice flags in the file (all) | Goals still open |
| --- | --- | --- | --- | --- | --- | --- |
| N0036 | `15_Area51_bunker` | Area 51 - Bunker | 687, 1136 min | AnnaNavarre, DrugDealer, Gatekeeper, GilbertTerrorist, GuntherHermann, HowardStrong, JoeGreene, JoJoFine, JosephManderley, JuanLebedev, MaggieChow, MJ12Commando, MJ12Troop, PrivateLloyd, Ray, Supervisor01, Terrorist, WaltonSimons | AmbrosiaTagged, BathroomBarks_Played, FilbenGaveKey, GreenKnowsAboutDowd, GuntherRespectsPlayer=0, HeardGrenadeTalk, HelpSailor, JacobsonRecruited, JaimeRecruited, KnowsAboutKillphrase, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, M04MetWalton, M08WarnedSmuggler, M11MetWalton, MeetJoeGreen_Played, PlayerMetFilben, SandraWentToCalifornia | - |
| N0037 | `15_Area51_entrance` | Area51 - Entrance | 708, 1162 min | AnnaNavarre, DrugDealer, Gatekeeper, GilbertTerrorist, GuntherHermann, HowardStrong, JoeGreene, JoJoFine, JosephManderley, JuanLebedev, MaggieChow, MJ12Commando, MJ12Troop, PrivateLloyd, Ray, Supervisor01, Terrorist, WaltonSimons | AmbrosiaTagged, BathroomBarks_Played, FilbenGaveKey, GreenKnowsAboutDowd, GuntherRespectsPlayer=0, HeardGrenadeTalk, HelpSailor, JacobsonRecruited, JaimeRecruited, KnowsAboutKillphrase, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, M04MetWalton, M08WarnedSmuggler, M11MetWalton, MeetJoeGreen_Played, PlayerMetFilben, SandraWentToCalifornia | - |
| N0038 | `15_Area51_final` | Area51 - Final | 730, 1181 min | AnnaNavarre, DrugDealer, Gatekeeper, GilbertTerrorist, GuntherHermann, HowardStrong, JoeGreene, JoJoFine, JosephManderley, JuanLebedev, MaggieChow, MJ12Commando, MJ12Troop, PrivateLloyd, Ray, Supervisor01, Terrorist, WaltonSimons | AmbrosiaTagged, BathroomBarks_Played, FilbenGaveKey, GreenKnowsAboutDowd, GuntherRespectsPlayer=0, HeardGrenadeTalk, HelpSailor, JacobsonRecruited, JaimeRecruited, KnowsAboutKillphrase, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, M04MetWalton, M08WarnedSmuggler, M11MetWalton, MeetJoeGreen_Played, PlayerMetFilben, SandraWentToCalifornia | DestroyArea51, killpage |
| N0040 | `15_Area51_final` | Area51 - Final | 744, 1199 min | AnnaNavarre, DrugDealer, Gatekeeper, GilbertTerrorist, GuntherHermann, HowardStrong, JoeGreene, JoJoFine, JosephManderley, JuanLebedev, MaggieChow, MJ12Commando, MJ12Troop, PrivateLloyd, Ray, Supervisor01, Terrorist, WaltonSimons | AmbrosiaTagged, BathroomBarks_Played, FilbenGaveKey, GreenKnowsAboutDowd, GuntherRespectsPlayer=0, HeardGrenadeTalk, HelpSailor, JacobsonRecruited, JaimeRecruited, KnowsAboutKillphrase, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, M04MetWalton, M08WarnedSmuggler, M11MetWalton, MeetJoeGreen_Played, PlayerMetFilben, SandraWentToCalifornia | killpage, SeeHelios, DestroyArea51 |
| N0042 | `15_Area51_page` | Area51 - Page | 754, 1215 min | AnnaNavarre, DrugDealer, Gatekeeper, GilbertTerrorist, GuntherHermann, HowardStrong, JoeGreene, JoJoFine, JosephManderley, JuanLebedev, MaggieChow, MJ12Commando, MJ12Troop, PrivateLloyd, Ray, Supervisor01, Terrorist, WaltonSimons | AmbrosiaTagged, BathroomBarks_Played, FilbenGaveKey, GreenKnowsAboutDowd, GuntherRespectsPlayer=0, HeardGrenadeTalk, HelpSailor, JacobsonRecruited, JaimeRecruited, KnowsAboutKillphrase, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, M04MetWalton, M08WarnedSmuggler, M11MetWalton, MeetJoeGreen_Played, PlayerMetFilben, SandraWentToCalifornia | killpage, DestroyArea51, DeactivateLocks, OverloadForceField |
| R0035 | `15_Area51_final` | Area51 - Final | 285, 1421 min | AnnaNavarre, DrinkingMan, DrugDealer, Gatekeeper, GilbertTerrorist, Gray, GuntherHermann, HowardStrong, JoJoFine, JosephManderley, JuanLebedev, MaggieChow, MJ12Commando, MJ12Troop, PrivateLloyd, Ray, Supervisor01, Terrorist, WaltonSimons; knocked out: Ray | AmbrosiaTagged, FilbenGaveKey, GuntherRespectsPlayer, HeardGrenadeTalk, HelpSailor, JacobsonRecruited, KnowsAboutKillphrase, KnowsGuntherKillphrase, KnowsOfJoJo, M01PlayerMetFilben, M02MechSlur=0, M04MetWalton, M11MetWalton, PlayerMetFilben, SandraWentToCalifornia | killpage, DestroyArea51, DeactivateLocks |

Six slots: bunker (N0036), entrance (N0037), Final (N0038, N0040, and the GOTY slot R0035 with modded weapons and Targeting/Regeneration/Power Recirculator augmentations: [travel](travel.md#play-step-4-loading-a-saved-game) loads it), Page (N0042).
N0038, N0040 and N0042 already have `M15MeetEverett_Played`, `M15MeetTong_Played` and `TongAppears` (N0042 and R0035 also `MeetHelios_Played`), so the three scenes have been shown; no slot is past an ending's last trigger.

## The intro, the endgames and the logo maps (missions 98, 99, -2, -1)

Not missions of the campaign proper, but they are where a game starts and ends and each carries a script, a conversation or a travel.

### 98: `00_Intro`

| Map | Actors | Level info (`MapName`; `MissionLocation`) | Startup text | Script | Arrives from | Leaves to |
| --- | --- | --- | --- | --- | --- | --- |
| `00_Intro` | 1833 | Intro; - | - | MissionIntro | - | - |

* **What it is.** The opening cinematic (`MissionIntro`, `missionNumber` 98, author Chris Todd): a Bob Page and Walton Simons conversation `Intro` (21 speeches) over the map's camera path. The map has one `MapExit` (`MapExit1`) with **no destination**: unused or script-set (unverified). One `DataLinkTrigger`
  (`DL_Daedalus_03`, tag `DaedalusDL03`) is left over in it. It has 41 pawns, 12 of them `bImportant` (Bob Page, Walton Simons, ...), which is why `BobPage_Dead`, `WaltonSimons_Dead` and others appear as set and read in mission 98 in the table of who can die (the intro's own cast; the intro wipes the flag store first).
* **How the player arrives.** `DeusExPlayer.ShowIntro` -> `SendPlayer(Self, "00_Intro")` (`DeusExPlayer.uc:1021-1033`): the main menu's Intro item, or New Game (`ShowIntro(True)`, which sets `bStartNewGameAfterIntro`). Nothing in the campaign leads here.
* **Script `MissionIntro`** (`.cache/research/src/DeusEx/MissionIntro.uc`, 97 lines): `InitStateMachine` runs `Super`, then `flags.DeleteAllFlags()` and sets `PlayerTraveling` again (`:12-23`); `FirstFrame` resets the root window's flags, finds the `BobPage` and **starts the conversation `Intro` by name** (`StartConversationByName('Intro', bob, False, True)`, `:43-50`),
  and lowers the sound volume to 32 (`:53-55`, restored by `PreTravel`); `Timer` (`:80-93`): `Intro_Played` set -> clears it (expiration 1) and calls `player.PostIntro()`.
* **How it ends.** `PostIntro` (`DeusExPlayer.uc:6968-6979`): with `bStartNewGameAfterIntro` -> `StartNewGame(strStartMap)` (`SendPlayer` to `strStartMap`, or `01_NYC_UNATCOIsland` when empty, `:988`), else `SendPlayer(Self, "dxonly")`. `StartNewGame` wipes the flags again (`ResetPlayer`).
* **Conversation** `Intro` (owner `BobPage`, first person, non-interactive): the only conversation of list 98; no choice, no flag. Slots: none. Required: the conversation must end (it sets `Intro_Played`) or the intro never leaves.

### 99: `99_Endgame1`, `99_Endgame2`, `99_Endgame3` (and `99_Endgame4`)

| Map | Actors | Level info (`MapName`; `MissionLocation`) | Startup text | Script | Arrives from | Leaves to |
| --- | --- | --- | --- | --- | --- | --- |
| `99_Endgame1` | 1127 | Endgame1; - | - | MissionEndgame | 15_Area51_Final; 99_Endgame1 | 99_Endgame1 |
| `99_Endgame2` | 1292 | Endgame2; - | - | MissionEndgame | 15_Area51_Final | - |
| `99_Endgame3` | 1254 | Endgame3; - | - | MissionEndgame | 15_Area51_Page | - |
| `99_Endgame4` | 44 | -; - | - | (none) | - | - |

* **Arrival.** `15_Area51_Final` `MapExit0` -> `99_Endgame1`, `MapExit1` -> `99_Endgame2`; `15_Area51_Page` `MapExit0` -> `99_endgame3` (mission 15 -> 99). `99_Endgame1`'s own `MapExit0` (tag `map_exit_generator`) points at itself. `99_Endgame4` (44 actors) has no `DeusExLevelInfo`, no script and is the target of nothing.
* **Script `MissionEndgame`** (`.cache/research/src/DeusEx/MissionEndgame.uc`, 239 lines): `InitStateMachine` wipes the flag store and sets `PlayerTraveling` as the intro does (`:17-28`); `FirstFrame` (`:36-60`) resets the root window's flags, **starts the conversation `Endgame1/2/3` by name** (owner the player, `JCDenton`) and lowers the sound volume;
  `Timer` (`:83-122`): `EndgameExplosions` (set by `Endgame1` itself) -> random explosions and fragments around the player (`ExplosionEffects`); `EndgameN_Played` -> the quote of the ending (`endgameQuote[2N]`, `[2N+1]`, `HUDMissionStartTextDisplay`) once, and after `endgameDelays[N]` seconds `FinishCinematic`
  (`Player.ShowCredits(True)`, `:128-148`).
* **How it ends.** The credits window (`CreditsWindow`, then `QuotesWindow` when `bQuotesEnabled`) sends the player to `dxonly` when it is destroyed with `bLoadIntro` (`CreditsWindow.uc:121-128`, `QuotesWindow.uc:98`): back to the logo map; the game is not over for the process, only for the campaign.
* **Conversations** (list 99): `Endgame1` (11 speeches; the speakers are a computer voice, Tracer Tong, Bob Page and Helios; one `SetFlag` `EndgameExplosions`, one `Jump`), `Endgame2` (14 speeches: JC Double, Helios, Bob Page), `Endgame3` (13 speeches: Morgan Everett, JC Double). No choice. `Endgame1` ("New Dark Age") is the Tong ending, `Endgame2` the Helios merge, `Endgame3` the Illuminati.
* **Slots**: none. A row for an endgame starts from the mission 15 slot of the matching ending or from a harness placement.

### -2 and -1: `DX` and `DXOnly` (and `Entry`)

* `DX.dx` (`missionNumber` -2, location "Intro", 42 actors, `PlayerStart1`) is the logo map the game boots into (`Browse: DX.dx?Name=Player?Class=DeusEx.JCDentonMale` after `LoadMap: entry.dx`, [travel](travel.md#measurements)); the main menu opens on it; its Training button, New Game and Load Game are the entries of the campaign. No script, no conversation.
* `DXOnly.dx` (-1, location "Splash", 16 actors) is where credits, quotes, death (`OPEN DXONLY`) and the demo splash send the player; the rotating logo with a `Paralyzed` player. No script.
* `Entry.dx` is the engine's entry level (19 actors, no `DeusExLevelInfo`).

## The choices with lasting consequences across missions

Two kinds of state cross a mission change by flags (items, credits, skills, augmentations, notes, goals and the conversation history cross in the player object, [travel](travel.md#what-travel-means)):
the **carried flags** (set by an event in mission *S*, still alive in a later mission *R* by the lifetime model, read there while *R* has no setter of its own) and the **deaths** of `bImportant` pawns. The data finds **36 carried flags**; the table gives where each is set, when it expires and who reads it later.
(A flag that several missions' conversations set with the same name, such as `KnowsSmugglerPassword` or the shop flags `M03BoughtScope`, is re-set in each reader's mission and is not carried.)

| Flag | Set by | Expires | Read later by |
| --- | --- | --- | --- |
| `AmbrosiaTagged` | M2 conversation DL_AmbrosiaFound, M2 trigger 02_NYC_BatteryPark/FlagTrigger1 | never; mission 6 | M3 checks in CarterGreeting03, M3 checks in ManderleyDebriefing02, M3 checks in AnnaManderley1, M3 checks in AnnaAtUNATCO |
| `AnnaKilledLebedev` | M3 script Mission03.Timer:312 | mission 6 | M4 checks in M04LloydBarks |
| `BathroomBarks_Played` | M1 conversation BathroomBarks | never | M3 checks in M03ShannonBarks, M4 checks in M04ShannonBarks |
| `BatteryParkSlaughter` | M2 script Mission02.Timer:178 | mission 6 | M3 checks in TroopBarks2, M3 checks in TroopBarks1, M3 checks in CarterGreeting03, M3 checks in CarterBarks, M3 checks in AnnaManderley2, M3 checks in AnnaManderley1 |
| `EscapeSuccessful` | M2 trigger 02_NYC_BatteryPark/FlagTrigger7, M2 trigger 02_NYC_BatteryPark/FlagTrigger8 | mission 7 | M3 checks in ManderleyDebriefing02, M3 checks in AnnaAtUNATCO |
| `EverettMechanicComment` | M11 conversation MeetEverett2@RayComment, M11 conversation MeetEverett2@deadset | never | M12 checks in TongSick, M14 checks in JockArea51, M15 checks in M15MeetEverett |
| `FilbenGaveKey` | M1 conversation MeetFilben@NoKeyB (=0), M1 conversation MeetFilben@GetKeyB | never | M3 checks in M03MeetFilben, M3 checks in FilbenAngryBarks |
| `FordSchickRescued` | M2 script Mission02.PreTravel:122 | mission 9 | M3 checks in SmugglerThanks, M3 checks in MeetSmuggler, M3 needed by SckickThanks, M3 checks in FordBarks, M4 checks in M04MeetSmuggler, M8 script Mission08.FirstFrame:28 |
| `FordSchickRescueDone` | M2 script Mission02.Timer:439 | mission 9 | M3 needed by SmugglerWaiting, M3 needed by SmugglerThanks |
| `GreenKnowsAboutDowd` | M8 conversation M08MeetJoeGreen@TellsAboutDowd | never | M9 script Mission09.Timer:170 |
| `GuntherFreed` | M1 trigger 01_NYC_UNATCOIsland/FlagTrigger2 | mission 12 | M11 checks in M11MeetGunther |
| `GuntherRespectsPlayer` | M1 conversation GuntherRescued@GiveSpeech, M1 conversation GuntherRescued@GiveNothing (=0), M1 conversation GuntherRescued@GiveNothingNicely | never | M11 checks in M11MeetGunther, M2 checks in GuntherHermann_BarkFutz, M3 checks in GuntherHermann_BarkFutz, M3 checks in TroopBarks2 |
| `HeardGrenadeTalk` | M2 conversation UNATCOGrenade1Meet | never | M3 checks in ManderleyDebriefing02 |
| `HelpSailor` | M8 conversation M08MeetSailor@GetPass | never | M9 checks in MeetFrontGuard, M9 checks in FrontGuardBarks, M9 checks in DoorGuardBarks, M9 needed by CafWorker1Help, M9 needed by CafWorker1Barks2, M9 needed by CafWorker1Barks, M9 trigger 09_NYC_Dockyard/FlagTrigger0, M9 trigger 09_NYC_Ship/FlagTrigger0 |
| `JacobsonRecruited` | M5 conversation M05MeetAlexJacobson | never | M6 script Mission06.FirstFrame:86 |
| `JaimeRecruited` | M5 conversation M05MeetJaime@Recruit | never | M10 checks in DL_metrosewer, M6 checks in Base_Guard_MiddleBarks, M6 checks in M07AlexJacobsonBarks, M6 checks in M06MeetAlexJacobson, M6 checks in M06AlexJacobsonBarks, M6 script Mission06.FirstFrame:76, M10 script Mission10.FirstFrame:31 |
| `KnowsAboutKillphrase` | M5 conversation PaulInMedLab@Killphrase | never | M10 checks in M10MeetJaime |
| `KnowsGuntherKillphrase` | M10 conversation M10MeetJaime@Continue | never | M11 checks in M11MeetGunther |
| `KnowsOfJoJo` | M2 conversation CounselWorker@Curious, M2 conversation MeetSandraRenton@CResume | never | M3 checks in ManderleyDebriefing02 |
| `M01PlayerAggressive` | M1 script Mission01.Timer:91 | mission 6 | M2 checks in PaulLeaving, M3 checks in TroopBarks2, M3 checks in TroopBarks1 |
| `M01PlayerMetFilben` | M1 conversation MeetFilbenAfterStatue, M1 conversation MeetFilben | never | M3 checks in M03MeetFilben |
| `M02MechSlur` | M2 conversation AnnaThanks@Cocky, M2 conversation AnnaThanks@TeamPlayer (=0) | never | M3 checks in TroopBarks2, M3 checks in AnnaEntrance, M3 checks in AnnaAtUNATCO |
| `M02QuestionedGreen` | M2 conversation MeetJoeGreen2@GreenQuestioned | never | M3 checks in ManderleyDebriefing02, M4 checks in M04MeetJoeGreen |
| `M02ViolenceInBar` | M2 script Mission02.Timer:416 | mission 4 | M3 checks in ManderleyDebriefing02 |
| `M03PlayerKilledAnna` | M3 conversation DL_AlexShocked | never | M4 checks in ManderleyDebriefing03, M4 checks in GuntherShowdown, M4 checks in CokeTroopBarks |
| `M04MetWalton` | M4 conversation M04MeetWalton | never | M14 checks in WaltonShowdown |
| `M08WarnedSmuggler` | M8 conversation M08SmugglerConvos@GiveWarning | never | M9 checks in DL_BadNews |
| `M11MetWalton` | M11 conversation M11WaltonHolo | never | M14 checks in WaltonShowdown |
| `MeetJoeGreen_Played` | M2 conversation MeetJoeGreen | never | M4 checks in M04MeetJoeGreen |
| `PlayerBailedOutWindow` | M4 trigger 04_NYC_Hotel/FlagTrigger9 | mission 6 | M5 script Mission05.FirstFrame:37 |
| `PlayerKilledLebedev` | M3 script Mission03.Timer:309, M3 script Mission03.Timer:322 | mission 6 | M4 checks in DL_SeeManderley, M4 checks in M04TroopBarks, M4 checks in M04ScottBarks, M4 checks in M04MeetCarter, M4 checks in M04LloydBarks, M4 checks in ManderleyDebriefing03, M4 checks in M04MeetJaime2, M4 checks in CokeTroopBarks, M4 checks in M04MeetAlex |
| `PlayerMetFilben` | M1 conversation MeetFilbenAfterStatue, M1 conversation MeetFilben, M3 conversation M03MeetFilben@FirstMeeting | never | M4 checks in M04MeetFilben |
| `SandraWentToCalifornia` | M4 conversation SandraAttackedByJoJoThanks, M4 conversation FamilySquabbleWrapUpGilbertDead, M4 conversation FamilySquabbleWrapUp@Hop | never | M12 checks in MeetBum_M, M12 checks in BumsOverheard2, M12 checks in BumsOverheard, M8 checks in M08MeetSailor, M8 script Mission08.FirstFrame:19, M12 script Mission12.FirstFrame:37 |
| `SimonsAssassination` | M3 conversation SimonsBarks@A4 | never | M14 checks in DL_Simons2 |
| `SubTerroristsDead` | M2 script Mission02.Timer:196 | mission 6 | M3 checks in ManderleyDebriefing02, M3 checks in AnnaAtUNATCO |
| `TenderloinSlaughter` | M2 script Mission02.Timer:285 | mission 6 | M3 checks in TroopBarks2, M3 checks in TroopBarks1, M3 checks in CarterGreeting03, M3 checks in PrivateLloydBark, M3 checks in ManderleyDebriefing02 |

What each is, in the player's terms. **Dialogue-only** flags change a line or a branch of a later conversation; the others change who is in a map or what a script does:

* **Mission 1**: *the commander's fate* is not a carried flag but `TerroristCommander_Dead`/`_Unconscious` (permanent), read in mission 1 by `PaulCongratulations`, `M02Briefing`, `MeetCarter`, `MeetManderley` and others and in mission 3 by Filben's `M03MeetFilben`, `FilbenNormalBarks` and `FilbenAngryBarks`; `FilbenGaveKey` ("You can trust me.") and `M01PlayerMetFilben`/`PlayerMetFilben` -> Filben's mission 3 and 4 conversations (dialogue only);
  `GuntherFreed` (expiration 12) and `GuntherRespectsPlayer` (armed him or not) -> mission 11's `M11MeetGunther` (it picks the branches `NotRescued`/`PlayerRefusedToArmGunther`); `M01PlayerAggressive` (8 or more lethal kills, expiration 6) -> UNATCO troop barks in missions 2 and 3 and `PaulLeaving` (dialogue only).
* **Mission 2**: `AmbrosiaTagged`, `SubTerroristsDead`, `EscapeSuccessful`, `BatteryParkSlaughter`, `TenderloinSlaughter`, `M02ViolenceInBar`, `HeardGrenadeTalk`, `KnowsOfJoJo`, `M02QuestionedGreen`, `MeetJoeGreen_Played`, `M02MechSlur` -> the mission 3 UNATCO debriefing (`ManderleyDebriefing02`), Carter's, Anna's and the troops' lines, mission 4's Joe Green
  (dialogue only). `FordSchickRescued`/`FordSchickRescueDone` are meant to reach missions 3, 4 and 8 (the smuggler's thanks, Ford in his lair) but the data cannot deliver them: see [mission 2](#mission-02-battery-park-and-hells-kitchen-nyc).
* **Mission 3**: who killed Lebedev (`PlayerKilledLebedev`/`AnnaKilledLebedev`, expiration 6) and `M03PlayerKilledAnna` -> mission 4's UNATCO conversations; **`M03PlayerKilledAnna` also changes `GuntherShowdown`** (its `AnnaDead` and `AnnaDead2` branches fire `GuntherAttacksJC` or `Mission4Exit` without the player's choice; which of the two is taken depends on checks that the extraction does not separate); `PlayerMetFilben` -> `M04MeetFilben`;
  `SimonsAssassination` -> mission 14's `DL_Simons2`.
* **Mission 4**: `SandraWentToCalifornia` (permanent) -> **mission 8 removes Sandra Renton** (`Mission08.FirstFrame:19`), mission 12 **brings her to the gas station** (`Mission12.FirstFrame:37`) and changes the bums' lines; `PlayerBailedOutWindow` (expiration 6) -> **mission 5 removes Paul from the lab** (`Mission05.FirstFrame:37`); `M04MetWalton` -> mission 14's `WaltonShowdown`.
* **Mission 5**: `JaimeRecruited` (**he is in the Tong base in Hong Kong after VersaLife, and not in the Paris metro**), `JacobsonRecruited` (Alex in the Tong base), `KnowsAboutKillphrase` (`M10MeetJaime`).
* **Mission 8**: `HelpSailor` (**the Brooklyn Naval Shipyard's guards, cafeteria worker and two alliance/welcome triggers read it**), `GreenKnowsAboutDowd` (the graveyard commandos, which also need the never-set `suprisePoint`), `M08WarnedSmuggler` (`DL_BadNews`).
* **Missions 10 and 11**: `KnowsGuntherKillphrase` (the killphrase choice of `M11MeetGunther`), `EverettMechanicComment` (missions 12, 14, 15: the `Rattle` branches of Jock's conversations and `M15MeetEverett`), `M11MetWalton` (mission 14).

**Who can die.** `ScriptedPawn.Died` sets `<BindName>_Dead` (permanent) for any pawn with `bImportant`, and `<BindName>_Unconscious` as well when the pawn is `bStunned`: **a knocked-out important pawn also counts as dead** for the rule below, and the conversations that check `_Unconscious` (Carter's `GoodGuy` branch for the commander) tell them apart.
From then on `MissionScript.FirstFrame` destroys that BindName's pawns in every map entered by travel (`MissionScript.uc:97-105`), so **a killed important NPC is absent from every later map**. Scripts add their own cases: `Mission01.Timer` destroys Gunther with `Destroy` (no flag); `Mission05.Timer` kills Anna (`annadies`); `Mission03.Timer` records Lebedev's killer (and sets `JuanLebedev_Dead` itself for a third party); `Mission11.Timer` kills Gunther (`KillGunther`, with the permanent `GuntherHermann_Dead`).
The table lists every important BindName of the 83 maps (85 rows; the intro and endgame casts are the missions 98 and 99) with the missions where it is placed and every other place the flag is read:

| BindName | Class | Important in (mission: maps) | Other places the flag is read |
| --- | --- | --- | --- |
| AnnaNavarre | AnnaNavarre | 0: TrainingFinal; 1: NYC_UNATCOHQ; 2: NYC_BatteryPark; 3: NYC_747, NYC_UNATCOHQ; 4: NYC_BatteryPark; 5: NYC_UNATCOHQ, NYC_UNATCOMJ12lab; 98: Intro | M11 checks DL_guntherprowling, M3 requires MeetLebedev3, M3 requires MeetLebedev2Trigger, M3 checks MeetLebedev2, M3 requires LebedevAnnaDead, M3 checks M03MeetGunther, M4 checks M04TroopBarks (+14 more) |
| BobPage | BobPage | 0: TrainingFinal; 6: HongKong_MJ12lab; 12: Vandenberg_Computer; 14: OceanLab_UC; 98: Intro | - |
| BobPage2 | BobPage | 0: TrainingFinal | - |
| JaimeReyes | JaimeReyes | 0: Training, TrainingFinal; 1: NYC_UNATCOHQ; 3: NYC_UNATCOHQ; 4: NYC_UNATCOHQ; 5: NYC_UNATCOHQ; 6: HongKong_TongBase; 10: Paris_Metro; 98: Intro; 99: Endgame3 | - |
| JosephManderley | JosephManderley | 0: Training; 1: NYC_UNATCOHQ; 3: NYC_UNATCOHQ; 4: NYC_UNATCOHQ; 5: NYC_UNATCOHQ; 98: Intro | M5 requires M05WaltonAlone, M5 checks M05JacobsonBarks, M5 trigger 05_NYC_UNATCOHQ/ConversationTrigger0 (M05WaltonAlone) |
| PaulDenton | PaulDenton | 0: TrainingFinal; 1: NYC_UNATCOHQ, NYC_UNATCOIsland; 2: NYC_Street; 3: NYC_Hangar; 4: NYC_Hotel; 5: NYC_UNATCOMJ12lab; 6: HongKong_TongBase; 15: Area51_Final | M15 requires DL_Final_Paul, M15 requires M15PaulHolo, M15 requires M15GaryHolo, M4 checks M04SmugglerBarks, M4 checks M04MeetSmuggler, M4 checks GuntherShowdown, M5 checks DL_Choice (+19 more) |
| WaltonSimons | WaltonSimons | 0: Training; 3: NYC_UNATCOHQ; 4: NYC_UNATCOHQ; 5: NYC_UNATCOHQ; 6: HongKong_WanChai_Street; 14: OceanLab_Lab; 15: Area51_Bunker; 98: Intro | - |
| AlexJacobson | AlexJacobson | 1: NYC_UNATCOHQ; 4: NYC_UNATCOHQ; 5: NYC_UNATCOHQ; 6: HongKong_TongBase; 11: Paris_Everett; 98: Intro; 99: Endgame3 | - |
| CorporalCollins | UNATCOTroop | 1: NYC_UNATCOIsland | - |
| custodytroop | UNATCOTroop | 1: NYC_UNATCOIsland | M1 checks MeetManderley, M1 checks M02Briefing, M1 checks MeetJanice |
| GuntherHermann | GuntherHermann | 1: NYC_UNATCOHQ, NYC_UNATCOIsland; 2: NYC_Warehouse; 3: NYC_Airfield; 4: NYC_BatteryPark; 10: Paris_Metro; 11: Paris_Cathedral; 98: Intro | M11 requires DL_guntherroof, M11 requires DL_guntherprowling, M11 requires DL_gunthernearcomp, M11 requires DL_guntherbalcony, M11 requires M11WaltonHolo |
| JaniceReed | Secretary | 1: NYC_UNATCOHQ; 3: NYC_UNATCOHQ | - |
| PrivateLloyd | UNATCOTroop | 1: NYC_UNATCOIsland; 3: NYC_UNATCOIsland; 5: NYC_UNATCOIsland | - |
| SamCarter | SamCarter | 1: NYC_UNATCOHQ; 3: NYC_UNATCOHQ; 4: NYC_UNATCOHQ; 5: NYC_UNATCOHQ; 12: Vandenberg_Computer; 98: Intro; 99: Endgame3 | M12 checks SavageBarks |
| Shannon | Female2 | 1: NYC_UNATCOHQ; 3: NYC_UNATCOHQ | - |
| TerroristCommander | TerroristCommander | 1: NYC_UNATCOIsland | M1 requires DL_LeaderNotKilled, M1 checks MeetCarter, M1 checks postmissiontroopsssecure, M1 checks PaulCongratulations, M1 checks MeetManderley, M1 checks ManderleyBarks, M1 checks M02Briefing (+7 more) |
| AlleyBum | BumMale | 2: NYC_Street | M2 requires BystanderWaiting, M2 requires BystanderPlea, M2 requires BystanderFinalBarks, M2 requires BumDead |
| FemaleHostage | Female1 | 2: NYC_Hotel | M2 checks UNATCOHotelMeet2, M2 checks HotelTroopsFinalBarks |
| FordSchick | FordSchick | 2: NYC_Underground; 4: NYC_Smug; 8: NYC_Smug | M2 checks SmugglerThanks, M2 checks MeetSmuggler, M3 checks SmugglerThanks, M3 checks MeetSmuggler, M4 checks M04MeetSmuggler, M2 script Mission02.PreTravel:120, M2 script Mission02.Timer:436 |
| GilbertRenton | GilbertRenton | 2: NYC_Hotel; 4: NYC_Hotel | M2 checks UNATCOHotelMeet2, M2 checks SandraInBar, M2 checks MeetSandraRenton, M4 requires SandraWaitingForJoJoBarks, M4 requires SandraFightingWithGilbertBarks (+18 more) |
| GilbertTerrorist | Terrorist | 2: NYC_Hotel | M2 requires RentonWaiting, M2 requires RentonRescued, M2 requires MeetRenton |
| Jock | Jock | 2: NYC_Bar | - |
| JoeGreene | JoeGreene | 2: NYC_Bar; 4: NYC_Bar; 8: NYC_FreeClinic | M8 checks M08MeetHarleyFilben, M8 requires M08FlibenBarks, M8 checks M08FlibenBarks, M8 requires FilbenCongrats, M8 script Mission08.Timer:77 |
| JordanShea | JordanShea | 2: NYC_Bar; 4: NYC_Bar; 8: NYC_Bar | M4 checks M04MeetJoeGreen, M8 checks M08MeetSandra, M8 checks SailorBarks, M4 trigger 04_NYC_Bar/FlagTrigger9, M4 trigger 04_NYC_Bar/FlagTrigger10 |
| MaleHostage | Male3 | 2: NYC_Hotel | M2 checks UNATCOHotelMeet2, M2 checks HotelTroopsFinalBarks |
| Pimp | ThugMale | 2: NYC_Street | M2 checks MeetSandraRenton, M2 checks JaneyThankful, M2 checks RentonRescued, M4 checks SandraStayingBarks |
| Sally | Hooker1 | 2: NYC_Street; 4: NYC_Street | - |
| SandraRenton | SandraRenton | 2: NYC_Bar, NYC_Street; 4: NYC_Hotel; 8: NYC_Bar; 12: Vandenberg_Gas | M12 checks MeetBum_M, M12 checks BumsOverheard2, M12 checks BumsOverheard, M2 requires PimpOverheard, M2 requires PimpKilledSandra, M2 requires PimpBark, M2 requires MeetPimp, M2 checks JaneyThankful (+25 more) |
| SubHostageFemale | BumFemale | 2: NYC_BatteryPark, NYC_Street | M2 requires DL_SubwayComplete2, M2 checks DL_SubwayComplete, M2 checks PaulBarricade, M2 checks AnnaThanks, M2 checks AnnaFinalBarks, M3 checks ManderleyDebriefing02, M2 script Mission02.Timer:202 |
| SubHostageMale | BumMale | 2: NYC_BatteryPark, NYC_Street | M2 requires DL_SubwayComplete2, M2 checks DL_SubwayComplete, M2 checks SubHostageFemaleInCar, M2 checks PaulBarricade, M2 checks AnnaThanks, M2 checks AnnaFinalBarks, M3 checks ManderleyDebriefing02 (+1 more) |
| Terrorist | Terrorist | 2: NYC_Street | - |
| Billy | ChildMale | 3: NYC_BatteryPark | - |
| DrugDealer | ThugMale3 | 3: NYC_BrooklynBridgeStation | M3 checks MeetLenny, M3 checks M03MeetJugHead, M3 requires M03JugHeadBarks3, M3 requires M03JugHeadBarks2, M3 requires M03JugHeadBarks, M3 requires JugheadThanks |
| GangMemberFemale2 | Hooker1 | 3: NYC_BrooklynBridgeStation | - |
| JuanLebedev | JuanLebedev | 3: NYC_747 | M3 requires OverhearLebedev, M3 checks HaroldConvos, M3 requires AnnaWaiting, M4 checks M04MeetJaime2, M3 script Mission03.FirstFrame:29, M3 script Mission03.FirstFrame:46 (+6 more) |
| MoleFemale | BumFemale | 3: NYC_MolePeople | M3 checks M03MolePersonBarks |
| Molekid | ChildMale | 3: NYC_MolePeople | M3 checks M03MoleFemaleBarks |
| NiceTerrorist | Terrorist | 3: NYC_Hangar | M3 requires M03PaulWaiting2, M3 requires M03PaulWaiting, M3 requires M03PaulPissed, M3 requires M03MeetPaul22, M3 requires M03MeetPaul2, M3 checks M03MeetPaul |
| Prisoner1 | Terrorist | 3: NYC_UNATCOHQ | M3 requires SimonsPissed, M3 requires SimonsInterrogating3, M3 requires SimonsInterrogating2, M3 requires SimonsInterrogating, M3 requires SimonsFrobbed2, M3 requires SimonsExecuted (+1 more) |
| Prisoner2 | Terrorist | 3: NYC_UNATCOHQ | M3 requires SimonsPissed2, M3 requires SimonsInterrogating3, M3 requires SimonsInterrogating2, M3 requires SimonsInterrogating, M3 requires SimonsFrobbed2, M3 requires SimonsBarks |
| TerroristLeader | Terrorist | 3: NYC_MolePeople | M3 checks MeetKevinBradley, M3 checks KevinBradleyBarks, M3 checks JimmyHint |
| HarleyFilben | HarleyFilben | 4: NYC_Bar | M8 script Mission08.Timer:175 |
| JoJoFine | JoJoFine | 4: NYC_Hotel | M4 requires SandraWaitingForJoJoBarks, M4 requires SandraFightingWithGilbertBarks, M4 requires SandraFightingLostGilbertBarks, M4 requires SandraFightingAloneBarks (+20 more) |
| Doctor | Doctor | 5: NYC_UNATCOMJ12lab | - |
| Miguel | Terrorist | 5: NYC_UNATCOHQ, NYC_UNATCOIsland, NYC_UNATCOMJ12lab | M5 checks M05MeetJock |
| BarManLawrence | LowerClassMale | 6: HongKong_WanChai_Underworld | M6 checks BarWomanLingBarks |
| Date1 | SarahMead | 6: HongKong_WanChai_Underworld | M6 requires MamasanConvos, M6 requires MamasanBarks, M6 requires MamasanAfterAmbush2, M6 requires MamasanAfterAmbush |
| DrinkingMan | Businessman1 | 6: HongKong_WanChai_Underworld | M6 checks DrinkingWomanBarks |
| GordonQuick | GordonQuick | 6: HongKong_WanChai_Market, HongKong_WanChai_Underworld | - |
| Labrat_Bum | BumMale3 | 6: HongKong_MJ12lab | M6 checks MJ12Lab_DoctorBarks |
| MaggieChow | MaggieChow | 6: HongKong_MJ12lab, HongKong_Storage, HongKong_WanChai_Street; 98: Intro; no level info: Endgame4 | M6 requires MeetMaySung, M6 requires MaySungStranger2, M6 requires MaySungStranger, M6 checks MarketNewsWomanConvos2, M6 trigger 06_HongKong_MJ12lab/FlagTrigger4 |
| MarketKid | ChildMale2 | 6: HongKong_WanChai_Market; 99: Endgame3 | M6 requires QuickLouisDead |
| MaxChen | MaxChen | 6: HongKong_WanChai_Market, HongKong_WanChai_Underworld | - |
| MJ12Commando | MJ12Commando | 6: HongKong_WanChai_Underworld; 10: Paris_Catacombs | - |
| Street_Man | SarahMead | 6: HongKong_VersaLife, HongKong_WanChai_Canal, HongKong_WanChai_Street | - |
| Supervisor01 | Businessman3 | 6: HongKong_VersaLife | M6 checks Disgruntled_Guy_Convos, M6 script Mission06.FirstFrame:39 |
| Table_Dancer | Hooker2 | 6: HongKong_WanChai_Underworld | - |
| TracerTong | TracerTong | 6: HongKong_TongBase; 12: Vandenberg_Cmd; 15: Area51_Entrance, Area51_Final; 99: Endgame3 | - |
| Sailor | NathanMadison | 8: NYC_Bar | M9 checks MeetFrontGuard, M9 checks FrontGuardBarks, M9 checks DoorGuardBarks, M9 requires CafWorker1Help, M9 requires CafWorker1Barks2 |
| StantonDowd | StantonDowd | 8: NYC_Street; 9: NYC_Graveyard | - |
| Gatekeeper | Janitor | 9: NYC_Graveyard | M9 checks M09MeetStantonDowd |
| SimonsButton | WaltonSimons | 9: NYC_Ship | - |
| Antoine | MichaelHamner | 10: Paris_Club | - |
| Chad | Chad | 10: Paris_Catacombs_Tunnels; 98: Intro | - |
| Charlotte | MargaretWilliams | 10: Paris_Club | - |
| Guy | ThugMale3 | 10: Paris_Metro | M10 checks HotelBartenderConvos |
| hostage | JunkieMale | 10: Paris_Catacombs_Tunnels | M10 checks ChadThankful |
| hostage_female | LowerClassFemale | 10: Paris_Catacombs_Tunnels | M10 requires Silhouette_FemaleChildSobbing, M10 checks Silhouette_FemaleChildFinalBarks, M10 checks ChadThankful |
| Louis | JoJoFine | 10: Paris_Club | - |
| MJ12Troop | MJ12Troop | 10: Paris_Catacombs | - |
| NicoletteDuClare | NicoletteDuClare | 10: Paris_Chateau, Paris_Club, Paris_Metro; no level info: Endgame4 | - |
| Renault | Businessman2 | 10: Paris_Metro | M10 checks MeetLeone, M10 checks HotelBartenderConvos |
| M11WaltonButton | WaltonSimons | 11: Paris_Cathedral | - |
| MorganEverett | MorganEverett | 11: Paris_Everett; 15: Area51_Entrance; 99: Endgame3 | - |
| Ray | Mechanic | 11: Paris_Everett | M11 requires DL_morganraythanks, M11 checks TalkAboutAI, M11 checks MeetEverett2, M11 checks MeetEverett, M11 checks TakeOff, M12 checks TongSick, M14 checks JockArea51, M15 checks M15MeetEverett (+3 more) |
| TobyAtanwe | TobyAtanwe | 11: Paris_Everett, Paris_Underground | - |
| GarySavage | GarySavage | 12: Vandenberg_Computer; 14: Vandenberg_Sub; 15: Area51_Final | - |
| TiffanySavage | TiffanySavage | 12: Vandenberg_Gas | M12 requires DL_TiffanyDead, M12 requires M12JockFinal2, M12 checks M12JockFinal2, M12 requires M12JockFinal, M12 requires M12JockBarks2, M14 checks GaryWaitingForSchematics, M14 checks GaryBarks (+3 more) |
| HowardStrong | HowardStrong | 14: Oceanlab_Silo | M14 checks MeetDrBernard, M14 requires BernardSecondMeeting, M14 requires BernardBarks3, M14 requires BernardBarks2 |
| tankkarkian | KarkianBaby | 14: Vandenberg_Sub | - |
| Gray | Gray | 15: Area51_Final | - |
| PhilipMead | PhilipMead | 98: Intro | - |
| RachelMead | RachelMead | 98: Intro; no level info: Endgame4 | - |
| MargaretWilliams | MargaretWilliams | no level info: Endgame4 | - |
| SarahMead | SarahMead | no level info: Endgame4 | - |

The consequences a Stage 6 row can check: a pawn killed in an earlier mission is missing at its later placements (from the table: Manderley is placed in HQ maps of missions 0, 1, 3, 4 and 5; Carter in 1, 3, 4, 5 and 12; Jaime in 0, 1, 3 to 6 and 10; Gunther in 1 to 4, 10 and 11; Sandra Renton in 2, 4, 8 and 12; Joe Green in 2, 4 and 8; Tracer Tong in 6, 12 and 15; Gary Savage in 12, 14 and 15);
a script that reads the flag acts on it (`Mission08.uc:77` and `:175`, `Mission06.uc:39`, `Mission05.uc:29`, `Mission03.uc:29` to `:321`, `Mission15.uc:284`: Gary instead of Paul in the Final); a conversation that needs the pawn alive does not start.

### Items handed over in conversations

The item-level choices are the `give`/`take` entries of the conversation tables: Paul's weapon (rifle, GEP gun or minicrossbow, mission 1), Carter's and Kaplan's ammo and mods (missions 1, 4), the shop stocks (Kaplan, the Mole, the smuggler in missions 2 to 8, the clinic doctor, the Hong Kong merchants, the Paris technician), Gunther's weapon (taken from the player in mission 1), Renton's gun (taken in mission 4),
the keys Filben and Alex Jacobson give, and `MunitionsTrooperTake`'s confiscation (Training). They persist in the inventory and are read through `CheckObject` events (`has?`) in the same conversation.

## The real save slots

41 slots, 39 of one 2002-03 playthrough (nicouzouf, retail 1.112: Liberty Island to Area 51 Page, about 20 hours, 1,215 minutes at the last slot) and 2 GOTY 1.112fm slots with modded weapons (retromaggedon). `SaveInfo.dxs` and the saved `FlagBase` of the slot's level were read; the saved level files hold the whole object graph. Slots per mission:
**1: 2, 2: 2, 3: 4, 4: 2, 5: 3, 6: 5, 8: 1, 9: 5, 10: 3, 12: 3, 14: 5, 15: 6; none in Training, 11, the intro or the endgames.** "Open goals" counts the goals not completed; the full list of each slot's flags is in `.work/campaign-inventory/slots.json`.

| Slot | Mission | Map | Saved as | Saves | Play time | Level files in the slot | Flags in the file | Open goals |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| N0001 | 1 | `01_NYC_UNATCOIsland` | NYC - Liberty Island | 17 | 22 min | 2 | 24 | 2 |
| N0002 | 1 | `01_NYC_UNATCOIsland` | NYC - Liberty Island | 42 | 54 min | 2 | 34 | 1 |
| N0003 | 2 | `02_NYC_BatteryPark` | NYC - Battery Park | 52 | 98 min | 2 | 24 | 1 |
| N0004 | 2 | `02_NYC_Street` | NYC - Hell's Kitchen | 91 | 163 min | 4 | 92 | 2 |
| N0005 | 3 | `03_NYC_BatteryPark` | NYC - Battery Park | 112 | 223 min | 4 | 119 | 1 |
| N0006 | 3 | `03_NYC_AirfieldHeliBase` | NYC - Helibase | 127 | 255 min | 7 | 191 | 1 |
| N0007 | 3 | `03_NYC_Airfield` | NYC - Airfield | 145 | 275 min | 8 | 195 | 2 |
| N0008 | 3 | `03_NYC_747` | NYC - 747 Airplane | 162 | 302 min | 10 | 210 | 1 |
| N0010 | 4 | `04_NYC_Hotel` | NYC - 'Ton Hotel | 170 | 327 min | 5 | 139 | 1 |
| N0011 | 4 | `04_NYC_Hotel` | NYC - 'Ton Hotel | 195 | 364 min | 6 | 168 | 1 |
| N0012 | 5 | `05_NYC_UNATCOMJ12lab` | Secret MJ12 Facility | 198 | 375 min | 2 | 114 | 0 |
| N0013 | 5 | `05_NYC_UNATCOMJ12lab` | Secret MJ12 Facility | 226 | 397 min | 2 | 121 | 2 |
| N0014 | 5 | `05_NYC_UNATCOHQ` | NYC - UNATCO HQ | 242 | 420 min | 3 | 135 | 2 |
| N0015 | 6 | `06_HongKong_Helibase` | Hong Kong - MJ12 Helibase | 259 | 447 min | 2 | 121 | 0 |
| N0016 | 6 | `06_HongKong_WanChai_Market` | Hong Kong - Market | 274 | 467 min | 3 | 137 | 2 |
| N0017 | 6 | `06_HongKong_WanChai_Underworld` | Hong Kong - Lucky Money Club | 291 | 506 min | 6 | 223 | 3 |
| N0018 | 6 | `06_HongKong_WanChai_Market` | Hong Kong - Market | 301 | 531 min | 7 | 278 | 1 |
| N0019 | 6 | `06_HongKong_WanChai_Garage` | Hong Kong - Canal Road | 322 | 576 min | 10 | 346 | 1 |
| N0020 | 8 | `08_NYC_Street` | NYC - Hell's Kitchen | 342 | 609 min | 2 | 162 | 0 |
| N0021 | 9 | `09_NYC_Dockyard` | NYC - Brooklyn Naval Shipyards | 359 | 642 min | 2 | 181 | 1 |
| N0022 | 9 | `09_NYC_Dockyard` | NYC - Brooklyn Naval Shipyards | 372 | 661 min | 2 | 187 | 3 |
| N0023 | 9 | `09_NYC_ShipFan` | NYC - Naval Assembly Building AC System | 388 | 684 min | 3 | 191 | 2 |
| N0024 | 9 | `09_NYC_Ship` | NYC - Naval Assembly Building and Ship | 400 | 698 min | 4 | 196 | 2 |
| N0025 | 10 | `10_Paris_Catacombs` | Paris - Denfert-Rochereau | 444 | 765 min | 2 | 182 | 2 |
| N0026 | 10 | `10_Paris_Catacombs_tunnels` | Paris - Catacombs | 463 | 792 min | 3 | 199 | 2 |
| N0027 | 10 | `10_Paris_Metro` | Paris - Near Champs Elysses | 486 | 823 min | 4 | 228 | 2 |
| N0028 | 12 | `12_Vandenberg_cmd` | Vandenberg - Command | 545 | 943 min | 2 | 225 | 2 |
| N0029 | 12 | `12_Vandenberg_tunnels` | Vandenberg - Tunnels | 572 | 992 min | 3 | 243 | 1 |
| N0030 | 12 | `12_vandenberg_gas` | Vandenberg - Gas | 592 | 1021 min | 5 | 277 | 1 |
| N0031 | 14 | `14_Vandenberg_sub` | New West Coast - Sub Base | 601 | 1035 min | 2 | 231 | 2 |
| N0032 | 14 | `14_OceanLab_Lab` | New West Coast - OceanLab | 618 | 1058 min | 3 | 244 | 1 |
| N0033 | 14 | `14_OceanLab_UC` | New West Coast - OceanLab UC | 650 | 1088 min | 4 | 249 | 1 |
| N0034 | 14 | `14_OceanLab_Lab` | New West Coast - OceanLab | 658 | 1102 min | 4 | 261 | 1 |
| N0035 | 14 | `14_OceanLab_silo` | New West Coast - Missile Silo | 664 | 1110 min | 5 | 272 | 1 |
| N0036 | 15 | `15_Area51_bunker` | Area 51 - Bunker | 687 | 1136 min | 2 | 236 | 0 |
| N0037 | 15 | `15_Area51_entrance` | Area51 - Entrance | 708 | 1162 min | 3 | 245 | 0 |
| N0038 | 15 | `15_Area51_final` | Area51 - Final | 730 | 1181 min | 4 | 277 | 2 |
| N0040 | 15 | `15_Area51_final` | Area51 - Final | 744 | 1199 min | 4 | 283 | 3 |
| N0042 | 15 | `15_Area51_page` | Area51 - Page | 754 | 1215 min | 5 | 294 | 4 |
| R0021 | 9 | `09_NYC_ShipFan` | NYC - Brooklyn Naval Shipyards | 165 | 877 min | 4 | 209 | 1 |
| R0035 | 15 | `15_Area51_final` | Area51 - Final | 285 | 1421 min | 4 | 305 | 3 |

What the playthrough chose, read from its slots (`Save0042`, the Page's bunker, and the earlier ones): **Filben's key given, Gunther not armed** (`GuntherRespectsPlayer` false) but freed (`GuntherFreed` is in every slot up to the metro of mission 10; it expires at 12), the Ambrosia tagged, Anna answered "TeamPlayer" (`M02MechSlur` false), Lebedev killed by Anna (`AnnaKilledLebedev` in mission 4's slots),
**Sandra went to California, Jaime and Alex recruited**, Paul alive, and Manderley, Anna, Lebedev, Gunther, Joe Green, Ray, Supervisor01, Maggie Chow, Private Lloyd, Howard Strong and Walton Simons dead; the sailor helped (`HelpSailor`), Walton met in missions 4 and 11. The two GOTY slots differ: `Save0021` (the duct of mission 9) did not recruit Jaime and has `GuntherFreed`;
`Save0035` (Area 51, Final) recruited Alex but not Jaime, knows Gunther's killphrase (`KnowsGuntherKillphrase`), and has Ray both dead and unconscious (`Ray_Dead`, `Ray_Unconscious`: the mechanic was knocked out). So the two GOTY slots are the only ones with Jaime left behind; every slot after mission 8 has `HelpSailor`; no slot has `KnowsGuntherKillphrase` but `Save0035`.

**Model check.** The 41 slots' flag stores agree with the lifetime model without exception (above). The slot file's `defaultFlagExpiration` and each flag's `expiration` are the original's own writes.

## Anomalies in the shipped data (candidate "cannot be done" rows)

These are places where the data names something that nothing provides; each is a fact of the data, and whether the original behaved the same is not known. They matter because a census that finds them unreachable is reporting the original, not a Play defect.

* **Flags read but set nowhere** (43; `scripts/inventory-campaign.mjs report` writes the list): the table below. Among them `AlwaysFalse` and `NeverTrue` are deliberate (conversations disabled by an unsatisfiable requirement), `MS_FordFollowing` blocks the exp-9 `FordSchickRescued`, `HaveROM` (Hong Kong's `John_Smith_Body`) is a typo of `Have_ROM`, `JoeGreen_Dead` (Mission 8) a typo of `JoeGreene_Dead`,
  `killpage` makes `Mission15.Timer`'s Page explosion dead code, `FoundWarehouse` blocks `DL_Warehouse` and `DL_Rooftops` (mission 2), `ShipBreech` and `suprisePoint` (mission 9), `BatteryParkComplete` (mission 2) is always false.
* **A `DataLinkTrigger` that names no InfoLink**: `05_NYC_UNATCOMJ12lab/DataLinkTrigger8` (`DL_nopaulcorpse`). **Two `ConversationTrigger`s that start nothing**: `01_NYC_UNATCOIsland/ConversationTrigger0` (`TerroristOverheard`; the conversation is `TerroristsOverheard`, which Amos' radius starts) and `ConversationTrigger1` (no `conversationTag`).
* **InfoLinks with no starter** (no `DataLinkTrigger`, no script call): 40 in all, listed in each mission's InfoLink table as "(none found)"; mission 10 has 8 (`DL_entered_maze` among them), Training 12. **Conversations that nothing can start**: `OverhearLebedev` (3) and `SendingSignal` (4) have no invoke flag, no jump, no trigger and no script call.
* **13 talk or overheard conversations whose owner `BindName` exists in no map** (`MetroJanitorConvos`, `M12MiBOverheard`, `TiffanyGuardsOverheard`, `HangarOverheard(2)`, `M03AnsweringMachineMessage`, `SendingSignal`, the club barks of Hong Kong, ...), and 38 whose owner exists only in other missions' maps.
* **Authoring slips with an effect**: Mission 00's `holobob` block (no such tag), mission 1's `FlagTrigger1` without a flag name, mission 6's `HaveROM`, mission 8's `JoeGreen_Dead`.
* **Script travels without an exit actor**: `Mission04.uc:93` (on death) and `Mission11.uc:61`.
* **Three exits that are not conversations or doors**: mission 15's switches and dispatchers, mission 14's mini-sub `FlagTrigger` chains, mission 9's helicopter `Event`.

| Flag | Read by (mission, kind, place) |
| --- | --- |
| `AlwaysFalse` | M12 requires M12SandraRentonAside, M2 requires WorkerReconciledHack, M2 requires WorkerOverheardHack, M2 requires ReconciledBarksHack, M2 requires CounselWorkerHack, M3 requires MeetLebedevAnnaHack, M3 requires MeetLebedev2 (+1 more) |
| `AnnaInOffice` | M3 script Mission03.Timer:183 |
| `BatteryParkComplete` | M2 script Mission02.FirstFrame:44 |
| `BotsReleased` | M12 checks CarlaBarks |
| `ChateauInCeller` | M10 requires NicoletteInCellar |
| `DL_ShipView` | M9 datalink trigger 09_NYC_Ship/DataLinkTrigger1 (DL_VentOpening) |
| `Doctor2_Dead` | M2 requires SickBum1Interrupted, M2 requires SickBum1DefaultBarks2, M2 requires SickBum1DefaultBarks, M2 requires SickBum1Barks |
| `DoctorStillArguing_Played` | M2 requires Doctor2StillArguing2 |
| `FordRescued` | M2 trigger 02_NYC_Underground/FlagTrigger15 |
| `FoundWarehouse` | M2 requires DL_Warehouse, M2 checks DL_StreetOpened, M2 requires DL_Rooftops, M2 requires DL_Alleys, M2 checks WorkerGivesInfo, M2 checks SallyFinalBarks, M2 checks MeetSally2, M2 checks JordanSheaConvos (+3 more) |
| `HaveROM` | M6 script Mission06.FirstFrame:40 |
| `JoeGreen_Dead` | M8 script Mission08.Timer:205 |
| `Jughead_Dead` | M3 checks GangMemberFemaleBarks |
| `killpage` | M15 script Mission15.Timer:400 |
| `M03TerroristLeaderAttacked` | M3 requires TerroristLeaderBarks, M3 requires M03MeetTerroristLeader |
| `M05PaulDentonDone` | M5 script Mission05.FirstFrame:36 |
| `M05SimonsAlone_Played` | M5 script Mission05.Timer:199 |
| `M06TroopersDefeated` | M6 requires TrooperBarks |
| `M07_Briefing_Played` | M6 trigger 06_HongKong_WanChai_Underworld/FlagTrigger19 |
| `M10_mj12_attack` | M10 requires DL_crawling_troops |
| `M10FoundClub` | M10 checks HotelBartenderConvos |
| `MaggieFled` | M6 requires MeetMaggie2, M6 requires MeetMaggie, M6 requires MaggieBarks |
| `MarketShopperOverheard_Played` | M6 script Mission06.FirstFrame:175 |
| `MaySung_Dead` | M6 checks MeetMaggie, M6 checks MaggieBarks |
| `MeetThomasDieter_Played` | M8 script Mission08.Timer:189 |
| `MetroJanitorDone` | M10 requires MetroJanitorConvos |
| `MorganMechanicComment` | M11 requires DL_morganraythanks |
| `MS_FordFollowing` | M2 script Mission02.PreTravel:119 |
| `NeverTrue` | M3 requires TroopBarks2, M3 requires TroopBarks1 |
| `NicoletteFoundSecretArea` | M10 checks NicoletteChateauBarks |
| `Ops1_Dead` | M9 requires Ops1DummyOverheard |
| `Ops2_Dead` | M9 requires Ops1DummyOverheard |
| `ReactorGray1_Dead` | M15 requires PowerGuyFollowup, M15 requires PowerGuyBarksA1, M15 checks MeetPowerGuy |
| `ReactorGray2_Dead` | M15 requires PowerGuyFollowup, M15 requires PowerGuyBarksA2, M15 checks MeetPowerGuy |
| `RenaultBakeryComment` | M10 checks RenaultPays |
| `Rene_Dead` | M10 requires ODeadBarks, M10 requires OBarks |
| `RightHandMan_Dead` | M6 checks MeetMaxChen |
| `ScientistFemaleConsulting_Dead` | M5 checks ScientistsConsulting2, M5 checks ScientistsConsulting |
| `ShipBreech` | M9 script Mission09.FirstFrame:21, M9 datalink trigger 09_NYC_ShipFan/DataLinkTrigger0 (DL_BuildingEntryAir) |
| `SickBumInterrupted_Played` | M2 script Mission02.Timer:391 |
| `Spy2Hack` | M8 checks M08MeetJoeGreen |
| `suprisePoint` | M9 script Mission09.Timer:171 |
| `TankKharkian_Dead` | M14 checks MeetDrCorwell, M14 checks CorwellBarks |

## What a Stage 6 row can start from (choices, to adopt or change)

* **Per mission**: the arrival (a slot where the mission has one, else the previous mission's exit), the exit chain (the "Required" paragraph and the `chains` blocks), and each exit actor once; Training's two required InfoLinks; mission 4's two exits and mission 12/15's alternatives.
* **Per lasting choice**: a pair (set in *S*, read in *R*) from the carried table: the slot or the run sets it, the reader's observable (a conversation branch, a pawn present or absent, a door) is checked in *R*; for the deaths, kill the pawn in its mission and check the absence at its next placement.
* **Scripted travels** are three kinds a plain `MapExit` census would miss: a travel fired by a script (`Mission04.uc:93` on death, `Mission11.uc:61`), a travel with a camera path (`bPlayTransition`: 20 of the 47 `MapExit`s), and the mini-sub/elevator `MapExit` chains inside missions 6 and 14.
* **Slots as start points**: 41 listed above; no start exists for Training, mission 11, the Statue's end, HQ in mission 1, the chateau, the silo's end, the ending triggers, the intro or the endgames.

## Summary

Per mission: the numbers of the sections above. *Own* conversations exclude the 384 shared barks; *choices* is conversations with at least one choice; *need a flag* is conversations with a `flagRefList`; *required* is the count of conversations on the exit chain read in the mission's "Required" paragraph (a choice of mine; "or" marks alternatives,
"+" an item the chain also needs); *carried* is the number of the 36 carried flags that are set in the mission and alive in a later one; *important* is the number of distinct `bImportant` BindNames placed in the mission's maps; *slots* is the number of the 41 real slots in the mission.

| Mission | Maps | Own conversations | InfoLinks | Talk | Overheard | With choices | Set flags | Need a flag | Goals | Required (progression) | Carried flags set here | Important pawns | Real slots |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 Training | 3 | 86 | 70 | 7 | 9 | 0 | 1 | 4 | 0 | 2 (`DL_CombatEntry`, `DL_DefuseFinish`) | 0 | 7 | 0 |
| 1 Liberty Island, HQ | 2 | 110 | 28 | 30 | 52 | 7 | 23 | 73 | 10 | 4 + one of 3 (`MeetJaime`, `MeetCarter`, `M02Briefing`, `GotoM02`; commander: `MeetTerrorist` or `DL_LeaderKilled` or `DL_LeaderKilledInSpite`) | 7 | 13 | 2 |
| 2 Battery Park, Hell's Kitchen | 8 | 193 | 21 | 64 | 108 | 19 | 46 | 131 | 11 | 0 by helicopter, 1 by boat (`BoatLeaving`); `GeneratorBlown` either way | 13 | 18 | 2 |
| 3 Airfield | 9 | 187 | 13 | 53 | 121 | 11 | 33 | 115 | 12 | 4 (`ManderleyDebriefing02`, `JockBarks`, `DL_Airfield`, `M03JockLeave`) | 5 | 20 | 4 |
| 4 Paul, NSF HQ | 9 | 136 | 8 | 36 | 92 | 6 | 22 | 82 | 9 | 6 (`ManderleyDebriefing03`, `JockTellsAboutPaul`, `PaulInjured`, `DL_PaulGoodJob` or the NSFHQ trigger, `TalkedToPaulAfterMessage`, `GuntherShowdown` or death) | 3 | 16 | 2 |
| 5 MJ12 lab, UNATCO | 3 | 61 | 13 | 19 | 29 | 5 | 13 | 33 | 9 | 2 + Anna's death (`M05MeetAlexJacobson`, `M05MeetJock`) | 3 | 10 | 3 |
| 6 Hong Kong | 10 | 296 | 27 | 65 | 204 | 15 | 53 | 204 | 20 | 5 + the Helibase blast doors (`MeetTracerTong`, `TriadCeremony`, `M07Briefing`, `M08Briefing`, `M06JockExit`; `Versalife_Done` by InfoLink or trigger) | 0 | 18 | 5 |
| 8 Hell's Kitchen again | 6 | 50 | 9 | 15 | 26 | 6 | 11 | 21 | 8 | 3 (`M08MeetHarleyFilben` or `MeetThomasDieter`, `StantonDowd`, `M08JockExit`) | 3 | 6 | 1 |
| 9 Naval Shipyard | 5 | 58 | 27 | 6 | 25 | 1 | 4 | 23 | 11 | 2 (`M09MeetStantonDowd`, `M09JockLeave`) | 0 | 3 | 5 |
| 10 Paris | 5 | 174 | 51 | 36 | 87 | 14 | 33 | 95 | 16 | 3 (`MeetNicolette`, `NicoletteOutside`, `JockReady`) | 1 | 13 | 3 |
| 11 Cathedral, Everett | 3 | 72 | 24 | 25 | 23 | 5 | 11 | 53 | 9 | 3 (`MeetTobyAtanwe`, `MeetEverett`, `TakeOff`) + the script travel | 2 | 6 | 0 |
| 12 Vandenberg | 4 | 66 | 22 | 21 | 23 | 2 | 7 | 38 | 11 | 4 (`PageHostageBriefing`, `GaryHostageBriefing`, `TongTrigger`/`TongSick`, `M12JockFinal`/`M12JockFinal2`) | 0 | 6 | 3 |
| 14 Sub base, Ocean Lab, silo | 4 | 53 | 26 | 11 | 16 | 0 | 3 | 31 | 7 | 4 (`GaryWaitingForSchematics`, `JockBarks`, `DL_Dead`, `JockArea51`) | 0 | 5 | 5 |
| 15 Area 51 | 4 | 81 | 59 | 10 | 12 | 0 | 11 | 38 | 12 | 0 (three endings by switches and a `FlagTrigger`) | 0 | 6 | 6 |
| 98 Intro | 1 | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 1 (`Intro` must end) | 0 | 12 | 0 |
| 99 Endgames | 4 | 3 | 0 | 3 | 0 | 0 | 1 | 0 | 0 | 1 each (`EndgameN` must end, then the credits) | 0 | 11 | 0 |
| **Total** | 80 | 1627 | 398 | 402 | 827 | 91 | 272 | 941 | 145 | | 37 | | 41 |

(The "carried" column sums to 37 because `PlayerMetFilben` is set by conversations of both mission 1 and mission 3. The 98 and 99 rows count the intro and the three endgame maps; the 99 row's "maps" counts `99_Endgame4`, which has no level info. The goals column counts distinct goal names that conversations or scripts add, complete or carry; some are shared by missions. The total of "own conversations" counts a conversation once per list it lives in.)
Further totals: **83 single-player maps** (the 80 of the rows plus `DX`, `DXOnly` and `Entry`); **36 carried flags** and **85 important BindNames** (the lasting choices); **41 real slots** covering 12 of the 16 units (missions 1 to 6, 8 to 10, 12, 14, 15; not Training, 11, the intro or the endgames);
**2 mission-script travels** (`Mission04.uc:93` on death, `Mission11.uc:61`) besides the menu-driven ones (`StartNewGame`, `PostIntro`, the credits' `SendPlayer` to `dxonly`); **47 `MapExit`s** (20 with camera paths) and **297 `Teleporter`s** in the 83 maps.

## What could not be determined from the data alone (all unverified)

* **Geometry and reachability.** Whether a player can walk from an arrival to a gate, whether a "touch only" exit is reachable before its story step (`02_NYC_Warehouse` `MapExit0`, `12_Vandenberg_Cmd` `MapExit4/1`, the mission 12 tunnels' exits), whether a door on the "gates" list is on the only route, and whether an InfoLink-only opener can be bypassed by a proximity trigger in Training. The inventory lists gates and exit actors; the route between them is a census output.
* **Flags set by something outside the extracted sources.** The 43 flags read but set nowhere (table above) are set by no script, conversation event or `FlagTrigger` in the data; the script sources of every package were searched, the native DLLs were not. `MS_FordFollowing` (so mission 2's exp-9 `FordSchickRescued`), `killpage`, `FoundWarehouse`, `ShipBreech`, `suprisePoint`, `BatteryParkComplete` are the ones that change behaviour.
* **Keys handed over by conversations.** `InitialInventory` is a struct array the map decoder leaves undecoded, so which `KeyID` Filben's key (probably `ruin_key`), Alex Jacobson's key (probably `levelone`) and Paul's `NanoKey` (mission 2) carry is not read; the `NanoKey` objects placed in the maps are read (58 distinct ids).
* **Which branch of a conversation runs.** The extraction lists each event with the label of the block it sits in and follows explicit jumps for the choices tables; it does not evaluate `CheckFlag` chains (a `CheckFlag` with several flags is shown flattened), fall-through between blocks, `RandomLabel` events or `CheckPersona` events (skill and augmentation tests).
* **Timing and order.** The expiration model decides what survives a travel; the order in which a mission's `Timer`, `FirstFrame`, triggers and conversations act within a second, and `bDisplayOnce` interplay, are in the scripts but were not simulated.
* **What the dying player carries.** `Mission04.uc:93` calls `SendPlayer` while the pawn is in the `Dying` state; the travel text of such a pawn, and whether the death flow's `OPEN DXONLY` timer can pre-empt a one-second `Timer`, were not read.
* **Unused or unreachable map content.** `00_Intro`'s `MapExit1`, `12_Vandenberg_Gas` `MapExit6/7` and `14_Vandenberg_Sub` `MapExit0` have no destination; `99_Endgame4` and `Entry` are targeted by nothing; 40 InfoLinks have no starter. Whether the original left them dead on purpose is not known.
* **One playthrough.** 39 of the 41 slots are the same game; the other branch of most carried flags has no slot (the two GOTY slots are the only ones with Jaime left behind). Slots that the data shows as containing a flag may still have been reached by a different route (a flag says what happened, not how).
* **Counts.** "Own" conversations are counted per list by name; names that several lists share (the named barks `<Owner>_Bark*` of lists 0 to 4, `TroopBarks1/2`) appear in each. Two lists can hold different conversations under one name (`JockBarks` is in lists 3 and 14 with different requirements and effects); the "Required" paragraphs read each list's own.
  The saved-flag totals of a slot are those of the file; a load adds the flags the first `Timer` makes ([travel](travel.md#play-step-4-loading-a-saved-game) counts 309 for `Save0035` after its load, the file holds 305).
* **Multiplayer** (`DXMP_*`, five maps) and the Easter-egg/mod content are out of scope.

