import test from 'node:test';
import assert from 'node:assert/strict';
import {linkScriptProperty, linkProperty} from '../src/runtime/script-property-link.mjs';
import {linkScriptStrProperty, linkStrProperty, UnsupportedScriptStrPropertyLinkError} from '../src/runtime/script-str-property-link.mjs';
import {linkScriptArrayProperty, linkArrayProperty, UnsupportedScriptArrayPropertyLinkError} from '../src/runtime/script-array-property-link.mjs';
import {linkScriptFixedArrayProperty, linkFixedArrayProperty, UnsupportedScriptFixedArrayPropertyLinkError} from '../src/runtime/script-fixed-array-property-link.mjs';
import {linkScriptMapProperty, linkMapProperty, UnsupportedScriptMapPropertyLinkError} from '../src/runtime/script-map-property-link.mjs';
import {linkScriptStructProperty, linkStructProperty, UnsupportedScriptStructPropertyLinkError} from '../src/runtime/script-struct-property-link.mjs';
import {linkScriptStruct, SCRIPT_STRUCT_LINK as S} from '../src/runtime/script-struct-link.mjs';
import {SCRIPT_STR_PROPERTY_LINK as STR} from '../src/runtime/script-str-property-link.mjs';
import {SCRIPT_ARRAY_PROPERTY_LINK} from '../src/runtime/script-array-property-link.mjs';
import {SCRIPT_FIXED_ARRAY_PROPERTY_LINK as FIXED} from '../src/runtime/script-fixed-array-property-link.mjs';
import {SCRIPT_MAP_PROPERTY_LINK} from '../src/runtime/script-map-property-link.mjs';
import {SCRIPT_STRUCT_PROPERTY_LINK as STRUCT_PROP} from '../src/runtime/script-struct-property-link.mjs';

const STR_VTABLE = STR.strProperty.vtable;
const ARRAY_VTABLE = SCRIPT_ARRAY_PROPERTY_LINK.arrayProperty.vtable;
const FIXED_VTABLE = FIXED.fixedArrayProperty.vtable;
const MAP_VTABLE = SCRIPT_MAP_PROPERTY_LINK.mapProperty.vtable;
const STRUCT_VTABLE = STRUCT_PROP.structProperty.vtable;
const INT_VTABLE = 0x10175bc4;
const BOOL_VTABLE = 0x10175c84;
const UCLASS_VTABLE = 0x101758f4;

function slotMap(entries = []) {
  return new Map(entries.map(([offset, value, width = 4]) => [offset, {value, width}]));
}
const get = (object, offset) => object.nativeSlots?.get(offset)?.value;

function uOuter(size) {
  return {nativeSlots: slotMap([[0x00, UCLASS_VTABLE], [0x3c, size]])};
}

function prop(kind, vtable, outer, extra = []) {
  return {kind, nativeSlots: slotMap([
    [0x00, vtable], [0x18, outer], [0x34, 1], [0x38, 4], [0x3c, 0], [0x48, 0], ...extra,
  ])};
}

function svc(size, override = {}) {
  return {preload() {}, getPropertiesSize: () => size, ...override};
}

// --- UStrProperty -----------------------------------------------------------

test('UStrProperty::Link writes FString size, aligned offset and the need-destruction flag', () => {
  const outer = uOuter(0x0d);
  let sizeCalls = 0;
  const p = prop('StrProperty', STR_VTABLE, outer);
  const r = linkScriptStrProperty(p, {archive: {}, services: {
    getPropertiesSize(o) { sizeCalls++; assert.equal(o, outer); return 0x0d; },
  }});
  assert.equal(get(p, 0x38), 0xc);
  assert.equal(get(p, 0x48), 0x10);                   // Align(0x0d, 4)
  assert.equal(get(p, 0x3c) & 0x400000, 0x400000);   // needs destruction
  assert.equal(sizeCalls, 1);
  assert.equal(r.kind, 'StrProperty');
});

test('UStrProperty::Link preserves an atomic property without the flag', () => {
  const p = prop('StrProperty', STR_VTABLE, uOuter(0x08), [[0x3c, 0x1000]]);
  linkScriptStrProperty(p, {archive: {}, services: svc(0x08)});
  assert.equal(get(p, 0x48), 0x08);
  assert.equal(get(p, 0x3c), 0x1000); // untouched
});

