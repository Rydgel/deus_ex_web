/** Core UFunction::Bind and its owner/CPP-name services.
 * Original instructions and boundaries: docs/script-function-bind.md. */
export const FUNCTION_BIND_CONTRACT = Object.freeze({
  body: 0x10129320, thunk: 0x10101d57, nativeFlag: 0x400,
  nativeTable: 0x101f41b8, nativeLimit: 0x1000,
  scriptHandler: 0x10101acd, undefinedHandler: 0x10101e60,
});

export class FunctionBindBoundaryError extends Error {
  constructor(message, {kind = 'SERVICE', line = null} = {}) {
    super(message);
    this.name = 'FunctionBindBoundaryError';
    this.code = `FUNCTION_BIND_${kind}`;
    this.line = line;
  }
}

function call(services, name, ...args) {
  if (typeof services[name] !== 'function')
    throw new FunctionBindBoundaryError(`Function Bind requires ${name}`);
  const value = services[name](...args);
  if (value && typeof value.then === 'function')
    throw new FunctionBindBoundaryError(`Function Bind ${name} suspended`, {kind: 'ASYNC'});
  return value;
}
function read(services, object, field) {
  const value = call(services, 'read', object, field);
  if (value === undefined)
    throw new FunctionBindBoundaryError(`Function Bind unresolved ${field}`, {kind: 'FIELD'});
  return value;
}
function uint(value, max, label) {
  if (!Number.isInteger(value) || value < 0 || value > max)
    throw new FunctionBindBoundaryError(`Function Bind requires ${label}`, {kind: 'FIELD'});
  return value;
}
function check(condition, line, message) {
  if (!condition) throw new FunctionBindBoundaryError(`Original UFunction::Bind assertion: ${message}`,
    {kind: 'ASSERT', line});
}

export function bindScriptFunction(object, services) {
  const flags = uint(read(services, object, 'functionFlags'), 0xffffffff, 'uint32 FunctionFlags');
  const index = uint(read(services, object, 'nativeIndex'), 0xffff, 'uint16 iNative');
  if (!(flags & FUNCTION_BIND_CONTRACT.nativeFlag)) {
    check(index === 0, 0x57a, 'iNative == 0');
    call(services, 'write', object, 'nativeFunction', FUNCTION_BIND_CONTRACT.scriptHandler);
  } else if (index !== 0) {
    check(index < FUNCTION_BIND_CONTRACT.nativeLimit, 0x580, 'iNative < MAX_NATIVE_FUNC');
    const pointer = uint(call(services, 'readNative', index), 0xffffffff, 'GNatives entry');
    check(pointer !== 0, 0x581, 'GNatives[iNative] != NULL');
    call(services, 'write', object, 'nativeFunction', pointer);
  } else {
    const owner = call(services, 'getOwnerClass', object);
    const cpp = call(services, 'getNameCPP', owner);
    const name = call(services, 'getName', object);
    if (typeof cpp !== 'string' || typeof name !== 'string')
      throw new FunctionBindBoundaryError('Function Bind requires native name text', {kind: 'FIELD'});
    const exportName = `int${cpp}exec${name}`;
    const currentOwner = call(services, 'getOwnerClass', object);
    const outer = read(services, currentOwner, 'outer');
    const cell = call(services, 'getDllExport', outer, exportName, 1);
    if (cell !== null && cell !== 0) {
      const pointer = uint(call(services, 'readPointer', cell), 0xffffffff, 'DLL export cell');
      call(services, 'write', object, 'nativeFunction', pointer);
    }
  }
}

/** UField::GetOwnerClass compares Class exactly, rather than using IsA. */
export function getFieldOwnerClass(field, services) {
  if (!services.classClass) throw new FunctionBindBoundaryError('GetOwnerClass requires Core.Class identity');
  let object = field;
  const seen = new Set();
  while (object !== null && object !== 0) {
    if (seen.has(object)) throw new FunctionBindBoundaryError('Cyclic GetOwnerClass Outer', {kind: 'FIELD'});
    seen.add(object);
    if (read(services, object, 'class') === services.classClass) return object;
    object = read(services, object, 'outer');
  }
  throw new FunctionBindBoundaryError('GetOwnerClass reached null Outer', {kind: 'FIELD'});
}

/** UClass::GetNameCPP's text result. Native scratch-buffer ownership is external. */
export function getScriptClassNameCPP(cls, services) {
  let current = cls, actor = false;
  const seen = new Set();
  while (current !== null && current !== 0) {
    if (seen.has(current)) throw new FunctionBindBoundaryError('Cyclic GetNameCPP superclass', {kind: 'FIELD'});
    seen.add(current);
    const currentName = call(services, 'getName', current);
    if (typeof currentName !== 'string') throw new FunctionBindBoundaryError('GetNameCPP unresolved name');
    if (currentName.replace(/[A-Z]/g, letter => letter.toLowerCase()) === 'actor') {
      actor = true;
      break;
    }
    current = read(services, current, 'superField');
  }
  return `${actor ? 'A' : 'U'}${call(services, 'getName', cls)}`;
}
