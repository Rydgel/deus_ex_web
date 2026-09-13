/**
 * Bounded translation of Core UObject::ResolveName's ordinary path.
 *
 * The body and helper call order are recovered in docs/script-resolve-name.md.
 * This module keeps mutable Outer/Name holders and delegates reached package
 * and object lookup edges to explicit synchronous services.  The config alias
 * path is deliberately an unsupported boundary; it is not inferred here.
 */

export const RESOLVE_NAME_NATIVE_CONTRACT = Object.freeze({
  thunk: 0x10102c34,
  body: 0x10154ad0,
  createPackageThunk: 0x10101ccb,
  createPackageBody: 0x101549f0,
  staticFindObjectThunk: 0x1010326a,
  staticFindObjectBody: 0x10151de0,
  appStrnicmp: 0x101029a0,
  appStrlen: 0x10101b04,
  appStrchr: 0x10101b9f,
  appStrcpy: 0x10102432,
  fNameText: 0x10102e96,
  corePackageClass: 0x1029b8e0,
  coreObjectClass: 0x1029e0d0,
  configPrefixes: Object.freeze(['ini:', 'usr:']),
  maxNameLength: 0x400,
  nameSeparator: '.',
});

export class ResolveNameBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', value = undefined, field = null} = {}) {
    super(message);
    this.name = 'ResolveNameBoundaryError';
    this.code = `RESOLVE_NAME_${kind}`;
    this.value = value;
    this.field = field;
  }
}

const fail = (message, details) => {
  throw new ResolveNameBoundaryError(message, details);
};

function requireObject(value, label) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    fail(`ResolveName requires ${label}`, {kind: 'REFERENCE', value, field: label});
  }
  return value;
}

function requireHolder(value, label) {
  if (typeof value?.get !== 'function' || typeof value?.set !== 'function') {
    fail(`ResolveName requires mutable ${label} holder`, {kind: 'HOLDER', value, field: label});
  }
  return value;
}

function requireName(value) {
  if (typeof value !== 'string') {
    fail('ResolveName requires UTF-16 name text', {kind: 'VALUE', value, field: 'Name'});
  }
  // Native appStr* helpers stop at the first NUL.  Keeping that boundary here
  // avoids turning an embedded terminator into a browser-only path component.
  return value.split('\0', 1)[0];
}

function requireInt(value, label) {
  if (!Number.isInteger(value)) {
    fail(`ResolveName requires integer ${label}`, {kind: 'VALUE', value, field: label});
  }
  return value;
}

function pointer(value) {
  return value === 0 ? null : value;
}

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`ResolveName ${label} service suspended; native path is synchronous`, {
      kind: 'ASYNC', value, field: label,
    });
  }
  return value;
}

function service(services, name) {
  if (typeof services?.[name] !== 'function') {
    fail(`ResolveName requires ${name} service`, {kind: 'SERVICE', field: name});
  }
  return services[name];
}

function emit(services, event) {
  if (services.trace === undefined) return;
  if (!Array.isArray(services.trace)) {
    fail('ResolveName trace must be an array', {kind: 'SERVICE', field: 'trace'});
  }
  services.trace.push(event);
}

function asciiFoldUnit(unit, name, offset) {
  // Core's reached CRT comparison is only established for the C-locale ASCII
  // path.  Do not let a browser locale define equivalence for an untraced
  // UTF-16 unit.
  if (unit > 0x7f) {
    fail('ResolveName ordinary prefix comparison requires ASCII UTF-16 units', {
      kind: 'ASCII', value: {name, offset, unit}, field: 'appStrnicmp',
    });
  }
  return unit >= 0x41 && unit <= 0x5a ? unit + 0x20 : unit;
}

function comparePrefix(name, prefix) {
  // appStrnicmp is a four-TCHAR comparison.  Compare UTF-16 code units and
  // fold only ASCII A-Z; String locale methods are not an evidence-backed
  // substitute for the original CRT.
  for (let offset = 0; offset < 4; offset++) {
    const left = offset < name.length ? name.charCodeAt(offset) : 0;
    const right = prefix.charCodeAt(offset);
    const foldedLeft = asciiFoldUnit(left, name, offset);
    const foldedRight = asciiFoldUnit(right, prefix, offset);
    if (foldedLeft !== foldedRight) return foldedLeft < foldedRight ? -1 : 1;
  }
  return 0;
}

