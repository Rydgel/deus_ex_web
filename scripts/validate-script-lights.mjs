/** Focused execution of the original 00_Training TriggerLight subset.
 *
 * Use the actual Play actor identities/property bindings. This does not enable
 * LightSwitch.Frob in Play: animation, audio and post-startup conversation
 * registration remain open. The inherited Decoration.Frob below runs against
 * explicitly verified null conversation storage in this prepared host.
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { createGame } from '../src/viewer/game.mjs';
import { createScriptLights } from '../src/runtime/script-lights.mjs';
import { gameDirectory } from './game-directory.mjs';

function packageFiles(root) {
  return (async () => {
    const files = [];
    for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music']) {
      for (const name of await readdir(`${root}/${directory}`)) {
        files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
      }
    }
    return files;
  })();
}

const root = gameDirectory();
const files = await packageFiles(root);
const assets = new AssetStore(files);
const mapAsset = await assets.get('00_Training');
const map = decodeMap(mapAsset.bytes);
const deusEx = await assets.get('DeusEx');
const game = await createGame(map, mapAsset, assets, {randomSeed: 1});
const runtime = game.doors.scriptRuntime.runtime;
const player = game.player.collisionActor, level = runtime.levelFor(player);
assert.equal(level.actors.length, map.level.actors.length + 1);
for (const [index, ref] of map.level.actors.entries()) {
  assert.equal(level.actors[index], ref ? await runtime.objects.resolve(mapAsset, ref) : null);
}
const mapLightActors = map.actors.filter(actor => /^TriggerLight[0-3]$/i.test(actor.name));
assert.deepEqual(mapLightActors.map(actor => actor.name), ['TriggerLight0', 'TriggerLight1', 'TriggerLight2', 'TriggerLight3']);
assert.deepEqual(mapLightActors.map(actor => actor.index), [111, 113, 114, 110]);
const switchMapActor = map.actors.find(actor => actor.name === 'LightSwitch0');
assert.ok(switchMapActor, '00_Training must contain LightSwitch0');

const lights = mapLightActors.map(actor => level.actors.find(value => value?.index === actor.index));
const lightSwitch = level.actors.find(actor => actor?.index === switchMapActor.index);
assert.equal(runtime.namedReference(lightSwitch, 'Mesh').get().key, 'deusexdeco.lightswitch');
assert.equal(runtime.namedReference(lightSwitch, 'Name').get(), 'LightSwitch0');
assert.equal(runtime.namedReference(lightSwitch, 'Class').get(), runtime.instance(lightSwitch).cls.record);
for (const identity of lights) {
  // TriggerLight's class default is the original zero ChangeTime.  The map
  // therefore reaches the native divide-by-zero/clamp branch in one tick;
  // do not inject a more convenient timing value into the map fixture.
  assert.equal(runtime.namedReference(identity, 'ChangeTime').get(), 0);
}

const controller = await createScriptLights({ runtime, assets, lights });
const initial = controller.reset();
assert.deepEqual(initial.map(item => item.state), ['TriggerToggle', 'TriggerToggle', 'TriggerToggle', 'TriggerToggle']);
assert.deepEqual(initial.map(item => item.tickEnabled), [true, true, true, true]);
assert.deepEqual(initial.map(item => item.triggerEnabled), [true, true, true, true]);
assert.deepEqual(initial.map(item => item.Alpha), [0, 0, 0, 0]);
assert.deepEqual(initial.map(item => item.Direction), [-1, -1, -1, -1]);
assert.deepEqual(initial.map(item => item.LightBrightness), [50, 50, 25, 25]);
assert.deepEqual(initial.map(item => item.InitialBrightness), [50, 50, 25, 25]);
assert.ok(initial.every(item => item.Skin === null));
assert.ok(initial.every(item => item.MultiSkins.every(value => value === null)));

// Execute the actual inherited Frob and AllActors fanout, with the current
// host's null conversation list explicitly checked. This is not evidence that
// native ConBindEvents would leave that list null after full game startup.
const engine = await assets.get('Engine');
await runtime.prepareFunction(engine, engine.exportsByPath.get('actor.frob'));
await runtime.prepareFunction(deusEx, deusEx.exportsByPath.get('deusexplayer.startconversation'));
const frob = await runtime.prepareFunction(deusEx, deusEx.exportsByPath.get('deusexdecoration.frob'));
assert.equal(runtime.namedReference(lightSwitch, 'ConListItems').get(), null);
runtime.callFunction(frob, lightSwitch, 2, index => index === 0 ? player : null);
const opened = lights.map(light => ({snapshot: controller.snapshot(light)}));
assert.ok(opened.every(result => result.snapshot.SavedTrigger === lightSwitch));
assert.deepEqual(opened.map(result => result.snapshot.Direction), [1, 1, 1, 1]);
assert.deepEqual(opened.map(result => result.snapshot.tickEnabled), [true, true, true, true]);

// One AActor.Tick step dispatches Tick first, then ProcessState and Timer.
// With the original ChangeTime=0, Alpha reaches its endpoint and TriggerLight
// disables Tick in that event body.  LightBrightness remains a typed byte.
const lit = controller.tick(1 / 120);
assert.ok(lit.every(result => result.tickEvent));
assert.deepEqual(lit.map(result => result.snapshot.Alpha), [1, 1, 1, 1]);
assert.deepEqual(lit.map(result => result.snapshot.LightBrightness), [50, 50, 25, 25]);
assert.ok(lit.every(result => typeof result.snapshot.LightBrightness === 'number'));
assert.deepEqual(lit.map(result => result.snapshot.tickEnabled), [false, false, false, false]);

// A second Trigger reverses the original state body, re-enables Tick, and a
// second Actor.Tick step reaches the zero-brightness corona branch.
const closed = lights.map(light => controller.trigger(light, lightSwitch, null));
assert.deepEqual(closed.map(result => result.snapshot.Direction), [-1, -1, -1, -1]);
assert.deepEqual(closed.map(result => result.snapshot.tickEnabled), [true, true, true, true]);
const dark = controller.tick(1 / 120);
assert.deepEqual(dark.map(result => result.snapshot.Alpha), [0, 0, 0, 0]);
assert.deepEqual(dark.map(result => result.snapshot.LightBrightness), [0, 0, 0, 0]);
assert.ok(dark.every(result => result.snapshot.Skin === null));
assert.deepEqual(dark.map(result => result.snapshot.tickEnabled), [false, false, false, false]);

// Re-running reset must clear the old state frame before BeginPlay, otherwise
// BeginPlay's Disable('Tick') would leave the previous state's probe result.
const again = controller.reset();
assert.deepEqual(again.map(item => item.Alpha), [0, 0, 0, 0]);
assert.deepEqual(again.map(item => item.Direction), [-1, -1, -1, -1]);
assert.deepEqual(again.map(item => item.LightBrightness), [50, 50, 25, 25]);
assert.ok(again.every(item => item.tickEnabled));

// Keep one controlled nonzero ChangeTime only to exercise the original
// interpolated/interrupt path.  This is still the installed bytecode; the
// training map's authored zero remains covered above and is restored below.
runtime.namedReference(lights[0], 'ChangeTime').set(2);
controller.reset();
controller.trigger(lights[0], lightSwitch, null);
const halfOn = controller.tickActor(lights[0], .5).snapshot;
assert.equal(halfOn.Alpha, .25);
assert.equal(halfOn.LightBrightness, 12); // FloatToByte truncates 12.5.
assert.equal(halfOn.tickEnabled, true);
controller.trigger(lights[0], lightSwitch, null);
const halfOff = controller.tickActor(lights[0], .6).snapshot;
assert.equal(halfOff.Alpha, 0);
assert.equal(halfOff.LightBrightness, 0);
assert.equal(halfOff.tickEnabled, false);
runtime.namedReference(lights[0], 'ChangeTime').set(0);
controller.reset();

console.log('Original 00_Training TriggerLight BeginPlay -> Actor.SetInitialState -> TriggerToggle.Trigger -> Actor.Tick reversal, byte brightness and corona branches passed.');
