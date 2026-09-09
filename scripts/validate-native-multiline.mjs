import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';

const f = Math.fround, cases = [], captureOnly = process.argv.includes('--capture-only');
const encode = (_, value) => typeof value === 'number' && !Number.isFinite(value)
  ? { number: Number.isNaN(value) ? 'NaN' : value > 0 ? '+Infinity' : '-Infinity' } : value;
const decode = (_, value) => value?.number === 'NaN' ? NaN : value?.number === '+Infinity' ? Infinity
  : value?.number === '-Infinity' ? -Infinity : value;
const hit = (i, time = .5, location = [50, 0, 0], normal = [1, 0, 0]) => ({ actor: `a${i}`,
  time: f(time), location: location.map(f), normal: normal.map(f), primitive: 0x11000000 + i, item: i });
const add = (value) => {
  const input = { start: [0, 0, 0], end: [100, 0, 0], extent: [0, 0, 0], extra: 0x1234,
    worldEnabled: false, worldHit: null, hashPresent: true, checkActors: 1, hits: [], ...value };
  input.actors ??= input.hits.map((h, i) => ({ id: h.actor, kind: i % 2 ? 'Actor' : 'Mover', depth: i % 3 }));
  cases.push(input);
};
let seed = 720671;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const vector = size => Array.from({ length: 3 }, () => f((random() * 2 - 1) * size));

// Original qsort's small-partition/quick-sort transitions, ties, and collection
// capacity. No world adjustment in this group, so its results isolate sorting.
for (let count = 0; count <= 72; count++) for (const pattern of ['equal', 'mixed', 'descending']) {
  add({ hits: Array.from({ length: count }, (_, i) => hit(i, pattern === 'equal' ? .5
    : pattern === 'mixed' ? Math.floor(random() * 5) / 4 : 1 - i / Math.max(1, count))) });
}
for (const worldEnabled of [false, true]) for (const hashPresent of [false, true]) {
  for (const checkActors of [0, 1]) for (const blocked of [false, true]) {
    add({ worldEnabled, hashPresent, checkActors, worldHit: blocked ? hit(99) : null,
      hits: [hit(0, .1), hit(1, .2), hit(2, .3)] });
  }
}
for (const time of [0, .0001, .009999999, .01, .010000001, .1, .5, 1]) {
  for (const distance of [0, .0001, 5, 29.999998, 30, 30.000002, 100]) {
    for (const offset of [0, 1.9999999, 2, 2.0000002]) {
      const world = hit(99, time, [distance, 0, 0]);
      add({ worldEnabled: true, worldHit: world, extent: cases.length % 2 ? [20, 20, 43] : [0, 0, 0],
        hits: [hit(0, .2, [distance + offset, 0, 0]), hit(1, .01, [distance, 0, 0]),
          hit(2, .7, [distance, 0, 0], [0, 1, 0]), hit(3, .3, [distance, 0, 0])] });
    }
  }
}
for (const count of [63, 64, 65, 80]) for (const time of [.001, .5]) {
  add({ worldEnabled: true, worldHit: hit(99, time, [10, 0, 0]),
    hits: Array.from({ length: count }, (_, i) => hit(i, .5, [20, 0, 0])) });
}
for (let i = 0; i < 400; i++) {
  const start = vector(10000), delta = vector(i % 7 === 0 ? .001 : 500), end = start.map((v, j) => f(v + delta[j]));
  const time = i % 17 === 0 ? 0 : f(random());
  const location = start.map((v, j) => f(v + delta[j] * time)), normal = vector(1);
  add({ start, end, extent: i % 2 ? [20, 20, 43] : [0, 0, 0], worldEnabled: true,
    worldHit: hit(99, time, location, normal),
    hits: Array.from({ length: i % 12 }, (_, j) => hit(j, random(),
      location.map(v => f(v + (random() - .5) * (j % 2 ? 10 : 1))),
      j % 3 === 0 ? vector(1) : normal)) });
}
const directory = path.resolve('reports/movement/native-multiline');
await mkdir(directory, { recursive: true });
const casesFile = path.join(directory, 'cases.json'), serialized = JSON.stringify(cases);
const casesSha256 = createHash('sha256').update(serialized).digest('hex');
let stdout;
if (process.argv.includes('--compare-captured')) stdout = await readFile(path.join(directory, 'original.json'), 'utf8');
else {
  await writeFile(casesFile, serialized);
  ({ stdout } = await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON ?? 'python3',
    [fileURLToPath(new URL('./native-multiline-oracle.py', import.meta.url)), gameDirectory(), casesFile],
    { maxBuffer: 64 * 1024 * 1024, timeout: 300_000 }));
  await writeFile(path.join(directory, 'original.json'), stdout);
}
const native = JSON.parse(stdout, decode);
assert.equal(native.casesSha256, casesSha256, 'original reference matches these inputs');
assert.equal(native.results.length, cases.length);
if (captureOnly) {
  console.log(JSON.stringify({ captured: cases.length,
    returnedHits: native.results.reduce((n, result) => n + result.hits.length, 0),
    nonFiniteHits: native.results.flatMap(result => result.hits).filter(h => !Number.isFinite(h.time)).length,
    scope: 'original MultiLineCheck and bundled CRT sort, with controlled world/actor queries' }, null, 2));
} else {
  const { multiLineCheck, sortLineHits } = await import('../src/runtime/multiline.mjs');
  const mismatches = [], comparisons = cases.map((input, index) => {
    const events = [], actorHits = structuredClone(input.hits);
    const kinds = new Map(input.actors.map(actor => [actor.id, actor.kind]));
    const actualHits = multiLineCheck({ hashPresent: input.hashPresent,
      isMover(actor) { return kinds.get(actor) === 'Mover'; },
      worldLineCheck(end, start, extent, extra) {
        events.push({ world: { end, start, extent, extra } }); return structuredClone(input.worldHit);
      },
      actorLineCheck(end, start, extent, extra) {
        events.push({ actors: { end, start, extent, extra } }); return actorHits;
      },
    }, input.end, input.start, input.extent, input.checkActors, input.worldEnabled ? '$world' : null, input.extra);
    for (let i = 0; i < actualHits.length; i++) assert.equal(actualHits[i].next, actualHits[i + 1] ?? null);
    const actual = { hits: actualHits.map(({ next, ...value }) => value), actorHitsAfter: actorHits, events };
    const expected = native.results[index], reasons = [];
    for (const key of ['hits', 'actorHitsAfter', 'events']) {
      try { assert.deepEqual(actual[key], expected[key]); } catch { reasons.push(key); }
    }
    const sorted = structuredClone(expected.sortInput);
    sortLineHits(sorted);
    try { assert.deepEqual(sorted, expected.sortOutput); } catch { reasons.push('isolated sort'); }
    if (reasons.length) mismatches.push({ index, reasons });
    return { input, actual, expected, reasons };
  });
  const summary = { cases: cases.length, casesSha256, binaryHashes: native.hashes,
    scope: 'MultiLineCheck shortening/recovery/collection/sorting; controlled primitive queries and actor-hit order',
    comparison: 'exact output hit order/fields, actor-hit mutations, query arguments and isolated CRT sort results',
    returnedHits: native.results.reduce((n, r) => n + r.hits.length, 0), mismatches };
  await writeFile(path.join(directory, 'comparison.json'), JSON.stringify({ summary, comparisons }, encode, 2));
  console.log(JSON.stringify({ ...summary, mismatches: mismatches.slice(0, 12), mismatchCount: mismatches.length }, null, 2));
  assert.equal(mismatches.length, 0, 'multi-line queries and sorting agree with original');
}
