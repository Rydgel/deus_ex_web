# Stage 5 exit criteria: a finite definition of "Done when"

Status: **draft for the user to adopt** (written 2026-10-17 from master 5d7285c; first census and scoreboard below: 0 of 50 criteria pass). Nothing here is a Stage 5 claim; it is the definition the claims will be
judged against. The data is `scripts/stage5-criteria.mjs`; the measure of where Play stands is `scripts/census-stage5.mjs`; the acceptance test is
`scripts/validate-stage5-acceptance.mjs` ([Running](#running)). Like the Stage 3 and Stage 4 gates ([Stage 3](stage-3-exit-criteria.md),
[Stage 4](stage-4-exit-criteria.md)) it exits 1 until every criterion passes. What the original offers a player in these maps is in
[the Stage 5 inventory](stage-5-inventory.md).

The roadmap's criterion for section 5 ([roadmap](roadmap.md#5-implement-the-full-gameplay-systems)): *training and Liberty Island support representative combat,
stealth, exploration, conversation, and alternate-route objectives, with the systems interacting correctly; a single successful route does not cover a mission.*
Section 5 listed systems but no scenes, so "representative" and "interacting correctly" have meant whatever the last agent drove. This note fixes both: a list of
scenarios per clause on Training and Liberty Island, the criterion of each, the evidence that would prove it against the original, or the word `MISSING`. Where the
choice is mine and the reason is weak, the row says so; the user adopts or changes the list.

## What a scenario is, and what passes it

A scenario is something a player does with the original's own controls, on a map, whose effect the original defines: *a pistol shot kills a Terrorist and leaves a
carcass*, *a visible player in a patrol's view is noticed*, *the key from Filben opens the front doors*. A row passes when all three hold:

1. **It runs.** The census drives the scenario in Play through the player's own inputs (`game.use`, `ActivateBelt`, `inputButton`, the installed bindings, console
   commands the original supports), with the original bytecode and no host stand-in, and the effect the original defines is observed. Class P. A scenario that stops
   Play at an unimplemented native or boundary is `pause`; one that runs but whose effect never happens is `no-effect`.
2. **It is the original's result.** A check names the original's output for the same inputs: O1 (a live trace of the original's own run, replayed in Play: the
   Stage 4 tracer, `live-acceptance.mjs --cmds`) or O3 (the original DLL's code on the inputs Play produced in that scene). O2 (a native against the DLL on fabricated
   inputs) is part of the evidence for the bodies a scenario uses, never the whole. Without such a check the row is `MISSING`, whatever the census says.
3. **The systems it touches pass their own rows.** A scenario that uses a body no other row covers does not hide it: the row names it in the "Existing" column and
   the clause 5.6 rows check combinations.

