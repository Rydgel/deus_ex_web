#!/usr/bin/env node
/** Stage 4 acceptance gate (docs/stage-4-exit-criteria.md): the roadmap's "Done when" for section 4 as a finite
 * list of criteria, each tied to representative scenes and to the checks that compare Play with the original.
 *
 * The gate composes the checks that exist; it implements none of them. A criterion's checks are
 *   - validators (scripts/validate-*.mjs) run as child processes: translations against the original DLLs' own code
 *     (Unicorn, NATIVE_PROBE_PYTHON) and Play's live inputs through the same code;
 *   - matched frames: `visual-acceptance.mjs play` + `compare` against the original's stored frames, judged by
 *     metrics chosen in this file (THRESHOLDS);
 *   - the interface (HUD, persona screens, menus, a datacube and the keypad): `interface-acceptance.mjs play` + `compare` against stored frames,
 *     judged by INTERFACE_THRESHOLDS (docs/interface-frames.md);
 *   - the security cameras: `camera-acceptance.mjs play` + `compare` against stored frames and state;
 *   - live scenes: `live-acceptance.mjs play` + `compare` (the original's per-tick trace replayed in Play) and
 *     `live-sweep.mjs replay` over stored traces.
 * A criterion with no check is MISSING, one whose stored original is absent is NO-ORIGINAL, and both keep the gate
 * red. EXCLUDED criteria name the stage or the reason they are out (they never turn the gate green or red).
 * The gate never starts DeusEx.exe: every original result is read from the stores (see "Stored originals" in the doc).
 *
 *   node scripts/validate-stage4-acceptance.mjs [--only regex] [--report [file]] [--jobs 2] [--list] [--markdown report.json]
 *        [--mem-cap MiB] [--mem-budget MiB] [--timeout-scale n]
 *
 * --only keeps the criteria whose id, clause or scene matches; --report prints the scoreboard and exits 0 (the
 * Stage 3 gate's --report), writing the JSON report to the file when one follows; --list prints the criteria and the
 * commands without running; --markdown re-renders the scoreboard table of a report. Exit status 1 while any
 * criterion is not PASS (EXCLUDED apart). DX_ORIGINALS (colon-separated .work directories) names the stores; the
 * default is this checkout's .work, the main checkout's .work and its .work/live/.work (where the originals are
 * captured). Native validators get NATIVE_PROBE_PYTHON from .cache/native-probe-env when it exists. */
import {spawn, execFileSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CRITERIA_VIEWS, ORDER as INTERFACE_ORDER} from './interface-views.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = argv.indexOf(name); return i === -1 ? fallback : (argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[i + 1]); };
const has = name => argv.includes(name);

// --- judgement chosen in this file (not taken from the original; the doc lists why each value was chosen) -------
const THRESHOLDS = Object.freeze({
  edgeRecall: 0.90,      // share of the original's strongest 5% Sobel edges that Play has within 2 px
  edgePrecision: 0.85,   // the converse
  outlierBlocks: 0,      // 16x9 blocks whose Play/original luminance ratio is 1.6x off the frame's median ratio
  subpixel: 0.25,        // |dx|, |dy| of the best-fit sub-pixel offset where the frame has enough gradient to measure it
  cameraMad: 1.0,        // mean abs. difference of a security camera window (200x150), Brightness 2/3 identity ramp
  cameraRecall: 0.90,    // a camera window's edge recall and precision (walking actors in a window moved the precision between runs: .95 to .99)
  // An effect's contribution (the frame with it less the frame without it, original against Play: visual-acceptance.mjs `compare --contribution`).
  // 02_NYC_Bar's smoke haze measures correlation .93, .93 and .99 and Play's haze over the original's within 1% to 4% of the frame's own
  // brightness ratio (the haze scales with the gap), every pixel the original's haze reaches also lit by Play's. Weak: set from three views; the
  // original's two frames are two captures, so the animated light maps' noise state is in its difference.
  contributionCorrelation: 0.90,
  contributionGap: 0.08,           // |play sum / original sum / frame ratio - 1|
  contributionAgreement: 0.98,     // share of the original's effect pixels (difference >= 1 level) where Play's is at least a quarter of its scaled value
  // An effect drawn with a FireTexture (04_NYC_Street's steam, row 4.2.13) changes from frame to frame at a held tick in the original itself (the sparks,
  // an unmatched host input as the beams' texture): its agreement is judged against the original's own floor instead (a LIVE check's `floorShots`):
  // over every pair of the stored frames and Play's (`--extra-shots`), Play's median agreement against the original at least the original's minimum
  // against itself (scripts/contribution-floor.mjs). The steam measured .898 against .867 (four frames a side; the original against itself .867 to .934);
  // since 2026-10-17 its row holds the texture at the original's pixels instead (a LIVE check's `fireHold`) and is judged at the thresholds above.
  // The laser beams' geometry in 64 x 64 blocks (visual-acceptance.mjs `compare --beams`). Island's doorway beams measure coverage .94 and .88, Play's
  // energy over the original's .87 to 1.01 and .88 to 1.0 over runs (the fire texture) and a y-offset of the centroids of 1.3 and 1.6 px rms; two frames of the original itself, whose beams'
  // texture is an animated fire, read 1.0, .99 and .3 px. Weak: set from two views; the sparks of the beam texture are an unmatched host input.
  beamCoverage: 0.85,              // blocks with beam energy in both frames, of those with it in either
  beamEnergyLow: 0.75, beamEnergyHigh: 1.33,   // Play's total beam energy (at the frame's brightness ratio) over the original's
  beamYRms: 2.5,                   // rms offset in y of the energy centroid of the blocks that hold beam in both, in pixels
  // The viewport flash as a per-channel map of levels (visual-acceptance.mjs `compare --flash-base`): Training's two held states measure 0 of 369
  // (channel, level) pairs differing and 0 stray pixels of 2,764,800 samples in either program; a Play that draws no flash differs at 363. Strong for the
  // pass's arithmetic and rounding over the levels the frame holds (0 to 154), nothing above them.
  flashMapDiffering: 0,            // (channel, level) pairs whose output level differs between the programs
  flashMapStrays: 0,               // samples off their input level's majority output, in either program
});
// The interface frames (docs/interface-frames.md): the 18 views of 00_Training compare equal to within 2 of 255 everywhere but one world scanline of
// 57 pixels (up to 27 levels) and, in the datacube view, 90 pixels of at most 13 levels. Strong for what it excludes: a missing underline, a stale log
// line, a wrong button or a shifted glyph are hundreds to thousands of pixels: Play before the two fixes of docs/interface-frames.md fails every one of
// the frames they changed (the closest, ui-health, has 105 pixels over 10). Weak for the margins: set from the 18 measured values (identical at least
// .9922; at most 57 pixels over 10, the world's scanline, plus a margin of 7).
const INTERFACE_THRESHOLDS = Object.freeze({
  identical: 0.99,       // share of the 921,600 pixels equal in all three channels
  over10: 64,            // pixels off by more than 10 of 255 in a channel (the measured worst is 57)
  mad: 0.1,              // mean absolute difference over 0..255 (the measured worst is 0.00)
  edge: 0.99,            // edge recall and precision
  outlierBlocks: 0,
});
// The conversation frames (docs/conversation-camera.md "Frames against the original"): a third-person frame at 1280x720 is the letterbox bars
// (rows 0..72 and 570..719), the subtitle in the lower bar, and the 3D band between them (the whole frame in the intro, whose window is 16:9 of the
// width). The bars and the subtitle are drawn by the same code on both sides and measured equal to the pixel in all 4 MeetPaul frames (0 of ~280,000
// pixels, maximum difference 0). The band differs where the two rasterizers tie on a polygon edge: 99% or more of its pixels off by more than 10 lie
// within 1 px of a hard step (a >24 of 255 step to a neighbour, in either frame), the rest are at most 93 pixels per frame, off by at most 25.
// Chosen from the frames compared (4 of MeetPaul, 3 of the intro, MeetManderley's; the measured worst in each comment): strong for a misplaced or missing bar, a shifted
// camera or viewport (the harness defect fixed 2026-10-16 read .33 identical, 349,313 pixels over 2), wrong text, colour, shading or texture (those
// are thousands of pixels away from edges); weak for the polygon edge, which is not judged by a count (it follows the silhouettes' length).
const CONVERSATION_THRESHOLDS = Object.freeze({
  barsOver2: 0,          // the two bars and the subtitle: pixels off by more than 2 of 255 (measured 0)
  bandIdentical: 0.94,   // share of the band's pixels equal in all channels (measured .951 to .983)
  awayOver10: 150,       // pixels off by more than 10 of 255 and farther than 1 px from every hard step (measured at most 93: the dark wood of Manderley's office)
  edge: 0.99,            // the frame's edge recall and precision (measured at least .997)
  outlierBlocks: 0,      // 16x9 blocks whose luminance ratio is 1.6x off the frame's median (measured 0)
});
// Views of flat, nearly black walls, where the strongest 5% of gradients are texture noise and the edge precision reads low with no visible
// difference (docs/visual-acceptance.md "Flags explained by the metric or by timing"; Smug y0/y1 show the same pattern, recall 1.0 and
// mean abs. difference under 1.3). They are judged by the recall and the outlier blocks alone.
const FLAT_VIEWS = new Set(['10_Paris_Club:y1', '10_Paris_Club:y2', '10_Paris_Club:y3', '10_Paris_Club:down', '03_NYC_AirfieldHeliBase:y1',
  '02_NYC_Smug:y0', '02_NYC_Smug:y1', '09_NYC_Ship:y2']);
// Views where the documented difference is a host input the two programs do not share, so a block or two of the frame differs between runs of the
// same code: the panning sky follows Level.TimeSeconds (the two clocks are held within 1 ms) and the animated light maps' noise state is not
// shared (docs/visual-acceptance.md "Flags explained by the metric or by timing", "The darkest pixels"). They may keep up to the listed
// outlier blocks. Weak: the allowance was read from the first runs (Street y2 or y3 one block, Garage garage2 two).
const EXPLAINED_BLOCKS = {'04_NYC_Street:y2': 2, '04_NYC_Street:y3': 2, '06_HongKong_WanChai_Garage:garage2': 2};
// The uniform Play/original brightness ratio (1.13 to 1.45 under Wine) is a known Windows gamma issue and is not judged.

// --- the stores of original results -----------------------------------------------------------------------
const mainCheckout = (() => {
  try {
    const gitFile = readFileSync(path.join(root, '.git'), 'utf8').trim();
    if (gitFile.startsWith('gitdir:')) return path.resolve(gitFile.slice(7).trim(), '..', '..', '..');
  } catch { /* a plain checkout has .git as a directory */ }
  return root;
})();
const storeRoots = (process.env.DX_ORIGINALS ? process.env.DX_ORIGINALS.split(':')
  : [path.join(root, '.work'), path.join(mainCheckout, '.work'), path.join(mainCheckout, '.work/live/.work')]).filter(dir => existsSync(dir));
const findStored = (relative) => { for (const dir of storeRoots) { const file = path.join(dir, relative); if (existsSync(file)) return file; } return null; };
// Original-derived inputs are linked (large traces) or copied (small lists) into this checkout's .work; Play's own outputs are written
// beside them, so nothing is ever linked to a file Play writes.
const stage = (relative, {copy = false} = {}) => {
  const target = path.join(root, '.work', relative);
  if (existsSync(target)) return true;
  try { unlinkSync(target); } catch { /* nothing to replace, or a dangling link now replaced */ }
  // the real file behind the store's entry (it can itself be a link an earlier staging made; a loop or a broken link is no source)
  let source = findStored(relative);
  try { source = source && realpathSync(source); } catch { source = null; }
  if (!source) return false;
  mkdirSync(path.dirname(target), {recursive: true});
  if (copy) copyFileSync(source, target); else symlinkSync(source, target);
  return true;
};
const missingFiles = list => list.filter(([relative, options]) => !stage(relative, options)).map(([relative]) => relative);

// --- checks -----------------------------------------------------------------------------------------------
// A check is {type, ...}; `tasks(check)` turns it into runnable tasks.
const V = (name, ...args) => ({type: 'validator', name, args});
const FAMILY = (pattern, label) => ({type: 'family', pattern, label});
const FRAMES = spec => ({type: 'frames', ...spec});
const CAMERA = spec => ({type: 'camera', ...spec});
const INTERFACE = spec => ({type: 'interface', ...spec});
const TERMINAL = spec => ({type: 'terminal', ...spec});
const LIVE = spec => ({type: 'live', ...spec});
const CONVERSATION = spec => ({type: 'conversation', ...spec});
const SWEEP = spec => ({type: 'sweep', ...spec});
// A live scene's Galaxy PlaySound calls (scripts/live-sound-compare.mjs --gate): the original's stored calls file against Play's replay of the same trace.
const SOUNDS = spec => ({type: 'sounds', ...spec});
const CENSUS = spec => ({type: 'census', ...spec});

const FROZEN = Object.freeze(['y0', 'y1', 'y2', 'y3', 'down']);
const frozen = (maps, flat = {}) => FRAMES({maps, views: FROZEN, flat});

