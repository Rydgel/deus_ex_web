/** Validate the recovered Core `ULinkerLoad::CreateExport` and its metaclass
 * class-loading branch.
 *
 * Three halves:
 *
 *   1. Contract evidence, re-derived from the installed Core.dll bytes rather
 *      than transcribed.  The thunk target, the export-record stride, every
 *      immediate the recovered body compares or masks with, the `Bind` vtable
 *      slot, and the five referenced strings are read back out of the image.
 *      The `NAME_Camera` gate is proved by reading the hard-coded name table
 *      entry that registers index 0xa2.
 *   2. The live metaclass route: each of the nine shipped DataLink image
 *      classes is constructed from the real DeusEx.u export table through
 *      `createLinkerExport`.  Their `ClassIndex` is 0, so `LoadClass` resolves
 *      to the Core.Class metaclass and the constructed object is a UClass.
 *      `IndexToObject` recurses into the same body for the shared
 *      `DataVaultImage` super, which is therefore constructed once and reused;
 *      the cross-package `Engine.Inventory` import is the explicit prebound
 *      boundary.  `UClass::Bind` is the project's recovered body, so the
 *      inherited AInventory constructor arrives by the original copy-down.
 *   3. The completion stage CreateExport deliberately leaves to its caller:
 *      each constructed class keeps RF_NeedLoad, and its Super, field chain,
 *      authored defaults and Link order are compared against the package.
 *
 * Evidence:
 *   Core.dll 0x101012fd/0x1012e230   CreateExport thunk and body
 *   Core.dll 0x1014c312              hard-coded name entry for 0xa2 `Camera`
 *   docs/script-create-export.md     the written body
 *   docs/script-class-bind.md        UClass::Bind, reached at vtable +0x5c
 *   docs/script-datavault-image.md   the DataVaultImage chain this feeds
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';

import {AssetStore} from '../src/unreal/assets.mjs';
import {readClass} from '../src/unreal/classes.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {createLinkerExport, CREATE_EXPORT_CONTRACT} from '../src/runtime/script-create-export.mjs';
import {bindScriptClassConstructor} from '../src/runtime/script-class-bind.mjs';
import {INVENTORY_CONSTRUCTION} from '../src/runtime/script-inventory-construction.mjs';
import {SCRIPTED_ACTOR_CONSTRUCTION} from '../src/runtime/script-scripted-actor-construction.mjs';
import {gameDirectory} from './game-directory.mjs';

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
const wideStringAt = address => {
  let at = fileOffset(address);
  let text = '';
  for (let unit = core.readUInt16LE(at); unit !== 0; at += 2, unit = core.readUInt16LE(at)) {
    text += String.fromCharCode(unit);
  }
  return text;
};
const asciiStringAt = address => {
  const at = fileOffset(address);
  return core.subarray(at, core.indexOf(0, at)).toString('latin1');
};

// The exported thunk is a direct jump to the recovered body.
const thunk = bytesAt(CREATE_EXPORT_CONTRACT.thunk, 5);
assert.equal(thunk[0], 0xe9, 'CreateExport thunk is a relative jump');
assert.equal(CREATE_EXPORT_CONTRACT.thunk + 5 + thunk.readInt32LE(1), CREATE_EXPORT_CONTRACT.body,
  'CreateExport thunk targets the recovered body');

// `lea eax,[eax+eax*8]` then a dword-scaled index is the 0x24 export stride.
assert.equal(hex(bytesAt(0x1012e252, 3)), '8d04c0', 'export index is scaled by nine dwords');
assert.equal(CREATE_EXPORT_CONTRACT.exportRecordStride, 9 * 4);
assert.equal(hex(bytesAt(0x1012e256, 6)), '8b8b84000000',
  `export table is read from linker +0x${CREATE_EXPORT_CONTRACT.exportTableOffset.toString(16)}`);
assert.equal(hex(bytesAt(0x1012e26c, 4)), '8b44811c', '_Object is the +0x1c export slot');

// Every immediate the body gates or masks with.
for (const [address, encoding, label] of [
  [0x1012e290, 'a804', 'RF_Public test on the ObjectName assert'],
  [0x1012e2bb, 'bf181c1f10', 'null LoadClass selects the Core.Class metaclass'],
  [0x1012e2dd, '817f24181c1f10', 'LoadClass->Class (+0x24) must be Core.Class'],
  [0x1012e2fd, '817f20a2000000', 'LoadClass->Name (+0x20) is compared with 0xa2'],
  [0x1012e354, '81e225007f06', 'RF_Load mask 0x067f0025'],
  [0x1012e35e, '81ca00020001', 'RF_NeedLoad|RF_NeedPostLoad or 0x01000200'],
  [0x1012e3b3, '6808030000', 'NAME_DevLoad 0x308 log category'],
  [0x1012e3c8, '3d18261f10', 'the first IsA compares with Core.Struct'],
  [0x1012e402, '3d181c1f10', 'the second IsA compares with Core.Class'],
  [0x1012e409, '8b4028', 'IsA follows SuperField at +0x28'],
  [0x1012e422, 'ff525c', 'Bind is the UClass vtable +0x5c entry'],
]) {
  assert.equal(hex(bytesAt(address, encoding.length / 2)), encoding,
    `${label} at 0x${address.toString(16)}`);
}
assert.equal(CREATE_EXPORT_CONTRACT.classStaticClass, 0x101f1c18);
assert.equal(CREATE_EXPORT_CONTRACT.structStaticClass, 0x101f2618);
assert.equal(CREATE_EXPORT_CONTRACT.cameraName, 0xa2);
assert.equal(CREATE_EXPORT_CONTRACT.loadFlagMask, 0x067f0025);
assert.equal(CREATE_EXPORT_CONTRACT.loadFlagOr, 0x01000200);
assert.equal(CREATE_EXPORT_CONTRACT.bindSlot, 0x5c);
assert.equal(CREATE_EXPORT_CONTRACT.logName, 0x308);

// The referenced strings name the original translation unit and its asserts.
assert.equal(asciiStringAt(0x101a83d4), CREATE_EXPORT_CONTRACT.sourceFile);
assert.equal(asciiStringAt(0x101aa600), CREATE_EXPORT_CONTRACT.asserts.objectName.text);
assert.equal(asciiStringAt(0x101aa5f4), CREATE_EXPORT_CONTRACT.asserts.loadClass.text);
assert.equal(asciiStringAt(0x101aa5bc), CREATE_EXPORT_CONTRACT.asserts.loadClassClass.text);
assert.equal(wideStringAt(0x101aa5a0), CREATE_EXPORT_CONTRACT.logFormat);

// The NAME_Camera gate: the hard-coded name entry that registers index 0xa2.
assert.equal(hex(bytesAt(0x1014c312, 17)), ['6a00', '6800000004', '68a2000000', '684cc21a10']
  .join(''), 'the hard-coded entry at 0x1014c312 registers name index 0xa2');
assert.equal(wideStringAt(0x101ac24c), 'Camera', 'name index 0xa2 is `Camera`');
assert.equal(wideStringAt(0x101ac238), 'Property', 'the 0xa1 neighbour confirms the indexing');
assert.equal(wideStringAt(0x101ac224), 'StackNode', 'the 0xa0 neighbour confirms the indexing');
assert.equal(wideStringAt(0x101ac834), 'DevLoad', 'the log category 0x308 is NAME_DevLoad');

// ---------------------------------------------------------------------------
// 2. The live metaclass route over the real DeusEx.u export table
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

/** The nine distinct classes the ten shipped `ConEventTransferObject`
 * references name; `DL_Rooftops` and `DL_Alleys` share Image02_NYC_Warehouse.
 * Only Image02 had an admitted spawn route before this slice. */
