/** SetupForSurf's bDynamicLightMover branch in the page's lighting (src/unreal/lighting.mjs `relightMover`,
 * docs/static-lighting.md "bDynamicLightMover"), on 00_TrainingCombat's pistol-range target: BreakableGlass0, whose translucent
 * Uob_Target_F polygon is the paper, and the holder DeusExMover4 it is attached to. Both set bDynamicLightMover and both brushes
 * were built inside solid space (y -3280, leaf -1), so their own light maps list no lights.
 *
 *   1. At the authored Location (leaf -1, 0x10b06f0b) every texel of every polygon is the zone ambient: no light at all.
 *   2. Slid in by KeyPos[1] (the station's switch, Event guntarget1: y -1216), the leaf is PointRegion's at that Location
 *      and each light map lists exactly the lights of Leaves[leaf].iPermeating that lie in front of its facet
 *      ((L - O)·Z > 0, recomputed here in doubles from the facet) and share the mover's bSpecialLit, without shadow masks;
 *      the paper is lit.
 *   3. The cache header (0x10b07e39..0x10b07ebe): the same leaf, Location and Rotation build nothing again; a moved Location does.
 *
 *   node scripts/validate-dynamic-light-mover.mjs
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
import { pointRegion } from '../src/runtime/zone.mjs';
import { loadScriptVmKernel } from '../src/runtime/script-vm-kernel.mjs';
import { gameDirectory } from './game-directory.mjs';
const NAME = 'validate-dynamic-light-mover';
let root; try { root = gameDirectory(); } catch { console.log(`SKIP ${NAME}: no installed game data`); process.exit(0); }
const files = [];
for (const directory of ['Maps', 'System']) for (const name of await readdir(path.join(root, directory)))
  files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files), kernel = await loadScriptVmKernel();
const asset = await assets.get('00_TrainingCombat'), map = decodeMap(asset.bytes), defaults = new ClassDefaults(assets);
const lighting = await createLighting(map, asset, assets, { kernel });
await lighting.prepare(map.model);
const failures = [], fail = message => { if (failures.push(message) <= 10) console.log(message); };
const transforms = matrix => { const normal = new THREE.Matrix3().getNormalMatrix(matrix);
  return { transform: p => fromView(new THREE.Vector3(...toView(p)).applyMatrix4(matrix).toArray()),
    transformNormal: n => fromView(new THREE.Vector3(...toView(n)).applyMatrix3(normal).toArray()) }; };
const leafOf = location => pointRegion(map.model, location, {}, []).leaf;
const permeating = leaf => { const refs = [], start = leaf >= 0 ? map.model.leaves[leaf].permeating : -1;
  for (let i = start; i >= 0 && map.model.lights[i]; i++) refs.push(map.model.lights[i]); return refs; };
const lightValues = new Map(await Promise.all([...new Set(map.model.lights.filter(Boolean))].map(async ref =>
  [ref, await defaults.forActor(asset, map.actors.find(a => a.index === ref))])));

const summary = [];
for (const name of ['BreakableGlass0', 'DeusExMover4']) {
  const actor = map.actors.find(a => a.name === name), values = await defaults.forActor(asset, actor);
  if (!values.bDynamicLightMover) { fail(`${name}: bDynamicLightMover is not set`); continue; }
  const raw = readModel(asset.pkg, asset.bytes, actor.values.Brush);
  const { model, triangles } = moverModelFromPolys(raw, readPolys(asset.pkg, asset.bytes, raw.polygons), { specialLit: Boolean(values.bSpecialLit) });
  const authored = brushMatrix(actor.values), { transform, transformNormal } = transforms(authored);
  lighting.dynamicLightMover(name, { specialLit: values.bSpecialLit });
  const zone = pointZone(map.model, transform(model.bounds.min.map((n, i) => (n + model.bounds.max[i]) / 2)));
  const records = [...new Set(triangles.map(t => t.surface))].filter(s => !(model.surfaces[s].flags & (POLY.Invisible | POLY.Unlit)))
    .map(s => lighting.surface(model, s, zone, transform, transformNormal, name)).filter(Boolean);
  const rotation = actor.values.Rotation ?? [0, 0, 0];
  // As world.mjs relightMover: the light maps are built again only for a new cache header.
  const place = (location, matrix) => lighting.moverHeaderChanged(name, leafOf(location), location, rotation)
    ? lighting.relightMover(name, { leaf: leafOf(location), location, rotation, ...transforms(matrix) }) : [];
  // 1. The authored pose: leaf -1, no light.
  const authoredLeaf = leafOf(actor.values.Location);
  place(actor.values.Location, authored);
  const ambient = records.map(r => Math.max(...r.baseTexels));
  if (authoredLeaf !== -1) fail(`${name}: the authored Location's leaf is ${authoredLeaf}, not -1`);
  for (const r of records) if (r.lightEntries.length || r.baseTexels.some((v, i) => v !== r.baseTexels[i % 3]))
    fail(`${name} surface ${r.surfaceIndex}: ${r.lightEntries.length} lights at leaf -1`);
  // 2. Slid in by KeyPos[1].
  const key = actor.values['KeyPos[1]'] ?? [0, 0, 0], slid = actor.values.Location.map((v, i) => Math.fround(v + key[i]));
  // The group matrix moverGroupMatrix gives a translated mover: the authored one plus the offset, in three's axes.
  const moved = authored.clone(); toView(key).forEach((v, i) => { moved.elements[12 + i] += v; });
  const leaf = leafOf(slid), rebuilt = place(slid, moved);
  if (rebuilt.length !== records.length) fail(`${name}: ${rebuilt.length} of ${records.length} light maps built again at the slid Location`);
  const candidates = permeating(leaf);
  for (const r of records) {
    const origin = transforms(moved).transform(model.points[r.surface.base]), normal = transforms(moved).transformNormal(model.vectors[r.surface.normal]);
    const expected = candidates.filter(ref => { const v = lightValues.get(ref), l = v.Location ?? [0, 0, 0];
      return l.reduce((sum, c, i) => sum + (c - origin[i]) * normal[i], 0) > 0 && Boolean(v.bSpecialLit) === Boolean(values.bSpecialLit); });
    const got = r.lightEntries.map(e => e.ref);
    if (got.join() !== expected.join()) fail(`${name} surface ${r.surfaceIndex}: lights [${got}] at leaf ${leaf}, expected [${expected}]`);
    if (!r.dynamicLight) fail(`${name} surface ${r.surfaceIndex}: not marked as a bDynamicLightMover light map`);
    summary.push({ name, surface: r.surfaceIndex, texture: r.surface.texture, lights: got.length, max: Math.max(...r.baseTexels) });
  }
  const paper = name === 'BreakableGlass0' ? records.find(r => r.surface.flags & POLY.Translucent) : null;
  if (name === 'BreakableGlass0' && !(paper && Math.max(...paper.baseTexels) > Math.max(...ambient)))
    fail(`${name}: the paper's light map is not lit at leaf ${leaf}`);
  // 3. The cache header.
  if (place(slid, moved).length) fail(`${name}: the same leaf, Location and Rotation built the light maps again`);
  const nudged = slid.map((v, i) => i === 1 ? Math.fround(v - 1) : v), nudgedMatrix = moved.clone();
  toView([0, -1, 0]).forEach((v, i) => { nudgedMatrix.elements[12 + i] += v; });
  if (place(nudged, nudgedMatrix).length !== records.length) fail(`${name}: a moved Location did not build the light maps again`);
  console.log(`${name}: leaf ${authoredLeaf} -> ${leaf}, ${candidates.length} permeating lights; ${records.length} light maps`);
}
lighting.dispose();
for (const row of summary) console.log(`  ${row.name} surface ${row.surface}: ${row.lights} lights, brightest texel byte ${row.max}`);
if (failures.length) { console.log(`FAIL ${NAME}: ${failures.length} failures`); process.exit(1); }
console.log(`PASS ${NAME}: 00_TrainingCombat's BreakableGlass0 and DeusExMover4 take no light at leaf -1, their slid leaf's in-front lights unshadowed, and build again only on a new cache header`);
