/**
 * Recovered Extension.dll XCheckboxWindow::SetCheckboxColor translation.
 *
 * The registered exec body evaluates one struct (4-byte color) argument and
 * tail-calls the method at 0x1000a9b0, which stores the dword into the
 * unaligned color field at +0x20d.  No flag tests, no reconfigure call.
 *
 * Evidence: Extension.dll SHA-256
 * 93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c,
 * exec body 0x1000b200 through 0x1000b23c,
 * method body 0x1000a9b0 through 0x1000a9bd.
 */

const freeze = value => Object.freeze(value);

export const WINDOW_SET_CHECKBOX_COLOR_NATIVE = freeze({
  package: 'Extension',
  function: 'CheckboxWindow.SetCheckboxColor / XCheckboxWindow::SetCheckboxColor',
  packageExport: 1012,
  nativeIndex: 1844,
  functionFlags: 0x401,
  serialSize: 31,
  dll: 'Extension.dll',
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  imageBase: 0x10000000,
  execBody: 0x1000b200,
  execEnd: 0x1000b23c,
  execSha256: '61fb39e54cfbab63e66ae0dea3f18e84abbe8acdaa519e6f950ab78436fefe8d',
  methodBody: 0x1000a9b0,
  methodEnd: 0x1000a9bd,
  methodSha256: 'c0a53b4128d8eb408deff44b06f76aa5465f44365ae0d58cbe0f6a856e5fa4bc',
});

export const WINDOW_SET_CHECKBOX_COLOR_ADDRESSES = freeze({
  body: WINDOW_SET_CHECKBOX_COLOR_NATIVE.methodBody,
  end: WINDOW_SET_CHECKBOX_COLOR_NATIVE.methodEnd,
});

/** Numeric byte offsets in the native XCheckboxWindow object. */
export const WINDOW_SET_CHECKBOX_COLOR_OFFSETS = freeze({
  checkboxColor: 0x20d,
});

export const WINDOW_SET_CHECKBOX_COLOR_FIELDS =
  WINDOW_SET_CHECKBOX_COLOR_OFFSETS;

export const WINDOW_SET_CHECKBOX_COLOR_NATIVE_CONTRACT = freeze({
  name: 'XCheckboxWindow::SetCheckboxColor',
  address: WINDOW_SET_CHECKBOX_COLOR_NATIVE.methodBody,
  arguments: freeze(['NewColor:struct (dword RGBA)']),
  returns: 'void',
  rawStorage: 'write(object, offset, kind, value, details)',
  fields: freeze({
    checkboxColor: WINDOW_SET_CHECKBOX_COLOR_OFFSETS.checkboxColor,
  }),
  callbacks: freeze([]),
});

export class WindowSetCheckboxColorNativeBoundaryError extends Error {
  constructor(message, {
    kind = 'BOUNDARY', value = undefined, object = undefined,
    offset = null, operation = null,
  } = {}) {
    super(message);
    this.name = 'WindowSetCheckboxColorNativeBoundaryError';
    this.code = `WINDOW_SET_CHECKBOX_COLOR_${kind}`;
    this.value = value;
    this.object = object;
    this.offset = offset;
    this.operation = operation;
  }
}

const fail = (message, details = {}) => {
  throw new WindowSetCheckboxColorNativeBoundaryError(message, details);
};

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`XCheckboxWindow::SetCheckboxColor ${label} suspended; native path is synchronous`, {
      kind: 'ASYNC', value, operation: label,
    });
  }
  return value;
}

function objectReference(object, name) {
  if (object === null || object === undefined ||
      (typeof object !== 'object' && typeof object !== 'function')) {
    fail(`XCheckboxWindow::SetCheckboxColor requires canonical ${name}`, {
      kind: 'REFERENCE', value: object, operation: name,
    });
  }
  return object;
}

/**
 * Execute the original method body: store the `NewColor` dword into +0x20d.
 *
 * `object` is the canonical CheckboxWindow receiver.  `newColor` is the
 * evaluated 4-byte color (script `Color` marshals as one dword).
 */
export function setCheckboxColorNative(object, newColor, services = {}) {
  objectReference(object, 'window');
  const writer = services.write;
  if (typeof writer !== 'function') {
    fail('XCheckboxWindow::SetCheckboxColor requires write service', {
      kind: 'SERVICE',
      offset: WINDOW_SET_CHECKBOX_COLOR_OFFSETS.checkboxColor,
      operation: 'checkbox-color-store',
    });
  }
  if (!Number.isInteger(newColor)) {
    fail('XCheckboxWindow::SetCheckboxColor requires a dword color', {
      kind: 'VALUE', value: newColor,
      offset: WINDOW_SET_CHECKBOX_COLOR_OFFSETS.checkboxColor,
      operation: 'checkbox-color-store',
    });
  }
  const offset = WINDOW_SET_CHECKBOX_COLOR_OFFSETS.checkboxColor;
  sync(writer(object, offset, 'u32', newColor, {
    native: WINDOW_SET_CHECKBOX_COLOR_NATIVE.methodBody,
    phase: 'checkbox-color-store',
    object,
    offset,
    kind: 'u32',
    width: 4,
  }), 'write +0x20d');
}

export const windowSetCheckboxColorNative = setCheckboxColorNative;
export const checkboxWindowSetCheckboxColorNative = setCheckboxColorNative;