function findDot(name) {
  return name.indexOf(RESOLVE_NAME_NATIVE_CONTRACT.nameSeparator);
}

function requireSupportedOrdinaryText(name) {
  // Keep all helper boundaries in the same explicitly validated subset.  A
  // non-ASCII unit in a later package component would otherwise bypass the
  // prefix comparator while still being presented as native-compatible text.
  for (let offset = 0; offset < name.length; offset++) {
    const unit = name.charCodeAt(offset);
    if (unit > 0x7f) {
      fail('ResolveName ordinary path requires ASCII UTF-16 units', {
        kind: 'ASCII', value: {name, offset, unit}, field: 'Name',
      });
    }
  }
  if (name.length >= RESOLVE_NAME_NATIVE_CONTRACT.maxNameLength) {
    fail('ResolveName ordinary path exceeds its 1024-TCHAR scratch boundary', {
      kind: 'LENGTH', value: name.length, field: 'Name',
    });
  }
  if (name.includes('"') || name.includes("'")) {
    fail('ResolveName quoted class/config syntax is outside this ordinary path', {
      kind: 'QUOTED', value: name, field: 'Name',
    });
  }
}

function canonicalResult(value, label) {
  if (value === undefined) {
    fail(`ResolveName ${label} returned an unbound result`, {kind: 'RETURN', value, field: label});
  }
  if (value !== null && value !== 0 && typeof value !== 'object' && typeof value !== 'function') {
    fail(`ResolveName ${label} returned a non-object`, {kind: 'REFERENCE', value, field: label});
  }
  return pointer(value);
}

function unsupportedConfig(name, prefix, throwOnConfigMissing) {
  fail('ResolveName reached the unbound config alias branch', {
    kind: 'CONFIG',
    value: {name, prefix, throwOnConfigMissing},
    field: 'config.GetString(+0x10)',
  });
}

/**
 * Execute the ordinary Core ResolveName path.
 *
 * `outerRef` and `nameRef` are mutable `{get,set}` cells.  `options` is the
 * native `(Create,Throw)` pair plus explicit host services:
 *
 * - `copyString({source,maxLength})` is the reached appStrcpy boundary and
 *   must return the copied UTF-16 text synchronously;
 * - `createPackage({outer,name})` is required for nonzero Create;
 * - `staticFindObject({classRef,outer,name,exactClass})`,
 *   `corePackageClass`, and `coreObjectClass` are required for Create=0;
 * - optional `trace` receives normalized helper/call events for comparison.
 */
