import test from 'node:test';
import assert from 'node:assert/strict';
import {ScriptLinks} from '../src/runtime/script-links.mjs';
import {ScriptObjects} from '../src/runtime/script-objects.mjs';
import {compactContextResults, descriptorZero, prepareContextResults, zeroContextResult} from '../src/runtime/script-context-results.mjs';

// A small deterministic generator, so a failure replays. These tests compare primitives and identities with `===`: a failing assert on a
// graph would make node inspect all of it.
const random = seed => () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;

/** The two Maps the links replaced, from the same operands: package index -> identity in first-reference order, offset -> identity (the
 * last write of an offset wins). */
function modelOf(bindings, operands) {
  const byIndex = new Map(), byOffset = new Map();
  for (const [index, identity] of bindings) byIndex.set(index, identity);
  for (const [offset, index] of operands) byOffset.set(offset, byIndex.get(index));
  return {byIndex, byOffset};
}

function linksOf(bindings, operands) {
  const indexes = bindings.map(([index]) => index), identities = bindings.map(([, identity]) => identity);
  const position = new Map(indexes.map((index, at) => [index, at]));
  return ScriptLinks.make(indexes, identities, operands.map(([offset]) => offset), operands.map(([, index]) => position.get(index)));
}

function randomScript(next, bindingCount, operandCount, offsetRange) {
  const bindings = [], used = new Set();
  while (bindings.length < bindingCount) {
    const index = Math.floor(next() * 400) - 40;
    if (!used.has(index)) { used.add(index); bindings.push([index, next() < 0.1 ? null : {name: `identity ${index}`}]); }
  }
  const operands = [];
  if (bindingCount > 0) for (let at = 0; at < operandCount; at++)
    operands.push([Math.floor(next() * offsetRange), bindings[Math.floor(next() * bindingCount)][0]]);
  return {bindings, operands};
}

test('ScriptLinks answers as the two Maps it replaced: bindings by package index, operands by expression offset', () => {
  const next = random(11);
  for (let round = 0; round < 300; round++) {
    const bindingCount = Math.floor(next() * (round % 7 === 0 ? 120 : 8)), operandCount = Math.floor(next() * (round % 5 === 0 ? 600 : 30));
    // a small range makes offsets that repeat (the last write wins), a large one sorted gaps
    const {bindings, operands} = randomScript(next, bindingCount, operandCount, round % 3 === 0 ? 40 : 6000);
    const links = linksOf(bindings, operands), model = modelOf(bindings, operands);
    assert.ok(links.size === model.byIndex.size);
    assert.ok([...links.values()].length === model.byIndex.size);
    let at = 0;
    for (const [index, identity] of model.byIndex) {
      assert.ok(links.has(index) && links.get(index) === identity);
      assert.ok([...links.keys()][at++] === index);
    }
    const ordered = [...model.byIndex.values()], values = [...links.values()];
    assert.ok(ordered.length === values.length && ordered.every((identity, i) => identity === values[i]));
    const entries = [...links], pairs = [...model.byIndex];
    assert.ok(entries.length === pairs.length && entries.every(([index, identity], i) => index === pairs[i][0] && identity === pairs[i][1]));
    let walked = 0;
    links.forEach((identity, index, owner) => { assert.ok(owner === links && model.byIndex.get(index) === identity); walked++; });
    assert.ok(walked === model.byIndex.size);
    for (const missing of [undefined, null, '1', 1.5, NaN, 99999]) assert.ok(links.has(missing) === model.byIndex.has(missing));
    assert.ok(links.operandCount === model.byOffset.size);
    let previous = -1;
    for (const [offset, value] of links.operands()) {
      assert.ok(offset > previous && model.byOffset.has(offset) && model.byOffset.get(offset) === value);
      previous = offset;
    }
    for (const [offset, identity] of model.byOffset) {
      const rank = links.find(offset);
      assert.ok(rank >= 0 && links.operandAt(rank) === identity);
    }
    for (const missing of [undefined, null, '5', 5.5, NaN, -1, 1e9, {}]) assert.ok(links.find(missing) === (model.byOffset.has(missing) ? links.find(missing) : -1));
    for (let probe = 0; probe < 50; probe++) {
      const offset = Math.floor(next() * 6100);
      assert.ok((links.find(offset) >= 0) === model.byOffset.has(offset));
    }
  }
});

