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
 *   gA        AllianceTrigger0 and OrdersTrigger6 touched by a landing at the button (Gunther UNATCO, WaitingFor), the button: the freed Gunther meets Terrorist18.
 *   tC tA     MeetTerrorist with the commander: Curious (DL_LeaderNotKilled, TerroristFollowup by frob) and Aggressive (the commander attacks, then
 *             MeetFilbenAfterStatue at Filben); both set StatueMissionComplete and run Mission01.Timer's mission-complete pass.
 *   oV        TerroristsOverheard (Amos and Jackson, first person) from behind a wall to KnowsShipment, then MoleConvos: its KnowsShipment branch, a purchase
 *             (credits, the Mole's Ammo10mm), BumFemaleWanders.
 *   oT        TopTerroristsOverheard (Terrorist9 and Terrorist8, first person) from a hidden place, to its end.
 *   kB        eight Terrorists killed (Tantalus) until Mission01.Timer sets M01PlayerAggressive, then UNATCOTroop6's TrooperCongratulation reads it. */
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
  // which the tracer does not record, and Play's frozen phase gives it its own few frames: with the conversation at tick 14, Play still showed the line at
  // MeetTerrorist's end (379: HUDLogDisplay's first draw, four GCs, the original's at 600). From tick 100 on, both run the hold's traced frames.
  tA: {map: '01_NYC_UNATCOIsland', ticks: 1050, conversation: true, early: PLACE(1221, -961, 799, 32768, -3632), pawns: ['TerroristCommander0', 'HarleyFilben0', 'PaulDenton0'], watch: [...COMMANDER, 'HarleyFilben0', 'BumFemale0'],
    cmds: `100:ghost|100:set DeusEx.JCDentonMale Location (X=2887,Y=38,Z=2539)|100:walk|100:set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=63000,Roll=0)|${SHOTS([160, 200, 240])}|${CHOOSE(300, 0)}|${SHOTS([360])}|700:ghost|700:set DeusEx.JCDentonMale Location (X=1496.6,Y=-9968.3,Z=-250)|700:walk|700:set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=0,Roll=0)|${SHOTS([760, 800, 840, 880, 920, 960])}`},
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
  // capture (2026-10-18) does not reach it: the kill at 110 made no carcass (seven, the count stays at 23, no flag), and the placement at the trooper
  // killed the player at once in both programs, as it had in a first capture (kA) that stayed at the last kill site. It passes as a comparison only.
  kB: {map: '01_NYC_UNATCOIsland', ticks: 700, conversation: true, early: 'KillAll FlyGenerator', pawns: ['Terrorist8', 'Terrorist9', 'UNATCOTroop6'], watch: ['UNATCOTroop6', 'Terrorist8', 'Terrorist9', 'Terrorist4', 'Terrorist27', 'Terrorist22', 'ThugMale3'],
    cmds: [[20, 1221, -961, 799, 32768, -3632], [50, 9871, 190, -87, 32768, -2104], [80, 2126, -1330, -91, 35109, -2430], [110, 3174, -271, 1093, 32768, -2104],
      [140, 3379, 105, 2037, 32768, -2104], [145, 3413, 182, 2037, 32768, -2104], [175, 6218, 2532, -91, 32768, -2104], [180, 6084, 2493, -91, 32768, -2104]]
      .map(([t, x, y, z, yaw, pitch]) => `${t}:ghost|${t}:set DeusEx.JCDentonMale Location (X=${x},Y=${y},Z=${z})|${t}:walk|${t}:set DeusEx.JCDentonMale ViewRotation (Pitch=${pitch},Yaw=${yaw},Roll=0)|${t}:Tantalus`).join('|')
      + '|186:ghost|186:set DeusEx.JCDentonMale Location (X=-4760.6,Y=10430.8,Z=-256.2)|186:walk|186:set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=58496,Roll=0)'
      + '|360:ghost|360:set DeusEx.JCDentonMale Location (X=-4062,Y=2085,Z=-187)|360:walk|360:set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=32768,Roll=0)'},
};
export const SCENE_FLAGS = ['--no-ghost', '--perception', '--player-gear', '--player-health', '--los-flag'];
// A conversation scene (`conversation: true`) also traces the player's mouth channel (--player-blend: JC's lines drive Pawn.LipSynch on blend channel 0) and
// what a conversation gives and takes (--inventory: the Inventory chains, the player's skill points, credits, conPlay, first goal and image). The replay feeds
// the speakers' measured mouth letters (conversation-acceptance.mjs phonemes, as the Stage 4 conversation rows do), and the capture dumps the player's
// FlagBase at the frozen start and at the end hold (--dump-flags, tools/dump-flags-win.c), compared with Play's at the end of the replay.
const sceneFlags = scene => scene.conversation ? [...SCENE_FLAGS, '--player-blend', '--inventory'] : SCENE_FLAGS;
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
  ...(scene.levelEnd ? ['call 0x1038fa10 settravel 4 always'] : []),
  // A scene with `windowVisibility` also records XWindow::SetVisibility (Extension.dll 0x1004c7d0; ECX the window, the bool its new visibility): which windows
  // the HUD shows and hides (tC: Play shows HUDLogDisplay at MeetTerrorist's end, where the original first draws it at TerroristFollowup's). The HUD calls it
  // for three windows every frame, which slows the traced game to about 0.5 s a tick.
  ...(scene.windowVisibility ? ['call Extension.dll@0x1004c7d0 setvis 1 always retname'] : [])];
