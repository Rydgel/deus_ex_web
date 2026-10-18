#!/usr/bin/env node
/** Stage 5 proof check (docs/stage-5-exit-criteria.md, class O1): a live capture of the original playing a gameplay scene, replayed in Play.
 *
 * Each scene is a stored trace of the original (`scripts/live-original.sh <map> --tag <tag> ...` with the flags and command list below, under the
 * bottle lock), taken with the AI event manager's breakpoints (`.work/live-acceptance/cfg/combat-900.cfg`). The check replays it in Play
 * (`live-acceptance.mjs play`: the original's deltas, stream state per tick and per key edge, the placement the original's frozen phase left,
 * the same console lines and key edges at the same ticks) and passes only when
 *   - every watched field of every watched actor (all ScriptedPawns, the player's pose, gear and hit regions, the perception fields) is equal
 *     (float32) at every tick (`live-acceptance.mjs compare`),
 *   - the level clock and the stream draws per tick are equal,
 *   - every AI event manager call and delivered callback is equal in order and value (`live-events-compare.mjs`),
 *   - every object the scene creates is the original's, in class and tick, in order (`live-sound-compare.mjs`'s registry part; the slots are reported).
 * The original is never started here: a scene whose stored trace is absent prints SKIP and exits 0 (the gate counts it as not passing). The validator sweep
 * leaves this check out (scripts/run-validators.mjs SWEEP_EXCLUDED): it runs as a Stage 5 proof check, with --scene.
 *
 *   node scripts/validate-stage5-live.mjs --scene cmb1
 *
 * Scenes (01_NYC_UNATCOIsland, Terrorist0 standing on open ground at (9651, 190) facing yaw 8624; the player placed in the original's frozen
 * phase (after `KillAll FlyGenerator`) by `ghost`, a SET of Location while out of the collision hash, `walk` (PlayerPawn.StartWalk re-adds it), and a SET of ViewRotation):
 *   cmb1  700 units in front of Terrorist0 (bearing 45 degrees, inside its view): the pistol summoned, picked up and drawn, aimed at Terrorist0, three
 *         Enter key edges (ParseLeftClick|Fire) at ticks 420, 480 and 540; 900 ticks. Sight at 700, the Terrorists' attack on the player, hits both ways.
 *   cmb2  700 units behind Terrorist0 (bearing 180 degrees, the census's island-sight pose), facing away: the pistol taken the same way, then at tick 590
 *         turned on Terrorist0; Enter edges at 600, 630 and 660 (the press at 630 falls inside the pistol's refire time and fires nothing); 900 ticks.
 *         The stored original: no Terrorist notices the player for 600 ticks; the two hits take Terrorist0 to 43 (TakingHit) and 30 (Fleeing) and wake the others.
 *   cmb3  150 units behind Terrorist0 (bearing 227 degrees), facing its back at head height: the pistol taken the same way, four Enter edges at 300, 360,
 *         420 and 480; 900 ticks. The stored original: Terrorist0 and ThugMale7 notice the player at tick 42; the first shot hits ThugMale7 (100 to 68), who
 *         stepped into the line, and the others miss; no kill.
 *   cmb4  cmb1's pose with BallisticArmor instead of the pistol: picked up, put in hand (ActivateBelt 1) and activated by the Enter edge at 180
 *         (ParseLeftClick: an activatable inHand's Activate); 900 ticks of the Terrorists' fire on an armored player.
 *   cmb5  a body found by a pawn that was not fighting: Terrorist16 on the statue's terrace killed at tick 20 by DeusExPlayer.Tantalus from a ledge
 *         900 units east, out of every NSF pawn's view; 900 ticks. The stored original: TerroristCarcass1 at 98 (its Inventory chain: the pistol, its
 *         ammo and the combat knife), the patrolling Terrorist21 meets it at 512 (CarcassTimer 120, Seeking, SeekType 4: SEEKTYPE_Carcass).
 *   cmb6  cmb1's inputs with the carcass watched; the stored original: the Terrorists' own fire kills ThugMale7 at 395 (ThugMale2Carcass0) and the
 *         player's three shots miss Terrorist0.
 *   cmb7  cmb2's pose with a MedKit picked up too (belt slot 2), shots at 300 and 360, the MedKit put in hand at 650 and used by the Enter edge at
 *         700; the stored original: the second shot kills Terrorist0, the others attack, the player is hurt from 548 and healed to 100 at 701.
 * A scene's `carcasses` are watched from the tick they appear (--carcass-watch: the tracer's late-watch, Play's lazy lookup), with their Inventory chain.
 * cmb1's stored original: Terrorist0 and ThugMale7 seek the player from tick 41 and attack from 178; the player's first shot (420) kills Terrorist0
 * (TerroristCarcass1 at 469). cmb3's: the Terrorists' fire kills the player at 863 (Dying, DeathFront through 900).
 *
 * A scene with `levelEnd` runs until the original leaves the level: the Dying player's PlayerCalcView types `OPEN DXONLY` once its fade reaches -1
 * (DeusExPlayer.uc state Dying, 20 s after FrobTime, the last render before bHidden), UGameEngine::Exec stores the URL (SetClientTravel, which also runs
 * every actor's PreTravel) and the next engine tick browses to it after the level's tick (UGameEngine::Tick's client travel). The tracer writes the
 * unfrozen ticks the level ran to <trace>.ended and detaches there (tools/dx-live-win.c); Play's replay stops at its own client travel (game.mjs
 * clientTravel, play-level-end<tag>.json). The check also passes only when both ended after the same tick and the trace holds every tick up to it.
 *   die1  cmb1's pose, no weapon, HealthTorso and HealthHead lowered to 5 by console SET in the frozen phase (both programs run the same line; the original's
 *         is read back before the tracer attaches): the Terrorists' fire kills the player, the Dying state runs to the OPEN and the level ends. Watched: the
 *         eight NSF pawns within 5,000 units of the pose (the trace of every pawn for 2,000 ticks would not fit the machine), the player and its carcass; the
 *         other ScriptedPawns are traced with their load-time fields only (live-acceptance.mjs `loadPawns`), written into Play and not compared.
 *         The stored original (2026-10-18): death at tick 652 (DeathFront), the carcass at 730, the OPEN in the render after 1930, the level's end after 1931. */
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const option = name => { const i = argv.indexOf(`--${name}`); return i < 0 ? null : argv[i + 1]; };

