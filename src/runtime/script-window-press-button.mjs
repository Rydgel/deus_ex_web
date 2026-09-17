/**
 * Recovered Extension.dll XButtonWindow::PressButton translation.
 *
 * The registered exec body is the whole native: it evaluates one byte
 * argument (script default 0x20), masks it to a byte, and dispatches the
 * receiver's +0x124 virtual (buttonPressed(key)).  No field reads, no
 * ancestor walk, no result store.
 *
 * Evidence: Extension.dll SHA-256
 * 93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c,
 * exec body 0x10008c90 through 0x10008cdb.
 */

const freeze = value => Object.freeze(value);

export const WINDOW_PRESS_BUTTON_NATIVE = freeze({
  package: 'Extension',
  function: 'ButtonWindow.PressButton / XButtonWindow::PressButton',
  packageExport: 1057,
  nativeIndex: 1598,
  functionFlags: 0x401,
  serialSize: 31,
  dll: 'Extension.dll',
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  imageBase: 0x10000000,
  execBody: 0x10008c90,
  execEnd: 0x10008cdb,
  execSha256: '47570d2613340f51610a24568a899c0692e20a4faf1fc8572cc0eebef215e194',
});

export const WINDOW_PRESS_BUTTON_NATIVE_ADDRESSES = freeze({
  body: WINDOW_PRESS_BUTTON_NATIVE.execBody,
  end: WINDOW_PRESS_BUTTON_NATIVE.execEnd,
  buttonPressedSlot: 0x124,
});

/** Numeric byte offsets in the native XButtonWindow object. */
export const WINDOW_PRESS_BUTTON_OFFSETS = freeze({
  vtable: 0x00,
});

export const WINDOW_PRESS_BUTTON_FIELDS = WINDOW_PRESS_BUTTON_OFFSETS;

export const WINDOW_PRESS_BUTTON_NATIVE_CONTRACT = freeze({
  name: 'XButtonWindow::PressButton',
  address: WINDOW_PRESS_BUTTON_NATIVE.execBody,
  arguments: freeze(['Key:byte']),
  returns: 'void',
  rawStorage: 'read(object, offset, kind, details)',
  fields: freeze({...WINDOW_PRESS_BUTTON_OFFSETS}),
  callbacks: freeze([
    'buttonPressed(receiver, key & 0xff) through vtable +0x124',
  ]),
});

export class WindowPressButtonNativeBoundaryError extends Error {
  constructor(message, {
    kind = 'BOUNDARY', value = undefined, object = undefined,
    offset = null, operation = null,
  } = {}) {
    super(message);
    this.name = 'WindowPressButtonNativeBoundaryError';
    this.code = `WINDOW_PRESS_BUTTON_${kind}`;
    this.value = value;
    this.object = object;
    this.offset = offset;
    this.operation = operation;
  }
}

const fail = (message, details = {}) => {
  throw new WindowPressButtonNativeBoundaryError(message, details);
};

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`XButtonWindow::PressButton ${label} suspended; native path is synchronous`, {
      kind: 'ASYNC', value, operation: label,
    });
  }
  return value;
}

function objectReference(value, name) {
  if (value === null || value === undefined ||
      (typeof value !== 'object' && typeof value !== 'function')) {
    fail(`XButtonWindow::PressButton requires canonical ${name}`, {
      kind: 'REFERENCE', value, operation: name,
    });
  }
  return value;
}

/**
 * Execute the original exec body: read the receiver's vtable (+0x00) and
 * dispatch its +0x124 virtual with `key & 0xff`.
 */
export function pressButtonNative(object, key, services = {}) {
  objectReference(object, 'window');
  if (!Number.isInteger(key)) {
    fail('XButtonWindow::PressButton requires a byte key argument', {
      kind: 'VALUE', value: key, operation: 'button-pressed',
    });
  }
  const O = WINDOW_PRESS_BUTTON_OFFSETS;
  const A = WINDOW_PRESS_BUTTON_NATIVE_ADDRESSES;
  const reader = services.read;
  if (typeof reader !== 'function') {
    fail('XButtonWindow::PressButton requires read service', {
      kind: 'SERVICE', offset: O.vtable, operation: 'button-pressed',
    });
  }
  sync(reader(object, O.vtable, 'ptr', {
    native: A.body, phase: 'button-pressed',
    object, offset: O.vtable, kind: 'ptr', width: 4,
  }), 'read +0x00');
  const dispatch = services.buttonPressed;
  if (typeof dispatch !== 'function') {
    fail('XButtonWindow::PressButton requires buttonPressed service', {
      kind: 'SERVICE', offset: A.buttonPressedSlot, operation: 'button-pressed',
    });
  }
  sync(dispatch({
    native: A.body,
    phase: 'button-pressed',
    object,
    key: key & 0xff,
    virtualSlot: A.buttonPressedSlot,
  }), 'ButtonPressed');
}

export const windowPressButtonNative = pressButtonNative;
export const buttonWindowPressButtonNative = pressButtonNative;
