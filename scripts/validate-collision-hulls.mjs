/** The typed collision hulls (src/runtime/collision-hulls.mjs, docs/live-heap.md "Step 9's results") against the object hulls they replaced
 * (test/helpers/collision-reference.mjs, the BspCollider of master 243f2b2b), on the level model of each map named and a few of its
 * mover brushes: every hull (node, bound, min, max, planes, sweep planes, as raw doubles), the transformed partition planes, the box
 * tree's candidates for random boxes, the leaf order of the line-candidate walk, and the sweeps and overlaps that come of them. Both
 * colliders run the legacy hull path (the model's `rootOutside` left out), the one that reads them; with a compiled root, as in every
 * map, the original model queries answer and no hull is built.
 *
 *   node scripts/validate-collision-hulls.mjs [--maps 01_NYC_UNATCOIsland,00_Training,03_NYC_747,...] [--queries 200] */
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parsePackage } from '../src/unreal/package.mjs';
import { readModel } from '../src/unreal/model.mjs';
import { modelObjects } from '../src/unreal/bsp-model.mjs';
import { BspCollider } from '../src/runtime/collision.mjs';
import { BspCollider as ReferenceCollider } from '../test/helpers/collision-reference.mjs';
import { gameDirectory } from './game-directory.mjs';

let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-collision-hulls: no installed game data'); process.exit(0); }
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const queries = Number(option('queries', '200'));
const all = (await readdir(`${root}/Maps`)).filter(name => /\.(dx|unr)$/i.test(name)).map(name => name.replace(/\.[^.]+$/, ''));
const maps = option('maps', '01_NYC_UNATCOIsland,00_Training,03_NYC_747,06_HongKong_WanChai_Market,15_Area51_Bunker,10_Paris_Chateau,09_NYC_Ship,02_NYC_Smug').split(',').filter(name => name === 'all' || all.includes(name));
const names = maps.includes('all') ? all : maps;

let failures = 0;
const fail = (label, detail) => { if (failures++ < 25) console.error(`FAIL ${label}: ${detail}`); };
const stats = { maps: 0, models: 0, hulls: 0, planes: 0, partitionPlanes: 0, candidateQueries: 0, lineQueries: 0, walkedLeaves: 0, sweeps: 0, hits: 0, overlapQueries: 0, errors: 0 };
const sameNumbers = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const same = (a, b, label, what) => { if (!sameNumbers(a, b)) fail(label, `${what}: ${a} against ${b}`); };

// A deterministic generator so a failure replays.
function rng(seed) { return () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296; }

// Pure functions given to both implementations: a rotation about Z, a scale and a shift, as a brush's transform is.
const angle = 0.6, c = Math.cos(angle), s = Math.sin(angle);
const transformPoint = p => [c * p[0] * 1.5 - s * p[1] + 100, s * p[0] * 1.5 + c * p[1] - 40, p[2] * 0.75 + 7];
const transformNormal = n => [c * n[0] - s * n[1], s * n[0] + c * n[1], n[2] / 0.75];

