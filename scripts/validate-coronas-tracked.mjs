/** The corona helper's TRACE_Level line check over the level model the moving
 * brush tracker left (docs/coronas.md "Lights behind a mover's fragments").
 *
 * 09_NYC_ShipFan, the visual-acceptance view fan2 (docs/visual-acceptance.md,
 * "Light effects against the original"): the player at (236, -238, -55), the
 * eye 40 units above, yaw 25298. The original hides the coronas of Light34,
 * Light35 and Light36 and draws Light33's; Play drew all four.
 *
 * Measured in the running original (tools/dx-live-win.c `trace` with a `call`
 * breakpoint on ULevel::SingleLineCheck 0x1039aed0, the Hit read at the
 * return; the helper's two call sites return to Render.dll 0x10b1bc61 and
 * 0x10b1bcb2; the first rendered frame of the traced run, the movers at the
 * map's poses): the helper made 11 first line checks (flags 6) from the eye
 * (236, -238, -15). Six were clear; five were blocked: Light34 by node 292 at
 * 0.35564 (a ray through nothing the static model holds), Light35 and Light36
 * by solid nodes past the static model's 1,478, Light60 by DeusExMover7, and one
 * by the static model. The lights were not hidden by their DeusEx.Lightbulb
 * (the cylinder is 1.6 by 2.15 in the original and in Play: Actor.PreBeginPlay
 * shortens a Decoration's CollisionHeight by 0.75).
 *
 * What the validator checks:
 *   1. The 11 measured segments through Play's tracked model (the Rust
 *      tracker's nodes after construction, ray.mjs traceRayFast) against
 *      Engine's unchanged UModel::LineCheck under Unicorn on the same level
 *      and movers (native-tracked-linecheck-oracle.py): every result,
 *      including Time, Location, Normal and the node, bit for bit at the game
 *      thread's control word 0x037f, and every decision and node at 0x007f, the
 *      render pass's (Time within 2 ulp there; open, below); and against the
 *      original's outcomes (clear or blocked per segment; Light34's hit is the
 *      measured one, Time to the bit from the DLL at 0x007f).
 *   2. Play's corona scan, at that view and the player's start region, over
 *      the tracked model (createCoronaScan's lineModel) offers the helper the
 *      same 11 lights and passes the same 6; over the static model it
 *      passes 9 (the three lamps the fan's blades hide).
 *
 *   NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-coronas-tracked.mjs */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { loadScriptVmKernel } from '../src/runtime/script-vm-kernel.mjs';
import { createBspOcclusion } from '../src/runtime/bsp-occlusion.mjs';
import { traceRayFast } from '../src/runtime/ray.mjs';
import { createGame } from '../src/viewer/game.mjs';
import { createCoronaScan } from '../src/viewer/corona-scan.mjs';
import { buildMap, bits } from './brush-tracker-request.mjs';
import { exportAt } from '../src/unreal/objects.mjs';

const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
if (!existsSync(python)) { console.log('SKIP validate-coronas-tracked: no native probe environment'); process.exit(0); }
let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-coronas-tracked: no installed game data'); process.exit(0); }
const MAP = '09_NYC_ShipFan';
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
const word = w => (u32[0] = w, f32[0]);

