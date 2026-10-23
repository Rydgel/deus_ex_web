# Stage 6 exit criteria: a finite definition of "Done when"

Status: **adopted by the user on 2026-10-23** in four decisions ([below](#what-the-user-decided-2026-10-23)); written from master fe15b3cb. The data is
`scripts/stage6-criteria.mjs` (`node scripts/stage6-criteria.mjs` prints the scoreboard, `--list` the rows, `--markdown` the tables of this note); the
facts each mission row is built from are in [the Stage 6 inventory](stage-6-inventory.md). There is no gate script yet: a row's PASS below means its proof
checks exist and passed on their last run, not that a gate ran them together. The gate (`validate-stage6-acceptance.mjs`, on the model of
[Stage 5's](stage-5-exit-criteria.md#running)) is written once the first mission rows have proofs.

The roadmap's criterion for section 6 ([roadmap](roadmap.md#6-persist-progress-and-complete-the-campaign)): *done when reloads and return visits preserve
expected world state, and the campaign can be completed through representative choices and endings without progression blockers. Validate each
mission's conversations, events, and transitions against the original game; keep a per-mission compatibility checklist.* The rows below fix what
"representative", "completed", "without progression blockers" and the checklist mean: clause 6.4 **is** the per-mission checklist.

## What the user decided (2026-10-23)

1. **A mission proves it can be completed by a placed chain.** The mission's required chain (the inventory's "Progression path" of each mission: the
   conversations, InfoLinks, triggers, keys and flags on every path from the arrival to an exit) is played in order with the player placed at each step,
   as Stage 5's placed approaches were; the row passes when Play's flags, goals, notes and travel text at the mission's exit equal the original's under
   Wine from the same start. Walking and fighting between the steps is not part of the row.
2. **Representative choices are the lasting ones.** One full route, plus both sides of each of the 36 carried flags (a flag set in one mission and read in a
   later one, the inventory's "The choices with lasting consequences"), each checked where the later mission reads it (a conversation branch, a pawn
   present or absent, a script's effect). The deaths of the `bImportant` pawns count with them where a later mission reads them.
3. **Every conversation runs; the chain's are compared.** Every one of the 1,627 own conversations of the mission lists starts and runs to its end in Play
   without a stop (a Play census); those on each mission's required chain are compared with the original by the chain row.
4. **One unbroken run.** One run in Play from New Game to an ending, each mission entered from the previous mission's exit (no save loaded), is the final proof
   that the campaign can be completed (row 6.6.1).

## What a row is, and what passes it

As in Stage 5 ([what passes a row](stage-5-exit-criteria.md#what-a-scenario-is-and-what-passes-it)): a row passes when it **runs** in Play through the
player's own inputs (the menus, the bindings, `game.use`, conversations started as their owner or trigger starts them; placing the player is a harness
step, labelled), when its **proof** compares Play with the original's own output for the same inputs (**O1**: a Wine capture of the same steps, compared by
the normalizer of [travel](travel.md) and the replay tools of [Stage 5](stage-5-exit-criteria.md)), and when nothing it needs is a substitute. A row
marked **P** compares Play with itself (a census that every conversation or transition runs without a stop); it passes on a clean census, and a stop by name
is a FAIL until it is fixed or made an explicit boundary with its reason. Rows that need a capture nobody has made are **MISSING**; rows whose work runs now are
**UNDRIVEN**; **PARTIAL** means a proof exists but the row's sample is not complete.

Starts: a mission row starts from a real desktop save of that mission where one exists (`.work/internet-saves`, 41 slots covering missions 1 to 6, 8 to 10,
12, 14 and 15; the inventory's slot tables say what each one has already chosen), else from the previous mission's exit, else (Training, mission 11) from the
menu or a cold open of the mission's first map. The same start is loaded in Play and in the original.

## The scoreboard (2026-10-23, after the first two chains)

| Clause | PASS | PARTIAL | UNDRIVEN | MISSING | EXCLUDED |
| --- | ---: | ---: | ---: | ---: | ---: |
| 6.1 The start and the menus | 5 | 0 | 0 | 1 | 0 |
| 6.2 Persistence | 5 | 0 | 0 | 1 | 0 |
| 6.3 Transitions | 2 | 0 | 0 | 0 | 0 |
| 6.4 The missions | 2 | 0 | 0 | 34 | 0 |
| 6.5 The endings | 0 | 0 | 0 | 3 | 0 |
| 6.6 The campaign in one run | 0 | 0 | 0 | 1 | 0 |
| 6.7 Excluded | 0 | 0 | 0 | 0 | 3 |
| **Total** | 14 | 0 | 0 | 40 | 3 |

## The rows

### 6.1 The start and the menus

| Row | Criterion | Evidence | Proof | Needed / weak / pending | Status |
| --- | --- | --- | --- | --- | --- |
| 6.1.1 | the page starts as the original: the splash, the logo map with its camera flight, MenuMain on Escape or a click | O1 | validate-travel-play.mjs, browser-tests/original-start-input.spec.mjs | - | PASS |
| 6.1.2 | New Game: the difficulty and skill screens, the intro, then the Island with the starting items and flags | O1 | validate-travel-newgame.mjs, validate-travel-newgame-play.mjs | - | PASS |
| 6.1.3 | Training from the menu: 00_Training with the travel text and the arrival flags | O1 | validate-travel.mjs, validate-travel-play.mjs | - | PASS |
| 6.1.4 | Play Intro and Credits from the menu, to their ends and back to the menu | O1 | validate-travel-endings.mjs, browser-tests/original-start-intro-credits.spec.mjs | - | PASS |
| 6.1.5 | the settings the menus write are kept across map loads and reloads, as the original writes DeusEx.ini and User.ini | O1 | validate-config-persistence.mjs, browser-tests/config-persistence.spec.mjs | - | PASS |
| 6.1.6 | every MenuMain entry reaches its screen or action (Multiplayer excluded) | P | - | a check of each entry's screen against the original (the census is Play-only), and Exit: what the original does and what the page does instead (unmeasured) | MISSING |

### 6.2 Persistence

| Row | Criterion | Evidence | Proof | Needed / weak / pending | Status |
| --- | --- | --- | --- | --- | --- |
| 6.2.1 | a return visit within a mission restores the level as it was left (destroyed actors, items, movers, the level time; no begin-play pass) | O1 | validate-travel-restore.mjs, validate-travel-restore-play.mjs, validate-travel-restore-play.mjs --island | - | PASS |
| 6.2.2 | a game saved in Play and loaded in Play is the saved game: flags, inventory, player, augmentations and skills, notes, goals, history, the actor census | O1 | - | a validator that saves in Play at a played state and loads the slot in Play, comparing the loaded state with the saved one, and with the original's state after loading the same slot | MISSING |
| 6.2.3 | real desktop saves load in Play with the state the original loads from them | O1 | validate-load-game.mjs, validate-load-saves.mjs | weak: the state comparison against the original covers 6 slots; the other 35 are checked for loading and running only | PASS |
| 6.2.4 | a slot Play writes loads in the original with the saved player, items and flags | O1 | validate-save-game.mjs, validate-save-info-corpus.mjs | - | PASS |
| 6.2.5 | QuickSave and QuickLoad, the Load Game screen in a running game, and Load Game after the player's death | O1 | validate-load-ui.mjs, browser-tests/load-game.spec.mjs, browser-tests/save-game.spec.mjs | - | PASS |
| 6.2.6 | saves are kept in the browser or a folder the player picked, can be exported and imported, and a storage failure is said and leaves the game running | P | browser-tests/save-folder.spec.mjs, browser-tests/save-game.spec.mjs | weak: the folder picker of a real (headed) browser and persist() were not run; Firefox and Safari are Stage 7's | PASS |

### 6.3 Transitions

| Row | Criterion | Evidence | Proof | Needed / weak / pending | Status |
| --- | --- | --- | --- | --- | --- |
| 6.3.1 | every MapExit, Teleporter and scripted travel of the single-player maps arrives (198 transitions), from a real save of its mission where one exists | P | census-transitions.mjs | weak: the 22 triggered exits get their Trigger call, not the conversation or dispatcher chain that fires them in the original; 5 s of arrival ticks; the arrivals at dx, DXOnly and the endings are 6.1.4/6.5's | PASS |
| 6.3.2 | a sample of every family of transition equals the original: the log lines, the travel text, the flags, the arrival place and the Save\Current listing | O1 | validate-travel-transitions.mjs, validate-travel.mjs | weak: one sample per family; the camera-path rides are bounded by one sample each; the two scripted SendPlayers (Mission04, Mission11) are not measured in the original | PASS |

### 6.4 The missions

| Row | Criterion | Evidence | Proof | Needed / weak / pending | Status |
| --- | --- | --- | --- | --- | --- |
| 6.4.00.1 | mission 0: the required chain (docs/stage-6-inventory.md "Progression path"), each step placed, runs from the arrival to the exit; the flags, goals, notes and travel text at the exit equal the original's | O1 | validate-stage6-chain.mjs --mission 00 | weak: the first and last maps' gates and the two InfoLinks are the chain; the course (jump, ladder, crate stack, swim) and the dark doors are not driven (a door the original closes again by itself has no stable state to compare); the Final map's Soldiers are made harmless (God mode) because the player is placed in their view and the original's real seconds are longer than Play's; the LAMs are defused with the level held (their countdown is shorter than a console line takes); the player is placed at each step, as Stage 5's placed approaches: the walk and the fights between the steps are not part of the row (the user's decision) | PASS |
| 6.4.00.3 | mission 0: every conversation and InfoLink of its list starts and runs to its end in Play without a stop; those on the required chain are compared with the original by 6.4.00.1 | P | - | a conversation census over the mission's own conversations (docs/stage-6-inventory.md), each started as its owner or trigger starts it | MISSING |
| 6.4.01.1 | mission 1: the required chain (docs/stage-6-inventory.md "Progression path"), each step placed, runs from the arrival to the exit; the flags, goals, notes and travel text at the exit equal the original's | O1 | validate-stage6-chain.mjs --mission 01 | weak: one branch of the commander (the aggressive branch, and the kill, are 6.4.01.2's); the Statue's gates (Filben's key, the ruins' doors, the lasers) are walked past by the placement; God mode on the Island (29 Terrorists patrol it); the boat is frobbed from the dock's edge because its blocking cylinder keeps a walking player outside the conversation's radius (measured in the original: the walk stops at x -4786.4 in both programs); a conversation's random-label speech may differ between two runs (the game's random stream is not shared) and is accepted as that conversation's alternative; the player is placed at each step, as Stage 5's placed approaches: the walk and the fights between the steps are not part of the row (the user's decision) | PASS |
| 6.4.01.2 | mission 1: both sides of each of its 7 carried flags, checked where the later mission reads them (the conversation branch, the pawn present or absent, the script's effect), equal to the original | O1 | - | per carried flag: the two branches set in the mission (or a slot holding each), the reader's observable in the later mission, in Play and under Wine | MISSING |
| 6.4.01.3 | mission 1: every conversation and InfoLink of its list starts and runs to its end in Play without a stop; those on the required chain are compared with the original by 6.4.01.1 | P | - | a conversation census over the mission's own conversations (docs/stage-6-inventory.md), each started as its owner or trigger starts it | MISSING |
| 6.4.02.1 | mission 2: the required chain (docs/stage-6-inventory.md "Progression path"), each step placed, runs from the arrival to the exit; the flags, goals, notes and travel text at the exit equal the original's | O1 | - | a placed-chain scene of the mission in Play and under Wine from the same start (a real slot of the mission, else the previous mission's exit), compared at the exit; weak: the player is placed at each step, as Stage 5's placed approaches: the walk and the fights between the steps are not part of the row (the user's decision) | MISSING |
| 6.4.02.2 | mission 2: both sides of each of its 13 carried flags, checked where the later mission reads them (the conversation branch, the pawn present or absent, the script's effect), equal to the original | O1 | - | per carried flag: the two branches set in the mission (or a slot holding each), the reader's observable in the later mission, in Play and under Wine | MISSING |
| 6.4.02.3 | mission 2: every conversation and InfoLink of its list starts and runs to its end in Play without a stop; those on the required chain are compared with the original by 6.4.02.1 | P | - | a conversation census over the mission's own conversations (docs/stage-6-inventory.md), each started as its owner or trigger starts it | MISSING |
| 6.4.03.1 | mission 3: the required chain (docs/stage-6-inventory.md "Progression path"), each step placed, runs from the arrival to the exit; the flags, goals, notes and travel text at the exit equal the original's | O1 | - | a placed-chain scene of the mission in Play and under Wine from the same start (a real slot of the mission, else the previous mission's exit), compared at the exit; weak: the player is placed at each step, as Stage 5's placed approaches: the walk and the fights between the steps are not part of the row (the user's decision) | MISSING |
| 6.4.03.2 | mission 3: both sides of each of its 5 carried flags, checked where the later mission reads them (the conversation branch, the pawn present or absent, the script's effect), equal to the original | O1 | - | per carried flag: the two branches set in the mission (or a slot holding each), the reader's observable in the later mission, in Play and under Wine | MISSING |
| 6.4.03.3 | mission 3: every conversation and InfoLink of its list starts and runs to its end in Play without a stop; those on the required chain are compared with the original by 6.4.03.1 | P | - | a conversation census over the mission's own conversations (docs/stage-6-inventory.md), each started as its owner or trigger starts it | MISSING |
| 6.4.04.1 | mission 4: the required chain (docs/stage-6-inventory.md "Progression path"), each step placed, runs from the arrival to the exit; the flags, goals, notes and travel text at the exit equal the original's | O1 | - | a placed-chain scene of the mission in Play and under Wine from the same start (a real slot of the mission, else the previous mission's exit), compared at the exit; weak: the player is placed at each step, as Stage 5's placed approaches: the walk and the fights between the steps are not part of the row (the user's decision) | MISSING |
| 6.4.04.2 | mission 4: both sides of each of its 3 carried flags, checked where the later mission reads them (the conversation branch, the pawn present or absent, the script's effect), equal to the original | O1 | - | per carried flag: the two branches set in the mission (or a slot holding each), the reader's observable in the later mission, in Play and under Wine | MISSING |
| 6.4.04.3 | mission 4: every conversation and InfoLink of its list starts and runs to its end in Play without a stop; those on the required chain are compared with the original by 6.4.04.1 | P | - | a conversation census over the mission's own conversations (docs/stage-6-inventory.md), each started as its owner or trigger starts it | MISSING |
| 6.4.05.1 | mission 5: the required chain (docs/stage-6-inventory.md "Progression path"), each step placed, runs from the arrival to the exit; the flags, goals, notes and travel text at the exit equal the original's | O1 | - | a placed-chain scene of the mission in Play and under Wine from the same start (a real slot of the mission, else the previous mission's exit), compared at the exit; weak: the player is placed at each step, as Stage 5's placed approaches: the walk and the fights between the steps are not part of the row (the user's decision) | MISSING |
| 6.4.05.2 | mission 5: both sides of each of its 3 carried flags, checked where the later mission reads them (the conversation branch, the pawn present or absent, the script's effect), equal to the original | O1 | - | per carried flag: the two branches set in the mission (or a slot holding each), the reader's observable in the later mission, in Play and under Wine | MISSING |
| 6.4.05.3 | mission 5: every conversation and InfoLink of its list starts and runs to its end in Play without a stop; those on the required chain are compared with the original by 6.4.05.1 | P | - | a conversation census over the mission's own conversations (docs/stage-6-inventory.md), each started as its owner or trigger starts it | MISSING |
| 6.4.06.1 | mission 6: the required chain (docs/stage-6-inventory.md "Progression path"), each step placed, runs from the arrival to the exit; the flags, goals, notes and travel text at the exit equal the original's | O1 | - | a placed-chain scene of the mission in Play and under Wine from the same start (a real slot of the mission, else the previous mission's exit), compared at the exit; weak: the player is placed at each step, as Stage 5's placed approaches: the walk and the fights between the steps are not part of the row (the user's decision) | MISSING |
| 6.4.06.3 | mission 6: every conversation and InfoLink of its list starts and runs to its end in Play without a stop; those on the required chain are compared with the original by 6.4.06.1 | P | - | a conversation census over the mission's own conversations (docs/stage-6-inventory.md), each started as its owner or trigger starts it | MISSING |
| 6.4.08.1 | mission 8: the required chain (docs/stage-6-inventory.md "Progression path"), each step placed, runs from the arrival to the exit; the flags, goals, notes and travel text at the exit equal the original's | O1 | - | a placed-chain scene of the mission in Play and under Wine from the same start (a real slot of the mission, else the previous mission's exit), compared at the exit; weak: the player is placed at each step, as Stage 5's placed approaches: the walk and the fights between the steps are not part of the row (the user's decision) | MISSING |
| 6.4.08.2 | mission 8: both sides of each of its 3 carried flags, checked where the later mission reads them (the conversation branch, the pawn present or absent, the script's effect), equal to the original | O1 | - | per carried flag: the two branches set in the mission (or a slot holding each), the reader's observable in the later mission, in Play and under Wine | MISSING |
| 6.4.08.3 | mission 8: every conversation and InfoLink of its list starts and runs to its end in Play without a stop; those on the required chain are compared with the original by 6.4.08.1 | P | - | a conversation census over the mission's own conversations (docs/stage-6-inventory.md), each started as its owner or trigger starts it | MISSING |
| 6.4.09.1 | mission 9: the required chain (docs/stage-6-inventory.md "Progression path"), each step placed, runs from the arrival to the exit; the flags, goals, notes and travel text at the exit equal the original's | O1 | - | a placed-chain scene of the mission in Play and under Wine from the same start (a real slot of the mission, else the previous mission's exit), compared at the exit; weak: the player is placed at each step, as Stage 5's placed approaches: the walk and the fights between the steps are not part of the row (the user's decision) | MISSING |
| 6.4.09.3 | mission 9: every conversation and InfoLink of its list starts and runs to its end in Play without a stop; those on the required chain are compared with the original by 6.4.09.1 | P | - | a conversation census over the mission's own conversations (docs/stage-6-inventory.md), each started as its owner or trigger starts it | MISSING |
| 6.4.10.1 | mission 10: the required chain (docs/stage-6-inventory.md "Progression path"), each step placed, runs from the arrival to the exit; the flags, goals, notes and travel text at the exit equal the original's | O1 | - | a placed-chain scene of the mission in Play and under Wine from the same start (a real slot of the mission, else the previous mission's exit), compared at the exit; weak: the player is placed at each step, as Stage 5's placed approaches: the walk and the fights between the steps are not part of the row (the user's decision) | MISSING |
| 6.4.10.2 | mission 10: both sides of each of its 1 carried flags, checked where the later mission reads them (the conversation branch, the pawn present or absent, the script's effect), equal to the original | O1 | - | per carried flag: the two branches set in the mission (or a slot holding each), the reader's observable in the later mission, in Play and under Wine | MISSING |
| 6.4.10.3 | mission 10: every conversation and InfoLink of its list starts and runs to its end in Play without a stop; those on the required chain are compared with the original by 6.4.10.1 | P | - | a conversation census over the mission's own conversations (docs/stage-6-inventory.md), each started as its owner or trigger starts it | MISSING |
| 6.4.11.1 | mission 11: the required chain (docs/stage-6-inventory.md "Progression path"), each step placed, runs from the arrival to the exit; the flags, goals, notes and travel text at the exit equal the original's | O1 | - | a placed-chain scene of the mission in Play and under Wine from the same start (a real slot of the mission, else the previous mission's exit), compared at the exit; weak: the player is placed at each step, as Stage 5's placed approaches: the walk and the fights between the steps are not part of the row (the user's decision) | MISSING |
| 6.4.11.2 | mission 11: both sides of each of its 2 carried flags, checked where the later mission reads them (the conversation branch, the pawn present or absent, the script's effect), equal to the original | O1 | - | per carried flag: the two branches set in the mission (or a slot holding each), the reader's observable in the later mission, in Play and under Wine | MISSING |
| 6.4.11.3 | mission 11: every conversation and InfoLink of its list starts and runs to its end in Play without a stop; those on the required chain are compared with the original by 6.4.11.1 | P | - | a conversation census over the mission's own conversations (docs/stage-6-inventory.md), each started as its owner or trigger starts it | MISSING |
| 6.4.12.1 | mission 12: the required chain (docs/stage-6-inventory.md "Progression path"), each step placed, runs from the arrival to the exit; the flags, goals, notes and travel text at the exit equal the original's | O1 | - | a placed-chain scene of the mission in Play and under Wine from the same start (a real slot of the mission, else the previous mission's exit), compared at the exit; weak: the player is placed at each step, as Stage 5's placed approaches: the walk and the fights between the steps are not part of the row (the user's decision) | MISSING |
| 6.4.12.3 | mission 12: every conversation and InfoLink of its list starts and runs to its end in Play without a stop; those on the required chain are compared with the original by 6.4.12.1 | P | - | a conversation census over the mission's own conversations (docs/stage-6-inventory.md), each started as its owner or trigger starts it | MISSING |
| 6.4.14.1 | mission 14: the required chain (docs/stage-6-inventory.md "Progression path"), each step placed, runs from the arrival to the exit; the flags, goals, notes and travel text at the exit equal the original's | O1 | - | a placed-chain scene of the mission in Play and under Wine from the same start (a real slot of the mission, else the previous mission's exit), compared at the exit; weak: the player is placed at each step, as Stage 5's placed approaches: the walk and the fights between the steps are not part of the row (the user's decision) | MISSING |
| 6.4.14.3 | mission 14: every conversation and InfoLink of its list starts and runs to its end in Play without a stop; those on the required chain are compared with the original by 6.4.14.1 | P | - | a conversation census over the mission's own conversations (docs/stage-6-inventory.md), each started as its owner or trigger starts it | MISSING |
| 6.4.15.1 | mission 15: the required chain (docs/stage-6-inventory.md "Progression path"), each step placed, runs from the arrival to the exit; the flags, goals, notes and travel text at the exit equal the original's | O1 | - | a placed-chain scene of the mission in Play and under Wine from the same start (a real slot of the mission, else the previous mission's exit), compared at the exit; weak: the player is placed at each step, as Stage 5's placed approaches: the walk and the fights between the steps are not part of the row (the user's decision) | MISSING |
| 6.4.15.3 | mission 15: every conversation and InfoLink of its list starts and runs to its end in Play without a stop; those on the required chain are compared with the original by 6.4.15.1 | P | - | a conversation census over the mission's own conversations (docs/stage-6-inventory.md), each started as its owner or trigger starts it | MISSING |

