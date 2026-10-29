/** Original UModel::PointCheck (Engine.dll 0x103f1570) with ZERO extent, on world and owned (mover) models: docs/point-check-zero-extent.md.
 *
 * The zero-extent branch (0x103f16c5) was recovered for the world model only (validate-native-points); an owned model (a mover brush, the owner's
 * ToWorld coordinates) threw "Owned zero-extent PointCheck is not yet verified" the moment a mover moved over a Tracer. This compares the translation with the
 * original on thousands of points: random points in and around every mover brush at its authored poses, points ON each transformed plane and one float32
 * step either side (where the x87 summation order and the rounding of the plane distance decide the branch), world-model points, and the leaf (Item) the walk ends in.
 * Cases are captured from the original BEFORE the comparison; --capture-only stops there, --reuse compares against the stored capture.
 *
 *   node scripts/validate-native-owned-point.mjs [--capture-only] [--reuse] [--map 01_NYC_UNATCOIsland] [--cases N]
 * Needs reports/movement/native-level/<map>/scene.json and reports/movement/native-bounds/cases.json (ignored; see docs/level-points.md). */
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {brushCollisionBounds} from '../src/runtime/brush-bounds.mjs';
import {brushToWorld} from '../src/runtime/coords.mjs';
import {modelPointCheck} from '../src/runtime/point-check.mjs';
import {gameDirectory} from './game-directory.mjs';
import {typedSceneModels} from './native-model.mjs';

const argv = process.argv.slice(2), captureOnly = argv.includes('--capture-only'), reuse = argv.includes('--reuse');
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const maps = option('map', null) ? [option('map')] : ['00_Training', '01_NYC_UNATCOIsland'];
const perActor = Number(option('cases', 8));
const f = Math.fround;
const view = new DataView(new ArrayBuffer(4));
const bits = v => { view.setFloat32(0, v, true); return view.getInt32(0, true); };
const fromBits = w => { view.setInt32(0, w, true); return view.getFloat32(0, true); };
/** The next float32 up or down: the neighbours of a point on a plane, where the branch is decided by the last bit. */
const step = (v, n) => { if (v === 0) return n > 0 ? fromBits(n) : -fromBits(-n); const w = bits(v); return fromBits(v > 0 ? w + n : w - n); };
/** xorshift32: the corpus is reproducible. */
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

