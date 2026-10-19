/** The Stage 5 criteria as data (docs/stage-5-exit-criteria.md): one row per representative scenario of the roadmap's section 5 "Done when", read by the census
 * (scripts/census-stage5.mjs, which drives each row's `census` scenario in Play) and by the gate (scripts/validate-stage5-acceptance.mjs).
 *
 * A row is {id, clause, scene, claim, ev, census, proof, have, need, weak, excluded}:
 *   ev       the evidence class a passing proof check would have (O1 Play against the original's own output for the same inputs; O2 a translation against the
 *            DLL's code; O3 O2 on Play's own inputs; P Play against itself). A played result needs O1 or O3 (docs/stage-4-exit-criteria.md "How the gate judges").
 *   census   the scenario of scripts/census-stage5.mjs that drives the row through the player's own inputs; the row cannot pass unless it plays.
 *   proof    the checks that, all passing, make the row PASS: [] while none exists (the row is then MISSING and `need` says what would prove it).
 *   have     existing checks that cover a part (named, not run, never enough alone).
 *   weak     why the choice of scenario or proof is mine and weak, for the user to adopt or change.
 * Stage 6 and multiplayer rows are `excluded` with the reason. */

export const CLAUSES = Object.freeze({
  1: 'Combat', 2: 'Stealth', 3: 'Exploration and the character systems', 4: 'Conversation', 5: 'Alternate-route objectives', 6: 'Systems interacting',
});

export const CRITERIA = [];
const add = (id, scene, claim, ev, census, need, extra = {}) => CRITERIA.push({id, clause: Number(id.split('.')[1]), scene, claim, ev, census, proof: [], have: [], need, weak: null, excluded: null, ...extra});
const live = (...scenes) => scenes.map(scene => ({type: 'validator', name: 'validate-stage5-live.mjs', args: ['--scene', scene]}));
const excluded = (id, scene, claim, reason) => CRITERIA.push({id, clause: Number(id.split('.')[1]), scene, claim, ev: '-', census: null, proof: [], have: [], need: null, weak: null, excluded: reason});

// 5.1 Combat -----------------------------------------------------------------------------------------------------------------------------
add('5.1.1', '00_Training crates', 'the crowbar breaks a Cratepick crate: swing, damage, fragments, contents, the Mission00 timer starts DL_Lockpick', 'O1', 'crowbar-crate',
  'O1: live trace of the original (crowbar summoned, ParseRightClick, ActivateBelt, a Fire edge at the crate) with the crate, fragment and contents state per tick',
  {have: ['validate-crowbar-crate (P)', 'validate-weapon-view-original (4.1.10 O1: the swing\'s draws)', 'script-crate-destruction.md']});
add('5.1.2', '00_TrainingCombat pistol range', 'take a pistol and Ammo10mm, walk in (DL_TArgetRange opens the cover over Switch3), press Switch3 (the target DeusExMover4 with BreakableGlass0 slides in; its MoverCollider passes the DirectionalTriggers that open the blast door), shoot the glass through the station window: ammo, recoil, trace hit, target and trigger state, DL_TArgetRangeshot1/2', 'O1', 'pistol-range',
  'O1: live trace of the original firing at the range (edge-triggered Fire) with ammo, hit actor, mover and DataLink-flag state per tick',
  {have: ['weapon noise O1 in the Underworld (pistol shots\' event traffic, not the hit or the ammo)']});
add('5.1.3', '00_TrainingCombat rifle range', 'take the rifle and Ammo3006, scope on, shoot: scope FOV, accuracy, hit; DL_RifleRangeShot1 sets SkillWeaponRifle to 3', 'O1', 'rifle-scope',
  'O1: live trace of the original (scope toggle and Fire edges) with the scope state, FOV, ammo and the skill level');
add('5.1.4', '00_TrainingCombat demolitions', 'place a LAM on BreakableWall1 (WeaponLAM.Fire\'s Place path near a Mover; a thrown LAM bounces off), shoot it (ThrownProjectile.TakeDamage): it explodes (HurtRadius), the wall breaks (BlowItUp), DL_FinishWall follows', 'O1', 'lam-wall',
  'O1: live trace of the original (LAM selected, Fire edge) with the LAM actor, the explosion\'s damage to the wall and its fragments',
  {have: ['alterations census (grenade throws play, P)', 'validate-island-blowitup (mover BlowItUp O2)']});
