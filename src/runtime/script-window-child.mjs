/**
 * Recovered Extension.Window.NewChild -> XWindow::CreateNewWindow boundary.
 *
 * This module stops at the original construction and lifecycle leaves.  The
 * host supplies the canonical UObject/class table, XWindow virtual Init,
 * InitWindow event dispatch, visibility and reconfiguration services.  It
 * never fabricates a Window object or substitutes a complete XWindow::Init.
 *
 * Evidence: installed v68 Extension.u (Window.NewChild export 2126, native
 * 1410), Extension.dll (image base 0x10000000, CreateNewWindow 0x1004df70),
 * and docs/script-window-child.md.
 */

const freeze = value => Object.freeze(value);

export const WINDOW_CHILD_NATIVE = freeze({
  package: 'Extension',
  function: 'Window.NewChild',
  packageExport: 2126,
  nativeIndex: 1410,
  dll: 'Extension.dll',
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  imageBase: 0x10000000,
  execThunk: 0x10051860,
  createNewWindow: 0x1004df70,
});

export const WINDOW_CHILD_NATIVE_ADDRESSES = freeze({
  createNewWindow: 0x1004df70,
  staticConstructObjectIat: 0x10059150,
  fNameNoneIat: 0x10059124,
  gErrorIat: 0x10059070,
  initVtableSlot: 0x54,
  initWindowEvent: 0x1004ded0,
  extensionInitWindowName: 0x1009b3a4,
  lockWindow: 0x1004c140,
  unlockWindow: 0x1004c150,
  safeDestroy: 0x1004c0b0,
  setVisibility: 0x1004c7d0,
  askParentForReconfigure: 0x1004e060,
});

export const WINDOW_CHILD_FIELDS = freeze({
  stateBits: 'windowFlags',
  lockCount: 'lockCount',
});

/** XWindow +0x30 bBeingDestroyed bit, read after reconfigure and by Unlock. */
export const WINDOW_BEING_DESTROYED = 0x10;

export const WINDOW_CHILD_NATIVE_CONTRACT = freeze({
  name: 'XWindow::CreateNewWindow',
  address: WINDOW_CHILD_NATIVE_ADDRESSES.createNewWindow,
  arguments: freeze(['UClass* NewClass', 'XWindow* Parent', 'int bShow']),
  returns: 'XWindow* or NULL',
  staticConstruction: freeze({
    classArgument: 'NewClass',
    outerArgument: 'Parent',
    name: 'NAME_None',
    flags: 0,
    template: null,
    error: '*GError',
  }),
  lifecycle: freeze([
    'child->Init(Parent) through vtable +0x54',
    'child->LockWindow()',
    'child->ProcessScript(EXTENSION_InitWindow, NULL, 1)',
    'if (bShow) child->SetVisibility(1)',
    'child->AskParentForReconfigure()',
    'read child +0x30 bit 0x10',
    'child->UnlockWindow()',
  ]),
});

export class WindowChildNativeBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', value = undefined, field = null} = {}) {
    super(message);
    this.name = 'WindowChildNativeBoundaryError';
    this.code = `WINDOW_CHILD_${kind}`;
    this.value = value;
    this.field = field;
  }
}

const fail = (message, details) => { throw new WindowChildNativeBoundaryError(message, details); };

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`Window.NewChild ${label} service suspended; native path is synchronous`, {
      kind: 'ASYNC', value,
    });
  }
  return value;
}

function requireFunction(value, name) {
  if (typeof value !== 'function') fail(`Window.NewChild requires ${name} service`, {kind: 'SERVICE'});
  return value;
}

function requireObject(value, name, {allowNull = false} = {}) {
  if (allowNull && value === null) return value;
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    fail(`Window.NewChild requires canonical ${name}`, {kind: 'REFERENCE', value});
  }
  return value;
}

function requireBool(value, name) {
  if (typeof value !== 'boolean') fail(`Window.NewChild requires boolean ${name}`, {kind: 'VALUE', value});
  return value;
}

function requireInt32(value, name) {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    fail(`Window.NewChild requires int32 ${name}`, {kind: 'VALUE', value});
  }
  return value;
}

function readField(object, field, services, phase) {
  const read = requireFunction(services.read, 'read');
  const value = sync(read(object, field, {native: WINDOW_CHILD_NATIVE.nativeIndex, phase, field}),
    `read ${field}`);
  if (value === undefined) fail(`Window.NewChild reached unresolved ${field} field`, {
    kind: 'FIELD', value, field,
  });
  return value;
}

