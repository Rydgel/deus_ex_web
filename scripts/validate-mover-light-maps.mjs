/** SetupForSurf's static cache header for movers without bDynamicLightMover (src/unreal/lighting.mjs relightMover and
 * relightPolygon, docs/static-lighting.md "Mover surfaces in SetupForSurf"), and the moving lights on a moved mover
 * (src/viewer/moving-lights.mjs), on two shipped movers: 00_TrainingCombat's DeusExMover26, a door that slides by
 * KeyPos[1] (0, -56, 0), and 09_NYC_ShipFan's DeusExMover1, a fan (RotationRate yaw -20000), turned here by 5000.
 *
 *   1. Built at the authored place, with its header, the same Location and Rotation build nothing again.
 *   2. At the new pose (brush matrix) every light map is built again from the brush's own light list with its shadow
 *      masks, and equals a cold build at that pose (a second lighting's `surface` with that transform) bit for bit; at
 *      least one differs from the authored build; back at the authored pose they equal it again.
 *   3. On the brush tracker's facets (tracker.rs Update at PC24, the facet DrawFrame takes: brush-tracker.mjs
 *      surfaceFacet): a light map built on a transform is built again on its facet even under the same header, then only
 *      on a new header; the facet lies on the transform's (origin within 0.01 units), with the same lights.
 *   4. Moving lights: a probe light beside a moved polygon composes on the polygon's current facet. Two worlds, one lit
 *      by the probe before the move and one only after it, must hold the texels of a world built cold at the new pose,
 *      bit for bit. Before 2026-10-28 the moving lights took a facet from the live group matrix once and added the
 *      mover's offset to it, so a light map first reached after a move was lit twice as far along, and a turned mover
 *      kept its authored orientation.
 *
 *   node scripts/validate-mover-light-maps.mjs
 */
import * as THREE from 'three';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { readModel } from '../src/unreal/model.mjs';
import { readPolys, moverModelFromPolys } from '../src/unreal/polys.mjs';
import { ClassDefaults } from '../src/unreal/classes.mjs';
import { createLighting, pointZone } from '../src/unreal/lighting.mjs';
import { POLY, toView, fromView } from '../src/unreal/geometry.mjs';
import { brushMatrix } from '../src/viewer/transforms.mjs';
import { createMovingLights } from '../src/viewer/moving-lights.mjs';
import { collectTrackerMovers, trackerMoverSpec, TRACKER } from '../src/runtime/brush-tracker.mjs';
import { createBspOcclusion } from '../src/runtime/bsp-occlusion.mjs';
import { loadScriptVmKernel } from '../src/runtime/script-vm-kernel.mjs';
import { gameDirectory } from './game-directory.mjs';
const NAME = 'validate-mover-light-maps';
let root; try { root = gameDirectory(); } catch { console.log(`SKIP ${NAME}: no installed game data`); process.exit(0); }
const files = [];
for (const directory of ['Maps', 'System']) for (const name of await readdir(path.join(root, directory)))
  files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files), kernel = await loadScriptVmKernel(), defaults = new ClassDefaults(assets);
const failures = [], fail = message => { if (failures.push(message) <= 12) console.log(message); };
const transforms = matrix => { const placed = matrix.clone(), normal = new THREE.Matrix3().getNormalMatrix(placed);
  return { transform: p => fromView(new THREE.Vector3(...toView(p)).applyMatrix4(placed).toArray()),
    transformNormal: n => fromView(new THREE.Vector3(...toView(n)).applyMatrix3(normal).toArray()) }; };
const same = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer), bits = v => (f32[0] = v, u32[0]);

const CASES = [
  { map: '00_TrainingCombat', mover: 'DeusExMover26',
    pose: actor => ({ location: actor.values.Location.map((v, i) => Math.fround(v + actor.values['KeyPos[1]'][i])),
      rotation: actor.values.Rotation ?? [0, 0, 0] }) },
  { map: '09_NYC_ShipFan', mover: 'DeusExMover1',
    pose: actor => ({ location: actor.values.Location, rotation: (actor.values.Rotation ?? [0, 0, 0]).map((v, i) => i === 1 ? v + 5000 : v) }) },
];
// A moving light the probe places 24 units in front of a lit polygon's facet (class 2: neither bStatic nor bNoDelete).
const probeValues = { LightType: 1, bStatic: false, bNoDelete: false, bDynamicLight: false, LightBrightness: 200, LightRadius: 12,
  LightEffect: 0, LightHue: 40, LightSaturation: 128, bSpecialLit: false };

