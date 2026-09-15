/**
 * Drive the recovered `ULinkerLoad::Preload` (Core.dll 0x10162000) over real
 * DeusEx.u class exports — `DataVaultImage` plus a curated set covering every
 * shipped default-tag shape (docs/script-linker-preload.md) — including the
 * complete closure each preload pulls through this package's and the other
 * packages' linkers.
 *
 * What this exercises end to end:
 *
 *   - real package linkers built from the installed bytes — names interned
 *     into one process-wide FName table, imports resolved eagerly at linker
 *     construction through the target package's own `ULinkerLoad`
 *     (ULinkerLoad::CreateImports behaviour), exports materialized lazily
 *     through `ULinkerLoad::CreateExport` (0x1012e230) exactly as
 *     IndexToObject drives it;
 *   - the registered Core/Engine/DeusEx native class objects
 *     (docs/script-native-registration-order.md +
 *     src/runtime/script-native-class-registry.mjs) aliased onto their
 *     package class exports by the StaticConstructObject find path
 *     (0x101579c0): the found object is re-initialized in place, its flags
 *     become `SetFlags | (old & 0x0c000000)` — which is how the registered
 *     records acquire RF_NeedLoad and serialize their package data;
 *   - `ULinkerLoad::Preload` itself: the IsA(UStruct) super preload, the
 *     cross-linker delegation through the object's +0x10 linker, the
 *     Seek/Precache/Serialize/Tell ordering and the export-size warning;
 *   - the recovered serialize chain: UObject/UField/UStruct/UState/UClass/
 *     UFunction/UProperty/UEnum/UConst/UTextBuffer bodies, the SerializeExpr
 *     boundary expanding compact refs to four-byte script slots, and the
 *     tagged-defaults loop writing through mutable cells;
 *   - the recovered link chain (UStruct/UState/UClass::Link + the per-kind
 *     UProperty::Link bodies) with the replication-condition walk over
 *     expanded script memory.
 *
 * The oracle is the decoded package (`readClass`/`readFieldLinks`/
 * `readPropertyMetadata` in src/unreal): field order, kinds, arrayDim,
 * linked offsets, PropertiesSize and every tagged default are compared.
 *
 * Explicit boundaries (recorded, not silently faked):
 *   - `initClassDefaultObject` seeds the defaults map from the superclass's
 *     already-loaded defaults (the native InitProperties memcpy boundary);
 *     native C++ constructor defaults for properties without a package tag
 *     are not modelled — comparison covers serialized tags only;
 *   - the registration-time defaults of the metaclasses themselves are not
 *     modelled: a constructed object seeds its instance region from the
 *     class's defaults block only once that class has serialized one (the
 *     re-init event records whether defaults existed);
 *   - `loadConfig`/`loadLocalized` are observed but do not mutate (no ini);
 *   - UObject::Serialize's FStateFrame block (RF 0x02000000) stays
 *     unsupported — no export in this closure carries it.
 */

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';

import {Reader, parsePackage} from '../src/unreal/package.mjs';
import {
  readClass,
  expandScriptExpression,
  skipExpandedScriptExpression,
} from '../src/unreal/classes.mjs';
import {
  readFieldLinks,
  readPropertyMetadata,
  readStructMetadata,
} from '../src/unreal/script-metadata.mjs';
import {nameAt} from '../src/unreal/objects.mjs';
import {AssetStore} from '../src/unreal/assets.mjs';

import {
  LINKER_PRELOAD,
  linkerLoadArchive,
  linkerPreload,
  serializeLoadedObject,
  serializeLoadedField,
  serializeLoadedStruct,
  serializeLoadedState,
  serializeLoadedClass,
  serializeLoadedFunction,
  serializeLoadedProperty,
  serializeLoadedEnum,
  serializeLoadedConst,
  serializeLoadedTextBuffer,
  serializeTaggedPropertiesLoad,
} from '../src/runtime/script-linker-preload.mjs';
import {createLinkerExport, CREATE_EXPORT_CONTRACT} from '../src/runtime/script-create-export.mjs';
import {bindScriptClassConstructor} from '../src/runtime/script-class-bind.mjs';
import {linkScriptStruct} from '../src/runtime/script-struct-link.mjs';
import {linkScriptState} from '../src/runtime/script-state-link.mjs';
import {linkScriptClass} from '../src/runtime/script-class-link.mjs';
import {linkScriptProperty} from '../src/runtime/script-property-link.mjs';
import {serializeScriptPropertyItem} from '../src/runtime/script-property-serialize-item.mjs';
import {
  CORE_CLASSES,
  ENGINE_CLASSES,
  DEUSEX_CLASSES,
  findNativeClassConstructor,
  isNativeClassRegisteredDynamic,
} from '../src/runtime/script-native-class-registry.mjs';
import {INVENTORY_CONSTRUCTION} from '../src/runtime/script-inventory-construction.mjs';
import {gameDirectory} from './game-directory.mjs';

const {engineInventory, dataVaultImage, image02NycWarehouse, layout} = INVENTORY_CONSTRUCTION;

// ---------------------------------------------------------------------------
// Native object-word constants (evidence in the module/doc headers)
// ---------------------------------------------------------------------------

// Object vtables an *instance* of each metaclass carries at +0x00 — read by
// the property-link bodies.  Scalar kinds come from the recovered link tables.
const KIND_VTABLE = new Map(Object.entries({
  Field: 0x10175ee4,
  Struct: 0x10175698,
  State: 0x101757d8,
  Class: 0x101758f4,
  Function: 0x10175738,
  Property: 0x10175a44,
  ByteProperty: 0x10175b04,
  IntProperty: 0x10175bc4,
  FloatProperty: 0x10175d44,
  NameProperty: 0x10175f84,
  ObjectProperty: 0x10175e04,
  ClassProperty: 0x10175ec4,
  BoolProperty: 0x10175c84,
  StrProperty: 0x10176044,
  ArrayProperty: 0x101761c4,
  FixedArrayProperty: 0x10176104,
  MapProperty: 0x10176284,
  StructProperty: 0x10176344,
}));

// Registered native class objects by package — recovered from the DLL
// registration bodies (script-native-class-registry.mjs).
const STATIC_BY_PACKAGE = new Map(Object.entries({
  Core: CORE_CLASSES,
  Engine: ENGINE_CLASSES,
  DeusEx: DEUSEX_CLASSES,
}));
const STATIC_ROW_BY_ADDRESS = new Map();
for (const [pkgName, table] of STATIC_BY_PACKAGE) {
  for (const [name, row] of Object.entries(table)) {
    STATIC_ROW_BY_ADDRESS.set(row.staticClass, {pkgName, name, row});
  }
}

// Registration flag dword pushed by the shared class-registration body.
const STATIC_FLAGS = 0x04084004;

// ---------------------------------------------------------------------------
// Process-wide FName table (GNames).  The property-class names must land on
// their real registered indices: `UProperty::GetId` returns the class's FName
// index and the tagged-defaults loop compares it to the tag type nibble.
// ---------------------------------------------------------------------------

const GNAMES_PINNED = new Map([
  [0x0, 'None'],
  [0x1, 'ByteProperty'],
  [0x2, 'IntProperty'],
  [0x3, 'BoolProperty'],
  [0x4, 'FloatProperty'],
  [0x5, 'ObjectProperty'],
  [0x6, 'NameProperty'],
  [0x8, 'ClassProperty'],
  [0x9, 'ArrayProperty'],
  [0xa, 'StructProperty'],
  [0xd, 'StrProperty'],
  [0xe, 'MapProperty'],
  [0xf, 'FixedArrayProperty'],
]);

const gnames = [];
const gnamesByText = new Map();
function intern(text) {
  const key = String(text);
  const existing = gnamesByText.get(key);
  if (existing !== undefined) return existing;
  const index = gnames.length;
  gnames.push(key);
  gnamesByText.set(key, index);
  return index;
}
for (let index = 0; index <= 0xf; index += 1) {
  intern(GNAMES_PINNED.get(index) ?? `__gnames_reserved_${index}`);
}
assert.equal(gnamesByText.get('None'), 0, 'NAME_None is global FName 0');
assert.equal(gnamesByText.get('IntProperty'), 2, 'IntProperty FName = tag type 2');
assert.equal(gnamesByText.get('StructProperty'), 0xa, 'StructProperty FName = tag type 0xa');
const nameText = index => (Number.isInteger(index) ? gnames[index] : index) ?? `<name ${index}>`;

