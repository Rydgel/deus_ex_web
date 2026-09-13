import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCRIPT_STATE_LINK,
  linkScriptState,
} from '../src/runtime/script-state-link.mjs';

function wordSlots(values = {}) {
  const slots = new Map();
  for (let index = 0; index < SCRIPT_STATE_LINK.offsets.hashBucketCount; index += 1) {
    const offset = SCRIPT_STATE_LINK.offsets.hashTable + index * 4;
    slots.set(offset, { value: values[index] ?? 0, width: 4 });
  }
  return slots;
}

test('UState::Link calls UStruct::Link, copies buckets, and hashes direct struct children', () => {
  const inherited = { nativeAddress: 0x5010, nameIndex: 3, kind: 'Function', isStruct: true };
  const parent = {
    nativeAddress: 0x4000,
    superClass: null,
    children: null,
    nativeSlots: wordSlots({ 3: inherited }),
  };
  inherited.outer = parent;
  const record = {
    nativeAddress: 0x3000,
    superClass: parent,
    nativeSlots: wordSlots(),
    children: null,
  };
  const laterProperty = { kind: 'IntProperty', isStruct: false, outer: record, next: inherited };
  const first = {
    kind: 'Function', isStruct: true, nameIndex: 0x103, outer: record,
    next: null, nativeSlots: new Map([[0x30, { value: null, width: 4 }]]),
  };
  const second = {
    kind: 'State', isStruct: true, nameIndex: 0x203, outer: record,
    next: laterProperty, nativeSlots: new Map([[0x30, { value: null, width: 4 }]]),
  };
  first.next = second;
  record.children = first;

  const calls = [];
  const result = linkScriptState(record, {
    archive: { marker: 'local-link-archive' },
    services: {
      linkStruct(receiver, archive, argument, detail) {
        calls.push([receiver, archive, argument, detail.body]);
        return 'linked-struct';
      },
    },
  });

  assert.deepEqual(calls, [[record, { marker: 'local-link-archive' }, 0, 0x10126060]]);
  assert.equal(result.structResult, 'linked-struct');
  assert.equal(result.super, parent);
  assert.deepEqual(result.linkedChildren, [first, second]);
  assert.equal(first.nativeSlots.get(0x30).value, inherited);
  assert.equal(second.nativeSlots.get(0x30).value, first);
  assert.equal(record.nativeSlots.get(0x84 + 3 * 4).value, second);
  assert.equal(result.hashBuckets[3], second);
  assert.equal(result.hashBuckets[4], 0);
  assert.deepEqual(result.probeMaskWrites, []);
  assert.deepEqual(result.metadataWrites, []);
  assert.deepEqual(result.operations.slice(0, 2).map(operation => operation.operation), [
    'struct-link', 'copy-state-hash-table',
  ]);
  assert.equal(result.operations.at(-1).operation, 'stop-non-direct-child');
});

test('UState::Link composes the inherited UStruct::Link by default and fails when its slot bindings are absent', () => {
  const record = { superClass: null, children: null, hashBuckets: new Array(256).fill(null) };
  assert.throws(
    () => linkScriptState(record, { archive: {} }),
    /UStruct::Link has no binding for \+0x38/,
  );
});