for (const { map: mapName, mover: name, pose } of CASES) {
  const asset = await assets.get(mapName), map = decodeMap(asset.bytes);
  const actor = map.actors.find(a => a.name === name), values = await defaults.forActor(asset, actor);
  if (values.bDynamicLightMover) { fail(`${name}: sets bDynamicLightMover`); continue; }
  const raw = readModel(asset.pkg, asset.bytes, actor.values.Brush);
  const { model, triangles } = moverModelFromPolys(raw, readPolys(asset.pkg, asset.bytes, raw.polygons), { specialLit: Boolean(values.bSpecialLit) });
  const authoredMatrix = brushMatrix(actor.values), authored = { location: actor.values.Location, rotation: actor.values.Rotation ?? [0, 0, 0] };
  const target = pose(actor);
  // As mover-matrix.mjs: a turned mover takes brushMatrix of its live pose, a slid one the authored matrix plus the offset.
  const targetMatrix = target.rotation.some((v, i) => v !== authored.rotation[i]) ? brushMatrix({ ...actor.values, Location: target.location, Rotation: target.rotation })
    : (() => { const m = authoredMatrix.clone(); toView(target.location.map((v, i) => v - authored.location[i])).forEach((v, i) => { m.elements[12 + i] += v; }); return m; })();
  // As world.mjs: the zone of the authored brush centre, every lit polygon, the header of the authored place.
  const zone = pointZone(map.model, transforms(authoredMatrix).transform(model.bounds.min.map((n, i) => (n + model.bounds.max[i]) / 2)));
  const surfaces = [...new Set(triangles.map(t => t.surface))].filter(s => !(model.surfaces.at(s).flags & (POLY.Invisible | POLY.Unlit)));
  const world = async (matrix, header) => {
    const lighting = await createLighting(map, asset, assets, { kernel });
    await lighting.prepare(model);
    const { transform, transformNormal } = transforms(matrix);
    const records = surfaces.map(s => lighting.surface(model, s, zone, transform, transformNormal, name)).filter(Boolean);
    lighting.markMoverHeader(name, -1, header.location, header.rotation);
    const moving = createMovingLights(lighting, map.model, { mode: 'incremental' });
    lighting.setMovingApplier(moving.apply);
    return { lighting, records, moving };
  };
  const relight = (lighting, place, matrix) => lighting.moverHeaderChanged(name, -1, place.location, place.rotation)
    ? lighting.relightMover(name, { leaf: -1, ...place, ...transforms(matrix) }) : [];
  const texels = records => records.map(r => Array.from(r.baseTexels));

  // 1-2. The brush matrix path.
  const a = await world(authoredMatrix, authored), cold = await world(targetMatrix, target);
  const authoredTexels = texels(a.records), coldTexels = texels(cold.records);
  if (relight(a.lighting, authored, authoredMatrix).length) fail(`${name}: the authored header built light maps again`);
  const built = relight(a.lighting, target, targetMatrix);
  if (built.length !== a.records.length) fail(`${name}: ${built.length} of ${a.records.length} light maps built again at the new pose`);
  let differs = 0, listed = 0;
  a.records.forEach((r, k) => {
    if (r.dynamicLight) fail(`${name} surface ${r.surfaceIndex}: built as a bDynamicLightMover`);
    if (!same(r.lightEntries.map(e => e.ref), cold.records[k].lightEntries.map(e => e.ref))) fail(`${name} surface ${r.surfaceIndex}: not the brush's light list`);
    if (!same(Array.from(r.baseTexels), coldTexels[k])) fail(`${name} surface ${r.surfaceIndex}: the rebuilt light map is not the cold build at the new pose`);
    if (!same(coldTexels[k], authoredTexels[k])) differs++;
    listed += r.lightEntries.length;
  });
  if (!differs) fail(`${name}: no light map changed with the pose (the check proves nothing)`);
  if (relight(a.lighting, target, targetMatrix).length) fail(`${name}: an unchanged header built light maps again`);
  relight(a.lighting, authored, authoredMatrix);
  if (!same(texels(a.records).flat(), authoredTexels.flat())) fail(`${name}: back at the authored pose the light maps differ from the authored build`);

  // 3. The tracker's facets at the new pose.
  const [collected] = (await collectTrackerMovers(assets, asset, map)).filter(m => m.name === name);
  const spec = trackerMoverSpec(collected, 0, { hidden: false, location: authored.location, rotation: authored.rotation,
    prePivot: actor.values.PrePivot ?? [0, 0, 0] });
  const occlusion = createBspOcclusion(kernel.occlusion, map.model, { surfaceTextureFlags: [], tracker: { movers: [spec] } });
  const facets = new Map();
  try {
    const t = occlusion.tracker;
    if (t.construct({ pc64: true })) throw new Error('tracker construction failed');
    t.setMover(0, { locationBits: target.location.map(bits), rotation: target.rotation.map(n => n | 0) });
    if (t.update(0, { pc64: false })) throw new Error('tracker update failed');
    for (let s = t.header(TRACKER.SURFS_TOP); s < t.header(TRACKER.SURFS_NUM); s++) facets.set(t.surfOwner(s).ordinal, t.surfaceFacet(s));
  } finally { occlusion.dispose(); }
  const f = await world(authoredMatrix, authored);
  relight(f.lighting, target, targetMatrix);
  let facetBuilt = 0, maxOrigin = 0, texelDiff = 0;
  for (const r of f.records) {
    const facet = facets.get(r.surfaceIndex);
    if (!facet) { fail(`${name} surface ${r.surfaceIndex}: no tracker facet`); continue; }
    const before = f.lighting.geometryFor(r);
    facetBuilt += f.lighting.relightPolygon(name, r.surfaceIndex, { leaf: -1, ...target, facet }).length;
    const after = f.lighting.geometryFor(r);
    maxOrigin = Math.max(maxOrigin, Math.hypot(...after.facet.origin.map((v, i) => v - before.facet.origin[i])));
    if (f.lighting.relightPolygon(name, r.surfaceIndex, { leaf: -1, ...target, facet }).length) fail(`${name} surface ${r.surfaceIndex}: the same header and facet built again`);
    const k = f.records.indexOf(r);
    if (!same(r.lightEntries.map(e => e.ref), cold.records[k].lightEntries.map(e => e.ref))) fail(`${name} surface ${r.surfaceIndex}: the facet build lists other lights`);
    texelDiff += r.baseTexels.reduce((n, v, i) => n + (v !== coldTexels[k][i]), 0);
  }
  if (facetBuilt !== f.records.length) fail(`${name}: ${facetBuilt} of ${f.records.length} light maps built again on the tracker's facets`);
  if (!(maxOrigin < 0.01)) fail(`${name}: a tracker facet lies ${maxOrigin} units from the transform's`);
  const nudged = { ...target, location: target.location.map((v, i) => i === 2 ? Math.fround(v + 1) : v) };
  if (f.lighting.relightPolygon(name, f.records[0].surfaceIndex, { leaf: -1, ...nudged, facet: facets.get(f.records[0].surfaceIndex) }).length !== 1)
    fail(`${name}: a new Location did not build the facet's light map again`);

  // 4. Moving lights after the move: lit before and after it (the incremental path's placed light maps), lit only after
  // it, and a world built cold at the new pose, with a probe in front of the brightest-listed polygon at the new pose.
  const lit = cold.records.reduce((best, r) => (r.lightEntries.length > (best?.lightEntries.length ?? -1) ? r : best), null);
  const { facet: litFacet } = cold.lighting.geometryFor(lit);
  const probe = { name: 'ProbeLight', values: probeValues, flickerKey: 1, levelBrightness: cold.lighting.levelBrightness,
    location: litFacet.origin.map((v, i) => Math.fround(v + litFacet.normal[i] * 24 + litFacet.axisU[i] * 8)) };
  const both = await world(authoredMatrix, authored), after = await world(authoredMatrix, authored);
  both.moving.update([probe]);
  for (const w of [both, after]) { relight(w.lighting, target, targetMatrix); w.moving.update([probe]); }
  cold.moving.update([probe]);
  const reached = cold.records.filter(r => r.moving?.length).length;
  if (!reached) fail(`${name}: the probe light reaches no light map at the new pose`);
  for (const [label, w] of [['lit before and after the move', both], ['lit after the move', after]])
    w.records.forEach((r, k) => {
      if (!same(Array.from(r.pixels), Array.from(cold.records[k].pixels))) fail(`${name} surface ${r.surfaceIndex} (${label}): texels differ from the cold build at the new pose`);
    });
  for (const w of [a, cold, f, both, after]) w.lighting.dispose();
  console.log(`${mapName} ${name}: ${a.records.length} light maps (${listed} listed lights), ${differs} change with the pose; `
    + `tracker facets within ${maxOrigin.toExponential(2)} units, ${texelDiff} texel bytes differ from the matrix build; probe light reaches ${reached}`);
}
if (failures.length) { console.log(`FAIL ${NAME}: ${failures.length} failures`); process.exit(1); }
console.log(`PASS ${NAME}: a slid door and a turned fan rebuild their brush lists at their pose (= cold builds), on tracker facets when drawn, and moving lights compose on the moved facets`);
