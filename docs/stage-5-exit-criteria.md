# Stage 5 exit criteria: a finite definition of "Done when"

Status: **draft for the user to adopt** (written 2026-10-17 from master 5d7285c; first census and scoreboard: 0 of 50 criteria pass; after the first original captures, the same evening: 2 of 50; on 2026-10-18 after the second captures and a spawned actor's first frame: 6 of 50; after the routes' captures, the same evening: 13 of 50; 21 of 50 on 2026-10-19; 23 of 50 after work item 8 on 2026-10-20; 24 of 50 after work item 16 the same day; 27 of 50, none failing, after work item 15; 30 of 50 after the first Linux captures; 32 of 50 with the first O3 proofs; 37 of 50 with the 00_Training captures; 41 of 50 with 00_TrainingFinal's; 46 of 50 with 00_TrainingCombat's; 47 of 50 with Training phase 1's; 49 of 50 with the bots' and the terminals' windows). Nothing here is a Stage 5 claim; it is the definition the claims will be
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
| 5.1.1 | 00_Training crates | the crowbar breaks a Cratepick crate: swing, damage, fragments, contents, the Mission00 timer starts DL_Lockpick | O1 | `crowbar-crate` |  | validate-stage5-live cbr1 (O1 2026-10-20, the Linux host, PASS: a WeaponCrowbar summoned, picked up and drawn at 130; the player 70 units north of CrateBreakableMedGeneral1 under CrateBreakableMedGeneral2 (Tags Cratepick1/2); Enter edges every 60 ticks: the upper crate HitPoints 10 -> 4 at 222, destroyed at 282 (6 WoodFragments and its Lockpick), the lower one 10 -> 4 at 342 and destroyed at 399 (the same); with one crate left Mission00.Timer starts DL_Lockpick at 301 (DataLinkPlay, the InfoLink display) and sets MS_CratesBroken; 21 actors and every creation equal for 900 ticks); validate-crowbar-crate (P); validate-weapon-view-original (4.1.10 O1: the swing's draws); script-crate-destruction.md | PASS |
| 5.1.2 | 00_TrainingCombat pistol range | take a pistol and Ammo10mm, walk in (DL_TArgetRange opens the cover over Switch3), press Switch3 (the target DeusExMover4 with BreakableGlass0 slides in; its MoverCollider passes the DirectionalTriggers that open the blast door), shoot the glass through the station window: ammo, recoil, trace hit, target and trigger state, DL_TArgetRangeshot1/2 | O1 | `pistol-range` |  | validate-stage5-live rng2 (O1 2026-10-20: rng1 plus the second lane; a second Ammo10mm box (Ammo10mm1) taken at 1000, the aim set again before every Enter edge (the recoil lifts the view 150 units a shot: rng2's first capture aimed once, hit three times in six and never broke the glass, so DL_TArgetRangeShot1 never played and lane 2 stayed shut); DL_TArgetRangeShot1's last event opens the cover DeusExMover28 over Switch13 at 2692; dropped at the second station at 2950, the right button at Switch13 (3010) slides the target DeusExMover5 with BreakableGlass1 in to y -1792; four hits break the glass (3271 to 3451: 0.5, 0.34, 0.18, 0.02, bDestroyed) and DL_TArgetRangeShot2 plays 3451 to 3832; Play equal for 4100 ticks, 23 actors, 4294 AI events, 413 creations, the 3 DataLink flags); validate-stage5-live rng1 (O1 2026-10-20, Linux host: dropped into DataLinkTrigger2 at the weapon counter, DL_TArgetRange plays from tick 8 to 934 and its last event opens the counter cover DeusExMover44 and the cover DeusExMover1 over Switch3 together (846, sliding to 906); WeaponPistol0 taken at 936 and the Ammo10mm0 box at 976 (destroyed into the pistol's stack), the pistol drawn at 1011 (Pickup, Idle2, Active, Idle); the right button at Switch3 (1121) slides the target DeusExMover4 with BreakableGlass0 from y -3280 to -1216 (240 ticks) and its MoverCollider passes the DirectionalTriggers that open the blast door DeusExMover7 (1139 to 1199); six Enter edges 60 ticks apart: ClipCount 1 to 6, NormalFire for 36 ticks each, the glass at 0.5, 0.34, 0.18, 0.02 and broken at the fourth hit (1581: bDestroyed, moved up 20,000), DL_TArgetRangeShot1 plays from 1581 to 2780 (its played flag at the end), the empty clip reloads at 1718 to 1900; Play equal for 2800 ticks, every pawn, AI event and 207 creations); weapon noise O1 in the Underworld (pistol shots' event traffic) | PASS |
| 5.1.3 | 00_TrainingCombat rifle range | take the rifle and Ammo3006, scope on, shoot: scope FOV, accuracy, hit; DL_RifleRangeShot1 sets SkillWeaponRifle to 3 | O1 | `rifle-scope` |  | validate-stage5-live rif1 (O1 2026-10-20, Linux host: dropped into DataLinkTrigger8 at the rifle counter, DL_RifleRange plays 8 to 850 and opens the counter cover DeusExMover67 and the cover DeusExMover29 over Switch0 at 762; WeaponRifle2 taken at 851 and the box Ammo0 after it, the rifle drawn at 931 (Active, Idle 953); the right button at Switch0 (1020) slides the target DeusExMover32 with BreakableGlass2 in and opens the blast door DeusExMover21 (1037); ToggleScope at 1310 sets bZoomed, DesiredFOV 75 to ScopeFOV 10 and FOVAngle 75, 68, 61, 54, 47, 40, 33, 26, 10 in eight ticks (1311 to 1318); the Enter edge at 1380 fires (ClipCount 1, NormalFire 90 ticks) and the one hit breaks the glass (doorStrength 0.25 to 0, bDestroyed) at 1381, DL_RifleRangeShot1 plays 1381 to 2049 and Mission00.Timer sets SkillWeaponRifle.CurrentLevel 0 to 3 at 1981; the second edge (1520) fires again; Play equal for 2150 ticks, every pawn, AI event, 158 creations, both flags at the end and the skill) | PASS |
| 5.1.4 | 00_TrainingCombat demolitions | place a LAM on BreakableWall1 (WeaponLAM.Fire's Place path near a Mover; a thrown LAM bounces off), shoot it (ThrownProjectile.TakeDamage): it explodes (HurtRadius), the wall breaks (BlowItUp), DL_FinishWall follows | O1 | `lam-wall` |  | validate-stage5-live lam1 (O1 2026-10-20, Linux host: a WeaponLAM and a pistol summoned and picked up facing away from BreakableWall1, the LAM drawn at 161; dropped 32 units from the wall (bNearWall from WeaponLAM.Tick's NearWallCheck) the Enter edge at 260 runs WeaponLAM.Fire's Place path (NormalFire, the Place animation): LAM5 appears stuck on the wall at (3000, 1829.5, -8.3) at 285 and the spent weapon destroys itself in AnimEnd at 304; the pistol drawn at 401, its third edge (600) hits the LAM: ThrownProjectile.TakeDamage explodes it at 601 (Exploding), HurtRadius breaks BreakableWall1 the same tick (doorStrength 0.4 to 0, bDestroyed, moved up 20,000, no collision), the player 150 units off is hurt at 606 (torso 100 to 10, Health 77) and DL_FinishWall plays from 601 to 1649; Play equal for 1700 ticks, every pawn, AI event and 363 creations (the wall's fragments, the explosion's effects)); alterations census (grenade throws play, P); validate-island-blowitup (mover BlowItUp O2) | PASS |
| 5.1.5 | 01_NYC_UNATCOIsland | the player's pistol hurts and kills a standing Terrorist: damage, hit reaction, hostile response, death, carcass and its inventory | O1 | `island-shoot-npc` | O1: live trace of the original (pistol summoned and drawn, Fire edges at a Terrorist in view) with the pawn's Health, state, Orders, Enemy and the carcass | validate-stage5-live cmb7 (O1: the second pistol shot kills Terrorist0 at 360; its carcass created at the original's tick); weapon noise O1 (the NPCs' event handlers for a player's shots in the Underworld); carcass memory natives 2108/2109 (O2) | PASS |
| 5.1.6 | 01_NYC_UNATCOIsland | a hostile Terrorist attacks the player: it aims and fires (Tracer, physProjectile), the player's Health, armor and hit regions change, the AI keeps attacking or takes cover | O1 | `island-npc-shoots-player` | O1: live trace of the original with a visible, hostile-allied player in an NPC's view and the NPC's state, fire, projectile and the player's damage per tick | validate-island-tracer (tracer flight, P); validate-native-projectile (O2) | PASS |
| 5.1.7 | 01_NYC_UNATCOIsland | a baton or crowbar knocks a Terrorist out: KnockedOut carcass, "Unconscious", and Mission01.Timer's aggression count | O1 | `island-melee-ko` | O1: live trace of the original (WeaponBaton drawn, Fire edge at a Terrorist) with the pawn's state, the carcass and its itemName | validate-stage5-live ko1 (O1 2026-10-18: one baton swing from behind at the seated Terrorist18 takes it to Dying, Health -1, at tick 658; TerroristCarcass1 at 736 with bNotDead 1, KillerAlliance Player and the pistol, ammo and knife it carried; every pawn, the player and the carcass compared per tick) | PASS |
| 5.1.8 | 01_NYC_UNATCOIsland | player death: lethal damage reaches Dying, the death state and view; the game does not continue the level | O1 | `island-death` | O1: live trace of the original from lethal damage to the level's end (the Dying player's OPEN DXONLY, browsed at the next engine tick); Play stops at the same tick (the screen after it is Stage 6's load menu) | validate-stage5-live cmb3 (O1: the Terrorists' fire kills the player at tick 863, HealthTorso -4, Dying and DeathFront; Play equal through Dying to tick 900); validate-console-command (OPEN: SetClientTravel stores the URL and runs PreTravel; the client travel step ends the level) | PASS |
| 5.1.9 | 01_NYC_UNATCOIsland AutoTurret | NSFTurret01 (bActive false, bTrackPlayersOnly) wakes on an NSF camera's 'Alarm' AI event (AutoTurret.AlarmHeard: the cameras trigger no Event; libertyturret1 is their UnTriggerEvent, a hacked camera turning the turret off), aims AutoTurretGun0 and fires at the player (AutoTurret.Fire: a Trace, gunDamage 5); the player can shoot it down (AutoTurretGun HitPoints 50, its Destroyed destroys the turret) | O1 | `island-turret` | cam1 passes since work item 8 (2026-10-20: Play's collision queries read the tracked Level->Model, so SecurityBot1's shot meets DeusExMover23's fragments as in the original). Not captured: shooting the turret down (AutoTurretGun HitPoints 50; rehearsed: an untrained pistol misses the gun from 340 units and the turret and SecurityBot1 kill the player first) | validate-stage5-live cam1 (O1 2026-10-18: SecurityCamera3 sees the player at tick 7 and starts its 'alarm' AI event at 252; AutoTurret0's AlarmHeard runs at 252, it takes the player as curTarget at 253, aims AutoTurretGun0 and fires 30 times from 335; the turret, its gun, the camera, every pawn and the player equal per tick); validate-island-tracer | PASS |

### 5.2 Stealth

| Id | Scene | Scenario | Ev. | Census | Proof that would pass it | Existing, partial | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5.2.1 | 00_TrainingFinal stealth maze | walk in and out of the soldiers' sight: patrols, AllianceTrigger hostile/neutral, AlarmUnit, DL_FailedStealth, the reset | O1 | `stealth-maze` |  | validate-stage5-live stl1 (O1 2026-10-20, the Linux host, PASS: the player placed 180 units from Soldier0 in its view; Soldier0 seeks at 18, goes Alerting at 34 (Enemy the player), runs to an AlarmUnit and trips it at 221 (the four units of Tag StealthMazeAlarmUnit, Dispatcher1 dispatching); both soldiers' Alliance level toward the Player goes from -1 to 1 at 222 (AllianceTrigger0 and 2, SoldierNeutral) and Soldier0 returns to Patrolling at 223; the units stop at 820; DL_FailedStealth_Played is set. Switch0 at 961 (ButtonDispatcher) takes the level back to -1 at 962 and Soldier0 sees the player on the platform again (Seeking 981, Alerting 1001) and trips the alarm a second time at 1122; every watched actor, the clock, the stream, the 1,327 AI event manager calls and the 177 created objects equal for 1,250 ticks) | PASS |
| 5.2.2 | 01_NYC_UNATCOIsland | a visible player in the open: a patrolling Terrorist sees it (AICanSee, SightCounter, CycleCumulative), turns, calls the alert; a hidden player is not seen | O1 | `island-sight` | O1: live trace of the original (no ghost, player standing at a measured pose in a patrol's view and out of it) with the perception fields of the Perception pilot | perception pilot O1 in the Underworld (civilians flee a visible mj12-allied player); validate-pawn-perception / AICanSee x87 (O2) | PASS |
| 5.2.3 | 01_NYC_UNATCOIsland | the player's noise reaches the guards: gunshots (WeaponFire, LoudNoise), the HandleShot/HandleLoudNoise callbacks; footsteps by speed and floor | O1 | `island-hearing` | footsteps (a held key the harness cannot post: O3 on Play's footstep inputs); the gunshot half has an Island O1 (cmb2) | validate-stage5-live cmb2 (O1 on Island: an unseen player's two pistol shots, every AI event manager call equal, the three NSF pawns woken); live-events-compare O1: 1,069 and 1,586 manager calls equal in the Underworld (pistol, assault shotgun) | MISSING |
| 5.2.4 | 01_NYC_UNATCOIsland cameras | SecurityCamera sees the player: CheckPlayerVisibility every 0.1 s (cameraRange 1024, cameraFOV 4096 of its swinging Rotation), it tracks him and after triggerDelay (4 s) TriggerEvent(True) sounds its own Klaxon2 and starts an 'Alarm' AI event (it triggers no Event: NSFCam01..03's libertyturret1 is their UnTriggerEvent), which wakes NSFTurret01 (AlarmHeard) and the guards that hear it (HandleAlarm); UN_CamSystem01..04 (bNoAlarm) never check the player | O1 | `island-camera` |  | validate-stage5-live cam1 (O1 2026-10-18: NSFCam02 = SecurityCamera3 sees the player 400 units in front of it at tick 7 (bTrackPlayer, bPlayerSeen), triggers after triggerDelay at 252 (bEventTriggered) and starts 'alarm': AutoTurret0's AlarmHeard and Terrorist21's HandleAlarm run at 252); validate-stage5-live cam2 (O1 2026-10-18, PASS: SecurityCamera2, UN_CamSystem02 with bNoAlarm, swings for 300 ticks with the player 700 units in front of it, inside its range and cone, and never tracks him) | PASS |
| 5.2.5 | 01_NYC_UNATCOIsland laser trap | a LaserTrigger beam broken by the player raises the alarm (LaserTrigger.BeginAlarm: Klaxon2 and an 'Alarm' AI event; the laser has no Event): the guards that hear it handle it (HandleAlarm: AlarmTimer 120, seek, attack), and AlarmTimer > 0 keeps them from the alarm box (Alerting: Alert -> Done -> Attacking); AlarmUnit0 (SetAlarmFlag -> FlagTrigger3 -> StatueAlarmTriggered) is rung by a RaiseAlarm BeforeAttacking guard that takes the player as its enemy with AlarmTimer 0 (Terrorist18 seeing him) | O1 | `island-laser` | O1: live trace of the original with the player placed across statue_lasertrap (the guards' AlarmTimer and states, the klaxon) and, separately, in Terrorist18's view (its run to AlarmUnit0 and the flag) | validate-stage5-live las1 (O1 2026-10-18: the player placed across the beams; LaserTrigger2..4 start 'alarm' at tick 2, AutoTurretSmall0's AlarmHeard and Terrorist30's and Terrorist2's HandleAlarm follow; Terrorist18 seeks with AlarmTimer > 0 and goes Alerting -> Attacking at 155-156 without the box; StatueAlarmTriggered stays unset); validate-stage5-live alm1 (O1: the player in Terrorist18's view south of its chair; NSFCam (SecurityCamera5) also alarms at 259; Terrorist18, AlarmTimer 0, seeks, goes Alerting at 114, rings AlarmUnit0 at 494 (its 'alarm', bActive) and StatueAlarmTriggered is set); validate-stage5-live alm2 (O1: hck1's hack from off Terrorist18's way: the MegaFutz shows it the player, it goes Alerting at 202 and rings AlarmUnit0 at 599; StatueAlarmTriggered set) | PASS |
| 5.2.6 | 01_NYC_UNATCOIsland laser trap | hacking ControlPanel0 with a multitool switches statue_lasertrap off: hack time (skill, hackStrength), the multitool's use, the lasers' state | O1 | `island-hack-panel` | O1: live trace of the original (Multitool selected, a left-button click on the panel: ParseLeftClick, never the right button) with the hack progress, multitool charge and laser state per tick | validate-stage5-live hck1 (O1 2026-10-18: the Multitool summoned, picked up and drawn, the Enter edge at 200 starts the hack, HackableDevices.Timer takes hackStrength 0.1 to 0 in 0.01 steps by tick 446, HackAction UnTriggers the five LaserTriggers; the panel, the lasers, AlarmUnit0, the Multitool and every pawn compared per tick) | PASS |
| 5.2.7 | 01_NYC_UNATCOIsland | a pawn reacts to a body: a killed or knocked-out Terrorist is seen (CheckCarcassPresence, HaveSeenCarcass, AddCarcass) and the finder investigates or flees | O1 | `island-carcass` | O1: live trace of the original with a carcass in a patrol's view | validate-pawn-carcass (natives 2108/2109, O2); validate-stage5-live cmb1 (O1: the attacking Terrorists find TerroristCarcass1, CarcassTimer 120, and stay in Attacking) | PASS |

### 5.3 Exploration and the character systems

| Id | Scene | Scenario | Ev. | Census | Proof that would pass it | Existing, partial | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5.3.1 | 00_Training phase 1 | PlayerStart to DL_part2 by the player's own inputs: doors, NanoKey and key ring, crowbar and crates, lockpicking gundoor, datacube and keypad 0012, multitool hack of Keypad2, the cadet's body to the table, the dark room, the repair bot | O1 | `phase1-route` |  | validate-stage5-live key1 (O1 2026-10-20, the Linux host, PASS: the player 110 units west of the start door DeusExMover16/17 (unlocked): the right button at 30 opens both panels (KeyNum 1 at 31, sliding until 151); placed at NanoKey0 (415, 1072, -145), FrobTarget at 203, the right button at 240 destroys it and gives the key ring its Train key (PickupNanoKey: NanoKeyInfo0 created, a DeusExLog); placed at the trainer door DeusExMover47/48 (KeyIDNeeded Train, locked, not pickable, lockStrength 1): the key ring (belt slot 0) in hand at 341, the Enter edge at 400 toggles bLocked 1 -> 0 on both panels at 401 (DeusExMover.Frob's NanoKeyRing branch), the right button at 460 opens them (KeyNum 1 at 461); 24 actors, 587 AI events and 43 creations equal for 560 ticks); validate-stage5-live pik1 (O1 2026-10-20, PASS: the bare right button at 10 leaves the gun door (DeusExMover45/46, Tag gundoor, locked, pickable, lockStrength 0.05) locked; a summoned Lockpick picked up at 90 and in hand at 131; the Enter edge at 210 starts the pick on the frobbed panel DeusExMover46 (bPicking at 211, pickValue 0.1 untrained, numPicks 10, TicksPerPick 4, curPick Lockpick0, pickPlayer the player); lockStrength falls 0.05 -> 0.04 at 240, 0.03 at 264, 0.02 at 288, 0.01 at 312 and 0 at 336, one 0.01 every 24 ticks (TicksSinceLastPick counts 1 to 4 between the Timer's 0.1 s steps), where both panels unlock and the Lockpick is used up (NumCopies 0); the right button at 700 opens the pair (KeyNum 1 at 701); 22 actors, 822 AI events and 40 creations equal for 800 ticks); validate-stage5-live kpd1 (O1 2026-10-20, PASS: DataCube0 (1496, 860, -147) in view; the right button at 30 sets its infoWindow (the HUD's HUDInformationDisplay) and aReader at 31 and creates the parser, the seven paragraph TextWindows, the DataVault note and a DeusExLog; the second right button at 90 clears both at 91; placed at Keypad0 (1998, 940, -55, validCode 0012), the right button at 200 opens HUDKeypadWindow and the Digit0, Digit0, Digit1, Digit2 key edges at 240, 260, 280 and 300 (VirtualKeyPressed) validate the code at the fourth: the paddoor pair DeusExMover26/18 (locked, Event paddoor) is triggered open at 301 (KeyNum 1, bLocked still 1) and stops sliding at 421; 23 actors, 541 AI events and 159 creations equal for 520 ticks. It found that OpenText's StaticLoadObject(XExtString) loads Extension:XExtString from its package at the first text, 21 member objects after the replaced placeholder class, and creates the text object ExtString 00_Datacube01, which OpenText deletes at once; Play created none of them (registry model: original-object-index.mjs loadNativeClass, docs/script-text-parser.md); validate-stage5-live hkp1 (O1 2026-10-20, PASS: Multitool1 (2241, 600, -147) picked up with the right button at 40, in hand at 81; placed at Keypad2 (2558, 940, -55, Event hackdoor, hackStrength 0.05), the Enter edge at 181 starts the hack (bHacking, numHacks 10, hackValue 0.1, TicksPerHack 4, the Multitool bBeingUsed); hackStrength 0.05 -> 0.04 at 204, 0.03 at 228, 0.02 at 258, 0.01 at 276 and 0 at 306 (steps of 23, 24, 30, 18 and 30 ticks: the Timer runs on the level clock), where the Multitool is used up and the hackdoor pair DeusExMover37/38 opens at 307; 23 actors, 543 AI events and 113 creations equal for 520 ticks); validate-stage5-live cad1 (O1 2026-10-20, PASS: the cadet UNATCOTroop2 (Test_Subject, Standing at (3652, 849)) killed by Tantalus at 20 (Dying at 21), his UNATCOTroopCarcass0 at 98 holding the NanoKey Body_Search_Room; the right button at 150 searches it (the key goes to the key ring: NanoKeyInfo0), the second at 190 carries it (POVCorpse0 in hand, Base the player, the carcass destroyed at 191); the player placed 100 units north of Trigger0 (3688, 378), the Tab edge (DropItem) at 300 destroys the POVCorpse and spawns UNATCOTroopCarcass1, which touches the TT_ClassProximity trigger: DeusExMover3/25 (bodydoorsopen, locked) open at 301 and DL_bodyexit starts (DataLinkPlay0); 25 actors, 732 AI events and 102 creations equal for 700 ticks); validate-stage5-live cbr1 (the crowbar and the two Cratepick crates, DL_Lockpick: row 5.1.1) and aug1 (the dark room's AugLight: row 5.3.2); Stage 3 gate route probe (P: the whole route in one walk); validate-keypad, validate-training-nanokey, validate-training-cadet, validate-crowbar-crate (P); datacube and keypad frames O1 (4.4.13, 4.4.14) | PASS |
| 5.3.2 | 00_Training dark room | F12 turns on AugLight: energy drain, the Beam, the lit room; the repair bot recharges | O1 | `dark-room-aug` |  | validate-stage5-live aug1 (O1 2026-10-20, the Linux host, PASS: the player placed in the dark room between darkdoor and darkdoor2; the F12 edge at 60 activates AugLight2: a DeusExLog message, Beam0 and Beam1 spawned and a 'Beam' AI event started (AIStartEvent) the same tick; Energy 100 -> 99.958 at 66 and down about 0.042 every 15 ticks, 98.5 at 600; 19 actors, the creations and the AI events equal for 600 ticks); validate-auglight-lighting (O3 lighting); validate-player-augmentation-startup (P) | PASS |
| 5.3.3 | 00_Training bots | the repair bot and the medical bot windows: recharge and heal amounts, cooldown, the window's buttons through the input path | O1 | `bots` |  | validate-stage5-live rpr1 (O1 2026-10-20, the Linux host, PASS: the player placed 68 units in front of RepairBot0, Energy set to 20, the right button opens HUDRechargeWindow (the bot Standing -> Idle at 63: StandStill, PlayAnim Start); the first focus is Recharge (the first enabled button), an Enter edge at 140 recharges Energy 20 -> 95 (chargeAmount 75, lastChargeTime 129.17) and the focus moves to Close, a second Enter at 220 closes the window (the bot Standing again), the right button at 290 reopens it with Recharge disabled by the cooldown (the first focus is Close) and an Enter at 370 closes it without a charge; 19 actors, the clock, the stream draws, 541 AI events and 161 creations equal for 520 ticks); validate-stage5-live rpr2 (O1 2026-10-20, PASS: the same recharge at 143, then 60 s of Level time: Energy set to 30 at 3763 and the window opened at 3803 with Recharge enabled again, an Enter at 3880 charges 30 -> 100 (capped by EnergyMax: 70), lastChargeTime 194.84, 62.3 s after the first; 19 actors equal for 4,020 ticks); validate-stage5-live med1 (O1 2026-10-20, PASS: HealthHead 70, HealthTorso 40 and HealthLegLeft 50 by DamagePart, the right button opens HUDMedBotHealthScreen with the focus on the Augmentations tab, Right moves it to Exit and Up to Heal All, an Enter at 203 heals every region to 100 (healAmount 300, lastHealTime 129.01), Escape closes the screen; the torso damaged again to 60 and the screen reopened: Alt+E, the accelerator of 'H/&eal All', presses nothing (the cooldown has disabled the button) and the torso stays 60; 19 actors, 581 AI events and 1,178 creations equal for 560 ticks); validate-window-baseline-play, validate-keypad (the window input chain, P); validate-window-mouse-focus-diff (MoveFocus, SetFocusWindow, O2) | PASS |
| 5.3.4 | 00_Training obstacle course | jump across the platforms and crouch under the pipes: Jump, Duck, fall and landing, the player's path equal to the original's | O1 | `obstacle-jump` |  | validate-stage5-live jmp1 (O1 2026-10-20, the Linux host, PASS: placed at the course (6991, -55) facing -Y; the Space edges at 30 and 150 leave the ground at 284 units/s (PHYS_Falling), the first peaks at Z 64.17 at 49 and lands at 69, the second lands at 189; 19 actors equal for 300 ticks); walking, falling, landing, stance oracles (O2); measure-training-physics | PASS |
| 5.3.5 | 00_Training ladder | climb the ladder by view pitch and the arrow keys, and leave it at the top | O3 | `ladder` | O3: the ladder prelude and physFlying on the inputs Play produced in this scene, against Engine.dll | validate-stage5-o3 --scene ladder (O3 2026-10-20: the scene with the recorder on, 1,465 calls replayed through Engine.dll, bit-exact: the walking-surface prelude 420 (174 Ladder branches), physFlying 174, physWalking 368, physFalling 52, processLanded 2, MoveActor's query 370, processHitWall 79; a control per body; Play's Rust-kernel run digest-equal); validate-native-ladder, validate-native-flying (O2); validate-training-ladder (P) | PASS |
| 5.3.6 | 00_Training crate stack | pick up a metal crate, drop it, stack and climb: GrabDecoration, DropDecoration, Bump, physFalling and physRolling of the crate, the climb | O3 | `crate-stack` | O3: the decoration's falling and rolling and the player's stepping on Play's inputs | validate-stage5-o3 --scene crate-stack (O3 2026-10-20: the crate carried, dropped, pushed (PHYS_Rolling) and climbed, 2,864 calls replayed through Engine.dll, bit-exact: decorations' physFalling 62, processLanded 26 and physRolling 312, the player's prelude 486, physWalking 443 (stepUp on a pushable decoration), physFalling 43, processLanded 2, processHitWall 161, MoveActor's query 1,329; controls; A/B digest. It found that physRolling stores OldLocation); validate-plant-push, validate-decoration-settle-roll (O2) | PASS |
| 5.3.7 | 00_Training swim | enter the contaminated water with and without the HazMat suit: WaterZone0 and DamageTrigger1 radiation, the suit's duration and armor, swimming and leaving by the ramp | O1 | `hazmat-swim` |  | validate-stage5-live hzm1 (O1 2026-10-20, the Linux host, PASS: moved into WaterZone0 (bPainZone, DamagePerSec 20 Radiation; DamageTrigger1, radius 700, around it) after the first unfrozen tick, bare: the torso 100 -> 60 at tick 2, Health 90, swimming, nothing more in 700 ticks; 19 actors equal); validate-stage5-live hzm2 (O1 2026-10-20, PASS: HazMatSuit2 picked up at 40, in hand at 80, activated by the Enter edge at 120 (Activated, bActive), then moved into the pool at 180: the torso 100 -> 70, Health 92, the suit's armor taking a quarter; its Charge 2000 -> 1960 at 181 and 1480 at 900, about 40 a second; 20 actors equal for 900 ticks); validate-native-swimming 1093 cases (O2); alterations census hit-radiation, hit-drowned (P) | PASS |
| 5.3.8 | 01_NYC_UNATCOIsland water | swim from the dock, dive to the ruins: breath (swimTimer, UnderWaterTime), drowning damage, surfacing | O1 | `island-swim` |  | validate-stage5-live swm1 (O1 2026-10-20, the Linux host, PASS: placed in WaterZone1 near the floor (Z -850) after the first unfrozen tick; PainTime 19.98 from UnderWaterTime 20, swimTimer 20 down to 0; out of breath at 1201, drowning takes 10 from the torso every 2 s (PainTime 2) until the player dies at 2162; 74 actors equal for 2,400 ticks); validate-stage5-live swm2 (O1 2026-10-20, PASS: placed at Z -450, the player sinks to -521, rises about 13 units a second and surfaces near 850 with about 6 s of breath left; swimTimer refills to 20 and he bobs at the surface, no damage; 74 actors equal for 1,500 ticks); validate-native-swimming (O2); validate-island-swimming (the fish, P) | PASS |
| 5.3.9 | 01_NYC_UNATCOIsland terminals | ComputerPersonal0 login with a user list, email; ATM0; ComputerSecurity camera views and door/turret choices | O1 | `island-terminal` |  | validate-stage5-live trm1 (O1 2026-10-20, the Linux host, PASS: ComputerPersonal0 from 68 units in front of it; the right button at 100 starts its Activate animation (bAnimating 103 to 109) and opens the NetworkTerminal on the login with the focus on the user name; KLloyd and a wrong password at 260 (both fields cleared, the user name refocused), KLloyd/squishy at 360 opens the e-mail screen (the first row of two selected, `01_Email01`), ArrowDown at 420 selects the second (`01_Email07`), Escape at 480 logs out to the login, GUEST/GUEST at 580 opens "No Email Today!", Escape twice (640, 680) closes the terminal and it turns off (bOn 0 at 689); 75 actors, 1,112 AI events and 1,059 creations equal for 720 ticks, 527 GCs in both); validate-stage5-live atm1 (O1 2026-10-20, PASS: ATM0 from 56 units in front; account 230023 with a wrong PIN at 260 (cleared), then 4558 at 360 (the withdraw screen: balance 200, the amount field focused), 50 and Enter at 440: DeusExPlayer.Credits 500 -> 550 and the ATM's balance 200 -> 150 at tick 443, in both; Escape twice closes it; 75 actors and 1,161 creations equal for 600 ticks); validate-stage5-live sec1 (O1 2026-10-20, PASS: ComputerSecurity1 (NSF001/smashthestate); the first focus is Camera Status; Alt+A at 380 unlocks the cell door DeusExMover10 (bLocked 1 -> 0 at 383), Alt+D at 440 opens it (KeyNum 1, interpolating 443 to 503), ArrowLeft and ArrowUp pan the camera (DesiredRotation), Alt+T three times at 600, 620 and 640 cycles the turret AutoTurretSmall0 to Disabled (bDisabled 1 at 643; it had woken at 526 on the camera's alarm); Escape twice closes the terminal; 78 actors, 1,231 AI events and 1,468 creations equal for 760 ticks); validate-stage5-live trf1, atf1, sef1 --frames (O1: the same inputs with the original's Shot (Ctrl+F9 under the terminal's keyboard grab) at held ticks, Brightness 2/3, against Play's frame at the same tick; their traces pass too); validate-terminals-play (the terminals in Play, P) | PASS |
| 5.3.10 | 01_NYC_UNATCOIsland doors | keyed, locked, breakable and keypad doors: the satcomhatch with the UNhatchdoor NanoKey, commvan_door keypad 0451, breakable and lockpicked movers, StatueRuinDoors | O1 | `island-doors` | O1: live trace of the original at each door (key use, pick, damage) with mover and lock state per tick. dor3 (the back entrance broken by a GEP rocket) equals the original for 900 ticks since work item 15: the break makes 14 MetalFragments in both, fragment 5 refused because AdjustSpot adjusts on a NaN Hit.Time (0x103983b3, an unordered FCOMP; docs/fitting.md "NaN in FindSpot") (the breakable door). | validate-island-cell-door, validate-island-blowitup (mover bodies, O2); validate-native-mover-move, -interpolation, -scene (O2); validate-native-findspot-nan (FindSpot over the tracked model and hash with a NaN Hit.Time, O2), validate-x87-compare-hardware (the compares, real x87) | PASS |
| 5.3.11 | 01_NYC_UNATCOIsland inventory | pick up and use items (MedKit, food, ammo, mods, Lockpick, Multitool), skill points (SkillAwardTrigger) and the skills screen, the AugmentationCannister and installing an augmentation, goals and notes | O1 | `island-items` |  | validate-stage5-live itm2 (O1 2026-10-20, the Linux host, PASS: HealthTorso set to 40; a summoned MedKit picked up at 100 (belt slot 1), in hand at 141, used by the Enter edge at 180: the torso 40 -> 70, Health 92; a Candybar the same way (slot 1 again), eaten at 360: the torso 72, Health 93; the player set clear of SkillAwardTrigger1 and slid into it by a console Velocity: SkillPointsAvail 5000 -> 5025 at 455 ("Exploration Bonus"); 75 actors equal for 900 ticks, with the original's object names (work item 13)); validate-stage5-live itm1 (O1, PASS: the same items; set inside the trigger the player never touches it, in both programs); alterations census: 19 scenarios play (P); persona screens O1 (4.4.11, 4.4.12) | PASS |
| 5.3.12 | 01_NYC_UNATCOIsland | move objects and fall: carry or push barrels and crates, throw them (kinetic damage), fall damage from a height | O1 | `island-movables-fall` |  | validate-stage5-live mov1 (O1 2026-10-20, the Linux host, PASS: Trashbag0 frobbed at 30 (GrabDecoration: carried, Base the player), thrown by DropItem at 120 (PHYS_Falling from Z -214), lands at 151 about 143 units on; the player dropped 380 units at 421 lands at 472, the left leg 100 -> 64, the torso 100 -> 88, Health 92; 75 actors equal for 900 ticks); validate-plant-push (O2); landing/falling oracles (O2) | PASS |
| 5.3.13 | 00_TrainingFinal and 01_NYC_UNATCOIsland movers | a switch-driven mover: 00_TrainingFinal Switch1 opens FirstStealthDoor; the exit door ElevatorMover1 (ExitDoor, a 64-unit slide, not a ride) is closed by a soldier's alarm (AlarmDispatcher -> CloseDoor, SequenceTrigger SeqNum 1) and reopened by Switch0 (ButtonDispatcher -> OpenDoor, SeqNum 0). Not driven: Island's Switch1 -> UN_maindoor (opened by Mission01) and the fork lift (DeusExMover11, a button in the ruins) | O1 | `elevator` |  | validate-stage5-live sw1 (O1 2026-10-20, the Linux host, PASS: the player set on the corridor floor 50 units west of Switch1 (frob target from tick 15); the right button at 60 (DeusExDecoration.Frob, Switch1.Anim On): DeusExMover0 (TriggerToggle) goes KeyNum 1 and interpolates 61 to 121; the second press at 220 takes it back, KeyNum 0, 221 to 281; 17 actors, the clock, the stream, the AI events and the 55 created objects equal for 360 ticks); validate-stage5-live stl1 (O1 2026-10-20: ElevatorMover1 (ExitDoor) slides from y 48 to 112 (64 units, 60 ticks, 223 to 282) when the soldier's alarm reaches SequenceTrigger1 (CloseDoor, SeqNum 1 -> ElevatorMover.SetSeq(1)), and back from 963 when the player presses Switch0 (ButtonDispatcher -> OpenDoor, SeqNum 0); the alarm that follows closes it again at 1124); validate-native-mover-move, -interpolation, -scene (O2); validate-island-cell-door | PASS |

### 5.4 Conversation

| Id | Scene | Scenario | Ev. | Census | Proof that would pass it | Existing, partial | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5.4.1 | 00_Training | the 18 DataLinks of the course start at their triggers, queue behind a playing one, end and set DL_*_Played; DL_Lockpick starts from the Mission00 timer | O1 | `training-datalinks` |  | validate-stage5-live dlk1 (O1 2026-10-20, the Linux host, PASS: the player slid by a console Velocity into dl_door's DataLinkTrigger24 at 32 and, while DL_door plays, into dl_key's DataLinkTrigger4 near 100: one DataLinkPlay from 32 to 1389, DL_door's InfoLink display and ConHistory at 32, DL_key's, queued, at 532 when DL_door ends; DL_door_Played and DL_key_Played set, equal at the end; 19 actors and every creation equal for 1,500 ticks); validate-stage5-live cbr1 (DL_Lockpick from Mission00.Timer at 301, once one Cratepick crate is left); validate-training-datalinks, validate-training-datalink-live (P); script-datalink-original.md | PASS |
| 5.4.2 | 00_TrainingCombat | the instructor takes the inventory: MunitionsTrooperTake/Frob (29 TransferObject events), MunitionsTrooperReady, Mission00.RemoveAllInventory | O1 | `instructor-take` |  | validate-stage5-live ins2 (O1 2026-10-20: ins1 without the second drop; the player stays inside the trooper's radius with Ready cleared by the Take and the radius greeting MunitionsTrooperFrob (ConPlay1) plays 823 to 917, UNATCOTroop3 in FirstPersonConversation, MunitionsTrooperFrob_Played set; Play equal for 1000 ticks, 1018 AI events, 126 creations and the 3 flags at the end); validate-stage5-live ins1 (O1 2026-10-20, Linux host: a pistol (with its Ammo10mm), a MedKit and a LAM (with its AmmoLAM) summoned and picked up at 61, 121 and 181; dropped into FlagTrigger2 beside UNATCOTroop3 at 245 (MunitionsTrooperReady true), the radius conversation MunitionsTrooperTake (ConPlay0) starts at 273, UNATCOTroop3 in FirstPersonConversation to 523: the 29 TransferObject events move the player's WeaponPistol5 and WeaponLAM0 to the trooper (the player keeps AmmoLAM0, MedKit0, Ammo10mm5 and the key ring) and the trooper's chain grows by 17 items; the conversation clears Ready and sets MunitionsTrooperTake_Played; the player leaves and drops in again at 600 (Ready true, no conversation inside the 10 s gate) and Mission00.Timer's RemoveAllInventory at 661 takes the rest, leaving the key ring; Play equal for 900 ticks, every pawn, AI event, 103 creations and the 2 flags at the end); validate-instructor-conversation (P) | PASS |
| 5.4.3 | 01_NYC_UNATCOIsland | MeetPaul: the three weapon choices (Minicrossbow, GEP gun, rifle) hand JC the weapon, the map image and three goals | O1 | `meet-paul` | O1: the conversation frames to the choice (4.5.5) plus the transferred object and goals per branch | 4.5.5 O1 frames; validate-island-conversation: each choice plays to the end (P) | PASS |
| 5.4.4 | 01_NYC_UNATCOIsland | MeetFilben (code phrase): the Choice decides FilbenGaveKey and the NanoKey; MeetFilben2 and AfterStatue follow the flags; skill points | O1 | `meet-filben` | O1: live trace of the original through each branch with the flags, inventory and skill points | - | PASS |
| 5.4.5 | 01_NYC_UNATCOIsland | GuntherRescued: free Gunther (the wall button DeusExMover8 triggers the cell door DeusExMover10, GuntherFreed), five choices, the player gives him a weapon (CheckObject/TransferObject), GuntherRespectsPlayer, AddSkillPoints, his alliance and orders | O1 | `gunther-rescued` | O1: live trace of the original through the branches with flags, inventory and Gunther's orders | - | PASS |
| 5.4.6 | 01_NYC_UNATCOIsland | MeetTerrorist with the commander: the Aggressive and Curious branches set PlayerAttackedStatueTerrorist and StatueMissionComplete; TerroristFollowup | O1 | `meet-terrorist` | O1: live trace of the original through both branches with the flags and the commander's orders | - | PASS |
| 5.4.7 | 01_NYC_UNATCOIsland | overheard conversations and barks: TerroristsOverheard (Amos), TopTerroristsOverheard, the NPC barks in alert states | O1 | `overheard-barks` | O1: live trace of the original with the player in range (the bark choice and the speech started) | validate-island-bark (P); validate-island-lipsync (O3) | PASS |
| 5.4.8 | 00_TrainingFinal | M00MeetPage and holo-Jaime: ConversationTrigger, JaimeAppears/JaimeBark_Played, EnterWorld/LeaveWorld by the Mission00 timer | O1 | `meet-page-final` |  | validate-stage5-live mpg1 (O1 2026-10-20, the Linux host, PASS: ConversationTrigger1's Touch at 152 starts M00MeetPage (BobPage1 and the player enter Conversation); the five speeches (Bob, JC, Bob, JC, Bob) are skipped by the Enter edges at 190, 230, 270, 310 and 350 and the conversation ends at 398 with M00MeetPage_Played set; 15 actors, the clock, the stream, the 539 AI events, the 173 created objects and the player's flags equal for 520 ticks with 29 measured mouth letters fed); validate-stage5-live jmr1 (O1 2026-10-20, PASS: Switch6 pressed at 150 sets JaimeAppears (FlagTrigger11); Mission00.Timer EnterWorld()s the holojaime JaimeReyes6 at 181 (bInWorld 0 to 1, MS_ReyesUnhidden); its radius conversation JaimeBark (first person) plays 182 to 882 (JaimeBark_Played); the Timer LeaveWorld()s it at 901 (bInWorld 1 to 0, MS_ReyesHidden); 16 actors, the 1,017 AI events, the 84 created objects and the four flags equal for 1,000 ticks with 61 mouth letters fed) | PASS |

### 5.5 Alternate-route objectives

| Id | Scene | Scenario | Ev. | Census | Proof that would pass it | Existing, partial | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5.5.1 | 01_NYC_UNATCOIsland front entrance | with the key from Filben (its first choice) the front doors (StatueRuinDoors, four movers) unlock and open; without it they stay locked and the player can pick them (lockStrength 0.1); they cannot be broken (bBreakable false) | O1 | `route-front` | O1: live trace of the original at the doors with and without the key and with the lockpick (key ring or Lockpick in hand, left-button click, then the right button to open). dor3 (the back entrance broken by a GEP rocket) equals the original for 900 ticks since work item 15: the break makes 14 MetalFragments in both, fragment 5 refused because AdjustSpot adjusts on a NaN Hit.Time (0x103983b3, an unordered FCOMP; docs/fitting.md "NaN in FindSpot"); its second rocket, at the front doors, leaves them whole. | - | PASS |
| 5.5.2 | 01_NYC_UNATCOIsland back entrance | the back way in (DL_BackEntrance, DeusExMover2: lockStrength 0.1, doorStrength 0.5, no key): lockpick it or break it; no hackable device guards it; the guards at the lower deck | O1 | `route-back` | O1: live trace of the original at DeusExMover2 (Lockpick in hand, left-button click, then the right button to open; the break by damage) and the patrol. dor3 (the back entrance broken by a GEP rocket) equals the original for 900 ticks since work item 15: the break makes 14 MetalFragments in both, fragment 5 refused because AdjustSpot adjusts on a NaN Hit.Time (0x103983b3, an unordered FCOMP; docs/fitting.md "NaN in FindSpot") (the break). | - | PASS |
| 5.5.3 | 01_NYC_UNATCOIsland airshafts | the airshaft route around the laser trap to Gunther's cell (DL_libertyruinsairshaft x3): crouch through the shafts, the NPCs and alarms bypassed | O1 | `route-airshaft` | O1: the same state comparisons with the player placed in the shaft | - | PASS |
| 5.5.4 | 01_NYC_UNATCOIsland water route | the east side by water: swim to the ruins, the electric arcs (ElectricityEmitter x3, LibElectric, EMP damage drains energy), ControlPanel1 and the fork lift | O1 | `route-water` | O1: live trace of the original from the water to the arcs, the panel and the lift | - | PASS |
| 5.5.5 | 01_NYC_UNATCOIsland | kill the commander: TerroristCommander_Dead -> DL_LeaderKilled (InSpite after NotKilled) -> StatueMissionComplete | O1 | `objective-kill` | O1: live trace of the original from the commander's death through Mission01.Timer | - | PASS |
| 5.5.6 | 01_NYC_UNATCOIsland | spare the commander: MeetTerrorist (Curious) -> StatueMissionComplete; DL_LeaderNotKilled | O1 | `objective-spare` | O1: live trace of the original through the conversation and the timer | - | PASS |
| 5.5.7 | 01_NYC_UNATCOIsland | StatueMissionComplete changes the world (Mission01.Timer): UN_maindoor opens, doors unlock, custody and post-mission troops enter, Terrorists die, Paul teleports, turrets and lasers go, cameras silenced | O1 | `mission-complete` | O1: live trace of the original after the flag with every changed actor per tick | - | PASS |

### 5.6 Systems interacting

| Id | Scene | Scenario | Ev. | Census | Proof that would pass it | Existing, partial | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5.6.1 | 01_NYC_UNATCOIsland | a shot near guards: noise, hostility, pursuit, distress to other pawns, the player hurt and healed with a MedKit | O1 | `noise-wakes-guards` | O1: live trace of the original of the whole encounter | 5.1.5, 5.1.6, 5.2.3 each partial; validate-stage5-live cmb2 (O1: the shots near the guards, their hostility, distress and the player hurt; no MedKit) | PASS |
| 5.6.2 | 00_TrainingFinal alarm | an AlarmUnit trips (bActive for its alarmTimeout, 10 s): AlarmDispatcher fires SoldierNeutral (AllianceTriggers), CloseDoor (ExitDoor) and failmessage (DL_FailedStealth) | O1 | `alarm-chain` |  | validate-stage5-live stl1 (O1 2026-10-20: the alarm tripped by Soldier0 (TriggerAlarm), not by a Trigger call as the census does: the four units active at 221 for alarmTimeout (inactive at 820, 599 ticks), Dispatcher1 in Dispatch at 221, SoldierNeutral on both soldiers at 222, ElevatorMover1.SetSeq(1) at 223 (KeyNum 1, bIsMoving 223 to 284), DL_FailedStealth played and its flag set; the second trip at 1122 does the same after the Switch0 reset) | PASS |
| 5.6.3 | 01_NYC_UNATCOIsland | light against sight: a pose seen or not seen by its lighting (AICanSee times AIVisibility against VisibilityThreshold). Island has no light switch, and AugLight adds a second path (its Beam AI event, CheckBeamPresence), so the census pair is the map's own lighting: two poses 500 units in front of Terrorist4 with a clear line of sight, one in shadow, one lit | O1 | `light-vs-sight` |  | validate-stage5-live lgt1 (O1 2026-10-20, the Linux host, PASS: in shadow the player's CurrentVisibility is 0.0042; Terrorist4 and Terrorist27's overheard conversation runs on and Terrorist4's EnemyReadiness stays 0 for 900 ticks); validate-stage5-live lgt2 (O1 2026-10-20, PASS: 15 degrees over, in the light, CurrentVisibility 0.0548; Terrorist4 leaves the conversation to seek at 138 and attacks at 274, EnemyReadiness 1; both equal per tick with the speakers' measured mouth letters); validate-pawn-perception, AICanSee (O2); lighting oracles (O2) | PASS |
| 5.6.4 | 01_NYC_UNATCOIsland | an explosion: a barrel or CrateExplosiveSmall near a Terrorist, a breakable door and a decoration: HurtRadius, damage to each, noise, chain explosions | O1 | `explosion-world` | O1: live trace of the original with the barrel shot | validate-stage5-live exp1 (O1 2026-10-18: two CrateExplosiveSmall summoned by the breakable DeusExMover5; the second lands half off the first and slides off it (processLanded's footprint push, 45); Terrorist2 comes to open the door, which crushes the first crate (Mover.EncroachingOn: TakeDamage 10000 'Crushed') at 307; its blast (ExplosionLarge, ShockRings, the gradual HurtRadius) sets off the second at 312, breaks the door (doorStrength 0.6 -> 0, bDestroyed), destroys TrashCan5 and kills Terrorist2; every pawn, the door, both crates, TrashCan5, Chair5, the AI events (LoudNoise) and the 1,634 objects created equal per tick); validate-native-landing (O2, the footprint push and the Carcass slide); validate-island-blowitup (O2); VisibleCollidingActors iterator 312 (O2) | PASS |
| 5.6.5 | 01_NYC_UNATCOIsland | EMP: an EMP grenade or the EMP field against a SecurityBot, the turret and the camera (disabled) and the player's energy | O1 | `emp-electronics` |  | validate-stage5-live emp1 (O1 2026-10-18, PASS: the grenade thrown at 200 toward PatrolPoint19; its blast takes SecurityBot0's EMPHitPoints 100 -> 69 -> 34 -> 0 from tick 418 and disables it at 423); validate-stage5-live emp2 (O1, recaptured with lastRefreshTime: at cam1's pose the blast confuses SecurityCamera3 (420) and AutoTurret0 (426), and the player's Energy drains 3.75 at 435, 450, 465 and 480, all equal); alterations census emp-grenade, hit-emp (P); validate-stage5-live emp2 equal for 900 ticks since work item 16 (2026-10-20): the player dies at 820, and the Dying state's PlayerCalcView, which leaves CameraRotation as UGameEngine::Draw passed it (the body's Rotation, Engine 0x1038f155-0x1038f1ac), views SecurityCamera3 from 821 as the original does | PASS |
| 5.6.6 | 01_NYC_UNATCOIsland | conversation flags change the world: GuntherFreed (the cell door chain; on the same walk Gunther's alliance flips at AllianceTrigger0's touch, and GuntherRescued's GuntherAttacks gives his orders), FilbenGaveKey, M01PlayerAggressive, KnowsShipment | O1 | `flags-change-world` | O1: live trace of the original from each flag's source to the world it changes | validate-stage5-live kB (O1, pass as a comparison: the Tantalus at tick 80 missed Terrorist18, seven carcasses, the player placed outside the world at the trooper, no M01PlayerAggressive in either program) | PASS |

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
session spawned more keyrings (inferred from the pending chain, not traced; since work item 11 the seed pairs the two by creation order and the free is Play's own:
[load-made actors](#load-made-actors-paired-by-creation-order-not-by-name-2026-10-19)). `cmb1`, `cmb2` and `cmb4` count 1 such release each, by their counts the sender event (not logged by name
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
| `dor3` | 5.5.2, 5.3.10, 5.5.1 | 336 units from the back entrance: a GEP gun summoned, picked up, drawn; an Enter edge at 300 at `DeusExMover2` (`bBreakable`, `doorStrength` 0.5, `minDamageThreshold` 50); placed 300 units from the StatueRuinDoors at 500, an Enter edge at 600 at `DeusExMover12` (`bBreakable` false). The second capture also watches `Rocket0` and the 51 `Rockchip`s of its explosion | the rocket's staggered HurtRadius breaks the back entrance at 320 (`BlowItUp`: 14 `MetalFragment`s of 16 attempts, FindSpot refusing the sixth and the fourteenth, moved up 20,000, non-colliding, `bDestroyed`); the second rocket leaves the front doors whole | **equal for 900 ticks** since work items 8 and 15. Until item 8 the rocket stopped 2.0 units shorter along its path in the original (13.86 of its 16.67-unit step, Play 15.86) because Play's world query missed the brush tracker's fragments (item 4 below); until item 15 the break made 15 fragments in Play, whose AdjustSpot skipped the NaN Hit.Time of the sixth attempt |

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

### Conversation captures: the Island's conversations, choices and flags (2026-10-18)

Rows 5.4.3 to 5.4.7 and 5.6.6 now have O1 scenes: the original plays an Island conversation through its own keys, traced per tick, and Play replays the same inputs.
They are `SCENES` of `scripts/validate-stage5-live.mjs` with `conversation: true`; `--print-capture` gives each capture command and `--scene <tag>` is the proof check.

**Method.** The player is placed in the frozen phase inside the conversation's radius (the combat scenes' `ghost`, SET of `Location`, `walk`, SET of `ViewRotation`), or later in
a hold. Enter during a third-person speech skips it (`ConWindowActive.VirtualKeyPressed`, then `ConPlay.PlayNextEvent`); a choice is ArrowDown edges, then Enter. A frob-only
follow-up is `ParseRightClick` on the pawn. A conversation scene's trace adds the player's mouth channel and what a conversation gives and takes (`live-acceptance.mjs --player-blend
--inventory`: every watched pawn's and the player's Inventory chain, the player's `SkillPointsAvail`, `Credits`, `conPlay`, `FirstGoal`, `FirstImage`, and each speaker's
`nextPhoneme`/`lastPhoneme`, a new FString field type `str` in `tools/dx-live-win.c`). The replay feeds the speakers' measured mouth letters (`conversation-acceptance.mjs phonemes`,
now from `nextPhoneme`). The capture dumps the player's `FlagBase` at the frozen start and the end hold (`--dump-flags`, `tools/dump-flags-win.c`), and the check needs every flag
equal at the end: name, type, value, expiration and the default expiration. A `watch` list names the pawns traced per tick; every other pawn is traced with its load fields only. Every AI
event, every object creation (a loaded `Sound` now also by its export name: which bark or speech line was loaded) and the stream draws of the whole level are still compared.
`scripts/stage5-capture-rehearsal.mjs --scene <tag>` prints the conversation, its event, choices, skill points, inventory and flags whenever they change.

| Scene | Conversation and branch | Ticks | Replay in Play |
| --- | --- | ---: | --- |
| `pG` | MeetPaul at the dock: the GEP gun (second choice) | 1150 | PASS: 23 actors, 1,678 AI events, 1,392 creations; the GEP gun and its rockets, the Liberty Island image and three goals; 1 flag |
| `pR` | MeetPaul: the sniper rifle (first) | 1150 | PASS: 23 actors, 1,680 AI events, 1,394 creations; 1 flag |
| `pX` | MeetPaul: the mini crossbow (third) | 1150 | PASS: 23 actors, 1,682 AI events, 1,396 creations; 1 flag |
| `fT` | MeetFilben: "You can trust me." (the NanoKey, `FilbenGaveKey`, 150 skill points, the commander's image) | 1200 | PASS: 20 actors, 1,766 AI events, 1,270 creations; 4 flags |
| `fM` | `fT`'s inputs, then MeetFilben2 by a frob fan: its GaveKey branch | 1250 | PASS: 20 actors, 1,834 AI events, 1,424 creations; 5 flags (after fix 7 below) |
| `fN` | MeetFilben: "I can't promise..." (`FilbenGaveKey` false), then MeetFilben2 without the key | 1300 | PASS: 20 actors, 1,892 AI events, 1,438 creations; 5 flags (after fix 7 below) |
| `gP` | GuntherRescued after the wall button: the carried pistol given (`GuntherRespectsPlayer`, `GuntherAttacks`) | 1350 | PASS: 22 actors, 1,938 AI events, 1,275 creations; 4 flags |
| `gN` | GuntherRescued without a weapon: "First thing is to get you out of here." | 1150 | PASS: 22 actors, 1,671 AI events, 1,221 creations; 4 flags |
| `gS` | `gP` with the stealth pistol carried: "As you wish.  Take my stealth pistol." (2026-10-19) | 1350 | PASS: 22 actors, 1,945 AI events, 1,282 creations; 4 flags |
| `gU` | `gP` with the assault gun carried: its own choice, the gun to Gunther (a new `Ammo762mm` in his chain in both programs) (2026-10-19) | 1350 | PASS: 22 actors, 1,941 AI events, 1,279 creations; 4 flags |
| `gK` | `gP` with the combat knife carried: Gunther already holds a knife, so the player's is destroyed, not added (2026-10-19) | 1350 | PASS: 22 actors, 1,940 AI events, 1,277 creations; 4 flags |
| `gW` | `gN` with NothingChoice's first answer, "Wish I could help, but I'm not very well armed.": GiveNothingNicely (`GuntherRespectsPlayer`, `GuntherAttacks`) (2026-10-19) | 1350 | PASS: 22 actors, 1,923 AI events, 1,258 creations; 4 flags |
| `gA` | `AllianceTrigger0` and `OrdersTrigger6` touched by a landing at the button, then the button: the freed Gunther fights `Terrorist18` | 900 | PASS: 22 actors, 1,486 AI events, 1,127 creations; 3 flags (after fix 1 below) |
| `tC` | MeetTerrorist, Curious: `DL_LeaderNotKilled`, Mission01's mission-complete pass, TerroristFollowup by frob | 1300 | PASS: 24 actors, 1,911 AI events, 1,523 creations; 7 flags (after fixes 4 and 6) |
| `tA` | MeetTerrorist, Aggressive (the commander attacks), then MeetFilbenAfterStatue at Filben; the player waits on `cmb5`'s ledge and is placed at the commander at tick 100 | 1050 | PASS: 26 actors, 1,684 AI events, 1,404 creations; 7 flags (a first capture placed in the frozen phase: below) |
| `tF` | `tA`'s first design: the player placed at the commander in the frozen phase (MeetTerrorist from tick 14), then MeetFilbenAfterStatue | 950 | PASS: 26 actors, 1,545 AI events, 1,357 creations; 7 flags; the frozen phase's window frames replayed from the trace, and FAIL without them ([below](#the-frozen-phases-window-frames-2026-10-19)) |
| `oV` | TerroristsOverheard (Amos and Jackson, first person, from behind a wall) to `KnowsShipment`, then MoleConvos: its KnowsShipment branch, the 10 mm clip bought (175 credits), `BumFemaleWanders` | 1300 | PASS: 26 actors, 1,883 AI events, 1,307 creations; 7 flags (after fix 3) |
| `oT` | TopTerroristsOverheard (Terrorist9 and Terrorist8, first person) from a hidden place | 1200 | PASS: 24 actors, 1,701 AI events, 1,061 creations; 1 flag |
| `kB` | eight Terrorists killed (`Tantalus`) for Mission01.Timer's `M01PlayerAggressive`, then the player placed at UNATCOTroop6 for TrooperCongratulation | 700 | PASS as a comparison: 23 actors, 884 AI events, 1,065 creations, no flag in either program. The `Tantalus` at 80 hit nothing: `Terrorist18` was not on its line (no death cry or `Distress` from it; its footsteps go on), so seven carcasses and the count stayed at 23. The placement at (-4062, 2085, -187) lies outside the world and killed the player at once in both (below) |
| `kC` | `kB` redesigned (2026-10-19): `Terrorist18` killed at tick 3 at its load place, the other seven at `kB`'s ticks, the player parked at the map start, then placed at (-4262.5, 2105.2, -191), 160 units north of UNATCOTroop6's seat: TrooperCongratulation's JustTerrorists branch ("Good shootin', sir.") | 800 | PASS: 25 actors, 1,358 AI events, 1,138 creations; 2 flags (`M01PlayerAggressive`, `TrooperCongratulation_Played`). The original: eight carcasses (52 to 253), the conversation 367 to 636 (after fix 8 below) |

**What the original does that the scenes had to follow** (DeusEx.u source, each confirmed by a capture):

* A speech that runs out restricts input for 0.5 s (`SpeechFinished`): an Enter there is dropped. `GetActiveConversation` refuses a conversation with the same NPC less than 1 s after
  `LastConEndTime`, which `EndConversation` sets when the `ConPlay` terminates. A radius conversation also waits 5 s after a first-person conversation with that NPC
  (`lastFirstPersonConvoTime`) and 10 s after a third-person one.
* The third-person window closes about 11 ticks after the conversation's end event in the original: the tracer's real-time window frames run between the level ticks. The headless
  rehearsal takes about 130. Every input timed after a conversation's end uses the original's figure (`pG` ends at 986, the rehearsal at 1022; `fT` at 469, the rehearsal at 589).
* Filben wanders off at the end of MeetFilben (`HarleyStartsToWander`) on a path the load's stream chooses: east in one capture, south-east out of the frob line in another. MeetFilben2
  is therefore started by a fan of right-button frobs from the end of the 1 s guard (`fM`, `fN`).
* A summoned weapon that lands faster than 200 units/s is a `LoudNoise` of radius 768 (`DeusExWeapon.PlayLandingSound`): near Gunther's cell it brings `Terrorist18`, so `gP` summons
  the pistol at the map's start. A console placement touches no trigger; a placement 64 units above the floor touches the triggers at its landing (`gA`: `AllianceTrigger0` and
  `OrdersTrigger6`, after which the freed Gunther fights `Terrorist18` and GuntherRescued never starts).
* `ConPlayBase.SetupEventTransferObject` gives nothing new when the recipient already holds the class: it destroys the giver's item ("Pawn cannot have
  multiple weapons"). Gunther starts with a `WeaponCombatKnife`, so `gK`'s knife leaves the player and is destroyed in both programs.
* `Pawn.LipSynch` applies the first letter of a speech with tween time 0 (a stale `animTimer[3]`), so an `X` at a speech's start does not show on the blend channel: the mouth letters
  are measured from `nextPhoneme` itself.
* The capture hides the HUD in the frozen phase (`ShowHud False`), so a frozen-phase `ghost` line ("You feel ethereal") waits in the hidden log, and
  `HUDLogDisplay.Tick` times it out after the log timeout (3 s) unless a third-person conversation pauses the count. The original's frozen phase gives the log
  the window time of the typed lines, which the tracer does not record (at least the capture's 2.4 s of sleeps after `ghost`, then the release's first
  window frame: 1.21 s in `tA`'s first capture, 2.39 s in `tC`'s). Play's frozen phase gives it a few frames. In `tA`'s first capture MeetTerrorist started at
  tick 14 and its Aggressive branch logs nothing, so Play still had the line waiting at the end (379) and drew the log there (four GCs), while the original
  first drew it at 600. `tA` now places the player at the commander in a hold after tick 100, whose window frames are traced and replayed. In the other
  scenes the original also draws the log at the conversation's end (`pG` 986, `pR` 976, `fT` 469, `gP` 1192: their conversations give the player something),
  or neither program does (`tC` at 717: with the release's 2.39 s frame the line times out before MeetTerrorist in Play too). Since 2026-10-19 a capture
  traces the frozen phase's window frames and the replay ticks Play's windows with them ([below](#the-frozen-phases-window-frames-2026-10-19)); `tF` is
  `tA`'s first design captured that way.
* `M01PlayerAggressive` (`kA`, `kB`, `kC`, measured 2026-10-19 on the stored traces). Mission01.Timer counts every `Terrorist` actor, a Dying one too, plus the carcasses the
  player did not kill (29 and the placed `TerroristCarcass0` at the load), so all eight victims must have become carcasses (`count < 23`). A Dying pawn sets `bStasis` False
  and finishes its death animation unseen: carcasses came up to 67 ticks after the player had left their victim (`kB`'s `Terrorist4`: left at 186, carcass at 253). `kA` made all eight (98 to 253) and set the
  flag. In `kB` the kill at tick 80 hit nothing: `Terrorist18` has Sitting orders, and once StartUp's `Sleep(FRand()+0.2)` ends it walks to a seat on a path the stream
  chooses, so the line aimed where `kA` found it at tick 80 missed it (no death cry or `Distress` from it, its footstep `LoudNoise`s go on at 85, 124, 162...). The
  placement at the trooper, (-4062, 2085, -187), is outside the world: the player's `Region` reads zone 0, leaf -1 at tick 361 in both captures (Play's `PointRegion`
  agrees), and `Pawn.FellOutOfWorld` sets Health -1, `PHYS_None` and calls `Died('Fell')`. In `kA` the player had stood unharmed at the last kill site until that
  placement (the earlier reading, a death by the Terrorists there, was wrong). The headless rehearsal first kept the player walking there; the cause, measured
  2026-10-19 (Play against itself, the evidence is the oracle below). Both run the hold's lines through the same console chain (`consoleCommand`): the `set` writes
  Location only (Region stays zone 3), `walk` ends in `PlayerWalking.BeginState`'s `SetPhysics(PHYS_Falling)`. In the replay `ThugMale3`, attacking the player,
  calls `FindPathToward` on it in tick 361 before the player ticks; with the target falling, the path worker runs the target's `jumpLanding` (0x103db4ec), whose
  test moves and FarMoveActor back recompute the player's Region (zone 0), so its physFalling takes the zone-0 branch. The rehearsal's own world (it set
  `M01PlayerAggressive` at 301, which neither capture did) had no such call: the falling move left the player in place, MoveActor's SetZone wrote zone 0,
  and `processLanded` ran physWalking, whose zone-0 branch (0x103ca584-0x103ca5e7: `FellOutOfWorld`, then return) Play did not have. It does now
  ([walking](walking.md), `validate-native-walking`'s zone-0 cases against Engine.dll), and the rehearsal's player dies at 361 by that route: Dying, Health -1,
  `PHYS_None`, unmoved at (-4062, 2085, -187), zone 0 / leaf -1, as in both captures; `kC`'s rehearsal still plays TrooperCongratulation from 367 to 636. The
  `PointRegion` check over the player's whole cylinder still picks a spot before a capture: it names the cause, the rehearsal only shows the outcome.
* `kC` follows both. A pawn in StartUp (`ScriptedPawn.uc` `auto state StartUp`) stays at its load place until `Sleep(FRand()+0.2)` ends (12 ticks at least)
  or the player renders it (its `Tick` then calls `FollowOrders`); the frozen phase leaves the player at the map start, so `Terrorist18` is killed in the hold
  after tick 3, from 220 units east with a clear line (Play's `FastTrace`; its death cry and `Distress` at tick 3, its carcass at 52). The trooper (Sitting
  orders) walks to its seat from tick 68 and rests at (-4262.5, 1945.2, -199.9) from 292; the placement 160 units north is in zone 8 over the whole cylinder,
  inside the radius (`CheckConversationInvokeRadius`: the int `VSize` against `Max(16, 250)`) and the height check, and comes after the flag
  (TrooperCongratulation is `bDisplayOnce`: a first play before the flag would take the other branch for good). The flag's tick is not traced; the
  rehearsal set it at 301, and the original's conversation began at 367 on the JustTerrorists line (`ConAudioMission01_382`).

**What the replays found in Play** (each fixed; every stored scene was rerun after the last):

1. **`AICanSee` with a skipped argument** (`gA`, general). `execAICanSee` (Engine.dll 0x103c8270) pre-stores every slot before stepping its token: `Visibility` 1.0f
   (0x3f800000), then the flags 1, 1, 0, 1. An `EX_Nothing` argument keeps the default, as an omitted tail does. Play read a skipped visibility as NaN and returned 0, so every
   `AICanSee(x, , ...)` call failed: FindBestEnemy's `CheckEnemyParams` (`AICanSee(checkPawn, , false, false, true, true)`) never took a new enemy, and the order, beam and
   Animal food tests never saw. In `gA` the original's Gunther ends a `MoveTo` at tick 676, finds `Terrorist30` 59 units away, closer than his enemy `Terrorist18` (Alerting,
   201 units after the 0.75 factor), and switches to it, with one more stream draw that tick; Play kept `Terrorist18`, and now switches with the same draws. The oracle had tested the worker
   0x103c6ab0 with explicit arguments only. Both the JS body and `percep.rs` now take the defaults; `validate-perception-kernel` and `validate-pawn-perception` pass.
2. **`AIProcess`'s replay stop** (`gA`). The replay feeds the original's `aiFirst` at the tick's exit as a stop. A stop at the first live receiver after the start is the
   cleanup's advance, not the budget, and the ring is visited whole (`aievent.rs`): `Terrorist30`'s `LoudNoise` had come one tick late, at 487.
3. **The frames of a hold** (`oV`). The original renders frames while the next line of a hold is typed, so a placement's `set Location` followed by `set ViewRotation` stamps the
   pawns in view between the two. `live-probe.mjs` now renders after each command of a hold (`HarleyFilben0`'s `LastRenderTime` at 481).
4. **A destroyed watched actor** (`tC`). After `UnhashObject` the tracer reads freed memory (Mission01's pass destroys `ThugMale3` and Gunther), so the check compares the release tick
   (the original's unhash of the actor's registry index against Play's free of the same index) and no row after it.
5. **The mouth letters** (`gP`): measured from `nextPhoneme` (item above), not derived from the blend channel.
6. **The portrait's first load** (`tC`): `HUDInfoLinkDisplay.SetSpeaker`'s `DynamicLoadObject("InfoPortraits.AlexJacobson")` creates `Package InfoPortraits`, its `LinkerLoad`, the
   `Texture` and its `Palette` at the DataLink's first speech (tick 841). The registry model of a prepared load is the routes batch's (`kil1`), applied here unchanged.

7. **A typed line during a conversation** (`fN`). The capture types a console line as keys (`ad/tools/dxinput.c` consoleLine: T, ten Backspaces, the
   characters, Enter), and `XInputExt::Process` (0x1002d0b0) offers every key to the root window before any binding. During a third-person conversation
   `ConWindowActive.VirtualKeyPressed` returns True for every key and plays the next event on Enter, so the console never opens and the line never runs: the
   original's `InputEvent` returned all of the line's releases as handled from tick 667 to 682, while MeetFilben2 played (the frob fan's lines typed after
   the frob that started it). Play ran every typed line through the console command chain. The replay now offers the line's T to Play's root window first
   (`game.windowKey`); a window that takes it gets the line's Backspaces and Enter instead, and the line is not run (`live-probe.mjs`).
8. **The order of the typed lines** (`kC`, the harness). The tracer holds at the sorted ticks (`pause-at`) and types each hold's lines in list order, while
   `live-probe.mjs` runs the command list as a queue. `kC`'s list names its parks at 80 and 186 after the kill at 180, so Play's first replay left the
   player at `Terrorist0`'s place from tick 81 (every actor's `DistanceFromPlayer` differed there). The replay now takes the stored lines in the order
   the original typed them (`live-acceptance.mjs` commandsWithStream: a stable sort by tick). Of the 74 stored command lists (every map), only `kC`'s
   is out of tick order, so no other replay changes.

**Checks rerun for the `AICanSee` fix and the portrait's registry model** (2026-10-18, the Mac): the stored Island scenes `cmb1` to `cmb7`, `die1`, `pG`, `pR`, `fT`, `gP`, `oV`,
`gA` and `tC` pass, as do the six Stage 4 rows that replay live traces (4.1.5, 4.1.6, 4.1.7, 4.2.13, 4.3.6, 4.5.5), the unit tests (652), `validate-perception-kernel` (12,000
cases, Rust against the JS body; a flag no longer takes a JavaScript leaf's `undefined`, which no original argument can be), `validate-pawn-perception` (356 scenes, 14
mutations), `validate-event-manager` and `validate-gm-trench-play-anim`, and the census (50 plays, 0 pause, 0 no-effect, 0 undriven).

**Checks rerun for the typed-line delivery** (fix 7, 2026-10-18, the Mac): the gate's 21 proof replays above (every stored Island scene), and the six Stage 4 rows that
replay live traces (4.1.5, 4.1.6, 4.1.7, 4.2.13, 4.3.6, 4.5.5).

**What stays uncaptured** (named in the rows' `weak` and `need`): the second answers of GuntherRescued's four give choices ("First thing is to get you out of
here.", each its own speech before GiveNothing, which `gN` plays from NothingChoice), Filben's two barks that read `FilbenGaveKey`, and PaulCongratulations
(`PaulWandering`). Captured on 2026-10-19: `M01PlayerAggressive` and TrooperCongratulation's JustTerrorists branch (`kC`, with `Tantalus` kills, not weapon
fire), the stealth pistol, assault gun and knife gives and NothingChoice's first answer (`gS`, `gU`, `gK`, `gW`). Every approach is placed and
every speech skipped, as the harness cannot walk.

### The frozen phase's window frames (2026-10-19)

**What was unmeasured.** `live-acceptance.mjs original` types `bCheatsEnabled`, `ShowHud False` and the `--early-cmds` lines (a placement's `ghost`, `set
Location`, `walk`, `set ViewRotation`) in the frozen phase, then checks the population, dumps the registry and the flags, and only then attached the tracer.
The game draws frames all that time, and `TickWindows` ticks every root with each frame's wall-clock time (`UExtensionEngine::Tick`, [interface
frames](interface-frames.md) 2b). The tracer's `roottick` records began at u 1, so the first one carried whatever gap preceded it (1.21 s in `tA`'s first
capture, 2.39 s in `tC`'s), and Play's frozen phase ticked its windows with its own page frames instead. A line a frozen-phase command logs ("You feel
ethereal") times out after the player's `logTimeout` (3 s, `HUDLogDisplay.Tick` counting `lastLogMsg`), so whether it still waits when a conversation
starts was host time on both sides (the `tA` item above).

**The tracer** (`tools/dx-live-win.c`). A call marked `frozen` is armed from the attach; the config line `frozen-wait <path>` attaches at once with only those
calls armed (records u 0, `inTick` 0) and no level breakpoint, and reads the rest of the config (the watch lines) from `<path>` when it appears; then it goes on
as before (the level's breakpoints, `release` counted from there). `<out>.resume` before that leaves (the population check's reload). The files are looked at
only at one of its call events with no step pending (the process is stopped there), or, with no call armed, at a wait's timeout. Resolving the watches walks
the whole object array while the game's next `RootTick` waits at its breakpoint, so one traced window frame spans it (21 s in the first `tF` capture): a measured
frame like the others, ticked before tick 1. Calls keep their own armed state (`calls_set` 0, 1 every call, 2 the `frozen` ones), so arming the rest at the
release keeps the frozen ones' original bytes. A tracer built before this ignores `frozen-wait` (it would release the level before the lines are typed):
`live-acceptance.mjs` stops when it sees one, and a checkout that captures must rebuild `ad/build/dx-live-win.exe`.

**The capture.** `--frozen-frames` (every Stage 5 capture, `validate-stage5-live.mjs captureCommand`; `UEngine::InputEvent` and `RootTick` are the `frozen`
calls of `captureConfig`) starts the tracer after the load and the generators' load dump, before the first typed line. Every console line typed from there to
the watch file, a retyped `KillAll` included, is listed in order in `frozen-lines<tag>.json`, with the call sequence number the tracer read the watch file at
(`goSeq`).

**The replay** (`live-acceptance.mjs play`). A console line runs inside its Enter press's `InputEvent` (the console's `KeyEvent`, as for a hold's commands), so
the n-th Enter press at u 0 before `goSeq` is the n-th line's, and the u 0 frames between two of them ran after the first line and before the second. Play's
frozen phase runs its own lines (`ShowHud False`, the early lines; `ghost` without `--no-ghost`) through `viewProbe` with its windows held (`windowHold`:
`game.tick` no longer ticks them with the page's frame time), and ticks them with the frames that preceded each line in the original (`windowFrames`); a line
Play does not type (`bCheatsEnabled`, which `viewProbe` writes, a `Brightness`, an `Alliance`, a retyped `KillAll`) keeps its frames in place. The frames
after the last line (the population check, the dumps, the tracer's two frozen ticks) tick the windows before tick 1, where an older trace gave tick 1 the last
frozen frame only. A hold at 0 takes the key edges and frames after the last line. The replay ends the hold when it arms. Without the file, or with a
different count of Enter presses than lines (reported), or with `--own-frozen-windows`, the frozen phase stays Play's own warm-up.

**Checked on `tF`** (`tA`'s first design, placed at the commander in the frozen phase; two captures on the Mac bottle, 2026-10-19; the stored one is the
second, with the tracer as committed). The 7 typed lines (`bCheatsEnabled`, `ShowHud False`, `KillAll FlyGenerator`, `ghost`, `set Location`, `walk`,
`set ViewRotation`) have their 7 Enter presses; 291 frames (15.46 s) ran before the last one and 4,945 (126.68 s) after it, before the release (the longest,
9.07 s, spans the watch resolve; the first capture's was 21 s). Play's HUD log clock when the replay arms is the original's frames' (`lastLogMsg` 3.01 s of 3:
the `ghost` line has timed out); Play's own warm-up left it at 0.42 to 1.00 s in four runs. `tF` passes: 26 actors for 950 ticks, the clock, the stream draws,
1,545 AI events, 1,357 creations and the 7 flags at the end. Replayed with Play's own warm-up (`--own-frozen-windows`) the same capture fails as `tA`'s first
capture did: the creations part at 899 of 1,357, where Play draws the log at MeetTerrorist's end (four `GC`s at 379) and the original does not (its release
frame, u 1, lasted 1.29 s, as `tA`'s 1.21 s). The first capture did not tell the two apart (its u 1 frame lasted 3.69 s, which times the line out by tick 2
either way). `tF` is the frozen phase's check (`validate-stage5-live.mjs --scene tF`), not in a row's proof list (5.4.6 has `tC` and `tA`). The stored scenes
have no `frozen-lines` file and replay as before (`tA` and `cmb2` rerun: PASS).

**Still unmeasured**: the original's frames between the map's load and the attach (the 40 s load wait and the generators' dump), against Play's page frames
before its first held line. The log is empty until the first typed line, and no other window state is known to depend on that time.

### The Deleted chain at the first purge: the original load's FlyGenerators (2026-10-19)

**What `alm2` showed** (work item 10, [scoreboard](#scoreboard-2026-10-19-after-the-merge-of-the-island-batches)). The original's `ULevel::CleanupDestroyed`
purges `alm2`'s Deleted chain at 895 (128 actors, `Multitool0` one of them) and Play purged nothing by 900; in `las1` Play purged at 565, the original at 561.

**No destroy is left off Play's chain; Play lacked actors.** The purge contents are the original's `unhash` records at the purge tick (`"ev":"ret"`; the `enter`
records carry a `"ret"` field too, the return address, so a filter on that word counts each free twice) against the frees of Play's `objects-play<tag>.json`.
`las1`'s chain at 561 held 128 actors, `FlyGenerator0` among them. Play's at 565 held the same actors without `FlyGenerator0`, and with the next destroy,
`BloodDrop57`, in its place. (The first player's keyring is the original's `NanoKeyRing4` and Play's `NanoKeyRing2`, the known substitution [above](#first-original-captures-island-combat-2026-10-17).)
`alm2`'s chain holds two FlyGenerators, so Play's was two short at 895, and no other actor was destroyed by 900. These are the load's chance FlyGenerators:
`DeusExDecoration.PreBeginPlay` runs `if (bGenerateFlies && (FRand() < 0.1)) flyGen = Spawn(Class'FlyGenerator', , , Location, Rotation)` (DeusEx.u). The scenes'
frozen phase types `KillAll FlyGenerator` first, which destroys them there, and each `Destroy` links its actor into the chain (`script-destroy.mjs`,
ULevel::DestroyActor); only the 128th link starts a purge (`script-cleanup.mjs`, ULevel::CleanupDestroyed). The original's load drew one in `las1` and two in `alm2`
(`generators-load<tag>.json`, the capture's list taken before the KillAll). Play's seed-1 Island load draws none (`play-population.json`), so its replayed KillAll
destroyed nothing. Play's slot model already replayed their slots as pre-frees, because Play did not hold them. Every stored Island scene with a purge fits.
The ones with no load FlyGenerator purged on the original's tick (`cmb3` 821, `exp1` 352 and 384, `die1` 1105, `tA` 481, `tF` 421). Of those with one or two,
`las1`, `alm2` and `emp2` (430, 576, 769 for the original's 429, 574, 765) purged late. `kil1` and `tC` purged on time, because the chain passed 128 by more than one
link in the purge's tick (`kil1` 354: 132 frees, most of them an explosion's blood; `tC` 721: 171 actors at once).

**The fix is a measured host input** (`live-acceptance.mjs play`, `live-probe.mjs loadFlyGenerators`). When the early commands hold `KillAll FlyGenerator`,
the replay reads `generators-load<tag>.json`. Before it replays those lines, Play makes each of the original's load FlyGenerators the way the decoration's branch
makes it: the `bGenerateFlies` decoration standing at the generator's measured Location (to 0.01) spawns it with its own Location, Rotation and Instigator, and its
`flyGen` is written. They are made in name order, so Play's name counter gives the original's names. The replayed KillAll then chains them where the original's
did (the purge releases them in the original's order: every free equal in `alm2` and `las1`). The objectTrace seed gives them the registry dump's indices. Because
they were made before the seed, the model is also handed their measured slot (`madePending` in the replay's `object trace` line), so their purge frees are logged
and given back, as a pre-placed actor's measured slot is. (Since work item 11 the seed pairs every actor made before it with the dump's by creation order within
its class, not by name; for these the two orders give the same pairs, `FlyGenerator0=FlyGenerator0`: [load-made actors](#load-made-actors-paired-by-creation-order-not-by-name-2026-10-19).)

**Unmeasured, labelled.** Their load-time draws (PawnGenerator.PostBeginPlay's `Rand` and `FRand`) are Play's own and come before tick 1. The replay sets the stream
per tick, and the generators are gone before it starts, so no replayed tick depends on them. Nothing compares their state before the KillAll (the original's
frozen phase does not tick them). A decoration that made one holds a `flyGen` to a deleted actor until the purge clears it, in both programs.

**Open.** A load of Play's that makes FlyGenerators of its own gets none made: 04_NYC_Street at seed 1 makes ten, against `vents5`'s eight. Its KillAll chains Play's
own in their place, so the chains still differ there (work item 12; row 4.2.13, `vents5`, still passes). The same holds for any harness destroy of an actor only Play has,
such as the population step's `removed` (empty in every Island scene).

**Result** (the Mac, this branch; every scene with a load FlyGenerator replayed, plus `cmb3` and `exp1`):

* `alm2` PASS: `Trashbag0` and `Trashbag5` make `FlyGenerator0` and `FlyGenerator1` (the replay prints them); purge at 895 with 128, and every free over 900
  ticks equal in index and order (before: no purge by 900, `Multitool0` never released).
* `las1` PASS: purge at 561 (131 frees in that tick, as the original's), every free equal.
* `alm1`, `air1`, `cmb7`, `fK`, `dor2`, `fN`, `cmb6`, `gU`, `gP`, `kC`, `oT`, `gS` and `gN` PASS: no purge in their window, every free equal, and 0 creations
  in another slot.
* `kil1`, `tC`, `cmb3` and `exp1` PASS. `emp2` (0.87 units, item 8) and `cam1` (item 8) FAIL as before, at the same first difference; `emp2` now purges at 429, 574
  and 765 like the original, and 526 of its creations take another slot instead of 603.
* What `kil1` (394 creations in another slot), `tC` and `exp1` (143) still differed in was one free: the original releases a Shadow at the purge (`Shadow71`,
  `Shadow60` and `Shadow56`) and Play's free of it went unlogged. `exp1` has no FlyGenerator, so this predated the fix. The cause was not the missing hand-over
  this item first named but the seed's matching by name: **resolved by work item 11** ([load-made actors](#load-made-actors-paired-by-creation-order-not-by-name-2026-10-19)).
* Unchanged by construction at the time: the scenes with no load FlyGenerator, and row 4.3.6. Work item 11 changed the seed for every scene and replayed them all.

### Load-made actors: paired by creation order, not by name (2026-10-19)

**What was missing** (work item 11). `kil1`, `tC` and `exp1` (and, the baseline shows, `die1`, `tA` and `tF`) each lacked one free at a purge: a Shadow
(`Shadow71`, `Shadow60`, `Shadow56`, `Shadow72`) that the original releases and Play did not log. The item named a cause: Play made the Shadow at its load,
before the objectTrace seed, so the seed gave it the dump's index but not the model's slot, which only `madePending` actors received. Handing every such actor its
measured slot was the proposed fix. Tried on `kil1` (2026-10-19), that change made the frees worse: `Shadow71`'s free was still missing at 354, and at the 541
collection Play freed five Shadows and a `LaserProxy` under slots the original does not free there.

**A load-made actor's name does not name the original's object.** UObject::MakeUniqueObjectName names a new object with its class's counter
(`ClassUnique`, incremented for each name it makes, the trailing digits of the class name dropped: class `ThugMale2` names `ThugMale0`). The counter lives for the
session, so a name depends on everything the process made before. Play's boot leaves the counters elsewhere than the original's, class by class. In `kil1`'s
dump and Play's seed-1 population (`play-population.json`), the load-made actors are:

| Class | Play | the original |
| --- | --- | --- |
| Shadow (52 pawns' and the player's) | `Shadow53`..`Shadow105` | `Shadow20`..`Shadow72` |
| LaserProxy | 8..15 | 1..8 |
| LaserEmitter, LaserSpot | 5..9 | 0..4 |
| ParticleProxy | 4..7 | 0..3 |
| AutoTurretGun | 2..3 | 0..1 |
| NanoKeyRing (the replaced player's, the live player's) | 2, 3 | 4, 5 |
| the player's AugmentationManager, augmentations, skills, color themes, BarkManager, PlayerReplicationInfo | 1 each | 2 each |

The seed matched actors by `Class.Name` against the dump, which is right for a map export (the same name in both programs) and wrong for these. Play's `Shadow53`
took the slot of the original's `Shadow53`, another pawn's Shadow, and the original's `Shadow71`'s slot went to Play's `Shadow71`, which nothing destroys in
`kil1`. The original's own frees prove the identity. At 541 it releases `ThugMale3`, `ThugMale5`, `ThugMale7`, `ThugMale9`, `GuntherHermann0` and
`Shadow20`..`Shadow24`, and Play's destroyed Shadows there are `Shadow53`..`Shadow57`. The commander's Shadow, released at 354, is the original's `Shadow71`, the last
pawn Shadow its load made, and Play's `Shadow104`. That is the offset of 33 throughout. The first player's keyring, which the doc
[above](#first-original-captures-island-combat-2026-10-17) calls a substitution (Play's `NanoKeyRing2`, the original's `NanoKeyRing4`), is the same thing.

**The fix: creation order within the class** (`live-probe.mjs` objectTrace, `live-acceptance.mjs` `registrySeed` `classRows`). A map export keeps its `Class.Name`
match. An actor that Play's runtime created (a native record with a registry index), live or pending deletion, the player excepted, is paired with a row of the
dump: the same class, a name that is no pre-placed actor's, and the same rank by trailing number. The counter orders creation within a class in both programs,
and both run the same load code over the same map, so the k-th Shadow Play made is the k-th the original made. A class is paired only when both programs hold as
many. Otherwise it keeps no index, and the original's frees of its slots stay pre-frees. A paired actor takes the dump's index (`globalIndex`, which also numbers
its sounds' channel ids) and the model is handed that slot, so its purge free is Play's own, logged and given back. The replay's `object trace` line lists each
class (`Shadow 53 (53..105 = 20..72)`) and the ones left unpaired. On the Island those are `DeusExGameInfo`, `Mutator` and `GameReplicationInfo`, 1 in Play
against 2 in the dump: the original's Entry level holds one of each.

**Unmeasured, labelled.** The pairing assumes that both loads make each class's actors in the same order. The frees then test it: a wrong pair frees the wrong slot.
Why Play's counters stand where they do is not traced. Play's Shadows start at 53, consistent with a boot that loaded the Island once before the player start's
reload, and the original's start at 20; neither session's history before the load is measured (work item 13). A load-made actor of a class that the two loads make
in different numbers is left unpaired.

**Result** (the Mac, 2026-10-19; all 45 stored Island scenes that `validate-stage5-live.mjs` lists, replayed one at a time, and row 4.3.6). The frees are the
original's `"ev":"ret"` unhash records against `objects-play<tag>.json`'s frees.

* Every scene keeps its status: 42 PASS; `cam1`, `emp2` and `dor3` FAIL (item 8) with the same check line as before the change, and the same first
  free difference, and still 627, 526 and 524 creations in another slot.
* `kil1`, `exp1` and `die1` now release `Shadow71` (354), `Shadow56` (352) and `Shadow72` (1105) as the original does: Play's `Shadow104`, `Shadow89` and `Shadow105`.
  `kil1` keeps 0 of 1,547 creations in another slot (394 before), and `exp1` 0 of 1,634 (143 before). `exp1` and `die1` have every free equal in tick, index and order.
  `kil1`'s two collections are equal as well: 354's 132 frees in order, the first player's keyring now among Play's own, and 541's 480 as a set. So are `tC`'s, `tA`'s and
  `tF`'s (721: 410, 481: 407, 421: 414, `Shadow60` now among them).
* Those four still free the same set in another order at that collection. `AIReceiverEvent15` and `AIReceiverEvent16` existed at the frozen start, and Play does not
  hold them, so they are pre-frees. The original releases them 70th and 71st in the collection. The replay releases an AI event pre-free after the event manager's Tick,
  which falls at Play's 237th. That predates this item (`tC`, `tA`, `tF` in the baseline) and is a harness placement, not a destroy (work item 14).
* The other 38 scenes have every free equal in tick, index and order, as before. In every scene the only unpaired classes are the Entry level's three.
* Row 4.3.6 (`sndm5`, strict slots) PASS: 103 of 103 Galaxy calls with every channel id equal (11 from spawned emitters), 557 of 557 registry takes in class and slot,
  231 frees equal in order.
* Also rerun: row 4.2.13 (`vents5`) PASS. It replays no object trace, so the seed does not reach it. Its FlyGenerator count, ten in Play against the original's
  eight, would leave that class unpaired (work item 12). The unit tests pass (652).
* Not rerun: the other Stage 4 rows that replay live traces (4.1.5, 4.1.6, 4.1.7, 4.5.5; they replay no object trace either), the census, the full validator sweep and the
  `bench-sim` digests. The seed is harness code: only the replays with `--object-trace` read it.

### Collision over the tracked Level->Model (work item 8, 2026-10-20)

**The change.** ULevel::MultiLineCheck's world check is Level->Model's LineCheck (vtable slot 22) with the trace's extent, and ULevel::MultiPointCheck's
is its PointCheck (slot 21). While the moving brush tracker lives, Play's level queries now trace the tracker's model: MoveActor, SingleLineCheck, Trace and
TraceTexture, the AI's line checks, FindSpot (SpawnActor, FarMoveActor) and the walking surface scans, in JavaScript and in the Rust trace kernel (which imports
the tracker's node block once per tracker generation). A world hit's Item and its surface resolve in the same model, so a fragment's texture is its mover
polygon's. Player start drops the tracker before its LoadMap, as the original deletes it there, so the reset's actor start-up traces the static BSP. The
mechanism and its switch (`?trackedCollision=off`) are in [the brush tracker](brush-tracker.md#play), "Collision".

**Evidence.** `validate-tracked-collision.mjs`: Engine's unchanged UModel::LineCheck (box branch included, with the model's LeafHulls) and UModel::PointCheck under
Unicorn, at the game thread's 0x037f, on the tracker oracle's level model: the static BSP, after GNewBrushTracker, and after a frame that moves every mover half way
to KeyPos[1]. Island: 1,140 line checks and 3,420 point checks per state. Training: 1,500 and 4,500. Every Time, Location, Normal and Item is equal but one static
PointCheck recovery tie on Training that predates the tracker ([point check](point-check.md), "Recovery tie between a hull plane and its bevel"). The Rust
kernel over the tracked model agrees with the JavaScript bodies on 5,280 answers, one import per generation. An import costs 0.15 ms (Linux host, Island's
26,936 tracked nodes) on a frame after a mover moved.

**Result** (the Linux host, 2026-10-20; every stored Island scene replayed on the change, one at a time, with the Mac's stores):

* `cam1` passes: SecurityBot1's shot (tick 310) now ends at DeusExMover23's fragment, and its blood lands where the original's does. 5.2.4 passes (`cam1`, `cam2`).
  5.1.9 passes on `cam1`. Its second half, the turret shot down, has no capture (work item 9) and is labelled `weak`.
* The other 42 scenes keep PASS (`cmb1`..`cmb7`, `die1`, `hck1`, `las1`, `alm1`, `alm2`, `cam2`, `ko1`, `exp1`, `emp1`, the conversations, the gives, `tC`..`kC`,
  `fK`, `kil1`, `dor1`, `dor2`, `wat1`, `air1`).
* `emp2` is equal through tick 820, where it failed at 306 before. From 821 the original draws SecurityCamera3 again (LastRenderTime every frame) as its confused
  swing pitches it down (Rotation pitch 60022, 59296), and Play does not (its LastRenderTime stays at tick 51's). The player's row and the camera's Rotation are
  equal, so the frame's visibility of the camera's mesh at the frustum edge differs. 5.6.5 failed on it. **Closed by work item 16** ([below](#the-death-cameras-rotation-work-item-16-2026-10-20)):
  not a render-visibility gap but the camera Play viewed from: the player dies at 820, and the Dying state's view starts from the body's Rotation in the original.
* `dor3` is equal through tick 319: the rocket meets DeusExMover2's fragments and stops where the original's does. It differed from 320, in DeusExMover2's break
  (BlowItUp: 16 fragment attempts, `Spawn` at `spawnLoc + FragmentSpread * VRand()`, refused before AddObject when FindSpot fails): Play made 15 MetalFragments, the original 14.
  **Closed by work item 15 (2026-10-20): `dor3` passes** (131 actors, the clock, the stream draws, 1,707 AI events and 1,392 creations equal for 900 ticks). The CRT rand state at each original
  AddObject (the stored trace's `addobj` entries) against Play's after each FindSpot had lined the attempts up: attempts 0 to 4 equal, then the original 3 draws ahead at its sixth
  fragment (gaps 23 and 17 where Play's were 20 and 20), and the original's last fragment attempt 15. The sixth attempt starts inside the door: AdjustSpot's first probe (-X, flags 6) hits
  the door's fragments (world, time 0) and DeusExMover2 itself, and MultiLineCheck's mover recovery makes the mover hit's Time and Location NaN (the world hit at time 0 shortens the actor
  segment to zero length, so `1 / length` is +inf and inf × 0 is NaN, in the original's x87 as in Play; `validate-native-multiline` covers that case). AdjustSpot reads `Hit.Time < 1`
  with `fcomp qword [1.0]; fnstsw ax; test ah, 1; je` (0x103983b3..0x103983c1), and an unordered compare sets C0, so the original adjusts by `(1.05 − NaN) × Normal × Size` and the
  candidate becomes NaN; Play's `time < 1` is false for a NaN and skipped the probe. Engine's unchanged FindSpot under Unicorn on the replay's 16 inputs (the tracked Island model, the
  map's hash) **refuses attempt 5**: the later probes, the point check and the displacement test all run on the NaN and FindSpot returns 0 (the displacement `fcompp; test ah, 1` is C0
  for a NaN), so SpawnActor returns None before any object exists. The 3 draws are the VRand of the next attempt's location; the original's 14 fragments are attempts 0-4, 6-12, 14 and
  15 (5 and 13 refused). Nothing is created at a NaN location, so SpawnActor and the fragment's start-up never run on a NaN. See [NaN in FindSpot](fitting.md#nan-in-findspot-work-item-15-2026-10-20).
  5.3.10, 5.5.1 and 5.5.2 pass on it.

**Also checked:** the unit tests (652), `validate-trace-kernel` (79,090 cases), `validate-brush-tracker`, `validate-tracked-linecheck`,
`validate-fast-line-check-tracked`, and the census (below). A recapture of `dor3` under the Linux host's wine ran at about 2.4 s a tick and stopped
ticking at 146. The cause was the desktop, not the tracer: Hyprland tiled the game's window to another size, and WinDrv's window procedure then
re-created the D3D device over and over (the main thread's stack: WinDrv → D3DDrv → ddraw → wined3d), so `ULevel::Tick` was never reached.
`live-original.sh` now runs the prefix in a Wine virtual desktop (`DX_DESKTOP`, [Linux host](linux-host.md#known-gaps)). The user accepts a capture
from either machine (2026-10-20). A Linux recapture of `cam2` (`cam2lx`, 0.3 s a tick) replays in Play with all 75 actors equal for 300 ticks,
as the Mac's capture does. (Work item 15 needed no capture: the oracle gave FindSpot's answer.)

### The death camera's rotation (work item 16, 2026-10-20)

**Finding.** In `emp2` the player dies at tick 820 (`Dying` from that tick in both). The Setup probe (`STAGE5_PLAY_ARGS='--setup-probe SecurityCamera3 --setup-ticks
810:830'`) has Play's FDynamicSprite::Setup reject SecurityCamera3 at every tick from 810 to 830 (status 0; its view-axis Z drops from 309.6 to 288.9 at 820, the eye
height times the view pitch's sine). The view is the cause, not Setup. `DeusExPlayer`'s `state Dying` `PlayerCalcView` (not hidden yet) sets `FrobTime`, traces
190 units behind the camera with extent (12, 12, 2) and sets `CameraLocation` to the hit or the end. It never sets `CameraRotation`, so the frame looks along the
rotation the engine passed in. `UGameEngine::Draw` (Engine `0x1038f110`) builds that event's parameters at `0x1038f155..0x1038f1ac` from `Viewport->Actor`:
`ViewActor` = the actor, `CameraLocation` = its `Location` (`+0x114`), `CameraRotation` = its **`Rotation`** (`+0x120`), not its `ViewRotation`, and calls
`ProcessEvent` (vslot `0x10`) with `FindFunctionChecked(PlayerCalcView)`. Play's `game.view()` passed `ViewRotation` (pitch 59536, about 33 degrees down), which
leaves SecurityCamera3, 12 degrees above the player at 400 units, outside the frame's top edge. The original's frame looks level along the body's yaw (`Rotation`
pitch 0) and draws the camera from 821.

**Change.** `game.view()` starts `PlayerCalcView` from `Location` and `Rotation`, as `UGameEngine::Draw` does. The first-person, behind-view (`CalcBehindView`),
`ViewTarget` and `ConCamera` branches set `CameraRotation` themselves, so they are unchanged. Only the branches that leave it alone see the difference:
`state Dying` (its hidden branch sets only pitch and yaw, so its roll is now the body's) and the spy drone's frozen first-person view (`bSpyDroneActive`).

**Result.** `emp2` passes (78 actors equal for 900 ticks), and so does 5.6.5. The stored scenes where the player dies were replayed and keep their status:
`cam1`, `die1` (to the level's end at 1931), `kB` and `cmb3` pass, and `dor3` still differs first at 320 (work item 15). Before this change, the Dying view's trace
from `ViewRotation` hit the world at time 0 behind the player (`emp2`, normal (0, −1, 0)), so Play's camera stood at `Location`. That trace now runs along the
body's yaw instead, as the original's does.

### Fourth captures, on the Linux host: light, breath, movables (2026-10-20)

The first scenes captured on the Linux host under Wine (`live-original.sh` in the prefix's virtual desktop, about 0.3 s a tick), designed from the census
scenario and rehearsed in Play first (`stage5-capture-rehearsal.mjs`), then replayed with `validate-stage5-live.mjs` as the Mac's scenes are.

**Overheard speech.** Placed 500 units in front of Terrorist4, the player starts Terrorist4 and Terrorist27's overheard conversation. Its lines drive
`Pawn.LipSynch` (ScriptedPawn's `FirstPersonConversation.Tick`), whose mouth letters come from Galaxy's audio update, a host input the replay does not run. The
first replays differed only there: blend channel 0 (`MouthClosed` at Terrorist27's first line, tick 17) stayed `None` in Play. A scene's `speech: true` now
feeds the speakers' measured letters (`conversation-acceptance.mjs phonemes`, read back from the trace's channel-0 changes) without the player's conversation
flags, as the conversation scenes do.

| Scene | Pose and inputs | What the original did | Replay in Play |
| --- | --- | --- | --- |
| `lgt1` (5.6.3) | 500 units in front of Terrorist4 (5835, 2059), facing it, in shadow | the player's CurrentVisibility 0.0042; the overheard conversation runs on, and Terrorist4's EnemyReadiness stays 0 for 900 ticks | **PASS**, 74 actors (128 mouth letters fed) |
| `lgt2` (5.6.3) | 15 degrees over (5963, 2033), in the light | CurrentVisibility 0.0548; Terrorist4 leaves the conversation to seek at 138 and attacks at 274 (EnemyReadiness 1), Terrorist27 with it | **PASS**, 74 actors (21 letters) |
| `swm1` (5.3.8) | on dry ground at (−4761, 10431), then moved into WaterZone1 near the floor (−2802, 6641, −850) after the first unfrozen tick | PainTime 19.98 (UnderWaterTime 20), swimTimer 20 down to 0; out of breath at 1201, drowning takes 10 from the torso every 2 s (PainTime 2) until the player dies at 2162 | **PASS**, 74 actors, 2,400 ticks |
| `swm2` (5.3.8) | the same, at Z −450 (the census's depth) | the player sinks to −521, rises about 13 units a second and surfaces near 850 with about 6 s of breath left; swimTimer refills to 20 and he bobs at the surface, no damage | **PASS**, 74 actors, 1,500 ticks |
| `mov1` (5.3.12) | 70 units west of Trashbag0 (−3881, 10100), looking down at it; ParseRightClick at 30, DropItem at 120; set 380 units over the ground at (−4761, 10431) at 420 | the bag carried from 30 (Base the player), thrown at 120 on a falling arc, lands at 151 about 143 units on; the player lands at 472: the left leg 100 → 64, the torso 100 → 88, Health 92 | **PASS**, 75 actors |
| `itm1` (5.3.11) | 123 units west of SkillAwardTrigger1 (−5977, 1327) facing west; HealthTorso set to 40; a MedKit and then a Candybar summoned, picked up, put in hand (belt slot 1 both times) and used by Enter edges; at 450 set inside the trigger | the MedKit at 180: the torso 40 → 70, Health 92; the Candybar at 360: 72, Health 93; set inside the trigger the player never touches it (SkillPointsAvail stays 5000: `walk`'s SetCollision finds the overlap, and Touch needs a new one) | **PASS**, 75 actors (with the original's names, work item 13) |
| `itm2` (5.3.11) | `itm1`'s items; at 450 set 70 units west of the trigger's centre and given a console Velocity of 300 east (a drop from above lands on its roof) | physWalking's move carries him into it: SkillPointsAvail 5000 → 5025 at 455 ("Exploration Bonus") | **PASS**, 75 actors |

**Placements after the frozen phase.** The first `swm1` capture placed the player under water in the frozen phase. The original's player tick then spawned 112
AirBubbles and a WaterRing before the trace started, and the population check reloaded the map. `INTO(x, y, z, tick)` moves the player after an unfrozen
tick, between `ghost` and `walk` as `PLACE` does: Play refuses a console `set` of a colliding actor's Location ("Remove actor before changing its registered
location"), so a scene never relies on it. `--player-breath` traces PainTime, UnderWaterTime, swimTimer and swimDuration at Play's `slotOf` offsets (Health
and FrobTime, read the same way, match the offsets measured before). A scene over 1,500 ticks replays with a 12 GB V8 heap limit (`swm1`'s 290 MB trace
aborted the default heap, exit null).

### Captures on the Linux host: 00_Training (2026-10-20)

Training's rows (5.1.1, 5.3.4, 5.3.7, 5.3.2), each a scene designed from its census scenario, rehearsed in Play (`stage5-capture-rehearsal.mjs`, now with
`--props '@player=...'`), captured under Wine and replayed in Play. A placement is checked against the BSP first: a point outside the world (zone 0) makes
physWalking's zone-0 branch kill the player (5c01ccb), as it did at the first dark-room spot, inside the room's crates.

| Scene | Pose and inputs | What the original did | Replay in Play |
| --- | --- | --- | --- |
| `jmp1` (5.3.4) | at the obstacle course (6991, −55), facing −Y; Space edges at 30 and 150 | each jump leaves the ground at 284 units/s (PHYS_Falling); the first peaks at Z 64.17 at 49 and lands at 69, the second lands at 189 | **PASS**, 19 actors |
| `hzm1` (5.3.7) | by the HazMat suit's table, then moved into WaterZone0 (5574, −4011, −150) after the first unfrozen tick | entering the pool (bPainZone, DamagePerSec 20 Radiation; DamageTrigger1 around it) costs the torso 100 → 60 at tick 2, Health 90; swimming, nothing more in 700 ticks | **PASS**, 19 actors |
| `hzm2` (5.3.7) | HazMatSuit2 (6584, −4057) on its table in view; ParseRightClick at 40, ActivateBelt 1 at 80, an Enter edge at 120; moved into the pool at 180 (the suit's Charge traced: the `Pickup` device fields) | the suit picked up at 40 and activated at 120 (Activated, bActive); entering the pool costs the torso 100 → 70 (Health 92), the armor taking a quarter of `hzm1`'s 40; the Charge 2000 → 1960 at 181 and 1480 at 900, about 40 a second | **PASS**, 20 actors |
| `aug1` (5.3.2) | in the dark room (4600, 700), between darkdoor and darkdoor2 (the first spot, (4600, 760), is inside the room's crates: zone 0); an F12 edge at 60 | AugLight2 activates at 60: a DeusExLog message, Beam0 and Beam1 and a 'Beam' AI event the same tick; Energy 100 → 99.958 at 66, about 0.042 every 15 ticks after, 98.5 at 600 | **PASS**, 19 actors |
| `dlk1` (5.4.1) | clear of dl_door's DataLinkTrigger24 (−310, 841, radius 150) at x −488, slid in by a console Velocity at 30 (from −500 the 16-unit slide stopped 4 units short); at 90 set clear of dl_key's DataLinkTrigger4 (385, 849) and slid in at 92 | DL_door starts at 32 (DataLinkPlay0, its InfoLink display and ConHistory); DL_key, triggered while it plays, waits and starts at 532 when DL_door ends; the DataLink ends at 1389; DL_door_Played and DL_key_Played set | **PASS**, 19 actors, both flags equal |
| `cbr1` (5.1.1) | a WeaponCrowbar summoned, picked up and drawn; 70 units north of the Cratepick crates; Enter edges every 60 ticks from 200 | the upper crate HitPoints 10 → 4 at 222, destroyed at 282 (6 WoodFragments and a Lockpick); one crate left, Mission00.Timer starts DL_Lockpick at 301; the lower crate 10 → 4 at 342, destroyed at 399 (the same) | **PASS**, 21 actors |

### Object names at the seed (work item 13, 2026-10-20)

**Finding.** `itm1` (row 5.3.11) differed only in a name: the Candybar the console summons is Candybar3 in the original and Candybar4 in Play (the player's
FrobTarget, Inventory and inHand from tick 264). A spawned actor's name comes from Core's `MakeUniqueObjectName` (`0x101575b0`, via the export at
`0x1010263a`): `Class->ClassUnique` (`+0x488`, read at `0x10157655` and written back incremented at `0x1015766b`) gives the suffix, and a name an object
already holds under the same Outer is skipped. The replay already starts each class's counter from the original's first traced AddObject name (`classCounters`,
here 3). But Play's own load-made Candybar was named Candybar3 (Play's boot had made one more Candybar than the original's session), so the generated name was
taken and Play went on to Candybar4. The seed paired that actor with the original's Candybar2 by class creation order, for its slot, but kept Play's name.

**Change.** At the seed (`live-probe.mjs` objectTrace), each paired load-made actor takes the dump's name of the original's actor it stands for
(`renameRegisteredObjects`: every one leaves its hash chain first, then takes its interned name and enters the chain of (Outer ^ Name) & 0xfff at its head; a
name another registered object holds is kept and reported). The Island replays rename 185 actors (Shadows, LaserProxies, AutoTurretGuns, carcass items and the
like). `--own-names` keeps Play's names and Play's counters, as before. Validation only: Play outside a replay is unchanged.

**Result.** `itm1` passes (75 actors), `cam1` too. Every stored Island scene was replayed after the change (below in the scoreboard).

### O3: the original's code on Play's inputs (2026-10-20)

**What O3 is here.** A row of evidence class O3 claims that the native bodies a scene runs, given the inputs Play produced in that scene, compute what Engine.dll's code
computes. The O2 oracles run those bodies on fabricated cases; this check runs them on what the scene made. `scripts/validate-stage5-o3.mjs --scene ladder|crate-stack`:

1. **Record.** The census scenario of the row runs in Play, headless, with the recorder on (`src/runtime/o3-record.mjs`, off by default: a call site asks `o3.on` and,
   only when recording, runs the same body through `o3Body`, which wraps the pawn's service functions for the one call and restores them). Each call of a native body
   is captured with its entry state (the pawn's tracked state: Location, Velocity, Acceleration, OldLocation, Physics, bJustTeleported, bIsWalking, bHitSlopedWall,
   bCanJump, MoveTimer, Base; a decoration's: the same without the Pawn flags, with numLandings), the constants it reads (zone gravity, speeds, collision extent...),
   every service it called in order (MoveActor and line checks with what the world answered, WalkTexture, script events, the nested native bodies) with the tracked state
   before and after each, and its exit state. `scripts/o3-adapters.mjs` says, per body, what that is.
2. **Replay.** Each recorded call goes to the oracle driver of its body (`--o3` of `scripts/native-*-oracle.py`, with `scripts/native-o3-replay.py`): Unicorn runs the
   original instructions from the recorded entry state; each service thunk the original reaches is answered from the recorded call at that point of the sequence, and Play's
   state after that service is installed. A service the original calls that Play did not (or in another order) is a divergence, reported with both sides.
3. **Compare.** The native's service calls (kind, arguments, the tracked state at each) and its exit state against Play's, number by number with `Object.is` (float32
   bits, signed zeros). Scalars only: a mismatch prints the path of the first differing number.
4. **Controls.** The same replay with an input of the first calls of each body changed (a constant by 2^-12, relatively; for processHitWall, whose recorded calls all
   return at a gate, the gate's input) must differ from Play's outputs: the comparison sees what it claims to.
5. **A/B.** The scene again with the recorder off and Play's own Rust kernels on: a SHA-256 over the player's and the scene's decorations' (the plants apart) Location, Velocity, Physics
   and Acceleration at every tick must equal the recorded run's. Recording takes the JavaScript reference body where Play runs a kernel with no JavaScript service boundary
   to observe (`ACTOR_PHYSICS=js` for the decoration falling kernel; the surface scan in walking-surface.mjs), so the A/B also shows those Rust bodies agree with the
   reference on the scene. The player's own physics already runs in JavaScript (the pawn kernels decline a PlayerPawn).

What the original's code decides is therefore replayed; what the world answers is the recording. The answers are their own rows: MoveActor's mutation tail (BumpWall,
Bump, touches, zone changes), the line-check and MultiLineCheck results (work item 8's tracked-model oracles), the script events' bodies (UnrealScript the VM runs:
`GrabDecoration`, `DropDecoration`, `DeusExDecoration.Bump`, `Landed`, `HitWall`, `Falling`), and the native bodies below that are stubbed in the replay:
`SetPhysics` (0x103c95f0), `SetSupportBase` (0x103c9390) and `SetBase` (0x10369c80), whose O2 oracle covers `setWalkingPhysics` only (`validate-native-walking-callbacks`).

**Result** (Linux host, 2026-10-20; the first O3 proofs; both scenes pass, every call equal, every control differs, the A/B digests equal):

| Scene | Body (Engine.dll) | Where Play runs it | Oracle driver | Calls | Service calls |
| --- | --- | --- | --- | ---: | ---: |
| `ladder` (420 ticks) | surface prelude 0x103cc450, ordinary scan and the Ladder branch 0x103cc519..0x103cc6ca | `walkingSurfacePrelude` through the pawn view | `native-ladder-oracle.py` | 420 | 9,951 (9,357 line queries, 420 WalkTexture, 174 physFlying stubs) |
| | `physFlying` 0x103d3040 with calcVelocity, stepUp, TwoWallAdjust | `physFlying` from the Ladder branch | `native-flying-oracle.py` | 174 | 332 (253 MoveActor, 79 processHitWall) |
| | `physWalking` 0x103ca540 | `walking` | `native-walking-oracle.py` | 368 | 633 |
| | `physFalling` 0x103d0a50, Pawn path | `falling` | `native-falling-oracle.py` | 52 | 106 |
| | `processLanded` 0x103cef60, Pawn | `processLanded` | `native-landing-oracle.py` | 2 | 6 |
| | MoveActor 0x103990e0: query, filter, math | `moveQuery` | `native-move-query-oracle.py` | 370 | 301 |
| | `processHitWall` 0x103cecc0 | `processPlayerHitWall` | `native-walking-callbacks-oracle.py` | 79 | 0 (every call returns at a gate) |
| `crate-stack` (485 ticks) | prelude | as above | `native-ladder-oracle.py` | 486 | 18,468 |
| | `physWalking` (stepUp on a pushable decoration) | | `native-walking-oracle.py` | 443 | 1,817 |
| | `physFalling`: 62 decorations, 43 the player | `falling`, `runSpawnedActorFalling` | `native-falling-oracle.py` | 105 | 186 |
| | `processLanded`: 26 decorations (footprint block, Landed, SetPhysics), 2 the player | | `native-landing-oracle.py` | 28 | 85 |
| | `physRolling` 0x103d4b80 of the pushed crate | `runActorRolling` | `native-rolling-oracle.py` | 312 | 516 |
| | MoveActor query | `moveQuery` | `native-move-query-oracle.py` | 1,329 | 1,236 |
| | `processHitWall` (the player) | | `native-walking-callbacks-oracle.py` | 161 | 0 |

1,465 and 2,864 calls. The `ladder` scenario is `scripts/training-ladder-scene.mjs` (the census runs it through `validate-training-ladder.mjs`, unchanged). The
`crate-stack` scenario grew to what the row says Play can do from the player's inputs: the crate carried and dropped as before, then the player walks into the dropped
crate (DeusExDecoration.Bump on a settled decoration selects PHYS_Rolling and physRolling slides it from x 7252 to 7367) and runs and jumps onto it
(processLanded, SetPhysics(PHYS_Walking, crate), physWalking with the crate as Base). The census still says `plays` (`effect`: rolled, pushedTo, climbed, standingAt).

**Finding.** The replay of the pushed crate failed on the first call: the pre-state `OldLocation` of the first MoveActor differs (Play 7254.29, original 7252.22).
The original's `physRolling` stores `OldLocation = Location` with the Velocity stores (0x103d4d34: `mov [esi+0x12c], edi`) before the first MoveActor, and
`rolling.mjs` kept OldLocation in a local and never wrote the field. Fixed there (and in the field-backed host, `runActorRolling`); `validate-native-rolling` compares
OldLocation now and passes its 321 cases; the O2 corpus did not read the field, which is why only the scene's replay saw it. After the fix 312 calls are equal.

**What this does not establish.** The scenes' world answers (above); vertical stacking (a drop from the floor lands on the floor; not driven, so the row's "stack" is
carry, drop, push and climb, said in its `weak`); `bBounce` decorations, fragments, inventory and projectiles (the adapters refuse them: the crate scene has none);
fields outside the tracked state (Rotation, ViewRotation except the prelude's, the zone actors' own state); the scan's sine is read from the oracle's FGlobalMath table with its
measured entry (`HARDWARE_TRIG`). **Row 5.2.3's footstep half is not this mechanism and is not attempted:** `PlayFootStep` is UnrealScript fired by the Walk
animation's notify; its natives are the animation tick (the Rust actor tick has no JavaScript service boundary: it needs its own recording switch and the
`native-animation-tick-oracle.py` driver extended to recorded cases), `Trace`/texture group for the floor, `AISendEvent` (the event manager oracle, which needs the
`LoudNoise` events Play sends replayed with the CRT state) and `PlaySound` (Galaxy). The scene would be a held walking key through the fixture
(`driveLegacy`), which the original-side harness cannot post, so O3 is the only possible class there.

**Adding a body.** An adapter in `o3-adapters.mjs` (before, services, after), its driver's `--o3` method (state install, the service thunks answered through
`Replay.take`), an entry in `ORACLES` and `CONTROLS` of the validator, and the call site's `o3Wants`/`o3Body` hook.

### Captures: 00_TrainingFinal (2026-10-20)

The first captures off the Island: rows 5.2.1 (stealth maze), 5.3.13 (switch-driven movers), 5.4.8 (M00MeetPage and holo-Jaime) and 5.6.2 (the alarm chain), all on
`00_TrainingFinal`, taken on the Linux host under Wine (`live-original.sh`) and replayed with `validate-stage5-live.mjs --scene`. Each scene was rehearsed in Play first
(`stage5-capture-rehearsal.mjs --scene <tag>`, class P) to find the poses; all four passed their first replay, so none of them found a difference in Play.

The map is opened at PlayerStart0 (-501, -499) and the frozen phase types `KillAll FlyGenerator`. stl1 places the player in the frozen phase
(180 units from Soldier0: nothing spawns there); the others move him after the first unfrozen tick with `MOVE(tick, x, y, z, yaw, pitch)` (`ghost`, the Location SET, `walk` and the view, as `INTO`
does). The poses:

* **Switches.** A switch is a small collision cylinder (Switch1 2.6 x 2.2, Switch0 and Switch6 5.3 x 5.2), so the pose aims at its Location from the player's eye
  (BaseEyeHeight 40 above his centre, which lands at Z 31.8 on the first corridor's floor and 79.8 in the Bob and Jaime rooms). Switch1 faces -X and is
  hit from 50 units west of it at pitch -2712; Switch0 sits on the edge of a platform over the maze (the maze floor is 160 units under it) and is hit from 38.7 units west
  of it, 50.7 under the eye, at pitch -9588; Switch6 from 43 units west at pitch -1900. The rehearsal showed the margin: pitch -8000 and -11000 from Switch0's pose select
  nothing. The right button (`ParseRightClick`) is pressed once the frob target holds (HighlightCenterObject runs every 0.1 s).
* **The ConversationTrigger needs a walking player.** `ConversationTrigger.Touch` calls `StartConversationByName`, whose `CanStartConversation` refuses a `Falling`
  player (and `Level.bPlayersOnly`). A placement (`ghost`, SET, `walk`) leaves him Falling until he lands (the original's trace: Physics 2 from tick 2 to 15 in mpg1), and the Touch is delivered by the first move
  that overlaps the trigger: a player placed inside or dropped into the cylinder touches it falling, the call returns false and the trigger, not re-armed, never starts
  the conversation (the rehearsal's first tries did exactly that: dropped from Z 170 at tick 1 and at tick 100, and set at the floor). The harness cannot hold a key, so mpg1 sets him 122.5 units from the
  trigger (its radius 96 plus his 20 is 116), outside it, lets him land (tick 15), and at 150 sets his Velocity to (0, -300, 0): the next walking move crosses the
  boundary, the Touch finds him Walking and the conversation starts at 152 in both programs. A measured input in the sense of the O1 rows, not the player's walk.

| Scene | Pose and inputs | What the original did | Replay in Play |
| --- | --- | --- | --- |
| `stl1` (5.2.1, 5.6.2, 5.3.13) | in the frozen phase 180 units east of Soldier0 (469.8, 383.8) on the maze floor, facing it; at 900 set on the platform west of Switch0 (pitch -9588), the right button at 960 | Soldier0 Seeking 18, Alerting 34 (Enemy the player); at 221 it trips the four AlarmUnits of Tag StealthMazeAlarmUnit (bActive; Dispatcher1 in Dispatch); both soldiers' Alliance level toward the Player goes -1 to 1 at 222 (SoldierNeutral), Soldier0 is Patrolling again at 223; ElevatorMover1 KeyNum 1 at 223, y 48 to 112 over 223 to 282; the units stop at 820; DL_FailedStealth is played. Switch0 at 961 (Dispatcher0 dispatches): level back to -1 at 962, ElevatorMover1 KeyNum 0 from 963, Soldier0 sees the player on the platform (Seeking 981, Alerting 1001) and trips the alarm again at 1122, the door KeyNum 1 at 1124. Soldier2 patrols (Patrolling from 60) and never sees him | **PASS**, 23 actors, 1,250 ticks, 1,327 AI events, 177 creations, the flag DL_FailedStealth_Played |
| `sw1` (5.3.13) | on the first corridor's floor 50 units west of Switch1 (-195, -36), pitch -2712; the right button at 60 and at 220 | frob target Switch1 from 15; DeusExMover0 (FirstStealthDoor, TriggerToggle) KeyNum 1 at 61, interpolating to 121; the second press: KeyNum 0 at 221 to 281; Switch1 plays On, then Off | **PASS**, 17 actors, 360 ticks, 55 creations, no flags |
| `mpg1` (5.4.8) | set 122.5 units from ConversationTrigger1 (6577, -5309), Velocity (0, -300, 0) at 150, Enter edges at 190, 230, 270, 310 and 350 | the player lands at 15; the Touch at 152 puts BobPage1 and the player in Conversation (ConPlay0, M00MeetPage); five speeches (Bob, JC, Bob, JC, Bob); both leave it at 398 and M00MeetPage_Played is set | **PASS**, 15 actors, 520 ticks, 539 AI events, 173 creations, the flag (29 mouth letters fed) |
| `jmr1` (5.4.8) | 43 units west of Switch6 (7255, -4287.5), pitch -1900; the right button at 150 | JaimeAppears at 151 (FlagTrigger11); Mission00.Timer EnterWorld()s JaimeReyes6 at 181 (bInWorld 1, MS_ReyesUnhidden) and its radius conversation JaimeBark starts at 182 (first person, no input); it ends at 882 (JaimeBark_Played); the Timer LeaveWorld()s it at 901 (bInWorld 0, MS_ReyesHidden) | **PASS**, 16 actors, 1,000 ticks, 1,017 AI events, 84 creations, the four flags (61 mouth letters fed) |

**What the original showed beyond the census.** The census trips the alarm with a `Trigger` call and presses Switch0 from a fixture pose; the captures take the original's
own path, a soldier that sees the player. The soldiers are neutral after the alarm (Alliance level 1 toward the Player, `bNoNegativeAlliances` set at 223), so the
player's visit to the platform at 905 is not seen; the reset (Switch0 -> ButtonDispatcher -> SoldierHostile, OpenDoor, SoldierPatrol, SpecialEventMsg) turns them
hostile at 962 and Soldier0, on the maze floor 475 units away and 160 under him, sees him within 20 ticks (Seeking 981). The alarm chain ran twice with the same effects (the second at 1122, cut by the end of
the scene while the units ring).

**Harness.** `DEVICE_FIELDS.ElevatorMover` (KeyNum, PrevKeyNum, bInterpolating, PhysAlpha, PhysRate, `bIsMoving` and `bFollowKeyframes` at 0x534, masks 2 and 1; Play's slotOf on
ElevatorMover1) because the exit door is an ElevatorMover, not a DeusExMover (it has no doorStrength: the rehearsal's first run read it and stopped). `wholeFlags` compares the
player's whole FlagBase at the end of a non-conversation scene (stl1, sw1); the conversation scenes always do. The worktree needs `ad/tools/dxinput.exe` and
`ad/build/*.exe` (ignored, built once in the main checkout): a missing dxinput stops the capture at its first typed line after the game is up (`wine: failed to open`).

**What is not covered.** The player never walks (no held key): he is placed in Soldier0's view and on the platform, pushed into the Bob trigger, and set at the switches.
SecondStealthDoor (Switch2) is the same class and path as FirstStealthDoor and is not driven; an AlarmUnit tripped by a laser, a camera or a hack (`bDisabled`) is not
driven; the AllianceTriggers' own touch (radius 96 beside the alarm units) is not watched.

### Captures: windows, the bots and the terminals (2026-10-20)

Rows 5.3.3 (the repair bot and medical bot windows) and 5.3.9 (the Island's terminals), captured on the Linux host under Wine (`live-original.sh`) and replayed with
`validate-stage5-live.mjs --scene`, each scene rehearsed in Play first (`stage5-capture-rehearsal.mjs --scene <tag> --window`, class P). The harness posts key edges and
console lines, never a mouse position or a click, so the first job was the original's own keyboard path for a window.

**How a window is driven by keys.** Read from the scripts (`.cache/research/src`) and measured in the running original (`dump-actor-win` on `DeusExRootWindow`: the focus window
at +0x5c8, the mouse at +0x590/+0x594, the mouse window +0x5a0, the grab counts +0x5cc/+0x5d0), then reproduced in Play, whose window input chain is the recovered Extension.dll
code (`docs/script-window-input.md`):

* **The cursor never moves.** The root cursor starts at (0, 0) and only mouse events change it; none are posted, so in both programs it stays at (0, 0) with no mouse window
  (read from the original with the bot screen up: mouse (0, 0), mouse window None, both grabs 1). A `MFocus_Enter` or `MFOCUS_Click` window (`DeusExBaseWindow`, the Persona
  screens, `NetworkTerminal`) therefore never takes its focus from the mouse. Its first focus is the root's `CheckFocusWindow`: the top modal's preferred focus, else
  `MoveFocus(1, 1)`, the first traversable window of its tab-group table. The original's: Recharge when it is enabled (`PersonaActionButtonWindow1`; Close when it is not),
  the Augmentations tab on the Health screen (`PersonaNavButtonWindow0`), the user name field on a login, and after a login the first choice (`MenuUIChoiceButton0`) or the
  e-mail list (`MenuUIListWindow0`).
* **A button is pressed by Enter or Space.** `ButtonWindow.VirtualKeyPressed` calls `PressButton(key)` for IK_Enter and IK_Space (`HandleVirtualKeyboard`: the focus window,
  then its parents; the root's keyboard grab consumes the key before any binding). The window's own `ButtonActivated` runs as for a click.
* **The focus moves by the arrows and Tab.** `RootWindow.VirtualKeyPressed` (what no window handled): arrows are `MoveFocusLeft/Right/Up/Down` (natives 1442 to 1445), Tab
  `MoveTabGroupNext` (1446). The table is ordered by position: on the Health screen Right goes from the Augmentations tab to Exit and Up from Exit to Heal All (measured in the
  original: `PersonaNavButtonWindow0` -> `PersonaNavButtonWindow2` -> `PersonaActionButtonWindow2`), and on a login Tab cycles user name, password, the buttons.
* **A window's own keys come first.** `ComputerScreenSecurity.VirtualKeyPressed` takes the arrows (pan the camera), `1` to `3` (the views), `=` and `-` (zoom): the arrows never
  reach `MoveFocus`, so the choices (Door |&Access, |&Door Status, |&Turret Status) are pressed by their accelerators, Alt and the label's letter (`SetAcceleratorText`;
  `XModalWindow::KeyPressed` with IK_Alt held finds the window in the modal's accelerator table and calls its `AcceleratorKeyPressed`). The original's: Alt+A unlocked the cell
  door, Alt+T cycled the turret. The first choice, Camera Status, has the focus after the login and takes Enter.
* **Text is typed as WM_CHAR, not as key edges.** A text field takes `KeyPressed(char)` from WinDrv's WM_CHAR. `dxinput`'s posted WM_KEYDOWN is translated by the game's
  message loop (`TranslateMessage`), under the host keyboard layout: the Linux prefix's is French, whose unshifted digit keys type `à` and `&` (a Shot of the login read
  `nsfàà&` for NSF001), while letters and Tab, Enter, Escape, Backspace are layout independent. A scene therefore types its text with `@type TEXT` (dxinput `type`: WM_CHAR
  units, no key edge) and presses control keys and letters as edges.

**Harness.** `@type TEXT`; `AltLeft` and `Backspace` edges (`ad/tools/dxinput.c` knows ALT: the main checkout's `dxinput.exe` is older than its source and has no `focus` or
`PRINT` either, so a worktree rebuilds it with `i686-w64-mingw32-gcc`); `--typed-chars`, which makes the replay deliver `TranslateMessage`'s characters after the
WM_KEYDOWN of Tab (0x09), Escape (0x1b), Enter (0x0d: WinDrv drops it), Space and the letters (`src/viewer/typed-characters.mjs keyOfCode`); `--player-credits`; the device
groups `RepairBot`, `MedicalBot`, `ATM` (`$atmBalance0`: userList[0].balance, +0x3c8) and `Computers` (bOn, bAnimating, bLockedOut); `--window` in the rehearsal (the top modal
and the root's focus window, with the focused button's label); `--frames` and `@ctrlshot` frames for the terminals. Three harness faults surfaced:

1. **A rest height an ulp off.** med1 failed twice at tick 1 (the player's Z, 19.7999992 for 19.8000011, every tick) and passed five times: the settle step before the replay
   accepted a rest height within 1e-3 of the original's, and in the runs where the page's frames were ticks the landing's own arithmetic had already moved Z by one ulp.
   The step now compares the pose exactly in float32 and places the original's pose otherwise (`live-acceptance.mjs`, with the wait loop untouched).
2. **Which replays `validate-stage5-live.mjs` waits for.** It waited for any `live-acceptance.mjs play|compare --map M` process, so a replay of the same map in another
   checkout (its own `.work`) blocked this one; where `/proc` names a process's directory it now waits only for its own checkout's.
3. **Draw frames.** See the findings.

| Scene | Pose and inputs | What the original did | Replay in Play |
| --- | --- | --- | --- |
| `rpr1` (5.3.3) | 00_Training, 68 units in front of RepairBot0 (5078, 362, facing +Y) at pitch -5000; Energy set to 20 at 20; the right button at 60; Enter edges at 140, 220 and 370; the right button again at 290 | the bot Standing -> Idle when the window opens (StandStill, PlayAnim Start); focus on Recharge; Energy 20 -> 95 at 143 (chargeAmount 75; lastChargeTime 129.17) and the focus moves to Close; the second Enter closes the window (Standing at 223); the window reopened at 293 has Recharge disabled by the cooldown, its first focus is Close, and Enter closes it at 373 with no charge | **PASS**, 19 actors, 541 AI events, 161 creations, 520 ticks |
| `rpr2` (5.3.3) | `rpr1`'s first visit, then 60 s of Level time: Energy set to 30 at 3760, the right button at 3800, Enter at 3880 and at 3960 | Recharge enabled again when the window opens at 3803 (the first charge's lastChargeTime 132.50; ready past Level time 192); Energy 30 -> 100 at 3883 (capped by EnergyMax: 70, not 75), lastChargeTime 194.84, 62.3 s after the first | **PASS**, 19 actors, 4,020 ticks |
| `med1` (5.3.3) | 00_Training, 70 units in front of MedicalBot0 (5105, -4170) at pitch -6000; HealthHead 70, HealthTorso 40, HealthLegLeft 50 by `DamagePart` at 21 to 23; the right button at 60; ArrowRight at 140, ArrowUp at 170, Enter at 200, Escape at 260; the torso damaged to 60 at 300, the right button at 320, Alt+E at 400, Escape at 470 | HUDMedBotHealthScreen with the focus on the Augmentations tab; Right: Exit; Up: Heal All; Enter at 203 heals every region to 100 (healAmount 300, lastHealTime 129.01); Escape closes it (the bot Standing at 263); reopened at 323 with the cooldown on, Alt+E (the accelerator of "H\|&eal All") presses nothing and the torso stays 60 | **PASS**, 19 actors, 581 AI events, 1,178 creations, 560 ticks |
| `trm1` (5.3.9) | Island, ComputerPersonal0 (-4335, 1953, facing +Y), the player 57 units in front at pitch -7500; the right button at 100; `@type KLloyd`, Tab, `@type wrongpw`, Enter at 200 to 260; KLloyd/squishy at 300 to 360; ArrowDown at 420; Escape at 480; GUEST/GUEST at 520 to 580; Escape at 640 and 680 | the Activate animation (bAnimating 103 to 109) and the login; the wrong password clears both fields; KLloyd opens the e-mail screen (two messages: `01_Email01` shown, ArrowDown selects `01_Email07`); Escape logs out; GUEST opens "No Email Today!"; the second Escape closes the terminal, which runs its Deactivate animation (683 to 689) and is Off | **PASS**, 75 actors, 1,112 AI events, 1,059 creations, 527 GCs in both, 720 ticks, the mouth letters of UNATCOTroop6's bark fed |
| `atm1` (5.3.9) | Island, ATM0 (2105, 1080, facing -Y), 56 units in front; the right button at 100; 230023 with PIN 1111 at 200 to 260, with 4558 at 300 to 360; `@type 50`, Enter at 420 to 440; Escape at 500 and 540 | ATM0 has no animation: ATMWindow opens at once with the focus on the account field; the wrong PIN clears both; the right one opens the withdraw screen (balance 200); the withdrawal: DeusExPlayer.Credits 500 -> 550 and ATM0's userList[0].balance 200 -> 150 at 443; Escape logs out, Escape closes | **PASS**, 75 actors, 1,161 creations, 600 ticks |
| `sec1` (5.3.9) | Island, ComputerSecurity1 (2018, -1645, facing +Y), 56 units in front; NSF001/smashthestate at 200 to 260; Enter at 320; Alt+A at 380; Alt+D at 440; ArrowLeft at 520, ArrowUp at 560; Alt+T at 600, 620 and 640; Escape at 700 and 740; the player takes no damage (`ReducedDamageType All`: Terrorist18, in the room, sees him (Seeking at 100, Alerting at 136) and attacks from 526) | the first focus is Camera Status (Enter changes no camera state); Alt+A unlocks DeusExMover10 (bLocked 1 -> 0 at 383), Alt+D opens it (KeyNum 1, interpolating 443 to 503), the pans move the camera's DesiredRotation, the turret AutoTurretSmall0 wakes at 526 on the camera's alarm (StatueAlarmTriggered) and the three Alt+T presses leave it Disabled (bDisabled 1 at 643) | **PASS**, 78 actors, 1,231 AI events, 1,468 creations, 760 ticks |
| `trf1`, `atf1`, `sef1` (5.3.9) | the three scenes' inputs again, with Brightness 2/3 and the original's Shot (`@ctrlshot`, Ctrl+F9 under the terminal's keyboard grab) at held ticks: trf1 at 280 (the wrong password), 380 (the first e-mail), 440 (the second), 600 (no e-mail); atf1 at 280 (the wrong PIN), 380 (the withdraw screen), 460 (withdrawn); sef1 at 290 (the security screen), 480 (door unlocked and open), 670 (turret disabled) | the actor traces equal the first captures' (the screenshots' key events change nothing); the frames, 1280 x 720, against Play's frame at the same tick (`--frames`: one replay per frame) | traces **PASS** (75, 75, 78 actors); frames: trf1 b, c, d and atf1 a, c identical to the pixel; trf1 a and atf1 b differ by 20 pixels each, the text caret (in one the original's, in the other Play's: it blinks on the host's clock); sef1: with the two "NO SIGNAL" static windows masked, 99.8% identical, 44 to 59 pixels over 10 of 255 (max 96) in the camera 1 window, the chrome identical |

**Findings.** No behavior of Play's windows, terminals or bots differed from the original in these scenes (every watched field of every watched actor is equal for every tick).
The replays' differences were in the harness and in what the registry comparison can judge; each is a measured fact of the original:

1. **The original draws no window in a held frame it does not complete.** The tracer holds a level by returning from `ULevel::Tick`; a hold is a run of frames (input pump,
   `RootTick`, the held level, the draw). In med1's hold at tick 200 the original ran the Enter press and release, one `roottick` frame (0.441 s)
   and then tick 201; the 43 GCs of the Health screen's new region windows (their layout: `QueryPreferredSize`'s `GetGC` per window) came after tick 201's AI process. After a
   console line (med1's `ParseRightClick` at 60) there were two frames: `roottick` 0.592 s, the 144 GCs of the new screen, `roottick` 0.275 s, tick 61. Play's three warm frames after
   every command drew at once, so the same GCs came one tick early. With `--typed-chars` a frame after a command paints only if a complete held frame follows it
   (`roottick` records after the command, before the next command or tick: all of them when the next is a command, one fewer before a tick; `live-probe.mjs` `noPaint`).
   rpr1, rpr2, med1, atm1, atf1 pass their creations strictly with it. In the terminals the first draw after a window opens or closes lays out some windows and the next
   frames the rest, so a GC lands a tick or a few windows from where Play makes it: trm1, sec1 and sef1 (`drawTiming`) compare the GCs as totals (527 = 527, 402 = 402, running
   counts within 1) and every other creation in class, tick and order.
2. **The first e-mail loads the class ExtString.** `DeusExTextParser.OpenText` is `StaticLoadObject(XExtString, "DeusExText.<name>")` (docs/script-text-parser.md): the
   original's first read creates the class ExtString (its 21 functions, parameters and properties: 22 registry objects, in the slot of a freed object) and each text is an
   ExtString it creates, reads and deletes (`01_EmailMenu_klloyd`, `01_Email01`, `01_Email07`): 25 creations. The first capture's replay found Play making none of them (the
   creations differed at the first, 1,016 of 1,586). Master's XExtString registry model (the `kpd1` work, `ScriptRuntime.modelExtStringLoad`) makes them: trm1 replayed on the merged
   branch compares all 1,059 non-GC creations equal in class, tick and order (no exclusion), and 13 take another slot (50 to 57 before the model).
3. **A barking trooper's mouth.** UNATCOTroop6, 207 units from the player, barks from tick 49; Pawn.LipSynch's letters (blend channel 0) are the audio update's, a host input
   (`speech: true` feeds the measured letters, 29 here), as in the other Island scenes.
4. **The caret.** A focused edit field's caret blinks on the host's clock: in `trf1a` the original's frame holds it and Play's does not, in `atf1b` the reverse, 20 pixels each time.
5. **Static.** A camera-less view shows random static in both programs: not comparable.

**What is not covered.** The mouse: no click, no hover, no pointer focus (an `MFocus_Enter` window would take its focus from the pointer's position); the buttons are pressed through
the keyboard route above, which is the same `ButtonActivated` as a click's. The augmentation screen the medical bot opens first when an AugmentationCannister is carried, the
per-region Heal buttons, the security views' selection keys (the screen has one camera) and zoom, hacking a terminal (the hack screens), the special-options screen and the ATM's
lockout and disabled screens are not driven. The terminals' frames are of the held tick, not of the moving windows (the camera image's static and the caret aside, their chrome is
identical); the camera's own image is the Security cameras' frames (docs/visual-acceptance.md). A key edge's `WM_CHAR` is delivered for the keys listed above only: a digit key's
character depends on the host's layout, and no scene presses one.

```bash
# the original (the Wine lock): each scene, then the replay; the frames' replays one per frame
.work/capture-and-replay.sh rpr1 rpr2 med1 trm1 atm1 sec1 trf1 atf1 sef1       # captures and replays one by one, logged in .work/captures/
node scripts/validate-stage5-live.mjs --scene sec1                             # the replay and its checks
node scripts/validate-stage5-live.mjs --scene sef1 --frames                    # the screens' frames
node scripts/stage5-capture-rehearsal.mjs --scene sec1 --window                # Play alone: the window and focus per tick (class P)
```

### Fifth captures: 00_TrainingCombat (2026-10-20)

Rows 5.1.2, 5.1.3, 5.1.4 and 5.4.2, captured on the Linux host under Wine and replayed with `validate-stage5-live.mjs` as the Island scenes are. The map has 9 ScriptedPawns (four
`UNATCOTroop` instructors, two `SecurityBot2`, two `MedicalBot`), all traced per tick, and its own devices. The player's start (`PlayerStart0`, (−775, 4)) touches nothing, so the
frozen phase types only `KillAll FlyGenerator`; **every approach is a drop after the first unfrozen tick** (`INTO`: `ghost`, a SET of Location, `walk`), because a player placed inside a
trigger's cylinder touches nothing and one that falls into it does ([item 6 above](#third-captures-the-routes-the-doors-and-the-mission-2026-10-18)). The ranges' data, from the map and `Mission00`:

* `DataLinkTrigger2` (65, −544, radius 100) plays `DL_TArgetRange` and `DataLinkTrigger8` (1061, −542, radius 96) `DL_RifleRange` (about 840 and 750 ticks of speech). The last event of each
  triggers the counter's cover (`DeusExMover44` Tag `BallisticStore`, `DeusExMover67` `BallisticStore2`: 34 units up in a second; a closed cover is the right button's FrobTarget over the weapons) and the
  cover over the first station's switch (`DeusExMover1` Tag `shield1`, `DeusExMover29` `shield3`).
* The station switch (`Switch3`, `Switch0`; Event `guntarget1`, `rifletarget1`) slides the target mover (`DeusExMover4`/`32` with `BreakableGlass0`/`2`, `doorStrength` 0.5 and 0.25) in from y −3280 to −1216
  in 240 ticks; its `MoverCollider` passes the four `DirectionalTrigger`s that open the blast door (`DeusExMover7`/`21`). The glass's `Event` (`shootplay`, `rifleshot1`) starts `DL_TArgetRangeShot1`
  (about 1,200 ticks) and `DL_RifleRangeShot1`, whose played flag `Mission00.Timer` turns into `SkillWeaponRifle.CurrentLevel` 3.
* The drop heights follow the cylinders: `DataLinkTrigger2`/`8` span z −160 to −80 (the player falls in from z −30, where the cell of the trigger's centre is open), `FlagTrigger2` (561, −79, radius 200) spans −96 to −16
  and the corridor in front of it (y −40) has the headroom for a drop from z 28 and up (a player placed at z 10 inside it touched nothing; at its centre (561, −79) the player rests on a sill at z 4, under a low ceiling).

| Scene | Rows | Pose and inputs | What the original did | Replay in Play |
| --- | --- | --- | --- | --- |
| `rng1` | 5.1.2 | dropped into `DataLinkTrigger2` at the weapon counter (−8, −515) at 1; the right button at 935 (looking at `WeaponPistol0`, pitch −5400) and 975 (`Ammo10mm0`, pitch −2800); `ActivateBelt 1` at 1010; dropped at the station (24, −590) at 1060 looking at `Switch3` (pitch −8700), the right button at 1120; aimed at the glass (yaw 48752, pitch −200) at 1380, six Enter edges 60 ticks apart from 1400 | `DL_TArgetRange` from 8 to 934; at 846 `DeusExMover44` and `DeusExMover1` open (906 done); pistol taken 936 (Pickup, Idle2), box 976 (destroyed into the stack), drawn 1011 (Active, Idle 1045); `Switch3` at 1121 slides `DeusExMover4` and the glass (1121 to 1360) and opens `DeusExMover7` (1139 to 1199); the edges hit the glass from 1401: `doorStrength` 0.5, 0.34, 0.18, 0.02, broken at 1581 (`bDestroyed`, moved up 20,000); `DL_TArgetRangeShot1` plays 1581 to 2780 (its played flag at the end); ClipCount 1 to 6, NormalFire 36 ticks each, Reload from 1718 to 1900 | **PASS**, 18 actors for 2,800 ticks, clock, stream draws, 2,879 AI events and 207 creations, both flags at the end |
| `rng2` | 5.1.2 | `rng1` plus the second lane: `Ammo10mm1` taken at 1000 (yaw 35000, pitch −2750), the aim set again 10 ticks before each Enter edge; dropped at the second station (106, −590) at 2950, the right button at `Switch13` at 3010, eleven edges from 3270 aimed at the glass 1,202 units off (yaw 49344, pitch −104) | lane 1 as in `rng1` (broken at 1581); `DL_TArgetRangeShot1`'s last event opens `DeusExMover28` at 2692; `Switch13` slides `DeusExMover5` and `BreakableGlass1` in (3011 to 3251, to y −1792); the edges hit from 3271: 0.5, 0.34, 0.18, 0.02, broken at 3451; `DL_TArgetRangeShot2` plays 3451 to 3832. The scene's first capture aimed once: three hits in six, the glass stayed at 0.02, `DL_TArgetRangeShot1` never played, lane 2 never opened (replay equal all the same; not the proof) | **PASS**, 23 actors for 4,100 ticks, 4,294 AI events, 413 creations, the 3 DataLink flags |
| `lam1` | 5.1.4 | a `WeaponLAM` and a `WeaponPistol` summoned and picked up at (3000, 1700) facing away from `BreakableWall1` (3000, 1836); the LAM drawn at 160; dropped at (3000, 1805) facing north (32 units from the wall) at 190, an Enter edge at 260; dropped 150 units south at 360, `ActivateBelt 2` at 400, Enter edges at 480, 540, 600, 660, 720 | `WeaponLAM0` `bNearWall`, NormalFire from 261 (the Place animation); `LAM5` appears on the wall at 285 (3000, 1829.5, −8.3, Flying) and the spent weapon is destroyed at 304; the pistol's edge at 600 hits the LAM: Exploding at 601, `BreakableWall1` `doorStrength` 0.4 to 0, `bDestroyed`, moved up 20,000 the same tick; the player (150 units off) is hurt at 606 (Health 100 to 77); `DL_FinishWall` plays 601 to 1649 | **PASS** since the `ProcessState` fix below, 13 actors for 1,700 ticks, 1,839 AI events, 363 creations, the flag at the end |
| `rif1` | 5.1.3 | dropped into `DataLinkTrigger8` at the rifle counter (984, −590); the right button at 850 (`WeaponRifle2`, pitch −5000) and 900 (`Ammo0`, yaw 35500 pitch −4500); `ActivateBelt 1` at 930; dropped at the station (1016, −590) at 960, the right button at `Switch0` at 1020; aimed at the glass at 1300; `ToggleScope` at 1310; Enter edges at 1380 and 1520 | `DL_RifleRange` 8 to 850, the covers `DeusExMover67` and `DeusExMover29` open at 762; rifle taken 851, drawn 931 (Idle 953); `Switch0` at 1021 slides `DeusExMover32` and `BreakableGlass2` in and opens `DeusExMover21` (1037); `bZoomed` at 1311, `DesiredFOV` 75 to 10, `FOVAngle` 75, 68, 61, 54, 47, 40, 33, 26, 10 (1311 to 1318); the first edge fires (1381, NormalFire 90 ticks) and the one hit takes the glass from 0.25 to 0, `bDestroyed`; `DL_RifleRangeShot1` plays 1381 to 2049 and `SkillWeaponRifle.CurrentLevel` goes 0 to 3 at 1981; the second edge fires at 1521 | **PASS**, 18 actors (the skill included) for 2,150 ticks, 2,209 AI events, 158 creations, both flags |
| `ins1` | 5.4.2 | a pistol, a MedKit and a LAM summoned and picked up facing east at the start place (61, 121, 181); dropped into `FlagTrigger2` (561, −40, from 40 units up) at 245; to (800, 0) at 560 and again into the trigger at 600 | `MunitionsTrooperReady` true when the fall enters the cylinder (255); `MunitionsTrooperTake` starts at 273 (`ConPlay0`, `UNATCOTroop3` in `FirstPersonConversation` to 523): the 29 `TransferObject` events move `WeaponPistol5` and `WeaponLAM0` to the trooper, whose chain grows by 17 items, and the conversation clears Ready (`MunitionsTrooperTake_Played`); the player keeps `AmmoLAM0`, `MedKit0`, `Ammo10mm5` and the key ring until `Mission00.Timer` (Ready true again from 600, inside the 10 s gate of the radius conversation) removes the rest at 661 | **PASS**, 10 actors for 900 ticks, 920 AI events, 103 creations, the 2 flags at the end |
| `ins2` | 5.4.2 | `ins1` without the second drop (to 1,000 ticks) | the Take as in `ins1` (273 to 523); the player stays in the trooper's radius with Ready cleared, and after the 10 s gate the radius greeting `MunitionsTrooperFrob` (`ConPlay1`, "You aren't done yet...") plays 823 to 917 (`MunitionsTrooperFrob_Played`) | **PASS**, 10 actors for 1,000 ticks, 1,018 AI events, 126 creations, the 3 flags at the end |
| `led1` | (the finding below) | dropped at (850, −20, 10) at tick 1, nothing else | the player falls onto the ledge and `processLanded` relocates him and adds the random horizontal velocity at tick 28 | **PASS** since the `appFrand` fix, 10 actors for 700 ticks |

**What the replays found.**

1. **A destroyed actor's state code stops** (`lam1`). The spent `WeaponLAM` destroys itself in `AnimEnd` (`state NormalFire`: a thrown weapon out of ammo `Destroy()`s). The original's `WeaponLAM0` stays in NormalFire with
   `bReadyToFire` 0 from there; Play ran the code after `FinishAnim` in the same tick (`ReadyToFire`, `Finish`, Idle). `AActor::ProcessState` (Engine.dll `0x103e5b60`) returns before it polls the latent action when
   `IsPendingKill` (virtual `+0x2c`, `AActor`'s body `0x1030df80`: `bDeleteMe`) is true (`0x103e5bb3`), and tests `bDeleteMe` (`Actor+0x28`, `0x80`) before each state opcode (`0x103e5c16`). `ScriptState.process`,
   the compiled loop (`resumeCompiled`), the reference engine and the Rust driver's `resumeState` now stop the same way, and a unit test pins the destroyed path. The Island's `exp1` and `dor3` (a rocket breaking a door, an
   exploding crate chain) and `rng1` still pass.
2. **A skill's number follows the process** (`rif1`). `SkillWeaponRifle0` is Play's, `SkillWeaponRifle2` the capture's (the player's `SkillManager` is created at each load, like `JCDentonMale`). A device named `Stem#`
   (`SkillWeaponRifle#:Skill`) is resolved to the original's name by the capture and found by `~Stem` in Play; `SkillManager` joins the numbered owners the comparison takes by stem.
3. **The ranges' geometry decides the inputs.** The weapons lie behind a cover that rises only when the DataLink ends (a frob before it targets the cover, `DeusExMover44`); the second pistol lane's target stops
   at y −1792, not −1216, and the pistol's recoil lifts the view 150 units a shot (rehearsed in Play, class P: one hit in eighteen shots without re-aiming, the glass broken at the fourth with the aim set again before each shot).
4. **appFrand is not a float32 in the landing** (`ins1`'s first capture, scene `led1`). Dropped at (850, −20), east of the corridor, the player falls 90 units onto a ledge that does not fit him: `processLanded` finds the
   support probe clear, `FindSpot` moves him up 2.3 units and the landing adds `appFrand() * 60 − 30` to each horizontal velocity component (`0x103cf52d`–`0x103cf587`: `fst` stores a copy and the arithmetic goes on
   with ST0, one `fstp` into `Velocity`). At tick 28 the original's `Velocity.X` is −15.166173 (f32 of 8101 · f32(1/32767) · 60 − 30), Play's was −15.1661739: the pawn physics service rounded the draw to float32
   (`Math.fround(rng.frand())`, `script-runtime.mjs`) before the expression. The draw is a 15-bit integer times a float32, exact in binary64 as the steps after it; the service now returns it unrounded. `led1` (the drop at
   the ledge, 700 ticks) passes, with `ins1`'s first capture's numbers as its unit test's reason; a unit test pins the service.

### Captures: Training phase 1 (2026-10-20)

Row 5.3.1, one scene per interaction of the route from `PlayerStart1` to `DL_part2`, captured on the Linux host under Wine and replayed with `validate-stage5-live.mjs`. The poses come from the map
(`near`/`list` of the placed actors) and the route probe (`training-probe-lib.mjs`, group `route`), the approaches from the rehearsal (`stage5-capture-rehearsal.mjs`, `--props '@player=Location,EyeHeight'`:
the player rests at z −80 on the start floor, −120 by the trainer door and −144 in the rooms at the key, the datacube, the keypads and the Multitool; the eye is 40 above). Every point was checked against the
BSP (`zone-at`): the first Multitool pose, south of its table at (2241, 530), is zone 0 and kills the player (the table's room opens to the north). `cbr1` (the crowbar and the crates, row 5.1.1) and `aug1`
(AugLight in the dark room, row 5.3.2) are reused from the earlier captures; the repair bot's window is row 5.3.3's.

**The capture opens the map directly.** `Mission00.FirstFrame` runs only when `PlayerTraveling` is set (`MissionScript.Timer`), and a map opened by `live-original.sh` never sets it, in the original and in the
replay (which deletes the flag Play's login adds). So the cadet is not knocked out (`TakeDamage(1, 'KnockedOut')`, `bNotDead`) and `UNATCOTroop2` stays `Standing`; `cad1` kills him with the Tantalus cheat, as
`cmb5` does for a Terrorist. The body that is searched, carried and dropped is a dead carcass; `DeusExCarcass.Frob`'s search, `POVCorpse` and the drop are the same code.

| Scene | Pose and inputs | What the original did | Replay in Play |
| --- | --- | --- | --- |
| `key1` | (−330, 832) facing +X, 110 units from the start door `DeusExMover16/17`; right button at 30; placed (415, 1010, −144) looking down at `NanoKey0` (415, 1072, −145), right button at 240; placed (384, 640, −120) at the trainer door `DeusExMover47/48`; `ActivateBelt 0` at 340, Enter edge at 400, right button at 460 | both panels slide open (KeyNum 1 at 31, done 151); `NanoKey0` FrobTarget at 203, destroyed at 241 (`PickupNanoKey`: `NanoKeyInfo0`); the key ring (`NanoKeyRing`, slot 0) in hand at 341; the Enter edge toggles `bLocked` 1 → 0 on both panels at 401 (lockStrength 1: not pickable, key `Train`); the right button opens them (KeyNum 1 at 461) | **PASS**, 24 actors, 587 AI events, 43 creations, 560 ticks |
| `pik1` | (1240, 144, −85) facing +X, 72 units from the gun door `DeusExMover45/46` (Tag `gundoor`, locked, pickable, lockStrength 0.05); bare right button at 10; turned west and down at 14, `summon DeusEx.Lockpick` at 20, right button at 90 (the pickup), `ActivateBelt 1` at 130; turned to the door at 170; Enter edge at 210; right button at 700 | the bare right button leaves it locked; the Lockpick in hand at 131; the Enter edge sets `bPicking` on the frobbed panel `DeusExMover46` at 211 (`pickValue` 0.1, `numPicks` 10, `TicksPerPick` 4, `curPick` `Lockpick0`); lockStrength 0.04 at 240, 0.03 at 264, 0.02 at 288, 0.01 at 312, 0 at 336 (a step every 24 ticks), when both panels unlock and the Lockpick (NumCopies 0) is used up; the right button opens the pair (KeyNum 1 at 701) | **PASS**, 22 actors, 822 AI events, 40 creations, 800 ticks |
| `kpd1` | (1566, 860, −144) facing −X looking down at `DataCube0` (1496, 860, −147); right button at 30 and 90; placed (1950, 880, −144) facing `Keypad0` (1998, 940, −55, Event `paddoor`); right button at 200; key edges `Digit0`, `Digit0`, `Digit1`, `Digit2` at 240, 260, 280, 300 | `infoWindow` (the HUD's `HUDInformationDisplay`) and `aReader` set at 31 with the parser, seven paragraph `TextWindow`s, `DeusExNote0` and a log line; both cleared at 91 by the second frob; at 200 `HUDKeypadWindow` opens; the fourth digit validates `0012` and triggers the paddoor pair `DeusExMover26/18` at 301 (KeyNum 1, still `bLocked`), done 421 | **PASS** since the fix below, 23 actors, 541 AI events, 159 creations, 520 ticks |
| `hkp1` | (2241, 670, −144) facing −Y looking down at `Multitool1` (2241, 600, −147); right button at 40, `ActivateBelt 1` at 80; placed (2510, 880, −144) facing `Keypad2` (2558, 940, −55, Event `hackdoor`, hackStrength 0.05); Enter edge at 180 | `Multitool1` in hand at 81; the hack starts at 181 (`bHacking`, `numHacks` 10, `hackValue` 0.1, `TicksPerHack` 4; the Multitool `bBeingUsed`); hackStrength 0.04 at 204, 0.03 at 228, 0.02 at 258, 0.01 at 276, 0 at 306 (steps of 23, 24, 30, 18, 30 ticks); the Multitool is used up and the hackdoor pair `DeusExMover37/38` opens at 307 | **PASS**, 23 actors, 543 AI events, 113 creations, 520 ticks |
| `cad1` | (3500, 849, −80) facing +X; `Tantalus` at 20 (the cadet, `UNATCOTroop2` at (3652, 849)); placed (3610, 849, −80) looking down at the carcass at 110; right button at 150 and 190; placed (3688, 478, −100) facing −Y, 100 units north of `Trigger0` (3688, 378, −40, `TT_ClassProximity`, Event `bodydoorsopen`) at 250; Tab edge at 300 | the cadet is `Dying` at 21 (Health −1) and `UNATCOTroopCarcass0` stands at 98 with the NanoKey `Body_Search_Room`; the first right button moves the key to the ring (`NanoKeyInfo0` at 150), the second puts a `POVCorpse0` in hand (`Base` the player) and destroys the carcass (191); the Tab edge (User.ini `DropItem`) destroys the `POVCorpse` and spawns `UNATCOTroopCarcass1` at 300, which touches the trigger: `DeusExMover3/25` (locked) open at 301 and `DL_bodyexit` starts (`DataLinkPlay0`) | **PASS**, 25 actors, 732 AI events, 102 creations, 700 ticks |

The keypad's digits go through the window input path as `Digit0..9` key edges: `HUDKeypadWindow.VirtualKeyPressed` presses the button of `IK_0..IK_9` and `PressButton` calls `ValidateCode` when the input is as long as
`validCode` (`HUDKeypadWindow.uc`, DeusEx.u); the Island's `dor1` drives the same window. Lockpick and Multitool are summoned and picked up facing away from the door or panel, as `dor2` and `hck1` do
(a `summon` lands in front of the view: turned the other way first, the pickup finds nothing).

**What the replays found.**

1. **A text load creates objects in the original's registry** (`kpd1`). `InformationDevices.Frob` → `CreateInfoWindow` → `DeusExTextParser.OpenText` runs `StaticLoadObject(XExtString, NULL, "DeusExText.00_Datacube01", NULL,
   LOAD_NoWarn|LOAD_Quiet)` (docs/script-text-parser.md). The first replay passed every actor but one (`DataCube0`, below) and failed the creations at the 20th: at tick 30 the original creates `Class ExtString` after
   unhashing the registered placeholder (`Class.ExtString`, slot 223 in that session), then the class's 21 Function and Property members, then the text object `ExtString 00_Datacube01`; `OpenText` frees the text object (and
   `CreateInfoWindow` the parser) in the same tick, so the next object (`TextWindow9`) takes its slot. Play's text source read the text without creating any of them. The registry model now takes them
   (`OriginalObjectIndexModel.loadNativeClass`, `ScriptRuntime.modelExtStringLoad`; the placeholder's slot comes from the dump's `Class.ExtString` row, a package the process had not loaded gets its `Package` and `LinkerLoad`
   as `loadPackage` does). The member list is the measured creation order (`EXT_STRING_CLASS_MEMBERS`), not derived from the loader: `ULinkerLoad::Preload` over the shared graph stops at `XExtString::Serialize` (Extension
   `0x10044140`: `UObject::Serialize`, then the FString at `+0x2c`; its import thunks are Core's `UObject::Serialize` and `operator<<(FArchive&, FString&)`; a prototype that added it, with `UObject::PostLoad` for the class
   whose vftable overrides only slots 10, 21 and 22, loaded the text) and then, loading the class, at `UFunction::Bind`'s `readNative` service, which the graph does not have; a not-found text creates nothing modeled (not measured). With it `kpd1` replays 159 of 159 creations in class, tick and slot.
2. **A window's name follows the process.** `DataCube0.infoWindow` is `HUDInformationDisplay2` in the capture and `HUDInformationDisplay1` in Play: the HUD's windows are built by each Player start and named by their class's session counter; why the capture's is one higher is not measured. The comparison treats the HUD's info display as a per-process numbered name (`runtimeNumbered`, like `SkillManager`).
3. **Pick state sits on the frobbed panel.** The pick fields (`bPicking`, `pickValue`, `numPicks`, `TicksPerPick`, `curPick`, `pickPlayer`) are set on the panel the player aims at (`DeusExMover46`); `DeusExMover45` only
   receives `lockStrength` and `bLocked` from the like-tagged loop in `Timer`, so a scene watching one panel of a pair sees no pick state.

### Held keys (2026-10-20)

The earlier scenes could not hold a key across ticks in the original, and their rows say so (the walk and the crouch of 5.3.4, 5.5.3's crawlspace, 5.5.4's swim, 5.2.3's
footsteps). The cause is in WinDrv, not in the tracer. `UViewport::ReadInput` (Engine `0x10374990`) calls the viewport's `UpdateInput(0)` every player tick, and
`UWindowsViewport::UpdateInput` (WinDrv `0x11109879`-`0x111098ea`) walks the 256 keys: a key UInput holds (`Input+0xeb0+key`) whose `GetKeyState` has bit `0x8000` clear gets
`CauseInputEvent(key, IST_Release)` (`0x111011f4`, action 3), and with `UpdateInput(1)` and the viewport focused a key the platform holds and UInput does not gets `IST_Press`.
A posted `WM_KEYDOWN` (dxinput `down`) leaves the thread's key state up, so the key is released at the next tick. The key state is set by input that goes through the Wine input
queue: dxinput `focus` (the game's window and viewport take the Wine foreground and keyboard focus) and `sdown`/`sup` (keybd_event), added for the security-camera frames on
2026-10-14. `--cmds "N:@hold CODE|M:@release CODE"` types them (`live-acceptance.mjs` `keyEdge`); Play takes the same edges through `game.inputKey`, whose platform key snapshot
is a keyboard's (`script-window-host.mjs` `updatePlatformInput`, the same reconciliation), and the replay pairs them with the original's `InputEvent` records like `@down`/`@up`.

| Scene | Pose and inputs | What the original did | Replay in Play |
| --- | --- | --- | --- |
| `wlk1` | `jmp1`'s spot (6991, −55, 17) facing +Y; Up (MoveForward) held from 30 to 150 | the run (`bAlwaysRun`): y −55 to 525.5 by tick 150 in the `Run` animation at 320 units/s, the slide out to (6972.02, 533.11) by 180; eight footsteps from tick 41 to 158, one each 16 or 17 ticks, each `PlayFootStep`'s `FRand`, `PlaySound` and `LoudNoise`: 0.5 by 422.2 while accelerating, 0.5 by 741.7 at the full run, 0.35 by 519.2 on the next floor (`volumeMultiplier` 0.7) for five, 0.12 by 92.3 in the slide | **PASS**, 19 actors equal for 240 ticks, the stream draws, the AI events and the creations equal |

## Scoreboard (2026-10-19, after the merge of the Island batches)

`node scripts/validate-stage5-acceptance.mjs --census .work/stage5-census-2026-10-19-final2.json --report .work/stage5-gate-2026-10-19-final2.json` on master `a786b4e`
(the devices, routes, conversation, `kC` and gives, frozen-phase frames, skipped-argument audit and zone-0 branches merged; the Mac, 2026-10-19: the census 1,161 s, 50 plays,
0 pause, 0 no-effect, 0 undriven, equal to its `EXPECTED`; the 43 proof scenes each replayed once, 12:25 to 13:19): **20 of 50 criteria pass; the gate is red** (exit 1 without
`--report`). 7 FAIL, 23 MISSING; 55 rows, 5 excluded. Every row was rerun on this code. Since work item 10 (below, merged in `79304d7`): **21 PASS, 6 FAIL,
23 MISSING**.

History: the first run (master 5d7285c, with the three tightened predicates) was 0 PASS, 14 FAIL, 33 MISSING, 3 UNDRIVEN. The Island devices task moved 5.2.6, 5.3.9, 5.5.1 and 5.5.2 from FAIL to
MISSING. The death, explosives and alarms task moved 5.1.2, 5.1.4, 5.1.5, 5.2.7, 5.6.2 and 5.6.5. That left 0 PASS, 4 FAIL, 43 MISSING, 3 UNDRIVEN. The first combat captures moved
5.2.2 from FAIL to PASS and 5.1.6 from MISSING to PASS (2 PASS, 3 FAIL, 42 MISSING). The second moved 5.6.1 from MISSING to PASS, and 5.1.5 and 5.2.7 from MISSING to FAIL: their proof,
`cmb5`, differed in one field at one tick (the carcass's first render stamp, [above](#second-captures-a-body-found-the-carcasss-contents-the-medkit-2026-10-18)).
The death capture (`die1`) moved 5.1.8 from MISSING to FAIL on the same item, its player carcass's first stamp ([above](#the-players-death-to-the-levels-end-2026-10-18)):
3 PASS, 6 FAIL, 38 MISSING, 3 UNDRIVEN (report `.work/stage5-gate-2026-10-18-518.json`). The undriven-scenarios task (item 6 below) made every scenario play, which moves the three
no-effect rows (5.2.5, 5.4.8, 5.5.5) and the three undriven ones (5.4.5, 5.6.3, 5.6.6) to MISSING; the mesh layer's fix moved 5.1.5, 5.2.7 and 5.1.8 from FAIL to PASS (6 PASS, 44 MISSING,
report `.work/stage5-gate-2026-10-18-mesh.json`). The third captures ([above](#third-captures-devices-and-weapons-2026-10-18)) moved 5.1.7, 5.2.5, 5.2.6 and 5.6.4 from MISSING to PASS
and 5.1.9, 5.2.4 and 5.6.5 from MISSING to FAIL. The conversation captures
([above](#conversation-captures-the-islands-conversations-choices-and-flags-2026-10-18)) moved 5.4.3 to 5.4.7 from MISSING to PASS, and `kC` moved 5.6.6 from MISSING to PASS.

The merge (2026-10-19) gives the union of the branches' results but one row: 5.2.5, PASS on the devices branch, fails on `alm2` (below). The routes' 5.5.3 to 5.5.7 pass and
5.3.10, 5.5.1 and 5.5.2 fail on `dor3`, as on their branch. The merge's first census had seven scenarios undriven (pistol-range, meet-page-final, island-laser,
gunther-rescued, route-back, noise-wakes-guards, flags-change-world): physWalking's zone-0 branch (merged `267feda`) makes a player placed outside the world fall out of it
and die, and the census driver's approaches and standing places tried such places, so every later approach started dead. The driver now skips a place PointRegion puts in
zone 0 (`c.inWorld`, `a786b4e`), and all 50 play.

| Clause | PASS | FAIL | MISSING | UNDRIVEN | EXCLUDED |
| --- | ---: | ---: | ---: | ---: | ---: |
| 5.1 Combat | 4 | 1 | 4 | 0 | 0 |
| 5.2 Stealth | 3 | 2 | 2 | 0 | 0 |
| 5.3 Exploration and the character systems | 0 | 1 | 12 | 0 | 0 |
| 5.4 Conversation | 5 | 0 | 3 | 0 | 0 |
| 5.5 Alternate-route objectives | 5 | 2 | 0 | 0 | 0 |
| 5.6 Systems interacting | 3 | 1 | 2 | 0 | 0 |
| 5.7 Excluded | 0 | 0 | 0 | 0 | 5 |
| **Total** | **20** | **7** | **23** | **0** | **5** |

**After work item 10** (2026-10-19, merged in `79304d7`): 5.2.5 passes. `validate-stage5-acceptance.mjs --only '^5\.2\.5 ' --census .work/stage5-census-2026-10-19-final2.json --report .work/stage5-gate-2026-10-19-525.json` replays `las1`, `alm1` and `alm2`, and all three pass, so the gate stands at **21 PASS, 6 FAIL, 23 MISSING** (5.2 Stealth: 4, 1, 2).
Every other scene the change reaches was replayed on its own and keeps its status ([the Deleted chain at the first purge](#the-deleted-chain-at-the-first-purge-the-original-loads-flygenerators-2026-10-19)).
**After work item 11** (2026-10-19): the counts stand. All 45 stored Island scenes were replayed and keep their status, and row 4.3.6 passes
([load-made actors](#load-made-actors-paired-by-creation-order-not-by-name-2026-10-19)).
**After work item 8** (2026-10-20, the Linux host, [collision over the tracked Level->Model](#collision-over-the-tracked-level-model-work-item-8-2026-10-20)):
the census plays all 50 (`.work/stage5-census-2026-10-20-item8.json`, 1,276 s, equal to its `EXPECTED`), and
`validate-stage5-acceptance.mjs --only '^5\.(1\.9|2\.4|6\.5|3\.10|5\.1|5\.2) '` (report `.work/stage5-gate-2026-10-20-item8.json`) passes 5.1.9 and 5.2.4
(`cam1`, `cam2`) and fails 5.6.5 (`emp2` from 821, work item 16) and 5.3.10, 5.5.1, 5.5.2 (`dor3` from 320, work item 15). Every other stored scene was
replayed and keeps PASS. The gate stands at **23 PASS, 4 FAIL, 23 MISSING** (5.1 Combat: 5, 0, 4; 5.2 Stealth: 5, 0, 2; 5.6: 3, 1, 2).
The table above is the merge's run.
**After work item 16** (2026-10-20, [the death camera's rotation](#the-death-cameras-rotation-work-item-16-2026-10-20)): 5.6.5 passes
(`validate-stage5-acceptance.mjs --only '^5\.6\.5 ' --census .work/stage5-census-2026-10-20-item8.json`, report `.work/stage5-gate-2026-10-20-item16.json`, `emp1` and `emp2`).
The gate stands at **24 PASS, 3 FAIL, 23 MISSING** (5.6: 4, 0, 2), and the three `FAIL` rows are `dor3`'s (work item 15).
**After work item 15** (2026-10-20, merged in `974fd0f`, [NaN in FindSpot](fitting.md#nan-in-findspot-work-item-15-2026-10-20)): 5.3.10, 5.5.1 and 5.5.2 pass
(`validate-stage5-acceptance.mjs --only '^5\.(3\.10|5\.1|5\.2) ' --census .work/stage5-census-2026-10-20-item8.json`, report `.work/stage5-gate-2026-10-20-item15.json`:
`dor1`, `dor2`, `fK` and `dor3`). The gate stands at **27 PASS, 0 FAIL, 23 MISSING** (5.3: 1, 0, 12; 5.5: 7, 0, 0): every row that has its capture passes. The
tables are from the merged report `.work/stage5-gate-2026-10-20-merged3.json`.
**After the fourth captures** (2026-10-20, [on the Linux host](#fourth-captures-on-the-linux-host-light-breath-movables-2026-10-20)): 5.6.3 passes on `lgt1` and `lgt2`
(report `.work/stage5-gate-2026-10-20-lgt.json`), then 5.3.8 on `swm1` and `swm2` and 5.3.12 on `mov1` (report `.work/stage5-gate-2026-10-20-swm-mov.json`).
The gate stood at **30 PASS, 0 FAIL, 20 MISSING**.
**After the O3 proofs** (2026-10-20, merged in `3b56787`, [O3](#o3-the-originals-code-on-plays-inputs-2026-10-20)): 5.3.5 and 5.3.6 pass (`validate-stage5-o3.mjs --scene ladder|crate-stack`;
`--only '^5\.3\.(5|6) ' --census .work/stage5-census-2026-10-20-o3.json`, report `.work/stage5-gate-2026-10-20-o3.json`). The gate stood at **32 PASS, 0 FAIL, 18 MISSING**.
**After work item 13 and the 00_Training captures** (2026-10-20, [object names](#object-names-at-the-seed-work-item-13-2026-10-20), [00_Training](#captures-on-the-linux-host-00_training-2026-10-20)):
every stored Island scene (51) was replayed with the seed's names and passes; 5.3.11 passes on `itm2`, and 5.1.1, 5.3.2, 5.3.4 and 5.3.7 on `cbr1`, `aug1`, `jmp1`, `hzm1` and `hzm2`
(`--only '^5\.(1\.1|3\.2|3\.4|3\.7|3\.11) '`, report `.work/stage5-gate-2026-10-20-mine.json`). The gate stood at **37 PASS, 0 FAIL, 13 MISSING**.
**After the 00_TrainingFinal captures** (2026-10-20, merged in `d094da0`, [00_TrainingFinal](#captures-00_trainingfinal-2026-10-20)): 5.2.1 and 5.6.2 pass on `stl1`, 5.3.13 on `sw1` and `stl1`,
5.4.8 on `mpg1` and `jmr1` (`--only '^5\.(2\.1|3\.13|6\.2|4\.8) '`, report `.work/stage5-gate-2026-10-20-final.json`). The gate stood at **41 PASS, 0 FAIL, 9 MISSING**.
**After the 00_TrainingCombat captures and `dlk1`** (2026-10-20, merged in `e982307`, [fifth captures](#fifth-captures-00_trainingcombat-2026-10-20)): 5.1.2 passes on `rng1` and `rng2`,
5.1.3 on `rif1`, 5.1.4 on `lam1`, 5.4.2 on `ins1` and `ins2`, 5.4.1 on `dlk1` and `cbr1` (`--only '^5\.(1\.2|1\.3|1\.4|4\.1|4\.2) '`, report
`.work/stage5-gate-2026-10-20-tc.json`). The merge brings two Play fixes the captures found: ProcessState stops at a destroyed actor (Engine `0x103e5bb3`,
`0x103e5c16`) and processLanded keeps appFrand unrounded (`0x103cf533`). The gate stood at **46 PASS, 0 FAIL, 4 MISSING**.
**After the Training phase 1 captures** (2026-10-20, merged in `2eb75a5`, [Training phase 1](#captures-training-phase-1-2026-10-20)): 5.3.1 passes on `key1`, `pik1`, `kpd1`, `hkp1` and `cad1`,
with `cbr1` and `aug1` from the earlier captures (`--only '^5\.3\.1 '`, census `phase1-route`, report `.work/stage5-gate-2026-10-20-5.3.1.json`, on the merged code). The merge brings the
registry's first XExtString load (`OriginalObjectIndexModel.loadNativeClass`). The gate stood at **47 PASS, 0 FAIL, 3 MISSING**.
**After the windows' captures** (2026-10-20, merged in `e81d0c9`, [the bots and the terminals](#captures-windows-the-bots-and-the-terminals-2026-10-20)): 5.3.3 passes on `rpr1`, `rpr2` and `med1`,
5.3.9 on `trm1`, `atm1` and `sec1` with the terminals' frames `trf1`, `atf1` and `sef1` (`--only '^5\.3\.(3|9) '`, censuses `bots` and `island-terminal`, report
`.work/stage5-gate-2026-10-20-ui.json`, on the branch merged with master `22ee79e`). The gate stands at **49 PASS, 0 FAIL, 1 MISSING**: 5.2.3, whose footsteps half waits on the
user's decision ([below](#what-the-user-should-decide)); the tables are from `.work/stage5-gate-2026-10-20-merged11.json`.

The twenty `PASS` rows have proof checks on stored Island scenes: 5.2.2 on `cmb1` and `cmb2`, 5.1.6 on `cmb1` to `cmb4`, `cmb6` and `cmb7`, 5.1.5 on `cmb1`, `cmb2` and `cmb5`,
5.2.7 on `cmb5`, 5.6.1 on `cmb7`, 5.1.8 on `die1`, 5.1.7 on `ko1`, 5.2.6 on `hck1`, 5.6.4 on `exp1`; 5.4.3 on `pG`, `pR` and `pX`, 5.4.4 on `fT`, `fM`, `fN` and `tA`, 5.4.5 on
`gP`, `gN`, `gA`, `gS`, `gU`, `gK` and `gW`, 5.4.6 on `tC` and `tA`, 5.4.7 on `oV`, `oT`, `cmb2` and `cmb3`, 5.6.6 on `gP`, `gN`, `gA`, `fT`, `fM`, `fN`, `oV` and `kC`; 5.5.3 on
`air1`, 5.5.4 on `wat1`, 5.5.5 on `kil1`, 5.5.6 on `tC`, 5.5.7 on `kil1` and `tC` (each with its `weak`). Six of the seven `FAIL` rows share one cause, named in their `need`
(work item 8 below: Play's traces read the static BSP where the original's `Level->Model` holds the brush tracker's mover fragments): 5.1.9 and 5.2.4 on `cam1` (`cam2`
passes) and 5.6.5 on `emp2` (`emp1` passes), from SecurityBot1's shot at the player; 5.3.10, 5.5.1 and 5.5.2 on `dor3` (`dor1`, `dor2` and `fK` pass), from the rocket at the
back entrance (routes, item 4).

**5.2.5 (`alm2`), new with the merge.** `las1` and `alm1` pass; `alm2` differs in one field of one actor: `Multitool0` (summoned at 20, used up and destroyed at 446 in
both) is released by the original at 895 and never by Play. The conversation batch's release comparison (`live-acceptance.mjs`: a destroyed actor's `unhash` record
against Play's object log) is what sees it; the devices branch, where `alm2` passed, compared rows only up to the destruction. At 895 the original's
`ULevel::CleanupDestroyed` purges 128 actors at once (55 BloodDrops, 22 BloodSpurts, 15 WaterRings, 14 MuzzleFlashes, 6 ConPlayBarks, 5 LaserSpots, 3 Tracers, 2
ShellCasings, 2 FlyGenerators, a BloodSplat, `Multitool0`, a NanoKeyRing and `PickupDistributor0`): the Deleted chain reached the 128 that `cleanupLevelDestroyed`
waits for. Play frees none of them by tick 900, so its chain was shorter at 895. Every creation and every compared field is equal, so the missing link is a
destroy Play does not chain. Play's object logs of the other scenes (a batch of 100 frees or more) show it is not `alm2`'s alone: Play purges with the original in
`cmb3` (821, 128) and `exp1` (352, 131; 384, 129), but in `las1` at 565 where the original purges at 561, which the check does not see (no watched actor is released
there). The two scenes whose purge holds FlyGenerators, killed by the frozen phase's `KillAll FlyGenerator` (one in `las1`, two in `alm2`), are the two where Play
purges late; `cmb3` and `exp1` have none. **Resolved (work item 10)**: Play did not leave those destroys off its chain. Its seed-1 load never made the
FlyGenerators, so its KillAll destroyed nothing. The replay now makes the original load's FlyGenerators before the KillAll (a measured host input), and `alm2`
passes: purge at 895, every free equal ([the Deleted chain at the first purge](#the-deleted-chain-at-the-first-purge-the-original-loads-flygenerators-2026-10-19)).

The 23 `MISSING` rows play in the census and name the capture that would prove them.
Stage 4's gate started at 44 of 70 because 60 checks against stored
originals already existed; for gameplay they did not. The strongest existing evidence is listed per row under "Existing, partial": the Island combat scenes, the Underworld's
weapon-noise traces for gunshots, the perception pilot, the first-person crowbar, MeetPaul's frames, and the native oracles for swimming, ladders, falling and movers.

**Checks rerun for the merge** (2026-10-19, the Mac, master `a786b4e`, the wasm core and `ad/build/dx-live-win.exe` rebuilt): the unit tests (652); the census
and the gate above (43 proof scenes); the two stored scenes no row names, `tF` (the frozen phase's window frames: 26 actors, 950 ticks, the 7 flags) and `kB`
(23 actors, 700 ticks), both PASS; the six Stage 4 rows that replay live traces (4.1.5, 4.1.6, 4.1.7, 4.2.13, 4.3.6, 4.5.5), all PASS; `cmb1` re-judged with
`--compare-only` on the merged comparison, PASS. On their own branches before the merge: the AIProcess stop's combined model on `las1`, `gA` and `alm1` and
`validate-event-manager` (98 scenarios), on a tree equal to master's but for comments and two unused helpers; physWalking's zone-0 branch on
`validate-native-walking` (399 cases, four zone-0), `-native-swimming`, `-walk-loop-kernel`, `-walk-loop-branches` and `-pawn-physics-kernel`. Not rerun: the full
validator sweep and the `bench-sim` digests.

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
5. **Pain zones and the HazMat suit** (finding 5): **done 2026-10-20** ([00_Training captures](#captures-on-the-linux-host-00_training-2026-10-20)): `hzm1` (the pool's radiation, no suit) and `hzm2`
   (the suit's absorption and Charge) replay equal, 5.3.7 passes on them.
6. ~~**The undriven scenarios**~~ **Done 2026-10-18** (findings 8 to 12): all six were driver faults or a misread row, none a Play gap. The cell door and Gunther (5.4.5, 5.6.6) open
   from the wall button. The lit/dark pair (5.6.3) is two measured poses in front of `Terrorist4`. `M00MeetPage` (5.4.8) is walked into, and holo-Jaime is driven too. The commander (5.5.5) is
   shot from outside his conversation radius. The `ElevatorMover1` "ride" (5.3.13) is the exit door, closed by the alarm and reopened by `Switch0`. The laser (5.2.5) row is restated
   from the original's `AlarmTimer` rule. The census now plays all 50 scenarios.
7. **Proof captures, by clause value**: conversation branches **done 2026-10-18** for 5.4.3 to 5.4.7 ([conversations](#conversation-captures-the-islands-conversations-choices-and-flags-2026-10-18));
   5.6.6's `M01PlayerAggressive` **done 2026-10-19** (`kC`), and GuntherRescued's other gives and GiveNothingNicely too (`gS`, `gU`, `gK`, `gW`). The third captures gave 5.1.7, 5.1.9,
   5.2.4, 5.2.5, 5.2.6, 5.6.4 and 5.6.5 their scenes ([devices](#third-captures-devices-and-weapons-2026-10-18)) and captured the routes (5.5, [routes](#third-captures-the-routes-the-doors-and-the-mission-2026-10-18)).
   Since done on 2026-10-20: weapons and damage (5.1.1 to 5.1.4), Training's lessons (5.3.1, 5.3.2, 5.3.4) and the O3 comparisons (5.3.5, 5.3.6). The bots' and the terminals'
   windows (5.3.3, 5.3.9) too. Left: the footsteps (5.2.3, the user's decision below). The census plays every scenario.
8. **Done 2026-10-20** ([above](#collision-over-the-tracked-level-model-work-item-8-2026-10-20)): `cam1` passes, `emp2` differs later (item 16) and `dor3` passes with item 15.
   **Collision and level traces over the brush tracker's `Level->Model`** ([brush tracker](brush-tracker.md#open), "Collision"): Play's MoveActor, MultiLineCheck's world check and with it
   SingleLineCheck, Trace and the AI and decal traces read the static BSP, while the original's level model holds every mover's fragments (FastLineCheck already reads them). So a trace that
   meets a mover also hits the world there, and MultiLineCheck's mover recovery moves the mover hit two units back. Proven bit-exact for `dor3`'s rocket (routes, item 4) and measured on
   SecurityBot1's shot (`cam1`, `emp2`, devices). Needs an oracle over a tracked model and every stored scene near a mover replayed after it. Unblocks 5.1.9 and 5.2.4 (`cam1`), 5.6.5
   (`emp2`), 5.3.10, 5.5.1 and 5.5.2 (`dor3`).
9. **Shooting the turret down** (5.1.9's second half) has no capture: an untrained pistol misses AutoTurretGun0 from 340 units, and the turret and SecurityBot1 kill the player first.
10. **The Deleted chain at `alm2`'s purge** (5.2.5): **done** 2026-10-19 ([the Deleted chain at the first purge](#the-deleted-chain-at-the-first-purge-the-original-loads-flygenerators-2026-10-19)).
    No destroy was left off Play's chain. The original's load made chance FlyGenerators that Play's seed-1 load did not make, and the frozen phase's KillAll chained
    them in the original only. The replay now makes them before the KillAll, from the capture's `generators-load<tag>.json`. `alm2` passes and `las1` purges at 561.
11. **The measured slot of a live actor Play made before the seed** (the slot model): **done** 2026-10-19 ([load-made actors](#load-made-actors-paired-by-creation-order-not-by-name-2026-10-19)).
    The hand-over alone did not cover it: a load-made actor's name is its class's session counter, which differs between the programs (Play's Shadows 53..105,
    the original's 20..72), so the seed's name match gave Play's Shadows other Shadows' slots. The seed now pairs load-made actors with the dump's by creation order
    within their class and hands each its measured slot. All 45 stored Island scenes keep their status (42 PASS; `cam1`, `emp2`, `dor3` FAIL on item 8 as before).
    `kil1` and `exp1` drop to 0 creations in another slot (394 and 143 before), and the Shadow frees of `kil1`, `tC`, `exp1`, `die1`, `tA` and `tF` are now Play's own and
    equal. Row 4.3.6 passes (103 of 103 calls, 557 of 557 takes in slot).
12. **Harness destroys of actors only Play has** lengthen Play's Deleted chain and move its purges earlier: Play's own chance FlyGenerators under a KillAll
    (04_NYC_Street at seed 1: ten, `vents5`'s original eight) and the population step's `removed`. None happens on the Island today.
13. ~~**Play's session name counters at a load**~~ **Done for the replays 2026-10-20** ([object names at the seed](#object-names-at-the-seed-work-item-13-2026-10-20)):
    Play's boot leaves each class's `ClassUnique` elsewhere than the original's session does (Island: Shadow 53 against 20, LaserProxy 8 against 1), so every
    load-made actor had another name than the original's, and `itm1`'s summoned Candybar was Candybar4 where the original's is Candybar3. The replay's seed now
    gives each paired load-made actor the dump's name of the original's actor it stands for, so the measured class counters name later objects as the original
    does. Play's own boot (outside a replay) still leaves the counters where its history puts them: the original session's history is a host input Play does not have.
14. **Where the replay releases an AI event pre-free** ([load-made actors](#load-made-actors-paired-by-creation-order-not-by-name-2026-10-19)): an AI event object that existed
    at the frozen start and that Play does not hold is released after the event manager's Tick, not at its anchor. Inside a large collection the original releases
    `AIReceiverEvent15` and `AIReceiverEvent16` 70th and 71st (`kil1` 541, `tC` 721, `tA` 481, `tF` 421), and the replay releases them 237th. The set is equal, the order
    is not. It is reported, not judged (the slots are reported), and no later creation takes another slot because of it.
15. **Done 2026-10-20: AdjustSpot on a NaN Hit.Time, and the NaN Location after it** (`dor3`, [above](#collision-over-the-tracked-level-model-work-item-8-2026-10-20)):
    the original adjusts on an unordered compare (`test ah, 1` after `fcomp`, 0x103983c1), the candidate becomes NaN, FindSpot's later probes and point check run on it, and
    its displacement test (`fcompp; test ah, 1`, 0x1039896f) refuses it, so SpawnActor returns None before any object exists: the original makes 14 fragments, not 15, and
    the 3 draws Play had after fragment 5's AddObject are the next attempt's VRand. No capture was needed: Engine.dll's own FindSpot under Unicorn
    (`native-tracked-fitting-oracle.py`: native-level-oracle.py's hash, actors and brush transforms over the brush tracker's `Level->Model`) on Play's inputs refuses attempt 5 and agrees
    on the other 15; the steps a NaN reaches are ported with their oracle cases (the hash's one-cell walk of a NaN line, the BSP ray's facing test, `UModel::PointCheck`'s
    traversal and hull loop, FindSpot's two compares) and the compare forms are measured on real x87 (`validate-x87-compare-hardware.mjs`, Wine on the Linux host).
    `validate-native-findspot-nan.mjs`; [NaN in FindSpot](fitting.md#nan-in-findspot-work-item-15-2026-10-20); `dor3` passes. Unblocks 5.3.10, 5.5.1, 5.5.2. Not ported (still
    throws, and FindSpot never reaches it): a hash line with exactly one NaN vector, a box-extent LineCheck on a NaN, infinities.
16. ~~**SecurityCamera3's visibility at the frustum edge**~~ **Done 2026-10-20** ([the death camera's rotation](#the-death-cameras-rotation-work-item-16-2026-10-20)):
    not a visibility gap. The player dies at 820, and `UGameEngine::Draw` starts `PlayerCalcView` from the body's `Rotation`, which the Dying view keeps. Play
    started it from `ViewRotation`. `emp2` and 5.6.5 pass.

## What the user should decide

* **The list itself**: 50 scenarios, Training meaning all three maps, Island with its five ways in, one row for the whole of Training's phase 1, placed approaches instead of walks. Weak choices are labelled `weak`
  in `scripts/stage5-criteria.mjs` and in the tables above.
* **Rows restated by work item 6** (findings 9 to 12), each from original script lines. 5.2.5: the beam makes the guards who hear it attack with `AlarmTimer` 120, and `AlarmUnit0` is rung by a
  guard who saw the player. 5.3.13: the exit door instead of a ride. 5.4.5: the wall button. 5.6.3: a measured pair under the map's lighting instead of AugLight or a light switch (the
  Island has no switch, and AugLight adds the `Beam` path). 5.6.6 is restated (the alliance flips on a touch, not from the flag) and labelled `weak`: of the conversations that read the other three flags, MeetFilben2, MoleConvos and TrooperCongratulation are captured (`fM` `fN`, `oV`, `kC`); PaulCongratulations and Filben's two barks are not.
* **O3 or O2 as enough for native-body rows** (ladder, crate physics, swimming, falling, movers): the doc defaults to O3 (the DLL's code on Play's inputs in the scene), which the ladder and the crate stack have (5.3.5, 5.3.6, [O3](#o3-the-originals-code-on-plays-inputs-2026-10-20)); the other native-body rows pass on O1 captures.
* **Cross-map evidence for shared code**: the gunshot half of 5.2.3 now has an Island capture (`cmb2`); its footsteps half can have no live trace (a held key), so the choice is O3 on Play's footstep inputs or accepting the row without footsteps.
* **Where a player's death stops** (item 2): implemented as the original's client travel, where its level ends; whether the load menu after it belongs to Stage 5 or 6 is still open.
* **The third captures' judgements** (labelled `weak` in their rows): actors spawned at load by a placed actor (LaserEmitter, AutoTurretGun, ParticleGenerator) compared by name
  stem, because Play's start loads the Island twice and the original's capture session once (whether the original's own start loads it once is not recorded); `ko1`'s Low-Tech skill
  from the `AllSkills` cheat (untrained, the baton's second swing lands after the Terrorist has left); 5.6.4's explosion set off by the door Terrorist2 opens (`Crushed`), the
  player's shots having missed; 5.1.9's and 5.2.4's restatements from the original scripts (the cameras trigger no Event: an `Alarm` AI event wakes the turret).
* **The routes' placed approaches** (5.5.3, 5.5.4): the airshaft row passes without its third trigger (a crawlspace a standing player cannot be dropped into) and the water row without the swim (a held key); both are labelled `weak`. Accept them, or require O3 for the crouch and the swim.
* **Priority**: every row but 5.2.3 passes. Its gunshot half is captured (`cmb2`); the footsteps half is the cross-map choice above (O3 on Play's footstep inputs, or the row without footsteps).
  Items 9, 12 and 14 of the remaining work stay open and block no row.

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
node scripts/validate-stage5-o3.mjs --scene ladder                       # an O3 proof (ladder, crate-stack): the scene's native physics calls replayed through Engine.dll on Play's inputs; --keep/--reuse/--no-ab ([O3](#o3-the-originals-code-on-plays-inputs-2026-10-20))
node scripts/validate-stage5-live.mjs --scene cmb1                       # a proof check: a stored Island scene (cmb1..cmb7, die1, the devices hck1..emp2, the routes kil1..air1, the conversations pG..kC) replayed in Play (SKIP without the store)
node scripts/validate-stage5-live.mjs --scene cmb1 --print-capture       # the original's capture command of that scene (writes its tracer config; the bottle lock first; --frozen-frames: the frozen phase's window frames)
node scripts/validate-stage5-live.mjs --scene cmb1 --compare-only        # judge the stored replay again after a change to the comparison alone (not after a Play change)
node scripts/stage5-capture-rehearsal.mjs --scene cmb1                    # rehearse a scene's input list in Play, headless, before a capture (class P)
```