add('5.1.5', '01_NYC_UNATCOIsland', 'the player\'s pistol hurts and kills a standing Terrorist: damage, hit reaction, hostile response, death, carcass and its inventory', 'O1', 'island-shoot-npc',
  'O1: live trace of the original (pistol summoned and drawn, Fire edges at a Terrorist in view) with the pawn\'s Health, state, Orders, Enemy and the carcass',
  {proof: live('cmb1', 'cmb2', 'cmb5'), have: ['validate-stage5-live cmb7 (O1: the second pistol shot kills Terrorist0 at 360; its carcass created at the original\'s tick)', 'weapon noise O1 (the NPCs\' event handlers for a player\'s shots in the Underworld)', 'carcass memory natives 2108/2109 (O2)'],
    weak: 'The contents (the Inventory chain the dying pawn hands over, SpawnCarcass) are compared on cmb5\'s carcass, Terrorist16 killed by the Tantalus cheat; the pistol kills (cmb1 at 420, cmb7 at 360) are compared by the death and the carcass\'s creation in class and tick, not by its contents (cmb6, cmb1\'s inputs with the carcass watched, missed: the Terrorists\' own fire killed ThugMale7 first). The chain is compared by the items\' classes in order (their numbers follow each process\'s creation order).'});
add('5.1.6', '01_NYC_UNATCOIsland', 'a hostile Terrorist attacks the player: it aims and fires (Tracer, physProjectile), the player\'s Health, armor and hit regions change, the AI keeps attacking or takes cover', 'O1', 'island-npc-shoots-player',
  'O1: live trace of the original with a visible, hostile-allied player in an NPC\'s view and the NPC\'s state, fire, projectile and the player\'s damage per tick',
  {proof: live('cmb1', 'cmb2', 'cmb3', 'cmb4', 'cmb6', 'cmb7'), have: ['validate-island-tracer (tracer flight, P)', 'validate-native-projectile (O2)'],
    weak: 'Six scenes against one group (Terrorist0, ThugMale7, Terrorist10) on open ground; the player stands still (the harness cannot hold a key). The armor (cmb4) is compared through the player\'s hit regions per tick; its Charge is not a watched field (a summoned actor). No scene has the AI take cover; in cmb6 the Terrorists\' own fire kills ThugMale7 (tick 395), and the strafing pawns\' sprint directions (RandomBiasedRotation) are compared in cmb6 and cmb7.'});
add('5.1.7', '01_NYC_UNATCOIsland', 'a baton or crowbar knocks a Terrorist out: KnockedOut carcass, "Unconscious", and Mission01.Timer\'s aggression count', 'O1', 'island-melee-ko',
  'O1: live trace of the original (WeaponBaton drawn, Fire edge at a Terrorist) with the pawn\'s state, the carcass and its itemName');
add('5.1.8', '01_NYC_UNATCOIsland', 'player death: lethal damage reaches Dying, the death state and view; the game does not continue the level', 'O1', 'island-death',
  'O1: live trace of the original from lethal damage to the level\'s end (the Dying player\'s OPEN DXONLY, browsed at the next engine tick); Play stops at the same tick (the screen after it is Stage 6\'s load menu)',
  {proof: live('die1'), have: ['validate-stage5-live cmb3 (O1: the Terrorists\' fire kills the player at tick 863, HealthTorso -4, Dying and DeathFront; Play equal through Dying to tick 900)',
    'validate-console-command (OPEN: SetClientTravel stores the URL and runs PreTravel; the client travel step ends the level)'],
    weak: 'One death: the Terrorists\' fire on a standing player whose HealthTorso and HealthHead were lowered to 5 by console SET in the frozen phase (both programs run the line; the original\'s is read back before the trace). Watched: the eight NSF pawns within 5,000 units, the player and its carcass; the other ScriptedPawns are traced with their load-time fields only (written into Play, not compared). The view (PlayerCalcView\'s camera) is compared through its effects, FrobTime and the tick of the OPEN, not as a camera.'});
add('5.1.9', '01_NYC_UNATCOIsland AutoTurret', 'NSFTurret01 fires at the player when its cameras trigger libertyturret1; the player can shoot it down', 'O1', 'island-turret',
  'O1: live trace of the original with the turret active (bActive via trigger) and the player in its range',
  {have: ['validate-island-tracer']});