// ---------------------------------------------------------------------------
// Object records: {nativeAddress, nativeSlots: Map(offset -> {value, width})}.
// Pointer slots hold records; FArray slots hold {data,num,max}.
// ---------------------------------------------------------------------------

let syntheticAddress = 0x70000000;
const objectHash = new Map(); // outerAddr:nameIndex:classAddr -> record
const loadedObjects = [];     // the GObjLoaded array (0x1029e638)
const events = [];
const warnings = [];
const assertions = [];
const linkOrder = [];
const createStack = [];       // the linker currently inside CreateExport

// Recorded comparison boundaries — struct tag payloads whose members need a
// shape this comparator does not decode (multi-element members and the
// complex property kinds).  Emptiness is asserted at the end.
const skippedStructValues = [];

const slotOf = (record, offset) => {
  const holder = record?.nativeSlots instanceof Map ? record.nativeSlots.get(offset) : undefined;
  return holder === undefined ? undefined : holder.value;
};
const readSlot = (record, offset) => slotOf(record, offset);
const writeSlot = (record, offset, value, width = 4) => {
  const holder = record.nativeSlots.get(offset);
  if (holder) {
    if (holder.width !== undefined && holder.width !== width) {
      throw new TypeError(`Wrong native slot width at +0x${offset.toString(16)}`);
    }
    holder.value = value;
  } else record.nativeSlots.set(offset, {value, width});
  return value;
};

const addr = record => record === null || record === undefined ? null
  : (record.nativeAddress ?? record.address ?? (typeof record === 'number' ? record : null));
const sameRecord = (a, b) => a === b || (addr(a) !== null && addr(a) === addr(b));

const classRecordOf = object => slotOf(object, 0x24) ?? null;
const superOf = object => slotOf(object, 0x28) ?? null;

function isA(object, target) {
  // The inlined native IsA: +0x24 Class then +0x28 SuperField to null.
  let cls = classRecordOf(object);
  const seen = new Set();
  while (cls !== null && cls !== undefined) {
    if (sameRecord(cls, target)) return true;
    const key = addr(cls) ?? cls;
    if (seen.has(key)) throw new Error('Cyclic Class ancestry in fixture IsA');
    seen.add(key);
    cls = superOf(cls);
  }
  return false;
}

function fullName(record) {
  if (record === null || record === undefined) return 'None';
  const parts = [];
  const seen = new Set();
  let current = record;
  while (current && typeof current === 'object') {
    if (seen.has(current)) break;
    seen.add(current);
    const nameIndex = slotOf(current, 0x20);
    parts.push(nameIndex === undefined ? '(unnamed)' : nameText(nameIndex));
    current = slotOf(current, 0x18) ?? null;
  }
  return parts.reverse().join('.');
}

function makeRecord({cls, outer, name, flags, linker = null, kind = null}) {
  const record = {
    nativeAddress: syntheticAddress,
    address: syntheticAddress,
    // `key`/`name`-family slots the item serializer reads for member keys
    // carry the name text; the numeric +0x20 index lives in nativeSlots.
    key: nameText(name),
    name: nameText(name),
    nativeSlots: new Map(),
    nativeConstructor: null,
    objectFlags: flags >>> 0,
    base: null,
    kind,
    instanceValues: new Map(),
    hashBuckets: null,
    farrays: null,
    script: null,
    defaults: null,
  };
  syntheticAddress += 0x40;
  const vtable = KIND_VTABLE.get(kind);
  if (vtable !== undefined) writeSlot(record, 0x00, vtable);
  writeSlot(record, 0x04, -1);            // GObjObjects index (unregistered)
  writeSlot(record, 0x08, 0);             // hash chain next
  writeSlot(record, 0x0c, 0);             // no state frame
  writeSlot(record, 0x10, linker);        // Linker
  writeSlot(record, 0x14, -1);            // LinkerIndex
  writeSlot(record, 0x18, outer);         // Outer
  writeSlot(record, 0x1c, flags >>> 0);   // ObjectFlags
  writeSlot(record, 0x20, name);          // Name (process-wide FName index)
  writeSlot(record, 0x24, cls);           // Class
  return record;
}

// ---------------------------------------------------------------------------
// Package loading: bytes -> parsePackage -> linker record + embedded archive.
// All package reads happen here (async) so the linker graph stays synchronous.
// ---------------------------------------------------------------------------

const root = gameDirectory();
const systemFiles = [];
for (const directory of ['System', 'Maps', 'Sounds', 'Textures', 'Music']) {
  for (const name of await readdir(path.join(root, directory))) {
    systemFiles.push({path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name))});
  }
}
const systemAssets = new AssetStore(systemFiles);

assert.equal(createHash('sha256')
  .update(await readFile(path.join(root, 'System', 'DeusEx.u'))).digest('hex'),
  INVENTORY_CONSTRUCTION.binaries.deusEx.sha256, 'local DeusEx.u is the recorded GOTY package');
assert.equal(createHash('sha256')
  .update(await readFile(path.join(root, 'System', 'Core.dll'))).digest('hex'),
  '8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4',
  'local Core.dll is the recorded GOTY build');

const packageBytes = new Map();
for (const file of systemFiles) {
  const m = file.path.match(/\.([^.]+)$/);
  if (!m || !['u','uax','utx','umx'].includes(m[1].toLowerCase())) continue;
  const name = path.basename(file.path, m[0]);
  packageBytes.set(name.toLowerCase(), {name, bytes: await file.read()});
}

const linkers = new Map();      // lowercased package name -> linker record
const packageRoots = new Map(); // lowercased package name -> UPackage record

function packageRoot(pkgName) {
  const key = pkgName.toLowerCase();
  let record = packageRoots.get(key);
  if (record === undefined) {
    record = makeRecord({
      cls: staticRecords.get('Core.Package') ?? null,
      outer: null,
      name: intern(pkgName),
      flags: 0x4, // RF_Public
      kind: 'Package',
    });
    packageRoots.set(key, record);
  }
  return record;
}

// The registered native class objects materialize before any linker work —
// they exist at boot, hashed under (Outer = package root, Name, Core.Class).
const staticRecords = new Map(); // 'Core.Object' -> record
for (const pkgName of ['Core', 'Engine', 'DeusEx']) packageRoot(pkgName);
for (const [pkgName, table] of STATIC_BY_PACKAGE) {
  for (const [name, row] of Object.entries(table)) {
    const record = makeRecord({
      cls: null, // patched below — every registered class object is a UClass
      outer: packageRoot(pkgName),
      name: intern(name),
      flags: STATIC_FLAGS,
      kind: 'Class',
    });
    record.nativeAddress = row.staticClass;
    record.address = row.staticClass;
    record.staticClass = row.staticClass;
    record.nativeConstructor = row.internalCtor ?? null;
    staticRecords.set(`${pkgName}.${name}`, record);
  }
}
const classStatic = staticRecords.get('Core.Class');
const structStatic = staticRecords.get('Core.Struct');
const stateStatic = staticRecords.get('Core.State');
const functionStatic = staticRecords.get('Core.Function');
const propertyStatic = staticRecords.get('Core.Property');
const boolPropertyStatic = staticRecords.get('Core.BoolProperty');
const fieldStatic = staticRecords.get('Core.Field');
const enumStatic = staticRecords.get('Core.Enum');
const constStatic = staticRecords.get('Core.Const');
const textBufferStatic = staticRecords.get('Core.TextBuffer');
const objectStatic = staticRecords.get('Core.Object');

for (const [key, record] of staticRecords) {
  const row = STATIC_ROW_BY_ADDRESS.get(record.nativeAddress).row;
  writeSlot(record, 0x00, KIND_VTABLE.get('Class'));
  writeSlot(record, 0x24, classStatic);
  const superRow = row.super !== undefined && row.super !== 0
    ? STATIC_ROW_BY_ADDRESS.get(row.super) : null;
  const superRecord = superRow
    ? staticRecords.get(`${superRow.pkgName}.${superRow.name}`) : null;
  writeSlot(record, 0x28, superRecord);
  record.base = superRecord;
  writeSlot(record, 0x3c, 0); // PropertiesSize — populated when its export loads
  objectHash.set(`${addr(packageRoot(key.split('.')[0]))}:${slotOf(record, 0x20)}:${addr(classStatic)}`, record);
}
// Package roots are UPackage instances — patch their class now that it exists.
for (const record of packageRoots.values()) {
  writeSlot(record, 0x24, staticRecords.get('Core.Package'));
}

// ---------------------------------------------------------------------------
// Linker construction + import resolution
// ---------------------------------------------------------------------------