// --- UArrayProperty ---------------------------------------------------------

test('UArrayProperty::Link preloads then links a null-Prev Inner before the TArray header', () => {
  const outer = uOuter(0x1c);
  const inner = prop('IntProperty', INT_VTABLE, outer);
  const order = [];
  const archive = {tag: 'ar'};
  const arr = prop('ArrayProperty', ARRAY_VTABLE, outer, [[0x5c, inner]]);
  const r = linkScriptArrayProperty(arr, {archive, services: {
    preload(o, a) { order.push(`preload:${o.kind}:${a.tag}`); },
    linkProperty(o, a, prev) { order.push(`link:${prev}`); return {kind: o.kind}; },
    getPropertiesSize() { order.push('size'); return 0x1c; },
  }});
  assert.deepEqual(order, ['preload:IntProperty:ar', 'link:null', 'size']);
  assert.equal(get(arr, 0x38), 0xc);
  assert.equal(get(arr, 0x48), 0x1c);
  assert.equal(get(arr, 0x3c) & 0x400000, 0x400000);
  assert.equal(r.kind, 'ArrayProperty');
});

test('UArrayProperty Inner recursion routes through the shared dispatcher', () => {
  const outer = uOuter(0x20);
  const inner = prop('BoolProperty', BOOL_VTABLE, outer);
  const arr = prop('ArrayProperty', ARRAY_VTABLE, outer, [[0x5c, inner]]);
  const r = linkScriptArrayProperty(arr, {archive: {}, services: svc(0x20, {mergeBools: () => 1})});
  assert.equal(get(inner, 0x38), 4);   // UBoolProperty::Link ran
  assert.equal(get(inner, 0x5c), 1);   // fresh DWORD, first bit
  assert.equal(get(inner, 0x48), 0x20);
  assert.equal(r.innerResult, 'BoolProperty'); // routed through the dispatcher
});

// --- UFixedArrayProperty ----------------------------------------------------

test('UFixedArrayProperty::Link multiplies Inner by Count and copies the destroy bit', () => {
  const outer = uOuter(0x30);
  const inner = prop('StrProperty', STR_VTABLE, outer, [[0x38, 0xc], [0x3c, 0x400000]]);
  const readsAfter = {value: false};
  const fa = prop('FixedArrayProperty', FIXED_VTABLE, outer, [[0x5c, inner], [0x60, 3]]);
  linkScriptFixedArrayProperty(fa, {archive: {}, services: {
    preload() {},
    linkProperty(o) { readsAfter.value = true; return {kind: o.kind}; },
    getPropertiesSize: () => 0x30,
    readSlot(o, off) {
      if (o === inner && (off === 0x38 || off === 0x3c)) assert.equal(readsAfter.value, true);
      return undefined;
    },
  }});
  assert.equal(get(fa, 0x38), 0x24);         // 0xc * 3
  assert.equal(get(fa, 0x48), 0x30);
  assert.equal(get(fa, 0x3c) & 0x400000, 0x400000); // copied from Inner
});

test('UFixedArrayProperty::Link keeps a plain Inner without the need-destruction bit', () => {
  const outer = uOuter(0x24);
  const inner = prop('IntProperty', INT_VTABLE, outer, [[0x38, 4], [0x3c, 0]]);
  const fa = prop('FixedArrayProperty', FIXED_VTABLE, outer, [[0x5c, inner], [0x60, 2]]);
  linkFixedArrayProperty(fa, {archive: {}, services: svc(0x24)});
  assert.equal(get(fa, 0x38), 8);
  assert.equal(get(fa, 0x3c) & 0x400000, 0);
  assert.equal(get(fa, 0x48), 0x24);
});

