import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DATALINK_NATIVE_INDICES,
  DataLinkNativeBoundaryError,
  createDataLinkNativeService,
  dataLinkNativeContract,
} from '../src/runtime/script-datalink-transmission.mjs';

test('ConSys native declarations retain recovered indices and arity', () => {
  assert.equal(dataLinkNativeContract(DATALINK_NATIVE_INDICES.BindEvents).arguments, 2);
  assert.deepEqual(dataLinkNativeContract(DATALINK_NATIVE_INDICES.BindEvents).parameters,
    ['Actor[10] out conBoundActors', 'Actor invokeActor']);
  assert.equal(dataLinkNativeContract(DATALINK_NATIVE_INDICES.BindActorEvents).arguments, 1);
  assert.equal(dataLinkNativeContract(DATALINK_NATIVE_INDICES.ClearBindEvents).arguments, 0);
  assert.equal(dataLinkNativeContract(DATALINK_NATIVE_INDICES.GetSpeechAudio).arguments, 1);
  assert.equal(dataLinkNativeContract(DATALINK_NATIVE_INDICES.GetSpeechLength).arguments, 1);
});

test('unserviced ConSys natives fail explicitly instead of fabricating results', () => {
  const service = createDataLinkNativeService();
  assert.throws(() => service({
    index: DATALINK_NATIVE_INDICES.BindEvents,
    argumentCount: 2,
    evaluateArgument: () => null,
  }), error => error instanceof DataLinkNativeBoundaryError &&
    error.nativeIndex === DATALINK_NATIVE_INDICES.BindEvents);
  assert.throws(() => service({
    index: DATALINK_NATIVE_INDICES.BindActorEvents,
    argumentCount: 0,
    evaluateArgument: () => null,
  }), /expected 1/);
});

test('native adapter preserves VM references for the host service', () => {
  const actor = { name: 'JC' };
  let received = null;
  const service = createDataLinkNativeService({
    bindActorEvents: details => {
      received = details;
      return undefined;
    },
  });
  const reference = { reference: true, get: () => actor, set: () => {} };
  const result = service({
    index: DATALINK_NATIVE_INDICES.BindActorEvents,
    receiver: { name: 'DL_Start' },
    argumentCount: 1,
    evaluateArgument: () => reference,
  });
  assert.equal(result, undefined);
  assert.equal(received.actorToBind, actor);
  assert.equal(received.references[0], reference);
  assert.equal(received.conversation.name, 'DL_Start');
});
