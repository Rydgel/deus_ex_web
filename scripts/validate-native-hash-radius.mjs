/** ActorRadiusCheck (Engine.dll 0x103589e0) against src/runtime/collision-hash-radius.mjs.
 *
 * scripts/native-hash-radius-oracle.py runs the unchanged body on a hash filled by the original AddActor
 * (native-hash-oracle.py's fixture). Per query the cell box the body computed and the hit list, in list order, must
 * equal the translation's, on the original's permutation tables (full native bucket semantics) and, where every cell lies in
 * 0..255, on the seed-independent domain. docs/screen-flash.md "Iterator 312". */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCollisionHash, collisionHashTables } from '../src/runtime/collision-hash.mjs';
import { actorRadiusCheck, radiusCells } from '../src/runtime/collision-hash-radius.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory();
const output = resolve('reports/movement/native-hash-radius');
const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
let state = 12345;
const random = () => { state = (Math.imul(state, 1103515245) + 12345) >>> 0; return state / 0x100000000; };
const between = (a, b) => a + (b - a) * random();
const f32 = Math.fround;

const actors = [];
for (let i = 0; i < 90; i++) {
  const location = [f32(between(-3000, 3000)), f32(between(-3000, 3000)), f32(between(-1000, 1000))];
  const half = i % 9 === 0 ? between(600, 2500) : between(8, 80);
  actors.push({ id: `a${i}`, location, bounds: { min: location.map(v => f32(v - half)), max: location.map(v => f32(v + half)) } });
}
// Exact-distance ties: 100 units from the origin on each axis, and a pair at the same cell corner.
actors.push({ id: 'tie-x', location: [100, 0, 0], bounds: { min: [92, -8, -8], max: [108, 8, 8] } });
actors.push({ id: 'tie-y', location: [0, -100, 0], bounds: { min: [-8, -108, -8], max: [8, -92, 8] } });
actors.push({ id: 'origin', location: [0, 0, 0], bounds: { min: [-16, -16, -16], max: [16, 16, 16] } });
const queries = [
  ...[0, 1, 24.5, 64, 99.99, 100, 100.00001, 300, 1000, 1400, -50].map(radius => ({ location: [0, 0, 0], radius })),
  ...Array.from({ length: 40 }, () => ({ location: [f32(between(-3500, 3500)), f32(between(-3500, 3500)), f32(between(-1500, 1500))], radius: f32(between(10, 1500)) })),
  { location: [32767.5, -32768, 0.001], radius: 256 }, { location: [-1e6, 1e6, 0], radius: 500 }, { location: [128.001953125, 128.001953125, 128.001953125], radius: 1e-12 },
  { location: [32640, 32640, 32640], radius: 128 }, { location: [-32768, -32768, -32768], radius: 0.5 },
];
const cases = [1, 123].map(seed => ({ seed, actors, queries }));
await mkdir(output, { recursive: true });
await writeFile(resolve(output, 'cases.json'), JSON.stringify(cases));
const native = spawnSync(python, [resolve('scripts/native-hash-radius-oracle.py'), root, resolve(output, 'cases.json')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (native.status !== 0) throw new Error(native.stderr || native.error?.message || `Native driver exit ${native.status}`);
const reference = JSON.parse(native.stdout);

let compared = 0, hitsTotal = 0, independent = 0, nonEmpty = 0;
for (let i = 0; i < cases.length; i++) {
  const { seed } = cases[i], expected = reference.results[i];
  for (const mode of ['exact', 'independent']) {
    const hash = createCollisionHash(mode === 'exact' ? { tables: collisionHashTables(seed) } : {});
    try { for (const a of actors) hash.addActor(a, a.bounds, { location: a.location }); } catch (error) { assert.equal(mode, 'independent'); assert.match(error.message, /seed-independent/); continue; }
    queries.forEach((query, j) => {
      const original = expected.queries[j];
      const cells = radiusCells(query.location, query.radius);
      assert.deepEqual(cells, original.cells, `case ${i} query ${j} cells ${JSON.stringify(query)}`);
      let hits;
      try { hits = actorRadiusCheck(hash, query, a => a.location).map(a => a.id); } catch (error) { assert.equal(mode, 'independent'); return; }
      assert.deepEqual(hits, original.hits, `case ${i} ${mode} query ${j} hits ${JSON.stringify(query)}`);
      compared++; hitsTotal += hits.length; if (hits.length) nonEmpty++; if (mode === 'independent') independent++;
    });
  }
}
// The strict comparison: an actor exactly 100 units away is outside a radius of 100 and inside 100.00001.
assert.ok(!reference.results[0].queries[5].hits.includes('tie-x') && reference.results[0].queries[6].hits.includes('tie-x'));
assert.ok(compared >= 100 && nonEmpty >= 40 && hitsTotal >= 300, `${compared} queries, ${nonEmpty} with hits, ${hitsTotal} hits`);
console.log(`PASS validate-native-hash-radius: ${compared} radius queries (${independent} on the seed-independent domain) equal to Engine.dll 0x103589e0: cell box and hit list order; ${hitsTotal} hits`);
