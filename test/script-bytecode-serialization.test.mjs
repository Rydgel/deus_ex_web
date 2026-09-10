import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeScript } from '../src/unreal/bytecode.mjs';
import {
  UnsupportedScriptBytecodeSerializationError,
  serializeGcScriptExpression,
} from '../src/runtime/script-bytecode-serialization.mjs';

function holder(values, index) {
  return {
    reference: true,
    get: () => values.get(index),
    set: value => { values.set(index, value); return value; },
  };
}

test('GC SerializeExpr preserves live object/name order, labels, and native progress', () => {
  const pkg = {
    version: 68,
    names: [{ name: 'None' }, { name: 'Begin' }, { name: 'Tick' }],
    exports: [{ name: 'Field' }, { name: 'ObjectConst' }, { name: 'TickFunction' }],
    imports: [],
  };
  // Three one-byte tokens place LabelTable at expanded offset 3.  Each label
  // expands to a four-byte FName plus a four-byte target; object/name operands
  // likewise expand to four bytes although their compact source index is one.
  const bytes = Uint8Array.from([
    0x25, 0x25, 0x25,
    0x0c, 0x01, 0, 0, 0, 0, 0x00, 0, 0, 0, 0,
    0x20, 0x02,
    0x1b, 0x02, 0x16,
    0x1c, 0x03, 0x16,
  ]);
  const script = { pkg, bytes, size: 37 };
  const decoded = decodeScript(script);
  const objects = new Map([[2, { name: 'ObjectConst' }], [3, { name: 'TickFunction' }]]);
  const names = new Map([[0, 'None'], [1, 'Begin'], [2, 'Tick']]);
  const events = [];
  const archive = {
    objectReference(reference, context) {
      events.push(['object', context.slot, reference.get()]);
      reference.set({ marked: reference.get().name });
    },
    nameReference(reference, context) {
      events.push(['name', context.slot, reference.get()]);
      reference.set(`marked:${reference.get()}`);
    },
  };
  const objectOperand = (node, slot) => {
    const index = node.objectIndex ?? node.functionIndex ?? node.fieldIndex;
    assert.ok(objects.has(index), `object operand ${slot} should resolve`);
    return holder(objects, index);
  };
  const nameOperand = (node, slot) => {
    assert.ok(names.has(node.nameIndex), `name operand ${slot} should resolve`);
    return holder(names, node.nameIndex);
  };

  for (let offset = 0; offset < decoded.size;) {
    offset = serializeGcScriptExpression(script, decoded, offset, archive, {
      objectOperand,
      nameOperand,
    });
  }

  assert.deepEqual(events.map(event => event.slice(0, 2)), [
    ['name', 'label'], ['name', 'label'], ['object', 'object'],
    ['name', 'function-name'], ['object', 'function'],
  ]);
  assert.equal(events[0][2], 'Begin');
  assert.equal(events[1][2], 'None');
  assert.equal(events[2][2].name, 'ObjectConst');
  assert.equal(events[3][2], 'Tick');
  assert.equal(events[4][2].name, 'TickFunction');
  assert.deepEqual(objects.get(2), { marked: 'ObjectConst' });
  assert.deepEqual(objects.get(3), { marked: 'TickFunction' });
  assert.equal(names.get(1), 'marked:Begin');
  assert.equal(names.get(0), 'marked:None');
  assert.equal(names.get(2), 'marked:Tick');

  // The native 0x2d handler consumes only its token.  A cursor walk must
  // still reach the retained child and then the following LetBool operand.
  const boolScript = { pkg, bytes: Uint8Array.from([0x14, 0x2d, 0x01, 0x01, 0x20, 0x02]), size: 12 };
  const boolDecoded = decodeScript(boolScript);
  const boolObjects = new Map([[1, { name: 'BoolProperty' }], [2, { name: 'ObjectConst' }]]);
  const boolEvents = [];
  const boolArchive = {
    objectReference(reference) { boolEvents.push(reference.get().name); },
    nameReference() {},
  };
  for (let cursor = 0; cursor < boolDecoded.size;) {
    cursor = serializeGcScriptExpression(boolScript, boolDecoded, cursor, boolArchive, {
      objectOperand: node => holder(boolObjects, node.fieldIndex ?? node.objectIndex),
      nameOperand: () => holder(new Map(), 0),
    });
  }
  assert.deepEqual(boolEvents, ['BoolProperty', 'ObjectConst']);

  const unsupported = { size: 1, expressions: new Map([
    [0, { op: 0x2b, token: 0x2b, offset: 0, end: 1 }],
  ]) };
  assert.throws(() => serializeGcScriptExpression(script, unsupported, 0, archive, {
    objectOperand,
    nameOperand,
  }), error => error instanceof UnsupportedScriptBytecodeSerializationError && /0x2b/.test(error.message));
  assert.throws(() => serializeGcScriptExpression(script, decoded, 20, {
    ...archive,
    archiveState: { ar04: 0x44, ar08: 0x44c, ar0c: 1 },
  }, { objectOperand, nameOperand }), /FArchive ar0c/);
});
