/** Original mirror reference first; browser translation checks are opt-in after
 * those cases exist. Original assets/results stay in the ignored .cache folder. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as THREE from 'three';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { POLY, toView, fromView } from '../src/unreal/geometry.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System']) for (const name of await readdir(path.join(root, directory)))
  files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files), asset = await assets.get('00_Training'), map = decodeMap(asset.bytes);
const surfaces = map.model.surfaces.filter(s => s.flags & POLY.Mirrored);
const heights = [...new Set(surfaces.map(s => map.model.points[s.base][2]))];
assert.equal(surfaces.length, 46);
assert.deepEqual(heights.toSorted((a, b) => a - b), [-176, -160, -144, -128]);
for (const s of surfaces) {
  assert.deepEqual(map.model.vectors[s.normal].map(v => v || 0), [0, 0, 1]);
  assert.equal(s.flags, 0x08840004);
}
const coordsFor = camera => {
  const e = camera.matrixWorld.elements;
  return [...fromView(e.slice(12, 15)), ...fromView(e.slice(0, 3)),
    ...fromView(e.slice(4, 7).map(v => -v)), ...fromView(e.slice(8, 11).map(v => -v))];
};
const cameras = [[65524, 31, 0], [65501, 2496, 0], [-4100, 7900, 1200]].map(rotation => {
  const camera = new THREE.PerspectiveCamera(60, 1.5, 1, 50000);
  camera.position.fromArray(toView([-1149.2435302734375, 825.8439331054688, -40.19999694824219]));
  const [p, y, r] = rotation.map(v => (v > 32767 ? v - 65536 : v) * Math.PI / 32768);
  camera.rotation.set(p, -y, -r, 'YXZ'); camera.updateMatrixWorld();
  // DLL accepts float32 coordinates; keep exactly those inputs for the adapter.
  camera.matrixWorld.elements = camera.matrixWorld.elements.map(Math.fround);
  return camera;
});
const cases = { frames: cameras.flatMap(camera => heights.map(z => ({ coords: coordsFor(camera), plane: [0, 0, 1, z] }))),
  blends: [0x08840004, 0x88840004] };
const reference = JSON.parse(execFileSync(process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python',
  ['scripts/native-mirror-oracle.py', root], { input: JSON.stringify(cases), encoding: 'utf8' }));
if (process.argv.includes('--reference-only')) {
  await writeFile('.cache/stage4-mirror-original.json', JSON.stringify({ cases, reference }, null, 2));
  console.log(`Recorded unchanged original code: ${reference.frames.length} mirror frames, 2 blend-state traces; 46 Training surfaces / 4 planes.`);
  process.exit(0);
}
const { mirrorMatrix } = await import('../src/viewer/mirrors.mjs');
for (let i = 0; i < cases.frames.length; i++) {
  const c = cases.frames[i], expected = reference.frames[i];
  const source = cameras[Math.floor(i / heights.length)];
  const plane = new THREE.Plane(new THREE.Vector3(...toView(c.plane.slice(0, 3))), -c.plane[3]);
  const reflected = source.clone();
  reflected.matrixWorld.multiplyMatrices(mirrorMatrix(plane), source.matrixWorld);
  const actual = coordsFor(reflected);
  actual.forEach((v, j) => assert.ok(Math.abs(v - expected.coords[j]) < .00002, `frame ${i} component ${j}: ${v} / ${expected.coords[j]}`));
  assert.equal(expected.mirror, -1);
  assert.ok(reflected.matrixWorld.determinant() < 0, 'mirror reverses winding');
  const original = source.matrixWorld.clone().invert();
  const transformed = plane.clone().applyMatrix4(original);
  // Native view has +Y down and +Z forward. NearClip is the negative
  // transformed world plane; in Three the accepted halfspace is distance>=0.
  const clip = [-transformed.normal.x, transformed.normal.y, transformed.normal.z, transformed.constant];
  clip.forEach((v, j) => assert.ok(Math.abs(v - expected.clip[j]) < .0001, `frame ${i} clip ${j}`));
}
assert.deepEqual(reference.blends[0].states, [[27, 1], [19, 2], [20, 4]]);
assert.deepEqual(reference.blends[1].states, [[27, 1], [19, 2], [20, 4], [14, 1]]);
console.log('Mirrors: 46 authored surfaces / 4 planes; 12 reflected frames and clip planes match original instructions; original blend ONE/INVSRCCOLOR and depth writes confirmed.');
