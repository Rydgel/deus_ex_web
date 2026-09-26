import test from 'node:test';
import assert from 'node:assert/strict';
import {
  destroyDeusExPlayerNative, destroyFlagBaseNative, destroyPlayerPawnExtNative,
} from '../src/runtime/script-player-destroy.mjs';

function player({flagBase = {name: 'FlagBase'}, rootWindow = {name: 'Root'}, inGarbageCollection = false} = {}) {
  const fields = new Map(Object.entries({conHistory: {name: 'History'}, FirstLog: {name: 'Log0'}, LastLog: {name: 'Log1'},
    flagBase, rootWindow}));
  const events = [];
  const services = {
    read: (_, name) => fields.get(name) ?? null,
    write: (_, name, value) => { events.push(`write:${name}:${value?.name ?? value}`); fields.set(name, value); },
    inGarbageCollection: () => inGarbageCollection,
    conditionalDestroy: target => events.push(`ConditionalDestroy:${target.name}`),
    safeDestroyWindow: root => events.push(`SafeDestroy:${root.name}`),
    destroyActorBase: () => events.push('AActor::Destroy'),
  };
  return {fields, events, services};
}

test('ADeusExPlayer::Destroy stores its three fields, then APlayerPawnExt::Destroy outside a collection', () => {
  const {fields, events, services} = player();
  destroyDeusExPlayerNative({}, services);
  assert.deepEqual(events, [
    'write:conHistory:null', 'write:FirstLog:null', 'write:LastLog:null',
    // 0x10037d7d: ConditionalDestroy without clearing +0x890.
    'ConditionalDestroy:FlagBase',
    'SafeDestroy:Root', 'write:rootWindow:null', 'AActor::Destroy',
  ]);
  assert.equal(fields.get('flagBase').name, 'FlagBase');
});

test('APlayerPawnExt::Destroy only nulls the FlagBase inside a collection or without one', () => {
  const collecting = player({inGarbageCollection: true});
  destroyPlayerPawnExtNative({}, collecting.services);
  assert.deepEqual(collecting.events, ['write:flagBase:null', 'SafeDestroy:Root', 'write:rootWindow:null', 'AActor::Destroy']);
  const empty = player({flagBase: null, rootWindow: null});
  destroyPlayerPawnExtNative({}, empty.services);
  assert.deepEqual(empty.events, ['write:flagBase:null', 'write:rootWindow:null', 'AActor::Destroy']);
});

test('XFlagBase::Destroy runs UObject::Destroy before draining the flag store', () => {
  const events = [], flagBase = {entries: new Map([['a', {}], ['b', {}]])};
  destroyFlagBaseNative(flagBase, {destroyObjectBase: target => events.push(`UObject::Destroy:${target.entries.size}`)});
  assert.deepEqual(events, ['UObject::Destroy:2']);
  assert.equal(flagBase.entries.size, 0);
  assert.throws(() => destroyFlagBaseNative({}, {destroyObjectBase: () => {}}), /host flag store/);
});
