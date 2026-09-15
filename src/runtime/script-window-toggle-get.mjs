/**
 * Recovered Extension.dll XToggleWindow::GetToggle translation.
 *
 * The unchanged method body is a three-instruction leaf: it reads the window's
 * toggle flags dword at +0x174 and returns only bit 0.  The exec trampoline at
 * 0x10049d80 advances the script frame past the call token, invokes the method,
 * and stores the dword result into the return slot; script-argument evaluation
 * is owned by the VM, not this adapter.  See docs/script-window-toggle-get.md.
 *
 * Evidence: Extension.dll SHA-256
 * 93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c,
 * method body 0x10049a50 through 0x10049a5a.
 */

const freeze = value => Object.freeze(value);

export const WINDOW_TOGGLE_GET_NATIVE = freeze({
  package: 'Extension',
  function: 'ToggleWindow.GetToggle / XToggleWindow::GetToggle',
  packageExport: 1033,
  nativeIndex: 1612,
  functionFlags: 0x401,
  serialSize: 28,
  dll: 'Extension.dll',
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  imageBase: 0x10000000,
  execBody: 0x10049d80,
  execEnd: 0x10049d95,
  execSha256: '279a75f4be5f46cf34e045bb54d0da0d813132af84a2be61aac8f4bd13405532',
  body: 0x10049a50,
  end: 0x10049a5a,
  stackBytes: 0,
  bodySha256: 'b01b08f5978bb9fdaf7a479ab9414e38adf5c10eb1f1a709401b966a4e0edaa9',
  registrationCell: 0x10098ea8,
});

export const WINDOW_TOGGLE_GET_NATIVE_ADDRESSES = freeze({
  body: WINDOW_TOGGLE_GET_NATIVE.body,
  end: WINDOW_TOGGLE_GET_NATIVE.end,
  registrationCell: WINDOW_TOGGLE_GET_NATIVE.registrationCell,
});

/** Numeric byte offsets in the native XToggleWindow object. */
export const WINDOW_TOGGLE_GET_OFFSETS = freeze({
  toggleFlags: 0x174,
});

export const WINDOW_TOGGLE_GET_FIELDS = WINDOW_TOGGLE_GET_OFFSETS;

/** The returned bit is bit 0 of the +0x174 flags dword. */
export const WINDOW_TOGGLE_GET_BITS = freeze({toggled: 0x01});

export const WINDOW_TOGGLE_GET_NATIVE_CONTRACT = freeze({
  name: 'XToggleWindow::GetToggle',
  address: WINDOW_TOGGLE_GET_NATIVE.body,
  arguments: freeze([]),
  returns: 'bool (dword bit 0)',
  rawStorage: 'read(object, offset, kind, details)',
  fields: freeze({toggleFlags: WINDOW_TOGGLE_GET_OFFSETS.toggleFlags}),
  callbacks: freeze([]),
});

export class WindowToggleGetNativeBoundaryError extends Error {
  constructor(message, {
    kind = 'BOUNDARY', value = undefined, object = undefined,
    offset = null, operation = null,
  } = {}) {
    super(message);
    this.name = 'WindowToggleGetNativeBoundaryError';
    this.code = `WINDOW_TOGGLE_GET_${kind}`;
    this.value = value;
    this.object = object;
    this.offset = offset;
    this.operation = operation;
  }
}

const fail = (message, details = {}) => {
  throw new WindowToggleGetNativeBoundaryError(message, details);
};

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`XToggleWindow::GetToggle ${label} suspended; native path is synchronous`, {
      kind: 'ASYNC', value, operation: label,
    });
  }
  return value;
}

function objectReference(value, name) {
  if (value === null || value === undefined ||
      (typeof value !== 'object' && typeof value !== 'function')) {
    fail(`XToggleWindow::GetToggle requires canonical ${name}`, {
      kind: 'REFERENCE', value, operation: name,
    });
  }
  return value;
}

function readFlags(object, services, phase) {
  const reader = services.read;
  if (typeof reader !== 'function') {
    fail('XToggleWindow::GetToggle requires read service', {
      kind: 'SERVICE', offset: WINDOW_TOGGLE_GET_OFFSETS.toggleFlags, operation: phase,
    });
  }
  const offset = WINDOW_TOGGLE_GET_OFFSETS.toggleFlags;
  const value = sync(reader(object, offset, 'u32', {
    native: WINDOW_TOGGLE_GET_NATIVE.body,
    phase,
    object,
    offset,
    kind: 'u32',
    width: 4,
  }), 'read +0x174');
  if (value === undefined) {
    fail('XToggleWindow::GetToggle reached unresolved +0x174 field', {
      kind: 'FIELD', value, object, offset, operation: phase,
    });
  }
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    fail('XToggleWindow::GetToggle requires uint32 +0x174 field', {
      kind: 'VALUE', value, object, offset, operation: phase,
    });
  }
  return value >>> 0;
}

/**
 * Execute the original bool XToggleWindow::GetToggle body.
 *
 * `object` is the canonical ToggleWindow receiver.  `services.read` has the
 * signature `read(object, offset, kind, details)` and must expose the +0x174
 * dword.  The native body returns the masked bit as a dword; the script-visible
 * result is a bool.
 */
export function getToggleNative(object, services = {}) {
  objectReference(object, 'window');
  const flags = readFlags(object, services, 'toggle-read');
  return (flags & WINDOW_TOGGLE_GET_BITS.toggled) !== 0;
}

export const windowGetToggleNative = getToggleNative;
export const toggleWindowGetToggleNative = getToggleNative;
