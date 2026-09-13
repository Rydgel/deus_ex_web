/** Focused execution of the original 00_Training TriggerLight subset.
 *
 * Use the actual Play actor identities/property bindings. The player subsystem
 * actors are appended after the serialized level actors, so this validator
 * verifies the preserved map prefix instead of the obsolete map-plus-player
 * actor count.
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { createGame } from '../src/viewer/game.mjs';
import { createScriptLights } from '../src/runtime/script-lights.mjs';
import { gameDirectory } from './game-directory.mjs';
import { loadOriginalGObjects } from './original-gobjects.mjs';

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
assert.ok(level.actors.length > map.level.actors.length + 1);
for (const [index, ref] of map.level.actors.entries()) {
  assert.equal(level.actors[index], ref ? await runtime.objects.resolve(mapAsset, ref) : null);
}
assert.equal(level.actors[map.level.actors.length], player);
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

// Execute the actual inherited Frob and AllActors fanout. The recovered
// Training conversation bind leaves this switch without conversation items.
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

// Native PlayAnim (259) against the actual LightSwitch mesh payload. The
// serialized sequence table was recovered by executing the original
// ULodMesh::Serialize (docs/lodmesh-serialization.md); the native contract is
// docs/script-play-anim.md. Sound (264) and the post-startup conversation
// binding remain explicit blockers for running the complete LightSwitch.Frob
// wrapper in Play.
const switchMesh = await runtime.prepareMesh(lightSwitch);
assert.equal(runtime.meshPayload(lightSwitch),switchMesh);
assert.equal(switchMesh.entry.name, 'LightSwitch');
assert.deepEqual(switchMesh.sequences.map(sequence => [sequence.name, sequence.startFrame, sequence.numFrames]), [
  ['All', 0, 2], ['Still', 0, 1], ['Off', 0, 1], ['On', 1, 1],
]);
{
  const before = runtime.namedReference(lightSwitch, 'AnimSequence').get();
  assert.equal(before, 'None');
  runtime.invokeNative({index: 259, receiver: lightSwitch, argumentCount: 1,
    evaluateArgument: () => 'Off'});
  assert.equal(runtime.namedReference(lightSwitch, 'AnimSequence').get(), 'Off');
  assert.equal(runtime.namedReference(lightSwitch, 'AnimFrame').get(), -1);
  assert.equal(runtime.namedReference(lightSwitch, 'AnimRate').get(), 0);
  assert.equal(runtime.namedReference(lightSwitch, 'TweenRate').get(), 10);
  assert.equal(runtime.namedReference(lightSwitch, 'AnimLast').get(), 0);
  const animation = lightSwitch.animationState;
  assert.deepEqual(animation.simAnim, {frame: -10000, rate: 0, tween: 10000, last: 0});
  // The NF==1 path zeroes the +0x224/+0x228 mirrors: linked AnimMinRate and
  // OldAnimRate ("= AnimRate until animation completes").
  assert.equal(runtime.namedReference(lightSwitch, 'AnimMinRate').get(), 0);
  assert.equal(runtime.namedReference(lightSwitch, 'OldAnimRate').get(), 0);
  // Second call: a previous sequence exists, so the TweenTime=-1 collapse no
  // longer applies and NumFrames==1 keeps the TweenRate=10 fallback.
  runtime.invokeNative({index: 259, receiver: lightSwitch, argumentCount: 1,
    evaluateArgument: () => 'On'});
  assert.equal(runtime.namedReference(lightSwitch, 'AnimSequence').get(), 'On');
  assert.equal(runtime.namedReference(lightSwitch, 'TweenRate').get(), 10);
  assert.equal(runtime.namedReference(lightSwitch, 'AnimFrame').get(), -1);
  // The two-frame 'All' sequence exercises the NumFrames!=1 paths. With a
  // previous sequence and TweenTime=-1, the prior mirror (the earlier
  // AnimRate bits, 0) selects the zero-mirror 0.025 tween (0x103e03a8).
  runtime.invokeNative({index: 259, receiver: lightSwitch, argumentCount: 1,
    evaluateArgument: () => 'All'});
  assert.equal(runtime.namedReference(lightSwitch, 'AnimFrame').get(), -2);
  assert.equal(runtime.namedReference(lightSwitch, 'TweenRate').get(), Math.fround(0.05));
  assert.equal(runtime.namedReference(lightSwitch, 'AnimRate').get(), 15);
  // A second 'All' call sees OldAnimRate (the prior AnimRate bits, 15 > 0)
  // and copies its bits into TweenRate, as the original 0x103e0323 branch does.
  runtime.invokeNative({index: 259, receiver: lightSwitch, argumentCount: 1,
    evaluateArgument: () => 'All'});
  assert.equal(runtime.namedReference(lightSwitch, 'AnimFrame').get(), -2);
  assert.equal(runtime.namedReference(lightSwitch, 'TweenRate').get(), 15);
  assert.equal(runtime.namedReference(lightSwitch, 'AnimRate').get(), 15);
}
// The mesh payload cache must return the same decoded identity on repeat calls.
assert.equal(runtime.meshPayload(lightSwitch), switchMesh);

// The global UObject index (Core.dll GObjObjects slot) read from the running
// original game (tools/dump-gobjects-win.c). docs/script-sound.md requires this
// true global identity, not the map export index, to form the PlaySound channel
// id. The live capture also shows the index is the recursive construction order
// during LoadAllObjects, not a contiguous N0 + exportIndex block
// (docs/boot-replay.md).
//
// Plan B generalises Plan A's single measured index: instead of a per-actor
// registerGlobalObjectIndex, install the capture-backed provider once, and
// soundField('ObjectIndex') resolves any pre-placed actor by (class, name).
// Runtime spawns (absent from the load-time capture) continue the recovered
// AddObject rule from the measured registry state
// (scripts/validate-object-index-model.mjs, test/script-object-index.test.mjs).
const gobjects = await loadOriginalGObjects('.cache/original-gobjects.txt');
runtime.setOriginalObjectIndex(gobjects.provider());
// The live game records PlaySound as a mover-sound boundary (script-doors.mjs);
// this focused validation instead runs the real execActorPlaySound native to
// check the channel id, so opt 264 back out of the host boundary now that the
// measured index provider is installed.
runtime.boundaryNatives.delete(264);
const switchGlobalIndex = gobjects.index('LightSwitch', 'LightSwitch0');
// The emitter's ObjectIndex now resolves to the true global registry slot with
// no actor-specific wiring -- the one input the PlaySound channel-id formula
// (validated in test/script-sound.test.mjs) was missing in Play. The formula is
// (Index << 4) + (Slot << 1) + bNoOverride (docs/script-sound.md).
assert.equal(runtime.soundField(lightSwitch, 'ObjectIndex'), switchGlobalIndex);
// A pre-placed neighbour (a TriggerLight) also resolves through the same
// provider, confirming the lookup is general, not switch-specific.
const sampleLight = lights[0];
assert.equal(runtime.soundField(sampleLight, 'ObjectIndex'),
  gobjects.index('TriggerLight', runtime.namedReference(sampleLight, 'Name').get()));

// Native 264 now runs its full listener traversal against the live host graph:
// the emitter's XLevel (ULevel), its Actors(0) LevelInfo and the LevelInfo's
// PawnList. Capture the PlaySound descriptor while the wrapper runs.
const soundCalls = [];
const invokeNative = runtime.invokeNative.bind(runtime);
runtime.invokeNative = call => { const result = invokeNative(call); if (call.index === 264) soundCalls.push(result); return result; };
const switchFrob = await runtime.prepareFunction(deusEx, deusEx.exportsByPath.get('lightswitch.frob'));
runtime.callFunction(switchFrob, lightSwitch, 2, index => index === 0 ? player : null);
runtime.invokeNative = invokeNative;

// LightSwitch.Frob plays Switch4ClickOn on slot 1; the channel id derives from
// the measured global index through (Index << 4) + (Slot << 1) + bNoOverride.
assert.equal(soundCalls.length, 1);
const [play] = soundCalls;
assert.ok(play.resultWritten);
const [playSound, slot, , noOverride] = play.arguments;
assert.equal(playSound.name, 'Switch4ClickOn');
assert.equal(play.result, ((switchGlobalIndex << 4) + (slot << 1) + noOverride) | 0);
assert.equal(play.result, 547874); // (34242 << 4) + (1 << 1) + 0

// The traversal walked the live PawnList; the player (JCDentonMale) sits at its
// spawn, far from the switch, so the original distance gate leaves every listener
// unheard here -- reaching ClientHearSound (audible playback) is Stage 4.
const jc = play.listeners.find(entry => entry.listener?.name === 'JCDentonMale');
assert.ok(jc, 'the player pawn is traversed as a listener');
assert.equal(jc.heard, false);
assert.equal(jc.reason, 'distance');
assert.ok(play.listeners.every(entry => entry.heard === false));

// Past PlaySound, the wrapper runs its own PlayAnim('On').
assert.equal(runtime.namedReference(lightSwitch, 'AnimSequence').get(), 'On');

console.log('Original 00_Training TriggerLight BeginPlay -> Actor.SetInitialState -> TriggerToggle.Trigger -> Actor.Tick reversal, byte brightness and corona branches passed.');
console.log('Native PlayAnim (259) against the original LightSwitch LodMesh payload: sequence lookup, animation stores and SimAnim tail passed.');
console.log(`LightSwitch.Frob runs end-to-end: Super.Frob + StartConversation, native 264 PlaySound(Switch4ClickOn) -> channel id ${play.result} from measured global index ${switchGlobalIndex}, live PawnList traversal (${play.listeners.length} listeners, none in range), then PlayAnim('On'). Remaining boundary: ClientHearSound audio playback (Stage 4).`);
