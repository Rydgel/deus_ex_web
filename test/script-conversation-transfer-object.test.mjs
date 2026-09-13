import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONVERSATION_TRANSFER_OBJECT_BIND,
  ConversationTransferObjectBindError,
  bindConversationTransferObjectActor,
  isConversationTransferObjectBindClass,
} from '../src/runtime/script-conversation-transfer-object-bind.mjs';

const read = (object, field) => object[field];
const write = (object, field, value) => { object[field] = value; };

function services(calls, loaded = { key: 'deusex.inventory-class' }) {
  const classRef = { key: 'core.class' };
  const outer = { key: 'deusex' };
  return {
    classRef,
    createPackage(request) { calls.push(['CreatePackage', request]); return outer; },
    staticLoadObject(request) { calls.push(['StaticLoadObject', request]); return loaded; },
    outer,
    loaded,
  };
}

test('TransferObject binds an ordinary from actor and loads giveObject afterward', () => {
  const event = {
    ObjectName: 'WeaponRifle', fromName: 'PaulDenton', toName: 'JCDenton',
    fromActor: 'old-from', toActor: 'old-to', giveObject: null,
  };
  const candidate = { BindName: 'pauldenton', BarkBindName: 'Other' };
  const conversation = { bFirstPerson: false };
  const calls = [];
  const svc = services(calls);
  assert.equal(bindConversationTransferObjectActor({
    event, firstActor: { ignored: true }, secondActor: candidate, conversation,
    read: (object, field) => { calls.push(['read', field]); return object[field]; },
    write: (object, field, value) => { calls.push(['write', field]); object[field] = value; },
    ...svc,
  }), true);
  assert.strictEqual(event.fromActor, candidate);
  assert.equal(event.toActor, 'old-to');
  assert.strictEqual(event.giveObject, svc.loaded);
  assert.equal(calls[0][0], 'CreatePackage');
  assert.deepEqual(calls.filter(call => call[0] === 'read').map(call => call[1]), [
    'fromName', 'BarkBindName', 'fromName', 'BindName',
    'toName', 'BarkBindName', 'toName', 'BindName', 'ObjectName',
  ]);
  assert.equal(calls.at(-2)[0], 'StaticLoadObject');
  assert.deepEqual(calls.at(-2)[1], {
    classRef: svc.classRef, outer: svc.outer, name: 'WeaponRifle',
    filename: null, flags: 2, sandbox: null,
  });
  assert.deepEqual(calls.at(-1).slice(0, 2), ['write', 'giveObject']);
});

test('TransferObject accepts a first-person bark name for toActor', () => {
  const event = {
    ObjectName: 'Image02_NYC_Warehouse', fromName: 'AlexJacobson', toName: 'JC-Bark',
    fromActor: null, toActor: null, giveObject: null,
  };
  const candidate = { BindName: 'JCDenton', BarkBindName: 'jc-bark' };
  const conversation = { bFirstPerson: true };
  const calls = [];
  const svc = services(calls);
  assert.equal(bindConversationTransferObjectActor({
    event, secondActor: candidate, conversation, read, write, ...svc,
  }), true);
  assert.equal(event.fromActor, null);
  assert.strictEqual(event.toActor, candidate);
  assert.strictEqual(event.giveObject, svc.loaded);
});

test('TransferObject can bind both actor fields to the same candidate', () => {
  const event = {
    ObjectName: 'NanoKey', fromName: 'Shared', toName: 'shared',
    fromActor: null, toActor: null, giveObject: null,
  };
  const candidate = { BindName: 'SHARED', BarkBindName: '' };
  const calls = [];
  const svc = services(calls);
  assert.equal(bindConversationTransferObjectActor({
    event, secondActor: candidate, conversation: { bFirstPerson: false }, read, write, ...svc,
  }), true);
  assert.strictEqual(event.fromActor, candidate);
  assert.strictEqual(event.toActor, candidate);
});

test('TransferObject miss preserves actor fields but still stores loader result', () => {
  const event = {
    ObjectName: 'DataVaultImage', fromName: 'From', toName: 'To',
    fromActor: 'old-from', toActor: 'old-to', giveObject: 'old-class',
  };
  const calls = [];
  const svc = services(calls, null);
  assert.equal(bindConversationTransferObjectActor({
    event, secondActor: { BindName: 'Other', BarkBindName: '' },
    conversation: { bFirstPerson: false }, read, write, ...svc,
  }), false);
  assert.equal(event.fromActor, 'old-from');
  assert.equal(event.toActor, 'old-to');
  assert.equal(event.giveObject, null);
});

test('TransferObject dispatch is exact-keyed and rejects missing native services', () => {
  assert.equal(isConversationTransferObjectBindClass('consys.coneventtransferobject'), true);
  assert.equal(isConversationTransferObjectBindClass('Other.ConEventTransferObject'), false);
  assert.throws(() => bindConversationTransferObjectActor({ classKey: 'Other.ConEventTransferObject' }),
    error => error instanceof ConversationTransferObjectBindError &&
      error.code === 'CONVERSATION_TRANSFER_OBJECT_BIND_CLASS');
  const event = { ObjectName: 'WeaponRifle', fromName: '', toName: '' };
  assert.throws(() => bindConversationTransferObjectActor({
    event, secondActor: { BindName: '', BarkBindName: '' },
    conversation: { bFirstPerson: false }, read, write,
  }), error => error instanceof ConversationTransferObjectBindError &&
    error.code === 'CONVERSATION_TRANSFER_OBJECT_BIND_SERVICE');
  assert.equal(CONVERSATION_TRANSFER_OBJECT_BIND.nativeBodySize, 0x160);
});
