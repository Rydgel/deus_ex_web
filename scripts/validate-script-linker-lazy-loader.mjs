/** Validate the ULinkerLoad Attach/Detach binding against the original probe. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';

import {gameDirectory} from './game-directory.mjs';
import {
  LINKER_LAZY_LOADER_CONTRACT,
  UnsupportedLinkerLazyLoaderError,
  attachLinkerLazyLoader,
  createLinkerLoadArchive,
  detachAllLinkerLazyLoaders,
  detachLinkerLazyLoader,
  linkerLazyLoaderGrowth,
} from '../src/runtime/script-linker-lazy-loader.mjs';

const root = path.resolve(process.argv[2] ?? gameDirectory());
const python = process.env.DEUS_EX_NATIVE_PYTHON ?? '.cache/native-probe-env/bin/python';
const native = JSON.parse(execFileSync(python, [
  'scripts/native-linker-lazy-loader-oracle.py', root,
], {encoding: 'utf8'}));

assert.deepEqual(native.hashes, {
  'Engine.dll': '0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4',
  'Core.dll': '8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4',
});
assert.equal(native.contract.attachBody, LINKER_LAZY_LOADER_CONTRACT.archive.attach.body);
assert.equal(native.contract.detachBody, LINKER_LAZY_LOADER_CONTRACT.archive.detach.body);
assert.equal(native.contract.detachAllBody, LINKER_LAZY_LOADER_CONTRACT.archive.detachAll.body);
assert.equal(native.contract.archiveVtable, LINKER_LAZY_LOADER_CONTRACT.archive.nativeVtable);
assert.equal(native.contract.arrayOffset, LINKER_LAZY_LOADER_CONTRACT.archive.outerLazyLoaderArrayOffset);
assert.equal(native.contract.reallocBody, LINKER_LAZY_LOADER_CONTRACT.array.reallocBody);
assert.equal(native.contract.removeBody, LINKER_LAZY_LOADER_CONTRACT.array.removeBody);
assert.equal(native.contract.tellBody, 0x10163110);
assert.equal(native.contract.logFormat, LINKER_LAZY_LOADER_CONTRACT.log.format);
assert.equal(linkerLazyLoaderGrowth(1), 0x21);
assert.throws(() => attachLinkerLazyLoader({
  nativeVtable: LINKER_LAZY_LOADER_CONTRACT.archive.nativeVtable,
}, {}), UnsupportedLinkerLazyLoaderError);

function makeArray(names, max = names.length) {
  return {
    data: names.length ? names.slice() : null,
    num: names.length,
    max,
  };
}

function createFixture(names, max) {
  const loaders = new Map();
  const loader = name => {
    if (!loaders.has(name)) loaders.set(name, {name, archive: 0xaaaa, savedPosition: 0xbbbb});
    return loaders.get(name);
  };
  for (const name of names) loader(name);
  const reader = {position: 0};
  const array = makeArray(names.map(name => loader(name)), max);
  const services = {
    readerTell: () => reader.position,
    arrayRealloc: (current, elementSize) => {
      assert.equal(elementSize, LINKER_LAZY_LOADER_CONTRACT.array.elementSize);
      const old = Array.isArray(current.data) ? current.data.slice(0, current.num) : [];
      current.data = new Array(current.max).fill(undefined);
      current.data.splice(0, old.length, ...old);
    },
    arrayRemove: (current, index, count, elementSize) => {
      assert.equal(elementSize, LINKER_LAZY_LOADER_CONTRACT.array.elementSize);
      assert.equal(count, 1);
      const oldMax = current.max;
      current.data.splice(index, count);
      current.num -= count;
      const newNum = current.num;
      if (3 * newNum < 2 * oldMax && (oldMax - newNum > 0x40 || newNum === 0)) {
        current.max = newNum;
        services.arrayRealloc(current, elementSize);
      }
    },
    log: (_archive, details) => { logs.push(details); },
  };
  const logs = [];
  const archive = createLinkerLoadArchive({
    linker: {kind: 'ULinkerLoad', id: 'fixture'},
    reader,
    array,
    logName: 'fixture-linker',
    services,
  });
  return {archive, reader, loader, loaders, logs};
}

function operationNames(result) {
  return result.operations.map(operation => operation.operation);
}

function nativeEvents(result) {
  return result.events.map(event => event.operation);
}

function expectedState(result, values, num, max) {
  assert.equal(result.array.num, num);
  assert.equal(result.array.max, max);
  assert.deepEqual(result.array.data.slice(0, result.array.num), values);
}

// Case 1: empty native FArray publishes Num, Max, then Realloc before Data[0]
// and Tell.  The browser service must expose the same boundary order.
const empty = createFixture([], 0);
empty.reader.position = 0x1234;
const emptyLoader = empty.loader('A');
const emptyResult = attachLinkerLazyLoader(empty.archive, emptyLoader);
assert.deepEqual(operationNames(emptyResult), [
  'array-num-write', 'array-max-write', 'array-realloc', 'array-element-write',
  'lazy-loader-field-write', 'archive-tell', 'lazy-loader-field-write',
]);
expectedState({array: empty.archive.lazyLoaderArray}, [emptyLoader], 1, 0x21);
assert.equal(emptyLoader.archive, empty.archive);
assert.equal(emptyLoader.savedPosition, 0x1234);
const nativeEmpty = native.results.find(result => result.id === 'attach-empty').operations[0];
assert.deepEqual(nativeEvents(nativeEmpty), ['array-realloc', 'reader-tell']);
assert.equal(nativeEmpty.events[0].num, 1);
assert.equal(nativeEmpty.events[0].max, 0x21);
assert.equal(nativeEmpty.events[0].elementSize, 4);
assert.equal(nativeEmpty.events[0].arrayOffset, 0x4d8);
assert.equal(nativeEmpty.events[1].value, emptyResult.position);
assert.notEqual(nativeEmpty.state.loader.archive, 0);
assert.equal(nativeEmpty.state.loader.savedPosition, 0x1234);

// Case 2: an existing capacity avoids Realloc, while the append and Tell
// boundaries remain ordered exactly as in the native body.
const capacity = createFixture(['A'], 4);
capacity.reader.position = 0x2345;
const capacityResult = attachLinkerLazyLoader(capacity.archive, capacity.loader('B'));
assert.deepEqual(operationNames(capacityResult), [
  'array-num-write', 'array-element-write', 'lazy-loader-field-write',
  'archive-tell', 'lazy-loader-field-write',
]);
expectedState({array: capacity.archive.lazyLoaderArray}, [
  capacity.loader('A'), capacity.loader('B'),
], 2, 4);
const nativeCapacity = native.results.find(result => result.id === 'attach-with-capacity').operations[0];
assert.deepEqual(nativeEvents(nativeCapacity), ['reader-tell']);
assert.equal(nativeCapacity.state.array.num, 2);
assert.equal(nativeCapacity.state.array.max, 4);
assert.equal(nativeCapacity.events[0].value, capacityResult.position);

// Case 3: Detach rechecks shifted entries, logs both duplicate and missing
// membership, and clears the loader fields after the log boundary.
const duplicates = createFixture(['A', 'A', 'B'], 3);
const duplicateLoader = duplicates.loader('A');
const duplicateResult = detachLinkerLazyLoader(duplicates.archive, duplicateLoader);
assert.deepEqual(operationNames(duplicateResult), [
  'array-remove', 'array-remove', 'detach-log',
  'lazy-loader-field-write', 'lazy-loader-field-write',
]);
expectedState({array: duplicates.archive.lazyLoaderArray}, [duplicates.loader('B')], 1, 3);
assert.equal(duplicateLoader.archive, 0);
assert.equal(duplicateLoader.savedPosition, 0);
assert.equal(duplicates.logs[0].removed, 2);
assert.equal(duplicates.logs[0].formatAddress, LINKER_LAZY_LOADER_CONTRACT.log.format);

const missingResult = detachLinkerLazyLoader(duplicates.archive, duplicates.loader('C'));
assert.deepEqual(operationNames(missingResult), [
  'detach-log', 'lazy-loader-field-write', 'lazy-loader-field-write',
]);
expectedState({array: duplicates.archive.lazyLoaderArray}, [duplicates.loader('B')], 1, 3);
assert.equal(duplicates.loader('C').archive, 0);
assert.equal(duplicates.logs[1].removed, 0);
const nativeDetach = native.results.find(result => result.id === 'detach-duplicates-and-missing');
assert.deepEqual(nativeEvents(nativeDetach.operations[0]), ['array-remove', 'array-remove', 'logf']);
assert.deepEqual(nativeEvents(nativeDetach.operations[1]), ['logf']);
assert.deepEqual(nativeDetach.operations[0].events.slice(0, 2).map(event => ({
  index: event.index, count: event.count, elementSize: event.elementSize,
})), [{index: 0, count: 1, elementSize: 4}, {index: 0, count: 1, elementSize: 4}]);
assert.equal(nativeDetach.operations[0].events[2].removed, 2);
assert.equal(nativeDetach.operations[1].events[0].removed, 0);
assert.equal(nativeDetach.operations[0].state.loader.archive, 0);
assert.equal(nativeDetach.operations[0].state.loader.savedPosition, 0);
assert.equal(nativeDetach.operations[1].state.loader.archive, 0);
assert.equal(nativeDetach.operations[1].state.loader.savedPosition, 0);

// Case 4: DetachAllLazyLoaders(0), ULinkerLoad::Destroy's call: every attached loader (a duplicate twice) loses its archive and
// position, then the array is emptied: Num and Max zeroed and one Realloc(4), with no Remove and no log.
const all = createFixture(['A', 'B', 'A'], 5);
const allResult = detachAllLinkerLazyLoaders(all.archive, 0);
assert.deepEqual(operationNames(allResult), [
  'lazy-loader-field-write', 'lazy-loader-field-write', 'lazy-loader-field-write', 'lazy-loader-field-write',
  'lazy-loader-field-write', 'lazy-loader-field-write', 'array-num-write', 'array-max-write', 'array-realloc',
]);
assert.deepEqual(allResult.loaders, [all.loader('A'), all.loader('B'), all.loader('A')]);
assert.equal(all.archive.lazyLoaderArray.num, 0);
assert.equal(all.archive.lazyLoaderArray.max, 0);
assert.equal(all.archive.lazyLoaderArray.data.length, 0);
assert.deepEqual(all.logs, []);
const nativeAll = native.results.find(result => result.id === 'detach-all').operations[0];
assert.deepEqual(nativeEvents(nativeAll), ['array-realloc']);
assert.deepEqual({num: nativeAll.events[0].num, max: nativeAll.events[0].max, elementSize: nativeAll.events[0].elementSize,
  arrayOffset: nativeAll.events[0].arrayOffset}, {num: 0, max: 0, elementSize: 4, arrayOffset: 0x4d8});
assert.deepEqual({num: nativeAll.state.array.num, max: nativeAll.state.array.max}, {num: 0, max: 0});
for (const name of ['A', 'B']) {
  assert.deepEqual(nativeAll.loaders[name], {archive: 0, savedPosition: 0});
  assert.equal(all.loader(name).archive, 0);
  assert.equal(all.loader(name).savedPosition, 0);
}
assert.throws(() => detachAllLinkerLazyLoaders(createFixture(['A'], 1).archive, 1), UnsupportedLinkerLazyLoaderError,
  'a Load pass needs the loaders\' Load virtual as an explicit service');

const doc = await readFile('docs/script-linker-lazy-loader.md', 'utf8');
assert.match(doc, /archive-relative `\+0x434`/);
assert.match(doc, /ULinkerLoad \+0x4d8/);
assert.match(doc, /Preload\(UObject\*\)/);
assert.doesNotMatch(doc, /Preload\(FLazyLoader\*\)/);
console.log('ULinkerLoad Attach/Detach/DetachAll matches original array, Tell, duplicate, missing-member and log boundaries.');
