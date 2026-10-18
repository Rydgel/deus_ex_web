# Stage 5 exit criteria: a finite definition of "Done when"

Status: **draft for the user to adopt** (written 2026-10-17 from master 5d7285c; first census and scoreboard: 0 of 50 criteria pass; after the first original captures, the same evening: 2 of 50). Nothing here is a Stage 5 claim; it is the definition the claims will be
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
| 5.1.2 | 00_TrainingCombat pistol range | take a pistol and Ammo10mm, walk in (DL_TArgetRange opens the cover over Switch3), press Switch3 (the target DeusExMover4 with BreakableGlass0 slides in; its MoverCollider passes the DirectionalTriggers that open the blast door), shoot the glass through the station window: ammo, recoil, trace hit, target and trigger state, DL_TArgetRangeshot1/2 | O1 | `pistol-range` | O1: live trace of the original firing at the range (edge-triggered Fire) with ammo, hit actor, mover and DataLink-flag state per tick | weapon noise O1 in the Underworld (pistol shots' event traffic, not the hit or the ammo) | MISSING |
| 5.1.3 | 00_TrainingCombat rifle range | take the rifle and Ammo3006, scope on, shoot: scope FOV, accuracy, hit; DL_RifleRangeShot1 sets SkillWeaponRifle to 3 | O1 | `rifle-scope` | O1: live trace of the original (scope toggle and Fire edges) with the scope state, FOV, ammo and the skill level | - | MISSING |
| 5.1.4 | 00_TrainingCombat demolitions | place a LAM on BreakableWall1 (WeaponLAM.Fire's Place path near a Mover; a thrown LAM bounces off), shoot it (ThrownProjectile.TakeDamage): it explodes (HurtRadius), the wall breaks (BlowItUp), DL_FinishWall follows | O1 | `lam-wall` | O1: live trace of the original (LAM selected, Fire edge) with the LAM actor, the explosion's damage to the wall and its fragments | alterations census (grenade throws play, P); validate-island-blowitup (mover BlowItUp O2) | MISSING |
| 5.1.5 | 01_NYC_UNATCOIsland | the player's pistol hurts and kills a standing Terrorist: damage, hit reaction, hostile response, death, carcass and its inventory | O1 | `island-shoot-npc` | cmb5 equal: its carcass's first LastRenderTime is stamped a tick late in Play (the actor mesh layer admits a spawned mesh actor asynchronously, so the first frame after the spawn tick does not draw or stamp it; the original does) | validate-stage5-live cmb7 (O1: the second pistol shot kills Terrorist0 at 360; its carcass created at the original's tick); weapon noise O1 (the NPCs' event handlers for a player's shots in the Underworld); carcass memory natives 2108/2109 (O2) | FAIL |
| 5.1.6 | 01_NYC_UNATCOIsland | a hostile Terrorist attacks the player: it aims and fires (Tracer, physProjectile), the player's Health, armor and hit regions change, the AI keeps attacking or takes cover | O1 | `island-npc-shoots-player` | O1: live trace of the original with a visible, hostile-allied player in an NPC's view and the NPC's state, fire, projectile and the player's damage per tick | validate-island-tracer (tracer flight, P); validate-native-projectile (O2) | PASS |
| 5.1.7 | 01_NYC_UNATCOIsland | a baton or crowbar knocks a Terrorist out: KnockedOut carcass, "Unconscious", and Mission01.Timer's aggression count | O1 | `island-melee-ko` | O1: live trace of the original (WeaponBaton drawn, Fire edge at a Terrorist) with the pawn's state, the carcass and its itemName | - | MISSING |
| 5.1.8 | 01_NYC_UNATCOIsland | player death: lethal damage reaches Dying, the death state and view; the game does not continue the level | O1 | `island-death` | die1 equal: its JCDentonMaleCarcass0's first LastRenderTime is stamped a tick late in Play (the actor mesh layer admits a spawned mesh actor asynchronously, so the first frame after the spawn tick does not draw or stamp it; the original does), the open item of cmb5 (5.1.5, 5.2.7). Every other watched field, the stream, the clock, the AI events, the creations and the level's end (after tick 1931 in both) are equal | validate-stage5-live cmb3 (O1: the Terrorists' fire kills the player at tick 863, HealthTorso -4, Dying and DeathFront; Play equal through Dying to tick 900); validate-console-command (OPEN: SetClientTravel stores the URL and runs PreTravel; the client travel step ends the level) | FAIL |
| 5.1.9 | 01_NYC_UNATCOIsland AutoTurret | NSFTurret01 fires at the player when its cameras trigger libertyturret1; the player can shoot it down | O1 | `island-turret` | O1: live trace of the original with the turret active (bActive via trigger) and the player in its range | validate-island-tracer | MISSING |

### 5.2 Stealth

| Id | Scene | Scenario | Ev. | Census | Proof that would pass it | Existing, partial | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5.2.1 | 00_TrainingFinal stealth maze | walk in and out of the soldiers' sight: patrols, AllianceTrigger hostile/neutral, AlarmUnit, DL_FailedStealth, the reset | O1 | `stealth-maze` | O1: live trace of the original with the player at fixed poses in a Soldier's patrol (no held keys needed) and the soldiers' states, alarm and trigger flags | - | MISSING |
| 5.2.2 | 01_NYC_UNATCOIsland | a visible player in the open: a patrolling Terrorist sees it (AICanSee, SightCounter, CycleCumulative), turns, calls the alert; a hidden player is not seen | O1 | `island-sight` | O1: live trace of the original (no ghost, player standing at a measured pose in a patrol's view and out of it) with the perception fields of the Perception pilot | perception pilot O1 in the Underworld (civilians flee a visible mj12-allied player); validate-pawn-perception / AICanSee x87 (O2) | PASS |
| 5.2.3 | 01_NYC_UNATCOIsland | the player's noise reaches the guards: gunshots (WeaponFire, LoudNoise), the HandleShot/HandleLoudNoise callbacks; footsteps by speed and floor | O1 | `island-hearing` | footsteps (a held key the harness cannot post: O3 on Play's footstep inputs); the gunshot half has an Island O1 (cmb2) | validate-stage5-live cmb2 (O1 on Island: an unseen player's two pistol shots, every AI event manager call equal, the three NSF pawns woken); live-events-compare O1: 1,069 and 1,586 manager calls equal in the Underworld (pistol, assault shotgun) | MISSING |
| 5.2.4 | 01_NYC_UNATCOIsland cameras | SecurityCamera sees the player: tracking, the alarm event, NSFCam01..03 trigger libertyturret1; UN_CamSystem01..04 (bNoAlarm) do not | O1 | `island-camera` | O1: live trace of the original with the player in a camera's cone and the camera's state, the alarm flag and the turret's state per tick | - | MISSING |
| 5.2.5 | 01_NYC_UNATCOIsland laser trap | a LaserTrigger beam broken by the player raises the alarm (LaserTrigger.BeginAlarm: klaxon and an 'alarm' AI event; the laser has no Event) and a guard in Alerting state triggers AlarmUnit0 (SetAlarmFlag -> StatueAlarmTriggered) | O1 | `island-laser` | O1: live trace of the original with the player placed across statue_lasertrap and the beam, trigger and flag state | - | FAIL |
| 5.2.6 | 01_NYC_UNATCOIsland laser trap | hacking ControlPanel0 with a multitool switches statue_lasertrap off: hack time (skill, hackStrength), the multitool's use, the lasers' state | O1 | `island-hack-panel` | O1: live trace of the original (Multitool selected, a left-button click on the panel: ParseLeftClick, never the right button) with the hack progress, multitool charge and laser state per tick | - | MISSING |
| 5.2.7 | 01_NYC_UNATCOIsland | a pawn reacts to a body: a killed or knocked-out Terrorist is seen (CheckCarcassPresence, HaveSeenCarcass, AddCarcass) and the finder investigates or flees | O1 | `island-carcass` | cmb5 equal: its carcass's first LastRenderTime is stamped a tick late in Play (see 5.1.5) | validate-pawn-carcass (natives 2108/2109, O2); validate-stage5-live cmb1 (O1: the attacking Terrorists find TerroristCarcass1, CarcassTimer 120, and stay in Attacking) | FAIL |

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
| 5.3.9 | 01_NYC_UNATCOIsland terminals | ComputerPersonal0 login with a user list, email; ATM0; ComputerSecurity camera views and door/turret choices | O1 | `island-terminal` | O1: frames of the original's login and screens plus the computer state after choices | security terminal screens O1 (4.4.13); Terminals in Play (P) | MISSING |
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
| 5.5.1 | 01_NYC_UNATCOIsland front entrance | with the key from Filben (its first choice) the front doors (StatueRuinDoors, four movers) unlock and open; without it they stay locked and the player can pick them (lockStrength 0.1); they cannot be broken (bBreakable false) | O1 | `route-front` | O1: live trace of the original at the doors with and without the key and with the lockpick (key ring or Lockpick in hand, left-button click, then the right button to open) | - | MISSING |
| 5.5.2 | 01_NYC_UNATCOIsland back entrance | the back way in (DL_BackEntrance, DeusExMover2: lockStrength 0.1, doorStrength 0.5, no key): lockpick it or break it; no hackable device guards it; the guards at the lower deck | O1 | `route-back` | O1: live trace of the original at DeusExMover2 (Lockpick in hand, left-button click, then the right button to open; the break by damage) and the patrol | - | MISSING |
| 5.5.3 | 01_NYC_UNATCOIsland airshafts | the airshaft route around the laser trap to Gunther's cell (DL_libertyruinsairshaft x3): crouch through the shafts, the NPCs and alarms bypassed | O1 | `route-airshaft` | O1: the same state comparisons with the player placed in the shaft | - | MISSING |
| 5.5.4 | 01_NYC_UNATCOIsland water route | the east side by water: swim to the ruins, the electric arcs (ElectricityEmitter x3, LibElectric, EMP damage drains energy), ControlPanel1 and the fork lift | O1 | `route-water` | O1: live trace of the original from the water to the arcs, the panel and the lift | - | MISSING |
| 5.5.5 | 01_NYC_UNATCOIsland | kill the commander: TerroristCommander_Dead -> DL_LeaderKilled (InSpite after NotKilled) -> StatueMissionComplete | O1 | `objective-kill` | O1: live trace of the original from the commander's death through Mission01.Timer | - | FAIL |
| 5.5.6 | 01_NYC_UNATCOIsland | spare the commander: MeetTerrorist (Curious) -> StatueMissionComplete; DL_LeaderNotKilled | O1 | `objective-spare` | O1: live trace of the original through the conversation and the timer | - | MISSING |
| 5.5.7 | 01_NYC_UNATCOIsland | StatueMissionComplete changes the world (Mission01.Timer): UN_maindoor opens, doors unlock, custody and post-mission troops enter, Terrorists die, Paul teleports, turrets and lasers go, cameras silenced | O1 | `mission-complete` | O1: live trace of the original after the flag with every changed actor per tick | - | MISSING |

### 5.6 Systems interacting

| Id | Scene | Scenario | Ev. | Census | Proof that would pass it | Existing, partial | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5.6.1 | 01_NYC_UNATCOIsland | a shot near guards: noise, hostility, pursuit, distress to other pawns, the player hurt and healed with a MedKit | O1 | `noise-wakes-guards` | O1: live trace of the original of the whole encounter | 5.1.5, 5.1.6, 5.2.3 each partial; validate-stage5-live cmb2 (O1: the shots near the guards, their hostility, distress and the player hurt; no MedKit) | PASS |
| 5.6.2 | 00_TrainingFinal alarm | an AlarmUnit trips (bActive for its alarmTimeout, 10 s): AlarmDispatcher fires SoldierNeutral (AllianceTriggers), CloseDoor (ExitDoor) and failmessage (DL_FailedStealth) | O1 | `alarm-chain` | O1: live trace of the original from the alarm's trigger | - | MISSING |
| 5.6.3 | 01_NYC_UNATCOIsland | light against sight: the same pose seen or not seen as the player lights or darkens it (AugLight, a light switch, the NPC's lighting of the player) | O1 | `light-vs-sight` | O1: live trace of the original with perception fields at two light states | validate-pawn-perception, AICanSee (O2); lighting oracles (O2) | UNDRIVEN |
| 5.6.4 | 01_NYC_UNATCOIsland | an explosion: a barrel or CrateExplosiveSmall near a Terrorist, a breakable door and a decoration: HurtRadius, damage to each, noise, chain explosions | O1 | `explosion-world` | O1: live trace of the original with the barrel shot | validate-island-blowitup (O2); VisibleCollidingActors iterator 312 (O2) | MISSING |
| 5.6.5 | 01_NYC_UNATCOIsland | EMP: an EMP grenade or the EMP field against a SecurityBot, the turret and the camera (disabled) and the player's energy | O1 | `emp-electronics` | O1: live trace of the original with an EMP grenade thrown at the bot | alterations census emp-grenade, hit-emp (P) | MISSING |
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

## Census: where Play stands (2026-10-17, after the combat captures)

`node scripts/census-stage5.mjs` drives the 50 scenarios in Play's own frame (headless: `createGame`, `sim-session` tick, sprite scan and HUD, the player-input fixture), one session per
map with the original Player start between scenarios, a child per map under an RSS watchdog. Headless is the established census practice (alterations census, Stage 3 probes); the
default worker page runs the same simulation code. **Full runs on the Linux host: 36 plays, 1 pause, 10 no-effect, 3 undriven (1,353 s, peak 4,390 MiB; a second run with the expectations stored passed in 1,448 s, peak 3,313 MiB, every outcome equal). On review three predicates were tightened to the effect their rows name (`pistol-range`: a range target registers; `island-shoot-npc`: the Terrorist is killed; `island-laser`: `StatueAlarmTriggered` is set) and those three rerun as no-effect: 33 plays, 1 pause, 13 no-effect, 3 undriven. The first gap task (A, branch of master 5625f65) fixed the pause and five no-effects (a Play gap and five driver faults, findings 1, 4 and 6): 39 plays, 0 pause, 8 no-effect, 3 undriven in 1,237 s (peak 4,282 MiB), outcomes equal to the stored expectations. The second (B, Island devices) on its own: 37 plays, 1 pause, 9 no-effect, 3 undriven. The two merged, one run: 43 plays, 0 pause, 4 no-effect, 3 undriven (1,081 s, peak 3,380 MiB). After the combat captures (`island-sight` rediagnosed, finding 6), one run on the Mac: **44 plays, 0 pause, 3 no-effect, 3 undriven** (706 s, peak 1,725 MiB), equal to the stored outcomes; the table below is that run.** The expected outcomes are stored in
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
  them for a player; `training-datalinks` leaves out `dl_bodyexit` (no collision: the body doors open it, which the route covers). Since the first gap task: the island scenarios wait for
  `MissionScript.FirstFrame` (flag `M1MissionStart`) before the player is placed, as a walk would; `island-shoot-npc` tops up the pistol from a second `Ammo10mm` pack (the summoned `WeaponPistol`
  carries `PickupAmmoCount` 6 and no reserve) and re-aims before each shot by placing the player's own view at the target (a fixture write of the player's position and rotation; the fire is a
  key edge), because a hit Terrorist flees; `lam-wall`, `pistol-range` and the combat shots aim the same way; `lam-wall` places the LAM (walks up until `bNearWall`, the original's path near a
  Mover) and shoots it from 150 units without backing off; `pistol-range` walks onto `DataLinkTrigger2`, frobs `Switch3` and shoots the glass the target carries; `emp-electronics` throws at
  `SecurityBot0` standing at its first patrol point, where a headless frame leaves it (no mesh is drawn, `bStasis` stops its patrol; a rendered bot keeps walking and the throw would have to
  lead it); `alarm-chain` trips the unit with a `Trigger` call and reads the chain during and after its 10 s `alarmTimeout`.

| Scenario | Rows | Map | Outcome | First pause, or what was observed |
| --- | --- | --- | --- | --- |
| `crowbar-crate` | 5.1.1 | 00_Training | plays | {delegate:validate-crowbar-crate.mjs,peakMiB:1032,last:crowbar crate: ticked hits, fragments/bounce/fade/expiry, Lockpick landing/pickup/equip, queued |
| `phase1-route` | 5.3.1 | 00_Training | plays | {route:PlayerStart -> DL_part2,ms:0} |
| `dark-room-aug` | 5.3.2 | 00_Training | plays | {active:true,energy0:100,energy:99.50003051757812,beams:2} |
| `bots` | 5.3.3 | 00_Training | plays | {RepairBot:true,MedicalBot:true} |
| `obstacle-jump` | 5.3.4 | 00_Training | plays | {z0:16.735414505004883,zMax:64.16401672363281,end:[6991,-82,17],physics:1} |
| `ladder` | 5.3.5 | 00_Training | plays | {delegate:validate-training-ladder.mjs,peakMiB:1109,last:{\floor\:-144,\top\:[6986,-3571,16],\hang\:-60,\descentZ\:-17.054441452026367,\scope\:\Traini |
| `crate-stack` | 5.3.6 | 00_Training | plays | {crate:CrateUnbreakableSmall0,carried:true,dropped:true,at:[7262,-1493,-14]} |
| `hazmat-swim` | 5.3.7 | 00_Training | plays | {bare:10,suited:8,swimming:true,active:true} |
| `training-datalinks` | 5.4.1 | 00_Training | plays | {triggers:18,played:17,died:false,missing:[]} |
| `pistol-range` | 5.1.2 | 00_TrainingCombat | plays | {intro:true,shield1:1,target:[0,-1216,-50],doorKey:1,shots:4,ammo:[18,14],glassGone:false,glass:[0,-1216,19916],shot1:true} |
| `rifle-scope` | 5.1.3 | 00_TrainingCombat | plays | {scoped:true,ammo:4,fov:10,skill:SkillWeaponRifle} |
| `lam-wall` | 5.1.4 | 00_TrainingCombat | plays | {near:true,placed:LAM5,stuck:true,proximity:true,shots:4,lamGone:true,wallDestroyed:true,doorStrength:0,playerHealth:77,finishWall:true} |
| `instructor-take` | 5.4.2 | 00_TrainingCombat | plays | {delegate:validate-instructor-conversation.mjs,peakMiB:906,last:Instructor Play flow passed: both owners, Frob/Take, natural FlagTrigger, 29 transfers |
| `stealth-maze` | 5.2.1 | 00_TrainingFinal | plays | {state:deusex.scriptedpawn.patrolling,enemy:null,failed:true} |
| `elevator` | 5.3.13 | 00_TrainingFinal | plays | {before:0,after:1,moving:false,note:ElevatorMover1 (ExitDoor) is moved by mission triggers only: not driven} |
| `alarm-chain` | 5.6.2 | 00_TrainingFinal | plays | {before:{state:deusex.scriptedpawn.startup,enemy:null,door:0},after:{state:deusex.scriptedpawn.patrolling,enemy:null,door:1,active:false},rang:true,ri |
| `meet-page-final` | 5.4.8 | 00_TrainingFinal | no-effect | the effect did not happen |
| `island-shoot-npc` | 5.1.5 | 01_NYC_UNATCOIsland | plays | {h0:75,health:null,shots:7,ammo:[18,13],state:null,enemy:false,newCarcasses:1,playerDied:false,bearing:3.141592653589793} |
| `island-npc-shoots-player` | 5.1.6 | 01_NYC_UNATCOIsland | plays | {enemy:true,tracers:1,minHealth:0,states:[standing,attacking],physics:1,died:false,h:0} |
| `island-melee-ko` | 5.1.7 | 01_NYC_UNATCOIsland | plays | {gone:true,fresh:[{name:TerroristCarcass2,itemName:Unconscious}],playerDied:false} |
| `island-death` | 5.1.8 | 01_NYC_UNATCOIsland | plays | {health:-500,state:deusex.deusexplayer.dying,reachedOpenDxOnly:false} |
| `island-turret` | 5.1.9 | 01_NYC_UNATCOIsland | plays | {tried:[[0,null,false],[1.57,JCDentonMale4,true]],h:[100,95],died:false} |
| `island-sight` | 5.2.2 | 01_NYC_UNATCOIsland | plays | {before:standing,behind:{unseen:true,out:{enemy:false,tracers:0,minHealth:100,states:[standing],physics:1},playerDied:false},inView:{out:{enemy:true,t |
| `island-hearing` | 5.2.3 | 01_NYC_UNATCOIsland | plays | {before:standing,quietBeforeShots:true,state:dying,enemy:true,playerDied:false,note:sight and hearing cannot be told apart in the open} |
| `island-camera` | 5.2.4 | 01_NYC_UNATCOIsland | plays | {seen:[[200,true,true],[350,true,true],[500,true,true]],alarm:true,state:active} |
| `island-laser` | 5.2.5 | 01_NYC_UNATCOIsland | no-effect | the beam fires (LaserTrigger.BeginAlarm: klaxon and an alarm AI event, lastAlarmTime set) but no guard triggers AlarmUnit0, so StatueAlarmTriggered is never set: the three Terrorists in view attack the player, who is dead in 15 s (the laser has no Event; AlarmUnit0 is triggered from ScriptedPawn.Alerting) |
| `island-hack-panel` | 5.2.6 | 01_NYC_UNATCOIsland | plays | {started:true,frames:239,hackStrength:0,lasersOn:[[true,true,true,true,true],[false,false,false,false,false]],multitool:[1,0],playerDied:false} |
| `island-carcass` | 5.2.7 | 01_NYC_UNATCOIsland | plays | {killed:true,numCarcasses:1,state:attacking,playerDied:false} |
| `island-swim` | 5.3.8 | 01_NYC_UNATCOIsland | plays | {physics:3,swimTimer:[19.533340454101562,5.533483505249023],health:[100,100],drowned:false} |
| `island-terminal` | 5.3.9 | 01_NYC_UNATCOIsland | plays | {ComputerPersonal0:true,ComputerPersonal0.window:networkterminalpersonal,ATM0:true,ComputerSecurity1:true,ComputerSecurity1.window:networkterminalsecu |
| `island-doors` | 5.3.10 | 01_NYC_UNATCOIsland | plays | {keyTaken:false,keypadDoor:true} |
| `island-items` | 5.3.11 | 01_NYC_UNATCOIsland | plays | {hurt:80,healed:87,points:[5000,5025]} |
| `island-movables-fall` | 5.3.12 | 01_NYC_UNATCOIsland | plays | {carried:true,item:Trashbag0,fall:8,h0:100,h:92} |
| `meet-paul` | 5.4.3 | 01_NYC_UNATCOIsland | plays | {delegate:validate-island-conversation.mjs,peakMiB:42,last:{\ok\:true,\start\:1420,\choice\:4268,\camera\:\ConCamera0\,\letterboxFrames\:2849,\paulSpe |
| `meet-filben` | 5.4.4 | 01_NYC_UNATCOIsland | plays | {trust:{met:true,ended:true,gaveKey:true,keys:[ruin_key],seconds:5.5},refuse:{met:true,ended:true,gaveKey:false,keys:[],seconds:7}} |
| `gunther-rescued` | 5.4.5 | 01_NYC_UNATCOIsland | undriven | the cell door DeusExMover10 is reached by no frob approach tried (8 bearings, 3 distances, 2 heights around its Location); the walk to it is not driven |
| `meet-terrorist` | 5.4.6 | 01_NYC_UNATCOIsland | plays | {played:false,complete:true,attacked:true,commander:conversation,at:[2887,38,2528]} |
| `overheard-barks` | 5.4.7 | 01_NYC_UNATCOIsland | plays | {delegate:validate-island-bark.mjs,peakMiB:1096,last:island-bark: Terrorist30's bark deusexconaudioaibarks.conaudioaibarks_896 on Galaxy channel 57306 |
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
| `emp-electronics` | 5.6.5 | 01_NYC_UNATCOIsland | plays | {before:{state:patrolling,emp:100,health:250},attempts:[[1.57,0]],state:disabled,emp:0,health:250,grenades:1,playerDied:false} |
| `flags-change-world` | 5.6.6 | 01_NYC_UNATCOIsland | undriven | needs GuntherFreed (see gunther-rescued) and the Filben and commander flows; only the conversation flows of meet-filben and meet-terrorist are driven |

**What the census found in Play** (each is a lead for an agent, not yet a diagnosis):

1. **`CriticalDelete` of a `ConHistory` was unrecovered, and a pawn's death never reached it** (`island-carcass`, was the only `pause`; **resolved by the first gap task**). The only caller in the retail
   bytecode is `DeusExPlayer.ResetConversationHistory`, reached from `MissionScript.FirstFrame` (the first `Mission01.Timer` call, behind `M1MissionStart`), `ResetPlayerToDefaults` (`Login`) and
   `RestartLevel`. The census placed the player beside `Terrorist4` before that first call, so the Terrorist's greeting made a history that `FirstFrame` then deleted; the shot at `Terrorist4` had nothing
   to do with it. The driver now lets `FirstFrame` run first (what a walk produces) and the deleting destructor is recovered (DeusEx vtable `0x10027fe8` slot `+0x0c` `0x100146a0`, ConSys `~DConHistory`
   `0x10003400`: [LoadMap GC](script-loadmap-gc.md), "ConHistory CriticalDelete"; `validate-con-history-delete`). A kill now finishes: `Terrorist4` becomes a `TerroristCarcass` with its inventory and
   `Terrorist27` goes `seeking`/`attacking`.
2. **The player's death ends at `OPEN DXONLY`** (`UGameEngine::Exec OPEN is not implemented`): `island-death` reaches the Dying state and a killed player (`route-front`: shot by the guards at the statue doors)
   stops there. That is the reload after death, Stage 6's neighbour; the question is where Play should stop.
   **Taken up 2026-10-18** ([below](#the-players-death-to-the-levels-end-2026-10-18)): `OPEN` is now the original's `SetClientTravel`, and Play stops where the original leaves the level,
   at `UGameEngine::Tick`'s client travel after the next tick; the Browse to `DXONLY` and its menu stay Stage 6 (5.7.1).
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
4. **LAM, EMP, AlarmUnit and the pistol range were driver faults, not Play's** (`lam-wall`, `emp-electronics`, `alarm-chain`, `pistol-range`; **resolved by the first gap task**, each now `plays`).
   `lam-wall`: the driver stood the player 250 units from `BreakableWall1` along x, outside the level (zone 0): the player fell out of the world and died on the first frames, so Fire did nothing.
   In the world, a thrown LAM bounces off the wall and back (`ThrownProjectile.Flying.HitWall`) and explodes on its fuse; the lesson's input is `WeaponLAM.Fire`'s Place path (`WeaponLAM.Tick`'s
   `NearWallCheck` traces 32 units at a Level or Mover hit, `BreakableWall` is a `DeusExMover`), which leaves a proximity LAM (a mine for NPCs only in single-player, `ThrownProjectile.Tick`)
   that `ThrownProjectile.TakeDamage` explodes: shot from 150 units, `HurtRadius` 'exploded' takes `doorStrength` 0.4 to 0, `BlowItUp` fires `FinishWall` and `DL_FinishWall` plays.
   `emp-electronics`: the driver threw at `SecurityBot0`'s start point while it walked away; the grenade (about 550 units of flight, fuse about 3.5 s) went off 590 units from it, outside the 512
   unit rings. Thrown from 550 units at the bot standing at its first patrol point, `HurtRadius` 'EMP' takes `EMPHitPoints` 100 to 0 and the bot goes `disabled`.
   `alarm-chain`: the driver read `bActive` once at 12 s; `AlarmUnit.Tick` calls `UnTrigger` at `alarmTimeout` (10 s on `AlarmUnit1`). The unit rings for 9 s, the dispatcher's outputs
   run (`ExitDoor` `KeyNum` 0 to 1, `DL_FailedStealth` played, the `SoldierNeutral` AllianceTriggers set the soldiers' alliance to `None`: they do not become hostile) and it falls silent again.
   `pistol-range`: the range is a chain, not a wall of targets. `DataLinkTrigger2` plays `DL_TArgetRange`, whose conversation event opens the cover `DeusExMover1` (`shield1`) over `Switch3`;
   `Switch3` (Event `guntarget1`) slides `DeusExMover4` with `BreakableGlass0` and a `MoverCollider` from y -3280 to -1216, and the `MoverCollider` passes the four `DirectionalTrigger`s
   (`ClassProximityType` `MoverCollider`, `Touch` fires from the side the dot product allows) that open the blast door `DeusExMover7`; the glass is the target (Event `shootplay`, then
   `DataLinkTrigger4` plays `DL_TArgetRangeshot1`). The window of the station spans z -110 to -47 over the sill at y -656 and the settled player's eye is at z -72. The old driver
   placed the player 36 units above the floor at x 65, between the two lanes (the glass stands at x 0 and 128), and fired six shots at a target that had never moved behind a closed blast door
   (a probe that re-placed the player at that height before each shot hit the window frame at y -656 every time; settled on the floor the shots reach the blast door). `AlarmUnit1`
   is not "the same unit" as the Island laser: **`island-laser` stays `no-effect` for another reason.** `LaserTrigger.BeginAlarm` only rings the klaxon and sends an `alarm` AI event
   (`LaserTrigger0`'s Event is None); `AlarmUnit0` (Event `SetAlarmFlag`, then `FlagTrigger3` sets `StatueAlarmTriggered`) is triggered by a guard in `ScriptedPawn.Alerting`
   (`TriggerAlarm`, an `AlarmUnit` within 2400). In the census run the three Terrorists in view attack the player (`attacking`) and he is dead in 15 s, before anyone alerts: that is the
   NPC-versus-player question of item 4 of the remaining work, not a missing alarm.
5. **Radiation costs the player once** (`hazmat-swim`): `WaterZone0` (`DamagePerSec` 20, Radiation, `bPainZone`) took 10 health on entry and no more over 20 s; with the HazMat suit active the entry took 8. A
   debug series (a second look at the same zone) shows `PainTime` counting the breath, not a pain interval.
6. **NPC reaction to being hurt** (`island-shoot-npc`; the kill itself is **resolved by the first gap task**, the reaction is still unverified): the 20 pistol shots that took `Terrorist0` from 75
   to 17 were a driver limit, not Play's damage. The summoned `WeaponPistol` carries `PickupAmmoCount` 6 and no reserve, the Terrorist turned on the player after the first hit and ran (`fleeing`)
   after the third, and the driver's aim was fixed at the placement, so shots 4 to 7 hit the world behind him (`ProcessTraceHit` on `LevelInfo0`) and the clip ran dry. The damage is the original
   script's: `ProcessTraceHit` hands 16 (the pistol's `HitDamage` 14 plus its modifiers) to `ScriptedPawn.TakeDamage`; `HandleDamage` takes `actualDamage` times 2 off a limb or the torso (32 per hit)
   and `Health` follows (75, 62, 49, 17 on three hits). With a second pack and the sights re-placed on him for each shot, seven shots kill him (health -1, `dying`, a carcass). `island-sight`
   (700 units, open ground) still saw no reaction in 10 s while at 350 units the Terrorist engages and the player is shot to 0 (`island-npc-shoots-player`, with Tracers in flight). **Compared with
   the original on 2026-10-17** ([below](#first-original-captures-island-combat-2026-10-17)): four captured scenes of Terrorists against a visible player replay equal in every pawn, the player, the
   clock, the stream and every AI event. The original does not notice a player 700 units *behind* `Terrorist0` either: the census had placed the player there (bearing PI, 133 degrees off its
   facing), and with no mesh drawn the pawn was in stasis after 5 s as well. `island-sight` now stands behind it and then in its view, stamps it as a rendered frame would, and plays.
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


## First original captures: Island combat (2026-10-17)

The first O1 evidence for a Stage 5 row: the original playing a scene of Terrorists against a visible player on `01_NYC_UNATCOIsland`, traced tick by tick (the
[live-scene method](visual-acceptance.md#live-scenes-2026-10-13)) and replayed in Play. The traces were taken on the Mac under CrossOver, one at a time under the bottle lock, and are
stored in `.work/live-acceptance/01_NYC_UNATCOIsland/*-cmbN.*` (outside Git). `node scripts/validate-stage5-live.mjs --scene cmbN --print-capture` prints each capture command, and
`node scripts/validate-stage5-live.mjs --scene cmbN` is the proof check. The check passes only when all of these are equal: every watched field of the 87 ScriptedPawns and the
player at every tick (the perception fields, the player's gear and six hit regions, `bLOSflag`), the level clock, the stream draws per tick, every AI event manager call and delivered
callback, and every object the scene creates, by class and tick, in order.

**The scene.** `Terrorist0` stands on open ground at (9651, 190), facing yaw 8624, with `ThugMale7` 127 units away (facing south) and the patrolling `Terrorist10` 800 units
away; all three are NSF and hostile to the player. The player is placed in the original's frozen phase. The early commands are `KillAll FlyGenerator` (the load's chance
flies, removed in both programs as row 4.2.13 does), `ghost` (out of the collision hash), a SET of `Location`, `walk` (back into the hash at the new place) and a SET of
`ViewRotation`. Play runs the same lines. A weapon or item is summoned, looked at, picked up with `ParseRightClick` and drawn with `ActivateBelt 1`. The fire is the `Enter`
binding's key edges (`ParseLeftClick|Fire`); the harness cannot hold a key, so the player never walks.

| Scene | Pose and inputs | What the original did | Replay in Play |
| --- | --- | --- | --- |
| `cmb1` | 700 units in front of `Terrorist0`; pistol; Enter at 420, 480, 540 | `Terrorist0` and `ThugMale7` seek the player from tick 41, all three attack from 178 and hit the player's legs and torso; the first shot (420) kills `Terrorist0` (`Dying`, `TerroristCarcass1` at 469) | 88 actors equal for 900 ticks; 1,571 AI events and 1,291 creations equal |
| `cmb2` | 700 units behind it (the census's old pose), facing away; pistol; turned on it at 590, Enter at 600, 630, 660 | nobody notices the player for 600 ticks; two hits take `Terrorist0` to 43 (`TakingHit`) and 30 (`Fleeing`); the others attack | 88 actors equal for 900 ticks; 1,421 AI events and 1,150 creations equal |
| `cmb3` | 150 units behind it at head height; pistol; Enter at 300, 360, 420, 480 | both notice the player at tick 42; the first shot hits `ThugMale7` (100 to 68), who stepped into the line; no Terrorist dies; their fire kills the player at tick 863 (`HealthTorso` -4: `Dying`, `DeathFront`) | 88 actors equal for 900 ticks, through 37 ticks of `Dying`; 1,514 AI events and 1,364 creations equal |
| `cmb4` | `cmb1`'s pose; `BallisticArmor` picked up, put in hand and activated by the Enter edge at 180 | the three attack from about tick 180; nine Tracers in 720 ticks take the armored player from 100 to 95 (legs and arms) | 88 actors equal for 900 ticks; 1,567 AI events and 1,284 creations equal |
| `cmb5` (2026-10-18) | a ledge 900 units east of `Terrorist16` on the statue's terrace and 287 above it, out of every NSF pawn's view; `Tantalus` at tick 20; `TerroristCarcass1` watched from the tick it appears | `Terrorist16` dies at 21; its carcass at 98 holds `WeaponPistol`, `Ammo10mm` and `WeaponCombatKnife`; no pawn hears the death (the nearest, `Terrorist21`, is 1,032 units off); the patrolling `Terrorist21` meets the body at 512 (`CarcassTimer` 120, `Seeking`, `SeekType` 4, `SEEKTYPE_Carcass`) | 88 of 89 actors equal for 900 ticks; the carcass's `LastRenderTime` is stamped one tick late (below); 1,352 AI events and 935 creations equal |
| `cmb6` (2026-10-18) | `cmb1`'s inputs, with `TerroristCarcass1` watched | the Terrorists' own fire kills `ThugMale7` at 395 (`ThugMale2Carcass0`); the player's shots miss `Terrorist0`, so no `TerroristCarcass1` appears | 89 actors equal for 900 ticks; 1,569 AI events and 1,310 creations equal |
| `cmb7` (2026-10-18) | `cmb2`'s pose; the pistol and a `MedKit` picked up facing away (belt slots 1 and 2); turned on `Terrorist0` at 200; Enter at 300 and 360; `ActivateBelt 2` at 650, Enter at 700 | the first shot hits `Terrorist0` (62, `TakingHit`), the second kills it; the three attack, the player is hurt from tick 548 (95 at 669: torso 90, leg 86, arm 95), and the MedKit heals every region to 100 at 701 | 88 actors equal for 900 ticks; 1,447 AI events and 1,134 creations equal |

**What the first replays found.** Every pawn was equal from the first replay. The differences that remained came from three inputs of the replay, each now measured from the original
([visual acceptance](visual-acceptance.md#a-placed-player-the-levels-tick-parity-and-the-frozen-render-stamps-2026-10-17-stage-5)):

1. The player's `AnimFrame` ran 0.0125 behind for the first 90 ticks. A landing after the placement left Play's player in `TweenToWaiting` (the same sequence name, `AnimLast` 0, no loop), and
   the replay wrote only four of the animation fields. This is also the conversation captures' unexplained allowance ([conversation camera](conversation-camera.md)).
2. One draw a tick early or late (338/339, 441/442, 445/446) and a `ShellCasing`'s `LoudNoise` value at 445. The cause was `ULevel::TickTag`'s parity at the release. A `BulletHole`
   owned by the level is deferred on every other tick, so its 1 s timer fires after 2 s, on ticks of one parity. Bisected with the original's per-actor stream trace (`--actor-trace`).
3. `LastRenderTime` of Paul, `SecurityBot0` and `UNATCOTroop1`, which the original's start view at the dock had stamped (`--render-history`).

Also changed on the way: `--early-cmds` now run in Play before the pose's placement, in the original's order (no difference was traced to the old order). The six Stage 4 rows that replay
live traces (4.1.5, 4.1.6, 4.1.7, 4.2.13, 4.3.6, 4.5.5) were rerun after these changes and pass.

**What the census learned.** `island-sight` had stood the player 700 units behind `Terrorist0`, where the original's Terrorists do not see it either (`cmb2`), and a headless frame left the
pawn in stasis after 5 s besides. It now stands behind it (the effect: no reaction) and then in its view (the effect: seeking and attacking), with the pawn stamped as the
renderer would stamp it. It plays.

**Rows.** 5.2.2 passes on `cmb1` and `cmb2`, and 5.1.6 on `cmb1` to `cmb4`, `cmb6` and `cmb7`. The armor is compared through the hit regions it protects; its `Charge` is not a watched field, because the armor is a summoned actor. No scene has a Terrorist take cover; the row's "or takes cover" is the AI's choice, not something the scene asks for. 5.6.1 passes on `cmb7`. 5.1.5 and 5.2.7 name `cmb5` and fail on its one open difference ([below](#second-captures-a-body-found-the-carcasss-contents-the-medkit-2026-10-18)). 5.2.3 keeps its footsteps `need`. 5.1.8 was not proved: `cmb3` keeps the player's
death (tick 863) and Play is equal through 37 ticks of `Dying`, but the death state's end is not captured. `die1` (2026-10-18, [below](#the-players-death-to-the-levels-end-2026-10-18)) runs it to the level's end.

**The subtitle windows' lifetime: explained and fixed (2026-10-18).** In `cmb2` and `cmb3` some objects took a different registry slot, while every creation was equal in class and tick: 50 of
1,150 and 64 of 1,364. The first difference in `cmb2` was the bark subtitle of tick 660 (`ConAudioAIBarks_859`, 1.976 s by both programs' `GetSpeechLength`; the MP3 is 1.985 s): Play freed its
`HUDBarkDisplayItem` windows at tick 664, the original at 675. The cause was the replay's order inside a held tick, read from the stored trace alone (no new capture):

* The level was held at tick 660 for 31 window frames (`roottick`, 1.7364 s) to type the two key edges. The Enter press's `UEngine::InputEvent` (call record seq 7969) came after 25 of them;
  the pistol's shot ran inside it and created the bark's windows (`HUDBarkDisplayItem3` at seq 7993), and 6 frames (0.4643 s) followed before tick 661.
* `HUDBarkDisplayItem.Tick` adds each frame's `deltaSeconds` to `timeDisplayed` and destroys the item when it passes `timeToDisplay` (DeusEx.u). Summing the original's frames after seq 7993 in
  f32 crosses 1.976 at the frame of u = 675 (seq 8203, total 1.9895), and the original's `UnhashObject` of the item follows at seq 8224, after its ten GCs and TextWindows in the order Play frees them.
* Play's replay ran a hold's commands first and then all of the hold's frames before the next tick, so the subtitle got the whole 1.7364 s. Window ticks with `ShowHud` or a
  held level are not the cause: the window system ticks every frame in both programs, and only the frames after its creation can reach a window.

The replay now splits a held tick's frames at its commands (`live-acceptance.mjs` `commandsWithStream`: each command's matched `InputEvent` record carries its call sequence number, and the frames of
the hold before it tick the windows before the command runs, `live-probe.mjs`), and Play's object log labels a window frame's frees and creations with the tracer's u (the last level tick before the
frame, not the next one). Rerun on the stored scenes: `cmb2` frees `HUDBarkDisplayItem3` at 675 as the original does, and 0 of its 1,150 creations take another slot; `cmb1` 0 of 1,291, `cmb4` 0 of 1,284; `cmb3`'s tick-43 bark is
freed at 50 as in the original; every actor, the clock, the draws, the AI events and the creations stay equal in all four scenes.

**Open: `cmb3`'s registry slots after tick 821 (bounded, not the subtitles).** 64 of `cmb3`'s 1,364 creations still take another slot, from `BloodSplat46` at tick 821 on (`sound-compare-cmb3.json` `oAdds[1277]`:
the original appends slot 48490, Play reuses 43708). Tick 821 is a `ULevel::CleanupDestroyed` purge in both programs (the same 126 frees in the same order). Three inputs of the slot model differ, none of
them game state:
1. The original's purge ends with two objects that existed at the frozen start, `NanoKeyRing4` (47461) and `PickupDistributor0` (43708), after `BloodSplat46` is created. The replay's `preFrees`
   release such objects before the tick they are freed in, so Play's free list held both at tick 821's spawn.
2. Play holds its own pending-deleted `PickupDistributor0` (it destroys itself at load) and its purge releases it under 36046, the index Play's map table gives export 4739
   (`map-object-indices.mjs`, built from an earlier capture of the map); in this run's dump `PickupDistributor0` is 43708 and 36046 is `ConEventEnd.ConEventEnd4793`. The objectTrace
   seed gives the dump's indices only to actors in `level.actors` whose name Play's population lists, so a pending-deleted pre-placed actor keeps the table's index. That is a
   general gap of the seed, not specific to this scene (found with a one-off stack trace of the release: `cleanupLevelDestroyed`, `script-level-collection.mjs` `release`).
3. The pre-free of `PickupDistributor0` is then counted twice: once by the replay and once by Play's own purge.
A fix needs the dump's index for pending-deleted pre-placed actors, no pre-free for an object Play itself frees, and the remaining pre-frees released at their place in the purge. Nothing a watched
actor reads depends on it. Until then the Stage 5 check judges the creations by class and tick and reports the slots. Row 4.3.6 keeps its strict slot check.

### Second captures: a body found, the carcass's contents, the MedKit (2026-10-18)

**Watching an actor the scene spawns.** The tracer resolved its watched names once, when it attached, so a carcass spawned mid-scene could not be watched. A `late-watch` group of
`tools/dx-live-win.c` names actors the level may not hold yet: an object of that name is offered at the return of `UObject::AddObject` (the captures' `addobj` breakpoint, `retname`) and by
any `GObjObjects` slot that changed since the last tick, and it is bound at the first tick exit once its `XLevel` is the traced level (SpawnActor sets it after AddObject). Its rows start
there. A field type `chain` follows a linked list through one offset: `Actor.Inventory` (+0xc0) is the carcass's first item and each item's next. `live-acceptance.mjs --carcass-watch A,B`
writes the group with the Actor fields, the fields `DeusExCarcass.InitFor` and the dying pawn set (`KillerAlliance`, `Alliance`, `CarcassName`, `MaxDamage`, `bNotDead`, `bEmitCarcass`,
`bInit`; Play's linked offsets for `TerroristCarcass0`) and the chain. Play's replay looks the name up at every row until its level holds it, and `compare` checks the tick each carcass
appears at (`Present`) and the chain by its items' classes in order (their numbers follow each program's creation order). In `cmb5` both programs bind `TerroristCarcass1` at tick 98.

**`cmb5`: a pawn finding a body it was not fighting over.** A kill next to other pawns wakes them first: the dying pawn raises `Distress` and `LoudNoise` (`PlayDyingSound`), and in
Play's rehearsal of `Tantalus` on `Terrorist0` the two pawns near it attacked the player on the next tick; in `cmb1` the body was found by pawns already in `Attacking`, where
`CheckCarcassPresence` adds it (`AddCarcass`, `CarcassTimer` 120) and they stay in `Attacking`. So the victim is a pawn no other pawn can hear: `Terrorist16`, wandering in place on the statue's terrace, whose nearest NSF neighbours are 1,032
(`Terrorist21`) and 1,153 units off counted as `APawn::AICanHear` counts (height twice, 800 units the default radius). The kill is `DeusExPlayer.Tantalus` (the cheat: every health 0 and
`TakeDamage` from the player): no `WeaponFire` and no `LoudNoise` from the player, and the death cry's `LoudNoise` is the dying pawn's own, which `HandleLoudNoise` ignores (not a valid
enemy). The pose, a ledge 900 units east and 287 above, with a clear line to `Terrorist16` and out of every NSF pawn's cone, was screened in Play (class P) and rehearsed headless. In the
original `Terrorist21` patrols on, sees the body at tick 512 and seeks it (`CarcassTimer` 120, `SeekType` 4). The `Carcass` AI event is raised by the carcass, but its callback is commented
out in the original's `UpdateReactionCallbacks`, so no `Carcass` callback is ever delivered: the finding is the polled sight check, and the 5.2.7 note of the first captures was the
original's behaviour, not a gap. `stage5-capture-rehearsal.mjs` now holds the level (`bPlayersOnly`) while the early lines are typed, as the capture does; before, 60 unfrozen ticks ran
first, and `Terrorist16` had wandered off by the kill.

**What the replays found.** Two differences, each an original cause, fixed in Play:

1. **Core's sine table at pi.** `Terrorist16`'s `Velocity.Y` after the kill (`Tantalus`'s momentum, `Vector(ViewRotation)` at yaw 32768) was -3.06962686e-15 in the original and
   -3.0697283e-15 in Play, and `cmb7`'s `Terrorist0` had the same 0.99997 ratio in `Acceleration.Y` at tick 366. FGlobalMath fills the table with a bare `fsin`, which reduces with a 66-bit pi:
   entry 8192 (the double nearest pi) is pi66 - pi, word `0x250d3000`, where Math.sin, Python's math.sin and Unicorn's FSIN (through a host double) give `0x250d3132`. Measured for all
   16,384 entries on the real x87 through Rosetta 2 (`tools/x87-sintable-probe.c`, the constructor's sequence at precision control 53 and 64: the only entry that differs). Play's table
   (`coords.mjs`, which the Rust kernel copies) and the Unicorn oracles (`native-collision-oracle.py` `HARDWARE_TRIG`) now hold the measured word ([fitting](fitting.md)). Every rotator at a
   right angle reads this entry (the sine of yaw 32768, the cosine of 16384). The validators that read the table were rerun: below. Unverified on the Linux host's AMD x87.
2. **`RandomBiasedRotation`'s draws.** `cmb7`'s `Terrorist10` (tick 781) and `cmb6`'s `Terrorist0` (796) sprinted toward a destination 0.02 to 0.06 units off the original's, one sine-table
   step of direction: `ComputeBestFiringPosition`'s sprint calls native 717, and Play gave the helper (`AActor::RandomBiasedRotation` 0x1036d030) a float32 copy of each `appFrand` draw. The
   helper uses appFrand's retained x87 product (`call [0x10599cb8]`, then `fadd st0,st0` on ST0; [rng](rng.md)), as native 709 already did. Both replays are equal since.

**Open: a spawned actor's first render stamp.** `TerroristCarcass1`'s `LastRenderTime` is -10 at tick 99 in Play and 187.668228 (tick 98's time) in the original, and equal from tick 100.
The original's `DrawActorSprite` stamps the carcass in the first frame after the tick that spawned it. Play's actor mesh layer admits a spawned mesh actor through an asynchronous binding
(`actor-mesh-sim.mjs` `admit`: `createMeshBinding` awaits the mesh resource and each group's skin), so that frame neither draws nor stamps it. It is one tick, and nothing in the scene
reads the carcass's stamp, but it is a difference in a watched field, so `cmb5` fails, and with it 5.1.5 and 5.2.7. The fix belongs to the mesh layer (a binding available in the frame
its actor first appears in, with its resources resident as the original's are); it is not made here.

**The other two scenes.** `cmb6` repeats `cmb1`'s inputs with `TerroristCarcass1` watched, for the contents of a pistol kill: this time the Terrorists' own fire killed `ThugMale7` at 395 and
the player's three shots missed `Terrorist0`. The scene replays equal and proves 5.1.6; the contents are compared on `cmb5`'s carcass, and the pistol kills (`cmb1` at 420, `cmb7` at 360)
by the death and the carcass's creation. `cmb7` is 5.6.1's whole encounter: two shots from 700 units behind `Terrorist0` (the second kills it), the others attack, the player is hurt from
548 and the MedKit heals every region to 100 at 701. The MedKit's own state (a summoned actor) is not watched; the heal is read through the player's `Health` and hit regions.

### The player's death to the level's end (2026-10-18)

**What the original does.** `DeusExPlayer` state `Dying` hides the player after `FinishAnim` and spawns its carcass (`bHidden`, `SpawnCarcass`). Until then its `PlayerCalcView`
sets `FrobTime` to `Level.TimeSeconds` at every render; afterwards the camera spirals over the carcass for 8 s and fades for 12 more, and at the first render where the fade is `-1`
(`Level.TimeSeconds - FrobTime` at least 20) it calls `ConsoleCommand("OPEN DXONLY")` when no menu or tool window is on top. The rest is native and was read from Engine.dll:
`UGameEngine::Exec` (0x1038a030) tests `OPEN` first and, with a client viewport, calls `SetClientTravel(Client->Viewports(0), Cmd, 0, TRAVEL_Partial)` (vtable +0x88 at 0x1038a0a9).
`SetClientTravel` (0x1038fa10) stores `TravelURL` (+0xa0), `TravelType` (+0x9c) and `bTravelItems` (+0xac) on the viewport, then runs `ProcessEvent(PreTravel)` on every actor of
`GLevel->Actors` whose `FindFunction(PreTravel)` finds one (0x1038fb4b..0x1038fb95, the name at 0x1047f080): `MissionScript` turns its timer off and drops its flags, `DeusExPlayer`
sets `PlayerTraveling`, saves its skill points in two int flags (`SaveSkillPoints`, `FlagBase.SetInt`) and puts its fire out (its own timer off), `AugLight` destroys its beams. Nothing is
browsed there. `UGameEngine::Tick` (0x1038fe90) ticks the levels (0x10390154..0x103901a3), then tests `Viewports(0)->TravelURL` (0x1039088e) and browses to it (vtable +0xa8 at
0x10390c01: `DDeusExGameEngine::Browse`, then LoadMap), and only then has the client render (`UClient::Tick`, vtable +0x64 at 0x1039117b). So an `OPEN` typed in the render after tick N
ends the level after tick N + 1, which still runs with the `PreTravel` changes.

**The tracer.** `tools/dx-live-win.c` breaks at 0x103908bd, the first instruction of the client travel branch (a `mov`, reached only for a non-empty URL): the unfrozen ticks the level
ran go to `<trace>.ended`, and it restores the byte and detaches before Browse (no record of the save, the unload or the next map's load). `live-acceptance.mjs original` takes a
tracer that ends there (no `paused after`, no end dumps) and `--wait-seconds` for a long run; it also reads back a typed `set DeusEx.JCDentonMale Health<Region> N` from the live player
before the trace (the console drops characters on a loaded host). Tried first on a 60-tick trace with `open 00_Training` typed in the hold after tick 30: `.ended` 30, and the
`settravel` breakpoint on `SetClientTravel` shows its arguments (the viewport, the URL, 0, 1) and, inside it, `AddObject` of a `FlagBool` and two `FlagInt` (`PreTravel`'s flags).

**Play.** `OPEN` runs `SetClientTravel` as recovered (`script-console-command.mjs`), and `game.mjs` `clientTravel` is the engine's travel step, called after each tick and before the
view (`sim-session.mjs`, the census session): a stored URL ends the level there, thrown as `ClientTravelBoundary` (Browse, LoadMap and the menu are Stage 6). A live replay records the
tick (`play-level-end<tag>.json`); a trace that ended at a hold runs that hold's commands first. `FlagBase.SetInt` (native 1102, `XFlagBase::SetInt` 0x10023e80) is `SetBool`'s body
with type 2, a `FlagInt` object and the whole int stored; the flag store now keys a flag by name and type (`script-triggers.mjs`; `validate-flagbase-iterators` still passes).
`validate-console-command` checks `OPEN` (the URL, the `PreTravel` flags, the next step's boundary).

**`die1`.** `cmb1`'s pose (700 units in front of `Terrorist0`), no weapon, `HealthTorso` and `HealthHead` set to 5 in the frozen phase: the Terrorists' fire kills the player at tick 652
(`DeathFront`, `HealthTorso` -5), the carcass is spawned at 730, `FrobTime` stops at 242.72316, the original's `SetClientTravel` comes in the render after tick 1930 (20.033 s later)
and its level ends after tick 1931. Play's ends after tick 1931 too. The check passes the level's end, the clock and the stream draws for all 1,931 ticks, the 1,536 AI events and the
1,572 creations (33 of them take another registry slot: reported, not judged). Watched: the eight NSF pawns within 5,000 units, the player and its carcass, all equal for every tick but
one field: **`JCDentonMaleCarcass0`'s first `LastRenderTime`** (242.739822 at tick 731 in the original, -10 in Play, equal afterwards), `cmb5`'s open item (the actor mesh layer admits a
spawned mesh asynchronously, [above](#second-captures-a-body-found-the-carcasss-contents-the-medkit-2026-10-18)). So 5.1.8 fails on that item alone, with 5.1.5 and 5.2.7. The trace is
47 MB (155 s on the bottle). A first capture (level end after 1825) found one more difference, in the harness: with an explicit watch list the other pawns' load-time `SightCounter`
was Play's own, and a far listener's check moved the player's `ShowSelf` draw from tick 12 to tick 4. `live-acceptance.mjs` now traces the unwatched `ScriptedPawn`s with their load
fields only (`Sight`, `TRate`, `TCount`, `LRT`; watch<tag>.json `loadPawns`), which the replay writes and does not compare; the second capture's draws are equal throughout.

## Scoreboard (2026-10-18, after the second combat captures)

`node scripts/validate-stage5-acceptance.mjs --census .work/stage5-census-2026-10-18.json --report` on a fresh census of this code (the Mac: the census 12 min, 44 plays, 0 pause,
3 no-effect, 3 undriven, equal to its `EXPECTED`; the seven proof replays, each run once, 10 min): **3 of 50 criteria pass; the gate is red** (exit 1). 55 rows, 5 excluded.
History: the first run (master 5d7285c, with the three tightened predicates) was 0 PASS, 14 FAIL, 33 MISSING, 3 UNDRIVEN. The Island devices task moved 5.2.6, 5.3.9, 5.5.1 and 5.5.2 from FAIL to
MISSING. The death, explosives and alarms task moved 5.1.2, 5.1.4, 5.1.5, 5.2.7, 5.6.2 and 5.6.5. That left 0 PASS, 4 FAIL, 43 MISSING, 3 UNDRIVEN. The first combat captures moved
5.2.2 from FAIL to PASS and 5.1.6 from MISSING to PASS (2 PASS, 3 FAIL, 42 MISSING). The second moved 5.6.1 from MISSING to PASS, and 5.1.5 and 5.2.7 from MISSING to FAIL: their proof,
`cmb5`, differs in one field at one tick (the carcass's first render stamp, [above](#second-captures-a-body-found-the-carcasss-contents-the-medkit-2026-10-18)).
The death capture (`die1`, the same day, rerun with `--only` on a fresh `island-death` census) moved 5.1.8 from MISSING to FAIL on the same item, its player carcass's first stamp
([above](#the-players-death-to-the-levels-end-2026-10-18)): 3 PASS, 6 FAIL, 38 MISSING, 3 UNDRIVEN (report `.work/stage5-gate-2026-10-18-518.json`). That report is the run above with
row 5.1.8 replaced by its rerun; the other rows were not rerun on the death task's code (`OPEN`, the client travel step, the typed flag store, the load-field pawns), which `cmb7`'s
check (still PASS) and the unit tests (652 pass) exercise.

| Clause | PASS | FAIL | MISSING | UNDRIVEN | EXCLUDED |
| --- | ---: | ---: | ---: | ---: | ---: |
| 5.1 Combat | 1 | 2 | 6 | 0 | 0 |
| 5.2 Stealth | 1 | 2 | 4 | 0 | 0 |
| 5.3 Exploration and the character systems | 0 | 0 | 13 | 0 | 0 |
| 5.4 Conversation | 0 | 1 | 6 | 1 | 0 |
| 5.5 Alternate-route objectives | 0 | 1 | 6 | 0 | 0 |
| 5.6 Systems interacting | 1 | 0 | 3 | 2 | 0 |
| 5.7 Excluded | 0 | 0 | 0 | 0 | 5 |
| **Total** | **3** | **6** | **38** | **3** | **5** |

The three `PASS` rows have proof checks on the stored Island combat scenes ([above](#first-original-captures-island-combat-2026-10-17)): 5.2.2 on `cmb1` and `cmb2`, 5.1.6 on `cmb1` to
`cmb4`, `cmb6` and `cmb7`, 5.6.1 on `cmb7`. Three `FAIL` rows (5.1.5, 5.2.7, 5.1.8) have a proof check that finds one difference, the same one (a spawned carcass's first render stamp); the other three `FAIL` rows do not play:
there is no pause, but `island-laser`, `meet-page-final` and `objective-kill` have no effect. The 38 `MISSING` rows play in the census and name the capture that would prove them. The 3 `UNDRIVEN` rows cannot be started. Stage 4's gate started at 44 of 70 because 60 checks against stored
originals already existed; for gameplay they did not. The strongest existing evidence is listed per row under "Existing, partial": the Island combat scenes, the Underworld's
weapon-noise traces for gunshots, the perception pilot, the first-person crowbar, MeetPaul's frames, and the native oracles for swimming, ladders, falling and movers.

**Checks rerun for the two Play fixes** (2026-10-18, the Mac): the 41 validators whose oracle or Play side reads Core's sine table (pawn nav and reach, falling, projectile, laser, level,
mover push, decals, brush rays and tracker, occlusion, child frames, sprites, the trace and actor iterators, the walking surface, the window viewport and sound, the collision and hash
natives, weapon attachment, static and mesh lighting, light animation and spatial, lodmesh frame, render visibility and mesh bounds, coords) all pass, as do the six Stage 4 rows that
replay live traces (4.1.5, 4.1.6, 4.1.7, 4.2.13, 4.3.6, 4.5.5) and the unit tests (652, two expected values updated to the measured sine entry). `validate-brush-tracker` stalled once
inside the sweep (both processes idle after its second case) and passes alone (20 cases, 239 steps). The three that also need the bottle (`validate-pawn-perception`,
`validate-pawn-locomotion`, `validate-window-scene-frame`) pass under the lock. Not rerun: the stored `bench-sim` digests (Play against Play), which predate the entry.

What backs the four newly playing rows is the recovered script source (`DeusExPlayer.ParseLeftClick`/`ParseRightClick`, `HackableDevices`, `DeusExMover`, `Computers`, `ConPlayBase.SetupEventTransferObject`) running as
bytecode in Play, plus the native oracle for the one native step Play was missing (the owned zero-extent PointCheck, 32,064 original cases). No row has an original trace of the pick, hack or key sequence yet
(the harness can type `@down Enter`/`@up Enter`, which are the `LeftMouse`/Enter binding `ParseLeftClick|Fire`. Placing the player in a ticking level is now done the combat captures' way:
`ghost`, a SET of `Location`, `walk`).

## Remaining Stage 5 work, in the order it blocks

Nothing below was fixed by the census task; the two gap tasks closed items 1 and 3. Each item is sized for one agent; "unblocks" names the rows.

1. ~~**Finish a pawn's death** (finding 1)~~ **Done by the first gap task A**: `CriticalDelete` of a `ConHistory` is recovered and a kill finishes (carcass and inventory); `island-carcass` and `island-shoot-npc` play.
2. **Decide and implement where a player's death stops** (finding 2): **done for the proof 2026-10-18**: Play stops at the original's client travel (`die1`,
   [above](#the-players-death-to-the-levels-end-2026-10-18)); the load menu after it stays Stage 6 unless the user decides otherwise (below).
3. **Island devices that never finish** (findings 3, 4, 7): **done 2026-10-17 by the two gap tasks.** Lockpick and hack outside Training and the personal and security terminals were the
   driver's wrong input, plus two Play gaps (findings 3 and 7); the LAM, the EMP grenade, the AlarmUnit and the pistol range were driver faults (finding 4). 5.1.2, 5.1.4, 5.2.6, 5.3.9, 5.5.1, 5.5.2,
   5.6.2 and 5.6.5 now play and wait for their O1 captures; the Island laser needs a guard in `Alerting` (finding 4, item 4 below).
4. **NPC combat against the player, compared with the original** (finding 6): **first captures done 2026-10-17, second 2026-10-18** ([above](#first-original-captures-island-combat-2026-10-17)).
   Seven scenes on Island, and `validate-stage5-live.mjs` is the proof check. 5.2.2, 5.1.6 and 5.6.1 pass. Still open, each named in the row's `need`: `cmb5`'s carcass render stamp, a tick
   late in Play (5.1.5, 5.2.7: the actor mesh layer's asynchronous admission), footsteps (5.2.3) and, for 5.1.8, the same carcass stamp on `die1` (the death runs to the level's end, equal).
5. **Pain zones and the HazMat suit** (finding 5): the zone's `DamagePerSec` over time and the suit's absorption, against a capture of Training's pool. Unblocks 5.3.7, 5.6.x radiation.
6. **The undriven scenarios**: the cell door and Gunther (5.4.5, 5.6.6), a lit/dark pair of poses (5.6.3), the `M00MeetPage` trigger (5.4.8), the commander from his room (5.5.5), the `ElevatorMover1` ride
   (5.3.13). Each is a driver plus whatever pause it finds; the first two are the biggest.
7. **Proof captures, by clause value**: conversation branches (5.4.3 to 5.4.6: choices, transfers, flags; the harness types Enter and Down as key edges), weapons and damage (5.1.1 to 5.1.3, 5.1.7), the
   routes (5.5), Training's lessons one capture each (5.3.1 to 5.3.4), and O3 comparisons for the native-body rows (5.3.5, 5.3.6, 5.3.2). The 43 `MISSING` rows are this item; none can start before items 1 to 4
   say Play does the scenario.

## What the user should decide

* **The list itself**: 50 scenarios, Training meaning all three maps, Island with its five ways in, one row for the whole of Training's phase 1, placed approaches instead of walks. Weak choices are labelled `weak`
  in `scripts/stage5-criteria.mjs` and in the tables above.
* **O3 or O2 as enough for native-body rows** (ladder, crate physics, swimming, falling, movers): the doc defaults to O3 (the DLL's code on Play's inputs in the scene), which does not exist yet for any of them.
* **Cross-map evidence for shared code**: the gunshot half of 5.2.3 now has an Island capture (`cmb2`); its footsteps half can have no live trace (a held key), so the choice is O3 on Play's footstep inputs or accepting the row without footsteps.
* **Where a player's death stops** (item 2): implemented as the original's client travel, where its level ends; whether the load menu after it belongs to Stage 5 or 6 is still open.
* **Priority**: items 1 and 3 are done, and item 4 has its first comparisons: the NPC-versus-player scenes replay equal. The largest open groups are now item 7's captures (one per row, about 15 minutes on the bottle each, plus a replay) and item 6's undriven scenarios.

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
node scripts/validate-stage5-live.mjs --scene cmb1                       # a proof check: the stored Island scene cmb1..cmb7, die1 replayed in Play (SKIP without the store)
node scripts/validate-stage5-live.mjs --scene cmb1 --print-capture       # the original's capture command of that scene (writes its tracer config; the bottle lock first)
node scripts/stage5-capture-rehearsal.mjs --scene cmb1                    # rehearse a scene's input list in Play, headless, before a capture (class P)
```
