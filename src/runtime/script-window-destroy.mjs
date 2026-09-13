/**
 * Recovered Extension.Window.Destroy -> XWindow destruction boundary.
 *
 * The native wrapper owns the frame guard increment and XWindow's
 * SafeDestroy/PreDestroy/KillAllChildren/CleanUp order.  Core allocation,
 * UObject registry invalidation, the class-specific destructor and GC leaves
 * remain synchronous host services.  The evidence and the intentionally
 * bounded inputs are recorded in docs/script-window-destroy.md.
 */

const freeze = value => Object.freeze(value);

const EXTENSION_HASH =
  '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c';

export const WINDOW_DESTROY_NATIVE = freeze({
  package: 'Extension',
  function: 'Window.Destroy',
  packageExport: 2129,
  nativeIndex: 1409,
  functionFlags: 0x401,
  serialSize: 27,
  dll: 'Extension.dll',
  dllSha256: EXTENSION_HASH,
  imageBase: 0x10000000,
  execThunk: 0x10051830,
  execEnd: 0x1005183d,
  execSha256: '6b0ef2d88d1e5045d8b7c3ed301cb552f68840fc5aadaf522f296bf28f7b440c',
  functions: freeze({
    safeDestroy: freeze({
      name: 'XWindow::SafeDestroy',
      body: 0x1004c0b0,
      end: 0x1004c10c,
      bodySha256: '91fb19753e085b7b0646e3c025db32da43ba0bfa35464dd46136d0c2b452380e',
    }),
    preDestroy: freeze({
      name: 'XWindow::PreDestroy',
      body: 0x10050500,
      end: 0x1005059f,
      bodySha256: '1170ff85f97d821a3adceb41a0db14d6174cb0c8fccf08dd984db7f46176ccf3',
    }),
    killAllChildren: freeze({
      name: 'XWindow::KillAllChildren',
      body: 0x100505d0,
      end: 0x10050652,
      bodySha256: '5c253430609c420c7632510279ed6d12f96c38dc0b44dc55fd177d2a7a7da560',
    }),
    cleanUp: freeze({
      name: 'XWindow::CleanUp',
      body: 0x1004bec0,
      end: 0x1004bfda,
      bodySha256: 'f3d2f014843b27f47b5c47b868b2da6577b8f389a0bb0c63206780bb812d95af',
    }),
    xwindowDestroy: freeze({
      name: 'XWindow::Destroy',
      body: 0x1004c010,
      end: 0x1004c077,
      bodySha256: '80d95bbaea81865dbc60640c42f0bc686c75d9a9116f8cede51002b14a897dc9',
    }),
    xwindowDestructor: freeze({
      name: 'XWindow::~XWindow',
      body: 0x100030b0,
      end: 0x10003117,
      bodySha256: '024ec08bd261daed89ab1dd905df4f10761d83b1f27c02480ac3b98cc325c830',
    }),
    deletingDestructor: freeze({
      name: 'XWindow scalar deleting destructor',
      body: 0x10004860,
      end: 0x100048a0,
      bodySha256: '3746497d10af00c8ab990bcfc137ef413268088a01731dbeca67af65d5b9c94e',
    }),
  }),
});

export const WINDOW_DESTROY_NATIVE_ADDRESSES = freeze({
  execDestroy: WINDOW_DESTROY_NATIVE.execThunk,
  execDestroyEnd: WINDOW_DESTROY_NATIVE.execEnd,
  safeDestroy: WINDOW_DESTROY_NATIVE.functions.safeDestroy.body,
  preDestroy: WINDOW_DESTROY_NATIVE.functions.preDestroy.body,
  killAllChildren: WINDOW_DESTROY_NATIVE.functions.killAllChildren.body,
  cleanUp: WINDOW_DESTROY_NATIVE.functions.cleanUp.body,
  xwindowDestroy: WINDOW_DESTROY_NATIVE.functions.xwindowDestroy.body,
  xwindowDestructor: WINDOW_DESTROY_NATIVE.functions.xwindowDestructor.body,
  deletingDestructor: WINDOW_DESTROY_NATIVE.functions.deletingDestructor.body,
  extensionDestroyWindow: 0x1009b348,
  setVisibility: 0x1004c7d0,
  setSelectability: 0x1004c390,
  processScript: 0x1004ded0,
  getRootWindow: 0x1004c5a0,
  removeChild: 0x10050a00,
  gMallocIat: 0x10059060,
  allocatorFreeSlot: 0x08,
  childRemovedSlot: 0x6c,
  descendantRemovedSlot: 0x74,
  cleanUpSlot: 0x58,
  deletingDestructorSlot: 0x0c,
  xwindowVtable: 0x10059930,
  extensionObjectVtable: 0x10059888,
});

