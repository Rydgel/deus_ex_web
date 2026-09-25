import {registerScriptStruct} from './script-struct-registration.mjs';
import {linkScriptClass} from './script-class-link.mjs';
import {loadScriptLocalized} from './script-object-config.mjs';
import {copyCompletePropertyValue} from './script-property-copy.mjs';

/**
 * The reached UClass registration/default-object path from the installed
 * Deus Ex GOTY Core.dll.
 *
 * This module is deliberately a storage and call-order adapter.  Object
 * queueing/registry insertion belongs to the UObject construction host, while
 * UClass::Link at virtual +0x6c, config and localization use concrete native
 * adapters. The byte buffer here represents UClass::Defaults (+0x4d4), not a
 * JavaScript class catalogue.
 */

export const SCRIPT_CLASS_REGISTRATION = Object.freeze({
  register: Object.freeze({ thunk: 0x10101e74, body: 0x10127800 }),
  initClassDefaultObject: Object.freeze({ thunk: 0x10101226, body: 0x10152300 }),
  initProperties: Object.freeze({ thunk: 0x1010102d, body: 0x101520d0 }),
  staticConstructor: Object.freeze({ thunk: 0x10101041, body: 0x1014f690 }),
  loadConfig: Object.freeze({ thunk: 0x101023dd, body: 0x10150d60 }),
  loadLocalized: Object.freeze({ thunk: 0x1010306c, body: 0x10151390 }),
  getPropertiesSize: Object.freeze({ slot: 0x64, thunk: 0x101026e4, body: 0x1010f7c0 }),
  postRegisterVirtual: Object.freeze({ slot: 0x6c, thunk: 0x10102f2c, body: 0x10127e30 }),
  defaults: Object.freeze({ data: 0x4d4, count: 0x4d8, capacity: 0x4dc }),
  uclass: Object.freeze({
    vtable: 0x00,
    super: 0x28,
    propertiesSize: 0x3c,
    classFlags: 0x484,
    classConfigName: 0x4a0,
    defaultsData: 0x4d4,
    defaultsSize: 0x4d8,
    defaultsCapacity: 0x4dc,
    staticConstructor: 0x4e4,
  }),
});

/** UClass's parameterized constructor stores raw input flags OR 0x12. */
export const UCLASS_CONSTRUCTOR_FLAG_OR = 0x12;
/** UClass::Register inherits only these superclass ClassFlags bits. */
export const UCLASS_SUPERCLASS_FLAG_MASK = 0x4ec;
/** InitClassDefaultObject/InitProperties preserve the UObject header. */
export const DEFAULT_OBJECT_HEADER_SIZE = 0x28;
/** UObject header slots written by InitClassDefaultObject after its memset. */
export const DEFAULT_OBJECT_HEADER_LAYOUT = Object.freeze({
  vtable: 0x00,
  index: 0x04,
  hashNext: 0x08,
  stateFrame: 0x0c,
  linker: 0x10,
  linkerIndex: 0x14,
  outer: 0x18,
  flags: 0x1c,
  name: 0x20,
  class: 0x24,
});
/** The local FArchive-shaped value passed to virtual slot +0x6c. */
export const CLASS_REGISTER_FRAME = Object.freeze({
  vtable: 0x101751f8,
  ar04: 0x44,
  ar08: 0x44c,
  ar0c: 0,
  ar10: 0,
  ar14: 0,
  ar18: 0,
  ar1c: 1,
  ar20: 1,
  ar24: 1,
  cleanupFlag: 1,
});

export class UnsupportedScriptClassRegistrationError extends Error {
  constructor(message, { operation = null, slot = null } = {}) {
    super(message);
    this.name = 'UnsupportedScriptClassRegistrationError';
    this.code = 'UNSUPPORTED_SCRIPT_CLASS_REGISTRATION';
    this.operation = operation;
    this.slot = slot;
  }
}

function fail(message, details = {}) {
  throw new UnsupportedScriptClassRegistrationError(message, details);
}