// 5.2 Stealth ----------------------------------------------------------------------------------------------------------------------------
add('5.2.1', '00_TrainingFinal stealth maze', 'walk in and out of the soldiers\' sight: patrols, AllianceTrigger hostile/neutral, AlarmUnit, DL_FailedStealth, the reset', 'O1', 'stealth-maze',
  'O1: live trace of the original with the player at fixed poses in a Soldier\'s patrol (no held keys needed) and the soldiers\' states, alarm and trigger flags');
add('5.2.2', '01_NYC_UNATCOIsland', 'a visible player in the open: a patrolling Terrorist sees it (AICanSee, SightCounter, CycleCumulative), turns, calls the alert; a hidden player is not seen', 'O1', 'island-sight',
  'O1: live trace of the original (no ghost, player standing at a measured pose in a patrol\'s view and out of it) with the perception fields of the Perception pilot',
  {proof: live('cmb1', 'cmb2'), have: ['perception pilot O1 in the Underworld (civilians flee a visible mj12-allied player)', 'validate-pawn-perception / AICanSee x87 (O2)'],
    weak: 'The two poses are 700 units in front of Terrorist0 (seen: it and ThugMale7 seek from tick 41; the patrolling Terrorist10 joins) and 700 units behind it (no Terrorist notices the player in 600 ticks). "Hidden" here is out of the view cone, not in darkness: light against sight is 5.6.3.'});
add('5.2.3', '01_NYC_UNATCOIsland', 'the player\'s noise reaches the guards: gunshots (WeaponFire, LoudNoise), the HandleShot/HandleLoudNoise callbacks; footsteps by speed and floor', 'O1', 'island-hearing',
  'O1: live trace on Island of the event traffic for a pistol and, with a walking player, for footsteps; footsteps need a held key the harness cannot post (O3 on Play\'s footstep inputs then)',
  {have: ['validate-stage5-live cmb2 (O1 on Island: an unseen player\'s two pistol shots, every AI event manager call equal, the three NSF pawns woken)', 'live-events-compare O1: 1,069 and 1,586 manager calls equal in the Underworld (pistol, assault shotgun)'],
    need: 'footsteps (a held key the harness cannot post: O3 on Play\'s footstep inputs); the gunshot half has an Island O1 (cmb2)', weak: 'Gunshot events are compared in the Underworld, not on Island; the code is shared. Adopt the Underworld evidence for the gunshot half, or require an Island capture.'});
add('5.2.4', '01_NYC_UNATCOIsland cameras', 'SecurityCamera sees the player: tracking, the alarm event, NSFCam01..03 trigger libertyturret1; UN_CamSystem01..04 (bNoAlarm) do not', 'O1', 'island-camera',
  'O1: live trace of the original with the player in a camera\'s cone and the camera\'s state, the alarm flag and the turret\'s state per tick');
add('5.2.5', '01_NYC_UNATCOIsland laser trap', 'a LaserTrigger beam broken by the player raises the alarm (LaserTrigger.BeginAlarm: Klaxon2 and an \'Alarm\' AI event; the laser has no Event): the guards that hear it handle it (HandleAlarm: AlarmTimer 120, seek, attack), and AlarmTimer > 0 keeps them from the alarm box (Alerting: Alert -> Done -> Attacking); AlarmUnit0 (SetAlarmFlag -> FlagTrigger3 -> StatueAlarmTriggered) is rung by a RaiseAlarm BeforeAttacking guard that takes the player as its enemy with AlarmTimer 0 (Terrorist18 seeing him)', 'O1', 'island-laser',
  'O1: live trace of the original with the player placed across statue_lasertrap (the guards\' AlarmTimer and states, the klaxon) and, separately, in Terrorist18\'s view (its run to AlarmUnit0 and the flag)');
add('5.2.6', '01_NYC_UNATCOIsland laser trap', 'hacking ControlPanel0 with a multitool switches statue_lasertrap off: hack time (skill, hackStrength), the multitool\'s use, the lasers\' state', 'O1', 'island-hack-panel',
  'O1: live trace of the original (Multitool selected, a left-button click on the panel: ParseLeftClick, never the right button) with the hack progress, multitool charge and laser state per tick');
