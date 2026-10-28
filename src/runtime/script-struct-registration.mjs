/**
 * The reached UStruct/UField registration prefix from the installed Deus Ex
 * GOTY Core.dll.  UObject identity registration is deliberately supplied by
 * the shared createScriptNativeRegistration host; this module owns only the
 * two native bodies below.
 */

import {NativeSlots} from './native-slots.mjs';

export const SCRIPT_STRUCT_REGISTRATION = Object.freeze({
  uField: Object.freeze({ thunk: 0x1010183e, body: 0x10125dd0 }),
  uStruct: Object.freeze({ thunk: 0x10103076, body: 0x10125fe0 }),
  uObjectRegister: Object.freeze({ thunk: 0x101020ae, body: 0x10152550 }),
  conditionalRegister: Object.freeze({ thunk: 0x101022ac, body: 0x1014fea0 }),
  field: Object.freeze({ baseField: 0x28, next: 0x2c }),
  struct: Object.freeze({ children: 0x38, friendlyName: 0x40, name: 0x20 }),
});

export class UnsupportedScriptStructRegistrationError extends Error {
  constructor(message, { operation = null, slot = null } = {}) {
    super(message);
    this.name = 'UnsupportedScriptStructRegistrationError';
    this.code = 'UNSUPPORTED_SCRIPT_STRUCT_REGISTRATION';
    this.operation = operation;
    this.slot = slot;
  }
}

function fail(message, details = {}) {
  throw new UnsupportedScriptStructRegistrationError(message, details);
}

function first(source, keys, fallback = undefined) {
  for (const key of keys) {
    if (source !== null && source !== undefined && source[key] !== undefined) return source[key];
  }
  return fallback;
}

function traceCall(trace, operation, fields = {}) {
  trace.push({ operation, ...fields });
}

function registrationMethod(registration, names, operation, slot) {
  for (const name of names) if (typeof registration?.[name] === 'function') return registration[name].bind(registration);
  fail(`${operation} requires the shared ${slot} registration adapter`, { operation, slot });
}

function baseFieldOf(record, explicit) {
  if (explicit !== undefined) return explicit;
  return first(record, ['baseField', 'base', 'superClass', 'superclass', 'super'], null);
}

function nameValueOf(record) {
  const value = first(record, ['nameIndex', 'name', 'nameRef'], undefined);
  if (value === undefined || value === null) {
    fail('UStruct::Register requires the UObject registration to resolve +0x20 Name', {
      operation: 'UStruct::Register', slot: '+0x20',
    });
  }
  return value;
}

function nativeFriendlyNameAlias(record) {
  if (!(record.nativeSlots instanceof NativeSlots)) return false;
  const existing = Object.getOwnPropertyDescriptor(record, 'friendlyName');
  if (existing && !existing.configurable && !existing.get && !existing.set) {
    fail('UStruct::Register cannot expose a live FriendlyName native slot', {
      operation: 'UStruct::Register', slot: '+0x40',
    });
  }
  if (!existing || existing.configurable) {
    const offset = SCRIPT_STRUCT_REGISTRATION.struct.friendlyName;
    Object.defineProperty(record, 'friendlyName', {
      configurable: true,
      enumerable: true,
      get: () => record.nativeSlots.value(offset),
      set: value => {
        const width = record.nativeSlots.width(offset);
        if (width !== undefined && width !== 4) {
          throw new Error(`FriendlyName native slot +0x${offset.toString(16)} is not 4 bytes`);
        }
        return record.nativeSlots.assign(offset, value, 4);
      },
    });
  }
  return true;
}

function writeNativeFriendlyNameSlot(record, value) {
  const offset = SCRIPT_STRUCT_REGISTRATION.struct.friendlyName;
  const width = record.nativeSlots.width(offset);
  if (width !== undefined && width !== 4) {
    throw new Error(`UStruct::Register FriendlyName slot +0x${offset.toString(16)} is not 4 bytes`);
  }
  record.nativeSlots.assign(offset, value, 4);
}

