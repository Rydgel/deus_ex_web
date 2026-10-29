import test from 'node:test';
import assert from 'node:assert/strict';
import {internEntries} from '../src/runtime/host-accessors.mjs';

test('internEntries gives one frozen array to equal lists, holes included', () => {
  const a = {}, b = {}, c = {};
  const first = internEntries([a, , c]);
  assert.equal(internEntries([a, undefined, c]), first, 'a hole and undefined are the same');
  assert.equal(Object.isFrozen(first), true);
  assert.equal(first.length, 3);
  assert.equal(first[1], undefined);
  assert.notEqual(internEntries([a, b, c]), first);
  assert.notEqual(internEntries([a, c]), first);
  assert.notEqual(internEntries([a, , c, undefined]), first, 'a different length is a different list');
  assert.equal(internEntries([a, , c, undefined]).length, 4);
  assert.equal(internEntries([]), internEntries([]));
  // the list given is not kept: a caller that goes on filling its own array does not change the shared one
  const mine = [a];
  const shared = internEntries(mine);
  mine[1] = b;
  assert.equal(shared.length, 1);
});