add('5.2.7', '01_NYC_UNATCOIsland', 'a pawn reacts to a body: a killed or knocked-out Terrorist is seen (CheckCarcassPresence, HaveSeenCarcass, AddCarcass) and the finder investigates or flees', 'O1', 'island-carcass',
  'O1: live trace of the original with a carcass in a patrol\'s view', {proof: live('cmb5'), have: ['validate-pawn-carcass (natives 2108/2109, O2)', 'validate-stage5-live cmb1 (O1: the attacking Terrorists find TerroristCarcass1, CarcassTimer 120, and stay in Attacking)'],
    weak: 'One body and one finder: Terrorist16 killed by the Tantalus cheat (no shot, so no WeaponFire or LoudNoise from the player; the death cry\'s LoudNoise and Distress reach no pawn within their 800 units), and the patrolling Terrorist21 meets the body at tick 512 (CheckCarcassPresence: AddCarcass, CarcassTimer 120, SetSeekLocation SEEKTYPE_Carcass, Seeking). The Carcass AI callback is commented out in the original\'s UpdateReactionCallbacks, so no Carcass callback is ever delivered; the finding is the polled sight check.'});

// 5.3 Exploration and the character systems --------------------------------------------------------------------------------------------
add('5.3.1', '00_Training phase 1', 'PlayerStart to DL_part2 by the player\'s own inputs: doors, NanoKey and key ring, crowbar and crates, lockpicking gundoor, datacube and keypad 0012, multitool hack of Keypad2, the cadet\'s body to the table, the dark room, the repair bot', 'O1', 'phase1-route',
  'O1 per step (live traces of the original at each interaction: door/mover state, lock strength and pick time, keypad result, hack time, body carry), or O3 where a step is a native body',
  {have: ['Stage 3 gate route probe (P)', 'validate-keypad, validate-training-nanokey, validate-training-cadet, validate-crowbar-crate (P)', 'datacube and keypad frames O1 (4.4.13, 4.4.14)'],
    weak: 'One row for the whole route because the existing probe is one walk; each interaction would be its own capture.'});
add('5.3.2', '00_Training dark room', 'F12 turns on AugLight: energy drain, the Beam, the lit room; the repair bot recharges', 'O3', 'dark-room-aug',
  'O3: Augmentation.Timer/energy and the Beam spawn on Play\'s inputs against the DLL; the light itself is validate-auglight-lighting',
  {have: ['validate-auglight-lighting (O3 lighting)', 'validate-player-augmentation-startup (P)']});
add('5.3.3', '00_Training bots', 'the repair bot and the medical bot windows: recharge and heal amounts, cooldown, the window\'s buttons through the input path', 'O1', 'bots',
  'O1: live trace of the original at the bots (ParseRightClick, window clicks as key edges) with energy and health');
add('5.3.4', '00_Training obstacle course', 'jump across the platforms and crouch under the pipes: Jump, Duck, fall and landing, the player\'s path equal to the original\'s', 'O1', 'obstacle-jump',
  'O1: live trace of the original with Jump on a key edge from a measured pose (a held walking key is not capturable: the approach is placed, as the Underworld scenes do)',
  {have: ['walking, falling, landing, stance oracles (O2)', 'measure-training-physics']});
add('5.3.5', '00_Training ladder', 'climb the ladder by view pitch and the arrow keys, and leave it at the top', 'O3', 'ladder',
  'O3: the ladder prelude and physFlying on the inputs Play produced in this scene, against Engine.dll', {have: ['validate-native-ladder, validate-native-flying (O2)', 'validate-training-ladder (P)']});
add('5.3.6', '00_Training crate stack', 'pick up a metal crate, drop it, stack and climb: GrabDecoration, DropDecoration, Bump, physFalling and physRolling of the crate, the climb', 'O3', 'crate-stack',
  'O3: the decoration\'s falling and rolling and the player\'s stepping on Play\'s inputs', {have: ['validate-plant-push, validate-decoration-settle-roll (O2)']});
add('5.3.7', '00_Training swim', 'enter the contaminated water with and without the HazMat suit: WaterZone0 and DamageTrigger1 radiation, the suit\'s duration and armor, swimming and leaving by the ramp', 'O1', 'hazmat-swim',
  'O1: live trace of the original (HazMatSuit activated by ActivateBelt, the player placed in the water, Health and the suit\'s charge per tick)',
  {have: ['validate-native-swimming 1093 cases (O2)', 'alterations census hit-radiation, hit-drowned (P)']});
add('5.3.8', '01_NYC_UNATCOIsland water', 'swim from the dock, dive to the ruins: breath (swimTimer, UnderWaterTime), drowning damage, surfacing', 'O1', 'island-swim',
  'O1: live trace of the original with the player placed under water until breath runs out', {have: ['validate-native-swimming (O2)', 'validate-island-swimming (the fish, P)']});