export const WINDOW_DESTROY_OFFSETS = freeze({
  vtable: 0x00,
  type: 0x28,
  windowFlags: 0x30,
  lockCount: 0x34,
  gcListA: 0x128,
  gcListB: 0x12c,
  gcContextA: 0x130,
  gcContextB: 0x134,
  parent: 0x138,
  firstChild: 0x13c,
  lastChild: 0x140,
  previousSibling: 0x144,
  nextSibling: 0x148,
  rootFocus: 0x5a0,
  rootGrab: 0x5c4,
  gcNodeNext: 0x1c,
  frameGuard: 0x0c,
});

export const WINDOW_DESTROY_BITS = freeze({
  visibleChain: 0x01,
  bBeingDestroyed: 0x10,
});

export const WINDOW_DESTROY_NATIVE_CONTRACT = freeze({
  name: 'Extension.Window.Destroy / XWindow::SafeDestroy',
  address: WINDOW_DESTROY_NATIVE.execThunk,
  arguments: freeze(['FFrame* Stack']),
  returns: 'bool (SafeDestroy result)',
  wrapper: freeze([
    'increment Stack +0x0c',
    'SafeDestroy(this)',
  ]),
  safeDestroy: freeze([
    'PreDestroy(this)',
    'if lockCount +0x34 > 0 return false',
    'virtual scalar deleting destructor +0x0c(this, 1)',
    'return true',
  ]),
  preDestroy: freeze([
    'if bBeingDestroyed bit +0x30/0x10 return',
    'walk visible-chain bit +0x30/0x01 through parent +0x138',
    'SetVisibility(this, 0) when the chain reaches null',
    'SetSelectability(this, 0)',
    'KillAllChildren(this)',
    'ProcessScript(this, EXTENSION_DestroyWindow, NULL, 1)',
    'virtual CleanUp +0x58',
    'set bBeingDestroyed bit +0x30/0x10',
  ]),
  cleanUp: freeze([
    'GetRootWindow(this)',
    'ChildRemoved(parent, this), then DescendantRemoved for reread ancestors',
    'clear root focus +0x5a0 and root grab +0x5c4 when they equal this',
    'free linked GC allocations at +0x128 and +0x12c',
    'destroy GC contexts at +0x130 and +0x134',
    'reread parent and RemoveChild(parent, this)',
  ]),
  rawStorage: 'read(object, offset, kind, details) / write(object, offset, kind, value, details)',
  leaves: freeze([
    'SetVisibility',
    'SetSelectability',
    'ProcessScript',
    'ChildRemoved / DescendantRemoved',
    'freeGc / destroyGc',
    'subclassDestructor or deleteWindow',
    'setVtable / conditionalDestroy / uobjectDestructor',
    'invalidateObject / freeObject',
  ]),
});

export class WindowDestroyNativeBoundaryError extends Error {
  constructor(message, {
    kind = 'BOUNDARY', value = undefined, object = undefined,
    offset = null, operation = null, field = null,
  } = {}) {
    super(message);
    this.name = 'WindowDestroyNativeBoundaryError';
    this.code = `WINDOW_DESTROY_${kind}`;
    this.value = value;
    this.object = object;
    this.offset = offset;
    this.operation = operation;
    this.field = field;
  }
}

