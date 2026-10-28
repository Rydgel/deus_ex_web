/** Play integration for AugLight's moving lights (docs/dynamic-lighting.md):
 * F12 runs the original ActivateAugmentation path, the two Beams it spawns
 * pass SetupDynamics' gate, the world adds their NonIncidence texels onto the
 * static light maps, and turning the augmentation off restores the static
 * texels exactly. Requires the local install. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { createWorld } from '../src/viewer/world.mjs';
import { createGame } from '../src/viewer/game.mjs';
import { gameDirectory } from './game-directory.mjs';
import { createPlayerInputFixture } from './player-input-fixture.mjs';
import { colorTableEntry } from '../src/runtime/dynamic-lighting.mjs';

const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files), asset = await assets.get('00_Training'), map = decodeMap(asset.bytes);
const world = await createWorld(map, asset, assets);
const game = await createGame(map, asset, assets, { randomSeed: 1, onLightingChanged: changes => world.updateLighting(changes) });
const input = createPlayerInputFixture(game, { tickSeconds: 1 / 120 });
// Play's mover states (sim-session.mjs movers) place the movers and their light maps (no tracker here: brush matrices)
// before the moving lights.
const frame = () => {
  world.syncMovers(game.collision.movers.map(mover => ({ name: mover.name, values: mover.values, position: [...mover.position],
    rotation: mover.rotation ? [...mover.rotation] : null, offset: [...mover.collider.offset] })));
  world.relightMovers(null);
  return world.syncMovingLights(game.movingLights());
};

input.tick(60);
const before = game.movingLights();
assert.ok(before.every(light => light.values.LightEffect !== 13), 'no NonIncidence moving light before F12');
// SecurityCamera lights are movable steady lights too; they light surfaces
// before and after the augmentation.
const idle = frame(), idleRecords = new Set(world.movingLightRecords());
// Check the actual renderer composition against the original normal spatial
// body. This detects accidentally leaving ordinary camera lights on the old
// float path even when the isolated runtime translation passes its oracle.
assert.equal(before.length, 4, 'four authored SecurityCamera lights');
const bits = new DataView(new ArrayBuffer(4));
const u32 = value => { bits.setFloat32(0, value, true); return bits.getUint32(0, true); };
const liveCases = [], liveRecords = [];
for (const record of idleRecords) for (const contribution of record.moving) {
  const { item, rect, grid, incidence } = contribution, { values, constants } = item;
  assert.equal(item.kind, 'normal', 'camera light dispatched to original normal path');
  const facet = record.movingGeometry.facet;
  liveRecords.push(record);
  liveCases.push({ light: { location: item.location, radius: values.LightRadius,
    brightness: values.LightBrightness, effect: 0 },
    facet: Object.fromEntries(Object.entries(facet).map(([key, v]) => [key, key === 'clamp' ? v : v.map(u32)])),
    grid: Object.fromEntries(Object.entries(grid).map(([key, v]) => [key, v.map(u32)])),
    rect: [rect.minU, rect.maxU, rect.minV, rect.maxV],
    constants: { rradius: u32(constants.rradius), rr2: u32(constants.rr2), incidence: u32(incidence) },
    table: Array.from({ length: 256 }, (_, s) => (0xff000000 | colorTableEntry(constants.steps[2], s) |
      (colorTableEntry(constants.steps[1], s) << 8) | (colorTableEntry(constants.steps[0], s) << 16)) >>> 0),
    static: new Array(record.width * record.height).fill(0) });
}
const original = JSON.parse(execFileSync(process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python',
  ['scripts/native-dynamic-light-oracle.py', root], { input: JSON.stringify({ normalTable: true, spatial: liveCases }),
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
const expected = new Map([...idleRecords].map(record => [record, record.staticPixels.slice()]));
for (let i = 0; i < liveCases.length; i++) {
  const out = expected.get(liveRecords[i]), result = original.spatial[i];
  for (let p = 0; p < result.spatial.length; p++) if (result.spatial[p]) {
    for (let channel = 0; channel < 3; channel++) {
      const value = (result.merged[p] >>> ((2 - channel) * 8)) & 255;
      out[p * 3 + channel] = Math.min(127 / 255, out[p * 3 + channel] + value / 255);
    }
  }
}
for (const [record, pixels] of expected) assert.deepEqual(record.pixels, pixels, `camera lightmap ${record.surfaceIndex}`);
assert.ok(!world.notes.some(note => note.includes('still use the float static-light reconstruction')));

game.inputKey('F12', true); game.inputKey('F12', false);
input.tick(12);
const beams = game.movingLights().filter(light => /^Beam\d+$/.test(light.name));
assert.equal(beams.length, 2, 'AugLight.BeginState spawned two Beams');
assert.ok(beams.every(beam => beam.values.LightType === 1 && beam.values.LightEffect === 13 && !beam.values.bStatic),
  'Beams are steady NonIncidence movable lights');
assert.deepEqual(beams.map(beam => beam.values.LightBrightness).sort(), [192, 220]);

const lit = frame();
assert.ok(lit.lightmaps > 0 && lit.surfaces > 0, 'the Beams reach Training light maps');
const lighting = [], litRecords = world.movingLightRecords();
for (const record of litRecords) {
  let brighter = 0;
  for (let i = 0; i < record.pixels.length; i++) if (record.pixels[i] > record.staticPixels[i] + 1e-7) brighter++;
  lighting.push({ surface: record.surfaceIndex, brighter, owner: record.owner });
}
assert.ok(lighting.some(entry => entry.brighter > 0), 'Beam texels brighten at least one light map');
assert.equal(frame().lightmaps, 0, 'an unchanged frame re-composes nothing');

game.inputKey('F12', true); game.inputKey('F12', false);
input.tick(12);
assert.equal(game.movingLights().filter(light => /^Beam\d+$/.test(light.name)).length, 0, 'Deactivate destroyed both Beams');
const off = frame();
assert.deepEqual(new Set(world.movingLightRecords()), idleRecords, 'only the pre-F12 moving lights remain');
const beamOnly = litRecords.filter(record => !idleRecords.has(record));
assert.ok(beamOnly.length > 0 && beamOnly.every(record => !record.staticPixels && !record.moving),
  'records the Beams alone reached return to their static texels');
console.log(JSON.stringify({ idle, nativeCameraLightmaps: expected.size, lit, litLightmaps: lighting.filter(entry => entry.brighter).length,
  brightestTexels: Math.max(...lighting.map(entry => entry.brighter)), off }));
