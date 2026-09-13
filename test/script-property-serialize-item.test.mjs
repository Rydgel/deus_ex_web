import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCRIPT_PROPERTY_SERIALIZE_ITEM,
  serializeScriptPropertyItem,
  serializeStrItem,
  serializeArrayItem,
  serializeFixedArrayItem,
  serializeStructItem,
  serializeMapItem,
  serializeBoolItem,
} from '../src/runtime/script-property-serialize-item.mjs';

function prop(kind, extra = {}) {
  return {kind, metadata: {kind, ...extra}};
}

/** Recording archive that accumulates raw bytes like the measure adapter. */
function rawArchive(events = []) {
  return {
    bytes: 0,
    serializeRaw(reference, width, context) {
      this.bytes += width;
      events.push(['raw', context?.phase ?? 'collector', context?.property?.name ?? '?', width]);
      return this;
    },
    objectReference(reference, context) { events.push(['object', reference.get()]); return this; },
    nameReference(reference, context) { events.push(['name', reference.get()]); return this; },
  };
}
const holder = value => ({get: () => value, set: next => { value = next; return next; }});
// Native order: FString {Data, ArrayNum (+4), ArrayMax (+8)}.
const fstringRecord = (text, arrayNum = text.length + 1, arrayMax = arrayNum) => ({data: text, arrayNum, arrayMax});

function streamArchive({loading = false, saving = false, input = []} = {}) {
  const bytes = [];
  const reads = [];
  const archive = {
    archiveState: {ar0c: loading ? 1 : 0, ar10: saving ? 1 : 0},
    bytes,
    reads,
    serializeRaw(reference, width, context = {}) {
      reads.push([context.branch, context.kind ?? 'raw', width]);
      if (!loading) {
        bytes.push([width, reference.get()]);
        return this;
      }
      let value = 0;
      for (let index = 0; index < width; index++) value |= (input.shift() ?? 0) << (index * 8);
      reference.set(value >>> 0);
      bytes.push([width, value >>> 0]);
      return this;
    },
  };
  return archive;
}

// --- UStrProperty::SerializeItem ----------------------------------------------

test('UStrProperty::SerializeItem writes CompactIndex then ArrayNum bytes for an ASCII FString', () => {
  const events = [];
  const ar = rawArchive(events);
  const p = prop('StrProperty', {});
  serializeStrItem(p, ar, holder(fstringRecord('hello', 6)), {key: 'name', property: p});
  assert.equal(ar.bytes, 10); // 4 marker + 6 chars * 1
  assert.deepEqual(events.map(e => e[3]), [4, 1, 1, 1, 1, 1, 1]);
});

test('UStrProperty::SerializeItem writes two bytes per char for a Unicode FString', () => {
  const ar = rawArchive();
  const p = prop('StrProperty', {});
  serializeStrItem(p, ar, holder(fstringRecord('h\u0100llo', 6)), {key: 'name', property: p});
  assert.equal(ar.bytes, 16); // 4 marker + 6 chars * 2
});

test('UStrProperty::SerializeItem uses ArrayNum, not ArrayMax capacity', () => {
  const ar = rawArchive();
  const p = prop('StrProperty', {});
  serializeStrItem(p, ar, holder(fstringRecord('abc', 4, 20)), {key: 'name', property: p});
  assert.equal(ar.bytes, 8); // Num=4, Max=20: 4 marker + 4 code units
});

test('UStrProperty::SerializeItem follows FString constructor counts for logical JS strings', () => {
  const ar = rawArchive();
  const p = prop('StrProperty', {});
  const result = serializeStrItem(p, ar, holder('hello'), {key: 'name', property: p});
  assert.equal(ar.bytes, 10); // FString(const TCHAR*) gives Num=Max=6
  assert.equal(result.arrayNum, 6);
  assert.equal(result.arrayMax, 6);

  const empty = rawArchive();
  const emptyResult = serializeStrItem(p, empty, holder(''), {key: 'empty', property: p});
  assert.equal(empty.bytes, 4); // FString(const TCHAR*) leaves empty Num=Max=0
  assert.equal(emptyResult.arrayNum, 0);

  // A host capacity service may preserve extra native allocation capacity;
  // ArrayNum remains the serialized count.
  const ar2 = rawArchive();
  const services = {stringCapacity: () => 20};
  const result2 = serializeStrItem(p, ar2, holder('hello'), {key: 'name', property: p}, services);
  assert.equal(ar2.bytes, 10);
  assert.equal(result2.arrayNum, 6);
  assert.equal(result2.arrayMax, 20);
  assert.throws(() => serializeStrItem(p, rawArchive(), holder('hello'), {key: 'name', property: p}, {
    stringCapacity: () => 2,
  }), /ArrayMax/);
});