// The eye of fan2: the player at (236, -238, -55) plus its 40 EyeHeight.
const EYE = [236, -238, -15];
// The helper's first line checks in the original (see above): [light, End
// words, the Hit it left or null when clear]. Hit Time is the float32 word's
// value; Location and Normal were read at three decimals.
const MEASURED = [
  ['(279.6, -571.1, 35.9)', [0x438bc963, 0xc40ec6f3, 0x420f8ab3], { actor: 'LevelInfo0', time: 0.5804018974304199, item: 564, location: [261.29, -431.337, 14.534], normal: [-0.309, 0.951, 0] }],
  ['Light60', [0x42bd624c, 0xc411799a, 0x406bc5df], { actor: 'DeusExMover7', time: 0.7754883170127869, item: 0, location: [126.417, -504.69, -0.511], normal: [0, 1, 0] }],
  ['Light44', [0xc2c02e0a, 0xc3ae247c, 0x418130aa], null],
  ['Light38', [0x431bd56d, 0xc39b0480, 0x42aa46c4], null],
  ['Light37', [0xc2b0c7a4, 0xc39be5e2, 0x42aa46c4], null],
  ['Light36', [0xc3881345, 0xc3301dab, 0x42aa46c4], { actor: 'LevelInfo0', time: 0.41145920753479004, item: 1959, location: [26.917, -212.537, 26.203], normal: [0.589, -0.808, 0] }],
  ['Light35', [0xc3aa1b85, 0x424f6859, 0x42aa631d], { actor: 'LevelInfo0', time: 0.28226932883262634, item: 1942, location: [73.352, -156.184, 13.282], normal: [0.99, 0.142, 0] }],
  ['Light34', [0xc3882652, 0x4388e7f2, 0x42aa46c4], { actor: 'LevelInfo0', time: 0.35564300417900085, item: 292, location: [55.227, -55.978, 20.613], normal: [0.866, 0.5, 0] }],
  ['Light33', [0xc2bee35b, 0x43cd4ad8, 0x42aa46c4], null],
  ['Light31', [0x431480a5, 0x43cbbf9e, 0x42aa46c4], null],
  ['(30.7, 51.6, -11.9)', [0x41f590a0, 0x424e66be, 0xc13dee84], null],
];

const files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files);
const kernel = (await loadScriptVmKernel()).occlusion;
const built = await buildMap(assets, MAP), model = built.map.model;
const movers = built.actors.map((a, i) => ({ tag: 0x40000000 + i, flags: a.flags, locationBits: a.locationBits, rotation: a.rotation,
  prePivotBits: a.prePivotBits, mainScale: a.mainScale, postScale: a.postScale, specialLit: a.specialLit,
  polys: a.brush.polys.map(p => ({ ...p, textureKey: p.texture === null ? 0 : p.texture + 1 })) }));
