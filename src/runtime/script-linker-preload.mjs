/**
 * GOTY Core.dll `ULinkerLoad::Preload` — the embedded linker archive's
 * `FArchive::Preload(UObject*)` override — plus the load-path serialize chain
 * it dispatches into.  See docs/script-linker-preload.md.
 *
 * The archive is the `ULinkerLoad`-embedded FArchive subclass whose vtable is
 * 0x1017a430: `+0x10` is this body (0x10162000), `+0x04` raw Serialize
 * (0x10163310), `+0x14` CountBytes (0x10106900, a `ret 8` no-op), `+0x18`
 * `operator<<(UObject*&)` (0x10163470), `+0x1c` `operator<<(FName&)`
 * (0x10163580), `+0x28` Tell (0x10163110), `+0x34` Seek (0x10163070).  Every
 * data call forwards to the reader stored at archive +0x440 (linker +0x4e4).
 *
 * The archive flag word at +0x0c carries the LinkerRoot pointer on a real
 * linker archive (ULinkerLoad's constructor writes it at 0x10160280-0x101602b4),
 * so the stream/linker branches — not the collector branches — are what a
 * package export hits.  `serializeLoadedObject` below keeps both branches but
 * the collector-only paths are unreachable through this archive.
 */

import {createLinkerLoadArchive} from './script-linker-lazy-loader.mjs';
import {NativeSlots, slotValue} from './native-slots.mjs';

const freeze = Object.freeze;

export const LINKER_PRELOAD = freeze({
  thunk: 0x101011cc,
  baseBody: 0x101068e0,
  body: 0x10162000,
  end: 0x1016226f,
  archiveVtable: 0x1017a430,
  archiveBase: 0xa4,
  readerPointer: 0x440,
  exportRecordStride: 0x24,
  slots: freeze({
    preload: 0x10,
    serialize: 0x28,
    objectRef: 0x18,
    nameRef: 0x1c,
    rawSerialize: 0x04,
    countBytes: 0x14,
    tell: 0x28,
    seek: 0x34,
    link: 0x6c,
    getPropertiesSize: 0x64,
    getInheritanceSuper: 0x68,
    serializeBin: 0x70,
    taggedProperties: 0x74,
    serializeExpr: 0x7c,
    readerTell: 0x28,
    readerSeek: 0x34,
    readerPrecache: 0x40,
  }),
  bodies: freeze({
    objectSerialize: 0x10150210,
    fieldSerialize: 0x10125c70,
    structSerialize: 0x10126fe0,
    stateSerialize: 0x10127590,
    classSerialize: 0x101280d0,
    functionSerialize: 0x10129010,
    propertyTag: 0x1012a840,
    taggedPropertyItem: 0x1012aca0,
    propertyGetId: 0x101655f0,
    classPropertyGetId: 0x10113e20,
    archiveObjectRef: 0x10163470,
    archiveNameRef: 0x10163580,
    archiveRawSerialize: 0x10163310,
    archiveTell: 0x10163110,
    archiveSeek: 0x10163070,
    countBytes: 0x10106900,
    compactIndex: 0x10102950,
    indexToObject: 0x10102c11,
    isValid: 0x10101c1c,
    failAssert: 0x10102c70,
    getFullName: 0x1010240f,
    localizeError: 0x101023b5,
    logf: 0x1010280b,
    serializeGuid: 0x1012ae20,
    serializeDependencies: 0x1012af20,
    serializePackageImports: 0x1011e120,
    taggedProperties: 0x10126730,
    initClassDefaultObject: 0x10101226,
    loadConfig: 0x101023dd,
    loadLocalized: 0x1010306c,
    farrayRealloc: 0x10101753,
    farrayAdd: 0x10102536,
    structLink: 0x10126060,
    stateLink: 0x10127640,
    classLink: 0x10127e30,
    functionLink: 0x10129490,
  }),
  globals: freeze({
    gwarn: 0x101a7c38,
    gmem: 0x101a7c44,
    gIsEditor: 0x101e5544,
    classClass: 0x101f1c18,
    structClass: 0x101f2618,
    objectClass: 0x1029e0d0,
    propertyClass: 0x102a7af0,
    boolPropertyClass: 0x102a6bf0,
    namesTable: 0x102961f0,
  }),
  flags: freeze({
    needLoad: 0x00000200,
    loading: 0x00008000,
    completedSerialization: 0x40000000,
    stateFrame: 0x02000000,
    oldClassFlags: 0x00080004,
  }),
  offsets: freeze({
    objectLinker: 0x10,
    linkerIndex: 0x14,
    outer: 0x18,
    objectFlags: 0x1c,
    name: 0x20,
    objectClass: 0x24,
    superField: 0x28,
    next: 0x2c,
    hashNext: 0x30,
    scriptText: 0x34,
    children: 0x38,
    propertiesSize: 0x3c,
    friendlyName: 0x40,
    script: 0x44,
    scriptNum: 0x48,
    scriptMax: 0x4c,
    textPos: 0x50,
    line: 0x54,
    probeMask: 0x6c,
    ignoreMask: 0x74,
    stateFlags: 0x7c,
    labelTableOffset: 0x80,
    propertyFlags: 0x3c,
    arrayDim: 0x34,
    elementSize: 0x38,
    propertyOffset: 0x48,
    propertyLinkNext: 0x4c,
    propertyLink: 0x60,
    functionFlags: 0x6c,
    iNative: 0x70,
    repOffset: 0x72,
    numParms: 0x74,
    classFlags: 0x484,
    constructorNext: 0x488,
    classGuid: 0x48c,
    classWithin: 0x49c,
    classConfigName: 0x4a0,
    dependencies: 0x4bc,
    packageImports: 0x4c8,
    defaults: 0x4d4,
    exportSerialSize: 0x14,
    exportSerialOffset: 0x18,
    exportObject: 0x1c,
    linkerNameTable: 0x6c,
    linkerNameCount: 0x70,
    linkerExportMap: 0x84,
  }),
  asserts: freeze({
    linkerValid: freeze({ line: 0x2da, file: 0x101a83d4, text: 0x101b0e10 }),
    object: freeze({ line: 0x2db, file: 0x101a83d4, text: 0x101b0e08 }),
    exportObject: freeze({ line: 0x2ee, file: 0x101a83d4, text: 0x101b0dec }),
    friendlyName: freeze({ line: 0x25b, file: 0x101a9a7c, text: 0x101a9aa0 }),
    taggedPropertiesStream: freeze({ line: 0x1d3, file: 0x101a9814, text: 0x101a9838 }),
    propertiesSize: freeze({ line: 0x3aa, file: 0x101a9dec, text: 0x101a9e10 }),
    superLoaded: freeze({ line: 0x3ab, file: 0x101a9e38, text: 0x101a9e5c }),
    defaultsSize: freeze({ line: 0x1e1, file: 0x101a8358, text: 0x101a832c }),
  }),
  strings: freeze({
    sizeMismatch: 0x101b0ddc,
    sizeMismatchSection: 0x101a7ef4,
    scriptMismatch: 0x101a9ab8,
  }),
});

export class UnsupportedLinkerPreloadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsupportedLinkerPreloadError';
    this.code = 'UNSUPPORTED_LINKER_PRELOAD';
  }
}

const fail = message => { throw new UnsupportedLinkerPreloadError(message); };
const pointer = value => value === 0 ? null : value;
const identity = value => pointer(value?.nativeAddress ?? value?.address ?? value);
const same = (a, b) => a === b || (identity(a) !== null && identity(a) === identity(b));
const integer = (value, label, { minimum = null, maximum = 0x7fffffff } = {}) => {
  if (!Number.isInteger(value) || (minimum !== null && value < minimum) || value > maximum)
    throw new TypeError(`ULinkerLoad::Preload requires ${label}, got ${String(value)}`);
  return value;
};
const required = (value, label) =>
  typeof value === 'function' ? value : fail(`ULinkerLoad::Preload requires ${label}`);