const archiveServices = linker => ({
  readerTell: reader => reader.offset,
  readerSeek: (reader, position) => reader.seek(position),
  readerPrecache: () => {},
  readerRead: (reader, size) => reader.take(size),
  readerCompactIndex: reader => reader.compact(),
  indexToObject,
  isEditor: () => 0,
  nameReferenceError: detail => {
    warnings.push({kind: 'name-reference', ...detail});
  },
});

function buildLinker(pkgName) {
  const key = pkgName.toLowerCase();
  if (linkers.has(key)) return linkers.get(key);
  const file = packageBytes.get(key);
  if (!file) return null; // unresolvable import — native maps it to NULL
  const pkg = parsePackage(file.bytes);
  const linker = {
    kind: 'ULinkerLoad',
    packageName: file.name,
    pkg,
    bytes: file.bytes,
    root: packageRoot(file.name),
    names: pkg.names.map(entry => intern(entry.name)),
    nameText,
    exports: pkg.exports.map(entry => ({
      classIndex: entry.classIndex,
      superIndex: entry.superIndex,
      packageIndex: entry.outer,
      objectName: intern(entry.name),
      objectFlags: entry.flags,
      serialSize: entry.serialSize,
      serialOffset: entry.serialOffset,
      object: null,
    })),
    imports: pkg.imports,
    importObjects: new Array(pkg.imports.length),
    // +0xa0 runtime context: GIsClient|GIsServer (0x10000|0x20000 when
    // 0x101e5548/0x101e554c are set; a local game run has both).
    contextFlags: 0x00030000,
    reader: new Reader(file.bytes),
  };
  linkers.set(key, linker); // memoize before import resolution (cycle-safe)
  linker.archive = linkerLoadArchive({
    linker,
    reader: linker.reader,
    // +0x0c/+0x18/+0x20/+0x24 carry the LinkerRoot *pointer* — the recovered
    // gates test it numerically, so the archive words hold its address.
    linkerRoot: linker.root.nativeAddress,
    version: pkg.version,
    services: archiveServices(linker),
  });
  const archive = linker.archive;
  archive.serializeRaw = (reference, width) => {
    const bytes = archive.readRaw(width);
    let value = 0;
    for (let i = 0; i < bytes.length; i += 1) value |= bytes[i] << (i * 8);
    reference.set(value >>> 0);
    return archive;
  };
  archive.objectReference = reference => {
    reference.set(archive.readObject().object);
    return archive;
  };
  archive.nameReference = reference => {
    reference.set(archive.readName().name);
    return archive;
  };
  // FArchive::Preload (+0x10) on this linker's archive — the recovered body
  // itself delegates through the object's own +0x10 linker when foreign.
  archive.preload = object =>
    linkerPreload(object, {archive, linker, events}, preloadServices);
  archive.preloadStruct = structure =>
    linkerPreload(structure, {archive, linker, events}, preloadServices);
  archive.serializeItem = (cell, detail) =>
    serializeScriptPropertyItem(detail.property, archive, cell, detail, itemServices);
  writeSlot(linker.root, 0x10, linker);

  // Native CreateImports resolves every import eagerly when the linker is
  // constructed, each through the target package's own ULinkerLoad.
  for (let index = 0; index < linker.imports.length; index += 1) {
    resolveImport(linker, index);
  }
  // Native ULinkerLoad::Verify iterates the ExportMap calling IndexToObject,
  // eagerly constructing every export at package load.  For exports that alias
  // registered statics (Engine.Texture, ...), this is what binds the static to
  // this linker (+0x10) and applies the export flags including RF_NeedLoad —
  // without it a registered super reached only via a name import has no linker
  // and its Preload early-returns unserialized.
  for (let index = 0; index < linker.exports.length; index += 1) {
    indexToObject(linker, index + 1);
  }
  return linker;
}

/** ULinkerLoad::IndexToObject (0x10102c11): 0 -> null, >0 -> export, <0 -> import. */
function indexToObject(linker, ref) {
  if (ref === 0) return null;
  if (ref > 0) {
    const record = linker.exports[ref - 1];
    if (!record) throw new Error(`Export index ${ref} outside ${linker.packageName}`);
    if (record.object === null) {
      createStack.push(linker);
      try {
        const result = createLinkerExport({linker, index: ref - 1}, createExportServices);
        record.object = result.object;
      } finally {
        createStack.pop();
      }
    }
    return record.object;
  }
  return resolveImport(linker, -ref - 1);
}

/**
 * Resolve an import through the package its outer chain names: the import's
 * outermost ancestor is the `Package` import naming the package, and the
 * remaining path selects the object inside that package — `StaticFindObject`
 * hits a registered native class first (metaclasses like `Core.Function`
 * have no package export at all), otherwise the export inside that package's
 * own linker — never a prebound identity.  A missing package maps to null
 * (native: the import stays NULL and downstream references produce null
 * cells).
 */
function resolveImport(linker, importIndex) {
  if (linker.importObjects[importIndex] !== undefined) return linker.importObjects[importIndex];
  const entry = linker.pkg.imports[importIndex];
  if (!entry) throw new Error(`Import index ${importIndex} outside ${linker.packageName}`);
  const segments = entry.path.split('.');
  let object = null;
  if (segments.length === 1) {
    const target = buildLinker(segments[0]);
    if (target === null) {
      warnings.push({kind: 'missing-package', import: entry.path, from: linker.packageName});
    } else {
      object = target.root;
    }
  } else {
    const staticHit = staticRecords.get(`${segments[0]}.${segments.slice(1).join('.')}`);
    if (staticHit) {
      object = staticHit;
    } else {
      const target = buildLinker(segments[0]);
      if (target === null) {
        warnings.push({kind: 'missing-package', import: entry.path, from: linker.packageName});
      } else {
        const localPath = segments.slice(1).join('.').toLowerCase();
        const exportIndex = target.pkg.exports.findIndex(e => e.path.toLowerCase() === localPath);
        if (exportIndex < 0) {
          throw new Error(`Import ${entry.path} has no export ${segments.slice(1).join('.')} in ${segments[0]}`);
        }
        object = indexToObject(target, exportIndex + 1);
      }
    }
  }
  linker.importObjects[importIndex] = object;
  return object;
}

// ---------------------------------------------------------------------------
// CreateExport services
// ---------------------------------------------------------------------------

