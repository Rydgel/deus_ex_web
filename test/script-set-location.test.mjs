import test from 'node:test';
import assert from 'node:assert/strict';
import { execSetLocation, SET_LOCATION_NATIVE } from '../src/runtime/script-set-location.mjs';
import { ScriptRuntime } from '../src/runtime/script-runtime.mjs';

test('SetLocation preserves the native level/actor/destination/zero-flag ABI', () => {
  const receiver = { name: 'script actor' };
  const level = { name: 'ULevel fixture' };
  const actor = { name: 'native actor' };
  const calls = [];
  const destination = [1.25, -2.5, 3.75];
  const result = execSetLocation(receiver, destination, {
    levelFor: value => { calls.push(['level', value]); return level; },
    actorFor: (value, linkedLevel) => {
      calls.push(['actor', value, linkedLevel]);
      return actor;
    },
    farMoveActor: (...args) => {
      calls.push(['farMoveActor', ...args]);
      return 1;
    },
  });

  assert.equal(result, true);
  assert.deepEqual(calls, [
    ['level', receiver],
    ['actor', receiver, level],
    ['farMoveActor', level, actor, destination, 0, 0],
  ]);
  assert.equal(SET_LOCATION_NATIVE.index, 267);
  assert.equal(SET_LOCATION_NATIVE.farMoveActorVtableOffset, 0x8c);
});

test('SetLocation rejects an absent explicit adapter instead of using player movement', () => {
  assert.throws(() => execSetLocation({}, [1, 2, 3], {
    levelFor: () => ({ name: 'ULevel fixture' }),
  }), /native actor identity/);
  assert.throws(() => execSetLocation({}, [1, 2, 3], {
    levelFor: () => ({ name: 'ULevel fixture' }),
    actorFor: () => ({}),
  }), /FarMoveActor/);
});

test('ScriptRuntime dispatch evaluates SetLocation once and returns the adapter Boolean', () => {
  const receiver = {};
  const destination = [9, 8, 7];
  let evaluations = 0;
  const calls = [];
  const runtime = new ScriptRuntime({}, {
    levelFor: () => ({ name: 'ULevel fixture' }),
    relocation: {
      actorFor: () => ({ name: 'native actor' }),
      farMoveActor: (...args) => { calls.push(args); return false; },
    },
  });
  const result = runtime.invokeNative({
    index: 267,
    receiver,
    argumentCount: 1,
    evaluateArgument: () => { evaluations++; return destination; },
  });
  assert.equal(result, false);
  assert.equal(evaluations, 1);
  assert.deepEqual(calls[0].slice(2), [destination, 0, 0]);
});
