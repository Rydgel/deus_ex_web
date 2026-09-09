import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { decodeMap } from '../src/unreal/map.mjs';
import { BspCollider } from '../src/runtime/collision.mjs';
import { gameDirectory } from './game-directory.mjs';
import { nativeModel } from './native-model.mjs';

// A bounded original-binary comparison for training's entrance/stairs region.
// This neither establishes whole-map compatibility nor substitutes internal tests.
const root = gameDirectory(), reportDir = path.resolve('reports/movement/native-collision');
const bytes = await readFile(path.join(root, 'Maps/00_Training.dx'));
const mapHash = createHash('sha256').update(bytes).digest('hex');
assert.equal(mapHash, 'bb66d95aafc6aae4179f8444e98661f3d5d27dab06d13d7dde7f4b5f4e24068d', 'supported original training map');
const { model } = decodeMap(bytes), collider = new BspCollider(model), cases = [];
for (const z of [-180, -130, -90, -85, -84.95, -82.9, -80.2, -65.1]) {
  for (const delta of [[0, 0, 30], [0, 0, -30], [20, 0, 0], [0, 0, -27], [10, 10, -1], [0, 0, -.2], [0, 0, -100]]) {
    cases.push({ start: [-1149.24353, 825.84393, z], delta, extent: [20, 20, 43] });
  }
}
let seed = 713;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
for (let i = 0; i < 400; i++) {
  cases.push({ start: [-1200 + random() * 2000, 750 + random() * 200, -140 + random() * 160],
    delta: [random() * 80 - 40, random() * 80 - 40, random() * 80 - 40], extent: [20, 20, i % 3 === 0 ? 16 : 43] });
}
await mkdir(reportDir, { recursive: true });
const modelFile = path.join(reportDir, 'model.json'), casesFile = path.join(reportDir, 'cases.json');
await writeFile(modelFile, JSON.stringify(nativeModel(model)));
await writeFile(casesFile, JSON.stringify(cases));
const { stdout } = await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON ?? 'python3',
  [fileURLToPath(new URL('./native-collision-oracle.py', import.meta.url)), root, modelFile, casesFile],
  { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
const native = JSON.parse(stdout), mismatches = [];
assert.equal(native.results.length, cases.length);
let maxTimeError = 0, hits = 0, pointOverlaps = 0;
const comparisons = cases.map((c, i) => {
  const actual = collider.sweep(c.start, c.delta, c.extent), overlap = collider.overlaps(c.start, c.extent);
  const expected = native.results[i], reasons = [];
  if (!actual !== expected.line.outside) reasons.push('line hit/miss');
  if (overlap === expected.point.outside) reasons.push('point overlap');
  if (overlap) pointOverlaps++;
  if (actual && !expected.line.outside) {
    hits++;
    const error = Math.abs(actual.time - expected.line.time);
    maxTimeError = Math.max(error, maxTimeError);
    if (error > 1e-4) reasons.push('line time');
    if (actual.normal.some((v, axis) => Math.abs(v - expected.line.normal[axis]) > 1e-4)) reasons.push('line normal');
  }
  if (reasons.length) mismatches.push({ index: i, reasons });
  return { case: c, expected, actual, overlap };
});
const summary = { mapHash, binaryHashes: native.hashes, cases: cases.length, hits, pointOverlaps, maxTimeError,
  timeTolerance: 1e-4, normalTolerance: 1e-4, mismatches };
await writeFile(path.join(reportDir, 'comparison.json'), JSON.stringify({ summary, comparisons }, null, 2));
console.log(JSON.stringify(summary, null, 2));
assert.equal(mismatches.length, 0, 'browser collision agrees with original binary for all sampled cases');
