/** Validate the admitted Image02_NYC_Warehouse construction and the recovered
 * ULevel::SpawnActor startup order for the DataVaultImage chain.
 *
 * Two halves:
 *
 *   1. Construction evidence, read back out of the local originals.  The
 *      AInventory registration, its InternalConstructor thunk chain, the two
 *      vtable stores in the constructor body and the three SpawnActor-used
 *      vtable slots are checked against Engine.dll bytes; the class identities,
 *      declarations, linked field chain and PropertiesSize are checked against
 *      DeusEx.u.  PropertiesSize is reproduced by running this project's
 *      recovered UStruct::Link over the real property chain rather than
 *      asserted as a constant.
 *   2. The live startup: one Image02_NYC_Warehouse spawned into the real Play
 *      world through runtime.spawnActor, with the level collision hash and the
 *      script dispatch instrumented so the recovered order is observed rather
 *      than inferred from end state.  The abstract DataVaultImage parent is
 *      spawned too, to pin the prologue gate that refuses it.
 *
 * Evidence:
 *   Engine.dll 0x1035fff0            AInventory registration
 *   Engine.dll 0x1030299b/0x10341710 InternalConstructor thunk chain
 *   Engine.dll 0x10341730            AInventory::AInventory body
 *   Engine.dll 0x10394f60            ULevel::SpawnActor
 *   .cache/reference/Actor.uc:1011-1025   PreBeginPlay fake-shrink + IsRelevant
 *   .cache/reference/Inventory.uc:282-293 BecomePickup
 *   .cache/reference/Inventory.uc:604-760 auto state Pickup
 *   src/runtime/script-inventory-construction.mjs  recorded construction contract
 *   src/runtime/script-spawn.mjs                   spawnActor (general SpawnActor)
 *   docs/script-datavault-image.md                 the written route
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';

import {AssetStore} from '../src/unreal/assets.mjs';
import {readClass} from '../src/unreal/classes.mjs';
import {readObject} from '../src/unreal/objects.mjs';
import {readFieldLinks} from '../src/unreal/script-metadata.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {
  INVENTORY_CONSTRUCTION,
  resolveInheritedInventoryConstructor,
} from '../src/runtime/script-inventory-construction.mjs';
import {linkScriptStruct, SCRIPT_STRUCT_LINK} from '../src/runtime/script-struct-link.mjs';
import {SCRIPT_SCALAR_PROPERTY_LINK} from '../src/runtime/script-scalar-property-link.mjs';
import {SCRIPT_BOOL_PROPERTY_LINK} from '../src/runtime/script-bool-property-link.mjs';
import {SCRIPT_STR_PROPERTY_LINK} from '../src/runtime/script-str-property-link.mjs';
import {SCRIPT_STRUCT_PROPERTY_LINK} from '../src/runtime/script-struct-property-link.mjs';
import {gameDirectory} from './game-directory.mjs';

const root = gameDirectory();
const {engineInventory, dataVaultImage, image02NycWarehouse, layout, startup} = INVENTORY_CONSTRUCTION;

// ---------------------------------------------------------------------------
// 1. Native construction evidence
// ---------------------------------------------------------------------------

const engineBytes = new Uint8Array(await readFile(path.join(root, 'System', 'Engine.dll')));
assert.equal(createHash('sha256').update(engineBytes).digest('hex'),
  INVENTORY_CONSTRUCTION.binaries.engine.sha256, 'local Engine.dll is the recorded GOTY build');

// Engine.dll maps file offset == RVA - image base across .text and .rdata here,
// which the AActor evidence in validate-script-scripted-actor-construction.mjs
// already relies on.
const view = new DataView(engineBytes.buffer, engineBytes.byteOffset, engineBytes.byteLength);
const fileOffset = rva => rva - engineInventory.imageBase;
const u32 = rva => view.getUint32(fileOffset(rva), true);
const expectBytes = (rva, expected, label) =>
  assert.deepEqual([...engineBytes.subarray(fileOffset(rva), fileOffset(rva) + expected.length)],
    expected, label);

// AInventory registration (0x1035fff0): the constructor pointer and raw flags
// are pushed first, then the 0x800 flag word, the 0x434 instance size and the
// AActor parent/own static class pointers.
expectBytes(engineInventory.registration,
  [0x56, 0x57, 0x8b, 0x3d, 0xfc, 0x99, 0x59, 0x10, 0x33, 0xc0,
    0x57, 0x68, 0x9b, 0x29, 0x30, 0x10,
    0x68, 0x04, 0x40, 0x08, 0x04],
  'AInventory registration constructor and flags');
expectBytes(engineInventory.registration + 0x37,
  [0x68, 0xf0, 0xcd, 0x57, 0x10],
  'AInventory registration pushes AActor::PrivateStaticClass');
expectBytes(engineInventory.registration + 0x3f,
  [0x68, 0x00, 0x08, 0x00, 0x00, 0x68, 0x34, 0x04, 0x00, 0x00,
    0x56, 0x89, 0x57, 0x08, 0xb9, 0x70, 0x6f, 0x57, 0x10],
  'AInventory registration size and static class');
assert.equal(u32(engineInventory.registration + 0x0c), engineInventory.internalConstructor);
assert.equal(u32(engineInventory.registration + 0x11), engineInventory.rawRegistrationFlags);
assert.equal(u32(engineInventory.registration + 0x38), engineInventory.superStaticClass);
assert.equal(u32(engineInventory.registration + 0x45), engineInventory.instanceSize);
assert.equal(u32(engineInventory.registration + 0x4e), engineInventory.staticClass);

// The registration's constructor pointer is a jump thunk. Following each `jmp
// rel32` reaches AInventory::InternalConstructor, whose own tail jump (through
// a second thunk) reaches the AInventory constructor body. This is the same
// null-checked InternalConstructor shape AActor uses.
function followThunks(rva, maxHops = 8) {
  for (let hop = 0; hop < maxHops && engineBytes[fileOffset(rva)] === 0xe9; hop++)
    rva = rva + 5 + view.getInt32(fileOffset(rva) + 1, true);
  if (engineBytes[fileOffset(rva)] === 0xe9) throw new Error('thunk chain did not terminate');
  return rva;
}
const internalConstructor = followThunks(engineInventory.internalConstructor);
assert.equal(internalConstructor, 0x10341710, 'AInventory InternalConstructor');
expectBytes(internalConstructor,
  [0x8b, 0x4c, 0x24, 0x04, 0x85, 0xc9, 0x74, 0x05, 0xe9],
  'AInventory InternalConstructor null-checks its argument before the ctor jump');
assert.equal(followThunks(internalConstructor + 8), engineInventory.constructorBody,
  'the InternalConstructor tail jump reaches the recovered AInventory::AInventory body');

// The ctor body runs the inlined AActor member construction and its
// intermediate vtable store before installing the final AInventory vtable.
expectBytes(engineInventory.constructorBody,
  [0x6a, 0xff, 0x68, 0xb7, 0xc9, 0x41, 0x10],
  'AInventory::AInventory body prologue');
expectBytes(0x103417c4, [0xc7, 0x06, 0xdc, 0x68, 0x42, 0x10], 'intermediate AActor vtable store');
assert.equal(u32(0x103417c4 + 2), engineInventory.intermediateVtable);
expectBytes(0x10341851, [0xc7, 0x06, 0xf8, 0x86, 0x42, 0x10], 'final AInventory vtable store');
assert.equal(u32(0x10341851 + 2), engineInventory.vtable);

// AInventory overrides none of the three slots SpawnActor dispatches through,
// so the inherited AActor bodies are the ones the startup sequence runs.
const actorVtable = engineInventory.intermediateVtable;
for (const {slot, thunk, label} of [
  {slot: engineInventory.processEvent.slot, thunk: engineInventory.processEvent.thunk, label: 'ProcessEvent'},
  {slot: engineInventory.initExecution.slot, thunk: engineInventory.initExecution.thunk, label: 'InitExecution'},
  {slot: engineInventory.spawned.slot, thunk: engineInventory.spawned.thunk, label: 'Spawned'},
]) {
  assert.equal(u32(engineInventory.vtable + slot), thunk, `AInventory vtable +0x${slot.toString(16)} is ${label}`);
  assert.equal(u32(actorVtable + slot), thunk, `AInventory inherits AActor's ${label} slot unchanged`);
}

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

function declaration(asset, record) {
  assert.ok(record.metadata.scriptText, 'class has a source TextBuffer');
  const reader = readObject(asset.pkg, asset.bytes, record.metadata.scriptText).reader;
  reader.u32();
  reader.u32();
  const source = reader.string(asset.pkg.version);
  const match = source.match(/class\s+[A-Za-z0-9_]+[\s\S]*?;/i);
  assert.ok(match, 'class declaration is present');
  return {declaration: match[0].replace(/\s+/g, ' ').trim(), source};
}

const inventory = classRecord(engineAsset, 'Inventory');
assert.equal(inventory.index, engineInventory.packageExport);
assert.equal(inventory.metadata.entry.flags, engineInventory.exportFlags);
assert.equal(inventory.metadata.classFlags, engineInventory.serializedClassFlags);
assert.equal(inventory.metadata.base, engineInventory.superPackageExport);
assert.equal(engineAsset.exportsByPath.get('actor'), engineInventory.superPackageExport,
  'Engine.Inventory Super is the Engine.Actor export reference');

const image = classRecord(deusExAsset, 'Image02_NYC_Warehouse');
const vault = classRecord(deusExAsset, 'DataVaultImage');
assert.equal(vault.index, dataVaultImage.packageExport);
assert.equal(vault.metadata.entry.flags, dataVaultImage.exportFlags);
assert.equal(vault.metadata.classFlags, dataVaultImage.serializedClassFlags);
assert.equal(vault.metadata.base, dataVaultImage.superPackageReference);
// classFlags bit 0x1 is RF-style `abstract`: SpawnActor's 0x10394fc2 gate reads
// the same bit and refuses the parent (checked live below).
assert.equal(dataVaultImage.serializedClassFlags & 0x1, 0x1, 'DataVaultImage is abstract');
assert.equal(image.index, image02NycWarehouse.packageExport);
assert.equal(image.metadata.entry.flags, image02NycWarehouse.exportFlags);
assert.equal(image.metadata.classFlags, image02NycWarehouse.serializedClassFlags);
assert.equal(image.metadata.classFlags & 0x1, 0, 'Image02_NYC_Warehouse is concrete');
// A same-package Super is the 1-based export reference itself.
assert.equal(image.metadata.base, image02NycWarehouse.superPackageExport);
assert.equal(image02NycWarehouse.superPackageExport, dataVaultImage.packageExport,
  'Image02_NYC_Warehouse Super is the DataVaultImage export');
// DataVaultImage's Super crosses packages, so it is a negative import reference.
assert.ok(dataVaultImage.superPackageReference < 0, 'DataVaultImage Super is an import reference');
assert.equal(deusExAsset.pkg.imports[-dataVaultImage.superPackageReference - 1].path, 'Engine.Inventory',
  'the DataVaultImage Super import resolves to Engine.Inventory');

assert.equal(declaration(deusExAsset, vault).declaration, dataVaultImage.scriptDeclaration);
assert.equal(declaration(deusExAsset, image).declaration, image02NycWarehouse.scriptDeclaration);
for (const record of [vault, image]) {
  assert.doesNotMatch(declaration(deusExAsset, record).declaration, /\bnative\b/i,
    'neither DataVaultImage nor Image02_NYC_Warehouse is a native class');
  assert.doesNotMatch(declaration(deusExAsset, record).source,
    /\b(?:event|simulated\s+event|function)\s+(?:Spawned|PreBeginPlay|BeginPlay|PostBeginPlay|PostPostBeginPlay|SetInitialState)\b/i,
    'neither class overrides an Actor startup event');
}

// ---------------------------------------------------------------------------
// 3. Linked property chain and PropertiesSize through the recovered linker
// ---------------------------------------------------------------------------

const vtables = new Map(Object.entries(SCRIPT_SCALAR_PROPERTY_LINK.properties)
  .map(([kind, body]) => [kind, body.vtable]));
vtables.set('BoolProperty', SCRIPT_BOOL_PROPERTY_LINK.boolProperty.vtable);
vtables.set('StrProperty', SCRIPT_STR_PROPERTY_LINK.strProperty.vtable);
vtables.set('StructProperty', SCRIPT_STRUCT_PROPERTY_LINK.structProperty.vtable);
const slotValue = (object, offset) => object.nativeSlots.get(offset)?.value;
const putSlot = (object, offset, value) => object.nativeSlots.set(offset, {value, width: 4});

const metadataRuntime = new ScriptRuntime(systemAssets);

/** Mirror of loadScriptStructLayout for a UClass: the same node graph and the
 * same recovered UStruct::Link, but walking a class's Children chain (which
 * interleaves Function/State siblings the linker skips) and starting from an
 * explicit Super PropertiesSize instead of a loaded base struct. */