function integer(value, label, { minimum = null } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || (minimum !== null && number < minimum)) {
    throw new TypeError(`Expected integer ${label}, got ${String(value)}`);
  }
  return number;
}

function own(source, key) {
  return source !== null && source !== undefined && Object.hasOwn(source, key);
}

function first(source, keys, fallback = undefined) {
  for (const key of keys) if (source !== null && source !== undefined && source[key] !== undefined) {
    return source[key];
  }
  return fallback;
}

function classSuper(record) {
  return first(record, ['superClass', 'superclass', 'super', 'baseClass', 'base'], null);
}

function classStaticConstructor(record) {
  return first(record, ['staticConstructor', 'staticConstructorAddress', 'staticCtor'],
    first(record?.metadata, ['staticConstructor', 'staticConstructorAddress', 'staticCtor'], null));
}

function classFlags(record) {
  return integer(first(record, ['classFlags', 'flags'],
    first(record?.metadata, ['classFlags', 'flags'], 0)), 'UClass ClassFlags', { minimum: 0 });
}

function pointerValue(pointer) {
  if (pointer === null || pointer === undefined) return null;
  // Native pointer comparisons treat a null pointer and integer zero alike.
  if (pointer === 0) return null;
  if (typeof pointer === 'number' || typeof pointer === 'string') return pointer;
  if (typeof pointer === 'function') return pointer;
  if (typeof pointer === 'object') {
    const nested = first(pointer, ['address', 'pointer', 'value'], pointer);
    return nested === pointer ? pointer : pointerValue(nested);
  }
  return pointer;
}

function samePointer(firstPointer, secondPointer) {
  if (firstPointer === secondPointer) return true;
  const firstValue = pointerValue(firstPointer), secondValue = pointerValue(secondPointer);
  return firstValue !== null && secondValue !== null && firstValue === secondValue;
}

function asBytes(value, label) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError(`Expected ${label} to be a byte buffer`);
}

function bufferRecord(value, label = 'Defaults') {
  if (!value || typeof value !== 'object') return null;
  const raw = value.data === undefined ? value : value.data;
  let data;
  try {
    data = asBytes(raw, `${label}.data`);
  } catch (error) {
    if (value.data === undefined) return null;
    throw error;
  }
  const size = integer(first(value, ['size', 'count', 'num'], data.length), `${label}.size`, { minimum: 0 });
  const capacity = integer(first(value, ['capacity', 'max'], data.length), `${label}.capacity`, { minimum: size });
  if (data.length < size) throw new RangeError(`${label}.data is smaller than its size`);
  return { data, size, capacity, source: value };
}

function traceCall(trace, operation, fields = {}) {
  trace.push({ operation, ...fields });
}

function propertiesSize(record, services, trace, stage) {
  const callback = services.getPropertiesSize ?? services.propertiesSize;
  let value;
  if (typeof callback === 'function') {
    value = callback(record, {
      kind: 'get-properties-size',
      body: SCRIPT_CLASS_REGISTRATION.getPropertiesSize.body,
      slot: SCRIPT_CLASS_REGISTRATION.getPropertiesSize.slot,
      stage,
    });
  } else {
    value = first(record, ['propertiesSize', 'propertySize'],
      first(record?.metadata, ['propertiesSize', 'propertySize'], undefined));
  }
  const size = integer(value, `UClass PropertiesSize (${stage})`, { minimum: 0 });
  traceCall(trace, 'get-properties-size', {
    stage, size, body: SCRIPT_CLASS_REGISTRATION.getPropertiesSize.body,
  });
  return size;
}

function sourceBuffer(record) {
  const candidate = first(record, ['defaultBuffer', 'defaultsBuffer', 'defaults'], null);
  return bufferRecord(candidate, `${record?.key ?? 'superclass'} Defaults`);
}

