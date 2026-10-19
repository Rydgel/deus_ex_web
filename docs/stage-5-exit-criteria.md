# Stage 5 exit criteria: a finite definition of "Done when"

Status: **draft for the user to adopt** (written 2026-10-17 from master 5d7285c; first census and scoreboard: 0 of 50 criteria pass; after the first original captures, the same evening: 2 of 50; on 2026-10-18 after the second captures and a spawned actor's first frame: 6 of 50; after the routes' captures, the same evening: 13 of 50). Nothing here is a Stage 5 claim; it is the definition the claims will be
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
| 5.1.5 | 01_NYC_UNATCOIsland | the player's pistol hurts and kills a standing Terrorist: damage, hit reaction, hostile response, death, carcass and its inventory | O1 | `island-shoot-npc` | O1: live trace of the original (pistol summoned and drawn, Fire edges at a Terrorist in view) with the pawn's Health, state, Orders, Enemy and the carcass | validate-stage5-live cmb7 (O1: the second pistol shot kills Terrorist0 at 360; its carcass created at the original's tick); weapon noise O1 (the NPCs' event handlers for a player's shots in the Underworld); carcass memory natives 2108/2109 (O2) | PASS |
| 5.1.6 | 01_NYC_UNATCOIsland | a hostile Terrorist attacks the player: it aims and fires (Tracer, physProjectile), the player's Health, armor and hit regions change, the AI keeps attacking or takes cover | O1 | `island-npc-shoots-player` | O1: live trace of the original with a visible, hostile-allied player in an NPC's view and the NPC's state, fire, projectile and the player's damage per tick | validate-island-tracer (tracer flight, P); validate-native-projectile (O2) | PASS |
| 5.1.7 | 01_NYC_UNATCOIsland | a baton or crowbar knocks a Terrorist out: KnockedOut carcass, "Unconscious", and Mission01.Timer's aggression count | O1 | `island-melee-ko` | O1: live trace of the original (WeaponBaton drawn, Fire edge at a Terrorist) with the pawn's state, the carcass and its itemName | validate-stage5-live ko1 (O1 2026-10-18: one baton swing from behind at the seated Terrorist18 takes it to Dying, Health -1, at tick 658; TerroristCarcass1 at 736 with bNotDead 1, KillerAlliance Player and the pistol, ammo and knife it carried; every pawn, the player and the carcass compared per tick) | PASS |
| 5.1.8 | 01_NYC_UNATCOIsland | player death: lethal damage reaches Dying, the death state and view; the game does not continue the level | O1 | `island-death` | O1: live trace of the original from lethal damage to the level's end (the Dying player's OPEN DXONLY, browsed at the next engine tick); Play stops at the same tick (the screen after it is Stage 6's load menu) | validate-stage5-live cmb3 (O1: the Terrorists' fire kills the player at tick 863, HealthTorso -4, Dying and DeathFront; Play equal through Dying to tick 900); validate-console-command (OPEN: SetClientTravel stores the URL and runs PreTravel; the client travel step ends the level) | PASS |
| 5.1.9 | 01_NYC_UNATCOIsland AutoTurret | NSFTurret01 (bActive false, bTrackPlayersOnly) wakes on an NSF camera's 'Alarm' AI event (AutoTurret.AlarmHeard: the cameras trigger no Event; libertyturret1 is their UnTriggerEvent, a hacked camera turning the turret off), aims AutoTurretGun0 and fires at the player (AutoTurret.Fire: a Trace, gunDamage 5); the player can shoot it down (AutoTurretGun HitPoints 50, its Destroyed destroys the turret) | O1 | `island-turret` | cam1: the blood of SecurityBot1's shots at the player (from tick 310; not the turret's) lands 0.87 units nearer the bot in Play, along the shot line, and the drops and splats it leaves differ from there. Cause found: ULevel::MultiLineCheck (0x1039b220) clips the actor segment at its world hit, Level->Model's LineCheck, and the original's Level->Model holds the brush tracker's mover fragments (DeusExMover23's face 930.7 units along the line), where Play's world check (hash.rs model_line_check, multiline.mjs) reads the static BSP (its hit 1801.8 units, the original DLL agreeing on that BSP); UPrimitive::LineCheck's 0.001 time back-off then gives 0.001 x (1801.8 - 930.7) = 0.871 (measured 0.8715). Need: Play's level traces over the tracked model (docs/brush-tracker.md "Open: Collision"); and shooting the turret down (AutoTurretGun HitPoints 50) is not captured (rehearsed: an untrained pistol misses the gun from 340 units and the turret and SecurityBot1 kill the player first) | validate-stage5-live cam1 (O1 2026-10-18: SecurityCamera3 sees the player at tick 7 and starts its 'alarm' AI event at 252; AutoTurret0's AlarmHeard runs at 252, it takes the player as curTarget at 253, aims AutoTurretGun0 and fires 30 times from 335; the turret, its gun, the camera, every pawn and the player equal per tick); validate-island-tracer | FAIL |

### 5.2 Stealth

| Id | Scene | Scenario | Ev. | Census | Proof that would pass it | Existing, partial | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5.2.1 | 00_TrainingFinal stealth maze | walk in and out of the soldiers' sight: patrols, AllianceTrigger hostile/neutral, AlarmUnit, DL_FailedStealth, the reset | O1 | `stealth-maze` | O1: live trace of the original with the player at fixed poses in a Soldier's patrol (no held keys needed) and the soldiers' states, alarm and trigger flags | - | MISSING |
| 5.2.2 | 01_NYC_UNATCOIsland | a visible player in the open: a patrolling Terrorist sees it (AICanSee, SightCounter, CycleCumulative), turns, calls the alert; a hidden player is not seen | O1 | `island-sight` | O1: live trace of the original (no ghost, player standing at a measured pose in a patrol's view and out of it) with the perception fields of the Perception pilot | perception pilot O1 in the Underworld (civilians flee a visible mj12-allied player); validate-pawn-perception / AICanSee x87 (O2) | PASS |
| 5.2.3 | 01_NYC_UNATCOIsland | the player's noise reaches the guards: gunshots (WeaponFire, LoudNoise), the HandleShot/HandleLoudNoise callbacks; footsteps by speed and floor | O1 | `island-hearing` | footsteps (a held key the harness cannot post: O3 on Play's footstep inputs); the gunshot half has an Island O1 (cmb2) | validate-stage5-live cmb2 (O1 on Island: an unseen player's two pistol shots, every AI event manager call equal, the three NSF pawns woken); live-events-compare O1: 1,069 and 1,586 manager calls equal in the Underworld (pistol, assault shotgun) | MISSING |
| 5.2.4 | 01_NYC_UNATCOIsland cameras | SecurityCamera sees the player: CheckPlayerVisibility every 0.1 s (cameraRange 1024, cameraFOV 4096 of its swinging Rotation), it tracks him and after triggerDelay (4 s) TriggerEvent(True) sounds its own Klaxon2 and starts an 'Alarm' AI event (it triggers no Event: NSFCam01..03's libertyturret1 is their UnTriggerEvent), which wakes NSFTurret01 (AlarmHeard) and the guards that hear it (HandleAlarm); UN_CamSystem01..04 (bNoAlarm) never check the player | O1 | `island-camera` | cam1: the blood of SecurityBot1's shots at the player (from tick 310; not the turret's) lands 0.87 units nearer the bot in Play, along the shot line, and the drops and splats it leaves differ from there. Cause found: ULevel::MultiLineCheck (0x1039b220) clips the actor segment at its world hit, Level->Model's LineCheck, and the original's Level->Model holds the brush tracker's mover fragments (DeusExMover23's face 930.7 units along the line), where Play's world check (hash.rs model_line_check, multiline.mjs) reads the static BSP (its hit 1801.8 units, the original DLL agreeing on that BSP); UPrimitive::LineCheck's 0.001 time back-off then gives 0.001 x (1801.8 - 930.7) = 0.871 (measured 0.8715). Need: Play's level traces over the tracked model (docs/brush-tracker.md "Open: Collision") | validate-stage5-live cam1 (O1 2026-10-18: NSFCam02 = SecurityCamera3 sees the player 400 units in front of it at tick 7 (bTrackPlayer, bPlayerSeen), triggers after triggerDelay at 252 (bEventTriggered) and starts 'alarm': AutoTurret0's AlarmHeard and Terrorist21's HandleAlarm run at 252); validate-stage5-live cam2 (O1 2026-10-18, PASS: SecurityCamera2, UN_CamSystem02 with bNoAlarm, swings for 300 ticks with the player 700 units in front of it, inside its range and cone, and never tracks him) | FAIL |
| 5.2.5 | 01_NYC_UNATCOIsland laser trap | a LaserTrigger beam broken by the player raises the alarm (LaserTrigger.BeginAlarm: Klaxon2 and an 'Alarm' AI event; the laser has no Event): the guards that hear it handle it (HandleAlarm: AlarmTimer 120, seek, attack), and AlarmTimer > 0 keeps them from the alarm box (Alerting: Alert -> Done -> Attacking); AlarmUnit0 (SetAlarmFlag -> FlagTrigger3 -> StatueAlarmTriggered) is rung by a RaiseAlarm BeforeAttacking guard that takes the player as its enemy with AlarmTimer 0 (Terrorist18 seeing him) | O1 | `island-laser` | O1: live trace of the original with the player placed across statue_lasertrap (the guards' AlarmTimer and states, the klaxon) and, separately, in Terrorist18's view (its run to AlarmUnit0 and the flag) | validate-stage5-live las1 (O1 2026-10-18: the player placed across the beams; LaserTrigger2..4 start 'alarm' at tick 2, AutoTurretSmall0's AlarmHeard and Terrorist30's and Terrorist2's HandleAlarm follow; Terrorist18 seeks with AlarmTimer > 0 and goes Alerting -> Attacking at 155-156 without the box; StatueAlarmTriggered stays unset); validate-stage5-live alm1 (O1: the player in Terrorist18's view south of its chair; NSFCam (SecurityCamera5) also alarms at 259; Terrorist18, AlarmTimer 0, seeks, goes Alerting at 114, rings AlarmUnit0 at 494 (its 'alarm', bActive) and StatueAlarmTriggered is set); validate-stage5-live alm2 (O1: hck1's hack from off Terrorist18's way: the MegaFutz shows it the player, it goes Alerting at 202 and rings AlarmUnit0 at 599; StatueAlarmTriggered set) | PASS |
| 5.2.6 | 01_NYC_UNATCOIsland laser trap | hacking ControlPanel0 with a multitool switches statue_lasertrap off: hack time (skill, hackStrength), the multitool's use, the lasers' state | O1 | `island-hack-panel` | O1: live trace of the original (Multitool selected, a left-button click on the panel: ParseLeftClick, never the right button) with the hack progress, multitool charge and laser state per tick | validate-stage5-live hck1 (O1 2026-10-18: the Multitool summoned, picked up and drawn, the Enter edge at 200 starts the hack, HackableDevices.Timer takes hackStrength 0.1 to 0 in 0.01 steps by tick 446, HackAction UnTriggers the five LaserTriggers; the panel, the lasers, AlarmUnit0, the Multitool and every pawn compared per tick) | PASS |
| 5.2.7 | 01_NYC_UNATCOIsland | a pawn reacts to a body: a killed or knocked-out Terrorist is seen (CheckCarcassPresence, HaveSeenCarcass, AddCarcass) and the finder investigates or flees | O1 | `island-carcass` | O1: live trace of the original with a carcass in a patrol's view | validate-pawn-carcass (natives 2108/2109, O2); validate-stage5-live cmb1 (O1: the attacking Terrorists find TerroristCarcass1, CarcassTimer 120, and stay in Attacking) | PASS |

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
| 5.3.10 | 01_NYC_UNATCOIsland doors | keyed, locked, breakable and keypad doors: the satcomhatch with the UNhatchdoor NanoKey, commvan_door keypad 0451, breakable and lockpicked movers, StatueRuinDoors | O1 | `island-doors` | O1: live trace of the original at each door (key use, pick, damage) with mover and lock state per tick. Open: dor3 differs from tick 319, where the original's rocket stops 2.0 units shorter: its MoveActor world query reads the moving brush tracker's fragments in Level->Model, so MultiLineCheck's mover recovery moves DeusExMover2's hit two units back (DLL MultiLineCheck and MoveActor on the tracked hit give the original's location to the bit); Play's collision world queries must read the tracked model (docs/brush-tracker.md Open) (the breakable door). | validate-island-cell-door, validate-island-blowitup (mover bodies, O2); validate-native-mover-move, -interpolation, -scene (O2) | FAIL |
| 5.3.11 | 01_NYC_UNATCOIsland inventory | pick up and use items (MedKit, food, ammo, mods, Lockpick, Multitool), skill points (SkillAwardTrigger) and the skills screen, the AugmentationCannister and installing an augmentation, goals and notes | O1 | `island-items` | O1: live trace of the original (ParseRightClick pickups, ActivateBelt, console) with inventory, health, skill and goal state | alterations census: 19 scenarios play (P); persona screens O1 (4.4.11, 4.4.12) | MISSING |
| 5.3.12 | 01_NYC_UNATCOIsland | move objects and fall: carry or push barrels and crates, throw them (kinetic damage), fall damage from a height | O1 | `island-movables-fall` | O1: live trace of the original with a thrown or pushed decoration and a measured fall | validate-plant-push (O2); landing/falling oracles (O2) | MISSING |
| 5.3.13 | 00_TrainingFinal and 01_NYC_UNATCOIsland movers | a switch-driven mover: 00_TrainingFinal Switch1 opens FirstStealthDoor; the exit door ElevatorMover1 (ExitDoor, a 64-unit slide, not a ride) is closed by a soldier's alarm (AlarmDispatcher -> CloseDoor, SequenceTrigger SeqNum 1) and reopened by Switch0 (ButtonDispatcher -> OpenDoor, SeqNum 0). Not driven: Island's Switch1 -> UN_maindoor (opened by Mission01) and the fork lift (DeusExMover11, a button in the ruins) | O1 | `elevator` | O1: live trace of the original at Switch1 and of the exit door closed by the alarm and reopened by Switch0 | validate-native-mover-move, -interpolation, -scene (O2); validate-island-cell-door | MISSING |

### 5.4 Conversation

| Id | Scene | Scenario | Ev. | Census | Proof that would pass it | Existing, partial | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5.4.1 | 00_Training | the 18 DataLinks of the course start at their triggers, queue behind a playing one, end and set DL_*_Played; DL_Lockpick starts from the Mission00 timer | O1 | `training-datalinks` | O1: the original's InfoLink window frames and the Played flags per tick (the window is not yet compared) | validate-training-datalinks, validate-training-datalink-live (P); script-datalink-original.md | MISSING |
| 5.4.2 | 00_TrainingCombat | the instructor takes the inventory: MunitionsTrooperTake/Frob (29 TransferObject events), MunitionsTrooperReady, Mission00.RemoveAllInventory | O1 | `instructor-take` | O1: live trace of the original through the conversation with the inventory per tick | validate-instructor-conversation (P) | MISSING |
| 5.4.3 | 01_NYC_UNATCOIsland | MeetPaul: the three weapon choices (Minicrossbow, GEP gun, rifle) hand JC the weapon, the map image and three goals | O1 | `meet-paul` | O1: the conversation frames to the choice (4.5.5) plus the transferred object and goals per branch | 4.5.5 O1 frames; validate-island-conversation: each choice plays to the end (P) | MISSING |
| 5.4.4 | 01_NYC_UNATCOIsland | MeetFilben (code phrase): the Choice decides FilbenGaveKey and the NanoKey; MeetFilben2 and AfterStatue follow the flags; skill points | O1 | `meet-filben` | O1: live trace of the original through each branch with the flags, inventory and skill points | - | MISSING |
| 5.4.5 | 01_NYC_UNATCOIsland | GuntherRescued: free Gunther (the wall button DeusExMover8 triggers the cell door DeusExMover10, GuntherFreed), five choices, the player gives him a weapon (CheckObject/TransferObject), GuntherRespectsPlayer, AddSkillPoints, his alliance and orders | O1 | `gunther-rescued` | O1: live trace of the original through the branches with flags, inventory and Gunther's orders | - | MISSING |
| 5.4.6 | 01_NYC_UNATCOIsland | MeetTerrorist with the commander: the Aggressive and Curious branches set PlayerAttackedStatueTerrorist and StatueMissionComplete; TerroristFollowup | O1 | `meet-terrorist` | O1: live trace of the original through both branches with the flags and the commander's orders | - | MISSING |
| 5.4.7 | 01_NYC_UNATCOIsland | overheard conversations and barks: TerroristsOverheard (Amos), TopTerroristsOverheard, the NPC barks in alert states | O1 | `overheard-barks` | O1: live trace of the original with the player in range (the bark choice and the speech started) | validate-island-bark (P); validate-island-lipsync (O3) | MISSING |
| 5.4.8 | 00_TrainingFinal | M00MeetPage and holo-Jaime: ConversationTrigger, JaimeAppears/JaimeBark_Played, EnterWorld/LeaveWorld by the Mission00 timer | O1 | `meet-page-final` | O1: live trace of the original with the flags and the holo pawns' bInWorld | - | MISSING |

### 5.5 Alternate-route objectives

| Id | Scene | Scenario | Ev. | Census | Proof that would pass it | Existing, partial | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5.5.1 | 01_NYC_UNATCOIsland front entrance | with the key from Filben (its first choice) the front doors (StatueRuinDoors, four movers) unlock and open; without it they stay locked and the player can pick them (lockStrength 0.1); they cannot be broken (bBreakable false) | O1 | `route-front` | O1: live trace of the original at the doors with and without the key and with the lockpick (key ring or Lockpick in hand, left-button click, then the right button to open). Open: dor3 differs from tick 319, where the original's rocket stops 2.0 units shorter: its MoveActor world query reads the moving brush tracker's fragments in Level->Model, so MultiLineCheck's mover recovery moves DeusExMover2's hit two units back (DLL MultiLineCheck and MoveActor on the tracked hit give the original's location to the bit); Play's collision world queries must read the tracked model (docs/brush-tracker.md Open) (the second rocket, at the front doors, follows it). | - | FAIL |
| 5.5.2 | 01_NYC_UNATCOIsland back entrance | the back way in (DL_BackEntrance, DeusExMover2: lockStrength 0.1, doorStrength 0.5, no key): lockpick it or break it; no hackable device guards it; the guards at the lower deck | O1 | `route-back` | O1: live trace of the original at DeusExMover2 (Lockpick in hand, left-button click, then the right button to open; the break by damage) and the patrol. Open: dor3 differs from tick 319, where the original's rocket stops 2.0 units shorter: its MoveActor world query reads the moving brush tracker's fragments in Level->Model, so MultiLineCheck's mover recovery moves DeusExMover2's hit two units back (DLL MultiLineCheck and MoveActor on the tracked hit give the original's location to the bit); Play's collision world queries must read the tracked model (docs/brush-tracker.md Open) (the break). | - | FAIL |
| 5.5.3 | 01_NYC_UNATCOIsland airshafts | the airshaft route around the laser trap to Gunther's cell (DL_libertyruinsairshaft x3): crouch through the shafts, the NPCs and alarms bypassed | O1 | `route-airshaft` | O1: the same state comparisons with the player placed in the shaft | - | PASS |
| 5.5.4 | 01_NYC_UNATCOIsland water route | the east side by water: swim to the ruins, the electric arcs (ElectricityEmitter x3, LibElectric, EMP damage drains energy), ControlPanel1 and the fork lift | O1 | `route-water` | O1: live trace of the original from the water to the arcs, the panel and the lift | - | PASS |
| 5.5.5 | 01_NYC_UNATCOIsland | kill the commander: TerroristCommander_Dead -> DL_LeaderKilled (InSpite after NotKilled) -> StatueMissionComplete | O1 | `objective-kill` | O1: live trace of the original from the commander's death through Mission01.Timer | - | PASS |
| 5.5.6 | 01_NYC_UNATCOIsland | spare the commander: MeetTerrorist (Curious) -> StatueMissionComplete; DL_LeaderNotKilled | O1 | `objective-spare` | O1: live trace of the original through the conversation and the timer | - | PASS |
| 5.5.7 | 01_NYC_UNATCOIsland | StatueMissionComplete changes the world (Mission01.Timer): UN_maindoor opens, doors unlock, custody and post-mission troops enter, Terrorists die, Paul teleports, turrets and lasers go, cameras silenced | O1 | `mission-complete` | O1: live trace of the original after the flag with every changed actor per tick | - | PASS |

### 5.6 Systems interacting

| Id | Scene | Scenario | Ev. | Census | Proof that would pass it | Existing, partial | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5.6.1 | 01_NYC_UNATCOIsland | a shot near guards: noise, hostility, pursuit, distress to other pawns, the player hurt and healed with a MedKit | O1 | `noise-wakes-guards` | O1: live trace of the original of the whole encounter | 5.1.5, 5.1.6, 5.2.3 each partial; validate-stage5-live cmb2 (O1: the shots near the guards, their hostility, distress and the player hurt; no MedKit) | PASS |
| 5.6.2 | 00_TrainingFinal alarm | an AlarmUnit trips (bActive for its alarmTimeout, 10 s): AlarmDispatcher fires SoldierNeutral (AllianceTriggers), CloseDoor (ExitDoor) and failmessage (DL_FailedStealth) | O1 | `alarm-chain` | O1: live trace of the original from the alarm's trigger | - | MISSING |
| 5.6.3 | 01_NYC_UNATCOIsland | light against sight: a pose seen or not seen by its lighting (AICanSee times AIVisibility against VisibilityThreshold). Island has no light switch, and AugLight adds a second path (its Beam AI event, CheckBeamPresence), so the census pair is the map's own lighting: two poses 500 units in front of Terrorist4 with a clear line of sight, one in shadow, one lit | O1 | `light-vs-sight` | O1: live trace of the original with Terrorist4's perception fields and the player's visibility at the two poses | validate-pawn-perception, AICanSee (O2); lighting oracles (O2) | MISSING |
| 5.6.4 | 01_NYC_UNATCOIsland | an explosion: a barrel or CrateExplosiveSmall near a Terrorist, a breakable door and a decoration: HurtRadius, damage to each, noise, chain explosions | O1 | `explosion-world` | O1: live trace of the original with the barrel shot | validate-stage5-live exp1 (O1 2026-10-18: two CrateExplosiveSmall summoned by the breakable DeusExMover5; the second lands half off the first and slides off it (processLanded's footprint push, 45); Terrorist2 comes to open the door, which crushes the first crate (Mover.EncroachingOn: TakeDamage 10000 'Crushed') at 307; its blast (ExplosionLarge, ShockRings, the gradual HurtRadius) sets off the second at 312, breaks the door (doorStrength 0.6 -> 0, bDestroyed), destroys TrashCan5 and kills Terrorist2; every pawn, the door, both crates, TrashCan5, Chair5, the AI events (LoudNoise) and the 1,634 objects created equal per tick); validate-native-landing (O2, the footprint push and the Carcass slide); validate-island-blowitup (O2); VisibleCollidingActors iterator 312 (O2) | PASS |
| 5.6.5 | 01_NYC_UNATCOIsland | EMP: an EMP grenade or the EMP field against a SecurityBot, the turret and the camera (disabled) and the player's energy | O1 | `emp-electronics` | emp2: the blood of SecurityBot1's shots at the player (tick 306 in the recapture; the first blood splat lands at 324 and the player's hit animation at 589 follows from the hit's place; not the turret's) lands 0.87 units nearer the bot in Play, along the shot line, and the drops and splats it leaves differ from there. Cause found: ULevel::MultiLineCheck (0x1039b220) clips the actor segment at its world hit, Level->Model's LineCheck, and the original's Level->Model holds the brush tracker's mover fragments (DeusExMover23's face 930.7 units along the line), where Play's world check (hash.rs model_line_check, multiline.mjs) reads the static BSP (its hit 1801.8 units, the original DLL agreeing on that BSP); UPrimitive::LineCheck's 0.001 time back-off then gives 0.001 x (1801.8 - 930.7) = 0.871 (measured 0.8715). Need: Play's level traces over the tracked model (docs/brush-tracker.md "Open: Collision") | validate-stage5-live emp1 (O1 2026-10-18, PASS: the grenade thrown at 200 toward PatrolPoint19; its blast takes SecurityBot0's EMPHitPoints 100 -> 69 -> 34 -> 0 from tick 418 and disables it at 423); validate-stage5-live emp2 (O1, recaptured with lastRefreshTime: at cam1's pose the blast confuses SecurityCamera3 (420) and AutoTurret0 (426), and the player's Energy drains 3.75 at 435, 450, 465 and 480, all equal); alterations census emp-grenade, hit-emp (P) | FAIL |
| 5.6.6 | 01_NYC_UNATCOIsland | conversation flags change the world: GuntherFreed (the cell door chain; on the same walk Gunther's alliance flips at AllianceTrigger0's touch, and GuntherRescued's GuntherAttacks gives his orders), FilbenGaveKey, M01PlayerAggressive, KnowsShipment | O1 | `flags-change-world` | O1: live trace of the original after each flag with the affected pawns' alliance and orders | - | MISSING |

### 5.7 Excluded

| Id | Scene | Scenario | Ev. | Census | Proof that would pass it | Existing, partial | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5.7.1 | every map | Save Game, Load Game, QuickSave and the load menu after death | - | - | Stage 6 (roadmap section 6): native 3011/3013; Stage 3 gate tolerates 3011 | - | EXCLUDED |
| 5.7.2 | Teleporter, MapExit, ClientTravel | Training map to map, Island to Battery Park, the HQ teleporter, the boat cinematic's end | - | - | Stage 6: map travel and PlayerTraveling (a measured host input) | - | EXCLUDED |
| 5.7.3 | flags across maps | flag expiration by mission number and persistence (M01PlayerAggressive until mission 6, DL_*_Played) | - | - | Stage 6: persistence | - | EXCLUDED |
| 5.7.4 | DXMP maps | multiplayer: replication, GameInfo MP, bots, the DXMP maps | - | - | Multiplayer is the last priority and may stay unsupported (AGENTS.md) | - | EXCLUDED |
| 5.7.5 | rendering of the above | how a scenario looks (weapon models, effects, windows) | - | - | Stage 4: the Stage 4 gate owns presentation | - | EXCLUDED |

<!-- criteria:end -->

## Census: where Play stands (2026-10-18, the merged branches)

`node scripts/census-stage5.mjs` drives the 50 scenarios in Play's own frame (headless: `createGame`, `sim-session` tick, sprite scan and HUD, the player-input fixture), one session per
map with the original Player start between scenarios, a child per map under an RSS watchdog. Headless is the established census practice (alterations census, Stage 3 probes); the
default worker page runs the same simulation code. **Full runs on the Linux host: 36 plays, 1 pause, 10 no-effect, 3 undriven (1,353 s, peak 4,390 MiB; a second run with the expectations stored passed in 1,448 s, peak 3,313 MiB, every outcome equal). On review three predicates were tightened to the effect their rows name (`pistol-range`: a range target registers; `island-shoot-npc`: the Terrorist is killed; `island-laser`: `StatueAlarmTriggered` is set) and those three rerun as no-effect: 33 plays, 1 pause, 13 no-effect, 3 undriven. The first gap task (A, branch of master 5625f65) fixed the pause and five no-effects (a Play gap and five driver faults, findings 1, 4 and 6): 39 plays, 0 pause, 8 no-effect, 3 undriven in 1,237 s (peak 4,282 MiB), outcomes equal to the stored expectations. The second (B, Island devices) on its own: 37 plays, 1 pause, 9 no-effect, 3 undriven. The two merged, one run: 43 plays, 0 pause, 4 no-effect, 3 undriven (1,081 s, peak 3,380 MiB). After the combat captures (`island-sight` rediagnosed, finding 6), one run on the Mac: 44 plays, 0 pause, 3 no-effect, 3 undriven (706 s, peak 1,725 MiB). After work item 6 (the six scenarios that did not play, findings 8 to 12, 2026-10-18), one run on the Mac: 50 plays, 0 pause, 0 no-effect, 0 undriven (839 s, peak 1,680 MiB). With the second captures and the death capture merged (master 9b9966a), one run on the Mac: **50 plays, 0 pause, 0 no-effect, 0 undriven** (1,045 s, peak 1,506 MiB), equal to the stored outcomes; the table below is that run.** The expected outcomes are stored in
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
  lead it); `alarm-chain` trips the unit with a `Trigger` call and reads the chain during and after its 10 s `alarmTimeout`. Since work item 6 (findings 8 to 12): `meet-page-final` walks into
  `ConversationTrigger1` from 160 units and presses `Switch6` for holo-Jaime; `objective-kill` shoots from 300 units in front of the commander (outside `MeetTerrorist`'s 140) with the pawn
  stamped; `island-laser` runs two branches, the beam and then (map reloaded) the player in Terrorist18's view; `gunther-rescued` presses the cell button `DeusExMover8` with a pistol in hand
  and walks to Gunther, re-aimed every half second; `flags-change-world` frees Gunther unarmed, plays `MeetFilben`'s first choice, walks onto `DL_NearTop`, and makes eight Terrorist kills as
  `TakeDamage` calls with the player as instigator (as `island-carcass` does), each part in a reloaded map; `light-vs-sight` places the player at the two measured poses in front of `Terrorist4`
  (stamped, with `Terrorist27`) and reads `AIGetLightLevel` and the line of sight through Play's own perception services; `elevator` lets `Soldier0` see the player (placed 180 units away) and
  then frobs `Switch0`.

| Scenario | Rows | Map | Outcome | First pause, or what was observed |
| --- | --- | --- | --- | --- |
| `crowbar-crate` | 5.1.1 | 00_Training | plays | {delegate:validate-crowbar-crate.mjs,peakMiB:819,last:crowbar crate: ticked hits, fragments/bounce/fade/expiry, Lockpick landing/pickup/equip, queued  |
| `phase1-route` | 5.3.1 | 00_Training | plays | {route:PlayerStart -> DL_part2,ms:0} |
| `dark-room-aug` | 5.3.2 | 00_Training | plays | {active:true,energy0:100,energy:99.50003051757812,beams:2} |
| `bots` | 5.3.3 | 00_Training | plays | {RepairBot:true,MedicalBot:true} |
| `obstacle-jump` | 5.3.4 | 00_Training | plays | {z0:16.735414505004883,zMax:64.16401672363281,end:[6991,-82,17],physics:1} |
| `ladder` | 5.3.5 | 00_Training | plays | {delegate:validate-training-ladder.mjs,peakMiB:960,last:{\floor\:-144,\top\:[6986,-3571,16],\hang\:-60,\descentZ\:-17.054441452026367,\scope\:\Trainin |
| `crate-stack` | 5.3.6 | 00_Training | plays | {crate:CrateUnbreakableSmall0,carried:true,dropped:true,at:[7262,-1493,-14]} |
| `hazmat-swim` | 5.3.7 | 00_Training | plays | {bare:10,suited:8,swimming:true,active:true} |
| `training-datalinks` | 5.4.1 | 00_Training | plays | {triggers:18,played:17,died:false,missing:[]} |
| `pistol-range` | 5.1.2 | 00_TrainingCombat | plays | {intro:true,shield1:1,target:[0,-1216,-50],doorKey:1,shots:4,ammo:[18,14],glassGone:false,glass:[0,-1216,19916],shot1:true} |
| `rifle-scope` | 5.1.3 | 00_TrainingCombat | plays | {scoped:true,ammo:4,fov:10,skill:SkillWeaponRifle} |
| `lam-wall` | 5.1.4 | 00_TrainingCombat | plays | {near:true,placed:LAM5,stuck:true,proximity:true,shots:4,lamGone:true,wallDestroyed:true,doorStrength:0,playerHealth:77,finishWall:true} |
| `instructor-take` | 5.4.2 | 00_TrainingCombat | plays | {delegate:validate-instructor-conversation.mjs,peakMiB:1063,last:Instructor Play flow passed: both owners, Frob/Take, natural FlagTrigger, 29 transfer |
| `stealth-maze` | 5.2.1 | 00_TrainingFinal | plays | {state:deusex.scriptedpawn.patrolling,enemy:null,failed:true} |
| `elevator` | 5.3.13 | 00_TrainingFinal | plays | {before:0,after:1,moving:false,exitDoor:{start:0,closedAt:3,closed:{key:1,y:112},reopened:{key:0,y:48}}} |
| `alarm-chain` | 5.6.2 | 00_TrainingFinal | plays | {before:{state:deusex.scriptedpawn.startup,enemy:null,door:0},after:{state:deusex.scriptedpawn.patrolling,enemy:null,door:1,active:false},rang:true,ri |
| `meet-page-final` | 5.4.8 | 00_TrainingFinal | plays | {page:{played:true,bob:BobPage1},holo:{hidden0:true,appears:true,entered:true,barkPlayed:true,inWorld:false,reyesHidden:true}} |
| `island-shoot-npc` | 5.1.5 | 01_NYC_UNATCOIsland | plays | {h0:75,health:null,shots:7,ammo:[18,13],state:null,enemy:false,newCarcasses:1,playerDied:false,bearing:3.141592653589793} |
| `island-npc-shoots-player` | 5.1.6 | 01_NYC_UNATCOIsland | plays | {enemy:true,tracers:1,minHealth:0,states:[standing,attacking],physics:1,died:false,h:0} |
| `island-melee-ko` | 5.1.7 | 01_NYC_UNATCOIsland | plays | {gone:true,fresh:[{name:TerroristCarcass2,itemName:Unconscious}],playerDied:false} |
| `island-death` | 5.1.8 | 01_NYC_UNATCOIsland | plays | {health:-500,state:deusex.deusexplayer.dying,reachedOpenDxOnly:false} |
| `island-turret` | 5.1.9 | 01_NYC_UNATCOIsland | plays | {tried:[[0,null,false],[1.57,JCDentonMale4,true]],h:[100,95],died:false} |
| `island-sight` | 5.2.2 | 01_NYC_UNATCOIsland | plays | {before:standing,behind:{unseen:true,out:{enemy:false,tracers:0,minHealth:100,states:[standing],physics:1},playerDied:false},inView:{out:{enemy:true,t |
| `island-hearing` | 5.2.3 | 01_NYC_UNATCOIsland | plays | {before:standing,quietBeforeShots:true,state:dying,enemy:true,playerDied:false,note:sight and hearing cannot be told apart in the open} |
| `island-camera` | 5.2.4 | 01_NYC_UNATCOIsland | plays | {seen:[[200,true,true],[350,true,true],[500,true,true]],alarm:true,state:active} |
| `island-laser` | 5.2.5 | 01_NYC_UNATCOIsland | plays | {beam:{lastAlarm:1.0666667222976685,klaxon:Klaxon2,alarmTimers:[112,112,112,112],t18:[seeking,alerting,attacking],hostile:4,unitRang:false,flag:false, |
| `island-hack-panel` | 5.2.6 | 01_NYC_UNATCOIsland | plays | {started:true,frames:239,hackStrength:0,lasersOn:[[true,true,true,true,true],[false,false,false,false,false]],multitool:[1,0],playerDied:false} |
| `island-carcass` | 5.2.7 | 01_NYC_UNATCOIsland | plays | {killed:true,numCarcasses:1,state:attacking,playerDied:false} |
| `island-swim` | 5.3.8 | 01_NYC_UNATCOIsland | plays | {physics:3,swimTimer:[19.533340454101562,5.533483505249023],health:[100,100],drowned:false} |
| `island-terminal` | 5.3.9 | 01_NYC_UNATCOIsland | plays | {ComputerPersonal0:true,ComputerPersonal0.window:networkterminalpersonal,ATM0:true,ComputerSecurity1:true,ComputerSecurity1.window:networkterminalsecu |
| `island-doors` | 5.3.10 | 01_NYC_UNATCOIsland | plays | {keyTaken:false,keypadDoor:true} |
| `island-items` | 5.3.11 | 01_NYC_UNATCOIsland | plays | {hurt:80,healed:87,points:[5000,5025]} |
| `island-movables-fall` | 5.3.12 | 01_NYC_UNATCOIsland | plays | {carried:true,item:Trashbag0,fall:8,h0:100,h:92} |
| `meet-paul` | 5.4.3 | 01_NYC_UNATCOIsland | plays | {delegate:validate-island-conversation.mjs,peakMiB:42,last:{\ok\:true,\start\:1420,\choice\:4268,\camera\:\ConCamera0\,\letterboxFrames\:2849,\paulSpe |
| `meet-filben` | 5.4.4 | 01_NYC_UNATCOIsland | plays | {trust:{met:true,ended:true,gaveKey:true,keys:[ruin_key],seconds:5.5},refuse:{met:true,ended:true,gaveKey:false,keys:[],seconds:7}} |
| `gunther-rescued` | 5.4.5 | 01_NYC_UNATCOIsland | plays | {door:{key:1,yaw:16384},freed:true,con:GuntherRescued,played:true,respects:true,weapon:WeaponPistol582,gave:true,skillPoints:[5000,5150],before:{allia |
| `meet-terrorist` | 5.4.6 | 01_NYC_UNATCOIsland | plays | {played:false,complete:true,attacked:true,commander:conversation,at:[2887,38,2528]} |
| `overheard-barks` | 5.4.7 | 01_NYC_UNATCOIsland | plays | {delegate:validate-island-bark.mjs,peakMiB:812,last:island-bark: Terrorist30's bark deusexconaudioaibarks.conaudioaibarks_896 on Galaxy channel 573066 |
| `route-front` | 5.5.1 | 01_NYC_UNATCOIsland | plays | {authored:{breakable:[false,false,false,false],lockStrength:0.10000000149011612},bareRightClick:[locked,locked,locked,locked],picking:true,pickFrames: |
| `route-back` | 5.5.2 | 01_NYC_UNATCOIsland | plays | {lockStrength:0.10000000149011612,bareRightClick:{locked:true,open:false},picking:true,pickFrames:245,unlocked:true,open:true,died:false,picks:0} |
| `route-airshaft` | 5.5.3 | 01_NYC_UNATCOIsland | plays | {played:true} |
| `route-water` | 5.5.4 | 01_NYC_UNATCOIsland | plays | {energy:[100,98],health:[100,95],died:false} |
| `objective-kill` | 5.5.5 | 01_NYC_UNATCOIsland | plays | {h0:100,distance:300,shots:5,dead:true,health:null,complete:true,killedPlayed:true,meetTerroristPlayed:false,playerDied:false} |
| `objective-spare` | 5.5.6 | 01_NYC_UNATCOIsland | plays | {complete:true,notKilledPlayed:false} |
| `mission-complete` | 5.5.7 | 01_NYC_UNATCOIsland | plays | {complete:true,thugsLeft:0,unMainDoorLocked:[false,false],paul:[-4681,2640,-94]} |
| `noise-wakes-guards` | 5.6.1 | 01_NYC_UNATCOIsland | plays | {out:{enemy:true,tracers:2,minHealth:0,states:[attacking,standing],physics:1},died:false,h:0} |
| `light-vs-sight` | 5.6.3 | 01_NYC_UNATCOIsland | plays | {dark:{at:[5835,2059,-96],distance:500,physics:1,los:true,light:0.0043,visibility:0.0043,readiness:0,seenAt:null,state:firstpersonconversation,playerD |
| `explosion-world` | 5.6.4 | 01_NYC_UNATCOIsland | plays | {gone:true,playerHealth:[100,83],died:false} |
| `emp-electronics` | 5.6.5 | 01_NYC_UNATCOIsland | plays | {before:{state:patrolling,emp:100,health:250},attempts:[[1.57,0]],state:disabled,emp:0,health:250,grenades:1,playerDied:false} |
| `flags-change-world` | 5.6.6 | 01_NYC_UNATCOIsland | plays | {gunther:{freed:true,before:{alliance:None,orders:Standing},after:{alliance:UNATCO,orders:RunningTo,state:attacking},respects:true},filben:{gaveKey:tr |

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
   is not "the same unit" as the Island laser: `island-laser` was `no-effect` for another reason, which turned out to be the row's own reading of the original (finding 9).
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
8. **`M00MeetPage` and the commander from his room were driver faults** (`meet-page-final`, `objective-kill`; **resolved by work item 6, 2026-10-18**). `MeetTerrorist` already played (the
   Aggressive branch with the first choice: `StatueMissionComplete` and `PlayerAttackedStatueTerrorist` set, `MeetTerrorist_Played` not), and `mission-complete` plays Mission01.Timer's world edit
   (Terrorists dead, `UN_maindoor` unlocked, Paul moved).
   `meet-page-final`: `ConversationTrigger1` (`conversationTag` `m00meetpage`, `BindName` `BobPage`, `CollisionRadius` 96) starts the conversation from its `Touch`
   (`ConversationTrigger.uc:55`, `StartConversationByName` with the owner within 800 units, `DeusExPlayer.uc:7705`), so the player has to walk *into* the cylinder. The driver placed the
   player 40 units from its centre, already inside, and no Touch ever began. Walked in from 160 units the Touch fires on the 17th frame and `M00MeetPage` (third person) plays to its end
   with Enter in about 6 s. The row's other half, holo-Jaime, is now driven too: `Switch6` (Event `jaime_talks`) reaches `FlagTrigger11`, which sets `JaimeAppears` and triggers `convo`
   (`ConversationTrigger0`, whose `conversationTag` `jaimebarks` names no conversation: both JaimeReyes own only `JaimeBark`). Mission00.Timer's `00_TRAININGFINAL` branch then calls
   `EnterWorld` on the `holojaime` JaimeReyes (`Mission00.uc:173`), its radius conversation `JaimeBark` (160 units) plays for 11.5 s, and on `JaimeBark_Played` the Timer calls `LeaveWorld`
   (`Mission00.uc:183`) and sets `MS_ReyesHidden`. Holo-Bob's `LeaveWorld` is in the `00_TRAINING` branch only, so Bob stays on this map, as in the original source.
   `objective-kill`: `MeetTerrorist` is the commander's radius conversation (`bInvokeRadius`, `radiusDistance` 140; `invokeRadius = Max(16, con.radiusDistance)`, `DeusExPlayer.uc:8070`). The
   driver placed the player 45 units from him, so the conversation started on his first low-priority tick. State `Conversation` put the pistol away (`conPlay.SetInHand(InHand);
   PutInHand(None)`, `DeusExPlayer.uc:7488`), and the clicks went to the conversation window: no shot was fired (the ammo stayed at 6). From 300 units in front of him, inside his room
   and outside the radius, five pistol shots kill him (100, 87, 74, 61, 29, -1; he attacks, then flees). Mission01.Timer then starts `DL_LeaderKilled` (`Mission01.uc:100`), whose event sets
   `StatueMissionComplete`, and `DL_LeaderKilled_Played` follows its end.
9. **The laser trap's row misread the original; the laser and the alarm box both play** (`island-laser`; **resolved by work item 6**). The row said a guard in `Alerting` triggers
   `AlarmUnit0` after the beam. The original script does not allow that for any guard that heard the beam. `LaserTrigger.BeginAlarm` rings `Klaxon2` and starts an `Alarm` AI event
   (`LaserTrigger.uc:31`; `LaserTrigger0` has no Event). A guard that handles it (`ScriptedPawn.HandleAlarm`) sets `AlarmTimer = 120` (`ScriptedPawn.uc:5531`) before `HandleEnemy`
   (`:5534`). `HandlingEnemy` sends a `RaiseAlarm` BeforeAttacking guard to `Alerting` (`:9694`), whose state code jumps to `Done` while `AlarmTimer > 0` (`Alert:`, `:11865`) and from there to
   `Attacking` (`:11910`). `AlarmTimer` counts down in `Tick` (`:7225`), so for two minutes after the beam no guard who heard it rings the box. Play does exactly this, per frame: on the
   beam, Terrorists 18, 30, 14 and 2 go `seeking` with `AlarmTimer` 120. Terrorist18 (`RaiseAlarm` 0, BeforeAttacking) is `alerting` for one frame (107) and `attacking` the next; the
   other three (`RaiseAlarm` 1) go straight to `attacking`; `AlarmUnit0` stays silent. The box is rung by a BeforeAttacking guard that takes the player as its enemy with `AlarmTimer` 0. With the
   map reloaded and the player 260 units in front of the seated Terrorist18 (stamped as rendered), it goes `seeking`, then `alerting` with `AlarmActor` `AlarmUnit0` (`FindTarget`, within
   2400), runs about 6 s to the box and `TriggerAlarm`s it: `SetAlarmFlag`, `FlagTrigger3`, `StatueAlarmTriggered`. The flag is read in this map by `TopTerroristsOverheard` (its `Alarm`
   branch) and gates `DL_lasertrigger` (which needs it false). Row 5.2.5 is restated from these lines and the driver checks both halves.
10. **Gunther's cell opens from a wall button** (`gunther-rescued`, `flags-change-world`; **resolved by work item 6**). `DeusExMover10` (Tag `temp_celldoor`, a door turning a quarter on
   `KeyRot[1]`) is opened by `DeusExMover8`, an unlocked button (`TriggerOpenTimed`, `KeyPos[1]` 8 units, Event `temp_celldoor`) beside the cell. A frob on the button opens it
   (`DeusExMover.Frob`, `Trigger(Frobber, P)`, `DeusExMover.uc:657`), and at the end of its slide it triggers the cell door (`TriggerToggle`, which has no lock test). The cell door's Event
   `guntherdoor` reaches `FlagTrigger4` (a trigger on `StatueMissionComplete` false), then `guntherfreedflag` and `FlagTrigger2`, which sets `GuntherFreed`. The census had aimed at
   `DeusExMover10`'s `Location`, its hinge pivot 170 units above the floor (`PrePivot` -48,0,96), so no approach selected it. Walked in from the button, the player crosses `AllianceTrigger0`
   (a touch trigger, Event `GuntherHermann`, Alliance `UNATCO`) and enters `GuntherRescued`'s radius (70; the conversation needs `GuntherFreed`). The conversation adds 150 skill points,
   and its `CheckObject` chain looks for the assault gun, then the stealth pistol, the pistol and the knife. With the pistol in hand, the first choice runs `TransferObject` (the pistol's
   Owner becomes Gunther), `GuntherRespectsPlayer` and the trigger `GuntherAttacks` (`OrdersTrigger0`: `RunningTo` `GuntherSpot`). `GuntherFreed` and Gunther's alliance are siblings of the same walk, not cause
   and effect: nothing fires `AllianceTrigger0`'s Tag `GuntherFreed`, and the alliance flips on the player's touch. For 5.6.6 a scan of all 140 conversations of the map (conversation flag
   lists, `ConEventCheckFlag`, `ConEventSetFlag`, choice flags, triggers) finds the other three flags read only by conversation branches. `FilbenGaveKey` is set by `MeetFilben`;
   `M01PlayerAggressive` by Mission01.Timer (`count < 23`, `Mission01.uc:90`); `KnowsShipment` by `DL_NearTop`, `TerroristsOverheard` and `MoleConvos`. They are read in `FilbenSecondBark`,
   `FilbenFinalBark` and `MeetFilben2`; `PaulCongratulations`, `MeetKaplan`, `TrooperCongratulation` and `postmissiontroopsssecure`; and `MoleConvos`. Three of those conversations fire
   OrdersTriggers (`PaulWandering`, `HarleyStartsToWander`, `BumFemaleWanders`), so they can change pawns too; which branch carries each trigger was not traced. The driver sets each flag
   from its source and leaves those conversations unplayed. The map holds 29 Terrorists and one placed `TerroristCarcass` with no killer, so `M01PlayerAggressive` needs eight kills, not six.
11. **Light against sight: a measured pair of poses** (`light-vs-sight`; **resolved by work item 6**). The Island has no `LightSwitch` and no `TriggerLight`. AugLight would confound the test:
   besides its glow (`b2`, `LightRadius` 4, brightness 220 at the player's eye, `AugLight.uc:83`), it starts a `Beam` AI event (`AugLight.uc:72`), and `CheckBeamPresence` answers any
   player Beam in view within 1,200 units with `HandleSighting` (`ScriptedPawn.uc:1991`) whatever the player's light. So the pair is the map's own lighting. `AICanSee`
   (`ScriptedPawn.uc:1887`) multiplies `64 (r²+h²)/dist²` by `AIVisibility` and subtracts `VisibilityThreshold` (0.01; [perception](script-pawn-perception.md)), and any positive result brings
   `EnemyReadiness` to 1 within 4.5 s (`CheckCycle`, `:1771`). A scan of `AIGetLightLevel` (the recovered native 700; `perceptionLighting` is never set, so Play runs the recovered body) found
   two poses 500 units in front of `Terrorist4`, 15 degrees apart, both standing on the ground with a clear `SingleLineCheck`. The dark pose is in shadow (light 0.0043, the zone ambient
   alone: every static light's trace is blocked); the lit pose reads 0.0549. Placed in the shadow for 10 s, the player leaves `EnemyReadiness` at 0. Placed in the light (the map reloaded), the
   player raises it by 0.24 a second: `seeking` at 3 s, `attacking` with the player as Enemy at 5 s. Row 5.6.3 now names this pair.
12. **The exit door of the stealth course is not a ride** (the `ElevatorMover1` part of `elevator`, row 5.3.13; **resolved by work item 6**). `ElevatorMover1` (Tag `ExitDoor`) slides 64
   units on y between two keys. `SequenceTrigger1` (Tag `CloseDoor`, SeqNum 1) and `SequenceTrigger0` (Tag `OpenDoor`, SeqNum 0) call `SetSeq`, which moves the door only when `KeyNum`
   differs (`ElevatorMover.uc:23`). It starts at 0, so `OpenDoor` alone moves nothing. Player input does reach both: `Soldier0`, seeing the player, rings an AlarmUnit, and the
   `AlarmDispatcher` sends `CloseDoor` (key 1 at 3 s). `Switch0` (Event `ButtonDispatcher`: `SoldierHostile`, `OpenDoor`, `SoldierPatrol`, `SpecialEventMsg`) brings the door back to key 0
   (`MoveTime` 1 s).

Unreached since work item 6: none. Every scenario is driven; what each does not cover is named in its row's `weak` or `need`.


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

**`cmb3`'s registry slots after tick 821: explained and fixed (2026-10-18).** 64 of `cmb3`'s 1,364 creations took another slot, from `BloodSplat46` at tick 821 on (`sound-compare-cmb3.json`
`oAdds[1277]`: the original appends slot 48490, Play reused 43708). Tick 821 is a `ULevel::CleanupDestroyed` purge in both programs. In the original's call records (seq 10424..10680) `BloodSplat46`
is created first, then 128 objects are freed: the 126 Play frees too, in the same order, and at the end two that existed at the frozen start, `NanoKeyRing4` (47461, after `WaterRing0` at seq 10676)
and `PickupDistributor0` (43708). Three inputs of the slot model differed, none of them game state:
1. The replay's `preFrees` released both objects before the tick, so Play's free list held them at tick 821's spawn.
2. Play holds its own `PickupDistributor0`, destroyed at load and pending deletion until the purge, and released it under 36046, the index `map-object-indices.mjs` gives export 4739 from an
   earlier capture of the map (in this run's dump 36046 is `ConEventEnd.ConEventEnd4793`). The objectTrace seed gave the dump's indices only to actors in `level.actors`, so a pending-deleted
   pre-placed actor kept the table's index: a general gap of the seed (found with a one-off stack trace of the release: `cleanupLevelDestroyed`, `script-level-collection.mjs` `release`).
3. `PickupDistributor0` was therefore freed twice, once by the pre-free and once by Play's purge.

The fix is in the replay's inputs only (`live-acceptance.mjs` `registrySeed`, `live-probe.mjs` objectTrace):
* The population step also lists the actors on the level's pending-deletion chain (`play-population.json` `pendingDeleted`; on the Island `NanoKeyRing2` and `PickupDistributor0`), and the
  seed walks that chain too, so a pending-deleted pre-placed actor takes this run's dump index (`PickupDistributor0` 43708; the dump has no row named `NanoKeyRing2`). A population file
  written before this change lacks the list: the replay warns and the seed falls back to the old behaviour, so the Stage 5 check (`validate-stage5-live.mjs`)
  runs `population` again first (checked from the main checkout's old file: `cmb3` at 0 slots), as row 4.3.6 does on every run.
* A pre-free whose index the seed gave an object Play holds is dropped: Play frees that object itself (`PickupDistributor0`).
* Every other pre-free carries the original's registry event right before it in the same tick (`anchor`, from the call records) and is released right after Play's model logs that event:
  `NanoKeyRing4` after the free of 47929 (`WaterRing0`). AI event objects keep their release after the event manager's Tick, and a pre-free that is its tick's first registry event is still
  released before the tick. A pre-free whose anchor never comes would be released one tick late and counted.

Play's u = 821 now holds the original's 129 registry events in order and slot (the add of 48490, then 128 frees ending 47929, 47461, 43708). The replay prints the slot model's inputs. In
`cmb3`, 1 pre-free is released at its anchor, with 0 late, 0 refused and 0 never reached. The model releases 2 slots it cannot name, and a one-off log of them named the counterparts of the
two pre-frees: Play's own landing sender event at tick 16 (created before the seed; the original's `AISenderEvent5`), and `NanoKeyRing2` at tick 821. `NanoKeyRing2` is the keyring of the
player the Player start replaced: Play's live player holds `NanoKeyRing3`, the original's `NanoKeyRing5`. The original's counterpart is `NanoKeyRing4`, renamed because the original's
session spawned more keyrings (inferred from the pending chain, not traced). `cmb1`, `cmb2` and `cmb4` count 1 such release each, by their counts the sender event (not logged by name
there). Rerun on the stored scenes: 0 of `cmb3`'s 1,364 creations take another slot, and `cmb1` (1,291), `cmb2` (1,150) and `cmb4` (1,284) stay at 0. Every actor (88 for 900 ticks),
the clock, the draws, the AI events and the creations stay equal in all four. Row 4.3.6 (strict slots, `sndm5`, its population rerun with the new list: `pendingDeleted` there is `NanoKeyRing2` alone) still passes: 103 of 103 calls and 557 of 557 registry takes equal. The Stage 5 check still judges the creations by class and tick and reports the slots: judging them
strictly is the user's decision.

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

**A spawned actor's first render stamp (fixed the same day).** `TerroristCarcass1`'s `LastRenderTime` was -10 at tick 99 in Play and 187.668228 (tick 98's time) in the original, and
equal from tick 100. The original's `DrawActorSprite` (0x10b25150) stamps the carcass in the first frame after the tick that spawned it. Play's actor mesh layer admitted a spawned mesh
actor through an asynchronous binding (`actor-mesh-sim.mjs` `admit`: `createMeshBinding` awaited the mesh resource and each group's skin), so that frame neither drew nor stamped it;
and a carcass's `Mesh2` (set by `DeusExCarcass.InitFor` after `DeathFront`) and `Mesh3` (water) were not even prepared at load. The layer now makes the binding inside the frame that
first sees the actor, before that frame's SetupDynamics and stamps, from resources prepared at load (the spawn closure prepares every mesh the live actors' properties and the
spawnable classes' defaults name), and falls back to the asynchronous path only for what is not resident ([NPC mesh inspection](npc-mesh-preview.md) "A spawned actor's first frame";
`validate-spawn-mesh-binding`: the nine Island carcass classes, each with `Mesh` and `Mesh2`, bound in their first frame). `cmb5` now passes (75 actors equal for 900 ticks), and
`cmb1` to `cmb4`, `cmb6` and `cmb7` still do; `die1` ([below](#the-players-death-to-the-levels-end-2026-10-18)), whose player carcass had the same item, now passes too.

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
1,572 creations (33 of them took another registry slot: reported, not judged; none since the cmb3 registry-slot task). Watched: the eight NSF pawns within 5,000 units, the player and
its carcass, all equal for every tick but one field: **`JCDentonMaleCarcass0`'s first `LastRenderTime`** (242.739822 at tick 731 in the original, -10 in Play, equal afterwards), `cmb5`'s
item (the actor mesh layer admitted a spawned mesh asynchronously, and the `DeathFront` carcass's `Mesh2` was not prepared at load,
[above](#second-captures-a-body-found-the-carcasss-contents-the-medkit-2026-10-18)). With that fixed, `die1` passes: 25 actors equal for all 1,931 ticks. The trace is
47 MB (155 s on the bottle). A first capture (level end after 1825) found one more difference, in the harness: with an explicit watch list the other pawns' load-time `SightCounter`
was Play's own, and a far listener's check moved the player's `ShowSelf` draw from tick 12 to tick 4. `live-acceptance.mjs` now traces the unwatched `ScriptedPawn`s with their load
fields only (`Sight`, `TRate`, `TCount`, `LRT`; watch<tag>.json `loadPawns`), which the replay writes and does not compare; the second capture's draws are equal throughout.

### Third captures: devices and weapons (2026-10-18)

The Island rows on devices and weapons, each a scene captured on the Mac under the bottle lock and replayed in Play with `validate-stage5-live.mjs` (the same check as
the combat scenes: every watched field of every watched actor per tick, the clock, the stream draws, the AI event manager's calls and callbacks, every object created by class and tick).
The scenes were designed from the original's scripts and rehearsed in Play first (`stage5-capture-rehearsal.mjs`, class P), which now stamps and prints a scene's devices.

**What the harness watches now.** `--device-watch Name:Class[@Owner.field]` (`live-acceptance.mjs`) traces a device with the Actor fields and its class's own (`DEVICE_FIELDS`: the
linked offsets and bool masks of Play's class graph for `SecurityCamera`, `AutoTurret` and its gun, `LaserTrigger`, `ControlPanel`, `AlarmUnit`, `Multitool`, decorations, `DeusExMover`,
`Robot`, and plain actors), late-watched when the scene spawns it; Play finds an actor a placed one spawned at load through its owner's field (`AutoTurret0.gun`). A scene's `flags` are
dumped at the original's end hold (`--dump-flags`) and compared with Play's FlagBase. `--player-view` adds the player's eye, bob, view shake and Energy.

| Scene | Pose and inputs | What the original did | Replay in Play |
| --- | --- | --- | --- |
| `hck1` (5.2.6) | at ControlPanel0 (1900, −895); a Multitool summoned, picked up and drawn; the Enter edge at 200 | the hack starts; HackableDevices.Timer takes hackStrength 0.1 to 0 in 0.01 steps by tick 446; HackAction UnTriggers the five LaserTriggers | **PASS**, 82 actors for 900 ticks |
| `las1` (5.2.5) | across `statue_lasertrap` (1900, −948.6) | LaserTrigger2..4 start `alarm` at tick 2: AutoTurretSmall0's AlarmHeard, Terrorist30's and (34) Terrorist2's HandleAlarm; Terrorist18 seeks with AlarmTimer > 0 and goes Alerting → Attacking (155, 156) without the box; StatueAlarmTriggered unset | **PASS**, 80 actors |
| `alm1` (5.2.5) | in Terrorist18's view south of its chair (2012, −1610) | SecurityCamera5 alarms at 259; Terrorist18, AlarmTimer 0, goes Alerting at 114 and rings AlarmUnit0 at 494; StatueAlarmTriggered set | **PASS**, 75 actors |
| `alm2` (5.2.5) | `hck1`'s hack from (1870, −860), off Terrorist18's way to the box | the MegaFutz shows Terrorist18 the player: Alerting at 202, AlarmUnit0 rung at 599; StatueAlarmTriggered set | **PASS**, 78 actors |
| `cam1` (5.2.4, 5.1.9) | 400 units in front of NSFCam02 (250, 331), facing it | SecurityCamera3 sees the player at 7 and triggers at 252 (`alarm`); AutoTurret0's AlarmHeard and Terrorist21's HandleAlarm at 252; the turret targets the player at 253 and fires 30 times from 335; SecurityBot1 fires from 310 | **FAIL**: only the blood of SecurityBot1's shots, from 310 (the open item below) |
| `cam2` (5.2.4) | 700 units in front of SecurityCamera2 (UN_CamSystem02, bNoAlarm), in range and cone | the camera swings and never tracks the player for 300 ticks | **PASS**, 75 actors |
| `ko1` (5.1.7) | a WeaponBaton taken at `cmb2`'s pose (`AllSkills`); placed 58 units behind the seated Terrorist18 at 600; the Enter edge at 630 | one swing from behind: Dying at 658, TerroristCarcass1 (bNotDead) at 736 | **PASS**, 75 actors |
| `exp1` (5.6.4) | two CrateExplosiveSmall summoned by DeusExMover5, a WeaponPistol; Enter edges at 240 to 440 | the shots miss; the second crate slides off the first (45); Terrorist2 opens the door, which crushes the first crate at 307 (`Crushed`); the blast sets off the second (312), breaks the door, destroys TrashCan5 and kills Terrorist2 | **PASS**, 79 actors, 1,634 creations |
| `emp1` (5.6.5) | 550 units west of PatrolPoint19; a WeaponEMPGrenade thrown at 200 | SecurityBot0's EMPHitPoints 100 → 69 → 34 → 0 from 418, Disabled at 423 | **PASS**, 75 actors |
| `emp2` (5.6.5) | `cam1`'s pose; a WeaponEMPGrenade thrown at 200 toward the camera | SecurityCamera3 confused at 420, AutoTurret0 at 426; the player's Energy drains 3.75 at 435, 450, 465 and 480 (the recapture) | **FAIL**: only from SecurityBot1's shot at 306 (the open item below); the camera, the turret and the drain are equal |

**What the replays found.** Each difference had an original cause, fixed in Play or in the replay's inputs:

1. **A held item's render feedback** (`hck1`). The original stamps the Multitool in the player's hand with the level clock in every render from the one after
   `ActivateBelt` (its `LastRenderTime` follows the clock while its `bHidden` is 1, set since `BecomeItem`). `Inventory.RenderOverlays` calls `Canvas.DrawActor`, which reaches
   `URender::DrawActor` (Render.dll `0x10b262c0`): it builds an `FDynamicSprite`, runs `FDynamicSprite::Setup` (`0x10b23910`: DrawType, Mesh, the centre's camera depth, the
   mesh's render bounds through `BoundVisible`) and, when Setup accepts, `DrawActorSprite`, which stamps (`0x10b25150..0x10b25161`). No `bHidden` test is on that path (it belongs
   to the world pass's admission). Play's overlay filtered `bHidden`, judged the stamp by the drawn groups' frustum test (tighter than Setup's whole-mesh bound: the rising Multitool
   was stamped 3 frames late) and bound a newly held item asynchronously. Now the overlay stamps what Setup accepts in the canvas frame (the occlusion kernel's `setup.rs` on one
   candidate with the master frame's words) and binds a held item in its first frame when its resources are resident (`createMeshBindingNow`, as the actor mesh layer admits a spawned actor).
2. **The player's frozen-phase bob** (`hck1`). The Multitool's `Location.Z` (`Owner.Location + CalcDrawOffset()`) was 4e-5 off for 102 ticks, until the player was hit. The
   capture with `--player-view` showed the cause in the replay's inputs: after the frozen phase the original's player has `BobTime` 22.69 (the frozen frames' own), which
   `WalkBob` and `CalcDrawOffset` read. The replay now writes the original's eye and bob state at the release, as it writes the animation state; the item is equal throughout.
3. **AIProcess's budget stop** (`las1`, `alm1`). AIProcess (`0x10384080`) checks its 2 ms budget only after a receiver that did work (`[ebp-0x44]`, set at `0x103842b9` once the
   receiver has a candidate sender; a destroyed receiver jumps past the check, `0x10384119 -> 0x10384470`) and leaves the loop before advancing (`0x1038449a` precedes `0x1038449f`);
   CleanupEvents then relinks `firstProcess` past destroyed receivers, and the tracer read it at the tick's exit. In `las1` at tick 139 Terrorist30's six receivers, destroyed in its
   own tick, made the record a whole lap's relink: the replay stopped after them and delivered Terrorist2's `HandleDistress` a tick late. In `alm1` at tick 361 Terrorist2's receivers
   were destroyed by its own callback, after the loop, so only AIProcess's own `firstProcess` at its return tells a whole lap from a stop. `aievent.rs` stops only right after a receiver
   that did work: exactly at the receiver new captures record at AIProcess's return (`tools/dx-live-win.c` `ecxrcv`, the capture's `aiproc` breakpoint), or at the first live receiver
   after it for an older capture. The tracer also lists the AI process ring on its frozen rows, and the replay compares Play's at the release (`ai-ring<tag>.json`).
4. **Names of actors spawned at load** (`hck1`, `cam1`). `LaserTrigger.BeginPlay` and `AutoTurret.PreBeginPlay` spawn the beams' emitters and the turrets' guns at load, so their
   numbers follow each process's session (MakeUniqueObjectName's class counter carries every load): the original's capture session loaded the Island once (`LaserEmitter0..4`,
   `AutoTurretGun0`), Play's start loads it again at the Player start (`LaserEmitter5..9`, `AutoTurretGun2`). The comparison takes these names by stem, as it takes the pawns'
   inventory (`runtimeNumbered`), and Play finds the gun through `AutoTurret0.gun`. **Weak, the user's to judge**: the cause is Play's second load at the Player start; whether the
   original's start loads the map once is not recorded here.
5. **A device's frozen-phase render stamps** (`cam1`). The original drew NSFTurret01 and its gun from the placement's view before the release (`LastRenderTime` 81.96 at tick 1);
   the replay writes that into the watched devices as it does for the pawns (`--render-history`), and their timer phase when their Timer runs from the load.
6. **processLanded's decoration footprint block** (`exp1`). The second crate lands half off the first at tick 45: the original gives it Velocity (0, −210, 52.5) and leaves it
   falling with no Base; Play based it on the first crate (and from there Terrorist2, the stream draws and the door all differed). [Landing](landing.md) "The decoration footprint
   block" had called the block read-only; its oracle never set `Hit.Actor` or SingleLineCheck's return. Disassembled (`0x103cf5f7`–`0x103d0284`): a centre probe, four corner sweeps,
   and with two or more clear corners across both diagonals a push off the edge (`numLandings` + 1, Velocity from the clear corners and the fall speed clamped to [30, 30 + R]) that
   returns without Landed or setPhysics; else a `bSlidingCarcass` Carcass slides down a slope. physFalling's PlayerPawn contact lowers the counter. Translated (`landing.mjs`, the
   hosts, `fall.rs`), and the oracle now controls each SingleLineCheck call: 853 cases, 0 mismatches; its exp1-shaped case gives the DLL's (0, −210, 52.5).
7. **A zero DrawScale** (`exp1`). The replay paused at the first explosion: `ShockRing.Tick` makes its first frame's DrawScale 0 (Tick runs before the LifeSpan decrement), and
   `lodMeshFrameMatrix` refused a zero scale. The original draws that frame: Core's FScale divides the origin by the scale (`fdiv` at `0x1011c39d`), every GetFrame point is the x87
   indefinite NaN, and DrawLodMesh's sign-bit outcodes (tables at `0x10b2abbc`) flag every point on all four planes, so no face is drawn. Play now runs the same arithmetic
   ([GetFrame](script-lodmesh-frame.md) "A zero DrawScale"; the NaN's sign and the GPU's own rejection are the unreproduced, pixel-only part).
8. **A destroyed actor's rows** (`exp1`). The original's tracer reads a watched actor's memory after the purge frees it (at 353 TrashCan5's reads a blood drop, Terrorist2's a
   splat). Every watched actor's rows now end at its UnhashObject (the capture's `unhash` records) or after its first `bDeleteMe` on either side; before, only late-watched actors'.
   Pawn rows carry no `bDeleteMe`, and Play's probe keeps a released pawn's last values, so a pawn's destruction tick is compared only through its carcass's creation (the registry).
9. **ParticleGenerator names** (`emp1`). SecurityBot0's `sparkGen` (Robot.Tick) is ParticleGenerator2 in the original and ParticleGenerator4 in Play: two generators are spawned at
   load (the original's start registry holds ParticleGenerator0/1), and Play's start loads the Island twice. Compared by stem, as finding 4 (the same **weak** judgement).
10. **The player's energy cadence** (`emp2`). `DeusExPlayer.MultiplayerTick` runs in single-player too and calls `MaintainEnergy` every 0.25 s of `lastRefreshTime`, which applies
   the EMP drain: Play's steps came 3 ticks after the original's (434, 449, … against 437, 452, …). The accumulator's phase at the release is the frozen frames' own; `--player-view`
   now traces `lastRefreshTime`, `EnergyDrain` and `EnergyDrainTotal` and writes `lastRefreshTime` at the release, as `BobTime`. In `emp2`'s recapture the steps are equal (435,
   450, 465, 480 in both).

**Open: SecurityBot1's shot and the brush tracker** (`cam1`, `emp2`). At `cam1`'s pose SecurityBot1 shoots the player from tick 310 (its `WeaponFire` event, not the turret). Every
blood drop and splat of that hit is 0.8715 units off in Play, all by the same vector, anti-parallel to the shot line (dot −0.9999998): the hit is nearer the bot. In `emp2` the same
shot (tick 334; 306 in the recapture) changes the body part, and the player's hit animation follows. Cause: ULevel::MultiLineCheck (`0x1039b220`) clips the actor segment at the world hit, which is
`Level->Model`'s LineCheck, and UPrimitive::LineCheck's hit time is `entry − 0.001` of that segment. The robot's machine gun traces `FMax(1024, MaxRange)` = 9,600 units; along its line
the static BSP's first hit is 1,801.8 units out (the original's UModel::LineCheck under Unicorn agrees on the map's BSP), and DeusExMover23's face is at 930.7. The original's
`Level->Model` holds the brush tracker's mover fragments ([brush tracker](brush-tracker.md), "Line checks" and "Open: Collision"), so its segment ends at the mover:
0.001 × (1,801.8 − 930.7) = 0.871. Play's FastLineCheck already reads the tracked model; its MultiLineCheck world check (`hash.rs` `model_line_check`, `multiline.mjs`) does not.
Not changed here: every level trace would follow, and every stored scene would need rerunning; it is the work item below.

### Third captures: the routes, the doors and the mission (2026-10-18)

**Watching what is not a pawn.** The routes are about doors, panels, arcs and the mission's own flags, which the combat scenes did not trace. The devices session's
`--device-watch Name:Class` (live-acceptance.mjs `DEVICE_FIELDS`, Play's slotOf offsets and bool masks; a summoned device bound late) is the group used here, with
the routes' classes added: `DeusExMover`'s pick in progress (`bPicking`, `pickValue`, `numPicks`, `TicksSinceLastPick`, `TicksPerPick`, `LastTickTime`, `pickPlayer`,
`TimeSinceReset`), `ElectricityEmitter`, `DamageTrigger`, `Projectile` (a rocket in flight), `Weapon` (the GEP's accuracy and lock), `Lockpick`, and `bDeleteMe` on every
device (the tick Mission01.Timer destroys a turret or a laser). `--player-talk` (DataLinkPlay, conPlay) adds player fields (`--player-view` already traces Energy), `--stop-destroyed`
adds `bDeleteMe` to the pawns: an actor both programs destroyed at the same tick is compared up to that tick, because the purge then frees its object and both sides
would read memory that is no longer its own (in `kil1` the gibbed commander's slot holds a `BloodSplat` from tick 363). A scene's named `flags` are compared at the
end (the original's FlagBase dumped at the end hold, `tools/dump-flags-win.c`, against Play's).

**Placed approaches, and how a trigger is entered.** The harness cannot hold a key, so every approach is placed; a placement typed in a hold of the scene (`MOVE`:
`ghost`, a SET of Location, `walk`, a SET of ViewRotation) runs between the same two ticks in both programs. A player placed inside a trigger's cylinder touches
nothing (item 6's lesson): to enter `DataLinkTrigger19`/`20` and `DamageTrigger1` the player is placed just above the cylinder and falls into it, so the landing's
MoveActor sweeps in and Touches. The poses that select a door, a keypad, a panel or a button were found in Play (the census's approach, or a ring of placements
whose view trace holds the target for 60 frames).

| Scene | Rows | Pose and inputs | What the original did | Replay in Play |
| --- | --- | --- | --- | --- |
| `kil1` | 5.5.5, 5.5.7 | 300 units in front of `TerroristCommander0` (outside `MeetTerrorist`'s radius 140); a GEP gun summoned, picked up and drawn; one Enter edge at 300 | the rocket gibs the commander at 318 (`TerroristCommander_Dead`); Mission01.Timer starts `DL_LeaderKilled` at 361; its event sets `StatueMissionComplete` at 481; the next Timer (541) unlocks the StatueRuinDoors and the cell door, unlocks `UN_maindoor` (opening from 542), destroys both turrets, the five lasers, the `ThugMale2`s, `SecurityBot3` and Gunther, kills every other Terrorist, brings the custody and post-mission troops into the world, moves Paul to `PaulTeleport` and silences NSFCam01..03 (`MS_MissionComplete`); the DataLink ends at 1025 | 49 actors equal for 1,100 ticks (each destroyed one up to the tick both destroy it), clock, draws, 1,691 AI events, 1,547 creations and the 5 flags at the end |
| `dor2` | 5.5.1, 5.5.2, 5.3.10 | at the back entrance two Lockpicks summoned and picked up facing away (NumCopies 2), drawn; at `DeusExMover2` the right button, then an Enter edge at 270, the right button at 530; placed at the StatueRuinDoors at 600: the right button, an Enter edge at 680, the right button at 950 | the bare right button leaves each door locked; the pick runs 271 to 516 on `DeusExMover2` (`lockStrength` 0.1 down by 0.01 a pick) and it slides open from 531; at the front the four like-tagged movers share the pick (681 to 926, the second copy spent) and open together from 951 | 79 actors (every ScriptedPawn and the five doors) equal for 1,150 ticks, clock, draws, 1,654 AI events and 991 creations |
| `dor1` | 5.3.10 | looking down at `NanoKey0` (KeyID `UNhatchdoor`): the right button at 30; placed at the satcom hatch `DeusExMover7` at 90, `ActivateBelt 0` at 150 (the key ring), an Enter edge at 220, the right button at 280; placed facing `Keypad0` at 400, the right button at 460, the keys 0 4 5 1 at 520 to 580 | the key goes onto the ring (`PickupNanoKey`, `NanoKey0` destroyed at 31); the key ring's left button unlocks the hatch at 221 (`DeusExMover.Frob`'s NanoKeyRing branch), the right button opens it at 281; the keypad window opens (its twelve `HUDKeypadButton`s), the fourth key validates 0451 and `commvan_door` (`DeusExMover21`) opens at 581 | 78 actors (every ScriptedPawn and the four devices) equal for 900 ticks, clock, draws, AI events and every creation (the keypad window's included) |
| `wat1` | 5.5.4 | in the ruins east of the arcs: a Multitool summoned, picked up, drawn; dropped from 126 units into the arcs at 200 (`DamageTrigger1`'s cylinder entered by the fall), placed back at `ControlPanel1` at 265, an Enter edge at 320; dropped into the arcs again at 650; placed at `Button2` at 750, the right button at 800 | the arcs ('Shocked' 20 a hit) take the player from 100 to 77 between 208 and 260 and the EMP floor drains Energy 0.5 every 0.25 s from 251 (`EnergyDrain`, `MultiplayerTick`'s 0.25 s step) to 98; the hack runs 321 to 566 and `UnTrigger LibElectric` turns the three emitters and the trigger off; the second drop does nothing; the fork lift rises from 801 | the recapture (with `lastRefreshTime` traced and written at the release): every watched actor equal for 1,300 ticks, clock, draws, AI events and creations (the gate's run). The first capture's replay differed only in the player's Energy, 6 ticks late (item 3 below) |
| `air1` | 5.5.3 | beside the laser trap room; placed 87 units above `DataLinkTrigger19` at 60, then 87 above `DataLinkTrigger20` in the shaft at 950 | the falling player enters the first trigger's cylinder at 64 and `DL_libertyruinsairshaft` starts (landing at 87); it ends at 890 (`DL_libertyruinsairshaft_Played`); the drop into the second trigger at 951 to 975 starts nothing (the DataLink has played); no pawn takes the player as its enemy | 77 actors (every ScriptedPawn and the three triggers) equal for 1,200 ticks, clock, draws, AI events, creations and the flag at the end |
| `fK` | 5.5.1 | the conversations batch's `fT` inputs (50 units west of Filben: six speeches skipped, "You can trust me.", two more); placed at the StatueRuinDoors at 560, `ActivateBelt 0` at 600, an Enter edge at 660, the right button at 720 | MeetFilben from 6 to 469 (`FilbenGaveKey`, Filben's `ruin_key` on the ring); the key ring unlocks the four doors at 661 (`DeusExMover.Frob`'s NanoKeyRing branch toggles the like-tagged movers) and the right button opens them at 721 | 24 actors (Filben's corner, the four doors) equal for 900 ticks, clock, draws, AI events, creations and the 4 flags at the end |
| `dor3` | 5.5.2, 5.3.10, 5.5.1 | 336 units from the back entrance: a GEP gun summoned, picked up, drawn; an Enter edge at 300 at `DeusExMover2` (`bBreakable`, `doorStrength` 0.5, `minDamageThreshold` 50); placed 300 units from the StatueRuinDoors at 500, an Enter edge at 600 at `DeusExMover12` (`bBreakable` false). The second capture also watches `Rocket0` and the 51 `Rockchip`s of its explosion | the rocket's staggered HurtRadius breaks the back entrance at 320 (`BlowItUp`: 15 `MetalFragment`s, moved up 20,000, non-colliding, `bDestroyed`); the second rocket leaves the front doors whole | **differs from tick 319**: the rocket stops 2.0 units shorter along its path in the original (13.86 of its 16.67-unit step, Play 15.86; the explosion's chips spawn 1 unit off the same +X normal in both), so the explosion, its chips' wall hits and noises, the draws and the AI events follow apart: Play's world query misses the brush tracker's fragments (item 4 below) |

`tC`, the conversations batch's capture of `MeetTerrorist`'s Curious choice (then `TerroristFollowup`, `DL_LeaderNotKilled` and Mission01's pass), is row 5.5.6's proof and
5.5.7's second route; it passes on this branch (24 actors for 1,300 ticks, 1,911 AI events, 1,523 creations, the 7 flags at the end). `fK`'s MeetFilben half is that batch's `fT`
inputs; this scene adds the doors.

**What the replays found.** Three causes, each now handled from the original's own data, and one open:

1. **A DataLink speaker's portrait is a first load** (Play fix). At tick 481 of `kil1` the original creates `Package InfoPortraits`, a `LinkerLoad`, `Texture AlexJacobson` and
   `Palette Palette50`: `HUDInfoLinkDisplay.SetSpeaker`'s `DynamicLoadObject("InfoPortraits." $ bindName)` loads the package the level had not loaded. Play's prepared route
   (`PreparedDynamicLoadGraph.load`) never told the registry model. `script-runtime.mjs` `modelPreparedDynamicLoad` now models it as the speech audio's route does
   (`loadPackage` at `CreateLinkerLoad`, `loadExport` at `CreateExport`, and the Texture's Palette, which its Preload creates), only for a package the run loaded first: the
   first version also allocated `hck1`'s `ConList_Mission01`, resident in the original. Creations of `kil1` went from 1,263 of 1,557 equal to all 1,547.
2. **A released actor's slot was reused** (harness). The conversations batch's `Released` check took the first free of each registry index; a late-bound actor (`Rocket0`,
   spawned at 300) had an earlier occupant freed at 66. Every free per index is kept now (the conversations batch's 3c2a377 carries the same rule).
3. **Two phases of the frozen period** (harness, measured inputs written at the release). `kil1`'s rocket started 7e-4 lower in Play: `ComputeProjectileStart` adds
   `CalcDrawOffset`, which reads the player's `EyeHeight` and `WalkBob`, whose smoothing ran through the original's frozen phase (the devices batch's `--player-view`). `wat1`'s
   EMP drain showed 6 ticks late: `DeusExPlayer.MultiplayerTick` (it runs in single player too) sums the tick deltas in `lastRefreshTime` and runs `MaintainEnergy` each time it
   passes 0.25 s, so its phase at the release is the frozen phase's own; `--player-view` now traces and writes it (and `EnergyDrain`, `EnergyDrainTotal`).
4. **Open, cause found: the rocket against the back entrance (`dor3`).** From tick 319 the original's rocket stops 2.0 units shorter along its path than Play's (13.86 of
   its 16.67-unit step, Play 15.86), with the same +X normal. **The cause is the moving brush tracker's fragments in `Level->Model`**, the open "Collision" item of
   [the brush tracker](brush-tracker.md#open): Play's collision world queries still read the static BSP. The chain, each step on the DLL under Unicorn with the
   segment's own values (one-off probes, not committed):
   - over the static level model the rocket's extended segment hits nothing; over the model the tracker builds at LoadMap (`GNewBrushTracker`, Play's Rust tracker,
     `validate-tracked-linecheck`'s setup) it hits `DeusExMover2`'s fragment at 0.95686, (7714.352, 757.771, -86.084), +X: the same place as the mover's own
     `UModel::LineCheck` (`native-brush-oracle.py`, which equals Play's);
   - `ULevel::MultiLineCheck` (`native-multiline-oracle.py`) given both hits applies its mover recovery (a mover hit with the world hit's normal, less than two units
     from it, is moved two units back along the trace, [fitting](fitting.md#multilinecheck-and-sorting-contract-before-translation)): the mover hit becomes 0.84972, first
     in the sorted list; without the world hit it stays at 0.95686 (Play's case). Play's `multiline.mjs` gives the same two lists;
   - `ULevel::MoveActor` (`native-move-query-oracle.py`) on the recovered list ends at (7717.16748046875, 754.951171875, -85.74213409423828), the original trace's
     `Rocket0` location at 319 to the bit (Play's `moveQuery` agrees on the same list).

   Ruled out on the way: the rocket's extent (`CollisionRadius`/`CollisionHeight` 0), its script (nothing moves it after a hit), another brush (of the map's 1,434 brush
   actors only `DeusExMover2` lies on the segment), MoveActor's own pull-back (one 2-unit pull-back in both). The fix is Play's: MoveActor's world query (and the other
   collision traces) must read the tracked `Level->Model` while the tracker lives; extent queries need the extent branch over the tracked nodes, which Play does not
   have yet. Rows 5.5.2 (the break), 5.3.10 (the breakable door) and 5.5.1 (the unbreakable front doors: the scene's second rocket meets the StatueRuinDoors'
   fragments the same way, not yet checked) wait on it.

**The bottle.** Three batches shared it this evening; a batch that releases the lock and re-takes it in the same instant never lets another in. The routes' queue releases it
for 15 s between scenes.

**Branches.** This branch has the devices batch merged through 7608261 (6198e64, 588f1cb) and the conversations batch merged through afe6e85 (1b25618), plus its 2ea38c3 (AICanSee's skipped
arguments), 622696f and 3c2a377 cherry-picked; not d3074f8, whose AIProcess stop rule conflicts in `aievent.rs` with the devices batch's 7608261 (those two batches reconcile
it). `kil1`, `dor2` and `tC` were rerun after the AICanSee fix and pass.

## Scoreboard (2026-10-18, after the third captures)

`node scripts/validate-stage5-acceptance.mjs --report .work/stage5-gate-2026-10-18-devices.json` with a fresh census of this branch (the Mac, 21:14 to 21:54: the census 50 plays, 0
pause, 0 no-effect, 0 undriven; the 18 proof scenes each replayed once): **10 of 50 criteria pass; the gate is red** (exit 1). 55 rows, 5 excluded. Every row was rerun on this code.
History: the first run (master 5d7285c, with the three tightened predicates) was 0 PASS, 14 FAIL, 33 MISSING, 3 UNDRIVEN. The Island devices task moved 5.2.6, 5.3.9, 5.5.1 and 5.5.2 from FAIL to
MISSING. The death, explosives and alarms task moved 5.1.2, 5.1.4, 5.1.5, 5.2.7, 5.6.2 and 5.6.5. That left 0 PASS, 4 FAIL, 43 MISSING, 3 UNDRIVEN. The first combat captures moved
5.2.2 from FAIL to PASS and 5.1.6 from MISSING to PASS (2 PASS, 3 FAIL, 42 MISSING). The second moved 5.6.1 from MISSING to PASS, and 5.1.5 and 5.2.7 from MISSING to FAIL: their proof,
`cmb5`, differed in one field at one tick (the carcass's first render stamp, [above](#second-captures-a-body-found-the-carcasss-contents-the-medkit-2026-10-18)).
The death capture (`die1`) moved 5.1.8 from MISSING to FAIL on the same item, its player carcass's first stamp ([above](#the-players-death-to-the-levels-end-2026-10-18)):
3 PASS, 6 FAIL, 38 MISSING, 3 UNDRIVEN (report `.work/stage5-gate-2026-10-18-518.json`). The undriven-scenarios task (item 6 below) made every scenario play, which moves the three
no-effect rows (5.2.5, 5.4.8, 5.5.5) and the three undriven ones (5.4.5, 5.6.3, 5.6.6) to MISSING; the mesh layer's fix moved 5.1.5, 5.2.7 and 5.1.8 from FAIL to PASS (6 PASS, 44 MISSING,
report `.work/stage5-gate-2026-10-18-mesh.json`). The third captures ([above](#third-captures-devices-and-weapons-2026-10-18)) moved 5.1.7, 5.2.5, 5.2.6 and 5.6.4 from MISSING to PASS
and 5.1.9, 5.2.4 and 5.6.5 from MISSING to FAIL.

| Clause | PASS | FAIL | MISSING | UNDRIVEN | EXCLUDED |
| --- | ---: | ---: | ---: | ---: | ---: |
| 5.1 Combat | 4 | 1 | 4 | 0 | 0 |
| 5.2 Stealth | 4 | 1 | 2 | 0 | 0 |
| 5.3 Exploration and the character systems | 0 | 0 | 13 | 0 | 0 |
| 5.4 Conversation | 0 | 0 | 8 | 0 | 0 |
| 5.5 Alternate-route objectives | 0 | 0 | 7 | 0 | 0 |
| 5.6 Systems interacting | 2 | 1 | 3 | 0 | 0 |
| 5.7 Excluded | 0 | 0 | 0 | 0 | 5 |
| **Total** | **10** | **3** | **37** | **0** | **5** |

The ten `PASS` rows have proof checks on stored Island scenes: 5.2.2 on `cmb1` and `cmb2`, 5.1.6 on `cmb1` to `cmb4`, `cmb6` and `cmb7`, 5.1.5 on `cmb1`, `cmb2` and `cmb5`,
5.2.7 on `cmb5`, 5.6.1 on `cmb7`, 5.1.8 on `die1`, 5.1.7 on `ko1`, 5.2.5 on `las1`, `alm1` and `alm2`, 5.2.6 on `hck1`, 5.6.4 on `exp1`. The three `FAIL` rows share one cause, named in
their `need`: 5.1.9 and 5.2.4 on `cam1` (and `cam2`, which passes) and 5.6.5 on `emp2` (and `emp1`, which passes) differ only from SecurityBot1's shot at the player, whose
hit Play places by the static BSP where the original's `Level->Model` holds the brush tracker's mover fragments (work item 8 below). The 37 `MISSING` rows play in the census and name the
capture that would prove them. Stage 4's gate started at 44 of 70 because 60 checks against stored
originals already existed; for gameplay they did not. The strongest existing evidence is listed per row under "Existing, partial": the Island combat scenes, the Underworld's
weapon-noise traces for gunshots, the perception pilot, the first-person crowbar, MeetPaul's frames, and the native oracles for swimming, ladders, falling and movers.

**Checks rerun for the third captures' Play changes** (2026-10-18, the Mac; the decoration footprint block, the zero-scale GetFrame, physFalling's PlayerPawn count with the
rebuilt Rust kernel): the 18 Island scenes in the gate run above (`cmb1` to `cmb7`, `die1` and the ten new ones: all but `cam1` and `emp2` pass); `validate-native-landing` (853
cases), `-native-falling`, `-native-actor-physics`, `-actor-physics-kernel`, `-island-falling-water`, `-decoration-settle-roll`, `-plant-push`, `-script-decoration`,
`-crowbar-crate`, `-pawn-carcass`; the unit tests (652). The comparison's new row end was also checked by re-judging the eight earlier scenes' stored replays (`--compare-only`): all
pass. Not rerun: the Stage 4 rows that replay live traces and the `bench-sim` digests (Play against Play).

**Checks rerun for the mesh layer's fix** (2026-10-18, the Mac): the eight Island scenes (`cmb1` to `cmb7`, `die1`) pass, as do the six Stage 4 rows that replay live traces
(4.1.5, 4.1.6, 4.1.7, 4.2.13, 4.3.6, 4.5.5), the unit tests (652), `validate-spawn-mesh-binding` (new) and the validators over the mesh layer and the texture store it shares
(`validate-actor-mesh-scene`, `-npc-mesh-preview`, `-sprite-setup`, `-fire-texture-rust`, `-viewer`, `-item-pickup`, `-crowbar-crate`).

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
   Seven scenes on Island and `die1`, and `validate-stage5-live.mjs` is the proof check. 5.2.2, 5.1.6, 5.6.1, 5.1.5, 5.2.7 and 5.1.8 pass (the last three since the carcass's first
   render stamp was fixed in the actor mesh layer, 2026-10-18). Still open, named in its row's `need`: footsteps (5.2.3).
5. **Pain zones and the HazMat suit** (finding 5): the zone's `DamagePerSec` over time and the suit's absorption, against a capture of Training's pool. Unblocks 5.3.7, 5.6.x radiation.
6. ~~**The undriven scenarios**~~ **Done 2026-10-18** (findings 8 to 12): all six were driver faults or a misread row, none a Play gap. The cell door and Gunther (5.4.5, 5.6.6) open
   from the wall button. The lit/dark pair (5.6.3) is two measured poses in front of `Terrorist4`. `M00MeetPage` (5.4.8) is walked into, and holo-Jaime is driven too. The commander (5.5.5) is
   shot from outside his conversation radius. The `ElevatorMover1` "ride" (5.3.13) is the exit door, closed by the alarm and reopened by `Switch0`. The laser (5.2.5) row is restated
   from the original's `AlarmTimer` rule. The census now plays all 50 scenarios.
7. **Proof captures, by clause value**: conversation branches (5.4.3 to 5.4.6: choices, transfers, flags; the harness types Enter and Down as key edges), weapons and damage (5.1.1 to 5.1.3),
   Training's lessons one capture each (5.3.1 to 5.3.4), and O3 comparisons for the native-body rows (5.3.5, 5.3.6, 5.3.2). The third captures gave 5.1.7, 5.1.9, 5.2.4, 5.2.5, 5.2.6, 5.6.4 and
   5.6.5 their scenes ([devices](#third-captures-devices-and-weapons-2026-10-18)) and captured the routes (5.5, [routes](#third-captures-the-routes-the-doors-and-the-mission-2026-10-18)). The
   census plays every scenario, and items 2, 5 and 8 still bound what the rows they name can show.
8. **Collision and level traces over the brush tracker's `Level->Model`** ([brush tracker](brush-tracker.md#open), "Collision"): Play's MoveActor, MultiLineCheck's world check and with it
   SingleLineCheck, Trace and the AI and decal traces read the static BSP, while the original's level model holds every mover's fragments (FastLineCheck already reads them). So a trace that
   meets a mover also hits the world there, and MultiLineCheck's mover recovery moves the mover hit two units back. Proven bit-exact for `dor3`'s rocket (routes, item 4) and measured on
   SecurityBot1's shot (`cam1`, `emp2`, devices). Needs an oracle over a tracked model and every stored scene near a mover replayed after it. Unblocks 5.1.9 and 5.2.4 (`cam1`), 5.6.5
   (`emp2`), 5.3.10, 5.5.1 and 5.5.2 (`dor3`).
9. **Shooting the turret down** (5.1.9's second half) has no capture: an untrained pistol misses AutoTurretGun0 from 340 units, and the turret and SecurityBot1 kill the player first.

## What the user should decide

* **The list itself**: 50 scenarios, Training meaning all three maps, Island with its five ways in, one row for the whole of Training's phase 1, placed approaches instead of walks. Weak choices are labelled `weak`
  in `scripts/stage5-criteria.mjs` and in the tables above.
* **Rows restated by work item 6** (findings 9 to 12), each from original script lines. 5.2.5: the beam makes the guards who hear it attack with `AlarmTimer` 120, and `AlarmUnit0` is rung by a
  guard who saw the player. 5.3.13: the exit door instead of a ride. 5.4.5: the wall button. 5.6.3: a measured pair under the map's lighting instead of AugLight or a light switch (the
  Island has no switch, and AugLight adds the `Beam` path). 5.6.6 is restated (the alliance flips on a touch, not from the flag) and labelled `weak`: the conversations that read the other three flags are not played.
* **O3 or O2 as enough for native-body rows** (ladder, crate physics, swimming, falling, movers): the doc defaults to O3 (the DLL's code on Play's inputs in the scene), which does not exist yet for any of them.
* **Cross-map evidence for shared code**: the gunshot half of 5.2.3 now has an Island capture (`cmb2`); its footsteps half can have no live trace (a held key), so the choice is O3 on Play's footstep inputs or accepting the row without footsteps.
* **Where a player's death stops** (item 2): implemented as the original's client travel, where its level ends; whether the load menu after it belongs to Stage 5 or 6 is still open.
* **The third captures' judgements** (labelled `weak` in their rows): actors spawned at load by a placed actor (LaserEmitter, AutoTurretGun, ParticleGenerator) compared by name
  stem, because Play's start loads the Island twice and the original's capture session once (whether the original's own start loads it once is not recorded); `ko1`'s Low-Tech skill
  from the `AllSkills` cheat (untrained, the baton's second swing lands after the Terrorist has left); 5.6.4's explosion set off by the door Terrorist2 opens (`Crushed`), the
  player's shots having missed; 5.1.9's and 5.2.4's restatements from the original scripts (the cameras trigger no Event: an `Alarm` AI event wakes the turret).
* **The routes' placed approaches** (5.5.3, 5.5.4): the airshaft row passes without its third trigger (a crawlspace a standing player cannot be dropped into) and the water row without the swim (a held key); both are labelled `weak`. Accept them, or require O3 for the crouch and the swim.
* **Priority**: items 1, 3 and 6 are done, and item 4 has its comparisons: the NPC-versus-player scenes replay equal. The largest open group is now item 7's captures (one per row, about 15 minutes on the bottle each, plus a replay); item 8 is the one Play fix three captured rows wait on.

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
node scripts/validate-stage5-live.mjs --scene cmb1                       # a proof check: a stored Island scene (cmb1..cmb7, die1, hck1, las1, alm1, alm2, cam1, cam2, ko1, exp1, emp1, emp2) replayed in Play (SKIP without the store; waits while another checkout replays the map)
node scripts/validate-stage5-live.mjs --scene cmb1 --print-capture       # the original's capture command of that scene (writes its tracer config; the bottle lock first)
node scripts/validate-stage5-live.mjs --scene cmb1 --compare-only        # judge the stored replay again after a change to the comparison alone (not after a Play change)
node scripts/stage5-capture-rehearsal.mjs --scene cmb1                    # rehearse a scene's input list in Play, headless, before a capture (class P)
```
