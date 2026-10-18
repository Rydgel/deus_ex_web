// Live-scene acceptance against the original (docs/visual-acceptance.md "Live
// scenes"): a level that runs (NPCs walking, dancing, animation, lights),
// compared tick for tick with the original DeusEx.exe under Wine.
//
// The original is observed as a debugger (tools/dx-live-win.c `trace`):
// breakpoints at ULevel::Tick's entry and return give, for every tick, the
// input delta and the CRT rand state it ran on and the watched actors' fields
// after it. Play then replays those ticks on its own live level: the same
// delta and the same stream state per tick (a measured host input, as the
// render draws between ticks are not modelled by the replay), and records the
// same fields. The first differing tick of each field is the divergence.
//
//   node scripts/live-acceptance.mjs original --map 10_Paris_Club [--ticks 600] [--release 3] [--delta 0.0166666675]
//        [--watch auto|A,B,..] [--no-open] [--load-wait 25000] [--hold] [--shot name]
//   --shot name (original and play): a frame of each side at the last replayed tick, the level held there (the original's
//   Tick is skipped by the tracer; Play's replay holds), into .work/acceptance/<map>/<name>-original.png / -play.png for
//   `node scripts/visual-acceptance.mjs compare --maps <map> --view <name>:0,0,0:0,0,0`.
//   --cmds "N:console line|N:@down Enter|N:@up Enter" (original): console lines and key edges typed after N unfrozen ticks with the level held (Play runs
//   them at the same point of its replay; `@down`/`@up` take a KeyboardEvent.code and go through the User.ini binding: a typed `Fire` is not the binding).
//   --object-trace first:last (play): the slot model from registry-start<tag>.txt and the registry's / Galaxy's events of those ticks (scripts/live-sound-compare.mjs).
//   --registry (original): the GObjObjects registry and its free list at the frozen start and at the end (registry-start/-end<tag>.txt).
//   --carcass-watch A,B (original): carcasses the scene spawns, watched from the tick they appear with CARCASS_FIELDS and their Inventory chain
//   (watch<tag>.json `carcasses`; play resolves them lazily, compare checks the tick each one appears at).
//   --event-trace first:last (play) records the AI event manager's calls; with the original's `call` breakpoints (--extra-config) compare them with
//   `node scripts/live-events-compare.mjs --map M --tag T` (docs/visual-acceptance.md "Weapon noise"). --draw-stacks (play) lists each command's draws.
//   node scripts/live-acceptance.mjs play --map 10_Paris_Club
//   node scripts/live-acceptance.mjs compare --map 10_Paris_Club
//
// `original` needs the game running under Wine (ad/scripts/original-game.mjs
// launch; WINEPREFIX, DX_WINE, DX_GAME as in visual-acceptance.mjs). Output
// in .work/live-acceptance/<map>/ (local captures stay outside Git).
import {execFileSync, spawn} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const flag = name => process.argv.includes(`--${name}`);
const verb = process.argv[2];
const earlyCommands = () => (option('early-cmds', '') ?? '').split('|').map(line => line.trim()).filter(Boolean);
const map = option('map', '10_Paris_Club');
const dir = path.join(root, '.work/live-acceptance', map);
mkdirSync(dir, {recursive: true});
// --tag name keeps a run's files apart (original-trace-<name>.jsonl, play-rows-<name>.json): a short capture of another tick must not
// overwrite the trace a frame was taken from.
const tag = option('tag', null), suffix = tag ? `-${tag}` : '';
const tracePath = path.join(dir, `original-trace${suffix}.jsonl`);
// A watched field read from memory that is no float (an --extra-watch door read with a pawn's field list) can print as -nan(ind) or inf: not JSON.
const parseTraceLine = line => JSON.parse(line.replace(/-?nan\([a-z0-9]+\)|-?nan\b|-?inf\b/gi, 'null'));
const watchPath = path.join(dir, `watch${suffix}.json`);
const playPath = path.join(dir, `play-rows${suffix}.json`);


// The fields watched on every actor: label (the trace's key), Unreal property
// (Play reads it by name), linked offset in the retail Actor/Pawn layout (the
// SDK's, confirmed by Play's slotOf for Hooker0) and the tool's type.
const FIELDS = [
  ['Loc', 'Location', 0x114, 'f3'], ['Rot', 'Rotation', 0x120, 'i3'], ['Vel', 'Velocity', 0x144, 'f3'], ['Acc', 'Acceleration', 0x150, 'f3'],
  ['Phys', 'Physics', 0x30, 'u8'], ['Anim', 'AnimSequence', 0x54, 'name'], ['Frame', 'AnimFrame', 0x58, 'f'], ['Rate', 'AnimRate', 0x5c, 'f'],
  ['Tween', 'TweenRate', 0x60, 'f'], ['Life', 'LifeSpan', 0x50, 'f'], ['State', '$state', 0x0c, 'state'],
  ['LRT', 'LastRenderTime', 0x34, 'f'], ['Dist', 'DistanceFromPlayer', 0x38, 'f'],
  ['Dest', 'Destination', 0x354, 'f3'], ['MoveT', 'MoveTimer', 0x348, 'f'], ['Order', 'Orders', 0x674, 'name'], ['Health', 'Health', 0x428, 'i32'],
  // Walking: what scales a pawn's acceleration (Play's slotOf offsets and bit masks, SecurityBot0).
  ['WalkSp', 'WalkingSpeed', 0x68c, 'f'], ['GSpeed', 'GroundSpeed', 0x378, 'f'], ['AccelR', 'AccelRate', 0x384, 'f'],
  ['IsWalk', 'bIsWalking', 0x318, 'bit', 0x10], ['Sprint', 'bSprint', 0x6e8, 'bit', 0x800], ['Pausing', 'bPausing', 0x910, 'bit', 0x2],
  ['Staring', 'bStaring', 0x910, 'bit', 0x4], ['Sitting', 'bSitting', 0x910, 'bit', 0x40], ['Dancing', 'bDancing', 0x910, 'bit', 0x80],
  ['Crouching', 'bCrouching', 0x910, 'bit', 0x100], ['InWorld', 'bInWorld', 0x910, 'bit', 0x800], ['WalkAround', 'bWalkAround', 0x974, 'bit', 0x4],
  ['MoveTgt', 'MoveTarget', 0x34c, 'obj'], ['Enemy', 'Enemy', 0x3cc, 'obj'], ['Focus', 'Focus', 0x360, 'f3'], ['DesRot', 'DesiredRotation', 0x208, 'i3'],
  ['NextAnim', 'NextAnim', 0x688, 'name'],
  // The stasis gate (AActor::InStasis 0x1036bfe0) and its inputs: bStasis, bForceStasis (Actor +0x2a bits 5 and 6), what a rendered view changes.
  ['Stasis', 'bStasis', 0x28, 'bit', 0x200000], ['FStasis', 'bForceStasis', 0x28, 'bit', 0x400000], ['TickVis', 'bTickVisibleOnly', 0x910, 'bit', 0x400],
  // Animation beyond sequence/frame/rate: the finished/looping/notify flags (Actor +0x2a... bits 3, 4, 5 of the dword at 0x28) and blend channel 0
  // (BlendAnimSequence[0] +0x68, BlendAnimFrame[0] +0x78, BlendAnimRate[0] +0x88, BlendTweenRate[0] +0x98): an AnimEnd or a notify changes them.
  ['AnimFin', 'bAnimFinished', 0x28, 'bit', 0x8], ['AnimLoop', 'bAnimLoop', 0x28, 'bit', 0x10], ['AnimNote', 'bAnimNotify', 0x28, 'bit', 0x20],
  ['BSeq0', 'BlendAnimSequence', 0x68, 'name', 0, 0], ['BFrame0', 'BlendAnimFrame', 0x78, 'f', 0, 0], ['BRate0', 'BlendAnimRate', 0x88, 'f', 0, 0], ['BTween0', 'BlendTweenRate', 0x98, 'f', 0, 0],
  ['DesSp', 'DesiredSpeed', 0x36c, 'f'], ['MaxDes', 'MaxDesiredSpeed', 0x370, 'f'], ['Reduced', 'bReducedSpeed', 0x318, 'bit', 0x800],
  // Pawn.PostBeginPlay draws SightCounter (0.2 * FRand()) from the load's stream, which the two sides do not share (docs/rng.md): written into Play
  // from the original's frozen phase (PAWN_LOAD_FIELDS); it decides which tick each listener's visibility check, and so the player's ShowSelf draws, run.
  ['Sight', 'SightCounter', 0x320, 'f'],
  // The Timer event's phase (Actor +0x48/+0x4c): who draws on which tick follows it.
  ['TRate', 'TimerRate', 0x48, 'f'], ['TCount', 'TimerCounter', 0x4c, 'f'],
  // The latent Sleep's remaining seconds (Actor +0xe0): the draw a StartUp pawn's Sleep(FRand()+0.2) made, so the stream position of each pawn's draw.
  ['LatF', 'LatentFloat', 0xe0, 'f'],
];
// The load-time draws of the pawns (see GENERATOR_FIELDS): label of FIELDS -> written into Play's pawn before the first tick.
const PAWN_LOAD_FIELDS = ['Sight', 'TRate', 'TCount'];
// --render-history: also each pawn's (and generator's) LastRenderTime at the original's last frozen tick. The frames the original drew before the tracer attached
// (the start view, and every view a typed --early-cmds line passed through) stamped it; Play replays one view, so the older stamps are a measured host
// input (the stasis gate reads them for 5 seconds: AActor::InStasis, docs/script-actor-tick.md). Compared from tick 1 on like every field.
const renderHistoryFields = () => flag('render-history') ? [...PAWN_LOAD_FIELDS, 'LRT'] : PAWN_LOAD_FIELDS;
// --perception: what carries a ScriptedPawn's perception and reaction (ScriptedPawn.CheckEnemyPresence/CheckCycle/UpdateReactionLevel, the
// HandleXxx reactions, SeekPawn/SeekLevel, the agitation and alarm timers), at the linked offsets Play's slotOf gives (liveProbe offsets with
// offsetMasks: bool properties give their UBoolProperty::BitMask) and the first eight AlliancesEx entries (name, AllianceLevel, AgitationLevel;
// entries start at +0x7ec, stride 16).
const PERCEPTION_FIELDS = [
  ['EnemyRdy', 'EnemyReadiness', 1856, 'f'], ['ReactLvl', 'ReactionLevel', 1860, 'f'], ['SightPct', 'SightPercentage', 1868, 'f'],
  ['CycTimer', 'CycleTimer', 1872, 'f'], ['CycPeriod', 'CyclePeriod', 1876, 'f'], ['CycCum', 'CycleCumulative', 1880, 'f'],
  ['CycCand', 'CycleCandidate', 1884, 'obj'], ['CycDist', 'CycleDistance', 1888, 'f'], ['CycIdx', 'CycleIndex', 2312, 'i32'],
  ['ChkPeriod', 'CheckPeriod', 2296, 'f'], ['EnemyLast', 'EnemyLastSeen', 2300, 'f'], ['PotAlly', 'PotentialEnemyAlliance', 1604, 'name'],
  ['PotTimer', 'PotentialEnemyTimer', 1608, 'f'], ['AlarmT', 'AlarmTimer', 1896, 'f'], ['AgitT', 'AgitationTimer', 1828, 'f'],
  ['AgitChk', 'AgitationCheckTimer', 1832, 'f'], ['PlAgitT', 'PlayerAgitationTimer', 1836, 'f'], ['SeekLvl', 'SeekLevel', 1580, 'i32'],
  ['SeekType', 'SeekType', 1584, 'u8'], ['SeekPawn', 'SeekPawn', 1588, 'obj'], ['SeekLoc', 'bSeekLocation', 1616, 'bit', 2],
  ['FearLvl', 'FearLevel', 1852, 'f'], ['FearT', 'FearTimer', 1848, 'f'], ['CarcassT', 'CarcassTimer', 1592, 'f'], ['BeamChk', 'BeamCheckTimer', 1612, 'f'],
  ['WeaponT', 'WeaponTimer', 1900, 'f'], ['FireT', 'FireTimer', 1904, 'f'], ['SpecialT', 'SpecialTimer', 1908, 'f'], ['Stimulus', 'Stimulus', 928, 'f'],
  ['HeldWpn', 'Weapon', 976, 'obj'],
  ['LkEnemy', 'bLookingForEnemy', 1804, 'bit', 1], ['LkLoud', 'bLookingForLoudNoise', 1804, 'bit', 2], ['LkAlarm', 'bLookingForAlarm', 1804, 'bit', 4],
  ['LkDistress', 'bLookingForDistress', 1804, 'bit', 8], ['LkProj', 'bLookingForProjectiles', 1804, 'bit', 16], ['LkFutz', 'bLookingForFutz', 1804, 'bit', 32],
  ['LkHack', 'bLookingForHacking', 1804, 'bit', 64], ['LkShot', 'bLookingForShot', 1804, 'bit', 128], ['LkWeapon', 'bLookingForWeapon', 1804, 'bit', 256],
  ['LkCarcass', 'bLookingForCarcass', 1804, 'bit', 512], ['LkInjury', 'bLookingForInjury', 1804, 'bit', 1024], ['LkIndirect', 'bLookingForIndirectInjury', 1804, 'bit', 2048],
  ['Distressed', 'bDistressed', 2320, 'bit', 16], ['Attacking', 'bAttacking', 2320, 'bit', 8], ['Stunned', 'bStunned', 2320, 'bit', 32],
  ['NoNegAl', 'bNoNegativeAlliances', 1616, 'bit', 16], ['AlChanged', 'bAlliancesChanged', 1616, 'bit', 8], ['FacingTgt', 'bFacingTarget', 1804, 'bit', 4096],
  // AICanSee's inputs on the viewer (Pawn: BaseEyeHeight, AIHorizontalFOV, AspectRatio, MinAngularSize, VisibilityThreshold, AIAddViewRotation) and its collision size.
  ['BaseEye', 'BaseEyeHeight', 0x3f4, 'f'], ['HFov', 'AIHorizontalFOV', 0x5ac, 'f'], ['Aspect', 'AspectRatio', 0x5b0, 'f'], ['MinAng', 'MinAngularSize', 0x5b8, 'f'],
  ['VisThr', 'VisibilityThreshold', 0x5bc, 'f'], ['AddView', 'AIAddViewRotation', 0x5c8, 'i3'], ['CRad', 'CollisionRadius', 0x1d4, 'f'], ['CHeight', 'CollisionHeight', 0x1d8, 'f'],
  ['Alliance', 'Alliance', 1476, 'name'], ['OrderTag', 'OrderTag', 1656, 'name'], ['OrderAct', 'OrderActor', 1668, 'obj'],
  ...[0, 1, 2, 3, 4, 5, 6, 7].flatMap(i => [[`AlName${i}`, `$AlName${i}`, 2028 + 16 * i, 'name'], [`AlLvl${i}`, `$AlLvl${i}`, 2032 + 16 * i, 'f'], [`AlAgit${i}`, `$AlAgit${i}`, 2036 + 16 * i, 'f']]),
];
if (flag('perception')) FIELDS.push(...PERCEPTION_FIELDS);
// --los-flag: Pawn.bLOSflag (+0x318 bit 0x80000), the alternating-trace bit the sight worker 0x103beb50 toggles on every FOV-checked call: it decides
// whether a far listener's ShowSelf check draws its FRand (script-pawn-perception.mjs losWorker), so a phase difference shifts a draw by one tick.
if (flag('los-flag')) FIELDS.push(['LOSflag', 'bLOSflag', 0x318, 'bit', 0x80000]);
// --touching: Actor.Touching[0..3] (+0xe8..+0xf4) of every watched actor, the extras' included (the four slots BeginTouch/AddTouch fill and evict).
if (flag('touching')) FIELDS.push(...[0, 1, 2, 3].map(i => [`Touch${i}`, 'Touching', 0xe8 + 4 * i, 'obj', 0, i]));
// The player's pose, read back from the original (the placement of Play's replay): view rotation and Region.
const PLAYER_FIELDS = FIELDS.slice(0, 10).concat([FIELDS[10]],
  [['VRot', 'ViewRotation', 0x3dc, 'i3'], ['RegZone', '$regionZone', 0xc8, 'obj'], ['RegLeaf', '$regionLeaf', 0xcc, 'i32'], ['RegNum', '$regionNum', 0xd0, 'u8'],
  // The rest of the player's animation state (script-anim.mjs: +0x220 AnimLast, +0x224 AnimMinRate, +0x228 OldAnimRate, the bits of +0x28), written into Play with
  // the sequence and frame: a TweenAnim (TweenToWaiting after a landing) leaves the same sequence name with AnimLast 0 and bAnimLoop off, and the replay's first
  // tick then ended that "tween" (AnimEnd, PlayWaiting) where the original's loop ran on (Stage 5 capture cmb1, 2026-10-17).
  ['ALast', 'AnimLast', 0x220, 'f'], ['AMin', 'AnimMinRate', 0x224, 'f'], ['AOld', 'OldAnimRate', 0x228, 'f'],
  ['AnimFin', 'bAnimFinished', 0x28, 'bit', 0x8], ['AnimLoop', 'bAnimLoop', 0x28, 'bit', 0x10], ['AnimNote', 'bAnimNotify', 0x28, 'bit', 0x20],
  // Actor.bTicked (+0x28 bit 0x200): the player ticks every tick, so it is ULevel::TickTag of that tick (docs/script-actor-tick.md); the replay starts Play's
  // tag at the original's parity (the frozen ticks of the two programs differ in number).
  ['Ticked', 'bTicked', 0x28, 'bit', 0x200]]);
