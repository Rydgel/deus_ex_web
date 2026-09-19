#!/usr/bin/env node
/** Focused original-DLL comparisons for the two-pass loader boundary. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {gameDirectory} from './game-directory.mjs';
import {endScriptLoad} from '../src/runtime/script-static-load-object.mjs';
import {conditionalPostLoad, postLoadObject, postLoadField, postLoadStruct,
  postLoadFunction, postLoadClass} from '../src/runtime/script-post-load.mjs';

const native = JSON.parse(execFileSync(process.env.DEUS_EX_NATIVE_PYTHON ?? '.cache/native-probe-env/bin/python',
  ['scripts/native-end-load-oracle.py', gameDirectory()], {encoding: 'utf8'}));
assert.equal(native.hashes['Core.dll'], '8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4');
const postBodies = {Object: postLoadObject, Field: postLoadField, Struct: postLoadStruct,
  Function: postLoadFunction, Class: postLoadClass};

function run(spec) {
  const events = [], objects = new Map(), linker = {name: 'linker'};
  for (const entry of spec.objects ?? []) objects.set(entry.name, {
    ...entry, objectFlags: entry.flags ?? 0x1000200, linker: entry.noLinker ? null : linker,
    classWithin: entry.noWithin ? null : linker,
  });
  for (const object of objects.values()) object.superField = objects.get(object.super) ?? null;
  linker.imports = (spec.imports ?? []).map((name, index) => ({object: objects.get(name) ?? null,
    sourceLinker: linker, sourceIndex: index + 7}));
  let loadedObjects = (spec.loaded ?? [...objects.keys()]).map(name => objects.get(name));
  const append = name => { loadedObjects = [...loadedObjects, objects.get(name)]; };
  const state = {nest: spec.nest ?? 1, loaderCleanupState: spec.counter ?? 0, loadedMax: 32};
  const services = {
    loadState: state, loaders: [linker],
    get loadedObjects() { return loadedObjects; },
    read: (object, field) => object[field],
    write: (object, field, value) => { object[field] = value; },
    logReceiver: 0x1234,
    logEndLoad({receiver, name, formatPointer}) {
      events.push({op: 'Logf', receiver, name, formatPointer});
      if (spec.logAppend) append(spec.logAppend);
    },
    preload({object, linker: owner, archiveOffset, virtualSlot}) {
      assert.equal(archiveOffset, 0xa4);
      assert.equal(virtualSlot, 0x10);
      events.push({op: 'Preload', object: object.name, linker: owner.name});
      object.objectFlags = (object.objectFlags & ~0x200) >>> 0;
      if (object.preloadAppend) append(object.preloadAppend);
    },
    conditionalPostLoad(object) {
      events.push({op: 'ConditionalPostLoad', object: object.name});
      conditionalPostLoad(object, services);
    },
    postLoad(object) {
      const kind = object.kind ?? 'Object';
      events.push({op: 'PostLoad', kind, object: object.name, flags: object.objectFlags});
      if (postBodies[kind]) postBodies[kind](object, services);
      else if (kind !== 'NoBase') {
        if (kind === 'Reenter') services.conditionalPostLoad(object);
        if (object.postAppend) append(object.postAppend);
        // The explicit native fixture callback tail-jumps to the original
        // UObject body with the virtual call's return address still on stack.
        events.push({op: 'PostLoad', kind: 'Object', object: object.name, flags: object.objectFlags});
        postLoadObject(object, services);
      }
    },
    bind(object) {
      events.push({op: 'Bind', object: object.name, flags: object.objectFlags});
      if (object.bindSuper) object.superField = objects.get(object.bindSuper);
    },
    getFullName(object, stopOuter) {
      events.push({op: 'GetFullName', object: object.name, stopOuter});
      return object.name;
    },
    errorReceiver: 0x5678,
    errorLogf(details) { events.push({op: 'ErrorLogf', ...details}); },
    reallocLoaded({array, elementSize, num, max, tag}) {
      assert.equal(array, loadedObjects);
      assert.equal(state.loadedMax, 0);
      assert.equal(elementSize, 4);
      events.push({op: 'Realloc', bytes: 0, tag, num, max});
    },
  };
  let assertion = null;
  try {
    if (spec.conditional) services.conditionalPostLoad(objects.get(spec.conditional));
    else endScriptLoad(services);
  } catch (error) {
    if (!error.line) throw error;
    assertion = error.line;
    events.push({op: 'Assert', line: assertion});
  }
  return {spec, events, assertion, nest: state.nest, counter: state.loaderCleanupState,
    max: state.loadedMax, loaded: loadedObjects.map(object => object.name),
    flags: Object.fromEntries([...objects].map(([name, object]) => [name, object.objectFlags])),
    imports: linker.imports.map(record => ({object: record.object?.name ?? null,
      sourceLinker: record.sourceLinker.name, sourceIndex: record.sourceIndex}))};
}

for (const sample of native.cases) assert.deepEqual(run(sample.spec), sample, sample.spec.name);

// Anchor the original evidence to the important boundaries instead of trusting
// a translation/native pair that accidentally omits the intended branch.
const cases = new Map(native.cases.map(sample => [sample.spec.name, sample]));
assert.equal(cases.get('postload-appends-asserts').assertion, 0x929);
assert.equal(cases.get('postload-appends-asserts').flags.b & 0x200, 0x200,
  'native does not rerun Preload after PostLoad appends an object');
assert.deepEqual(cases.get('cleanup').imports.map(record => record.object), [null, 'native', null, null]);
assert.equal(cases.get('missing-base-diagnostic').flags.a, 0,
  'old base-called flag is cleared before dispatch, so it cannot hide a missing base call');
assert.ok(cases.get('class-super-order').events.findIndex(e => e.op === 'Bind' && e.object === 'child') <
  cases.get('class-super-order').events.findIndex(e => e.op === 'ConditionalPostLoad' && e.object === 'base'));
console.log(`PASS EndLoad/PostLoad: ${native.cases.length} original Core cases, live two-pass queue, ` +
  'metadata bind order, flags, diagnostics and import cleanup');
