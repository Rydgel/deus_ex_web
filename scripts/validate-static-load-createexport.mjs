/** Validate that an absent export reached by the recovered
 * `UObject::StaticLoadObject` path is constructed by the recovered
 * `ULinkerLoad::CreateExport` body, not a host stub.
 *
 * The native export resolver at 0x10161cc0 calls `FindExportIndex` and, on a
 * hash match, forwards the index to `CreateExport` and returns its result
 * directly (0x10161d26-0x10161d2e).  `staticLoadObject` therefore routes
 * every matched export through the `createExport` service; the
 * `linkerCreateExport` adapter binds that service to the real body.  An
 * absent `_Object` bound to anything else is refused, because only the
 * recovered body performs the gates and writes the export slot.
 *
 * The fixture loads `DeusEx.Image02_NYC_Warehouse` — a class export whose
 * `ClassIndex` is 0 — from the real DeusEx.u export table, through
 * StaticLoadObject's BeginLoad -> ResolveName -> GetPackageLinker -> FName ->
 * FindExportIndex -> CreateExport -> EndLoad order, and asserts the inner
 * recovered CreateExport sequence.  Its `SuperIndex` recurses through the
 * host `IndexToObject` into the same body, constructing the shared
 * `DataVaultImage` super once; `Engine.Inventory` remains the explicit
 * prebound import boundary.
 *
 * Evidence:
 *   Core.dll 0x10161cc0/0x10161d26   the resolver forwards to CreateExport
 *   Core.dll 0x10161e00            FindExportIndex: +0xd8 hash, +0x84 export
 *                                  table, +0x78 import table, +0x08/+0x0c/
 *                                  +0x20 record fields, classIndex==0
 *                                  identity 0x14 (`Core`) / 0x29b (`Class`)
 *   Core.dll 0x101012fd/0x1012e230 CreateExport thunk and body
 *   docs/script-static-load-object.md
 *   docs/script-create-export.md
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';

import {AssetStore} from '../src/unreal/assets.mjs';
import {
  staticLoadObject,
  linkerCreateExport,
  STATIC_LOAD_OBJECT_CONTRACT,
  StaticLoadObjectBoundaryError,
} from '../src/runtime/script-static-load-object.mjs';
import {createLinkerExport, CREATE_EXPORT_CONTRACT} from '../src/runtime/script-create-export.mjs';
import {bindScriptClassConstructor} from '../src/runtime/script-class-bind.mjs';
import {INVENTORY_CONSTRUCTION} from '../src/runtime/script-inventory-construction.mjs';
import {SCRIPTED_ACTOR_CONSTRUCTION} from '../src/runtime/script-scripted-actor-construction.mjs';
import {gameDirectory} from './game-directory.mjs';
import { importAt, exportAt } from '../src/unreal/objects.mjs';

const root = gameDirectory();

// ---------------------------------------------------------------------------
// 1. Contract evidence, read back out of Core.dll
// ---------------------------------------------------------------------------

const CORE_SHA256 = '8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4';
const core = await readFile(path.join(root, 'System', 'Core.dll'));
assert.equal(createHash('sha256').update(core).digest('hex'), CORE_SHA256,
  'Core.dll is the hash-verified GOTY image');

const pe = core.readUInt32LE(0x3c);
const sectionCount = core.readUInt16LE(pe + 6);
const optionalSize = core.readUInt16LE(pe + 20);
const imageBase = core.readUInt32LE(pe + 24 + 28);
assert.equal(imageBase, 0x10100000, 'Core.dll image base');
const sections = [];
for (let i = 0, at = pe + 24 + optionalSize; i < sectionCount; i++, at += 40) {
  sections.push({
    virtualSize: core.readUInt32LE(at + 8), virtualAddress: core.readUInt32LE(at + 12),
    rawSize: core.readUInt32LE(at + 16), rawAddress: core.readUInt32LE(at + 20),
  });
}
const fileOffset = address => {
  const relative = address - imageBase;
  for (const s of sections) {
    if (relative >= s.virtualAddress && relative < s.virtualAddress + Math.max(s.virtualSize, s.rawSize)) {
      return s.rawAddress + (relative - s.virtualAddress);
    }
  }
  throw new Error(`Address 0x${address.toString(16)} is outside Core.dll`);
};
const bytesAt = (address, length) => core.subarray(fileOffset(address), fileOffset(address) + length);
const hex = buffer => buffer.toString('hex');

// The resolver body forwards a matched index to the CreateExport thunk and
// returns its result directly: `push eax; mov ecx,edi; call 0x101012fd` is
// immediately followed by the epilogue at 0x10161d2e.
assert.equal(hex(bytesAt(0x10161d26, 8)), '508bcfe8cff5f9ff',
  'the resolver pushes the matched index and calls the CreateExport thunk');
assert.equal(0x10161d2e + bytesAt(0x10161d29, 5).readInt32LE(1),
  STATIC_LOAD_OBJECT_CONTRACT.createExport, 'the resolver calls the CreateExport thunk');
assert.equal(hex(bytesAt(0x10161d05, 3)), '83f8ff',
  'a -1 FindExportIndex result leaves CreateExport unreached');
assert.equal(hex(bytesAt(0x10161d0a, 4)), 'f6451010',
  'the resolver tests flag 0x10 before calling CreateExport');

// FindExportIndex (0x10161e00): the export hash head is the 256-entry table
// at linker +0xd8, the export table is linker +0x84, the import table is
// linker +0x78, and the record fields compared are +0x0c ObjectName,
// +0x08 PackageIndex and +0x20 _iHashNext.
for (const [address, encoding, label] of [
  [0x10161e51, '25ff000000', 'the 256-entry export hash bucket mask'],
  [0x10161e56, '8b8487d8000000', 'the export hash head is linker +0xd8'],
  [0x10161e66, '8bb784000000', 'the export table is linker +0x84'],
  [0x10161e75, '39560c', 'record +0x0c is the ObjectName compare'],
  [0x10161e81, '8b5608', 'record +0x08 is the PackageIndex compare'],
  [0x10161e88, '83f9ff', 'requested outer -1 is the wildcard'],
  [0x10161e93, '8b4f78', 'the import table is linker +0x78'],
  [0x10161ec9, 'b914000000', 'classIndex==0 class outer name is 0x14 (`Core`)'],
  [0x10161f00, 'b99b020000', 'classIndex==0 class name is 0x29b (`Class`)'],
  [0x10161f09, '8b4620', 'record +0x20 is the _iHashNext chain link'],
]) {
  assert.equal(hex(bytesAt(address, encoding.length / 2)), encoding,
    `${label} at 0x${address.toString(16)}`);
}

// The CreateExport thunk still targets the recovered body the adapter binds.
const thunk = bytesAt(CREATE_EXPORT_CONTRACT.thunk, 5);
assert.equal(thunk[0], 0xe9, 'CreateExport thunk is a relative jump');
assert.equal(CREATE_EXPORT_CONTRACT.thunk + 5 + thunk.readInt32LE(1),
  CREATE_EXPORT_CONTRACT.body, 'CreateExport thunk targets the recovered body');

// ---------------------------------------------------------------------------
// 2. A real DeusEx.u linker fixture carrying both record field spellings
// ---------------------------------------------------------------------------

const systemFiles = [];
for (const directory of ['System', 'Maps']) {
  for (const name of await readdir(path.join(root, directory))) {
    systemFiles.push({path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name))});
  }
}
const assets = new AssetStore(systemFiles);
const deusEx = await assets.get('DeusEx');
assert.equal(createHash('sha256').update(await readFile(path.join(root, 'System', 'DeusEx.u'))).digest('hex'),
  '257f5c166739b3d13884a8b8e98a47dda458b325fa929b3b3b99be056cb74480',
  'DeusEx.u is the hash-verified GOTY package');

// The global name table is already interned by the time the export hash is
// consulted, so the fixture interns every reached package name once.  The
// serialized `Core`/`Class` identities 0x14/0x29b are hard-coded in the
// original body and are not interned here.
const names = new Map();
let nextName = 0x400;
const nameIndex = text => {
  const key = String(text).toLowerCase();
  if (!names.has(key)) names.set(key, nextName++);
  return names.get(key);
};
nameIndex('DeusEx');
for (const entry of deusEx.pkg.imports) nameIndex(entry.name);
for (const entry of deusEx.pkg.exports) nameIndex(entry.name);

const deusExPackage = {name: 'DeusEx', isPackage: true, outer: null, nameIndex: nameIndex('DeusEx')};
const linker = {
  kind: 'ULinkerLoad', asset: deusEx, outer: deusExPackage, root: deusExPackage,
  reader: {kind: 'GFileManagerReader', asset: deusEx},
  contextFlags: 0x000f0000, exports: [], hashHeads: Array(256).fill(-1),
};
// One live record per export carries both spellings: StaticLoadObject reads
// outerIndex/nameIndex/nextHash while the recovered CreateExport body reads
// packageIndex/objectName/objectFlags/superIndex — the same FObjectExport
// fields at +0x08/+0x0c/+0x10/+0x04/+0x20.
for (const entry of deusEx.pkg.exports) {
  linker.exports.push({
    classIndex: entry.classIndex, superIndex: entry.superIndex,
    packageIndex: entry.outer, outerIndex: entry.outer,
    nameIndex: nameIndex(entry.name), objectName: nameIndex(entry.name),
    objectFlags: entry.flags, serialSize: entry.serialSize,
    serialOffset: entry.serialOffset ?? 0,
    nextHash: -1, object: null,
  });
}
// Link every export into the bucket the recovered hash computes for it, the
// same construction the prepared-linker graph performs.
const exportClassIdentity = record => {
  if (record.classIndex < 0) {
    const entry = importAt(deusEx.pkg, record.classIndex);
    if (!entry || entry.outer >= 0) return null;
    const outer = importAt(deusEx.pkg, entry.outer);
    if (!outer) return null;
    return {name: nameIndex(entry.name), outer: nameIndex(outer.name)};
  }
  if (record.classIndex > 0) {
    const entry = exportAt(deusEx.pkg, record.classIndex);
    return entry ? {name: nameIndex(entry.name), outer: nameIndex('DeusEx')} : null;
  }
  return {name: 0x29b, outer: 0x14};
};
for (const [index, record] of linker.exports.entries()) {
  const identity = exportClassIdentity(record);
  if (identity === null) continue;
  const normalizedOuter = identity.outer === 0x18 ? 0x17 : identity.outer;
  const bucket = (identity.name * 7 + normalizedOuter * 31 + record.nameIndex) & 0xff;
  record.nextHash = linker.hashHeads[bucket];
  linker.hashHeads[bucket] = index;
}

// ---------------------------------------------------------------------------
// 3. Canonical identities and the two service sets
// ---------------------------------------------------------------------------

// Core.Class is both the StaticLoadObject Class argument and the metaclass
// CreateExport falls back to: its serialized name identity is 0x29b inside
// package 0x14 (`Core`), exactly what FindExportIndex hard-codes for a class
// export's ClassIndex==0 class identity.
const corePackage = {name: 'Core', isPackage: true, outer: null, nameIndex: 0x14};
const coreClass = {name: 'Core.Class', address: CREATE_EXPORT_CONTRACT.classStaticClass,
  nameIndex: 0x29b, base: null, objectFlags: 0x04000000, nativeConstructor: 0x10128750,
  outer: corePackage};
const coreStruct = {name: 'Core.Struct', address: CREATE_EXPORT_CONTRACT.structStaticClass,
  nameIndex: 0x0b, base: null, objectFlags: 0x04000000, nativeConstructor: 0x101273d0};
coreClass.class = coreClass;
coreStruct.class = coreClass;
coreStruct.base = null;
coreClass.base = coreStruct;
const coreObject = {name: 'Core.Object', address: 0x1029e0d0, class: coreClass,
  nameIndex: 0x0c, base: null, objectFlags: 0x04000000, nativeConstructor: 0x10127420};
// The cross-package Engine.Inventory super remains the prebound native
// identity; resolving imports through their own linker is a separate
// boundary.
const engineActorIdentity = {
  name: 'Engine.Actor', class: coreClass, nameIndex: 0x2001, base: coreObject,
  objectFlags: 0x04000000,
  nativeConstructor: SCRIPTED_ACTOR_CONSTRUCTION.engineActor.internalConstructor,
  prebound: true,
};
const engineInventoryIdentity = {
  name: 'Engine.Inventory', class: coreClass, nameIndex: 0x2000, base: engineActorIdentity,
  objectFlags: 0x04000000,
  nativeConstructor: INVENTORY_CONSTRUCTION.engineInventory.internalConstructor,
  prebound: true,
};

const loadedObjects = [];
const logLines = [];
const innerEvents = [];
const nestedEvents = [];
let constructCalls = 0;

const readObject = (object, field) => {
  if (field === 'superField') return object?.base ?? null;
  if (object && typeof object === 'object' && Object.hasOwn(object, field)) return object[field];
  return undefined;
};

// The recovered body's service set.  `indexToObject` recurses into the same
// body for a positive export reference — the shared DataVaultImage super is
// constructed through it — and refuses any import other than the prebound
// Engine.Inventory boundary.
const createServices = {
  readExport(target, index) {
    assert.equal(target, linker);
    const record = linker.exports[index];
    assert.ok(record, `export[${index}] exists`);
    return record;
  },
  writeExportObject(target, index, object) {
    assert.equal(target, linker);
    linker.exports[index].object = object;
  },
  contextFlags: target => target.contextFlags,
  linkerRoot: target => target.root,
  indexToObject(target, reference) {
    assert.equal(target, linker);
    if (reference === 0) return null;
    if (reference > 0) {
      const nested = createLinkerExport({linker: target, index: reference - 1}, createServices);
      nestedEvents.push(...nested.events);
      return nested.object;
    }
    const entry = importAt(deusEx.pkg, reference);
    if (entry.path === 'Engine.Inventory') return engineInventoryIdentity;
    throw new Error(`CreateExport import resolution is not implemented: ${entry.path}`);
  },
  preload(object) {
    assert.equal(object, coreClass, 'the only preloaded LoadClass on this route is the metaclass');
  },
  staticConstructObject({cls, outer, name, flags, template, error, native}) {
    constructCalls++;
    assert.equal(cls, coreClass, 'a class export is constructed through the Core.Class metaclass');
    assert.equal(outer, deusExPackage);
    assert.equal(template, null);
    assert.equal(error, createServices.errorDevice);
    assert.equal(native, CREATE_EXPORT_CONTRACT.staticConstructObject);
    return {class: cls, outer, nameIndex: name, objectFlags: flags,
      base: null, nativeConstructor: null, constructedBy: cls.nativeConstructor};
  },
  setLinker(object, target, index) {
    object.linker = target;
    object.linkerIndex = index;
  },
  loadedObjects,
  getFullName: object => `Class DeusEx.${[...names].find(([, i]) => i === object.nameIndex)?.[0]}`,
  log: ({name, format, text}) => logLines.push({name, format, text}),
  read: readObject,
  write(object, field, value) {
    assert.equal(field, 'superField');
    object.base = value;
  },
  bind(object) {
    const bindSuper = base => bindScriptClassConstructor(base, {
      coreObject, isEditor: () => false, bindSuper,
    });
    bindScriptClassConstructor(object, {coreObject, isEditor: () => false, bindSuper});
  },
  classStaticClass: coreClass,
  structStaticClass: coreStruct,
  errorDevice: {name: 'GWarn', address: CREATE_EXPORT_CONTRACT.errorDevice},
};

const loadState = {nest: 1};
const sloServices = {
  loadState,
  loadedObjects,
  read: readObject,
  resolveName(outerRef, nameRef, options) {
    assert.deepEqual(options, {create: 1, throwOnConfigMissing: 1});
    assert.equal(outerRef.get(), null);
    assert.equal(nameRef.get(), 'DeusEx.Image02_NYC_Warehouse');
    outerRef.set(deusExPackage);
    nameRef.set('Image02_NYC_Warehouse');
    return true;
  },
  loaders: [linker],
  readPackageExtension: () => 'u',
  copyString: ({source}) => {
    assert.equal(source, 'u');
    return source;
  },
  findName(text, mode) {
    assert.equal(text, 'Image02_NYC_Warehouse');
    assert.equal(mode, 1);
    return nameIndex(text);
  },
  readHashHead: (candidate, bucket) => {
    assert.equal(candidate, linker);
    return linker.hashHeads[bucket];
  },
  readExport: (candidate, index) => {
    assert.equal(candidate, linker);
    return linker.exports[index];
  },
  readImportWord: (candidate, byteOffset) => {
    assert.equal(candidate, linker);
    const entry = deusEx.pkg.imports.at(Math.floor(byteOffset / 0x1c));
    assert.ok(entry, `import word +0x${byteOffset.toString(16)} exists`);
    const field = byteOffset % 0x1c;
    if (field === 8) return entry.outer;
    if (field === 12) return nameIndex(entry.name);
    assert.fail(`unexpected native import-table offset ${byteOffset}`);
  },
  createExport: linkerCreateExport(createServices, event => innerEvents.push(event)),
  staticFindObject: () => assert.fail('StaticFindObject fallback was unexpectedly reached'),
};

// ---------------------------------------------------------------------------
// 4. The absent export loads through the recovered body
// ---------------------------------------------------------------------------

const image02Index = deusEx.exportsByPath.get('image02_nyc_warehouse') - 1;
const image02Entry = deusEx.pkg.exports.at(image02Index);
assert.equal(image02Index + 1, INVENTORY_CONSTRUCTION.image02NycWarehouse.packageExport,
  'the fixture exercises the shipped Image02_NYC_Warehouse export');
assert.equal(image02Entry.classIndex, 0, 'a class export selects the metaclass');
assert.equal(image02Entry.superIndex, INVENTORY_CONSTRUCTION.dataVaultImage.packageExport);
assert.equal(image02Entry.flags, 0x000f0004);
assert.equal(linker.exports[image02Index].object, null, 'the export starts absent');

const result = staticLoadObject({
  classRef: coreClass, outer: null, name: 'DeusEx.Image02_NYC_Warehouse',
  filename: null, flags: 2, sandbox: null,
}, sloServices);

const image02 = result.object;
assert.ok(image02, 'the absent export was constructed');
assert.equal(image02, linker.exports[image02Index].object,
  'the export slot holds the returned object');
assert.equal(loadState.nest, 1, 'the nested load scope closed');

// The outer recovered order: the resolver reached the matched export, ran
// CreateExport and returned its object without touching StaticFindObject.
assert.deepEqual(result.events.map(event => event.op), [
  'StaticLoadObject', 'BeginLoad', 'ResolveName', 'GetPackageLinker', 'appStrcpy',
  'FName', 'FindExportIndex', 'CreateExport', 'EndLoad',
], 'StaticLoadObject call order for an absent export');

// The inner order is the recovered ULinkerLoad::CreateExport body itself:
// metaclass LoadClass, the inert NAME_Camera gate, Preload, LinkerRoot outer,
// construction, SetLinker, GObjLoaded, the Created log, SuperField, Bind.
assert.deepEqual(innerEvents.map(event => event.op), [
  'CreateExport', 'LoadClass', 'CameraGate', 'Preload', 'Outer',
  'StaticConstructObject', 'SetLinker', 'LoadedObjectsAdd', 'Logf', 'SuperField', 'Bind',
], 'the recovered CreateExport order inside StaticLoadObject');

// The shared DataVaultImage super was constructed through the same body by
// the recursive IndexToObject — exactly once, after Image02's own construct.
assert.deepEqual(nestedEvents.map(event => event.op), [
  'CreateExport', 'LoadClass', 'CameraGate', 'Preload', 'Outer',
  'StaticConstructObject', 'SetLinker', 'LoadedObjectsAdd', 'Logf', 'SuperField', 'Bind',
], 'DataVaultImage was constructed through the same recovered body');
assert.equal(constructCalls, 2, 'Image02 plus its one shared super');
assert.equal(loadedObjects.length, 2, 'both constructed exports joined GObjLoaded');
assert.equal(loadedObjects[0], image02, 'the requested export constructed first');

const vault = loadedObjects[1];
assert.equal(image02.base, vault, 'Image02 SuperField is the constructed DataVaultImage');
assert.equal(vault.base, engineInventoryIdentity,
  'DataVaultImage SuperField reached the prebound Engine.Inventory import');
assert.equal(image02.class, coreClass, 'the constructed export is a UClass');
assert.equal(image02.linker, linker, 'SetLinker installed the linker');
assert.equal(image02.linkerIndex, image02Index, 'SetLinker installed the 0-based export index');
assert.equal(image02.objectFlags, 0x010f0204, 'the recovered load-flag arithmetic');
assert.notEqual(image02.objectFlags & 0x00000200, 0, 'RF_NeedLoad stays set');
assert.notEqual(image02.objectFlags & 0x01000000, 0, 'RF_NeedPostLoad stays set');
assert.equal(image02.nativeConstructor, INVENTORY_CONSTRUCTION.engineInventory.internalConstructor,
  'UClass::Bind copied the AInventory native constructor down the chain');
assert.equal(vault.nativeConstructor, INVENTORY_CONSTRUCTION.engineInventory.internalConstructor);
assert.equal(logLines.length, 2);
for (const line of logLines) {
  assert.equal(line.name, CREATE_EXPORT_CONTRACT.logName);
  assert.equal(line.format, CREATE_EXPORT_CONTRACT.logFormat);
  assert.match(line.text, /^Class DeusEx\./);
}

// ---------------------------------------------------------------------------
// 5. The same route with the export now present takes the _Object early-out
// ---------------------------------------------------------------------------

innerEvents.length = 0;
nestedEvents.length = 0;
const again = staticLoadObject({
  classRef: coreClass, outer: null, name: 'DeusEx.Image02_NYC_Warehouse',
  filename: null, flags: 2, sandbox: null,
}, sloServices);
assert.equal(again.object, image02, 'a second load returns the same constructed export');
assert.equal(constructCalls, 2, 'the existing export is not reconstructed');
assert.deepEqual(innerEvents.map(event => event.op), ['CreateExport', 'ExistingExport'],
  'the recovered body takes the +0x1c _Object early-out');
assert.deepEqual(nestedEvents, [], 'no nested construction on the early-out');

// ---------------------------------------------------------------------------
// 6. Boundaries stay explicit
// ---------------------------------------------------------------------------

// An absent export bound to a stub that is not the recovered body is refused
// rather than allowed to fabricate a loaded object.
const unmarked = () => null;
assert.throws(() => staticLoadObject({
  classRef: coreClass, outer: null, name: 'DeusEx.Image03_NYC_Airfield',
  filename: null, flags: 2, sandbox: null,
}, {
  ...sloServices,
  resolveName(outerRef, nameRef) {
    outerRef.set(deusExPackage);
    nameRef.set('Image03_NYC_Airfield');
    return true;
  },
  findName: () => nameIndex('Image03_NYC_Airfield'),
  createExport: unmarked,
}), error => error instanceof StaticLoadObjectBoundaryError &&
  error.code === 'STATIC_LOAD_OBJECT_SERVICE',
  'an absent export requires the recovered CreateExport body');

// A service that returns an object the live export slot does not hold fails
// the resolver's return check instead of being trusted.
const image03Index = deusEx.exportsByPath.get('image03_nyc_airfield') - 1;
assert.throws(() => staticLoadObject({
  classRef: coreClass, outer: null, name: 'DeusEx.Image03_NYC_Airfield',
  filename: null, flags: 2, sandbox: null,
}, {
  ...sloServices,
  resolveName(outerRef, nameRef) {
    outerRef.set(deusExPackage);
    nameRef.set('Image03_NYC_Airfield');
    return true;
  },
  findName: () => nameIndex('Image03_NYC_Airfield'),
  createExport: linkerCreateExport({
    ...createServices,
    writeExportObject: () => {},
  }),
}), error => error instanceof StaticLoadObjectBoundaryError &&
  error.code === 'STATIC_LOAD_OBJECT_RETURN',
  'a return the export slot does not hold is refused');
assert.equal(linker.exports[image03Index].object, null,
  'the refused construction did not leak into the export slot');

// A legitimate null CreateExport result — the context-flag gate leaves
// _Object null — falls back to StaticFindObject exactly as a missed export
// does: the native resolver returns CreateExport's result directly and
// StaticLoadObject tests it.
const sentinel = {label: 'StaticFindObject result'};
const skippedLinker = {
  ...linker, contextFlags: 0x00000000,
  exports: linker.exports.map(record => ({...record, object: null})),
  hashHeads: [...linker.hashHeads],
};
const findCalls = [];
const skippedResult = staticLoadObject({
  classRef: coreClass, outer: null, name: 'DeusEx.Image05_NYC_MJ12Lab',
  filename: null, flags: 2, sandbox: null,
}, {
  ...sloServices,
  resolveName(outerRef, nameRef) {
    outerRef.set(deusExPackage);
    nameRef.set('Image05_NYC_MJ12Lab');
    return true;
  },
  findName(text, mode) {
    assert.equal(text, 'Image05_NYC_MJ12Lab');
    assert.equal(mode, 1);
    return nameIndex(text);
  },
  loaders: [skippedLinker],
  readHashHead: (candidate, bucket) => {
    assert.equal(candidate, skippedLinker);
    return skippedLinker.hashHeads[bucket];
  },
  readExport: (candidate, index) => {
    assert.equal(candidate, skippedLinker);
    return skippedLinker.exports[index];
  },
  createExport: linkerCreateExport({
    ...createServices,
    readExport: (target, index) => {
      assert.equal(target, skippedLinker);
      return skippedLinker.exports[index];
    },
  }),
  staticFindObject: request => {
    findCalls.push(request);
    return sentinel;
  },
});
assert.equal(skippedResult.object, sentinel,
  'a null CreateExport result falls back to StaticFindObject');
assert.equal(findCalls.length, 1);
assert.deepEqual(findCalls[0], {classRef: coreClass, outer: deusExPackage,
  name: 'Image05_NYC_MJ12Lab', exactClass: 0});
const skippedOps = skippedResult.events.map(event => event.op);
assert.ok(skippedOps.indexOf('CreateExport') !== -1 &&
  skippedOps.indexOf('CreateExport') < skippedOps.indexOf('StaticFindObject'),
  'the resolver still reached CreateExport before the gate returned null');
assert.equal(skippedOps.at(-2), 'StaticFindObject',
  'StaticFindObject is the last call before EndLoad unwinds the scope');

console.log('StaticLoadObject->CreateExport passed: an absent DeusEx.u class export reaches the ' +
  'recovered ULinkerLoad::CreateExport body through the linkerCreateExport adapter — metaclass ' +
  'LoadClass, the inert NAME_Camera gate, Preload, LinkerRoot outer, StaticConstructObject, ' +
  'SetLinker, GObjLoaded, the Created log, SuperField and UClass::Bind — with the shared ' +
  'DataVaultImage super constructed once through the recursive IndexToObject, the _Object ' +
  'early-out on the second load, and the absent-export/unheld-return boundaries still explicit.');
