/**
 * Narrow host boundary for Core `ULinkerLoad::CreateExport`.
 *
 * The native body is recovered in docs/script-create-export.md.  This module
 * owns the observable order, the four gates, the load-flag arithmetic, the two
 * inlined `IsA` walks and the two writes the body performs.  `IndexToObject`,
 * `Preload`, `StaticConstructObject`, `SetLinker`, `GetFullName` and `Logf`
 * stay host services with their recorded native addresses, because each has a
 * separate startup graph.
 *
 * A class export reaches this body with `ClassIndex == 0`, so `LoadClass`
 * becomes the hard-coded `Core.Class` metaclass and the constructed object is
 * itself a `UClass`: that is the metaclass class-loading route.  The body stops
 * at `UClass::Bind` and leaves `RF_NeedLoad` set; serializing the export's own
 * bytes, linking its field chain and producing its defaults belong to the
 * caller's preload stage, not here.
 *
 * The `appUnwindf` tail at `0x1012e43b`-`0x1012e4a2` is the structured-exception
 * unwind path and is deliberately not translated.
 */

export const CREATE_EXPORT_CONTRACT = Object.freeze({
  thunk: 0x101012fd,
  body: 0x1012e230,
  bodyEnd: 0x1012e4af,
  sourceFile: 'D:\\prj\\Clean\\Core\\Src\\UnLinker.h',
  // Export table pointer and record stride reached from the linker receiver.
  exportTableOffset: 0x84,
  exportRecordStride: 0x24,
  // FObjectExport slots, read directly from this body's (%esi) accesses.
  exportOffsets: Object.freeze({
    classIndex: 0x00,
    superIndex: 0x04,
    packageIndex: 0x08,
    objectName: 0x0c,
    objectFlags: 0x10,
    serialSize: 0x14,
    serialOffset: 0x18,
    object: 0x1c,
    hashNext: 0x20,
  }),
  // Linker slots reached from %ebx.
  linkerRootOffset: 0x28,
  contextFlagsOffset: 0xa0,
  archiveSubobjectOffset: 0xa4,
  preloadSlot: 0x10,
  bindSlot: 0x5c,
  // UObject/UField slots, already recovered in script-object-serialization.md.
  objectFlagsOffset: 0x1c,
  nameOffset: 0x20,
  classOffset: 0x24,
  superFieldOffset: 0x28,
  // Hard-coded static class identities.
  classStaticClass: 0x101f1c18,
  structStaticClass: 0x101f2618,
  // Native leaves.
  indexToObject: 0x10102c11,
  staticConstructObject: 0x10101771,
  setLinker: 0x10101631,
  getFullName: 0x1010240f,
  logf: 0x10102a95,
  errorDevice: 0x101a7c38,
  logDevice: 0x101a7c3c,
  loadedArrayData: 0x1029e638,
  loadedArrayAdd: 0x10102536,
  loadedArrayElementSize: 4,
  // Gates and arithmetic.
  publicFlag: 0x4,
  cameraName: 0xa2,
  loadFlagMask: 0x067f0025,
  loadFlagOr: 0x01000200,
  logName: 0x308,
  logFormat: 'Created %s',
  asserts: Object.freeze({
    objectName: Object.freeze({line: 0x313, text: 'Export.ObjectName!=NAME_None || !(Export.ObjectFlags&RF_Public)'}),
    loadClass: Object.freeze({line: 0x319, text: 'LoadClass'}),
    loadClassClass: Object.freeze({line: 0x31a, text: 'LoadClass->GetClass()==UClass::StaticClass()'}),
  }),
});

export class CreateExportBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', value = undefined, field = null} = {}) {
    super(message);
    this.name = 'CreateExportBoundaryError';
    this.code = `CREATE_EXPORT_${kind}`;
    this.value = value;
    this.field = field;
  }
}

const fail = (message, details) => {
  throw new CreateExportBoundaryError(message, details);
};

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`CreateExport ${label} service suspended; native path is synchronous`, {kind: 'ASYNC', value});
  }
  return value;
}

function requireFunction(value, name) {
  if (typeof value !== 'function') fail(`CreateExport requires ${name} service`, {kind: 'SERVICE'});
  return value;
}

function requireInt(value, name) {
  if (!Number.isInteger(value)) fail(`CreateExport requires int32 ${name}`, {kind: 'VALUE', value, field: name});
  return value;
}

