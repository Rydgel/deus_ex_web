/** The light-map frustum sphere without kept texel points (docs/live-heap.md, step 1). Before, the lighting cache
 * (src/unreal/lighting.mjs `surface`) kept one [x, y, z] array per texel, transform(basis.point(x, y)), and world.mjs `inFrustum`
 * ran THREE.Sphere.setFromPoints over them in view space; now `texelSphere` computes the points as it goes. For every lit surface
 * of each --maps level (the world's own records, identity transform), and of the first under a mover-like matrix transform, the
 * sphere from that former body (the reference) and texelSphere's must be the same doubles: centre and radius.
 *
 *   node scripts/validate-texel-sphere.mjs [--maps 01_NYC_UNATCOIsland,00_Training]
 */
import * as THREE from 'three';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { createLighting } from '../src/unreal/lighting.mjs';
import { POLY, toView } from '../src/unreal/geometry.mjs';
import { texelSphere } from '../src/viewer/world.mjs';
import { loadScriptVmKernel } from '../src/runtime/script-vm-kernel.mjs';
import { gameDirectory } from './game-directory.mjs';
const NAME = 'validate-texel-sphere';
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const maps = option('maps', '01_NYC_UNATCOIsland,00_Training').split(',').filter(Boolean);
let root; try { root = gameDirectory(); } catch { console.log(`SKIP ${NAME}: no installed game data`); process.exit(0); }
const files = [];
for (const directory of ['Maps', 'System']) for (const name of await readdir(path.join(root, directory)))
  files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files), kernel = await loadScriptVmKernel();
const matrix = new THREE.Matrix4().compose(new THREE.Vector3(123.25, -77.5, 31), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -1.1, 0.7)), new THREE.Vector3(1, 1, 1));
const moved = p => new THREE.Vector3(...p).applyMatrix4(matrix).toArray();
let records = 0, texels = 0, differ = 0;
for (const [m, name] of maps.entries()) for (const transform of m === 0 ? [undefined, moved] : [undefined]) {
  const asset = await assets.get(name), map = decodeMap(asset.bytes), model = map.model;
  const lighting = await createLighting(map, asset, assets, { kernel });
  await lighting.prepare(model);
  const seen = new Set();
  for (const t of map.triangles) {
    const zone = model.nodes[t.node].zones[1], key = `${t.surface}:${zone}`, surface = model.surfaces[t.surface];
    if (seen.has(key) || surface.flags & (POLY.Invisible | POLY.FakeBackdrop | POLY.Unlit)) continue;
    seen.add(key);
    let record; try { record = lighting.surface(model, t.surface, zone, transform ?? undefined); } catch { continue; }
    if (!record) continue;
    const points = [];   // what lighting.surface kept before step 1
    for (let y = 0; y < record.height; y++) for (let x = 0; x < record.width; x++) points.push(record.transform(record.basis.point(x, y)));
    const before = new THREE.Sphere().setFromPoints(points.map(point => new THREE.Vector3(...toView(point)))), after = texelSphere(record);
    records++; texels += points.length;
    if (![...before.center.toArray(), before.radius].every((v, i) => Object.is(v, [...after.center.toArray(), after.radius][i]))) {
      if (differ++ < 5) console.log(`${name} ${key}: setFromPoints ${JSON.stringify(before)}, texelSphere ${JSON.stringify(after)}`);
    }
  }
  lighting.dispose();
}
if (differ) { console.log(`FAIL ${NAME}: ${differ} of ${records} spheres differ`); process.exit(1); }
console.log(`PASS ${NAME}: ${records} light-map records (${texels} texels; ${maps.join(', ')}, the first also under a mover's matrix) have the same frustum sphere as before`);