function slot(object, offset, services, names = []) {
  const fromHost = services.readSlot?.(object, offset);
  if (fromHost !== undefined) return fromHost;
  if (object?.nativeSlots instanceof NativeSlots && object.nativeSlots.has(offset))
    return object.nativeSlots.value(offset);
  for (const name of names) if (object && Object.hasOwn(object, name)) return object[name];
  return undefined;
}

function write(object, offset, value, services, names = [], width = 4) {
  const slots = object?.nativeSlots instanceof NativeSlots ? object.nativeSlots : null;
  const present = slots !== null && slots.has(offset), prior = present ? slots.width(offset) : undefined;
  if (prior !== undefined && prior !== width)
    throw new TypeError(`Wrong native slot width at +0x${offset.toString(16)}`);
  if (services.writeSlot) services.writeSlot(object, offset, value, width);
  if (present) slots.assign(offset, value);
  else if (slots) slots.set(offset, value, width);
  for (const name of names) if (slots === null || RECORD_FIELDS.has(name)) object[name] = value;
  return value;
}

// What a record with native slots keeps beside its slots: the fields that stand for the record itself and are read by name (`name`,
// `objectFlags`, `base`, `defaults`, `names`; makeRecord's literal and the class-bind and enum readers). Every other alias below
// (`flags`, `superField`, `super`, `next`, `hashNext`, `iNative`, `numParms`, `repOffset`, the state and class words, `line`,
// `textPos`...) lived in the slot alone for the three that only slot() read (docs/live-heap.md, steps 2 and 3), and now all do: they
// were written beside every slot and read by nothing, a property array of up to thirty properties on every record (docs/live-heap.md
// "Load records and functions"). An object without native slots (a fixture) keeps all of them.
const RECORD_FIELDS = new Set(['name', 'objectFlags', 'base', 'defaults', 'names']);

const NAMES = freeze({
  0x0c: ['frame', 'stateFrame'],
  0x10: ['linker', 'objectLinker'],
  0x14: ['linkerIndex'],
  0x18: ['outer'],
  0x1c: ['objectFlags', 'flags'],
  0x20: ['objectName', 'name', 'nameIndex'],
  0x24: ['objectClass', 'class'],
  0x28: ['superField', 'base', 'super'],
  0x2c: ['next'],
  0x30: ['hashNext'],
  // Dual-purpose offsets carry no shared aliases: +0x34/+0x38/+0x3c/+0x40/
  // +0x44/+0x48/+0x4c/+0x5c/+0x60/+0x6c differ per object kind (struct vs
  // property vs function), so records must reach them through nativeSlots.
  0x50: ['textPos', 'textPosition'],
  0x54: ['line'],
  0x70: ['iNative'],
  0x72: ['repOffset'],
  0x74: ['numParms'],
  0x7c: ['stateFlags'],
  0x80: ['labelTableOffset'],
  0x484: ['classFlags'],
  0x488: ['constructorNext'],
  0x48c: ['classGuid', 'guid'],
  0x49c: ['classWithin', 'within'],
  0x4a0: ['classConfigName', 'configName'],
  0x4bc: ['dependencies'],
  0x4c8: ['packageImports'],
  0x4d4: ['defaults'],
});

const read = (object, offset, services) => slot(object, offset, services, NAMES[offset] ?? []);
const put = (object, offset, value, services, width = 4) =>
  write(object, offset, value, services, NAMES[offset] ?? [], width);

function emit(context, event) {
  context?.events?.push(event);
  return event;
}

function assertCheck(condition, assertion, services, detail = {}) {
  if (condition) return;
  const failure = { ...assertion, ...detail };
  if (services.failAssert) services.failAssert(failure);
  const error = new UnsupportedLinkerPreloadError(
    `ULinkerLoad::Preload assert at UnLinker.h:${assertion.line} ` +
    `(text 0x${assertion.text.toString(16)})`);
  error.assert = failure;
  throw error;
}

function archiveVersion(archive) {
  return archive.version ?? archive.ar04;
}

function archiveFlags(archive) {
  return {
    linkerRoot: archive.ar0c ?? (archive.linkerRoot !== undefined ? archive.linkerRoot : 0),
    loading: archive.ar10 ?? 0,
    saving: archive.ar14 ?? 0,
    transient: archive.ar18 ?? 0,
  };
}

/**
 * The embedded linker archive (vtable 0x1017a430).  `reader` is the host
 * stream behind archive +0x440; each op is the recovered slot body:
 * raw Serialize forwards to reader +0x04 (0x10163310), Tell to reader +0x28
 * (0x10163110), Seek to reader +0x34 (0x10163070), CountBytes is a `ret 8`
 * no-op (0x10106900).  `<<UObject*&` (0x10163470) reads a compact index off
 * the reader then calls the linker's `IndexToObject`; `<<FName&` (0x10163580)
 * bounds-checks the index against the linker name count (+0x70) before
 * reading the name table (+0x6c).
 */
export function linkerLoadArchive({ linker, reader, linkerRoot = null, version, services = {} } = {}) {
  if (!linker || typeof linker !== 'object') throw new TypeError('linkerLoadArchive requires the ULinkerLoad record');
  if (!reader || typeof reader !== 'object') throw new TypeError('linkerLoadArchive requires the +0x440 reader');
  const archive = Object.assign(createLinkerLoadArchive({linker, reader, services}), {
    kind: 'ULinkerLoadArchive',
    vtable: LINKER_PRELOAD.archiveVtable,
    linker,
    reader,
    ar04: version,
    ar08: 0x44c,
    ar0c: linkerRoot ?? linker.root ?? null,
    ar10: 0,
    ar14: 0,
    ar18: linkerRoot ?? linker.root ?? null,
    ar1c: services.isEditor ? services.isEditor() : 0,
    ar20: linkerRoot ?? linker.root ?? null,
    ar24: linkerRoot ?? linker.root ?? null,
    ar28: 0,
  });
  archive.tell = () => required(services.readerTell, 'reader Tell (+0x28)')(reader);
  archive.seek = position => required(services.readerSeek, 'reader Seek (+0x34)')(reader, position);
  archive.precache = size => required(services.readerPrecache, 'reader Precache (+0x40)')(reader, size);
  archive.readRaw = size => required(services.readerRead, 'reader Serialize (+0x04)')(reader, size);
  archive.readCompact = () => required(services.readerCompactIndex, 'reader FCompactIndex read')(reader);
  archive.readU32 = () => {
    const bytes = archive.readRaw(4);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  };
  archive.readU16 = () => {
    const bytes = archive.readRaw(2);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(0, true);
  };
  archive.countBytes = (amount, maximum) => {
    archive.countedBytes = (archive.countedBytes ?? 0);
    return { amount, maximum, body: LINKER_PRELOAD.bodies.countBytes };
  };
  archive.readObject = () => {
    // 0x10163470 calls IndexToObject unconditionally; index 0 returns null
    // inside that body.
    const index = archive.readCompact();
    const object = required(services.indexToObject,
      'ULinkerLoad::IndexToObject (0x10102c11)')(linker, index);
    archive.lastObjectIndex = index;
    return { index, object };
  };
  archive.readName = () => {
    // 0x10163580: the stream carries a package-local index; the linker name
    // map (+0x6c, count +0x70) translates it to the process-wide FName index
    // (NAME_None is global index 0 — 0x102a3f10 reads as zero).
    const index = archive.readCompact();
    const names = linker.names ?? linker.nameTable ?? [];
    if (index < 0 || index >= names.length) {
      const detail = { index, count: names.length, body: LINKER_PRELOAD.bodies.archiveNameRef };
      if (services.nameReferenceError) services.nameReferenceError(detail);
      throw new RangeError(`FName reference ${index} is outside the ${names.length}-entry linker name table`);
    }
    const name = names[index];
    archive.lastNameIndex = index;
    const text = typeof linker.nameText === 'function' ? linker.nameText(name) : undefined;
    return { index, name, text };
  };
  return archive;
}

