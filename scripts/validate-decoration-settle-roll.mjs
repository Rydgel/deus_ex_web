/** End-to-end decoration physics in the live Play host: the training Plant7
 * settles from its map-load PHYS_Falling onto the floor (physFalling ->
 * DeusExDecoration.Landed -> setPhysics(PHYS_None)), and a subsequent player Bump
 * then takes the settled-decoration branch (Velocity.Z zeroed, SetPhysics(PHYS_Rolling))
 * and physically slides the plant along the floor (physRolling). This guards the
 * whole chain wired in src/runtime/decoration-physics.mjs + script-doors.mjs, which
 * the bytecode-level checks (validate-native-falling / -landing / -rolling /
 * -move-query, validate-plant-push) cover only in isolation. Requires the local
 * game install. Model: docs/script-plant-contact.md, docs/rolling.md. */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { createGame } from '../src/viewer/game.mjs';
import { gameDirectory } from './game-directory.mjs';

const PHYS_FALLING = 2, PHYS_NONE = 0, PHYS_ROLLING = 7;

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
const plant = runtime.levelFor(player).actors.find(actor => actor?.name === 'Plant7');
assert.ok(plant, '00_Training must contain Plant7');
assert.equal(runtime.instance(plant).cls.record.name, 'Plant2');
const ref = (actor, name) => runtime.namedReference(actor, name);
const num = value => (Array.isArray(value) ? value.map(Number) : Number(value));

// 1. Map load: the Plant2 default Physics is PHYS_Falling and it is not yet settled.
assert.equal(num(ref(plant, 'Physics').get()), PHYS_FALLING, 'Plant7 loads as PHYS_Falling');
const loadLocation = num(ref(plant, 'Location').get());

// 2. Settle: the decoration physics phase advances physFalling each tick. A plant
// resting on the floor lands within a tick, so setPhysics(PHYS_None) rebases it and
// zeroes its velocity. Tick a fixed budget and assert it has settled.
for (let i = 0; i < 30; i++) game.doors.tick(1 / 60);
assert.equal(num(ref(plant, 'Physics').get()), PHYS_NONE, 'Plant7 settles to PHYS_None on its floor');
assert.deepEqual(num(ref(plant, 'Velocity').get()), [0, 0, 0], 'settling zeroes the velocity');
assert.ok(ref(plant, 'Base').get(), 'settling bases the plant on the floor actor');
const settledLocation = num(ref(plant, 'Location').get());
assert.ok(Math.hypot(settledLocation[0] - loadLocation[0], settledLocation[1] - loadLocation[1]) < 1,
  'a plant already on the floor does not drift horizontally while settling');

// 3. Push the settled plant. Because it is now PHYS_None (not PHYS_Falling), the
// Bump body zeroes Velocity.Z and calls SetPhysics(PHYS_Rolling).
const pushVelocity = [180, -40, 22];
game.player.position = [settledLocation[0] + 10, settledLocation[1], settledLocation[2]];
game.player.velocity = [...pushVelocity];
assert.deepEqual(num(ref(player, 'Velocity').get()), pushVelocity, 'live pawn velocity reaches the runtime');
game.collision.doorCallbacks.dispatch(plant, 'Bump', [player]);

assert.equal(num(ref(plant, 'Physics').get()), PHYS_ROLLING, 'a settled-plant Bump selects the SetPhysics(PHYS_Rolling) branch');
const bumped = num(ref(plant, 'Velocity').get());
assert.deepEqual([bumped[0], bumped[1]], [pushVelocity[0], pushVelocity[1]], 'the push copies the horizontal player velocity');
assert.equal(bumped[2], 0, 'the non-falling Bump branch zeroes Velocity.Z');

// 4. Roll: physRolling now advances the plant along the floor each tick.
const beforeRoll = num(ref(plant, 'Location').get());
for (let i = 0; i < 10; i++) game.doors.tick(1 / 60);
const afterRoll = num(ref(plant, 'Location').get());
const horizontal = Math.hypot(afterRoll[0] - beforeRoll[0], afterRoll[1] - beforeRoll[1]);
assert.ok(horizontal > 1, `the rolling plant physically moves along the floor (moved ${horizontal.toFixed(2)} units)`);
assert.ok(Math.abs(afterRoll[2] - beforeRoll[2]) < 1, 'the rolling plant stays on its floor (no vertical drift)');
assert.equal(num(ref(plant, 'Physics').get()), PHYS_ROLLING, 'the plant is still rolling');

console.log(`Decoration settle->roll validated in the Play host: Plant7 settles PHYS_Falling->PHYS_None on its floor, ` +
  `a player Bump then selects SetPhysics(PHYS_Rolling) (Velocity ${JSON.stringify(bumped)}), and physRolling slides it ` +
  `${horizontal.toFixed(2)} units along the floor.`);