const authoredBounds = JSON.parse(await readFile('reports/movement/native-bounds/cases.json'));
const summaries = [];
for (const name of maps) {
  const directory = path.resolve('reports/movement/native-owned-point', name); await mkdir(directory, {recursive: true});
  const sceneRaw = await readFile(`reports/movement/native-level/${name}/scene.json`), scene = JSON.parse(sceneRaw);
  typedSceneModels(scene);
  let cases;
  if (reuse) cases = JSON.parse(await readFile(path.join(directory, 'cases.json')));
  else {
    const random = rng(0x5eed + name.length), models = [];
    const pushCase = (actor, owner, position, note) => models.push({...(actor ? {actor: actor.id} : {}), ...(owner ? {owner} : {}), position: position.map(f), extent: [0, 0, 0], flags: 0, note});
    // The world model: points in the level's bounds and on a few of its planes.
    const worldNodes = scene.model.nodes.filter(n => n.plane && n.vertexCount > 0);
    for (let i = 0; i < perActor * 8 && worldNodes.length; i++) {
      const node = worldNodes[Math.floor(random() * worldNodes.length)], p = node.plane;
      // a point on the plane near the origin of the plane, then jittered along it
      const base = [p[0] * p[3], p[1] * p[3], p[2] * p[3]].map((v, k) => v + (random() - .5) * 400 * (k === 2 ? .5 : 1));
      pushCase(null, null, base, 'world-near-plane');
    }
    for (const actor of scene.actors) {
      if (!actor.model) continue;
      const poses = [{}];
      for (const fraction of [.5, 1]) {
        const captured = authoredBounds.find(c => c.name === `${name}/${actor.id}/${fraction}`);
        if (captured) poses.push({Location: captured.owner.Location, Rotation: captured.owner.Rotation ?? [0, 0, 0]});
      }
      // extra poses: a rotated and a shifted owner, so the axes are not the identity
      poses.push({Location: actor.values.Location.map((v, k) => v + [37.25, -91.5, 12.125][k]), Rotation: [0, 4096 + Math.floor(random() * 20000), 0]});
      poses.push({Location: actor.values.Location, Rotation: [Math.floor(random() * 6000), Math.floor(random() * 65536), Math.floor(random() * 3000)]});
      for (const owner of poses) {
        const values = {...actor.values, ...owner}, b = brushCollisionBounds(actor.model, values), ownerArg = Object.keys(owner).length ? owner : null;
        const coords = brushToWorld(values), rows = [coords.slice(3, 6), coords.slice(6, 9), coords.slice(9, 12)];
        for (let i = 0; i < perActor; i++) {
          const point = b.min.map((lo, k) => lo - 40 + random() * (b.max[k] - lo + 80));
          pushCase(actor, ownerArg, point, 'random');
        }
        // On the planes: transform a node plane as the original does and put the point on it (and one float32 step either side along the normal axis).
        const planes = actor.model.nodes.filter(n => n.plane && n.vertexCount > 0);
        for (let i = 0; i < perActor && planes.length; i++) {
          const p = planes[Math.floor(random() * planes.length)].plane;
          const n = rows.map(row => f(row[0] * p[0] + row[1] * p[1] + row[2] * p[2]));
          const w = f(p[3] - f(f(coords[0] * rows[0][0] + coords[1] * rows[0][1] + coords[2] * rows[0][2]) * n[0] + f(coords[0] * rows[1][0] + coords[1] * rows[1][1] + coords[2] * rows[1][2]) * n[1] + f(coords[0] * rows[2][0] + coords[1] * rows[2][1] + coords[2] * rows[2][2]) * n[2]));
          const inBox = b.min.map((lo, k) => lo + random() * (b.max[k] - lo));
          const d = inBox[0] * n[0] + inBox[1] * n[1] + inBox[2] * n[2] - w;
          const onPlane = inBox.map((v, k) => v - d * n[k]);
          pushCase(actor, ownerArg, onPlane, 'on-plane');
          const axis = n.reduce((best, v, k) => Math.abs(v) > Math.abs(n[best]) ? k : best, 0);
          for (const s of [-2, -1, 1, 2]) { const q = onPlane.map(f); q[axis] = step(q[axis], s); pushCase(actor, ownerArg, q, `on-plane${s}`); }
        }
      }
    }
    cases = {models, points: []};
    await writeFile(path.join(directory, 'cases.json'), JSON.stringify(cases));
  }
  await writeFile(path.join(directory, 'scene.json'), sceneRaw);
  let original;
  if (reuse) original = JSON.parse(await readFile(path.join(directory, 'original.json')));
  else {
    const result = spawnSync(process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python', ['scripts/native-level-points-oracle.py', gameDirectory(), path.join(directory, 'scene.json'), path.join(directory, 'cases.json')], {encoding: 'utf8', maxBuffer: 256 * 1024 * 1024});
    if (result.status !== 0) throw Error(result.stderr);
    await writeFile(path.join(directory, 'original.json'), result.stdout); original = JSON.parse(result.stdout);
  }
  assert.equal(original.sceneSha256, createHash('sha256').update(sceneRaw).digest('hex'));
  assert.equal(original.casesSha256, createHash('sha256').update(await readFile(path.join(directory, 'cases.json'))).digest('hex'));
  if (captureOnly) { console.log(name, cases.models.length, 'models captured'); continue; }
  const actors = scene.actors, mismatches = [], errors = [];
  const pack = (h, actor) => ({outside: h.outside, location: h.location, normal: h.normal, time: h.time, actor: actor?.id ?? null, item: h.item ?? -1, primitive: actor?.id ?? '$world'});
  let outsideCount = 0;
  cases.models.forEach((c, i) => {
    const actor = actors.find(a => a.id === c.actor), model = actor?.model ?? scene.model;
    try {
      const actual = pack(modelPointCheck(model, c.position, c.extent, actor ? brushToWorld({...actor.values, ...c.owner}) : null, c.flags), actor);
      assert.deepEqual(actual, original.models[i]);
      if (actual.outside) outsideCount++;
    } catch (error) { (error.name === 'AssertionError' ? mismatches : errors).push({index: i, input: c, actual: error.actual, expected: error.expected ?? original.models[i], error: error.name === 'AssertionError' ? undefined : error.message}); }
  });
  summaries.push({name, models: cases.models.length, clear: outsideCount, hits: cases.models.length - outsideCount - mismatches.length - errors.length, mismatches: mismatches.length, errors: errors.length});
  console.log(JSON.stringify({...summaries.at(-1), first: [...mismatches, ...errors].slice(0, 3)}));
  await writeFile(path.join(directory, 'comparison.json'), JSON.stringify(summaries.at(-1)));
}
if (!captureOnly) { assert.equal(summaries.reduce((n, s) => n + s.mismatches + s.errors, 0), 0); console.log('PASS validate-native-owned-point'); }