/**
 * `ULinkerLoad::Preload` — body 0x10162000, the embedded archive's +0x10 slot.
 *
 * `context` is `{archive, linker}` where `archive` is the record produced by
 * `linkerLoadArchive` and `linker` the owning `ULinkerLoad` record.  The
 * object record is accessed through native offsets (nativeSlots or the
 * semantic spellings in NAMES): +0x10 Linker, +0x14 LinkerIndex, +0x1c flags,
 * +0x24 Class, +0x28 SuperField.
 *
 * Host-service boundaries, named by their recovered addresses:
 *   isValidLinker(linker)                IsValid thunk 0x10101c1c
 *   readExport(linker, index)            ExportMap[LinkerIndex], stride 0x24
 *   indexToObject(linker, ref)           IndexToObject thunk 0x10102c11
 *   serialize(object, archive)           object vtable +0x28
 *   readerTell/readerSeek/readerPrecache reader +0x28/+0x34/+0x40
 *   getFullName(object)                  0x1010240f (warn path only)
 *   localizeError(key, section)          0x101023b5 (warn path only)
 *   warnLog(text, ...args)               GWarn 0x101a7c38 -> Logf 0x1010280b
 *   failAssert(assert)                   appFailAssert 0x10102c70
 */
export function linkerPreload(object, context = {}, services = {}) {
  // `services.preloadStack`: a host that records what each Preload references (the load graph's load edges) needs the object whose
  // serialization is in progress. Every Preload counts, this body's own recursion into the class and the struct super included.
  const stack = services.preloadStack;
  if (!stack) return linkerPreloadBody(object, context, services);
  stack.push(object);
  try { return linkerPreloadBody(object, context, services); }
  finally { stack.pop(); }
}

function linkerPreloadBody(object, context = {}, services = {}) {
  const events = context.events ?? (context.events = []);
  const archive = context.archive;
  const linker = context.linker ?? archive?.linker;
  if (!archive || !linker) throw new TypeError('ULinkerLoad::Preload requires the archive and its linker');
  emit(context, { op: 'Preload', object, body: LINKER_PRELOAD.body });

  const valid = services.isValidLinker ? services.isValidLinker(linker) : linker != null;
  assertCheck(valid, LINKER_PRELOAD.asserts.linkerValid, services, { linker });
  assertCheck(object != null, LINKER_PRELOAD.asserts.object, services, { object });

  const objectLinker = pointer(read(object, LINKER_PRELOAD.offsets.objectLinker, services));
  if (!same(objectLinker, linker)) {
    if (objectLinker === null) {
      emit(context, { op: 'PreloadReturn', object, reason: 'no-linker' });
      return { object, preloaded: false, reason: 'no-linker', events };
    }
    emit(context, { op: 'PreloadDelegate', object, linker: objectLinker });
    const delegatedArchive = objectLinker.archive;
    if (!delegatedArchive) fail('ULinkerLoad::Preload delegation needs the other linker\'s +0xa4 archive');
    return linkerPreload(object, { linker: objectLinker, archive: delegatedArchive, events }, services);
  }

  const flags = integer(read(object, LINKER_PRELOAD.offsets.objectFlags, services), 'ObjectFlags',
    { minimum: 0, maximum: 0xffffffff });
  if ((flags & LINKER_PRELOAD.flags.needLoad) === 0) {
    emit(context, { op: 'PreloadReturn', object, reason: 'loaded' });
    return { object, preloaded: false, reason: 'loaded', events };
  }

  // The inline IsA(UStruct) walk: the object's Class ancestry through +0x28
  // is compared with the Core.Struct static identity 0x101f2618.
  let structAncestry = false;
  const structIdentity = services.structClass ?? LINKER_PRELOAD.globals.structClass;
  let cls = pointer(read(object, LINKER_PRELOAD.offsets.objectClass, services));
  const ancestrySeen = new Set();
  while (cls !== null) {
    if (same(cls, structIdentity)) { structAncestry = true; break; }
    const key = identity(cls) ?? cls;
    if (ancestrySeen.has(key)) throw new Error('Cyclic Class ancestry in ULinkerLoad::Preload');
    ancestrySeen.add(key);
    cls = pointer(read(cls, LINKER_PRELOAD.offsets.superField, services));
  }
  const superField = pointer(read(object, LINKER_PRELOAD.offsets.superField, services));
  if (structAncestry && superField !== null) {
    emit(context, { op: 'PreloadSuper', object, superField });
    linkerPreload(superField, context, services);
  }

  const linkerIndex = integer(read(object, LINKER_PRELOAD.offsets.linkerIndex, services),
    'LinkerIndex', { minimum: 0 });
  const record = required(services.readExport, 'ExportMap read (linker +0x84)')(linker, linkerIndex);
  if (!record || typeof record !== 'object') fail(`ULinkerLoad::Preload found no export record at ${linkerIndex}`);
  const slotObject = record.object ?? record._object ?? record._Object;
  assertCheck(same(slotObject, object), LINKER_PRELOAD.asserts.exportObject, services,
    { object, record, linkerIndex });

  const serialOffset = integer(record.serialOffset ?? record.SerialOffset,
    'export SerialOffset (+0x18)');
  const serialSize = integer(record.serialSize ?? record.SerialSize,
    'export SerialSize (+0x14)');

  const savedPosition = archive.tell();
  emit(context, { op: 'PreloadTell', object, position: savedPosition });
  archive.seek(serialOffset);
  emit(context, { op: 'PreloadSeek', object, serialOffset });
  archive.precache(serialSize);
  emit(context, { op: 'PreloadPrecache', object, serialSize });

  const loadingFlags = ((flags & ~LINKER_PRELOAD.flags.needLoad) | LINKER_PRELOAD.flags.loading) >>> 0;
  put(object, LINKER_PRELOAD.offsets.objectFlags, loadingFlags, services);
  emit(context, { op: 'PreloadSerializeEnter', object, flags: loadingFlags });
  const result = required(services.serialize, 'object Serialize dispatch (+0x28)')(object, archive);
  put(object, LINKER_PRELOAD.offsets.objectFlags,
    (loadingFlags & ~LINKER_PRELOAD.flags.loading) >>> 0, services);
  emit(context, { op: 'PreloadSerializeExit', object, result });

  const end = archive.tell();
  const consumed = end - serialOffset;
  emit(context, { op: 'PreloadTellExit', object, position: end, consumed, expected: serialSize });
  if (consumed !== serialSize) {
    const endAgain = archive.tell();
    const fullName = services.getFullName ? services.getFullName(object) : null;
    const text = services.localizeError
      ? services.localizeError(LINKER_PRELOAD.strings.sizeMismatch,
        LINKER_PRELOAD.strings.sizeMismatchSection)
      : null;
    emit(context, {
      op: 'PreloadSizeMismatch', object, fullName,
      consumed: endAgain - serialOffset, expected: serialSize,
    });
    if (services.warnLog) {
      services.warnLog({
        device: LINKER_PRELOAD.globals.gwarn, body: LINKER_PRELOAD.bodies.logf,
        text, name: fullName, consumed: endAgain - serialOffset, expected: serialSize,
      });
    }
  }
  archive.seek(savedPosition);
  emit(context, { op: 'PreloadRestore', object, position: savedPosition });
  return { object, preloaded: true, serialOffset, serialSize, consumed, result, events };
}

/**
 * `UObject::Serialize` — body 0x10150210 — for the linker-archive load path.
 * Sets RF_LoadCompleted (0x40000000), preloads the object's class when it is
 * not Core.Class, and — because archive +0x0c carries the LinkerRoot — skips
 * the name/outer/class/linker object references entirely.  The state-frame
 * block (flag 0x02000000) and the +0x0c frame-pointer free are host
 * boundaries; a set frame flag is unsupported on this path.
 */
