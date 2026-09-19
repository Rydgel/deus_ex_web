/** Original Core ConditionalPostLoad and metadata PostLoad bodies.
 * Virtual dispatch and binding are explicit synchronous services. Evidence and
 * the unimplemented resource/SEH boundaries are in docs/script-end-load.md.
 */
export const POST_LOAD_CONTRACT = Object.freeze({
  conditional: 0x1014ff70,
  object: 0x1014f9b0,
  field: 0x10125bf0,
  struct: 0x10128f30,
  function: 0x101291a0,
  class: 0x10127d70,
  needPostLoad: 0x01000000,
  basePostLoadCalled: 0x20000000,
  clearBeforeDispatch: 0xdeffffff,
  missingBaseFormat: 0x101adce0,
});

export class PostLoadBoundaryError extends Error {
  constructor(message, {kind = 'SERVICE', line = null} = {}) {
    super(message);
    this.name = 'PostLoadBoundaryError';
    this.code = `POST_LOAD_${kind}`;
    this.line = line;
  }
}

function call(services, name, ...args) {
  if (typeof services[name] !== 'function')
    throw new PostLoadBoundaryError(`PostLoad requires ${name} service`);
  const value = services[name](...args);
  if (value && typeof value.then === 'function')
    throw new PostLoadBoundaryError(`PostLoad ${name} service suspended`, {kind: 'ASYNC'});
  return value;
}

function read(services, object, field) {
  const value = call(services, 'read', object, field);
  if (value === undefined)
    throw new PostLoadBoundaryError(`PostLoad reached unresolved ${field}`, {kind: 'FIELD'});
  return value;
}

function flags(services, object) {
  const value = read(services, object, 'objectFlags');
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
    throw new PostLoadBoundaryError('PostLoad requires uint32 UObject flags', {kind: 'FIELD'});
  return value;
}

export function conditionalPostLoad(object, services) {
  const before = flags(services, object);
  if (!(before & POST_LOAD_CONTRACT.needPostLoad)) return;
  call(services, 'write', object, 'objectFlags', (before & POST_LOAD_CONTRACT.clearBeforeDispatch) >>> 0);
  call(services, 'postLoad', object);
  if (!(flags(services, object) & POST_LOAD_CONTRACT.basePostLoadCalled)) {
    const fullName = call(services, 'getFullName', object, 0);
    if (services.errorReceiver === undefined)
      throw new PostLoadBoundaryError('PostLoad requires the error Logf receiver');
    call(services, 'errorLogf', {receiver: services.errorReceiver,
      formatPointer: POST_LOAD_CONTRACT.missingBaseFormat, fullName});
  }
}

export function postLoadObject(object, services) {
  call(services, 'write', object, 'objectFlags',
    (flags(services, object) | POST_LOAD_CONTRACT.basePostLoadCalled) >>> 0);
}

export function postLoadField(object, services) {
  postLoadObject(object, services);
  call(services, 'bind', object);
}

export function postLoadStruct(object, services) {
  postLoadField(object, services);
}

export function postLoadFunction(object, services) {
  postLoadStruct(object, services);
}

export function postLoadClass(object, services) {
  if (!read(services, object, 'classWithin'))
    throw new PostLoadBoundaryError('Original UClass::PostLoad ClassWithin assertion',
      {kind: 'ASSERT', line: 0x362});
  postLoadStruct(object, services);
  const base = read(services, object, 'superField');
  if (base !== null && base !== 0) call(services, 'conditionalPostLoad', base);
}
