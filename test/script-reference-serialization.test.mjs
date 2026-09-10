import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REFERENCE_PROPERTY_FLAGS,
  STATE_FRAME_FLAG,
  UnsupportedScriptReferenceSerializationError,
  serializeObjectHeaderReferences,
  serializeScriptReferences,
} from '../src/runtime/script-reference-serialization.mjs';

const field = (key, type, extra = {}) => ({ key, metadata: { type, arrayDim: 1, ...extra } });
const lvalue = (storage, key) => ({
  reference: true,
  key,
  get: () => storage.get(key),
  set: value => { storage.set(key, value); return value; },
});

test('typed archive walk preserves property order, ArrayDim order, and nested PointRegion references', () => {
  const owner = { name: 'Owner' }, first = { name: 'First' }, second = { name: 'Second' };
  const zone = { name: 'ZoneInfo' };
  const region = field('engine.actor.region', 'struct', {
    structKey: 'engine.actor.pointregion',
    structFields: [
      field('engine.actor.pointregion.zone', 'object', { flags: REFERENCE_PROPERTY_FLAGS.Transient }),
      field('engine.actor.pointregion.ileaf', 'int'),
      field('engine.actor.pointregion.zonenumber', 'byte'),
    ],
  });
  const fields = [
    field('engine.actor.owner', 'object'),
    field('engine.actor.touching', 'object', { arrayDim: 2 }),
    region,
    field('engine.actor.transientref', 'object', { flags: REFERENCE_PROPERTY_FLAGS.Transient }),
    field('engine.actor.skipref', 'object', { flags: REFERENCE_PROPERTY_FLAGS.SkipSerialization }),
    field('engine.actor.location', 'struct', { structKey: 'core.object.vector' }),
  ];
  const storage = new Map([
    ['engine.actor.owner', owner],
    ['engine.actor.touching', [first, second]],
    ['engine.actor.region', {
      'engine.actor.pointregion.zone': zone,
      'engine.actor.pointregion.ileaf': 11,
      'engine.actor.pointregion.zonenumber': 3,
    }],
    ['engine.actor.transientref', { name: 'Transient' }],
    ['engine.actor.skipref', { name: 'Skipped' }],
    ['engine.actor.location', [1, 2, 3]],
  ]);
  const seen = [], preloaded = [];
  const archive = {
    objectReference(ref, context) { seen.push([context.key, ref.get()]); },
    preloadStruct(metadata, context) { preloaded.push([metadata.structKey, context.key]); },
  };

  const result = serializeScriptReferences(fields, current => lvalue(storage, current.key), archive);
  assert.deepEqual(seen, [
    ['engine.actor.owner', owner],
    ['engine.actor.touching[0]', first],
    ['engine.actor.touching[1]', second],
    ['engine.actor.pointregion.zone', zone],
    ['engine.actor.transientref', storage.get('engine.actor.transientref')],
  ]);
  assert.deepEqual(preloaded, [['engine.actor.pointregion', 'engine.actor.region']]);
  assert.deepEqual(result, { references: 5, fields: 5, skipped: 1 });

  seen.length = 0;
  const persistent = serializeScriptReferences(fields, current => lvalue(storage, current.key), archive, { persistent: true });
  assert.deepEqual(seen.map(([key]) => key), [
    'engine.actor.owner', 'engine.actor.touching[0]', 'engine.actor.touching[1]',
  ]);
  assert.equal(persistent.skipped, 2);
});

test('UFixedArrayProperty-style inner metadata walks fixed elements and dynamic arrays stay explicit', () => {
  const a = { name: 'A' }, b = { name: 'B' };
  const fixed = field('engine.actor.targets', 'fixedArray', {
    fixedArraySize: 2,
    innerMetadata: { type: 'class', arrayDim: 1 },
  });
  const storage = new Map([['engine.actor.targets', [a, b]]]);
  const seen = [];
  const archive = { objectReference: (ref, context) => seen.push([context.key, ref.get()]) };
  const result = serializeScriptReferences([fixed], current => lvalue(storage, current.key), archive);
  assert.equal(result.references, 2);
  assert.deepEqual(seen, [['engine.actor.targets[0]', a], ['engine.actor.targets[1]', b]]);

  const dynamic = field('engine.actor.inventory', 'array', { innerMetadata: { type: 'object' } });
  assert.throws(
    () => serializeScriptReferences([dynamic], current => lvalue(storage, current.key), archive),
    error => error instanceof UnsupportedScriptReferenceSerializationError && error.type === 'array',
  );
  const hooked = [];
  const handled = serializeScriptReferences([dynamic], current => lvalue(storage, current.key), archive, {
    serializeProperty: (current, ref, context) => { hooked.push([current.key, context.operation, ref.get()]); return 0; },
  });
  assert.equal(handled.references, 0);
  assert.deepEqual(hooked, [['engine.actor.inventory', 'array', undefined]]);
});

test('UObject header archive reaches Outer/Class/Linker and FStateFrame Node/State in collector state', () => {
  const outer = { name: 'Outer' }, klass = { name: 'Class' }, linker = { name: 'Linker' };
  const node = { name: 'Node' }, state = { name: 'State' };
  const object = {
    key: 'engine.cameraPoint',
    name: 'CameraPoint',
    outer,
    classRecord: klass,
    linker,
    objectFlags: STATE_FRAME_FLAG,
    stateFrame: { node, state },
  };
  const seen = [], names = [];
  const archive = {
    nameReference: (ref, context) => names.push([context.key, ref.get()]),
    objectReference: (ref, context) => seen.push([context.key, ref.get()]),
  };
  const result = serializeObjectHeaderReferences(object, archive, { archiveState: { ar0c: 0, ar10: 0, ar14: 0, ar18: 0 } });
  assert.deepEqual(seen, [
    ['header.outer', outer], ['header.class', klass], ['header.linker', linker],
    ['stateFrame.node', node], ['stateFrame.state', state],
  ]);
  assert.deepEqual(names, [['header.name', 'CameraPoint']]);
  assert.deepEqual(result, { references: 5, identity: true, linker: true, stateFrame: true });

  seen.length = 0;
  const nonCollector = serializeObjectHeaderReferences(object, archive, {
    archiveState: { ar0c: 1, ar10: 0, ar14: 1, ar18: 0 },
  });
  assert.deepEqual(seen.map(([key]) => key), ['header.outer', 'header.class']);
  assert.deepEqual(nonCollector, { references: 2, identity: true, linker: false, stateFrame: false });
});