const SHIPPED_IMAGE_CLASSES = [
  'Image02_NYC_Warehouse', 'Image03_NYC_Airfield', 'Image05_NYC_MJ12Lab',
  'Image11_Paris_CathedralEntrance', 'Image11_Paris_Cathedral',
  'Image12_Vandenberg_Command', 'Image14_Schematic',
  'Image15_BlueFusionDevice', 'Image15_Area51Bunker',
];
assert.equal(SHIPPED_IMAGE_CLASSES.length, 9);
assert.equal(new Set(SHIPPED_IMAGE_CLASSES).size, 9, 'the shipped image classes are distinct');

const vaultExport = INVENTORY_CONSTRUCTION.dataVaultImage.packageExport;
for (const name of SHIPPED_IMAGE_CLASSES) {
  const index = deusEx.exportsByPath.get(name.toLowerCase());
  assert.ok(index !== undefined, `${name} is a DeusEx.u export`);
  const entry = deusEx.pkg.exports[index - 1];
  assert.equal(entry.classIndex, 0, `${name} is a class export, so ClassIndex selects the metaclass`);
  assert.equal(entry.superIndex, vaultExport, `${name} derives from the DataVaultImage export`);
  assert.equal(entry.outer, 0, `${name} has no Outer, so CreateExport uses LinkerRoot`);
  assert.equal(entry.flags, 0x000f0004, `${name} export flags`);
}