test('an operand written after linking is its own: the binding and the other operands of the same identity are as they were', () => {
  const identity = {name: 'shared'}, other = {name: 'other'};
  const links = linksOf([[7, identity], [9, other]], [[4, 7], [10, 7], [30, 9]]);
  const first = links.find(4), second = links.find(10), third = links.find(30);
  assert.ok(links.operandAt(first) === identity && links.operandAt(second) === identity);
  links.setOperandAt(first, null);
  assert.ok(links.operandAt(first) === null);
  assert.ok(links.operandAt(second) === identity && links.operandAt(third) === other);
  assert.ok(links.get(7) === identity);
  links.setOperandAt(third, identity);
  assert.ok(links.operandAt(third) === identity && links.get(9) === other);
  links.setOperandAt(first, other);
  assert.ok(links.operandAt(first) === other);
});

test('blocks share chunks, and one larger than a chunk has an array of its own', () => {
  const next = random(5), all = [];
  for (let at = 0; at < 400; at++) {
    const {bindings, operands} = randomScript(next, 1 + Math.floor(next() * 30), Math.floor(next() * 90), 4000);
    all.push({links: linksOf(bindings, operands), model: modelOf(bindings, operands)});
  }
  const big = randomScript(next, 60, 700, 9000);
  all.push({links: linksOf(big.bindings, big.operands), model: modelOf(big.bindings, big.operands)});
  const chunks = new Set(all.map(({links}) => links.words));
  assert.ok(chunks.size < all.length / 4 && chunks.size > 1);
  for (const {links, model} of all) {
    for (const [offset, identity] of model.byOffset) assert.ok(links.operandAt(links.find(offset)) === identity);
    for (const [index, identity] of model.byIndex) assert.ok(links.get(index) === identity);
  }
});

// The fixture runtime of script-context-results.test.mjs
const asset = {name: 'Fixture', pkg: {}, bytes: new Uint8Array()};
const field = (index, type, extra = {}) => ({key: `fixture.field${index}`, kind: `${type[0].toUpperCase()}${type.slice(1)}Property`, asset, index,
  metadata: {type, arrayDim: 1, ...extra}});

async function preparedFixture() {
  const types = ['byte', 'int', 'bool', 'float', 'name', 'object', 'class', 'struct'], fields = new Map();
  types.forEach((type, at) => fields.set(at + 1, field(at + 1, type, type === 'struct' ? {structKey: 'Core.Object.Rotator'} : {propertyClassRef: 9})));
  fields.set(20, field(20, 'string'));
  fields.set(21, {key: 'fixture.class', kind: 'Class', asset, index: 21, metadata: {}});
  const runtime = {objects: {reference: (_script, index) => fields.get(index)}, field: async record => record};
  const expressions = new Map(), values = [];
  const add = (offset, node) => expressions.set(offset, {offset, ...node});
  let offset = 100;
  for (let at = 0; at < 8; at++) {
    const value = {op: 0x01, offset: offset + 1, fieldIndex: at + 1};
    add(offset, {op: at % 2 === 0 ? 0x19 : 0x12, context: {op: 0x01, fieldIndex: 6}, value, valueSize: [1, 4, 4, 4, 4, 4, 4, 12][at]});
    values.push(value);
    offset += 10;
  }
  const stringValue = {op: 0x01, offset: offset + 1, fieldIndex: 20};
  add(offset, {op: 0x19, context: {op: 0x01, fieldIndex: 6}, value: stringValue, valueSize: 0}); offset += 10;
  // a DynamicCast result: prepared, but it names a class, which has no typed zero
  const castValue = {op: 0x2e, offset: offset + 1, fieldIndex: 21};
  add(offset, {op: 0x19, context: {op: 0x01, fieldIndex: 6}, value: castValue, valueSize: 4});
  values.push(castValue);
  const script = {asset, entry: {path: 'Fixture'}}, decoded = {expressions};
  const results = await prepareContextResults(runtime, script, decoded);
  return {results, values, stringValue, decoded};
}

