import {ScriptObjectRegistry} from './script-object-construction.mjs';

/** Raw Core globals and native entry points used by the registration subset. */
export const NATIVE_REGISTRATION = Object.freeze({
  objectConstructor: 0x1014f4c0,
  conditionalRegister: 0x1014fea0,
  processRegistrants: 0x10152a40,
  objectRegister: 0x10152550,
  createPackage: 0x101549f0,
  addObject: 0x10157830,
  hashObject: 0x10157730,
  objectGate: 0x102a2648,
  registrationGate: 0x102a2644,
  registrationDepth: 0x102a2654,
  registrationHead: 0x102a265c,
  gNames: 0x102961f0,
  gObjects: 0x1029e628,
  gHashBuckets: 0x1029e644,
  coreObjectClass: 0x1029e0d0,
  uObjectVtable: 0x10179dfc,
  virtualRegisterOffset: 0x4c,
});

export const CORE_CLASS_CONSTRUCTORS = Object.freeze({
  // UClass::UClass stores the first pushed constructor at +0x4e0 and the
  // second at +0x4e4 (Core 0x10128630, 0x101286a3 and 0x1012871a).
  instance: 0x10102e0a,
  static: 0x10101041,
});

const MISSING = Symbol('missing raw global');
const UObjectFlags = Object.freeze({native: 0x04000000});
const isMap = value => value instanceof Map;
const U32 = value => Number(value) >>> 0;

function requireObject(value, name) {
  if (!value || typeof value !== 'object') throw new TypeError(`Native registration requires ${name}`);
  return value;
}

function requireArray(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`Native registration requires ${name} array`);
  return value;
}

function rawGet(globals, address) {
  if (isMap(globals)) return globals.has(address) ? globals.get(address) : MISSING;
  return Object.hasOwn(globals, address) ? globals[address] : MISSING;
}

function rawSet(globals, address, value) {
  if (isMap(globals)) globals.set(address, value);
  else globals[address] = value;
}

function requireRawGlobal(globals, address) {
  const value = rawGet(globals, address);
  if (value === MISSING) throw new Error(`Native registration requires raw global 0x${address.toString(16)}`);
  return value;
}

function numericGlobal(globals, address, name) {
  const value = requireRawGlobal(globals, address);
  if (typeof value !== 'number' && typeof value !== 'boolean')
    throw new TypeError(`Native registration global ${name} must be numeric`);
  return Number(value);
}

function textValue(value, name) {
  if (typeof value !== 'string') throw new TypeError(`Native registration requires ${name} text`);
  const nul = value.indexOf('\u0000');
  return nul < 0 ? value : value.slice(0, nul);
}

function pointerOrNull(value) {
  return value === undefined || value === null ? null : value;
}

/**
 * Build the recovered Core UObject registration subset.
 *
 * The caller supplies the mutable raw globals, a ScriptObjectRegistry for the
 * GObjObjects/hash storage, and the createScriptNames result for FName
 * interning.  Package creation, StaticFindObject, and the virtual +0x4c
 * Register dispatch are required callbacks: this adapter never turns those
 * source calls into an empty success path.
 *
 * Required callback shapes:
 *
 *   createPackage({outer: null, name, object}) -> package|null
 *   staticFindObject({classRef: null, outer, name, exactClass: 0, object})
 *     -> existing object|null
 *   virtualRegister(object, {vtableOffset: 0x4c})
 *
 * `coreObjectClass` or `isCoreObjectClass` identifies the one constructor
 * branch that immediately invokes UObject::Register.  The raw global
 * 0x102a2648 is required to be zero for the accepted constructor path.  The
 * original calls appFailAssert and continues for a nonzero value; strict host
 * validation throws after the diagnostic unless `continueAfterAssert` is
 * explicitly enabled.
 */
