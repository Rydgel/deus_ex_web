/** Runtime spawns' sounds reach Galaxy with a channel id formed from the original's slot model
 * (docs/object-index-captures.md "Runtime spawns").
 *
 * An actor spawned at run time has no entry in the live capture: its GObjObjects slot is whatever AddObject gave it
 * (the last freed slot, else Num), so `execPlaySound`'s `(Index << 4) + (Slot << 1) + bNoOverride` needs that slot. Play's
 * registry model (original-object-index.mjs) starts from the map's measured registry (map-registry-seeds.mjs: Training's
 * Num 42167 and its one freed slot 42156) when the boot is over and continues by the same rule. Before it, such an
 * emitter's PlaySound stayed the recorded boundary (channel id 0, nothing audible).
 *
 * Training, headless: the player stands by CrateBreakableMedGeneral1 and the crate takes damage past its HitPoints
 * (DeusExDecoration.TakeDamage -> Destroyed -> Frag.Spawn x6 and the Containers contents). Then
 *  - the six WoodFragments and the Lockpick each hold a slot of the model above the capture's Num, one slot each, in
 *    spawn order (the AddObject rule), and no live object shares it with another;
 *  - their sounds (HitWall's ImpactSound/MiscSound, the Lockpick's landing) reach Galaxy's PlaySound with
 *    id = (slot << 4) + (Slot << 1) + bNoOverride of THAT emitter, the same id for the same emitter;
 *  - none of them is a recorded boundary any more (no `FragmentSound`/`PickupLandedSound` audio effect);
 *  - the model is the registry's: the fragments' slots are the next ones its free list gives. */
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {gameDirectory} from './game-directory.mjs';
import {createPlayerInputFixture} from './player-input-fixture.mjs';

let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-spawn-sound-index: no installed game data'); process.exit(0); }
const files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`))
    files.push({path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`)});
const assets = new AssetStore(files), asset = await assets.get('00_Training');
const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor, level = runtime.levelFor(player);
const input = createPlayerInputFixture(game);
const get = (object, name) => runtime.namedReference(object, name).get();
const audio = level.engine.audio, playSound = audio.playSound, calls = [];
audio.playSound = (actor, id, sound, ...rest) => { const result = playSound(actor, id, sound, ...rest); calls.push({actor, id, sound, result}); return result; };

const model = runtime.actorLifecycle.construction.registry.original;
assert.ok(model, 'the slot model is seeded when the boot is over');
assert.match(model.source, /00_Training/);
assert.ok(model.count >= 42167, `the model starts at Training's captured Num: ${model.count}`);
input.tick(30);

const crate = level.actors.find(actor => actor?.name === 'CrateBreakableMedGeneral1');
const at = get(crate, 'Location');
input.place([at[0], at[1] + 64, -128 + 43 + 0.2]);
input.tick(2);
const before = model.snapshot();
const hitPoints = get(crate, 'HitPoints');
runtime.processEvent(crate, 'TakeDamage', [hitPoints + 1, player, at, [0, 0, 0], 'Shot']);
input.tick(90);

const isKind = (actor, key) => runtime.instance(actor).cls.record.key === key;
const spawned = key => level.actors.filter(actor => actor && isKind(actor, key));
const fragments = spawned('deusex.woodfragment'), lockpick = spawned('deusex.lockpick').find(actor => runtime.instance(actor).nativeObject);
assert.equal(fragments.length, 6, 'the crate leaves six wood fragments');
assert.ok(lockpick, 'and its Lockpick contents');
const slotOf = actor => runtime.instance(actor).nativeObject.originalIndex;
for (const actor of [...fragments, lockpick]) {
  assert.ok(Number.isInteger(slotOf(actor)) && slotOf(actor) >= 42167, `${actor.name} holds a slot of the model above the capture's Num: ${slotOf(actor)}`);
  assert.deepEqual(runtime.soundObjectIndex(actor), {index: slotOf(actor), source: 'modeled'});
  assert.equal(runtime.measuredObjectIndex(actor), null, 'a measured index is only ever the capture\'s');
}
const byCreation = [...fragments].sort((a, b) => Number(a.name.replace(/\D+/g, '')) - Number(b.name.replace(/\D+/g, '')));
byCreation.forEach((actor, i) => { if (i) assert.equal(slotOf(actor), slotOf(byCreation[i - 1]) + 1, 'consecutive spawns take consecutive slots (AddObject appends)'); });
assert.ok(slotOf(byCreation[0]) >= before.count - 1, 'the spawns took slots the model had not given out');
// no two live objects share a slot, measured or modeled
const used = new Map();
for (const actor of level.actors) {
  if (!actor) continue;
  const found = runtime.soundObjectIndex(actor);
  if (!found) continue;
  assert.ok(!used.has(found.index), `${actor.name} and ${used.get(found.index)} share slot ${found.index}`);
  used.set(found.index, actor.name);
}

// their sounds reach Galaxy with the id of their own slot, and nothing about them stays a recorded boundary
const mine = calls.filter(call => call.actor && [...fragments, lockpick].includes(call.actor));
assert.ok(mine.length >= 8, `the fragments' and the Lockpick's sounds reach Galaxy: ${mine.length}`);
for (const call of mine) {
  assert.equal(call.id >> 4, slotOf(call.actor), `${call.actor.name}'s channel id carries its own slot`);
  assert.equal(call.id & 1, 0, 'bNoOverride clear');
  assert.equal((call.id >> 1) & 7, 0, 'SLOT_None');
  assert.equal(call.result, true, 'a free channel took it');
}
for (const actor of [...fragments, lockpick]) {
  const ids = new Set(mine.filter(call => call.actor === actor).map(call => call.id));
  assert.ok(ids.size <= 1, `${actor.name}: one channel id for one emitter`);
}
const names = new Set(mine.map(call => String(call.sound?.key ?? call.sound?.name).split('.').pop().toLowerCase()));
assert.ok(['woodhit1', 'woodhit2'].some(name => names.has(name)), `HitWall's wood sounds: ${[...names]}`);
const deferred = [...game.player.unimplementedPhysicsEffects].filter(effect => /audio/.test(effect));
assert.deepEqual(deferred, [], 'no emitter with a modeled slot is a recorded audio boundary');
assert.ok(runtime.audio.modeledIds.get('WoodFragment') >= 6 && runtime.audio.modeledIds.get('Lockpick') >= 1, 'the audio reports which classes played with a modeled id');
// the model is the registry's own: its count covers every slot handed out
assert.ok(model.count > before.count && [...fragments, lockpick].every(actor => slotOf(actor) < model.count));
console.log(`spawn sound ids: ${fragments.length} fragments (slots ${slotOf(byCreation[0])}..${slotOf(byCreation[5])}) and the Lockpick (${slotOf(lockpick)}), ` +
  `${mine.length} Galaxy PlaySound calls carrying their own slots; ${runtime.audio.modeledIds.size} modeled classes`);