/** What zeroContextResult did with a node and size: the value, or the error it raised with its fields. */
function outcome(table, node, size) {
  try { return JSON.stringify({value: zeroContextResult(table, node, size)}); }
  catch (error) { return JSON.stringify({name: error.name, message: error.message, code: error.code ?? null, key: error.key ?? null, type: error.type ?? null, offset: error.offset ?? null, size: error.size ?? null}); }
}

test('compact Context results give the values and raise the errors of the descriptors Map', async () => {
  const {results, values, stringValue} = await preparedFixture();
  assert.ok(results.size === 9);
  const links = linksOf([[1, {name: 'one'}]], [[100, 1]]).prepared(compactContextResults(results));
  assert.ok(links.hasContexts && links.contextCount === 9 && links.get(1).name === 'one' && links.find(100) >= 0);
  for (const value of [...values, stringValue, {op: 0x01, offset: 5}, {op: 0x01}, undefined, null, {offset: 100, value: values[0]}]) {
    for (const size of [0, 1, 4, 12, undefined]) assert.ok(outcome(links, value, size) === outcome(results, value, size), `${value?.offset} ${size}`);
  }
  // the Context node itself is accepted when its value is prepared
  assert.ok(outcome(links, {offset: 100, value: values[0]}, 1) === outcome(results, {offset: 100, value: values[0]}, 1));
  // a vector of three zeros each time, and the cast fails on width as its descriptor did
  const a = zeroContextResult(links, values[7], 12), b = zeroContextResult(links, values[7], 12);
  assert.ok(a !== b && a.length === 3 && a.every(x => x === 0));
  assert.throws(() => zeroContextResult(links, values[8], 4), error => /width mismatch for undefined: encoded 4, linked undefined/.test(error.message));
});

test('Context results prepared again replace the first, an empty set is prepared, and a script never prepared is told apart', async () => {
  const {results, values} = await preparedFixture();
  const entries = compactContextResults(results);
  const plain = linksOf([[1, {name: 'one'}], [2, {name: 'two'}]], [[10, 1], [20, 2]]);
  assert.ok(!plain.hasContexts && plain.contextCount === 0 && plain.contextFind(values[0].offset) === -1);
  const empty = plain.prepared([]);
  assert.ok(empty.hasContexts && empty.contextCount === 0 && empty.get(2).name === 'two');
  assert.throws(() => zeroContextResult(empty, values[0], 1), error => /Unsupported null Context result/.test(error.message));
  assert.throws(() => zeroContextResult(undefined, values[0], 1), error => error instanceof TypeError && /Expected a prepared Context result Map/.test(error.message));
  const full = empty.prepared(entries), fewer = full.prepared(entries.slice(0, 2)), none = fewer.prepared([]);
  assert.ok(full.contextCount === 9 && fewer.contextCount === 2 && none.contextCount === 0);
  assert.ok(fewer.length === 2 + 2 * 2 && none.length === 2 && fewer.get(2).name === 'two' && none.find(20) >= 0);
  assert.ok(outcome(fewer, values[0], 1) === outcome(results, values[0], 1));
  assert.ok(outcome(fewer, values[5], 4) !== outcome(results, values[5], 4));
  assert.throws(() => zeroContextResult(none, values[0], 1), error => /Unsupported null Context result/.test(error.message));
  // the operands written before the results were prepared carry over
  plain.setOperandAt(plain.find(10), null);
  assert.ok(plain.prepared(entries).operandAt(plain.find(10)) === null);
});