const PISTOL = yaw => `20:summon DeusEx.WeaponPistol|50:set DeusEx.JCDentonMale ViewRotation (Pitch=-10130,Yaw=${yaw},Roll=0)|90:ParseRightClick|130:ActivateBelt 1`;
const SHOTS = ticks => ticks.map(t => `${t}:@down Enter|${t}:@up Enter`).join('|');
// `KillAll FlyGenerator` first: the load's chance FlyGenerators (10% per fly-making decoration) removed in both programs, as row 4.2.13 does.
const PLACE = (x, y, z, yaw, pitch = 0) => `KillAll FlyGenerator|ghost|set DeusEx.JCDentonMale Location (X=${x},Y=${y},Z=${z})|walk|set DeusEx.JCDentonMale ViewRotation (Pitch=${pitch},Yaw=${yaw},Roll=0)`;
// The alternate routes and the mission (rows 5.5.x, 5.3.10): doors, locks, keys, the commander and Mission01.Timer's world change (Mission01.uc).
const AIM = (n, yaw, pitch = 0) => `${n}:set DeusEx.JCDentonMale ViewRotation (Pitch=${pitch},Yaw=${yaw},Roll=0)`;
// a placement typed in a hold of the scene: both programs run it between the same two ticks (the early placement's lines)
const MOVE = (n, x, y, z, yaw, pitch = 0) => `${n}:ghost|${n}:set DeusEx.JCDentonMale Location (X=${x},Y=${y},Z=${z})|${n}:walk|${AIM(n, yaw, pitch)}`;
// what Mission01.Timer changes once StatueMissionComplete is set: UN_maindoor opened, the StatueRuinDoors and temp_celldoor unlocked, NSFTurret01/02 and the
// statue_lasertrap LaserTriggers destroyed, NSFCam01..03 silenced (SecurityCamera1, UN_CamSystem03, is a camera it leaves alone)
const MISSION_DEVICES = [...['DeusExMover16', 'DeusExMover17', 'DeusExMover12', 'DeusExMover6', 'DeusExMover22', 'DeusExMover23', 'DeusExMover10'].map(n => `${n}:DeusExMover`),
  'AutoTurret0:AutoTurret', 'AutoTurret2:AutoTurret', ...[0, 1, 2, 3, 4].map(i => `LaserTrigger${i}:LaserTrigger`),
  ...['SecurityCamera5', 'SecurityCamera3', 'SecurityCamera7', 'SecurityCamera1'].map(n => `${n}:SecurityCamera`)];
const MISSION_FLAGS = ['TerroristCommander_Dead', 'MS_DL_Played', 'DL_LeaderKilled_Played', 'StatueMissionComplete', 'MS_MissionComplete', 'MeetTerrorist_Played',
  'PlayerAttackedStatueTerrorist', 'MS_DL2_Played', 'DL_LeaderNotKilled_Played', 'M01PlayerAggressive'];
