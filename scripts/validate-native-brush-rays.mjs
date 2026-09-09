import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Vector3 } from 'three';
import { AssetStore } from '../src/unreal/assets.mjs';
import { ClassDefaults } from '../src/unreal/classes.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { readModel } from '../src/unreal/model.mjs';
import { toView, fromView } from '../src/unreal/geometry.mjs';
import { brushMatrix } from '../src/viewer/transforms.mjs';
import { nativeModel } from './native-model.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory(), f = Math.fround, captureOnly = process.argv.includes('--capture-only');
const files = [];
for (const directory of ['Maps', 'System']) for (const name of await readdir(path.join(root, directory))) {
  files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
}
const assets = new AssetStore(files), defaults = new ClassDefaults(assets);
const plane = { rootOutside: 1, leafHulls: [], nodes: [{ plane: [1, 0, 0, 3.25], zoneMask: [0, 0],
  vertexPool: 0, surface: 0, back: -1, front: -1, coplanar: -1, collisionBound: -1,
  renderBound: -1, zones: [0, 0], vertexCount: 4, flags: 0, leaves: [-1, -1] }] };
const groups = [{ name: 'one-plane', model: plane, cases: [] }];
let seed = 872679;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const vector = (size = 100) => Array.from({ length: 3 }, () => f((random() * 2 - 1) * size));
const owners = [{}, { Location: [100, -32, 12], PrePivot: [12, 13, 14] },
  ...[[0, 16384, 0], [0, -16384, 0], [0, 7001, 0], [2049, -3191, 4097], [0, 0, 0]].map(Rotation => ({
    Location: [100, -32, 12], PrePivot: [12, 13, 14], Rotation,
    MainScale: { scale: [2, .5, -1] }, PostScale: { scale: [.75, 1.5, 2] } })),
  ...Array.from({ length: 6 }, (_, i) => ({ Location: [-3, 5, 7], PrePivot: [1, 2, 3],
    Rotation: [2048, 4096, -8192], MainScale: { scale: [2, 3, 1], shearRate: .6, shearAxis: i + 1 },
    PostScale: { scale: [1, .5, -2], shearRate: -.3, shearAxis: 6 - i } }))];
for (const owner of owners) for (let i = 0; i < 40; i++) {
  const start = vector().map((v, axis) => f(v + (owner.Location?.[axis] ?? 0)));
  groups[0].cases.push({ owner, start, delta: i === 0 ? [0, 0, 0] : vector(200),
    extent: [0, 0, 0], extraNodeFlags: i % 3 === 0 ? 0x10 : 0 });
}
for (const name of ['00_Training', '01_NYC_UNATCOIsland']) {
  const asset = await assets.get(name), map = decodeMap(asset.bytes), movers = [];
  for (const actor of map.actors) {
    const values = await defaults.forActor(asset, actor);
    if (values.bIsMover && values.Brush > 0 && values.bBlockPlayers) movers.push({ ...actor, values });
  }
  const selected = name === '00_Training' ? movers.filter(a => ['DeusExMover16', 'DeusExMover17'].includes(a.name)) : movers.slice(0, 2);
  assert.equal(selected.length, 2);
  for (const actor of selected) {
    const model = readModel(asset.pkg, asset.bytes, actor.values.Brush), cases = [];
    const mapHash = createHash('sha256').update(asset.bytes).digest('hex');
    for (const fraction of [0, .5, 1]) {
      const owner = { ...actor.values, Location: actor.values.Location.map((v, i) =>
        f(v + (actor.values['KeyPos[1]']?.[i] ?? 0) * fraction)) };
      // Existing render transforms only distribute probe inputs near the brush;
      // the original DLL supplies all expected transforms and collision results.
      const matrix = brushMatrix(owner), center = fromView(new Vector3(...toView(model.bounds.min.map((v, i) =>
        (v + model.bounds.max[i]) / 2))).applyMatrix4(matrix).toArray());
      for (let i = 0; i < 100; i++) {
        const start = vector(100).map((v, axis) => f(v + center[axis]));
        cases.push({ owner, start, delta: i === 0 ? [0, 0, 0] : vector(200), extent: [0, 0, 0], extraNodeFlags: i % 4 === 0 ? 0x10 : 0 });
      }
    }
    groups.push({ name: `${name}-${actor.name}`, mapHash, model, cases });
  }
}

const reports = [];
for (const group of groups) {
  const directory = path.resolve('reports/movement/native-brush-rays', group.name);
  await mkdir(directory, { recursive: true });
  const modelFile = path.join(directory, 'model.json'), casesFile = path.join(directory, 'cases.json');
  await writeFile(modelFile, JSON.stringify(nativeModel(group.model)));
  await writeFile(casesFile, JSON.stringify(group.cases));
  const { stdout } = await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON ?? 'python3',
    [fileURLToPath(new URL('./native-brush-oracle.py', import.meta.url)), root, modelFile, casesFile],
    { maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
  await writeFile(path.join(directory, 'original.json'), stdout);
  const native = JSON.parse(stdout);
  assert.equal(native.results.length, group.cases.length);
  if (captureOnly) {
    console.log(JSON.stringify({ name: group.name, captured: native.results.length, hits: native.results.filter(r => !r.line.outside).length }));
    continue;
  }
  const { traceRay } = await import('../src/runtime/ray.mjs');
  const { brushToWorld } = await import('../src/runtime/coords.mjs');
  const mismatches = [];
  let hits = 0, maxError = 0;
  const comparisons = group.cases.map((input, index) => {
    const reference = native.results[index], expected = reference.line;
    // Coordinate generation and ray traversal have separate native corpora;
    // now verify their complete composition from the same original actor fields.
    const coords = brushToWorld(input.owner);
    const actual = traceRay(group.model, input.start, input.start.map((v, i) => f(v + input.delta[i])),
      input.extraNodeFlags, coords);
    const reasons = [];
    if (coords.some((v, i) => !Object.is(v, reference.coords[i]))) reasons.push('coords');
    if (!actual !== expected.outside) reasons.push('outside');
    if (actual && !expected.outside) {
      hits++;
      for (const key of ['time', 'normal', 'location']) {
        const a = key === 'time' ? [actual.time] : actual[key], b = key === 'time' ? [expected.time] : expected[key];
        maxError = Math.max(maxError, ...a.map((v, i) => Math.abs(v - b[i])));
        if (a.some((v, i) => !Object.is(v, b[i]))) reasons.push(key);
      }
    }
    if (reasons.length) mismatches.push({ index, reasons });
    return { input, actual, expected, coords, expectedCoords: reference.coords };
  });
  const summary = { name: group.name, mapHash: group.mapHash, binaryHashes: native.hashes,
    cases: group.cases.length, hits, scope: 'complete ABrush.ToWorld and owned UModel zero-extent rays from actor fields',
    comparison: 'exact coordinates, hit/miss, time, normal and location, including signed zero', maxError, mismatches };
  await writeFile(path.join(directory, 'comparison.json'), JSON.stringify({ summary, comparisons }, null, 2));
  console.log(JSON.stringify({ ...summary, mismatches: mismatches.slice(0, 6), mismatchCount: mismatches.length }, null, 2));
  reports.push(summary);
}
assert.equal(reports.reduce((sum, report) => sum + report.mismatches.length, 0), 0, 'owned ray translation matches original LineCheck');
