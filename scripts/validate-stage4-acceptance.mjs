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
import {copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
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
  const source = findStored(relative);
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
const SWEEP = spec => ({type: 'sweep', ...spec});
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
});
const effectViews = key => FRAMES({maps: [EFFECT_VIEWS[key].map], explicit: EFFECT_VIEWS[key].views, flat: {}});

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
  SWEEP({maps: ['02_NYC_BatteryPark', '02_NYC_Hotel', '06_HongKong_WanChai_Market', '10_Paris_Chateau', '15_Area51_Bunker']}));
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
missing('4.2.13', C2, '04_NYC_Street vents', 'a frame with particles and sprites against the original with the generators\' state matched',
  'no matched capture holds a particle or sprite whose generator state the original side fixed');
add('4.2.14', C2, 'decals', 'AttachDecal, ClipDecal and the vertices of a decal equal Engine.dll and Render.dll', 'O2',
  V('decal-attach'), V('decal-render'), V('decal-startup'), V('decal-vertices-play'), V('decals-play'));
missing('4.2.15', C2, 'Training shadows, bullet holes', 'a decal frame against the original', 'no matched capture shows a decal; blood and scorch marks need combat');
add('4.2.16', C2, 'volumetric fog (02_NYC_Bar)', 'ComputeFromActor and the fog loop equal Render.dll; the pass in Play', 'O3',
  V('volumetric-fog'), V('volumetric-fog-play'));
missing('4.2.17', C2, '02_NYC_Bar smoke haze', 'a fog frame against the original', 'the stored frames are 08_NYC_Bar, whose zones hold no fog; 02_NYC_Bar has no original capture');
add('4.2.18', C2, 'mirrors', 'frame cases, child frames, nesting, the sky inside a mirror, the strobe', 'O2',
  V('mirrors'), V('child-frames'), V('mirror-plan-play'), V('mirrors-play'), V('sky-in-mirror-play'), V('strobe-mirror-play'), V('underworld-panes-play'));
missing('4.2.19', C2, '02_NYC_Hotel bathroom mirror', 'an opaque unlit mirror against the original', 'no stored original frame of 02_NYC_Hotel (only mirrors-play, Play against itself)');
add('4.2.20', C2, 'Fire.dll textures', 'fire and water textures, animated and auto-panned surfaces', 'O2',
  V('native-fire-texture'), V('fire-texture-rust'), V('native-texture-animation'), V('native-surface-pan'), V('fire-texture-play'), V('texture-animation-play'));
add('4.2.21', C2, 'detail textures', 'the D3DDrv detail pass equals the original body; Play draws it', 'O2',
  V('detail-pass'), V('detail-pass-rust'), V('detail-play-sim'), V('detail-play'));
missing('4.2.22', C2, 'detail pass in a frame', 'Play\'s detail pass against a capture of the original with the pass poked in',
  'measured once (Jaccard 0.94 to 0.98 on five of six views, docs/frame-projection.md); those captures are not in a store the gate reads');
add('4.2.23', C2, 'lasers', 'LaserIterator.CurrentItem equals the original; the Island doorway beams draw', 'O2', V('native-laser'), V('lasers-play'));
missing('4.2.24', C2, '01_NYC_UNATCOIsland doorway', 'a beam frame against the original', 'no original capture of a beam (docs/lasers.md)');
add('4.2.25', C2, 'viewport flash', 'EndFlash equals D3DDrv; the flash pass draws', 'O2', V('d3d-endflash'), V('flash-play'), V('player-alterations-census'));
missing('4.2.26', C2, 'underwater or drunk frame', 'a held flash frame against the original under Wine',
  'the pass is checked against Play itself only; GL\'s 8-bit blend rounding against the device\'s is unmeasured (roadmap section 4 Open)');
add('4.2.27', C2, 'vertices and visibility', 'Render.dll\'s projection, D3DDrv\'s vertices and OccludeBsp equal the original', 'O2',
  V('frame-projection'), V('frame-projection-movers'), V('frame-projection-play'), V('bsp-occlusion'), V('master-frame-play'));
