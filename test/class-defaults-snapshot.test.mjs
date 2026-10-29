import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultsSnapshot} from '../src/runtime/class-defaults-snapshot.mjs';

// Live-heap step 5 (docs/live-heap.md "Step 5's results"): objects attached while a class's defaults are unchanged share one copy.

const values = (...pairs) => new Map(pairs);
const classWith = entries => ({defaults: new Map(entries)});

test('objects attached to an unchanged class share one snapshot with its entries', () => {
  const cls = classWith([['a', values([0, 1])], ['b', values([0, 'x'])]]);
  const first = defaultsSnapshot(cls), second = defaultsSnapshot(cls);
  assert.equal(first, second);
  assert.notEqual(first, cls.defaults, 'the snapshot is a copy of the class\'s Map');
  assert.deepEqual([...first.keys()], ['a', 'b']);
  for (const [key, value] of cls.defaults) assert.equal(first.get(key), value);
});

test('a default replaced after a snapshot leaves it as it was and starts a new one', () => {
  const cls = classWith([['a', values([0, 1])], ['b', values([0, 2])]]);
  const before = defaultsSnapshot(cls), oldA = before.get('a');
  cls.defaults.set('a', values([0, 99]));
  const after = defaultsSnapshot(cls);
  assert.notEqual(after, before);
  assert.equal(before.get('a'), oldA, 'the earlier snapshot keeps the earlier entry');
  assert.equal(after.get('a'), cls.defaults.get('a'));
  assert.equal(defaultsSnapshot(cls), after, 'and the new one is shared in turn');
});

test('an added or removed entry starts a new snapshot; classes never share one', () => {
  const cls = classWith([['a', values([0, 1])]]), other = classWith([['a', cls.defaults.get('a')]]);
  const before = defaultsSnapshot(cls);
  assert.notEqual(defaultsSnapshot(other), before);
  cls.defaults.set('b', values([0, 2]));
  const grown = defaultsSnapshot(cls);
  assert.notEqual(grown, before);
  assert.equal(grown.size, 2);
  cls.defaults.delete('a');
  const shrunk = defaultsSnapshot(cls);
  assert.notEqual(shrunk, grown);
  assert.deepEqual([...shrunk.keys()], ['b']);
});
