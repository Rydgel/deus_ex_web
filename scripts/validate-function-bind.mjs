#!/usr/bin/env node
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {gameDirectory} from './game-directory.mjs';
import {AssetStore} from '../src/unreal/assets.mjs';
import {createScriptLoadGraph} from '../src/runtime/script-load-graph.mjs';
import {bindScriptFunction, getFieldOwnerClass, getScriptClassNameCPP} from '../src/runtime/script-function-bind.mjs';

const native = JSON.parse(execFileSync(process.env.DEUS_EX_NATIVE_PYTHON ?? '.cache/native-probe-env/bin/python',
  ['scripts/native-function-bind-oracle.py', gameDirectory()], {encoding: 'utf8', maxBuffer: 1024 * 1024}));
assert.equal(native.hashes['Core.dll'], '8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4');

for (const sample of native.cases) {
  const spec = sample.spec, classClass = {}, otherClass = {}, events = [];
  const pkg = {name: 'package'}, otherPackage = {name: 'other-package'};
  const base = {name: 'aCtOr', class: classClass, superField: null};
  const owner = {name: spec.className ?? 'Object', class: classClass, outer: pkg,
    superField: spec.actorBase ? base : null};
  const second = {name: 'Second', class: classClass, outer: otherPackage, superField: null};
  const state = {class: otherClass, outer: owner};
  const fn = {name: spec.functionName ?? 'DynamicLoadObject', class: otherClass,
    functionFlags: spec.flags ?? 0x400, nativeIndex: spec.index ?? 0,
    nativeFunction: spec.before ?? 0xdeadbeef, outer: spec.nested ? state : owner};
  let ownerCalls = 0, cpp = null;
  const services = {
    classClass,
    read: (object, field) => object[field],
    write: (object, field, value) => { object[field] = value; },
    readNative: () => spec.pointer ?? 0x12345678,
    getOwnerClass(object) {
      events.push({op: 'GetOwnerClass', object: 'function'});
      ownerCalls += 1;
      if (ownerCalls === 2 && spec.secondOwner) fn.outer = second;
      return getFieldOwnerClass(object, services);
    },
    getNameCPP(cls) {
      events.push({op: 'GetNameCPP', class: cls.name});
      cpp = getScriptClassNameCPP(cls, services);
      return cpp;
    },
    getName(object) {
      if (object === fn) events.push({op: 'FormatExport', name: `int${cpp}exec${fn.name}`});
      return object.name;
    },
    getDllExport(pkg, name, checked) {
      events.push({op: 'GetDllExport', package: pkg.name, name, checked});
      return spec.missing ? null : {pointer: spec.pointer ?? 0x12345678};
    },
    readPointer: cell => cell.pointer,
  };
  let assertion = null;
  try { bindScriptFunction(fn, services); }
  catch (error) {
    if (!error.line) throw error;
    assertion = error.line;
    events.push({op: 'Assert', line: assertion});
  }
  assert.deepEqual({spec, pointer: fn.nativeFunction, events, assertion}, sample, spec.name);
}
assert.equal(native.registry.initialized, 1);
assert.equal(Object.keys(native.registry.numbered).length, 250);
assert.equal(native.registry.numbered[167], native.registry.named.intUObjectexecRand.pointer);
assert.deepEqual(native.packageForward, {sameObject: true, sameArchive: true, wordAfterBase: 0x12345678});

// Complete the actual Core.Object metadata queue, using its original package
// and registration table. No queue filtering or preinstalled function pointer
// substitutes: all 652 queued records pass through the shared EndLoad body.
const assets = new AssetStore([{path: 'System/Core.u',
  read: () => readFile(path.join(gameDirectory(), 'System/Core.u'))}]);
const core = await assets.get('Core');
const lifecycleEvents = [];
const graph = createScriptLoadGraph({packageAssets: new Map([['core', core]]), captureEvents: true,
  nativeFunctions: {
    readNative: index => native.registry.numbered[index] ?? native.registry.defaultHandler,
    getDllExport(pkg, name, checked) {
      assert.equal(graph.fullName(pkg), 'Core');
      assert.equal(checked, 1);
      const cell = native.registry.named[name];
      assert.ok(cell, `Original Core exports ${name}`);
      return cell;
    },
    readPointer: cell => cell.pointer,
  },
  lifecycle: {
    logReceiver: {name: 'GWarn'},
    logEndLoad: () => lifecycleEvents.push('Logf'),
    reallocLoaded: ({array, num, max}) => {
      assert.equal(array, graph.loadedObjects);
      assert.equal(num, 0);
      assert.equal(max, 0);
      lifecycleEvents.push('Realloc');
    },
  },
});
graph.beginLoad();
const object = graph.loadExport('Core', core.exportsByPath.get('object'));
const queued = [...graph.loadedObjects];
assert.equal(queued.length, 652);
graph.endLoad();
assert.equal(graph.loadState.nest, 0);
assert.equal(graph.importState.importCount, 0);
assert.equal(graph.loadedObjects.length, 0);
assert.deepEqual(lifecycleEvents, ['Logf', 'Realloc']);
let functions = 0, named = 0, scripts = 0;
for (const record of queued) {
  const flags = graph.slotOf(record, 0x1c);
  assert.equal(flags & 0x01000200, 0, `${graph.fullName(record)} finishes load and postload`);
  assert.ok(flags & 0x20000000, `${graph.fullName(record)} calls the UObject base`);
  if (graph.fullName(graph.classRecordOf(record)) !== 'Core.Function') continue;
  functions += 1;
  const fnFlags = graph.slotOf(record, 0x6c), index = graph.slotOf(record, 0x70);
  const name = graph.nameText(graph.slotOf(record, 0x20));
  let expected;
  if (!(fnFlags & 0x400)) { expected = 0x10101acd; scripts += 1; }
  else if (index) expected = native.registry.numbered[index] ?? native.registry.defaultHandler;
  else { expected = native.registry.named[`intUObjectexec${name}`].pointer; named += 1; }
  assert.equal(graph.slotOf(record, 0x7c), expected, `${name} preserves the original native pointer identity`);
}
assert.equal(functions, 164);
assert.equal(named, 10);
assert.ok(scripts > 0);
const eventCount = graph.events.length;
graph.conditionalPostLoad(object);
assert.equal(graph.events.length, eventCount, 'already post-loaded metadata is not rebound');
assert.deepEqual(graph.assertions, []);
console.log(`PASS function binding: ${native.cases.length} original Core cases, native owner/CPP-name ` +
  `walks; Core.Object finalizes ${queued.length} real queued objects and ${functions} functions ` +
  `(${named} named natives, ${scripts} script handlers) through the shared graph`);
