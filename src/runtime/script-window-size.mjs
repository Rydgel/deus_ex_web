/**
 * Recovered Extension.dll XWindow::SetSize/Resize translation.
 *
 * SetSize forwards both float arguments to Resize. Resize clamps negative or
 * unordered requested values to positive zero, compares width then height via
 * x87 C3, stores both dimensions when either differs, and synchronously asks
 * the window hierarchy to reconfigure. See docs/script-window-size.md.
 */

const freeze = Object.freeze;
const f = Math.fround;

export const WINDOW_SIZE_NATIVE = freeze({
  package: 'Extension',
  function: 'Window.SetSize',
  packageExport: 2055,
  nativeIndex: 1431,
  functionFlags: 0x401,
  serialSize: 34,
  dll: 'Extension.dll',
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  execBody: 0x100520d0,
  execEnd: 0x1005213f,
  execSha256: 'fb0147f27c5fd013d5c638ed0f3ba918e2555acb8917bb9ae0e44404f3740f53',
  setSizeBody: 0x10003310,
  setSizeEnd: 0x10003322,
  setSizeSha256: 'f6c015c15a2e360336c9c1c3cf6a207943cf3944076575b25da9f2e00e52eec0',
  resizeBody: 0x1004cf70,
  resizeEnd: 0x1004d010,
  resizeSha256: 'c14796430b9c4ec8d2c629be3116a439ccad25efea413eec4d79118d05eac775',
});

export const WINDOW_SIZE_OFFSETS = freeze({width: 0x9c, height: 0xa0});

export class WindowSizeNativeBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'WindowSizeNativeBoundaryError';
    this.code = `WINDOW_SIZE_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => { throw new WindowSizeNativeBoundaryError(message, details); };

function sync(value, label) {
  if (value && typeof value.then === 'function') fail(`Window.SetSize ${label} suspended`, {kind: 'ASYNC'});
  return value;
}

function number(value, label) {
  if (typeof value !== 'number') fail(`Window.SetSize requires numeric ${label}`, {kind: 'VALUE', value});
  return f(value);
}

function requested(value) {
  const result = f(value);
  // fcom requested,0 followed by test C0: negative and unordered clamp. A
  // supplied -0 has neither condition and retains its sign bit.
  return Number.isNaN(result) || result < 0 ? 0 : result;
}

function x87C3Equal(left, right) {
  // fcom's C3 is also set for unordered values. Signed zero compares equal.
  return Number.isNaN(left) || Number.isNaN(right) || left === right;
}

function read(object, offset, services, phase) {
  if (typeof services.read !== 'function') fail('Window.SetSize requires raw read service', {kind: 'SERVICE', offset});
  const value = sync(services.read(object, offset, 'f32', {
    native: WINDOW_SIZE_NATIVE.resizeBody, phase, offset, kind: 'f32', width: 4,
  }), `read +0x${offset.toString(16)}`);
  return number(value, `stored ${phase}`);
}

function write(object, offset, value, services, phase) {
  if (typeof services.write !== 'function') fail('Window.SetSize requires raw write service', {kind: 'SERVICE', offset});
  return sync(services.write(object, offset, 'f32', value, {
    native: WINDOW_SIZE_NATIVE.resizeBody, phase, offset, kind: 'f32', width: 4,
  }), `write +0x${offset.toString(16)}`);
}

export function resizeWindowNative(object, newWidth, newHeight, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('Window.SetSize requires a canonical Window object', {kind: 'REFERENCE', value: object});
  const width = requested(number(newWidth, 'newWidth'));
  const height = requested(number(newHeight, 'newHeight'));
  const oldWidth = read(object, WINDOW_SIZE_OFFSETS.width, services, 'width-compare');
  if (x87C3Equal(width, oldWidth)) {
    const oldHeight = read(object, WINDOW_SIZE_OFFSETS.height, services, 'height-compare');
    if (x87C3Equal(height, oldHeight)) return false;
  }
  write(object, WINDOW_SIZE_OFFSETS.width, width, services, 'width-store');
  write(object, WINDOW_SIZE_OFFSETS.height, height, services, 'height-store');
  if (typeof services.askParentForReconfigure !== 'function')
    fail('Window.SetSize requires AskParentForReconfigure service', {kind: 'SERVICE'});
  sync(services.askParentForReconfigure({
    object, native: WINDOW_SIZE_NATIVE.resizeBody, width, height,
  }), 'AskParentForReconfigure');
  return true;
}

export const setWindowSizeNative = resizeWindowNative;
