/**
 * Narrow host boundary for Core UObject::StaticLoadObject's existing and
 * evidence-backed first-load linker paths.
 *
 * The native body is recovered in docs/script-static-load-object.md.  This
 * module owns the observable call order and the linker hash/import walk; the
 * host supplies canonical object references and the three services whose
 * startup graphs are separate (ResolveName, FName(text,1), appStrcpy).
 *
 * First-load construction remains an explicit host service because the native
 * ULinkerLoad constructor owns file/archive allocation.  When that service is
 * bound, this helper publishes the returned linker into the live loader array
 * before the resolver/export walk.  The empty outermost load lifecycle is
 * implemented below; nonempty postload and loader-cleanup branches still
 * require explicit services.  No path-only or display-name fallback is
 * inferred here.
 */

export const STATIC_LOAD_OBJECT_CONTRACT = Object.freeze({
  thunk: 0x10102a1d,
  body: 0x10154d50,
  beginLoadThunk: 0x10103328,
  beginLoadBody: 0x10155410,
  endLoadThunk: 0x10102f27,
  endLoadBody: 0x10155510,
  resolveName: 0x10102c34,
  fNameText: 0x10102e96,
  appStrcpy: 0x10102432,
  getPackageLinkerThunk: 0x10101591,
  createLinkerLoadThunk: 0x10101f91,
  createLinkerLoadBody: 0x10160000,
  linkerArchiveBaseVtable: 0x101751f8,
  linkerArchiveVtable: 0x1017a430,
  linkerArchiveVersion: 0x44,
  linkerArchiveLicenseeVersion: 0x44c,
  linkerReaderOffset: 0x4e4,
  linkerResolve: 0x10102a72,
  findExportIndex: 0x1010191a,
  createExport: 0x101012fd,
  loadFlagsOr: 0x28,
  skipLinkerFlag: 0x40,
  loaderOuterField: 'outer',
  classNameField: 'nameIndex',
  classOuterField: 'outer',
  exportRecordStride: 0x24,
  importRecordStride: 0x1c,
});

// Core globals and calls reached by BeginLoad/EndLoad when the nesting counter
// crosses 0 -> 1 -> 0.  The names describe the host-facing state rather than
// claiming Unreal's private linker type layout where this task has not
// recovered it.  The addresses and constants are from the hash-checked body.
export const STATIC_LOAD_LIFECYCLE_CONTRACT = Object.freeze({
  loadNest: 0x102a2650,
  registrationQueueHead: 0x102a265c,
  loadedArrayData: 0x1029e638,
  loadedArrayNum: 0x1029e63c,
  loadedArrayMax: 0x1029e640,
  loaderArrayData: 0x1029e608,
  loaderArrayNum: 0x1029e60c,
  loaderReaderOffset: 0x90,
  loaderCleanupState: 0x102a2658,
  endLoadLogName: 0x308,
  endLoadLogFormat: 0x101af3d4,
  loadedArrayElementSize: 4,
  loadedArrayReallocTag: 0x101ab50c,
});

export class StaticLoadObjectBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', value = undefined, field = null} = {}) {
    super(message);
    this.name = 'StaticLoadObjectBoundaryError';
    this.code = `STATIC_LOAD_OBJECT_${kind}`;
    this.value = value;
    this.field = field;
  }
}

const fail = (message, details) => {
  throw new StaticLoadObjectBoundaryError(message, details);
};

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`StaticLoadObject ${label} service suspended; native path is synchronous`, {
      kind: 'ASYNC', value,
    });
  }
  return value;
}

function requireFunction(value, name) {
  if (typeof value !== 'function') fail(`StaticLoadObject requires ${name} service`, {kind: 'SERVICE'});
  return value;
}

function requireObject(value, name, {allowNull = false} = {}) {
  if (allowNull && value === null) return value;
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    fail(`StaticLoadObject requires canonical ${name}`, {kind: 'REFERENCE', value});
  }
  return value;
}

function requireInt(value, name, {min = -0x80000000, max = 0x7fffffff} = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`StaticLoadObject requires int32 ${name}`, {kind: 'VALUE', value});
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== 'string') fail(`StaticLoadObject requires ${name} text`, {kind: 'VALUE', value});
  return value;
}