export const CAPTURE_CONFIG = captureConfig({ticks: 900});
const configFile = scene => `.work/live-acceptance/cfg/${scene.levelEnd ? 'death' : scene.windowVisibility ? 'windows' : 'combat'}-${scene.ticks}.cfg`;
/** The original's capture command of a scene (for the doc and a recapture). */
export const captureCommand = tag => {
  const s = SCENES[tag];
  // (--carcass-watch: the carcasses the scene spawns, bound by the tracer when they appear: tools/dx-live-win.c late-watch; --watch: the pawns watched, all
  // ScriptedPawns when absent; --wait-seconds: the tracer's time, a long scene's run to the level's end)
  return `scripts/live-original.sh ${s.map} --tag ${tag} --ticks ${s.ticks} --delta 0.0166666675 ${sceneFlags(s).join(' ')}${s.conversation ? ' --dump-flags' : ''} --registry --extra-config ${configFile(s)}`
    + `${s.carcasses ? ` --carcass-watch ${s.carcasses.join(',')}` : ''}${s.watch ? ` --watch ${s.watch.join(',')}` : ''}${s.levelEnd || s.conversation ? ` --wait-seconds ${Math.ceil(s.ticks * (s.windowVisibility ? 1.2 : 0.8))}` : ''}`
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
  // A conversation's speakers: the mouth letters the original's audio update wrote (read back from the trace's blend channels; a measured host input,
  // docs/lip-sync.md), regenerated from the stored trace as the Stage 4 conversation rows do.
  const phonemes = path.join('.work/live-acceptance', scene.map, `phonemes-${tag}.json`);
  if (scene.conversation) {
    const letters = await exec(['scripts/conversation-acceptance.mjs', 'phonemes', '--map', scene.map, '--tag', tag], 300);
    if (letters.code !== 0) { console.log(letters.out.trim().split('\n').slice(-6).join('\n')); console.log(`FAIL ${tag}: the phonemes step stopped (exit ${letters.code})`); process.exit(1); }
    console.log(`phonemes: ${letters.out.trim().split('\n').slice(-1)[0]}`);
  }
  const play = await exec(['scripts/live-acceptance.mjs', 'play', '--map', scene.map, '--seed', '1', '--tag', tag, ...sceneFlags(scene), ...PLAY_FLAGS, '--early-cmds', scene.early,
    ...(scene.conversation ? ['--phonemes', phonemes] : []), '--event-trace', `1:${scene.ticks}`, '--object-trace', `1:${scene.ticks}`], Math.max(1800, scene.ticks * 2));
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
    // (a loaded Sound also by its export name: which bark or speech line was loaded, ConAudioAIBarks_896 or ConAudioMission01_558)
    const stem = cls => String(cls).replace(/\d+$/, '').toLowerCase(), {oAdds: a, pAdds: b} = sequence;
    const same = (o, q) => stem(o.cls) === stem(q.cls) && o.u === q.u && (stem(o.cls) !== 'sound' || o.name === q.name);
    let i = 0; while (i < a.length && i < b.length && same(a[i], b[i])) i++;
    const slots = a.filter((o, k) => b[k] && o.index !== b[k].index).length;
    console.log(`registry: ${i} of ${a.length}/${b.length} creations equal in class and tick (a Sound in name), in order; ${slots} take another slot`);
    if (i !== a.length || i !== b.length) problems.push(`creations differ at ${i} (original ${JSON.stringify(a[i] ?? null)}, Play ${JSON.stringify(b[i] ?? null)})`);
  }
  // A conversation scene's flags: the player's FlagBase at the end hold against Play's at the end of the replay (the conversations' SetFlag events, the
  // <Conversation>_Played flags ConPlay sets at the end, the mission script's own).
  let flagNote = '';
  if (scene.conversation) {
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