add('5.3.9', '01_NYC_UNATCOIsland terminals', 'ComputerPersonal0 login with a user list, email; ATM0; ComputerSecurity camera views and door/turret choices', 'O1', 'island-terminal',
  'O1: frames of the original\'s login and screens plus the computer state after choices', {have: ['security terminal screens O1 (4.4.13)', 'Terminals in Play (P)']});
add('5.3.10', '01_NYC_UNATCOIsland doors', 'keyed, locked, breakable and keypad doors: the satcomhatch with the UNhatchdoor NanoKey, commvan_door keypad 0451, breakable and lockpicked movers, StatueRuinDoors', 'O1', 'island-doors',
  'O1: live trace of the original at each door (key use, pick, damage) with mover and lock state per tick',
  {have: ['validate-island-cell-door, validate-island-blowitup (mover bodies, O2)', 'validate-native-mover-move, -interpolation, -scene (O2)']});
add('5.3.11', '01_NYC_UNATCOIsland inventory', 'pick up and use items (MedKit, food, ammo, mods, Lockpick, Multitool), skill points (SkillAwardTrigger) and the skills screen, the AugmentationCannister and installing an augmentation, goals and notes', 'O1', 'island-items',
  'O1: live trace of the original (ParseRightClick pickups, ActivateBelt, console) with inventory, health, skill and goal state',
  {have: ['alterations census: 19 scenarios play (P)', 'persona screens O1 (4.4.11, 4.4.12)']});
add('5.3.12', '01_NYC_UNATCOIsland', 'move objects and fall: carry or push barrels and crates, throw them (kinetic damage), fall damage from a height', 'O1', 'island-movables-fall',
  'O1: live trace of the original with a thrown or pushed decoration and a measured fall', {have: ['validate-plant-push (O2)', 'landing/falling oracles (O2)']});
add('5.3.13', '00_TrainingFinal and 01_NYC_UNATCOIsland movers', 'a switch-driven mover: 00_TrainingFinal Switch1 opens FirstStealthDoor; the exit door ElevatorMover1 (ExitDoor, a 64-unit slide, not a ride) is closed by a soldier\'s alarm (AlarmDispatcher -> CloseDoor, SequenceTrigger SeqNum 1) and reopened by Switch0 (ButtonDispatcher -> OpenDoor, SeqNum 0). Not driven: Island\'s Switch1 -> UN_maindoor (opened by Mission01) and the fork lift (DeusExMover11, a button in the ruins)', 'O1', 'elevator',
  'O1: live trace of the original at Switch1 and of the exit door closed by the alarm and reopened by Switch0', {have: ['validate-native-mover-move, -interpolation, -scene (O2)', 'validate-island-cell-door']});

// 5.4 Conversation -----------------------------------------------------------------------------------------------------------------------
add('5.4.1', '00_Training', 'the 18 DataLinks of the course start at their triggers, queue behind a playing one, end and set DL_*_Played; DL_Lockpick starts from the Mission00 timer', 'O1', 'training-datalinks',
  'O1: the original\'s InfoLink window frames and the Played flags per tick (the window is not yet compared)', {have: ['validate-training-datalinks, validate-training-datalink-live (P)', 'script-datalink-original.md']});
add('5.4.2', '00_TrainingCombat', 'the instructor takes the inventory: MunitionsTrooperTake/Frob (29 TransferObject events), MunitionsTrooperReady, Mission00.RemoveAllInventory', 'O1', 'instructor-take',
  'O1: live trace of the original through the conversation with the inventory per tick', {have: ['validate-instructor-conversation (P)']});
add('5.4.3', '01_NYC_UNATCOIsland', 'MeetPaul: the three weapon choices (Minicrossbow, GEP gun, rifle) hand JC the weapon, the map image and three goals', 'O1', 'meet-paul',
  'O1: the conversation frames to the choice (4.5.5) plus the transferred object and goals per branch',
  {proof: live('pG', 'pR', 'pX'), have: ['4.5.5 O1 frames', 'validate-island-conversation: each choice plays to the end (P)'],
    weak: 'The player is placed at the dock inside MeetPaul\'s radius and the speeches are skipped with Enter (the harness cannot walk; a skipped line ends in both programs at the key, so a line\'s full length is compared only where it runs out). What a branch gives is compared through the player\'s Inventory chain (the classes in order), FirstGoal and FirstImage, and the creations (the weapon, its ammunition, the image and the goals, in class and tick).'});