// Canonical host identities.  The two hard-coded static classes carry their
// recovered addresses so the module's identity comparison sees the real values.
const coreClass = {name: 'Core.Class', address: CREATE_EXPORT_CONTRACT.classStaticClass,
  nameIndex: 0x0a, base: null, objectFlags: 0x04000000, nativeConstructor: 0x10128750};
const coreStruct = {name: 'Core.Struct', address: CREATE_EXPORT_CONTRACT.structStaticClass,
  nameIndex: 0x0b, base: null, objectFlags: 0x04000000, nativeConstructor: 0x101273d0};
// Core.Class's own Class is itself; the metaclass assert at UnLinker.h:794 reads
// this slot, and the IsA walks start from it.
coreClass.class = coreClass;
coreStruct.class = coreClass;
coreStruct.base = null;
coreClass.base = coreStruct;

const linkerRoot = {name: 'DeusEx', isPackage: true};
// The serialized Core.Object class identity, which UClass::Bind exempts from
// its non-null superclass assertion.
const coreObject = {name: 'Core.Object', address: 0x1029e0d0, class: coreClass,
  nameIndex: 0x0c, base: null, objectFlags: 0x04000000, nativeConstructor: 0x10127420};
// The cross-package Engine.Inventory Super is an import.  It is the prebound
// native identity this project already registered, carrying the AInventory
// constructor; resolving imports through their own linker is a separate
// boundary and is refused rather than faked.  Bind walks its superclass chain,
// so the registered Engine.Actor and Core.Object links are present.
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

const names = new Map();
const nameIndexFor = text => {
  const key = text.toLowerCase();
  // Index 0 is NAME_None, so interning starts at 1 and the ObjectName assert
  // at UnLinker.h:787 sees a nonzero name for every public export.
  if (!names.has(key)) names.set(key, names.size + 1);
  return names.get(key);
};

const constructed = new Map();
const loadedObjects = [];
const logLines = [];
const traces = new Map();
let constructCalls = 0;

const linker = {name: 'DeusEx linker', root: linkerRoot, contextFlags: 0x000f0000};

const services = {
  readExport(target, index) {
    assert.equal(target, linker);
    const entry = deusEx.pkg.exports[index - 1];
    assert.ok(entry, `export[${index}] exists`);
    return {
      classIndex: entry.classIndex, superIndex: entry.superIndex,
      packageIndex: entry.outer, objectName: nameIndexFor(entry.name),
      objectFlags: entry.flags, serialSize: entry.serialSize,
      serialOffset: entry.serialOffset ?? 0,
      object: constructed.has(index) ? constructed.get(index) : null,
    };
  },
  writeExportObject(target, index, object) {
    assert.equal(target, linker);
    constructed.set(index, object);
  },
  contextFlags: target => target.contextFlags,
  linkerRoot: target => target.root,
  /** The native IndexToObject reaches the same CreateExport body for a positive
   * export reference.  Imports are the explicit prebound boundary. */
  indexToObject(target, reference) {
    assert.equal(target, linker);
    if (reference === 0) return null;
    if (reference > 0) return createLinkerExport({linker: target, index: reference}, services).object;
    const entry = deusEx.pkg.imports[-reference - 1];
    if (entry.path === 'Engine.Inventory') return engineInventoryIdentity;
    throw new Error(`CreateExport import resolution is not implemented: ${entry.path}`);
  },
  preload(object) {
    assert.equal(object, coreClass, 'the only preloaded LoadClass on this route is the metaclass');
  },
  staticConstructObject({cls, outer, name, flags, template, error, native}) {
    constructCalls++;
    assert.equal(cls, coreClass, 'a class export is constructed through the Core.Class metaclass');
    assert.equal(outer, linkerRoot);
    assert.equal(template, null);
    assert.equal(error, services.errorDevice);
    assert.equal(native, CREATE_EXPORT_CONTRACT.staticConstructObject);
    // The metaclass selects UClass's native constructor; the constructed object
    // is a class with the empty slots Bind and Link later fill.
    return {class: cls, outer, nameIndex: name, objectFlags: flags,
      base: null, nativeConstructor: null, constructedBy: cls.nativeConstructor};
  },
  setLinker(object, target, index) {
    object.linker = target;
    object.linkerIndex = index;
  },
  loadedObjects,
  getFullName: object => `Class ${linkerRoot.name}.${[...names].find(([, i]) => i === object.nameIndex)?.[0]}`,
  log: ({name, format, text}) => logLines.push({name, format, text}),
  read(object, field) {
    if (field === 'class') return object.class ?? null;
    if (field === 'superField') return object.base ?? null;
    if (field === 'nameIndex') return object.nameIndex;
    throw new Error(`Unexpected CreateExport read of ${field}`);
  },
  write(object, field, value) {
    assert.equal(field, 'superField');
    object.base = value;
  },
  bind(object) {
    // The recovered UClass::Bind body, reached through the vtable +0x5c slot.
    const bindSuper = base => bindScriptClassConstructor(base, {
      coreObject, isEditor: () => false, bindSuper,
    });
    bindScriptClassConstructor(object, {coreObject, isEditor: () => false, bindSuper});
  },
  classStaticClass: coreClass,
  structStaticClass: coreStruct,
  errorDevice: {name: 'GWarn', address: CREATE_EXPORT_CONTRACT.errorDevice},
};