add('4.2.28', C2, 'security cameras', 'ViewportWindow windows on four maps match the original\'s computer screens', 'O1',
  CAMERA({map: '14_OceanLab_Lab', computer: 'ComputerSecurity1', user: 'Oceanguard', password: 'Kraken', cameraActor: 'SecurityCamera0', name: 'cs1', windows: 3}),
  CAMERA({map: '02_NYC_BatteryPark', computer: 'ComputerSecurity2', user: 'NSF', password: 'righteous', cameraActor: 'SecurityCamera1', name: 'bp2', windows: 3}),
  CAMERA({map: '06_HongKong_WanChai_Market', computer: 'ComputerSecurity0', user: 'TAM', password: 'DRAGON', cameraActor: 'SecurityCamera2', name: 'hk0', windows: 3}),
  CAMERA({map: '09_NYC_Ship', computer: 'ComputerSecurity3', user: 'SECURITY', password: 'Brooklyn', cameraActor: 'SecurityCamera1', name: 'sh3', windows: 3}));
missing('4.2.29', C2, 'camera with a mirror, sky, fog or corona in view', 'a camera frame against the original', 'the thirteen captured windows look into rooms (visual-acceptance.md "What stays")');
missing('4.2.30', C2, '06_HongKong_WanChai_Underworld mirrored panes', 'the dance floor in the mirrored panes at a held Strobe against the original',
  'the stored d_s0 and d_s1 frames cannot be reproduced: the level time each was held at is not stored with it (times.json holds the last capture\'s, 54.18 s, written after the frames), and with that clock Play differs in 7 blocks');
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
missing('4.3.6', C3, 'a live scene\'s script sounds', 'the original\'s PlaySound calls of a scene against Play\'s',
  'scripts/live-sound-compare.mjs compares one capture (Underworld, tag snd1); its stored original trace is not in a store the gate reads');
missing('4.3.7', C3, 'audible output', 'the output Galaxy produces for the speakers', 'the music bus delay, the ring heads\' spacing, MPEG and ADPCM samples and 3D voices are unmeasured or untranslated (docs/galaxy-music.md, galaxy-audio.md)');

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
missing('4.5.5', C5, 'MeetPaul frame', 'the third-person conversation frame (letterbox, behind view, camera, subtitles) against the original\'s', 'compared by hand 2026-10-16 (docs/conversation-camera.md "Frames against the original": four frames, bars and subtitle pixel-equal, the band within polygon edges; stored as cvA1..4 in the main .work); the gate check kind that replays and judges them is not written yet');
missing('4.5.6', C5, 'speech audio', 'the speech samples the player hears against Galaxy\'s', 'Galaxy\'s MPEG decoder is not translated; the host\'s decode and rounding are unverified (docs/lip-sync.md)');
missing('4.5.7', C5, '00_Intro camera shots', 'the intro\'s CameraPoint shots against the original', 'the original\'s frames at ticks 170, 1000 and 2250 are stored (main .work, tag in2), but Play\'s replay of the intro diverges from tick 1 (docs/conversation-camera.md "Hand-off"), so no comparison is claimed');
missing('4.5.8', C5, 'a second third-person conversation', 'a conversation on another map, with the third-person camera, lip sync and speech', 'chosen: 01_NYC_UNATCOHQ MeetManderley (every map\'s object-index capture already exists, docs/object-index-captures.md); it starts and plays in Play with the camera, but no original capture was taken yet (docs/conversation-camera.md "Hand-off")');

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
  if (task.sweep) return judgeSweep(task, add, fail, result);
  if (task.census) return judgeCensus(task, add, fail, result);
  return fail('no runner');
}