function* linkedProperties(record) {
  const candidate = first(record, ['linkedProperties', 'propertyLink', 'linkedPropertyList'], null);
  if (candidate === null || candidate === undefined) return;
  if (typeof candidate[Symbol.iterator] === 'function') { yield* candidate; return; }

  // A host may retain the original +0x68/+0x54 singly linked chain.  Follow
  // only an explicitly named next link; no export-table order is inferred.
  const seen = new Set();
  for (let property = candidate; property;) {
    if (seen.has(property)) throw new Error('Cyclic UClass linked property chain');
    seen.add(property); yield property;
    const rawNext = property.nativeSlots?.get(0x54);
    if (property.nativeSlots instanceof Map && rawNext?.value === undefined)
      fail('Inherited CopyCompleteValue requires live property Next +0x54', {operation: 'InitProperties', slot: '+0x54'});
    property = rawNext ? rawNext.value : first(property, ['next', 'nextProperty'], null);
  }
}

function propertyLayout(property, sourceSize) {
  const metadata = property?.metadata ?? property;
  const native = (offset, fallback) => property?.nativeSlots?.has(offset)
    ? property.nativeSlots.get(offset).value : fallback;
  const offsetValue = native(0x48, first(property, ['offset', 'propertyOffset'], first(metadata, ['offset', 'propertyOffset'])));
  if (offsetValue === null || offsetValue === undefined)
    fail('Inherited CopyCompleteValue requires linked property offset', {operation: 'InitProperties', slot: '+0x48'});
  const offset = integer(offsetValue, 'linked property offset', {minimum: 0});
  // 101521b8–c0 skips before reading the property's stride/dimension.
  if (offset >= sourceSize) return {offset};
  const raw = {
    elementSize: native(0x38, first(property, ['elementSize'], first(metadata, ['elementSize', 'size']))),
    arrayDim: native(0x34, first(property, ['arrayDim', 'arrayDimension'], first(metadata, ['arrayDim', 'arrayDimension']))),
  };
  for (const [name, value] of Object.entries(raw)) {
    if (value === null || value === undefined) {
      fail(`Inherited CopyCompleteValue requires linked property ${name}`, {
        operation: 'InitProperties', slot: name,
      });
    }
  }
  const elementSize = integer(raw.elementSize, 'linked property element size', { minimum: 0 });
  const arrayDim = integer(raw.arrayDim, 'linked property ArrayDim', { minimum: 0 });
  const bytes = elementSize * arrayDim;
  if (!Number.isSafeInteger(bytes)) throw new RangeError('Linked property byte span is too large');
  return { offset, elementSize, arrayDim, bytes };
}

function defaultHeader(record) {
  return {
    vtable: first(record, ['classVtable', 'vtable', 'nativeVtable'],
      first(record?.metadata, ['classVtable', 'vtable', 'nativeVtable'], null)),
    index: -1,
    hashNext: null,
    class: record,
    outer: null,
    name: 0,
    flags: 0,
    stateFrame: null,
    linker: null,
    // InitClassDefaultObject's memset leaves +0x14 at zero.  The -1
    // sentinel belongs to StaticAllocateObject's ordinary fresh-object path.
    linkerIndex: 0,
  };
}

function allocateDefaults(record, size, services, trace) {
  const explicit = first(record, ['defaultBuffer', 'defaultsBuffer'], null);
  const existing = bufferRecord(explicit, `${record?.key ?? 'class'} Defaults`);
  let allocated;
  if (existing && existing.data.length >= size) {
    allocated = existing.data;
  } else if (typeof services.allocateDefaults === 'function') {
    allocated = services.allocateDefaults(size, 1, {
      kind: 'defaults-realloc', body: 0x10145440, classRecord: record,
    });
  } else {
    // JS typed arrays are zero-filled.  InitClassDefaultObject immediately
    // writes the header and InitProperties zeroes/copies the tail, so this
    // cannot expose allocator garbage on the accepted path.
    allocated = new Uint8Array(size);
  }

  const data = asBytes(allocated?.data ?? allocated, 'allocated Defaults');
  const capacity = integer(allocated?.capacity ?? allocated?.max ?? Math.max(size, data.length),
    'allocated Defaults capacity', { minimum: size });
  if (data.length < size) throw new RangeError('Allocated Defaults buffer is smaller than PropertiesSize');
  const result = { data, size: 0, capacity, header: null, sourceSize: 0, copiedProperties: [] };
  traceCall(trace, 'defaults-realloc', {
    elementSize: 1, max: size, dataBytes: data.length,
    body: 0x10145440,
  });
  return result;
}

