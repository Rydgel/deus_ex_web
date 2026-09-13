import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCRIPT_BOOL_PROPERTY_LINK,
  UnsupportedScriptBoolPropertyLinkError,
  linkScriptBoolProperty,
  linkBoolProperty,
} from '../src/runtime/script-bool-property-link.mjs';
import {linkScriptProperty} from '../src/runtime/script-property-link.mjs';
import {linkScriptStruct, SCRIPT_STRUCT_LINK as S} from '../src/runtime/script-struct-link.mjs';

const BOOL_VTABLE = SCRIPT_BOOL_PROPERTY_LINK.boolProperty.vtable; // 0x10175c84
const UCLASS_VTABLE = 0x101758f4;
const UFUNCTION_VTABLE = 0x10175738;

function slotMap(entries = []) {
  return new Map(entries.map(([offset, value, width = 4]) => [offset, {value, width}]));
}
const get = (object, offset) => object.nativeSlots.get(offset)?.value;

function boolProp(outer, extra = []) {
  return {kind: 'BoolProperty', nativeSlots: slotMap([
    [0x00, BOOL_VTABLE], [0x18, outer], [0x34, 1], [0x38, 0], [0x48, 0], [0x5c, 0], ...extra,
  ])};
}

test('UBoolProperty::Link packs consecutive bools into one DWORD via a shifting bitmask', () => {
  const outer = {nativeSlots: slotMap([[0x3c, 0x10]])};
  let mergeCalls = 0, sizeCalls = 0;
  const services = {
    mergeBools(o) { mergeCalls++; assert.equal(o, outer); return 1; },
    getPropertiesSize(o) { sizeCalls++; assert.equal(o, outer); return 0x10; },
  };

  const b0 = boolProp(outer);
  const r0 = linkScriptBoolProperty(b0, {archive: {}, previousProperty: null, services});
  assert.equal(r0.packed, false);
  assert.equal(get(b0, 0x5c), 1); assert.equal(get(b0, 0x48), 0x10); assert.equal(get(b0, 0x38), 4);

  const b1 = boolProp(outer);
  const r1 = linkScriptBoolProperty(b1, {archive: {}, previousProperty: b0, services});
  assert.equal(r1.packed, true);
  assert.equal(get(b1, 0x5c), 2); assert.equal(get(b1, 0x48), 0x10); assert.equal(get(b1, 0x38), 4);

  const b2 = boolProp(outer);
  const r2 = linkScriptBoolProperty(b2, {archive: {}, previousProperty: b1, services});
  assert.equal(r2.packed, true);
  assert.equal(get(b2, 0x5c), 4); assert.equal(get(b2, 0x48), 0x10); assert.equal(get(b2, 0x38), 4);

  // MergeBools is consulted every call (native +0x58 is unconditional);
  // GetPropertiesSize only on the fresh path.
  assert.equal(mergeCalls, 3);
  assert.equal(sizeCalls, 1);
});

test('UBoolProperty::Link starts a fresh DWORD once bit 31 is taken', () => {
  const outer = {nativeSlots: slotMap([[0x3c, 0x20]])};
  const services = {mergeBools: () => 1, getPropertiesSize: () => 0x20};

  // Previous bool already at bit 30 packs up to bit 31.
  const prevBit30 = boolProp(outer, [[0x5c, 0x40000000], [0x48, 0x1c]]);
  const packs = boolProp(outer);
  linkScriptBoolProperty(packs, {archive: {}, previousProperty: prevBit30, services});
  assert.equal(get(packs, 0x5c), 0x80000000);
  assert.equal(get(packs, 0x48), 0x1c);

  // Previous bool at bit 31 (0x80000000) cannot shift further: fresh DWORD.
  const prevBit31 = boolProp(outer, [[0x5c, 0x80000000], [0x48, 0x1c]]);
  const overflow = boolProp(outer);
  const result = linkScriptBoolProperty(overflow, {archive: {}, previousProperty: prevBit31, services});
  assert.equal(result.packed, false);
  assert.equal(get(overflow, 0x5c), 1);
  assert.equal(get(overflow, 0x48), 0x20);
});

