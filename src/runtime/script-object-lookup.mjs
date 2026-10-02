import {ScriptObjectRegistry} from './script-object-construction.mjs';

export const SCRIPT_OBJECT_LOOKUP = Object.freeze({
  staticFindObject: 0x10151de0,
  resolveName: 0x10154ad0,
  coreObjectClass: 0x1029e0d0,
  corePackageClass: 0x1029b8e0,
  anyPackage: -1,
});

const own = (object, key) => object != null && Object.hasOwn(object, key);
const pointer = value => value === 0 ? null : value;
function text(value) {
  if (typeof value !== 'string') throw new TypeError('Core object lookup requires UTF-16 name text');
  return value.split('\0', 1)[0];
}
function holder(value) {
  return {get: () => value, set: next => { value = next; }};
}
function requireReference(reference) {
  if (typeof reference?.get !== 'function' || typeof reference?.set !== 'function')
    throw new TypeError('ResolveName requires mutable Outer/Name holders');
}
function storedClass(object) {
  if (!own(object, 'objectClass')) throw new Error('Object lookup requires the native Class pointer');
  return object.objectClass;
}
function storedSuper(cls) {
  if (cls.nativeSlots?.has(0x28)) return cls.nativeSlots.get(0x28).value;
  if (own(cls, 'superClass')) return cls.superClass;
  throw new Error('Object lookup requires a bound Class.SuperField (+0x28)');
}

/** Core lookup over live objects/hash buckets and the original FName table.
 * The name resolver calls back into this same lookup for package/object path
 * components. Config access and package creation are required only if reached.
 */
export function createScriptObjectLookup({
  registry, names, coreObjectClass, corePackageClass,
  classOf = storedClass, superClass = storedSuper,
  getConfigString, createPackage, throwConfigError,
} = {}) {
  if (!(registry instanceof ScriptObjectRegistry) || typeof names?.intern !== 'function')
    throw new TypeError('Core lookup requires live object and FName registries');
  if (typeof classOf !== 'function' || typeof superClass !== 'function')
    throw new TypeError('Core lookup requires class storage accessors');

  function isA(object, target) {
    const seen = new Set();
    for (let cls = pointer(classOf(object)); cls !== null; cls = pointer(superClass(cls))) {
      if (!cls || typeof cls !== 'object') throw new Error('Unbound native Class identity');
      if (cls === target) return true;
      if (seen.has(cls)) throw new Error('Cyclic native class ancestry');
      seen.add(cls);
    }
    return target === null;
  }
  function classMatches(object, target, exactClass) {
    return target === null || (exactClass ? pointer(classOf(object)) === target : isA(object, target));
  }
  function requireCoreClass(cls, name) {
    if (!cls || typeof cls !== 'object') throw new Error(`Core lookup requires canonical ${name}`);
    return cls;
  }

  function resolveName(outerRef, nameRef, {create = 0, throwOnConfigMissing = 0} = {}) {
    requireReference(outerRef); requireReference(nameRef);
    let name = text(nameRef.get());
    const prefix = name.slice(0, 4).replace(/[A-Z]/g, letter => letter.toLowerCase());
    if ((prefix === 'ini:' || prefix === 'usr:') && name.length < 1024 && name.includes('.')) {
      const alias = name.slice(4), dot = alias.lastIndexOf('.');
      if (typeof getConfigString !== 'function')
        throw new Error('ResolveName reached an unbound config GetString (+0x10)');
      const query = {section: alias.slice(0, dot), key: alias.slice(dot + 1),
        file: prefix === 'ini:' ? 'System' : 'User', maxLength: 1024};
      const result = getConfigString(query);
      if (!result || typeof result.found !== 'boolean')
        throw new TypeError('ResolveName config lookup requires an explicit found result');
      if (!result.found) {
        if (throwOnConfigMissing) {
          if (typeof throwConfigError !== 'function')
            throw new Error('ResolveName localized config failure is not bound');
          throwConfigError({name, query});
          throw new Error('ResolveName config error adapter must throw');
        }
        return false;
      }
      name = text(result.value);
      if (name.length >= 1024) throw new Error('Config GetString exceeded its native destination');
      nameRef.set(name);
    }
    for (let dot = name.indexOf('.'); dot !== -1; dot = name.indexOf('.')) {
      const component = name.slice(0, dot), outer = pointer(outerRef.get());
      let next;
      if (create) {
        if (typeof createPackage !== 'function') throw new Error('ResolveName CreatePackage is not bound');
        next = createPackage({outer, name: component});
        if (next === undefined) throw new Error('CreatePackage must return a native object or null');
      } else {
        next = staticFindObject({classRef: requireCoreClass(corePackageClass, 'Core.Package'),
          outer, name: component, exactClass: 0});
        if (next === null) next = staticFindObject({
          classRef: requireCoreClass(coreObjectClass, 'Core.Object'), outer, name: component, exactClass: 0,
        });
        if (next === null) return false;
      }
      outerRef.set(pointer(next));
      name = name.slice(dot + 1); nameRef.set(name);
    }
    return true;
  }

  function staticFindObject({classRef = null, outer = null, name, exactClass = 0} = {}) {
    classRef = pointer(classRef);
    const initialOuter = outer;
    const outerRef = holder(outer === SCRIPT_OBJECT_LOOKUP.anyPackage ? null : pointer(outer));
    const nameRef = holder(text(name));
    if (!resolveName(outerRef, nameRef)) return null;
    const resolvedName = names.intern(nameRef.get(), 0);
    const nameIndex = resolvedName?.index;
    if (!Number.isInteger(nameIndex) || nameIndex < 0)
      throw new Error('Find-only FName lookup returned an invalid index');
    if (nameIndex === 0) return null;
    const resolvedOuter = outerRef.get();
    // An unregistered map actor hashes by its measured index (hashIndex).
    const outerIndex = resolvedOuter === null ? 0 : Number.isInteger(resolvedOuter?.index) ? resolvedOuter.index : resolvedOuter?.hashIndex;
    if (resolvedOuter !== null && !Number.isInteger(outerIndex))
      throw new Error('Object lookup requires Outer.Index');
    const bucket = (nameIndex ^ outerIndex) & 0xfff;
    const seen = new Set();
    for (let object = registry.buckets[bucket]; object !== null; object = object.hashNext) {
      if (!object || seen.has(object)) throw new Error('Invalid native object hash chain');
      seen.add(object);
      if (object.nameIndex === nameIndex && pointer(object.outer) === resolvedOuter &&
          classMatches(object, classRef, exactClass)) return object;
    }
    if (initialOuter === SCRIPT_OBJECT_LOOKUP.anyPackage) {
      const objectClass = requireCoreClass(coreObjectClass, 'Core.Object');
      for (const object of registry.objects) {
        if (object == null || !isA(object, objectClass)) continue;
        if (object.nameIndex === nameIndex && classMatches(object, classRef, exactClass)) return object;
      }
    }
    return null;
  }

  return {staticFindObject, resolveName, findObject: (outer, name) => staticFindObject({outer, name})};
}
