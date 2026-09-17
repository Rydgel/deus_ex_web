/**
 * Recovered Extension.dll XCheckboxWindow::SetCheckboxStyle translation.
 *
 * The registered exec body evaluates one byte argument (script default 0) and
 * tail-calls the method at 0x1000a9a0, which stores the argument's low byte
 * into the style byte at +0x20c.  No flag tests, no reconfigure call.
 *
 * Evidence: Extension.dll SHA-256
 * 93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c,
 * exec body 0x1000b190 through 0x1000b1d3,
 * method body 0x1000a9a0 through 0x1000a9ad.
 */

const freeze = value => Object.freeze(value);

export const WINDOW_SET_CHECKBOX_STYLE_NATIVE = freeze({
  package: 'Extension',
  function: 'CheckboxWindow.SetCheckboxStyle / XCheckboxWindow::SetCheckboxStyle',
  packageExport: 1011,
  nativeIndex: 1843,
  functionFlags: 0x401,
  serialSize: 31,
  dll: 'Extension.dll',
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  imageBase: 0x10000000,
  execBody: 0x1000b190,
  execEnd: 0x1000b1d3,
  execSha256: '57ce3fcab9981cafed07422025132cd8c943f38229f2a28d5fc47ed2c17f681a',
  methodBody: 0x1000a9a0,
  methodEnd: 0x1000a9ad,
  methodSha256: '5205f04c9fa4361e03484f955edec791f2a387babb850494abdf648714c2f645',
});

export const WINDOW_SET_CHECKBOX_STYLE_ADDRESSES = freeze({
  body: WINDOW_SET_CHECKBOX_STYLE_NATIVE.methodBody,
  end: WINDOW_SET_CHECKBOX_STYLE_NATIVE.methodEnd,
});

/** Numeric byte offsets in the native XCheckboxWindow object. */
export const WINDOW_SET_CHECKBOX_STYLE_OFFSETS = freeze({
  checkboxStyle: 0x20c,
});

export const WINDOW_SET_CHECKBOX_STYLE_FIELDS =
  WINDOW_SET_CHECKBOX_STYLE_OFFSETS;

export const WINDOW_SET_CHECKBOX_STYLE_NATIVE_CONTRACT = freeze({
  name: 'XCheckboxWindow::SetCheckboxStyle',
  address: WINDOW_SET_CHECKBOX_STYLE_NATIVE.methodBody,
  arguments: freeze(['NewStyle:byte']),
  returns: 'void',
  rawStorage: 'write(object, offset, kind, value, details)',
  fields: freeze({
    checkboxStyle: WINDOW_SET_CHECKBOX_STYLE_OFFSETS.checkboxStyle,
  }),
  callbacks: freeze([]),
});

export class WindowSetCheckboxStyleNativeBoundaryError extends Error {
  constructor(message, {
    kind = 'BOUNDARY', value = undefined, object = undefined,
    offset = null, operation = null,
  } = {}) {
    super(message);
    this.name = 'WindowSetCheckboxStyleNativeBoundaryError';
    this.code = `WINDOW_SET_CHECKBOX_STYLE_${kind}`;
    this.value = value;
    this.object = object;
    this.offset = offset;
    this.operation = operation;
  }
}

const fail = (message, details = {}) => {
  throw new WindowSetCheckboxStyleNativeBoundaryError(message, details);
};

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`XCheckboxWindow::SetCheckboxStyle ${label} suspended; native path is synchronous`, {
      kind: 'ASYNC', value, operation: label,
    });
  }
  return value;
}

function objectReference(value, name) {
  if (value === null || value === undefined ||
      (typeof value !== 'object' && typeof value !== 'function')) {
    fail(`XCheckboxWindow::SetCheckboxStyle requires canonical ${name}`, {
      kind: 'REFERENCE', value, operation: name,
    });
  }
  return value;
}

/**
 * Execute the original method body: store `NewStyle`'s low byte into +0x20c.
 *
 * `object` is the canonical CheckboxWindow receiver.  `services.write` has
 * the signature `write(object, offset, kind, value, details)`; the store is
 * a single byte write.
 */
export function setCheckboxStyleNative(object, newStyle, services = {}) {
  objectReference(object, 'window');
  const writer = services.write;
  if (typeof writer !== 'function') {
    fail('XCheckboxWindow::SetCheckboxStyle requires write service', {
      kind: 'SERVICE',
      offset: WINDOW_SET_CHECKBOX_STYLE_OFFSETS.checkboxStyle,
      operation: 'checkbox-style-store',
    });
  }
  if (!Number.isInteger(newStyle)) {
    fail('XCheckboxWindow::SetCheckboxStyle requires a byte argument', {
      kind: 'VALUE', value: newStyle,
      offset: WINDOW_SET_CHECKBOX_STYLE_OFFSETS.checkboxStyle,
      operation: 'checkbox-style-store',
    });
  }
  const offset = WINDOW_SET_CHECKBOX_STYLE_OFFSETS.checkboxStyle;
  sync(writer(object, offset, 'u8', newStyle, {
    native: WINDOW_SET_CHECKBOX_STYLE_NATIVE.methodBody,
    phase: 'checkbox-style-store',
    object,
    offset,
    kind: 'u8',
    width: 1,
  }), 'write +0x20c');
}

export const windowSetCheckboxStyleNative = setCheckboxStyleNative;
export const checkboxWindowSetCheckboxStyleNative = setCheckboxStyleNative;
