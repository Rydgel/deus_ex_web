import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';

import {gameDirectory} from './game-directory.mjs';
import {conditionalPostLoad, postLoadObject} from '../src/runtime/script-post-load.mjs';
import {
  STATIC_LOAD_OBJECT_CONTRACT,
  STATIC_LOAD_LIFECYCLE_CONTRACT,
  StaticLoadObjectBoundaryError,
  staticLoadObject,
} from '../src/runtime/script-static-load-object.mjs';

const root = path.resolve(process.argv[2] ?? gameDirectory());
const python = process.env.DEUS_EX_NATIVE_PYTHON ?? '.cache/native-probe-env/bin/python';
const native = JSON.parse(execFileSync(python, [
  'scripts/native-static-load-object-oracle.py', root,
], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024}));

assert.deepEqual(native.hashes, {
  'Core.dll': '8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4',
  'Engine.dll': '0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4',
});
assert.deepEqual(native.addresses, {
  StaticLoadObject: '0x10154d50',
  BeginLoadThunk: '0x10103328',
  BeginLoadBody: '0x10155410',
  EndLoadThunk: '0x10102f27',
  EndLoadBody: '0x10155510',
  ResolveName: '0x10102c34',
  FNameText: '0x10102e96',
  GetPackageLinker: '0x10101591',
  FindExportIndex: '0x10161e00',
  CreateExport: '0x1012e230',
  Logf: '0x10102a95',
  FArrayRealloc: '0x10145440',
});

const nativeCase = native.case;
assert.equal(nativeCase.result, 'DeusExConText.Mission00');
assert.equal(nativeCase.flags, 2);
assert.equal(nativeCase.loadNestAfter, 1);

const nativeOutermost = native.outermost;
assert.equal(nativeOutermost.result, 'DeusExConText.Mission00');
assert.equal(nativeOutermost.flags, 2);
assert.equal(nativeOutermost.loadNestBefore, 0);
assert.equal(nativeOutermost.loadNestAfter, 0);
assert.equal(nativeOutermost.loadedNumAfter, 0);
assert.equal(nativeOutermost.loadedMaxAfter, 0);
assert.equal(nativeOutermost.loadStateAfter, 0);

const packageObject = {label: 'DeusExConText', outer: null, nameIndex: 0x42};
const classPackage = {label: 'ConSys', outer: null, nameIndex: 0x53};
const classRef = {label: 'ConSys.ConversationList', outer: classPackage, nameIndex: 0x29a};
const loadedObject = {label: 'DeusExConText.Mission00', outer: packageObject, nameIndex: 0x29b};
const exportRecord = {
  classIndex: -1,
  outerIndex: 0,
  nameIndex: 0x29b,
  object: loadedObject,
  nextHash: -1,
};
const linker = {
  label: 'LinkerLoad(DeusExConText)',
  outer: packageObject,
  reader: {label: 'LinkerReader(DeusExConText)'},
};
const loadState = {nest: 1};
const serviceCalls = [];

const existingRequest = {
  classRef,
  outer: null,
  name: 'DeusExConText.Mission00',
  filename: null,
  flags: 2,
  sandbox: null,
};
const existingServices = {
  loadState,
  read: (object, field) => object[field],
  resolveName: (outerRef, nameRef, options) => {
    assert.deepEqual(options, {create: 1, throwOnConfigMissing: 1});
    assert.equal(outerRef.get(), null);
    assert.equal(nameRef.get(), 'DeusExConText.Mission00');
    outerRef.set(packageObject);
    nameRef.set('Mission00');
    serviceCalls.push('ResolveName');
    return true;
  },
  loaders: [linker],
  readPackageExtension: () => '',
  copyString: ({source}) => {
    assert.equal(source, '');
    serviceCalls.push('appStrcpy');
    return source;
  },
  findName: (text, mode) => {
    assert.equal(text, 'Mission00');
    assert.equal(mode, 1);
    serviceCalls.push('FName');
    return 0x29b;
  },
  readHashHead: (candidate, bucket) => {
    assert.equal(candidate, linker);
    assert.equal(bucket, 222);
    return 0;
  },
  readExport: (candidate, index) => {
    assert.equal(candidate, linker);
    assert.equal(index, 0);
    return exportRecord;
  },
  readImportWord: (candidate, byteOffset) => {
    assert.equal(candidate, linker);
    if (byteOffset === 8) return -2;
    if (byteOffset === 40) return 0x53;
    if (byteOffset === 12) return 0x29a;
    assert.fail(`unexpected native import-table offset ${byteOffset}`);
  },
  createExport: ({linker: actualLinker, index, classRef: actualClass,
    record, existing}) => {
    assert.equal(actualLinker, linker);
    assert.equal(index, 0);
    assert.equal(actualClass, classRef);
    assert.equal(record, exportRecord);
    assert.equal(existing, loadedObject);
    serviceCalls.push('CreateExport');
    return existing;
  },
  staticFindObject: () => assert.fail('StaticFindObject fallback was unexpectedly reached'),
};
const translated = staticLoadObject(existingRequest,existingServices);