const createExportServices = {
  readExport: (linker, index) => linker.exports[index],
  writeExportObject: (linker, index, object) => { linker.exports[index].object = object; },
  contextFlags: linker => linker.contextFlags,
  linkerRoot: linker => linker.root,
  indexToObject,
  preload(object) {
    // (this+0xa4)->vtable[+0x10]: the CREATING linker's embedded archive; the
    // body delegates through the object's own +0x10 linker when foreign.
    const creating = createStack[createStack.length - 1];
    if (!creating) throw new Error('CreateExport preload outside an active export');
    return linkerPreload(object, {archive: creating.archive, linker: creating, events},
      preloadServices);
  },
  /**
   * StaticConstructObject (0x10157ff0 -> worker 0x101579c0): the name hash
   * hits return the existing registered object, warn, fold its
   * 0x0c000000 flag bits into SetFlags, and re-initialize it in place —
   * header words +0x04..+0x24 rewritten and the property region rebuilt by
   * InitProperties — before AddObject reinserts it at its old index.  A
   * found *class* keeps its +0x49c/+0x484-bit/+0x4e0 across the reset.
   */
  staticConstructObject({cls, outer, name, flags}) {
    const key = `${addr(outer)}:${name}:${addr(cls)}`;
    const existing = objectHash.get(key);
    if (existing) {
      events.push({op: 'ConstructExisting', object: existing, name: nameText(name)});
      warnings.push({kind: 'exists', object: existing, name: nameText(name)});
      const wasClass = isA(existing, classStatic);
      const saved = wasClass ? {
        within: slotOf(existing, 0x49c),
        flagsBit: (slotOf(existing, 0x484) ?? 0) & 1,
        ctor: existing.nativeConstructor,
      } : null;
      const merged = (flags | ((existing.objectFlags ?? 0) & 0x0c000000)) >>> 0;
      // InitProperties boundary: seed the instance region (+0x28..size) from
      // the class's loaded defaults block, or zeros when the class has not
      // serialized one yet.  Cleared slots read as null so field walks see
      // the native zero — but +0x28 must stay null-readable for the CreateExport
      // isA walk that runs before the superIndex write.
      const source = cls?.defaults?.data instanceof Map ? cls.defaults.data : null;
      for (const [offset, holder] of existing.nativeSlots) {
        if (offset >= 0x28) existing.nativeSlots.set(offset, {value: null, width: holder.width});
      }
      existing.instanceValues = new Map();
      existing.script = null;
      existing.defaults = null;
      existing.farrays = null;
      existing.hashBuckets = null;
      existing.base = null;
      if (source) {
        for (const [offset, value] of source) {
          if (offset >= 0x28) existing.instanceValues.set(offset, deepCopy(value));
        }
      }
      events.push({
        op: 'ConstructReinit', object: existing,
        seededFromDefaults: source !== null,
      });
      writeSlot(existing, 0x04, -1);
      writeSlot(existing, 0x08, 0);
      writeSlot(existing, 0x0c, 0);
      writeSlot(existing, 0x10, 0);
      writeSlot(existing, 0x14, -1);
      writeSlot(existing, 0x18, outer);
      writeSlot(existing, 0x1c, merged);
      existing.objectFlags = merged;
      writeSlot(existing, 0x20, name);
      writeSlot(existing, 0x24, cls);
      if (saved) {
        writeSlot(existing, 0x49c, saved.within ?? null);
        writeSlot(existing, 0x484, saved.flagsBit);
        existing.nativeConstructor = saved.ctor;
      }
      return existing;
    }
    const kind = nameText(slotOf(cls, 0x20));
    const record = makeRecord({cls, outer, name, flags, kind});
    objectHash.set(key, record);
    events.push({op: 'ConstructObject', object: record, cls: kind, name: nameText(name)});
    return record;
  },
  setLinker(object, linker, index) {
    writeSlot(object, 0x10, linker);
    writeSlot(object, 0x14, index);
  },
  loadedObjects,
  getFullName: object => fullName(object),
  log: detail => { events.push({op: 'Logf', ...detail}); },
  read(object, field) {
    const offset = {class: 0x24, superField: 0x28, nameIndex: 0x20}[field];
    return offset === undefined ? undefined : slotOf(object, offset);
  },
  write(object, field, value) {
    if (field !== 'superField') throw new Error(`CreateExport write ${field} unmapped`);
    writeSlot(object, 0x28, value);
    object.base = value;
  },
  bind(object) {
    bindScriptClassConstructor(object, {
      coreObject: objectStatic,
      isEditor: () => false,
      bindSuper: base => createExportServices.bind(base),
      findRegisteredClass(cls) {
        // autoclass lookup (0x1015a5a0): the class's outer package name and
        // its own name select the registered record; +0x4e0 holds the
        // InternalConstructor the registry captured.
        let outer = cls;
        const seen = new Set();
        while (outer && !packageRoots.has(fullName(outer).toLowerCase())) {
          if (seen.has(outer)) return null;
          seen.add(outer);
          outer = slotOf(outer, 0x18) ?? null;
        }
        const pkgName = outer ? fullName(outer) : null;
        return findNativeClassConstructor(pkgName, nameText(slotOf(cls, 0x20)));
      },
      isRegisteredDynamic(cls) {
        let outer = cls;
        const seen = new Set();
        while (outer && !packageRoots.has(fullName(outer).toLowerCase())) {
          if (seen.has(outer)) return false;
          seen.add(outer);
          outer = slotOf(outer, 0x18) ?? null;
        }
        return isNativeClassRegisteredDynamic(outer ? fullName(outer) : null,
          nameText(slotOf(cls, 0x20)));
      },
      warn: message => warnings.push({kind: 'bind', message}),
    });
  },
  classStaticClass: classStatic,
  structStaticClass: structStatic,
  errorDevice: {address: 0x101a7c38},
};

// ---------------------------------------------------------------------------
// Preload + serialize services
// ---------------------------------------------------------------------------

function propertyKindOf(object) {
  const cls = classRecordOf(object);
  return cls ? nameText(slotOf(cls, 0x20)) : null;
}

/** Serialize dispatch = the object's Class vtable +0x28 slot. */
function serializeDispatch(object, archive) {
  if (isA(object, classStatic)) return serializeLoadedClass(object, archive, preloadServices, {events});
  if (isA(object, stateStatic)) return serializeLoadedState(object, archive, preloadServices, {events});
  if (isA(object, functionStatic)) return serializeLoadedFunction(object, archive, preloadServices, {events});
  if (isA(object, propertyStatic)) return serializeLoadedProperty(object, archive, preloadServices, {events});
  if (sameRecord(classRecordOf(object), enumStatic)) return serializeLoadedEnum(object, archive, preloadServices, {events});
  if (sameRecord(classRecordOf(object), constStatic)) return serializeLoadedConst(object, archive, preloadServices, {events});
  if (sameRecord(classRecordOf(object), textBufferStatic)) return serializeLoadedTextBuffer(object, archive, preloadServices, {events});
  if (isA(object, structStatic)) return serializeLoadedStruct(object, archive, preloadServices, {events});
  if (isA(object, fieldStatic)) return serializeLoadedField(object, archive, preloadServices, {events});
  if (isA(object, objectStatic)) return serializeLoadedObject(object, archive, preloadServices, {events});
  throw new Error(`ULinkerLoad::Preload has no recovered Serialize body for ${fullName(object)}`);
}

function scriptDataOf(record) {
  const data = slotOf(record, 0x44);
  if (!(data instanceof Uint8Array)) throw new Error(`No expanded script memory on ${fullName(record)}`);
  return data;
}

/** Struct fields in native SerializeBin order: own children then each super. */
function* structFieldChain(structure) {
  const seenStructs = new Set();
  for (let current = structure; current !== null; current = superOf(current)) {
    if (seenStructs.has(addr(current))) throw new Error('Cyclic struct inheritance');
    seenStructs.add(addr(current));
    let field = slotOf(current, 0x38) ?? null;
    const seenFields = new Set();
    while (field !== null) {
      if (seenFields.has(addr(field))) throw new Error('Cyclic Children chain');
      seenFields.add(addr(field));
      if (isA(field, propertyStatic)) yield field;
      field = slotOf(field, 0x2c) ?? null;
    }
  }
}

/** Default cell value for a property kind, mirroring a zeroed native field. */
function defaultValueFor(property) {
  const kind = propertyKindOf(property);
  switch (kind) {
    case 'StrProperty': return '';
    case 'ArrayProperty': case 'FixedArrayProperty': return [];
    case 'StructProperty': {
      const structure = slotOf(property, 0x5c) ?? null;
      const value = {};
      if (structure) {
        for (const field of structFieldChain(structure)) {
          value[nameText(slotOf(field, 0x20))] = defaultValueFor(field);
        }
      }
      return value;
    }
    case 'ObjectProperty': case 'ClassProperty': return null;
    default: return 0;
  }
}

const f32 = new Float32Array(1);
const f32u32 = new Uint32Array(f32.buffer);
function coerceValue(property, value) {
  const kind = propertyKindOf(property);
  if (kind === 'FloatProperty' && Number.isInteger(value)) {
    f32u32[0] = value >>> 0;
    return f32[0];
  }
  if (kind === 'IntProperty' && Number.isInteger(value)) return value | 0;
  return value;
}

/** dataReference: the defaults/instance backing store is a Map(byteOffset -> value). */
function dataReference(data, offset, detail = {}) {
  const map = data instanceof Map ? data : (data.instanceValues ??= new Map());
  const property = detail.property ?? null;
  return {
    reference: true,
    key: `${detail?.tag?.text ?? '?'}@+0x${offset.toString(16)}`,
    get() {
      if (!map.has(offset)) map.set(offset, property ? defaultValueFor(property) : 0);
      return map.get(offset);
    },
    set(value) {
      map.set(offset, property ? coerceValue(property, value) : value);
      return value;
    },
  };
}

const itemServices = {
  // Item-serializer host boundaries; property metadata reads go through the
  // nativeSlots the serialize/link path wrote.
  structOf: property => slotOf(property, 0x5c),
  innerStruct: property => slotOf(property, 0x5c),
  innerProperty: property => slotOf(property, 0x5c),
  structProperties: structure => [...structFieldChain(structure)],
  childrenOf: structure => {
    const list = [];
    let field = slotOf(structure, 0x38) ?? null;
    while (field) { list.push(field); field = slotOf(field, 0x2c) ?? null; }
    return list;
  },
  inheritanceSuper: structure => superOf(structure),
  nextOf: field => slotOf(field, 0x2c),
  arrayDim: property => slotOf(property, 0x34),
  elementSize: property => slotOf(property, 0x38),
  fixedArrayCount: property => slotOf(property, 0x60),
  propertyFlags: property => slotOf(property, 0x3c),
  boolMask: property => slotOf(property, 0x5c),
  // FArchive::Preload (+0x10) through the property's +0x5c struct: the item's
  // archive drives the call; the body delegates on a foreign +0x10 linker.
  preloadStruct: (structure, context) =>
    linkerPreload(structure, {archive: context.archive, linker: context.archive?.linker, events},
      preloadServices),
};

