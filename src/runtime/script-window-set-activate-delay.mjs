/**
 * Recovered Extension.dll XButtonWindow::SetActivateDelay translation.
 *
 * The registered exec body evaluates one float argument into a stack slot
 * (script default 0.3f lives in the exec's own local init, VM-side) and then
 * `fld`/`fstp`s it into the activation-delay field at +0x178.  No flag tests,
 * no reconfigure call, no other state touched.
 *
 * Evidence: Extension.dll SHA-256
 * 93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c,
 * exec body 0x10008620 through 0x10008665.
 */

const freeze = value => Object.freeze(value);

export const WINDOW_SET_ACTIVATE_DELAY_NATIVE = freeze({
  package: 'Extension',
  function: 'ButtonWindow.SetActivateDelay / XButtonWindow::SetActivateDelay',
  packageExport: 1065,
  nativeIndex: 1591,
  functionFlags: 0x401,
  serialSize: 31,
  dll: 'Extension.dll',
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  imageBase: 0x10000000,
  execBody: 0x10008620,
  execEnd: 0x10008665,
  execSha256: 'cba3940499b76b1c62c2028475f795b8eab34ccee3c42bc9fbaf355f811ead7c',
});

export const WINDOW_SET_ACTIVATE_DELAY_ADDRESSES = freeze({
  body: WINDOW_SET_ACTIVATE_DELAY_NATIVE.execBody,
  end: WINDOW_SET_ACTIVATE_DELAY_NATIVE.execEnd,
});

/** Numeric byte offsets in the native XButtonWindow object. */
export const WINDOW_SET_ACTIVATE_DELAY_OFFSETS = freeze({
  activateDelay: 0x178,
});

export const WINDOW_SET_ACTIVATE_DELAY_FIELDS =
  WINDOW_SET_ACTIVATE_DELAY_OFFSETS;

export const WINDOW_SET_ACTIVATE_DELAY_NATIVE_CONTRACT = freeze({
  name: 'XButtonWindow::SetActivateDelay',
  address: WINDOW_SET_ACTIVATE_DELAY_NATIVE.execBody,
  arguments: freeze(['newDelay:float']),
  returns: 'void',
  rawStorage: 'write(object, offset, kind, value, details)',
  fields: freeze({
    activateDelay: WINDOW_SET_ACTIVATE_DELAY_OFFSETS.activateDelay,
  }),
  callbacks: freeze([]),
});

export class WindowSetActivateDelayNativeBoundaryError extends Error {
  constructor(message, {
    kind = 'BOUNDARY', value = undefined, object = undefined,
    offset = null, operation = null,
  } = {}) {
    super(message);
    this.name = 'WindowSetActivateDelayNativeBoundaryError';
    this.code = `WINDOW_SET_ACTIVATE_DELAY_${kind}`;
    this.value = value;
    this.object = object;
    this.offset = offset;
    this.operation = operation;
  }
}

const fail = (message, details = {}) => {
  throw new WindowSetActivateDelayNativeBoundaryError(message, details);
};

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`XButtonWindow::SetActivateDelay ${label} suspended; native path is synchronous`, {
      kind: 'ASYNC', value, operation: label,
    });
  }
  return value;
}

function objectReference(value, name) {
  if (value === null || value === undefined ||
      (typeof value !== 'object' && typeof value !== 'function')) {
    fail(`XButtonWindow::SetActivateDelay requires canonical ${name}`, {
      kind: 'REFERENCE', value, operation: name,
    });
  }
  return value;
}

/**
 * Execute the original exec body: store `newDelay` as the +0x178 float.
 *
 * `object` is the canonical ButtonWindow receiver.  `services.write` has the
 * signature `write(object, offset, kind, value, details)` and must accept the
 * +0x178 float field.  The argument arrives already evaluated by the script
 * VM; this native performs the field store only.
 */
export function setActivateDelayNative(object, newDelay, services = {}) {
  objectReference(object, 'window');
  const writer = services.write;
  if (typeof writer !== 'function') {
    fail('XButtonWindow::SetActivateDelay requires write service', {
      kind: 'SERVICE',
      offset: WINDOW_SET_ACTIVATE_DELAY_OFFSETS.activateDelay,
      operation: 'activate-delay-store',
    });
  }
  if (typeof newDelay !== 'number' || Number.isNaN(newDelay)) {
    fail('XButtonWindow::SetActivateDelay requires a finite float delay', {
      kind: 'VALUE', value: newDelay,
      offset: WINDOW_SET_ACTIVATE_DELAY_OFFSETS.activateDelay,
      operation: 'activate-delay-store',
    });
  }
  const offset = WINDOW_SET_ACTIVATE_DELAY_OFFSETS.activateDelay;
  sync(writer(object, offset, 'f32', newDelay, {
    native: WINDOW_SET_ACTIVATE_DELAY_NATIVE.execBody,
    phase: 'activate-delay-store',
    object,
    offset,
    kind: 'f32',
    width: 4,
  }), 'write +0x178');
}

export const windowSetActivateDelayNative = setActivateDelayNative;
export const buttonWindowSetActivateDelayNative = setActivateDelayNative;