assert.equal(translated.object, loadedObject);
assert.equal(loadState.nest, 1);
assert.deepEqual(serviceCalls, ['ResolveName', 'appStrcpy', 'FName', 'CreateExport']);

function normalizedNativeEvents(events, {outermost = false} = {}) {
  return events.map(event => {
    if (event.op === 'BeginLoadThunk') {
      return {op: 'BeginLoad', before: event.nest, after: outermost ? 1 : 2};
    }
    if (event.op === 'BeginLoadBody') return null;
    if (event.op === 'EndLoadThunk') {
      return {op: 'EndLoad', before: event.nest, after: outermost ? 0 : 1};
    }
    if (event.op === 'EndLoadBody') return null;
    if (event.op === 'StaticLoadObject') {
      return {op: event.op, path: event.path, filename: event.filename,
        flags: event.flags, sandbox: event.sandbox};
    }
    if (event.op === 'ResolveName') {
      return {op: event.op, create: event.create, throw: event.throw,
        name: event.tail ?? event.name, outer: event.outer};
    }
    if (event.op === 'GetPackageLinker') {
      return {op: event.op, flags: event.flags, filename: event.filename,
        sandbox: event.sandbox, guid: event.guid, root: event.outer};
    }
    if (event.op === 'appStrcpy') return {op: event.op, source: event.source};
    if (event.op === 'FName') return {op: event.op, text: event.text,
      findMode: event.findMode, nameIndex: event.nameIndex};
    if (event.op === 'FindExportIndex') return {op: event.op, className: event.className,
      classOuterName: event.classOuter, objectName: event.objectName,
      requestedOuter: event.requestedOuter, bucket: event.bucket, index: 0};
    if (event.op === 'CreateExport') return {op: event.op, index: event.index,
      existing: event.existing};
    if (event.op === 'Logf') return {op: event.op, name: event.name,
      formatPointer: event.formatPointer};
    if (event.op === 'FArrayRealloc') return {op: event.op, elementSize: 4,
      num: 0, max: 0, tag: event.tag};
    return event;
  }).filter(Boolean);
}

const nativeEvents = normalizedNativeEvents(nativeCase.events);
function normalizedTranslatedEvents(events) {
  return events.map(event => {
    if (event.op === 'StaticLoadObject') {
      return {op: event.op, path: event.path, filename: event.filename,
        flags: event.flags, sandbox: event.sandbox};
    }
    if (event.op === 'ResolveName') {
      return {op: event.op, create: event.create, throw: event.throw,
        name: event.name, outer: event.outer?.label ?? null};
    }
    if (event.op === 'GetPackageLinker') {
      return {op: event.op, flags: event.flags, filename: event.filename,
        sandbox: event.sandbox, guid: event.guid, root: event.root?.label ?? null};
    }
    if (event.op === 'appStrcpy') return {op: event.op, source: event.source};
    if (event.op === 'FName') return {op: event.op, text: event.text,
      findMode: event.findMode, nameIndex: event.nameIndex};
    if (event.op === 'FindExportIndex') return event;
    if (event.op === 'CreateExport') return {op: event.op, index: event.index,
      existing: event.existing.label};
    if (event.op === 'BeginLoad') return {op: event.op, before: event.before, after: event.after};
    if (event.op === 'EndLoad') return {op: event.op, before: event.before, after: event.after};
    if (event.op === 'Logf') return {op: event.op, name: event.name,
      formatPointer: event.formatPointer};
    if (event.op === 'FArrayRealloc') return {op: event.op, elementSize: event.elementSize,
      num: event.num, max: event.max, tag: event.tag};
    return event;
  });
}
const translatedEvents = normalizedTranslatedEvents(translated.events);
assert.deepEqual(translatedEvents, nativeEvents, 'StaticLoadObject call order and arguments');