function deepCopy(value) {
  if (Array.isArray(value)) return value.map(deepCopy);
  if (value && typeof value === 'object' && !(value instanceof Map) && !('nativeSlots' in value)) {
    const copy = {};
    for (const [key, entry] of Object.entries(value)) copy[key] = deepCopy(entry);
    return copy;
  }
  return value;
}

const preloadServices = {
  isValidLinker: linker => linker != null,
  readExport: (linker, index) => linker.exports[index],
  indexToObject,
  serialize: serializeDispatch,
  serializeExpr(object, archive, cursor) {
    // UStruct::SerializeExpr: one serialized expression expands into the
    // four-byte-slot script memory image.
    const linker = slotOf(object, 0x10) ?? archive.linker;
    const {bytes, expanded} = expandScriptExpression(linker.pkg, archive.reader, {
      resolveObject: index => {
        const resolved = indexToObject(linker, index);
        return resolved === null ? 0 : addr(resolved);
      },
      resolveName: index => linker.names[index],
    });
    object.script.data.set(bytes, cursor.offset);
    cursor.offset += expanded;
  },
  serializeExpression(owner, cursor) {
    // The +0x7c SerializeExpr memory path used by linkCondition: the cursor
    // advances over the expanded script image.
    const version = slotOf(owner, 0x10)?.pkg?.version ?? 68;
    cursor.value = skipExpandedScriptExpression(scriptDataOf(owner), cursor.value, {version});
  },
  readScriptBytes: (owner, offset, count) => scriptDataOf(owner).subarray(offset, offset + count),
  serializeTaggedProperties(structure, archive, data, defaultsStruct) {
    // Scope each applied tag to its destination so the oracle comparison can
    // split instance-memory writes from the class Defaults block.
    const mark = events.length;
    const result = serializeTaggedPropertiesLoad(structure, archive, data, defaultsStruct,
      preloadServices, {events});
    for (let i = mark; i < events.length; i += 1) {
      const event = events[i];
      if (event.op === 'TagSerializeItem' || event.op === 'TagBoolItem') event.data = data;
    }
    return result;
  },
  serializeItem: (property, archive, cell, detail) =>
    serializeScriptPropertyItem(property, archive, cell, {...detail, archive}, itemServices),
  dataReference,
  propertyKindOf,
  getPropertiesSize: object => slotOf(object, 0x3c) ?? 0,
  getInheritanceSuper: object => isA(object, functionStatic) ? null : superOf(object),
  initClassDefaultObject(data, cls) {
    // InitClassDefaultObject -> InitProperties: memcpy the super's loaded
    // defaults over the shared prefix.
    const superClass = superOf(cls);
    if (superClass === null) return;
    const superData = superClass.defaults?.data;
    if (superData instanceof Map) {
      for (const [offset, value] of superData) data.set(offset, deepCopy(value));
    }
  },
  allocateDefaults: () => new Map(),
  loadConfig: () => { events.push({op: 'LoadConfig', boundary: true}); },
  loadLocalized: () => { events.push({op: 'LoadLocalized', boundary: true}); },
  makeName: text => intern(text),
  nameText,
  warnLog: detail => { warnings.push({kind: 'warn', ...detail}); },
  failAssert: failure => { assertions.push(failure); },
  getFullName: object => fullName(object),
  localizeError: () => 'Serial size mismatch',
  freeFrame: () => { throw new Error('unexpected +0x0c frame free'); },
  serializeBin: () => { throw new Error('SerializeBin is unreachable on the linker archive'); },
  link: (object, archive, argument) => {
    let result;
    if (isA(object, classStatic)) {
      result = linkScriptClass(object, {archive, secondArgument: argument, services: linkServices});
    } else if (isA(object, stateStatic)) {
      result = linkScriptState(object, {archive, secondArgument: argument, services: linkServices});
    } else if (isA(object, structStatic)) {
      // UFunction::Link forwards to UStruct::Link in this image.
      result = linkScriptStruct(object, {archive, secondArgument: argument, services: linkServices});
    } else {
      throw new Error(`Link dispatch reached a non-struct ${fullName(object)}`);
    }
    linkOrder.push({object, secondArgument: argument, operations: result?.operations ?? []});
    return result;
  },
  readSlot,
  writeSlot,
  classClass: classStatic,
  structClass: structStatic,
  objectClass: objectStatic,
  propertyClass: propertyStatic,
  boolPropertyClass: boolPropertyStatic,
};

// ---------------------------------------------------------------------------
// Link services (UStruct/UState/UClass::Link + property bodies).  The inner
// link calls are wrapped so the per-struct operations land in `linkOrder`.
// ---------------------------------------------------------------------------

const linkServices = {
  getInheritanceSuper: object => isA(object, functionStatic) ? null : superOf(object),
  isA: (object, target) => isA(object, target),
  getOwnerClass(property) {
    let current = slotOf(property, 0x18) ?? null;
    const seen = new Set();
    while (current !== null) {
      if (seen.has(addr(current))) throw new Error('Cyclic Outer chain in GetOwnerClass');
      seen.add(addr(current));
      if (isA(current, classStatic)) return current;
      current = slotOf(current, 0x18) ?? null;
    }
    return null;
  },
  getPropertiesSize: object => slotOf(object, 0x3c) ?? 0,
  // UField/UState/UClass MergeBools bodies return nonzero; UFunction's is 0.
  mergeBools: outer => isA(outer, functionStatic) ? 0 : 1,
  getNativeVTable: property => KIND_VTABLE.get(propertyKindOf(property)),
  isBoolProperty: property => sameRecord(classRecordOf(property), boolPropertyStatic),
  preload: (object, archive) =>
    linkerPreload(object, {archive, linker: archive.linker, events}, preloadServices),
  serializeExpression: (owner, cursor) => {
    const version = slotOf(owner, 0x10)?.pkg?.version ?? 68;
    cursor.value = skipExpandedScriptExpression(scriptDataOf(owner), cursor.value, {version});
  },
  readScriptBytes: (owner, offset, count) => scriptDataOf(owner).subarray(offset, offset + count),
  readGlobal: address => {
    if (address === 0x101e5544) return 0; // GIsEditor = false: replication links
    throw new Error(`Unexpected global read 0x${address.toString(16)}`);
  },
  getHashBuckets: record => (record.hashBuckets ??= new Array(256).fill(null)),
  getNameIndex: record => slotOf(record, 0x20),
  getFieldClass: field => classRecordOf(field),
  getClassSuper: cls => superOf(cls),
  getArrayStorage(record, offset) {
    record.farrays ??= new Map();
    let fa = record.farrays.get(offset);
    if (!fa) {
      fa = {data: [], num: 0, max: 0};
      record.farrays.set(offset, fa);
    }
    return {
      identity: fa,
      getData: () => fa.data,
      setData: next => { fa.data = next; return next; },
      getNum: () => fa.num,
      setNum: value => { fa.num = value; },
      getCapacity: () => fa.max,
      setCapacity: value => { fa.max = value; },
    };
  },
  readSlot,
  writeSlot,
  linkProperty: (property, archive, previous) =>
    linkScriptProperty(property, {archive, previousProperty: previous, services: linkServices}),
};
// Inner-link recorders: linkScriptState calls services.linkUStruct and
// linkScriptClass calls services.linkUState for the embedded calls.
linkServices.linkUStruct = (object, archive, argument) => {
  const result = linkScriptStruct(object, {archive, secondArgument: argument, services: linkServices});
  linkOrder.push({object, secondArgument: argument, operations: result?.operations ?? [], inner: 'struct'});
  return result;
};
linkServices.linkUState = (object, archive, argument) => {
  const result = linkScriptState(object, {archive, secondArgument: argument, services: linkServices});
  linkOrder.push({object, secondArgument: argument, operations: result?.operations ?? [], inner: 'state'});
  return result;
};
linkServices.stateLink = linkServices;
linkServices.structLink = linkServices;
linkServices.classLink = linkServices;

// ---------------------------------------------------------------------------
// Per-class comparator: run one Class export through the recovered
// ULinkerLoad::Preload and compare every serialized field against the
// decoded-package oracle.
// ---------------------------------------------------------------------------

