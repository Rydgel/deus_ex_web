import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCRIPT_TAGGED_PROPERTIES,
  TAGGED_GC_ARCHIVE_STATE,
  serializeTaggedPropertiesGc,
} from '../src/runtime/script-tagged-properties.mjs';
import {
  createScriptPropertyMeasureArchive,
  PROPERTY_MEASURE_ARCHIVE,
} from '../src/runtime/script-property-measure-archive.mjs';

test('GC tagged-property walk follows native filters, defaults, tag order, and two helper calls', () => {
  const current = {
    Changed: 9,
    Same: 7,
    Transient: 4,
    Arrayed: [1, 0, 2],
    Obj: { identity: 'live' },
    NullObj: null,
    Booled: 2,
    FloatNaN: Number.NaN,
  };
  const defaults = {
    Changed: 1,
    Same: 7,
    Transient: 0,
    Arrayed: [1, 0, 0],
    Booled: 0,
    FloatNaN: 0,
  };
  const properties = [
    { name: 'Native', id: 1, className: 'IntProperty', flags: 0x1000, offset: 0, elementSize: 4 },
    { name: 'Changed', id: 2, className: 'IntProperty', flags: 0, offset: 4, elementSize: 4 },
    { name: 'Same', id: 2, className: 'IntProperty', flags: 0, offset: 8, elementSize: 4 },
    { name: 'Transient', id: 6, className: 'ByteProperty', flags: 0x2000, offset: 12, elementSize: 1 },
    { name: 'Arrayed', id: 7, className: 'ByteProperty', flags: 0, offset: 16, elementSize: 1, arrayDim: 3 },
    { name: 'Obj', id: 5, className: 'ObjectProperty', flags: 0, offset: 20, elementSize: 4 },
    { name: 'NullObj', id: 8, className: 'ObjectProperty', flags: 0, offset: 24, elementSize: 4 },
    { name: 'Booled', id: 3, className: 'BoolProperty', flags: 0, offset: 28, elementSize: 4, boolMask: 2 },
    { name: 'FloatNaN', id: 4, className: 'FloatProperty', flags: 0, offset: 32, elementSize: 4 },
  ];
  const events = [];
  const archive = {
    archiveState: { ...TAGGED_GC_ARCHIVE_STATE },
    mapObject(value) {
      events.push(['mapObject', value]);
      return value === current.Obj ? 13 : 0;
    },
    mapName(value) {
      events.push(['mapName', value]);
      return value === 'MappedName' ? 23 : 0;
    },
    objectReference(reference, context) {
      events.push(['object', context.phase ?? 'collector', reference.get()]);
      return this;
    },
    nameReference(reference, context) {
      events.push(['name', context.kind, reference.get()]);
      return this;
    },
    serializeRaw(reference, width, context) {
      events.push(['raw', context.phase, context.property.name, width, reference.get()]);
      return this;
    },
  };
  const result = serializeTaggedPropertiesGc(
    { children: properties },
    archive,
    current,
    { defaultBuffer: { data: defaults, size: 20, capacity: 20 } },
    {
      walkProperties: structure => structure.children,
      noneName: 'NoneEntry',
    },
  );

  assert.equal(SCRIPT_TAGGED_PROPERTIES.body, 0x10126730);
  assert.deepEqual(result.properties.map(entry => [entry.property.name, entry.index]), [
    ['Changed', 0], ['Transient', 0], ['Arrayed', 2], ['Obj', 0], ['Booled', 0],
  ]);
  assert.deepEqual(result.skipped.filter(entry => entry.reason === 'native').map(entry => entry.property.name), ['Native']);
  assert.deepEqual(result.skipped.filter(entry => entry.reason === 'identical').map(entry => entry.property.name), [
    'Same', 'Arrayed', 'Arrayed', 'NullObj', 'FloatNaN',
  ]);

  const tags = result.properties.map(entry => [entry.property.name, entry.tag.type, entry.tag.typeFlags, entry.tag.size, entry.tag.arrayIndex]);
  assert.deepEqual(tags, [
    ['Changed', 2, 0x22, 4, 0],
    ['Transient', 6, 0x06, 1, 0],
    ['Arrayed', 7, 0x87, 1, 2],
    ['Obj', 5, 0x25, 4, 0],
    ['Booled', 3, 0xd3, 0, 0],
  ]);
  assert.equal(SCRIPT_TAGGED_PROPERTIES.measureArchive.constructorBody, 0x10106b30);
  assert.equal(SCRIPT_TAGGED_PROPERTIES.measureArchive.vtable, PROPERTY_MEASURE_ARCHIVE.vtable);
  assert.deepEqual(events.filter(event => event[0] === 'name').map(event => event[2]), ['NoneEntry']);
  assert.deepEqual(events.filter(event => event[0] === 'object').map(event => event[2]), [current.Obj]);
  assert.deepEqual(events.filter(event => event[0] === 'raw').map(event => event.slice(1, 4)), [
    ['collector', 'Changed', 4],
    ['collector', 'Transient', 1],
    ['collector', 'Arrayed', 1],
  ]);
  assert.deepEqual(result.helperCalls.filter(call => call.kind === 'bool').map(call => call.phase), ['measure', 'collector']);

  const direct = createScriptPropertyMeasureArchive(archive);
  direct.serializeRaw({ value: 1 }, 2, { kind: 'raw-check' });
  direct.objectReference({ value: current.Obj }, { kind: 'object-check' });
  direct.nameReference({ value: 'MappedName' }, { kind: 'name-check' });
  direct.countBytes(12, 24, { kind: 'count-check' });
  assert.equal(direct.tell({ kind: 'tell-check' }), -1);
  assert.equal(direct.bytes, 10);
  assert.deepEqual(direct.operations.map(operation => operation.kind), [
    'raw', 'object', 'raw', 'name', 'raw', 'countBytes', 'tell',
  ]);
});

test('GC tagged-property size classes cover all generic measured counts through the native measure adapter', () => {
  const counts = [0, 1, 2, 3, 4, 5, 11, 12, 13, 15, 16, 17, 0xff, 0x100, 0x10000, 0x10001];
  const properties = counts.map((measuredBytes, index) => ({
    name: `Size${index}`,
    id: index + 1,
    className: 'MeasuredProperty',
    flags: 0,
    offset: index,
    elementSize: 1,
    identical: () => false,
    serializeItem(_property, archive) {
      if (archive.measure) archive.bytes = measuredBytes;
      return archive;
    },
  }));
  const archive = {
    archiveState: { ...TAGGED_GC_ARCHIVE_STATE },
    nameReference() { return this; },
  };
  const data = Object.fromEntries(properties.map(property => [property.name, 1]));
  const result = serializeTaggedPropertiesGc(
    { children: properties },
    archive,
    data,
    { defaultBuffer: { data: {}, size: 0, capacity: 0 } },
    {
      walkProperties: structure => structure.children,
      noneName: 0,
    },
  );
  const expectedClass = count => {
    if (count === 1) return 0x00;
    if (count === 2) return 0x10;
    if (count === 4) return 0x20;
    if (count === 0x0c) return 0x30;
    if (count === 0x10) return 0x40;
    if (count <= 0xff) return 0x50;
    if (count <= 0x10000) return 0x60;
    return 0x70;
  };
  assert.deepEqual(result.properties.map(entry => entry.tag.typeFlags), counts.map((count, index) =>
    ((index + 1) & 0xff) | expectedClass(count)));
});