function writeFriendlyName(record, value, services, trace) {
  const detail = {
    kind: 'friendly-name', body: SCRIPT_STRUCT_REGISTRATION.uStruct.body,
    sourceOffset: SCRIPT_STRUCT_REGISTRATION.struct.name,
    destinationOffset: SCRIPT_STRUCT_REGISTRATION.struct.friendlyName,
  };
  const writer = services.writeSlot ?? services.writeNativeSlot;
  if (typeof writer === 'function') {
    writer(record, SCRIPT_STRUCT_REGISTRATION.struct.friendlyName, value, 4, detail);
  }
  if (record.nativeSlots instanceof NativeSlots) {
    nativeFriendlyNameAlias(record);
    writeNativeFriendlyNameSlot(record, value);
  } else {
    // Plain logical records have no separate raw storage, so the property is
    // the one live representation available to the host.
    record.friendlyName = value;
  }
  traceCall(trace, 'friendly-name', { value, ...detail });
  return value;
}

function registerFieldPrefix(record, {
  registration,
  baseField: explicitBaseField,
  registrants,
} = {}) {
  if (!registration || typeof registration !== 'object') {
    throw new TypeError('UField::Register requires the shared registration host');
  }
  const registerUObject = registrationMethod(
    registration, ['registerUObject', 'register'], 'UField::Register', 'UObject::Register',
  );

  const baseResult = registerUObject(record);
  const operations = [];
  traceCall(operations, 'uobject-register', {
    body: SCRIPT_STRUCT_REGISTRATION.uObjectRegister.body,
    result: baseResult,
  });

  // UField::Register tests +0x28 after UObject::Register.  For UClass this
  // same slot is Super; for UField it is BaseField.  ConditionalRegister owns
  // the original unregistered-index and temporary-registrant checks.
  const baseField = baseFieldOf(record, explicitBaseField);
  if (baseField !== null && baseField !== undefined) {
    const conditionalRegister = registrationMethod(
      registration, ['conditionalRegister'], 'UField::Register', 'ConditionalRegister',
    );
    if (registrants === undefined) conditionalRegister(baseField);
    else conditionalRegister(baseField, registrants);
    traceCall(operations, 'conditional-register-base-field', {
      body: SCRIPT_STRUCT_REGISTRATION.conditionalRegister.body,
      field: baseField, offset: SCRIPT_STRUCT_REGISTRATION.field.baseField,
    });
  }
  return { baseResult, baseField: baseField ?? null, operations };
}

/** Replays UField::Register without the UStruct FriendlyName assignment. */
export function registerScriptField(record, options = {}) {
  if (!record || typeof record !== 'object') throw new TypeError('Expected a UField record');
  const prefix = registerFieldPrefix(record, options);
  return { record, ...prefix };
}

/**
 * Replays `UField::Register` followed by `UStruct::Register`.
 *
 * `registration` is the object returned by createScriptNativeRegistration;
 * its `registerUObject` call performs UObject::Register, and its
 * `conditionalRegister` call performs the exact virtual +0x4c dispatch for a
 * non-null BaseField/Super at +0x28.  `writeSlot` is optional for plain
 * logical records, but a nativeSlots record is updated directly at +0x40.
 */
export function registerScriptStruct(record, {
  registration,
  baseField: explicitBaseField,
  registrants,
  writeSlot,
  writeNativeSlot,
} = {}) {
  if (!record || typeof record !== 'object') throw new TypeError('Expected a UField/UStruct record');
  const trace = [];
  const prefix = registerFieldPrefix(record, {
    registration, baseField: explicitBaseField, registrants,
  });
  trace.push(...prefix.operations);

  // UStruct::Register copies the resolved UObject Name FName at +0x20 to
  // FriendlyName at +0x40 only after UField::Register returns.
  const friendlyName = writeFriendlyName(record, nameValueOf(record), {
    writeSlot, writeNativeSlot,
  }, trace);
  return {
    record,
    baseResult: prefix.baseResult,
    baseField: prefix.baseField,
    friendlyName,
    operations: trace,
  };
}

export const registerUStruct = registerScriptStruct;
export const registerUField = registerScriptField;

export default registerScriptStruct;
