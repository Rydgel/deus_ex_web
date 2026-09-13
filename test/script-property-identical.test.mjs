import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCRIPT_PROPERTY_IDENTICAL,
  UnsupportedScriptPropertyIdenticalError,
  identicalScriptProperty,
  identicalStr,
  identicalMap,
  identicalFixedArray,
  identicalArray,
  identicalStruct,
  structProperties,
} from '../src/runtime/script-property-identical.mjs';

function prop(kind, extra = {}) {
  return {kind, metadata: {...extra}};
}

// --- UStrProperty::Identical ------------------------------------------------

test('UStrProperty::Identical compares case-insensitively like appStricmp', () => {
  assert.equal(identicalStr('hello', 'hello'), true);
  assert.equal(identicalStr('hello', 'HELLO'), true);
  assert.equal(identicalStr('Hello', 'hELLo'), true);
  assert.equal(identicalStr('hello', 'world'), false);
  assert.equal(identicalStr('hello', 'hell'), false);
});

test('UStrProperty::Identical treats empty and null defaults as the empty literal', () => {
  // The native B == null branch compares against the literal at 0x102a7fe8;
  // the installed image provides the empty string there (see the module
  // literals table).  B with ArrayMax == 0 uses the 0x101ef654 empty literal.
  assert.equal(identicalStr('', ''), true);
  assert.equal(identicalStr('', null), true);
  assert.equal(identicalStr('hello', null), false);
  assert.equal(identicalStr('hello', ''), false);
  assert.equal(SCRIPT_PROPERTY_IDENTICAL.literals.none.text, '');
  assert.equal(SCRIPT_PROPERTY_IDENTICAL.literals.empty.text, '');
});

test('UStrProperty::Identical requires a non-null current value', () => {
  assert.throws(() => identicalStr(null, 'x'), /non-null current FString/);
});

// --- UMapProperty::Identical ------------------------------------------------

test('UMapProperty::Identical returns true unconditionally', () => {
  assert.equal(identicalMap(), true);
  assert.equal(identicalMap({anything: 1}), true);
});

// --- UFixedArrayProperty::Identical ------------------------------------------

test('UFixedArrayProperty::Identical compares each element through the Inner virtual', () => {
  const inner = prop('StrProperty');
  const fa = prop('FixedArrayProperty', {arrayCount: 3, inner});
  assert.equal(identicalFixedArray(fa, ['a', 'b', 'c'], ['a', 'B', 'C']), true);
  assert.equal(identicalFixedArray(fa, ['a', 'b', 'c'], ['a', 'x', 'c']), false);
  // Default shorter than count: undefined elements are compared like null.
  assert.equal(identicalFixedArray(fa, ['a', 'b', 'c'], ['a']), false);
});

test('UFixedArrayProperty::Identical with count zero returns true without the Inner', () => {
  const fa = prop('FixedArrayProperty', {arrayCount: 0});
  assert.equal(identicalFixedArray(fa, [], null), true);
});

test('UFixedArrayProperty::Identical passes null element defaults when the default is null', () => {
  const inner = prop('StrProperty');
  const fa = prop('FixedArrayProperty', {arrayCount: 2, inner});
  // Str default null compares against the empty literal.
  assert.equal(identicalFixedArray(fa, ['', ''], null), true);
  assert.equal(identicalFixedArray(fa, ['a', ''], null), false);
});

test('UFixedArrayProperty::Identical routes Inner recursion through the dispatch', () => {
  const inner = prop('FixedArrayProperty', {arrayCount: 2, inner: prop('IntProperty')});
  const outer = prop('FixedArrayProperty', {arrayCount: 1, inner});
  // Inner FixedArray (ints) uses the scalar Identical through dispatch; the
  // Int Identical is not this module, so verify an explicit unsupported error.
  assert.throws(() => identicalFixedArray(outer, [[1, 2]], [[1, 2]]),
    /does not dispatch IntProperty/);
});

// --- UArrayProperty::Identical ------------------------------------------------

test('UArrayProperty::Identical compares ArrayNum before the Inner elements', () => {
  const inner = prop('StrProperty');
  const arr = prop('ArrayProperty', {inner});
  assert.equal(identicalArray(arr, ['a', 'b'], ['a', 'b']), true);
  assert.equal(identicalArray(arr, ['a', 'b'], ['a']), false); // count mismatch
  assert.equal(identicalArray(arr, [], []), true);
});

test('UArrayProperty::Identical treats a null current value as an empty array', () => {
  const inner = prop('StrProperty');
  const arr = prop('ArrayProperty', {inner});
  assert.equal(identicalArray(arr, null, []), true);
  assert.equal(identicalArray(arr, null, ['a']), false);
});

test('UArrayProperty::Identical accepts native-shaped TArray records', () => {
  const inner = prop('StrProperty');
  const arr = prop('ArrayProperty', {inner});
  const current = {data: ['a', 'b'], arrayNum: 2};
  const fallback = {data: ['A', 'B'], arrayNum: 2};
  assert.equal(identicalArray(arr, current, fallback), true);
});

test('UArrayProperty::Identical requires a non-null default TArray', () => {
  const arr = prop('ArrayProperty', {inner: prop('StrProperty')});
  assert.throws(() => identicalArray(arr, [], null), /non-null default TArray/);
});

// --- UStructProperty::Identical ----------------------------------------------