// A simple name with a filename resolves the package before the second native
// loader scan. This is the call shape used by conversation GetSpeechAudio.
const filename='..\\System\\DeusExConText.u';
const nativeFilename=JSON.parse(execFileSync(python,[
  'scripts/native-static-load-filename-oracle.py',root,
],{encoding:'utf8',maxBuffer:2**20}));
const filenameServices={...existingServices,
  resolveName:(outerRef,nameRef)=>{
    assert.equal(outerRef.get(),null);assert.equal(nameRef.get(),'Mission00');return true;
  },
  findPackageFile:args=>{
    assert.deepEqual(args,{filename,guid:null});return {found:true,path:filename};
  },
  readPackageExtension:()=>assert.fail('Filename route does not copy package extension'),
  copyString:({source})=>{assert.equal(source,filename);return source;},
  createPackage:args=>{assert.deepEqual(args,{outer:null,name:'DeusExConText'});return packageObject;},
};
const filenameRequest={...existingRequest,name:'Mission00',filename};
const translatedFilename=staticLoadObject(filenameRequest,filenameServices);
assert.equal(translatedFilename.object,loadedObject);
assert.equal(nativeFilename.result,loadedObject.label);
assert.equal(loadState.nest,nativeFilename.nest);
assert.deepEqual(normalizedTranslatedEvents(translatedFilename.events),
  normalizedNativeEvents(nativeFilename.events),'filename parsing, package and existing linker/export call order');
console.log('Original simple-name + filename route also matches package parsing and the second existing-linker scan.');
assert.throws(()=>staticLoadObject({...filenameRequest,sandbox:{}},filenameServices),
  error=>error.code==='STATIC_LOAD_OBJECT_LINKER_CHECK');

// The live Training capture has nest=0, GObjLoaded.Num=0, and an already
// loaded ConversationList export.  Exercise the matching outermost branch:
// BeginLoad increments 0 -> 1, then EndLoad decrements 1 -> 0.  Empty
// GObjLoaded skips ConditionalPostLoad, but the native body still logs and
// calls FArray::Realloc before skipping zero loader-cleanup state.
const outerLoadState = {
  nest: 0,
  registrationQueueHead: null,
  loadedMax: 0,
  loaderCleanupState: 0,
};
const outerLoadedObjects = [];
const outerServiceCalls = [];
const translatedOuter = staticLoadObject({
  classRef,
  outer: null,
  name: 'DeusExConText.Mission00',
  filename: null,
  flags: 2,
  sandbox: null,
}, {
  loadState: outerLoadState,
  loadedObjects: outerLoadedObjects,
  read: (object, field) => object[field],
  resolveName: (outerRef, nameRef, options) => {
    assert.deepEqual(options, {create: 1, throwOnConfigMissing: 1});
    assert.equal(outerRef.get(), null);
    assert.equal(nameRef.get(), 'DeusExConText.Mission00');
    outerRef.set(packageObject);
    nameRef.set('Mission00');
    outerServiceCalls.push('ResolveName');
    return true;
  },
  loaders: [linker],
  readPackageExtension: () => '',
  copyString: ({source}) => {
    assert.equal(source, '');
    outerServiceCalls.push('appStrcpy');
    return source;
  },
  findName: (text, mode) => {
    assert.equal(text, 'Mission00');
    assert.equal(mode, 1);
    outerServiceCalls.push('FName');
    return 0x29b;
  },
  readHashHead: (candidate, bucket) => {
    assert.equal(candidate, linker);
    assert.equal(bucket, 222);
    return 0;
  },
  readExport: (candidate, index) => {
    assert.equal(candidate, linker);
    assert.equal(index, 0);
    return exportRecord;
  },
  readImportWord: (candidate, byteOffset) => {
    assert.equal(candidate, linker);
    if (byteOffset === 8) return -2;
    if (byteOffset === 40) return 0x53;
    if (byteOffset === 12) return 0x29a;
    assert.fail(`unexpected native import-table offset ${byteOffset}`);
  },
  createExport: ({linker: actualLinker, index, classRef: actualClass,
    record, existing}) => {
    assert.equal(actualLinker, linker);
    assert.equal(index, 0);
    assert.equal(actualClass, classRef);
    assert.equal(record, exportRecord);
    assert.equal(existing, loadedObject);
    outerServiceCalls.push('CreateExport');
    return existing;
  },
  logReceiver: {label: 'GWarn'},
  logEndLoad: ({receiver, name, formatPointer, native: nativeBody}) => {
    assert.equal(receiver.label, 'GWarn');
    assert.equal(name, STATIC_LOAD_LIFECYCLE_CONTRACT.endLoadLogName);
    assert.equal(formatPointer, STATIC_LOAD_LIFECYCLE_CONTRACT.endLoadLogFormat);
    assert.equal(nativeBody, STATIC_LOAD_OBJECT_CONTRACT.endLoadBody);
    outerServiceCalls.push('Logf');
  },
  reallocLoaded: ({array, elementSize, num, max, tag, native: nativeBody}) => {
    assert.equal(array, outerLoadedObjects);
    assert.equal(elementSize, STATIC_LOAD_LIFECYCLE_CONTRACT.loadedArrayElementSize);
    assert.equal(num, 0);
    assert.equal(max, 0);
    assert.equal(tag, STATIC_LOAD_LIFECYCLE_CONTRACT.loadedArrayReallocTag);
    assert.equal(nativeBody, STATIC_LOAD_OBJECT_CONTRACT.endLoadBody);
    outerServiceCalls.push('FArrayRealloc');
  },
  staticFindObject: () => assert.fail('StaticFindObject fallback was unexpectedly reached'),
});

