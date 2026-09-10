import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GC_ARCHIVE_STATE,
  OBJECT_SERIALIZATION_FLAGS,
  serializeGcObject,
} from '../src/runtime/script-object-serialization.mjs';

const slot = (object, key) => ({
  get: () => object[key],
  set: value => { object[key] = value; return value; },
});

test('GC UObject Serialize preserves native header/frame/property order and code offset round-trip', () => {
  const outer = {kind: 'outer'};
  const klass = {kind: 'class'};
  const linker = {kind: 'linker'};
  const node = {kind: 'node'};
  const state = {kind: 'state'};
  const object = {
    flags: OBJECT_SERIALIZATION_FLAGS.StateFrame,
    name: {kind: 'name'}, outer, klass, linker,
    stateFrame: {
      node, state, probeMask: [0x12, 0x34], latentAction: 9, codePointer: 104,
    },
  };
  const events = [];
  const archive = {
    archiveState: GC_ARCHIVE_STATE,
    nameReference: (ref, context) => events.push(['name', context.key, ref.get()]),
    objectReference: (ref, context) => events.push(['object', context.key, ref.get()]),
    serializeRaw: (ref, size, context) => events.push(['raw', context.key, size, ref.get()]),
    countBytes: (first, second) => events.push(['count', first, second]),
  };
  const result = serializeGcObject(object, archive, {
    layout: {
      flags: slot(object, 'flags'),
      name: slot(object, 'name'), outer: slot(object, 'outer'),
      class: slot(object, 'klass'), linker: slot(object, 'linker'),
      stateFrame: slot(object, 'stateFrame'),
    },
    frameLayout: {
      node: slot(object.stateFrame, 'node'), state: slot(object.stateFrame, 'state'),
      probeMask: slot(object.stateFrame, 'probeMask'),
      latentAction: slot(object.stateFrame, 'latentAction'),
      codePointer: slot(object.stateFrame, 'codePointer'),
    },
    nodeCodeRange: () => ({start: 100, size: 20}),
    serializeProperties: () => { events.push(['properties']); },
    getPropertiesSize: () => 12,
    isCoreClassObject: false,
  });

  assert.deepEqual(events, [
    ['name', 'header.name', object.name],
    ['object', 'header.outer', outer],
    ['object', 'header.class', klass],
    ['object', 'header.linker', linker],
    ['object', 'stateFrame.node', node],
    ['object', 'stateFrame.state', state],
    ['raw', 'stateFrame.probeMask', 8, object.stateFrame.probeMask],
    ['raw', 'stateFrame.latentAction', 4, 9],
    ['raw', 'stateFrame.codeOffset', 4, 4],
    ['properties'],
    ['count', 12, 12],
  ]);
  assert.equal(object.flags & OBJECT_SERIALIZATION_FLAGS.SerializeRoute, OBJECT_SERIALIZATION_FLAGS.SerializeRoute);
  assert.equal(object.stateFrame.codePointer, 104);
  assert.deepEqual(result.archiveState, GC_ARCHIVE_STATE);
  assert.equal(result.routeMarker, true);
  assert.equal(result.references, 6);
  assert.equal(result.nameReferences, 1);
});

test('GC path rejects non-collector archive branches and omits Core.Class SerializeBin', () => {
  const object = {flags: 0, name: {}, outer: null, klass: {}, linker: null};
  const archive = {
    nameReference() {}, objectReference() {},
  };
  const layout = {
    flags: slot(object, 'flags'), name: slot(object, 'name'), outer: slot(object, 'outer'),
    class: slot(object, 'klass'), linker: slot(object, 'linker'),
  };
  assert.throws(() => serializeGcObject(object, archive, {
    layout, archiveState: {...GC_ARCHIVE_STATE, ar18: 1}, isCoreClassObject: true,
  }), /FArchive ar18/);
  const result = serializeGcObject(object, archive, {
    layout, isCoreClassObject: true, getPropertiesSize: () => 0,
  });
  assert.equal(result.specialClass, true);
  assert.equal(result.properties.skipped, true);
  assert.equal(result.size, 0);
});

test('GC path frees a stale unflagged frame and clears code when the post-archive Node is null', () => {
  const archive = {nameReference() {}, objectReference() {}, serializeRaw() {}};
  const node = {kind: 'node'};
  const makeObject = (flags, frame) => {
    const object = {flags, name: {}, outer: null, klass: {}, linker: null, stateFrame: frame};
    return {object, layout: {
      flags: slot(object, 'flags'), name: slot(object, 'name'), outer: slot(object, 'outer'),
      class: slot(object, 'klass'), linker: slot(object, 'linker'), stateFrame: slot(object, 'stateFrame'),
    }};
  };
  const stale = {node: null, state: null, probeMask: [0, 0], latentAction: 0, codePointer: 77};
  const unflagged = makeObject(0, stale);
  const freed = [];
  serializeGcObject(unflagged.object, archive, {
    layout: unflagged.layout, isCoreClassObject: false, getPropertiesSize: () => 0,
    serializeProperties: () => {}, freeStateFrame: frame => freed.push(frame),
  });
  assert.deepEqual(freed, [stale]);
  assert.equal(unflagged.object.stateFrame, null);

  const flagged = makeObject(OBJECT_SERIALIZATION_FLAGS.StateFrame, {...stale});
  serializeGcObject(flagged.object, archive, {
    layout: flagged.layout,
    frameLayout: {
      node: slot(flagged.object.stateFrame, 'node'), state: slot(flagged.object.stateFrame, 'state'),
      probeMask: slot(flagged.object.stateFrame, 'probeMask'),
      latentAction: slot(flagged.object.stateFrame, 'latentAction'),
      codePointer: slot(flagged.object.stateFrame, 'codePointer'),
    },
    isCoreClassObject: false, getPropertiesSize: () => 0, serializeProperties: () => {},
  });
  assert.equal(flagged.object.stateFrame.codePointer, null);

  const outsideFrame = {...stale, node, codePointer: 80};
  const outside = makeObject(OBJECT_SERIALIZATION_FLAGS.StateFrame, outsideFrame);
  const warnings = [];
  serializeGcObject(outside.object, archive, {
    layout: outside.layout,
    frameLayout: {
      node: slot(outside.object.stateFrame, 'node'), state: slot(outside.object.stateFrame, 'state'),
      probeMask: slot(outside.object.stateFrame, 'probeMask'),
      latentAction: slot(outside.object.stateFrame, 'latentAction'),
      codePointer: slot(outside.object.stateFrame, 'codePointer'),
    },
    nodeCodeRange: () => ({start: 100, size: 20}), onCodeOffsetWarning: info => warnings.push(info),
    isCoreClassObject: false, getPropertiesSize: () => 0, serializeProperties: () => {},
  });
  assert.equal(outside.object.stateFrame.codePointer, 80);
  assert.equal(warnings.length, 1);
});