export function serializeLoadedObject(object, archive, services = {}, context = {}) {
  const flags = integer(read(object, LINKER_PRELOAD.offsets.objectFlags, services),
    'ObjectFlags', { minimum: 0, maximum: 0xffffffff });
  const completed = (flags | LINKER_PRELOAD.flags.completedSerialization) >>> 0;
  put(object, LINKER_PRELOAD.offsets.objectFlags, completed, services);
  emit(context, { op: 'SerializeObjectEnter', object, body: LINKER_PRELOAD.bodies.objectSerialize });

  const objectClass = pointer(read(object, LINKER_PRELOAD.offsets.objectClass, services));
  const classIdentity = services.classClass ?? LINKER_PRELOAD.globals.classClass;
  if (!same(objectClass, classIdentity) && objectClass !== null) {
    emit(context, { op: 'SerializePreloadClass', object, objectClass });
    linkerPreload(objectClass, { archive, linker: archive.linker, events: context.events }, services);
  }

  const { linkerRoot, loading, saving } = archiveFlags(archive);
  // 0x1015025c-0x1015028c: the name/outer/class references are serialized when
  // the archive is neither persistent nor loading, OR when it is saving.
  if (!(linkerRoot || loading) || saving) {
    put(object, LINKER_PRELOAD.offsets.name, archive.readName().name, services);
    put(object, LINKER_PRELOAD.offsets.outer, archive.readObject().object, services);
    put(object, LINKER_PRELOAD.offsets.objectClass, archive.readObject().object, services);
  }
  // 0x1015028c-0x1015029e: the linker self-reference is only serialized on a
  // plain non-stream archive.
  if (!linkerRoot && !loading) {
    put(object, LINKER_PRELOAD.offsets.objectLinker, archive.readObject().object, services);
  }

  if (saving) {
    fail('UObject::Serialize save path (ar+0x14 != 0) is unsupported on the linker archive');
  }
  if ((completed & LINKER_PRELOAD.flags.stateFrame) !== 0) {
    fail('ULinkerLoad::Preload cannot serialize an FStateFrame (flag 0x02000000)');
  }
  const frame = pointer(read(object, 0x0c, services));
  if (frame !== null) {
    required(services.freeFrame, 'GMem->free for the +0x0c frame pointer')(frame);
    put(object, 0x0c, null, services);
  }

  if (objectClass !== null && !same(objectClass, classIdentity)) {
    if ((linkerRoot || loading) && !saving) {
      required(services.serializeTaggedProperties,
        'class SerializeTaggedProperties (+0x74, body 0x10126730)')(objectClass, archive, object, objectClass);
    } else {
      required(services.serializeBin,
        'class SerializeBin (+0x70)')(objectClass, archive, object);
    }
  }
  const classSize = objectClass === null ? 0
    : integer(required(services.getPropertiesSize,
      'class GetPropertiesSize (+0x64)')(objectClass), 'class PropertiesSize', { minimum: 0 });
  archive.countBytes(classSize, classSize);
  emit(context, { op: 'SerializeObjectExit', object });
}

/** `UField::Serialize` — body 0x10125c70 — adds SuperField and Next. */
export function serializeLoadedField(object, archive, services = {}, context = {}) {
  serializeLoadedObject(object, archive, services, context);
  const superRef = archive.readObject();
  put(object, LINKER_PRELOAD.offsets.superField, superRef.object, services);
  emit(context, { op: 'SerializeFieldSuper', object, index: superRef.index, object: superRef.object });
  const nextRef = archive.readObject();
  put(object, LINKER_PRELOAD.offsets.next, nextRef.object, services);
  emit(context, { op: 'SerializeFieldNext', object, index: nextRef.index, object: nextRef.object });
  if (archiveFlags(archive).linkerRoot) put(object, LINKER_PRELOAD.offsets.hashNext, 0, services);
}

/**
 * `UEnum::Serialize` — thunk 0x101033a5, body 0x10159a20.  After the
 * inherited `UField::Serialize` it runs `Ar << Names` — the shared
 * FArray<FName> operator at 0x1011e120: CountBytes(Max*4, Num*4), then on a
 * stream archive a compact count lands in Max, Num resets to 0, and each
 * element appends through the archive's +0x1c `<<FName` slot.  The array
 * header lives at +0x34 on the enum record.
 */
export function serializeLoadedEnum(object, archive, services = {}, context = {}) {
  serializeLoadedField(object, archive, services, context);
  const names = object.names ?? slotValue(object, 0x34) ?? {};
  archive.countBytes((names.max ?? 0) * 4, (names.num ?? 0) * 4);
  const count = archive.readCompact();
  const data = new Array(count);
  names.max = count;
  names.num = 0;
  names.data = data;
  object.names = names;
  for (let index = 0; index < count; index++) {
    const ref = archive.readName();
    data[index] = ref.name;
    names.num += 1;
    emit(context, { op: 'SerializeEnumName', object, index, nameIndex: ref.index, name: ref.name });
  }
  write(object, 0x34, names, services, ['names', 'enumNames']);
  emit(context, { op: 'SerializeEnum', object, count });
}

/**
 * The FString read shared by `UConst::Serialize` and the text paths —
 * `operator<<(FArchive&, FString&)` at 0x101459b0, load branch
 * 0x10145a2f-0x10145a89: a compact element count (negative for stored
 * UTF-16), `num`/`max` both take the absolute count, then each unit arrives
 * as one serialized byte (ANSI, widened) or two (stored UTF-16).  Returns
 * the array record `{units, num, max}` with `units` holding char codes.
 */
export function serializeLoadedString(archive) {
  const count = archive.readCompact();
  const units = Math.abs(count);
  const codes = new Array(units);
  if (count >= 0) {
    for (let index = 0; index < units; index++) codes[index] = archive.readRaw(1)[0];
  } else {
    for (let index = 0; index < units; index++) codes[index] = archive.readU16();
  }
  return { units: codes, num: units, max: units, serializedCount: count };
}

/**
 * `UConst::Serialize` — thunk 0x101029b9, body 0x10129680: the inherited
 * `UField::Serialize`, then `Ar << Value` — the FString at +0x34.
 */
export function serializeLoadedConst(object, archive, services = {}, context = {}) {
  serializeLoadedField(object, archive, services, context);
  const value = serializeLoadedString(archive);
  write(object, 0x34, value, services, ['constValue', 'value'], 4);
  emit(context, { op: 'SerializeConst', object, count: value.num, wide: value.serializedCount < 0 });
  return value;
}

/**
 * `UTextBuffer::Serialize` — thunk 0x10103166, body 0x101598a0: the
 * inherited `UObject::Serialize`, then raw Pos (+0x2c) and Top (+0x30)
 * dwords and `Ar << Text` — the FString at +0x34.
 */
export function serializeLoadedTextBuffer(object, archive, services = {}, context = {}) {
  serializeLoadedObject(object, archive, services, context);
  put(object, 0x2c, archive.readU32(), services);
  put(object, 0x30, archive.readU32(), services);
  const text = serializeLoadedString(archive);
  write(object, 0x34, text, services, ['text', 'textBuffer'], 4);
  emit(context, { op: 'SerializeTextBuffer', object, count: text.num });
  return text;
}

/**
 * `UStruct::Serialize` — body 0x10126fe0.  The script-size local is seeded
 * from Script.Num (+0x48) and the expression cursor is the `SerializeExpr`
 * (+0x7c) boundary; the size-mismatch log and the `Link(Ar, 1)` tail call
 * (+0x6c) run only on the linker stream (archive +0x0c nonzero).
 */