function writeField(object, field, value, services, phase) {
  const write = requireFunction(services.write, 'write');
  return sync(write(object, field, value, {
    native: WINDOW_CHILD_NATIVE.nativeIndex, phase, field, value,
  }), `write ${field}`);
}

function call(service, name, details) {
  return sync(requireFunction(service, name)(details), name);
}

function lockWindow(child, services) {
  const count = requireInt32(readField(child, WINDOW_CHILD_FIELDS.lockCount, services, 'LockWindow'),
    WINDOW_CHILD_FIELDS.lockCount);
  writeField(child, WINDOW_CHILD_FIELDS.lockCount, (count + 1) | 0, services, 'LockWindow');
}

function unlockWindow(child, services) {
  const count = requireInt32(readField(child, WINDOW_CHILD_FIELDS.lockCount, services, 'UnlockWindow'),
    WINDOW_CHILD_FIELDS.lockCount);
  if (count <= 0) return;
  writeField(child, WINDOW_CHILD_FIELDS.lockCount, count - 1, services, 'UnlockWindow');
  const flags = readField(child, WINDOW_CHILD_FIELDS.stateBits, services, 'UnlockWindow');
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xffffffff) {
    fail(`Window.NewChild requires uint32 ${WINDOW_CHILD_FIELDS.stateBits}`, {
      kind: 'VALUE', value: flags, field: WINDOW_CHILD_FIELDS.stateBits,
    });
  }
  if ((flags & WINDOW_BEING_DESTROYED) !== 0) {
    call(services.safeDestroy, 'safeDestroy', {
      object: child,
      native: WINDOW_CHILD_NATIVE_ADDRESSES.safeDestroy,
    });
  }
}

/**
 * Execute the recovered XWindow::CreateNewWindow body.
 *
 * `args` is `{newClass, parent, bShow?, errorDevice?}`.  Each callback is a
 * synchronous native boundary.  `read`/`write` expose only the two fields
 * touched by the recovered LockWindow/UnlockWindow bodies; construction and
 * all class-specific initialization stay with the supplied services.
 */
export function createNewWindowNative({newClass, parent = null, bShow = true, errorDevice} = {}, services = {}) {
  if (newClass === null) return null; // 1004df96–1004df9b: null class guard.
  requireObject(newClass, 'NewClass');
  requireObject(parent, 'Parent', {allowNull: true});
  requireBool(bShow, 'bShow');
  if (errorDevice === undefined) fail('Window.NewChild requires explicit GError device', {kind: 'SERVICE'});

  const child = sync(requireFunction(services.staticConstructObject, 'StaticConstructObject')({
    classObject: newClass,
    outer: parent,
    name: 'None',
    flags: 0,
    template: null,
    error: errorDevice,
    native: WINDOW_CHILD_NATIVE_ADDRESSES.staticConstructObjectIat,
  }), 'StaticConstructObject');
  if (child === null) return null; // native allocation failure returns NULL.
  requireObject(child, 'constructed child');

  call(services.initVtable, 'Init-vtable', {
    object: child,
    parent,
    virtualSlot: WINDOW_CHILD_NATIVE_ADDRESSES.initVtableSlot,
    native: WINDOW_CHILD_NATIVE_ADDRESSES.createNewWindow,
  });
  lockWindow(child, services);
  call(services.processScript, 'ProcessScript', {
    object: child,
    event: 'InitWindow',
    eventNameAddress: WINDOW_CHILD_NATIVE_ADDRESSES.extensionInitWindowName,
    parameters: null,
    thirdArgument: 1,
    native: WINDOW_CHILD_NATIVE_ADDRESSES.initWindowEvent,
  });
  if (bShow) {
    call(services.setVisibility, 'SetVisibility', {
      object: child,
      visible: true,
      native: WINDOW_CHILD_NATIVE_ADDRESSES.setVisibility,
    });
  }
  call(services.askParentForReconfigure, 'AskParentForReconfigure', {
    object: child,
    native: WINDOW_CHILD_NATIVE_ADDRESSES.askParentForReconfigure,
  });

  // CreateNewWindow samples bBeingDestroyed before it calls UnlockWindow.
  const flags = readField(child, WINDOW_CHILD_FIELDS.stateBits, services, 'CreateNewWindow');
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xffffffff) {
    fail(`Window.NewChild requires uint32 ${WINDOW_CHILD_FIELDS.stateBits}`, {
      kind: 'VALUE', value: flags, field: WINDOW_CHILD_FIELDS.stateBits,
    });
  }
  const beingDestroyed = (flags & WINDOW_BEING_DESTROYED) !== 0;
  unlockWindow(child, services);
  return beingDestroyed ? null : child;
}

export const createWindowChildNative = createNewWindowNative;
