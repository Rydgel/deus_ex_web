/**
 * Recovered Extension.dll XWindow::IsKeyDown translation.
 *
 * The registered exec body evaluates one byte argument (script default 0),
 * tail-calls the method at 0x1004c980, and stores the returned dword into the
 * result slot.  The method calls GetRootWindow (0x1004c5a0): climb the +0x138
 * parent chain to the topmost window and keep it only when its +0x28 type
 * byte is >= 3; otherwise the result is 0.  With a root and a key in
 * [0, 0xff) the method returns the root window's key-state byte at
 * +0x630+key; key == 0xff always yields 0 (the exec already masked the
 * argument to a byte, so [0,255] is the whole domain).
 *
 * Evidence: Extension.dll SHA-256
 * 93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c,
 * exec body 0x100535f0 through 0x1005363f,
 * method body 0x1004c980 through 0x1004c9e2,
 * GetRootWindow at 0x1004c5a0.
 */

const freeze = value => Object.freeze(value);

export const WINDOW_IS_KEY_DOWN_NATIVE = freeze({
  package: 'Extension',
  function: 'Window.IsKeyDown / XWindow::IsKeyDown',
  packageExport: 1879,
  nativeIndex: 1470,
  functionFlags: 0x401,
  serialSize: 31,
  dll: 'Extension.dll',
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  imageBase: 0x10000000,
  execBody: 0x100535f0,
  execEnd: 0x1005363f,
  execSha256: '5c8f89f39a9afd2d0e27bc4b1ab0cea92106aae75fb721652c55e4b18454375f',
  methodBody: 0x1004c980,
  methodEnd: 0x1004c9e2,
  methodSha256: '6cb0a65ec683e5a5d349076813de41cfed48569131d30b83c6210196dd101ce9',
});

export const WINDOW_IS_KEY_DOWN_NATIVE_ADDRESSES = freeze({
  body: WINDOW_IS_KEY_DOWN_NATIVE.methodBody,
  end: WINDOW_IS_KEY_DOWN_NATIVE.methodEnd,
  getRootWindow: 0x1004c5a0,
});

/** Numeric byte offsets in the native XWindow object. */
export const WINDOW_IS_KEY_DOWN_OFFSETS = freeze({
  parent: 0x138,
  windowType: 0x28,
  keyStateBase: 0x630,
});

export const WINDOW_IS_KEY_DOWN_FIELDS = WINDOW_IS_KEY_DOWN_OFFSETS;

/** The method bounds the key index to [0, 0xff). */
export const WINDOW_IS_KEY_DOWN_LIMITS = freeze({
  keyStateCount: 0xff,
  rootWindowType: 3,
});

export const WINDOW_IS_KEY_DOWN_NATIVE_CONTRACT = freeze({
  name: 'XWindow::IsKeyDown',
  address: WINDOW_IS_KEY_DOWN_NATIVE.methodBody,
  arguments: freeze(['Key:byte']),
  returns: 'bool (dword)',
  rawStorage: 'read(object, offset, kind, details)',
  fields: freeze({...WINDOW_IS_KEY_DOWN_OFFSETS}),
  callbacks: freeze([]),
});

export class WindowIsKeyDownNativeBoundaryError extends Error {
  constructor(message, {
    kind = 'BOUNDARY', value = undefined, object = undefined,
    offset = null, operation = null,
  } = {}) {
    super(message);
    this.name = 'WindowIsKeyDownNativeBoundaryError';
    this.code = `WINDOW_IS_KEY_DOWN_${kind}`;
    this.value = value;
    this.object = object;
    this.offset = offset;
    this.operation = operation;
  }
}

const fail = (message, details = {}) => {
  throw new WindowIsKeyDownNativeBoundaryError(message, details);
};

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`XWindow::IsKeyDown ${label} suspended; native path is synchronous`, {
      kind: 'ASYNC', value, operation: label,
    });
  }
  return value;
}

function objectReference(value, name) {
  if (value === null || value === undefined ||
      (typeof value !== 'object' && typeof value !== 'function')) {
    fail(`XWindow::IsKeyDown requires canonical ${name}`, {
      kind: 'REFERENCE', value, operation: name,
    });
  }
  return value;
}

const present = value => value !== null && value !== undefined && value !== 0;

function readRaw(object, offset, kind, services, phase) {
  const reader = services.read;
  if (typeof reader !== 'function') {
    fail('XWindow::IsKeyDown requires read service', {
      kind: 'SERVICE', offset, operation: phase,
    });
  }
  return sync(reader(object, offset, kind, {
    native: WINDOW_IS_KEY_DOWN_NATIVE.methodBody,
    phase, object, offset, kind,
    width: kind === 'u8' ? 1 : 4,
  }), `read +0x${offset.toString(16)}`);
}

/** GetRootWindow at 0x1004c5a0: climb +0x138 to the topmost window; keep it
 * only when its +0x28 type byte is at least 3. */
function getRootWindow(start, services, phase) {
  const O = WINDOW_IS_KEY_DOWN_OFFSETS;
  const seen = new Set([start]);
  let node = start;
  for (;;) {
    const parent = readRaw(node, O.parent, 'ptr', services, phase);
    if (!present(parent)) break;
    if (seen.has(parent)) {
      fail('XWindow::IsKeyDown received a cyclic native parent chain', {
        kind: 'REFERENCE', value: parent, object: start, operation: phase,
      });
    }
    seen.add(parent);
    node = parent;
  }
  const type = readRaw(node, O.windowType, 'u8', services, phase);
  return type >= WINDOW_IS_KEY_DOWN_LIMITS.rootWindowType ? node : null;
}

/**
 * Execute the original method body: resolve the root window, then return its
 * key-state byte for keys in [0, 0xff), else 0.
 */
export function isKeyDownNative(object, key, services = {}) {
  objectReference(object, 'window');
  if (!Number.isInteger(key)) {
    fail('XWindow::IsKeyDown requires a byte key argument', {
      kind: 'VALUE', value: key, operation: 'key-state-read',
    });
  }
  const root = getRootWindow(object, services, 'root-walk');
  if (!present(root)) return 0;
  if (key < 0 || key >= WINDOW_IS_KEY_DOWN_LIMITS.keyStateCount) return 0;
  const state = readRaw(root,
    WINDOW_IS_KEY_DOWN_OFFSETS.keyStateBase + key, 'u8',
    services, 'key-state-read');
  if (!Number.isInteger(state) || state < 0 || state > 0xff) {
    fail('XWindow::IsKeyDown requires a uint8 key-state byte', {
      kind: 'VALUE', value: state, object: root,
      offset: WINDOW_IS_KEY_DOWN_OFFSETS.keyStateBase + key,
      operation: 'key-state-read',
    });
  }
  return state;
}

export const windowIsKeyDownNative = isKeyDownNative;
export const windowWindowIsKeyDownNative = isKeyDownNative;
