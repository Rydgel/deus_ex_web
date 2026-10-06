/** Moving lights' incremental recomposition against the whole-frame
 * reference (src/viewer/moving-lights.mjs, docs/dynamic-lighting.md "Host
 * work"): two worlds of one map, one per mode, take the same lights and
 * mover offsets every frame. After every frame both must have the same
 * moving light maps, every light map either one ever recomposed must hold
 * the same float bits, static copy and moving region, and every light-atlas
 * byte must match.
 *
 * This is a host-work differential, not an original-game comparison: the
 * full mode is the reference for this composition, whose own original
 * evidence is validate-dynamic-lighting, validate-normal-moving-lighting and
 * validate-auglight-lighting. Workloads:
 * - 00_Training: the original AugLight path (F12), turning, so its two Beams
 *   move every frame; then F12 again.
 * - 01_NYC_UNATCOIsland and 03_NYC_Airfield: the authored moving lights as
 *   Play reads them, plus seeded perturbations (lights leaving and returning
 *   as an ElectricityEmitter's LightType flicker does, changed brightness and
 *   locations, swapped and repeated entries, mover offsets, and probe lights
 *   beside movers for the brush light maps). The perturbations are synthetic
 *   inputs for the bookkeeping, not game states.
 * Each map runs in its own process to bound memory. Requires the local install.
 *
 *   node scripts/validate-moving-lights-incremental.mjs [--map NAME] [--frames N] [--seed N] [--shell 1]
 *
 * `--shell 1` makes the fourth probe an LE_Shell light (the grenades'
 * ExplosionLight, spatial.rs in the Rust core) instead of a normal one.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2), flag = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const MAPS = ['00_Training', '01_NYC_UNATCOIsland', '03_NYC_Airfield'];

if (!flag('map')) {
  const results = [];
  for (const map of MAPS) {
    const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--map', map, ...argv],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 16 * 1024 * 1024 });
    results.push(JSON.parse(out.trim().split('\n').at(-1)));
  }
  console.log(JSON.stringify(results));
  process.exit(0);
}

const { AssetStore } = await import('../src/unreal/assets.mjs');
const { decodeMap } = await import('../src/unreal/map.mjs');
const { createWorld } = await import('../src/viewer/world.mjs');
const { createGame } = await import('../src/viewer/game.mjs');
const { gameDirectory } = await import('./game-directory.mjs');
const { createPlayerInputFixture } = await import('./player-input-fixture.mjs');

const mapName = flag('map'), frames = Number(flag('frames', 300));
const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files), asset = await assets.get(mapName), map = decodeMap(asset.bytes);
const full = await createWorld(map, asset, assets, undefined, { movingLightsMode: 'full' });
const incremental = await createWorld(map, asset, assets, undefined, { movingLightsMode: 'incremental' });
const game = await createGame(map, asset, assets, { randomSeed: 1,
  onLightingChanged: changes => { full.updateLighting(changes); incremental.updateLighting(changes); } });
const input = createPlayerInputFixture(game, { tickSeconds: 1 / 60 });
const runtime = game.doors.scriptRuntime.runtime;

// Seeded perturbations (mulberry32).
let seed = Number(flag('seed', 0x5eed1e55));
const rand = () => {
  seed = seed + 0x6d2b79f5 | 0;
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};
const pick = list => list[Math.floor(rand() * list.length)];
const perturbed = mapName !== '00_Training';
const changes = new Map(), moverDeltas = new Map(), flicker = new Set();
// Probe lights beside movers: the normal, NonIncidence and float paths.
const probes = game.collision.movers.slice(0, 4).map((mover, i) => ({ name: `ProbeLight${i}`, mover,
  values: { LightType: 1, bStatic: false, bNoDelete: false, bDynamicLight: false, LightBrightness: 180 + i * 20,
    LightRadius: 12 + i * 4, LightEffect: [0, 13, 1, flag('shell') ? 14 : 0][i], LightHue: 40 * i, LightSaturation: 128, bSpecialLit: false } }));
function lightsFor(frame) {
  let lights = game.movingLights();
  if (!perturbed) return lights;
  lights = lights.map(light => ({ ...light, location: [...light.location], values: { ...light.values } }));
  if (frame === 0) for (const light of lights) if (/ElectricityEmitter/.test(light.name) || rand() < 1 / 3) flicker.add(light.name);
  if (rand() < 0.08 && lights.length) {
    const light = pick(lights);
    changes.set(light.name, rand() < 0.5 ? { LightBrightness: 1 + Math.floor(rand() * 255) }
      : { offset: [rand() * 48 - 24, rand() * 48 - 24, rand() * 48 - 24] });
  }
  if (rand() < 0.05 && changes.size) changes.delete(pick([...changes.keys()]));
  for (const light of lights) {
    const change = changes.get(light.name);
    if (change?.LightBrightness) light.values.LightBrightness = change.LightBrightness;
    if (change?.offset) light.location = light.location.map((v, i) => v + change.offset[i]);
  }
  for (const probe of probes) if (frame % 90 < 60 + 7 * probe.name.length % 30)
    lights.push({ name: probe.name, location: probe.mover.position.map((v, i) => v + [24, -16, 32][i]),
      values: { ...probe.values }, levelBrightness: lights[0]?.levelBrightness ?? 1 });
  lights = lights.filter(light => !(flicker.has(light.name) && rand() < 0.4));
  if (rand() < 0.03 && lights.length > 1) {
    const i = Math.floor(rand() * lights.length), j = Math.floor(rand() * lights.length);
    [lights[i], lights[j]] = [lights[j], lights[i]];
  }
  if (rand() < 0.02 && lights.length) lights.splice(Math.floor(rand() * lights.length), 0, { ...pick(lights) });
  return lights;
}
function moversFor() {
  // Play's mover states (sim-session.mjs): name and collider offset.
  const movers = game.collision.movers.map(mover => ({ name: mover.name, offset: mover.collider.offset }));
  if (!perturbed) return movers;
  if (rand() < 0.05 && movers.length) moverDeltas.set(pick(movers).name, [rand() * 64 - 32, rand() * 64 - 32, rand() * 16 - 8]);
  if (rand() < 0.05 && moverDeltas.size) moverDeltas.delete(pick([...moverDeltas.keys()]));
  return movers.map(mover => ({ name: mover.name,
    offset: mover.offset.map((v, i) => v + (moverDeltas.get(mover.name)?.[i] ?? 0)) }));
}

const keyOf = record => `${record.owner ?? ''}|${record.surfaceIndex}|${record.zone}`;
const seen = [new Map(), new Map()];
const bytes = array => Buffer.from(array.buffer, array.byteOffset, array.byteLength);
const regionKey = region => region ? `${region.minU},${region.maxU},${region.minV},${region.maxV}` : '-';
const totals = { frames: 0, full: 0, incremental: 0, compared: 0, maxLights: 0 };
function frame(index) {
  const lights = lightsFor(index), movers = moversFor();
  totals.maxLights = Math.max(totals.maxLights, lights.length);
  const timeSeconds = runtime.readNamed(runtime.levelFor(game.player.collisionActor).actors[0], 'TimeSeconds');
  const results = [full, incremental].map(world => {
    const result = world.syncMovingLights(lights, movers);
    world.updateTextureAnimation(index / 60, { timeSeconds });
    return result;
  });
  totals.frames++; totals.full += results[0].lightmaps; totals.incremental += results[1].lightmaps;
  const active = [full, incremental].map((world, i) => {
    const keys = new Set();
    for (const record of world.movingLightRecords()) { const key = keyOf(record); keys.add(key); seen[i].set(key, record); }
    return keys;
  });
  assert.deepEqual([...active[1]].sort(), [...active[0]].sort(), `${mapName} frame ${index}: moving light maps`);
  for (const [key, a] of seen[0]) {
    const b = seen[1].get(key);
    assert.ok(b, `${mapName} frame ${index}: ${key} recomposed by the full mode only`);
    const where = `${mapName} frame ${index} light map ${key}`;
    assert.ok(bytes(a.pixels).equals(bytes(b.pixels)), `${where}: texels`);
    assert.equal(Boolean(b.staticPixels), Boolean(a.staticPixels), `${where}: static copy`);
    if (a.staticPixels) assert.ok(bytes(a.staticPixels).equals(bytes(b.staticPixels)), `${where}: static texels`);
    assert.equal(regionKey(b.movingRegion), regionKey(a.movingRegion), `${where}: moving region`);
    assert.equal(b.movingTexels, a.movingTexels, `${where}: moving texels`);
    totals.compared++;
  }
  assert.equal(seen[1].size, seen[0].size, `${mapName} frame ${index}: recomposed light maps`);
  const pages = [full.lightAtlasPages(), incremental.lightAtlasPages()];
  assert.equal(pages[1].length, pages[0].length);
  for (let i = 0; i < pages[0].length; i++)
    assert.ok(bytes(pages[0][i]).equals(bytes(pages[1][i])), `${mapName} frame ${index}: light atlas page ${i}`);
}

input.tick(60);
if (mapName === '00_Training') {
  for (let i = 0; i < 10; i++) { input.tick(1); frame(i); }
  game.inputKey('F12', true); game.inputKey('F12', false);
  let beams = 0;
  for (let i = 10; i < frames; i++) {
    game.inputAxis('MouseX', 6);
    input.tick(1); frame(i);
    beams = Math.max(beams, game.movingLights().filter(light => /^Beam\d+$/.test(light.name)).length);
  }
  assert.equal(beams, 2, 'AugLight spawned its two Beams');
  game.inputKey('F12', true); game.inputKey('F12', false);
  for (let i = frames; i < frames + 30; i++) { input.tick(1); frame(i); }
} else {
  for (let i = 0; i < frames; i++) { input.tick(1); frame(i); }
}
assert.ok(totals.compared > 0 && totals.full > 0, `${mapName}: the workload recomposed light maps`);
console.log(JSON.stringify({ map: mapName, ...totals, lightMaps: seen[0].size, notes: full.notes.length }));