assert.equal(translatedOuter.object, loadedObject);
assert.equal(outerLoadState.nest, 0);
assert.equal(outerLoadState.loadedMax, 0);
assert.equal(outerLoadState.loaderCleanupState, 0);
assert.deepEqual(outerLoadedObjects, []);
assert.deepEqual(outerServiceCalls, [
  'ResolveName', 'appStrcpy', 'FName', 'CreateExport', 'Logf', 'FArrayRealloc',
]);
assert.deepEqual(
  normalizedTranslatedEvents(translatedOuter.events),
  normalizedNativeEvents(nativeOutermost.events, {outermost: true}),
  'StaticLoadObject outermost empty lifecycle and call order',
);

// EndLoad rereads GObjLoaded.Num after Logf. Its newly supported nonempty path
// must still reject an object whose native fields/services are unresolved.
const lateLoadedObjects = [];
const lateLoadState = {
  nest: 0,
  registrationQueueHead: null,
  loadedMax: 0,
  loaderCleanupState: 0,
};
const lateCalls = [];
assert.throws(() => staticLoadObject({
  classRef,
  outer: null,
  name: 'DeusExConText.Mission00',
  filename: null,
  flags: 0x40,
  sandbox: null,
}, {
  loadState: lateLoadState,
  loadedObjects: lateLoadedObjects,
  read: (object, field) => object[field],
  resolveName: (outerRef, nameRef) => {
    outerRef.set(packageObject);
    nameRef.set('Mission00');
    return true;
  },
  loaders: [],
  logReceiver: {label: 'GWarn'},
  logEndLoad: () => {
    lateCalls.push('Logf');
    lateLoadedObjects.push({label: 'published-by-log'});
  },
  reallocLoaded: () => assert.fail('Realloc must not follow late GObjLoaded publication'),
  staticFindObject: () => null,
}), error => error instanceof StaticLoadObjectBoundaryError &&
  error.code === 'STATIC_LOAD_OBJECT_FIELD' && error.field === 'objectFlags');
assert.equal(lateLoadState.nest, 0);
assert.deepEqual(lateCalls, ['Logf']);
assert.equal(lateLoadedObjects.length, 1);