const occlusion = createBspOcclusion(kernel, model, { surfaceTextureFlags: [], tracker: { movers } });
let report;
try {
  assert.equal(occlusion.tracker.construct({ pc64: true }), 0, 'tracker construction');
  const tracked = occlusion.lineModel();

  // 1. The measured segments: Play, the original's DLL, the original's game.
  const start = EYE.map(Math.fround), ends = MEASURED.map(([, words]) => words.map(word));
  const request = { gameRoot: root, model: built.model, actors: built.actors, fillers: [], rootOutside: model.rootOutside ? 1 : 0, details: true,
    checks: ends.map(end => ({ start: start.map(bits), end: end.map(bits) })) };
  const oracle = checkControlWord => JSON.parse(execFileSync(python, ['scripts/native-tracked-linecheck-oracle.py'],
    { input: JSON.stringify({ ...request, checkControlWord }), encoding: 'utf8', maxBuffer: 1 << 28 }));
  // 0x037f: the game thread's precision, the one traceRayFast models (bit for
  // bit); 0x007f: the render pass's, where DrawFrame's corona pass runs (the
  // helper's results agree in every decision and node, Time within 2 ulp).
  const native = oracle(0x037f), renderPass = oracle(0x007f);
  const rows = [];
  let ulp = 0;
  MEASURED.forEach(([label, , hit], i) => {
    const play = traceRayFast(tracked, start, ends[i]), still = traceRayFast(model, start, ends[i]);
    for (const [name, run] of [['0x037f', native], ['0x007f', renderPass]]) {
      assert.equal(still === null ? 1 : 0, run.static[i], `${label}: static LineCheck at ${name}`);
      assert.equal(play === null ? 1 : 0, run.tracked[i], `${label}: tracked LineCheck at ${name}`);
      if (play) assert.equal(play.node, run.trackedHits[i].item, `${label}: node at ${name}`);
    }
    if (play) {
      const n = native.trackedHits[i], r = renderPass.trackedHits[i];
      assert.equal(bits(play.time), n.time, `${label}: Time`);
      assert.deepEqual(play.location.map(bits), n.location, `${label}: Location`);
      assert.deepEqual(play.normal.map(bits), n.normal, `${label}: Normal`);
      ulp = Math.max(ulp, Math.abs(bits(play.time) - r.time));
      assert.ok(Math.abs(bits(play.time) - r.time) <= 2, `${label}: Time at the render pass's precision`);
    }
    // The original's outcome, as far as a world hit goes: a clear segment is
    // clear, a segment the original blocked with the level or a mover is blocked
    // (the mover's own hit is an actor hit, found through the hash, not here).
    if (!hit) assert.ok(play === null, `${label}: the original found it clear`);
    else if (hit.actor === 'LevelInfo0') assert.ok(play !== null, `${label}: the original hit the level model`);
    rows.push({ label, original: hit ? `${hit.actor} ${hit.time.toFixed(5)}` : 'clear', static: still ? still.time.toFixed(5) : 'clear',
      tracked: play ? `${play.time.toFixed(5)} node ${play.node}` : 'clear' });
  });
  // Light34's hit (the walk the fragments change ends at static node 292) is
  // the measured one: the DLL at the render pass's precision gives its Time
  // to the bit; traceRayFast, at the game thread's, is one ulp below.
  const light34 = MEASURED.findIndex(([label]) => label === 'Light34'), measured34 = MEASURED[light34][2];
  const play34 = traceRayFast(tracked, start, ends[light34]), render34 = renderPass.trackedHits[light34];
  assert.equal(word(render34.time), measured34.time, 'Light34: the DLL at 0x007f gives the original\'s Time');
  assert.equal(bits(play34.time) + 1, render34.time, 'Light34: Play\'s Time is the one ulp below');
  assert.equal(play34.node, measured34.item, 'Light34: node equals the original\'s');
  assert.deepEqual(play34.location.map(v => +v.toFixed(3)), measured34.location, 'Light34: Location');
  assert.deepEqual(play34.normal.map(v => +v.toFixed(3)), measured34.normal, 'Light34: Normal');
  // The static model lets the three lamps through.
  for (const label of ['Light34', 'Light35', 'Light36'])
    assert.equal(traceRayFast(model, start, ends[MEASURED.findIndex(([name]) => name === label)]), null, `${label}: the static model is clear`);

  // 2. The corona scan: the helper's visit list and what it passes.
  const asset = await assets.get(MAP);
  const game = await createGame(built.map, asset, assets, { randomSeed: 1 });
  const exportName = ref => exportAt(asset.pkg, ref)?.name;
  const view = { location: EYE, rotation: [-1850, 25298, 0], fov: 75 }, rect = { width: 1280, height: 720 };
  const scan = lineModel => createCoronaScan(game.doors.scriptRuntime.runtime, { model, exportName, player: () => game.player.collisionActor, lineModel })
    .update(view, rect, null, [], 0);
  const over = scan(() => occlusion.lineModel()), without = scan(() => null);
  assert.equal(over.stats.leafLights, 11, 'the helper is offered the original\'s 11 lights');
  assert.equal(over.stats.visible, 6, 'six lights pass both checks, as in the original');
  for (const name of ['Light33', 'Light31', 'Light37', 'Light38', 'Light44']) assert.ok(over.seen.includes(name), `${name} passes`);
  for (const name of ['Light34', 'Light35', 'Light36', 'Light60']) assert.ok(!over.seen.includes(name), `${name} is hidden`);
  assert.equal(without.stats.leafLights, 11);
  assert.deepEqual(without.seen.filter(name => !over.seen.includes(name)).sort(), ['Light34', 'Light35', 'Light36'],
    'over the static model the fan\'s lamps pass (the divergence)');
  report = { rows, renderPassTimeUlp: ulp, scan: { tracked: { visited: over.stats.leafLights, passed: over.seen }, staticModel: { passed: without.stats.visible } } };
} finally { occlusion.dispose(); }
console.log(JSON.stringify(report, null, 1));
console.log('validate-coronas-tracked: PASS');
process.exit(0);