### 6.5 The endings

| Row | Criterion | Evidence | Proof | Needed / weak / pending | Status |
| --- | --- | --- | --- | --- | --- |
| 6.5.1 | ending 1 from its in-world trigger, the reactor switches (Tong's ending): the endgame, the credits and the menu, equal to the original | O1 | - | the original driven through the same trigger (Final's MapExit0 sits in solid space: the trigger, not the exit actor, is the way) | MISSING |
| 6.5.2 | ending 2 from its in-world trigger, Helios' hub: the endgame, the credits and the menu, equal to the original | O1 | - | the original driven through the same trigger (Final's MapExit0 sits in solid space: the trigger, not the exit actor, is the way) | MISSING |
| 6.5.3 | ending 3 from its in-world trigger, Page's bunker (killpage): the endgame, the credits and the menu, equal to the original | O1 | - | the original driven through the same trigger (Final's MapExit0 sits in solid space: the trigger, not the exit actor, is the way) | MISSING |

### 6.6 The campaign in one run

| Row | Criterion | Evidence | Proof | Needed / weak / pending | Status |
| --- | --- | --- | --- | --- | --- |
| 6.6.1 | one run in Play from New Game to an ending, each mission entered from the previous mission's exit (no save loaded), every required step placed; the travel text at each mission change equals the original's for the same run | O1 | - | the chained run in Play, and the original's texts at each mission change from the same chained steps (the 6.4.*.1 captures chained) | MISSING |