const fail = (message, details = {}) => {
  throw new WindowDestroyNativeBoundaryError(message, details);
};

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`Window.Destroy ${label} service suspended; native path is synchronous`, {
      kind: 'ASYNC', value, operation: label,
    });
  }
  return value;
}

function required(value, name) {
  if (typeof value !== 'function') {
    fail(`Window.Destroy requires ${name} service`, {kind: 'SERVICE', operation: name});
  }
  return value;
}

function canonical(value, name, {allowNull = false} = {}) {
  if (allowNull && (value === null || value === 0)) return null;
  if (value === null || value === undefined || value === 0 ||
      (typeof value !== 'object' && typeof value !== 'function' && typeof value !== 'number')) {
    fail(`Window.Destroy requires canonical ${name}`, {kind: 'REFERENCE', value, operation: name});
  }
  if (typeof value === 'number' &&
      (!Number.isInteger(value) || value < 0 || value > 0xffffffff)) {
    fail(`Window.Destroy requires uint32 ${name} pointer`, {kind: 'VALUE', value, operation: name});
  }
  return value;
}

function present(value) {
  return value !== null && value !== undefined && value !== 0;
}

function pointer(value, name, details = {}) {
  if (!present(value)) return null;
  return canonical(value, name, details);
}

function integer(value, kind, name, details = {}) {
  if (!Number.isInteger(value)) {
    fail(`Window.Destroy requires ${kind} ${name}`, {kind: 'VALUE', value, operation: name, ...details});
  }
  if (kind === 'uint32' && (value < 0 || value > 0xffffffff)) {
    fail(`Window.Destroy requires uint32 ${name}`, {kind: 'VALUE', value, operation: name, ...details});
  }
  if (kind === 'int32' && (value < -0x80000000 || value > 0x7fffffff)) {
    fail(`Window.Destroy requires int32 ${name}`, {kind: 'VALUE', value, operation: name, ...details});
  }
  if (kind === 'uint8' && (value < 0 || value > 0xff)) {
    fail(`Window.Destroy requires uint8 ${name}`, {kind: 'VALUE', value, operation: name, ...details});
  }
  return kind === 'uint32' ? value >>> 0 : value;
}

function rawDetails(phase, object, offset, kind) {
  return {
    native: phase === 'execDestroy'
      ? WINDOW_DESTROY_NATIVE_ADDRESSES.execDestroy
      : WINDOW_DESTROY_NATIVE_ADDRESSES[phase] || WINDOW_DESTROY_NATIVE_ADDRESSES.safeDestroy,
    phase, object, offset, kind,
    width: kind === 'u8' ? 1 : 4,
  };
}

function readRaw(object, offset, kind, services, phase) {
  const read = required(services.read, 'read');
  const value = sync(read(object, offset, kind, rawDetails(phase, object, offset, kind)),
    `read +0x${offset.toString(16)}`);
  if (value === undefined) {
    fail(`Window.Destroy reached unresolved raw field +0x${offset.toString(16)}`, {
      kind: 'FIELD', value, object, offset, operation: phase,
    });
  }
  if (kind === 'ptr') return pointer(value, `+0x${offset.toString(16)} pointer`, {object, offset});
  if (kind === 'u8') return integer(value, 'uint8', `+0x${offset.toString(16)}`, {object, offset});
  if (kind === 'u32') return integer(value, 'uint32', `+0x${offset.toString(16)}`, {object, offset});
  if (kind === 'i32') return integer(value, 'int32', `+0x${offset.toString(16)}`, {object, offset});
  fail(`Window.Destroy does not support raw read kind ${kind}`, {kind: 'VALUE', value: kind});
}

function writeRaw(object, offset, kind, value, services, phase) {
  const write = required(services.write, 'write');
  let normalized = value;
  if (kind === 'ptr') normalized = pointer(value, `+0x${offset.toString(16)} pointer`, {object, offset});
  else if (kind === 'u8') normalized = integer(value, 'uint8', `+0x${offset.toString(16)}`, {object, offset});
  else if (kind === 'u32') normalized = integer(value, 'uint32', `+0x${offset.toString(16)}`, {object, offset});
  else if (kind === 'i32') normalized = integer(value, 'int32', `+0x${offset.toString(16)}`, {object, offset});
  else fail(`Window.Destroy does not support raw write kind ${kind}`, {kind: 'VALUE', value: kind});
  return sync(write(object, offset, kind, normalized, rawDetails(phase, object, offset, kind)),
    `write +0x${offset.toString(16)}`);
}