const ROUTE_SCENES = {
  // 5.5.5 and 5.5.7: the commander (Health 100) killed by one GEP rocket from 300 units in front of him, outside MeetTerrorist's radius (140); a pistol's
  // three hits made him flee in the rehearsal, out of a fixed aim. Mission01.Timer then starts DL_LeaderKilled, whose event sets StatueMissionComplete,
  // and the next Timer changes the world. The rest of the pawns are traced with their load fields only (die1's rule).
  kil1: {map: '01_NYC_UNATCOIsland', ticks: 1100, early: PLACE(2975.7, 324.2, 2547, 47600),
    cmds: `20:summon DeusEx.WeaponGEPGun|50:set DeusEx.JCDentonMale ViewRotation (Pitch=-10130,Yaw=47600,Roll=0)|90:ParseRightClick|130:ActivateBelt 1|${AIM(240, 47600, -800)}|${SHOTS([300])}`,
    watch: ['TerroristCommander0', 'Terrorist8', 'Terrorist9', 'ThugMale3', 'Terrorist22', 'UNATCOTroop3', 'UNATCOTroop7', 'UNATCOTroop8', 'GuntherHermann0', 'SecurityBot1',
      'PaulDenton0', 'Terrorist0', 'ThugMale7'],
    devices: [...MISSION_DEVICES, 'WeaponGEPGun0:Weapon', 'Rocket0:Projectile'], flags: MISSION_FLAGS, options: ['--player-talk', '--stop-destroyed']},
  // 5.3.10, the keyed and the keypad doors: NanoKey0 (KeyID UNhatchdoor) picked up with the right button (PickupNanoKey, the key ring); at the satcom hatch
  // DeusExMover7 (KeyIDNeeded UNhatchdoor) the key ring is put in hand (ActivateBelt 0) and used with the left button (ParseLeftClick: DoFrob(Self, inHand),
  // DeusExMover.Frob toggles bLocked), then the right button opens it; at Keypad0 the right button opens the keypad window and the keys 0 4 5 1
  // (HUDKeypadWindow.VirtualKeyPressed, ValidateCode) trigger commvan_door, DeusExMover21. The poses: the census's approach (view trace selecting each target).
  dor1: {map: '01_NYC_UNATCOIsland', ticks: 900, early: PLACE(-5640.5, 1177.4, -92, 32768, -10910),
    cmds: `30:ParseRightClick|${MOVE(90, -6400, 1376, -128, 32768, -7246)}|150:ActivateBelt 0|${SHOTS([220])}|280:ParseRightClick`
      + `|${MOVE(400, -6097.1, 1274.1, -92, 0, -5065)}|460:ParseRightClick|${['0', '4', '5', '1'].map((d, i) => `${520 + 20 * i}:@down Digit${d}|${520 + 20 * i}:@up Digit${d}`).join('|')}`,
    devices: ['NanoKey0:Actor', 'DeusExMover7:DeusExMover', 'Keypad0:ControlPanel', 'DeusExMover21:DeusExMover']},
  // 5.5.2 picked and 5.5.1 without the key (and 5.3.10's lockpicked doors): two Lockpicks summoned and picked up facing away at the back entrance (the second
  // joins the first: NumCopies 2), put in hand (ActivateBelt 1); at DeusExMover2 (no key, lockStrength 0.1) the bare right button leaves it locked
  // (DeusExMover.Frob: msgLocked), the left button picks it (ParseLeftClick: DoFrob(Self, inHand), DeusExMover.Timer), the right button opens it. Then at the
  // StatueRuinDoors (four movers led by DeusExMover12, KeyIDNeeded ruin_key, lockStrength 0.1) the same three inputs: the four share the pick and open together
  // (like-tagged movers). The front is last and short: its patrols shoot the player there (the rehearsal: from about 340 ticks after arrival).
  dor2: {map: '01_NYC_UNATCOIsland', ticks: 1150, early: PLACE(7735.5, 742.5, -96, 57344),
    cmds: `20:summon DeusEx.Lockpick|${AIM(50, 57344, -10130)}|90:ParseRightClick|100:summon DeusEx.Lockpick|140:ParseRightClick|170:ActivateBelt 1|${AIM(210, 24576, -7055)}`
      + `|240:ParseRightClick|${SHOTS([270])}|530:ParseRightClick|${MOVE(600, 530.7, 29.3, -88, 57344, 5849)}|640:ParseRightClick|${SHOTS([680])}|950:ParseRightClick`,
    devices: ['DeusExMover2', 'DeusExMover12', 'DeusExMover6', 'DeusExMover22', 'DeusExMover23'].map(n => `${n}:DeusExMover`)},
  // 5.5.2 broken (and 5.3.10's breakable door): the back entrance DeusExMover2 (bBreakable, doorStrength 0.5, minDamageThreshold 50) hit by a GEP rocket from
  // 336 units (the explosion's HurtRadius: DeusExMover.TakeDamage, doorStrength to 0, BlowItUp: fragments, bDestroyed); the MedicalBots behind it watched with
  // every pawn.
  dor3: {map: '01_NYC_UNATCOIsland', ticks: 600, early: PLACE(7947.6, 530.4, -96, 57344),
    cmds: `20:summon DeusEx.WeaponGEPGun|${AIM(50, 57344, -10130)}|90:ParseRightClick|130:ActivateBelt 1|${AIM(240, 24576, -837)}|${SHOTS([300])}`,
    devices: ['DeusExMover2:DeusExMover']},
  // 5.5.4, the water route's east end in the ruins: ControlPanel1 (UnTriggerEvent LibElectric) hacked with a Multitool from beside the arcs; first a short
  // drop into the arcs (the three ElectricityEmitters: 'Shocked' 20 a hit; DamageTrigger1 under them: EMP 2 a touch, the player's Energy), out again, the hack
  // (HackableDevices.Timer, HackAction: UnTrigger LibElectric turns the emitters and the trigger off), the drop again (nothing), and Button2 (Event fork) raises
  // the fork lift DeusExMover11 (MoveTime 12). A drop from 126 units above the floor is the walk in: falling into the trigger's cylinder Touches it.
  wat1: {map: '01_NYC_UNATCOIsland', ticks: 1300, early: PLACE(7056.7, -3326, -416, 0),
    cmds: `20:summon DeusEx.Multitool|${AIM(50, 0, -10130)}|90:ParseRightClick|130:ActivateBelt 1|${MOVE(200, 6929, -3157.5, -290, -16384)}|${MOVE(265, 7056.7, -3326, -416, 32768, -3000)}`
      + `|${SHOTS([320])}|${MOVE(650, 6929, -3157.5, -290, -16384)}|${MOVE(750, 7362.3, -3227.4, -416, 35499, -3823)}|800:ParseRightClick`,
    devices: ['ElectricityEmitter0:ElectricityEmitter', 'ElectricityEmitter2:ElectricityEmitter', 'ElectricityEmitter5:ElectricityEmitter', 'DamageTrigger1:DamageTrigger',
      'ControlPanel1:ControlPanel', 'Button2:Actor', 'DeusExMover11:DeusExMover'], options: ['--player-energy']},
  // 5.5.3, the airshafts around the laser trap: the player drops into the DataLinkTriggers of DL_libertyruinsairshaft (a drop from just above the cylinder is the
  // walk in: a placement inside it Touches nothing), DataLinkTrigger19 in the room at the shaft and DataLinkTrigger20 in the shaft; the DataLink plays once
  // (DataLinkTrigger.Touch: StartDataLinkTransmission; in Play's rehearsal from tick 64 to about 890, DL_libertyruinsairshaft_Played at 801), the second
  // drop comes after its end, and every pawn is watched (the guards of the laser trap do not notice the player). DataLinkTrigger21 sits in a crawlspace 120
  // units high: a standing player cannot be dropped into its cylinder, and the harness cannot hold the crouch key.
  air1: {map: '01_NYC_UNATCOIsland', ticks: 1200, early: PLACE(2112, -675, -95, 0),
    cmds: `${MOVE(60, 2362, -675, -8, 0)}|${MOVE(950, 3546, -1116, -129, 0)}`,
    devices: ['DataLinkTrigger19:Actor', 'DataLinkTrigger20:Actor', 'DataLinkTrigger21:Actor'], flags: ['DL_libertyruinsairshaft_Played'], options: ['--player-talk']},
};
export const SCENES = {
  cmb1: {map: '01_NYC_UNATCOIsland', ticks: 900, early: PLACE(10146.3, 685.2, -88, 40960),
    cmds: `${PISTOL(40960)}|170:set DeusEx.JCDentonMale ViewRotation (Pitch=-536,Yaw=40960,Roll=0)|${SHOTS([420, 480, 540])}`},
  cmb2: {map: '01_NYC_UNATCOIsland', ticks: 900, early: PLACE(8951.3, 190.2, -84, 32768),
    cmds: `${PISTOL(32768)}|170:set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=32768,Roll=0)|590:set DeusEx.JCDentonMale ViewRotation (Pitch=-536,Yaw=0,Roll=0)|${SHOTS([600, 630, 660])}`},
  cmb3: {map: '01_NYC_UNATCOIsland', ticks: 900, early: PLACE(9549, 80.5, -84, 8624),
    cmds: `${PISTOL(8624)}|170:set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=8624,Roll=0)|${SHOTS([300, 360, 420, 480])}`},
  // ballistic armor instead of the pistol: picked up the same way, put in hand by ActivateBelt 1 and activated by the Enter edge (ParseLeftClick: inHand.bActivatable -> Activate)
  cmb4: {map: '01_NYC_UNATCOIsland', ticks: 900, early: PLACE(10146.3, 685.2, -88, 40960),
    cmds: '20:summon DeusEx.BallisticArmor|50:set DeusEx.JCDentonMale ViewRotation (Pitch=-10130,Yaw=40960,Roll=0)|90:ParseRightClick|130:ActivateBelt 1'
      + `|170:set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=40960,Roll=0)|${SHOTS([180])}`},
  // a body found by a pawn that was not fighting: Terrorist16 (standing on the statue's terrace at (321, -961, 512), facing yaw 28425) killed at tick 20 by
  // DeusExPlayer.Tantalus (the cheat: every health 0 and TakeDamage from the player, no shot, so no WeaponFire or LoudNoise from the player) from the ledge
  // 900 units east of it and 287 above, out of every NSF pawn's view; the patrolling Terrorist21 (1,032 units off: out of the death cry's and the distress's
  // 800-unit hearing) walks its route and meets the carcass (CheckCarcassPresence). The carcass and its Inventory chain are watched from the tick it appears.
  cmb5: {map: '01_NYC_UNATCOIsland', ticks: 900, early: PLACE(1221, -961, 799, 32768, -3632), cmds: '20:Tantalus', carcasses: ['TerroristCarcass1']},
  // cmb1's inputs again (the pistol's first shot at 420 killed Terrorist0 in both captures of cmb1), with the carcass the kill spawns watched: its Inventory chain
  cmb6: {map: '01_NYC_UNATCOIsland', ticks: 900, early: PLACE(10146.3, 685.2, -88, 40960),
    cmds: `${PISTOL(40960)}|170:set DeusEx.JCDentonMale ViewRotation (Pitch=-536,Yaw=40960,Roll=0)|${SHOTS([420, 480, 540])}`, carcasses: ['TerroristCarcass1']},
  // shots near unaware guards, then a MedKit: cmb2's pose (700 units behind Terrorist0); the pistol and a MedKit summoned and picked up facing away (the pistol in
  // belt slot 1, the MedKit in 2), the pistol drawn and turned on Terrorist0 at 200, Enter edges at 300 and 360; at 650 the MedKit is put in hand (ActivateBelt 2)
  // and the Enter edge at 700 uses it (ParseLeftClick: inHand.Activate, MedKit's Activated state: HealPlayer(healAmount, True), UseOnce)
  // the player's death to the level's end (row 5.1.8): `ticks` is the tracer's cap, the trace ends where the original's level ends
  die1: {map: '01_NYC_UNATCOIsland', ticks: 3000, levelEnd: true, early: `${PLACE(10146.3, 685.2, -88, 40960)}|set DeusEx.JCDentonMale HealthTorso 5|set DeusEx.JCDentonMale HealthHead 5`,
    cmds: '', carcasses: ['JCDentonMaleCarcass0'], watch: ['Terrorist0', 'ThugMale7', 'Terrorist10', 'Terrorist7', 'Terrorist3', 'Terrorist4', 'Terrorist27', 'ThugMale5']},
  // hacking ControlPanel0 (row 5.2.6): the player placed in front of the panel facing away from it; a Multitool summoned, picked up (ParseRightClick) and
  // drawn (ActivateBelt 1); turned on the panel and the Enter edge (ParseLeftClick: DoFrob(Self, inHand), HackableDevices.Frob's multitool branch); the hack
  // runs on HackableDevices.Timer while the player looks at the panel, then HackAction UnTriggers statue_lasertrap (the five LaserTriggers' emitters off).
  hck1: {map: '01_NYC_UNATCOIsland', ticks: 900, early: PLACE(1900, -895, -100, 0),
    cmds: '20:summon DeusEx.Multitool|50:set DeusEx.JCDentonMale ViewRotation (Pitch=-10130,Yaw=0,Roll=0)|90:ParseRightClick|130:ActivateBelt 1'
      + `|170:set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=32768,Roll=0)|${SHOTS([200])}`,
    devices: ['ControlPanel0:ControlPanel', ...[0, 1, 2, 3, 4].map(i => `LaserTrigger${i}:LaserTrigger`), 'AlarmUnit0:AlarmUnit', 'Multitool0:Multitool'], flags: ['StatueAlarmTriggered']},
  // a camera and the turret it wakes (rows 5.2.4, 5.1.9): the player placed 400 units in front of NSFCam02 (SecurityCamera3, facing yaw 16592, 300 units from
  // NSFTurret01), facing it. SecurityCamera.Tick checks the player every 0.1 s (CheckPlayerVisibility: in cameraRange 1024 and inside cameraFOV 4096 of the
  // camera's swinging Rotation), tracks him, and after triggerDelay 4 s TriggerEvent(True) sounds its klaxon and starts an 'Alarm' AI event (radius
  // 25 * (SoundRadius + 1)); AutoTurret0 (bActive false, bTrackPlayersOnly) hears it (AISetEventCallback('Alarm', 'AlarmHeard')), wakes, aims AutoTurretGun0
  // and fires at the player (fireRate 0.25, gunDamage 5).
  cam1: {map: '01_NYC_UNATCOIsland', ticks: 900, early: PLACE(250, 331, -100, 49152),
    cmds: '', devices: ['SecurityCamera3:SecurityCamera', 'AutoTurret0:AutoTurret', 'AutoTurretGun0:AutoTurretGun']},
  cmb7: {map: '01_NYC_UNATCOIsland', ticks: 900, early: PLACE(8951.3, 190.2, -84, 32768),
    cmds: '20:summon DeusEx.WeaponPistol|50:set DeusEx.JCDentonMale ViewRotation (Pitch=-10130,Yaw=32768,Roll=0)|90:ParseRightClick|100:summon DeusEx.MedKit|140:ParseRightClick'
      + `|170:ActivateBelt 1|200:set DeusEx.JCDentonMale ViewRotation (Pitch=-536,Yaw=0,Roll=0)|${SHOTS([300, 360])}|650:ActivateBelt 2|${SHOTS([700])}`},
  ...ROUTE_SCENES,
};
export const SCENE_FLAGS = ['--no-ghost', '--perception', '--player-gear', '--player-health', '--los-flag'];
// a scene's own options for both runs (`options`: --player-energy, --player-talk, --stop-destroyed); the scenes without keep exactly SCENE_FLAGS
const sceneFlags = scene => [...SCENE_FLAGS, ...(scene.options ?? [])];
// The replay's measured inputs beyond the trace rows: --render-history writes each pawn's LastRenderTime at the original's last frozen tick (the frames the
// original drew at the map's start pose, before the placement, stamped Paul, SecurityBot0 and UNATCOTroop1 at the dock; the stasis gate reads them).
const PLAY_FLAGS = ['--render-history'];
// The tracer's breakpoints of the captures (tools/dx-live-win.c `call`, docs/object-index-captures.md): the registry (AddObject, UnhashObject), the key
// edges' stream state (UEngine::InputEvent), the AI event manager (AISendEvent, AIStartEvent, AIEndEvent, AIClearEvent, the AIEvent callback) and the
// window system's frame deltas (Extension RootTick).
// A levelEnd scene also records UGameEngine::SetClientTravel (body 0x1038fa10; its four arguments: the viewport, the URL, bItems, TravelType): when the OPEN
// was typed, between which two ticks (`u`, inTick 0: the render after tick u).
export const captureConfig = scene => [`call-ticks 1 ${scene.ticks}`, 'call-frames', 'call 0x10157830 addobj 1 always retname', 'call 0x10157760 unhash 1 always retname',
  'call 0x103814e0 inputevent 4 always', 'call 0x10382c60 aisend 5 always name0 fname 1', 'call 0x10382fe0 aistart 5 always name0 fname 1',
  'call 0x103831e0 aiend 3 always name0 fname 1', 'call 0x103832c0 aiclear 2 always name0 fname 1',
  'call 0x10384980 aievent 5 always name0 fname 1 fname 4 namearg 3 0 deref 3 5 0', 'call Extension.dll@0x1003be90 roottick 1 always',
  ...(scene.levelEnd ? ['call 0x1038fa10 settravel 4 always'] : [])];
