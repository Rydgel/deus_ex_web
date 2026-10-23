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

## What the chains found

Each was found by a difference at a snapshot or in a text, fixed from the original's own evidence, and checked by the chain again.

1. **A restored or loaded level's decoration could not speak** (mission 1, `GotoM02` after the HQ round trip: `Unsupported original door native 264 PlaySound from conplay.playspeech`; the player could not leave the mission).
   The boat, a pre-placed actor of a level restored from `Save\Current` (or loaded from a slot), has no measured GObjObjects slot, and the speech's channel id needs its index. `ScriptRuntime.soundObjectIndex` now answers
   `{source: 'restored'}` for such an actor with the one model of a restored level ([travel](travel.md), Unresolved 10: the hash slot `0x100000` + the export index), reported with the modeled spawns
   (`audio.modeledIds`). **Unverified**: one sample against the original (the chain's `gobjects` op, mission 1): the boat is index 38639 on the New Game's arrival, 35580 after the HQ round trip, and the
   model says 1,050,470; of 482 actors present in both captures no constant offset separates the two numberings (408 different offsets), so the model has no basis beyond being unique. It feeds only the channel id of a
   speech. Check: `validate-restored-speech.mjs` (a fresh Island keeps its measured 36115; the restored Island and a real slot, nicouzouf's Save0002, take the model and play GotoM02).
2. **A Name value's spelling is the first one a package entered** (mission 0, `dl_bodyexit_Played` in the original, `DL_bodyexit_Played` in Play): the Training map spells a DataLinkTrigger's tag `dl_bodyexit`, DeusExConText spells
   the conversation `DL_bodyexit`, the map loads first, so the original's FName (and `con.conName $ "_Played"`) is lowercase; `M00MeetPage_Played` stays capitalized because DeusEx.u, a startup package, has it. Play now
   keeps two layers (`src/unreal/name-spelling.mjs`): the names of the startup script packages (DeusEx, Core, Engine, Extension, ConSys) and the names of the current map, first spelling wins, applied to Name-typed
   property values (`readObject`) and to `StringToName`. **Unverified in general**: one measured case (`dl_bodyexit`, `M00MeetPage`); a name that stays alive across a travel keeps its first spelling in the original and
   takes the new level's here; `dl_start_Played` (Play's spelling now) is not yet measured (a probe, `.work/chains/probe-dlstart.mjs`, is written). Three pinned spellings were relaxed to a comparison without case
   (`script-infolink-content`, `script-infolink-audio`, `validate-training-datalinks`).

Findings that were the harness's, not Play's: the dump tool `dump-travel-win.exe` was not built on the Linux host (the travel captures were the Mac's); a placement inside a Teleporter's or exit's cylinder raises no Touch (the fall
into it does, and a key held across the map change walks the player in the next map); an NPC with Sitting or Wandering orders must be measured after it has settled; a headless frame draws no actor mesh, so a pawn's radius
conversation needs the `watch` stand-in (Anna's, Paul's); a door that closes again by itself (the final doors) has no stable state to compare; a Lockpick is used up by its door (the next item's belt slot moves up);
the boat's blocking cylinder keeps a walking player out of the conversation's radius (the walk stops at x -4786.4 in both programs), so the conversation starts by the right button.

## Left open

* 6.4.00.3 and 6.4.01.3 (the conversation censuses) are the other worker's; 6.4.01.2 (both sides of the seven carried flags: the aggressive branch of MeetTerrorist, Filben's two offers, Gunther's, the kill) is a second chain per branch on this harness.
* The course of Training (jump, ladder, crate stack, swim), the dark doors and the medical door; the Island's Statue gates (Filben's key, the ruins, the lasers) are walked past by the placement.
* Name spellings in general, and the restored-level index model, stay unverified (above). `DL_Start`'s flag spelling needs its probe run under Wine.
* Each later mission needs its chain; the harness is the same (`start` from the previous mission's exit or a real slot, `chain-plan.mjs` for the placements).