function requireReference(value, name, {allowNull = false} = {}) {
  if (value === null || value === undefined) {
    if (allowNull) return null;
    fail(`CreateExport requires canonical ${name}`, {kind: 'REFERENCE', value, field: name});
  }
  const type = typeof value;
  if (type !== 'object' && type !== 'function' && type !== 'number') {
    fail(`CreateExport requires canonical ${name}`, {kind: 'REFERENCE', value, field: name});
  }
  return value;
}

/** Canonical identities may be the recovered address or a host object that
 * carries it, matching the comparison script-object-serialization.mjs uses for
 * the same hard-coded class pointers. */
function sameIdentity(value, identity) {
  if (value === null || value === undefined) return false;
  if (value === identity) return true;
  if (typeof identity === 'number') {
    return value === identity || value?.address === identity || value?.staticClass === identity;
  }
  return false;
}

function readSlot(object, field, services, label) {
  const read = requireFunction(services.read, 'read');
  const value = sync(read(object, field, {field}), `read ${field}`);
  if (value === undefined) {
    fail(`CreateExport ${label} did not expose ${field}`, {kind: 'FIELD', field, value: object});
  }
  return value;
}

/** The inlined native IsA: start at the object's Class `+0x24` and follow
 * SuperField `+0x28` until the pointer matches or the chain ends.  A chain that
 * runs out is not a match, which is what the native null exit computes. */
function isA(object, identity, services, label) {
  let cursor = readSlot(object, 'class', services, label);
  const seen = new Set();
  while (cursor !== null && cursor !== undefined) {
    if (sameIdentity(cursor, identity)) return true;
    if (typeof cursor === 'object' || typeof cursor === 'function') {
      if (seen.has(cursor)) {
        fail('CreateExport IsA walked a cyclic SuperField chain', {kind: 'REFERENCE', value: cursor});
      }
      seen.add(cursor);
    }
    cursor = readSlot(cursor, 'superField', services, label);
  }
  return false;
}

function readExportRecord(linker, index, services) {
  const record = sync(requireFunction(services.readExport, 'readExport')(linker, index), 'readExport');
  if (!record || typeof record !== 'object') {
    fail(`CreateExport readExport did not return export[${index}]`, {kind: 'RETURN', value: record});
  }
  requireInt(record.classIndex, 'Export.ClassIndex');
  requireInt(record.superIndex, 'Export.SuperIndex');
  requireInt(record.packageIndex, 'Export.PackageIndex');
  requireInt(record.objectName, 'Export.ObjectName');
  requireInt(record.objectFlags, 'Export.ObjectFlags');
  if (record.object === undefined) {
    fail(`CreateExport readExport did not expose export[${index}]._Object`, {kind: 'FIELD', field: 'object'});
  }
  return record;
}

/**
 * Execute the recovered `ULinkerLoad::CreateExport` body for one export index.
 *
 * Required services:
 *
 * - `readExport(linker, index)` returns the live `FObjectExport` slots
 *   (`classIndex`, `superIndex`, `packageIndex`, `objectName`, `objectFlags`
 *   and the current `object`), mirroring the `+0x00`-`+0x1c` reads;
 * - `writeExportObject(linker, index, object)` publishes `_Object` at `+0x1c`;
 * - `contextFlags(linker)` is the linker's `+0xa0` word and `linkerRoot(linker)`
 *   its `+0x28` package;
 * - `indexToObject(linker, packageIndex)` resolves a package object reference;
 * - `preload(object)` binds the `+0xa4` archive's `+0x10` slot;
 * - `staticConstructObject({cls, outer, name, flags, template, error, native})`
 *   binds `0x10101771` and must apply the class-selected native constructor;
 * - `setLinker(object, linker, index)` binds `0x10101631`;
 * - `loadedObjects` is the live `GObjLoaded` array (`0x1029e638`); the module
 *   appends through `push` or an `add` method, matching `FArray::Add(1, 4)`;
 * - `getFullName(object)` and `log({name, format, text, device, native})` bind
 *   `0x1010240f` and the `NAME_DevLoad` `Logf`;
 * - `read(object, field)` exposes `class`, `superField` and `nameIndex`, and
 *   `write(object, 'superField', value)` performs the `+0x28` store;
 * - `bind(object)` binds the `UClass` vtable `+0x5c` entry;
 * - `classStaticClass` and `structStaticClass` are the canonical `0x101f1c18`
 *   and `0x101f2618` identities, and `errorDevice` the canonical `GWarn`.
 *
 * Returns `{object, events}`; `object` is `null` only where the native body
 * returns a null `_Object` or takes the `NAME_Camera` gate.
 */
