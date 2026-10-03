/** Original-map geometry/material stream across the ordered GPU batch boundary. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createWorld} from '../src/viewer/world.mjs';
import {gameDirectory} from './game-directory.mjs';

const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures']) for (const name of await readdir(path.join(root, directory)))
  files.push({path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name))});
const assets = new AssetStore(files);
function stream(world) {
  const meshes = [];world.root.traverse(mesh => {if (mesh.isMesh) meshes.push(mesh);});
  meshes.sort((a, b) => Number(a.material.transparent) - Number(b.material.transparent) ||
    a.renderOrder - b.renderOrder || a.material.id - b.material.id || a.id - b.id);
  const hash = createHash('sha256');let triangles = 0;
  for (const mesh of meshes) {
    const material = mesh.material;
    if (mesh.userData.backdrop) {
      // The depth-only fake-backdrop mesh (no texture or face identities):
      // its triangles and its place in the draw order belong to the stream.
      hash.update(JSON.stringify(['backdrop', mesh.userData.actor, mesh.userData.model, mesh.renderOrder,
        material.side, material.colorWrite, material.depthWrite]));
      const positions = mesh.geometry.getAttribute('position').array;
      hash.update(new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength));
      continue;
    }
    // Transparent meshes retain their geometry/material boundaries; opaque
    // merged runs retain this same per-triangle sequence and material state.
    for (let i = 0; i < mesh.userData.faces.length; i++) {
      const metadata = mesh.userData.faceMaterials?.[i] ?? material.userData;
      hash.update(JSON.stringify([mesh.userData.actor, mesh.userData.model, mesh.userData.faces[i], metadata,
        material.side, material.alphaTest, material.transparent, material.blending, material.depthWrite,
        material.blendSrc, material.blendDst]));
      for (const name of ['position', 'normal', 'uv', 'lightUV', 'lightBounds', 'lightLayer']) {
        const attribute = mesh.geometry.getAttribute(name), start = i * 3 * attribute.itemSize;
        const values = attribute.array.slice(start, start + 3 * attribute.itemSize), stride = mesh.userData.lightTextureStride;
        if (name === 'lightUV' && stride) for (let j = 2; j < values.length; j += 3) {
          const layer = Math.round(values[j]) % stride;
          if (layer) assert.equal(layer - 1, mesh.geometry.attributes.lightLayer.array[i * 3 + (j - 2) / 3]);
          values[j] = Number(layer > 0);
        }
        hash.update(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
      }
      triangles++;
    }
  }
  return {triangles, hash: hash.digest('hex'), errors: world.errors, counts: world.counts};
}
for (const name of ['00_Training', '01_NYC_UNATCOIsland']) {
  const asset = await assets.get(name), map = decodeMap(asset.bytes);
  const original = await createWorld(map, asset, assets, undefined, {batchOpaque: false});
  const expected = stream(original);original.dispose();
  const batched = await createWorld(map, asset, assets);
  try {
    assert.deepEqual(stream(batched), expected, `${name}: every original-map triangle, material, UV, texel layer and inspection identity remains ordered`);
    assert.ok(batched.submissionBatches.after < batched.submissionBatches.before / 2);
    console.log(JSON.stringify({map: name, ...batched.submissionBatches, triangles: expected.triangles,
      stream: expected.hash, existingErrors: expected.errors.length}));
  } finally {batched.dispose();}
}