for (const name of names) {
  const file = [`${root}/Maps/${name}.dx`, `${root}/Maps/${name}.unr`].find(existsSync), bytes = await readFile(file), pkg = parsePackage(bytes);
  stats.maps++;
  const models = pkg.exports.map((e, i) => e.className === 'Model' ? i + 1 : 0).filter(Boolean);
  // The level's model (the Level's own) first, then up to six of the brushes with hulls.
  const picked = [];
  for (const index of models) {
    let model;
    try { model = readModel(pkg, bytes, index); } catch { continue; }
    if (!model.nodes.length) continue;
    let withHull = false;
    for (let i = 0; i < model.nodes.length && !withHull; i++) withHull = model.nodes.collisionBound(i) !== -1;
    if (!withHull) continue;
    picked.push({ index, model });
    if (picked.length >= 1 + (maps.length > 3 ? 4 : 6)) break;
  }
  for (const { index, model } of picked) {
    stats.models++;
    const label = `${name} model ${index}`;
    const objects = modelObjects(model);
    for (const [brush, rooted] of [[false, false], [true, false], [true, true]]) {
      const tp = brush ? transformPoint : undefined, tn = brush ? transformNormal : undefined, tag = `${label}${brush ? ' (brush)' : ''}`;
      // Rooted: the model keeps its root, so a brush collider with no owner walks the BSP for its leaves (lineCandidates).
      const legacy = { ...objects, rootOutside: rooted ? objects.rootOutside : undefined }, typed = { ...model, rootOutside: rooted ? model.rootOutside : undefined };
      let reference, referenceError = null, collider, error = null;
      try { reference = new ReferenceCollider(legacy, tp, tn, brush && !rooted ? { Location: [0, 0, 0] } : null); } catch (e) { referenceError = e; }
      collider = new BspCollider(typed, tp, tn, brush && !rooted ? { Location: [0, 0, 0] } : null);
      let hulls = null;
      try { hulls = collider.hulls; } catch (e) { error = e; }
      if (referenceError || error) {
        stats.errors++;
        if (!referenceError || !error || referenceError.message !== error.message) fail(tag, `${referenceError?.message} against ${error?.message}`);
        continue;
      }
      stats.hulls += hulls.length;
      if (reference.hulls.length !== hulls.length || collider.hullCount !== hulls.length) { fail(tag, `hull count ${reference.hulls.length} against ${hulls.length} (${collider.hullCount})`); continue; }
      for (let i = 0; i < hulls.length; i++) {
        const a = reference.hulls[i], b = hulls.at(i);
        if (a.node !== b.node) fail(tag, `hull ${i} node ${a.node} against ${b.node}`);
        same(a.min, b.min, tag, `hull ${i} min`); same(a.max, b.max, tag, `hull ${i} max`);
        for (const key of ['planes', 'sweepPlanes']) {
          if (a[key].length !== b[key].length) { fail(tag, `hull ${i} ${key}: ${a[key].length} against ${b[key].length}`); continue; }
          stats.planes += a[key].length;
          a[key].forEach((p, k) => same(p, b[key][k], tag, `hull ${i} ${key}[${k}]`));
        }
        if (hulls.indexOfBound(a.node !== undefined ? objects.nodes[a.node].collisionBound : -2) !== i) fail(tag, `hull ${i} bound lookup`);
      }
      const { partition } = collider.prepare();
      for (let i = 0; i < reference.partitionPlanes.length; i++) {
        stats.partitionPlanes++;
        same(reference.partitionPlanes[i], Array.from(partition.subarray(4 * i, 4 * i + 4)), tag, `partition plane ${i}`);
      }
      // Random queries inside the model's box (and some aimed at hulls), the same for both.
      const random = rng(0x9e3779b1 ^ index), lo = reference.tree ? reference.tree.min : [-1000, -1000, -1000], hi = reference.tree ? reference.tree.max : [1000, 1000, 1000];
      const point = () => lo.map((v, i) => v + random() * (hi[i] - v));
      const pick = () => { const h = reference.hulls[Math.floor(random() * reference.hulls.length)]; return h.min.map((v, i) => v + random() * (h.max[i] - v)); };
      for (let q = 0; q < queries; q++) {
        const start = q % 2 ? pick() : point(), end = q % 3 ? pick() : point(), delta = end.map((v, i) => v - start[i]);
        const extent = [[0, 0, 0], [2, 2, 2], [20, 20, 43], [16, 16, 16]][q % 4];
        if (rooted) {
          // The BSP walk's leaf order, and the zero-extent sweep it feeds (the only query that reaches it).
          stats.lineQueries++;
          const walked = Array.from(reference.lineCandidates(start, delta, extent), h => h.node), got = Array.from(collider.lineCandidates(start, delta, extent), h => hulls.node[h]);
          stats.walkedLeaves += walked.length;
          if (walked.join() !== got.join()) fail(tag, `line candidates ${walked.length} against ${got.length}`);
          const zero = [0, 0, 0];
          let hit, hitError = null, found, foundError = null;
          try { hit = reference.sweep(start, delta, zero); } catch (e) { hitError = e; }
          try { found = collider.sweep(start, delta, zero); } catch (e) { foundError = e; }
          if (hitError || foundError) { if (hitError?.message !== foundError?.message) fail(tag, `rooted sweep error ${hitError?.message} against ${foundError?.message}`); continue; }
          if ((hit === null) !== (found === null)) fail(tag, 'rooted sweep hit against miss');
          else if (hit && (!Object.is(hit.time, found.time) || hit.node !== found.node)) fail(tag, `rooted sweep time ${hit.time} against ${found.time}`);
          continue;
        }
        stats.candidateQueries++;
        const expected = reference.candidates(start, delta, extent).map(h => h.node), actual = collider.candidates(start, delta, extent).map(h => hulls.node[h]);
        if (expected.join() !== actual.join()) fail(tag, `candidates ${expected.length} against ${actual.length}`);
        stats.overlapQueries++;
        const position = start.map(v => v), overlapExpected = reference.overlaps(position, extent), overlapActual = collider.overlaps(position, extent);
        if (overlapExpected !== overlapActual) fail(tag, `overlaps ${overlapExpected} against ${overlapActual}`);
        // The sweeps need a model with nodes the line walk can use; a hull-only walk is the rootOutside-less candidates one.
        stats.sweeps++;
        let hit, hitError = null, got, gotError = null;
        try { hit = reference.sweep(start, delta, extent); } catch (e) { hitError = e; }
        try { got = collider.sweep(start, delta, extent); } catch (e) { gotError = e; }
        if (hitError || gotError) { if (hitError?.message !== gotError?.message) fail(tag, `sweep error ${hitError?.message} against ${gotError?.message}`); continue; }
        if ((hit === null) !== (got === null)) { fail(tag, `sweep ${hit && 'hit'} against ${got && 'hit'} from ${start} by ${delta} extent ${extent}`); continue; }
        if (hit) {
          stats.hits++;
          if (!Object.is(hit.time, got.time) || hit.node !== got.node || hit.penetrating !== got.penetrating) fail(tag, `sweep time ${hit.time} against ${got.time}`);
          same(hit.normal, got.normal, tag, 'sweep normal');
        }
      }
    }
  }
}
console.log(JSON.stringify(stats));
if (failures) { console.error(`${failures} differences`); process.exit(1); }
console.log('validate-collision-hulls: the typed hulls hold every double of the object hulls');