function readField(object, field, services) {
  const read = requireFunction(services.read, 'read');
  const value = sync(read(object, field, {field}), `read ${field}`);
  if (value === undefined) {
    fail(`StaticLoadObject reached unresolved ${field} field`, {kind: 'FIELD', value, field});
  }
  return value;
}

function requireArray(value, name) {
  if (!Array.isArray(value)) {
    fail(`StaticLoadObject requires live ${name} array`, {kind: 'SERVICE', value});
  }
  return value;
}

function requireEmptyArray(value, name) {
  const array = requireArray(value, name);
  if (array.length !== 0) {
    fail(`StaticLoadObject reached nonempty ${name} lifecycle branch`, {
      kind: 'NONEMPTY', value: array.length, field: name,
    });
  }
  return array;
}

function requireZero(value, name) {
  if (value !== 0 && value !== null) {
    fail(`StaticLoadObject requires empty ${name}`, {kind: 'NONEMPTY', value, field: name});
  }
}

/**
 * Implement the reached empty outermost BeginLoad checks from Core.
 *
 * Native BeginLoad has no observable write besides the nest increment on this
 * branch.  It asserts an empty GObjLoaded count, an empty registration queue,
 * and a non-null +0x90 reader on every in-range linker.  The latter is a
 * presence check only; no reader virtual is called here.
 */
function beginOutermostEmpty(services, events, state) {
  const loadedObjects = requireEmptyArray(services.loadedObjects, 'GObjLoaded');
  requireZero(state.registrationQueueHead, 'registration queue');
  const loaders = requireArray(services.loaders, 'ULinkerLoad');
  for (let index = 0; index < loaders.length; index += 1) {
    const linker = loaders[index];
    requireObject(linker, `loader[${index}]`);
    const reader = readField(linker, 'reader', services);
    if (reader === undefined || reader === null || reader === 0 || reader === false) {
      fail(`StaticLoadObject reached null loader[${index}] +0x90 reader`, {
        kind: 'FIELD', value: reader, field: `loader[${index}].reader`,
      });
    }
  }
  // Keep the exact empty-array observation on the lifecycle event so a host
  // integration can audit that this branch did not silently skip its checks.
  let begin = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].op === 'BeginLoad') {
      begin = events[index];
      break;
    }
  }
  if (begin) {
    begin.loadedCount = loadedObjects.length;
    begin.loaderCount = loaders.length;
    begin.registrationQueueEmpty = true;
  }
}

/**
 * Implement the reached empty outermost EndLoad work from Core.
 *
 * EndLoad logs first, then clears GObjLoaded's Num/Max and calls FArray::Realloc
 * with element size 4.  With cleanup state zero, the linker cleanup loop is
 * skipped and the state is written back as zero.  Each external edge is
 * required as a synchronous host service so an omitted allocator/output path
 * cannot become a guessed no-op.
 */