export function serializeLoadedStruct(object, archive, services = {}, context = {}) {
  serializeLoadedField(object, archive, services, context);
  const scriptText = archive.readObject();
  put(object, LINKER_PRELOAD.offsets.scriptText, scriptText.object, services);
  emit(context, { op: 'SerializeStructScriptText', object, index: scriptText.index, object: scriptText.object });
  const children = archive.readObject();
  put(object, LINKER_PRELOAD.offsets.children, children.object, services);
  emit(context, { op: 'SerializeStructChildren', object, index: children.index, object: children.object });
  const friendly = archive.readName();
  put(object, LINKER_PRELOAD.offsets.friendlyName, friendly.name, services);
  emit(context, { op: 'SerializeStructFriendlyName', object, index: friendly.index, name: friendly.name });
  assertCheck(friendly.name !== 0 && friendly.name !== null && friendly.name !== undefined,
    LINKER_PRELOAD.asserts.friendlyName, services, { object, index: friendly.index });

  put(object, LINKER_PRELOAD.offsets.line, archive.readU32(), services);
  put(object, LINKER_PRELOAD.offsets.textPos, archive.readU32(), services);
  const scriptArray = object.script ?? slotValue(object, LINKER_PRELOAD.offsets.script) ?? {};
  const scriptSize = archive.readU32();
  emit(context, { op: 'SerializeStructScriptSize', object, scriptSize });

  if (archiveFlags(archive).linkerRoot) {
    // Script FArray: Num=0, Max=0, Realloc(1); Num+=scriptSize; grow to
    // Num + 3*Num/8 + 0x20 when the new Num exceeds Max (0x101270ab-0x101270c6).
    // The three header words land at +0x44 (data), +0x48 (num), +0x4c (max).
    scriptArray.num = 0;
    scriptArray.max = 0;
    scriptArray.data = new Uint8Array(0);
    scriptArray.num += scriptSize;
    if (scriptArray.num > scriptArray.max) {
      scriptArray.max = scriptArray.num + Math.floor(scriptArray.num * 3 / 8) + 0x20;
      scriptArray.data = new Uint8Array(scriptArray.max);
    }
    object.script = scriptArray;
    put(object, LINKER_PRELOAD.offsets.script, scriptArray.data, services);
    put(object, LINKER_PRELOAD.offsets.scriptNum, scriptArray.num, services);
    put(object, LINKER_PRELOAD.offsets.scriptMax, scriptArray.max, services);
  }

  let offset = 0;
  while (offset < scriptSize) {
    const cursor = { offset };
    required(services.serializeExpr,
      'UStruct::SerializeExpr dispatch (+0x7c)')(object, archive, cursor);
    offset = integer(cursor.offset, 'SerializeExpr cursor', { minimum: 0 });
  }
  if (offset !== scriptSize) {
    emit(context, { op: 'SerializeScriptSizeMismatch', object, offset, scriptSize });
    if (services.warnLog) {
      services.warnLog({
        device: LINKER_PRELOAD.globals.gwarn, body: LINKER_PRELOAD.bodies.logf,
        format: LINKER_PRELOAD.strings.scriptMismatch, offset, expected: scriptSize,
      });
    }
  }
  if (archiveFlags(archive).linkerRoot) {
    emit(context, { op: 'SerializeStructLink', object, argument: 1 });
    required(services.link, 'struct Link dispatch (+0x6c)')(object, archive, 1);
  }
}

/** `UState::Serialize` — body 0x10127590. */
export function serializeLoadedState(object, archive, services = {}, context = {}) {
  serializeLoadedStruct(object, archive, services, context);
  const probeMask = [archive.readU32(), archive.readU32()];
  write(object, LINKER_PRELOAD.offsets.probeMask, probeMask, services, ['probeMask'], 8);
  const ignoreMask = [archive.readU32(), archive.readU32()];
  write(object, LINKER_PRELOAD.offsets.ignoreMask, ignoreMask, services, ['ignoreMask'], 8);
  write(object, LINKER_PRELOAD.offsets.labelTableOffset, archive.readU16(), services, ['labelTableOffset'], 2);
  put(object, LINKER_PRELOAD.offsets.stateFlags, archive.readU32(), services);
  emit(context, {
    op: 'SerializeState', object, probeMask, ignoreMask,
    labelTableOffset: read(object, LINKER_PRELOAD.offsets.labelTableOffset, services),
    stateFlags: read(object, LINKER_PRELOAD.offsets.stateFlags, services),
  });
}

/** `SerializeGuid` — body 0x1012ae20: four raw dwords at ClassGuid (+0x48c). */
function serializeLoadedGuid(object, archive, services) {
  const guid = [archive.readU32(), archive.readU32(), archive.readU32(), archive.readU32()];
  write(object, LINKER_PRELOAD.offsets.classGuid, guid, services, ['classGuid', 'guid'], 16);
  return guid;
}

/**
 * `SerializeDependencies` — body 0x1012af20, load branch: compact count into
 * Max, then per 12-byte entry `<<object`, dword, dword.
 */
function serializeLoadedDependencies(object, archive, services, context) {
  const count = archive.readCompact();
  const entries = [];
  for (let index = 0; index < count; index++) {
    const classRef = archive.readObject();
    const deep = archive.readU32();
    const scriptCRC = archive.readU32();
    entries.push({ classIndex: classRef.index, class: classRef.object, deep, scriptCRC });
    emit(context, {
      op: 'SerializeDependency', object, index,
      classIndex: classRef.index, class: classRef.object, deep, scriptCRC,
    });
  }
  write(object, LINKER_PRELOAD.offsets.dependencies,
    { data: entries, num: entries.length, max: count }, services, ['dependencies']);
  return entries;
}

/**
 * `SerializePackageImports` — body 0x1011e120, load branch: compact count
 * into Max, then a `<<FName` per 4-byte entry.
 */
function serializeLoadedPackageImports(object, archive, services, context) {
  const count = archive.readCompact();
  const names = [];
  for (let index = 0; index < count; index++) {
    const ref = archive.readName();
    names.push(ref.name);
    emit(context, { op: 'SerializePackageImport', object, index, nameIndex: ref.index, name: ref.name });
  }
  write(object, LINKER_PRELOAD.offsets.packageImports,
    { data: names, num: names.length, max: count }, services, ['packageImports']);
  return names;
}

/**
 * `UClass::Serialize` — body 0x101280d0 — on the linker archive (+0x0c
 * nonzero): after UState::Serialize it reads ClassFlags (+0x484), the GUID,
 * dependencies and package imports, then — for version >= 62 — ClassWithin
 * and ClassConfigName.  The load tail resizes Defaults (+0x4d4) to
 * GetPropertiesSize, runs `InitClassDefaultObject` (0x10101226), the
 * SerializeTaggedProperties +0x74 read, `LoadConfig` (0x101023dd) and
 * `LoadLocalized` (0x1010306c) on the defaults object, each guarded by the
 * 0x1e1 Defaults.Num check.  The pre-62 fallback writes Core.Object into
 * ClassWithin.
 */