async function linkClassProperties(asset, classPath, superPropertiesSize) {
  const index = asset.exportsByPath.get(classPath.toLowerCase());
  const record = await metadataRuntime.objects.resolve(asset, index);
  const metadata = readClass(asset, index);
  const base = {nativeSlots: new Map(), preloaded: true};
  for (const [offset, value] of [[0, 0x10175698], [0x28, null], [0x38, null],
    [0x3c, superPropertiesSize], [0x68, null]]) putSlot(base, offset, value);
  const node = {record, key: record.key, kind: 'Struct', nativeVtable: 0x10175698,
    nativeSlots: new Map(), fields: new Map(), preloaded: true};
  for (const [offset, value] of [[0, node.nativeVtable], [0x28, base], [0x38, null], [0x3c, 0]])
    putSlot(node, offset, value);
  const declared = [];
  let child = await metadataRuntime.objects.resolve(asset, metadata.children);
  let previous = null;
  const seen = new Set();
  while (child) {
    if (seen.has(child.key)) throw new Error(`Cyclic class Children chain: ${child.key}`);
    seen.add(child.key);
    if (child.kind.endsWith('Property')) {
      const field = await metadataRuntime.field(child, []);
      const vtable = vtables.get(child.kind);
      assert.ok(vtable !== undefined, `unsupported linked property kind ${child.kind}`);
      const property = {record: child, key: child.key, kind: child.kind,
        nativeSlots: new Map(), preloaded: true, nativeVtable: vtable};
      putSlot(property, 0x18, node);
      putSlot(property, 0x2c, null);
      for (const [offset, value] of [[0, vtable], [0x34, field.metadata.arrayDim],
        [0x38, 0], [0x3c, field.metadata.flags], [0x48, 0]]) putSlot(property, offset, value);
      if (field.metadata.type === 'bool') putSlot(property, 0x5c, 1);
      if (field.metadata.type === 'struct') putSlot(property, 0x5c, field.metadata.structLayout);
      node.fields.set(child.key, property);
      putSlot(previous ?? node, previous ? 0x2c : 0x38, property);
      previous = property;
      declared.push({name: child.name, kind: child.kind, arrayDim: field.metadata.arrayDim});
    }
    child = await metadataRuntime.objects.resolve(child.asset, readFieldLinks(child.asset, child.index).nextRef);
  }
  linkScriptStruct(node, {
    archive: {preload(object) {
      if (!object?.preloaded) throw new Error('class Link reached metadata before async preload completed');
    }},
    secondArgument: 1,
    services: {isA(object, target) {
      if (target === SCRIPT_STRUCT_LINK.propertyClass) return vtables.has(object.kind);
      if (target === SCRIPT_STRUCT_LINK.objectPropertyClass) return ['ObjectProperty', 'ClassProperty'].includes(object.kind);
      if (target === SCRIPT_STRUCT_LINK.structPropertyClass) return object.kind === 'StructProperty';
      throw new Error(`Unsupported class layout class test: ${target}`);
    }},
  });
  return {
    propertiesSize: slotValue(node, 0x3c),
    declared,
    elementSizes: declared.map((entry, index) =>
      slotValue([...node.fields.values()][index], 0x38)),
  };
}

