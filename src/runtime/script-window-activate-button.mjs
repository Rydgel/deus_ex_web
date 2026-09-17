/**
 * Recovered Extension.dll XButtonWindow::ActivateButton translation.
 *
 * The registered exec body evaluates one byte argument (script default 0) and
 * tail-calls the method at 0x100077e0, which walks the +0x138 ancestor chain
 * starting at the receiver and dispatches an activation virtual on each
 * window until one returns nonzero or the chain ends:
 *   Key == 2  -> vtable slot +0xec (second activation entry)
 *   otherwise -> vtable slot +0xe8
 * Both slots receive the receiver (not the ancestor) as their source
 * argument.  The remaining code in the body is the SEH frame's exception
 * path (the appMsgf import) and is unreachable in normal flow.
 *
 * Evidence: Extension.dll SHA-256
 * 93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c,
 * exec body 0x100085b0 through 0x100085f9,
 * method body 0x100077e0 through 0x10007881.
 */

const freeze = value => Object.freeze(value);

export const WINDOW_ACTIVATE_BUTTON_NATIVE = freeze({
  package: 'Extension',
  function: 'ButtonWindow.ActivateButton / XButtonWindow::ActivateButton',
  packageExport: 1067,
  nativeIndex: 1590,
  functionFlags: 0x401,
  serialSize: 31,
  dll: 'Extension.dll',
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  imageBase: 0x10000000,
  execBody: 0x100085b0,
  execEnd: 0x100085f9,
  execSha256: '2d59c03602b49cf10078172f631f651be1f22137a030135a2a7693db65444c00',
  methodBody: 0x100077e0,
  methodEnd: 0x10007881,
  methodSha256: 'c36d1ec8820131ab0a9e51d4f272d70641f673d0d9dd9732985d5697be973be1',
});

export const WINDOW_ACTIVATE_BUTTON_NATIVE_ADDRESSES = freeze({
  body: WINDOW_ACTIVATE_BUTTON_NATIVE.methodBody,
  end: WINDOW_ACTIVATE_BUTTON_NATIVE.methodEnd,
  activateSlot: 0xe8,
  activateKey2Slot: 0xec,
});

/** Numeric byte offsets in the native XButtonWindow object. */
export const WINDOW_ACTIVATE_BUTTON_OFFSETS = freeze({
  parent: 0x138,
  vtable: 0x00,
});

export const WINDOW_ACTIVATE_BUTTON_FIELDS = WINDOW_ACTIVATE_BUTTON_OFFSETS;

/** The key value that selects the +0xec activation slot. */
export const WINDOW_ACTIVATE_BUTTON_KEYS = freeze({ key2: 2 });

export const WINDOW_ACTIVATE_BUTTON_NATIVE_CONTRACT = freeze({
  name: 'XButtonWindow::ActivateButton',
  address: WINDOW_ACTIVATE_BUTTON_NATIVE.methodBody,
  arguments: freeze(['Key:byte']),
  returns: 'void',
  rawStorage: 'read(object, offset, kind, details)',
  fields: freeze({...WINDOW_ACTIVATE_BUTTON_OFFSETS}),
  callbacks: freeze([
    'activateButton(ancestor, source) through vtable +0xe8 (Key != 2)',
    'activateKey2(ancestor, source) through vtable +0xec (Key == 2)',
  ]),
});

export class WindowActivateButtonNativeBoundaryError extends Error {
  constructor(message, {
    kind = 'BOUNDARY', value = undefined, object = undefined,
    offset = null, operation = null,
  } = {}) {
    super(message);
    this.name = 'WindowActivateButtonNativeBoundaryError';
    this.code = `WINDOW_ACTIVATE_BUTTON_${kind}`;
    this.value = value;
    this.object = object;
    this.offset = offset;
    this.operation = operation;
  }
}

const fail = (message, details = {}) => {
  throw new WindowActivateButtonNativeBoundaryError(message, details);
};

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`XButtonWindow::ActivateButton ${label} suspended; native path is synchronous`, {
      kind: 'ASYNC', value, operation: label,
    });
  }
  return value;
}

function objectReference(value, name) {
  if (value === null || value === undefined ||
      (typeof value !== 'object' && typeof value !== 'function')) {
    fail(`XButtonWindow::ActivateButton requires canonical ${name}`, {
      kind: 'REFERENCE', value, operation: name,
    });
  }
  return value;
}

const present = value => value !== null && value !== undefined && value !== 0;

function readRaw(object, offset, kind, services, phase) {
  const reader = services.read;
  if (typeof reader !== 'function') {
    fail('XButtonWindow::ActivateButton requires read service', {
      kind: 'SERVICE', offset, operation: phase,
    });
  }
  return sync(reader(object, offset, kind, {
    native: WINDOW_ACTIVATE_BUTTON_NATIVE.methodBody,
    phase, object, offset, kind,
    width: kind === 'u8' ? 1 : 4,
  }), `read +0x${offset.toString(16)}`);
}

function leafHandled(value, label) {
  if (value === false || value === null || value === 0) return false;
  if (value === true) return true;
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    fail(`XButtonWindow::ActivateButton ${label} returned an unresolved native result`, {
      kind: 'BOUNDARY', value, operation: label,
    });
  }
  return value !== 0;
}

/**
 * Execute the original method body: the activation notify walk over the
 * +0x138 ancestor chain, dispatching +0xec when `key == 2` and +0xe8
 * otherwise, until a callback returns nonzero or the chain ends.
 */
export function activateButtonNative(object, key, services = {}) {
  objectReference(object, 'window');
  if (!Number.isInteger(key)) {
    fail('XButtonWindow::ActivateButton requires a byte key argument', {
      kind: 'VALUE', value: key, operation: 'activate-walk',
    });
  }
  const O = WINDOW_ACTIVATE_BUTTON_OFFSETS;
  const A = WINDOW_ACTIVATE_BUTTON_NATIVE_ADDRESSES;
  const slot = key === WINDOW_ACTIVATE_BUTTON_KEYS.key2
    ? A.activateKey2Slot : A.activateSlot;
  const seen = new Set();
  let current = object;
  while (present(current)) {
    if (seen.has(current)) {
      fail('XButtonWindow::ActivateButton received a cyclic native notify chain', {
        kind: 'REFERENCE', value: current, object, operation: 'activate-walk',
      });
    }
    seen.add(current);
    readRaw(current, O.vtable, 'ptr', services, 'activate-walk');
    const dispatch = services.activateButton;
    if (typeof dispatch !== 'function') {
      fail('XButtonWindow::ActivateButton requires activateButton service', {
        kind: 'SERVICE', offset: slot, operation: 'activate-walk',
      });
    }
    const handled = leafHandled(sync(dispatch({
      native: A.body,
      phase: 'activate-walk',
      object: current,
      source: object,
      virtualSlot: slot,
    }), 'ActivateButton'), 'ActivateButton');
    if (handled) break;
    current = readRaw(current, O.parent, 'ptr', services, 'activate-walk');
  }
}

export const windowActivateButtonNative = activateButtonNative;
export const buttonWindowActivateButtonNative = activateButtonNative;
