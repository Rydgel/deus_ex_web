import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {LightAtlas} from '../src/viewer/light-atlas.mjs';
import {batchWorldMeshes} from '../src/viewer/world-batches.mjs';
import {POLY} from '../src/unreal/geometry.mjs';

const lightmap = value => ({width: 2, height: 2, pixels: new Float32Array(12).fill(value), uv: () => [.5, .5]});

test('lightmap array retains page bytes and sends partial updates to the exact layer/rectangle', () => {
  const atlas = new LightAtlas(4), maps = [lightmap(.1), lightmap(.5), lightmap(.9)];
  const tiles = maps.map(map => atlas.add(map)), before = atlas.pages.map(page => page.pixels.slice());
  const array = atlas.sealArray().value;
  assert.equal(array.image.depth, 3);
  for (const [i, page] of atlas.pages.entries()) {
    assert.deepEqual(page.pixels, before[i]);
    assert.equal(page.pixels.buffer, array.image.data.buffer);
    assert.equal(page.texture.image.data, page.pixels); assert.equal(page.staging.image.data, page.pixels);
  }
  maps[1].pixels.fill(.25); atlas.update(maps[1]);
  assert.equal(array.layerUpdates.size, 0, 'first upload still initializes all layers');
  array.onUpdate(); atlas.pages[1].texture.onUpdate();
  maps[1].pixels[0] = .75;
  atlas.update(maps[1], {partial: true, region: {minU: 0, maxU: 1, minV: 0, maxV: 1}});
  const copies = [];
  atlas.flush({copyTextureToTexture(source, destination, region, position) {
    copies.push({source, destination, min: region.min.toArray(), max: region.max.toArray(), at: position.toArray()});
  }});
  assert.equal(copies.length, 2);
  assert.equal(copies[0].destination, tiles[1].page.texture);
  assert.equal(copies[1].destination, array);
  assert.deepEqual(copies.map(copy => [copy.min, copy.max, copy.at]),
    [[[0, 0], [2, 2], [0, 0]], [[0, 0], [2, 2], [0, 0, 1]]]);
  assert.equal(tiles[1].page.pixels[0], Math.round(.75 * 255));
  atlas.update(maps[2]); assert.equal(array.layerUpdates.size, 0);
  atlas.update(maps[0], {partial: true}); atlas.flush(null);
  assert.equal(array.layerUpdates.size, 0);
  assert.throws(() => atlas.add(lightmap(.2)), /sealed/);
  atlas.dispose();
});

test('ordered batches preserve vertices, equal-depth triangle order, barriers and inspection metadata', () => {
  const root = new THREE.Group(), atlas = new LightAtlas(4);
  for (let i = 0; i < 3; i++) atlas.add(lightmap(.3));
  let ordinal = 0;
  const textures = Array.from({length: 12}, () => new THREE.DataTexture(new Uint8Array(16), 2, 2));
  const add = ({texture = 0, parent = root, flags = 0, material = null, alphaTest = 0, side = THREE.FrontSide} = {}) => {
    material ??= new THREE.MeshBasicMaterial({map: textures[texture], alphaTest, side});
    material.userData = {key: `texture${texture}`, flags, ordinal};
    if (flags & POLY.Translucent) material.transparent = true;
    const geometry = new THREE.BufferGeometry();
    for (const [name, size] of [['position', 3], ['normal', 3], ['uv', 2], ['lightUV', 3], ['lightBounds', 4], ['lightLayer', 1]])
      geometry.setAttribute(name, new THREE.Float32BufferAttribute(new Float32Array(size * 3).fill(ordinal + .25), size));
    for (let i = 0; i < 3; i++) geometry.attributes.lightUV.array[i * 3 + 2] = ordinal % 2;
    geometry.attributes.lightLayer.array.fill(ordinal % 3);
    const mesh = new THREE.Mesh(geometry, material);mesh.userData = {actor: parent === root ? null : 'Mover', faces: [ordinal++]};
    parent.add(mesh);return mesh;
  };
  for (let i = 0; i < 10; i++) add({texture: i}); // Eight-sampler limit splits this run.
  add({flags: POLY.Translucent}); // Separate transparent list; never altered.
  const mirror = add({flags: POLY.Mirrored});
  add();add();
  const mover = new THREE.Group();root.add(mover);
  const shared = add();const moved = add({parent: mover, material: shared.material});
  add();add({alphaTest: .5});add({alphaTest: .5});add({side: THREE.DoubleSide});add({side: THREE.DoubleSide});
  const opaque = () => {
    const all = [];root.traverse(mesh => {if (mesh.isMesh && !mesh.material.transparent) all.push(mesh);});
    return all.sort((a, b) => a.material.id - b.material.id || a.id - b.id);
  };
  const stream = () => opaque().flatMap(mesh => {
    const stride = mesh.userData.lightTextureStride, shader = {uniforms: {}, vertexShader: '', fragmentShader: ''};
    if (stride) mesh.material.onBeforeCompile(shader);
    return mesh.userData.faces.map((face, i) => ({face,
      material: mesh.userData.faceMaterials?.[i] ?? mesh.material.userData,
      texture: stride ? shader.uniforms[`deusMap${Math.floor(mesh.geometry.attributes.lightUV.array[i * 9 + 2] / stride)}`].value : mesh.material.map,
      attrs: Object.fromEntries(['position', 'normal', 'uv', 'lightUV', 'lightBounds', 'lightLayer'].map(name => {
        const attr = mesh.geometry.getAttribute(name), values = attr.array.slice(i * 3 * attr.itemSize, (i + 1) * 3 * attr.itemSize);
        if (stride && name === 'lightUV') for (let j = 2; j < values.length; j += 3) {
          const layer = Math.round(values[j]) % stride;
          if (layer) assert.equal(layer - 1, mesh.geometry.attributes.lightLayer.array[i * 3 + (j - 2) / 3]);
          values[j] = Number(layer > 0);
        }
        return [name, values];
      }))}));
  });
  const before = stream(), oldIds = opaque().map(mesh => mesh.material.id);
  const stats = batchWorldMeshes(root, atlas, {value: 1}, {value: 1});
  assert.deepEqual(stream(), before);
  assert.ok(stats.after < stats.before / 2);assert.equal(stats.batches, 5);
  assert.equal(mirror.parent, root);assert.equal(shared.parent, root);assert.equal(moved.parent, mover);
  assert.ok(opaque().every(mesh => oldIds.includes(mesh.material.id)), 'first material IDs preserve global sort slots');
  const shader = {uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>',
    fragmentShader: '#include <common>\n#include <map_fragment>\n#include <colorspace_fragment>'};
  opaque()[0].material.onBeforeCompile(shader);
  assert.equal(shader.uniforms.deusLightAtlas, atlas.arrayUniform);
  assert.equal(Object.keys(shader.uniforms).filter(key => /^deusMap/.test(key)).length, 8);
  assert.ok(shader.fragmentShader.indexOf('texture2D(deusMap7') < shader.fragmentShader.indexOf('if (deusTextureIndex'));
  assert.ok(!shader.vertexShader.includes('flat varying'), 'original vertex varying layout is retained');
  assert.match(shader.fragmentShader, /highp int deusTextureIndex = int\(floor\(vDeusLightUV.z \+ 0.5\)\) \/ 4;/);
  assert.match(shader.fragmentShader, /highp int deusLightLayer = int\(floor\(vDeusLightUV.z \+ 0.5\)\) % 4;/);
  root.traverse(mesh => mesh.geometry?.dispose());atlas.dispose();textures.forEach(texture => texture.dispose());
});