function endOutermostEmpty(services, events, state) {
  // EndLoad calls Logf before rereading GObjLoaded.Num.  Keep the live array
  // reference across that boundary so a callback that publishes an object is
  // observed at the same point as the native loop.
  const loadedObjects = requireArray(services.loadedObjects, 'GObjLoaded');
  const logEndLoad = requireFunction(services.logEndLoad, 'logEndLoad');
  const receiver = services.logReceiver;
  if (receiver === undefined) {
    fail('StaticLoadObject requires the GWarn Logf receiver', {kind: 'SERVICE'});
  }
  sync(logEndLoad({
    receiver,
    name: STATIC_LOAD_LIFECYCLE_CONTRACT.endLoadLogName,
    formatPointer: STATIC_LOAD_LIFECYCLE_CONTRACT.endLoadLogFormat,
    native: STATIC_LOAD_OBJECT_CONTRACT.endLoadBody,
  }), 'logEndLoad');
  events.push({op: 'Logf', receiver, name: STATIC_LOAD_LIFECYCLE_CONTRACT.endLoadLogName,
    formatPointer: STATIC_LOAD_LIFECYCLE_CONTRACT.endLoadLogFormat});

  if (loadedObjects.length !== 0) {
    fail('StaticLoadObject reached nonempty GObjLoaded postload branch', {
      kind: 'NONEMPTY', value: loadedObjects.length, field: 'GObjLoaded',
    });
  }

  // Core writes both fields before the Realloc call, even though they are
  // already zero in this accepted empty fixture.
  loadedObjects.length = 0;
  requireInt(state.loadedMax, 'loadState.loadedMax', {min: 0});
  state.loadedMax = 0;
  const reallocLoaded = requireFunction(services.reallocLoaded, 'reallocLoaded');
  sync(reallocLoaded({
    array: loadedObjects,
    elementSize: STATIC_LOAD_LIFECYCLE_CONTRACT.loadedArrayElementSize,
    num: 0,
    max: 0,
    tag: STATIC_LOAD_LIFECYCLE_CONTRACT.loadedArrayReallocTag,
    native: STATIC_LOAD_OBJECT_CONTRACT.endLoadBody,
  }), 'reallocLoaded');
  events.push({op: 'FArrayRealloc', elementSize: STATIC_LOAD_LIFECYCLE_CONTRACT.loadedArrayElementSize,
    num: 0, max: 0, tag: STATIC_LOAD_LIFECYCLE_CONTRACT.loadedArrayReallocTag});
  const cleanupState = requireInt(state.loaderCleanupState,
    'loadState.loaderCleanupState', {min: 0});
  if (cleanupState !== 0) {
    fail('StaticLoadObject reached nonzero loader cleanup state', {
      kind: 'CLEANUP', value: cleanupState, field: 'loaderCleanupState',
    });
  }
  state.loaderCleanupState = 0;
}

function lifecycleBegin(services, events) {
  const state = services.loadState;
  requireObject(state, 'loadState');
  const before = requireInt(state.nest, 'loadState.nest', {min: 0});
  const after = before + 1;
  state.nest = after;
  const outermost = after === 1;
  events.push({op: 'BeginLoad', before, after, outermost});
  if (outermost) {
    if (services.outermostBeginLoad !== undefined) {
      const service = requireFunction(services.outermostBeginLoad, 'outermostBeginLoad');
      sync(service({state, native: STATIC_LOAD_OBJECT_CONTRACT.beginLoadBody}),
        'outermostBeginLoad');
    } else {
      beginOutermostEmpty(services, events, state);
    }
  }
}

function lifecycleEnd(services, events) {
  const state = services.loadState;
  requireObject(state, 'loadState');
  const before = requireInt(state.nest, 'loadState.nest', {min: 1});
  const after = before - 1;
  state.nest = after;
  const outermost = after === 0;
  events.push({op: 'EndLoad', before, after, outermost});
  if (outermost) {
    if (services.outermostEndLoad !== undefined) {
      const service = requireFunction(services.outermostEndLoad, 'outermostEndLoad');
      sync(service({state, native: STATIC_LOAD_OBJECT_CONTRACT.endLoadBody}),
        'outermostEndLoad');
    } else {
      endOutermostEmpty(services, events, state);
    }
  }
}

function holder(value) {
  let current = value;
  return {
    get: () => current,
    set: next => { current = next; },
  };
}

function resolveName(request, services, events) {
  const resolve = requireFunction(services.resolveName, 'resolveName');
  const outerRef = holder(request.outer ?? null);
  const nameRef = holder(requireString(request.name, 'name'));
  const result = sync(resolve(outerRef, nameRef, {
    create: 1,
    throwOnConfigMissing: 1,
  }), 'resolveName');
  if (typeof result !== 'boolean' && result !== 0 && result !== 1) {
    fail(`StaticLoadObject ResolveName returned ${String(result)}`, {kind: 'RETURN', value: result});
  }
  const outer = outerRef.get();
  const name = requireString(nameRef.get(), 'resolved name');
  if (outer !== null) requireObject(outer, 'resolved Outer');
  events.push({op: 'ResolveName', create: 1, throw: 1, name, outer});
  return {outer, name, result};
}

