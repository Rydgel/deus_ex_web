import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UnsupportedScriptContextResultError,
  prepareContextResults,
  zeroContextResult,
} from '../src/runtime/script-context-results.mjs';

const asset = { name: 'Fixture', pkg: {}, bytes: new Uint8Array() };
const field = (index, type, extra = {}) => ({
  key: `fixture.field${index}`,
  kind: `${type[0].toUpperCase()}${type.slice(1)}Property`,
  asset,
  index,
  metadata: { type, arrayDim: 1, ...extra },
});

test('prepares fixed scalar, bool-wrapper, and canonical struct Context results', async () => {
  const fields = new Map([
    [1, field(1, 'object', { propertyClassRef: 9 })],
    [2, field(2, 'byte')],
    [3, field(3, 'bool')],
    [4, field(4, 'struct', { structKey: 'Core.Object.Vector' })],
    [5, field(5, 'string')],
  ]);
  const runtime = { objects: { reference: (_script, index) => fields.get(index) }, field: async record => record };
  const byteValue = { op: 0x01, fieldIndex: 2 };
  const boolValue = { op: 0x2d, value: { op: 0x01, fieldIndex: 3 } };
  const vectorValue = { op: 0x36, fieldIndex: 4, value: { op: 0x17 } };
  const stringValue = { op: 0x01, fieldIndex: 5 };
  const decoded = { expressions: new Map([
    [10, { op: 0x19, offset: 10, context: { op: 0x01, fieldIndex: 1 }, value: byteValue, valueSize: 1 }],
    [20, { op: 0x19, offset: 20, context: { op: 0x01, fieldIndex: 1 }, value: boolValue, valueSize: 4 }],
    [30, { op: 0x19, offset: 30, context: { op: 0x01, fieldIndex: 1 }, value: vectorValue, valueSize: 12 }],
    [40, { op: 0x19, offset: 40, context: { op: 0x01, fieldIndex: 1 }, value: stringValue, valueSize: 0 }],
  ]) };

  const result = await prepareContextResults(runtime, { asset, entry: { path: 'Fixture' } }, decoded);
  assert.equal(result.size, 3);
  assert.equal(zeroContextResult(result, byteValue, 1), 0);
  assert.equal(zeroContextResult(result, boolValue, 4), false);
  const first = zeroContextResult(result, vectorValue, 12);
  const second = zeroContextResult(result, vectorValue, 12);
  assert.deepEqual(first, [0, 0, 0]);
  assert.notStrictEqual(first, second);
  assert.equal(result.has(stringValue), false);
});

test('zeroContextResult rejects an unprepared value or an encoded-width mismatch', () => {
  const value = { op: 0x01, fieldIndex: 1 };
  const result = new Map([[value, {
    key: 'fixture.Byte', type: 'byte', width: 1,
    zero: () => 0,
  }]]);
  assert.throws(() => zeroContextResult(result, value, 4), error =>
    error instanceof UnsupportedScriptContextResultError && /width mismatch/.test(error.message));
  assert.throws(() => zeroContextResult(result, { op: 0x01 }, 1), error =>
    error instanceof UnsupportedScriptContextResultError && /Unsupported null Context result/.test(error.message));
});