test('UFixedArrayProperty recursion routes through the dispatcher and packs inner bools', () => {
  const outer = uOuter(0x28);
  const inner = prop('BoolProperty', BOOL_VTABLE, outer);
  const fa = prop('FixedArrayProperty', FIXED_VTABLE, outer, [[0x5c, inner], [0x60, 2]]);
  linkScriptFixedArrayProperty(fa, {archive: {}, services: svc(0x28, {mergeBools: () => 1})});
  assert.equal(get(inner, 0x38), 4);
  assert.equal(get(fa, 0x38), 8);
  assert.equal(get(fa, 0x48), 0x28);
});

// --- UMapProperty ------------------------------------------------------------

test('UMapProperty::Link links Key then Value children; element size is 0x14', () => {
  const outer = uOuter(0x14);
  const key = prop('IntProperty', INT_VTABLE, outer);
  const value = prop('StrProperty', STR_VTABLE, outer);
  const map = prop('MapProperty', MAP_VTABLE, outer, [[0x5c, key], [0x60, value]]);
  const order = [];
  const r = linkScriptMapProperty(map, {archive: {}, services: {
    preload(o) { order.push(`preload:${o.kind}`); },
    linkProperty(o, a, prev) { order.push(`link:${o.kind}:${prev}`); return {kind: o.kind}; },
    getPropertiesSize() { order.push('size'); return 0x14; },
  }});
  assert.deepEqual(order, ['preload:IntProperty', 'link:IntProperty:null', 'preload:StrProperty', 'link:StrProperty:null', 'size']);
  assert.equal(get(map, 0x38), 0x14);
  assert.equal(get(map, 0x48), 0x14);
  assert.equal(get(map, 0x3c) & 0x400000, 0x400000);
  assert.equal(r.kind, 'MapProperty');
});

test('UMapProperty child recursion goes through the shared dispatcher', () => {
  const outer = uOuter(0x10);
  const key = prop('IntProperty', INT_VTABLE, outer);
  const fixedInner = prop('IntProperty', INT_VTABLE, outer, [[0x38, 4]]);
  const value = prop('FixedArrayProperty', FIXED_VTABLE, outer, [[0x5c, fixedInner], [0x60, 2]]);
  const map = prop('MapProperty', MAP_VTABLE, outer, [[0x5c, key], [0x60, value]]);
  const r = linkMapProperty(map, {archive: {}, services: svc(0x10)});
  assert.equal(get(key, 0x48), 0x10);
  assert.equal(r.keyResult, 'IntProperty');
  assert.equal(r.valueResult, 'FixedArrayProperty');
});

// --- UStructProperty -------------------------------------------------------------

test('UStructProperty::Link aligns the Outer size by the inner struct size rule', () => {
  const structOf = size => ({nativeSlots: slotMap([[0x3c, size], [0x68, 0]])});

  const sp2 = prop('StructProperty', STRUCT_VTABLE, uOuter(0x13), [[0x5c, structOf(2)]]);
  linkScriptStructProperty(sp2, {archive: {}, services: svc(0x13)});
  assert.equal(get(sp2, 0x38), 2);
  assert.equal(get(sp2, 0x48), 0x14);   // Align(0x13, 2)

  const sp3 = prop('StructProperty', STRUCT_VTABLE, uOuter(0x13), [[0x5c, structOf(3)]]);
  linkStructProperty(sp3, {archive: {}, services: svc(0x13)});
  assert.equal(get(sp3, 0x38), 3);
  assert.equal(get(sp3, 0x48), 0x13);   // Align(0x13, 1)

  const sp4 = prop('StructProperty', STRUCT_VTABLE, uOuter(0x11), [[0x5c, structOf(4)]]);
  linkScriptStructProperty(sp4, {archive: {}, services: svc(0x11)});
  assert.equal(get(sp4, 0x48), 0x14);   // Align(0x11, 4)
});

