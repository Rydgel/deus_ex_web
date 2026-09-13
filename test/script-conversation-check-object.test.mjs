import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONVERSATION_CHECK_OBJECT_BIND,
  ConversationCheckObjectBindError,
  bindConversationCheckObjectActor,
  isConversationCheckObjectBindClass,
} from '../src/runtime/script-conversation-check-object-bind.mjs';

function fixture(objectName, checkObject = { key: 'seed.class' }) {
  const event = { objectName, checkObject };
  const writes = [];
  return {
    event,
    writes,
    read: (object, field) => object[field],
    write: (object, field, value) => {
      writes.push({ field, value });
      object[field] = value;
    },
  };
}

test('CheckObject dispatch is exact-key and reports the recovered contract', () => {
  assert.equal(isConversationCheckObjectBindClass('ConSys.ConEventCheckObject'), true);
  assert.equal(isConversationCheckObjectBindClass('consys.coneventcheckobject'), true);
  assert.equal(isConversationCheckObjectBindClass('ConSys.ConEventMoveCamera'), false);
  assert.equal(CONVERSATION_CHECK_OBJECT_BIND.classExport, 365);
  assert.equal(CONVERSATION_CHECK_OBJECT_BIND.scriptTextExport, 319);
  assert.equal(CONVERSATION_CHECK_OBJECT_BIND.vtable, 0x1001393c);
  assert.equal(CONVERSATION_CHECK_OBJECT_BIND.nativeBody, 0x10007bf0);
  assert.equal(CONVERSATION_CHECK_OBJECT_BIND.vtableSlot, 0x58);
  assert.equal(CONVERSATION_CHECK_OBJECT_BIND.argumentBytes, 0xc);
  assert.equal(CONVERSATION_CHECK_OBJECT_BIND.result, false);
});

test('CheckObject NK_ branch clears checkObject and does not load a package', () => {
  const current = fixture('NK_Catacombs_Blastdoor02');
  const calls = [];
  assert.equal(bindConversationCheckObjectActor({
    event: current.event,
    read: current.read,
    write: current.write,
    createPackage: request => calls.push({ kind: 'CreatePackage', request }),
    staticLoadObject: request => calls.push({ kind: 'StaticLoadObject', request }),
  }), false);
  assert.equal(current.event.checkObject, null);
  assert.deepEqual(current.writes, [{ field: 'checkObject', value: null }]);
  assert.deepEqual(calls, []);
});

test('CheckObject regular branch preserves CreatePackage then StaticLoadObject order', () => {
  const current = fixture('AugmentationCannister');
  const classRef = { key: 'core.class' };
  const packageObject = { key: 'deusex' };
  const loadedObject = { key: 'deusex.augmentationcannister' };
  const calls = [];
  assert.equal(bindConversationCheckObjectActor({
    classKey: 'consys.coneventcheckobject',
    event: current.event,
    read: current.read,
    write: current.write,
    classRef,
    createPackage: request => {
      calls.push({ kind: 'CreatePackage', request });
      return packageObject;
    },
    staticLoadObject: request => {
      calls.push({ kind: 'StaticLoadObject', request });
      return loadedObject;
    },
  }), false);
  assert.deepEqual(calls, [
    { kind: 'CreatePackage', request: { outer: null, name: 'DeusEx' } },
    {
      kind: 'StaticLoadObject',
      request: {
        classRef,
        outer: packageObject,
        name: 'AugmentationCannister',
        filename: null,
        flags: 2,
        sandbox: null,
      },
    },
  ]);
  assert.strictEqual(current.event.checkObject, loadedObject);
  assert.deepEqual(current.writes, [{ field: 'checkObject', value: loadedObject }]);
});

test('CheckObject uses appStricmp semantics for the NK_ prefix', () => {
  const current = fixture('nk_KeyName', { key: 'seed.class' });
  let loads = 0;
  bindConversationCheckObjectActor({
    event: current.event,
    read: current.read,
    write: current.write,
    createPackage: () => { loads++; },
    staticLoadObject: () => { loads++; },
  });
  assert.equal(loads, 0);
  assert.equal(current.event.checkObject, null);
});

test('CheckObject keeps missing and asynchronous loader services explicit', () => {
  const current = fixture('WeaponRifle');
  assert.throws(() => bindConversationCheckObjectActor({
    event: current.event,
    read: current.read,
    write: current.write,
  }), error => error instanceof ConversationCheckObjectBindError &&
    error.code === 'CONVERSATION_CHECK_OBJECT_BIND_SERVICE');

  assert.throws(() => bindConversationCheckObjectActor({
    event: current.event,
    read: current.read,
    write: current.write,
    classRef: { key: 'core.class' },
    createPackage: async () => ({ key: 'deusex' }),
    staticLoadObject: () => null,
  }), error => error instanceof ConversationCheckObjectBindError &&
    error.code === 'CONVERSATION_CHECK_OBJECT_BIND_ASYNC');
});
