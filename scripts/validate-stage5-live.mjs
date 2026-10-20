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
 * STAGE5_PAGE_PARAMS='a=1&b=2' passes page parameters to the replay (live-acceptance.mjs --page-params: `trackedCollision=off` replays with the
 * collision queries on the static BSP, for comparisons); STAGE5_PLAY_ARGS='--setup-probe A,B --setup-ticks 815:825' adds options to the replay's
 * live-acceptance.mjs play (the Setup probe writes setup-play.json); DEBUG_CONSOLE=text prints the replay page's console lines that contain it.
 *
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
 *         The stored original (2026-10-18): death at tick 652 (DeathFront), the carcass at 730, the OPEN in the render after 1930, the level's end after 1931.
 *
 * The conversation scenes (`conversation: true`, rows 5.4.3 to 5.4.7 and 5.6.6) drive the Island's conversations through the original's keys: Enter skips a
 * speech, ArrowDown and Enter make a choice, ParseRightClick on a pawn starts a frob-only follow-up. Their trace adds the player's mouth channel and what a
 * conversation gives and takes (live-acceptance.mjs --player-blend --inventory: the Inventory chains, skill points, credits, conPlay, first goal and image),
 * the replay feeds the speakers' measured mouth letters, and the check also needs the player's FlagBase at the end hold equal (every flag, type, value and
 * expiration, and the default expiration). A `watch` list names the pawns traced per tick (the conversation's speakers and their neighbours); the others are
 * traced with their load fields only, and every AI event, object creation and stream draw of the whole level is still compared.
 *   pG pR pX  MeetPaul at the dock: the GEP gun, the sniper rifle, the mini crossbow (each with its ammunition), the Liberty Island image, three goals.
 *   fT fM fN  MeetFilben ("You can trust me.": the NanoKey and FilbenGaveKey; "I can't promise...": FilbenGaveKey false), then MeetFilben2 by frob (its branch
 *             on FilbenGaveKey; fM and fN frob in a fan of views) and Filben's HarleyStartsToWander orders.
 *   gP gN     GuntherRescued after the wall button frees Gunther: a carried pistol given to him (GuntherRespectsPlayer, GuntherAttacks: RunningTo), or none
 *             ("First thing is to get you out of here.": GuntherRespectsPlayer false); Gunther's first-person GuntherTrappedBarks before.
 *   gS gU gK  gP with the stealth pistol, the assault gun or the combat knife carried instead: each gives by its own choice (Gunther already holds a knife, so
 *             gK's is destroyed, ConPlayBase.SetupEventTransferObject).
 *   gW        gN with NothingChoice's first answer: GiveNothingNicely (GuntherRespectsPlayer, GuntherAttacks).
 *   gA        AllianceTrigger0 and OrdersTrigger6 touched by a landing at the button (Gunther UNATCO, WaitingFor), the button: the freed Gunther meets Terrorist18.
 *   tC tA     MeetTerrorist with the commander: Curious (DL_LeaderNotKilled, TerroristFollowup by frob) and Aggressive (the commander attacks, then
 *             MeetFilbenAfterStatue at Filben); both set StatueMissionComplete and run Mission01.Timer's mission-complete pass.
 *   oV        TerroristsOverheard (Amos and Jackson, first person) from behind a wall to KnowsShipment, then MoleConvos: its KnowsShipment branch, a purchase
 *             (credits, the Mole's Ammo10mm), BumFemaleWanders.
 *   oT        TopTerroristsOverheard (Terrorist9 and Terrorist8, first person) from a hidden place, to its end.
 *   kB        eight Terrorists killed (Tantalus) until Mission01.Timer sets M01PlayerAggressive, then UNATCOTroop6's TrooperCongratulation reads it.
 *   kC        kB redesigned for its two measured causes: Terrorist18 killed at its load place before StartUp lets it move, the trooper placement inside the world. */
import {execFileSync, spawn} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const option = name => { const i = argv.indexOf(`--${name}`); return i < 0 ? null : argv[i + 1]; };

const PISTOL = yaw => `20:summon DeusEx.WeaponPistol|50:set DeusEx.JCDentonMale ViewRotation (Pitch=-10130,Yaw=${yaw},Roll=0)|90:ParseRightClick|130:ActivateBelt 1`;
const SHOTS = ticks => ticks.map(t => `${t}:@down Enter|${t}:@up Enter`).join('|');
// a key edge pair at tick t, and Alt plus a letter (an accelerator: the root's keyDownMap holds Alt while the letter's character arrives, XModalWindow::KeyPressed)
const KEY = (t, code) => `${t}:@down ${code}|${t}:@up ${code}`;
const ALT = (t, letter) => `${t}:@down AltLeft|${t}:@down Key${letter}|${t}:@up Key${letter}|${t}:@up AltLeft`;
// `KillAll FlyGenerator` first: the load's chance FlyGenerators (10% per fly-making decoration) removed in both programs, as row 4.2.13 does.
// The player moved after the first unfrozen tick, between `ghost` and `walk` as PLACE does (a colliding actor's Location is not set by the console).
const INTO = (x, y, z, tick = 1) => `${tick}:ghost|${tick}:set DeusEx.JCDentonMale Location (X=${x},Y=${y},Z=${z})|${tick}:walk`;
const PLACE = (x, y, z, yaw, pitch = 0) => `KillAll FlyGenerator|ghost|set DeusEx.JCDentonMale Location (X=${x},Y=${y},Z=${z})|walk|set DeusEx.JCDentonMale ViewRotation (Pitch=${pitch},Yaw=${yaw},Roll=0)`;
// A conversation's choice: `downs` ArrowDown edges ten ticks apart from tick t, then the Enter edge 20 ticks after the last (the focus starts on the first choice).
const CHOOSE = (t, downs) => [...Array.from({length: downs}, (_, i) => `${t + 10 * i}:@down ArrowDown|${t + 10 * i}:@up ArrowDown`), `${t + 10 * downs + 20}:@down Enter|${t + 10 * downs + 20}:@up Enter`].join('|');
// A frob fan for a pawn that walks away: eight view yaws around `yaw` (0, -4500, +4500, ... units, pitch -3500 at a standing pawn's chest 30 to 100 units
// off), each followed 7 ticks later by the right button (DeusExPlayer.HighlightCenterObject traces for the frob target every 0.1 s), from tick t.
const FROB_FAN = (t, yaw) => [0, -4500, 4500, -9000, 9000, -13500, 13500, 0].map((d, k) => `${t + 8 * k}:set DeusEx.JCDentonMale ViewRotation (Pitch=-3500,Yaw=${(yaw + d + 65536) % 65536},Roll=0)|${t + 8 * k + 7}:ParseRightClick`).join('|');
// The pawns within about 4,000 units of MeetPaul's pose at the dock (the conversation's owner, the dock's bots and guard, the nearest Terrorist).
const DOCK = ['PaulDenton0', 'SecurityBot0', 'UNATCOTroop1', 'MedicalBot3', 'MedicalBot1', 'MedicalBot0', 'Terrorist12'];
// Filben's corner (the informant, the sitting BumFemale0 and the two nearest NSF).
const FILBEN = ['HarleyFilben0', 'BumFemale0', 'Terrorist36', 'ThugMale0'];
// Gunther's cell and the NSF within about 1,500 units of it.
const GUNTHER = ['GuntherHermann0', 'Terrorist18', 'Terrorist30', 'Terrorist33', 'Terrorist2', 'Terrorist14'];
// The commander's floor and the two floors below it (TopTerroristsOverheard's Terrorist8 and Terrorist9, TerroristsOverheard's ThugMale3 and Terrorist22).
// Amos's floor (TerroristsOverheard's ThugMale3 and Terrorist22, the patrolling Terrorist20) and the floor above.
const AMOS = ['ThugMale3', 'Terrorist22', 'Terrorist20', 'Terrorist8', 'Terrorist9', 'TerroristCommander0'];
const COMMANDER = ['TerroristCommander0', 'Terrorist8', 'Terrorist9', 'ThugMale3', 'Terrorist22', 'Terrorist20', 'PaulDenton0', 'GuntherHermann0'];
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
  // 5.5.1 with the key: MeetFilben's trust branch as the conversations' scene fT plays it ("You can trust me.": TransferObject of Filben's ruin_key NanoKey,
  // FilbenGaveKey; the window closes about 11 ticks after the end event, 469 in fT's capture), then the player placed at the StatueRuinDoors (dor2's pose), the
  // key ring put in hand (ActivateBelt 0) and used with the left button (ParseLeftClick: DoFrob(Self, inHand), DeusExMover.Frob's NanoKeyRing branch: the
  // four like-tagged movers' bLocked toggled), then the right button opens them.
  fK: {map: '01_NYC_UNATCOIsland', ticks: 900, conversation: true, early: PLACE(1496.6, -9968.3, -250, 0), pawns: ['HarleyFilben0', 'BumFemale0'], watch: FILBEN,
    cmds: `${SHOTS([60, 100, 140, 180, 220, 260])}|${CHOOSE(300, 0)}|${SHOTS([360, 400])}|${MOVE(560, 530.7, 29.3, -88, 57344, 5849)}|600:ActivateBelt 0|${SHOTS([660])}|720:ParseRightClick`,
    devices: ['DeusExMover12', 'DeusExMover6', 'DeusExMover22', 'DeusExMover23'].map(n => `${n}:DeusExMover`)},
  // 5.5.5 and 5.5.7: the commander (Health 100) killed by one GEP rocket from 300 units in front of him, outside MeetTerrorist's radius (140); a pistol's
  // three hits made him flee in the rehearsal, out of a fixed aim. Mission01.Timer then starts DL_LeaderKilled, whose event sets StatueMissionComplete,
  // and the next Timer changes the world. The rest of the pawns are traced with their load fields only (die1's rule).
  kil1: {map: '01_NYC_UNATCOIsland', ticks: 1100, early: PLACE(2975.7, 324.2, 2547, 47600),
    cmds: `20:summon DeusEx.WeaponGEPGun|50:set DeusEx.JCDentonMale ViewRotation (Pitch=-10130,Yaw=47600,Roll=0)|90:ParseRightClick|130:ActivateBelt 1|${AIM(240, 47600, -800)}|${SHOTS([300])}`,
    watch: ['TerroristCommander0', 'Terrorist8', 'Terrorist9', 'ThugMale3', 'Terrorist22', 'UNATCOTroop3', 'UNATCOTroop7', 'UNATCOTroop8', 'GuntherHermann0', 'SecurityBot1',
      'PaulDenton0', 'Terrorist0', 'ThugMale7'],
    devices: [...MISSION_DEVICES, 'WeaponGEPGun0:Weapon', 'Rocket0:Projectile'], flags: MISSION_FLAGS, wholeFlags: true, options: ['--player-talk', '--stop-destroyed']},
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
  // every pawn. Then 5.5.1's third half: the player placed 300 units from the StatueRuinDoors and a second rocket at DeusExMover12 (bBreakable false:
  // TakeDamage changes nothing).
  dor3: {map: '01_NYC_UNATCOIsland', ticks: 900, early: PLACE(7947.6, 530.4, -96, 57344),
    cmds: `20:summon DeusEx.WeaponGEPGun|${AIM(50, 57344, -10130)}|90:ParseRightClick|130:ActivateBelt 1|${AIM(240, 24576, -837)}|${SHOTS([300])}`
      + `|${MOVE(500, 318.6, 241.4, -88, 57344)}|${SHOTS([600])}`,
    // (the rocket and the 51 Rockchips its explosion spawns at 319, DeusExProjectile.SpawnEffects: Damage/5 tries, FRand() < 0.8, watched from their spawn:
    // which of them hit the door during their first tick, a Fragment.HitWall and its LoudNoise)
    devices: [...['DeusExMover2', 'DeusExMover12', 'DeusExMover6', 'DeusExMover22', 'DeusExMover23'].map(n => `${n}:DeusExMover`), 'Rocket0:Projectile',
      ...Array.from({length: 51}, (_, i) => `Rockchip${i}:Actor`)]},
  // 5.5.4, the water route's east end in the ruins: ControlPanel1 (UnTriggerEvent LibElectric) hacked with a Multitool from beside the arcs; first a short
  // drop into the arcs (the three ElectricityEmitters: 'Shocked' 20 a hit; DamageTrigger1 under them: EMP 2 a touch, the player's Energy), out again, the hack
  // (HackableDevices.Timer, HackAction: UnTrigger LibElectric turns the emitters and the trigger off), the drop again (nothing), and Button2 (Event fork) raises
  // the fork lift DeusExMover11 (MoveTime 12). A drop from 126 units above the floor is the walk in: falling into the trigger's cylinder Touches it.
  wat1: {map: '01_NYC_UNATCOIsland', ticks: 1300, early: PLACE(7056.7, -3326, -416, 0),
    cmds: `20:summon DeusEx.Multitool|${AIM(50, 0, -10130)}|90:ParseRightClick|130:ActivateBelt 1|${MOVE(200, 6929, -3157.5, -290, -16384)}|${MOVE(265, 7056.7, -3326, -416, 32768, -3000)}`
      + `|${SHOTS([320])}|${MOVE(650, 6929, -3157.5, -290, -16384)}|${MOVE(750, 7362.3, -3227.4, -416, 35499, -3823)}|800:ParseRightClick`,
    devices: ['ElectricityEmitter0:ElectricityEmitter', 'ElectricityEmitter2:ElectricityEmitter', 'ElectricityEmitter5:ElectricityEmitter', 'DamageTrigger1:DamageTrigger',
      'ControlPanel1:ControlPanel', 'Button2:Actor', 'DeusExMover11:DeusExMover']},
  // 5.5.3, the airshafts around the laser trap: the player drops into the DataLinkTriggers of DL_libertyruinsairshaft (a drop from just above the cylinder is the
  // walk in: a placement inside it Touches nothing), DataLinkTrigger19 in the room at the shaft and DataLinkTrigger20 in the shaft; the DataLink plays once
  // (DataLinkTrigger.Touch: StartDataLinkTransmission; in Play's rehearsal from tick 64 to about 890, DL_libertyruinsairshaft_Played at 801), the second
  // drop comes after its end, and every pawn is watched (the guards of the laser trap do not notice the player). DataLinkTrigger21 sits in a crawlspace 120
  // units high: a standing player cannot be dropped into its cylinder, and the harness cannot hold the crouch key.
  air1: {map: '01_NYC_UNATCOIsland', ticks: 1200, early: PLACE(2112, -675, -95, 0),
    cmds: `${MOVE(60, 2362, -675, -8, 0)}|${MOVE(950, 3546, -1116, -129, 0)}`,
    devices: ['DataLinkTrigger19:Actor', 'DataLinkTrigger20:Actor', 'DataLinkTrigger21:Actor'], flags: ['DL_libertyruinsairshaft_Played'], wholeFlags: true, options: ['--player-talk']},
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
  // the laser trap's beam (row 5.2.5, its first half): the player placed across statue_lasertrap's beams (LaserTrigger0..4 at (1841, -948.6), facing +X),
  // facing along them. LaserTrigger.Tick sees its emitter's HitActor change to the player (TriggerType TT_PlayerProximity: IsRelevant) and BeginAlarm
  // rings Klaxon2 and starts an 'Alarm' AI event (the laser has no Event); the guards that hear it run ScriptedPawn.HandleAlarm (AlarmTimer 120, then
  // HandleEnemy), and AlarmTimer > 0 keeps them from the alarm box (Alerting: Alert -> Done -> Attacking).
  las1: {map: '01_NYC_UNATCOIsland', ticks: 900, early: PLACE(1900, -948.6, -96, 0), cmds: '',
    devices: [...[0, 1, 2, 3, 4].map(i => `LaserTrigger${i}:LaserTrigger`), 'AlarmUnit0:AlarmUnit'], flags: ['StatueAlarmTriggered']},
  // the alarm box (row 5.2.5, its second half): the player placed in the view of Terrorist18 (RaiseAlarm BeforeAttacking), 180 units in front of Chair9
  // where it sits (facing yaw 48128), off its way to AlarmUnit0 (in hck1 the player at the panel stood in that way, and Terrorist18 never reached the
  // box). Seeing the player with AlarmTimer 0, it goes Alerting, FindTarget picks AlarmUnit0, it runs there and TriggerAlarm()s it: SetAlarmFlag ->
  // FlagTrigger3 -> StatueAlarmTriggered.
  alm1: {map: '01_NYC_UNATCOIsland', ticks: 900, early: PLACE(2012, -1610, -96, 16384), cmds: '', devices: ['AlarmUnit0:AlarmUnit'], flags: ['StatueAlarmTriggered']},
  // the alarm box, rung (row 5.2.5, its second half): hck1's hack of ControlPanel0 from (1870, -860), off Terrorist18's way north to AlarmUnit0 (in hck1
  // the player at (1900, -895) stood in it, and Terrorist18, Alerting, never passed). The panel area is out of NSFCam01's sweep (in alm1 the camera saw a
  // player south of Terrorist18's chair, and its alarm gave Terrorist18 AlarmTimer 120, which keeps it from the box). The hack's MegaFutz shows Terrorist18
  // the player; with AlarmTimer 0 it goes Alerting, runs to AlarmUnit0 and TriggerAlarm()s it: SetAlarmFlag -> FlagTrigger3 -> StatueAlarmTriggered.
  alm2: {map: '01_NYC_UNATCOIsland', ticks: 900, early: PLACE(1870, -860, -96, 0),
    cmds: '20:summon DeusEx.Multitool|50:set DeusEx.JCDentonMale ViewRotation (Pitch=-10130,Yaw=0,Roll=0)|90:ParseRightClick|130:ActivateBelt 1'
      + `|170:set DeusEx.JCDentonMale ViewRotation (Pitch=-3640,Yaw=42690,Roll=0)|${SHOTS([200])}`,
    devices: ['ControlPanel0:ControlPanel', 'AlarmUnit0:AlarmUnit', 'SecurityCamera5:SecurityCamera', 'Multitool0:Multitool'], flags: ['StatueAlarmTriggered']},
  // a camera and the turret it wakes (rows 5.2.4, 5.1.9): the player placed 400 units in front of NSFCam02 (SecurityCamera3, facing yaw 16592, 300 units from
  // NSFTurret01), facing it. SecurityCamera.Tick checks the player every 0.1 s (CheckPlayerVisibility: in cameraRange 1024 and inside cameraFOV 4096 of the
  // camera's swinging Rotation), tracks him, and after triggerDelay 4 s TriggerEvent(True) sounds its klaxon and starts an 'Alarm' AI event (radius
  // 25 * (SoundRadius + 1)); AutoTurret0 (bActive false, bTrackPlayersOnly) hears it (AISetEventCallback('Alarm', 'AlarmHeard')), wakes, aims AutoTurretGun0
  // and fires at the player (fireRate 0.25, gunDamage 5).
  cam1: {map: '01_NYC_UNATCOIsland', ticks: 900, early: PLACE(250, 331, -100, 49152),
    // (Watched too: the blood of the turret's first hit, AutoTurret.SpawnBlood's and DeusExPlayer's drops, and the splats a drop leaves where it meets a wall.
    // Shooting the turret down was rehearsed and dropped: an untrained pistol misses AutoTurretGun0 from 340 units, and the turret and SecurityBot1 kill the
    // player first.)
    cmds: '', devices: ['SecurityCamera3:SecurityCamera', 'AutoTurret0:AutoTurret', 'AutoTurretGun0:AutoTurretGun@AutoTurret0.gun',
      ...[0, 1, 2, 3].map(i => `BloodDrop${i}:Actor`), 'BloodSplat0:Actor', 'BloodSplat1:Actor']},
  // a UNATCO camera (row 5.2.4, its bNoAlarm half): the player placed 700 units in front of SecurityCamera2 (UN_outside, Tag UN_CamSystem02, bNoAlarm), in its
  // range (cameraRange 1024) and inside its cone, facing it. SecurityCamera.Tick checks the player only `if (!bNoAlarm)`: the camera swings and never sees him.
  cam2: {map: '01_NYC_UNATCOIsland', ticks: 300, early: PLACE(-3885, 3132, -96, 52325, 5410), cmds: '', devices: ['SecurityCamera2:SecurityCamera']},
  // light against sight (row 5.6.3): the census's pair (light-vs-sight), the player placed 500 units in front of Terrorist4 (Orders Standing at (5998, 2532),
  // facing yaw -18944) with a clear line of sight, facing it: lgt1 in shadow (Play's AIGetLightLevel 0.0043, ambient only), lgt2 15 degrees over in the light
  // (0.0549). AICanSee's acc = 64 (r^2+h^2)/dist^2 * AIVisibility - VisibilityThreshold (0.01) is below zero in the dark and above it in the light.
  // Placed there, the player starts Terrorist4 and Terrorist27's overheard conversation; their lines drive Pawn.LipSynch, so the replay feeds the mouth letters
  // the original's audio update wrote (`speech`). In the dark it runs on; in the light Terrorist4 sees the player, and both leave it to attack.
  lgt1: {map: '01_NYC_UNATCOIsland', ticks: 900, early: PLACE(5835, 2059, -96, 12924), cmds: '', speech: true},
  lgt2: {map: '01_NYC_UNATCOIsland', ticks: 900, early: PLACE(5963, 2033, -96, 15656), cmds: '', speech: true},
  // the breath under water (row 5.3.8): the player placed in WaterZone1 (the bay north of the dock: water from about Z -355 down to the floor near -900),
  // still. swm1 near the floor: PainTime runs out before he rises to the surface, and drowning damage takes him (Play's rehearsal: the first hit near 1200,
  // dead near 2220). swm2 at the census's depth (WaterZone1's Location + 30): he surfaces with breath left, and swimTimer refills. The player is placed on
  // dry ground first and moved into the water after the first unfrozen tick: placed under water in the frozen phase, the original's player tick already
  // spawned 112 AirBubbles and a WaterRing before the trace starts (the population check's reload).
  swm1: {map: '01_NYC_UNATCOIsland', ticks: 2400, early: PLACE(-4761, 10431, -281, 0), cmds: INTO(-2802, 6641, -850), options: ['--player-breath']},
  swm2: {map: '01_NYC_UNATCOIsland', ticks: 1500, early: PLACE(-4761, 10431, -281, 0), cmds: INTO(-2802, 6641, -450), options: ['--player-breath']},
  // move objects and fall (row 5.3.12): the player placed 70 units west of Trashbag0 (-3881, 10100) looking down at it; ParseRightClick frobs it (DeusExPlayer
  // GrabDecoration: CarriedDecoration), the view levels, and DropItem (Tab) throws it (DropDecoration: Vector(ViewRotation) * 500 + (0, 0, 220) + 40 * VRand(),
  // over Mass / 20 clamped to 1..40) to fall and land; at 420 the player is set 380 units over the ground at the census's fall place (-4761, 10431), between
  // `ghost` and `walk` as PLACE does (a colliding actor's Location is not set by the console), and lands with fall damage.
  mov1: {map: '01_NYC_UNATCOIsland', ticks: 900, early: PLACE(-3951, 10100, -240, 0, -7800),
    cmds: `30:ParseRightClick|90:set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=0,Roll=0)|120:DropItem|${INTO(-4761, 10431, 99, 420)}`,
    devices: ['Trashbag0:Decoration']},
  // items and skill points (row 5.3.11): the player placed 123 units west of SkillAwardTrigger1 (-5977, 1327), facing west (away from DeusExMover21's door,
  // which a frob facing east reaches first); HealthTorso set to 40; a MedKit
  // summoned, picked up (belt slot 1), put in hand and used by the Enter edge (MedKit.Activated: HealPlayer), then a Candybar the same way (slot 1 again: the used MedKit freed it); at 450
  // the player is moved into the trigger (SkillAwardTrigger.Touch: SkillPointsAdd).
  itm1: {map: '01_NYC_UNATCOIsland', ticks: 900, early: PLACE(-6100, 1327, -88, 32768),
    cmds: '20:set DeusEx.JCDentonMale HealthTorso 40|30:summon DeusEx.MedKit|60:set DeusEx.JCDentonMale ViewRotation (Pitch=-10130,Yaw=32768,Roll=0)|100:ParseRightClick'
      + `|140:ActivateBelt 1|${SHOTS([180])}|240:summon DeusEx.Candybar|280:ParseRightClick|320:ActivateBelt 1|${SHOTS([360])}`
      + `|420:set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=0,Roll=0)|${INTO(-5977, 1327, -88, 450)}`,
    options: ['--inventory'], devices: ['SkillAwardTrigger1:Actor']},
  // itm1's items again, and the award: set inside SkillAwardTrigger1 the player touches nothing (itm1: SkillPointsAvail 5000 throughout, in both programs):
  // `walk`'s SetCollision finds him already overlapping it, and Touch comes only with a new overlap (and a roof covers it: a drop from above lands on that).
  // So at 450 he is set 70 units west of its centre, clear of it, and the console sets his Velocity to 300 east: physWalking's MoveActor carries him into
  // it (Touch, SkillAwardTrigger.Touch -> SkillPointsAdd 25) as the census's walk does.
  itm2: {map: '01_NYC_UNATCOIsland', ticks: 900, early: PLACE(-6100, 1327, -88, 32768),
    cmds: '20:set DeusEx.JCDentonMale HealthTorso 40|30:summon DeusEx.MedKit|60:set DeusEx.JCDentonMale ViewRotation (Pitch=-10130,Yaw=32768,Roll=0)|100:ParseRightClick'
      + `|140:ActivateBelt 1|${SHOTS([180])}|240:summon DeusEx.Candybar|280:ParseRightClick|320:ActivateBelt 1|${SHOTS([360])}`
      + `|420:set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=0,Roll=0)|${INTO(-6047, 1327, -88, 450)}|452:set DeusEx.JCDentonMale Velocity (X=300,Y=0,Z=0)`,
    options: ['--inventory'], devices: ['SkillAwardTrigger1:Actor']},
  // 00_Training (rows 5.3.4, 5.3.7, 5.1.1): poses from the census scenarios.
  // jumps (row 5.3.4): the player placed at the obstacle course (6991, -55), facing -Y; two Space edges (Jump through the User.ini binding), each a
  // PlayerPawn.DoJump into PHYS_Falling and a landing; the walk across and the crouch under the pipes are held keys the harness cannot post.
  jmp1: {map: '00_Training', ticks: 300, early: PLACE(6991, -55, 17, 49152), cmds: '30:@down Space|30:@up Space|150:@down Space|150:@up Space'},
  // the contaminated pool (row 5.3.7): WaterZone0 (5574, -4011) and its DamageTrigger1; hzm1 swims in it bare (moved in after the first unfrozen tick, as
  // the Island's swim scenes are); hzm2 first picks up HazMatSuit2 (6584, -4057), puts it in hand and activates it (Enter edge: ChargedPickup.Activate),
  // then is moved into the pool: the suit's protection and its charge per tick.
  hzm1: {map: '00_Training', ticks: 700, early: PLACE(6538, -3980, 50, 54796), cmds: INTO(5574, -4011, -150), options: ['--player-breath']},
  hzm2: {map: '00_Training', ticks: 900, early: PLACE(6538, -3980, 50, 54796, -800),
    cmds: `40:ParseRightClick|80:ActivateBelt 1|${SHOTS([120])}|${INTO(5574, -4011, -150, 180)}`, options: ['--player-breath'], devices: ['HazMatSuit2:Pickup']},
  // the crowbar and a crate (row 5.1.1): a WeaponCrowbar summoned facing away from the crates, picked up and drawn; the player turned on
  // CrateBreakableMedGeneral1 (1022, -275, under CrateBreakableMedGeneral2) 70 units north of it; Enter edges swing it (WeaponCrowbar's melee
  // TraceFire) until the crate breaks (DeusExDecoration.TakeDamage -> Destroyed: fragments and contents).
  cbr1: {map: '00_Training', ticks: 900, early: PLACE(1022, -205, -85, 16384),
    cmds: `20:summon DeusEx.WeaponCrowbar|50:set DeusEx.JCDentonMale ViewRotation (Pitch=-10130,Yaw=16384,Roll=0)|90:ParseRightClick|130:ActivateBelt 1`
      + `|170:set DeusEx.JCDentonMale ViewRotation (Pitch=-7100,Yaw=49152,Roll=0)|${SHOTS([200, 260, 320, 380, 440, 500])}`,
    devices: ['CrateBreakableMedGeneral1:Decoration', 'CrateBreakableMedGeneral2:Decoration']},
  // AugLight in the dark room (row 5.3.2): the player placed inside it (between darkdoor and darkdoor2, the cratelight TriggerLights off); an F12 edge
  // (ActivateAugmentation through the User.ini binding) turns AugLight on: Augmentation.Activate, its Beam spawned and moved with the player, the
  // energy drain of Augmentation.Timer (--player-view traces Energy).
  aug1: {map: '00_Training', ticks: 600, early: PLACE(4600, 700, -85, 0), cmds: '60:@down F12|60:@up F12', view: true},
  // a baton knock-out (row 5.1.7): a WeaponBaton summoned, picked up and drawn at cmb2's pose (700 units behind Terrorist0, where nobody notices the player; a
  // summoned item's landing is a noise, and next to the target it wakes it); at tick 600, once Terrorist18 sits on Chair9 (2017.7, -1429.6, facing yaw 48128),
  // the player is placed by the same console lines 58 units behind it at his rest height, facing its back; the Enter edge at 630 swings the baton
  // (WeaponBaton.WeaponDamageType 'KnockedOut'; ScriptedPawn.TakeDamageBase: a hit from behind within 64 units does 10 times the damage). `AllSkills`
  // (the cheat, typed in the frozen phase as `summon` is later) makes Low-Tech master: DeusExWeapon.ProcessTraceHit's `mult += -2.0 * GetWeaponSkill()`
  // doubles the baton's 7, so the hit from behind (140) knocks the 75-health Terrorist out; untrained it does 70, and the second swing (Attack2, a slower
  // animation) lands after Terrorist18 has left TakingHit for the alarm (rehearsed). The carcass the knocked-out pawn leaves (bNotDead, "Unconscious") is
  // watched from the tick it appears.
  ko1: {map: '01_NYC_UNATCOIsland', ticks: 900, early: `${PLACE(8951.3, 190.2, -84, 32768)}|AllSkills`,
    cmds: '20:summon DeusEx.WeaponBaton|50:set DeusEx.JCDentonMale ViewRotation (Pitch=-10130,Yaw=32768,Roll=0)|90:ParseRightClick|130:ActivateBelt 1'
      + `|${PLACE(2023.4, -1371.9, -96.3, 48128, -4000).split('|').slice(1).map(line => `600:${line}`).join('|')}|${SHOTS([630])}`, carcasses: ['TerroristCarcass1'], view: true},
  // an explosion near a door, a decoration and a guard (row 5.6.4): the player placed east of the breakable DeusExMover5 (doorStrength 0.6,
  // minDamageThreshold 50) facing it summons a CrateExplosiveSmall (explosionDamage 300, explosionRadius 800, HitPoints 4) 72 units ahead, between the door
  // and TrashCan5, and a second one turned 22 degrees left (the chain: the first's HurtRadius sets off the second); a WeaponPistol summoned facing away, picked up and drawn; the player placed 530 units east of the crate (the room ends there) and the
  // Enter edges fire at the crate. In the original both shots miss; the second crate lands half off the first and slides off it (processLanded's footprint
  // push, tick 45), and Terrorist2, come to open the door, crushes the first crate with it at 307 (Mover.EncroachingOn: TakeDamage 10000 'Crushed'):
  // DeusExDecoration.Explode's HurtRadius sets off the second crate, breaks the door (doorStrength 0.6 -> 0, BlowItUp), destroys TrashCan5 and kills
  // Terrorist2; the blast's noise.
  exp1: {map: '01_NYC_UNATCOIsland', ticks: 900, early: PLACE(3242, -1072, -192, 32768),
    cmds: '20:summon DeusEx.CrateExplosiveSmall|30:set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=36768,Roll=0)|35:summon DeusEx.CrateExplosiveSmall'
      + '|40:set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=0,Roll=0)|45:summon DeusEx.WeaponPistol'
      + '|70:set DeusEx.JCDentonMale ViewRotation (Pitch=-10130,Yaw=0,Roll=0)|110:ParseRightClick|150:ActivateBelt 1'
      + `|${PLACE(3700, -1072, -160, 32768, -1890).split('|').slice(1).map(line => `190:${line}`).join('|')}|${SHOTS([240, 280, 320, 360, 400, 440])}`,
    devices: ['DeusExMover5:DeusExMover', 'TrashCan5:Decoration', 'CrateExplosiveSmall1:Decoration', 'CrateExplosiveSmall4:Decoration', 'Chair5:Decoration']},
  // an EMP grenade on a security bot (row 5.6.5): SecurityBot0 (UNATCO, Patrolling UN_botpath1) walks a straight line from (-2302, 10169) to PatrolPoint19
  // (-2057, 9673), which it reaches at tick 368 (the original's hck1 trace, where it then stands in stasis with the player far away); the player placed 550
  // units west of PatrolPoint19 facing it (east of it is water); a WeaponEMPGrenade summoned facing away, picked up and drawn; the Enter edge at 200 (the grenade idle again after its Select) throws it
  // (ThrownProjectile) toward the patrol point, where its EMP blast (HurtRadius 'EMP') meets the bot: Robot.TakeDamage takes its EMPHitPoints and disables it.
  emp1: {map: '01_NYC_UNATCOIsland', ticks: 900, early: PLACE(-2607, 9673, -256, 32768),
    cmds: '20:summon DeusEx.WeaponEMPGrenade|50:set DeusEx.JCDentonMale ViewRotation (Pitch=-10130,Yaw=32768,Roll=0)|90:ParseRightClick|130:ActivateBelt 1'
      + `|170:set DeusEx.JCDentonMale ViewRotation (Pitch=-2500,Yaw=64116,Roll=0)|${SHOTS([200])}`,
    devices: ['SecurityBot0:Robot', 'EMPGrenade0:Actor']},
  // an EMP blast on the electronics and on the player (row 5.6.5, its other half): cam1's pose (400 units in front of NSFCam02, 330 from NSFTurret01);
  // a WeaponEMPGrenade summoned, picked up and drawn, thrown at 200 toward the camera: its blast (HurtRadius 'EMP') confuses SecurityCamera3
  // (SecurityCamera.TakeDamage: bConfused, confusionDuration) and AutoTurret0 (bConfused), and drains the player's Energy (DeusExPlayer.TakeDamage 'EMP').
  emp2: {map: '01_NYC_UNATCOIsland', ticks: 900, early: PLACE(250, 331, -100, 49152),
    cmds: '20:summon DeusEx.WeaponEMPGrenade|50:set DeusEx.JCDentonMale ViewRotation (Pitch=-10130,Yaw=49152,Roll=0)|90:ParseRightClick|130:ActivateBelt 1'
      + `|170:set DeusEx.JCDentonMale ViewRotation (Pitch=-6000,Yaw=49152,Roll=0)|${SHOTS([200])}`,
    devices: ['SecurityCamera3:SecurityCamera', 'AutoTurret0:AutoTurret', 'AutoTurretGun0:AutoTurretGun@AutoTurret0.gun', 'EMPGrenade0:Actor']},
  cmb7: {map: '01_NYC_UNATCOIsland', ticks: 900, early: PLACE(8951.3, 190.2, -84, 32768),
    cmds: '20:summon DeusEx.WeaponPistol|50:set DeusEx.JCDentonMale ViewRotation (Pitch=-10130,Yaw=32768,Roll=0)|90:ParseRightClick|100:summon DeusEx.MedKit|140:ParseRightClick'
      + `|170:ActivateBelt 1|200:set DeusEx.JCDentonMale ViewRotation (Pitch=-536,Yaw=0,Roll=0)|${SHOTS([300, 360])}|650:ActivateBelt 2|${SHOTS([700])}`},
  // The Island conversations (rows 5.4.3 to 5.4.7, 5.6.6). A third-person conversation takes the keys through its window: Enter while only a speech shows
  // skips it (ConWindowActive.VirtualKeyPressed: IK_Enter with numChoices 0 -> ConPlay.PlayNextEvent, which stops the speech and plays the next event), and
  // with the choices shown ArrowDown moves the focus to the next ConChoiceWindow (RootWindow.VirtualKeyPressed, MoveFocusDown) and Enter activates the focused
  // one (ConWindowActive.ButtonActivated). `pawns` are the rehearsal's printed pawns; `watch` the pawns traced per tick (the others with their load fields).
  // MeetPaul (radius 180 around PaulDenton0, third person): cvA's pose, the conversation starts at the release; its eight speeches before the choice are
  // skipped, the choice made, and the speeches after it skipped up to the last one, which runs out (Paul's "Interrogate the leader", then the trigger
  // PaulWandering and the end). The choices: the sniper rifle (first), the GEP gun (second), the mini crossbow (third); each branch gives its weapon
  // (ConEventTransferObject from Paul), then the Liberty Island image; the three goals come before the first speech.
  pG: {map: '01_NYC_UNATCOIsland', ticks: 1150, conversation: true, early: PLACE(-2385, 8393, -256.2, 51120), pawns: ['PaulDenton0'], watch: DOCK,
    cmds: `${SHOTS([60, 100, 140, 180, 220, 260, 300, 340])}|${CHOOSE(400, 1)}|${SHOTS([480, 520, 560, 600, 640, 680, 720])}`},
  pR: {map: '01_NYC_UNATCOIsland', ticks: 1150, conversation: true, early: PLACE(-2385, 8393, -256.2, 51120), pawns: ['PaulDenton0'], watch: DOCK,
    cmds: `${SHOTS([60, 100, 140, 180, 220, 260, 300, 340])}|${CHOOSE(400, 0)}|${SHOTS([470, 510, 550, 590, 630, 670, 710])}`},
  pX: {map: '01_NYC_UNATCOIsland', ticks: 1150, conversation: true, early: PLACE(-2385, 8393, -256.2, 51120), pawns: ['PaulDenton0'], watch: DOCK,
    cmds: `${SHOTS([60, 100, 140, 180, 220, 260, 300, 340])}|${CHOOSE(400, 2)}|${SHOTS([490, 530, 570, 610, 650, 690, 730])}`},
  // MeetFilben (radius 60 around HarleyFilben0): the player placed 50 units west of him, facing him; six speeches skipped (the last hands over the image of
  // the commander), the choice, the branch's speeches skipped but the last. Then MeetFilben2 (frob only, needs MeetFilben_Played) by the right button on
  // Filben: its first event checks FilbenGaveKey. "You can trust me." (first): the NanoKey and FilbenGaveKey; "I can't promise..." (second): neither.
  // The frob must come one second after the conversation's end (GetActiveConversation: Level.TimeSeconds - LastConEndTime < 1, set by EndConversation when
  // ConPlay terminates) and before Filben, wandering from the end (HarleyStartsToWander), leaves the frob range. In the original the third-person window
  // closes in about 11 ticks after the end event (the tracer's real-time window frames; fT's first capture: 469, the rehearsal 589, where the frob at 700
  // found Filben gone), so the right button is pressed twice, 62 and 92 ticks after that (a press during the started conversation's first speech is the
  // original's own input too).
  fT: {map: '01_NYC_UNATCOIsland', ticks: 1200, conversation: true, early: PLACE(1496.6, -9968.3, -250, 0), pawns: ['HarleyFilben0', 'BumFemale0'], watch: FILBEN,
    cmds: `${SHOTS([60, 100, 140, 180, 220, 260])}|${CHOOSE(300, 0)}|${SHOTS([360, 400])}|534:ParseRightClick|564:ParseRightClick|${SHOTS([600, 640, 680, 720, 760])}`},
  // fT's inputs to MeetFilben's end (the original's conPlay clears at 469 in both captures of fT), then a frob fan from the end of the one-second guard
  // (529): Filben wanders off at once (HarleyStartsToWander) on a path the load's stream chooses (fT's two captures: east, still in range at 596;
  // south-east, out of the frob line at 505), so one view rarely finds him. MeetFilben2's GaveKey branch, its last speech run out.
  fM: {map: '01_NYC_UNATCOIsland', ticks: 1250, conversation: true, early: PLACE(1496.6, -9968.3, -250, 0), pawns: ['HarleyFilben0', 'BumFemale0'], watch: FILBEN,
    cmds: `${SHOTS([60, 100, 140, 180, 220, 260])}|${CHOOSE(300, 0)}|${SHOTS([360, 400])}|${FROB_FAN(531, 0)}|${SHOTS([620, 660, 700, 740, 780])}`},
  // fN: "I can't promise..." (second), the branch's speeches skipped, then the same fan after its end: MeetFilben2's branch without the key.
  fN: {map: '01_NYC_UNATCOIsland', ticks: 1300, conversation: true, early: PLACE(1496.6, -9968.3, -250, 0), pawns: ['HarleyFilben0', 'BumFemale0'], watch: FILBEN,
    cmds: `${SHOTS([60, 100, 140, 180, 220, 260])}|${CHOOSE(300, 1)}|${SHOTS([370, 410, 450, 490, 530, 570])}|${FROB_FAN(643, 0)}|${SHOTS([720, 760, 800])}`},
  // GuntherRescued (radius 70 around GuntherHermann0, needs GuntherFreed). A pistol summoned and picked up at the map's start (carried: ConEventCheckObject walks
  // the Inventory; a summoned weapon's landing is a LoudNoise of radius 768, DeusExWeapon.PlayLandingSound, which near the cell brings Terrorist18), then the
  // player placed on the floor at the cell's wall button DeusExMover8 (ghost, a SET of Location, walk: the harness cannot walk; a placement touches nothing,
  // so AllianceTrigger0 and OrdersTrigger6, which a walk to the button crosses, are left to gA: with Gunther UNATCO the freed Gunther fights Terrorist18 and
  // never becomes conversable). Gunther's first-person GuntherTrappedBarks (radius 580) plays at once. The button pressed with the right button (DeusExMover8
  // TriggerOpenTimed -> Event temp_celldoor, the cell door DeusExMover10 -> guntherdoor -> FlagTrigger4 -> FlagTrigger2: GuntherFreed), then the player placed
  // inside the radius; the radius conversation waits five seconds after the bark's end (DeusExPlayer.GetActiveConversation, lastFirstPersonConvoTime). The
  // conversation: the goal, 150 skill points, four speeches skipped, the CheckObject chain (assault gun, stealth pistol, pistol: found), the choice "As you
  // wish. Take my pistol." (first) -> TransferObject to Gunther -> his last speech runs out, GuntherRespectsPlayer, the trigger GuntherAttacks (OrdersTrigger0:
  // RunningTo GuntherSpot).
  gP: {map: '01_NYC_UNATCOIsland', ticks: 1350, conversation: true, early: 'KillAll FlyGenerator', pawns: ['GuntherHermann0', 'Terrorist18'], watch: GUNTHER,
    cmds: '20:summon DeusEx.WeaponPistol|50:set DeusEx.JCDentonMale ViewRotation (Pitch=-10130,Yaw=58496,Roll=0)|90:ParseRightClick'
      + '|130:ghost|130:set DeusEx.JCDentonMale Location (X=1952,Y=-1796,Z=-84.2)|130:walk|130:set DeusEx.JCDentonMale ViewRotation (Pitch=-10130,Yaw=49152,Roll=0)|200:ParseRightClick'
      + `|400:ghost|400:set DeusEx.JCDentonMale Location (X=1885,Y=-2180,Z=-128)|400:walk|400:set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=49152,Roll=0)`
      + `|${SHOTS([580, 620, 660, 700])}|${CHOOSE(740, 0)}|${SHOTS([800])}`},
  // GuntherRescued unarmed: gP without the pistol; the CheckObject chain falls through to NothingChoice, and "First thing is to get you out of here." (second)
  // jumps to GiveNothing: three speeches, skipped, and GuntherRespectsPlayer false, no GuntherAttacks.
  gN: {map: '01_NYC_UNATCOIsland', ticks: 1150, conversation: true, early: 'KillAll FlyGenerator', pawns: ['GuntherHermann0', 'Terrorist18'], watch: GUNTHER,
    cmds: '130:ghost|130:set DeusEx.JCDentonMale Location (X=1952,Y=-1796,Z=-84.2)|130:walk|130:set DeusEx.JCDentonMale ViewRotation (Pitch=-10130,Yaw=49152,Roll=0)|200:ParseRightClick'
      + `|545:ghost|545:set DeusEx.JCDentonMale Location (X=1885,Y=-2180,Z=-128)|545:walk|545:set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=49152,Roll=0)`
      + `|${SHOTS([590, 630, 670, 710])}|${CHOOSE(750, 1)}|${SHOTS([820, 860, 900, 1010])}`},
  // GuntherRescued's other give choices (row 5.4.5): gP's inputs with the stealth pistol (gS), the assault gun (gU) or the combat knife (gK) summoned and carried
  // instead of the pistol. The CheckObject chain (assault gun, stealth pistol, pistol, knife) offers the first one carried, "As you wish. Take my ..." (first),
  // its TransferObject to Gunther, GiveSpeech, GuntherRespectsPlayer and GuntherAttacks.
  ...Object.fromEntries([['gS', 'WeaponStealthPistol'], ['gU', 'WeaponAssaultGun'], ['gK', 'WeaponCombatKnife']].map(([tag, weapon]) => [tag, {map: '01_NYC_UNATCOIsland', ticks: 1350,
    conversation: true, early: 'KillAll FlyGenerator', pawns: ['GuntherHermann0', 'Terrorist18'], watch: GUNTHER,
    cmds: `20:summon DeusEx.${weapon}|50:set DeusEx.JCDentonMale ViewRotation (Pitch=-10130,Yaw=58496,Roll=0)|90:ParseRightClick`
      + '|130:ghost|130:set DeusEx.JCDentonMale Location (X=1952,Y=-1796,Z=-84.2)|130:walk|130:set DeusEx.JCDentonMale ViewRotation (Pitch=-10130,Yaw=49152,Roll=0)|200:ParseRightClick'
      + `|400:ghost|400:set DeusEx.JCDentonMale Location (X=1885,Y=-2180,Z=-128)|400:walk|400:set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=49152,Roll=0)`
      + `|${SHOTS([580, 620, 660, 700])}|${CHOOSE(740, 0)}|${SHOTS([800])}`}])),
  // NothingChoice's first answer (row 5.4.5): gN's inputs with "Wish I could help, but I'm not very well armed." (first) -> GiveNothingNicely: Gunther's one
  // speech runs out, GuntherRespectsPlayer true and GuntherAttacks, as a give does, without a transfer.
  gW: {map: '01_NYC_UNATCOIsland', ticks: 1350, conversation: true, early: 'KillAll FlyGenerator', pawns: ['GuntherHermann0', 'Terrorist18'], watch: GUNTHER,
    cmds: '130:ghost|130:set DeusEx.JCDentonMale Location (X=1952,Y=-1796,Z=-84.2)|130:walk|130:set DeusEx.JCDentonMale ViewRotation (Pitch=-10130,Yaw=49152,Roll=0)|200:ParseRightClick'
      + `|545:ghost|545:set DeusEx.JCDentonMale Location (X=1885,Y=-2180,Z=-128)|545:walk|545:set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=49152,Roll=0)`
      + `|${SHOTS([590, 630, 670, 710])}|${CHOOSE(750, 0)}|${SHOTS([820])}`},
  // Gunther's alliance and orders before the conversation (rows 5.4.5, 5.6.6): the player placed on the floor at the wall button, then at tick 20 placed again 64
  // units higher, so that its landing sweeps into AllianceTrigger0 (bInitiallyActive, bTriggerOnceOnly: Gunther's Alliance UNATCO, NSF -1, Player +1) and
  // OrdersTrigger6 (Orders WaitingFor) as a walk to the button does; the button pressed (GuntherFreed). With the door open the UNATCO Gunther meets Terrorist18.
  gA: {map: '01_NYC_UNATCOIsland', ticks: 900, conversation: true, early: PLACE(1952, -1796, -84.2, 49152, -10130), pawns: ['GuntherHermann0', 'Terrorist18'], watch: GUNTHER,
    cmds: '20:ghost|20:set DeusEx.JCDentonMale Location (X=1952,Y=-1796,Z=-20)|20:walk|20:set DeusEx.JCDentonMale ViewRotation (Pitch=-10130,Yaw=49152,Roll=0)|90:ParseRightClick'},
  // MeetTerrorist (radius 140 around TerroristCommander0, third person): the player placed where the census walks in, 44 units west of him, facing him; the three
  // goals completed, three speeches skipped, the choice, the branch's speeches skipped but the last. "Tell me about the shipment..." (second, Curious):
  // PlayerAttackedStatueTerrorist false, StatueMissionComplete, the trigger DL_LeaderNotKilled; then TerroristFollowup (frob only, needs MeetTerrorist_Played)
  // by the right button. StatueMissionComplete makes Mission01.Timer's mission-complete pass (MS_MissionComplete: every Terrorist but the commander killed,
  // the ThugMale2s, SecurityBot3 and Gunther destroyed, Paul moved to PaulTeleport, the custody and post-mission troops entering the world, the NSF turrets
  // and the statue's lasers destroyed) and its DataLink DL_LeaderNotKilled (MS_DL2_Played).
  tC: {map: '01_NYC_UNATCOIsland', ticks: 1300, conversation: true, windowVisibility: true, early: PLACE(2887, 38, 2539, 63000), pawns: ['TerroristCommander0', 'Terrorist8', 'Terrorist9', 'PaulDenton0'], watch: COMMANDER,
    cmds: `${SHOTS([60, 100, 140])}|${CHOOSE(200, 1)}|${SHOTS([280, 320, 360, 400, 440])}|900:ParseRightClick|${SHOTS([960, 1000, 1040, 1080, 1120, 1180])}`},
  // "Except send YOU back to the people..." (first, Aggressive): PlayerAttackedStatueTerrorist, the commander's last speech runs out, StatueMissionComplete, the
  // trigger TerroristCommanderAttacks. The player is then placed at Filben, never met before: MeetFilbenAfterStatue (radius 60, needs M01PlayerMetFilben false
  // and StatueMissionComplete) starts. The frozen phase leaves the player on cmb5's ledge, out of every conversation's radius and every NSF pawn's view, and
  // the placement at the commander is typed in the hold after tick 100: the frozen phase's `ghost` line ("You feel ethereal") waits in the hidden log
  // (ShowHud False), and HUDLogDisplay.Tick times it out after the log timeout (3 s) unless a third-person conversation pauses it. The original's frozen
  // phase gives it the window time of the typed lines (at least the capture's 2.4 s of sleeps after `ghost`, then 1.21 s at the release in the first capture),
  // which the tracer did not record, and Play's frozen phase gives it its own few frames: with the conversation at tick 14, Play still showed the line at
  // MeetTerrorist's end (379: HUDLogDisplay's first draw, four GCs, the original's at 600). From tick 100 on, both run the hold's traced frames.
  // (Captures now trace the frozen phase's frames, --frozen-frames: tF is tA's first design, the placement in the frozen phase, for that.)
  tA: {map: '01_NYC_UNATCOIsland', ticks: 1050, conversation: true, early: PLACE(1221, -961, 799, 32768, -3632), pawns: ['TerroristCommander0', 'HarleyFilben0', 'PaulDenton0'], watch: [...COMMANDER, 'HarleyFilben0', 'BumFemale0'],
    cmds: `100:ghost|100:set DeusEx.JCDentonMale Location (X=2887,Y=38,Z=2539)|100:walk|100:set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=63000,Roll=0)|${SHOTS([160, 200, 240])}|${CHOOSE(300, 0)}|${SHOTS([360])}|700:ghost|700:set DeusEx.JCDentonMale Location (X=1496.6,Y=-9968.3,Z=-250)|700:walk|700:set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=0,Roll=0)|${SHOTS([760, 800, 840, 880, 920, 960])}`},
  // tA's first design: the player placed at the commander in the frozen phase, so MeetTerrorist starts at tick 14 and its Aggressive branch logs nothing while
  // the frozen phase's `ghost` lines wait in the hidden log. Whether HUDLogDisplay times them out before the conversation pauses it is decided by the window
  // time of the frozen phase, which the capture traces (--frozen-frames: the frames around each typed line, frozen-lines-tF.json) and the replay ticks Play's
  // windows with (docs/stage-5-exit-criteria.md "The frozen phase's window frames"); the first capture of this design failed on that alone (four GCs).
  tF: {map: '01_NYC_UNATCOIsland', ticks: 950, conversation: true, early: PLACE(2887, 38, 2539, 63000), pawns: ['TerroristCommander0', 'HarleyFilben0', 'PaulDenton0'], watch: [...COMMANDER, 'HarleyFilben0', 'BumFemale0'],
    cmds: `${SHOTS([60, 100, 140])}|${CHOOSE(200, 0)}|${SHOTS([260])}|600:ghost|600:set DeusEx.JCDentonMale Location (X=1496.6,Y=-9968.3,Z=-250)|600:walk|600:set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=0,Roll=0)|${SHOTS([660, 700, 740, 780, 820, 860])}`},
  // TerroristsOverheard (radius 350 around ThugMale3, first person, non-interactive: Amos and Jackson, Terrorist22): the player placed 180 units from Amos behind
  // the wall that hides it from both (no line from either eye to its head or feet; at 317 units in the open they see the player and the fight interrupts it).
  // Its first two speeches run out (a first-person conversation takes no key) and the second sets KnowsShipment. At tick 480 the player is placed at the Mole
  // (BumFemale0, Filben's companion), which ends the overheard conversation, and frobs her: MoleConvos checks KnowsShipment ("I've heard a little bit about
  // the shipment" instead of "A ship?"), sets it, offers the ammunition the player's 500 credits can buy (ConEventCheckPersona: credits >= 300, 175, 50), and
  // "I'll take the 10 mm clip for 175." (first) -> TransferObject of the Mole's Ammo10mm, M01MoleBought10mm, AddCredits -175, the trigger BumFemaleWanders.
  oV: {map: '01_NYC_UNATCOIsland', ticks: 1300, conversation: true, early: PLACE(3109, -61, 1088, 32768), pawns: ['ThugMale3', 'Terrorist22', 'BumFemale0'], watch: [...AMOS, ...FILBEN],
    cmds: '480:ghost|480:set DeusEx.JCDentonMale Location (X=1771,Y=-9838,Z=-250)|480:walk|480:set DeusEx.JCDentonMale ViewRotation (Pitch=-7500,Yaw=7416,Roll=0)|520:ParseRightClick'
      + `|${SHOTS([560, 600, 640, 680, 720, 760])}|${CHOOSE(800, 0)}|${SHOTS([860])}`},
  // TopTerroristsOverheard (radius 200 around Terrorist9, first person: Terrorist9 and Terrorist8 on the floor below the commander): the player placed 150 units
  // away where neither sees it (the hiding test of oV); its six speeches run out, its two ConEventCheckFlags (StatueAlarmTriggered, GuntherFreed) both false:
  // "The troops pulled back...".
  oT: {map: '01_NYC_UNATCOIsland', ticks: 1200, conversation: true, early: PLACE(3338, 221, 2032, 32768), pawns: ['Terrorist9', 'Terrorist8', 'TerroristCommander0'], watch: COMMANDER, cmds: ''},
  // M01PlayerAggressive (row 5.6.6): eight Terrorists killed by the player, each with DeusExPlayer.Tantalus (every health 0 and TakeDamage from the player) from
  // a place 220 units off with a clear line (Terrorist16 from cmb5's ledge), so that Mission01.Timer's count (the Terrorists plus the carcasses JC did not
  // kill, 29 + 1 at the load) falls below 23 and sets the flag; six ticks after the last kill the player is placed back at the map's start, then by
  // UNATCOTroop6, whose first-person TrooperCongratulation (radius 250) reads the flag ("Good shootin', sir", its JustTerrorists branch). The stored
  // capture (2026-10-18) does not reach it: the Tantalus at 80 hit nothing (Terrorist18 was not on the line; seven carcasses, the count stays at 23, no
  // flag), and the placement at the trooper, outside the world, killed the player at once in both programs, as it had in a first capture (kA) that made all
  // eight carcasses and set the flag. It passes as a comparison only; kC is its redesign.
  kB: {map: '01_NYC_UNATCOIsland', ticks: 700, conversation: true, early: 'KillAll FlyGenerator', pawns: ['Terrorist8', 'Terrorist9', 'UNATCOTroop6'], watch: ['UNATCOTroop6', 'Terrorist8', 'Terrorist9', 'Terrorist4', 'Terrorist27', 'Terrorist22', 'ThugMale3'],
    cmds: [[20, 1221, -961, 799, 32768, -3632], [50, 9871, 190, -87, 32768, -2104], [80, 2126, -1330, -91, 35109, -2430], [110, 3174, -271, 1093, 32768, -2104],
      [140, 3379, 105, 2037, 32768, -2104], [145, 3413, 182, 2037, 32768, -2104], [175, 6218, 2532, -91, 32768, -2104], [180, 6084, 2493, -91, 32768, -2104]]
      .map(([t, x, y, z, yaw, pitch]) => `${t}:ghost|${t}:set DeusEx.JCDentonMale Location (X=${x},Y=${y},Z=${z})|${t}:walk|${t}:set DeusEx.JCDentonMale ViewRotation (Pitch=${pitch},Yaw=${yaw},Roll=0)|${t}:Tantalus`).join('|')
      + '|186:ghost|186:set DeusEx.JCDentonMale Location (X=-4760.6,Y=10430.8,Z=-256.2)|186:walk|186:set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=58496,Roll=0)'
      + '|360:ghost|360:set DeusEx.JCDentonMale Location (X=-4062,Y=2085,Z=-187)|360:walk|360:set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=32768,Roll=0)'},
  ...ROUTE_SCENES,
  // kB's two causes, measured on its stored capture and kA's: (1) the kill at tick 80 hit nothing in kB (no death cry, no Distress from Terrorist18, whose
  // footstep LoudNoises go on at 85, 124, 162...): Terrorist18 (Sitting orders) leaves its load place for a seat once StartUp's Sleep(FRand()+0.2) ends, on a
  // path the stream chooses, and the line aimed at kA's tick-80 place missed it; the other seven victims made their carcasses in both captures (98 to 253),
  // the last ones after the player had left (a Dying pawn sets bStasis False). (2) kB's placement at the trooper (-4062, 2085, -187) lies outside the world
  // (the trace's player Region: zone 0, leaf -1, at 361; Play's PointRegion agrees): Pawn.FellOutOfWorld (Health -1, PHYS_None, Died 'Fell').
  // kC: Terrorist18 killed at tick 3 at its load place (1906.3, -1329.9, -96.3) from 220 units east, before the 0.2 s minimum of StartUp's Sleep can move
  // it (an unrendered pawn in StartUp follows its orders only when the Sleep ends; the frozen phase leaves the player at the map start, 12,000 units off),
  // then kB's other seven kills at kB's ticks, the player parked at the map start at 80 (in kB it went to Terrorist18's place) and at 186; at 360, after
  // the last carcass (kB: 253) and Mission01.Timer's next count, placed on the office floor 160 units north of UNATCOTroop6's seat ((-4262.5, 1945.2,
  // -199.9) from 359 on in kB's trace), facing it: inside TrooperCongratulation's 250 (DeusExPlayer.CheckConversationInvokeRadius: int VSize <= 250) and
  // its height check, with the flag already set (bDisplayOnce: it plays once, so the flag must come first).
  kC: {map: '01_NYC_UNATCOIsland', ticks: 800, conversation: true, early: 'KillAll FlyGenerator', pawns: ['Terrorist18', 'Terrorist16', 'UNATCOTroop6'],
    watch: ['UNATCOTroop6', 'Terrorist18', 'Terrorist16', 'Terrorist8', 'Terrorist9', 'Terrorist4', 'Terrorist27', 'Terrorist22', 'Terrorist0'],
    cmds: [[3, 2126.3, -1329.9, -91, 32768, -2120], [20, 1221, -961, 799, 32768, -3632], [50, 9871, 190, -87, 32768, -2104], [110, 3174, -271, 1093, 32768, -2104],
      [140, 3379, 105, 2037, 32768, -2104], [145, 3413, 182, 2037, 32768, -2104], [175, 6218, 2532, -91, 32768, -2104], [180, 6084, 2493, -91, 32768, -2104]]
      .map(([t, x, y, z, yaw, pitch]) => `${t}:ghost|${t}:set DeusEx.JCDentonMale Location (X=${x},Y=${y},Z=${z})|${t}:walk|${t}:set DeusEx.JCDentonMale ViewRotation (Pitch=${pitch},Yaw=${yaw},Roll=0)|${t}:Tantalus`).join('|')
      + [80, 186].map(t => `|${t}:ghost|${t}:set DeusEx.JCDentonMale Location (X=-4760.6,Y=10430.8,Z=-256.2)|${t}:walk|${t}:set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=58496,Roll=0)`).join('')
      + '|360:ghost|360:set DeusEx.JCDentonMale Location (X=-4262.5,Y=2105.2,Z=-191)|360:walk|360:set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=49152,Roll=0)'},
  // 00_TrainingFinal (sixth captures, rows 5.2.1, 5.3.13, 5.4.8, 5.6.2). The map is opened at PlayerStart0 (-501, -499); the stealth maze's two soldiers (Soldier0 and
  // Soldier2, Patrolling, Alliance None) are the pawns, and the alarm chain's devices are watched with their class's fields (ElevatorMover is not a DeusExMover).
  // stl1, the maze lost and reset (rows 5.2.1, 5.6.2, 5.3.13's close and reopen): the player placed in the frozen phase 180 units east of Soldier0 (469.8, 383.8) on the
  // maze floor, facing it. Soldier0 sees him, goes Alerting and runs to an AlarmUnit; AlarmUnit.Trigger -> UpdateGroup triggers the four of Tag StealthMazeAlarmUnit,
  // each fires its Event AlarmDispatcher (Dispatcher1: SoldierNeutral = AllianceTrigger0 and 2, CloseDoor = SequenceTrigger1 SeqNum 1 -> ElevatorMover1.SetSeq,
  // failmessage = DataLinkTrigger7 -> DL_FailedStealth); the units ring for alarmTimeout (10 s). Then the player is set on the platform west of Switch0 (300, 207.7;
  // the pose is 38.7 units from the switch and 50.7 under his eye: pitch -9588) and the right button presses it (ButtonDispatcher: SoldierHostile, OpenDoor =
  // SequenceTrigger0 SeqNum 0, SoldierPatrol, SpecialEventMsg), and ExitDoor slides back.
  stl1: {map: '00_TrainingFinal', ticks: 1250, early: PLACE(650, 384, -128, 32768), speech: true, wholeFlags: true,
    cmds: `${MOVE(900, 300, 207.7, 45, 0, -9588)}|960:ParseRightClick`, pawns: ['Soldier0', 'Soldier2'],
    devices: [...[0, 1, 2, 3].map(i => `AlarmUnit${i}:AlarmUnit`), 'ElevatorMover1:ElevatorMover', 'Dispatcher1:Actor', 'Dispatcher0:Actor', 'Switch0:Actor']},
  // sw1 (row 5.3.13, Switch1): the player set on the first corridor's floor 50 units west of Switch1 (-144.9, -36.2, 58.5; it faces -X), 13.3 under his eye (pitch -2712);
  // the right button presses it at 60 (DeusExDecoration.Frob triggers its Event FirstStealthDoor: DeusExMover0, TriggerToggle, MoveTime 1) and again at 220 (it toggles back).
  sw1: {map: '00_TrainingFinal', ticks: 360, early: 'KillAll FlyGenerator', wholeFlags: true, pawns: ['Soldier0', 'Soldier2'],
    cmds: `${MOVE(1, -195, -36, 45, 0, -2712)}|60:ParseRightClick|220:ParseRightClick`,
    devices: ['DeusExMover0:DeusExMover', 'Switch1:Actor']},
  // mpg1 (row 5.4.8, M00MeetPage): ConversationTrigger1 (conversationTag m00meetpage, BindName BobPage, radius 96) starts the third-person conversation from its Touch, which
  // needs the player not Falling (DeusExPlayer.CanStartConversation): every placement leaves him falling for a few ticks, so he is set 122.5 units from the trigger (outside
  // its 96 + his radius), lands, and is pushed toward it at 150 by a Velocity SET (a held key cannot be posted); the first move across the boundary touches it and
  // BobPage1 and the player enter their conversation states. Five speeches (Bob, JC, Bob, JC, Bob) are skipped with the Enter edge every 40 ticks from 190 and the last
  // one ends the conversation (M00MeetPage_Played).
  mpg1: {map: '00_TrainingFinal', ticks: 520, early: 'KillAll FlyGenerator', conversation: true, pawns: ['BobPage1'],
    cmds: `${MOVE(1, 6577, -5309, 100, 49152)}|150:set DeusEx.JCDentonMale Velocity (X=0,Y=-300,Z=0)|${SHOTS([190, 230, 270, 310, 350])}`},
  // jmr1 (row 5.4.8, holo-Jaime): the player set 43 units west of Switch6 (7298.4, -4287.5, 111.9; it faces -X), 7.9 under his eye (pitch -1900); the right button at 150
  // presses it (Event jaime_talks -> FlagTrigger11 sets JaimeAppears and triggers 'convo'). Mission00.Timer's 00_TRAININGFINAL branch EnterWorld()s the holojaime
  // JaimeReyes (JaimeReyes6, bInWorld false until then), whose radius conversation JaimeBark (first person, 160 units) plays; on JaimeBark_Played the Timer LeaveWorld()s
  // it and sets MS_ReyesHidden.
  jmr1: {map: '00_TrainingFinal', ticks: 1000, early: 'KillAll FlyGenerator', conversation: true, pawns: ['JaimeReyes6'],
    cmds: `${MOVE(1, 7255, -4287.5, 100, 0, -1900)}|150:ParseRightClick`, devices: ['Switch6:Actor']},
  // Windows by key edges (rows 5.3.3 and 5.3.9; docs/stage-5-exit-criteria.md "Captures: windows, the bots and the terminals"). The harness posts no mouse: a button is
  // pressed by the focus the window system gives it and an Enter edge (ButtonWindow.VirtualKeyPressed: Enter or Space presses the focused button), the focus moves by the
  // arrow keys and Tab (RootWindow.VirtualKeyPressed: MoveFocusLeft/Right/Up/Down, MoveTabGroupNext), text is typed as WM_CHAR units (`@type`), a button's accelerator is
  // Alt and its letter (`@down AltLeft|@down KeyD|@up KeyD|@up AltLeft`). `--typed-chars` makes the replay deliver TranslateMessage's characters of the Tab, Escape, Enter and
  // letter edges, as the original's message loop does.
  // The repair bot (HUDRechargeWindow, MFocus_Enter: the focus is not the mouse's, the root cursor stays at (0, 0)): the player placed 68 units in front of RepairBot0 (5078, 362,
  // facing +Y), looking down at its chest; Energy set to 20; the right button opens the window. The first focus is the Recharge button when it is enabled (the window's
  // CheckFocusWindow: MoveFocus(1, 1)): an Enter edge recharges (RepairBot.ChargePlayer: Min(EnergyMax - Int(Energy), chargeAmount 75), lastChargeTime), the button is disabled
  // by the cooldown (chargeRefreshTime 60) and the focus moves to Close; a second Enter closes the window (DestroyWindow: the bot's Stop animation and FollowOrders). The
  // right button again opens it with Recharge disabled (CanCharge false): the first focus is Close, and an Enter closes it without charging.
  rpr1: {map: '00_Training', ticks: 520, early: PLACE(5078, 430, -110, 49152, -5000), view: true, options: ['--typed-chars'],
    cmds: `20:set DeusEx.JCDentonMale Energy 20|60:ParseRightClick|${SHOTS([140])}|${SHOTS([220])}|290:ParseRightClick|${SHOTS([370])}`,
    devices: ['RepairBot0:RepairBot']},
  // the medical bot (HUDMedBotHealthScreen, mouse focus mode Click: the first focus is the Augmentations tab): the player 70 units in front of MedicalBot0 (5105, -4170, facing +Y);
  // the head, torso and left leg damaged by the cheat's DamagePart (the screen's maximum is the class default, so `set` of a region would not show as damage); the right
  // button opens the Health screen; Right moves the focus to the Exit tab and Up to Heal All (the position-ordered focus table), Enter presses it (MedicalBot.HealPlayer:
  // healAmount 300 to every region, lastHealTime). Escape then closes the screen (the screen's VirtualKeyPressed); the torso damaged again and the screen opened again (the
  // cooldown disables Heal All, healRefreshTime 60), Alt+E (the button's accelerator, "H|&eal All") presses nothing, Escape closes it.
  med1: {map: '00_Training', ticks: 560, early: PLACE(5105, -4100, 30, 49152, -6000), view: true, options: ['--typed-chars'],
    cmds: `20:DamagePart 1 60|21:DamagePart 0 30|22:DamagePart 4 50|60:ParseRightClick|${SHOTS([140]).replace(/Enter/g, 'ArrowRight')}|${SHOTS([170]).replace(/Enter/g, 'ArrowUp')}|${SHOTS([200])}|${SHOTS([260]).replace(/Enter/g, 'Escape')}`
      + `|300:DamagePart 1 40|320:ParseRightClick|400:@down AltLeft|400:@down KeyE|400:@up KeyE|400:@up AltLeft|${SHOTS([470]).replace(/Enter/g, 'Escape')}`,
    devices: ['MedicalBot0:MedicalBot']},
  // The Island's terminals (row 5.3.9). The player is placed in front of each (the pose of the rehearsal: the view trace selects it; a placement below the floor is zone 0) and
  // the right button opens it: the terminal runs its Activate animation (Computers.Frob, state On: TryInvoke), then InvokeComputerScreen opens the NetworkTerminal on its login
  // screen with the focus on the user name (ComputerScreenLogin.SetCompOwner), Tab moves to the password, Enter is EditActivated (ProcessLogin: a wrong pair clears both and
  // refocuses the user name), a right login opens the first screen (the e-mail list with its first row selected, or the security screen with the focus on its first choice).
  // trm1, ComputerPersonal0 (UNATCO, users GUEST/GUEST and KLloyd/squishy; the e-mails are DeusExText `01_EmailMenu_<user>`): a wrong password, KLloyd (two e-mails: ArrowDown on
  // the list selects the second), Escape (logout: back to the login screen), GUEST (`No Email Today!`), Escape twice (the second closes the terminal, which turns off).
  trm1: {map: '01_NYC_UNATCOIsland', ticks: 720, early: PLACE(-4335, 2010, -170, 49152, -7500), options: ['--typed-chars'], devices: ['ComputerPersonal0:Computers'],
    cmds: `100:ParseRightClick|200:@type KLloyd|${KEY(220, 'Tab')}|240:@type wrongpw|${KEY(260, 'Enter')}|300:@type KLloyd|${KEY(320, 'Tab')}|340:@type squishy|${KEY(360, 'Enter')}`
      + `|${KEY(420, 'ArrowDown')}|${KEY(480, 'Escape')}|520:@type GUEST|${KEY(540, 'Tab')}|560:@type GUEST|${KEY(580, 'Enter')}|${KEY(640, 'Escape')}|${KEY(680, 'Escape')}`},
  // atm1, ATM0 (account 230023, PIN 4558, balance 200; no animation): a wrong PIN ("LOGIN ERROR": both fields cleared), the right one (the withdraw screen: the amount field has the
  // focus), 50 and Enter (ComputerScreenATMWithdraw: DeusExPlayer.Credits 500 to 550, the ATM's balance 200 to 150), Escape (the login screen) and Escape (closes it).
  atm1: {map: '01_NYC_UNATCOIsland', ticks: 600, early: PLACE(2105, 1024, -100, 16384, -1000), options: ['--typed-chars', '--player-credits'], devices: ['ATM0:ATM'],
    cmds: `100:ParseRightClick|200:@type 230023|${KEY(220, 'Tab')}|240:@type 1111|${KEY(260, 'Enter')}|300:@type 230023|${KEY(320, 'Tab')}|340:@type 4558|${KEY(360, 'Enter')}`
      + `|420:@type 50|${KEY(440, 'Enter')}|${KEY(500, 'Escape')}|${KEY(540, 'Escape')}`},
  // sec1, ComputerSecurity1 (NSF, NSF001/smashthestate; view 1 "Temp Holding Cell": camera NSFCam01 = SecurityCamera5, door temp_celldoor = DeusExMover10 (locked), turret celldoor
  // = AutoTurretSmall0 (bTrackPlayersOnly, inactive)): the first focus is the Camera Status choice (Enter presses it), the other choices have no tab stop that an arrow reaches (the
  // screen's VirtualKeyPressed takes the arrows to pan the camera), so they are pressed by their accelerators, Alt and the letter of the label ("Door |&Access", "|&Door Status",
  // "|&Turret Status"): Alt+A toggles the door's lock (ToggleDoorLock: every DeusExMover of the tag), Alt+D triggers it (TriggerDoor: it opens), ArrowLeft and ArrowUp pan the
  // camera (PanCamera: DesiredRotation), and Alt+T three times cycles the turret (Attack Allies -> Attack Enemies -> Attack Everything -> Disabled: SetTurretState and
  // SetTurretTrackMode). Escape logs out, Escape closes the terminal.
  // (The terminal stands in Terrorist18's room: it sees the player, goes Alerting and attacks him from tick 600 in the rehearsal, so the player is set to take no damage, as
  // the camera captures do, `ReducedDamageType All`: a death would end the scene with the terminal open.)
  sec1: {map: '01_NYC_UNATCOIsland', ticks: 760, early: `${PLACE(2018, -1589, -100, 49152, -3500)}|set DeusEx.JCDentonMale ReducedDamageType All`, options: ['--typed-chars'],
    devices: ['ComputerSecurity1:Computers', 'SecurityCamera5:SecurityCamera', 'DeusExMover10:DeusExMover', 'AutoTurretSmall0:AutoTurret'],
    cmds: `100:ParseRightClick|200:@type NSF001|${KEY(220, 'Tab')}|240:@type smashthestate|${KEY(260, 'Enter')}|${KEY(320, 'Enter')}|${ALT(380, 'A')}|${ALT(440, 'D')}`
      + `|${KEY(520, 'ArrowLeft')}|${KEY(560, 'ArrowUp')}|${ALT(600, 'T')}|${ALT(620, 'T')}|${ALT(640, 'T')}|${KEY(700, 'Escape')}|${KEY(740, 'Escape')}`},
};
export const SCENE_FLAGS = ['--no-ghost', '--perception', '--player-gear', '--player-health', '--los-flag'];
// The device scenes add the player's eye and bob (the first-person item's placement: Inventory.RenderOverlays, CalcDrawOffset): the stored combat scenes
// were captured without them, and their commands are kept as captured. A scene's own `options` (--player-talk, --stop-destroyed) are added to
// both runs too.
// A conversation scene (`conversation: true`) also traces the player's mouth channel (--player-blend: JC's lines drive Pawn.LipSynch on blend channel 0) and
// what a conversation gives and takes (--inventory: the Inventory chains, the player's skill points, credits, conPlay, first goal and image). The replay feeds
// the speakers' measured mouth letters (conversation-acceptance.mjs phonemes, as the Stage 4 conversation rows do), and the capture dumps the player's
// FlagBase at the frozen start and at the end hold (--dump-flags, tools/dump-flags-win.c), compared with Play's at the end of the replay.
const sceneFlags = scene => [...SCENE_FLAGS, ...(scene.devices || scene.view ? ['--player-view'] : []), ...(scene.conversation ? ['--player-blend', '--inventory'] : []),
  ...(scene.options ?? [])];
// The replay's measured inputs beyond the trace rows: --render-history writes each pawn's LastRenderTime at the original's last frozen tick (the frames the
// original drew at the map's start pose, before the placement, stamped Paul, SecurityBot0 and UNATCOTroop1 at the dock; the stasis gate reads them).
const PLAY_FLAGS = ['--render-history'];
// The tracer's breakpoints of the captures (tools/dx-live-win.c `call`, docs/object-index-captures.md): the registry (AddObject, UnhashObject), the key
// edges' stream state (UEngine::InputEvent), the AI event manager (AISendEvent, AIStartEvent, AIEndEvent, AIClearEvent, the AIEvent callback) and the
// window system's frame deltas (Extension RootTick). The key edges and the frame deltas are also `frozen`: the capture's tracer attaches before the
// frozen phase's console lines are typed (live-acceptance.mjs --frozen-frames) and traces those two from there, so the replay ticks Play's windows
// with the frames the original ran around each line (docs/stage-5-exit-criteria.md "The frozen phase's window frames").
// A levelEnd scene also records UGameEngine::SetClientTravel (body 0x1038fa10; its four arguments: the viewport, the URL, bItems, TravelType): when the OPEN
// was typed, between which two ticks (`u`, inTick 0: the render after tick u).
export const captureConfig = scene => [`call-ticks 1 ${scene.ticks}`, 'call-frames', 'call 0x10157830 addobj 1 always retname', 'call 0x10157760 unhash 1 always retname',
  'call 0x103814e0 inputevent 4 always frozen', 'call 0x10382c60 aisend 5 always name0 fname 1', 'call 0x10382fe0 aistart 5 always name0 fname 1',
  'call 0x103831e0 aiend 3 always name0 fname 1', 'call 0x103832c0 aiclear 2 always name0 fname 1',
  'call 0x10384980 aievent 5 always name0 fname 1 fname 4 namearg 3 0 deref 3 5 0', 'call Extension.dll@0x1003be90 roottick 1 always frozen',
  // AIProcess's own firstProcess at its return (+0x38), before CleanupEvents relinks it past receivers destroyed in the callbacks: where its 2 ms budget
  // stopped the receiver loop (the tick exit's `aiFirst` is after the relink: capture alm1, tick 361)
  'call 0x10384080 aiproc 0 always ecxrcv 0x38',
  ...(scene.levelEnd ? ['call 0x1038fa10 settravel 4 always'] : []),
  // A scene with `windowVisibility` also records XWindow::SetVisibility (Extension.dll 0x1004c7d0; ECX the window, the bool its new visibility): which windows
  // the HUD shows and hides (tC: Play shows HUDLogDisplay at MeetTerrorist's end, where the original first draws it at TerroristFollowup's). The HUD calls it
  // for three windows every frame, which slows the traced game to about 0.5 s a tick.
  ...(scene.windowVisibility ? ['call Extension.dll@0x1004c7d0 setvis 1 always retname'] : [])];
export const CAPTURE_CONFIG = captureConfig({ticks: 900});
// (`-f`: the config with the `frozen` calls; other checkouts write the plain names)
const configFile = scene => `.work/live-acceptance/cfg/${scene.levelEnd ? 'death' : scene.windowVisibility ? 'windows' : 'combat'}-${scene.ticks}-f.cfg`;
/** The original's capture command of a scene (for the doc and a recapture). */
export const captureCommand = tag => {
  const s = SCENES[tag];
  // (--carcass-watch: the carcasses the scene spawns, bound by the tracer when they appear: tools/dx-live-win.c late-watch; --watch: the pawns watched, all
  // ScriptedPawns when absent; --device-watch Name:Class: the devices the scene is about, with their class's fields (live-acceptance.mjs DEVICE_FIELDS);
  // --wait-seconds: the tracer's time, a long scene's run to the level's end)
  return `scripts/live-original.sh ${s.map} --tag ${tag} --ticks ${s.ticks} --delta 0.0166666675 ${sceneFlags(s).join(' ')} --registry${s.flags || s.conversation || s.wholeFlags ? ' --dump-flags' : ''} --frozen-frames --extra-config ${configFile(s)}`
    + `${s.carcasses ? ` --carcass-watch ${s.carcasses.join(',')}` : ''}${s.watch ? ` --watch ${s.watch.join(',')}` : ''}${s.devices ? ` --device-watch ${s.devices.join(',')}` : ''}`
    + `${s.levelEnd || s.conversation ? ` --wait-seconds ${Math.ceil(s.ticks * (s.windowVisibility ? 1.2 : 0.8))}` : s.ticks > 900 ? ` --wait-seconds ${Math.ceil(600 * s.ticks / 900)}` : ''}`
    + ` --early-cmds "${s.early}" --cmds "${s.cmds}"`;
};

// The player's FlagBase at the end of a scene. The original's is flags-end<tag>.txt (tools/dump-flags-win.c at the end hold: a block per object named like
// JCDentonMale that holds a FlagBase, `<class> <name> slot N: FlagBase 0x.. (FlagBase) defaultExpiration D`, then one line per XFlag, `flag NAME type T
// expiration E value 0xV bucket B`: type 0 is FLAG_Bool, +0x40 the value); Play's is flags-play-end<tag>.json (live-acceptance.mjs, liveProbe({flags}):
// {defaultExpiration, entries: [{name, value, expiration}]}, a non-bool entry with its type). Every flag must be in both, with the same type, value and
// expiration, and the default expiration equal.
export const parseFlagDump = text => {
  const blocks = []; let block = null;
  for (const line of text.split('\n')) {
    const head = /^(\S+) (\S+) slot (\d+): FlagBase 0x[0-9a-f]+ \((\S+)\) defaultExpiration (-?\d+)/.exec(line);
    if (head) { blocks.push(block = {cls: head[1], name: head[2], slot: Number(head[3]), defaultExpiration: Number(head[5]), flags: new Map()}); continue; }
    const f = /^\s+flag (\S+) type (\d+) expiration (-?\d+) value 0x([0-9a-f]+)/.exec(line);
    if (f && block) block.flags.set(f[1].toLowerCase(), {name: f[1], type: Number(f[2]), expiration: Number(f[3]), value: parseInt(f[4], 16)});
  }
  return blocks;
};
export const compareFlags = (blocks, play) => {
  // (the live player: a JCDentonMale; a released player of an earlier load could still list a FlagBase, so the one with the most flags, then the last slot)
  const players = blocks.filter(b => b.cls === 'JCDentonMale').sort((a, b) => b.flags.size - a.flags.size || b.slot - a.slot);
  if (!players.length) return {problems: ['the original\'s flag dump holds no JCDentonMale FlagBase'], original: null};
  const original = players[0], problems = [], f32 = value => { const view = new DataView(new ArrayBuffer(4)); view.setFloat32(0, value, true); return view.getUint32(0, true); };
  if (original.defaultExpiration !== play.defaultExpiration) problems.push(`defaultExpiration original ${original.defaultExpiration}, Play ${play.defaultExpiration}`);
  const played = new Map(play.entries.map(entry => [entry.name.toLowerCase(), entry]));
  for (const [key, o] of original.flags) {
    const p = played.get(key);
    if (!p) { problems.push(`${o.name} only in the original (type ${o.type}, value ${o.value})`); continue; }
    const type = p.type ?? 0;
    if (type !== o.type) { problems.push(`${o.name} type original ${o.type}, Play ${type}`); continue; }
    // (a FLAG_Name value is an FName index in the original and a name in Play: not compared; the vector and rotator types hold more than +0x40)
    const value = type === 0 ? (p.value ? 1 : 0) : type === 3 ? f32(p.value) : type === 1 || type === 2 ? p.value >>> 0 : null;
    if (value !== null && value !== o.value) problems.push(`${o.name} value original 0x${o.value.toString(16)}, Play 0x${value.toString(16)}`);
    if (p.expiration !== o.expiration) problems.push(`${o.name} expiration original ${o.expiration}, Play ${p.expiration}`);
  }
  for (const [key, p] of played) if (!original.flags.has(key)) problems.push(`${p.name} only in Play (value ${JSON.stringify(p.value)})`);
  return {problems, original, candidates: players.length};
};

// A long scene's trace is large (swm1: 2,400 ticks of 74 actors, 290 MB): its play and compare steps outgrow V8's default heap (an abort, exit null),
// so a scene over 1,500 ticks runs them with a 12 GB heap limit (a ceiling, not a reservation).
let heapArgs = [];
const exec = (args, limitSeconds) => new Promise(resolve => {
  const proc = spawn(process.execPath, [...heapArgs, ...args], {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
  let out = '';
  proc.stdout.on('data', d => { out += d; }); proc.stderr.on('data', d => { out += d; });
  const timer = setTimeout(() => proc.kill('SIGKILL'), limitSeconds * 1000);
  proc.on('exit', code => { clearTimeout(timer); resolve({code, out}); });
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tag = option('scene');
  const scene = SCENES[tag];
  if (!scene) { console.error(`--scene ${Object.keys(SCENES).join('|')}`); process.exit(2); }
  if (scene.ticks > 1500) heapArgs = ['--max-old-space-size=12288'];
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
  // --compare-only judges the scene's stored replay again (play-rows-<tag>.json and the files beside it), after a change to the comparison alone
  const compareOnly = argv.includes('--compare-only');
  // Two replays of one map in different checkouts share its .work directory: this one waits while another runs (live-acceptance.mjs play or compare)
  const busy = () => { try { return execFileSync('pgrep', ['-f', `live-acceptance.mjs (play|compare) --map ${scene.map}`], {encoding: 'utf8'}).trim().length > 0; } catch { return false; } };
  for (let waited = 0; busy(); waited++) { if (!waited) console.log(`waiting: another replay of ${scene.map} is running`); await new Promise(resolve => setTimeout(resolve, 15000)); }
  if (compareOnly && !existsSync(path.join(dir, `play-rows-${tag}.json`))) { console.log(`FAIL ${tag}: --compare-only without a stored replay (play-rows-${tag}.json)`); process.exit(1); }
  // A conversation's speakers: the mouth letters the original's audio update wrote (read back from the trace's blend channels; a measured host input,
  // docs/lip-sync.md), regenerated from the stored trace as the Stage 4 conversation rows do.
  // (`speech: true`: a scene whose NPCs speak to each other, an overheard conversation, without the player's conversation flags: only the letters are fed)
  const phonemes = path.join('.work/live-acceptance', scene.map, `phonemes-${tag}.json`), speech = scene.conversation || scene.speech;
  if (speech && !compareOnly) {
    const letters = await exec(['scripts/conversation-acceptance.mjs', 'phonemes', '--map', scene.map, '--tag', tag], 300);
    if (letters.code !== 0) { console.log(letters.out.trim().split('\n').slice(-6).join('\n')); console.log(`FAIL ${tag}: the phonemes step stopped (exit ${letters.code})`); process.exit(1); }
    console.log(`phonemes: ${letters.out.trim().split('\n').slice(-1)[0]}`);
  }
  const play = compareOnly ? {code: 0, out: ''} : await exec(['scripts/live-acceptance.mjs', 'play', '--map', scene.map, '--seed', '1', '--tag', tag, ...sceneFlags(scene), ...PLAY_FLAGS, '--early-cmds', scene.early,
    ...(speech ? ['--phonemes', phonemes] : []), '--event-trace', `1:${scene.ticks}`, '--object-trace', `1:${scene.ticks}`, ...(process.env.STAGE5_PAGE_PARAMS ? ['--page-params', process.env.STAGE5_PAGE_PARAMS] : []),
    ...(process.env.STAGE5_PLAY_ARGS ? process.env.STAGE5_PLAY_ARGS.split(' ').filter(Boolean) : [])], Math.max(1800, scene.ticks * 2));
  if (play.code !== 0) { console.log(play.out.trim().split('\n').slice(-12).join('\n')); console.log(`FAIL ${tag}: the replay stopped (exit ${play.code})`); process.exit(1); }
  // the slot model's inputs (the run's own indices, the pre-frees and where they were released), the frozen phase's window frames (a capture with
  // --frozen-frames: how many the replay ticked around the typed lines and before tick 1), and the original load's FlyGenerators Play made before its KillAll
  for (const line of play.out.split('\n')) if ((line.startsWith('object trace: ') && !/registry events/.test(line)) || line.startsWith('frozen phase: ') || /window frames around them/.test(line)
    || /^the original's (\d+ )?load FlyGenerators/.test(line) || (process.env.DEBUG_CONSOLE && line.includes(process.env.DEBUG_CONSOLE))) console.log(line);
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
    // (a loaded Sound also by its export name: which bark or speech line was loaded, ConAudioAIBarks_896 or ConAudioMission01_558)
    const stem = cls => String(cls).replace(/\d+$/, '').toLowerCase(), {oAdds: a, pAdds: b} = sequence;
    const same = (o, q) => stem(o.cls) === stem(q.cls) && o.u === q.u && (stem(o.cls) !== 'sound' || o.name === q.name);
    let i = 0; while (i < a.length && i < b.length && same(a[i], b[i])) i++;
    const slots = a.filter((o, k) => b[k] && o.index !== b[k].index).length;
    console.log(`registry: ${i} of ${a.length}/${b.length} creations equal in class and tick (a Sound in name), in order; ${slots} take another slot`);
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
  // A conversation scene's (or a `wholeFlags` scene's) whole FlagBase: the player's FlagBase at the end hold against Play's at the end of the replay (the conversations' SetFlag events, the
  // <Conversation>_Played flags ConPlay sets at the end, the mission script's own).
  let flagNote = '';
  if (scene.conversation || scene.wholeFlags) {
    const originalFlags = path.join(dir, `flags-end-${tag}.txt`), playFlags = path.join(dir, `flags-play-end-${tag}.json`);
    if (!existsSync(originalFlags) || !existsSync(playFlags)) problems.push(`no flag comparison (${[originalFlags, playFlags].filter(f => !existsSync(f)).map(f => path.basename(f)).join(', ')} absent)`);
    else {
      const {problems: differ, original, candidates} = compareFlags(parseFlagDump(readFileSync(originalFlags, 'utf8')), JSON.parse(readFileSync(playFlags, 'utf8')));
      console.log(`flags at the end: the original's ${original ? `${original.name} ${original.flags.size} flags (${[...original.flags.values()].map(f => `${f.name}=${f.value}`).join(' ')})` : 'none'}${candidates > 1 ? ` (${candidates} players listed)` : ''}`);
      if (differ.length) problems.push(`flags differ: ${differ.slice(0, 6).join('; ')}`);
      else flagNote = `, the ${original.flags.size} flags at the end equal`;
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
  console.log(`PASS ${tag}: ${actors.length} actors equal for ${report.ticks} ticks, clock, stream draws, AI events and object creations equal${flagNote}${scene.levelEnd ? `, the level ends after tick ${report.ticks} in both` : ''}`);
}
