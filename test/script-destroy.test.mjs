import test from 'node:test';
import assert from 'node:assert/strict';
import {destroyScriptActor} from '../src/runtime/script-destroy.mjs';

const actor = (id, extra = {}) => ({
  id,
  bStatic: false,
  bNoDelete: false,
  bDeleteMe: false,
  Role: 4,
  bNetTemporary: false,
  bCollideActors: false,
  Base: null,
  Owner: null,
  Touching: [null, null, null, null],
  StandingCount: 0,
  Deleted: null,
  ...extra,
});

function fixture(targetExtra = {}) {
  const target = actor('target', targetExtra);
  const level = {
    actors: [target],
    pendingDeleted: null,
    engine: {audio: null},
    collisionHash: null,
  };
  const calls = [];
  const options = {
    levelFor: () => level,
    read: (receiver, property) => receiver[property],
    write: (receiver, property, value) => {
      receiver[property] = value;
    },
    processEvent: (receiver, name) => calls.push(`event:${receiver.id}:${name}`),
    isProbing: () => false,
    validate: () => true,
    modify: receiver => calls.push(`modify:${receiver.id}`),
    conditionalDestroy: receiver => calls.push(`conditional:${receiver.id}`),
  };
  return {target, level, calls, options};
}

test('DestroyActor applies play gates before looking up the live actor slot', () => {
  for (const [extra, expected] of [
    [{bStatic: true}, false],
    [{bNoDelete: true}, false],
    [{Role: 3}, false],
    [{Role: 3, bNetTemporary: true}, true],
  ]) {
    const {target, calls, options} = fixture(extra);
    assert.equal(destroyScriptActor(target, options), expected);
    assert.equal(calls.some(call => call.startsWith('modify:')), expected);
  }

  const repeated = fixture({bDeleteMe: true});
  repeated.level.actors[0] = null;
  assert.equal(destroyScriptActor(repeated.target, repeated.options), true);
  assert.deepEqual(repeated.calls, []);

  const forced = fixture({Role: 3});
  assert.equal(destroyScriptActor(forced.target, forced.options, true), true);
});

test('DestroyActor preserves callback order, live combined relationship scan, and reentrant return', () => {
  const owner = actor('owner');
  const other = actor('other');
  const child = actor('child', {Owner: null});
  const {target, level, calls, options} = fixture({Owner: owner, bCollideActors: true});
  child.Owner = target;
  other.Touching[0] = target;
  level.actors = [target, other, child, owner];
  level.collisionHash = {
    removeActor: receiver => calls.push(`hash:remove:${receiver.id}`),
    checkActorNotReferenced: receiver => calls.push(`hash:check:${receiver.id}`),
  };
  level.engine.audio = {
    noteDestroy: receiver => {
      assert.equal(level.actors[0], null);
      assert.equal(receiver.bDeleteMe, true);
      calls.push(`audio:${receiver.id}`);
    },
  };
  options.isProbing = () => true;
  options.setOwner = (receiver, next) => {
    calls.push(`setOwner:${receiver.id}`);
    receiver.Owner = next;
  };
  options.endTouch = (receiver, otherActor, force) => {
    assert.equal(force, 1);
    calls.push(`endTouch:${otherActor.id}`);
    otherActor.Touching[0] = null;
  };
  options.processEvent = (receiver, name) => calls.push(`event:${receiver.id}:${name}`);

  assert.equal(destroyScriptActor(target, options), true);
  assert.deepEqual(calls, [
    'modify:target',
    'event:target:EndState',
    'hash:remove:target',
    'hash:check:target',
    'event:target:Destroyed',
    'endTouch:other',
    'setOwner:child',
    'event:owner:LostChild',
    'audio:target',
    'conditional:target',
  ]);
  assert.equal(level.actors[0], null);
  assert.equal(target.bDeleteMe, true);
  assert.equal(target.Deleted, null);
  assert.equal(level.pendingDeleted, target);
  assert.equal(child.Owner, null);

  const reentrant = fixture();
  reentrant.options.processEvent = (receiver, name) => {
    reentrant.calls.push(`event:${receiver.id}:${name}`);
    if (name === 'Destroyed') receiver.bDeleteMe = true;
  };
  assert.equal(destroyScriptActor(reentrant.target, reentrant.options), true);
  assert.equal(reentrant.level.actors[0], reentrant.target);
  assert.equal(reentrant.level.pendingDeleted, null);
  assert.deepEqual(reentrant.calls, ['modify:target', 'event:target:Destroyed']);
});
