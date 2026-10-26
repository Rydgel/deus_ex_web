/** Shared synchronous loader graph. Original contracts and remaining services:
 * docs/script-load-graph.md. Package I/O is supplied before entering the graph.
 */
import {Reader} from '../unreal/package.mjs';
import {expandScriptExpression, skipExpandedScriptExpression} from '../unreal/classes.mjs';
import {
  linkerLoadArchive, linkerPreload, serializeLoadedObject, serializeLoadedField,
  serializeLoadedStruct, serializeLoadedState, serializeLoadedClass,
  serializeLoadedFunction, serializeLoadedProperty, serializeLoadedEnum,
  serializeLoadedConst, serializeLoadedTextBuffer, serializeTaggedPropertiesLoad,
} from './script-linker-preload.mjs';
import {createLinkerExport, CREATE_EXPORT_CONTRACT} from './script-create-export.mjs';
import {buildLinkerExportHash, verifyLinkerImports, linkerIndexToObject} from './script-linker-imports.mjs';
import {bindScriptClassConstructor} from './script-class-bind.mjs';
import {bindScriptFunction, getFieldOwnerClass, getScriptClassNameCPP} from './script-function-bind.mjs';
import {conditionalPostLoad, postLoadObject, postLoadField, postLoadStruct,
  postLoadFunction, postLoadClass} from './script-post-load.mjs';
import {beginScriptLoad, endScriptLoad} from './script-static-load-object.mjs';
import {resolveNameNative} from './script-resolve-name.mjs';
import {createScriptPackage} from './script-package-construction.mjs';
import {attachLinkerLazyLoader, detachLinkerLazyLoader} from './script-linker-lazy-loader.mjs';
import {constructTexture, constructPalette, serializeTexture, serializePalette,
  postLoadTexture, loadTextureLazyBytes, removeResourceArray} from './script-texture-load.mjs';
import {MUSIC_NATIVE, constructMusic, serializeMusic} from './script-music-load.mjs';
import {constructSoundNative} from './script-sound-construction.mjs';
import {FONT_NATIVE, constructFont, serializeFont} from './script-font-load.mjs';
import {constructLodMesh, serializeLodMesh, loadMeshLazyArray, reallocateMeshArray, constructMesh, serializeMesh} from './script-mesh-load.mjs';
import {meshPayloadView} from './lodmesh-payload.mjs';
import {serializeSoundLifecycle, serializeSoundByteArray} from './script-sound-lifecycle.mjs';
import {loadLazyByteArray} from './script-lazy-byte-array.mjs';
import {loadSoundDataNative, loadSoundDataSpecial} from './script-sound-load.mjs';
import {getPeriod} from './script-sound-period.mjs';
import {linkScriptStruct} from './script-struct-link.mjs';
import {linkScriptState} from './script-state-link.mjs';
import {linkScriptClass} from './script-class-link.mjs';
import {linkScriptProperty} from './script-property-link.mjs';
import {serializeScriptPropertyItem} from './script-property-serialize-item.mjs';
import {loadConfig as loadObjectConfig, defaultsObject} from './script-config.mjs';
import {CORE_CLASSES, ENGINE_CLASSES, DEUSEX_CLASSES, findNativeClassConstructor,
  isNativeClassRegisteredDynamic} from './script-native-class-registry.mjs';

// The longest Class/SuperField chain isA follows before it calls the chain a cycle (a real chain is a few records long).
const MAX_CHAIN = 1024;

// Service objects with accessor members are dictionary-mode objects whose
// accessors are defined on the object itself. As object literals, each graph's
// accessors went into the transition tree of the literal's map, which belongs
// to the literal's allocation site and lives as long as this module; V8 kept
// the descriptor arrays of that tree, accessor closures included, and with
// them the first graphs' scopes (their runtimes, object images and Rust VM
// memory) after their map was left.
const accessorMembers = (data, accessors) => {
  const object = Object.assign(Object.create(null), data);
  for (const [name, get, set] of accessors) Object.defineProperty(object, name, {get, set, enumerable: true, configurable: true});
  return object;
};

