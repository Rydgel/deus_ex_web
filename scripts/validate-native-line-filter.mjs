import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';

const f = Math.fround, cases = [], captureOnly = process.argv.includes('--capture-only');
const kinds = ['LevelInfo', 'Pawn', 'Mover', 'ZoneInfo', 'Actor'];
const hit = (actor, i = 0, time = .25) => ({ actor, location: [f(i + .1), -23.75, 123], normal: [0, 1, 0],
  primitive: 0x11000000 + i, time: f(time), item: i - 17 });
const add = (actors, hits, flags, source = null, extra = 0) => cases.push({ actors, hits, flags, source,
  start: [10.125, -20.5, .001].map(f), end: [-100.75, 29.25, -.003].map(f),
  extent: cases.length % 2 ? [20, 20, 43] : [0, 0, 0], extra,
  initial: { next: 'sentinel', actor: 'sentinel', location: [101.5, -202.25, 303.125],
    normal: [.25, -.5, .75], primitive: 0x12345678, time: .875, item: -999 } });
for (let flags = 0; flags < 64; flags++) {
  for (const kind of kinds) for (const collisionBits of [0, 4, 8, 12, 16, 28]) {
    add([{ id: 'a', kind, collisionBits, depth: cases.length % 4 }], [hit('a')], flags, null, cases.length % 257);
  }
  // All branches also see an empty list, independent of whether query flags
  // would normally produce any candidates at this controlled boundary.
  add([], [], flags);
  const actors = [{ id: 'source', kind: 'Pawn', owner: 'owner' },
    { id: 'owner', kind: 'Mover', owner: 'ancestor' }, { id: 'ancestor', kind: 'Actor', collisionBits: 28 },
    { id: 'child', kind: 'Actor', owner: 'source', collisionBits: 28 },
    { id: 'sibling', kind: 'Pawn', owner: 'owner' }];
  for (const order of [['source', 'owner', 'ancestor', 'child', 'sibling'],
    ['ancestor', 'owner', 'source'], ['child', 'source', 'sibling'], ['sibling', 'child']]) {
    add(actors, order.map((id, i) => hit(id, i)), flags, 'source');
  }
  for (let rotation = 0; rotation < kinds.length; rotation++) {
    const ordered = kinds.map((_, i) => kinds[(rotation + i) % kinds.length]);
    add(ordered.map((kind, i) => ({ id: `a${i}`, kind, depth: 2, collisionBits: 28 })),
      ordered.map((_, i) => hit(`a${i}`, i, rotation % 2 ? .5 : 1 - i * .125)), flags);
  }
}
// High bits must not accidentally broaden the low-byte native checks.
for (const flags of [0x100, 0x106, 0x80000000, 0xffffffff]) {
  add(kinds.map((kind, i) => ({ id: `a${i}`, kind, depth: 1, collisionBits: 12 })),
    kinds.map((_, i) => hit(`a${i}`, i)), flags, null, 0x12345678);
}
const directory = path.resolve('reports/movement/native-line-filter');
await mkdir(directory, { recursive: true });
const casesFile = path.join(directory, 'cases.json');
const serializedCases = JSON.stringify(cases);
const casesSha256 = createHash('sha256').update(serializedCases).digest('hex');
let stdout;
if (process.argv.includes('--compare-captured')) stdout = await readFile(path.join(directory, 'original.json'), 'utf8');
else {
  await writeFile(casesFile, serializedCases);
  ({ stdout } = await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON ?? 'python3',
    [fileURLToPath(new URL('./native-line-filter-oracle.py', import.meta.url)), gameDirectory(), casesFile],
    { maxBuffer: 32 * 1024 * 1024, timeout: 120_000 }));
  await writeFile(path.join(directory, 'original.json'), stdout);
}
const native = JSON.parse(stdout);
assert.equal(native.casesSha256, casesSha256, 'original reference belongs to these exact inputs');
assert.equal(native.results.length, cases.length);
if (captureOnly) {
  console.log(JSON.stringify({ cases: cases.length, accepted: native.results.filter(r => !r.outside).length,
    scope: 'original SingleLineCheck with controlled ordered MultiLineCheck lists' }, null, 2));
} else {
  const { singleLineCheck } = await import('../src/runtime/line-filter.mjs');
  const mismatches = [], comparisons = cases.map((input, index) => {
    const actors = new Map(input.actors.map(actor => [actor.id, { ...actor }]));
    for (const actor of actors.values()) actor.owner = actors.get(actor.owner) ?? null;
    const hits = input.hits.map((value, i) => ({ ...value, actor: actors.get(value.actor),
      next: i + 1 < input.hits.length ? i + 1 : null }));
    const events = [], result = structuredClone(input.initial), levelInfo = {};
    const outside = singleLineCheck({ levelInfo,
      isA(actor, kind) { return actor.kind === kind || actor.kind === 'LevelInfo' && kind === 'ZoneInfo'; },
      multiLineCheck(end, start, extent, checkActors, info, extra) {
        events.push({ end, start, extent, checkActors, world: info === levelInfo, extra }); return hits;
      },
    }, result, actors.get(input.source) ?? null, input.end, input.start, input.flags, input.extent, input.extra);
    const actual = { outside, hit: { ...result, actor: typeof result.actor === 'string' ? result.actor : result.actor?.id ?? null }, events };
    const expected = native.results[index];
    try { assert.deepEqual(actual, expected); } catch { mismatches.push(index); }
    return { input, actual, expected };
  });
  const summary = { cases: cases.length, binaryHashes: native.hashes, casesSha256,
    accepted: native.results.filter(r => !r.outside).length, mismatches,
    scope: 'SingleLineCheck filter/result-copy/query contract; controlled actor metadata and ordered MultiLineCheck results',
    comparison: 'exact result, all FCheckResult fields, and forwarded query arguments' };
  await writeFile(path.join(directory, 'comparison.json'), JSON.stringify({ summary, comparisons }, null, 2));
  console.log(JSON.stringify({ ...summary, mismatches: mismatches.slice(0, 10), mismatchCount: mismatches.length }, null, 2));
  assert.equal(mismatches.length, 0, 'line filtering agrees with original SingleLineCheck');
}
