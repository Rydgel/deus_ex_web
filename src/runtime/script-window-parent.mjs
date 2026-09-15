/**
 * Recovered Extension.dll XWindow::GetParent translation.
 *
 * GetParent returns the raw pointer at Window+0x138. That slot is the native
 * winParent link already recovered by AddChild/GetRootWindow; UObject.Outer is
 * not a substitute. See docs/script-window-parent.md.
 */

const freeze = Object.freeze;

export const WINDOW_PARENT_NATIVE = freeze({
  package: 'Extension',
  function: 'Window.GetParent',
  packageExport: 2093,
  nativeIndex: 1428,
  functionFlags: 0x401,
  serialSize: 28,
  dll: 'Extension.dll',
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  imageBase: 0x10000000,
  execBody: 0x10051f60,
  execEnd: 0x10051f75,
  execSha256: '0bd41b4adeabcbde56af609fc84091176f450439d1d18616b7296038a40d0e90',
  getParentBody: 0x1004c550,
  getParentEnd: 0x1004c557,
  getParentSha256: '99acf02931ea857de9495f555b16462b3d3a1869d7d270611bcca2162fae415d',
});

/** Same recovered parent slot as GetRootWindow / AddChild / Raise. */
export const WINDOW_PARENT_OFFSETS = freeze({parent: 0x138});

export class WindowParentNativeBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'WindowParentNativeBoundaryError';
    this.code = `WINDOW_PARENT_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => { throw new WindowParentNativeBoundaryError(message, details); };

function sync(value, label) {
  if (value && typeof value.then === 'function') fail(`Window.GetParent ${label} suspended`, {kind: 'ASYNC'});
  return value;
}

function present(value) {
  return value !== null && value !== undefined && value !== 0;
}

function pointer(value, label) {
  if (!present(value)) return value ?? null;
  if (typeof value !== 'object' && typeof value !== 'function' && typeof value !== 'number') {
    fail(`Window.GetParent requires canonical ${label}`, {kind: 'REFERENCE', value});
  }
  if (typeof value === 'number' && (!Number.isInteger(value) || value < 0 || value > 0xffffffff)) {
    fail(`Window.GetParent requires uint32 ${label}`, {kind: 'VALUE', value});
  }
  return value;
}

export function getParentWindowNative(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('Window.GetParent requires a canonical Window object', {kind: 'REFERENCE', value: object});
  let value;
  if (typeof services.read === 'function') {
    value = sync(services.read(object, WINDOW_PARENT_OFFSETS.parent, 'ptr', {
      native: WINDOW_PARENT_NATIVE.getParentBody, phase: 'GetParent/parent',
      offset: WINDOW_PARENT_OFFSETS.parent, kind: 'ptr', width: 4,
    }), 'read +0x138');
  } else if (typeof services.readParent === 'function') {
    value = sync(services.readParent(object), 'readParent');
  } else {
    fail('Window.GetParent requires raw read or readParent service', {kind: 'SERVICE', offset: WINDOW_PARENT_OFFSETS.parent});
  }
  if (value === undefined)
    fail('Window.GetParent reached unresolved +0x138', {kind: 'FIELD', offset: WINDOW_PARENT_OFFSETS.parent});
  const parent = pointer(value, 'parent');
  return present(parent) ? parent : null;
}

export const xWindowGetParentNative = getParentWindowNative;
