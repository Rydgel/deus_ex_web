// Real-map fog-loop inputs (docs/volumetric-fog.md "Fast path"): builds a
// map's world headless and drives the Play fog pass (world.fog.update, the
// same frame coords, light constants, frustum test and early-out flag chain
// as main.mjs) over many eye positions and view rotations, recording every
// surface the pass sends to the Rust loop: the sorted lights' words, colour
// tables, camera-space grid, size and incoming flag. A resolve hook swaps
// world.mjs's fog-pass import for volumetric-fog-capture-shim.mjs, which
// wraps the kernel the real pass receives; no production code changes.
//
//   node scripts/volumetric-fog-capture.mjs MAP OUT.json [--views N]
//
// Frames of kind "view" use the main view's frustum (75 degrees at 3:2, as
// main.mjs at 1440x960); kind "all" sends every fog surface (no frustum) for
// coverage. Run one map per process: the world build is heavy.
import {registerHooks} from 'node:module';
import {readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import * as THREE from 'three';
import {gameDirectory} from './game-directory.mjs';

const [map, out] = process.argv.slice(2);
if (!map || !out) throw new Error('usage: volumetric-fog-capture.mjs MAP OUT.json [--views N]');
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : Number(process.argv[i + 1]); };
const VIEWS = option('views', 240);

const shim = new URL('./volumetric-fog-capture-shim.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './fog-pass.mjs' && context.parentURL?.endsWith('/src/viewer/world.mjs')) return {url: shim, shortCircuit: true};
    return next(specifier, context);
  },
});
const {fogCapture} = await import(shim);
const {AssetStore} = await import('../src/unreal/assets.mjs');
const {decodeMap} = await import('../src/unreal/map.mjs');
const {createWorld} = await import('../src/viewer/world.mjs');
const {toView, fromView} = await import('../src/unreal/geometry.mjs');

const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures']) for (const name of await readdir(path.join(root, directory)))
  files.push({path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name))});
const assets = new AssetStore(files);
const asset = await assets.get(map), decoded = decodeMap(asset.bytes);
const started = performance.now();
const world = await createWorld(decoded, asset, assets);
const fog = world.fog;
if (!fog.stats.surfaces || !fog.stats.lights) throw new Error(`${map}: no fog surfaces (${fog.stats.surfaces}) or volumetric lights (${fog.stats.lights})`);
if (!fog.stats.kernel) throw new Error(`${map}: the fog pass has no Rust kernel`);
console.error(`${map}: world in ${((performance.now() - started) / 1000).toFixed(1)} s, ${fog.stats.surfaces} fog surfaces, ${fog.stats.lights} volumetric lights`);

// Deterministic views.
let seed = 0x0f06ca9e ^ [...map].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const between = (a, b) => a + (b - a) * random();
const units = radians => Math.round(radians * 32768 / Math.PI);
const lookAt = (eye, target) => {
  const d = target.map((v, i) => v - eye[i]);
  return [units(Math.atan2(d[2], Math.hypot(d[0], d[1]))), units(Math.atan2(d[1], d[0]))];
};
const randomDirection = () => {
  const z = between(-1, 1), a = between(0, 2 * Math.PI), r = Math.sqrt(1 - z * z);
  return [r * Math.cos(a), r * Math.sin(a), z];
};
const volumetric = decoded.actors.filter(a => a.values.VolumeRadius > 0 && a.values.Location);
const starts = decoded.actors.filter(a => a.className === 'PlayerStart' && a.values.Location);
const spheres = fog.root.children.map(mesh => fromView(mesh.geometry.boundingSphere.center.toArray()));
const views = [];
if (map === '02_NYC_Bar') views.push({kind: 'view', location: [-900, -330, 80], rotation: [0, 25000, 0]}); // validate-volumetric-fog-play
for (const start of starts.slice(0, 2)) for (let k = 0; k < 8; k++)
  views.push({kind: 'view', location: start.values.Location, rotation: [0, (start.values.Rotation?.[1] ?? 0) + k * 8192, 0]});
while (views.length < VIEWS) {
  const pick = random();
  let location, rotation;
  if (pick < 0.45) {
    // Near or inside a volume: eyes from the centre out to 2.5 radii.
    const light = volumetric[Math.floor(random() * volumetric.length)], radius = ((light.values.VolumeRadius & 255) + 1) * 25;
    const direction = randomDirection(), distance = radius * 2.5 * Math.sqrt(random());
    location = light.values.Location.map((v, i) => v + direction[i] * distance);
    rotation = random() < 0.5 ? lookAt(location, light.values.Location) : [Math.round(between(-6000, 6000)), Math.round(between(0, 65536))];
  } else {
    // Looking at a fog surface from 100-1500 units.
    const target = spheres[Math.floor(random() * spheres.length)], direction = randomDirection();
    location = target.map((v, i) => v + direction[i] * between(100, 1500));
    rotation = lookAt(location, target);
  }
  rotation = [rotation[0] + Math.round(between(-1500, 1500)), rotation[1] + Math.round(between(-3000, 3000)), random() < 0.1 ? Math.round(between(-4000, 4000)) : 0];
  views.push({kind: views.length % 8 === 7 ? 'all' : 'view', location: location.map(Math.fround), rotation});
}

// main.mjs's camera: 75 degrees horizontal at 1440x960, rotation order YXZ.
const camera = new THREE.PerspectiveCamera(75, 1440 / 960, 1, 65536);
camera.rotation.order = 'YXZ';
camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(75 / 2)) / camera.aspect));
camera.updateProjectionMatrix();
const angle = n => ((n % 65536 + 98304) % 65536 - 32768) * Math.PI / 32768;
const frustumOf = view => {
  camera.position.fromArray(toView(view.location));
  camera.rotation.set(angle(view.rotation[0]), -angle(view.rotation[1]), -angle(view.rotation[2]));
  camera.updateMatrixWorld();
  return new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
};

const b64 = array => Buffer.from(array.buffer, array.byteOffset, array.byteLength).toString('base64');
const tables = [], tableIds = new Map(), lightSets = [], lightSetIds = new Map(), frames = [];
let records = [];
fogCapture.sink = ({width, height, count, lights, tables: bytes, grid, missIn}) => {
  const tableKey = b64(bytes);
  if (!tableIds.has(tableKey)) { tableIds.set(tableKey, tables.length); tables.push(tableKey); }
  const lightKey = `${b64(lights)}:${tableIds.get(tableKey)}`;
  if (!lightSetIds.has(lightKey)) { lightSetIds.set(lightKey, lightSets.length); lightSets.push({lights: b64(lights), table: tableIds.get(tableKey)}); }
  records.push(width, height, count, missIn, lightSetIds.get(lightKey), ...grid);
};
let texels = 0;
for (const view of views) {
  records = [];
  fog.update({location: view.location, rotation: view.rotation}, view.kind === 'all' ? null : frustumOf(view));
  frames.push({kind: view.kind, location: view.location, rotation: view.rotation, surfaces: b64(Uint32Array.from(records))});
  for (let i = 0; i < records.length; i += 14) texels += records[i] * records[i + 1] * records[i + 2];
}
await writeFile(out, JSON.stringify({map, lights: fog.stats.lights, fogSurfaces: fog.stats.surfaces, tables, lightSets, frames}));
console.error(`${map}: ${frames.length} frames, ${texels} texel-lights captured to ${out}`);
world.dispose();
