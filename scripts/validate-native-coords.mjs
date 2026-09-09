import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';

const cases = [{}], captureOnly = process.argv.includes('--capture-only'), f = Math.fround;
const origin = { Location: [1317.25, -319.75, -77.125], PrePivot: [101, 7.5, -31] };
const angles = [-2147483648, -65537, -65536, -65535, -16385, -16384, -1, 0, 1, 3, 4, 16383, 16384, 16385, 65535, 65536, 2147483647];
for (let axis = 0; axis < 3; axis++) for (const angle of angles) {
  const Rotation = [0, 0, 0]; Rotation[axis] = angle;
  cases.push({ ...origin, Rotation });
}
const rates = [-1, -.650001, -.65, -.649999, -.550001, -.55, -.549999, -.050001, -.05, -.049999,
  0, .049999, .05, .050001, .549999, .55, .550001, .649999, .65, .650001, 1];
for (const key of ['MainScale', 'PostScale']) for (let shearAxis = 1; shearAxis <= 6; shearAxis++) {
  for (const shearRate of rates) cases.push({ ...origin, Rotation: [12345, -7987, 19999],
    [key]: { scale: [2, .5, -3], shearAxis, shearRate: f(shearRate) } });
}
let seed = 9172;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const vector = size => Array.from({ length: 3 }, () => f((random() * 2 - 1) * size));
const scale = () => ({ scale: Array.from({ length: 3 }, () => f((random() < .3 ? -1 : 1) * (.2 + random() * 4))),
  shearRate: f(random() * 2 - 1), shearAxis: Math.floor(random() * 7) });
for (let i = 0; i < 400; i++) cases.push({ Location: vector(4096), PrePivot: vector(512),
  Rotation: Array.from({ length: 3 }, () => Math.floor(random() * 200000 - 100000)), MainScale: scale(), PostScale: scale() });
const directory = path.resolve('reports/movement/native-coords');
await mkdir(directory, { recursive: true });
const casesFile = path.join(directory, 'cases.json');
await writeFile(casesFile, JSON.stringify(cases));
const { stdout } = await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON ?? 'python3',
  [fileURLToPath(new URL('./native-coords-oracle.py', import.meta.url)), gameDirectory(), casesFile],
  { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
await writeFile(path.join(directory, 'original.json'), stdout);
const native = JSON.parse(stdout);
assert.equal(native.coords.length, cases.length);
if (captureOnly) console.log(JSON.stringify({ capturedCoords: native.coords.length, sineTableEntries: native.sineTable.length }));
else {
  const { brushToWorld, rotationSineTable } = await import('../src/runtime/coords.mjs');
  const table = rotationSineTable(), sineMismatches = [];
  assert.equal(table.length, native.sineTable.length);
  for (const [index, value] of table.entries()) if (!Object.is(value, native.sineTable[index])) sineMismatches.push(index);
  const mismatches = [], comparisons = [];
  let maxError = 0;
  for (const [index, input] of cases.entries()) {
    const actual = brushToWorld(input), expected = native.coords[index];
    const components = actual.flatMap((value, i) => Object.is(value, expected[i]) ? [] : [i]);
    if (components.length) mismatches.push({ index, components });
    maxError = Math.max(maxError, ...actual.map((v, i) => Math.abs(v - expected[i])));
    comparisons.push({ input, actual, expected });
  }
  const summary = { cases: cases.length, sineTableEntries: table.length, sineMismatches, binaryHashes: native.hashes,
    comparison: 'exact float32 origin/axes and sine table, including signed zero', maxError, mismatches };
  await writeFile(path.join(directory, 'comparison.json'), JSON.stringify({ summary, comparisons }, null, 2));
  console.log(JSON.stringify({ ...summary, mismatches: mismatches.slice(0, 10), sineMismatches: sineMismatches.slice(0, 10),
    mismatchCount: mismatches.length, sineMismatchCount: sineMismatches.length }, null, 2));
  assert.equal(mismatches.length + sineMismatches.length, 0, 'coordinates and sine table match original routines');
}