// Views aimed at one effect (docs/visual-acceptance.md "Light effects against the original"); cameras recovered from the capture's
// play.json (yaw = 65536 - the camera's Euler yaw), integers in raw rotator units.
const EFFECT_VIEWS = Object.freeze({
  club: {map: '10_Paris_Club', views: ['club1:248,-211,87:64002,34378,0', 'club2:-249,-108,48:64412,50980,0', 'club3:-136,-322,150:51536,0,0', 'club4:-176,-282,150:56536,49152,0']},
  garage: {map: '06_HongKong_WanChai_Garage', views: ['garage1:3449,-1156,-111:63907,5810,0', 'garage2:3575,-968,-168:735,1653,0', 'garage3:3889,-988,-40:53536,0,0']},
  below: {map: '09_NYC_ShipBelow', views: ['below1:-5762,678,-489:64541,34747,0', 'below2:-6043,684,-406:53536,0,0']},
  street: {map: '04_NYC_Street', views: ['street1:-264,-256,-452:-343,32616,0', 'street2:993,-1703,-261:62999,31953,0']},
  training: {map: '00_Training', views: ['trainA:-100,840,30:0,0,0', 'trainB:1200,840,30:0,0,0']},
  fan: {map: '09_NYC_ShipFan', views: ['fan2:236,-238,-55:63686,25298,0']},
  // 2026-10-16 captures (visual-acceptance.md "Effect frames"), each frame with its own <view>-time.txt.
  bar: {map: '02_NYC_Bar', views: ['fog3:-1200,-357,90:65501,16384,0', 'fog5:-1518,261,90:65513,57344,0', 'fog0:-900,-57,90:65501,32768,0']},
  laser: {map: '01_NYC_UNATCOIsland', views: ['laser1:1920,-1069,-60:63036,16384,0', 'laser2:1850,-1000,-60:64036,15000,0']},
  hotel: {map: '02_NYC_Hotel', views: ['hotel1:1880,-1158,148:0,32768,0', 'hotel2:1880,-1158,148:63036,32768,0']},
  // Held viewport flashes (docs/screen-flash.md "Against the original"), captured on the Mac at Brightness 2/3 (the Shot is the framebuffer), one capture
  // and clock per state; FLASH_BASE is the same camera without the flash, a capture of its own.
  flashA: {map: '00_Training', views: ['flashA:-100,840,30:0,0,0']},
  flashB: {map: '00_Training', views: ['flashB:-100,840,30:0,0,0']},
  // Training's pawns' shadows (docs/decals.md "Against the original"), captured on the Mac at Brightness 2/3 with the level unfrozen and the pawns'
  // meshes hidden at the shot, each view with its frame without decals (<view>-base) and the shadows' state (<view>-decals.json). The recipe's
  // shadow1 (61,1326,-23:62166,61567,0) is not used: an animated console screen and a flickering patch in it change between any two frames of
  // either program, so its contribution measures them (correlation .945 and .78 in two captures); shadow3 sees the same shadows without them.
  shadow: {map: '00_Training', views: ['shadow2:211,1266,-33:62500,61567,0', 'shadow3:61,1326,-23:61166,59067,0']},
  // The D3DDrv detail pass (docs/frame-projection.md "Detail textures"), captured on the Mac at Brightness 2/3 with the render device's DetailTextures
  // poked to 1 (CrossOver's ddraw, like Linux Wine's, does not report BLENDDIFFUSEALPHA, so SetRes leaves it 0) and each view again with it 0 (<view>-base).
  detailT: {map: '00_Training', views: ['detailT1:-736,1314,560:0,16384,0', 'detailT2:-1100,1224,560:0,21384,0']},
  detailI: {map: '01_NYC_UNATCOIsland', views: ['detailI1:-4761,10431,-234:56536,20000,0', 'detailI2:-4761,10431,-256:62536,0,0']},
  // The Underworld's dance floor in the mirrored panes (docs/visual-acceptance.md "Strobe in child frames"), captured on the Mac at Brightness 2/3 with the
  // dancers hidden and Render.dll's Strobe flag held (<view>_s0 lit, _s1 dark, the hold beside each frame in <view>-strobe-held.txt), one capture: uw is the
  // aimed camera whose main frame draws no strobe-lit surface (the floor only in the panes), uwd sees two panes beside the direct floor. The level's clock runs
  // on at the held dilation between the shots and the club's two Disco lights (LE_Disco: Light2, Light21) follow it, so each frame keeps the level time of
  // its own shot (<view>-time.txt) and is played in a run of its own.
  uw: {map: '06_HongKong_WanChai_Underworld', views: ['uw_s0:-1081,-2010,-336:0,54769,0', 'uw_s1:-1081,-2010,-336:0,54769,0',
    'uwd_s0:-1120,-1900,-336:0,55000,0', 'uwd_s1:-1120,-1900,-336:0,55000,0']},
});
const FLASH_BASE = 'flash0:-100,840,30:0,0,0';
// `extra`: `base` names the effect of a contribution check ('fog': the stored <view>-base frames are the original without it, Play's own frame
// without it comes from `--base fog`); `playerPose`: Play writes the player's animation the original measured (<view>-state.json); `preShot` and
// `preShotWait`: console lines both programs run at the camera before the shot and the wait after them (`--pre-shot-cmd`, `--pre-shot-wait`);
// `flashBase`: the view without the flash, played in a run of its own (its own clock) and judged as a frame too, and the flash judged as a map of
// levels from it; `decalState`: the shadows' state the original had at each shot (<view>-decals.json) against Play's (`--decal-state`); `cmds`:
// console lines both programs run once after ghost, with the level still frozen (`--cmd`); `cameraTransit`: Play places each camera as the original's
// console does, Location and then ViewRotation, with frames between (`--camera-transit`).
const effectViews = (key, extra = {}) => FRAMES({maps: [EFFECT_VIEWS[key].map], explicit: EFFECT_VIEWS[key].views, flat: {}, ...extra});

// Pilots: the original's per-tick trace of the load, replayed in Play (docs/visual-acceptance.md "Live scenes").
const PILOT = (map, extra = {}) => LIVE({map, ...extra});

// --- the criteria ----------------------------------------------------------------------------------------
// evidence: O1 = Play compared with the original's own output for the same inputs (frame, state per tick, call log);
//           O2 = the translation compared with the original DLL's code executed unchanged (Unicorn, real x87);
//           O3 = O2 on the inputs Play itself produced while running the scene;
//           P  = Play against itself (reach, integration), never enough alone for a rendered or played result.
const CRITERIA = [];
const add = (id, clause, scene, claim, evidence, ...checks) => CRITERIA.push({id, clause, scene, claim, evidence, checks});
const missing = (id, clause, scene, claim, reason) => CRITERIA.push({id, clause, scene, claim, evidence: '-', missing: reason, checks: []});
const excluded = (id, clause, scene, claim, reason) => CRITERIA.push({id, clause, scene, claim, evidence: '-', excluded: reason, checks: []});

// the console lines of the Manderley captures: Brightness 2/3 (the display ramp is the identity), the ghost placed at the rest height in front of Manderley, then `walk`
const MANDERLEY_START = 'set WinDrv.WindowsClient Brightness 0.666667|set DeusEx.JCDentonMale Location (X=310,Y=-164,Z=287.629913)|set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=63442,Roll=0)|walk';
const C1 = 'Animated actors', C2 = 'Effects', C3 = 'Sound', C4 = 'Text and interfaces', C5 = 'Speech, lip sync and the conversation camera';

// 4.1 Animated actors -----------------------------------------------------------------------------------
add('4.1.1', C1, '00_Training start views', 'meshes, lighting and the floor mirror in five frames match the original\'s', 'O1',
  frozen(['00_Training']));
add('4.1.2', C1, 'mesh pipeline', 'GetFrame, LOD, skins and mesh lighting equal Engine.dll and Render.dll', 'O2',
  V('lodmesh-frame'), V('lodmesh-lod'), V('lodmesh-materials'), V('mesh-lighting'), V('mesh-light-types'), V('mesh-environment'));
add('4.1.3', C1, 'mesh pipeline in Play', 'the same code on the inputs Play produced in Training and Island', 'O3',
  V('mesh-lighting-play'), V('lodmesh-lod-play'), V('mesh-light-types-play'));
add('4.1.4', C1, 'animation state', 'animation phase, controls, blend and the dilated delta equal the original', 'O2',
  V('animation-tick'), V('animation-controls'), V('tween-blend'), V('get-anim-group'), V('anim-dilation-play'));
add('4.1.5', C1, '01_NYC_UNATCOIsland live', '88 actors, 600 ticks: every watched field, the clock and the stream draws equal', 'O1',
  PILOT('01_NYC_UNATCOIsland'));
add('4.1.6', C1, '10_Paris_Club live', '22 actors, 600 ticks, then the dancers animating in view and their frame', 'O1',
  PILOT('10_Paris_Club'),
  LIVE({map: '10_Paris_Club', tag: 'cvclub', shot: 'cvclub', earlyCmds: 'CheatView DeusEx.Female4|set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=49152,Roll=0)', renderHistory: true}));
add('4.1.7', C1, '06_HongKong_WanChai_Underworld live', '50 actors, 600 ticks, six dancers', 'O1',
  PILOT('06_HongKong_WanChai_Underworld'));
add('4.1.8', C1, 'five campaign maps, 1,200 ticks', 'BatteryPark, Hotel, Market, Chateau and Area 51 Bunker: every actor equal', 'O1',
  // BatteryPark's first stored sweep trace (tag `sweep`) is a load whose population held a chance FlyGenerator Play's seeded load lacks (that sweep ran
  // with --allow-missing generators); `sweep2` is a fresh original load with an exact population (docs/visual-acceptance.md "Battery Park").
  SWEEP({maps: ['02_NYC_BatteryPark', '02_NYC_Hotel', '06_HongKong_WanChai_Market', '10_Paris_Chateau', '15_Area51_Bunker'], tags: {'02_NYC_BatteryPark': 'sweep2'}}));
add('4.1.9', C1, '01_NYC_UNATCOIsland armed pawns', 'a pawn\'s third-person weapon: hand frame and Coords equal Render.dll, drawn in Play', 'O2',
  V('weapon-attach'), V('weapon-play'));
missing('4.1.10', C1, 'Training first-person crowbar', 'the first-person weapon frame (view model, GPU camera passes) against the original',
  'only the selection (validate-weapon-lod) is compared with the original; no matched capture of the held weapon');
add('4.1.11', C1, '05_NYC_UNATCOMJ12lab mirror', 'the player holding a pistol and a MedKit in a mirror child frame: the frame\'s planes and the Coords equal the running original\'s logged draws', 'O1',
  V('weapon-attach'), V('weapon-mirror-play'));
missing('4.1.12', C1, 'an armed NPC in a mirror, a weapon in a camera window', 'an armed pawn in a mirror child frame and a weapon in a ViewportWindow against the original\'s frames',
  'wired and checked in Play (validate-terminals-camera-browser --expect weapons); no original capture of an armed NPC in a mirror (the maps\' mirrors miss a standing pawn\'s hands) or of a camera window with an armed pawn (docs/weapon-attachment.md Open)');

// 4.2 Effects --------------------------------------------------------------------------------------------
add('4.2.1', C2, '01_NYC_UNATCOIsland', 'sky, water, skyline and decorations, five frozen frames', 'O1', frozen(['01_NYC_UNATCOIsland']));
add('4.2.2', C2, '04_NYC_Street', 'steam vents, panning sky, Spotlight and Cylinder pools', 'O1', frozen(['04_NYC_Street'], {}), effectViews('street'));
add('4.2.3', C2, '02_NYC_BatteryPark and 03_NYC_AirfieldHeliBase', 'street-lamp coronas and exterior lighting', 'O1',
  frozen(['02_NYC_BatteryPark', '03_NYC_AirfieldHeliBase']));
add('4.2.4', C2, '08_NYC_Bar', 'the bar\'s translucent mirror and lighting', 'O1', frozen(['08_NYC_Bar']));
add('4.2.5', C2, '10_Paris_Club', 'Disco floor, wall mirrors and lights', 'O1', frozen(['10_Paris_Club']), effectViews('club'));
add('4.2.6', C2, '09_NYC_Ship', 'Rotor fan and SlowWave hold, coronas behind a mover, the ship\'s frames', 'O1',
  frozen(['09_NYC_Ship']), effectViews('fan'), effectViews('below'));
add('4.2.7', C2, '06_HongKong_WanChai_Garage', 'Searchlights, red and blue ceiling panels', 'O1', effectViews('garage'));
add('4.2.8', C2, 'Training corridor, Everett, Smuggler\'s, 747, Market', 'NonIncidence lights, a standing mirror, a window mirror and a mover mirror', 'O1',
  effectViews('training'), frozen(['11_Paris_Everett', '02_NYC_Smug', '03_NYC_747', '06_HongKong_WanChai_Market']));
add('4.2.9', C2, 'light maps', 'static and animated light maps, spatial and moving light effects equal Render.dll', 'O2',
  V('static-lighting'), V('light-animation'), V('light-spatial'), V('moving-light-effects'), V('normal-moving-lighting'), V('dynamic-lighting'), V('leaf-lights'), V('original-light-tables'));
add('4.2.10', C2, 'light effects in Play', 'the Disco floor, a barrel fire and AugLight in Play against the original bodies', 'O3',
  V('light-spatial-play'), V('moving-light-effects-play'), V('auglight-lighting'));
add('4.2.11', C2, 'coronas', 'visibility helper, DrawIcon arguments, tracker trace and the tile chain', 'O2',
  V('coronas'), V('coronas-tracked'), V('corona-tiles'), V('corona-tiles-play'), V('coronas-mover-play'), V('coronas-play'));
add('4.2.12', C2, 'particles and sprites', 'ParticleIterator, FDynamicSprite and the tile chain', 'O2',
  V('native-particles'), V('sprite-setup'), V('sprite-tiles'), V('sprite-tiles-play'), V('sprite-tiles-mirror-play'), V('particles-play'));
add('4.2.13', C2, '04_NYC_Street vents', 'a frame with particles and sprites against the original with the generators\' state matched: the original\'s 600 ticks (stream state per tick) replayed in Play (the load\'s chance FlyGenerators removed in both by the original\'s KillAll), then the held frame and the steam (the frame less the frozen start\'s) against the original\'s, the steam\'s FireTexture held at the original\'s pixels',
  // vents5 (the Mac, Brightness 2/3): the load's chance FlyGenerators removed in both programs by the original's KillAll (their names are a per-process
  // counter, so a name match does not hold the same decorations: docs/visual-acceptance.md "04_NYC_Street's steam vents"), and the steam's FireTexture
  // held at the original's frames (`dx-live-win fire hold`, its pixels read and written into Play's), so the frame is judged per pixel at the normal
  // thresholds. vents4's floorShots (the agreement against the original's own frame-to-frame floor, adopted 2026-10-16) is superseded.
  'O1', LIVE({map: '04_NYC_Street', tag: 'vents5', shot: 'vents5', baseShot: true, renderHistory: true, fireHold: true,
    earlyCmds: 'KillAll FlyGenerator|set DeusEx.JCDentonMale Location (X=454,Y=67,Z=-467)|set DeusEx.JCDentonMale ViewRotation (Pitch=1800,Yaw=0,Roll=0)'}));
