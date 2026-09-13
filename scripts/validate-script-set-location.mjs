/** Focused native 267 wrapper/dispatch validation. */
import assert from 'node:assert/strict';
import { execSetLocation } from '../src/runtime/script-set-location.mjs';
import { ScriptRuntime } from '../src/runtime/script-runtime.mjs';

const receiver = { name: 'SetLocation script actor' };
const level = { name: 'ULevel fixture' };
const actor = { name: 'native actor' };
const destination = [12.5, -4.25, 88];
const events = [];
const result = execSetLocation(receiver, destination, {
  levelFor: value => { events.push({ op: 'load-level', receiver: value }); return level; },
  actorFor: (value, linkedLevel) => {
    events.push({ op: 'resolve-actor', receiver: value, level: linkedLevel });
    return actor;
  },
  farMoveActor: (linkedLevel, linkedActor, location, test, noCheck) => {
    events.push({ op: 'FarMoveActor', level: linkedLevel, actor: linkedActor,
      location: location.slice(), test, noCheck });
    return true;
  },
});
assert.equal(result, true);
assert.deepEqual(events.map(event => event.op), ['load-level', 'resolve-actor', 'FarMoveActor']);
assert.deepEqual(events.at(-1), {
  op: 'FarMoveActor', level, actor, location: destination, test: 0, noCheck: 0,
});

let evaluations = 0;
const runtime = new ScriptRuntime({}, {
  levelFor: () => level,
  relocation: {
    actorFor: () => actor,
    farMoveActor: (linkedLevel, linkedActor, location, test, noCheck) => {
      assert.equal(linkedLevel, level);
      assert.equal(linkedActor, actor);
      assert.deepEqual(location, destination);
      assert.equal(test, 0);
      assert.equal(noCheck, 0);
      return false;
    },
  },
});
const dispatched = runtime.invokeNative({
  index: 267, receiver, argumentCount: 1,
  evaluateArgument: () => { evaluations++; return destination; },
});
assert.equal(dispatched, false);
assert.equal(evaluations, 1);
assert.throws(() => new ScriptRuntime({}, {levelFor: () => level}).invokeNative({
  index: 267, receiver, argumentCount: 1, evaluateArgument: () => destination,
}), /native actor identity/);
console.log('Native 267 Actor.SetLocation wrapper and explicit FarMoveActor adapter passed.');
