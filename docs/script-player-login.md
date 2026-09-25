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
unsupported branch until translated.

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

## Reset teardown research boundary

A second fresh Login in the same world cannot safely be implemented by
merely dropping the old player or clearing its FlagBase map. The current
public reset retains the scene player identity (`src/viewer/game.mjs`),
restores its host transform/vitals and replays doors/map startup. That is a
host reset policy, not evidence that original LoadMap destroys/reconstructs
a player with those same operations. A fresh-world restart or an explicit
translation of original player teardown must replace that policy before
claiming a repeated cold Login is faithful.

Retail native ownership recovered on 2026-09-25:

* DeusEx.dll vtable `0x10027568`, slot `+0x24` (Destroy), points to
  `ADeusExPlayer::Destroy` `0x100141f0`. It clears the dwords at `+0x9fc`,
  `+0xa50`, `+0xa54` (`0x10014216..0x10014222`) and calls imported
  APlayerPawnExt::Destroy at `0x10014228`. These are three explicit stores,
  not a general array clear or recursive destruction of their referents.
* Extension.dll PlayerPawnExt vtable `0x1005c32c`, slot `+0x24`, points to
  `0x10037d40`. It reads imported GObjInGarbageCollection (`0x1005914c`).
  Outside GC, a non-null flagBase at `+0x890` is passed to Core
  ConditionalDestroy (`0x10037d7d`). This branch does **not** explicitly zero
  the pointer afterwards. Inside GC (or if it was null), the alternative
  branch writes null at `0x10037d85`.
* Next it reads rootWindow `+0x894`. A non-null window is passed to existing
  XWindow::SafeDestroy (`0x1004c0b0`) at `0x10037d95`. It then unconditionally
  clears rootWindow (`0x10037d9c`) and calls imported AActor::Destroy
  (`0x10037da2`). SafeDestroy may defer deleting a locked window; treating it
  as unconditional immediate release would violate the existing window
  contract. See [window destruction](script-window-destroy.md).
* FlagBase vtable `0x1005c20c`, slot `+0x24`, selects XFlagBase::Destroy
  `0x100239f0`. It first calls UObject::Destroy (`0x10023a1a`), then scans
  exactly 64 hash buckets at `+0x28 + 4*i` (`0x10023a22..0x10023a3a`).
  It repeatedly calls RemoveFlag on the current head until each bucket is
  empty. This routine does **not** invoke a flag deleting destructor.
* RemoveFlag `0x10023a80` accepts only a non-null node whose flagBase `+0x30`
  equals this. FindFlag `0x10024f50` selects bucket `(node[+0x2c] & 63)` and
  finds that exact node by following next `+0x34`, returning the address of
  its predecessor link. On success RemoveFlag rewrites that link to next,
  then zeros node.next and node.flagBase (`0x10023ac0..0x10023acb`). The
  detached flag object remains an object until its separate lifetime ends.

These facts use the same hash-pinned Extension.dll as the constructor and
window evidence; DeusEx.dll SHA-256 is
`b91002f3e7658c0562d28bccc887cf9db79a47a19f5e09e8be460c9d0c0bee04`.
They are static original-instruction evidence, not yet an executable reset
comparison. All addresses here are preferred DLL addresses, before the
oracle's Extension rebase.

Core ConditionalDestroy/UObject.Destroy and Window.SafeDestroy already have
recovered family implementations. Consequently the player Destroy wrappers
and FlagBase unlink loop are bounded new translations, not evidence of a
large unknown native subsystem. However `createFlagBase` currently projects
entries into a JavaScript Map with no original flag-node UObject identities,
bucket links or backreferences. A faithful general teardown must either add
that ownership projection or establish a rigorously bounded observable
projection with original cases (including multiple buckets and retained node
references). Replacing its explicit Destroy error with `entries.clear()`
would not establish node unlinking, property cleanup or callback order.

In addition, the player actor's registered Destroy hook must select its real
DeusExPlayer/PlayerPawnExt overrides, and rootWindow must use the existing
window lifecycle implementation rather than a guessed teardown. Native
Destroy is reached synchronously by ConditionalDestroy in accepted
ULevel::DestroyActor; deferred allocation cleanup is a separate later stage.
Neither generic Core destruction alone nor waiting for deferred cleanup
bypasses these overrides. An original family oracle should measure the empty
and populated FlagBase cases and both GC branches before wiring reset. No
teardown implementation or claim that repeated Login/reset is complete was
made by this research.

The current `ScriptRuntime.spawnActor` construction adapter unconditionally
installs `object.destroy = receiver => destroyActorBase(receiver)` after every
native actor constructor. This is valid only for classes inheriting that
Destroy slot unchanged. It is **incorrect for PlayerPawnExt and DeusExPlayer**:
the measured vtables above override slot +0x24. Their generated constructor
rows prove construction effects and IsPendingKill selection, not that the
base Actor Destroy virtual can replace every subclass. Leaving that base-only
hook would silently skip player-owned FlagBase ConditionalDestroy and window
SafeDestroy, so the explicit FlagBase teardown error might never be reached
by destroying the player. That absence of an error cannot establish fidelity.

The next bounded recovery targets are known rather than unidentified:
XFlag constructor `0x10023750`, XFlag::Destroy `0x10023870`,
XFlagBase::AddFlag `0x10023b20`, SetBool `0x10023c60`, SetByte `0x10023d80`,
SetInt `0x10023e80`, SetFloat `0x10023f80`, and SetName `0x10024080`.
Only the types actually reached by the cold/reset path need admission now.
The missing native-node projection includes flagName (SDK candidate +0x28),
flagHash (+0x2c, used by recovered FindFlag), flagBase (+0x30), nextFlag
(+0x34), flagType (SDK candidate +0x38), expiration (SDK candidate +0x3c),
and each subtype's value storage; candidate fields still need retail checks
before implementation. Outer/name/registry ownership must be recovered from
the actual allocating setters/constructors, not assigned from the SDK alone.

Complexity assessment: this is a real fidelity gap, but static evidence does
**not** justify asserting that it necessarily requires more than a day of new
reverse engineering. The teardown loop and wrappers are small and their
service targets already exist. General typed flag construction/list ownership
could broaden the work, especially if retained flag objects or non-bool types
are reached, but that reach has not been demonstrated by this task. A decision
to stop at the last green milestone should state the confirmed missing
ownership/destruction behavior and current integration scope; it should not
present a speculative day-scale estimate as a discovered blocker. No original
executable reset oracle has yet measured the combined player/flag/window
teardown chain.

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

### Reset: open

"Player start" still keeps the logged-in player. It does not unload the level
and log in again. It restores the key ring through CreateKeyRing, relinks the
player at the PawnList head (the reload's PreBeginPlay AddPawn), and replays
the map startup. The reloaded LoadMap spawns a new GameInfo and
GameReplicationInfo. The retained player keeps its old GameReplicationInfo
and PlayerReplicationInfo, and the new game counts `NumPlayers` 0.

This is the host reset policy this page already rejects as an original
contract. The original reload purges the old level by garbage collection.
There, PlayerPawnExt::Destroy takes its GObjInGarbageCollection branch and
nulls flagBase, SafeDestroys rootWindow and runs AActor::Destroy. No script
Destroyed events run. The new level's SpawnPlayActor then logs in a new
player. Replacing the policy needs that teardown for the player graph (and
the other purged objects), a second Login into rebound Play services, and
the FlagBase ownership work described above.
