# Original standalone player login

Research contract, 2026-09-25. Authority is retail Engine.dll SHA-256
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`
and embedded Engine.u / DeusEx.u script source. Native disassembly is local
in `.cache/spawn-play-actor.asm` and `.cache/spawn-play-tail.asm`; extracted
source remains in `.cache/reference`. This page establishes behavior for
translation; it does not claim a completed browser integration.

## SpawnPlayActor inputs and Login

The exported ULevel::SpawnPlayActor thunk `0x1030209a` reaches `0x10396bd0`.
Its arguments are UPlayer*, RemoteRole, const FURL&, FString& Error. The
local GameEngine.Init call at `0x1038972f` supplies its new Viewport, numeric
RemoteRole **2**, the local FURL and Error. This is after LoadMap, before
Input.Init/OpenWindow (see [viewport evidence](script-viewport-console.md)).

The body clears Error (`0x10396bff..0x10396c69`). It selects an incoming
PlayerPawn class by trying URL.GetOption("CLASS=", null), then
`usr:DefaultPlayer.Class`, then `ini:URL.Class` (`0x10396c91..0x10396d31`).
Each attempt uses StaticLoadClass with PlayerPawn required base
(`0x1058c160`), null outer/filename, load flags 2 and a PackageMap obtained
from the network connection if applicable. Failure of all attempts reaches
the original error path. Do not infer a successful browser fallback class
from this native path; DeusExGameInfo separately applies its script policy.

At `0x10396d34..0x10396da8`, Options is constructed as `?` followed by each
URL.Op entry in order, identically to LoadMap. Portal is copied from
URL.Portal (`+0x34` FString) at `0x10396fbe..0x1039701c`. The actual Login
parameter record at `[ebp-0xbc]` is:

| Offset | Value |
| --- | --- |
| 0 | Portal FString |
| 12 | Options FString |
| 24 | Error FString (out) |
| 36 | SpawnClass UClass* |
| 40 | return PlayerPawn*, initially null |

LevelInfo.Game is the receiver. FindFunctionChecked resolves name global
`0x10583674` at `0x103970dd`; ProcessEvent runs at `0x103970ed`. Error is
copied back at `0x103970fa`; the returned player is read at `0x10397100`.
A null result logs failure and returns null (`0x10397150..0x10397183`).
PreLogin is not dispatched by this local SpawnPlayActor body.

## Native work after successful Login

The exact order is more extensive than Login followed immediately by
PostLogin:

| Address | Operation |
| --- | --- |
| `0x1039718e` | Player.SetPlayer(Viewport), including Possess dispatch |
| `0x10397196` | player.Role = 4 (ROLE_Authority) |
| `0x1039719a` | player.RemoteRole = incoming role (2 for local caller) |
| `0x1039719d` | player.ShowFlags (+0x5fc) = 0x480c |
| `0x103971a7` | player.RendMap (+0x600) = 5 |
| `0x103971ad..0x103971d8` | Set bAdmin when command line has `alladmin` or ULevel.NetDriver (+0x3c) is null |
| `0x103971f4` | player.TravelPreAccept() |
| `0x103971f7..0x10397ab6` | Resolve/import travel text and references; run non-player imported actors' TravelPreAccept in reverse import order |
| `0x10397b48` | Game.AcceptInventory(player) |
| `0x10397b4b..0x10397b8b` | Imported non-player actors' TravelPostAccept in reverse import order |
| `0x10397ba9` | player.TravelPostAccept() |
| `0x10397c34` | Game.PostLogin(player) |

The native FName registration (`0x1038037c..0x1038063a`) resolves the relevant
globals: `0x10583674` Login, `0x10583670` AcceptInventory, `0x10583640`
TravelPreAccept, `0x1058363c` TravelPostAccept and `0x105835e8` PostLogin.
These are checked against original UTF-16 literals, not inferred from order.

With no travel text, the import arrays initialized at `0x103973e3` have zero
entries and `0x10397400` jumps to `0x103977ac`; the import loops skip, but
**AcceptInventory, the player's TravelPostAccept and PostLogin still run**.
The cold browser path must not omit those callbacks on the grounds that
save/travel support is deferred. Nonempty travel parsing remains a separate
unsupported branch until translated: [map travel](travel.md#spawnplayactor-importing-the-travel-text)
records the import (three passes, the grammar, the callbacks) and a measured text.

SetPlayer itself is `0x10368c90`: an existing Viewport.Actor loses its Player
pointer (`0x10368cde`), Viewport.Actor is cleared, then the new player's
Player (+0x5d4) and Viewport.Actor (+0x30) are set (`0x10368ce7/0x10368ced`).
Possess is dispatched at `0x10368d06`. Thus Possess sees the identity links
and precedes SpawnPlayActor's explicit Role/RemoteRole stores. Replacing
SetPlayer with backlink stores alone loses a real event.

## Original script path

DeusExGameInfo.Login first calls ApproveClass; its implementation returns
false, forcing `class'JCDentonMale'`. It then delegates to GameInfo.Login.
For standalone, Engine.GameInfo.Login skips the network capacity branch,
parses Name (first 20 characters), Team, Password, Skin, Face and Checksum,
and obtains FindPlayerStart(None, InTeam, Portal). Missing start returns
FailedPlaceMessage/None. Its base FindPlayerStart uses the first matching
Teleporter Tag for a nonempty Portal; otherwise the first enabled
bSinglePlayerStart PlayerStart in AllActors order, then the first disabled
single-player start if necessary. It does not choose nearest or random.

Login can reuse an unoccupied player in PawnList when Player is null,
PlayerReplicationInfo exists, bIsPlayer is true and its name differs from
the PRI class default; standalone bypasses the additional name/password
match. The fresh browser case must begin without an already fabricated
script player in PawnList, or this branch may select that stand-in.

Without a match, Login checks human-only restrictions, then calls original
Spawn(SpawnClass,,,StartSpot.Location,StartSpot.Rotation) and copies start
rotation into ViewRotation. This Spawn must execute Pawn.PreBeginPlay and
the complete player startup chain. Login immediately needs its resulting
PlayerReplicationInfo to assign PlayerID=CurrentID++ and initialize the
name. It also calls SetMultiSkin, ClientSetRotation, ChangeName/ChangeTeam,
sets Password/bAdmin/GameReplicationInfo, invokes the start teleport effect,
performs configured logging and increments NumPlayers for a non-spectator.
Failures and class/skin policy belong to original script, not a host bypass.

On return from Super.Login, DeusExGameInfo.Login checks player != None and
absence of the Loadgame option. It calls ResetPlayerToDefaults and
CreateDumpLocationObject. A saved dump takes the original load-location /
pause / SetLocation / rotation / CriticalDelete branch. Otherwise it obtains
Team again and, in standalone, calls FindPlayerStart(None, Team, Portal)
again, then SetLocation, SetRotation, ViewRotation and ClientSetRotation.
The second start lookup and positioning must not be silently coalesced with
the first: both execute script and can observe world changes.

Base GameInfo.AcceptInventory calls AddDefaultInventory; original player
TravelPostAccept performs health recovery and DeusEx subsystem/mission work;
base GameInfo.PostLogin invokes ClientSetMusic. Their inherited/overridden
bytecode must determine actual effects. Stage 4 audio playback can stay an
explicit presentation boundary; the script callback cannot disappear.

## Browser integration contract and verification

Login's Spawn must create the canonical script player. Bind the existing
scene collision/movement view to that object during native spawn setup,
before collision/zone setup and startup callbacks can observe it. A second
collision player or attaching script state to the old host-created player
after Login would leave references, PawnList and Viewport.Actor inconsistent.
Before Pawn startup, general SpawnActor needs the same FootRegion/HeadRegion
SetActorZone and pawn collision services already used by map pawns. Keep
those services separate from skipping any original Pawn callback.

Focused reference cases should check the returned player is the Spawn result;
PRI exists before Login assigns PlayerID; Portal/Options/out Error are exact;
Possess sees Player/Actor backlinks; local final Role/RemoteRole are 4/2;
and cold callbacks order is TravelPreAccept, AcceptInventory,
TravelPostAccept, PostLogin. Check SetPause from the Esc path reads the PRI's
actual nonempty PlayerName, then verify the existing instructor, keypad,
weapon-equip, augmentation and console validators.

The native local sequence itself is now recovered; it is not a new day-scale
reverse-engineering problem on this evidence. Implementation risk remains
in the existing constructor formatting boundary, early pawn bindings and
newly reached original ResetPlayerToDefaults / dump-location / possession /
TravelPostAccept branches. Runtime failures should identify the exact new
native or service before estimating that work. Save-game reuse, nonempty
travel data, network class loading and multiplayer branches remain outside
the cold standalone scope; they must fail explicitly if reached.

## Cold standalone adapter

`src/runtime/script-player-login.mjs` exports async `preparePlayerLogin`.
Preparation loads the installed User.ini DefaultPlayer.Class, falling back to
the installed system INI URL.Class when the first candidate does not identify
an available PlayerPawn class. Corrupt package/loading/preparation errors
propagate. No hard-coded default player class is substituted. It prepares the
selected class and its PRI class through the supplied preparation callback.
The synchronous `login()` executes original GameInfo.Login with an explicit
null caller-owned return slot, preserves out Error, then performs the native
stores and callback order above. A null script return stays null and leaves
`error` available on the adapter. No missing runtime service is swallowed.

Supported inputs are deliberately fixed: standalone NetMode, no NetDriver,
empty Portal, URL.Op=[], local RemoteRole=2, no CLASS option and no travel
text/imported actors. The host must supply a prepared Viewport prefix and a
completed LoadMap, and must connect pawn collision/movement/zone services
before calling login. The adapter does not attach a pre-existing scene player
or skip player startup. Nonempty options, travel text and remote/network
connections require extending the recovered input pipeline first. Native
error logging, platform viewport/input setup and full StaticLoadClass path
syntax are not reproduced by this module.

Verification at this translation boundary used a controlled runtime event
service to assert exact Login inputs, configured class fallback, identity
links visible inside Possess before Role assignment, final 4/2 roles and
0x480c/5 display defaults, and the six-callback sequence. `node --check` also
passes. These checks validate the translation against the recovered contract;
they do not establish full original-player integration or replace the pending
Training integration validators.

## Player teardown on reset

The research boundary recorded here on 2026-09-25 is closed. The retail
native facts it collected are now implemented in
`src/runtime/script-player-destroy.mjs` and documented, with the LoadMap
caller that reaches them, in [Player start collection](script-loadmap-gc.md):

* `ADeusExPlayer::Destroy` (`0x100141f0`, vtable `0x10027568` slot `+0x24`)
  makes three stores and then calls `APlayerPawnExt::Destroy`. By the retail
  property offsets they null `conHistory` (`+0x9fc`), `FirstLog` (`+0xa50`)
  and `LastLog` (`+0xa54`).
* `APlayerPawnExt::Destroy` (`0x10037d40`) takes one of two
  `GObjInGarbageCollection` branches for the FlagBase (`+0x890`). It then
  SafeDestroys `rootWindow` (`+0x894`), nulls it and runs `AActor::Destroy`.
  The reset reaches it outside a collection: LoadMap destroys the old player
  through `DestroyActor` before the load.
* `XFlagBase::Destroy` (`0x100239f0`) runs `UObject::Destroy`, then drains
  the 64 buckets with `RemoveFlag` (`0x10023a80`). The host FlagBase stores
  flags without flag-object identities, so the drained store is its
  observable result. The detached XFlag objects have no host records (see the
  limits in the collection note).
* The root window's `SafeDestroy` uses the recovered XRootWindow family
  (CleanUp `0x10039240`, destructor `0x100059c0`).

`ScriptRuntime.spawnActor` now installs the Destroy virtual of the
constructed actor's native vtable. That is these overrides for the player
chain and `AActor::Destroy` otherwise; among the admitted native Actor
classes, only this chain overrides slot `+0x24`.

## ResetKeyboard and the native Input object

ResetKeyboard is native **544 on Engine.PlayerPawn**, inherited by
PlayerPawnExt; it is not the existing UInput::ResetInput key/axis clearing
routine. Its export thunk `0x103021b2` reaches `0x103b96d0`.
After advancing FFrame.Code, it checks Player non-null and its ancestry for
Viewport, then checks Viewport.Input (`+0x60`) non-null
(`0x103b9702..0x103b9737`). The successful path passes **Input.Class** to
Core.UObject::ResetConfig at `0x103b973d` (IAT `0x1059a098`). No UInput.Viewport
backlink or Input.Init state is inspected. UViewport constructs Input before
SpawnPlayActor, so the normal cold original path cannot be justified by
inventing a null Input solely to take this native early return.

ResetConfig's thunk `0x10101a14` reaches Core `0x10151ac0..0x10151d85`:

1. Read Class.ConfigName `+0x4a0`. System name index `0x2e8` selects original
   `Default.ini`; User `0x2e9` selects `DefUser.ini`. Other names return.
2. GConfig.GetSection(Class.GetPathName(), buffer, 0x7fff, default filename)
   at `0x10151b38`. For each null-separated entry, find `=`, split key/value,
   and call GConfig.SetString with the same class pathname and ConfigName
   filename (`0x10151b9f`). This does not first clear the destination section.
3. Iterate loaded UClasses derived from that class and call LoadConfig(1)
   on each CDO (`0x10151c40`).
4. Iterate loaded UObject instances whose class derives from that class;
   call LoadConfig(1) (`0x10151cef`), then virtual +0x40 PostEditChange
   (`0x10151d02`).

There is **no Flush or FileManager call** in ResetConfig's body. Any later
flush would follow the existing config cache policy; research here performed
no config mutation on installed original files. The selected original
Engine.Engine.Input is Extension.InputExt. Installed DefUser.ini contains
Engine.Input but no Extension.InputExt section, so copying that exact class
section has no writes; the class/instance reload passes still execute and
LoadConfig(1) propagates into Engine.Input. A missing section does not make
ResetKeyboard itself a no-op.

### InputExt and ResetConfig as implemented

The selected Engine.Engine.Input is Extension `InputExt`. Its registration
at Extension `0x1002cf10` passes UInput's size `0xfb0`, flags `0x04084004`
(CLASS_Config), config name "User" (string `0x10098708`), class name
"InputExt" (`0x100986f6`) and UInput's StaticConstructor. That body is a
bare `ret` (Engine `0x10393570`), so InputExt declares no properties of its
own. UInput::StaticInitInput (`0x103930c0`) creates the config properties on
Engine.Input: the Alias struct, `Aliases[40]` and one UStrProperty per
EInputKey whose FName is not None, named past its first three characters.
All of them carry exactly CPF_Config (`0x4000`), with no GlobalConfig. The
function ends with LoadConfig(1) on UInput's defaults.

XInputExt's constructor (`0x1002cfb0`), outside GIsEditor, runs LoadConfig(1)
on the InputExt class defaults and then on the new object (`0x1002d03a..
0x1002d04a`). LoadConfig(1) first runs the Engine.Input pass and then the
InputExt pass, over the same inherited properties. The second pass reads
`[Extension.InputExt]`. The installed User.ini and DefUser.ini have no such
section.

`script-input-console.mjs` holds one InputExt object: its bindings and
aliases arrays plus the class defaults. Both are loaded by that LoadConfig
order from GConfig's User file, and console commands read the arrays in place.
The binding values match the previous scalar reader for all 255 installed
keys. The window host exposes the object as `input`. Play stores it at
UViewport::Input (`viewport.input`, +0x60) before Login.

ResetKeyboard (native 544, `0x103b96d0`) advances the code pointer and needs
Player (+0x5d4) to be a UViewport with a non-null Input (+0x60). It then
calls ResetConfig(Input.Class). ResetConfig
(`0x10151ac0..0x10151d85`) runs these steps in order:

1. The "User" config name selects DefUser.ini. Its `[Extension.InputExt]`
   section would be copied into User through GetSection (+0x18) and
   SetString. That section is absent in the installed data. A present section
   throws, because GetSection's buffer copy is not recovered.
2. Every loaded class that IsChildOf InputExt gets LoadConfig(1) on its
   defaults. Only InputExt itself qualifies.
3. Every object that IsA InputExt (the one Input) gets LoadConfig(1) and then
   PostEditChange. InputExt's vtable slot +0x40 is UObject::PostEditChange
   (`0x1014f9c0`), which only calls virtual Modify. UObject::Modify
   (`0x10150170`) records into GUndo. Core and Engine only read GUndo; only
   Editor.dll writes it. So the game's Modify returns.

At cold Login GConfig is unchanged since construction, so the reload leaves
the same values. The reload still runs, rather than being skipped.

### Other natives newly reached by Login

* InitRootWindow (1052, `0x10038560` -> `0x10037df0`) runs from
  PlayerPawnExt.Possess. It constructs the root through ConstructRootWindow
  (`0x10037e70`) only while rootWindow (+0x894) is None. Play creates the
  native window host before Login for this reason.
* FlagBase.CheckFlag (1120, exec `0x10025aa0`, body `0x100247d0`) returns
  whether GetFlag finds that name with that EFlagType. It is reached from
  RestoreSkillPoints in TravelPostAccept with `FLAG_Int`. The live store
  holds only bools, and every non-bool setter is still unsupported, so it
  cannot contain another type.
* GameInfo.SetPause now finds a PlayerReplicationInfo. The Esc path writes
  `LevelInfo.Pauser = "Player"`, and Play's tick takes ULevel::Tick's paused
  branch (`0x103a5793..0x103a58cf`). No actor ticks, and the viewer
  movement port, standing in for ReadInput/PlayerInput, does not run.
  Training has no bAlwaysTick actor. One would be recorded as an unadmitted
  boundary.

## Play integration, 2026-09-25

Play boots Training through the original sequence: LoadMap passes, then
SpawnPlayActor, then DeusExGameInfo.Login. Login spawns `JCDentonMale0` with
`PlayerReplicationInfo0` (PlayerID 0, PlayerName "Player"). It sets
GameReplicationInfo, Role 4 / RemoteRole 2 and ShowFlags `0x480c`. The
subsystem graph (AugmentationManager, skills, key ring) comes from
PostBeginPlay, and the root window from Possess. Login then runs
ResetPlayerToDefaults, CreateDumpLocationObject and TravelPostAccept.
`NumPlayers` becomes 1. Object names follow live class counters: Play's
session starts at Training, while the 2026-09-12 capture came from a menu
session whose DX.dxm player took suffix 0.
`script-player-startup.mjs` now only prepares that bytecode and verifies the
graph Login built. The isolated InitializeSubSystems path and its forced name
counters are removed.

Fresh Play entry then supplies the `PlayerTraveling=True`, expiration-zero
marker carried by original `PreTravel`; the first mission Timer consumes it.
This is separate from the direct empty-travel-text Login contract above and
also runs after Player start's new Login. See
[Training mission entry](script-training-mission-entry.md) for evidence and
the explicit limits of this fresh-entry projection.

### Reset: reload and a second Login

"Player start" is a reload of the loaded map, then SpawnPlayActor, as at
boot. The full original sequence, its evidence and the host projection are in
[Player start collection](script-loadmap-gc.md). In order:

1. `game.reset()` first runs `retirePlayer()`, which is LoadMap before it
   loads anything (`0x1038c6c4..0x1038c731`). It sends `NotifyLevelChange`
   to the viewport console, clears `Player.Player` and `Viewport.Actor`, and
   runs `DestroyActor(oldPlayer)`. The old player's script `Destroyed` chain
   runs, then `ADeusExPlayer::Destroy` outside a collection. That destroys
   the FlagBase and SafeDestroys the root window tree.
2. The host restores the map exports in place and makes the reloaded
   `Level.Actors` the exports only. This corresponds to ResetLoaders plus
   StaticAllocateObject's same-index replacement. Spawned actors (NPC
   inventory and Shadows, the GameInfo graph, the Mission script, ConPlay
   actors) are no longer `DestroyActor`ed by the host.
3. LoadMap's `CollectGarbage(RF_Native)` purges everything the old level
   spawned: every old-package actor is tagged `0x400`, and the non-actors
   only those actors reached become unreachable. The purge releases their
   registry slots in index order and deletes their FNames.
4. The GameInfo spawn, the LoadMap passes and `loginPlayer()` run as at boot.
   The new objects reuse the freed slots, highest first.

Each reset therefore produces `JCDentonMale<n+1>`, `PlayerReplicationInfo<n+1>`,
new subsystems, a fresh FlagBase and a new root window, and releases the
previous generation. The InfoLink shell, live ConPlay and DataLink, and the
HUD rebind to the new player.

This replaces the 2026-09-25 model, which assumed that `Viewport.Actor`
kept the retired player alive through LoadMap's collection. LoadMap nulls
`Viewport.Actor` and destroys that player before the collection, and its
`0x400` tag excludes every old-package actor. No retired generation survives
the reset that retired it.