function publishDefaults(record, buffer) {
  // UClass::Register mutates the live +0x4d4/+0x4d8/+0x4dc FArray before
  // calling InitClassDefaultObject.  A raw-slot host may expose this through
  // a setter; plain records simply retain the same buffer object.
  record.defaultBuffer = buffer;
}

function growDefaults(buffer, count, services, record, trace) {
  if (count <= buffer.capacity) return;
  // FArray::Add's native growth is trunc(3*Num/8)+Num+0x20. CDQ's bias
  // corrects negative signed division; it adds nothing for positive Num.
  // This branch is
  // not expected for a stable class, but retaining it avoids silently using a
  // guessed fixed capacity when a virtual size changes during registration.
  const capacity = count + Math.trunc(3 * count / 8) + 0x20;
  let data = buffer.data;
  if (data.length < capacity) {
    const replacement = typeof services.allocateDefaults === 'function'
      ? services.allocateDefaults(capacity, 1, {
        kind: 'defaults-grow', body: 0x10145440, classRecord: record,
      })
      : new Uint8Array(capacity);
    const replacementBytes = asBytes(replacement?.data ?? replacement, 'grown Defaults');
    replacementBytes.set(data.subarray(0, Math.min(data.length, replacementBytes.length)));
    data = replacementBytes;
  }
  buffer.data = data; buffer.capacity = Math.max(capacity, data.length);
  traceCall(trace, 'defaults-grow', { count, capacity: buffer.capacity, body: 0x10107080 });
}

/**
 * Implements Core's `UObject::InitClassDefaultObject` body (`10152300`) and
 * its reached `InitProperties` storage behavior.  `record` is the UClass
 * whose Defaults.Data is being initialized; its superclass supplies the
 * inherited default tail and linked property list.
 *
 * The raw header writer remains a storage boundary. Inherited +0x90 calls use
 * the translated property dispatcher unless the host supplies an override.
 * Owning values additionally require the reached native heap services in
 * `services.propertyCopy`; missing heap storage is not a shallow-copy fallback.
 */