export function serializeLoadedClass(object, archive, services = {}, context = {}) {
  serializeLoadedState(object, archive, services, context);
  const version = integer(archiveVersion(archive), 'archive version', { minimum: 0 });
  if (version <= 61) {
    archive.readU32();
    const flags = integer(read(object, LINKER_PRELOAD.offsets.objectFlags, services),
      'ObjectFlags', { minimum: 0, maximum: 0xffffffff });
    put(object, LINKER_PRELOAD.offsets.objectFlags,
      (flags | LINKER_PRELOAD.flags.oldClassFlags) >>> 0, services);
  }
  put(object, LINKER_PRELOAD.offsets.classFlags, archive.readU32(), services);
  const guid = serializeLoadedGuid(object, archive, services);
  emit(context, { op: 'SerializeClassGuid', object, guid });
  const dependencies = serializeLoadedDependencies(object, archive, services, context);
  const packageImports = serializeLoadedPackageImports(object, archive, services, context);
  if (version >= 62) {
    const within = archive.readObject();
    put(object, LINKER_PRELOAD.offsets.classWithin, within.object, services);
    emit(context, { op: 'SerializeClassWithin', object, index: within.index, object: within.object });
    const configName = archive.readName();
    put(object, LINKER_PRELOAD.offsets.classConfigName, configName.name, services);
    emit(context, { op: 'SerializeClassConfigName', object, index: configName.index, name: configName.name });
  } else {
    // 0x10128189-0x1012819a: pre-62 packages store FName("System") in +0x4a0
    // through the appFName boundary (0x10102e96) — the host resolves it.
    const fallback = required(services.makeName,
      'appFName boundary (0x10102e96) for the pre-62 config name')('System', 1);
    put(object, LINKER_PRELOAD.offsets.classConfigName, fallback, services);
    emit(context, { op: 'SerializeClassConfigNameFallback', object, name: fallback });
  }

  if (!archiveFlags(archive).linkerRoot) {
    fail('UClass::Serialize collector path is not reachable through the linker archive');
  }

  const getSize = () => integer(required(services.getPropertiesSize,
    'GetPropertiesSize (+0x64)')(object), 'PropertiesSize', { minimum: 0 });
  let propertiesSize = getSize();
  assertCheck(propertiesSize >= 0x28, LINKER_PRELOAD.asserts.propertiesSize, services,
    { object, propertiesSize });

  const superField = pointer(read(object, LINKER_PRELOAD.offsets.superField, services));
  if (superField !== null) {
    const superFlags = integer(read(superField, LINKER_PRELOAD.offsets.objectFlags, services),
      'SuperField ObjectFlags', { minimum: 0, maximum: 0xffffffff });
    assertCheck((superFlags & LINKER_PRELOAD.flags.needLoad) === 0,
      LINKER_PRELOAD.asserts.superLoaded, services, { object, superField });
  }

  // Defaults FArray (+0x4d4): Num=0, Max=GetPropertiesSize(), Realloc(1),
  // Add(PropertiesSize) so Num == PropertiesSize (0x101281f2-0x10128222).  The
  // host owns the buffer shape through allocateDefaults; the fallback is a
  // plain byte array.
  const defaults = object.defaults && typeof object.defaults === 'object' ? object.defaults : {};
  defaults.num = 0;
  defaults.max = getSize();
  defaults.data = services.allocateDefaults
    ? services.allocateDefaults(defaults.max, object)
    : new Uint8Array(defaults.max);
  defaults.num += getSize();
  object.defaults = defaults;
  write(object, LINKER_PRELOAD.offsets.defaults, defaults, services, ['defaults']);

  propertiesSize = getSize();
  assertCheck(defaults.num === propertiesSize, LINKER_PRELOAD.asserts.defaultsSize, services,
    { object, num: defaults.num, propertiesSize });
  required(services.initClassDefaultObject,
    'InitClassDefaultObject (0x10101226)')(defaults.data, object);
  emit(context, { op: 'SerializeClassInitDefaults', object, size: defaults.num });

  required(services.serializeTaggedProperties,
    'SerializeTaggedProperties (+0x74, body 0x10126730)')(object, archive, defaults.data, superField);
  emit(context, { op: 'SerializeClassDefaults', object });

  // 0x10128266-0x101282e8: the 0x1e1 check wraps LoadConfig (three pushed
  // zero args) and LoadLocalized (two); +0x488 is cleared last.
  assertCheck(defaults.num === getSize(), LINKER_PRELOAD.asserts.defaultsSize, services,
    { object, num: defaults.num });
  required(services.loadConfig, 'LoadConfig (0x101023dd)')(defaults.data, 0, 0, 0, object);
  assertCheck(defaults.num === getSize(), LINKER_PRELOAD.asserts.defaultsSize, services,
    { object, num: defaults.num });
  required(services.loadLocalized, 'LoadLocalized (0x1010306c)')(defaults.data, 0, 0);
  put(object, LINKER_PRELOAD.offsets.constructorNext, 0, services);
  if (version <= 61) {
    put(object, LINKER_PRELOAD.offsets.classWithin,
      services.objectClass ?? LINKER_PRELOAD.globals.objectClass, services);
  }
  emit(context, { op: 'SerializeClassExit', object, dependencies, packageImports });
}

/**
 * `UFunction::Serialize` — body 0x10129010.  After the inherited
 * UStruct::Serialize it reads iNative (+0x70, word), the serialized NumParms
 * (+0x74, byte), FunctionFlags (+0x6c, dword) and — for FUNC_Net (0x40) — the
 * replication offset (+0x72, word); the extra +0x76/+0x75/+0x78 reads only
 * run for version <= 63.  On a stream archive the tail then recomputes
 * NumParms (+0x75), ParmsSize (+0x76) and the first out-parm offset (+0x78)
 * by walking Children until the first non-property or non-CFParm (0x80)
 * child.
 */
export function serializeLoadedFunction(object, archive, services = {}, context = {}) {
  serializeLoadedStruct(object, archive, services, context);
  const version = integer(archiveVersion(archive), 'archive version', { minimum: 0 });
  if (version <= 0x3f) write(object, 0x76, archive.readU16(), services, [], 2);
  write(object, 0x70, archive.readU16(), services, ['iNative'], 2);
  if (version <= 0x3f) write(object, 0x75, archive.readRaw(1)[0], services, [], 1);
  write(object, 0x74, archive.readRaw(1)[0], services, ['numParms'], 1);
  if (version <= 0x3f) write(object, 0x78, archive.readU16(), services, [], 2);
  const functionFlags = archive.readU32();
  put(object, 0x6c, functionFlags, services);
  if (functionFlags & 0x40) write(object, 0x72, archive.readU16(), services, ['repOffset'], 2);
  emit(context, {
    op: 'SerializeFunction', object, iNative: read(object, 0x70, services),
    numParms: read(object, 0x74, services), functionFlags,
  });

  if (!archiveFlags(archive).linkerRoot) return;
  put(object, 0x75, 0, services);
  write(object, 0x76, 0, services, [], 2);
  write(object, 0x78, 0xffff, services, [], 2);
  // 0x101290c2-0x1012915f: recompute NumParms/ParmsSize/out-parm offset from
  // the leading CFParm property children; the loop exits on the first child
  // that is not a UProperty (IsA 0x102a7af0) or lacks flag 0x80.
  let child = pointer(read(object, LINKER_PRELOAD.offsets.children, services));
  const seen = new Set();
  while (child !== null) {
    if (seen.has(identity(child))) throw new Error('Cyclic UFunction Children chain');
    seen.add(identity(child));
    let cls = pointer(read(child, LINKER_PRELOAD.offsets.objectClass, services));
    let isProperty = false;
    const ancestry = new Set();
    while (cls !== null) {
      if (same(cls, services.propertyClass ?? LINKER_PRELOAD.globals.propertyClass)) {
        isProperty = true;
        break;
      }
      const key = identity(cls) ?? cls;
      if (ancestry.has(key)) throw new Error('Cyclic Class ancestry in UFunction::Serialize');
      ancestry.add(key);
      cls = pointer(read(cls, LINKER_PRELOAD.offsets.superField, services));
    }
    if (!isProperty) break;
    const flags = integer(read(child, LINKER_PRELOAD.offsets.propertyFlags, services) ?? 0,
      'child PropertyFlags', { minimum: 0, maximum: 0xffffffff });
    if ((flags & 0x80) === 0) break;
    const elementSize = integer(read(child, LINKER_PRELOAD.offsets.elementSize, services),
      'child ElementSize', { minimum: 0, maximum: 0xffff });
    const arrayDim = integer(read(child, LINKER_PRELOAD.offsets.arrayDim, services),
      'child ArrayDim', { minimum: 0, maximum: 0xffff });
    const offset = integer(read(child, LINKER_PRELOAD.offsets.propertyOffset, services),
      'child property Offset', { minimum: 0, maximum: 0xffff });
    put(object, 0x75, (integer(read(object, 0x75, services), 'NumParms') + 1) & 0xff, services);
    write(object, 0x76, (offset + Math.imul(elementSize, arrayDim)) & 0xffff, services, [], 2);
    if (flags & 0x400) write(object, 0x78, offset & 0xffff, services, [], 2);
    emit(context, { op: 'SerializeFunctionParm', object, child, offset });
    child = pointer(read(child, LINKER_PRELOAD.offsets.next, services));
  }
}

/**
 * `UProperty::Serialize` — body 0x10165020 (thunk 0x1010147e) — plus the
 * subclass tails that call it.  The base body runs UField::Serialize, then
 * ArrayDim (+0x34, dword), PropertyFlags (+0x3c, dword), Category (+0x40,
 * FName) and the net RepOffset (+0x44, word) when flag 0x20 is set.  For
 * archive versions <= 0x3d it masks PropertyFlags with 0xfff7ffbf; on a
 * stream archive (+0x0c nonzero) it zeroes +0x48 and +0x54.
 *
 * Recovered subclass tails (each calls the base thunk first):
 *   Object/Byte/Struct/ArrayProperty   `<<object` into +0x5c
 *   ClassProperty (0x10167050)         ObjectProperty tail, then `<<object`
 *                                      into +0x64 and check(+0x64 != 0)
 *                                      (UnProperties.h:0x2ec)
 *   MapProperty (0x10168db0)           `<<object` into +0x5c and +0x60
 *   FixedArrayProperty (0x10167df0)    `<<object` into +0x5c, then a dword
 *                                      into +0x60
 *   BoolProperty (0x10166160)          +0x5c bitmask dword ONLY on a
 *                                      non-stream archive (+0x0c == 0 &&
 *                                      +0x10 == 0); on the linker archive
 *                                      the mask arrives through Link
 *   Int/Float/Name/Str/plain Property  no tail (vtable +0x28 is the base
 *                                      body, or a bare forwarder for Str)
 */
