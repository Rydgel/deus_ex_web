/** Exercise the live Play -> world steady TriggerLight brightness bridge.
 *
 * This stays renderer-independent: it checks the source lightmap object and
 * atlas upload result directly after the original Training LightSwitch route.
 * The native bLightChanged setter/clear remains intentionally outside this
 * host callback; see docs/script-light-cache.md.
 */
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

const root = gameDirectory(), files = [];
const python=process.env.DEUS_EX_NATIVE_PYTHON??'.cache/native-probe-env/bin/python';
const original=JSON.parse(execFileSync(python,['scripts/native-light-color-cache-oracle.py',root],{encoding:'utf8'}));
assert.deepEqual(original.cases.map(value=>value.branch),['reuse','rebuild','rebuild','rebuild','rebuild','reuse']);
console.log(`Original Render.dll brightness/color-cache branch: ${original.cases.length} cases passed.`);
for (const dir of ['Maps', 'Textures', 'System', 'Sounds', 'Music']) {
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    if (entry.isFile()) files.push({ path: `${dir}/${entry.name}`, read: () => readFile(path.join(root, dir, entry.name)) });
  }
}
const assets = new AssetStore(files), asset = await assets.get('00_Training'), map = decodeMap(asset.bytes);
const world = await createWorld(map, asset, assets);
let syncCalls = 0, tracked = null;
const changes = [];
const game = await createGame(map, asset, assets, {
  randomSeed: 1,
  onLightingChanged(lights) {
    const update = world.updateLighting(lights);
    syncCalls++;
    changes.push({ lights, update });
    if (!tracked) {
      const lightmap = update.lightmaps.find(value => value.lightRefs?.has(111));
      if (lightmap) tracked = { lightmap, initial: lightmap.pixels.slice() };
    }
  },
});
assert.equal(syncCalls, 1, 'createGame reset performs one initial steady-light atlas sync');
assert.ok(tracked, 'initial sync must include a cached lightmap using TriggerLight 111');
assert.ok(changes[0].update.uploaded > 0, 'initial reset sync uploads dependent lightmaps');

const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor;
const input = createPlayerInputFixture(game, {tickSeconds: 1 / 120});
const level = runtime.levelFor(player), lightSwitch = level.actors.find(actor => actor?.name === 'LightSwitch0');
assert.ok(lightSwitch, 'Training map has LightSwitch0');
const pixelObject = tracked.lightmap, initialPixels = [...pixelObject.pixels];

// TriggerToggle's initial state transition re-enables Tick after BeginPlay's
// Disable('Tick'). The Training lights have ChangeTime 0 and bInitiallyOn
// false, so their first enabled Tick clamps Alpha to 0 and writes brightness
// 0 (docs/script-lights.md). The switch then turns them on. Batch 6 aims
// through real ticks, so this first Tick precedes any frob.
input.tick(1);
assert.equal(syncCalls, 2, 'the first TriggerLight Tick reaches world.updateLighting');
assert.deepEqual(changes[1].lights.map(light => light.values.LightBrightness), [0, 0, 0, 0],
  'bInitiallyOn=false lights write brightness zero on their first Tick');
assert.equal(tracked.lightmap, pixelObject, 'the affected cached lightmap object is retained');
const darkPixels = [...pixelObject.pixels];
assert.ok(darkPixels.some((value, index) => value !== initialPixels[index]), 'zero brightness changes cached pixels in place');

await input.frob(lightSwitch); // On: the original Tick body restores the authored brightness.
input.tick(1);
assert.equal(syncCalls, 3, 'restored steady brightness reaches the world callback');
const litPixels = [...pixelObject.pixels];
assert.deepEqual(litPixels, initialPixels, 'the authored brightness restores the initial cached pixels');
input.tick(30);
assert.equal(syncCalls, 3, 'unchanged steady brightness does not trigger a redundant upload');

await input.frob(lightSwitch); // Off: the original Tick body writes brightness zero.
input.tick(1);
assert.equal(syncCalls, 4, 'script Tick callback reaches world.updateLighting after the off write');
assert.deepEqual([...pixelObject.pixels], darkPixels, 'the off write returns the same cached pixels to dark');

game.reset();
assert.equal(syncCalls, 5, 'game reset performs one steady-light brightness resync');
assert.deepEqual([...pixelObject.pixels], initialPixels, 'reset restores the authored brightness contribution');
world.dispose();
console.log(`Play light-cache bridge validated: ${changes.length} atlas syncs, one cached object retained across off/on/reset.`);