function event(services, op, details = {}) {
  if (typeof services.onEvent === 'function') {
    sync(services.onEvent({op, ...details}), op);
  }
}

function call(service, name, details) {
  return sync(required(service, name)(details), name);
}

function readPointer(object, offset, services, phase) {
  return readRaw(object, offset, 'ptr', services, phase);
}

function writePointer(object, offset, value, services, phase) {
  return writeRaw(object, offset, 'ptr', value, services, phase);
}

/** The native GetRootWindow helper, limited to canonical resolved pointers. */
export function getRootWindowForDestroyNative(object, services = {}) {
  let current = canonical(object, 'Window');
  const seen = new Set();
  for (;;) {
    if (seen.has(current)) {
      fail('Window.Destroy received a cyclic native window hierarchy', {
        kind: 'REFERENCE', object: current, operation: 'GetRootWindow',
      });
    }
    seen.add(current);
    const parent = readPointer(current, WINDOW_DESTROY_OFFSETS.parent, services, 'getRootWindow');
    if (parent === null) break;
    current = canonical(parent, 'Window parent');
  }
  const type = readRaw(current, WINDOW_DESTROY_OFFSETS.type, 'u8', services, 'getRootWindow');
  return type >= 3 ? current : null;
}

function unlinkChild(parent, child, services) {
  const lower = readPointer(child, WINDOW_DESTROY_OFFSETS.previousSibling, services, 'removeChild');
  const higher = readPointer(child, WINDOW_DESTROY_OFFSETS.nextSibling, services, 'removeChild');
  if (lower !== null) {
    writePointer(lower, WINDOW_DESTROY_OFFSETS.nextSibling, higher, services, 'removeChild');
  } else {
    writePointer(parent, WINDOW_DESTROY_OFFSETS.firstChild, higher, services, 'removeChild');
  }
  if (higher !== null) {
    writePointer(higher, WINDOW_DESTROY_OFFSETS.previousSibling, lower, services, 'removeChild');
  } else {
    writePointer(parent, WINDOW_DESTROY_OFFSETS.lastChild, lower, services, 'removeChild');
  }
  writePointer(child, WINDOW_DESTROY_OFFSETS.nextSibling, null, services, 'removeChild');
  writePointer(child, WINDOW_DESTROY_OFFSETS.previousSibling, null, services, 'removeChild');
  writePointer(child, WINDOW_DESTROY_OFFSETS.parent, null, services, 'removeChild');
}

/** XWindow::CleanUp.  A supplied removeChild service may own the native link. */
export function cleanUpWindowNative(object, services = {}) {
  const window = canonical(object, 'Window');
  event(services, 'CleanUp', {object: window, native: WINDOW_DESTROY_NATIVE_ADDRESSES.cleanUp});
  return cleanUpWindowBody(window, services);
}