// --perception: the player's AIVisibility cache (Actor +0x2e8: VisUpdateTime, CurrentVisibility, LastVisibility), which every AICanSee on the player reads.
if (flag('perception')) PLAYER_FIELDS.push(['CRad', 'CollisionRadius', 0x1d4, 'f'], ['CHeight', 'CollisionHeight', 0x1d8, 'f'], ['BaseEye', 'BaseEyeHeight', 0x3f4, 'f'], ['VisT', 'VisUpdateTime', 0x2e8, 'f'], ['CurVis', 'CurrentVisibility', 0x2ec, 'f'], ['LastVis', 'LastVisibility', 0x2f0, 'f']);

// --player-gear: what the player holds and aims at (Pawn.Weapon/PendingWeapon, Inventory, DeusExPlayer.inHand/FrobTarget, bFire, Health): the console scenes that summon,
// pick up and fire a weapon (--cmds) are followed through these.
if (flag('player-gear')) PLAYER_FIELDS.push(['Weapon', 'Weapon', 976, 'obj'], ['PendWeapon', 'PendingWeapon', 980, 'obj'], ['Inv', 'Inventory', 192, 'obj'], ['InHand', 'inHand', 2600, 'obj'],
  ['FrobTgt', 'FrobTarget', 2536, 'obj'], ['bFire', 'bFire', 1206, 'u8'], ['PHealth', 'Health', 1064, 'i32'], ['FrobTime', 'FrobTime', 2540, 'f']);
// --player-health: the player's hit regions (Pawn.HealthHead..HealthArmRight, the linked offsets of Play's class graph): where an NPC's shots land
// (DeusExPlayer.TakeDamage/HandleDamage) in the combat scenes of the Stage 5 gate (docs/stage-5-exit-criteria.md).
const HIT_REGION_FIELDS = [['HHead', 'HealthHead', 1376, 'i32'], ['HTorso', 'HealthTorso', 1380, 'i32'], ['HLegL', 'HealthLegLeft', 1384, 'i32'],
  ['HLegR', 'HealthLegRight', 1388, 'i32'], ['HArmL', 'HealthArmLeft', 1392, 'i32'], ['HArmR', 'HealthArmRight', 1396, 'i32']];
if (flag('player-health')) PLAYER_FIELDS.push(...HIT_REGION_FIELDS);
// --player-blend: the player's blend channel 0 (the mouth animation Pawn.LipSynch plays while JC speaks in a conversation): BSeq0, BFrame0, BRate0, BTween0 of FIELDS.
if (flag('player-blend')) PLAYER_FIELDS.push(...FIELDS.filter(f => ['BSeq0', 'BFrame0', 'BRate0', 'BTween0'].includes(f[0])));
// Load-time random state of the PawnGenerators (PigeonGenerator, SeagullGenerator, ...): PostBeginPlay draws TryTimer
// (0.25 + FRand()*0.75) and, with bRandomCount, PoolCount from the load's stream, which the two sides do not share
// (the original seeds the CRT with time(NULL), docs/rng.md). A generator first spawns when its TryTimer runs out,
// so Play's own draws moved those ticks (and the draws they make) by several ticks. Like the player's pose, the
// original's values are a measured input: read at the release (the last frozen row), written into Play before its first tick.
const GENERATOR_LOAD_FIELDS = [['TryTimer', 'TryTimer', 0x540, 'f'], ['PoolCount', 'PoolCount', 0x3b4, 'i32']];
// Watched too, on both sides (row 4.2.13, docs/visual-acceptance.md "04_NYC_Street's steam vents"): what decides whether a generator's tick
// generates (PawnGenerator.Tick: IsActorUnnecessary is DistanceFromPlayer >= ActiveArea, so where it is), whether it ticks at all (AActor::InStasis
// 0x1036bfe0 returns 0 at a clear bStasis before it reads LastRenderTime's zone table) and its scout. A chance FlyGenerator of one load and the
// same-named one of another are two decorations' (DeusExDecoration.PreBeginPlay's FRand() < 0.1, numbered in spawn order): Location tells them apart.
// Offsets: Play's slotOf (liveProbe offsets) for PawnGenerator, the PawnGenerator layout every generator class shares.
const GENERATOR_FIELDS = [...GENERATOR_LOAD_FIELDS, ['Loc', 'Location', 0x114, 'f3'], ['Dist', 'DistanceFromPlayer', 0x38, 'f'],
  ['LRT', 'LastRenderTime', 0x34, 'f'], ['Stasis', 'bStasis', 0x28, 'bit', 0x200000], ['Phys', 'Physics', 0x30, 'u8'],
  ['PawnCount', 'PawnCount', 0x3b0, 'i32'], ['ScoutInit', 'bScoutInit', 0x550, 'bit', 0x2], ['Scout', 'Scout', 0x538, 'obj']];

// --carcass-watch A,B: carcasses the scene spawns (a pawn's death, ScriptedPawn.SpawnCarcass), watched from the tick they appear (tools/dx-live-win.c
// `late-watch`: bound at the tick exit after their AddObject; Play's replay resolves the same name lazily), with the Actor fields of every actor, the
// DeusExCarcass fields InitFor and the Dying pawn set (Play's slotOf for TerroristCarcass0: KillerAlliance, Alliance, CarcassName, MaxDamage, the bools
// at +0x3c8) and the Inventory chain the pawn handed over (Actor.Inventory +0xc0, then each item's own: the contents Frob gives the player).
const CARCASS_FIELDS = [
  ['Loc', 'Location', 0x114, 'f3'], ['Rot', 'Rotation', 0x120, 'i3'], ['Vel', 'Velocity', 0x144, 'f3'], ['Acc', 'Acceleration', 0x150, 'f3'], ['Phys', 'Physics', 0x30, 'u8'],
  ['Anim', 'AnimSequence', 0x54, 'name'], ['Frame', 'AnimFrame', 0x58, 'f'], ['Rate', 'AnimRate', 0x5c, 'f'], ['Life', 'LifeSpan', 0x50, 'f'], ['State', '$state', 0x0c, 'state'],
  ['LRT', 'LastRenderTime', 0x34, 'f'], ['Dist', 'DistanceFromPlayer', 0x38, 'f'], ['TRate', 'TimerRate', 0x48, 'f'], ['TCount', 'TimerCounter', 0x4c, 'f'],
  ['CRad', 'CollisionRadius', 468, 'f'], ['CHeight', 'CollisionHeight', 472, 'f'], ['Hidden', 'bHidden', 40, 'bit', 2], ['Base', 'Base', 196, 'obj'],
  ['Mass', 'Mass', 500, 'f'], ['Buoy', 'Buoyancy', 504, 'f'], ['Killer', 'KillerAlliance', 944, 'name'], ['CAlliance', 'Alliance', 956, 'name'],
  ['CarcName', 'CarcassName', 960, 'name'], ['MaxDmg', 'MaxDamage', 964, 'i32'], ['CumDmg', 'CumulativeDamage', 844, 'i32'], ['NotDead', 'bNotDead', 968, 'bit', 1],
  ['Emit', 'bEmitCarcass', 968, 'bit', 2], ['CInit', 'bInit', 968, 'bit', 8], ['Flies', 'bGenerateFlies', 948, 'bit', 1], ['InvChain', '$inventoryChain', 192, 'chain'],
];

const spec = ([label, , off, type, mask]) => `${label}:0x${off.toString(16)}:${type}${mask ? `:0x${mask.toString(16)}` : ''}`;


// The original's window under Hyprland: floating, 1280x720 and inside the screen (docs/visual-acceptance.md "Frames").
function hyprlandWindow() {
  // the game's window is the largest client of the class (a hidden log window shares it)
  const find = () => JSON.parse(execFileSync('hyprctl', ['clients', '-j'], {encoding: 'utf8'})).filter(c => c.class.toLowerCase() === 'deusex.exe')
    .sort((a, b) => b.size[0] * b.size[1] - a.size[0] * a.size[1])[0];
  const placed = w => w && w.floating && w.size[0] === 1280 && w.size[1] === 720 && w.at[0] >= 0 && w.at[1] >= 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    const window = find();
    if (!window) throw new Error('no deusex.exe window');
    if (placed(window)) return attempt > 0;
    const at = `address:${window.address}`;
    for (const dispatch of [`hl.dsp.window.float({ action = "set", window = "${at}" })`,
      `hl.dsp.window.resize({ x = 1280, y = 720, relative = false, window = "${at}" })`, `hl.dsp.window.center({ window = "${at}" })`])
      { execFileSync('hyprctl', ['dispatch', dispatch]); execFileSync('sleep', ['1.5']); } // each takes effect before the next (a resize sent right after the float was ignored)
    execFileSync('sleep', ['1']);
  }
  throw new Error(`the deusex.exe window does not stay floating at 1280x720: ${JSON.stringify(JSON.parse(execFileSync('hyprctl', ['clients', '-j'], {encoding: 'utf8'})).filter(c => /deus/i.test(c.class)).map(c => ({floating: c.floating, size: c.size, at: c.at, mapped: c.mapped})))}`);
}
const acceptanceDir = () => { const d = path.join(root, '.work/acceptance', map); mkdirSync(d, {recursive: true}); return d; };