### 6.7 Excluded

| Row | Criterion | Evidence | Proof | Needed / weak / pending | Status |
| --- | --- | --- | --- | --- | --- |
| 6.7.1 | multiplayer: the DXMP_* maps, the Multiplayer menu, server travel | - | - | multiplayer is the last priority (AGENTS.md) | EXCLUDED |
| 6.7.2 | missions 7 and 13 | - | - | the installed game has no maps, scripts or conversation lists of their own (ConList_Mission07 duplicates 06) | EXCLUDED |
| 6.7.3 | Firefox and Safari, a headed browser's folder picker | - | - | Stage 7 (browser reliability) | EXCLUDED |

## The order of the remaining work

1. **6.3.1, the transition census**: done 2026-10-23 (198 of 198 arrive, [travel transitions](travel-transitions.md)); its two families of stop were fixed.
2. **6.4.\*.3, the conversation census**: every own conversation of each list started in Play as its owner or trigger starts it (Play only; cheap; it finds the
   conversation-side blockers before any capture is spent).
3. **6.4.\*.1, the placed chains**, mission by mission in the campaign's order (Training and mission 1 first: Stage 5's captures and scenes cover much of their
   maps), each with its Wine capture from the same start. Missions 0 and 1 pass ([the harness and what it found](stage-6-chains.md)); the next mission needs its chain file and its capture.
4. **6.4.\*.2, the lasting choices**: the pairs of the carried table, the second branch captured where no slot holds it.
5. **6.2.2** (save in Play, load in Play), **6.1.6** (each menu entry against the original; what Exit does), **6.5** (the endings from their triggers).
6. **6.6.1, the unbroken run**, chaining the 6.4.\*.1 steps from New Game, then the gate.

## Excluded

Multiplayer (the `DXMP_*` maps, the Multiplayer menu, server travel), missions 7 and 13 (the installed game has none), Firefox, Safari and a headed browser's
folder picker (Stage 7). The anomalies of the shipped data (the inventory's "Anomalies in the shipped data": flags read but never set, InfoLinks without a
starter) are not rows: Play must do what the original does with them, which the chain and census rows check where they are reached.