export function createLinkerExport(request, services = {}) {
  if (!request || typeof request !== 'object') {
    fail('CreateExport requires a request object', {kind: 'VALUE', value: request});
  }
  const linker = requireReference(request.linker, 'ULinkerLoad');
  const index = requireInt(request.index, 'export index');
  if (index < 0) fail(`CreateExport export index ${index} is negative`, {kind: 'VALUE', value: index});

  const events = [{op: 'CreateExport', linker, index}];
  const record = readExportRecord(linker, index, services);

  // 0x1012e26c: an already constructed export short-circuits the whole body.
  if (record.object !== null) {
    events.push({op: 'ExistingExport', index, object: record.object});
    return {object: record.object, events};
  }

  // 0x1012e278-0x1012e283: the export must be selected by the linker's context
  // flags.  The native path falls to the same return, so _Object stays null.
  const contextFlags = requireInt(
    sync(requireFunction(services.contextFlags, 'contextFlags')(linker), 'contextFlags'),
    'ULinkerLoad context flags');
  if ((record.objectFlags & contextFlags) === 0) {
    events.push({op: 'ContextFlagsSkip', index, objectFlags: record.objectFlags, contextFlags});
    return {object: null, events};
  }

  // 0x1012e289-0x1012e2a8, UnLinker.h:787.
  if (record.objectName === 0 && (record.objectFlags & CREATE_EXPORT_CONTRACT.publicFlag) !== 0) {
    fail(`CreateExport assert failed: ${CREATE_EXPORT_CONTRACT.asserts.objectName.text}`, {
      kind: 'ASSERT', value: record.objectFlags, field: 'objectName',
    });
  }

  // 0x1012e2ab-0x1012e2c0: a null ClassIndex selects the Core.Class metaclass,
  // which is what makes this export a class.
  const indexToObject = requireFunction(services.indexToObject, 'indexToObject');
  const classStaticClass = requireReference(services.classStaticClass, 'Core.Class static identity');
  let loadClass = record.classIndex === 0
    ? null
    : requireReference(sync(indexToObject(linker, record.classIndex), 'indexToObject'),
      'LoadClass', {allowNull: true});
  const metaclass = loadClass === null;
  if (metaclass) loadClass = classStaticClass;
  events.push({op: 'LoadClass', index, classIndex: record.classIndex, loadClass, metaclass});

  // 0x1012e2c2-0x1012e2da, UnLinker.h:793.
  if (loadClass === null || loadClass === undefined) {
    fail(`CreateExport assert failed: ${CREATE_EXPORT_CONTRACT.asserts.loadClass.text}`, {kind: 'ASSERT'});
  }
  // 0x1012e2dd-0x1012e2fa, UnLinker.h:794.
  const loadClassClass = metaclass ? classStaticClass : readSlot(loadClass, 'class', services, 'LoadClass');
  if (!sameIdentity(loadClassClass, classStaticClass)) {
    fail(`CreateExport assert failed: ${CREATE_EXPORT_CONTRACT.asserts.loadClassClass.text}`, {
      kind: 'ASSERT', value: loadClassClass, field: 'class',
    });
  }

  // 0x1012e2fd-0x1012e318: the legacy NAME_Camera gate.  It is inert for class
  // exports, whose LoadClass is always Core.Class, but the native body still
  // evaluates it, so it is evaluated and reported here.
  const loadClassName = requireInt(readSlot(loadClass, 'nameIndex', services, 'LoadClass'),
    'LoadClass name index');
  events.push({op: 'CameraGate', index, name: loadClassName, skipped: loadClassName === CREATE_EXPORT_CONTRACT.cameraName});
  if (loadClassName === CREATE_EXPORT_CONTRACT.cameraName) return {object: null, events};

  // (this+0xa4)->vtable[+0x10]
  sync(requireFunction(services.preload, 'preload')(loadClass), 'preload');
  events.push({op: 'Preload', object: loadClass, slot: CREATE_EXPORT_CONTRACT.preloadSlot});

  // 0x1012e32b-0x1012e33e: the outer is resolved before the second _Object
  // check, so keep that order.
  const thisOuter = record.packageIndex !== 0
    ? requireReference(sync(indexToObject(linker, record.packageIndex), 'indexToObject'), 'ThisOuter')
    : requireReference(sync(requireFunction(services.linkerRoot, 'linkerRoot')(linker), 'linkerRoot'),
      'LinkerRoot');
  events.push({op: 'Outer', index, packageIndex: record.packageIndex, outer: thisOuter});

  // 0x1012e341-0x1012e346: Preload may have constructed the export already.
  const afterPreload = readExportRecord(linker, index, services);
  if (afterPreload.object !== null) {
    events.push({op: 'ExistingExport', index, object: afterPreload.object, afterPreload: true});
    return {object: afterPreload.object, events};
  }

  // 0x1012e34c-0x1012e375.
  const flags = ((record.objectFlags & CREATE_EXPORT_CONTRACT.loadFlagMask) |
    CREATE_EXPORT_CONTRACT.loadFlagOr) >>> 0;
  const object = requireReference(sync(
    requireFunction(services.staticConstructObject, 'staticConstructObject')({
      cls: loadClass,
      outer: thisOuter,
      name: record.objectName,
      flags,
      template: null,
      error: requireReference(services.errorDevice, 'GWarn'),
      native: CREATE_EXPORT_CONTRACT.staticConstructObject,
    }), 'staticConstructObject'), 'StaticConstructObject result');
  sync(requireFunction(services.writeExportObject, 'writeExportObject')(linker, index, object),
    'writeExportObject');
  events.push({op: 'StaticConstructObject', index, cls: loadClass, outer: thisOuter,
    name: record.objectName, flags, object});

  // 0x1012e378-0x1012e37c.
  sync(requireFunction(services.setLinker, 'setLinker')(object, linker, index), 'setLinker');
  events.push({op: 'SetLinker', object, linker, index, native: CREATE_EXPORT_CONTRACT.setLinker});

  // 0x1012e381-0x1012e39a: FArray::Add(1, 4) then the slot store.
  const loaded = services.loadedObjects;
  if (Array.isArray(loaded)) loaded.push(object);
  else if (loaded && typeof loaded.add === 'function') sync(loaded.add(object), 'GObjLoaded.Add');
  else fail('CreateExport requires the live GObjLoaded array', {kind: 'SERVICE', field: 'loadedObjects'});
  events.push({op: 'LoadedObjectsAdd', object, elementSize: CREATE_EXPORT_CONTRACT.loadedArrayElementSize,
    native: CREATE_EXPORT_CONTRACT.loadedArrayAdd});

  // 0x1012e39d-0x1012e3b9.
  const fullName = sync(requireFunction(services.getFullName, 'getFullName')(object), 'getFullName');
  sync(requireFunction(services.log, 'log')({
    name: CREATE_EXPORT_CONTRACT.logName,
    format: CREATE_EXPORT_CONTRACT.logFormat,
    text: fullName,
    device: CREATE_EXPORT_CONTRACT.logDevice,
    native: CREATE_EXPORT_CONTRACT.logf,
  }), 'log');
  events.push({op: 'Logf', name: CREATE_EXPORT_CONTRACT.logName, text: fullName});

  // 0x1012e3be-0x1012e3f5.
  const structStaticClass = requireReference(services.structStaticClass, 'Core.Struct static identity');
  if (isA(object, structStaticClass, services, 'export') && record.superIndex !== 0) {
    const superField = requireReference(
      sync(indexToObject(linker, record.superIndex), 'indexToObject'), 'SuperField', {allowNull: true});
    sync(requireFunction(services.write, 'write')(object, 'superField', superField), 'write superField');
    events.push({op: 'SuperField', object, superIndex: record.superIndex, superField});
  }

  // 0x1012e3f8-0x1012e422.
  if (isA(object, classStaticClass, services, 'export')) {
    sync(requireFunction(services.bind, 'bind')(object), 'bind');
    events.push({op: 'Bind', object, slot: CREATE_EXPORT_CONTRACT.bindSlot});
  }

  return {object, events};
}

export default createLinkerExport;