/** Full-name oracle for a package-local object reference (tag values). */
function oraclePathForRef(ref, linker) {
  if (typeof ref === 'string') return ref;
  if (ref === 0 || ref === null || ref === undefined) return null;
  if (ref > 0) return `${linker.packageName}.${linker.pkg.exports[ref - 1].path}`;
  return linker.pkg.imports[-ref - 1].path;
}

// Member kinds this comparator does not decode inside an undecoded struct
// tag payload — recorded boundaries, not silently faked.
const SKIPPED_STRUCT_MEMBER_KINDS = new Set([
  'BoolProperty', 'StructProperty', 'ArrayProperty', 'FixedArrayProperty', 'MapProperty',
]);
const DECODED_STRUCT_MEMBER_KINDS = new Set([
  'ByteProperty', 'IntProperty', 'FloatProperty', 'NameProperty',
  'ObjectProperty', 'ClassProperty', 'StrProperty',
]);

function verifyClassExport(className, {linker = deusExLinker} = {}) {
  const asset = {pkg: linker.pkg, bytes: linker.bytes, name: linker.packageName};
  const index = linker.pkg.exports.findIndex(e => e.name === className && e.className === 'Class');
  assert.ok(index >= 0, `${linker.packageName} exports a Class named ${className}`);
  const exportEntry = linker.exports[index];

  // Preload may be a no-op here: a class already serialized as another set
  // member's superclass returns {preloaded: false, reason: 'loaded'}.  The
  // serialize proof is the recorded PreloadTellExit event for this record.
  const object = indexToObject(linker, index + 1);
  assert.ok(object, `CreateExport produced ${className}`);
  linkerPreload(object, {archive: linker.archive, linker, events}, preloadServices);
  const tellExit = events.find(event =>
    event.op === 'PreloadTellExit' && sameRecord(event.object, object));
  assert.ok(tellExit, `${className} serialized through ULinkerLoad::Preload`);
  assert.equal(tellExit.consumed, exportEntry.serialSize,
    `${className} Preload consumed exactly the export serial range`);
  assert.ok(!events.some(event =>
    event.op === 'PreloadSizeMismatch' && sameRecord(event.object, object)),
    `${className} raised no export-size warning`);

  const oracle = readClass(asset, index + 1);

  // Children chain: names, classes, arrayDim/flags and linked offsets vs the
  // decoded-package oracle.
  const oracleFields = [];
  {
    let ref = oracle.children;
    const seen = new Set();
    while (ref) {
      assert.ok(!seen.has(ref), `${className} oracle children chain is acyclic`);
      seen.add(ref);
      const entry = linker.pkg.exports[ref - 1];
      const links = readFieldLinks(asset, ref);
      oracleFields.push({ref, entry, links});
      ref = links.nextRef;
    }
  }
  const loadedFields = [];
  {
    let field = slotOf(object, 0x38) ?? null;
    const seen = new Set();
    while (field) {
      assert.ok(!seen.has(addr(field)), `${className} loaded children chain is acyclic`);
      seen.add(addr(field));
      loadedFields.push(field);
      field = slotOf(field, 0x2c) ?? null;
    }
  }
  assert.equal(loadedFields.length, oracleFields.length,
    `${className} children chain length matches the package`);
  for (const [i, expected] of oracleFields.entries()) {
    const field = loadedFields[i];
    assert.equal(nameText(slotOf(field, 0x20)), expected.entry.name, `${className} child ${i} name`);
    assert.equal(propertyKindOf(field), expected.entry.className, `${className} child ${i} class`);
  }
  const linkedProperties = loadedFields.filter(field => isA(field, propertyStatic));
  for (const [i, expected] of oracleFields.entries()) {
    if (!expected.entry.className.endsWith('Property')) continue;
    const field = loadedFields[i];
    const oracleProp = readPropertyMetadata(asset, expected.ref);
    assert.equal(slotOf(field, 0x34), oracleProp.arrayDim,
      `${className}.${expected.entry.name} serialized ArrayDim`);
    assert.equal(slotOf(field, 0x3c), oracleProp.propertyFlags,
      `${className}.${expected.entry.name} serialized PropertyFlags`);
    assert.ok(Number.isInteger(slotOf(field, 0x48)),
      `${className}.${expected.entry.name} received a linked Offset`);
  }
  // UBoolProperty::Link packs consecutive bools into one DWORD
  // (Offset = Prev->Offset while the bitmask shifts), so equal consecutive
  // offsets are legal exactly when both properties are BoolProperty.
  const ownOffsets = linkedProperties.map(field => slotOf(field, 0x48));
  for (let i = 1; i < ownOffsets.length; i += 1) {
    const packedBool = ownOffsets[i] === ownOffsets[i - 1] &&
      propertyKindOf(linkedProperties[i]) === 'BoolProperty' &&
      propertyKindOf(linkedProperties[i - 1]) === 'BoolProperty';
    assert.ok(ownOffsets[i] > ownOffsets[i - 1] || packedBool,
      `${className} own-property offsets increase in link order ` +
      `(${nameText(slotOf(linkedProperties[i - 1], 0x20))} -> ${nameText(slotOf(linkedProperties[i], 0x20))})`);
  }

  // Serialized class-body fields vs the oracle.
  assert.equal(slotOf(object, 0x484), oracle.classFlags, `${className} ClassFlags`);
  assert.equal(nameText(slotOf(object, 0x4a0)), oracle.configName, `${className} ClassConfigName`);
  assert.equal(nameText(slotOf(object, 0x40)), oracle.friendlyName, `${className} FriendlyName`);
  assert.equal(slotOf(object, 0x54), oracle.line, `${className} Line`);
  assert.equal(slotOf(object, 0x50), oracle.textPosition, `${className} TextPos`);
  const loadedDeps = slotOf(object, 0x4bc);
  assert.equal(loadedDeps?.num ?? loadedDeps?.data?.length, oracle.dependencies.length,
    `${className} dependency count`);

  // Tagged defaults vs the oracle.  Tag events were scoped to their
  // destination by the serializeTaggedProperties wrapper; the defaults pass
  // is the one whose data is the class's allocated Map.
  const defaultsMap = object.defaults?.data;
  assert.ok(defaultsMap instanceof Map, `${className} defaults storage exists`);
  const appliedTags = events.filter(event =>
    (event.op === 'TagSerializeItem' || event.op === 'TagBoolItem') && event.data === defaultsMap);
  const oracleTags = oracle.properties;
  assert.equal(appliedTags.length, oracleTags.length,
    `${className} applied ${oracleTags.length} tags`);

  const loadedTagValue = event => {
    const property = event.property;
    const kind = propertyKindOf(property);
    const raw = defaultsMap.get(event.destOffset);
    if (event.op === 'TagBoolItem') return (event.tag.raw & 0x80) !== 0;
    if (kind === 'NameProperty') return raw === null || raw === undefined ? raw : nameText(raw);
    return raw;
  };

  for (const [i, oracleTag] of oracleTags.entries()) {
    const applied = appliedTags[i];
    assert.equal(nameText(slotOf(applied.property, 0x20)), oracleTag.name,
      `${className} tag ${i} resolves to ${oracleTag.name}`);
    assert.equal(applied.tag.type, oracleTag.type, `${className} tag ${i} type`);
    assert.equal(applied.tag.arrayIndex, oracleTag.arrayIndex, `${className} tag ${i} arrayIndex`);
    assert.equal(applied.destOffset,
      slotOf(applied.property, 0x48) + slotOf(applied.property, 0x38) * oracleTag.arrayIndex,
      `${className} tag ${oracleTag.name} placement`);
    const loaded = loadedTagValue(applied);
    if (oracleTag.type === 5 || oracleTag.type === 8) {
      // Object and class references both ship as type 5.
      assert.equal(loaded ? fullName(loaded) : null, oraclePathForRef(oracleTag.value, linker),
        `${className} tag ${oracleTag.name} object reference`);
    } else if (oracleTag.type === 4) {
      assert.ok(Math.abs(loaded - oracleTag.value) < 1e-6 ||
        Object.is(loaded, oracleTag.value), `${className} tag ${oracleTag.name} float`);
    } else if (oracleTag.type === 10) {
      // Struct tags serialize memberwise; the loaded cell is member-keyed.
      // Member values keep the archive's raw dword — decode Float/Int bits by
      // the member's own property kind.
      const structure = slotOf(applied.property, 0x5c);
      const memberFields = [...structFieldChain(structure)];
      const memberNames = memberFields.map(field => nameText(slotOf(field, 0x20)));
      const memberValueEqual = (field, got, expected, label) => {
        const kind = propertyKindOf(field);
        if (kind === 'FloatProperty') {
          f32u32[0] = got >>> 0;
          assert.ok(Math.abs(f32[0] - expected) < 1e-6 || Object.is(f32[0], expected),
            `${label} (bits 0x${(got >>> 0).toString(16)})`);
        } else if (kind === 'IntProperty') {
          assert.equal(got >>> 0, expected >>> 0, label);
        } else {
          assert.equal(got, expected, label);
        }
      };
      if (oracleTag.decoded) {
        if (Array.isArray(oracleTag.value)) {
          for (const [m, expected] of oracleTag.value.entries()) {
            memberValueEqual(memberFields[m], loaded[memberNames[m]], expected,
              `${className} tag ${oracleTag.name} member ${memberNames[m]}`);
          }
        } else if (oracleTag.value && typeof oracleTag.value === 'object') {
          for (const [key, expected] of Object.entries(oracleTag.value)) {
            const memberField = memberFields.find(f => nameText(slotOf(f, 0x20)) === key);
            if (expected && typeof expected === 'object' && Array.isArray(expected)) {
              const member = loaded[key];
              const innerFields = [...structFieldChain(slotOf(memberField, 0x5c))];
              const innerNames = innerFields.map(f => nameText(slotOf(f, 0x20)));
              for (const [m, v] of expected.entries()) {
                memberValueEqual(innerFields[m], member[innerNames[m]], v,
                  `${className} tag ${oracleTag.name}.${key}.${innerNames[m]}`);
              }
            } else {
              memberValueEqual(memberField, loaded[key], expected,
                `${className} tag ${oracleTag.name}.${key}`);
            }
          }
        }
        continue;
      }
      // Undecoded oracle shape: decode the raw tag payload memberwise against
      // the struct's exported member table (same member order SerializeBin
      // walks), then compare each member against the loaded cell.
      const structSegments = fullName(structure).split('.');
      const structLinker = linkers.get(structSegments[0].toLowerCase());
      assert.ok(structLinker,
        `${className} tag ${oracleTag.name}: struct package ${structSegments[0]} is loaded`);
      const structAsset = {pkg: structLinker.pkg, bytes: structLinker.bytes, name: structLinker.packageName};
      const structPath = structSegments.slice(1).join('.');
      const structIndex = structLinker.pkg.exports.findIndex(e => e.path === structPath);
      assert.ok(structIndex >= 0,
        `${className} tag ${oracleTag.name}: ${fullName(structure)} resolves to an export`);
      const members = readStructMetadata(structAsset, structIndex + 1).children;
      const boundary = members.filter(member =>
        member.arrayDim > 1 || SKIPPED_STRUCT_MEMBER_KINDS.has(member.className) ||
        !DECODED_STRUCT_MEMBER_KINDS.has(member.className));
      if (boundary.length > 0) {
        for (const member of boundary) {
          skippedStructValues.push({
            className, tag: oracleTag.name, struct: fullName(structure), member: member.name,
          });
        }
        continue;
      }
      const r = new Reader(oracleTag.data);
      for (const member of members) {
        const memberLoaded = loaded[member.name];
        const label = `${className} tag ${oracleTag.name}[${oracleTag.arrayIndex}] member ${member.name}`;
        switch (member.className) {
          case 'ByteProperty':
            assert.equal(memberLoaded, r.u8(), label);
            break;
          case 'IntProperty':
            // Member cells keep the archive's raw dword; compare as bits.
            assert.equal(memberLoaded >>> 0, r.i32() >>> 0, label);
            break;
          case 'FloatProperty': {
            // Member cells keep the raw IEEE-754 dword (the per-property
            // float coercion only applies to top-level tag destinations).
            f32u32[0] = memberLoaded >>> 0;
            const expected = r.f32();
            assert.ok(Math.abs(f32[0] - expected) < 1e-6 || Object.is(f32[0], expected),
              `${label} (bits 0x${(memberLoaded >>> 0).toString(16)})`);
            break;
          }
          case 'NameProperty':
            assert.equal(nameText(memberLoaded), nameAt(linker.pkg, r.compact()), label);
            break;
          case 'ObjectProperty': case 'ClassProperty': {
            const ref = r.compact();
            assert.equal(memberLoaded ? fullName(memberLoaded) : null,
              oraclePathForRef(ref, linker), label);
            break;
          }
          case 'StrProperty':
            assert.equal(memberLoaded, r.string(linker.pkg.version), label);
            break;
          default:
            throw new Error(`unreachable: filtered member kind ${member.className}`);
        }
      }
      assert.equal(r.offset, oracleTag.data.length,
        `${className} tag ${oracleTag.name} oracle consumed exactly the tag payload`);
    } else {
      assert.deepEqual(loaded, oracleTag.value, `${className} tag ${oracleTag.name}`);
    }
  }

  // The +0x60 chain contains every property the tags wrote to — inherited
  // members reachable through the linked merge.
  const chainNames = new Set();
  {
    let property = slotOf(object, 0x60) ?? null;
    const seen = new Set();
    while (property) {
      assert.ok(!seen.has(addr(property)), `${className} cyclic +0x60 chain`);
      seen.add(addr(property));
      chainNames.add(nameText(slotOf(property, 0x20)));
      property = slotOf(property, 0x4c) ?? null;
    }
  }
  for (const tag of oracleTags) {
    assert.ok(chainNames.has(tag.name),
      `${className} +0x60 chain contains inherited property ${tag.name}`);
  }

  // Link ordering: the class's struct link ran its per-property links in
  // Children order, then built the reference and property chains.
  const structLink = linkOrder.find(entry =>
    sameRecord(entry.object, object) && entry.operations.some(op => op.operation === 'build-property-chains'));
  assert.ok(structLink, `${className} ran the recovered UStruct::Link`);
  const opOrder = structLink.operations.map(op => op.operation);
  const firstLinkProperty = opOrder.indexOf('link-property');
  const refChain = opOrder.indexOf('build-reference-chain');
  const chainIndex = opOrder.indexOf('build-property-chains');
  assert.ok(firstLinkProperty >= 0 && refChain > firstLinkProperty && chainIndex > refChain,
    `${className} link order: per-property link, then reference chains, then the property chains`);
  const linkPropertyOrder = structLink.operations
    .filter(op => op.operation === 'link-property')
    .map(op => nameText(slotOf(op.property, 0x20)));
  const ownPropertyNames = oracleFields
    .filter(field => field.entry.className.endsWith('Property'))
    .map(field => field.entry.name);
  assert.deepEqual(linkPropertyOrder, ownPropertyNames,
    `${className} property link order follows the serialized Children chain`);

  const indexed = oracleTags.filter(tag => tag.arrayIndex > 0).length;
  console.log(`verified ${className}: ${loadedFields.length} children, ` +
    `${oracleTags.length} tags (${indexed} at arrayIndex>0), ${exportEntry.serialSize} serial bytes`);
  return {object, oracle, appliedTags, loadedFields, linkedProperties, oracleFields};
}