function rootOuter(outer, services) {
  let current = outer;
  const seen = new Set();
  while (current !== null) {
    requireObject(current, 'Outer');
    if (seen.has(current)) fail('StaticLoadObject encountered a cyclic Outer chain', {kind: 'REFERENCE'});
    seen.add(current);
    const next = readField(current, 'outer', services);
    if (next === null) return current;
    requireObject(next, 'Outer');
    current = next;
  }
  return null;
}

function loadedLinker(root, services, events) {
  // GetPackageLinker only scans its loader array when Outer is non-null
  // (0x1015457f).  A null root proceeds directly to file/error handling.
  if (root === null) return null;
  const loaders = services.loaders;
  if (!Array.isArray(loaders)) fail('StaticLoadObject requires the live linker loader array', {kind: 'SERVICE'});
  for (let index = 0; index < loaders.length; index += 1) {
    const linker = loaders[index];
    // The original loop dereferences every in-range slot; a null slot is not
    // evidence of an absent linker and must not silently terminate the scan.
    requireObject(linker, `loader[${index}]`);
    const candidateOuter = readField(linker, STATIC_LOAD_OBJECT_CONTRACT.loaderOuterField, services);
    if (candidateOuter === root) return linker;
  }
  return null;
}

function filenameLinker(filename, guid, services, events) {
  const findFile = requireFunction(services.findPackageFile, 'findPackageFile');
  const found = sync(findFile({filename, guid}), 'findPackageFile');
  if (found?.found !== true) {
    fail('StaticLoadObject filename lookup/error handling is unbound', {kind:'FILE_SEARCH',value:found});
  }
  const resolved = requireString(found.path, 'resolved package filename');
  if (resolved.length >= 256 || filename.length >= 256 || filename.includes('\0'))
    fail('StaticLoadObject filename exceeds the native scratch boundary', {kind:'FILENAME',value:filename});
  events.push({op:'appFindPackageFile',filename,guid,found:true});
  const copy = requireFunction(services.copyString, 'copyString');
  const copied = sync(copy({source:filename}), 'copyString');
  if (copied !== filename) fail('StaticLoadObject filename copy changed the input', {kind:'RETURN',value:copied});
  events.push({op:'appStrcpy',source:filename});
  let stem = copied;
  const scan = char => {
    const index = stem.indexOf(char);
    events.push({op:'appStrchr',text:stem,char,index});
    return index;
  };
  while (true) {
    let advanced = false;
    for (const separator of ['\\','/',':']) {
      if (scan(separator) !== -1) {
        stem = stem.slice(scan(separator)+1);
        advanced = true;
        break;
      }
    }
    if (!advanced) break;
  }
  if (scan('.') !== -1) stem = stem.slice(0,scan('.'));
  const create = requireFunction(services.createPackage, 'createPackage');
  events.push({op:'CreatePackage',outer:null,name:stem});
  const packageObject = sync(create({outer:null,name:stem}), 'createPackage');
  requireObject(packageObject,'filename package');
  const linker = loadedLinker(packageObject, services, events);
  if (linker === null) fail('StaticLoadObject filename reached linker construction', {kind:'FIRST_LOAD'});
  return linker;
}

/**
 * Bind the reached ULinkerLoad constructor without hiding its native-owned
 * archive/file allocation behind a fabricated linker.  GetPackageLinker adds
 * a successful first-load result to GObjLoaders; publish the canonical result
 * here so the following export walk and later calls observe the same identity.
 * The constructor service is intentionally synchronous, matching the native
 * StaticLoadObject frame.
 */