test('compactContextResults refuses a descriptor it cannot keep', () => {
  assert.throws(() => compactContextResults(new Map([[5, {source: 'property', key: 'k', metadata: {}, width: 4.5, type: 'int', contextOffset: 3, zero() {}}]])), TypeError);
  assert.throws(() => compactContextResults(new Map([[5, {source: 'cast', type: 'object', width: 4, contextOffset: 3}]])), TypeError);
  assert.throws(() => compactContextResults(new Map([[5.5, {source: 'cast', type: 'object', contextOffset: 3}]])), TypeError);
});

test('function results with equal metadata share the first one; a different one, or a function that is not an object, keeps its own', () => {
  const owner = {key: 'fixture.fn'}, other = {key: 'fixture.other'};
  const metadata = (extra = {}) => ({asset, index: 4, type: 'int', arrayDim: 1, flags: 0, ...extra});
  const descriptor = (offset, fn, meta) => [offset, {source: 'function', key: 'fixture.fn.returnvalue', field: {}, metadata: meta, type: 'int', structKey: null,
    width: 4, offset: null, zero: descriptorZero, function: fn, returnField: {}, contextOffset: offset - 1, encodedSize: 4}];
  const a = metadata(), b = metadata(), c = metadata({flags: 8}), d = metadata(), e = metadata();
  const entries = compactContextResults(new Map([descriptor(11, owner, a), descriptor(21, owner, b), descriptor(31, owner, c), descriptor(41, other, d),
    descriptor(51, 'not an object', e), descriptor(61, owner, a)]));
  const at = offset => entries.find(entry => entry.offset === offset).metadata;
  assert.ok(at(11) === a && at(21) === a && at(31) === c && at(41) === d && at(51) === e && at(61) === a);
  // another call keeps sharing with the first object ever kept for the function
  const later = compactContextResults(new Map([descriptor(71, owner, metadata())]));
  assert.ok(later[0].metadata === a);
  // the shared metadata gives the same zero
  const links = linksOf([[1, {name: 'one'}]], [[10, 1]]).prepared(entries);
  const node = {offset: 21, value: {offset: 21}};
  assert.ok(zeroContextResult(links, node, 4) === 0);
});

// ScriptObjects over the links
function fixtureObjects(count) {
  const exports = Array.from({length: count}, (_, at) => ({name: `Export${at}`, path: `Export${at}`, className: 'Object'}));
  const fixtureAsset = {name: 'Fixture', pkg: {version: 68, exports, imports: [], names: []}};
  const objects = new ScriptObjects({resolve: async (source, index) => ({asset: fixtureAsset, index, entry: exports[index - 1], key: `Fixture.Export${index - 1}`})});
  return {objects, asset: fixtureAsset};
}

