/** URender::LeafLights, the moving lights OccludeBsp's Filter walk leaves on
 * each BSP leaf (docs/coronas.md "Leaf lights"), against the unchanged
 * Render.dll (scripts/native-dynamic-light-oracle.py `leafLists`):
 *   - SetupDynamics' light block 0x10b230e8-0x10b232f4 per light in
 *     Level.Actors order: the candidate gate (LightType, bStatic|bNoDelete
 *     unless bDynamicLight, LightBrightness, LightRadius) and the ViewPlanes
 *     sphere test with R = max(WorldLightRadius, 25 * (VolumeRadius + 1)),
 *     the planes being the master frame's (the Rust core's CreateMasterFrame
 *     and the render pass's ComputeRenderSize);
 *   - FDynamicLight::Filter 0x10b24a10 over the node lists from node 0, in
 *     list order, leaf lists built by prepending.
 * Every accepted light and every leaf's list, in order, must match
 * (dynamic-lighting.mjs movingLightInView and movingLightLeafLists).
 *
 *   node scripts/validate-leaf-lights.mjs */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { loadScriptVmKernel } from '../src/runtime/script-vm-kernel.mjs';
import { createBspOcclusion } from '../src/runtime/bsp-occlusion.mjs';
import { isMovingLightCandidate, movingLightInView, movingLightLeafLists, worldLightRadius } from '../src/runtime/dynamic-lighting.mjs';
import { surfaceTextureFlags, renderPassTangent, renderRectangle } from './occlusion-request.mjs';

const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
if (!existsSync(python)) { console.log('SKIP validate-leaf-lights: no native probe environment'); process.exit(0); }
const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files);
const kernel = (await loadScriptVmKernel()).occlusion;
const f = Math.fround, units = r => Math.round(r * 32768 / Math.PI);
const SIZES = [[1440, 960], [1920, 1080], [1024, 768]];
const FLAGS = [0, 0, 1, 4, 0x800, 0x801, 0x804, 5, 0x805];   // bStatic 1, bNoDelete 4, bDynamicLight 0x800

