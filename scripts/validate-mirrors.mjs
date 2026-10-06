/** Original mirror reference first; browser translation checks are opt-in after
 * those cases exist. Original assets/results stay in the ignored .cache folder. */
import { auditAssert } from './precision-audit.mjs';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as THREE from 'three';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { POLY, toView, fromView } from '../src/unreal/geometry.mjs';
import { gameDirectory } from './game-directory.mjs';
// ORACLE_CW=0x007f: the render-pass precision audit (precision-audit.mjs).
const assert = auditAssert();

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
// Every static mirrored BSP surface in the shipped single-player maps, by the
// node plane OccludeBsp reflects across ([ebp-0x1c] = FBspNode, whose first
// 16 bytes are its FPlane). Each surface has exactly one node plane.
const { mirrorPlanes } = await import('../src/viewer/mirrors.mjs');
const allPlanes = new Map(), kinds = {};
let mirroredSurfaces = 0;
for (const name of (await readdir(path.join(root, 'Maps'))).filter(n => /\.dx$/i.test(n) && !/^dxmp_/i.test(n))) {
  const m = name === '00_Training.dx' ? map : decodeMap((await assets.get(name.replace(/\.dx$/i, ''))).bytes);
  const planes = mirrorPlanes(m.model);
  for (const [surfaceIndex, plane] of planes) {
    const flags = m.model.surfaces[surfaceIndex].flags, n = plane;
    const kind = `${Math.abs(n[2]) > .999 ? (n[2] > 0 ? 'up' : 'down') : Math.abs(n[2]) < .001 ? 'vertical' : 'oblique'} ${flags & 0x47 ? 'composited' : 'opaque'}`;
    kinds[kind] = (kinds[kind] ?? 0) + 1;
    allPlanes.set(plane.join(), plane); mirroredSurfaces++;
  }
}
assert.equal(mirroredSurfaces, 211);
assert.equal(allPlanes.size, 80); // 117 per-map planes; repeated maps (Smug, Bar, Hotel...) share them
const planeCases = [...allPlanes.values()];
const cases = { frames: [...cameras.flatMap(camera => heights.map(z => ({ coords: coordsFor(camera), plane: [0, 0, 1, z] }))),
  ...cameras.flatMap(camera => planeCases.map(plane => ({ coords: coordsFor(camera), plane })))],
  blends: [0x08840004, 0x88840004],
  // Every mirrored surface flag word in the shipped maps (static and mover).
  afterChild: [0x08840004, 0x08800004, 0x08000000, 0x08400000, 0x08400004, 0x08880004, 0x0840000c, 0x0888000c, 0x08000002, 0x08000040] };
const reference = JSON.parse(execFileSync(process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python',
  ['scripts/native-mirror-oracle.py', root], { input: JSON.stringify(cases), encoding: 'utf8' }));
if (process.argv.includes('--reference-only')) {
  await writeFile('.cache/stage4-mirror-original.json', JSON.stringify({ cases, reference }, null, 2));
  console.log(`Recorded unchanged original code: ${reference.frames.length} mirror frames, 2 blend-state traces; 46 Training surfaces / 4 planes, ${mirroredSurfaces} mirrored surfaces / ${allPlanes.size} planes in all maps.`);
  process.exit(0);
}
const { mirrorMatrix } = await import('../src/viewer/mirrors.mjs');
for (let i = 0; i < cases.frames.length; i++) {
  const c = cases.frames[i], expected = reference.frames[i];
  const training = cameras.length * heights.length;
  const source = cameras[i < training ? Math.floor(i / heights.length) : Math.floor((i - training) / planeCases.length)];
  const plane = new THREE.Plane(new THREE.Vector3(...toView(c.plane.slice(0, 3))), -c.plane[3]);
  const reflected = source.clone();
  reflected.matrixWorld.multiplyMatrices(mirrorMatrix(plane), source.matrixWorld);
  const actual = coordsFor(reflected);
  // The original computes in float32 (x87 with FST of each vector); the
  // adapter keeps doubles until the GPU upload. Allow a few float32 ulps of
  // the largest magnitude in the reflection (origin, plane W, result).
  const scale = Math.max(Math.abs(c.plane[3]), ...c.coords.slice(0, 3).map(Math.abs));
  actual.forEach((v, j) => assert.ok(Math.abs(v - expected.coords[j]) < .00002 + 4 * 2 ** -24 * Math.max(scale, Math.abs(v)) * (j < 3),
    `frame ${i} component ${j}: ${v} / ${expected.coords[j]}`));
  assert.equal(expected.mirror, -1);
  assert.ok(reflected.matrixWorld.determinant() < 0, 'mirror reverses winding');
  const original = source.matrixWorld.clone().invert();
  const transformed = plane.clone().applyMatrix4(original);
  // Native view has +Y down and +Z forward. NearClip is the negative
  // transformed world plane; in Three the accepted halfspace is distance>=0.
  const clip = [-transformed.normal.x, transformed.normal.y, transformed.normal.z, transformed.constant];
  clip.forEach((v, j) => assert.ok(Math.abs(v - expected.clip[j]) < .0001 + 4 * 2 ** -24 * scale * (j === 3),
    `frame ${i} clip ${j}: ${v} / ${expected.clip[j]}`));
}
// After the child frame (10b18b58-10b18b93, D3D SpanBased 0): a surface with
// any of Invisible|Masked|Translucent|Modulated (0x47) keeps drawing with
// PF_Occlude over the reflection; an opaque mirror becomes PF_Invisible too,
// so only the reflected child shows.
const { mirrorDrawFlags } = await import('../src/viewer/mirrors.mjs');
cases.afterChild.forEach((flags, i) => assert.equal(mirrorDrawFlags(flags) >>> 0, reference.afterChild[i] >>> 0, `after child 0x${flags.toString(16)}`));
assert.deepEqual(reference.afterChild.map(f => (f >>> 0).toString(16)),
  ['88840004', '88800004', '88000001', '88400001', '88400004', '88880004', '8840000c', '8888000c', '88000002', '88000040']);
assert.deepEqual(reference.blends[0].states, [[27, 1], [19, 2], [20, 4]]);
assert.deepEqual(reference.blends[1].states, [[27, 1], [19, 2], [20, 4], [14, 1]]);
console.log(`Mirrors: 46 Training surfaces / 4 planes and ${mirroredSurfaces} mirrored surfaces / ${allPlanes.size} node planes in all maps (${JSON.stringify(kinds)}); ${cases.frames.length} reflected frames and clip planes match original instructions; original blend ONE/INVSRCCOLOR and depth writes confirmed.`);
if (assert.enabled) assert.report('validate-mirrors');