for (const name of SHIPPED_IMAGE_CLASSES) {
  const index = deusEx.exportsByPath.get(name.toLowerCase());
  const {object, events} = createLinkerExport({linker, index}, services);
  traces.set(name, {object, events, index});
  assert.ok(object, `${name} was constructed`);
}

const vaultObject = constructed.get(vaultExport);
assert.ok(vaultObject, 'the shared DataVaultImage super was constructed through the same body');
// Nine image classes plus the one shared super.
assert.equal(constructCalls, SHIPPED_IMAGE_CLASSES.length + 1,
  'the shared DataVaultImage super is constructed exactly once and reused');
assert.equal(loadedObjects.length, constructCalls, 'every constructed export joined GObjLoaded');
assert.equal(new Set(loadedObjects).size, loadedObjects.length, 'GObjLoaded has no duplicates');
assert.equal(logLines.length, constructCalls);
for (const line of logLines) {
  assert.equal(line.name, CREATE_EXPORT_CONTRACT.logName);
  assert.equal(line.format, CREATE_EXPORT_CONTRACT.logFormat);
}

// The recovered order, observed on one class rather than inferred from the end
// state.  DataVaultImage is already constructed by the time Image02 is reached,
// so this trace is the steady-state one the other eight also produce.
const rooftops = traces.get('Image02_NYC_Warehouse');
assert.deepEqual(rooftops.events.map(event => event.op), [
  'CreateExport', 'LoadClass', 'CameraGate', 'Preload', 'Outer',
  'StaticConstructObject', 'SetLinker', 'LoadedObjectsAdd', 'Logf', 'SuperField', 'Bind',
], 'the recovered CreateExport order');

const loadClassEvent = rooftops.events.find(event => event.op === 'LoadClass');
assert.equal(loadClassEvent.classIndex, 0);
assert.equal(loadClassEvent.metaclass, true, 'a null ClassIndex selected the metaclass');
assert.equal(loadClassEvent.loadClass, coreClass);

const cameraGate = rooftops.events.find(event => event.op === 'CameraGate');
assert.equal(cameraGate.skipped, false, 'the NAME_Camera gate is evaluated and not taken');
assert.notEqual(cameraGate.name, CREATE_EXPORT_CONTRACT.cameraName);

const construct = rooftops.events.find(event => event.op === 'StaticConstructObject');
assert.equal(construct.flags, ((0x000f0004 & CREATE_EXPORT_CONTRACT.loadFlagMask) |
  CREATE_EXPORT_CONTRACT.loadFlagOr) >>> 0, 'the recovered load-flag arithmetic');
assert.equal(construct.flags, 0x010f0204);
assert.equal(construct.flags & 0x00000200, 0x200, 'the constructed class keeps RF_NeedLoad');
assert.equal(construct.flags & 0x01000000, 0x01000000, 'and RF_NeedPostLoad');

for (const name of SHIPPED_IMAGE_CLASSES) {
  const {object, index} = traces.get(name);
  assert.equal(object.linker, linker, `${name} was given its linker`);
  assert.equal(object.linkerIndex, index, `${name} retained its export index`);
  assert.equal(object.base, vaultObject, `${name} SuperField is the shared DataVaultImage class`);
  assert.equal(object.class, coreClass, `${name} is a UClass`);
  // UClass::Bind copied the nearest native constructor down the chain: these
  // classes and DataVaultImage declare none, so AInventory's arrives.
  assert.equal(object.nativeConstructor, INVENTORY_CONSTRUCTION.engineInventory.internalConstructor,
    `${name} inherited the AInventory native constructor through UClass::Bind`);
}
assert.equal(vaultObject.base, engineInventoryIdentity,
  'DataVaultImage SuperField reached the prebound Engine.Inventory import');