export function initializeClassDefaultObject(record, buffer, services = {}, trace = []) {
  buffer.copiedProperties = [];
  if (!record || typeof record !== 'object') throw new TypeError('Expected a UClass record');
  if (!buffer || typeof buffer !== 'object') throw new TypeError('Expected a Defaults buffer record');
  const data = asBytes(buffer.data, 'Defaults.data');
  const size = integer(buffer.size, 'Defaults.size', { minimum: DEFAULT_OBJECT_HEADER_SIZE });
  if (data.length < size) throw new RangeError('Defaults.data is smaller than Defaults.size');
  const writeHeader = services.writeDefaultHeader ?? services.writeHeader;
  if (typeof writeHeader !== 'function') {
    fail('InitClassDefaultObject requires an explicit raw CDO header writer', {
      operation: 'InitClassDefaultObject', slot: 'UObject header +0x00..+0x24',
    });
  }

  // InitClassDefaultObject first clears the UObject header, then stores Class
  // and Index, and copies the class vtable through the class object's +0 slot.
  data.fill(0, 0, DEFAULT_OBJECT_HEADER_SIZE);
  const header = defaultHeader(record);
  buffer.header = header;
  traceCall(trace, 'default-object-header-zero', {
    bytes: DEFAULT_OBJECT_HEADER_SIZE,
    body: SCRIPT_CLASS_REGISTRATION.initClassDefaultObject.body,
  });
  traceCall(trace, 'default-object-header-write', {
    vtable: header.vtable, class: record, index: -1,
  });
  writeHeader(data, header, {
    kind: 'default-object-header', body: SCRIPT_CLASS_REGISTRATION.initClassDefaultObject.body,
  });

  const sizeOfClass = propertiesSize(record, services, trace, 'init-class-default-object');
  if (sizeOfClass !== size) {
    fail(`InitClassDefaultObject size ${sizeOfClass} disagrees with Defaults.Num ${size}`, {
      operation: 'InitClassDefaultObject', slot: '+0x4d8',
    });
  }

  const parent = classSuper(record);
  const parentDefaults = parent ? sourceBuffer(parent) : null;
  const parentSize = parentDefaults?.size ?? 0;
  const tailStart = DEFAULT_OBJECT_HEADER_SIZE;
  let source = null;
  if (parentDefaults && parentSize > 0) {
    if (parentSize < DEFAULT_OBJECT_HEADER_SIZE) {
      throw new RangeError('Superclass Defaults is smaller than the UObject header');
    }
    if (parentSize > size) {
      throw new RangeError('Superclass Defaults exceeds the derived Defaults buffer');
    }
    const tailBytes = parentSize - DEFAULT_OBJECT_HEADER_SIZE;
    data.set(parentDefaults.data.subarray(tailStart, parentSize), tailStart);
    source = parentDefaults.data;
    buffer.sourceSize = parentSize;
    traceCall(trace, 'init-properties-copy-tail', {
      sourceSize: parentSize, bytes: tailBytes, sourceOffset: tailStart,
      destinationOffset: tailStart, body: SCRIPT_CLASS_REGISTRATION.initProperties.body,
    });
    if (parentSize < size) data.fill(0, parentSize, size);
  } else {
    data.fill(0, tailStart, size);
    buffer.sourceSize = 0;
    traceCall(trace, 'init-properties-zero-tail', {
      bytes: Math.max(0, size - tailStart), body: SCRIPT_CLASS_REGISTRATION.initProperties.body,
    });
  }

  // InitProperties receives Class=Superclass and therefore visits the
  // superclass +0x68 linked list.  A property is eligible only when its
  // offset is below the inherited Defaults size, exactly as 101521b8–c0.
  const properties = linkedProperties(parent);
  const copyCompleteValue = services.copyCompleteValue ?? services.copyProperty ??
    (detail => copyCompletePropertyValue(detail.property,
      {bytes: detail.destination, offset: detail.destinationOffset},
      {bytes: detail.source, offset: detail.sourceOffset}, services.propertyCopy ?? {}));
  for (const property of properties) {
    const layout = propertyLayout(property, buffer.sourceSize);
    if (layout.offset >= buffer.sourceSize) continue;
    if (layout.offset + layout.bytes > size || (source && layout.offset + layout.bytes > buffer.sourceSize)) {
      throw new RangeError(`Linked property exceeds Defaults storage at +0x${layout.offset.toString(16)}`);
    }
    data.fill(0, layout.offset, layout.offset + layout.bytes);
    traceCall(trace, 'init-properties-zero-linked', {
      property, offset: layout.offset, bytes: layout.bytes,
      body: SCRIPT_CLASS_REGISTRATION.initProperties.body,
    });
    copyCompleteValue({
      property,
      destination: data,
      source,
      destinationOffset: layout.offset,
      sourceOffset: layout.offset,
      elementSize: layout.elementSize,
      arrayDim: layout.arrayDim,
      bytes: layout.bytes,
    }, {
      kind: 'copy-complete-value', virtualSlot: 0x90,
      property, classRecord: record,
    });
    buffer.copiedProperties.push(property);
    traceCall(trace, 'init-properties-copy-complete', {
      property, offset: layout.offset, bytes: layout.bytes,
      virtualSlot: 0x90,
    });
  }
  return { buffer, header, size: sizeOfClass, parent, sourceSize: buffer.sourceSize };
}