// Stored originals a validator compares with when this checkout has them (it falls back to fabricated cases without them, which would
// prove less than the criterion says), so the gate stages them and reports NO-ORIGINAL when they are absent.
const VALIDATOR_ORIGINALS = {'weapon-attach': ['weapon/original-cases.json', 'weapon/original-cases-2.json', 'weapon/original-cases-3.json']};
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
// matched frames -----------------------------------------------------------------------------------------
async function judgeFrames(task, add, fail, result) {
  const {maps, views, explicit, flat = {}} = task.frames;
  const names = explicit ? explicit.map(v => v.split(':')[0]) : views;
  // One store supplies the whole run: the first root that holds the first frame. Its times.json (the level time each map was held at) goes
  // with it, since a map captured twice (the frozen set at 46.8 s, the effect views at 52.3 s) has a clock per capture.
  const source = storeRoots.find(dir => existsSync(path.join(dir, `acceptance/${maps[0]}/${names[0]}-original.png`)));
  const absent = [];
  if (!source) absent.push(`acceptance/${maps[0]}/${names[0]}-original.png`);
  else for (const map of maps) for (const name of names) if (!existsSync(path.join(source, `acceptance/${map}/${name}-original.png`))) absent.push(`acceptance/${map}/${name}-original.png`);
  if (source && !existsSync(path.join(source, 'acceptance/times.json'))) absent.push('acceptance/times.json');
  if (absent.length) return fail(`stored originals absent: ${absent.slice(0, 4).join(', ')}${absent.length > 4 ? ` +${absent.length - 4}` : ''}`, 'NO-ORIGINAL');
  for (const map of maps) {
    mkdirSync(path.join(root, '.work/acceptance', map), {recursive: true});
    for (const name of names) {
      const to = path.join(root, '.work/acceptance', map, `${name}-original.png`);
      try { unlinkSync(to); } catch { /* none yet */ }
      symlinkSync(path.join(source, `acceptance/${map}/${name}-original.png`), to);
    }
  }
  const timesTo = path.join(root, '.work/acceptance/times.json');
  try { unlinkSync(timesTo); } catch { /* none yet */ }
  copyFileSync(path.join(source, 'acceptance/times.json'), timesTo);
  const viewArgs = explicit ? explicit.flatMap(v => ['--view', v]) : [];
  const play = add(await exec(process.execPath, ['scripts/visual-acceptance.mjs', 'play', '--maps', maps.join(','), '--query', 'antialias=0', ...viewArgs], {limitSeconds: 900}));
  if (play.killed || play.code !== 0 || /errors:/.test(play.out)) return fail(`play step: ${play.killed ?? tail(play.out)}`);
  const compare = add(await exec(process.execPath, ['scripts/visual-acceptance.mjs', 'compare', '--maps', maps.join(','), ...viewArgs], {limitSeconds: 300}));
  if (compare.killed || compare.code !== 0) return fail(`compare step: ${compare.killed ?? tail(compare.out)}`);
  const report = readJson(path.join(root, '.work/acceptance/report.json'));
  const problems = [];
  const lines = [];
  for (const map of maps) for (const name of names) {
    const m = report[map]?.[name];
    if (!m) { problems.push(`${map} ${name}: no comparison`); continue; }
    const isFlat = FLAT_VIEWS.has(`${map}:${name}`);
    const off = frameProblems(m, isFlat, EXPLAINED_BLOCKS[`${map}:${name}`] ?? 0);
    if (off.length) problems.push(`${map} ${name}: ${off.join('; ')}`);
    lines.push(`${name} ${m.edgeRecall}/${m.edgePrecision}/${m.outlierBlocks.length}`);
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
  ['commands', '.json', 'copy', false], ['deferred', '.json', 'copy', false], ['hold', '.json', 'copy', false], ['registry-start', '.txt', 'copy', false]];
function stageLive(map, tag, into = '.work/live-acceptance') {
  const s = tag ? `-${tag}` : '';
  const traceName = `original-trace${s}.jsonl`;
  const sourceRoot = storeRoots.find(dir => existsSync(path.join(dir, 'live-acceptance', map, traceName)));
  if (!sourceRoot) return [`${map}/${traceName}`];
  const absent = [];
  const targetDir = path.join(root, into, map);
  mkdirSync(targetDir, {recursive: true});
  for (const [base, ext, how, required] of LIVE_BASES) {
    const names = [`${base}${s}${ext}`, `${base}${ext}`];
    const found = names.find(name => existsSync(path.join(sourceRoot, 'live-acceptance', map, name)));
    if (!found) { if (required) absent.push(`${map}/${names[0]}`); continue; }
    const from = path.join(sourceRoot, 'live-acceptance', map, found), to = path.join(targetDir, found);
    try { unlinkSync(to); } catch { /* none yet */ }
    if (how === 'copy') copyFileSync(from, to); else symlinkSync(from, to);
    // the sweep's replay and compare read `watch-<tag>.json` / `population-<tag>.json` by the tag
    if (found !== names[0] && /^(watch|population)$/.test(base)) { const tagged = path.join(targetDir, names[0]); try { unlinkSync(tagged); } catch { /* none */ } copyFileSync(from, tagged); }
  }
  return absent;
}
async function judgeLive(task, add, fail, result) {
  const {map, tag = null, shot = null, earlyCmds = null, renderHistory = false} = task.live;
  const absent = stageLive(map, tag);
  if (shot) { if (!stage(`acceptance/${map}/${shot}-original.png`)) absent.push(`acceptance/${map}/${shot}-original.png`); stage('acceptance/times.json', {copy: true}); }
  if (absent.length) return fail(`stored originals absent: ${absent.join(', ')}`, 'NO-ORIGINAL');
  const extra = [...(tag ? ['--tag', tag] : []), ...(shot ? ['--shot', shot] : []), ...(earlyCmds ? ['--early-cmds', earlyCmds] : []), ...(renderHistory ? ['--render-history'] : [])];
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
    const frame = add(await exec(process.execPath, ['scripts/visual-acceptance.mjs', 'compare', '--maps', map, '--view', `${shot}:0,0,0:0,0,0`], {limitSeconds: 300}));
    const line = frame.out.trim().split('\n').find(l => l.startsWith(`${map} ${shot} `));
    const m = line ? JSON.parse(line.slice(`${map} ${shot} `.length, line.lastIndexOf('}') + 1)) : null;
    const blocks = line ? Number(/ (\d+) outlier blocks/.exec(line)?.[1]) : NaN;
    if (!m) problems.push('no frame comparison');
    else {
      const off = frameProblems({...m, outlierBlocks: Array.from({length: blocks}, () => [])});
      if (off.length) problems.push(`frame ${shot}: ${off.join(', ')}`);
      frameNote = `; frame ${shot} ${m.edgeRecall}/${m.edgePrecision}/${blocks}`;
    }
  }
  if (problems.length) return fail(`${map}${tag ? ` ${tag}` : ''}: ${problems.join('; ')}`);
  return {...result, status: 'PASS', detail: `${map}${tag ? ` ${tag}` : ''}: ${actors.length} actors equal for ${report.ticks} ticks, clock and stream draws equal${frameNote}${flaky ? ` (the first run's ${flaky}; equal on the repeat)` : ''}`, flaky: Boolean(flaky)};
}
async function judgeSweep(task, add, fail, result) {
  const {maps} = task.sweep;
  const fromDir = '.work/stage4-sweep-originals';
  const absent = maps.flatMap(map => stageLive(map, 'sweep', fromDir));
  if (absent.length) return fail(`stored originals absent: ${absent.slice(0, 4).join(', ')}${absent.length > 4 ? ` +${absent.length - 4}` : ''}`, 'NO-ORIGINAL');
  const outFile = '.work/live-acceptance/stage4-gate-sweep.json';
  try { unlinkSync(path.join(root, outFile)); } catch { /* fresh */ }
  const r = add(await exec(process.execPath, ['scripts/live-sweep.mjs', 'replay', '--from', path.join(root, fromDir), '--maps', maps.join(','), '--ticks', '1200', '--out', outFile, '--force'], {limitSeconds: 3000}));
  if (r.killed || r.code !== 0) return fail(`replay: ${r.killed ?? tail(r.out)}`);
  const data = readJson(path.join(root, outFile));
  const problems = [];
  let watched = 0, equal = 0;
  for (const map of maps) {
    const e = data.maps?.[map];
    if (!e || e.status !== 'ok') { problems.push(`${map}: ${e?.status ?? 'not replayed'} ${e?.reason ?? ''}`.trim()); continue; }
    watched += e.watched; equal += e.equal;
    if (e.equal !== e.watched) problems.push(`${map}: ${e.equal} of ${e.watched} actors equal (${e.diverging.slice(0, 3).map(d => `${d.actor}@${d.firstTick} ${d.field}`).join(', ')})`);
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
