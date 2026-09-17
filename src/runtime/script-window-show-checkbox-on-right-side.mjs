/**
 * Recovered Extension.dll XCheckboxWindow::ShowCheckboxOnRightSide translation.
 *
 * The registered exec body evaluates one bool argument (script default true)
 * and then updates bit 0 of the dword flags field at +0x208 in place:
 *   flags ^= (flags ^ arg) & 1
 * preserving every other bit.  No reconfigure call, no other state touched.
 *
 * Evidence: Extension.dll SHA-256
 * 93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c,
 * exec body 0x1000b110 through 0x1000b163.
 */

const freeze = value => Object.freeze(value);

export const WINDOW_SHOW_CHECKBOX_ON_RIGHT_SIDE_NATIVE = freeze({
  package: 'Extension',
  function:
    'CheckboxWindow.ShowCheckboxOnRightSide / XCheckboxWindow::ShowCheckboxOnRightSide',
  packageExport: 914,
  nativeIndex: 1842,
  functionFlags: 0x401,
  serialSize: 31,
  dll: 'Extension.dll',
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  imageBase: 0x10000000,
  execBody: 0x1000b110,
  execEnd: 0x1000b163,
  execSha256: '8c06280539de3dc6487f339e4109445a3eddf96c6db74611550b5b4122e4efd0',
});

export const WINDOW_SHOW_CHECKBOX_ON_RIGHT_SIDE_ADDRESSES = freeze({
  body: WINDOW_SHOW_CHECKBOX_ON_RIGHT_SIDE_NATIVE.execBody,
  end: WINDOW_SHOW_CHECKBOX_ON_RIGHT_SIDE_NATIVE.execEnd,
});

/** Numeric byte offsets in the native XCheckboxWindow object. */
export const WINDOW_SHOW_CHECKBOX_ON_RIGHT_SIDE_OFFSETS = freeze({
  checkboxFlags: 0x208,
});

export const WINDOW_SHOW_CHECKBOX_ON_RIGHT_SIDE_FIELDS =
  WINDOW_SHOW_CHECKBOX_ON_RIGHT_SIDE_OFFSETS;

/** Bit 0 of +0x208 is the show-on-right-side flag. */
export const WINDOW_SHOW_CHECKBOX_ON_RIGHT_SIDE_BITS = freeze({
  onRight: 0x01,
});

export const WINDOW_SHOW_CHECKBOX_ON_RIGHT_SIDE_NATIVE_CONTRACT = freeze({
  name: 'XCheckboxWindow::ShowCheckboxOnRightSide',
  address: WINDOW_SHOW_CHECKBOX_ON_RIGHT_SIDE_NATIVE.execBody,
  arguments: freeze(['bRight:bool']),
  returns: 'void',
  rawStorage: 'read/write(object, offset, kind, ..., details)',
  fields: freeze({
    checkboxFlags: WINDOW_SHOW_CHECKBOX_ON_RIGHT_SIDE_OFFSETS.checkboxFlags,
  }),
  callbacks: freeze([]),
});

export class WindowShowCheckboxOnRightSideNativeBoundaryError extends Error {
  constructor(message, {
    kind = 'BOUNDARY', value = undefined, object = undefined,
    offset = null, operation = null,
  } = {}) {
    super(message);
    this.name = 'WindowShowCheckboxOnRightSideNativeBoundaryError';
    this.code = `WINDOW_SHOW_CHECKBOX_ON_RIGHT_SIDE_${kind}`;
    this.value = value;
    this.object = object;
    this.offset = offset;
    this.operation = operation;
  }
}

const fail = (message, details = {}) => {
  throw new WindowShowCheckboxOnRightSideNativeBoundaryError(message, details);
};

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`XCheckboxWindow::ShowCheckboxOnRightSide ${label} suspended; native path is synchronous`, {
      kind: 'ASYNC', value, operation: label,
    });
  }
  return value;
}

function objectReference(value, name) {
  if (value === null || value === undefined ||
      (typeof value !== 'object' && typeof value !== 'function')) {
    fail(`XCheckboxWindow::ShowCheckboxOnRightSide requires canonical ${name}`, {
      kind: 'REFERENCE', value, operation: name,
    });
  }
  return value;
}

function readFlags(object, services, phase) {
  const reader = services.read;
  if (typeof reader !== 'function') {
    fail('XCheckboxWindow::ShowCheckboxOnRightSide requires read service', {
      kind: 'SERVICE',
      offset: WINDOW_SHOW_CHECKBOX_ON_RIGHT_SIDE_OFFSETS.checkboxFlags,
      operation: phase,
    });
  }
  const offset = WINDOW_SHOW_CHECKBOX_ON_RIGHT_SIDE_OFFSETS.checkboxFlags;
  const value = sync(reader(object, offset, 'u32', {
    native: WINDOW_SHOW_CHECKBOX_ON_RIGHT_SIDE_NATIVE.execBody,
    phase, object, offset, kind: 'u32', width: 4,
  }), 'read +0x208');
  if (value === undefined) {
    fail('XCheckboxWindow::ShowCheckboxOnRightSide reached unresolved +0x208 field', {
      kind: 'FIELD', value, object, offset, operation: phase,
    });
  }
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    fail('XCheckboxWindow::ShowCheckboxOnRightSide requires uint32 +0x208 field', {
      kind: 'VALUE', value, object, offset, operation: phase,
    });
  }
  return value >>> 0;
}

/**
 * Execute the original exec body: `+0x208 = (+0x208 & ~1) | (arg & 1)`.
 *
 * `object` is the canonical CheckboxWindow receiver.  `bRight` is the
 * evaluated bool argument (the script VM supplies it; this native performs
 * the in-place bit update only).
 */
export function showCheckboxOnRightSideNative(object, bRight, services = {}) {
  objectReference(object, 'window');
  const flags = readFlags(object, services, 'checkbox-flags-read');
  const writer = services.write;
  if (typeof writer !== 'function') {
    fail('XCheckboxWindow::ShowCheckboxOnRightSide requires write service', {
      kind: 'SERVICE',
      offset: WINDOW_SHOW_CHECKBOX_ON_RIGHT_SIDE_OFFSETS.checkboxFlags,
      operation: 'checkbox-flags-write',
    });
  }
  if (typeof bRight !== 'boolean' && typeof bRight !== 'number') {
    fail('XCheckboxWindow::ShowCheckboxOnRightSide requires a bool argument', {
      kind: 'VALUE', value: bRight,
      offset: WINDOW_SHOW_CHECKBOX_ON_RIGHT_SIDE_OFFSETS.checkboxFlags,
      operation: 'checkbox-flags-write',
    });
  }
  const offset = WINDOW_SHOW_CHECKBOX_ON_RIGHT_SIDE_OFFSETS.checkboxFlags;
  const word = flags ^ ((flags ^ (Number(bRight) & 1)) &
    WINDOW_SHOW_CHECKBOX_ON_RIGHT_SIDE_BITS.onRight);
  sync(writer(object, offset, 'u32', word, {
    native: WINDOW_SHOW_CHECKBOX_ON_RIGHT_SIDE_NATIVE.execBody,
    phase: 'checkbox-flags-write',
    object,
    offset,
    kind: 'u32',
    width: 4,
  }), 'write +0x208');
}

export const windowShowCheckboxOnRightSideNative =
  showCheckboxOnRightSideNative;
export const checkboxWindowShowCheckboxOnRightSideNative =
  showCheckboxOnRightSideNative;