add('5.4.4', '01_NYC_UNATCOIsland', 'MeetFilben (code phrase): the Choice decides FilbenGaveKey and the NanoKey; MeetFilben2 and AfterStatue follow the flags; skill points', 'O1', 'meet-filben',
  'O1: live trace of the original through each branch with the flags, inventory and skill points',
  {proof: live('fT', 'fM', 'fN', 'tA'),
    weak: 'The player is placed 50 units from Filben. MeetFilben2 is started by a fan of right-button frobs: Filben wanders off at the end of MeetFilben (HarleyStartsToWander) on a path the load\'s stream chooses. AfterStatue is MeetFilbenAfterStatue in tA (Filben never met, StatueMissionComplete set by MeetTerrorist\'s Aggressive branch). FilbenSecondBark and FilbenFinalBark, which also read FilbenGaveKey, are not captured.'});
add('5.4.5', '01_NYC_UNATCOIsland', 'GuntherRescued: free Gunther (the wall button DeusExMover8 triggers the cell door DeusExMover10, GuntherFreed), five choices, the player gives him a weapon (CheckObject/TransferObject), GuntherRespectsPlayer, AddSkillPoints, his alliance and orders', 'O1', 'gunther-rescued',
  'O1: live trace of the original through the branches with flags, inventory and Gunther\'s orders',
  {proof: live('gP', 'gN', 'gA'),
    weak: 'Two of the five CheckObject/Choice pairs are captured: PistolChoice\'s give (gP: TransferObject of the carried pistol, GiveSpeech, GuntherRespectsPlayer, the trigger GuntherAttacks: RunningTo) and NothingChoice\'s second answer (gN: GiveNothing, GuntherRespectsPlayer false). The assault gun, stealth pistol and knife gives run the same CheckObject, Choice and TransferObject events with another class, and NothingChoice\'s first answer (GiveNothingNicely) the same SetFlag and Trigger; none of the four is captured. The player is placed at the button (a placement touches no trigger); gA touches AllianceTrigger0 and OrdersTrigger6 with a landing, and its freed Gunther fights Terrorist18 instead of talking.'});
add('5.4.6', '01_NYC_UNATCOIsland', 'MeetTerrorist with the commander: the Aggressive and Curious branches set PlayerAttackedStatueTerrorist and StatueMissionComplete; TerroristFollowup', 'O1', 'meet-terrorist',
  'O1: live trace of the original through both branches with the flags and the commander\'s orders',
  {proof: live('tC', 'tA'),
    weak: 'The player is placed inside the commander\'s radius and the speeches are skipped. tC (Curious) also runs DL_LeaderNotKilled and Mission01.Timer\'s mission-complete pass; tA (Aggressive) ends with the commander attacking and the player placed at Filben.'});
add('5.4.7', '01_NYC_UNATCOIsland', 'overheard conversations and barks: TerroristsOverheard (Amos), TopTerroristsOverheard, the NPC barks in alert states', 'O1', 'overheard-barks',
  'O1: live trace of the original with the player in range (the bark choice and the speech started)',
  {proof: live('oV', 'oT', 'cmb2', 'cmb3'), have: ['validate-island-bark (P)', 'validate-island-lipsync (O3)'],
    weak: 'The overheard conversations are first person and non-interactive; the player is placed hidden inside their radius. The barks are the alert-state barks of the combat scenes (cmb2, cmb3: the ConPlayBark, the bark line\'s Sound by name and its subtitle window at the original\'s ticks, the choice through the equal stream draws); none drives a mouth letter there.'});
add('5.4.8', '00_TrainingFinal', 'M00MeetPage and holo-Jaime: ConversationTrigger, JaimeAppears/JaimeBark_Played, EnterWorld/LeaveWorld by the Mission00 timer', 'O1', 'meet-page-final',
  'O1: live trace of the original with the flags and the holo pawns\' bInWorld');

// 5.5 Alternate-route objectives (Liberty Island) ---------------------------------------------------------------------------------------------
add('5.5.1', '01_NYC_UNATCOIsland front entrance', 'with the key from Filben (its first choice) the front doors (StatueRuinDoors, four movers) unlock and open; without it they stay locked and the player can pick them (lockStrength 0.1); they cannot be broken (bBreakable false)', 'O1', 'route-front',
  'O1: live trace of the original at the doors with and without the key and with the lockpick (key ring or Lockpick in hand, left-button click, then the right button to open)', {weak: 'The approach to the doors is placed; the guards near them are not compared.'});
