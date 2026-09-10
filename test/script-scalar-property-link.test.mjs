import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCRIPT_SCALAR_PROPERTY_LINK,
  UnsupportedScriptScalarPropertyLinkError,
  linkScalarProperty,
} from '../src/runtime/script-scalar-property-link.mjs';

function slotMap(entries = []) {
  return new Map(entries.map(([offset, value, width = 4]) => [offset, {value, width}]));
}

test('scalar UProperty::Link dispatches verified bodies, preserves order, and rejects unsupported kinds', () => {
  const cases = [
    ['ByteProperty', 5, 5],
    ['IntProperty', 5, 8],
    ['FloatProperty', 6, 8],
    ['NameProperty', 9, 12],
    ['ObjectProperty', 10, 12],
    ['ClassProperty', 13, 16],
  ];
  let previous = null;
  for (const [kind, outerSize, expectedOffset] of cases) {
    const outer = {nativeSlots: slotMap([[0x3c, outerSize]])};
    const property = {
      kind,
      nativeSlots: slotMap([
        [0x00, SCRIPT_SCALAR_PROPERTY_LINK.properties[kind].vtable],
        [0x18, outer],
        [0x38, 0],
        [0x48, 0],
      ]),
    };
    const events = [];
    const result = linkScalarProperty(property, {}, previous, {
      getPropertiesSize(receiver, detail) {
        events.push(['size', receiver, detail.previousProperty]);
        assert.equal(property.nativeSlots.get(0x38).value,
          SCRIPT_SCALAR_PROPERTY_LINK.properties[kind].elementSize);
        return outerSize;
      },
    });
    assert.equal(result.kind, kind);
    assert.equal(result.previousProperty, previous);
    assert.equal(property.nativeSlots.get(0x38).value,
      SCRIPT_SCALAR_PROPERTY_LINK.properties[kind].elementSize);
    assert.equal(property.nativeSlots.get(0x48).value, expectedOffset);
    assert.deepEqual(events, [['size', outer, previous]]);
    previous = property;
  }
  const outer = {nativeSlots: slotMap([[0x3c, 4]])};
  const unsupported = {
    kind: 'BoolProperty',
    nativeSlots: slotMap([[0x00, 0x10175c84], [0x18, outer]]),
  };
  assert.throws(() => linkScalarProperty(unsupported, {}), error =>
    error instanceof UnsupportedScriptScalarPropertyLinkError &&
    error.code === 'UNSUPPORTED_SCRIPT_SCALAR_PROPERTY_LINK' && /does not implement/.test(error.message));

  const wrongVtable = {
    kind: 'IntProperty',
    nativeSlots: slotMap([[0x00, 0x10175d44], [0x18, outer]]),
  };
  assert.throws(() => linkScalarProperty(wrongVtable, {}), /does not match IntProperty/);
});