async function validate(mapName, count, seed) {
  const asset = await assets.get(mapName), model = decodeMap(asset.bytes).model;
  let state = seed >>> 0;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const int = n => Math.floor(random() * n), pick = list => list[int(list.length)];
  const occlusion = createBspOcclusion(kernel, model, { surfaceTextureFlags: await surfaceTextureFlags(assets, asset, model),
    zoneActors: model.zones.map(z => (z.actor > 0 ? z.actor : 0)) });
  const cases = [], inputs = [];
  const bounds = model.bounds;
  for (let c = 0; c < count; c++) {
    const location = [0, 1, 2].map(k => f(bounds.min[k] + random() * (bounds.max[k] - bounds.min[k])));
    const fov = random() < 0.5 ? 75 : 90, [vw, vh] = pick(SIZES), rect = renderRectangle(vw, vh, random, random() < 0.5 ? 1 : 0.5);
    renderPassTangent(fov, rect.width, 'validate-leaf-lights');
    const master = occlusion.master({ location, rotation: [int(14000) - 7000, int(65536), 0], width: vw, height: vh, fov,
      render: { width: rect.width, height: rect.height } });
    const raw = new Float32Array(Uint32Array.from(master.fields.slice(41, 57)).buffer);
    const planes = [0, 1, 2, 3].map(k => [...raw.subarray(4 * k, 4 * k + 4)]);
    const lights = Array.from({ length: 3 + int(12) }, () => {
      const spread = random() < 0.7 ? 1200 : 6000;
      return { location: [0, 1, 2].map(k => f(location[k] + (random() - 0.5) * spread)), type: random() < 0.1 ? 0 : 1 + int(4),
        brightness: random() < 0.1 ? 0 : 1 + int(255), radius: random() < 0.05 ? 0 : 1 + int(70), flags: pick(FLAGS),
        volumeRadius: random() < 0.3 ? int(60) : 0, volumeBrightness: int(256) };
    });
    // The original records each first-hit leaf in DynLightLeaves (0x10b59600,
    // room for about 1,080 before it runs into URender's other globals): keep
    // each case's light spheres reaching fewer.
    const gate = light => ({ LightType: light.type, bStatic: light.flags & 1, bNoDelete: light.flags & 4, bDynamicLight: light.flags & 0x800,
      LightBrightness: light.brightness, LightRadius: light.radius, VolumeRadius: light.volumeRadius });
    const reached = () => movingLightLeafLists(model, lights.filter(l => isMovingLightCandidate(gate(l)) && movingLightInView(l.location, gate(l), planes))
      .map(l => ({ location: l.location, radius: worldLightRadius({ LightRadius: l.radius }) }))).size;
    while (reached() > 900) for (const light of lights) light.radius = Math.max(1, light.radius >> 1);
    cases.push({ model: { nodes: model.nodes.map(n => [...n.plane, n.surface, n.back, n.front, n.coplanar, ...n.leaves]),
      surfaces: model.surfaces.map(s => [s.flags >>> 0, s.lightMap]), lightMaps: 0 }, planes, lights });
    inputs.push({ planes, lights });
  }
  occlusion.dispose();
  const reference = JSON.parse(execFileSync(python, ['scripts/native-dynamic-light-oracle.py', root],
    { input: JSON.stringify({ leafLists: cases }), encoding: 'utf8', maxBuffer: 1 << 30 })).leafLists;
  const stats = { lights: 0, accepted: 0, outOfView: 0, gated: 0, lists: 0, multi: 0, reversed: 0, entries: 0 };
  inputs.forEach(({ planes, lights }, c) => {
    const where = `${mapName} case ${c}`;
    const accepted = [];
    lights.forEach((light, i) => {
      stats.lights++;
      const values = { LightType: light.type, bStatic: light.flags & 1, bNoDelete: light.flags & 4, bDynamicLight: light.flags & 0x800,
        LightBrightness: light.brightness, LightRadius: light.radius, VolumeRadius: light.volumeRadius };
      if (!isMovingLightCandidate(values)) { stats.gated++; return; }
      if (!movingLightInView(light.location, values, planes)) { stats.outOfView++; return; }
      accepted.push(i);
    });
    assert.deepEqual(accepted, reference[c].accepted, `${where}: candidates (gate and ViewPlanes sphere test)`);
    stats.accepted += accepted.length;
    const lists = movingLightLeafLists(model, accepted.map(i => ({ location: lights[i].location,
      radius: worldLightRadius({ LightRadius: lights[i].radius }) })));
    const got = {}, want = {};
    for (const [leaf, list] of lists) got[leaf] = list.map(k => accepted[k]);
    reference[c].leaves.forEach((list, leaf) => { if (list.length) want[leaf] = list; });
    assert.deepEqual(got, want, `${where}: LeafLights`);
    for (const list of Object.values(want)) {
      stats.lists++; stats.entries += list.length;
      if (list.length > 1) { stats.multi++; if (list[0] > list.at(-1)) stats.reversed++; }
    }
  });
  console.log(`${mapName}: ${cases.length} cases, ${stats.lights} lights (${stats.gated} gated out, ${stats.outOfView} outside a ViewPlane, ` +
    `${stats.accepted} candidates), ${stats.lists} leaf lists with ${stats.entries} entries match; ${stats.multi} lists hold several lights ` +
    `(${stats.reversed} in reverse candidate order)`);
  return stats;
}

const totals = [];
totals.push(await validate('00_Training', 30, 5));
totals.push(await validate('01_NYC_UNATCOIsland', 30, 7));
totals.push(await validate('10_Paris_Club', 30, 11));
assert.ok(totals.every(t => t.outOfView > 0 && t.multi > 0 && t.reversed > 0 && t.reversed < t.multi), 'cases reach the plane test and both list orders');
console.log('validate-leaf-lights: ok');