export function serializeLoadedProperty(object, archive, services = {}, context = {}) {
  serializeLoadedField(object, archive, services, context);
  put(object, LINKER_PRELOAD.offsets.arrayDim, archive.readU32(), services);
  let flags = archive.readU32();
  put(object, LINKER_PRELOAD.offsets.propertyFlags, flags, services);
  const category = archive.readName();
  put(object, 0x40, category.name, services);
  emit(context, {
    op: 'SerializeProperty', object, arrayDim: read(object, 0x34, services),
    flags, category: category.name, categoryIndex: category.index,
  });
  if (flags & 0x20) write(object, 0x44, archive.readU16(), services, ['repOffset'], 2);
  const version = integer(archiveVersion(archive), 'archive version', { minimum: 0 });
  if (version <= 0x3d) {
    flags = (flags & 0xfff7ffbf) >>> 0;
    put(object, LINKER_PRELOAD.offsets.propertyFlags, flags, services);
  }
  const { linkerRoot, loading } = archiveFlags(archive);
  if (linkerRoot) {
    put(object, 0x48, 0, services);
    put(object, 0x54, 0, services);
  }
  const kind = services.propertyKindOf ? services.propertyKindOf(object)
    : object.kind ?? object.nativeKind;
  switch (kind) {
    case 'ClassProperty': {
      put(object, 0x5c, archive.readObject().object, services);
      const meta = archive.readObject();
      put(object, 0x64, meta.object, services);
      assertCheck(meta.object !== null,
        { line: 0x2ec, file: 0x101b14d8, text: 0x101b14fc }, services, { object });
      break;
    }
    case 'MapProperty':
      put(object, 0x5c, archive.readObject().object, services);
      put(object, 0x60, archive.readObject().object, services);
      break;
    case 'FixedArrayProperty':
      put(object, 0x5c, archive.readObject().object, services);
      put(object, 0x60, archive.readU32(), services);
      break;
    case 'ByteProperty':
    case 'ObjectProperty':
    case 'ArrayProperty':
    case 'StructProperty':
      put(object, 0x5c, archive.readObject().object, services);
      break;
    case 'BoolProperty':
      // 0x10166196-0x101661ae: the +0x5c bitmask is serialized only on a
      // plain non-stream archive; a linker archive leaves it to Link.
      if (!linkerRoot && !loading) put(object, 0x5c, archive.readU32(), services);
      break;
    case 'IntProperty': case 'FloatProperty': case 'NameProperty':
    case 'StrProperty': case 'Property':
      break;
    default:
      fail(`UProperty::Serialize has no recovered tail for kind ${String(kind)}`);
  }
}

/**
 * `FPropertyTag` stream read — body 0x1012a840 (thunk 0x10101ea6).  The tag
 * fields land at +0x00 type (raw byte & 0x0f), +0x01 raw byte, +0x04 name
 * (FName compact), +0x08 struct name (only when type nibble is 0xa), +0x0c
 * size (nibble-selected literal or a 1/2/4-byte read), +0x10 array index
 * (packed: direct byte, 0x80-prefixed word, or 0xc0-prefixed dword; absent
 * for type 3 and when bit 0x80 of the raw byte is clear).
 */
export function readPropertyTag(archive, services = {}, context = {}) {
  const name = archive.readName();
  // The resolved FName (name.name = process-wide index) is what every
  // downstream compare uses: the None test against global 0 (0x102a3f10),
  // the +0x20 property-name match, and the struct-name match.
  const tag = {
    packageIndex: name.index, nameIndex: name.name, name: name.name, text: name.text,
    type: 0, raw: 0, size: 0, arrayIndex: 0, structNameIndex: null, structName: null,
  };
  if (name.name === 0) {
    tag.none = true;
    emit(context, { op: 'TagNone', body: LINKER_PRELOAD.bodies.propertyTag });
    return tag;
  }
  tag.raw = archive.readRaw(1)[0];
  tag.type = tag.raw & 0x0f;
  if (tag.type === 0x0a) {
    const structName = archive.readName();
    tag.structNameIndex = structName.name;
    tag.structName = structName.name;
    tag.structNameText = structName.text;
  }
  switch (tag.raw & 0x70) {
    case 0x00: tag.size = 1; break;
    case 0x10: tag.size = 2; break;
    case 0x20: tag.size = 4; break;
    case 0x30: tag.size = 0x0c; break;
    case 0x40: tag.size = 0x10; break;
    case 0x50: tag.size = archive.readRaw(1)[0]; break;
    case 0x60: tag.size = archive.readU16(); break;
    default: tag.size = archive.readU32(); break;
  }
  if ((tag.raw & 0x80) !== 0 && tag.type !== 3) {
    const first = archive.readRaw(1)[0];
    if ((first & 0x80) === 0) tag.arrayIndex = first;
    else if ((first & 0xc0) === 0x80) {
      tag.arrayIndex = ((first & 0x7f) << 8) | archive.readRaw(1)[0];
    } else {
      tag.arrayIndex = ((first & 0x3f) << 24) | (archive.readRaw(1)[0] << 16)
        | (archive.readRaw(1)[0] << 8) | archive.readRaw(1)[0];
    }
  }
  emit(context, { op: 'PropertyTag', body: LINKER_PRELOAD.bodies.propertyTag, tag });
  return tag;
}

/**
 * `FPropertyTag::SerializeTaggedProperty` — body 0x1012aca0 (thunk
 * 0x10102dc9).  A UBoolProperty (class identity 0x102a6bf0) folds its value
 * into the raw tag byte's 0x80 bit: `*dest |= mask` or `*dest &= ~mask`
 * through the +0x5c bitmask; every other property takes its +0x78
 * `SerializeItem` virtual with the computed destination.
 */
export function serializeTaggedProperty(tag, archive, property, data, services = {}, context = {}) {
  const destOffset = integer(read(property, LINKER_PRELOAD.offsets.propertyOffset, services),
    'property Offset', { minimum: 0 })
    + Math.imul(integer(read(property, LINKER_PRELOAD.offsets.elementSize, services),
      'property ElementSize', { minimum: 0 }), tag.arrayIndex);
  const isBool = same(read(property, LINKER_PRELOAD.offsets.objectClass, services),
    services.boolPropertyClass ?? LINKER_PRELOAD.globals.boolPropertyClass);
  if (isBool) {
    const mask = integer(read(property, 0x5c, services), 'UBoolProperty bitmask', { minimum: 1, maximum: 0xffffffff });
    if (archiveFlags(archive).linkerRoot === 0) {
      fail('SerializeTaggedProperty non-stream bool path is unsupported');
    }
    const cell = required(services.dataReference,
      'defaults cell reference')(data, destOffset, { property, tag, width: 4 });
    const current = integer(cell.get(), 'bool cell', { minimum: 0, maximum: 0xffffffff });
    cell.set((tag.raw & 0x80) !== 0 ? (current | mask) >>> 0 : (current & ~mask) >>> 0);
    emit(context, { op: 'TagBoolItem', property, tag, destOffset, mask, value: cell.get() });
    return { property, kind: 'BoolProperty', destOffset };
  }
  const cell = required(services.dataReference,
    'defaults cell reference')(data, destOffset, { property, tag });
  emit(context, { op: 'TagSerializeItem', property, tag, destOffset });
  const result = required(services.serializeItem,
    'UProperty::SerializeItem dispatch (+0x78)')(property, archive, cell, {
    operation: 'SerializeTaggedProperty', property, tag, destOffset,
  });
  return { property, kind: result?.kind, destOffset, result };
}

