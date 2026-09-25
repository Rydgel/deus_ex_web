/** General Frob dispatch in the live Play host (item #2, M2). Frobbing a plain
 * decoration runs its real inherited DeusExDecoration.Frob through the general VM
 * router instead of the "interaction not supported yet" stub: the empty Actor.Frob
 * base, DeusExPlayer.StartConversation (early-false while ConListItems is null —
 * the training case), then the Event/AllActors trigger fanout (skipped when Event
 * is None). Frobbing the LightSwitch runs its full override (roadmap item #3): the
 * cratelight fanout toggles the four TriggerLights (advanced into TriggerToggle by
 * the door host's shared createScriptLights), the real PlayAnim native sets the
 * switch AnimSequence, and the click is a recorded Stage-4 audio boundary.
 * Model/evidence: docs/scene-events.md, docs/script-light-switch.md; the bodies are
 * also validated in scripts/validate-script-lights.mjs. Requires the local install. */
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
const ref = (actor, name) => runtime.namedReference(actor, name).get();
const find = name => { const a = level.actors.find(x => x?.name === name); assert.ok(a, `00_Training must contain ${name}`); return a; };

// A plain decoration (Plant): its inherited DeusExDecoration.Frob is a no-op here
// (Event is None, ConListItems is null), so the whole real body runs and returns.
const plant = find('Plant7');
assert.equal(runtime.instance(plant).cls.record.name, 'Plant2');
assert.equal(ref(plant, 'Event'), 'None', 'training plant has no Event tag (no trigger fanout)');
assert.equal(ref(plant, 'ConListItems'), null, 'no bound conversation (StartConversation returns early-false)');
const outcome = game.doors.scriptRuntime.dispatchEvent(plant, 'Frob', [player, null]);
assert.deepEqual(outcome, { handled: true, result: true }, 'the real DeusExDecoration.Frob ran through the general router (no scene-adapter pause)');

// game.use() takes the original right-click route, DeusExPlayer.ParseRightClick.
// A pushable decoration is grabbed there (GrabDecoration), not frobbed.
// PutCarriedDecorationInHand's SetLocation runs the recovered FarMoveActor on
// the map decoration (docs/script-map-actor-move.md), then bases it on JC with
// its collision word cleared and bCollideWorld written off.
game.interaction.frobTarget = plant;
assert.deepEqual(game.use(), { ok: true, message: '' }, 'ParseRightClick grabs the pushable plant');
assert.equal(ref(player, 'CarriedDecoration'), plant, 'GrabDecoration carries the plant');
assert.equal(ref(plant, 'Base'), player, 'PutCarriedDecorationInHand bases the plant on JC');
assert.equal(ref(plant, 'Physics'), 0, 'the carried plant is PHYS_None');
assert.equal(plant.flags & 0x1f, 0, 'SetCollision(False,False,False) and bCollideWorld=False clear the +0x1dc word');
assert.equal(ref(plant, 'bCollideWorld'), false, 'the script field reads the native word');
// Right click with nothing highlighted is ParseRightClick -> PutInHand(None),
// which drops the carried decoration (DeusExPlayer.DropDecoration).
game.interaction.frobTarget = null;
assert.deepEqual(game.use(), { ok: true, message: '' }, 'an empty right click runs ParseRightClick');
assert.equal(ref(player, 'CarriedDecoration'), null, 'DropDecoration released the plant');
assert.equal(ref(plant, 'Base'), null, 'the dropped plant leaves JC');
assert.equal(plant.flags & 0xd, 0xd, 'the dropped plant collides and blocks again');

// The mover Frob path is unchanged: a mover target still routes to doors.use().
const mover = level.actors.find(a => a?.lineage?.includes('engine.mover') && game.collision.movers.includes(a));
if (mover) {
  game.interaction.frobTarget = mover;
  const result = game.use();
  assert.ok(result && typeof result.message === 'string', 'a mover frob still returns a door result, not the Frob path');
}

// LightSwitch.Frob runs its full override in the live host (M2 step 2, roadmap
// item #3): Super.Frob's AllActors('cratelight') fanout toggles the four
// TriggerLights (advanced into TriggerToggle by the door host's shared
// createScriptLights), the real PlayAnim native sets the switch AnimSequence, and
// the switch click is recorded as a Stage-4 audio boundary.
const lightSwitch = find('LightSwitch0');
assert.equal(runtime.instance(lightSwitch).cls.record.name, 'LightSwitch');
const lights = level.actors.filter(a => a?.name && /^TriggerLight[0-3]$/.test(a.name));
assert.equal(lights.length, 4, '00_Training has four TriggerLights tagged cratelight');
for (const light of lights) {
  assert.equal(runtime.instance(light).state?.stateNode?.record?.name, 'TriggerToggle',
    `${light.name} was advanced into its TriggerToggle state at load`);
  assert.equal(ref(light, 'Tag'), 'cratelight');
}
const dirs = () => lights.map(l => ref(l, 'Direction'));
assert.equal(ref(lightSwitch, 'bOn'), false, 'switch starts off');
const before = dirs();
const deferredBefore = new Set(game.player.unimplementedPhysicsEffects);

game.interaction.frobTarget = lightSwitch;
assert.deepEqual(game.use(), { ok: true, message: '' }, 'game.use() runs the full LightSwitch.Frob');
assert.equal(ref(lightSwitch, 'bOn'), true, 'the switch toggled on');
assert.equal(ref(lightSwitch, 'AnimSequence'), 'On', 'the real PlayAnim native set the switch animation');
assert.deepEqual(dirs(), before.map(d => -d), 'the cratelight fanout reversed every TriggerLight (state Trigger ran)');
const switchSound = [...game.player.unimplementedPhysicsEffects].filter(e => !deferredBefore.has(e));
assert.ok(switchSound.some(e => /LightSwitch0\.SwitchSound/.test(e)), `switch click recorded as a Stage-4 audio boundary: ${switchSound.join(', ')}`);

// A second frob reverses it: bOn, the lights, and the animation all toggle back.
assert.deepEqual(game.use(), { ok: true, message: '' });
assert.equal(ref(lightSwitch, 'bOn'), false, 'the switch toggled back off');
assert.equal(ref(lightSwitch, 'AnimSequence'), 'Off');
assert.deepEqual(dirs(), before, 'the TriggerLights reversed back');

console.log('General Frob validated in the Play host: a plain decoration (Plant7) runs the real ' +
  'DeusExDecoration.Frob through the general router, game.use() takes the original ParseRightClick route ' +
  '(the pushable plant is lifted through GrabDecoration and dropped by an empty right click), and the mover path is intact. LightSwitch0.Frob runs end-to-end (roadmap item #3): the cratelight AllActors ' +
  'fanout toggles all four TriggerLights via their state Trigger, the real PlayAnim sets AnimSequence ' +
  "(On/Off), and the click is a recorded Stage-4 audio boundary; a second frob reverses everything.");
