import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_OBJECT_HEADER_LAYOUT,
  UCLASS_SUPERCLASS_FLAG_MASK,
  initializeClassDefaultObject,
  registerScriptClass,
} from '../src/runtime/script-class-registration.mjs';

test('UClass Register keeps native order and copies an inherited linked property', () => {
  const parentData = new Uint8Array(0x30);
  parentData.fill(0xa5, 0x28);
  const parent = {
    key: 'Core.Super',
    classFlags: 0x100,
    propertiesSize: 0x30,
    staticConstructor: 0x10101041,
    defaultBuffer: { data: parentData, size: 0x30, capacity: 0x30 },
    linkedProperties: [{ key: 'Core.Super.Value', offset: 0x28, elementSize: 4, arrayDim: 1 }],
  };
  const record = {
    key: 'Fixture.Class',
    classFlags: 0x2,
    propertiesSize: 0x34,
    superClass: parent,
    staticConstructor: 0x10112345,
    vtable: 0x101758f4,
    address: 0x10203040,
    configName: 'System',
  };
  const calls = [];
  let linkGate = 0;
  let linkGateReads = 0;
  const services = {
    registerBase: () => { calls.push('base'); },
    internName: (value, detail) => {
      calls.push(['name', value, detail.findName]);
      return { name: value, index: 7 };
    },
    allocateDefaults: (size, elementSize, detail) => {
      calls.push(['alloc', size, elementSize, detail.kind]);
      return { data: new Uint8Array(size), capacity: size };
    },
    copyCompleteValue: ({ destination, source, destinationOffset, sourceOffset, bytes }) => {
      calls.push('copy');
      destination.set(source.subarray(sourceOffset, sourceOffset + bytes), destinationOffset);
    },
    callStaticConstructor: (data, classRecord, detail) => {
      assert.strictEqual(data, classRecord.defaultBuffer.data);
      assert.equal(classRecord.defaultBuffer.size, 0x34);
      calls.push(['static', detail.pointer]);
    },
    writeDefaultHeader: (data, header) => {
      const raw = new DataView(data.buffer, data.byteOffset, data.byteLength);
      raw.setUint32(DEFAULT_OBJECT_HEADER_LAYOUT.vtable, header.vtable, true);
      raw.setInt32(DEFAULT_OBJECT_HEADER_LAYOUT.index, header.index, true);
      raw.setUint32(DEFAULT_OBJECT_HEADER_LAYOUT.class, header.class.address, true);
    },
    classLink: {
      get globalLinkGate() { linkGateReads += 1; return linkGate; },
      services: {
        linkState: (classRecord, frame, secondArgument) => {
          assert.equal(classRecord.defaultBuffer.size, 0x34);
          calls.push(['virtual', frame.ar04, frame.ar08, secondArgument]);
          linkGate = 1;
        },
      },
    },
    loadConfig: (_data, first, second, third) => {
      calls.push(['config', first, second, third]);
    },
    loadLocalized: (_data, first, second) => {
      calls.push(['localized', first, second]);
    },
  };
  const result = registerScriptClass(record, services);
  assert.equal(linkGateReads, 1);

  assert.deepEqual(calls, [
    'base', ['name', 'System', 1], ['alloc', 0x34, 1, 'defaults-realloc'],
    'copy', ['static', 0x10112345], ['virtual', 0x44, 0x44c, 0],
    ['config', 0, 0, 0], ['localized', 0, 0],
  ]);
  assert.equal(record.classFlags, 0x2 | (0x100 & UCLASS_SUPERCLASS_FLAG_MASK));
  assert.equal(result.defaults.size, 0x34);
  assert.equal(result.defaultObject.index, -1);
  assert.equal(result.defaultObject.linkerIndex, 0);
  assert.equal(result.defaultObject.class, record);
  const raw = new DataView(result.defaults.data.buffer, result.defaults.data.byteOffset, result.defaults.data.byteLength);
  assert.equal(raw.getUint32(DEFAULT_OBJECT_HEADER_LAYOUT.vtable, true), record.vtable);
  assert.equal(raw.getInt32(DEFAULT_OBJECT_HEADER_LAYOUT.index, true), -1);
  assert.equal(raw.getUint32(DEFAULT_OBJECT_HEADER_LAYOUT.class, true), record.address);
  assert.deepEqual([...result.defaults.data.subarray(0x28, 0x2c)], [0xa5, 0xa5, 0xa5, 0xa5]);
  assert.equal(result.operations.at(-1).operation, 'load-localized');

  const { writeDefaultHeader, ...withoutHeaderWriter } = services;
  assert.throws(
    () => initializeClassDefaultObject(record, { data: new Uint8Array(0x34), size: 0x34 }, withoutHeaderWriter),
    error => error.code === 'UNSUPPORTED_SCRIPT_CLASS_REGISTRATION' && /raw CDO header writer/.test(error.message),
  );
  const { internName, ...withoutNameIntern } = services;
  assert.throws(
    () => registerScriptClass({ ...record, defaultBuffer: null }, withoutNameIntern),
    error => error.code === 'UNSUPPORTED_SCRIPT_CLASS_REGISTRATION' && /ClassConfigName adapter/.test(error.message),
  );
  assert.throws(
    () => initializeClassDefaultObject({
      ...record,
      superClass: {...parent, linkedProperties: [{...parent.linkedProperties[0], elementSize: null}]},
    }, {data: new Uint8Array(0x34), size: 0x34}, services),
    error => error.code === 'UNSUPPORTED_SCRIPT_CLASS_REGISTRATION' && /elementSize/.test(error.message),
  );

  // The chains produced by UStruct::Link use live +54 Next and raw layout.
  const rawProperty = (offset, next) => ({nativeSlots: new Map([
    [0x48, {value: offset, width: 4}], [0x38, {value: 4, width: 4}],
    [0x34, {value: 1, width: 4}], [0x54, {value: next, width: 4}],
  ])});
  const secondRaw = rawProperty(0x2c, null);
  const firstRaw = rawProperty(0x28, secondRaw);
  const rawBuffer = {data: new Uint8Array(0x34), size: 0x34};
  initializeClassDefaultObject({...record, superClass: {...parent, linkedProperties: firstRaw}}, rawBuffer, services);
  assert.deepEqual(rawBuffer.copiedProperties, [firstRaw, secondRaw]);
  assert.deepEqual([...rawBuffer.data.subarray(0x28, 0x30)], Array(8).fill(0xa5));
});