export function createScriptLoadGraph({packageAssets = new Map(), captureEvents = false,
  nativeFunctions = {}, lifecycle = {}, resourceServices = null,
  meshLoadServices = resourceServices, classSerialized = null} = {}) {
  if (resourceServices) {
    for (const name of ['seconds', 'getLazyLoad', 'setLazyLoad', 'mipBias']) {
      if (typeof resourceServices[name] !== 'function')
        throw new Error(`Native resource loading requires ${name}`);
    }
  }
  if (meshLoadServices && typeof meshLoadServices.getLazyLoad !== 'function')
    throw new Error('Native mesh loading requires getLazyLoad');
  const boundaries = new Set(['native-constructor-defaults', 'metaclass-bootstrap-defaults',
    'native-resource-payloads', 'postload-and-heap-ownership']);
  // GConfig (config-cache.mjs), bound by the runtime once the installed .ini
  // files are read; LoadConfig reads it synchronously inside the load.
  let configCache = null;
  // Object vtables an *instance* of each metaclass carries at +0x00 — read by
  // the property-link bodies.  Scalar kinds come from the recovered link tables.
  const KIND_VTABLE = new Map(Object.entries({
    Object: 0x10179dfc,
    Package: 0x101753a0,
    TextBuffer: 0x10175548,
    Field: 0x1017561c,
    Enum: 0x10175878,
    Const: 0x101759c8,
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
    [0x14, 'Core'],
    [0x17, 'UnrealI'],
    [0x18, 'UnrealShare'],
    [0xa2, 'Camera'],
    [0x298, 'Package'],
    [0x29b, 'Class'],
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
  for (let index = 0; index <= 0x29b; index += 1) {
    intern(GNAMES_PINNED.get(index) ?? `__gnames_reserved_${index}`);
  }
  const nameText = index => (Number.isInteger(index) ? gnames[index] : index) ?? `<name ${index}>`;

  // ---------------------------------------------------------------------------
  // Object records: {nativeAddress, nativeSlots: Map(offset -> {value, width})}.
  // Pointer slots hold records; FArray slots hold {data,num,max}.
  // ---------------------------------------------------------------------------

  let syntheticAddress = 0x70000000;
  const objectHash = new Map(); // outerAddr:nameIndex:classAddr -> record
  let loadedObjects = [];       // the GObjLoaded array (0x1029e638); see suspendLoadQueue
  const events = captureEvents ? [] : {length: 0, push() {}};
  const warnings = [];
  const assertions = [];
  const linkOrder = captureEvents ? [] : {push() {}};
  const createStack = [];       // the linker currently inside CreateExport

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
    // The inlined native IsA: +0x24 Class then +0x28 SuperField to null. A class chain is a few records long; one longer than
    // MAX_CHAIN can only be a cycle (the native loops forever there). Counting instead of a visited set: isA runs for every field of
    // every struct walk at link time (a set per call cost about 0.3 s of each map load).
    let cls = classRecordOf(object);
    for (let steps = 0; cls !== null && cls !== undefined; steps++) {
      if (sameRecord(cls, target)) return true;
      if (steps === MAX_CHAIN) throw new Error('Cyclic Class ancestry in fixture IsA');
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
  // Supplied package bytes/tables -> linker record + embedded archive.
  // Asset fetching completes outside this graph before synchronous loading.
  // ---------------------------------------------------------------------------

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
  const graphView = {slotOf, superOf, isA, fullName, nameText, intern, propertyKindOf, classStatic};
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
    let superRecord = superRow
      ? staticRecords.get(`${superRow.pkgName}.${superRow.name}`) : null;
    // Core.Object's registration argument is its own static class pointer;
    // the original UStruct/UClass construction normalizes that to null.
    if (superRecord === record) superRecord = null;
    writeSlot(record, 0x28, superRecord);
    record.base = superRecord;
    // Native UClass construction installs its registered instance size even
    // when no script export has been loaded (notably Sound and Package).
    writeSlot(record, 0x3c, row.instanceSize ?? 0);
    objectHash.set(`${addr(packageRoot(key.split('.')[0]))}:${slotOf(record, 0x20)}:${addr(classStatic)}`, record);
  }
  // Package roots are UPackage instances — patch their class now that it exists.
  for (const record of packageRoots.values()) {
    writeSlot(record, 0x24, staticRecords.get('Core.Package'));
  }

  // Sound has no Engine.u class export. These selected bootstrap fields and
  // its entire 44-byte zero default tail are recovered from the original
  // initializer + UClass::Register, not inferred from absent package tags.
  // This does not initialize other native-only resource classes.
  if (resourceServices) {
    const soundClass = staticRecords.get('Engine.Sound');
    writeSlot(soundClass, 0x3c, 0x54);
    writeSlot(soundClass, 0x484, 0x52);
    writeSlot(soundClass, 0x49c, objectStatic);
    writeSlot(soundClass, 0x4a0, intern('System'));
    writeSlot(soundClass, 0x4e4, 0x10101041);
    soundClass.defaults = {data: new Map(), num: 0x54, max: 0x54};
    for (let offset = 0x28; offset < 0x54; offset += 4) soundClass.defaults.data.set(offset, 0);
    soundClass.defaultsSource = 'original-native-sound-registration';
    // Font is native-only as well: initializer 0x103855b0 registers size
    // 0x38, raw flags 0 (registered 0x12), Super/Within Core.Object, config
    // System and UObject's static constructor; UClass::Register leaves a
    // 16-byte zero default tail (scripts/native-font-load-oracle.py).
    const fontClass = staticRecords.get('Engine.Font');
    writeSlot(fontClass, 0x3c, FONT_NATIVE.instanceSize);
    writeSlot(fontClass, 0x484, FONT_NATIVE.registeredClassFlags);
    writeSlot(fontClass, 0x49c, objectStatic);
    writeSlot(fontClass, 0x4a0, intern('System'));
    writeSlot(fontClass, 0x4e4, FONT_NATIVE.staticConstructor);
    fontClass.defaults = {data: new Map(), num: FONT_NATIVE.instanceSize, max: FONT_NATIVE.instanceSize};
    for (let offset = 0x28; offset < FONT_NATIVE.instanceSize; offset += 4) fontClass.defaults.data.set(offset, 0);
    fontClass.defaultsSource = 'original-native-font-registration';
    // Music is native-only too: initializer 0x10370eb0 registers size 0x4c,
    // raw flags 0x40 (registered 0x52), Super/Within Core.Object, config
    // System and UObject's static constructor (docs/script-music-load.md).
    const musicClass = staticRecords.get('Engine.Music');
    writeSlot(musicClass, 0x3c, MUSIC_NATIVE.instanceSize);
    writeSlot(musicClass, 0x484, MUSIC_NATIVE.registeredClassFlags);
    writeSlot(musicClass, 0x49c, objectStatic);
    writeSlot(musicClass, 0x4a0, intern('System'));
    writeSlot(musicClass, 0x4e4, MUSIC_NATIVE.staticConstructor);
    musicClass.defaults = {data: new Map(), num: MUSIC_NATIVE.instanceSize, max: MUSIC_NATIVE.instanceSize};
    for (let offset = 0x28; offset < MUSIC_NATIVE.instanceSize; offset += 4) musicClass.defaults.data.set(offset, 0);
    musicClass.defaultsSource = 'original-native-music-registration';
  }
  if (meshLoadServices) {
    // Engine native-only initializers + original UClass::Register. Defaults
    // are zero bytes; the instance constructors subsequently write nonzeros.
    for (const [name, size] of [['Primitive', 0x54], ['Mesh', 0x12c], ['LodMesh', 0x1b0]]) {
      const cls = staticRecords.get(`Engine.${name}`);
      writeSlot(cls, 0x3c, size); writeSlot(cls, 0x484, 0x12);
      writeSlot(cls, 0x49c, objectStatic); writeSlot(cls, 0x4a0, intern('System'));
      writeSlot(cls, 0x4e4, 0x10101041);
      cls.defaults = {data: new Map(), num: size, max: size};
      for (let offset = 0x28; offset < size; offset += 4) cls.defaults.data.set(offset, 0);
      cls.defaultsSource = 'original-native-mesh-registration';
    }
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
    const file = packageAssets.get(key);
    if (!file) throw new Error(`Package file lookup is unsupported for missing ${pkgName}`);
    const pkg = file.pkg;
    const linker = {
      kind: 'ULinkerLoad',
      packageName: file.name,
      pkg,
      bytes: file.bytes,
      asset: file,
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
      imports: pkg.imports.map(entry => ({
        classPackage: intern(entry.classPackage),
        className: intern(entry.className),
        packageIndex: entry.outer,
        objectName: intern(entry.name),
        object: null, sourceLinker: null, sourceIndex: -1,
      })),
      summaryImportCount: pkg.tables.imports.count,
      loadFlags: 0,
      verified: 0,
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
    archive.preload = object => preloadOnLinker(object, archive, linker);
    archive.preloadStruct = structure => preloadOnLinker(structure, archive, linker);
    archive.serializeItem = (cell, detail) =>
      serializeScriptPropertyItem(detail.property, archive, cell, detail, itemServices);
    writeSlot(linker.root, 0x10, linker);
    buildLinkerExportHash(linker, importServices);
    verifyLinkerImports(linker, importServices);
    return linker;
  }

  function indexToObject(linker, ref) {
    return linkerIndexToObject(linker, ref, importServices);
  }

  const importState = {importCount: 0};
  const loadState = accessorMembers({nest: 0, registrationQueueHead: null, loadedMax: 0},
    [['loaderCleanupState', () => importState.importCount, value => { importState.importCount = value; }]]);
  const importFields = {name: 0x20, class: 0x24, superField: 0x28, flags: 0x1c,
    classFlags: 0x484, packageFlags: 0x30};
  const importServices = {
    state: importState,
    packageClass: staticRecords.get('Core.Package'), classClass: classStatic,
    read: (object, field) => slotOf(object, importFields[field]),
    write: (object, field, value) => writeSlot(object, importFields[field], value),
    nameText,
    nameIndex: (text, mode) => { if (mode !== 1) throw new Error('Unsupported FName find mode'); return intern(text); },
    createPackage(outer, text) {
      if (outer !== null) throw new Error('Nested CreatePackage service is unsupported');
      return packageRoot(text);
    },
    getPackageLinker(root, filename, flags, sandbox, guid) {
      if (filename !== null || flags !== 8 || sandbox !== null || guid !== null)
        throw new Error('Unsupported GetPackageLinker arguments');
      return buildLinker(nameText(slotOf(root, 0x20)));
    },
    staticFindObject(cls, outer, text, exact) {
      if (exact !== 0) throw new Error('Unsupported StaticFindObject exact-class mode');
      if (cls === staticRecords.get('Core.Package') && outer === null) {
        return packageRoots.get(text.toLowerCase()) ?? null;
      }
      return objectHash.get(`${addr(outer)}:${intern(text)}:${addr(cls)}`) ?? null;
    },
    createExport(linker, index) {
      createStack.push(linker);
      try {
        return createLinkerExport({linker, index}, createExportServices).object;
      } finally {
        createStack.pop();
      }
    },
  };

  // ---------------------------------------------------------------------------
  // CreateExport services
  // ---------------------------------------------------------------------------

  const createExportServices = accessorMembers({
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
      return preloadOnLinker(object, creating.archive, creating);
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
        if (existing.resourceConstructed)
          throw new Error(`Native resource reconstruction/destruction is unsupported: ${fullName(existing)}`);
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
        initializeResource(existing);
        return existing;
      }
      const kind = nameText(slotOf(cls, 0x20));
      const record = makeRecord({cls, outer, name, flags, kind});
      initializeResource(record);
      objectHash.set(key, record);
      events.push({op: 'ConstructObject', object: record, cls: kind, name: nameText(name)});
      return record;
    },
    setLinker(object, linker, index) {
      writeSlot(object, 0x10, linker);
      writeSlot(object, 0x14, index);
    },
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
  }, [['loadedObjects', () => loadedObjects]]);

  // ---------------------------------------------------------------------------
  // Preload + serialize services
  // ---------------------------------------------------------------------------

  function propertyKindOf(object) {
    const cls = classRecordOf(object);
    return cls ? nameText(slotOf(cls, 0x20)) : null;
  }

  const serializedMetadataKinds = new Set(['Object', 'Package', 'Class', 'State', 'Function',
    'Struct', 'Field', 'Enum', 'Const', 'TextBuffer', 'Property', 'ByteProperty',
    'IntProperty', 'FloatProperty', 'NameProperty', 'ObjectProperty', 'ClassProperty',
    'BoolProperty', 'StrProperty', 'ArrayProperty', 'FixedArrayProperty', 'MapProperty',
    'StructProperty'].map(kind => `Core.${kind}`));

  function initializeResource(object) {
    const kind = fullName(classRecordOf(object));
    if (kind === 'Engine.LodMesh' || kind === 'Engine.Mesh' ? !meshLoadServices :
      !resourceServices || !['Engine.Texture', 'Engine.Palette', 'Engine.Sound', 'Engine.Font', 'Engine.Music'].includes(kind)) return;
    const source = classRecordOf(object)?.defaults?.data;
    if (!(source instanceof Map)) throw new Error(`Resource construction requires loaded class defaults: ${kind}`);
    object.instanceValues = new Map([...source].filter(([offset]) => offset >= 0x28)
      .map(([offset, value]) => [offset, deepCopy(value)]));
    if (kind === 'Engine.LodMesh') constructLodMesh(object, meshServices);
    else if (kind === 'Engine.Mesh') constructMesh(object, meshServices);
    else if (kind === 'Engine.Sound') {
      // Existing Sound translations use semantic names. Accessors preserve one
      // backing store for these names and the shared native field offsets.
      Object.defineProperty(object, 'nativeVtable', {get: () => slotOf(object, 0),
        set: value => writeSlot(object, 0, value)});
      for (const [name, offset] of Object.entries({soundData: 0x28, formatName: 0x44,
        serializedByteCount: 0x48, durationCache: 0x4c, copyField: 0x50})) {
        Object.defineProperty(object, name, {
          get: () => name === 'soundData' ? object.instanceValues.get(offset) || null : object.instanceValues.get(offset),
          set: value => object.instanceValues.set(offset, value),
        });
      }
      constructSoundNative(object, soundServices);
    } else if (kind === 'Engine.Font') constructFont(object, fontServices);
    else if (kind === 'Engine.Music') constructMusic(object, musicServices);
    else (kind === 'Engine.Texture' ? constructTexture : constructPalette)(object, textureServices);
    object.resourceConstructed = kind;
  }

  // Allocation is host storage, while Num/Max, element order and reallocation
  // decisions are made by the recovered bodies. Native heap ownership is open.
  const textureServices = {
    ...resourceServices,
    read(object, offset, type) {
      if (offset < 0x28) return slotOf(object, offset);
      const value = object.instanceValues.get(offset) ?? (type === 'pointer' ? null : 0);
      return type === 'u8' ? value & 255 : value;
    },
    write(object, offset, value, type) {
      if (offset < 0x28) { writeSlot(object, offset, value); return; }
      // Native color words and tagged Color structs share the same backing cell.
      if (type === 'u32' && (offset === 0x44 || offset === 0x48)) {
        const property = [...structFieldChain(classRecordOf(object))]
          .find(field => slotOf(field, 0x48) === offset);
        if (propertyKindOf(property) !== 'StructProperty') throw new Error('Bitmap color layout is unresolved');
        value = Object.fromEntries([...structFieldChain(slotOf(property, 0x5c))]
          .map(field => [nameText(slotOf(field, 0x20)), (value >>> (8 * slotOf(field, 0x48))) & 255]));
      }
      object.instanceValues.set(offset, value);
    },
    objectConstructor: object => writeSlot(object, 0, 0x10179dfc),
    objectSerialize: (object, archive) => serializeLoadedObject(object, archive, preloadServices, {events}),
    objectPostLoad: object => postLoadObject(object, postServices),
    arrayRealloc(a) {
      if (!a.max) { a.data = null; return; }
      a.data ??= [];
      a.data.length = a.max;
    },
    arrayRemove: (a, index, amount, size) => removeResourceArray(a, index, amount, size, textureServices),
    freeArray: a => { a.data = null; },
    readerTell: reader => reader.offset,
    attach: (archive, lazy) => attachLinkerLazyLoader(archive, lazy, textureServices),
    detach: (archive, lazy) => detachLinkerLazyLoader(archive, lazy, textureServices),
  };

  const fontServices = {
    read: textureServices.read, write: textureServices.write,
    objectConstructor: textureServices.objectConstructor,
    objectSerialize: textureServices.objectSerialize,
    getLazyLoad: () => resourceServices.getLazyLoad(),
    setLazyLoad: value => resourceServices.setLazyLoad(value),
    // FArchive vtable +0x18: the linker's operator<<(UObject*&) -> IndexToObject.
    serializeObject: archive => archive.readObject().object,
    arrayRealloc: (a, size) => textureServices.arrayRealloc(a, size),
    arrayRemove: textureServices.arrayRemove,
    freeArray: textureServices.freeArray,
    loadLazyArray(lazy) {
      // Texture mips hold TLazyArray<BYTE>; its vtable slot 0 is Load 0x1030cbb0.
      if (lazy?.vtable !== FONT_NATIVE.lazyArrayVtable) throw new Error('Font page mip is not a byte lazy array');
      return loadTextureLazyBytes(lazy, textureServices);
    },
    failAssert: detail => { assertions.push({kind: 'UFont::Serialize', ...detail}); },
  };
  const soundServices = {
    getSerializationFlag: () => resourceServices.getLazyLoad(),
    setSerializationFlag: value => resourceServices.setLazyLoad(value),
    uobjectSerialize: (object, archive) => serializeLoadedObject(object, archive, preloadServices, {events}),
    serializeName: (reference, archive) => { reference.set(archive.readName().name); return archive; },
    attachLazyLoader: (archive, data) => attachLinkerLazyLoader(archive, data, soundServices),
    readerTell: reader => reader.offset,
    tell: archive => archive.tell(),
    seek: (archive, position) => archive.seek(position),
    countBytes: (archive, num, max) => archive.countBytes(num, max),
    serializeCompact: (archive, reference) => { reference.value = archive.readCompact(); },
    serializeRaw(archive, reference, width) {
      if (reference.value instanceof Uint8Array) reference.value.set(archive.readRaw(width));
      else if (width === 0) archive.readRaw(0);
      else if (width === 4) reference.value = archive.readU32();
      else throw new Error('Unresolved Sound raw archive storage');
    },
    arrayRealloc(array, size) {
      if (size !== 1) return textureServices.arrayRealloc(array, size);
      const old = array.data;
      array.data = array.max ? new Uint8Array(array.max) : null;
      if (old && array.data) array.data.set(old.subarray(0, Math.min(old.length, array.max)));
    },
  };
  const meshServices = {
    read: (object, offset) => offset < 0x28 ? slotOf(object, offset) : object.instanceValues.get(offset),
    write(object, offset, value, type) {
      if (offset < 0x28) { writeSlot(object, offset, value); return; }
      object.instanceValues.set(offset, type === 'u8'
        ? ((object.instanceValues.get(offset) ?? 0) & 0xffffff00) | (value & 255) : value);
    },
    objectConstructor: object => writeSlot(object, 0, 0x10179dfc),
    objectSerialize: (object, archive) => serializeLoadedObject(object, archive, preloadServices, {events}),
    arrayRealloc(array, size) {
      events.push({op: 'MeshRealloc', elementSize: size, num: array.num, max: array.max});
      reallocateMeshArray(array, size);
    },
    referenceToken: object => addr(object) ?? 0,
    getLazyLoad: () => meshLoadServices.getLazyLoad(),
    attach: (archive, lazy) => attachLinkerLazyLoader(archive, lazy, textureServices),
  };
  // UMusic: its Data is the same TLazyArray<BYTE> the texture mips hold.
  const musicServices = {
    ...textureServices,
    read: (object, offset) => object.instanceValues.get(offset),
    write: (object, offset, value) => { object.instanceValues.set(offset, value); },
    writeVtable: (object, vtable) => writeSlot(object, 0, vtable),
    uobjectSerialize: (object, archive) => serializeLoadedObject(object, archive, preloadServices, {events}),
  };
  const soundByteServices = {
    read: (object, key) => object[key],
    write: (object, key, value) => { object[key] = value; },
    tell: soundServices.tell, seek: soundServices.seek,
    serializeArray: (archive, array) => serializeSoundByteArray({array}, archive, soundServices),
  };
  function loadSoundResource(object, {special = false} = {}) {
    if (object.resourceConstructed !== 'Engine.Sound') throw new Error('Sound loading requires a constructed native Sound');
    const data = object.soundData;
    if (special) return loadSoundDataSpecial(data, soundByteServices);
    return loadSoundDataNative(data, {
      ...soundByteServices,
      loadArray: value => loadLazyByteArray(value, soundByteServices),
      getPeriod: value => getPeriod(value, {lazyLoad: current => loadLazyByteArray(current, soundByteServices)}),
      readAudio: resourceServices.readAudio,
    });
  }

  function requireSerializer(object) {
    const kind = fullName(classRecordOf(object));
    if ((kind === 'Engine.LodMesh' || kind === 'Engine.Mesh') && slotOf(object, 0x10)?.pkg.version !== 68)
      throw new Error(`No recovered ${kind === 'Engine.Mesh' ? 'Mesh' : 'LodMesh'} load archive version for ${fullName(object)}`);
    if (!serializedMetadataKinds.has(kind) && object.resourceConstructed !== kind)
      throw new Error(`ULinkerLoad::Preload has no recovered Serialize body for ${fullName(object)} (${kind})`);
  }

  function preloadOnLinker(object, archive, linker) {
    // Admission is a host boundary before entering the original body, which
    // clears RF_NeedLoad before virtual Serialize. Do not silently consume a
    // resource through the shorter UObject serializer and strand its flags.
    if (slotOf(object, 0x10) && (slotOf(object, 0x1c) & 0x200)) requireSerializer(object);
    return linkerPreload(object, {archive, linker, events}, preloadServices);
  }

  /** Serialize dispatch = the object's Class vtable +0x28 slot. */
  function serializeDispatch(object, archive) {
    requireSerializer(object);
    if (object.resourceConstructed === 'Engine.Texture') return serializeTexture(object, archive, textureServices);
    if (object.resourceConstructed === 'Engine.Palette') return serializePalette(object, archive, textureServices);
    if (object.resourceConstructed === 'Engine.Sound') return serializeSoundLifecycle(object, archive, soundServices);
    if (object.resourceConstructed === 'Engine.Font') return serializeFont(object, archive, fontServices);
    if (object.resourceConstructed === 'Engine.Music') return serializeMusic(object, archive, musicServices);
    if (object.resourceConstructed === 'Engine.LodMesh') {
      serializeLodMesh(object, archive, meshServices);
      const linker = slotOf(object, 0x10), index = slotOf(object, 0x14);
      object.meshPayload = meshPayloadView(object, meshServices, {archive, entry: linker.pkg.exports[index]});
      return;
    }
    if (object.resourceConstructed === 'Engine.Mesh') {
      serializeMesh(object, archive, meshServices);
      const linker = slotOf(object, 0x10), index = slotOf(object, 0x14);
      object.meshPayload = meshPayloadView(object, meshServices, {archive, entry: linker.pkg.exports[index], classic: true});
      return;
    }
    if (isA(object, classStatic)) {
      const result = serializeLoadedClass(object, archive, preloadServices, {events});
      // The host's process-lifetime class defaults (classSerialized: script-class-loader.mjs), once the class's Defaults are built and
      // before a subclass's InitClassDefaultObject copies them or an object is constructed from them.
      classSerialized?.(object);
      return result;
    }
    if (isA(object, stateStatic)) return serializeLoadedState(object, archive, preloadServices, {events});
    if (isA(object, functionStatic)) return serializeLoadedFunction(object, archive, preloadServices, {events});
    if (isA(object, propertyStatic)) return serializeLoadedProperty(object, archive, preloadServices, {events});
    if (sameRecord(classRecordOf(object), enumStatic)) return serializeLoadedEnum(object, archive, preloadServices, {events});
    if (sameRecord(classRecordOf(object), constStatic)) return serializeLoadedConst(object, archive, preloadServices, {events});
    if (sameRecord(classRecordOf(object), textBufferStatic)) return serializeLoadedTextBuffer(object, archive, preloadServices, {events});
    if (isA(object, structStatic)) return serializeLoadedStruct(object, archive, preloadServices, {events});
    if (isA(object, fieldStatic)) return serializeLoadedField(object, archive, preloadServices, {events});
    // UPackage::Serialize 0x1015a470 forwards only to UObject::Serialize.
    if (sameRecord(classRecordOf(object), objectStatic) ||
        sameRecord(classRecordOf(object), staticRecords.get('Core.Package')))
      return serializeLoadedObject(object, archive, preloadServices, {events});
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
      preloadOnLinker(structure, context.archive, context.archive?.linker),
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
    // UClass::Serialize's LoadConfig(0,0,0) on the class default object
    // (0x1012829a). With GConfig bound (setConfig), the recovered body imports
    // the installed .ini values into the Defaults block; without it the call
    // stays a recorded boundary. docs/script-config.md.
    loadConfig: (data, propagate, classArgument, filename, cls) => {
      if (!configCache || !cls) { boundaries.add('config'); events.push({op: 'LoadConfig', boundary: true}); return; }
      events.push({op: 'LoadConfig', object: cls});
      loadObjectConfig(graphView, configCache, defaultsObject(graphView, cls, data),
        {propagate, cls: classArgument || null, filename: filename || null});
    },
    loadLocalized: () => { boundaries.add('localization'); events.push({op: 'LoadLocalized', boundary: true}); },
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
    preload: (object, archive) => preloadOnLinker(object, archive, archive.linker),
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


  function preload(object) {
    const linker = slotOf(object, 0x10);
    if (!linker || typeof linker !== 'object') throw new Error(`No owning linker for ${fullName(object)}`);
    preloadOnLinker(object, linker.archive, linker);
    return object;
  }

  // Metadata virtuals are selected from the recovered Core class identities.
  // A resource's UObject ancestry does not prove it inherits these bodies.
  const metadataPostLoad = new Map([
    ['Core.Object', postLoadObject], ['Core.Package', postLoadObject],
    ['Core.TextBuffer', postLoadObject], ['Core.Class', postLoadClass],
    ['Core.Function', postLoadFunction], ['Core.State', postLoadStruct],
    ['Core.Struct', postLoadStruct], ['Core.Field', postLoadField],
    ['Core.Enum', postLoadField], ['Core.Const', postLoadField],
    ...['Property', 'ByteProperty', 'IntProperty', 'FloatProperty', 'BoolProperty',
      'NameProperty', 'ObjectProperty', 'ClassProperty', 'StrProperty', 'ArrayProperty',
      'FixedArrayProperty', 'MapProperty', 'StructProperty'].map(kind => [`Core.${kind}`, postLoadField]),
  ]);
  if (resourceServices) {
    metadataPostLoad.set('Engine.Texture', object => postLoadTexture(object, textureServices));
    metadataPostLoad.set('Engine.Palette', postLoadObject);
    metadataPostLoad.set('Engine.Sound', postLoadObject); // Engine 0x1036fb20 forwards only to UObject
    metadataPostLoad.set('Engine.Font', postLoadObject); // vtable +0x20 -> 0x1040c72e -> Core UObject::PostLoad
    metadataPostLoad.set('Engine.Music', postLoadObject); // UMusic::PostLoad 0x10370df0 forwards only to UObject
  }
  if (meshLoadServices) {
    metadataPostLoad.set('Engine.LodMesh', postLoadObject); // original vtable +20 -> 0x1040c72e -> Core
    metadataPostLoad.set('Engine.Mesh', postLoadObject); // UMesh vtable 0x104290b8 +20 is the same 0x1040c72e
  }
  const postFields = {objectFlags: 0x1c, class: 0x24, outer: 0x18, superField: 0x28,
    classWithin: 0x49c, functionFlags: 0x6c, nativeIndex: 0x70, nativeFunction: 0x7c,
    linker: 0x10};
  const postServices = {
    ...nativeFunctions,
    classClass: classStatic,
    read(object, field) {
      if (field === 'imports' || field === 'reader' || field === 'object') return object[field];
      return slotOf(object, postFields[field]);
    },
    write(object, field, value) {
      if (field === 'object') { object.object = value; return; }
      const offset = postFields[field];
      if (offset === undefined) throw new Error(`Unmapped PostLoad field ${field}`);
      writeSlot(object, offset, value);
      if (field === 'objectFlags') object.objectFlags = value;
    },
    getName: object => nameText(slotOf(object, 0x20)),
    getOwnerClass: object => getFieldOwnerClass(object, postServices),
    getNameCPP: object => getScriptClassNameCPP(object, postServices),
    bind(object) {
      const kind = fullName(classRecordOf(object));
      events.push({op: 'Bind', object, kind});
      if (kind === 'Core.Class') return createExportServices.bind(object);
      if (kind === 'Core.Function') return bindScriptFunction(object, postServices);
      if (metadataPostLoad.get(kind) === postLoadField ||
          metadataPostLoad.get(kind) === postLoadStruct) return; // UField::Bind 0x10125be0
      throw new Error(`No recovered Bind for ${fullName(object)}`);
    },
    conditionalPostLoad(object) {
      const kind = fullName(classRecordOf(object));
      if ((slotOf(object, 0x1c) & 0x01000000) && !metadataPostLoad.has(kind))
        throw new Error(`No recovered PostLoad for ${fullName(object)} (${kind})`);
      return conditionalPostLoad(object, postServices);
    },
    postLoad(object) {
      const kind = fullName(classRecordOf(object));
      const body = metadataPostLoad.get(kind);
      if (!body) throw new Error(`No recovered PostLoad for ${fullName(object)} (${kind})`);
      events.push({op: 'PostLoad', object, kind});
      body(object, postServices);
    },
    getFullName: object => fullName(object),
    errorReceiver: lifecycle.errorReceiver,
    errorLogf: lifecycle.errorLogf,
  };
  const lifecycleServices = accessorMembers({
    ...postServices,
    loadState,
    logReceiver: lifecycle.logReceiver,
    logEndLoad: lifecycle.logEndLoad,
    reallocLoaded: lifecycle.reallocLoaded,
    preload: ({object}) => preload(object),
  }, [['loadedObjects', () => loadedObjects], ['loaders', () => [...linkers.values()]]]);
  /**
   * Play's class loader creates and preloads exports lazily and never runs
   * EndLoad, so its GObjLoaded and GImportCount hold entries the original
   * flushed during startup. The original outermost BeginLoad asserts an empty
   * queue. A dynamic load therefore holds that deferred state aside, runs the
   * recovered Begin/EndLoad over exactly the objects it creates, and restores
   * it. This is a host scheduling boundary, not a change to either body.
   */
  function suspendLoadQueue() {
    if (loadState.nest !== 0) throw new Error('A scoped load cannot start inside another load');
    const deferred = {queue: loadedObjects, imports: importState.importCount, max: loadState.loadedMax};
    loadedObjects = [];
    importState.importCount = 0;
    loadState.loadedMax = 0;
    // After a thrown load, objects it created stay pending in the deferred queue.
    return ({failed = false} = {}) => {
      if (failed) deferred.queue.push(...loadedObjects);
      else if (loadState.nest !== 0 || loadedObjects.length !== 0)
        throw new Error('Scoped load ended with GObjLoaded entries');
      loadedObjects = deferred.queue;
      importState.importCount = deferred.imports;
      loadState.loadedMax = deferred.max;
    };
  }

  // UObject::GObjNoRegister, cleared and set around BindPackage's DLL load.
  let objNoRegister = 1;

  /**
   * UPackage::BindPackage 0x10152ff0: for an unbound top-level package that
   * has not attempted a bind, appSprintf(Temp, "%s%s", appBaseDir(), Name),
   * GObjNoRegister=0, AttemptedBind(+0x2c)=1, DllHandle(+0x28)=
   * appGetDllHandle(Temp), GObjNoRegister=1. A bound DLL would then log
   * "Bound to %s%s" and run ProcessRegistrants, which is not translated.
   */
  function bindPackage(object, getDllHandle) {
    if (slotOf(object, 0x28) || slotOf(object, 0x18) || slotOf(object, 0x2c)) return;
    const name = nameText(slotOf(object, 0x20));
    objNoRegister = 0;
    writeSlot(object, 0x2c, 1);
    const handle = getDllHandle(name);
    if (handle !== null) throw new Error(`BindPackage bound ${name}.dll; ProcessRegistrants is not translated`);
    writeSlot(object, 0x28, null);
    objNoRegister = 1;
    events.push({op: 'BindPackage', package: object, name, dllHandle: null, objNoRegister});
  }

  /**
   * Services for the recovered StaticLoadObject (script-static-load-object.mjs)
   * over this graph's own linkers, FNames, CreateExport, Preload and PostLoad.
   * `appGetDllHandle(name)` must answer from the installed System directory
   * (null when <name>.dll is absent); `lifecycle` supplies Logf/Realloc.
   */
  function staticLoadServices({appGetDllHandle} = {}) {
    if (typeof appGetDllHandle !== 'function') throw new Error('StaticLoadObject requires appGetDllHandle');
    const packageClass = staticRecords.get('Core.Package');
    const resolveServices = {
      copyString: ({source}) => source,
      createPackage: ({outer, name}) => createScriptPackage({
        outer, name, packageClass,
        lookup: {
          resolveName: (outerRef, nameRef, options) =>
            resolveNameNative(outerRef, nameRef, {...options, services: resolveServices}),
          staticFindObject: ({classRef, outer: at, name: text, exactClass}) =>
            importServices.staticFindObject(classRef, at, text, exactClass),
        },
        internName: (text, mode) => {
          if (mode !== 1) throw new Error(`CreatePackage FName mode ${mode}`);
          return {index: intern(text), name: text};
        },
        staticAllocateObject({classRef, outer: at, nameText: text, size, flags}) {
          if (classRef !== packageClass || at !== null || size !== 0x34 || flags !== 4)
            throw new Error('Only a top-level UPackage allocation is supported');
          const record = packageRoot(text);
          events.push({op: 'CreatePackage', object: record, name: text});
          return record;
        },
        errorDevice: {address: 0x101a7c38},
        bindPackage: object => bindPackage(object, appGetDllHandle),
      }),
    };
    const exportView = (linker, index) => {
      const record = linker.exports[index];
      return {classIndex: record.classIndex, outerIndex: record.packageIndex,
        nameIndex: record.objectName, nextHash: record.hashNext,
        get object() { return linker.exports[index].object; }};
    };
    const createExport = ({linker, index}) => importServices.createExport(linker, index);
    createExport.body = CREATE_EXPORT_CONTRACT.body;
    return accessorMembers({
      loadState,
      read(object, field) {
        if (object?.kind === 'ULinkerLoad') {
          if (field === 'outer') return object.root;
          if (field === 'reader') return object.reader;
          if (field === 'imports') return object.imports;
        }
        if (field === 'object') return object.object ?? null;
        const offset = {outer: 0x18, nameIndex: 0x20, objectFlags: 0x1c, linker: 0x10}[field];
        if (offset === undefined) throw new Error(`StaticLoadObject field ${field} is unmapped`);
        return slotOf(object, offset) ?? null;
      },
      write(record, field, value) {
        if (field !== 'object') throw new Error(`StaticLoadObject write ${field} is unmapped`);
        record.object = value;
      },
      resolveName: (outerRef, nameRef, options) =>
        resolveNameNative(outerRef, nameRef, {...options, services: resolveServices}),
      readPackageExtension: () => '',
      copyString: ({source}) => source,
      findName(text, mode) {
        if (mode !== 1) throw new Error(`StaticLoadObject FName mode ${mode}`);
        return intern(text);
      },
      readHashHead: (linker, bucket) => linker.exportHash[bucket],
      readExport: exportView,
      readImportWord(linker, offset) {
        const record = linker.imports[Math.floor(offset / 0x1c)], field = offset % 0x1c;
        if (!record) throw new Error(`StaticLoadObject import word +0x${offset.toString(16)} is absent`);
        if (field === 8) return record.packageIndex;
        if (field === 12) return record.objectName;
        throw new Error(`StaticLoadObject import field +0x${field.toString(16)} is unmapped`);
      },
      createLinkerLoad({root}) {
        const name = nameText(slotOf(root, 0x20));
        if (!packageAssets.has(name.toLowerCase()))
          throw new Error(`DynamicLoadObject package bytes were not prepared: ${name}`);
        const linker = buildLinker(name);
        if (linker.root !== root) throw new Error(`First-load linker root diverged for ${name}`);
        events.push({op: 'CreateLinkerLoad', linker, name});
        return linker;
      },
      createExport,
      staticFindObject: ({classRef, outer, name, exactClass}) =>
        importServices.staticFindObject(classRef, outer, name, exactClass),
      preload: ({object}) => preload(object),
      conditionalPostLoad: object => postServices.conditionalPostLoad(object),
      logReceiver: lifecycle.logReceiver,
      logEndLoad: lifecycle.logEndLoad,
      reallocLoaded: lifecycle.reallocLoaded,
    }, [['loadedObjects', () => loadedObjects], ['loaders', () => [...linkers.values()]]]);
  }

  return {
    setConfig(cache) { configCache = cache; },
    get config() { return configCache; },
    packageAssets, boundaries, linkers, packageRoots, staticRecords, importState,
    events, warnings, assertions, linkOrder,
    get loadedObjects() { return loadedObjects; },
    suspendLoadQueue, staticLoadServices,
    buildLinker, indexToObject, preload, preloadServices,
    loadResourceBytes: lazy => loadTextureLazyBytes(lazy, textureServices),
    loadSoundResource,
    loadMeshArray: lazy => loadMeshLazyArray(lazy, meshServices),
    slotOf, writeSlot, addr, sameRecord, classRecordOf, superOf, isA, fullName,
    nameText, intern, propertyKindOf, structFieldChain,
    classStatic, structStatic, propertyStatic, boolPropertyStatic,
    loadState,
    beginLoad: () => beginScriptLoad(lifecycleServices, events),
    endLoad: () => endScriptLoad(lifecycleServices, events),
    conditionalPostLoad: postServices.conditionalPostLoad,
    loadExport(packageName, index) {
      return preload(indexToObject(buildLinker(packageName), index));
    },
  };
}
