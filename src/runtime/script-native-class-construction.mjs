import {UCLASS_CONSTRUCTOR_FLAG_OR} from './script-class-registration.mjs';
import {NativeSlots} from './native-slots.mjs';

export const NATIVE_CLASS_CONSTRUCTION = Object.freeze({
  uStruct: 0x10125ef0,
  uClass: 0x10128630,
  coreClass: 0x101f1c18,
  structVtable: 0x10175698,
  classVtable: 0x101758f4,
});

const pointerSlots = new Set([0x28, 0x2c, 0x30, 0x34, 0x38, 0x68, 0x49c]);
const aliases = Object.freeze({
  nativeVtable: 0,
  superClass: 0x28,
  propertiesSize: 0x3c,
  linkedProperties: 0x68,
  classFlags: 0x484,
  nameCount: 0x488,
  withinClass: 0x49c,
  classConfigName: 0x4a0,
  nativeInstanceConstructor: 0x4e0,
  staticConstructor: 0x4e4,
});

function u32(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
    throw new TypeError(`Native UClass construction requires uint32 ${label}`);
  return value;
}

/** Mutable slots shared by native construction, registration and serialization.
 * A missing slot is deliberately not fabricated as zero. Pointer zero is
 * normalized at this typed boundary; the stored raw value remains available.
 */
export function nativeClassSlot(record, offset) {
  const slots = record.nativeSlots;
  if (!(slots instanceof NativeSlots) || !slots.has(offset)) throw new Error(`Unbound native class slot +0x${offset.toString(16)}`);
  return {
    get: () => {
      const value = slots.value(offset);
      return pointerSlots.has(offset) && value === 0 ? null : value;
    },
    set: value => slots.assign(offset, value),
  };
}

function bindAliases(record) {
  for (const [name, offset] of Object.entries(aliases)) {
    Object.defineProperty(record, name, {
      configurable: true, enumerable: true,
      get: () => nativeClassSlot(record, offset).get(),
      set: value => nativeClassSlot(record, offset).set(value),
    });
  }
  // The native Defaults FArray stores a pointer/count/capacity, independently
  // of the typed property map used by loaded script classes.
  Object.defineProperty(record, 'defaultBuffer', {
    configurable: true, enumerable: true,
    get: () => {
      const data = nativeClassSlot(record, 0x4d4).get();
      if (data === 0 || data === null) return null;
      return {
        data,
        size: nativeClassSlot(record, 0x4d8).get(),
        capacity: nativeClassSlot(record, 0x4dc).get(),
      };
    },
    set: buffer => {
      nativeClassSlot(record, 0x4d4).set(buffer?.data ?? 0);
      nativeClassSlot(record, 0x4d8).set(buffer?.size ?? 0);
      nativeClassSlot(record, 0x4dc).set(buffer?.capacity ?? 0);
    },
  });
}

/** Core UClass ENativeConstructor -> UStruct ENativeConstructor -> UObject.
 * `registration` is the recovered createScriptNativeRegistration host.
 * `coreClass` must be the caller's canonical native Core.Class identity.
 * This queues a class for registration; it does not replace Register/Link.
 */
export function constructNativeScriptClass(record, {
  registration, coreClass, instanceSize, classFlags, superClass, withinClass,
  guid, nameText, packageText, configText, objectFlags,
  instanceConstructor, staticConstructor, onWrite,
} = {}) {
  if (!record || typeof record !== 'object') throw new TypeError('Expected a native UClass record');
  if (typeof registration?.constructUObject !== 'function')
    throw new TypeError('Native UClass construction requires the UObject construction host');
  if (!coreClass || typeof coreClass !== 'object')
    throw new TypeError('Native UClass construction requires canonical Core.Class');
  for (const [value, label] of [[instanceSize, 'instanceSize'], [classFlags, 'classFlags'],
    [objectFlags, 'objectFlags']]) u32(value, label);
  if (!Array.isArray(guid) || guid.length !== 4) throw new TypeError('Expected four FGuid words');
  guid.forEach((word, index) => u32(word, `GUID[${index}]`));
  for (const [value, label] of [[superClass, 'Super'], [withinClass, 'Within']]) {
    if (value !== null && (!value || typeof value !== 'object'))
      throw new TypeError(`Native UClass construction requires explicit ${label} identity or null`);
  }
  for (const [value, label] of [[nameText, 'name'], [packageText, 'package'], [configText, 'config']]) {
    if (typeof value !== 'string') throw new TypeError(`Native UClass construction requires ${label} text`);
  }
  if (instanceConstructor === undefined || staticConstructor === undefined)
    throw new TypeError('Native UClass construction requires explicit constructor pointers');
  if (record.nativeSlots !== undefined && !(record.nativeSlots instanceof NativeSlots))
    throw new TypeError('Native UClass storage must be NativeSlots');
  record.nativeSlots ??= new NativeSlots();
  const write = (offset, value, width = 4) => {
    const slots = record.nativeSlots;
    if (slots.has(offset) && slots.width(offset) !== width)
      throw new Error(`Native slot width mismatch at +0x${offset.toString(16)}`);
    slots.assign(offset, value, width);
    if (offset === 0) record.nativeVtable = value;
    onWrite?.({object: record, offset, width, value});
  };
  const zero = offsets => { for (const offset of offsets) write(offset, 0); };

  // 10128630-5c removes only a self Super. 10125f0d always passes Core.Class.
  registration.constructUObject(record, {
    objectClass: coreClass, nameText, outerText: packageText, flags: objectFlags,
  });
  write(0x28, superClass === record ? null : superClass);
  zero([0x2c, 0x30, 0x34, 0x38, 0x44, 0x48, 0x4c, 0x50,
    0x54, 0x58, 0x5c, 0x60, 0x64, 0x68]);
  write(0x3c, instanceSize);
  write(0, NATIVE_CLASS_CONSTRUCTION.structVtable);

  write(0x484, (classFlags | UCLASS_CONSTRUCTOR_FLAG_OR) >>> 0);
  write(0x48c, guid[0]); zero([0x4a4, 0x4a8]);
  write(0x490, guid[1]); zero([0x4ac, 0x4b0]);
  write(0x494, guid[2]); zero([0x4b4, 0x4b8]);
  write(0x498, guid[3]); zero([0x4bc, 0x4c0, 0x4c4]);
  write(0x49c, withinClass);
  zero([0x4c8, 0x4cc, 0x4d0, 0x6c, 0x74, 0x4d4, 0x4d8, 0x4dc,
    0x70, 0x78, 0x7c]);
  write(0x80, 0, 2);
  write(0x488, 0);
  write(0x4e4, staticConstructor);
  zero([0x4e8, 0x4ec, 0x4f0]);
  write(0x4e0, instanceConstructor);
  write(0, NATIVE_CLASS_CONSTRUCTION.classVtable);
  write(0x4a0, configText);
  bindAliases(record);
  return record;
}