add('5.5.2', '01_NYC_UNATCOIsland back entrance', 'the back way in (DL_BackEntrance, DeusExMover2: lockStrength 0.1, doorStrength 0.5, no key): lockpick it or break it; no hackable device guards it; the guards at the lower deck', 'O1', 'route-back',
  'O1: live trace of the original at DeusExMover2 (Lockpick in hand, left-button click, then the right button to open; the break by damage) and the patrol', {weak: 'The census drives the lockpick only; the approach is placed.'});
add('5.5.3', '01_NYC_UNATCOIsland airshafts', 'the airshaft route around the laser trap to Gunther\'s cell (DL_libertyruinsairshaft x3): crouch through the shafts, the NPCs and alarms bypassed', 'O1', 'route-airshaft',
  'O1: the same state comparisons with the player placed in the shaft', {weak: 'The shaft geometry is not read from the BSP here; the DataLinks name the route.'});
add('5.5.4', '01_NYC_UNATCOIsland water route', 'the east side by water: swim to the ruins, the electric arcs (ElectricityEmitter x3, LibElectric, EMP damage drains energy), ControlPanel1 and the fork lift', 'O1', 'route-water',
  'O1: live trace of the original from the water to the arcs, the panel and the lift');
add('5.5.5', '01_NYC_UNATCOIsland', 'kill the commander: TerroristCommander_Dead -> DL_LeaderKilled (InSpite after NotKilled) -> StatueMissionComplete', 'O1', 'objective-kill',
  'O1: live trace of the original from the commander\'s death through Mission01.Timer');
add('5.5.6', '01_NYC_UNATCOIsland', 'spare the commander: MeetTerrorist (Curious) -> StatueMissionComplete; DL_LeaderNotKilled', 'O1', 'objective-spare',
  'O1: live trace of the original through the conversation and the timer');
add('5.5.7', '01_NYC_UNATCOIsland', 'StatueMissionComplete changes the world (Mission01.Timer): UN_maindoor opens, doors unlock, custody and post-mission troops enter, Terrorists die, Paul teleports, turrets and lasers go, cameras silenced', 'O1', 'mission-complete',
  'O1: live trace of the original after the flag with every changed actor per tick');

// 5.6 Systems interacting ---------------------------------------------------------------------------------------------------------------------
add('5.6.1', '01_NYC_UNATCOIsland', 'a shot near guards: noise, hostility, pursuit, distress to other pawns, the player hurt and healed with a MedKit', 'O1', 'noise-wakes-guards',
  'O1: live trace of the original of the whole encounter', {proof: live('cmb7'), have: ['5.1.5, 5.1.6, 5.2.3 each partial', 'validate-stage5-live cmb2 (O1: the shots near the guards, their hostility, distress and the player hurt; no MedKit)'],
    weak: 'cmb7: two shots from 700 units behind Terrorist0 (the second kills it), the three NSF pawns attack, the player is hurt from tick 548 and the MedKit (ActivateBelt 2, the Enter edge at 700) heals every region to 100 at 701. The MedKit\'s own state (NumCopies, a summoned actor) is not watched: the heal is read through the player\'s Health and hit regions.'});
add('5.6.2', '00_TrainingFinal alarm', 'an AlarmUnit trips (bActive for its alarmTimeout, 10 s): AlarmDispatcher fires SoldierNeutral (AllianceTriggers), CloseDoor (ExitDoor) and failmessage (DL_FailedStealth)', 'O1', 'alarm-chain', 'O1: live trace of the original from the alarm\'s trigger');
add('5.6.3', '01_NYC_UNATCOIsland', 'light against sight: a pose seen or not seen by its lighting (AICanSee times AIVisibility against VisibilityThreshold). Island has no light switch, and AugLight adds a second path (its Beam AI event, CheckBeamPresence), so the census pair is the map\'s own lighting: two poses 500 units in front of Terrorist4 with a clear line of sight, one in shadow, one lit', 'O1', 'light-vs-sight',
  'O1: live trace of the original with Terrorist4\'s perception fields and the player\'s visibility at the two poses', {have: ['validate-pawn-perception, AICanSee (O2)', 'lighting oracles (O2)']});
add('5.6.4', '01_NYC_UNATCOIsland', 'an explosion: a barrel or CrateExplosiveSmall near a Terrorist, a breakable door and a decoration: HurtRadius, damage to each, noise, chain explosions', 'O1', 'explosion-world',
  'O1: live trace of the original with the barrel shot', {have: ['validate-island-blowitup (O2)', 'VisibleCollidingActors iterator 312 (O2)']});
