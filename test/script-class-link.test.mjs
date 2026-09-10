import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLASS_LINK_ARCHIVE_STATE,
  SCRIPT_CLASS_LINK,
  linkScriptClass,
} from '../src/runtime/script-class-link.mjs';

const fieldClass = { address: SCRIPT_CLASS_LINK.identities.fieldClass, superClass: null };
const propertyClass = { address: SCRIPT_CLASS_LINK.identities.propertyClass, superClass: fieldClass };
const functionClass = { address: SCRIPT_CLASS_LINK.identities.functionClass, superClass: fieldClass };

function property(owner, name, { next = null, arrayDim = 1 } = {}) {
  return {
    name,
    classIdentity: propertyClass,
    ownerClass: owner,
    outer: owner,
    propertyFlags: SCRIPT_CLASS_LINK.flags.netProperty,
    arrayDim,
    next,
  };
}

function localArchive() {
  return { ...CLASS_LINK_ARCHIVE_STATE };
}

test('UClass::Link calls UState::Link, copies superclass reps, and links direct net properties', () => {
  const parent = { superClass: null, classReps: [{ field: { name: 'Inherited' }, index: 3 }], children: null };
  const record = { superClass: parent, children: null, classReps: [], netFields: [], globalLinkGate: 0 };
  const direct = property(record, 'Direct', { arrayDim: 2 });
  record.children = direct;
  const calls = [];
  const result = linkScriptClass(record, {
    archive: localArchive(),
    services: {
      linkState(receiver, archive, argument, detail) {
        calls.push(['state', receiver, archive, argument, detail.body]);
      },
    },
  });

  assert.equal(result.skipped, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'state');
  assert.equal(calls[0][2].vtable, CLASS_LINK_ARCHIVE_STATE.vtable);
  assert.equal(calls[0][3], 0);
  assert.equal(calls[0][4], SCRIPT_CLASS_LINK.uState.linkBody);
  assert.deepEqual(result.classReps, [
    { field: { name: 'Inherited' }, index: 3 },
    { field: direct, index: 0 },
    { field: direct, index: 1 },
  ]);
  assert.deepEqual(result.netFields, [direct]);
  assert.equal(direct.repIndex, 1);
  assert.deepEqual(record.classReps, result.classReps);
  assert.deepEqual(record.netFields, result.netFields);
  assert.deepEqual(result.operations.map(operation => operation.operation).slice(0, 4), [
    'state-link', 'link-gate', 'empty-array', 'reserve-array',
  ]);
  assert.equal(result.operations.some(operation => operation.operation === 'copy-class-rep'), true);
  assert.equal(result.operations.at(-1).operation, 'sort-net-fields');
  assert.equal(result.operations.find(operation => operation.operation === 'grow-array' &&
    operation.offset === 0x4b0).capacity, 33);
});

test('UClass::Link reaches the UFunction special branch and sorts with the recovered helper', () => {
  const record = { superClass: null, classReps: [], netFields: [], globalLinkGate: 0 };
  const fn = {
    name: 'Special',
    classIdentity: functionClass,
    ownerClass: record,
    outer: record,
    super: null,
    specialFlags: SCRIPT_CLASS_LINK.flags.specialFunction,
    next: null,
    linker: {}, linkerIndex: 1,
  };
  const direct = property(record, 'Direct', { next: fn });
  direct.linker = {}; direct.linkerIndex = 2;
  record.children = direct;
  const result = linkScriptClass(record, {
    archive: localArchive(),
    services: {
      linkState() {},
    },
  });

  assert.deepEqual(result.netFields, [fn, direct]);
  assert.equal(result.operations.at(-1).body, SCRIPT_CLASS_LINK.helpers.sortNetFields.body);
  assert.deepEqual(result.operations.filter(operation => operation.operation === 'append-special-function').length, 1);
});

test('UClass::Link reads the link gate after UState::Link and skips class arrays', () => {
  const record = { superClass: null, children: null, classReps: [{ field: 1, index: 0 }], netFields: [{ field: 2 }], globalLinkGate: 0 };
  const calls = [];
  const result = linkScriptClass(record, {
    archive: localArchive(),
    services: {
      linkState() { calls.push('state'); record.globalLinkGate = 1; },
    },
  });
  assert.deepEqual(calls, ['state']);
  assert.equal(result.skipped, true);
  assert.equal(result.globalLinkGate, 1);
  assert.deepEqual(record.classReps, [{ field: 1, index: 0 }]);
  assert.deepEqual(record.netFields, [{ field: 2 }]);
});
