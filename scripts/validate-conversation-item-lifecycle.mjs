/** Validate the original ConListItem constructor and scalar deleting wrapper.
 *
 * The Python oracle executes the unchanged ConSys bodies and services only
 * Core's process-dependent lifecycle imports.  The JS half compares those
 * recorded calls with the narrow root translation in an isolated fixture;
 * this does not claim array deleting, Core registry unlinking, or allocator
 * reclamation beyond the explicit boundary call.
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {access} from 'node:fs/promises';
import {
  constructConversationItem,
  releaseConversationItem,
} from '../src/runtime/script-conversation-item-lifecycle.mjs';
import {gameDirectory} from './game-directory.mjs';

const python = process.env.NATIVE_PROBE_PYTHON ||
  path.resolve('.cache/native-probe-env/bin/python');
await access(python);
const oracle = JSON.parse(execFileSync(python, [
  path.resolve('scripts/native-conversation-item-lifecycle-oracle.py'),
  gameDirectory(),
], {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024}));

const address = oracle.addresses;
const imports = oracle.imports;
assert.equal(oracle.staticVtables.conListItemDeletingSlot, address.deletingWrapper,
  'ConListItem scalar deleting slot');
assert.equal(oracle.staticVtables.conListItemDestroySlot, address.destroyThunk,
  'ConListItem +0x24 Destroy thunk');
assert.equal(oracle.staticVtables.conObjectDestroySlot, address.destroyThunk,
  'ConObject +0x24 Destroy thunk');
assert.equal(oracle.staticVtables.destroyThunkTarget, imports.destroy,
  'Destroy thunk resolves through Core IAT');
assert.equal(oracle.staticVtables.destroyThunkTarget, 0x101025f4,
  'installed Core UObject::Destroy import target');
assert.equal(imports.uobjectConstructor, 0x101021c6,
  'installed Core UObject constructor import target');
assert.equal(imports.uobjectDestructor, 0x101028c4,
  'installed Core UObject destructor import target');
assert.equal(imports.conditionalDestroy, 0x10102270,
  'installed Core ConditionalDestroy import target');
assert.equal(imports.operatorDelete, 0x101010cd,
  'installed Core operator delete import target');

const nativeConstructor = oracle.cases.flags0.constructor;
assert.equal(nativeConstructor.vtable, address.conListItemVtable);
assert.equal(nativeConstructor.con, 0);
assert.equal(nativeConstructor.next, 0);
assert.equal(nativeConstructor.objectFlags, 0x55555555,
  'constructor leaves ObjectFlags untouched');
assert.deepEqual(nativeConstructor.writes.map(({offset, size, value}) =>
  [offset, size, value]), [
  [0, 4, address.coreVtable],
  [0, 4, address.conListItemVtable],
  [0x28, 4, 0],
  [0x2c, 4, 0],
], 'constructor writes Core vtable, ConListItem vtable, con and next only');
assert.deepEqual(nativeConstructor.coreConstructorTrace, [
  imports.uobjectConstructor, 0x1014f340,
], 'constructor calls the real Core UObject constructor body');

function translate(flags) {
  const object = {
    identity: {name: 'ConListItemFixture'},
    index: -1,
    nativeVtable: address.conListItemVtable,
    flags: 0x55555555,
    con: 0x11111111,
    next: 0x22222222,
    stateFrame: null,
  };
  const writes = [];
  const conditional = [];
  const freed = [];
  constructConversationItem(object, {
    write(identity, field, value) {
      assert.equal(identity, object.identity);
      writes.push(field);
      object[field] = value;
    },
  });
  const result = releaseConversationItem(object, flags, {
    conditionalDestroy(value) {
      assert.equal(value, object);
      conditional.push(object.nativeVtable);
    },
    gates: {[0x102a2644]: true, [0x101e5550]: false},
    freeObject(value) {
      assert.equal(value, object);
      freed.push(value);
    },
  });
  return {
    object,
    result,
    writes,
    conditional,
    freed,
  };
}

function normalizedNative(caseResult) {
  return {
    constructorVtable: caseResult.constructor.vtable,
    constructorFields: [caseResult.constructor.con || null,
      caseResult.constructor.next || null],
    constructorObjectFlags: caseResult.constructor.objectFlags,
    releaseEvents: caseResult.release.events.map(event => {
      if (event.op === 'ConditionalDestroy') {
        return ['conditionalDestroy', event.vtable, event.destroySlot, event.destroyIat];
      }
      if (event.op === 'UObjectDestructor')
        return ['uobjectDestructor', event.vtableBefore];
      if (event.op === 'operatorDelete')
        return ['operatorDelete', event.size];
      throw new Error(`Unexpected native release event ${event.op}`);
    }),
    finalVtable: caseResult.release.finalVtable,
    returnIsObject: caseResult.release.returnIsObject,
    freed: caseResult.release.events.some(event => event.op === 'operatorDelete'),
  };
}

for (const flags of [0, 1]) {
  const key = `flags${flags}`;
  const native = oracle.cases[key];
  const translated = translate(flags);
  assert.deepEqual(translated.writes, ['con', 'next'], `${key} constructor fields`);
  assert.equal(translated.object.nativeVtable, address.coreVtable, `${key} final vtable`);
  assert.equal(translated.object.con, null, `${key} con default`);
  assert.equal(translated.object.next, null, `${key} next default`);
  assert.equal(translated.object.flags, 0x55555555, `${key} flags untouched by fixture gate`);
  assert.deepEqual(translated.conditional, [
    address.conListItemVtable, address.conObjectVtable,
  ], `${key} two native ConditionalDestroy calls`);
  assert.equal(translated.freed.length, flags, `${key} scalar delete gate`);

  const expected = normalizedNative(native);
  assert.deepEqual({
    constructorVtable: address.conListItemVtable,
    // Native stores integer zero; the reflected pointer translation exposes
    // the same null pointer as JavaScript null.
    constructorFields: [null, null],
    constructorObjectFlags: translated.object.flags,
    releaseEvents: [
      ['conditionalDestroy', address.conListItemVtable, address.destroyThunk,
        imports.destroy],
      ['conditionalDestroy', address.conObjectVtable, address.destroyThunk,
        imports.destroy],
      ['uobjectDestructor', address.conObjectVtable],
      ...(flags ? [['operatorDelete', 0x30]] : []),
    ],
    finalVtable: translated.object.nativeVtable,
    returnIsObject: true,
    freed: Boolean(flags),
  }, expected, `${key} native and translated scalar lifecycle contract`);
}

assert.deepEqual(oracle.cases.flags0.destroyThunk.call, [{
  op: 'UObjectDestroy', object: 'item', vtable: address.conListItemVtable,
}], 'vtable +0x24 thunk dispatches to the explicit Destroy service');
assert.deepEqual(oracle.cases.flags1.destroyThunk.call, [{
  op: 'UObjectDestroy', object: 'item', vtable: address.conListItemVtable,
}], 'second fresh item has the same Destroy thunk dispatch');

console.log('Original ConSys ConListItem constructor and scalar deleting wrapper passed: ' +
  'real Core base constructor, con/next zeroing, two ConditionalDestroy calls, ' +
  'base vtable restoration, and flags 0/1 delete gate.');
console.log('Unsupported boundary remains explicit: array deleting flags 2 and Core registry/' +
  'allocator side effects are not emulated by the lifecycle callbacks.');