test('ScriptObjects links, resolves operands, takes a written operand and keeps the results the links hold', async () => {
  const {objects, asset: fixtureAsset} = fixtureObjects(30);
  const node = (offset, name, index) => ({op: 0x20, offset, [name]: index});
  const decoded = {expressions: new Map([[8, node(8, 'objectIndex', 3)], [2, node(2, 'fieldIndex', 5)], [20, node(20, 'objectIndex', 3)], [31, {op: 0x04, offset: 31}]])};
  const script = {asset: fixtureAsset, entry: {path: 'Linked'}};
  let epoch = objects.operandEpoch, notified = 0;
  objects.operandListeners.push(() => notified++);
  const bindings = await objects.link(script, decoded);
  assert.ok(objects.operandEpoch === epoch + 1 && notified === 1);
  assert.ok([...bindings.keys()].join() === '3,5' && bindings.get(3).key === 'fixture.export2' && bindings.size === 2);
  assert.ok(objects.operand(script, {offset: 8}) === bindings.get(3) && objects.operand(script, {offset: 2}) === bindings.get(5));
  assert.ok(objects.operand(script, {offset: 20}) === objects.operand(script, {offset: 8}));
  assert.ok(objects.reference(script, 5) === bindings.get(5) && objects.reference(script, 0) === null);
  assert.throws(() => objects.reference(script, 6), /Unlinked script reference Linked:6/);
  assert.throws(() => objects.operand(script, {offset: 31}), /Unlinked bytecode operand Linked:31/);
  assert.throws(() => objects.operand(script, undefined), /Unlinked bytecode operand Linked:undefined/);
  assert.throws(() => objects.operand({entry: {path: 'Other'}}, {offset: 2}), /Unlinked bytecode operand Other:2/);
  assert.throws(() => objects.operandReference(script, {offset: 3}), /Unlinked bytecode operand Linked:3/);
  // linking again checks the same buffer and hands back the same links
  assert.ok(await objects.link(script, decoded) === bindings);
  await assert.rejects(objects.link(script, {expressions: new Map([[9, node(9, 'objectIndex', 3)]])}), /different linked bytecode buffer/);
  // an operand written through its reference
  const reference = objects.operandReference(script, {offset: 8});
  assert.ok(reference.reference === true && reference.get() === bindings.get(3));
  assert.throws(() => reference.set(7), TypeError);
  epoch = objects.operandEpoch;
  reference.set(null);
  assert.ok(objects.operandEpoch === epoch + 1 && notified === 2 && reference.get() === null);
  assert.ok(objects.operand(script, {offset: 8}) === null && objects.operand(script, {offset: 20}) === bindings.get(3) && objects.reference(script, 3) === bindings.get(3));
  // null-Context results: unprepared, then prepared; the links stay the script's
  assert.ok(objects.contextResultsOf(script) === undefined);
  const value = {op: 0x01, offset: 41, fieldIndex: 5};
  const results = new Map([[41, {source: 'property', key: 'fixture.f', field: null, metadata: {type: 'int', arrayDim: 1}, type: 'int', structKey: null, width: 4, offset: 41,
    zero: function () { return 0; }, contextOffset: 40, encodedSize: 4}]]);
  assert.throws(() => objects.setContextResults({entry: {path: 'Nothing'}}, []), /Script bytecode is not linked: Nothing/);
  assert.throws(() => compactContextResults(results), TypeError);   // this fixture's zero is not the descriptor's own
  objects.setContextResults(script, []);
  const kept = objects.contextResultsOf(script);
  assert.ok(kept !== undefined && kept.contextCount === 0);
  assert.ok(objects.operand(script, {offset: 8}) === null && objects.operand(script, {offset: 2}) === bindings.get(5));
  assert.throws(() => zeroContextResult(kept, value, 4), /Unsupported null Context result at offset 41/);
  assert.ok(objects.links.get(script) === kept);
});

test('ScriptObjects keeps a written operand through the prepared results that replace its links', async () => {
  const {objects, asset: fixtureAsset} = fixtureObjects(10);
  const decoded = {expressions: new Map([[6, {op: 0x20, offset: 6, objectIndex: 2}], [12, {op: 0x20, offset: 12, objectIndex: 2}]])};
  const script = {asset: fixtureAsset, entry: {path: 'Replaced'}};
  const bindings = await objects.link(script, decoded);
  const reference = objects.operandReference(script, {offset: 12});
  reference.set(null);
  const {results} = await preparedFixture();
  objects.setContextResults(script, compactContextResults(results));
  const now = objects.links.get(script);
  assert.ok(now !== bindings && now.hasContexts && now.contextCount === 9);
  assert.ok(objects.operand(script, {offset: 12}) === null && objects.operand(script, {offset: 6}) === bindings.get(2));
  // the reference taken before the replacement writes into the links the script has now
  reference.set(bindings.get(2));
  assert.ok(objects.operand(script, {offset: 12}) === bindings.get(2));
  assert.ok(bindings.get(2) === now.get(2));
});