function structure(children) {
  const record = {children, super: null, nativeAddress: Symbol('struct')};
  record.objectClass = {nativeAddress: 0x102a7af0};
  children.forEach(child => { child.objectClass = record.objectClass; });
  return record;
}
function member(key, kind, extra = {}) {
  return {key, kind, metadata: {kind, ...extra}};
}

test('UStructProperty::Identical compares each UProperty member element', () => {
  const st = structure([member('a', 'StrProperty'), member('b', 'StrProperty')]);
  const sp = prop('StructProperty', {struct: st});
  assert.equal(identicalStruct(sp, {a: 'x', b: 'y'}, {a: 'x', b: 'Y'}), true);
  assert.equal(identicalStruct(sp, {a: 'x', b: 'y'}, {a: 'z', b: 'y'}), false);
});

test('UStructProperty::Identical walks the inheritance chain via the +0x68 super', () => {
  const base = structure([member('base', 'StrProperty')]);
  const derived = {children: [member('own', 'StrProperty')], super: base};
  derived.nativeAddress = Symbol('derived');
  const sp = prop('StructProperty', {struct: derived});
  assert.equal(identicalStruct(sp, {own: 'a', base: 'b'}, {own: 'a', base: 'B'}), true);
  assert.equal(identicalStruct(sp, {own: 'a', base: 'b'}, {own: 'a', base: 'x'}), false);
});

test('UStructProperty::Identical passes null element defaults when the default struct is null', () => {
  const st = structure([member('a', 'StrProperty')]);
  const sp = prop('StructProperty', {struct: st});
  // Str against a null default compares against the empty literal.
  assert.equal(identicalStruct(sp, {a: ''}, null), true);
  assert.equal(identicalStruct(sp, {a: 'x'}, null), false);
});

test('UStructProperty::Identical handles members with ArrayDim > 1', () => {
  const st = structure([member('v', 'StrProperty', {arrayDim: 2})]);
  const sp = prop('StructProperty', {struct: st});
  assert.equal(identicalStruct(sp, {v: ['a', 'b']}, {v: ['A', 'B']}), true);
  assert.equal(identicalStruct(sp, {v: ['a', 'b']}, {v: ['A', 'x']}), false);
});

test('UStructProperty::Identical stops at the first mismatch', () => {
  const st = structure([member('a', 'StrProperty'), member('b', 'StrProperty')]);
  const sp = prop('StructProperty', {struct: st});
  assert.equal(identicalStruct(sp, {a: 'x', b: 'y'}, {a: 'z', b: 'y'}), false);
});

test('structProperties returns UProperty children across supers in order', () => {
  const base = structure([member('base', 'StrProperty')]);
  const derived = {children: [member('own', 'StrProperty'), {key: 'not-a-prop'}], super: base};
  derived.nativeAddress = Symbol('derived');
  const list = structProperties(derived);
  assert.deepEqual(list.map(p => p.key), ['own', 'base']);
});

// --- dispatch ----------------------------------------------------------------

test('identicalScriptProperty dispatches all five complex kinds and rejects others', () => {
  const st = structure([member('a', 'StrProperty')]);
  const cases = [
    [prop('StrProperty'), 'x', 'X', true],
    [prop('MapProperty'), {}, null, true],
    [prop('FixedArrayProperty', {arrayCount: 1, inner: prop('StrProperty')}), ['a'], ['A'], true],
    [prop('ArrayProperty', {inner: prop('StrProperty')}), ['a'], ['A'], true],
    [prop('StructProperty', {struct: st}), {a: 'b'}, {a: 'B'}, true],
  ];
  for (const [p, value, fallback, expected] of cases) {
    assert.equal(identicalScriptProperty(p, value, fallback), expected, `${p.kind}`);
  }
  assert.throws(() => identicalScriptProperty(prop('IntProperty'), 1, 1),
    /does not dispatch IntProperty/);
  assert.throws(() => identicalScriptProperty(prop('Unknown'), 1, 1), UnsupportedScriptPropertyIdenticalError);
});

test('the tagged-property defaultComparison now resolves complex +0x6c kinds', async () => {
  const {serializeTaggedPropertiesGc} = await import('../src/runtime/script-tagged-properties.mjs');
  const member = {key: 'name', name: 'name', kind: 'StrProperty', metadata: {
    kind: 'StrProperty', name: 'name', arrayDim: 1, arrayDimension: 1,
    offset: 0, elementSize: 0xc, propertyFlags: 0,
  }};
  const structureRecord = {children: [member], super: null, nativeAddress: 0x99};
  structureRecord.objectClass = {nativeAddress: 0x102a7af0};
  member.objectClass = {nativeAddress: 0x102a7af0};
  const archive = {
    archiveState: {ar04: 0x44, ar08: 0x44c, ar0c: 0, ar10: 0, ar14: 0, ar18: 0, ar1c: 1, ar20: 1, ar24: 1},
    nameReference(ref) { return ref; },
    serializeRaw() {},
  };
  const result = serializeTaggedPropertiesGc(structureRecord, archive, {name: ''}, null, {});
  // The Str property is identical to the empty default; no tag is emitted.
  assert.equal(result.identicalCalls.length, 1);
  assert.equal(result.properties.length, 0);
  assert.equal(result.skipped.filter(s => s.reason === 'identical').length, 1);
});