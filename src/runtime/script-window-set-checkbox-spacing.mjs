/**
 * Recovered Extension.dll XCheckboxWindow::SetCheckboxSpacing translation.
 *
 * The registered exec body evaluates one float argument and tail-calls the
 * method at 0x1000a910, which compares the current +0x204 spacing float
 * against the argument with `fcomp`/`fnstsw` (ZF = equal OR unordered):
 * when they differ it stores the new spacing into +0x204 and calls
 * AskParentForReconfigure; when equal (or NaN-unordered) it does nothing.
 *
 * Evidence: Extension.dll SHA-256
 * 93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c,
 * exec body 0x1000b0a0 through 0x1000b0e6,
 * method body 0x1000a910 through 0x1000a969,
 * AskParentForReconfigure leaf at 0x1004e060.
 */

const freeze = value => Object.freeze(value);

export const WINDOW_SET_CHECKBOX_SPACING_NATIVE = freeze({
  package: 'Extension',
  function:
    'CheckboxWindow.SetCheckboxSpacing / XCheckboxWindow::SetCheckboxSpacing',
  packageExport: 988,
  nativeIndex: 1841,
  functionFlags: 0x401,
  serialSize: 31,
  dll: 'Extension.dll',
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  imageBase: 0x10000000,
  execBody: 0x1000b0a0,
  execEnd: 0x1000b0e6,
  execSha256: '832e5a22af4c2df6d875a82411bd9ca820973fedf7f6ce48de628b4932582cdd',
  methodBody: 0x1000a910,
  methodEnd: 0x1000a969,
  methodSha256: '57a2485cfd0167f7dba6125c3e3993585e3521209df48bc5b6509ce54b6ba8b1',
});

export const WINDOW_SET_CHECKBOX_SPACING_ADDRESSES = freeze({
  body: WINDOW_SET_CHECKBOX_SPACING_NATIVE.methodBody,
  end: WINDOW_SET_CHECKBOX_SPACING_NATIVE.methodEnd,
});

/** Numeric byte offsets in the native XCheckboxWindow object. */
export const WINDOW_SET_CHECKBOX_SPACING_OFFSETS = freeze({
  checkboxSpacing: 0x204,
});

export const WINDOW_SET_CHECKBOX_SPACING_FIELDS =
  WINDOW_SET_CHECKBOX_SPACING_OFFSETS;

export const WINDOW_SET_CHECKBOX_SPACING_NATIVE_CONTRACT = freeze({
  name: 'XCheckboxWindow::SetCheckboxSpacing',
  address: WINDOW_SET_CHECKBOX_SPACING_NATIVE.methodBody,
  arguments: freeze(['newSpacing:float']),
  returns: 'void',
  rawStorage: 'read/write(object, offset, kind, ..., details)',
  fields: freeze({
    checkboxSpacing: WINDOW_SET_CHECKBOX_SPACING_OFFSETS.checkboxSpacing,
  }),
  callbacks: freeze(['AskParentForReconfigure (leaf, only when changed)']),
});

export class WindowSetCheckboxSpacingNativeBoundaryError extends Error {
  constructor(message, {
    kind = 'BOUNDARY', value = undefined, object = undefined,
    offset = null, operation = null,
  } = {}) {
    super(message);
    this.name = 'WindowSetCheckboxSpacingNativeBoundaryError';
    this.code = `WINDOW_SET_CHECKBOX_SPACING_${kind}`;
    this.value = value;
    this.object = object;
    this.offset = offset;
    this.operation = operation;
  }
}

const fail = (message, details = {}) => {
  throw new WindowSetCheckboxSpacingNativeBoundaryError(message, details);
};

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`XCheckboxWindow::SetCheckboxSpacing ${label} suspended; native path is synchronous`, {
      kind: 'ASYNC', value, operation: label,
    });
  }
  return value;
}

function objectReference(value, name) {
  if (value === null || value === undefined ||
      (typeof value !== 'object' && typeof value !== 'function')) {
    fail(`XCheckboxWindow::SetCheckboxSpacing requires canonical ${name}`, {
      kind: 'REFERENCE', value, operation: name,
    });
  }
  return value;
}

/** x87 fcomp equality: equal OR unordered (either operand NaN). */
const fcompEqual = (a, b) => a === b || Number.isNaN(a) || Number.isNaN(b);

/**
 * Execute the original method body: if the +0x204 spacing differs from
 * `newSpacing` under fcomp semantics, store it and emit the
 * AskParentForReconfigure callback.
 */
export function setCheckboxSpacingNative(object, newSpacing, services = {}) {
  objectReference(object, 'window');
  const reader = services.read;
  const writer = services.write;
  if (typeof reader !== 'function' || typeof writer !== 'function') {
    fail('XCheckboxWindow::SetCheckboxSpacing requires read/write services', {
      kind: 'SERVICE',
      offset: WINDOW_SET_CHECKBOX_SPACING_OFFSETS.checkboxSpacing,
      operation: 'checkbox-spacing-update',
    });
  }
  const offset = WINDOW_SET_CHECKBOX_SPACING_OFFSETS.checkboxSpacing;
  const current = sync(reader(object, offset, 'f32', {
    native: WINDOW_SET_CHECKBOX_SPACING_NATIVE.methodBody,
    phase: 'checkbox-spacing-read', object, offset, kind: 'f32', width: 4,
  }), 'read +0x204');
  if (typeof current !== 'number') {
    fail('XCheckboxWindow::SetCheckboxSpacing requires float +0x204 field', {
      kind: 'VALUE', value: current, object, offset,
      operation: 'checkbox-spacing-read',
    });
  }
  if (fcompEqual(current, newSpacing)) return;
  sync(writer(object, offset, 'f32', newSpacing, {
    native: WINDOW_SET_CHECKBOX_SPACING_NATIVE.methodBody,
    phase: 'checkbox-spacing-write', object, offset, kind: 'f32', width: 4,
  }), 'write +0x204');
  const reconfigure = services.askParentForReconfigure;
  if (typeof reconfigure !== 'function') {
    fail('XCheckboxWindow::SetCheckboxSpacing requires AskParentForReconfigure service', {
      kind: 'SERVICE', object, offset,
      operation: 'ask-parent-reconfigure',
    });
  }
  sync(reconfigure({
    native: WINDOW_SET_CHECKBOX_SPACING_NATIVE.methodBody,
    phase: 'ask-parent-reconfigure',
    object,
    callee: 0x1004e060,
  }), 'AskParentForReconfigure');
}

export const windowSetCheckboxSpacingNative = setCheckboxSpacingNative;
export const checkboxWindowSetCheckboxSpacingNative =
  setCheckboxSpacingNative;