test('UStrProperty::SerializeItem keeps raw and allocated empty FStrings distinct', () => {
  const p = prop('StrProperty', {});
  const raw = rawArchive();
  const rawResult = serializeStrItem(p, raw, holder(fstringRecord('', 0, 0)), {key: 'raw', property: p});
  assert.equal(raw.bytes, 4); // Num=0: CompactIndex only
  assert.equal(rawResult.arrayNum, 0);

  const allocated = rawArchive();
  const allocatedResult = serializeStrItem(p, allocated, holder(fstringRecord('', 1)), {key: 'allocated', property: p});
  assert.equal(allocated.bytes, 5); // Num=1: marker + terminating code unit
  assert.equal(allocatedResult.arrayNum, 1);
});

test('UStrProperty::SerializeItem follows the native saving CompactIndex and CountBytes branches', () => {
  const p = prop('StrProperty', {});
  const archive = streamArchive({saving: true});
  const countCalls = [];
  archive.countBytes = (count, maximum, context) => countCalls.push([count, maximum, context.body]);
  const value = fstringRecord('h\u0100', 3, 8);
  const result = serializeStrItem(p, archive, holder(value), {key: 'save'}, {});
  assert.equal(result.branch, 'saving');
  assert.equal(result.marker, -3);
  assert.equal(result.compactIndexBytes, 1);
  assert.equal(result.serializedBytes, 7); // 0x83 + three UTF-16 code units
  assert.deepEqual(countCalls, [[6, 16, 0x101459b0]]);
  assert.deepEqual(archive.bytes, [[1, 0x83], [2, 0x68], [2, 0x100], [2, 0]]);
});

test('UStrProperty::SerializeItem loads signed Unicode units, reallocates, and canonicalizes one-unit empty values', () => {
  const p = prop('StrProperty', {});
  const events = [];
  const archive = streamArchive({loading: true, input: [0x83, 0x68, 0, 0, 1, 0]});
  archive.countBytes = (count, maximum) => events.push(['countBytes', count, maximum]);
  const services = {
    reallocateArray(record, elementSize, details) {
      events.push(['realloc', elementSize, details.arrayNum, details.arrayMax]);
      record.data = new Array(details.arrayMax);
    },
    stringEmpty(record, elementSize, slack, details) {
      events.push(['empty', elementSize, slack, details.body]);
      record.data = [];
    },
  };
  const value = fstringRecord('old', 4, 4);
  const result = serializeStrItem(p, archive, holder(value), {key: 'load'}, services);
  assert.equal(result.branch, 'loading');
  assert.equal(result.marker, -3);
  assert.equal(result.width, 2);
  assert.deepEqual(value, {data: [0x68, 0x100, 0], arrayNum: 3, arrayMax: 3});
  assert.deepEqual(events, [['countBytes', 8, 8], ['realloc', 2, 3, 3]]);

  const empty = fstringRecord('old', 2, 2);
  const emptyArchive = streamArchive({loading: true, input: [1, 0]});
  const emptyEvents = [];
  serializeStrItem(p, emptyArchive, holder(empty), {key: 'empty-load'}, {
    reallocateArray(record, elementSize, details) {
      emptyEvents.push(['realloc', details.arrayNum, details.arrayMax]);
      record.data = new Array(details.arrayMax);
    },
    stringEmpty(record, elementSize, slack) {
      emptyEvents.push(['empty', elementSize, slack]);
      record.data = [];
    },
  });
  assert.deepEqual(empty, {data: [], arrayNum: 0, arrayMax: 0});
  assert.deepEqual(emptyEvents, [['realloc', 1, 1], ['empty', 2, 0]]);
});