function configName(record, services, trace) {
  const value = first(record, ['classConfigName', 'configName'],
    first(record?.metadata, ['classConfigName', 'configName'], undefined));
  if (value === undefined) {
    fail('UClass::Register requires the serialized ClassConfigName value', {
      operation: 'UClass::Register', slot: '+0x4a0',
    });
  }
  const intern = services.internName ?? services.resolveName ??
    (services.registration?.names?.intern
      ? (value, detail) => services.registration.names.intern(value, detail.findName) : undefined);
  if (typeof intern !== 'function') {
    fail('UClass::Register requires an explicit FName ClassConfigName adapter', {
      operation: 'UClass::Register', slot: '+0x4a0/FName(findName=1)',
    });
  }
  const resolved = intern(value, { kind: 'class-config-name', findName: 1, body: 0x10102e96 });
  if (resolved === null || resolved === undefined) {
    fail('ClassConfigName FName adapter returned no resolved name', {
      operation: 'UClass::Register', slot: '+0x4a0/FName(findName=1)',
    });
  }
  record.classConfigName = resolved;
  traceCall(trace, 'class-config-name', { value, resolved, findName: 1, body: 0x10102e96 });
  return resolved;
}

function storeClassFlags(record, value) {
  record.classFlags = value;
  if (record.metadata && own(record.metadata, 'classFlags')) record.metadata.classFlags = value;
}

function required(service, names, operation, slot) {
  for (const name of names) if (typeof service?.[name] === 'function') return service[name];
  fail(`${operation} requires an explicit ${slot} adapter`, { operation, slot });
}

function checkPropertiesSize(record, buffer, services, trace, stage) {
  const size = propertiesSize(record, services, trace, stage);
  if (size !== buffer.size) {
    fail(`UClass::Register PropertiesSize ${size} disagrees with Defaults.Num ${buffer.size}`, {
      operation: 'UClass::Register', slot: '+0x4d8',
    });
  }
  traceCall(trace, 'assert-properties-size', { stage, size });
  return size;
}

/**
 * Replays the reached `UClass::Register` sequence.  The base callback owns
 * UStruct/UField/UObject registration and registry insertion.  Other
 * callbacks receive the same receiver/argument boundaries as the native
 * body, so a host can provide its already traced native adapters without this
 * module inventing config, localization or +0x6c behavior.
 */