const vaultLayout = await linkClassProperties(deusExAsset, 'DataVaultImage', layout.inventoryPropertiesSize);
// The recorded field table is the class's declaration order, which is also the
// UField::Next order the linker walks.
assert.deepEqual(vaultLayout.declared.map(entry => entry.name),
  dataVaultImage.fields.map(field => field.name), 'DataVaultImage linked field order');
assert.deepEqual(vaultLayout.declared.map(entry => entry.kind),
  dataVaultImage.fields.map(field => field.kind), 'DataVaultImage linked field classes');
assert.deepEqual(vaultLayout.declared.map(entry => entry.arrayDim),
  dataVaultImage.fields.map(field => field.arrayDim), 'DataVaultImage linked array dimensions');
assert.deepEqual(vaultLayout.elementSizes, dataVaultImage.fields.map(field => field.elementSize),
  'DataVaultImage linked element sizes');
assert.equal(vaultLayout.propertiesSize, layout.dataVaultImagePropertiesSize,
  'UStruct::Link over the real property chain reproduces DataVaultImage PropertiesSize');
assert.equal(vaultLayout.propertiesSize, layout.inventoryPropertiesSize +
  dataVaultImage.fields.reduce((size, field) => size + field.elementSize * field.arrayDim, 0),
  'every DataVaultImage member is 4-aligned, so the class adds exactly its member bytes');