function cleanUpWindowBody(window, services) {
  const root = getRootWindowForDestroyNative(window, services);

  let parent = readPointer(window, WINDOW_DESTROY_OFFSETS.parent, services, 'cleanUp');
  if (parent !== null) {
    event(services, 'ChildRemoved', {
      parent, child: window, virtualSlot: WINDOW_DESTROY_NATIVE_ADDRESSES.childRemovedSlot,
    });
    call(services.childRemoved, 'ChildRemoved', {
      parent, child: window, virtualSlot: WINDOW_DESTROY_NATIVE_ADDRESSES.childRemovedSlot,
      native: WINDOW_DESTROY_NATIVE_ADDRESSES.cleanUp,
    });
    parent = readPointer(window, WINDOW_DESTROY_OFFSETS.parent, services, 'cleanUp');
    while (parent !== null) {
      event(services, 'DescendantRemoved', {
        ancestor: parent, child: window,
        virtualSlot: WINDOW_DESTROY_NATIVE_ADDRESSES.descendantRemovedSlot,
      });
      call(services.descendantRemoved, 'DescendantRemoved', {
        ancestor: parent, child: window,
        virtualSlot: WINDOW_DESTROY_NATIVE_ADDRESSES.descendantRemovedSlot,
        native: WINDOW_DESTROY_NATIVE_ADDRESSES.cleanUp,
      });
      parent = readPointer(parent, WINDOW_DESTROY_OFFSETS.parent, services, 'cleanUp');
    }
  }

  if (root !== null) {
    for (const offset of [WINDOW_DESTROY_OFFSETS.rootFocus, WINDOW_DESTROY_OFFSETS.rootGrab]) {
      if (readPointer(root, offset, services, 'cleanUp') === window) {
        writePointer(root, offset, null, services, 'cleanUp');
      }
    }
  }

  for (const offset of [WINDOW_DESTROY_OFFSETS.gcListA, WINDOW_DESTROY_OFFSETS.gcListB]) {
    let node = readPointer(window, offset, services, 'cleanUp');
    while (node !== null) {
      const next = readPointer(node, WINDOW_DESTROY_OFFSETS.gcNodeNext, services, 'cleanUp');
      event(services, 'FreeGc', {object: node, owner: window, slot: offset});
      call(services.freeGc, 'freeGc', {
        object: node, owner: window, slot: offset, next,
        native: WINDOW_DESTROY_NATIVE_ADDRESSES.gMallocIat,
      });
      writePointer(window, offset, next, services, 'cleanUp');
      node = next;
    }
  }

  for (const offset of [WINDOW_DESTROY_OFFSETS.gcContextA, WINDOW_DESTROY_OFFSETS.gcContextB]) {
    const context = readPointer(window, offset, services, 'cleanUp');
    if (context !== null) {
      event(services, 'DestroyGc', {object: context, owner: window, slot: offset, flags: 1});
      call(services.destroyGc, 'destroyGc', {
        object: context, owner: window, slot: offset, flags: 1,
        native: WINDOW_DESTROY_NATIVE_ADDRESSES.deletingDestructorSlot,
      });
      writePointer(window, offset, null, services, 'cleanUp');
    }
  }

  parent = readPointer(window, WINDOW_DESTROY_OFFSETS.parent, services, 'cleanUp');
  if (parent !== null) {
    event(services, 'RemoveChild', {
      parent, child: window, native: WINDOW_DESTROY_NATIVE_ADDRESSES.removeChild,
    });
    if (typeof services.removeChild === 'function') {
      call(services.removeChild, 'RemoveChild', {
        parent, child: window, native: WINDOW_DESTROY_NATIVE_ADDRESSES.removeChild,
      });
    } else {
      unlinkChild(parent, window, services);
    }
  }
}

/** XWindow::KillAllChildren.  The sibling is read before SafeDestroy. */
export function killAllChildrenNative(object, services = {}) {
  const window = canonical(object, 'Window');
  event(services, 'KillAllChildren', {
    object: window, native: WINDOW_DESTROY_NATIVE_ADDRESSES.killAllChildren,
  });
  let child = readPointer(window, WINDOW_DESTROY_OFFSETS.firstChild, services, 'killAllChildren');
  while (child !== null) {
    const next = readPointer(child, WINDOW_DESTROY_OFFSETS.nextSibling, services, 'killAllChildren');
    safeDestroyWindowNative(child, services);
    child = next;
  }
}

function invokeCleanUp(window, services) {
  event(services, 'CleanUp', {
    object: window, native: WINDOW_DESTROY_NATIVE_ADDRESSES.cleanUp,
    virtualSlot: WINDOW_DESTROY_NATIVE_ADDRESSES.cleanUpSlot,
  });
  if (typeof services.cleanUp === 'function') {
    return call(services.cleanUp, 'CleanUp', {
      object: window,
      native: WINDOW_DESTROY_NATIVE_ADDRESSES.cleanUp,
      virtualSlot: WINDOW_DESTROY_NATIVE_ADDRESSES.cleanUpSlot,
      baseCleanUp: () => cleanUpWindowBody(window, services),
    });
  }
  return cleanUpWindowBody(window, services);
}