// Connect the newly recovered EndLoad body to StaticLoadObject itself. The
// separate native EndLoad oracle proves its internals; this check proves that
// objects published by the export service now reach those bodies and cleanup.
const pending = {label: 'newly-loaded', objectFlags: 0x01000200, linker};
const pendingImport = {object: pending, sourceLinker: linker, sourceIndex: 7};
linker.imports = [pendingImport];
const completeState = {nest: 0, registrationQueueHead: null, loadedMax: 1, loaderCleanupState: 1};
const completeQueue = [], completionCalls = [];
const completeServices = {
  ...existingServices, loadState: completeState, loadedObjects: completeQueue,
  write: (object, field, value) => { object[field] = value; },
  createExport: () => { completeQueue.push(pending); return loadedObject; },
  logReceiver: {label: 'GWarn'}, logEndLoad: () => completionCalls.push('Logf'),
  preload: ({object, linker: owner}) => {
    assert.equal(object, pending);
    assert.equal(owner, linker);
    completionCalls.push('Preload');
    object.objectFlags &= ~0x200;
  },
  conditionalPostLoad: object => {
    completionCalls.push('ConditionalPostLoad');
    conditionalPostLoad(object, completeServices);
  },
  postLoad: object => {
    completionCalls.push('PostLoad');
    postLoadObject(object, completeServices);
  },
  reallocLoaded: ({num, max}) => {
    assert.equal(num, 0);
    assert.equal(max, 0);
    completionCalls.push('Realloc');
  },
};
assert.equal(staticLoadObject(existingRequest, completeServices).object, loadedObject);
assert.deepEqual(completionCalls, ['Logf', 'Preload', 'ConditionalPostLoad', 'PostLoad', 'Realloc']);
assert.equal(pending.objectFlags, 0x20000000);
assert.deepEqual(completeQueue, []);
assert.equal(completeState.nest, 0);
assert.equal(completeState.loaderCleanupState, 0);
assert.deepEqual(pendingImport, {object: null, sourceLinker: linker, sourceIndex: 7});

// A missing loaded linker must stop at the explicit first-load service.  This
// catches a helper that quietly turns a display-name hit into a loaded object.
const missingState = {nest: 1};
assert.throws(() => staticLoadObject({
  classRef, outer: null, name: 'DeusExConText.Mission00', filename: null, flags: 2, sandbox: null,
}, {
  loadState: missingState,
  read: (object, field) => object[field],
  resolveName: (outerRef, nameRef) => { outerRef.set(packageObject); nameRef.set('Mission00'); return true; },
  loaders: [],
  readPackageExtension: () => '',
  copyString: () => '',
  findName: () => 0x29b,
}), error => error instanceof StaticLoadObjectBoundaryError && error.code === 'STATIC_LOAD_OBJECT_FIRST_LOAD');
assert.equal(missingState.nest, 1, 'failed first-load path must close its nested load scope');

