import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCRIPT_STRUCT_REGISTRATION,
  registerScriptField,
  registerScriptStruct,
} from '../src/runtime/script-struct-registration.mjs';
import {NativeSlots} from '../src/runtime/native-slots.mjs';

test('UStruct Register calls shared UObject/base-field registration before FriendlyName copy', () => {
  const baseField = { key: 'Core.BaseField', index: -1 };
  const record = {
    key: 'Fixture.Struct',
    nameIndex: 23,
    baseField,
    next: { key: 'Fixture.Next' },
    children: { key: 'Fixture.Children' },
    nativeSlots: NativeSlots.from([[SCRIPT_STRUCT_REGISTRATION.struct.friendlyName, { value: 0, width: 4 }]]),
  };
  const registrants = [record, baseField];
  const calls = [];
  const registration = {
    registerUObject(object) {
      calls.push(['uobject', object]);
      return { registered: object };
    },
    conditionalRegister(object, list) {
      calls.push(['conditional', object, list]);
    },
  };

  const result = registerScriptStruct(record, { registration, registrants });
  assert.deepEqual(calls, [
    ['uobject', record], ['conditional', baseField, registrants],
  ]);
  assert.equal(result.baseResult.registered, record);
  assert.equal(result.baseField, baseField);
  assert.equal(result.friendlyName, 23);
  assert.equal(record.friendlyName, 23);
  assert.equal(record.nativeSlots.value(0x40), 23);
  assert.deepEqual(record.next, { key: 'Fixture.Next' });
  assert.deepEqual(record.children, { key: 'Fixture.Children' });
  assert.deepEqual(result.operations.map(operation => operation.operation), [
    'uobject-register', 'conditional-register-base-field', 'friendly-name',
  ]);

  const property = {
    key: 'Fixture.Property',
    nameIndex: 41,
    baseField: null,
    nativeSlots: NativeSlots.from([[SCRIPT_STRUCT_REGISTRATION.struct.friendlyName, { value: 0xdeadbeef, width: 4 }]]),
  };
  const fieldResult = registerScriptField(property, {
    registration: { registerUObject: object => object },
  });
  assert.equal(fieldResult.friendlyName, undefined);
  assert.equal(property.nativeSlots.value(SCRIPT_STRUCT_REGISTRATION.struct.friendlyName), 0xdeadbeef);
  assert.equal(Object.hasOwn(property, 'friendlyName'), false);
});
