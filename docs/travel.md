# Map travel in the original (single-player)

Research for Stage 6 ([roadmap §6](roadmap.md#6-persist-progress-and-complete-the-campaign)), 2026-10-21. This page is the source of truth for
how the original game moves the player between maps, what it carries and what it saves. Steps 0 and 1 of the
[implementation order](#proposed-implementation-order-for-play) are in Play ([what runs, what was checked, what still stops](#play-steps-0-and-1)):
the main menu's Training button on the logo map travels to `00_Training` with no items. Step 2 is too ([New Game and items](#play-step-2-new-game-and-items)):
New Game runs the real menu screens, the intro, `PostIntro` and `StartNewGame` and arrives on `01_NYC_UNATCOIsland` with the starting inventory, and the
texts, flags and log of that path and of three item scenarios equal captures of the original. Step 3 is in ([visited maps restored](#play-step-3-visited-maps-restored)):
leaving a map for another of the same mission files the level in `Save\Current` as a version-68 `.dxs` of the original's layout ([the file](#the-dxs-a-saved-levels-package)),
and coming back restores it through the warm `LoadMap`; the file's reading is checked against the original's own files and Play's own writing is an interim in the respects listed there.
Step 4 is in both halves ([saving](#play-step-4-saving), [loading](#play-step-4-loading-a-saved-game)): the slot is the original's `Save\SaveNNNN\` or `QuickSave\`, and `?loadgame=N` loads the original's own slots (the old desktop slots, a slot the original wrote under Wine, 41 real slots from the internet, 40 of which load) with the saved player and its whole object graph, from the Load Game screen, the QuickLoad key and the menu a death leads to.
Step 5's first part is in ([Play Intro, Credits, DXOnly and the endings](#play-step-5-first-part-play-intro-credits-dxonly-and-the-endings)): the menu's Play Intro and Credits, the DXOnly level and its menu, and the three endings
(`LocalTravel 99_Endgame1..3` from Area 51 through the credits and back to the menu) match eleven captures of the original.
Step 5's second part is in ([every map-to-map transition of the campaign](travel-transitions.md): the 198 `MapExit`s, `Teleporter`s and scripted `SendPlayer`s of the installed maps driven in Play, the Hong Kong lifts, the four exits without a destination, the mission `PreTravel`s and the `Map.dx #Portal` URL forms, replayed against six Wine sessions).
Every other branch stops at a named boundary ([where Play stops](#where-play-stops-today)).

**Evidence.** Every claim names its source:

* *Script source* is the retail game's own, extracted from the shipped `.u` packages into `.cache/research/src/<Package>/*.uc` (outside Git; the
  `file.uc:line` references are lines of those files). Engine, DeusEx, Extension and Core script are the shipped ones, not the SDK's.
* *Native code* is the hash-pinned GOTY DLLs in `Deus Ex GOTY Edition/System`, read with `tools/disasm-annotated.py` (a capstone listing with imports,
  exported functions and string literals named; `--brief` drops the exception-state noise, `--notes` keeps calls and branches). Addresses are the DLLs'
  own image addresses (`0x10…`); thunk exports (Engine.dll's `jmp rel32` table at `0x103011xx..0x1030xxxx`) are resolved to the body.

  | DLL | SHA-256 |
  | --- | --- |
  | Engine.dll | `0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4` |
  | DeusEx.dll | `b91002f3e7658c0562d28bccc887cf9db79a47a19f5e09e8be460c9d0c0bee04` |
  | Extension.dll | `93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c` |

  C++ names and member layouts come from the SDK headers (`Reference/DeusExSDK1112f`, [SDK reference](sdk-reference.md)): `DDeusExGameEngine`
  (`DeusExGameEngine.h`), `XGameEngineExt`, `UGameEngine` (`UnGame.h`), `ULevel.TravelInfo` (`UnLevel.h:148`), the viewport's travel fields (`UnCamera.h:229`). The retail
  `ADeusExPlayer` is 4 bytes later than the SDK's from `bStartingNewGame` on (retail `+0xaf8`, SDK `+0xaf4`); property offsets and `travel` flags below
  are read from the retail classes (`CPF_Travel` = `0x10000` in the compiled property flags).
* *Measurement* is the original under Wine on the Linux host (`scripts/travel-probe.sh`, `tools/dump-travel-win.c`; [Measurements](#measurements)).
  Captures stay under `.work/travel/` (outside Git).

Reproduce a listing with, for instance, `NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python; $NATIVE_PROBE_PYTHON tools/disasm-annotated.py --brief DeusEx.dll 10010b90-10011520` (`DDeusExGameEngine::Browse`),
`... --brief Engine.dll 10390868-10390d5a` (the tick's travel step), `... --brief Engine.dll 10391740-10391ab2` (`ExportTravel`), `... --brief Engine.dll 103971f0-10397c40` (the import), `... --list Engine.dll Browse` (exports and the thunks' bodies).
The retail property tables (offsets, `travel` flags, bit masks) come from the loaded script classes (`ScriptRuntime`, `classLoader.graph.slotOf(field.loadRecord, 0x48 | 0x3c | 0x5c)`).

Items not read or not measured are listed in [Unresolved](#unresolved) and marked **unverified** where they appear.

## The chain in one page

A map change is one *client travel*. It has two halves separated by the end of a tick:

```
script   GameInfo.SendPlayer(P, URL)                          Engine/GameInfo.uc:1479   ClientTravel(URL, TRAVEL_Relative, bItems=True)
         PlayerPawn.ClientTravel  (native event)              Engine/PlayerPawn.uc:206
native   APlayerPawn::execClientTravel 0x103df100             ProcessEvent(PreClientTravel); Engine->SetClientTravel(Player, URL, bItems, type)
native   UGameEngine::SetClientTravel 0x1038fa10              viewport.TravelURL/TravelType/bTravelItems; ProcessEvent(PreTravel) on every actor that has one
script   DeusExPlayer.PreTravel, MissionScript.PreTravel, ...  PlayerTraveling flag, skill points, datalink history, fire out, timers off
         ... the level finishes the current tick ...
native   UGameEngine::Tick 0x1038fe90, travel step 0x10390868 export the player and its travel objects as text (ExportTravel 0x10391740),
                                                              TravelInfo[PlayerName] = text; URL = FURL(LastURL, TravelURL, TravelType); Browse(URL, &TravelInfo)
native   XGameEngineExt::Browse -> UGameEngine::Browse (0 for a local map) -> DDeusExGameEngine::Browse 0x10010b90
                                                              mission numbers decide: save the level left into Save\Current, or wipe Current
native   UGameEngine::LoadMap 0x1038c1f0                      old level retired and collected; new level loaded (.dx, or a saved .dxs); ULevel.TravelInfo = TravelInfo
native   ULevel::SpawnPlayActor 0x10396bd0                    GameInfo.Login (fresh player) ; import the travel text ; AcceptInventory ; TravelPostAccept ; PostLogin
script   MissionScript.Timer (first one)                      PlayerTraveling set -> FirstFrame
```

The same chain serves every single-player entry: `SendPlayer` (MapExit, Teleporter, scripts, menus), the console `OPEN` (items off), `?restart`,
and `ClientTravel("?loadgame=N")`. What differs is the URL, `bItems` and the branch `DDeusExGameEngine::Browse` takes.

## Script chain

### Entry points

| Who | Call | `bItems` | Source |
| --- | --- | --- | --- |
| `GameInfo.SendPlayer(P, URL)` | `P.ClientTravel(URL, TRAVEL_Relative, true)` | true | `Engine/GameInfo.uc:1479..1482`; `DeusExGameInfo` does not override it |
| `MapExit.LoadMap` (touch or trigger) | `ClearWindowStack`; `bPlayTransition`: camera path then `NextMap = DestMap` (the player's `Interpolating` state calls `SendPlayer(Self, NextMap)` at `InterpolateEnd`), else `SendPlayer(Player, DestMap)` | true | `DeusEx/MapExit.uc:19..46`, `DeusEx/DeusExPlayer.uc:4142..4156` |
| `Teleporter.Touch` with `/` or `#` in `URL` | `Level.Game.SendPlayer(PlayerPawn(Other), URL)`; `Map#Portal` | true | `Engine/Teleporter.uc:213..217`; all 149 URLs in the installed maps contain `#` ([destinations](#destinations-in-the-installed-maps)) |
| `DeusExPlayer.StartTrainingMission` | `SkillSystem.ResetSkills; ResetPlayer(True); DeleteSaveGameFiles(); bStartingNewGame = True; SendPlayer(Self, "00_Training")` | true | `DeusEx/DeusExPlayer.uc:997..1015` |
| `DeusExPlayer.ShowIntro(bStartNewGame)` | `bStartNewGameAfterIntro = bStartNewGame; SendPlayer(Self, "00_Intro")` | true | `DeusExPlayer.uc:1021..1034` (`AugmentationSystem.DeactivateAll` first) |
| `DeusExPlayer.PostIntro` | `bStartNewGameAfterIntro` ? `StartNewGame(strStartMap)` : `SendPlayer(Self, "dxonly")` | true | `DeusExPlayer.uc:6969..6980`; called by `MissionIntro.Timer` once `Intro_Played` is set, and by `ShowMainMenu` on the intro map (`MissionNumber == 98`) |
| `DeusExPlayer.StartNewGame(startMap)` | `ClearWindowStack`; `PlayerTraveling`; `SaveSkillPoints; ResetPlayer(); DeleteSaveGameFiles(); bStartingNewGame = True; SendPlayer(Self, startMap)` (`""` -> `01_NYC_UNATCOIsland`) | true | `DeusExPlayer.uc:971..992` |
| `DeusExPlayer.LoadGame(N)` | `DesiredFOV = Default.DesiredFOV; ClearWindowStack; ClientTravel("?loadgame=" $ N, TRAVEL_Absolute, False)`; QuickLoad = `LoadGame(-1)` | false | `DeusExPlayer.uc:876..883`, `:932..937` |
| `MenuScreenLoadGame.LoadGame(row)` | `player.LoadGame(DirectoryIndex of the row)` | | `DeusEx/MenuScreenLoadGame.uc:514..524` |
| `LoadMapWindow` (cheat UI) | `ClientTravel(file, TRAVEL_Relative, True)` or `ConsoleCommand("Open <file>?loadonly")` | | `DeusEx/LoadMapWindow.uc:172..190` |
| The dead player's camera | after 20 s `ConsoleCommand("OPEN DXONLY")` (when no menu is on top) | false (console `OPEN`) | `DeusExPlayer.uc:4047`; [death](stage-5-exit-criteria.md#the-players-death-to-the-levels-end-2026-10-18) |
| `Mission04`, `Mission11`, credits and quotes windows | `SendPlayer(Player, "05_NYC_UNATCOMJ12Lab" \| "11_PARIS_EVERETT" \| "dxonly")` | true | `Mission04.uc:93`, `Mission11.uc:61`, `CreditsWindow.uc:128`, `QuotesWindow.uc:98`, `DemoSplashWindow.uc:25,38` |
| `exec RestartLevel`, `LocalTravel URL` | `ClientTravel("?restart", TRAVEL_Relative, false)`, `ClientTravel(URL, TRAVEL_Relative, true)` | | `Engine/PlayerPawn.uc:1372..1383` |

`ETravelType` is `TRAVEL_Absolute` 0, `TRAVEL_Partial` 1, `TRAVEL_Relative` 2 (`Engine/Actor.uc:502..507`). `ServerTravel`/`ProcessServerTravel` return at once in
`NM_Standalone` (`Engine/LevelInfo.uc:156..158`) and are not part of single-player travel.

### PreTravel: what runs before the level is left

`SetClientTravel` calls `PreTravel` on every actor that has the function, in `Level.Actors` order, at the moment `ClientTravel` is called (the level has not ended yet).

* `DeusExPlayer.PreTravel` (`DeusExPlayer.uc:577..592`): `flagBase.SetBool('PlayerTraveling', True, True, 0)` (expiration 0: never expires);
  `SaveSkillPoints()`; `dataLinkPlay.AbortAndSaveHistory()` if a datalink plays; `ExtinguishFire()`.
  `SaveSkillPoints` (`:2045..2062`) stores `SkillPointsAvail`/`SkillPointsTotal` as the Int flags `SKTemp_SkillPointsAvail`/`SKTemp_SkillPointsTotal` once
  (`bSavingSkillsAugs` guards it until `RestoreSkillPoints` in `TravelPostAccept` clears it).
* `MissionScript.PreTravel` (`MissionScript.uc:137..145`): `SetTimer(0, False)`; `flags = None` ("so `FirstFrame()` gets executed at load"). The subclasses add: `Mission02`
  sets `MS_MapLeftEarly` leaving Battery Park early and `FordSchickRescued` leaving the underground with Ford; `Mission08` destroys the `EntranceCopter` of `08_NYC_STREET`;
  `Mission10` sets `NicoletteLeftClub`; `MissionIntro`/`MissionEndgame` restore the sound volume; the others only call `Super`.
* `AugLight.PreTravel` (`AugLight.uc:8..16`) destroys its two beams.

No other class defines `PreTravel` (grep over all packages).

### PlayerTraveling

| Event | Where | Effect |
| --- | --- | --- |
| set | `DeusExPlayer.PreTravel` at every `SetClientTravel` (`OPEN` too) | in the *old* player's `flagBase`; it travels only if `bItems` |
| set | `DeusExPlayer.StartNewGame` (`DeusExPlayer.uc:978`) | wiped at once: `ResetPlayer -> ResetPlayerToDefaults -> DeusExRootWindow.ResetFlags` removes every flag but `SKTemp_*` (`DeusExRootWindow.uc:971..1010`); the `PreTravel` of the `SendPlayer` sets it again |
| set | `MissionIntro.InitStateMachine` / `MissionEndgame.InitStateMachine` (`MissionIntro.uc:14..23`, `MissionEndgame.uc:19..28`) | `DeleteAllFlags`, then `PlayerTraveling` again: "always want it set for the intro and endgames" |
| read | `MissionScript.InitStateMachine` (`MissionScript.uc:62`) | `flags.DeleteExpiredFlags(MissionNumber)` only when set ("don't delete expired flags if we just loaded a savegame") |
| read | `MissionScript.Timer` (`MissionScript.uc:160`) | `FirstFrame()` only when set: a map entered without it (a direct `open`, a loaded savegame) skips `FirstFrame` |
| deleted | `MissionScript.FirstFrame` (`MissionScript.uc:94`) | `flags.DeleteFlag('PlayerTraveling', FLAG_Bool)` |

`FirstFrame` is the first `Timer` of the new `MissionScript` (it is spawned by `DeusExLevelInfo.PostBeginPlay`, `DeusExLevelInfo.uc:44..47`, or by `DeusExPlayer.TravelPostAccept` if none exists,
`DeusExPlayer.uc:699..710`). So the flag is *set in one level and consumed in the next*, and what travels is what the player's `flagBase` holds, nothing else.
`FirstFrame` also (`MissionScript.uc:88..131`): destroys dead important NPCs (`<BindName>_Dead`), prints the startup text once per map (`M<MAP>_StartupText`), and on the first map of a mission
(`M<n>MissionStart` unset) resets goals and conversation history.

The flag store: `FlagBase` is a script object whose state is `travel` properties (`Extension/FlagBase.uc:12..13`: `hashTable[64]` and `defaultFlagExpiration`; each `Flag` has
`flagName, flagHash, flagBase, nextFlag, flagType, expiration` and its value, all `travel`: `Extension/Flag*.uc`). So it crosses maps as part of the player's travel text like any other object (below).
`DeleteExpiredFlags(criteria)` removes every flag whose expiration is non-zero and `<= criteria` (`script-triggers.mjs`, `XFlagBase::DeleteExpiredFlags 0x10024ac0`), and
`MissionScript.InitStateMachine` sets the default expiration to `MissionNumber + 1`: a flag made in mission *n* dies when the player enters mission *n+1* by travel.

### What `travel` means

A property declared `travel` has `CPF_Travel` (`0x10000`). `bTravel` (`Actor.uc:81`) is the actor-level switch; its class default is true for `Inventory` (and so weapons, ammo, pickups, `NanoKeyRing`),
`DeusExPlayer`, `DeusExDecoration` (so `Containers`, `Keypad`, ...) and the `Augmentation`/`Skill` managers and entries, false for `Actor`, `Pawn`, `ScriptedPawn`, `Decoration`, `DeusExCarcass`
(read from the retail class defaults). The exporter skips an actor whose `bTravel` is false; objects that are not actors (`FlagBase` and the `Flag*` objects, `ColorThemeManager` and its themes in the measured text) are always exported.

`DeusExPlayer` (and so `JCDentonMale`) has 52 travel properties, in memory order: `Inventory` (`+0xc0`), `LastConEndTime`, `Weapon`, `SelectedItem`, `Health` and the six `Health*` regions,
`carriedDecoration`, `DodgeClickTimer`, `MyAutoAim`, `Handedness`, `FlagBase` (`+0x890`), `TruePlayerName`, `PlayerSkin`, `CombatDifficulty`, `AugmentationSystem` (`+0x9b0`), `SkillSystem` (`+0x9b4`), `SkillPointsTotal`,
`SkillPointsAvail`, `Credits`, `Energy`, `EnergyMax`, `EnergyDrain`, `EnergyDrainTotal`, `KeyRing`, `KeyList`, `ConHistory`, `invSlots[30]`, `inHand`, `inHandPending`, `ClientinHandPending`, `LastinHand`,
`bInHandTransition`, `FirstGoal`, `LastGoal`, `FirstNote`, `LastNote`, `FirstImage`, `bForceDuck`, `bCrouchOn`, `bWasCrouchOn`, `lastbDuck`, `bStartNewGameAfterIntro`, `bIgnoreNextShowMenu`, `BarkManager`, `ThemeManager`,
`saveCount`, `saveTime`. The classes reached through object properties add their own: an `Inventory` item has 9 (`AutoSwitchPriority, bActive, Charge, invPosX, invPosY, bInObjectBelt, beltPos, ...`), a weapon 29 (`ClipCount`, `ModBase*`, ...),
`Ammo` 12, `AugmentationManager` 4, `SkillManager` 3, `Skill` 4, `Augmentation` 8, `DeusExDecoration` 3. Properties that are *not* `travel` do not cross (for instance `bStartingNewGame`, `bSavingSkillsAugs`,
`NextMap`, `strStartMap`, everything on the level's own actors).

### Login and the callbacks of the arrival

In the new level `DeusExGameInfo.Login` (`DeusEx/DeusExGameInfo.uc:11..70`) runs `Super.Login` (a *new* `JCDentonMale` at the start spot; `GameInfo.Login` reuses an unoccupied saved player when one exists, `Engine/GameInfo.uc:801..`) and,
unless the options contain `Loadgame`, `player.ResetPlayerToDefaults()` (fresh subsystems), then the dump-location branch (`UDumpLocation`, a developer file; **unverified** that it is never present in retail play) or
`FindPlayerStart(None, InTeam, Portal)`: the first `Teleporter` whose `Tag` equals the URL's portal (`Map#Portal`), else the first enabled `bSinglePlayerStart` `PlayerStart` (`GameInfo.uc` `FindPlayerStart`).
The travel text is imported afterwards by `SpawnPlayActor` (native, below); the script callbacks it fires:

| Order | Callback | Source |
| --- | --- | --- |
| 1 | `player.TravelPreAccept()` (empty) | native `0x103971f4` |
| 2 | travel objects (not the player): `TravelPreAccept()`, last imported first; `Inventory.TravelPreAccept` = `GiveTo(Pawn(Owner))`, then `Activate()` if `bActive` | `Engine/Inventory.uc:230..236` |
| 3 | `Game.AcceptInventory(player)` (`GameInfo.AddDefaultInventory`: `JumpZ`, the mutator's default weapon) | `Engine/GameInfo.uc:1025..1033` |
| 4 | travel objects: `TravelPostAccept()`, last first: `DeusExWeapon` repairs `AmmoName`/`ProjectileClass`; `Pickup` calls `PickupFunction`; `DeusExDecoration` empty | `DeusExWeapon.uc:267..296`, `Engine/Pickup.uc:21..25` |
| 5 | `player.TravelPostAccept()`: `Super` (`Health <= 0` -> `Default.Health`), `ResetKeyboard`, logo/`DXOnly` hacks (`MissionNumber` -2: `IntroCam` interpolation, -1: `Paralyzed`), themes, `RefreshChargedPickups`, `RestoreSkillPoints`, `SkillSystem/AugmentationSystem.SetPlayer`, `conPlay.TerminateConversation`, `UpdatePlayerSkin`, carried decoration, `SetFOVAngle`, `RestoreScopeView`, `info.SpawnScript()` if no `MissionScript`, `BaseEyeHeight`; `JCDentonMale` then sets the face texture | `DeusExPlayer.uc:599..714`, `JCDentonMale.uc:10..24` |
| 6 | `Game.PostLogin(player)` | native `0x10397c34` |

The same order is recovered for the cold login in [Original standalone player login](script-player-login.md); that page covers the case with no travel text.

## Native chain

### `ClientTravel` -> `SetClientTravel`

`APlayerPawn::execClientTravel` (`0x103df100`, export thunk `0x10301ec4`) reads `URL`, `TravelType`, `bItems`; when `Player` (`+0x5d4`) is set it fires `PreClientTravel`
(`Engine/PlayerPawn.uc:224`, empty) and calls `XLevel->Engine->SetClientTravel(Player, URL, bItems, TravelType)` (vtable `+0x88`, `0x103df1f5`; an empty URL is passed as the empty string).

`UGameEngine::SetClientTravel` (`0x1038fa10`):

1. `Viewport = CastChecked<UViewport>(Player)` (assert at `UnGame.cpp:0x5fd`).
2. `Viewport->TravelURL (+0xa0) = NextURL; Viewport->TravelType (+0x9c) = TravelType; Viewport->bTravelItems (+0xac) = bItems` (`0x1038fb31..0x1038fb3d`).
3. For `i` in `0 .. GLevel->Actors.Num()-1` (`GLevel` = engine `+0x68`, `Actors` TArray `+0x2c`/`+0x30`): a non-null actor whose class has a function named `PreTravel` (`FName("PreTravel", FNAME_Find)`, `FindFunction`) gets
   `ProcessEvent(function, NULL)` (`0x1038fb43..0x1038fb99`).

Nothing else happens there: the level keeps running. Calling `ClientTravel` twice before the tick ends overwrites the URL (and runs `PreTravel` again).
The console `OPEN` is the same function with `bItems = 0`, `TRAVEL_Partial` (`UGameEngine::Exec` `0x1038a030`, [recovered earlier](stage-5-exit-criteria.md#the-players-death-to-the-levels-end-2026-10-18)).

### The engine tick's travel step

`UGameEngine::Tick` (`0x1038fe90`) ticks the levels, then (`0x10390868..0x10390d5a`) tests `Client->Viewports(0)->TravelURL` (`0x1039088e`, case-insensitive compare with `""`, `0x103908ac`); if it is not empty:

1. A local `TMap<FString,FString> TravelInfo` (hash size 8; `0x103908ce..0x103908e8`).
2. If `TravelURL ~= "?RESTART"` (`0x10390908`): `TravelInfo = GLevel->TravelInfo` (the map the current level was loaded with, `ULevel+0xe4`).
   Else if `bTravelItems`: `Logf("Export travel for: %s", Viewport->Actor->PlayerReplicationInfo->PlayerName)`; `ExportTravel(textDevice, Viewport->Actor)` (`0x10391740`);
   `TravelInfo.Set(PlayerName, text)` (key compare is `appStricmp`; `0x10390a11..0x10390a44`). `bItems = 0` leaves `TravelInfo` empty.
3. Every option of `LastURL` (engine `+0x74`) equal to `loadonly` (`appStricmp`) is removed, last to first (`0x10390a8a..0x10390b34`); `LastURL.Portal` is cleared (`0x10390b3c..0x10390bad`).
4. `URL = FURL(&LastURL, TravelURL, TravelType)` (`0x10390bd8`) and `Browse(URL, &TravelInfo, Error)` (`Error` a local FString; vtable `+0xa8`, `0x10390c01`). **The result is not tested**: a failed Browse is not retried here.
5. `Viewport->TravelURL = ""` (`0x10390c07..0x10390c63`), the locals are freed, and the tick goes on to the client (render) as before.

So a travel requested during tick *N* ends the level after tick *N + 1* has run with the `PreTravel` changes, and `Browse` runs before that frame is drawn.

`FURL(&Base, Text, Type)` (`0x103f7b60`) is the stock Unreal 1 parser: `TRAVEL_Relative` copies the base's protocol, host, port, map and portal and keeps no options; `TRAVEL_Partial` copies protocol, host, port and the base's options except
`PUSH`, `POP`, `PEER`, `LOAD`; `TRAVEL_Absolute` copies nothing; the text then supplies the map (a `.dx` suffix is accepted), `#portal` and `?options`. `FURL::IsLocalInternal`/`IsInternal` (`0x103f9890`, `0x103f97b0`) classify the result.
The installed maps use `Map`, `Map#Portal`, `Map.dx`, `Map.dx#Portal` and, in three `MapExit`s, a space before the `#` ([destinations](#destinations-in-the-installed-maps)); measured: the `.dx` is kept in the level's `URL.Map`, the space too (a trailing space in `Map`), and both load ([URL forms](#load-game-restart-and-url-forms)).

### ExportTravel: the travel text

`ExportTravel(FOutputDevice& Out, AActor* RootObject)` (`0x10391740`, `UnGame.cpp` assert line `0x581`) keeps a worklist of objects starting with the root (the player). For each object, in worklist order:

* an `AActor` is skipped unless its `bTravel` bit (`+0x28`, mask `0x40000`) is set; an object that is not an actor is exported;
* it writes `Class=<class path name> Name=<object name> Ptr=<address, %08x>` then `{`;
* for every property of the class chain (most-derived class first, then each superclass; declaration order inside a class) with `CPF_Travel`, for each array element: `Property->ExportText(index, buffer, object, class defaults, 0)`
  (vtable `+0x88`); an element that returns nothing is skipped. ExportText is given the class defaults, so **a property whose value equals its class default is not written** (a fresh player's block has no `Health`, `Credits`
  or skill points; measured below);
  * an object property is written `Name=<pointer %08x> <object name>` (`Name[<i>]=...` for an array element; `None` for null) and its target is appended to the worklist if it is not on it yet (this is how the inventory chain, the flag objects, the
    skills and the augmentations are reached);
  * any other property is written `Name[<i>]=<text>` with every newline of the text replaced by `\` (so a multi-line value stays on one line);
* then `}`.

Lines end with `\r\n`. The importer reads this back with the same grammar (below). The text for the player alone is a few kilobytes plus one block per item; a measured example is in [Measurements](#measurements).

### Browse: the DeusEx override

`DDeusExGameEngine::Browse` (`DeusEx.dll 0x10010b90`; vtable `+0xa8`, the object the engine really is is a `DDeusExGameEngine`, `DeusEx.ini` `[Engine.Engine] GameEngine`):

1. `Error = ""`; `XGameEngineExt::Browse(URL, TravelInfo, Error)` (Extension `0x10026330`): `UGameEngine::Browse` (Engine `0x1038ad30`) and, if it returned non-zero and a viewport actor exists, `APlayerPawnExt::InitRootWindow` (`0x10037df0`).
   DeusEx's build of `UGameEngine::Browse` only handles `.unreal` links, bad URLs, `?failed`/`?entry` (AbortToEntry, returns 1), `?pop`, network and external URLs. For `?restart`, `load=`, `loadgame=` and every local map it **returns 0 at
   once** (`0x1038b084 -> 0x1038b8b4`). If Super returned 1, Browse returns 1.
2. `URL.HasOption("restart")`: `info = GetDeusExLevelInfo()`; with a level info `URL = FURL(info->MapName)` with `LastURL`'s portal and the option `loadonly` added (`0x10010d00..0x10010e60`), without one `URL = LastURL`; `DeleteSaveGameFiles("")`;
   then the local-map load `LoadMap(URL, NULL, TravelInfo, Error)` (`0x100115f6`). Measured: `LoadMap: 00_training?loadonly`.
3. `URL.GetOption("loadgame=")` = *N*: `Logf("Doing loadgame, not load")`; `saveInfo = LoadSaveInfo(N)` (null -> return 0);
   `cur = <SavePath>\Current`; `src = <SavePath>\QuickSave` if `saveInfo->DirectoryIndex == -1` else `<SavePath>\Save%04d` with *N*; `DeleteSaveGameFiles(cur)`; `CopySaveGameFiles(src, cur)`;
   `url = FString::Printf("%s\%s.%s?load?loadonly?loadgame", cur, saveInfo->MapName, DefaultSaveExt)` -> `<SavePath>\Current\<MapName>.dxs?load?loadonly?loadgame`;
   `LoadMap(FURL(&URL, url, TRAVEL_Absolute), NULL, NULL, Error)`; on success `LastURL = GLevel->URL`, return 1. (`0x10010f4f..0x1001151e`.) No `TravelInfo`: the player is in the saved level.
4. Otherwise `URL.GetOption("load=")` or a local-internal URL goes to the *mission logic* (`0x10011716..`). A URL that is neither (a network or external one) ends in the `ServerOpen`/`InvalidURL` errors and returns 0.
5. The mission logic:
   * `nextMap = (load= option) ? option : URL.Map`; `curMap = GLevel ? GLevel->URL.Map : "Dx.Dx"`.
   * `cur = GetCurrentMissionNumber()` = `GetDeusExLevelInfo()->missionNumber` (`+0x33c`) or -1 with no level; `GetDeusExLevelInfo()` scans `GObjObjects` for the first `ADeusExLevelInfo` (`0x100120a0`).
   * `next = GetNextMissionNumber(nextMap)` (`0x10011ef0`): -1 for an empty name or when the first two characters are not both digits, else `atoi(Left(name, 2))`. (`dx`, `dxonly`, `entry` are -1; `00_Training` is 0; `99_Endgame1` is 99.)
   * `Logf("Current mission number is %d, next is %d", cur, next)`.
   * **If `next != -1` and the URL has no `loadonly` option**: `player = Client->Viewports(0)->Actor` (null-safe). If `next == cur` and the player is not `bStartingNewGame` (`DeusExPlayer +0xaf8` bit 0):
     `PruneTravelActors()`; `SaveCurrentLevel(-2)`; strip a `.dx` suffix from `nextMap`; `path = <SavePath>\Current\<nextMap>.<DefaultSaveExt>`; `GFileManager->FindFiles(path)`; no match: `LoadMap(URL, NULL, TravelInfo, Error)` (the fresh `.dx`);
     a match: `LoadMap(FURL(&URL, path, TRAVEL_Partial) with URL.Portal copied back, NULL, TravelInfo, Error)` (the saved level; the player still arrives by `TravelInfo`); on success `LastURL = GLevel->URL`, return 1, on failure return 0.
   * **Otherwise** (`next == -1`, `loadonly`, a different mission, or `bStartingNewGame`): `DeleteSaveGameFiles("")` (the `Current` directory is emptied; a non-null player's `bStartingNewGame` is cleared on this path) and `LoadMap(URL, NULL, TravelInfo, Error)`;
     if that fails, the old map's name replaces `URL.Map` and the load is tried again (`0x10011e38..0x10011e60`), and the result is returned.

   So *within one mission*, leaving a map files it in `Save\Current` and entering a map that is filed there restores it; *across missions*, the level is always fresh and `Current` is wiped. The game start (no `GLevel`: `cur = -1`) and a new game or Training start
   (`bStartingNewGame`) wipe it too.

#### `PruneTravelActors` and `SaveCurrentLevel`

`PruneTravelActors` (`0x1000f9b0`), for `Client->Viewports(0)->Actor` (null-safe), destroys what travels with the player so it is not filed with the level: the `AugmentationSystem` (`+0x9b0`) and each actor on its list
(`+0x370`, linked by `+0x340`), the `SkillSystem` (`+0x9b4`) and its list (`+0x358`, link `+0x360`), calls `XFlagBase::DeleteAllFlags` on the `FlagBase` (`+0x890`) and destroys it, and destroys the carried decoration (`+0x4e0`).
`Level->DestroyActor` is vtable `+0x94`. The player, its inventory, `KeyRing` and the rest of the chain are **not** destroyed here (see [Unresolved](#unresolved)); the travel text was exported before this (step 2 of the tick).

`SaveCurrentLevel(Position = -2, bSavePlayer)` (`0x1000fac0`, `ret 8`; the second parameter is not read):

1. Directory: `-2` -> `<SavePath>\Current`, `-1` -> `<SavePath>\QuickSave`, else `<SavePath>\Save%04d`; `GFileManager->MakeDirectory(dir, Tree=1)`.
2. `LevelInfo.LevelAction (+0x510) = 2` (saving); `PaintProgress()` (vtable `+0xb8`); `GWarn->BeginSlowTask(Localize("DeusEx","Saving"), ...)` unless `Position == -1`.
3. `GLevel->BrushTracker (+0xfc)` deleted and cleared; `GLevel->CleanupDestroyed(1)` (vtable `+0x98`).
4. `info = GetDeusExLevelInfo()`; `file = dir + "\" + info->MapName + "." + DefaultSaveExt` (`"\%s.%s"`, `0x1000fe2f`); **`UObject::SavePackage(GLevel->GetOuter(), GLevel, 0, file, GLog, NULL)`** (`0x1000fe93`):
   the whole level package (its `Level` object with all its actors and objects, in the engine's package format) goes to `<MapName>.dxs` (measured: written as `Save.tmp`, then `Moving '..\Save\Current\Save.tmp' to '..\Save\Current\<MapName>.dxs'`). `MapName` is the `DeusExLevelInfo.MapName` property, not the file name (`00_training` for `00_Training.dx`).
5. For each `AMover` in `GLevel->Actors`: `SavedPos (+0x4ac) = (-1, -1, -1)` (the mover's saved-position marker is reset after the save); the brush tracker is recreated (`GNewBrushTracker(GLevel)`); `EndSlowTask`;
   `LevelInfo.LevelAction = 0`; `GCache.Flush`.
   Without a `DeusExLevelInfo`: `Logf("WARNING!  DeusExLevelInfo MISSING!")` and nothing is saved.

#### The save directory

`GSys->SavePath` is `..\Save` (`DeusEx.ini` `[Core.System] SavePath`); `FURL::DefaultSaveExt` is `dxs`.

```
Save\Current\<MapName>.dxs        one per map left in the current mission (SaveCurrentLevel(-2)); emptied by DeleteSaveGameFiles("") (the directory stays)
Save\QuickSave\SaveInfo.dxs       QuickSave: SaveGame(-1)
Save\QuickSave\<MapName>.dxs      ... a copy of Current, plus the level the player is in, saved with the player in it
Save\Save0001\SaveInfo.dxs        SaveGame(N): the same, N = saveInfo.DirectoryIndex
Save\Save0001\<MapName>.dxs
```

`DDeusExGameEngine::SaveGame(Position, desc)` (`0x1000ef10`; the console `SAVEGAME n` and `DELETEGAME n` are `DDeusExGameEngine::Exec` `0x1000ed70`, other lines go to `UGameEngine::Exec`):
needs a viewport actor and a `DeusExLevelInfo`; `package = CreatePackage(NULL, "SaveInfo")`; `saveInfo = GetSaveInfo(package)` (the `UDeusExSaveInfo` named `MyDeusExSaveInfo`); fills it
(`Description` = *desc*, or the level's title when empty (`LevelInfo +0x49c`); `DirectoryIndex` = *Position*; `MapName` and `MissionLocation` from the level info; `saveCount` = `++player.saveCount`; `saveTime` = `ftol(player.saveTime)`;
`UpdateTimeStamp()`; `bCheatsEnabled`; a `Snapshot` texture holding the 160 x 120 picture (a P8 texture of 256 x 128, the next powers of two) through `XRootWindow::GenerateSnapshot` unless the render device is `OpenGLDrv.OpenGLRenderDevice`); a new slot (Position 0) takes `XGameDirectory::GetNewSaveFileIndex`;
`DeleteSaveGameFiles(dest)`; `CopySaveGameFiles(<SavePath>\Current, dest)` (every `*.dxs`); `SavePackage(package, saveInfo, 0, dest\SaveInfo.dxs, GWarn, NULL)`; `SaveCurrentLevel(saveInfo->DirectoryIndex, 0)`
(the level the player is in goes **into the slot**, with the player, not into `Current`).

`DeusExSaveInfo` (`DeusEx/DeusExSaveInfo.uc`, native object, `UDeusExSaveInfo`): `Year, Month, Day, Hour, Minute, Second` (`+0x28..+0x3c`), `DirectoryIndex` (`+0x40`), `Description` (`+0x44`), `MissionLocation` (`+0x50`),
`MapName` (`+0x5c`), `Snapshot` (`+0x68`), `saveCount` (`+0x6c`), `saveTime` (`+0x70`), `bCheatsEnabled` (`+0x74` bit 0). `LoadSaveInfo(index)` (`0x100108a0`) maps -2/-1/*n* to `Current`/`QuickSave`/`Save%04d`, loads
`<dir>\SaveInfo.dxs` and returns the `MyDeusExSaveInfo` object (`StaticLoadObject`), stamping `DirectoryIndex`. `DeleteSaveGameFiles(dir)` (`0x10010360`) releases the level package's loaders (`ResetLoaders`), takes `dir == ""` as
`<SavePath>\Current`, and deletes every file in it (`FindFiles("<dir>\*.*")`; the directory itself stays). `CopySaveGameFiles(src, dst)` (`0x10010000`) copies every `*.dxs` of `src` to `dst`.
`DeleteGame(n)` (`0x10010710`) deletes slot *n*.

#### SaveGame in full (traced 2026-10-22, DeusEx.dll and Extension.dll listings, `tools/disasm-annotated.py`)

`DeusExPlayer.SaveGame(int saveIndex, optional string saveDesc)` is native 3011, `ADeusExPlayer::execSaveGame` (`0x10014830`, thunk `0x100342e8`): the int, the optional string copied, then
`this->GetLevel()->Engine (ULevel +0x40)->SaveGame(index, desc)` (`DDeusExGameEngine::SaveGame` `0x1000ef10`, a direct call with the engine as `this`). The script callers are `DeusExPlayer.QuickSave` (`DeusExPlayer.uc:889`:
refused when `GetLevelInfo().MissionNumber < 0` (the logo map), in the states `Dying`, `Paralyzed` or `Interpolating`, while a DataLink plays (`dataLinkPlay != None`) or outside `NM_Standalone`; else `SaveGame(-1, QuickSaveGameTitle)`, the localized
"Quick Save") and `MenuScreenSaveGame.PerformSave` (`SaveGame(gameIndex, editName.GetText())`, `gameIndex` 0 for the new-slot row, whose row id field is -2); the console's `SAVEGAME n` is `DDeusExGameEngine::Exec` (`0x1000ed70`, below). The body, in order:

1. `Client (engine +0x44)->Viewports(0)->Actor (viewport +0x30)`: no viewport or no actor: return with nothing done (`0x1000ef78..0x1000ef99`). `GetDeusExLevelInfo()` (`0x100120a0`): none: `Logf("WARNING!  DeusExLevelInfo MISSING!")` and return.
2. `CreatePackage(NULL, "SaveInfo")` (null: `WARNING!  Unable to create SaveInfoPackage!`, return), then `GetSaveInfo(package)` (`0x10010850`) = `LoadSaveInfo(-2)` (`0x100108a0`: `StaticLoadObject` of `MyDeusExSaveInfo` from `<SavePath>\Current\SaveInfo.dxs`) and, when that finds nothing,
   `new(package, "MyDeusExSaveInfo", RF_Public) UDeusExSaveInfo` (size `0x78`, constructor `0x10014dc0`); null: `WARNING!  Unable to create DeusExSaveInfo Object!`, return. So the object persists in the package after the first save (later saves find it), and after `LoadGame` (which copies the
   slot, `SaveInfo.dxs` included, into `Current`) it is the loaded object. The first `SaveGame` of a process logs the failed load (measured, `s1/n9-deleted.log`): `Warning: Failed to load '..\Save\Current\SaveInfo.dxs': Can't find file '..\Save\Current\SaveInfo.dxs'` and
   `Warning: Failed to load 'DeusExSaveInfo None.MyDeusExSaveInfo': Can't find file '..\Save\Current\SaveInfo.dxs'`.
3. The fields (`0x1000f279..0x1000f3c0`): `MapName (+0x5c)` = `DeusExLevelInfo +0x318` (`MapName`); `Description (+0x44)` = the description argument when `appStricmp(desc, "") != 0`, else `LevelInfo +0x49c` (`Actors(0)`'s `Title`: "Untitled" for the Island and Training);
   `DirectoryIndex (+0x40)` = Position; `saveCount (+0x6c)` = `++player.saveCount (+0xd34)`; `saveTime (+0x70)` = `_ftol(player.saveTime (+0xd38))` (truncation toward zero); `UpdateTimeStamp()` (native 3075, `appSystemTime` into Year..Second: the local clock);
   `bCheatsEnabled (+0x74` bit 0`)` = bit 13 of the player's flag word at `+0x6a0` (`Pawn.bCheatsEnabled`); `MissionLocation (+0x50)` = `DeusExLevelInfo +0x330`.
4. The snapshot (`0x1000f3c5..0x1000f44e`): `GConfig->GetString("Engine.Engine", "GameRenderDevice")` (vtable `+0xc`); unless it equals `OpenGLDrv.OpenGLRenderDevice` (`appStricmp`): `saveInfo->CreateTexture()` (`0x10014e20`: `new(GetOuter(), None, 0) UTexture` (size `0xc0`) with the vtable `0x10028090`, so the Texture is an
   object of the package `saveInfo`; its name is the next free `Texture<n>`), `Snapshot (+0x68)` = it, `playerroot (player +0x894)->SetSnapshotSize(160.0, 120.0)` (Extension, a side effect that stays on the root window) and `XRootWindow::GenerateSnapshot(texture, 1, 0, 0)`
   (`Extension.dll 0x10039410`: with a texture argument the body reuses it instead of making one, and the rest is [root snapshot](root-snapshot.md): the last frame read back from the render device, boxed down to 160 x 120, P8 grey, in the 256 x 128 texture; the Palette is made there, named `Palette<n>`).
   With the OpenGL device `Snapshot` is set to None and no texture exists.
5. A new slot (`0x1000f460..0x1000f4b7`): when `DirectoryIndex` is 0: a new `XGameDirectory` (`new`, 0x54 bytes, transient package), `GetSaveGamesDirectory()`, `GetNewSaveFileIndex()` (largest `Save*` number + 1, [save-directory](save-directory.md)), the object destroyed; the index replaces `DirectoryIndex`.
6. The destination (`0x1000f4b7..0x1000f62f`): Position == -1: `<SavePath>\QuickSave`, else `<SavePath>\Save%04d` of `saveInfo->DirectoryIndex`; `GFileManager->MakeDirectory(dest, Tree = 1)` (vtable `+0x20`); the Current path `<SavePath>\Current`.
7. `DeleteSaveGameFiles(dest)` (`0x10010360`: `ResetLoaders` of the level package (the log's `Unloading: Package <level>`, once per level), `FindFiles(dest\*.*)`, each deleted) then `CopySaveGameFiles(Current, dest)` (`0x10010000`: `FindFiles(Current\*.dxs)`, each
   `GFileManager->Copy(dest\file, Current\file, Replace, EvenIfReadOnly, Attributes)`: the files keep their times, measured). The SaveInfo's path: `<SavePath>\QuickSave\SaveInfo.dxs` for -1 (Position, not the index), else `<SavePath>\Save%04d\SaveInfo.dxs`.
8. `UObject::SavePackage(package, saveInfo, 0, path, GWarn, NULL)` (`0x1000f8e6`): `Base` the SaveInfo with its Texture and Palette; the engine log has `Save=<ms>` and `Moving '..\Save\<dest>\Save.tmp' to '..\Save\<dest>\SaveInfo.dxs'`. Then `SaveCurrentLevel(saveInfo->DirectoryIndex, 0)` (`0x1000f8f8`):
   the level **with the player and its FlagBase** (no `PruneTravelActors`), the same function as a level change ([above](#prunetravelactors-and-savecurrentlevel)) with `Position` as the directory and no `BeginSlowTask` for -1. The measured log of `SaveGame 77` is, in order: the two warnings, `Unloading: Package 01_NYC_UNATCOIsland`,
   `Save=5.054840`, `Moving ...\Save0077\SaveInfo.dxs`, `Shut down moving brush tracker`, `Save=92.787551`, `Moving ...\Save0077\01_NYC_UNATCOIsland.dxs`, `Initialized moving brush tracker`.

`DDeusExGameEngine::Exec` (`0x1000ed70`, reached through `UGameEngine`'s second vtable, `this - 0x28`): `ParseCommand(&Cmd, "SAVEGAME")`; matched: when the next character is `0`..`9`, `SaveGame(appAtoi(Cmd), "")`; matched or not the command is claimed (returns 1, `0x1000ee60`).
Then `ParseCommand(&Cmd, "DELETEGAME")` the same way for `DeleteGame(appAtoi(Cmd))`; any other line goes to `UGameEngine::Exec`. `DeleteGame(n)` (`0x10010710`): `<SavePath>\Save%04d` with `n` (no QuickSave case: -1 is `Save-001`) and `GFileManager->DeleteDirectory(path, RequireExists = 0, Tree = 1)` (vtable `+0x24`).
`Object.GetConfig(section, key)` (`Core.dll` `UObject::execGetConfig 0x1013e4e0`, a Deus Ex addition): `GConfig->GetString(Section, Key, &Value, NULL)` (vtable `+0xc`, no file name: the system ini), the empty string when absent.

**The SaveInfo.dxs file** (decoded from three originals: the Wine session's Save0077 and the desktop saves Save0001 and QuickSave, `.work/travel/dxs/save77-SaveInfo.dxs`, `save-backup-pw1`): a version-68 package (the header as the levels', package flags 1) of 3 exports with no Outer, 5 imports (Engine, Engine.Texture, DeusEx, DeusEx.DeusExSaveInfo,
Engine.Palette) and 33 names (`None`, then the property and class names of the three objects in the original process's FName-table order (`InternalTime, VBits, VClamp, UBits, UClamp, Palette, Description, USize, VSize, MapName, saveTime, Second, Minute, Hour, Day, Month, Year, MissionLocation, Snapshot, DirectoryIndex, saveCount, saveInfo, DeusExSaveInfo, DeusEx, Texture, Class, Package, Engine, Core`:
`saveInfo` is in the table and used by no entry), then the three object names in export order). The Texture (flags `0x70000`) carries `Palette` (the export), `UBits 8`, `VBits 7`, `USize 256`, `VSize 128`, `UClamp 256`, `VClamp 128`, `InternalTime[0..1]` (the engine's `appSeconds()` as two ints: a host clock reading, different in every file) and one mip
(`compact(1)`, the lazy array's SkipPos (the absolute file position after the indices), `compact(32768)`, the P8 indices, USize, VSize, UBits, VBits); the Palette (`0x70000`) 256 colours (i, i, i, 255); `MyDeusExSaveInfo` (`0x70004`) the tags Year, Month, Day, Hour, Minute, Second, DirectoryIndex, Description, MissionLocation, MapName, Snapshot, saveCount, saveTime, bCheatsEnabled
(a value equal to the default, 0, "" or false, is not stored, so a Minute of 0 is absent). The order of the Texture and the Palette is the objects' order in GObjObjects (Texture0 before Palette0 in the Wine file, Palette1 before Texture1 and Palette3 before Texture3 in the two older ones); the number is the unique-name counter.
`src/runtime/save-info-write.mjs` writes this layout: **given the original's GUID, InternalTime, pixels, names and export order it reproduces all three files byte for byte** (`test/save-info-write.test.mjs`, 0 differing bytes of 34,569, 34,576 and 34,563).

What the Load Game and Save Game screens *read* of this directory, the `GameDirectory` natives 3080-3094 behind it and Play's save-directory interface are in [save-directory](save-directory.md)
(2026-10-21: the directory side of step 4; the screen opens from the default start with an empty directory, as the original does with no saves. 2026-10-22: the page gives that directory real saves from the browser or a picked `Save` folder, and the screen draws their snapshot pictures; Load Game still stops at `Browse loadgame`: [save storage](save-storage.md).)

#### The `.dxs`: a saved level's package

Decoded 2026-10-22 from the files of `.work/travel/dxs` (`00_training`, `00_TrainingCombat`, `island-left`) and `rt1/*.Current` (the Island and HQ, saved with play behind them: 8 files in all), and read again by `scripts/validate-level-save.mjs`.
The same validator reads the 120 level files of 41 real desktop save slots downloaded from the internet (`.work/internet-saves`, outside Git, sources in its `SOURCES.md`: one 2002-03 playthrough of
every mission from Liberty Island to Area 51, and two GOTY 1.112fm slots): their `Model`, `Polys`, `LevelSummary` and AI event payloads write back to their own bytes too (2026-10-22, 128 files in all).
A file is a normal version-68 package (`parsePackage`; magic `0x9e2a83c1`, 64-byte header: counts and offsets of the name, export and import tables, the GUID, one generation `{exports, names}`).

* **Actors**: one export per entry of `Level.Actors` (the `Level`'s actor array holds each export's index), flags `0x2070001` (`RF_HasStack`): `[FStateFrame header][tagged properties]`. The header is `Node`, `StateNode` (compact object references), `ProbeMask` (two words),
  `LatentAction`, and with a `Node` its code offset (`-1` when no state code runs); a restored actor continues from it (`ScriptState.restoreFrame`). The tagged list holds each property of the class chain that is not `CPF_Transient`, not `CPF_Native` and not
  identical to the class default's (`UObject::SerializeTaggedProperties`; byte-identical to Play's writer on 2,584 of 2,594 Island actors, the rest differing by what the save itself changed: the counters `Login` bumped and the properties `PruneTravelActors` nulled).
  Tags carry their type (bool: the size bit in the info byte; struct: the struct name; array elements by index); a **class** property has tag type 5.
* **Other objects** reachable from an actor and made at run time with the level or an actor as `Outer` (the conversation history of the player, notes, goals, logs): flags `0x70000`, `[tagged properties]` only. `CLASS_Transient` classes are not saved and a reference to one is `None`
  (`MissionScript`: `DeusExPlayer.TravelPostAccept` spawns it again, which is why a restored level logs `Spawned new mission script`).
* **`Level`** (`MyLevel`): the property list `None`, then `Actors` (count twice, compact references), the URL (`deusex`, host, map, portal, options), two words (`7790`, `1`), the world `Model`, `ReachSpecs`, `TimeSeconds` (the double written as a **float**,
  `0x1039d5a2`), `FirstDeleted` (0: `CleanupDestroyed(1)` ran), 16 empty `TextBlocks`, and `TravelInfo` (the text pairs, so a loaded level keeps the text it was entered with).
* **Native payloads** copied with every reference translated: the world `Model`, each mover's brush `Model` and its `Polys`, and the `LevelSummary` (`model-transcode.mjs`). In the measured files two brush objects of `00_TrainingCombat.dxs` carry an `FStateFrame` header
  (flags `0x2070001`) where every other `Model` and `Polys` has none (`0x70001`); when the original does which is **unresolved**, Play's reader skips the header and its writer leaves it out.
* **The AI event manager** (`EventManager` and its `AIEventType`, `AISenderEvent` and `AIReceiverEvent`: 296 + 54 + 9 objects in a saved Island): each a native `UObject` whose `Serialize` writes the empty property list and then its members
  ([ai-event-manager](ai-event-manager.md), `ai-events-payload.mjs`).
* **Name flags**: every name of a saved level carries `0x70010` (plus the native bits `0x4000000`, `0x400` of a few): the load flags `RF_LoadForClient|RF_LoadForServer|RF_LoadForEdit`. The original's loader (`ULinkerLoad::LoadNameMap`) maps a name whose flags lack its context
  to `None`, which ends a tag list at once: a `.dx` holds a few editor-only names with `0x40010` (`bHidden` among them, `bHiddenEd`, `CsgOper`, `PolyFlags`, ...), and a Play-written file that copied them stopped the original at `Candybar2` (`Serial size mismatch: Got 35, Expected 120`, the first
  actor whose second tag was `bHidden`). Play's writer saves every name with the load flags.
* **Not in the file**: the viewport and the windows (a reference to one is `None`), destroyed actors (`CleanupDestroyed(1)` emptied the chain), the transient classes above.
* **The player** is in the file: the pawn with its replication info, inventory and `KeyRing` (`PruneTravelActors` destroyed the `AugmentationSystem`, `SkillSystem`, `FlagBase` and carried decoration and nulled the properties that held them). On restore `GameInfo.Login` finds the saved pawn on
  `Level.PawnList`, **moves it to the start spot** (the portal's teleporter, or the `PlayerStart`) and re-possesses it, so the level holds one player pawn, under the name it was saved with (`JCDentonMale3`), and none leaks.
* **Loading**: the file's `LevelInfo.bBegunPlay` is set, so `LoadMap` skips the begin-play pass and runs `PostPostBeginPlay` over the live array, then the partition ([LoadMap](#loadmap)); the one load warning is
  `Type mismatch in Region of GameReplicationInfo: file 10, class 2` (the saved struct tag of a property that is an object in the retail class; the tag is skipped).

### LoadMap

`UGameEngine::LoadMap` (`0x1038c1f0`) is covered where the stages needed it ([GameInfo selection](script-loadmap-gameinfo.md), [startup scheduler](script-loadmap-startup.md),
[retiring and collecting the previous level](script-loadmap-gc.md)). What travel adds:

* **TravelInfo**: after the new level is loaded and before it is brought up, `GLevel->TravelInfo = *TravelInfo` when the argument is non-null (`0x1038d09a..0x1038d0bf`; the map including its hash size). A later `?restart` uses it again.
* **The level file**: `URL.Map` is loaded as a package (`StaticLoadObject(ULevel, ..., "MyLevel")`, `0x1038c695..0x1038c6b0`); a saved `.dxs` level is the same kind of package as a `.dx` map, so `Save\Current\X.dxs` and `Save\SaveNNNN\X.dxs` load through the same path.
* **Cold or warm**: `LevelInfo.bBegunPlay` (`LevelInfo +0x4f0`, bit 1; test at `0x1038d6f6`). A map from a `.dx` file has it clear, so LoadMap runs the whole begin-play pass (`InitExecution`, `PreBeginPlay`, `BeginPlay`, `SetActorZone`, `PostBeginPlay`, `SetInitialState`,
  base fixup, `PostPostBeginPlay`, `TimeSeconds` from 0). A level saved while it played has the bit set, so LoadMap **skips that pass** (`jne 0x1038dbec`) and continues with the saved actors as they were; the level's time is restored from the saved
  `LevelInfo.TimeSeconds` (`0x1038dc59`: `ULevel+0xdc` double from `LevelInfo+0x478`). A restored level does not run `BeginPlay` again.
* **Players**: `SpawnPlayActor` for the viewport after the level is up (`0x10396bd0`), which is where the travel text is read.

### SpawnPlayActor: importing the travel text

[Original standalone player login](script-player-login.md) gives the order of `Login`, `SetPlayer`, `Role`, `TravelPreAccept`, `AcceptInventory`, `TravelPostAccept`, `PostLogin`. The import in the middle (`0x103971f7..0x10397c34`):

1. Skip everything if `URL.HasOption("loadonly")`.
2. `name = URL.GetOption("NAME=", FURL::DefaultName)`. Look `name` up (case-insensitive) in `ULevel.TravelInfo`; if it is not there, `NetMode == NM_Standalone` (`LevelInfo +0x518 == 0`) and the map is not empty: take the **first** pair's value. No text: no import.
3. *Pass 1, objects.* Repeat while text remains: `Parse(text, "CLASS=")`, `"NAME="`, `"PTR="` (a record that lacks one stops the pass); `StaticLoadClass(UObject, NULL, <class>, NULL, 0x22)`:
   * not found: `Logf("SpawnPlayActor: Cannot accept travelling class '%s'")`, the record is read past and ignored;
   * a `PlayerPawn` class: the record stands for the *new* player (`Login`'s);
   * an `Actor` class: `SpawnActor(Class, NAME_None, Owner = player, Instigator = NULL, player.Location, player.Rotation, Template = NULL, bNoCollisionFail = 1, bRemoteOwned = 0)`; failure logs `Failed to spawn travelling class`;
   * any other class: `StaticConstructObject(Class, Outer = player, NAME_None, 0, NULL, GError)`;
   each object is entered in a table with its record's name and `Ptr`; the lines of the record up to `}` are stored with it (`ParseLine`, the `{` line skipped).
4. *Pass 2, properties.* For every table entry, for every stored line: skip leading spaces; read `Name` (letters, digits, `_`), optional `[index]`, `=`; the value is the rest with `\` turned back into a newline. Find the class's property of that name that has
   `CPF_Travel` (class chain, own first). An object property: if the value starts with a hex pointer, remember `(address of the property slot, pointer)` for pass 3 (`"InPtr != InName && Ptr != 0"` assert at `UnLevAct.cpp:0x22a`); any other property: `Property->ImportText(value, slot, 0)` (vtable `+0x84`).
   A line whose property is missing or not `travel` is ignored.
5. *Pass 3, references.* Each remembered `(slot, pointer)` whose pointer equals an entry's `Ptr` gets that entry's object written into the slot. Pointers that match nothing keep whatever the slot held.
6. Callbacks as in the table above: `TravelPreAccept` over the entries last to first (not the player), `AcceptInventory`, `TravelPostAccept` last to first (not the player), the player's `TravelPostAccept`, `PostLogin`.

The player's own record is applied to the object `Login` made, so the new player gets the old one's travel properties (health, credits, skill points, `Inventory`, `FlagBase`, ...); the objects `ResetPlayerToDefaults` created before (a first `FlagBase`, `SkillSystem`, `AugmentationSystem`, `KeyRing`)
are replaced by the imported ones through the property assignments and become garbage.

## Which branch each single-player entry takes

`cur` is the *level info's* `missionNumber` of the level being left; `next` is the first two digits of the *destination's file name* (`GetNextMissionNumber`). Measured lines are marked (M).

| Entry | URL / type / `bItems` | `DDeusExGameEngine::Browse` branch | `Save\Current` afterwards | Player at arrival |
| --- | --- | --- | --- | --- |
| Game start (`DX.dx`) | the startup `Browse` | local map, `cur -1`, `next -1` (M) -> wipe, `LoadMap` | empty | fresh `Login`, no travel text |
| Menu: Training | `00_Training`, Relative, true | `cur -2`, `next 0` (M) -> wipe | empty | travel text (74 records, M) |
| Menu: New Game | `ShowIntro(True)`: `00_Intro`; after the intro `StartNewGame(strStartMap)` | `-2 -> 0` (M, 96-record text), then `98 -> 1` (M, 79 records; the intro's level info says 98): wipe both times; `bStartingNewGame` is set | empty | travel text |
| MapExit / Teleporter to a map of the same mission | `Map[#Portal]`, Relative, true | `next == cur` (M `0,0`, `1,1`, `2,2`): `PruneTravelActors`, `SaveCurrentLevel(-2)`, the destination restored if filed | the maps left (M) | travel text |
| MapExit to the next mission | same, `next != cur` | wipe (M `1,2`) | empty (M) | travel text |
| Endgames, credits, `dxonly`, `dx` | `-1` for `dx`/`dxonly`, 99 for the endgames | `15 -> 99` (the endings, M), `99 -> -1` (the credits after an ending, M) and `98 -> -1` (the intro's end, M): wipe | empty | travel text (the endgame: 96 records; `dxonly`: 97 after the intro, 98 after an ending, M) |
| Console `OPEN map` | Partial, false | by the mission numbers (M `2,-1`) | as the numbers say | **none** (empty `TravelInfo`): a fresh player |
| Death (`OPEN DXONLY`) | Partial, false | `next -1` -> wipe | empty | none |
| Load Game / QuickLoad | `?loadgame=N`, Absolute, false | `loadgame=`, no mission lines (M) | a copy of the slot (M) | the saved pawn, in the saved level |
| `RestartLevel` (`?restart`) | Relative, false | the `restart` branch: no `Export travel` (M) | emptied (M) | fresh `Login`, the level reloaded from the `.dx` with `?loadonly`, no travel text (M) |

## Destinations in the installed maps

A census of every map in `Maps/` (`decodeMap`, `DeusExLevelInfo`, `MapExit`, `Teleporter`; `.work/travel/census-exits.json`) finds:

* 47 `MapExit` actors: 20 with `bPlayTransition` (the mission-ending camera paths: `Dock_boatpath`, `CameraPath`, `Camera1`, `heli_camera`, ...), 27 that travel directly (Hong Kong, Vandenberg, `02_NYC_Street`/`Warehouse`, the endgame starts).
  37 distinct non-empty `DestMap`s, 21 of them with a `#portal`. Four have no `DestMap` in the map (`00_Intro` `MapExit1`, `12_Vandenberg_Gas` `MapExit6`/`MapExit7`, `14_Vandenberg_Sub` `MapExit0`; set by script or unused: **unverified**).
  Six end in `.dx` (`04_NYC_UNATCOIsland.dx`, `06_hongkong_helibase.dx`, `14_Vandenberg_sub.dx#subbay`, ...) and three have a space before the `#` (`15_area51_bunker.dx #bunker_start`, `14_Oceanlab_silo.dx #frontgate`, `14_OceanLab_Lab.dx #Sunkenlab`).
  `00_TrainingFinal`'s exit goes to `dx` (the logo map) and `15_Area51_Final`/`Page` to the endgames `99_Endgame1..3`; `99_Endgame1` exits to itself.
* 298 `Teleporter` actors, 149 with a URL, all of the form `Map#Portal`; the others are the targets (their `Tag` is the portal name). They are the way between the maps of one mission (the Training trio, UNATCO HQ and Island, the NYC street and its
  interiors, ...).
* `missionNumber` per map: -2 `DX`, -1 `DXOnly`, 0 the three Training maps (not serialized: the property default), 1..15 the missions, 98 `00_Intro`, 99 the endgames, 7/12/14/15/16 for the `DXMP_*` maps.

## Measurements

2026-10-21, the installed game under Wine on the Linux host (`~/.wine-deusex`, the shared Wine lock), one launch, many travels. Tools: `scripts/travel-step.sh` (console lines through the Talk key, a wait for a level
by its `URL.Map`, a snapshot of the save directory, the engine log, the player's `FlagBase` (`tools/dump-flags-win.c`) and the levels' URL and `TravelInfo` (`tools/dump-travel-win.c`, new: it reads
`ULevel+0x44` and `+0xe4` from the running process)), `scripts/travel-probe.sh` (the same steps in one locked session: it launches, runs a steps file and quits; `r1` was its first run, then the same game was driven by `travel-step.sh` through `s1`..`s4`, one launch in all). Captures are under `.work/travel/` (`r1`, `s1`..`s4`, a copy of the level files of `Save\Current` in `dxs/`).
One caveat: the engine log is flushed in 8 KB blocks, so the copy taken at a snapshot ends at the last flush; the last snapshot's copy (`s4/f2-space-portal.log`, 813 lines) holds the whole session but its last few lines.

How the scenarios are driven: the console `LocalTravel <url>` is `ClientTravel(url, TRAVEL_Relative, true)`, exactly what `SendPlayer` calls; the console `StartNewGame <map>` is the `exec` function of the same name
(script `StartNewGame`: the pistol, the prod and a medkit, then `SendPlayer`); `SaveGame n`/`DeleteGame n` are `DDeusExGameEngine::Exec`; `LoadGame n` is the `exec` function. To look at a level *as it arrives*, before its
first `MissionScript` timer, `set LevelInfo bPlayersOnly True` is typed first: the class default carries into the next level, which then loads frozen (the method of `ad/README.md`'s intro captures).
The game boots into the logo map `DX.dx` whatever map the command line names (log: `Browse: DX.dx?Name=Player?Class=DeusEx.JCDentonMale` after `LoadMap: entry.dx`).

### What each travel did

| Travel (from the logo map unless noted) | `bItems` | Engine log (in order) | `Save\Current` afterwards | Arrival |
| --- | --- | --- | --- | --- |
| `LocalTravel 00_TrainingCombat` (mission -2 to 0) | true | `Export travel for: Player`; `Browse: 00_TrainingCombat?Name=Player?Class=DeusEx.JCDentonMale`; `Doing load, not loadgame`; `Current mission number is -2, next is 0`; `Attempting to get player`; `Unloading: Package DX`; `LoadMap: ...`; `Loading: Package ...`; `Collecting garbage`; `Purging garbage`; `Garbage: objects: 34883->34678`; `Game class is 'DeusExGameInfo'`; `Bringing Level 00_TrainingCombat.MyLevel up for play (0)...`; `InitGame: ?Name=Player?Class=DeusEx.JCDentonMale`; `Spawned new mission script 'DeusEx.Mission00'`; `Spawning new actor for Viewport`; `Login: Player`; `Possessed PlayerPawn: JCDentonMale 00_TrainingCombat.JCDentonMale1`; `All inventory from Player is accepted` | empty | fresh `.dx`; URL `Map=00_TrainingCombat`, `Op=[Name=Player, Class=DeusEx.JCDentonMale]`, `TravelInfo` = 1 pair, key `Player` |
| `LocalTravel 00_Training` (Combat to Training, mission 0 to 0) | true | `Export travel`; `Browse`; `Current mission number is 0, next is 0`; `Attempting to get player`; **`Shut down moving brush tracker for Level 00_TrainingCombat.MyLevel`; `Unloading: Package 00_TrainingCombat`; `Save=28.546052`; `Moving '..\Save\Current\Save.tmp' to '..\Save\Current\00_TrainingCombat.dxs'`; `Initialized moving brush tracker`**; then `LoadMap`, as above | `00_TrainingCombat.dxs` 1,650,584 bytes | fresh `.dx` (no `Training` file yet) |
| `LocalTravel 00_TrainingCombat` (Training to Combat) | true | the same, with `00_training.dxs` written | `00_TrainingCombat.dxs` (**unchanged**, still there) and `00_training.dxs` 3,245,939 | the **saved** Combat: URL `Map=..\Save\Current\00_TrainingCombat.dxs`; the pawn is the saved `JCDentonMale1` |
| `StartNewGame 01_NYC_UNATCOIsland` (Combat to Island, mission 0 to 1; `bStartingNewGame`) | true | as the first row | empty | fresh; the text carries a `MedKit`, `WeaponProd`, `AmmoBattery`, `WeaponPistol`, `Ammo10mm` |
| `LocalTravel 01_NYC_UNATCOHQ` (Island to HQ, 1 to 1) | true | the save lines for `01_NYC_UNATCOIsland.dxs` | `01_NYC_UNATCOIsland.dxs` 8,071,358 | fresh HQ |
| `LocalTravel 01_NYC_UNATCOIsland` (HQ to Island) | true | the save lines for HQ | `...HQ.dxs` 1,890,516 and the Island file | the saved Island: URL `Map=..\Save\Current\01_NYC_UNATCOIsland.dxs`; exactly one `JCDentonMale` actor, `JCDentonMale3`, with `Player` set |
| `LocalTravel 01_NYC_UNATCOHQ`, again | true | (the Island file is written again, 8,087,378) | both files; HQ read from `Current`, not rewritten | saved HQ |
| `LocalTravel 02_NYC_Street` (Island, restored from the load, to mission 2) | true | `Current mission number is 1, next is 2` | **empty** (the directory stays) | fresh |

### What each save command did

* `SaveGame 77` (in the restored Island, `Current` = `{HQ, Island}`): `Save0077\` = `SaveInfo.dxs` (34,569 bytes), `01_NYC_UNATCOHQ.dxs` (copied from `Current`, its time preserved: 06:28:45) and
  `01_NYC_UNATCOIsland.dxs` (8,092,508 bytes, **new**, written for the live level, with the player). `Current` is not touched. `SaveInfo.dxs` holds `MyDeusExSaveInfo`:
  `DirectoryIndex 77`, `Description "Untitled"` (the level's title; the command passed none), `MissionLocation "NYC - Liberty Island"`, `MapName "01_NYC_UNATCOIsland"`, `saveCount 1`, `saveTime 135`, the date and a snapshot texture.
* `LoadGame 77` (from HQ): `Current` is **replaced by a copy of the slot**, `SaveInfo.dxs` included, with the slot's file times; the level is `..\Save\Current\01_NYC_UNATCOIsland.dxs`. The call passes no travel text, yet the loaded
  level's `TravelInfo` holds one pair (the HQ player's record): `ULevel::Serialize` writes `TravelInfo` into the saved level, so a loaded or restored level keeps the text it was entered with (and `?restart` can reuse it; inferred, since `LoadMap` was called with a null map).
  The player's flags are what the file held (`PlayerTraveling` was still set in it, because the save was taken before the level's first timer).
* `DeleteGame 77`: the whole directory `Save0077` is gone.
* Save files are ordinary version-68 Unreal packages (`parsePackage` reads them): `SaveInfo.dxs` has 3 exports (`DeusExSaveInfo`, `Texture`, `Palette`); a level file has the level's whole object set, 541..3,042 exports
  (`Level MyLevel`, every actor, `LevelInfo`, `DeusExLevelInfo`) **and the player's pawn with its replication info, `NanoKeyRing`s, `AugmentationManager`/`SkillManager`, inventory and `FlagBase`**: `PruneTravelActors` does not remove the pawn.
  A `Current` file written on leaving a level has `JCDentonMale<N>` in it; the old `Save0001\00_training.dxs` from 2026-09-12 has 661 exports including `JCDentonMale1`, `WeaponPistol`, `WeaponProd`, `FlagBase2` and 15 `FlagBool`.

### The player's flags across a travel

`tools/dump-flags-win.c` at the frozen arrival (before the new `MissionScript`'s first timer) and after it:

| Moment | `FlagBase` | `defaultExpiration` |
| --- | --- | --- |
| logo map, before the travel | no flag | 0 |
| arrival at Combat (frozen) | `PlayerTraveling` (bool, expiration 0) | 0 |
| after Combat's timer | `M0MissionStart` (expiration 1) | 1 |
| arrival at Island by `StartNewGame` (frozen) | `PlayerTraveling` | 1 |
| after Island's timer | `M01_NYC_UNATCOISLAND_StartupText`, `M1MissionStart` (expiration 2) | 2 |
| arrival at HQ (frozen), at the restored Island, in the loaded game, at Street (frozen) | `PlayerTraveling` plus the earlier mission-1 flags (expiration 2) | 2 |

So the `SKTemp_SkillPointsAvail`/`Total` flags that the travel text carries are consumed at once by `TravelPostAccept` (`RestoreSkillPoints`); `PlayerTraveling` is the one flag left to the first timer, which removes it.
(The mission-1 flags at Street are still there at the frozen arrival; the first timer's `DeleteExpiredFlags(2)` removes them, expiration 2 <= 2.)

### The travel text, as exported

`tools/dump-travel-win.c` prints the value the new level kept. The text for the logo-map player going to Training Combat is 413 lines, 10,797 bytes, 96 records (`.work/travel/r1/dx-to-combat.travel.txt`); a new game's
text at the Island has 79 records, and the one for the player leaving HQ after a few minutes has 103. The head of the first (pointers are runtime addresses):

```
Class=DeusEx.JCDentonMale Name=JCDentonMale0 Ptr=02e5a800
{
AugmentationSystem=0549ec00 AugmentationManager0
SkillSystem=0549d800 SkillManager0
KeyRing=043b5a00 NanoKeyRing1
BarkManager=04c05000 BarkManager0
ThemeManager=05328500 ColorThemeManager0
FlagBase=0527a640 FlagBase0
Inventory=043b5a00 NanoKeyRing1
}
Class=DeusEx.AugmentationManager Name=AugmentationManager0 Ptr=0549ec00
{
AugLocs[6]=(AugCount=3)
FirstAug=043bdc00 AugSpeed0
}
...
Class=Extension.FlagBase Name=FlagBase0 Ptr=0527a640
{
hashTable[11]=02b72c60 FlagBool0
hashTable[43]=02b72bc0 FlagInt1
hashTable[63]=02b72c10 FlagInt0
}
...
Class=Extension.FlagBool Name=FlagBool0 Ptr=02b72c60
{
bValue=True
FlagName=PlayerTraveling
flagHash=908074891
FlagBase=0527a640 FlagBase0
}
Class=Extension.FlagInt Name=FlagInt1 Ptr=02b72bc0
{
intValue=5000
FlagName=SKTemp_SkillPointsTotal
flagHash=-1881739733
FlagBase=0527a640 FlagBase0
flagType=FLAG_Int
}
```

What it shows:

* **Defaults are left out.** A fresh player writes no `Health`, `Credits` or skill points; after Mission00's `FirstFrame` zeroed them, `SkillPointsTotal=0` and `SkillPointsAvail=0` *are* written (they differ from the 5000 default); `saveTime=67.075813`
  is written. The flags: `expiration` 0 and `flagType=FLAG_Bool` (0) are left out; `FLAG_Int` and a non-zero expiration are written.
* **Order.** Records are in worklist order: the player; then the objects its travel properties point at, in the order of the class chain (`AugmentationSystem`, `SkillSystem`, `KeyRing`, `BarkManager`, `ThemeManager` of `DeusExPlayer`; `FlagBase` of `PlayerPawnExt`;
  `Inventory` of `Actor`); then theirs. The managers' lists (`FirstAug` -> `Next`, `FirstSkill` -> `Next`, `FirstColorTheme` -> `Next`) and the flag chains come out one link per record.
* **Names.** The property is written with the spelling of its `FName` (`FlagName` for the declared `flagName`); the importer compares without case.
* **Items.** After `StartNewGame` the chain is `Inventory=MedKit0`; `MedKit0 { bInObjectBelt=True, beltPos=3, Inventory=WeaponProd0 }`; `WeaponProd0 { AmmoType=AmmoBattery0, bInObjectBelt=True, beltPos=2, Inventory=AmmoBattery0 }`;
  `WeaponPistol5 { AmmoType=Ammo10mm5, bInObjectBelt=True, beltPos=1, Inventory=Ammo10mm5 }`: the item chain follows `Inventory.Inventory`, and the belt position is the item's own property.
* The `NanoKeyRing` (a normal `Inventory` item) is in every text: `bInObjectBelt=True`, `beltPos=0`.
* **Key.** `TravelInfo` holds one pair, key `Player` (the player's name), in the arrival level (`ULevel+0xe4`).

### Restoring a level: what the log shows

The log of a saved level's `LoadMap` (`Browse: 02_NYC_Street?Name=Player?Class=...` then `LoadMap: ..\Save\Current\02_NYC_Street.dxs?Name=Player?Class=DeusEx.JCDentonMale`) has `Loading: Package ...`, one load warning
(`Type mismatch in Region of GameReplicationInfo: file 10, class 2`), the garbage pass, `Spawning new actor for Viewport`, `Login: Player`, `Possessed PlayerPawn: JCDentonMale 02_NYC_Street.JCDentonMale5`, `All inventory from Player is accepted`, and then
`DeusExLevelInfo - Spawned new mission script 'DeusEx.Mission02'` (the mission script is `transient`: `TravelPostAccept` makes it, `DeusExPlayer.uc:699..710`) and `InitStateMachine()`. It has **no** `Game class is 'DeusExGameInfo'`, no `Bringing Level ... up for play`,
no `InitGame`, no `Base Mutator`: the begin-play pass is skipped (the saved `LevelInfo` has `bBegunPlay`), while a fresh `.dx` prints `Game class`, `Bringing Level`, `InitGame`, `Base Mutator`, and `Spawned new mission script` *before* `Spawning new actor for Viewport`
(from `DeusExLevelInfo.PostBeginPlay`). The player in the restored Island is the saved pawn (`JCDentonMale3`), re-possessed; no second pawn exists.

**Destroyed actors stay destroyed.** In `00_Training` (reached from the menu), `set DeusEx.JCDentonMale bCheatsEnabled True` and `KillAll UNATCOTroop` destroyed the four troops (`dump-actor-win` shows `bDeleteMe` set on all). After
`LocalTravel 00_TrainingCombat` and `LocalTravel 00_Training` the level came back from `..\Save\Current\00_Training.dxs` with **no** `UNATCOTroop` actor object at all (the fresh `.dx` has four), and with `UNATCOTroopCarcass0` (the knocked-out test subject
`Mission00.FirstFrame` makes) still there; the player is the one pawn `JCDentonMale8` with a viewport.

### The restore capture `rt1` (2026-10-22)

One launch of the original under Wine (`scripts/travel-probe.sh`, the shared lock; `.work/travel/rt1`): `StartNewGame 01_NYC_UNATCOIsland`; on the Island the troops killed (`KillAll UNATCOTroop`) and a `UNATCOTroop`, a `Sodacan` and `Binoculars` summoned; `LocalTravel 01_NYC_UNATCOHQ`; at HQ
`KillAll UNATCOTroop` and a `Candybar` summoned; `LocalTravel 01_NYC_UNATCOIsland` (the Island restored); `LocalTravel 01_NYC_UNATCOHQ` (HQ restored); `LocalTravel 02_NYC_Street` (a mission change). Each step snapshots the level (actors, `GObjObjects`, flags, log, `Save\Current`).

* **Listings**: after leaving the Island `Current` = `{01_NYC_UNATCOIsland.dxs 8,052,532}` (the level's `MapName`); after leaving HQ `{01_NYC_UNATCOHQ.dxs 1,907,461, 01_NYC_UNATCOIsland.dxs}` (the Island's file is not written again by the restore); after the mission change `Current` is empty, the directory stays.
* **Log of a leave-and-restore** (`final.log`): `Export travel for: Player`, `Browse`, `Current mission number is 1, next is 1`, `Attempting to get player`, `Shut down moving brush tracker for Level ...MyLevel`, `Unloading: Package ...`, `Save=<ms>`, `Moving '..\Save\Current\Save.tmp' to '...dxs'`,
  `Initialized moving brush tracker`, `LoadMap: ..\Save\Current\<Map>.dxs?Name=Player?Class=DeusEx.JCDentonMale`, the load warning, `Spawning new actor for Viewport`, `Login: Player`, `Possessed PlayerPawn: JCDentonMale <Map>.JCDentonMale<N>`, `All inventory from Player is accepted`,
  `DeusExLevelInfo - Spawned new mission script`, `InitStateMachine()`. None of `Game class is`, `Bringing Level`, `InitGame`, `Base Mutator`.
* **The restored Island**: the troops destroyed before the leave are not in the file (the level's `UNATCOTroop` objects are the carcasses and the summoned one), a `Sodacan` and `Binoculars` are in its object list again (`i3-soda`, `i3-binoculars`) and the restored HQ holds the `Candybar` (`h3-candybar`); one player pawn, `JCDentonMale1`, the saved one with `Player` set (no leaked second pawn); the flags are the travel text's
  (`M01_NYC_UNATCOHQ_StartupText`, `M01_NYC_UNATCOISLAND_StartupText`, `M1MissionStart`, ...) at default expiration 2.
* The two measured Unresolved items it closes are 3 (no leaked pawn; the name is kept) and 5 (below).

### Load game, restart and URL forms

**`LoadGame 77`** (log): `URL: Adding default option Name=Player`, `URL: Adding default option Class=DeusEx.JCDentonMale`, `Browse: Index.dx?loadgame=77?Name=Player?Class=DeusEx.JCDentonMale`, `Doing loadgame, not load` (no `Current mission number` line, no `Export travel`),
`Loading: Package saveInfo`, `Unloading: Package 01_NYC_UNATCOHQ`, `LoadMap: ..\Save\Current\01_NYC_UNATCOIsland.dxs?load?loadonly?loadgame?Name=Player?Class=DeusEx.JCDentonMale`, then the restored-level sequence above (`Login: Player`,
`Possessed PlayerPawn: JCDentonMale 01_NYC_UNATCOIsland.JCDentonMale3`, ...). The `FURL` constructor adds the `Name=` and `Class=` defaults of `[DefaultPlayer]` to every URL that lacks them (the `?loadgame=77` text names the map `Index.dx`, `FURL::DefaultMap`).

**`RestartLevel`** (the `exec` function: `ResetPlayer()`, then `ClientTravel("?restart", TRAVEL_Relative, false)`), from the restored Training: `Browse: ..\Save\Current\00_Training.dxs?Name=Player?Class=DeusEx.JCDentonMale?restart`, **no** `Export travel` and no
mission-number line, `LoadMap: 00_training?loadonly` (the map name is the level info's `MapName`), the full cold sequence (`Game class is`, `Bringing Level 00_Training.MyLevel up for play (0)...`, `InitGame: ?loadonly`, `Base Mutator`, `Spawned new mission script`),
`Login: ` (an empty name: the URL has no `Name=` option), `Possessed PlayerPawn: JCDentonMale 00_Training.JCDentonMale10`. `Save\Current` was emptied; the new player's `FlagBase` has no flag (the `loadonly` option skips the travel import, so not even
`PlayerTraveling`); the level's URL is `Index.dx` (the URL stored in the map file: `LoadMap` keeps it for any option that starts with `load`) and its `TravelInfo` is the previous level's pair.

**URL forms** (`LocalTravel` of the installed `MapExit` strings, from the restarted Training): `04_NYC_UNATCOIsland.dx` loads; the level's `URL.Map` is `04_NYC_UNATCOIsland.dx`, portal empty, the log's `Browse:`/`LoadMap:` lines print it without `Name=`/`Class=`.
`15_area51_bunker.dx #bunker_start` (a space before the `#`) loads; `URL.Map` is `15_area51_bunker.dx ` **with the trailing space** and `URL.Portal` is `bunker_start`. Both arrive with the flags `{PlayerTraveling}`. (Which start spot the portal chose was not measured.)

**Mission-number lines** (`Current mission number is %d, next is %d`) seen in the session: `-1, -1` (the boot's own `Browse`), `-2, 0` (logo map to Combat), `0, 0` (Combat to Training and back), `0, 1` (`StartNewGame` to Island), `1, 1` (Island and HQ), `1, 2` (to Street),
`2, 2` (Street and Bar), `2, -1` (`open DX`), `-2, 0` (the menu's Training), `0, 4` (`04_NYC_UNATCOIsland.dx`).

**A scripted `open`** (`open DX` from Street, `UGameEngine::Exec`): `Browse: DX?Name=Player?Class=DeusEx.JCDentonMale`, `Current mission number is 2, next is -1`, **no** `Export travel` (`bItems` 0), and `Save\Current` emptied.

**The logo map's main menu.** The logo cinematic plays; a click in the window (the `Interpolating` state's `Fire`) opens `MenuMain` over it: `New Game`, `Save Game` (disabled), `Load Game`, `Settings`, `Training`, `Play Intro`, `Credits`, `Back to Game` (disabled), `Multiplayer`, `Exit`, with
`Mon Mar 19 12:06:14 2001 v1.112fm` under the buttons (screenshot `.work/travel/s2/dx-menu1.png`). The `Training` button starts `00_Training` at once, with no prompt: the text is the 74-record one above, and the level prints `UNATCO Training Facilities / Continental United States` (the startup text).
The engine's own `Shot` key does not work while the menu is up (UI screens grab the keyboard); the root window's `Ctrl-F9` does (`DeusExRootWindow.uc:143`).


## Play, steps 0 and 1

2026-10-21. What the [order](#proposed-implementation-order-for-play)'s steps 0 and 1 put into Play, where it is, what was checked against the measured original, and what still stops.

**The chain in Play.** The page's default start (no `debug=1`) starts DX.dx; Escape (User.ini's `Escape=ShowMainMenu`) opens `MenuMain`; the Training button (a click, or `winButtons[4]` through the menu driver)
runs `StartTrainingMission` (`ResetSkills`, `ResetPlayer(True)`, native 3012 `DeleteSaveGameFiles`, `SendPlayer`) on the VM; `PlayerPawn.ClientTravel` is `APlayerPawn::execClientTravel` (`script-travel.mjs`: `PreClientTravel`, then
`SetClientTravel`: the viewport's `TravelURL`/`TravelType`/`bTravelItems` and `PreTravel` on every actor). After the tick, `game.clientTravel()` runs the engine tick's travel step (`travel.mjs`): `Export travel for: <PlayerName>`,
`ExportTravel` (`travel-export.mjs`), `LastURL` cleaned, `FURL(LastURL, TravelURL, TravelType)` (`furl.mjs`), `Browse:` and `DDeusExGameEngine::Browse`'s decision (`travel-browse.mjs`, executed there). A `LoadMap` effect becomes a request
`{map, portal, url, options, travelInfo, lastURL}` that the simulation hands the page in its frame (`frame.travel`, `sim-session.mjs`); the level left does not tick again. The page's `loadMap(map, {travel})` builds the next session
(`hostOptions.travel = {arrival, lastURL}`, `sim-worker.mjs` `load`), whose startup is the cold LoadMap passes and then `SpawnPlayActor` with the arrival's portal and options: `DeusExGameInfo.Login`, the player's `TravelPreAccept`,
**the three-pass import** of the text (`travel-import.mjs`), the imported actors' `TravelPreAccept`, `AcceptInventory`, their `TravelPostAccept`, the player's, `PostLogin` (`script-player-login.mjs`).

| File | Role |
| --- | --- |
| `src/runtime/furl.mjs` | `FURL` for `Map`, `Map#Portal` and `?option` texts; `UnsupportedFurlForm` for the rest (a `.dx` suffix, a space before `#`, paths, hosts, a portal with options) |
| `src/runtime/travel-browse.mjs` | `DDeusExGameEngine::Browse` as a pure decision: effects `log`, `deleteSaveGameFiles`, `clearStartingNewGame`, `loadMap`, `boundary`; `GetNextMissionNumber`/`GetCurrentMissionNumber` (`test/travel-browse.test.mjs`: the branch table) |
| `src/runtime/travel-text.mjs` | the text's parser and formatter, `normalizeTravelText` (pointers by first appearance, instance numbers), `firstTravelTextDifference`, `travelTextOfDump` for the captures (`test/travel-text.test.mjs`) |
| `src/runtime/script-travel.mjs` | `SetClientTravel`, `ClientTravel`, native 3012 and Play's `Save\Current` store (`createSaveStore`; empty: nothing files a level yet) |
| `src/runtime/travel-export.mjs` | `ExportTravel` over `CPF_Travel` properties read from the retail class chain (the load graph's Class/Property records), the host `FlagBase` exported as `FlagBase`/`Flag*` objects |
| `src/runtime/travel.mjs` | the tick's travel step and Browse's execution; `TravelStop` names a branch that is not implemented |
| `src/runtime/travel-import.mjs` | `SpawnPlayActor`'s three passes and the flag store fill |
| `scripts/validate-travel.mjs`, `scripts/validate-travel-play.mjs` | the checks below (headless; the page in the browser) |

**One session per map.** In Play a level is one runtime: `createGame` binds a map's actors to a `ScriptRuntime`, and the page's `loadMap` builds the world, the GPU meshes and the HUD for it. So LoadMap of *another* map is the page's own map change
with the arrival's data (the same path the toolbar's map list uses), not the Stage 3 in-place reload (`game.reset()`, [LoadMap GC](script-loadmap-gc.md)), which stays what "Player start" means. What the original's LoadMap does that this does not model:
`NotifyLevelChange` and the old player's `DestroyActor` (tried: the frame that is still being drawn then finds the player's native heap objects freed), the collection of the previous level over one shared object registry (the arrival's object indices are the map's
open-capture seed, not the post-travel registry the original has: **unverified**, [the registry](object-index-captures.md)), the package load and unload lines, `Collecting garbage`/`Garbage:` and the brush tracker's lines. A session that does not travel
(`createGame` without `travel`: every validator and census session) keeps `TravelBoundary` at `ClientTravel` and `ClientTravelBoundary` at the tick's step; so do live replays (`game.liveReplay`), which stop at the original's level end as before
(Stage 5's `die1` still ends after tick 1931 in both). The page passes `travel`.

**What was checked against the measured original** (`node scripts/validate-travel.mjs`; the captures stay in `.work/travel`, outside Git; the browser path `node scripts/validate-travel-play.mjs`):

| Check | Result |
| --- | --- |
| Play's exported text for the logo-map player at the menu's Training button | **74 records equal** `s2/s5-training-menu` after normalization (pointers, instance numbers; no `AugmentationSystem`, the six flag-less lines, the skills and themes interleaved by the worklist) |
| the same ClientTravel with the augmentations in place (`LocalTravel 00_TrainingCombat` from the logo map) | **96 records equal** `r1/dx-to-combat` (`AugmentationSystem`, `AugLocs[6]=(AugCount=3)`, 21 augmentations, the flag chains) |
| Browse's branch and URL | `Current mission number is -2, next is 0`, `Attempting to get player`, wipe, `LoadMap: 00_Training?Name=Player?Class=DeusEx.JCDentonMale` |
| the arrival's flags | `{PlayerTraveling}` (expiration 0) before the first timer (the `SKTemp_*` flags are consumed by `RestoreSkillPoints`; this needed native 1112 `FlagBase.GetInt`: `XFlagBase::execGetInt` 0x10025790 -> `GetInt` 0x100244e0), `{M00_TRAINING_StartupText@1, M0MissionStart@1}` after it; no host-supplied marker (`beginFreshMission` runs only for a cold open) |
| Mission00.FirstFrame's effect | `UNATCOTroop2` is knocked out into `UNATCOTroopCarcass0` |
| the engine log | the 17 lines Play models (`Unloading: Package DX`, `Export travel for`, `Browse:`, `Doing load, not loadgame`, `Current mission number`, `Attempting to get player`, `LoadMap:`, `Game class is`, `Bringing Level`, `InitGame`, `Base Mutator`, `Spawned new mission script`, `Spawning new actor for Viewport`, `Login: Player`, `Possessed PlayerPawn`, `All inventory ... accepted`, `InitStateMachine`) are the measured log's, in its order (the `Unloading` line comes from the script's native 3012 for the menu and from Browse's own `DeleteSaveGameFiles` for the console `LocalTravel`: both measured) |
| the import | every line of the text is in the arrived player's own export; the arrival adds one line, `SkillWeaponPistol: CurrentLevel=1`: pass 2 writes only the lines a text has, so the imported pistol skill keeps what its `PreBeginPlay` set (`ResetSkills` had put the departing level to the class default 0, which the text omits), as the original's import does by the same rules |
| `RestartLevel` (`?restart`) | no `Export travel`; `LoadMap: 00_training?loadonly` (the level's `MapName`), `InitGame: ?loadonly`, `Login:` (no `Name=`), the new player has **no flag** at arrival or after the first timer, the nine modelled lines are the measured restart's |
| the page (its default start, worker mode) | a click on Training arrives in `00_Training` with "UNATCO Training Facilities / Continental United States" and the flags, carcass above; no runtime error |
| not regressed | the Stage 5 replays `cad1` and `key1` (Training, the host marker for a cold open), `die1` (Island, the level end); the validators of the touched code (console command, loadmap, mission timer, FlagBase iterators, triggers, player log/dump, player start); 685 unit tests |

**Facts found on the way.**

* `DeleteSaveGameFiles` releases the level package's loaders the first time it runs in a level (`Unloading: Package <level>`); in the menu path that is the script's native 3012, in `LocalTravel`'s it is Browse's own call, so the log line is one per level.
* `ColorThemeManager`, the themes, the skills and the augmentations are Actors (`extends Actor`, `bTravel` true), so the import spawns them; only `FlagBase` and the `Flag*` classes are non-Actors in the texts so far.
* An imported actor is spawned with the player as its Owner, so an imported `Augmentation`'s Owner is the player, not the manager that created it. Play's cold-login verification of the augmentation graph (`script-player-startup.mjs`) therefore takes `{imported}` and checks the shape without the cold defaults.
* The player keeps the objects `Login`'s `ResetPlayerToDefaults` made for every property the text does not carry (the menu's text has no `AugmentationSystem`, so the arrived player has a fresh one), and the replaced ones stay in the level as unreferenced actors, as in the original.
* The text's key is the player's name; `Login` takes `Name=Player` from the URL options the arrival passes (the cold login's options are empty, so a cold Play prints `Login: ` and a travel arrival `Login: Player`, as the original does).
* A property is written with the spelling of its name in the package's name table (`FlagName`, `FlagBase`, `flagHash`: the compiler keeps the first spelling of a name), which is what the measured texts show; no spelling table is needed.

**Still a named stop** (a thrown `TravelStop`, a `TravelBoundary` in a session without `travel`, or an unsupported-property error naming the class and property):

* every Browse branch but the wipe and `?restart`: travel within one mission (`PruneTravelActors`, `SaveCurrentLevel(-2)`, a filed level restored), `?loadgame=`, network URLs; a failed `LoadMap` (the retry with the old map's name);
* `FURL` forms other than `Map`, `Map#Portal`, `?options`: paths and hosts (the `.dx` suffix and the blank before `#` of the installed destinations are in since [step 5, second part](travel-transitions.md#the-url-forms-with-a-map-extension-and-a-blank));
* the travel text's property kinds that were not measured: vectors, rotators, dynamic arrays, strings with newlines, class properties (`UnsupportedTravelPropertyError`, `UnsupportedTravelImportError`); flags other than bool and int; **items are not verified** (step 2): the exporter and importer are generic over `CPF_Travel`, but only the no-item texts were compared;
* `DeleteSaveGameFiles` of a directory (save slots), `SaveGame` (native 3011), `LoadGame`, the other menu entries (Play Intro, Load Game, Credits; New Game is [step 2](#play-step-2-new-game-and-items)).

## Play, step 2: New Game and items

2026-10-21. The [order](#proposed-implementation-order-for-play)'s step 2: the New Game path through the original scripts and the player's carried state, checked against new captures of the original under
Wine. The path itself needed no change in the travel code: steps 0 and 1 had built the chain, and what was left was to drive it through the real screens and compare. Two bodies the item scenarios reached were
missing and are now in (below).

**The path in Play** (the default start, Escape, then a click on each control; `scripts/validate-travel-newgame-play.mjs`, and the headless `validate-travel-newgame.mjs` through the menu driver):

| Step | Script | What it leaves |
| --- | --- | --- |
| New Game | `MenuMain.winButtons[0]` -> `MenuUIWindow.ProcessMenuAction(MA_NewGame)` -> `StartNewGame()` (`MenuUIWindow.uc:673`) | `bAskedToTrain` is a `globalconfig` Bool and the installed `User.ini` has none: a fresh install is False, so the original asks first (`MenuUIMessageBoxWindow`, `MB_AskToTrain`: Yes is `StartTrainingMission`, No continues; the box was captured once with `set DeusEx.DeusExPlayer bAskedToTrain False`). The capture prefix's `User.ini` had it True (a previous Training click saved it) and went straight to the difficulty menu; Play asks |
| difficulty | `MenuSelectDifficulty.ProcessCustomMenuButton`: Easy 1.0, Medium 1.5, Hard 2.0, Realistic 4.0 -> `InvokeNewGameScreen` | `MenuScreenNewGame.SetDifficulty` |
| the screen | `MenuScreenNewGame` (`InitWindow`: `SaveSkillPoints`, `ResetToDefaults`, `CopySkills`): the real name (an edit window, "JC Denton" selected), the portrait arrows (`portraitIndex`), the skill list and Upgrade/Downgrade over local copies of the skills | nothing on the player until Start |
| Start Game | `ProcessAction("START")` -> `SaveSettings` (`ApplySkills`, `TruePlayerName`, `PlayerSkin`, `CombatDifficulty`) -> `ShowIntro(True)` (`AugmentationSystem.DeactivateAll`, `bStartNewGameAfterIntro`, `SendPlayer(Self, "00_Intro")`) | the tick's step: `Browse` `-2 -> 0` (wipe), the 96-record text |
| the intro | `00_Intro` (mission 98): `MissionIntro` (its first Timer's `InitStateMachine` deletes every flag and sets `PlayerTraveling` again; `FirstFrame` starts the `Intro` conversation with Bob Page and turns the sound down), the `CameraPoint` cinematic | the conversation ends with `Intro_Played`; `MissionIntro.Timer` calls `PostIntro` |
| Escape | the `Escape` binding -> `ShowMainMenu` on mission 98 (`DeusExPlayer.uc:6916`): `FLUSH`, `bIgnoreNextShowMenu = True`, `PostIntro` | the same call, early |
| `PostIntro` | `bStartNewGameAfterIntro`: `StartNewGame(strStartMap)` (`""`: `01_NYC_UNATCOIsland`): `ClearWindowStack`, `PlayerTraveling`, `SaveSkillPoints`, `ResetPlayer()` (a pistol, a prod and a medkit, each `Spawn` and `Frob(Self, None)`, `bInObjectBelt`), `DeleteSaveGameFiles()` (the script native: `Unloading: Package 00_Intro`), `bStartingNewGame`, `SendPlayer` | the tick's step: `Browse` `98 -> 1` (wipe), the 79-record text |
| the Island | `SpawnPlayActor`'s import (the player's `TravelPreAccept`, the items' `GiveTo`, `AcceptInventory`, `TravelPostAccept`, `PostLogin`), `Mission01`'s first Timer (`InitStateMachine`, `FirstFrame`: `PlayerTraveling` deleted, the startup text "Liberty Island, New York / UNATCO HQ" on the HUD, the `M01_NYC_UNATCOISLAND_StartupText` and `M1MissionStart` flags, goals and conversation history reset) | the starting belt: pistol 1, prod 2, medkit 3, key ring 0 |

**Measured** (2026-10-21, six launches of the installed game under Wine, `scripts/travel-probe.sh` with its new `key`, `type`, `click`, `move` and `follow:<file>` steps; captures in `.work/travel/nw0` to `nw5`, outside Git, each with the engine log of the session as `final.log`).
The menus were driven by real mouse clicks and typed characters (`dxinput`) on the 1280 x 720 viewport: a click on the logo map opens `MenuMain` (640, 360); New Game (641, 196); Easy, Medium, Hard, Realistic at (641, 287 / 323 / 359 / 395); Start Game (797, 565); the name edit is typed over
(`type`), the portrait's right arrow is (477, 489), the skill rows are 12 px lines from y 212 and Upgrade is (551, 516). Each level was frozen on arrival (`set LevelInfo bPlayersOnly True` typed before the travel: the class default carries into the next level, so its mission script never runs its first Timer),
`dump-flags-win` and `dump-travel-win` read the player's flags and the text the level kept, and the freeze was lifted for the first Timer where the scenario needed it. Escape is `key ESC` (`dxinput`'s name; `key Escape` is not a key and does nothing: the first attempt's intro stayed up for four minutes).

| Session | Scenario (tags) | What the original did |
| --- | --- | --- |
| `nw0` | A: defaults (Medium), Escape (`n1b`) | texts of 96 and 79 records; Island flags `{PlayerTraveling}` (default expiration 0), then `{M01_NYC_UNATCOISLAND_StartupText@2, M1MissionStart@2}` (default expiration 2); 33 modelled log lines |
| | B: Hard, portrait 2, Lockpicking and Computer raised, Escape (`n2`) | `PlayerSkin=2`, `CombatDifficulty=2.0`, the two skills `CurrentLevel=1`, `SKTemp_SkillPointsAvail=2075`, `SKTemp_SkillPointsTotal=5000` |
| | C: defaults, the intro left to end by itself (`n1`, `n3-natural-island`): about 137 s after the freeze was lifted | the Island's text has `LastConEndTime=413.335846` (the intro level's clock at the conversation's end; about 277 s of it were the freeze) and no `bIgnoreNextShowMenu`; `defaultFlagExpiration=99` in its flag store (the intro's `InitStateMachine` set it) |
| | D: the cheats on the Island (`n4`) | 142 records at the Street: `Credits=100000`, `SkillPointsTotal=115900`, all skills and augmentations, 36 `Image*` items, a `NanoKeyInfo`, a `DeusExNote`, a `DeusExGoal`; then 143 at the Airfield |
| `nw1` | E: Realistic, the name typed, portrait 1, Medicine raised, then `set` of item properties on the live objects, two keys, two notes, two goals (`n5`) | 109 and 109 records: `TruePlayerName=Test Agent`, `PlayerSkin=1`, `CombatDifficulty=4.0`, `ClipCount=3`, `ModBaseAccuracy=0.250000`, `bHasLaser=True`, `AmmoAmount=17`, `NumCopies=3` |
| `nw3` | G: A again with the "train first?" box (`set DeusEx.DeusExPlayer bAskedToTrain False` typed first), then Escape twice on the Island (`n7`) | the box "Training Mission" with Yes and No (`n7-train-box.png`; Play's is the same box), No at (743, 414) goes on to the difficulty screen; the texts and flags of A; the first Escape on the Island opens nothing, the second `MenuMain` (the session's `final.log` stops at the first Export travel: the 8 KB flush, so no log comparison for G) |
| `nw4` | H: the console's `StartNewGame 01_NYC_UNATCOIsland` from Training Combat (the logo map's `LocalTravel 00_TrainingCombat`, 8 s there) (`n8`) | the Island's 79-record text equal to the first captures' `s1/n1-island-frozen`; flags `{PlayerTraveling}` with default expiration 1, then the Island's two flags |
| `nw5` | I: MeetPaul played with Enter (the player placed 100 units in front of Paul after `bCheatsEnabled`, `ghost`, `set Location`, `walk`, `set ViewRotation`; Enter every 4.5 s for 3 min), then `LocalTravel 02_NYC_Street` and `03_NYC_Airfield` (`n9`) | 127 records at the Street: `ConHistory` (`conOwnerName=Paul Denton`, `strLocation=NYC - Liberty Island`, `firstEvent`, `lastEvent`) with 16 `ConHistoryEvent`s, three `DeusExGoal`s, `Image01_LibertyIsland`, the sniper rifle (`WeaponRifle`, `Ammo3006`) at belt 4, `LastConEndTime`, `MeetPaul_Played@2`; 109 at the Airfield (history and goals reset by `Mission02.FirstFrame`) |
| `nw2` | F: the soda can, the liquor bottle and the crowbar picked up by placing the player where the view trace selects each (`ghost`, `set JCDentonMale Location`, `walk`, `set JCDentonMale ViewRotation`, `ParseRightClick`) (`n6`) | 107 and 109 records: `invSlots[0..3]=1`, `invPosX`/`invPosY` (0,0), (1,0), (2,0), the new items at belt 4, 5, 6 |

**What the captures showed** (each of these is in Play and checked below):

* **`bIgnoreNextShowMenu=True` travels.** It is a `travel` Bool set by the Escape's `ShowMainMenu` on the intro map; the text for the Island carries it after Escape (`n1b`, `n2`, `n4`, `n5`, `n6`) and not after the intro's own end. Its reader is the next `ShowMainMenu`, which clears it and returns at once (`DeusExPlayer.uc:6926`): on the original's Island the first Escape opens nothing (`nw3/n7-esc1.png`: the game view) and the second opens `MenuMain` over it with Save Game and Back to Game enabled (`n7-esc2.png`).
* **`saveTime` and `LastConEndTime` hold the run's own frame times.** `saveTime` is the sum of `UpdateTimePlayed` over the ticks the player spent in `PlayerWalking`, `PlayerFlying`, `PlayerSwimming` or `Conversation` since `ResetPlayer` zeroed it (`DeusExPlayer.uc:3710, 3754, 3890, 7435`): the original's text has `saveTime=0.006523` and `0.007809`, one tick at its own frame rate; Play's fixed step
  writes 1/60. A default of 0 is not written, so *whether* the property is there is the behavior and the value is the run's: `normalizeTravelText(text, {times: true})` masks the values of `saveTime` and `LastConEndTime` (`TIME_PROPERTIES`) and nothing else.
* **The frozen intro's player is walking, not paralyzed.** `Paralyzed, Letterbox` comes from `CameraPoint.Idle`'s state code (`CameraPoint.uc:117`), which a frozen level never runs; the player keeps `PlayerWalking` and accumulates `saveTime`. The Escape's `PostIntro` therefore exports a `saveTime`; with the level running (an Escape after the first Timer) the player is `Paralyzed` and writes none.
* **`MissionScript.InitStateMachine` is the first Timer's, not the load's.** A frozen level never logs `**** InitStateMachine()` (no such line in the Escape captures) and its mission script has no `Player` or `flags` yet: `MissionIntro.PreTravel` logs `ScriptWarning ... Accessed None` (`MissionIntro.uc` `Player.SetInstantSoundVolume`) in all three Escape captures and not in the natural end, and the arrival's flags are exactly what the text carried: `{PlayerTraveling}` with default expiration 0.
* **Mission01's start**: the HUD shows "Liberty Island, New York / UNATCO HQ" (the startup text, captured in `n5-startup.png` and in Play's page) and the belt reads 10MM AMMO / PISTOL, CHARGER / PROD, MEDKIT, KEY RING.
* **`ghost` is a cheat.** F's first two attempts typed `ghost`, `set JCDentonMale Location`, `walk` without `bCheatsEnabled`: `ghost` returned at once, `set` moved a hashed pawn, and the original's `LoadMap` died on `JCDentonMale ... moved without proper hashing` (`FCollisionHash::RemoveActor`, `ULevel::DestroyActor`). With `set DeusEx.JCDentonMale bCheatsEnabled True` first the placement is the live scenes' and the travel is clean.

**New in Play for step 2** (the rest of the chain was steps 0 and 1's):

* `ScriptRuntime.scriptConsoleExec` imports a `Name` parameter (`UNameProperty::ImportText 0x101674d0`: `ReadToken(0x400)`, `FName`; the body `set` already used) and a `String` parameter takes the whole remaining text, quotes included (`UStrProperty::ImportText 0x10167980`, already there; measured: `GiveNanoKey TestKeyA "Test key A"` leaves `Description="Test key A"`) ([console exec](script-console-exec.md)). `GiveNanoKey` and `GoalAdd` are the exec functions with a Name parameter that the scenarios reached first.
* `SpawnPlayActor`'s pass 1 constructs any other travelling class as `StaticConstructObject(Class, Outer = player, NAME_None, 0, NULL)`, which is the script's `new(Self) class'X'` (`ScriptRuntime.newObject`): `DeusExNote`, `DeusExGoal` and `NanoKeyInfo`, the Object subclasses a player's notes, goals and keys are. The two native conversation-history classes, `ConSys.ConHistory` and `ConHistoryEvent`, are built as the `CreateHistoryObject` and `CreateHistoryEvent` natives build them (`constructHistoryObject`, factored out of `script-conplay-live.mjs`; their vtables and the `DConHistory::Destroy` chain), with Outer = the player. Any other Object class the runtime has no constructor for stops the arrival by name.
* `menu-driver.mjs` gained `pressField`, `pressActionKey` and `center` (where a click on a control lands), `settings-probe.mjs` the `center` step, for the screens' own controls; `scripts/travel-probe.sh` and `travel-step.sh` the steps above.

**What was checked** (`node scripts/validate-travel-newgame.mjs`, one process per scenario, A to I, about 20 minutes; the page: `node scripts/validate-travel-newgame-play.mjs` and `--natural`). Every row compares Play with the captures after normalization (pointers by first appearance, instance numbers, and the two time properties' values):

| Check | Result |
| --- | --- |
| the text at Start Game, for `00_Intro` | **96 records equal** in A, B, C, D, E, F (Medium, Hard, Realistic, a typed name, a portrait, raised skills: `TruePlayerName`, `PlayerSkin`, `CombatDifficulty`, the skill levels, the `SKTemp_SkillPoints*` flags) |
| the text at the Escape or the intro's end, for the Island | **79 records equal** in all six (the starting inventory `MedKit -> WeaponProd -> AmmoBattery -> WeaponPistol -> Ammo10mm -> NanoKeyRing`, belt 3, 2, 1, 0; `bIgnoreNextShowMenu` after Escape, `LastConEndTime` and `defaultFlagExpiration=99` after the end; `saveTime` present exactly where the original's is) |
| the arrival flags | `{PlayerTraveling@0}` with default expiration 0 (Escape) before the first Timer; `{M01_NYC_UNATCOISLAND_StartupText@2, M1MissionStart@2}` with default expiration 2 after it (`FirstFrame` ran because the text carried `PlayerTraveling`: no host marker); the intro's own flags `{PlayerTraveling}` |
| the engine log | the 33 modelled lines of A, B, E, F (34 in C: the intro's `InitStateMachine` too) are the captures', in order: `Export travel` ... `All inventory from Player is accepted` for the intro, `Unloading: Package 00_Intro`, `Export travel`, `Current mission number is 98, next is 1`, the Island's startup, its `InitStateMachine` |
| the intro's own end | Play's conversation ends at 135.0 s of level time and calls `PostIntro` through `MissionIntro.Timer` (the original: about 137 s, polled every 2 to 4 s); the text equals the capture's |
| items, the text at the Street (`LocalTravel 02_NYC_Street`) | **142 (D), 109 (E), 107 (F), 127 (I) records equal**: credits, skills, augmentations, images, `NanoKeyInfo`, `DeusExNote`, `DeusExGoal`, non-default weapon, ammo and pickup properties, the real pickups' `invSlots`, `invPosX/Y` and belt positions; in I the conversation's `ConHistory` with its 16 `ConHistoryEvent`s, three goals, an image and the sniper rifle the choice transferred |
| the fixed point | the text at the Airfield, exported by the player that *imported* the Street's, equals the original's own (143, 109, 109, 109 records, the goals gone because `Mission02.FirstFrame` resets them, and the imported conversation history with them: `ResetConversationHistory` deleted the imported objects through `DConHistory::Destroy`); and the Street arrival's export equals the imported text outside the flag records (the `SKTemp_*` flags are consumed by `RestoreSkillPoints`) |
| the console `StartNewGame` (H) | the Island's text equals `nw4/n8` and the first captures' `s1/n1-island-frozen` (79 records, the Training Combat player's history: default expiration 1), the Combat arrival flags and the Island's flags equal |
| the train box and the Escape on the Island (G) | the same texts and flags as A through the box path; Play's first Escape on the Island opens nothing and clears `bIgnoreNextShowMenu`, the second opens `MenuMain`, as `nw3` shows |
| the page (the default start, worker mode) | real clicks on New Game, No, Medium and Start Game; the intro plays (letterbox, subtitles); Escape, or `--natural` the intro's own end, then the Island with the belt and the flags above; no runtime error |
| not regressed | `validate-travel` (A, B, C), 691 unit tests, the Stage 5 replays and the intro checks listed under "Verified not regressed" below |

**Property kinds the measured texts carry**, each now checked against one: Int (`Credits`, `SkillPointsTotal`, `invPosX`, `NumCopies`, `ClipCount`, `AmmoAmount`), Float (`CombatDifficulty`, `ModBaseAccuracy`, `saveTime`, `LastConEndTime`), Bool (`bIgnoreNextShowMenu`, `bInObjectBelt`, `bHasLaser`, `bHasIt`), Byte and enum (`flagType`), Byte array (`invSlots[i]=1`), Name (`goalName`, `KeyID`), Str
(`TruePlayerName=Test Agent`, `Text="Goal B"`, `Description="Key two"`, note texts: written as the console took them, quotes included), Object and object arrays (`Inventory`, `FirstGoal`, `FirstImage`, `hashTable[i]`), Struct array (`AugLocs[i]=(AugCount=n)`).
(`conOwnerName=Paul Denton`, `strLocation=NYC - Liberty Island`, the speech strings: scenario I.) A survey of every `CPF_Travel` property of the shipped DeusEx, Engine and Extension classes shows these are all but three: a `Name[]` (`AugmentationCannister.AddAugs`), the vector and rotator values of `FlagVector`/`FlagRotator`, and strings that hold a newline (the `\` rule is read from the exporter, not seen).
Those three stay named stops (below).

**Still a named stop after step 2:**

* the three property kinds above; weapons with mods, a carried decoration, charged pickups' state and an item with a `Charge` the scenarios did not change (the generic kinds they use are covered; the classes were not exercised);
* every Browse branch but the wipe and `?restart`: same-mission travel and visited-map restoration are step 3, loadgame is step 4; the other menu entries (Play Intro, Load Game, Credits);
* `bAskedToTrain` is saved by `SaveConfig` as the original does, and since 2026-10-22 the default start keeps it across page loads ([configuration persistence](config-persistence.md)): a reloaded page asks "train first?" once.

**Verified not regressed** (2026-10-21, at the step's last commit): 691 unit tests; `validate-travel` (A, B, C) and `validate-travel-play`; the validators of the code the step touched (`--filter console`: 4, `native-config`: 2, `class-import`, `script-config`, `window-list`: 16, `window-typed`: 3, `gc-underline`, `settings`: 2); the Stage 5 live replays `cad1` and `key1` (Training) and `cmb1` and `die1`
(Island, the level end after tick 1931 in both); and the intro's gate row 4.5.7 (`validate-stage4-acceptance.mjs --only '^4\.5\.7$'`, 214 s: the intro's CameraPoint shots and `native-find-base`).

## Play, step 3: visited maps restored

2026-10-22. The [order](#proposed-implementation-order-for-play)'s step 3: within one mission, leaving a map files the level in `Save\Current` and entering a filed map restores it, as `DDeusExGameEngine::Browse` and `SaveCurrentLevel(-2)` do. The file is the original's own
format ([above](#the-dxs-a-saved-levels-package)), read exactly and written as Play's interim (what differs is listed); every file access goes through the [save-directory](save-directory.md) interface, so a browser store can replace the in-memory one.

**What runs**

| Piece | Module | Original |
| --- | --- | --- |
| `Browse`'s same-mission branch returns the effects (`pruneTravelActors`, `saveCurrentLevel`, `loadMap` with the saved URL and file) | `travel-browse.mjs`, `travel.mjs` | `0x10011716..` |
| `PruneTravelActors` | `travel-save.mjs` | `0x1000f9b0` |
| `SaveCurrentLevel(-2)`: `LevelAction = 2`, the log lines, `CleanupDestroyed(1)`, the package written to `<MapName>.dxs`, every mover's `SavedPos` reset | `travel-save.mjs`, `level-save.mjs` | `0x1000fac0` |
| the file: `ByteWriter`, `package-write` (names, imports, exports), `tagged-write` (the tag grammar), `model-transcode` | `src/runtime/*.mjs` | `UObject::SavePackage` |
| the store: `Current` of the save directory (`createSaveStore`), the page's and the worker's `hostSaveDirectory()` | `script-travel.mjs`, `save-directory.mjs` | `GFileManager` |
| the warm `LoadMap` of a filed level: the saved actors' properties and state frames, the pawn list, the AI event manager (Rust `ai_load`), `TimeSeconds`, `PostPostBeginPlay`, the partition; no begin-play pass | `script-doors.mjs` `warmLoadMap`, `game.mjs` `restore`, `restore-asset.mjs` | `LoadMap` `0x1038d6f6` |
| `GameInfo.Login` re-possesses the saved pawn (viewport and player unlinked, the pawn on `Level.PawnList`, moved to the start spot) | the real script | `Login` |
| the page: the worker restores the file, the page loads the same map's geometry and does **not** run Player start over it (`resetCamera({keepLevel})`, worker `restoreView`); `game.reset` of a restored level stops by name | `main.mjs`, `sim-worker.mjs`, `game.mjs` | |
| Teleporter portals (`Map#Portal`: `Teleporter.Touch` -> `SendPlayer`; `Login`'s `FindPlayerStart(Portal)`), `MapExit` direct and with `bPlayTransition` (`Interpolating` along the `InterpolationPoint`s, `InterpolateEnd` -> `SendPlayer`) | the real scripts and natives | |

**Checked.** Against the measured original (`.work/travel`, outside Git):

* `scripts/validate-travel-restore.mjs`, headless: **T** the Training pair (the measured `s1`/`s3` legs), **I** the Island and HQ (`rt1`): `Current`'s listing after each leg and after a mission change, the log of the save and the restore line for line (the lines Play models, in order), no begin-play line, the markers
  (a destroyed troop stays destroyed, the summoned item, a moved mover, the clock past the saved one, 63 of 63 NPCs in their saved state 1.5 s later), exactly one player pawn; **P** the Teleporters of the Island/HQ pair (`Teleporter3` -> `Inside_UN_HQ`, `Teleporter2` -> `tunnel_drop_nyc` in the restored Island: the player arrives at the
  destination teleporter); **X** `02_NYC_Street`'s `MapExit0` -> `02_NYC_Warehouse#ToRoofTop` and the way back through `MapExit1` (the Street restored, the player at `FromRoofTop`), and `03_NYC_UNATCOIsland`'s `bPlayTransition` exit (the camera path runs 940 ticks, `Browse` files the Island, the arrival walks); **A** the AI manager's `ai_load(ai_snapshot())` after 3 s of the Street.
* `scripts/validate-level-save.mjs`: every `Model`, `Polys`, `LevelSummary` and AI event payload of the 8 measured saved levels (204 + 204 + 8 + 1,502) writes back to the original's bytes.
* The round trip: a measured `.dxs` restored, saved by Play and restored again gives the same level on 611,534 property values (13 differences, each explained: `SavedPos` reset by the save, `Login`'s counters, what `PruneTravelActors` nulled, one animation field); `scripts/probe-roundtrip.mjs` (a scratch probe).
* `scripts/validate-travel-restore-play.mjs` in headless Chromium, worker mode: the default start, Escape, the Training button or New Game, then `LocalTravel` to the other map and back: no runtime error, the markers (troops destroyed, the summoned item), one player pawn, the same items under the same names (a carcass's
  inventory is spawned by its begin play, so a reload shows as new names), **no begin-play line in the restored level's log**, the tracked movers' vertices where they were saved (one mover placed up before the leave: 25 movers in the Training), a drawn scene. It found that the page's Player start (`resetCamera`, run after every load) had cold-reloaded the restored level from its file and run begin play over it; the headless
  validator cannot see that, the page check can.
* The AI manager's snapshot panicked on `02_NYC_Street` once receivers held a best sender (an actor handle indexed as an ordinal): fixed, and `validate-event-manager` (which checks the live manager against the original) and the live replay `cmb1` (900 ticks, 1,571 AI events) still pass.
* `npm test` (756), `validate-travel`, `validate-travel-newgame`, `validate-travel-play`, `validate-travel-newgame-play`, `validate-save-directory`, `validate-loadmap-gc` (its expectation now names the level's package after the map: the record is named for the map so a saved level's outer is right), `validate-event-manager`, `validate-ai-visibility*`;
  the Stage 5 rows `5.1.1`, `5.1.5` and `5.4.1` (`node scripts/validate-stage5-acceptance.mjs --only '^5\.(1\.1|1\.5|4\.1) ' --jobs 2`: the live replays `cbr1`, `cmb1`, `cmb2`, `dlk1`, `cmb5` equal and "every criterion passes"): map travel moved no replay.

**Interim, unverified or not done** (each stops or is labelled where it is):

* **Play's file is not the original's byte for byte**: the order of exports, names and imports (the original's is `GObjObjects` and name-table order, which a Play session does not reproduce: Unresolved 10) and the GUID. Everything the validators above can read is the original's.
* **The original loads Play's file** (2026-10-22, `.work/travel/pw1`, `pw2`): the original under Wine ran `StartNewGame 01_NYC_UNATCOIsland`, `LocalTravel 01_NYC_UNATCOHQ`, then `scripts/travel-probe.sh`'s `putcurrent` put a Play-written `01_NYC_UNATCOIsland.dxs` (a Play Island with its ten troops
  killed and a Candybar summoned, 8,024,843 bytes) over the original's file in `Save\Current`, and `LocalTravel 01_NYC_UNATCOIsland` restored it. **First run (`pw1`): the original stopped at `Candybar 01_NYC_UNATCOIsland.Candybar2: Serial size mismatch: Got 35, Expected 120`** (the name flags above; fixed in `package-write.mjs`,
  with a unit test). **Second run (`pw2`): the original restores the level**: the log is the original's own restore sequence line for line (`LoadMap: ..\Save\Current\...`, the `Type mismatch in Region of GameReplicationInfo` warning and its skip, `Collecting garbage`, `Spawning new actor for Viewport`, `Login: Player`,
  `Possessed PlayerPawn: JCDentonMale 01_NYC_UNATCOIsland.JCDentonMale0` (the pawn Play saved), `All inventory from Player is accepted`, `Spawned new mission script`, `InitStateMachine()`, and none of `Game class is`, `Bringing Level`, `InitGame`); the restored level holds no `UNATCOTroop` actor (four carcasses), `Candybar0`..`Candybar3`
  (Play's four) and exactly one `JCDentonMale` with its viewport. Only that one file and that one scenario were tried: whole-level equality of the original's restored actors and Play's (properties, states) was not compared, and the HQ leg's `Save` time (34.96 ms) is the original's own.
* **Registry indices of a restored level are modeled**, not measured: each restored object's hash slot is `0x100000 + export index` and the player's index is modeled (labelled in `script-doors.mjs` and `script-runtime.mjs`). They feed the sound channel ids of a restored level's speakers too (2026-10-23, [chains](stage-6-chains.md): `soundObjectIndex` source `restored`; one sample in the original shows no constant offset to the fresh numbering). They are not read by anything a restore compares, and a replay of a restored level would need the original's `GObjObjects` (`rt1`'s `*.gobjects.txt` has them).
* The `Outer` of a restored script object is the level package stand-in; non-`ScriptedPawn` pawns (`GeneratorScout`) tick after a restore but their spawn details are not compared.
* **Not in a restored file or level**: `Flag*` objects and the player's notes, goals, logs and images as save-slot content (a file with a `FlagBase` stops by name: `restoring a saved game's flag store is travel step 4`), `LoadGame`/`SaveGame` slots, `GetSaveInfo` snapshots: step 4.
* **Player start** (`game.reset`) of a restored level stops by name; the page's own `Player start` button after a restore is the same stop.
* The `MapExit` and Teleporter paths were run, not measured against the original (`rt1` used `LocalTravel`); which start spot a `Map#Portal` picks when two teleporters share a tag is still unread (Unresolved 1).
* A `.dxs` of a level whose actors use a class property tag, array tag or struct form the reader has not met stops by name (`script-map-properties.mjs`); the three loaded forms and the type-mismatch skip are the ones the measured files use.

## Play, step 4: saving

2026-10-22. The [order](#proposed-implementation-order-for-play)'s step 4, save side: `SaveGame`, the Save Game screen, QuickSave, `SAVEGAME n` and `DELETEGAME n`/`DeleteGame` write and delete slots in the original's format ([the trace](#savegame-in-full)); the page's storage keeps them
([save storage](save-storage.md#writing-a-save)); the Load Game screen lists them with their pictures. Loading a slot is the other half of step 4 (the load side).

**What runs**

| Piece | Module | Original |
| --- | --- | --- |
| native 3011 `SaveGame` (index, optional description), native 3012 with a slot directory | `script-travel.mjs` -> `game-save.mjs` | `execSaveGame` `0x10014830`, `DDeusExGameEngine::SaveGame` `0x1000ef10`, `DeleteSaveGameFiles` `0x10010360` |
| the console's `SAVEGAME n` / `DELETEGAME n` | `script-console-command.mjs` `engineExec` (the keyword claim, a digit next) | `DDeusExGameEngine::Exec` `0x1000ed70`, `DeleteGame` `0x10010710` |
| `QuickSave` (the exec function), the Save Game screen's `PerformSave`, its edit control, overwrite and low-space boxes | the original scripts | `DeusExPlayer.uc:889`, `MenuScreenSaveGame.uc` |
| `Object.GetConfig` (the preview's `GenerateNewSnapShot`) | `script-runtime.mjs` (by name) | `UObject::execGetConfig` `0x1013e4e0` |
| `SaveInfo.dxs` | `save-info-write.mjs` | `SavePackage` of the `saveInfo` package |
| the level with the player and its FlagBase | `travel-save.mjs` `saveCurrentLevel(index)`, `level-save.mjs` (`FlagBase`/`Flag*` objects from the host store) | `SaveCurrentLevel` `0x1000fac0` without `PruneTravelActors` |
| the picture | `script-window-host.mjs` `requestForSave`, `main.mjs` (frame keeper, `snapshotGrey`), `sim-worker.mjs` | `XRootWindow::GenerateSnapshot` `0x10039410` |
| the slot in storage | `save-sink.mjs` -> `main.mjs` `keepSimSave` -> `save-persistence.mjs` `commitSlot` -> `save-store.mjs` `replaceDir` | `GFileManager` |

**Checked**

* `SaveInfo.dxs`: `test/save-info-write.test.mjs` and `node scripts/validate-save-info-corpus.mjs`: given the original's GUID, time, pixels, names and the two process-history orders, the writer produces **every original file measured byte for byte** (41 slots of other players' games, `.work/internet-saves`: 34,562..34,614 bytes; the Wine session's own Save0077 and, from the capture `wa5`, its Save0005, Save0006 (cheats on) and QuickSave; the desktop game's two of 2026-09). What the 41 added to the three: the Texture is always 256 x 128 (USize/VSize, UBits 8/VBits 7, UClamp/VClamp the same) with one P8 mip; the **picture is the top-left 160 x 120 and every byte outside it is 0**
  (`GenerateSnapshot` rounds the snapshot size up to powers of two and writes only the picture's box; the texture is 256 x 128, the *picture* 160 x 120); the Palette is the grey ramp in all 41; a time field of 0 is not stored and its name is not in the table (4 files have 32 names, one without `Hour`, three without `Second`); no file has `bCheatsEnabled`;
  the Texture/Palette/`MyDeusExSaveInfo` names and the Texture/Palette exports come in several orders (above): process history.
* The FlagBase: `scripts/validate-save-game.mjs --only F` puts the flags of five real saves (the desktop game's Training save: 15 flags, and four of the internet corpus: 24, 114, 277, 294) into Play's flag store and saves: `hashTable` buckets, chain order, `flagHash`, `expiration`, values and `defaultFlagExpiration` equal the original's flag by flag.
* The slot: `--only S`: `SaveInfo.dxs` + the byte-for-byte copies of Current's `*.dxs` with **their file times** + the live level; Current unchanged; `SavedPos` reset; the engine log is the measured SaveGame 77 sequence line for line (two warnings on the first save of a process, `Unloading`, `Save=`, `Moving`, tracker, `Save=`, `Moving`, tracker); a new slot is the largest number + 1 (`Save0008` after `Save0007`);
  a slot saved over is replaced whole (a stale file goes); QuickSave is `Save\QuickSave` with `DirectoryIndex -1` and "Quick Save"; `DeleteGame 7` removes the directory; a `SAVEGAME` with no number is claimed and does nothing; a `SaveInfo.dxs` in Current (after a load) is written over, not duplicated; the sink sees the slot whole, `SaveInfo.dxs` last.
  `--only L` replays the measured s1 session (Island, HQ, the Island restored, `SaveGame 77`): the slot's files and the SaveInfo equal the original's listing and fields. This found a real stop: a save in a restored level died in `CleanupDestroyed` on the player's bare FlagBase store (fixed: `script-level-collection.mjs` `isValid`).
* The screen: `--only U`: the Save Game screen through the menu driver: the new-save row, SAVE, the overwrite box (No keeps the slot, Yes replaces it), the low-disk-space box with 50 MB free (nothing is written).
* The page: `browser-tests/save-game.spec.mjs` (Chromium new headless, worker mode, the default start): Esc -> Save Game on `00_Training` writes `Save0001` into IndexedDB (SaveInfo with the Description, MissionLocation, MapName and a **lit picture of the frame**, the level file with `JCDentonMale`, `FlagBase`, the managers), a second save named by typing over the selection and Enter
  (`Save0002`, "My first name"), a save over `Save0001` through the overwrite box, the Load Game screen listing both with their info, the Quick Save key (`QuickSave`, -1, "Quick Save"), Delete Game through its box (`Save0001` gone from the storage), and a refused write (a `QuotaExceededError` on the bytes): the game goes on, the toast and the Saves window name it, the listing is the old one, and the next save is kept.
* `npm test` (821); `validate-level-save`, `validate-travel`, `validate-travel-restore`, `validate-travel-restore-play`, `validate-travel-play`, `validate-travel-newgame-play`, `validate-save-directory`, `validate-save-snapshot`, `validate-console-command` after the change (the two that read the Wine prefix's `Save` folder fail while a probe has Play's slots in it, and pass with the folder restored); the Stage 5 rows of the code touched were not rerun (see below).

**Against the original's own files, the same moment (`wa5`, Wine, 2026-10-22; `node scripts/validate-save-game.mjs --only W`)**

A fresh `00_Training` in the original (the proven opening: `set DeusEx.JCDentonMale bCheatsEnabled True`, `set LevelInfo bPlayersOnly True`, `LocalTravel 00_Training`, both set back), `SaveGame 5`, the cheat flag on and `SaveGame 6`, off again, 60 s later `QuickSave`, then `DeleteGame 5`; Play does the same in a headless session with the clock of the capture (the delete is `--only S`'s: the original's removed the directory `Save0005` and its files and touched no other slot, as Play's does). `scripts/save-info-diff.mjs` places every differing byte in a field:
the package GUID (16 bytes, new for every package), `Texture.InternalTime` (8, `appSeconds()` of the texture's making), the picture (19,124 bytes: the generator's gradient, not the original's frame), `saveTime` (1) and, where the clock moved, `Minute` and `Second` (1 each): **nothing else**.
The files have the same size (34,563, 34,585, 34,563) once Play's file is written in the original's two orders, the name tail and the export order (process history, above); Description, MissionLocation, MapName, DirectoryIndex, saveCount and bCheatsEnabled are equal, Play's `saveTime` is `ftol` of its own player's value and the original's lies between its two readings, and the slot's files are the original's (`00_training.dxs`, `SaveInfo.dxs`).

**The original loads Play's slots (`wc1`, `wc2`, Wine, 2026-10-22; `node scripts/validate-save-game.mjs --only C`)**

`scripts/make-play-saves.mjs` makes slots in headless Play sessions and records the live player at each save (`facts-*.json`): `Save0010` (`00_Training` by the menu's Training button, no cheats), `Save0011` (the Island by New Game, then the cheat lines of the travel captures: credits, skills, augmentations, images, a key, a note, a goal; 42 items; **bCheatsEnabled on**), `QuickSave` (the Island, the Quick Save key before the cheats; 6 items) and `Save0012` (the Island, `LocalTravel 01_NYC_UNATCOHQ`, `SaveGame` in HQ: HQ live, the Island copied from Current).
`travel-probe.sh` puts each into the prefix's `Save` (`putslot`; the folder is backed up before and put back after, `DX_SAVE_BACKUP`) and the original runs `LoadGame N` (`QuickLoad` and its box for the Quick Save: the console line `LoadGame -1` is not typed by `dxinput`, `wc1`'s attempt loaded nothing and is not counted). Each loaded player is dumped from the live process (`dump-actor-win`, the flag base and the items by owner):

| slot | what the original's loaded player holds, against what Play saved |
| --- | --- |
| `Save0010`, Training | Location, Rotation, ViewRotation, Health (3), Credits 500, skill points, Energy, CombatDifficulty, `saveCount` 1 (= the SaveInfo's, one more than the live value at the call), `NanoKeyRing2` owned by the player, the FlagBase with its two flags in the buckets Play's hash gives (34, 60), expiration 1 |
| `Save0011`, Island (`wc1`, and again `wc2` with the final writer's SaveInfo) | the same fields (credits 100000, skill points 30550, 42 of 42 items, 3 flags); `saveCount` 2 |
| `QuickSave`, Island (`wc2`, through the box) | the same fields as Play had at the key (credits 500, skill points 5000, 6 of 6 items, 3 flags, `saveCount` 1) |
| `Save0012`, HQ (`wc1`) | Location, Rotation, ViewRotation, stats, 5 flags (HQ's and the Island's startup texts included); the weapons dumped (2 of 2) |

* **The log** of the whole session is the loaded-game sequence above three times (`Browse: Index.dx?loadgame=N`, `Doing loadgame, not load`, `LoadMap: ..\Save\Current\<map>.dxs?load?loadonly?loadgame`, `Login: Player`, `Possessed PlayerPawn: JCDentonMale <map>.JCDentonMale0`), then `LocalTravel 01_NYC_UNATCOIsland` from HQ: the `LoadMap` of `Save\Current\01_NYC_UNATCOIsland.dxs` is the Island that `Save0012` held (copied to Current by the load), **its 10 troops back** (the names Play's file has). No warning or error but the two `GameReplicationInfo` lines every restore prints.
* **`bCheatsEnabled` is not a saved property.** The original's own level file saved with the cheats on (`wa6`) has the same 63 tags on the player as the one with them off; Play's has none either; the loaded player has the cheats **off** (`Save0011` was saved with them on), while the SaveInfo keeps the flag (the Load Game screen's cheat marker). The load side must not restore the flag from the file or the SaveInfo.
* **The Island slots load into the Paul conversation** (`wc2-quickload-box.png`: the weapon choice on screen, Escape ends it and the player stands with the pistol, prod, medkit, key ring and the sniper rifle Paul gives): the pawn's `Rotation.Yaw` at the dumps (3935, 3825, 4461) is the conversation's turn, `ViewRotation` is the saved one (-7040) throughout. Whether Play's own save was taken with that conversation running is not recorded (unverified).
* `saveTime` after a load reads 100..730 s at dumps some minutes later (saved: 8.5 and 19.5 s), consistent with the saved value continuing, not measured as such; the QuickLoad box (`ConfirmQuickLoad`, Yes) works while a conversation is on screen only after Escape ended it; a loaded level's `URL.Map` is the bare map name (`01_NYC_UNATCOIsland`), which is why `arrive:...[.]dxs$` of `wc1` timed out at 150 s on every `LoadGame` (the loads had happened).
* Not compared: the HQ and Quick Save dumps cover the kinds of item they dumped (HQ: weapons only), the Training dump has no augmentations or skills, and nothing was compared past the first minutes of play after a load; Play loading these files is the other half of step 4.

**Interim, unverified or not done**

* **The picture** is the page's 8-bit canvas after the display ramp (the CRT effect included when it is on), kept while a window holds the mouse or a save waits, and taken from the frame drawn after the request when none was kept (one frame later than the original's `ReadPixels` of the 16-bit surface); with no answer in 4 s the slot is committed with a black picture. The framebuffer copy that keeps a frame while a window is open was not timed.
* **The registry**: the `saveInfo` package, `MyDeusExSaveInfo`, the Texture and the Palette (and the temporary `XGameDirectory` of a new slot) take no slots in Play's registry model. The Texture's number is the Texture class's name counter; the Palette takes the same number (the three measured sets did, 44 of 44).
* **The name table's tail and the Texture/Palette export order** are the original process's history (FName and GObjObjects indices): Play writes Texture, Palette, `MyDeusExSaveInfo` and the Texture first (Save0077, a first save). `bCheatsEnabled` (measured in the Wine session's Save0006, cheats on) is the last tag of the SaveInfo, and its name sits between `Snapshot` and `DirectoryIndex` (34 names, the others 33); the order of the three object names and of the exports changes from save to save of one process (wa5, one process: the name tails Texture0 / `MyDeusExSaveInfo` / Palette0, then Palette1 / Texture1 / `MyDeusExSaveInfo`, then Texture2 / Palette2 / `MyDeusExSaveInfo`; the exports Texture first, then Palette first twice), so a comparison with an original of the same moment is made after writing Play's file in the original's two orders (`scripts/save-info-diff.mjs`); Play's own choice, for a first save of its process Texture, Palette, `MyDeusExSaveInfo` and later ones Palette, Texture, `MyDeusExSaveInfo`, follows the commonest of the 44, not a rule.
* **Flags**: every flag is written with the FlagBase as Outer (the 2026-09 desktop save has that); 96% of the internet saves' flags have the player (flags a travel text imported are constructed with the player as Outer, `SpawnPlayActor` pass 1). Only bool flags were compared with real files (the saves hold no other kind); a FlagInt/FlagByte/FlagFloat/FlagName/FlagVector/FlagRotator is written by the same path from the host store but was compared with no original file.
* **Level payload**: the order of exports, names and imports of the level file is Play's (Unresolved 10); `ProgressBar`/`BeginSlowTask` (`LevelAction = 2`, `PaintProgress`) is not drawn; the clock of the time stamp is the browser's local time and `InternalTime` its monotonic clock.
* A `LoadSaveInfo(-2)` that finds `Current\SaveInfo.dxs` (a save after a load) loads the object from the file in the original (and logs `Loading: Package saveInfo` the first time); Play writes the new SaveInfo without that read.
* `QuickSave`'s refusals (the logo map, `Dying`/`Paralyzed`/`Interpolating`, a DataLink playing) are the script's own; the generator of the load checks met the DataLink one on the Island.
* Storage: an overwrite in a picked folder is not atomic (IndexedDB's is); the bytes cross the worker boundary as copies; Chromium's `showDirectoryPicker` write path was run against an origin-private-file-system handle only ([save storage](save-storage.md)).

## Play, step 4: loading a saved game

2026-10-22, the load side (the save side is [above](#play-step-4-saving)). `?loadgame=N` runs the recovered Browse branch, the slot's level is restored with the saved player and its whole object graph, and the Load Game
screen's button, the QuickLoad key and the menu after a death reach it. Sources: the script chain (`DeusExPlayer.LoadGame`/`QuickLoad`/`QuickLoadConfirmed`, `DeusExRootWindow.ConfirmQuickLoad`/`BoxOptionSelected`,
`MenuScreenLoadGame.ProcessAction`/`LoadGame`, `DeusExGameInfo.Login`, `GameInfo.Login`, `MissionScript.InitStateMachine`/`Timer`), the DLL listings of [Browse](#browse-the-deusex-override) (`0x10010f4f..0x1001151e`),
`LoadSaveInfo`/`CopySaveGameFiles`/`DeleteSaveGameFiles` ([the save directory](#the-save-directory)), the destructors read for this step (`0x1000dda0`, `0x1000db40`, `0x1000e0e0`, `0x1000de40`), and captures of the original
under Wine (`scripts/save-probe.sh`: it takes the shared lock, sets the prefix's own `Save` folder aside and puts it back; sessions `o1e`, `w1`, `o2` in `.work/travel`).

**What `loadgame` changes after `LoadMap` (traced and measured).**

| Where | What | Evidence |
| --- | --- | --- |
| `Browse` | `Doing loadgame, not load`; `LoadSaveInfo(N)` (`Loading: Package saveInfo`; null: Browse returns 0 and the level goes on); `DeleteSaveGameFiles(Current)` (the left level's `Unloading: Package`, once per level: a level that has saved already printed it); `CopySaveGameFiles(slot, Current)`; `LoadMap(FURL(&URL, "..\Save\Current\<MapName>.dxs?load?loadonly?loadgame", TRAVEL_Absolute), NULL, NULL)`, then `LastURL = GLevel->URL` | DLL `0x10010f4f..`; measured `LoadGame 77`, `1`, `-1`, `201..203` and the QuickLoad and menu loads of `o2` |
| `LoadMap` | the file is a level whose `LevelInfo.bBegunPlay` is set: no begin-play pass (no `Game class is`, `Bringing Level`, `InitGame`, `Base Mutator`); `TimeSeconds` from the file; **the level keeps the URL and the `TravelInfo` its file holds** (a `load` option keeps the saved URL: the loaded level's `URL.Map` was the bare map name with `Name=Player`, `Class=...`, not the `LoadMap:` path; its `TravelInfo` is the one pair the level was entered with). So `LastURL` is the file's: a death after a load browses `DXONLY?Name=Player?Class=DeusEx.JCDentonMale`, with no `loadgame` option | measured `dump-travel-win` after the load; measured `Browse: DXONLY?...` after a QuickLoad (`o2`); `ULevel::Serialize`'s tail ([the file](#the-dxs-a-saved-levels-package)) |
| `SpawnPlayActor` | `loadonly` skips only the **import** of the travel text; the callbacks run: the player's `TravelPreAccept`, `AcceptInventory` (`All inventory from Player is accepted`), `TravelPostAccept`, `PostLogin` (the same on `?restart`) | measured log |
| `DeusExGameInfo.Login` | `HasOption(Options, "Loadgame")`: no `ResetPlayerToDefaults`, no `FindPlayerStart`, no `SetLocation`: the saved pawn keeps its subsystems and its place (`DeusExGameInfo.uc:23..65`). `GameInfo.Login` finds the unoccupied saved pawn on `Level.PawnList` and calls `ClientSetRotation(Rotation)`, so **`ViewRotation` becomes `Rotation`** (measured: saved `(8293,-16162,0)`, loaded `(0,-16162,0)`) | script; measured props before the save and after the load |
| `DeusExPlayer.TravelPostAccept` | the real script on the saved pawn: `RestoreSkillPoints` (nothing: `bSavingSkillsAugs` is false in a plain save), the managers' `SetPlayer`, `conPlay.TerminateConversation`, ..., `info.SpawnScript()` (the `MissionScript` is `transient`: `Spawned new mission script`) | measured log; script |
| `MissionScript` | **no marker says "just loaded a savegame"**: it is the absence of `PlayerTraveling` in the saved `FlagBase` (the flag exists only between `PreTravel` and the level's first Timer). The first Timer runs `InitStateMachine` (no `DeleteExpiredFlags`, `SetDefaultExpiration(mission + 1)`) and no `FirstFrame`. A save taken before the first Timer holds the flag (the `SaveGame 77` capture of step 3), and by the script that first Timer then runs `FirstFrame` (not measured) | `MissionScript.uc:62,160`; measured: after the load and the unfreeze the log has `**** InitStateMachine()` and the flags did not change |
| the file | `SaveGame` does not call `PruneTravelActors`: the saved pawn still holds its `AugmentationSystem`, `SkillSystem`, `FlagBase` and carried decoration, and the level holds the `Flag*` objects, `DeusExNote`/`DeusExGoal`/`NanoKeyInfo`, `DeusExLog`s (95 in a played Island), `ConHistory`/`ConHistoryEvent`s | the classes of the captured files |
| the package's name | a loaded level's package takes the spelling of a **live package of the same name** (case-insensitive): a QuickLoad of `00_training.dxs` in the level `00_Training` printed `Level 00_Training.MyLevel` and `Possessed PlayerPawn: ... 00_Training.JCDentonMale1`, the same load from `DXOnly` (no such package) printed `00_training` | `o2` (three loads) |

**What the player does** (the scripts are the original's; measured in `o2`): the **QuickLoad** key is `GreySlash` (User.ini; the numpad `/`): `QuickLoad` -> `DeusExRootWindow.ConfirmQuickLoad` -> a `MenuUIMessageBoxWindow` "Quick Load?" /
"You will lose your current game in progress, are you sure you wish to Quick Load?" with **Yes** and No (`BoxOptionSelected(0)` -> `QuickLoadConfirmed` -> `LoadGame(-1)`). The **Load Game** screen's Load button has **no
confirm box** (`MenuScreenLoadGame.ProcessAction("LOAD")` -> `LoadGame(row)`; only Delete confirms, through its checkbox); from the running game's Escape menu (every button enabled) and from the logo map's menu it is the same.
After a **death** (`Suicide`: the Dying state, the camera spiral and fade, `OPEN DXONLY` at 20 s) the level is `DXOnly` (the rotating logo; its player is `Paralyzed`), Escape opens MenuMain with **Save Game and Back to Game
greyed**, and its Load Game screen loads as above. The loaded Training from `Save0001` shows the HUD, belt and key ring as saved (`.work/travel/o2/*.png`, the page's `reports/browser/load-game-*.png`).

**A trap in the captures.** `set <Class> <Property> <value>` (the console's `set`) writes the live objects *and the class default*, and a tagged property equal to its class default is not saved. The first Island capture
moved the player with `set JCDentonMale Location`: the file had **no `Location`** for the pawn (it equalled the default the session had written), which loads correctly in the same process and puts the pawn at the origin in
any other. The accepted captures walk the player after the `set` (`hold:W`, the Wine input queue's key state) and use no `set` of an item property.

**Play (what runs).**

| Piece | Module | Original |
| --- | --- | --- |
| `Browse`'s loadgame branch as a decision: the log lines, `deleteSaveGameFiles`, `copySaveGameFiles(slot, Current)`, `loadMap` with `furl.mjs loadGameUrl`; a slot with no `SaveInfo.dxs` returns without loading (a warning line of Play's); a session with no save directory stops by name | `travel-browse.mjs`, `furl.mjs` | `0x10010f4f..0x1001151e` |
| its execution: `LoadSaveInfo` from the save directory's parsed `SaveInfo`, `Current` emptied and refilled (`copyFiles`, with the file times), the request `{map: MapName, restore, loadgame: {dir, fetch}, travelInfo: []}`; `fetch` lists the slot files the simulation's directory knows only by name and size | `travel.mjs` | |
| the bytes: the page reads the files from its storage (IndexedDB or the picked folder, `save-store.mjs read()`), awaits them, and hands them to the worker with the level's `load` message, which writes them into `Current` before the level is read from there; a file the storage cannot give stops by name | `main.mjs loadSavedFiles`, `sim-client.mjs`, `sim-worker.mjs` | |
| the saved level, the saved pawn **where the file left it** (no placement search: `Player(restored)`), `Login` with the loadgame option, the real `TravelPostAccept`; the level keeps the file's `TravelInfo` and the file's URL as `LastURL` | `game.mjs`, `player.mjs`, `level-travel-info.mjs`, `script-doors.mjs` | `Login`, `LoadMap` |
| a saved game's non-actor objects: `DeusExNote`, `DeusExGoal`, `NanoKeyInfo` (plain `UObject`s), `DeusExLog` and `DataVaultImageNote` (native, vtables `0x10027ad0`, `0x10027b24`), `ConHistory` and its events, and the **flag store**: the saved `FlagBase` becomes the host flag store (`createFlagBase` on its identity), filled by walking the saved `hashTable` heads and `nextFlag` chains with each flag's class, name, hash check, expiration and value, and replaces the store the trigger natives and the player's `FlagBase` property were bound to before the file's objects existed | `script-restore-objects.mjs`, `script-triggers.mjs useFlagBase` | |
| `CriticalDelete` of a saved log or image note: the deleting destructors `0x1000dda0` / `0x1000e0e0` (the class vtable, `ConditionalDestroy`, the `FString` member's array freed, `~UObject`, `operator delete(this, 0x38 / 0x44)`) are the history event's shape: `deleteObject` | `script-runtime.mjs criticalDelete` | read |
| the travel text's `\` rule for a multi-line string, measured on the real notes of `Save0001` (a datacube's `code:    \n0012  \n...` is written `code:    \0012  \...`): each newline is written as `\`, and a `\` is read back as a newline; a carriage return stops by name | `travel-export.mjs`, `travel-import.mjs` | `ExportTravel` `0x10391740` |

**Checked against the original** (`node scripts/validate-load-game.mjs --only I|T|Q|N|H|G`, `node scripts/validate-load-ui.mjs`, headless; the captures stay in `.work/travel`):

| Scenario | Slot (written by) | Result |
| --- | --- | --- |
| I | an Island the original wrote itself (`SaveGame 77`: troops killed, MeetPaul played, notes, goals, keys, every augmentation and skill, a fired pistol), loaded from HQ | the 13 modelled log lines in the original's order; 6 flags equal; location, rotation, view rotation, health and physics equal; the actor census (2,674 actors, every one in the original's `GObjObjects`; the original's loaded slots hold no other actor of those classes); the loaded player's export at `LocalTravel` **175 records equal** to the original's |
| T | the old desktop slot `Save0001` (Training, 2026-09-12), loaded from Training Combat | 13 lines, 15 flags, place, census (514), export **137 records equal** |
| Q | the prefix's `QuickSave` (slot -1) | 13 lines, 2 flags, place, census (507), export **98 records equal** |
| N | nicouzouf `Save0002` (Liberty Island, retail 1.112, 2002), the original loading it from Training Combat | 11 lines, 34 flags, place and health 84, census (2,637), export **263 records equal** |
| H | nicouzouf `Save0016` (Hong Kong Market) | 11 lines, 137 flags, place, census (1,442), export **369 records equal** |
| G | retromaggedon `Save0035` (GOTY `15_Area51_final`, modded weapons and augmentations) | 13 lines, 309 flags, place, census (1,300), export **796 records equal** |
| UI | `o2`: QuickLoad key and box, Yes; the Escape menu (every button enabled), Load Game (rows Quick Save, Untitled, UNATCO Training Course; the first selected), Load; `Suicide`, `OPEN DXONLY`, DXOnly (Paralyzed), Escape (Save Game and Back to Game greyed), Load Game, Load | the four loads' modelled log lines equal in order (12, 13, 14 and 13 lines, the death's `Browse: DXONLY?...` slice from `Browse` to `Initialized moving brush tracker`), the QuickLoaded player at the saved place, the rows and the button states as the screenshots |

The census compares class and name of every actor Play holds with the original's dump of `GObjObjects` (which does not say which package an object is in: leftovers of earlier levels sit in it, so the reverse check looks only
at the slots of the loaded package); the mission script's instance counter differs (Unresolved 10). `viewRotation` equal means Play's real `Login` ran `ClientSetRotation`. `bCheatsEnabled` is not a saved property (the
save branch measured it): a loaded player has it off, as Play's.

**Every real slot** (`node scripts/validate-load-saves.mjs`, one process per slot, `.work/load-saves.json`): the 39 slots of nicouzouf's 2002 playthrough (Liberty Island to Area 51 Page; the 41 slots name 32 distinct levels) and the two GOTY slots of retromaggedon go through the original's screen (the row of the one slot), the Load button, Browse, the restore with the saved player and two seconds of ticks, and, for the 27 slots that carry other
levels of their mission, a `LocalTravel` to one of them (`PruneTravelActors`, `SaveCurrentLevel(-2)` of the loaded level, the filed level restored from the original's file, the travel text imported, a second of ticks).
**41 of 41 load.** The one that stopped, **retromaggedon `Save0021` (`09_NYC_ShipFan`)**, loads since the rotating brushes ([rotating-brushes](rotating-brushes.md), 2026-10-22): `DeusExMover1`, the Naval Assembly Building's AC fan, is saved destroyed (`BlowItUp`: non-colliding, Location + 20000) and still spinning (`PHYS_MovingBrush` with a `RotationRate`, not `PHYS_Rotating`), and the level load had dropped a mover without `bCollideActors` before it became a moving brush, so its first `physicsRotation` reached `SetRotation MoveActor for a pawn, brush or non-colliding map actor is not linked`. The original loads the same slot under Wine (`LoadGame 21`) and the fan spins there. nicouzouf's `Save0023` of the same map loaded, its fan not being on. The walk found and fixed: a pawn saved crouched in a duct was *re-placed* by Play's spawn search (`No valid collision placement near player start`: a saved pawn is not spawned, so it stays), the deleting
destructors of the log and image-note objects (a travel from a loaded game deletes the old logs: `CriticalDelete deleting destructor is not recovered for native vtable 0x10027ad0`), and plain saved Objects without their `UObject` record.

**The page** (`browser-tests/load-game.spec.mjs`, Chromium new headless, worker mode, the default start; `browser-tests/save-folder.spec.mjs` for a picked folder): the real desktop slots imported into the browser's storage load from
the logo map's menu (`Save0001`), from the running game's Escape menu (`QuickSave`) and by the QuickLoad key with its box and Yes (the player walked away first and is back at the saved place), and after `Suicide` the
dying camera ends at `OPEN DXONLY`, the logo level's menu loads `Save0001` again; with a picked folder the Load button reads the files from the folder (the folder's files unchanged).

**Not done, not measured or not verified (explicit).**

* **Play's own saves are loaded by Play** (the save branch's `Save0010..0012`: Training, the Island with cheats, HQ with the Island filed; `make-play-saves.mjs`): load and tick, and the HQ slot's travel to the filed Island, were run; the state was
  not compared with the original's load of the same files beyond what the save branch recorded (its `wc1`, `wc2` loaded them live, unfrozen).
* **A `.dx` level's package name** is the URL's text in the original (`OPEN DXONLY` printed `Level DXONLY.MyLevel`, `Possessed PlayerPawn: ... DXONLY.JCDentonMale2`) and the file's in Play (`DXOnly`): cosmetic, compared
  case-insensitively in `validate-load-ui` (Unresolved 19).
* Every class and native the 41 slots reach is supported or never reached (the rotating fan of `Save0021` is [done](rotating-brushes.md)).
* A slot whose `SaveInfo` names a map the installation has no `.dx` for (a mod's) stops by name in the page (`Map is not available`); a slot with a missing level file stops in Browse by name; `LoadSaveInfo` finding no `SaveInfo.dxs`
  returns without loading, with Play's own warning line (the original's was not measured).
* The registry indices of a restored level's objects (`0x100000 + export index`, the player's modeled) are not the original's (Unresolved 10); nothing a load compares reads them.
* **Active augmentations and timers after a load** (an augmentation saved active, a charged pickup, a running poison or fire) are restored from the file's properties and state frames and were not compared in a *running* level
  after the first frames (the exports compare equal at the load); `G`'s modded Regeneration/Cloak slot loads and exports equal.
* Firefox and Safari were not run; the folder path's later-visit handle, as in [save storage](save-storage.md).

## Play, step 5 (first part): Play Intro, Credits, DXOnly and the endings

2026-10-22. The [order](#proposed-implementation-order-for-play)'s step 5, first part: the main menu's remaining entries and the game's endings, traced in the original's scripts, measured under Wine and checked against Play. Almost all of it ran
already on the machinery of steps 0 to 3 (the same menus, `SendPlayer`, the travel text and the real scripts); what this step added is the evidence, two small fixes the paths exposed (below), the checks and the page specs.
The beginning of every entry is a plain map change; the death route to `dxonly` (the console `OPEN DXONLY`) and the load paths are step 4's (not touched here; `ep6` below is a reference capture of the death route).

**The paths** (every body is the original's script; the native steps are the chain of [the first page](#the-chain-in-one-page)):

| Entry | What runs | Source |
| --- | --- | --- |
| MenuMain, Play Intro (`winButtons[5]`, `MA_Intro`) | `MenuUIWindow.ConfirmIntro`: on a running game (`MissionNumber >= 0`, not Dying or Paralyzed) the box `MB_Intro` asks first (not measured), else `DeusExPlayer.ShowIntro()`: `ClearWindowStack`, `bStartNewGameAfterIntro = False`, `AugmentationSystem.DeactivateAll`, `SendPlayer(Self, "00_Intro")` | `MenuUIWindow.uc:694..712`, `DeusExPlayer.uc:1021..1034` |
| the intro | `MissionIntro` (`InitStateMachine` deletes every flag and sets `PlayerTraveling`; `FirstFrame` starts the `Intro` conversation, sound down); its end sets `Intro_Played`, `MissionIntro.Timer` sets it False (expiration 1) and calls `PostIntro` -> `SendPlayer(Self, "dxonly")` (`bStartNewGameAfterIntro` False). Escape: with the conversation window up `ConWindowActive` aborts the conversation (`AbortCinematicConvo`: `TerminateConversation`, which flags the end, so the same `Timer` path follows); with the level frozen (no window) `ShowMainMenu` on mission 98 sets `bIgnoreNextShowMenu` and calls `PostIntro` itself ([step 2](#play-step-2-new-game-and-items)) | `MissionIntro.uc`, `ConWindowActive.uc:476..491`, `DeusExPlayer.uc:6916..6980` |
| DXOnly (`Maps/DXOnly.dx`, mission -1) | 16 actors: the DX logo, two `DXText`, the electricity emitter, three lights, a `PlayerStart`, `DeusExLevelInfo` (`MissionLocation` "Splash"); no `MissionScript` (no "Spawned new mission script" line). The arrived player's `TravelPostAccept` returns early (`DeusExPlayer.uc:639..644`): `ShowHud(False)`, `GotoState('Paralyzed')`, so no `SetPlayer` on the imported augmentation and skill managers (their `Player` stays None: not a `travel` property) and `RestoreSkillPoints` never consumes the `SKTemp_*` flags | `DeusExPlayer.uc:596..645` |
| the menu on DXOnly | `Paralyzed.Fire` (the left button) calls `ShowMainMenu`; Escape reaches the same exec; `MenuMain.UpdateButtonStatus` disables Save Game and Back to Game (`IsInState('Paralyzed')`) | `DeusExPlayer.uc:4203..4215`, `MenuMain.uc:30..60` |
| MenuMain, Credits (`winButtons[6]`: `MA_MenuScreen` invoking `CreditsWindow`) | `InvokeMenuScreen(CreditsWindow)` over the menu, `bLoadIntro` False: `CreditsScrollWindow.InitWindow` (black background, `StopRendering`, `StartMusic`: `Credits_Music`, `ProcessText` of `DeusExCredits`), `Tick` scrolls one pixel per `currentScrollSpeed` = 0.04 s; a mouse release or the end calls `FinishedScrolling`: `bQuotesEnabled` (a `globalconfig` bool, False unless the cheat phrase set it) False -> `Super`: `PopWindow`; `StopMusic` restores the level's song | `CreditsWindow.uc`, `CreditsScrollWindow.uc` |
| the Quotes window | `ShowQuotesWindow` (a cheat exec) or, with `bQuotesEnabled`, the end of the credits after `creditsEndSoundLength` (4 s): ten bouncing `SpinningLogoWindow`s over scrolling `DeusExQuotes`, `Quotes_Music`; `bClearStack` (after the credits) clears the window stack at its end, `bLoadIntro` travels to `dxonly` from its `DestroyWindow` | `QuotesWindow.uc` |
| the endings | the endgame `MapExit`s: `15_Area51_Final` `MapExit0` (`map_exit_generator`, `Endgame1`, triggered by the reactor's `Dispatcher7`), `MapExit1` (`Merge_helios_exit`, `Endgame2`, triggered by `FlagTrigger3` on `HeliosFree`), `15_Area51_Page` `MapExit0` (`start_endgame`, `99_endgame3`, triggered by `Mission15.Timer` nine seconds after the `killpage` flag): `LoadMap` (`ClearWindowStack`, `SendPlayer(Player, DestMap)`) -> `Browse` `15 -> 99` (wipe) -> `99_Endgame1..3` (mission 99): `MissionEndgame` (`InitStateMachine` as the intro's; `FirstFrame` deletes the flags, starts the conversation `Endgame<n>` with `bForcePlay` and turns the sound down; `Timer`: `ExplosionEffects` while `EndgameExplosions`, then after `Endgame<n>_Played` the quote (`PrintEndgameQuote`: a `HUDMissionStartTextDisplay`, `EndgameExplosions` False) and after `endgameDelays[n-1]` `FinishCinematic`: the camera points halt, `ShowCredits(True)`); Escape aborts the conversation (`AbortCinematicConvo` -> `FinishCinematic` at once; `ShowMainMenu` on mission 99 does the same) | `MapExit.uc`, `Mission15.uc:396..437`, `MissionEndgame.uc`, `DeusExPlayer.uc:1036..1056`, `ConWindowActive.uc` |
| the end of the credits after an ending | `CreditsWindow.DestroyWindow`: `bLoadIntro` -> `SendPlayer(player, "dxonly")`; `Browse` `99 -> -1` (wipe); the DXOnly level as above, the menu a click away | `CreditsWindow.uc:123..132` |

**Measured** (2026-10-22, eleven launches of the installed game under Wine, `scripts/travel-probe.sh` with its `follow:` mode; captures `.work/travel/ep0` to `ep11`, outside Git, each with the session's engine log as `final.log`: the game was ended through the menu's Exit box
(Yes at (635, 413)) so that the log is flushed whole; a kill truncates it at the last 8 KB block). The menu was driven by real clicks on the 1280 x 720 viewport: a click on the logo map opens MenuMain, Play Intro (641, 376), Credits (641, 412), Exit (641, 542); the endings by the typed
console lines `open 15_Area51_Final` and `LocalTravel 99_Endgame1` (`open` leaves the FlagBase empty; Play's marker is removed before the comparison), a click on the credits, the DXOnly menu, Exit.

| Session | Scenario | What the original did |
| --- | --- | --- |
| `ep0` | the menu's geometry | buttons at y = 196 + 36 i (Exit 58 lower), x 641 |
| `ep1` | Play Intro to the intro's own end; DXOnly; a click; Credits to their end; Escape twice; a click beside the menu | the text for `00_Intro` (426 dump lines; Play: the same 96 records as for New Game); the conversation ended at level time 126.67 s (a screenshot key was pressed during it); the DXOnly text (97 records, `LastConEndTime`, no `bIgnoreNextShowMenu`); flags `Intro_Played` False@1, `PlayerTraveling`@0, `SKTemp_SkillPointsTotal`/`Avail` 5000@99, default expiration 99; a click opens MenuMain (Save Game and Back to Game grey); the credits scroll at 25 px/s and end by themselves at about 421 s with the menu behind them (the team photo's bottom at y 488 at 400 s); Escape closes the menu, a second Escape reopens it; a click beside it does nothing |
| `ep2` | Play Intro, Escape 20 s into the conversation; a click; Credits ended by a click after 20 s; Exit | `LastConEndTime` 20.88 (the Escape), no `bIgnoreNextShowMenu` (the conversation window took the Escape), the same flags and 33 modelled log lines (below); the DXOnly log: `DevMusic: Load music Title_Music`; Credits: `Unregister Title_Music`, `Load Credits_Music`, then back `Unregister Credits_Music`, `Load Title_Music`; the window host's "Assigning Last Button Window" lines |
| `ep3`, `ep8` | `open 15_Area51_Final`, `LocalTravel 99_Endgame1`, to the credits, a click, DXOnly, the menu, Exit | `Current mission number is 15, next is 99`; `Endgame1_Music`; flags `EndgameExplosions`=1@0 during the conversation, then `Endgame1_Played`=1@100 and `EndgameExplosions`=0@100; the credits at about +65 s; `LastConEndTime` 54.04 (`ep8`, a second run: 53.71); `Current mission number is 99, next is -1`; the DXOnly text (98 records) and flags (`Endgame1_Played`, `EndgameExplosions`, `PlayerTraveling`, `SKTemp_*` at 100, default expiration 100) |
| `ep4` | the same for `Endgame2` | `LastConEndTime` 66.16; flags `Endgame2_Played`, `EndgameExplosions` False (no `EndgameExplosions` True at any snapshot); the quote "If there were no god, it would be necessary to invent him. -- Voltaire" on the screen at +67 s; four `ScriptWarning ... Accessed None` lines (three `TriggerLight`s, `ShakeTrigger0`) at the start |
| `ep5` | `set ... bCheatsEnabled True`, `ShowQuotesWindow` (shots, a click), then `open 15_Area51_Page`, `LocalTravel 99_endgame3` | the Quotes window ("Deus Ex Quotes - ...", ten spinning logos), `Quotes_Music`, a click ends it and `Title_Music` returns; Endgame3: `LastConEndTime` 101.68; flags as above; the URL's spelling `99_endgame3` (the `MapExit`'s `DestMap`) is the level package's name in the log |
| `ep6` | the player placed outside the world (a failed Final MapExit placement: its `MapExit0` lies in solid space, no zone) | "fell out of the world", the death, `OPEN DXONLY`: `Browse: DXONLY...`, `Current mission number is 15, next is -1`, no travel text (`0 pairs`), the fresh player's FlagBase empty with default expiration 0; a click opens MenuMain. A reference for the death route (step 4's) |
| `ep7` | Escape 20 s into Endgame1 | the credits within a second (no quote); `LastConEndTime` 21.90; flags `Endgame1_Played`, `EndgameExplosions` False; the same log lines as the natural end |
| `ep9` | Endgame3 with `ConPlay0`'s `TimerRate`, `TimerCounter` and the level's `TimeSeconds` read every 7 s (`tools/dump-actor-win.c`) | the timer counter advances 1.02 to 1.18 times faster than `TimeSeconds` ([the conversation's length](#the-conversations-length-and-the-originals-actor-delta-clamp)) |
| `ep10` | a real played game: the internet slot `nicouzouf` Save0040 (`15_Area51_final`, 285 flags) loaded with the console's `LoadGame 40` (`Browse: Index.dx?loadgame=40`, `LoadMap: ..\Save\Current\15_Area51_final.dxs?load?loadonly?loadgame`), then `LocalTravel 99_Endgame1`, the credits, a click, DXOnly | the same 33 modelled log lines as the fresh player's; the text for the endgame is 719 classes (4952 dump lines: the played inventory, augmentations, notes, goals), the DXOnly text 355; `LastConEndTime` 54.56; flags as the fresh player's but `SKTemp_SkillPointsTotal` 28033 and `Avail` 1333 |
| `ep11` | the ending with `bQuotesEnabled` True (`set DeusEx.DeusExPlayer bQuotesEnabled True` on the logo map, then `open 15_Area51_Final`, `LocalTravel 99_Endgame2`, no input for 15 minutes) | the credits start at about +80 s and run to their end (about +498 s: the same 420 s); no menu or window stack beneath them; 4 s later `QuotesWindow` (ten spinning logos, `DeusExQuotes`), `DevMusic`: `Unregister Credits_Music`, `Load Quotes_Music`, then at its end (about 365 s later, a click not needed) `Export travel`, `Current mission number is 99, next is -1`, `dxonly`, `Unregister Quotes_Music`, `Load Title_Music`; `LastConEndTime` 65.87; the DXOnly text and flags as after the click-ended credits |

**What the captures showed**

* **Play Intro starts without a prompt on the logo map** (mission -2) and leaves `bStartNewGameAfterIntro` False; the exported text for `00_Intro` is the one New Game's Start Game exports (96 records).
* **The intro's Escape depends on whether the conversation window is up.** With the level running it is `ConWindowActive`'s `AbortCinematicConvo` (the text has no `bIgnoreNextShowMenu`; `LastConEndTime` is the Escape's time); the frozen intro of the New Game captures never had the window.
* **DXOnly's player is Paralyzed and nothing opens by itself**; a click or Escape opens MenuMain; Escape closes it and a second Escape reopens it (the exec `ShowMainMenu` is not among the functions the state ignores). The arrival through `OPEN DXONLY` (death) differs only in having no travel text.
* **The level package is named as the process first spelled the map** (`FName` keeps the first spelling of a name and compares case-insensitively): `dxonly` and `99_endgame3` as the scripts and the `MapExit` spell them, `DXONLY` after the console `OPEN DXONLY`, `Bringing Level dxonly.MyLevel`, `Possessed PlayerPawn: JCDentonMale dxonly.JCDentonMale2`; but a `?restart`'s `LoadMap: 00_training?loadonly` brings `00_Training.MyLevel` (the name existed, spelled so, since the first load: `s4` capture).
* **The Credits from the menu end at the menu**: no Quotes window by default; the end after an ending travels to DXOnly. The column is 9797 px tall and starts 12 px above the root's bottom edge (`winScroll.y` 468 at a 480 px root, 708 at the capture's 720); the scroll lasts (708 + 9797) / 25 = 420.2 s, which is the measured end (the photo's bottom at y 488 at 400.5 s, the menu back by 421 s).
* **The endings' flags run `EndgameExplosions` (True while the conversation plays) -> `Endgame<n>_Played`, `EndgameExplosions` False**, and the flag store leaves the endgame with default expiration 100 (`MissionEndgame` set it from mission 99 + 1).

**New in Play for step 5**

* `script-player-startup.mjs`: the verification of an *imported* player expected `AugmentationManager.Player == player`, which holds for every level but the DX.dx logo map and DXOnly, whose `TravelPostAccept` returns before `SetPlayer`: the first arrival at DXOnly stopped with "AugmentationManager Player is not JCDentonMale".
  An imported manager in a level of mission number below 0 now keeps `Player` None, as the original's does (and its augmentations' `Owner` is the player, as for any imported actor).
* `script-doors.mjs`, `script-datalink-live.mjs`: the level package takes the name the travel URL spelled (`arrival.map`; the file's name for a map opened directly) unless the process (the page's worker, a validator's Node process) has already named a level in another case, then that first spelling
  (`internLevelName`: `FName`'s rule), in the engine log's `Bringing Level`, `Unloading: Package` and `Initialized moving brush tracker` lines and in object names. Before, a travel to `dxonly` or `99_endgame3` logged `DXOnly` and `99_Endgame3`.
* `scripts/census-stage5-session.mjs` `openSession` takes `frameSeconds` (default 1/60) for a session whose frames are not 60 Hz.
* Nothing else: the menu buttons, the intro, the credits and quotes windows, `MissionEndgame`, the conversations and the cinematics ran unchanged on the existing machinery.
* **The natives on these paths** (all bound before this step, none new; the census sessions of [native census](native-census.md) ran the Credits button clean): `RootWindow.EnableRendering`/`IsRenderingEnabled` (1512/1513, `0x10039e20`; the credits' `StopRendering` clears the root's `bRender` bit, `script-root-render-viewport.mjs`
  then draws no 3D view under the window) and `ShowCursor`; the `DeusExTextParser` natives that read `DeusExCredits` and `DeusExQuotes` ([text parser](script-text-parser.md)); `PlayerPawn.ClientSetMusic` with `DynamicLoadObject` of `Credits_Music`/`Quotes_Music` and the level's song again at the end ([music load](script-music-load.md), [Galaxy music](galaxy-music.md));
  `Actor.PlaySound` (`CreditsEnd`, the explosions of `MissionEndgame.ExplosionEffects`), `SetInstantSoundVolume`, `ConsoleCommand("FLUSH")` of `ShowMainMenu`, `ShakeView`, the `HUDMissionStartTextDisplay` window natives for the quote, `PlayerPawn.ClientTravel`/`SetClientTravel`, the conversation natives (`GetSpeechLength` 2056, [sound length](script-conversation-sound-length.md))
  and the camera/animation natives of the cinematics ([conversation camera](conversation-camera.md)).

**What was checked** (`node scripts/validate-travel-endings.mjs`, one process per scenario; headless, against the captures above; the page: `browser-tests/original-start-intro-credits.spec.mjs` and `browser-tests/ending.spec.mjs`):

| Check | Result |
| --- | --- |
| P: Play Intro, Escape in the conversation, DXOnly, a click, Credits ended by a click, Exit's box | the texts for `00_Intro` (96 records) and DXOnly (97) **equal** the captures' after normalization; the arrival flags equal; the Paralyzed player; no window at arrival; the click opens MenuMain with Save Game and Back to Game insensitive; Escape closes it and a second reopens it; the Credits open over it and a click returns to it; **33 modelled log lines equal** the original's, in order (`Export travel` ... `Initialized moving brush tracker for Level dxonly.MyLevel`) |
| N: the intro's own end | the DXOnly text (97 records) and flags equal `ep1`'s; the conversation ends at 133.3 s at 60 Hz against `ep1`'s 126.7 (the clamp, below; the first New Game captures: about 136 s with a frozen start) |
| C: Credits to their end | the column is 9797 px, `currentScrollSpeed` 0.04, "Andrew Megowan" at offset 4842 (measured 4867 +- 45) and "EIDOS INTERACTIVE EUROPE" at 7986 (7992 +- 45); the window ends after (the column's start y + 9797) / 25 s (410.1 s at the headless root's 480 px) and the menu is back |
| E1, E2, E3: `LocalTravel` from a directly opened Final or Page to the endgame, the credits, a click, DXOnly, the menu | the texts for the endgame (96 records) and for DXOnly (98) **equal** the captures'; the measured flag sets appear in Play's sequence in order; `Endgame<n>_Played` appears inside the measured window (E1 56 s, E2 70 s, E3 109 s at 60 Hz) and before the credits (70, 84, 120 s); the click on the credits requests `dxonly`; the arrival flags equal; **33 modelled log lines equal** the original's each |
| T1, T2, T3: the conversation's length at the capture's frame time | at 4.7 ms frames Play's conversations end at 52.8 s (measured 54.04 and 53.71), 66.2 s (66.16) and 102.7 s (101.68), within 5 % ([below](#the-conversations-length-and-the-originals-actor-delta-clamp)) |
| M1, M2, M3: the endgame `MapExit`s as their triggers fire them | `Actor.Trigger` on Final's `MapExit0` and `MapExit1` requests `99_Endgame1`/`99_Endgame2` with the text equal to `LocalTravel`'s (96 records); on Page `killpage` (set as a test input) makes `Mission15.Timer` run `PageExplosionEffects`, destroy Page and the platform at 7 s (`MS_PageDestroyed`) and trigger `start_endgame` at 10 s: `99_endgame3` is requested with the flag in its text; each endgame arrives in mission 99 with the Paralyzed player. The original was not driven through these triggers ([unresolved](#unresolved) 23) |
| W: the ending with `bQuotesEnabled` True | the credits at 84 s, the Quotes window 415 s later (the scroll's 410 s and `creditsEndSoundLength`'s 4 s; `bClearStack` and `bLoadIntro` True), its end after 355 s (headless root 480 px; 365 s at the capture's 720 px, the measured end at about 365 s) with the window stack clear, `dxonly` requested; the DXOnly text (98 records) and flags **equal** `ep11`'s |
| L: the ending from a played game: the slot `nicouzouf` Save0040 loaded in Play, `LocalTravel 99_Endgame1`, the credits, a click | the text for the endgame (**719 records**) and for DXOnly (**355**) **equal** `ep10`'s, the arrival flags equal (`SKTemp_SkillPointsTotal` 28033, `Avail` 1333), **33 modelled log lines equal** |
| X: Escape during the Endgame1 conversation | the credits open at once, the flags equal `ep7`'s, the DXOnly text (98 records), the arrival flags and the 33 log lines equal |
| Q: the Quotes window | `ShowQuotesWindow` returns without cheats and opens `QuotesWindow` with them (`DeusExQuotes`, `Quotes_Music`); a click ends it and nothing travels |
| the page, default start (worker mode, Chromium new headless) | real clicks: Escape, Play Intro, Escape in the conversation, DXOnly with the four flags and nothing open, a click opens MenuMain (Save Game, Back to Game grey), Credits open and a click returns to the menu; no runtime or page error |
| the page, debugging start | `15_Area51_Final`, `LocalTravel 99_Endgame1`: the conversation window, `Endgame1_Played`, the credits, a click, DXOnly with the five flags, a click opens MenuMain; and the Escape variant opens the credits within a second |

### The conversation's length and the original's actor delta clamp

The conversations of the endings last 2 to 8 s longer in Play at 60 Hz than in the captures (`LastConEndTime` 56.28 / 70.53 / 109.30 s against 54.04 / 66.16 / 101.68; the intro 133.3 against 126.67). It is the capture machine, not the conversation: Play's event timeline
is exactly the scripts' (each speech event lasts `GetSpeechLength` + the 0.5 s `Sleep` of `SpeechFinished` + at most one tick: 9 events of Endgame1, TimerRate 7.358, 5.226, 16.406, ..., deltas 7.86, 5.74, 16.91, ...), and the natives are the original's. `ULevel::Tick` ([level scheduling](script-level-tick.md)) clamps the delta its *actors* get
(timers, `Sleep`, animation) to [0.005, 0.4] s while `LevelInfo.TimeSeconds` adds the unclamped product: the Wine session ran these simple levels at frames of about 4.7 ms, so every actor tick counted 5 ms for 4.7 and `ConPlay0`'s `TimerCounter` ran 1.02 to 1.18 times faster than `TimeSeconds` (`ep9`: samples of `TimerRate` 23.19 s, counter
0.46, 7.84, 15.00, 22.03 against level times 36.08, 42.88, 49.80, 56.69). Play running its tick at 4.7 ms frames (`openSession`'s `frameSeconds`) reproduces the captured ends within 5 % (scenarios T1 to T3: 52.8, 66.2, 102.7 s) and the captured event starts (Endgame3's third speech at 13.52 s against 13.72 s; the seventh at 35.70 against 35.62).
At 60 Hz or any frame above 5 ms (the page on a 60 or 120 Hz display) the clamp never applies and the conversations last their nominal time; a 240 Hz display would shorten them as the capture machine did, because Play runs the same tick.

## Play, step 5 (second part): every map-to-map transition of the campaign

2026-10-22/23. The details, the census and the captures are in [travel-transitions.md](travel-transitions.md); this is the summary and the list of what it changed in the chain above.

* **What the installed maps hold.** 47 `MapExit`s (20 with `bPlayTransition`), 149 `Teleporter`s with a URL (5 disabled, never fired) and two scripted `SendPlayer`s (`Mission04.Timer`, `Mission11.Timer`): 198 transitions
  with five URL shapes (`Map#Portal`, `Map`, `Map.dx`, `Map.dx#Portal`, `Map.dx #Portal`).
* **The Hong Kong lifts** are four mutual pairs of *triggered* `MapExit`s (tags `change_floors`, `change_floors01`) fired by the `Button1` of the lift cabin; all eight are mission 6 to 6 (file and restore). **The four `MapExit`s without a `DestMap`**
  (`00_Intro` `MapExit1`, `12_Vandenberg_Gas` `MapExit6`/`7`, `14_Vandenberg_Sub` `MapExit0`) are never given one at run time (only `MapExit.LoadMap` reads it); `SendPlayer(P, "")` runs `PreTravel` and then nothing (the tick tests `TravelURL` against `""`,
  `UGameEngine::Tick` `0x1039088e`), a `bPlayTransition` one ends its camera path without a request (`InterpolateEnd`: `if (NextMap != "")`). Measured: only `PlayerTraveling` and the `SKTemp_SkillPoints*` flags change.
* **PreTravel**: `Mission02` (`MS_MapLeftEarly` leaving Battery Park early, `FordSchickRescued` leaving the sewers with Ford), `Mission08` (the `EntranceCopter` of `08_NYC_Street` destroyed before the level is filed), `Mission10` (`NicoletteLeftClub`); the first two measured.
* **`FURL` with a map extension.** The head `Map.dx` / `Map.dx ` before a `#` is a pure filename (`0x103f8680..0x103f875d`): `Map` keeps the extension and the blank, `FURL::String` prints map, options, `#portal` (`0x103f9210`); `DDeusExGameEngine::Browse` cuts the filed level's name at
  the first `.dx` (`appStrstr`, `0x100119d7`) so `Map.dx ` finds `Map.dxs` in `Save\Current`. `furl.mjs` (`mapFileStem`) and `travel-browse.mjs` do the same; six of the eight installed `.dx` destinations are on the campaign's main path.
* **A carried `WeaponMod`** (the importer now prepares the view meshes of every carried `Inventory` class) stopped nine arrivals from the real slots of the first missions.
* **Census and measurements.** `scripts/census-transitions.mjs` drives all 198 from a real slot or a cold open (`.work/census-transitions.json`); `scripts/validate-travel-transitions.mjs` replays six Wine sessions (`scripts/travel-steps/`, captures `tr-a`..`tr-f`: the Hong Kong
  pair, an empty `SendPlayer`, the two PreTravels, the `.dx` forms and a mission change with a `#portal`, a start spot above water, two camera-path exits) and compares the log, the travel text, the flags, the arrival place and the `Current` listing; `browser-tests/transitions.spec.mjs` covers the page.

## Where Play stops today

* `PlayerPawn.ClientTravel` in a session without `travel` (every validator, census and live replay): `TravelBoundary` (`travel-boundary.mjs`) with the URL, type and `bItems`; with `travel` (the page): the recovered native, then the tick's step as above.
* The console `OPEN` (`bItems` 0, `TRAVEL_Partial`): `SetClientTravel` as recovered; the tick's step throws `ClientTravelBoundary` without `travel` and with a live replay ([Stage 5 death proof](stage-5-exit-criteria.md#the-players-death-to-the-levels-end-2026-10-18)), and travels with it (`OPEN DX` and `OPEN DXONLY` are the `next == -1` wipe).
* `PlayerTraveling`: a **host input for a cold open only** (Play's login supplies the fresh-mission marker, [Stage 3 exit criteria](stage-3-exit-criteria.md); Stage 5's replays delete it first); a map entered by travel gets it from the travel text, and a restart has none.
* In the page: the logo map's Training and New Game travel (`00_Training`; `00_Intro`, then the Island by Escape or the intro's end) and, since step 3, same-mission travel (`MapExit`, `Teleporter`: `PruneTravelActors`, `SaveCurrentLevel(-2)`, a filed level restored; the
  Player start of a restored level stops by name); `?loadgame=` loads a slot since step 4 ([loading](#play-step-4-loading-a-saved-game)); Play Intro, Credits, DXOnly and the three endings (`LocalTravel`, Escape, the credits' click) are in since step 5's first part ([step 5](#play-step-5-first-part-play-intro-credits-dxonly-and-the-endings); the entries through the real triggers in the original, the other endings from a slot and the Play Intro prompt are [named below](#unresolved)) (the Load Game *screen* opens with an empty save directory since 2026-10-21, [save-directory](save-directory.md)); an arrival whose text holds a class the import cannot construct stops in pass 1 by name (`UnsupportedTravelImportError`).

## Unresolved

Each item is **unverified** or unread; none blocks the first two steps of the [order](#proposed-implementation-order-for-play) except where said.

1. **`FURL` parsing.** The travel-type branches are read (`0x103f7b60`); the installed forms were exercised, not traced: `.dx` suffix, a space before `#` (the map keeps the trailing space and still loads) and the portal split ([measured](#load-game-restart-and-url-forms)).
   Not read: how the parser trims or resolves the map for the file lookup, the default options it adds (`URL: Adding default option Name=Player`, `Class=DeusEx.JCDentonMale` from `[DefaultPlayer]`; `LoadURLConfig`/`SaveURLConfig` at `0x103f9bc0`/`0x103f9cb0` and the end of
   `LoadMap`, `0x1038e32c..0x1038e3c1`), and which start spot a `Map#Portal` picks when two teleporters share a tag. A port can start from the measured outputs (Map, Portal, Op) for the 21 + 149 installed destinations. *Step 0 ported the plain forms (`furl.mjs`); the `.dx` suffix and the blank before `#` are traced and measured in [step 5's second part](travel-transitions.md#the-url-forms-with-a-map-extension-and-a-blank) (also: `TRAVEL_Relative` copies the base's options except `PUSH`, `POP`, `PEER` and `LOAD`, `0x103f7edb`, where `furl.mjs` appends the `[DefaultPlayer]` options: [open](travel-transitions.md#unresolved-in-this-part)); paths and hosts are refused by name until they are traced.*
2. **ExportText / ImportText formats.** Only what the samples show is established: ints, bools, names, `FLAG_*` enum names, a struct (`AugLocs[6]=(AugCount=3)`), floats (`saveTime=67.075813`), object references (`%08x name`). Not sampled: vectors, rotators,
   strings with newlines (the `\` rule is read, not seen), byte arrays (`invSlots[30]`), `Conversation`/`Note`/`Goal` lists, inventory with mods, a carried decoration. *Step 2 measured the byte array (`invSlots[0..3]=1`), notes, goals, keys, images, strings typed or taken from the console, non-default weapon, ammo and pickup properties and the belt positions of real pickups ([Play, step 2](#play-step-2-new-game-and-items)); and the conversation history (`ConHistory` with 16 `ConHistoryEvent`s, scenario I); inventory with mods, a carried decoration, a `Name[]`, flag vectors and rotators and strings with a newline are still not sampled.* A played save's travel text (weapons with mods, ammo, notes, goals, images, history) is the next reference. *Step 1 implements bool, int, float, byte and enum, name, string, struct and object properties (`travel-export.mjs`/`travel-import.mjs`; the first six through `config-text.mjs`'s Core-verified bodies), matched by the two measured texts; every other kind stops by name.*
   *Step 4 (load): the `\` rule for a multi-line string is now seen: each newline is written as `\` (the real notes of `Save0001`, [loading](#play-step-4-loading-a-saved-game)), and the original's exports of 6 real slots (137, 98, 175, 263, 369 and 796 records) equal Play's; a carriage return stays a named stop. Vectors, rotators and `Name[]` (`AugmentationCannister.AddAugs`) are still not sampled.*
3. **`PruneTravelActors`** destroys the managers, the flag base and the carried decoration but leaves the pawn and its inventory in the saved level (measured: the `.dxs` holds `JCDentonMale<N>` and its items). The saved pawn is then re-possessed
   on restore (measured: one pawn); which of its saved properties survive, in what order the travel text overwrites them, and why `GameInfo.Login`'s name test accepts it (`PlayerName != PlayerReplicationInfo.default.PlayerName`)
   are not traced. *Measured by `rt1` (step 3): no pawn leaks (one player pawn in the restored Island, the saved one, name kept) and `Login` moves it to the start spot; why `Login`'s name test accepts it is still untraced (Play runs the real script, which does).*
4. **The `.dxs` format.** *Decoded in step 3 ([the file](#the-dxs-a-saved-levels-package)): the tag stream, the state frame header, `Level`'s tail, the native `Model`/`Polys`/`LevelSummary` payloads and the AI event objects, each checked by writing the original's bytes back (`validate-level-save`).
   Open: the order of exports, names and imports and when a brush object carries an `FStateFrame` header; the original loading more than the one Play-written Island tried; the flag, note and goal objects of a slot (step 4).* Compatibility with original desktop saves is the user's decision (the design change of 2026-10-22: real files, importable): reading is done for levels, a slot import is step 4.
   *Step 4: Play loads and restores levels the original wrote at every mission (41 real slots, 41 of 41 load; the exports of the loaded players equal the original's for six of them). The original loading Play's files: the Island and the save branch's Training, Island, Quick Save and HQ slots (its `wc1`, `wc2`); not another map after more play.*
5. **Level state after a restore.** Measured: destroyed actors stay destroyed and a carcass made before the leave persists ([below](#restoring-a-level-what-the-log-shows)); *by `rt1` (step 3): summoned items stay where they were left, the player's flags are the travel text's, and the log is the one above.
   Play's restore keeps a mover where it stood (its `Location` and `KeyNum`: `validate-travel-restore`), the AI manager and the NPCs' states (63 of 63 after 1.5 s) and the level time; whether the original's restored mover and timers continue as these do is
   checked only through the file's own contents (the restore reads them), not by a second measurement of the live level, and conversations already played (the history objects) are restored from the file.* The first marker tried (a summoned item) never spawned: `summon` and `KillAll` need `bCheatsEnabled` The first marker tried (a summoned item) never spawned: `summon` and `KillAll` need `bCheatsEnabled` (`DeusExPlayer.uc:2075,5400`;
   `set DeusEx.JCDentonMale bCheatsEnabled True`).
6. **Startup and menu.** `UGameEngine::Init`'s first `Browse` (why the game boots `DX.dx` whatever the command line says), the first appearance of `MenuMain` on the logo map (measured: a click over the playing logo cinematic opens it, an Escape posted through `dxinput` did not within 4 s; the code that decides is the `Interpolating` state's
   `Fire`/`ShowMainMenu`, `DeusExPlayer.uc:4162..4165`, and the logo map's own `TravelPostAccept` hack, `:616..640`), and the menu buttons' handlers other than Training, New Game, Play Intro and Credits (the last two: [step 5](#play-step-5-first-part-play-intro-credits-dxonly-and-the-endings); measured: the Training button starts the level at once, no prompt; New Game goes to the difficulty screen when `bAskedToTrain` is True, then the New Game screen, Start Game and the intro: *step 2*; the "train first?" box of a False `bAskedToTrain` was measured once, `nw3`) are not traced.
7. **`LastURL`.** The engine's `LastURL` (`+0x74`) is assigned in the load-game and saved-level branches of `DDeusExGameEngine::Browse`; the plain local-map success path does not assign it (`0x10011cb6`), and `LoadMap` does not either (no `FURL::operator=` in its body). Where else it is set is not read. It only feeds
   the base of the next `FURL` (protocol, host, port; options for `TRAVEL_Partial`), so a wrong value shows only through `OPEN`'s inherited options.
   *Step 4: `LastURL` after a load is `GLevel->URL`, which keeps the URL the *file* holds (the bare map name with `Name=` and `Class=`, measured `Browse: DXONLY?Name=Player?Class=DeusEx.JCDentonMale` after a QuickLoad), not the `LoadMap` path with `loadonly`/`loadgame`: Play sets it from the file ([loading](#play-step-4-loading-a-saved-game)).*
8. **`ULevel::Serialize`.** `TravelInfo` is serialized with the level (measured through a loaded game). *Decoded in step 3 from the files ([the file](#the-dxs-a-saved-levels-package): `Actors`, the URL, `Model`, `ReachSpecs`, `TimeSeconds` as a float, `FirstDeleted`, 16 `TextBlocks`, `TravelInfo`); the instructions of `ULevel::Serialize` beyond `0x1039d5a2` were read for the time, not for the whole function.*
9. **Failure paths**: `LoadMap` returning null in `DDeusExGameEngine::Browse` (the old map is reloaded by name, `0x10011e38`), `AbortToEntry`, a `TravelURL` with an unknown map. Single-player content never reaches them; Play should report them and stop.
10. **The object registry after a travel.** The arrival's objects take the slots of the map's open-capture seed (`mapRegistrySeed`), where the original's LoadMap collects the previous level in one registry (measured: `Garbage: objects: 35229->35017`). The registry indices of the arrival's actors, the player's sound channel ids that follow from them, and the object names' instance counters (`JCDentonMale8` against Play's `JCDentonMale0`) therefore differ from the original's: **unverified**, and not needed until a replay compares a travelled level's streams. *Step 3 adds a model for a restored level: each restored object's hash slot is `0x100000 + export index` and the player's index is modeled; both are labelled and unverified.*
11. **LoadMap's retire step across maps.** `NotifyLevelChange` and the old player's `DestroyActor` do not run (the old session is dropped with its frame still in flight); the original runs them in the old world, where their effects are the level's own. Whether anything they do reaches the next level (the audio subsystem's channels, the cache) is **unverified**. *In the page the retire step of a restored arrival is the same as of a fresh one.*
12. **`ExportText`'s details.** `UStructProperty::ExportTextItem`'s `Port()` filter was not read (every member that differs from the default is written, which matches `AugLocs[6]=(AugCount=3)`); a string with a newline is written with `\` for each newline (measured in step 4; a carriage return stops the export by name); the property kinds that are not in the measured texts stop the export by name.
13. **The cold open's `Login` options.** The original's boot URL carries `?Name=Player?Class=DeusEx.JCDentonMale`, so its cold `Login` prints `Login: Player`; Play's cold open passes no options (`Login: `), which a travel arrival does not share. Changing the cold path would touch the Stage 3 gates, so it was left.
14. **Not single-player, left unsupported**: `ServerTravel`/`ProcessServerTravel`, `PreClientTravel` for remote clients, `NM_Client` pending levels, the `?push`/`?pop`/`?peer` options and the `Game%04i.dxs` pushes in `LoadMap`, the developer `UDumpLocation` file branch of `DeusExGameInfo.Login`, `LoadMapWindow`'s `?loadonly` opens.
15. **The conversation history in the travel text** *(was open at the start of step 2)*. Measured once, the Island's MeetPaul (`nw5`) and ported: Play's export and import equal the original's (scenario I). Not measured: a history after several conversations or an InfoLink's (`bInfoLink`), an event whose speech holds a newline, and the sound ids across levels (`soundID` is exported as the original wrote it).
16. **The captures' freeze is a class default, Play's a typed line.** The captures carried `set LevelInfo bPlayersOnly True` into each new level through the class default; Play types the same line in the arrived session before its first frame (`scriptClassSet` imports into the level's live actors and into the class defaults, as `UObject::GlobalSetProperty` does). The two freeze the same actors (the intro's player stays `PlayerWalking` in both), but the equivalence of carrying a default across a `LoadMap` with typing after it is assumed, not traced.
17. **Play's `.dxs` under the original engine** *(step 3)*. Tried once, on the Island: the original loads it ([above](#play-step-3-visited-maps-restored)), after the name-flag fix its first attempt exposed. Not tried: another map, a level after more play, a `Save000N` slot with a `SaveInfo` and `LoadGame N` (a loaded game, with the player's `FlagBase` and notes in it: step 4), and a comparison of the restored levels' actors beyond the census.
18. **A `MapExit` with `bPlayTransition`** *(step 3)* runs through the real `Interpolating` state and `InterpolateEnd` in Play (the Island of mission 3: 940 ticks to the request); the camera path's exact timing and the arrival were not measured against the original.
19. **A level package's name.** The loaded package takes the spelling of a live package of the same name (a QuickLoad of `00_training.dxs` in `00_Training` printed `00_Training`; from `DXOnly` it printed `00_training`: modeled in `travel.mjs loadGame`, three measured loads, the rule inferred from them); a level loaded from a `.dx` is named by the URL's text in the original (`OPEN DXONLY`: `DXONLY.MyLevel`, `DXONLY.JCDentonMale2`) and by the file in Play (`DXOnly`): cosmetic, **unverified** beyond these loads and not modeled. *Step 5 models it for travel arrivals: the package is named as the URL spelled the map (`dxonly`, `99_endgame3`: the captured logs' spellings) and keeps a spelling the process made first (`internLevelName`: a `?restart`'s `00_training` is `00_Training`, as measured in `s4`); a restored or loaded level keeps `travel.mjs loadGame`'s rule above; a map opened directly (the validators', the map list's) is named by its file.*
20. **A spinning mover in a loaded level** *(done 2026-10-22)*: [rotating-brushes](rotating-brushes.md). `Save0021`'s destroyed fan is a non-colliding moving brush turned by `performPhysics`' tail -> `physicsRotation` -> `MoveActor`, proven against the original binary (72 cases, 714 ticks) and loaded by the original under Wine; the crush of a pawn by a fan against the running original, and the Rust twin of the mover's `MoveActor` (about 1 ms per tick for the three fans of that map), are open there.
21. **Loading after more play and under other conditions.** The captures freeze the loaded level at its arrival (the class-default freeze, item 16) and compare the first frame: what a loaded level does over the next minutes (an NPC mid-patrol, a running timer, an active augmentation) was compared through the file's contents and Play's own two seconds of ticks, not against a live second measurement. `QuickLoad` while a conversation is on screen works in the original only after Escape (the save branch's `wc2`); Play was not run there.
22. **A loaded player saved crouched** *(done 2026-10-22)*: `UGameEngine::LoadMap`'s tail runs `Input->ResetInput()` for every viewport right after Login and the brush tracker (`0x1038dfe0..0x1038e004`), which zeroes the held keys and every `CPF_Input` byte and float of the player (`bDuck` 1 saved in `Save0021`); Play now does the same at the end of `loginPlayer`, and the loaded player of `Save0021` stands at Z -464.100006 after 60 ticks, bit for bit the original's dump ([script-input-reset](script-input-reset.md), `validate-load-input-reset`).

23. **The endings' real entries** *(step 5)*. The original was driven through `LocalTravel` (the console line is `SendPlayer`'s own `ClientTravel`; `MapExit.LoadMap` adds `ClearWindowStack` first, a no-op with no window open). Play was also driven through the `MapExit`s' own triggers (scenarios M1 to M3: `Actor.Trigger` on `MapExit0`/`MapExit1`, and
   Page's `Mission15.Timer` route from the flag `killpage`), which the original was not: Final's `MapExit0` is fired by `Dispatcher7` (the reactor sequence), `MapExit1` by `FlagTrigger3` on the flag `HeliosFree`, Page's by `Mission15.Timer` nine seconds after `killpage`; the flags' sources are conversation events, no console line sets a flag, and Final's `MapExit0`
   sits in solid space (no zone: a player placed on it falls out of the world, `ep6`), so it cannot be touched. Not measured in the original: the explosions of Page's sequence and the nine seconds.
24. **The endings from a played game** *(step 5)*. Measured once in the original (`ep10`: the internet slot `nicouzouf` Save0040, Final, 285 flags, a full inventory, loaded with `LoadGame 40`, then `LocalTravel 99_Endgame1`) and **equal in Play** after step 4's load (scenario L: the 719-class text for the endgame, the
   355-class text for DXOnly, the flags with `SKTemp_SkillPointsTotal` 28033, the 33 log lines). Not run: the other endings from a slot (Save0042 for Page), the real triggers from a slot (item 23), the augmentation and weapon states of a played game that Save0040 does not hold.
25. **The quotes-enabled credits** *(step 5)*. `bQuotesEnabled` is False unless the phrase `QUOTES` is typed during the credits with cheats on (`CreditsWindow.EggFound`, which also saves the config). Measured with the setting made by the console's `set` instead (`ep11`, Endgame2): the credits' end only plays `CreditsEnd`,
   `creditsEndSoundLength` (4 s) later `InvokeQuotesWindow` opens `QuotesWindow` (`SetClearStack(True)`, `SetLoadIntro(True)`), whose end clears the window stack and travels to `dxonly`; Play matches (scenario W: the timing, the texts, the flags). The phrase typed through the credits' `KeyPressed` and the easter-egg phrases `DANCEPARTY`
   (`OPEN 99_ENDGAME4`), `THEREISNOSPOON` and `IAMWARREN` are not reached.
26. **Log lines Play does not write** *(step 5)*. The captured logs hold, besides the modelled lines the validators compare: `DevAudio: Galaxy SetViewport`, `DevMusic: Load/Unregister music` (Title, Intro, Credits, Quotes, Area51 and Endgame music in the order the scripts ask), the window host's `Assigning Last Button Window` and `Tried to remove lastbuttonwindow descendant`, texture package
   loads and unloads, `Collecting garbage`/`Garbage`, `Shut down moving brush tracker` and `ScriptWarning` lines. Endgame2 logs four `ScriptWarning: TriggerLight 99_Endgame2.TriggerLight0 (Function Engine.TriggerLight.TriggerToggle.Trigger:002B) Accessed None` (three lights and `ShakeTrigger0`:
   `ConPlayBase.SetupEventTrigger` passes `lastActor`, None before the first speech); Play runs the same scripts but its runtime's `warning` service has no engine-log sink (the VM reports `Accessed None` to it, nothing writes the line; the offset the original prints is the code pointer after the context expression).
   The music and window-host lines are modelled in their own validators (galaxy music, window host), not compared here.
27. **The Play Intro confirmation** *(step 5)*. With a game running (`MissionNumber >= 0`, not Dying or Paralyzed) `MenuUIWindow.ConfirmIntro` asks first (`MB_Intro`); the logo map and DXOnly never ask. Not measured; Play runs the script.
28. **Level time of the endgame conversations** *(step 5)*: [explained and reproduced](#the-conversations-length-and-the-originals-actor-delta-clamp); the captured values are the capture machine's frame time, Play's at 60 Hz the nominal ones.

## Proposed implementation order for Play

Smallest first; each step is a vertical slice that ends at a check against the measured original, and every branch it does not implement stays an explicit boundary (a thrown, named stop like today's `ClientTravelBoundary`), never a substitute.
The reference scenarios are in `.work/travel/` (the travel texts, flags, listings and logs above); compare texts with the pointers (`Ptr=`, hex values) and the instance numbers of names normalized.

**0. Prepare (no behavior change).** *Done 2026-10-21 ([Play, steps 0 and 1](#play-steps-0-and-1)): the normalizer, the pure Browse decision with its branch-table test and `FURL` for `Map`/`Map#Portal`; the measured scenarios stay outside Git and `validate-travel.mjs` reads them.* Keep the measured scenarios as fixtures outside Git (the texts of `s2/s5-training-menu` (74 records), `r1/dx-to-combat` (96), `s1/n1-island-frozen` (79), `s1/n3-hq` (103); the flag tables; the save listings; the log lines) and write the normalizer.
Make `DDeusExGameEngine::Browse`'s decision a pure function of (`cur`, `next`, options, `bStartingNewGame`, file present) with a unit test of the cases in the [branch table](#which-branch-each-single-player-entry-takes), and port `FURL` for plain `Map` / `Map#Portal` URLs, throwing on the other forms ([Unresolved](#unresolved) 1).

**1. `SendPlayer` to `00_Training` from DX.dx's menu, no items.** *Done 2026-10-21 ([Play, steps 0 and 1](#play-steps-0-and-1)), with two differences from the plan below: d. is the page's own map change (one session per map) and not an in-place generalization of the Stage 3 reset, for the reasons given there; and `?restart` is in (its `loadonly` reload is the same map change).* The slice every menu entry needs. The Training button's script (`StartTrainingMission`) already runs on Play's VM; what it reaches is:
a. `PlayerPawn.ClientTravel` becomes the recovered native (`PreClientTravel`, then `SetClientTravel`: the viewport fields and `PreTravel` on every actor, as `OPEN` already does) instead of `TravelBoundary` (`script-runtime.mjs:3249`); `DeleteSaveGameFiles` (native 3012) empties Play's `Current` store (empty here).
b. The tick's travel step (`game.mjs clientTravel`) stops throwing: `TravelInfo` and `ExportTravel` (generic over `CPF_Travel` from the retail class metadata, `ExportText` for the property types of the samples), `TravelInfo.Set(PlayerName, text)`, `FURL(LastURL, TravelURL, TravelType)`, `Browse`.
c. `Browse` with the cases `cur != next` / `next == -1` / `loadonly` / `restart` (wipe, then `LoadMap`); no `Current` yet, so `PruneTravelActors`/`SaveCurrentLevel` stay a named boundary.
d. `LoadMap` of the next map in the same page: the Stage 3 reset that retires and collects the previous level ([LoadMap GC](script-loadmap-gc.md)) generalized from "player start" to "any map", `ULevel.TravelInfo = TravelInfo`, the cold begin-play pass ([startup scheduler](script-loadmap-startup.md)).
e. `SpawnPlayActor`'s three-pass import (above) with the `Login` before it ([player login](script-player-login.md)); the `FlagBase` records map onto Play's flag store (name, type, expiration, value; the bucket order the iterators see is the hash order, `ResetFlags` depends on it) and back.
**Check:** the exported text for the logo-map player at the Training button equals the measured one (74 records, no `AugmentationSystem` because `ResetPlayer(True)` removed it); at arrival the player's flags are `{PlayerTraveling}` before the first timer and
`{M00_TRAINING_StartupText, M0MissionStart}` after; `Mission00.FirstFrame`'s effects (the knocked-out troop, `UNATCOTroop2` -> carcass) appear without the host-supplied marker; the log-line order of the original's travel holds. The page then starts as the original does (`DX.dx`, the logo, `MenuMain`); the `?debug=1` HUD stays separate.

**2. Items.** *Done 2026-10-21 ([Play, step 2](#play-step-2-new-game-and-items)), with these differences from the plan below: the New Game path was measured through the real menus, and the console's `StartNewGame` stayed a cross-check of the starting text: `s1/n1-island-frozen` differs from the Escape capture `n1b` in `CombatDifficulty` (Medium), `bIgnoreNextShowMenu` (the Escape), the two `SKTemp_*` flags' values and the flag expirations (its player came from Training Combat: default expiration 1), and in nothing else, and a new capture of that path from the logo map through Combat (`nw4/n8`, without the Training hops that need step 3) is equal to it; Play's text after the console `StartNewGame` equals both after normalization (scenario H);
the "leaving HQ after play" text could not be reproduced (same-mission travel is step 3), so its structure is checked through the Street text of scenario F (the starting items, the three default augmentations, the picked-up items) and the Airfield text that follows it; the pickup-then-travel scene is F, and the conversation history is I (the Island's MeetPaul, with the weapon its choice transfers); weapon mods and a carried decoration are not covered.* `StartNewGame` (the New Game path; the console's `StartNewGame <map>` is a test input) and travel with a real inventory: the pistol, prod, medkit and keyring chain, belts, ammo, weapon mods, carried decoration, notes, goals, conversation history, images, augmentations and skills with their levels;
`Inventory.TravelPreAccept`/`GiveTo`, `DeusExWeapon.TravelPostAccept`, `Pickup.TravelPostAccept`, `AcceptInventory`. **Check:** the text after `StartNewGame` equals `n1-island-frozen`; the text leaving HQ after play equals `n3-hq`'s structure; export -> import -> export is a fixed point; a
pickup-then-travel scene against a new original capture with items the samples lack ([Unresolved](#unresolved) 2).

**3. Visited-map restoration (one mission's maps).** *Done 2026-10-22 ([Play, step 3](#play-step-3-visited-maps-restored)), with these differences from the plan below: the store is the save-directory interface (in memory; a browser store implements the same calls), and the file is the original's own `.dxs` layout, written by Play as an interim (export order and GUID differ, the original loads the one file tried, an Island);
Teleporter portals and `MapExit` (direct and `bPlayTransition`) run through the real scripts; `?restart` was step 1's.* The `Current` store and everything in `DDeusExGameEngine::Browse`'s mission logic: `PruneTravelActors`, `SaveCurrentLevel(-2)`, the file name from `DeusExLevelInfo.MapName`, wipe on a mission change, restore when filed, the warm `LoadMap` (no `BeginPlay`, level time restored) and the saved pawn's re-possession.
Play needs its own level snapshot (the object image: actors and their state, movers, timers, AI, level time, `TravelInfo`; the original's `SavePackage` of `MyLevel`); the store is the browser's (IndexedDB, quota and failure handling per roadmap §6). Teleporter portals (`FindPlayerStart(Portal)`), `MapExit` with
`bPlayTransition` (the `Interpolating` camera path and `InterpolateEnd`), `?restart`. **Check:** after each measured travel the store lists the files the original listed (names by `MapName`, one per left map, none after a mission change); a level restored by Play matches the original's restored level on a marker
set ([Unresolved](#unresolved) 5) and on the actor census; the restored log has no begin-play lines.

**4. Save and load.** `SaveGame` (`SaveInfo` object, `Current` copied to the slot, the live level with the player written into the slot), `QuickSave`/`QuickLoad` (`-1`), `LoadGame` (`?loadgame=N`: slot copied over `Current`, saved level loaded with `?load?loadonly?loadgame`, no travel import, `Login` skips
`ResetPlayerToDefaults`), `DeleteGame`, the `GameDirectory` natives 3080-3094 and the Load/Save screens (*done for the directory side, 2026-10-21*: [save-directory](save-directory.md); the store's `put`/`remove` are where `SaveGame` and `DeleteGame` land), the snapshot texture, `ConsoleCommand("SAVEGAME n")`; then export/import of a slot as a file, a format version, and the storage-failure messages.
**Check:** the slot's files equal the measured listing (`SaveInfo.dxs` + the copied maps + the live level), `SaveInfo` fields equal, save -> load -> state equality, and the Stage 5 death proof's load menu. *The save side is done 2026-10-22 ([saving](#play-step-4-saving)); the load side too ([loading](#play-step-4-loading-a-saved-game)): `?loadgame=N`, the Load Game screen's button, QuickLoad and the load menu after a death, checked against slots the original wrote, the old desktop slots and 41 real slots from the internet; the slot as a file in or out of the browser is [save storage](save-storage.md).*

**5. The remaining entries and the campaign.** *First part done 2026-10-22 ([Play, step 5](#play-step-5-first-part-play-intro-credits-dxonly-and-the-endings)): the menu's Play Intro and Credits, the intro to `dxonly`, DXOnly and its menu, the three endings to the credits and back. Second part done 2026-10-23 ([every map-to-map transition](#play-step-5-second-part-every-map-to-map-transition-of-the-campaign)): the Hong Kong `MapExit` pairs, the four `MapExit`s without a destination, the mission `PreTravel`s and the two scripted `SendPlayer`s, the 198 transitions of the installed maps driven in Play and the families of them measured under Wine; open: the death route (step 4's), the per-mission checklist.* The intro and endgames (`MissionIntro`/`MissionEndgame` set `PlayerTraveling` themselves), credits and `dxonly`, death -> `DXONLY` -> menu, the Hong Kong `MapExit` pairs, the four `MapExit`s without a destination, the mission-specific `PreTravel`s (`Mission02/08/10`), and the per-mission compatibility
checklist of roadmap §6 (conversations, flags and exits of each of the 15 missions, using the census above).
