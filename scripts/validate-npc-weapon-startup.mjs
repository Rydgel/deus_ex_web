/** Real Training Play integration for the recovered armed-NPC inventory
 * startup: UNATCOTroop0/1/3 and JosephManderley0 run
 * ScriptedPawn.InitializeInventory through original bytecode on their first
 * ProcessState tick, spawn their weapon/ammo/knife through the recovered
 * ULevel::SpawnActor, attach them (GiveTo -> AddInventory -> SetBase), fall,
 * land with StandingCount 3 and tick their items.  Player reset destroys the
 * spawned actors through the recovered ULevel::DestroyActor — no leaked
 * Level.Actors slots, no duplicates on the next run.
 *
 * UNATCOTroop2 is unarmed but receives a NanoKey from the authored
 * PickupDistributor's original PostPostBeginPlay before the first tick.
 *
 * Evidence: docs/script-npc-weapon-startup.md; the asserted values are the
 * original class defaults merged with the map overrides recorded there.
 */
import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {Reader} from '../src/unreal/package.mjs';
import {readObject,nameAt} from '../src/unreal/objects.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {actorRenderFeedback} from '../src/viewer/actor-render-feedback.mjs';
import {gameDirectory} from './game-directory.mjs';

const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name))});
const assets = new AssetStore(files), asset = await assets.get('00_Training');
const map = decodeMap(asset.bytes);
// Original PickupDistributor0 export 1633 has exactly one authored struct
// override. SerializeBin member order is ScriptedPawnTag, KeyID, Description,
// SkinColor (PickupDistributor.uc). The SkinColor assignment is commented
// out in the original PostPostBeginPlay; it is not an expected mutation.
const distributor = map.actors.find(actor => actor.name === 'PickupDistributor0');
assert.equal(distributor?.index,1633);
const keyTags = readObject(asset.pkg,asset.bytes,distributor.index).properties.filter(tag=>tag.name==='NanoKeyData');
assert.equal(keyTags.length,1);assert.equal(keyTags[0].arrayIndex,0);
const keyReader = new Reader(keyTags[0].data);
const distributedInput = {tag:nameAt(asset.pkg,keyReader.compact()),keyID:nameAt(asset.pkg,keyReader.compact()),
  description:keyReader.string(asset.pkg.version),skinColor:keyReader.u8()};
assert.equal(keyReader.offset,keyTags[0].data.length);
assert.deepEqual(distributedInput,{tag:'Test_Subject',keyID:'Body_Search_Room',description:'Medical Room',skinColor:0});
assert.deepEqual(map.actors.filter(actor=>actor.values.Tag===distributedInput.tag).map(actor=>actor.name),['UNATCOTroop2']);
const game = await createGame(map, asset, assets, {randomSeed: 1, presentation: true});
const {runtime, npcPawns, npcFailures} = game.doors.scriptRuntime;
const level = runtime.levelFor(game.player.collisionActor);
const get = (actor, name) => runtime.namedReference(actor, name).get();
const clsKey = value => {
  if (value == null) return null;
  if (typeof value === 'string') return value.toLowerCase();
  if (value.record?.key) return value.record.key;
  if (value.key) return value.key;
  if (value.asset && value.index != null) {
    const entry = value.asset.pkg?.exports?.[value.index - 1];
    return entry ? `${value.asset.name}.${entry.path}`.toLowerCase() : null;
  }
  return null;
};
const authored = (cls, field) => {
  const member = runtime.lookupMember(cls, 'fields', field);
  return member ? runtime.defaultValue(cls, member) : undefined;
};
const instance = actor => runtime.instance(actor);
const isInventory = actor => {
  try {
    for (let cls = instance(actor).cls; cls; cls = cls.base)
      if (cls.record.key === 'engine.inventory') return true;
  } catch { /* not a script instance */ }
  return false;
};
const isWeapon = actor => {
  for (let cls = instance(actor).cls; cls; cls = cls.base)
    if (cls.record.key === 'engine.weapon') return true;
  return false;
};
const isAmmo = actor => {
  for (let cls = instance(actor).cls; cls; cls = cls.base)
    if (cls.record.key === 'engine.ammo') return true;
  return false;
};
// The NPC-spawned inventory actors are the ones that came through the
// recovered SpawnActor path — the collision view is installed only there.
// Map-serialized pickups (NanoKey0, Multitool0, …) share the ancestry but
// were never spawned at runtime.
const spawnedInventory = () => level.actors.filter(actor => {
  if (!actor || !runtime.collisionViewActors.has(actor)) return false;
  try { if (instance(actor).pendingKill) return false; } catch { return false; }
  return isInventory(actor);
});
const shadowCount = () => level.actors.filter(actor => {
  if (!actor) return false;
  try {
    const entry = instance(actor);
    return entry.cls.record.key === 'deusex.shadow' && !entry.pendingKill;
  } catch { return false; }
}).length;