add('5.6.5', '01_NYC_UNATCOIsland', 'EMP: an EMP grenade or the EMP field against a SecurityBot, the turret and the camera (disabled) and the player\'s energy', 'O1', 'emp-electronics',
  'O1: live trace of the original with an EMP grenade thrown at the bot', {have: ['alterations census emp-grenade, hit-emp (P)']});
add('5.6.6', '01_NYC_UNATCOIsland', 'conversation flags change the world: GuntherFreed (the cell door chain; on the same walk Gunther\'s alliance flips at AllianceTrigger0\'s touch, and GuntherRescued\'s GuntherAttacks gives his orders), FilbenGaveKey, M01PlayerAggressive, KnowsShipment', 'O1', 'flags-change-world',
  'O1: live trace of the original from each flag\'s source to the world it changes',
  {proof: live('gP', 'gN', 'gA', 'fT', 'fM', 'fN', 'oV', 'kC'),
    have: ['validate-stage5-live kB (O1, pass as a comparison: the Tantalus at tick 80 missed Terrorist18, seven carcasses, the player placed outside the world at the trooper, no M01PlayerAggressive in either program)'],
    weak: 'GuntherFreed through the cell door and AllianceTrigger0 to Gunther\'s orders (gP gN gA); FilbenGaveKey to MeetFilben2\'s two branches (fT fM fN); KnowsShipment to MoleConvos and BumFemaleWanders (oV); M01PlayerAggressive from Mission01.Timer\'s count to TrooperCongratulation\'s JustTerrorists branch (kC). kC\'s eight kills are DeusExPlayer.Tantalus (the cheat: every health 0 and TakeDamage from the player), not weapon fire, each from a placement, and Terrorist18 is killed at tick 3, before StartUp lets it walk to a seat. PaulCongratulations (PaulWandering) and Filben\'s two barks are not captured.'});

// Excluded --------------------------------------------------------------------------------------------------------------------------------
excluded('5.7.1', 'every map', 'Save Game, Load Game, QuickSave and the load menu after death', 'Stage 6 (roadmap section 6): native 3011/3013; Stage 3 gate tolerates 3011');
excluded('5.7.2', 'Teleporter, MapExit, ClientTravel', 'Training map to map, Island to Battery Park, the HQ teleporter, the boat cinematic\'s end', 'Stage 6: map travel and PlayerTraveling (a measured host input)');
excluded('5.7.3', 'flags across maps', 'flag expiration by mission number and persistence (M01PlayerAggressive until mission 6, DL_*_Played)', 'Stage 6: persistence');
excluded('5.7.4', 'DXMP maps', 'multiplayer: replication, GameInfo MP, bots, the DXMP maps', 'Multiplayer is the last priority and may stay unsupported (AGENTS.md)');
excluded('5.7.5', 'rendering of the above', 'how a scenario looks (weapon models, effects, windows)', 'Stage 4: the Stage 4 gate owns presentation');

/** Replace what sits between the `criteria:start` and `criteria:end` comments of the doc by `tables`. */
export function injectTables(doc, tables) {
  const start = '<!-- criteria:start -->', end = '<!-- criteria:end -->';
  const a = doc.indexOf(start), b = doc.indexOf(end);
  if (a < 0 || b < a) throw new Error('the doc has no criteria:start/end markers');
  return `${doc.slice(0, a + start.length)}\n${tables}\n${doc.slice(b)}`;
}

/** The criteria tables of the doc, one per clause. `status(row)` supplies the Status cell. */
export function renderTables(status = () => 'MISSING') {
  const cell = text => String(text ?? '').replace(/\|/g, '/').replace(/\n/g, ' ');
  const out = [];
  for (const [clause, name] of [...Object.entries(CLAUSES), ['7', 'Excluded']]) {
    const rows = CRITERIA.filter(row => row.clause === Number(clause));
    if (!rows.length) continue;
    out.push(`### 5.${clause} ${name}`, '', '| Id | Scene | Scenario | Ev. | Census | Proof that would pass it | Existing, partial | Status |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const row of rows) out.push(`| ${row.id} | ${cell(row.scene)} | ${cell(row.claim)} | ${row.ev} | ${row.census ? `\`${row.census}\`` : '-'} | ${cell(row.excluded ? row.excluded : row.need)} | ${cell((row.have ?? []).join('; ') || '-')} | ${status(row)} |`);
    out.push('');
  }
  return out.join('\n');
}
