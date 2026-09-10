/**
 * The bounded Core package-construction path recovered from the installed
 * GOTY image.  Name/path lookup, allocation, and BindPackage remain explicit
 * host boundaries because they own global native state outside this helper.
 * See docs/script-package-construction.md for the source trace.
 */

export const SCRIPT_PACKAGE_CONSTRUCTION = Object.freeze({
  createPackageThunk: 0x10101ccb,
  createPackage: 0x101549f0,
  resolveName: 0x10102c34,
  staticFindObject: 0x1010326a,
  packageClass: 0x1029b8e0,
  operatorNewThunk: 0x10102e82,
  operatorNew: 0x1010cb20,
  staticAllocateObjectThunk: 0x10102ec3,
  staticAllocateObject: 0x101579c0,
  packageConstructorThunk: 0x10101a9b,
  packageConstructor: 0x1015a3e0,
  bindPackageThunk: 0x101017e9,
  bindPackage: 0x10152ff0,
  packageVtable: 0x101753a0,
  packageSize: 0x34,
  packageFlags: 0x4,
  findName: 0x1,
  noSubobjectRoot: null,
});

const CONFIG = SCRIPT_PACKAGE_CONSTRUCTION;

function requireObject(value, name) {
  if (!value || typeof value !== 'object') throw new TypeError(`CreatePackage requires ${name}`);
  return value;
}

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`CreatePackage requires ${name} callback`);
  return value;
}

function text(value, name) {
  if (typeof value !== 'string') throw new TypeError(`CreatePackage requires ${name} text`);
  const nul = value.indexOf('\u0000');
  return nul < 0 ? value : value.slice(0, nul);
}

function pointer(value) {
  // Native null pointers are represented by zero.  Preserve `undefined` on
  // service returns so an omitted adapter result cannot masquerade as a
  // successful null allocation.
  return value === null || value === 0 ? null : value;
}

function mutableHolder(value, setValue) {
  return {
    get: () => value,
    set: next => {
      value = pointer(next);
      setValue?.(value);
      return value;
    },
  };
}

function requireFName(value, sourceName) {
  if (Number.isInteger(value) && value >= 0) {
    return {index: value, name: sourceName};
  }
  if (!value || typeof value !== 'object' || !Number.isInteger(value.index) || value.index < 0) {
    throw new TypeError('CreatePackage requires FName intern(text,1) to return an indexed value');
  }
  return value;
}

function writePackageVtable(object) {
  // UPackage::UPackage writes the virtual table before BindPackage.  When a
  // host exposes raw slots, keep that live +0 holder synchronized instead of
  // creating a detached JS-only value.
  object.nativeVtable = CONFIG.packageVtable;
  if (object.nativeSlots === undefined) return;
  if (!(object.nativeSlots instanceof Map)) {
    throw new TypeError('UPackage nativeSlots must be an offset Map');
  }
  const holder = object.nativeSlots.get(0);
  if (holder === undefined) {
    object.nativeSlots.set(0, {value: CONFIG.packageVtable, width: 4});
    return;
  }
  if (!holder || typeof holder !== 'object' || holder.width !== 4) {
    throw new TypeError('UPackage vtable slot +0 must be a four-byte holder');
  }
  holder.value = CONFIG.packageVtable;
}

/**
 * Apply the selected UPackage native constructor.
 *
 * `bindPackage` is mandatory: the original constructor calls the static
 * BindPackage routine after writing its vtable, and this helper never turns
 * that reached native call into an empty success path.
 */
export function constructScriptPackage(object, {bindPackage} = {}) {
  requireObject(object, 'an allocated package object');
  requireFunction(bindPackage, 'BindPackage');
  writePackageVtable(object);
  bindPackage(object, {
    address: CONFIG.bindPackage,
    thunk: CONFIG.bindPackageThunk,
    kind: 'UPackage::BindPackage',
  });
  return object;
}