export function registerScriptClass(record, services = {}) {
  if (!record || typeof record !== 'object') throw new TypeError('Expected a UClass record');
  const trace = [];
  const registerBase = services.registerBase ?? services.registerStruct ??
    (services.registration ? object => registerScriptStruct(object, {registration: services.registration})
      : required(services, ['registerBase', 'registerStruct'], 'UClass::Register', 'UStruct::Register'));
  const baseResult = registerBase(record, {
    kind: 'uclass-register-base', body: 0x10125fe0,
  });
  traceCall(trace, 'register-base', { body: 0x10125fe0, result: baseResult });

  configName(record, services, trace);
  const firstSize = propertiesSize(record, services, trace, 'defaults-capacity');
  if (firstSize < DEFAULT_OBJECT_HEADER_SIZE) {
    fail(`UClass PropertiesSize ${firstSize} is smaller than the UObject header`, {
      operation: 'UClass::Register', slot: '+0x64',
    });
  }
  const buffer = allocateDefaults(record, firstSize, services, trace);
  buffer.size = 0;
  publishDefaults(record, buffer);
  traceCall(trace, 'defaults-num-zero', { offset: 0x4d8, value: 0 });

  const addSize = propertiesSize(record, services, trace, 'defaults-add');
  growDefaults(buffer, addSize, services, record, trace);
  buffer.size = addSize;
  publishDefaults(record, buffer);
  traceCall(trace, 'defaults-add', { count: addSize, elementSize: 1, body: 0x10107080 });
  // Native UClass::Register asserts this before calling InitClassDefaultObject.
  checkPropertiesSize(record, buffer, services, trace, 'before-init-class-default-object');

  const initialized = initializeClassDefaultObject(record, buffer, services, trace);

  const parent = classSuper(record);
  const currentStatic = classStaticConstructor(record);
  const parentStatic = parent ? classStaticConstructor(parent) : null;
  let staticConstructorCalled = false;
  // The native branch is guarded by a non-null superclass, then compares the
  // two +0x4e4 pointers.  A root class with no Super skips this call entirely.
  if (parent && !samePointer(parentStatic, currentStatic)) {
    checkPropertiesSize(record, buffer, services, trace, 'before-static-constructor');
    const invokeStatic = services.callStaticConstructor ?? services.staticConstructor;
    if (typeof invokeStatic === 'function') {
      invokeStatic(buffer.data, record, {
        kind: 'uclass-static-constructor', pointer: currentStatic,
        body: SCRIPT_CLASS_REGISTRATION.staticConstructor.body,
      });
    } else if (typeof currentStatic === 'function') {
      currentStatic(buffer.data, record);
    } else {
      fail('UClass::Register reached a distinct static constructor without an adapter', {
        operation: 'UClass::Register', slot: '+0x4e4',
      });
    }
    staticConstructorCalled = true;
    traceCall(trace, 'static-constructor', {
      pointer: currentStatic, receiver: buffer.data,
      body: SCRIPT_CLASS_REGISTRATION.staticConstructor.body,
    });
  }

  const inheritedFlags = parent ? classFlags(parent) & UCLASS_SUPERCLASS_FLAG_MASK : 0;
  const beforeFlags = classFlags(record);
  const afterFlags = (beforeFlags | inheritedFlags) >>> 0;
  storeClassFlags(record, afterFlags);
  traceCall(trace, 'inherit-class-flags', {
    before: beforeFlags, inherited: inheritedFlags,
    mask: UCLASS_SUPERCLASS_FLAG_MASK, after: afterFlags,
  });

  const frame = { ...CLASS_REGISTER_FRAME };
  const postRegister = services.postRegisterVirtual ?? services.virtual6c ?? services.initializeClassVirtual ??
    (services.classLink ? (object, archive, secondArgument) => {
      // Preserve live option getters: UClass::Link reads its global gate only
      // after the inherited UState::Link call has had a chance to change it.
      const options = Object.defineProperties({}, {
        ...Object.getOwnPropertyDescriptors(services.classLink),
        archive: {value: archive, enumerable: true},
        secondArgument: {value: secondArgument, enumerable: true},
      });
      return linkScriptClass(object, options);
    } : required(services,
      ['postRegisterVirtual', 'virtual6c', 'initializeClassVirtual'],
      'UClass::Register', 'UClass::Link (+0x6c)'));
  postRegister(record, frame, 0, {
    kind: 'uclass-register-virtual-6c', slot: 0x6c,
    body: SCRIPT_CLASS_REGISTRATION.postRegisterVirtual.body, receiver: record,
  });
  traceCall(trace, 'virtual-6c', { frame, secondArgument: 0, slot: 0x6c });
  checkPropertiesSize(record, buffer, services, trace, 'after-virtual-6c');

  // Core UClass::Register calls LoadConfig on Defaults.Data with (0, 0, 0).
  // The host binds script-config.mjs through its graph/GConfig storage view;
  // do not maintain a second translation for this raw-buffer boundary.
  const loadConfig = required(services, ['loadConfig'], 'UClass::Register', 'LoadConfig');
  loadConfig(buffer.data, 0, 0, 0, {
    kind: 'uclass-load-config', body: SCRIPT_CLASS_REGISTRATION.loadConfig.body,
    classRecord: record,
  });
  traceCall(trace, 'load-config', { receiver: buffer.data, arguments: [0, 0, 0] });
  checkPropertiesSize(record, buffer, services, trace, 'after-load-config');

  const objectConfig = Object.create(services.objectConfig ?? null);
  objectConfig.classRecord = record;
  const loadLocalized = services.loadLocalized ??
    ((data, first, second) => loadScriptLocalized(data, first, second, objectConfig));
  loadLocalized(buffer.data, 0, 0, {
    kind: 'uclass-load-localized', body: SCRIPT_CLASS_REGISTRATION.loadLocalized.body,
    classRecord: record,
  });
  traceCall(trace, 'load-localized', { receiver: buffer.data, arguments: [0, 0] });

  return {
    record,
    defaults: buffer,
    defaultObject: initialized.header,
    classFlags: afterFlags,
    frame,
    baseResult,
    staticConstructorCalled,
    operations: trace,
  };
}

export const registerUClass = registerScriptClass;