test('UStrProperty::SerializeItem fails without a raw-capable archive', () => {
  const p = prop('StrProperty', {});
  assert.throws(() => serializeStrItem(p, {}, holder(fstringRecord('a', 2)), {key: 'k', property: p}),
    /serializeRaw/);
});

// --- UArrayProperty::SerializeItem ---------------------------------------------

test('UArrayProperty::SerializeItem writes the count then one item per element', () => {
  const events = [];
  const ar = rawArchive(events);
  const inner = prop('IntProperty', {});
  const p = prop('ArrayProperty', {inner});
  serializeArrayItem(p, ar, holder(['x', 'y']), {key: 'arr', property: p});
  assert.equal(ar.bytes, 12); // 4 count + 2 * 4
  assert.deepEqual(events.map(e => e[3]), [4, 4, 4]);
});

test('UArrayProperty::SerializeItem with an empty array writes only the count', () => {
  const ar = rawArchive();
  const p = prop('ArrayProperty', {inner: prop('IntProperty', {})});
  serializeArrayItem(p, ar, holder([]), {key: 'arr', property: p});
  assert.equal(ar.bytes, 4);
});

test('UArrayProperty::SerializeItem treats a null current value as an empty array', () => {
  const ar = rawArchive();
  const p = prop('ArrayProperty', {inner: prop('IntProperty', {})});
  serializeArrayItem(p, ar, holder(null), {key: 'arr', property: p});
  assert.equal(ar.bytes, 4);
});

test('UArrayProperty::SerializeItem recurses through mixed element kinds', () => {
  const events = [];
  const ar = rawArchive(events);
  const strInner = prop('StrProperty', {});
  const p = prop('ArrayProperty', {inner: strInner});
  // An optional capacity service can preserve extra native allocation
  // capacity; ArrayNum remains the serialized count.
  const services = {stringCapacity: () => 3};
  serializeArrayItem(p, ar, holder(['ab', 'cd']), {key: 'arr', property: p}, services);
  assert.equal(ar.bytes, 4 + 2 * (4 + 3)); // count + two Str items (4 marker + Num=3)
});

test('UArrayProperty::SerializeItem accepts native-shaped TArray records', () => {
  const ar = rawArchive();
  const p = prop('ArrayProperty', {inner: prop('IntProperty', {})});
  const record = {data: [5, 6, 7], arrayNum: 3};
  serializeArrayItem(p, ar, holder(record), {key: 'arr', property: p});
  assert.equal(ar.bytes, 4 + 3 * 4);
});

test('UArrayProperty::SerializeItem loads count, applies native growth, and recurses through Inner', () => {
  const archive = streamArchive({loading: true, input: [2, 7, 0, 0, 0, 9, 0, 0, 0]});
  const events = [];
  const value = {data: [99], arrayNum: 1, arrayMax: 1};
  const inner = prop('IntProperty', {elementSize: 4});
  const p = prop('ArrayProperty', {inner});
  const result = serializeArrayItem(p, archive, holder(value), {key: 'load-array'}, {
    reallocateArray(record, elementSize, details) {
      events.push([elementSize, details.arrayNum, details.arrayMax]);
      record.data = new Array(details.arrayMax);
    },
  });
  assert.equal(result.branch, 'loading');
  assert.equal(result.arrayNum, 2);
  assert.equal(result.arrayMax, 34); // 2 + floor(3*2/8) + 32
  assert.deepEqual(value.data.slice(0, 2), [7, 9]);
  assert.deepEqual(events, [[4, 0, 0], [4, 2, 34]]);
});

test('UArrayProperty::SerializeItem reports the missing native realloc boundary on load', () => {
  const p = prop('ArrayProperty', {inner: prop('IntProperty', {elementSize: 4})});
  const archive = streamArchive({loading: true, input: [1]});
  assert.throws(() => serializeArrayItem(p, archive,
    holder({data: [], arrayNum: 0, arrayMax: 0}), {key: 'missing-realloc'}), /FArray::Realloc/);
});

// --- UMapProperty::SerializeItem ----------------------------------------------

test('UMapProperty::SerializeItem is an immediate no-op', () => {
  const ar = rawArchive();
  const result = serializeMapItem();
  assert.equal(ar.bytes, 0);
  assert.equal(result.kind, 'MapProperty');
});