// An export whose class is named `Camera` takes the legacy gate.  Re-running the
// body with a LoadClass whose name is 0xa2 must construct nothing.
const cameraLinker = {name: 'camera linker', root: linkerRoot, contextFlags: 0x000f0000};
const cameraClass = {name: 'Camera', address: 0x0bad0000, nameIndex: CREATE_EXPORT_CONTRACT.cameraName,
  class: coreClass, base: coreStruct, objectFlags: 0x04000000, nativeConstructor: 0x1};
const cameraServices = {
  ...services,
  readExport: () => ({classIndex: 7, superIndex: 0, packageIndex: 0, objectName: 1,
    objectFlags: 0x000f0004, serialSize: 0, serialOffset: 0, object: null}),
  contextFlags: () => 0x000f0000,
  indexToObject: () => cameraClass,
  staticConstructObject: () => assert.fail('the NAME_Camera gate must construct nothing'),
};
const camera = createLinkerExport({linker: cameraLinker, index: 1}, cameraServices);
assert.equal(camera.object, null, 'the NAME_Camera gate returns null');
assert.equal(camera.events.at(-1).op, 'CameraGate');
assert.equal(camera.events.at(-1).skipped, true);

// An export the linker's context flags do not select is skipped before any
// class resolution, and the ObjectName assert fires for a public unnamed export.
const skipped = createLinkerExport({linker: {contextFlags: 0x00000000, root: linkerRoot}, index: 1}, {
  ...services,
  readExport: () => ({classIndex: 0, superIndex: 0, packageIndex: 0, objectName: 1,
    objectFlags: 0x000f0004, serialSize: 0, serialOffset: 0, object: null}),
  contextFlags: target => target.contextFlags,
  indexToObject: () => assert.fail('a context-flag skip resolves no class'),
});
assert.equal(skipped.object, null);
assert.equal(skipped.events.at(-1).op, 'ContextFlagsSkip');

assert.throws(() => createLinkerExport({linker, index: 1}, {
  ...services,
  readExport: () => ({classIndex: 0, superIndex: 0, packageIndex: 0, objectName: 0,
    objectFlags: 0x000f0004, serialSize: 0, serialOffset: 0, object: null}),
}), /Export\.ObjectName!=NAME_None/, 'the UnLinker.h:787 assert is preserved');

// ---------------------------------------------------------------------------
// 3. The completion stage CreateExport leaves to its caller
// ---------------------------------------------------------------------------

const runtime = new ScriptRuntime(assets);
const vaultClass = await runtime.loadClass(deusEx, vaultExport);
const vaultFields = vaultClass.propertyOrder.map(field => field.name);
assert.ok(vaultFields.length > 0, 'DataVaultImage declares the image property chain');

for (const name of SHIPPED_IMAGE_CLASSES) {
  const {index} = traces.get(name);
  const metadata = readClass(deusEx, index);
  // Super, as CreateExport installed it, agrees with the package.
  assert.equal(metadata.base, vaultExport, `${name} package Super`);
  // Field chain: these classes add nothing, so the linked chain is inherited.
  assert.equal(metadata.children, 0, `${name} declares no fields of its own`);
  const cls = await runtime.loadClass(deusEx, index);
  assert.equal(cls.base.record.key, INVENTORY_CONSTRUCTION.dataVaultImage.key,
    `${name} links to DataVaultImage`);
  assert.deepEqual([...cls.propertyOrder], [], `${name} contributes no properties to the link`);
  assert.deepEqual(cls.propertyLink.map(field => field.key),
    vaultClass.propertyLink.map(field => field.key),
    `${name} inherits the DataVaultImage property link order unchanged`);
  // Authored defaults link against the inherited chain rather than new fields.
  assert.ok(metadata.properties.length > 0, `${name} carries authored defaults`);
  for (const property of metadata.properties) {
    assert.ok(runtime.lookupMember(cls, 'fields', property.name),
      `${name} default ${property.name} resolves to an inherited field`);
  }
  assert.ok(cls.defaults.size > 0, `${name} produced linked defaults`);
}

console.log('CreateExport passed: the recovered ULinkerLoad::CreateExport body matches the ' +
  'Core.dll bytes (thunk, 0x24 stride, every gate immediate, the +0x5c Bind slot and all five ' +
  'referenced strings, with name index 0xa2 read back as `Camera`), and all nine shipped DataLink ' +
  'image classes were constructed from the real DeusEx.u export table through the metaclass ' +
  'branch — ClassIndex 0 selecting Core.Class, the shared DataVaultImage super constructed once ' +
  'by the recursive IndexToObject, RF_NeedLoad/RF_NeedPostLoad set by the recovered flag ' +
  'arithmetic, SuperField installed before UClass::Bind copied AInventory down the chain, and ' +
  'each class then linking to the inherited DataVaultImage property chain and defaults.');