export const CAPTURE_CONFIG = captureConfig({ticks: 900});
const configFile = scene => `.work/live-acceptance/cfg/${scene.levelEnd ? 'death' : 'combat'}-${scene.ticks}.cfg`;
/** The original's capture command of a scene (for the doc and a recapture). */
export const captureCommand = tag => {
  const s = SCENES[tag];
  // (--carcass-watch: the carcasses the scene spawns, bound by the tracer when they appear: tools/dx-live-win.c late-watch; --watch: the pawns watched, all
  // ScriptedPawns when absent; --device-watch Name:Class: the devices the scene is about, with their class's fields (live-acceptance.mjs DEVICE_FIELDS);
  // --wait-seconds: the tracer's time, a long scene's run to the level's end)
  return `scripts/live-original.sh ${s.map} --tag ${tag} --ticks ${s.ticks} --delta 0.0166666675 ${sceneFlags(s).join(' ')} --registry${s.flags ? ' --dump-flags' : ''} --extra-config ${configFile(s)}`
    + `${s.carcasses ? ` --carcass-watch ${s.carcasses.join(',')}` : ''}${s.watch ? ` --watch ${s.watch.join(',')}` : ''}${s.devices ? ` --device-watch ${s.devices.join(',')}` : ''}`
    + `${s.levelEnd ? ` --wait-seconds ${Math.ceil(s.ticks * 0.6)}` : s.ticks > 900 ? ` --wait-seconds ${Math.ceil(600 * s.ticks / 900)}` : ''}`
    + ` --early-cmds "${s.early}" --cmds "${s.cmds}"`;
};

