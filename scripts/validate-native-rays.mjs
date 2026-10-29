import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { decodeMap } from '../src/unreal/map.mjs';
import { traceRay } from '../src/runtime/ray.mjs';
import { gameDirectory } from './game-directory.mjs';
import { nativeModel } from './native-model.mjs';
import { modelFromObjects } from '../src/unreal/bsp-model.mjs';
import { loadTraceKernel } from '../src/runtime/trace-kernel.mjs';
await loadTraceKernel(); // Rust BSP traces; TRACE_KERNEL=js runs the JavaScript bodies

const root = gameDirectory(), f = Math.fround, reports = [];
const point = value => [f(value), 0, 0];
const plane = modelFromObjects({ rootOutside: 1, leafHulls: [], nodes: [{ plane: [1, 0, 0, 0], zoneMask: [0, 0],
  vertexPool: 0, surface: 0, back: -1, front: -1, coplanar: -1, collisionBound: -1,
  renderBound: -1, zones: [0, 0], vertexCount: 4, flags: 0, leaves: [-1, -1] }] });
const groups = [{ name: 'one-plane', model: plane, cases: [] }];
for (const a of [-10, -.001001, -.001, -.000999, 0, .000999, .001, .001001, 10]) {
  for (const extraNodeFlags of [0, 0x10, 1]) groups[0].cases.push({ start: point(a),
    delta: [0, 0, 0], extent: [0, 0, 0], extraNodeFlags });
  for (const b of [-10, -.001001, -.001, -.000999, 0, .000999, .001, .001001, 10]) {
    for (const extraNodeFlags of [0, 0x10, 1]) {
      const start = point(a), end = [f(b), 1, 0]; // Nonzero length even for equal plane distances.
      groups[0].cases.push({ start, delta: end.map((v, i) => v - start[i]), extent: [0, 0, 0], extraNodeFlags });
    }
  }
}
let seed = 910338;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
for (const name of ['00_Training', '01_NYC_UNATCOIsland']) {
  const bytes = await readFile(path.join(root, 'Maps', `${name}.dx`)), { model, actors } = decodeMap(bytes);
  const origin = actors.find(a => a.className === 'PlayerStart').values.Location, cases = [];
  for (let i = 0; i < 400; i++) {
    const start = [origin[0] - 200 + random() * 1500, origin[1] - 200 + random() * 400,
      origin[2] - 150 + random() * 250].map(f);
    const end = start.map(v => f(v + (random() * 2 - 1) * 200));
    cases.push({ start, delta: end.map((v, axis) => v - start[axis]), extent: [0, 0, 0], extraNodeFlags: i % 4 ? 0 : 0x10 });
  }
  groups.push({ name, model, cases, mapHash: createHash('sha256').update(bytes).digest('hex') });
}
for (const group of groups) {
  const directory = path.resolve('reports/movement/native-rays', group.name);
  await mkdir(directory, { recursive: true });
  const modelFile = path.join(directory, 'model.json'), casesFile = path.join(directory, 'cases.json');
  await writeFile(modelFile, JSON.stringify(nativeModel(group.model)));
  await writeFile(casesFile, JSON.stringify(group.cases));
  const model = group.model;
  const { stdout } = await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON ?? 'python3',
    [fileURLToPath(new URL('./native-collision-oracle.py', import.meta.url)), root, modelFile, casesFile],
    { maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
  const native = JSON.parse(stdout);
  // Preserve original signed-zero outputs in the unmodified Python JSON stream.
  await writeFile(path.join(directory, 'original.json'), stdout);
  let hits = 0, maxError = 0;
  const mismatches = [];
  const comparisons = group.cases.map((input, index) => {
    const end = input.start.map((v, axis) => f(v + input.delta[axis]));
    const actual = traceRay(model, input.start, end, input.extraNodeFlags), expected = native.results[index].line;
    const reasons = [];
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
    return { input, actual, expected };
  });
  const summary = { name: group.name, mapHash: group.mapHash, binaryHashes: native.hashes,
    cases: group.cases.length, hits, comparison: 'exact hit/miss, time, normal and location, including signed zero', maxError, mismatches };
  await writeFile(path.join(directory, 'comparison.json'), JSON.stringify({ summary, comparisons }, null, 2));
  console.log(JSON.stringify({ ...summary, mismatches: mismatches.slice(0, 10), mismatchCount: mismatches.length }, null, 2));
  reports.push(summary);
}
assert.equal(reports.reduce((sum, report) => sum + report.mismatches.length, 0), 0, 'world rays match original LineCheck');