**What the original-side harness can and cannot do** (from the [perception pilot](visual-acceptance.md#perception-pilot-2026-10-13) and
[weapon noise](visual-acceptance.md#weapon-noise-2026-10-14)): it types console lines and key edges (`@down Enter`, `@up Enter`) after N ticks with the level held,
places and aims the player by console `set`, summons items and pawns, and compares every watched field of every actor per tick with Play's replay of the same ticks.
It **cannot hold a key** (WinDrv releases posted keys at once), so walking, footsteps and automatic fire have no O1; their rows say O3 or place the approach.
A typed `Fire` does nothing (the binding does), so firing is a key edge. NPC-versus-player combat has never been captured. Every capture is new work: the stored
originals ([Stage 4](stage-4-exit-criteria.md#stored-originals)) hold the Island pilots (88 actors, 600 ticks, a ghost player), MeetPaul, the Underworld's perception and
weapon-noise traces (46 NPCs, a pistol and an assault shotgun), Training's first-person crowbar and its frames. Those are the O1 the first scoreboard can use.

## Scenarios chosen, and why

| Map | Why it is in |
| --- | --- |
| `00_Training` | Strong: the first mission and the only map every interface probe, the Stage 3 route and the first-person weapon comparison reach; its DataLinks are the original's own lesson list. |
| `00_TrainingCombat`, `00_TrainingFinal` | Medium: the roadmap says "training"; the lessons for weapons, explosives, bots, stealth, alarms and the holo conversations are in these two maps, not in `00_Training`. Weak: I added them to "Training"; if only `00_Training` counts, rows 5.1.2 to 5.1.4, 5.2.1, 5.3.13 (half), 5.4.2, 5.4.8 and 5.6.2 leave the list. |
| `01_NYC_UNATCOIsland` | Strong: the roadmap names Liberty Island; it has every system (combat with 29 Terrorists and bots, cameras, turrets, lasers, alarms, hacking, water, conversations with choices and flags, `Mission01`'s logic) and several ways to the objective, which the DataLinks themselves list. |

Not scenes, by decision: the other 80 maps (the Stage 3 census runs their startup), the HQ and later missions, hostages and shops (Island has none: the transfers are Paul's weapon,
Filben's key and Gunther's exchange), and the full 60-minute playthrough. **Alternate-route objectives** (clause 5.5) are the routes the DataLinks and `Mission01` define: the
front doors with Filben's key, the back entrance, the airshafts around the laser trap, the water to the ruins, and the two ways to end the commander (kill him, or let him surrender),
each reaching `StatueMissionComplete`. Walking from the dock to each is not driven; the approach is a fixture placement (`place`), as in the alterations census and the Stage 3
probes, and the row says "placed" where it is. **Weak:** a placed approach skips the long walk's AI and noise; one end-to-end run per route is the stronger row and costs a capture each.

## How the gate judges

Statuses: `PASS` (the census runs it and every proof check passes); `FAIL` (a proof check ran and is off, or the census says `pause` or `no-effect`, with the boundary printed);
`MISSING` (the census runs it but no check compares it with the original: `need` says which); `UNDRIVEN` (the census cannot start the scenario yet: the reason is printed);
`EXCLUDED` (Stage 6, multiplayer or Stage 4: the reason is printed). Everything except `PASS` and `EXCLUDED` keeps the gate red. A `Stage 4 row` check reads the Stage 4 gate's
report (`--stage4-report`), so presentation proof is not repeated.

**Judgement chosen in the gate** (mine, to adopt or change):

| Choice | Value | Why | Strength |
| --- | --- | --- | --- |
| A scenario passes without O1 only if it is a native body | O3 or O2 on the scene's inputs | Movement, ladders, swimming and decoration physics are bodies of Engine.dll with 100% instruction-covered oracles; a live trace of the original adds nothing a held key cannot give | Weak: the player's path is not compared in a walking original |
| Census run length | the scenario plus 5 to 20 s of Level time after the effect | long enough for the timers (hack, pick, gas, pursuit) | Weak |
| Census fixture writes | placement (`place`), items by `summon` and the map's own pickups, `bCheatsEnabled`, flags only through conversation events or triggers | the alterations census's rules; no field the scenario is about is written | Strong |
| "plays" | no error from the tick, the sprite scan or the HUD, and the effect observed | a silent no-op must not read as a pass | Strong |
| Mission-level rows (5.5.5 to 5.5.7) | the flags and actor states Mission01.Timer defines | Mission01.uc is the specification | Strong for the script; the timer's one-second cadence is Play's scheduler |

## The scenarios

<!-- criteria:start -->
### 5.1 Combat

| Id | Scene | Scenario | Ev. | Census | Proof that would pass it | Existing, partial | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5.1.1 | 00_Training crates | the crowbar breaks a Cratepick crate: swing, damage, fragments, contents, the Mission00 timer starts DL_Lockpick | O1 | `crowbar-crate` | O1: live trace of the original (crowbar summoned, ParseRightClick, ActivateBelt, a Fire edge at the crate) with the crate, fragment and contents state per tick | validate-crowbar-crate (P); validate-weapon-view-original (4.1.10 O1: the swing's draws); script-crate-destruction.md | MISSING |
| 5.1.2 | 00_TrainingCombat pistol range | take a pistol and Ammo10mm, shoot the range targets: ammo, recoil, trace hit, target and trigger state, DL_TArgetRangeshot1/2 | O1 | `pistol-range` | O1: live trace of the original firing at the range (edge-triggered Fire) with ammo, hit actor, mover and DataLink-flag state per tick | weapon noise O1 in the Underworld (pistol shots' event traffic, not the hit or the ammo) | FAIL |
| 5.1.3 | 00_TrainingCombat rifle range | take the rifle and Ammo3006, scope on, shoot: scope FOV, accuracy, hit; DL_RifleRangeShot1 sets SkillWeaponRifle to 3 | O1 | `rifle-scope` | O1: live trace of the original (scope toggle and Fire edges) with the scope state, FOV, ammo and the skill level | - | MISSING |
| 5.1.4 | 00_TrainingCombat demolitions | throw a LAM at BreakableWall1: it sticks, explodes (HurtRadius), the wall breaks, the Mission00 DataLinks follow | O1 | `lam-wall` | O1: live trace of the original (LAM selected, Fire edge) with the LAM actor, the explosion's damage to the wall and its fragments | alterations census (grenade throws play, P); validate-island-blowitup (mover BlowItUp O2) | FAIL |
| 5.1.5 | 01_NYC_UNATCOIsland | the player's pistol hurts and kills a standing Terrorist: damage, hit reaction, hostile response, death, carcass and its inventory | O1 | `island-shoot-npc` | O1: live trace of the original (pistol summoned and drawn, Fire edges at a Terrorist in view) with the pawn's Health, state, Orders, Enemy and the carcass | weapon noise O1 (the NPCs' event handlers for a player's shots in the Underworld); carcass memory natives 2108/2109 (O2) | FAIL |
| 5.1.6 | 01_NYC_UNATCOIsland | a hostile Terrorist attacks the player: it aims and fires (Tracer, physProjectile), the player's Health, armor and hit regions change, the AI keeps attacking or takes cover | O1 | `island-npc-shoots-player` | O1: live trace of the original with a visible, hostile-allied player in an NPC's view and the NPC's state, fire, projectile and the player's damage per tick | validate-island-tracer (tracer flight, P); validate-native-projectile (O2) | MISSING |
| 5.1.7 | 01_NYC_UNATCOIsland | a baton or crowbar knocks a Terrorist out: KnockedOut carcass, "Unconscious", and Mission01.Timer's aggression count | O1 | `island-melee-ko` | O1: live trace of the original (WeaponBaton drawn, Fire edge at a Terrorist) with the pawn's state, the carcass and its itemName | - | MISSING |
| 5.1.8 | 01_NYC_UNATCOIsland | player death: lethal damage reaches Dying, the death state and view; the game does not continue the level | O1 | `island-death` | O1: live trace of the original from lethal damage (TakeDamage via console) to the death state; Play stops at the same point of the original (the screen after it is Stage 6's load menu) | - | MISSING |
| 5.1.9 | 01_NYC_UNATCOIsland AutoTurret | NSFTurret01 fires at the player when its cameras trigger libertyturret1; the player can shoot it down | O1 | `island-turret` | O1: live trace of the original with the turret active (bActive via trigger) and the player in its range | validate-island-tracer | MISSING |

### 5.2 Stealth

| Id | Scene | Scenario | Ev. | Census | Proof that would pass it | Existing, partial | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5.2.1 | 00_TrainingFinal stealth maze | walk in and out of the soldiers' sight: patrols, AllianceTrigger hostile/neutral, AlarmUnit, DL_FailedStealth, the reset | O1 | `stealth-maze` | O1: live trace of the original with the player at fixed poses in a Soldier's patrol (no held keys needed) and the soldiers' states, alarm and trigger flags | - | MISSING |
| 5.2.2 | 01_NYC_UNATCOIsland | a visible player in the open: a patrolling Terrorist sees it (AICanSee, SightCounter, CycleCumulative), turns, calls the alert; a hidden player is not seen | O1 | `island-sight` | O1: live trace of the original (no ghost, player standing at a measured pose in a patrol's view and out of it) with the perception fields of the Perception pilot | perception pilot O1 in the Underworld (civilians flee a visible mj12-allied player); validate-pawn-perception / AICanSee x87 (O2) | FAIL |
| 5.2.3 | 01_NYC_UNATCOIsland | the player's noise reaches the guards: gunshots (WeaponFire, LoudNoise), the HandleShot/HandleLoudNoise callbacks; footsteps by speed and floor | O1 | `island-hearing` | O1: live trace on Island of the event traffic for a pistol and, with a walking player, for footsteps; footsteps need a held key the harness cannot post (O3 on Play's footstep inputs then) | live-events-compare O1: 1,069 and 1,586 manager calls equal in the Underworld (pistol, assault shotgun) | MISSING |
| 5.2.4 | 01_NYC_UNATCOIsland cameras | SecurityCamera sees the player: tracking, the alarm event, NSFCam01..03 trigger libertyturret1; UN_CamSystem01..04 (bNoAlarm) do not | O1 | `island-camera` | O1: live trace of the original with the player in a camera's cone and the camera's state, the alarm flag and the turret's state per tick | - | MISSING |
| 5.2.5 | 01_NYC_UNATCOIsland laser trap | a LaserTrigger beam broken by the player triggers AlarmUnit0 (SetAlarmFlag -> StatueAlarmTriggered) and the guards react | O1 | `island-laser` | O1: live trace of the original with the player placed across statue_lasertrap and the beam, trigger and flag state | - | FAIL |
| 5.2.6 | 01_NYC_UNATCOIsland laser trap | hacking ControlPanel0 with a multitool switches statue_lasertrap off: hack time (skill, hackStrength), the multitool's use, the lasers' state | O1 | `island-hack-panel` | O1: live trace of the original (Multitool selected, ParseRightClick on the panel) with the hack progress, multitool charge and laser state per tick | - | FAIL |
| 5.2.7 | 01_NYC_UNATCOIsland | a pawn reacts to a body: a killed or knocked-out Terrorist is seen (CheckCarcassPresence, HaveSeenCarcass, AddCarcass) and the finder investigates or flees | O1 | `island-carcass` | O1: live trace of the original with a carcass in a patrol's view | validate-pawn-carcass (natives 2108/2109, O2) | FAIL |

### 5.3 Exploration and the character systems

| Id | Scene | Scenario | Ev. | Census | Proof that would pass it | Existing, partial | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5.3.1 | 00_Training phase 1 | PlayerStart to DL_part2 by the player's own inputs: doors, NanoKey and key ring, crowbar and crates, lockpicking gundoor, datacube and keypad 0012, multitool hack of Keypad2, the cadet's body to the table, the dark room, the repair bot | O1 | `phase1-route` | O1 per step (live traces of the original at each interaction: door/mover state, lock strength and pick time, keypad result, hack time, body carry), or O3 where a step is a native body | Stage 3 gate route probe (P); validate-keypad, validate-training-nanokey, validate-training-cadet, validate-crowbar-crate (P); datacube and keypad frames O1 (4.4.13, 4.4.14) | MISSING |
| 5.3.2 | 00_Training dark room | F12 turns on AugLight: energy drain, the Beam, the lit room; the repair bot recharges | O3 | `dark-room-aug` | O3: Augmentation.Timer/energy and the Beam spawn on Play's inputs against the DLL; the light itself is validate-auglight-lighting | validate-auglight-lighting (O3 lighting); validate-player-augmentation-startup (P) | MISSING |
| 5.3.3 | 00_Training bots | the repair bot and the medical bot windows: recharge and heal amounts, cooldown, the window's buttons through the input path | O1 | `bots` | O1: live trace of the original at the bots (ParseRightClick, window clicks as key edges) with energy and health | - | MISSING |
| 5.3.4 | 00_Training obstacle course | jump across the platforms and crouch under the pipes: Jump, Duck, fall and landing, the player's path equal to the original's | O1 | `obstacle-jump` | O1: live trace of the original with Jump on a key edge from a measured pose (a held walking key is not capturable: the approach is placed, as the Underworld scenes do) | walking, falling, landing, stance oracles (O2); measure-training-physics | MISSING |
| 5.3.5 | 00_Training ladder | climb the ladder by view pitch and the arrow keys, and leave it at the top | O3 | `ladder` | O3: the ladder prelude and physFlying on the inputs Play produced in this scene, against Engine.dll | validate-native-ladder, validate-native-flying (O2); validate-training-ladder (P) | MISSING |
| 5.3.6 | 00_Training crate stack | pick up a metal crate, drop it, stack and climb: GrabDecoration, DropDecoration, Bump, physFalling and physRolling of the crate, the climb | O3 | `crate-stack` | O3: the decoration's falling and rolling and the player's stepping on Play's inputs | validate-plant-push, validate-decoration-settle-roll (O2) | MISSING |
| 5.3.7 | 00_Training swim | enter the contaminated water with and without the HazMat suit: WaterZone0 and DamageTrigger1 radiation, the suit's duration and armor, swimming and leaving by the ramp | O1 | `hazmat-swim` | O1: live trace of the original (HazMatSuit activated by ActivateBelt, the player placed in the water, Health and the suit's charge per tick) | validate-native-swimming 1093 cases (O2); alterations census hit-radiation, hit-drowned (P) | MISSING |
| 5.3.8 | 01_NYC_UNATCOIsland water | swim from the dock, dive to the ruins: breath (swimTimer, UnderWaterTime), drowning damage, surfacing | O1 | `island-swim` | O1: live trace of the original with the player placed under water until breath runs out | validate-native-swimming (O2); validate-island-swimming (the fish, P) | MISSING |
| 5.3.9 | 01_NYC_UNATCOIsland terminals | ComputerPersonal0 login with a user list, email; ATM0; ComputerSecurity camera views and door/turret choices | O1 | `island-terminal` | O1: frames of the original's login and screens plus the computer state after choices | security terminal screens O1 (4.4.13); Terminals in Play (P) | FAIL |
| 5.3.10 | 01_NYC_UNATCOIsland doors | keyed, locked, breakable and keypad doors: the satcomhatch with the UNhatchdoor NanoKey, commvan_door keypad 0451, breakable and lockpicked movers, StatueRuinDoors | O1 | `island-doors` | O1: live trace of the original at each door (key use, pick, damage) with mover and lock state per tick | validate-island-cell-door, validate-island-blowitup (mover bodies, O2); validate-native-mover-move, -interpolation, -scene (O2) | MISSING |
| 5.3.11 | 01_NYC_UNATCOIsland inventory | pick up and use items (MedKit, food, ammo, mods, Lockpick, Multitool), skill points (SkillAwardTrigger) and the skills screen, the AugmentationCannister and installing an augmentation, goals and notes | O1 | `island-items` | O1: live trace of the original (ParseRightClick pickups, ActivateBelt, console) with inventory, health, skill and goal state | alterations census: 19 scenarios play (P); persona screens O1 (4.4.11, 4.4.12) | MISSING |
| 5.3.12 | 01_NYC_UNATCOIsland | move objects and fall: carry or push barrels and crates, throw them (kinetic damage), fall damage from a height | O1 | `island-movables-fall` | O1: live trace of the original with a thrown or pushed decoration and a measured fall | validate-plant-push (O2); landing/falling oracles (O2) | MISSING |
| 5.3.13 | 00_TrainingFinal and 01_NYC_UNATCOIsland movers | a switch-driven mover: 00_TrainingFinal Switch1 opens FirstStealthDoor. Not driven: ElevatorMover1 (ExitDoor) is moved by SequenceTriggers no player input reaches, Island's Switch1 -> UN_maindoor (opened by Mission01) and the fork lift (DeusExMover11, a button in the ruins) | O1 | `elevator` | O1: live trace of the original with the player on the mover | validate-native-mover-move, -interpolation, -scene (O2); validate-island-cell-door | MISSING |

### 5.4 Conversation

| Id | Scene | Scenario | Ev. | Census | Proof that would pass it | Existing, partial | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5.4.1 | 00_Training | the 18 DataLinks of the course start at their triggers, queue behind a playing one, end and set DL_*_Played; DL_Lockpick starts from the Mission00 timer | O1 | `training-datalinks` | O1: the original's InfoLink window frames and the Played flags per tick (the window is not yet compared) | validate-training-datalinks, validate-training-datalink-live (P); script-datalink-original.md | MISSING |
| 5.4.2 | 00_TrainingCombat | the instructor takes the inventory: MunitionsTrooperTake/Frob (29 TransferObject events), MunitionsTrooperReady, Mission00.RemoveAllInventory | O1 | `instructor-take` | O1: live trace of the original through the conversation with the inventory per tick | validate-instructor-conversation (P) | MISSING |
| 5.4.3 | 01_NYC_UNATCOIsland | MeetPaul: the three weapon choices (Minicrossbow, GEP gun, rifle) hand JC the weapon, the map image and three goals | O1 | `meet-paul` | O1: the conversation frames to the choice (4.5.5) plus the transferred object and goals per branch | 4.5.5 O1 frames; validate-island-conversation: each choice plays to the end (P) | MISSING |
| 5.4.4 | 01_NYC_UNATCOIsland | MeetFilben (code phrase): the Choice decides FilbenGaveKey and the NanoKey; MeetFilben2 and AfterStatue follow the flags; skill points | O1 | `meet-filben` | O1: live trace of the original through each branch with the flags, inventory and skill points | - | MISSING |
| 5.4.5 | 01_NYC_UNATCOIsland | GuntherRescued: free Gunther, five choices, the player gives him a weapon (CheckObject/TransferObject), GuntherRespectsPlayer, AddSkillPoints, the cell door | O1 | `gunther-rescued` | O1: live trace of the original through the branches with flags, inventory and Gunther's orders | - | UNDRIVEN |
| 5.4.6 | 01_NYC_UNATCOIsland | MeetTerrorist with the commander: the Aggressive and Curious branches set PlayerAttackedStatueTerrorist and StatueMissionComplete; TerroristFollowup | O1 | `meet-terrorist` | O1: live trace of the original through both branches with the flags and the commander's orders | - | MISSING |
| 5.4.7 | 01_NYC_UNATCOIsland | overheard conversations and barks: TerroristsOverheard (Amos), TopTerroristsOverheard, the NPC barks in alert states | O1 | `overheard-barks` | O1: live trace of the original with the player in range (the bark choice and the speech started) | validate-island-bark (P); validate-island-lipsync (O3) | MISSING |
| 5.4.8 | 00_TrainingFinal | M00MeetPage and holo-Jaime: ConversationTrigger, JaimeAppears/JaimeBark_Played, EnterWorld/LeaveWorld by the Mission00 timer | O1 | `meet-page-final` | O1: live trace of the original with the flags and the holo pawns' bInWorld | - | FAIL |

### 5.5 Alternate-route objectives

| Id | Scene | Scenario | Ev. | Census | Proof that would pass it | Existing, partial | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5.5.1 | 01_NYC_UNATCOIsland front entrance | with the key from Filben the front doors (StatueRuinDoors) open; without it they stay locked, the player can pick (ls 0.1) or break them | O1 | `route-front` | O1: live trace of the original at the doors with and without the key, with the lockpick and with damage | - | FAIL |
| 5.5.2 | 01_NYC_UNATCOIsland back entrance | the back way in (DL_BackEntrance, DeusExMover2): lockpick, multitool or break it; the guards at the lower deck | O1 | `route-back` | O1: live trace of the original at DeusExMover2 and the patrol | - | FAIL |
| 5.5.3 | 01_NYC_UNATCOIsland airshafts | the airshaft route around the laser trap to Gunther's cell (DL_libertyruinsairshaft x3): crouch through the shafts, the NPCs and alarms bypassed | O1 | `route-airshaft` | O1: the same state comparisons with the player placed in the shaft | - | MISSING |
| 5.5.4 | 01_NYC_UNATCOIsland water route | the east side by water: swim to the ruins, the electric arcs (ElectricityEmitter x3, LibElectric, EMP damage drains energy), ControlPanel1 and the fork lift | O1 | `route-water` | O1: live trace of the original from the water to the arcs, the panel and the lift | - | MISSING |
| 5.5.5 | 01_NYC_UNATCOIsland | kill the commander: TerroristCommander_Dead -> DL_LeaderKilled (InSpite after NotKilled) -> StatueMissionComplete | O1 | `objective-kill` | O1: live trace of the original from the commander's death through Mission01.Timer | - | FAIL |
| 5.5.6 | 01_NYC_UNATCOIsland | spare the commander: MeetTerrorist (Curious) -> StatueMissionComplete; DL_LeaderNotKilled | O1 | `objective-spare` | O1: live trace of the original through the conversation and the timer | - | MISSING |
| 5.5.7 | 01_NYC_UNATCOIsland | StatueMissionComplete changes the world (Mission01.Timer): UN_maindoor opens, doors unlock, custody and post-mission troops enter, Terrorists die, Paul teleports, turrets and lasers go, cameras silenced | O1 | `mission-complete` | O1: live trace of the original after the flag with every changed actor per tick | - | MISSING |

### 5.6 Systems interacting

| Id | Scene | Scenario | Ev. | Census | Proof that would pass it | Existing, partial | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5.6.1 | 01_NYC_UNATCOIsland | a shot near guards: noise, hostility, pursuit, distress to other pawns, the player hurt and healed with a MedKit | O1 | `noise-wakes-guards` | O1: live trace of the original of the whole encounter | 5.1.5, 5.1.6, 5.2.3 each partial | MISSING |
| 5.6.2 | 00_TrainingFinal alarm | an AlarmUnit trips: AlarmDispatcher, soldiers go hostile, the doors | O1 | `alarm-chain` | O1: live trace of the original from the alarm's trigger | - | FAIL |
| 5.6.3 | 01_NYC_UNATCOIsland | light against sight: the same pose seen or not seen as the player lights or darkens it (AugLight, a light switch, the NPC's lighting of the player) | O1 | `light-vs-sight` | O1: live trace of the original with perception fields at two light states | validate-pawn-perception, AICanSee (O2); lighting oracles (O2) | UNDRIVEN |
| 5.6.4 | 01_NYC_UNATCOIsland | an explosion: a barrel or CrateExplosiveSmall near a Terrorist, a breakable door and a decoration: HurtRadius, damage to each, noise, chain explosions | O1 | `explosion-world` | O1: live trace of the original with the barrel shot | validate-island-blowitup (O2); VisibleCollidingActors iterator 312 (O2) | MISSING |
| 5.6.5 | 01_NYC_UNATCOIsland | EMP: an EMP grenade or the EMP field against a SecurityBot, the turret and the camera (disabled) and the player's energy | O1 | `emp-electronics` | O1: live trace of the original with an EMP grenade thrown at the bot | alterations census emp-grenade, hit-emp (P) | FAIL |
| 5.6.6 | 01_NYC_UNATCOIsland | conversation flags change pawns: GuntherFreed -> AllianceTrigger and orders, FilbenGaveKey, M01PlayerAggressive, KnowsShipment | O1 | `flags-change-world` | O1: live trace of the original after each flag with the affected pawns' alliance and orders | - | UNDRIVEN |

### 5.7 Excluded

| Id | Scene | Scenario | Ev. | Census | Proof that would pass it | Existing, partial | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5.7.1 | every map | Save Game, Load Game, QuickSave and the load menu after death | - | - | Stage 6 (roadmap section 6): native 3011/3013; Stage 3 gate tolerates 3011 | - | EXCLUDED |
| 5.7.2 | Teleporter, MapExit, ClientTravel | Training map to map, Island to Battery Park, the HQ teleporter, the boat cinematic's end | - | - | Stage 6: map travel and PlayerTraveling (a measured host input) | - | EXCLUDED |
| 5.7.3 | flags across maps | flag expiration by mission number and persistence (M01PlayerAggressive until mission 6, DL_*_Played) | - | - | Stage 6: persistence | - | EXCLUDED |
| 5.7.4 | DXMP maps | multiplayer: replication, GameInfo MP, bots, the DXMP maps | - | - | Multiplayer is the last priority and may stay unsupported (AGENTS.md) | - | EXCLUDED |
| 5.7.5 | rendering of the above | how a scenario looks (weapon models, effects, windows) | - | - | Stage 4: the Stage 4 gate owns presentation | - | EXCLUDED |

<!-- criteria:end -->

## Census: where Play stands (2026-10-17, master 5d7285c plus this branch)

`node scripts/census-stage5.mjs` drives the 50 scenarios in Play's own frame (headless: `createGame`, `sim-session` tick, sprite scan and HUD, the player-input fixture), one session per
map with the original Player start between scenarios, a child per map under an RSS watchdog. Headless is the established census practice (alterations census, Stage 3 probes); the
default worker page runs the same simulation code. **Full runs on the Linux host: 36 plays, 1 pause, 10 no-effect, 3 undriven (1,353 s, peak 4,390 MiB; a second run with the expectations stored passed in 1,448 s, peak 3,313 MiB, every outcome equal). On review three predicates were tightened to the effect their rows name (`pistol-range`: a range target registers; `island-shoot-npc`: the Terrorist is killed; `island-laser`: `StatueAlarmTriggered` is set) and those three rerun as no-effect: 33 plays, 1 pause, 13 no-effect, 3 undriven.** The expected outcomes are stored in
the script (`EXPECTED`), so a regrown boundary fails the run and a fixed one must be recorded. The census is class P: it says what Play does, never that it equals the original.

How the scenarios are driven (and what that means for reading the table):

* **Items** come from `summon` (the console cheat the original supports, as the alterations census does) and the map's own pickups; **the player is placed** at the approach (fixture write),
  checked to stand on dry ground in the world: a placement outside it makes physFalling dispatch `FellOutOfWorld` and the player dies (`OPEN DXONLY` is the first thing a death reaches, below).
* **Stasis devices need the renderer's feedback.** A headless frame draws no meshes, so a keypad, panel or door never gets a fresh `LastRenderTime` and its Timer never runs; the driver stamps the
  device the player works on, as the Stage 3 route does ([route](script-training-route.md)). A state machine such as a `Computers` terminal also needs the seconds a player spends walking up to it
  (its level-start animation, `Frob` refuses while `bAnimating`), so the driver stamps it for 3 s before the frob.
* **Tools are used with the left button.** `c.useTool` (a Lockpick or NanoKeyRing on a mover, a Multitool on a hackable device) is `ParseLeftClick`; `c.frob` is the right button (`ParseRightClick`,
  `DoFrob(Self, None)`: pickups, doors that are unlocked, terminals). `useTool` aims until the view trace selects the target, lets the player land (the placement is a few units off the floor) and
  requires the selection to hold for 12 frames standing still before it presses: the pick and hack Timers stop, and spend the tool, as soon as `frobTarget != Self`. `c.restart()` is the original
  Player start inside a scenario (`route-front` and `meet-filben` run two branches).
* **Delegated scenarios** run an existing Play validator unchanged (`validate-crowbar-crate`, `-training-ladder`, `-instructor-conversation`, `-island-conversation`, `-island-bark`) and
  `phase1-route` runs the Stage 3 route probe: they play because those validators pass.
* **Weak spots of the drivers** (so a `plays` is not read as more than it is): `island-hearing` cannot separate sight from hearing in the open; `island-sight` and the combat scenarios use one
  Terrorist (`Terrorist0`, standing in the east) as the subject; `island-doors` takes the keypad door only (the NanoKey lies where no approach reaches); `route-airshaft` and `route-water` place the
  player at the trigger or hazard and walk a few steps; the `AlarmUnit` and the `AutoTurret` are tripped with a `Trigger` call as the camera or laser would, because nothing in the map triggers
  them for a player; `training-datalinks` leaves out `dl_bodyexit` (no collision: the body doors open it, which the route covers).

| Scenario | Rows | Map | Outcome | First pause, or what was observed |
| --- | --- | --- | --- | --- |
| `crowbar-crate` | 5.1.1 | 00_Training | plays | {delegate:validate-crowbar-crate.mjs,peakMiB:1162,last:crowbar crate: ticked hits, fragments/bounce/fade/expiry, Lockpick landing/pickup/equip, queued |
| `phase1-route` | 5.3.1 | 00_Training | plays | {route:PlayerStart -> DL_part2,ms:0} |
| `dark-room-aug` | 5.3.2 | 00_Training | plays | {active:true,energy0:100,energy:99.50003051757812,beams:2} |
| `bots` | 5.3.3 | 00_Training | plays | {RepairBot:true,MedicalBot:true} |
| `obstacle-jump` | 5.3.4 | 00_Training | plays | {z0:16.735414505004883,zMax:64.16401672363281,end:[6991,-82,17],physics:1} |
| `ladder` | 5.3.5 | 00_Training | plays | {delegate:validate-training-ladder.mjs,peakMiB:1443,last:{\floor\:-144,\top\:[6986,-3571,16],\hang\:-60,\descentZ\:-17.054441452026367,\scope\:\Traini |
| `crate-stack` | 5.3.6 | 00_Training | plays | {crate:CrateUnbreakableSmall0,carried:true,dropped:true,at:[7262,-1493,-14]} |
| `hazmat-swim` | 5.3.7 | 00_Training | plays | {bare:10,suited:8,swimming:true,active:true} |
| `training-datalinks` | 5.4.1 | 00_Training | plays | {triggers:18,played:17,died:false,missing:[]} |
| `pistol-range` | 5.1.2 | 00_TrainingCombat | no-effect | ammo spent (6 to 0) but no target registers: glass whole, DL_TArgetRangeshot1 not played |
| `rifle-scope` | 5.1.3 | 00_TrainingCombat | plays | {scoped:true,ammo:4,fov:10,skill:SkillWeaponRifle} |
| `lam-wall` | 5.1.4 | 00_TrainingCombat | no-effect | the effect did not happen |
| `instructor-take` | 5.4.2 | 00_TrainingCombat | plays | {delegate:validate-instructor-conversation.mjs,peakMiB:1886,last:Instructor Play flow passed: both owners, Frob/Take, natural FlagTrigger, 29 transfer |
| `stealth-maze` | 5.2.1 | 00_TrainingFinal | plays | {state:deusex.scriptedpawn.patrolling,enemy:null,failed:true} |
| `elevator` | 5.3.13 | 00_TrainingFinal | plays | {before:0,after:1,moving:false,note:ElevatorMover1 (ExitDoor) is moved by mission triggers only: not driven} |
| `alarm-chain` | 5.6.2 | 00_TrainingFinal | no-effect | AlarmUnit1.Trigger left bActive false |
| `meet-page-final` | 5.4.8 | 00_TrainingFinal | no-effect | the effect did not happen |
| `island-shoot-npc` | 5.1.5 | 01_NYC_UNATCOIsland | no-effect | 20 shots took Terrorist0 from 75 to 17 health, not killed; still standing, no Enemy |
| `island-npc-shoots-player` | 5.1.6 | 01_NYC_UNATCOIsland | plays | {enemy:true,tracers:1,minHealth:0,states:[standing,attacking],physics:1,died:false,h:0} |
| `island-melee-ko` | 5.1.7 | 01_NYC_UNATCOIsland | plays | {gone:true,fresh:[{name:TerroristCarcass1,itemName:Unconscious}],playerDied:false} |
| `island-death` | 5.1.8 | 01_NYC_UNATCOIsland | plays | {health:-500,state:deusex.deusexplayer.dying,reachedOpenDxOnly:false} |
| `island-turret` | 5.1.9 | 01_NYC_UNATCOIsland | plays | {tried:[[0,null,false],[1.57,JCDentonMale4,true]],h:[100,95],died:false} |
| `island-sight` | 5.2.2 | 01_NYC_UNATCOIsland | no-effect | the effect did not happen |
| `island-hearing` | 5.2.3 | 01_NYC_UNATCOIsland | plays | {before:standing,quietBeforeShots:true,state:dying,enemy:true,playerDied:false,note:sight and hearing cannot be told apart in the open} |
| `island-camera` | 5.2.4 | 01_NYC_UNATCOIsland | plays | {seen:[[200,true,true],[350,true,true],[500,true,true]],alarm:true,state:active} |
| `island-laser` | 5.2.5 | 01_NYC_UNATCOIsland | no-effect | the beam fires (lastAlarmTime 0.57) but StatueAlarmTriggered is never set: the chain stops at AlarmUnit0, as in `alarm-chain` |
| `island-hack-panel` | 5.2.6 | 01_NYC_UNATCOIsland | plays | {started:true,frames:239,hackStrength:0,lasersOn:[[true,true,true,true,true],[false,false,false,false,false]],multitool:[1,0],playerDied:false} |
| `island-carcass` | 5.2.7 | 01_NYC_UNATCOIsland | pause | CriticalDelete deleting destructor is not recovered for native vtable 0x10027fe8 |
| `island-swim` | 5.3.8 | 01_NYC_UNATCOIsland | plays | {physics:3,swimTimer:[19.533340454101562,5.533483505249023],health:[100,100],drowned:false} |
| `island-terminal` | 5.3.9 | 01_NYC_UNATCOIsland | plays | {ComputerPersonal0:true,ComputerPersonal0.window:networkterminalpersonal,ATM0:true,ComputerSecurity1:true,ComputerSecurity1.window:networkterminalsecu |
| `island-doors` | 5.3.10 | 01_NYC_UNATCOIsland | plays | {keyTaken:false,keypadDoor:true} |
| `island-items` | 5.3.11 | 01_NYC_UNATCOIsland | plays | {hurt:80,healed:87,points:[5000,5025]} |
| `island-movables-fall` | 5.3.12 | 01_NYC_UNATCOIsland | plays | {carried:true,item:Trashbag0,fall:8,h0:100,h:92} |
| `meet-paul` | 5.4.3 | 01_NYC_UNATCOIsland | plays | {delegate:validate-island-conversation.mjs,peakMiB:55,last:{\ok\:true,\start\:1420,\choice\:4268,\camera\:\ConCamera0\,\letterboxFrames\:2849,\paulSpe |
| `meet-filben` | 5.4.4 | 01_NYC_UNATCOIsland | plays | {trust:{met:true,ended:true,gaveKey:true,keys:[ruin_key],seconds:5.5},refuse:{met:true,ended:true,gaveKey:false,keys:[],seconds:7}} |
| `gunther-rescued` | 5.4.5 | 01_NYC_UNATCOIsland | undriven | the cell door DeusExMover10 is reached by no frob approach tried (8 bearings, 3 distances, 2 heights around its Location); the walk to it is not driven |
| `meet-terrorist` | 5.4.6 | 01_NYC_UNATCOIsland | plays | {played:false,complete:true,attacked:true,commander:conversation,at:[2887,38,2528]} |
| `overheard-barks` | 5.4.7 | 01_NYC_UNATCOIsland | plays | {delegate:validate-island-bark.mjs,peakMiB:1294,last:island-bark: Terrorist30's bark deusexconaudioaibarks.conaudioaibarks_896 on Galaxy channel 57306 |
| `route-front` | 5.5.1 | 01_NYC_UNATCOIsland | plays | {authored:{breakable:[false,false,false,false],lockStrength:0.10000000149011612},bareRightClick:[locked,locked,locked,locked],picking:true,pickFrames: |
| `route-back` | 5.5.2 | 01_NYC_UNATCOIsland | plays | {lockStrength:0.10000000149011612,bareRightClick:{locked:true,open:false},picking:true,pickFrames:245,unlocked:true,open:true,died:false,picks:0} |
| `route-airshaft` | 5.5.3 | 01_NYC_UNATCOIsland | plays | {played:true} |
| `route-water` | 5.5.4 | 01_NYC_UNATCOIsland | plays | {energy:[100,98],health:[100,95],died:false} |
| `objective-kill` | 5.5.5 | 01_NYC_UNATCOIsland | no-effect | the effect did not happen |
| `objective-spare` | 5.5.6 | 01_NYC_UNATCOIsland | plays | {complete:true,notKilledPlayed:false} |
| `mission-complete` | 5.5.7 | 01_NYC_UNATCOIsland | plays | {complete:true,thugsLeft:0,unMainDoorLocked:[false,false],paul:[-4681,2640,-94]} |
| `noise-wakes-guards` | 5.6.1 | 01_NYC_UNATCOIsland | plays | {out:{enemy:true,tracers:2,minHealth:0,states:[attacking,standing],physics:1},died:false,h:0} |
| `light-vs-sight` | 5.6.3 | 01_NYC_UNATCOIsland | undriven | needs a measured lit/dark pair of poses in an NPC's view and the NPC's perception fields; no such pose is read from the map yet |
| `explosion-world` | 5.6.4 | 01_NYC_UNATCOIsland | plays | {gone:true,playerHealth:[100,83],died:false} |
| `emp-electronics` | 5.6.5 | 01_NYC_UNATCOIsland | no-effect | the effect did not happen |
| `flags-change-world` | 5.6.6 | 01_NYC_UNATCOIsland | undriven | needs GuntherFreed (see gunther-rescued) and the Filben and commander flows; only the conversation flows of meet-filben and meet-terrorist are driven |

**What the census found in Play** (each is a lead for an agent, not yet a diagnosis):

1. **A pawn's death does not finish** (`island-carcass`, the only `pause`): killing `Terrorist4` reaches `CriticalDelete` (native 751) on a `ConHistory` object (DeusEx vtable `0x10027fe8`), whose deleting
   destructor `script-runtime.mjs` does not recover (the LoadMap collection does recover it: `DConHistory::Destroy` `0x1000ca20`, [LoadMap GC](script-loadmap-gc.md)). Every kill the player makes to the end
   (5.1.5, 5.2.7, 5.5.5, the aggression count of `Mission01`) passes through it.
2. **The player's death ends at `OPEN DXONLY`** (`UGameEngine::Exec OPEN is not implemented`): `island-death` reaches the Dying state and a killed player (`route-front`: shot by the guards at the statue doors)
   stops there. That is the reload after death, Stage 6's neighbour; the question is where Play should stop.
3. **Lockpicking and hacking on Island devices never completed: the driver gave the wrong input, not Play** (`island-hack-panel`, `route-back`, `route-front`; fixed 2026-10-17).
   The driver used the right button (`game.use()` = `ParseRightClick`), which frobs the target with nothing in hand (`DoFrob(Self, None)`, `DeusExPlayer.uc` `ParseRightClick`): `HackableDevices.Frob`
   and `DeusExMover.Frob` start a hack or a pick only when handed the Multitool or Lockpick, and a Multitool or Lockpick reaches them from the LEFT button (`ParseLeftClick`:
   `DoFrob(Self, inHand)` for a Lockpick or NanoKeyRing on a `DeusExMover` and a Multitool on a `HackableDevices`; the Training route fires with `LeftMouse`). The old runs stood 30 to 40 s in front of
   the device with nothing started (and at the statue doors the guards shot the player meanwhile). With `c.useTool` (aim until the view trace selects the target, let the player land, hold the
   selection standing still, press the left button) the original bodies run: `ControlPanel0` hacks in 239 frames (`hackStrength` 0.1, `HackTime` 4, 10 hacks at skill value 0.1), its `UnTriggerEvent`
   switches all five `statue_lasertrap` lasers off and the Multitool is spent; `DeusExMover2` picks in 245 frames (`lockStrength` 0.1, `pickTime` 4), the Lockpick is spent, the right button opens
   it. A pick or hack aborted by looking away (`frobTarget != Self`, the Timer's own test) also spends the tool: that was the first symptom of an approach that did not hold the target.
   One real Play gap showed on the way: with the statue doors opening under fire, a `Tracer` (zero extent) inside a moving mover's bounds stopped Play at "Owned zero-extent PointCheck is not yet
   verified"; recovered from Engine.dll and compared with the original on 32,064 points ([point-check](point-check.md#owned-zero-extent-descent-2026-10-17)).
4. **A thrown LAM spawns nothing** (`lam-wall`): the weapon goes Active to Idle on Fire and no `LAM` projectile appears; the EMP grenade at `SecurityBot0` does spawn an `EMPGrenade` and changes nothing
   (`emp-electronics`). `AlarmUnit1.Trigger` leaves `bActive` false (`alarm-chain`); on Island the laser beam fires but `StatueAlarmTriggered` is never set (`island-laser`), the same unit. Six pistol shots at the 00_TrainingCombat range register on no target (`pistol-range`).
5. **Radiation costs the player once** (`hazmat-swim`): `WaterZone0` (`DamagePerSec` 20, Radiation, `bPainZone`) took 10 health on entry and no more over 20 s; with the HazMat suit active the entry took 8. A
   debug series (a second look at the same zone) shows `PainTime` counting the breath, not a pain interval.
6. **NPC reaction to being hurt is not stable** (`island-shoot-npc`): 20 pistol shots took `Terrorist0` from 75 to 17 and left it `Standing` with no Enemy in the final driver, while the first variant of the
   driver (a different stance) saw it flee with the player as Enemy. `island-sight` (700 units, open ground) saw no reaction in 10 s while at 350 units the Terrorist engages and the player is shot to 0
   (`island-npc-shoots-player`, with Tracers in flight). No original trace exists for any of this.
7. **Terminals** (`island-terminal`; fixed 2026-10-17, a driver limit): `ATM0` is a decoration and opens its window on the frob; `ComputerPersonal0` and `ComputerSecurity1` are `Computers` state machines
   (`Computers.uc`, `auto state Off`). `bOn` is true in the class defaults and the map, so the level start runs `Off.Begin`: `PlayAnim('Deactivate')`, `FinishAnim()`, `bOn=false`; `Frob` returns without opening while `bAnimating`, and
   `On.Begin` (Activate animation, `TryInvoke` -> `Invoke` -> `InvokeComputerScreen`) is skipped when `bOn` is already true. A computer nobody has drawn sits in stasis (`bStasis`, `LastRenderTime -10`), so
   its animation never ran in the headless census and the frob (made at once) found it animating. Stamped as the renderer's feedback would and given the 3 s a player spends walking up, `ComputerPersonal0`
   opens `NetworkTerminalPersonal` and `ComputerSecurity1` `NetworkTerminalSecurity` through the frob path, as `ATM0` does. This is the same state machine as in the original; the login, user list and screens
   are Stage 4's (4.4.13) and the Terminals-in-Play work, not driven here. A second Play gap showed with the player standing at the personal terminal beside `UNATCOTroop6` (26 units away, inside both cylinders): that pawn's own `SetLocation` call
   (its state code, from `Actor.Tick`) met the player and `CheckEncroachment` dispatched `Pawn.EncroachingOn`, a value-returning event the pawn-physics dispatch called without a result block
   ("Return-value ProcessEvent requires a caller result reference"); it now gets the block as `dispatchSpawnedEvent` gives it (why the call came some seconds after the window closed was not traced).
8. **`M00MeetPage` does not play** (`meet-page-final`) when the player walks into `ConversationTrigger1`; `MeetTerrorist` does (the Aggressive branch with the first choice: `StatueMissionComplete` and
   `PlayerAttackedStatueTerrorist` set, `MeetTerrorist_Played` not), and `mission-complete` then plays Mission01.Timer's world edit (Terrorists dead, `UN_maindoor` unlocked, Paul moved). Shooting the commander
   from his room (`objective-kill`) did not hurt him.

Unreached: `gunther-rescued` and `flags-change-world` (the cell door `DeusExMover10` is selected by no frob approach tried), `light-vs-sight` (no measured lit/dark pair of poses), and the `ElevatorMover1`
ride (no player input reaches its SequenceTriggers).


## Scoreboard (2026-10-17, first run)

`node scripts/validate-stage5-acceptance.mjs --census .work/stage5-census.json --report` on the census above: **0 of 50 criteria pass; the gate is red** (exit 1). 55 rows, 5 excluded (after the three tightened predicates).

| Clause | PASS | FAIL | MISSING | UNDRIVEN | EXCLUDED |
| --- | ---: | ---: | ---: | ---: | ---: |
| 5.1 Combat | 0 | 3 | 6 | 0 | 0 |
| 5.2 Stealth | 0 | 4 | 3 | 0 | 0 |
| 5.3 Exploration and the character systems | 0 | 1 | 12 | 0 | 0 |
| 5.4 Conversation | 0 | 1 | 6 | 1 | 0 |
| 5.5 Alternate-route objectives | 0 | 3 | 4 | 0 | 0 |
| 5.6 Systems interacting | 0 | 2 | 2 | 2 | 0 |
| 5.7 Excluded | 0 | 0 | 0 | 0 | 5 |
| **Total** | **0** | **14** | **33** | **3** | **5** |

No row has a proof check yet: the 33 `MISSING` rows play in the census and name the capture that would prove them; the 14 `FAIL` rows do not play (one pause, thirteen no-effect); the 3 `UNDRIVEN`
rows cannot be started. This is the honest first number: Stage 4's gate started at 44 of 70 because 60 checks against stored originals already existed, and for gameplay they do not. The strongest
existing evidence is listed per row under "Existing, partial" (the Underworld's weapon-noise traces for gunshots, the perception pilot, the first-person crowbar, MeetPaul's frames, the native oracles for
swimming, ladders, falling and movers).

## Remaining Stage 5 work, in the order it blocks

Nothing below was fixed in this task. Each item is sized for one agent; "unblocks" names the rows.

1. **Finish a pawn's death** (finding 1): `CriticalDelete` of a `ConHistory` (vtable `0x10027fe8`) in `script-runtime.mjs:943`; the body is recovered for the LoadMap collection. Small, and everything that kills
   a pawn waits on it. Unblocks 5.1.5, 5.2.7, 5.5.5 and every row that ends with a body.
2. **Decide and implement where a player's death stops** (finding 2): `OPEN DXONLY`, the Dying state's chain up to the reload. Needs the user's call (below). Unblocks the end of 5.1.6, 5.1.8, 5.5.1.
3. **Island devices that never finish** (findings 3, 4, 7): lockpick and hack outside Training and the personal and security terminals are done (2026-10-17: the driver gave the wrong input, plus the two Play gaps of
   findings 3 and 7); the LAM throw and the AlarmUnit trigger (finding 4) remain, one agent diagnosing each against the original body (`ThrownProjectile`, `AlarmUnit.Trigger`). Unblocks 5.1.4, 5.6.2 (5.2.6,
   5.3.9, 5.5.1 and 5.5.2 now play and wait for their O1 captures).
4. **NPC combat against the player, compared with the original** (finding 6): the first capture nobody has taken. `live-acceptance.mjs original --no-ghost` on Island with a visible player at 350 and 700 units
   from `Terrorist0`, the pistol drawn and fired by key edges, 600 ticks; replay in Play; fix the first divergence. The Stage 4 notes say a summoned MJ12Troop beside the player did not attack in Play and no
   original run exists. Unblocks 5.1.5, 5.1.6, 5.2.2, 5.2.3, 5.6.1 (and the O1 for 5.1.7, 5.1.8).
5. **Pain zones and the HazMat suit** (finding 5): the zone's `DamagePerSec` over time and the suit's absorption, against a capture of Training's pool. Unblocks 5.3.7, 5.6.x radiation.
6. **The undriven scenarios**: the cell door and Gunther (5.4.5, 5.6.6), a lit/dark pair of poses (5.6.3), the `M00MeetPage` trigger (5.4.8), the commander from his room (5.5.5), the `ElevatorMover1` ride
   (5.3.13). Each is a driver plus whatever pause it finds; the first two are the biggest.
7. **Proof captures, by clause value**: conversation branches (5.4.3 to 5.4.6: choices, transfers, flags; the harness types Enter and Down as key edges), weapons and damage (5.1.1 to 5.1.3, 5.1.7), the
   routes (5.5), Training's lessons one capture each (5.3.1 to 5.3.4), and O3 comparisons for the native-body rows (5.3.5, 5.3.6, 5.3.2). The 33 `MISSING` rows are this item; none can start before items 1 to 4
   say Play does the scenario.

## What the user should decide

* **The list itself**: 50 scenarios, Training meaning all three maps, Island with its five ways in, one row for the whole of Training's phase 1, placed approaches instead of walks. Weak choices are labelled `weak`
  in `scripts/stage5-criteria.mjs` and in the tables above.
* **O3 or O2 as enough for native-body rows** (ladder, crate physics, swimming, falling, movers): the doc defaults to O3 (the DLL's code on Play's inputs in the scene), which does not exist yet for any of them.
* **Cross-map evidence for shared code**: accept the Underworld's gunshot and perception traces for 5.2.3 or require an Island capture.
* **Where a player's death stops** (item 2) and whether the load menu belongs to Stage 5 or 6.
* **Priority**: item 4 is the largest unknown (nothing about NPC-versus-player combat has ever been compared); items 1 to 3 are small and mechanical.

## Excluded

Rows 5.7.1 to 5.7.5 above. They stay on the page so a reader sees them left out, with the stage that owns them.

## Running

```bash
# a new checkout under .claude/worktrees needs the setup of the worktree-validator-setup note: symlink node_modules, "Deus Ex GOTY Edition",
# Reference and the .cache entries (except .cache/wasm), and run `npm run build:wasm`.
node scripts/census-stage5.mjs [--only slug,slug] [--json out.json]       # drive the scenarios in Play; asserts the stored EXPECTED outcomes
node scripts/validate-stage5-acceptance.mjs                               # the gate: exit 1 until every criterion passes
node scripts/validate-stage5-acceptance.mjs --report [file]               # the scoreboard, exit 0
node scripts/validate-stage5-acceptance.mjs --markdown [file]             # the tables of this page from a report
```
