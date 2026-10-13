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
game.collision.queries.changeActor(player, () => {
  game.player.position = [plantLocation[0] + 10, plantLocation[1], plantLocation[2]];
});
game.player.velocity = [120, -30, 18];
assert.deepEqual(ref(player, 'Velocity').get(), [120, -30, 18], 'live pawn velocity reaches the runtime');
// AIStartEvent (714) reaches the level's AI event manager (script-vm-aievent.mjs, docs/ai-event-manager.md); record its calls.
const aiEvents = runtime.scriptVm.aiEvents, aiStarts = [], aiStart = aiEvents.start.bind(aiEvents);
aiEvents.start = (sender, event, ...rest) => { aiStarts.push({ sender: sender?.name, event: String(event) }); return aiStart(sender, event, ...rest); };
// XLevel->Engine->Audio is Galaxy's subsystem; record its StopSoundId calls.
const audio = runtime.levelFor(plant).engine.audio, stops = [], stopSoundId = audio.stopSoundId;
audio.stopSoundId = id => { stops.push(id); return stopSoundId(id); };

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

// The push sound is the original PlaySound(PushSound, SLOT_Misc,,, 128): its
// channel id comes from Plant7's measured index. The AI loud-noise event
// starts on the event manager.
const pushId = ref(plant, 'pushSoundId').get();
assert.equal(pushId, (runtime.measuredObjectIndex(plant) << 4) + (1 << 1), 'pushSoundId is execPlaySound\'s channel id');
assert.ok(aiStarts.some(call => call.sender === 'Plant7' && /^LoudNoise$/i.test(call.event)), `AI loud-noise started: ${JSON.stringify(aiStarts)}`);

// The SetTimer(0.2) push-sound lifetime clears bPushSoundPlaying once the
// one-shot Timer fires (DeusExDecoration.Timer -> StopSound/AIEndEvent). The
// falling plant's own MoveActor then hits the overlapping JC, and that Bump
// runs DeusExDecoration.Bump again: SetTimer(0.2) restarts the lifetime. Live
// decoration physics delivers these callbacks, so the Timer clears 0.2 s after
// the last Bump rather than the manual one.
const levelInfo = game.collision.queries.levelInfo;
const seconds = () => runtime.readNamed(levelInfo, 'TimeSeconds');
const bumpTimes = [], processEvent = runtime.processEvent;
runtime.processEvent = function (actor, name, ...rest) {
  if (actor === plant && String(name).toLowerCase() === 'bump') bumpTimes.push(seconds());
  return processEvent.call(this, actor, name, ...rest);
};
game.tick(0.1, {});
assert.equal(ref(plant, 'bPushSoundPlaying').get(), true, 'still playing before 0.2s');
let clearedAt = null;
for (let frame = 0; frame < 20 && clearedAt === null; frame++) {
  game.tick(0.05, {});
  if (!ref(plant, 'bPushSoundPlaying').get()) clearedAt = seconds();
}
runtime.processEvent = processEvent;
assert.ok(bumpTimes.length > 0, 'the falling plant re-bumps the overlapping JC through live physics');
assert.ok(clearedAt !== null, 'Timer cleared the push sound');
const lifetime = clearedAt - bumpTimes.at(-1);
assert.ok(lifetime >= 0.2 - 1e-6 && lifetime <= 0.25 + 1e-6,
  `Timer cleared the push sound 0.2s after the last Bump (lifetime ${lifetime})`);
assert.ok(stops.includes(pushId), `Timer's StopSound(pushSoundId) reached Galaxy StopSoundId: ${stops}`);
assert.ok(!runtime.audio.galaxy.state.channels.some(channel => ((channel.id ^ pushId) & ~1) === 0), 'the push channel stopped');

console.log(`Plant push validated in the Play host: Plant7.Bump runs the real DeusExDecoration.Bump ` +
  `(velocity ${JSON.stringify(ref(plant, 'Velocity').get())}, Instigator JC, push sound on Galaxy, AI loud-noise started), ` +
  `and its SetTimer(0.2) lifetime clears bPushSoundPlaying. No scene-adapter pause.`);