export function resolveNameNative(
  outerRef,
  nameRef,
  {create = 0, throwOnConfigMissing = 0, services = {}} = {},
) {
  requireHolder(outerRef, 'Outer');
  requireHolder(nameRef, 'Name');
  requireInt(create, 'Create');
  requireInt(throwOnConfigMissing, 'Throw');
  if (services === null || typeof services !== 'object') {
    fail('ResolveName requires a service object', {kind: 'SERVICE', value: services});
  }

  let name = requireName(nameRef.get());
  requireSupportedOrdinaryText(name);
  const outer = pointer(outerRef.get());
  emit(services, {
    op: 'ResolveNameEnter', outer, name, create, throwOnConfigMissing,
  });

  // 10154b19–10154b4f.  Native appStrnicmp performs both comparisons even
  // when the first prefix does not match.
  const prefixResults = RESOLVE_NAME_NATIVE_CONTRACT.configPrefixes.map(prefix => {
    const result = comparePrefix(name, prefix);
    emit(services, {
      op: 'appStrnicmp', left: name.slice(0, 4), right: prefix,
      count: 4, result,
    });
    return result === 0;
  });

  if (prefixResults[0] || prefixResults[1]) {
    // 10154b55–10154b63.  appStrlen is reached only after one of the prefix
    // comparisons succeeds; an ordinary name jumps directly to 10154c4e.
    const length = name.length;
    emit(services, {op: 'appStrlen', text: name, length});
    if (length < RESOLVE_NAME_NATIVE_CONTRACT.maxNameLength && findDot(name) !== -1) {
      // The original strips the prefix, splits the last dot, calls the config
      // object's virtual +0x10, and feeds a static 1024-TCHAR buffer back into
      // the ordinary loop.  That graph is outside this ordinary-path task.
      unsupportedConfig(name, prefixResults[0] ? 'ini:' : 'usr:', throwOnConfigMissing);
    }
  }

  while (true) {
    // 10154b69 and 10154c54.  Each iteration checks the current *Name before
    // deciding whether a package component remains.
    const dot = findDot(name);
    emit(services, {op: 'appStrchr', text: name, char: '.', index: dot, found: dot !== -1});
    if (dot === -1) {
      return true;
    }

    const component = name.slice(0, dot);
    emit(services, {op: 'appStrcpy', text: name, maxLength: RESOLVE_NAME_NATIVE_CONTRACT.maxNameLength});
    const copied = sync(service(services, 'copyString')({
      source: name,
      maxLength: RESOLVE_NAME_NATIVE_CONTRACT.maxNameLength,
    }), 'appStrcpy');
    if (typeof copied !== 'string') {
      fail('ResolveName appStrcpy must return copied UTF-16 text', {
        kind: 'RETURN', value: copied, field: 'appStrcpy',
      });
    }
    if (copied.split('\0', 1)[0] !== name) {
      fail('ResolveName appStrcpy changed the ordinary path', {
        kind: 'RETURN', value: copied, field: 'appStrcpy',
      });
    }
    const copiedDot = findDot(copied);
    if (copiedDot === -1) {
      // The native body asserts this impossible state after the first scan.
      fail('ResolveName copied name lost its separator', {kind: 'NATIVE', value: copied});
    }
    emit(services, {
      op: 'appStrchr', text: copied, char: '.', index: copiedDot, found: true,
    });

    const currentOuter = pointer(outerRef.get());
    let next;
    if (create) {
      emit(services, {op: 'CreatePackageEnter', outer: currentOuter, name: component});
      next = canonicalResult(sync(service(services, 'createPackage')({
        outer: currentOuter,
        name: component,
      }), 'CreatePackage'), 'CreatePackage');
    } else {
      const packageClass = requireObject(services.corePackageClass, 'Core.Package class');
      emit(services, {
        op: 'StaticFindObjectEnter', classRef: packageClass, outer: currentOuter,
        name: component, exactClass: 0,
      });
      next = canonicalResult(sync(service(services, 'staticFindObject')({
        classRef: packageClass,
        outer: currentOuter,
        name: component,
        exactClass: 0,
      }), 'StaticFindObject(Core.Package)'), 'StaticFindObject(Core.Package)');
      if (next === null) {
        const objectClass = requireObject(services.coreObjectClass, 'Core.Object class');
        emit(services, {
          op: 'StaticFindObjectEnter', classRef: objectClass, outer: currentOuter,
          name: component, exactClass: 0,
        });
        next = canonicalResult(sync(service(services, 'staticFindObject')({
          classRef: objectClass,
          outer: currentOuter,
          name: component,
          exactClass: 0,
        }), 'StaticFindObject(Core.Object)'), 'StaticFindObject(Core.Object)');
      }
      if (next === null) {
        return false;
      }
    }

    // 10154ce5–10154cf8.  Native publishes the package result and advances
    // *Name only after the component lookup has returned.
    outerRef.set(next);
    emit(services, {op: 'appStrchr', text: name, char: '.', index: dot, found: true});
    name = name.slice(dot + 1);
    nameRef.set(name);
  }
}

// The short name is useful to callers that already bind the Core function by
// its exported symbol; it is the same bounded implementation and carries no
// compatibility aliases for other path syntaxes.
export const resolveName = resolveNameNative;

export default resolveNameNative;