add('4.2.14', C2, 'decals', 'AttachDecal, ClipDecal and the vertices of a decal equal Engine.dll and Render.dll', 'O2',
  V('decal-attach'), V('decal-render'), V('decal-startup'), V('decal-vertices-play'), V('decals-play'));
// The pawns' Shadow decals with the level unfrozen (Shadow.Tick attaches them), held at the shot: the two pawns in view that walk (mib1 Wandering,
// ScientistMale0 Patrolling) are ordered to stand while still frozen in StartUp (their walks are each program's own random draws from a tick count
// the programs do not share), the meshes are hidden and the level frozen again before the shot, so the state read after it is the frame's; Play
// moves its camera as the original's console does (a pawn drawn only in those frames gets its shadow).
add('4.2.15', C2, '00_Training pawns\' shadows', 'a decal frame against the original: the frames, the shadows\' contribution (the frame less the frame without decals) and the shadows\' state at the shot (drawn set, owners, Location, DrawScale, Rotation, surfaces) equal; bullet holes, blood and scorch marks need combat and are not in it', 'O1',
  effectViews('shadow', {unfreeze: true, base: 'decal', decalState: true, cameraTransit: true, cmds: ['set MIB Orders Standing', 'set ScientistMale Orders Standing'],
    preShot: ['set ScriptedPawn bHidden True', 'set LevelInfo bPlayersOnly True']}));
add('4.2.16', C2, 'volumetric fog (02_NYC_Bar)', 'ComputeFromActor and the fog loop equal Render.dll; the pass in Play', 'O3',
  V('volumetric-fog'), V('volumetric-fog-play'));
add('4.2.17', C2, '02_NYC_Bar smoke haze', 'a fog frame against the original: the frame, and the haze (the frame with the fog zones less the frame without) against the original\'s', 'O1', effectViews('bar', {base: 'fog'}));
add('4.2.18', C2, 'mirrors', 'frame cases, child frames, nesting, the sky inside a mirror, the strobe', 'O2',
  V('mirrors'), V('child-frames'), V('mirror-plan-play'), V('mirrors-play'), V('sky-in-mirror-play'), V('strobe-mirror-play'), V('underworld-panes-play'));
add('4.2.19', C2, '02_NYC_Hotel bathroom mirror', 'an opaque unlit mirror against the original, the player in the reflection posed as the original had him', 'O1', effectViews('hotel', {playerPose: true}));
add('4.2.20', C2, 'Fire.dll textures', 'fire and water textures, animated and auto-panned surfaces', 'O2',
  V('native-fire-texture'), V('fire-texture-rust'), V('native-texture-animation'), V('native-surface-pan'), V('fire-texture-play'), V('texture-animation-play'));
add('4.2.21', C2, 'detail textures', 'the D3DDrv detail pass equals the original body; Play draws it', 'O2',
  V('detail-pass'), V('detail-pass-rust'), V('detail-play-sim'), V('detail-play'));
// The pass in a frame: Play keeps its pass (`detail`) and its frame without it is the same frame with the detail scene hidden (`base: 'detail'`).
add('4.2.22', C2, '00_Training and 01_NYC_UNATCOIsland detail pass', 'a frame with the detail pass against the original\'s with the pass poked in: the frames, and the pass\'s contribution (the frame less the frame without the pass) against the original\'s', 'O1',
  effectViews('detailT', {detail: true, base: 'detail'}), effectViews('detailI', {detail: true, base: 'detail'}));
add('4.2.23', C2, 'lasers', 'LaserIterator.CurrentItem equals the original; the Island doorway beams draw', 'O2', V('native-laser'), V('lasers-play'));
add('4.2.24', C2, '01_NYC_UNATCOIsland doorway', 'a beam frame against the original: the beams\' geometry (the beam texture is an animated fire: its sparks are not matched)', 'O1',
  effectViews('laser', {unfreeze: true, rngPin: '0x2f6e2b1b', beams: true, twin: ['laser1']}));
add('4.2.25', C2, 'viewport flash', 'EndFlash equals D3DDrv; the flash pass draws', 'O2', V('d3d-endflash'), V('flash-play'), V('player-alterations-census'));
// The flash held through ConstantGlowScale/ConstantGlowFog (a written FlashScale/FlashFog decays in a second at a held level). flashA: scale 0.5 and the
// recipe's fog (0.3,0.1,0), which ViewFlash cuts to 0 at a held tick in both programs (each step is fog * 10 * 0.005 < 0.019): the multiply branch, alpha 128.
// flashB: fog (0.6,0.45,0.4), no scale: the additive branch, alpha 255, fog bytes (153,115,102), saturating.
add('4.2.26', C2, '00_Training held viewport flash', 'two held flash states against the original\'s frames: the flash as a per-channel map of levels (each program\'s frame with it from its own frame without it) equal at every level, and the frames', 'O1',
  effectViews('flashA', {preShot: ['set DeusEx.JCDentonMale ConstantGlowScale -0.5', 'set DeusEx.JCDentonMale ConstantGlowFog (X=0.3,Y=0.1,Z=0)'], preShotWait: 5000, flashBase: FLASH_BASE}),
  effectViews('flashB', {preShot: ['set DeusEx.JCDentonMale ConstantGlowScale 0', 'set DeusEx.JCDentonMale ConstantGlowFog (X=0.6,Y=0.45,Z=0.4)'], preShotWait: 5000, flashBase: FLASH_BASE}));
add('4.2.27', C2, 'vertices and visibility', 'Render.dll\'s projection, D3DDrv\'s vertices and OccludeBsp equal the original', 'O2',
  V('frame-projection'), V('frame-projection-movers'), V('frame-projection-play'), V('bsp-occlusion'), V('master-frame-play'));
add('4.2.28', C2, 'security cameras', 'ViewportWindow windows on four maps match the original\'s computer screens', 'O1',
  CAMERA({map: '14_OceanLab_Lab', computer: 'ComputerSecurity1', user: 'Oceanguard', password: 'Kraken', cameraActor: 'SecurityCamera0', name: 'cs1', windows: 3}),
  CAMERA({map: '02_NYC_BatteryPark', computer: 'ComputerSecurity2', user: 'NSF', password: 'righteous', cameraActor: 'SecurityCamera1', name: 'bp2', windows: 3}),
  CAMERA({map: '06_HongKong_WanChai_Market', computer: 'ComputerSecurity0', user: 'TAM', password: 'DRAGON', cameraActor: 'SecurityCamera2', name: 'hk0', windows: 3}),
  CAMERA({map: '09_NYC_Ship', computer: 'ComputerSecurity3', user: 'SECURITY', password: 'Brooklyn', cameraActor: 'SecurityCamera1', name: 'sh3b', windows: 3}));
missing('4.2.29', C2, 'camera with a mirror, sky, fog or corona in view', 'a camera frame against the original', 'the thirteen captured windows look into rooms (visual-acceptance.md "What stays")');
// Both Strobe states at both cameras, one Play run per frame (each at its own clock); `strobeHeld`: each stored frame's hold record must show the flag
// its name asks for, held through the shot, the view's camera and a level clock held over the shot.
add('4.2.30', C2, '06_HongKong_WanChai_Underworld mirrored panes', 'the dance floor in the mirrored panes at a held Strobe against the original: both states (lit and dark) at two cameras, the floor seen only in the panes and two panes beside the direct floor', 'O1',
  ...EFFECT_VIEWS.uw.views.map(view => FRAMES({maps: [EFFECT_VIEWS.uw.map], explicit: [view], flat: {}, cmds: ['set ScriptedPawn bHidden True'], strobeHeld: true})));
excluded('4.2.31', C2, 'animated mesh skins and DT_SpriteAnimOnce', 'frames no shipped class, actor or script reaches', 'unreachable: documented in particles.md and texture-animation.md');
excluded('4.2.32', C2, 'UseVertexFog, Glide fog, wireframe and particle mesh branches', 'options the shipped D3D configuration does not use', 'unreachable in the shipped game (roadmap section 4, census-lodmesh-branches.mjs)');
excluded('4.2.33', C2, 'swimming and drowning visuals', 'water entry, underwater movement and the drowning flash', 'Stage 5 (swimming is a gameplay system)');

// 4.3 Sound ------------------------------------------------------------------------------------------------
add('4.3.1', C3, 'ambient and script sounds', 'PlaySound, StopSound, Update, volumes and the ambient scan equal Galaxy.dll', 'O2',
  V('native-galaxy-audio'), V('galaxy-volumes'));
add('4.3.2', C3, 'sound effects', 'sample voices and both buses\' PCM equal Galaxy.dll\'s mixer', 'O2', V('galaxy-effects'), V('galaxy-mixer'));
add('4.3.3', C3, 'zone reverb', 'reverb coefficients and the SSE kernel equal Galaxy.dll', 'O2', V('galaxy-reverb'));
add('4.3.4', C3, 'music', 'IT loader, sequencer and Update\'s music section equal Galaxy.dll', 'O2',
  V('galaxy-music-loader'), V('galaxy-music-sequencer'), V('galaxy-music-update'));
add('4.3.5', C3, 'Island, Training and the intro in Play', 'ambient voices, music and window sounds reach the mixer in the worker and the worklet', 'O3',
  V('galaxy-effects-play'), V('galaxy-music-play'), V('galaxy-music-host'), V('window-sound-play'), V('window-sound-browser'));
add('4.3.6', C3, '06_HongKong_WanChai_Underworld, 400 ticks: a pistol picked up, drawn and fired', 'the original\'s Galaxy PlaySound calls of the scene against Play\'s replay: every call\'s sound, emitter, volume, radius, pitch, channel id and order', 'O1',
  SOUNDS({map: '06_HongKong_WanChai_Underworld', tag: 'sndm5', ticks: 400}));
add('4.3.7', C3, '00_Training, captured from the launch (4,851 callbacks): Galaxy\'s output buffer', 'every byte Galaxy\'s timer callback copies into the DirectSound buffer, and where it lands, equals the translation\'s under the original\'s replayed library calls and cursor positions; Play places the music bus D bytes ahead of the effects bus, D measured; speech through Galaxy\'s ring transport against the original\'s instructions (docs/audio-output-scope.md section 6)', 'O1',
  V('galaxy-output-callback'), V('galaxy-output-poll', '--store', '.work/audio-output'), V('galaxy-output-replay', '--capture', '.work/audio-output/replay-training.bin'),
  V('galaxy-output-play'), V('galaxy-ring-voice'));

// 4.4 Text and interfaces -----------------------------------------------------------------------------------
add('4.4.1', C4, 'fonts and text layout', 'font load, glyph metrics, text layout and the parser equal the original', 'O2',
  V('font-load'), V('font-load-graph'), V('text-layout-diff'), V('text-parser-diff'), V('gc-get-text-extent'), V('gc-draw-text'));
add('4.4.2', C4, 'GC drawing', 'every GC native (draw, state, clip) equals Extension.dll', 'O2', FAMILY(/^gc-/, 'gc-*'));
add('4.4.3', C4, 'window system', 'window natives, hierarchy, focus, input, scroll and list equal Extension.dll', 'O2', FAMILY(/^window-(?!sound-play|sound-browser)/, 'window-*'));
add('4.4.4', C4, 'text and edit windows', 'TextWindow and EditWindow natives equal Extension.dll', 'O2', FAMILY(/^(text|edit)-(?!layout-diff|parser-diff)/, 'text-*, edit-*'));
add('4.4.5', C4, '00_Training HUD', 'the HUD tree, belt, ammo, log and glyph output run on the original bytecode and natives', 'O3', V('play-hud'));
add('4.4.6', C4, 'player screens and menus', 'inventory, health, augmentations, skills, goals, conversations, images, logs, quotes, augmentation add and the main menu open, draw and close; Settings screens take input', 'P',
  CENSUS({}), V('settings-play'));
add('4.4.7', C4, 'Training datacube', 'DeusExText, the parser and the information window read a datacube through the real frob path', 'O3', V('datacube-read'));
add('4.4.8', C4, 'computers and security', 'ComputerWindow playback and the terminals reach screens through the real frob path; camera screen in the browser', 'O3',
  V('window-computer'), V('window-computer-playback'), V('terminals-play'), V('terminals-camera-browser'));
add('4.4.9', C4, 'Training keypad', 'the keypad window takes input through the original path', 'O3', V('keypad'));
add('4.4.10', C4, 'InfoLink, DataLink and conversation windows', 'the DataLink transmission, the InfoLink window and conversation screens run the original bytecode', 'O3',
  V('infolink-shell'), V('infolink-content'), V('instructor-conversation'), V('conversation-tile'));
add('4.4.11', C4, '00_Training HUD', 'the HUD, belt and log in a frame against the original\'s: the health display, compass, key ring and a belt slot with its item, a log line and its timeout', 'O1',
  INTERFACE({map: '00_Training', views: CRITERIA_VIEWS['4.4.11']}));
add('4.4.12', C4, 'persona screens', 'inventory (empty and with an item), health, skills, goals and notes, logs, images, conversations and augmentations in a frame against the original\'s', 'O1',
  INTERFACE({map: '00_Training', views: CRITERIA_VIEWS['4.4.12']}));
add('4.4.13', C4, 'main menu and Settings', 'the main menu, the Settings menu, Game Options and Adjust Colors in a frame against the original\'s', 'O1',
  INTERFACE({map: '00_Training', views: CRITERIA_VIEWS['4.4.13']}));
