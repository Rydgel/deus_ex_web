/**
 * Recovered Extension.dll XToggleWindow::SetToggleSounds translation.
 *
 * The registered exec body evaluates two object arguments and tail-calls the
 * method at 0x10049a60, which stores the enable-sound pointer into +0x1ec and
 * the disable-sound pointer into +0x1f0.  Pure pointer stores — no audio is
 * played, no reconfigure call.
 *
 * Evidence: Extension.dll SHA-256
 * 93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c,
 * exec body 0x10049dc0 through 0x10049e2f,
 * method body 0x10049a60 through 0x10049a77.
 */

const freeze = value => Object.freeze(value);

export const WINDOW_SET_TOGGLE_SOUNDS_NATIVE = freeze({
  package: 'Extension',
  function: 'ToggleWindow.SetToggleSounds / XToggleWindow::SetToggleSounds',
  packageExport: 1026,
  nativeIndex: 1613,
  functionFlags: 0x401,
  serialSize: 34,
  dll: 'Extension.dll',
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  imageBase: 0x10000000,
  execBody: 0x10049dc0,
  execEnd: 0x10049e2f,
  execSha256: 'f8ebbbe10a34ca4e05b872486641a7b8c6b3f64e2ddca8b38b42a6b6041edcbe',
  methodBody: 0x10049a60,
  methodEnd: 0x10049a77,
  methodSha256: 'f5ff377a608f26160b0c72c110101655b38e7889e3007a705c5c83a1486da298',
});

export const WINDOW_SET_TOGGLE_SOUNDS_ADDRESSES = freeze({
  body: WINDOW_SET_TOGGLE_SOUNDS_NATIVE.methodBody,
  end: WINDOW_SET_TOGGLE_SOUNDS_NATIVE.methodEnd,
});

/** Numeric byte offsets in the native XToggleWindow object. */
export const WINDOW_SET_TOGGLE_SOUNDS_OFFSETS = freeze({
  enableSound: 0x1ec,
  disableSound: 0x1f0,
});

export const WINDOW_SET_TOGGLE_SOUNDS_FIELDS =
  WINDOW_SET_TOGGLE_SOUNDS_OFFSETS;

export const WINDOW_SET_TOGGLE_SOUNDS_NATIVE_CONTRACT = freeze({
  name: 'XToggleWindow::SetToggleSounds',
  address: WINDOW_SET_TOGGLE_SOUNDS_NATIVE.methodBody,
  arguments: freeze(['enableSound:object', 'disableSound:object']),
  returns: 'void',
  rawStorage: 'write(object, offset, kind, value, details)',
  fields: freeze({...WINDOW_SET_TOGGLE_SOUNDS_OFFSETS}),
  callbacks: freeze([]),
});

export class WindowSetToggleSoundsNativeBoundaryError extends Error {
  constructor(message, {
    kind = 'BOUNDARY', value = undefined, object = undefined,
    offset = null, operation = null,
  } = {}) {
    super(message);
    this.name = 'WindowSetToggleSoundsNativeBoundaryError';
    this.code = `WINDOW_SET_TOGGLE_SOUNDS_${kind}`;
    this.value = value;
    this.object = object;
    this.offset = offset;
    this.operation = operation;
  }
}

const fail = (message, details = {}) => {
  throw new WindowSetToggleSoundsNativeBoundaryError(message, details);
};

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`XToggleWindow::SetToggleSounds ${label} suspended; native path is synchronous`, {
      kind: 'ASYNC', value, operation: label,
    });
  }
  return value;
}

function objectReference(value, name) {
  if (value === null || value === undefined ||
      (typeof value !== 'object' && typeof value !== 'function')) {
    fail(`XToggleWindow::SetToggleSounds requires canonical ${name}`, {
      kind: 'REFERENCE', value, operation: name,
    });
  }
  return value;
}

function soundReference(value, name) {
  if (value === 0) return null;
  if (value !== null && value !== undefined &&
      typeof value !== 'object' && typeof value !== 'function') {
    fail(`XToggleWindow::SetToggleSounds requires canonical ${name} or none`, {
      kind: 'REFERENCE', value, operation: name,
    });
  }
  return value ?? null;
}

/**
 * Execute the original method body: +0x1ec = enableSound,
 * +0x1f0 = disableSound.  The stored values are sound OBJECT POINTERS;
 * nothing is played.
 */
export function setToggleSoundsNative(
  object, enableSound, disableSound, services = {}) {
  objectReference(object, 'window');
  const writer = services.write;
  if (typeof writer !== 'function') {
    fail('XToggleWindow::SetToggleSounds requires write service', {
      kind: 'SERVICE',
      offset: WINDOW_SET_TOGGLE_SOUNDS_OFFSETS.enableSound,
      operation: 'toggle-sounds-store',
    });
  }
  const F = WINDOW_SET_TOGGLE_SOUNDS_OFFSETS;
  sync(writer(object, F.enableSound, 'ptr', soundReference(enableSound, 'enableSound'), {
    native: WINDOW_SET_TOGGLE_SOUNDS_NATIVE.methodBody,
    phase: 'enable-sound-store', object, offset: F.enableSound,
    kind: 'ptr', width: 4,
  }), 'write +0x1ec');
  sync(writer(object, F.disableSound, 'ptr', soundReference(disableSound, 'disableSound'), {
    native: WINDOW_SET_TOGGLE_SOUNDS_NATIVE.methodBody,
    phase: 'disable-sound-store', object, offset: F.disableSound,
    kind: 'ptr', width: 4,
  }), 'write +0x1f0');
}

export const windowSetToggleSoundsNative = setToggleSoundsNative;
export const toggleWindowSetToggleSoundsNative = setToggleSoundsNative;