/** XWindow::PreDestroy in its original visibility, child and cleanup order. */
export function preDestroyWindowNative(object, services = {}) {
  const window = canonical(object, 'Window');
  event(services, 'PreDestroy', {
    object: window, native: WINDOW_DESTROY_NATIVE_ADDRESSES.preDestroy,
  });
  const initialFlags = readRaw(window, WINDOW_DESTROY_OFFSETS.windowFlags, 'u32', services, 'preDestroy');
  if ((initialFlags & WINDOW_DESTROY_BITS.bBeingDestroyed) !== 0) return;

  let current = window;
  const seen = new Set();
  for (;;) {
    if (seen.has(current)) {
      fail('Window.Destroy received a cyclic visible native window chain', {
        kind: 'REFERENCE', object: current, operation: 'PreDestroy',
      });
    }
    seen.add(current);
    const flags = readRaw(current, WINDOW_DESTROY_OFFSETS.windowFlags, 'u8', services, 'preDestroy');
    if ((flags & WINDOW_DESTROY_BITS.visibleChain) === 0) break;
    current = readPointer(current, WINDOW_DESTROY_OFFSETS.parent, services, 'preDestroy');
    if (current === null) {
      event(services, 'SetVisibility', {
        object: window, visible: false, native: WINDOW_DESTROY_NATIVE_ADDRESSES.setVisibility,
      });
      call(services.setVisibility, 'SetVisibility', {
        object: window, visible: false, native: WINDOW_DESTROY_NATIVE_ADDRESSES.setVisibility,
      });
      break;
    }
  }

  event(services, 'SetSelectability', {
    object: window, selectable: false, native: WINDOW_DESTROY_NATIVE_ADDRESSES.setSelectability,
  });
  call(services.setSelectability, 'SetSelectability', {
    object: window, selectable: false, native: WINDOW_DESTROY_NATIVE_ADDRESSES.setSelectability,
  });
  killAllChildrenNative(window, services);
  event(services, 'ProcessScript', {
    object: window, event: 'DestroyWindow',
    eventNameAddress: WINDOW_DESTROY_NATIVE_ADDRESSES.extensionDestroyWindow,
    parameters: null, thirdArgument: 1, native: WINDOW_DESTROY_NATIVE_ADDRESSES.processScript,
  });
  call(services.processScript, 'ProcessScript', {
    object: window, event: 'DestroyWindow',
    eventNameAddress: WINDOW_DESTROY_NATIVE_ADDRESSES.extensionDestroyWindow,
    parameters: null, thirdArgument: 1, native: WINDOW_DESTROY_NATIVE_ADDRESSES.processScript,
  });
  invokeCleanUp(window, services);

  const finalFlags = readRaw(window, WINDOW_DESTROY_OFFSETS.windowFlags, 'u32', services, 'preDestroy');
  writeRaw(window, WINDOW_DESTROY_OFFSETS.windowFlags, 'u32',
    finalFlags | WINDOW_DESTROY_BITS.bBeingDestroyed, services, 'preDestroy');
}

