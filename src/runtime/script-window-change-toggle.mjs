/**
 * Recovered Extension.dll XToggleWindow::ChangeToggle translation.
 *
 * The registered exec body only advances the script frame past the call token
 * (no arguments are evaluated) and tail-calls the method at 0x10049910, which
 * walks the +0x138 ancestor chain starting at the receiver and dispatches the
 * +0xf0 virtual (toggleChanged(source, toggle)) on each window until one
 * returns nonzero or the chain ends.  The receiver's +0x174 toggle bit is
 * re-read before every dispatch.  The method itself does NOT modify +0x174 —
 * the name notwithstanding, no bit is flipped anywhere in this body.
 *
 * Evidence: Extension.dll SHA-256
 * 93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c,
 * exec body 0x10049ce0 through 0x10049cef,
 * method body 0x10049910 through 0x100499a2.
 */

const freeze = value => Object.freeze(value);

export const WINDOW_CHANGE_TOGGLE_NATIVE = freeze({
  package: 'Extension',
  function: 'ToggleWindow.ChangeToggle / XToggleWindow::ChangeToggle',
  packageExport: 1044,
  nativeIndex: 1610,
  functionFlags: 0x401,
  serialSize: 27,
  dll: 'Extension.dll',
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  imageBase: 0x10000000,
  execBody: 0x10049ce0,
  execEnd: 0x10049cef,
  execSha256: '613e7bcfb61d196b63e4e0c95d76054d0e3a2d247af97e8ce11c77b501e383e4',
  methodBody: 0x10049910,
  methodEnd: 0x100499a2,
  methodSha256: '3bb70497f390b4c97716487c80867ff5763fe6cce27186f6102fd48d79525e4b',
});

export const WINDOW_CHANGE_TOGGLE_NATIVE_ADDRESSES = freeze({
  body: WINDOW_CHANGE_TOGGLE_NATIVE.methodBody,
  end: WINDOW_CHANGE_TOGGLE_NATIVE.methodEnd,
  notifySlot: 0xf0,
});

/** Numeric byte offsets in the native XToggleWindow object. */
export const WINDOW_CHANGE_TOGGLE_OFFSETS = freeze({
  toggleFlags: 0x174,
  parent: 0x138,
  vtable: 0x00,
});

export const WINDOW_CHANGE_TOGGLE_FIELDS = WINDOW_CHANGE_TOGGLE_OFFSETS;

export const WINDOW_CHANGE_TOGGLE_BITS = freeze({ toggled: 0x01 });

export const WINDOW_CHANGE_TOGGLE_NATIVE_CONTRACT = freeze({
  name: 'XToggleWindow::ChangeToggle',
  address: WINDOW_CHANGE_TOGGLE_NATIVE.methodBody,
  arguments: freeze([]),
  returns: 'void',
  rawStorage: 'read(object, offset, kind, details)',
  fields: freeze({...WINDOW_CHANGE_TOGGLE_OFFSETS}),
  callbacks: freeze([
    'toggleChanged(ancestor, source, toggle) through vtable +0xf0',
  ]),
});

export class WindowChangeToggleNativeBoundaryError extends Error {
  constructor(message, {
    kind = 'BOUNDARY', value = undefined, object = undefined,
    offset = null, operation = null,
  } = {}) {
    super(message);
    this.name = 'WindowChangeToggleNativeBoundaryError';
    this.code = `WINDOW_CHANGE_TOGGLE_${kind}`;
    this.value = value;
    this.object = object;
    this.offset = offset;
    this.operation = operation;
  }
}

const fail = (message, details = {}) => {
  throw new WindowChangeToggleNativeBoundaryError(message, details);
};

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`XToggleWindow::ChangeToggle ${label} suspended; native path is synchronous`, {
      kind: 'ASYNC', value, operation: label,
    });
  }
  return value;
}

function objectReference(value, name) {
  if (value === null || value === undefined ||
      (typeof value !== 'object' && typeof value !== 'function')) {
    fail(`XToggleWindow::ChangeToggle requires canonical ${name}`, {
      kind: 'REFERENCE', value, operation: name,
    });
  }
  return value;
}

const present = value => value !== null && value !== undefined && value !== 0;

function readRaw(object, offset, kind, services, phase) {
  const reader = services.read;
  if (typeof reader !== 'function') {
    fail('XToggleWindow::ChangeToggle requires read service', {
      kind: 'SERVICE', offset, operation: phase,
    });
  }
  return sync(reader(object, offset, kind, {
    native: WINDOW_CHANGE_TOGGLE_NATIVE.methodBody,
    phase, object, offset, kind,
    width: kind === 'u8' ? 1 : 4,
  }), `read +0x${offset.toString(16)}`);
}

function leafHandled(value, label) {
  if (value === false || value === null || value === 0) return false;
  if (value === true) return true;
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    fail(`XToggleWindow::ChangeToggle ${label} returned an unresolved native result`, {
      kind: 'BOUNDARY', value, operation: label,
    });
  }
  return value !== 0;
}

/**
 * Execute the original method body: the +0xf0 notify walk over the +0x138
 * ancestor chain, starting at the receiver, until a callback returns nonzero
 * or the chain ends.
 */
export function changeToggleNative(object, services = {}) {
  objectReference(object, 'window');
  const O = WINDOW_CHANGE_TOGGLE_OFFSETS;
  const A = WINDOW_CHANGE_TOGGLE_NATIVE_ADDRESSES;
  const seen = new Set();
  let current = object;
  while (present(current)) {
    if (seen.has(current)) {
      fail('XToggleWindow::ChangeToggle received a cyclic native notify chain', {
        kind: 'REFERENCE', value: current, object, operation: 'notify-toggle',
      });
    }
    seen.add(current);
    const toggleFlags = readRaw(object, O.toggleFlags, 'u32', services,
      'notify-toggle');
    if (!Number.isInteger(toggleFlags) ||
        toggleFlags < 0 || toggleFlags > 0xffffffff) {
      fail('XToggleWindow::ChangeToggle requires uint32 +0x174 field', {
        kind: 'VALUE', value: toggleFlags, object,
        offset: O.toggleFlags, operation: 'notify-toggle',
      });
    }
    readRaw(current, O.vtable, 'ptr', services, 'notify-toggle');
    const dispatch = services.toggleChanged;
    if (typeof dispatch !== 'function') {
      fail('XToggleWindow::ChangeToggle requires toggleChanged service', {
        kind: 'SERVICE', offset: A.notifySlot, operation: 'notify-toggle',
      });
    }
    const handled = leafHandled(sync(dispatch({
      native: A.body,
      phase: 'notify-toggle',
      object: current,
      source: object,
      toggle: toggleFlags & WINDOW_CHANGE_TOGGLE_BITS.toggled,
      virtualSlot: A.notifySlot,
    }), 'ToggleChanged'), 'ToggleChanged');
    if (handled) break;
    current = readRaw(current, O.parent, 'ptr', services, 'notify-toggle');
  }
}

export const windowChangeToggleNative = changeToggleNative;
export const toggleWindowChangeToggleNative = changeToggleNative;