// --- the original ---------------------------------------------------------
async function original() {
  const game = await import('../ad/scripts/original-game.mjs');
  const scratch = path.join(dir, 'steps'); mkdirSync(scratch, {recursive: true});
  let step = 0;
  const post = (lines, timeout) => {
    const file = path.join(scratch, `step-${String(step++).padStart(3, '0')}.txt`);
    writeFileSync(file, lines.join('\n') + '\n');
    game.run(file, timeout);
  };
  const tool = path.join(root, 'ad/build/dx-live-win.exe');
  const wine = (...args) => execFileSync(game.WINE, [tool, ...args], {encoding: 'utf8', env: process.env, maxBuffer: 1 << 26});
  const loadWait = Number(option('load-wait', 25000));
  if (!flag('no-open')) {
    // Leaving a map saves its travel state, and a map visited before loads from it
    // (visual-acceptance.mjs "Fresh maps"): hop to another map first when the game
    // has this one loaded, then move the saved state aside.
    const lastPath = path.join(root, '.work/live-acceptance/last-map.txt');
    const current = option('current', existsSync(lastPath) ? readFileSync(lastPath, 'utf8').trim() : null);
    if (current === map) post([`cmd open ${map === '00_Training' ? '01_NYC_UNATCOIsland' : '00_Training'}`, `sleep ${loadWait}`], loadWait + 60000);
    const travel = path.join(game.GAME, 'Save', 'Current', `${map}.dxs`);
    if (existsSync(travel)) {
      const aside = path.join(root, '.work/live-acceptance/save-current'); mkdirSync(aside, {recursive: true});
      renameSync(travel, path.join(aside, `${map}-${Date.now()}.dxs`));
    }
    writeFileSync(lastPath, map);
    post(['cmd set LevelInfo bPlayersOnly True', 'sleep 300', 'cmd set LevelInfo TimeDilation 1', 'sleep 300',
      `cmd open ${map}`, `sleep ${loadWait}`], loadWait + 60000);
    // The load's generators as it made them, before an --early-cmds `KillAll` removes some (generators-load<tag>.json): class, name, slot, Location
    // (do_list) and the fields of GENERATOR_FIELDS plus ActiveArea (dump-actor-win), the original's side of which chance FlyGenerator is where.
    if (earlyCommands().some(line => /^KillAll\s/i.test(line))) {
      const listed = wine('list', 'PawnGenerator').split('\n').map(line => /^(\S+) (\S+) slot=(\d+) loc=\(([^)]*)\)/.exec(line)).filter(Boolean)
        .map(m => ({cls: m[1], name: m[2], slot: Number(m[3]), loc: m[4].split(',').map(Number)}));
      // one walk of the object array for all of them (a name substring; dump-actor-win has no signed type: i32 reads as u32)
      const specs = [...GENERATOR_FIELDS, ['ActiveArea', 'ActiveArea', 0x398, 'f']].map(([label, prop, off, type, mask]) => spec([label, prop, off, type === 'i32' ? 'u32' : type, mask]));
      const dumped = execFileSync(game.WINE, [path.join(root, 'ad/build/dump-actor-win.exe'), 'Generator', ...specs], {encoding: 'utf8', env: process.env, maxBuffer: 1 << 24}).split('\n');
      for (const entry of listed) {
        const line = dumped.find(text => text.startsWith(`${entry.cls} ${entry.name} `));
        entry.fields = line ? Object.fromEntries([...line.matchAll(/(\w+)=(\S+)/g)].map(m => [m[1], m[2]])) : null;
      }
      writeFileSync(path.join(dir, `generators-load${suffix}.json`), JSON.stringify(listed, null, 1));
      console.log(`generators at the load: ${listed.map(e => `${e.name}@(${e.loc.map(Math.round)})`).join(' ')}`);
    }
    // --no-ghost: the player stays a normal visible player at the map's start (the perception pilot); --player-alliance NAME: `set` of the player's
    // Alliance (non-location, so safe in a level that then ticks): NPCs that hate NAME see the player as one of them.
    // --original-brightness b: the original's Brightness (`set WinDrv.WindowsClient Brightness b`; Shot bakes a ramp of it into the bitmap, 0.666667 makes
    // the Shot the framebuffer, visual-acceptance.mjs --brightness). Play's page keeps --brightness (0.4, its identity).
    post([...(option('original-brightness', null) ? [`cmd set WinDrv.WindowsClient Brightness ${option('original-brightness')}`, 'sleep 600'] : []),
      'cmd set DeusEx.JCDentonMale bCheatsEnabled True', 'sleep 200', ...(flag('no-ghost') ? [] : ['cmd ghost', 'sleep 200']), 'cmd ShowHud False', 'sleep 500',
      ...(option('player-alliance', null) ? [`cmd set DeusEx.JCDentonMale Alliance ${option('player-alliance')}`, 'sleep 500'] : []),
      // --early-cmds "line|line": console lines typed in the frozen phase, before the tracer attaches (Play runs the same lines after its placement). They must
      // not move or re-hash an actor: `CheatView <class>` (the camera follows another actor, PlayerPawn.CalcBehindView) and `set ...ViewRotation` are the intended use.
      ...earlyCommands().flatMap(line => [`cmd ${line}`, 'sleep 600'])]);
    // The window is placed (floating, 1280x720, inside the screen) before the tracer attaches, with a throwaway shot (the
    // first frame after a resize is stale): a resize while the tracer holds the level did not take (2026-10-13).
    // (the Mac's CrossOver window keeps the size its ini gives it: no placement there, the base frame below is still taken)
    if (option('shot', null)) {
      if (process.env.DX_HYPRLAND === '1') {
        hyprlandWindow();
        const stale = game.shots();
        post(['sleep 3000', 'shot', 'sleep 900']);
        for (const shot of game.shots().filter(shot => !stale.includes(shot))) renameSync(path.join(game.SYSTEM, shot), path.join(scratch, shot));
      }
      // --base-shot: the frozen start's frame at this camera (before the tracer releases the level): <shot>-base-original.png, with the clock it was taken at
      // beside it, the frame without the particles and sprites the ticks make (play --base-shot writes Play's).
      if (flag('base-shot')) {
        const before = game.shots();
        post(['sleep 1500', 'shot', 'sleep 900']);
        const fresh = game.shots().filter(name => !before.includes(name));
        if (!fresh.length) throw new Error('no base frame');
        const png = path.join(acceptanceDir(), `${option('shot')}-base-original.png`);
        game.bmpToPng(path.join(game.SYSTEM, fresh[0]), png);
        renameSync(path.join(game.SYSTEM, fresh[0]), path.join(acceptanceDir(), `${option('shot')}-base-original.bmp`));
      }
    }
    // Placement. The original is never moved with `set Location` or `set Region` in a level that
    // then ticks: the collision hash is not updated, and the live level crashed (a General
    // protection fault in TickLevel, 2026-10-11). The player stays at the map's start pose, or
    // flies as a ghost through input (MoveActor keeps the hash) after a `set ViewRotation`,
    // which does not touch it: --fly yaw:ms (e.g. 32768:3000). Play is placed from what the
    // original ends up in (the trace's first row).
    const fly = option('fly', null);
    if (fly) {
      const [yaw, ms] = fly.split(':').map(Number);
      post([`cmd set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=${yaw},Roll=0)`, 'sleep 300', 'down W', `sleep ${ms}`, 'up W', 'sleep 1500']);
    }
  }
  // --sweep yawBase --sweep-pawns A,B [--sweep-step 15]: instead of tracing, turn the view (ViewRotation only) through the full circle
  // in steps and read these pawns' LastRenderTime against the level time (rendered while the difference is under half a second),
  // to .work/live-acceptance/<map>/sweep-original.json (Play's: the `sweep` verb). The level stays frozen.
  // --stamps-yaws a,b --stamp-pawns A,B [--stamp-seconds 3]: at those view yaws (ViewRotation only) the tracer's `stamps` command logs
  // which frame stamps each pawn's LastRenderTime (Render.dll 0x10b25161: the frame's recursion, surface and mirror) to
  // .work/live-acceptance/<map>/stamps-<yaw>.txt. The level stays frozen.
  if (option('stamps-yaws', null) !== null) {
    for (const yaw of option('stamps-yaws').split(',').map(Number)) {
      post([`cmd set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=${yaw},Roll=0)`, 'sleep 1500']);
      const out = execFileSync(game.WINE, [path.join(root, 'ad/build/dx-live-win.exe'), 'stamps', option('stamp-seconds', 3), option('stamp-pawns', '')], {encoding: 'utf8', env: process.env, maxBuffer: 1 << 26});
      writeFileSync(path.join(dir, `stamps-${yaw}.txt`), out);
      const by = {};
      for (const line of out.split('\n').filter(Boolean)) { const m = /^\d+ (\S+) .*recursion=(\d+) iSurf=(-?\d+)/.exec(line); if (m) { const k = `${m[1]} r${m[2]}${m[2] !== '0' ? ` surf${m[3]}` : ''}`; by[k] = (by[k] ?? 0) + 1; } }
      console.log(yaw, JSON.stringify(by));
    }
    return;
  }
  if (option('sweep', null) !== null) {
    const base = Number(option('sweep')), stepDeg = Number(option('sweep-step', 15)), pawns = option('sweep-pawns', '').split(',').filter(Boolean);
    const results = [];
    for (let deg = 0; deg < 360; deg += stepDeg) {
      const yaw = ((base + Math.round(deg / 360 * 65536)) % 65536 + 65536) % 65536;
      post([`cmd set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=${yaw},Roll=0)`, 'sleep 1500']);
      const row = {deg, yaw, pawns: {}};
      for (const name of pawns) {
        const dump = execFileSync(game.WINE, [path.join(root, 'ad/build/dump-actor-win.exe'), name, 'LRT:0x34:f', 'Time:0xa8:pf:0x478'], {encoding: 'utf8', env: process.env});
        const live = dump.split('\n').map(line => /^(\S+) (\S+) LRT=(\S+) Time=(\S+)/.exec(line)).filter(m => m && m[1] !== 'Class' && m[2] === name && Number(m[4]) > 1)[0];
        if (live) row.pawns[name] = {stale: +(Number(live[4]) - Number(live[3])).toFixed(3), lrt: Number(live[3])};
      }
      results.push(row);
      console.log(deg, yaw, Object.entries(row.pawns).map(([n, v]) => `${n}:${v.stale < 0.5 ? 'R' : '.'}`).join(' '));
    }
    writeFileSync(path.join(dir, 'sweep-original.json'), JSON.stringify({map, base, results}, null, 1));
    return;
  }
  // An --early-cmds `KillAll <Class>` that the console lost (a loaded host drops typed characters, docs/visual-acceptance.md) leaves that class's
  // actors in the level: typed once more, then the run stops (exit 4) rather than trace a scene that is not the one asked for.
  for (const killed of earlyCommands().map(line => /^KillAll\s+(\w+)$/i.exec(line)?.[1]).filter(Boolean)) {
    const left = () => wine('list', killed).split('\n').filter(line => /^\S+ \S+ slot=/.test(line)).length;
    if (left()) { post([`cmd KillAll ${killed}`, 'sleep 800']); }
    const remaining = left();
    if (remaining) { console.log(`KillAll ${killed}: ${remaining} still in the level`); process.exitCode = 4; return; }
    console.log(`KillAll ${killed}: none left`);
  }
  // Likewise an --early-cmds `set DeusEx.JCDentonMale Health<Region> N` (the death scene's pre-lowered HealthTorso and HealthHead): read back from the
  // live player (dump-actor-win; the JCDentonMale whose Player is set), typed once more if the console lost it, else the run stops (exit 4).
  for (const [, property, wanted] of earlyCommands().map(line => /^set DeusEx\.JCDentonMale (Health(?:Head|Torso|LegLeft|LegRight|ArmLeft|ArmRight)) (-?\d+)$/i.exec(line)).filter(Boolean)) {
    const field = HIT_REGION_FIELDS.find(f => f[1].toLowerCase() === property.toLowerCase());
    const read = () => {
      const out = execFileSync(game.WINE, [path.join(root, 'ad/build/dump-actor-win.exe'), 'JCDentonMale', 'Player:0x5d4:u32', `V:0x${field[2].toString(16)}:u32`], {encoding: 'utf8', env: process.env});
      const live = out.split('\n').map(line => /^JCDentonMale \S+ Player=0x([0-9a-f]+) V=(\S+)/.exec(line)).filter(m => m && m[1] !== '0');
      return live.length === 1 ? Number(live[0][2]) | 0 : null;
    };
    if (read() !== Number(wanted)) post([`cmd set DeusEx.JCDentonMale ${property} ${wanted}`, 'sleep 800']);
    const now = read();
    if (now !== Number(wanted)) { console.log(`${property}: the live player holds ${now}, not ${wanted}`); process.exitCode = 4; return; }
    console.log(`${property}: ${now}`);
  }
  const generators = flag('no-generators') ? [] : wine('list', 'PawnGenerator').split('\n').map(line => /^\S+ (\S+) slot=/.exec(line)?.[1]).filter(Boolean);
  const watchOption = option('watch', 'auto');
  let names;
  const classOf = {};   // each watched pawn's class (the sweep groups divergences by it)
  if (watchOption === 'auto') {
    names = wine('list', 'ScriptedPawn').split('\n').map(line => { const m = /^(\S+) (\S+) slot=/.exec(line); if (m) classOf[m[2]] = m[1]; return m?.[2]; }).filter(Boolean);
  } else names = watchOption.split(',');
  // --extra-watch A,B: more actors (a seat, a door) watched with the same fields, e.g. one a pawn walks to.
  const extras = option('extra-watch', null)?.split(',') ?? [];
  names.push(...extras);
  const carcasses = option('carcass-watch', null)?.split(',') ?? [];
  // --cmds "30:Fire|90:AltFire": console commands typed into the original at those unfrozen tick counts, between two ticks: the tracer holds the
  // level (config `pause-at`, ticks skipped as for the final pause) while the command is typed, and Play runs the same command at the same point
  // of its replay (commands<tag>.json). A command is the console line as typed (an exec function of the player, `set ...`).
  // A command `@down NAME` / `@up NAME` is a key edge instead of a console line (NAME is a KeyboardEvent.code, `PageDown`, `Enter`): the original gets
  // it as a WM_KEYDOWN/WM_KEYUP (dxinput), Play through game.inputKey, so the User.ini binding runs (`Enter=ParseLeftClick|Fire`, `PageDown=LookDown`);
  // a typed `Fire` is not the binding: the alias runs through UInput::Exec only (docs/script-console-command.md "Aliases").
  const DXINPUT_KEYS = {PageDown: 'PGDN', PageUp: 'PGUP', Enter: 'ENTER', Escape: 'ESC', Space: 'SPACE', End: 'END', Home: 'HOME', Tab: 'TAB',
    ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', ShiftLeft: 'SHIFT', ControlLeft: 'CTRL'};
  // --cmds "N:@ctrlshot NAME": a frame of the held level while a conversation window grabs every key (ConWindowActive.VirtualKeyPressed swallows Print
  // and the numpad `*` and answers only its own hard-coded Ctrl+F9, ConsoleCommand("SHOT")). Ctrl goes through the Wine input queue (IsKeyDown reads the
  // thread's key state), F9 likewise. The Shot bitmap becomes .work/acceptance/<map>/NAME-original.png and NAME-time.txt holds the level time it was
  // taken at. Play does not run it (a screenshot changes no state): `play --ticks N --shot NAME` takes its own frame at that tick.
  const ctrlShotName = text => /^@ctrlshot (\S+)$/.exec(text)?.[1] ?? null;
  const takeCtrlShot = name => {
    const before = game.shots();
    let fresh = [];
    // (the first Ctrl+F9 of a run was once lost: tried again, the level stays held)
    for (let attempt = 0; attempt < 3 && !fresh.length; attempt++) {
      post(['focus', 'sdown CTRL', 'sleep 250', 'shold F9 120', 'sleep 250', 'sup CTRL', 'sleep 900']);
      fresh = game.shots().filter(shot => !before.includes(shot));
    }
    const dump = execFileSync(game.WINE, [path.join(root, 'ad/build/dump-actor-win.exe'), 'JCDentonMale', 'Player:0x5d4:u32', 'LevelTime:0xa8:pf:0x478'], {encoding: 'utf8', env: process.env});
    const live = dump.split('\n').map(line => /^JCDentonMale \S+ Player=0x([0-9a-f]+) LevelTime=(\S+)/.exec(line)).filter(m => m && m[1] !== '0');
    if (!fresh.length) { console.log(`@ctrlshot ${name}: NO FRAME of the original`); return; }
    const png = path.join(acceptanceDir(), `${name}-original.png`), size = game.bmpToPng(path.join(game.SYSTEM, fresh[0]), png);
    renameSync(path.join(game.SYSTEM, fresh[0]), path.join(acceptanceDir(), `${name}-original.bmp`));
    for (const extra of fresh.slice(1)) renameSync(path.join(game.SYSTEM, extra), path.join(scratch, extra));
    if (live.length === 1) writeFileSync(path.join(acceptanceDir(), `${name}-time.txt`), `${live[0][2]}\n`);
    console.log(`@ctrlshot ${name}: ${size.width}x${size.height}, level time ${live.length === 1 ? live[0][2] : '?'}`);
  };
  const keyEdge = text => {
    const m = /^@(down|up) (\S+)$/.exec(text);
    if (!m) return null;
    const key = DXINPUT_KEYS[m[2]] ?? m[2].replace(/^(Key|Digit)/, '');
    return [`${m[1]} ${key}`, 'sleep 200'];
  };
  const cmds = option('cmds', '').split('|').filter(Boolean).map(entry => { const i = entry.indexOf(':'); return {after: Number(entry.slice(0, i)), text: entry.slice(i + 1)}; });
  writeFileSync(path.join(dir, `commands${suffix}.json`), JSON.stringify(cmds));
  // Actors whose Timer runs from the load (SetTimer in PostBeginPlay, e.g. Tree: 4 + 2 * FRand()): Play's load draws another rate, so the
  // original's TimerRate/TimerCounter are read here and written into Play (docs/rng.md). The list comes from Play's population step.
  const reference0 = path.join(dir, 'play-population.json');
  // The two programs spell some actors' names with other case (the original's `mib1`, `Light1`; Play's `MIB1`, `light1`: the name table keeps the first
  // spelling registered, and FNames compare without case). Names are matched lowercase, and a name Play reports is watched in the original's spelling.
  const originalSpelling = new Map(wine('list', 'Actor').split('\n').map(line => /^\S+ (\S+) slot=/.exec(line)?.[1]).filter(Boolean).map(name => [name.toLowerCase(), name]));
  // An explicit --watch list leaves the other ScriptedPawns unwatched, but their load-time fields are replay inputs all the same (PAWN_LOAD_FIELDS and
  // LastRenderTime: a listener's SightCounter decides the tick its check runs in the player's ShowSelf, and with it that check's far-path draw; die1's
  // first replay drew at tick 4 where the original drew at 12): traced with those fields only (watch<tag>.json `loadPawns`), written by the replay at the
  // release, not compared (Play does not watch them, as the timed actors).
  let loadPawns = watchOption === 'auto' ? [] : wine('list', 'ScriptedPawn').split('\n').map(line => /^\S+ (\S+) slot=/.exec(line)?.[1]).filter(name => name && !names.includes(name));
  const LOAD_FIELDS = FIELDS.filter(f => [...PAWN_LOAD_FIELDS, 'LRT'].includes(f[0]));
  const timers = (existsSync(reference0) && !flag('no-timers') ? JSON.parse(readFileSync(reference0, 'utf8')).timers ?? [] : []).map(name => originalSpelling.get(name.toLowerCase()) ?? name)
    .filter(name => !names.includes(name) && !generators.includes(name) && !loadPawns.includes(name));
  const buildConfig = (names, generators, timers) => {
  const config = [`out ${tracePath}`, 'player JCDentonMale', `release ${option('release', 3)}`, `ticks ${option('ticks', 600)}`,
    ...(cmds.length ? [`pause-at ${[...new Set(cmds.map(c => c.after))].sort((a, b) => a - b).join(' ')}`] : []),
    ...(option('delta', null) ? [`delta ${option('delta')}`] : []), ...(option('max-seconds', null) ? [`max-seconds ${option('max-seconds')}`] : []), ...(option('monitor', null) ? [`monitor ${option('monitor')}`] : []), ...(option('actor-trace', null) ? [`actor-trace ${option('actor-trace').replace(':', ' ')}`] : []),
    // --rng-from <trace.jsonl>: the original draws the stream another capture's trace recorded: that trace's `rngIn` of unfrozen tick k is
    // written into the CRT at the entry of this run's tick k (tools/dx-live-win.c `rng-file`), so the same pawns make the same decisions
    // on a fresh load and `call` breakpoints can trace them (the capture to trace is not repeatable by loading again).
    ...(option('rng-from', null) ? (() => {
      const rows = readFileSync(option('rng-from'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.unfrozen >= 1 && row.rngIn);
      const file = path.join(dir, `rng-force${suffix}.txt`);
      writeFileSync(file, rows.map(row => String(row.rngIn).replace(/^0x/, '')).join('\n') + '\n');
      return [`rng-file ${file}`];
    })() : []),
    // --extra-config <file>: more trace.cfg lines (tools/dx-live-win.c `call` breakpoints, call-ticks, call-pawn).
    ...(option('extra-config', null) ? readFileSync(option('extra-config'), 'utf8').split('\n').filter(line => line.trim()) : []),
    ...(generators.length ? [`watch ${generators.join(',')} ${GENERATOR_FIELDS.map(spec).join(' ')}`] : []),
    `watch @player ${PLAYER_FIELDS.map(spec).join(' ')}`,
    `watch ${names.join(',')} ${FIELDS.map(spec).join(' ')}`,
    ...(carcasses.length ? [`late-watch ${carcasses.join(',')} ${CARCASS_FIELDS.map(spec).join(' ')}`] : [])];
  if (timers.length) config.push(`watch ${timers.join(',')} TRate:0x48:f TCount:0x4c:f`);
  if (loadPawns.length) config.push(`watch ${loadPawns.join(',')} ${LOAD_FIELDS.map(spec).join(' ')}`);
  return config;
  };
  let config = buildConfig(names, generators, timers.slice());
  const configPath = path.join(dir, 'trace.cfg');
  writeFileSync(configPath, config.join('\n') + '\n');
  writeFileSync(watchPath, JSON.stringify({map, pawns: names.filter(name => !extras.includes(name)), extras, carcasses, generators, timers, loadPawns, classes: classOf}, null, 1));
  // The actors the original's level holds (a load removes some at random: OddsOfAppearing).
  const everything = wine('list', 'Actor').split('\n').map(line => /^\S+ (\S+) slot=(\d+) loc=\(([^)]*)\) .* odds=(\S+)/.exec(line)).filter(Boolean)
    .map(m => ({name: m[1], odds: Number(m[4]), slot: Number(m[2]), loc: m[3].split(',').map(Number)}));   // slot: the GObjObjects slot (the order a load made the actors in)
  // tagged too (population<tag>.json): the replay of one capture must not read another's while a second runs
  writeFileSync(path.join(dir, 'population.json'), JSON.stringify(everything));
  if (suffix) writeFileSync(path.join(dir, `population${suffix}.json`), JSON.stringify(everything));
  console.log(`${everything.length} actors in the original's level, ${everything.filter(e => e.odds < 1).length} with OddsOfAppearing < 1`);
  // A chance FlyGenerator (DeusExDecoration.PreBeginPlay, FRand() < 0.1 for each of the map's fly-making decorations, named in spawn order) passes the
  // name match whichever decoration made it: the ones whose name both loads hold at other places are reported (generatorsElsewhere in watch<tag>.json),
  // not reloaded for (two loads all but never pick the same decorations). Row 4.2.13 removes them in both programs instead (--early-cmds KillAll).
  const playedLocations = existsSync(path.join(dir, 'play-population.json')) ? JSON.parse(readFileSync(path.join(dir, 'play-population.json'), 'utf8')).locations ?? null : null;
  const elsewhere = playedLocations ? everything.filter(e => /^FlyGenerator\d+$/i.test(e.name) && playedLocations[e.name] && e.loc
    && Math.hypot(...e.loc.map((v, i) => v - playedLocations[e.name][i])) > 1).map(e => ({name: e.name, original: e.loc, play: playedLocations[e.name].map(v => +v.toFixed(1))})) : [];
  if (elsewhere.length) console.log(`POPULATION note: ${elsewhere.length} same-named FlyGenerators stand elsewhere in Play's load: ${elsewhere.map(e => `${e.name} (${e.original.map(Math.round)}) vs (${e.play.map(Math.round)})`).join(', ')}`);
  if (elsewhere.length) writeFileSync(watchPath, JSON.stringify({...JSON.parse(readFileSync(watchPath, 'utf8')), generatorsElsewhere: elsewhere}, null, 1));
  // The original's load decided some map actors by chance (FlyGenerator, OddsOfAppearing): Play's replay destroys the
  // ones only Play holds, but cannot create the ones only the original holds. Reload until it holds none (the
  // driver's exit code 3 asks for a retry); `--no-population-check` runs on regardless.
  const reference = path.join(dir, 'play-population.json');
  if (existsSync(reference) && !flag('no-population-check')) {
    const played = new Set(JSON.parse(readFileSync(reference, 'utf8')).names.map(name => name.toLowerCase()));
    const spawned = /^(Skill|Aug|NanoKey|ColorTheme|Shadow|ParticleProxy|Laser|Flare|Cigarettes|Candybar|Weapon|Mission|GameReplicationInfo|PlayerReplicationInfo|JCDenton|Mutator|DeusExGameInfo|PickupDistributor|AutoTurretGun|BarkManager|ParticleGenerator|DataVault|Credits|Ammo|BioelectricCell|Medkit|Binoculars|Lockpick|Multitool|LAM|Liquor|Soda|Sodacan|Fruit|Vice)/;
    const only = everything.filter(e => !played.has(e.name.toLowerCase()) && !spawned.test(e.name)).map(e => e.name);
    // The spawned names are exempt above because their numbers follow each process's creation order, but not their number: a load that spawned one more
    // ParticleGenerator, Medkit or Laser than Play's (or one fewer) holds an actor Play lacks that ticks and draws. The class-name families (the name
    // without its number) are counted on both sides; the player's own (the original keeps the first load's Shadow, NanoKeyRing and PickupDistributor
    // after a Player start, 1 more of each than Play's population probe) are the constant offsets of every map and are left out.
    const familyOf = name => name.replace(/\d+$/, '').toLowerCase();
    const count = names => { const m = new Map(); for (const name of names) m.set(familyOf(name), (m.get(familyOf(name)) ?? 0) + 1); return m; };
    const playedFamilies = count(JSON.parse(readFileSync(reference, 'utf8')).names), originalFamilies = count(everything.map(e => e.name));
    for (const family of new Set([...playedFamilies.keys(), ...originalFamilies.keys()])) {
      if (['shadow', 'nanokeyring', 'pickupdistributor'].includes(family)) continue;
      const difference = (originalFamilies.get(family) ?? 0) - (playedFamilies.get(family) ?? 0), listed = only.filter(name => familyOf(name) === family).length;
      if (difference > listed) only.push(`${family}(+${difference - listed})`);
      else if (difference < 0 && new RegExp(spawned.source, 'i').test(family)) only.push(`${family}(${difference})`);   // an exempt family Play holds more of (the others Play destroys)
    }
    // --allow-missing generators|all: go on when the actors only the original holds are all generators (a sweep: FlyGenerators and
    // the like are chosen by chance at each load and Play's seeded load cannot be made to hold the original's set); they leave the watch
    // list and the map's record (`notInPlay`). Any other actor missing in Play still asks for a reload (exit code 3).
    const tolerated = {generators: /Generator\d+$/, all: /./}[option('allow-missing', '')];
    if (only.length && tolerated && only.every(name => tolerated.test(name))) {
      const gone = new Set(only);
      console.log(`POPULATION tolerated: ${only.length} actors only the original holds are not watched: ${only.slice(0, 20).join(' ')}`);
      names = names.filter(name => !gone.has(name)); loadPawns = loadPawns.filter(name => !gone.has(name));
      const keptGenerators = generators.filter(name => !gone.has(name)), keptTimers = timers.filter(name => !gone.has(name));
      config = buildConfig(names, keptGenerators, keptTimers);
      writeFileSync(configPath, config.join('\n') + '\n');
      writeFileSync(watchPath, JSON.stringify({map, pawns: names.filter(name => !extras.includes(name)), extras, carcasses, generators: keptGenerators, timers: keptTimers, loadPawns, classes: classOf, notInPlay: only}, null, 1));
    } else if (only.length) { console.log(`POPULATION: the original holds ${only.length} actors Play's seed ${option('seed', 1)} load lacks: ${only.slice(0, 20).join(' ')}`); process.exitCode = 3; return; }
    else console.log('population: the original holds nothing Play lacks');
  }
  rmSync(`${tracePath}.resume`, {force: true});
  rmSync(`${tracePath}.go`, {force: true});
  rmSync(`${tracePath}.strobe`, {force: true});
  rmSync(`${tracePath}.ended`, {force: true});
  // --registry: the original's GObjObjects (rows, addresses and the free list GObjAvailable) at the frozen start, before the tracer
  // attaches, and again at the end while the level is held (registry-start/-end<tag>.txt; docs/object-index-captures.md "Runtime spawns").
  const registryDump = label => {
    if (!flag('registry')) return;
    const text = execFileSync(game.WINE, [path.join(root, 'ad/build/dump-gobjects-win.exe'), '--available'], {encoding: 'utf8', env: process.env, maxBuffer: 1 << 28});
    writeFileSync(path.join(dir, `registry-${label}${suffix}.txt`), text);
    console.log(`registry ${label}: ${text.split('\n').length - 2} rows, ${text.split('\n').find(line => line.startsWith('available=')) ?? 'no free list'}`.slice(0, 200));
  };
  // --dump-flags: the player's FlagBase (every flag: name, type, expiration, value) at the frozen start and at the end hold, to
  // flags-<start|end><tag>.txt (tools/dump-flags-win.c): the mission scripts' start state (PlayerTraveling and the mission flags).
  const flagsDump = label => {
    if (!flag('dump-flags')) return;
    const text = execFileSync(game.WINE, [path.join(root, 'ad/build/dump-flags-win.exe'), 'JCDentonMale'], {encoding: 'utf8', env: process.env, maxBuffer: 1 << 24});
    writeFileSync(path.join(dir, `flags-${label}${suffix}.txt`), text);
    console.log(`flags ${label}: ${text.split('\n').filter(line => /^\s+flag /.test(line)).length} flags; ${text.split('\n').filter(line => /FlagBase/.test(line)).join(' | ').slice(0, 300)}`);
  };
  flagsDump('start');
  registryDump('start');
  const child = spawn(game.WINE, [tool, 'trace', configPath], {env: process.env, stdio: ['ignore', 'pipe', 'pipe']});
  console.log('tracer pid', child.pid, `${names.length} pawns watched`);
  let log = '';
  child.stderr.on('data', chunk => { log += chunk; });
  const finished = new Promise(resolve => child.on('exit', resolve));
  const started = Date.now();
  const handled = new Set();
  // --wait-seconds s (default 600): how long the tracer may run (a long trace under the breakpoints is ~0.12 s a tick on the Mac, more when it is loaded).
  // The tracer ends on its own when the game leaves the level (tools/dx-live-win.c: UGameEngine::Tick's client travel, `<trace>.ended`): no pause then.
  while (!/paused after/.test(log) && child.exitCode === null && Date.now() - started < Number(option('wait-seconds', 600)) * 1000) {
    for (const match of log.matchAll(/^held after (\d+) unfrozen ticks/gm)) {
      const n = Number(match[1]);
      if (handled.has(n)) continue;
      handled.add(n);
      post(['sleep 300', ...cmds.filter(c => c.after === n && !ctrlShotName(c.text)).flatMap(c => keyEdge(c.text) ?? [`cmd ${c.text}`, 'sleep 500'])]);
      for (const c of cmds.filter(c => c.after === n && ctrlShotName(c.text))) takeCtrlShot(ctrlShotName(c.text));
      writeFileSync(`${tracePath}.go`, '');
      console.log(`typed after ${n} ticks: ${cmds.filter(c => c.after === n).map(c => c.text).join(' ; ')}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(log.trim());
  // The level's end (the Dying player's OPEN DXONLY, browsed at the next engine tick): the tracer wrote the unfrozen ticks the level ran to
  // <trace>.ended and detached; the game is on the next map, so there is no held level to dump or shoot.
  const ended = /^level ended after (\d+) unfrozen ticks/m.exec(log);
  if (ended) console.log(`the level ended after ${ended[1]} unfrozen ticks (${existsSync(`${tracePath}.ended`) ? 'stored' : 'NOT stored'}: ${path.relative(root, `${tracePath}.ended`)})`);
  if (/paused after/.test(log)) { registryDump('end'); flagsDump('end'); }
  if (option('shot', null) && /paused after/.test(log)) {
    // The level is held at the last replayed tick (the tracer returns from ULevel::Tick); the game still draws.
    // --fire-hold NAME,..: Fire.dll's ticks stopped first (`dx-live-win fire hold`: UFireTexture::ConstantTimeTick returns at once), so every
    // frame of the hold shows the same fire pixels, and those FireTextures' state read (`fire read`) into fire<tag>.json; Play's replay
    // (play --fire-hold) holds its own fires and writes those pixels into them before its frames (a measured host input, as the Strobe).
    if (option('fire-hold', null)) {
      console.log(wine('fire', 'hold').trim());
      execFileSync('sleep', ['0.5']);
      const fires = {};
      for (const name of option('fire-hold').split(',')) {
        const [head, pixels] = wine('fire', 'read', name).trim().split('\n');
        fires[name] = {...Object.fromEntries([...head.matchAll(/(\w+)=(\S+)/g)].map(m => [m[1], m[2]])), pixels: pixels.replace(/^pixels /, '')};
        console.log(`fire ${name}: ${head.slice(0, 160)}`);
      }
      writeFileSync(path.join(dir, `fire${suffix}.json`), JSON.stringify(fires));
    }
    let taken = null;
    // --shot-ctrl: the frame is the Ctrl+F9 one (a conversation window grabs the keys the plain `shot` presses), see --cmds @ctrlshot.
    if (flag('shot-ctrl')) { takeCtrlShot(option('shot')); taken = path.join(acceptanceDir(), `${option('shot')}-original.png`); }
    for (let attempt = 0; attempt < 3 && !taken; attempt++) {
      const before = game.shots();
      post(['sleep 1500', 'shot', 'sleep 900']);
      const fresh = game.shots().filter(shot => !before.includes(shot));
      if (fresh.length) {
        const png = path.join(acceptanceDir(), `${option('shot')}-original.png`), size = game.bmpToPng(path.join(game.SYSTEM, fresh[0]), png);
        renameSync(path.join(game.SYSTEM, fresh[0]), path.join(acceptanceDir(), `${option('shot')}-original.bmp`));
        if (size.width === 1280 && size.height === 720) taken = png;
      }
    }
    console.log(taken ? `frame: ${taken}` : 'NO FRAME of the original');
    // --extra-shots N: N more frames of the same held tick (<name>-original-2.png ...), a second or more apart: the original against itself, what
    // changes from frame to frame at a held level (a FireTexture ticks each drawn frame: the steam's puffs, docs/visual-acceptance.md) is its own floor.
    for (let k = 2; k <= 1 + Number(option('extra-shots', 0)); k++) {
      let extra = null;
      for (let attempt = 0; attempt < 3 && !extra; attempt++) {
        const before = game.shots();
        post(['sleep 1500', 'shot', 'sleep 900']);
        const fresh = game.shots().filter(shot => !before.includes(shot));
        if (fresh.length) {
          const png = path.join(acceptanceDir(), `${option('shot')}-original-${k}.png`), size = game.bmpToPng(path.join(game.SYSTEM, fresh[0]), png);
          renameSync(path.join(game.SYSTEM, fresh[0]), path.join(acceptanceDir(), `${option('shot')}-original-${k}.bmp`));
          if (size.width === 1280 && size.height === 720) extra = png;
        }
      }
      console.log(extra ? `frame ${k}: ${extra}` : `NO FRAME ${k} of the original`);
    }
    // Render.dll's Strobe flag and the TimeSeconds it last saw, as the held frames left them (the tracer writes them at every held Tick):
    // a host input of the frame, like the rand state (docs/visual-acceptance.md "Strobe").
    if (option('fire-hold', null)) console.log(wine('fire', 'release').trim());
    const strobePath = `${tracePath}.strobe`;
    if (existsSync(strobePath)) {
      const [flag, time] = readFileSync(strobePath, 'utf8').trim().split(/\s+/).map(Number);
      writeFileSync(path.join(dir, `hold${suffix}.json`), JSON.stringify({strobe: {flag, time}}));
      console.log(`strobe at the hold: flag ${flag}, time ${time}`);
    }
  }
  if (!flag('hold')) {
    writeFileSync(`${tracePath}.resume`, '');
    await finished;
    rmSync(`${tracePath}.resume`, {force: true});
    console.log('tracer finished');
    const crash = `${tracePath}.crash.txt`;
    if (existsSync(crash)) console.log('CRASH CAPTURED\n' + readFileSync(crash, 'utf8'));
  } else console.log(`level held by the tracer (pid ${child.pid}); create ${tracePath}.resume to resume`);
}

// --- Play -----------------------------------------------------------------
async function withPlay(body) {
  const {chromium} = await import('@playwright/test');
  const {createServer} = await import('vite');
  let server = null, url = option('url', null);
  if (!url) {
    const {default: base} = await import('../vite.config.mjs');
    const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && root.includes('/.work/'))
      && !(pattern.includes('.claude/worktrees') && root.includes('/.claude/worktrees/')));
    server = await createServer({...base, configFile: false, root, logLevel: 'error',
      server: {...base.server, port: 0, strictPort: false, fs: {...base.server.fs, deny}, watch: null}});
    await server.listen();
    url = server.resolvedUrls.local[0].replace(/\/$/, '');
  }
  const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 720}, deviceScaleFactor: 1});
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${url}/?hold=1&seed=${option('seed', 1)}${option('detail', 'off') === 'on' || /detailTextures=/.test(option('page-params', '') ?? '') ? '' : '&detailTextures=0'}${option('script-vm', null) ? `&scriptVm=${option('script-vm')}` : ''}${option('page-params', null) ? `&${option('page-params')}` : ''}`);   // --page-params 'pawnPhysics=js&walkLoopKernel=js&movePawnKernel=js': the JavaScript twins (the walk trace)
    await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
    if (await page.evaluate(() => window.deusExViewer.status().map) !== map) {
      await page.locator('#map').selectOption(map);
      await page.waitForFunction(m => { const s = window.deusExViewer?.status(); return s?.ready && s.map === m; }, map, {timeout: 300000});
    }
    const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
    // The frozen start of the original's capture: bPlayersOnly from the first tick, then ghost / ShowHud False.
    await page.evaluate(() => window.deusExViewer.viewProbe({playersOnly: true, timeDilation: 1}));
    await page.evaluate(() => window.deusExViewer.release());
    await frames(10);
    // --no-ghost: a normal, visible player standing at the map's start (the perception pilot): only the HUD is hidden, as the capture does.
    const ghost = await page.evaluate(noGhost => window.deusExViewer.viewProbe(noGhost ? {exec: ['ShowHud False']} : {ghost: true}), flag('no-ghost'));
    await frames(5);
    await body({page, frames, errors, ghost});
    await page.close();
  } finally { await browser.close(); await server?.close(); }
}

// snap --at x,y,z [--pitch p --yaw y]: a Play frame from that place, to choose a camera.
async function snap() {
  const location = option('at', null)?.split(',').map(Number) ?? null;
  const rotation = [Number(option('pitch', 0)), Number(option('yaw', 0)), 0];
  await withPlay(async ({page, frames}) => {
    await page.addStyleTag({content: `.toolbar, footer, #toast, #play-hint, #npc-preview-label, #panel, #crosshair, #gate { display: none !important; }
#app { height: 100vh !important; } #viewport { position: fixed !important; inset: 0 !important; width: 1280px; height: 720px; }
#scene { position: fixed !important; left: 0 !important; top: 0 !important; margin: 0 !important; border: 0 !important; transform: none !important; width: 1280px !important; height: 720px !important; }`});
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.evaluate(() => { const el = document.getElementById('brightness'); el.value = '0.4'; el.dispatchEvent(new Event('input')); });
    // --exec "line|line": console commands typed first (Play only, a way to choose the camera a --cmds line gives: `CheatView DeusEx.Businessman`);
    // --run-frames N: the level is released (bPlayersOnly False) and runs N page frames before the shot, so what a view shows is live.
    let region = null;
    if (location) {
      region = (await page.evaluate(at => window.deusExViewer.liveProbe({pointRegion: at}), location)).pointRegion;  // Play only: a camera for looking
      await page.evaluate(([at, rot, reg]) => window.deusExViewer.viewProbe({location: at, rotation: rot, region: {zone: reg.zone, iLeaf: reg.iLeaf, zoneNumber: reg.zoneNumber}}), [location, rotation, region]);
    }
    const exec = option('exec', '').split('|').filter(Boolean);
    if (exec.length) console.log(JSON.stringify((await page.evaluate(lines => window.deusExViewer.viewProbe({exec: lines}), exec)).output));
    if (option('run-frames', null)) await page.evaluate(() => window.deusExViewer.viewProbe({playersOnly: false}));
    await frames(Number(option('run-frames', 45)));
    // --after-file js: an expression the page evaluates before the shot (a probe that changes what is drawn)
    if (option('after-file', null)) { console.log(JSON.stringify(await page.evaluate(readFileSync(option('after-file'), 'utf8')))); await frames(8); }
    const file = path.join(dir, option('name', 'snap.png'));
    await page.screenshot({path: file, clip: {x: 0, y: 0, width: 1280, height: 720}});
    console.log(file, JSON.stringify(region));
  });
}

// population: which OddsOfAppearing < 1 actors Play's seeded load keeps (compared with the original's before a trace).
async function population() {
  await withPlay(async ({page}) => {
    const {actors} = await page.evaluate(() => window.deusExViewer.liveProbe({actors: 'engine.actor'}));
    // locations: where each actor of the seeded load stands (a chance FlyGenerator's name says nothing about which decoration made it)
    writeFileSync(path.join(dir, 'play-population.json'), JSON.stringify({seed: Number(option('seed', 1)), names: actors.map(a => a.name), timers: actors.filter(a => a.timer).map(a => a.name),
      locations: Object.fromEntries(actors.map(a => [a.name, a.location]))}));
    console.log(map, `seed ${option('seed', 1)}:`, actors.length, 'actors');
  });
}

// screen --maps a,b,..: Play's own run of each map from its start pose (the player standing, no input) with the view turned
// through four yaws, and per view the pawns Play rendered within the last half second that are not in stasis and animate (a
// census of LastRenderTime, bStasis, AnimRate). It picks the maps worth a run of the original (the original's own
// LastRenderTime/bStasis from a short trace decide). Output: .work/live-acceptance/screen.json.
async function screen() {
  const maps = option('maps', '').split(',').filter(Boolean);
  const {chromium} = await import('@playwright/test');
  const {createServer} = await import('vite');
  const {default: base} = await import('../vite.config.mjs');
  const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && root.includes('/.work/')) && !(pattern.includes('.claude/worktrees') && root.includes('/.claude/worktrees/')));
  const server = await createServer({...base, configFile: false, root, logLevel: 'error', server: {...base.server, port: 0, strictPort: false, fs: {...base.server.fs, deny}, watch: null}});
  await server.listen();
  const url = server.resolvedUrls.local[0].replace(/\/$/, '');
  const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
  const file = path.join(root, '.work/live-acceptance/screen.json');
  const result = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  try {
    for (const name of maps) {
      const page = await browser.newPage({viewport: {width: 1280, height: 720}, deviceScaleFactor: 1});
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto(`${url}/?seed=1`);
        await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
        if (await page.evaluate(() => window.deusExViewer.status().map) !== name) {
          await page.locator('#map').selectOption(name);
          await page.waitForFunction(m => { const s = window.deusExViewer?.status(); return s?.ready && s.map === m; }, name, {timeout: 300000});
        }
        const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
        await frames(120);
        const start = await page.evaluate(() => window.deusExViewer.viewProbe({}));
        const views = [];
        for (let k = 0; k < 4; k++) {
          const yaw = ((start.viewRotation[1] + 16384 * k) % 65536 + 65536) % 65536;
          if (k) await page.evaluate(r => window.deusExViewer.viewProbe({rotation: r}), [0, yaw, 0]);
          await frames(k ? 150 : 60);
          const {census} = await page.evaluate(() => window.deusExViewer.liveProbe({census: true}));
          const seen = census.pawns.filter(p => !p.hidden && census.time - p.lrt < 0.5 && p.lrt > 0);
          const active = seen.filter(p => !p.stasis);
          views.push({yaw, rendered: seen.length, notStasis: active.length, animating: active.filter(p => p.rate > 0).length,
            names: active.map(p => `${p.name}:${p.anim}:${p.state}`).slice(0, 12), pawns: census.pawns.length,
            // rendered pawns (InStasis is false while LastRenderTime is recent, whatever bStasis says)
            seen: seen.map(p => `${p.name}:${p.anim}:${p.state}:rate ${Number(p.rate).toFixed(2)}:${Math.round(p.dist)}`)});
        }
        result[name] = {start: start.location, startYaw: start.viewRotation[1], views, errors: errors.slice(0, 2)};
        const best = views.reduce((a, b) => b.rendered > a.rendered ? b : a);
        console.log(name.padEnd(30), `pawns ${views[0].pawns}`, `best yaw ${best.yaw}: rendered ${best.rendered}: ${best.seen.join(' ')}`);
      } catch (error) { result[name] = {error: String(error.message).slice(0, 200)}; console.log(name.padEnd(30), 'ERROR', result[name].error); }
      await page.close();
      writeFileSync(file, JSON.stringify(result, null, 1));
    }
  } finally { await browser.close(); await server.close(); }
}