// --- UBoolProperty::SerializeItem ----------------------------------------------

test('UBoolProperty::SerializeItem writes exactly one byte', () => {
  for (const word of [0, 4, 0xffffffff]) {
    const ar = rawArchive();
    const p = prop('BoolProperty', {boolMask: 4});
    serializeBoolItem(p, ar, holder(word), {key: 'b', property: p});
    assert.equal(ar.bytes, 1);
  }
});

test('UBoolProperty::SerializeItem requires a nonzero mask', () => {
  const ar = rawArchive();
  const p = prop('BoolProperty', {});
  assert.throws(() => serializeBoolItem(p, ar, holder(1), {key: 'b', property: p}), /mask/);
});

// --- dispatch -------------------------------------------------------------------

test('serializeScriptPropertyItem dispatches all supported kinds', () => {
  const events = [];
  const ar = rawArchive(events);
  const cases = [
    [prop('IntProperty', {}), 1, 4],
    [prop('ByteProperty', {}), 1, 1],
    [prop('FloatProperty', {}), 1.5, 4],
    [prop('BoolProperty', {boolMask: 2}), 2, 1],
  ];
  let total = 0;
  for (const [p, value, width] of cases) {
    const ar2 = rawArchive();
    serializeScriptPropertyItem(p, ar2, holder(value), {key: 'k', property: p});
    assert.equal(ar2.bytes, width, p.kind);
    total += width;
  }
});

test('serializeScriptPropertyItem routes object and name kinds to the archive operators', () => {
  const events = [];
  const ar = {
    serializeRaw() { return this; },
    objectReference(ref) { events.push(['object', ref.get()]); return this; },
    nameReference(ref) { events.push(['name', ref.get()]); return this; },
  };
  const obj = prop('ObjectProperty', {});
  serializeScriptPropertyItem(obj, ar, holder('O1'), {key: 'k', property: obj});
  const name = prop('NameProperty', {});
  serializeScriptPropertyItem(name, ar, holder('N1'), {key: 'k', property: name});
  assert.deepEqual(events, [['object', 'O1'], ['name', 'N1']]);
});

test('serializeScriptPropertyItem routes Str/Array/Map to their bodies', () => {
  const events = [];
  const ar = rawArchive(events);
  const strP = prop('StrProperty', {});
  serializeScriptPropertyItem(strP, ar, holder(fstringRecord('a', 2)), {key: 's', property: strP});
  assert.equal(ar.bytes, 6);

  const arrP = prop('ArrayProperty', {inner: prop('IntProperty', {})});
  serializeScriptPropertyItem(arrP, ar, holder([1]), {key: 'a', property: arrP});
  assert.equal(ar.bytes, 6 + 4 + 4);

  const mapP = prop('MapProperty', {});
  serializeScriptPropertyItem(mapP, ar, holder({}), {key: 'm', property: mapP});
  assert.equal(ar.bytes, 6 + 4 + 4 + 0);
});

test('serializeScriptPropertyItem routes FixedArray and Struct to their recovered bodies', () => {
  const ar = rawArchive();
  const fixedP = prop('FixedArrayProperty', {
    inner: prop('ByteProperty', {elementSize: 1}),
    fixedArraySize: 2,
  });
  const fixed = serializeScriptPropertyItem(fixedP, ar, holder([1, 2]), {key: 'fixed', property: fixedP});
  assert.equal(fixed.kind, 'FixedArrayProperty');
  assert.equal(fixed.measuredBytes, 2);

  const structP = prop('StructProperty', {
    struct: {key: 'fixture.Dispatch', fields: [prop('ByteProperty', {name: 'value', elementSize: 1})]},
  });
  const struct = serializeScriptPropertyItem(structP, ar, holder({value: 7}), {key: 'struct', property: structP});
  assert.equal(struct.kind, 'StructProperty');
  assert.equal(struct.serializeBinBody, 0x10126610);
  assert.equal(struct.measuredBytes, 1);
  assert.equal(ar.bytes, 3);
});