test('UBoolProperty::Link only packs after another bool (Cast<UBoolProperty>)', () => {
  const outer = {nativeSlots: slotMap([[0x3c, 0x0c]])};
  const services = {mergeBools: () => 1, getPropertiesSize: () => 0x0c};
  const prevInt = {kind: 'IntProperty', nativeSlots: slotMap([[0x5c, 1], [0x48, 0x08]])};
  const prop = boolProp(outer);
  const result = linkScriptBoolProperty(prop, {archive: {}, previousProperty: prevInt, services});
  assert.equal(result.packed, false);
  assert.equal(get(prop, 0x5c), 1);
  assert.equal(get(prop, 0x48), 0x0c); // Align(0x0c,4)
});

test('UBoolProperty::Link never packs when the Outer is a UFunction (MergeBools = 0)', () => {
  const outer = {nativeSlots: slotMap([[0x3c, 0x10]])};
  const b0 = boolProp(outer);
  const b1 = boolProp(outer);
  const services = {mergeBools: () => 0, getPropertiesSize: () => 0x10};
  linkScriptBoolProperty(b0, {archive: {}, previousProperty: null, services});
  const r1 = linkScriptBoolProperty(b1, {archive: {}, previousProperty: b0, services});
  assert.equal(r1.packed, false);
  assert.equal(get(b0, 0x5c), 1);
  assert.equal(get(b1, 0x5c), 1);
});

test('UBoolProperty::Link resolves MergeBools and GetPropertiesSize from known Outer vtables', () => {
  // UClass Outer -> MergeBools 1 (packs); size read from +0x3c.
  const uclass = {nativeSlots: slotMap([[0x00, UCLASS_VTABLE], [0x3c, 0x0d]])};
  const c0 = boolProp(uclass);
  linkScriptBoolProperty(c0, {archive: {}, previousProperty: null, services: {}});
  assert.equal(get(c0, 0x48), 0x10); // Align(0x0d,4)
  const c1 = boolProp(uclass);
  const rc1 = linkScriptBoolProperty(c1, {archive: {}, previousProperty: c0, services: {}});
  assert.equal(rc1.packed, true);
  assert.equal(get(c1, 0x5c), 2);

  // UFunction Outer -> MergeBools 0 (never packs).
  const ufunc = {nativeSlots: slotMap([[0x00, UFUNCTION_VTABLE], [0x3c, 0x10]])};
  const f0 = boolProp(ufunc);
  const f1 = boolProp(ufunc);
  linkScriptBoolProperty(f0, {archive: {}, previousProperty: null, services: {}});
  const rf1 = linkScriptBoolProperty(f1, {archive: {}, previousProperty: f0, services: {}});
  assert.equal(rf1.packed, false);
  assert.equal(get(f1, 0x5c), 1);

  assert.equal(SCRIPT_BOOL_PROPERTY_LINK.outerMergeBools.get(UCLASS_VTABLE), 1);
  assert.equal(SCRIPT_BOOL_PROPERTY_LINK.outerMergeBools.get(UFUNCTION_VTABLE), 0);
});

test('UBoolProperty::Link rejects the wrong kind and vtable, and an unverified Outer', () => {
  const outer = {nativeSlots: slotMap([[0x3c, 4]])};
  const wrongKind = {kind: 'IntProperty', nativeSlots: slotMap([[0x00, 0x10175bc4], [0x18, outer]])};
  assert.throws(() => linkScriptBoolProperty(wrongKind, {archive: {}}), error =>
    error instanceof UnsupportedScriptBoolPropertyLinkError &&
    error.code === 'UNSUPPORTED_SCRIPT_BOOL_PROPERTY_LINK' && /does not implement IntProperty/.test(error.message));

  const wrongVtable = {kind: 'BoolProperty', nativeSlots: slotMap([[0x00, 0x10175bc4], [0x18, outer]])};
  assert.throws(() => linkScriptBoolProperty(wrongVtable, {archive: {}}), /does not match BoolProperty/);

  const unverifiedOuter = boolProp({nativeSlots: slotMap([[0x00, 0x1badf00d], [0x3c, 4]])});
  assert.throws(() => linkScriptBoolProperty(unverifiedOuter, {archive: {}}),
    /Outer MergeBools \(\+0x58\)/);

  assert.throws(() => linkScriptBoolProperty({}, {archive: {}}), /native property kind/);
  assert.throws(() => linkScriptBoolProperty(boolProp(outer), {archive: null}), TypeError);
});

