/** Validate the bounded original Window.NewChild/CreateNewWindow contract. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { readFunctionMetadata } from '../src/unreal/script-metadata.mjs';
import { ScriptRuntime } from '../src/runtime/script-runtime.mjs';
import {
  WINDOW_BEING_DESTROYED,
  WINDOW_CHILD_FIELDS,
  WINDOW_CHILD_NATIVE,
  WINDOW_CHILD_NATIVE_ADDRESSES,
  createNewWindowNative,
} from '../src/runtime/script-window-child.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory();
const extensionPath = path.join(root, 'System', 'Extension.u');
const extensionBytes = new Uint8Array(await readFile(extensionPath));
const assets = new AssetStore((await readdir(path.join(root, 'System'))).map(name => ({
  path: 'System/' + name,
  read: () => name === 'Extension.u' ? extensionBytes : readFile(path.join(root, 'System', name)),
})));
const extension = await assets.get('Extension');
const newChildIndex = extension.exportsByPath.get('window.newchild');
assert.equal(newChildIndex, WINDOW_CHILD_NATIVE.packageExport);
const metadata = readFunctionMetadata(extension, newChildIndex);
assert.equal(metadata.nativeIndex, WINDOW_CHILD_NATIVE.nativeIndex);
assert.equal(metadata.functionFlags, 0x401);
assert.equal(metadata.entry.serialSize, 34);
assert.deepEqual(metadata.parameters.map(parameter => ({
  name: parameter.name,
  className: parameter.className,
  flags: parameter.flags,
  type: parameter.type,
})), [
  {name: 'NewClass', className: 'ClassProperty', flags: 0x80, type: 'class'},
  {name: 'bShow', className: 'BoolProperty', flags: 0x90, type: 'bool'},
  {name: 'ReturnValue', className: 'ObjectProperty', flags: 0x580, type: 'object'},
]);

const extensionDll = new Uint8Array(await readFile(path.join(root, 'System', 'Extension.dll')));
assert.equal(createHash('sha256').update(extensionDll).digest('hex'), WINDOW_CHILD_NATIVE.dllSha256);

const python = process.env.NATIVE_PROBE_PYTHON ||
  path.resolve('.cache/native-probe-env/bin/python');
const native = JSON.parse(execFileSync(python, [
  path.resolve('scripts/native-window-child-oracle.py'), root,
], {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024}));
assert.equal(native.hashes['Extension.dll'], WINDOW_CHILD_NATIVE.dllSha256);
assert.equal(native.extensionBase, 0x12000000);
assert.equal(native.addresses.createNewWindow, 0x1204df70);
assert.equal(native.addresses.initVtableSlot, 0x54);
assert.equal(native.addresses.beingDestroyedBit, WINDOW_BEING_DESTROYED);

function fixture({deleteDuringInit = false} = {}) {
  const parent = {name: 'parent'};
  const newClass = {name: 'HUDInfoLinkDisplay'};
  const child = {name: 'child', [WINDOW_CHILD_FIELDS.stateBits]: 0,
    [WINDOW_CHILD_FIELDS.lockCount]: 0};
  const trace = [];
  const read = (object, field, details) => {
    trace.push({op: 'read', field, phase: details.phase});
    return object[field];
  };
  const write = (object, field, value, details) => {
    trace.push({op: 'write', field, value, phase: details.phase});
    object[field] = value;
  };
  const services = {
    staticConstructObject: details => {
      trace.push({op: 'StaticConstructObject', ...details, object: child});
      return child;
    },
    initVtable: details => trace.push({op: 'InitVtable', ...details}),
    processScript: details => {
      trace.push({op: 'ProcessScript', ...details});
      if (deleteDuringInit) child[WINDOW_CHILD_FIELDS.stateBits] |= WINDOW_BEING_DESTROYED;
    },
    setVisibility: details => trace.push({op: 'SetVisibility', ...details}),
    askParentForReconfigure: details => trace.push({op: 'AskParentForReconfigure', ...details}),
    safeDestroy: details => trace.push({op: 'SafeDestroy', ...details}),
    read,
    write,
  };
  return {parent, newClass, child, trace, services};
}

function translatedCase(options) {
  const fixtureValue = fixture(options);
  const result = createNewWindowNative({
    newClass: fixtureValue.newClass,
    parent: fixtureValue.parent,
    bShow: true,
    errorDevice: {name: 'GError'},
  }, fixtureValue.services);
  return {...fixtureValue, result};
}

const translatedNormal = translatedCase();
const translatedDeletion = translatedCase({deleteDuringInit: true});
const translatedNull = (() => {
  let called = false;
  const result = createNewWindowNative({newClass: null}, {
    staticConstructObject: () => { called = true; return {}; },
  });
  return {result, called};
})();

assert.equal(translatedNull.result, null);
assert.equal(translatedNull.called, false, 'null class returns before construction');
assert.equal(translatedNormal.result, translatedNormal.child);
assert.equal(translatedNormal.child[WINDOW_CHILD_FIELDS.stateBits], 0);
assert.equal(translatedNormal.child[WINDOW_CHILD_FIELDS.lockCount], 0);
assert.equal(translatedDeletion.result, null);
assert.equal(translatedDeletion.child[WINDOW_CHILD_FIELDS.stateBits], WINDOW_BEING_DESTROYED);
assert.equal(translatedDeletion.child[WINDOW_CHILD_FIELDS.lockCount], 0);

function ops(trace) {
  return trace.filter(event => !['read', 'write'].includes(event.op)).map(event => event.op);
}
assert.deepEqual(ops(translatedNormal.trace), [
  'StaticConstructObject', 'InitVtable', 'ProcessScript', 'SetVisibility',
  'AskParentForReconfigure',
]);
assert.deepEqual(ops(translatedDeletion.trace), [
  'StaticConstructObject', 'InitVtable', 'ProcessScript', 'SetVisibility',
  'AskParentForReconfigure', 'SafeDestroy',
]);

function lifecycle(trace) {
  return trace.filter(event => event.op === 'read' || event.op === 'write')
    .map(event => `${event.op}:${event.phase}:${event.field}`);
}
assert.deepEqual(lifecycle(translatedNormal.trace), [
  'read:LockWindow:lockCount', 'write:LockWindow:lockCount',
  'read:CreateNewWindow:windowFlags',
  'read:UnlockWindow:lockCount', 'write:UnlockWindow:lockCount',
  'read:UnlockWindow:windowFlags',
]);
const deletionLifecycle = lifecycle(translatedDeletion.trace);
assert.ok(deletionLifecycle.indexOf('read:CreateNewWindow:windowFlags') <
  deletionLifecycle.indexOf('read:UnlockWindow:lockCount'),
  'CreateNewWindow samples the deletion flag before UnlockWindow');

const oracleNormal = native.cases.normal;
const oracleDeletion = native.cases.deletionDuringInitWindow;
assert.equal(native.cases.nullClass.result, 0);
assert.deepEqual(oracleNormal.events.map(event => event.op), [
  'FName', 'StaticConstructObject', 'InitVtable', 'ProcessScript',
  'SetVisibility', 'AskParentForReconfigure',
]);
assert.deepEqual(oracleDeletion.events.map(event => event.op), [
  'FName', 'StaticConstructObject', 'InitVtable', 'ProcessScript',
  'InitWindowSetBeingDestroyed', 'SetVisibility', 'AskParentForReconfigure',
  'SafeDestroy',
]);
assert.equal(oracleNormal.resultIsChild, true);
assert.equal(oracleNormal.state.flags, 0);
assert.equal(oracleNormal.state.lockCount, 0);
assert.equal(oracleDeletion.result, 0);
assert.equal(oracleDeletion.state.flags, WINDOW_BEING_DESTROYED);
assert.equal(oracleDeletion.state.lockCount, 0);
assert.deepEqual(oracleNormal.writes.map(write => [write.offset, write.value]), [[0x34, 1], [0x34, 0]]);
assert.deepEqual(oracleDeletion.writes.map(write => [write.offset, write.value]), [[0x34, 1], [0x34, 0]]);
const staticArgs = oracleNormal.events.find(event => event.op === 'StaticConstructObject');
assert.equal(staticArgs.name, 0, 'StaticConstructObject receives NAME_None');
assert.equal(staticArgs.flags, 0);
assert.equal(staticArgs.template, 0);
assert.equal(staticArgs.error, 0x45454545);

// The shared native wrapper executes the prepared original declaration, using
// canonical class/receiver/result identities. Lifecycle leaves remain explicit.
const vmFixture = fixture();
const errorDevice = {name: 'GError'};
const runtime = new ScriptRuntime(assets, {
  windowLifecycle: {...vmFixture.services, errorDevice},
  native: call => { throw new Error('Unexpected Window native ' + call.index); },
});
const windowIndex = extension.exportsByPath.get('window');
const windowClass = await runtime.loadClass(extension, windowIndex);
const classObject = await runtime.objects.resolve(extension, windowIndex);
runtime.attach(vmFixture.parent, windowClass);
runtime.attach(vmFixture.child, windowClass);
const newChild = await runtime.prepareFunction(extension, newChildIndex);
assert.equal(runtime.callFunction(newChild, vmFixture.parent, 1, () => classObject), vmFixture.child);
const vmConstruction = vmFixture.trace.find(event => event.op === 'StaticConstructObject');
assert.equal(vmConstruction.classObject, classObject);
assert.equal(vmConstruction.outer, vmFixture.parent);
assert.equal(vmConstruction.error, errorDevice);
assert.equal(vmFixture.trace.find(event => event.op === 'SetVisibility').visible, true,
  'execNewChild initializes the optional bShow operand to one at 0x10051892');
vmFixture.trace.length = 0;
assert.equal(runtime.callFunction(newChild, vmFixture.parent, 2, index =>
  index === 0 ? classObject : false), vmFixture.child);
assert.ok(!vmFixture.trace.some(event => event.op === 'SetVisibility'));
assert.equal(vmFixture.trace.find(event => event.op === 'ProcessScript').thirdArgument, 1);
vmFixture.trace.length = 0;
assert.equal(runtime.callFunction(newChild, vmFixture.parent, 2, index =>
  index === 0 ? classObject : undefined), vmFixture.child);
assert.equal(vmFixture.trace.find(event => event.op === 'SetVisibility').visible, true,
  'an empty operand leaves execNewChild\'s initialized bShow value intact');
vmFixture.trace.length = 0;
assert.equal(runtime.callFunction(newChild, vmFixture.parent, 1, () => null), null);
assert.equal(vmFixture.trace.length, 0, 'null class remains a no-service return in the shared VM');

console.log('Window child contract validated: Extension.u native1410/export2126 metadata, ' +
  'hash-checked unchanged CreateNewWindow execution, exact construction/lifecycle order, ' +
  'Lock/Unlock timing, normal return, null class, InitWindow deletion return, ' +
  'and canonical shared native1410 arguments/results with default/false visibility.');