add('4.4.14', C4, 'datacube, keypad and computer screens', 'a datacube\'s information display, the keypad and a security computer\'s screen (four maps) in a frame against the original\'s; the screen outside the camera windows', 'O1',
  INTERFACE({map: '00_Training', views: CRITERIA_VIEWS['4.4.14']}),
  TERMINAL({map: '14_OceanLab_Lab', computer: 'ComputerSecurity1', user: 'Oceanguard', password: 'Kraken', cameraActor: 'SecurityCamera0', name: 'cs1'}),
  TERMINAL({map: '02_NYC_BatteryPark', computer: 'ComputerSecurity2', user: 'NSF', password: 'righteous', cameraActor: 'SecurityCamera1', name: 'bp2'}),
  TERMINAL({map: '06_HongKong_WanChai_Market', computer: 'ComputerSecurity0', user: 'TAM', password: 'DRAGON', cameraActor: 'SecurityCamera2', name: 'hk0'}),
  TERMINAL({map: '09_NYC_Ship', computer: 'ComputerSecurity3', user: 'SECURITY', password: 'Brooklyn', cameraActor: 'SecurityCamera1', name: 'sh3'}));
excluded('4.4.15', C4, 'Load Game, Save Game, QuickSave screens', 'the save-game directory screens', 'Stage 6 (saved games; native 3013)');
excluded('4.4.16', C4, 'multiplayer menus and screens', 'the multiplayer join, host and in-game screens', 'multiplayer is the last priority and may stay unsupported (AGENTS.md)');

// 4.5 Speech, lip sync and the conversation camera ---------------------------------------------------------
add('4.5.1', C5, 'lip sync analysis', 'Galaxy.dll\'s window, FFT and letter choice equal the Rust kernel', 'O2', V('galaxy-lipsync'));
add('4.5.2', C5, '01_NYC_UNATCOIsland MeetPaul', 'speech reaches the lip-sync channels and Paul\'s mouth follows the letters', 'O3', V('island-lipsync'));
add('4.5.3', C5, '01_NYC_UNATCOIsland MeetPaul camera', 'CreateConCamera, the letterbox raw background, the render viewport clip and the player in behind view', 'O3',
  V('root-raw-background'), V('root-render-viewport'), V('conversation-move-camera'), V('island-conversation'));
add('4.5.4', C5, 'speech timing and audio', 'speech lookup, sound length and the retained archive equal the original', 'O2',
  V('conversation-speech'), V('conversation-speech-audio'), V('conversation-sound-length'), V('conversation-audio-integration'), V('infolink-audio'));
add('4.5.5', C5, 'MeetPaul frame', 'the third-person conversation frame (letterbox, behind view, camera, subtitles) against the original\'s', 'O1',
  CONVERSATION({scene: 'meetpaul', map: '01_NYC_UNATCOIsland', tag: 'cvA', playerBlend: true,
    frames: [{name: 'cvA1', tick: 100}, {name: 'cvA2', tick: 250}, {name: 'cvA3', tick: 600}, {name: 'cvA4', tick: 750}],
    liveAllow: {'@player': ['Frame'], SecurityBot0: ['LRT'], UNATCOTroop1: ['LRT']},   // measured: the player's AnimFrame at tick 1-5 (a tween phase), two guards' LastRenderTime at tick 1 (the render history before the release)
    earlyCmds: 'set WinDrv.WindowsClient Brightness 0.666667|set DeusEx.JCDentonMale Location (X=-2385,Y=8393,Z=-256.2)|set DeusEx.JCDentonMale ViewRotation (Pitch=0,Yaw=51120,Roll=0)|walk'}));
excluded('4.5.6', C5, 'speech audio', 'the speech samples the player hears against Galaxy\'s', 'the user\'s decision (2026-10-16): speech stays decoded by the browser\'s MP3 decoder, not a port of Galaxy\'s MPEG decoder; lip sync runs the translated analysis on those samples (docs/lip-sync.md)');
add('4.5.7', C5, '00_Intro camera shots', 'the intro\'s CameraPoint shots against the original', 'O1',
  CONVERSATION({scene: 'intro', map: '00_Intro', tag: 'in2', noGhost: true, keepTraveling: true,
    frames: [{name: 'in2-in1', tick: 170}, {name: 'in2-in3', tick: 1000}, {name: 'in2-in4', tick: 2250}],
    earlyCmds: 'set WinDrv.WindowsClient Brightness 0.666667'}),
  V('native-find-base'));   // the replay's first tick: SetPhysics(PHYS_None) reaches FindBase (a wrong extent put the standing player back in PHYS_Falling)
add('4.5.8', C5, '01_NYC_UNATCOHQ MeetManderley', 'a conversation on another map, with the third-person camera, lip sync and speech (the lines and their timing; the audio samples are 4.5.6)', 'O1',
  // two loads of the original (tags mmA, mmB), each with the player's blend channel; the frames are at speeches of JC and Manderley and at two cameras. mmB1 (tick 40,
  // the first speech) is stored and not compared: the letterbox is still sliding at tick 40, the original's bars finished while it was held and Play's, driven by the
  // level's ticks, are frozen mid-slide at the hold (docs/conversation-camera.md).
  CONVERSATION({scene: 'manderley', map: '01_NYC_UNATCOHQ', tag: 'mmA', playerBlend: true, liveAllow: {'@player': ['Frame']},
    frames: [{name: 'mm2', tick: 450}, {name: 'mm3', tick: 700}], earlyCmds: MANDERLEY_START}),
  CONVERSATION({scene: 'manderley', map: '01_NYC_UNATCOHQ', tag: 'mmB', playerBlend: true, liveAllow: {'@player': ['Frame']},
    frames: [{name: 'mmB2', tick: 300}, {name: 'mmB3', tick: 580}], earlyCmds: MANDERLEY_START}));

// --- runner ----------------------------------------------------------------------------------------------
const probePython = path.join(root, '.cache/native-probe-env/bin/python');
// The real-x87 validators run a small probe executable under Wine (never DeusEx.exe) when X87_PROBE_WINE names one.
const wineBinary = ['/usr/bin/wine'].find(existsSync), winePrefix = path.join(process.env.HOME ?? '', '.wine-deusex');
const baseEnv = {...process.env, ...(existsSync(probePython) && !process.env.NATIVE_PROBE_PYTHON ? {NATIVE_PROBE_PYTHON: path.relative(root, probePython)} : {}),
  ...(wineBinary && !process.env.X87_PROBE_WINE ? {X87_PROBE_WINE: wineBinary} : {}), ...(wineBinary && !process.env.WINEPREFIX && existsSync(winePrefix) ? {WINEPREFIX: winePrefix} : {})};