test('the property-link dispatcher routes BoolProperty to the packing body and scalars to the scalar body', () => {
  const outer = {nativeSlots: slotMap([[0x3c, 0x08]])};
  const services = {mergeBools: () => 1, getPropertiesSize: () => 0x08};

  const b0 = boolProp(outer);
  linkScriptProperty(b0, {archive: {}, previousProperty: null, services});
  const b1 = boolProp(outer);
  const rb1 = linkScriptProperty(b1, {archive: {}, previousProperty: b0, services});
  assert.equal(rb1.kind, 'BoolProperty');
  assert.equal(get(b1, 0x5c), 2);
  assert.equal(get(b1, 0x48), 0x08);

  const int = {kind: 'IntProperty', nativeSlots: slotMap([[0x00, 0x10175bc4], [0x18, outer], [0x38, 0], [0x48, 0]])};
  const ri = linkScriptProperty(int, {archive: {}, previousProperty: b1, services});
  assert.equal(ri.kind, 'IntProperty');
  assert.equal(get(int, 0x38), 4);
  assert.equal(get(int, 0x48), 0x08); // Align(0x08,4)
});

test('UStruct::Link lays out a mixed int/bool/bool/int class with the bools sharing one DWORD', () => {
  // Minimal UField class scaffolding shared with script-struct-link.test.mjs.
  const record = values => ({nativeSlots: new Map(Object.entries(values).map(([offset, value]) =>
    [Number(offset), {value, width: 4}]))});
  const fieldClass = record({0x28: null}); fieldClass.nativeAddress = 0x101f2b18;
  const propertyClass = record({0x28: fieldClass}); propertyClass.nativeAddress = S.propertyClass;

  const cls = record({0x00: UCLASS_VTABLE, 0x28: null, 0x38: null, 0x3c: 0});
  cls.objectClass = {nativeAddress: S.classClass};

  const field = (kind, vtable) => {
    const value = record({0x00: vtable, 0x18: cls, 0x2c: null, 0x34: 1, 0x38: 4, 0x3c: 0, 0x48: 0, 0x5c: 0});
    value.kind = kind; value.objectClass = propertyClass;
    return value;
  };
  const int0 = field('IntProperty', 0x10175bc4);
  const bool0 = field('BoolProperty', BOOL_VTABLE);
  const bool1 = field('BoolProperty', BOOL_VTABLE);
  const int1 = field('IntProperty', 0x10175bc4);
  cls.nativeSlots.get(0x38).value = int0;
  int0.nativeSlots.get(0x2c).value = bool0;
  bool0.nativeSlots.get(0x2c).value = bool1;
  bool1.nativeSlots.get(0x2c).value = int1;

  const archive = {};
  linkScriptStruct(cls, {archive, secondArgument: 1, services: {preload() {}}});

  // int0 at 0, bools share the DWORD at 4 (bit 1 then bit 2), int1 after at 8.
  assert.equal(get(int0, 0x48), 0x00);
  assert.equal(get(bool0, 0x48), 0x04); assert.equal(get(bool0, 0x5c), 1);
  assert.equal(get(bool1, 0x48), 0x04); assert.equal(get(bool1, 0x5c), 2);
  assert.equal(get(int1, 0x48), 0x08);
  assert.equal(get(cls, 0x3c), 0x0c); // total PropertiesSize
});

test('the callback shape mirrors the options form for UStruct::Link', () => {
  const outer = {nativeSlots: slotMap([[0x3c, 0x04]])};
  const services = {mergeBools: () => 1, getPropertiesSize: () => 0x04};
  const prop = boolProp(outer);
  const result = linkBoolProperty(prop, {}, null, services);
  assert.equal(result.kind, 'BoolProperty');
  assert.equal(get(prop, 0x5c), 1);
  assert.equal(get(prop, 0x48), 0x04);
});
