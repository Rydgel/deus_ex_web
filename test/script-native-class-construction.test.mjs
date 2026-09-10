import test from 'node:test';
import assert from 'node:assert/strict';
import {ScriptObjectRegistry} from '../src/runtime/script-object-construction.mjs';
import {createScriptNames} from '../src/runtime/script-names.mjs';
import {createScriptNativeRegistration, NATIVE_REGISTRATION,
  CORE_CLASS_CONSTRUCTORS} from '../src/runtime/script-native-registration.mjs';
import {constructNativeScriptClass, nativeClassSlot,
  NATIVE_CLASS_CONSTRUCTION} from '../src/runtime/script-native-class-construction.mjs';

test('original Core.Class constructor inputs reach the live queue and preserve native slot storage', () => {
  const coreClass = {nativeAddress: 0x101f1c18};
  const coreObject = {nativeAddress: 0x1029e0d0};
  const coreState = {nativeAddress: 0x101f2118};
  const corePackage = {nativeAddress: 0x1029b8e0};
  const untouchedName = {value: 913, width: 4};
  const untouchedPadding = {value: 0xbeef, width: 2};
  coreClass.nativeSlots = new Map([[0x40, untouchedName], [0x82, untouchedPadding]]);
  const notReached = () => { throw new Error('Registration is outside this constructor reference case'); };
  const registration = createScriptNativeRegistration({
    registry: new ScriptObjectRegistry(),
    names: createScriptNames({allocator: {free: notReached}}),
    globals: {
      [NATIVE_REGISTRATION.objectGate]: 0,
      [NATIVE_REGISTRATION.registrationGate]: 1,
    },
    coreObjectClass: coreObject,
    createPackage: notReached, staticFindObject: notReached, virtualRegister: notReached,
  });
  const writes = [];
  constructNativeScriptClass(coreClass, {
    registration, coreClass, instanceSize: 0x4f4, classFlags: 0,
    superClass: coreState, withinClass: corePackage, guid: [0, 0, 0, 0],
    nameText: 'Class', packageText: 'Core', configText: 'System',
    objectFlags: 0x04084004,
    instanceConstructor: CORE_CLASS_CONSTRUCTORS.instance,
    staticConstructor: CORE_CLASS_CONSTRUCTORS.static,
    onWrite: write => writes.push(write),
  });
  assert.equal(registration.queueHead, coreClass);
  assert.equal(coreClass.objectClass, coreClass);
  assert.equal(coreClass.index, -1);
  assert.equal(coreClass.flags, 0x04084004);
  assert.equal(coreClass.superClass, coreState);
  assert.equal(coreClass.withinClass, corePackage);
  assert.equal(coreClass.classFlags, 0x12);
  assert.equal(coreClass.propertiesSize, 0x4f4);
  assert.equal(coreClass.nativeInstanceConstructor, 0x10102e0a);
  assert.equal(coreClass.staticConstructor, 0x10101041);
  assert.equal(coreClass.classConfigName, 'System');
  assert.equal(coreClass.defaultBuffer, null);
  assert.equal(coreClass.linkedProperties, null);
  assert.deepEqual(writes.filter(write => write.offset === 0).map(write => write.value),
    [NATIVE_CLASS_CONSTRUCTION.structVtable, NATIVE_CLASS_CONSTRUCTION.classVtable]);
  assert.equal(writes.find(write => write.offset === 0x80).width, 2);
  assert.equal(coreClass.nativeSlots.get(0x40), untouchedName);
  assert.equal(coreClass.nativeSlots.get(0x82), untouchedPadding);
  assert.equal(untouchedName.value, 913);
  assert.equal(untouchedPadding.value, 0xbeef);

  // Registration aliases and metadata serializers use the same mutable slots.
  coreClass.classConfigName = {index: 17, name: 'System'};
  assert.equal(nativeClassSlot(coreClass, 0x4a0).get(), coreClass.classConfigName);
  nativeClassSlot(coreClass, 0x28).set(coreObject);
  assert.equal(coreClass.superClass, coreObject);
  const data = new Uint8Array(0x4f4);
  coreClass.defaultBuffer = {data, size: data.length, capacity: data.length};
  assert.equal(nativeClassSlot(coreClass, 0x4d4).get(), data);
  assert.equal(coreClass.defaultBuffer.size, 0x4f4);
  assert.throws(() => nativeClassSlot(coreClass, 0x84), /Unbound/);

  // Only self Super is nulled; construction still uses the Core.Class identity.
  constructNativeScriptClass(coreObject, {
    registration, coreClass, instanceSize: 0x28, classFlags: 1,
    superClass: coreObject, withinClass: coreObject, guid: [0, 0, 0, 0],
    nameText: 'Object', packageText: 'Core', configText: 'System',
    objectFlags: 0x04084004, instanceConstructor: 0x101017da, staticConstructor: 0x10101041,
  });
  assert.equal(coreObject.superClass, null);
  assert.equal(coreObject.classFlags, 0x13);
  assert.equal(coreObject.objectClass, coreClass);
  assert.equal(registration.queueHead, coreObject);
  assert.equal(coreObject.registrationNext, coreClass);
  assert.equal(coreObject.nativeSlots.has(0x40), false);
});
