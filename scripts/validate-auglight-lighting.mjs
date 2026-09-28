/** Play integration for AugLight's moving lights (docs/dynamic-lighting.md):
 * F12 runs the original ActivateAugmentation path, the two Beams it spawns
 * pass SetupDynamics' gate, the world adds their NonIncidence texels onto the
 * static light maps, and turning the augmentation off restores the static
 * texels exactly. Requires the local install. */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { createWorld } from '../src/viewer/world.mjs';
import { createGame } from '../src/viewer/game.mjs';
import { gameDirectory } from './game-directory.mjs';
import { createPlayerInputFixture } from './player-input-fixture.mjs';

const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files), asset = await assets.get('00_Training'), map = decodeMap(asset.bytes);
const world = await createWorld(map, asset, assets);
const game = await createGame(map, asset, assets, { randomSeed: 1, onLightingChanged: changes => world.updateLighting(changes) });
const input = createPlayerInputFixture(game, { tickSeconds: 1 / 120 });
const frame = () => world.syncMovingLights(game.movingLights(), game.collision.movers);

input.tick(60);
const before = game.movingLights();
assert.ok(before.every(light => light.values.LightEffect !== 13), 'no NonIncidence moving light before F12');
// SecurityCamera lights are movable steady lights too; they light surfaces
// before and after the augmentation.
const idle = frame(), idleRecords = new Set(world.movingLightRecords());
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
console.log(JSON.stringify({ idle, lit, litLightmaps: lighting.filter(entry => entry.brighter).length,
  brightestTexels: Math.max(...lighting.map(entry => entry.brighter)), off }));

