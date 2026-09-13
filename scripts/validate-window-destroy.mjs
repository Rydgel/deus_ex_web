/** Validate the bounded original Window.Destroy destruction contract. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readFunctionMetadata} from '../src/unreal/script-metadata.mjs';
import {gameDirectory} from './game-directory.mjs';
import {
  WINDOW_DESTROY_BITS,
  WINDOW_DESTROY_NATIVE,
  WINDOW_DESTROY_NATIVE_ADDRESSES,
  WINDOW_DESTROY_OFFSETS,
  execDestroyWindowNative,
} from '../src/runtime/script-window-destroy.mjs';

const root = gameDirectory();
const extensionPath = path.join(root, 'System', 'Extension.u');
const extensionBytes = new Uint8Array(await readFile(extensionPath));
const assets = new AssetStore((await readdir(path.join(root, 'System'))).map(name => ({
  path: `System/${name}`,
  read: () => name === 'Extension.u'
    ? extensionBytes : readFile(path.join(root, 'System', name)),
})));
const extension = await assets.get('Extension');
const destroyIndex = extension.exportsByPath.get('window.destroy');
assert.equal(destroyIndex, WINDOW_DESTROY_NATIVE.packageExport);
const metadata = readFunctionMetadata(extension, destroyIndex);
assert.equal(metadata.nativeIndex, WINDOW_DESTROY_NATIVE.nativeIndex);
assert.equal(metadata.functionFlags, WINDOW_DESTROY_NATIVE.functionFlags);
assert.equal(metadata.entry.serialSize, WINDOW_DESTROY_NATIVE.serialSize);
assert.deepEqual(metadata.parameters, []);

const extensionDll = new Uint8Array(await readFile(path.join(root, 'System', 'Extension.dll')));
assert.equal(createHash('sha256').update(extensionDll).digest('hex'), WINDOW_DESTROY_NATIVE.dllSha256);
const bodyHash = (start, end) => createHash('sha256').update(
  extensionDll.subarray(start - WINDOW_DESTROY_NATIVE.imageBase, end - WINDOW_DESTROY_NATIVE.imageBase),
).digest('hex');
for (const functionInfo of Object.values(WINDOW_DESTROY_NATIVE.functions)) {
  assert.equal(bodyHash(functionInfo.body, functionInfo.end), functionInfo.bodySha256,
    `${functionInfo.name} body changed`);
}

const python = process.env.NATIVE_PROBE_PYTHON || path.resolve('.cache/native-probe-env/bin/python');
const native = JSON.parse(execFileSync(python, [
  path.resolve('scripts/native-window-destroy-oracle.py'), root,
], {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024}));
assert.equal(native.hashes['Extension.dll'], WINDOW_DESTROY_NATIVE.dllSha256);
assert.equal(native.extensionBase, 0x12000000);
assert.equal(native.addresses.execDestroy, 0x12051830);
assert.equal(native.addresses.safeDestroy, 0x1204c0b0);
assert.equal(native.addresses.preDestroy, 0x12050500);
assert.equal(native.addresses.killAllChildren, 0x120505d0);
assert.equal(native.addresses.cleanUp, 0x1204bec0);
assert.equal(native.addresses.deletingDestructor, 0x12004860);
assert.equal(native.addresses.beingDestroyedBit, WINDOW_DESTROY_BITS.bBeingDestroyed);

function makeWindow({name, flags = 2, lockCount = 0, type = 3, parent = null} = {}) {
  const raw = new Map([
    [WINDOW_DESTROY_OFFSETS.type, type],
    [WINDOW_DESTROY_OFFSETS.windowFlags, flags],
    [WINDOW_DESTROY_OFFSETS.lockCount, lockCount],
    [WINDOW_DESTROY_OFFSETS.parent, parent],
    [WINDOW_DESTROY_OFFSETS.firstChild, null],
    [WINDOW_DESTROY_OFFSETS.lastChild, null],
    [WINDOW_DESTROY_OFFSETS.previousSibling, null],
    [WINDOW_DESTROY_OFFSETS.nextSibling, null],
    [WINDOW_DESTROY_OFFSETS.rootFocus, null],
    [WINDOW_DESTROY_OFFSETS.rootGrab, null],
    [WINDOW_DESTROY_OFFSETS.gcListA, null],
    [WINDOW_DESTROY_OFFSETS.gcListB, null],
    [WINDOW_DESTROY_OFFSETS.gcContextA, null],
    [WINDOW_DESTROY_OFFSETS.gcContextB, null],
  ]);
  return {name, raw};
}

function makeNode(name, next = null) {
  return {name, raw: new Map([[WINDOW_DESTROY_OFFSETS.gcNodeNext, next]])};
}

function makeContext(name) {
  return {name, raw: new Map()};
}

function linkChildren(parent, children) {
  parent.raw.set(WINDOW_DESTROY_OFFSETS.firstChild, children[0] ?? null);
  parent.raw.set(WINDOW_DESTROY_OFFSETS.lastChild, children.at(-1) ?? null);
  children.forEach((child, index) => {
    child.raw.set(WINDOW_DESTROY_OFFSETS.parent, parent);
    child.raw.set(WINDOW_DESTROY_OFFSETS.previousSibling, children[index - 1] ?? null);
    child.raw.set(WINDOW_DESTROY_OFFSETS.nextSibling, children[index + 1] ?? null);
  });
}

function fixture() {
  const moduleEvents = [];
  const leaves = [];
  const read = (object, offset, kind) => {
    if (!(object?.raw instanceof Map) || !object.raw.has(offset)) {
      throw new Error(`unresolved fixture offset +0x${offset.toString(16)}`);
    }
    const value = object.raw.get(offset);
    if (kind === 'ptr') return value ?? null;
    return value;
  };
  const write = (object, offset, kind, value) => {
    if (!(object?.raw instanceof Map)) throw new Error('fixture write received a non-object');
    object.raw.set(offset, kind === 'ptr' ? (value ?? null) : value);
  };
  const services = {
    read,
    write,
    onEvent: event => moduleEvents.push(event),
    setVisibility: details => {
      assert.equal(details.visible, false);
      leaves.push('SetVisibility');
    },
    setSelectability: details => {
      assert.equal(details.selectable, false);
      leaves.push('SetSelectability');
    },
    processScript: details => {
      assert.equal(details.event, 'DestroyWindow');
      assert.equal(details.parameters, null);
      assert.equal(details.thirdArgument, 1);
      leaves.push('ProcessScript');
    },
    childRemoved: details => leaves.push(`ChildRemoved:${details.parent.name}`),
    descendantRemoved: details => leaves.push(`DescendantRemoved:${details.ancestor.name}`),
    freeGc: details => leaves.push(`FreeGc:${details.object.name}`),
    destroyGc: details => {
      assert.equal(details.flags, 1);
      leaves.push(`DestroyGc:${details.object.name}`);
    },
    subclassDestructor: details => {
      leaves.push('SubclassDestructor');
      details.baseDestructor();
    },
    setVtable: details => leaves.push(`setVtable:${details.vtable.toString(16)}`),
    conditionalDestroy: () => leaves.push('conditionalDestroy'),
    uobjectDestructor: () => leaves.push('uobjectDestructor'),
    invalidateObject: () => leaves.push('invalidateObject'),
    freeObject: details => {
      assert.equal(details.size, 0x14c);
      assert.equal(details.flags, 1);
      leaves.push('freeObject');
    },
  };
  return {moduleEvents, leaves, services};
}

function runTranslated(name, rootObject, options = {}) {
  const value = fixture();
  const frame = {name: `${name}-frame`, raw: new Map([[WINDOW_DESTROY_OFFSETS.frameGuard, 0]])};
  const result = execDestroyWindowNative({object: rootObject, frame}, value.services);
  return {...value, result, frame, rootObject, ...options};
}

function ops(events) {
  return events.map(event => event.op);
}

function nativeOps(name) {
  return ops(native.cases[name].events).filter(op =>
    !['XWindowDestructor', 'FreeObject'].includes(op));
}

function translatedOps(value) {
  return ops(value.moduleEvents).filter(op => op !== 'ExecDestroy');
}

const normalObject = makeWindow({name: 'normal'});
const normal = runTranslated('normal', normalObject);
assert.equal(normal.result, true);
assert.equal(normal.frame.raw.get(WINDOW_DESTROY_OFFSETS.frameGuard), 1);
assert.equal(normalObject.raw.get(WINDOW_DESTROY_OFFSETS.windowFlags), 2 | WINDOW_DESTROY_BITS.bBeingDestroyed);
assert.deepEqual(translatedOps(normal), nativeOps('normal'));
assert.deepEqual(normal.leaves, [
  'SetSelectability', 'ProcessScript', 'SubclassDestructor',
  `setVtable:${WINDOW_DESTROY_NATIVE_ADDRESSES.xwindowVtable.toString(16)}`,
  'conditionalDestroy', `setVtable:${WINDOW_DESTROY_NATIVE_ADDRESSES.extensionObjectVtable.toString(16)}`,
  'conditionalDestroy', 'uobjectDestructor', 'invalidateObject', 'freeObject',
]);

const visibleObject = makeWindow({name: 'visible', flags: 1});
const visible = runTranslated('visible', visibleObject);
assert.equal(visible.result, true);
assert.deepEqual(translatedOps(visible), nativeOps('visible'));
assert.deepEqual(visible.leaves.slice(0, 3), ['SetVisibility', 'SetSelectability', 'ProcessScript']);

const lockedObject = makeWindow({name: 'locked', lockCount: 1});
const locked = runTranslated('locked', lockedObject);
assert.equal(locked.result, false);
assert.equal(locked.frame.raw.get(WINDOW_DESTROY_OFFSETS.frameGuard), 1);
assert.equal(lockedObject.raw.get(WINDOW_DESTROY_OFFSETS.windowFlags), 2 | WINDOW_DESTROY_BITS.bBeingDestroyed);
assert.deepEqual(translatedOps(locked), nativeOps('locked'));
assert.ok(!locked.leaves.includes('freeObject'));

const preflagObject = makeWindow({name: 'preflag', flags: 2 | WINDOW_DESTROY_BITS.bBeingDestroyed});
const preflag = runTranslated('preflag', preflagObject);
assert.equal(preflag.result, true);
assert.deepEqual(translatedOps(preflag), nativeOps('preflag'));
assert.deepEqual(preflag.leaves.slice(0, 1), ['SubclassDestructor']);

const childRoot = makeWindow({name: 'children-root'});
const children = [makeWindow({name: 'child-1', type: 0}), makeWindow({name: 'child-2', type: 0})];
linkChildren(childRoot, children);
const childCase = runTranslated('children', childRoot);
assert.equal(childCase.result, true);
assert.deepEqual(translatedOps(childCase), nativeOps('children'));
assert.equal(childRoot.raw.get(WINDOW_DESTROY_OFFSETS.firstChild), null);
assert.equal(childRoot.raw.get(WINDOW_DESTROY_OFFSETS.lastChild), null);
assert.equal(children[0].raw.get(WINDOW_DESTROY_OFFSETS.parent), null);
assert.equal(children[1].raw.get(WINDOW_DESTROY_OFFSETS.parent), null);

const gcRoot = makeWindow({name: 'gc-root'});
const gcB = makeNode('gc-b');
const gcA = makeNode('gc-a', gcB);
const gcC = makeNode('gc-c');
const contextA = makeContext('context-a');
const contextB = makeContext('context-b');
gcRoot.raw.set(WINDOW_DESTROY_OFFSETS.gcListA, gcA);
gcRoot.raw.set(WINDOW_DESTROY_OFFSETS.gcListB, gcC);
gcRoot.raw.set(WINDOW_DESTROY_OFFSETS.gcContextA, contextA);
gcRoot.raw.set(WINDOW_DESTROY_OFFSETS.gcContextB, contextB);
gcRoot.raw.set(WINDOW_DESTROY_OFFSETS.rootFocus, gcRoot);
gcRoot.raw.set(WINDOW_DESTROY_OFFSETS.rootGrab, gcRoot);
const gcCase = runTranslated('gc', gcRoot);
assert.equal(gcCase.result, true);
assert.deepEqual(translatedOps(gcCase), nativeOps('gc'));
for (const offset of [WINDOW_DESTROY_OFFSETS.gcListA, WINDOW_DESTROY_OFFSETS.gcListB,
  WINDOW_DESTROY_OFFSETS.gcContextA, WINDOW_DESTROY_OFFSETS.gcContextB,
  WINDOW_DESTROY_OFFSETS.rootFocus, WINDOW_DESTROY_OFFSETS.rootGrab]) {
  assert.equal(gcRoot.raw.get(offset), null);
}
assert.deepEqual(gcCase.leaves.filter(value => value.startsWith('FreeGc:')), [
  'FreeGc:gc-a', 'FreeGc:gc-b', 'FreeGc:gc-c',
]);
assert.deepEqual(gcCase.leaves.filter(value => value.startsWith('DestroyGc:')), [
  'DestroyGc:context-a', 'DestroyGc:context-b',
]);

console.log('Window destroy contract validated: Extension.u native1409/export2129 metadata, ' +
  'hash-checked Destroy/SafeDestroy/PreDestroy/KillAllChildren/CleanUp bodies, ' +
  'frame increment, visibility-chain branch, locked/preflag behavior, child order, ' +
  'GC list/context teardown, parent relinking, and explicit final-release leaves.');
