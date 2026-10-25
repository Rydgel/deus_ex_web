# Stage 6 chains: a mission's required chain, each step placed, in Play and under Wine

Rows 6.4.NN.1 of [the exit criteria](stage-6-exit-criteria.md): *the mission's required chain ([the inventory's "Progression path"](stage-6-inventory.md)), each step placed, runs in
Play from the arrival to the exit, and the flags, goals, notes and travel text at the exit equal the original's under Wine from the same start.* This note is the harness every
mission row reuses, what the two missions run with it so far (0 and 1), and what each found.

## The step format

A chain is a list of steps in `scripts/chains/mission<NN>.mjs` (data, no game text: positions, names of actors and flags, the labels a choice's branch jumps to). Two drivers read the
same file and write the same result:

| Driver | Runs | How |
| --- | --- | --- |
| `scripts/chain-play.mjs` | Play's headless session (`openSession`, as the transition and New Game validators), one session per map | the menu driver for the start, key presses through the root window and the bindings (`pressKey`: the root window is offered the key first, as XInputExt::Process does), console lines as the original's console takes them (`typeLine`: the T key goes to the root window first, so a conversation swallows a line as it does in the original), Level time passing |
| `scripts/chain-original.mjs` | the installed DeusEx.exe under Wine | `scripts/travel-probe.sh` in `follow` mode (it takes the Wine lock, launches the game, restores `Save/` and quits it), then the steps through `scripts/travel-step.sh` (dxinput's clicks, keys and held keys, typed console lines) and the dump tools (`tools/dump-actor-win.c`, `dump-flags-win.c`, `dump-travel-win.c`, `dump-gobjects-win.c`), read **between** steps so each step knows when it took effect (a map change, a flag, a conversation's current event) |

The ops (`scripts/chain-lib.mjs` documents them):

| Op | Meaning |
| --- | --- |
| `start` | `menu-training` (the logo map, Escape, the Training button), `new-game` (New Game, a difficulty, Start Game, the intro left by Escape, as travel step 2 measured), `open` (the console's `LocalTravel <map>`, for probes) |
| `place` | **a labelled harness step**: `ghost`, `set Location`, `walk`, `set ViewRotation` (the lines Stage 5's captures type). `drop: true` puts the player above a Teleporter's or exit's cylinder with the view set first: a placement inside a cylinder raises no Touch, the fall into it does |
| `walk` | the forward key held for N seconds (the original's through the Wine input queue: Stage 5 "Held keys") |
| `frob`, `click`, `belt`, `key`, `line` | the right button (`ParseRightClick`, what `RightMouse` is bound to), the left button (Enter), `ActivateBelt n`, key presses, any console line |
| `conv` | a conversation played **as it comes** (no key skips a speech: a skip races the choice that follows); the listed choices are picked when the current event is a `ConEventChoice` (ArrowDown by index, Enter), by the label the branch jumps to |
| `wait` | Level seconds in Play, real seconds under Wine, or until a flag is (not) set |
| `travel` | the map change a step caused; the arrival is awaited and the travel text it exported is the leg's |
| `snap` | the flags (name, type, expiration, value, the default expiration) |
| `gobjects`, `report` | the original's object table, and a place (not compared) |

`scripts/chain-plan.mjs` finds the placements in Play's world so that both programs are given the same numbers: `approach` (a held forward key reaches an actor's cylinder), `drop`
(a fall into it), `stand` (a place at a distance from an NPC with a clear line, landed first and aimed from the landed eye), `face` (the view trace selects the actor). NPCs with
Sitting or Wandering orders walk to their places first: `stand` settles 900 frames before it measures them.

## Running

```bash
# once per checkout: the dump tools are not in Git (ad/build is ignored). tools/dump-travel-win.exe is the one the Linux host did not have:
i686-w64-mingw32-gcc -O2 -o ad/build/dump-travel-win.exe tools/dump-travel-win.c -lpsapi
# (dump-actor-win, dump-flags-win, dump-gobjects-win and dxinput.exe are built the same way, ad/README.md)

node scripts/chain-original.mjs --mission 00        # the original under Wine (the Wine lock, minutes); writes .work/chains/m00/ (outside Git: it holds the game's texts)
node scripts/chain-play.mjs --mission 00             # Play alone, printing every step
node scripts/validate-stage6-chain.mjs --mission 00  # Play against the stored capture: PASS/FAIL (SKIP without the capture)
node scripts/validate-stage6-chain.mjs --mission 00 --capture   # capture first
node scripts/chain-plan.mjs stand 01_NYC_UNATCOHQ SamCarter0 --distances 70 --lift 15
```

On the Mac (2026-10-23) `scripts/travel-probe.sh`, `travel-step.sh` and `chain-original.mjs` run the CrossOver bottle `DeusEx` (the Darwin branch of
`scripts/live-original.sh`: CrossOver's wine, no `flock`, the save listing and file times through Perl and BSD `stat` where GNU `find -printf` and `stat -c`
are missing, no `mapfile` in bash 3.2). The captures a machine takes stay in its own `.work/` (the Linux host's and the Mac's differ): a validator whose
capture is not there SKIPs. A console line typed while a menu is open is the menu's (its Enter activates the focused button): close the menus first.

### Rules a chain follows (learned on mission 15, 2026-10-24)

* God mode (`ReducedDamageType`) and `bCheatsEnabled` are not travel properties: type both lines again after every `travel` (a level change drops them in both programs).
* A slot's level is not the cold map: plan every placement after a slot start with `chain-plan.mjs face-chain`, in the level the chain reaches, not with `face` on the cold map.
* A radius conversation needs its owner's `DistanceFromPlayer` current, which only drawing keeps: headless Play needs the `watch` stand-in on the owner, and when the
  original first draws him is not derivable from the chain (a placement draws frames with the old view between `set Location` and `set ViewRotation`), so a chain waits
  on the conversation's `_Played` flag in its window rather than on time.
* When a capture stops at a `wait`, read the original's player first (its `Health` and state in the dumps): a dead or dying player explains most timeouts (ending 1's first
  capture: the reactor's radiation, seen by the user watching the Wine window).

### Starts, exit saves and the batch (2026-10-24)

* **Each mission's chain starts from the previous chain's exit.** A chain ends with a `save` step (Play only: the console's `SaveGame` through the viewport's
  Exec chain, once no conversation holds the keys); `node scripts/chain-play.mjs --mission NN --save-exit` pins that slot to
  `.work/chains/exits/mNN/exit/Save01NN` (beside the captures: an original capture clears `.work/chains/mNN/`), and the next chain starts from it in both
  programs (`start: { kind: 'slot', source: 'chain', chain: 'NN', ... }`). The chains so join New Game to an ending, which row 6.6.1 needs, and every start is a
  fresh arrival, so placements are planned on the cold maps. The exit-text equality of chain NN is the evidence that Play's save holds the original's state.
  A chain whose previous chain does not run yet starts **provisionally** from the nearest real desktop slot (the file says so) and is moved to the chain start
  when it exists.
* **The batch.** `node scripts/chain-capture-all.mjs [--missions 02,03]` captures each mission under Wine in turn and runs Play against each capture
  (`validate-stage6-chain.mjs`); a capture newer than its chain file and its start save is kept, so a batch that stops resumes. Long chains run Node with
  `--max-old-space-size=12288` (a level is released some maps after it is left; a chain disposes of a level before loading the next, with two event-loop turns).
* **Planner additions.** `chain-plan.mjs terminal <map> <computer> <user> <password>` logs in and prints the special options' buttons as `point` takes them
  (one button at y 329, two at 314/344, four at 284/314/344/374, x 641: the window grows by 30 per button about its centre); `--flags a,b` stages a scene
  (a pawn a mission script brings in once a flag is set).

### Rules a chain follows (learned on missions 2 to 8, 2026-10-24)

* God mode is set as a value, `set DeusEx.JCDentonMale ReducedDamageType All`, not with the `God` toggle: an arrival in a restored level re-possesses the pawn
  filed there (`DeusExGameInfo.Login`; the original's log: "Possessed PlayerPawn: JCDentonMale 15_Area51_final.JCDentonMale2"), with the `ReducedDamageType` it
  was filed with (it is not a travel property and ResetPlayerToDefaults leaves it), so a level left in God mode is re-entered in God mode, and the toggle
  switched it off (mission 8's player died). Ending 1's original lost God mode because its Final had been filed by the slot's player, without it.
  (`validate-travel-restore-objects.mjs` checks both: dropped on a cold arrival, kept as filed on a restored one; one Wine capture of a level filed with God
  and re-entered would settle it beyond the source and the re-possession log.)
* **Placements before a conversation turn first** (`place` with `turnFirst: true`: ghost, the view, the location, walk last): while ghosted no conversation
  starts (CanStartConversation refuses CheatFlying), so a conversation the placement brings in range starts after the last typed line. With the view set last,
  an owner already in view started its radius conversation mid-placement and the remaining keys were the conversation's: mission 2's first capture had
  JockExit begin and end inside the placement's lines in the original (no travel), while Play's frames happened to pick Go.
* A radius conversation's owner is watched from the `conv` step (its own `watch`), after the placement: a watch before the placement starts the conversation
  during it, the step then waits for something already over, and a frob within a second of a conversation's end starts nothing (GetActiveConversation's
  `LastConEndTime` gate). Mission 3's JockBarks.
* A computer loads in state `Off` at its `Begin` code's `FinishAnim` in a fresh map too: `watch` it before the placement, wait 2 s, then frob (mission 4's NSF
  computers refused the frob, and the typed login went to the game's keys).
* **The camera's zone is stamped every headless frame** (`census-stage5-session.mjs`): OccludeBsp's master frame writes `Zones[Frame->ZoneNumber].LastRenderTime
  = TimeSeconds` (Render.dll 0x10b1768d, `occlude.rs`) for the zone at the camera's origin, and `AActor::InStasis` keeps every actor in a zone rendered within
  5 s and within 1200 units of the player awake (`actor-tick.mjs`). Headless Play kept the table at zero, so only `watch`ed actors woke: mission 5's first
  capture set `doorclosed` (the lab's alarm units, tag `AlarmUnit`; AlarmUnit8 fires `CloseDoor`, FlagTrigger1 then FlagTrigger0) during the armory pickups
  and Play did not; with the camera zone stamped Play sets it at the same snapshot. The zones the frame's portals show are stamped by the original as well
  and are not headless (no occlusion runs there): an actor woken only through a portal still needs `watch`. The stamp reopened mission 2: its subway's
  standing terrorists and hostages (bForceStasis, so stasis applies though they walk) had slept in Play and now wake as the original's do, and Play's hostages
  die where the original's ran into the train (`EscapeSuccessful`). Its first PASS rested on the sleep; `.work/chains/diag/d02-subway.mjs` reads the
  pawns' Health, Enemy, Orders, animation and location in both programs to tell an AI difference from a perception one.
* A key-locked door: the key ring in hand (`belt 0`), the left button uses it (DeusExMover.Frob with a NanoKeyRing holding `KeyIDNeeded` toggles `bLocked`),
  the right button opens it (mission 5's `levelone`, as mission 0's key door).
* A conversation step names each choice by the branch it leads to; Play checks it (a choice's own label is its `ChoiceSpeechLabel_N`, followed to the Jump),
  so a wrong index fails with the branches shown instead of taking another path (mission 8's smuggler shows four, then two).
* `frob` fails when the view selects another actor than its target (name, tag or class); a teleporter in a doorway is entered by `approach` (a `drop` lands
  on the ceiling); a placement can kill the player (mission 8: the spot east of Stanton Dowd crushes him even in God mode): plan it.
* Read the owners and the script, not only the inventory's path: mission 3's airfield helicopter (M03JockLeave's owner) enters the world only after the 747's
  Lebedev scene (Mission03.FirstFrame), which the path called optional; mission 4's `ApartmentEntered` is set on the return to Paul (FlagTrigger30, touched with
  `NSFSignalSent`, fires FlagTrigger16, which cannot be touched); mission 8's exit helicopter needs `DL_Exit_Played` (Mission08.Timer).

### Rules from the first captures of missions 2 and 3 (2026-10-25)

* **A snapshot never races the program's pace.** The original runs in real time and a typed console line takes it seconds, so whatever happens on its own
  after a step (an InfoLink an arrival's trigger plays, a conversation that follows another, a helper walking up) has happened by a snapshot in the original
  and not yet in Play: a snapshot waits on that flag, or is not taken there (mission 2's `DL_Pickup` and `DL_SubwayComplete`, mission 3's `dl_batterypark`
  and Anna's entrance, mission 11's Carla). Skill points from an InfoLink still playing at a travel land after `PreTravel` copied them to the `SKTemp_` flags
  (mission 2's first comparison: 5000 against 5300 in the flags, the same total in the text).
* **No key is down when a map starts.** The original's `walk` was one wall-clock hold: a walk into a teleporter kept the key down through the map change and
  walked the player on in the next map (mission 3's first capture: down the hangar's ramp into `dl_gochopper`'s trigger and into Paul's radius before
  Mission03.FirstFrame destroyed Paul, a conversation cut after one line), while Play's walk ends at the travel. A walk into a teleporter or an exit is now
  `untilTravel`: pulses of 0.1 s with the key up between them, in both drivers, ending once a map change is under way.
* **Inventory is the chain's own.** On the chain's line the player has what the chains gave him: mission 5's prison takes everything and the chain takes the
  pistol and the armory's rockets back; mission 9 takes the dockyard's rocket packs and the map's GEP gun (belt 2), which the welds, mission 12's bots and
  mission 14 use. A step that fires a weapon names the belt slot the chain's own inventory gives it.
* **A blocking owner wider than its conversation's radius** (the island helicopters, 461 and 300 units; a vehicle once `PutInWorld` restores its collision):
  the conversation starts by the right button from just outside the cylinder (the original never started JockBarks with the player placed inside).

## What is compared

At every `snap` the flags (equal as sets of `name|type|expiration|value`, and the default expiration), and for every map change the **travel text** the leg exported, after the
travel step's normalization (pointers by first appearance, instance numbers, and the two frame-time properties' values): the flags with their expirations, the goals, the notes, the
inventory with its ammo and belt positions, the skills, the conversation history, everything the original carries into the next map. The original's text is the TravelInfo the next
level kept (`dump-travel-win`), found through the player's own `XLevel` (a level object that is still in memory from an earlier visit is not mistaken for the arrival).

## Mission 0 and mission 1 (2026-10-23)

| Mission | Chain (steps placed unless noted) | Compared with the original |
| --- | --- | --- |
| 0, Training (`scripts/chains/mission00.mjs`, about 100 steps) | the logo map's Training button; **00_Training**: the Train key and the key door, the crowbar and the upper crate (swings until `MS_CratesBroken`), the Lockpick the crate drops (the player is placed by where it lies) and the gun door, DataCube0 and Keypad0 (0012), the multitool and the Keypad2 hack, the cadet's body searched, carried to the table and dropped on the trigger; Teleporter0 (a fall into its cylinder); **00_TrainingCombat**: the walk into DataLinkTrigger20 (DL_CombatEntry), the four DefuseLAM LAMs disarmed and taken with the level held (DL_DefuseFinish from Mission00.Timer), Teleporter5; **00_TrainingFinal**: God mode, the stealth maze's two switches, Keypad1 (0089), the walk into ConversationTrigger1 (M00MeetPage), MapExit0 to DX | 8 snapshots' flags, 15 door states (`KeyNum`, `bLocked` of the key door, gun door picked and opened, the pad and hack doors, the body's doors, the stealth doors, the bridge) and 4 travel texts (74, 110, 119 and 126 records): all equal |
| 1, Liberty Island and UNATCO HQ (`mission01.mjs`) | New Game (Medium, the intro left by Escape); the walk for DL_StartGame, **MeetPaul** (the first choice, the rifle); the Statue's top: **MeetTerrorist** (the second choice, the questioning branch: `StatueMissionComplete`), Mission01.Timer's pass (UN_maindoor and the Statue ruins' doors unlocked) and DL_LeaderNotKilled; Teleporter3; **HQ**: MeetCarter (the first offer), MeetJaime, M02Briefing, Paul's bark; Teleporter2 (the filed Island restored); the police boat frobbed from the dock's edge (**GotoM02**), the camera path, 02_NYC_BatteryPark, Anna's dock conversation and her run to the castle | 9 snapshots' flags, 7 door states and 5 travel texts (96, 79, 149, 214 and 217 records: the exit text carries the goals, the notes, the conversation history, the inventory and the flags with their expirations) |

Each equality is by `validate-stage6-chain.mjs --mission 00|01` against a capture in `.work/chains/m<NN>/` (outside Git). **Weak, as the rows say:** the player is placed at each step and the walk and the fights between
are not part of the row; the original ran in real time (a step takes the original several times Play's Level seconds), so waits end on a flag where the run's own timing decides (`PaulFinalBark_Played`,
`AnnaReachedCastle`), the LAMs are defused with the level held, and the Final map's Soldiers and the Island's Terrorists are made harmless with God mode (the placed player stands in their view for the original's
longer seconds). A conversation with a `ConEventRandomLabel` says one of its alternatives by the game's random stream, which the two runs do not share: the comparison accepts a history event whose speech differs
from the original's only when both speeches belong to one conversation with a random label (`scripts/chain-conversations.mjs`; the Carter bark's two lines in mission 1, one event in each of two texts).

## Mission 15: the three endings (rows 6.5.1 to 6.5.3, 2026-10-24)

Each ending is a chain from a real desktop slot (`start: { kind: 'slot' }`: the slot's files put into the save folder, `LoadGame <index>` from the logo map; Play puts
them into its save directory, the original's driver copies them into the prefix after the probe set the folder aside), nicouzouf `Save0042` (`15_Area51_page`: the
Final, Entrance and Bunker filed in `Current`, MeetHelios played, no ending's flag set), then the in-world chain that the maps' own actors spell out
([the criteria rows](stage-6-exit-criteria.md) name it), the ending's own trigger, the endgame, 120 s for the conversation, the quote and the credits to start, a click on
the credits and the arrival at `dxonly`:

| Ending | Chain (`scripts/chains/mission15e<n>.mjs`) |
| --- | --- |
| 3, Illuminati | the four node keypads (7243), each waiting for its `DL_Blue<n>` (Mission15.Timer plays the InfoLink of the count of set flags: four at once would play `DL_Blue4` alone), `Page_button` open, `Switch4` (`kill_page`, Dispatcher1, `start_endgame`) |
| 2, Helios | the uplink buttons `Button18`/`Button19` (`UplinkLock1/2`), `ComputerPersonal0` logged in (`type`, Tab, `type`, Enter) and its special option clicked (`point`: the button's centre in Play's terminal moved by the difference of the root centres, (641,329) of the original's 1280x720 viewport; `HeliosFree`), Escape twice, `Teleporter8` to the filed Final, `FlagTrigger3` (`Merge_helios_exit`) |
| 1, New Dark Age | Page's coolant `Switch0` (`coolantcut`), `Teleporter8`, the Timer's switch swap (`MS_ButtonsHidden`), `Switch10` and `Switch16` and one drop into the overlapping coolant FlagTriggers 2 and 4 (each LogicTrigger input toggles: each touched once), a walk into a `DL_Tong7` trigger (`ReactorReady`), `FlagTrigger5` (`Generator_panel`), the three reactor buttons in turn (each opens the cover of the next), `FlagTrigger9` (`Generator_overload`), Final's `Switch4` (`destroy_generator`); the Mechanic's overheard `PowerGuyScared1` (before the first button) and `2` (before the third) are waited for: the original's first capture had them and Play none, because the Mechanic, never drawn headless, kept a stale `DistanceFromPlayer` (the `watch` stand-in from the reactor room on); `PowerGuyScared3` (button 3) started in neither program (120 s waited in Play; why it does not start is unresolved); the endgame's snapshot waits for `EndgameExplosions` (Endgame1 sets it at its own pace) |

Two ops came with them: `type` (text into the field that holds the keyboard, with its WM_CHAR units) and `point` (a click at a point of the original's viewport over a
centred window). The planner's `face` takes `--before "CauseEvent a; CauseEvent b"` for a target a chain uncovers first (a mover the chain opens), and `face-chain <mission> <step> <actor>...`
plans in the level the chain reaches at a step: a slot's level is not the cold map (ending 1's spot north of Page's coolant switch lands 34 units higher in Save0042's level, in both
programs, and the frob misses; the restored Final's spots near the generator switches differ too), so ending 1's placements from the coolant switch on are planned there. A
slot can also hold a device mid-animation: Save0042 saved `ComputerPersonal0` in state `Off` at its `Begin` code's `FinishAnim` (`bAnimating`), and `Computers.Frob` does
nothing until the animation ends, which needs the computer drawn: ending 2 starts the `watch` stand-in at the placement and waits 2 s before the frob. God mode
(`ReducedDamageType`) and `bCheatsEnabled` are not travel properties: every arrival drops both, in Play as in the original, so a chain types the two lines again after each map
change (the first ending 1 capture lost its player to the reactor's radiation in Final over the original's longer real seconds). On the Linux host a
capture started over ssh needs the session's display (`DISPLAY=:0`, `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`): without it the game does not come up.

## What the chains found

Each was found by a difference at a snapshot or in a text, fixed from the original's own evidence, and checked by the chain again.

1. **A restored or loaded level's decoration could not speak** (mission 1, `GotoM02` after the HQ round trip: `Unsupported original door native 264 PlaySound from conplay.playspeech`; the player could not leave the mission).
   The boat, a pre-placed actor of a level restored from `Save\Current` (or loaded from a slot), has no measured GObjObjects slot, and the speech's channel id needs its index. `ScriptRuntime.soundObjectIndex` now answers
   `{source: 'restored'}` for such an actor with the one model of a restored level ([travel](travel.md), Unresolved 10: the hash slot `0x100000` + the export index), reported with the modeled spawns
   (`audio.modeledIds`). **Unverified**: one sample against the original (the chain's `gobjects` op, mission 1): the boat is index 38639 on the New Game's arrival, 35580 after the HQ round trip, and the
   model says 1,050,470; of 482 actors present in both captures no constant offset separates the two numberings (408 different offsets), so the model has no basis beyond being unique. It feeds only the channel id of a
   speech. Check: `validate-restored-speech.mjs` (a fresh Island keeps its measured 36115; the restored Island and a real slot, nicouzouf's Save0002, take the model and play GotoM02).
2. **A Name value's spelling is the first one a package entered** (mission 0, `dl_bodyexit_Played` in the original, `DL_bodyexit_Played` in Play): the Training map spells a DataLinkTrigger's tag `dl_bodyexit`, DeusExConText spells
   the conversation `DL_bodyexit`, the map loads first, so the original's FName (and `con.conName $ "_Played"`) is lowercase; `M00MeetPage_Played` stays capitalized because DeusEx.u, a startup package, has it.
   Mission 10 (`DL_EverettContact_Played` and `DL_EverettMaze_Played` in the original, `DL_everettcontact_played` and `DL_everettmaze_Played` in Play) gave the rule across levels: LoadMap enters the next map's names
   before its collection, while the previous level's DeusExConText is still loaded, and the collection keeps the new map's names with those spellings ([script-names.md](script-names.md#spelling-across-levels): Core
   addresses and the original's engine log). Play's `src/unreal/name-spelling.mjs` now models the process's table across levels (startup packages, LoadMap's entry and collection, DeusExConText at each level's start,
   StringToName and the travel text's names); what it leaves out is listed there. `dl_start_Played` (Play's spelling now) is not yet measured (a probe, `.work/chains/probe-dlstart.mjs`, is written). Three pinned spellings were relaxed to a comparison without case
   (`script-infolink-content`, `script-infolink-audio`, `validate-training-datalinks`).

Findings that were the harness's, not Play's: the dump tool `dump-travel-win.exe` was not built on the Linux host (the travel captures were the Mac's); a placement inside a Teleporter's or exit's cylinder raises no Touch (the fall
into it does, and a key held across the map change walks the player in the next map); an NPC with Sitting or Wandering orders must be measured after it has settled; a headless frame draws no actor mesh, so a pawn's radius
conversation needs the `watch` stand-in (Anna's, Paul's); a door that closes again by itself (the final doors) has no stable state to compare; a Lockpick is used up by its door (the next item's belt slot moves up);
the boat's blocking cylinder keeps a walking player out of the conversation's radius (the walk stops at x -4786.4 in both programs), so the conversation starts by the right button.

## Left open

* 6.4.00.3 and 6.4.01.3 (the conversation censuses) are the other worker's; 6.4.01.2 (both sides of the seven carried flags: the aggressive branch of MeetTerrorist, Filben's two offers, Gunther's, the kill) is a second chain per branch on this harness.
* The course of Training (jump, ladder, crate stack, swim), the dark doors and the medical door; the Island's Statue gates (Filben's key, the ruins, the lasers) are walked past by the placement.
* Name spellings: the rule across levels is recovered and measured on two chains, but the parts Play does not model stay unverified (script-names.md "Spelling across levels"); the restored-level index model stays unverified
  (above). `DL_Start`'s flag spelling needs its probe run under Wine.
* Each later mission needs its chain; the harness is the same (`start` from the previous mission's exit or a real slot, `chain-plan.mjs` for the placements).