/**
 * Translate UObject::CreatePackage for the ordinary Core package path.
 *
 * Required services are deliberately narrow and source-shaped:
 *
 *   lookup.resolveName(outerRef, nameRef, {create: 1, throwOnConfigMissing: 0})
 *   lookup.staticFindObject({classRef, outer, name, exactClass: 0})
 *   internName(name, 1) -> {index, name, ...}
 *   staticAllocateObject({classRef, outer, name, nameText, nameIndex,
 *     size: 0x34, flags: 4, errorDevice, subobjectRoot: null}) -> object|null
 *   bindPackage(object, detail)
 *
 * The original CreatePackage ignores ResolveName's boolean result, so this
 * translation does the same while preserving the resolver's mutated holders.
 * A missing allocation returns null; an undefined result from a required
 * service is rejected as an unbound adapter rather than treated as success.
 */
export function createScriptPackage({
  outer = null,
  name,
  packageClass,
  lookup,
  internName,
  staticAllocateObject,
  errorDevice,
  bindPackage,
} = {}) {
  if (!lookup || typeof lookup !== 'object') throw new TypeError('CreatePackage requires object lookup services');
  requireFunction(lookup.resolveName, 'ResolveName');
  requireFunction(lookup.staticFindObject, 'StaticFindObject');
  requireObject(packageClass, 'canonical Core.Package class identity');

  let resolvedOuter = pointer(outer);
  let resolvedName = text(name, 'package name');
  const outerRef = mutableHolder(resolvedOuter, value => { resolvedOuter = value; });
  const nameRef = {
    get: () => resolvedName,
    set: next => {
      resolvedName = text(next, 'resolved package name');
      return resolvedName;
    },
  };

  // 10154a14–10154a24: ResolveName(&Outer,&Name,1,0).  EAX is deliberately
  // ignored by the native caller; errors thrown by a reached required branch
  // still propagate from the host adapter.
  lookup.resolveName(outerRef, nameRef, {
    create: 1,
    throwOnConfigMissing: 0,
  });

  // 10154a32–10154a45: StaticFindObject(Core.Package,Outer,Name,0).
  let existing = lookup.staticFindObject({
    classRef: packageClass,
    outer: resolvedOuter,
    name: resolvedName,
    exactClass: 0,
  });
  existing = pointer(existing);
  if (existing === undefined) {
    throw new TypeError('StaticFindObject must return an object or null');
  }
  if (existing !== null) return existing;

  // These branches are not reached for an existing package. In particular,
  // a lookup-only caller does not need an allocator or a DLL binding service.
  requireFunction(internName, 'FName interning');
  requireFunction(staticAllocateObject, 'StaticAllocateObject');
  if (errorDevice === undefined)
    throw new TypeError('CreatePackage allocation requires explicit ErrorDevice/GWarn value');

  // 10154a47–10154a60: FName(Name,EFindName=1), followed by
  // operator new(0x34,Outer,FName,4).  FName is a single scalar in this
  // image; the name result is retained as the host's canonical FName value.
  const fName = requireFName(internName(resolvedName, CONFIG.findName), resolvedName);
  const allocation = {
    address: CONFIG.staticAllocateObject,
    thunk: CONFIG.staticAllocateObjectThunk,
    kind: 'UPackage::operator new -> StaticAllocateObject',
    classRef: packageClass,
    outer: resolvedOuter,
    name: fName,
    nameText: fName.name ?? resolvedName,
    nameIndex: fName.index,
    size: CONFIG.packageSize,
    flags: CONFIG.packageFlags,
    errorDevice,
    subobjectRoot: CONFIG.noSubobjectRoot,
  };
  const allocated = pointer(staticAllocateObject(allocation));
  if (allocated === null) return null;
  if (allocated === undefined || typeof allocated !== 'object') {
    throw new TypeError('StaticAllocateObject must return an object or null');
  }
  return constructScriptPackage(allocated, {bindPackage});
}

/**
 * Create the callback suitable for createScriptObjectLookup({createPackage}).
 * The lookup must itself be configured with this callback when it resolves a
 * dotted name, so recursive package components reuse the same exact path.
 */
export function createScriptPackageFactory(services = {}) {
  requireObject(services, 'package services');
  return ({outer = null, name} = {}) => createScriptPackage({...services, outer, name});
}

export default createScriptPackage;
