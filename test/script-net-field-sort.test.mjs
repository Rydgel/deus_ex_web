import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCRIPT_NET_FIELD_SORT,
  sortScriptNetFields,
} from '../src/runtime/script-net-field-sort.mjs';

function byKey(left, right) {
  return (left.key - right.key) | 0;
}

test('GOTY net-field sort preserves native mixed/equal-key partition order', () => {
  const data = [5, 3, 5, 2, 5, 1, 5, 4, 5]
    .map((key, id) => ({ key, id }));
  const original = data;

  const result = sortScriptNetFields(data, { comparator: byKey });

  assert.equal(result, original);
  assert.deepEqual(data.map(item => `${item.key}:${item.id}`), [
    '1:5', '2:3', '3:1', '4:7',
    '5:0', '5:6', '5:2', '5:4', '5:8',
  ]);
});

test('GOTY net-field sort honors an explicit count and leaves the tail alone', () => {
  const data = [
    { key: 4, id: 0 },
    { key: 1, id: 1 },
    { key: 3, id: 2 },
    { key: 2, id: 3 },
    { key: 99, id: 'tail' },
  ];

  sortScriptNetFields(data, { comparator: byKey, count: 4 });

  assert.deepEqual(data.map(item => item.key), [1, 2, 3, 4, 99]);
  assert.equal(data[4].id, 'tail');
});

test('small ranges use the native selection path without comparator calls for one item', () => {
  const data = [{ key: 7, id: 0 }];
  let calls = 0;

  assert.equal(
    sortScriptNetFields(data, { comparator: () => { calls += 1; return 0; } }),
    data,
  );
  assert.equal(calls, 0);
  assert.equal(SCRIPT_NET_FIELD_SORT.body, 0x1012b690);
});