/**
 * `UStruct::SerializeTaggedProperties` — body 0x10126730 — restricted to the
 * linker-stream path (archive +0x0c nonzero): the recovered second phase at
 * 0x10126c07 only runs for non-stream archives and is left unsupported here.
 *
 * The loop reads `FPropertyTag` records until the None tag, looks each up in
 * the linked +0x60 property chain (walking +0x4c, matching the +0x20 name
 * index), applies the recovered type/array-index/struct-name checks with
 * their warn-and-skip paths, then dispatches `SerializeTaggedProperty`.
 * `data` is the opaque destination base the host resolves through
 * `services.dataReference(data, offset, detail)`.
 */
export function serializeTaggedPropertiesLoad(structure, archive, data, defaultsStruct, services = {}, context = {}) {
  const flags = archiveFlags(archive);
  assertCheck(flags.linkerRoot !== 0 || flags.loading !== 0,
    { line: 0x1d3, file: 0x101a9814, text: 0x101a9838 }, services, { structure });
  // 0x1012679b-0x101267aa: the DefaultsStruct's FArray (+0x4d4/+0x4d8) is
  // loaded up front; only the non-stream second phase consumes it.
  const superDefaults = defaultsStruct ? {
    data: read(defaultsStruct, LINKER_PRELOAD.offsets.defaults, services),
    num: read(defaultsStruct, LINKER_PRELOAD.offsets.defaults + 4, services),
  } : null;
  if (flags.linkerRoot === 0) {
    fail('UStruct::SerializeTaggedProperties non-stream pass (0x10126c07) is unsupported');
  }
  const consumed = [];
  const seen = new Set();
  for (;;) {
    const tag = readPropertyTag(archive, services, context);
    if (tag.nameIndex === 0) break;
    // Property lookup: walk the +0x60 chain via +0x4c, matching +0x20.
    let property = pointer(read(structure, LINKER_PRELOAD.offsets.propertyLink, services));
    let matched = null;
    const chainSeen = new Set();
    while (property !== null) {
      const key = identity(property) ?? property;
      if (chainSeen.has(key)) throw new Error('Cyclic +0x60 property chain');
      chainSeen.add(key);
      if (read(property, LINKER_PRELOAD.offsets.name, services) === tag.nameIndex) {
        matched = property;
        break;
      }
      property = pointer(read(property, LINKER_PRELOAD.offsets.propertyLinkNext, services));
    }
    if (matched === null) {
      emit(context, { op: 'TagUnmatched', tag });
      required(services.warnLog, 'GWarn Logf for an unmatched tag')({
        device: LINKER_PRELOAD.globals.gwarn, body: LINKER_PRELOAD.bodies.logf,
        format: 0x101a9858, tag, structure,
      });
      archive.readRaw(tag.size);
      continue;
    }
    property = matched;
    // The recovered body calls the property's +0x9c GetID slot virtually
    // (`call dword ptr [eax+0x9c]` at 0x1012690a and 0x1012682d).  Every
    // property vtable's slot reaches the shared UProperty::GetID body
    // 0x101655f0 (`mov eax,[ecx+0x24]; mov al,[eax+0x20]; ret` — the
    // property class object's name index low byte) EXCEPT UClassProperty:
    // its vtable (0x10175ec4) +0x9c holds thunk 0x10102ac2 -> body
    // 0x10113e20 (`mov al, 5; ret`), so a class-reference default ships and
    // is accepted as tag type 5.
    const propertyClass = pointer(read(property, LINKER_PRELOAD.offsets.objectClass, services));
    const propertyKind = services.propertyKindOf ? services.propertyKindOf(property)
      : property.kind ?? property.nativeKind;
    const propertyId = propertyClass === null ? 0
      : propertyKind === 'ClassProperty' ? 0x05
      : integer(read(propertyClass, LINKER_PRELOAD.offsets.name, services) ?? 0,
        'property-class name index', { minimum: 0, maximum: 0xffffffff }) & 0xff;
    if (tag.type === 0x07 && propertyId === 0x0d) {
      fail('SerializeTaggedProperties type-7 wide-string path (0x10126829) is unsupported');
    }
    if (tag.type !== propertyId) {
      emit(context, { op: 'TagTypeMismatch', tag, property, propertyId });
      required(services.warnLog, 'GWarn Logf for a tag type mismatch')({
        device: LINKER_PRELOAD.globals.gwarn, body: LINKER_PRELOAD.bodies.logf,
        format: 0x101a9890, tag, property, propertyId,
      });
      archive.readRaw(tag.size);
      continue;
    }
    const arrayDim = integer(read(property, LINKER_PRELOAD.offsets.arrayDim, services),
      'property ArrayDim', { minimum: 0 });
    if (tag.arrayIndex >= arrayDim) {
      emit(context, { op: 'TagArrayIndex', tag, property, arrayDim });
      required(services.warnLog, 'GWarn Logf for an out-of-range tag index')({
        device: LINKER_PRELOAD.globals.gwarn, body: LINKER_PRELOAD.bodies.logf,
        format: 0x101a98ec, tag, property, arrayDim,
      });
      archive.readRaw(tag.size);
      continue;
    }
    if (tag.type === 0x0a) {
      const structRef = pointer(read(property, 0x5c, services));
      const structNameIndex = structRef === null ? null
        : read(structRef, LINKER_PRELOAD.offsets.name, services);
      if (structNameIndex !== tag.structNameIndex) {
        emit(context, { op: 'TagStructMismatch', tag, property, structNameIndex });
        required(services.warnLog, 'GWarn Logf for a struct-name mismatch')({
          device: LINKER_PRELOAD.globals.gwarn, body: LINKER_PRELOAD.bodies.logf,
          format: 0x101a992c, tag, property, structNameIndex,
        });
        archive.readRaw(tag.size);
        continue;
      }
    }
    const propertyFlags = integer(read(property, LINKER_PRELOAD.offsets.propertyFlags, services),
      'property PropertyFlags', { minimum: 0, maximum: 0xffffffff });
    if ((propertyFlags & 0x1000) !== 0
      || ((propertyFlags & 0x2000) !== 0 && (archive.ar18 ?? 0) !== 0)) {
      // 0x10126ad7-0x10126b8c: CPF_Native (0x1000) always skips; CPF_Transient
      // (0x2000) skips only while the archive reads transient data (+0x18).
      // The tag-name text is compared against "XLevel" twice (stricmp):
      // equal -> both warns are suppressed; otherwise GWarn logs
      // "Property %s of %s is not serializable" (tag text, property text)
      // then "Skipping %i bytes of type %i" (tag size, raw tag type).
      const tagText = tag.text ?? services.nameText?.(tag.nameIndex);
      const propName = read(property, LINKER_PRELOAD.offsets.name, services);
      const propText = services.nameText?.(propName);
      const isXLevel = typeof tagText === 'string' && tagText.toUpperCase() === 'XLEVEL';
      if (!isXLevel) {
        emit(context, { op: 'TagNotSerializable', tag, property, propertyFlags });
        required(services.warnLog, 'GWarn Logf for a non-serializable property tag')({
          device: LINKER_PRELOAD.globals.gwarn, body: LINKER_PRELOAD.bodies.logf,
          format: 0x101a9998, args: [tagText, propText], tag, property,
        });
        emit(context, { op: 'TagSkippingBytes', tag, property });
        required(services.warnLog, 'GWarn Logf for skipped tag bytes')({
          device: LINKER_PRELOAD.globals.gwarn, body: LINKER_PRELOAD.bodies.logf,
          format: 0x101a99f4, args: [tag.size, tag.type], tag, property,
        });
      }
      archive.readRaw(tag.size);
      continue;
    }
    seen.add(identity(property) ?? property);
    consumed.push({ tag, property });
    serializeTaggedProperty(tag, archive, property, data, services, context);
  }
  emit(context, { op: 'TaggedPropertiesExit', structure, count: consumed.length });
  return { structure, consumed, superDefaults };
}