test('UStructProperty sets need-destruction only for an inner struct with a destroy chain', () => {
  const clean = {nativeSlots: slotMap([[0x3c, 8], [0x68, 0]])};
  const sp = prop('StructProperty', STRUCT_VTABLE, uOuter(8), [[0x5c, clean]]);
  linkScriptStructProperty(sp, {archive: {}, services: svc(8)});
  assert.equal(get(sp, 0x3c) & 0x400000, 0);

  const dirty = {nativeSlots: slotMap([[0x3c, 8], [0x68, 0xdeadbeef]])};
  const sp2 = prop('StructProperty', STRUCT_VTABLE, uOuter(8), [[0x5c, dirty]]);
  linkScriptStructProperty(sp2, {archive: {}, services: svc(8)});
  assert.equal(get(sp2, 0x3c) & 0x400000, 0x400000);

  const sp3 = prop('StructProperty', STRUCT_VTABLE, uOuter(8), [[0x5c, dirty], [0x3c, 0x1000]]);
  linkScriptStructProperty(sp3, {archive: {}, services: svc(8)});
  assert.equal(get(sp3, 0x3c), 0x1000);
});

// --- dispatcher ---------------------------------------------------------------

test('the dispatcher routes all five complex kinds and the callback shape mirrors it', () => {
  const outer = uOuter(0x0c);
  const opts = {archive: {}, services: svc(0x0c)};

  const str = prop('StrProperty', STR_VTABLE, outer);
  const rs = linkProperty(str, {}, null);
  assert.equal(rs.kind, 'StrProperty');
  assert.equal(get(str, 0x38), 0xc);

  const inner = prop('IntProperty', INT_VTABLE, outer);
  const arr = prop('ArrayProperty', ARRAY_VTABLE, outer, [[0x5c, inner]]);
  const ra = linkScriptProperty(arr, opts);
  assert.equal(ra.kind, 'ArrayProperty');
  assert.equal(get(arr, 0x38), 0xc);

  const fa = prop('FixedArrayProperty', FIXED_VTABLE, outer, [[0x5c, inner], [0x60, 4]]);
  const rfa = linkScriptProperty(fa, opts);
  assert.equal(rfa.kind, 'FixedArrayProperty');
  assert.equal(get(fa, 0x38), 0x10);

  const key = prop('IntProperty', INT_VTABLE, outer);
  const value = prop('BoolProperty', BOOL_VTABLE, outer);
  const map = prop('MapProperty', MAP_VTABLE, outer, [[0x5c, key], [0x60, value]]);
  const rmap = linkScriptProperty(map, {archive: {}, services: svc(0x0c, {mergeBools: () => 1})});
  assert.equal(rmap.kind, 'MapProperty');
  assert.equal(get(map, 0x38), 0x14);

  const st = prop('StructProperty', STRUCT_VTABLE, outer, [[0x5c, {nativeSlots: slotMap([[0x3c, 8], [0x68, 0]])}]]);
  const rst = linkScriptProperty(st, opts);
  assert.equal(rst.kind, 'StructProperty');
  assert.equal(get(st, 0x38), 8);
});

test('complex bodies reject wrong kinds, missing natives, wrong vtables and null archives', () => {
  const cases = [
    ['ArrayProperty', ARRAY_VTABLE, UnsupportedScriptArrayPropertyLinkError, linkScriptArrayProperty],
    ['FixedArrayProperty', FIXED_VTABLE, UnsupportedScriptFixedArrayPropertyLinkError, linkScriptFixedArrayProperty],
    ['MapProperty', MAP_VTABLE, UnsupportedScriptMapPropertyLinkError, linkScriptMapProperty],
    ['StructProperty', STRUCT_VTABLE, UnsupportedScriptStructPropertyLinkError, linkScriptStructProperty],
  ];
  for (const [kind, vtable, ErrorType, fn] of cases) {
    const outer = uOuter(8);
    const wrong = prop('IntProperty', INT_VTABLE, outer);
    assert.throws(() => fn(wrong, {archive: {}}), ErrorType);
    assert.throws(() => fn(wrong, {archive: {}}), /does not implement IntProperty/);
    assert.throws(() => fn({}, {archive: {}}), ErrorType);
    assert.throws(() => fn(prop(kind, vtable, outer), {archive: null}), TypeError);
    const bad = prop(kind, 0x1badf00d, outer);
    assert.throws(() => fn(bad, {archive: {}}), /does not match/);
  }
  // StrProperty additionally.
  assert.throws(() => linkScriptStrProperty(prop('IntProperty', INT_VTABLE, uOuter(8)), {archive: {}}), /does not implement/);
});