// sweep --yaw-base N --pawns A,B [--step 15]: Play's side of `original --sweep`: the same views, the same pawns' staleness of LastRenderTime.
async function sweep() {
  const base = Number(option('yaw-base')), stepDeg = Number(option('step', 15)), pawns = option('pawns', '').split(',').filter(Boolean);
  await withPlay(async ({page, frames}) => {
    const results = [];
    for (let deg = 0; deg < 360; deg += stepDeg) {
      const yaw = ((base + Math.round(deg / 360 * 65536)) % 65536 + 65536) % 65536;
      await page.evaluate(r => window.deusExViewer.viewProbe({rotation: r}), [0, yaw, 0]);
      const t0 = (await page.evaluate(() => window.deusExViewer.liveProbe({census: true}))).census.time;
      let census;
      do { await frames(15); census = (await page.evaluate(() => window.deusExViewer.liveProbe({census: true}))).census; } while (census.time - t0 < 1.5);
      const row = {deg, yaw, pawns: {}};
      for (const name of pawns) { const p = census.pawns.find(q => q.name === name); if (p) row.pawns[name] = {stale: +(census.time - p.lrt).toFixed(3), lrt: p.lrt}; }
      results.push(row);
      console.log(deg, yaw, Object.entries(row.pawns).map(([n, v]) => `${n}:${v.stale < 0.5 ? 'R' : '.'}`).join(' '));
    }
    writeFileSync(path.join(dir, 'sweep-play.json'), JSON.stringify({map, base, results}, null, 1));
  });
}

