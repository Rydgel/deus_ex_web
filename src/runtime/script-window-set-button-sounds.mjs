/**
 * Recovered Extension.dll XButtonWindow::SetButtonSounds translation.
 *
 * The registered exec body evaluates two object arguments and tail-calls the
 * method at 0x10007b00, which stores the press-sound pointer into +0x190 and
 * the click-sound pointer into +0x194.  Pure pointer stores — no audio is
 * played, no reconfigure call.
 *
 * Evidence: Extension.dll SHA-256
 * 93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c,
 * exec body 0x10008c00 through 0x10008c6f,
 * method body 0x10007b00 through 0x10007b17.
 */

const freeze = value => Object.freeze(value);

export const WINDOW_SET_BUTTON_SOUNDS_NATIVE = freeze({
  package: 'Extension',
  function: 'ButtonWindow.SetButtonSounds / XButtonWindow::SetButtonSounds',
  packageExport: 1048,
  nativeIndex: 1597,
  functionFlags: 0x401,
  serialSize: 34,
  dll: 'Extension.dll',
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  imageBase: 0x10000000,
  execBody: 0x10008c00,
  execEnd: 0x10008c6f,
  execSha256: '8eb68e278b324467d6a8ee30f2134dad3ce739a44b76bd7bde956e7c431c870d',
  methodBody: 0x10007b00,
  methodEnd: 0x10007b17,
  methodSha256: '3ac2430c7458752631b2072a8077013dbd935a739cec0c854ba454dbc687669f',
});

export const WINDOW_SET_BUTTON_SOUNDS_ADDRESSES = freeze({
  body: WINDOW_SET_BUTTON_SOUNDS_NATIVE.methodBody,
  end: WINDOW_SET_BUTTON_SOUNDS_NATIVE.methodEnd,
});

/** Numeric byte offsets in the native XButtonWindow object. */
export const WINDOW_SET_BUTTON_SOUNDS_OFFSETS = freeze({
  pressSound: 0x190,
  clickSound: 0x194,
});

export const WINDOW_SET_BUTTON_SOUNDS_FIELDS =
  WINDOW_SET_BUTTON_SOUNDS_OFFSETS;

export const WINDOW_SET_BUTTON_SOUNDS_NATIVE_CONTRACT = freeze({
  name: 'XButtonWindow::SetButtonSounds',
  address: WINDOW_SET_BUTTON_SOUNDS_NATIVE.methodBody,
  arguments: freeze(['pressSound:object', 'clickSound:object']),
  returns: 'void',
  rawStorage: 'write(object, offset, kind, value, details)',
  fields: freeze({...WINDOW_SET_BUTTON_SOUNDS_OFFSETS}),
  callbacks: freeze([]),
});

export class WindowSetButtonSoundsNativeBoundaryError extends Error {
  constructor(message, {
    kind = 'BOUNDARY', value = undefined, object = undefined,
    offset = null, operation = null,
  } = {}) {
    super(message);
    this.name = 'WindowSetButtonSoundsNativeBoundaryError';
    this.code = `WINDOW_SET_BUTTON_SOUNDS_${kind}`;
    this.value = value;
    this.object = object;
    this.offset = offset;
    this.operation = operation;
  }
}

const fail = (message, details = {}) => {
  throw new WindowSetButtonSoundsNativeBoundaryError(message, details);
};

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`XButtonWindow::SetButtonSounds ${label} suspended; native path is synchronous`, {
      kind: 'ASYNC', value, operation: label,
    });
  }
  return value;
}

function objectReference(value, name) {
  if (value === null || value === undefined ||
      (typeof value !== 'object' && typeof value !== 'function')) {
    fail(`XButtonWindow::SetButtonSounds requires canonical ${name}`, {
      kind: 'REFERENCE', value, operation: name,
    });
  }
  return value;
}

function soundReference(value, name) {
  if (value === 0) return null;
  if (value !== null && value !== undefined &&
      typeof value !== 'object' && typeof value !== 'function') {
    fail(`XButtonWindow::SetButtonSounds requires canonical ${name} or none`, {
      kind: 'REFERENCE', value, operation: name,
    });
  }
  return value ?? null;
}

/**
 * Execute the original method body: +0x190 = pressSound, +0x194 = clickSound.
 * The stored values are sound OBJECT POINTERS; nothing is played.
 */
export function setButtonSoundsNative(
  object, pressSound, clickSound, services = {}) {
  objectReference(object, 'window');
  const writer = services.write;
  if (typeof writer !== 'function') {
    fail('XButtonWindow::SetButtonSounds requires write service', {
      kind: 'SERVICE',
      offset: WINDOW_SET_BUTTON_SOUNDS_OFFSETS.pressSound,
      operation: 'button-sounds-store',
    });
  }
  const F = WINDOW_SET_BUTTON_SOUNDS_OFFSETS;
  sync(writer(object, F.pressSound, 'ptr', soundReference(pressSound, 'pressSound'), {
    native: WINDOW_SET_BUTTON_SOUNDS_NATIVE.methodBody,
    phase: 'press-sound-store', object, offset: F.pressSound,
    kind: 'ptr', width: 4,
  }), 'write +0x190');
  sync(writer(object, F.clickSound, 'ptr', soundReference(clickSound, 'clickSound'), {
    native: WINDOW_SET_BUTTON_SOUNDS_NATIVE.methodBody,
    phase: 'click-sound-store', object, offset: F.clickSound,
    kind: 'ptr', width: 4,
  }), 'write +0x194');
}

export const windowSetButtonSoundsNative = setButtonSoundsNative;
export const buttonWindowSetButtonSoundsNative = setButtonSoundsNative;
