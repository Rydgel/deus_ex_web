import test from 'node:test';
import assert from 'node:assert/strict';
import {MapActorHost, isBackedHost, hostDelete, releasePendingTables, PENDING} from '../src/runtime/host-accessors.mjs';
import '../src/runtime/actor-pose-fields.mjs';
import '../src/runtime/actor-mirror-fields.mjs';
import '../src/runtime/actor-link-fields.mjs';
import '../src/runtime/actor-flag-words.mjs';

// docs/live-heap.md, "Actor hosts and mesh bindings": a MapActorHost keeps the values of its image-backed members in a pending table
// until an installer takes them (host-members.test.mjs runs the installers); these are the host's own behaviors.

const actor = {index: 3, name: 'Crate0', className: 'Crate', properties: null, nativeBytes: 5, stack: null};
const make = () => new MapActorHost(actor, {Tag: 'x'});

test('a MapActorHost has the decoded fields in order and the image-backed members as prototype accessors', () => {
  const host = make();
  assert.deepEqual(Object.keys(host), ['index', 'name', 'className', 'properties', 'values', 'nativeBytes', 'stack']);
  assert.equal(isBackedHost(host), true);
  assert.equal(isBackedHost({}), false);
  for (const member of ['position', 'rotation', 'oldLocation', 'radius', 'height', 'physics', 'velocity', 'standingCount', 'marker', 'base', 'touching',
    'flags', 'collisionBits', 'collideActors', 'blocking', 'actorFlags', 'static', 'movable', 'motionFlags']) {
    assert.equal(member in host, true, member);
    assert.equal(Object.hasOwn(host, member), false, member);
    assert.equal(host[member], undefined, `${member} is absent until set`);
  }
  assert.equal('pawnList' in host, false, 'the level target of the mirror installer is not a host member');
});

test('stores before an installer takes a member are the member\'s pending value; assignment and spread behave as for data properties', () => {
  const host = make();
  host.position = [1, 2, 3];
  Object.assign(host, {radius: 20, height: 30, base: null, touching: [null, null, null, null], flags: 5});
  assert.deepEqual(host.position, [1, 2, 3]);
  assert.equal(host.radius, 20);
  assert.equal(host.base, null);
  assert.deepEqual(Object.keys(host), ['index', 'name', 'className', 'properties', 'values', 'nativeBytes', 'stack'], 'not own properties');
  assert.deepEqual(Object.getOwnPropertySymbols(host), [PENDING]);
  assert.equal(Object.getOwnPropertyDescriptor(host, PENDING).enumerable, false);
  assert.equal(Object.keys({...host}).length, 7, 'a spread copies the own enumerable data only');
  // an ordinary data property is untouched
  host.lineage = ['engine.actor'];
  assert.deepEqual(Object.keys(host).slice(-1), ['lineage']);
});

test('hostDelete removes a pending value like delete removes a data property; releasePendingTables lets empty tables go', () => {
  const host = make(), other = make(), plain = {radius: 1};
  host.radius = 1; host.height = 2; other.radius = 3;
  hostDelete(host, 'radius');
  assert.equal(host.radius, undefined);
  assert.equal(host.height, 2);
  hostDelete(host, 'neverSet');
  hostDelete(plain, 'radius');
  assert.equal('radius' in plain, false);
  hostDelete(other, 'radius');
  releasePendingTables([host, other, plain, make()]);
  assert.notEqual(host[PENDING], undefined, 'a table that still holds a value stays');
  assert.equal(other[PENDING], undefined, 'an empty one is released');
  other.radius = 9;
  assert.equal(other.radius, 9, 'a store after the release makes it again');
});
