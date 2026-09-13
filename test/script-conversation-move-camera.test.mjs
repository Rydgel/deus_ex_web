import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONVERSATION_BASE_BIND,
  CONVERSATION_MOVE_CAMERA_BIND,
  bindConversationBaseActor,
  bindConversationMoveCameraActor,
  conversationMoveCameraBindNativeContract,
  isConversationBaseBindClass,
  isConversationMoveCameraBindClass,
} from '../src/runtime/script-conversation-base-bind.mjs';

test('MoveCamera uses its distinct recovered false-return BindActor body', () => {
  const key = 'ConSys.ConEventMoveCamera';
  assert.equal(isConversationMoveCameraBindClass(key), true);
  assert.equal(isConversationMoveCameraBindClass(key.toLowerCase()), true);
  assert.equal(isConversationBaseBindClass(key), false);
  assert.equal(bindConversationMoveCameraActor({
    classKey: key,
    event: {unexpected: 'ignored'},
    firstActor: {unexpected: 'ignored'},
    secondActor: {unexpected: 'ignored'},
    conversation: {unexpected: 'ignored'},
  }), false);

  const contract = conversationMoveCameraBindNativeContract(key);
  assert.equal(contract.classKey, key);
  assert.equal(contract.nativeBody, 0x100098f0);
  assert.deepEqual(contract.bodyBytes, [0x32, 0xc0, 0xc2, 0x0c, 0x00]);
  assert.equal(contract.vtableSlot, 0x58);
  assert.equal(contract.argumentBytes, 0xc);
  assert.equal(contract.result, false);
  assert.equal(contract.classRecord.slotTarget, contract.nativeBody);
});

test('MoveCamera remains separate from the inherited false-body partition', () => {
  assert.equal(CONVERSATION_MOVE_CAMERA_BIND.nativeBody, 0x100098f0);
  assert.notEqual(CONVERSATION_MOVE_CAMERA_BIND.nativeBody, CONVERSATION_BASE_BIND.nativeBody);
  assert.throws(() => bindConversationBaseActor({classKey: 'ConSys.ConEventMoveCamera'}), error =>
    error.code === 'CONVERSATION_BASE_BIND_OVERRIDE' && error.slotTarget === 0x100098f0);
  assert.equal(isConversationMoveCameraBindClass('ConSys.ConEventCheckObject'), false);
  assert.throws(() => bindConversationMoveCameraActor({classKey: 'ConSys.ConEventCheckObject'}), error =>
    error.code === 'CONVERSATION_BASE_BIND_MOVE_CAMERA_CLASS' && error.slotTarget === 0x10007bf0);
});
