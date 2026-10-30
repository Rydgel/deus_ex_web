/** ULevel::FindSpot when AdjustSpot meets a NaN Hit.Time (docs/fitting.md "NaN in
 * FindSpot"): Play's translation against Engine.dll executed under Unicorn.
 *
 * DeusExMover2's break (dor3, tick 320) spawns MetalFragments at `spawnLoc +
 * FragmentSpread * VRand()`; the sixth attempt starts inside the door. AdjustSpot's
 * first probe (-X, flags 6) meets the door's fragments in Level->Model at time 0
 * and DeusExMover2 itself, and ULevel::MultiLineCheck's mover recovery gives the
 * mover hit a NaN Time. AdjustSpot reads `Hit.Time < 1` with FCOMP + `test ah, 1`
 * (0x103983b3-0x103983c1), which an unordered compare satisfies: the candidate
 * becomes NaN, every later probe, the point check and the displacement test run on
 * it, and FindSpot returns 0 (the displacement test, FCOMPP + `test ah, 1`, is C0
 * for a NaN too, 0x1039896f). Play skipped the adjustment (JavaScript's `<` is false
 * for a NaN), fitted the fragment at x + 6.3 and made one fragment more than the
 * original (15, not 14), and drew the rand stream a fragment's start-up later.
 *
 * The oracle (scripts/native-tracked-fitting-oracle.py) is native-level-oracle.py's
 * level (the original hash, SetActorCollision, every collidable actor with its brush
 * through ABrush::ToWorld, UModel::LineCheck / PointCheck) with the model's nodes
 * replaced by the brush tracker's (Play's Rust tracker after GNewBrushTracker's
 * Update(NULL): the node block the dor3 replay held at tick 320 differs from it in
 * the render's NF_PolyOccluded / NF_BoxOccluded bits only, which collision's
 * 0x21 mask never reads). It runs the unchanged FindSpot (0x10398480) and lists
 * every call of the chain with its arguments and result as float words. Compared:
 *
 *   1. FindSpot on dor3's 16 MetalFragment attempts (position, extent 6, 6, 0) and on
 *      seeded positions through the door's box (extents 6, 6, 0 and 20, 20, 43; half of them meet a NaN Time): success,
 *      position, and every point check and AdjustSpot line check with its result;
 *   2. ULevel::SingleLineCheck and SinglePointCheck on NaN vectors, with and without
 *      the actor hash (the hash's one-cell walk of a NaN line, MultiLineCheck's list);
 *   3. UModel::LineCheck (zero extent) and PointCheck on NaN rays and positions over
 *      the static BSP and the tracked model of both maps (the facing test of a NaN
 *      ray, the traversal of a NaN point).
 *
 * Supported NaN domain (the oracle's cases): a line query whose Start and End are both
 * all-NaN; a point at a position with a NaN component (zero or nonzero extent); a BSP
 * ray with any NaN component. A hash line query with one NaN vector stays unsupported
 * (it throws, as before): FindSpot never makes one.
 *
 *   node scripts/validate-native-findspot-nan.mjs [--cases N]   (N NaN-producing seeded positions and as many others, default 16; 40 passed on 2026-10-20, 8.5 minutes)
 *
 * Needs NATIVE_PROBE_PYTHON (default .cache/native-probe-env/bin/python): SKIP without it.
 * runner-timeout: 1200 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { ClassDefaults } from '../src/unreal/classes.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { nativeLevelScene } from './native-level-scene.mjs';
import { nativeModel, typedSceneModels } from './native-model.mjs';
import { loadScriptVmKernel } from '../src/runtime/script-vm-kernel.mjs';
import { createBspOcclusion } from '../src/runtime/bsp-occlusion.mjs';
import { createLevelQueries } from '../src/runtime/level-queries.mjs';
import { traceExtent } from '../src/runtime/extent-trace.mjs';
import { loadTraceKernel } from '../src/runtime/trace-kernel.mjs';
import { traceRay, traceRayFast } from '../src/runtime/ray.mjs';
import { modelPointCheck } from '../src/runtime/point-check.mjs';
import { findSpot } from '../src/runtime/fitting.mjs';
import { buildMap, bits } from './brush-tracker-request.mjs';

const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
if (!existsSync(python)) { console.log('SKIP validate-native-findspot-nan: no native probe environment'); process.exit(0); }
const argument = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
await loadTraceKernel();
const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files), defaults = new ClassDefaults(assets), kernel = (await loadScriptVmKernel()).occlusion;
const directory = path.resolve('reports/movement/native-findspot-nan');
mkdirSync(directory, { recursive: true });

const floatOf = word => new Float32Array(new Uint32Array([word >>> 0]).buffer)[0];
const NAN = 0xffc00000, QNAN = 0x7fc00000;
// A Play number against a native float word: a NaN against a NaN (the payload is a JavaScript engine's), else the same value with the same sign of zero.
const sameWord = (number, word) => { const native = floatOf(word); return Number.isNaN(number) ? Number.isNaN(native) : Object.is(number, native); };
const describe = number => Number.isNaN(number) ? 'NaN' : Object.is(number, -0) ? '-0' : String(number);
const differences = [];
const check = (label, ok, detail = () => '') => { if (!ok) differences.push(`${label}: ${detail()}`); return ok; };
const vectorsMatch = (numbers, words) => numbers.length === words.length && numbers.every((v, i) => sameWord(v, words[i]));
const show = (numbers, words) => `Play [${numbers.map(describe)}] native [${words.map(w => describe(floatOf(w)))}]`;

// ---- the Island: tracked Level->Model, the map's hash --------------------------------------------------------------
const mapName = '01_NYC_UNATCOIsland';
const asset = await assets.get(mapName), map = decodeMap(asset.bytes);
const scene = await nativeLevelScene(defaults, asset, map);
const built = await buildMap(assets, mapName);
const trackerMovers = built.actors.map((a, i) => ({ tag: 0x40000000 + i, flags: a.flags, locationBits: a.locationBits, rotation: a.rotation,
  prePivotBits: a.prePivotBits, mainScale: a.mainScale, postScale: a.postScale, specialLit: a.specialLit,
  polys: a.brush.polys.map(p => ({ ...p, textureKey: p.texture === null ? 0 : p.texture + 1 })) }));
const occlusion = createBspOcclusion(kernel, map.model, { surfaceTextureFlags: [], tracker: { movers: trackerMovers } });
occlusion.tracker.construct({ pc64: true });
const collision = occlusion.collisionModel(), nodeBlock = occlusion.lineNodes();
const rawNodes = Array.from(new Uint32Array(nodeBlock.memory.buffer, nodeBlock.at, 16 * nodeBlock.count));
Object.defineProperty(map.model, 'trackedCollision', { configurable: true, value: () => collision });
const runtimeActors = scene.actors.map(actor => ({ ...actor }));
for (const actor of runtimeActors) actor.owner = runtimeActors.find(a => a.id === actor.owner) ?? null;
typedSceneModels({}, runtimeActors);   // the movers' brushes as the typed tables the queries read; scene.actors keeps the JSON objects
const queries = createLevelQueries(map.model, runtimeActors, { extentCheck: traceExtent });
const model = nativeModel(map.model); delete model.nodes;
const sceneFile = path.join(directory, 'scene.json');
writeFileSync(sceneFile, JSON.stringify({ model: { ...model, rawNodes }, actors: scene.actors }));

function runOracle(name, cases) {
  const file = path.join(directory, `${name}-cases.json`);
  writeFileSync(file, JSON.stringify(cases));
  try {
    const out = execFileSync(python, ['scripts/native-tracked-fitting-oracle.py', root, sceneFile, file],
      { encoding: 'utf8', maxBuffer: 1 << 29, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ORACLE_BUDGET: '100000000' } });
    writeFileSync(path.join(directory, `${name}-original.json`), out);
    const native = JSON.parse(out);
    assert.equal(native.results.length, cases.length);
    for (const [i, r] of native.results.entries()) assert.ok(!r.error, `${name} case ${i}: ${r.error}`);
    return native.results;
  } catch (error) { throw new Error(`the native oracle failed: ${String(error.stderr ?? error.message).split('\n').slice(-5).join(' | ')}`); }
}

// ---- 1. FindSpot -----------------------------------------------------------------------------------------------------
// dor3's 16 MetalFragment attempts at tick 320 (the replay's FindSpot inputs, float32 positions).
const DOR3 = [[7688.6015625, 757.8338012695312, -101.54550170898438], [7740.89697265625, 738.3628540039062, -103.01197052001953],
  [7727.57080078125, 762.4295043945312, -115.093505859375], [7720.46630859375, 706.3368530273438, -105.12190246582031],
  [7695.474609375, 714.9281616210938, -91.79086303710938], [7713.68701171875, 708.2366943359375, -126.47925567626953],
  [7726.61474609375, 715.374267578125, -128.958984375], [7684.900390625, 727.2096557617188, -93.20262908935547],
  [7736.0341796875, 752.263671875, -120.03988647460938], [7682.87548828125, 745.204833984375, -96.73312377929688],
  [7730.12353515625, 715.49658203125, -125.09410095214844], [7692.9501953125, 712.071044921875, -123.6773681640625],
  [7709.34765625, 748.402099609375, -140.4917449951172], [7717.7021484375, 729.0115966796875, -141.26284790039062],
  [7694.19970703125, 710.99853515625, -123.21817779541016], [7714.91259765625, 736.8151245117188, -142.6101531982422]];
let seed = 0x15f1d5;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const fits = DOR3.map(position => ({ position, extent: [6, 6, 0], label: 'dor3 attempt' }));
// Seeded positions through DeusExMover2's box and the walls beside it. Play's own FindSpot is run over 6,000 of them
// (a fragment's and a pawn's extent) to find those whose AdjustSpot meets a NaN Time (about 1 in 80): the first
// NAN_CASES of them are compared with the original, with as many that do not.
const NAN_CASES = Number(argument('--cases') ?? 16);
const draw = extent => ({ position: [7676 + random() * 76, 700 + random() * 96, -150 + random() * 90].map(Math.fround), extent });
const hasNaNTime = c => {
  let nan = false;
  const watch = { pointCheck: (...a) => queries.pointCheck(...a), lineCheck(...a) { const r = queries.lineCheck(...a); nan ||= Number.isNaN(r.time); return r; } };
  findSpot(watch, c.position, c.extent, 0, 1);
  return nan;
};
const nanFound = [], plain = [];
for (let i = 0; i < 6000 && (nanFound.length < NAN_CASES || plain.length < NAN_CASES); i++) {
  const c = draw(i % 3 === 2 ? [20, 20, 43] : [6, 6, 0]);
  if (hasNaNTime(c)) { if (nanFound.length < NAN_CASES) nanFound.push({ ...c, label: 'seeded NaN' }); }
  else if (plain.length < NAN_CASES) plain.push({ ...c, label: 'seeded' });
}
fits.push(...nanFound, ...plain);
const fitCases = fits.map(c => ({ kind: 'fit', position: c.position.map(bits), extent: c.extent.map(bits), options: [0, 1] }));
const fitResults = runOracle('fit', fitCases);
let nanFits = 0, refused = 0, wrongSuccess = 0;
fits.forEach((c, i) => {
  const events = [];
  const observed = {
    pointCheck(...a) { const r = queries.pointCheck(...a); events.push({ point: a, result: r }); return r; },
    lineCheck(...a) { const r = queries.lineCheck(...a); events.push({ line: a, result: r }); return r; },
  };
  const label = `FindSpot ${c.label} ${i} [${c.position}] extent ${c.extent}`;
  let got;
  try { got = findSpot(observed, c.position, c.extent, 0, 1); } catch (error) { check(label, false, () => `Play throws: ${error.message}`); return; }
  const native = fitResults[i];
  check(`${label} success`, (got !== null) === native.success, () => `Play ${got === null ? 'refuses' : 'fits'}, native ${native.success ? 'fits' : 'refuses'}`);
  if (got !== null && native.success) check(`${label} position`, vectorsMatch(got, native.position), () => show(got, native.position));
  // the chain: depth 0 point checks, depth 1 line checks of the AdjustSpots
  const chain = native.calls.filter(k => (k.name === 'SinglePointCheck' && k.depth === 0) || (k.name === 'SingleLineCheck' && k.depth === 1));
  check(`${label} query count`, chain.length === events.length, () => `Play ${events.length}, native ${chain.length}`);
  chain.slice(0, events.length).forEach((call, k) => {
    const event = events[k], q = `${label} query ${k}`;
    if (call.name === 'SinglePointCheck') {
      check(`${q} kind`, event.point !== undefined);
      if (event.point) {
        check(`${q} position`, vectorsMatch(event.point[0], call.args.position), () => show(event.point[0], call.args.position));
        check(`${q} result`, event.result === Number(call.return & 0xff), () => `Play ${event.result}, native ${call.return & 0xff}`);
      }
    } else {
      check(`${q} kind`, event.line !== undefined);
      if (!event.line) return;
      check(`${q} start`, vectorsMatch(event.line[0], call.args.start), () => show(event.line[0], call.args.start));
      check(`${q} end`, vectorsMatch(event.line[1], call.args.end), () => show(event.line[1], call.args.end));
      const clear = Boolean(call.return & 0xff), hit = event.result;
      check(`${q} clear`, hit.outside === clear, () => `Play ${hit.outside}, native ${clear}`);
      if (!clear && !hit.outside) {
        check(`${q} time`, sameWord(hit.time, call.hit.time), () => `Play ${describe(hit.time)}, native ${describe(floatOf(call.hit.time))}`);
        check(`${q} normal`, vectorsMatch(hit.normal, call.hit.normal), () => show(hit.normal, call.hit.normal));
        check(`${q} actor`, (hit.actor?.id ?? null) === (call.hit.actor === '$world' ? '$world' : call.hit.actor), () => `Play ${hit.actor?.id ?? null}, native ${call.hit.actor}`);
      }
    }
  });
  if (events.some(e => e.line && Number.isNaN(e.result.time))) nanFits++;
  if (!native.success) refused++;
  if ((got !== null) !== native.success) wrongSuccess++;
});
check('dor3 attempt 5 is refused by the original', !fitResults[5].success, () => 'native fits it');
check('dor3 attempt 12 is refused by the original', !fitResults[12].success);
check('dor3: 14 of 16 attempts fit in the original', fitResults.slice(0, 16).filter(r => r.success).length === 14);
console.log(`1. FindSpot: ${fits.length} cases (${DOR3.length} dor3 attempts, ${nanFound.length} seeded with a NaN Hit.Time, ${plain.length} without), ${nanFits} with a NaN Hit.Time in Play's chain, ${refused} refused by the original, ${wrongSuccess} outcomes differ`);
assert.ok(nanFits >= 1 + Math.min(NAN_CASES, 20), 'the cases exercise a NaN Hit.Time');

// ---- 2. the level's NaN queries --------------------------------------------------------------------------------------
const A = [7713.68701171875, 708.2366943359375, -126.47925567626953].map(bits);
const vectors = { A, NN: [NAN, NAN, NAN], QQ: [QNAN, QNAN, QNAN] };
const extents = { zero: [0, 0, 0], six: [bits(6), bits(6), 0], pawn: [bits(20), bits(20), bits(47.5)] };
const levelCases = [], levelKeys = [];
for (const s of ['NN', 'QQ']) for (const e of ['NN', 'QQ']) for (const flags of [6, 0x17]) {
  levelCases.push({ kind: 'line', start: vectors[s], end: vectors[e], extent: [0, 0, 0], flags, extra: 0 }); levelKeys.push({ kind: 'line', s, e, flags });
}
for (const s of ['A', 'NN', 'QQ']) for (const x of Object.keys(extents)) for (const checkActors of [0, 1]) {
  levelCases.push({ kind: 'point', position: vectors[s], extent: extents[x], flags: 0, checkActors, world: true }); levelKeys.push({ kind: 'point', s, x, checkActors });
}
const levelResults = runOracle('level', levelCases);
levelCases.forEach((c, i) => {
  const key = levelKeys[i], native = levelResults[i], label = key.kind === 'line' ? `level line ${key.s}->${key.e} flags ${key.flags}` : `level point ${key.s} ${key.x} checkActors ${key.checkActors}`;
  if (key.kind === 'line') {
    const hit = queries.lineCheck(c.start.map(floatOf), c.end.map(floatOf), [0, 0, 0], c.flags, 0, null);
    check(`${label} blocked`, hit.outside === native.clear, () => `Play ${hit.outside}, native ${native.clear}`);
    if (!hit.outside && !native.clear) {
      check(`${label} time`, sameWord(hit.time, native.hit.time));
      check(`${label} location`, vectorsMatch(hit.location, native.hit.location), () => show(hit.location, native.hit.location));
      check(`${label} normal`, vectorsMatch(hit.normal, native.hit.normal), () => show(hit.normal, native.hit.normal));
      check(`${label} actor`, (hit.actor?.id ?? null) === native.hit.actor, () => `Play ${hit.actor?.id}, native ${native.hit.actor}`);
    }
    // the hash's walk of a NaN line: one cell, no actor; MultiLineCheck's list is the world hit alone
    const hash = native.calls.find(k => k.name === 'HashActorLineCheck');
    if (hash) check(`${label} hash cells`, JSON.stringify(hash.cells) === JSON.stringify({ min: [0, 0, 0], max: [0, 0, 0] }) && hash.hits.length === 0, () => JSON.stringify(hash));
  } else {
    const r = queries.singlePointCheck(c.position.map(floatOf), c.extent.map(floatOf), 0, queries.levelInfo, c.checkActors);
    check(`${label} blocked`, r.outside === native.clear, () => `Play ${r.outside}, native ${native.clear}`);
    if (!r.outside && !native.clear) {
      check(`${label} location`, vectorsMatch(r.hit.location, native.hit.location), () => show(r.hit.location, native.hit.location));
      check(`${label} normal`, vectorsMatch(r.hit.normal, native.hit.normal), () => show(r.hit.normal, native.hit.normal));
      check(`${label} item`, r.hit.item === (native.hit.item | 0), () => `Play ${r.hit.item}, native ${native.hit.item | 0}`);
    }
  }
});
console.log(`2. level queries: ${levelCases.length} cases (NaN lines through SingleLineCheck / MultiLineCheck / the hash, NaN points through SinglePointCheck)`);
occlusion.dispose();

// ---- 3. UModel::LineCheck / PointCheck on NaN, both maps, static and tracked --------------------------------------------
const finiteV = [0x45f12345, 0x440a0000, 0xc2fc0000];
const rays = [['all NaN', [NAN, NAN, NAN], [NAN, NAN, NAN]], ['all quiet NaN', [QNAN, QNAN, QNAN], [QNAN, QNAN, QNAN]], ['start NaN', [NAN, NAN, NAN], finiteV],
  ['end NaN', finiteV, [NAN, NAN, NAN]], ['x NaN', [NAN, finiteV[1], finiteV[2]], finiteV], ['y NaN', finiteV, [finiteV[0], NAN, finiteV[2]]],
  ['z NaN', [finiteV[0], finiteV[1], NAN], [NAN, finiteV[1], finiteV[2]]], ['finite', finiteV, [finiteV[0] + 0x00100000, finiteV[1], finiteV[2]]]];
const pointExtents = { zero: [0, 0, 0], six: [bits(6), bits(6), 0], box: [bits(8), bits(8), bits(8)], pawn: [bits(20), bits(20), bits(47.5)] };
let modelCases = 0;
for (const name of ['01_NYC_UNATCOIsland', '00_Training']) {
  const mapBuilt = await buildMap(assets, name), mapModel = mapBuilt.map.model;
  const movers = mapBuilt.actors.map((a, i) => ({ tag: 0x40000000 + i, flags: a.flags, locationBits: a.locationBits, rotation: a.rotation, prePivotBits: a.prePivotBits,
    mainScale: a.mainScale, postScale: a.postScale, specialLit: a.specialLit, polys: a.brush.polys.map(p => ({ ...p, textureKey: p.texture === null ? 0 : p.texture + 1 })) }));
  const mapOcclusion = createBspOcclusion(kernel, mapModel, { surfaceTextureFlags: [], tracker: { movers } });
  mapOcclusion.tracker.construct({ pc64: true });
  const tracked = mapOcclusion.lineModel(), trackedCollision = mapOcclusion.collisionModel();
  const request = { gameRoot: root, model: mapBuilt.model, actors: mapBuilt.actors, fillers: [], rootOutside: mapModel.rootOutside ? 1 : 0, details: true,
    checkControlWord: 0x037f, constructControlWord: 0x037f, checks: rays.map(([, start, end]) => ({ start, end })),
    points: rays.flatMap(([, start]) => Object.values(pointExtents).map(extent => ({ position: start, extent }))) };
  const original = JSON.parse(execFileSync(python, ['scripts/native-tracked-linecheck-oracle.py'],
    { input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['pipe', 'pipe', 'pipe'] }));
  for (const [state, source] of [['static', mapModel], ['tracked', tracked]]) {
    rays.forEach(([ray, start, end], i) => {
      const clear = original[state][i], hit = original[`${state}Hits`][i], label = `${name} ${state} ray ${ray}`;
      for (const [route, answer] of [['JavaScript', traceRayFast(source, start.map(floatOf), end.map(floatOf), 0, null)],
        ...(state === 'tracked' ? [['kernel route', traceRay(trackedCollision, start.map(floatOf), end.map(floatOf), 0, null)]] : [])]) {
        check(`${label} (${route}) blocked`, (answer === null) === Boolean(clear));
        if (answer && !clear) {
          check(`${label} (${route}) time`, sameWord(answer.time, hit.time));
          check(`${label} (${route}) location`, vectorsMatch(answer.location, hit.location), () => show(answer.location, hit.location));
          check(`${label} (${route}) normal`, vectorsMatch(answer.normal, hit.normal), () => show(answer.normal, hit.normal));
          check(`${label} (${route}) item`, answer.node === (hit.item | 0), () => `Play ${answer.node}, native ${hit.item | 0}`);
        }
      }
      modelCases++;
    });
    let k = 0;
    for (const [ray, start] of rays) for (const [x, extent] of Object.entries(pointExtents)) {
      const index = k++, outside = original[`${state}Points`][index], hit = original[`${state}PointHits`][index], label = `${name} ${state} point ${ray} ${x}`;
      const answer = modelPointCheck(source, start.map(floatOf), extent.map(floatOf));
      check(`${label} outside`, answer.outside === Boolean(outside), () => `Play ${answer.outside}, native ${Boolean(outside)}`);
      if (!outside && !answer.outside) {
        check(`${label} location`, vectorsMatch(answer.location, hit.location), () => show(answer.location, hit.location));
        check(`${label} normal`, vectorsMatch(answer.normal, hit.normal), () => show(answer.normal, hit.normal));
        check(`${label} item`, answer.item === (hit.item | 0), () => `Play ${answer.item}, native ${hit.item | 0}`);
      }
      modelCases++;
    }
  }
  mapOcclusion.dispose();
}
console.log(`3. models: ${modelCases} NaN rays and points over the static BSP and the tracked model of two maps`);

if (differences.length) {
  writeFileSync(path.join(directory, 'differences.txt'), differences.join('\n'));
  console.log(`FAIL validate-native-findspot-nan: ${differences.length} differences (first ${Math.min(12, differences.length)}):\n  ${differences.slice(0, 12).join('\n  ')}`);
  process.exit(1);
}
console.log('PASS validate-native-findspot-nan: Play equals Engine.dll on FindSpot with a NaN Hit.Time and on every NaN query it reaches');