const timingsFile = [path.join(root, '.cache/validator-timings.json'), path.join(mainCheckout, '.cache/validator-timings.json')].find(existsSync);
const timings = (() => { try { return JSON.parse(readFileSync(timingsFile, 'utf8')); } catch { return {}; } })();
const memories = (() => { try { return JSON.parse(readFileSync(timingsFile.replace('timings', 'memory'), 'utf8')); } catch { return {}; } })();
const timeoutScale = Number(flag('--timeout-scale', 1));
const memCap = Number(flag('--mem-cap', 6144)), memBudget = Number(flag('--mem-budget', 16384));
const jobs = Math.max(1, Number(flag('--jobs', 2)));
const q = text => /[^\w@%+=:,./-]/.test(text) ? `'${text.replace(/'/g, `'\\''`)}'` : text;

const scriptFiles = readdirSync(path.join(root, 'scripts'));
// The ignored local data a validator names under .work/ (captures it reads): for --list, so a missing store shows before a run.
const workRefs = file => {
  try {
    const refs = [...new Set([...readFileSync(path.join(root, 'scripts', file), 'utf8').matchAll(/\.work\/[A-Za-z0-9_.\/-]+/g)].map(m => m[0]))];
    return refs.length ? ` reads ${refs.slice(0, 3).join(' ')}` : '';
  } catch { return ''; }
};
// How a validator exercises Play, from its source: `worker` (a headless Chromium on Play's default page, the simulation in the worker),
// `inline` (it forces ?sim=inline: the page's own simulation, not the default), `oracle` (the original's code under Unicorn or a
// probe, no page) or `node` (Play's simulation modules driven headless in Node, no page).
const modeOf = file => {
  let text;
  try { text = readFileSync(path.join(root, 'scripts', file), 'utf8'); } catch { return 'node'; }
  if (/chromium|playwright/i.test(text)) return /goto\(.*sim=inline/.test(text) ? 'inline' : 'worker';
  return /NATIVE_PROBE_PYTHON|native-probe|oracle/i.test(text) ? 'oracle' : 'node';
};
const validatorFile = name => `validate-${name}.mjs`;

/** Expand a check into tasks: {key, label, cmd, args, env, mutex, estimate, memory, judge(output, code) -> {status, detail}, prepare()}. */
function expand(check, criterion) {
  const labelOf = c => c.label ?? `${c.type}`;
  if (check.type === 'validator') {
    const file = validatorFile(check.name);
    if (!scriptFiles.includes(file)) return [{key: `${criterion.id}:${check.name}`, label: check.name, error: `scripts/${file} does not exist`}];
    const special = check.name === 'original-light-tables' ? ['original'] : [];
    return [{key: `${criterion.id}:${check.name}`, label: check.name, cmd: process.execPath, args: [path.join('scripts', file), ...check.args],
      estimate: (timings[file] ?? 60000) / 1000, memory: memories[file] ?? 1536, validator: file, special, mode: modeOf(file)}];
  }
  if (check.type === 'family') {
    return scriptFiles.filter(f => f.startsWith('validate-') && f.endsWith('.mjs') && check.pattern.test(f.slice(9, -4)))
      .map(file => ({key: `${criterion.id}:${file.slice(9, -4)}`, label: file.slice(9, -4), cmd: process.execPath, args: [path.join('scripts', file)],
        estimate: (timings[file] ?? 5000) / 1000, memory: memories[file] ?? 600, validator: file, mode: modeOf(file)}));
  }
  if (check.type === 'frames') {
    const name = `frames ${check.maps.join(',')}${check.explicit ? ` [${check.explicit.map(v => v.split(':')[0]).join(',')}]` : ''}`;
    return [{key: `${criterion.id}:${name}`, label: name, frames: check, mutex: ['acceptance'], estimate: 30 * check.maps.length + 20, memory: 1500}];
  }
  if (check.type === 'interface') return [{key: `${criterion.id}:interface ${check.map}`, label: `interface ${check.map} (${check.views.length} views)`, interface: check, mutex: ['acceptance'], estimate: 120, memory: 1800}];
  if (check.type === 'terminal') return [{key: `${criterion.id}:terminal ${check.name}`, label: `terminal ${check.map} ${check.name}`, terminal: check, mutex: ['acceptance'], estimate: 120, memory: 1800}];
  if (check.type === 'camera') return [{key: `${criterion.id}:camera ${check.name}`, label: `camera ${check.map} ${check.name}`, camera: check, mutex: ['acceptance'], estimate: 120, memory: 1800}];
  if (check.type === 'live') return [{key: `${criterion.id}:live ${check.map}${check.tag ? ` ${check.tag}` : ''}`, label: `live ${check.map}${check.tag ? ` (${check.tag})` : ''}`, live: check, mutex: check.shot ? [`live:${check.map}`, 'acceptance'] : [`live:${check.map}`], estimate: 120, memory: 1500}];
  // one task per scene: the frames' replays share the tag's play-rows file, so they run one after the other
  if (check.type === 'conversation') return [{key: `${criterion.id}:conversation ${check.scene} ${check.tag}`, label: `conversation ${check.map} ${check.tag} (${check.frames.length} frames)`, conversation: check, mutex: [`live:${check.map}`, 'acceptance'],
    estimate: 130 * check.frames.length, memory: 1800}];
  if (check.type === 'sounds') return [{key: `${criterion.id}:sounds ${check.map} ${check.tag}`, label: `sounds ${check.map} (${check.tag})`, sounds: check, mutex: [`live:${check.map}`], estimate: 200, memory: 1500}];
  if (check.type === 'sweep') return [{key: `${criterion.id}:sweep`, label: `sweep replay ${check.maps.length} maps`, sweep: check, mutex: ['live-sweep'], estimate: 75 * check.maps.length, memory: 1500}];
  if (check.type === 'census') return [{key: `${criterion.id}:census-ui-screens`, label: 'census-ui-screens', census: check, estimate: 150, memory: 1500}];
  return [{key: `${criterion.id}:${labelOf(check)}`, label: labelOf(check), error: `unknown check type ${check.type}`}];
}

// --- executing a task -------------------------------------------------------------------------------------
const running = new Set();
let peakTotal = 0;
const sampler = setInterval(() => {
  if (!running.size) return;
  let table;
  try { table = execFileSync('ps', ['-A', '-o', 'pid=,pgid=,rss='], {encoding: 'utf8'}); } catch { return; }
  const byGroup = new Map();
  const wanted = new Set([...running].map(job => job.pgid));
  for (const line of table.trim().split('\n')) {
    const [, pgid, rss] = line.trim().split(/\s+/).map(Number);
    if (wanted.has(pgid)) byGroup.set(pgid, (byGroup.get(pgid) ?? 0) + rss / 1024);
  }
  let total = 0;
  for (const job of running) {
    job.current = byGroup.get(job.pgid) ?? 0;
    job.peak = Math.max(job.peak, job.current);
    total += job.current;
    if (job.current > memCap && !job.killed) kill(job, `memory cap: ${job.current.toFixed(0)} MiB > ${memCap} MiB`);
    if (Date.now() - job.begin > job.limit && !job.killed) kill(job, `timeout after ${Math.round((Date.now() - job.begin) / 1000)} s (limit ${Math.round(job.limit / 1000)} s)`);
  }
  peakTotal = Math.max(peakTotal, total);
}, 500);
sampler.unref();
const kill = (job, reason) => { job.killed = reason; try { process.kill(-job.pgid, 'SIGKILL'); } catch { /* gone */ } };

/** Run a command in its own process group; resolves {code, out, seconds, peak, killed}. */
function exec(cmd, args, {env = baseEnv, limitSeconds = 600} = {}) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, {cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true});
    const job = {pgid: child.pid, current: 0, peak: 0, begin: Date.now(), limit: limitSeconds * 1000 * timeoutScale, killed: null};
    running.add(job);
    let out = '';
    const take = chunk => { out += chunk; if (out.length > 6e6) out = out.slice(-3e6); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    child.on('close', code => {
      running.delete(job);
      resolve({code, out, seconds: (Date.now() - job.begin) / 1000, peak: job.peak, killed: job.killed});
    });
  });
}
const tail = (text, n = 6) => text.trim().split('\n').slice(-n).map(line => line.slice(0, 200)).join(' | ');

async function runTask(task) {
  if (task.error) return {status: 'FAIL', detail: task.error, seconds: 0, peak: 0};
  const result = {seconds: 0, peak: 0};
  const add = r => { result.seconds += r.seconds; result.peak = Math.max(result.peak, r.peak); return r; };
  const limit = Math.max(600, 4 * task.estimate);
  const fail = (detail, status = 'FAIL') => ({...result, status, detail});
  if (task.validator) {
    let args = task.args;
    const absentOriginals = (VALIDATOR_ORIGINALS[task.label] ?? []).filter(relative => !stage(relative, {copy: true}));
    if (absentOriginals.length) return fail(`stored originals absent: ${absentOriginals.join(', ')}`, 'NO-ORIGINAL');
    if (task.special?.includes('original')) {
      const dir = findStored('fpu');
      if (dir) args = [...args, dir];
    }
    const r = add(await exec(task.cmd, args, {limitSeconds: limit}));
    if (r.killed) return fail(r.killed);
    if (r.code !== 0) return fail(`exit ${r.code}: ${tail(r.out)}`);
    if (/^SKIP /m.test(r.out)) return fail(tail(r.out.split('\n').filter(l => /^SKIP /.test(l)).join('\n'), 2), 'SKIPPED');
    return {...result, status: task.mode === 'inline' ? 'INLINE' : 'PASS', detail: (task.mode === 'inline' ? 'passes, but forces ?sim=inline (not the default worker mode): ' : '') + tail(r.out, 1)};
  }
  if (task.frames) return judgeFrames(task, add, fail, result);
  if (task.interface) return judgeInterface(task, add, fail, result);
  if (task.terminal) return judgeTerminal(task, add, fail, result);
  if (task.camera) return judgeCamera(task, add, fail, result);
  if (task.live) return judgeLive(task, add, fail, result);
  if (task.conversation) return judgeConversation(task, add, fail, result);
  if (task.sweep) return judgeSweep(task, add, fail, result);
  if (task.sounds) return judgeSounds(task, add, fail, result);
  if (task.census) return judgeCensus(task, add, fail, result);
  return fail('no runner');
}

// Stored originals a validator compares with when this checkout has them (it falls back to fabricated cases without them, which would
// prove less than the criterion says), so the gate stages them and reports NO-ORIGINAL when they are absent.
const VALIDATOR_ORIGINALS = {'weapon-attach': ['weapon/original-cases.json', 'weapon/original-cases-2.json', 'weapon/original-cases-3.json'],
  'galaxy-output-poll': ['training-load1', 'training-load2'].flatMap(poll => ['.json', '.pan.bin', '.poll.txt'].map(ext => `audio-output/${poll}${ext}`)),
  'galaxy-output-replay': ['audio-output/replay-training.bin']};
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

// One frame's metrics against THRESHOLDS: the list of what is off.
function frameProblems(m, isFlat = false, allowedBlocks = 0) {
  const off = [];
  if (m.edgeRecall < THRESHOLDS.edgeRecall) off.push(`edge recall ${m.edgeRecall} < ${THRESHOLDS.edgeRecall}`);
  if (!isFlat && m.edgePrecision < THRESHOLDS.edgePrecision) off.push(`edge precision ${m.edgePrecision} < ${THRESHOLDS.edgePrecision}`);
  if (m.outlierBlocks.length > THRESHOLDS.outlierBlocks + allowedBlocks) off.push(`${m.outlierBlocks.length} outlier blocks (${m.outlierBlocks.slice(0, 3).map(b => b.join(':')).join(' ')})`);
  if (m.subpixel && (Math.abs(m.subpixel[0]) > THRESHOLDS.subpixel || Math.abs(m.subpixel[1]) > THRESHOLDS.subpixel)) off.push(`sub-pixel offset ${m.subpixel}`);
  return off;
}
// One view's effect contribution against THRESHOLDS: Play's difference of the frame with and without the effect against the original's.
function beamProblems(m) {
  const c = m.beams, off = [];
  if (!c) return ['no beam metrics'];
  if (!(c.coverage >= THRESHOLDS.beamCoverage)) off.push(`beam coverage ${c.coverage} < ${THRESHOLDS.beamCoverage}`);
  if (!(c.energy >= THRESHOLDS.beamEnergyLow && c.energy <= THRESHOLDS.beamEnergyHigh)) off.push(`beam energy ${c.energy} outside ${THRESHOLDS.beamEnergyLow}..${THRESHOLDS.beamEnergyHigh}`);
  if (!(c.yRms <= THRESHOLDS.beamYRms)) off.push(`beam y offset ${c.yRms} px rms > ${THRESHOLDS.beamYRms}`);
  return off;
}
// The viewport flash as a map of levels against THRESHOLDS: the original's and Play's output level for every input level both frames hold.
function flashProblems(m) {
  const f = m.flashMap, off = [];
  if (!f) return ['no flash map (the frames without the flash are absent)'];
  if (!f.levels) off.push('no input level shared by the two frames without the flash');
  if (f.differing > THRESHOLDS.flashMapDiffering) off.push(`flash map: ${f.differing} of ${f.levels} levels differ (${f.firstDiffering.join(' ')}, original/Play)`);
  if (f.straysOriginal > THRESHOLDS.flashMapStrays || f.straysPlay > THRESHOLDS.flashMapStrays) off.push(`flash map: ${f.straysOriginal} / ${f.straysPlay} stray samples (original / Play)`);
  return off;
}
// The shadows' state at the shot (visual-acceptance.mjs `compare --decal-state`): every Shadow of the original found in Play by its owner, the same
// shadows drawn in the frame, each attached to as many surfaces with the same bHasDecal, and, attached in either, its owner at the same float32
// Location; attached in both, the decal's Location, DrawScale (float32) and Rotation equal. No tolerance: the inputs of the frame are held, not near.
function decalStateProblems(m) {
  const d = m.decalState, off = [];
  if (!d) return ['no decal state (<view>-decals.json or <view>-play-decals.json absent)'];
  if (d.unmatched.length) off.push(`shadows in one program only: ${d.unmatched.slice(0, 4).join(', ')}`);
  if (d.drawn[0].join() !== d.drawn[1].join()) off.push(`drawn shadows ${d.drawn[0].join(',')} / ${d.drawn[1].join(',')} (original / Play)`);
  if (d.differing.length) off.push(`${d.differing.length} shadows differ (${d.differing.slice(0, 3).join(' | ')})`);
  return off;
}
// A frame taken at a held Strobe (<name>_s0 / _s1): the original's hold record (visual-acceptance.mjs `original`, <view>-strobe-held.txt) shows the
// flip patched out (byte 0xeb at 0x10b05b4b), the name's flag written, the same flag and kept time polled after the shot, the view's camera before
// and after the shot, and a level time that moved under 0.01 s between those two reads.
function strobeHeldProblems(map, name, spec) {
  const want = /_s([01])$/.exec(name)?.[1], file = path.join(root, '.work/acceptance', map, `${name}-strobe-held.txt`);
  if (want === undefined) return [`${name}: no _s0/_s1 in the name`];
  if (!existsSync(file)) return [`no hold record (${name}-strobe-held.txt)`];
  const lines = readFileSync(file, 'utf8').split('\n'), line = label => lines.find(l => l.startsWith(`${label}: `)) ?? '';
  const held = /^hold: byte 0xeb flag=(\d) time=(\S+)/.exec(line('hold')), polled = /^poll after shot: \d+ flag=(\d) time=(\S+)/.exec(line('poll after shot'));
  if (!held) return [`the hold record does not show the flip patched out: ${line('hold')}`];
  const off = [];
  if (held[1] !== want) off.push(`held flag ${held[1]}, the view asks for ${want}`);
  if (!polled || polled[1] !== held[1] || polled[2] !== held[2]) off.push(`the flag or kept time moved by the shot: ${line('hold')} / ${line('poll after shot')}`);
  if (spec) {
    const [, at, rotation] = spec.split(':'), camera = `Location=(${at}) ViewRotation=(${rotation})`;
    for (const label of ['before shot', 'after shot']) if (!line(label).endsWith(camera)) off.push(`camera ${label}: ${line(label)}, the view's is ${camera}`);
  }
  // the clock held at the shot: seconds of wall time between the two reads are thousandths of a second of level time at the held dilation 0.001
  const [t0, t1] = ['before shot', 'after shot'].map(label => Number(/level time (\S+)/.exec(line(label))?.[1]));
  if (!(t1 - t0 >= 0 && t1 - t0 < 0.01)) off.push(`the level time ran from ${t0} to ${t1} over the shot (not held)`);
  return off;
}
const flashBasePlays = new Map();
function contributionProblems(m, {floor = false} = {}) {
  const c = m.contribution, off = [];
  if (!c) return ['no contribution measured'];
  if (!c.effectPixels) off.push('the original shows no contribution');
  if (!(c.correlation >= THRESHOLDS.contributionCorrelation)) off.push(`contribution correlation ${c.correlation} < ${THRESHOLDS.contributionCorrelation}`);
  if (!(Math.abs(c.gap / m.ratio - 1) <= THRESHOLDS.contributionGap)) off.push(`contribution gap ${c.gap} against the frame's ratio ${m.ratio}`);
  // (floor: judged against the original's own frames instead, judgeLive)
  if (!floor && !(c.agreement >= THRESHOLDS.contributionAgreement)) off.push(`contribution agreement ${c.agreement} < ${THRESHOLDS.contributionAgreement}`);
  return off;
}
// matched frames -----------------------------------------------------------------------------------------
async function judgeFrames(task, add, fail, result) {
  const {maps, views, explicit, flat = {}} = task.frames;
  const names = explicit ? explicit.map(v => v.split(':')[0]) : views;
  // `flashBase`: the view without the flash is staged from the same store (its frame and clock) and played in a run of its own.
  const baseName = task.frames.flashBase?.split(':')[0] ?? null, staged = baseName ? [...names, baseName] : names;
  // One store supplies the whole run: the first root that holds the first frame. Its times.json (the level time each map was held at) goes
  // with it, since a map captured twice (the frozen set at 46.8 s, the effect views at 52.3 s) has a clock per capture.
  // The files a view needs from the store: its frame; with a contribution check (`base`) the original without the effect; with `playerPose`
  // the player's animation the original measured.
  const storedFiles = name => [`${name}-original.png`, ...(task.frames.base ? [`${name}-base-original.png`] : []), ...(task.frames.playerPose ? [`${name}-state.json`] : []),
    ...(task.frames.twin?.includes(name) ? [`${name}b-original.png`] : []), ...(task.frames.decalState ? [`${name}-decals.json`] : []),
    ...(task.frames.strobeHeld ? [`${name}-strobe-held.txt`] : [])];
  const source = storeRoots.find(dir => existsSync(path.join(dir, `acceptance/${maps[0]}/${names[0]}-original.png`)));
  const absent = [];
  if (!source) absent.push(`acceptance/${maps[0]}/${names[0]}-original.png`);
  else for (const map of maps) for (const name of staged) for (const file of storedFiles(name)) if (!existsSync(path.join(source, `acceptance/${map}/${file}`))) absent.push(`acceptance/${map}/${file}`);
  // A frame keeps its own clock beside it (<view>-time.txt, written by `visual-acceptance.mjs original`); the older captures have one clock per
  // map in times.json, which the run then needs.
  const hasTime = (map, name) => existsSync(path.join(source ?? '', `acceptance/${map}/${name}-time.txt`));
  const needsTimes = source && maps.some(map => staged.some(name => !hasTime(map, name)));
  if (needsTimes && !existsSync(path.join(source, 'acceptance/times.json'))) absent.push('acceptance/times.json');
  if (absent.length) return fail(`stored originals absent: ${absent.slice(0, 4).join(', ')}${absent.length > 4 ? ` +${absent.length - 4}` : ''}`, 'NO-ORIGINAL');
  for (const map of maps) {
    mkdirSync(path.join(root, '.work/acceptance', map), {recursive: true});
    for (const name of staged) {
      // A checkout that holds the originals itself (its own captures) is its own source: nothing is linked or copied over a file onto itself
      // (unlinking the target would delete the original).
      const bring = (file, copy) => {
        const from = path.join(source, `acceptance/${map}/${file}`), to = path.join(root, '.work/acceptance', map, file);
        if (path.resolve(from) === path.resolve(to)) return;
        try { unlinkSync(to); } catch { /* none yet */ }
        if (copy) copyFileSync(from, to); else symlinkSync(from, to);
      };
      for (const file of storedFiles(name)) bring(file, file.endsWith('.json') || file.endsWith('.txt'));
      if (hasTime(map, name)) bring(`${name}-time.txt`, true);
    }
  }
  if (needsTimes && path.resolve(source) !== path.resolve(path.join(root, '.work'))) {
    const timesTo = path.join(root, '.work/acceptance/times.json');
    try { unlinkSync(timesTo); } catch { /* none yet */ }
    copyFileSync(path.join(source, 'acceptance/times.json'), timesTo);
  }
  const viewArgs = explicit ? explicit.flatMap(v => ['--view', v]) : [];
  // Play's frame without the flash, at the base's own clock: one run per gate, shared by the flash states (the 'acceptance' mutex orders them).
  if (task.frames.flashBase) {
    const key = `${maps.join(',')}:${task.frames.flashBase}`;
    if (!flashBasePlays.has(key)) flashBasePlays.set(key, exec(process.execPath, ['scripts/visual-acceptance.mjs', 'play', '--maps', maps.join(','), '--query', 'antialias=0',
      '--view', task.frames.flashBase], {limitSeconds: 900}));
    const basePlay = await flashBasePlays.get(key);
    if (!basePlay.counted) { basePlay.counted = true; add(basePlay); }
    if (basePlay.killed || basePlay.code !== 0 || /errors:/.test(basePlay.out)) return fail(`play step (${baseName}): ${basePlay.killed ?? tail(basePlay.out)}`);
  }
  // `detail`: the original was captured with the detail pass poked in (--poke D3DRenderDevice0:0x78:1), so Play keeps its pass.
  const play = add(await exec(process.execPath, ['scripts/visual-acceptance.mjs', 'play', '--maps', maps.join(','), '--query', 'antialias=0', ...(task.frames.detail ? ['--detail', 'on'] : []),
    ...(task.frames.base ? ['--base', task.frames.base] : []), ...(task.frames.playerPose ? ['--player-pose'] : []),
    ...(task.frames.unfreeze ? ['--unfreeze'] : []), ...(task.frames.rngPin ? ['--rng-pin', task.frames.rngPin] : []), ...(task.frames.decalState ? ['--decal-state'] : []),
    ...(task.frames.cmds ?? []).flatMap(line => ['--cmd', line]), ...(task.frames.cameraTransit ? ['--camera-transit'] : []),
    ...(task.frames.preShot ?? []).flatMap(line => ['--pre-shot-cmd', line]), ...(task.frames.preShotWait ? ['--pre-shot-wait', String(task.frames.preShotWait)] : []), ...viewArgs], {limitSeconds: 900}));
  if (play.killed || play.code !== 0 || /errors:/.test(play.out)) return fail(`play step: ${play.killed ?? tail(play.out)}`);
  const compare = add(await exec(process.execPath, ['scripts/visual-acceptance.mjs', 'compare', '--maps', maps.join(','), ...(task.frames.base ? ['--contribution'] : []), ...(task.frames.beams ? ['--beams'] : []),
    ...(task.frames.decalState ? ['--decal-state'] : []),
    ...(task.frames.flashBase ? ['--flash-base', baseName, '--view', task.frames.flashBase] : []), ...viewArgs], {limitSeconds: 300}));
  if (compare.killed || compare.code !== 0) return fail(`compare step: ${compare.killed ?? tail(compare.out)}`);
  const report = readJson(path.join(root, '.work/acceptance/report.json'));
  const problems = [];
  const lines = [];
  // With a flash base, the frame without the flash is judged as a frame too (the screen clear and the scene the flash is mapped from).
  for (const map of maps) for (const name of baseName ? [baseName, ...names] : names) {
    const m = report[map]?.[name];
    if (!m) { problems.push(`${map} ${name}: no comparison`); continue; }
    const isFlat = FLAT_VIEWS.has(`${map}:${name}`);
    const off = frameProblems(m, isFlat, EXPLAINED_BLOCKS[`${map}:${name}`] ?? 0);
    if (task.frames.base) off.push(...contributionProblems(m));
    if (task.frames.beams) off.push(...beamProblems(m));
    if (task.frames.flashBase && name !== baseName) off.push(...flashProblems(m));
    if (task.frames.decalState) off.push(...decalStateProblems(m));
    if (task.frames.strobeHeld) off.push(...strobeHeldProblems(map, name, explicit?.find(v => v.split(':')[0] === name)));
    if (off.length) problems.push(`${map} ${name}: ${off.join('; ')}`);
    lines.push(`${name} ${m.edgeRecall}/${m.edgePrecision}/${m.outlierBlocks.length}${m.contribution ? ` ${{decal: 'decals', detail: 'detail'}[task.frames.base] ?? 'haze'} r ${m.contribution.correlation}` : ''}${m.beams ? ` beams ${m.beams.coverage}/${m.beams.energy}/${m.beams.yRms}` : ''}${m.flashMap ? ` flash ${m.flashMap.levels - m.flashMap.differing}/${m.flashMap.levels} levels equal, fog (${m.flashMap.zero})` : ''}${m.decalState ? ` shadows ${m.decalState.matched - m.decalState.differing.length}/${m.decalState.shadows} equal (${m.decalState.attached[0]} attached)` : ''}`);
  }
  if (problems.length) return fail(problems.join(' | '));
  return {...result, status: 'PASS', detail: `${maps.length} map(s), ${lines.length} view(s): recall/precision/outliers ${lines.slice(0, 5).join(' ')}${lines.length > 5 ? ' ...' : ''}`};
}

