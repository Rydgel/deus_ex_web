/** Plant push in the live Play host: a player Bump on the training Plant7 now
 * runs the real inherited DeusExDecoration.Bump through the linked VM instead of
 * pausing at the scene adapter. This exercises the same target-first dispatch
 * player-move uses (game.collision.doorCallbacks.dispatch), so it covers the
 * scene-events route, the door-runtime decoration handler, the recorded
 * sound/AI boundaries, and the push-sound Timer lifetime. Model and evidence:
 * docs/script-plant-contact.md; the bytecode itself is validated in
 * scripts/validate-script-decoration.mjs. Requires the local game install. */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { createGame } from '../src/viewer/game.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory();
const files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`))
    files.push({ path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`) });
const assets = new AssetStore(files);
const mapAsset = await assets.get('00_Training');
const map = decodeMap(mapAsset.bytes);

const game = await createGame(map, mapAsset, assets, { randomSeed: 1 });
const runtime = game.doors.scriptRuntime.runtime;
const player = game.player.collisionActor;
const level = runtime.levelFor(player);
const plant = level.actors.find(actor => actor?.name === 'Plant7');
assert.ok(plant, '00_Training must contain Plant7');
assert.equal(runtime.instance(plant).cls.record.name, 'Plant2');

const ref = (actor, name) => runtime.namedReference(actor, name);
// The class defaults make this the pushing path (docs/script-plant-contact.md).
assert.equal(ref(plant, 'bPushable').get(), true);
assert.equal(ref(plant, 'Physics').get(), 2);          // PHYS_Falling
assert.equal(ref(plant, 'Mass').get(), 50);
assert.equal(ref(plant, 'bPushSoundPlaying').get(), false);
const plantLocation = ref(plant, 'Location').get();
const plantHeight = ref(plant, 'CollisionHeight').get();
assert.ok(plantHeight > 0);

// Place JC in vertical overlap with the plant and give the pawn a live velocity;
// the bump copies Other.Velocity into the decoration.
game.player.position = [plantLocation[0] + 10, plantLocation[1], plantLocation[2]];
game.player.velocity = [120, -30, 18];
assert.deepEqual(ref(player, 'Velocity').get(), [120, -30, 18], 'live pawn velocity reaches the runtime');
const deferredBefore = new Set(game.player.unimplementedPhysicsEffects);

// Dispatch exactly as player-move does: the hit actor's Bump first, player as
// its argument. This must NOT throw "Unsupported original scene event".
const dispatch = game.collision.doorCallbacks.dispatch;
dispatch(plant, 'Bump', [player]);
dispatch(player, 'Bump', [plant]); // reciprocal player Bump is the dry no-op

// The falling plant copies the player's full velocity (Z is not zeroed), stores
// the player as Instigator, and starts its push-sound state.
assert.deepEqual(ref(plant, 'Velocity').get(), [120, -30, 18]);
assert.equal(ref(plant, 'Instigator').get(), player);
assert.equal(ref(plant, 'bPushSoundPlaying').get(), true);
const yaw = ref(plant, 'Rotation').get();
assert.ok(Array.isArray(yaw) && Number.isInteger(yaw[1]), 'a yaw rotation was computed');

// The push sound and AI loud-noise event are recorded deferred boundaries.
const newDeferred = [...game.player.unimplementedPhysicsEffects].filter(effect => !deferredBefore.has(effect));
assert.ok(newDeferred.some(effect => /Plant7\.PushSound/.test(effect)), `push sound recorded: ${newDeferred.join(', ')}`);
assert.ok(newDeferred.some(effect => /Plant7\.AIStartEvent/.test(effect)), `AI loud-noise recorded: ${newDeferred.join(', ')}`);

// The SetTimer(0.2) push-sound lifetime clears bPushSoundPlaying once the
// one-shot Timer fires (DeusExDecoration.Timer -> StopSound/AIEndEvent).
game.doors.tick(0.1);
assert.equal(ref(plant, 'bPushSoundPlaying').get(), true, 'still playing before 0.2s');
game.doors.tick(0.15); // total 0.25s > 0.2s
assert.equal(ref(plant, 'bPushSoundPlaying').get(), false, 'Timer cleared the push sound after 0.2s');
const afterTimer = [...game.player.unimplementedPhysicsEffects].filter(effect => !deferredBefore.has(effect));
assert.ok(afterTimer.some(effect => /Plant7\.StopSound/.test(effect)), 'StopSound recorded by Timer');

console.log(`Plant push validated in the Play host: Plant7.Bump runs the real DeusExDecoration.Bump ` +
  `(velocity ${JSON.stringify(ref(plant, 'Velocity').get())}, Instigator JC, push sound + AI recorded), ` +
  `and its SetTimer(0.2) lifetime clears bPushSoundPlaying. No scene-adapter pause.`);