// ---------------------------------------------------------------------------
// Run: build the linkers, then Preload the DataVaultImage export
// ---------------------------------------------------------------------------

const coreLinker = buildLinker('Core');
const engineLinker = buildLinker('Engine');
const deusExLinker = buildLinker('DeusEx');

const dviIndex = deusExLinker.pkg.exports.findIndex(e => e.name === 'DataVaultImage');
assert.ok(dviIndex >= 0, 'DeusEx.u exports DataVaultImage');
const dviExport = deusExLinker.exports[dviIndex];

// DataVaultImage's SuperField reference is an import that must resolve
// through Engine's own ULinkerLoad.
const superImportRef = deusExLinker.pkg.exports[dviIndex].superIndex;
assert.ok(superImportRef < 0, 'DataVaultImage Super is an import reference');
const superImport = deusExLinker.pkg.imports[-superImportRef - 1];
assert.equal(superImport.path, 'Engine.Inventory');

const deusExAsset = {pkg: deusExLinker.pkg, bytes: deusExLinker.bytes, name: 'DeusEx'};

// ---------------------------------------------------------------------------
// Assertions — DataVaultImage through the shared comparator plus its recorded
// INVENTORY_CONSTRUCTION layout checks, then the curated set.
// ---------------------------------------------------------------------------