test('UFixedArrayProperty::SerializeItem loops Inner at the linked stride without a count header', () => {
  const events = [];
  const ar = rawArchive(events);
  const inner = prop('IntProperty', {elementSize: 4});
  const fixedP = prop('FixedArrayProperty', {inner, fixedArraySize: 3});
  const result = serializeFixedArrayItem(fixedP, ar, holder([11, 22, 33]), {key: 'f', property: fixedP});
  assert.equal(ar.bytes, 12);
  assert.equal(result.count, 3);
  assert.equal(result.stride, 4);
  assert.deepEqual(events.map(event => event[3]), [4, 4, 4]);
});

test('UFixedArrayProperty::SerializeItem returns before Inner when Count is zero', () => {
  const ar = rawArchive();
  const fixedP = prop('FixedArrayProperty', {fixedArraySize: 0});
  const result = serializeScriptPropertyItem(fixedP, ar, holder([]), {key: 'f', property: fixedP});
  assert.equal(ar.bytes, 0);
  assert.equal(result.count, 0);
  assert.equal(result.inner, null);
});

test('UStructProperty::SerializeItem preloads then walks Children and inherited members', () => {
  const events = [];
  const preloads = [];
  const ar = rawArchive(events);
  ar.preloadStruct = (structure, context) => preloads.push([structure.key, context.archiveVirtualSlot]);
  const baseMember = prop('ByteProperty', {name: 'baseByte', arrayDim: 1, elementSize: 1});
  const directMember = prop('IntProperty', {name: 'directInt', arrayDim: 1, elementSize: 4});
  const structure = {
    key: 'fixture.Struct',
    children: [directMember],
    superStruct: {children: [baseMember]},
  };
  const structP = prop('StructProperty', {struct: structure});
  const result = serializeStructItem(structP, ar,
    holder({directInt: 7, baseByte: 3}), {key: 's', property: structP});
  assert.deepEqual(preloads, [['fixture.Struct', 0x10]]);
  assert.equal(result.serializeBinBody, 0x10126610);
  assert.equal(result.measuredBytes, 5);
  assert.deepEqual(events.map(event => event[3]), [4, 1]);
  assert.deepEqual(result.members.map(member => member.key), ['directInt', 'baseByte']);
});

test('UStructProperty::SerializeBin applies native and persistent transient flags', () => {
  const calls = [];
  const ar = rawArchive();
  const native = prop('IntProperty', {name: 'native', flags: 0x1000, elementSize: 4});
  const transient = prop('ByteProperty', {name: 'transient', flags: 0x2000, elementSize: 1});
  const ordinary = prop('ByteProperty', {name: 'ordinary', flags: 0, elementSize: 1});
  const structure = {key: 'fixture.Flags', fields: [native, transient, ordinary]};
  const p = prop('StructProperty', {struct: structure});
  serializeStructItem(p, ar, holder({native: 1, transient: 2, ordinary: 3}), {key: 's', property: p}, {persistent: true});
  assert.equal(ar.bytes, 1);
  assert.equal(calls.length, 0);
  const result = serializeStructItem(p, rawArchive(), holder({native: 1, transient: 2, ordinary: 3}), {key: 's', property: p});
  assert.equal(result.measuredBytes, 2);
  assert.deepEqual(result.members.map(member => member.skipped ?? null), ['native', null, null]);
});

test('the recovered measure byte counts match the native probe oracle', () => {
  const ar = rawArchive();
  serializeStrItem(prop('StrProperty', {}), ar, holder(fstringRecord('', 0, 0)), {key: 's', property: prop('StrProperty', {})});
  assert.equal(ar.bytes, 4); // str_empty (raw Num=0)
  const allocated = rawArchive();
  serializeStrItem(prop('StrProperty', {}), allocated, holder(fstringRecord('', 1)), {key: 's', property: prop('StrProperty', {})});
  assert.equal(allocated.bytes, 5); // allocated empty Num=1
  assert.equal(SCRIPT_PROPERTY_SERIALIZE_ITEM.offsets.compactIndexWidth, 4);
  assert.equal(SCRIPT_PROPERTY_SERIALIZE_ITEM.offsets.fStringArrayNum, 4);
  assert.equal(SCRIPT_PROPERTY_SERIALIZE_ITEM.offsets.fStringArrayMax, 8);
});
