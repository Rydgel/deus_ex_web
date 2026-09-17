/**
 * Recovered Extension.dll XRadioBoxWindow::GetEnabledToggle translation.
 *
 * The registered exec body is the whole native — it is an inline trampoline
 * with no separate method call: it takes the receiver from the script frame
 * (frame+8), reads the enabled-toggle child pointer at +0x184, and stores it
 * verbatim into the result slot.  No flag tests, no child walk, no callback.
 *
 * Evidence: Extension.dll SHA-256
 * 93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c,
 * exec body 0x10038e00 through 0x10038e1a.
 */

const freeze = value => Object.freeze(value);

export const WINDOW_GET_ENABLED_TOGGLE_NATIVE = freeze({
  package: 'Extension',
  function: 'RadioBoxWindow.GetEnabledToggle / XRadioBoxWindow::GetEnabledToggle',
  packageExport: 1216,
  nativeIndex: 1820,
  functionFlags: 0x401,
  serialSize: 28,
  dll: 'Extension.dll',
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  imageBase: 0x10000000,
  execBody: 0x10038e00,
  execEnd: 0x10038e1a,
  execSha256: '6752f2a8df53432f7857548b4bbd6b256f088740177b80444b1069f081ebd522',
});

export const WINDOW_GET_ENABLED_TOGGLE_ADDRESSES = freeze({
  body: WINDOW_GET_ENABLED_TOGGLE_NATIVE.execBody,
  end: WINDOW_GET_ENABLED_TOGGLE_NATIVE.execEnd,
});

/** Numeric byte offsets in the native XRadioBoxWindow object. */
export const WINDOW_GET_ENABLED_TOGGLE_OFFSETS = freeze({
  enabledToggle: 0x184,
});

export const WINDOW_GET_ENABLED_TOGGLE_FIELDS =
  WINDOW_GET_ENABLED_TOGGLE_OFFSETS;

export const WINDOW_GET_ENABLED_TOGGLE_NATIVE_CONTRACT = freeze({
  name: 'XRadioBoxWindow::GetEnabledToggle',
  address: WINDOW_GET_ENABLED_TOGGLE_NATIVE.execBody,
  arguments: freeze([]),
  returns: 'XToggleWindow* (dword pointer at +0x184)',
  rawStorage: 'read(object, offset, kind, details)',
  fields: freeze({
    enabledToggle: WINDOW_GET_ENABLED_TOGGLE_OFFSETS.enabledToggle,
  }),
  callbacks: freeze([]),
});

export class WindowGetEnabledToggleNativeBoundaryError extends Error {
  constructor(message, {
    kind = 'BOUNDARY', value = undefined, object = undefined,
    offset = null, operation = null,
  } = {}) {
    super(message);
    this.name = 'WindowGetEnabledToggleNativeBoundaryError';
    this.code = `WINDOW_GET_ENABLED_TOGGLE_${kind}`;
    this.value = value;
    this.object = object;
    this.offset = offset;
    this.operation = operation;
  }
}

const fail = (message, details = {}) => {
  throw new WindowGetEnabledToggleNativeBoundaryError(message, details);
};

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`XRadioBoxWindow::GetEnabledToggle ${label} suspended; native path is synchronous`, {
      kind: 'ASYNC', value, operation: label,
    });
  }
  return value;
}

function objectReference(value, name) {
  if (value === null || value === undefined ||
      (typeof value !== 'object' && typeof value !== 'function')) {
    fail(`XRadioBoxWindow::GetEnabledToggle requires canonical ${name}`, {
      kind: 'REFERENCE', value, operation: name,
    });
  }
  return value;
}

/**
 * Execute the original exec body: return the +0x184 pointer as a canonical
 * object reference (or null when the field holds no child).
 *
 * `object` is the canonical RadioBoxWindow receiver.  `services.read` has the
 * signature `read(object, offset, kind, details)` and must expose the +0x184
 * pointer field.
 */
export function getEnabledToggleNative(object, services = {}) {
  objectReference(object, 'window');
  const reader = services.read;
  if (typeof reader !== 'function') {
    fail('XRadioBoxWindow::GetEnabledToggle requires read service', {
      kind: 'SERVICE',
      offset: WINDOW_GET_ENABLED_TOGGLE_OFFSETS.enabledToggle,
      operation: 'enabled-toggle-read',
    });
  }
  const offset = WINDOW_GET_ENABLED_TOGGLE_OFFSETS.enabledToggle;
  return sync(reader(object, offset, 'ptr', {
    native: WINDOW_GET_ENABLED_TOGGLE_NATIVE.execBody,
    phase: 'enabled-toggle-read',
    object,
    offset,
    kind: 'ptr',
    width: 4,
  }), 'read +0x184');
}

export const windowGetEnabledToggleNative = getEnabledToggleNative;
export const radioBoxWindowGetEnabledToggleNative = getEnabledToggleNative;