test('complex bodies require their child records', () => {
  const outer = uOuter(8);
  assert.throws(() => linkScriptArrayProperty(prop('ArrayProperty', ARRAY_VTABLE, outer), {archive: {}}), /non-null Inner/);
  assert.throws(() => linkMapProperty(prop('MapProperty', MAP_VTABLE, outer), {archive: {}}), /non-null Key/);
  assert.throws(() => linkMapProperty(prop('MapProperty', MAP_VTABLE, outer, [[0x5c, 0x1234]]), {archive: {}}), /non-null Value/);
  assert.throws(() => linkScriptStructProperty(prop('StructProperty', STRUCT_VTABLE, outer), {archive: {}}), /non-null inner Struct/);
  assert.throws(() => linkScriptFixedArrayProperty(prop('FixedArrayProperty', FIXED_VTABLE, outer), {archive: {}}), /non-null Inner/);
});

// --- integration with UStruct::Link ----------------------------------------x

function record(values) {
  return {nativeSlots: new Map(Object.entries(values).map(([offset, value]) => [Number(offset), {value, width: 4}]))};
}
function classRecord() {
  const fieldClass = record({0x28: null}); fieldClass.nativeAddress = 0x101f2b18;
  const propertyClass = record({0x28: fieldClass}); propertyClass.nativeAddress = S.propertyClass;
  const cls = record({0x00: UCLASS_VTABLE, 0x28: null, 0x38: null, 0x3c: 0});
  cls.objectClass = {nativeAddress: S.classClass};
  const field = (kind, vtable, extra = {}) => {
    const value = record({0x00: vtable, 0x18: cls, 0x2c: null, 0x34: 1, 0x38: 4, 0x3c: 0, 0x48: 0, ...extra});
    value.kind = kind; value.objectClass = propertyClass;
    return value;
  };
  return {cls, field};
}

test('UStruct::Link lays out string, bool and int fields with the destroy chain', () => {
  const {cls, field} = classRecord();
  const str = field('StrProperty', STR_VTABLE);
  const bool0 = field('BoolProperty', BOOL_VTABLE);
  const bool1 = field('BoolProperty', BOOL_VTABLE);
  const int1 = field('IntProperty', INT_VTABLE);
  cls.nativeSlots.get(0x38).value = str;
  str.nativeSlots.get(0x2c).value = bool0;
  bool0.nativeSlots.get(0x2c).value = bool1;
  bool1.nativeSlots.get(0x2c).value = int1;

  linkScriptStruct(cls, {archive: {}, secondArgument: 1, services: {preload() {}}});

  assert.equal(get(str, 0x48), 0x00);
  assert.equal(get(str, 0x38), 0xc);
  assert.equal(get(bool0, 0x48), 0x0c); assert.equal(get(bool0, 0x5c), 1);
  assert.equal(get(bool1, 0x48), 0x0c); assert.equal(get(bool1, 0x5c), 2);
  assert.equal(get(int1, 0x48), 0x10);
  assert.equal(get(cls, 0x3c), 0x14);

  // String paints the destroy flag; the destroy chain head points at it.
  assert.equal(get(str, 0x3c) & 0x400000, 0x400000);
  assert.equal(get(cls, 0x68), str);
  assert.equal(str.nativeSlots.get(0x54)?.value, null);
});

test('UStruct::Link lays out array fields and inner element offsets', () => {
  const {cls, field} = classRecord();
  const el = {kind: 'IntProperty', nativeSlots: slotMap([[0x00, INT_VTABLE], [0x18, cls], [0x38, 4]])};
  const arr = field('ArrayProperty', ARRAY_VTABLE, {0x5c: el});
  const arr2 = field('ArrayProperty', ARRAY_VTABLE, {0x5c: el});
  cls.nativeSlots.get(0x38).value = arr;
  arr.nativeSlots.get(0x2c).value = arr2;

  linkScriptStruct(cls, {archive: {}, secondArgument: 1, services: {preload() {}}});
  assert.equal(get(arr, 0x48), 0x00);
  assert.equal(get(arr2, 0x48), 0x0c);
  assert.equal(get(cls, 0x3c), 0x18);
});