const exec = (args, limitSeconds) => new Promise(resolve => {
  const proc = spawn(process.execPath, args, {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
  let out = '';
  proc.stdout.on('data', d => { out += d; }); proc.stderr.on('data', d => { out += d; });
  const timer = setTimeout(() => proc.kill('SIGKILL'), limitSeconds * 1000);
  proc.on('exit', code => { clearTimeout(timer); resolve({code, out}); });
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tag = option('scene');
  const scene = SCENES[tag];
  if (!scene) { console.error(`--scene ${Object.keys(SCENES).join('|')}`); process.exit(2); }
  if (argv.includes('--print-capture')) {
    mkdirSync(path.join(root, '.work/live-acceptance/cfg'), {recursive: true});
    writeFileSync(path.join(root, configFile(scene)), captureConfig(scene).join('\n') + '\n');
    console.log(captureCommand(tag)); process.exit(0);
  }
  const dir = path.join(root, '.work/live-acceptance', scene.map);
  const stored = ['original-trace', 'watch', 'population', 'commands'].map(base => path.join(dir, `${base}-${tag}.${base === 'original-trace' ? 'jsonl' : 'json'}`));
  const absent = stored.filter(file => !existsSync(file));
  // A scene with a watch list replays the other pawns' load fields (live-acceptance.mjs `loadPawns`): a watch file without them is a capture from before that
  // group, whose replay draws on Play's own SightCounters (die1's first capture: the player's ShowSelf draw at tick 4, the original's at 12).
  if (!absent.length && scene.watch && !(JSON.parse(readFileSync(stored[1], 'utf8')).loadPawns?.length)) {
    console.log(`FAIL ${tag}: the stored watch file has no loadPawns (a capture from before the load-field group: recapture with --print-capture)`); process.exit(1);
  }
  // (exit 0, as the sweep's store-dependent validators do; the Stage 5 gate counts a SKIP as not passing)
  if (absent.length) { console.log(`SKIP no stored original for ${tag}: ${absent.map(f => path.relative(root, f)).join(', ')}`); process.exit(0); }
  const problems = [];
  // Play's population (play-population.json): the pre-placed actors, and those pending deletion, whose dump index the slot model takes. A file
  // without the pending list (written before it existed) would leave PickupDistributor0 the map table's index: the step runs again.
  const populationFile = path.join(dir, 'play-population.json');
  if (!existsSync(populationFile) || !JSON.parse(readFileSync(populationFile, 'utf8')).pendingDeleted) {
    const population = await exec(['scripts/live-acceptance.mjs', 'population', '--map', scene.map, '--seed', '1'], 600);
    if (population.code !== 0) { console.log(population.out.trim().split('\n').slice(-6).join('\n')); console.log(`FAIL ${tag}: the population step stopped (exit ${population.code})`); process.exit(1); }
    console.log(`population: ${population.out.trim().split('\n').slice(-1)[0]} (play-population.json written again: it had no pendingDeleted list)`);
  }
  const play = await exec(['scripts/live-acceptance.mjs', 'play', '--map', scene.map, '--seed', '1', '--tag', tag, ...sceneFlags(scene), ...PLAY_FLAGS, '--early-cmds', scene.early,
    '--event-trace', `1:${scene.ticks}`, '--object-trace', `1:${scene.ticks}`], Math.max(1800, scene.ticks * 2));
  if (play.code !== 0) { console.log(play.out.trim().split('\n').slice(-12).join('\n')); console.log(`FAIL ${tag}: the replay stopped (exit ${play.code})`); process.exit(1); }
  // the slot model's inputs (the run's own indices, the pre-frees and where they were released)
  for (const line of play.out.split('\n')) if (line.startsWith('object trace: ') && !/registry events/.test(line)) console.log(line);
  const compare = await exec(['scripts/live-acceptance.mjs', 'compare', '--map', scene.map, '--tag', tag, ...sceneFlags(scene)], 600);
  console.log(compare.out.trim());
  // the scene's own report (report-<tag>.json): another checkout's replay of the same map writes the untagged report.json in the shared .work
  const report = JSON.parse(readFileSync(path.join(dir, `report-${tag}.json`), 'utf8'));
  // (the actors Play watched: the trace's timed actors and load-field pawns are written into Play, not compared; a watched name Play's level lacks fails
  // the replay before the comparison, liveProbe's `no actor`)
  const actors = Object.entries(report.actors).filter(([, e]) => e.compared !== false && (e.compared || e.firstDifference !== null)), different = actors.filter(([, e]) => e.firstDifference !== null);
  if (different.length) problems.push(`${different.length} of ${actors.length} actors differ (${different.sort((a, b) => a[1].firstDifference - b[1].firstDifference).slice(0, 4).map(([n, e]) => `${n}@${e.firstDifference}`).join(' ')})`);
  if (report.clock?.firstDifference) problems.push(`clock differs at tick ${report.clock.firstDifference.tick}`);
  if (report.rng?.firstTickWithDifferentDrawCount) problems.push(`stream draws differ at tick ${report.rng.firstTickWithDifferentDrawCount.tick}`);
  const events = await exec(['scripts/live-events-compare.mjs', '--map', scene.map, '--tag', tag, '--show', '4'], 600);
  console.log(events.out.trim());
  if (events.code !== 0) problems.push(`AI events differ (${/(\d+) ticks differ/.exec(events.out)?.[1] ?? '?'} ticks)`);
  // Every object the scene creates (UObject::AddObject: weapons, ammo, tracers, decals, the carcass and what it holds) in class and tick, in order: the
  // registry part of live-sound-compare.mjs (its Galaxy half is not this check's: the scenes carry no `gplay` breakpoint). The registry slot each one takes is
  // reported, not judged: it follows the free list, and cmb3's tick-821 purge (ULevel::CleanupDestroyed) still releases two objects of the frozen start at
  // another place, and a pending-deleted pre-placed actor under another run's index (open, docs/stage-5-exit-criteria.md "First original captures"; the bark
  // subtitles' windows, the first cause, are fixed: a held tick's window frames are split at its commands).
  const registry = await exec(['scripts/live-sound-compare.mjs', '--map', scene.map, '--tag', tag], 600);
  const sequence = existsSync(path.join(dir, `sound-compare-${tag}.json`)) ? JSON.parse(readFileSync(path.join(dir, `sound-compare-${tag}.json`), 'utf8')) : null;
  if (registry.code !== 0 || !sequence) problems.push(`no registry comparison (${registry.out.trim().split('\n').slice(-1)[0]})`);
  else {
    const stem = cls => String(cls).replace(/\d+$/, '').toLowerCase(), {oAdds: a, pAdds: b} = sequence;
    let i = 0; while (i < a.length && i < b.length && stem(a[i].cls) === stem(b[i].cls) && a[i].u === b[i].u) i++;
    const slots = a.filter((o, k) => b[k] && o.index !== b[k].index).length;
    console.log(`registry: ${i} of ${a.length}/${b.length} creations equal in class and tick, in order; ${slots} take another slot`);
    if (i !== a.length || i !== b.length) problems.push(`creations differ at ${i} (original ${JSON.stringify(a[i] ?? null)}, Play ${JSON.stringify(b[i] ?? null)})`);
  }
  // A scene's `flags`: the player's FlagBase at the end of the scene, the original's (--dump-flags: tools/dump-flags-win.c at the end hold, flags-end<tag>.txt)
  // and Play's (flags-play-end<tag>.json), each named flag's presence, type and value.
  if (scene.flags) {
    const endFile = path.join(dir, `flags-end-${tag}.txt`), playFile = path.join(dir, `flags-play-end-${tag}.json`);
    if (!existsSync(endFile) || !existsSync(playFile)) problems.push(`no end flags (${[endFile, playFile].filter(f => !existsSync(f)).map(f => path.basename(f)).join(', ')})`);
    else {
      const original = new Map(readFileSync(endFile, 'utf8').split('\n').map(line => /^\s+flag (\S+) type (\d+) expiration (-?\d+) value 0x([0-9a-f]+)/.exec(line))
        .filter(Boolean).map(m => [m[1].toLowerCase(), {type: Number(m[2]), value: parseInt(m[4], 16) | 0}]));
      const played = new Map(JSON.parse(readFileSync(playFile, 'utf8')).entries.map(e => [e.name.toLowerCase(), {type: e.type ?? 0, value: Number(e.value) | 0}]));
      const text = f => f ? `${f.value}${f.type ? ` (type ${f.type})` : ''}` : 'absent';
      for (const name of scene.flags) {
        const o = original.get(name.toLowerCase()), p = played.get(name.toLowerCase());
        console.log(`flag ${name} at the end: the original's ${text(o)}, Play's ${text(p)}`);
        if (Boolean(o) !== Boolean(p) || (o && (o.type !== p.type || o.value !== p.value))) problems.push(`flag ${name}: the original's ${text(o)}, Play's ${text(p)}`);
      }
    }
  }
  // The level's end: the original's (<trace>.ended, the tracer at UGameEngine::Tick's client travel) and Play's (play-level-end<tag>.json, game.mjs clientTravel).
  if (scene.levelEnd) {
    const endedFile = path.join(dir, `original-trace-${tag}.jsonl.ended`), playEnd = path.join(dir, `play-level-end-${tag}.json`);
    const ended = existsSync(endedFile) ? Number(readFileSync(endedFile, 'utf8').trim()) : null, played = existsSync(playEnd) ? JSON.parse(readFileSync(playEnd, 'utf8')) : null;
    // when the original typed the OPEN: SetClientTravel's record (`settravel`, between ticks u and u + 1)
    const calls = path.join(dir, `original-trace-${tag}.jsonl.calls.jsonl`);
    const travel = existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(line => line.includes('"fn":"settravel"') && line.includes('"ev":"enter"')).map(line => JSON.parse(line)) : [];
    console.log(`level end: the original's OPEN (SetClientTravel) ${travel.length ? travel.map(r => `after tick ${r.u}${r.inTick ? ' inside a tick' : ''}`).join(', ') : 'not recorded'}; its level ended after ${ended ?? '?'} ticks, Play's after ${played?.tick ?? '(none)'}${played ? ` (client travel to ${played.url})` : ''}`);
    if (ended === null) problems.push('the stored capture did not reach the level\'s end (no <trace>.ended)');
    else {
      if (!played) problems.push(`Play's level did not end (the original's ended after ${ended} ticks)`);
      else if (played.tick !== ended) problems.push(`Play's level ended after ${played.tick} ticks, the original's after ${ended}`);
      if (report.ticks !== ended) problems.push(`the trace holds ${report.ticks} ticks, the original's level ended after ${ended}`);
    }
  }
  if (problems.length) { console.log(`FAIL ${tag}: ${problems.join('; ')}`); process.exit(1); }
  console.log(`PASS ${tag}: ${actors.length} actors equal for ${report.ticks} ticks, clock, stream draws, AI events and object creations equal${scene.levelEnd ? `, the level ends after tick ${report.ticks} in both` : ''}`);
}
