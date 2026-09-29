import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { decodeMap } from '../src/unreal/map.mjs';
import { BspCollider } from '../src/runtime/collision.mjs';
import { findSpot } from '../src/runtime/fitting.mjs';
import { gameDirectory } from './game-directory.mjs';
import { nativeModel } from './native-model.mjs';
import { loadTraceKernel } from '../src/runtime/trace-kernel.mjs';
await loadTraceKernel(); // Rust BSP traces; TRACE_KERNEL=js runs the JavaScript bodies

const f = Math.fround, root = gameDirectory(), reports = [];
let seed = 786401;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
for (const name of ['00_Training', '01_NYC_UNATCOIsland']) {
  const bytes = await readFile(path.join(root, 'Maps', `${name}.dx`));
  const mapHash = createHash('sha256').update(bytes).digest('hex');
  const { model, actors } = decodeMap(bytes), collider = new BspCollider(model);
  const start = actors.find(a => a.className === 'PlayerStart').values.Location, cases = [];
  for (const offset of [[0, 0], [100, 0], [300, 0], [600, 0], [900, 0], [1100, 0], [0, -150], [0, 150]]) {
    for (const z of [-110, -65, -40, -20, 0, 20, 60, 100]) for (const height of [16, 43]) {
      for (const checkFirst of [0, 1]) cases.push({ position: start.map((v, axis) => f(v + (axis === 2 ? z : offset[axis]))),
        extent: [20, 20, height], options: [0, checkFirst] });
    }
  }
  for (let i = 0; i < 300; i++) cases.push({ position: [start[0] - 200 + random() * 1500,
    start[1] - 200 + random() * 400, start[2] - 150 + random() * 250].map(f),
    extent: [20, 20, i % 2 ? 16 : 43], options: [0, (i >> 1) % 2] });
  const directory = path.resolve('reports/movement/native-world-fitting', name);
  await mkdir(directory, { recursive: true });
  const casesFile = path.join(directory, 'cases.json'), modelFile = path.join(directory, 'model.json');
  await writeFile(casesFile, JSON.stringify(cases));
  await writeFile(modelFile, JSON.stringify(nativeModel(model)));
  const { stdout } = await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON ?? 'python3',
    [fileURLToPath(new URL('./native-fitting-oracle.py', import.meta.url)), root, casesFile, modelFile],
    { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  const native = JSON.parse(stdout);
  await writeFile(path.join(directory, 'original.json'), stdout);
  assert.equal(native.results.length, cases.length);
  let maxPositionError = 0, corrected = 0, successes = 0, exactPositions = 0, lineChecks = 0, pointChecks = 0;
  const mismatches = [];
  const comparisons = cases.map((input, index) => {
    const events = [];
    const queries = {
      pointCheck(position, extent, flags, extra) {
        const outside = !collider.overlaps(position, extent);
        events.push({ point: { position, extent, flags, extra }, result: { outside } }); return outside ? 1 : 0;
      },
      lineCheck(start, end, extent, flags, extra) {
        const hit = collider.sweep(start, end.map((v, axis) => v - start[axis]), extent);
        events.push({ line: { start, end, extent, flags, extra }, result: hit ? { outside: false,
          time: hit.time, normal: hit.normal, location: hit.location } : { outside: true } });
        return hit ?? { time: 1, normal: [0, 0, 0] };
      },
    };
    const position = findSpot(queries, input.position, input.extent, ...input.options), expected = native.results[index];
    if (expected.success) successes++;
    if (expected.success && expected.position.some((v, axis) => v !== input.position[axis])) corrected++;
    const actual = { success: position !== null, position: position ?? input.position };
    const error = Math.max(...actual.position.map((v, axis) => Math.abs(v - expected.position[axis])));
    maxPositionError = Math.max(maxPositionError, error);
    if (actual.position.every((v, axis) => Object.is(v, expected.position[axis]))) exactPositions++;
    const reasons = [];
    try { assert.deepEqual(actual, { success: expected.success, position: expected.position }); }
    catch { reasons.push('placement'); }
    if (events.length !== expected.events.length) reasons.push('query count');
    for (const [eventIndex, event] of events.entries()) {
      const reference = expected.events[eventIndex], type = event.line ? 'line' : 'point';
      if (type === 'line') lineChecks++; else pointChecks++;
      try {
        assert.deepEqual(event[type], reference?.[type]);
        assert.equal(event.result.outside, reference.result.outside);
        // FindSpot consumes only point clear/blocked; point recovery data is
        // separate unverified scope. Compare every returned ray field it uses,
        // plus location, without masking signed zero or float-store differences.
        if (type === 'line' && !event.result.outside) for (const key of ['time', 'normal', 'location']) {
          assert.deepEqual(event.result[key], reference.result[key]);
        }
      } catch { reasons.push(`query ${eventIndex}`); }
    }
    if (reasons.length) mismatches.push({ index, reasons });
    return { input, actual, expected, events, error, reasons };
  });
  const summary = { name, mapHash, binaryHashes: native.hashes, cases: cases.length, successes, corrected, exactPositions, lineChecks, pointChecks,
    scope: 'original complete FindSpot / AdjustSpot / level / model query chain; actor collision hash absent on both sides',
    comparison: 'exact position, success, query order/arguments, point hit/miss and ray hit/miss/time/normal/location', maxPositionError, mismatches };
  await writeFile(path.join(directory, 'comparison.json'), JSON.stringify({ summary, comparisons }, null, 2));
  reports.push(summary);
  console.log(JSON.stringify({ ...summary, mismatches: mismatches.slice(0, 12), mismatchCount: mismatches.length }, null, 2));
}
assert.equal(reports.reduce((sum, report) => sum + report.mismatches.length, 0), 0, 'world placement agrees with original query/physics chain');