// the interface ----------------------------------------------------------------------------------------------
// The scenario is one sequence (the log's lines and the notes accumulate from view to view): Play runs all 18 views once per map, in order, and
// each criterion judges its own views from the shared report. The criteria's tasks run one after another (the 'acceptance' mutex), so the first
// does the run and the others read it.
const interfaceRuns = new Map();
async function judgeInterface(task, add, fail, result) {
  const {map, views} = task.interface;
  const needed = [...new Set([...views, INTERFACE_ORDER[0]])];
  const absent = missingFiles(needed.flatMap(view => [[`acceptance/${map}/${view}-original.png`], [`acceptance/${map}/${view}-time.txt`, {copy: true}]]));
  if (absent.length) return fail(`stored originals absent: ${absent.slice(0, 4).join(', ')}${absent.length > 4 ? ` +${absent.length - 4}` : ''}`, 'NO-ORIGINAL');
  if (!interfaceRuns.has(map)) interfaceRuns.set(map, (async () => {
    const play = await exec(process.execPath, ['scripts/interface-acceptance.mjs', 'play', '--map', map, '--suffix', 'gate'], {limitSeconds: 900});
    if (play.killed || play.code !== 0 || /ERRORS/.test(play.out)) return {play, error: `play step: ${play.killed ?? tail(play.out)}`};
    const compare = await exec(process.execPath, ['scripts/interface-acceptance.mjs', 'compare', '--map', map, '--suffix', 'gate'], {limitSeconds: 600});
    if (compare.killed || compare.code !== 0) return {play, compare, error: `compare step: ${compare.killed ?? tail(compare.out)}`};
    return {play, compare, report: readJson(path.join(root, `.work/acceptance/${map}/interface-gate-report.json`))};
  })());
  const run = await interfaceRuns.get(map);
  if (!run.counted) { run.counted = true; for (const r of [run.play, run.compare]) if (r) add(r); }
  if (run.error) return fail(run.error);
  const T = INTERFACE_THRESHOLDS, problems = [], lines = [];
  for (const view of views) {
    const m = run.report[view];
    if (!m || m.error) { problems.push(`${view}: ${m?.error ?? 'no comparison'}`); continue; }
    const off = [];
    if (m.identical < T.identical) off.push(`${(m.identical * 100).toFixed(2)}% identical < ${T.identical * 100}%`);
    if (m.over10 > T.over10) off.push(`${m.over10} pixels off by more than 10 > ${T.over10}`);
    if (m.mad > T.mad) off.push(`MAD ${m.mad} > ${T.mad}`);
    if (m.edgeRecall < T.edge || m.edgePrecision < T.edge) off.push(`edges ${m.edgeRecall}/${m.edgePrecision} < ${T.edge}`);
    if (m.outlierBlocks > T.outlierBlocks) off.push(`${m.outlierBlocks} outlier blocks`);
    if (off.length) problems.push(`${view}: ${off.join('; ')}`);
    lines.push(`${view.slice(3)} ${m.identical}/${m.over10}`);
  }
  if (problems.length) return fail(problems.join(' | '));
  return {...result, status: 'PASS', detail: `${views.length} view(s), identical share / pixels off by more than 10: ${lines.slice(0, 5).join(' ')}${lines.length > 5 ? ' ...' : ''}`};
}

// security cameras ----------------------------------------------------------------------------------------
// One Play run per computer serves both its camera windows (4.2.28) and its terminal screen (4.4.14): the tasks run one after another (the
// 'acceptance' mutex), the first does the run and later ones read its frame.
const cameraPlays = new Map();
async function cameraPlay(c, add) {
  const key = `${c.map}:${c.name}`;
  if (!cameraPlays.has(key)) cameraPlays.set(key, exec(process.execPath, ['scripts/camera-acceptance.mjs', 'play', '--map', c.map, '--computer', c.computer, '--user', c.user,
    '--password', c.password, '--camera-actor', c.cameraActor, '--name', c.name, '--suffix', 'gate', '--antialias', 'off'], {limitSeconds: 1500}));
  const play = await cameraPlays.get(key);
  if (!play.counted) { play.counted = true; add(play); }
  return play;
}
// The terminal screen outside the camera windows (4.4.14): the interface the original draws around the views, which the camera windows' own metrics skip.
// The four stored frames read 0 pixels off by more than 2 of 255 outside the windows (the largest difference 0 to 2); a few pixels of margin.
const TERMINAL_OVER2 = 20, TERMINAL_OVER10 = 0;
async function judgeTerminal(task, add, fail, result) {
  const c = task.terminal;
  const absent = missingFiles([[`acceptance/${c.map}/${c.name}-original.png`], [`acceptance/${c.map}/${c.name}-state.json`, {copy: true}]]);
  if (absent.length) return fail(`stored originals absent: ${absent.join(', ')}`, 'NO-ORIGINAL');
  const play = await cameraPlay(c, add);
  if (play.killed || play.code !== 0) return fail(`play step: ${play.killed ?? tail(play.out)}`);
  const chrome = add(await exec(process.execPath, ['scripts/camera-acceptance.mjs', 'chrome', '--map', c.map, '--name', c.name, '--suffix', 'gate'], {limitSeconds: 300}));
  if (chrome.killed || chrome.code !== 0) return fail(`chrome step: ${chrome.killed ?? tail(chrome.out)}`);
  const row = JSON.parse(chrome.out.trim().split('\n').filter(line => line.startsWith('{')).at(-1));
  if (row.over2 > TERMINAL_OVER2 || row.over10 > TERMINAL_OVER10)
    return fail(`${c.map} ${c.name}: ${row.over2} pixels off by more than 2 and ${row.over10} by more than 10 outside the camera windows (of ${row.outsidePixels})`);
  return {...result, status: 'PASS', detail: `${c.name}: ${row.outsidePixels} pixels outside the camera windows, ${row.over2} off by more than 2 (largest difference ${row.maxDifference})`};
}
async function judgeCamera(task, add, fail, result) {
  const c = task.camera;
  const absent = missingFiles([[`acceptance/${c.map}/${c.name}-original.png`], [`acceptance/${c.map}/${c.name}-state.json`, {copy: true}]]);
  if (absent.length) return fail(`stored originals absent: ${absent.join(', ')}`, 'NO-ORIGINAL');
  const play = await cameraPlay(c, add);
  if (play.killed || play.code !== 0) return fail(`play step: ${play.killed ?? tail(play.out)}`);
  const compare = add(await exec(process.execPath, ['scripts/camera-acceptance.mjs', 'compare', '--map', c.map, '--name', c.name, '--suffix', 'gate'], {limitSeconds: 300}));
  if (compare.killed || compare.code !== 0) return fail(`compare step: ${compare.killed ?? tail(compare.out)}`);
  const rows = compare.out.trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  if (!rows.length) return fail('no window metrics');
  const problems = [];
  for (const row of rows) {
    const off = [];
    if (row.mad > THRESHOLDS.cameraMad) off.push(`MAD ${row.mad} > ${THRESHOLDS.cameraMad}`);
    if (row.edgeRecall < THRESHOLDS.cameraRecall) off.push(`recall ${row.edgeRecall}`);
    if (row.edgePrecision < THRESHOLDS.cameraRecall) off.push(`precision ${row.edgePrecision}`);
    if (off.length) problems.push(`window ${row.window}: ${off.join(', ')}`);
  }
  if (problems.length) return fail(`${c.map} ${c.name}: ${problems.join('; ')}`);
  return {...result, status: 'PASS', detail: `${rows.length} windows, MAD ${rows.map(r => r.mad).join('/')}, recall ${rows.map(r => r.edgeRecall).join('/')}`};
}

// live scenes ----------------------------------------------------------------------------------------------
// The original's inputs of a traced load: its per-tick trace (symlinked, tens of MB), the watch and population lists, the commands it
// was typed and the held Strobe state (copied). A tagged run prefers `<base>-<tag>.<ext>` and falls back to the untagged name; one
// store root supplies all of them (the first root holding the trace), so files of two runs never mix. Play's own outputs are never staged.
const LIVE_BASES = [['original-trace', '.jsonl', 'link', true], ['original-trace', '.jsonl.strobe', 'link', false], ['watch', '.json', 'copy', true], ['population', '.json', 'copy', true],
  ['commands', '.json', 'copy', false], ['deferred', '.json', 'copy', false], ['hold', '.json', 'copy', false], ['registry-start', '.txt', 'copy', false],
  ['fire', '.json', 'copy', false]];   // fire<tag>.json: the held FireTextures' pixels at the original's frames (`original --fire-hold`)