const EXPECTED = {
  unatcotroop0: {ammo: 'deusex.ammo762mm', weapon: 'deusex.weaponassaultgun', ammoAmount: 360, maxAmmo: 300, reloadCount: 30},
  unatcotroop1: {ammo: 'deusex.ammo762mm', weapon: 'deusex.weaponassaultgun', ammoAmount: 360, maxAmmo: 300, reloadCount: 30},
  unatcotroop3: {ammo: 'deusex.ammo762mm', weapon: 'deusex.weaponassaultgun', ammoAmount: 360, maxAmmo: 300, reloadCount: 30},
  josephmanderley0: {ammo: 'deusex.ammo10mm', weapon: 'deusex.weaponpistol', ammoAmount: 72, maxAmmo: 150, reloadCount: 6},
};
const targets = new Map();
for (const actor of npcPawns) {
  const name = String(actor.name ?? '').toLowerCase();
  if (name in EXPECTED) targets.set(name, actor);
}
assert.equal(targets.size, 4, 'all four armed Training NPCs are scripted pawns');
const keyPawn=npcPawns.find(pawn=>pawn.name==='UNATCOTroop2');
assert.ok(keyPawn,'the authored distributor target is a linked pawn');
const verifyDistributedKey = () => {
  const keys=spawnedInventory().filter(item=>instance(item).cls.record.key==='deusex.nanokey');
  assert.equal(keys.length,1,'PickupDistributor spawned exactly one authored NanoKey');
  const key=keys[0];
  assert.equal(get(key,'Owner'),keyPawn);assert.equal(get(key,'Instigator'),keyPawn);
  assert.equal(get(key,'Base'),keyPawn);assert.equal(get(keyPawn,'Inventory'),key);
  assert.equal(get(key,'Inventory'),null,'unarmed target carries only the distributor key');
  assert.equal(get(key,'KeyID'),distributedInput.keyID);assert.equal(get(key,'Description'),distributedInput.description);
  assert.equal(get(keyPawn,'StandingCount'),1,'original SetBase adds one key rider');
  return key;
};
// This headless fixture continuously observes the four target pawns. Supply
// that visibility input explicitly; the live renderer owns draw feedback.
const rendered = [...targets.values()].map(pawn => actorRenderFeedback(runtime, pawn));

// npcFailures overwrites the entry on each repeated failure; keep the first
// message per actor so the boundary report names the original failure.
const firstFailure = new Map();
const observeFailures = () => {
  for (const [actor, message] of npcFailures)
    if (!firstFailure.has(actor)) firstFailure.set(actor, message);
};