const {
  object: dviObject,
  linkedProperties: dviLinkedProperties,
  oracleFields: dviOracleFields,
} = verifyClassExport('DataVaultImage');
assert.equal(dviExport.object, dviObject);
assert.equal(slotOf(dviObject, 0x10), deusExLinker, 'DataVaultImage carries the DeusEx linker');
assert.equal(slotOf(dviObject, 0x14), dviIndex, 'DataVaultImage LinkerIndex is its export index');

// The import path materialized Engine.Inventory through Engine's own linker
// and aliased the registered AInventory class object (0x10576f70).
const inventoryRecord = resolveImport(deusExLinker, -superImportRef - 1);
const engineInventoryExportIndex = engineLinker.pkg.exports.findIndex(e => e.path === 'Inventory');
assert.ok(engineInventoryExportIndex >= 0);
assert.equal(inventoryRecord, engineLinker.exports[engineInventoryExportIndex].object,
  'the import resolves through Engine\'s own ULinkerLoad');
assert.equal(addr(inventoryRecord), ENGINE_CLASSES.Inventory.staticClass,
  'the Engine.Inventory export aliases the registered class object');
assert.notEqual(addr(dviObject), ENGINE_CLASSES.Inventory.staticClass,
  'DataVaultImage is not the Inventory static — the import was a real lookup');

// UClass::Bind: DataVaultImage (scripted-only, no DeusEx.dll registration)
// inherits the Engine AInventory InternalConstructor through its super.
assert.equal(dviObject.nativeConstructor, ENGINE_CLASSES.Inventory.internalCtor,
  'DataVaultImage inherits AInventory InternalConstructor through UClass::Bind');
assert.equal(slotOf(dviObject, 0x28), inventoryRecord, 'DataVaultImage SuperField is the resolved import');

// The recorded field table (name/kind/arrayDim/elementSize) must match after link.
assert.deepEqual(dviLinkedProperties.map(field => nameText(slotOf(field, 0x20))),
  dataVaultImage.fields.map(field => field.name), 'DataVaultImage property order');
assert.deepEqual(dviLinkedProperties.map(field => propertyKindOf(field)),
  dataVaultImage.fields.map(field => field.kind), 'DataVaultImage property classes');
for (const [i, field] of dviLinkedProperties.entries()) {
  const expected = dataVaultImage.fields[i];
  const oracleRef = dviOracleFields.find(f => f.entry.name === expected.name)?.ref;
  assert.ok(oracleRef, `oracle has property ${expected.name}`);
  const oracleProp = readPropertyMetadata(deusExAsset, oracleRef);
  assert.equal(slotOf(field, 0x34), oracleProp.arrayDim, `${expected.name} serialized ArrayDim`);
  assert.equal(slotOf(field, 0x34), expected.arrayDim, `${expected.name} recorded ArrayDim`);
  assert.equal(slotOf(field, 0x38), expected.elementSize, `${expected.name} linked ElementSize`);
  assert.equal(slotOf(field, 0x3c), oracleProp.propertyFlags, `${expected.name} serialized PropertyFlags`);
  assert.ok(Number.isInteger(slotOf(field, 0x48)), `${expected.name} received a linked Offset`);
}
assert.equal(slotOf(dviObject, 0x3c), layout.dataVaultImagePropertiesSize,
  'linked PropertiesSize matches the recorded class layout');

// PlayerPawn correction: the Engine registration exists (0x1058c160 /
// 0x10301ff0) — if the closure constructed it, Bind must have landed the
// real constructor rather than the missing-record fallback.
const playerPawnExportIndex = engineLinker.pkg.exports.findIndex(e => e.path === 'PlayerPawn');
if (playerPawnExportIndex >= 0 && engineLinker.exports[playerPawnExportIndex].object) {
  const pp = engineLinker.exports[playerPawnExportIndex].object;
  assert.equal(pp.nativeConstructor, ENGINE_CLASSES.PlayerPawn.internalCtor,
    'PlayerPawn binds its registered Engine constructor');
}

// The curated set — DeusExWeapon ahead of its subclass WeaponAssaultGun, so
// the superclass preload lands inside the parent's own run.
for (const className of [
  'DeusExWeapon', 'WeaponAssaultGun', 'DeusExPlayer', 'Gray', 'Rocket',
  'MenuScreenCustomizeKeys',
]) {
  verifyClassExport(className);
}

// No tag anywhere in the closure took a native warn-and-skip path.
const tagSkips = events.filter(event => [
  'TagUnmatched', 'TagTypeMismatch', 'TagArrayIndex', 'TagStructMismatch', 'TagNotSerializable',
].includes(event.op));
assert.equal(tagSkips.length, 0, `no tag warn-and-skip events: ${JSON.stringify(
  tagSkips.slice(0, 5).map(event => ({op: event.op, tag: event.tag?.text})))}`);

// Closure accounting — report the measured closure; every serialize ran a
// recovered body, every construct went through CreateExport.
const serializedCount = events.filter(event => event.op === 'PreloadSerializeEnter').length;
const constructedCount = events.filter(event => event.op === 'ConstructObject').length;
const reinitCount = events.filter(event => event.op === 'ConstructReinit').length;
const classExportCount = events.filter(event =>
  event.op === 'ConstructObject' && sameRecord(classRecordOf(event.object), classStatic)).length +
  reinitCount;
console.log(`preload closure: ${serializedCount} serialized, ${constructedCount} constructed ` +
  `(${reinitCount} static re-inits), ${classExportCount} class exports`);
assert.ok(serializedCount > 0 && constructedCount > 0, 'closure produced objects');
assert.equal(assertions.length, 0, `no native assert fired: ${JSON.stringify(assertions.slice(0, 3))}`);
const realWarnings = warnings.filter(w => !['name-reference', 'exists'].includes(w.kind));
assert.equal(realWarnings.length, 0, `no warnings: ${JSON.stringify(realWarnings.slice(0, 5))}`);

// Shipped-shape census over every serialized DeusEx.u class export: which
// tag types and array-index encodings the GOTY package actually contains.
{
  let classCount = 0;
  let tagCount = 0;
  let indexedClasses = 0;
  let maxArrayIndex = 0;
  let maxArrayIndexClass = null;
  const typeCounts = new Map();
  for (const [i, entry] of deusExLinker.pkg.exports.entries()) {
    if (entry.className !== 'Class' || !entry.serialSize) continue;
    const cls = readClass(deusExAsset, i + 1);
    classCount += 1;
    let indexed = false;
    for (const tag of cls.properties) {
      tagCount += 1;
      typeCounts.set(tag.type, (typeCounts.get(tag.type) ?? 0) + 1);
      assert.notEqual(tag.type, 9, `${entry.path} ships an ArrayProperty tag`);
      assert.notEqual(tag.type, 8, `${entry.path} ships a type-8 tag`);
      assert.ok(tag.arrayIndex < 128,
        `${entry.path}.${tag.name} ships a multi-byte array index`);
      if (tag.arrayIndex > 0) indexed = true;
      if (tag.arrayIndex > maxArrayIndex) {
        maxArrayIndex = tag.arrayIndex;
        maxArrayIndexClass = entry.name;
      }
    }
    if (indexed) indexedClasses += 1;
  }
  const typeSummary = Object.fromEntries([...typeCounts.entries()].sort((a, b) => a[0] - b[0]));
  console.log(`shipped defaults: ${classCount} classes, ${tagCount} tags, ` +
    `types ${JSON.stringify(typeSummary)}, max arrayIndex ${maxArrayIndex} ` +
    `(${maxArrayIndexClass}), ${indexedClasses} classes with arrayIndex>0`);
  assert.equal(classCount, 1158, 'DeusEx.u serialized class count');
  assert.equal(tagCount, 13865, 'DeusEx.u shipped default-tag count');
  assert.deepEqual(typeSummary,
    {1: 523, 2: 1375, 3: 1075, 4: 2895, 5: 4192, 6: 91, 10: 1483, 13: 2231},
    'DeusEx.u shipped tag-type totals');
  assert.equal(indexedClasses, 464, 'classes with an arrayIndex>0 tag');
  assert.equal(maxArrayIndex, 70, 'largest shipped array index');
  assert.equal(maxArrayIndexClass, 'MenuScreenCustomizeKeys', 'largest shipped array index class');
}

// Every struct default in the set was value-compared; a nonempty list means a
// set member carries a member shape this comparator does not decode.
assert.equal(skippedStructValues.length, 0,
  `struct payloads skipped by the comparator: ${JSON.stringify(skippedStructValues)}`);

console.log('validate-linker-preload: 7 classes preload/link/defaults verified against the decoded package');