// eval --expr 'js': the expression in the page after the map's frozen start (a quick look at Play's state: window.deusExViewer.status().notes, ...).
// read --names A,B --props P,Q [--run-frames N]: those properties of those actors in Play's frozen start (liveProbe `read`); with --run-frames the
// level is released and runs N page frames first. Prints JSON. Play only: what an actor holds (its Weapon, bHidden) when a frame shows something else.
async function readActors() {
  const names = option('names', '').split(',').filter(Boolean), props = option('props', '').split(',').filter(Boolean);
  await withPlay(async ({page, frames}) => {
    if (option('run-frames', null)) { await page.evaluate(() => window.deusExViewer.viewProbe({playersOnly: false})); await frames(Number(option('run-frames'))); }
    // --offsets: the linked offsets (and bool masks) of those properties instead of their values, for tools/dump-actor-win.c
    if (flag('offsets')) { console.log(JSON.stringify((await page.evaluate(args => window.deusExViewer.liveProbe({offsets: Object.fromEntries(args.names.map(name => [name, args.props])), offsetMasks: true}), {names, props})).offsets, null, 1)); return; }
    const result = await page.evaluate(args => window.deusExViewer.liveProbe({read: args}), {names, props}); console.log(JSON.stringify(result?.read ?? result, null, 1));
  });
}