// Bind the recovered first-load constructor for the canonical package root.
// The adapter owns ULinkerLoad/archive allocation and publishes that identity
// into GObjLoaders; StaticLoadObject must then continue through the ordinary
// FName/hash/CreateExport path without copying the existing-linker extension.
const firstLinker = {
  label: 'ConstructedLinker(DeusExConText)',
  outer: packageObject,
  reader: {label: 'ConstructedReader(DeusExConText)'},
};
const firstExportRecord = {...exportRecord, object: loadedObject};
const firstLoaders = [];
const firstLoadState = {
  nest: 0,
  registrationQueueHead: null,
  loadedMax: 0,
  loaderCleanupState: 0,
};
const firstLoadedObjects = [];
const firstServiceCalls = [];
let firstCreateArgs = null;
const firstTranslated = staticLoadObject({...existingRequest}, {
  loadState: firstLoadState,
  loadedObjects: firstLoadedObjects,
  read: (object, field) => object[field],
  resolveName: (outerRef, nameRef, options) => {
    assert.deepEqual(options, {create: 1, throwOnConfigMissing: 1});
    assert.equal(outerRef.get(), null);
    assert.equal(nameRef.get(), 'DeusExConText.Mission00');
    outerRef.set(packageObject);
    nameRef.set('Mission00');
    firstServiceCalls.push('ResolveName');
    return true;
  },
  loaders: firstLoaders,
  createLinkerLoad: args => {
    firstCreateArgs = args;
    firstServiceCalls.push('CreateLinkerLoad');
    return firstLinker;
  },
  findName: (text, mode) => {
    assert.equal(text, 'Mission00');
    assert.equal(mode, 1);
    firstServiceCalls.push('FName');
    return 0x29b;
  },
  readHashHead: (candidate, bucket) => {
    assert.equal(candidate, firstLinker);
    assert.equal(bucket, 222);
    return 0;
  },
  readExport: (candidate, index) => {
    assert.equal(candidate, firstLinker);
    assert.equal(index, 0);
    return firstExportRecord;
  },
  readImportWord: (candidate, byteOffset) => {
    assert.equal(candidate, firstLinker);
    if (byteOffset === 8) return -2;
    if (byteOffset === 40) return 0x53;
    if (byteOffset === 12) return 0x29a;
    assert.fail(`unexpected native first-load import-table offset ${byteOffset}`);
  },
  createExport: ({linker: actualLinker, index, classRef: actualClass,
    record, existing}) => {
    assert.equal(actualLinker, firstLinker);
    assert.equal(index, 0);
    assert.equal(actualClass, classRef);
    assert.equal(record, firstExportRecord);
    assert.equal(existing, loadedObject);
    firstServiceCalls.push('CreateExport');
    return existing;
  },
  logReceiver: {label: 'GWarn'},
  logEndLoad: ({receiver, name, formatPointer, native: nativeBody}) => {
    assert.equal(receiver.label, 'GWarn');
    assert.equal(name, STATIC_LOAD_LIFECYCLE_CONTRACT.endLoadLogName);
    assert.equal(formatPointer, STATIC_LOAD_LIFECYCLE_CONTRACT.endLoadLogFormat);
    assert.equal(nativeBody, STATIC_LOAD_OBJECT_CONTRACT.endLoadBody);
    firstServiceCalls.push('Logf');
  },
  reallocLoaded: ({array, elementSize, num, max, tag, native: nativeBody}) => {
    assert.equal(array, firstLoadedObjects);
    assert.equal(elementSize, STATIC_LOAD_LIFECYCLE_CONTRACT.loadedArrayElementSize);
    assert.equal(num, 0);
    assert.equal(max, 0);
    assert.equal(tag, STATIC_LOAD_LIFECYCLE_CONTRACT.loadedArrayReallocTag);
    assert.equal(nativeBody, STATIC_LOAD_OBJECT_CONTRACT.endLoadBody);
    firstServiceCalls.push('FArrayRealloc');
  },
  staticFindObject: () => assert.fail('first-load StaticFindObject fallback was unexpectedly reached'),
});
assert.equal(firstTranslated.object, loadedObject);
assert.deepEqual(firstCreateArgs, {
  root: packageObject, filename: null, flags: 0x2a, sandbox: null, guid: null,
});
assert.deepEqual(firstLoaders, [firstLinker]);
assert.equal(firstLoadState.nest, 0);
assert.deepEqual(firstServiceCalls, [
  'ResolveName', 'CreateLinkerLoad', 'FName', 'CreateExport', 'Logf', 'FArrayRealloc',
]);
assert.deepEqual(firstTranslated.events.map(event => event.op), [
  'StaticLoadObject', 'BeginLoad', 'ResolveName', 'GetPackageLinker', 'CreateLinkerLoad',
  'FName', 'FindExportIndex', 'CreateExport', 'EndLoad', 'Logf', 'FArrayRealloc',
]);
const firstConstruction = firstTranslated.events.find(event => event.op === 'CreateLinkerLoad');
assert.equal(firstConstruction.thunk, STATIC_LOAD_OBJECT_CONTRACT.createLinkerLoadThunk);
assert.equal(firstConstruction.body, STATIC_LOAD_OBJECT_CONTRACT.createLinkerLoadBody);
assert.equal(firstLinker.outer, packageObject);
assert.ok(firstLinker.reader);

assert.equal(STATIC_LOAD_OBJECT_CONTRACT.loadFlagsOr, 0x28);
assert.equal(STATIC_LOAD_OBJECT_CONTRACT.skipLinkerFlag, 0x40);
assert.equal(STATIC_LOAD_OBJECT_CONTRACT.createLinkerLoadThunk, 0x10101f91);
assert.equal(STATIC_LOAD_OBJECT_CONTRACT.createLinkerLoadBody, 0x10160000);
assert.equal(STATIC_LOAD_OBJECT_CONTRACT.linkerArchiveVtable, 0x1017a430);
console.log('StaticLoadObject existing and first-load linker scans, Begin/End gates, FName/import hash lookup, and existing CreateExport return match the recovered Core paths.');
