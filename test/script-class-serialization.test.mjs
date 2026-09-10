import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCRIPT_CLASS_GC_ARCHIVE_STATE,
  SCRIPT_CLASS_SERIALIZE,
  serializeUClass,
} from '../src/runtime/script-class-serialization.mjs';

test('UClass GC serialization preserves Core metadata chain and helper order', () => {
  const baseField = { kind: 'base-field' };
  const next = { kind: 'next' };
  const scriptText = { kind: 'script-text' };
  const children = { kind: 'children' };
  const within = { kind: 'within' };
  const dependencyClass = { kind: 'dependency-class' };
  const names = {
    friendly: { kind: 'friendly' },
    config: { kind: 'config' },
    import: { kind: 'import' },
  };
  const object = {
    baseField, next, scriptText, children,
    friendlyName: names.friendly, line: 10, textPosition: 20, scriptSize: 2,
    probeMask: [1, 2], ignoreMask: [3, 4], labelTableOffset: 5, stateFlags: 6,
    classFlags: 7, guid: [8, 9, 10, 11],
    dependencies: [{ class: dependencyClass, deep: 12, scriptTextCRC: 13 }],
    packageImports: [names.import], classWithin: within, classConfigName: names.config,
    linker: null, defaults: { data: new Uint8Array([1, 2, 3, 4]), size: 4, capacity: 8 },
  };
  const events = [];
  const archive = {
    archiveState: { ...SCRIPT_CLASS_GC_ARCHIVE_STATE },
    objectReference(reference, context) {
      events.push(['object', context.key, reference.get()]);
    },
    nameReference(reference, context) {
      events.push(['name', context.key, reference.get()]);
    },
    serializeRaw(reference, size, context) {
      events.push(['raw', context.key, size, reference.get()]);
    },
    countBytes(first, second, context) {
      events.push(['count', context.key, first, second]);
    },
  };
  const returned = serializeUClass(object, archive, {
    serializeUObject() { events.push(['base']); },
    serializeExpr(current, offsetReference) {
      events.push(['expr', offsetReference.get()]);
      offsetReference.set(offsetReference.get() + 1);
    },
    serializeTaggedProperties(currentArchive, data, currentBaseField) {
      events.push(['tagged', currentArchive, data, currentBaseField]);
    },
    getPropertiesSize() {
      events.push(['size']);
      return 4;
    },
    serializeBin(currentArchive, data) {
      events.push(['bin', currentArchive, data]);
    },
  });

  assert.deepEqual(events.map(event => event[0]), [
    'base', 'object', 'object', 'object', 'object', 'name',
    'raw', 'raw', 'raw', 'expr', 'expr',
    'raw', 'raw', 'raw', 'raw', 'raw', 'raw', 'raw', 'raw', 'raw',
    'count', 'raw', 'object', 'raw', 'raw',
    'count', 'raw', 'name', 'object', 'name',
    'tagged', 'size', 'count', 'bin',
  ]);
  assert.equal(returned.kind, 'UClass');
  assert.equal(returned.dependencies.entries[0].class, dependencyClass);
  assert.deepEqual(returned.guid, [8, 9, 10, 11]);
  assert.equal(returned.defaults.size, 4);
  assert.equal(returned.events.at(-1).kind, 'serialize-bin');
  assert.equal(SCRIPT_CLASS_SERIALIZE.uClass.body, 0x101280d0);
});

test('metadata GC serializers reject a non-collector archive and missing reached helpers', () => {
  const archive = {
    archiveState: { ...SCRIPT_CLASS_GC_ARCHIVE_STATE, ar0c: 1 },
    objectReference() {}, nameReference() {},
  };
  assert.throws(() => serializeUClass({}, archive), /FArchive ar0c/);

  const object = {
    baseField: null, next: null, scriptText: null, children: null,
    friendlyName: {}, line: 0, textPosition: 0, scriptSize: 1,
    probeMask: [0, 0], ignoreMask: [0, 0], labelTableOffset: 0, stateFlags: 0,
    classFlags: 0, guid: [0, 0, 0, 0], dependencies: [], packageImports: [],
    classWithin: null, classConfigName: {}, linker: null,
    defaults: { data: null, size: 0, capacity: 0 },
  };
  const validArchive = {
    archiveState: { ...SCRIPT_CLASS_GC_ARCHIVE_STATE },
    objectReference() {}, nameReference() {},
  };
  assert.throws(() => serializeUClass(object, validArchive, {
    serializeUObject() {}, getPropertiesSize: () => 0,
    serializeTaggedProperties() {}, serializeBin() {},
  }), /SerializeExpr/);
});