export function createScriptNativeRegistration({
  registry,
  names,
  globals,
  coreObjectClass,
  isCoreObjectClass,
  createPackage,
  staticFindObject,
  virtualRegister,
  onAssert,
  onLog,
  onStep,
  continueAfterAssert = false,
} = {}) {
  if (!(registry instanceof ScriptObjectRegistry))
    throw new TypeError('Native registration requires a ScriptObjectRegistry');
  requireObject(names, 'a createScriptNames result');
  const intern = typeof names.intern === 'function' ? names.intern.bind(names)
    : typeof names.internName === 'function' ? names.internName.bind(names) : null;
  if (!intern) throw new TypeError('Native registration requires FName intern(text,1)');
  if (!globals || (!isMap(globals) && typeof globals !== 'object'))
    throw new TypeError('Native registration requires mutable raw globals');
  if (typeof createPackage !== 'function') throw new TypeError('Native registration requires createPackage');
  if (typeof staticFindObject !== 'function') throw new TypeError('Native registration requires staticFindObject');
  if (typeof virtualRegister !== 'function') throw new TypeError('Native registration requires virtualRegister');
  if (coreObjectClass === undefined && typeof isCoreObjectClass !== 'function') {
    throw new TypeError('Native registration requires coreObjectClass or isCoreObjectClass');
  }

  // These two counters are initialized by appInit/ProcessRegistrants in the
  // original image.  Initializing only the queue bookkeeping here avoids
  // inventing a startup value for the 0x102a2648 gate.
  if (rawGet(globals, NATIVE_REGISTRATION.registrationDepth) === MISSING)
    rawSet(globals, NATIVE_REGISTRATION.registrationDepth, 0);
  if (rawGet(globals, NATIVE_REGISTRATION.registrationHead) === MISSING)
    rawSet(globals, NATIVE_REGISTRATION.registrationHead, null);

  const temporaryRegistrants = [];

  function reportAssert(type, message, detail = {}) {
    const event = {type, message, address: detail.address, ...detail};
    onAssert?.(event);
    if (!continueAfterAssert) throw new Error(message);
  }

  function step(name, detail = {}) {
    onStep?.({step: name, ...detail});
  }

  function log(type, detail = {}) {
    onLog?.({type, ...detail});
  }

  function globalValue(address, name) {
    return numericGlobal(globals, address, name);
  }

  function queueHead() {
    const head = requireRawGlobal(globals, NATIVE_REGISTRATION.registrationHead);
    return pointerOrNull(head);
  }

  function setQueueHead(value) {
    rawSet(globals, NATIVE_REGISTRATION.registrationHead, pointerOrNull(value));
  }

  function objectIndex(object) {
    if (!Object.hasOwn(object, 'index') || !Number.isInteger(object.index))
      throw new TypeError('Native registration object requires integer index');
    return object.index;
  }

  function objectName(object) {
    const value = object.registrationName ?? object.nameText ?? object.name;
    return textValue(value, 'object name');
  }

  function objectOuterName(object) {
    const value = object.registrationOuterName ?? object.outerName ?? object.outerText;
    return textValue(value, 'object outer/package name');
  }

  function isCoreObjectClassValue(classRef) {
    return typeof isCoreObjectClass === 'function'
      ? isCoreObjectClass(classRef) === true
      : classRef === coreObjectClass;
  }

  function queueNext(object) {
    if (Object.hasOwn(object, 'registrationNext')) return object.registrationNext;
    if (Object.hasOwn(object, 'linkerIndex')) return object.linkerIndex;
    throw new TypeError('Native registration queue entry has no +0x14 link');
  }

  /** Core HashObject10157730. This is kept separate so AddObject's array write
   * and the subsequent hash-link write are visible and source ordered. */
  function hashObject(object) {
    const outer = object.outer;
    if (outer !== null && outer !== undefined && !Number.isInteger(outer.index))
      throw new Error('Native HashObject requires an indexed Outer package');
    if (!Number.isInteger(object.nameIndex) || object.nameIndex < 0)
      throw new Error('Native HashObject requires a resolved FName index');
    const bucket = (((outer?.index ?? 0) ^ object.nameIndex) & 0xfff) >>> 0;
    const previous = registry.buckets[bucket] ?? null;
    step('hashObject', {address: NATIVE_REGISTRATION.hashObject, object, bucket, previous});
    registry.buckets[bucket] = object;
    object.hashNext = previous;
    object.hashBucket = bucket;
    return bucket;
  }

  /** Core AddObject10157830's normal index path, using live registry arrays. */
  function addObject(object) {
    objectIndex(object);
    if (object.index !== -1) throw new Error('Native AddObject requires an unregistered object');
    if (!Number.isInteger(object.nameIndex) || object.nameIndex < 0)
      throw new Error('Native AddObject requires a resolved FName index');
    if (object.outer !== null && object.outer !== undefined && !Number.isInteger(object.outer.index))
      throw new Error('Native AddObject requires an indexed Outer package');

    const objects = requireArray(registry.objects, 'registry.objects');
    const freeIndices = requireArray(registry.freeIndices, 'registry.freeIndices');
    const index = freeIndices.length ? freeIndices[freeIndices.length - 1] : objects.length;
    if (!Number.isInteger(index) || index < 0 || index > objects.length || objects[index] !== undefined && objects[index] !== null)
      throw new Error('Native AddObject encountered an invalid object-array index');
    step('addObject', {address: NATIVE_REGISTRATION.addObject, object, index});
    if (freeIndices.length) freeIndices.pop();
    objects[index] = object;
    object.index = index;
    hashObject(object);
    return index;
  }

  /** Core UObject::Register10152550 through package/name/find/add/hash. */
  function registerUObject(object) {
    requireObject(object, 'an object');
    if (objectIndex(object) !== -1)
      throw new Error('Native UObject::Register requires an unregistered object');
    if (globalValue(NATIVE_REGISTRATION.registrationGate, 'registrationGate') === 0) {
      reportAssert('RegistrationGate', 'UObject::Register reached with raw registration gate 0', {
        address: NATIVE_REGISTRATION.registrationGate, object,
      });
    }

    const outerName = objectOuterName(object);
    const nameText = objectName(object);

    // 101525a0 pushes +18 followed by zero. Under cdecl this is
    // CreatePackage(Outer=NULL, Name=+18).
    step('createPackage', {address: NATIVE_REGISTRATION.createPackage, object, outer: null, name: outerName});
    const packageObject = pointerOrNull(createPackage({outer: null, name: outerName, object}));
    object.outer = packageObject;
    if (packageObject === null) log('MissingPackage', {object, name: outerName});

    step('internName', {object, name: nameText, findType: 1});
    const resolved = intern(nameText, 1);
    if (!resolved || !Number.isInteger(resolved.index) || resolved.index < 0 || typeof resolved.name !== 'string')
      throw new Error('Native UObject::Register requires a resolved FName result');
    object.nameIndex = resolved.index;
    object.name = resolved.name;
    object.registrationNext = -1;
    object.linkerIndex = -1;
    if (packageObject === null) log('NullPackage', {object});
    if (resolved.index === 0) log('ZeroName', {object});

    // The native lookup obtains the text from GNames after FName conversion.
    step('staticFindObject', {
      address: 0x1010326a, object, classRef: null, outer: packageObject,
      name: resolved.name, exactClass: 0,
    });
    const duplicate = staticFindObject({
      classRef: null, outer: packageObject, name: resolved.name, exactClass: 0, object,
    });
    if (duplicate !== null && duplicate !== undefined) log('DuplicateObject', {object, duplicate});

    addObject(object);
    return object;
  }

  /** Core ConditionalRegister1014fea0 and virtual UObject +0x4c dispatch. */
  function conditionalRegister(object, registrants = temporaryRegistrants) {
    requireObject(object, 'a registrant');
    // 1014fed0-1014fed3: an object with an assigned GObjObjects index takes
    // the direct epilogue.  In particular, repeated ConditionalRegister must
    // not dispatch the virtual +0x4c Register again.
    if (objectIndex(object) !== -1) return;
    if (!Array.isArray(registrants) || !registrants.includes(object)) {
      reportAssert('RegistrantSet', 'ConditionalRegister received an unlisted unregistered object', {
        address: NATIVE_REGISTRATION.conditionalRegister, object,
      });
    }
    return virtualRegister(object, {vtableOffset: NATIVE_REGISTRATION.virtualRegisterOffset});
  }

  /** Core ProcessRegistrants10152a40 with its depth guard and temp array. */
  function processRegistrants() {
    const depth = globalValue(NATIVE_REGISTRATION.registrationDepth, 'registrationDepth');
    if (!Number.isInteger(depth) || depth < 0) throw new Error('Native registration depth is invalid');
    const nextDepth = depth + 1;
    rawSet(globals, NATIVE_REGISTRATION.registrationDepth, nextDepth);
    if (nextDepth !== 1) {
      rawSet(globals, NATIVE_REGISTRATION.registrationDepth, nextDepth - 1);
      return [];
    }

    temporaryRegistrants.length = 0;
    const seen = new Set();
    const processed = [];
    try {
      // Constructor registration prepends. ProcessRegistrants copies that
      // linked list into an FArray before invoking any virtual Register.
      while (queueHead() !== null) {
        const current = queueHead();
        if (current === -1 || !current || typeof current !== 'object')
          throw new Error('Native registration queue contains an invalid pointer');
        if (seen.has(current)) throw new Error('Native registration queue is cyclic');
        seen.add(current);
        temporaryRegistrants.push(current);
        setQueueHead(queueNext(current));
      }

      for (const object of temporaryRegistrants) {
        conditionalRegister(object, temporaryRegistrants);
        processed.push(object);
      }

      // The native FArray is emptied/freed before this final queue assertion.
      temporaryRegistrants.length = 0;
      if (queueHead() !== null) {
        reportAssert('RegistrationQueue', 'ProcessRegistrants left a non-null registration queue', {
          address: NATIVE_REGISTRATION.processRegistrants,
        });
      }
      return processed;
    } finally {
      temporaryRegistrants.length = 0;
      rawSet(globals, NATIVE_REGISTRATION.registrationDepth, nextDepth - 1);
    }
  }

  /** Core UObject constructor1014f4c0 header writes and queue insertion. */
  function constructUObject(object, {
    classRef,
    objectClass,
    name,
    nameText,
    outerName,
    outerText,
    flags = 0,
    nativeInstanceConstructor,
    nativeConstructor,
    staticConstructor,
    vtable = NATIVE_REGISTRATION.uObjectVtable,
  } = {}) {
    requireObject(object, 'an object');
    const resolvedClass = classRef ?? objectClass ?? object.objectClass ?? object.classRef;
    if (resolvedClass === undefined || resolvedClass === null)
      throw new TypeError('Native UObject constructor requires classRef');
    const resolvedName = textValue(name ?? nameText ?? object.nameText ?? object.name, 'object name');
    const resolvedOuterName = textValue(outerName ?? outerText ?? object.outerName ?? object.outerText, 'object outer/package name');
    const instanceConstructor = nativeInstanceConstructor ?? nativeConstructor;

    // 1014f4df-1014f4f9: unregistered index, queue sentinel, native flag,
    // and the zeroed raw name field precede the 102a2648 check.
    object.index = -1;
    object.registrationNext = -1;
    object.linkerIndex = -1;
    object.nameIndex = 0;
    object.flags = U32(U32(flags) | UObjectFlags.native);
    if (Object.hasOwn(object, 'objectFlags')) object.objectFlags = object.flags;

    if (globalValue(NATIVE_REGISTRATION.objectGate, 'objectGate') !== 0) {
      reportAssert('ObjectConstructorGate', 'UObject constructor reached with raw gate 0x102a2648 nonzero', {
        address: NATIVE_REGISTRATION.objectGate, object,
      });
    }

    // 1014f506-1014f515: common UObject pointers and vtable.
    object.hashNext = null;
    object.stateFrame = null;
    object.linker = null;
    object.outer = null;
    object.objectClass = resolvedClass;
    object.classRef = resolvedClass;
    object.nativeVtable = vtable;
    if (instanceConstructor !== undefined) {
      object.nativeInstanceConstructor = instanceConstructor;
      object.nativeConstructor = instanceConstructor;
    }
    if (staticConstructor !== undefined) object.staticConstructor = staticConstructor;

    // 1014f534-1014f550 stores the source text pointers, then prepends the
    // object to the global registrant list.
    object.name = resolvedName;
    object.nameText = resolvedName;
    object.registrationName = resolvedName;
    object.outerName = resolvedOuterName;
    object.outerText = resolvedOuterName;
    object.registrationOuterName = resolvedOuterName;
    const previous = queueHead();
    object.registrationNext = previous;
    object.linkerIndex = previous;
    setQueueHead(object);

    if (globalValue(NATIVE_REGISTRATION.registrationGate, 'registrationGate') !== 0 &&
        isCoreObjectClassValue(resolvedClass)) {
      // The native constructor calls the base Register only for the
      // Core.Object class branch; it does not use virtual +0x4c here.
      registerUObject(object);
    }
    return object;
  }

  return {
    registry,
    names,
    globals,
    temporaryRegistrants,
    constructUObject,
    construct: constructUObject,
    registerUObject,
    register: registerUObject,
    conditionalRegister,
    processRegistrants,
    addObject,
    hashObject,
    get queueHead() { return queueHead(); },
    set queueHead(value) { setQueueHead(value); },
    get registrationDepth() { return globalValue(NATIVE_REGISTRATION.registrationDepth, 'registrationDepth'); },
  };
}

export default createScriptNativeRegistration;