function constructFirstLoadLinker({root, filename, flags, sandbox, guid}, services, events) {
  if (root === null) {
    fail('StaticLoadObject first-load construction requires a resolved package root', {
      kind: 'FIRST_LOAD', value: {root, filename, flags, sandbox, guid},
    });
  }
  requireObject(root, 'first-load package root');
  const create = requireFunction(services.createLinkerLoad, 'createLinkerLoad');
  const loaders = requireArray(services.loaders, 'ULinkerLoad');
  const linker = sync(create({root, filename, flags, sandbox, guid}), 'createLinkerLoad');
  requireObject(linker, 'constructed ULinkerLoad');
  const linkerOuter = readField(linker, STATIC_LOAD_OBJECT_CONTRACT.loaderOuterField, services);
  if (linkerOuter !== root) {
    fail('StaticLoadObject first-load linker Outer did not preserve the package root', {
      kind: 'REFERENCE', value: {root, linker, linkerOuter}, field: 'outer',
    });
  }
  const reader = readField(linker, 'reader', services);
  if (reader === null || reader === undefined || reader === 0 || reader === false) {
    fail('StaticLoadObject first-load ULinkerLoad has no native reader', {
      kind: 'FIELD', value: reader, field: 'reader',
    });
  }
  if (!loaders.includes(linker)) loaders.push(linker);
  // A constructor adapter may publish the object itself.  Re-scan the live
  // array in either case so a duplicate or mismatched package cannot pass as
  // the native GetPackageLinker result.
  const published = loadedLinker(root, services, events);
  if (published !== linker) {
    fail('StaticLoadObject first-load linker was not published for its package root', {
      kind: 'REFERENCE', value: {root, linker, published}, field: 'loaders',
    });
  }
  events.push({op: 'CreateLinkerLoad', root, filename, flags, sandbox, guid,
    thunk: STATIC_LOAD_OBJECT_CONTRACT.createLinkerLoadThunk,
    body: STATIC_LOAD_OBJECT_CONTRACT.createLinkerLoadBody});
  return linker;
}

function linkerFor({root, filename, flags, sandbox, guid}, services, events) {
  let linker = null;
  if ((flags & STATIC_LOAD_OBJECT_CONTRACT.skipLinkerFlag) === 0) {
    const linkerFlags = flags | STATIC_LOAD_OBJECT_CONTRACT.loadFlagsOr;
    events.push({op: 'GetPackageLinker', root, filename, flags: linkerFlags, sandbox, guid});
    linker = loadedLinker(root, services, events);
    if (linker === null) {
      if (root === null && filename !== null) linker = filenameLinker(filename,guid,services,events);
      else if (root !== null && services.createLinkerLoad !== undefined) {
        linker = constructFirstLoadLinker({root, filename, flags: linkerFlags, sandbox, guid},
          services, events);
      } else fail('StaticLoadObject reached the unbound first-load GetPackageLinker path', {
        kind: 'FIRST_LOAD', value: {root, filename, flags: linkerFlags, sandbox, guid},
      });
    } else {
      const readExtension = requireFunction(services.readPackageExtension, 'readPackageExtension');
      const extension = requireString(sync(readExtension(), 'readPackageExtension'),
        'package extension');
      const copy = requireFunction(services.copyString, 'copyString');
      sync(copy({source: extension}), 'copyString');
      events.push({op: 'appStrcpy', source: extension});
    }
    if (sandbox !== null || guid !== null)
      fail('StaticLoadObject sandbox/GUID checks are unbound', {kind:'LINKER_CHECK',value:{sandbox,guid}});
  }
  return linker;
}

function nameIndex(text, services, events) {
  const findName = requireFunction(services.findName, 'findName');
  const result = sync(findName(text, 1), 'findName');
  const index = requireInt(result, 'FName index', {min: 0});
  events.push({op: 'FName', text, findMode: 1, nameIndex: index});
  return index;
}

function exportRecord(linker, index, services) {
  const readExport = requireFunction(services.readExport, 'readExport');
  const record = sync(readExport(linker, index, {
    stride: STATIC_LOAD_OBJECT_CONTRACT.exportRecordStride,
  }), 'readExport');
  requireObject(record, `export[${index}]`);
  for (const field of ['classIndex', 'outerIndex', 'nameIndex', 'nextHash']) {
    requireInt(record[field], `export[${index}].${field}`);
  }
  if (record.object === undefined) {
    fail(`StaticLoadObject reached unresolved export[${index}].object`, {
      kind: 'FIELD', value: record.object, field: 'object',
    });
  }
  return record;
}

function importWord(linker, byteOffset, services) {
  const readImportWord = requireFunction(services.readImportWord, 'readImportWord');
  const offset = requireInt(byteOffset, 'import byte offset', {min: 0});
  const value = sync(readImportWord(linker, offset, {
    stride: STATIC_LOAD_OBJECT_CONTRACT.importRecordStride,
  }), 'readImportWord');
  return requireInt(value, `import word +0x${offset.toString(16)}`);
}

