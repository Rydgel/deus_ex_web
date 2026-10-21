# Native census

The question this answers: which of the original game's script natives does Play handle, which can a shipped script
call that it does not, and where will "Unsupported original native N" come from next? Before this page the answer was a
grep for index literals, which misses natives a dispatcher routes through a named constant, a table or a range, and an
older hand-kept catalogue (`scripts/inventory-script-runtime.mjs`) that had stopped running. Now the answer is data that a
test keeps true.

A **native** is a script function declared `native` in a shipped package (`System/*.u`): 891 of them, 806 with an index
(`native(N)`) and 85 bound by name (no index; the engine finds the C++ function by class and name). Play reaches the
handling code of a native through one function, `ScriptRuntime.invokeNative`, except for the VM's own primitive operators and
the foreach iterators. Every native gets one status:

| status | meaning |
|---|---|
| `handled` | some dispatcher of Play routes it (a branch exists; the branch's own validator is the evidence of its fidelity, and `partial`/`when` in the registry say which receivers or sessions it covers) |
| `missing-reachable` | no dispatcher routes it and a shipped script can call it. `reach` says from what: **game code** (DeusEx, Extension, ConSys functions), **engine base** (only Engine.u classes: base code DeusEx may override or never run), **developer tools** (only the cheat and debug windows) |
| `missing-unreachable` | no dispatcher routes it and no shipped script calls it |
| `excluded` | no dispatcher routes it and it belongs to a part of the game the project defers: **stage-6** (saves, GameDirectory: [roadmap section 6](roadmap.md), [travel](travel.md)), **multiplayer** (last priority, AGENTS.md; also UT's server browser and window packages, which `DeusEx.ini` lists under `[Editor.EditorEngine] EditPackages` only), **editor** (map building) |

## Method

1. **Declarations.** `scripts/native-reachability.mjs` reads every `System/*.u` package and collects each `Function` export
   with `FUNC_Native` (0x400) and its native index (`script-metadata.mjs`). Index 2054 is declared twice (ConEvent.GetSoundLength
   and Conversation.ClearBindEvents, both in ConSys); Play routes the index to ClearBindEvents and no script calls
   ConEvent.GetSoundLength.
2. **What Play handles: the registry.** `src/runtime/native-registry.mjs` lists, for each place that routes a native (22
   entries: the VM primitives, `invokeNative`, `createIterator`, the window host and its seven leaf dispatchers, Play's
   `nativeCall`, the ConPlay and FlagBase handlers, the log, dump, travel, HUD and overlay wrappers), the indices and function
   keys its code routes. It adds the Rust layer (below) and the latent polls. `handledNatives()` is the union.
   `test/native-registry.test.mjs` (part of `npm test`) reads each dispatcher's code with `scripts/native-dispatch-parse.mjs`
   (comments and string contents blanked; `index === N`, `[..].includes(index)`, `index >= A && index <= B`, `case N:`,
   `[N, handler]` table rows, named constants, `call.record.key === 'pkg.class.fn'`) and compares in both directions: a native
   the code routes and the registry omits fails, a native the registry lists and the code does not route fails. A run-time
   lookup by index (`set.has(index)`) must be declared too, so a new form of dispatch cannot hide. A range that only forwards to
   a child dispatcher is a declared `gate`; the child's `case` labels are the routes. Every source file that reads `call.index`
   must be a registered site or be named in `NOT_DISPATCHERS` with its reason. The check found, when first run, that the
   old catalogue named a dispatch site that no longer existed.
3. **The Rust side.** native/script-vm does not route natives of its own: the JavaScript lowering (`script-vm-lower.mjs`)
   emits a Rust kind only where the runtime's own `invokeNative` case would run, and the kind transcribes that case.
   `RUST_LOWERED_NATIVES` (95 indices: Core's operators, increments and compound assignments, vector and rotator operators, IsA,
   the short-circuit pair, the perception natives 705/2105/2107, GetStateName/LastRendered/InStasis, the eight GC natives gc.rs
   runs) plus the AI event manager (650, 710, 711, 713-716, `aievent.rs`) are 102 natives; the test requires every one to have a
   JavaScript dispatcher. The rest of a script's natives cross to JavaScript host imports.
4. **Who can call a native.** The same module decodes every function and state body (`bytecode.mjs`) and records a call by
   (a) a native token (the compiler emits one for every numbered native, in a context call too), (b) a final call to the
   declaration (exact), (c) a virtual or global call by name, matched to a name-bound native whose class is the caller's
   class, an ancestor (the nearest declaration wins, as virtual dispatch does) or a descendant, and (d) a context call
   `obj.Name()`, whose receiver class is read from the context expression where it is a typed variable, `self` or a cast
   (that cut `Actor.ConsoleCommand` and `Console.ConsoleCommand`, which the menus call as `player.ConsoleCommand` and so reach
   `PlayerPawn.ConsoleCommand`, from 148 and 132 call sites to 19 and 20, one DeusEx function among them), else matched by name
   alone.
   A caller is a function of the shipped packages, so a call in code no map ever runs still counts: the result
   over-approximates "can run".
5. **Which callers count.** Caller kinds (regular expressions on `Package.Class.Function` in `scripts/census-natives.mjs`):
   `editor`, `multiplayer` (IpDrv, IpServer, UWindow, UBrowser, DeusEx's lower-case multiplayer menus and links, StatLog,
   MapList), `saves` (the save and load screens, quick save/load), `developer` (BehindTheCurtain, the DumpLocation, flag
   and tool windows, the debug console functions), `engine` (other Engine.u), `game` (everything else). A native is
   `excluded` when it is declared in Editor/IpDrv/StatLog/GameDirectory/DeusExSaveInfo or when every caller is editor,
   multiplayer or saves code.
6. **The probe.** `scripts/probe-natives.mjs` boots 00_Training headlessly and sends every declared native through the
   live `invokeNative` chain (or `createIterator`) with no receiver and no arguments. A routed native answers with its own
   refusal (an argument count, a missing receiver); an unrouted one ends at "Unsupported original door native N" (or the chain's
   other last refusals). This is independent of the parser: **885 of 890 index/name slots agree** with the registry. The five
   that differ are exactly the registry's conditional and receiver-scoped entries (3012 needs a travelling session, 467 the
   overlay recording, 264/283/298 a receiver with a global object index, identity or collision view). Run it with
   `node scripts/probe-natives.mjs` then `node scripts/census-natives.mjs --probe .work/native-probe.json`.
7. **The menu sweep.** `scripts/census-ui-menus.mjs`; see [The menu sweep](#the-menu-sweep).

## Numbers and lists

Generated by `node scripts/census-natives.mjs --doc docs/native-census.md --probe .work/native-probe.json` (everything between
the markers; the JSON report with every native, its callers and the probe outcome is `.work/native-census.json`).

<!-- census:begin -->

### Numbers

| package | declared | handled | missing-reachable | missing-unreachable | excluded |
|---|---|---|---|---|---|
| ConSys | 11 | 10 | 1 | 0 | 0 |
| Core | 165 | 131 | 4 | 25 | 5 |
| DeusEx | 57 | 17 | 19 | 3 | 18 |
| DeusExText | 12 | 12 | 0 | 0 | 0 |
| Editor | 13 | 0 | 0 | 0 | 13 |
| Engine | 158 | 85 | 20 | 29 | 24 |
| Extension | 453 | 372 | 16 | 65 | 0 |
| IpDrv | 22 | 0 | 0 | 0 | 22 |
| **all** | **891** | **627** | **60** | **122** | **82** |

### Dispatchers

| dispatcher | layer | natives routed | source |
|---|---|---|---|
| vm-primitives | vm | 115 | src/runtime/script-vm.mjs |
| runtime-invoke | runtime | 149 (+ forwards ranges) | src/runtime/script-runtime.mjs |
| runtime-iterator | runtime | 10 | src/runtime/script-runtime.mjs |
| pawn-alliance | runtime | 3 | src/runtime/script-pawn-alliance.mjs |
| window-tile | runtime | 11 | src/runtime/script-window-tile.mjs |
| text-parser | runtime | 12 | src/runtime/script-text-parser-natives.mjs |
| window-host | window-host | 7 (+ forwards ranges) | src/runtime/script-window-host.mjs |
| window-sound | window-host | 1 | src/runtime/script-window-sound.mjs |
| window-actor-refs | window-host | 3 | src/runtime/script-window-actor-refs.mjs |
| console-command | window-host | 1 | src/runtime/script-input-console.mjs |
| window-list | window-host | 69 | src/runtime/script-window-list.mjs |
| window-edit | window-host | 32 | src/runtime/script-window-edit-natives.mjs |
| window-gc | window-host | 49 | src/runtime/script-window-gc-dispatch.mjs |
| window-host-natives | window-host | 133 | src/runtime/script-window-host-natives.mjs |
| play-native | play-host | 14 | src/runtime/script-doors.mjs |
| conplay | play-host | 7 | src/runtime/script-conplay-live.mjs |
| triggers | play-host | 16 | src/runtime/script-triggers.mjs |
| player-log | play-host | 1 | src/runtime/script-player-log.mjs |
| player-dump | play-host | 2 | src/runtime/script-player-dump.mjs |
| travel | play-host | 1 | src/runtime/script-travel.mjs |
| play-hud | play-host | 4 | src/runtime/script-play-hud.mjs |
| weapon-overlay | play-host | 1 | src/viewer/weapon-overlay-sim.mjs |

Handled only under a condition or for some receivers (27):

- 2051 ConSys.Conversation.CreateConCamera: a live ConPlay/DataLinkPlay owns the receiver; a Conversation receiver
- 3002 DeusEx.DeusExPlayer.CreateHistoryObject: a live ConPlay/DataLinkPlay owns the receiver
- 3003 DeusEx.DeusExPlayer.CreateHistoryEvent: a live ConPlay/DataLinkPlay owns the receiver
- 3012 DeusEx.DeusExPlayer.DeleteSaveGameFiles: a session that travels (the save store)
- 262 Engine.Actor.SetCollision: actors with the spawn collision view; the map actors with the native flag word are play-native's; a map actor with the native +0x1dc flag word (script-actor-collision.mjs)
- 264 Engine.Actor.PlaySound: a live ConPlay/DataLinkPlay owns the receiver; Play declares 264 a host boundary native (script-doors.mjs boundaryNatives), so this body serves harnesses; Play's PlaySound is the play-native one; an emitter with a measured or modeled global object index plays through Galaxy; another is a recorded no-audio boundary; the speech PlaySound of ConPlay and DataLinkPlay
- 268 Engine.Actor.SetInstantSoundVolume: a live ConPlay/DataLinkPlay owns the receiver
- 269 Engine.Actor.SetInstantSpeechVolume: a live ConPlay/DataLinkPlay owns the receiver
- 270 Engine.Actor.SetInstantMusicVolume: a live ConPlay/DataLinkPlay owns the receiver
- 283 Engine.Actor.SetCollisionSize: same receivers as SetCollision; a map actor the host holds an identity for
- 298 Engine.Actor.SetBase: collision-view actors and map actors of an Actor class
- 467 Engine.Canvas.DrawActor: only while the first-person overlay is recorded
- 3970 Engine.Actor.SetPhysics: attached non-mover actors; a mover only for an equal Physics (script-doors.mjs); only a mover asking for the Physics it already has
- 1100 Extension.FlagBase.SetBool: the player's FlagBase (the receiver must be the bound store)
- 1102 Extension.FlagBase.SetInt: the player's FlagBase (the receiver must be the bound store)
- 1110 Extension.FlagBase.GetBool: the player's FlagBase (the receiver must be the bound store)
- 1112 Extension.FlagBase.GetInt: the player's FlagBase (the receiver must be the bound store)
- 1120 Extension.FlagBase.CheckFlag: the player's FlagBase (the receiver must be the bound store)
- 1121 Extension.FlagBase.DeleteFlag: the player's FlagBase (the receiver must be the bound store)
- 1122 Extension.FlagBase.SetExpiration: the player's FlagBase (the receiver must be the bound store)
- 1124 Extension.FlagBase.DeleteExpiredFlags: the player's FlagBase (the receiver must be the bound store)
- 1125 Extension.FlagBase.SetDefaultExpiration: the player's FlagBase (the receiver must be the bound store)
- 1126 Extension.FlagBase.CreateIterator: the player's FlagBase (the receiver must be the bound store)
- 1127 Extension.FlagBase.GetNextFlagName: the player's FlagBase (the receiver must be the bound store)
- 1128 Extension.FlagBase.GetNextFlag: the player's FlagBase (the receiver must be the bound store)
- 1129 Extension.FlagBase.DestroyIterator: the player's FlagBase (the receiver must be the bound store)
- 1130 Extension.FlagBase.DeleteAllFlags: the player's FlagBase (the receiver must be the bound store)

### Missing and reachable

#### From game code (DeusEx, Extension, ConSys) (11)

**window: root and player** (3)

| native | called from | note |
|---|---|---|
| 1050 Extension.PlayerPawnExt.PreRenderWindows | Extension.PlayerPawnExt (PreRender) | Called by the PreRender event; Play paints the windows from its own render path (src/runtime/script-play-hud.mjs), so the script event is not dispatched. |
| 1051 Extension.PlayerPawnExt.PostRenderWindows | Extension.PlayerPawnExt (PostRenderFlash) | Called by the PostRenderFlash event; same as PreRenderWindows. |
| 1524 Extension.RootWindow.GenerateSnapshot | DeusExRootWindow (ShowSnapshot); MenuScreenSaveGame (GenerateNewSnapShot) | DeusExRootWindow.ShowSnapshot, which UIPauseGame calls whenever the UI pauses the game; the save screen calls it for its preview. |

**actor** (2)

| native | called from | note |
|---|---|---|
| 722 Engine.Actor.ParabolicTrace | ScriptedPawn (AISafeToThrow, GetProjectileList) | ScriptedPawn.AISafeToThrow and GetProjectileList: an NPC deciding to throw a grenade or avoid a projectile. |
| by name Engine.Actor.PlayOwnedSound | DeusExWeapon (PlaySimSound, SpawnEffectSounds); Engine.PlayerPawn (DoJump, Dodge) | DeusExWeapon.PlaySimSound (called by Fire, ClientFire and PlayFiringSound) and SpawnEffectSounds: a fired weapon, not a rare path. |

**window: graphics context** (2)

| native | called from | note |
|---|---|---|
| 1288 Extension.GC.DrawActor | ActorDisplayWindow (DrawWindow); AugmentationDisplayWindow (DrawVisionAugmentation) | The vision augmentation (AugmentationDisplayWindow) and the actor display window. |
| 1295 Extension.GC.ClearZ | ActorDisplayWindow (DrawWindow) |  |

**conversation** (1)

| native | called from | note |
|---|---|---|
| 2050 ConSys.Conversation.CreateFlagRef | ConSys.Conversation (AddFlagRef) | Only Conversation.AddFlagRef calls it, and no script calls AddFlagRef: the conversation import does (Play loads conversations through script-native-conversation-list.mjs). |

**developer: DumpLocation** (1)

| native | called from | note |
|---|---|---|
| 3038 DeusEx.DumpLocation.LoadLocation | DeusExGameInfo (Login); DumpLocationListLocationsWindow (ViewDumpLocation) | DeusExGameInfo.Login calls it only when HasLocationBeenSaved (3039, handled) is true (docs/travel.md); the DumpLocation windows call it too. |

**player (DeusExPlayer)** (1)

| native | called from | note |
|---|---|---|
| 3014 DeusEx.DeusExPlayer.CreateDataVaultImageNoteObject | PersonaImageWindow (MouseButtonReleased) |  |

**window** (1)

| native | called from | note |
|---|---|---|
| 1449 Extension.Window.ConvertCoordinates | HUDObjectSlot (MouseMoved); PersonaInventoryItemButton (MouseMoved); PersonaScreenInventory (UpdateDragMouse) | Inventory drag and drop (the item buttons and the belt slots). |

#### Only from Engine base classes (18)

**canvas** (4)

| native | called from | note |
|---|---|---|
| 464 Engine.Canvas.StrLen | Engine.Console (PrintActionMessage, DrawConsoleView, ...) |  |
| 465 Engine.Canvas.DrawText | Engine.Console (PrintActionMessage, DrawConsoleView, ...) |  |
| 466 Engine.Canvas.DrawTile | Engine.Canvas (DrawPattern, DrawIcon, ...); Engine.Console (PostRender) | Callers: Canvas.DrawIcon and DrawPattern (script functions) and Engine.Console; the HUD paints through Extension GC natives. |
| 470 Engine.Canvas.TextSize | Engine.Console (TimeDemoRender); UWindow.UWindowWindow (TextSize) |  |

**player pawn** (4)

| native | called from | note |
|---|---|---|
| 546 Engine.PlayerPawn.UpdateURL | menuchoice_class (SaveSetting, ResetToDefault); menuchoice_team (SaveSetting, ResetToDefault); Engine.PlayerPawn (SetName, ClientChangeTeam) | Callers: the multiplayer class and team menu choices, PlayerPawn.SetName and ClientChangeTeam. |
| by name Engine.PlayerPawn.GetDefaultURL | menuchoice_class (SetInitialClass, LoadSetting); menuchoice_team (SetInitialTeam, LoadSetting); Engine.GameInfo (ProcessServerTravel) | Callers: the multiplayer class and team menu choices, GameInfo.ProcessServerTravel. |
| by name Engine.PlayerPawn.GetEntryLevel | deusexserverlist (PingServer, ServerStatus); menuscreenjoinlan (Query); menuscreenjoininternet (Query); +8 more classes | Callers: the multiplayer server list, ping and join menus, Engine.Console and the UT browser. |
| by name Engine.PlayerPawn.GetPlayerNetworkAddress | Engine.PlayerPawn (KickBan) | Only PlayerPawn.KickBan. |

**actor** (2)

| native | called from | note |
|---|---|---|
| 3969 Engine.Actor.MoveSmooth | Engine.PlayerPawn (ProcessMove) | The PlayerSpectating and PlayerWaiting states of PlayerPawn (ProcessMove); DeusExPlayer declares neither. |
| by name Engine.Actor.GetNextIntDesc | Engine.GameInfo (GetRules); UBrowser.UBrowserMainClientWindow (Created) | Outside the UT browser only GameInfo.GetRules (the server rules list) calls it. |

**console** (2)

| native | called from | note |
|---|---|---|
| by name Engine.Console.ConsoleCommand | ShowClassWindow (SaveSettings); Engine.Console (KeyEvent); UBrowser.UBrowserMainWindow (OpenURL); +6 more classes | Reached only through context calls whose receiver class this reading cannot type; Play creates no script Console object. |
| by name Engine.Console.SaveTimeDemo | Engine.Console (PrintTimeDemoResult) | Only Console.PrintTimeDemoResult. |

**warpzoneinfo** (2)

| native | called from | note |
|---|---|---|
| 314 Engine.WarpZoneInfo.Warp | Engine.WarpZoneInfo (ActorEntered) | WarpZoneInfo.ActorEntered; none of the 88 shipped maps names WarpZoneInfo in its name table (grep of Maps/*.dx). |
| 315 Engine.WarpZoneInfo.UnWarp | Engine.WarpZoneInfo (ActorEntered) | Same as Warp. |

**core: object** (1)

| native | called from | note |
|---|---|---|
| by name Core.Object.Localize | Engine.Console (KeyEvent); UBrowser.UBrowserMainClientWindow (Created); UWindow.UWindowConsoleClientWindow (Notify) |  |

**gameinfo** (1)

| native | called from | note |
|---|---|---|
| by name Engine.GameInfo.ParseKillMessage | Engine.GameInfo (Killed) | Only GameInfo.Killed. |

**levelinfo** (1)

| native | called from | note |
|---|---|---|
| by name Engine.LevelInfo.GetAddressURL | Engine.GameInfo (GetServerPort); IpDrv.UdpBeacon (BroadcastBeacon); UBrowser.UBrowserIRCSystemPage (CheckAway) | GameInfo.GetServerPort, the UdpBeacon and the UT browser. |

**pawn** (1)

| native | called from | note |
|---|---|---|
| 524 Engine.Pawn.FindStairRotation | Engine.PlayerPawn (PlayerMove) | PlayerPawn.PlayerWalking.PlayerMove, the base state function that DeusExPlayer.PlayerWalking inherits (it overrides only ProcessMove, PlayerTick and ZoneChange). |

#### Developer tools only (31)

**developer: DumpLocation** (17)

| native | called from | note |
|---|---|---|
| 3020 DeusEx.DumpLocation.GetFirstDumpFile | BehindTheCurtain (ViewDumps); DumpLocationListWindow (PopulateDumpList) |  |
| 3021 DeusEx.DumpLocation.GetNextDumpFile | DumpLocationListWindow (PopulateDumpList) |  |
| 3022 DeusEx.DumpLocation.GetDumpFileIndex | DumpLocationListWindow (PopulateDumpList) |  |
| 3023 DeusEx.DumpLocation.GetDumpFileCount | BehindTheCurtain (ViewDumps) |  |
| 3024 DeusEx.DumpLocation.OpenDumpFile | DumpLocationEditWindow (SetEditMode, SetAddMode); DumpLocationListLocationsWindow (PopulateLocationsList) |  |
| 3026 DeusEx.DumpLocation.DeleteDumpFile | DumpLocationListWindow (DeleteDumpFile) |  |
| 3027 DeusEx.DumpLocation.GetFirstDumpFileLocation | DumpLocationListLocationsWindow (PopulateLocationsList) |  |
| 3028 DeusEx.DumpLocation.GetNextDumpFileLocation | DumpLocationListLocationsWindow (PopulateLocationsList) |  |
| 3029 DeusEx.DumpLocation.GetDumpLocationIndex | DumpLocationListLocationsWindow (PopulateLocationsList) |  |
| 3030 DeusEx.DumpLocation.SelectDumpFileLocation | DumpLocationEditWindow (SetEditMode); DumpLocationListLocationsWindow (ViewDumpLocation) |  |
| 3032 DeusEx.DumpLocation.DeleteDumpFileLocation | DumpLocationListLocationsWindow (DeleteDumpLocation) |  |
| 3033 DeusEx.DumpLocation.AddDumpFileLocation | DumpLocationEditWindow (SubmitDump) |  |
| 3034 DeusEx.DumpLocation.GetNextDumpFileLocationID | DumpLocationEditWindow (SetAddMode) |  |
| 3035 DeusEx.DumpLocation.GetCurrentUser | DumpLocationEditWindow (SetAddMode, SubmitDump); DeusExPlayer (DXDumpInfo) |  |
| 3036 DeusEx.DumpLocation.SetPlayer | BehindTheCurtain (CreateDumpLoc); DumpLocationBaseWindow (CreateDumpLoc) |  |
| 3037 DeusEx.DumpLocation.SaveLocation | DumpLocationListLocationsWindow (ViewDumpLocation) |  |
| 3040 DeusEx.DumpLocation.GetDumpFileLocationCount | DumpLocationListWindow (PopulateDumpList) |  |

**flags (FlagBase)** (7)

| native | called from | note |
|---|---|---|
| 1101 Extension.FlagBase.SetByte | FlagEditWindow (ModalComplete) |  |
| 1103 Extension.FlagBase.SetFloat | FlagEditWindow (ModalComplete) |  |
| 1104 Extension.FlagBase.SetName | FlagEditWindow (ModalComplete) |  |
| 1111 Extension.FlagBase.GetByte | FlagEditWindow (BuildFlagString); FlagAddWindow (SetEditFlag) |  |
| 1113 Extension.FlagBase.GetFloat | FlagEditWindow (BuildFlagString); FlagAddWindow (SetEditFlag) |  |
| 1114 Extension.FlagBase.GetName | FlagEditWindow (BuildFlagString); FlagAddWindow (SetEditFlag) |  |
| 1123 Extension.FlagBase.GetExpiration | FlagEditWindow (BuildFlagString); FlagAddWindow (SetEditFlag) |  |

**core: debug** (3)

| native | called from | note |
|---|---|---|
| 4001 Core.DebugInfo.Command | DeusExPlayer (DebugCommand) |  |
| 4002 Core.DebugInfo.SetString | DeusExPlayer (SetDebug) |  |
| 4003 Core.DebugInfo.GetString | DeusExPlayer (GetDebug) |  |

**window** (3)

| native | called from | note |
|---|---|---|
| 1501 Extension.ModalWindow.IsCurrentModal | ToolTitleBarWindow (DrawWindow) |  |
| 1530 Extension.BorderWindow.SetBorders | ToolWindow (CreateToolWindowContainer); ToolBorderWindow (InitWindow) |  |
| 1532 Extension.BorderWindow.BaseMarginsFromBorder | ToolWindow (CreateToolWindowContainer); ToolBorderWindow (InitWindow) |  |

**actor** (1)

| native | called from | note |
|---|---|---|
| by name Engine.Actor.ConsoleCommand | ShowClassWindow (SaveSettings); UBrowser.UBrowserMainWindow (OpenURL); UBrowser.UBrowserBrowserButton (Click); +5 more classes | Reached only through context calls whose receiver class this reading cannot type; the player's ConsoleCommand is PlayerPawn.ConsoleCommand (handled by name). |

### Excluded

#### Owner: stage-6 (19)

- **saves and GameDirectory** (18): 3011 DeusExPlayer.SaveGame, 3013 DeusExPlayer.CreateGameDirectoryObject, 3075 DeusExSaveInfo.UpdateTimeStamp, 3080 GameDirectory.GetGameDirectory, 3081 GameDirectory.GetNewSaveFileIndex, 3082 GameDirectory.GenerateSaveFilename, 3083 GameDirectory.GenerateNewSaveFilename, 3084 GameDirectory.GetDirCount, 3085 GameDirectory.GetDirFilename, 3086 GameDirectory.SetDirType, 3087 GameDirectory.SetDirFilter, 3088 GameDirectory.GetSaveInfo, 3089 GameDirectory.GetSaveInfoFromDirectoryIndex, 3090 GameDirectory.GetTempSaveInfo, 3091 GameDirectory.DeleteSaveInfo, 3092 GameDirectory.PurgeAllSaveInfo, 3093 GameDirectory.GetSaveFreeSpace, 3094 GameDirectory.GetSaveDirectorySize
- **core: object** (1): Object.GetConfig (by name)

#### Owner: multiplayer (49)

- **network (IpDrv)** (22): InternetLink.GetLastError (by name), InternetLink.GetLocalIP (by name), InternetLink.IpAddrToString (by name), InternetLink.IsDataPending (by name), InternetLink.ParseURL (by name), InternetLink.Resolve (by name), InternetLink.StringToIpAddr (by name), InternetLink.Validate (by name), TcpLink.BindPort (by name), TcpLink.Close (by name), TcpLink.IsConnected (by name), TcpLink.Listen (by name), TcpLink.Open (by name), TcpLink.ReadBinary (by name), TcpLink.ReadText (by name), TcpLink.SendBinary (by name), TcpLink.SendText (by name), UdpLink.BindPort (by name), UdpLink.ReadBinary (by name), UdpLink.ReadText (by name), UdpLink.SendBinary (by name), UdpLink.SendText (by name)
- **multiplayer: stat logging** (16): StatLog.BatchLocal (by name), StatLog.BrowseRelativeLocalURL (by name), StatLog.ExecuteLocalLogBatcher (by name), StatLog.ExecuteSilentLogBatcher (by name), StatLog.ExecuteWorldLogBatcher (by name), StatLog.GetGMTRef (by name), StatLog.GetMapFileName (by name), StatLog.GetPlayerChecksum (by name), StatLog.InitialCheck (by name), StatLog.LogMutator (by name), StatLogFile.CloseLog (by name), StatLogFile.FileFlush (by name), StatLogFile.FileLog (by name), StatLogFile.GetChecksum (by name), StatLogFile.OpenLog (by name), StatLogFile.Watermark (by name)
- **canvas** (3): 468 Canvas.DrawTileClipped, 469 Canvas.DrawTextClipped, 471 Canvas.DrawClippedActor
- **actor** (2): 545 Actor.GetNextSkin, 547 Actor.GetURLMap
- **core: object** (2): Object.GetPropertyText (by name), Object.SetPropertyText (by name)
- **player pawn** (2): PlayerPawn.CopyToClipboard (by name), PlayerPawn.PasteFromClipboard (by name)
- **core: operators** (1): 116 Object.Greater_StrStr
- **gameinfo** (1): GameInfo.GetNetworkNumber (by name)

#### Owner: editor (14)

- **editor** (13): BrushBuilder.BadParameters (by name), BrushBuilder.BeginBrush (by name), BrushBuilder.EndBrush (by name), BrushBuilder.GetPolyCount (by name), BrushBuilder.GetVertex (by name), BrushBuilder.GetVertexCount (by name), BrushBuilder.Poly3i (by name), BrushBuilder.Poly4i (by name), BrushBuilder.PolyBegin (by name), BrushBuilder.PolyEnd (by name), BrushBuilder.Polyi (by name), BrushBuilder.Vertex3f (by name), BrushBuilder.Vertexv (by name)
- **core: operators** (1): 183 Object.DivideEqual_FloatFloat

### Missing and unreachable

#### No shipped script calls them (122)

- **window** (28): 1435 Window.ResetSize, 1436 Window.ResetWidth, 1437 Window.ResetHeight, 1441 Window.GetFocusWindow, 1452 Window.GetCursorPos, 1471 Window.IsPointInWindow, 1478 Window.SetFonts, 1479 Window.SetNormalFont, 1480 Window.SetBoldFont, 1481 Window.EnableSpecialText, 1496 Window.SetVisibilitySounds, 1531 BorderWindow.SetBorderMargins, 1533 BorderWindow.EnableResizing, 1534 BorderWindow.SetMoveCursors, 1554 TextWindow.GetTextPart, 1591 ButtonWindow.SetActivateDelay, 1610 ToggleWindow.ChangeToggle, 1613 ToggleWindow.SetToggleSounds, 1682 ClipWindow.SetUnitSize, 1683 ClipWindow.SetUnitWidth, 1684 ClipWindow.SetUnitHeight, 1685 ClipWindow.ResetUnitSize, 1686 ClipWindow.ResetUnitWidth, 1687 ClipWindow.ResetUnitHeight, 1688 ClipWindow.GetUnitSize, 1690 ClipWindow.EnableSnapToUnits, 1691 ClipWindow.GetChild, 1820 RadioBoxWindow.GetEnabledToggle
- **window: computer terminal** (24): 1970 ComputerWindow.SetBackgroundTextures, 1972 ComputerWindow.SetTextWindowPosition, 1974 ComputerWindow.SetFontColor, 1977 ComputerWindow.SetCursorTexture, 1979 ComputerWindow.SetCursorBlinkSpeed, 1981 ComputerWindow.SetTextSound, 1982 ComputerWindow.SetTypingSound, 1983 ComputerWindow.SetComputerSoundVolume, 1984 ComputerWindow.SetTypingSoundVolume, 1986 ComputerWindow.ClearLine, 1988 ComputerWindow.PrintLn, 1989 ComputerWindow.GetInput, 1990 ComputerWindow.GetChar, 1991 ComputerWindow.PrintGraphic, 1992 ComputerWindow.PlaySoundLater, 1993 ComputerWindow.SetTextPosition, 1994 ComputerWindow.IsBufferFlushed, 1995 ComputerWindow.Pause, 1996 ComputerWindow.Resume, 1997 ComputerWindow.IsPaused, 1998 ComputerWindow.SetThrottle, 1999 ComputerWindow.GetThrottle, 2000 ComputerWindow.ResetThrottle, 2002 ComputerWindow.FadeOutText
- **core: object** (14): 191 Object.Exp, 192 Object.Loge, 227 Object.Invert, 230 Object.GetUnAxes, 232 Object.Warn, 247 Object.Lerp, 1001 Object.AllObjects, 1005 Object.clock, 1006 Object.unclock, 1007 Object.CyclesToSeconds, Object.Normalize (by name), Object.OrthoRotation (by name), Object.ResetConfig (by name), Object.StaticSaveConfig (by name)
- **actor** (12): 233 Actor.Error, 263 Actor.HasAnim, 305 Actor.ChildActors, 307 Actor.TouchingActors, 539 Actor.GetMapName, 549 Actor.Subtract_ColorColor, 550 Actor.Multiply_FloatColor, 551 Actor.Add_ColorColor, 552 Actor.Multiply_ColorFloat, Actor.DemoPlaySound (by name), Actor.GetNextInt (by name), Actor.GetSoundDuration (by name)
- **core: operators** (9): 133 Object.MultiplyEqual_ByteByte, 134 Object.DivideEqual_ByteByte, 136 Object.SubtractEqual_ByteByte, 137 Object.AddAdd_PreByte, 170 Object.MultiplyMultiply_FloatFloat, 220 Object.Cross_VectorVector, 289 Object.Divide_RotatorFloat, 290 Object.MultiplyEqual_RotatorFloat, 291 Object.DivideEqual_RotatorFloat
- **pawn** (8): 522 Pawn.ClearPaths, 525 Pawn.FindRandomDest, 526 Pawn.PickWallAdjust, 540 Pawn.FindBestInventoryPath, 706 Pawn.AICanHear, 707 Pawn.AICanSmell, 1020 Pawn.ComputePathnodeDistances, Pawn.ClientHearSound (by name)
- **engine: other** (7): 308 ZoneInfo.ZoneActors, 472 ScriptedTexture.DrawText, 473 ScriptedTexture.DrawTile, 474 ScriptedTexture.DrawColoredText, 475 ScriptedTexture.ReplaceTexture, 476 ScriptedTexture.TextSize, 519 NavigationPoint.describeSpec
- **strings (ExtString)** (7): 1140 ExtString.SetText, 1141 ExtString.AppendText, 1142 ExtString.GetText, 1143 ExtString.GetTextLength, 1144 ExtString.GetTextPart, 1145 ExtString.GetFirstTextPart, 1146 ExtString.GetNextTextPart
- **flags (FlagBase)** (4): 1105 FlagBase.SetVector, 1106 FlagBase.SetRotator, 1115 FlagBase.GetVector, 1116 FlagBase.GetRotator
- **core: debug** (2): 4000 DebugInfo.AddTimingData, Commandlet.Main (by name)
- **developer: DumpLocation** (2): 3025 DumpLocation.CloseDumpFile, 3031 DumpLocation.GetDumpFileLocationInfo
- **window: root and player** (2): 1519 RootWindow.EnablePositionalSound, 1520 RootWindow.IsPositionalSoundEnabled
- **canvas** (1): 480 Canvas.DrawPortal
- **levelinfo** (1): LevelInfo.GetLocalURL (by name)
- **player (DeusExPlayer)** (1): 3001 DeusExPlayer.SetBoolFlagFromString

Natives with a translated body (a module declaring `nativeIndex`) that no dispatcher routes (5): 1554 GetTextPart, 1591 SetActivateDelay, 1610 ChangeToggle, 1613 SetToggleSounds, 1820 GetEnabledToggle

<!-- census:end -->

## The menu sweep

`scripts/census-ui-screens.mjs` (older) runs in Node on 00_Training: it opens the in-game screens (`ShowInventoryWindow` and ten
more) through the console and, for a `Menu...` path, activates the button that invokes each class, with no pointer and no
window areas; its `Menu...` entries stop at the save-game directory. It does not start from the logo map.

`scripts/census-ui-menus.mjs` is the sweep that finds what a **click** reaches first. It runs the page in its default worker
mode in headless Chromium on the default start (DX.dx, Escape for MenuMain), walks the screens breadth first, and on each one
reads the window tree (`settingsProbe` op `controls`, `src/viewer/menu-driver.mjs`: class, ancestry, absolute bounds, visible,
sensitive, the menu's own button table) and presses with real pointer events (the pointer lock is released first, as in
`validate-travel-newgame-play`'s `click`): a left, right and double click at the top window's corners and middle and at a screen
corner, a left click on every visible window of at least 2 x 2 pixels, and a 40-pixel drag from each title bar (the click that
ended in FindWindow, native 1472). A click that opens a screen or message box is an edge; Escape returns. A runtime error pauses the
game, is recorded with its message, and the page is rebooted and the route replayed (25 to 40 seconds each). Not pressed: the main
menu's Training, Intro and Quit, the Yes of the message boxes MenuMain raises for them, and Start Game (their paths are
`validate-travel-newgame-play` and [travel](travel.md)); gestures are also kept off those buttons' rectangles.

One run (37 minutes, `.work/native-menu-sweep.json`): **21 screens (15 classes), 618 gestures on 782 windows (summed per screen); 10 gestures stopped the
game, for 6 distinct reasons**: two unsupported natives (3013 and the name-bound `GetDefaultURL`) and four stops that are not
natives. Every screen with a title window gets a title click and drag; none of them stopped (native 1472 is handled).

| stop | where | what it is |
|---|---|---|
| native **3013** `DeusExPlayer.CreateGameDirectoryObject` | MenuMain, Load Game button (`MenuScreenLoadGame.GetSaveGameDirectory`) | census: excluded, stage-6; **reached from the default start** |
| name-bound native `PlayerPawn.GetDefaultURL` (native 0) | MenuMPMain button 2 (`menuchoice_class.SetInitialClass`) | census: missing-reachable, engine base; multiplayer menu |
| script function not prepared: `UWindow.UWindowList.SetupSentinel` | MenuMPMain buttons 0 and 1 | not a native: Play prepares no UWindow class, which the multiplayer server list derives from |
| host service: "XButtonWindow auto-repeat tick requires mouse-input services" | Customize Keys, the two `ButtonWindow`s (auto-repeat scroll arrows) | `Window.EnableAutoRepeat` (1595) is handled; its tick needs the mouse-input service (`script-window-family-draw.mjs`) |
| engine exec command "UWindowsViewport::Exec ToggleFullscreen" | Display, the full-screen choice | the `ConsoleCommand` chain (`script-console-command.mjs`), not a script native |
| engine exec command "USystem::Exec RELAUNCH -changevideo" | Display, the render-device message box's OK | same |

Of the 25 menu window classes (not counting the choice and message-box windows) the sweep reached 13 and did **not** reach 12: Load Game (blocked at 3013: its next natives are
3080, 3086, 3084, 3088, 3089, 3091, 3093 and 3094), Save Game (the main menu's button is insensitive without a running game; its
natives are 3011, 3075, 3090, 1524 and `Object.GetConfig`), the multiplayer Host, Join and Player Setup screens (behind the
MenuMPMain stops above), and the colour-theme screens (`MenuScreenRGB` and Themes Load/Save are opened only by
`DeusExPlayer.ShowRGBDialog`; no control of Adjust Colors reached it). Every other screen of the main menu's tree (Settings and its
six screens, Brightness, Credits, New Game with its difficulty screen and message boxes, the multiplayer menu itself) ran clean
or stopped for one of the reasons above.

A stop hides what is behind it, so the sweep is repeated when one is fixed (`node scripts/census-ui-menus.mjs`; `--reuse FILE`
re-sorts an earlier report against the current census). The exec commands the menus send through `ConsoleCommand` are a second
finite list worth a census of their own (the `UnsupportedConsoleCommandError` branches of `script-console-command.mjs` are its
current boundary).

## Proposed order

Menus and the default start first, because the user meets them first; then ordinary play; the rest waits for its stage.

1. **The Load Game screen from the default start** (stage 6 owns the save directory, but the screen opens from DX.dx and is the
   one stop on that path). Nine natives: 3013 `CreateGameDirectoryObject`, 3080 `GetGameDirectory`, 3086 `SetDirType`, 3084
   `GetDirCount`, 3088 `GetSaveInfo`, 3089 `GetSaveInfoFromDirectoryIndex`, 3091 `DeleteSaveInfo`, 3093 `GetSaveFreeSpace`, 3094
   `GetSaveDirectorySize`; an empty directory (a browser store with no saves) opens it. The rest of the family follows with
   saving: 3011 `SaveGame`, 3075 `UpdateTimeStamp`, 3090 `GetTempSaveInfo`, 3081-3083, 3085, 3087, 3092, `Object.GetConfig` and
   1524 `RootWindow.GenerateSnapshot` (also called whenever the UI pauses the game: `DeusExRootWindow.UIPauseGame` ->
   `ShowSnapshot`).
2. **Ordinary play**, the natives game code calls that nothing routes: `Actor.PlayOwnedSound` (name-bound; `DeusExWeapon.PlaySimSound`,
   which `Fire` and `PlayFiringSound` call), 722 `ParabolicTrace` (an NPC deciding to throw a grenade), 1449
   `Window.ConvertCoordinates` (inventory drag and drop), 1288 `GC.DrawActor` and 1295 `GC.ClearZ` (the vision augmentation), 3014
   `CreateDataVaultImageNoteObject` (the images screen), 524 `Pawn.FindStairRotation` (if the base `PlayerWalking.PlayerMove` runs).
   Decide, with a note in the registry, for 1050/1051 (`PreRenderWindows`/`PostRenderWindows`: Play paints the windows itself) and
   2050 (`CreateFlagRef`: only the conversation import reaches it).
3. **Host services the menus ask for**, which are not script natives: the mouse-input service for button auto-repeat (Customize Keys),
   `TOGGLEFULLSCREEN` and `RELAUNCH` for the Display screen. Run the sweep again after 1 and 3.
4. **Multiplayer menus**: only if multiplayer is taken up. Until then the MenuMPMain buttons stop on a UWindow function that is
   not prepared, and `GetDefaultURL`, `UpdateURL`, `GetEntryLevel`, `GetPropertyText` and the IpDrv natives are the family behind it.
5. **Engine base-class natives** (18) when a script `Console` object or the spectator and waiting states exist; **developer tools**
   (31: DumpLocation, flag and tool windows, `DebugInfo`) when the cheat console is wanted.
6. **The 122 natives no script calls** need nothing: if one starts to be called, `npm test` does not notice (it checks dispatchers
   against the registry), but this census and the probe list it as missing and reachable.

## What the census does not say

- `handled` is a routed branch. 27 natives are handled only for some receivers or sessions (listed above); the rest of
  their behavior is the evidence of their own validators. The registry is not a fidelity claim.
- Reachability is static and over-approximate (dead functions count) and under-approximate where a call is built by the
  engine, not a script (native code calls script events, not natives). Conditions inside a caller (`Level.NetMode`, cheats)
  are not evaluated: a native listed as reachable from game code may need a multiplayer or cheat path to run.
- A call whose receiver class cannot be typed (a call result as context) is matched by name against name-bound natives only.
- 105 handled natives are called by no shipped script (the host or a harness calls them); they remain handled.

## Keeping it current

- A native or a dispatcher changes: edit the dispatcher, then the `idx('...')` list of its entry in
  `src/runtime/native-registry.mjs` (the test names the site and the indices on each side). A new source file that reads
  `call.index` must be added to `NATIVE_SITES`. A site installed only under a condition gets `when`; a branch that refuses some
  receivers gets `partial`.
- `npm test` runs the registry test. The census, the probe and the sweep are run when a family is implemented:
  `node scripts/census-natives.mjs --doc docs/native-census.md` (add `--probe` after `node scripts/probe-natives.mjs`),
  then `node scripts/census-ui-menus.mjs`.
