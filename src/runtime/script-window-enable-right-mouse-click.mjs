/**
 * Recovered Extension.dll XButtonWindow::EnableRightMouseClick translation.
 *
 * The registered exec body evaluates one bool argument (script default true)
 * and tail-calls the method at 0x10007ae0, which updates bit 3 (0x08) of the
 * button flags dword at +0x174:
 *   flags = (flags & ~0x08) | ((arg & 1) << 3)
 * preserving every other bit.  No reconfigure call.
 *
 * Evidence: Extension.dll SHA-256
 * 93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c,
 * exec body 0x10008b90 through 0x10008bd6,
 * method body 0x10007ae0 through 0x10007afe.
 */

const freeze = value => Object.freeze(value);

export const WINDOW_ENABLE_RIGHT_MOUSE_CLICK_NATIVE = freeze({
  package: 'Extension',
  function:
    'ButtonWindow.EnableRightMouseClick / XButtonWindow::EnableRightMouseClick',
  packageExport: 1058,
  nativeIndex: 1596,
  functionFlags: 0x401,
  serialSize: 31,
  dll: 'Extension.dll',
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  imageBase: 0x10000000,
  execBody: 0x10008b90,
  execEnd: 0x10008bd6,
  execSha256: '1d1ce175e21716cafa58c39f1e7991515f235bfed5bd2accf682ef3e08c40841',
  methodBody: 0x10007ae0,
  methodEnd: 0x10007afe,
  methodSha256: '8ee4fda6966f2a2c76966af17994a05a311ee1b01ed532da07581378f7a8e971',
});

export const WINDOW_ENABLE_RIGHT_MOUSE_CLICK_ADDRESSES = freeze({
  body: WINDOW_ENABLE_RIGHT_MOUSE_CLICK_NATIVE.methodBody,
  end: WINDOW_ENABLE_RIGHT_MOUSE_CLICK_NATIVE.methodEnd,
});

/** Numeric byte offsets in the native XButtonWindow object. */
export const WINDOW_ENABLE_RIGHT_MOUSE_CLICK_OFFSETS = freeze({
  buttonFlags: 0x174,
});

export const WINDOW_ENABLE_RIGHT_MOUSE_CLICK_FIELDS =
  WINDOW_ENABLE_RIGHT_MOUSE_CLICK_OFFSETS;

/** Bit 3 of +0x174 is the right-mouse-click enable flag. */
export const WINDOW_ENABLE_RIGHT_MOUSE_CLICK_BITS = freeze({
  rightMouseClick: 0x08,
});

export const WINDOW_ENABLE_RIGHT_MOUSE_CLICK_NATIVE_CONTRACT = freeze({
  name: 'XButtonWindow::EnableRightMouseClick',
  address: WINDOW_ENABLE_RIGHT_MOUSE_CLICK_NATIVE.methodBody,
  arguments: freeze(['bEnable:bool']),
  returns: 'void',
  rawStorage: 'read/write(object, offset, kind, ..., details)',
  fields: freeze({
    buttonFlags: WINDOW_ENABLE_RIGHT_MOUSE_CLICK_OFFSETS.buttonFlags,
  }),
  callbacks: freeze([]),
});

export class WindowEnableRightMouseClickNativeBoundaryError extends Error {
  constructor(message, {
    kind = 'BOUNDARY', value = undefined, object = undefined,
    offset = null, operation = null,
  } = {}) {
    super(message);
    this.name = 'WindowEnableRightMouseClickNativeBoundaryError';
    this.code = `WINDOW_ENABLE_RIGHT_MOUSE_CLICK_${kind}`;
    this.value = value;
    this.object = object;
    this.offset = offset;
    this.operation = operation;
  }
}

const fail = (message, details = {}) => {
  throw new WindowEnableRightMouseClickNativeBoundaryError(message, details);
};

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`XButtonWindow::EnableRightMouseClick ${label} suspended; native path is synchronous`, {
      kind: 'ASYNC', value, operation: label,
    });
  }
  return value;
}

function objectReference(value, name) {
  if (value === null || value === undefined ||
      (typeof value !== 'object' && typeof value !== 'function')) {
    fail(`XButtonWindow::EnableRightMouseClick requires canonical ${name}`, {
      kind: 'REFERENCE', value, operation: name,
    });
  }
  return value;
}

/**
 * Execute the original method body:
 * `+0x174 = (+0x174 & ~0x08) | ((bEnable & 1) << 3)`.
 */
export function enableRightMouseClickNative(object, bEnable, services = {}) {
  objectReference(object, 'window');
  const reader = services.read;
  const writer = services.write;
  if (typeof reader !== 'function' || typeof writer !== 'function') {
    fail('XButtonWindow::EnableRightMouseClick requires read/write services', {
      kind: 'SERVICE',
      offset: WINDOW_ENABLE_RIGHT_MOUSE_CLICK_OFFSETS.buttonFlags,
      operation: 'button-flags-update',
    });
  }
  const offset = WINDOW_ENABLE_RIGHT_MOUSE_CLICK_OFFSETS.buttonFlags;
  const flags = sync(reader(object, offset, 'u32', {
    native: WINDOW_ENABLE_RIGHT_MOUSE_CLICK_NATIVE.methodBody,
    phase: 'button-flags-read', object, offset, kind: 'u32', width: 4,
  }), 'read +0x174');
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xffffffff) {
    fail('XButtonWindow::EnableRightMouseClick requires uint32 +0x174 field', {
      kind: 'VALUE', value: flags, object, offset,
      operation: 'button-flags-read',
    });
  }
  const bit = WINDOW_ENABLE_RIGHT_MOUSE_CLICK_BITS.rightMouseClick;
  const word = ((flags & ~bit) |
    ((Number(bEnable) & 1) * bit)) >>> 0;
  sync(writer(object, offset, 'u32', word, {
    native: WINDOW_ENABLE_RIGHT_MOUSE_CLICK_NATIVE.methodBody,
    phase: 'button-flags-write', object, offset, kind: 'u32', width: 4,
  }), 'write +0x174');
}

export const windowEnableRightMouseClickNative =
  enableRightMouseClickNative;
export const buttonWindowEnableRightMouseClickNative =
  enableRightMouseClickNative;