const imageLayout = await linkClassProperties(deusExAsset, 'Image02_NYC_Warehouse', vaultLayout.propertiesSize);
assert.deepEqual(imageLayout.declared, [], 'Image02_NYC_Warehouse declares no properties of its own');
assert.equal(imageLayout.propertiesSize, layout.image02PropertiesSize,
  'Image02_NYC_Warehouse inherits DataVaultImage PropertiesSize unchanged');

// ---------------------------------------------------------------------------
// 4. Inherited constructor selection
// ---------------------------------------------------------------------------

const inventoryRecord = {key: engineInventory.key,
  nativeConstructor: engineInventory.internalConstructor, nativeVtable: engineInventory.vtable};
const vaultRecord = {key: dataVaultImage.key, nativeConstructor: null};
const imageRecord = {key: image02NycWarehouse.key, nativeConstructor: null};
const selection = resolveInheritedInventoryConstructor({
  image02: imageRecord, dataVaultImage: vaultRecord, inventory: inventoryRecord,
});
assert.equal(selection.inherited, true);
assert.equal(selection.classKey, image02NycWarehouse.key);
assert.equal(selection.constructor, engineInventory.internalConstructor);
assert.equal(selection.constructorBody, engineInventory.constructorBody);
assert.equal(selection.nativeVtable, engineInventory.vtable);
assert.equal(selection.propertiesSize, layout.image02PropertiesSize);
assert.deepEqual([...selection.bindOrder].slice(-2), [
  'copy Engine.Inventory ClassConstructor to DataVaultImage',
  'copy DataVaultImage ClassConstructor to Image02_NYC_Warehouse',
]);
// A native subclass that carried its own ClassConstructor, or a mismatched
// Inventory registration, must not silently inherit this body.
assert.throws(() => resolveInheritedInventoryConstructor({
  image02: {...imageRecord, nativeConstructor: 0x1234}, dataVaultImage: vaultRecord, inventory: inventoryRecord,
}), /independent native constructor/);
assert.throws(() => resolveInheritedInventoryConstructor({
  image02: imageRecord, dataVaultImage: {...vaultRecord, nativeConstructor: 0x1234}, inventory: inventoryRecord,
}), /independent native constructor/);
assert.throws(() => resolveInheritedInventoryConstructor({
  image02: imageRecord, dataVaultImage: vaultRecord,
  inventory: {...inventoryRecord, nativeConstructor: 0x1234},
}), /ClassConstructor/);
assert.throws(() => resolveInheritedInventoryConstructor({
  image02: {...imageRecord, key: 'engine.camerapoint'}, dataVaultImage: vaultRecord, inventory: inventoryRecord,
}), /deusex\.image02_nyc_warehouse/);