function runXWindowDestructor(object, services) {
  const setVtable = required(services.setVtable, 'setVtable');
  const conditionalDestroy = required(services.conditionalDestroy, 'conditionalDestroy');
  const uobjectDestructor = required(services.uobjectDestructor, 'uobjectDestructor');
  const invalidateObject = required(services.invalidateObject, 'invalidateObject');

  call(setVtable, 'setVtable', {
    object, vtable: WINDOW_DESTROY_NATIVE_ADDRESSES.xwindowVtable,
    native: WINDOW_DESTROY_NATIVE_ADDRESSES.xwindowDestructor,
  });
  call(conditionalDestroy, 'conditionalDestroy', {
    object, vtable: WINDOW_DESTROY_NATIVE_ADDRESSES.xwindowVtable,
    native: WINDOW_DESTROY_NATIVE_ADDRESSES.xwindowDestructor,
  });
  call(setVtable, 'setVtable', {
    object, vtable: WINDOW_DESTROY_NATIVE_ADDRESSES.extensionObjectVtable,
    native: WINDOW_DESTROY_NATIVE_ADDRESSES.xwindowDestructor,
  });
  call(conditionalDestroy, 'conditionalDestroy', {
    object, vtable: WINDOW_DESTROY_NATIVE_ADDRESSES.extensionObjectVtable,
    native: WINDOW_DESTROY_NATIVE_ADDRESSES.xwindowDestructor,
  });
  call(uobjectDestructor, 'uobjectDestructor', {
    object, native: WINDOW_DESTROY_NATIVE_ADDRESSES.xwindowDestructor,
  });
  call(invalidateObject, 'invalidateObject', {
    object, native: WINDOW_DESTROY_NATIVE_ADDRESSES.xwindowDestructor,
  });
}

/**
 * Execute the scalar deleting-destructor leaf after SafeDestroy/CleanUp.
 * `deleteWindow` may own a complete class-specific native destructor.  If it
 * is absent, `subclassDestructor` must call the supplied `baseDestructor` and
 * the adapter then performs the scalar allocator free.
 */
export function releaseWindowNative(object, services = {}) {
  const window = canonical(object, 'Window');
  event(services, 'DeletingDestructor', {
    object: window, flags: 1, native: WINDOW_DESTROY_NATIVE_ADDRESSES.deletingDestructor,
  });
  if (typeof services.deleteWindow === 'function') {
    return call(services.deleteWindow, 'deleteWindow', {
      object: window, flags: 1,
      native: WINDOW_DESTROY_NATIVE_ADDRESSES.deletingDestructor,
      size: 0x14c,
    });
  }

  const subclassDestructor = required(services.subclassDestructor, 'subclassDestructor');
  call(subclassDestructor, 'subclassDestructor', {
    object: window,
    flags: 1,
    native: WINDOW_DESTROY_NATIVE_ADDRESSES.deletingDestructor,
    baseDestructor: () => runXWindowDestructor(window, services),
  });
  const freeObject = required(services.freeObject, 'freeObject');
  call(freeObject, 'freeObject', {
    object: window, size: 0x14c, flags: 1,
    native: WINDOW_DESTROY_NATIVE_ADDRESSES.deletingDestructor,
  });
}

/** XWindow::SafeDestroy. */
export function safeDestroyWindowNative(object, services = {}) {
  const window = canonical(object, 'Window');
  event(services, 'SafeDestroy', {
    object: window, native: WINDOW_DESTROY_NATIVE_ADDRESSES.safeDestroy,
  });
  preDestroyWindowNative(window, services);
  const lockCount = readRaw(window, WINDOW_DESTROY_OFFSETS.lockCount, 'i32', services, 'safeDestroy');
  if (lockCount > 0) return false;
  releaseWindowNative(window, services);
  return true;
}

/** Execute native1409, including the FFrame +0x0c increment. */
export function execDestroyWindowNative({object, frame} = {}, services = {}) {
  const window = canonical(object, 'Window');
  const stack = canonical(frame, 'FFrame');
  event(services, 'ExecDestroy', {
    object: window, frame: stack, native: WINDOW_DESTROY_NATIVE_ADDRESSES.execDestroy,
  });
  const guard = readRaw(stack, WINDOW_DESTROY_OFFSETS.frameGuard, 'u32', services, 'execDestroy');
  writeRaw(stack, WINDOW_DESTROY_OFFSETS.frameGuard, 'u32', (guard + 1) >>> 0,
    services, 'execDestroy');
  return safeDestroyWindowNative(window, services);
}

/** Convenience name for callers that do not have the VM's FFrame. */
export const destroyWindowNative = safeDestroyWindowNative;
