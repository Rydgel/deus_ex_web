import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { AssetStore } from '../src/unreal/assets.mjs';
import { ClassDefaults } from '../src/unreal/classes.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { readModel } from '../src/unreal/model.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory(), f = Math.fround, cases = [], maps = [];
const bounds = { min: [-13.25, -27.5, -3.125], max: [48.75, 56, 18.5], valid: true };
for (const valid of [false, true]) for (const primitive of [false, true]) {
  cases.push({ bounds: { ...bounds, valid }, primitive });
  cases.push({ bounds: { ...bounds, valid }, primitive, owner: {} });
}
for (let axis = 0; axis <= 6; axis++) for (const shearRate of [-.7, -.6, -.55, -.05, 0, .05, .55, .6, .7]) {
  for (const Rotation of [[0,0,0], [0,16384,0], [2049,-3191,4097]]) cases.push({ bounds, owner: {
    Location: [100.25,-32.125,12], PrePivot: [12,13,14], Rotation,
    MainScale: { scale: [2,.5,-1], shearAxis: axis, shearRate },
    PostScale: { scale: [.75,1.5,2], shearAxis: 6-axis, shearRate: -shearRate },
  } });
}
for (const Location of [[0,0,0], [100.25,-32.125,12], [1e6, -1e6, 1e6]]) {
  for (const CollisionRadius of [0, .001, 17, 123.456]) for (const CollisionHeight of [0, .001, 42, 234.567]) {
    cases.push({ primitive: true, bounds, owner: { Location, CollisionRadius, CollisionHeight } });
  }
}
const files = [];
for (const directory of ['Maps', 'System']) for (const name of await readdir(path.join(root, directory))) {
  files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
}
const assets = new AssetStore(files), defaults = new ClassDefaults(assets);
for (const name of ['00_Training', '01_NYC_UNATCOIsland']) {
  const asset = await assets.get(name), map = decodeMap(asset.bytes); let movers = 0;
  for (const actor of map.actors) {
    const values = await defaults.forActor(asset, actor);
    if (!values.bIsMover || !(values.Brush > 0)) continue;
    movers++;
    const model = readModel(asset.pkg, asset.bytes, values.Brush);
    for (const fraction of [0,.5,1]) cases.push({ name: `${name}/${actor.name}/${fraction}`, bounds: model.bounds, owner: {
      ...values, Location: values.Location.map((v,i) => f(v + (values['KeyPos[1]']?.[i] ?? 0) * fraction)),
      Rotation: (values.Rotation ?? [0,0,0]).map((v,i) => (v + (values['KeyRot[1]']?.[i] ?? 0) * fraction) | 0),
    } });
  }
  maps.push({ name, movers, sha256: createHash('sha256').update(asset.bytes).digest('hex') });
}
const directory = path.resolve('reports/movement/native-bounds');
await mkdir(directory, { recursive: true });
const casesFile = path.join(directory, 'cases.json');
await writeFile(casesFile, JSON.stringify(cases));
const { stdout } = await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON ?? 'python3',
  ['scripts/native-bounds-oracle.py', root, casesFile], { maxBuffer: 32 * 1024 * 1024, timeout: 120000 });
await writeFile(path.join(directory, 'original.json'), stdout);
const reference = JSON.parse(stdout);
if (process.argv.includes('--capture-only')) {
  console.log(JSON.stringify({ cases: cases.length, maps, hashes: reference.hashes }));
} else {
  const { brushCollisionBounds, primitiveCollisionBounds } = await import('../src/runtime/brush-bounds.mjs');
  const mismatches = [];
  for (const [index, c] of cases.entries()) {
    const actual = (c.primitive ? primitiveCollisionBounds : brushCollisionBounds)({ bounds: c.bounds }, c.owner);
    try { assert.deepEqual(actual, reference.results[index]); }
    catch { mismatches.push({ index, name: c.name, actual, expected: reference.results[index] }); }
  }
  const summary = { cases: cases.length, maps, hashes: reference.hashes, mismatches };
  await writeFile(path.join(directory, 'comparison.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, mismatches: mismatches.slice(0, 10), mismatchCount: mismatches.length }, null, 2));
  assert.equal(mismatches.length, 0);
}