// ---------------------------------------------------------------------------
// 5. Live ULevel::SpawnActor startup order
// ---------------------------------------------------------------------------

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
const player = game.player.collisionActor;
const level = runtime.levelFor(player);
const deusEx = await assets.get('DeusEx');
const imageClass = await runtime.loadClass(deusEx, deusEx.exportsByPath.get('image02_nyc_warehouse'));
const vaultClass = await runtime.loadClass(deusEx, deusEx.exportsByPath.get('datavaultimage'));
const get = (object, field) => runtime.namedReference(object, field).get();
const authored = field => runtime.defaultValue(imageClass, runtime.lookupMember(imageClass, 'fields', field));

// The class defaults the recovered startup branches read.
for (const [field, expected] of Object.entries(image02NycWarehouse.authoredDefaults))
  assert.equal(authored(field), expected, `authored default ${field}`);
assert.equal(authored('bCollideWorld'), false,
  'bCollideWorld is clear by default, so SpawnActor takes no FindSpot placement branch');
assert.equal(authored('bCollideWhenPlacing'), false,
  'bCollideWhenPlacing is clear by default, so SpawnActor takes no FindSpot placement branch');

// Instrument both the level collision hash and the script dispatch so the
// order below is observed, not inferred from the end state.
const trace = [];
const hash = level.hash;
const restoreHash = [];
for (const name of ['addActor', 'removeActor', 'actorEncroachmentCheck', 'lineCheck']) {
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
const actor = runtime.spawnActor({
  cls: imageClass.record, level, name: 'None', owner: null,
  instigator: null, location: [0, 0, 0], rotation: [0, 0, 0],
});
armed = false;

assert.ok(actor, 'original ULevel::SpawnActor admitted Image02_NYC_Warehouse');
assert.equal(level.actors.length - actorsBefore, 1, 'the spawn took exactly one Level.Actors slot');
assert.equal(level.actors.at(-1), actor, 'the spawned actor occupies the appended slot');

// The recovered startup order. Reading it top to bottom:
//   Spawned (inherited AActor no-op) -> PreBeginPlay, whose Deus Ex fake-shrink
//   runs two IsA tests and SetCollisionSize (283) before the GameInfo/Mutator
//   relevance chain and its OddsOfAppearing FRand (195) -> BeginPlay ->
//   Inventory.PostBeginPlay (GetItemName, then Super) -> CheckEncroachment ->
//   SetInitialState -> GotoState (113) -> Pickup.BeginState -> BecomePickup ->
//   SetCollision (262), which is the first and only hash registration ->
//   PostPostBeginPlay.
assert.deepEqual(trace, [
  'event:Spawned',
  'event:PreBeginPlay',
  'native:303',
  'native:303',
  'native:283',
  'call:engine.gameinfo.isrelevant',
  'call:engine.mutator.alwayskeep',
  'call:engine.mutator.isrelevant',
  'call:engine.mutator.checkreplacement',
  'native:195',
  'event:BeginPlay',
  'event:PostBeginPlay',
  'call:engine.actor.getitemname',
  'call:engine.actor.postbeginplay',
  'hash:actorEncroachmentCheck',
  'event:SetInitialState',
  'native:113',
  'event:BeginState',
  'call:engine.inventory.becomepickup',
  'native:262',
  'hash:addActor',
  'event:PostPostBeginPlay',
], 'recovered ULevel::SpawnActor startup order for the admitted Inventory chain');

// The pre-startup hash gate (0x103953b7-0x103953cf) reads +0x1dc bit 0x1. The
// authored bCollideActors is clear, so the only registration in the whole
// sequence is BecomePickup's SetCollision, well after SetOwner/InitExecution.
assert.equal(authored('bCollideActors') && startup.preStartupHashMask, false,
  'the pre-startup hash gate is a no-op for this class');
assert.equal(trace.indexOf('hash:addActor'), trace.lastIndexOf('hash:addActor'),
  'exactly one hash registration occurs during the spawn');
assert.ok(trace.indexOf('hash:addActor') > trace.indexOf('native:262'),
  'the registration comes from BecomePickup SetCollision, not the pre-startup gate');
assert.ok(trace.indexOf('hash:actorEncroachmentCheck') > trace.indexOf('event:PostBeginPlay') &&
  trace.indexOf('hash:actorEncroachmentCheck') < trace.indexOf('event:SetInitialState'),
  'CheckEncroachment runs between PostBeginPlay and SetInitialState');

// CheckEncroachment took the general path, not the bounded early return: the
// early return at 0x1039a350 requires +0x1dc & 0x0d == 0, and the authored
// bBlockActors keeps bit 0x4 set, so the live hash query actually ran.
assert.equal(authored('bBlockActors'), true);
assert.notEqual((actor.collisionBits & startup.encroachmentMask), 0,
  'the authored collision bits keep CheckEncroachment off its early return');
assert.ok(trace.includes('hash:actorEncroachmentCheck'),
  'the live extent query ran rather than being skipped');

// Actor.PreBeginPlay's Deus Ex fake shrink (Actor.uc:1013-1015) runs before
// CheckEncroachment, so the encroachment extent uses the shrunk height.
assert.equal(get(actor, 'CollisionRadius'), image02NycWarehouse.authoredDefaults.CollisionRadius,
  'the fake shrink preserves CollisionRadius');
assert.equal(get(actor, 'CollisionHeight'),
  Math.fround(image02NycWarehouse.authoredDefaults.CollisionHeight - 0.75),
  'IsA(Inventory) with CollisionHeight > 0.75 shrinks the height by 0.75 before encroachment');
assert.ok(trace.indexOf('native:283') < trace.indexOf('hash:actorEncroachmentCheck'),
  'SetCollisionSize precedes the encroachment query');

// SpawnActor header/identity writes (0x10395227-0x103953b4).
assert.equal(get(actor, 'Tag'), imageClass.record.name, 'Tag is the class short name');
assert.equal(get(actor, 'ObjectFlags') & 1, 1, 'ObjectFlags gains RF_Transactional');
assert.deepEqual(get(actor, 'Location'), [0, 0, 0]);
assert.deepEqual(get(actor, 'OldLocation'), [0, 0, 0]);
assert.strictEqual(get(actor, 'Level'), level.actors[0], 'Level points at the LevelInfo');
assert.strictEqual(get(actor, 'Brush'), null);
assert.equal(get(actor, 'bTicked'), !level.tickParity);
assert.equal(get(actor, 'LastRenderTime'), -10, 'LastRenderTime is the -10 spawn sentinel');
assert.strictEqual(get(actor, 'Owner'), null, 'a null spawn owner stays null through SetOwner');
assert.strictEqual(get(actor, 'Instigator'), null);

// SetInitialState resolved `auto state Pickup`. Image02 inherits
// DataVaultImage's own Pickup override, which shadows Engine.Inventory's.
const state = runtime.instance(actor).state.stateNode;
assert.equal(state?.record?.name, 'Pickup');
assert.equal(state?.record?.key, 'deusex.datavaultimage.pickup',
  'GotoState(Auto) resolves the derived DataVaultImage.Pickup record');

// Pickup.BeginState: BecomePickup's field writes plus bCollideWorld. The
// RemoteRole write inside BecomePickup is skipped because Physics is
// PHYS_Falling, and Level.bStartup is false here so bAlwaysRelevant stays clear.
assert.equal(get(actor, 'bCollideActors'), true, 'BecomePickup SetCollision(true,true,false)');
assert.equal(get(actor, 'bBlockActors'), true);
assert.equal(get(actor, 'bBlockPlayers'), false);
assert.equal(get(actor, 'bCollideWorld'), true, 'Pickup.BeginState sets bCollideWorld');
assert.equal(get(actor, 'bHidden'), false);
assert.equal(get(actor, 'bCarriedItem'), false);
assert.equal(get(actor, 'bOnlyOwnerSee'), false);
assert.equal(get(actor, 'NetPriority'), image02NycWarehouse.authoredDefaults.NetPriority);
assert.equal(get(actor, 'RemoteRole'), image02NycWarehouse.authoredDefaults.RemoteRole,
  'Physics == PHYS_Falling skips BecomePickup\'s RemoteRole write');
assert.equal(get(level.actors[0], 'bStartup'), false);
assert.equal(get(actor, 'bAlwaysRelevant'), false, 'Level.bStartup is false, so bAlwaysRelevant stays clear');

// The `Begin:`/`Dropped:` labels are state latent code, not part of
// SetInitialState, so BecomePickup runs exactly once during the spawn.
assert.equal(trace.filter(entry => entry === 'call:engine.inventory.becomepickup').length, 1,
  'only Pickup.BeginState calls BecomePickup during the spawn');

// The FindBase tail gate (0x10395612-0x1039569c). Ancestry and bCollideWorld
// pass, but the authored PHYS_Falling is outside {PHYS_None, PHYS_Rotating}, so
// no downward trace runs at spawn; BecomeItem's SetPhysics(PHYS_None) reaches
// it later (scripts/validate-datalink-transfer-object.mjs).
assert.equal(get(actor, 'Physics'), image02NycWarehouse.authoredDefaults.Physics);
assert.equal(startup.findBasePhysicsValues.includes(get(actor, 'Physics')), false,
  'PHYS_Falling is outside the FindBase physics set');
assert.ok(startup.findBaseAncestry.some(key => actor.lineage.includes(key)),
  'the Inventory ancestry gate itself passes');
assert.equal(get(actor, 'Base'), null, 'no base is assigned at spawn');
assert.equal(trace.includes('hash:lineCheck'), false, 'the FindBase trace does not run at spawn');

// The recorded class chain is the live lineage the gates walk.
assert.deepEqual([...actor.lineage], [...INVENTORY_CONSTRUCTION.chain]);

// The abstract parent is refused by the prologue gate at 0x10394fc2, before
// any class-specific startup and without touching the level or the hash.
const tracedBefore = trace.length;
const actorsAfterImage = level.actors.length;
armed = true;
const abstractResult = runtime.spawnActor({
  cls: vaultClass.record, level, name: 'None', owner: null,
  instigator: null, location: [0, 0, 0], rotation: [0, 0, 0],
});
armed = false;
assert.equal(abstractResult, null, 'SpawnActor refuses the abstract DataVaultImage');
assert.equal(trace.length, tracedBefore, 'the abstract rejection runs no startup and no hash query');
assert.equal(level.actors.length, actorsAfterImage, 'the abstract rejection takes no Level.Actors slot');

runtime.callFunction = originalCallFunction;
runtime.invokeNative = originalInvokeNative;
runtime.processEvent = originalProcessEvent;
for (const [name, previous] of restoreHash) {
  if (previous === undefined) delete hash[name];
  else hash[name] = previous;
}

console.log('Inventory spawn passed: AInventory registration/constructor-thunk/vtable evidence matches Engine.dll, ' +
  `the recovered UStruct::Link reproduces DataVaultImage/Image02 PropertiesSize 0x${vaultLayout.propertiesSize.toString(16)} ` +
  'over the real 13-property chain, the inherited AInventory constructor is selected and guarded, and one live ' +
  'Image02_NYC_Warehouse ran the recovered ULevel::SpawnActor order (PreBeginPlay fake shrink before a live ' +
  'CheckEncroachment, a single BecomePickup hash registration, DataVaultImage.Pickup auto-state entry and a ' +
  'deferred FindBase) while the abstract parent was refused by the prologue gate.');
