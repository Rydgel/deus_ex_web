/** Validate the source-backed standalone player subsystem startup used by Play.
 *
 * The fixture is the real 00_Training map and installed GOTY packages. The
 * browser player is attached to LevelInfo, then the original
 * DeusExPlayer.InitializeSubSystems bytecode runs through
 * CreateAugmentations/AddDefaultAugmentations/CreateSkills and CreateKeyRing.
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { createGame } from '../src/viewer/game.mjs';
import { PLAYER_AUGMENTATION_STARTUP } from '../src/runtime/script-player-startup.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory();
const files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music']) {
  for (const name of await readdir(`${root}/${directory}`)) {
    const path = `${directory}/${name}`;
    files.push({ path, read: () => readFile(`${root}/${path}`) });
  }
}

const assets = new AssetStore(files);
const mapAsset = await assets.get('00_Training');
const game = await createGame(decodeMap(mapAsset.bytes), mapAsset, assets, { randomSeed: 1 });
const startup = game.doors.scriptRuntime.playerStartup;
const runtime = game.doors.scriptRuntime.runtime;
const player = game.player.collisionActor;
const ref = (object, name) => runtime.namedReference(object, name).get();
const manager = ref(player, 'AugmentationSystem');

assert.ok(startup, 'Play must expose the player startup result');
assert.ok(manager, 'InitializeSubSystems must create AugmentationSystem');
assert.equal(manager.name, 'AugmentationManager1');
assert.equal(ref(manager, 'Name'), 'AugmentationManager1');
assert.equal(ref(manager, 'Owner'), player);
assert.equal(ref(manager, 'Player'), player);
assert.deepEqual(startup.classKeys, PLAYER_AUGMENTATION_STARTUP.classes);
assert.deepEqual(
  [manager, ...startup.augmentations].map(object => object.name),
  PLAYER_AUGMENTATION_STARTUP.defaultObjectNames,
  'Spawned subsystem identities retain the canonical native FName spelling',
);
assert.deepEqual(
  [manager, ...startup.augmentations].map(object => ref(object, 'Name')),
  PLAYER_AUGMENTATION_STARTUP.defaultObjectNames,
  'Reflected Name fields retain the canonical native FName spelling',
);

const first = ref(manager, 'FirstAug');
assert.equal(first, startup.augmentations[0]);
const linked = [];
for (let current = first; current; current = ref(current, 'Next')) linked.push(current);
assert.deepEqual(linked, startup.augmentations, 'FirstAug/Next preserve Spawn order and identity');

const lower = value => String(value ?? '').toLowerCase();
const member = (object, name) => {
  const key = Object.keys(object).find(candidate => lower(candidate).endsWith(`.${lower(name)}`));
  assert.ok(key, `missing linked struct member ${name}`);
  return object[key];
};
const locations = ref(manager, 'AugLocs');
assert.equal(locations.length, PLAYER_AUGMENTATION_STARTUP.locationSlots.length);
for (const [index, slot] of locations.entries()) {
  const expected = PLAYER_AUGMENTATION_STARTUP.locationSlots[index];
  assert.equal(member(slot, 'NumSlots'), expected.numSlots);
  assert.equal(member(slot, 'KeyBase'), expected.keyBase);
  assert.equal(member(slot, 'AugCount'), index === 6 ? 3 : expected.augCount);
}

for (const [index, augmentation] of startup.augmentations.entries()) {
  const key = startup.classKeys[index];
  assert.equal(ref(augmentation, 'Owner'), manager, `${key} Owner`);
  assert.equal(ref(augmentation, 'Player'), player, `${key} Player`);
  assert.equal(ref(augmentation, 'bHasIt'), PLAYER_AUGMENTATION_STARTUP.defaults.includes(key), `${key} ownership`);
  assert.equal(ref(augmentation, 'bIsActive'), key === 'deusex.augiff' || key === 'deusex.augdatalink', `${key} active state`);
}

const enviro = startup.augmentations.find(object => object.name === 'AugEnviro1');
const getAugLevelValue = runtime.lookup(manager, 'GetAugLevelValue');
assert.equal(runtime.callFunction(getAugLevelValue, manager, 1, () => runtime.instance(enviro).cls.record), -1,
  'unowned AugEnviro returns the original -1 sentinel');

assert.equal(startup.boundary, null);
const keyRing = ref(player, 'KeyRing');
assert.equal(runtime.instance(keyRing).cls.record.key, 'deusex.nanokeyring');
assert.equal(ref(keyRing, 'Owner'), player);
assert.equal(ref(player, 'KeyList'), null, 'a fresh ring holds no keys');

console.log('Player augmentation startup passed: 00_Training creates AugmentationManager1, preserves the capture-backed 21-class linked list and defaults, and spawns the NanoKeyRing.');