let previousItems = null, resetShadowCount = null;
for (let run = 0; run < 3; run++) {
  if (run) game.reset();
  observeFailures();
  verifyDistributedKey();

  // InitializeInventory runs on the first ProcessState tick, not at load —
  // the serialized Inventory field must still be empty before any tick.
  for (const [name, pawn] of targets) {
    assert.equal(get(pawn, 'Inventory'), null, `${name} carries no inventory before the first tick`);
    assert.equal(get(pawn, 'Weapon'), null, `${name} has no selected weapon before the first tick`);
  }

  for (let i = 0; i < 300; i++) {
    for (const notify of rendered) notify();
    game.tick(1 / 60, {});
    observeFailures();
  }

  const label = run === 0 ? 'load' : `reset ${run}`;
  const items = spawnedInventory();
  const player = game.player.collisionActor;
  const rings = items.filter(item => instance(item).cls.record.key === 'deusex.nanokeyring');
  const distributedKey=verifyDistributedKey();
  const npcItems = items.filter(item => !rings.includes(item)&&item!==distributedKey);
  assert.equal(rings.length, 1, `${label}: CreateKeyRing spawned one NanoKeyRing`);
  assert.equal(get(rings[0], 'Owner'), player, `${label}: the key ring is the player's`);
  assert.equal(npcItems.length, 12, `${label}: exactly the twelve NPC-spawned inventory actors`);
  assert.equal(items.length,14,`${label}: twelve armed-NPC items, one distributor key and one player keyring`);
  assert.equal(new Set(items).size, items.length, `${label}: no duplicate inventory actors`);
  const shadows = shadowCount();
  if (run === 0) {
    // The load run's AttachDecal draws sit wherever the shared stream stood
    // after load; reset() reseeds it (game.mjs random.seed(randomSeed)), so
    // reset runs replay one identical stream.  Only the repeated-run count
    // must be identical — the RNG-dependent AttachDecal failures are the
    // faithful Decal.BeginPlay behavior, not a leak.
    console.log(`run ${run} (${label}): ${items.length} spawned inventory actors, ${shadows} shadows, level.actors=${level.actors.length}`);
  } else {
    if (resetShadowCount === null) resetShadowCount = shadows;
    assert.equal(shadows, resetShadowCount,
      `${label}: reset shadow count is identical across repeated runs (no leaked respawn)`);
    console.log(`run ${run} (${label}): ${items.length} spawned inventory actors, ${shadows} shadows, level.actors=${level.actors.length}`);
  }
  // The previous run's NPC and distributor items were destroyed by the
  // recovered ULevel::DestroyActor path during reset: their Level.Actors slots
  // are clear and the objects are pending kill — never reintroduced. The old
  // player's key ring leaves with its retired Login graph instead (the
  // reload's garbage collection, not DestroyActor).
  if (previousItems) {
    for (const item of previousItems) {
      assert.equal(level.actors.includes(item), false,
        `${item.name}: previous-run item left the live Level.Actors set`);
      if (instance(item).cls.record.key === 'deusex.nanokeyring') continue;
      assert.equal(instance(item).pendingKill, true,
        `${item.name}: previous-run item is pending kill`);
    }
  }
  previousItems = items;

  for (const [name, pawn] of targets) {
    const expected = EXPECTED[name];
    assert.equal(npcFailures.has(pawn), false, `${name}: no startup/tick failure`);
    assert.equal(get(pawn, 'Weapon'), null, `${name}: Weapon stays None`);
    assert.equal(get(pawn, 'Physics'), 1, `${name}: landed in PHYS_Walking`);
    assert.equal(get(pawn, 'StandingCount'), 3, `${name}: three attached inventory riders`);

    // The Inventory chain order is the reverse of the spawn order the
    // original's AddInventory head-insert produces.
    const chain = [];
    for (let item = get(pawn, 'Inventory'); item; item = get(item, 'Inventory')) chain.push(item);
    const expectedOrder = ['deusex.weaponcombatknife', expected.ammo, expected.weapon];
    assert.deepEqual(chain.map(item => instance(item).cls.record.key), expectedOrder,
      `${name}: inventory chain order`);

    const ammoItem = chain[1];
    for (const [index, item] of chain.entries()) {
      const cls = instance(item).cls, key = cls.record.key;
      const where = `${name} ${key}`;
      assert.equal(get(item, 'Owner'), pawn, `${where} Owner`);
      assert.equal(get(item, 'Instigator'), pawn, `${where} Instigator`);
      assert.equal(get(item, 'Base'), pawn, `${where} Base`);
      assert.equal(get(item, 'bHidden'), true, `${where} bHidden`);
      assert.equal(get(item, 'bCarriedItem'), true, `${where} bCarriedItem`);
      assert.equal(get(item, 'bOnlyOwnerSee'), true, `${where} bOnlyOwnerSee`);
      assert.equal(get(item, 'Physics'), 0, `${where} Physics`);
      assert.equal(get(item, 'bCollideActors'), false, `${where} bCollideActors`);
      assert.equal(get(item, 'bBlockActors'), false, `${where} bBlockActors`);
      assert.equal(get(item, 'bBlockPlayers'), false, `${where} bBlockPlayers`);
      assert.equal(get(item, 'bCollideWorld'), false, `${where} bCollideWorld`);
      assert.equal(String(get(item, 'Tag')).toLowerCase(), 'none', `${where} Tag`);
      assert.equal(String(get(item, 'InitialState')).toLowerCase(), 'idle2', `${where} InitialState`);
      assert.ok(instance(item).state?.stateNode?.record?.key?.endsWith('.idle2'),
        `${where} current state is Inventory.Idle2`);
      assert.equal(clsKey(get(item, 'Mesh')), clsKey(authored(cls, 'PlayerViewMesh')),
        `${where} Mesh is the class default PlayerViewMesh`);
      assert.deepEqual(get(item, 'Location'), get(pawn, 'Location'),
        `${where} rides at the pawn's Location`);
      if (isWeapon(item)) {
        assert.equal(get(item, 'Lifespan'), 0, `${where} Lifespan`);
        assert.equal(get(item, 'LockMode'), 0, `${where} LockMode`);
        assert.equal(get(item, 'ReloadCount'), index === 2 ? expected.reloadCount : 0,
          `${where} ReloadCount`);
        assert.equal(authored(cls, 'mpPickupAmmoCount'), authored(cls, 'PickupAmmoCount'),
          `${where} Default.mpPickupAmmoCount was written to PickupAmmoCount`);
        if (index === 2) {
          assert.equal(get(item, 'AmmoType'), ammoItem, `${where} AmmoType is the spawned ammo item`);
          assert.equal(clsKey(get(item, 'AmmoName')), expected.ammo, `${where} AmmoName`);
        } else {
          assert.equal(get(item, 'AmmoType'), null, `${where} knife AmmoType stays None`);
          assert.equal(clsKey(get(item, 'AmmoName')), 'deusex.ammonone', `${where} knife AmmoName`);
        }
      }
      if (isAmmo(item)) {
        assert.equal(get(item, 'AmmoAmount'), expected.ammoAmount, `${where} AmmoAmount`);
        assert.equal(get(item, 'MaxAmmo'), expected.maxAmmo, `${where} MaxAmmo`);
        assert.equal(get(item, 'Mesh'), null, `${where} ammo has no player view mesh`);
      }
    }
  }
}

console.log('\nper-NPC boundary report:');
for (const [name, pawn] of targets)
  console.log(`  ${name}: next boundary: ${firstFailure.get(pawn) ?? npcFailures.get(pawn) ?? 'none'}`);
const other = [...firstFailure.entries()].filter(([actor]) => !targets.has(String(actor.name ?? '').toLowerCase()));
if (other.length) {
  console.log('still-failing unrelated actors (recorded boundaries, not part of this slice):');
  for (const [actor, message] of other)
    console.log(`  ${actor.name ?? actor}: ${message}`);
}
console.log('NPC weapon startup passed: all four armed Training NPCs spawned and attached their inventory through ' +
  'the recovered SpawnActor/GiveTo/SetBase path, landed with StandingCount 3, ticked 300 frames, and reset ' +
  'destroyed every spawned item without Level.Actors leakage.');
