/** Validate the admitted DeusEx weapon/ammo construction and the recovered
 * ULevel::SpawnActor startup order for the armed-NPC inventory classes.
 *
 * Three halves:
 *
 *   1. Construction evidence, read back out of the local originals.  The
 *      AWeapon registration, its InternalConstructor thunk chain, the
 *      AActor constructor call and the final vtable store in the constructor
 *      body, and the vtable slots SpawnActor dispatches through are checked
 *      against Engine.dll bytes; the class identities, export flags,
 *      classFlags and Super references of the Engine.Weapon/Pickup/Ammo and
 *      DeusEx weapon/ammo chains are checked against Engine.u/DeusEx.u.
 *   2. Constructor-family selection on the real linked classes: the
 *      generalized Inventory-ancestry chain resolver must select AWeapon's
 *      ClassConstructor/vtable for the DeusExWeapon leaves and AInventory's
 *      for the DeusExAmmo leaves, the class loader's own recovered
 *      UStruct::Link must reproduce Engine.Weapon's 0x504 PropertiesSize,
 *      the DataVaultImage-only image route must stay closed to weapons, and
 *      a different native Inventory subclass must be refused explicitly.
 *   3. The live startup: one WeaponAssaultGun and one Ammo762mm spawned into
 *      the real Play world through runtime.spawnActor, with the level
 *      collision hash and the script dispatch instrumented so the recovered
 *      lifecycle order is observed rather than inferred from end state.
 *
 * Evidence:
 *   Engine.dll 0x1035f110            AWeapon registration
 *   Engine.dll 0x10302ef5/0x10342a70/0x10303fb7  InternalConstructor thunks
 *   Engine.dll 0x10342a90            AWeapon::AWeapon body
 *   Engine.dll 0x10342aad            call ??0AActor@@QAE@XZ (0x10303431)
 *   Engine.dll 0x10342b43            final vtable store 0x104287a4
 *   .cache/research/DeusExWeapon.uc:304-311  Default.mpPickupAmmoCount write
 *   .cache/research/Weapon.uc:212-230        Weapon.PostBeginPlay/SetWeaponStay
 *   src/runtime/script-inventory-construction.mjs  recorded construction contract
 *   src/runtime/script-spawn.mjs               inventoryConstructorChain/Selection
 *   docs/script-npc-weapon-startup.md          the written route
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';

import {AssetStore} from '../src/unreal/assets.mjs';
import {readClass} from '../src/unreal/classes.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {
  INVENTORY_CONSTRUCTION,
  resolveInheritedInventoryConstructorChain,
} from '../src/runtime/script-inventory-construction.mjs';
import {
  inventoryConstructorChain,
  inventoryImageChain,
  inventorySelection,
} from '../src/runtime/script-spawn.mjs';
import {gameDirectory} from './game-directory.mjs';
// This validator records original call order by replacing the runtime's
// callFunction/executeScript/invokeNative hooks. The Rust interpreter
// (the default engine) runs calls and natives such as IsA without those
// JavaScript entry points, so the trace is taken on the JavaScript VM; Rust's
// equivalence is checked by validate-script-vm-interp and SCRIPT_VM_CHECK.
process.env.SCRIPT_VM = 'js';

const root = gameDirectory();
const {engineInventory, engineWeapon, nativeRoots} = INVENTORY_CONSTRUCTION;

// ---------------------------------------------------------------------------
// 1. Native construction evidence
// ---------------------------------------------------------------------------

const engineBytes = new Uint8Array(await readFile(path.join(root, 'System', 'Engine.dll')));
assert.equal(createHash('sha256').update(engineBytes).digest('hex'),
  INVENTORY_CONSTRUCTION.binaries.engine.sha256, 'local Engine.dll is the recorded GOTY build');

// Engine.dll maps file offset == RVA - image base across .text and .rdata here,
// which the AInventory evidence in validate-inventory-spawn.mjs already relies
// on.
const view = new DataView(engineBytes.buffer, engineBytes.byteOffset, engineBytes.byteLength);
const fileOffset = rva => rva - engineWeapon.imageBase;
const u32 = rva => view.getUint32(fileOffset(rva), true);
const expectBytes = (rva, expected, label) =>
  assert.deepEqual([...engineBytes.subarray(fileOffset(rva), fileOffset(rva) + expected.length)],
    expected, label);

// AWeapon registration (0x1035f110): the constructor pointer and raw flags
// are pushed first, then the AInventory parent static class, the 0x504
// instance size and the class's own static class pointer.
expectBytes(engineWeapon.registration,
  [0x56, 0x57, 0x8b, 0x3d, 0xfc, 0x99, 0x59, 0x10, 0x33, 0xc0,
    0x57, 0x68, 0xf5, 0x2e, 0x30, 0x10,
    0x68, 0x04, 0x40, 0x08, 0x04],
  'AWeapon registration constructor and flags');
expectBytes(engineWeapon.registration + 0x37,
  [0x68, 0x70, 0x6f, 0x57, 0x10],
  'AWeapon registration pushes AInventory::PrivateStaticClass');
expectBytes(engineWeapon.registration + 0x40,
  [0x68, 0x04, 0x05, 0x00, 0x00],
  'AWeapon registration pushes the 0x504 instance size');
assert.equal(u32(engineWeapon.registration + 0x0c), engineWeapon.internalConstructor);
assert.equal(u32(engineWeapon.registration + 0x11), engineWeapon.rawRegistrationFlags);
assert.equal(u32(engineWeapon.registration + 0x38), engineWeapon.superStaticClass);
assert.equal(u32(engineWeapon.registration + 0x41), engineWeapon.instanceSize);
assert.equal(u32(engineWeapon.registration + 0x4a), engineWeapon.staticClass);

// The registration's constructor pointer is a jump thunk to the null-this
// guard (0x10342a70), whose own tail jump — through one more thunk
// (0x10303fb7) — reaches the AWeapon constructor body.  Same guarded
// InternalConstructor shape AActor/AInventory use.
function followThunks(rva, maxHops = 8) {
  for (let hop = 0; hop < maxHops && engineBytes[fileOffset(rva)] === 0xe9; hop++)
    rva = rva + 5 + view.getInt32(fileOffset(rva) + 1, true);
  if (engineBytes[fileOffset(rva)] === 0xe9) throw new Error('thunk chain did not terminate');
  return rva;
}
assert.equal(engineBytes[fileOffset(engineWeapon.internalConstructor)], 0xe9,
  'AWeapon InternalConstructor entry is a jmp thunk');
assert.equal(followThunks(engineWeapon.internalConstructor), 0x10342a70,
  'the first thunk reaches the null-this guard');
expectBytes(0x10342a70,
  [0x8b, 0x4c, 0x24, 0x04, 0x85, 0xc9, 0x74, 0x05, 0xe9],
  'AWeapon InternalConstructor null-checks its argument before the ctor jump');
assert.equal(0x10342a78 + 5 + view.getInt32(fileOffset(0x10342a79), true), 0x10303fb7,
  'the guard tail jump reaches the second thunk');
assert.equal(engineBytes[fileOffset(0x10303fb7)], 0xe9, 'the second thunk is a jmp');
assert.equal(followThunks(0x10303fb7), engineWeapon.constructorBody,
  'the second thunk reaches the recovered AWeapon::AWeapon body');

// The ctor body calls ??0AActor@@QAE@XZ at 0x10342aad (the ENoInit/FStringNoInit
// member constructions at +0x320/+0x32c/+0x338/+0x3c8/+0x3d4/+0x3e0/+0x41c/
// +0x428 write no member bytes), then stores the final AWeapon vtable.
assert.equal(engineBytes[fileOffset(0x10342aad)], 0xe8, 'ctor body calls AActor::AActor');
assert.equal(0x10342aad + 5 + view.getInt32(fileOffset(0x10342aae), true),
  engineWeapon.actorConstructorCall, 'the ctor body calls the recovered AActor constructor');
expectBytes(0x10342b43, [0xc7, 0x06, 0xa4, 0x87, 0x42, 0x10], 'final AWeapon vtable store');
assert.equal(u32(0x10342b43 + 2), engineWeapon.vtable);

// AWeapon overrides none of the three slots SpawnActor dispatches through —
// its +0x10/+0x38/+0x74 dwords equal AActor's and AInventory's — so the
// inherited AActor bodies are the ones the startup sequence runs.  +0x0c
// (the vector deleting destructor) is the one slot where all three differ.
const actorVtable = engineWeapon.intermediateVtable;
for (const {slot, thunk, label} of [
  {slot: engineWeapon.processEvent.slot, thunk: engineWeapon.processEvent.thunk, label: 'ProcessEvent'},
  {slot: engineWeapon.initExecution.slot, thunk: engineWeapon.initExecution.thunk, label: 'InitExecution'},
  {slot: engineWeapon.spawned.slot, thunk: engineWeapon.spawned.thunk, label: 'Spawned'},
]) {
  assert.equal(u32(engineWeapon.vtable + slot), thunk, `AWeapon vtable +0x${slot.toString(16)} is ${label}`);
  assert.equal(u32(actorVtable + slot), thunk, `AWeapon inherits AActor's ${label} slot unchanged`);
  assert.equal(u32(engineInventory.vtable + slot), thunk,
    `AWeapon shares AInventory's ${label} slot`);
}
assert.equal(u32(engineWeapon.vtable + 0x0c), 0x10303c74, 'AWeapon destructor slot');
assert.equal(u32(engineInventory.vtable + 0x0c), 0x103016ea, 'AInventory destructor slot differs');
assert.equal(u32(actorVtable + 0x0c), 0x10301479, 'AActor destructor slot differs');

// ---------------------------------------------------------------------------
// 2. Package class evidence
// ---------------------------------------------------------------------------

const systemFiles = [];
for (const directory of ['System', 'Maps']) {
  for (const name of await readdir(path.join(root, directory))) {
    systemFiles.push({path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name))});
  }
}
const systemAssets = new AssetStore(systemFiles);
const deusExAsset = await systemAssets.get('DeusEx');
const engineAsset = await systemAssets.get('Engine');
assert.equal(createHash('sha256').update(await readFile(path.join(root, 'System', 'DeusEx.u'))).digest('hex'),
  INVENTORY_CONSTRUCTION.binaries.deusEx.sha256, 'local DeusEx.u is the recorded GOTY package');

function classRecord(asset, classPath) {
  const index = asset.exportsByPath.get(classPath.toLowerCase());
  assert.ok(index, `missing original class ${asset.name}.${classPath}`);
  return {index, metadata: readClass(asset, index)};
}

// `metadata.base` is a same-package 1-based export index or a negative import
// index; import entries carry their full `Package.Object` path.
function expectClass(asset, classPath, {index: expectedIndex, flags, classFlags, super: superRef, superPath}) {
  const {index, metadata} = classRecord(asset, classPath);
  assert.equal(index, expectedIndex, `${asset.name}.${classPath} export index`);
  assert.equal(metadata.entry.flags, flags, `${asset.name}.${classPath} export flags`);
  assert.equal(metadata.classFlags, classFlags, `${asset.name}.${classPath} serialized classFlags`);
  if (superRef != null) assert.equal(metadata.base, superRef, `${asset.name}.${classPath} Super`);
  if (superPath != null) {
    assert.ok(metadata.base < 0, `${asset.name}.${classPath} Super is an import reference`);
    assert.equal(asset.pkg.imports[-metadata.base - 1].path, superPath,
      `${asset.name}.${classPath} Super import resolves to ${superPath}`);
  }
  return {index, metadata};
}

// Engine side: Weapon is the second admitted native root; Pickup and Ammo are
// script-only (entry flags 0xf0004, no RF_Native 0x04000000) so an ammo
// chain's first native class is Engine.Inventory.
expectClass(engineAsset, 'Weapon', {index: 9, flags: 0x040f0004, classFlags: 0x33, super: 6});
expectClass(engineAsset, 'Pickup', {index: 606, flags: 0xf0004, classFlags: 0x33, super: 6});
expectClass(engineAsset, 'Ammo', {index: 31, flags: 0xf0004, classFlags: 0x33, super: 606});
assert.equal(engineAsset.exportsByPath.get('inventory'), 6, 'Engine.Weapon Super is Engine.Inventory');
assert.equal(engineAsset.exportsByPath.get('pickup'), 606, 'Engine.Ammo Super is Engine.Pickup');

// DeusEx side: the weapon leaves hang off DeusExWeapon (Super import
// Engine.Weapon); the ammo leaves off DeusExAmmo (Super import Engine.Ammo).
expectClass(deusExAsset, 'DeusExWeapon', {index: 4, flags: 0xf0004, classFlags: 0x37, superPath: 'Engine.Weapon'});
expectClass(deusExAsset, 'WeaponAssaultGun', {index: 1103, flags: 0xf0004, classFlags: 0x36, super: 4});
expectClass(deusExAsset, 'WeaponPistol', {index: 1000, flags: 0xf0004, classFlags: 0x36, super: 4});
expectClass(deusExAsset, 'WeaponCombatKnife', {index: 1794, flags: 0xf0004, classFlags: 0x36, super: 4});
expectClass(deusExAsset, 'DeusExAmmo', {index: 56, flags: 0xf0004, classFlags: 0x33, superPath: 'Engine.Ammo'});
expectClass(deusExAsset, 'Ammo762mm', {index: 621, flags: 0xf0004, classFlags: 0x32, super: 56});
expectClass(deusExAsset, 'Ammo10mm', {index: 841, flags: 0xf0004, classFlags: 0x32, super: 56});
expectClass(deusExAsset, 'AmmoNone', {index: 629, flags: 0xf0004, classFlags: 0x32, super: 56});

// ---------------------------------------------------------------------------
// 3. Constructor-family selection on the real linked classes
// ---------------------------------------------------------------------------

// The live runtime runs the recovered native class loader, whose own
// UStruct::Link stores the class's linked PropertiesSize at +0x3c — the same
// slot SpawnActor's constructor selection reads back.
const playFiles = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music']) {
  for (const name of await readdir(path.join(root, directory))) {
    playFiles.push({path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name))});
  }
}
const assets = new AssetStore(playFiles);
const mapAsset = await assets.get('00_Training');
const game = await createGame(decodeMap(mapAsset.bytes), mapAsset, assets, {randomSeed: 1});
const runtime = game.doors.scriptRuntime.runtime;
const level = runtime.levelFor(game.player.collisionActor);
const deusEx = await assets.get('DeusEx');
const engine = await assets.get('Engine');
const get = (object, field) => runtime.namedReference(object, field).get();
const classOf = (asset, classPath) => runtime.loadClass(asset, asset.exportsByPath.get(classPath.toLowerCase()));

const assaultGunClass = await classOf(deusEx, 'WeaponAssaultGun');
const pistolClass = await classOf(deusEx, 'WeaponPistol');
const knifeClass = await classOf(deusEx, 'WeaponCombatKnife');
const ammo762Class = await classOf(deusEx, 'Ammo762mm');
const ammo10Class = await classOf(deusEx, 'Ammo10mm');
const ammoNoneClass = await classOf(deusEx, 'AmmoNone');
const imageClass = await classOf(deusEx, 'Image02_NYC_Warehouse');
const cameraClass = await classOf(engine, 'CameraPoint');
const inventoryClass = await classOf(engine, 'Inventory');
const weaponBaseClass = await classOf(engine, 'Weapon');
const pickupClass = await classOf(engine, 'Pickup');
const ammoBaseClass = await classOf(engine, 'Ammo');

const linkedSize = cls => cls.loadRecord.nativeSlots.get(0x3c)?.value;
// AWeapon's registration instance size doubles as Engine.Weapon's
// PropertiesSize — the convention AInventory's record already relies on.
// The recovered UStruct::Link the class loader ran must reproduce it.
assert.equal(linkedSize(weaponBaseClass), engineWeapon.instanceSize,
  'the recovered UStruct::Link reproduces Engine.Weapon PropertiesSize 0x504');
assert.equal(linkedSize(inventoryClass), engineInventory.instanceSize,
  'the recovered UStruct::Link reproduces Engine.Inventory PropertiesSize 0x434');
assert.ok(Number.isInteger(linkedSize(pickupClass)) && linkedSize(pickupClass) >= engineInventory.instanceSize,
  'Engine.Pickup links its script fields over Engine.Inventory');
assert.ok(Number.isInteger(linkedSize(ammoBaseClass)) && linkedSize(ammoBaseClass) >= linkedSize(pickupClass),
  'Engine.Ammo links its script fields over Engine.Pickup');

const chainKeys = selected => selected.chain.map(node => node.record.key);

// Weapon leaves inherit AWeapon's ClassConstructor and vtable through
// UClass::Bind's copy-down (DeusExWeapon is script-only).
for (const [cls, leaf] of [[assaultGunClass, 'deusex.weaponassaultgun'],
  [pistolClass, 'deusex.weaponpistol'], [knifeClass, 'deusex.weaponcombatknife']]) {
  const selected = inventoryConstructorChain(cls);
  assert.ok(selected, `${leaf} is admitted by its Weapon ancestry`);
  assert.equal(selected.root, engineWeapon.key);
  assert.deepEqual(chainKeys(selected),
    [leaf, 'deusex.deusexweapon', engineWeapon.key],
    `${leaf} chain descends DeusExWeapon -> Weapon`);
  const selection = inventorySelection(cls);
  assert.equal(selection.classKey, leaf);
  assert.equal(selection.inherited, true);
  assert.equal(selection.constructor, engineWeapon.internalConstructor);
  assert.equal(selection.constructorBody, engineWeapon.constructorBody);
  assert.equal(selection.nativeVtable, engineWeapon.vtable);
  assert.ok(selection.propertiesSize >= engineWeapon.instanceSize,
    `${leaf} linked PropertiesSize covers the AWeapon instance size`);
  assert.equal(linkedSize(cls), selection.propertiesSize,
    `${leaf} selection uses the leaf's real linked PropertiesSize`);
  assert.deepEqual([...selection.bindOrder].slice(-2), [
    'copy weapon ClassConstructor to deusexweapon',
    `copy deusexweapon ClassConstructor to ${leaf.split('.').pop()}`,
  ]);
}

// Ammo leaves inherit AInventory's ClassConstructor — the chain's first
// native class — because Engine.Ammo and Engine.Pickup are script-only.
for (const [cls, leaf] of [[ammo762Class, 'deusex.ammo762mm'], [ammo10Class, 'deusex.ammo10mm']]) {
  const selected = inventoryConstructorChain(cls);
  assert.ok(selected, `${leaf} is admitted by its Inventory ancestry`);
  assert.equal(selected.root, engineInventory.key);
  assert.deepEqual(chainKeys(selected).slice(1), [
    'deusex.deusexammo', 'engine.ammo', 'engine.pickup', engineInventory.key,
  ], `${leaf} chain descends DeusExAmmo -> Ammo -> Pickup -> Inventory`);
  const selection = inventorySelection(cls);
  assert.equal(selection.constructor, engineInventory.internalConstructor);
  assert.equal(selection.nativeVtable, engineInventory.vtable);
  assert.ok(selection.propertiesSize >= engineInventory.instanceSize);
  assert.equal(linkedSize(cls), selection.propertiesSize);
}
assert.equal(inventoryConstructorChain(ammoNoneClass).root, engineInventory.key,
  'AmmoNone is admitted through the same Inventory ancestry');

// The pinned image route stays closed: Image02 is admitted by the image
// chain, a weapon is not, and a non-Inventory native root (CameraPoint)
// returns null rather than inheriting a foreign constructor family.
assert.ok(inventoryImageChain(imageClass), 'Image02 keeps its pinned chain admission');
assert.equal(inventoryImageChain(assaultGunClass), null,
  'the image route does not admit a Weapon subclass');
assert.equal(inventoryConstructorChain(cameraClass), null,
  'a non-Inventory native root is not an Inventory constructor family');

// A chain whose first native class is a different native Inventory subclass
// is a foreign constructor family — never silently rebound to the recovered
// roots.  The probe below the native node is what makes this throw rather
// than return null.
const fakeNativeRoot = {record: {key: 'engine.nativeinventorysubclass', name: 'NativeInventorySubclass'},
  metadata: {entry: {flags: 0x04000000}}, base: inventoryClass};
const fakeLeaf = {record: {key: 'deusex.fakeitem', name: 'FakeItem'},
  metadata: {entry: {flags: 0x000f0004}}, base: fakeNativeRoot};
assert.throws(() => inventoryConstructorChain(fakeLeaf),
  /UClass::Bind native constructor family is not implemented for engine\.nativeinventorysubclass/);

// The chain resolver itself rejects a mismatched root record, a script node
// carrying its own native constructor, or an undersized PropertiesSize.
const weaponRecord = {key: engineWeapon.key,
  nativeConstructor: engineWeapon.internalConstructor, nativeVtable: engineWeapon.vtable};
const leafRecord = {key: 'deusex.weaponassaultgun', name: 'WeaponAssaultGun', nativeConstructor: null};
const deusExWeaponRecord = {key: 'deusex.deusexweapon', name: 'DeusExWeapon', nativeConstructor: null};
const direct = resolveInheritedInventoryConstructorChain(
  [leafRecord, deusExWeaponRecord, weaponRecord], 0x504, nativeRoots['engine.weapon']);
assert.equal(direct.constructor, engineWeapon.internalConstructor);
assert.equal(direct.nativeVtable, engineWeapon.vtable);
assert.throws(() => resolveInheritedInventoryConstructorChain(
  [leafRecord, deusExWeaponRecord, {...weaponRecord, nativeConstructor: 0x1234}], 0x504, nativeRoots['engine.weapon']),
  /ClassConstructor/);
assert.throws(() => resolveInheritedInventoryConstructorChain(
  [{...leafRecord, nativeConstructor: 0x1234}, deusExWeaponRecord, weaponRecord], 0x504, nativeRoots['engine.weapon']),
  /independent native constructor/);
assert.throws(() => resolveInheritedInventoryConstructorChain(
  [leafRecord, deusExWeaponRecord, weaponRecord], 0x500, nativeRoots['engine.weapon']),
  /PropertiesSize/);

// ---------------------------------------------------------------------------
// 4. Authored class defaults the spawn path reads (the doc's table), checked
//    on the pristine linked classes before any tick mutates them
// ---------------------------------------------------------------------------

const classKeyOf = value => {
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
const authored = (cls, field) => runtime.defaultValue(cls, runtime.lookupMember(cls, 'fields', field));

for (const [cls, label, table] of [
  [assaultGunClass, 'WeaponAssaultGun', {
    bCollideActors: true, bBlockActors: true, bCollideWorld: false, Physics: 2,
    CollisionRadius: 15, CollisionHeight: Math.fround(1.1), Mass: 30,
    PickupAmmoCount: 30, ReloadCount: 30, bInstantHit: true, mpPickupAmmoCount: 0,
  }],
  [pistolClass, 'WeaponPistol', {
    Physics: 2, CollisionRadius: 7, CollisionHeight: 1, Mass: 10,
    PickupAmmoCount: 6, ReloadCount: 6, mpPickupAmmoCount: 0,
  }],
  [knifeClass, 'WeaponCombatKnife', {
    CollisionRadius: Math.fround(12.65), CollisionHeight: Math.fround(0.8),
    PickupAmmoCount: 0, ReloadCount: 0, bHandToHand: true, mpPickupAmmoCount: 0,
  }],
  [ammo762Class, 'Ammo762mm', {
    bCollideActors: true, bBlockActors: true, Physics: 2,
    CollisionRadius: 6, CollisionHeight: Math.fround(0.75), AmmoAmount: 30, MaxAmmo: 300,
  }],
  [ammo10Class, 'Ammo10mm', {
    CollisionRadius: 8.5, CollisionHeight: Math.fround(3.77), AmmoAmount: 6, MaxAmmo: 150,
  }],
]) {
  for (const [field, expected] of Object.entries(table))
    assert.equal(authored(cls, field), expected, `${label} authored default ${field}`);
}
assert.equal(classKeyOf(authored(assaultGunClass, 'AmmoName')), 'deusex.ammo762mm',
  'WeaponAssaultGun authored AmmoName');
assert.equal(classKeyOf(authored(pistolClass, 'AmmoName')), 'deusex.ammo10mm',
  'WeaponPistol authored AmmoName');
assert.equal(classKeyOf(authored(knifeClass, 'AmmoName')), 'deusex.ammonone',
  'WeaponCombatKnife authored AmmoName');
// The authored PlayerViewMesh values the carried items copy onto Mesh.
assert.equal(classKeyOf(authored(assaultGunClass, 'PlayerViewMesh')), 'deusexitems.assaultgun');
assert.equal(classKeyOf(authored(pistolClass, 'PlayerViewMesh')), 'deusexitems.glock');
assert.equal(classKeyOf(authored(knifeClass, 'PlayerViewMesh')), 'deusexitems.combatknife');
assert.equal(authored(ammo762Class, 'PlayerViewMesh'), null, 'Ammo762mm has no player view mesh');

// ---------------------------------------------------------------------------
// 5. Live ULevel::SpawnActor: one weapon and one ammo through the real Play
//    runtime, lifecycle order observed through instrumentation
// ---------------------------------------------------------------------------

const trace = [];
const hash = level.hash;
const restoreHash = [];
for (const name of ['addActor', 'removeActor', 'actorEncroachmentCheck']) {
  const original = hash[name].bind(hash);
  restoreHash.push([name, Object.hasOwn(hash, name) ? hash[name] : undefined]);
  hash[name] = (...args) => { if (armed) trace.push(`hash:${name}`); return original(...args); };
}
const originalCallFunction = runtime.callFunction.bind(runtime);
const originalInvokeNative = runtime.invokeNative.bind(runtime);
const originalProcessEvent = runtime.processEvent.bind(runtime);
let armed = false;
runtime.callFunction = (record, ...rest) => {
  if (armed) trace.push(`call:${record.key}`);
  return originalCallFunction(record, ...rest);
};
runtime.invokeNative = call => {
  if (armed) trace.push(`native:${call.index}`);
  return originalInvokeNative(call);
};
runtime.processEvent = (receiver, name, ...rest) => {
  if (armed) trace.push(`event:${name}`);
  return originalProcessEvent(receiver, name, ...rest);
};

const actorsBefore = level.actors.length;
armed = true;
const weapon = runtime.spawnActor({
  cls: assaultGunClass.record, level, name: 'None', owner: null,
  instigator: null, location: [0, 0, 0], rotation: [0, 0, 0],
});
armed = false;
assert.ok(weapon, 'original ULevel::SpawnActor admitted WeaponAssaultGun');
assert.equal(level.actors.length - actorsBefore, 1, 'the spawn took exactly one Level.Actors slot');
assert.equal(level.actors.at(-1), weapon, 'the spawned weapon occupies the appended slot');
assert.equal(runtime.instance(weapon).nativeObject.nativeVtable, engineWeapon.vtable,
  'the live weapon was constructed by the recovered AWeapon constructor');

// The recovered startup order for the weapon route, observed live.  Unlike
// the image classes, the authored bCollideActors keeps +0x1dc bit 0x1 set, so
// the pre-startup hash gate (0x103953b7-0x103953cf) registers the actor
// before SetOwner/InitExecution; the fake shrink's SetCollisionSize
// re-registers it during PreBeginPlay; and Pickup.BeginState's
// BecomePickup -> SetCollision re-registers it a third time.
assert.deepEqual(trace, [
  'hash:addActor',
  'event:Spawned',
  'event:PreBeginPlay',
  'call:deusex.deusexweapon.prebeginplay',
  'call:engine.actor.prebeginplay',
  'native:303',
  'native:303',
  'native:283',
  'hash:removeActor',
  'hash:addActor',
  'call:engine.gameinfo.isrelevant',
  'call:engine.mutator.alwayskeep',
  'call:engine.mutator.isrelevant',
  'call:engine.mutator.checkreplacement',
  'native:195',
  'event:BeginPlay',
  'event:PostBeginPlay',
  'call:engine.weapon.postbeginplay',
  'call:engine.inventory.postbeginplay',
  'call:engine.actor.postbeginplay',
  'call:engine.weapon.setweaponstay',
  'hash:actorEncroachmentCheck',
  'event:SetInitialState',
  'native:113',
  'event:BeginState',
  'call:engine.weapon.becomepickup',
  'call:engine.inventory.becomepickup',
  'native:262',
  'hash:removeActor',
  'hash:addActor',
  'call:engine.actor.setdisplayproperties',
  'event:PostPostBeginPlay',
], 'recovered ULevel::SpawnActor startup order for the admitted Weapon chain');
assert.equal(get(weapon, 'bCollideActors'), true, 'BecomePickup SetCollision(true,true,false)');
assert.equal(get(weapon, 'bCollideWorld'), true, 'Pickup.BeginState sets bCollideWorld');
assert.equal(runtime.instance(weapon).state.stateNode?.record?.key, 'engine.inventory.pickup',
  'SetInitialState resolved Inventory.Pickup (Weapon declares no Pickup override)');
assert.equal(weapon.lineage.includes(engineWeapon.key), true,
  'the live weapon lineage carries the recovered native root');

// DeusExWeapon.PreBeginPlay's `Default.mpPickupAmmoCount = Default.PickupAmmoCount`
// is a real class-default write through the VM: the authored 0 became the
// authored PickupAmmoCount.
assert.equal(authored(assaultGunClass, 'mpPickupAmmoCount'), authored(assaultGunClass, 'PickupAmmoCount'),
  'the live spawn ran the recovered class-default write');
assert.equal(authored(assaultGunClass, 'mpPickupAmmoCount'), 30);

const ammoBefore = level.actors.length;
trace.length = 0;
armed = true;
// Spawned away from the weapon above so the live CheckEncroachment reports
// no overlap; an overlap would (correctly) dispatch EncroachingOn/
// EncroachedBy to the blocking actor.
const ammo = runtime.spawnActor({
  cls: ammo762Class.record, level, name: 'None', owner: null,
  instigator: null, location: [-5000, 0, 0], rotation: [0, 0, 0],
});
armed = false;
assert.ok(ammo, 'original ULevel::SpawnActor admitted Ammo762mm');
assert.equal(level.actors.length - ammoBefore, 1, 'the ammo spawn took exactly one Level.Actors slot');
assert.equal(runtime.instance(ammo).nativeObject.nativeVtable, engineInventory.vtable,
  'the live ammo was constructed by the recovered AInventory constructor');
// The ammo route: same gate sequence minus the fake shrink — the authored
// CollisionHeight 0.75 is not > 0.75, so no SetCollisionSize (283) and no
// second hash re-registration — and Pickup's own Pickup state overrides
// Inventory's.
assert.deepEqual(trace, [
  'hash:addActor',
  'event:Spawned',
  'event:PreBeginPlay',
  'native:303',
  'native:303',
  'native:303',
  'call:engine.gameinfo.isrelevant',
  'call:engine.mutator.alwayskeep',
  'call:engine.mutator.isrelevant',
  'call:engine.mutator.checkreplacement',
  'native:195',
  'event:BeginPlay',
  'event:PostBeginPlay',
  'call:engine.inventory.postbeginplay',
  'call:engine.actor.postbeginplay',
  'hash:actorEncroachmentCheck',
  'event:SetInitialState',
  'native:113',
  'event:BeginState',
  'call:engine.inventory.pickup.beginstate',
  'call:engine.inventory.becomepickup',
  'native:262',
  'hash:removeActor',
  'hash:addActor',
  'event:PostPostBeginPlay',
], 'recovered ULevel::SpawnActor startup order for the admitted Ammo chain');
assert.equal(runtime.instance(ammo).state.stateNode?.record?.key, 'engine.pickup.pickup',
  'SetInitialState resolved Pickup.Pickup (Pickup redeclares the auto state)');
assert.equal(ammo.lineage.includes(engineInventory.key), true);
assert.equal(ammo.lineage.includes(engineWeapon.key), false,
  'the ammo lineage descends Pickup -> Inventory without touching Weapon');

runtime.callFunction = originalCallFunction;
runtime.invokeNative = originalInvokeNative;
runtime.processEvent = originalProcessEvent;
for (const [name, previous] of restoreHash) {
  if (previous === undefined) delete hash[name];
  else hash[name] = previous;
}

console.log('Weapon construction passed: AWeapon registration/constructor-thunk/vtable evidence matches Engine.dll, ' +
  `the recovered UStruct::Link reproduces Engine.Weapon PropertiesSize 0x${engineWeapon.instanceSize.toString(16)}, ` +
  'the generalized Inventory-ancestry resolver selects AWeapon for the DeusExWeapon leaves and AInventory for the ' +
  'DeusExAmmo leaves (image route still closed, foreign native root refused), the authored defaults table matches, ' +
  'and live WeaponAssaultGun/Ammo762mm spawns ran the recovered lifecycle order with the recorded native vtables.');