function classIdentityMatches(classRef, linker, record, className, classOuterName, services) {
  const classIndex = record.classIndex;
  let recordOuterName;
  if (classIndex < 0) {
    const outerImportIndex = importWord(linker, -0x1c * classIndex - 0x14, services);
    recordOuterName = importWord(linker, -0x1c * outerImportIndex - 0x10, services);
  } else if (classIndex > 0) {
    const linkerOuter = readField(linker, 'outer', services);
    requireObject(linkerOuter, 'linker Outer');
    recordOuterName = requireInt(readField(linkerOuter, 'nameIndex', services),
      'linker Outer name index', {min: 0});
  } else {
    recordOuterName = 0x14;
  }
  if (recordOuterName !== classOuterName) return false;

  let recordName;
  if (classIndex < 0) {
    recordName = importWord(linker, -0x1c * classIndex - 0x10, services);
  } else if (classIndex > 0) {
    const classRecord = exportRecord(linker, classIndex - 1, services);
    recordName = classRecord.nameIndex;
  } else {
    recordName = 0x29b;
  }
  return recordName === className;
}

function findExportIndex(linker, classRef, requestedName, requestedOuter, services, events) {
  requireObject(classRef, 'Class');
  const className = requireInt(readField(classRef, 'nameIndex', services),
    'Class name index', {min: 0});
  const classOuter = readField(classRef, 'outer', services);
  requireObject(classOuter, 'Class Outer');
  const classOuterName = requireInt(readField(classOuter, 'nameIndex', services),
    'Class Outer name index', {min: 0});
  const normalizedOuter = classOuterName === 0x18 ? 0x17 : classOuterName;
  const bucket = (className * 7 + normalizedOuter * 31 + requestedName) & 0xff;
  const readHashHead = requireFunction(services.readHashHead, 'readHashHead');
  let index = requireInt(sync(readHashHead(linker, bucket), 'readHashHead'),
    `hash bucket ${bucket}`);
  const seen = new Set();
  while (index !== -1) {
    if (seen.has(index)) fail(`StaticLoadObject encountered a cyclic export hash at ${index}`, {kind: 'REFERENCE'});
    seen.add(index);
    const record = exportRecord(linker, index, services);
    if (record.nameIndex === requestedName &&
        (record.outerIndex === requestedOuter || requestedOuter === -1) &&
        classIdentityMatches(classRef, linker, record, className, classOuterName, services)) {
      events.push({op: 'FindExportIndex', className, classOuterName, objectName: requestedName,
        requestedOuter, bucket, index});
      return {index, record};
    }
    index = record.nextHash;
  }
  events.push({op: 'FindExportIndex', className, classOuterName, objectName: requestedName,
    requestedOuter, bucket, index: -1});
  return null;
}

function existingExport(linker, classRef, match, services, events) {
  const {index, record} = match;
  if (record.object === null || record.object === 0) {
    fail(`StaticLoadObject reached null export[${index}] construction`, {
      kind: 'SERVICE', value: {linker, index}, field: 'object',
    });
  }
  const create = requireFunction(services.createExport, 'createExport');
  const object = sync(create({linker, index, classRef, record, existing: record.object}),
    'createExport');
  if (object !== record.object) {
    fail(`StaticLoadObject createExport did not preserve existing export[${index}]`, {
      kind: 'RETURN', value: object,
    });
  }
  events.push({op: 'CreateExport', index, existing: object});
  return object;
}

