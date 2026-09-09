import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { ClassDefaults } from '../src/unreal/classes.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { readModel } from '../src/unreal/model.mjs';
import { brushCollisionBounds, primitiveCollisionBounds } from '../src/runtime/brush-bounds.mjs';
import { nativeModel } from './native-model.mjs';
import { gameDirectory } from './game-directory.mjs';
import { createHash } from 'node:crypto';
import { BspCollider } from '../src/runtime/collision.mjs';
import { createLevelQueries } from '../src/runtime/level-queries.mjs';
import { findSpot } from '../src/runtime/fitting.mjs';
import { traceExtent } from '../src/runtime/extent-trace.mjs';

const root = gameDirectory(), f = Math.fround, files = [];
for (const folder of ['Maps', 'System']) for (const name of await readdir(path.join(root, folder))) {
  files.push({ path: `${folder}/${name}`, read: () => readFile(path.join(root, folder, name)) });
}
const assets = new AssetStore(files), defaults = new ClassDefaults(assets);
let failureCount = 0;
for (const name of ['00_Training', '01_NYC_UNATCOIsland']) {
  const asset = await assets.get(name), map = decodeMap(asset.bytes), actors = [];
  for (const actor of map.actors) {
    const values = await defaults.forActor(asset, actor);
    if (!values.bCollideActors) continue;
    const lineage = await defaults.lineage(asset, asset.pkg.exports[actor.index - 1].classIndex);
    const kind = ['Pawn', 'Mover', 'ZoneInfo'].find(k => lineage.includes(`engine.${k.toLowerCase()}`)) ?? 'Actor';
    const model = values.Brush > 0 ? readModel(asset.pkg, asset.bytes, values.Brush) : null;
    actors.push({ id: actor.name, index: actor.index, kind, lineage, values,
      collisionBits: 1 | (values.bBlockActors ? 4 : 0) | (values.bBlockPlayers ? 8 : 0) | (values.bProjTarget ? 16 : 0),
      model: model && nativeModel(model) });
  }
  for (const actor of actors) actor.owner = actors.find(a => a.index === actor.values.Owner)?.id ?? null;
  const scene = { model: nativeModel(map.model), actors }, cases = { rays: [], fitting: [] };
  const start = map.actors.find(a => a.className === 'PlayerStart').values.Location;
  for (const actor of actors) {
    const bounds = actor.model ? brushCollisionBounds(actor.model, actor.values) : primitiveCollisionBounds(null, actor.values);
    const middle = bounds.min.map((v, i) => f((v + bounds.max[i]) * .5));
    for (let axis = 0; axis < 3; axis++) for (const reverse of [false, true]) {
      const from = [...middle], to = [...middle];
      from[axis] = f(bounds.min[axis] - 50); to[axis] = f(bounds.max[axis] + 50);
      for (const flags of [6, 0x17, 0x3f]) cases.rays.push({ start: reverse ? to : from,
        end: reverse ? from : to, extent: [0, 0, 0], flags });
    }
    if (actor.model) for (const delta of [[0,0,0], [20,0,0], [-20,0,0], [0,0,45]]) {
      for (const height of [16,43]) cases.fitting.push({ position: middle.map((v,i) => f(v+delta[i])), extent: [20,20,height], options: [0,0] });
    }
  }
  for (const x of [0,100,300,600,900]) for (const z of [-65,-20,0,20,60]) {
    cases.fitting.push({ position: start.map((v,i) => f(v+(i===0?x:i===2?z:0))), extent: [20,20,43], options: [0,1] });
  }
  if (process.argv.includes('--extents')) {
    cases.rays = cases.rays.filter(c => c.flags === 0x17).flatMap(c => [16,43].map(height => ({...c,extent:[20,20,height]})));
    cases.fitting = [];
  }
  if (process.argv.includes('--surfaces')) {
    const previous = JSON.parse(await readFile(path.resolve('reports/movement/native-level',name,'original.json')));
    cases.rays = cases.rays.filter((c,i) => !previous.rays[i].outside &&
      (previous.rays[i].actor === '$world' || actors.some(a => a.id === previous.rays[i].actor && a.model))).filter((c,i)=>i%7===0).slice(0,96);
    cases.fitting = [];
  }
  const directory = path.resolve('reports/movement/native-level', name + (process.argv.includes('--extents') ? '-extents' : process.argv.includes('--surfaces') ? '-surfaces' : ''));
  await mkdir(directory, { recursive: true });
  const sceneFile = path.join(directory,'scene.json'), casesFile = path.join(directory,'cases.json');
  await writeFile(sceneFile, JSON.stringify(scene)); await writeFile(casesFile, JSON.stringify(cases));
  let stdout;
  if (process.argv.includes('--compare-captured')) stdout = await readFile(path.join(directory,'original.json'), 'utf8');
  else {
    ({ stdout } = await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON ?? 'python3',
      ['scripts/native-level-oracle.py', root, sceneFile, casesFile], { maxBuffer: 64*1024*1024, timeout: 180000 }));
    await writeFile(path.join(directory,'original.json'), stdout);
  }
  const native = JSON.parse(stdout);
  assert.equal(native.sceneSha256, createHash('sha256').update(JSON.stringify(scene)).digest('hex'));
  assert.equal(native.casesSha256, createHash('sha256').update(JSON.stringify(cases)).digest('hex'));
  assert.deepEqual(native.registration, actors.map(a => a.id), 'original level registration order');
  if (process.argv.includes('--capture-only')) {
    console.log(JSON.stringify({ name, actors: actors.length, rays: native.rays.length, fitting: native.fitting.length, capture: true }));
    continue;
  }
  const runtimeActors = actors.map(actor => ({ ...actor }));
  for (const actor of runtimeActors) actor.owner = runtimeActors.find(a => a.id === actor.owner) ?? null;
  const world = new BspCollider(map.model);
  const queries = createLevelQueries(map.model, runtimeActors, { extentCheck: traceExtent, pointCheck(position, extent, flags, checkActors) {
    assert.equal(flags, 0); assert.equal(checkActors, 0);
    return world.overlaps(position, extent) ? 0 : 1;
  } });
  const mismatches = [];
  const fields = result => result.outside ? { outside: true, time: result.time, actor: result.actor?.id ?? null }
    : { outside: false, time: result.time, actor: result.actor?.id ?? null, location: result.location, normal: result.normal };
  const nativeFields = result => fields({ ...result, actor: result.actor && { id: result.actor } });
  for (const [index, c] of cases.rays.entries()) {
    const actual = fields(queries.lineCheck(c.start,c.end,c.extent,c.flags,c.extra ?? 0,runtimeActors.find(a=>a.id===c.source)??null));
    const expected = nativeFields(native.rays[index]);
    try {
      assert.deepEqual(actual,expected);
      if (process.argv.includes('--surfaces')) assert.equal(queries.lineCheck(c.start,c.end,c.extent,c.flags).item,native.rays[index].item);
    }
    catch { mismatches.push({ kind: 'ray', index, actual, expected }); }
  }
  let lineChecks = 0, pointChecks = 0;
  for (const [index,c] of cases.fitting.entries()) {
    const events = [];
    const observed = {
      pointCheck(...args) { const outside = queries.pointCheck(...args) === 1;
        const [position,extent,flags,extra] = args;
        events.push({ point: { position,extent,flags,extra }, result: { outside } }); pointChecks++; return outside ? 1 : 0; },
      lineCheck(...args) { const result = queries.lineCheck(...args), [start,end,extent,flags,extra] = args;
        events.push({ line: { start,end,extent,flags,extra,source: null }, result: fields(result) }); lineChecks++; return result; },
    };
    const position = findSpot(observed,c.position,c.extent,...c.options), expected = native.fitting[index];
    const actual = { success: position!==null, position: position??c.position, events };
    const reference = { ...expected, events: expected.events.map(e => ({ ...e,
      result: e.line ? nativeFields(e.result) : { outside: e.result.outside } })) };
    try { assert.deepEqual(actual,reference); }
    catch { mismatches.push({ kind:'fitting', index, actual, expected:reference }); }
  }
  const summary = { name, actors: actors.length, rays: cases.rays.length, fitting: cases.fitting.length,
    lineChecks, pointChecks, mismatchCount: mismatches.length };
  await writeFile(path.join(directory,'comparison.json'),JSON.stringify({summary,mismatches},null,2));
  console.log(JSON.stringify({ ...summary, examples:mismatches.slice(0,2).map(({kind,index})=>({kind,index})) }));
  failureCount += mismatches.length;
}
assert.equal(failureCount,0,'composed original level queries');
