#!/usr/bin/env node
/** Headless driver of the moving-light update over a fixed frame sequence (host measurement only; docs/firefox-60fps-plan.md
 * "Moving lights (2026-11-07)"). It boots a map through Play's createGame and createWorld, puts the player at a spot, and for N frames
 * hands the world what main.mjs hands it: the light frame, the movers, game.movingLights(), and the light maps in the view's
 * frustum as the drawn ones (no OccludeBsp here: the browser's drawn set is smaller, so the figures overstate the phase a little).
 * It times `world.syncMovingLights` (the update and the atlas writes) and can hash what it produced: after every frame the floats
 * of every moving light map and every atlas page, so that two builds or two switch settings are compared byte for byte.
 *
 *   node scripts/moving-lights-bench.mjs --map 03_NYC_MolePeople --place 2469,-179,23 --yaw 32768 [--frames 240] [--warm 60]
 *     [--hash] [--stats] [--lights] [--cpu-profile FILE] [--auglight] (00_Training: F12, the AugLight) [--turn N] (MouseX N each frame)
 *     [--all] (no view: every light map is drawn)
 *
 * MOVING_COMPOSE=js|rust|verify (the switches of moving-lights.mjs) are read from the environment.
 * --hash prints sha1 digests of the pixels (`texels`: the moving light maps' floats, `atlas`: the pages' bytes), each updated per frame.
 * --stats counts, per frame, the recomposed light maps and the texels of their dirty regions.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as THREE from 'three';

const argv = process.argv.slice(2), flag = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const has = name => argv.includes(`--${name}`);
const mapName = flag('map', '03_NYC_MolePeople'), frames = Number(flag('frames', 240)), warm = Number(flag('warm', 60));
const place = flag('place', null)?.split(',').map(Number) ?? null, yaw = Number(flag('yaw', 0)), turn = Number(flag('turn', 0));

const { AssetStore } = await import('../src/unreal/assets.mjs');
const { decodeMap } = await import('../src/unreal/map.mjs');
const { createWorld } = await import('../src/viewer/world.mjs');
const { createGame } = await import('../src/viewer/game.mjs');
const { placeProbe } = await import('../src/viewer/decal-probe.mjs');
const { toView } = await import('../src/unreal/geometry.mjs');
const { gameDirectory } = await import('./game-directory.mjs');
const { createPlayerInputFixture } = await import('./player-input-fixture.mjs');
const { createLightNoise, lightNoiseSnapshot } = await import('../src/runtime/static-lighting.mjs');
const { createNativeRng } = await import('../src/runtime/rng.mjs');

const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files), asset = await assets.get(mapName), map = decodeMap(asset.bytes);
const world = await createWorld(map, asset, assets);
const game = await createGame(map, asset, assets, { randomSeed: 1, onLightingChanged: changes => world.updateLighting(changes) });
const input = createPlayerInputFixture(game, { tickSeconds: 1 / 60 });
const runtime = game.doors.scriptRuntime.runtime;
input.tick(60);
if (place) placeProbe(game, { location: place, rotation: [0, yaw, 0] });
if (mapName === '00_Training' && has('auglight')) { game.inputKey('F12', true); game.inputKey('F12', false); }

// The view the drawn light maps are taken from: the player's eye (Unreal axes -> three's), 75 degrees vertical, 4:3.
const eye = place ?? game.view().location, camera = new THREE.PerspectiveCamera(75, 1.5, 1, 100000);
const yawRad = yaw * Math.PI / 32768;
camera.position.set(...toView(eye.map((v, i) => v + (i === 2 ? 48 : 0))));
camera.lookAt(...toView(eye.map((v, i) => v + [Math.cos(yawRad), Math.sin(yawRad), 0][i] * 100 + (i === 2 ? 48 : 0))));
camera.updateMatrixWorld();
const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));

const lightNoise = createLightNoise(createNativeRng(0x1badf00d).frand);
const texelHash = createHash('sha1'), atlasHash = createHash('sha1');
const bytes = array => Buffer.from(array.buffer, array.byteOffset, array.byteLength);
const times = [], stats = [];
const movers = () => game.collision.movers.map(mover => ({ name: mover.name, values: mover.values, rotation: mover.rotation ? [...mover.rotation] : null,
  offset: [...mover.collider.offset], position: mover.values.Location.map((v, i) => Math.fround(v + mover.collider.offset[i])) }));
let profile = null;
if (flag('cpu-profile', null)) {
  const inspector = await import('node:inspector'), session = new inspector.Session();
  session.connect();
  const post = (method, params) => new Promise((resolve, reject) => session.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
  await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: 100 });
  profile = { start: () => post('Profiler.start'), stop: async () => (await post('Profiler.stop')).profile };
}
const lightLog = [];
if (has('debug-changes')) globalThis.__dbgChanged = [];
function frame(index, timed) {
  if (turn) game.inputAxis('MouseX', turn);
  input.tick(1);
  const lights = game.movingLights();
  const timeSeconds = Math.fround(runtime.readNamed(runtime.levelFor(game.player.collisionActor).actors[0], 'TimeSeconds'));
  lightNoise.update(timeSeconds);
  world.beginLightFrame({ timeSeconds, noise: lightNoiseSnapshot(lightNoise) });
  if (timed && has('lights') && index === warm) for (const l of lights) console.error(`${l.name} type ${l.values.LightType} effect ${l.values.LightEffect} brightness ${l.values.LightBrightness} radius ${l.values.LightRadius} at ${l.location.map(Math.round)}`);
  const state = movers();
  world.syncMovers(state); world.relightMovers(null);
  const start = performance.now();
  const result = world.syncMovingLights(lights, has('all') ? {} : { frustum });
  const ms = performance.now() - start;
  world.updateTextureAnimation(index / 60, has('all') ? { timeSeconds } : { timeSeconds, frustum });
  if (!timed) return;
  times.push(ms);
  if (has('stats') || has('hash')) {
    const records = world.movingLightRecords();
    if (has('stats')) stats.push({ lights: lights.length, records: records.length, changed: result.lightmaps,
      texels: records.reduce((n, r) => n + (r.movingTexels ?? 0), 0) });
    if (has('hash')) {
      for (const record of records) texelHash.update(bytes(record.pixels));
      texelHash.update(Buffer.from(String(records.length)));
      for (const page of world.lightAtlasPages()) atlasHash.update(bytes(page));
    }
  }
}
for (let i = 0; i < warm; i++) frame(i, false);
await profile?.start();
for (let i = warm; i < warm + frames; i++) frame(i, true);
if (profile) await writeFile(flag('cpu-profile'), JSON.stringify(await profile.stop()));
const sorted = [...times].sort((a, b) => a - b), mean = times.reduce((s, x) => s + x, 0) / times.length;
const report = { map: mapName, place, yaw, frames, mode: process.env.MOVING_COMPOSE ?? 'default',
  meanMs: +mean.toFixed(3), p50Ms: +sorted[sorted.length >> 1].toFixed(3), p90Ms: +sorted[Math.floor(sorted.length * 0.9)].toFixed(3),
  ...(has('hash') ? { texels: texelHash.digest('hex').slice(0, 16), atlas: atlasHash.digest('hex').slice(0, 16) } : {}) };
if (has('stats')) {
  const sum = key => stats.reduce((s, x) => s + x[key], 0) / stats.length;
  Object.assign(report, { lights: +sum('lights').toFixed(1), movingRecords: +sum('records').toFixed(1), changedPerFrame: +sum('changed').toFixed(2),
    movingTexels: +sum('texels').toFixed(0) });
}
if (world.movingLightStats) Object.assign(report, { compose: world.movingLightStats().compose, composeStats: world.movingLightStats().stats });
if (globalThis.__dbgChanged) { const c = new Map(); for (const x of globalThis.__dbgChanged) c.set(x, (c.get(x) ?? 0) + 1); console.error([...c].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${v} ${k}`).join('\n')); }
console.log(JSON.stringify(report));
process.exit(0);
