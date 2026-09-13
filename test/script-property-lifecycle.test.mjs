import test from 'node:test';
import assert from 'node:assert/strict';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';

test('ExitProperties destroys owning struct members while preserving numeric/object fields and inline arrays', () => {
  const member = (name, kind, type, flags = 0) => ({key: `fixture.record.${name}`, name, kind,
    metadata: {type, flags, arrayDim: 1, elementSize: type === 'string' ? 12 : 4}});
  const title = member('title', 'StrProperty', 'string', 0x400000);
  const labels = {...member('labels', 'StrProperty', 'string', 0x400000)};
  labels.metadata = {...labels.metadata, arrayDim: 2};
  const amount = member('amount', 'IntProperty', 'int');
  const target = member('target', 'ObjectProperty', 'object');
  const field = {key: 'fixture.actor.records', kind: 'StructProperty', metadata: {
    type: 'struct', flags: 0x400000, arrayDim: 2, elementSize: null,
    structKey: 'fixture.record', structFields: [title, labels, amount, target],
  }};
  const captions = {key: 'fixture.actor.captions', kind: 'StrProperty', metadata: {
    type: 'string', flags: 0x400000, arrayDim: 2, elementSize: null,
  }};
  const receiver = {}, object = {}, runtime = new ScriptRuntime({});
  const values = ['first', 'second'].map((text, index) => ({[title.key]: text,
    [labels.key]: ['left', 'right'], [amount.key]: index + 37, [target.key]: object}));
  const captionValues = ['above', 'below'];
  const slots = new Map([[field.key, values], [captions.key, captionValues], ['untouched', 'ordinary property']]);
  runtime.instances.set(receiver, {cls: {destructorLink: [field, captions]}, slots, bindings: new Map()});
  runtime.exitProperties(receiver);
  assert.deepEqual(slots.get(field.key).map(value => value[title.key]), ['', '']);
  assert.deepEqual(slots.get(field.key).map(value => value[amount.key]), [37, 38]);
  assert.deepEqual(slots.get(field.key).map(value => value[labels.key]), [['', ''], ['', '']]);
  assert.deepEqual(slots.get(captions.key), ['', '']);
  for (const value of slots.get(field.key)) assert.equal(value[target.key], object);
  assert.equal(slots.get('untouched'), 'ordinary property');
  assert.deepEqual(values.map(value => value[title.key]), ['first', 'second']);
  assert.deepEqual(values.map(value => value[labels.key]), [['left', 'right'], ['left', 'right']]);
  assert.deepEqual(captionValues, ['above', 'below']);
});