async function evaluate() {
  // --expr "js" or --expr-file path (a longer script: an async function the page awaits)
  const expression = option('expr-file', null) ? readFileSync(option('expr-file'), 'utf8') : option('expr');
  await withPlay(async ({page, frames}) => { await frames(30); console.log(JSON.stringify(await page.evaluate(expression), null, 1)); });
}

async function play() {
  // --ticks N replays only the first N unfrozen ticks; --nav-trace A,B [--nav-ticks first:last] also records those pawns'
  // reach and path natives' boundary calls (src/runtime/nav-trace.mjs) to nav-play<-tag>.json, to compare with the original's
  // (tools/dx-live-win.c `call`, original --extra-config).
  const limit = Number(option('ticks', 0)) || undefined;
  const traceRows = readFileSync(tracePath, 'utf8').trim().split('\n').map(parseTraceLine);   // parsed once: a long trace is large
  const trace = traceRows.filter(row => row.unfrozen >= 1).slice(0, limit);
  // The window system's wall-clock deltas (Extension RootTick 0x1003be90, the tracer's `roottick` call records: args[0] is the f32 TickWindows
  // passes every root), a measured input like the stream state: the frames the original ran after unfrozen tick k-1, held frames included, tick
  // the windows before level tick k (game.mjs tick). Tick 1 takes the last frame of the frozen phase only (Play's warm-up has run its own).
  const rootTicks = new Map();
  if (existsSync(`${tracePath}.calls.jsonl`)) for (const line of readFileSync(`${tracePath}.calls.jsonl`, 'utf8').split('\n')) {
    if (!line.includes('"fn":"roottick"') || !line.includes('"ev":"enter"')) continue;
    const r = parseTraceLine(line);
    if (!rootTicks.has(r.u)) rootTicks.set(r.u, []);
    rootTicks.get(r.u).push({seq: r.seq, delta: r.floats[0]});
  }
  // A held tick's frames are split at its commands (commandsWithStream): the frames before a command's InputEvent record run before the command,
  // the ones after the hold's last command before the next level tick. holdCuts: unfrozen tick -> the call sequence number of its last command's record.
  const holdCuts = new Map();
  const windowDeltas = unfrozen => {
    const frames = rootTicks.get(unfrozen - 1);
    if (!frames?.length) return {};
    const cut = holdCuts.get(unfrozen - 1) ?? -Infinity, list = frames.filter(f => f.seq > cut).map(f => f.delta);
    return {windowSeconds: unfrozen === 1 ? list.slice(-1) : list};
  };
  const {pawns, extras = [], carcasses = [], generators = [], timers = [], loadPawns = []} = JSON.parse(readFileSync(watchPath, 'utf8'));
  // Play is placed where the original's player stood when the replay begins: the last frozen tick's exit.
  const frozen = traceRows.filter(row => row.unfrozen === 0);
  const pose = frozen[frozen.length - 1].actors['@player'];
  await withPlay(async ({page, frames, errors, ghost}) => {
    // The ghost's own script starts its flying animation (the Tread loop) in the first player ticks after `ghost`, and the request below writes
    // only the original's sequence, frame, rate and tween: AnimLast, OldAnimRate, bAnimLoop and bAnimNotify stay the ones the animation that
    // was running when the replay began had. The page's frames before it are not ticks (the worker merges posts), so on a slow run the idle
    // sequence (BreatheLight: no notifies, bAnimNotify 0) was still running, the Tread loop never ran its PlayFootStep notifies (one FRand each)
    // and the replay's draw count was one short from tick 45 (Underworld; Battery Park tick 10). Wait until the player runs the pose's sequence.
    // --early-cmds: the console lines the original was typed in its frozen phase (a camera that follows an actor, a placement), run first through the same
    // chain, as the original ran them before its frozen frames: a placement's `walk` (PlayerPawn.StartWalk: ClientReStart, PlayWaiting) restarts the idle
    // animation, and run after the pose's write it left the player's BreatheLight 0.0125 behind the original's for 90 ticks (Stage 5 capture cmb1, 2026-10-17).
    if (earlyCommands().length) console.log('early commands:', JSON.stringify((await page.evaluate(lines => window.deusExViewer.viewProbe({exec: lines}), earlyCommands())).output));
    let running = null;
    const same = () => String(running).toLowerCase() === String(pose.Anim).toLowerCase();
    for (let k = 0; k < 300 && !same(); k++) {
      running = (await page.evaluate(() => window.deusExViewer.liveProbe({read: {names: ['@player'], props: ['AnimSequence']}}))).read?.['@player']?.AnimSequence ?? null;
      if (!same()) await frames(2);
    }
    if (!same()) console.log(`the player's animation is ${running}, the original's ${pose.Anim}: its flags are the former's`);
    // The original's pose, exactly (the frozen-phase history of the ghost differs: its landing, its Tread loop).
    await page.evaluate(a => window.deusExViewer.viewProbe({location: a.Loc, rotation: a.VRot, rehash: a.rehash,
      region: {zone: a.RegZone, iLeaf: a.RegLeaf, zoneNumber: a.RegNum}}), {...pose, rehash: flag('ghost-in-hash')});
    // A player placed at the original's pose (a no-ghost player, or a ghost put on its feet by `walk`) is not standing yet: it stands in the Physics its login or
    // `walk` left it (falling), and settles in a few ticks (a fall, the landing, a lift to the rest height: Manderley's `set Location` 0.17 below its rest height 287.8
    // fell 2 units and came back in five ticks). The original's stood in a frozen phase of tens of seconds (the intro: Physics 1, Velocity 0, Z -80.2). The frozen
    // level (bPlayersOnly) is ticked until the player is in the pose's Physics, at its Location, at rest. A replay that began before it (the page's frames are not
    // ticks when the worker is busy) read the player's Z a few hundredths off at tick 1 and every pawn's DistanceFromPlayer with it.
    if ((flag('no-ghost') || pose.Phys === 1) && pose.Phys !== undefined) {
      const stand = async () => (await page.evaluate(() => window.deusExViewer.liveProbe({read: {names: ['@player'], props: ['Physics', 'Location', 'Velocity', 'Base']}}))).read?.['@player'];
      let now = await stand(), waited = 0;
      // landed and at rest where the original's stood (the landing is a few frozen ticks and a tick's delta is the host's frame time, so the first
      // tick in the pose's Physics can still be moving to its rest height)
      const rested = () => now?.Physics === pose.Phys && now.Location.every((v, i) => Math.abs(v - pose.Loc[i]) < 1e-3) && now.Velocity.every(v => v === 0);
      // settled in the pose's Physics: the rest height after a landing is the frozen phase's own outcome (its frames' deltas are the host's: the
      // original under CrossOver rested MeetPaul's ghost at Z -256.2948 where Play and the Linux host's capture rest at -256.2, 2026-10-17), so a
      // player settled elsewhere is put at the original's pose, a measured input like the pose itself
      const settled = () => now?.Physics === pose.Phys && now.Velocity.every(v => v === 0);
      for (; waited < 240 && !rested(); waited += 2) { await frames(2); now = await stand(); if (settled() && !rested() && waited >= 20) break; }
      if (settled() && !rested()) {
        console.log(`the player rests at ${JSON.stringify(now.Location)}, the original's at ${JSON.stringify(pose.Loc)}: placed at the original's`);
        await page.evaluate(a => window.deusExViewer.viewProbe({location: a.Loc, rotation: a.VRot, region: {zone: a.RegZone, iLeaf: a.RegLeaf, zoneNumber: a.RegNum}}), pose);
        await frames(4); now = await stand();
      }
      console.log(`the player after ${waited} frames: Physics ${now?.Physics} (the original's ${pose.Phys}), Location ${JSON.stringify(now?.Location)}, Velocity ${JSON.stringify(now?.Velocity)}, Base ${now?.Base?.name ?? now?.Base}`);
    }
    // A trace without the player's AnimLast and loop bits (before 2026-10-17): the original's player stood for its whole frozen phase, so it runs the pose's sequence
    // as a playing loop (frame and rate positive); Play's placement may have landed it (PlayLanded, then TweenToWaiting: the same sequence name, AnimLast 0, no loop).
    // The frozen level is ticked until the player runs that loop, so the flags the write below leaves are the loop's.
    if (pose.ALast === undefined && pose.Frame >= 0 && pose.Rate > 0) {
      const anim = async () => (await page.evaluate(() => window.deusExViewer.liveProbe({read: {names: ['@player'], props: ['AnimSequence', 'AnimFrame', 'AnimLast', 'bAnimLoop']}}))).read?.['@player'];
      let now = await anim(), waited = 0;
      const looping = () => String(now?.AnimSequence).toLowerCase() === String(pose.Anim).toLowerCase() && now.AnimFrame >= 0 && now.AnimLast > 0 && now.bAnimLoop;
      for (; waited < 240 && !looping(); waited += 2) { await frames(2); now = await anim(); }
      console.log(`the player's animation after ${waited} frames: ${JSON.stringify(now)}${looping() ? '' : ` (not the original's running ${pose.Anim} loop)`}`);
    }
    const populationFile = [`population${suffix}.json`, 'population.json'].map(name => path.join(dir, name)).find(existsSync);
    const population = populationFile ? JSON.parse(readFileSync(populationFile, 'utf8')) : null;
    if (population) {
      const result = (await page.evaluate(names => window.deusExViewer.liveProbe({population: names}), population)).population;
      console.log(`population: ${result.removed.length} actors only Play had destroyed (${result.removed.slice(0, 12).join(' ')}${result.removed.length > 12 ? ' ...' : ''}); ${result.missing.length} only the original has (${result.missing.slice(0, 12).join(' ')})`);
      writeFileSync(path.join(dir, `population-result${suffix}.json`), JSON.stringify(result));
    }
    // the generators watched on Play's side: the original's that Play's level holds (the population step cannot make one only the original has)
    const missing = new Set((population ? JSON.parse(readFileSync(path.join(dir, `population-result${suffix}.json`), 'utf8')).missing : []).map(name => name.toLowerCase()));
    const watchedGenerators = generators.filter(name => !missing.has(name.toLowerCase()));
    // The original's `open` leaves the player's FlagBase empty (--dump-flags, tools/dump-flags-win.c); Play's login supplies the fresh-mission marker
    // PlayerTraveling, which makes the mission script's first Timer run FirstFrame (flags, startup text, NPCs entering the world). The replay takes
    // the original's start: the flag is deleted (the original's DeleteFlag native). --keep-traveling keeps Play's own.
    {
      const flags = (await page.evaluate(remove => window.deusExViewer.liveProbe({flags: {delete: remove ? [] : ['PlayerTraveling']}}), flag('keep-traveling'))).flags;
      writeFileSync(path.join(dir, `flags-play-start${suffix}.json`), JSON.stringify(flags));
      console.log(`flags at the start: Play ${flags.entries.length}${flags.entries.length ? ` (${flags.entries.map(e => e.name).join(' ')})` : ''}`);
    }
    await frames(5);
    // The page as a 1280x720 frame at the brightness whose display ramp is the identity (the held frame's, and --base-shot's).
    let prepared = false;
    const preparePage = async () => {
      if (prepared) return; prepared = true;
      await page.addStyleTag({content: `.toolbar, footer, #toast, #play-hint, #npc-preview-label, #panel, #crosshair, #gate { display: none !important; }
#app { height: 100vh !important; } #viewport { position: fixed !important; inset: 0 !important; width: 1280px; height: 720px; }
#scene { position: fixed !important; left: 0 !important; top: 0 !important; margin: 0 !important; border: 0 !important; transform: none !important; width: 1280px !important; height: 720px !important; }`});
      await page.evaluate(() => window.dispatchEvent(new Event('resize')));
      await page.evaluate(value => { const el = document.getElementById('brightness'); el.value = value; el.dispatchEvent(new Event('input')); }, option('brightness', '0.4'));
    };
    // --base-shot (play, with --shot name): the frozen start's frame at the same camera, before the first tick (<name>-play-base.png): the frame
    // without the particles and sprites the ticks make, the base of `visual-acceptance.mjs compare --contribution` (the original's is <name>-base-original.png).
    if (flag('base-shot') && option('shot', null)) {
      await preparePage(); await frames(30);
      await page.screenshot({path: path.join(acceptanceDir(), `${option('shot')}-play-base.png`), clip: {x: 0, y: 0, width: 1280, height: 720}});
    }
    const props = [...new Set([...FIELDS.map(f => f[1]), ...(option('extra-props', '') ?? '').split(',').filter(Boolean)])], playerProps = [...new Set([...PLAYER_FIELDS.map(f => f[1]), ...(option('extra-props', '') ?? '').split(',').filter(Boolean)])];
    // the player's animation too, in the call that arms the replay: no frozen tick runs between (a looping ghost
    // animation reaching its end can call script that draws)
    const setupNames = option('setup-probe', null), [setupFirst, setupLast] = option('setup-ticks', `1:${trace.length}`).split(':').map(Number);   // Setup's result for those actors (setup-play.json)
    const scriptPawns = option('script-trace', null), [scriptFirst, scriptLast] = option('script-ticks', `1:${trace.length}`).split(':').map(Number);
    const eventWindow = option('event-trace', null)?.split(':').map(Number);   // --event-trace first:last: every AI event manager call and delivered callback of those ticks (events-play<tag>.json)
    // --object-trace first:last: the slot model started from the original's registry at the frozen start (registry-start<tag>.txt, `original --registry`)
    // and every object it takes or gives back and every Galaxy PlaySound call of those ticks (objects-play<tag>.json, sounds-play<tag>.json).
    const objectWindow = option('object-trace', null)?.split(':').map(Number);
    const registrySeed = () => {
      const file = path.join(dir, `registry-start${suffix}.txt`);
      if (!existsSync(file)) return null;
      const text = readFileSync(file, 'utf8').replace(/\r/g, '');
      const count = Number(/objects=(\d+)/.exec(text.split('\n', 1)[0])?.[1]), free = /^available=\d+:(.*)$/m.exec(text)?.[1].trim();
      // The pre-placed actors' indices in THIS run (a process's registry depends on everything it loaded: another session's table is
      // off by thousands): the unique Class.Name rows of the dump whose name Play's population holds, and the live player (the
      // JCDentonMale created last).
      const names = new Set((existsSync(path.join(dir, 'play-population.json')) ? JSON.parse(readFileSync(path.join(dir, 'play-population.json'), 'utf8')).names : []));
      const rowsByKey = new Map();
      let player = null;
      const packages = [];   // the Package objects the original holds at the start
      for (const line of text.split(/\r?\n/)) {
        const m = /^slot\s+\d+\s+index\s+(\d+)\s+ptr 0x\w+\s+(\S+?)\.(\S+)$/.exec(line);
        if (!m) continue;
        const key = `${m[2]}.${m[3]}`;
        if (names.has(m[3])) rowsByKey.set(key, rowsByKey.has(key) ? null : Number(m[1]));
        if (m[2] === 'JCDentonMale' && (!player || Number(m[1]) > player.index)) player = {key, index: Number(m[1])};
        if (m[2] === 'Package') packages.push(m[3]);
      }
      // Objects that existed at the frozen start and that the original frees during the replay (the sender event the player's landing left
      // in the manager, ...): Play does not hold them, and their slots come back in the order the original freed them, so the free list
      // would differ. They are replayed as a measured input (UnhashObject at the tick, `preFrees`), as the CRT state and the clocks are.
      const callsFile = `${tracePath}.calls.jsonl`, preFrees = [];
      if (existsSync(callsFile)) {
        const born = new Set();
        for (const line of readFileSync(callsFile, 'utf8').split('\n')) {
          if (!line.includes('"ev":"ret"') || !(line.includes('"fn":"addobj"') || line.includes('"fn":"unhash"'))) continue;
          const r = parseTraceLine(line);
          if (r.fn === 'addobj') born.add(r.ecxIndex);
          else if (born.has(r.ecxIndex)) born.delete(r.ecxIndex);
          else preFrees.push({u: r.u, index: r.ecxIndex, cls: r.ecxClass, name: r.ecxName});
        }
      }
      return {count, freeIndices: free ? free.split(/\s+/).map(Number) : [], preFrees, packages,
        measured: Object.fromEntries([...rowsByKey].filter(([, index]) => index !== null)), player};
    };
    const touchWindow = option('touch-trace', null)?.split(':').map(Number);   // --touch-trace first:last: EndTouch/AddTouch/BeginTouch of those ticks (touch-play.json)
    const navPawns = option('nav-trace', null), [navFirst, navLast] = option('nav-ticks', `1:${trace.length}`).split(':').map(Number);
    // The generators' load-time draws (GENERATOR_FIELDS), as the original's frozen phase left them.
    // The commands typed between two ticks run on a stream state the replay cannot derive (the level is held while the game draws frames, 256 draws
    // each: docs/visual-acceptance.md "What the original does with the random stream"). The tracer's `call` breakpoint at UEngine::InputEvent
    // (0x103814e0, label `inputevent`, config events.cfg) carries the CRT state at each key edge, the start of a key-edge command: its `rng` is a
    // measured input handed to Play with that command (the n-th `@down`/`@up` of a hold takes the n-th press/release record of that hold).
    const commandsWithStream = () => {
      // (an `@ctrlshot NAME` is the original's screenshot of a held tick: it changes no state, so the replay skips it)
      const list = (existsSync(path.join(dir, `commands${suffix}.json`)) ? JSON.parse(readFileSync(path.join(dir, `commands${suffix}.json`), 'utf8')) : []).filter(c => !/^@ctrlshot /.test(c.text));
      const callsFile = `${tracePath}.calls.jsonl`;
      if (!existsSync(callsFile)) return list;
      const edges = new Map();
      for (const line of readFileSync(callsFile, 'utf8').split('\n')) {
        if (!line.includes('"fn":"inputevent"') || !line.includes('"ev":"enter"')) continue;
        const r = parseTraceLine(line), action = parseInt(r.args[2], 16);
        if (r.inTick !== 0 || (action !== 1 && action !== 3)) continue;
        if (!edges.has(r.u)) edges.set(r.u, []);
        edges.get(r.u).push({key: parseInt(r.args[1], 16), action, rng: r.rng, seq: r.seq});
      }
      // A hold's records are taken in order. A typed console line is the console key (T), Backspaces, the characters (not press/release
      // events) and Enter: the console's KeyEvent runs the line inside Enter's InputEvent, so the line takes the next Enter press's state
      // (2026-10-17: a summon typed in a hold drew the summoned pawn's spawn-time FRand from another state, docs/weapon-attachment.md). A key
      // edge takes the next record of its key and action (EInputKey: the virtual-key codes of the keys --cmds names; any key if unknown).
      const KEYS = {Enter: 0x0d, PageDown: 0x22, PageUp: 0x21, Escape: 0x1b, Space: 0x20, Tab: 0x09, End: 0x23, Home: 0x24, ArrowLeft: 0x25, ArrowUp: 0x26,
        ArrowRight: 0x27, ArrowDown: 0x28, ShiftLeft: 0x10, ControlLeft: 0x11};
      const keyCode = code => KEYS[code] ?? (/^Key([A-Z])$/.exec(code)?.[1].charCodeAt(0)) ?? (/^Digit(\d)$/.exec(code) ? 0x30 + Number(code.slice(5)) : null);
      // The window frames the original ran in the hold before that record (the `roottick` records of the hold with a smaller call sequence number) tick
      // the windows before the command runs; the rest of the hold's frames tick them before the next level tick (windowDeltas, holdCuts). A window the
      // command creates gets only the frames after it: cmb2's bark subtitle (HUDBarkDisplayItem, created inside the Enter press's InputEvent at tick 660,
      // after 25 of the hold's 31 frames) got all 1.736 s of the hold in Play and was freed 11 ticks early (docs/stage-5-exit-criteria.md). The frozen
      // phase (after 0) is Play's own warm-up and is not split.
      const cursor = new Map();
      return list.map(command => {
        const m = /^@(down|up) (\S+)$/.exec(command.text), records = edges.get(command.after) ?? [], from = cursor.get(command.after) ?? 0;
        const action = m && m[1] === 'up' ? 3 : 1, key = m ? keyCode(m[2]) : 0x0d;
        const at = records.findIndex((e, i) => i >= from && e.action === action && (key === null || e.key === key));
        if (at < 0) return command;
        cursor.set(command.after, at + 1);
        if (command.after < 1) return {...command, rng: records[at].rng};
        const seq = records[at].seq, previous = holdCuts.get(command.after) ?? -Infinity;
        holdCuts.set(command.after, seq);
        return {...command, rng: records[at].rng, windowSeconds: (rootTicks.get(command.after) ?? []).filter(f => f.seq > previous && f.seq < seq).map(f => f.delta)};
      });
    };
    const commands = commandsWithStream();   // before the ticks' window frames (windowDeltas reads holdCuts)
    // (--render-history: their LastRenderTime too, when the trace has it; the generators are in Play's level: a name only the original holds is not written)
    const generatorLoad = [...GENERATOR_LOAD_FIELDS, ...(flag('render-history') ? GENERATOR_FIELDS.filter(f => f[0] === 'LRT') : [])];
    const generatorWrites = Object.fromEntries(watchedGenerators.filter(name => frozen[frozen.length - 1].actors[name])
      .map(name => [name, Object.fromEntries(generatorLoad.filter(([label]) => frozen[frozen.length - 1].actors[name][label] !== undefined)
        .map(([label, prop]) => [prop, frozen[frozen.length - 1].actors[name][label]]))]));
    const lastFrozen = frozen[frozen.length - 1].actors;
    // --no-pawn-load / --no-timer-load: diagnostics, a replay without the pawns' (SightCounter, TimerRate, TimerCounter) or the timed actors' load-time inputs.
    const pawnWrites = flag('no-pawn-load') ? {} : Object.fromEntries([...pawns, ...loadPawns].filter(name => lastFrozen[name] && renderHistoryFields().every(label => lastFrozen[name][label] !== undefined))
      .map(name => [name, Object.fromEntries(renderHistoryFields().map(label => [FIELDS.find(f => f[0] === label)[1], lastFrozen[name][label]]))]));
    const timerWrites = flag('no-timer-load') ? {} : Object.fromEntries(timers.filter(name => lastFrozen[name]?.TRate !== undefined).map(name => [name, {TimerRate: lastFrozen[name].TRate, TimerCounter: lastFrozen[name].TCount}]));
    // The original's class counters (UClass+0x488: MakeUniqueObjectName's suffix, docs/script-construction.md "Spawned names against the original")
    // carry the capture's whole session (the maps it loaded before this one): a measured input like the stream state. A class's first traced
    // AddObject (the `addobj` call records' name and class at the return) gives its counter; --own-names keeps Play's own.
    const classCounters = (() => {
      const file = `${tracePath}.calls.jsonl`;
      if (flag('own-names') || !existsSync(file)) return null;
      const counters = {};
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.includes('"fn":"addobj"') || !line.includes('"ecxName"')) continue;
        const r = parseTraceLine(line), cls = r.ecxClass, name = String(r.ecxName ?? '');
        if (!cls || counters[cls] !== undefined) continue;
        const prefix = cls.replace(/[0-9]+$/, ''), m = name.toLowerCase().startsWith(prefix.toLowerCase()) ? /^(\d+)$/.exec(name.slice(prefix.length)) : null;
        if (m) counters[cls] = Number(m[1]);
      }
      return Object.keys(counters).length ? counters : null;
    })();
    if (classCounters) console.log(`class counters from the original's traced names: ${Object.keys(classCounters).length} classes`);
    // ULevel::TickTag during the first replayed tick: the opposite of the player's bTicked at the last frozen tick (the trace's), or --tick-tag 0|1
    // for a trace without it; otherwise Play keeps its own parity.
    const tickTag = () => option('tick-tag', null) !== null ? Number(option('tick-tag')) : pose.Ticked === undefined ? null : 1 - Number(Boolean(pose.Ticked));
    // the rest of the animation state when the trace has it (PLAYER_FIELDS: captures from 2026-10-17 on)
    const animState = pose.ALast === undefined ? {} : {AnimLast: pose.ALast, AnimMinRate: pose.AMin, OldAnimRate: pose.AOld,
      bAnimFinished: Boolean(pose.AnimFin), bAnimLoop: Boolean(pose.AnimLoop), bAnimNotify: Boolean(pose.AnimNote)};
    const request = {...(classCounters ? {classCounters} : {}), write: {...timerWrites, ...pawnWrites, '@player': {AnimSequence: pose.Anim, AnimFrame: pose.Frame, AnimRate: pose.Rate, TweenRate: pose.Tween, ...animState, ...(option('player-alliance', null) ? {Alliance: option('player-alliance')} : {}),
      // FrobTime accumulates the player's tick deltas (HighlightCenterObject runs when it reaches 0.1 s); the frozen phase's deltas are the host's, so the original's value is a measured input
      ...(flag('player-gear') && pose.FrobTime !== undefined ? {FrobTime: pose.FrobTime} : {})}, ...generatorWrites},
      ...(touchWindow ? {touchTrace: {first: touchWindow[0], last: touchWindow[1]}} : {}),
      ...(eventWindow ? {eventTrace: {first: eventWindow[0], last: eventWindow[1]}} : {}),
      ...(objectWindow ? {objectTrace: {first: objectWindow[0], last: objectWindow[1], seed: registrySeed()}} : {}),
      ...(navPawns ? {navTrace: {pawns: navPawns.split(','), first: navFirst, last: navLast}} : {}),
      ...(trace[0]?.viewport?.[0] && !flag('own-viewport') ? {renderSize: trace[0].viewport} : {}),   // the original's frame size (--own-viewport: Play's page)
      ...(setupNames ? {setupProbe: {names: setupNames.split(','), first: setupFirst, last: setupLast}} : {}),
      ...(scriptPawns ? {scriptTrace: {pawns: scriptPawns.split(','), first: scriptFirst, last: scriptLast}} : {}), replay: {ticks: trace.map(({n, unfrozen, delta, rngIn, clockIn, tsIn, strobeIn, aiFirst}) => ({n, unfrozen, delta, rngIn, clockIn, tsIn, strobeIn, aiFirst, ...windowDeltas(unfrozen)})),   // not the watched fields: a long trace would not fit the page
      release: true, hold: true, levelEnded: existsSync(`${tracePath}.ended`), tickTag: tickTag(), drawTrace: flag('draw-trace'), drawStacks: flag('draw-stacks'), drawStackActor: option('draw-stack-actor', null),
      // --phonemes file.json ([{n, name, letter}]; conversation-acceptance.mjs `phonemes`): the letters the original's audio update wrote into a speaker's nextPhoneme, a measured input
      ...(option('phonemes', null) ? {phonemes: JSON.parse(readFileSync(option('phonemes'), 'utf8'))} : {}),
      ...(option('can-see', null) ? {canSeeProbe: {pawn: option('can-see'), first: Number(option('can-see-ticks', '1:1').split(':')[0]), last: Number(option('can-see-ticks', '1:1').split(':')[1])}} : {}),
      commands, watch: [
      {names: ['@player'], props: playerProps}, {names: pawns, props}, ...(watchedGenerators.length ? [{names: watchedGenerators, props: GENERATOR_FIELDS.map(f => f[1])}] : []),
      // --extra-watch actors are not pawns: the fields every Actor has
      ...(extras.length ? [{names: extras, props: ['Location', 'Rotation', 'Velocity', 'Physics', 'AnimSequence', 'AnimFrame', 'AnimRate', 'TweenRate', 'LifeSpan', 'LastRenderTime', 'DistanceFromPlayer', 'TimerRate', 'TimerCounter', ...(flag('touching') ? ['Touching'] : [])]}] : []),
      // --carcass-watch (the original's run): resolved by name from the tick the actor is in Play's level, as the tracer's late-watch
      ...(carcasses.length ? [{names: carcasses, props: CARCASS_FIELDS.map(f => f[1]), late: true}] : [])]}};
    const started = await page.evaluate(r => window.deusExViewer.liveProbe(r), request);
    if (started.objectTrace) console.log(`object trace: the run's own indices for ${started.objectTrace.measured} pre-placed actors and the player (${started.objectTrace.player})`);
    const touch = [], rows = [], nav = [], script = [], setup = [], commandLog = [], events = [], objects = [], sounds = [];
    let stalls = 0, levelEnd = null;
    rmSync(path.join(dir, `play-level-end${suffix}.json`), {force: true});
    // A trace that stopped at the original's level end (<trace>.ended): the replay runs on until Play's own client travel, or until it stalls.
    const originalEnded = existsSync(`${tracePath}.ended`);
    while (rows.length < trace.length || (originalEnded && !levelEnd)) {
      await frames(20);
      const taken = await page.evaluate(() => window.deusExViewer.liveProbe({take: true}));
      if (taken.debug?.length) { (globalThis.__debugRows ??= []).push(...taken.debug); } nav.push(...(taken.nav ?? [])); touch.push(...(taken.touch ?? [])); events.push(...(taken.events ?? [])); objects.push(...(taken.objects ?? [])); sounds.push(...(taken.sounds ?? [])); script.push(...(taken.script ?? [])); setup.push(...(taken.setup ?? [])); commandLog.push(...(taken.commands ?? [])); for (const line of taken.stackLog ?? []) console.log(line);
      if (taken.rows.length) { rows.push(...taken.rows); stalls = 0; }
      // the level's end (game.mjs clientTravel: an OPEN's URL browsed after the next tick): Play stops there; every row before it was taken above
      if (taken.levelEnd) { levelEnd = taken.levelEnd; break; }
      if (!taken.rows.length && ++stalls > 40 && rows.length >= trace.length) break;   // every row replayed and Play's level did not end: the check says so
      if (!taken.rows.length && stalls > 40) throw new Error(`the replay stopped at tick ${rows.length}${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}${(await page.evaluate(() => document.querySelector('#toast')?.textContent ?? '').catch(() => '')).slice(0, 600)}`);
    }
    // the boundaries Play recorded instead of running during the replay (docs/visual-acceptance.md, record-only audit)
    {   // the player's FlagBase at the end of the replay (the original's: flags-end<tag>.txt from --dump-flags)
      const flags = (await page.evaluate(() => window.deusExViewer.liveProbe({flags: {}}))).flags;
      writeFileSync(path.join(dir, `flags-play-end${suffix}.json`), JSON.stringify(flags));
      console.log(`flags at the end: Play defaultExpiration ${flags.defaultExpiration}, ${flags.entries.length} flags${flags.entries.length ? ` (${flags.entries.map(e => e.name).join(' ')})` : ''}`);
    }
    // (play-level-end<tag>.json: the tick Play's level ended after, or null; validate-stage5-live.mjs compares it with the original's <trace>.ended)
    writeFileSync(path.join(dir, `play-level-end${suffix}.json`), JSON.stringify(levelEnd));
    if (levelEnd) console.log(`the level ended after ${levelEnd.tick} replayed ticks (client travel to ${levelEnd.url}); the trace holds ${trace.length}${existsSync(`${tracePath}.ended`) ? `, the original's level ended after ${readFileSync(`${tracePath}.ended`, 'utf8').trim()}` : ''}`);
    const deferred = (await page.evaluate(() => window.deusExViewer.liveProbe({deferred: true}))).deferred ?? [];
    writeFileSync(path.join(dir, `deferred${suffix}.json`), JSON.stringify(deferred));
    console.log(`${deferred.length} recorded boundaries: ${deferred.slice(0, 12).join('; ')}`);
    writeFileSync(playPath, JSON.stringify({map, ghost, initial: started.initial, rows, errors, commands: commandLog, levelEnd}));
    for (const c of commandLog) if (c.draws) console.log(`  ${c.draws.length} draws in ${c.text}:\n    ${c.draws.join('\n    ')}`);
    for (const c of commandLog) console.log(`command after ${c.after} ticks: ${c.text} -> ${c.error ? `ERROR ${c.error}` : JSON.stringify(c.output)}`);
    if (globalThis.__debugRows) writeFileSync(path.join(dir, 'debug-play.json'), JSON.stringify(globalThis.__debugRows));
    if (touchWindow) writeFileSync(path.join(dir, 'touch-play.json'), JSON.stringify(touch));
    if (eventWindow) writeFileSync(path.join(dir, `events-play${suffix}.json`), JSON.stringify(events));
    if (objectWindow) { writeFileSync(path.join(dir, `objects-play${suffix}.json`), JSON.stringify(objects)); writeFileSync(path.join(dir, `sounds-play${suffix}.json`), JSON.stringify(sounds));
      console.log(`object trace: ${objects.length} registry events, ${sounds.length} Galaxy PlaySound calls`); }
    if (setupNames) writeFileSync(path.join(dir, 'setup-play.json'), JSON.stringify(setup));
    if (scriptPawns) writeFileSync(path.join(dir, 'script-play.json'), JSON.stringify({pawns: scriptPawns.split(','), events: script}));
    if (navPawns) writeFileSync(path.join(dir, `nav-play${suffix}.json`), JSON.stringify({pawns: navPawns.split(','), events: nav}));
    if (option('shot', null)) {
      // The replay holds the level at its last tick; Play draws on: the frame at the brightness whose display ramp is the identity.
      await preparePage();
      await frames(30);
      // The original's Strobe state at its held frame (hold<tag>.json, the original run's), unless --own-strobe: the flag flips with every
      // drawn frame at a new time, so which phase a held frame shows depends on the host's frame timing, in either program.
      const holdFile = path.join(dir, `hold${suffix}.json`);
      if (!flag('own-strobe') && existsSync(holdFile)) {
        const {strobe} = JSON.parse(readFileSync(holdFile, 'utf8'));
        console.log('strobe set to the original\'s:', JSON.stringify(await page.evaluate(s => window.deusExViewer.liveProbe({strobe: s}), strobe)));
        await frames(30);
      }
      // --fire-hold: the original's fires held at its frames' pixels (fire<tag>.json, `original --fire-hold`)
      const firePath = path.join(dir, `fire${suffix}.json`);
      if (flag('fire-hold') || option('fire-hold', null)) {
        if (!existsSync(firePath)) throw new Error(`--fire-hold: no ${firePath}`);
        const fires = JSON.parse(readFileSync(firePath, 'utf8'));
        const held = await page.evaluate(spec => window.deusExViewer.proceduralHold(spec), {kind: 'FireTexture', pixels: Object.fromEntries(Object.entries(fires).map(([name, f]) => [name, f.pixels]))});
        console.log('fires held at the original\'s:', JSON.stringify(held));
        if (Object.values(held.written).some(v => typeof v !== 'number')) throw new Error(`--fire-hold: ${JSON.stringify(held.written)}`);
        await frames(10);
      }
      const file = path.join(acceptanceDir(), `${option('shot')}-play.png`);
      await page.screenshot({path: file, clip: {x: 0, y: 0, width: 1280, height: 720}});
      console.log(`frame: ${file}`);
      // --extra-shots N: N more frames of the held tick (<name>-play-2.png ...), 90 page frames apart: Play against itself, as the original's (above)
      for (let k = 2; k <= 1 + Number(option('extra-shots', 0)); k++) {
        await frames(90);
        await page.screenshot({path: path.join(acceptanceDir(), `${option('shot')}-play-${k}.png`), clip: {x: 0, y: 0, width: 1280, height: 720}});
      }
    }
    // --after-file js [--after-out file.json] (play): an expression the page evaluates with the level held at its last tick (the weapon states of
    // the frame just drawn: lodProbe({list: 'weapons'})); its value goes to --after-out, else to the log.
    if (option('after-file', null)) {
      const value = JSON.stringify(await page.evaluate(readFileSync(option('after-file'), 'utf8')));
      if (option('after-out', null)) writeFileSync(option('after-out'), value); else console.log(value);
    }
    console.log(map, `${rows.length} ticks replayed`, errors.length ? `errors: ${errors.slice(0, 2).join(' | ')}` : '');
  });
}

// --- comparison -----------------------------------------------------------
const f32 = Math.fround;
let rotationCompare = false;
const indexOf = new Map(FIELDS.filter(f => f[5] !== undefined).map(f => [f[0], f[5]]));
// Objects the two programs create while running are numbered by their own creation order (JCDentonMale2 and JCDentonMale1, the NPCs' weapons
// WeaponAssaultShotgun0 and 1): the same object under another number. Map actors keep their names.
const runtimeNumbered = /^((?:JCDenton\w*?|Weapon\w+?|Ammo\w+?|NanoKeyRing))\d+$/;
function same(a, b) {
  if (a === null || a === undefined) a = 'None';
  if (b === null || b === undefined) b = 'None';
  if (typeof a === 'string' && typeof b === 'string' && a !== b) {
    const x = runtimeNumbered.exec(a), y = runtimeNumbered.exec(b);
    if (x && y && x[1] === y[1]) return true;
  }
  if (rotationCompare && Array.isArray(a) && Array.isArray(b)) { const wrap = v => ((v % 65536) + 65536) % 65536; a = a.map(wrap); b = b.map(wrap); }
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (typeof a === 'number' && typeof b === 'number') return Object.is(f32(a), f32(b)) || (a === b);
  return a === b;
}
const fmt = v => Array.isArray(v) ? `(${v.map(fmt).join(', ')})` : typeof v === 'number' ? String(+v.toPrecision(9)) : String(v);
function compare() {
  const original = readFileSync(tracePath, 'utf8').trim().split('\n').map(parseTraceLine);
  const rows = original.filter(row => row.unfrozen >= 1);
  const played = JSON.parse(readFileSync(playPath, 'utf8'));
  const labelOf = new Map(FIELDS.map(f => [f[1] === '$state' ? 'State' : f[1], f[0]]));
  const report = {map, ticks: rows.length, tickChecks: {}, actors: {}};
  // Per tick: stream and clocks.
  let firstRng = null, firstClock = null;
  const tickDraws = [];
  rows.forEach((row, i) => {
    const p = played.rows[i];
    if (!p) return;
    const draws = (a, b) => { const step = s => (Math.imul(s, 214013) + 2531011) >>> 0; let x = parseInt(a, 16) >>> 0, k = 0; const t = parseInt(b, 16) >>> 0; while (x !== t && k < 100000) { x = step(x); k++; } return x === t ? k : null; };
    const po = draws(row.rngIn, row.rngOut), pp = draws(p.rngIn, p.rngOut);
    if (po !== pp && firstRng === null) firstRng = {tick: i + 1, original: po, play: pp, originalState: row.rngOut, playState: p.rngOut};
    if (po) tickDraws.push([i + 1, po, pp]);
    if (!Object.is(row.clockOut, p.clockOut) && firstClock === null) firstClock = {tick: i + 1, original: row.clockOut, play: p.clockOut};
  });
  report.rng = {firstTickWithDifferentDrawCount: firstRng, ticksWithDraws: tickDraws.length, tickDraws: tickDraws.slice(0, 40)};
  report.clock = {firstDifference: firstClock};
  // Render.dll's Strobe state (one flip per drawn frame at a new time: a host input of the frames, not of the ticks): the ticks at
  // which the flag differs and how often each side flipped it.
  if (rows[0]?.strobeOut && played.rows[0]?.strobeOut) {
    const flips = list => list.reduce((n, r, i) => n + (i && r.strobeOut[0] !== list[i - 1].strobeOut[0] ? 1 : 0), 0);
    const differing = rows.filter((r, i) => played.rows[i] && r.strobeOut[0] !== played.rows[i].strobeOut[0]).length;
    report.strobe = {originalFlips: flips(rows), playFlips: flips(played.rows), ticksWithDifferentFlag: differing,
      originalLastChange: rows.findLast((r, i) => i && r.strobeOut[0] !== rows[i - 1].strobeOut[0])?.n ?? null,
      playLastChange: played.rows.findLast((r, i) => i && r.strobeOut[0] !== played.rows[i - 1].strobeOut[0])?.n ?? null};
  }
  // The actors of the first row, and the ones a scene spawns (--carcass-watch, watch<tag>.json `carcasses`): those have rows from the tick they appear,
  // and whether one is there at a tick is compared too (`Present`: the original's tracer binds it at the tick exit after its AddObject, Play's replay at
  // the end of the same tick). (The timed actors' rows are the original's only: Play writes their timers and does not watch them.)
  const late = existsSync(watchPath) ? JSON.parse(readFileSync(watchPath, 'utf8')).carcasses ?? [] : [];
  const names = [...new Set([...Object.keys(rows[0]?.actors ?? {}), ...late])];
  const labels = [...FIELDS, ...PLAYER_FIELDS.slice(11), ...GENERATOR_LOAD_FIELDS, ...GENERATOR_FIELDS.slice(GENERATOR_LOAD_FIELDS.length).filter(f => !FIELDS.some(g => g[0] === f[0])),
    ...CARCASS_FIELDS.filter(f => !FIELDS.some(g => g[0] === f[0]))].map(f => [f[0], f[1] === '$state' ? 'State' : f[1]]);
  // An Inventory chain is compared by its items' classes in order: the items' numbers follow each process's creation order (runtimeNumbered)
  const stems = list => Array.isArray(list) ? list.map(name => String(name).replace(/\d+$/, '').toLowerCase()) : list;
  for (const name of names) {
    const entry = report.actors[name] = {firstDifference: null, fields: {}};
    for (let i = 0; i < rows.length; i++) {
      const o = rows[i].actors[name], p = played.rows[i]?.actors[name];
      if (late.includes(name) && Boolean(o) !== Boolean(p) && played.rows[i]) {
        const field = entry.fields.Present ??= {tick: i + 1, original: Boolean(o), play: Boolean(p), count: 0};
        field.count++;
        if (entry.firstDifference === null || i + 1 < entry.firstDifference) entry.firstDifference = i + 1;
      }
      if (!o || !p) continue;
      entry.compared = true;   // (an actor only the original's trace holds, a timed actor or a pawn traced for its load fields, is never compared)
      for (const [label, prop] of labels) {
        if (!(label in o) || !(prop in p)) continue;
        let ov = o[label], pv = p[prop];
        if (label === 'InvChain') { ov = stems(ov); pv = stems(pv); }
        const index = indexOf.get(label);
        if (index !== undefined && Array.isArray(pv)) pv = pv[index];
        if (label === 'State') { ov = String(ov).split('|')[0]; pv = String(pv).split('|')[0]; }
        rotationCompare = label === 'Rot';
        if (same(ov, pv)) continue;
        const field = entry.fields[label] ??= {tick: i + 1, original: ov, play: pv, count: 0};
        field.count++;
        if (entry.firstDifference === null || i + 1 < entry.firstDifference) entry.firstDifference = i + 1;
      }
    }
  }
  writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 1));
  console.log(`${map}: ${rows.length} ticks; clock ${firstClock ? `differs from tick ${firstClock.tick}` : 'equal'}; stream draws per tick ${firstRng ? `differ at tick ${firstRng.tick} (original ${firstRng.original}, Play ${firstRng.play})` : 'equal'}`);
  if (report.strobe) console.log(`Strobe flag: original flipped ${report.strobe.originalFlips} times (last at tick ${report.strobe.originalLastChange}), Play ${report.strobe.playFlips} (last at tick ${report.strobe.playLastChange}); differs at ${report.strobe.ticksWithDifferentFlag} of ${rows.length} ticks`);
  for (const [name, entry] of Object.entries(report.actors)) {
    const fields = Object.entries(entry.fields).sort((a, b) => a[1].tick - b[1].tick).slice(0, 4)
      .map(([label, f]) => `${label}@${f.tick}: ${fmt(f.original)} vs ${fmt(f.play)}`).join(' | ');
    console.log(`${name.padEnd(18)} ${entry.firstDifference === null ? `equal for ${rows.length} ticks` : `first difference at tick ${entry.firstDifference}`}  ${fields}`);
  }
}

if (verb === 'original') await original();
else if (verb === 'snap') await snap();
else if (verb === 'population') await population();
else if (verb === 'screen') await screen();
else if (verb === 'sweep') await sweep();
else if (verb === 'eval' || verb === 'script') await evaluate();
else if (verb === 'read') await readActors();
else if (verb === 'play') await play();
else if (verb === 'compare') compare();
else console.log('usage: live-acceptance.mjs original|play|compare|snap --map <map>');
