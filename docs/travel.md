# Map travel in the original (single-player)

Research for Stage 6 ([roadmap §6](roadmap.md#6-persist-progress-and-complete-the-campaign)), 2026-10-21. This page is the source of truth for
how the original game moves the player between maps, what it carries and what it saves. Steps 0 and 1 of the
[implementation order](#proposed-implementation-order-for-play) are in Play ([what runs, what was checked, what still stops](#play-steps-0-and-1)):
the main menu's Training button on the logo map travels to `00_Training` with no items. Step 2 is too ([New Game and items](#play-step-2-new-game-and-items)):
New Game runs the real menu screens, the intro, `PostIntro` and `StartNewGame` and arrives on `01_NYC_UNATCOIsland` with the starting inventory, and the
texts, flags and log of that path and of three item scenarios equal captures of the original. Every other branch stops at a named boundary
([where Play stops](#where-play-stops-today)).

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
`UpdateTimeStamp()`; `bCheatsEnabled`; a 160 x 120 `Snapshot` texture through `XRootWindow::GenerateSnapshot` unless the render device is `OpenGLDrv.OpenGLRenderDevice`); a new slot (Position 0) takes `XGameDirectory::GetNewSaveFileIndex`;
`DeleteSaveGameFiles(dest)`; `CopySaveGameFiles(<SavePath>\Current, dest)` (every `*.dxs`); `SavePackage(package, saveInfo, 0, dest\SaveInfo.dxs, GWarn, NULL)`; `SaveCurrentLevel(saveInfo->DirectoryIndex, 0)`
(the level the player is in goes **into the slot**, with the player, not into `Current`).

`DeusExSaveInfo` (`DeusEx/DeusExSaveInfo.uc`, native object, `UDeusExSaveInfo`): `Year, Month, Day, Hour, Minute, Second` (`+0x28..+0x3c`), `DirectoryIndex` (`+0x40`), `Description` (`+0x44`), `MissionLocation` (`+0x50`),
`MapName` (`+0x5c`), `Snapshot` (`+0x68`), `saveCount` (`+0x6c`), `saveTime` (`+0x70`), `bCheatsEnabled` (`+0x74` bit 0). `LoadSaveInfo(index)` (`0x100108a0`) maps -2/-1/*n* to `Current`/`QuickSave`/`Save%04d`, loads
`<dir>\SaveInfo.dxs` and returns the `MyDeusExSaveInfo` object (`StaticLoadObject`), stamping `DirectoryIndex`. `DeleteSaveGameFiles(dir)` (`0x10010360`) releases the level package's loaders (`ResetLoaders`), takes `dir == ""` as
`<SavePath>\Current`, and deletes every file in it (`FindFiles("<dir>\*.*")`; the directory itself stays). `CopySaveGameFiles(src, dst)` (`0x10010000`) copies every `*.dxs` of `src` to `dst`.
`DeleteGame(n)` (`0x10010710`) deletes slot *n*.

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
| Endgames, credits, `dxonly`, `dx` | `-1` for `dx`/`dxonly`, 99 for the endgames | wipe | empty | travel text |
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

**The chain in Play.** The page's `?boot=1` starts DX.dx; Escape (User.ini's `Escape=ShowMainMenu`) opens `MenuMain`; the Training button (a click, or `winButtons[4]` through the menu driver)
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
| the page (`?boot=1`, worker mode) | a click on Training arrives in `00_Training` with "UNATCO Training Facilities / Continental United States" and the flags, carcass above; no runtime error |
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
* `FURL` forms other than `Map`, `Map#Portal`, `?options`: `.dx` suffixes, a space before `#` (three installed `MapExit`s), paths;
* the travel text's property kinds that were not measured: vectors, rotators, dynamic arrays, strings with newlines, class properties (`UnsupportedTravelPropertyError`, `UnsupportedTravelImportError`); flags other than bool and int; **items are not verified** (step 2): the exporter and importer are generic over `CPF_Travel`, but only the no-item texts were compared;
* `DeleteSaveGameFiles` of a directory (save slots), `SaveGame` (native 3011), `LoadGame`, the other menu entries (Play Intro, Load Game, Credits; New Game is [step 2](#play-step-2-new-game-and-items)).

## Play, step 2: New Game and items

2026-10-21. The [order](#proposed-implementation-order-for-play)'s step 2: the New Game path through the original scripts and the player's carried state, checked against new captures of the original under
Wine. The path itself needed no change in the travel code: steps 0 and 1 had built the chain, and what was left was to drive it through the real screens and compare. Two bodies the item scenarios reached were
missing and are now in (below).

**The path in Play** (`?boot=1`, Escape, then a click on each control; `scripts/validate-travel-newgame-play.mjs`, and the headless `validate-travel-newgame.mjs` through the menu driver):

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
| the page (`?boot=1`, worker mode) | real clicks on New Game, No, Medium and Start Game; the intro plays (letterbox, subtitles); Escape, or `--natural` the intro's own end, then the Island with the belt and the flags above; no runtime error |
| not regressed | `validate-travel` (A, B, C), 691 unit tests, the Stage 5 replays and the intro checks listed under "Verified not regressed" below |

**Property kinds the measured texts carry**, each now checked against one: Int (`Credits`, `SkillPointsTotal`, `invPosX`, `NumCopies`, `ClipCount`, `AmmoAmount`), Float (`CombatDifficulty`, `ModBaseAccuracy`, `saveTime`, `LastConEndTime`), Bool (`bIgnoreNextShowMenu`, `bInObjectBelt`, `bHasLaser`, `bHasIt`), Byte and enum (`flagType`), Byte array (`invSlots[i]=1`), Name (`goalName`, `KeyID`), Str
(`TruePlayerName=Test Agent`, `Text="Goal B"`, `Description="Key two"`, note texts: written as the console took them, quotes included), Object and object arrays (`Inventory`, `FirstGoal`, `FirstImage`, `hashTable[i]`), Struct array (`AugLocs[i]=(AugCount=n)`).
(`conOwnerName=Paul Denton`, `strLocation=NYC - Liberty Island`, the speech strings: scenario I.) A survey of every `CPF_Travel` property of the shipped DeusEx, Engine and Extension classes shows these are all but three: a `Name[]` (`AugmentationCannister.AddAugs`), the vector and rotator values of `FlagVector`/`FlagRotator`, and strings that hold a newline (the `\` rule is read from the exporter, not seen).
Those three stay named stops (below).

**Still a named stop after step 2:**

* the three property kinds above; weapons with mods, a carried decoration, charged pickups' state and an item with a `Charge` the scenarios did not change (the generic kinds they use are covered; the classes were not exercised);
* every Browse branch but the wipe and `?restart`: same-mission travel and visited-map restoration are step 3, loadgame is step 4; the other menu entries (Play Intro, Load Game, Credits);
* `bAskedToTrain` is saved by `SaveConfig` as the original does, and Play's config is not persisted across page loads yet ([script config](script-config.md): save/profile work): a reloaded page asks "train first?" again.

**Verified not regressed** (2026-10-21, at the step's last commit): 691 unit tests; `validate-travel` (A, B, C) and `validate-travel-play`; the validators of the code the step touched (`--filter console`: 4, `native-config`: 2, `class-import`, `script-config`, `window-list`: 16, `window-typed`: 3, `gc-underline`, `settings`: 2); the Stage 5 live replays `cad1` and `key1` (Training) and `cmb1` and `die1`
(Island, the level end after tick 1931 in both); and the intro's gate row 4.5.7 (`validate-stage4-acceptance.mjs --only '^4\.5\.7$'`, 214 s: the intro's CameraPoint shots and `native-find-base`).

## Where Play stops today

* `PlayerPawn.ClientTravel` in a session without `travel` (every validator, census and live replay): `TravelBoundary` (`travel-boundary.mjs`) with the URL, type and `bItems`; with `travel` (the page): the recovered native, then the tick's step as above.
* The console `OPEN` (`bItems` 0, `TRAVEL_Partial`): `SetClientTravel` as recovered; the tick's step throws `ClientTravelBoundary` without `travel` and with a live replay ([Stage 5 death proof](stage-5-exit-criteria.md#the-players-death-to-the-levels-end-2026-10-18)), and travels with it (`OPEN DX` and `OPEN DXONLY` are the `next == -1` wipe).
* `PlayerTraveling`: a **host input for a cold open only** (Play's login supplies the fresh-mission marker, [Stage 3 exit criteria](stage-3-exit-criteria.md); Stage 5's replays delete it first); a map entered by travel gets it from the travel text, and a restart has none.
* In the page: the logo map's Training and New Game travel (`00_Training`; `00_Intro`, then the Island by Escape or the intro's end). Same-mission travel (`MapExit`, `Teleporter`: `PruneTravelActors`, `SaveCurrentLevel(-2)`, a filed level restored) throws `TravelStop` at the `Browse` branch,
  after the text is exported; `?loadgame=`, Play Intro (`dxonly`), Credits and Load Game are the later steps; an arrival whose text holds a class the import cannot construct stops in pass 1 by name (`UnsupportedTravelImportError`).

## Unresolved

Each item is **unverified** or unread; none blocks the first two steps of the [order](#proposed-implementation-order-for-play) except where said.

1. **`FURL` parsing.** The travel-type branches are read (`0x103f7b60`); the installed forms were exercised, not traced: `.dx` suffix, a space before `#` (the map keeps the trailing space and still loads) and the portal split ([measured](#load-game-restart-and-url-forms)).
   Not read: how the parser trims or resolves the map for the file lookup, the default options it adds (`URL: Adding default option Name=Player`, `Class=DeusEx.JCDentonMale` from `[DefaultPlayer]`; `LoadURLConfig`/`SaveURLConfig` at `0x103f9bc0`/`0x103f9cb0` and the end of
   `LoadMap`, `0x1038e32c..0x1038e3c1`), and which start spot a `Map#Portal` picks when two teleporters share a tag. A port can start from the measured outputs (Map, Portal, Op) for the 21 + 149 installed destinations. *Step 0 ported the plain forms (`furl.mjs`); the `.dx` suffix, the space before `#`, paths and hosts are refused by name until they are traced.*
2. **ExportText / ImportText formats.** Only what the samples show is established: ints, bools, names, `FLAG_*` enum names, a struct (`AugLocs[6]=(AugCount=3)`), floats (`saveTime=67.075813`), object references (`%08x name`). Not sampled: vectors, rotators,
   strings with newlines (the `\` rule is read, not seen), byte arrays (`invSlots[30]`), `Conversation`/`Note`/`Goal` lists, inventory with mods, a carried decoration. *Step 2 measured the byte array (`invSlots[0..3]=1`), notes, goals, keys, images, strings typed or taken from the console, non-default weapon, ammo and pickup properties and the belt positions of real pickups ([Play, step 2](#play-step-2-new-game-and-items)); and the conversation history (`ConHistory` with 16 `ConHistoryEvent`s, scenario I); inventory with mods, a carried decoration, a `Name[]`, flag vectors and rotators and strings with a newline are still not sampled.* A played save's travel text (weapons with mods, ammo, notes, goals, images, history) is the next reference. *Step 1 implements bool, int, float, byte and enum, name, string, struct and object properties (`travel-export.mjs`/`travel-import.mjs`; the first six through `config-text.mjs`'s Core-verified bodies), matched by the two measured texts; every other kind stops by name.*
3. **`PruneTravelActors`** destroys the managers, the flag base and the carried decoration but leaves the pawn and its inventory in the saved level (measured: the `.dxs` holds `JCDentonMale<N>` and its items). The saved pawn is then re-possessed
   on restore (measured: one pawn); which of its saved properties survive, in what order the travel text overwrites them, and why `GameInfo.Login`'s name test accepts it (`PlayerName != PlayerReplicationInfo.default.PlayerName`)
   are not traced. The effect on the restored level's actor list (a leaked pawn per visit?) was not counted.
4. **The `.dxs` format.** `SavePackage` writes a normal version-68 package (read by `parsePackage`); what the saved properties contain for each class (all non-default properties of every actor, state frames, the native tail of `Level` and movers) is not decoded.
   Play needs its own snapshot of the Rust object image ([order](#proposed-implementation-order-for-play), step 3); compatibility with original desktop saves is a separate decision (roadmap §6).
5. **Level state after a restore.** Measured: destroyed actors stay destroyed and a carcass made before the leave persists ([below](#restoring-a-level-what-the-log-shows)). Not measured: that a mover keeps its position (`SavedPos` is reset to -1 after the save, `0x1000fec6`),
   that timers, `AI` state, held doors and dropped items continue, that conversations already played stay played. The first marker tried (a summoned item) never spawned: `summon` and `KillAll` need `bCheatsEnabled` (`DeusExPlayer.uc:2075,5400`;
   `set DeusEx.JCDentonMale bCheatsEnabled True`).
6. **Startup and menu.** `UGameEngine::Init`'s first `Browse` (why the game boots `DX.dx` whatever the command line says), the first appearance of `MenuMain` on the logo map (measured: a click over the playing logo cinematic opens it, an Escape posted through `dxinput` did not within 4 s; the code that decides is the `Interpolating` state's
   `Fire`/`ShowMainMenu`, `DeusExPlayer.uc:4162..4165`, and the logo map's own `TravelPostAccept` hack, `:616..640`), and the menu buttons' handlers other than Training and New Game (measured: the Training button starts the level at once, no prompt; New Game goes to the difficulty screen when `bAskedToTrain` is True, then the New Game screen, Start Game and the intro: *step 2*; the "train first?" box of a False `bAskedToTrain` was measured once, `nw3`) are not traced.
7. **`LastURL`.** The engine's `LastURL` (`+0x74`) is assigned in the load-game and saved-level branches of `DDeusExGameEngine::Browse`; the plain local-map success path does not assign it (`0x10011cb6`), and `LoadMap` does not either (no `FURL::operator=` in its body). Where else it is set is not read. It only feeds
   the base of the next `FURL` (protocol, host, port; options for `TRAVEL_Partial`), so a wrong value shows only through `OPEN`'s inherited options.
8. **`ULevel::Serialize`.** `TravelInfo` is serialized with the level (measured through a loaded game); the rest of the level's serialized native state (`Model`, `ReachSpecs`, `TextBlocks`, `TimeSeconds`, `iFirstDynamicActor`) is not read here.
9. **Failure paths**: `LoadMap` returning null in `DDeusExGameEngine::Browse` (the old map is reloaded by name, `0x10011e38`), `AbortToEntry`, a `TravelURL` with an unknown map. Single-player content never reaches them; Play should report them and stop.
10. **The object registry after a travel.** The arrival's objects take the slots of the map's open-capture seed (`mapRegistrySeed`), where the original's LoadMap collects the previous level in one registry (measured: `Garbage: objects: 35229->35017`). The registry indices of the arrival's actors, the player's sound channel ids that follow from them, and the object names' instance counters (`JCDentonMale8` against Play's `JCDentonMale0`) therefore differ from the original's: **unverified**, and not needed until a replay compares a travelled level's streams.
11. **LoadMap's retire step across maps.** `NotifyLevelChange` and the old player's `DestroyActor` do not run (the old session is dropped with its frame still in flight); the original runs them in the old world, where their effects are the level's own. Whether anything they do reaches the next level (the audio subsystem's channels, the cache) is **unverified**.
12. **`ExportText`'s details.** `UStructProperty::ExportTextItem`'s `Port()` filter was not read (every member that differs from the default is written, which matches `AugLocs[6]=(AugCount=3)`); a string with a newline (the `\` rule) is an assumption (it stops the export by name); the property kinds that are not in the measured texts stop the export by name.
13. **The cold open's `Login` options.** The original's boot URL carries `?Name=Player?Class=DeusEx.JCDentonMale`, so its cold `Login` prints `Login: Player`; Play's cold open passes no options (`Login: `), which a travel arrival does not share. Changing the cold path would touch the Stage 3 gates, so it was left.
14. **Not single-player, left unsupported**: `ServerTravel`/`ProcessServerTravel`, `PreClientTravel` for remote clients, `NM_Client` pending levels, the `?push`/`?pop`/`?peer` options and the `Game%04i.dxs` pushes in `LoadMap`, the developer `UDumpLocation` file branch of `DeusExGameInfo.Login`, `LoadMapWindow`'s `?loadonly` opens.
15. **The conversation history in the travel text** *(was open at the start of step 2)*. Measured once, the Island's MeetPaul (`nw5`) and ported: Play's export and import equal the original's (scenario I). Not measured: a history after several conversations or an InfoLink's (`bInfoLink`), an event whose speech holds a newline, and the sound ids across levels (`soundID` is exported as the original wrote it).
16. **The captures' freeze is a class default, Play's a typed line.** The captures carried `set LevelInfo bPlayersOnly True` into each new level through the class default; Play types the same line in the arrived session before its first frame (`scriptClassSet` imports into the level's live actors and into the class defaults, as `UObject::GlobalSetProperty` does). The two freeze the same actors (the intro's player stays `PlayerWalking` in both), but the equivalence of carrying a default across a `LoadMap` with typing after it is assumed, not traced.

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

**3. Visited-map restoration (one mission's maps).** The `Current` store and everything in `DDeusExGameEngine::Browse`'s mission logic: `PruneTravelActors`, `SaveCurrentLevel(-2)`, the file name from `DeusExLevelInfo.MapName`, wipe on a mission change, restore when filed, the warm `LoadMap` (no `BeginPlay`, level time restored) and the saved pawn's re-possession.
Play needs its own level snapshot (the object image: actors and their state, movers, timers, AI, level time, `TravelInfo`; the original's `SavePackage` of `MyLevel`); the store is the browser's (IndexedDB, quota and failure handling per roadmap §6). Teleporter portals (`FindPlayerStart(Portal)`), `MapExit` with
`bPlayTransition` (the `Interpolating` camera path and `InterpolateEnd`), `?restart`. **Check:** after each measured travel the store lists the files the original listed (names by `MapName`, one per left map, none after a mission change); a level restored by Play matches the original's restored level on a marker
set ([Unresolved](#unresolved) 5) and on the actor census; the restored log has no begin-play lines.

**4. Save and load.** `SaveGame` (`SaveInfo` object, `Current` copied to the slot, the live level with the player written into the slot), `QuickSave`/`QuickLoad` (`-1`), `LoadGame` (`?loadgame=N`: slot copied over `Current`, saved level loaded with `?load?loadonly?loadgame`, no travel import, `Login` skips
`ResetPlayerToDefaults`), `DeleteGame`, the `GameDirectory` natives 3080-3094 and the Load/Save screens (script-window-list-family already runs them), the snapshot texture, `ConsoleCommand("SAVEGAME n")`; then export/import of a slot as a file, a format version, and the storage-failure messages.
**Check:** the slot's files equal the measured listing (`SaveInfo.dxs` + the copied maps + the live level), `SaveInfo` fields equal, save -> load -> state equality, and the Stage 5 death proof's load menu.

**5. The remaining entries and the campaign.** The intro and endgames (`MissionIntro`/`MissionEndgame` set `PlayerTraveling` themselves), credits and `dxonly`, death -> `DXONLY` -> menu, the Hong Kong `MapExit` pairs, the four `MapExit`s without a destination, the mission-specific `PreTravel`s (`Mission02/08/10`), and the per-mission compatibility
checklist of roadmap §6 (conversations, flags and exits of each of the 15 missions, using the census above).