/**
 * Execute the recovered synchronous StaticLoadObject path.
 *
 * Required service shape (all pointer values are canonical host identities):
 *
 * - `read(object, field)` reads `outer`/`nameIndex` and any linker-owned field;
 * - `loadState.nest` is the Core load nesting counter;
 * - for an outermost empty lifecycle, `loadState.registrationQueueHead` is
 *   `null` or `0`, `loadState.loadedMax` is an int32, and
 *   `loadState.loaderCleanupState` is `0`;
 * - `resolveName(outerRef, nameRef, {create, throwOnConfigMissing})` preserves
 *   the two mutable holders;
 * - `loaders` is the ordered existing ULinkerLoad array;
 * - `loadedObjects` is the live GObjLoaded array.  The empty outermost branch
 *   requires it to be empty and reads each loader's `reader` field (the
 *   native `+0x90` presence check);
 * - `readPackageExtension()` and `copyString({source})` bind appStrcpy;
 * - a null resolved root plus filename may use
 *   `findPackageFile({filename,guid})->{found:true,path}` and
 *   `createPackage({outer:null,name})->canonicalPackage` to reach an existing
 *   linker. These leaves must provide the original file/creation behavior;
 *   filename parsing and the second loader scan execute in this module;
 * - `findName(text, 1)` returns the existing FName index;
 * - `readHashHead(linker, bucket)`, `readExport(linker, index)`, and
 *   `readImportWord(linker, byteOffset)` expose the native linker tables;
 * - `createExport({linker,index,classRef,record,existing})` returns the same
 *   canonical existing export object;
 * - an optional synchronous `createLinkerLoad({root,filename,flags,sandbox,guid})`
 *   binds the recovered first-load ULinkerLoad constructor.  It must return a
 *   canonical linker whose `outer` is `root` and whose native reader is
 *   non-null; this helper publishes it in `loaders` before the export walk.
 *   The adapter owns the archive/file allocation described in
 *   `docs/script-linker-lazy-loader.md` and may retain explicit unsupported
 *   null-export, metaclass, and nonempty post-load branches;
 * - `logReceiver`, `logEndLoad({receiver,name,formatPointer,native})`, and
 *   `reallocLoaded({array,elementSize,num,max,tag,native})` are required for
 *   the empty outermost EndLoad branch.  They are synchronous and must retain
 *   the native Logf and FMalloc boundaries;
 * - optional `outermostBeginLoad`/`outermostEndLoad` callbacks may replace the
 *   built-in empty checks only when the caller has separately bound an exact
 *   lifecycle graph;
 * - `staticFindObject` is required only when the explicit linker/export lookup
 *   misses or the `LoadFlags & 0x40` branch skips linker lookup.  A missing
 *   preloaded linker is an explicit FIRST_LOAD boundary unless the caller
 *   binds the exact `createLinkerLoad` service above.
 */
export function staticLoadObject(request, services = {}) {
  requireObject(request, 'StaticLoadObject request');
  requireObject(request.classRef, 'Class');
  const name = requireString(request.name, 'name');
  const flags = requireInt(request.flags, 'LoadFlags', {min: 0});
  if (request.filename !== null && request.filename !== undefined) {
    requireString(request.filename, 'Filename');
  }
  if (request.sandbox !== null && request.sandbox !== undefined) {
    requireObject(request.sandbox, 'Sandbox');
  }
  const events = [{
    op: 'StaticLoadObject', classRef: request.classRef, outer: request.outer ?? null,
    path: name, filename: request.filename ?? null, flags, sandbox: request.sandbox ?? null,
  }];
  lifecycleBegin(services, events);
  try {
    const resolved = resolveName({...request, name}, services, events);
    const root = rootOuter(resolved.outer, services);
    const linker = linkerFor({root, filename: request.filename ?? null, flags,
      sandbox: request.sandbox ?? null, guid: null}, services, events);
    if (linker !== null) {
      const requestedName = nameIndex(resolved.name, services, events);
      const match = findExportIndex(linker, request.classRef, requestedName, -1, services, events);
      if (match !== null) return {object: existingExport(linker, request.classRef, match, services, events), events};
    }
    const findObject = requireFunction(services.staticFindObject, 'staticFindObject');
    const object = sync(findObject({classRef: request.classRef, outer: resolved.outer,
      name: resolved.name, exactClass: 0}), 'staticFindObject');
    if (object === undefined) fail('StaticLoadObject StaticFindObject returned undefined', {kind: 'RETURN'});
    events.push({op: 'StaticFindObject', object});
    return {object, events};
  } finally {
    lifecycleEnd(services, events);
  }
}