function stageLive(map, tag, into = '.work/live-acceptance') {
  const s = tag ? `-${tag}` : '';
  const traceName = `original-trace${s}.jsonl`;
  // the first root holding the trace and every required list (a root with a partial set, such as this checkout's own after an interrupted staging, is passed over)
  const holdsAll = dir => LIVE_BASES.every(([base, ext, , required]) => !required || [`${base}${s}${ext}`, `${base}${ext}`].some(name => existsSync(path.join(dir, 'live-acceptance', map, name))));
  const sourceRoot = storeRoots.find(dir => existsSync(path.join(dir, 'live-acceptance', map, traceName)) && holdsAll(dir))
    ?? storeRoots.find(dir => existsSync(path.join(dir, 'live-acceptance', map, traceName)));
  if (!sourceRoot) return [`${map}/${traceName}`];
  const absent = [];
  const targetDir = path.join(root, into, map);
  mkdirSync(targetDir, {recursive: true});
  for (const [base, ext, how, required] of LIVE_BASES) {
    const names = [`${base}${s}${ext}`, `${base}${ext}`];
    const found = names.find(name => existsSync(path.join(sourceRoot, 'live-acceptance', map, name)));
    if (!found) { if (required) absent.push(`${map}/${names[0]}`); continue; }
    const to = path.join(targetDir, found);
    // The real file behind any chain of links: a store root can hold links an earlier staging made (this checkout's own .work is the first root,
    // and live-sweep's replay links the trace from --from back into it), so linking to the link itself made a loop the second time (2026-10-16:
    // the sweep's trace pointed at itself and the replay found "no stored trace").
    let from;
    try { from = realpathSync(path.join(sourceRoot, 'live-acceptance', map, found)); } catch { if (required) absent.push(`${map}/${found}`); continue; }
    // What is already in place stays: the target is that file, or already leads to it.
    let current = null;
    try { current = realpathSync(to); } catch { /* none yet, or a broken link */ }
    if (current === from) continue;
    try { unlinkSync(to); } catch { /* none yet */ }
    if (how === 'copy') copyFileSync(from, to); else symlinkSync(from, to);
    // the sweep's replay and compare read `watch-<tag>.json` / `population-<tag>.json` by the tag
    if (found !== names[0] && /^(watch|population)$/.test(base)) { const tagged = path.join(targetDir, names[0]); try { unlinkSync(tagged); } catch { /* none */ } copyFileSync(from, tagged); }
  }
  return absent;
}
async function judgeLive(task, add, fail, result) {
  const {map, tag = null, shot = null, earlyCmds = null, renderHistory = false, baseShot = false, floorShots = 0, fireHold = false} = task.live;
  const absent = stageLive(map, tag);
  if (shot) { if (!stage(`acceptance/${map}/${shot}-original.png`)) absent.push(`acceptance/${map}/${shot}-original.png`); stage('acceptance/times.json', {copy: true}); }
  if (shot && baseShot && !stage(`acceptance/${map}/${shot}-base-original.png`)) absent.push(`acceptance/${map}/${shot}-base-original.png`);
  // floorShots: the original's further frames of the same held tick (`live-original.sh --extra-shots`), the contribution's own floor (THRESHOLDS)
  for (let k = 2; shot && k <= 1 + floorShots; k++) if (!stage(`acceptance/${map}/${shot}-original-${k}.png`)) absent.push(`acceptance/${map}/${shot}-original-${k}.png`);
  if (fireHold && !existsSync(path.join(root, '.work/live-acceptance', map, `fire${tag ? `-${tag}` : ''}.json`))) absent.push(`live-acceptance/${map}/fire${tag ? `-${tag}` : ''}.json`);
  if (absent.length) return fail(`stored originals absent: ${absent.join(', ')}`, 'NO-ORIGINAL');
  const extra = [...(tag ? ['--tag', tag] : []), ...(shot ? ['--shot', shot] : []), ...(earlyCmds ? ['--early-cmds', earlyCmds] : []), ...(renderHistory ? ['--render-history'] : []), ...(baseShot ? ['--base-shot'] : []),
    ...(floorShots ? ['--extra-shots', String(floorShots)] : []),
    // fireHold: the original's fires were held at its frames (`dx-live-win fire hold`) and their pixels stored; Play holds its own at them
    ...(fireHold ? ['--fire-hold'] : [])];
  // One replay of the original's trace. A run whose only difference is the stream's draw count is repeated once: that count differed in
  // single runs under host load and not on the repeat (docs/visual-acceptance.md "Open", unattributed), and the repeat is reported.
  const replay = async () => {
    const play = add(await exec(process.execPath, ['scripts/live-acceptance.mjs', 'play', '--map', map, '--seed', '1', ...extra], {limitSeconds: 1500}));
    if (play.killed || play.code !== 0) return {error: `play step: ${play.killed ?? tail(play.out)}`};
    const compare = add(await exec(process.execPath, ['scripts/live-acceptance.mjs', 'compare', '--map', map, ...(tag ? ['--tag', tag] : [])], {limitSeconds: 600}));
    if (compare.killed || compare.code !== 0) return {error: `compare step: ${compare.killed ?? tail(compare.out)}`};
    const report = readJson(path.join(root, '.work/live-acceptance', map, 'report.json'));
    const actors = Object.entries(report.actors);
    const different = actors.filter(([, e]) => e.firstDifference !== null);
    const problems = [];
    if (different.length) problems.push(`${different.length} of ${actors.length} actors differ (${different.slice(0, 4).map(([n, e]) => `${n}@${e.firstDifference}`).join(' ')})`);
    if (report.clock?.firstDifference) problems.push('clock differs');
    const draws = report.rng?.firstTickWithDifferentDrawCount ? `stream draws differ at tick ${report.rng.firstTickWithDifferentDrawCount.tick}` : null;
    return {report, actors, problems, draws};
  };
  let first = await replay(), flaky = null;
  if (!first.error && !first.problems.length && first.draws) { flaky = first.draws; first = await replay(); }
  if (first.error) return fail(first.error);
  const {report, actors} = first, problems = [...first.problems];
  if (first.draws) problems.push(first.draws);
  let frameNote = '';
  if (shot) {
    const frame = add(await exec(process.execPath, ['scripts/visual-acceptance.mjs', 'compare', '--maps', map, ...(baseShot ? ['--contribution'] : []), '--view', `${shot}:0,0,0:0,0,0`], {limitSeconds: 300}));
    const line = frame.out.trim().split('\n').find(l => l.startsWith(`${map} ${shot} `));
    const m = line ? JSON.parse(line.slice(`${map} ${shot} `.length, line.lastIndexOf('}') + 1)) : null;
    const blocks = line ? Number(/ (\d+) outlier blocks/.exec(line)?.[1]) : NaN;
    if (!m) problems.push('no frame comparison');
    else {
      const off = frameProblems({...m, outlierBlocks: Array.from({length: blocks}, () => [])});
      if (baseShot) off.push(...contributionProblems(m, {floor: floorShots > 0}));
      frameNote = `; frame ${shot} ${m.edgeRecall}/${m.edgePrecision}/${blocks}`;
      // the contribution's agreement against the original's own frame-to-frame floor (every frame pair, the stored frames and this run's)
      if (baseShot && floorShots) {
        const run = add(await exec(process.execPath, ['scripts/contribution-floor.mjs', '--map', map, '--shot', shot, '--extra', String(floorShots), '--json'], {limitSeconds: 600}));
        const floor = (() => { try { return JSON.parse(run.out.trim().split('\n').pop()); } catch { return null; } })();
        if (!floor || floor.originals !== 1 + floorShots || floor.plays !== 1 + floorShots) off.push(`no contribution floor (${run.killed ?? tail(run.out)})`);
        else {
          const median = floor.cross.agreement.median, minimum = floor.originalSelf.agreement.min;
          if (!(median >= minimum)) off.push(`contribution agreement: Play's median against the original ${median} < the original's own minimum ${minimum}`);
          frameNote += `; steam agreement median ${median} (${floor.cross.agreement.min} to ${floor.cross.agreement.max}) against the original's own ${minimum} to ${floor.originalSelf.agreement.max}`;
        }
      }
      if (off.length) problems.push(`frame ${shot}: ${off.join(', ')}`);
    }
  }
  if (problems.length) return fail(`${map}${tag ? ` ${tag}` : ''}: ${problems.join('; ')}`);
  return {...result, status: 'PASS', detail: `${map}${tag ? ` ${tag}` : ''}: ${actors.length} actors equal for ${report.ticks} ticks, clock and stream draws equal${frameNote}${flaky ? ` (the first run's ${flaky}; equal on the repeat)` : ''}`, flaky: Boolean(flaky)};
}
// conversation frames -------------------------------------------------------------------------------------
// The original's held frames of a conversation (taken with Ctrl+F9 at a tick of the traced load, `live-original.sh --cmds "N:@ctrlshot name"`) against
// Play's replay of the same trace stopped at the same tick: `live-acceptance.mjs play --ticks N --shot name` (the measured phonemes fed, the player's
// placement as the original's console typed it), then `conversation-acceptance.mjs compare`, which splits the frame into the letterbox bars, the
// subtitle and the 3D band. One replay per frame; the replays share the trace's play-rows file, so they run in turn.
async function judgeConversation(task, add, fail, result) {
  const c = task.conversation, T = {...CONVERSATION_THRESHOLDS, ...task.conversation.thresholds};
  const absent = stageLive(c.map, c.tag);
  for (const frame of c.frames) {
    if (!stage(`acceptance/${c.map}/${frame.name}-original.png`)) absent.push(`acceptance/${c.map}/${frame.name}-original.png`);
    stage(`acceptance/${c.map}/${frame.name}-time.txt`, {copy: true});
  }
  if (absent.length) return fail(`stored originals absent: ${absent.join(', ')}`, 'NO-ORIGINAL');
  // The speakers' mouth letters, read back from the staged trace (a measured host input: Galaxy's audio analysis writes them from the speech it plays in
  // real time, docs/lip-sync.md); the file is derived, so it is regenerated here, not stored.
  const phonemes = path.join('.work/live-acceptance', c.map, `phonemes-${c.tag}.json`);
  const letters = add(await exec(process.execPath, ['scripts/conversation-acceptance.mjs', 'phonemes', '--scene', c.scene, '--tag', c.tag], {limitSeconds: 300}));
  if (letters.killed || letters.code !== 0) return fail(`phonemes: ${letters.killed ?? tail(letters.out)}`);
  for (const frame of c.frames) {
    const args = ['scripts/live-acceptance.mjs', 'play', '--map', c.map, '--seed', '1', '--tag', c.tag, '--ticks', String(frame.tick), '--shot', frame.name,
      ...(c.playerBlend ? ['--player-blend'] : []), ...(existsSync(path.join(root, phonemes)) ? ['--phonemes', phonemes] : []),
      ...(c.noGhost ? ['--no-ghost'] : []), ...(c.keepTraveling ? ['--keep-traveling'] : []), ...(c.earlyCmds ? ['--early-cmds', c.earlyCmds] : [])];
    const play = add(await exec(process.execPath, args, {limitSeconds: 900}));
    if (play.killed || play.code !== 0) return fail(`play ${frame.name}: ${play.killed ?? tail(play.out)}`);
    if (!existsSync(path.join(root, '.work/acceptance', c.map, `${frame.name}-play.png`))) return fail(`play ${frame.name}: no frame was written`);
  }
  // The traced actors over the longest replay (the last one): the speakers' mouths follow the measured phonemes, so Paul's and JC's blend channels,
  // the cameras' actors and every pawn of the load must equal the original's per tick, apart from the measured exceptions c.liveAllow names (actor ->
  // fields): a host input before the release that the replay cannot reproduce (docs/conversation-camera.md, item 2).
  const live = add(await exec(process.execPath, ['scripts/live-acceptance.mjs', 'compare', '--map', c.map, '--tag', c.tag, ...(c.playerBlend ? ['--player-blend'] : [])], {limitSeconds: 600}));
  if (live.killed || live.code !== 0) return fail(`live compare: ${live.killed ?? tail(live.out)}`);
  const liveReport = readJson(path.join(root, '.work/live-acceptance', c.map, 'report.json'));
  const liveProblems = [], allow = c.liveAllow ?? {};
  for (const [name, e] of Object.entries(liveReport.actors)) {
    if (e.firstDifference === null) continue;
    const extra = Object.keys(e.fields ?? {}).filter(field => !(allow[name] ?? []).includes(field));
    if (extra.length) liveProblems.push(`${name}@${e.firstDifference} ${extra.slice(0, 3).join(',')}`);
  }
  if (liveReport.clock?.firstDifference) liveProblems.push('clock differs');
  if (liveReport.rng?.firstTickWithDifferentDrawCount) liveProblems.push(`stream draws differ at tick ${liveReport.rng.firstTickWithDifferentDrawCount.tick}`);
  const watched = Object.keys(liveReport.actors).length;
  const compare = add(await exec(process.execPath, ['scripts/conversation-acceptance.mjs', 'compare', '--scene', c.scene, '--frames', c.frames.map(f => f.name).join(',')], {limitSeconds: 600}));
  if (compare.killed || compare.code !== 0) return fail(`compare: ${compare.killed ?? tail(compare.out)}`);
  const report = readJson(path.join(root, '.work/acceptance', c.map, `conversation-${c.scene}-play-report.json`));
  const problems = [], notes = [];
  for (const frame of c.frames) {
    const row = report[frame.name];
    if (!row || row.error) { problems.push(`${frame.name}: ${row?.error ?? 'no comparison'}`); continue; }
    const R = row.regions, off = [];
    for (const part of ['topBar', 'bottomBar', 'subtitle']) if (R[part].pixels && R[part].over2 > T.barsOver2) off.push(`${part} ${R[part].over2} pixels over 2`);
    if (R.band.identical < T.bandIdentical) off.push(`band identical ${R.band.identical}`);
    if (row.awayFromEdges.over10 > T.awayOver10) off.push(`${row.awayFromEdges.over10} pixels over 10 away from the edges`);
    if (row.edgeRecall < T.edge) off.push(`edge recall ${row.edgeRecall}`);
    if (row.edgePrecision < T.edge) off.push(`edge precision ${row.edgePrecision}`);
    if (row.outlierBlocks > T.outlierBlocks) off.push(`${row.outlierBlocks} outlier blocks`);
    if (off.length) problems.push(`${frame.name} (tick ${frame.tick}): ${off.join(', ')}`);
    notes.push(`${frame.name} band ${R.band.identical}/${R.band.over2}/${R.band.over10}, ${row.awayFromEdges.over10} of the over 10 off the edges, bars+subtitle over2 ${R.topBar.over2 + R.bottomBar.over2 + R.subtitle.over2}, edges ${row.edgeRecall}/${row.edgePrecision}`);
  }
  if (liveProblems.length) problems.push(`live: ${liveProblems.slice(0, 6).join(', ')}`);
  if (problems.length) return fail(`${c.map} ${c.tag}: ${problems.join('; ')}`);
  return {...result, status: 'PASS', detail: `${c.map} ${c.tag}: ${notes.join('; ')}; ${watched} watched actors equal for the ${Math.max(...c.frames.map(f => f.tick))} ticks replayed${Object.keys(allow).length ? ' but the measured exceptions' : ''}, clock and stream draws equal`};
}

// The original's Galaxy PlaySound calls of a live scene (the tracer's `gplay` records in original-trace<tag>.jsonl.calls.jsonl, Galaxy 0x10608100) against
// Play's replay of the same trace. Every call must equal in order (per tick), sound, emitter, volume, radius, pitch and channel id; the slot model that
// gives a runtime-spawned emitter its id is seeded from registry-start<tag>.txt (docs/object-index-captures.md). The `population` step comes first: its
// play-population.json names the pre-placed actors whose own measured indices the slot model takes.
async function judgeSounds(task, add, fail, result) {
  const {map, tag, ticks} = task.sounds;
  const absent = stageLive(map, tag);
  for (const name of [`original-trace-${tag}.jsonl.calls.jsonl`, `registry-start-${tag}.txt`, `commands-${tag}.json`]) {
    if (!stage(`live-acceptance/${map}/${name}`, {copy: !name.endsWith('.calls.jsonl')})) absent.push(`${map}/${name}`);
  }
  if (absent.length) return fail(`stored originals absent: ${absent.join(', ')}`, 'NO-ORIGINAL');
  const population = add(await exec(process.execPath, ['scripts/live-acceptance.mjs', 'population', '--map', map, '--seed', '1'], {limitSeconds: 600}));
  if (population.killed || population.code !== 0) return fail(`population step: ${population.killed ?? tail(population.out)}`);
  // --no-ghost: the capture's player is a normal one (it picks up the pistol and fires it), not the cheat-flying ghost of the other pilots
  const play = add(await exec(process.execPath, ['scripts/live-acceptance.mjs', 'play', '--map', map, '--seed', '1', '--tag', tag, '--no-ghost', '--object-trace', `1:${ticks}`], {limitSeconds: 1500}));
  if (play.killed || play.code !== 0) return fail(`play step: ${play.killed ?? tail(play.out)}`);
  const compare = add(await exec(process.execPath, ['scripts/live-sound-compare.mjs', '--map', map, '--tag', tag, '--gate'], {limitSeconds: 300}));
  if (compare.killed) return fail(`compare step: ${compare.killed}`);
  const line = compare.out.split('\n').find(l => l.startsWith('GATE '));
  if (!line) return fail(`compare step: ${tail(compare.out)}`);
  const g = JSON.parse(line.slice(5));
  const detail = `${map} ${tag}: ${g.equalTicks} of ${g.ticksWithCalls} ticks with sound calls equal, ${g.equalCalls} of ${g.originalCalls} calls (Play made ${g.playCalls}), first differing tick ${g.firstDifferentTick ?? 'none'}; ` +
    `matched ignoring order within the tick ${g.matchedLoosely}, channel id equal in ${g.idsEqualLoosely}; registry takes equal for ${g.registryTakesEqual} of ${g.registryTakes[0]}/${g.registryTakes[1]}` +
    (g.firstDifferentRegistryTake ? ` (then original ${g.firstDifferentRegistryTake.original}, Play ${g.firstDifferentRegistryTake.play})` : '');
  if (g.firstDifferentTick !== null || g.originalCalls !== g.playCalls) return fail(detail);
  return {...result, status: 'PASS', detail};
}
async function judgeSweep(task, add, fail, result) {
  const {maps, tags = {}} = task.sweep;
  const tagOf = map => tags[map] ?? 'sweep';
  const fromDir = '.work/stage4-sweep-originals';
  const absent = maps.flatMap(map => stageLive(map, tagOf(map), fromDir));
  if (absent.length) return fail(`stored originals absent: ${absent.slice(0, 4).join(', ')}${absent.length > 4 ? ` +${absent.length - 4}` : ''}`, 'NO-ORIGINAL');
  // live-sweep.mjs takes one --tag: one replay per tag, the maps' results are judged together
  const byTag = new Map();
  for (const map of maps) byTag.set(tagOf(map), [...(byTag.get(tagOf(map)) ?? []), map]);
  const problems = [];
  let watched = 0, equal = 0;
  for (const [tag, tagged] of byTag) {
    const outFile = `.work/live-acceptance/stage4-gate-sweep-${tag}.json`;
    try { unlinkSync(path.join(root, outFile)); } catch { /* fresh */ }
    const r = add(await exec(process.execPath, ['scripts/live-sweep.mjs', 'replay', '--from', path.join(root, fromDir), '--maps', tagged.join(','), '--tag', tag, '--ticks', '1200', '--out', outFile, '--force'], {limitSeconds: 3000}));
    if (r.killed || r.code !== 0) return fail(`replay: ${r.killed ?? tail(r.out)}`);
    const data = readJson(path.join(root, outFile));
    for (const map of tagged) {
      const e = data.maps?.[map];
      if (!e || e.status !== 'ok') { problems.push(`${map}: ${e?.status ?? 'not replayed'} ${e?.reason ?? ''}`.trim()); continue; }
      watched += e.watched; equal += e.equal;
      if (e.equal !== e.watched) problems.push(`${map}: ${e.equal} of ${e.watched} actors equal (${e.diverging.slice(0, 3).map(d => `${d.actor}@${d.firstTick} ${d.field}`).join(', ')})`);
    }
  }
  if (problems.length) return fail(problems.join(' | '));
  return {...result, status: 'PASS', detail: `${maps.length} maps, ${equal} of ${watched} actors equal over 1,200 ticks`};
}
async function judgeCensus(task, add, fail, result) {
  const r = add(await exec(process.execPath, ['scripts/census-ui-screens.mjs'], {limitSeconds: 1200}));
  if (r.killed || r.code !== 0) return fail(`census: ${r.killed ?? tail(r.out)}`);
  const lines = r.out.trim().split('\n').filter(line => line.startsWith('{'));
  const rows = lines.map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const bad = rows.filter(row => row.error);
  if (!rows.length) return fail(`no screen results: ${tail(r.out, 3)}`);
  if (bad.length) return fail(`${bad.length} of ${rows.length} screens: ${bad.slice(0, 3).map(row => JSON.stringify(row).slice(0, 160)).join(' | ')}`);
  return {...result, status: 'PASS', detail: `${rows.length} screens open, draw and close (the census's own criterion: no error)`};
}

// --- scheduling and reporting ------------------------------------------------------------------------------
const matcher = flag('--only') && flag('--only') !== true ? new RegExp(flag('--only'), 'i') : null;
const selected = CRITERIA.filter(c => !matcher || [c.id, c.clause, c.scene, c.claim].some(text => matcher.test(text)));
if (!selected.length) { console.error(`no criterion matches --only ${flag("--only")}`); process.exit(2); }
const tasks = [];
for (const criterion of selected) for (const check of criterion.checks) for (const task of expand(check, criterion)) tasks.push({...task, criterion});

if (has('--markdown')) {
  const report = readJson(flag('--markdown'));
  console.log(renderMarkdown(report.criteria, flag('--clause')));
  process.exit(0);
}
if (has('--list')) {
  let total = 0;
  for (const c of selected) {
    const mine = tasks.filter(t => t.criterion === c);
    const estimate = mine.reduce((n, t) => n + (t.estimate ?? 0), 0);
    total += estimate;
    console.log(`${c.id.padEnd(7)} ${c.evidence.padEnd(2)} ${c.missing ? 'MISSING' : c.excluded ? 'EXCLUDED' : `${mine.length} task(s), ~${Math.round(estimate)} s`}  ${c.scene}: ${c.claim}`);
    for (const t of mine) console.log(`          ${t.label} (${t.mode ?? "worker"})${t.validator ? workRefs(t.validator) : ''}  ~${Math.round(t.estimate ?? 0)} s ${t.mutex ? `[${t.mutex.join(',')}]` : ''}${t.error ? ` ERROR ${t.error}` : ''}`);
    if (c.missing || c.excluded) console.log(`          ${c.missing ? 'MISSING' : 'EXCLUDED'}: ${c.missing ?? c.excluded}`);
  }
  console.log(`\n${tasks.length} tasks, about ${Math.round(total)} s of work (${Math.round(total / jobs)} s at ${jobs} jobs)`);
  process.exit(0);
}

const started = Date.now();
const results = new Map();
const held = new Set();
const queue = [...tasks].sort((a, b) => (b.estimate ?? 0) - (a.estimate ?? 0));
let active = 0;
await new Promise(resolve => {
  const pump = () => {
    if (!queue.length && !active) return resolve();
    while (active < jobs && queue.length) {
      const reserved = [...running].reduce((n, job) => n + Math.max(job.current, 0), 0);
      const index = queue.findIndex(task => (!task.mutex || !task.mutex.some(m => held.has(m))) && (active === 0 || reserved + (task.memory ?? 1024) <= memBudget));
      if (index === -1) break;
      const [task] = queue.splice(index, 1);
      for (const m of task.mutex ?? []) held.add(m);
      active++;
      runTask(task).catch(error => ({status: 'FAIL', detail: `gate error: ${error.stack?.split('\n')[0] ?? error}`, seconds: 0, peak: 0})).then(r => {
        results.set(task.key, {task, ...r});
        for (const m of task.mutex ?? []) held.delete(m);
        active--;
        console.log(`[${String(results.size).padStart(3)}/${tasks.length}] ${r.status.padEnd(11)} ${r.seconds.toFixed(0).padStart(4)}s ${(r.peak / 1024).toFixed(1)}G  ${task.criterion.id}  ${task.label}`);
        pump();
      });
    }
    setTimeout(pump, 500);
  };
  pump();
});
clearInterval(sampler);
const wall = (Date.now() - started) / 1000;

const rank = {FAIL: 6, 'NO-ORIGINAL': 5, SKIPPED: 4, INLINE: 3, PASS: 0};
const rows = selected.map(c => {
  const mine = [...results.values()].filter(r => r.task.criterion === c);
  let status = 'PASS';
  if (c.excluded) status = 'EXCLUDED'; else if (c.missing) status = 'MISSING';
  else for (const r of mine) if ((rank[r.status] ?? 5) > (rank[status] ?? 0)) status = r.status;
  const failing = mine.filter(r => r.status !== 'PASS');
  return {id: c.id, clause: c.clause, scene: c.scene, claim: c.claim, evidence: c.evidence, status, reason: c.missing ?? c.excluded ?? null,
    checks: mine.map(r => ({check: r.task.label, mode: r.task.mode ?? (r.task.census ? 'node' : 'worker'), status: r.status, seconds: Math.round(r.seconds), peakMiB: Math.round(r.peak), flaky: r.flaky ?? false, detail: r.detail})),
    failing: failing.map(r => `${r.task.label}: ${r.detail}`)};
});
const blocking = rows.filter(r => r.status !== 'PASS' && r.status !== 'EXCLUDED');
const pass = blocking.length === 0;

function renderMarkdown(list, clause = null) {
  const cell = text => String(text ?? '').replace(/\|/g, '/');
  const out = ['| Id | Scene | Criterion | Ev. | Checks (mode) | Status |', '| --- | --- | --- | --- | --- | --- |'];
  for (const r of list.filter(r => !clause || r.id.startsWith(`4.${clause}.`))) {
    let checks;
    if (r.reason) checks = `${r.status === 'EXCLUDED' ? 'excluded' : 'missing'}: ${r.reason}`;
    else if (r.checks.length > 7) checks = `${r.checks.length} validators (${r.checks.slice(0, 3).map(c => c.check).join(', ')}, ...) [${[...new Set(r.checks.map(c => c.mode))].join('/')}]`;
    else checks = r.checks.map(c => `\`${c.check}\` [${c.mode}]${c.flaky ? ' (flaky)' : ''}`).join(', ');
    out.push(`| ${r.id} | ${cell(r.scene)} | ${cell(r.claim)} | ${r.evidence} | ${cell(checks)} | ${r.status} |`);
  }
  return out.join('\n');
}
console.log(`\nStage 4 acceptance gate: ${rows.length} criteria, ${tasks.length} checks run in ${wall.toFixed(0)} s wall at ${jobs} jobs, peak ${peakTotal.toFixed(0)} MiB across the checks`);
let clause = '';
for (const r of rows) {
  if (r.clause !== clause) { clause = r.clause; console.log(`\n${clause}`); }
  console.log(`  ${r.status.padEnd(11)} ${r.id.padEnd(7)} ${r.evidence.padEnd(2)} ${r.scene}: ${r.claim}`.slice(0, 230));
  if (r.status !== 'PASS') for (const text of [...(r.reason ? [r.reason] : []), ...r.failing]) console.log(`                         ${text.slice(0, 260)}`);
}
const count = status => rows.filter(r => r.status === status).length;
console.log(`\n${count('PASS')} PASS, ${count('FAIL')} FAIL, ${count('NO-ORIGINAL')} NO-ORIGINAL, ${count('SKIPPED')} SKIPPED, ${count('INLINE')} INLINE, ${count('MISSING')} MISSING, ${count('EXCLUDED')} EXCLUDED`);
const reportFile = flag('--report');
if (reportFile && reportFile !== true) {
  mkdirSync(path.dirname(path.resolve(root, reportFile)), {recursive: true});
  writeFileSync(path.resolve(root, reportFile), JSON.stringify({generated: new Date().toISOString(), jobs, wallSeconds: Math.round(wall), peakMiB: Math.round(peakTotal), thresholds: THRESHOLDS, pass, criteria: rows}, null, 1) + '\n');
  console.log(`wrote ${reportFile}`);
}
console.log(`${pass ? 'PASS' : 'OPEN'}: Stage 4 acceptance gate${matcher ? ` (subset: --only ${flag('--only')}; only the full run is the gate)` : ''}${pass ? '' : ` (${blocking.length} of ${rows.length - count('EXCLUDED')} criteria not passing)`}`);
process.exit(pass || has('--report') ? 0 : 1);
