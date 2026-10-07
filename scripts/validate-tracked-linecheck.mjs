/** SetupForActor's visibility LineCheck over the level model the moving
 * brush tracker left (docs/mesh-lighting.md "LineCheck and the brush
 * tracker"): Play's ray.mjs traceRayFast over bsp-occlusion.mjs lineModel()
 * (the Rust tracker's model memory) against Engine's unchanged
 * UModel::LineCheck under Unicorn (scripts/native-tracked-linecheck-oracle.py)
 * on the same level model and movers, after GNewBrushTracker. The checks are
 * the mesh-light line checks of the two visual-acceptance cases (Helibase's
 * BlackHelicopter0 and the 747's RepairBot0, each to every light of its
 * leaf's permeating list) and segments through every mover of those maps.
 * Each must agree; and the static model must answer differently for some
 * of them (the tracker's fragments block what the static BSP lets through).
 *
 *   node scripts/validate-tracked-linecheck.mjs */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { ClassDefaults } from '../src/unreal/classes.mjs';
import { loadScriptVmKernel } from '../src/runtime/script-vm-kernel.mjs';
import { createBspOcclusion } from '../src/runtime/bsp-occlusion.mjs';
import { traceRayFast } from '../src/runtime/ray.mjs';
import { pointRegion } from '../src/runtime/zone.mjs';
import { buildMap, bits } from './brush-tracker-request.mjs';

const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
if (!existsSync(python)) { console.log('SKIP validate-tracked-linecheck: no native probe environment'); process.exit(0); }
const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files), defaults = new ClassDefaults(assets);
const kernel = (await loadScriptVmKernel()).occlusion;
const f = Math.fround;
let seed = 0x7ac4ed;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };

const CASES = [{ map: '06_HongKong_Helibase', actor: 'BlackHelicopter0' }, { map: '03_NYC_747', actor: 'RepairBot0' }];
const report = [];
for (const { map: mapName, actor: actorName } of CASES) {
  const built = await buildMap(assets, mapName), model = built.map.model, asset = await assets.get(mapName);
  // The actor's leaf (the map's point region: the static BSP's leaf at its
  // Location) and that leaf's permeating lights.
  const actors = built.map.actors, byName = new Map(actors.map(a => [a.name, a]));
  void defaults;
  const sink = byName.get(actorName), location = sink.values.Location.map(f);
  // (Its region is set at start-up, before GNewBrushTracker: the static BSP.)
  const leaf = model.leaves[pointRegion(model, location, {}, []).leaf], lights = [];
  if (leaf && leaf.permeating >= 0)
    for (let i = leaf.permeating; i < model.lights.length && model.lights[i]; i++) {
      const light = actors.find(a => a.index === model.lights[i]);
      if (light) lights.push({ name: light.name, location: (await defaults.forActor(asset, light)).Location.map(f) });
    }
  const checks = lights.map(light => ({ label: `${actorName}->${light.name}`, start: location, end: light.location }));
  // Segments through each mover: from 60-260 units on one side of its
  // location to the other side, random directions.
  for (const mover of built.actors) {
    const at = mover.locationBits.map(b => new Float32Array(new Uint32Array([b]).buffer)[0]);
    for (let k = 0; k < 6; k++) {
      const d = [random() - .5, random() - .5, random() - .5], n = Math.hypot(...d) || 1, a = 60 + 200 * random(), b = 60 + 200 * random();
      checks.push({ label: `${mover.name} #${k}`, start: at.map((v, i) => f(v - d[i] / n * a)), end: at.map((v, i) => f(v + d[i] / n * b)) });
    }
  }
  // Play: the Rust tracker's model after construction (Update(NULL), PC64).
  const movers = built.actors.map((a, i) => ({ tag: 0x40000000 + i, flags: a.flags, locationBits: a.locationBits,
    rotation: a.rotation, prePivotBits: a.prePivotBits, mainScale: a.mainScale, postScale: a.postScale,
    specialLit: a.specialLit, polys: a.brush.polys.map(p => ({ ...p, textureKey: p.texture === null ? 0 : p.texture + 1 })) }));
  const occlusion = createBspOcclusion(kernel, model, { surfaceTextureFlags: [], tracker: { movers } });
  let play, regions = 0;
  try {
    assert.equal(occlusion.tracker.construct({ pc64: true }), 0, 'tracker construction');
    const tracked = occlusion.lineModel();
    play = checks.map(c => ({ static: traceRayFast(model, c.start, c.end) === null ? 1 : 0,
      tracked: traceRayFast(tracked, c.start, c.end) === null ? 1 : 0 }));
    // UModel::PointRegion over the tracked model gives the static model's
    // region: AddNode (0x1037bb00) gives a fragment both sides' iZone and
    // iLeaf from its parent's side, and coplanar fragments hang off iPlane,
    // which PointRegion does not follow. Points around every mover.
    for (const c of checks) for (let k = 0; k <= 4; k++) {
      const point = c.start.map((v, i) => f(v + (c.end[i] - v) * k / 4));
      const a = pointRegion(model, point, {}, []), b = pointRegion(tracked, point, {}, []);
      assert.deepEqual([b.leaf, b.zoneNumber], [a.leaf, a.zoneNumber], `${mapName} ${c.label}: PointRegion at step ${k}`);
      regions++;
    }
  } finally { occlusion.dispose(); }
  const request = { gameRoot: root, model: built.model, actors: built.actors, fillers: [], rootOutside: model.rootOutside ? 1 : 0,
    checks: checks.map(c => ({ start: c.start.map(bits), end: c.end.map(bits) })) };
  const original = JSON.parse(execFileSync(python, ['scripts/native-tracked-linecheck-oracle.py'],
    { input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 1 << 28 }));
  let differ = 0;
  checks.forEach((c, i) => {
    assert.equal(play[i].static, original.static[i], `${mapName} ${c.label}: static LineCheck`);
    assert.equal(play[i].tracked, original.tracked[i], `${mapName} ${c.label}: tracked LineCheck`);
    if (play[i].static !== play[i].tracked) differ++;
  });
  const lightRows = lights.map((light, i) => `${light.name}:${play[i].static}${play[i].tracked}`);
  report.push({ map: mapName, actor: actorName, checks: checks.length, trackerChanged: differ, regions, lights: lightRows });
}
console.log(JSON.stringify(report));
assert.ok(report.every(r => r.trackerChanged > 0), 'the tracker\'s fragments change some line checks on each map');
console.log('validate-tracked-linecheck: PASS');
